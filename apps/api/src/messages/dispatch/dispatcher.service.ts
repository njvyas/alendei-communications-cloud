import { Inject, Injectable, Logger } from '@nestjs/common';
import { ORG_LIFECYCLE_LOCK_CLASS, schema } from '@acc/db';
import {
  RCS_MESSAGE_TYPES_CAPABILITY,
  rcsProviderSupports,
  type AuthPrincipal,
  type RcsMessageType,
  type SimulatorBehavior,
} from '@acc/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

import { DISPATCH_POOL } from '../../database/database.tokens';
import { ProviderSubmissionExecutor } from '../../provider-adapters/submission-executor';
import { ProviderStateStore } from '../../providers/provider-state.store';
import { mapMessageForSubmission, resolveChannelCode } from './submission-mapping';

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

@Injectable()
export class DispatcherService {
  private readonly logger = new Logger(DispatcherService.name);

  constructor(
    @Inject(DISPATCH_POOL) private readonly pool: Pool,
    private readonly providerStateStore: ProviderStateStore,
    private readonly executor: ProviderSubmissionExecutor,
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
      this.logger.error('Failed to claim messages from queue', error);
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
      }>(`SELECT claim_token, dispatch_epoch FROM message_dispatch_queue WHERE message_id = $1`, [
        claim.messageId,
      ]);
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
        await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
          claim.messageId,
        ]);
        await client.query('COMMIT');
        return { messageId: claim.messageId, outcome: 'failed', error: reason };
      }

      // Read active provider assignments ordered by priority, excluding already-attempted providers (P3-D03, P3-D14, P3-D15)
      const assignmentsResult = await client.query<{
        id: string;
        provider_id: string;
        priority: number;
      }>(
        `SELECT opa.id, opa.provider_id, opa.priority
         FROM organization_provider_assignments opa
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
          await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
            claim.messageId,
          ]);
          await client.query('COMMIT');
          return { messageId: claim.messageId, outcome: 'failed', error: 'NO_ELIGIBLE_PROVIDER' };
        }
      }

      // Candidate iteration: try candidates in priority order, skipping circuit-refused providers (P3-D13, P3-D14)
      const dbTx = drizzle(client, { schema });
      let selectedProviderId: string | null = null;
      let admission: Awaited<ReturnType<typeof this.providerStateStore.admit>> | null = null;

      for (const candidate of candidates) {
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
          this.logger.warn({
            msg: 'Provider circuit refused admission; trying next candidate',
            providerId: candidate.provider_id,
            state: candidateAdmission.state,
          });
        } catch (admitErr) {
          this.logger.error({
            msg: 'Error checking circuit admission for provider',
            providerId: candidate.provider_id,
            error: String(admitErr),
          });
        }
      }

      if (!selectedProviderId || !admission) {
        // Every candidate skipped because circuit admission refused (P3-D14)
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
              details: 'All assigned provider circuits refused admission',
            }),
          ],
        );
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
      const settled = await this.executor.execute(
        admission.admission,
        {
          submissionId: claim.messageId,
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
      // Step 3: Settlement Transaction
      // -----------------------------------------------------------------------
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
        `SELECT dispatch_epoch, claim_token
         FROM message_dispatch_queue
         WHERE message_id = $1`,
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

      // Record observation and sample in providerStateStore
      const settlementTx = drizzle(client, { schema });
      await this.providerStateStore.recordSubmission(
        settlementTx as never,
        DISPATCH_PRINCIPAL,
        settled,
        { attemptId },
      );

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
          `UPDATE message_attempts
           SET status = 'accepted',
               failure_reason = NULL,
               latency_ms = $1,
               completed_at = now()
           WHERE id = $2`,
          [settled.result.latencyMs, attemptId],
        );

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
               completed_at = now()
           WHERE id = $3`,
          [unknownReason, settled.result.latencyMs, attemptId],
        );

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

        // Delete from queue (terminal, non-retryable, zero fallback per ADR-014 D16)
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
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('Failed to process dispatch claim', error);
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
   * Recovers expired leases (P3-D11 / ADR-014 D18).
   * Attempts that expired during 'submitting' status cannot be safely retried
   * and must be terminalized as OUTCOME_UNKNOWN (terminal, non-retryable).
   */
  async recoverExpiredLeases(): Promise<number> {
    const client = await this.pool.connect();
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
         FOR UPDATE SKIP LOCKED`,
      );
      const expired = expiredResult.rows;

      let recovered = 0;

      for (const row of expired) {
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
          // Terminalize attempt and message as OUTCOME_UNKNOWN (P3-D11)
          const reason = 'Dispatch lease expired during external submission (outcome_unknown)';

          if (msgRows[0].current_attempt_id) {
            await client.query(
              `UPDATE message_attempts
               SET status = 'outcome_unknown',
                   failure_reason = $1,
                   completed_at = now()
               WHERE id = $2`,
              [reason, msgRows[0].current_attempt_id],
            );
          }

          await client.query(
            `UPDATE messages
             SET status = 'outcome_unknown',
                 failure_reason = $1,
                 completed_at = now(),
                 updated_at = now()
             WHERE id = $2`,
            [reason, row.message_id],
          );

          await client.query(
            `INSERT INTO message_events (id, org_id, message_id, attempt_id, event_type, payload)
             VALUES ($1, $2, $3, $4, 'message.outcome_unknown', $5)`,
            [
              uuidv7(),
              row.org_id,
              row.message_id,
              msgRows[0].current_attempt_id,
              JSON.stringify({ outcome: 'outcome_unknown', reason }),
            ],
          );

          // Delete from queue (non-retryable)
          await client.query(`DELETE FROM message_dispatch_queue WHERE message_id = $1`, [
            row.message_id,
          ]);
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

        recovered++;
      }

      await client.query('COMMIT');
      return recovered;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error('Failed to recover expired leases', error);
      throw error;
    } finally {
      client.release();
    }
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
