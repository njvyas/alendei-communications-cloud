/**
 * Database principals, privileges and RLS coverage, asserted against the
 * catalog and then proven behaviourally (Gate-B security audit, Blocker 2).
 *
 * Catalog assertions say what is configured; the negative controls prove the
 * configuration is what holds the boundary — each one weakens exactly one thing
 * (a policy, a role attribute, table ownership), shows cross-tenant rows become
 * reachable through `acc_app`, and restores it. A suite that stayed green with
 * the control removed would prove nothing.
 *
 * FORCE ROW LEVEL SECURITY — decision. It is deliberately **not** enabled. FORCE
 * only changes anything for a table *owner* that is not a superuser; the
 * owner here is the schema/migration principal, which must stay exempt so
 * retention, test teardown and seeding can work (and a superuser owner ignores
 * FORCE anyway). What FORCE would protect against — an application principal
 * owning a table — is instead made impossible to deploy unnoticed: this suite
 * asserts no application principal owns, or is a member of the owner of, any
 * table, and the API refuses to start if its principal does
 * (`assertRlsBoundPrincipal`, exercised below).
 */
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { createDatabase, withTenantTransaction } from '../client';
import { DB_ROLES } from '../constants';
import { assertRlsBoundPrincipal, PrincipalPostureError } from '../principal-guard';
import {
  connect,
  createTenant,
  destroyTenant,
  loadTestEnv,
  type Principals,
  type TenantFixture,
} from './harness';

/** Every table in `public`. A new table fails here until it is classified. */
const TABLES = [
  'api_keys',
  'audit_logs',
  'idempotency_keys',
  'organizations',
  'permissions',
  'resellers',
  'role_permissions',
  'roles',
  'sessions',
  'teams',
  'user_roles',
  'users',
  'workspaces',
  'ws_tickets',
].sort();

/** The complete intended table-privilege map, per principal. Anything else is a defect. */
const EXPECTED_GRANTS: Record<string, Record<string, string>> = {
  acc_app: {
    api_keys: 'INSERT,SELECT,UPDATE',
    audit_logs: 'INSERT,SELECT',
    idempotency_keys: 'DELETE,INSERT,SELECT,UPDATE',
    organizations: 'INSERT,SELECT,UPDATE',
    permissions: 'SELECT',
    resellers: 'INSERT,SELECT,UPDATE',
    role_permissions: 'DELETE,INSERT,SELECT,UPDATE',
    roles: 'DELETE,INSERT,SELECT,UPDATE',
    sessions: 'INSERT,SELECT,UPDATE',
    teams: 'DELETE,INSERT,SELECT,UPDATE',
    user_roles: 'DELETE,INSERT,SELECT,UPDATE',
    users: 'INSERT,SELECT,UPDATE',
    workspaces: 'INSERT,SELECT,UPDATE',
    ws_tickets: 'INSERT,SELECT,UPDATE',
  },
  acc_auth: {
    api_keys: 'SELECT,UPDATE',
    audit_logs: 'INSERT',
    organizations: 'SELECT',
    permissions: 'SELECT',
    resellers: 'SELECT',
    role_permissions: 'SELECT',
    roles: 'SELECT',
    sessions: 'INSERT,SELECT,UPDATE',
    teams: 'SELECT',
    user_roles: 'SELECT',
    users: 'SELECT,UPDATE',
    workspaces: 'SELECT',
    ws_tickets: 'SELECT,UPDATE',
  },
  // SELECT on audit_logs is granted for the planned SIEM projection, but no RLS
  // policy targets acc_relay, so it reads zero rows today (asserted below).
  acc_relay: {
    audit_logs: 'SELECT',
  },
};

