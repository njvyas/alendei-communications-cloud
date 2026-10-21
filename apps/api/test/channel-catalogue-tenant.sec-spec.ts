/**
 * ACC Batch 2 — tenant operators read the channel catalogue (migration 0035).
 *
 *   GET /channels — platform callers: providers.read at platform scope, exactly
 *   as Phase 2.1 (ADR-013 F-3). Tenant operators: one of suppressions.read,
 *   contacts.read, templates.read, messages.read at the resolved, active
 *   organization, asserted in the request transaction before
 *   app_channel_catalogue() is called.
 *
 * Every HTTP case drives the real application against the real database; the
 * function cases inspect the catalogue and open acc_app / acc_auth / acc_relay
 * connections directly, with the service bypassed.
 */
import { randomBytes } from 'node:crypto';

import { AUDIT_ACTIONS, ERROR_CODES, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const CATALOGUE_FIELDS = ['code', 'createdAt', 'displayName', 'id', 'status', 'updatedAt'];
const TENANT_READ_PERMISSIONS = [
  'suppressions.read',
  'contacts.read',
  'templates.read',
  'messages.read',
] as const;

interface ChannelBody {
  id: string;
  code: string;
  displayName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

describe('ACC Batch 2 — tenant read of the channel catalogue', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenant: TenantFixture;
  let other: TenantFixture;
  let appPool: Pool;
  let authPool: Pool;
  let relayPool: Pool;

  const createdUsers: string[] = [];
  const createdRoles: string[] = [];
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let apiKey: string;
  let apiKeyId: string;
  let channelIds: string[] = [];

  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => uuidv7().replace(/-/g, '').slice(-10);

  async function createUser(label: string) {
    const email = `b2-${label}-${suffix()}@example.test`;
    const [u] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    createdUsers.push(u!.id);
    return { userId: u!.id, email };
  }

  async function grant(
    userId: string,
    roleId: string,
    scopeType: 'platform' | 'reseller' | 'organization',
    scopeId: string | null,
  ) {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({ userId, roleId, scopeType, scopeId });
    });
  }

  async function platformRole(key: string) {
    const [r] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, key), isNull(schema.roles.orgId)));
    return r!.id;
  }

  /** A custom role in `orgId` holding exactly `permissionKeys`, created by the owner. */
  async function tenantRole(orgId: string, permissionKeys: readonly string[]): Promise<string> {
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId,
          key: `b2_role_${suffix()}`,
          name: 'Batch 2 test role',
          isSystemRole: false,
          allowedScopeTypes: ['organization'],
        })
        .returning({ id: schema.roles.id });
      createdRoles.push(role!.id);
      const perms = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(inArray(schema.permissions.key, [...permissionKeys]));
      expect(perms).toHaveLength(permissionKeys.length);
      for (const p of perms)
        await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId: p.id });
      return role!.id;
    });
  }

  async function platformRoleWith(permissionKeys: readonly string[]): Promise<string> {
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: null,
          key: `b2_platform_${suffix()}`,
          name: 'Batch 2 platform role',
          isSystemRole: false,
          allowedScopeTypes: ['platform'],
        })
        .returning({ id: schema.roles.id });
      createdRoles.push(role!.id);
      const perms = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(inArray(schema.permissions.key, [...permissionKeys]));
      for (const p of perms)
        await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId: p.id });
      return role!.id;
    });
  }

  async function login(email: string) {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  const get = (credential: string | null, path: string, org?: string) => {
    let r = request(h.app.getHttpServer()).get(url(path));
    if (credential) r = r.set('authorization', `Bearer ${credential}`);
    return org ? r.set('x-acc-organization', org) : r;
  };

  const deniedAudits = async (userId: string) =>
    (
      await h.admin.execute<{ scope_type: string; scope_id: string | null; metadata: unknown }>(
        sql`select scope_type, scope_id, metadata from audit_logs
             where action = ${AUDIT_ACTIONS.AUTHORIZATION_DENIED} and actor_user_id = ${userId}
             order by id`,
      )
    ).rows;

  async function asAppTenant<T>(
    orgId: string,
    userId: string,
    work: (c: import('pg').PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      for (const [name, value] of [
        ['app.current_org_id', orgId],
        ['app.current_workspace_id', ''],
        ['app.current_reseller_id', ''],
        ['app.current_user_id', userId],
        ['app.is_platform_admin', 'off'],
        ['app.provisioning', 'off'],
      ] as const) {
        await c.query('SELECT set_config($1, $2, true)', [name, value]);
      }
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    authPool = new Pool({ connectionString: process.env.DATABASE_AUTH_URL, max: 1 });
    relayPool = new Pool({ connectionString: process.env.DATABASE_RELAY_URL, max: 1 });

    tenant = await createTenant(h.admin, 'b2a', credentials);
    other = await createTenant(h.admin, 'b2b', credentials);

    // One operator per admitting permission, each holding only that one.
    for (const permission of TENANT_READ_PERMISSIONS) {
      const person = await createUser(permission.replace('.', '-'));
      await grant(
        person.userId,
        await tenantRole(tenant.orgId, [permission]),
        'organization',
        tenant.orgId,
      );
      userIds[permission] = person.userId;
      tokens[permission] = await login(person.email);
    }

    // A tenant user holding tenant permissions, none of them a content read.
    const plain = await createUser('no-content');
    await grant(
      plain.userId,
      await tenantRole(tenant.orgId, ['workspaces.read', 'users.read', 'suppressions.manage']),
      'organization',
      tenant.orgId,
    );
    userIds.plain = plain.userId;
    tokens.plain = await login(plain.email);

    // Content read in the OTHER organization only; a non-content grant here.
    const crossOrg = await createUser('cross-org');
    await grant(crossOrg.userId, tenant.roleId, 'organization', tenant.orgId);
    await grant(
      crossOrg.userId,
      await tenantRole(other.orgId, ['suppressions.read']),
      'organization',
      other.orgId,
    );
    userIds.crossOrg = crossOrg.userId;
    tokens.crossOrg = await login(crossOrg.email);

    const platform = await createUser('platform');
    await grant(
      platform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    tokens.platform = await login(platform.email);

    const reader = await createUser('reader');
    await grant(reader.userId, await platformRoleWith(['providers.read']), 'platform', null);
    tokens.reader = await login(reader.email);

    // A platform-grant holder without providers.read who ALSO holds a content
    // read at an organization: the platform path decides it, as before.
    const support = await createUser('support');
    await grant(
      support.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );
    await grant(
      support.userId,
      await tenantRole(tenant.orgId, ['suppressions.read']),
      'organization',
      tenant.orgId,
    );
    userIds.support = support.userId;
    tokens.support = await login(support.email);

    const reseller = await createUser('reseller');
    await grant(
      reseller.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      tenant.resellerId,
    );
    tokens.reseller = await login(reseller.email);

    // An organization API key carrying every admitting scope.
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const secret = `s${randomBytes(16).toString('hex')}`;
    const [key] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        name: `b2-${suffix()}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        scopes: [...TENANT_READ_PERMISSIONS],
        createdBy: tenant.userId,
      })
      .returning({ id: schema.apiKeys.id });
    apiKey = `${prefix}.${secret}`;
    apiKeyId = key!.id;

    channelIds = (await h.admin.select({ id: schema.channels.id }).from(schema.channels)).map(
      (r) => r.id,
    );
  }, 180_000);

  afterAll(async () => {
    try {
      await h.clearRateLimits();
      const list = (values: string[]) =>
        sql.join(
          values.map((v) => sql`${v}`),
          sql`, `,
        );
      await purgeAudit(
        h.admin,
        sql`actor_user_id IN (${list(createdUsers)}) OR actor_api_key_id = ${apiKeyId}`,
      );
      await h.admin.execute(sql`DELETE FROM api_keys WHERE id = ${apiKeyId}`);
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.provisioning','on',true)`);
        await tx.execute(
          sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
        await tx.execute(
          sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_reseller_admin_liveness`,
        );
        try {
          await tx.execute(sql`DELETE FROM user_roles WHERE user_id IN (${list(createdUsers)})`);
          await tx.execute(
            sql`DELETE FROM role_permissions WHERE role_id IN (${list(createdRoles)})`,
          );
          await tx.execute(sql`DELETE FROM roles WHERE id IN (${list(createdRoles)})`);
        } finally {
          await tx.execute(
            sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_reseller_admin_liveness`,
          );
          await tx.execute(
            sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
          );
        }
      });
      await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
      await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
      await destroyTenant(h.admin, tenant);
      await destroyTenant(h.admin, other);
    } finally {
      await appPool.end();
      await authPool.end();
      await relayPool.end();
      await h.close();
    }
  }, 180_000);

  // ===========================================================================
  describe('A. authorized tenant operators', () => {
    it.each(TENANT_READ_PERMISSIONS)(
      'a tenant operator holding only %s at its organization lists the catalogue — the same body a platform caller receives',
      async (permission) => {
        const platformBody = (await get(tokens.platform!, '/channels').expect(200)).body;
        const tenantBody = (await get(tokens[permission]!, '/channels', tenant.orgId).expect(200))
          .body;
        expect(tenantBody).toEqual(platformBody);
        expect(tenantBody.data.length).toBe(channelIds.length);
        expect(tenantBody.data.length).toBeGreaterThan(0);
      },
    );

    it('the single-organization operator is admitted without naming the organization', async () => {
      const r = await get(tokens['suppressions.read']!, '/channels').expect(200);
      expect(r.body.data.length).toBe(channelIds.length);
    });

    it('exposes only the six catalogue fields, nothing from providers, and pages exactly as the platform path', async () => {
      const first = (
        await get(tokens['messages.read']!, '/channels?limit=2', tenant.orgId).expect(200)
      ).body;
      for (const channel of first.data as ChannelBody[]) {
        expect(Object.keys(channel).sort()).toEqual(CATALOGUE_FIELDS);
      }
      expect(JSON.stringify(first)).not.toMatch(/adapter|credential|secret|provider/i);

      const platformFirst = (await get(tokens.platform!, '/channels?limit=2').expect(200)).body;
      expect(first).toEqual(platformFirst);
      expect(first.page.hasMore).toBe(true);
      const cursor = encodeURIComponent(first.page.nextCursor as string);
      const second = (
        await get(
          tokens['messages.read']!,
          `/channels?limit=2&cursor=${cursor}`,
          tenant.orgId,
        ).expect(200)
      ).body;
      const platformSecond = (
        await get(tokens.platform!, `/channels?limit=2&cursor=${cursor}`).expect(200)
      ).body;
      expect(second).toEqual(platformSecond);
      const seen = [...first.data, ...second.data].map((c: ChannelBody) => c.id);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('only the list is opened: one channel by id, the provider catalogue and every write stay platform-only', async () => {
      const token = tokens['suppressions.read']!;
      await get(token, `/channels/${channelIds[0]}`, tenant.orgId).expect(403);
      await get(token, '/providers', tenant.orgId).expect(403);
      await request(h.app.getHttpServer())
        .post(url('/providers'))
        .set('authorization', `Bearer ${token}`)
        .set('x-acc-organization', tenant.orgId)
        .send({ channelId: channelIds[0], name: `b2-${suffix()}`, adapterKey: 'simulator' })
        .expect(403);
    });
  });

  // ===========================================================================
  describe('B. refused callers — exactly the pre-existing refusal', () => {
    it('unauthenticated requests are 401', async () => {
      const r = await get(null, '/channels').expect(401);
      expect(r.body.data).toBeUndefined();
    });

    it('a tenant user holding no content read is 403, audited at its organization as a platform-scope attempt', async () => {
      const r = await get(tokens.plain!, '/channels', tenant.orgId).expect(403);
      expect(r.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      expect(r.body.data).toBeUndefined();
      const denied = await deniedAudits(userIds.plain!);
      expect(denied.at(-1)).toMatchObject({ scope_type: 'organization', scope_id: tenant.orgId });
      expect(denied.at(-1)!.metadata).toMatchObject({ attemptedScopeType: 'platform' });
    });

    it('tenant isolation: a content read held in another organization admits nothing in this one', async () => {
      await get(tokens.crossOrg!, '/channels', tenant.orgId).expect(403);
      // Naming the organization where it is held is the only way it counts.
      await get(tokens.crossOrg!, '/channels', other.orgId).expect(200);
    });

    it('a member of several organizations calling without one selected is refused as before (403, nothing audited)', async () => {
      const before = (await deniedAudits(userIds.crossOrg!)).length;
      const r = await get(tokens.crossOrg!, '/channels').expect(403);
      expect(r.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      expect((await deniedAudits(userIds.crossOrg!)).length).toBe(before);
    });

    it('a suspended organization admits no tenant read', async () => {
      await h.admin
        .update(schema.organizations)
        .set({ status: 'suspended' })
        .where(eq(schema.organizations.id, tenant.orgId));
      try {
        const r = await get(tokens['suppressions.read']!, '/channels', tenant.orgId);
        expect(r.status).toBe(403);
        expect(r.body.data).toBeUndefined();
      } finally {
        await h.admin
          .update(schema.organizations)
          .set({ status: 'active' })
          .where(eq(schema.organizations.id, tenant.orgId));
      }
    });

    it('a reseller administrator is 403', async () => {
      await get(tokens.reseller!, '/channels').expect(403);
      await get(tokens.reseller!, '/channels', tenant.orgId).expect(403);
    });

    it('an organization API key carrying every admitting scope is 403 (user sessions only)', async () => {
      const r = await get(apiKey, '/channels').expect(403);
      expect(r.body.data).toBeUndefined();
    });
  });

  // ===========================================================================
  describe('C. platform authorization is unchanged', () => {
    it('the platform administrator and a providers.read platform role list and read the catalogue', async () => {
      for (const token of [tokens.platform!, tokens.reader!]) {
        const list = await get(token, '/channels').expect(200);
        expect(list.body.data.length).toBe(channelIds.length);
        await get(token, `/channels/${channelIds[0]}`).expect(200);
      }
    });

    it('a platform-grant holder without providers.read stays refused, even holding suppressions.read at the organization it names', async () => {
      const r = await get(tokens.support!, '/channels', tenant.orgId).expect(403);
      expect(r.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      await get(tokens.support!, '/channels').expect(403);
    });

    it('no tenant role confers providers.read: the admitted operator holds no providers.* permission anywhere', async () => {
      const { rows } = await h.admin.execute<{ key: string }>(sql`
        SELECT DISTINCT p.key FROM user_roles ur
          JOIN role_permissions rp ON rp.role_id = ur.role_id
          JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = ${userIds['suppressions.read']!}`);
      expect(rows.map((r) => r.key)).toEqual(['suppressions.read']);
    });
  });

  // ===========================================================================
  describe('D. app_channel_catalogue() — the database boundary', () => {
    it('is STABLE SECURITY DEFINER, search_path pinned, no arguments, returning exactly the six catalogue columns', async () => {
      const { rows } = await h.admin.execute<Record<string, unknown>>(sql`
        SELECT p.prosecdef, p.proconfig, p.provolatile, p.pronargs, p.proretset,
               pg_get_function_result(p.oid) AS result, l.lanname
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname = 'public' AND p.proname = 'app_channel_catalogue'`);
      expect(rows).toEqual([
        {
          prosecdef: true,
          proconfig: ['search_path=public, pg_temp'],
          provolatile: 's',
          pronargs: 0,
          proretset: true,
          result:
            'TABLE(id uuid, code channel_code, display_name text, status channel_status, created_at timestamp with time zone, updated_at timestamp with time zone)',
          lanname: 'sql',
        },
      ]);
    });

    it('is owned by the catalogue table’s owner and executable by acc_app alone', async () => {
      const { rows } = await h.admin.execute<{ owner: string; acl: string; table_owner: string }>(
        sql`
        SELECT pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
               (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.channels'::regclass) AS table_owner
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'app_channel_catalogue'`,
      );
      const { owner, acl, table_owner } = rows[0]!;
      expect(owner).toBe(table_owner);
      expect(['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch']).not.toContain(owner);
      expect(acl).toBe(`{${owner}=X/${owner},acc_app=X/${owner}}`);
      const { rows: can } = await h.admin.execute<{ grantee: string; can: boolean }>(sql`
        SELECT g.grantee, has_function_privilege(g.grantee, 'public.app_channel_catalogue()', 'EXECUTE') AS can
          FROM (VALUES ('public'), ('acc_app'), ('acc_auth'), ('acc_relay'), ('acc_dispatch')) AS g(grantee)
         ORDER BY g.grantee`);
      expect(can.map((r) => `${r.grantee}:${r.can}`)).toEqual([
        'acc_app:true',
        'acc_auth:false',
        'acc_dispatch:false',
        'acc_relay:false',
        'public:false',
      ]);
    });

    it('opens no general bypass: a tenant acc_app session still reads no channel row directly, and no provider row at all', async () => {
      await asAppTenant(tenant.orgId, userIds['suppressions.read']!, async (c) => {
        expect((await c.query('SELECT count(*)::int n FROM channels')).rows[0].n).toBe(0);
        expect((await c.query('SELECT count(*)::int n FROM providers')).rows[0].n).toBe(0);
        const viaHelper = await c.query('SELECT * FROM app_channel_catalogue()');
        expect(viaHelper.rows.length).toBe(channelIds.length);
        expect(viaHelper.fields.map((f) => f.name)).toEqual([
          'id',
          'code',
          'display_name',
          'status',
          'created_at',
          'updated_at',
        ]);
        await expect(c.query(`UPDATE channels SET display_name = 'x'`)).rejects.toThrow(
          /permission denied/,
        );
      });
    });

    it('acc_auth and acc_relay cannot call it', async () => {
      for (const pool of [authPool, relayPool]) {
        await expect(pool.query('SELECT * FROM app_channel_catalogue()')).rejects.toThrow(
          /permission denied/,
        );
      }
    });
  });
});
