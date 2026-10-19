import { resolve } from 'node:path';
import type { Pool } from 'pg';

import { MigrationHistoryError, loadExpectedMigrations } from './migration-history';
import { migrateSchema } from './schema-migrate';

const REPO_MIGRATIONS = resolve(__dirname, '../../migrations');
const expected = loadExpectedMigrations(REPO_MIGRATIONS);

/** A pool double that answers the two history queries and records every statement. */
function fakePool(history: Array<{ id: number; hash: string; created_at: string }> | null) {
  const statements: string[] = [];
  const pool = {
    query: jest.fn(async (text: string) => {
      statements.push(text);
      if (text.includes('to_regclass')) return { rows: [{ present: history !== null }] };
      if (text.includes('FROM drizzle.__drizzle_migrations')) return { rows: history ?? [] };
      throw new Error(`unexpected statement: ${text}`);
    }),
  };
  return { pool: pool as unknown as Pool, statements };
}

const rowsFor = (upTo: number) =>
  expected.slice(0, upTo).map((m, i) => ({ id: i + 1, hash: m.hash, created_at: String(m.when) }));

const ROLE_SQL = /\b(ALTER|CREATE|DROP)\s+(ROLE|USER)\b|\bPASSWORD\b|\bLOGIN\b/i;

describe('migrateSchema — schema only, verified first', () => {
  it('applies everything on a database never migrated, and issues no role statement', async () => {
    const { pool, statements } = fakePool(null);
    const migrator = jest.fn(async () => undefined);
    const result = await migrateSchema(pool, REPO_MIGRATIONS, migrator);
    expect(migrator).toHaveBeenCalledTimes(1);
    expect(result.pending).toHaveLength(expected.length);
    expect(statements.filter((s) => ROLE_SQL.test(s))).toEqual([]);
  });

  it('applies only the remainder of a valid partial history', async () => {
    const { pool } = fakePool(rowsFor(25));
    const migrator = jest.fn(async () => undefined);
    const result = await migrateSchema(pool, REPO_MIGRATIONS, migrator);
    expect(migrator).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(25);
    expect(result.pending.map((m) => m.idx)).toEqual(expected.slice(25).map((m) => m.idx));
  });

  it('does not call the migrator when the schema is up to date', async () => {
    const { pool } = fakePool(rowsFor(expected.length));
    const migrator = jest.fn(async () => undefined);
    await expect(migrateSchema(pool, REPO_MIGRATIONS, migrator)).resolves.toMatchObject({
      pending: [],
    });
    expect(migrator).not.toHaveBeenCalled();
  });

  it('refuses, before the migrator runs, when a recorded hash differs from the file', async () => {
    const rows = rowsFor(expected.length).map((r, i) =>
      i === 33 ? { ...r, hash: '914e'.padEnd(64, '0') } : r,
    );
    const { pool } = fakePool(rows);
    const migrator = jest.fn(async () => undefined);
    await expect(migrateSchema(pool, REPO_MIGRATIONS, migrator)).rejects.toBeInstanceOf(
      MigrationHistoryError,
    );
    expect(migrator).not.toHaveBeenCalled();
  });

  it('refuses, before the migrator runs, on an orphaned history row', async () => {
    const rows = [...rowsFor(3), { id: 4, hash: 'f'.repeat(64), created_at: '42' }];
    const { pool } = fakePool(rows);
    const migrator = jest.fn(async () => undefined);
    await expect(migrateSchema(pool, REPO_MIGRATIONS, migrator)).rejects.toThrow(
      'matches no journal entry',
    );
    expect(migrator).not.toHaveBeenCalled();
  });
});
