/**
 * Schema-only migration: verify the applied history, then let drizzle apply
 * what is pending. Nothing here touches PostgreSQL roles or passwords — that
 * is `role-reconcile.ts`, run separately and deliberately.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

import {
  MigrationHistoryError,
  loadExpectedMigrations,
  verifyMigrationHistory,
  type AppliedMigration,
  type ExpectedMigration,
} from './migration-history';

export type Migrator = (pool: Pool, migrationsFolder: string) => Promise<void>;

const drizzleMigrator: Migrator = (pool, migrationsFolder) =>
  migrate(drizzle(pool), { migrationsFolder });

/** The applied history, or none on a database drizzle has never migrated. */
export async function readAppliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  const history = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  if (!history.rows[0]?.present) return [];
  const { rows } = await pool.query<{ id: number; hash: string; created_at: string | number }>(
    'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
  );
  return rows.map((r) => ({ id: Number(r.id), hash: r.hash, createdAt: Number(r.created_at) }));
}

export interface SchemaMigrationResult {
  readonly applied: number;
  readonly pending: readonly ExpectedMigration[];
}

/**
 * Refuses (throws `MigrationHistoryError`) on any journal or history
 * discrepancy, before drizzle is called; otherwise applies pending migrations.
 */
export async function migrateSchema(
  pool: Pool,
  migrationsFolder: string,
  migrator: Migrator = drizzleMigrator,
): Promise<SchemaMigrationResult> {
  const expected = loadExpectedMigrations(migrationsFolder);
  const verdict = verifyMigrationHistory(expected, await readAppliedMigrations(pool));
  if (verdict.problems.length > 0) throw new MigrationHistoryError(verdict.problems);
  if (verdict.pending.length > 0) await migrator(pool, migrationsFolder);
  return { applied: verdict.applied, pending: verdict.pending };
}
