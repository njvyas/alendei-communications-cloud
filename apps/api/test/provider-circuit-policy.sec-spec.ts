/**
 * Gate D.3 remediation — the administrable circuit policy (`PROVIDER_ADAPTER.md`
 * §6a, §6h, §6i; ADR-013 "Gate D.3 remediation design").
 *
 * Real HTTP against the real database. The policy is one platform-wide row the
 * other provider suites rely on, so every case here leaves it as seeded (the
 * owner restores it after each case, advancing the version as the database
 * requires). Time is the injected provider clock; concurrency is made
 * deterministic by parking requests on a row lock the test holds.
 */
import { randomBytes } from 'node:crypto';

import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PLATFORM_ROLE_KEYS,
  PROVIDER_CIRCUIT_DEFAULTS as SEEDED,
  PROVIDER_CIRCUIT_POLICY_BOUNDS as B,
  PROVIDER_CIRCUIT_POLICY_FIELDS,
  type ProviderCircuitPolicy,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { ProviderSubmissionExecutor } from '../src/provider-adapters/submission-executor';
import { routingEligibility } from '../src/providers/provider-state-machine';
import { circuitPolicyOf, circuitSnapshot } from '../src/providers/provider-views';
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

jest.setTimeout(60_000);

interface Person {
  userId: string;
  email: string;
}

