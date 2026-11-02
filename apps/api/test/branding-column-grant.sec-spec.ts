/**
 * D-2: Column-level UPDATE grant on organizations.brand_config (QA defect D-2).
 *
 * Verifies:
 * 1. Migration 0041 granted UPDATE (brand_config) to acc_app:
 *    - Tenant admin can update organization branding (200 OK).
 *    - Reseller admin of the parent reseller can update branding (200 OK).
 *    - Super admin can update organization branding (200 OK).
 * 2. Authorization and lifecycle boundaries:
 *    - Platform support read works (200 OK), but update is forbidden (403 AUTHZ_SCOPE_DENIED).
 *    - Reseller admin of an unrelated reseller receives 404 RESOURCE_NOT_FOUND (no leakage).
 *    - Suspended organization:
 *        - Tenant admin receives 403 TENANCY_ORGANIZATION_SUSPENDED.
 *        - Reseller admin receives 403 TENANCY_ORGANIZATION_SUSPENDED.
 *        - Super admin receives 409 ORGANIZATION_LIFECYCLE_CONFLICT.
 *    - Closed organization:
 *        - Tenant admin receives 403 TENANCY_ORGANIZATION_CLOSED.
 *        - Reseller admin receives 403 TENANCY_ORGANIZATION_CLOSED.
 *        - Super admin receives 409 ORGANIZATION_LIFECYCLE_CONFLICT.
 * 3. Database-level privilege boundaries (acc_app, acc_auth, acc_relay):
 *    - acc_app can UPDATE brand_config on an active organization.
 *    - acc_app CANNOT UPDATE ungranted columns (e.g. slug, id) -> SQLSTATE 42501.
 *    - acc_app CANNOT UPDATE a closed organization -> trigger organizations_closed_terminal.
 *    - acc_auth CANNOT UPDATE brand_config -> SQLSTATE 42501.
 *    - acc_relay CANNOT UPDATE brand_config -> SQLSTATE 42501.
 */
