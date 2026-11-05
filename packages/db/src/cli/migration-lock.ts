/**
 * Session-level migration lock (U14.1a).
 *
 * `db:migrate` and the concurrent-index runner hold `MIGRATION_LOCK_KEY` on ONE
 * pinned connection for their whole run: history verification, every drizzle
 * transaction, `CREATE INDEX CONCURRENTLY`, catalogue verification and the final
 * invariant check. A session-level advisory lock belongs to the backend that took
 * it — another pool connection does not share it — which is why every step runs
 * on the same `ClientBase` and `assertMigrationLockHeld` checks, on that client,
 * that its own backend is the holder before each phase.
 *
 * Waiting is bounded (owner decision U-2): `pg_try_advisory_lock` is retried at a
 * fixed interval until the deadline, then the run refuses and names the holder.
 */
import type { ClientBase } from 'pg';

import { MIGRATION_LOCK_KEY } from '../constants';

export const MIGRATION_LOCK_DEFAULT_WAIT_MS = 30_000;
export const MIGRATION_LOCK_RETRY_INTERVAL_MS = 500;

/** `pg_locks` shows a bigint advisory key as (classid = high 32 bits, objid = low 32 bits, objsubid = 1). */
const CLASSID = Number(MIGRATION_LOCK_KEY >> 32n);
const OBJID = Number(MIGRATION_LOCK_KEY & 0xffffffffn);

export class MigrationLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLockError';
  }
}

export interface LockWaitOptions {
  readonly waitMs?: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Who holds the lock, for the refusal message (pid, application, state, since). */
async function describeHolder(client: ClientBase): Promise<string> {
  const { rows } = await client.query<{
    pid: number;
    application_name: string | null;
    state: string | null;
    backend_start: string | null;
  }>(
    `SELECT l.pid, a.application_name, a.state, a.backend_start::text AS backend_start
       FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.classid = $1 AND l.objid = $2 AND l.objsubid = 1`,
    [CLASSID, OBJID],
  );
  const holder = rows[0];
  if (!holder) return 'the holder could not be identified (it may just have released the lock)';
  return `held by pid ${holder.pid} (application "${holder.application_name ?? '?'}", state ${holder.state ?? '?'}, session since ${holder.backend_start ?? '?'})`;
}

/**
 * Takes the migration lock on `client`, retrying until `waitMs`; never waits
 * indefinitely. Throws `MigrationLockError` naming the holder on timeout.
 */
export async function acquireMigrationLock(
  client: ClientBase,
  options: LockWaitOptions = {},
): Promise<void> {
  const waitMs = options.waitMs ?? MIGRATION_LOCK_DEFAULT_WAIT_MS;
  // A NaN or negative wait would make the deadline unreachable or meaningless: refuse instead (U-2).
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    throw new MigrationLockError(`invalid migration lock wait: ${String(waitMs)} ms`);
  }
  const intervalMs = options.intervalMs ?? MIGRATION_LOCK_RETRY_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  for (;;) {
    const { rows } = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS ok',
      [MIGRATION_LOCK_KEY.toString()],
    );
    if (rows[0]?.ok) return;
    if (now() >= deadline) {
      throw new MigrationLockError(
        `Refusing to migrate: the migration lock is ${await describeHolder(client)}; ` +
          `waited ${waitMs} ms. Another db:migrate or index runner is in progress — wait for it, never run two at once.`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Fails closed unless THIS backend currently holds the migration lock. */
export async function assertMigrationLockHeld(client: ClientBase, phase: string): Promise<void> {
  const { rows } = await client.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
          AND classid = $1 AND objid = $2 AND objsubid = 1) AS held`,
    [CLASSID, OBJID],
  );
  if (!rows[0]?.held) {
    throw new MigrationLockError(
      `Refusing to continue (${phase}): this session does not hold the migration lock.`,
    );
  }
}

/** Releases the lock if this session holds it; returns whether it did. */
export async function releaseMigrationLock(client: ClientBase): Promise<boolean> {
  const { rows } = await client.query<{ released: boolean }>(
    'SELECT pg_advisory_unlock($1::bigint) AS released',
    [MIGRATION_LOCK_KEY.toString()],
  );
  return rows[0]?.released === true;
}

/** For tests and diagnostics: the lock's identity in `pg_locks`. */
export const MIGRATION_LOCK_IDENTITY = { classid: CLASSID, objid: OBJID, objsubid: 1 } as const;

/** `ACC_MIGRATION_LOCK_WAIT_MS` for both CLIs: unset means the default; anything but a non-negative integer is refused. */
export function lockWaitFromEnv(
  raw: string | undefined = process.env.ACC_MIGRATION_LOCK_WAIT_MS,
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new MigrationLockError(
      'ACC_MIGRATION_LOCK_WAIT_MS must be a non-negative integer number of milliseconds',
    );
  }
  return value;
}
