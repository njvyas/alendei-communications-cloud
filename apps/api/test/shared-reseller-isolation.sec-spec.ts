/**
 * Shared-reseller isolation through the application (Gate-B security audit,
 * Blocker 1).
 *
 * The defect: `ScopeResolver.tenantContextFor` filled the tenant context's
 * `resellerId` from the selected organization's reseller for every principal;
 * `withRequestTenant` wrote it into `app.current_reseller_id`; and
 * `app_org_in_scope()` admits every organization under that reseller. Four
 * list endpoints carried no tenant predicate of their own, so an organization
 * administrator would have enumerated every sibling organization under the same
 * reseller — and every direct customer shares one. Every earlier fixture gave
 * each tenant its own reseller, which is why no test saw it.
 *
 *     Reseller A ── Org A1
 *                └─ Org A2
 *     Reseller B ── Org B1
 *
 * Part A drives real HTTP with real tokens. Part B computes each principal's
 * tenant context with the production `ScopeResolver` — exactly as `AuthGuard`
 * does — and runs unfiltered queries as `acc_app` under it, so the resolver
 * and RLS are proven together with no application filter in the way.
 */
import { ERROR_CODES, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema, type TenantSession, type Transaction } from '@acc/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { ScopeResolver } from '../src/auth/scope-resolver.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { CredentialService } from '../src/iam/credential.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';

interface Org {
  readonly label: string;
  readonly orgId: string;
  readonly resellerId: string;
  readonly workspaceId: string;
  readonly workspaceTwoId: string;
  readonly teamId: string;
  readonly roles: Record<string, string>;
  readonly admin: { userId: string; email: string };
  readonly adminAssignmentId: string;
  readonly apiKeyId: string;
  readonly auditId: string;
}

