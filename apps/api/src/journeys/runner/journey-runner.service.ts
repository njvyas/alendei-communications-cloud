import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  JOURNEY_END_REASONS,
  JOURNEY_RUNNER_ERROR_CODES,
  JOURNEY_RUNNER_LIMITS,
  type JourneyGraph,
  type JourneyNode,
  type JourneyStepOutcome,
} from '@acc/contracts';
import { schema, type Database, type Transaction } from '@acc/db';
import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';

import { AuditWriter } from '../../audit/audit-writer.service';
import { AppConfigService } from '../../config/app-config.service';
import { JOURNEY_DB } from '../../database/database.tokens';
import { evaluateNode, type ExecutionState, type NodeResult } from './journey-node-evaluator';
import {
  JOURNEY_SEND_PORT,
  UnavailableJourneySendPort,
  type JourneySendPort,
} from './journey-send.port';
import {
  JourneyFenced,
  JourneyNodeFailure,
  errorCode,
  isTransient,
  retryBackoffMs,
} from './runner-errors';

/** One claimed queue row, as `app_journey_claim` returns it. */
export interface JourneyClaim {
  readonly executionId: string;
  readonly orgId: string;
  readonly claimToken: string;
  readonly epoch: number;
  /** Claims since the last committed transition, including this one. */
  readonly attempts: number;
}

export type ClaimOutcome =
  | 'advanced' // committed transitions; released for the next claim
  | 'waiting' // armed or kept a timer; released until it is due
  | 'ended' // the execution ended (completed or failed)
  | 'inactive' // the journey is not active: released untouched
  | 'fenced' // the claim was lost or superseded: nothing written
  | 'retry'; // a failure was recorded; released with backoff

export interface ClaimResult {
  readonly executionId: string;
  readonly outcome: ClaimOutcome;
  readonly transitions: number;
  readonly errorCode?: string;
}

export interface JourneyRunnerOptions {
  readonly batchSize: number;
  readonly perOrgLimit: number;
  readonly leaseSeconds: number;
  /** `lock_timeout` of every runner transaction, so a held row is a transient failure, not a hang. */
  readonly lockTimeoutMs: number;
  readonly workerId: string;
}

type Step = {
  readonly nodeKey: string;
  readonly nodeType: string;
  readonly outcome: JourneyStepOutcome;
  readonly errorCode?: string | null;
  readonly details: Record<string, unknown>;
  /** 8C-5b: the message a completed send created. */
  readonly messageId?: string | null;
};

const RUNNER_ACTOR_LABEL = 'journey_runner';

/**
 * Phase 8C PR 8C-3: the journey runner (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §§8.2, 8.3, 9).
 *
 * Runs as `acc_journey`, whose every policy is bound to one claimed execution with a live
 * lease (migration 0064). **Disabled unless `JOURNEY_RUNNER_ENABLED`**, which configuration
 * refuses outside tests until enablement is separately authorised; disabled, no journey
 * pool exists and this service has no database (`db === null`).
 *
 * Protocol, per claim:
 * 1. `app_journey_claim` takes due rows of active journeys (SKIP LOCKED, epoch + 1, fresh
 *    token, lease, attempts + 1, per-organisation share).
 * 2. Each transition is ONE transaction: lock the queue row through the claim (the row is
 *    invisible once the lease expired or another worker took it), re-check the journey is
 *    active, run the node, then a conditional update on `state_version` plus one history row
 *    (`seq` = the new `state_version`) — all or nothing.
 * 3. Up to `maxTransitionsPerClaim` transitions, then the claim is released.
 * 4. A failure rolls back; it is recorded with backoff, and bounded (handover §9).
 *
 * 8C-5b: `send_message` goes through the injected `JourneySendPort`, whose production binding
 * (`UnavailableJourneySendPort`) never sends; `wait_for_outcome` keeps a persisted deadline
 * (`wait_deadline_at`), set only while waiting there and cleared by every path that leaves it.
 * Nothing here dispatches, calls out or reads a provider.
 */
@Injectable()
export class JourneyRunnerService {
  private readonly logger = new Logger(JourneyRunnerService.name);
  readonly options: JourneyRunnerOptions;
  private readonly sendPort: JourneySendPort;

