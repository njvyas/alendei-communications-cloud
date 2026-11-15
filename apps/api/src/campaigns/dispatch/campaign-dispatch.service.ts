import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CAMPAIGN_EXECUTOR_CODES,
  CAMPAIGN_EXECUTOR_LIMITS,
  JOURNEY_RUNNER_LIMITS,
  type CampaignPauseReason,
} from '@acc/contracts';
import { schema, type Database, type Transaction } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';

import { AuditWriter } from '../../audit/audit-writer.service';
import { AppConfigService } from '../../config/app-config.service';
import { CAMPAIGN_DB } from '../../database/database.tokens';
import { MessageSubmissionCore } from '../../messages/submission/message-submission.core';
import { authorizeAutomationSubmission } from '../../messages/submission/submission-authorization';
import type { SubmissionOrigin } from '../../messages/submission/submission.types';
import { campaignRefusal, mintRefusalDetail, refusalCode } from './campaign-refusals';

/** One claimed campaign, as `app_campaign_claim` returns it. */
export interface CampaignClaim {
  readonly campaignId: string;
  readonly orgId: string;
  readonly claimToken: string;
  readonly epoch: number;
  readonly attempts: number;
}

export type CampaignClaimOutcome =
  | 'completed' // no pending recipient remained: the campaign is completed
  | 'released' // the slot quota was sent; released until the next slot
  | 'paused' // paused automatically (OD-8B3-3) or by the organisation's automation pause
  | 'inactive' // the campaign stopped running (operator pause or cancel): nothing written
  | 'fenced' // the claim was lost or superseded: nothing written
  | 'retry'; // a transient or unexpected failure: released with backoff

export interface CampaignClaimResult {
  readonly campaignId: string;
  readonly outcome: CampaignClaimOutcome;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly errorCode?: string;
  readonly pauseReason?: CampaignPauseReason;
}

export interface CampaignDispatchOptions {
  readonly batchSize: number;
  readonly perOrgLimit: number;
  readonly leaseSeconds: number;
  readonly lockTimeoutMs: number;
  readonly workerId: string;
}

/** What the executor reads of the claimed campaign (its own claim-bound rows). */
interface CampaignSettings {
  readonly workspaceId: string;
  readonly templateId: string;
  readonly channelCode: string;
  readonly variables: Record<string, string>;
  readonly quota: number;
}

type SendOutcome =
  | { readonly kind: 'sent' | 'skipped' | 'failed' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'paused'; readonly reason: CampaignPauseReason }
  | { readonly kind: 'inactive' | 'fenced' }
  | { readonly kind: 'retry'; readonly code: string };

class Fenced extends Error {}
class RetryLater extends Error {
  constructor(readonly code: string) {
    super(`campaign send: retry later (${code})`);
  }
}

const EXECUTOR_LABEL = 'campaign_executor';

/** The core's one method the executor needs (a stub in the refusal-matrix tests). */
export type CampaignSubmissionCore = Pick<MessageSubmissionCore, 'submit'>;

/**
 * Phase 8B PR 8B-3b: the campaign executor (PHASE-8B-3-HANDOVER-Rev2 §6).
 *
 * Runs as `acc_campaign` (migration 0068): every policy is bound to ONE claimed campaign, and the
 * send-path policies additionally require a valid automation capability. **Disabled unless
 * `CAMPAIGN_DISPATCH_ENABLED`**, which configuration refuses outside tests and without billing
 * enforcement; disabled, no `acc_campaign` pool exists and this service has no database.
 *
 * T-send — ONE transaction per recipient, on one connection (Rev 2 §6.2, owner clarification
 * C-2): the claim fence, the next pending recipient (SKIP LOCKED), the capability mint (which
 * holds the organisation control row and the campaign row FOR SHARE), the automation proof, the
 * shared core with a campaign origin (message, queue entry, event and funds reservation), the
 * recipient update, and COMMIT. Nothing here calls a provider: dispatch is the existing
 * dispatcher's job, outside any transaction.
 */
@Injectable()
export class CampaignDispatchService {
  private readonly logger = new Logger(CampaignDispatchService.name);
  readonly options: CampaignDispatchOptions;

