/**
 * Gate C observability (ROADMAP §4d): the two metrics Phase 1C requires.
 *
 *   acc_organization_status_refusals_total{status, operation}
 *   acc_session_cap_evictions_total
 *
 * Booted through `createApp()` — the function `main.ts` calls — so the counters,
 * the exception filter that records refusals and `/metrics` are exactly the
 * production wiring, not the test harness's own filter. Each counter is read
 * back from `/metrics` and compared before and after one specific event, with a
 * negative control for every case that must not count.
 */
import { PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { createDatabase, createPool, schema, type Database, type Transaction } from '@acc/db';
import type { INestApplication } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import type { CredentialService } from '../src/iam/credential.service';
import type { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit } from './auth-harness';

const SESSION_CAP = 2;
const url = (path: string) => `/${PREFIX}${path}`;
const suffix = () => uuidv7().replace(/-/g, '').slice(-10);

/** One sample of a counter from the Prometheus text format, matched on the given labels. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const pairs = /\{([^}]*)\}/.exec(line)?.[1] ?? '';
    if (Object.entries(labels).every(([k, v]) => pairs.includes(`${k}="${v}"`))) {
      return Number(line.slice(line.lastIndexOf(' ') + 1));
    }
  }
  return 0;
}

describe('Gate C metrics — organization-status refusals and session-cap evictions', () => {
  let app: INestApplication;
  let clearRateLimits: () => Promise<void>;
  let pool: ReturnType<typeof createPool>;
  let admin: Database;
  let credentials: CredentialService;
  let provisioner: TenantRoleProvisioner;
  const orgs: Record<'active' | 'suspended' | 'closed', string> = {
    active: '',
    suspended: '',
    closed: '',
  };
  const users: Record<
    'member' | 'outsider' | 'platform' | 'evictee',
    { id: string; email: string }
  > = {} as never;
  let resellerId: string;

  async function scrape(): Promise<string> {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    return res.text;
  }

  async function login(email: string, password = PASSWORD) {
    await clearRateLimits();
    return request(app.getHttpServer()).post(url('/auth/login')).send({ email, password });
  }

  async function token(email: string): Promise<string> {
    const res = await login(email);
    expect(res.status).toBe(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  async function createUser(label: string) {
    const email = `${label}-${suffix()}@example.test`;
    const [row] = await admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    return { id: row!.id, email };
  }

  async function plantOrg(label: string, status: 'active' | 'suspended' | 'closed') {
    const [org] = await admin
      .insert(schema.organizations)
      .values({ name: `M ${label}`, slug: `m-${label}-${suffix()}`, resellerId, status })
      .returning({ id: schema.organizations.id });
    await admin
      .insert(schema.workspaces)
      .values({ orgId: org!.id, name: 'Default', slug: 'default', isDefault: true });
    await admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await provisioner.seedTenantRoles(tx as unknown as Transaction, org!.id, {
        correlationId: uuidv7(),
      });
    });
    return org!.id;
  }

  async function grantOrgAdmin(userId: string, orgId: string) {
    const [role] = await admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.orgId, orgId), eq(schema.roles.key, TENANT_ROLE_KEYS.ORG_ADMIN)));
    await admin
      .insert(schema.userRoles)
      .values({ userId, roleId: role!.id, scopeType: 'organization', scopeId: orgId });
  }

  beforeAll(async () => {
    const saved = {
      AUTH_MAX_SESSIONS_PER_USER: process.env.AUTH_MAX_SESSIONS_PER_USER,
      METRICS_ENABLED: process.env.METRICS_ENABLED,
    };
    process.env.AUTH_MAX_SESSIONS_PER_USER = String(SESSION_CAP);
    process.env.METRICS_ENABLED = 'true';
    try {
      let createApp!: () => Promise<INestApplication>;
      let redisToken!: symbol | string;
      // Provider tokens must come from the same isolated module registry as
      // the application, or `app.get` cannot resolve them.
      let credentialToken!: typeof CredentialService;
      let provisionerToken!: typeof TenantRoleProvisioner;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        credentialToken = require('../src/iam/credential.service').CredentialService;
        provisionerToken =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../src/rbac/tenant-role-provisioner.service').TenantRoleProvisioner;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        createApp = require('../src/app.factory').createApp;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        redisToken = require('../src/redis/redis.module').REDIS_CLIENT;
      });
      app = await createApp();
      await app.init();
      credentials = app.get(credentialToken);
      provisioner = app.get(provisionerToken);
      const redis = app.get(redisToken) as {
        keys(p: string): Promise<string[]>;
        del(...k: string[]): Promise<number>;
      };
      clearRateLimits = async () => {
        const keys = await redis.keys('*ratelimit:*');
        if (keys.length > 0) await redis.del(...keys);
      };
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    pool = createPool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 2 });
    admin = createDatabase(pool);

    const [reseller] = await admin
      .insert(schema.resellers)
      .values({ name: `R metrics ${suffix()}`, slug: `rs-metrics-${suffix()}` })
      .returning({ id: schema.resellers.id });
    resellerId = reseller!.id;
    orgs.active = await plantOrg('active', 'active');
    orgs.suspended = await plantOrg('suspended', 'suspended');
    orgs.closed = await plantOrg('closed', 'closed');

    users.member = await createUser('metrics-member');
    await grantOrgAdmin(users.member.id, orgs.suspended);
    await grantOrgAdmin(users.member.id, orgs.closed);
    users.outsider = await createUser('metrics-outsider');
    await grantOrgAdmin(users.outsider.id, orgs.active);
    users.evictee = await createUser('metrics-evictee');
    await grantOrgAdmin(users.evictee.id, orgs.active);

    users.platform = await createUser('metrics-platform');
    await admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(
          and(
            eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
            isNull(schema.roles.orgId),
          ),
        );
      await tx
        .insert(schema.userRoles)
        .values({ userId: users.platform.id, roleId: role!.id, scopeType: 'platform' });
    });
  });

  afterAll(async () => {
    try {
      if (admin) await teardown();
    } finally {
      if (pool) await pool.end();
      if (app) await app.close();
    }
  });

  async function teardown() {
    const userIds = Object.values(users).map((u) => u.id);
    const orgIds = Object.values(orgs).filter(Boolean);
    // An empty list must still be valid SQL when set-up failed part-way.
    const list = (ids: string[]) =>
      ids.length
        ? sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )
        : sql`NULL::uuid`;
    await purgeAudit(
      admin,
      sql`org_id IN (${list(orgIds)}) OR actor_user_id IN (${list(userIds)})`,
    );
    await admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      await tx.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(userIds)})`);
      await tx.execute(
        sql`DELETE FROM user_roles WHERE user_id IN (${list(userIds)})
              AND NOT (scope_type = 'organization' AND org_id IN (${list(orgIds)}))`,
      );
      for (const table of ['teams', 'workspaces']) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${list(orgIds)})`);
      }
      // The organizations before their users: organization-scope grants, roles
      // and role permissions cascade with them — the exemption of the
      // last-organization-administrator rule (migration 0028).
      await tx.execute(sql`DELETE FROM organizations WHERE id IN (${list(orgIds)})`);
      await tx.execute(
        sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      await tx.execute(sql`DELETE FROM users WHERE id IN (${list(userIds)})`);
      if (resellerId) await tx.execute(sql`DELETE FROM resellers WHERE id = ${resellerId}`);
    });
  }

  const refusals = (text: string, status: string, operation: string) =>
    sample(text, 'acc_organization_status_refusals_total', { status, operation });

  it('exposes both counters on /metrics with their bounded labels only', async () => {
    const text = await scrape();
    expect(text).toContain('# TYPE acc_organization_status_refusals_total counter');
    expect(text).toContain('# TYPE acc_session_cap_evictions_total counter');
  });

  it('counts a suspended-organization access refusal once, as status=suspended operation=access', async () => {
    const t = await token(users.member.email);
    const before = await scrape();
    const res = await request(app.getHttpServer())
      .get(url('/workspaces'))
      .set('authorization', `Bearer ${t}`)
      .set('x-acc-organization', orgs.suspended);
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'TENANCY_ORGANIZATION_SUSPENDED',
    );
    const after = await scrape();
    expect(refusals(after, 'suspended', 'access') - refusals(before, 'suspended', 'access')).toBe(
      1,
    );
    expect(refusals(after, 'closed', 'access')).toBe(refusals(before, 'closed', 'access'));
  });

  it('counts a closed-organization access refusal as status=closed operation=access', async () => {
    const t = await token(users.member.email);
    const before = await scrape();
    const res = await request(app.getHttpServer())
      .get(url('/workspaces'))
      .set('authorization', `Bearer ${t}`)
      .set('x-acc-organization', orgs.closed);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'TENANCY_ORGANIZATION_CLOSED',
    );
    const after = await scrape();
    expect(refusals(after, 'closed', 'access') - refusals(before, 'closed', 'access')).toBe(1);
    expect(refusals(after, 'suspended', 'access')).toBe(refusals(before, 'suspended', 'access'));
  });

  it('counts a refused mutation in a suspended and in a closed organization as operation=mutation', async () => {
    const t = await token(users.platform.email);
    for (const status of ['suspended', 'closed'] as const) {
      const before = await scrape();
      const res = await request(app.getHttpServer())
        .post(url('/workspaces'))
        .set('authorization', `Bearer ${t}`)
        .set('x-acc-organization', orgs[status])
        .send({ name: 'refused', slug: `refused-${suffix()}` });
      expect(res.status).toBe(409);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        'ORGANIZATION_LIFECYCLE_CONFLICT',
      );
      const after = await scrape();
      expect(refusals(after, status, 'mutation') - refusals(before, status, 'mutation')).toBe(1);
    }
  });

  it('does not count refusals that are not caused by an inactive organization', async () => {
    const before = await scrape();
    // An organization the principal is not connected to: the generic mismatch.
    const outsider = await token(users.outsider.email);
    const mismatch = await request(app.getHttpServer())
      .get(url('/workspaces'))
      .set('authorization', `Bearer ${outsider}`)
      .set('x-acc-organization', orgs.suspended);
    expect((mismatch.body as { error: { code: string } }).error.code).toBe(
      'TENANCY_CONTEXT_MISMATCH',
    );
    // A lifecycle conflict on an active organization (reactivating it).
    const platform = await token(users.platform.email);
    const conflict = await request(app.getHttpServer())
      .post(url(`/organizations/${orgs.active}/reactivate`))
      .set('authorization', `Bearer ${platform}`)
      .send({});
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: { details: { status: string } } }).error.details.status).toBe(
      'active',
    );
    // An ordinary successful request.
    await request(app.getHttpServer())
      .get(url('/workspaces'))
      .set('authorization', `Bearer ${outsider}`)
      .expect(200);
    const after = await scrape();
    for (const status of ['suspended', 'closed']) {
      for (const operation of ['access', 'mutation']) {
        expect(refusals(after, status, operation)).toBe(refusals(before, status, operation));
      }
    }
  });

  it('counts each session evicted at the cap, and nothing for logins under it or failed logins', async () => {
    const evictions = async () => sample(await scrape(), 'acc_session_cap_evictions_total');
    const start = await evictions();
    for (let i = 0; i < SESSION_CAP; i += 1) {
      expect((await login(users.evictee.email)).status).toBe(200);
    }
    expect(await evictions()).toBe(start);
    expect((await login(users.evictee.email, 'not-the-password-at-all')).status).toBe(401);
    expect(await evictions()).toBe(start);

    expect((await login(users.evictee.email)).status).toBe(200);
    expect(await evictions()).toBe(start + 1);
    expect((await login(users.evictee.email)).status).toBe(200);
    expect(await evictions()).toBe(start + 2);

    // The counter agrees with the database: every eviction is a revoked session
    // with the cap reason, and the live sessions never exceed the cap.
    const [row] = (
      await admin.execute(
        sql`SELECT count(*) FILTER (WHERE revoked_reason = 'session_limit_exceeded')::int AS evicted,
                   count(*) FILTER (WHERE revoked_at IS NULL)::int AS live
              FROM sessions WHERE user_id = ${users.evictee.id}`,
      )
    ).rows as { evicted: number; live: number }[];
    expect(row).toEqual({ evicted: 2, live: SESSION_CAP });
  });
});
