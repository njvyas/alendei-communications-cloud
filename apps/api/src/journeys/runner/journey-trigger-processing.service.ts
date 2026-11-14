import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  JOURNEY_RUNNER_LIMITS,
  JOURNEY_SCHEDULE_ERROR_CODES,
  JOURNEY_TRIGGER_PROCESSING_LIMITS,
  nextJourneyScheduleFire,
  type JourneyTrigger,
} from '@acc/contracts';
import { schema, type Database, type Transaction } from '@acc/db';
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';

import { JOURNEY_DB } from '../../database/database.tokens';
import { JourneyNodeFailure, errorCode, isTransient, retryBackoffMs } from './runner-errors';
import { segmentPredicates } from './segment-criteria';

type Schedule = Extract<JourneyTrigger, { kind: 'schedule' }>['schedule'];

export interface EventIntakeResult {
  readonly eventId: string;
  readonly outcome: 'enrolled' | 'no_match' | 'failed';
  readonly enrolled: number;
}

/** One claimed schedule firing, as `app_journey_claim_schedule` returns it. */
export interface ScheduleClaim {
  readonly triggerId: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly journeyId: string;
  readonly journeyVersionId: string;
  readonly segmentId: string;
  readonly schedule: Schedule;
  readonly firingAt: Date;
  readonly fireCursor: string | null;
  readonly claimToken: string;
  readonly epoch: number;
  readonly attempts: number;
}

export interface FiringResult {
  readonly triggerId: string;
  /**
   * `paused`: released at the per-claim batch bound (the firing resumes). `inactive`: the
   * journey was paused or archived mid-firing; released, nothing enrolled since.
   */
  readonly result: 'completed' | 'abandoned' | 'retry' | 'paused' | 'inactive' | 'fenced';
  readonly enrolled: number;
  readonly batches: number;
  readonly nextFireAt?: string | null;
  readonly errorCode?: string;
}

export interface TriggerProcessingOptions {
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly scheduleBatch: number;
  readonly scheduleBatchesPerClaim: number;
  readonly lockTimeoutMs: number;
  /** The scheduler's clock (tests drive it across DST boundaries). */
  readonly now: () => Date;
}

/**
 * Phase 8C PR 8C-4: journey event intake and scheduled-trigger processing
 * (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §§5, 8.1, 9).
 *
 * Runs as `acc_journey` inside the runner loop, which is **disabled by default and refused
 * outside tests**; each part has its own flag (`JOURNEY_EVENT_INTAKE_ENABLED`,
 * `JOURNEY_SCHEDULER_ENABLED`), also off and refused. Disabled, there is no database here.
 *
 * - **Events.** `app_journey_process_events` takes unprocessed events (SKIP LOCKED) and enrols
 *   each contact into the active journeys listening for it — never a journey activated after
 *   the event occurred — with `entry_ref` `event:<id>`, marking the event processed in the same
 *   transaction. A replayed or concurrently processed event enrols nobody twice.
 * - **Schedules.** `app_journey_claim_schedule` claims one due trigger (SKIP LOCKED, lease,
 *   epoch) and freezes its fire instant. The segment audience is enrolled in keyset batches
 *   (`entry_ref` `schedule:<trigger>:<instant>`, so a resumed or overlapping firing never
 *   enrols a contact twice for one fire). On completion the next fire is computed strictly
 *   after the fire instant (DST-correct) and from no earlier than now — missed fires are not
 *   replayed in a burst — and the firing is audited.
 *
 * Nothing here creates a message, dispatches, or calls out.
 */
@Injectable()
export class JourneyTriggerProcessingService {
  private readonly logger = new Logger(JourneyTriggerProcessingService.name);
  readonly options: TriggerProcessingOptions;

  constructor(
    @Optional() @Inject(JOURNEY_DB) private readonly db: Database | null,
    @Optional()
    @Inject('JOURNEY_TRIGGER_PROCESSING_OPTIONS')
    options?: Partial<TriggerProcessingOptions>,
  ) {
    const L = JOURNEY_TRIGGER_PROCESSING_LIMITS;
    this.options = {
      workerId: options?.workerId ?? `journey-scheduler-${randomUUID().slice(0, 8)}`,
      leaseSeconds: options?.leaseSeconds ?? 60,
      scheduleBatch: options?.scheduleBatch ?? L.scheduleBatch,
      scheduleBatchesPerClaim: options?.scheduleBatchesPerClaim ?? L.scheduleBatchesPerClaim,
      lockTimeoutMs: options?.lockTimeoutMs ?? 5_000,
      now: options?.now ?? (() => new Date()),
    };
  }

  get available(): boolean {
    return this.db !== null;
  }

  private requireDb(): Database {
    if (!this.db)
      throw new Error('journey trigger processing is disabled (no acc_journey connection)');
    return this.db;
  }