  constructor(
    @Optional() @Inject(CAMPAIGN_DB) private readonly db: Database | null,
    @Inject(MessageSubmissionCore) private readonly core: CampaignSubmissionCore,
    private readonly audit: AuditWriter,
    @Optional() config?: AppConfigService,
    @Optional() @Inject('CAMPAIGN_DISPATCH_OPTIONS') options?: Partial<CampaignDispatchOptions>,
  ) {
    const fromConfig = config?.campaigns;
    this.options = {
      batchSize: options?.batchSize ?? fromConfig?.batchSize ?? 5,
      perOrgLimit: options?.perOrgLimit ?? fromConfig?.perOrgLimit ?? 2,
      leaseSeconds: options?.leaseSeconds ?? fromConfig?.leaseSeconds ?? 30,
      lockTimeoutMs: options?.lockTimeoutMs ?? 5_000,
      workerId: options?.workerId ?? `campaign-executor-${randomUUID().slice(0, 8)}`,
    };
  }

  /** True when an `acc_campaign` database exists (dispatch was enabled at boot). */
  get available(): boolean {
    return this.db !== null;
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('campaign dispatch is disabled (no acc_campaign connection)');
    return this.db;
  }

  /** One cycle: retention, scheduled starts, then a batch of campaign claims. */
  async tick(): Promise<CampaignClaimResult[]> {
    await this.purgeCapabilities();
    await this.startDue();
    const results: CampaignClaimResult[] = [];
    for (const claim of await this.claim()) results.push(await this.processClaim(claim));
    return results;
  }

  /** Starts due scheduled campaigns (`app_campaign_start_due`, migration 0070). */
  async startDue(limit = CAMPAIGN_EXECUTOR_LIMITS.scheduledStartsPerCycle): Promise<string[]> {
    const { rows } = await this.requireDb().execute<{ campaign_id: string }>(
      sql`SELECT campaign_id FROM app_campaign_start_due(${limit}::int)`,
    );
    return rows.map((r) => r.campaign_id);
  }

