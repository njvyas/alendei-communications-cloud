/**
 * The Model B tenant-content predicate, proven directly against PostgreSQL
 * (ADR-015 R-7, R-8; ADR-014 §17.1; DECISIONS §1o "Required evidence").
 *
 * No content table exists before Phase 3.1, so this suite creates a disposable,
 * test-only one on its clone with exactly the §17.1 policy shape
 * (`contentFixtureDdl`) and drops it again. Every query runs as the real
 * non-owner `acc_app` (or `acc_auth` / `acc_relay`) login with raw
 * `set_config`, reads the whole table with no application-side filter, and
 * calls `app_content_context_valid()` directly — so RLS alone decides.
 *
 * Topology (planted by the owner):
 *
 *     Reseller R ── Org A (rows a1, a2 — a2 in A's default workspace)
 *                ├─ Org B (row b1)
 *                └─ Org S (row s1; suspended)
 */
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { contentFixtureDdl } from './content-tables';
import {
  connect,
  createReseller,
  createTenant,
  destroyReseller,
  destroyTenant,
  loadTestEnv,
  plantPlatformAdmin,
  plantPlatformSupport,
  plantResellerAdmin,
  removeIdentities,
  type Principals,
  type TenantFixture,
} from './harness';

const T = 's4_content';

/** One transaction's claims; absent ones are written empty / off, as production does. */
interface Ctx {
  readonly org?: string;
  readonly user?: string;
  readonly key?: string;
  readonly reseller?: string;
  readonly platform?: boolean;
  readonly workspace?: string;
}

const claims = (ctx: Ctx): [string, string][] => [
  ['app.current_org_id', ctx.org ?? ''],
  ['app.current_workspace_id', ctx.workspace ?? ''],
  ['app.current_reseller_id', ctx.reseller ?? ''],
  ['app.current_user_id', ctx.user ?? ''],
  ['app.is_platform_admin', ctx.platform ? 'on' : 'off'],
  ['app.provisioning', 'off'],
  ['app.current_api_key_id', ctx.key ?? ''],
];

/** The SQLSTATE of a refusal, or null when `work` succeeded. */
async function code(work: Promise<unknown>): Promise<string | null> {
  return work.then(
    () => null,
    (e: { code?: string }) => e.code ?? 'no-code',
  );
}

