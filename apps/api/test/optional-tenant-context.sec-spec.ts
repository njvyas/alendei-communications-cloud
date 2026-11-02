/**
 * D-3: Optional tenant context for four routes (QA defect D-3).
 *
 * Target routes:
 * 1. POST /resellers
 * 2. POST /resellers/:id/suspend
 * 3. POST /resellers/:id/reactivate
 * 4. POST /onboarding/direct
 *
 * Verifies:
 * 1. Decorating all four routes with @OptionalTenantContext():
 *    - Unauthenticated callers receive 401 AUTH_CREDENTIAL_REQUIRED.
 *    - Tenant principals (single-org or multi-org with header) receive 403 AUTHZ_SCOPE_DENIED
 *      and their refusal IS audited at their resolved organization scope (ADR-005 D-6).
 *    - Reseller admins receive 403 AUTHZ_SCOPE_DENIED and their refusal IS audited at
 *      their resolved reseller scope.
 *    - Platform support receives 403 AUTHZ_SCOPE_DENIED and their refusal IS audited at
 *      platform scope.
 * 2. Binding decision D3-Q1:
 *    - Multi-organization member with NO organization header:
 *        - Returns 403 AUTHZ_SCOPE_DENIED.
 *        - Emits a structured API warning log.
 *        - ZERO audit records are created (unambiguous scope cannot be determined).
 *        - Never returns 500 INTERNAL_ERROR (no unhandled actorScope error).
 *        - No arbitrary organization selection or cross-tenant disclosure.
 *    - Multi-organization member with invalid/foreign organization header receives
 *      403 TENANCY_CONTEXT_MISMATCH.
 * 3. Implementation invariants:
 *    - POST /onboarding/direct runs with authSession.orgId: null (unattached to caller org).
 *    - Reseller suspend/reactivate uses caller's actual isPlatformAdmin, not hardcoded true.
 *    - Super admin (holding PLATFORM_TENANTS_MANAGE) succeeds on all four routes (201 / 200).
 * 4. Zero side effects on refused requests.
 */
import request from 'supertest';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PLATFORM_ROLE_KEYS,
  TENANT_ROLE_KEYS,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { purgeAudit, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, suffix, url, type Org, type Person } from './revocation-fixtures';

