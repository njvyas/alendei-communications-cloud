/**
 * Migration `0029` (ADR-015 follow-up, item 2): `roles_allowed_scope_types_non_empty`
 * refuses an empty scope-type set for every writer.
 *
 * The constraint from `0004` was `array_length(allowed_scope_types, 1) >= 1`,
 * which is NULL — and so passes — for `'{}'`. An empty set also satisfies the
 * R-5 eligibility rule (role scopes ⊆ permission scopes) vacuously, so these
 * cases run as the schema owner, the most privileged writer: a CHECK binds it
 * as it binds every application principal.
 *
 * Every case runs in one transaction that is rolled back; each refusal is
 * isolated by a savepoint. Roles carrying zero permissions stay legal — the
 * constraint concerns the scope-type array only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';

import { connect, loadTestEnv, type Principals } from './harness';

interface PgError {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
}

const CONSTRAINT = 'roles_allowed_scope_types_non_empty';

describe('roles_allowed_scope_types_non_empty refuses an empty scope-type set (migration 0029)', () => {
  let db: Principals;
  let c: PoolClient;
  let orgId: string;

  beforeAll(() => {
    loadTestEnv();
    db = connect();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    c = await db.adminPool.connect();
    await c.query('BEGIN');
    const { rows: reseller } = await c.query<{ id: string }>(
      `INSERT INTO resellers (name, slug) VALUES ('i2', 'rs-i2-' || substr(md5(random()::text), 1, 12)) RETURNING id`,
    );
    const { rows: org } = await c.query<{ id: string }>(
      `INSERT INTO organizations (name, slug, reseller_id)
       VALUES ('i2', 'org-i2-' || substr(md5(random()::text), 1, 12), $1) RETURNING id`,
      [reseller[0]!.id],
    );
    orgId = org[0]!.id;
  });

  afterEach(async () => {
    await c.query('ROLLBACK');
    c.release();
  });

  /** Runs one statement under a savepoint; returns the error, or null if it succeeded. */
  const attempt = async (text: string, values: unknown[] = []): Promise<PgError | null> => {
    await c.query('SAVEPOINT attempt');
    try {
      await c.query(text, values);
      await c.query('RELEASE SAVEPOINT attempt');
      return null;
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT attempt');
      return error as PgError;
    }
  };

  const refusal = (error: PgError | null) => [error?.code, error?.constraint];

  it('INSERT of a tenant role with {} is refused: 23514 roles_allowed_scope_types_non_empty', async () => {
    const error = await attempt(
      `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
       VALUES ($1, 'i2_tenant_empty', 'i2', false, '{}')`,
      [orgId],
    );
    expect(refusal(error)).toEqual(['23514', CONSTRAINT]);
  });

  it('INSERT of a platform role (org_id NULL) with {} is refused: 23514 roles_allowed_scope_types_non_empty', async () => {
    const error = await attempt(
      `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
       VALUES (NULL, 'i2_platform_empty', 'i2', false, '{}')`,
    );
    expect(refusal(error)).toEqual(['23514', CONSTRAINT]);
  });

  it('UPDATE of an existing role to {} is refused: 23514 roles_allowed_scope_types_non_empty, and the row is unchanged', async () => {
    // No grant and no permission: nothing but this CHECK stands in the way
    // (the stranded-grant and eligibility guards both pass for such a role).
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
       VALUES ($1, 'i2_narrowed', 'i2', false, '{organization,workspace}') RETURNING id`,
      [orgId],
    );
    const id = rows[0]!.id;
    const error = await attempt(`UPDATE roles SET allowed_scope_types = '{}' WHERE id = $1`, [id]);
    expect(refusal(error)).toEqual(['23514', CONSTRAINT]);
    const { rows: after } = await c.query<{ scopes: string }>(
      `SELECT allowed_scope_types::text AS scopes FROM roles WHERE id = $1`,
      [id],
    );
    expect(after).toEqual([{ scopes: '{organization,workspace}' }]);
  });

  it('a non-empty set is accepted on insert and update, for tenant and platform roles, and a role with zero permissions is legal', async () => {
    expect(
      await attempt(
        `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
         VALUES ($1, 'i2_tenant_ok', 'i2', false, '{team}')`,
        [orgId],
      ),
    ).toBeNull();
    expect(
      await attempt(
        `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
         VALUES (NULL, 'i2_platform_ok', 'i2', false, '{reseller}')`,
      ),
    ).toBeNull();
    expect(
      await attempt(
        `UPDATE roles SET allowed_scope_types = '{organization}' WHERE org_id = $1 AND key = 'i2_tenant_ok'`,
        [orgId],
      ),
    ).toBeNull();
    const { rows } = await c.query<{ key: string; scopes: string; permissions: number }>(
      `SELECT r.key, r.allowed_scope_types::text AS scopes,
              (SELECT count(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS permissions
         FROM roles r WHERE r.key IN ('i2_tenant_ok', 'i2_platform_ok') ORDER BY r.key`,
    );
    expect(rows).toEqual([
      { key: 'i2_platform_ok', scopes: '{reseller}', permissions: 0 },
      { key: 'i2_tenant_ok', scopes: '{organization}', permissions: 0 },
    ]);
  });

  it('the migration’s verification block passes on clean data and names the offending role ids otherwise', async () => {
    const migration = readFileSync(
      resolve(__dirname, '../../migrations/0029_adr015_roles_scope_types_non_empty.sql'),
      'utf8',
    );
    const block = migration.slice(migration.indexOf('DO $$'), migration.indexOf('END $$;') + 7);
    expect(block).toMatch(/^DO \$\$[\s\S]*roles_allowed_scope_types_non_empty[\s\S]*END \$\$;$/);
    expect(await attempt(block)).toBeNull();

    // The bad row can exist only without the constraint: drop it inside this
    // transaction (rolled back), plant the row, and run the block again.
    await c.query(`ALTER TABLE roles DROP CONSTRAINT ${CONSTRAINT}`);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
       VALUES ($1, 'i2_planted_empty', 'i2', false, '{}') RETURNING id`,
      [orgId],
    );
    const error = await attempt(block);
    expect(error?.code).toBe('23514');
    expect(error?.message).toBe(
      `migration 0029 verification failed [${CONSTRAINT}]: 1 roles with an empty allowed_scope_types (ids: ${rows[0]!.id})`,
    );
  });
});