describe('Model B tenant-content predicate — direct PostgreSQL', () => {
  let db: Principals;
  let relayPool: Pool;
  let owner: string;

  let reseller: string;
  let A: TenantFixture;
  let B: TenantFixture;
  let S: TenantFixture;
  const role: Record<string, string> = {};
  const user: Record<string, string> = {};
  const key: Record<string, string> = {};
  const planted: string[] = [];

  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  async function plantUser(label: string, status: 'active' | 'disabled' = 'active') {
    const { rows } = await admin(
      `INSERT INTO users (email, status, password_hash) VALUES ($1, $2, 'not-a-login-credential') RETURNING id`,
      [`${label}-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`, status],
    );
    return rows[0].id as string;
  }

  async function grant(userId: string, orgId: string, scopeType: string, scopeId: string) {
    await admin(
      `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, $4)`,
      [userId, role[orgId], scopeType, scopeId],
    );
  }

  async function plantKey(orgId: string, options: { revoked?: boolean; expired?: boolean } = {}) {
    const { rows } = await admin(
      `INSERT INTO api_keys (org_id, name, key_prefix, key_hash, revoked_at, revoked_reason, expires_at)
       VALUES ($1, 'content-test', $2, 'not-a-real-hash',
               CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN 'test' END,
               CASE WHEN $4 THEN now() - interval '1 minute' END)
       RETURNING id`,
      [orgId, `ak_test_${randomBytes(8).toString('hex')}`, !!options.revoked, !!options.expired],
    );
    return rows[0].id as string;
  }

  /** Runs `work` as `acc_app` under `ctx`, in a transaction that is rolled back. */
  async function asApp<R>(ctx: Ctx, work: (c: PoolClient) => Promise<R>): Promise<R> {
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      for (const [name, value] of claims(ctx)) {
        await c.query('SELECT set_config($1, $2, true)', [name, value]);
      }
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  const labels = async (c: PoolClient) =>
    (await c.query<{ label: string }>(`SELECT label FROM ${T} ORDER BY label`)).rows.map(
      (r) => r.label,
    );
  const validIn = async (c: PoolClient) =>
    (await c.query<{ v: boolean }>('SELECT app_content_context_valid() AS v')).rows[0]!.v;

  /** What `ctx` can do: the function's answer and the content rows it reaches. */
  const probe = (ctx: Ctx) =>
    asApp(ctx, async (c) => ({ valid: await validIn(c), rows: await labels(c) }));

  /** Tenancy-table visibility, to show an elevated claim really is honoured there. */
  const workspacesOf = (ctx: Ctx, orgId: string) =>
    asApp(ctx, async (c) =>
      Number(
        (
          await c.query<{ n: string }>('SELECT count(*) AS n FROM workspaces WHERE org_id = $1', [
            orgId,
          ])
        ).rows[0]!.n,
      ),
    );

  const DENIED = { valid: false, rows: [] };

  beforeAll(async () => {
    loadTestEnv();
    db = connect();
    relayPool = new Pool({ connectionString: process.env.DATABASE_RELAY_URL!, max: 1 });
    owner = (
      await admin(
        `SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'public.user_roles'::regclass`,
      )
    ).rows[0].o;

    reseller = await createReseller(db.admin, 'content');
    A = await createTenant(db.admin, 'content-a', { resellerId: reseller });
    B = await createTenant(db.admin, 'content-b', { resellerId: reseller });
    S = await createTenant(db.admin, 'content-s', { resellerId: reseller });
    for (const t of [A, B, S]) {
      const { rows } = await admin(
        `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
         VALUES ($1, 'content_member', 'Content member', false, '{organization,workspace,team}')
         RETURNING id`,
        [t.orgId],
      );
      role[t.orgId] = rows[0].id;
    }

    user.orgA = await plantUser('c-org-a');
    await grant(user.orgA, A.orgId, 'organization', A.orgId);
    user.wsA = await plantUser('c-ws-a');
    await grant(user.wsA, A.orgId, 'workspace', A.workspaceId);
    user.teamA = await plantUser('c-team-a');
    await grant(user.teamA, A.orgId, 'team', A.teamId);
    user.orgB = await plantUser('c-org-b');
    await grant(user.orgB, B.orgId, 'organization', B.orgId);
    user.both = await plantUser('c-both');
    await grant(user.both, A.orgId, 'organization', A.orgId);
    await grant(user.both, B.orgId, 'organization', B.orgId);
    user.disabledA = await plantUser('c-disabled-a', 'disabled');
    await grant(user.disabledA, A.orgId, 'organization', A.orgId);
    user.orgS = await plantUser('c-org-s');
    await grant(user.orgS, S.orgId, 'organization', S.orgId);
    user.liveGrant = await plantUser('c-live-grant');
    await grant(user.liveGrant, A.orgId, 'organization', A.orgId);
    user.liveStatus = await plantUser('c-live-status');
    await grant(user.liveStatus, A.orgId, 'organization', A.orgId);
    // `A.userId` is the harness's invited user, holding org_admin at A.

    user.reseller = await plantResellerAdmin(db.admin, reseller, 'c-reseller');
    user.platform = await plantPlatformAdmin(db.admin, 'c-platform');
    user.support = await plantPlatformSupport(db.admin, 'c-support');
    user.platformMember = await plantPlatformAdmin(db.admin, 'c-platform-member');
    planted.push(user.reseller, user.platform, user.support, user.platformMember);
    await grant(user.platformMember, A.orgId, 'organization', A.orgId);

    key.A = A.apiKeyId;
    key.B = B.apiKeyId;
    key.revokedA = await plantKey(A.orgId, { revoked: true });
    key.expiredA = await plantKey(A.orgId, { expired: true });
    key.liveA = await plantKey(A.orgId);

    await admin(
      `UPDATE organizations SET status = 'suspended', status_changed_at = now(), status_reason = 'content test'
       WHERE id = $1`,
      [S.orgId],
    );

    for (const statement of contentFixtureDdl(T)) await admin(statement);
    await admin(
      `INSERT INTO ${T} (org_id, workspace_id, label) VALUES
         ($1, NULL, 'a1'), ($1, $2, 'a2'), ($3, NULL, 'b1'), ($4, NULL, 's1')`,
      [A.orgId, A.workspaceId, B.orgId, S.orgId],
    );
  }, 120_000);

  afterAll(async () => {
    await admin(`DROP TABLE IF EXISTS ${T}`);
    await removeIdentities(db.admin, planted);
    for (const t of [A, B, S]) await destroyTenant(db.admin, t);
    for (const id of Object.values(user)) {
      await admin(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
      await admin(`DELETE FROM users WHERE id = $1`, [id]);
    }
    await destroyReseller(db.admin, reseller);
    await relayPool.end();
    await db.close();
  }, 120_000);

  // ===========================================================================
  describe('allowed', () => {
    it('an active user with an organization grant reaches its own organization only', async () => {
      expect(await probe({ org: A.orgId, user: user.orgA })).toEqual({
        valid: true,
        rows: ['a1', 'a2'],
      });
    });

    it('a workspace grant admits the whole organization at the database layer (ADR-011 D-4)', async () => {
      // a1 has no workspace and a2 is in A's default workspace: both visible.
      // Workspace isolation is the application's check, not this predicate's.
      expect(await probe({ org: A.orgId, user: user.wsA, workspace: A.workspaceId })).toEqual({
        valid: true,
        rows: ['a1', 'a2'],
      });
    });

    it('a team grant admits the whole organization at the database layer', async () => {
      expect(await probe({ org: A.orgId, user: user.teamA })).toEqual({
        valid: true,
        rows: ['a1', 'a2'],
      });
    });

    it('a valid (unrevoked, unexpired) API key of the organization is allowed', async () => {
      expect(await probe({ org: A.orgId, key: key.A })).toEqual({
        valid: true,
        rows: ['a1', 'a2'],
      });
    });

    it('an explicit organization grant is the only way in for a platform principal — its platform claim adds nothing', async () => {
      // R-8: no break-glass arm. With an org grant at A the super-admin reaches
      // A's content, exactly A's; at B (no grant) nothing, claim or no claim.
      expect(await probe({ org: A.orgId, user: user.platformMember, platform: true })).toEqual({
        valid: true,
        rows: ['a1', 'a2'],
      });
      expect(await probe({ org: B.orgId, user: user.platformMember, platform: true })).toEqual(
        DENIED,
      );
      expect(
        await workspacesOf({ org: B.orgId, user: user.platformMember, platform: true }, B.orgId),
      ).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  describe('denied', () => {
    it('sibling organization: a member of A selecting B is denied (user arm)', async () => {
      expect(await probe({ org: B.orgId, user: user.orgA })).toEqual(DENIED);
    });

    it('reseller-only: a validated reseller claim plus a selected organization, with no org/workspace/team grant, is denied', async () => {
      for (const org of [A.orgId, B.orgId]) {
        const ctx = { org, user: user.reseller, reseller };
        expect(await probe(ctx)).toEqual(DENIED);
        // The claim itself is valid — the tenancy table admits it — so the
        // denial is the content predicate's, not a broken context.
        expect(await workspacesOf(ctx, org)).toBeGreaterThan(0);
      }
    });

    it('platform-only: a validated super-admin claim plus a selected organization is denied', async () => {
      const ctx = { org: A.orgId, user: user.platform, platform: true };
      expect(await probe(ctx)).toEqual(DENIED);
      expect(await workspacesOf(ctx, A.orgId)).toBeGreaterThan(0);
    });

    it('support-only: alendei_support selecting an organization is denied', async () => {
      expect(await probe({ org: A.orgId, user: user.support })).toEqual(DENIED);
      expect(await probe({ org: A.orgId, user: user.support, platform: true })).toEqual(DENIED);
    });

    it('a disabled user is denied despite an organization grant', async () => {
      expect(await probe({ org: A.orgId, user: user.disabledA })).toEqual(DENIED);
    });

    it('an invited user is denied despite an organization grant', async () => {
      expect(await probe({ org: A.orgId, user: A.userId })).toEqual(DENIED);
    });

    it('a revoked API key is denied', async () => {
      expect(await probe({ org: A.orgId, key: key.revokedA })).toEqual(DENIED);
    });

    it('an expired API key is denied', async () => {
      expect(await probe({ org: A.orgId, key: key.expiredA })).toEqual(DENIED);
    });

    it('an API key of another organization is denied', async () => {
      expect(await probe({ org: A.orgId, key: key.B })).toEqual(DENIED);
    });

    it('forged organization context: A’s member or A’s key with current_org_id = B is denied', async () => {
      expect(await probe({ org: B.orgId, user: user.orgA })).toEqual(DENIED);
      expect(await probe({ org: B.orgId, key: key.A })).toEqual(DENIED);
      expect(await probe({ org: B.orgId, user: user.orgA, key: key.A })).toEqual(DENIED);
    });

    it('an empty app.current_org_id is denied, whatever user or key is named', async () => {
      expect(await probe({ user: user.orgA })).toEqual(DENIED);
      expect(await probe({ key: key.A })).toEqual(DENIED);
      expect(await probe({ user: user.both, key: key.A, platform: true })).toEqual(DENIED);
    });

    it('a transaction that sets no claim at all is denied', async () => {
      const c = await db.appPool.connect();
      try {
        await c.query('BEGIN');
        expect(await validIn(c)).toBe(false);
        expect(await labels(c)).toEqual([]);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('no claim, user or key arm alone admits: a user and a key of different organizations are each judged against the one in context', async () => {
      expect(await probe({ org: A.orgId, user: user.orgB, key: key.B })).toEqual(DENIED);
    });
  });

  // ===========================================================================
  describe('the app.current_user_id residual (SECURITY.md §4b) — exactly', () => {
    it('a forged current_user_id of a real member of B, with current_org_id = B, reaches B’s rows only', async () => {
      // This is the accepted residual: acc_app sets the user claim, so a
      // compromised acc_app naming B's member reaches B's content …
      expect(await probe({ org: B.orgId, user: user.orgB })).toEqual({ valid: true, rows: ['b1'] });
      // … never A's: the user arm is judged against the organization in context …
      expect(await probe({ org: A.orgId, user: user.orgB })).toEqual(DENIED);
      // … never two organizations, even for a user who is a member of both …
      expect(await probe({ org: A.orgId, user: user.both })).toEqual({
        valid: true,
        rows: ['a1', 'a2'],
      });
      expect(await probe({ org: B.orgId, user: user.both })).toEqual({ valid: true, rows: ['b1'] });
      // … and never by reseller or platform reach.
      expect(await probe({ org: B.orgId, user: user.reseller, reseller })).toEqual(DENIED);
      expect(await probe({ org: B.orgId, user: user.platform, platform: true })).toEqual(DENIED);
    });
  });

  // ===========================================================================
  describe('writes', () => {
    it('a cross-organization INSERT is refused (42501); an own-organization INSERT is admitted', async () => {
      await asApp({ org: A.orgId, user: user.orgA }, async (c) => {
        expect(
          await code(c.query(`INSERT INTO ${T} (org_id, label) VALUES ($1, 'x')`, [B.orgId])),
        ).toBe('42501');
      });
      await asApp({ org: A.orgId, user: user.orgA }, async (c) => {
        const { rowCount } = await c.query(`INSERT INTO ${T} (org_id, label) VALUES ($1, 'x')`, [
          A.orgId,
        ]);
        expect(rowCount).toBe(1);
      });
    });

    it('an INSERT by a reseller-only, platform-only or empty-organization context is refused (42501)', async () => {
      for (const ctx of [
        { org: A.orgId, user: user.reseller, reseller },
        { org: A.orgId, user: user.platform, platform: true },
        { user: user.orgA },
        { org: A.orgId, key: key.revokedA },
      ]) {
        await asApp(ctx, async (c) => {
          expect(
            await code(c.query(`INSERT INTO ${T} (org_id, label) VALUES ($1, 'x')`, [A.orgId])),
          ).toBe('42501');
        });
      }
    });

    it('an UPDATE cannot move a row to another organization (WITH CHECK, 42501)', async () => {
      await asApp({ org: A.orgId, user: user.orgA }, async (c) => {
        expect(
          await code(c.query(`UPDATE ${T} SET org_id = $1 WHERE label = 'a1'`, [B.orgId])),
        ).toBe('42501');
      });
    });

    it('an UPDATE by a denied context reaches no row', async () => {
      await asApp({ org: A.orgId, user: user.reseller, reseller }, async (c) => {
        const { rowCount } = await c.query(`UPDATE ${T} SET label = label || '!'`);
        expect(rowCount).toBe(0);
      });
    });

    it('DELETE is not granted: acc_app is refused even in its own organization (42501)', async () => {
      await asApp({ org: A.orgId, user: user.orgA }, async (c) => {
        expect(await code(c.query(`DELETE FROM ${T} WHERE label = 'a1'`))).toBe('42501');
      });
    });
  });

  // ===========================================================================
  describe('who may call the function', () => {
    it('the ACL is exactly the owner and acc_app; PUBLIC, acc_auth and acc_relay hold no EXECUTE', async () => {
      const { rows } = await admin(
        `SELECT p.proacl::text AS acl,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege('acc_auth', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('acc_relay', p.oid, 'EXECUTE') AS relay,
                has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'app_content_context_valid'`,
      );
      expect(rows).toEqual([
        {
          acl: `{${owner}=X/${owner},acc_app=X/${owner}}`,
          pub: false,
          auth: false,
          relay: false,
          app: true,
        },
      ]);
    });

    it('acc_auth and acc_relay get 42501 calling it', async () => {
      expect(await code(db.authPool.query('SELECT app_content_context_valid()'))).toBe('42501');
      expect(await code(relayPool.query('SELECT app_content_context_valid()'))).toBe('42501');
    });

    it('acc_app cannot grant EXECUTE to PUBLIC or to acc_auth: the ACL is unchanged', async () => {
      for (const grantee of ['PUBLIC', 'acc_auth', 'acc_relay']) {
        const c = await db.appPool.connect();
        try {
          await c.query('BEGIN');
          // acc_app holds EXECUTE without GRANT OPTION, so PostgreSQL grants
          // nothing (it warns rather than errors); either outcome must leave
          // the ACL as it was — checked inside the same transaction.
          await code(
            c.query(`GRANT EXECUTE ON FUNCTION app_content_context_valid() TO ${grantee}`),
          );
          await c.query('ROLLBACK');
        } finally {
          c.release();
        }
        const { rows } = await admin(
          `SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'app_content_context_valid'`,
        );
        expect(`${grantee}:${rows[0].acl}`).toBe(
          `${grantee}:{${owner}=X/${owner},acc_app=X/${owner}}`,
        );
      }
      // The same attempt, committed rather than rolled back, still grants nothing.
      await code(
        db.appPool.query(`GRANT EXECUTE ON FUNCTION app_content_context_valid() TO PUBLIC`),
      );
      expect(await code(relayPool.query('SELECT app_content_context_valid()'))).toBe('42501');
    });

    it('a caller’s temporary tables cannot shadow user_roles, users or api_keys (pinned search_path)', async () => {
      const forgedKey = uuidv7();
      const forgedUser = uuidv7();
      await asApp({ org: B.orgId, user: forgedUser, key: forgedKey }, async (c) => {
        await c.query(
          `CREATE TEMP TABLE api_keys (id uuid, org_id uuid, revoked_at timestamptz, expires_at timestamptz) ON COMMIT DROP`,
        );
        await c.query(`INSERT INTO pg_temp.api_keys VALUES ($1, $2, NULL, NULL)`, [
          forgedKey,
          B.orgId,
        ]);
        await c.query(`CREATE TEMP TABLE users (id uuid, status text) ON COMMIT DROP`);
        await c.query(`INSERT INTO pg_temp.users VALUES ($1, 'active')`, [forgedUser]);
        await c.query(
          `CREATE TEMP TABLE user_roles (user_id uuid, org_id uuid, scope_type text) ON COMMIT DROP`,
        );
        await c.query(`INSERT INTO pg_temp.user_roles VALUES ($1, $2, 'organization')`, [
          forgedUser,
          B.orgId,
        ]);
        await c.query(`SET LOCAL search_path = pg_temp, public`);
        expect(await validIn(c)).toBe(false);
        expect(await labels(c)).toEqual([]);
      });
    });
  });

  // ===========================================================================
  describe('live evaluation — STABLE within one statement only', () => {
    /** Runs statement 1, then `change` in another committed transaction, then statement 2. */
    async function acrossChange(ctx: Ctx, change: () => Promise<unknown>) {
      return asApp(ctx, async (c) => {
        const before = { valid: await validIn(c), rows: await labels(c) };
        await change();
        const after = { valid: await validIn(c), rows: await labels(c) };
        return { before, after };
      });
    }

    it('a grant revoked in another committed transaction denies the next statement', async () => {
      const result = await acrossChange({ org: A.orgId, user: user.liveGrant }, () =>
        admin(`DELETE FROM user_roles WHERE user_id = $1`, [user.liveGrant]),
      );
      expect(result).toEqual({ before: { valid: true, rows: ['a1', 'a2'] }, after: DENIED });
    });

    it('a user disabled in another committed transaction is denied on the next statement', async () => {
      const result = await acrossChange({ org: A.orgId, user: user.liveStatus }, () =>
        admin(`UPDATE users SET status = 'disabled' WHERE id = $1`, [user.liveStatus]),
      );
      expect(result).toEqual({ before: { valid: true, rows: ['a1', 'a2'] }, after: DENIED });
    });

    it('an API key revoked in another committed transaction is denied on the next statement', async () => {
      const result = await acrossChange({ org: A.orgId, key: key.liveA }, () =>
        admin(`UPDATE api_keys SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1`, [
          key.liveA,
        ]),
      );
      expect(result).toEqual({ before: { valid: true, rows: ['a1', 'a2'] }, after: DENIED });
    });

    it('the predicate is an InitPlan: the function runs once per statement, not per row', async () => {
      const plan = await asApp({ org: A.orgId, user: user.orgA }, async (c) => {
        const { rows } = await c.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF, VERBOSE) SELECT label FROM ${T}`,
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      console.log(`EXPLAIN — content predicate on ${T}:\n${plan}`);
      // One InitPlan, executed once (loops=1), computing the function …
      expect(plan).toMatch(
        /InitPlan 1\n\s+->\s+Result \(actual rows=1 loops=1\)\n\s+Output: app_content_context_valid\(\)/,
      );
      expect(plan.match(/app_content_context_valid\(\)/g)).toHaveLength(1);
      // … the per-row filter reads only its result …
      expect(plan).toMatch(/Filter: \(InitPlan 1\)\.col1\n/);
      // … and the org term (app_current_org_id() is inlined by the planner)
      // stays indexable: it is the index condition, not a filter.
      expect(plan).toMatch(
        /Index Cond: \(s4_content\.org_id = \(NULLIF\(current_setting\('app\.current_org_id'::text, true\), ''::text\)\)::uuid\)/,
      );
    });
  });

  // ===========================================================================
  describe('observations (no decision covers them; recorded, not chosen)', () => {
    it('the organization’s own status is not consulted: an active member of a suspended organization is admitted', async () => {
      // DECISIONS §1o R-7 and ADR-014 §17.1 name no status condition, so none
      // was added. Organization lifecycle is enforced by authorization
      // (TENANCY.md §1a). Reported for review.
      expect(await probe({ org: S.orgId, user: user.orgS })).toEqual({ valid: true, rows: ['s1'] });
    });
  });
});