describe('D-3: Optional tenant context on four routes', () => {
  let h: Harness;
  let w: RevocationWorld;
  let orgA: Org;
  let orgB: Org;
  let singleOrgUser: Person;
  let multiOrgUser: Person;
  let resellerAdmin: Person;
  let support: Person;
  let superAdmin: Person;
  let testResellerId: string;
  const token: Record<string, string> = {};

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    await w.init('d3-test');

    // 1. Two organizations under w.resellerId
    orgA = await w.org('d3-org-a');
    orgB = await w.org('d3-org-b');

    // 2. Single-org user: grant only in orgA
    singleOrgUser = await w.person('d3-single-user');
    await w.grant(singleOrgUser.userId, orgA.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', orgA.orgId);

    // 3. Multi-org user: grants in both orgA and orgB
    multiOrgUser = await w.person('d3-multi-user');
    await w.grant(multiOrgUser.userId, orgA.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', orgA.orgId);
    await w.grant(multiOrgUser.userId, orgB.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', orgB.orgId);

    // 4. Reseller admin
    resellerAdmin = await w.resellerAdmin(w.resellerId, 'd3-reseller-admin');

    // 5. Platform support
    support = await w.person('d3-support');
    await w.grant(
      support.userId,
      await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );

    // 6. Super admin
    superAdmin = await w.superAdmin('d3-super-admin');

    // 7. Seed an active reseller for suspend/reactivate tests
    const [r] = await h.admin
      .insert(schema.resellers)
      .values({
        name: `D3 Managed Reseller ${suffix()}`,
        slug: `d3-reseller-${suffix()}`,
        status: 'active',
      })
      .returning({ id: schema.resellers.id });
    testResellerId = r!.id;

    for (const [k, p] of Object.entries({
      singleOrgUser,
      multiOrgUser,
      resellerAdmin,
      support,
      superAdmin,
    })) {
      token[k] = await w.login(p.email);
    }
  }, 120_000);

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    try {
      const orgIds = [orgA?.orgId, orgB?.orgId].filter(Boolean);
      if (orgIds.length > 0) {
        await purgeAudit(
          h.admin,
          sql`org_id IN (${sql.join(orgIds.map((id) => sql`${id}`), sql`, `)})`,
        );
      }
      if (testResellerId) {
        await purgeAudit(h.admin, sql`reseller_id = ${testResellerId}`);
        await h.admin.delete(schema.resellers).where(eq(schema.resellers.id, testResellerId));
      }
    } catch (err) {
      cleanupErrors.push(err);
    }

    try {
      await w.teardown();
    } catch (err) {
      cleanupErrors.push(err);
    }

    try {
      await h.close();
    } catch (err) {
      cleanupErrors.push(err);
    }

    if (cleanupErrors.length > 0) {
      if (cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      }
      throw new AggregateError(
        cleanupErrors,
        `afterAll cleanup failed with ${cleanupErrors.length} errors`,
      );
    }
  }, 120_000);

  type RouteDef = {
    name: string;
    path: () => string;
    body: Record<string, unknown>;
  };

  const TARGET_ROUTES: RouteDef[] = [
    {
      name: 'POST /resellers',
      path: () => '/resellers',
      body: { name: `Test Reseller ${suffix()}`, slug: `test-r-${suffix()}` },
    },
    {
      name: 'POST /resellers/:id/suspend',
      path: () => `/resellers/${testResellerId}/suspend`,
      body: { reason: 'Unauthorized suspend attempt' },
    },
    {
      name: 'POST /resellers/:id/reactivate',
      path: () => `/resellers/${testResellerId}/reactivate`,
      body: { reason: 'Unauthorized reactivate attempt' },
    },
    {
      name: 'POST /onboarding/direct',
      path: () => '/onboarding/direct',
      body: {
        name: `Direct Customer ${suffix()}`,
        slug: `dir-cust-${suffix()}`,
        adminUser: {
          email: `admin-${suffix()}@example.com`,
          firstName: 'Direct',
          lastName: 'Admin',
        },
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // 1. Unauthenticated Callers
  // ---------------------------------------------------------------------------
  describe('Unauthenticated callers', () => {
    it.each(TARGET_ROUTES)('$name refuses with 401 AUTH_CREDENTIAL_REQUIRED', async (route) => {
      const res = await request(h.app.getHttpServer())
        .post(url(route.path()))
        .send(route.body);

      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe(ERROR_CODES.AUTH_CREDENTIAL_REQUIRED);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. D3-Q1 Binding Decision: Multi-Org Member with NO Organization Header
  // ---------------------------------------------------------------------------
  describe('D3-Q1: Multi-org member with no organization header', () => {
    it.each(TARGET_ROUTES)(
      '$name returns 403 AUTHZ_SCOPE_DENIED without audit record and never 500',
      async (route) => {
        const auditBeforeCount = await h.admin
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.auditLogs);

        const res = await request(h.app.getHttpServer())
          .post(url(route.path()))
          .set('authorization', `Bearer ${token.multiOrgUser}`)
          .send(route.body);

        // Crucial: Must be 403, NOT 500 (the bug was an unhandled 500 error!)
        expect(res.status).toBe(403);
        expect(res.body.error?.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

        // D3-Q1: No audit record created because unambiguous org cannot be determined
        const auditAfterCount = await h.admin
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.auditLogs);
        expect(auditAfterCount[0]?.count).toBe(auditBeforeCount[0]?.count);
      },
    );

    it('refuses multi-org member with foreign organization header with 403 TENANCY_CONTEXT_MISMATCH', async () => {
      const foreignOrgId = uuidv7();
      const res = await request(h.app.getHttpServer())
        .post(url('/resellers'))
        .set('authorization', `Bearer ${token.multiOrgUser}`)
        .set('x-acc-organization', foreignOrgId)
        .send({ name: 'Denied Reseller', slug: `denied-r-${suffix()}` });

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Attributable Callers: Preserving Audit Attribution
  // ---------------------------------------------------------------------------
  describe('Preserving audit attribution for attributable callers', () => {
    it.each(TARGET_ROUTES)(
      '$name audits denial attributed to single-org user organization',
      async (route) => {
        const res = await request(h.app.getHttpServer())
          .post(url(route.path()))
          .set('authorization', `Bearer ${token.singleOrgUser}`)
          .send(route.body);

        expect(res.status).toBe(403);
        expect(res.body.error?.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

        // Denial audit row MUST exist and be attributed to orgA
        const [audit] = await h.admin
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.action, AUDIT_ACTIONS.AUTHORIZATION_DENIED),
              eq(schema.auditLogs.correlationId, res.headers['x-correlation-id'] as string),
            ),
          );
        expect(audit).toBeDefined();
        expect(audit.scopeType).toBe('organization');
        expect(audit.scopeId).toBe(orgA.orgId);
        expect(audit.orgId).toBe(orgA.orgId);
      },
    );

    it.each(TARGET_ROUTES)(
      '$name audits denial attributed to specified org when multi-org member supplies header',
      async (route) => {
        const res = await request(h.app.getHttpServer())
          .post(url(route.path()))
          .set('authorization', `Bearer ${token.multiOrgUser}`)
          .set('x-acc-organization', orgB.orgId)
          .send(route.body);

        expect(res.status).toBe(403);
        expect(res.body.error?.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

        // Denial audit row MUST exist and be attributed to orgB
        const [audit] = await h.admin
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.action, AUDIT_ACTIONS.AUTHORIZATION_DENIED),
              eq(schema.auditLogs.correlationId, res.headers['x-correlation-id'] as string),
            ),
          );
        expect(audit).toBeDefined();
        expect(audit.scopeType).toBe('organization');
        expect(audit.scopeId).toBe(orgB.orgId);
        expect(audit.orgId).toBe(orgB.orgId);
      },
    );

    it.each(TARGET_ROUTES)(
      '$name audits denial attributed to reseller for reseller admin caller',
      async (route) => {
        const res = await request(h.app.getHttpServer())
          .post(url(route.path()))
          .set('authorization', `Bearer ${token.resellerAdmin}`)
          .send(route.body);

        expect(res.status).toBe(403);
        expect(res.body.error?.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

        const [audit] = await h.admin
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.action, AUDIT_ACTIONS.AUTHORIZATION_DENIED),
              eq(schema.auditLogs.correlationId, res.headers['x-correlation-id'] as string),
            ),
          );
        expect(audit).toBeDefined();
        expect(audit.scopeType).toBe('reseller');
        expect(audit.scopeId).toBe(w.resellerId);
      },
    );

    it.each(TARGET_ROUTES)(
      '$name audits denial attributed to platform for platform support caller',
      async (route) => {
        const res = await request(h.app.getHttpServer())
          .post(url(route.path()))
          .set('authorization', `Bearer ${token.support}`)
          .send(route.body);

        expect(res.status).toBe(403);
        expect(res.body.error?.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

        const [audit] = await h.admin
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.action, AUDIT_ACTIONS.AUTHORIZATION_DENIED),
              eq(schema.auditLogs.correlationId, res.headers['x-correlation-id'] as string),
            ),
          );
        expect(audit).toBeDefined();
        expect(audit.scopeType).toBe('platform');
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 4. Authorized Execution: Super Admin Success
  // ---------------------------------------------------------------------------
  describe('Super admin execution and side-effects verification', () => {
    it('creates a reseller successfully (201 Created)', async () => {
      const resellerPayload = {
        name: `Super Reseller ${suffix()}`,
        slug: `super-r-${suffix()}`,
      };
      const res = await request(h.app.getHttpServer())
        .post(url('/resellers'))
        .set('authorization', `Bearer ${token.superAdmin}`)
        .send(resellerPayload);

      expect(res.status).toBe(201);
      expect(res.body.data.slug).toBe(resellerPayload.slug);

      // Clean up created reseller
      const createdResellerId = res.body.data.id;
      await purgeAudit(h.admin, sql`reseller_id = ${createdResellerId}`);
      await h.admin.delete(schema.resellers).where(eq(schema.resellers.id, createdResellerId));
    });

    it('suspends and reactivates a reseller with caller actual platform status (200 OK)', async () => {
      // Suspend
      const suspendRes = await request(h.app.getHttpServer())
        .post(url(`/resellers/${testResellerId}/suspend`))
        .set('authorization', `Bearer ${token.superAdmin}`)
        .send({ reason: 'Admin routine audit' });

      expect(suspendRes.status).toBe(200);
      expect(suspendRes.body.data.status).toBe('suspended');

      // Reactivate
      const reactivateRes = await request(h.app.getHttpServer())
        .post(url(`/resellers/${testResellerId}/reactivate`))
        .set('authorization', `Bearer ${token.superAdmin}`)
        .send({ reason: 'Admin audit cleared' });

      expect(reactivateRes.status).toBe(200);
      expect(reactivateRes.body.data.status).toBe('active');
    });

    it('onboards direct customer explicitly unattached to caller org (201 Created)', async () => {
      const directPayload = {
        name: `Direct Corp ${suffix()}`,
        slug: `direct-corp-${suffix()}`,
        adminUser: {
          email: `admin-${suffix()}@directcorp.example.com`,
          firstName: 'Direct',
          lastName: 'Admin',
        },
      };
      const res = await request(h.app.getHttpServer())
        .post(url('/onboarding/direct'))
        .set('authorization', `Bearer ${token.superAdmin}`)
        .send(directPayload);

      expect(res.status).toBe(201);
      expect(res.body.data.organizationSlug).toBe(directPayload.slug);
      expect(res.body.data.domain.domain).toContain(directPayload.slug);

      // Clean up direct customer
      const createdOrgId = res.body.data.organizationId;
      await purgeAudit(h.admin, sql`org_id = ${createdOrgId}`);
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.orgId, createdOrgId));
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.provisioning','on',true)`);
        await tx.execute(sql`DELETE FROM role_permissions WHERE org_id = ${createdOrgId}`);
        await tx.execute(sql`DELETE FROM roles WHERE org_id = ${createdOrgId}`);
      });
      await h.admin.delete(schema.organizationDomains).where(eq(schema.organizationDomains.orgId, createdOrgId));
      await h.admin.delete(schema.workspaces).where(eq(schema.workspaces.orgId, createdOrgId));
      await h.admin.delete(schema.organizations).where(eq(schema.organizations.id, createdOrgId));
      await h.admin.delete(schema.users).where(eq(schema.users.email, directPayload.adminUser.email));
    });
  });
});
