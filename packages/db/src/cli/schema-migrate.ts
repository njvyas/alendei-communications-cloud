/**
 * Schema-only migration: verify the applied history, then apply what is pending.
 * Nothing here touches PostgreSQL roles or passwords — that is
 * `role-reconcile.ts`, run separately and deliberately.
 *
 * U14.1a (barrier-aware, one entry point for every environment):
 *   1. one connection is pinned for the whole run and takes the session-level
 *      migration lock (bounded wait, owner decision U-2);
 *   2. the history is verified against the committed journal and files, and every
 *      barrier whose migration is ALREADY recorded is verified against the live
 *      catalogue before anything is applied (owner decision U-3: the journal is
 *      never proof; a drifted index stops the run here, nothing further applied);
 *   3. if a barrier migration is pending, every pending migration BEFORE it is
 *      applied first (drizzle's own `readMigrationFiles` + `dialect.migrate`, one
 *      transaction, on the pinned connection), the history is re-verified, and the
 *      barrier's out-of-transaction step runs (for 0042: CREATE INDEX CONCURRENTLY
 *      + exact catalogue verification);
 *   4. the remaining migrations are applied — the barrier migration itself is a
 *      guard that re-checks the catalogue inside its transaction, so its history
 *      row exists only if the guard passed;
 *   5. finally, every recorded barrier (including one recorded by this run) is
 *      verified again — defence in depth.
 * The lock is released explicitly on success and error; if the process or the
 * connection dies, the server releases it when the session ends.
 *
 * drizzle 0.45.x applies all pending migrations in ONE transaction and has no
 * per-migration transaction control, which is why the barrier splits the run.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import type { ClientBase, Pool, PoolClient } from 'pg';

import {
  ensureMessagesOrgIdIdDescIndex,
  verifyIndexExact,
  type EnsureResult,
} from '../maintenance/messages-org-id-id-desc';
import {
  acquireMigrationLock,
  assertMigrationLockHeld,
  releaseMigrationLock,
  type LockWaitOptions,
} from './migration-lock';
import {
  MigrationHistoryError,
  loadExpectedMigrations,
  verifyMigrationHistory,
  type AppliedMigration,
  type ExpectedMigration,
} from './migration-history';

/** A schema maintenance step that must run outside any transaction, before a given migration. */
export interface Barrier {
  /** The journal tag of the migration that may only be applied after `prepare` succeeded. */
  readonly beforeTag: string;
  readonly label: string;
  prepare(client: ClientBase, log: (line: string) => void): Promise<EnsureResult>;
  /** Run on every migration run once `beforeTag` is in the history; throws on drift. */
  verifyApplied(client: ClientBase): Promise<void>;
}

export const MESSAGES_INDEX_BARRIER: Barrier = {
  beforeTag: '0042_messages_org_id_id_desc_guard',
  label: 'messages_org_id_id_desc_idx',
  prepare: (client, log) => ensureMessagesOrgIdIdDescIndex(client, { log }),
  verifyApplied: (client) =>
    verifyIndexExact(
      client,
      'Refusing: migration 0042_messages_org_id_id_desc_guard is recorded, but the index is not as required',
    ),
};

export const BARRIERS: readonly Barrier[] = [MESSAGES_INDEX_BARRIER];

/** Applies the given migrations (drizzle semantics) on the pinned connection. */
export type ApplyMigrations = (
  client: PoolClient,
  migrations: MigrationMeta[],
  folder: string,
) => Promise<void>;

const drizzleApply: ApplyMigrations = async (client, migrations, folder) => {
  const db = drizzle(client) as unknown as {
    dialect: {
      migrate(m: MigrationMeta[], s: unknown, c: { migrationsFolder: string }): Promise<void>;
    };
    session: unknown;
  };
  // drizzle's own `migrate()` is exactly `dialect.migrate(readMigrationFiles(config), session, config)`;
  // handing it a prefix applies only that prefix. Given a client (not a Pool), its transaction runs on
  // that same client — the one holding the migration lock.
  await db.dialect.migrate(migrations, db.session, { migrationsFolder: folder });
};

export type Checkpoint =
  | 'locked'
  | 'verified'
  | 'recorded-barriers-verified'
  | 'before-prefix'
  | 'after-prefix'
  | 'before-barrier'
  | 'after-barrier'
  | 'before-remaining'
  | 'after-remaining'
  | 'before-invariants';

export interface MigrateOptions {
  readonly lock?: LockWaitOptions;
  readonly barriers?: readonly Barrier[];
  readonly apply?: ApplyMigrations;
  readonly log?: (line: string) => void;
  /** Test-only interruption points. */
  readonly checkpoint?: (point: Checkpoint, tag?: string) => Promise<void>;
}

