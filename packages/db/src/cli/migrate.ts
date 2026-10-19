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
 * Deployment constraint: run ONE migrator per database at a time. drizzle-orm
 * 0.45.x takes no lock, so concurrent runs can both pass verification and race
 * on the same pending migration (failing, or recording a duplicate history row
 * that later runs refuse). The planned pre-upgrade migration job is a single runner.
 */
import { resolve } from 'node:path';
import { Pool } from 'pg';

import { loadCliEnv, requireEnv } from './_env';
import { migrateSchema } from './schema-migrate';

const MIGRATIONS_FOLDER = resolve(__dirname, '../../migrations');

async function main(): Promise<void> {
  loadCliEnv();

  const adminUrl = requireEnv('DATABASE_ADMIN_URL');
  const pool = new Pool({ connectionString: adminUrl, max: 1, application_name: 'acc-migrate' });
  try {
    console.log(`Verifying migration history, then applying migrations from ${MIGRATIONS_FOLDER}`);
    const result = await migrateSchema(pool, MIGRATIONS_FOLDER);
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