import request from 'supertest';
import { AUDIT_ACTIONS, ERROR_CODES, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { purgeAudit, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, url, type Org, type Person } from './revocation-fixtures';

describe('D-2: Branding column-level grant and lifecycle enforcement', () => {
  let h: Harness;
  let w: RevocationWorld;
  let orgActive: Org;
  let orgSuspended: Org;
  let orgClosed: Org;
  let adminActive: Person;
  let adminSuspended: Person;
  let adminClosed: Person;
  let resellerAdminOwn: Person;
  let resellerAdminOther: Person;
  let support: Person;
  let superAdmin: Person;
  const token: Record<string, string> = {};

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    await w.init('d2-branding');

    // 1. Active organization under w.resellerId
    orgActive = await w.org('d2-active');
    adminActive = await w.admin(orgActive, 'd2-admin-act');

    // 2. Suspended organization under w.resellerId
    orgSuspended = await w.org('d2-suspended');
    adminSuspended = await w.admin(orgSuspended, 'd2-admin-susp');
    await h.admin
      .update(schema.organizations)
      .set({
        status: 'suspended',
        statusChangedAt: new Date(),
        statusReason: 'Suspended for testing D-2',
      })
      .where(eq(schema.organizations.id, orgSuspended.orgId));

    // 3. Closed organization under w.resellerId
    orgClosed = await w.org('d2-closed');
    adminClosed = await w.admin(orgClosed, 'd2-admin-closed');
    await h.admin
      .update(schema.organizations)
      .set({
        status: 'closed',
        statusChangedAt: new Date(),
        statusReason: 'Closed for testing D-2',
      })
      .where(eq(schema.organizations.id, orgClosed.orgId));

    // 4. Reseller admin of the owning reseller
    resellerAdminOwn = await w.resellerAdmin(w.resellerId, 'd2-reseller-own');

    // 5. Reseller admin of a separate, unrelated reseller
    const otherReseller = await w.reseller('d2-other-reseller');
    resellerAdminOther = await w.resellerAdmin(otherReseller, 'd2-reseller-other');

    // 6. Platform support
    support = await w.person('d2-support');
    await w.grant(
      support.userId,
      await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );

    // 7. Super admin
    superAdmin = await w.superAdmin('d2-super');

    for (const [k, p] of Object.entries({
      adminActive,
      adminSuspended,
      adminClosed,
      resellerAdminOwn,
      resellerAdminOther,
      support,
      superAdmin,
    })) {
      token[k] = await w.login(p.email);
    }
  }, 120_000);

  afterAll(async () => {
    const orgIds = [orgActive?.orgId, orgSuspended?.orgId, orgClosed?.orgId].filter(Boolean);
    if (orgIds.length > 0) {
      await purgeAudit(
        h.admin,
        sql`org_id IN (${sql.join(
          orgIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }
    await w.teardown();
    await h.close();
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Tenant Administrator Behavior
  // ---------------------------------------------------------------------------
  describe('Tenant administrator behavior', () => {
    it('updates branding successfully on an active organization (200 OK)', async () => {
      const brandPayload = {
        brandName: 'Brand Active Tenant',
        primaryColor: '#4f46e5',
        supportEmail: 'support@active.example.com',
      };
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgActive.orgId}/branding`))
        .set('authorization', `Bearer ${token.adminActive}`)
        .send(brandPayload);

      expect(res.status).toBe(200);
      expect(res.body.data.brandName).toBe(brandPayload.brandName);
      expect(res.body.data.primaryColor).toBe(brandPayload.primaryColor);
      expect(res.body.data.supportEmail).toBe(brandPayload.supportEmail);

      // Verify database row
      const [row] = await h.admin
        .select({ brandConfig: schema.organizations.brandConfig })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgActive.orgId));
      expect(row?.brandConfig).toMatchObject(brandPayload);

      // Verify audit log
      const [audit] = await h.admin
        .select()
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.action, AUDIT_ACTIONS.BRANDING_UPDATED),
            eq(schema.auditLogs.scopeId, orgActive.orgId),
          ),
        );
      expect(audit).toBeDefined();
      expect(audit.outcome).toBe('success');
    });

    it('refuses updating branding on a suspended organization with 403 TENANCY_ORGANIZATION_SUSPENDED', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgSuspended.orgId}/branding`))
        .set('authorization', `Bearer ${token.adminSuspended}`)
        .send({ brandName: 'Illegal Suspended Update' });

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED);
    });

    it('refuses updating branding on a closed organization with 403 TENANCY_ORGANIZATION_CLOSED', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgClosed.orgId}/branding`))
        .set('authorization', `Bearer ${token.adminClosed}`)
        .send({ brandName: 'Illegal Closed Update' });

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_CLOSED);
    });
  });

  // ---------------------------------------------------------------------------
  // Reseller Administrator Behavior
  // ---------------------------------------------------------------------------
  describe('Reseller administrator behavior', () => {
    it('updates branding successfully on an active child organization (200 OK)', async () => {
      const brandPayload = {
        brandName: 'Branded by Reseller Admin',
        accentColor: '#10b981',
      };
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgActive.orgId}/branding`))
        .set('authorization', `Bearer ${token.resellerAdminOwn}`)
        .send(brandPayload);

      expect(res.status).toBe(200);
      expect(res.body.data.brandName).toBe(brandPayload.brandName);
      expect(res.body.data.accentColor).toBe(brandPayload.accentColor);
    });

    it('refuses updating branding on a suspended child organization with 403 TENANCY_ORGANIZATION_SUSPENDED', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgSuspended.orgId}/branding`))
        .set('authorization', `Bearer ${token.resellerAdminOwn}`)
        .send({ brandName: 'Reseller Illegal Suspended' });

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED);
    });

    it('refuses updating branding on a closed child organization with 403 TENANCY_ORGANIZATION_CLOSED', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgClosed.orgId}/branding`))
        .set('authorization', `Bearer ${token.resellerAdminOwn}`)
        .send({ brandName: 'Reseller Illegal Closed' });

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_CLOSED);
    });

    it('refuses updating branding on an organization under another reseller with 404 RESOURCE_NOT_FOUND', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgActive.orgId}/branding`))
        .set('authorization', `Bearer ${token.resellerAdminOther}`)
        .send({ brandName: 'Cross Reseller Attempt' });

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });
  });

  // ---------------------------------------------------------------------------
  // Platform Support Behavior
  // ---------------------------------------------------------------------------
  describe('Platform support behavior', () => {
    it('allows reading organization branding (200 OK)', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/organizations/${orgActive.orgId}/branding`))
        .set('authorization', `Bearer ${token.support}`);

      expect(res.status).toBe(200);
      expect(res.body.data.brandName).toBeDefined();
    });

    it('refuses updating branding with 403 AUTHZ_SCOPE_DENIED (support is read-only)', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgActive.orgId}/branding`))
        .set('authorization', `Bearer ${token.support}`)
        .send({ brandName: 'Support Tampering' });

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });
  });

  // ---------------------------------------------------------------------------
  // Super Administrator Behavior & Conflict Handling
  // ---------------------------------------------------------------------------
  describe('Super administrator behavior', () => {
    it('updates branding successfully on an active organization (200 OK)', async () => {
      const brandPayload = { brandName: 'Branded by Super Admin' };
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgActive.orgId}/branding`))
        .set('authorization', `Bearer ${token.superAdmin}`)
        .send(brandPayload);

      expect(res.status).toBe(200);
      expect(res.body.data.brandName).toBe(brandPayload.brandName);
    });

    it('refuses updating branding on a suspended organization with 409 ORGANIZATION_LIFECYCLE_CONFLICT', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgSuspended.orgId}/branding`))
        .set('authorization', `Bearer ${token.superAdmin}`)
        .send({ brandName: 'Super Admin on Suspended' });

      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe(ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT);
      expect(res.body.error?.details).toEqual({ status: 'suspended' });
    });

    it('refuses updating branding on a closed organization with 409 ORGANIZATION_LIFECYCLE_CONFLICT', async () => {
      const res = await request(h.app.getHttpServer())
        .patch(url(`/organizations/${orgClosed.orgId}/branding`))
        .set('authorization', `Bearer ${token.superAdmin}`)
        .send({ brandName: 'Super Admin on Closed' });

      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe(ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT);
      expect(res.body.error?.details).toEqual({ status: 'closed' });
    });
  });

  // ---------------------------------------------------------------------------
  // Database Direct Column Privilege Checks
  // ---------------------------------------------------------------------------
  describe('Database direct column privilege assertions', () => {
    let appPool: Pool;
    let authPool: Pool;
    let relayPool: Pool;

    beforeAll(() => {
      appPool = new Pool({
        connectionString: process.env.DATABASE_URL!, // acc_app
        max: 1,
      });
      authPool = new Pool({
        connectionString: process.env.DATABASE_AUTH_URL!, // acc_auth
        max: 1,
      });
      relayPool = new Pool({
        connectionString: process.env.DATABASE_RELAY_URL!, // acc_relay
        max: 1,
      });
    });

    afterAll(async () => {
      await appPool.end();
      await authPool.end();
      await relayPool.end();
    });

    it('acc_app can UPDATE brand_config on an active organization in its RLS scope', async () => {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.current_user_id', $2, true)`,
          [orgActive.orgId, adminActive.userId],
        );
        const result = await client.query(
          `UPDATE organizations SET brand_config = '{"brandName": "Direct SQL by acc_app"}'::jsonb WHERE id = $1`,
          [orgActive.orgId],
        );
        expect(result.rowCount).toBe(1);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('acc_app CANNOT UPDATE ungranted columns like slug (SQLSTATE 42501)', async () => {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.current_user_id', $2, true)`,
          [orgActive.orgId, adminActive.userId],
        );
        await expect(
          client.query(`UPDATE organizations SET slug = 'new-slug' WHERE id = $1`, [
            orgActive.orgId,
          ]),
        ).rejects.toMatchObject({
          code: '42501', // insufficient_privilege
        });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('acc_app CANNOT UPDATE ungranted columns like id (SQLSTATE 42501)', async () => {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.current_user_id', $2, true)`,
          [orgActive.orgId, adminActive.userId],
        );
        await expect(
          client.query(`UPDATE organizations SET id = $1 WHERE id = $1`, [uuidv7()]),
        ).rejects.toMatchObject({
          code: '42501', // insufficient_privilege
        });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('acc_app CANNOT UPDATE a closed organization (organizations_closed_terminal trigger)', async () => {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.current_user_id', $2, true),
                  set_config('app.is_platform_admin', 'true', true)`,
          [orgClosed.orgId, superAdmin.userId],
        );
        await expect(
          client.query(
            `UPDATE organizations SET brand_config = '{"brandName": "Cannot update closed"}'::jsonb WHERE id = $1`,
            [orgClosed.orgId],
          ),
        ).rejects.toMatchObject({
          code: '42501',
          constraint: 'organizations_closed_terminal',
        });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('acc_auth CANNOT UPDATE brand_config (SQLSTATE 42501)', async () => {
      const client = await authPool.connect();
      try {
        await expect(
          client.query(
            `UPDATE organizations SET brand_config = '{"brandName": "acc_auth hijack"}'::jsonb WHERE id = $1`,
            [orgActive.orgId],
          ),
        ).rejects.toMatchObject({
          code: '42501', // insufficient_privilege
        });
      } finally {
        client.release();
      }
    });

    it('acc_relay CANNOT UPDATE brand_config (SQLSTATE 42501)', async () => {
      const client = await relayPool.connect();
      try {
        await expect(
          client.query(
            `UPDATE organizations SET brand_config = '{"brandName": "acc_relay hijack"}'::jsonb WHERE id = $1`,
            [orgActive.orgId],
          ),
        ).rejects.toMatchObject({
          code: '42501', // insufficient_privilege
        });
      } finally {
        client.release();
      }
    });
  });
});
