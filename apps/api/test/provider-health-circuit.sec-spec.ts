/**
 * Phase 2.3 — provider health and circuit breaker (ADR-013 F-6/F-7, ROADMAP §5b
 * 2.3, `PROVIDER_ADAPTER.md` §5-§6, Gate D.3).
 *
 * Every case drives real HTTP against the real database. Time is the injected
 * provider clock (`ManualProviderClock`): windows, cooldowns and probe leases are
 * crossed by advancing it to the exact millisecond — nothing sleeps. Concurrency
 * is made deterministic by parking requests on a row lock the test holds, and
 * releasing it only once every request is waiting; a submission is held "in
 * flight" by gating the real executor. The database boundary is proven with the
 * service bypassed, as `acc_app`, `acc_auth` and `acc_relay` directly.
 */
import { randomBytes } from 'node:crypto';

import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PLATFORM_ROLE_KEYS,
  PROVIDER_CIRCUIT_DEFAULTS as C,
  PROVIDER_HEALTH_DEFAULTS as H,
  PROVIDER_SUBMISSION_DEFAULTS,
  type ProviderSubmissionResult,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { FORBIDDEN_LABELS, MetricsService } from '../src/observability/metrics.service';
import { ProviderSubmissionExecutor } from '../src/provider-adapters/submission-executor';
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

interface Person {
  userId: string;
  email: string;
}

type Behavior = '500' | '429' | 'SUCCESS' | 'INVALID_REQUEST' | 'INVALID_CREDENTIALS' | 'TIMEOUT';

// Each case makes many real requests; none sleeps.
jest.setTimeout(60_000);

