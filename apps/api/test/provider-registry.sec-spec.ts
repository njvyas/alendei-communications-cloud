/**
 * Phase 2.1 — channel and provider registry (ADR-013, ROADMAP §5b 2.1, Gate D.1).
 *
 * The catalogue is global: no row carries a tenant. The security model is
 * layered and names no role (ADR-013 F-3):
 *
 *   authenticated principal -> validated providers.* permission (AuthorizationService)
 *   -> platform-scope target -> RLS platform-scope eligibility (app_has_platform_scope())
 *
 * Every case drives real HTTP against the real database; the RLS cases open
 * `acc_app`, `acc_auth` and `acc_relay` connections directly, with the service
 * bypassed, so the database boundary is proven on its own.
 */
import { randomBytes } from 'node:crypto';

import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PLATFORM_ROLE_KEYS,
  PROVIDER_CAPABILITY_LIMITS,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
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

interface Person {
  userId: string;
  email: string;
}

interface ProviderBody {
  id: string;
  channelId: string;
  channelCode: string;
  name: string;
  adapterKey: string;
  status: string;
  healthState: string;
  circuitState: string;
  capabilities?: { key: string; value: unknown }[];
}

describe('Phase 2.1 provider and channel registry', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenant: TenantFixture;
  let appPool: Pool;
  let authPool: Pool;
  let relayPool: Pool;

  const people: Record<string, Person> = {};
  const tokens: Record<string, string> = {};
  const createdUsers: string[] = [];
  const createdRoles: string[] = [];
  let resellerId: string;
  let apiKey: string;
  let apiKeyId: string;
  let channels: Record<string, string> = {};

  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => uuidv7().replace(/-/g, '').slice(-10);
  const providerName = () => `prov-${suffix()}`;

  // --- fixtures ---------------------------------------------------------------

  async function createUser(label: string, status: 'active' | 'disabled' = 'active') {
    const email = `p21-${label}-${suffix()}@example.test`;
    const [u] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status,
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

  /**
   * A platform role that is **not** `alendei_super_admin`, holding exactly the
   * given permissions — the stand-in for "a future privileged platform role".
   * Created by the owner, as platform roles only ever are (D22).
   */
  async function testPlatformRole(permissionKeys: string[]): Promise<string> {
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: null,
          key: `test_catalogue_${suffix()}`,
          name: 'Test catalogue role',
          isSystemRole: false,
          allowedScopeTypes: ['platform'],
        })
        .returning({ id: schema.roles.id });
      createdRoles.push(role!.id);
      const perms = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(inArray(schema.permissions.key, permissionKeys));
      for (const p of perms) {
        await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId: p.id });
      }
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

  const call = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    credential: string | null,
    path: string,
    org?: string,
  ) => {
    let r = request(h.app.getHttpServer())[method](url(path));
    if (credential) r = r.set('authorization', `Bearer ${credential}`);
    return org ? r.set('x-acc-organization', org) : r;
  };

  const createProvider = async (name = providerName(), channel = 'sms') => {
    const res = await call('post', tokens.platform!, '/providers')
      .send({ channelId: channels[channel], name, adapterKey: 'simulator' })
      .expect(201);
    return res.body.data as ProviderBody;
  };

  const providerRow = async (id: string) =>
    (await h.admin.select().from(schema.providers).where(eq(schema.providers.id, id)))[0];

  const auditFor = async (providerId: string, action: string) =>
    (
      await h.admin.execute<Record<string, unknown>>(
        sql`SELECT * FROM audit_logs WHERE resource_id = ${providerId} AND action = ${action} ORDER BY id`,
      )
    ).rows;

  const counts = async () => {
    const [p] = (await h.admin.execute<{ n: number }>(sql`select count(*)::int n from providers`))
      .rows;
    const [c] = (
      await h.admin.execute<{ n: number }>(sql`select count(*)::int n from provider_capabilities`)
    ).rows;
    const [a] = (
      await h.admin.execute<{ n: number }>(
        sql`select count(*)::int n from audit_logs where action like 'provider.%'`,
      )
    ).rows;
    return { providers: p!.n, capabilities: c!.n, providerAudits: a!.n };
  };

  /** Runs `work` as a direct database principal under a transaction-local context, then rolls back. */
  async function asPrincipal<T>(
    pool: Pool,
    context: { userId?: string | null; isPlatformAdmin?: boolean; orgId?: string | null },
    work: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const [name, value] of [
        ['app.current_org_id', context.orgId ?? ''],
        ['app.current_workspace_id', ''],
        ['app.current_reseller_id', ''],
        ['app.current_user_id', context.userId ?? ''],
        ['app.is_platform_admin', context.isPlatformAdmin ? 'on' : 'off'],
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

  const pgError = async (op: Promise<unknown>): Promise<{ code?: string; message: string }> => {
    try {
      await op;
    } catch (error) {
      return error as { code?: string; message: string };
    }
    throw new Error('expected the database to refuse');
  };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    authPool = new Pool({ connectionString: process.env.DATABASE_AUTH_URL, max: 1 });
    relayPool = new Pool({ connectionString: process.env.DATABASE_RELAY_URL, max: 1 });

    tenant = await createTenant(h.admin, 'p21', credentials);
    resellerId = tenant.resellerId;

    people.platform = await createUser('platform');
    await grant(
      people.platform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    people.support = await createUser('support');
    await grant(
      people.support.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );
    people.reseller = await createUser('reseller');
    await grant(
      people.reseller.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerId,
    );
    people.reader = await createUser('reader');
    await grant(people.reader.userId, await testPlatformRole(['providers.read']), 'platform', null);
    people.disabledPlatform = await createUser('disabled-platform');
    await grant(
      people.disabledPlatform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    await h.admin
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, people.disabledPlatform.userId));

    // An organization API key requesting every providers.* scope, created by a
    // platform administrator who genuinely holds them — the strongest key there
    // can be. It must still be refused: a key is organization-bound.
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const secret = `s${randomBytes(16).toString('hex')}`;
    const [key] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        name: `p21-${suffix()}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        scopes: ['providers.read', 'providers.manage', 'providers.test_send'],
        createdBy: people.platform.userId,
      })
      .returning({ id: schema.apiKeys.id });
    apiKey = `${prefix}.${secret}`;
    apiKeyId = key!.id;

    for (const name of ['platform', 'support', 'reseller', 'reader'])
      tokens[name] = await login(people[name]!.email);
    tokens.orgAdmin = await login(tenant.email);

    const rows = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels);
    channels = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  }, 180_000);

  afterAll(async () => {
    await h.clearRateLimits();
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM provider_capabilities`);
    });
    const ids = (await h.admin.select({ id: schema.providers.id }).from(schema.providers)).map(
      (r) => r.id,
    );
    if (ids.length > 0) {
      await purgeAudit(
        h.admin,
        sql`resource_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
      await h.admin.delete(schema.providers).where(inArray(schema.providers.id, ids));
    }
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
      try {
        await tx.execute(sql`DELETE FROM user_roles WHERE user_id IN (${list(createdUsers)})`);
        if (createdRoles.length > 0) {
          await tx.execute(
            sql`DELETE FROM role_permissions WHERE role_id IN (${list(createdRoles)})`,
          );
          await tx.execute(sql`DELETE FROM roles WHERE id IN (${list(createdRoles)})`);
        }
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
    });
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await destroyTenant(h.admin, tenant);
    await appPool.end();
    await authPool.end();
    await relayPool.end();
    await h.close();
  }, 180_000);

  // ===========================================================================
  describe('A. channels (seeded, read-only)', () => {
    it('lists the five seeded channels in code order, paginated with the shared conventions', async () => {
      const all = await call('get', tokens.platform!, '/channels').expect(200);
      expect(all.body.data.map((c: { code: string }) => c.code)).toEqual([
        'whatsapp',
        'rcs',
        'sms',
        'email',
        'voice',
      ]);
      expect(all.body.page).toMatchObject({ limit: expect.any(Number), hasMore: false });
      // Two per page: 2 + 2 + 1, with no repeats and no gaps.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: request.Response = await call(
          'get',
          tokens.platform!,
          `/channels?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ).expect(200);
        seen.push(...page.body.data.map((c: { code: string }) => c.code));
        cursor = page.body.page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(['whatsapp', 'rcs', 'sms', 'email', 'voice']);
    });

    it('reads one channel; an unknown id is 404; there is no route that changes a channel', async () => {
      const res = await call('get', tokens.platform!, `/channels/${channels.sms}`).expect(200);
      expect(res.body.data).toMatchObject({ code: 'sms', displayName: 'SMS', status: 'active' });
      await call('get', tokens.platform!, `/channels/${uuidv7()}`).expect(404);
      for (const method of ['post', 'patch', 'put', 'delete'] as const) {
        const r = await call(method, tokens.platform!, `/channels/${channels.sms}`).send({});
        expect(`${method}:${r.status}`).toBe(`${method}:404`);
      }
      await call('post', tokens.platform!, '/channels').send({ code: 'fax' }).expect(404);
    });
  });

  // ===========================================================================
  describe('B. provider registry — the permitted operations', () => {
    it('creates a provider disabled, healthy and closed, with no capabilities, and audits it at platform scope', async () => {
      const name = providerName();
      const res = await call('post', tokens.platform!, '/providers')
        .send({ channelId: channels.whatsapp, name, adapterKey: 'simulator' })
        .expect(201);
      const body = res.body.data as ProviderBody;
      expect(body).toMatchObject({
        channelId: channels.whatsapp,
        channelCode: 'whatsapp',
        name,
        adapterKey: 'simulator',
        status: 'disabled',
        healthState: 'healthy',
        circuitState: 'closed',
        capabilities: [],
      });
      const [audit] = await auditFor(body.id, AUDIT_ACTIONS.PROVIDER_CREATED);
      expect(audit).toMatchObject({
        scope_type: 'platform',
        scope_id: null,
        org_id: null,
        actor_user_id: people.platform!.userId,
        resource_type: 'Provider',
        outcome: 'success',
        before: null,
      });
      expect((audit!.after as { name: string }).name).toBe(name);
    });

    it('reads a provider with its capabilities; lists with channel and status filters and keyset pagination', async () => {
      const a = await createProvider(undefined, 'rcs');
      const b = await createProvider(undefined, 'rcs');
      await call('post', tokens.platform!, `/providers/${b.id}/enable`).expect(200);

      const detail = await call('get', tokens.platform!, `/providers/${a.id}`).expect(200);
      expect(detail.body.data).toMatchObject({ id: a.id, capabilities: [] });

      const rcs = await call(
        'get',
        tokens.platform!,
        `/providers?channelId=${channels.rcs}`,
      ).expect(200);
      const ids = rcs.body.data.map((p: ProviderBody) => p.id);
      expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(rcs.body.data.every((p: ProviderBody) => p.channelCode === 'rcs')).toBe(true);

      const active = await call(
        'get',
        tokens.platform!,
        `/providers?channelId=${channels.rcs}&status=active`,
      ).expect(200);
      expect(active.body.data.map((p: ProviderBody) => p.id)).toEqual([b.id]);

      // Keyset pagination over the whole list, one per page, sorted by -createdAt.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: request.Response = await call(
          'get',
          tokens.platform!,
          `/providers?limit=1&sort=-createdAt${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ).expect(200);
        seen.push(...page.body.data.map((p: ProviderBody) => p.id));
        cursor = page.body.page.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(seen.indexOf(b.id)).toBeLessThan(seen.indexOf(a.id));

      await call('get', tokens.platform!, `/providers/${uuidv7()}`).expect(404);
      await call('get', tokens.platform!, '/providers?sort=status').expect(400);
    });

    it('renames a provider (audited before/after); an unchanged name records nothing; names are unique per channel, case-insensitively', async () => {
      const p = await createProvider(undefined, 'email');
      const renamed = `${p.name}-renamed`;
      await call('patch', tokens.platform!, `/providers/${p.id}`)
        .send({ name: renamed })
        .expect(200);
      const [audit] = await auditFor(p.id, AUDIT_ACTIONS.PROVIDER_UPDATED);
      expect(audit).toMatchObject({ before: { name: p.name }, after: { name: renamed } });

      await call('patch', tokens.platform!, `/providers/${p.id}`)
        .send({ name: renamed })
        .expect(200);
      await call('patch', tokens.platform!, `/providers/${p.id}`).send({}).expect(200);
      expect(await auditFor(p.id, AUDIT_ACTIONS.PROVIDER_UPDATED)).toHaveLength(1);

      // Natural idempotency of creation: a retried create is a 409, never a second row.
      const before = await counts();
      const dup = await call('post', tokens.platform!, '/providers')
        .send({ channelId: channels.email, name: renamed.toUpperCase(), adapterKey: 'simulator' })
        .expect(409);
      expect(dup.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
      expect(await counts()).toEqual(before);
      // The same name on another channel is a different provider.
      await call('post', tokens.platform!, '/providers')
        .send({ channelId: channels.voice, name: renamed, adapterKey: 'simulator' })
        .expect(201);

      const other = await createProvider(undefined, 'email');
      await call('patch', tokens.platform!, `/providers/${other.id}`)
        .send({ name: renamed })
        .expect(409);
      expect((await providerRow(other.id))!.name).toBe(other.name);
    });

    it('replaces the capability set as a whole, naturally idempotently, and audits each real change', async () => {
      const p = await createProvider();
      const set = [
        { key: 'max_message_size', value: 1600 },
        { key: 'media_support', value: { image: true, video: false } },
      ];
      const res = await call('put', tokens.platform!, `/providers/${p.id}/capabilities`)
        .send({ capabilities: set })
        .expect(200);
      expect(res.body.data.capabilities).toEqual(set);
      expect(await auditFor(p.id, AUDIT_ACTIONS.PROVIDER_CAPABILITIES_REPLACED)).toHaveLength(1);

      // Same set (keys reordered, object keys reordered): no write, no audit.
      await call('put', tokens.platform!, `/providers/${p.id}/capabilities`)
        .send({
          capabilities: [
            { key: 'media_support', value: { video: false, image: true } },
            { key: 'max_message_size', value: 1600 },
          ],
        })
        .expect(200);
      expect(await auditFor(p.id, AUDIT_ACTIONS.PROVIDER_CAPABILITIES_REPLACED)).toHaveLength(1);

      const cleared = await call('put', tokens.platform!, `/providers/${p.id}/capabilities`)
        .send({ capabilities: [] })
        .expect(200);
      expect(cleared.body.data.capabilities).toEqual([]);
      const audits = await auditFor(p.id, AUDIT_ACTIONS.PROVIDER_CAPABILITIES_REPLACED);
      expect(audits).toHaveLength(2);
      expect(audits[1]).toMatchObject({ after: { capabilities: [] } });
    });

    it('walks the exact status-transition matrix; each legal step is audited, each illegal one is 409 and changes nothing', async () => {
      const p = await createProvider();
      const go = (action: string) => call('post', tokens.platform!, `/providers/${p.id}/${action}`);
      const refused = async (action: string, status: string) => {
        const before = await counts();
        const r = await go(action).expect(409);
        expect(r.body.error).toMatchObject({
          code: ERROR_CODES.PROVIDER_LIFECYCLE_CONFLICT,
          details: { status },
        });
        expect((await providerRow(p.id))!.status).toBe(status);
        expect(await counts()).toEqual(before);
      };
      // disabled
      await refused('disable', 'disabled');
      await refused('drain', 'disabled');
      expect((await go('enable').expect(200)).body.data.status).toBe('active');
      // active
      await refused('enable', 'active');
      expect((await go('drain').expect(200)).body.data.status).toBe('draining');
      // draining
      await refused('drain', 'draining');
      expect((await go('enable').expect(200)).body.data.status).toBe('active');
      expect((await go('drain').expect(200)).body.data.status).toBe('draining');
      expect((await go('disable').expect(200)).body.data.status).toBe('disabled');
      expect((await go('enable').expect(200)).body.data.status).toBe('active');
      expect((await go('disable').expect(200)).body.data.status).toBe('disabled');

      const steps = (
        await h.admin.execute<{ action: string; before: unknown; after: unknown }>(
          sql`select action, before, after from audit_logs where resource_id = ${p.id} and action <> ${AUDIT_ACTIONS.PROVIDER_CREATED} order by id`,
        )
      ).rows.map((r) => `${r.action}:${JSON.stringify(r.before)}->${JSON.stringify(r.after)}`);
      expect(steps).toEqual([
        'provider.enabled:{"status":"disabled"}->{"status":"active"}',
        'provider.drained:{"status":"active"}->{"status":"draining"}',
        'provider.enabled:{"status":"draining"}->{"status":"active"}',
        'provider.drained:{"status":"active"}->{"status":"draining"}',
        'provider.disabled:{"status":"draining"}->{"status":"disabled"}',
        'provider.enabled:{"status":"disabled"}->{"status":"active"}',
        'provider.disabled:{"status":"active"}->{"status":"disabled"}',
      ]);
      await call('post', tokens.platform!, `/providers/${uuidv7()}/enable`).expect(404);
    });

    it('two concurrent transitions serialize: exactly one succeeds', async () => {
      const p = await createProvider();
      const results = await Promise.all([
        call('post', tokens.platform!, `/providers/${p.id}/enable`),
        call('post', tokens.platform!, `/providers/${p.id}/enable`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await auditFor(p.id, AUDIT_ACTIONS.PROVIDER_ENABLED)).toHaveLength(1);
    });
  });

  // ===========================================================================
  describe('C. input validation — nothing outside the frozen 2.1 surface can be set', () => {
    it('an unregistered adapter is 422 with the registered keys; a malformed one or an unknown channel creates nothing', async () => {
      const before = await counts();
      const unknown = await call('post', tokens.platform!, '/providers')
        .send({ channelId: channels.sms, name: providerName(), adapterKey: 'acme_sms' })
        .expect(422);
      expect(unknown.body.error).toMatchObject({
        code: ERROR_CODES.PROVIDER_ADAPTER_UNKNOWN,
        details: { adapterKeys: ['simulator'] },
      });
      await call('post', tokens.platform!, '/providers')
        .send({ channelId: channels.sms, name: providerName(), adapterKey: 'Acme SMS' })
        .expect(400);
      await call('post', tokens.platform!, '/providers')
        .send({ channelId: uuidv7(), name: providerName(), adapterKey: 'simulator' })
        .expect(404);
      await call('post', tokens.platform!, '/providers')
        .send({ channelId: channels.sms, name: ' padded ', adapterKey: 'simulator' })
        .expect(400);
      expect(await counts()).toEqual(before);
    });

    it('status, health, circuit, credential and tenant fields are refused, not ignored', async () => {
      const before = await counts();
      for (const extra of [
        { status: 'active' },
        { healthState: 'offline' },
        { circuitState: 'open' },
        { credentialRef: 'env:SECRET' },
        { secret: 'x' },
        { orgId: tenant.orgId },
        { workspaceId: tenant.workspaceId },
        { teamId: tenant.teamId },
        { priority: 1 },
        { weight: 50 },
      ]) {
        const r = await call('post', tokens.platform!, '/providers').send({
          channelId: channels.sms,
          name: providerName(),
          adapterKey: 'simulator',
          ...extra,
        });
        expect(`${Object.keys(extra)[0]}:${r.status}`).toBe(`${Object.keys(extra)[0]}:400`);
        expect(r.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      }
      const p = await createProvider();
      for (const extra of [
        { status: 'active' },
        { adapterKey: 'simulator' },
        { channelId: channels.rcs },
      ]) {
        await call('patch', tokens.platform!, `/providers/${p.id}`).send(extra).expect(400);
      }
      await call('get', tokens.platform!, `/providers?orgId=${tenant.orgId}`).expect(400);
      await call('get', tokens.platform!, `/channels?workspaceId=${tenant.workspaceId}`).expect(
        400,
      );
      expect((await counts()).providers).toBe(before.providers + 1);
    });

    it('capability sets: secret-named keys, duplicates, oversized values and too many entries are refused, and nothing is written', async () => {
      const p = await createProvider();
      const before = await counts();
      const put = (capabilities: unknown) =>
        call('put', tokens.platform!, `/providers/${p.id}/capabilities`).send({ capabilities });
      for (const key of [
        'api_token',
        'client_secret',
        'password_hint',
        'auth_credential',
        'apikey',
      ]) {
        const r = await put([{ key, value: 'x' }]).expect(400);
        expect(JSON.stringify(r.body.error.details)).toContain('SECRET_KEY_FORBIDDEN');
      }
      const dup = await put([
        { key: 'media_support', value: true },
        { key: 'media_support', value: false },
      ]).expect(400);
      expect(JSON.stringify(dup.body.error.details)).toContain('DUPLICATE_KEY');
      const big = await put([
        { key: 'blob', value: 'x'.repeat(PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES) },
      ]).expect(400);
      expect(JSON.stringify(big.body.error.details)).toContain('VALUE_TOO_LARGE');
      await put(
        Array.from({ length: PROVIDER_CAPABILITY_LIMITS.MAX_ENTRIES + 1 }, (_, i) => ({
          key: `cap_${i}`,
          value: i,
        })),
      ).expect(400);
      await put([{ key: 'Bad-Key', value: 1 }]).expect(400);
      expect(await counts()).toEqual(before);
    });

    it('there is no provider deletion', async () => {
      const p = await createProvider();
      await call('delete', tokens.platform!, `/providers/${p.id}`).expect(404);
      expect(await providerRow(p.id)).toBeDefined();
    });
  });

  // ===========================================================================
  describe('D. authorization — only platform-scope providers.* holders', () => {
    const routes = (id: string, channelId: string) =>
      [
        ['get', '/channels', undefined],
        ['get', `/channels/${channelId}`, undefined],
        ['get', '/providers', undefined],
        ['get', `/providers/${id}`, undefined],
        ['post', '/providers', { channelId, name: providerName(), adapterKey: 'simulator' }],
        ['patch', `/providers/${id}`, { name: providerName() }],
        ['put', `/providers/${id}/capabilities`, { capabilities: [{ key: 'x_cap', value: 1 }] }],
        ['post', `/providers/${id}/enable`, undefined],
        ['post', `/providers/${id}/disable`, undefined],
        ['post', `/providers/${id}/drain`, undefined],
      ] as const;

    async function expectRefusedEverywhere(
      credential: string | null,
      expected: number,
      org?: string,
    ) {
      const p = await createProvider();
      const rowBefore = await providerRow(p.id);
      const before = await counts();
      const observed: string[] = [];
      for (const [method, path, body] of routes(p.id, channels.sms!)) {
        const r = await call(method, credential, path, org).send(body ?? {});
        observed.push(`${method} ${path}:${r.status}`);
        expect(JSON.stringify(r.body)).not.toContain(p.name);
      }
      // The database first: whatever the responses were, nothing may have changed.
      expect(await counts()).toEqual(before);
      expect(await providerRow(p.id)).toEqual(rowBefore);
      expect(observed).toEqual(
        routes(p.id, channels.sms!).map(([method, path]) => `${method} ${path}:${expected}`),
      );
    }

    it('unauthenticated requests are 401 on every route', async () => {
      await expectRefusedEverywhere(null, 401);
    });

    it('an organization administrator is 403 on every route, and the refusal is audited at its own organization', async () => {
      await expectRefusedEverywhere(tokens.orgAdmin!, 403);
      const denied = (
        await h.admin.execute<Record<string, unknown>>(
          sql`select scope_type, scope_id, metadata from audit_logs where action = ${AUDIT_ACTIONS.AUTHORIZATION_DENIED} and actor_user_id = ${tenant.userId} order by id`,
        )
      ).rows;
      expect(denied.length).toBeGreaterThanOrEqual(10);
      expect(denied.at(-1)).toMatchObject({ scope_type: 'organization', scope_id: tenant.orgId });
      expect(denied.at(-1)!.metadata).toMatchObject({ attemptedScopeType: 'platform' });
    });

    it('a client-supplied organization cannot broaden anything: the organization administrator naming its own organization is still 403', async () => {
      await expectRefusedEverywhere(tokens.orgAdmin!, 403, tenant.orgId);
    });

    it('a tenant role carrying providers.manage at the organization does not reach the platform catalogue', async () => {
      // A super administrator could compose such a role (`providers.*` is not in
      // the `platform.` domain); it confers nothing here, because the decision is
      // made at platform scope and RLS admits only platform-scope principals.
      const user = await createUser('tenant-provider-role');
      const roleId = await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.provisioning','on',true)`);
        const [role] = await tx
          .insert(schema.roles)
          .values({
            orgId: tenant.orgId,
            key: `tenant_providers_${suffix()}`,
            name: 'Tenant providers role',
            isSystemRole: false,
            allowedScopeTypes: ['organization'],
          })
          .returning({ id: schema.roles.id });
        createdRoles.push(role!.id);
        const perms = await tx
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(inArray(schema.permissions.key, ['providers.read', 'providers.manage']));
        for (const p of perms)
          await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId: p.id });
        return role!.id;
      });
      await h.admin
        .insert(schema.userRoles)
        .values({ userId: user.userId, roleId, scopeType: 'organization', scopeId: tenant.orgId });
      await expectRefusedEverywhere(await login(user.email), 403);
      await asPrincipal(appPool, { userId: user.userId, orgId: tenant.orgId }, async (c) => {
        expect((await c.query('select count(*)::int n from providers')).rows[0].n).toBe(0);
      });
    });

    it('a reseller administrator is 403 on every route', async () => {
      await expectRefusedEverywhere(tokens.reseller!, 403);
    });

    it('alendei_support — RLS-eligible through its platform grant — is refused by authorization on every route', async () => {
      await expectRefusedEverywhere(tokens.support!, 403);
      // And it is RLS-eligible: the separation is the permission layer, by design.
      await asPrincipal(appPool, { userId: people.support!.userId }, async (c) => {
        const { rows } = await c.query('select app_has_platform_scope() as eligible');
        expect(rows[0].eligible).toBe(true);
      });
    });

    it('an API key — even one requesting every providers.* scope, created by a platform administrator — is 403 on every route', async () => {
      await expectRefusedEverywhere(apiKey, 403);
    });

    it('a platform role that is not alendei_super_admin, granted providers.read, reads the catalogue with no policy change — and cannot write', async () => {
      const list = await call('get', tokens.reader!, '/providers').expect(200);
      expect(Array.isArray(list.body.data)).toBe(true);
      await call('get', tokens.reader!, '/channels').expect(200);
      await call('post', tokens.reader!, '/providers')
        .send({ channelId: channels.sms, name: providerName(), adapterKey: 'simulator' })
        .expect(403);
    });
  });

  // ===========================================================================
  describe('E. the database boundary, with the service bypassed', () => {
    it('acc_app without a validated platform-scope claim sees no row and cannot write — whatever else the transaction claims', async () => {
      const p = await createProvider();
      for (const ctx of [
        { userId: tenant.userId, orgId: tenant.orgId },
        { userId: null },
        // A forged administrator flag is not a platform-scope grant.
        { userId: tenant.userId, isPlatformAdmin: true },
        // A disabled identity's grants confer nothing.
        { userId: people.disabledPlatform!.userId, isPlatformAdmin: true },
      ]) {
        await asPrincipal(appPool, ctx, async (c) => {
          for (const table of ['channels', 'providers', 'provider_capabilities']) {
            const { rows } = await c.query(`select count(*)::int n from ${table}`);
            expect(`${JSON.stringify(ctx)} ${table}:${rows[0].n}`).toBe(
              `${JSON.stringify(ctx)} ${table}:0`,
            );
          }
          const upd = await c.query(`update providers set name = 'hijacked' where id = $1`, [p.id]);
          expect(upd.rowCount).toBe(0);
          await c.query('SAVEPOINT s');
          const err = await pgError(
            c.query(
              `insert into providers (channel_id, name, adapter_key) values ($1, 'forged', 'simulator')`,
              [channels.sms],
            ),
          );
          expect(err.code).toBe('42501');
          await c.query('ROLLBACK TO SAVEPOINT s');
        });
      }
      expect((await providerRow(p.id))!.name).toBe(p.name);
    });

    it('a validated platform-scope user is RLS-eligible regardless of role name; the grants still forbid DELETE on providers and any write to channels', async () => {
      for (const userId of [people.platform!.userId, people.reader!.userId]) {
        await asPrincipal(appPool, { userId }, async (c) => {
          const { rows } = await c.query('select count(*)::int n from channels');
          expect(rows[0].n).toBe(5);
          await c.query('SAVEPOINT s');
          expect((await pgError(c.query('delete from providers'))).code).toBe('42501');
          await c.query('ROLLBACK TO SAVEPOINT s');
          expect((await pgError(c.query(`update channels set display_name = 'x'`))).code).toBe(
            '42501',
          );
        });
      }
    });

    it('acc_auth and acc_relay hold no grant on any catalogue table, and cannot call the eligibility function', async () => {
      for (const pool of [authPool, relayPool]) {
        for (const table of ['channels', 'providers', 'provider_capabilities']) {
          await asPrincipal(pool, {}, async (c) => {
            expect((await pgError(c.query(`select 1 from ${table} limit 1`))).code).toBe('42501');
          });
        }
        await asPrincipal(pool, {}, async (c) => {
          expect((await pgError(c.query('select app_has_platform_scope()'))).code).toBe('42501');
        });
      }
    });

    it('the RLS predicate names no role and no permission', async () => {
      const { rows: policies } = await h.admin.execute<{
        tablename: string;
        roles: string;
        qual: string | null;
        with_check: string | null;
      }>(
        sql`select tablename, roles::text, qual, with_check from pg_policies where tablename in ('channels','providers','provider_capabilities') order by tablename, policyname`,
      );
      expect(policies).toHaveLength(3);
      for (const p of policies) {
        expect(p.roles).toBe('{acc_app}');
        for (const expr of [p.qual, p.with_check].filter(Boolean)) {
          expect(expr).toBe('app_has_platform_scope()');
        }
      }
      const { rows: fn } = await h.admin.execute<{ src: string; acl: string; secdef: boolean }>(
        sql`select prosrc as src, proacl::text as acl, prosecdef as secdef from pg_proc where proname = 'app_has_platform_scope'`,
      );
      expect(fn[0]!.secdef).toBe(true);
      expect(fn[0]!.acl).toBe('{postgres=X/postgres,acc_app=X/postgres}');
      expect(fn[0]!.src).toContain("ur.scope_type = 'platform'");
      for (const forbidden of ['alendei_super_admin', 'alendei_support', 'r.key', 'permission'])
        expect(fn[0]!.src).not.toContain(forbidden);
    });

    it('no catalogue table can hold a credential, and provider_credentials does not exist', async () => {
      const { rows } = await h.admin.execute<{ table_name: string; column_name: string }>(
        sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('channels','providers','provider_capabilities')`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.column_name).not.toMatch(
          /secret|password|passwd|token|credential|api_?key|private/,
        );
      }
      const { rows: t } = await h.admin.execute<{ n: number }>(
        sql`select count(*)::int n from information_schema.tables where table_name = 'provider_credentials'`,
      );
      expect(t[0]!.n).toBe(0);
    });
  });
});
