/**
 * Phase 2.4 — hot reload: runtime configuration convergence across running
 * instances (`PROVIDER_ADAPTER.md` §3a, ADR-013 "2.4 design", Gate D.4).
 *
 * Two real application instances (A and B) share one disposable database,
 * each with its own injected provider clock, so `R` and `T` are crossed to the
 * millisecond on B alone. A notification is "delivered" when B's cache has
 * marked itself dirty — waited for as a condition, never a sleep. Notification
 * loss is simulated by suppressing B's hints; restart by closing B and starting
 * a fresh instance; LISTEN loss by terminating the listener's backend.
 *
 * Hot reload is advisory: every case that matters for correctness also shows
 * the authoritative path (lifecycle, circuit admission) reading PostgreSQL.
 */
import { randomBytes } from 'node:crypto';

import {
  ERROR_CODES,
  PLATFORM_ROLE_KEYS,
  PROVIDER_CIRCUIT_DEFAULTS as SEEDED,
  PROVIDER_CIRCUIT_POLICY_FIELDS,
  PROVIDER_CONFIGURATION_CACHE as C,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';

import { CredentialService } from '../src/iam/credential.service';
import { MetricsService } from '../src/observability/metrics.service';
import { ProviderConfigurationCache } from '../src/providers/provider-configuration.cache';
import { ProviderConfigurationListener } from '../src/providers/provider-configuration.listener';
import { circuitPolicyOf } from '../src/providers/provider-views';
import {
  ManualProviderClock,
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  purgeProviderHealth,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

jest.setTimeout(90_000);

interface Person {
  userId: string;
  email: string;
}

describe('Phase 2.4 hot reload — configuration convergence across instances', () => {
  let a: Harness;
  let b: Harness;
  const clockA = new ManualProviderClock();
  const clockB = new ManualProviderClock();
  let credentials: CredentialService;
  let tenant: TenantFixture;
  let appPool: Pool;
  let authPool: Pool;
  let relayPool: Pool;
  let ownerPool: Pool;
  const people: Record<string, Person> = {};
  const tokens: Record<string, string> = {};
  const createdUsers: string[] = [];
  const createdRoles: string[] = [];
  const createdProviders: string[] = [];
  let sms: string;
  let apiKeyId: string;
  const restore: (() => Promise<unknown> | unknown)[] = [];

  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => randomBytes(5).toString('hex');
  const list = (values: string[]) =>
    sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    );

  // --- instances --------------------------------------------------------------

  async function startInstance(clock: ManualProviderClock) {
    const h = await startHarness({ providerClock: clock });
    await new Promise<void>((resolve) => h.app.getHttpServer().listen(0, resolve));
    // Wait until it listens, so a test never races its own startup.
    await until(() => h.app.get(ProviderConfigurationListener).isConnected(), 'LISTEN connection');
    return h;
  }
  const cacheOf = (h: Harness) => h.app.get(ProviderConfigurationCache);

  const call = (
    h: Harness,
    method: 'get' | 'post' | 'put',
    who: string | null,
    path: string,
    body?: object,
    org?: string,
  ) => {
    let r = request(h.app.getHttpServer())[method](url(path));
    if (who && tokens[who]) r = r.set('authorization', `Bearer ${tokens[who]}`);
    if (org) r = r.set('x-acc-organization', org);
    return body === undefined ? r : r.send(body);
  };
  /** The advisory read: lifecycle-active provider ids of the SMS channel, as instance `h` serves them. */
  async function candidates(h: Harness, who = 'reader') {
    const res = await call(h, 'get', who, `/channels/${sms}/routing-candidates`).expect(200);
    return res.body.data as {
      configurationRevision: number;
      circuitPolicyVersion: number;
      advisory: true;
      providers: { providerId: string; name: string; adapterKey: string }[];
    };
  }
  const lists = async (h: Harness, id: string) =>
    (await candidates(h)).providers.some((p) => p.providerId === id);
  const nameOn = async (h: Harness, id: string) =>
    (await candidates(h)).providers.find((p) => p.providerId === id)?.name;

  /** Waits until B's cache has received a notification newer than what it serves. */
  const delivered = (h: Harness) => until(() => cacheOf(h).isDirty(), 'a notification');

  /** Simulates total notification loss on an instance. */
  function suppressNotifications(h: Harness) {
    const cache = cacheOf(h);
    jest.spyOn(cache, 'hint').mockImplementation(() => 'duplicate');
  }

  async function metric(h: Harness, name: string, labels: Record<string, string> = {}) {
    const line = (await h.app.get(MetricsService).scrape())
      .split('\n')
      .find(
        (l) =>
          (l.startsWith(`${name}{`) || l.startsWith(`${name} `)) &&
          Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)),
      );
    return line ? Number(line.split(' ').at(-1)) : 0;
  }

  async function until(condition: () => boolean, what: string) {
    const deadline = Date.now() + 20_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // --- fixtures ---------------------------------------------------------------

  async function createUser(label: string) {
    const email = `hr-${label}-${suffix()}@example.test`;
    const [u] = await a.admin
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
  async function grant(userId: string, roleId: string, scopeType: string, scopeId: string | null) {
    await a.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId,
        roleId,
        scopeType: scopeType as 'platform',
        scopeId,
      });
    });
  }
  async function platformRole(key: string) {
    const [r] = await a.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, key), isNull(schema.roles.orgId)));
    return r!.id;
  }
  async function testRole(keys: string[], orgId: string | null) {
    return a.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId,
          key: `test_hr_${suffix()}`,
          name: 'Test hot-reload role',
          isSystemRole: false,
          allowedScopeTypes: [orgId ? 'organization' : 'platform'],
        })
        .returning({ id: schema.roles.id });
      createdRoles.push(role!.id);
      const perms = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(inArray(schema.permissions.key, keys));
      for (const p of perms)
        await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId: p.id });
      return role!.id;
    });
  }
  async function login(email: string) {
    await a.clearRateLimits();
    return (
      await request(a.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken as string;
  }

  /** A provider created through instance A's API, then enabled — so the change is announced. */
  async function createProvider(): Promise<string> {
    const res = await call(a, 'post', 'manager', '/providers', {
      channelId: sms,
      name: `hr-${suffix()}`,
      adapterKey: 'simulator',
    }).expect(201);
    const id = res.body.data.id as string;
    createdProviders.push(id);
    await call(a, 'post', 'manager', `/providers/${id}/enable`).expect(200);
    return id;
  }
  const transition = (
    h: Harness,
    id: string,
    to: 'enable' | 'disable' | 'drain',
    who = 'manager',
  ) => call(h, 'post', who, `/providers/${id}/${to}`);

  async function storedPolicy() {
    return (await a.admin.select().from(schema.providerCircuitPolicy))[0]!;
  }
  async function restoreSeededPolicy() {
    const current = await storedPolicy();
    if (PROVIDER_CIRCUIT_POLICY_FIELDS.every((f) => current[f] === SEEDED[f])) return;
    await a.admin
      .update(schema.providerCircuitPolicy)
      .set({ ...SEEDED, version: current.version + 1 })
      .where(eq(schema.providerCircuitPolicy.scope, 'platform'));
  }
  const revision = async () =>
    (await a.admin.select().from(schema.providerConfigurationRevision))[0]!.revision;

  async function asPrincipal<T>(
    pool: Pool,
    userId: string | null,
    work: (c: PoolClient) => Promise<T>,
    flag = false,
  ): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const [name, value] of [
        ['app.current_org_id', ''],
        ['app.current_workspace_id', ''],
        ['app.current_reseller_id', ''],
        ['app.current_user_id', userId ?? ''],
        ['app.is_platform_admin', flag ? 'on' : 'off'],
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
  async function attempt(c: PoolClient, text: string) {
    await c.query('SAVEPOINT s');
    try {
      const res = await c.query(text);
      return res.rowCount === 0 && /^\s*(update|delete)/i.test(text) ? 'none' : 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? 'error';
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT s');
    }
  }

  beforeAll(async () => {
    a = await startInstance(clockA);
    b = await startInstance(clockB);
    credentials = a.app.get(CredentialService);
    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    authPool = new Pool({ connectionString: process.env.DATABASE_AUTH_URL, max: 1 });
    relayPool = new Pool({ connectionString: process.env.DATABASE_RELAY_URL, max: 1 });
    ownerPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
    tenant = await createTenant(a.admin, 'hr', credentials);
    await restoreSeededPolicy();

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
      tenant.resellerId,
    );
    people.manager = await createUser('manager');
    await grant(
      people.manager.userId,
      await testRole(['providers.read', 'providers.manage'], null),
      'platform',
      null,
    );
    people.tester = await createUser('tester');
    await grant(
      people.tester.userId,
      await testRole(['providers.read', 'providers.test_send'], null),
      'platform',
      null,
    );
    people.reader = await createUser('reader');
    await grant(people.reader.userId, await testRole(['providers.read'], null), 'platform', null);
    people.tenantComposed = await createUser('tenant-composed');
    await grant(
      people.tenantComposed.userId,
      await testRole(['providers.read', 'providers.manage', 'providers.test_send'], tenant.orgId),
      'organization',
      tenant.orgId,
    );
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const secret = `s${randomBytes(16).toString('hex')}`;
    const [key] = await a.admin
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        name: `hr-${suffix()}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        scopes: ['providers.read', 'providers.manage', 'providers.test_send'],
        createdBy: people.platform.userId,
      })
      .returning({ id: schema.apiKeys.id });
    tokens.apiKey = `${prefix}.${secret}`;
    apiKeyId = key!.id;
    for (const name of Object.keys(people)) tokens[name] = await login(people[name]!.email);
    tokens.orgAdmin = await login(tenant.email);
    const [channel] = await a.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'sms'));
    sms = channel!.id;
  }, 180_000);

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const undo of restore.splice(0).reverse()) await undo();
    await restoreSeededPolicy();
  });

  afterAll(async () => {
    await restoreSeededPolicy();
    await a.clearRateLimits();
    if (createdProviders.length > 0) {
      await purgeAudit(a.admin, sql`resource_id IN (${list(createdProviders)})`);
      await purgeProviderHealth(a.admin, sql`provider_id IN (${list(createdProviders)})`);
      await a.admin.execute(
        sql`DELETE FROM provider_capabilities WHERE provider_id IN (${list(createdProviders)})`,
      );
      await a.admin.execute(sql`DELETE FROM providers WHERE id IN (${list(createdProviders)})`);
    }
    await purgeAudit(a.admin, sql`action = 'provider.circuit_policy_updated'`);
    await purgeAudit(
      a.admin,
      sql`actor_user_id IN (${list(createdUsers)}) OR actor_api_key_id = ${apiKeyId}`,
    );
    await a.admin.execute(sql`DELETE FROM api_keys WHERE id = ${apiKeyId}`);
    await a.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        await tx.execute(sql`DELETE FROM user_roles WHERE user_id IN (${list(createdUsers)})`);
        await tx.execute(
          sql`DELETE FROM role_permissions WHERE role_id IN (${list(createdRoles)})`,
        );
        await tx.execute(sql`DELETE FROM roles WHERE id IN (${list(createdRoles)})`);
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
    });
    await a.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await a.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await destroyTenant(a.admin, tenant);
    await Promise.all([appPool.end(), authPool.end(), relayPool.end(), ownerPool.end()]);
    await b.close();
    await a.close();
  }, 180_000);

  // ===========================================================================
  describe('A. changes through A converge on B without restart', () => {
    it('enable, drain, enable, disable: each reaches B’s advisory read through the notification, before R on B’s clock', async () => {
      const id = await createProvider();
      await delivered(b);
      expect(await lists(b, id)).toBe(true);
      for (const [to, expected] of [
        ['drain', false],
        ['enable', true],
        ['disable', false],
        ['enable', true],
      ] as const) {
        const before = await revision();
        await transition(a, id, to).expect(200);
        expect(await revision()).toBeGreaterThan(before);
        await delivered(b);
        expect(`${to} → ${await lists(b, id)}`).toBe(`${to} → ${expected}`);
      }
      // B's clock never moved: this was the notification path, not reconciliation.
      expect(await metric(b, 'acc_provider_config_reloads_total', { operation: 'reconcile' })).toBe(
        0,
      );
    });

    it('a rename, a capability change and a circuit-policy change converge on B the same way', async () => {
      const id = await createProvider();
      await delivered(b);
      await candidates(b);
      const name = `hr-renamed-${suffix()}`;
      await request(a.app.getHttpServer())
        .patch(url(`/providers/${id}`))
        .set('authorization', `Bearer ${tokens.manager}`)
        .send({ name })
        .expect(200);
      await delivered(b);
      expect(await nameOn(b, id)).toBe(name);

      await request(a.app.getHttpServer())
        .put(url(`/providers/${id}/capabilities`))
        .set('authorization', `Bearer ${tokens.manager}`)
        .send({ capabilities: [{ key: 'max_message_size', value: 1600 }] })
        .expect(200);
      await delivered(b);
      await candidates(b);
      expect(
        cacheOf(b)
          .peek()!
          .providers.find((p) => p.id === id)!.capabilities,
      ).toEqual({
        max_message_size: 1600,
      });

      const policy = await storedPolicy();
      await call(a, 'put', 'manager', '/provider-circuit-policy', {
        ...circuitPolicyOf(policy),
        cooldownMs: 12_000,
        expectedVersion: policy.version,
      }).expect(200);
      await delivered(b);
      const after = await candidates(b);
      expect(after.circuitPolicyVersion).toBe(policy.version + 1);
      expect(cacheOf(b).peek()!.circuitPolicy.cooldownMs).toBe(12_000);
    });

    it('read-your-writes on the instance that made the change, even with its own notification lost', async () => {
      const id = await createProvider();
      await candidates(a);
      suppressNotifications(a);
      await transition(a, id, 'disable').expect(200);
      expect(await lists(a, id)).toBe(false); // local invalidation, not the notification
      expect(
        await metric(a, 'acc_provider_config_local_invalidations_total', { operation: 'disable' }),
      ).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  describe('B. the convergence bound, on B’s injected clock', () => {
    it('notifications lost: B serves the old configuration until R and the new one on its first read at R — never later', async () => {
      const id = await createProvider();
      await delivered(b);
      await candidates(b); // B installs the current revision; its R timer starts now
      suppressNotifications(b);
      await transition(a, id, 'disable').expect(200);
      clockB.advance(C.RECONCILE_MS - 1);
      expect(await lists(b, id)).toBe(true); // stale, within the bound
      clockB.advance(1);
      expect(await lists(b, id)).toBe(false); // exactly R: reconciled
      expect(
        await metric(b, 'acc_provider_config_reloads_total', {
          operation: 'reconcile',
          outcome: 'success',
        }),
      ).toBeGreaterThan(0);
    });

    it('revision signal disabled: B serves the new configuration on its first read at T — never later (hard TTL)', async () => {
      const id = await createProvider();
      await delivered(b);
      await candidates(b);
      suppressNotifications(b);
      await a.admin.execute(
        sql`ALTER TABLE providers DISABLE TRIGGER trg_providers_configuration_updated`,
      );
      restore.push(() =>
        a.admin.execute(
          sql`ALTER TABLE providers ENABLE TRIGGER trg_providers_configuration_updated`,
        ),
      );
      const before = await revision();
      await transition(a, id, 'disable').expect(200);
      expect(await revision()).toBe(before); // no revision, no notification
      for (const step of [C.RECONCILE_MS, C.RECONCILE_MS, C.MAX_AGE_MS - 2 * C.RECONCILE_MS - 1]) {
        clockB.advance(step);
        expect(await lists(b, id)).toBe(true); // reconciliation sees nothing new
      }
      clockB.advance(1);
      expect(await lists(b, id)).toBe(false); // T: reloaded regardless
      expect(
        await metric(b, 'acc_provider_config_reloads_total', {
          operation: 'ttl',
          outcome: 'success',
        }),
      ).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  describe('C. stale cache never bypasses PostgreSQL', () => {
    it('a provider disabled through A is refused by B’s very next test-send while B’s snapshot still lists it — and an enabled one is admitted while B’s snapshot still omits it', async () => {
      const id = await createProvider();
      await delivered(b);
      await candidates(b);
      suppressNotifications(b);
      await transition(a, id, 'disable').expect(200);
      expect(await lists(b, id)).toBe(true); // B's advisory read is stale…
      const refused = await call(b, 'post', 'tester', `/providers/${id}/test-send`, {
        behavior: 'SUCCESS',
      }).expect(409); // …the authoritative path is not
      expect(refused.body.error.code).toBe(ERROR_CODES.PROVIDER_LIFECYCLE_CONFLICT);
      await transition(a, id, 'enable').expect(200);
      clockB.advance(C.RECONCILE_MS);
      expect(await lists(b, id)).toBe(true);
      await transition(a, id, 'disable').expect(200);
      clockB.advance(C.RECONCILE_MS);
      expect(await lists(b, id)).toBe(false); // B's snapshot omits it now…
      await transition(a, id, 'enable').expect(200);
      await call(b, 'post', 'tester', `/providers/${id}/test-send`, { behavior: 'SUCCESS' }).expect(
        200,
      ); // …and the database admits it
    });

    it('new circuit decisions on B use the current policy even while B’s advisory snapshot reports the old one', async () => {
      const id = await createProvider();
      await delivered(b);
      const stale = await candidates(b);
      suppressNotifications(b);
      const policy = await storedPolicy();
      await call(a, 'put', 'manager', '/provider-circuit-policy', {
        ...circuitPolicyOf(policy),
        minSamples: 2,
        failurePercent: 100,
        expectedVersion: policy.version,
      }).expect(200);
      expect((await candidates(b)).circuitPolicyVersion).toBe(stale.circuitPolicyVersion);
      for (let i = 0; i < 2; i++)
        await call(b, 'post', 'tester', `/providers/${id}/test-send`, { behavior: '500' }).expect(
          200,
        );
      const [row] = await a.admin
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.id, id));
      expect(row!.circuitState).toBe('open'); // two failures: the new policy decided
    });
  });

  // ===========================================================================
  describe('D. notifications are hints only', () => {
    const notify = (payload: string) =>
      a.admin.execute(sql`select pg_notify(${C.NOTIFY_CHANNEL}, ${payload})`);

    it('duplicate, out-of-order, malformed and forged notifications change nothing; a later real change still converges', async () => {
      const id = await createProvider();
      await delivered(b);
      const settled = await candidates(b);
      const current = String(settled.configurationRevision);
      const duplicates = await metric(b, 'acc_provider_config_notifications_total', {
        outcome: 'duplicate',
      });
      for (const payload of [current, current, '1', String(settled.configurationRevision - 1)])
        await notify(payload);
      const malformedBefore = await metric(b, 'acc_provider_config_notifications_total', {
        outcome: 'malformed',
      });
      for (const payload of ['garbage', '{"status":"disabled"}', `${id}`, '-1'])
        await notify(payload);
      await (async () => {
        const deadline = Date.now() + 20_000;
        while (
          (await metric(b, 'acc_provider_config_notifications_total', { outcome: 'malformed' })) <
          malformedBefore + 4
        ) {
          if (Date.now() > deadline) throw new Error('malformed notifications not received');
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
      expect(
        await metric(b, 'acc_provider_config_notifications_total', { outcome: 'duplicate' }),
      ).toBeGreaterThanOrEqual(duplicates + 4);
      // Nothing about the provider changed: a payload is never applied as state.
      expect(await lists(b, id)).toBe(true);
      const [row] = await a.admin
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.id, id));
      expect(row!.status).toBe('active');
      // A forged, very high revision cannot stop a real change from converging.
      await notify('999999999999');
      await until(() => cacheOf(b).isDirty(), 'the forged hint');
      await candidates(b);
      expect(cacheOf(b).isDirty()).toBe(false); // the forged hint cost exactly one reload
      await transition(a, id, 'disable').expect(200);
      await until(() => cacheOf(b).isDirty(), 'dirty');
      expect(await lists(b, id)).toBe(false);
    });

    it('a change in an open transaction is neither visible nor announced until commit; a rollback leaves no revision and no notification', async () => {
      const id = await createProvider();
      await delivered(b);
      await candidates(b);
      const applied = await metric(b, 'acc_provider_config_notifications_total', {
        outcome: 'applied',
      });
      const before = await revision();
      const c = await ownerPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE providers SET status = 'disabled' WHERE id = $1`, [id]);
        expect(await revision()).toBe(before); // not visible outside the transaction
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
      // A committed sentinel: notifications arrive in commit order, so had the
      // rolled-back change been announced, it would have arrived first.
      const malformed = await metric(b, 'acc_provider_config_notifications_total', {
        outcome: 'malformed',
      });
      await a.admin.execute(sql`select pg_notify(${C.NOTIFY_CHANNEL}, 'sentinel')`);
      const deadline = Date.now() + 20_000;
      while (
        (await metric(b, 'acc_provider_config_notifications_total', { outcome: 'malformed' })) <=
        malformed
      ) {
        if (Date.now() > deadline) throw new Error('sentinel not received');
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(
        await metric(b, 'acc_provider_config_notifications_total', { outcome: 'applied' }),
      ).toBe(applied);
      expect(await revision()).toBe(before);
      expect(await lists(b, id)).toBe(true);
    });
  });

  // ===========================================================================
  describe('E. restart and connection loss', () => {
    it('restart during propagation: a change committed while an instance is down is served by the restarted instance on its first read', async () => {
      const id = await createProvider();
      const c = await startInstance(new ManualProviderClock());
      try {
        expect(await lists(c, id)).toBe(true);
      } finally {
        await c.close();
      }
      await transition(a, id, 'disable').expect(200); // while "c" is down
      const restarted = await startInstance(new ManualProviderClock());
      try {
        expect(cacheOf(restarted).peek()).toBeNull(); // nothing carried over
        expect(await lists(restarted, id)).toBe(false); // startup reconciliation
        expect(
          await metric(restarted, 'acc_provider_config_reloads_total', {
            operation: 'startup',
            outcome: 'success',
          }),
        ).toBe(1);
      } finally {
        await restarted.close();
      }
    });

    it('LISTEN loss: a change announced while B is not listening is served on B’s very next read, before R — the loss itself marks the snapshot dirty; the listener then reconnects and notifications resume', async () => {
      const id = await createProvider();
      await delivered(b);
      // Drain: notifications arrive in commit order, so once a sentinel sent now
      // is processed, nothing older is still in flight to B.
      const settled = await candidates(b);
      const duplicates = await metric(b, 'acc_provider_config_notifications_total', {
        outcome: 'duplicate',
      });
      await a.admin.execute(
        sql`select pg_notify(${C.NOTIFY_CHANNEL}, ${String(settled.configurationRevision)})`,
      );
      const drained = Date.now() + 20_000;
      while (
        (await metric(b, 'acc_provider_config_notifications_total', { outcome: 'duplicate' })) <=
        duplicates
      ) {
        if (Date.now() > drained) throw new Error('sentinel not received');
        await new Promise((r) => setTimeout(r, 5));
      }
      await candidates(b);
      expect(cacheOf(b).isDirty()).toBe(false); // clean before the outage
      const listener = b.app.get(ProviderConfigurationListener);
      // Hold the reconnect, so the outage lasts exactly as long as the test needs.
      const held = jest
        .spyOn(listener as unknown as { scheduleReconnect: () => void }, 'scheduleReconnect')
        .mockImplementation(() => undefined);
      const lost = await metric(b, 'acc_provider_config_listener_events_total', {
        outcome: 'lost',
      });
      await a.admin.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'acc-provider-config-listener' and datname = current_database()`,
      );
      await until(() => !listener.isConnected(), 'listener loss');
      expect(cacheOf(b).isDirty()).toBe(true); // the loss itself marked it dirty
      expect(
        await metric(b, 'acc_provider_config_listener_events_total', { outcome: 'lost' }),
      ).toBe(lost + 1);
      expect(await metric(b, 'acc_provider_config_listener_connected')).toBe(0);
      // A change while B is deaf: its notification never reaches B.
      await transition(a, id, 'disable').expect(200);
      expect(await lists(b, id)).toBe(false); // B's clock has not moved: the loss marked it dirty
      expect(
        await metric(b, 'acc_provider_config_reloads_total', {
          operation: 'listener',
          outcome: 'success',
        }),
      ).toBeGreaterThan(0);
      // Reconnect, and notifications flow again.
      held.mockRestore();
      await (listener as unknown as { connect: () => Promise<void> }).connect();
      await until(() => listener.isConnected(), 'reconnect');
      await until(() => a.app.get(ProviderConfigurationListener).isConnected(), 'reconnect A');
      await candidates(b);
      await transition(a, id, 'enable').expect(200);
      await delivered(b);
      expect(await lists(b, id)).toBe(true);
      expect(await metric(b, 'acc_provider_config_listener_connected')).toBe(1);
    });
  });

  // ===========================================================================
  describe('F. concurrency', () => {
    it('two administrators changing different providers concurrently, through different instances: both commit, every instance converges to both', async () => {
      const p1 = await createProvider();
      const p2 = await createProvider();
      const before = await revision();
      const [r1, r2] = await Promise.all([
        transition(a, p1, 'disable', 'manager'),
        transition(b, p2, 'drain', 'platform'),
      ]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect(await revision()).toBeGreaterThanOrEqual(before + 2);
      for (const h of [a, b]) {
        clockA.advance(C.RECONCILE_MS);
        clockB.advance(C.RECONCILE_MS);
        const ids = (await candidates(h)).providers.map((p) => p.providerId);
        expect([ids.includes(p1), ids.includes(p2)]).toEqual([false, false]);
      }
    });

    it('rapid successive state changes converge to the last committed state on every instance', async () => {
      const id = await createProvider();
      const steps = ['drain', 'enable', 'disable', 'enable', 'drain', 'disable', 'enable'] as const;
      for (const to of steps) await transition(a, id, to).expect(200);
      clockB.advance(C.RECONCILE_MS);
      clockA.advance(C.RECONCILE_MS);
      expect(await lists(a, id)).toBe(true);
      expect(await lists(b, id)).toBe(true);
      await transition(a, id, 'disable').expect(200);
      clockB.advance(C.RECONCILE_MS);
      expect(await lists(b, id)).toBe(false);
    });

    it('two policy updates from one version through different instances: one wins, both instances converge to it', async () => {
      const policy = await storedPolicy();
      const [r1, r2] = await Promise.all([
        call(a, 'put', 'manager', '/provider-circuit-policy', {
          ...circuitPolicyOf(policy),
          cooldownMs: 7_000,
          expectedVersion: policy.version,
        }),
        call(b, 'put', 'platform', '/provider-circuit-policy', {
          ...circuitPolicyOf(policy),
          cooldownMs: 9_000,
          expectedVersion: policy.version,
        }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const winner = [r1, r2].find((r) => r.status === 200)!.body.data.cooldownMs as number;
      for (const h of [a, b]) {
        clockA.advance(C.RECONCILE_MS);
        clockB.advance(C.RECONCILE_MS);
        await candidates(h);
        expect(cacheOf(h).peek()!.circuitPolicy).toMatchObject({
          cooldownMs: winner,
          version: policy.version + 1,
        });
      }
    });
  });

  // ===========================================================================
  describe('G. security — reload is never authorization', () => {
    it('unauthenticated, tenant, reseller, support, API-key and forged-scope requests are refused before the cache is read or refreshed', async () => {
      await candidates(b);
      const reloads = async () =>
        (await b.app.get(MetricsService).scrape())
          .split('\n')
          .filter((l) => l.startsWith('acc_provider_config_reloads_total{'))
          .reduce((n, l) => n + Number(l.split(' ').at(-1)), 0);
      cacheOf(b).invalidateLocal('test'); // a refused request must not trigger this reload
      const before = await reloads();
      for (const [who, status, org] of [
        [null, 401, undefined],
        ['orgAdmin', 403, undefined],
        ['orgAdmin', 403, tenant.orgId],
        ['tenantComposed', 403, tenant.orgId],
        ['reseller', 403, undefined],
        ['support', 403, undefined],
        ['apiKey', 403, undefined],
      ] as const) {
        const res = await call(
          b,
          'get',
          who,
          `/channels/${sms}/routing-candidates`,
          undefined,
          org,
        );
        expect(`${who} → ${res.status}`).toBe(`${who} → ${status}`);
      }
      expect(await reloads()).toBe(before);
      expect(cacheOf(b).isDirty()).toBe(true);
      // A test_send-only role holds providers.read: it may read the advisory view.
      await call(b, 'get', 'tester', `/channels/${sms}/routing-candidates`).expect(200);
      expect(await reloads()).toBe(before + 1);
    });

    it('a notification can be sent by any database role, and still can neither change provider state nor grant anything', async () => {
      const id = await createProvider();
      await delivered(b);
      await candidates(b);
      // As a tenant user over acc_app, and as acc_auth: NOTIFY needs no privilege.
      for (const pool of [appPool, authPool]) {
        const c = await pool.connect();
        try {
          await c.query(`NOTIFY ${C.NOTIFY_CHANNEL}, '1'`);
          await c.query(`NOTIFY ${C.NOTIFY_CHANNEL}, '{"providerId":"${id}","status":"disabled"}'`);
        } finally {
          c.release();
        }
      }
      clockB.advance(C.RECONCILE_MS);
      expect(await lists(b, id)).toBe(true);
      const [row] = await a.admin
        .select()
        .from(schema.providers)
        .where(eq(schema.providers.id, id));
      expect(row!.status).toBe('active');
      // The advisory read itself still requires authorization.
      await call(b, 'get', 'orgAdmin', `/channels/${sms}/routing-candidates`).expect(403);
    });

    it('the revision table: platform-scope read, providers.manage update, monotonic, no insert or delete, nothing for acc_auth or acc_relay', async () => {
      const bump = `update provider_configuration_revision set revision = revision + 1`;
      for (const [userId, flag, expected] of [
        [people.manager!.userId, false, 'ok'],
        [people.platform!.userId, false, 'ok'],
        [people.tester!.userId, false, 'none'],
        [people.reader!.userId, false, 'none'],
        [people.support!.userId, false, 'none'],
        [tenant.userId, false, 'none'],
        [tenant.userId, true, 'none'],
        [null, false, 'none'],
      ] as const) {
        await asPrincipal(
          appPool,
          userId,
          async (c) => {
            expect(`${userId} ${flag} → ${await attempt(c, bump)}`).toBe(
              `${userId} ${flag} → ${expected}`,
            );
            expect(await attempt(c, 'delete from provider_configuration_revision')).toBe('42501');
            expect(
              await attempt(c, `insert into provider_configuration_revision (scope) values ('x')`),
            ).toBe('42501');
          },
          flag,
        );
      }
      for (const [userId, rows] of [
        [people.reader!.userId, 1],
        [people.support!.userId, 1],
        [tenant.userId, 0],
        [null, 0],
      ] as const) {
        await asPrincipal(appPool, userId, async (c) => {
          expect(
            (await c.query('select count(*)::int n from provider_configuration_revision')).rows[0]
              .n,
          ).toBe(rows);
        });
      }
      for (const pool of [authPool, relayPool]) {
        await asPrincipal(pool, people.platform!.userId, async (c) => {
          expect(await attempt(c, 'select 1 from provider_configuration_revision')).toBe('42501');
        });
      }
      // Monotonic for everyone, the owner included.
      for (const statement of [
        sql`update provider_configuration_revision set revision = revision`,
        sql`update provider_configuration_revision set revision = revision - 1`,
        sql`update provider_configuration_revision set scope = 'other', revision = revision + 1`,
      ]) {
        await expect(a.admin.execute(statement)).rejects.toMatchObject({
          cause: { code: '23514' },
        });
      }
    });

    it('policies, triggers and functions: exact predicates, no role names, invoker functions, no SECURITY DEFINER added', async () => {
      const { rows: policies } = await a.admin.execute<{
        policyname: string;
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(
        sql`select policyname, cmd, qual, with_check from pg_policies where tablename = 'provider_configuration_revision' order by policyname`,
      );
      expect(policies.map((p) => `${p.policyname}:${p.cmd}`).sort()).toEqual([
        'provider_configuration_revision_platform_read:SELECT',
        'provider_configuration_revision_platform_update:UPDATE',
      ]);
      expect(policies.find((p) => p.cmd === 'SELECT')!.qual).toBe('app_has_platform_scope()');
      expect(policies.find((p) => p.cmd === 'UPDATE')!.qual).toBe(
        "app_has_platform_permission('providers.manage'::text)",
      );
      const { rows: fns } = await a.admin.execute<{ proname: string; secdef: boolean }>(
        sql`select proname, prosecdef as secdef from pg_proc where proname in ('fn_provider_configuration_changed','fn_provider_configuration_revision_monotonic')`,
      );
      expect(fns.map((f) => `${f.proname}:${f.secdef}`).sort()).toEqual([
        'fn_provider_configuration_changed:false',
        'fn_provider_configuration_revision_monotonic:false',
      ]);
      const { rows: triggers } = await a.admin.execute<{ tgname: string }>(
        sql`select tgname from pg_trigger where tgfoid = 'fn_provider_configuration_changed'::regproc order by tgname`,
      );
      expect(triggers.map((t) => t.tgname).sort()).toEqual([
        'trg_channels_configuration_changed',
        'trg_provider_capabilities_configuration_changed',
        'trg_provider_circuit_policy_configuration_changed',
        'trg_providers_configuration_inserted_deleted',
        'trg_providers_configuration_updated',
      ]);
      const { rows: definers } = await a.admin.execute<{ proname: string }>(
        sql`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and (p.proname like '%provider%' or p.proname like '%configuration%' or p.proname like 'app_has_platform%')`,
      );
      expect(definers.map((d) => d.proname).sort()).toEqual([
        'app_has_platform_permission',
        'app_has_platform_scope',
      ]);
    });

    it('health and circuit writes are not configuration: test-sends move no revision', async () => {
      const id = await createProvider();
      const before = await revision();
      for (const behavior of ['500', '500', 'SUCCESS'])
        await call(a, 'post', 'tester', `/providers/${id}/test-send`, { behavior }).expect(200);
      await call(a, 'post', 'manager', `/providers/${id}/health-check`, {
        behavior: 'UNHEALTHY',
      }).expect(200);
      expect(await revision()).toBe(before);
    });
  });

  // ===========================================================================
  describe('H. observability', () => {
    it('every hot-reload metric exists and is bounded', async () => {
      await candidates(b);
      const text = await b.app.get(MetricsService).scrape();
      for (const family of [
        'acc_provider_config_notifications_total',
        'acc_provider_config_reloads_total',
        'acc_provider_config_revision',
        'acc_provider_config_convergence_seconds_count',
        'acc_provider_config_listener_connected',
        'acc_provider_config_listener_events_total',
      ]) {
        expect(text.split('\n').some((l) => l.startsWith(family))).toBe(true);
      }
      expect(await metric(b, 'acc_provider_config_revision')).toBe(await revision());
      expect(
        await metric(a, 'acc_provider_config_local_invalidations_total', { operation: 'enable' }),
      ).toBeGreaterThan(0);
    });
  });
});