  // --- events --------------------------------------------------------------------------------

  async processEvents(
    limit: number = JOURNEY_TRIGGER_PROCESSING_LIMITS.eventBatch,
  ): Promise<EventIntakeResult[]> {
    const { rows } = await this.requireDb().execute<{
      event_id: string;
      outcome: EventIntakeResult['outcome'];
      enrolled: number;
    }>(sql`SELECT * FROM app_journey_process_events(${limit}::int)`);
    return rows.map((r) => ({
      eventId: r.event_id,
      outcome: r.outcome,
      enrolled: Number(r.enrolled),
    }));
  }

  async purgeEvents(
    days: number = JOURNEY_TRIGGER_PROCESSING_LIMITS.eventRetentionDays,
    limit: number = JOURNEY_TRIGGER_PROCESSING_LIMITS.purgeBatch,
  ): Promise<number> {
    const { rows } = await this.requireDb().execute<{ n: number }>(
      sql`SELECT app_journey_purge_events(${days}::int, ${limit}::int) AS n`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  // --- schedules -----------------------------------------------------------------------------

  async claimSchedule(): Promise<ScheduleClaim | null> {
    const { rows } = await this.requireDb().execute<{
      trigger_id: string;
      org_id: string;
      workspace_id: string;
      journey_id: string;
      journey_version_id: string;
      segment_id: string;
      schedule: Schedule;
      firing_at: Date;
      fire_cursor: string | null;
      claim_token: string;
      epoch: number;
      attempts: number;
    }>(
      sql`SELECT * FROM app_journey_claim_schedule(${this.options.workerId}, ${this.options.leaseSeconds}::int)`,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      triggerId: r.trigger_id,
      orgId: r.org_id,
      workspaceId: r.workspace_id,
      journeyId: r.journey_id,
      journeyVersionId: r.journey_version_id,
      segmentId: r.segment_id,
      schedule: r.schedule,
      firingAt: new Date(r.firing_at),
      fireCursor: r.fire_cursor,
      claimToken: r.claim_token,
      epoch: Number(r.epoch),
      attempts: Number(r.attempts),
    };
  }

  /** Claims and fires due schedules until none is due or `max` firings ran. */
  async fireDueSchedules(
    max: number = JOURNEY_TRIGGER_PROCESSING_LIMITS.firingsPerCycle,
  ): Promise<FiringResult[]> {
    const results: FiringResult[] = [];
    for (let i = 0; i < max; i++) {
      const claim = await this.claimSchedule();
      if (!claim) break;
      results.push(await this.fire(claim));
    }
    return results;
  }

  private withTrigger<T>(claim: ScheduleClaim, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.requireDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_org_id', ${claim.orgId}, true),
                                  set_config('app.journey_trigger_id', ${claim.triggerId}, true),
                                  set_config('app.journey_trigger_claim_token', ${claim.claimToken}, true),
                                  set_config('lock_timeout', ${`${this.options.lockTimeoutMs}ms`}, true)`);
      return work(tx);
    });
  }

  /** The next fire strictly after the fire instant, and not before now (no burst catch-up). */
  nextFireAfter(claim: ScheduleClaim): Date | null {
    // A one-off schedule fires once: after its firing (completed or abandoned) it never recurs.
    if (claim.schedule.type === 'once') return null;
    const now = this.options.now();
    const from = claim.firingAt.getTime() > now.getTime() ? claim.firingAt : now;
    const next = nextJourneyScheduleFire(claim.schedule, from);
    if (next && next.getTime() <= claim.firingAt.getTime()) return null;
    return next;
  }

  /**
   * One audience batch of a claimed firing, in one transaction: reads the next keyset batch of
   * the segment and enrols it through `app_journey_enrol_scheduled`, which locks the journey,
   * then the trigger, and re-checks both (and the claim) immediately before creating any
   * execution. `'inactive'` when the journey or trigger is no longer active: nothing was
   * created and the cursor did not move.
   */
  async runBatch(
    claim: ScheduleClaim,
    cursor: string | null,
  ): Promise<{ count: number; size: number; last: string | null } | 'inactive'> {
    return this.withTrigger(claim, async (tx) => {
      const predicates = await segmentPredicates(tx, {
        id: claim.segmentId,
        orgId: claim.orgId,
        workspaceId: claim.workspaceId,
      });
      const where: SQL[] = [
        eq(schema.contacts.orgId, claim.orgId),
        eq(schema.contacts.workspaceId, claim.workspaceId),
        ...predicates,
      ];
      if (cursor) where.push(gt(schema.contacts.id, cursor));
      const rows = await tx
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(and(...where))
        .orderBy(asc(schema.contacts.id))
        .limit(this.options.scheduleBatch);
      const ids = rows.map((r) => r.id);
      const last = ids.length > 0 ? ids[ids.length - 1]! : cursor;
      const enrolledRows = await tx.execute<{ n: number }>(
        sql`SELECT app_journey_enrol_scheduled(${`{${ids.join(',')}}`}::uuid[], ${last}::uuid) AS n`,
      );
      const count = Number(enrolledRows.rows[0]?.n ?? 0);
      if (count < 0) return 'inactive' as const;
      return { count, size: ids.length, last };
    });
  }

  /** Runs one claimed firing: batches until the audience is exhausted or the per-claim bound. */
  async fire(claim: ScheduleClaim): Promise<FiringResult> {
    const correlation = randomUUID();
    let cursor = claim.fireCursor;
    let enrolled = 0;
    let batches = 0;
    if (claim.attempts > JOURNEY_RUNNER_LIMITS.poisonClaims) {
      return this.finish(
        claim,
        'abandoned',
        JOURNEY_SCHEDULE_ERROR_CODES.POISONED,
        correlation,
        0,
        0,
      );
    }
    try {
      for (;;) {
        const step = await this.runBatch(claim, cursor);
        if (step === 'inactive') {
          // Paused or archived since the claim (or the previous batch): nothing was enrolled
          // in this batch. Release the claim and keep the firing for a resume.
          await this.withTrigger(claim, (tx) =>
            tx.execute(
              sql`SELECT app_journey_finish_schedule('release', NULL, NULL, NULL, ${correlation}::uuid)`,
            ),
          );
          return { triggerId: claim.triggerId, result: 'inactive', enrolled, batches };
        }
        batches++;
        enrolled += step.count;
        cursor = step.last;
        if (step.size < this.options.scheduleBatch) {
          return this.finish(claim, 'completed', null, correlation, enrolled, batches);
        }
        if (batches >= this.options.scheduleBatchesPerClaim) {
          // Release the claim; the firing (fire instant and cursor) resumes at the next claim.
          await this.withTrigger(claim, (tx) =>
            tx.execute(
              sql`SELECT app_journey_finish_schedule('retry', NULL, NULL, now(), ${correlation}::uuid)`,
            ),
          );
          return { triggerId: claim.triggerId, result: 'paused', enrolled, batches };
        }
      }
    } catch (error) {
      if (error instanceof JourneyNodeFailure) {
        const code =
          error.errorCode === 'VALIDATION_FAILED'
            ? JOURNEY_SCHEDULE_ERROR_CODES.CRITERIA_INVALID
            : error.errorCode;
        return this.finish(claim, 'abandoned', code, correlation, enrolled, batches);
      }
      const code = errorCode(error) ?? 'RUNNER_UNEXPECTED_ERROR';
      if (code === '42501') {
        // The claim was lost (lease expired or taken over): nothing more to do here.
        return { triggerId: claim.triggerId, result: 'fenced', enrolled, batches, errorCode: code };
      }
      this.logger[isTransient(error) ? 'warn' : 'error']({
        msg: 'journey schedule firing failed; will retry',
        triggerId: claim.triggerId,
        attempt: claim.attempts,
        code,
      });
      if (claim.attempts >= JOURNEY_RUNNER_LIMITS.poisonClaims) {
        return this.finish(
          claim,
          'abandoned',
          JOURNEY_SCHEDULE_ERROR_CODES.POISONED,
          correlation,
          enrolled,
          batches,
        );
      }
      const retryAt = new Date(Date.now() + retryBackoffMs(claim.attempts));
      try {
        await this.withTrigger(claim, (tx) =>
          tx.execute(
            sql`SELECT app_journey_finish_schedule('retry', NULL, ${code}, ${retryAt}::timestamptz, ${correlation}::uuid)`,
          ),
        );
      } catch {
        return { triggerId: claim.triggerId, result: 'fenced', enrolled, batches, errorCode: code };
      }
      return { triggerId: claim.triggerId, result: 'retry', enrolled, batches, errorCode: code };
    }
  }

  private async finish(
    claim: ScheduleClaim,
    result: 'completed' | 'abandoned',
    code: string | null,
    correlation: string,
    enrolled: number,
    batches: number,
  ): Promise<FiringResult> {
    const next = this.nextFireAfter(claim);
    try {
      await this.withTrigger(claim, (tx) =>
        tx.execute(
          sql`SELECT app_journey_finish_schedule(${result}, ${next}::timestamptz, ${code}, NULL, ${correlation}::uuid)`,
        ),
      );
    } catch (error) {
      if (errorCode(error) === '42501')
        return { triggerId: claim.triggerId, result: 'fenced', enrolled, batches };
      throw error;
    }
    return {
      triggerId: claim.triggerId,
      result,
      enrolled,
      batches,
      nextFireAt: next ? next.toISOString() : null,
      ...(code ? { errorCode: code } : {}),
    };
  }
}
