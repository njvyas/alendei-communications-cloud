/**
 * Verifies the physical shape the architecture depends on actually exists in a
 * migrated database: RLS on every tenant-scoped table, the documented
 * constraints and indexes, and time-sortable UUIDv7 primary keys.
 */
import { sql } from 'drizzle-orm';
import { ALL_PERMISSION_KEYS } from '@acc/contracts';

import { connect, createTenant, destroyTenant, type Principals } from './harness';

/** The Phase 1 tables listed in `ROADMAP.md` Phase 1 "DB changes" (Phase 1A and 1B). */
const PHASE_1_TABLES = [
  'organizations',
  'resellers',
  'workspaces',
  'teams',
  'users',
  'roles',
  'permissions',
  'role_permissions',
  'user_roles',
  'api_keys',
  'sessions',
  'ws_tickets',
  'idempotency_keys',
  'audit_logs',
] as const;

/**
 * Tables carrying tenant data. `permissions` is a global, system-defined
 * catalogue and `users`/`sessions` are platform-level identities, so their
 * policies are identity-shaped rather than `org_id`-shaped — all of them still
 * have RLS enabled, asserted separately below.
 */
const ORG_SCOPED_TABLES = [
  'organizations',
  'workspaces',
  'teams',
  'roles',
  'role_permissions',
  'user_roles',
  'api_keys',
  'ws_tickets',
  'idempotency_keys',
  'audit_logs',
] as const;

