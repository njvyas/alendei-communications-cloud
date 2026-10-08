/**
 * The tenant-context trust model, measured rather than asserted (Gate-B final
 * verification, `SECURITY.md` §4b).
 *
 * Tenant context reaches PostgreSQL as custom session variables, and PostgreSQL
 * lets any principal set a custom variable. This suite records exactly what the
 * real `acc_app` login principal can and cannot do with that, so the residual
 * risk is a stated, reproducible fact:
 *
 *   CAN   set any `app.*` variable transaction-locally or for its session;
 *         with `app.current_org_id` alone, read that organization's rows.
 *   CAN   claim reseller/platform scope only by *also* naming a user id that
 *         genuinely holds the grant (migration `0010`).
 *   CANNOT persist a variable as a role or database default, `SET ROLE` /
 *         `SET SESSION AUTHORIZATION` to any other principal, call a trigger
 *         function directly, attach any SECURITY DEFINER trigger function
 *         (trigger-only since migrations `0015`/`0016`) to a temporary table of
 *         its own, or reach any
 *         SECURITY DEFINER function that sets a variable, runs dynamic SQL or
 *         grants anything.
 *
 * Every assertion here describes arbitrary-SQL capability as `acc_app` — a
 * compromised application process. The application itself never issues these
 * statements: it writes all seven variables, from the authenticated principal, at
 * the start of every transaction (`withTenantTransaction`).
 */
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { createDatabase, withTenantTransaction, type Database } from '../client';
import {
  connect,
  createTenant,
  destroyTenant,
  loadTestEnv,
  plantPlatformAdmin,
  plantResellerAdmin,
  removeIdentities,
  type Principals,
  type TenantFixture,
} from './harness';