  /** Capability retention, 90 days (OD-8B3-6), in one bounded batch. */
  async purgeCapabilities(): Promise<number> {
    const { rows } = await this.requireDb().execute<{ n: number }>(
      sql`SELECT app_automation_purge_capabilities(${CAMPAIGN_EXECUTOR_LIMITS.capabilityPurgeBatch}::int) AS n`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async claim(limit = this.options.batchSize): Promise<CampaignClaim[]> {
    const { rows } = await this.requireDb().execute<{
      campaign_id: string;
      org_id: string;
      claim_token: string;
      epoch: number;
      attempts: number;
    }>(
      sql`SELECT * FROM app_campaign_claim(${this.options.workerId}, ${limit}::int, ${this.options.leaseSeconds}::int, ${this.options.perOrgLimit}::int)`,
    );
    return rows.map((r) => ({
      campaignId: r.campaign_id,
      orgId: r.org_id,
      claimToken: r.claim_token,
      epoch: Number(r.epoch),
      attempts: Number(r.attempts),
    }));
  }

  /** Sends up to the slot quota for one claimed campaign, then completes, pauses or releases it. */
  async processClaim(claim: CampaignClaim): Promise<CampaignClaimResult> {
    const counts = { sent: 0, skipped: 0, failed: 0 };
    const result = (
      outcome: CampaignClaimOutcome,
      extra: Partial<CampaignClaimResult> = {},
    ): CampaignClaimResult => ({ campaignId: claim.campaignId, outcome, ...counts, ...extra });

    let settings: CampaignSettings;
    try {
      settings = await this.settings(claim);
    } catch (error) {
      if (error instanceof Fenced) return result('fenced');
      throw error;
    }
    for (let i = 0; i < settings.quota; i++) {
      let outcome: SendOutcome;
      try {
        outcome = await this.sendNext(claim, settings);
      } catch (error) {
        if (error instanceof Fenced) return result('fenced');
        const code =
          error instanceof RetryLater ? error.code : (refusalCode(error) ?? 'UNEXPECTED');
        this.logger.warn({
          msg: 'campaign send failed; rolled back',
          campaignId: claim.campaignId,
          code,
        });
        await this.release(claim, { backoff: true, errorCode: code });
        return result('retry', { errorCode: code });
      }
      switch (outcome.kind) {
        case 'sent':
        case 'skipped':
        case 'failed':
          counts[outcome.kind]++;
          continue;
        case 'empty':
          if (await this.complete(claim)) return result('completed');
          await this.release(claim, { nextSlot: true });
          return result('released');
        case 'paused':
          return result('paused', { pauseReason: outcome.reason });
        case 'inactive':
        case 'fenced':
          return result(outcome.kind);
        case 'retry':
          await this.release(claim, { backoff: true, errorCode: outcome.code });
          return result('retry', { errorCode: outcome.code });
      }
    }
    await this.release(claim, { nextSlot: true });
    return result('released');
  }

  // --- the claim transaction scaffolding ------------------------------------------------------

  /** One transaction on the acc_campaign connection, fenced by the live claim (FOR UPDATE). */
  private async withClaim<T>(
    claim: CampaignClaim,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.requireDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org_id', ${claim.orgId}, true),
                                  set_config('app.campaign_id', ${claim.campaignId}, true),
                                  set_config('app.campaign_claim_token', ${claim.claimToken}, true),
                                  set_config('lock_timeout', ${`${this.options.lockTimeoutMs}ms`}, true)`);
      const { rows } = await tx.execute<{ epoch: number }>(
        sql`SELECT epoch FROM campaign_dispatch
             WHERE campaign_id = ${claim.campaignId} AND claim_token = ${claim.claimToken}
               AND claimed_until > clock_timestamp()
             FOR UPDATE`,
      );
      if (rows.length !== 1 || Number(rows[0]!.epoch) !== claim.epoch) {
        throw new Fenced('claim lost or superseded');
      }
      return work(tx);
    });
  }

  private async settings(claim: CampaignClaim): Promise<CampaignSettings> {
    return this.withClaim(claim, async (tx) => {
      const { rows } = await tx.execute<{
        workspace_id: string;
        template_id: string;
        channel_code: string | null;
        template_variables: Record<string, string> | null;
        rate: number | string | null;
      }>(
        sql`SELECT workspace_id, template_id, app_channel_code(channel_id) AS channel_code,
                   template_variables, (throttling->>'rateLimitPerSecond') AS rate
              FROM campaigns WHERE id = ${claim.campaignId}`,
      );
      const row = rows[0];
      if (!row || !row.channel_code) throw new Fenced('campaign not visible');
      const rate = Math.max(1, Math.min(1_000, Number(row.rate) || 1));
      return {
        workspaceId: row.workspace_id,
        templateId: row.template_id,
        channelCode: row.channel_code,
        variables: row.template_variables ?? {},
        quota: Math.ceil(rate * CAMPAIGN_EXECUTOR_LIMITS.slotSeconds),
      };
    });
  }

  // --- T-send ---------------------------------------------------------------------------------

  private async sendNext(claim: CampaignClaim, settings: CampaignSettings): Promise<SendOutcome> {
    try {
      return await this.withClaim(claim, async (tx) => {
        const { rows } = await tx.execute<{
          id: string;
          contact_id: string;
          identity_id: string | null;
          attempts: number;
        }>(
          sql`SELECT id, contact_id, identity_id, attempts FROM campaign_recipients
               WHERE campaign_id = ${claim.campaignId} AND status = 'pending'
               ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        const recipient = rows[0];
        if (!recipient) return { kind: 'empty' } as const;
        await tx.execute(
          sql`SELECT set_config('app.campaign_recipient_id', ${recipient.id}, true)`,
        );

        // The capability: refused for a paused organisation, a campaign no longer running, a lost
        // claim — and it locks the control row and the campaign row FOR SHARE until COMMIT.
        const minted = await tx.execute<{ t: string }>(
          sql`SELECT app_automation_capability_mint('campaign_recipient', ${recipient.id}::uuid) AS t`,
        );
        await tx.execute(
          sql`SELECT set_config('app.automation_capability', ${minted.rows[0]!.t}, true)`,
        );

        // The materialised identity must still be an active identity of the recipient's contact.
        const identity = recipient.identity_id
          ? (
              await tx.execute<{ address: string; status: string; contact_id: string }>(
                sql`SELECT normalized_address AS address, status, contact_id FROM contact_identities
                     WHERE id = ${recipient.identity_id}`,
              )
            ).rows[0]
          : undefined;
        if (
          !identity ||
          identity.status !== 'active' ||
          identity.contact_id !== recipient.contact_id
        ) {
          await this.finishRecipient(tx, recipient.id, 'skipped', {
            skipReason: CAMPAIGN_EXECUTOR_CODES.NO_ACTIVE_IDENTITY,
          });
          return { kind: 'skipped' } as const;
        }

        const origin: SubmissionOrigin = {
          kind: 'campaign',
          campaignId: claim.campaignId,
          campaignRecipientId: recipient.id,
        };
        let messageId: string;
        try {
          // A savepoint: a refusal rolls back only the core's partial writes.
          messageId = await tx.transaction(async (sp) => {
            const authorization = await authorizeAutomationSubmission(sp, claim.orgId);
            const submitted = await this.core.submit(
              sp,
              {
                orgId: claim.orgId,
                correlationId: `campaign:${recipient.id}`,
                authorization,
                origin,
              },
              {
                channelCode: settings.channelCode,
                recipient: identity.address,
                templateId: settings.templateId,
                workspaceId: settings.workspaceId,
                payload: { variables: settings.variables },
              },
            );
            return submitted.messageId;
          });
        } catch (error) {
          const code = refusalCode(error);
          const refusal = campaignRefusal(code);
          switch (refusal.kind) {
            case 'skip':
              await this.finishRecipient(tx, recipient.id, 'skipped', {
                skipReason: refusal.reason,
              });
              return { kind: 'skipped' } as const;
            case 'fail':
              await this.finishRecipient(tx, recipient.id, 'failed', { errorCode: refusal.code });
              return { kind: 'failed' } as const;
            case 'pause':
              await this.pauseCampaign(tx, claim, refusal.pauseReason, code);
              return { kind: 'paused', reason: refusal.pauseReason } as const;
            case 'transient':
              throw new RetryLater(code ?? 'TRANSIENT');
            case 'unexpected': {
              const attempts = Number(recipient.attempts) + 1;
              if (attempts >= CAMPAIGN_EXECUTOR_LIMITS.unexpectedAttempts) {
                await this.finishRecipient(tx, recipient.id, 'failed', {
                  errorCode: CAMPAIGN_EXECUTOR_CODES.SEND_UNEXPECTED,
                  attempts,
                });
                return { kind: 'failed' } as const;
              }
              await tx.execute(
                sql`UPDATE campaign_recipients SET attempts = ${attempts}, updated_at = now() WHERE id = ${recipient.id}`,
              );
              return { kind: 'retry', code: code ?? 'UNEXPECTED' } as const;
            }
          }
        }
        await tx.execute(
          sql`UPDATE campaign_recipients SET status = 'sent', message_id = ${messageId}, updated_at = now()
               WHERE id = ${recipient.id}`,
        );
        // Progress: the claim's failure count starts again.
        await tx.execute(
          sql`UPDATE campaign_dispatch SET attempts = 0, last_error_code = NULL WHERE campaign_id = ${claim.campaignId}`,
        );
        return { kind: 'sent' } as const;
      });
    } catch (error) {
      if (error instanceof Fenced || error instanceof RetryLater) throw error;
      switch (mintRefusalDetail(error)) {
        case 'AUTOMATION_PAUSED':
          return (await this.autoPause(claim, 'automation_paused'))
            ? { kind: 'paused', reason: 'automation_paused' }
            : { kind: 'fenced' };
        case 'CAMPAIGN_NOT_RUNNING':
          return { kind: 'inactive' };
        case 'CLAIM_LOST':
          return { kind: 'fenced' };
        default:
          throw error;
      }
    }
  }

  private async finishRecipient(
    tx: Transaction,
    recipientId: string,
    status: 'skipped' | 'failed',
    detail: { skipReason?: string; errorCode?: string; attempts?: number },
  ): Promise<void> {
    await tx
      .update(schema.campaignRecipients)
      .set({
        status,
        skipReason: detail.skipReason ?? null,
        errorCode: detail.errorCode ?? null,
        ...(detail.attempts === undefined ? {} : { attempts: detail.attempts }),
        updatedAt: new Date(),
      })
      .where(eq(schema.campaignRecipients.id, recipientId));
  }

  // --- campaign transitions -------------------------------------------------------------------

  /** Auto-pause (OD-8B3-3): status `paused` with its reason; the claim row removed; audited. */
  private async pauseCampaign(
    tx: Transaction,
    claim: CampaignClaim,
    reason: CampaignPauseReason,
    code: string | null,
  ): Promise<void> {
    const [workspace] = await tx
      .update(schema.campaigns)
      .set({ status: 'paused', pauseReason: reason, updatedAt: new Date() })
      .where(and(eq(schema.campaigns.id, claim.campaignId), eq(schema.campaigns.status, 'running')))
      .returning({ workspaceId: schema.campaigns.workspaceId });
    if (!workspace) throw new Fenced('campaign no longer running');
    await this.recordAudit(tx, claim, workspace.workspaceId, 'campaign.auto_paused', 'failure', {
      pauseReason: reason,
      errorCode: code,
    });
    await tx
      .delete(schema.campaignDispatch)
      .where(eq(schema.campaignDispatch.campaignId, claim.campaignId));
  }

  private async autoPause(claim: CampaignClaim, reason: CampaignPauseReason): Promise<boolean> {
    try {
      await this.withClaim(claim, (tx) => this.pauseCampaign(tx, claim, reason, null));
      return true;
    } catch (error) {
      if (error instanceof Fenced) return false;
      throw error;
    }
  }

  /** No pending recipient remains: `completed`, a metrics snapshot, the claim row removed, audited. */
  private async complete(claim: CampaignClaim): Promise<boolean> {
    try {
      return await this.withClaim(claim, async (tx) => {
        const { rows } = await tx.execute<{ status: string; n: number }>(
          sql`SELECT status::text AS status, count(*)::int AS n FROM campaign_recipients
               WHERE campaign_id = ${claim.campaignId} GROUP BY 1`,
        );
        const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
        if ((by.pending ?? 0) > 0) return false;
        const total = rows.reduce((a, r) => a + Number(r.n), 0);
        const [done] = await tx
          .update(schema.campaigns)
          .set({
            status: 'completed',
            completedAt: new Date(),
            metrics: sql`metrics || ${JSON.stringify({
              totalRecipients: total,
              sent: by.sent ?? 0,
              skipped: by.skipped ?? 0,
              failed: by.failed ?? 0,
            })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(
            and(eq(schema.campaigns.id, claim.campaignId), eq(schema.campaigns.status, 'running')),
          )
          .returning({ workspaceId: schema.campaigns.workspaceId });
        if (!done) return false;
        await this.recordAudit(tx, claim, done.workspaceId, 'campaign.completed', 'success', {
          totalRecipients: total,
          sent: by.sent ?? 0,
          skipped: by.skipped ?? 0,
          failed: by.failed ?? 0,
        });
        await tx
          .delete(schema.campaignDispatch)
          .where(eq(schema.campaignDispatch.campaignId, claim.campaignId));
        return true;
      });
    } catch (error) {
      if (error instanceof Fenced) return false;
      throw error;
    }
  }

  /** Releases the claim: at the next throttle slot, or with backoff after a failure. */
  private async release(
    claim: CampaignClaim,
    opts: { nextSlot?: boolean; backoff?: boolean; errorCode?: string },
  ): Promise<void> {
    const slot = CAMPAIGN_EXECUTOR_LIMITS.slotSeconds;
    const backoffSeconds =
      Math.min(
        JOURNEY_RUNNER_LIMITS.backoffMaxMs,
        JOURNEY_RUNNER_LIMITS.backoffBaseMs * 2 ** Math.max(0, claim.attempts - 1),
      ) / 1000;
    try {
      await this.withClaim(claim, async (tx) => {
        await tx.execute(sql`
          UPDATE campaign_dispatch
             SET claim_token = NULL, claimed_until = NULL, claimed_by = NULL,
                 next_slot_at = ${opts.nextSlot ? sql`now() + make_interval(secs => ${slot})` : sql`next_slot_at`},
                 available_at = ${opts.backoff ? sql`now() + make_interval(secs => ${backoffSeconds}::double precision)` : sql`available_at`},
                 last_error_code = ${opts.errorCode ?? null}
           WHERE campaign_id = app_campaign_id()`);
      });
    } catch (error) {
      // A lost lease lapses on its own; the next claim takes over.
      if (!(error instanceof Fenced)) throw error;
    }
  }

  private recordAudit(
    tx: Transaction,
    claim: CampaignClaim,
    workspaceId: string,
    action: 'campaign.completed' | 'campaign.auto_paused',
    outcome: 'success' | 'failure',
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record(
      {
        scopeType: 'workspace',
        scopeId: workspaceId,
        actorType: 'system',
        actorUserId: null,
        actorApiKeyId: null,
        actorLabel: EXECUTOR_LABEL,
        action,
        resourceType: 'Campaign',
        resourceId: claim.campaignId,
        outcome,
        before: null,
        after: null,
        metadata,
        correlationId: randomUUID(),
      },
      tx,
    );
  }
}
