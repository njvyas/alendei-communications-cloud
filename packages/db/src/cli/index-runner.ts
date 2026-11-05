/**
 * The standalone concurrent-index runner (U14.1a, generalised for U14.1b; owner decisions U-1, U-3).
 * Entry points: `index-messages-org-id-desc.ts` (U14.1a) and `index-messages-org-created-at.ts` (U14.1b):
 *   npm run <command> --workspace @acc/db -- [--check | --recover-invalid]
 *
 * Same pinned connection + session-level migration lock as `db:migrate`, so the
 * two never overlap.
 *
 *   (no flag)          ensure: absent → CREATE INDEX CONCURRENTLY + exact verification;
 *                      exact → no-op; anything unexpected → refuse.
 *   --check            read-only: exit 0 only if the exact, valid index exists.
 *   --recover-invalid  as ensure, and an exact-definition index that is not
 *                      valid/ready/live (an interrupted concurrent build) is dropped
 *                      CONCURRENTLY — that verified target only — rebuilt and verified.
 *
 * Preflight: the applied history must be an exact prefix of the committed journal
 * that includes the migration creating public.messages (0033). The runner writes
 * no history row; `db:migrate` records the guard migration after its guard passes.
 */
import { resolve } from 'node:path';
import { Pool } from 'pg';

import {
  IndexMaintenanceError,
  classifyIndexFor,
  describeFor,
  ensureIndexFor,
  readIndexCatalogueFor,
  type ConcurrentIndexSpec,
} from '../maintenance/concurrent-index';
import { loadCliEnv, requireEnv } from './_env';
import { acquireMigrationLock, lockWaitFromEnv, releaseMigrationLock } from './migration-lock';
import {
  MigrationHistoryError,
  loadExpectedMigrations,
  verifyMigrationHistory,
} from './migration-history';
import { readAppliedMigrations } from './schema-migrate';

const MIGRATIONS_FOLDER = resolve(__dirname, '../../migrations');
const MESSAGES_MIGRATION = '0033_phase3_3_orchestrator_dispatch';

export type RunnerMode = 'ensure' | 'check' | 'recover-invalid';

export function parseRunnerArgs(argv: readonly string[], command: string): RunnerMode {
  if (argv.length === 0) return 'ensure';
  if (argv.length === 1 && argv[0] === '--check') return 'check';
  if (argv.length === 1 && argv[0] === '--recover-invalid') return 'recover-invalid';
  throw new Error(`usage: ${command} [--check | --recover-invalid]`);
}

export async function runIndexRunnerFor(
  spec: ConcurrentIndexSpec,
  pool: Pool,
  mode: RunnerMode,
  options: { lockWaitMs?: number; log?: (line: string) => void } = {},
): Promise<{ ok: boolean; summary: string }> {
  const log = options.log ?? (() => {});
  const expected = loadExpectedMigrations(MIGRATIONS_FOLDER);
  const client = await pool.connect();
  let broken = false;
  // Without a listener on the checked-out client, a terminated session is an unhandled 'error' crash.
  const onError = (): void => {
    broken = true;
  };
  client.on('error', onError);
  let locked = false;
  try {
    await client.query('SET client_connection_check_interval = 1000');
    await acquireMigrationLock(client, { waitMs: options.lockWaitMs });
    locked = true;
    const verdict = verifyMigrationHistory(expected, await readAppliedMigrations(client));
    if (verdict.problems.length > 0) throw new MigrationHistoryError(verdict.problems);
    const messagesAt = expected.findIndex((m) => m.tag === MESSAGES_MIGRATION);
    if (verdict.applied <= messagesAt) {
      throw new IndexMaintenanceError(
        `Refusing: the database has ${verdict.applied} migrations applied; public.messages is created by ${MESSAGES_MIGRATION}. Run db:migrate.`,
      );
    }
    if (mode === 'check') {
      const snapshot = await readIndexCatalogueFor(spec, client);
      const state = classifyIndexFor(spec, snapshot);
      const ok = state.kind === 'exact' && snapshot.equivalents.length === 0;
      const extra =
        snapshot.equivalents.length > 0
          ? `; equivalent index(es) under another name: ${snapshot.equivalents.join(', ')}`
          : '';
      return { ok, summary: `${describeFor(spec, state)}${extra}` };
    }
    const result = await ensureIndexFor(spec, client, {
      recoverInvalid: mode === 'recover-invalid',
      log,
    });
    return { ok: true, summary: `${spec.name}: ${result}, exact and valid` };
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    if (locked) {
      try {
        await releaseMigrationLock(client);
      } catch {
        broken = true;
      }
    }
    client.off('error', onError);
    client.release(broken ? true : undefined);
  }
}

/** The CLI body shared by the entry points. */
export async function runIndexCli(spec: ConcurrentIndexSpec, command: string): Promise<void> {
  loadCliEnv();
  const mode = parseRunnerArgs(process.argv.slice(2), command);
  const pool = new Pool({
    connectionString: requireEnv('DATABASE_ADMIN_URL'),
    max: 1,
    application_name: 'acc-index-runner',
  });
  // An idle connection terminated by the server is reported, not an unhandled crash.
  pool.on('error', (error) => console.error(`database connection error: ${error.message}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.error(
        `index runner interrupted by ${signal}; an interrupted build leaves an INVALID index (rerun with --recover-invalid).`,
      );
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
  try {
    const { ok, summary } = await runIndexRunnerFor(spec, pool, mode, {
      lockWaitMs: lockWaitFromEnv(),
      log: (line) => console.log(line),
    });
    console.log(summary);
    if (!ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