/** The applied history, or none on a database drizzle has never migrated. */
export async function readAppliedMigrations(
  q: Pick<ClientBase, 'query'> | Pool,
): Promise<AppliedMigration[]> {
  const history = await q.query<{ present: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  if (!history.rows[0]?.present) return [];
  const { rows } = await q.query<{ id: number; hash: string; created_at: string | number }>(
    'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
  );
  return rows.map((r) => ({ id: Number(r.id), hash: r.hash, createdAt: Number(r.created_at) }));
}

export interface SchemaMigrationResult {
  readonly applied: number;
  readonly pending: readonly ExpectedMigration[];
  readonly barriers: ReadonlyArray<{ readonly tag: string; readonly result: EnsureResult }>;
}

async function verifiedHistory(client: ClientBase, expected: readonly ExpectedMigration[]) {
  const verdict = verifyMigrationHistory(expected, await readAppliedMigrations(client));
  if (verdict.problems.length > 0) throw new MigrationHistoryError(verdict.problems);
  return verdict;
}

/**
 * Refuses (throws) on any journal or history discrepancy, a held lock, a barrier
 * refusal or a recorded barrier that no longer holds; otherwise applies pending
 * migrations around their barriers.
 */
export async function migrateSchema(
  pool: Pool,
  migrationsFolder: string,
  options: MigrateOptions = {},
): Promise<SchemaMigrationResult> {
  const barriers = options.barriers ?? BARRIERS;
  const apply = options.apply ?? drizzleApply;
  const log = options.log ?? (() => {});
  const checkpoint = options.checkpoint ?? (async () => {});
  const expected = loadExpectedMigrations(migrationsFolder);
  const files = readMigrationFiles({ migrationsFolder });
  const fileFor = (tag: string): MigrationMeta => {
    const m = expected.find((e) => e.tag === tag);
    const f = files.find((x) => x.folderMillis === m?.when && x.hash === m?.hash);
    if (!m || !f) {
      throw new MigrationHistoryError([`journal entry ${tag} has no matching migration file`]);
    }
    return f;
  };

  const client = await pool.connect();
  let broken = false;
  // A checked-out client has no pool listener: without this, a session terminated between statements
  // would crash the process with an unhandled 'error' event instead of failing the next query.
  const onError = (): void => {
    broken = true;
  };
  client.on('error', onError);
  let locked = false;
  try {
    // If this process goes away mid-statement, the server notices within a second and aborts the
    // statement (a concurrent build then leaves an INVALID index, handled on the next run).
    await client.query('SET client_connection_check_interval = 1000');
    await acquireMigrationLock(client, options.lock);
    locked = true;
    await checkpoint('locked');

    const first = await verifiedHistory(client, expected);
    await checkpoint('verified');

    // U-3, fail closed: a barrier whose migration is already recorded must still hold BEFORE anything
    // further is applied. The journal is never proof; a drifted index stops the run here.
    for (const barrier of barriers) {
      const position = expected.findIndex((m) => m.tag === barrier.beforeTag);
      if (position >= 0 && position < first.applied) {
        await assertMigrationLockHeld(client, `recorded barrier ${barrier.label}`);
        await barrier.verifyApplied(client);
      }
    }
    await checkpoint('recorded-barriers-verified');
    let remaining = [...first.pending];
    const barrierResults: Array<{ tag: string; result: EnsureResult }> = [];

    for (const barrier of barriers) {
      const at = remaining.findIndex((m) => m.tag === barrier.beforeTag);
      if (at < 0) continue;
      const prefix = remaining.slice(0, at);
      if (prefix.length > 0) {
        await checkpoint('before-prefix', barrier.beforeTag);
        await assertMigrationLockHeld(client, `migrations before ${barrier.beforeTag}`);
        await apply(
          client,
          prefix.map((m) => fileFor(m.tag)),
          migrationsFolder,
        );
        const after = await verifiedHistory(client, expected);
        if (after.pending[0]?.tag !== barrier.beforeTag) {
          throw new MigrationHistoryError([
            `after applying the migrations before ${barrier.beforeTag}, the next pending migration is ${after.pending[0]?.tag ?? 'none'}`,
          ]);
        }
        log(
          `Applied ${prefix.length} migration(s) before ${barrier.beforeTag}: ${prefix.map((m) => m.tag).join(', ')}`,
        );
        await checkpoint('after-prefix', barrier.beforeTag);
      }
      await checkpoint('before-barrier', barrier.beforeTag);
      await assertMigrationLockHeld(client, `barrier ${barrier.label}`);
      const result = await barrier.prepare(client, log);
      barrierResults.push({ tag: barrier.beforeTag, result });
      log(`Barrier ${barrier.label} before ${barrier.beforeTag}: ${result}`);
      await checkpoint('after-barrier', barrier.beforeTag);
      remaining = remaining.slice(at);
    }

    if (remaining.length > 0) {
      await checkpoint('before-remaining');
      await assertMigrationLockHeld(client, 'remaining migrations');
      await apply(
        client,
        remaining.map((m) => fileFor(m.tag)),
        migrationsFolder,
      );
      const done = await verifiedHistory(client, expected);
      if (done.pending.length > 0) {
        throw new MigrationHistoryError([
          `still pending after applying the migrations: ${done.pending.map((m) => m.tag).join(', ')}`,
        ]);
      }
      await checkpoint('after-remaining');
    }

    // Defence in depth: every recorded barrier (including one recorded by this run) is verified again.
    await checkpoint('before-invariants');
    await assertMigrationLockHeld(client, 'final verification');
    const final = await readAppliedMigrations(client);
    for (const barrier of barriers) {
      const position = expected.findIndex((m) => m.tag === barrier.beforeTag);
      if (position >= 0 && final.length > position) await barrier.verifyApplied(client);
    }
    return { applied: first.applied, pending: first.pending, barriers: barrierResults };
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    if (locked) {
      try {
        await releaseMigrationLock(client);
      } catch {
        broken = true; // the session will be discarded; the server releases the lock with it
      }
    }
    // A failed run discards its connection rather than returning a possibly mid-state session to the pool.
    client.off('error', onError);
    client.release(broken ? true : undefined);
  }
}
