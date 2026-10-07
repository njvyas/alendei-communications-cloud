/**
 * ADR-015 remediation step 3 — migration `0026` (R-5 / HIGH-4, grant side of
 * R-6), proven directly against PostgreSQL.
 *
 *   A  the projection: the catalogue rows are the contracts' classification
 *      and allowed scopes; the content keys are catalogue-only
 *   B  fn_validate_role_permission: role.allowed_scope_types ⊆
 *      permission.allowed_scope_types, for every writer
 *   C  widening a role past what its permissions may be conferred at
 *   D  narrowing or reclassifying a permission a role already carries
 *   E  the permissions CHECKs (NULL, the four classes, platform ⇔ prefix,
 *      scope-set shape)
 *   F  deterministic concurrency: attach versus narrowing, attach versus
 *      widening — each order, observed through pg_blocking_pids
 *   G  the migration's verification block refuses bad data, naming it
 *
 * Every statement runs as a real principal — `acc_app` under an explicit tenant
 * context, or the schema owner — in its own transaction, rolled back unless the
 * case is about commit order. A refusal asserts the exact SQLSTATE and
 * constraint name.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_ALLOWED_SCOPES,
  PERMISSION_CLASS,
  PLATFORM_ROLE_KEYS,
  TENANT_CONTENT_PERMISSIONS,
} from '@acc/contracts';
import { Pool, type PoolClient } from 'pg';

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}
interface Ctx {
  orgId?: string;
  userId?: string;
  platform?: boolean;
  provisioning?: boolean;
}
type Outcome = { rows: number } | { code: string; constraint: string | null };

const MIGRATION = resolve(
  __dirname,
  '../../../packages/db/migrations/0026_adr015_permission_classification.sql',
);
const DELEGATE = 'platform.roles.delegate_tenant';

const ok = (rows = 1): Outcome => ({ rows });
const refused = (code: string, constraint: string | null): Outcome => ({ code, constraint });
const ELIGIBILITY = refused('42501', 'role_permissions_scope_eligibility');
const IN_USE = refused('42501', 'permissions_allowed_scope_types_in_use');
const WIDENING = refused('42501', 'roles_allowed_scope_types_permission_eligibility');

const tag = randomBytes(4).toString('hex');

describe('migration 0026: permission classification and scope eligibility (ADR-015 R-5, R-6)', () => {
  let owner: Pool;
  let app: Pool;
  const f = {} as Record<string, string>;
  const perm = {} as Record<string, string>;
  const platformRole = {} as Record<string, string>;

  async function applyCtx(c: PoolClient, ctx: Ctx): Promise<void> {
    for (const [name, value] of [
      ['app.current_org_id', ctx.orgId ?? ''],
      ['app.current_workspace_id', ''],
      ['app.current_reseller_id', ''],
      ['app.current_user_id', ctx.userId ?? ''],
      ['app.is_platform_admin', ctx.platform ? 'on' : 'off'],
      ['app.provisioning', ctx.provisioning ? 'on' : 'off'],
    ] as const) {
      await c.query('SELECT set_config($1, $2, true)', [name, value]);
    }
  }

  /** One statement as `pool` under `ctx`, in a transaction that is always rolled back. */
  async function attempt(
    pool: Pool,
    ctx: Ctx | null,
    text: string,
    params: unknown[] = [],
    isolation = 'READ COMMITTED',
  ): Promise<Outcome> {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      if (ctx) await applyCtx(c, ctx);
      const r = await c.query(text, params);
      return { rows: r.rowCount ?? 0 };
    } catch (error) {
      const e = error as PgError;
      return { code: e.code ?? '', constraint: e.constraint ?? null };
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  /** Owner statements committed, with the flags the system-role guards admit. */
  async function plant<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await applyCtx(c, { platform: true, provisioning: true });
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  const one = async (c: PoolClient, text: string, params: unknown[] = []): Promise<string> =>
    (await c.query(text, params)).rows[0].id as string;

  const attach = 'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)';
  const asOwner: Ctx = { platform: true, provisioning: true };
  const orgAdmin = (): Ctx => ({ userId: f.user!, orgId: f.org! });

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 4 });
    app = new Pool({ connectionString: process.env.DATABASE_URL!, max: 4 });

    const { rows } = await owner.query<{ key: string; id: string }>(
      'SELECT key, id FROM permissions',
    );
    for (const row of rows) perm[row.key] = row.id;
    const roles = await owner.query<{ key: string; id: string }>(
      'SELECT key, id FROM roles WHERE org_id IS NULL',
    );
    for (const row of roles.rows) platformRole[row.key] = row.id;

    await plant(async (c) => {
      const reseller = await one(
        c,
        'INSERT INTO resellers (name, slug) VALUES ($1, $1) RETURNING id',
        [`pc-${tag}`],
      );
      f.reseller = reseller;
      f.org = await one(
        c,
        'INSERT INTO organizations (name, slug, reseller_id) VALUES ($1, $1, $2) RETURNING id',
        [`pc-${tag}`, reseller],
      );
      const role = (key: string, scopes: string) =>
        one(
          c,
          `INSERT INTO roles (org_id, key, name, allowed_scope_types) VALUES ($1, $2, $2, $3) RETURNING id`,
          [f.org, `pc_${key}_${tag}`, scopes],
        );
      f.full = await role('full', '{organization,workspace,team}'); // users.read; the member's grant
      f.orgOnly = await role('orgonly', '{organization}'); // carries templates.read
      f.orgWs = await role('orgws', '{organization,workspace}'); // empty
      f.free = await role('free', '{organization}'); // empty; widened and attached in E/F
      f.orgContacts = await role('orgcontacts', '{organization}'); // carries contacts.read
      await c.query(attach, [f.full, perm['users.read']]);
      await c.query(attach, [f.orgOnly, perm['templates.read']]);
      await c.query(attach, [f.orgContacts, perm['contacts.read']]);
      f.user = await one(
        c,
        "INSERT INTO users (email, password_hash, status) VALUES ($1, 'not-a-credential', 'active') RETURNING id",
        [`pc-${tag}@example.test`],
      );
      await c.query(
        "INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'organization', $3)",
        [f.user, f.full, f.org],
      );
      // A custom platform role at {platform}, for the platform-domain cases.
      f.platformCustom = await one(
        c,
        `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
         VALUES (NULL, $1, 'Classification test', false, '{platform}') RETURNING id`,
        [`pc_platform_${tag}`],
      );
      f.resellerCustom = await one(
        c,
        `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
         VALUES (NULL, $1, 'Classification test', false, '{platform,reseller}') RETURNING id`,
        [`pc_preseller_${tag}`],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await plant(async (c) => {
      await c.query('DELETE FROM user_roles WHERE user_id = $1', [f.user]);
      await c.query('DELETE FROM users WHERE id = $1', [f.user]);
      await c.query('DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])', [
        [f.platformCustom, f.resellerCustom],
      ]);
      await c.query('DELETE FROM roles WHERE id = ANY($1::uuid[])', [
        [f.platformCustom, f.resellerCustom],
      ]);
      await c.query('DELETE FROM role_permissions WHERE org_id = $1', [f.org]);
      await c.query('DELETE FROM roles WHERE org_id = $1', [f.org]);
      await c.query('DELETE FROM organizations WHERE id = $1', [f.org]);
      await c.query('DELETE FROM resellers WHERE id = $1', [f.reseller]);
      // Restore the catalogue values any race case committed (they are the
      // contracts' values; a no-op when nothing changed).
      for (const key of TENANT_CONTENT_PERMISSIONS) {
        await c.query('UPDATE permissions SET allowed_scope_types = $2 WHERE key = $1', [
          key,
          [...PERMISSION_ALLOWED_SCOPES[key]],
        ]);
      }
    });
    await Promise.all([owner.end(), app.end()]);
  }, 60_000);

  // ===========================================================================
  describe('A. the projection', () => {
    it('every catalogue row is (key, classification, allowed scopes) exactly as packages/contracts defines it', async () => {
      const { rows } = await owner.query<{
        key: string;
        classification: string;
        scopes: string[];
      }>('SELECT key, classification, allowed_scope_types::text[] AS scopes FROM permissions');
      const actual = Object.fromEntries(
        rows.map((r) => [r.key, { classification: r.classification, scopes: r.scopes }]),
      );
      const expected = Object.fromEntries(
        ALL_PERMISSION_KEYS.map((k) => [
          k,
          { classification: PERMISSION_CLASS[k], scopes: [...PERMISSION_ALLOWED_SCOPES[k]] },
        ]),
      );
      expect(actual).toEqual(expected);
      expect(rows).toHaveLength(46);
    });

    it("the content keys are catalogue-only: rows exist, no role carries them (beyond this suite's own fixture)", async () => {
      const { rows } = await owner.query<{ key: string; holders: string }>(
        `SELECT p.key, count(rp.role_id)::text AS holders FROM permissions p
           LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.org_id IS DISTINCT FROM $1
          WHERE p.classification = 'tenant_content' GROUP BY p.key ORDER BY p.key`,
        [f.org],
      );
      expect(rows.map((r) => r.key)).toEqual([...TENANT_CONTENT_PERMISSIONS].sort());
      expect(rows.map((r) => r.holders)).toEqual(rows.map(() => '0'));
    });

    it('alendei_super_admin carries 38 keys including delegate_tenant; support and reseller_admin do not carry it', async () => {
      const { rows } = await owner.query<{ key: string; n: string; delegate: boolean }>(
        `SELECT r.key, count(*)::text AS n, bool_or(p.key = $1) AS delegate
           FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE r.org_id IS NULL AND r.key = ANY($2::text[]) GROUP BY r.key ORDER BY r.key`,
        [DELEGATE, Object.values(PLATFORM_ROLE_KEYS)],
      );
      expect(rows).toEqual([
        { key: 'alendei_super_admin', n: '38', delegate: true },
        { key: 'alendei_support', n: '13', delegate: false },
        { key: 'reseller_admin', n: '18', delegate: false },
      ]);
    });
  });

  // ===========================================================================
  describe('B. attaching: the role must be eligible for the permission', () => {
    it('no tenant-content key can be attached to any seeded platform role', async () => {
      for (const roleKey of Object.values(PLATFORM_ROLE_KEYS)) {
        for (const key of TENANT_CONTENT_PERMISSIONS) {
          expect([
            roleKey,
            key,
            await attempt(owner, asOwner, attach, [platformRole[roleKey], perm[key]]),
          ]).toEqual([roleKey, key, ELIGIBILITY]);
        }
      }
    });

    it('nor to a custom platform role, at platform or reseller scope', async () => {
      for (const role of [f.platformCustom, f.resellerCustom]) {
        expect(await attempt(owner, asOwner, attach, [role, perm['messages.send']])).toEqual(
          ELIGIBILITY,
        );
      }
    });

    it('delegate_tenant cannot be carried by a reseller-scope role; [+] a platform-scope role may carry it', async () => {
      expect(
        await attempt(owner, asOwner, attach, [platformRole.reseller_admin, perm[DELEGATE]]),
      ).toEqual(ELIGIBILITY);
      expect(await attempt(owner, asOwner, attach, [f.resellerCustom, perm[DELEGATE]])).toEqual(
        ELIGIBILITY,
      );
      expect(await attempt(owner, asOwner, attach, [f.platformCustom, perm[DELEGATE]])).toEqual(
        ok(),
      );
    });

    it('delegate_tenant cannot be carried by a tenant role (the platform.% rule, kept)', async () => {
      for (const [pool, ctx] of [
        [owner, asOwner],
        [app, orgAdmin()],
      ] as const) {
        const outcome = await attempt(pool, ctx, attach, [f.orgOnly, perm[DELEGATE]]);
        expect(outcome).toEqual(refused('42501', null));
      }
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await expect(c.query(attach, [f.orgOnly, perm[DELEGATE]])).rejects.toThrow(
          /platform permission platform\.roles\.delegate_tenant cannot be attached to tenant role/,
        );
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('an organization-only content key cannot go on a tenant role admitting workspace or team — for acc_app and the owner', async () => {
      for (const [pool, ctx] of [
        [owner, asOwner],
        [app, orgAdmin()],
      ] as const) {
        expect(await attempt(pool, ctx, attach, [f.orgWs, perm['templates.read']])).toEqual(
          ELIGIBILITY,
        );
        expect(await attempt(pool, ctx, attach, [f.full, perm['suppressions.manage']])).toEqual(
          ELIGIBILITY,
        );
        expect(await attempt(pool, ctx, attach, [f.full, perm['contacts.read']])).toEqual(
          ELIGIBILITY,
        );
        // [+] Eligible combinations are admitted.
        expect(await attempt(pool, ctx, attach, [f.orgWs, perm['contacts.read']])).toEqual(ok());
        expect(await attempt(pool, ctx, attach, [f.free, perm['templates.manage']])).toEqual(ok());
        expect(await attempt(pool, ctx, attach, [f.full, perm['workspaces.read']])).toEqual(ok());
      }
    });

    it('the refusal names the role, its scope types and the permission', async () => {
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await applyCtx(c, asOwner);
        await expect(
          c.query(attach, [platformRole.alendei_super_admin, perm['contacts.read']]),
        ).rejects.toThrow(
          /role alendei_super_admin admits scope types \{platform\} but permission contacts\.read may only be conferred at \{organization,workspace\}/,
        );
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });

  // ===========================================================================
  describe('C. widening a role past its permissions', () => {
    const widen = 'UPDATE roles SET allowed_scope_types = $2 WHERE id = $1';

    it('a role carrying an organization-only key cannot be widened to workspace — acc_app and owner', async () => {
      for (const [pool, ctx] of [
        [owner, asOwner],
        [app, orgAdmin()],
      ] as const) {
        expect(await attempt(pool, ctx, widen, [f.orgOnly, '{organization,workspace}'])).toEqual(
          WIDENING,
        );
        expect(
          await attempt(pool, ctx, widen, [f.orgOnly, '{organization,workspace,team}']),
        ).toEqual(WIDENING);
      }
    });

    it('[+] a role whose permissions admit the new scopes is widened, and a rename is untouched', async () => {
      const text = 'UPDATE roles SET allowed_scope_types = $2 WHERE id = $1';
      expect(
        await attempt(app, orgAdmin(), text, [f.free, '{organization,workspace,team}']),
      ).toEqual(ok());
      expect(
        await attempt(app, orgAdmin(), "UPDATE roles SET name = 'renamed' WHERE id = $1", [
          f.orgOnly,
        ]),
      ).toEqual(ok());
    });

    it('a platform role cannot be widened to reseller while it carries a platform.* key', async () => {
      expect(
        await attempt(owner, asOwner, 'UPDATE roles SET allowed_scope_types = $2 WHERE id = $1', [
          platformRole.alendei_support,
          '{platform,reseller}',
        ]),
      ).toEqual(WIDENING);
    });
  });

  // ===========================================================================
  describe('D. narrowing or reclassifying a permission a role carries', () => {
    const narrow = 'UPDATE permissions SET allowed_scope_types = $2 WHERE key = $1';

    it('narrowing an existing key below the scopes of roles carrying it is refused', async () => {
      expect(await attempt(owner, null, narrow, ['users.read', '{organization}'])).toEqual(IN_USE);
      expect(
        await attempt(owner, null, narrow, ['templates.read', '{platform,organization}']),
      ).toEqual(refused('23514', 'permissions_tenant_content_scopes'));
    });

    it('reclassifying a key that platform roles carry as tenant content is refused', async () => {
      expect(
        await attempt(
          owner,
          null,
          "UPDATE permissions SET classification = 'tenant_content', allowed_scope_types = '{organization,workspace}' WHERE key = 'users.read'",
        ),
      ).toEqual(IN_USE);
      // Classification alone is pinned by the CHECKs on the scope set.
      expect(
        await attempt(
          owner,
          null,
          "UPDATE permissions SET classification = 'tenant_content' WHERE key = 'users.read'",
        ),
      ).toEqual(refused('23514', 'permissions_tenant_content_scopes'));
    });

    it('[+] narrowing a key no ineligible role carries is admitted', async () => {
      expect(await attempt(owner, null, narrow, ['contacts.read', '{organization}'])).toEqual(ok());
    });

    it('narrowing at REPEATABLE READ or SERIALIZABLE is refused before anything is read', async () => {
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        expect(
          await attempt(owner, null, narrow, ['contacts.read', '{organization}'], iso),
        ).toEqual(refused('25000', 'permissions_allowed_scope_types_narrowing_isolation'));
        // [+] Widening a permission is not narrowing.
        expect(
          await attempt(owner, null, narrow, ['templates.read', '{organization,workspace}'], iso),
        ).toEqual(ok());
      }
    });
  });

  // ===========================================================================
  describe('E. the shape of a classification', () => {
    const insert =
      'INSERT INTO permissions (key, domain, action, classification, allowed_scope_types) VALUES ($1, $2, $3, $4, $5)';
    const row = (key: string, cls: string | null, scopes: string | null) => {
      const dot = key.lastIndexOf('.');
      return [key, key.slice(0, dot), key.slice(dot + 1), cls, scopes];
    };

    it('NULL classification and NULL scopes are refused; nothing defaults', async () => {
      expect(
        await attempt(owner, null, insert, row('zz.null_class', null, '{organization}')),
      ).toEqual(refused('23502', null));
      expect(
        await attempt(owner, null, insert, row('zz.null_scopes', 'tenancy_administration', null)),
      ).toEqual(refused('23502', null));
      expect(
        await attempt(
          owner,
          null,
          "INSERT INTO permissions (key, domain, action) VALUES ('zz.bare', 'zz', 'bare')",
        ),
      ).toEqual(refused('23502', null));
      const { rows } = await owner.query(
        `SELECT column_name, column_default FROM information_schema.columns
          WHERE table_name = 'permissions' AND column_name IN ('classification', 'allowed_scope_types')
          ORDER BY column_name`,
      );
      expect(rows).toEqual([
        { column_name: 'allowed_scope_types', column_default: null },
        { column_name: 'classification', column_default: null },
      ]);
    });

    it('only the four classes exist', async () => {
      expect(
        await attempt(owner, null, insert, row('zz.other', 'tenant_admin', '{organization}')),
      ).toEqual(refused('23514', 'permissions_classification_valid'));
    });

    it('platform ⇔ the platform. prefix, in both directions', async () => {
      expect(
        await attempt(
          owner,
          null,
          insert,
          row('platform.zz.x', 'tenancy_administration', '{platform}'),
        ),
      ).toEqual(refused('23514', 'permissions_classification_platform_domain'));
      expect(await attempt(owner, null, insert, row('zz.x', 'platform', '{platform}'))).toEqual(
        refused('23514', 'permissions_classification_platform_domain'),
      );
    });

    it('a scope set is non-empty; platform is {platform}; content never platform or reseller', async () => {
      expect(
        await attempt(owner, null, insert, row('zz.empty', 'tenancy_administration', '{}')),
      ).toEqual(refused('23514', 'permissions_allowed_scope_types_non_empty'));
      expect(
        await attempt(owner, null, insert, row('platform.zz.y', 'platform', '{platform,reseller}')),
      ).toEqual(refused('23514', 'permissions_platform_scope_only'));
      for (const scopes of ['{reseller,organization}', '{platform}']) {
        expect(
          await attempt(owner, null, insert, row('zz.content', 'tenant_content', scopes)),
        ).toEqual(refused('23514', 'permissions_tenant_content_scopes'));
      }
    });

    it('no application principal may write the catalogue', async () => {
      expect(
        await attempt(
          app,
          orgAdmin(),
          'UPDATE permissions SET allowed_scope_types = $2 WHERE key = $1',
          ['contacts.read', '{organization}'],
        ),
      ).toEqual(refused('42501', null));
    });
  });

  // ===========================================================================
  describe('F. deterministic concurrency (READ COMMITTED)', () => {
    /** Waits until `waiter` is blocked by `holder`; observed, not assumed. */
    async function blockedBy(holder: number, waiter: number): Promise<boolean> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { rows } = await owner.query<{ blocked: boolean }>(
          'SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS blocked',
          [holder, waiter],
        );
        if (rows[0]!.blocked) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    }
    const pid = async (c: PoolClient) =>
      (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const settle = (p: Promise<unknown>): Promise<Outcome> =>
      p.then(
        (r) => ({ rows: (r as { rowCount?: number }).rowCount ?? 0 }),
        (e: PgError) => ({ code: e.code ?? '', constraint: e.constraint ?? null }),
      );

    /** Runs `first` (held, uncommitted) then `second`, which must wait for it. */
    async function race(
      first: { pool: Pool; ctx: Ctx | null; text: string; params: unknown[] },
      second: { pool: Pool; ctx: Ctx | null; text: string; params: unknown[] },
    ): Promise<{ firstRows: number; waited: boolean; secondOutcome: Outcome }> {
      const t1 = await first.pool.connect();
      const t2 = await second.pool.connect();
      try {
        await t1.query('BEGIN');
        if (first.ctx) await applyCtx(t1, first.ctx);
        const p1 = await pid(t1);
        const r1 = await t1.query(first.text, first.params);

        await t2.query('BEGIN');
        if (second.ctx) await applyCtx(t2, second.ctx);
        const p2 = await pid(t2);
        const pending = settle(t2.query(second.text, second.params));

        const waited = await blockedBy(p1, p2);
        await t1.query('COMMIT');
        const secondOutcome = await pending;
        await t2.query('rows' in secondOutcome && secondOutcome.rows >= 0 ? 'COMMIT' : 'ROLLBACK');
        return { firstRows: r1.rowCount ?? 0, waited, secondOutcome };
      } finally {
        await t1.query('ROLLBACK').catch(() => undefined);
        await t2.query('ROLLBACK').catch(() => undefined);
        t1.release();
        t2.release();
      }
    }

    const narrowContacts = {
      pool: undefined as unknown as Pool,
      ctx: null,
      text: "UPDATE permissions SET allowed_scope_types = '{organization}' WHERE key = 'contacts.read'",
      params: [],
    };
    const restoreContacts = () =>
      owner.query(
        "UPDATE permissions SET allowed_scope_types = '{organization,workspace}' WHERE key = 'contacts.read'",
      );
    const holdersOf = async (key: string) =>
      (
        await owner.query(
          'SELECT role_id FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE key = $1)',
          [key],
        )
      ).rows.map((r) => r.role_id as string);
    const scopesOf = async (key: string) =>
      (
        await owner.query('SELECT allowed_scope_types::text AS s FROM permissions WHERE key = $1', [
          key,
        ])
      ).rows[0].s as string;
    const roleScopes = async (id: string) =>
      (await owner.query('SELECT allowed_scope_types::text AS s FROM roles WHERE id = $1', [id]))
        .rows[0].s as string;

    it('an attach racing a narrowing that got there first waits, then is refused by the narrowed set', async () => {
      try {
        const result = await race(
          { ...narrowContacts, pool: owner },
          { pool: app, ctx: orgAdmin(), text: attach, params: [f.orgWs, perm['contacts.read']] },
        );
        expect(result).toEqual({ firstRows: 1, waited: true, secondOutcome: ELIGIBILITY });
        expect(await holdersOf('contacts.read')).toEqual([f.orgContacts]);
        expect(await scopesOf('contacts.read')).toBe('{organization}');
      } finally {
        await restoreContacts();
      }
    });

    it('a narrowing racing an attach that got there first waits, then is refused by the committed attach', async () => {
      try {
        const result = await race(
          { pool: app, ctx: orgAdmin(), text: attach, params: [f.orgWs, perm['contacts.read']] },
          { ...narrowContacts, pool: owner },
        );
        expect(result).toEqual({ firstRows: 1, waited: true, secondOutcome: IN_USE });
        expect((await holdersOf('contacts.read')).sort()).toEqual([f.orgContacts, f.orgWs].sort());
        expect(await scopesOf('contacts.read')).toBe('{organization,workspace}');
      } finally {
        await owner.query('DELETE FROM role_permissions WHERE role_id = $1', [f.orgWs]);
        await restoreContacts();
      }
    });

    it('an attach racing a widening of the role that got there first waits, then is refused', async () => {
      try {
        const result = await race(
          {
            pool: app,
            ctx: orgAdmin(),
            text: "UPDATE roles SET allowed_scope_types = '{organization,workspace}' WHERE id = $1",
            params: [f.free],
          },
          { pool: app, ctx: orgAdmin(), text: attach, params: [f.free, perm['templates.read']] },
        );
        expect(result).toEqual({ firstRows: 1, waited: true, secondOutcome: ELIGIBILITY });
        expect(await holdersOf('templates.read')).toEqual([f.orgOnly]);
        expect(await roleScopes(f.free!)).toBe('{organization,workspace}');
      } finally {
        await owner.query("UPDATE roles SET allowed_scope_types = '{organization}' WHERE id = $1", [
          f.free,
        ]);
      }
    });

    it('a widening racing an attach that got there first waits, then is refused', async () => {
      try {
        const result = await race(
          { pool: app, ctx: orgAdmin(), text: attach, params: [f.free, perm['templates.read']] },
          {
            pool: app,
            ctx: orgAdmin(),
            text: "UPDATE roles SET allowed_scope_types = '{organization,workspace}' WHERE id = $1",
            params: [f.free],
          },
        );
        expect(result).toEqual({ firstRows: 1, waited: true, secondOutcome: WIDENING });
        expect(await roleScopes(f.free!)).toBe('{organization}');
      } finally {
        await owner.query('DELETE FROM role_permissions WHERE role_id = $1', [f.free]);
      }
    });

    // A role carrying contacts.read at {organization}: widening it to workspace
    // is eligible under {organization,workspace}; narrowing contacts.read to
    // {organization} is eligible for the unwidened role. Both together are not.
    const widenContactsRole = {
      text: "UPDATE roles SET allowed_scope_types = '{organization,workspace}' WHERE id = $1",
    };

    it('a narrowing racing a widening of a role carrying the permission waits, then is refused', async () => {
      try {
        const result = await race(
          { pool: app, ctx: orgAdmin(), text: widenContactsRole.text, params: [f.orgContacts] },
          { ...narrowContacts, pool: owner },
        );
        expect(result).toEqual({ firstRows: 1, waited: true, secondOutcome: IN_USE });
        expect(await scopesOf('contacts.read')).toBe('{organization,workspace}');
      } finally {
        await owner.query("UPDATE roles SET allowed_scope_types = '{organization}' WHERE id = $1", [
          f.orgContacts,
        ]);
        await restoreContacts();
      }
    });

    it('a widening racing a narrowing of a permission the role carries waits, then is refused', async () => {
      try {
        const result = await race(
          { ...narrowContacts, pool: owner },
          { pool: app, ctx: orgAdmin(), text: widenContactsRole.text, params: [f.orgContacts] },
        );
        expect(result).toEqual({ firstRows: 1, waited: true, secondOutcome: WIDENING });
        expect(await roleScopes(f.orgContacts!)).toBe('{organization}');
        expect(await scopesOf('contacts.read')).toBe('{organization}');
      } finally {
        await restoreContacts();
      }
    });
  });

  // ===========================================================================
  describe('G. the verification block refuses bad data before anything is applied', () => {
    const verification = () => {
      const block = readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')[0]!;
      const start = block.indexOf('DO $$');
      expect(start).toBeGreaterThan(-1);
      return block.slice(start);
    };
    const asOwnerRolledBack = async (work: (c: PoolClient) => Promise<void>) => {
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await applyCtx(c, asOwner);
        await work(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    const failure = async (c: PoolClient): Promise<PgError> => {
      try {
        await c.query(verification());
      } catch (error) {
        return error as PgError;
      }
      throw new Error('expected the verification to refuse');
    };

    it('passes on the current database', async () => {
      await asOwnerRolledBack(async (c) => {
        await c.query(verification());
      });
    });

    it('names a permission key it cannot classify', async () => {
      await asOwnerRolledBack(async (c) => {
        await c.query(
          "INSERT INTO permissions (key, domain, action, classification, allowed_scope_types) VALUES ('zz.unknown', 'zz', 'unknown', 'tenancy_administration', '{organization}')",
        );
        const err = await failure(c);
        expect(err.code).toBe('23514');
        expect(err.message).toMatch(
          /migration 0026 verification failed \[permissions_known_catalogue\]: 1 permissions .*\(keys: zz\.unknown\)/,
        );
      });
    });

    it('names a role already carrying a permission it is ineligible for', async () => {
      await asOwnerRolledBack(async (c) => {
        await c.query('ALTER TABLE role_permissions DISABLE TRIGGER trg_role_permissions_validate');
        await c.query(attach, [platformRole.alendei_support, perm['contacts.read']]);
        const err = await failure(c);
        expect(err.code).toBe('42501');
        expect(err.message).toMatch(
          /\[role_permissions_scope_eligibility\]: 1 role permissions .*alendei_support:contacts\.read/,
        );
      });
    });
  });
});
