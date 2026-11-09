import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ORG_LIFECYCLE_LOCK_CLASS, schema } from '@acc/db';
import {
  DELIVERY_RECEIPTS_CAPABILITY,
  ERROR_CODES,
  RCS_MESSAGE_TYPES_CAPABILITY,
  declaredDeliveryReceipts,
  rcsProviderSupports,
  type AuthPrincipal,
  type DeliveryReceiptType,
  type ProviderStatus,
  type ProviderSubmissionResult,
  type RcsMessageType,
  type SimulatorBehavior,
} from '@acc/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

import { AppException } from '../../common/errors/app.exception';
import { DISPATCH_POOL } from '../../database/database.tokens';
import { ProviderSubmissionExecutor } from '../../provider-adapters/submission-executor';
import { MetricsService } from '../../observability/metrics.service';
import { ProviderStateStore, type SubmissionRecord } from '../../providers/provider-state.store';
import { initialDeliveryStatus } from '../delivery/delivery-rules';
import {
  applyHeldReceipts,
  lockMessage,
  refreshMessageDeliveryState,
} from '../delivery/delivery-writer';
import { mapMessageForSubmission, resolveChannelCode } from './submission-mapping';

/** A PostgreSQL SQLSTATE: five digits or upper-case letters (for example 42501). */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * A dispatch failure as a structured, safe log entry (issue #22): the message
 * and, when the error carries one, its SQLSTATE. Never the error object, stack,
 * SQL, parameters or detail. `logger.error('msg', error)` loses the error under
 * nestjs-pino, which treats the extra argument as a format value.
 */
function failureLogEntry(
  msg: string,
  error: unknown,
): { msg: string; error: string; code?: string } {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    msg,
    error: error instanceof Error ? error.message : String(error),
    ...(typeof code === 'string' && SQLSTATE.test(code) ? { code } : {}),
  };
}

/**
 * Admission refused because the provider is not `active` (disabled or draining):
 * `ProviderStateStore.admit` raises PROVIDER_LIFECYCLE_CONFLICT for exactly this,
 * before the circuit is consulted. An eligibility outcome, not a fault (issue #20).
 */
function isProviderLifecycleRefusal(error: unknown): error is AppException {
  return error instanceof AppException && error.code === ERROR_CODES.PROVIDER_LIFECYCLE_CONFLICT;
}

/**
 * The `message.failed` details when no candidate was admitted, from the observed
 * outcomes (issue #20). Without a lifecycle refusal the existing wording is kept.
 */
function noEligibleProviderDetails(outcomes: {
  readonly lifecycle: number;
  readonly other: number;
}): string {
  if (outcomes.lifecycle === 0) return 'All assigned provider circuits refused admission';
  if (outcomes.other === 0) return 'No assigned provider is active (disabled or draining)';
  return 'No assigned provider was admitted: some are not active (disabled or draining), the others were refused admission';
}

export interface DispatchClaim {
  readonly messageId: string;
  readonly orgId: string;
  readonly dispatchEpoch: number;
  readonly claimToken: string;
}

export interface DispatchProcessResult {
  readonly messageId: string;
  readonly outcome: 'accepted' | 'failed' | 'circuit_refused' | 'held' | 'fenced' | 'unknown';
  readonly attemptId?: string;
  readonly error?: string;
}

const DISPATCH_PRINCIPAL: AuthPrincipal = Object.freeze({
  actorType: 'system',
  userId: null,
  apiKeyId: null,
  sessionId: null,
  roles: [],
  permissions: [],
  tenant: { orgId: null, resellerId: null, workspaceId: null, isPlatformAdmin: false },
});

export const LEASE_DURATION_MS = 30_000;

/** What the settlement transaction (T3) needs; fixed before its first run (OD-7-2). */
/** The executor's settled result (no import of the admission ledger: ADR-015 R-13). */
type SettledSubmission = Awaited<ReturnType<ProviderSubmissionExecutor['execute']>>;

interface SettlementInput {
  readonly claim: DispatchClaim;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly selectedProviderId: string;
  readonly message: { readonly channel_id: string };
  readonly mapping: { readonly rcs?: { readonly messageType: RcsMessageType } };
  readonly settled: SettledSubmission;
  readonly record: SubmissionRecord;
  readonly enforced: boolean;
}

/**
 * Phase 7 PR 7-5: whether a settled provider result means the attempt reached the
 * provider (OD-7-4: provider cost is recorded for each such attempt; under
 * `charge_per_attempt` it is charged when the chain ends accepted). Owner decision,
 * 09-Nov-2026:
 *   - accepted: reached;
 *   - TIMEOUT and UNKNOWN: never reached (outcome_unknown, OD-7-4U), whatever the origin;
 *   - any other failure: reached only when an actual provider response decided it
 *     (`failure.origin === 'provider'`, set at the adapter boundary). A failure
 *     detected locally — configuration, credentials checked before any network
 *     submission — is not reached, whatever its category (an `AUTH_ERROR` can be
 *     either).
 */
export function reachedProvider(result: ProviderSubmissionResult): boolean {
  if (result.outcome === 'accepted') return true;
  const { category, origin } = result.failure;
  if (category === 'TIMEOUT' || category === 'UNKNOWN') return false;
  return origin === 'provider';
}

/**
 * Phase 7 PR 7-5: refusals of the pre-submit reservation top-up and attempt rating
 * (`app_dispatch_attempt_reserve`), by SQLSTATE. Each terminates the message
 * `failed` before any provider call, and its reservation is released.
 */
const ATTEMPT_BILLING_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  BL001: 'BILLING_ACCOUNT_NOT_CONFIGURED',
  BL002: 'BILLING_ACCOUNT_FROZEN',
  BL003: 'BILLING_INSUFFICIENT_FUNDS',
  BL007: 'BILLING_PRICE_NOT_CONFIGURED',
  BL008: 'BILLING_PROVIDER_COST_NOT_CONFIGURED',
  BL009: 'BILLING_UNITS_CHANGED',
});

function sqlState(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  return undefined;
}

@Injectable()
export class DispatcherService {
  /** OD-7-2: at most this many runs of the settlement transaction. */
  static readonly SETTLEMENT_MAX_ATTEMPTS = 3;
  /** OD-7-2: a settlement retry starts only with at least this much claim lease left. */
  static readonly SETTLEMENT_MIN_LEASE_MS = 5_000;

  private readonly logger = new Logger(DispatcherService.name);