describe('Phase 2.3 provider health and circuit breaker', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenant: TenantFixture;
  let appPool: Pool;
  let authPool: Pool;
  let relayPool: Pool;
  let lockPool: Pool;
  const clock = new ManualProviderClock();
  const people: Record<string, Person> = {};
  const tokens: Record<string, string> = {};
  const createdUsers: string[] = [];
  const createdRoles: string[] = [];
  const createdProviders: string[] = [];
  /** Locks and gates still held when a case ends — always released, pass or fail. */
  const outstanding: (() => Promise<void> | void)[] = [];
  let channelSms: string;
  let apiKey: string;
  let apiKeyId: string;

  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => randomBytes(5).toString('hex');
  const list = (values: string[]) =>
    sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    );

  // --- fixtures ---------------------------------------------------------------

  async function createUser(label: string) {
    const email = `p23-${label}-${suffix()}@example.test`;
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

  /** A role that is not alendei_super_admin, holding exactly `permissionKeys`. */
  async function testRole(
    permissionKeys: string[],
    scope: { orgId: string | null; allowed: 'platform' | 'organization' },
  ): Promise<string> {
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: scope.orgId,
          key: `test_p23_${suffix()}`,
          name: 'Test p23 role',
          isSystemRole: false,
          allowedScopeTypes: [scope.allowed],
        })
        .returning({ id: schema.roles.id });
      createdRoles.push(role!.id);
      const perms = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(inArray(schema.permissions.key, permissionKeys));
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

  const call = (
    method: 'get' | 'post',
    credential: string | null,
    path: string,
    body?: object,
    org?: string,
  ) => {
    let r = request(h.app.getHttpServer())[method](url(path));
    if (credential) r = r.set('authorization', `Bearer ${credential}`);
    if (org) r = r.set('x-acc-organization', org);
    return body === undefined ? r : r.send(body);
  };
  const send = (who: string, id: string, behavior: Behavior) =>
    call('post', tokens[who]!, `/providers/${id}/test-send`, { behavior });
  const probe = (who: string, id: string, behavior: string) =>
    call('post', tokens[who]!, `/providers/${id}/health-check`, { behavior });
  const override = (who: string, id: string, body: object) =>
    call('post', tokens[who]!, `/providers/${id}/health`, body);
  const history = (who: string, id: string, query = '') =>
    call('get', tokens[who]!, `/providers/${id}/health${query}`);

  /**
   * A provider planted by the owner, so a case can start from any lifecycle,
   * health or circuit state (the owner is exempt from the state guard, as for
   * every maintenance write; the application never writes this way).
   */
  async function plantProvider(
    options: {
      status?: 'active' | 'disabled' | 'draining';
      adapterKey?: string;
      circuit?: 'closed' | 'open' | 'half_open';
      generation?: number;
      changedAt?: Date | null;
    } = {},
  ) {
    const circuit = options.circuit ?? 'closed';
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelSms,
        name: `p23-${suffix()}`,
        adapterKey: options.adapterKey ?? 'simulator',
        status: options.status ?? 'active',
        circuitState: circuit,
        circuitGeneration: options.generation ?? (circuit === 'closed' ? 0 : 1),
        circuitChangedAt:
          options.changedAt !== undefined
            ? options.changedAt
            : circuit === 'closed'
              ? null
              : clock.now(),
      })
      .returning({ id: schema.providers.id });
    createdProviders.push(p!.id);
    return p!.id;
  }

  /** An `open` provider whose cooldown has exactly elapsed on the injected clock. */
  const plantOpenPastCooldown = (status: 'active' | 'disabled' | 'draining' = 'active') =>
    plantProvider({
      status,
      circuit: 'open',
      changedAt: new Date(clock.now().getTime() - C.COOLDOWN_MS),
    });

  const providerRow = async (id: string) =>
    (await h.admin.select().from(schema.providers).where(eq(schema.providers.id, id)))[0]!;

  const samples = async (id: string) =>
    h.admin
      .select()
      .from(schema.providerHealth)
      .where(eq(schema.providerHealth.providerId, id))
      .orderBy(schema.providerHealth.id);

  const audits = async (id: string, action?: string) =>
    (
      await h.admin.execute<Record<string, unknown>>(
        action
          ? sql`select * from audit_logs where resource_id = ${id} and action = ${action} order by id`
          : sql`select * from audit_logs where resource_id = ${id} order by id`,
      )
    ).rows;

  const healthAudits = async (id: string) =>
    (
      await h.admin.execute<{ n: number }>(
        sql`select count(*)::int n from audit_logs where resource_id = ${id} and action in ('provider.health_checked','provider.health_changed','provider.health_overridden','provider.circuit_changed')`,
      )
    ).rows[0]!.n;

  const sampleCount = async () =>
    (await h.admin.execute<{ n: number }>(sql`select count(*)::int n from provider_health`))
      .rows[0]!.n;

  // --- metrics -----------------------------------------------------------------

  const scrape = () => h.app.get(MetricsService).scrape();
  /** The value of one series, matched on every given label; 0 when absent. */
  async function metric(name: string, labels: Record<string, string>): Promise<number> {
    const line = (await scrape())
      .split('\n')
      .find(
        (l) =>
          l.startsWith(`${name}{`) &&
          Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)),
      );
    return line ? Number(line.split(' ').at(-1)) : 0;
  }

  // --- concurrency instruments --------------------------------------------------

  /** Holds the provider row `FOR UPDATE` on an owner connection until released. */
  async function holdProviderLock(id: string) {
    const c = await lockPool.connect();
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM providers WHERE id = $1 FOR UPDATE', [id]);
    let held = true;
    const release = async () => {
      if (!held) return;
      held = false;
      await c.query('COMMIT');
      c.release();
    };
    outstanding.push(release);
    return { release };
  }

  /** Waits — on a condition, never a fixed sleep — until `n` backends wait on a lock. */
  async function waitForLockWaiters(n: number) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await h.admin.execute<{ n: number }>(
        sql`select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and state = 'active'`,
      );
      if (rows[0]!.n >= n) return;
      if (Date.now() > deadline) throw new Error(`only ${rows[0]!.n} of ${n} lock waiters`);
      await new Promise((r) => setImmediate(r));
    }
  }

  async function until(condition: () => boolean, what: string) {
    const deadline = Date.now() + 20_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setImmediate(r));
    }
  }

  /**
   * Holds every submission the real executor receives until released, and
   * counts them — the adapter is reached exactly when `calls` moves.
   */
  function gateExecutor() {
    const executor = h.app.get(ProviderSubmissionExecutor);
    const original = executor.execute.bind(executor);
    const waiting: (() => void)[] = [];
    const gate = { calls: 0, waiting, releaseAll: () => waiting.splice(0).forEach((w) => w()) };
    outstanding.push(() => gate.releaseAll());
    jest.spyOn(executor, 'execute').mockImplementation(async (...args) => {
      gate.calls++;
      await new Promise<void>((resolve) => waiting.push(resolve));
      return original(...args);
    });
    return gate;
  }

  /** Holds only the next submission until released; later ones run normally. */
  function holdNextSubmission() {
    const executor = h.app.get(ProviderSubmissionExecutor);
    const original = executor.execute.bind(executor);
    let release!: () => void;
    let entered = false;
    const released = new Promise<void>((r) => (release = r));
    outstanding.push(() => release());
    jest.spyOn(executor, 'execute').mockImplementationOnce(async (...args) => {
      entered = true;
      await released;
      return original(...args);
    });
    return { release, isEntered: () => entered };
  }

  /** Counts adapter submissions without changing them. */
  function countSubmissions() {
    const executor = h.app.get(ProviderSubmissionExecutor);
    return jest.spyOn(executor, 'execute');
  }

  async function asPrincipal<T>(
    pool: Pool,
    userId: string | null,
    work: (c: PoolClient) => Promise<T>,
    isPlatformAdmin = false,
    orgId: string | null = null,
  ): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const [name, value] of [
        ['app.current_org_id', orgId ?? ''],
        ['app.current_workspace_id', ''],
        ['app.current_reseller_id', ''],
        ['app.current_user_id', userId ?? ''],
        ['app.is_platform_admin', isPlatformAdmin ? 'on' : 'off'],
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
  const asApp = <T>(userId: string | null, work: (c: PoolClient) => Promise<T>, flag = false) =>
    asPrincipal(appPool, userId, work, flag);

  /** Runs one statement in a savepoint; answers `ok` or the SQLSTATE. */
  async function attempt(c: PoolClient, text: string, values: unknown[] = []) {
    await c.query('SAVEPOINT s');
    try {
      const res = await c.query(text, values);
      return res.rowCount === 0 && /^\s*update/i.test(text) ? 'none' : 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? 'error';
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT s');
    }
  }

  beforeAll(async () => {
    h = await startHarness({ providerClock: clock });
    // Listen for the whole suite. Otherwise supertest listens on the first
    // request and closes the server when that request ends — and close() waits
    // for every open connection, so a response would be withheld until a
    // submission this suite deliberately holds in flight had finished.
    await new Promise<void>((resolve) => h.app.getHttpServer().listen(0, resolve));
    credentials = h.app.get(CredentialService);
    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    authPool = new Pool({ connectionString: process.env.DATABASE_AUTH_URL, max: 1 });
    relayPool = new Pool({ connectionString: process.env.DATABASE_RELAY_URL, max: 1 });
    lockPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
    tenant = await createTenant(h.admin, 'p23', credentials);

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
    const platformScope = { orgId: null, allowed: 'platform' as const };
    people.manager = await createUser('manager');
    await grant(
      people.manager.userId,
      await testRole(['providers.read', 'providers.manage'], platformScope),
      'platform',
      null,
    );
    people.tester = await createUser('tester');
    await grant(
      people.tester.userId,
      await testRole(['providers.read', 'providers.test_send'], platformScope),
      'platform',
      null,
    );
    people.reader = await createUser('reader');
    await grant(
      people.reader.userId,
      await testRole(['providers.read'], platformScope),
      'platform',
      null,
    );
    // A tenant role composed with every providers.* permission, granted at the organization.
    people.tenantComposed = await createUser('tenant-composed');
    await grant(
      people.tenantComposed.userId,
      await testRole(['providers.read', 'providers.manage', 'providers.test_send'], {
        orgId: tenant.orgId,
        allowed: 'organization',
      }),
      'organization',
      tenant.orgId,
    );

    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const secret = `s${randomBytes(16).toString('hex')}`;
    const [key] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        name: `p23-${suffix()}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        scopes: ['providers.read', 'providers.manage', 'providers.test_send'],
        createdBy: people.platform.userId,
      })
      .returning({ id: schema.apiKeys.id });
    apiKey = `${prefix}.${secret}`;
    apiKeyId = key!.id;
    tokens.apiKey = apiKey;

    for (const name of [
      'platform',
      'support',
      'reseller',
      'manager',
      'tester',
      'reader',
      'tenantComposed',
    ])
      tokens[name] = await login(people[name]!.email);
    tokens.orgAdmin = await login(tenant.email);

    const [sms] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'sms'));
    channelSms = sms!.id;
  }, 180_000);

  afterEach(async () => {
    for (const release of outstanding.splice(0)) await release();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await h.clearRateLimits();
    if (createdProviders.length > 0) {
      await purgeAudit(h.admin, sql`resource_id IN (${list(createdProviders)})`);
      await purgeProviderHealth(h.admin, sql`provider_id IN (${list(createdProviders)})`);
      await h.admin.execute(
        sql`DELETE FROM provider_capabilities WHERE provider_id IN (${list(createdProviders)})`,
      );
      await h.admin.execute(sql`DELETE FROM providers WHERE id IN (${list(createdProviders)})`);
    }
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
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await destroyTenant(h.admin, tenant);
    await Promise.all([appPool.end(), authPool.end(), relayPool.end(), lockPool.end()]);
    await h.close();
  }, 180_000);

  // ===========================================================================
  describe('A. the health check (probe)', () => {
    it('HEALTHY and UNHEALTHY: 200 with the probe outcome, one probe sample, provider.health_checked success / failure, and the circuit untouched', async () => {
      const id = await plantProvider();
      const ok = await probe('manager', id, 'HEALTHY').expect(200);
      expect(ok.body.data).toMatchObject({
        providerId: id,
        adapterKey: 'simulator',
        channelCode: 'sms',
        behavior: 'HEALTHY',
        outcome: 'healthy',
        healthState: 'healthy',
        circuitState: 'closed',
      });
      // Measured on the real submission timer: immediate, not a timeout.
      expect(ok.body.data.latencyMs).toBeLessThan(H.PROBE_TIMEOUT_MS);
      const bad = await probe('manager', id, 'UNHEALTHY').expect(200);
      expect(bad.body.data).toMatchObject({ outcome: 'unhealthy', healthState: 'healthy' });

      const rows = await samples(id);
      expect(rows.map((r) => [r.kind, r.outcome, r.classification, r.source])).toEqual([
        ['probe', 'healthy', 'success', 'automatic'],
        ['probe', 'unhealthy', 'failure', 'automatic'],
      ]);
      expect(rows.map((r) => r.observedAt.toISOString())).toEqual([
        clock.now().toISOString(),
        clock.now().toISOString(),
      ]);
      const checked = await audits(id, AUDIT_ACTIONS.PROVIDER_HEALTH_CHECKED);
      expect(checked.map((a) => [a.outcome, (a.after as { outcome: string }).outcome])).toEqual([
        ['success', 'healthy'],
        ['failure', 'unhealthy'],
      ]);
      expect(checked[0]).toMatchObject({
        scope_type: 'platform',
        org_id: null,
        actor_user_id: people.manager!.userId,
        resource_type: 'Provider',
      });
      expect(await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED)).toHaveLength(0);
      const row = await providerRow(id);
      expect([row.circuitState, row.circuitGeneration]).toEqual(['closed', 0]);
    });

    it(
      'TIMEOUT: the probe times out at the platform timeout and is recorded as a failure',
      async () => {
        const id = await plantProvider();
        const res = await probe('manager', id, 'TIMEOUT').expect(200);
        expect(res.body.data).toMatchObject({ outcome: 'timeout', latencyMs: H.PROBE_TIMEOUT_MS });
        const [sample] = await samples(id);
        expect([sample!.outcome, sample!.classification, sample!.latencyMs]).toEqual([
          'timeout',
          'failure',
          H.PROBE_TIMEOUT_MS,
        ]);
        const [checked] = await audits(id, AUDIT_ACTIONS.PROVIDER_HEALTH_CHECKED);
        expect(checked!.outcome).toBe('failure');
      },
      H.PROBE_TIMEOUT_MS + 15_000,
    );

    it('five consecutive unhealthy probes take health to offline with one provider.health_changed row; healthy probes bring it back as the window moves', async () => {
      const id = await plantProvider();
      for (let i = 0; i < 4; i++) {
        const r = await probe('manager', id, 'UNHEALTHY').expect(200);
        expect(r.body.data.healthState).toBe('healthy'); // fewer than five: no conclusion
      }
      const fifth = await probe('manager', id, 'UNHEALTHY').expect(200);
      expect(fifth.body.data.healthState).toBe('offline');
      const changed = await audits(id, AUDIT_ACTIONS.PROVIDER_HEALTH_CHANGED);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        before: { healthState: 'healthy' },
        after: { healthState: 'offline', source: 'automatic', cause: 'probe' },
        actor_user_id: people.manager!.userId,
      });
      const row = await providerRow(id);
      expect(row.healthState).toBe('offline');
      expect(row.healthChangedAt!.toISOString()).toBe(clock.now().toISOString());

      // One healthy probe ends the streak: 5 failures of 6 is critical (rate ≥ 50 %).
      expect((await probe('manager', id, 'HEALTHY').expect(200)).body.data.healthState).toBe(
        'critical',
      );
      // Past the 300 s window the failures no longer count: one healthy sample is "too few" → healthy.
      clock.advance(H.WINDOW_MS);
      expect((await probe('manager', id, 'HEALTHY').expect(200)).body.data.healthState).toBe(
        'healthy',
      );
      expect(
        (await audits(id, AUDIT_ACTIONS.PROVIDER_HEALTH_CHANGED)).map(
          (a) =>
            `${(a.before as { healthState: string }).healthState}>${(a.after as { healthState: string }).healthState}`,
        ),
      ).toEqual(['healthy>offline', 'offline>critical', 'critical>healthy']);
      // The circuit never moved.
      expect((await providerRow(id)).circuitGeneration).toBe(0);
    });

    it('a health check is permitted in every lifecycle status and every circuit state, and never moves the circuit', async () => {
      for (const status of ['active', 'disabled', 'draining'] as const) {
        for (const circuit of ['closed', 'open', 'half_open'] as const) {
          const id = await plantProvider({
            status,
            circuit,
            generation: circuit === 'closed' ? 0 : 3,
          });
          const before = await providerRow(id);
          for (let i = 0; i < 5; i++) await probe('manager', id, 'UNHEALTHY').expect(200);
          const after = await providerRow(id);
          expect([after.status, after.circuitState, after.circuitGeneration]).toEqual([
            before.status,
            before.circuitState,
            before.circuitGeneration,
          ]);
          expect(after.healthState).toBe('offline');
          expect(await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED)).toHaveLength(0);
        }
      }
    });

    it('authority withdrawn while the probe runs — providers.manage revoked, or the user disabled: 403, and no sample or audit row is written', async () => {
      const id = await plantProvider();
      const executor = h.app.get(ProviderSubmissionExecutor);
      const original = executor.probe.bind(executor);
      const during = (between: () => Promise<void>) =>
        jest.spyOn(executor, 'probe').mockImplementationOnce(async (...args) => {
          await between();
          return original(...args);
        });
      const managerGrant = (
        await h.admin.execute<{ role_id: string }>(
          sql`select role_id from user_roles where user_id = ${people.manager!.userId} and scope_type = 'platform'`,
        )
      ).rows[0]!.role_id;

      const revoked = during(async () => {
        await h.admin.execute(
          sql`DELETE FROM user_roles WHERE user_id = ${people.manager!.userId} AND role_id = ${managerGrant}`,
        );
      });
      try {
        const res = await probe('manager', id, 'UNHEALTHY').expect(403);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
        expect(revoked).toHaveBeenCalledTimes(1); // authorized when it started, so it ran
      } finally {
        await grant(people.manager!.userId, managerGrant, 'platform', null);
      }

      during(async () => {
        await h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, people.manager!.userId));
      });
      try {
        await probe('manager', id, 'UNHEALTHY').expect(403);
      } finally {
        await h.admin
          .update(schema.users)
          .set({ status: 'active' })
          .where(eq(schema.users.id, people.manager!.userId));
      }
      expect(await samples(id)).toHaveLength(0);
      expect(await healthAudits(id)).toBe(0);
      // Restored, the same manager probes normally again.
      tokens.manager = await login(people.manager!.email);
      await probe('manager', id, 'HEALTHY').expect(200);
    });

    it('an unknown provider is 404; an unregistered adapter is 422; an unknown behaviour or an extra field is 400 — nothing recorded', async () => {
      const before = await sampleCount();
      const missing = await probe('manager', uuidv7(), 'HEALTHY').expect(404);
      expect(missing.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
      const orphan = await plantProvider({ adapterKey: 'acme_unregistered' });
      const unknown = await probe('manager', orphan, 'HEALTHY').expect(422);
      expect(unknown.body.error.code).toBe(ERROR_CODES.PROVIDER_ADAPTER_UNKNOWN);
      const id = await plantProvider();
      await probe('manager', id, 'SLOW').expect(400);
      await call('post', tokens.manager!, `/providers/${id}/health-check`, {}).expect(400);
      await call('post', tokens.manager!, `/providers/${id}/health-check`, {
        behavior: 'HEALTHY',
        adapterKey: 'simulator',
      }).expect(400);
      expect(await sampleCount()).toBe(before);
      expect(await healthAudits(orphan)).toBe(0);
      expect(await healthAudits(id)).toBe(0);
    });
  });

  // ===========================================================================
  describe('B. health derivation from real samples', () => {
    it('the exact sequence: healthy → degraded (20 %) → critical (50 %) → offline (five in a row), each change audited once as automatic', async () => {
      const id = await plantProvider();
      const states: string[] = [];
      const go = async (b: 'HEALTHY' | 'UNHEALTHY') =>
        states.push((await probe('manager', id, b).expect(200)).body.data.healthState);
      for (let i = 0; i < 4; i++) await go('HEALTHY'); // fewer than five: healthy
      await go('UNHEALTHY'); // 1/5 = 20 % → degraded
      await go('HEALTHY'); // 1/6 → healthy
      await go('UNHEALTHY'); // 2/7 → degraded
      await go('UNHEALTHY'); // 3/8 → degraded
      await go('UNHEALTHY'); // 4/9 → degraded
      await go('UNHEALTHY'); // 5/10 = 50 % → critical
      await go('UNHEALTHY'); // streak 5 → offline
      expect(states).toEqual([
        'healthy',
        'healthy',
        'healthy',
        'healthy',
        'degraded',
        'healthy',
        'degraded',
        'degraded',
        'degraded',
        'critical',
        'offline',
      ]);
      const changes = await audits(id, AUDIT_ACTIONS.PROVIDER_HEALTH_CHANGED);
      expect(
        changes.map((a) => {
          const after = a.after as { healthState: string; source: string; cause: string };
          return `${(a.before as { healthState: string }).healthState}>${after.healthState}:${after.source}:${after.cause}`;
        }),
      ).toEqual([
        'healthy>degraded:automatic:probe',
        'degraded>healthy:automatic:probe',
        'healthy>degraded:automatic:probe',
        'degraded>critical:automatic:probe',
        'critical>offline:automatic:probe',
      ]);
      expect(changes.every((a) => a.actor_user_id === people.manager!.userId)).toBe(true);
    });

    it('samples older than the 300 s window no longer count; the window is the latest 20 counted samples', async () => {
      const id = await plantProvider();
      for (let i = 0; i < 5; i++) await probe('manager', id, 'UNHEALTHY').expect(200);
      expect((await providerRow(id)).healthState).toBe('offline');
      clock.advance(H.WINDOW_MS - 1);
      // Still inside the window: one success makes it 5/6 → critical.
      expect((await probe('manager', id, 'HEALTHY').expect(200)).body.data.healthState).toBe(
        'critical',
      );
      clock.advance(1);
      // Exactly 300 s after the failures they are outside `(now − 300 s, now]`.
      expect((await probe('manager', id, 'HEALTHY').expect(200)).body.data.healthState).toBe(
        'healthy',
      );
      // The window is capped at the latest 20 counted samples: after five failures,
      // sixteen successes leave 4 failures of 20 (20 % → degraded) and the
      // seventeenth leaves 3 of 20 (healthy). Uncapped it would be 5 of 22.
      const other = await plantProvider();
      for (let i = 0; i < 5; i++) await probe('manager', other, 'UNHEALTHY').expect(200);
      for (let i = 0; i < 16; i++) await probe('manager', other, 'HEALTHY').expect(200);
      expect((await providerRow(other)).healthState).toBe('degraded');
      await probe('manager', other, 'HEALTHY').expect(200);
      expect((await providerRow(other)).healthState).toBe('healthy');
    });

    it('neutral outcomes (INVALID_REQUEST, INVALID_CREDENTIALS) are recorded but move neither health nor circuit', async () => {
      const id = await plantProvider();
      for (let i = 0; i < 6; i++) {
        await send('tester', id, i % 2 ? 'INVALID_REQUEST' : 'INVALID_CREDENTIALS').expect(200);
      }
      const rows = await samples(id);
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map((r) => r.classification))).toEqual(new Set(['neutral']));
      expect(rows.map((r) => r.outcome).slice(0, 2)).toEqual(['auth_error', 'invalid_request']);
      const row = await providerRow(id);
      expect([row.healthState, row.circuitState, row.circuitGeneration]).toEqual([
        'healthy',
        'closed',
        0,
      ]);
      expect(await healthAudits(id)).toBe(0);
    });
  });

  // ===========================================================================
  describe('C. the manual override', () => {
    it('pins health: provider.health_overridden and provider.health_changed, an override sample with source manual; automatic samples no longer move health', async () => {
      const id = await plantProvider();
      const res = await override('manager', id, {
        override: 'offline',
        reason: 'carrier outage',
      }).expect(200);
      expect(res.body.data).toMatchObject({
        id,
        healthState: 'offline',
        healthOverride: 'offline',
        circuitState: 'closed',
        status: 'active',
      });
      const [sample] = await samples(id);
      expect(sample).toMatchObject({
        kind: 'override',
        outcome: 'manual',
        classification: 'neutral',
        latencyMs: null,
        healthState: 'offline',
        source: 'manual',
      });
      const [overridden] = await audits(id, AUDIT_ACTIONS.PROVIDER_HEALTH_OVERRIDDEN);
      expect(overridden).toMatchObject({
        outcome: 'success',
        actor_user_id: people.manager!.userId,
        before: { healthOverride: null, healthState: 'healthy' },
        after: { healthOverride: 'offline', healthState: 'offline', reason: 'carrier outage' },
      });
      const [changed] = await audits(id, AUDIT_ACTIONS.PROVIDER_HEALTH_CHANGED);
      expect(changed!.after).toEqual({
        healthState: 'offline',
        source: 'manual',
        cause: 'override',
      });

      for (let i = 0; i < 6; i++) await probe('manager', id, 'HEALTHY').expect(200);
      expect((await providerRow(id)).healthState).toBe('offline');
      expect(await audits(id, AUDIT_ACTIONS.PROVIDER_HEALTH_CHANGED)).toHaveLength(1);
    });

    it('the override already in force changes nothing and records nothing; clearing re-derives from the window at once', async () => {
      const id = await plantProvider();
      for (let i = 0; i < 5; i++) await probe('manager', id, 'UNHEALTHY').expect(200);
      await override('manager', id, { override: 'healthy' }).expect(200);
      const auditsBefore = (await audits(id)).length;
      const samplesBefore = (await samples(id)).length;
      await override('manager', id, { override: 'healthy', reason: 'again' }).expect(200);
      expect((await audits(id)).length).toBe(auditsBefore);
      expect((await samples(id)).length).toBe(samplesBefore);
      // Cleared: derived again from the five failures → offline.
      const cleared = await override('manager', id, { override: null }).expect(200);
      expect(cleared.body.data).toMatchObject({ healthOverride: null, healthState: 'offline' });
      // Clearing again is a no-op too.
      await override('manager', id, { override: null }).expect(200);
      expect(
        (await audits(id, AUDIT_ACTIONS.PROVIDER_HEALTH_OVERRIDDEN)).map(
          (a) => (a.after as { healthOverride: string | null }).healthOverride,
        ),
      ).toEqual(['healthy', null]);
    });

    it('the override never touches the circuit or the lifecycle', async () => {
      const id = await plantProvider({ circuit: 'open', generation: 4 });
      await override('manager', id, { override: 'healthy' }).expect(200);
      await override('manager', id, { override: null }).expect(200);
      const row = await providerRow(id);
      expect([row.status, row.circuitState, row.circuitGeneration]).toEqual(['active', 'open', 4]);
      expect(await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED)).toHaveLength(0);
    });

    it('the body is exact: an absent or unknown override, an over-long reason, or any circuit, status or tenant field is 400 and nothing changes', async () => {
      const id = await plantProvider();
      for (const body of [
        {},
        { override: 'draining' },
        { override: 'HEALTHY' },
        { override: 'healthy', reason: 'x'.repeat(501) },
        { override: 'healthy', circuitState: 'closed' },
        { override: 'healthy', circuit: 'closed' },
        { override: 'healthy', status: 'active' },
        { override: 'healthy', healthState: 'healthy' },
        { override: 'healthy', orgId: tenant.orgId },
        { override: 'healthy', scopeType: 'organization', scopeId: tenant.orgId },
      ]) {
        const res = await override('manager', id, body);
        expect(`${JSON.stringify(body).slice(0, 60)} → ${res.status}`).toMatch(/→ 400$/);
      }
      expect(await samples(id)).toHaveLength(0);
      expect(await healthAudits(id)).toBe(0);
      expect((await providerRow(id)).healthOverride).toBeNull();
    });
  });

  // ===========================================================================
  describe('D. the circuit breaker, through test-send', () => {
    it('T1 at the boundary: four failures keep it closed, the fifth opens it — one provider.circuit_changed row with the window figures', async () => {
      const id = await plantProvider();
      for (let i = 0; i < 4; i++) {
        const r = await send('tester', id, '500').expect(200);
        expect(r.body.data).toMatchObject({ circuitState: 'closed', circuitProbe: false });
      }
      const fifth = await send('tester', id, '500').expect(200);
      // Test-send samples feed health too: five consecutive failures → offline.
      expect(fifth.body.data).toMatchObject({ circuitState: 'open', healthState: 'offline' });
      const row = await providerRow(id);
      expect(row).toMatchObject({ circuitState: 'open', circuitGeneration: 1 });
      expect(row.circuitChangedAt!.toISOString()).toBe(clock.now().toISOString());
      const changed = await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        outcome: 'success',
        scope_type: 'platform',
        actor_user_id: people.tester!.userId,
        before: { circuitState: 'closed', circuitGeneration: 0 },
        after: {
          circuitState: 'open',
          circuitGeneration: 1,
          cause: 'failure_threshold',
          window: { samples: 5, failures: 5 },
        },
      });
      // The view exposes the cooldown end.
      const detail = await call('get', tokens.reader!, `/providers/${id}`).expect(200);
      expect(detail.body.data).toMatchObject({
        circuitState: 'open',
        circuitChangedAt: clock.now().toISOString(),
        circuitCooldownUntil: new Date(clock.now().getTime() + C.COOLDOWN_MS).toISOString(),
      });
    });

    it('exactly 50 % at the minimum opens — and a success can be the sample that trips it; 40 % does not', async () => {
      const at40 = await plantProvider();
      for (const b of ['SUCCESS', 'SUCCESS', 'SUCCESS', '500', '500'] as const)
        await send('tester', at40, b).expect(200);
      expect((await providerRow(at40)).circuitState).toBe('closed'); // 2/5
      await send('tester', at40, '500').expect(200);
      expect((await providerRow(at40)).circuitState).toBe('open'); // 3/6 = 50 %

      const onSuccess = await plantProvider();
      for (const b of ['500', '500', '500', '500'] as const)
        await send('tester', onSuccess, b).expect(200);
      expect((await providerRow(onSuccess)).circuitState).toBe('closed');
      const r = await send('tester', onSuccess, 'SUCCESS').expect(200);
      expect(r.body.data).toMatchObject({ outcome: 'accepted', circuitState: 'open' }); // 4/5
    });

    it('only the current 60 s window counts: failures older than the window never trip it', async () => {
      const id = await plantProvider();
      for (let i = 0; i < 4; i++) await send('tester', id, '500').expect(200);
      clock.advance(C.WINDOW_MS);
      // The four are now outside `(now − 60 s, now]`: four more make a window of four.
      for (let i = 0; i < 4; i++) await send('tester', id, '500').expect(200);
      expect((await providerRow(id)).circuitState).toBe('closed');
      await send('tester', id, '500').expect(200);
      expect((await providerRow(id)).circuitState).toBe('open');
    });

    it('RATE_LIMITED counts as a failure, as does TIMEOUT; neutral rejections never open the circuit', async () => {
      const limited = await plantProvider();
      for (let i = 0; i < 5; i++) await send('tester', limited, '429').expect(200);
      expect((await providerRow(limited)).circuitState).toBe('open');

      // A timeout's classification, without waiting 3 s five times: the executor
      // answers TIMEOUT exactly as its timeout does.
      const executor = h.app.get(ProviderSubmissionExecutor);
      jest.spyOn(executor, 'execute').mockImplementation(
        async (_a, _c, submission) =>
          ({
            outcome: 'rejected',
            submissionId: submission.submissionId,
            correlationId: submission.correlationId,
            failure: {
              category: 'TIMEOUT',
              retryable: true,
              providerCode: null,
              message: 'timeout',
            },
            latencyMs: PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS,
          }) satisfies ProviderSubmissionResult,
      );
      const timedOut = await plantProvider();
      for (let i = 0; i < 5; i++) await send('tester', timedOut, 'TIMEOUT').expect(200);
      expect((await providerRow(timedOut)).circuitState).toBe('open');
      expect((await samples(timedOut)).map((s) => s.outcome)).toEqual(Array(5).fill('timeout'));
      jest.restoreAllMocks();

      const neutral = await plantProvider();
      for (let i = 0; i < 12; i++) await send('tester', neutral, 'INVALID_REQUEST').expect(200);
      expect((await providerRow(neutral)).circuitState).toBe('closed');
    });

    it('OPEN short-circuits: 409 PROVIDER_CIRCUIT_OPEN with retryAfterMs, the adapter is not called, no sample, a short_circuited provider.test_sent failure row and a rejection metric', async () => {
      const id = await plantProvider({ circuit: 'open' });
      clock.advance(1_000);
      const rejectionsBefore = await metric('acc_provider_circuit_rejections_total', {
        provider: id,
        status: 'open',
      });
      const spy = countSubmissions();
      const res = await send('tester', id, 'SUCCESS').expect(409);
      expect(res.body.error).toMatchObject({
        code: ERROR_CODES.PROVIDER_CIRCUIT_OPEN,
        details: { circuitState: 'open', retryAfterMs: C.COOLDOWN_MS - 1_000 },
      });
      expect(spy).not.toHaveBeenCalled();
      expect(await samples(id)).toHaveLength(0);
      const sent = await audits(id, AUDIT_ACTIONS.PROVIDER_TEST_SENT);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        outcome: 'failure',
        actor_user_id: people.tester!.userId,
        after: {
          behavior: 'SUCCESS',
          outcome: 'short_circuited',
          circuitState: 'open',
          submissionId: null,
        },
      });
      expect(
        await metric('acc_provider_circuit_rejections_total', { provider: id, status: 'open' }),
      ).toBe(rejectionsBefore + 1);
      const row = await providerRow(id);
      expect([row.circuitState, row.circuitGeneration]).toEqual(['open', 1]);
    });

    it('the cooldown on the injected clock: refused 1 ms before it ends; exactly at it, T2 to half_open and that submission is the probe', async () => {
      const id = await plantProvider({ circuit: 'open' });
      clock.advance(C.COOLDOWN_MS - 1);
      const early = await send('tester', id, 'SUCCESS').expect(409);
      expect(early.body.error.details).toEqual({ circuitState: 'open', retryAfterMs: 1 });
      clock.advance(1);
      const res = await send('tester', id, 'SUCCESS').expect(200);
      expect(res.body.data).toMatchObject({ circuitProbe: true, circuitState: 'half_open' });
      const changed = await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED);
      expect(changed.map((a) => a.after)).toEqual([
        { circuitState: 'half_open', circuitGeneration: 2, cause: 'cooldown_elapsed' },
      ]);
      const row = await providerRow(id);
      expect(row).toMatchObject({
        circuitState: 'half_open',
        circuitGeneration: 2,
        circuitProbeSuccesses: 1,
        circuitProbeId: null,
        circuitProbeLeaseUntil: null,
      });
      const [sample] = await samples(id);
      expect(sample).toMatchObject({ circuitGeneration: 2, circuitState: 'half_open' });
    });

    it('HALF_OPEN → CLOSED: two successful probes, one after the other (T4)', async () => {
      const id = await plantOpenPastCooldown();
      const first = await send('tester', id, 'SUCCESS').expect(200);
      expect(first.body.data).toMatchObject({ circuitProbe: true, circuitState: 'half_open' });
      const second = await send('tester', id, 'SUCCESS').expect(200);
      expect(second.body.data).toMatchObject({ circuitProbe: true, circuitState: 'closed' });
      const third = await send('tester', id, 'SUCCESS').expect(200);
      expect(third.body.data).toMatchObject({ circuitProbe: false, circuitState: 'closed' });
      expect(
        (await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED)).map(
          (a) => (a.after as { cause: string }).cause,
        ),
      ).toEqual(['cooldown_elapsed', 'probes_succeeded']);
      expect(await providerRow(id)).toMatchObject({
        circuitState: 'closed',
        circuitGeneration: 3,
        circuitProbeSuccesses: 0,
      });
    });

    it('HALF_OPEN → OPEN: a failed probe re-opens the circuit and the cooldown restarts', async () => {
      const id = await plantOpenPastCooldown();
      await send('tester', id, 'SUCCESS').expect(200); // probe 1 succeeds
      const failed = await send('tester', id, '500').expect(200);
      expect(failed.body.data).toMatchObject({ circuitProbe: true, circuitState: 'open' });
      const row = await providerRow(id);
      expect(row).toMatchObject({
        circuitState: 'open',
        circuitGeneration: 3,
        circuitProbeSuccesses: 0,
      });
      expect(row.circuitChangedAt!.toISOString()).toBe(clock.now().toISOString());
      expect((await send('tester', id, 'SUCCESS').expect(409)).body.error.details).toEqual({
        circuitState: 'open',
        retryAfterMs: C.COOLDOWN_MS,
      });
      expect(
        (await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED)).map(
          (a) => (a.after as { cause: string }).cause,
        ),
      ).toEqual(['cooldown_elapsed', 'probe_failed']);
    });

    it('a neutral probe releases the slot and changes nothing else', async () => {
      const id = await plantOpenPastCooldown();
      const r = await send('tester', id, 'INVALID_REQUEST').expect(200);
      expect(r.body.data).toMatchObject({ circuitProbe: true, circuitState: 'half_open' });
      expect(await providerRow(id)).toMatchObject({
        circuitState: 'half_open',
        circuitGeneration: 2,
        circuitProbeSuccesses: 0,
        circuitProbeId: null,
      });
      // The slot is free: the next submission is the probe.
      expect((await send('tester', id, 'SUCCESS').expect(200)).body.data.circuitProbe).toBe(true);
    });
  });

  // ===========================================================================
  describe('E. concurrency', () => {
    it('simultaneous failures: four answers recorded concurrently on top of four prior failures open the circuit exactly once', async () => {
      const id = await plantProvider();
      for (let i = 0; i < 4; i++) await send('tester', id, '500').expect(200);
      const gate = gateExecutor();
      const pending = Array.from({ length: 4 }, () => send('tester', id, '500').then((r) => r));
      await until(() => gate.waiting.length === 4, 'four admitted submissions');
      expect(gate.calls).toBe(4); // all four admitted while closed, in generation 0
      const lock = await holdProviderLock(id);
      gate.releaseAll();
      await waitForLockWaiters(4); // every recording parked behind the lock
      await lock.release();
      const results = await Promise.all(pending);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);

      const changed = await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED);
      expect(changed).toHaveLength(1);
      expect(changed[0]!.after).toMatchObject({ circuitState: 'open', circuitGeneration: 1 });
      expect(await providerRow(id)).toMatchObject({ circuitState: 'open', circuitGeneration: 1 });
      // Eight samples: the first recording opened the circuit; the other three were
      // admitted in generation 0 and recorded as such, after it.
      const rows = await samples(id);
      expect(rows).toHaveLength(8);
      expect(rows.slice(4).map((r) => [r.circuitGeneration, r.circuitState])).toEqual([
        [0, 'open'],
        [0, 'open'],
        [0, 'open'],
        [0, 'open'],
      ]);
    });

    it('simultaneous HALF_OPEN attempts: of four concurrent submissions after the cooldown, exactly one becomes the probe and reaches the adapter; one T2', async () => {
      const id = await plantOpenPastCooldown();
      const gate = gateExecutor();
      const lock = await holdProviderLock(id);
      const pending = Array.from({ length: 4 }, () => send('tester', id, 'SUCCESS').then((r) => r));
      await waitForLockWaiters(4); // every admission parked behind the lock
      await lock.release();
      await until(() => gate.calls >= 1, 'the probe');
      const settled: request.Response[] = [];
      const tracked = pending.map((p) =>
        p.then((r) => {
          settled.push(r);
          return r;
        }),
      );
      await until(() => settled.length === 3, 'three refusals');
      expect(settled.map((r) => [r.status, r.body.error?.details?.circuitState])).toEqual([
        [409, 'half_open'],
        [409, 'half_open'],
        [409, 'half_open'],
      ]);
      expect(gate.calls).toBe(1); // only the probe reached the adapter
      gate.releaseAll();
      const probeResponse = (await Promise.all(tracked)).find((r) => r.status === 200)!;
      expect(probeResponse.body.data).toMatchObject({
        circuitProbe: true,
        circuitState: 'half_open',
      });
      expect(await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED)).toHaveLength(1);
      expect(await samples(id)).toHaveLength(1);
      expect(
        (await audits(id, AUDIT_ACTIONS.PROVIDER_TEST_SENT)).filter(
          (a) => (a.after as { outcome: string }).outcome === 'short_circuited',
        ),
      ).toHaveLength(3);
    });

    it('a probe in flight holds the slot: every concurrent submission is refused half_open until it answers, and then the slot is free again', async () => {
      const id = await plantOpenPastCooldown();
      const held = holdNextSubmission();
      const probeRequest = send('tester', id, 'SUCCESS').then((r) => r);
      await until(held.isEntered, 'the probe to reach the adapter');
      const row = await providerRow(id);
      expect(row.circuitProbeId).not.toBeNull();
      expect(row.circuitProbeLeaseUntil!.toISOString()).toBe(
        new Date(clock.now().getTime() + C.PROBE_LEASE_MS).toISOString(),
      );
      const refused = await Promise.all([
        send('tester', id, 'SUCCESS'),
        send('platform', id, '500'),
        send('tester', id, 'SUCCESS'),
      ]);
      expect(refused.map((r) => r.status)).toEqual([409, 409, 409]);
      held.release();
      expect((await probeRequest).body.data).toMatchObject({ circuitProbe: true });
      expect((await providerRow(id)).circuitProbeId).toBeNull();
      expect((await send('tester', id, 'SUCCESS').expect(200)).body.data).toMatchObject({
        circuitProbe: true,
        circuitState: 'closed',
      });
    });

    it('a slow answer from an earlier episode is stale: it cannot trip a re-closed circuit', async () => {
      const id = await plantProvider();
      const held = holdNextSubmission();
      const slow = send('tester', id, '500').then((r) => r); // admitted in generation 0
      await until(held.isEntered, 'the slow submission');
      for (let i = 0; i < 5; i++) await send('tester', id, '500').expect(200); // → open, gen 1
      clock.advance(C.COOLDOWN_MS);
      await send('tester', id, 'SUCCESS').expect(200); // T2 → gen 2, probe 1
      await send('tester', id, 'SUCCESS').expect(200); // T4 → closed, gen 3
      for (let i = 0; i < 4; i++) await send('tester', id, '500').expect(200); // 4 in gen 3
      expect(await providerRow(id)).toMatchObject({ circuitState: 'closed', circuitGeneration: 3 });
      held.release();
      const res = await slow;
      expect(res.status).toBe(200);
      // Recorded, tagged with the generation it was admitted in — and it changed nothing.
      expect(res.body.data.circuitState).toBe('closed');
      expect(await providerRow(id)).toMatchObject({ circuitState: 'closed', circuitGeneration: 3 });
      const last = (await samples(id)).at(-1)!;
      expect([last.circuitGeneration, last.outcome]).toEqual([0, 'provider_error']);
      expect(await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED)).toHaveLength(3);
    });

    it('an abandoned probe: its lease expires, the slot is reclaimed, and its late answer neither re-opens the circuit nor releases the new probe', async () => {
      const id = await plantOpenPastCooldown();
      const abandonedBefore = await metric('acc_provider_circuit_probes_total', {
        provider: id,
        outcome: 'abandoned',
      });
      const first = holdNextSubmission();
      const late = send('tester', id, '500').then((r) => r); // probe A — will fail, late
      await until(first.isEntered, 'probe A');
      const slotA = (await providerRow(id)).circuitProbeId;
      expect((await send('tester', id, 'SUCCESS')).status).toBe(409); // slot held
      clock.advance(C.PROBE_LEASE_MS); // A's lease expires
      const second = holdNextSubmission();
      const fresh = send('tester', id, 'SUCCESS').then((r) => r); // probe B — reclaims
      await until(second.isEntered, 'probe B');
      const slotB = (await providerRow(id)).circuitProbeId;
      expect(slotB).not.toBeNull();
      expect(slotB).not.toBe(slotA);
      expect(
        await metric('acc_provider_circuit_probes_total', { provider: id, outcome: 'abandoned' }),
      ).toBe(abandonedBefore + 1);

      first.release();
      expect((await late).body.data).toMatchObject({
        circuitProbe: true,
        circuitState: 'half_open',
      });
      // A's failure is stale: not re-opened, B still holds the slot.
      expect(await providerRow(id)).toMatchObject({
        circuitState: 'half_open',
        circuitGeneration: 2,
        circuitProbeId: slotB,
        circuitProbeSuccesses: 0,
      });
      expect(
        await metric('acc_provider_circuit_probes_total', { provider: id, outcome: 'stale' }),
      ).toBe(1);
      second.release();
      await fresh;
      expect(await providerRow(id)).toMatchObject({
        circuitProbeId: null,
        circuitProbeSuccesses: 1,
      });
      expect(
        (await audits(id, AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED)).map(
          (a) => (a.after as { cause: string }).cause,
        ),
      ).toEqual(['cooldown_elapsed']);
    });

    it('a lifecycle transition and a circuit transition on the same provider serialize, and both survive', async () => {
      const id = await plantProvider();
      for (let i = 0; i < 4; i++) await send('tester', id, '500').expect(200);
      // The fifth failure is admitted while active, then held in flight; its
      // recording and the drain then queue on the same row lock.
      const held = holdNextSubmission();
      const fifth = send('tester', id, '500').then((r) => r);
      await until(held.isEntered, 'the fifth submission');
      const lock = await holdProviderLock(id);
      held.release();
      const drain = call('post', tokens.platform!, `/providers/${id}/drain`).then((r) => r);
      await waitForLockWaiters(2);
      await lock.release();
      const [a, b] = await Promise.all([fifth, drain]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await providerRow(id)).toMatchObject({
        status: 'draining',
        circuitState: 'open',
        circuitGeneration: 1,
      });
    });
  });

  // ===========================================================================
  describe('F. lifecycle versus circuit', () => {
    it('a disabled or draining provider is refused on its status whatever its circuit, and the circuit is never consulted', async () => {
      for (const status of ['disabled', 'draining'] as const) {
        const cases = [
          await plantProvider({ status, circuit: 'open' }), // inside the cooldown
          await plantOpenPastCooldown(status), // past it: would half-open
          await plantProvider({ status, circuit: 'half_open', generation: 2 }),
        ];
        // half_open with its slot held by someone else
        await h.admin
          .update(schema.providers)
          .set({
            circuitProbeId: uuidv7(),
            circuitProbeLeaseUntil: new Date(clock.now().getTime() + C.PROBE_LEASE_MS),
          })
          .where(eq(schema.providers.id, cases[2]!));
        for (const id of cases) {
          const before = await providerRow(id);
          const rejections = await metric('acc_provider_circuit_rejections_total', {
            provider: id,
          });
          const res = await send('tester', id, 'SUCCESS').expect(409);
          expect(res.body.error).toMatchObject({
            code: ERROR_CODES.PROVIDER_LIFECYCLE_CONFLICT,
            details: { status },
          });
          const after = await providerRow(id);
          expect([after.circuitState, after.circuitGeneration, after.circuitProbeId]).toEqual([
            before.circuitState,
            before.circuitGeneration,
            before.circuitProbeId,
          ]);
          expect(await audits(id)).toHaveLength(0); // no T2, no short-circuit row
          expect(await samples(id)).toHaveLength(0);
          expect(await metric('acc_provider_circuit_rejections_total', { provider: id })).toBe(
            rejections,
          );
        }
      }
    });

    it('lifecycle transitions never change health or circuit; re-enabling leaves an open circuit open', async () => {
      const id = await plantProvider();
      for (let i = 0; i < 5; i++) await send('tester', id, '500').expect(200);
      const open = await providerRow(id);
      expect([open.circuitState, open.healthState]).toEqual(['open', 'offline']);
      await call('post', tokens.platform!, `/providers/${id}/disable`).expect(200);
      await call('post', tokens.platform!, `/providers/${id}/enable`).expect(200);
      const after = await providerRow(id);
      expect([after.circuitState, after.circuitGeneration, after.healthState]).toEqual([
        'open',
        1,
        'offline',
      ]);
      expect((await send('tester', id, 'SUCCESS').expect(409)).body.error.code).toBe(
        ERROR_CODES.PROVIDER_CIRCUIT_OPEN,
      );
      // Re-enabled, past the cooldown, it recovers only through probes.
      clock.advance(C.COOLDOWN_MS);
      expect((await send('tester', id, 'SUCCESS').expect(200)).body.data.circuitProbe).toBe(true);
    });

    it('health never gates a submission: an offline override still admits a test-send', async () => {
      const id = await plantProvider();
      await override('manager', id, { override: 'offline' }).expect(200);
      const res = await send('tester', id, 'SUCCESS').expect(200);
      expect(res.body.data).toMatchObject({
        outcome: 'accepted',
        healthState: 'offline',
        circuitState: 'closed',
      });
    });
  });

  // ===========================================================================
  describe('G. authorization — platform-scope providers.* only', () => {
    const routes = (id: string) =>
      [
        ['post', `/providers/${id}/health-check`, { behavior: 'HEALTHY' }],
        ['post', `/providers/${id}/health`, { override: 'offline' }],
        ['get', `/providers/${id}/health`, undefined],
      ] as const;

    async function refusedEverywhere(who: string, expected: number, org?: string) {
      const id = await plantProvider();
      const before = await sampleCount();
      for (const [method, path, body] of routes(id)) {
        const res = await call(method, tokens[who] ?? null, path, body, org);
        expect(`${who} ${method} ${path} → ${res.status}`).toBe(
          `${who} ${method} ${path} → ${expected}`,
        );
      }
      expect(await sampleCount()).toBe(before);
      expect(await healthAudits(id)).toBe(0);
      expect(await providerRow(id)).toMatchObject({ healthState: 'healthy', healthOverride: null });
    }

    it('unauthenticated: 401 on every health route', async () => {
      await refusedEverywhere('nobody', 401);
    });

    it('an organization administrator — with or without its organization named — a reseller administrator, alendei_support and an API key: 403 on every health route, nothing recorded', async () => {
      await refusedEverywhere('orgAdmin', 403);
      await refusedEverywhere('orgAdmin', 403, tenant.orgId);
      await refusedEverywhere('reseller', 403);
      await refusedEverywhere('support', 403);
      await refusedEverywhere('apiKey', 403);
    });

    it('a tenant role composed with every providers.* permission at the organization reaches nothing', async () => {
      await refusedEverywhere('tenantComposed', 403, tenant.orgId);
      const id = await plantProvider();
      await send('tenantComposed', id, 'SUCCESS').expect(403);
    });

    it('a test_send-only role cannot probe or override; a read-only role reads the history only; a manage-only role probes and overrides but cannot test-send', async () => {
      const id = await plantProvider();
      await probe('tester', id, 'HEALTHY').expect(403);
      await override('tester', id, { override: 'offline' }).expect(403);
      await history('tester', id).expect(200);
      await probe('reader', id, 'HEALTHY').expect(403);
      await override('reader', id, { override: 'offline' }).expect(403);
      await send('reader', id, 'SUCCESS').expect(403);
      await history('reader', id).expect(200);
      await probe('manager', id, 'HEALTHY').expect(200);
      await override('manager', id, { override: 'degraded' }).expect(200);
      await send('manager', id, 'SUCCESS').expect(403);
      // Each refusal is an audited denial of the platform-scope decision, in the
      // actor's own name. It is filed at platform scope — or at the organization
      // selected implicitly when the database holds exactly one (ADR-003 D-4,
      // ADR-013 2.1 notes (d)) — so the attempted scope is what is invariant.
      const denials = (
        await h.admin.execute<{
          actor_user_id: string;
          scope_type: string;
          metadata: { attemptedScopeType: string; permission: string };
        }>(
          sql`select actor_user_id, scope_type, metadata from audit_logs where action = 'authorization.denied' and actor_user_id in (${list([people.tester!.userId, people.reader!.userId, people.manager!.userId])})`,
        )
      ).rows;
      expect(denials).toHaveLength(6);
      expect(new Set(denials.map((d) => d.metadata.attemptedScopeType))).toEqual(
        new Set(['platform']),
      );
      expect(denials.map((d) => d.metadata.permission).sort()).toEqual([
        'providers.manage',
        'providers.manage',
        'providers.manage',
        'providers.manage',
        'providers.test_send',
        'providers.test_send',
      ]);
      for (const d of denials) expect(['platform', 'organization']).toContain(d.scope_type);
    });

    it('forged scope and tenant identifiers are refused or inert: header, query and body', async () => {
      const id = await plantProvider();
      // A selected organization never widens a platform decision.
      await probe('orgAdmin', id, 'HEALTHY').set('x-acc-organization', tenant.orgId).expect(403);
      // Unknown query parameters on the history are refused, never applied as filters.
      for (const q of [
        `?orgId=${tenant.orgId}`,
        '?providerId=x',
        '?scopeType=platform',
        '?kind=probe',
      ]) {
        await history('reader', id, q).expect(400);
      }
      // Nothing in a body can name another provider, a tenant or a state.
      for (const body of [
        { behavior: 'HEALTHY', providerId: uuidv7() },
        { behavior: 'HEALTHY', orgId: tenant.orgId },
        { behavior: 'HEALTHY', circuitState: 'closed' },
        { behavior: 'HEALTHY', tenantId: tenant.orgId },
      ]) {
        await call('post', tokens.manager!, `/providers/${id}/health-check`, body).expect(400);
      }
      for (const body of [
        { behavior: 'SUCCESS', circuitProbe: true },
        { behavior: 'SUCCESS', circuitState: 'closed' },
        { behavior: 'SUCCESS', generation: 0 },
      ]) {
        await call('post', tokens.tester!, `/providers/${id}/test-send`, body).expect(400);
      }
      expect(await samples(id)).toHaveLength(0);
    });

    it('the sample history: newest first, keyset-paginated, 404 for an unknown provider after authorization', async () => {
      const id = await plantProvider();
      await probe('manager', id, 'HEALTHY').expect(200);
      await send('tester', id, '500').expect(200);
      await override('manager', id, { override: 'critical' }).expect(200);
      const page1 = await history('reader', id, '?limit=2').expect(200);
      expect(page1.body.data.map((s: { kind: string }) => s.kind)).toEqual([
        'override',
        'submission',
      ]);
      expect(page1.body.page).toMatchObject({ hasMore: true, limit: 2 });
      const page2 = await history(
        'reader',
        id,
        `?limit=2&cursor=${encodeURIComponent(page1.body.page.nextCursor)}`,
      ).expect(200);
      expect(page2.body.data.map((s: { kind: string }) => s.kind)).toEqual(['probe']);
      expect(page2.body.page.hasMore).toBe(false);
      expect(Object.keys(page1.body.data[0]).sort()).toEqual(
        [
          'id',
          'providerId',
          'kind',
          'outcome',
          'classification',
          'latencyMs',
          'healthState',
          'circuitState',
          'circuitGeneration',
          'source',
          'observedAt',
          'createdAt',
        ].sort(),
      );
      await history('reader', uuidv7()).expect(404);
      await history('orgAdmin', uuidv7()).expect(403); // authorize before disclosing
    });
  });

  // ===========================================================================
  describe('H. the database boundary, with the service bypassed', () => {
    const insertSample = (
      providerId: string,
      kind: string,
      outcome: string,
      classification: string,
    ) =>
      `insert into provider_health (provider_id, kind, outcome, classification, latency_ms, health_state, circuit_state, circuit_generation, source, observed_at)
       values ('${providerId}', '${kind}', '${outcome}', '${classification}', ${kind === 'override' ? 'null' : '0'}, 'healthy', 'closed', 0, '${kind === 'override' ? 'manual' : 'automatic'}', now())`;

    it('provider_health: RLS enabled, acc_app-only SELECT/INSERT; without a validated platform claim zero rows and no insert', async () => {
      const id = await plantProvider();
      await probe('manager', id, 'HEALTHY').expect(200);
      const { rows: rls } = await h.admin.execute<{ rls: boolean }>(
        sql`select relrowsecurity as rls from pg_class where relname = 'provider_health'`,
      );
      expect(rls[0]!.rls).toBe(true);
      const { rows: grants } = await h.admin.execute<{ grantee: string; privilege_type: string }>(
        sql`select grantee, privilege_type from information_schema.role_table_grants where table_name = 'provider_health' and grantee <> 'postgres' order by grantee, privilege_type`,
      );
      expect(grants.map((g) => `${g.grantee}:${g.privilege_type}`)).toEqual([
        'acc_app:INSERT',
        'acc_app:SELECT',
      ]);
      // A tenant user, no user, a forged platform flag: nothing visible, nothing writable.
      for (const [userId, flag] of [
        [tenant.userId, false],
        [null, false],
        [tenant.userId, true],
      ] as const) {
        await asApp(
          userId,
          async (c) => {
            expect((await c.query('select count(*)::int n from provider_health')).rows[0].n).toBe(
              0,
            );
            expect(await attempt(c, insertSample(id, 'probe', 'healthy', 'success'))).toBe('42501');
          },
          flag,
        );
      }
      // A validated platform-scope principal — even one without a providers permission — reads.
      await asApp(people.support!.userId, async (c) => {
        expect(
          (
            await c.query('select count(*)::int n from provider_health where provider_id = $1', [
              id,
            ])
          ).rows[0].n,
        ).toBe(1);
      });
      for (const pool of [authPool, relayPool]) {
        await asPrincipal(pool, people.platform!.userId, async (c) => {
          expect(await attempt(c, 'select 1 from provider_health')).toBe('42501');
        });
      }
    });

    it('a sample insert is bound to the permission of the operation that writes it: submission ← test_send, probe and override ← manage', async () => {
      const id = await plantProvider();
      const matrix: [string, string, string, string, string][] = [
        // who, kind, outcome, classification, expected
        ['tester', 'submission', 'accepted', 'success', 'ok'],
        ['tester', 'probe', 'healthy', 'success', '42501'],
        ['tester', 'override', 'manual', 'neutral', '42501'],
        ['manager', 'submission', 'accepted', 'success', '42501'],
        ['manager', 'probe', 'healthy', 'success', 'ok'],
        ['manager', 'override', 'manual', 'neutral', 'ok'],
        ['platform', 'submission', 'accepted', 'success', 'ok'],
        ['platform', 'probe', 'healthy', 'success', 'ok'],
        ['reader', 'submission', 'accepted', 'success', '42501'],
        ['reader', 'probe', 'healthy', 'success', '42501'],
        ['support', 'probe', 'healthy', 'success', '42501'],
      ];
      for (const [who, kind, outcome, classification, expected] of matrix) {
        await asApp(people[who]!.userId, async (c) => {
          expect(
            `${who} ${kind} → ${await attempt(c, insertSample(id, kind, outcome, classification))}`,
          ).toBe(`${who} ${kind} → ${expected}`);
        });
      }
    });

    it('append-only: no principal — the owner included — can update, delete or truncate a sample', async () => {
      const id = await plantProvider();
      await probe('manager', id, 'HEALTHY').expect(200);
      await asApp(people.platform!.userId, async (c) => {
        expect(
          await attempt(
            c,
            `update provider_health set outcome = 'unhealthy' where provider_id = '${id}'`,
          ),
        ).toBe('42501');
        expect(await attempt(c, `delete from provider_health where provider_id = '${id}'`)).toBe(
          '42501',
        );
      });
      for (const statement of [
        sql`update provider_health set latency_ms = 1 where provider_id = ${id}`,
        sql`delete from provider_health where provider_id = ${id}`,
        sql`truncate provider_health`,
      ]) {
        await expect(h.admin.execute(statement)).rejects.toMatchObject({
          cause: { code: '42501' },
        });
      }
      expect(await samples(id)).toHaveLength(1);
    });

    it('the classification is fixed by the outcome: a misclassified or mis-sourced sample is refused even for the owner', async () => {
      const id = await plantProvider();
      for (const [kind, outcome, classification] of [
        ['submission', 'provider_error', 'success'],
        ['submission', 'timeout', 'neutral'],
        ['submission', 'rate_limited', 'neutral'],
        ['submission', 'invalid_request', 'failure'],
        ['submission', 'accepted', 'failure'],
        ['probe', 'unhealthy', 'success'],
        ['probe', 'accepted', 'success'],
        ['submission', 'healthy', 'success'],
        ['override', 'manual', 'success'],
      ]) {
        await expect(
          h.admin.execute(sql.raw(insertSample(id, kind!, outcome!, classification!))),
        ).rejects.toMatchObject({
          cause: { code: '23514' },
        });
      }
    });

    it('the state guard: a test_send holder may write observation state only — administrative columns and the override need providers.manage', async () => {
      const id = await plantProvider();
      const row = (who: string, set: string) =>
        asApp(people[who]!.userId, (c) =>
          attempt(c, `update providers set ${set} where id = '${id}'`),
        );
      expect(await row('tester', `name = 'renamed'`)).toBe('42501');
      expect(await row('tester', `status = 'disabled'`)).toBe('42501');
      expect(await row('tester', `adapter_key = 'other'`)).toBe('42501');
      expect(await row('tester', `channel_id = channel_id`)).toBe('ok'); // no change is no change
      expect(await row('tester', `health_override = 'offline', health_state = 'offline'`)).toBe(
        '42501',
      );
      expect(await row('tester', `health_state = 'degraded', health_changed_at = now()`)).toBe(
        'ok',
      );
      expect(
        await row(
          'tester',
          `circuit_state = 'open', circuit_generation = 1, circuit_changed_at = now()`,
        ),
      ).toBe('ok');
      // A read-only or support principal updates nothing at all (RLS: zero rows).
      expect(await row('reader', `health_state = 'degraded'`)).toBe('none');
      expect(await row('support', `health_state = 'degraded'`)).toBe('none');
      // A manager may do both.
      expect(
        await row(
          'manager',
          `name = 'renamed ${suffix()}', health_override = 'offline', health_state = 'offline'`,
        ),
      ).toBe('ok');
    });

    it('the state guard: only the four circuit edges, each advancing the generation by exactly one — for every application principal', async () => {
      const closed = await plantProvider();
      const open = await plantProvider({ circuit: 'open', generation: 1 });
      const half = await plantProvider({ circuit: 'half_open', generation: 2 });
      const tryAs = (who: string, id: string, set: string) =>
        asApp(people[who]!.userId, (c) =>
          attempt(c, `update providers set ${set} where id = '${id}'`),
        );
      for (const who of ['tester', 'platform']) {
        expect(
          await tryAs(
            who,
            closed,
            `circuit_state = 'half_open', circuit_generation = 1, circuit_changed_at = now()`,
          ),
        ).toBe('23514');
        expect(await tryAs(who, open, `circuit_state = 'closed', circuit_generation = 2`)).toBe(
          '23514',
        );
        expect(
          await tryAs(
            who,
            closed,
            `circuit_state = 'open', circuit_generation = 2, circuit_changed_at = now()`,
          ),
        ).toBe('23514');
        expect(
          await tryAs(
            who,
            closed,
            `circuit_state = 'open', circuit_generation = 0, circuit_changed_at = now()`,
          ),
        ).toBe('23514');
        expect(await tryAs(who, closed, `circuit_generation = 5`)).toBe('23514');
        expect(await tryAs(who, open, `circuit_generation = 0`)).toBe('23514'); // a stale writer
        expect(await tryAs(who, open, `circuit_state = 'half_open', circuit_generation = 2`)).toBe(
          'ok',
        );
        expect(
          await tryAs(
            who,
            half,
            `circuit_state = 'open', circuit_generation = 3, circuit_changed_at = now()`,
          ),
        ).toBe('ok');
        expect(await tryAs(who, half, `circuit_state = 'closed', circuit_generation = 3`)).toBe(
          'ok',
        );
      }
      // The consistency checks hold for everyone, the owner included.
      await expect(
        h.admin.execute(
          sql`update providers set circuit_probe_id = ${uuidv7()} where id = ${closed}`,
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(
        h.admin.execute(sql`update providers set health_override = 'offline' where id = ${closed}`),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });

    it('the audit policy admits exactly: health_checked and health_overridden for manage, circuit_changed for test_send, health_changed for either — in one’s own name, never denied', async () => {
      const id = await plantProvider();
      const row = (actor: string, action: string, outcome = 'success') =>
        `insert into audit_logs (scope_type, scope_id, actor_type, actor_user_id, action, resource_type, resource_id, outcome, metadata, correlation_id)
         values ('platform', null, 'user', '${actor}', '${action}', 'Provider', '${id}', '${outcome}', '{}'::jsonb, '${uuidv7()}')`;
      const matrix: [string, string, string, string][] = [
        ['manager', 'provider.health_checked', 'success', 'ok'],
        ['manager', 'provider.health_checked', 'failure', 'ok'],
        ['manager', 'provider.health_checked', 'denied', '42501'],
        ['manager', 'provider.health_overridden', 'success', 'ok'],
        ['manager', 'provider.health_overridden', 'failure', '42501'],
        ['manager', 'provider.health_changed', 'success', 'ok'],
        ['manager', 'provider.circuit_changed', 'success', '42501'],
        ['tester', 'provider.health_changed', 'success', 'ok'],
        ['tester', 'provider.circuit_changed', 'success', 'ok'],
        ['tester', 'provider.circuit_changed', 'failure', '42501'],
        ['tester', 'provider.health_checked', 'success', '42501'],
        ['tester', 'provider.health_overridden', 'success', '42501'],
        ['reader', 'provider.health_changed', 'success', '42501'],
        ['support', 'provider.health_changed', 'success', '42501'],
        ['support', 'provider.circuit_changed', 'success', '42501'],
      ];
      for (const [who, action, outcome, expected] of matrix) {
        await asApp(people[who]!.userId, async (c) => {
          expect(
            `${who} ${action} ${outcome} → ${await attempt(c, row(people[who]!.userId, action, outcome))}`,
          ).toBe(`${who} ${action} ${outcome} → ${expected}`);
        });
      }
      // Never in another user's name; never with a forged flag.
      await asApp(people.tester!.userId, async (c) => {
        expect(await attempt(c, row(people.platform!.userId, 'provider.circuit_changed'))).toBe(
          '42501',
        );
      });
      await asApp(
        tenant.userId,
        async (c) => {
          expect(await attempt(c, row(tenant.userId, 'provider.health_changed'))).toBe('42501');
        },
        true,
      );
    });

    it('policies and functions: exact predicates, no role names, no new SECURITY DEFINER; the two trigger functions are invoker', async () => {
      const { rows: policies } = await h.admin.execute<{
        tablename: string;
        policyname: string;
        cmd: string;
        roles: string;
        qual: string | null;
        with_check: string | null;
      }>(
        sql`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where tablename = 'provider_health' or policyname in ('providers_platform_observation_update','audit_logs_provider_health_insert') order by policyname`,
      );
      const TEST_SEND = "app_has_platform_permission('providers.test_send'::text)";
      const MANAGE = "app_has_platform_permission('providers.manage'::text)";
      expect(policies.map((p) => `${p.tablename}.${p.policyname}:${p.cmd}:${p.roles}`)).toEqual([
        'audit_logs.audit_logs_provider_health_insert:INSERT:{acc_app}',
        'provider_health.provider_health_platform_insert:INSERT:{acc_app}',
        'provider_health.provider_health_platform_read:SELECT:{acc_app}',
        'providers.providers_platform_observation_update:UPDATE:{acc_app}',
      ]);
      const by = Object.fromEntries(policies.map((p) => [p.policyname, p]));
      expect(by.provider_health_platform_read!.qual).toBe('app_has_platform_scope()');
      expect(by.provider_health_platform_insert!.with_check).toContain(TEST_SEND);
      expect(by.provider_health_platform_insert!.with_check).toContain(MANAGE);
      expect(by.providers_platform_observation_update!.qual).toBe(TEST_SEND);
      expect(by.providers_platform_observation_update!.with_check).toBe(TEST_SEND);
      const audit = by.audit_logs_provider_health_insert!.with_check!;
      for (const fragment of [
        "'provider.health_checked'",
        "'provider.health_overridden'",
        "'provider.health_changed'",
        "'provider.circuit_changed'",
        'app_current_user_id()',
        TEST_SEND,
        MANAGE,
      ])
        expect(audit).toContain(fragment);
      for (const p of policies)
        expect(`${p.qual ?? ''} ${p.with_check ?? ''}`).not.toMatch(
          /alendei_|is_platform_admin|r\.key/,
        );

      const { rows: fns } = await h.admin.execute<{
        proname: string;
        secdef: boolean;
        src: string;
      }>(
        sql`select proname, prosecdef as secdef, prosrc as src from pg_proc where proname in ('fn_providers_state_guard', 'fn_provider_health_append_only') order by proname`,
      );
      expect(fns.map((f) => `${f.proname}:${f.secdef}`).sort()).toEqual([
        'fn_provider_health_append_only:false',
        'fn_providers_state_guard:false',
      ]);
      for (const f of fns) expect(f.src).not.toMatch(/alendei_|is_platform_admin/);
      // The SECURITY DEFINER inventory is what Phase 2.2 left: nothing added by 0022.
      const { rows: definers } = await h.admin.execute<{ proname: string }>(
        sql`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and (p.proname like '%provider%' or p.proname like 'app_has_platform%')`,
      );
      expect(definers.map((d) => d.proname).sort()).toEqual([
        'app_has_platform_permission',
        'app_has_platform_scope',
      ]);
      const { rows: triggers } = await h.admin.execute<{ tgname: string }>(
        sql`select tgname from pg_trigger where tgrelid in ('providers'::regclass, 'provider_health'::regclass) and not tgisinternal order by tgname`,
      );
      expect(triggers.map((t) => t.tgname).sort()).toEqual([
        'trg_provider_health_append_only',
        'trg_provider_health_no_truncate',
        'trg_providers_state_guard',
        'trg_providers_updated_at',
      ]);
    });
  });

  // ===========================================================================
  describe('I. observability', () => {
    it('health checks, gauges, transitions, rejections and probes move exactly; every label is bounded', async () => {
      const id = await plantProvider();
      const checks = (outcome: string) =>
        metric('acc_provider_health_checks_total', { channel: 'sms', outcome });
      const [healthyBefore, unhealthyBefore] = [await checks('healthy'), await checks('unhealthy')];
      await probe('manager', id, 'HEALTHY').expect(200);
      for (let i = 0; i < 5; i++) await probe('manager', id, 'UNHEALTHY').expect(200);
      expect(await checks('healthy')).toBe(healthyBefore + 1);
      expect(await checks('unhealthy')).toBe(unhealthyBefore + 5);
      expect(await metric('acc_provider_health_state', { provider: id, status: 'offline' })).toBe(
        1,
      );
      expect(await metric('acc_provider_health_state', { provider: id, status: 'healthy' })).toBe(
        0,
      );
      expect(
        await metric('acc_provider_health_transitions_total', {
          provider: id,
          from_state: 'healthy',
          to_state: 'critical', // after H,U,U,U,U: 4 of 5
        }),
      ).toBe(1);
      expect(
        await metric('acc_provider_health_transitions_total', {
          provider: id,
          from_state: 'critical',
          to_state: 'offline', // the fifth U: five in a row
        }),
      ).toBe(1);

      for (let i = 0; i < 5; i++) await send('tester', id, '500').expect(200);
      const transition = (from: string, to: string) =>
        metric('acc_provider_circuit_transitions_total', {
          provider: id,
          from_state: from,
          to_state: to,
        });
      expect(await transition('closed', 'open')).toBe(1);
      expect(await metric('acc_provider_circuit_state', { provider: id, status: 'open' })).toBe(1);
      expect(await metric('acc_provider_circuit_state', { provider: id, status: 'closed' })).toBe(
        0,
      );
      await send('tester', id, 'SUCCESS').expect(409);
      expect(
        await metric('acc_provider_circuit_rejections_total', { provider: id, status: 'open' }),
      ).toBe(1);
      clock.advance(C.COOLDOWN_MS);
      await send('tester', id, 'SUCCESS').expect(200);
      await send('tester', id, 'SUCCESS').expect(200);
      expect(await transition('open', 'half_open')).toBe(1);
      expect(await transition('half_open', 'closed')).toBe(1);
      expect(
        await metric('acc_provider_circuit_probes_total', { provider: id, outcome: 'success' }),
      ).toBe(2);
      expect(await metric('acc_provider_circuit_state', { provider: id, status: 'closed' })).toBe(
        1,
      );

      const text = await scrape();
      const families = [
        'acc_provider_health_checks_total',
        'acc_provider_health_state',
        'acc_provider_health_transitions_total',
        'acc_provider_circuit_state',
        'acc_provider_circuit_transitions_total',
        'acc_provider_circuit_rejections_total',
        'acc_provider_circuit_probes_total',
      ];
      for (const family of families) {
        const lines = text.split('\n').filter((l) => l.startsWith(`${family}{`));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines)
          for (const label of FORBIDDEN_LABELS) expect(line).not.toContain(`${label}=`);
      }
    });
  });
});
