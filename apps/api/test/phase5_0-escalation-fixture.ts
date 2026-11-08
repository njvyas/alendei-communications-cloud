/**
 * Phase 5.0 PR-E (implementation plan T11; design spec Rev 2 §B.7, §B.8) — the escalation-race
 * TEST FIXTURE. Not product code: there is no timer, poller, worker or escalation in Phase 5.0
 * (§G). This file holds the documented escalation statement that the future Phase 5 engine
 * will run, so the serialisation protocol between it and delivery ingestion can be proven now.
 *
 * Protocol (one transaction, §B.8 lock order: message, then current attempt):
 *
 *   SELECT id FROM messages WHERE id = $m FOR UPDATE;
 *   SELECT id FROM message_attempts WHERE id = <current attempt> FOR UPDATE;
 *   UPDATE messages m SET updated_at = clock_timestamp()
 *     FROM message_attempts a
 *    WHERE m.id = $m AND a.id = m.current_attempt_id
 *      AND m.current_attempt_id = $expected                          -- E1
 *      AND m.status = 'accepted'                                     -- E2
 *      AND a.status = 'accepted' AND a.delivery_status = 'pending'   -- E3
 *      AND m.delivery_status IS DISTINCT FROM 'delivered'            -- E4
 *   RETURNING …;   -- 0 rows = not eligible = no-op
 *
 * What the SET may write: the 0044 terminal guard refuses every non-delivery change to an
 * `accepted` message, for every writer (bypass sessions included). The fixture therefore writes
 * only `updated_at` — the one column the guard exempts besides the delivery columns, which an
 * escalation must never touch. A real Phase 5 escalation (supersede the attempt, requeue) needs
 * a Phase 5 guard change and is out of scope; the fixture proves the eligibility predicate
 * (AC-LT-5) and that it serialises with ingestion — exactly one winner, no lost delivery
 * outcome, no deadlock (AC-LT-3).
 *
 * It runs on the owner connection of the test harness: Phase 5's escalation principal is not
 * designed yet, and the subject here is row locking and the predicate, not RLS.
 */
import { sql } from 'drizzle-orm';

import type { Harness } from './auth-harness';

export interface EscalationResult {
  /** 1 when E1–E4 held and the escalation statement affected the message; 0 = no-op. */
  readonly affected: number;
  /** The current attempt's delivery status the statement saw under its locks (null if none). */
  readonly sawAttemptDelivery: string | null;
}

/**
 * Runs the escalation statement for message `messageId`, expecting `expectedAttemptId` as the
 * current attempt (E1). `holdMs` keeps the §B.8 locks that long before the UPDATE (to force an
 * ordering in tests); the UPDATE then runs and the transaction commits.
 */
export async function runEscalationFixture(
  h: Harness,
  messageId: string,
  expectedAttemptId: string,
  options: { holdMs?: number; onLocked?: () => void } = {},
): Promise<EscalationResult> {
  return h.admin.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM messages WHERE id = ${messageId} FOR UPDATE`);
    const current = await tx.execute<{ delivery_status: string | null }>(
      sql`SELECT a.delivery_status::text AS delivery_status
            FROM message_attempts a
           WHERE a.id = (SELECT current_attempt_id FROM messages WHERE id = ${messageId})
           FOR UPDATE`,
    );
    options.onLocked?.();
    if (options.holdMs) await new Promise((r) => setTimeout(r, options.holdMs));
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE messages m SET updated_at = clock_timestamp()
        FROM message_attempts a
       WHERE m.id = ${messageId} AND a.id = m.current_attempt_id
         AND m.current_attempt_id = ${expectedAttemptId}
         AND m.status = 'accepted'
         AND a.status = 'accepted' AND a.delivery_status = 'pending'
         AND m.delivery_status IS DISTINCT FROM 'delivered'
      RETURNING m.id`);
    return {
      affected: updated.rows.length,
      sawAttemptDelivery: current.rows[0]?.delivery_status ?? null,
    };
  });
}
