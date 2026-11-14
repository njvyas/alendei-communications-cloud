import { JOURNEY_RUNNER_LIMITS } from '@acc/contracts';

/**
 * Phase 8C PR 8C-3: failure classification for the journey runner (handover §9).
 *
 * - A **transient** failure (serialisation failure, deadlock, lock or statement timeout,
 *   connection loss) rolls the transition back and is retried with backoff, at most
 *   `transientMaxAttempts` times in all.
 * - Any other **unexpected** error is retried the same way, bounded by `poisonClaims` claims
 *   without progress, after which the execution fails as poison.
 * - A **node failure** (`JourneyNodeFailure`) is deterministic — the graph or the data makes
 *   the node impossible — and ends the execution `failed` at once, in the transition itself.
 */

/** SQLSTATEs and driver codes treated as transient. */
const TRANSIENT_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '08000',
  '08003',
  '08006', // connection exceptions
  'BILLING_BUSY', // 8C-5b: the send port's reservation was busy (handover Rev 2 §7.3)
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

/** A deterministic node failure: recorded as the step's `error_code`, never retried. */
export class JourneyNodeFailure extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'JourneyNodeFailure';
  }
}

/**
 * 8C-5b: a send refusal that records nothing and is retried — transient (`BILLING_BUSY`, a
 * transient SQLSTATE) or, for an unmapped code, bounded by the poison limit. `code` is what
 * `errorCode` reports and the queue row records.
 */
export class JourneySendRetry extends Error {
  constructor(readonly code: string) {
    super(`journey send refused (${code}); retried`);
    this.name = 'JourneySendRetry';
  }
}

/** The transition lost its claim or its expected state: another worker owns it now. */
export class JourneyFenced extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'JourneyFenced';
  }
}

/** The SQLSTATE or driver code of an error (Drizzle wraps the driver error in `cause`). */
export function errorCode(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0 && code.length <= 100) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

export function isTransient(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== null && TRANSIENT_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /Connection terminated|connection timeout/i.test(message);
}

/**
 * Backoff after the `attempt`-th failed attempt (1-based): base × 2^(attempt−1), capped, with
 * ±20 % jitter so executions failing together do not retry together.
 */
export function retryBackoffMs(attempt: number, random: () => number = Math.random): number {
  const { backoffBaseMs, backoffMaxMs } = JOURNEY_RUNNER_LIMITS;
  const raw = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.8 + 0.4 * random()));
}
