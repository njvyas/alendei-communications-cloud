import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { CredentialService } from '../src/iam/credential.service';

const url = (p: string) => `/${PREFIX}${p}`;

describe('Phase 8A-2: Contact Import & Export Security Suite (RBAC, Tenancy, Privacy)', () => {
  let h: Harness;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenAdminA: string;
  let tokenReadOnlyA: string;
  let tokenManageOnlyA: string;
  let tokenImportOnlyA: string;
  let tokenExportOnlyA: string;
  let _tokenAdminB: string;

  const login = async (email: string) => {
    await h.clearRateLimits();
    return (
      await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken as string;
  };

  const createRole = async (tenant: TenantFixture, keySuffix: string, permissions: string[]) => {
    const roleId = uuidv7();
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: tenant.orgId,
      key: `custom_${keySuffix}_${tenant.slug.replace(/-/g, '_')}`,
      name: `Custom ${keySuffix} ${tenant.slug}`,
      description: 'Custom test role',
      isSystemRole: false,
      allowedScopeTypes: ['organization', 'workspace'],
    });

    for (const permKey of permissions) {
      const [perm] = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, permKey));
      if (perm) {
        await h.admin.insert(schema.rolePermissions).values({
          roleId,
          permissionId: perm.id,
        });
      }
    }
    return roleId;
  };

  const createUserWithRole = async (tenant: TenantFixture, roleId: string, email: string) => {
    const credentials = h.app.get(CredentialService);
    const userId = uuidv7();
    const hash = await credentials.hash(PASSWORD);
    await h.admin.insert(schema.users).values({
      id: userId,
      orgId: tenant.orgId,
      email,
      passwordHash: hash,
      status: 'active',
    });
    await h.admin.insert(schema.userRoles).values({
      orgId: tenant.orgId,
      userId,
      roleId,
      scopeType: 'organization',
      scopeId: tenant.orgId,
    });
    return login(email);
  };

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    tenantA = await createTenant(h.admin, 'sec-a', credentials);
    tenantB = await createTenant(h.admin, 'sec-b', credentials);

    tokenAdminA = await login(tenantA.email);
    _tokenAdminB = await login(tenantB.email);

    // Create role with ONLY contacts.read
    const readOnlyRoleId = await createRole(tenantA, 'read_only', [PERMISSIONS.CONTACTS_READ]);
    tokenReadOnlyA = await createUserWithRole(
      tenantA,
      readOnlyRoleId,
      `readonly-${tenantA.slug}@example.com`,
    );

    // Create role with ONLY contacts.manage (no contacts.import or contacts.export)
    const manageOnlyRoleId = await createRole(tenantA, 'manage_only', [
      PERMISSIONS.CONTACTS_READ,
      PERMISSIONS.CONTACTS_MANAGE,
    ]);
    tokenManageOnlyA = await createUserWithRole(
      tenantA,
      manageOnlyRoleId,
      `manage-${tenantA.slug}@example.com`,
    );

    // Create role with ONLY contacts.import
    const importOnlyRoleId = await createRole(tenantA, 'import_only', [
      PERMISSIONS.CONTACTS_READ,
      PERMISSIONS.CONTACTS_IMPORT,
    ]);
    tokenImportOnlyA = await createUserWithRole(
      tenantA,
      importOnlyRoleId,
      `import-${tenantA.slug}@example.com`,
    );

    // Create role with ONLY contacts.export
    const exportOnlyRoleId = await createRole(tenantA, 'export_only', [
      PERMISSIONS.CONTACTS_READ,
      PERMISSIONS.CONTACTS_EXPORT,
    ]);
    tokenExportOnlyA = await createUserWithRole(
      tenantA,
      exportOnlyRoleId,
      `export-${tenantA.slug}@example.com`,
    );
  });

  afterAll(async () => {
    if (tenantA) await destroyTenant(h.admin, tenantA);
    if (tenantB) await destroyTenant(h.admin, tenantB);
    await h.close();
  });

  describe('1. RBAC Isolation for Contact Export', () => {
    it('contacts.read alone cannot export contacts (POST & GET return 403 Forbidden)', async () => {
      // POST
      const postRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${tokenReadOnlyA}`)
        .send({ format: 'json' });
      expect(postRes.status).toBe(403);

      // GET
      const getRes = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${tokenReadOnlyA}`);
      expect(getRes.status).toBe(403);
    });

    it('contacts.manage alone cannot export contacts (POST & GET return 403 Forbidden)', async () => {
      // POST
      const postRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${tokenManageOnlyA}`)
        .send({ format: 'json' });
      expect(postRes.status).toBe(403);

      // GET
      const getRes = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${tokenManageOnlyA}`);
      expect(getRes.status).toBe(403);
    });

    it('contacts.export authorizes streaming contact export (POST & GET return 200 OK)', async () => {
      // POST
      const postRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${tokenExportOnlyA}`)
        .send({ format: 'json' });
      expect(postRes.status).toBe(200);
      expect(postRes.headers['transfer-encoding']).toBe('chunked');

      // GET
      const getRes = await request(h.app.getHttpServer())
        .get(url(`/workspaces/${tenantA.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${tokenExportOnlyA}`);
      expect(getRes.status).toBe(200);
      expect(getRes.headers['content-type']).toContain('text/csv');
    });
  });

  describe('2. RBAC Isolation for Contact Import', () => {
    it('contacts.read alone cannot import contacts (returns 403 Forbidden)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${tokenReadOnlyA}`)
        .send({ contacts: [{ phone: '+15551112222' }] });
      expect(res.status).toBe(403);
    });

    it('contacts.manage alone cannot import contacts (returns 403 Forbidden)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${tokenManageOnlyA}`)
        .send({ contacts: [{ phone: '+15551112222' }] });
      expect(res.status).toBe(403);
    });

    it('contacts.import authorizes importing contacts (returns 200 OK)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${tokenImportOnlyA}`)
        .send({
          contacts: [
            {
              firstName: 'Imported',
              lastName: 'User',
              phone: '+15551112222',
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.summary.created).toBe(1);
    });
  });

  describe('3. Model B Tenant & Workspace Boundary', () => {
    it('Tenant A caller cannot import into Tenant B workspace (returns 404)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantB.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${tokenAdminA}`)
        .send({ contacts: [{ phone: '+15553334444' }] });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('Tenant A caller cannot export from Tenant B workspace (returns 404)', async () => {
      const res = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantB.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${tokenAdminA}`)
        .send({ format: 'json' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });
  });

  describe('4. Zero-PII Audit Integrity', () => {
    it('audit logs for contact.imported and contact.exported contain zero customer PII', async () => {
      // 1. Perform import
      const secretPhone = '+15559998888';
      const secretEmail = 'secret.executive@private-corp.com';
      const secretName = 'Sensitive Person';

      const importRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/import`))
        .set('authorization', `Bearer ${tokenImportOnlyA}`)
        .send({
          contacts: [
            {
              firstName: secretName,
              phone: secretPhone,
              email: secretEmail,
            },
          ],
        });
      expect(importRes.status).toBe(200);

      // 2. Perform export
      const exportRes = await request(h.app.getHttpServer())
        .post(url(`/workspaces/${tenantA.workspaceId}/contacts/export`))
        .set('authorization', `Bearer ${tokenExportOnlyA}`)
        .send({ format: 'json' });
      expect(exportRes.status).toBe(200);

      // 3. Inspect audit_logs in DB
      const logs = await h.admin
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.scopeId, tenantA.workspaceId))
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(10);

      const importLog = logs.find((l) => l.action === 'contact.imported');
      const exportLog = logs.find((l) => l.action === 'contact.exported');

      expect(importLog).toBeDefined();
      expect(exportLog).toBeDefined();

      const importMeta = JSON.stringify(importLog!.metadata ?? {});
      const exportMeta = JSON.stringify(exportLog!.metadata ?? {});

      // Assert zero PII in audit metadata
      expect(importMeta).not.toContain(secretPhone);
      expect(importMeta).not.toContain(secretEmail);
      expect(importMeta).not.toContain(secretName);

      expect(exportMeta).not.toContain(secretPhone);
      expect(exportMeta).not.toContain(secretEmail);
      expect(exportMeta).not.toContain(secretName);

      // Assert presence of privacy-safe summary metrics
      expect(importLog!.metadata).toMatchObject({
        totalCount: 1,
        processedCount: 1,
        created: 1,
      });

      expect(exportLog!.metadata).toMatchObject({
        format: 'json',
        ceiling: 50000,
      });
    });
  });
});