describe('shared-reseller isolation (application + acc_app)', () => {
  let h: Harness;
  let db: TenantDatabase;
  let resolver: ScopeResolver;
  let credentials: CredentialService;

  let resellerA: string;
  let resellerB: string;
  let a1: Org;
  let a2: Org;
  let b1: Org;
  const people: Record<string, { userId: string; email: string }> = {};
  const tokens: Record<string, string> = {};
  const createdUsers: string[] = [];

  const url = (path: string) => `/${PREFIX}${path}`;

  // --- fixtures ----------------------------------------------------------------

  async function createUser(label: string): Promise<{ userId: string; email: string }> {
    const email = `${label}-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;
    const [user] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    createdUsers.push(user!.id);
    return { userId: user!.id, email };
  }

  async function grant(
    userId: string,
    roleId: string,
    scopeType: 'platform' | 'reseller' | 'organization' | 'workspace' | 'team',
    scopeId: string | null,
  ): Promise<string> {
    return h.admin.transaction(async (tx) => {
      // Platform-level roles may only be granted under the platform flag, which
      // the owner declares transaction-locally exactly as `seed.ts` does.
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [row] = await tx
        .insert(schema.userRoles)
        .values({ userId, roleId, scopeType, scopeId })
        .returning({ id: schema.userRoles.id });
      return row!.id;
    });
  }

  async function platformRole(key: string): Promise<string> {
    const [row] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, key), isNull(schema.roles.orgId)));
    return row!.id;
  }

  async function createReseller(label: string): Promise<string> {
    const [row] = await h.admin
      .insert(schema.resellers)
      .values({
        name: `Reseller ${label}`,
        slug: `rs-${label}-${uuidv7().replace(/-/g, '').slice(-10)}`,
      })
      .returning({ id: schema.resellers.id });
    return row!.id;
  }

  async function createOrg(label: string, resellerId: string): Promise<Org> {
    const slug = `${label}-${uuidv7().replace(/-/g, '').slice(-10)}`;
    const [org] = await h.admin
      .insert(schema.organizations)
      .values({ name: `Org ${slug}`, slug: `org-${slug}`, resellerId })
      .returning({ id: schema.organizations.id });
    const orgId = org!.id;
    const [ws1] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId, name: 'Default', slug: 'default', isDefault: true })
      .returning({ id: schema.workspaces.id });
    const [ws2] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId, name: 'Second', slug: 'second' })
      .returning({ id: schema.workspaces.id });
    const [team] = await h.admin
      .insert(schema.teams)
      .values({ orgId, workspaceId: ws1!.id, name: 'Support' })
      .returning({ id: schema.teams.id });

    // The production seeding path for an organization's system roles.
    const provisioner = h.app.get(TenantRoleProvisioner);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await provisioner.seedTenantRoles(tx as unknown as Transaction, orgId, {
        correlationId: uuidv7(),
      });
    });
    const roleRows = await h.admin
      .select({ id: schema.roles.id, key: schema.roles.key })
      .from(schema.roles)
      .where(eq(schema.roles.orgId, orgId));
    const roles = Object.fromEntries(roleRows.map((r) => [r.key, r.id]));

    const admin = await createUser(`${label}-admin`);
    const adminAssignmentId = await grant(
      admin.userId,
      roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
      'organization',
      orgId,
    );

    const [key] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId,
        name: `Key ${slug}`,
        keyPrefix: `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`,
        keyHash: 'not-a-real-hash',
        scopes: ['workspaces.read'],
        createdBy: admin.userId,
      })
      .returning({ id: schema.apiKeys.id });

    const { rows } = await h.admin.execute<{ id: string }>(sql`
      INSERT INTO audit_logs (scope_type, scope_id, actor_type, actor_user_id, action, resource_type, outcome, correlation_id)
      VALUES ('organization', ${orgId}, 'user', ${admin.userId}, 'organization.updated', 'organization', 'success', ${uuidv7()})
      RETURNING id`);

    // A session, a WebSocket ticket and an idempotency record, so every
    // tenant-sensitive table has a row for Part B to (not) see.
    await h.admin.execute(sql`
      INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
      VALUES (${admin.userId}, ${`h-${uuidv7()}`}, now() + interval '1 day')`);
    await h.admin.execute(sql`
      INSERT INTO ws_tickets (ticket_hash, user_id, org_id, expires_at)
      VALUES (${`t-${uuidv7()}`}, ${admin.userId}, ${orgId}, now() + interval '30 seconds')`);
    await h.admin.execute(sql`
      INSERT INTO idempotency_keys (org_id, endpoint, idempotency_key, request_hash)
      VALUES (${orgId}, 'POST /test', ${`k-${uuidv7()}`}, 'x')`);

    return {
      label,
      orgId,
      resellerId,
      workspaceId: ws1!.id,
      workspaceTwoId: ws2!.id,
      teamId: team!.id,
      roles,
      admin,
      adminAssignmentId,
      apiKeyId: key!.id,
      auditId: rows[0]!.id,
    };
  }

  async function destroyOrg(org: Org): Promise<void> {
    await purgeAudit(h.admin, sql`org_id = ${org.orgId}`);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      for (const table of [
        'user_roles',
        'role_permissions',
        'roles',
        'ws_tickets',
        'api_keys',
        'idempotency_keys',
        'teams',
        'workspaces',
      ]) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id = ${org.orgId}`);
      }
    });
    await h.admin.execute(sql`DELETE FROM organizations WHERE id = ${org.orgId}`);
  }

  async function login(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  beforeAll(async () => {
    h = await startHarness();
    db = h.app.get(TenantDatabase);
    resolver = h.app.get(ScopeResolver);
    credentials = h.app.get(CredentialService);

    resellerA = await createReseller('shared-a');
    resellerB = await createReseller('shared-b');
    a1 = await createOrg('a1', resellerA);
    a2 = await createOrg('a2', resellerA);
    b1 = await createOrg('b1', resellerB);

    people.resellerA = await createUser('reseller-a');
    await grant(
      people.resellerA.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerA,
    );
    people.resellerB = await createUser('reseller-b');
    await grant(
      people.resellerB.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerB,
    );
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
    people.workspace = await createUser('a1-workspace');
    await grant(
      people.workspace.userId,
      a1.roles[TENANT_ROLE_KEYS.WORKSPACE_MANAGER]!,
      'workspace',
      a1.workspaceId,
    );
    people.team = await createUser('a1-team');
    await grant(people.team.userId, a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'team', a1.teamId);

    tokens.a1 = await login(a1.admin.email);
    tokens.a2 = await login(a2.admin.email);
    tokens.b1 = await login(b1.admin.email);
    for (const name of Object.keys(people)) tokens[name] = await login(people[name]!.email);
  }, 120_000);

  afterAll(async () => {
    await purgeAudit(h.admin, sql`true`);
    await h.admin.transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        for (const id of createdUsers) {
          await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
          await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${id}`);
        }
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
    });
    for (const org of [a1, a2, b1]) if (org) await destroyOrg(org);
    for (const id of createdUsers) await h.admin.execute(sql`DELETE FROM users WHERE id = ${id}`);
    await h.admin.execute(sql`DELETE FROM resellers WHERE id IN (${resellerA}, ${resellerB})`);
    await h.close();
  }, 120_000);

  // --- HTTP helpers --------------------------------------------------------------

  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    token: string,
    path: string,
    org?: string,
  ) => {
    const req = request(h.app.getHttpServer())
      [method](url(path))
      .set('authorization', `Bearer ${token}`);
    return org ? req.set('x-acc-organization', org) : req;
  };

  /** Every identifier belonging to `org` — any one of them in a response is a leak. */
  const identifiersOf = (org: Org): string[] => [
    org.orgId,
    org.workspaceId,
    org.workspaceTwoId,
    org.teamId,
    org.admin.userId,
    org.adminAssignmentId,
    org.apiKeyId,
    org.auditId,
    ...Object.values(org.roles),
  ];

  const LISTS = [
    '/tenants/workspaces?limit=100',
    '/api-keys?limit=100',
    '/role-assignments?limit=100',
    '/audit-logs?limit=100',
    '/users?limit=100',
    '/roles?limit=100',
  ];

  // ===========================================================================
  // Part A — application authorization over HTTP
  // ===========================================================================
  describe('A. tenant context and organization selection', () => {
    it('Org A1’s context carries no reseller claim and names only A1', async () => {
      // `/auth/me` is `@NoTenantContext()`: it never selects an organization, so
      // it cannot show the per-organization derivation (Part B pins that, and
      // the list/direct-object cases pin the whole chain). What it does show:
      // an organization member holds no reseller claim at all.
      const res = await call('get', tokens.a1!, '/auth/me').expect(200);
      expect(res.body.data.authorizedOrganizationIds).toEqual([a1.orgId]);
      expect(res.body.data.tenant.orgId).toBeNull();
      expect(res.body.data.tenant.resellerId).toBeNull();
      expect(res.body.data.tenant.isPlatformAdmin).toBe(false);
    });

    it('Org A1 → Org A2 = DENY and Org A1 → Org B1 = DENY at selection', async () => {
      for (const target of [a2.orgId, b1.orgId]) {
        const res = await call('get', tokens.a1!, '/tenants/workspaces', target).expect(403);
        expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
        expect(JSON.stringify(res.body)).not.toContain(target);
      }
    });

    it('Reseller A → Org A1 and Org A2 = ALLOW; → Org B1 = DENY', async () => {
      const me = await call('get', tokens.resellerA!, '/auth/me', a1.orgId).expect(200);
      expect([...me.body.data.authorizedOrganizationIds].sort()).toEqual(
        [a1.orgId, a2.orgId].sort(),
      );
      expect(me.body.data.tenant.resellerId).toBe(resellerA);
      await call('get', tokens.resellerA!, '/tenants/workspaces', a1.orgId).expect(200);
      await call('get', tokens.resellerA!, '/tenants/workspaces', a2.orgId).expect(200);
      const denied = await call('get', tokens.resellerA!, '/tenants/workspaces', b1.orgId).expect(
        403,
      );
      expect(denied.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it('Reseller B → Org A1 / Org A2 = DENY', async () => {
      for (const target of [a1.orgId, a2.orgId]) {
        const res = await call('get', tokens.resellerB!, '/tenants/workspaces', target).expect(403);
        expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      }
    });

    it('Platform → every organization = ALLOW, as a platform administrator', async () => {
      const me = await call('get', tokens.platform!, '/auth/me', b1.orgId).expect(200);
      expect(me.body.data.tenant.isPlatformAdmin).toBe(true);
      for (const target of [a1.orgId, a2.orgId, b1.orgId]) {
        await call('get', tokens.platform!, '/tenants/workspaces', target).expect(200);
      }
    });

    it('alendei_support may select any organization but is not a platform administrator', async () => {
      const me = await call('get', tokens.support!, '/auth/me', a1.orgId).expect(200);
      expect(me.body.data.tenant.isPlatformAdmin).toBe(false);
      await call('get', tokens.support!, '/tenants/workspaces', b1.orgId).expect(200);
      // Read-only: no write permission, whatever it selects.
      const res = await call('post', tokens.support!, '/roles', a1.orgId)
        .send({
          key: 'support_made',
          name: 'x',
          allowedScopeTypes: ['organization'],
          permissionKeys: [],
        })
        .expect((r) => expect([400, 403]).toContain(r.status));
      expect(res.status).not.toBe(201);
    });
  });

  describe('A. enumeration — Org A1 lists nothing of Org A2 or Org B1', () => {
    it.each(LISTS)('GET %s', async (path) => {
      const res = await call('get', tokens.a1!, path).expect(200);
      const body = JSON.stringify(res.body);
      for (const id of [...identifiersOf(a2), ...identifiersOf(b1)]) {
        expect(body.includes(id) ? `leaked ${id}` : 'clean').toBe('clean');
      }
    });

    it('positive control — the same lists do return Org A1’s own rows', async () => {
      expect(JSON.stringify((await call('get', tokens.a1!, LISTS[0]!).expect(200)).body)).toContain(
        a1.workspaceId,
      );
      expect(JSON.stringify((await call('get', tokens.a1!, LISTS[1]!).expect(200)).body)).toContain(
        a1.apiKeyId,
      );
      expect(JSON.stringify((await call('get', tokens.a1!, LISTS[2]!).expect(200)).body)).toContain(
        a1.adminAssignmentId,
      );
      expect(JSON.stringify((await call('get', tokens.a1!, LISTS[3]!).expect(200)).body)).toContain(
        a1.auditId,
      );
    });

    it.each(LISTS)('Reseller A acting in A1 lists nothing of Org B1: GET %s', async (path) => {
      // `reseller_admin` holds no `api_keys.read`, so that list is refused
      // outright; every page that is served must carry nothing of Org B1.
      const res = await call('get', tokens.resellerA!, path, a1.orgId);
      expect([200, 403]).toContain(res.status);
      const body = JSON.stringify(res.body);
      for (const id of identifiersOf(b1))
        expect(body.includes(id) ? `leaked ${id}` : 'clean').toBe('clean');
    });
  });

  describe('A. direct-object access with Org A2 identifiers — all 404, nothing moves', () => {
    it('reads', async () => {
      for (const path of [
        `/tenants/workspaces/${a2.workspaceId}`,
        `/api-keys/${a2.apiKeyId}`,
        `/role-assignments/${a2.adminAssignmentId}`,
        `/audit-logs/${a2.auditId}`,
        `/users/${a2.admin.userId}`,
        `/roles/${a2.roles[TENANT_ROLE_KEYS.ORG_ADMIN]}`,
      ]) {
        const res = await call('get', tokens.a1!, path);
        // `404`, never `403`: a sibling's object must be indistinguishable from
        // one that does not exist. A `403` here is the existence oracle the
        // widened reseller claim produced.
        expect(`${path} ${res.status}`).toBe(`${path} 404`);
      }
    });

    it('writes', async () => {
      await call('post', tokens.a1!, `/api-keys/${a2.apiKeyId}/revoke`).send({}).expect(404);
      await call('delete', tokens.a1!, `/role-assignments/${a2.adminAssignmentId}`).expect(404);
      await call('post', tokens.a1!, `/users/${a2.admin.userId}/disable`).send({}).expect(404);
      await call('patch', tokens.a1!, `/users/${a2.admin.userId}`)
        .send({ phone: '+919876543210' })
        .expect(404);

      const [key] = await h.admin
        .select({ r: schema.apiKeys.revokedAt })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, a2.apiKeyId));
      expect(key!.r).toBeNull();
      const [user] = await h.admin
        .select({ s: schema.users.status, p: schema.users.phone })
        .from(schema.users)
        .where(eq(schema.users.id, a2.admin.userId));
      expect(user).toEqual({ s: 'active', p: null });
      const [grantRow] = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.id, a2.adminAssignmentId));
      expect(grantRow).toBeDefined();
    });

    /**
     * The audit's exploit chain: pull a sibling's user into Org A1 with a grant
     * (role-assignment guard 5 decided reachability by RLS visibility), then
     * disable them globally. The first step must already fail.
     */
    it('Org A1 cannot enrol an Org A2 user, so the cross-tenant disable chain is closed', async () => {
      const res = await call('post', tokens.a1!, '/role-assignments')
        .send({
          userId: a2.admin.userId,
          roleId: a1.roles[TENANT_ROLE_KEYS.READ_ONLY],
          scopeType: 'organization',
          scopeId: a1.orgId,
        })
        .expect(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
      const rows = await h.admin
        .select()
        .from(schema.userRoles)
        .where(
          and(eq(schema.userRoles.userId, a2.admin.userId), eq(schema.userRoles.orgId, a1.orgId)),
        );
      expect(rows).toEqual([]);
    });

    it('Org A1 cannot grant or mint at an Org A2 scope', async () => {
      await call('post', tokens.a1!, '/role-assignments')
        .send({
          userId: a1.admin.userId,
          roleId: a2.roles[TENANT_ROLE_KEYS.READ_ONLY],
          scopeType: 'organization',
          scopeId: a2.orgId,
        })
        .expect(404);
      await call('post', tokens.a1!, '/api-keys')
        .send({
          name: `x-${uuidv7().slice(-6)}`,
          scopeType: 'organization',
          scopeId: a2.orgId,
          scopes: ['workspaces.read'],
        })
        .expect(404);
    });

    it('Org A1 → Reseller A = DENY and Org A1 → Reseller B = DENY for grants', async () => {
      const ownReseller = await call('post', tokens.a1!, '/role-assignments').send({
        userId: a1.admin.userId,
        roleId: a1.roles[TENANT_ROLE_KEYS.READ_ONLY],
        scopeType: 'reseller',
        scopeId: resellerA,
      });
      expect([403, 404]).toContain(ownReseller.status);
      const otherReseller = await call('post', tokens.a1!, '/role-assignments').send({
        userId: a1.admin.userId,
        roleId: a1.roles[TENANT_ROLE_KEYS.READ_ONLY],
        scopeType: 'reseller',
        scopeId: resellerB,
      });
      expect(otherReseller.status).toBe(404);
      const rows = await h.admin
        .select()
        .from(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, a1.admin.userId),
            eq(schema.userRoles.scopeType, 'reseller'),
          ),
        );
      expect(rows).toEqual([]);
    });
  });

  describe('A. reseller and platform reach through direct objects', () => {
    it('Reseller A reads Org A2’s workspace in A2’s context, but not through A1’s', async () => {
      await call(
        'get',
        tokens.resellerA!,
        `/tenants/workspaces/${a2.workspaceId}`,
        a2.orgId,
      ).expect(200);
      // Pinned to the selected organization: an authorization made for A1 does
      // not hand out A2's object even to a principal who may read both.
      await call(
        'get',
        tokens.resellerA!,
        `/tenants/workspaces/${a2.workspaceId}`,
        a1.orgId,
      ).expect(404);
    });

    it('Reseller A → Org B1 objects = 404; Reseller B → Org A1 objects = 404', async () => {
      await call('get', tokens.resellerA!, `/api-keys/${b1.apiKeyId}`, a1.orgId).expect(404);
      await call('get', tokens.resellerA!, `/audit-logs/${b1.auditId}`, a1.orgId).expect(404);
      await call('get', tokens.resellerB!, `/api-keys/${a1.apiKeyId}`, b1.orgId).expect(404);
      await call(
        'get',
        tokens.resellerB!,
        `/role-assignments/${a1.adminAssignmentId}`,
        b1.orgId,
      ).expect(404);
    });

    it('Platform reads any organization’s objects in that organization’s context', async () => {
      await call('get', tokens.platform!, `/api-keys/${b1.apiKeyId}`, b1.orgId).expect(200);
      await call('get', tokens.platform!, `/tenants/workspaces/${a2.workspaceId}`, a2.orgId).expect(
        200,
      );
    });
  });

  describe('A. workspace- and team-scoped principals stay below the organization', () => {
    it('a workspace-scoped user cannot read organization-level lists', async () => {
      for (const path of ['/tenants/workspaces', '/api-keys', '/role-assignments', '/audit-logs']) {
        const res = await call('get', tokens.workspace!, path);
        expect(`${path} ${res.status}`).toBe(`${path} 403`);
      }
    });

    it('a team-scoped user cannot read organization-level lists', async () => {
      for (const path of ['/tenants/workspaces', '/api-keys', '/role-assignments', '/audit-logs']) {
        const res = await call('get', tokens.team!, path);
        expect(`${path} ${res.status}`).toBe(`${path} 403`);
      }
    });
  });

  // ===========================================================================
  // Part B — the context the resolver computes, applied to acc_app, no filter
  // ===========================================================================
  describe('B. resolver-computed context, direct acc_app access', () => {
    /** Exactly what `AuthGuard` derives for this user and organization selection. */
    async function contextFor(userId: string, requestedOrg: string | null): Promise<TenantSession> {
      const tenant = await db.auth.transaction(async (raw) => {
        const tx = raw as Transaction;
        const scopes = await resolver.forUser(tx, userId);
        const orgId = resolver.selectOrganization(scopes, requestedOrg);
        return resolver.tenantContextFor(tx, scopes, orgId);
      });
      return { ...tenant, userId };
    }

    const TABLES = [
      'organizations',
      'workspaces',
      'teams',
      'api_keys',
      'ws_tickets',
      'idempotency_keys',
      'roles',
      'role_permissions',
      'user_roles',
      'audit_logs',
    ];
    const label = (orgId: string | null): string | undefined =>
      orgId === a1.orgId ? 'A1' : orgId === a2.orgId ? 'A2' : orgId === b1.orgId ? 'B1' : undefined;

    async function reach(session: TenantSession): Promise<Record<string, string[]>> {
      return db.withTenant(session, async (tx) => {
        const out: Record<string, string[]> = {};
        for (const table of TABLES) {
          const column = table === 'organizations' ? 'id' : 'org_id';
          const { rows } = await tx.execute<{ org: string | null }>(
            sql.raw(`SELECT DISTINCT ${column}::text AS org FROM ${table}`),
          );
          out[table] = rows
            .map((r) => label(r.org))
            .filter((l): l is string => !!l)
            .sort();
        }
        const users = await tx.execute<{ id: string }>(sql`SELECT id::text AS id FROM users`);
        out.users = users.rows
          .map((r) => [a1, a2, b1].find((o) => o.admin.userId === r.id))
          .filter((o): o is Org => !!o)
          .map((o) => label(o.orgId)!)
          .sort();
        const sessions = await tx.execute<{ u: string }>(
          sql`SELECT DISTINCT user_id::text AS u FROM sessions`,
        );
        out.sessions = sessions.rows
          .map((r) => [a1, a2, b1].find((o) => o.admin.userId === r.u))
          .filter((o): o is Org => !!o)
          .map((o) => label(o.orgId)!)
          .sort();
        return out;
      });
    }

    const expectOnly = (seen: Record<string, string[]>, expected: string[]) => {
      for (const [table, orgs] of Object.entries(seen))
        expect(`${table}=${orgs.join(',')}`).toBe(`${table}=${expected.join(',')}`);
    };

    it('the resolver gives an organization member no reseller claim', async () => {
      const ctx = await contextFor(a1.admin.userId, null);
      expect(ctx).toMatchObject({ orgId: a1.orgId, resellerId: null, isPlatformAdmin: false });
    });

    it('Org A1 → Org A2 / Org B1 = DENY on every tenant table', async () => {
      expectOnly(await reach(await contextFor(a1.admin.userId, null)), ['A1']);
    });

    it('Org A2 → Org A1 = DENY on every tenant table', async () => {
      expectOnly(await reach(await contextFor(a2.admin.userId, null)), ['A2']);
    });

    it('Reseller A (acting in A1) → A1 and A2 = ALLOW, B1 = DENY', async () => {
      const ctx = await contextFor(people.resellerA!.userId, a1.orgId);
      expect(ctx.resellerId).toBe(resellerA);
      const seen = await reach(ctx);
      for (const table of TABLES)
        expect(`${table}=${seen[table]!.join(',')}`).toBe(`${table}=A1,A2`);
    });

    it('Reseller B → B1 only', async () => {
      expectOnly(await reach(await contextFor(people.resellerB!.userId, b1.orgId)), ['B1']);
    });

    it('Platform administrator → all three', async () => {
      const ctx = await contextFor(people.platform!.userId, a1.orgId);
      expect(ctx.isPlatformAdmin).toBe(true);
      const seen = await reach(ctx);
      for (const table of TABLES)
        expect(`${table}=${seen[table]!.join(',')}`).toBe(`${table}=A1,A2,B1`);
    });

    it('alendei_support acting in A1 → A1 only: a platform-scope grant is not platform-admin reach', async () => {
      const ctx = await contextFor(people.support!.userId, a1.orgId);
      expect(ctx.isPlatformAdmin).toBe(false);
      expectOnly(await reach(ctx), ['A1']);
    });
  });
});