describe('tenant-context trust model — what acc_app can do with session variables', () => {
  let db: Principals;
  let pool: Pool;
  let app: Database;
  let attacker: TenantFixture;
  let victim: TenantFixture;
  let victimResellerAdmin: string;
  let platformAdmin: string;

  beforeAll(async () => {
    loadTestEnv();
    db = connect();
    pool = new Pool({
      connectionString: process.env.DATABASE_URL!,
      max: 1,
      application_name: 'acc-test-trust',
    });
    app = createDatabase(pool);
    attacker = await createTenant(db.admin, 'trust-attacker');
    victim = await createTenant(db.admin, 'trust-victim');
    victimResellerAdmin = await plantResellerAdmin(db.admin, victim.resellerId, 'trust-reseller');
    platformAdmin = await plantPlatformAdmin(db.admin, 'trust-platform');
  }, 60_000);

  afterAll(async () => {
    await removeIdentities(db.admin, [victimResellerAdmin, platformAdmin]);
    await destroyTenant(db.admin, attacker);
    await destroyTenant(db.admin, victim);
    await pool.end();
    await db.close();
  }, 60_000);

  /** Victim workspaces visible after running `setup` statements, raw SQL, no helper. */
  async function victimWorkspacesAfter(setup: string[]): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of setup) await client.query(statement);
      const { rows } = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM workspaces WHERE org_id = $1',
        [victim.orgId],
      );
      return Number(rows[0]!.n);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  const local = (name: string, value: string) => `SELECT set_config('${name}', '${value}', true)`;

  it('the principal is the real non-owner acc_app: not superuser, not BYPASSRLS', async () => {
    const { rows } = await pool.query<{ u: string; s: boolean; b: boolean }>(
      `SELECT current_user AS u, rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ u: 'acc_app', s: false, b: false });
  });

  // --- A/B: organization context --------------------------------------------
  it('A/B. acc_app CAN set app.current_org_id to a victim organization and read its rows (the residual)', async () => {
    expect(await victimWorkspacesAfter([])).toBe(0);
    expect(await victimWorkspacesAfter([local('app.current_org_id', attacker.orgId)])).toBe(0);
    expect(
      await victimWorkspacesAfter([local('app.current_org_id', victim.orgId)]),
    ).toBeGreaterThan(0);
    // Plain `SET LOCAL` works identically to `set_config(..., true)`.
    expect(
      await victimWorkspacesAfter([`SET LOCAL app.current_org_id = '${victim.orgId}'`]),
    ).toBeGreaterThan(0);
  });

  // --- C: reseller / platform / workspace / team ------------------------------
  it('C. a reseller claim is refused without a backing grant, honoured only with a real holder’s user id', async () => {
    expect(await victimWorkspacesAfter([local('app.current_reseller_id', victim.resellerId)])).toBe(
      0,
    );
    expect(
      await victimWorkspacesAfter([
        local('app.current_reseller_id', victim.resellerId),
        local('app.current_user_id', attacker.userId),
      ]),
    ).toBe(0);
    // Naming a user who genuinely holds the grant is what the claim rests on —
    // and `app.current_user_id` is itself a variable. This is the residual.
    expect(
      await victimWorkspacesAfter([
        local('app.current_reseller_id', victim.resellerId),
        local('app.current_user_id', victimResellerAdmin),
      ]),
    ).toBeGreaterThan(0);
  });

  it('C. a platform claim is refused without a backing grant, honoured only with a real administrator’s user id', async () => {
    expect(await victimWorkspacesAfter([local('app.is_platform_admin', 'on')])).toBe(0);
    expect(
      await victimWorkspacesAfter([
        local('app.is_platform_admin', 'on'),
        local('app.current_user_id', attacker.userId),
      ]),
    ).toBe(0);
    expect(
      await victimWorkspacesAfter([
        local('app.is_platform_admin', 'on'),
        local('app.current_user_id', platformAdmin),
      ]),
    ).toBeGreaterThan(0);
  });

  it('C. the workspace variable is inert: no policy reads it, so it neither widens nor narrows', async () => {
    const base = await victimWorkspacesAfter([local('app.current_org_id', victim.orgId)]);
    const narrowed = await victimWorkspacesAfter([
      local('app.current_org_id', victim.orgId),
      local('app.current_workspace_id', attacker.workspaceId),
    ]);
    expect(narrowed).toBe(base);
    expect(
      await victimWorkspacesAfter([local('app.current_workspace_id', victim.workspaceId)]),
    ).toBe(0);
    const { rows } = await db.admin.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM pg_policies
      WHERE coalesce(qual, '') || coalesce(with_check, '') LIKE '%workspace_id()%'`);
    expect(rows[0]!.n).toBe('0');
  });

  it('C. there is no team variable: setting one is accepted by PostgreSQL and read by nothing', async () => {
    expect(await victimWorkspacesAfter([local('app.current_team_id', victim.teamId)])).toBe(0);
    const { rows } = await db.admin.execute<{ n: string }>(sql`
      SELECT (SELECT count(*) FROM pg_policies
               WHERE coalesce(qual, '') || coalesce(with_check, '') LIKE '%team%')
           + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.prosrc LIKE '%current_team%') AS n`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  // --- D: SECURITY DEFINER functions -----------------------------------------
  it('D. no SECURITY DEFINER function sets a variable, runs dynamic SQL, or grants/alters anything', async () => {
    const { rows } = await db.admin.execute<{ proname: string; prosrc: string }>(sql`
      SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef`);
    expect(rows.length).toBeGreaterThan(0);
    // Scanned as code: string literals (error messages mention "grant") and
    // comments are removed first, then statements are matched, not substrings.
    const FORBIDDEN = [
      /\bset_config\s*\(/,
      /\bexecute\s+(?!function)/,
      /(^|;|\s)grant\s/,
      /(^|;|\s)alter\s/,
      /\bset\s+(local\s+)?role\b/,
      /\bset\s+session\b/,
    ];
    // Positive control: the scanner does flag each construct in real code.
    const synthetic = [
      "perform set_config('app.is_platform_admin','on',true);",
      "execute format('select 1');",
      'grant select on users to public;',
      'alter role acc_app bypassrls;',
      'set role postgres;',
      'set session authorization postgres;',
    ];
    FORBIDDEN.forEach((pattern, i) => expect(pattern.test(synthetic[i]!)).toBe(true));
    for (const row of rows) {
      const code = row.prosrc
        .toLowerCase()
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/--[^\n]*/g, '');
      for (const pattern of FORBIDDEN) {
        expect(`${row.proname}:${pattern}:${pattern.test(code)}`).toBe(
          `${row.proname}:${pattern}:false`,
        );
      }
    }
  });

  it('D. every trigger function refuses a direct call', async () => {
    const { rows } = await db.admin.execute<{ proname: string }>(sql`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND p.prorettype = 'trigger'::regtype`);
    expect(rows.length).toBeGreaterThan(0);
    // Either refusal is the invariant: no EXECUTE at all (`42501`, migration
    // 0015's trigger-only functions) or the PL/pgSQL trigger-only check
    // (`0A000`). The exact message is not what is being protected.
    for (const { proname } of rows) {
      const error = await pool.query(`SELECT ${proname}()`).then(
        () => null,
        (e: { code?: string }) => e,
      );
      expect(`${proname}:${error?.code}`).toMatch(new RegExp(`^${proname}:(42501|0A000)$`));
    }
  });

  /**
   * Every SECURITY DEFINER trigger function is trigger-only — executable by the
   * owner alone: the three Phase 1C.6 functions since migration 0015 (review
   * H-1), the six older ones since migration 0016 (review H-3).
   */
  const TRIGGER_ONLY = [
    'fn_organizations_guard_reseller_id',
    'fn_protect_system_role_permissions',
    'fn_protect_system_roles',
    'fn_roles_guard_allowed_scope_types',
    'fn_user_roles_platform_admin_guard',
    'fn_users_platform_admin_guard',
    'fn_validate_audit_scope',
    'fn_validate_role_permission',
    'fn_validate_user_role_scope',
  ];

  it('D. no application principal, nor PUBLIC, holds EXECUTE on a trigger-only SECURITY DEFINER function', async () => {
    const { rows } = await db.admin.execute<{ proname: string; grantee: string; can: boolean }>(sql`
      SELECT p.proname, g.grantee, has_function_privilege(g.grantee, p.oid, 'EXECUTE') AS can
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN (VALUES ('public'), ('acc_app'), ('acc_auth'), ('acc_relay')) AS g(grantee)
      WHERE n.nspname = 'public' AND p.prosecdef AND p.prorettype = 'trigger'::regtype
        AND p.proname IN (${sql.join(
          TRIGGER_ONLY.map((f) => sql`${f}`),
          sql`, `,
        )})`);
    expect(new Set(rows.map((r) => r.proname))).toEqual(new Set(TRIGGER_ONLY));
    expect(rows.filter((r) => r.can).map((r) => `${r.proname}:${r.grantee}`)).toEqual([]);
  });

  it('D. acc_app cannot attach a trigger-only SECURITY DEFINER function to a temporary table of its own', async () => {
    // TEMP is a database privilege every principal holds; attaching the
    // function to its own table would run the body as the owner on rows the
    // caller chooses. CREATE TRIGGER needs EXECUTE, which is what 0015 revokes.
    for (const fn of TRIGGER_ONLY) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('CREATE TEMP TABLE c6_attach (id uuid) ON COMMIT DROP');
        const error = await c
          .query(
            `CREATE TRIGGER c6_attach BEFORE INSERT ON c6_attach FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
          )
          .then(
            () => null,
            (e: { code?: string }) => e,
          );
        expect(`${fn}:${error?.code}`).toBe(`${fn}:42501`);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
  });

  it('D. the trigger-only list is the complete set of SECURITY DEFINER trigger functions, and none is executable by PUBLIC', async () => {
    // A new SECURITY DEFINER trigger function fails this until it is both
    // listed above and revoked from PUBLIC in its creating migration.
    const { rows } = await db.admin.execute<{ proname: string; pub: boolean }>(sql`
      SELECT p.proname, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND p.prorettype = 'trigger'::regtype
      ORDER BY p.proname`);
    expect(rows.map((r) => r.proname)).toEqual(TRIGGER_ONLY);
    expect(rows.filter((r) => r.pub).map((r) => r.proname)).toEqual([]);
  });

  it('D. the callable helpers confer nothing: bypass check false, claims unbacked, and one read-only disclosure', async () => {
    const { rows } = await pool.query<{
      bypass: boolean;
      admin: boolean;
      reseller: string | null;
      disclosed: string | null;
    }>(
      `SELECT app_session_bypasses_rls() AS bypass,
              app_is_platform_admin() AS admin,
              app_current_reseller_id()::text AS reseller,
              app_org_reseller($1)::text AS disclosed`,
      [victim.orgId],
    );
    expect(rows[0]!.bypass).toBe(false);
    expect(rows[0]!.admin).toBe(false);
    expect(rows[0]!.reseller).toBeNull();
    // `app_org_reseller(org)` returns any organization's reseller id to a caller
    // that already knows the organization id — an identifier, not tenant data.
    // Recorded as a known, bounded disclosure (it is what lets policies ask
    // "is this org under my reseller?" without recursing).
    expect(rows[0]!.disclosed).toBe(victim.resellerId);
  });

  // --- E: role switching ---------------------------------------------------------
  it.each(['postgres', 'acc_auth', 'acc_relay'])(
    'E. acc_app cannot SET ROLE or SET SESSION AUTHORIZATION to %s',
    async (target) => {
      await expect(pool.query(`SET ROLE ${target}`)).rejects.toThrow(/permission denied/);
      await expect(pool.query(`SET SESSION AUTHORIZATION ${target}`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(pool.query(`SELECT set_config('role', '${target}', false)`)).rejects.toThrow(
        /permission denied/,
      );
    },
  );

  // --- F: surviving the transaction boundary -------------------------------------
  it('F. a session-level SET survives commit on that connection — but every sanctioned transaction overwrites it', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET app.current_org_id = '${victim.orgId}'`);
      await client.query('BEGIN');
      await client.query('COMMIT');
      const { rows } = await client.query<{ v: string }>(
        `SELECT current_setting('app.current_org_id', true) AS v`,
      );
      expect(rows[0]!.v).toBe(victim.orgId); // it persisted
      // A bare query on that poisoned connection would see the victim …
      const bare = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM workspaces WHERE org_id = $1',
        [victim.orgId],
      );
      expect(Number(bare.rows[0]!.n)).toBeGreaterThan(0);
    } finally {
      client.release();
    }
    // … but the application never issues a bare tenant query: every one goes
    // through `withTenantTransaction`, which writes all seven variables first.
    // On the same single connection, a sanctioned transaction sees only its own.
    const seen = await withTenantTransaction(app, { orgId: attacker.orgId }, async (tx) => {
      const { rows } = await tx.execute<{ org: string }>(
        sql`SELECT DISTINCT org_id::text AS org FROM workspaces`,
      );
      return rows.map((r) => r.org);
    });
    expect(seen).toEqual([attacker.orgId]);
    await pool.query('RESET app.current_org_id');
  });

  it('F. the seventh claim, app.current_api_key_id, cannot leak from a poisoned connection into a sanctioned transaction', async () => {
    // ADR-015 R-7: the API-key arm of app_content_context_valid() reads this
    // claim, so a value left on a pooled connection must never reach the next
    // principal's transaction — a session principal's included, for which the
    // claim is absent and must be written as the empty string, not skipped.
    const client = await pool.connect();
    try {
      await client.query(`SET app.current_api_key_id = '${victim.apiKeyId}'`);
    } finally {
      client.release();
    }
    const seen = await withTenantTransaction(
      app,
      { orgId: attacker.orgId, userId: attacker.userId },
      async (tx) => {
        const { rows } = await tx.execute<{ v: string | null }>(
          sql`SELECT current_setting('app.current_api_key_id', true) AS v`,
        );
        return rows[0]!.v;
      },
    );
    expect(seen).toBe('');
    const withKey = await withTenantTransaction(
      app,
      { orgId: attacker.orgId, apiKeyId: attacker.apiKeyId },
      async (tx) => {
        const { rows } = await tx.execute<{ v: string | null }>(
          sql`SELECT current_setting('app.current_api_key_id', true) AS v`,
        );
        return rows[0]!.v;
      },
    );
    expect(withKey).toBe(attacker.apiKeyId);
    await pool.query('RESET app.current_api_key_id');
  });

  it('F. a variable cannot be persisted as a role or database default', async () => {
    await expect(
      pool.query(`ALTER ROLE acc_app SET app.current_org_id = '${victim.orgId}'`),
    ).rejects.toThrow(/permission denied/);
    const { rows } = await db.admin.execute<{ d: string }>(sql`SELECT current_database() AS d`);
    await expect(
      pool.query(`ALTER DATABASE ${rows[0]!.d} SET app.current_org_id = '${victim.orgId}'`),
    ).rejects.toThrow(/must be owner/);
  });
});