  constructor(
    @Optional() @Inject(JOURNEY_DB) private readonly db: Database | null,
    private readonly audit: AuditWriter,
    @Optional() config?: AppConfigService,
    @Optional() @Inject('JOURNEY_RUNNER_OPTIONS') options?: Partial<JourneyRunnerOptions>,
    @Optional() @Inject(JOURNEY_SEND_PORT) sendPort?: JourneySendPort,
  ) {
    // Fail closed: without a binding, sends are unavailable.
    this.sendPort = sendPort ?? new UnavailableJourneySendPort();
    const fromConfig = config?.journeys;
    this.options = {
      batchSize: options?.batchSize ?? fromConfig?.batchSize ?? 10,
      perOrgLimit: options?.perOrgLimit ?? fromConfig?.perOrgLimit ?? 5,
      leaseSeconds: options?.leaseSeconds ?? fromConfig?.leaseSeconds ?? 30,
      lockTimeoutMs: options?.lockTimeoutMs ?? 5_000,
      workerId: options?.workerId ?? `journey-runner-${randomUUID().slice(0, 8)}`,
    };
  }

  /** True when a journey database exists (the runner was enabled at boot). */
  get available(): boolean {
    return this.db !== null;
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('journey runner is disabled (no acc_journey connection)');
    return this.db;
  }

  /** One cycle: claim a batch and process each claim in turn. */
  async tick(): Promise<ClaimResult[]> {
    const claims = await this.claim(this.options.batchSize);
    const results: ClaimResult[] = [];
    for (const claim of claims) results.push(await this.processClaim(claim));
    return results;
  }

  async claim(limit = this.options.batchSize): Promise<JourneyClaim[]> {
    const db = this.requireDb();
    const { rows } = await db.execute<{
      execution_id: string;
      org_id: string;
      claim_token: string;
      epoch: number;
      attempts: number;
    }>(
      sql`SELECT * FROM app_journey_claim(${this.options.workerId}, ${limit}::int, ${this.options.leaseSeconds}::int, ${this.options.perOrgLimit}::int)`,
    );
    return rows.map((r) => ({
      executionId: r.execution_id,
      orgId: r.org_id,
      claimToken: r.claim_token,
      epoch: Number(r.epoch),
      attempts: Number(r.attempts),
    }));
  }

  /** Processes one claim: transitions until it waits, ends, is fenced or reaches the per-claim bound. */
  async processClaim(claim: JourneyClaim): Promise<ClaimResult> {
    const correlationId = randomUUID();
    if (claim.attempts > JOURNEY_RUNNER_LIMITS.poisonClaims) {
      // Claimed again and again without progress (crashes, lost leases, repeated failures).
      return this.failExecution(
        claim,
        JOURNEY_RUNNER_ERROR_CODES.POISONED,
        JOURNEY_END_REASONS.POISONED,
      );
    }
    let transitions = 0;
    for (;;) {
      let step: { outcome: ClaimOutcome | 'continue'; committed: boolean };
      try {
        step = await this.transition(claim, correlationId);
      } catch (error) {
        if (error instanceof JourneyFenced)
          return { executionId: claim.executionId, outcome: 'fenced', transitions };
        return this.recordFailure(claim, error, transitions);
      }
      if (step.committed) transitions++;
      if (step.outcome !== 'continue')
        return { executionId: claim.executionId, outcome: step.outcome, transitions };
      if (transitions >= JOURNEY_RUNNER_LIMITS.maxTransitionsPerClaim) {
        await this.release(claim, { availableNow: true });
        return { executionId: claim.executionId, outcome: 'advanced', transitions };
      }
    }
  }

  // --- one transition ------------------------------------------------------------------------