describe('Gate D.3 remediation — the administrable circuit policy', () => {
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
  const outstanding: (() => Promise<void> | void)[] = [];
  let channelSms: string;
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
    const email = `cp-${label}-${suffix()}@example.test`;
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
          key: `test_cp_${suffix()}`,
          name: 'Test circuit-policy role',
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
    method: 'get' | 'put' | 'post',
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
  const getPolicy = (who: string) => call('get', who, '/provider-circuit-policy');
  const putPolicy = (who: string, body: object, org?: string) =>
    call('put', who, '/provider-circuit-policy', body, org);
  const send = (who: string, id: string, behavior: string) =>
    call('post', who, `/providers/${id}/test-send`, { behavior });

  const storedPolicy = async () => (await h.admin.select().from(schema.providerCircuitPolicy))[0]!;

  /** Replaces the policy through the API as the manager, from the stored version. */
  async function setPolicy(overrides: Partial<ProviderCircuitPolicy>) {
    const current = await storedPolicy();
    const res = await putPolicy('manager', {
      ...circuitPolicyOf(current),
      ...overrides,
      expectedVersion: current.version,
    }).expect(200);
    return res.body.data as ProviderCircuitPolicy & { version: number; updatedAt: string };
  }

  /** The owner puts the seeded values back (the version still advances by one). */
  async function restoreSeeded() {
    const current = await storedPolicy();
    if (PROVIDER_CIRCUIT_POLICY_FIELDS.every((f) => current[f] === SEEDED[f])) return;
    await h.admin
      .update(schema.providerCircuitPolicy)
      .set({ ...SEEDED, version: current.version + 1 })
      .where(eq(schema.providerCircuitPolicy.scope, 'platform'));
  }

  const policyAudits = async () =>
    (
      await h.admin.execute<Record<string, unknown>>(
        sql`select * from audit_logs where action = ${AUDIT_ACTIONS.PROVIDER_CIRCUIT_POLICY_UPDATED} order by id`,
      )
    ).rows;

  async function plantProvider(
    options: { circuit?: 'closed' | 'open'; changedAt?: Date } = {},
  ): Promise<string> {
    const circuit = options.circuit ?? 'closed';
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelSms,
        name: `cp-${suffix()}`,
        adapterKey: 'simulator',
        status: 'active',
        circuitState: circuit,
        circuitGeneration: circuit === 'closed' ? 0 : 1,
        circuitChangedAt: circuit === 'closed' ? null : (options.changedAt ?? clock.now()),
      })
      .returning({ id: schema.providers.id });
    createdProviders.push(p!.id);
    return p!.id;
  }

  const providerRow = async (id: string) =>
    (await h.admin.select().from(schema.providers).where(eq(schema.providers.id, id)))[0]!;

  async function holdLock(statement: string, values: unknown[] = []) {
    const c = await lockPool.connect();
    await c.query('BEGIN');
    await c.query(statement, values);
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

  /** Holds every submission the executor receives until released, and counts them. */
  function gateExecutor() {
    const executor = h.app.get(ProviderSubmissionExecutor);
    const original = executor.execute.bind(executor);
    const waiting: (() => void)[] = [];
    const gate = {
      calls: 0,
      waiting,
      releaseOne: () => waiting.shift()?.(),
      releaseAll: () => waiting.splice(0).forEach((w) => w()),
    };
    outstanding.push(() => gate.releaseAll());
    jest.spyOn(executor, 'execute').mockImplementation(async (...args) => {
      gate.calls++;
      await new Promise<void>((resolve) => waiting.push(resolve));
      return original(...args);
    });
    return gate;
  }

  async function asPrincipal<T>(
    pool: Pool,
    userId: string | null,
    work: (c: PoolClient) => Promise<T>,
    isPlatformAdmin = false,
  ): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const [name, value] of [
        ['app.current_org_id', ''],
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

  /** Runs one statement in a savepoint: `ok`, `none` (an UPDATE that matched no row) or the SQLSTATE. */
  async function attempt(c: PoolClient, text: string, values: unknown[] = []) {
    await c.query('SAVEPOINT s');
    try {
      const res = await c.query(text, values);
      return res.rowCount === 0 && /^\s*(update|delete)/i.test(text) ? 'none' : 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? 'error';
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT s');
    }
  }

  beforeAll(async () => {
    h = await startHarness({ providerClock: clock });
    await new Promise<void>((resolve) => h.app.getHttpServer().listen(0, resolve));
    credentials = h.app.get(CredentialService);
    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    authPool = new Pool({ connectionString: process.env.DATABASE_AUTH_URL, max: 1 });
    relayPool = new Pool({ connectionString: process.env.DATABASE_RELAY_URL, max: 1 });
    lockPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
    tenant = await createTenant(h.admin, 'cp', credentials);
    await restoreSeeded();

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
        name: `cp-${suffix()}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        scopes: ['providers.read', 'providers.manage', 'providers.test_send'],
        createdBy: people.platform.userId,
      })
      .returning({ id: schema.apiKeys.id });
    tokens.apiKey = `${prefix}.${secret}`;
    apiKeyId = key!.id;

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
    await restoreSeeded();
  });

  afterAll(async () => {
    try {
      await restoreSeeded();
      await h.clearRateLimits();
      await purgeAudit(h.admin, sql`action = ${AUDIT_ACTIONS.PROVIDER_CIRCUIT_POLICY_UPDATED}`);
      if (createdProviders.length > 0) {
        await purgeAudit(h.admin, sql`resource_id IN (${list(createdProviders)})`);
        await purgeProviderHealth(h.admin, sql`provider_id IN (${list(createdProviders)})`);
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
    } finally {
      // Always release connections, even when a cleanup step fails (for
      // example on a mutated clone), so the run ends instead of hanging.
      await Promise.all([appPool.end(), authPool.end(), relayPool.end(), lockPool.end()]);
      await h.close();
    }
  }, 180_000);

  // ===========================================================================
  describe('A. read and replace', () => {
    it('a providers.manage administrator reads exactly the eight parameters, the version and updatedAt — no internal field', async () => {
      const current = await storedPolicy();
      for (const who of ['manager', 'platform']) {
        const res = await getPolicy(who).expect(200);
        expect(Object.keys(res.body.data).sort()).toEqual(
          [...PROVIDER_CIRCUIT_POLICY_FIELDS, 'version', 'updatedAt'].sort(),
        );
        expect(res.body.data).toMatchObject({ ...SEEDED, version: current.version });
      }
    });

    it('a replacement is persisted, advances the version by one, is audited with before and after, and is what the next read returns', async () => {
      const before = await storedPolicy();
      const next: ProviderCircuitPolicy = {
        windowMs: 120_000,
        windowMaxSamples: 30,
        minSamples: 8,
        failurePercent: 40,
        cooldownMs: 45_000,
        halfOpenMaxProbes: 3,
        probeLeaseMs: 20_000,
        halfOpenSuccessesToClose: 4,
      };
      const res = await putPolicy('manager', { ...next, expectedVersion: before.version }).expect(
        200,
      );
      expect(res.body.data).toMatchObject({ ...next, version: before.version + 1 });
      const stored = await storedPolicy();
      expect(circuitPolicyOf(stored)).toEqual(next);
      expect(stored.version).toBe(before.version + 1);
      expect((await getPolicy('platform').expect(200)).body.data).toMatchObject(next);

      const audits = await policyAudits();
      const row = audits.at(-1)!;
      expect(row).toMatchObject({
        action: 'provider.circuit_policy_updated',
        outcome: 'success',
        scope_type: 'platform',
        org_id: null,
        resource_type: 'ProviderCircuitPolicy',
        resource_id: null,
        actor_user_id: people.manager!.userId,
        before: { ...SEEDED, version: before.version },
        after: { ...next, version: before.version + 1 },
      });
    });

    it('re-sending the policy already in force changes nothing and records nothing', async () => {
      const before = await storedPolicy();
      const audits = (await policyAudits()).length;
      const res = await putPolicy('manager', {
        ...circuitPolicyOf(before),
        expectedVersion: before.version,
      }).expect(200);
      expect(res.body.data.version).toBe(before.version);
      expect((await storedPolicy()).version).toBe(before.version);
      expect(await policyAudits()).toHaveLength(audits);
    });

    it('a stale expectedVersion is 409 RESOURCE_CONFLICT naming the current version, and nothing changes', async () => {
      const before = await storedPolicy();
      const audits = (await policyAudits()).length;
      for (const stale of [before.version - 1, before.version + 1]) {
        if (stale < 1) continue;
        const res = await putPolicy('manager', {
          ...SEEDED,
          cooldownMs: 9_000,
          expectedVersion: stale,
        }).expect(409);
        expect(res.body.error).toMatchObject({
          code: ERROR_CODES.RESOURCE_CONFLICT,
          details: { currentVersion: before.version },
        });
      }
      expect(await storedPolicy()).toMatchObject({
        version: before.version,
        cooldownMs: SEEDED.cooldownMs,
      });
      expect(await policyAudits()).toHaveLength(audits);
    });
  });

  // ===========================================================================
  describe('B. validation — the safe bounds, at the API and at the database', () => {
    it('every parameter one below its minimum and one above its maximum is 400 naming the field; nothing changes', async () => {
      const before = await storedPolicy();
      const audits = (await policyAudits()).length;
      for (const field of PROVIDER_CIRCUIT_POLICY_FIELDS) {
        for (const value of [B[field].min - 1, B[field].max + 1]) {
          const body = { ...SEEDED, [field]: value, expectedVersion: before.version };
          // minSamples ≤ windowMaxSamples stays satisfied by the other bound, so
          // the only reason to refuse is the bound under test.
          if (field === 'windowMaxSamples' && value < SEEDED.minSamples) body.minSamples = 1;
          const res = await putPolicy('manager', body);
          expect(`${field}=${value} → ${res.status}`).toBe(`${field}=${value} → 400`);
          expect(JSON.stringify(res.body.error)).toContain(field);
        }
      }
      expect((await storedPolicy()).version).toBe(before.version);
      expect(await policyAudits()).toHaveLength(audits);
    });

    it('each bound itself is accepted', async () => {
      for (const edge of ['min', 'max'] as const) {
        const values = Object.fromEntries(
          PROVIDER_CIRCUIT_POLICY_FIELDS.map((f) => [f, B[f][edge]]),
        ) as unknown as ProviderCircuitPolicy;
        const current = await storedPolicy();
        await putPolicy('manager', { ...values, expectedVersion: current.version }).expect(200);
        expect(circuitPolicyOf(await storedPolicy())).toEqual(values);
      }
    });

    it('non-integers, strings, nulls, missing fields, minSamples above windowMaxSamples and any extra field are 400', async () => {
      const { version } = await storedPolicy();
      const base = { ...SEEDED, expectedVersion: version };
      const bodies: object[] = [
        { ...base, windowMs: 60_000.5 },
        { ...base, failurePercent: '50' },
        { ...base, cooldownMs: null },
        { ...base, expectedVersion: 0 },
        (({ probeLeaseMs: _omit, ...rest }) => rest)(base),
        (({ expectedVersion: _omit, ...rest }) => rest)(base),
        { ...base, minSamples: 21, windowMaxSamples: 20 },
        { ...base, version: version + 5 },
        { ...base, updatedAt: new Date().toISOString() },
        { ...base, scope: 'organization' },
        { ...base, orgId: tenant.orgId },
        { ...base, scopeType: 'organization', scopeId: tenant.orgId },
        { ...base, providerId: uuidv7() },
        { ...base, tenantId: tenant.orgId },
      ];
      for (const body of bodies) {
        const res = await putPolicy('manager', body);
        expect(`${JSON.stringify(body).slice(-70)} → ${res.status}`).toMatch(/→ 400$/);
      }
      const crossField = await putPolicy('manager', {
        ...base,
        minSamples: 21,
        windowMaxSamples: 20,
      });
      expect(crossField.body.error.details.issues[0]).toMatchObject({
        field: 'minSamples',
        rule: 'MIN_SAMPLES_ABOVE_MAX',
      });
      expect((await storedPolicy()).version).toBe(version);
    });

    it('the database refuses an out-of-range value, a version that does not advance by exactly one, and a key change — even from the owner', async () => {
      const current = await storedPolicy();
      const statements = [
        sql`update provider_circuit_policy set window_ms = 9999, version = version + 1`,
        sql`update provider_circuit_policy set failure_percent = 0, version = version + 1`,
        sql`update provider_circuit_policy set half_open_max_probes = 11, version = version + 1`,
        sql`update provider_circuit_policy set probe_lease_ms = 4999, version = version + 1`,
        sql`update provider_circuit_policy set min_samples = 50, window_max_samples = 20, version = version + 1`,
        sql`update provider_circuit_policy set cooldown_ms = 5000`,
        sql`update provider_circuit_policy set cooldown_ms = 5000, version = version + 2`,
        sql`update provider_circuit_policy set cooldown_ms = 5000, version = version - 1`,
        sql`update provider_circuit_policy set scope = 'other', version = version + 1`,
      ];
      for (const statement of statements) {
        await expect(h.admin.execute(statement)).rejects.toMatchObject({
          cause: { code: '23514' },
        });
      }
      await expect(
        h.admin.execute(
          sql`insert into provider_circuit_policy (scope, window_ms, window_max_samples, min_samples, failure_percent, cooldown_ms, half_open_max_probes, probe_lease_ms, half_open_successes_to_close) values ('second', 60000, 20, 5, 50, 30000, 1, 10000, 2)`,
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      expect(await storedPolicy()).toMatchObject({ version: current.version });
    });
  });

  // ===========================================================================
  describe('C. authorization — providers.manage at platform scope, nothing else', () => {
    async function refused(who: string | null, status: number, org?: string) {
      const before = await storedPolicy();
      const audits = (await policyAudits()).length;
      const read = await call('get', who, '/provider-circuit-policy', undefined, org);
      const write = await putPolicy(
        who ?? 'nobody',
        { ...SEEDED, cooldownMs: 7_000, expectedVersion: before.version },
        org,
      );
      expect(`${who} GET ${read.status} PUT ${write.status}`).toBe(
        `${who} GET ${status} PUT ${status}`,
      );
      expect(await storedPolicy()).toMatchObject({
        version: before.version,
        cooldownMs: before.cooldownMs,
      });
      expect(await policyAudits()).toHaveLength(audits);
    }

    it('unauthenticated: 401', async () => {
      await refused(null, 401);
    });

    it('organization administrator (with and without its organization named), reseller administrator, alendei_support and an API key holding every providers.* scope: 403, nothing changes, nothing is recorded as an update', async () => {
      await refused('orgAdmin', 403);
      await refused('orgAdmin', 403, tenant.orgId);
      await refused('reseller', 403);
      await refused('support', 403);
      await refused('apiKey', 403);
    });

    it('a tenant role composed with every providers.* permission at the organization: 403', async () => {
      await refused('tenantComposed', 403, tenant.orgId);
    });

    it('platform roles without providers.manage — test_send only, read only — cannot read or change it', async () => {
      await refused('tester', 403);
      await refused('reader', 403);
    });

    it('forged identifiers: a selected organization never widens or narrows the decision, and query parameters are refused', async () => {
      // A manager naming an organization is still deciding at platform scope.
      const current = await storedPolicy();
      await putPolicy(
        'manager',
        { ...SEEDED, cooldownMs: 6_000, expectedVersion: current.version },
        tenant.orgId,
      ).expect(200);
      expect((await storedPolicy()).cooldownMs).toBe(6_000);
      // The read takes no parameter: anything appended is inert — it can neither
      // select another scope nor another version.
      for (const q of [`?scope=organization`, `?orgId=${tenant.orgId}`, '?version=1']) {
        const res = await call('get', 'manager', `/provider-circuit-policy${q}`).expect(200);
        expect(res.body.data).toMatchObject({ cooldownMs: 6_000, version: current.version + 1 });
      }
    });

    it('the database boundary with the service bypassed: only a providers.manage holder can change the row; nobody can insert or delete one; acc_auth and acc_relay see nothing', async () => {
      const set = `update provider_circuit_policy set cooldown_ms = 8000, version = version + 1`;
      const matrix: [string | null, boolean, string][] = [
        [people.manager!.userId, false, 'ok'],
        [people.platform!.userId, false, 'ok'],
        [people.tester!.userId, false, 'none'],
        [people.reader!.userId, false, 'none'],
        [people.support!.userId, false, 'none'],
        [tenant.userId, false, 'none'],
        [tenant.userId, true, 'none'],
        [null, false, 'none'],
      ];
      for (const [userId, flag, expected] of matrix) {
        await asApp(
          userId,
          async (c) => {
            expect(`${userId} ${flag} → ${await attempt(c, set)}`).toBe(
              `${userId} ${flag} → ${expected}`,
            );
            expect(await attempt(c, 'delete from provider_circuit_policy')).toBe('42501');
            expect(
              await attempt(
                c,
                `insert into provider_circuit_policy (scope, window_ms, window_max_samples, min_samples, failure_percent, cooldown_ms, half_open_max_probes, probe_lease_ms, half_open_successes_to_close) values ('platform', 60000, 20, 5, 50, 30000, 1, 10000, 2)`,
              ),
            ).toBe('42501');
          },
          flag,
        );
      }
      // Reads: every validated platform-scope principal (each circuit decision reads it); no tenant.
      for (const [userId, rows] of [
        [people.tester!.userId, 1],
        [people.support!.userId, 1],
        [tenant.userId, 0],
        [null, 0],
      ] as const) {
        await asApp(userId, async (c) => {
          expect(
            (await c.query('select count(*)::int n from provider_circuit_policy')).rows[0].n,
          ).toBe(rows);
        });
      }
      for (const pool of [authPool, relayPool]) {
        await asPrincipal(pool, people.platform!.userId, async (c) => {
          expect(await attempt(c, 'select 1 from provider_circuit_policy')).toBe('42501');
        });
      }
    });

    it('the audit policy admits a policy-update row only for providers.manage, in one’s own name, with no resource id and outcome success', async () => {
      const row = (actor: string, extra: { outcome?: string; resourceId?: string } = {}) =>
        `insert into audit_logs (scope_type, scope_id, actor_type, actor_user_id, action, resource_type, resource_id, outcome, metadata, correlation_id)
         values ('platform', null, 'user', '${actor}', 'provider.circuit_policy_updated', 'ProviderCircuitPolicy', ${extra.resourceId ? `'${extra.resourceId}'` : 'null'}, '${extra.outcome ?? 'success'}', '{}'::jsonb, '${uuidv7()}')`;
      const cases: [string, string, string][] = [
        [people.manager!.userId, row(people.manager!.userId), 'ok'],
        [people.manager!.userId, row(people.platform!.userId), '42501'],
        [people.manager!.userId, row(people.manager!.userId, { outcome: 'failure' }), '42501'],
        [people.manager!.userId, row(people.manager!.userId, { resourceId: uuidv7() }), '42501'],
        [people.tester!.userId, row(people.tester!.userId), '42501'],
        [people.support!.userId, row(people.support!.userId), '42501'],
        [people.reader!.userId, row(people.reader!.userId), '42501'],
      ];
      for (const [userId, statement, expected] of cases) {
        await asApp(userId, async (c) => expect(await attempt(c, statement)).toBe(expected));
      }
    });

    it('policies, triggers and functions: exact predicates, no role name, no SECURITY DEFINER added', async () => {
      const { rows: policies } = await h.admin.execute<{
        policyname: string;
        cmd: string;
        roles: string;
        qual: string | null;
        with_check: string | null;
      }>(
        sql`select policyname, cmd, roles::text, qual, with_check from pg_policies where tablename = 'provider_circuit_policy' or policyname = 'audit_logs_provider_circuit_policy_insert' order by policyname`,
      );
      const MANAGE = "app_has_platform_permission('providers.manage'::text)";
      expect(policies.map((p) => `${p.policyname}:${p.cmd}:${p.roles}`).sort()).toEqual([
        'audit_logs_provider_circuit_policy_insert:INSERT:{acc_app}',
        'provider_circuit_policy_platform_read:SELECT:{acc_app}',
        'provider_circuit_policy_platform_update:UPDATE:{acc_app}',
      ]);
      const by = Object.fromEntries(policies.map((p) => [p.policyname, p]));
      expect(by.provider_circuit_policy_platform_read!.qual).toBe('app_has_platform_scope()');
      expect(by.provider_circuit_policy_platform_update!.qual).toBe(MANAGE);
      expect(by.provider_circuit_policy_platform_update!.with_check).toBe(MANAGE);
      for (const fragment of [
        "'provider.circuit_policy_updated'::text",
        "'ProviderCircuitPolicy'::text",
        'resource_id IS NULL',
        'app_current_user_id()',
        MANAGE,
      ])
        expect(by.audit_logs_provider_circuit_policy_insert!.with_check).toContain(fragment);
      for (const p of policies)
        expect(`${p.qual ?? ''} ${p.with_check ?? ''}`).not.toMatch(/alendei_|is_platform_admin/);
      const { rows: fn } = await h.admin.execute<{ secdef: boolean }>(
        sql`select prosecdef as secdef from pg_proc where proname = 'fn_provider_circuit_policy_version'`,
      );
      expect(fn).toEqual([{ secdef: false }]);
      const { rows: definers } = await h.admin.execute<{ proname: string }>(
        sql`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and (p.proname like '%provider%' or p.proname like '%circuit%' or p.proname like 'app_has_platform%')`,
      );
      expect(definers.map((d) => d.proname).sort()).toEqual([
        'app_has_platform_permission',
        'app_has_platform_scope',
      ]);
    });
  });

  // ===========================================================================
  describe('D. a changed policy governs every subsequent circuit decision', () => {
    it('minSamples 2 and failurePercent 100: two failures open the circuit (the seeded policy needs five), and the decision records the version it used', async () => {
      const id = await plantProvider();
      const v = (await setPolicy({ minSamples: 2, failurePercent: 100 })).version;
      await send('tester', id, '500').expect(200);
      expect((await providerRow(id)).circuitState).toBe('closed');
      await send('tester', id, '500').expect(200);
      expect((await providerRow(id)).circuitState).toBe('open');
      const [changed] = (
        await h.admin.execute<{ after: Record<string, unknown> }>(
          sql`select after from audit_logs where resource_id = ${id} and action = 'provider.circuit_changed'`,
        )
      ).rows;
      expect(changed!.after).toMatchObject({
        circuitState: 'open',
        circuitPolicyVersion: v,
        window: { samples: 2, failures: 2 },
      });
      const samples = await h.admin
        .select({ v: schema.providerHealth.circuitPolicyVersion })
        .from(schema.providerHealth)
        .where(eq(schema.providerHealth.providerId, id));
      expect(samples.map((s) => s.v)).toEqual([v, v]);
    });

    it('failurePercent: at 60 % three failures of five do not open the circuit; at the seeded 50 % they do', async () => {
      const strict = await plantProvider();
      await setPolicy({ failurePercent: 61 });
      for (const b of ['SUCCESS', 'SUCCESS', '500', '500', '500'])
        await send('tester', strict, b).expect(200);
      expect((await providerRow(strict)).circuitState).toBe('closed');
      await restoreSeeded();
      const seeded = await plantProvider();
      for (const b of ['SUCCESS', 'SUCCESS', '500', '500', '500'])
        await send('tester', seeded, b).expect(200);
      expect((await providerRow(seeded)).circuitState).toBe('open');
    });

    it('windowMs and windowMaxSamples: only failures inside a 10 s window, and only the latest five samples, count', async () => {
      await setPolicy({ windowMs: 10_000, windowMaxSamples: 5, minSamples: 5 });
      const aged = await plantProvider();
      for (let i = 0; i < 4; i++) await send('tester', aged, '500').expect(200);
      clock.advance(10_000); // outside (now − 10 s, now]
      await send('tester', aged, '500').expect(200);
      expect((await providerRow(aged)).circuitState).toBe('closed');
      const capped = await plantProvider();
      // History built under a 100 % threshold so it cannot open early.
      await setPolicy({
        windowMs: 10_000,
        windowMaxSamples: 5,
        minSamples: 5,
        failurePercent: 100,
      });
      for (const b of ['500', '500', '500', 'SUCCESS', 'SUCCESS', 'SUCCESS']) {
        await send('tester', capped, b).expect(200);
      }
      // Then 40 %: the latest five of f f f s s s s are s s s s f → 20 %, closed;
      // uncapped, 3 of 7 (43 %) would open it.
      await setPolicy({ windowMs: 10_000, windowMaxSamples: 5, minSamples: 5, failurePercent: 40 });
      await send('tester', capped, 'SUCCESS').expect(200);
      expect((await providerRow(capped)).circuitState).toBe('closed');
    });

    it('cooldownMs: a 5 s cooldown is refused at 4 999 ms and half-opens at 5 000 ms; the provider view reports it', async () => {
      await setPolicy({ cooldownMs: 5_000 });
      const id = await plantProvider({ circuit: 'open' });
      const detail = await call('get', 'reader', `/providers/${id}`).expect(200);
      expect(detail.body.data.circuitCooldownUntil).toBe(
        new Date(clock.now().getTime() + 5_000).toISOString(),
      );
      clock.advance(4_999);
      expect((await send('tester', id, 'SUCCESS').expect(409)).body.error.details).toEqual({
        circuitState: 'open',
        retryAfterMs: 1,
      });
      clock.advance(1);
      expect((await send('tester', id, 'SUCCESS').expect(200)).body.data.circuitProbe).toBe(true);
    });

    it('HALF_OPEN permits only the configured probe count: with three, exactly three of five concurrent submissions reach the adapter', async () => {
      await setPolicy({ halfOpenMaxProbes: 3 });
      const id = await plantProvider({
        circuit: 'open',
        changedAt: new Date(clock.now().getTime() - SEEDED.cooldownMs),
      });
      const gate = gateExecutor();
      const lock = await holdLock('SELECT 1 FROM providers WHERE id = $1 FOR UPDATE', [id]);
      const pending = Array.from({ length: 5 }, () => send('tester', id, 'SUCCESS').then((r) => r));
      await waitForLockWaiters(5);
      await lock.release();
      const settled: request.Response[] = [];
      const tracked = pending.map((p) =>
        p.then((r) => {
          settled.push(r);
          return r;
        }),
      );
      await until(() => gate.calls === 3 && settled.length === 2, 'three probes and two refusals');
      expect(settled.map((r) => [r.status, r.body.error?.details?.circuitState])).toEqual([
        [409, 'half_open'],
        [409, 'half_open'],
      ]);
      expect((await providerRow(id)).circuitProbes).toHaveLength(3);
      gate.releaseAll();
      const all = await Promise.all(tracked);
      expect(all.filter((r) => r.status === 200 && r.body.data.circuitProbe)).toHaveLength(3);
    });

    it('a lowered probe count applies at the next admission; probes already in flight finish', async () => {
      await setPolicy({ halfOpenMaxProbes: 2 });
      const id = await plantProvider({
        circuit: 'open',
        changedAt: new Date(clock.now().getTime() - SEEDED.cooldownMs),
      });
      const gate = gateExecutor();
      const a = send('tester', id, 'INVALID_REQUEST').then((r) => r); // neutral probes
      const b = send('tester', id, 'INVALID_REQUEST').then((r) => r);
      await until(() => gate.calls === 2, 'two probes in flight');
      await setPolicy({ halfOpenMaxProbes: 1 });
      expect((await send('tester', id, 'SUCCESS')).status).toBe(409); // 2 live ≥ 1
      // The gate releases the probe that reached it first, which may be either
      // request: wait for whichever settles, not for `a` in particular (waiting
      // on the wrong one left it parked until the test timed out).
      gate.releaseOne();
      await Promise.race([a, b]);
      expect((await send('tester', id, 'SUCCESS')).status).toBe(409); // 1 live ≥ 1
      gate.releaseOne();
      await Promise.all([a, b]);
      jest.restoreAllMocks();
      expect((await send('tester', id, 'SUCCESS').expect(200)).body.data.circuitProbe).toBe(true);
    });

    it('halfOpenSuccessesToClose and probeLeaseMs: one success closes when it is 1; a 5 s lease is reclaimed at 5 s', async () => {
      await setPolicy({ halfOpenSuccessesToClose: 1 });
      const closesFast = await plantProvider({
        circuit: 'open',
        changedAt: new Date(clock.now().getTime() - SEEDED.cooldownMs),
      });
      expect((await send('tester', closesFast, 'SUCCESS').expect(200)).body.data.circuitState).toBe(
        'closed',
      );

      await setPolicy({ probeLeaseMs: 5_000 });
      const leased = await plantProvider({
        circuit: 'open',
        changedAt: new Date(clock.now().getTime() - SEEDED.cooldownMs),
      });
      const gate = gateExecutor();
      void send('tester', leased, 'SUCCESS').then((r) => r);
      await until(() => gate.calls === 1, 'the first probe');
      expect((await providerRow(leased)).circuitProbes[0]!.leaseUntil).toBe(
        new Date(clock.now().getTime() + 5_000).toISOString(),
      );
      clock.advance(4_999);
      expect((await send('tester', leased, 'SUCCESS')).status).toBe(409);
      clock.advance(1);
      void send('tester', leased, 'SUCCESS').then((r) => r);
      await until(() => gate.calls === 2, 'the reclaiming probe');
      gate.releaseAll();
    });
  });

  // ===========================================================================
  describe('E. concurrent updates are deterministic', () => {
    it('two updates from the same version, parked on the policy row lock: exactly one succeeds, the other is 409, one audit row, one version step', async () => {
      const before = await storedPolicy();
      const audits = (await policyAudits()).length;
      const lock = await holdLock('SELECT 1 FROM provider_circuit_policy FOR UPDATE');
      const a = putPolicy('manager', {
        ...SEEDED,
        cooldownMs: 11_000,
        expectedVersion: before.version,
      }).then((r) => r);
      const b = putPolicy('platform', {
        ...SEEDED,
        cooldownMs: 22_000,
        expectedVersion: before.version,
      }).then((r) => r);
      await waitForLockWaiters(2);
      await lock.release();
      const results = await Promise.all([a, b]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.error.details).toEqual({ currentVersion: before.version + 1 });
      const stored = await storedPolicy();
      expect(stored.version).toBe(before.version + 1);
      expect(stored.cooldownMs).toBe(winner.body.data.cooldownMs);
      expect(await policyAudits()).toHaveLength(audits + 1);
    });

    it('sequential updates each from the version before: every one applies, in order, one version step and one audit row each', async () => {
      const before = await storedPolicy();
      const audits = (await policyAudits()).length;
      const cooldowns = [2_000, 3_000, 4_000, 5_000, 6_000];
      for (const cooldownMs of cooldowns) await setPolicy({ cooldownMs });
      expect(await storedPolicy()).toMatchObject({
        version: before.version + 5,
        cooldownMs: 6_000,
      });
      const rows = (await policyAudits()).slice(audits);
      expect(rows.map((r) => (r.after as { cooldownMs: number }).cooldownMs)).toEqual(cooldowns);
      expect(rows.map((r) => (r.after as { version: number }).version)).toEqual(
        cooldowns.map((_c, i) => before.version + 1 + i),
      );
    });
  });

  // ===========================================================================
  describe('F. the routing-eligibility contract, read from the persisted state (§6h)', () => {
    it('OPEN excludes the provider from normal traffic for the configured cooldown; HALF_OPEN offers only the configured probe slots; CLOSED is eligible', async () => {
      await setPolicy({
        halfOpenMaxProbes: 2,
        cooldownMs: 4_000,
        minSamples: 2,
        failurePercent: 100,
      });
      const id = await plantProvider();
      const eligibility = async () => {
        const policy = circuitPolicyOf(await storedPolicy());
        const row = await providerRow(id);
        return routingEligibility(row.status, circuitSnapshot(row), policy, clock.now());
      };
      expect(await eligibility()).toEqual({ verdict: 'eligible' });
      await send('tester', id, '500').expect(200);
      await send('tester', id, '500').expect(200);
      expect(await eligibility()).toEqual({ verdict: 'excluded_open', retryAfterMs: 4_000 });
      clock.advance(4_000);
      expect(await eligibility()).toEqual({ verdict: 'probe_only', probeSlotsFree: 2 });
      const gate = gateExecutor();
      void send('tester', id, 'INVALID_REQUEST').then((r) => r);
      await until(() => gate.calls === 1, 'one probe');
      expect(await eligibility()).toEqual({ verdict: 'probe_only', probeSlotsFree: 1 });
      void send('tester', id, 'INVALID_REQUEST').then((r) => r);
      await until(() => gate.calls === 2, 'two probes');
      expect(await eligibility()).toEqual({ verdict: 'probe_only', probeSlotsFree: 0 });
      // The router may send nothing more: admission agrees.
      expect((await send('tester', id, 'SUCCESS')).status).toBe(409);
      gate.releaseAll();
      // Lifecycle first: draining excludes whatever the circuit says.
      await call('post', 'platform', `/providers/${id}/drain`).expect(200);
      expect(await eligibility()).toEqual({ verdict: 'excluded_lifecycle', status: 'draining' });
    });
  });
});
