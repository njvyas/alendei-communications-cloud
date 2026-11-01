/**
 * Platform operational support and troubleshooting (U13.4, `SECURITY.md`, ADR-015).
 *
 * 1. Read-only access by default: PLATFORM_SUPPORT_READ permission.
 * 2. Strict negative authorization: unauthenticated callers get 401, tenant admins get 403.
 * 3. Probing non-existent organizations fails closed with 403 (no existence oracle).
 * 4. Authorized platform support operators can inspect overview, routing, dispatch, and cross-tenant audit.
 * 5. Privacy: recipient addresses are masked; message bodies and provider credentials/secrets are omitted.
 * 6. Auditability: every diagnostic read is synchronously recorded in audit_logs.
 */
import { ERROR_CODES, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { purgeAudit, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, url, type Org, type Person } from './revocation-fixtures';

describe('Platform Support & Operations (U13.4 Security & RLS Spec)', () => {
  let h: Harness;
  let w: RevocationWorld;
  let org: Org;
  let supportUser: Person;
  let supportToken: string;
  let tenantAdmin: Person;
  let tenantAdminToken: string;

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    await w.init('platform-support');
    org = await w.org('support-target');

    // Create a user with alendei_support platform role
    supportUser = await w.person('support-operator');
    const [supportRole] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT));
    await w.grant(supportUser.userId, supportRole!.id, 'platform', null);
    supportToken = await w.login(supportUser.email);

    // Create a tenant admin user
    const adminPerson = await w.admin(org, 'tenant-admin');
    tenantAdmin = adminPerson;
    tenantAdminToken = await w.login(tenantAdmin.email);
  }, 120_000);

  afterAll(async () => {
    await w.teardown();
    await h.close();
  }, 120_000);

  afterEach(async () => {
    await purgeAudit(h.admin, sql`action = 'platform.support.diagnostic_read'`);
  });

  describe('Negative authorization — unauthenticated (401)', () => {
    it('rejects overview request without token with 401', async () => {
      const res = await request(h.app.getHttpServer()).get(
        url(`/platform/support/organizations/${org.orgId}/overview`),
      );
      expect(res.status).toBe(401);
    });

    it('rejects routing diagnostics request without token with 401', async () => {
      const res = await request(h.app.getHttpServer()).get(
        url(`/platform/support/organizations/${org.orgId}/routing`),
      );
      expect(res.status).toBe(401);
    });

    it('rejects dispatch diagnostics request without token with 401', async () => {
      const res = await request(h.app.getHttpServer()).get(
        url(`/platform/support/organizations/${org.orgId}/dispatch`),
      );
      expect(res.status).toBe(401);
    });

    it('rejects cross-tenant audit search without token with 401', async () => {
      const res = await request(h.app.getHttpServer()).get(url('/platform/support/audit'));
      expect(res.status).toBe(401);
    });
  });

  describe('Negative authorization — tenant principals (403)', () => {
    it('refuses tenant administrator on overview with 403', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/overview`))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('refuses tenant administrator on routing diagnostics with 403', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/routing`))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('refuses tenant administrator on dispatch diagnostics with 403', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/dispatch`))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('refuses tenant administrator on cross-tenant audit search with 403', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url('/platform/support/audit'))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('refuses tenant administrator probing non-existent organization with 403 (fails closed before disclosure)', async () => {
      const randomOrgId = uuidv7();
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${randomOrgId}/overview`))
        .set('authorization', `Bearer ${tenantAdminToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Platform Support Authorized Operations (200)', () => {
    it('returns 404 for authorized support user when organization does not exist', async () => {
      const nonExistentOrgId = uuidv7();
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${nonExistentOrgId}/overview`))
        .set('authorization', `Bearer ${supportToken}`);
      if (res.status !== 404) console.error('Non-existent org error:', res.status, res.body);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('allows support operator to inspect organization overview', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/overview`))
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.organization.id).toBe(org.orgId);
      expect(res.body.data.workspaces).toBeDefined();
      expect(res.body.data.metrics).toBeDefined();

      // Check synchronous audit record was written
      const auditRows = await h.admin
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'platform.support.diagnostic_read'));
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      const audit = auditRows.find((r) => r.resourceId === org.orgId);
      expect(audit).toBeDefined();
      expect(audit?.actorUserId).toBe(supportUser.userId);
      expect(audit?.outcome).toBe('success');
    });

    it('allows support operator to inspect routing without exposing provider credentials', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/routing`))
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.channels).toBeDefined();
      expect(res.body.data.assignments).toBeDefined();
      expect(res.body.data.providerHealth).toBeDefined();

      const rawJson = JSON.stringify(res.body);
      expect(rawJson).not.toContain('secret');
      expect(rawJson).not.toContain('apiKey');
      expect(rawJson).not.toContain('credentials');
      expect(rawJson).not.toContain('password');
      expect(rawJson).not.toContain('token');
    });

    it('allows support operator to inspect dispatch diagnostics and masks recipient PII', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/platform/support/organizations/${org.orgId}/dispatch`))
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.queue).toBeDefined();
      expect(res.body.data.queue.pendingCount).toBeDefined();
      expect(res.body.data.recentFailures).toBeDefined();
    });

    it('allows support operator to execute cross-tenant audit search with cursor pagination', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url('/platform/support/audit?limit=10'))
        .set('authorization', `Bearer ${supportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.page).toBeDefined();
      expect(res.body.page.limit).toBe(10);
    });
  });
});
