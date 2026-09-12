/**
 * Verifies the physical shape the architecture depends on actually exists in a
 * migrated database: RLS on every tenant-scoped table, the documented
 * constraints and indexes, and time-sortable UUIDv7 primary keys.
 */
import { sql } from 'drizzle-orm';

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

  it('seeds the platform default reseller exactly once', async () => {
    const result = await db.admin.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM resellers WHERE is_platform_default`,
    );
    expect(Number(result.rows[0]!.count)).toBe(1);
  });
});
