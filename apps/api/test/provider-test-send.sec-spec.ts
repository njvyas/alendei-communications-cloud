/**
 * Phase 2.2 — provider adapter contract and SimulatorAdapter, through
 * `POST /providers/:id/test-send` (ADR-013 PD-3, ROADMAP §5b 2.2, Gate D.2).
 *
 * The adapter is reached only through a provider in the platform catalogue:
 * `providers.test_send` at platform scope, an `active` provider, and the
 * adapter named by that provider's catalogue row. Nothing the caller sends can
 * name an adapter, a provider other than the path's, a recipient, content or a
 * credential. No message is persisted; the only write is the audit row.
 */
import { randomBytes } from 'node:crypto';

import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PLATFORM_ROLE_KEYS,
  PROVIDER_HEALTH_DEFAULTS,
  PROVIDER_SUBMISSION_DEFAULTS,
  SIMULATOR_BEHAVIORS,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { MetricsService } from '../src/observability/metrics.service';
import { ProviderSubmissionExecutor } from '../src/provider-adapters/submission-executor';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  ManualProviderClock,
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

describe('Phase 2.2 provider adapter test-send', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenant: TenantFixture;
  let appPool: Pool;
  const people: Record<string, Person> = {};
  const tokens: Record<string, string> = {};
  const createdUsers: string[] = [];
  const createdRoles: string[] = [];
  const createdProviders: string[] = [];
  let channelSms: string;
  let apiKey: string;
  let apiKeyId: string;
  let provider: string;

  /**
   * Phase 2.3: test-sends now feed the provider's circuit and health. This suite
   * proves the 2.2 adapter behaviours, so each case starts beyond both sample
   * windows (`PROVIDER_ADAPTER.md` §5c, §6a) — the injected clock is advanced,
   * nothing sleeps — and the shared provider's earlier answers cannot trip its
   * circuit. The circuit's own effect on test-send is proven by
   * `provider-health-circuit.sec-spec.ts`.
   */
  const clock = new ManualProviderClock();
  beforeEach(() => clock.advance(PROVIDER_HEALTH_DEFAULTS.WINDOW_MS + 1));

  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => randomBytes(5).toString('hex');

  async function createUser(label: string) {
    const email = `p22-${label}-${suffix()}@example.test`;
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

  /** A platform role that is not alendei_super_admin, holding exactly `permissionKeys`. */
  async function testPlatformRole(permissionKeys: string[]): Promise<string> {
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: null,
          key: `test_p22_${suffix()}`,
          name: 'Test p22 role',
          isSystemRole: false,
          allowedScopeTypes: ['platform'],
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

  const testSend = (credential: string | null, id: string, body: object, org?: string) => {
    let r = request(h.app.getHttpServer()).post(url(`/providers/${id}/test-send`));
    if (credential) r = r.set('authorization', `Bearer ${credential}`);
    if (org) r = r.set('x-acc-organization', org);
    return r.send(body);
  };

  /** A provider planted by the owner (bypassing the API), so tests can set any state or adapter key. */
  async function plantProvider(
    status: 'active' | 'disabled' | 'draining',
    adapterKey = 'simulator',
  ) {
    const [p] = await h.admin
      .insert(schema.providers)
      .values({ channelId: channelSms, name: `p22-${suffix()}`, adapterKey, status })
      .returning({ id: schema.providers.id });
    createdProviders.push(p!.id);
    return p!.id;
  }

  const testSentRows = async (providerId: string) =>
    (
      await h.admin.execute<Record<string, unknown>>(
        sql`select * from audit_logs where resource_id = ${providerId} and action = ${AUDIT_ACTIONS.PROVIDER_TEST_SENT} order by id`,
      )
    ).rows;

  const allAuditFor = async (providerId: string) =>
    (
      await h.admin.execute<{ n: number }>(
        sql`select count(*)::int n from audit_logs where resource_id = ${providerId}`,
      )
    ).rows[0]!.n;

  /** Every adapter submission ever counted, across channels and outcomes. */
  const submissions = async () =>
    (await h.app.get(MetricsService).scrape())
      .split('\n')
      .filter((l) => l.startsWith('acc_provider_submissions_total{'))
      .reduce((sum, l) => sum + Number(l.split(' ').at(-1)), 0);

  async function asApp<T>(
    userId: string | null,
    work: (c: PoolClient) => Promise<T>,
    isPlatformAdmin = false,
  ): Promise<T> {
    const c = await appPool.connect();
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

  beforeAll(async () => {
    h = await startHarness({ providerClock: clock });
    credentials = h.app.get(CredentialService);
    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    tenant = await createTenant(h.admin, 'p22', credentials);

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
      await testPlatformRole(['providers.read', 'providers.manage']),
      'platform',
      null,
    );
    people.tester = await createUser('tester');
    await grant(
      people.tester.userId,
      await testPlatformRole(['providers.read', 'providers.test_send']),
      'platform',
      null,
    );

    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const secret = `s${randomBytes(16).toString('hex')}`;
    const [key] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        name: `p22-${suffix()}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        scopes: ['providers.read', 'providers.manage', 'providers.test_send'],
        createdBy: people.platform.userId,
      })
      .returning({ id: schema.apiKeys.id });
    apiKey = `${prefix}.${secret}`;
    apiKeyId = key!.id;

    for (const name of ['platform', 'support', 'reseller', 'manager', 'tester'])
      tokens[name] = await login(people[name]!.email);
    tokens.orgAdmin = await login(tenant.email);

    const [sms] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'sms'));
    channelSms = sms!.id;
    provider = await plantProvider('active');
  }, 180_000);

  afterAll(async () => {
    await h.clearRateLimits();
    const list = (values: string[]) =>
      sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      );
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
    await appPool.end();
    await h.close();
  }, 180_000);

  // ===========================================================================
  describe('A. the seven submission-time behaviours, end to end', () => {
    const expected: Record<
      string,
      {
        outcome: string;
        category: string | null;
        retryable: boolean | null;
        providerCode: string | null;
      }
    > = {
      SUCCESS: { outcome: 'accepted', category: null, retryable: null, providerCode: null },
      SLOW_RESPONSE: { outcome: 'accepted', category: null, retryable: null, providerCode: null },
      TIMEOUT: { outcome: 'rejected', category: 'TIMEOUT', retryable: true, providerCode: null },
      '500': {
        outcome: 'rejected',
        category: 'PROVIDER_ERROR',
        retryable: true,
        providerCode: 'SIM-500',
      },
      '429': {
        outcome: 'rejected',
        category: 'RATE_LIMITED',
        retryable: true,
        providerCode: 'SIM-429',
      },
      INVALID_CREDENTIALS: {
        outcome: 'rejected',
        category: 'AUTH_ERROR',
        retryable: false,
        providerCode: 'SIM-401',
      },
      INVALID_REQUEST: {
        outcome: 'rejected',
        category: 'INVALID_REQUEST',
        retryable: false,
        providerCode: 'SIM-400',
      },
    };

    for (const behavior of SIMULATOR_BEHAVIORS) {
      it(
        `${behavior}: 200 with the normalized answer, one audit row, nothing else persisted`,
        async () => {
          const e = expected[behavior]!;
          const before = await testSentRows(provider);
          const res = await testSend(tokens.platform!, provider, { behavior }).expect(200);
          const body = res.body.data;
          expect(body).toMatchObject({
            providerId: provider,
            adapterKey: 'simulator',
            channelCode: 'sms',
            behavior,
            outcome: e.outcome,
          });
          expect(body.submissionId).toMatch(/^[0-9a-f-]{36}$/);
          expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
          if (e.outcome === 'accepted') {
            expect(body.providerMessageId).toBe(`sim-${body.submissionId}`);
            expect(body.failure).toBeNull();
          } else {
            expect(body.providerMessageId).toBeNull();
            expect(body.failure).toMatchObject({
              category: e.category,
              retryable: e.retryable,
              providerCode: e.providerCode,
            });
          }
          if (behavior === 'TIMEOUT')
            expect(body.latencyMs).toBe(PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS);
          if (behavior === 'SLOW_RESPONSE') {
            expect(body.latencyMs).toBeGreaterThanOrEqual(
              PROVIDER_SUBMISSION_DEFAULTS.SIMULATOR_SLOW_RESPONSE_MS - 5,
            );
            expect(body.latencyMs).toBeLessThan(PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS);
          }

          const rows = await testSentRows(provider);
          expect(rows).toHaveLength(before.length + 1);
          const row = rows.at(-1)!;
          expect(row).toMatchObject({
            scope_type: 'platform',
            org_id: null,
            actor_user_id: people.platform!.userId,
            resource_type: 'Provider',
            // success: authorized and accepted; failure: authorized, attempted, rejected.
            outcome: e.outcome === 'accepted' ? 'success' : 'failure',
            before: null,
          });
          expect(row.after).toMatchObject({
            behavior,
            outcome: e.outcome,
            category: e.category,
            submissionId: body.submissionId,
          });
          // No payload: neither the synthetic recipient nor the content is recorded.
          expect(JSON.stringify(row)).not.toContain('test-recipient');
          expect(JSON.stringify(row)).not.toContain('ACC provider test-send');
        },
        PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS + 15_000,
      );
    }

    it('no message, attempt or webhook table exists to write to', async () => {
      const { rows } = await h.admin.execute<{ n: number }>(
        // `provider_health` exists from Phase 2.3 by design (migration 0022); it
        // holds observations, not messages, and is proven in the 2.3 suite.
        sql`select count(*)::int n from information_schema.tables where table_schema = 'public' and table_name in ('messages','message_attempts','webhook_events')`,
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('the submission counter moves by channel and normalized outcome', async () => {
      const scrape = () => h.app.get(MetricsService).scrape();
      const value = (text: string, outcome: string) => {
        const line = text
          .split('\n')
          .find(
            (l) =>
              l.startsWith('acc_provider_submissions_total{') &&
              l.includes('channel="sms"') &&
              l.includes(`outcome="${outcome}"`),
          );
        return line ? Number(line.split(' ').at(-1)) : 0;
      };
      const before = await scrape();
      await testSend(tokens.platform!, provider, { behavior: '429' }).expect(200);
      await testSend(tokens.platform!, provider, { behavior: 'SUCCESS' }).expect(200);
      const after = await scrape();
      expect(value(after, 'rate_limited') - value(before, 'rate_limited')).toBe(1);
      expect(value(after, 'accepted') - value(before, 'accepted')).toBe(1);
      expect(after).not.toMatch(
        /acc_provider_submissions_total\{[^}]*(provider_id|submission|correlation)/,
      );
    });
  });

  // ===========================================================================
  describe('B. provider state and adapter resolution fail closed', () => {
    it('a disabled or draining provider is not a submission target: 409 with its status, and nothing is recorded', async () => {
      for (const status of ['disabled', 'draining'] as const) {
        const id = await plantProvider(status);
        const sentBefore = await submissions();
        const res = await testSend(tokens.platform!, id, { behavior: 'SUCCESS' }).expect(409);
        expect(res.body.error).toMatchObject({
          code: ERROR_CODES.PROVIDER_LIFECYCLE_CONFLICT,
          details: { status },
        });
        expect(await allAuditFor(id)).toBe(0);
        expect(await submissions()).toBe(sentBefore);
      }
    });

    it('re-enabling a disabled provider makes it a target again', async () => {
      const id = await plantProvider('disabled');
      await testSend(tokens.platform!, id, { behavior: 'SUCCESS' }).expect(409);
      await request(h.app.getHttpServer())
        .post(url(`/providers/${id}/enable`))
        .set('authorization', `Bearer ${tokens.platform}`)
        .expect(200);
      await testSend(tokens.platform!, id, { behavior: 'SUCCESS' }).expect(200);
    });

    it('a provider whose catalogue adapter key is not registered fails closed with 422, and nothing is recorded', async () => {
      const id = await plantProvider('active', 'legacy_vendor');
      const sentBefore = await submissions();
      const res = await testSend(tokens.platform!, id, { behavior: 'SUCCESS' }).expect(422);
      expect(res.body.error).toMatchObject({
        code: ERROR_CODES.PROVIDER_ADAPTER_UNKNOWN,
        details: { adapterKeys: ['simulator'] },
      });
      expect(await allAuditFor(id)).toBe(0);
      expect(await submissions()).toBe(sentBefore);
    });

    it('an unknown provider is 404', async () => {
      await testSend(tokens.platform!, uuidv7(), { behavior: 'SUCCESS' }).expect(404);
    });
  });

  // ===========================================================================
  describe('C. nothing the caller sends can choose an adapter, a provider, a payload or a credential', () => {
    it('adapter, provider, recipient, content, tenant and credential fields are refused, not ignored — and nothing is recorded', async () => {
      const before = await allAuditFor(provider);
      for (const extra of [
        { adapterKey: 'simulator' },
        { adapterKey: 'acme_sms' },
        { providerId: uuidv7() },
        { channel: 'whatsapp' },
        { recipient: '+15550000000' },
        { content: { text: 'hello' } },
        { text: 'hello' },
        { credential: 'x' },
        { credentialRef: 'env:SECRET' },
        { apiKey: 'k' },
        { password: 'p' },
        { token: 't' },
        { secret: 's' },
        { orgId: tenant.orgId },
        { timeoutMs: 1 },
      ]) {
        const r = await testSend(tokens.platform!, provider, { behavior: 'SUCCESS', ...extra });
        expect(`${Object.keys(extra)[0]}:${r.status}`).toBe(`${Object.keys(extra)[0]}:400`);
        expect(r.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      }
      expect(await allAuditFor(provider)).toBe(before);
    });

    it('a behaviour outside the frozen submission-time set, or none at all, is 400', async () => {
      for (const body of [
        {},
        { behavior: 'DELIVERY_DELAY' },
        { behavior: 'DUPLICATE_WEBHOOK' },
        { behavior: 'success' },
        { behavior: 500 },
      ]) {
        await testSend(tokens.platform!, provider, body).expect(400);
      }
    });
  });

  // ===========================================================================
  describe('D. authorization — providers.test_send at platform scope, nothing else', () => {
    const refusedEverywhere = async (credential: string | null, status: number, org?: string) => {
      const before = await allAuditFor(provider);
      const sentBefore = await submissions();
      const r = await testSend(credential, provider, { behavior: 'SUCCESS' }, org);
      expect(r.status).toBe(status);
      expect(await allAuditFor(provider)).toBe(before);
      // Refused before the adapter: no submission was attempted at all.
      expect(await submissions()).toBe(sentBefore);
      return r;
    };

    it('unauthenticated: 401', async () => {
      await refusedEverywhere(null, 401);
    });

    it('an organization administrator, with or without naming its organization: 403', async () => {
      await refusedEverywhere(tokens.orgAdmin!, 403);
      await refusedEverywhere(tokens.orgAdmin!, 403, tenant.orgId);
    });

    it('a reseller administrator: 403', async () => {
      await refusedEverywhere(tokens.reseller!, 403);
    });

    it('alendei_support: 403, audited at platform scope', async () => {
      const r = await refusedEverywhere(tokens.support!, 403);
      expect(r.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('an API key requesting every providers.* scope: 403', async () => {
      await refusedEverywhere(apiKey, 403);
    });

    it('a platform role holding providers.manage but not providers.test_send: 403 — the permission is specific', async () => {
      await refusedEverywhere(tokens.manager!, 403);
    });

    it('a platform role that is not alendei_super_admin, holding providers.test_send: 200, and its audit row is inserted', async () => {
      const res = await testSend(tokens.tester!, provider, { behavior: 'SUCCESS' }).expect(200);
      const rows = await testSentRows(provider);
      expect(rows.at(-1)).toMatchObject({
        actor_user_id: people.tester!.userId,
        scope_type: 'platform',
      });
      expect((rows.at(-1)!.after as { submissionId: string }).submissionId).toBe(
        res.body.data.submissionId,
      );
    });
  });

  // ===========================================================================
  describe('E. the database boundary, with the service bypassed', () => {
    const testSentRow = (actor: string) =>
      `insert into audit_logs (scope_type, scope_id, actor_type, actor_user_id, action, resource_type, resource_id, outcome, metadata, correlation_id)
       values ('platform', null, 'user', '${actor}', 'provider.test_sent', 'Provider', '${provider}', 'success', '{}'::jsonb, '${uuidv7()}')`;
    const attempt = (userId: string | null, isPlatformAdmin = false) =>
      asApp(
        userId,
        async (c) => {
          await c.query('SAVEPOINT s');
          try {
            await c.query(testSentRow(userId ?? people.platform!.userId));
            return 'ok';
          } catch (e) {
            return (e as { code?: string }).code ?? 'error';
          } finally {
            await c.query('ROLLBACK TO SAVEPOINT s');
          }
        },
        isPlatformAdmin,
      );

    it('a provider.test_sent row is admitted exactly for providers.test_send holders at platform scope, in their own name', async () => {
      expect(await attempt(people.platform!.userId, true)).toBe('ok');
      expect(await attempt(people.tester!.userId)).toBe('ok');
      for (const refused of [
        await attempt(people.manager!.userId),
        await attempt(people.support!.userId),
        await attempt(people.reseller!.userId),
        await attempt(tenant.userId),
        await attempt(tenant.userId, true),
        await attempt(null),
      ]) {
        expect(refused).toBe('42501');
      }
      // The outcome is success or failure — never denied, which is AuthorizationService's alone.
      await asApp(people.tester!.userId, async (c) => {
        await c.query('SAVEPOINT a');
        await c.query(testSentRow(people.tester!.userId).replace("'success'", "'failure'"));
        await c.query('ROLLBACK TO SAVEPOINT a');
        await expect(
          c.query(testSentRow(people.tester!.userId).replace("'success'", "'denied'")),
        ).rejects.toMatchObject({ code: '42501' });
      });
      // A legitimate tester cannot file one in another user's name.
      await asApp(people.tester!.userId, async (c) => {
        await expect(c.query(testSentRow(people.platform!.userId))).rejects.toMatchObject({
          code: '42501',
        });
      });
    });

    it('the test-send audit policy names no role, adds no function, and leaves the other audit policies as they were (plus the 2.3 health policy)', async () => {
      const { rows } = await h.admin.execute<{ policyname: string; with_check: string }>(
        sql`select policyname, with_check from pg_policies where tablename = 'audit_logs' and cmd = 'INSERT' order by policyname`,
      );
      expect(rows.map((r) => r.policyname)).toEqual([
        'audit_logs_auth_insert',
        'audit_logs_insert',
        'audit_logs_platform_self_denial_insert',
        // Gate D.3 remediation (migration 0023), pinned in provider-circuit-policy.sec-spec.ts.
        'audit_logs_provider_circuit_policy_insert',
        // Phase 2.3 (migration 0022), pinned in provider-health-circuit.sec-spec.ts.
        'audit_logs_provider_health_insert',
        'audit_logs_provider_insert',
        'audit_logs_provider_test_send_insert',
      ]);
      const policy = rows.find((r) => r.policyname === 'audit_logs_provider_test_send_insert')!;
      expect(policy.with_check).toContain(
        "app_has_platform_permission('providers.test_send'::text)",
      );
      expect(policy.with_check).toContain(
        "ARRAY['success'::audit_outcome, 'failure'::audit_outcome]",
      );
      expect(policy.with_check).not.toMatch(/alendei_|is_platform_admin/);
      const { rows: definers } = await h.admin.execute<{ proname: string }>(
        sql`select proname from pg_proc where prosecdef and proname like 'app_has_platform%' order by proname`,
      );
      expect(definers.map((d) => d.proname)).toEqual([
        'app_has_platform_permission',
        'app_has_platform_scope',
      ]);
    });
  });

  // ===========================================================================
  describe('F. the boundary between the two transactions (TOCTOU)', () => {
    /**
     * Runs `between` while the submission is in flight — after the first
     * transaction has authorized and released, before the second one writes —
     * by wrapping the real executor for one call.
     */
    function duringSubmission(between: () => Promise<void>) {
      const executor = h.app.get(ProviderSubmissionExecutor);
      const original = executor.execute.bind(executor);
      return jest.spyOn(executor, 'execute').mockImplementationOnce(async (...args) => {
        await between();
        return original(...args);
      });
    }
    const rowsFor = async (submissionId: string) =>
      (
        await h.admin.execute<{ actor_user_id: string }>(
          sql`select actor_user_id from audit_logs where action = ${AUDIT_ACTIONS.PROVIDER_TEST_SENT} and after->>'submissionId' = ${submissionId}`,
        )
      ).rows;
    const testerGrant = async () =>
      (
        await h.admin.execute<{ role_id: string }>(
          sql`select role_id from user_roles where user_id = ${people.tester!.userId} and scope_type = 'platform'`,
        )
      ).rows[0]!.role_id;

    afterEach(() => jest.restoreAllMocks());

    it('providers.test_send revoked while the submission runs: 403, and no provider.test_sent row is written', async () => {
      const roleId = await testerGrant();
      const before = await testSentRows(provider);
      const spy = duringSubmission(async () => {
        await h.admin.execute(
          sql`DELETE FROM user_roles WHERE user_id = ${people.tester!.userId} AND role_id = ${roleId}`,
        );
      });
      try {
        const res = await testSend(tokens.tester!, provider, { behavior: 'SUCCESS' }).expect(403);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
        expect(spy).toHaveBeenCalledTimes(1); // authorized when it started, so it ran
        expect(await testSentRows(provider)).toHaveLength(before.length);
      } finally {
        await grant(people.tester!.userId, roleId, 'platform', null);
      }
    });

    it('the user disabled while the submission runs: 403, and no provider.test_sent row is written', async () => {
      const before = await testSentRows(provider);
      duringSubmission(async () => {
        await h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, people.tester!.userId));
      });
      try {
        await testSend(tokens.tester!, provider, { behavior: 'SUCCESS' }).expect(403);
        expect(await testSentRows(provider)).toHaveLength(before.length);
      } finally {
        await h.admin
          .update(schema.users)
          .set({ status: 'active' })
          .where(eq(schema.users.id, people.tester!.userId));
      }
    });

    it('the provider disabled while the submission runs: the test that ran is recorded truthfully, and the next one is refused', async () => {
      const id = await plantProvider('active');
      duringSubmission(async () => {
        await h.admin
          .update(schema.providers)
          .set({ status: 'disabled' })
          .where(eq(schema.providers.id, id));
      });
      const res = await testSend(tokens.platform!, id, { behavior: '500' }).expect(200);
      const rows = await testSentRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'failure', actor_user_id: people.platform!.userId });
      expect((rows[0]!.after as { submissionId: string }).submissionId).toBe(
        res.body.data.submissionId,
      );
      await testSend(tokens.platform!, id, { behavior: 'SUCCESS' }).expect(409);
    });

    it('a refused principal never reaches the executor', async () => {
      const executor = h.app.get(ProviderSubmissionExecutor);
      const spy = jest.spyOn(executor, 'execute');
      for (const token of [
        tokens.orgAdmin!,
        tokens.reseller!,
        tokens.support!,
        tokens.manager!,
        apiKey,
      ]) {
        await testSend(token, provider, { behavior: 'SUCCESS' }).expect(403);
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it('each audit row is attributed to the user whose request ran the test, even when two run concurrently', async () => {
      const [a, b] = await Promise.all([
        testSend(tokens.platform!, provider, { behavior: 'SUCCESS' }).expect(200),
        testSend(tokens.tester!, provider, { behavior: '429' }).expect(200),
      ]);
      expect(await rowsFor(a.body.data.submissionId)).toEqual([
        { actor_user_id: people.platform!.userId },
      ]);
      expect(await rowsFor(b.body.data.submissionId)).toEqual([
        { actor_user_id: people.tester!.userId },
      ]);
    });
  });
});