  constructor(
    @Inject(DISPATCH_POOL) private readonly pool: Pool,
    private readonly providerStateStore: ProviderStateStore,
    private readonly executor: ProviderSubmissionExecutor,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Claims up to `limit` available messages using `FOR UPDATE SKIP LOCKED`.
   * Leases each claimed row for 30 seconds and increments dispatch_epoch.
   */
  async claimBatch(limit = 10): Promise<DispatchClaim[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const claimResult = await client.query<{
        message_id: string;
        org_id: string;
        dispatch_epoch: number;
      }>(
        `SELECT message_id, org_id, dispatch_epoch
         FROM message_dispatch_queue
         WHERE available_at <= now()
           AND (claimed_until IS NULL OR claimed_until < now())
         ORDER BY available_at, message_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );

      const claims: DispatchClaim[] = [];
      const leaseUntil = new Date(Date.now() + LEASE_DURATION_MS);

      for (const row of claimResult.rows) {
        const claimToken = randomUUID();
        const nextEpoch = row.dispatch_epoch + 1;

        await client.query(
          `UPDATE message_dispatch_queue
           SET claim_token = $1,
               claimed_until = $2,
               claimed_by = $3,
               dispatch_epoch = $4
           WHERE message_id = $5`,
          [claimToken, leaseUntil, 'dispatcher-worker', nextEpoch, row.message_id],
        );

        claims.push({
          messageId: row.message_id,
          orgId: row.org_id,
          dispatchEpoch: nextEpoch,
          claimToken,
        });
      }

      await client.query('COMMIT');
      return claims;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error(failureLogEntry('Failed to claim messages from queue', error));
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Processes a single claimed message end-to-end:
   * 1. Intent transaction (routing -> submitting, advisory lock, admission check, attempt creation).
   * 2. Execution outside transaction.
   * 3. Settlement transaction (fencing token verification, status update, observation recording, queue deletion).
   */
  async processClaim(claim: DispatchClaim): Promise<DispatchProcessResult> {
    const client = await this.pool.connect();
    let attemptId: string | undefined;

    try {
      // -----------------------------------------------------------------------
      // Step 1: Intent Transaction
      // -----------------------------------------------------------------------
      await client.query('BEGIN');

      // Set transaction-local dispatch context
      await client.query(
        `SELECT set_config('app.current_org_id', $1, true),
                set_config('app.dispatch_message_id', $2, true),
                set_config('app.dispatch_claim_token', $3, true)`,
        [claim.orgId, claim.messageId, claim.claimToken],
      );

      // Verify claim validity and fencing epoch before proceeding
      const queueResult = await client.query<{
        claim_token: string | null;
        dispatch_epoch: number;
      }>(
        // Phase 7 PR 7-5: the fence is read under the queue-row lock (§1zi.1: queue row
        // first in every dispatch transaction), so lease recovery (SKIP LOCKED) cannot
        // take the row while this transaction may settle money for it.
        `SELECT claim_token, dispatch_epoch FROM message_dispatch_queue WHERE message_id = $1 FOR UPDATE`,
        [claim.messageId],
      );
      const queueRows = queueResult.rows;

      if (
        !queueRows[0] ||
        queueRows[0].claim_token !== claim.claimToken ||
        queueRows[0].dispatch_epoch !== claim.dispatchEpoch
      ) {
        await client.query('ROLLBACK');
        return {
          messageId: claim.messageId,
          outcome: 'fenced',
          error: 'Claim superseded by another worker (fencing mismatch)',
        };
      }

      // Advisory lock: serialization with organization lifecycle transitions
      await client.query(`SELECT pg_advisory_xact_lock_shared($1, hashtext($2))`, [
        ORG_LIFECYCLE_LOCK_CLASS,
        claim.orgId,
      ]);

      // BE-DISPATCH-02: claimBatch also takes expired leases, so a claim can land
      // on a message whose earlier worker vanished mid-submission, before lease
      // recovery reaches it. That submission may have reached the provider:
      // settle it OUTCOME_UNKNOWN, exactly as recovery would, and never submit
      // it again — to another provider or, by the org-status paths, at all.
      const stateResult = await client.query<{
        status: string;
        current_attempt_id: string | null;
        billing_enforced: boolean;
      }>(`SELECT status, current_attempt_id, billing_enforced FROM messages WHERE id = $1`, [
        claim.messageId,
      ]);
      // Phase 7 PR 7-5: settlement applies only to messages submitted under billing
      // enforcement (immutable on the message; never the current flag).
      const enforced = stateResult.rows[0]?.billing_enforced === true;
      if (stateResult.rows[0]?.status === 'submitting') {
        const reason = await this.settleAbandonedSubmission(
          client,
          claim.orgId,
          claim.messageId,
          stateResult.rows[0].current_attempt_id,
        );
        await client.query('COMMIT');
        return {
          messageId: claim.messageId,
          ...(stateResult.rows[0].current_attempt_id
            ? { attemptId: stateResult.rows[0].current_attempt_id }
            : {}),
          outcome: 'unknown',
          error: reason,
        };
      }

      // Check organization lifecycle status
      const orgResult = await client.query<{ status: string }>(
        `SELECT status FROM organizations WHERE id = $1`,
        [claim.orgId],
      );
      const orgRows = orgResult.rows;

      if (!orgRows[0]) {
        await client.query('ROLLBACK');
        return { messageId: claim.messageId, outcome: 'failed', error: 'Organization not found' };
      }

      const orgStatus = orgRows[0].status;

      if (orgStatus === 'suspended') {
        // Hold queued work: release claim and back off 60s
        await client.query(
          `UPDATE message_dispatch_queue
           SET claim_token = NULL,
               claimed_until = NULL,
               claimed_by = NULL,
               available_at = now() + interval '60 seconds'
           WHERE message_id = $1 AND claim_token = $2`,
          [claim.messageId, claim.claimToken],
        );
        await client.query('COMMIT');
        return { messageId: claim.messageId, outcome: 'held', error: 'Organization suspended' };
      }

      if (orgStatus === 'closed') {
        // Terminalize message as failed
        await client.query(
          `UPDATE messages
           SET status = 'failed',
               failure_reason = 'Organization is closed',
               completed_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [claim.messageId],
        );
        // The event first: acc_dispatch may write it only while its claim row exists.
        await client.query(
          `INSERT INTO message_events (id, org_id, message_id, event_type, payload)
           VALUES ($1, $2, $3, 'message.failed', '{"reason":"Organization is closed"}')`,
          [uuidv7(), claim.orgId, claim.messageId],
        );
        await this.settleMessageBilling(client, enforced);
        await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
          claim.messageId,
        ]);
        await client.query('COMMIT');
        return { messageId: claim.messageId, outcome: 'failed', error: 'Organization closed' };
      }

      // Read message payload and details, with the channel code of its channel
      // (Phase 4.2: the channel is the message's, never assumed).
      const msgResult = await client.query<{
        id: string;
        channel_id: string;
        channel_code: string | null;
        recipient_address: string;
        payload: Record<string, unknown>;
        correlation_id: string;
      }>(
        `SELECT m.id, m.channel_id, c.code AS channel_code, m.recipient_address, m.payload,
                m.correlation_id
         FROM messages m
         LEFT JOIN channels c ON c.id = m.channel_id
         WHERE m.id = $1`,
        [claim.messageId],
      );
      const msgRows = msgResult.rows;

      if (!msgRows[0]) {
        await client.query('ROLLBACK');
        return { messageId: claim.messageId, outcome: 'failed', error: 'Message row not found' };
      }

      const message = msgRows[0];

      // Map the stored payload for the provider before any attempt exists: a
      // message that cannot be submitted fails here, with nothing to roll back.
      const channelCode = resolveChannelCode(message.channel_code);
      const mapping = channelCode
        ? mapMessageForSubmission(channelCode, message.payload)
        : ({
            ok: false,
            reason: `CHANNEL_UNSUPPORTED: ${message.channel_code ?? 'unknown'}`,
          } as const);

      if (!channelCode || !mapping.ok) {
        const reason = mapping.ok ? 'CHANNEL_UNSUPPORTED' : mapping.reason;
        await client.query(
          `UPDATE messages
           SET status = 'failed',
               failure_reason = $1,
               completed_at = now(),
               updated_at = now()
           WHERE id = $2`,
          [reason, claim.messageId],
        );
        // The event first: acc_dispatch may write it only while its claim row exists.
        await client.query(
          `INSERT INTO message_events (id, org_id, message_id, event_type, payload)
           VALUES ($1, $2, $3, 'message.failed', $4)`,
          [uuidv7(), claim.orgId, claim.messageId, JSON.stringify({ reason, attempts: 0 })],
        );
        await this.settleMessageBilling(client, enforced);
        await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
          claim.messageId,
        ]);
        await client.query('COMMIT');
        return { messageId: claim.messageId, outcome: 'failed', error: reason };
      }

      // Re-check suppression and consent at dispatch (Phase 4.3 G-2, migration
      // 0037): either may have changed since the send path checked them. Runs
      // on every claim, fallback re-claims included, before any provider is
      // selected. The function answers only for this live claim, with a code.
      const blockResult = await client.query<{ block: string | null }>(
        `SELECT app_dispatch_recipient_block() AS block`,
      );
      const block = blockResult.rows[0]?.block ?? null;

      if (block) {
        const priorAttemptsResult = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM message_attempts WHERE message_id = $1`,
          [claim.messageId],
        );
        const priorAttemptCount = parseInt(priorAttemptsResult.rows[0]?.count ?? '0', 10);
        await client.query(
          `UPDATE messages
           SET status = 'failed',
               failure_reason = $1,
               completed_at = now(),
               updated_at = now()
           WHERE id = $2`,
          [block, claim.messageId],
        );
        // The event first: acc_dispatch may write it only while its claim row exists.
        await client.query(
          `INSERT INTO message_events (id, org_id, message_id, event_type, payload)
           VALUES ($1, $2, $3, 'message.failed', $4)`,
          [
            uuidv7(),
            claim.orgId,
            claim.messageId,
            JSON.stringify({ reason: block, attempts: priorAttemptCount }),
          ],
        );
        await this.settleMessageBilling(client, enforced);
        await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
          claim.messageId,
        ]);
        await client.query('COMMIT');
        return { messageId: claim.messageId, outcome: 'failed', error: block };
      }

      // Read active provider assignments ordered by priority, excluding already-attempted providers (P3-D03, P3-D14, P3-D15)
      const assignmentsResult = await client.query<{
        id: string;
        provider_id: string;
        priority: number;
        provider_status: ProviderStatus;
      }>(
        `SELECT opa.id, opa.provider_id, opa.priority, p.status AS provider_status
         FROM organization_provider_assignments opa
         JOIN providers p ON p.id = opa.provider_id
         WHERE opa.org_id = $1 AND opa.channel_id = $2 AND opa.status = 'active'
           AND opa.provider_id NOT IN (
             SELECT ma.provider_id FROM message_attempts ma WHERE ma.message_id = $3
           )
         ORDER BY opa.priority ASC`,
        [claim.orgId, message.channel_id, claim.messageId],
      );
      const assignments = assignmentsResult.rows;

      if (assignments.length === 0) {
        // Check if there were prior attempts for this message (exhaustion vs no initial assignment)
        const priorAttemptsResult = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM message_attempts WHERE message_id = $1`,
          [claim.messageId],
        );
        const priorAttemptCount = parseInt(priorAttemptsResult.rows[0]?.count ?? '0', 10);
        const reason =
          priorAttemptCount > 0
            ? 'NO_ELIGIBLE_PROVIDER'
            : 'No active provider assignment for channel';

        await client.query(
          `UPDATE messages
           SET status = 'failed',
               failure_reason = $1,
               completed_at = now(),
               updated_at = now()
           WHERE id = $2`,
          [reason, claim.messageId],
        );
        // The event first: acc_dispatch may write it only while its claim row exists.
        await client.query(
          `INSERT INTO message_events (id, org_id, message_id, event_type, payload)
           VALUES ($1, $2, $3, 'message.failed', $4)`,
          [
            uuidv7(),
            claim.orgId,
            claim.messageId,
            JSON.stringify({ reason, attempts: priorAttemptCount }),
          ],
        );
        await this.settleMessageBilling(client, enforced);
        await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
          claim.messageId,
        ]);
        await client.query('COMMIT');
        return { messageId: claim.messageId, outcome: 'failed', error: reason };
      }

      // RCS content eligibility (Phase 4.2): drop providers whose declared
      // rcs_message_types exclude this message's type. Done before circuit
      // admission, so an ineligible provider never takes an admission or a
      // half-open probe slot. No declaration means every type.
      let candidates = assignments;
      if (mapping.rcs) {
        const messageType = mapping.rcs.messageType;
        const eligible = await this.rcsEligibleProviders(
          client,
          assignments.map((a) => a.provider_id),
          messageType,
        );
        candidates = assignments.filter((a) => eligible.has(a.provider_id));

        if (candidates.length === 0) {
          const priorAttemptsResult = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM message_attempts WHERE message_id = $1`,
            [claim.messageId],
          );
          const priorAttemptCount = parseInt(priorAttemptsResult.rows[0]?.count ?? '0', 10);
          await client.query(
            `UPDATE messages
             SET status = 'failed',
                 failure_reason = 'NO_ELIGIBLE_PROVIDER',
                 completed_at = now(),
                 updated_at = now()
             WHERE id = $1`,
            [claim.messageId],
          );
          // The event first: acc_dispatch may write it only while its claim row exists.
          await client.query(
            `INSERT INTO message_events (id, org_id, message_id, event_type, payload)
             VALUES ($1, $2, $3, 'message.failed', $4)`,
            [
              uuidv7(),
              claim.orgId,
              claim.messageId,
              JSON.stringify({
                reason: 'NO_ELIGIBLE_PROVIDER',
                attempts: priorAttemptCount,
                details: `No assigned RCS provider carries message type ${messageType}`,
              }),
            ],
          );
          await this.settleMessageBilling(client, enforced);
          await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
            claim.messageId,
          ]);
          await client.query('COMMIT');
          return { messageId: claim.messageId, outcome: 'failed', error: 'NO_ELIGIBLE_PROVIDER' };
        }
      }

      // Candidate iteration: try candidates in priority order, skipping providers that are
      // not active or whose circuit refuses admission (P3-D13, P3-D14; issue #20)
      const dbTx = drizzle(client, { schema });
      let selectedProviderId: string | null = null;
      let admission: Awaited<ReturnType<typeof this.providerStateStore.admit>> | null = null;
      const refusals = { lifecycle: 0, other: 0 };

      for (const candidate of candidates) {
        // Lifecycle exclusion before circuit admission (ROUTING_ENGINE.md §5, PROVIDER_ADAPTER.md §6f/§6h; issue #20)
        if (candidate.provider_status !== 'active') {
          refusals.lifecycle++;
          this.logger.warn({
            msg: 'Provider is not active (disabled or draining); trying next candidate',
            providerId: candidate.provider_id,
            status: candidate.provider_status,
            messageId: message.id,
            orgId: claim.orgId,
          });
          continue;
        }

        try {
          const candidateAdmission = await this.providerStateStore.admit(
            dbTx as never,
            DISPATCH_PRINCIPAL,
            candidate.provider_id,
          );
          if (candidateAdmission.admitted) {
            selectedProviderId = candidate.provider_id;
            admission = candidateAdmission;
            break;
          }
          refusals.other++;
          this.logger.warn({
            msg: 'Provider circuit refused admission; trying next candidate',
            providerId: candidate.provider_id,
            state: candidateAdmission.state,
            messageId: message.id,
            orgId: claim.orgId,
          });
        } catch (admitErr) {
          if (isProviderLifecycleRefusal(admitErr)) {
            refusals.lifecycle++;
            this.logger.warn({
              msg: 'Provider is not active (disabled or draining); trying next candidate',
              providerId: candidate.provider_id,
              status: admitErr.details?.status,
              messageId: message.id,
              orgId: claim.orgId,
            });
            continue;
          }
          refusals.other++;
          this.logger.error({
            ...failureLogEntry('Error checking circuit admission for provider', admitErr),
            providerId: candidate.provider_id,
            messageId: message.id,
            orgId: claim.orgId,
          });
        }
      }

      if (!selectedProviderId || !admission) {
        // No candidate admitted: not active, circuit-refused or admission failed (P3-D14; issue #20)
        await client.query(
          `UPDATE messages
           SET status = 'failed',
               failure_reason = 'NO_ELIGIBLE_PROVIDER',
               completed_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [claim.messageId],
        );
        await client.query(
          `INSERT INTO message_events (id, org_id, message_id, event_type, payload)
           VALUES ($1, $2, $3, 'message.failed', $4)`,
          [
            uuidv7(),
            claim.orgId,
            claim.messageId,
            JSON.stringify({
              reason: 'NO_ELIGIBLE_PROVIDER',
              details: noEligibleProviderDetails(refusals),
            }),
          ],
        );
        await this.settleMessageBilling(client, enforced);
        await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
          claim.messageId,
        ]);
        await client.query('COMMIT');
        return {
          messageId: claim.messageId,
          outcome: 'circuit_refused',
          error: 'NO_ELIGIBLE_PROVIDER',
        };
      }

      // Phase 7 PR 7-5: a refused pre-submit top-up undoes the attempt (and the
      // queued -> submitting transition) to this savepoint, then fails the message.
      if (enforced) await client.query('SAVEPOINT billing_attempt');

      // Create message attempt
      attemptId = uuidv7();

      // Read current max attempt number
      const attemptNumResult = await client.query<{ max_num: number | null }>(
        `SELECT max(attempt_number) AS max_num FROM message_attempts WHERE message_id = $1`,
        [claim.messageId],
      );
      const attemptNumRows = attemptNumResult.rows;
      const attemptNumber = (attemptNumRows[0]?.max_num ?? 0) + 1;

      // Transition message status: queued -> submitting
      await client.query(
        `UPDATE messages
         SET status = 'submitting',
             current_attempt_id = $1,
             updated_at = now()
         WHERE id = $2`,
        [attemptId, claim.messageId],
      );

      await client.query(
        `INSERT INTO message_attempts (
           id, message_id, org_id, provider_id, channel_id, attempt_number,
           fencing_epoch, claim_token, status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, 'submitting'
         )`,
        [
          attemptId,
          claim.messageId,
          claim.orgId,
          selectedProviderId,
          message.channel_id,
          attemptNumber,
          claim.dispatchEpoch,
          claim.claimToken,
        ],
      );

      await client.query(
        `INSERT INTO message_events (id, org_id, message_id, attempt_id, event_type, payload)
         VALUES ($1, $2, $3, $4, 'message.submitting', $5)`,
        [
          uuidv7(),
          claim.orgId,
          claim.messageId,
          attemptId,
          JSON.stringify({ attemptNumber, providerId: selectedProviderId }),
        ],
      );

      // Phase 7 PR 7-5 (RQ-2, D-74-3): rate this attempt and top up the reservation when
      // the remaining reservation is below its price — before any provider call. The
      // units re-derived for submission must equal those persisted at submission.
      if (enforced) {
        const refusal = await this.reserveAttempt(
          client,
          attemptId,
          mapping.sms ? mapping.sms.segments : 1,
        );
        if (refusal) {
          await client.query('ROLLBACK TO SAVEPOINT billing_attempt');
          const reason = `${refusal}: refused before provider submission`;
          await client.query(
            `UPDATE messages
             SET status = 'failed',
                 failure_reason = $1,
                 completed_at = now(),
                 updated_at = now()
             WHERE id = $2`,
            [reason, claim.messageId],
          );
          await client.query(
            `INSERT INTO message_events (id, org_id, message_id, event_type, payload)
             VALUES ($1, $2, $3, 'message.failed', $4)`,
            [uuidv7(), claim.orgId, claim.messageId, JSON.stringify({ reason: refusal })],
          );
          await this.settleMessageBilling(client, enforced);
          await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
            claim.messageId,
          ]);
          await client.query('COMMIT');
          return { messageId: claim.messageId, outcome: 'failed', error: refusal };
        }
      }

      // Read simulator_behavior capability from PostgreSQL (ADR-014 §10, D19)
      let simulatorBehavior: SimulatorBehavior = 'SUCCESS';
      const capResult = await client.query<{ value: unknown }>(
        `SELECT value FROM provider_capabilities WHERE provider_id = $1 AND capability_key = 'simulator_behavior'`,
        [selectedProviderId],
      );
      const capRows = capResult.rows;
      if (capRows[0]?.value) {
        const rawVal = capRows[0].value;
        const valStr = typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal);
        simulatorBehavior = valStr.replace(/^"|"$/g, '') as SimulatorBehavior;
      }

      await client.query('COMMIT');

      // -----------------------------------------------------------------------
      // Step 2: Submission Execution (Outside DB Transaction)
      // -----------------------------------------------------------------------

      // Pre-submission race protection (U13.2 Requirement 4 & 5):
      // Recheck organization status immediately before external provider submission.
      const preCheck = await client.query<{ status: string }>(
        `SELECT status FROM organizations WHERE id = $1`,
        [claim.orgId],
      );
      const preStatus = preCheck.rows[0]?.status;

      if (preStatus === 'suspended') {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [claim.orgId, claim.messageId, claim.claimToken],
        );
        await client.query(`SELECT pg_advisory_xact_lock_shared($1, hashtext($2))`, [
          ORG_LIFECYCLE_LOCK_CLASS,
          claim.orgId,
        ]);
        await client.query(
          `UPDATE messages
           SET status = 'queued',
               updated_at = now()
           WHERE id = $1`,
          [claim.messageId],
        );
        await client.query(
          `UPDATE message_attempts
           SET status = 'failed',
               failure_reason = 'Organization was suspended before provider submission',
               completed_at = now()
           WHERE id = $1`,
          [attemptId],
        );
        await client.query(
          `UPDATE message_dispatch_queue
           SET claim_token = NULL,
               claimed_until = NULL,
               claimed_by = NULL,
               available_at = now() + interval '60 seconds'
           WHERE message_id = $1 AND claim_token = $2`,
          [claim.messageId, claim.claimToken],
        );
        await client.query('COMMIT');
        return {
          messageId: claim.messageId,
          outcome: 'held',
          error: 'Organization suspended before provider submission',
        };
      }

      if (preStatus === 'closed') {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [claim.orgId, claim.messageId, claim.claimToken],
        );
        await client.query(`SELECT pg_advisory_xact_lock_shared($1, hashtext($2))`, [
          ORG_LIFECYCLE_LOCK_CLASS,
          claim.orgId,
        ]);
        await client.query(
          `UPDATE messages
           SET status = 'failed',
               failure_reason = 'Organization is closed',
               completed_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [claim.messageId],
        );
        await client.query(
          `UPDATE message_attempts
           SET status = 'failed',
               failure_reason = 'Organization is closed',
               completed_at = now()
           WHERE id = $1`,
          [attemptId],
        );
        await client.query(
          `INSERT INTO message_events (id, org_id, message_id, attempt_id, event_type, payload)
           VALUES ($1, $2, $3, $4, 'message.failed', '{"reason":"Organization is closed"}')`,
          [uuidv7(), claim.orgId, claim.messageId, attemptId],
        );
        await this.settleMessageBilling(client, enforced);
        await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
          claim.messageId,
        ]);
        await client.query('COMMIT');
        return {
          messageId: claim.messageId,
          outcome: 'failed',
          error: 'Organization closed',
        };
      }

      const settled = await this.executor.execute(
        admission.admission,
        {
          // Phase 5.0 (OD-8): the attempt id is the submission reference and the client
          // reference a provider echoes in its receipts — unique per attempt, so every
          // attempt of a message gets its own provider message id.
          submissionId: attemptId,
          correlationId: message.correlation_id,
          channel: channelCode,
          recipient: message.recipient_address,
          content: mapping.content,
          ...(mapping.sms ? { sms: mapping.sms } : {}),
          ...(mapping.rcs ? { rcs: mapping.rcs } : {}),
        },
        simulatorBehavior,
      );

      // -----------------------------------------------------------------------
      // Step 3: Settlement Transaction — retried alone, never the provider call (OD-7-2)
      // -----------------------------------------------------------------------
      // The circuit record is taken from the admission ledger exactly once, here.
      const record = this.providerStateStore.takeSubmissionRecord(settled);
      return await this.settleWithRetry(client, {
        claim,
        attemptId,
        attemptNumber,
        selectedProviderId,
        message,
        mapping,
        settled,
        record,
        enforced,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error(failureLogEntry('Failed to process dispatch claim', error));
      return {
        messageId: claim.messageId,
        attemptId,
        outcome: 'unknown',
        error: String(error),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Phase 7 PR 7-5 (OD-7-2): the settlement transaction (T3), whole — BEGIN, dispatch
   * context, org-lifecycle lock, the fence read FOR UPDATE, the message lock, the
   * circuit/health recording, the attempt and message updates, settlement facts, the
   * queue row, COMMIT. It holds nothing between runs, so `settleWithRetry` can run it
   * again from the top after a rollback. It never calls the provider: it works on the
   * provider result (`settled`) and the circuit record already taken.
   */
  private async settleSubmission(
    client: PoolClient,
    t: SettlementInput,
    sink: { afterCommit?: () => void },
  ): Promise<DispatchProcessResult> {
    const {
      claim,
      attemptId,
      attemptNumber,
      selectedProviderId,
      message,
      mapping,
      settled,
      record,
      enforced,
    } = t;
    await client.query('BEGIN');

    // Re-set dispatch session context
    await client.query(
      `SELECT set_config('app.current_org_id', $1, true),
              set_config('app.dispatch_message_id', $2, true),
              set_config('app.dispatch_claim_token', $3, true)`,
      [claim.orgId, claim.messageId, claim.claimToken],
    );

    await client.query(`SELECT pg_advisory_xact_lock_shared($1, hashtext($2))`, [
      ORG_LIFECYCLE_LOCK_CLASS,
      claim.orgId,
    ]);

    // Fencing check: verify dispatch_epoch and claim_token match
    const fenceResult = await client.query<{
      dispatch_epoch: number;
      claim_token: string | null;
    }>(
      // Phase 7 PR 7-5 (OD-7-2): the settlement fence is read FOR UPDATE.
      `SELECT dispatch_epoch, claim_token
       FROM message_dispatch_queue
       WHERE message_id = $1
       FOR UPDATE`,
      [claim.messageId],
    );
    const fenceRows = fenceResult.rows;

    if (
      !fenceRows[0] ||
      fenceRows[0].dispatch_epoch !== claim.dispatchEpoch ||
      fenceRows[0].claim_token !== claim.claimToken
    ) {
      // Fencing breach: leased token or epoch was lost/recovered!
      this.logger.warn({
        msg: 'Dispatcher fencing epoch breach detected; aborting settlement',
        messageId: claim.messageId,
        expectedEpoch: claim.dispatchEpoch,
        actualEpoch: fenceRows[0]?.dispatch_epoch,
      });
      await client.query('ROLLBACK');
      return {
        messageId: claim.messageId,
        attemptId,
        outcome: 'fenced',
        error: 'Fencing check failed',
      };
    }

    // Phase 5.0 lock order (§B.8): the message row first, before anything touches the
    // attempt — including the observation below, whose attempt reference takes a key-share
    // lock on it. Delivery ingestion locks message then attempt, so this order cannot
    // deadlock with a receipt for the same attempt (AC-LK-1/2).
    await lockMessage(client, claim.messageId);

    // Phase 5.0: the receipt types the selected provider declares decide the attempt's
    // initial delivery status (`pending`, or `not_supported` without receipts, OD-3).
    const receipts = await this.deliveryReceiptsOf(client, selectedProviderId);
    const initialDelivery = initialDeliveryStatus(receipts);

    // Record observation and sample in providerStateStore
    const settlementTx = drizzle(client, { schema });
    // OD-7-2 recording split: the record was taken once, before the retry loop; this
    // writes it in this transaction only, and its metrics wait for COMMIT (sink).
    const written = await this.providerStateStore.writeSubmissionRecord(
      settlementTx as never,
      DISPATCH_PRINCIPAL,
      record,
      { attemptId },
    );
    sink.afterCommit = written.afterCommit;

    // Evaluate outcome taxonomy
    const isAccepted = settled.result.outcome === 'accepted';
    const failureCategory =
      'failure' in settled.result && settled.result.failure
        ? settled.result.failure.category
        : null;
    const failureMessage =
      'failure' in settled.result && settled.result.failure
        ? settled.result.failure.message
        : 'Provider submission rejected';
    const fullFailureReason = failureCategory
      ? `${failureCategory}: ${failureMessage}`
      : failureMessage;

    if (isAccepted) {
      // Success path
      await client.query(
        // Phase 5.0: the provider message id (write-once) and the initial delivery status are
        // written in the same statement that settles the attempt — the terminal guard admits
        // no later provider reference on an accepted attempt (migration 0044).
        `UPDATE message_attempts
         SET status = 'accepted',
             failure_reason = NULL,
             latency_ms = $1,
             completed_at = now(),
             provider_message_id = $3,
             delivery_status = $4,
             delivery_updated_at = now()
         WHERE id = $2`,
        [
          settled.result.latencyMs,
          attemptId,
          settled.result.outcome === 'accepted' ? settled.result.providerMessageId : null,
          initialDelivery,
        ],
      );
      await this.settleAttemptBilling(client, enforced, attemptId, reachedProvider(settled.result));

      await client.query(
        `UPDATE messages
         SET status = 'accepted',
             failure_reason = NULL,
             completed_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [claim.messageId],
      );

      await client.query(
        `INSERT INTO message_events (id, org_id, message_id, attempt_id, event_type, payload)
         VALUES ($1, $2, $3, $4, 'message.accepted', $5)`,
        [
          uuidv7(),
          claim.orgId,
          claim.messageId,
          attemptId,
          JSON.stringify({ latencyMs: settled.result.latencyMs }),
        ],
      );

      // Phase 5.0: the message's delivery state and the held receipts — while the claim row
      // still exists (every acc_dispatch policy is claim-bound).
      await this.settleDelivery(client, claim, attemptId, selectedProviderId, {
        providerMessageId:
          settled.result.outcome === 'accepted' ? settled.result.providerMessageId : null,
        receipts,
      });

      await this.settleMessageBilling(client, enforced);
      await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
        claim.messageId,
      ]);

      await client.query('COMMIT');
      return {
        messageId: claim.messageId,
        attemptId,
        outcome: 'accepted',
      };
    }

    // Ambiguous outcome: TIMEOUT or UNKNOWN (ADR-014 §7, D16) -> OUTCOME_UNKNOWN
    if (failureCategory === 'TIMEOUT' || failureCategory === 'UNKNOWN') {
      const unknownReason =
        failureCategory === 'TIMEOUT'
          ? 'TIMEOUT: Submission timed out'
          : `UNKNOWN: ${failureMessage}`;

      await client.query(
        `UPDATE message_attempts
         SET status = 'outcome_unknown',
             failure_reason = $1,
             latency_ms = $2,
             completed_at = now(),
             delivery_status = $4,
             delivery_updated_at = now()
         WHERE id = $3`,
        [unknownReason, settled.result.latencyMs, attemptId, initialDelivery],
      );
      // OD-7-4U: an unknown outcome never reached-billed: no provider cost, no charge.
      await this.settleAttemptBilling(client, enforced, attemptId, false);

      await client.query(
        `UPDATE messages
         SET status = 'outcome_unknown',
             failure_reason = $1,
             completed_at = now(),
             updated_at = now()
         WHERE id = $2`,
        [unknownReason, claim.messageId],
      );

      await client.query(
        `INSERT INTO message_events (id, org_id, message_id, attempt_id, event_type, payload)
         VALUES ($1, $2, $3, $4, 'message.outcome_unknown', $5)`,
        [
          uuidv7(),
          claim.orgId,
          claim.messageId,
          attemptId,
          JSON.stringify({
            category: failureCategory,
            reason: unknownReason,
            latencyMs: settled.result.latencyMs,
          }),
        ],
      );

      // Phase 5.0: delivery is tracked for an unknown outcome too — a receipt may resolve it
      // on the delivery axis while the submission status stays outcome_unknown (§B.5 rule 5).
      await this.settleDelivery(client, claim, attemptId, selectedProviderId, {
        providerMessageId: null,
        receipts,
      });

      // Delete from queue (terminal, non-retryable, zero fallback per ADR-014 D16)
      await this.settleMessageBilling(client, enforced);
      await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
        claim.messageId,
      ]);

      await client.query('COMMIT');
      return {
        messageId: claim.messageId,
        attemptId,
        outcome: 'unknown',
        error: unknownReason,
      };
    }

    // Definite non-acceptance: settle attempt as failed with structured reason
    await client.query(
      `UPDATE message_attempts
       SET status = 'failed',
           failure_reason = $1,
           latency_ms = $2,
           completed_at = now()
       WHERE id = $3`,
      [fullFailureReason, settled.result.latencyMs, attemptId],
    );
    await this.settleAttemptBilling(client, enforced, attemptId, reachedProvider(settled.result));

    const isFallbackEligible =
      failureCategory === 'PROVIDER_ERROR' || failureCategory === 'RATE_LIMITED';

    if (isFallbackEligible) {
      // Check if there are remaining active candidates for this message
      const remainingResult = await client.query<{ provider_id: string }>(
        `SELECT opa.provider_id
         FROM organization_provider_assignments opa
         WHERE opa.org_id = $1 AND opa.channel_id = $2 AND opa.status = 'active'
           AND opa.provider_id NOT IN (
             SELECT ma.provider_id FROM message_attempts ma WHERE ma.message_id = $3
           )`,
        [claim.orgId, message.channel_id, claim.messageId],
      );
      const remainingIds = remainingResult.rows.map((r) => r.provider_id);
      // RCS: only providers the next claim would actually try count (Phase 4.2),
      // so a message is not requeued just to be refused by its own next claim.
      const remainingCount = mapping.rcs
        ? (await this.rcsEligibleProviders(client, remainingIds, mapping.rcs.messageType)).size
        : remainingIds.length;

      if (remainingCount > 0) {
        // Re-queue message for fallback: submitting -> queued
        await client.query(
          `UPDATE messages
           SET status = 'queued',
               current_attempt_id = NULL,
               failure_reason = $1,
               updated_at = now()
           WHERE id = $2`,
          [fullFailureReason, claim.messageId],
        );

        // Append fallback requeue event while active claim still exists for RLS
        await client.query(
          `INSERT INTO message_events (id, org_id, message_id, attempt_id, event_type, payload)
           VALUES ($1, $2, $3, $4, 'message.queued', $5)`,
          [
            uuidv7(),
            claim.orgId,
            claim.messageId,
            attemptId,
            JSON.stringify({
              reason: 'fallback',
              attemptNumber,
              failureCategory,
              remainingCandidates: remainingCount,
            }),
          ],
        );

        // Phase 5.0: receipts held for this failed attempt (anomaly path, §B.3), before the
        // claim is released. Never cancels or alters the requeue (§B.6a rules 3–5).
        await this.settleDelivery(client, claim, attemptId, selectedProviderId, {
          providerMessageId: null,
          receipts,
        });

        // Release claim on queue so next worker/poll claims with fresh token and epoch
        await client.query(
          `UPDATE message_dispatch_queue
           SET claim_token = NULL,
               claimed_until = NULL,
               claimed_by = NULL,
               available_at = now()
           WHERE message_id = $1`,
          [claim.messageId],
        );

        await client.query('COMMIT');
        return {
          messageId: claim.messageId,
          attemptId,
          outcome: 'failed',
          error: fullFailureReason,
        };
      }
    }

    // Candidate exhaustion or non-fallback failure: terminal failed
    const terminalReason = isFallbackEligible ? 'NO_ELIGIBLE_PROVIDER' : fullFailureReason;

    await client.query(
      `UPDATE messages
       SET status = 'failed',
           failure_reason = $1,
           completed_at = now(),
           updated_at = now()
       WHERE id = $2`,
      [terminalReason, claim.messageId],
    );

    await client.query(
      `INSERT INTO message_events (id, org_id, message_id, attempt_id, event_type, payload)
       VALUES ($1, $2, $3, $4, 'message.failed', $5)`,
      [
        uuidv7(),
        claim.orgId,
        claim.messageId,
        attemptId,
        JSON.stringify({
          reason: terminalReason,
          failureCategory,
          latencyMs: settled.result.latencyMs,
        }),
      ],
    );

    await this.settleDelivery(client, claim, attemptId, selectedProviderId, {
      providerMessageId: null,
      receipts,
    });

    await this.settleMessageBilling(client, enforced);
    await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
      claim.messageId,
    ]);

    await client.query('COMMIT');

    return {
      messageId: claim.messageId,
      attemptId,
      outcome: 'failed',
      error: terminalReason,
    };
  }

  /**
   * Phase 7 PR 7-5 (OD-7-2): runs the settlement transaction, retrying **only it**
   * after a deadlock (40P01) or serialization failure (40001): at most
   * SETTLEMENT_MAX_ATTEMPTS runs, with 25–100 ms jitter, and a retry only while the
   * claim lease has at least SETTLEMENT_MIN_LEASE_MS left. Each run re-reads the fence
   * under the queue-row lock, so a superseded worker never settles.
   *
   * A database error aborts the PostgreSQL transaction, so the run is rolled back as a
   * whole — no partial fact, sample or status survives — and the next run starts from
   * BEGIN. The provider result is the immutable `settled` value in memory and the
   * circuit record was taken once, before the first run: no path here can reach the
   * executor or issue an admission, so the provider is never called again. Metrics are
   * published once, after the run that commits.
   *
   * Exhaustion or any other error is rethrown, leaving the message `submitting` with its
   * claim held and no ledger fact. Lease recovery then settles it `outcome_unknown`
   * (baseline §9.2, D-2): released, never charged, never re-sent.
   */
  private async settleWithRetry(
    client: PoolClient,
    t: SettlementInput,
  ): Promise<DispatchProcessResult> {
    for (let run = 1; ; run += 1) {
      const sink: { afterCommit?: () => void } = {};
      try {
        const result = await this.settleSubmission(client, t, sink);
        sink.afterCommit?.();
        if (run > 1) this.metrics?.dispatchSettlementRetries.inc({ outcome: 'succeeded' });
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = sqlState(error);
        const context = { messageId: t.claim.messageId, attemptId: t.attemptId, run };
        if (code !== '40P01' && code !== '40001') {
          this.metrics?.dispatchSettlementRetries.inc({ outcome: 'non_retryable' });
          this.logger.error({
            ...failureLogEntry('Settlement transaction failed; left for lease recovery', error),
            ...context,
          });
          throw error;
        }
        const leaseMs =
          run < DispatcherService.SETTLEMENT_MAX_ATTEMPTS
            ? await this.remainingLeaseMs(client, t.claim)
            : null;
        if (leaseMs === null || leaseMs < DispatcherService.SETTLEMENT_MIN_LEASE_MS) {
          this.metrics?.dispatchSettlementRetries.inc({ outcome: 'exhausted' });
          this.logger.error({
            ...failureLogEntry('Settlement retries exhausted; left for lease recovery', error),
            ...context,
            leaseMs,
          });
          throw error;
        }
        this.logger.warn({
          ...failureLogEntry('Settlement transaction failed; retrying', error),
          ...context,
        });
        await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 76)));
      }
    }
  }

  /** The claim's remaining lease in ms, or null when the claim is no longer this worker's. */
  private async remainingLeaseMs(client: PoolClient, claim: DispatchClaim): Promise<number | null> {
    await client.query('BEGIN');
    try {
      await client.query(
        `SELECT set_config('app.current_org_id', $1, true),
                set_config('app.dispatch_message_id', $2, true),
                set_config('app.dispatch_claim_token', $3, true)`,
        [claim.orgId, claim.messageId, claim.claimToken],
      );
      const { rows } = await client.query<{ ms: string | null }>(
        `SELECT (EXTRACT(EPOCH FROM (claimed_until - clock_timestamp())) * 1000)::bigint::text AS ms
           FROM message_dispatch_queue
          WHERE message_id = $1 AND claim_token = $2 AND dispatch_epoch = $3`,
        [claim.messageId, claim.claimToken, claim.dispatchEpoch],
      );
      return rows[0]?.ms == null ? null : Number(rows[0].ms);
    } finally {
      await client.query('COMMIT').catch(() => undefined);
    }
  }

  /**
   * Phase 7 PR 7-5: charges (on a confirmed accepted chain) and releases the reservation,
   * in the transaction that finishes the message, while the claim row still exists
   * (`app_dispatch_message_settle` verifies the live claim). Nothing for a message not
   * submitted under billing enforcement.
   */
  private async settleMessageBilling(client: PoolClient, enforced: boolean): Promise<void> {
    if (!enforced) return;
    await client.query(`SELECT * FROM app_dispatch_message_settle()`);
  }

  /**
   * Phase 7 PR 7-5: records whether a settled attempt reached the provider and, if it did,
   * its provider cost — after the attempt's terminal status is written, in the same
   * transaction (`app_dispatch_attempt_settle`).
   */
  private async settleAttemptBilling(
    client: PoolClient,
    enforced: boolean,
    attemptId: string,
    reached: boolean,
  ): Promise<void> {
    if (!enforced) return;
    await client.query(`SELECT * FROM app_dispatch_attempt_settle($1, $2)`, [attemptId, reached]);
  }

  /**
   * Phase 7 PR 7-5: rates the new attempt and tops up the reservation if needed
   * (`app_dispatch_attempt_reserve`). Returns the refusal code for a billing refusal
   * (the caller rolls back to its savepoint and fails the message); rethrows anything
   * else.
   */
  private async reserveAttempt(
    client: PoolClient,
    attemptId: string,
    units: number,
  ): Promise<string | null> {
    try {
      await client.query(`SELECT * FROM app_dispatch_attempt_reserve($1, $2)`, [attemptId, units]);
      return null;
    } catch (error) {
      const refusal = ATTEMPT_BILLING_REFUSALS[sqlState(error) ?? ''];
      if (!refusal) throw error;
      return refusal;
    }
  }

  /** The receipt types the provider declares (`delivery_receipts`, OD-3); none when absent. */
  private async deliveryReceiptsOf(
    client: PoolClient,
    providerId: string,
  ): Promise<ReadonlySet<DeliveryReceiptType>> {
    const { rows } = await client.query<{ value: unknown }>(
      `SELECT value FROM provider_capabilities WHERE provider_id = $1 AND capability_key = $2`,
      [providerId, DELIVERY_RECEIPTS_CAPABILITY],
    );
    return declaredDeliveryReceipts(rows[0]?.value);
  }

  /**
   * Phase 5.0 settlement of the delivery axis (design spec Rev 2 §B.3, §B.5, §E.6; plan T6),
   * in the settlement transaction, under the message lock and the live claim, after the
   * attempt has settled (with its initial delivery status when `accepted`/`outcome_unknown`):
   * derives the message's delivery state, then applies the receipts held for this attempt
   * (`deferred`/`unmatched`). Changes only delivery columns, `message_events` and held
   * `webhook_events` outcomes.
   */
  private async settleDelivery(
    client: PoolClient,
    claim: Pick<DispatchClaim, 'orgId' | 'messageId'>,
    attemptId: string,
    providerId: string,
    options: {
      readonly providerMessageId: string | null;
      readonly receipts: ReadonlySet<DeliveryReceiptType>;
    },
  ): Promise<void> {
    const receipts = options.receipts;
    await refreshMessageDeliveryState(client, claim.messageId);
    await applyHeldReceipts(client, {
      orgId: claim.orgId,
      messageId: claim.messageId,
      attemptId,
      providerId,
      providerMessageId: options.providerMessageId,
      receipts,
      now: new Date(),
    });
  }

  /**
   * The providers among `providerIds` that carry an RCS message of `messageType`
   * by their declared `rcs_message_types` (no declaration: every type). One rule
   * for both claim-time candidate selection and settlement-time fallback, so a
   * message is never requeued for a provider the next claim would skip.
   */
  private async rcsEligibleProviders(
    client: PoolClient,
    providerIds: readonly string[],
    messageType: RcsMessageType,
  ): Promise<Set<string>> {
    if (providerIds.length === 0) return new Set();
    const declaredResult = await client.query<{ provider_id: string; value: unknown }>(
      `SELECT provider_id, value FROM provider_capabilities
       WHERE capability_key = $1 AND provider_id = ANY($2::uuid[])`,
      [RCS_MESSAGE_TYPES_CAPABILITY, providerIds],
    );
    const declared = new Map(declaredResult.rows.map((r) => [r.provider_id, r.value]));
    return new Set(
      providerIds.filter((id) =>
        rcsProviderSupports(
          declared.has(id) ? { [RCS_MESSAGE_TYPES_CAPABILITY]: declared.get(id) } : {},
          messageType,
        ),
      ),
    );
  }

  /**
   * Settles a message whose submission was abandoned mid-flight (its worker's
   * lease ran out while it was `submitting`): the attempt and the message become
   * OUTCOME_UNKNOWN, terminal and never resubmitted (P3-D11, ADR-014 D16), and
   * the queue row is deleted. The caller holds a live claim on the queue row
   * and has set the dispatch context; the event is written before the delete.
   */
  private async settleAbandonedSubmission(
    client: PoolClient,
    orgId: string,
    messageId: string,
    attemptId: string | null,
  ): Promise<string> {
    const reason = 'Dispatch lease expired during external submission (outcome_unknown)';

    // Phase 5.0 lock order (§B.8): the message row before the attempt.
    await lockMessage(client, messageId);

    // Phase 5.0: an abandoned submission is an unknown outcome, tracked on the delivery axis
    // like any other (§B.3); its initial status is written as the attempt settles.
    let delivery: { providerId: string; receipts: ReadonlySet<DeliveryReceiptType> } | null = null;
    if (attemptId) {
      const { rows } = await client.query<{ provider_id: string }>(
        `SELECT provider_id FROM message_attempts WHERE id = $1`,
        [attemptId],
      );
      if (rows[0]) {
        delivery = {
          providerId: rows[0].provider_id,
          receipts: await this.deliveryReceiptsOf(client, rows[0].provider_id),
        };
      }
      await client.query(
        `UPDATE message_attempts
         SET status = 'outcome_unknown',
             failure_reason = $1,
             completed_at = now(),
             delivery_status = $3::message_delivery_status,
             delivery_updated_at = CASE WHEN $3::message_delivery_status IS NULL THEN NULL ELSE now() END
         WHERE id = $2`,
        [reason, attemptId, delivery ? initialDeliveryStatus(delivery.receipts) : null],
      );
    }

    await client.query(
      `UPDATE messages
       SET status = 'outcome_unknown',
           failure_reason = $1,
           completed_at = now(),
           updated_at = now()
       WHERE id = $2`,
      [reason, messageId],
    );

    await client.query(
      `INSERT INTO message_events (id, org_id, message_id, attempt_id, event_type, payload)
       VALUES ($1, $2, $3, $4, 'message.outcome_unknown', $5)`,
      [
        uuidv7(),
        orgId,
        messageId,
        attemptId,
        JSON.stringify({ outcome: 'outcome_unknown', reason }),
      ],
    );

    if (attemptId && delivery) {
      await this.settleDelivery(client, { orgId, messageId }, attemptId, delivery.providerId, {
        providerMessageId: null,
        receipts: delivery.receipts,
      });
    }

    // Phase 7 PR 7-5 (OD-7-4U): an abandoned submission is never charged and carries no
    // provider cost; its reservation is released in this transaction, which finishes the
    // message, while the (recovery or new) claim is still live.
    const billing = await client.query<{ billing_enforced: boolean }>(
      `SELECT billing_enforced FROM messages WHERE id = $1`,
      [messageId],
    );
    const enforced = billing.rows[0]?.billing_enforced === true;
    if (attemptId) await this.settleAttemptBilling(client, enforced, attemptId, false);
    await this.settleMessageBilling(client, enforced);

    // Delete from queue (non-retryable)
    await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [messageId]);
    return reason;
  }

  /**
   * Recovers expired leases (P3-D11 / ADR-014 D18).
   * Attempts that expired during 'submitting' status cannot be safely retried
   * and must be terminalized as OUTCOME_UNKNOWN (terminal, non-retryable).
   *
   * Phase 7 PR 7-5 (OD-7-2): **one expired lease per transaction**. Settlement takes
   * the organization's billing account, so a batch spanning organizations could
   * deadlock with another recovery run; and a lease that fails (a poison lease) must
   * not hold back the others. A failing lease is rolled back, logged and skipped for
   * the rest of this run; it is retried on the next cycle, never re-sent. The first
   * error is rethrown once every other lease has been recovered.
   */
  async recoverExpiredLeases(): Promise<number> {
    const client = await this.pool.connect();
    const skipped: string[] = [];
    let firstError: unknown = null;
    let recovered = 0;
    try {
      for (;;) {
        let messageId: string | null = null;
        try {
          await client.query('BEGIN');
          const expiredResult = await client.query<{
            message_id: string;
            org_id: string;
            claim_token: string | null;
            dispatch_epoch: number;
          }>(
            `SELECT message_id, org_id, claim_token, dispatch_epoch
             FROM message_dispatch_queue
             WHERE claimed_until < now()
               AND NOT (message_id = ANY($1::uuid[]))
             ORDER BY claimed_until, message_id
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [skipped],
          );
          const row = expiredResult.rows[0];
          if (!row) {
            await client.query('COMMIT');
            break;
          }
          messageId = row.message_id;

          // Claim the expired queue row for recovery
          const recoveryToken = randomUUID();
          await client.query(
            `UPDATE message_dispatch_queue
             SET claim_token = $1,
                 claimed_until = now() + interval '30 seconds',
                 dispatch_epoch = dispatch_epoch + 1
             WHERE message_id = $2`,
            [recoveryToken, row.message_id],
          );

          // Set dispatch context under the active recovery claim
          await client.query(
            `SELECT set_config('app.current_org_id', $1, true),
                    set_config('app.dispatch_message_id', $2, true),
                    set_config('app.dispatch_claim_token', $3, true)`,
            [row.org_id, row.message_id, recoveryToken],
          );

          // Check if message is in 'submitting' status
          const msgResult = await client.query<{
            status: string;
            current_attempt_id: string | null;
          }>(`SELECT status, current_attempt_id FROM messages WHERE id = $1`, [row.message_id]);
          const msgRows = msgResult.rows;

          if (msgRows[0]?.status === 'submitting') {
            await this.settleAbandonedSubmission(
              client,
              row.org_id,
              row.message_id,
              msgRows[0].current_attempt_id,
            );
          } else {
            // Message was not submitting (e.g. queued/routing): release claim for redelivery
            await client.query(
              `UPDATE message_dispatch_queue
               SET claim_token = NULL,
                   claimed_until = NULL,
                   claimed_by = NULL
               WHERE message_id = $1`,
              [row.message_id],
            );
          }

          await client.query('COMMIT');
          recovered++;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          this.logger.error(failureLogEntry('Failed to recover expired leases', error));
          firstError ??= error;
          // Without a row there is nothing to skip: the failure is not lease-specific.
          if (messageId === null) break;
          skipped.push(messageId);
        }
      }
    } finally {
      client.release();
    }
    if (firstError !== null) throw firstError;
    return recovered;
  }

  /**
   * Runs a single dispatch cycle: claims up to `limit` messages and processes
   * them together. Every claim in a batch shares one 30 s lease, sized for a
   * single claim's longest legitimate hold (ADR-014 D18), so they cannot be
   * processed one after another: ten submissions at the 3 s submission timeout
   * would outlive it. The dispatch pool bounds how many run at once.
   */
  async dispatchBatch(limit = 10): Promise<DispatchProcessResult[]> {
    const claims = await this.claimBatch(limit);
    const settled = await Promise.allSettled(claims.map((claim) => this.processClaim(claim)));
    return settled.map((result, i) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            messageId: claims[i]?.messageId ?? '',
            outcome: 'unknown',
            error: String(result.reason),
          },
    );
  }
}