  private async withClaim<T>(
    claim: JourneyClaim,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.requireDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org_id', ${claim.orgId}, true),
                                  set_config('app.journey_execution_id', ${claim.executionId}, true),
                                  set_config('app.journey_claim_token', ${claim.claimToken}, true),
                                  set_config('lock_timeout', ${`${this.options.lockTimeoutMs}ms`}, true)`);
      // The fence: this claim's token, a live lease and the epoch the claim was issued with.
      // Locked FOR UPDATE for the whole transaction, so no other worker can take it meanwhile
      // (the claim function skips locked rows). Every other acc_journey policy re-checks the
      // live claim through app_journey_claim_valid().
      const [queue] = await tx
        .select({ epoch: schema.journeyExecutionQueue.epoch })
        .from(schema.journeyExecutionQueue)
        .where(
          and(
            eq(schema.journeyExecutionQueue.executionId, claim.executionId),
            eq(schema.journeyExecutionQueue.claimToken, claim.claimToken),
            gt(schema.journeyExecutionQueue.claimedUntil, sql`now()`),
          ),
        )
        .for('update');
      if (!queue || queue.epoch !== claim.epoch)
        throw new JourneyFenced('claim lost or superseded');
      return work(tx);
    });
  }

  /**
   * One transition. Returns `continue` after a committed advance (the claim is kept), or the
   * claim's final outcome.
   */
  private async transition(
    claim: JourneyClaim,
    correlationId: string,
  ): Promise<{ outcome: ClaimOutcome | 'continue'; committed: boolean }> {
    return this.withClaim(claim, async (tx) => {
      const [execution] = await tx
        .select()
        .from(schema.journeyExecutions)
        .where(eq(schema.journeyExecutions.id, claim.executionId));
      if (!execution) throw new JourneyFenced('execution not visible');
      if (execution.status !== 'running' && execution.status !== 'waiting') {
        await this.deleteQueueRow(tx, claim);
        return { outcome: 'ended', committed: false };
      }
      const [journey] = await tx
        .select({ status: schema.journeys.status, deletedAt: schema.journeys.deletedAt })
        .from(schema.journeys)
        .where(eq(schema.journeys.id, execution.journeyId));
      // Re-checked in every transition (the claim function filters too). Not row-locked:
      // acc_journey holds no UPDATE on journeys, so a pause that commits during an in-flight
      // transition takes effect at the next one.
      if (!journey || journey.status !== 'active' || journey.deletedAt !== null) {
        // Paused (or archived meanwhile): released untouched; the claim did not count.
        await this.releaseInTx(tx, { availableAt: null, attemptsDelta: -1 });
        return { outcome: 'inactive', committed: false };
      }
      const clock = await tx.execute<{ now: Date }>(sql`SELECT now() AS now`);
      const now = new Date(clock.rows[0]!.now);
      if (execution.status === 'waiting' && execution.wakeAt && execution.wakeAt > now) {
        // Claimed before its timer (should not happen: available_at = wake_at). Keep waiting.
        await this.releaseInTx(tx, { availableAt: execution.wakeAt, attemptsDelta: -1 });
        return { outcome: 'waiting', committed: false };
      }
      const [version] = await tx
        .select({ graph: schema.journeyVersions.graph })
        .from(schema.journeyVersions)
        .where(eq(schema.journeyVersions.id, execution.journeyVersionId));
      const graph = version?.graph as JourneyGraph | undefined;
      const nodeKey = execution.currentNodeKey!;
      const node =
        graph && Object.prototype.hasOwnProperty.call(graph.nodes ?? {}, nodeKey)
          ? (graph.nodes[nodeKey] as JourneyNode)
          : undefined;
      const state: ExecutionState = {
        id: execution.id,
        orgId: execution.orgId,
        workspaceId: execution.workspaceId,
        journeyId: execution.journeyId,
        contactId: execution.contactId,
        status: execution.status,
        wakeAt: execution.wakeAt,
        waitDeadlineAt: execution.waitDeadlineAt,
      };

      let result: NodeResult;
      try {
        if (!node)
          throw new JourneyNodeFailure(JOURNEY_RUNNER_ERROR_CODES.NODE_MISSING, 'node missing');
        if (execution.transitions >= JOURNEY_RUNNER_LIMITS.maxTransitions)
          throw new JourneyNodeFailure(
            JOURNEY_RUNNER_ERROR_CODES.TRANSITION_LIMIT,
            'transition limit',
          );
        // A savepoint, so a deterministic node failure can be recorded in this same
        // transaction without any partial effect of the node.
        result = await tx.transaction(async (sp) =>
          evaluateNode(sp, node, state, now, { sendPort: this.sendPort }, nodeKey),
        );
      } catch (error) {
        if (!(error instanceof JourneyNodeFailure)) throw error;
        await this.endExecution(tx, execution, {
          status: 'failed',
          endReason: JOURNEY_END_REASONS.NODE_FAILED,
          step: {
            nodeKey,
            nodeType: node?.type ?? 'unknown',
            outcome: 'failed',
            errorCode: error.errorCode,
            details: {},
          },
        });
        await this.deleteQueueRow(tx, claim);
        return { outcome: 'ended', committed: true };
      }

      if (result.kind === 'rearm') {
        // A wait_for_outcome re-check without an outcome: only the next wake moves. No history
        // row and no transition, conditional on the state and the deadline read (handover §6).
        const rearmed = await tx
          .update(schema.journeyExecutions)
          .set({ wakeAt: result.until, updatedAt: sql`now()` })
          .where(
            and(
              eq(schema.journeyExecutions.id, execution.id),
              eq(schema.journeyExecutions.stateVersion, execution.stateVersion),
              eq(schema.journeyExecutions.status, 'waiting'),
              isNotNull(schema.journeyExecutions.waitDeadlineAt),
              eq(schema.journeyExecutions.waitDeadlineAt, execution.waitDeadlineAt!),
            ),
          )
          .returning({ id: schema.journeyExecutions.id });
        if (rearmed.length !== 1) throw new JourneyFenced('state_version changed');
        await this.releaseInTx(tx, { availableAt: result.until, attemptsDelta: 'reset' });
        return { outcome: 'waiting', committed: false };
      }
      const step: Step = {
        nodeKey,
        nodeType: node!.type,
        outcome: result.kind === 'wait' ? 'waited' : result.outcome,
        details: result.details,
        errorCode: result.kind === 'wait' ? null : (result.errorCode ?? null),
        messageId: result.kind === 'advance' ? (result.messageId ?? null) : null,
      };
      if (result.kind === 'end') {
        await this.endExecution(tx, execution, {
          status: result.status,
          endReason: result.endReason,
          step,
        });
        await this.deleteQueueRow(tx, claim);
        return { outcome: 'ended', committed: true };
      }
      if (result.kind === 'wait') {
        await this.advance(tx, execution, step, {
          status: 'waiting',
          currentNodeKey: nodeKey,
          wakeAt: result.until,
          waitDeadlineAt: result.deadline ?? null,
        });
        await this.releaseInTx(tx, { availableAt: result.until, attemptsDelta: 'reset' });
        return { outcome: 'waiting', committed: true };
      }
      await this.advance(tx, execution, step, {
        status: 'running',
        currentNodeKey: result.next,
        wakeAt: null,
        waitDeadlineAt: null,
      });
      if (result.contactUpdate) {
        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: execution.workspaceId,
            actorType: 'system',
            actorUserId: null,
            actorApiKeyId: null,
            actorLabel: RUNNER_ACTOR_LABEL,
            action: 'contact.updated',
            resourceType: 'Contact',
            resourceId: execution.contactId,
            outcome: 'success',
            before: null,
            after: null,
            metadata: {
              journeyId: execution.journeyId,
              journeyVersionId: execution.journeyVersionId,
              executionId: execution.id,
              nodeKey,
              operations: result.contactUpdate.operations,
            },
            correlationId,
            causationId: execution.id,
          },
          tx,
        );
      }
      // Progress: the claim's failure count starts again; the row stays claimed for the next
      // transition of this claim (or is released by the caller at the per-claim bound).
      await tx
        .update(schema.journeyExecutionQueue)
        .set({ attempts: 0, lastErrorCode: null })
        .where(eq(schema.journeyExecutionQueue.executionId, claim.executionId));
      return { outcome: 'continue', committed: true };
    });
  }

  /** The conditional, fenced advance: `state_version` must still be the one read. */
  private async advance(
    tx: Transaction,
    execution: typeof schema.journeyExecutions.$inferSelect,
    step: Step,
    next: {
      status: 'running' | 'waiting';
      currentNodeKey: string;
      wakeAt: Date | null;
      /** Non-null only when a wait_for_outcome arms (the CHECK of 0066 forbids it otherwise). */
      waitDeadlineAt: Date | null;
    },
  ): Promise<void> {
    const seq = execution.stateVersion + 1;
    const updated = await tx
      .update(schema.journeyExecutions)
      .set({
        status: next.status,
        currentNodeKey: next.currentNodeKey,
        wakeAt: next.wakeAt,
        waitDeadlineAt: next.waitDeadlineAt,
        stateVersion: seq,
        transitions: execution.transitions + 1,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.journeyExecutions.id, execution.id),
          eq(schema.journeyExecutions.stateVersion, execution.stateVersion),
          inArray(schema.journeyExecutions.status, ['running', 'waiting']),
        ),
      )
      .returning({ id: schema.journeyExecutions.id });
    if (updated.length !== 1) throw new JourneyFenced('state_version changed');
    await this.insertStep(tx, execution, seq, step);
  }

  private async endExecution(
    tx: Transaction,
    execution: typeof schema.journeyExecutions.$inferSelect,
    end: { status: 'completed' | 'exited' | 'failed'; endReason: string; step: Step },
  ): Promise<void> {
    const seq = execution.stateVersion + 1;
    const updated = await tx
      .update(schema.journeyExecutions)
      .set({
        status: end.status,
        endedAt: sql`now()`,
        endReason: end.endReason,
        wakeAt: null,
        // Every end clears the deadline in the same update (handover §6; 0066 CHECK).
        waitDeadlineAt: null,
        stateVersion: seq,
        transitions: Math.min(execution.transitions + 1, JOURNEY_RUNNER_LIMITS.maxTransitions),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.journeyExecutions.id, execution.id),
          eq(schema.journeyExecutions.stateVersion, execution.stateVersion),
          inArray(schema.journeyExecutions.status, ['running', 'waiting']),
        ),
      )
      .returning({ id: schema.journeyExecutions.id });
    if (updated.length !== 1) throw new JourneyFenced('state_version changed');
    await this.insertStep(tx, execution, seq, end.step);
  }

  private async insertStep(
    tx: Transaction,
    execution: typeof schema.journeyExecutions.$inferSelect,
    seq: number,
    step: Step,
  ): Promise<void> {
    await tx.insert(schema.journeyExecutionSteps).values({
      orgId: execution.orgId,
      workspaceId: execution.workspaceId,
      executionId: execution.id,
      seq,
      nodeKey: step.nodeKey,
      nodeType: step.nodeType,
      outcome: step.outcome,
      errorCode: step.errorCode ?? null,
      messageId: step.messageId ?? null,
      details: step.details,
      finishedAt: sql`clock_timestamp()`,
    });
  }

  private async deleteQueueRow(tx: Transaction, claim: JourneyClaim): Promise<void> {
    await tx
      .delete(schema.journeyExecutionQueue)
      .where(eq(schema.journeyExecutionQueue.executionId, claim.executionId));
  }

  /** Releases the claim inside the current claim transaction. */
  private async releaseInTx(
    tx: Transaction,
    opts: { availableAt: Date | null; attemptsDelta: -1 | 'reset'; lastErrorCode?: string },
  ): Promise<void> {
    const executionId = sql`app_journey_execution_id()`;
    await tx.execute(sql`
      UPDATE journey_execution_queue
         SET claim_token = NULL, claimed_until = NULL, claimed_by = NULL,
             available_at = coalesce(${opts.availableAt}::timestamptz, available_at),
             attempts = ${opts.attemptsDelta === 'reset' ? sql`0` : sql`greatest(attempts - 1, 0)`},
             last_error_code = ${opts.attemptsDelta === 'reset' ? sql`NULL` : sql`last_error_code`}
       WHERE execution_id = ${executionId}`);
  }

  private async release(claim: JourneyClaim, opts: { availableNow: boolean }): Promise<void> {
    try {
      await this.withClaim(claim, async (tx) => {
        await tx.execute(sql`
          UPDATE journey_execution_queue
             SET claim_token = NULL, claimed_until = NULL, claimed_by = NULL,
                 available_at = ${opts.availableNow ? sql`now()` : sql`available_at`}
           WHERE execution_id = app_journey_execution_id()`);
      });
    } catch (error) {
      if (!(error instanceof JourneyFenced)) throw error;
    }
  }

  // --- failures ------------------------------------------------------------------------------

  /**
   * Records a failed attempt (the transition already rolled back). A transient failure is
   * retried until `transientMaxAttempts`; any failure until `poisonClaims`; then the
   * execution ends `failed`. Otherwise the claim is released with backoff.
   */
  private async recordFailure(
    claim: JourneyClaim,
    error: unknown,
    transitions: number,
  ): Promise<ClaimResult> {
    const transient = isTransient(error);
    const code = errorCode(error) ?? JOURNEY_RUNNER_ERROR_CODES.UNEXPECTED;
    this.logger[transient ? 'warn' : 'error']({
      msg: 'journey transition failed; rolled back',
      executionId: claim.executionId,
      attempt: claim.attempts,
      transient,
      code,
      error: error instanceof Error ? error.message : String(error),
    });
    if (transient && claim.attempts >= JOURNEY_RUNNER_LIMITS.transientMaxAttempts) {
      return this.failExecution(
        claim,
        JOURNEY_RUNNER_ERROR_CODES.RETRY_EXHAUSTED,
        JOURNEY_END_REASONS.RETRY_EXHAUSTED,
        transitions,
      );
    }
    if (claim.attempts >= JOURNEY_RUNNER_LIMITS.poisonClaims) {
      return this.failExecution(
        claim,
        JOURNEY_RUNNER_ERROR_CODES.POISONED,
        JOURNEY_END_REASONS.POISONED,
        transitions,
      );
    }
    const delayMs = retryBackoffMs(claim.attempts);
    try {
      await this.withClaim(claim, async (tx) => {
        await tx.execute(sql`
          UPDATE journey_execution_queue
             SET claim_token = NULL, claimed_until = NULL, claimed_by = NULL,
                 available_at = now() + make_interval(secs => ${delayMs / 1000}::double precision),
                 last_error_code = ${code}
           WHERE execution_id = app_journey_execution_id()`);
      });
    } catch (recordError) {
      // The lease is lost or the database is unavailable: the lease lapses and the next claim
      // counts the attempt anyway (poison bound).
      if (!(recordError instanceof JourneyFenced))
        this.logger.error({
          msg: 'could not record a journey failure',
          executionId: claim.executionId,
          code: errorCode(recordError),
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      return { executionId: claim.executionId, outcome: 'fenced', transitions, errorCode: code };
    }
    return { executionId: claim.executionId, outcome: 'retry', transitions, errorCode: code };
  }

  /** Ends the execution `failed` with the runner's error code, its history row, and no queue row. */
  private async failExecution(
    claim: JourneyClaim,
    code: string,
    endReason: string,
    transitions = 0,
  ): Promise<ClaimResult> {
    try {
      await this.withClaim(claim, async (tx) => {
        const [execution] = await tx
          .select()
          .from(schema.journeyExecutions)
          .where(eq(schema.journeyExecutions.id, claim.executionId));
        if (!execution) throw new JourneyFenced('execution not visible');
        if (execution.status === 'running' || execution.status === 'waiting') {
          const [version] = await tx
            .select({ graph: schema.journeyVersions.graph })
            .from(schema.journeyVersions)
            .where(eq(schema.journeyVersions.id, execution.journeyVersionId));
          const nodes = ((version?.graph as JourneyGraph | undefined)?.nodes ?? {}) as Record<
            string,
            JourneyNode
          >;
          const nodeKey = execution.currentNodeKey!;
          await this.endExecution(tx, execution, {
            status: 'failed',
            endReason,
            step: {
              nodeKey,
              nodeType: Object.prototype.hasOwnProperty.call(nodes, nodeKey)
                ? nodes[nodeKey]!.type
                : 'unknown',
              outcome: 'failed',
              errorCode: code,
              details: { attempts: claim.attempts },
            },
          });
        }
        await this.deleteQueueRow(tx, claim);
      });
    } catch (error) {
      if (error instanceof JourneyFenced)
        return { executionId: claim.executionId, outcome: 'fenced', transitions, errorCode: code };
      throw error;
    }
    return { executionId: claim.executionId, outcome: 'ended', transitions, errorCode: code };
  }
}
