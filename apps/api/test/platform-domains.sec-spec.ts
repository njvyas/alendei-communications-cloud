/**
 * U13.3 — platform domain oversight: registry, challenge monitoring, DNS
 * diagnostics and lifecycle history across every tenant.
 *
 * What is proven here, against a real database and the real HTTP stack:
 *   - only `platform.tenants.read` / `platform.audit.read` at platform scope
 *     reach the routes; tenant and reseller administrators are refused;
 *   - `alendei_support`, which is not an RLS platform administrator, sees the
 *     registry only because of policy `organization_domains_platform_read`
 *     (migration 0039) — the policy is shown to be load-bearing;
 *   - no response ever carries a challenge value, and the U12 registration
 *     audit image no longer stores one;
 *   - challenge states, filters, pagination and summary agree;
 *   - DNS diagnostics compare on the server, return outcomes only and change
 *     nothing;
 *   - U12 hostname resolution and the U12 lifecycle routes are unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUDIT_ACTIONS,
  PLATFORM_ROLE_KEYS,
  TENANT_ROLE_KEYS,
  type DnsResolverResult,
  type PlatformDomainView,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { REDACTED } from '../src/audit/audit-redactor';
import { CredentialService } from '../src/iam/credential.service';
import { DnsDiagnosticsProbe } from '../src/organizations/domains/oversight/dns-diagnostics.probe';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';
import { OpenApiValidator } from './openapi-validator';

const HOUR = 60 * 60 * 1000;

describe('U13.3 platform domain oversight', () => {
  let h: Harness;
  let credentials: CredentialService;
  const sfx = uuidv7().replace(/-/g, '').slice(-10);
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];
  const createdResellers: string[] = [];
  const tokens: Record<string, string> = {};
  const challenge = (n: number) => `acc-domain-verification=u133-${sfx}-${n}`;
  let orgA: { id: string; roles: Record<string, string> };
  let orgB: { id: string; roles: Record<string, string> };
  let resellerA: string;
  let resellerB: string;
  const d: Record<string, string> = {};
  const host = (label: string) => `${label}-${sfx}.example.test`;

  const url = (p: string) => `/${PREFIX}${p}`;
  const get = (token: string | null, path: string, org?: string) => {
    const r = request(h.app.getHttpServer()).get(url(path));
    if (token) r.set('authorization', `Bearer ${token}`);
    return org ? r.set('x-acc-organization', org) : r;
  };
  const post = (token: string, path: string, body: object = {}) =>
    request(h.app.getHttpServer())
      .post(url(path))
      .set('authorization', `Bearer ${token}`)
      .send(body);

  /** No challenge value may appear anywhere in a body. */
  const expectNoChallenge = (body: unknown) => {
    const text = JSON.stringify(body);
    expect(text).not.toContain(`u133-${sfx}`);
    expect(text).not.toContain('acc-domain-verification=');
    expect(text).not.toMatch(/verificationValue/);
  };

  // --- fixtures ---------------------------------------------------------------

  async function createUser(label: string) {
    const email = `u133-${label}-${sfx}@example.test`;
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

  async function createReseller(label: string) {
    const [r] = await h.admin
      .insert(schema.resellers)
      .values({ name: `U133 R ${label}`, slug: `u133-${label}-${sfx}` })
      .returning({ id: schema.resellers.id });
    createdResellers.push(r!.id);
    return r!.id;
  }

  async function plantOrg(label: string, resellerId: string) {
    const [org] = await h.admin
      .insert(schema.organizations)
      .values({ name: `U133 O ${label}`, slug: `u133-${label}-${sfx}`, resellerId })
      .returning({ id: schema.organizations.id });
    const id = org!.id;
    createdOrgs.push(id);
    await h.admin
      .insert(schema.workspaces)
      .values({ orgId: id, name: 'Default', slug: 'default', isDefault: true });
    const provisioner = h.app.get(TenantRoleProvisioner);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await provisioner.seedTenantRoles(tx as unknown as Transaction, id, {
        correlationId: uuidv7(),
      });
    });
    const rows = await h.admin
      .select({ id: schema.roles.id, key: schema.roles.key })
      .from(schema.roles)
      .where(eq(schema.roles.orgId, id));
    return { id, roles: Object.fromEntries(rows.map((r) => [r.key, r.id])) };
  }

  async function plantDomain(
    key: string,
    orgId: string,
    values: Partial<typeof schema.organizationDomains.$inferInsert> & { ageHours: number },
    n: number,
  ) {
    const { ageHours, ...rest } = values;
    const at = new Date(Date.now() - ageHours * HOUR);
    const [row] = await h.admin
      .insert(schema.organizationDomains)
      .values({
        orgId,
        domain: host(key),
        domainType: 'custom',
        status: 'pending_verification',
        verificationMethod: 'dns_txt',
        verificationValue: challenge(n),
        verificationStatus: 'pending',
        createdAt: at,
        updatedAt: at,
        ...rest,
      })
      .returning({ id: schema.organizationDomains.id });
    d[key] = row!.id;
  }

  async function login(email: string) {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  /** Every fixture domain, newest data only: the `sfx` search isolates this suite. */
  const registry = (token: string, query = '') =>
    get(token, `/platform/domains?q=${sfx}&limit=100${query}`);

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);

    resellerA = await createReseller('a');
    resellerB = await createReseller('b');
    orgA = await plantOrg('a', resellerA);
    orgB = await plantOrg('b', resellerB);

    await plantDomain('pending', orgA.id, { ageHours: 1 }, 1);
    await plantDomain('expiring', orgA.id, { ageHours: 60 }, 2);
    await plantDomain('expired', orgA.id, { ageHours: 100, verificationStatus: 'failed' }, 3);
    await plantDomain('failed', orgA.id, { ageHours: 5, verificationStatus: 'failed' }, 4);
    await plantDomain(
      'sub',
      orgB.id,
      {
        ageHours: 200,
        domainType: 'subdomain',
        verificationMethod: 'platform_subdomain',
        status: 'active',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
      },
      5,
    );
    await plantDomain(
      'live',
      orgB.id,
      { ageHours: 300, status: 'active', verificationStatus: 'verified', verifiedAt: new Date() },
      6,
    );

    const superAdmin = await createUser('super');
    await grant(
      superAdmin.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    const support = await createUser('support');
    await grant(
      support.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );
    const tenantAdmin = await createUser('tenant');
    await grant(
      tenantAdmin.userId,
      orgA.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
      'organization',
      orgA.id,
    );
    const resellerAdmin = await createUser('reseller');
    await grant(
      resellerAdmin.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerA,
    );

    tokens.super = await login(superAdmin.email);
    tokens.support = await login(support.email);
    tokens.tenant = await login(tenantAdmin.email);
    tokens.reseller = await login(resellerAdmin.email);
  }, 180_000);

  afterAll(async () => {
    h.app.get(DnsDiagnosticsProbe).configure(() => Promise.resolve([]), []);
    await h.clearRateLimits();
    const list = (ids: string[]) =>
      sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
    await purgeAudit(
      h.admin,
      sql`org_id IN (${list(createdOrgs)}) OR actor_user_id IN (${list(createdUsers)}) OR reseller_id IN (${list(createdResellers)})`,
    );
    await h.admin
      .delete(schema.organizationDomains)
      .where(inArray(schema.organizationDomains.orgId, createdOrgs));
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_reseller_admin_liveness`,
      );
      try {
        await tx.execute(
          sql`DELETE FROM user_roles WHERE (user_id IN (${list(createdUsers)}) OR org_id IN (${list(createdOrgs)})) AND NOT (scope_type = 'organization' AND org_id IN (${list(createdOrgs)}))`,
        );
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_reseller_admin_liveness`,
        );
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
      for (const table of ['idempotency_keys', 'teams', 'workspaces']) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${list(createdOrgs)})`);
      }
      await tx.execute(sql`DELETE FROM organizations WHERE id IN (${list(createdOrgs)})`);
    });
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await h.admin.delete(schema.resellers).where(inArray(schema.resellers.id, createdResellers));
    await h.close();
  }, 180_000);

  // --- authorization ------------------------------------------------------------

  it('1. a super admin sees every tenant’s domains with organization and reseller, and no challenge value', async () => {
    const res = await registry(tokens.super!).expect(200);
    const byHost = new Map((res.body.data as PlatformDomainView[]).map((row) => [row.domain, row]));
    expect([...byHost.keys()].sort()).toEqual(
      ['pending', 'expiring', 'expired', 'failed', 'sub', 'live'].map(host).sort(),
    );
    const live = byHost.get(host('live'))!;
    expect(live.organization).toEqual({
      id: orgB.id,
      name: 'U133 O b',
      slug: `u133-b-${sfx}`,
      status: 'active',
    });
    expect(live.reseller).toEqual({ id: resellerB, name: 'U133 R b', isPlatformDefault: false });
    expectNoChallenge(res.body);
  });

  it('2. support (not an RLS platform administrator) sees the same registry', async () => {
    const res = await registry(tokens.support!).expect(200);
    expect(res.body.data).toHaveLength(6);
    expectNoChallenge(res.body);
  });

  it('3. policy organization_domains_platform_read is load-bearing for support, and only for reads', async () => {
    const policies = await h.admin.execute<{ policyname: string; cmd: string; roles: string }>(
      sql`SELECT policyname, cmd, roles::text FROM pg_policies WHERE tablename = 'organization_domains' AND policyname = 'organization_domains_platform_read'`,
    );
    expect(policies.rows).toEqual([
      { policyname: 'organization_domains_platform_read', cmd: 'SELECT', roles: '{acc_app}' },
    ]);
    await h.admin.execute(
      sql`ALTER POLICY organization_domains_platform_read ON organization_domains USING (false)`,
    );
    try {
      const withheld = await registry(tokens.support!).expect(200);
      expect(withheld.body.data).toEqual([]);
      // The super admin's RLS platform-administrator claim is independent of it.
      const superView = await registry(tokens.super!).expect(200);
      expect(superView.body.data).toHaveLength(6);
    } finally {
      await h.admin.execute(
        sql`ALTER POLICY organization_domains_platform_read ON organization_domains USING (app_current_user_id() IS NOT NULL AND app_has_platform_permission('platform.tenants.read'))`,
      );
    }
  });

  it('4. tenant and reseller administrators, and anonymous callers, are refused on every route', async () => {
    const paths = [
      `/platform/domains?q=${sfx}`,
      '/platform/domains/summary',
      `/platform/domains/${d.live}`,
      `/platform/domains/${d.pending}/dns-diagnostics`,
      `/platform/domains/${d.live}/history`,
    ];
    for (const path of paths) {
      const tenant = await get(tokens.tenant!, path, orgA.id);
      expect([path, tenant.status]).toEqual([path, 403]);
      expectNoChallenge(tenant.body);
      const reseller = await get(tokens.reseller!, path);
      expect([path, reseller.status]).toEqual([path, 403]);
      expectNoChallenge(reseller.body);
      const anonymous = await get(null, path);
      expect([path, anonymous.status]).toEqual([path, 401]);
    }
    // The tenant's refusal is audited at its own organization.
    const denied = await h.admin.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${orgA.id} AND action = ${AUDIT_ACTIONS.AUTHORIZATION_DENIED} AND resource_type = 'OrganizationDomain'`,
    );
    expect(denied.rows[0]!.n).toBeGreaterThanOrEqual(paths.length);
  });

  // --- registry behaviour ----------------------------------------------------------

  it('5. challenge states follow the U12 72-hour TTL', async () => {
    const res = await registry(tokens.super!).expect(200);
    const state = Object.fromEntries(
      (res.body.data as PlatformDomainView[]).map((row) => [row.domain, row.challenge]),
    );
    expect(state[host('pending')].state).toBe('pending');
    expect(state[host('expiring')].state).toBe('expiring_soon');
    expect(state[host('expired')].state).toBe('expired');
    expect(state[host('failed')].state).toBe('failed');
    expect(state[host('sub')]).toEqual({ state: 'not_required', issuedAt: null, expiresAt: null });
    expect(state[host('live')]).toEqual({ state: 'verified', issuedAt: null, expiresAt: null });
    const expiring = state[host('expiring')];
    expect(Date.parse(expiring.expiresAt) - Date.parse(expiring.issuedAt)).toBe(72 * HOUR);
  });

  it('6. filters combine, and the challenge-state filter agrees with the derived state', async () => {
    const hosts = async (query: string) =>
      ((await registry(tokens.super!, query).expect(200)).body.data as Array<{ domain: string }>)
        .map((r) => r.domain)
        .sort();
    for (const [stateName, key] of [
      ['pending', 'pending'],
      ['expiring_soon', 'expiring'],
      ['expired', 'expired'],
      ['failed', 'failed'],
      ['not_required', 'sub'],
      ['verified', 'live'],
    ] as const) {
      expect(await hosts(`&challengeState=${stateName}`)).toEqual([host(key)]);
    }
    expect(await hosts('&status=active')).toEqual([host('live'), host('sub')].sort());
    expect(await hosts('&domainType=subdomain')).toEqual([host('sub')]);
    expect(await hosts(`&orgId=${orgB.id}`)).toEqual([host('live'), host('sub')].sort());
    expect(await hosts(`&resellerId=${resellerA}`)).toEqual(
      ['pending', 'expiring', 'expired', 'failed'].map(host).sort(),
    );
    expect(await hosts(`&resellerId=${resellerA}&verificationStatus=failed`)).toEqual(
      [host('expired'), host('failed')].sort(),
    );
    expect(await hosts(`&resellerId=${uuidv7()}`)).toEqual([]);
  });

  it('7. paginates with a cursor without repeating or skipping', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `/platform/domains?q=${sfx}&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(tokens.support!, query).expect(200);
      seen.push(...(res.body.data as Array<{ domain: string }>).map((r) => r.domain));
      cursor = res.body.page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...seen].sort());
    expect(seen).toHaveLength(6);
  });

  it('8. validates its input', async () => {
    for (const query of [
      '?status=deleted',
      '?challengeState=stale',
      '?orgId=not-a-uuid',
      '?q=%25',
      '?q=a%20b',
      '?sort=verificationValue',
    ]) {
      const res = await get(tokens.super!, `/platform/domains${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }
    await get(tokens.super!, '/platform/domains/not-a-uuid').expect(400);
    await get(tokens.super!, `/platform/domains/${uuidv7()}`).expect(404);
  });

  it('9. the summary is consistent with itself and counts the fixtures', async () => {
    const res = await get(tokens.support!, '/platform/domains/summary').expect(200);
    const s = res.body.data;
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(s.byStatus)).toBe(s.total);
    expect(sum(s.byChallengeState)).toBe(s.total);
    expect(sum(s.byType)).toBe(s.total);
    expect(s.needsAttention).toBe(
      s.byChallengeState.expiring_soon + s.byChallengeState.expired + s.byChallengeState.failed,
    );
    expect(s.total).toBeGreaterThanOrEqual(6);
    expect(s.byChallengeState.expired).toBeGreaterThanOrEqual(1);
    expect(s.byChallengeState.expiring_soon).toBeGreaterThanOrEqual(1);
  });

  it('10. one domain by id', async () => {
    const res = await get(tokens.support!, `/platform/domains/${d.expiring}`).expect(200);
    expect(res.body.data.domain).toBe(host('expiring'));
    expect(res.body.data.challenge.state).toBe('expiring_soon');
    expectNoChallenge(res.body);
  });

  // --- DNS diagnostics --------------------------------------------------------------

  it('11. diagnostics compare on the server, return outcomes only, and change nothing', async () => {
    const probe = h.app.get(DnsDiagnosticsProbe);
    const looked: string[] = [];
    probe.configure(
      (resolver, name) => {
        looked.push(`${resolver.label}|${name}`);
        if (resolver.label === 'one') return Promise.resolve([[challenge(1)]]);
        if (resolver.label === 'two') return Promise.resolve([['v=spf1 -all']]);
        return Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
      },
      [
        { label: 'one', servers: ['192.0.2.1'] },
        { label: 'two', servers: ['192.0.2.2'] },
        { label: 'three', servers: ['192.0.2.3'] },
      ],
    );
    const before = await h.admin
      .select()
      .from(schema.organizationDomains)
      .where(eq(schema.organizationDomains.id, d.pending!));

    const res = await get(tokens.support!, `/platform/domains/${d.pending}/dns-diagnostics`).expect(
      200,
    );
    const body = res.body.data;
    expect(body.challengeHost).toBe(`_alendei-challenge.${host('pending')}`);
    expect(body.propagation).toBe('partial');
    expect(
      (body.results as DnsResolverResult[]).map((r) => [
        r.resolver,
        r.outcome,
        r.recordCount,
        r.errorCode,
      ]),
    ).toEqual([
      ['one', 'match', 1, null],
      ['two', 'mismatch', 1, null],
      ['three', 'not_found', 0, 'ENOTFOUND'],
    ]);
    expect(looked.every((l) => l.endsWith(`|_alendei-challenge.${host('pending')}`))).toBe(true);
    expectNoChallenge(res.body);
    expect(JSON.stringify(res.body)).not.toContain('v=spf1');

    const after = await h.admin
      .select()
      .from(schema.organizationDomains)
      .where(eq(schema.organizationDomains.id, d.pending!));
    expect(after).toEqual(before);
  });

  it('12. diagnostics: expired challenge says regenerate; verified and subdomains are not applicable', async () => {
    const probe = h.app.get(DnsDiagnosticsProbe);
    probe.configure(() => Promise.resolve([[challenge(3)]]), [{ label: 'one', servers: null }]);
    const expired = await get(
      tokens.super!,
      `/platform/domains/${d.expired}/dns-diagnostics`,
    ).expect(200);
    expect(expired.body.data.propagation).toBe('propagated');
    expect(expired.body.data.challenge.state).toBe('expired');
    expect(expired.body.data.guidance).toMatch(/regenerate/);

    let calls = 0;
    probe.configure(() => {
      calls += 1;
      return Promise.resolve([]);
    });
    for (const key of ['live', 'sub']) {
      const res = await get(tokens.super!, `/platform/domains/${d[key]}/dns-diagnostics`).expect(
        200,
      );
      expect(res.body.data.propagation).toBe('not_applicable');
      expect(res.body.data.results).toEqual([]);
    }
    expect(calls).toBe(0);

    probe.configure(() => Promise.reject(Object.assign(new Error('t'), { code: 'ETIMEOUT' })));
    const unreachable = await get(
      tokens.super!,
      `/platform/domains/${d.pending}/dns-diagnostics`,
    ).expect(200);
    expect(unreachable.body.data.propagation).toBe('unreachable');
    expect(unreachable.body.data.guidance).toMatch(/outbound DNS/);
  });

  // --- lifecycle history and U12 compatibility ------------------------------------------

  it('13. history shows U12 lifecycle actions with allowlisted fields only', async () => {
    await post(tokens.super!, `/organizations/${orgB.id}/domains/${d.live}/suspend`, {
      reason: 'U13.3 oversight check',
    }).expect(200);
    await post(tokens.super!, `/organizations/${orgB.id}/domains/${d.live}/activate`).expect(200);

    const res = await get(tokens.support!, `/platform/domains/${d.live}/history`).expect(200);
    const entries = res.body.data as Array<Record<string, unknown>>;
    expect(entries.map((e) => [e.action, e.fromStatus, e.toStatus, e.reason])).toEqual([
      [AUDIT_ACTIONS.DOMAIN_ACTIVATED, 'suspended', 'active', null],
      [AUDIT_ACTIONS.DOMAIN_SUSPENDED, 'active', 'suspended', 'U13.3 oversight check'],
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          'action',
          'actorType',
          'actorUserId',
          'fromStatus',
          'fromVerificationStatus',
          'id',
          'occurredAt',
          'outcome',
          'reason',
          'toStatus',
          'toVerificationStatus',
        ].sort(),
      );
    }
    expectNoChallenge(res.body);
  });

  it('14. a U12 registration is audited without its challenge value, and shows in history', async () => {
    const tenantRes = await request(h.app.getHttpServer())
      .post(url(`/organizations/${orgA.id}/domains`))
      .set('authorization', `Bearer ${tokens.tenant}`)
      .send({ domain: host('registered'), domainType: 'custom' });
    expect(tenantRes.status).toBe(201);
    const id = tenantRes.body.data.id as string;
    // The owning organization still receives its challenge from U12, unchanged.
    expect(tenantRes.body.data.verificationValue).toMatch(/^acc-domain-verification=/);

    const audit = await h.admin.execute<{ after: Record<string, unknown> }>(
      sql`SELECT after FROM audit_logs WHERE resource_id = ${id} AND action = ${AUDIT_ACTIONS.DOMAIN_REGISTERED}`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.after.verificationValue).toBe(REDACTED);
    expect(audit.rows[0]!.after.domain).toBe(host('registered'));

    const history = await get(tokens.super!, `/platform/domains/${id}/history`).expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({
      action: AUDIT_ACTIONS.DOMAIN_REGISTERED,
      fromStatus: null,
      toStatus: 'pending_verification',
      toVerificationStatus: 'pending',
    });
    expect(JSON.stringify(history.body)).not.toContain(tenantRes.body.data.verificationValue);
  });

  it('15. U12 hostname resolution is unchanged: only active, verified domains resolve', async () => {
    const live = await request(h.app.getHttpServer())
      .get(url(`/domains/resolve?hostname=${host('live')}`))
      .expect(200);
    expect(live.body.data.matched).toBe(true);
    expect(live.body.data.organization.id).toBe(orgB.id);
    const pending = await request(h.app.getHttpServer())
      .get(url(`/domains/resolve?hostname=${host('pending')}`))
      .expect(200);
    expect(pending.body.data.organization).toBeNull();
  });

  it('16. responses conform to the OpenAPI document', async () => {
    h.app
      .get(DnsDiagnosticsProbe)
      .configure(() => Promise.resolve([[challenge(1)]]), [{ label: 'one', servers: null }]);
    const validator = new OpenApiValidator(
      JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.v1.json'), 'utf8')),
    );
    const problems: string[] = [];
    const check = async (token: string, path: string) => {
      const res = await get(token, path);
      problems.push(...validator.check('GET', url(path), res));
    };
    await check(tokens.super!, `/platform/domains?q=${sfx}`);
    await check(tokens.super!, '/platform/domains/summary');
    await check(tokens.super!, `/platform/domains/${d.live}`);
    await check(tokens.super!, `/platform/domains/${d.pending}/dns-diagnostics`);
    await check(tokens.super!, `/platform/domains/${d.live}/history`);
    await check(tokens.reseller!, '/platform/domains/summary');
    await check(tokens.super!, `/platform/domains/${uuidv7()}`);
    expect(problems).toEqual([]);
  });
});