describe('Phase 1 schema', () => {
  let db: Principals;

  beforeAll(() => {
    db = connect();
  });

  afterAll(async () => {
    await db.close();
  });

  it('creates every Phase 1 table', async () => {
    const result = await db.admin.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const present = new Set(result.rows.map((row) => row.tablename));
    for (const table of PHASE_1_TABLES) {
      expect(present.has(table)).toBe(true);
    }
  });

  it('enables row-level security on every Phase 1 table', async () => {
    const result = await db.admin.execute<{ tablename: string; rowsecurity: boolean }>(
      sql`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'`,
    );
    const byTable = new Map(result.rows.map((row) => [row.tablename, row.rowsecurity]));
    for (const table of PHASE_1_TABLES) {
      expect(byTable.get(table)).toBe(true);
    }
  });

  it('defines at least one policy on every Phase 1 table', async () => {
    const result = await db.admin.execute<{ tablename: string; count: string }>(
      sql`SELECT tablename, count(*)::text AS count FROM pg_policies
          WHERE schemaname = 'public' GROUP BY tablename`,
    );
    const byTable = new Map(result.rows.map((row) => [row.tablename, Number(row.count)]));
    for (const table of PHASE_1_TABLES) {
      expect(byTable.get(table) ?? 0).toBeGreaterThan(0);
    }
  });

  it('scopes every org-scoped policy to the transaction-local tenant context', async () => {
    const result = await db.admin.execute<{
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(
      sql`SELECT tablename, policyname, qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND 'acc_app' = ANY(roles)`,
    );
    const orgScoped = result.rows.filter((row) =>
      (ORG_SCOPED_TABLES as readonly string[]).includes(row.tablename),
    );
    expect(orgScoped.length).toBeGreaterThan(0);
    for (const row of orgScoped) {
      // An INSERT policy has only WITH CHECK; every other command has USING.
      // Whichever is present must resolve tenancy through the session-variable
      // helpers, so no expression can be satisfied by a value in the query.
      const expression = `${row.qual ?? ''} ${row.with_check ?? ''}`.trim();
      expect(expression).not.toBe('');
      expect(expression).toMatch(
        /app_org_in_scope|app_is_platform_admin|app_current_|app_is_provisioning/,
      );
    }
  });

  it('installs the scope-integrity and role-permission triggers', async () => {
    const result = await db.admin.execute<{ tgname: string }>(
      sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`,
    );
    const names = new Set(result.rows.map((row) => row.tgname));
    expect(names.has('trg_user_roles_validate_scope')).toBe(true);
    expect(names.has('trg_role_permissions_validate')).toBe(true);
    expect(names.has('trg_audit_logs_validate_scope')).toBe(true);
    expect(names.has('trg_audit_logs_append_only')).toBe(true);
  });

  it('indexes every foreign key used for tenant filtering', async () => {
    const result = await db.admin.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(result.rows.map((row) => row.indexname));
    for (const expected of [
      'organizations_slug_key',
      'workspaces_org_id_idx',
      'teams_org_id_idx',
      'users_email_key',
      'sessions_refresh_token_hash_key',
      'api_keys_key_prefix_key',
      'ws_tickets_ticket_hash_key',
      'idempotency_keys_scope_key',
      'user_roles_scope_idx',
      // The organization-membership probe behind `GET /users` (migration
      // `0008`). `users` has no tenant column, so this index is the whole of
      // what makes "the users of this organization" a bounded query.
      'user_roles_org_user_id_idx',
      'permissions_key_key',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('generates time-sortable UUIDv7 primary keys', async () => {
    // Separate statements with a gap: UUIDv7 orders by its millisecond prefix,
    // so two values minted inside the same millisecond are not required to sort.
    const first = await db.admin.execute<{ v: string }>(sql`SELECT uuidv7() AS v`);
    await db.admin.execute(sql`SELECT pg_sleep(0.01)`);
    const second = await db.admin.execute<{ v: string }>(sql`SELECT uuidv7() AS v`);

    const a = first.rows[0]!.v;
    const b = second.rows[0]!.v;

    // Version nibble is the first character of the third group; variant is the
    // first character of the fourth (8, 9, a or b).
    expect(a[14]).toBe('7');
    expect(b[14]).toBe('7');
    expect(a[19]).toMatch(/[89ab]/);
    expect(a < b).toBe(true);
  });

  it('rejects a malformed email through the check constraint', async () => {
    // Raw pg, so the assertion sees PostgreSQL's own constraint name.
    await expect(
      db.adminPool.query(`INSERT INTO users (email) VALUES ('not-an-email')`),
    ).rejects.toMatchObject({ constraint: 'users_email_format' });
  });

  it('rejects an API key prefix that does not match the documented shape', async () => {
    const tenant = await createTenant(db.admin, 'shape');
    try {
      await expect(
        db.adminPool.query(
          `INSERT INTO api_keys (org_id, name, key_prefix, key_hash) VALUES ($1, 'bad', 'not_a_prefix', 'x')`,
          [tenant.orgId],
        ),
      ).rejects.toMatchObject({ constraint: 'api_keys_prefix_shape' });
    } finally {
      await destroyTenant(db.admin, tenant);
    }
  });

  it('refuses a team whose denormalized org_id disagrees with its workspace', async () => {
    const a = await createTenant(db.admin, 'compa');
    const b = await createTenant(db.admin, 'compb');
    try {
      // The composite foreign key makes the inconsistent row unrepresentable,
      // regardless of which code path attempts to write it.
      await expect(
        db.adminPool.query(`INSERT INTO teams (workspace_id, org_id, name) VALUES ($1, $2, 'x')`, [
          a.workspaceId,
          b.orgId,
        ]),
      ).rejects.toMatchObject({ constraint: 'teams_workspace_org_fk' });
    } finally {
      await destroyTenant(db.admin, a);
      await destroyTenant(db.admin, b);
    }
  });

  /**
   * Phase 1C.1b (migration `0012`): teams carry the workspace lifecycle, using
   * the same enum, defaulting to `active`, with the status-filter index — and no
   * RLS policy changed to get there (`teams_tenant` stays organization-scoped).
   */
  it('gives teams the workspace lifecycle without touching their policies', async () => {
    const column = await db.admin.execute<{ udt: string; nullable: string; def: string }>(sql`
      SELECT udt_name AS udt, is_nullable AS nullable, column_default AS def
      FROM information_schema.columns WHERE table_name = 'teams' AND column_name = 'status'`);
    expect(column.rows).toEqual([
      { udt: 'workspace_status', nullable: 'NO', def: "'active'::workspace_status" },
    ]);
    const index = await db.admin.execute<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'teams_org_id_status_idx'`,
    );
    expect(index.rows[0]?.indexdef).toContain('(org_id, status)');
    const policies = await db.admin.execute<{ polname: string; qual: string }>(sql`
      SELECT polname, pg_get_expr(polqual, polrelid) AS qual FROM pg_policy
      WHERE polrelid = 'teams'::regclass ORDER BY polname`);
    expect(policies.rows).toEqual([
      { polname: 'teams_auth_read', qual: 'true' },
      { polname: 'teams_tenant', qual: 'app_org_in_scope(org_id)' },
    ]);

    const tenant = await createTenant(db.admin, 'teamstatus');
    try {
      const inserted = await db.adminPool.query<{ status: string }>(
        `INSERT INTO teams (workspace_id, org_id, name) VALUES ($1, $2, 'x') RETURNING status`,
        [tenant.workspaceId, tenant.orgId],
      );
      expect(inserted.rows[0]!.status).toBe('active');
      await expect(
        db.adminPool.query(
          `INSERT INTO teams (workspace_id, org_id, name, status) VALUES ($1, $2, 'y', 'deleted')`,
          [tenant.workspaceId, tenant.orgId],
        ),
      ).rejects.toMatchObject({ code: '22P02' });
    } finally {
      await db.adminPool.query(`DELETE FROM teams WHERE org_id = $1`, [tenant.orgId]);
      await destroyTenant(db.admin, tenant);
    }
  });

  /**
   * The catalogue in the database is the one the code checks against.
   *
   * `AuthorizationService` compares against permission *keys*; a key the code
   * asserts but the catalogue lacks can never be attached to a role, so the
   * endpoint guarding it is unreachable rather than unguarded — a failure that
   * looks like a permissions bug and is actually a seeding one. Migration
   * `0008` and `seed.ts` both write `users.reactivate`, and this is what says
   * the two agree.
   */
  it('seeds every permission the code publishes', async () => {
    const result = await db.admin.execute<{ key: string }>(sql`SELECT key FROM permissions`);
    const seeded = new Set(result.rows.map((row) => row.key));
    const missing = ALL_PERMISSION_KEYS.filter((key) => !seeded.has(key));
    expect(missing).toEqual([]);
  });

  it('seeds the platform default reseller exactly once', async () => {
    const result = await db.admin.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM resellers WHERE is_platform_default`,
    );
    expect(Number(result.rows[0]!.count)).toBe(1);
  });
});