describe('database principals and RLS coverage', () => {
  let db: Principals;
  let orgA: TenantFixture;
  let orgB: TenantFixture;

  beforeAll(async () => {
    loadTestEnv();
    db = connect();
    orgA = await createTenant(db.admin, 'prin-a');
    orgB = await createTenant(db.admin, 'prin-b');
  }, 60_000);

  afterAll(async () => {
    await destroyTenant(db.admin, orgA);
    await destroyTenant(db.admin, orgB);
    await db.close();
  }, 60_000);

  const principals = Object.values(DB_ROLES);

  // ===========================================================================
  describe('catalog', () => {
    it('every table in public is classified, and every one has RLS enabled', async () => {
      const { rows } = await db.admin.execute<{ relname: string; rls: boolean }>(sql`
        SELECT c.relname, c.relrowsecurity AS rls
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`);
      expect(rows.map((r) => r.relname)).toEqual(TABLES);
      for (const row of rows) expect(`${row.relname}:${row.rls}`).toBe(`${row.relname}:true`);
    });

    it('FORCE is not relied on: no table is owned by, or by a role granted to, an application principal', async () => {
      const { rows } = await db.admin.execute<{ relname: string; owner: string }>(sql`
        SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`);
      for (const row of rows) {
        for (const principal of principals) {
          const { rows: member } = await db.admin.execute<{ m: boolean }>(
            sql`SELECT pg_has_role(${principal}, ${row.owner}, 'MEMBER') AS m`,
          );
          expect(`${row.relname}/${principal}:${member[0]!.m}`).toBe(
            `${row.relname}/${principal}:false`,
          );
        }
      }
    });

    it('each application principal is LOGIN, not superuser, not BYPASSRLS, and holds no role-management attribute', async () => {
      const { rows } = await db.admin.execute<Record<string, unknown>>(sql`
        SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
        FROM pg_roles WHERE rolname IN ('acc_app', 'acc_auth', 'acc_relay') ORDER BY rolname`);
      expect(rows.map((r) => r.rolname)).toEqual(['acc_app', 'acc_auth', 'acc_relay']);
      for (const row of rows) {
        expect(row).toEqual({
          rolname: row.rolname,
          rolcanlogin: true,
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
        });
      }
    });

    it('no application principal is a member of any role, and none is granted to another', async () => {
      const { rows } = await db.admin.execute<{ member: string; role: string }>(sql`
        SELECT m.rolname AS member, r.rolname AS role
        FROM pg_auth_members am
        JOIN pg_roles m ON m.oid = am.member
        JOIN pg_roles r ON r.oid = am.roleid
        WHERE m.rolname IN ('acc_app', 'acc_auth', 'acc_relay')
           OR r.rolname IN ('acc_app', 'acc_auth', 'acc_relay')`);
      expect(rows).toEqual([]);
    });

    it('each principal holds exactly its intended table privileges and nothing else', async () => {
      const { rows } = await db.admin.execute<{
        grantee: string;
        table_name: string;
        privs: string;
      }>(sql`
        SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
        FROM information_schema.role_table_grants
        WHERE grantee IN ('acc_app', 'acc_auth', 'acc_relay') AND table_schema = 'public'
        GROUP BY grantee, table_name`);
      const actual: Record<string, Record<string, string>> = {
        acc_app: {},
        acc_auth: {},
        acc_relay: {},
      };
      for (const row of rows) actual[row.grantee]![row.table_name] = row.privs;
      expect(actual).toEqual(EXPECTED_GRANTS);
    });

    it('no principal holds a column-level privilege, TRUNCATE, or CREATE on the schema', async () => {
      const { rows: columns } = await db.admin.execute(sql`
        SELECT 1 FROM information_schema.column_privileges
        WHERE grantee IN ('acc_app', 'acc_auth', 'acc_relay') AND table_schema = 'public'
          AND (grantee, table_name, privilege_type) NOT IN (
            SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
            WHERE table_schema = 'public')`);
      expect(columns).toEqual([]);
      for (const principal of principals) {
        const { rows } = await db.admin.execute<{ c: boolean }>(
          sql`SELECT has_schema_privilege(${principal}, 'public', 'CREATE') AS c`,
        );
        expect(`${principal}:${rows[0]!.c}`).toBe(`${principal}:false`);
      }
    });

    it('acc_relay reads zero audit rows: no RLS policy targets it', async () => {
      const { rows: policies } = await db.admin.execute(
        sql`SELECT 1 FROM pg_policies WHERE 'acc_relay' = ANY(roles)`,
      );
      expect(policies).toEqual([]);
      const relay = new Pool({ connectionString: process.env.DATABASE_RELAY_URL!, max: 1 });
      try {
        const { rows } = await relay.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM audit_logs',
        );
        expect(rows[0]!.n).toBe('0');
        await expect(relay.query('SELECT 1 FROM users LIMIT 1')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await relay.end();
      }
    });

    it('no security-definer function is owned by an application principal or executable by PUBLIC', async () => {
      const { rows } = await db.admin.execute<{
        proname: string;
        owner: string;
        public_exec: boolean;
      }>(sql`
        SELECT p.proname, pg_get_userbyid(p.proowner) AS owner,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND p.prorettype <> 'trigger'::regtype`);
      for (const row of rows) {
        expect(principals).not.toContain(row.owner);
      }
      // The two lookups that disclose tenancy facts are not callable by PUBLIC.
      const byName = new Map(rows.map((r) => [r.proname, r.public_exec]));
      expect(byName.get('app_org_reseller')).toBe(false);
      expect(byName.get('app_session_bypasses_rls')).toBe(false);
    });
  });

  // ===========================================================================
  describe('no privilege path out of the application principals', () => {
    it.each(principals)(
      '%s cannot SET ROLE to the owner or to another application principal',
      async (principal) => {
        const url =
          principal === 'acc_app'
            ? process.env.DATABASE_URL!
            : principal === 'acc_auth'
              ? process.env.DATABASE_AUTH_URL!
              : process.env.DATABASE_RELAY_URL!;
        const pool = new Pool({ connectionString: url, max: 1 });
        try {
          const { rows } = await db.admin.execute<{ owner: string }>(
            sql`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'public.users'::regclass`,
          );
          const targets = [rows[0]!.owner, ...principals.filter((p) => p !== principal)];
          for (const target of targets) {
            await expect(pool.query(`SET ROLE ${target}`)).rejects.toThrow(/permission denied/);
            await expect(pool.query(`SET SESSION AUTHORIZATION ${target}`)).rejects.toThrow(
              /permission denied/,
            );
          }
        } finally {
          await pool.end();
        }
      },
    );
  });

  // ===========================================================================
  describe('start-up posture guard (assertRlsBoundPrincipal)', () => {
    it('accepts acc_app and acc_auth as configured', async () => {
      for (const url of [process.env.DATABASE_URL!, process.env.DATABASE_AUTH_URL!]) {
        const pool = new Pool({ connectionString: url, max: 1 });
        try {
          await expect(assertRlsBoundPrincipal(pool, 'test')).resolves.toMatchObject({
            superuser: false,
            bypassRls: false,
            ownedTables: [],
            memberOf: [],
          });
        } finally {
          await pool.end();
        }
      }
    });

    it('refuses the schema owner — the misconfiguration of pointing DATABASE_URL at it', async () => {
      await expect(assertRlsBoundPrincipal(db.adminPool, 'test')).rejects.toBeInstanceOf(
        PrincipalPostureError,
      );
    });

    it('refuses acc_app the moment it gains BYPASSRLS', async () => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
      await db.admin.execute(sql`ALTER ROLE acc_app BYPASSRLS`);
      try {
        await expect(assertRlsBoundPrincipal(pool, 'test')).rejects.toThrow(/BYPASSRLS/);
      } finally {
        await db.admin.execute(sql`ALTER ROLE acc_app NOBYPASSRLS`);
        await pool.end();
      }
    });

    it('refuses acc_app the moment it owns a table', async () => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
      const owner = await currentOwner('teams');
      await db.admin.execute(sql`ALTER TABLE teams OWNER TO acc_app`);
      try {
        await expect(assertRlsBoundPrincipal(pool, 'test')).rejects.toThrow(/owns .*teams/);
      } finally {
        await restoreOwnership('teams', owner);
        await pool.end();
      }
    });
  });

  /**
   * Hands `table` back to `owner` and re-applies exactly the intended grants.
   * Transferring ownership rewrites the ACL — the application principals'
   * grants do not survive a round trip through `OWNER TO acc_app` — so a
   * mutation test that only restored the owner would silently leave the
   * database broken for every later suite.
   */
  async function restoreOwnership(table: string, owner: string): Promise<void> {
    await db.admin.execute(sql.raw(`ALTER TABLE ${table} OWNER TO ${owner}`));
    for (const [principal, grants] of Object.entries(EXPECTED_GRANTS)) {
      await db.admin.execute(sql.raw(`REVOKE ALL ON ${table} FROM ${principal}`));
      const privileges = grants[table];
      if (privileges) {
        await db.admin.execute(
          sql.raw(`GRANT ${privileges.split(',').join(', ')} ON ${table} TO ${principal}`),
        );
      }
    }
  }

  async function currentOwner(table: string): Promise<string> {
    const { rows } = await db.admin.execute<{ owner: string }>(
      sql`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = ${`public.${table}`}::regclass`,
    );
    return rows[0]!.owner;
  }

  // ===========================================================================
  describe('negative controls — each weakened control really does open the boundary', () => {
    /** Organization B rows visible to Organization A's `acc_app` context, per table. */
    const leakedFrom = async (table: string, column: string): Promise<number> => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
      try {
        return await withTenantTransaction(
          createDatabase(pool),
          { orgId: orgA.orgId, userId: orgA.userId },
          async (tx) => {
            const { rows } = await tx.execute<{ n: string }>(
              sql.raw(`SELECT count(*)::text AS n FROM ${table} WHERE ${column} = '${orgB.orgId}'`),
            );
            return Number(rows[0]!.n);
          },
        );
      } finally {
        await pool.end();
      }
    };

    /**
     * Every acc_app SELECT-capable policy on a tenant-scoped table: baseline
     * sees nothing of Organization B; the policy's USING clause replaced by
     * `true` exposes Organization B; restoring it closes the boundary again.
     */
    const POLICIES: readonly { table: string; policy: string; column: string }[] = [
      { table: 'organizations', policy: 'organizations_select', column: 'id' },
      { table: 'workspaces', policy: 'workspaces_tenant', column: 'org_id' },
      { table: 'teams', policy: 'teams_tenant', column: 'org_id' },
      { table: 'api_keys', policy: 'api_keys_tenant', column: 'org_id' },
      { table: 'roles', policy: 'roles_select', column: 'org_id' },
      { table: 'user_roles', policy: 'user_roles_tenant', column: 'org_id' },
    ];

    it.each(POLICIES)('$policy is load-bearing for $table', async ({ table, policy, column }) => {
      expect(await leakedFrom(table, column)).toBe(0);
      const { rows } = await db.admin.execute<{ qual: string }>(
        sql`SELECT qual FROM pg_policies WHERE tablename = ${table} AND policyname = ${policy}`,
      );
      const original = rows[0]!.qual;
      await db.admin.execute(sql.raw(`ALTER POLICY ${policy} ON ${table} USING (true)`));
      try {
        expect(await leakedFrom(table, column)).toBeGreaterThan(0);
      } finally {
        await db.admin.execute(sql.raw(`ALTER POLICY ${policy} ON ${table} USING (${original})`));
      }
      expect(await leakedFrom(table, column)).toBe(0);
    });

    it('resellers_select is load-bearing: Organization A cannot see Organization B’s reseller', async () => {
      const visible = async (): Promise<number> => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
        try {
          return await withTenantTransaction(
            createDatabase(pool),
            { orgId: orgA.orgId, userId: orgA.userId },
            async (tx) => {
              const { rows } = await tx.execute<{ n: string }>(
                sql`SELECT count(*)::text AS n FROM resellers WHERE id = ${orgB.resellerId}`,
              );
              return Number(rows[0]!.n);
            },
          );
        } finally {
          await pool.end();
        }
      };
      expect(await visible()).toBe(0);
      const { rows } = await db.admin.execute<{ qual: string }>(
        sql`SELECT qual FROM pg_policies WHERE policyname = 'resellers_select'`,
      );
      await db.admin.execute(sql`ALTER POLICY resellers_select ON resellers USING (true)`);
      try {
        expect(await visible()).toBe(1);
      } finally {
        await db.admin.execute(
          sql.raw(`ALTER POLICY resellers_select ON resellers USING (${rows[0]!.qual})`),
        );
      }
      expect(await visible()).toBe(0);
    });

    it('role_permissions_select is load-bearing', async () => {
      await db.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.provisioning','on',true)`);
        await tx.execute(sql`
          INSERT INTO role_permissions (role_id, permission_id)
          SELECT ${orgB.roleId}, id FROM permissions WHERE key = 'workspaces.read' ON CONFLICT DO NOTHING`);
      });
      expect(await leakedFrom('role_permissions', 'org_id')).toBe(0);
      const { rows } = await db.admin.execute<{ qual: string }>(
        sql`SELECT qual FROM pg_policies WHERE policyname = 'role_permissions_select'`,
      );
      await db.admin.execute(
        sql`ALTER POLICY role_permissions_select ON role_permissions USING (true)`,
      );
      try {
        expect(await leakedFrom('role_permissions', 'org_id')).toBeGreaterThan(0);
      } finally {
        await db.admin.execute(
          sql.raw(
            `ALTER POLICY role_permissions_select ON role_permissions USING (${rows[0]!.qual})`,
          ),
        );
      }
      expect(await leakedFrom('role_permissions', 'org_id')).toBe(0);
    });

    it('BYPASSRLS on acc_app would open every table — the attribute is load-bearing', async () => {
      expect(await leakedFrom('workspaces', 'org_id')).toBe(0);
      await db.admin.execute(sql`ALTER ROLE acc_app BYPASSRLS`);
      try {
        expect(await leakedFrom('workspaces', 'org_id')).toBeGreaterThan(0);
      } finally {
        await db.admin.execute(sql`ALTER ROLE acc_app NOBYPASSRLS`);
      }
      expect(await leakedFrom('workspaces', 'org_id')).toBe(0);
    });

    it('table ownership by acc_app would exempt it from RLS — ownership is load-bearing', async () => {
      const owner = await currentOwner('teams');
      expect(await leakedFrom('teams', 'org_id')).toBe(0);
      await db.admin.execute(sql`ALTER TABLE teams OWNER TO acc_app`);
      try {
        expect(await leakedFrom('teams', 'org_id')).toBeGreaterThan(0);
      } finally {
        await restoreOwnership('teams', owner);
      }
      expect(await leakedFrom('teams', 'org_id')).toBe(0);
    });

    it('with no tenant context at all, acc_app sees no tenant row in any table', async () => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
      try {
        await withTenantTransaction(createDatabase(pool), {}, async (tx) => {
          for (const table of [
            'organizations',
            'workspaces',
            'teams',
            'api_keys',
            'ws_tickets',
            'idempotency_keys',
            'user_roles',
            'audit_logs',
            'sessions',
            'users',
          ]) {
            const { rows } = await tx.execute<{ n: string }>(
              sql.raw(`SELECT count(*)::text AS n FROM ${table}`),
            );
            expect(`${table}:${rows[0]!.n}`).toBe(`${table}:0`);
          }
        });
      } finally {
        await pool.end();
      }
    });
  });
});
