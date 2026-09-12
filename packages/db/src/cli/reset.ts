/**
 * Drops and rebuilds the local schema, then re-applies migrations and seeds.
 * Refuses to run against anything but a development or test environment.
 */
import { Pool } from 'pg';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { loadCliEnv, requireEnv } from './_env';

async function main(): Promise<void> {
  loadCliEnv();

  const appEnv = process.env.APP_ENV ?? 'development';
  if (appEnv !== 'development' && appEnv !== 'test') {
    throw new Error(`db:reset refuses to run with APP_ENV=${appEnv}`);
  }

  const pool = new Pool({
    connectionString: requireEnv('DATABASE_ADMIN_URL'),
    max: 1,
    application_name: 'acc-reset',
  });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
    console.log('Schema dropped and recreated.');
  } finally {
    await pool.end();
  }

  const cwd = resolve(__dirname, '../..');
  execFileSync('npx', ['tsx', 'src/cli/migrate.ts'], { cwd, stdio: 'inherit' });
  execFileSync('npx', ['tsx', 'src/cli/seed.ts'], { cwd, stdio: 'inherit' });
}

main().catch((error: unknown) => {
  console.error('Reset failed:', error);
  process.exitCode = 1;
});
