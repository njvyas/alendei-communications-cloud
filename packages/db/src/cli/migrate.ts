/**
 * Applies every pending migration, then reconciles the non-owner database roles.
 *
 * Migrations run as the schema owner (`DATABASE_ADMIN_URL`). The migration
 * itself creates `acc_app`/`acc_auth`/`acc_relay` as NOLOGIN, passwordless
 * roles; this step grants them LOGIN and sets each password from the
 * environment, so no credential ever lives in a migration file.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

import { DB_ROLES } from '../constants';
import { loadCliEnv, requireEnv } from './_env';

const MIGRATIONS_FOLDER = resolve(__dirname, '../../migrations');

interface RoleCredential {
  readonly role: string;
  readonly password: string;
}

/** Rejects an identifier that is not one of our own fixed role names. */
function assertKnownRole(role: string): void {
  const known: readonly string[] = Object.values(DB_ROLES);
  if (!known.includes(role)) {
    throw new Error(`refusing to alter unknown role "${role}"`);
  }
}

async function reconcileRoles(pool: Pool, credentials: readonly RoleCredential[]): Promise<void> {
  for (const { role, password } of credentials) {
    assertKnownRole(role);
    // `ALTER ROLE` takes no bind parameters, so the password is escaped by
    // PostgreSQL itself via quote_literal rather than by string handling here.
    // The role name is safe by construction: it came from the allowlist above.
    const { rows } = await pool.query<{ literal: string }>(
      'SELECT quote_literal($1::text) AS literal',
      [password],
    );
    const literal = rows[0]?.literal;
    if (!literal) {
      throw new Error(`failed to quote password for role ${role}`);
    }
    await pool.query(`ALTER ROLE ${role} LOGIN PASSWORD ${literal}`);
  }
}

async function main(): Promise<void> {
  loadCliEnv();

  const adminUrl = requireEnv('DATABASE_ADMIN_URL');
  const appPassword = requireEnv('DATABASE_APP_PASSWORD');
  const authPassword = requireEnv('DATABASE_AUTH_PASSWORD');
  const relayPassword = requireEnv('DATABASE_RELAY_PASSWORD');

  const pool = new Pool({ connectionString: adminUrl, max: 1, application_name: 'acc-migrate' });
  try {
    console.log(`Applying migrations from ${MIGRATIONS_FOLDER}`);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    console.log('Migrations applied.');

    await reconcileRoles(pool, [
      { role: DB_ROLES.APP, password: appPassword },
      { role: DB_ROLES.AUTH, password: authPassword },
      { role: DB_ROLES.RELAY, password: relayPassword },
    ]);
    console.log(`Roles reconciled: ${Object.values(DB_ROLES).join(', ')}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
