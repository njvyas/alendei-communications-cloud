/**
 * `npm run db:migrate` — schema only.
 *
 * Verifies the applied history against the committed journal and files
 * (`migration-history.ts`; any discrepancy refuses before anything is applied),
 * then applies pending migrations as the schema owner (`DATABASE_ADMIN_URL`).
 *
 * It never creates or alters roles' LOGIN or passwords: roles are
 * cluster-global, and that is the separate, explicit `npm run db:roles:reconcile`.
 * (Migrations `0000` and `0032` still create the application roles NOLOGIN when
 * they do not exist yet; that is committed migration content.)
 *
 * Serialization (U14.1a): the whole run holds a session-level advisory lock
 * (`MIGRATION_LOCK_KEY`) on one pinned connection; a second `db:migrate` or the
 * concurrent-index runner waits a bounded time and then refuses. drizzle-orm
 * 0.45.x takes no lock of its own.
 *
 * Barrier (U14.1a): before migration 0042 the index messages_org_id_id_desc_idx
 * is built CONCURRENTLY outside any transaction and verified; 0042 only checks it.
 * Once 0042 is recorded, every run re-verifies the index and exits non-zero if it
 * is missing, invalid or different (recover with `db:index:messages-org-id-desc`).
 */
import { resolve } from 'node:path';
import { Pool } from 'pg';

import { loadCliEnv, requireEnv } from './_env';
import { migrateSchema } from './schema-migrate';

const MIGRATIONS_FOLDER = resolve(__dirname, '../../migrations');

/** Bounded wait for the migration lock (ms); `ACC_MIGRATION_LOCK_WAIT_MS` overrides the default. */
function lockWaitMs(): number | undefined {
  const raw = process.env.ACC_MIGRATION_LOCK_WAIT_MS;
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      'ACC_MIGRATION_LOCK_WAIT_MS must be a non-negative integer number of milliseconds',
    );
  }
  return value;
}

async function main(): Promise<void> {
  loadCliEnv();

  const adminUrl = requireEnv('DATABASE_ADMIN_URL');
  const pool = new Pool({ connectionString: adminUrl, max: 1, application_name: 'acc-migrate' });
  // An idle connection terminated by the server is reported, not an unhandled crash.
  pool.on('error', (error) => console.error(`database connection error: ${error.message}`));
  // On SIGINT/SIGTERM the process exits; the server notices the closed session (client_connection_check_interval)
  // and aborts any running statement, and the session-level migration lock ends with the session.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.error(
        `db:migrate interrupted by ${signal}; the migration lock is released when the session closes.`,
      );
      process.exit(130);
    });
  }
  try {
    console.log(`Verifying migration history, then applying migrations from ${MIGRATIONS_FOLDER}`);
    const result = await migrateSchema(pool, MIGRATIONS_FOLDER, {
      lock: { waitMs: lockWaitMs() },
      log: (line) => console.log(line),
    });
    console.log(
      result.pending.length === 0
        ? `Schema up to date (${result.applied} migrations verified).`
        : `Applied ${result.pending.length} migration(s) after ${result.applied} verified: ${result.pending.map((m) => m.tag).join(', ')}`,
    );
    console.log(
      'Roles were not changed. Role LOGIN/passwords are set only by `npm run db:roles:reconcile`.',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
