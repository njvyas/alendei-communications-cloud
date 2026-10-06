import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';

/**
 * Which principal a guarded pool logs in as. The only legal cross-pool nesting
 * is `app` → `auth` (ADR-015 R-1): a tenant transaction may resolve identity
 * state, but identity resolution never opens a tenant transaction.
 */
export type GuardedPoolRole = 'app' | 'auth';

/**
 * A connection was requested from a pool while the same async context already
 * holds one from that pool, or an `acc_app` connection was requested while an
 * `acc_auth` one is held (ADR-015 R-1).
 *
 * Raised at the point of acquisition, before anything waits. Without it the
 * acquisition queues behind connections that only this context's own callers
 * can release, and enough concurrent callers deadlock the pool until
 * `connectionTimeoutMillis` turns every one of them into a `500`.
 */
export class NestedPoolAcquisitionError extends Error {
  constructor(
    readonly requested: GuardedPoolRole,
    readonly held: readonly GuardedPoolRole[],
  ) {
    super(
      `nested pool acquisition refused: an ${requested === 'app' ? 'acc_app' : 'acc_auth'} connection was requested while this context holds [${held
        .map((role) => (role === 'app' ? 'acc_app' : 'acc_auth'))
        .join(', ')}] (ADR-015 R-1)`,
    );
    this.name = 'NestedPoolAcquisitionError';
  }
}

/**
 * The pools whose connection the current async context holds.
 *
 * Its own storage, deliberately not the per-request context: each transaction
 * runs its callback under a *new* immutable set, so the mark ends exactly when
 * that callback's async work does and can never leak into a sequential
 * transaction of the same request.
 */
const held = new AsyncLocalStorage<ReadonlySet<Pool>>();
const roles = new WeakMap<Pool, GuardedPoolRole>();

function refusal(pool: Pool): NestedPoolAcquisitionError | null {
  const current = held.getStore();
  if (!current || current.size === 0) return null;
  const requested = roles.get(pool)!;
  const heldRoles = [...current].flatMap((p) => {
    const role = roles.get(p);
    return role ? [role] : [];
  });
  if (current.has(pool)) return new NestedPoolAcquisitionError(requested, heldRoles);
  if (requested === 'app' && heldRoles.includes('auth')) {
    return new NestedPoolAcquisitionError(requested, heldRoles);
  }
  return null;
}

/**
 * Installs the runtime nested-acquisition guard on `pool` (ADR-015 R-1).
 *
 * `connect()` is the single acquisition point: `pg-pool`'s own `query()` goes
 * through it, so a transaction-less statement is checked exactly as a
 * transaction is. A refused acquisition fails at once, in the shape `pg-pool`
 * itself uses for a pool that is ending. There is no exemption mechanism — a
 * path that needs one is a path that must be restructured.
 */
export function guardPool(pool: Pool, role: GuardedPoolRole): Pool {
  if (roles.has(pool)) throw new Error('pool guard: this pool is already guarded');
  roles.set(pool, role);
  const connect = pool.connect.bind(pool) as (callback?: unknown) => unknown;
  pool.connect = ((callback?: (error: Error | undefined) => void) => {
    const refused = refusal(pool);
    if (refused) return callback ? callback(refused) : Promise.reject(refused);
    return connect(callback);
  }) as Pool['connect'];
  return pool;
}

/** Runs `work` with `pool` marked as held by the current async context. */
export function holdingPool<T>(pool: Pool, work: () => T): T {
  const current = held.getStore();
  return held.run(new Set([...(current ?? []), pool]), work);
}
