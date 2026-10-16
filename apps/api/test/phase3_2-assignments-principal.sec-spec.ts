/**
 * Phase 3.2 Security Specification Suite (ADR-014 §4, §9.2, §17.1, P3-D01 to P3-D06)
 *
 * Covers:
 * 1. Platform assignment lifecycle (create, list, get, patch priority, disable, enable)
 *    and exact audit trail emission.
 * 2. Uniqueness, priority collision and non-existence failure semantics.
 * 3. Scope & RBAC hierarchy: PLATFORM -> RESELLER -> ORGANIZATION -> WORKSPACE -> TEAM.
 *    Platform administrative only; tenant/reseller/workspace/team/api-key callers receive 403.
 * 4. Anti-enumeration: denies before disclosing existence to unauthorized callers.
 * 5. Dedicated `acc_dispatch` database principal isolation proofs:
 *    - Model A RLS on organization_provider_assignments (active assignments only for current org)
 *    - Restricted provider visibility (assigned providers only)
 *    - Provider observation state update permission (administrative updates denied)
 *    - Channels static read and organizations status read
 *    - Strict table-level denial on content (Model B) and identity tables
 *    - Denial of INSERT/UPDATE/DELETE on assignments and DELETE/TRUNCATE everywhere.
 * 6. Tenancy Record (Model A) RLS and least-privilege SQL grants for `acc_app`.
 */
import { randomBytes } from 'node:crypto';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  PLATFORM_ROLE_KEYS,
  type RoleScopeType,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { CredentialService } from '../src/iam/credential.service';

const url = (p: string) => `/${PREFIX}${p}`;

describe('Phase 3.2 Assignments & Principal Scopes Security Suite', () => {
  let h: Harness;
  let credentials: CredentialService;
  let appPool: Pool;
  let adminPool: Pool;

  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let channelSmsId: string;
  let channelEmailId: string;

  let providerSms1: { id: string; name: string; channelId: string };
  let providerSms2: { id: string; name: string; channelId: string };
  let providerEmail1: { id: string; name: string; channelId: string };

  const createdUsers: string[] = [];
  const createdRoles: string[] = [];

  const tokens: {
    platform?: string;
    platformReader?: string;
    reseller?: string;
    orgAdmin?: string;
    workspaceUser?: string;
    teamUser?: string;
  } = {};

  let apiKeyHeader: string;
  let platformUserId: string;

  async function createUser(label: string): Promise<{ userId: string; email: string }> {
    const email = `p32-${label}-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
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

  async function createTestRole(
    name: string,
    scopeTypes: RoleScopeType[],
    permissions: string[],
    orgId: string | null = null,
  ): Promise<string> {
    const roleId = uuidv7();
    const sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId,
      key: `p32_${sanitized}_${randomBytes(4).toString('hex')}`,
      name,
      description: 'Phase 3.2 test role',
      isSystemRole: false,
      allowedScopeTypes: scopeTypes,
    });
    createdRoles.push(roleId);

    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(inArray(schema.permissions.key, permissions));

    for (const p of perms) {
      await h.admin.insert(schema.rolePermissions).values({ roleId, permissionId: p.id });
    }
    return roleId;
  }

  async function grant(
    userId: string,
    roleId: string,
    scopeType: RoleScopeType,
    scopeId: string | null,
    orgId: string | null = null,
  ): Promise<void> {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId,
        roleId,
        scopeType,
        scopeId,
        orgId,
      });
    });
  }

  async function login(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    token: string | null,
    path: string,
  ) => {
    let r = request(h.app.getHttpServer())[method](url(path));
    if (token) r = r.set('authorization', `Bearer ${token}`);
    return r;
  };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);

    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });

    tenantA = await createTenant(h.admin, 'p32-tenant-a', credentials);
    tenantB = await createTenant(h.admin, 'p32-tenant-b', credentials);

    // Channels
    const channels = await h.admin.select().from(schema.channels);
    const sms = channels.find((c) => c.code === 'sms');
    const email = channels.find((c) => c.code === 'email');
    if (!sms || !email) throw new Error('Expected sms and email channels to exist');
    channelSmsId = sms.id;
    channelEmailId = email.id;

    // Platform super admin
    const platformUser = await createUser('platform-admin');
    platformUserId = platformUser.userId;
    const [superAdminRole] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN));
    await grant(platformUser.userId, superAdminRole!.id, 'platform', null);
    tokens.platform = await login(platformUser.email);

    // Platform reader (providers.read only)
    const readerUser = await createUser('platform-reader');
    const readerRole = await createTestRole(
      'Platform Reader',
      ['platform'],
      [PERMISSIONS.PROVIDERS_READ],
    );
    await grant(readerUser.userId, readerRole, 'platform', null);
    tokens.platformReader = await login(readerUser.email);

    // Reseller admin
    const resellerUser = await createUser('reseller-admin');
    const [resellerRole] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.RESELLER_ADMIN));
    await grant(resellerUser.userId, resellerRole!.id, 'reseller', tenantA.resellerId);
    tokens.reseller = await login(resellerUser.email);

    // Org admin
    tokens.orgAdmin = await login(tenantA.email);

    // Workspace user
    const wsUser = await createScopedUser(
      h.admin,
      tenantA,
      credentials,
      'workspace',
      tenantA.workspaceId,
      'ws-user',
    );
    tokens.workspaceUser = await login(wsUser.email);
    createdUsers.push(wsUser.userId);

    // Team user
    const tmUser = await createScopedUser(
      h.admin,
      tenantA,
      credentials,
      'team',
      tenantA.teamId,
      'tm-user',
    );
    tokens.teamUser = await login(tmUser.email);
    createdUsers.push(tmUser.userId);

    // API Key (org-scoped, granted providers.manage)
    const keyPrefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const keySecret = `s_${randomBytes(16).toString('hex')}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: tenantA.orgId,
      name: 'p32-test-key',
      keyPrefix,
      keyHash: await credentials.hash(keySecret),
      scopes: [PERMISSIONS.PROVIDERS_MANAGE, PERMISSIONS.PROVIDERS_READ],
      createdBy: platformUser.userId,
    });
    apiKeyHeader = `${keyPrefix}.${keySecret}`;

    // Create Catalogue Providers for testing
    const [p1] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelSmsId,
        name: `p32-sms-prov1-${uuidv7().slice(-6)}`,
        adapterKey: 'simulator',
        status: 'active',
      })
      .returning();
    providerSms1 = p1!;

    const [p2] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelSmsId,
        name: `p32-sms-prov2-${uuidv7().slice(-6)}`,
        adapterKey: 'simulator',
        status: 'active',
      })
      .returning();
    providerSms2 = p2!;

    const [pe1] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channelEmailId,
        name: `p32-email-prov1-${uuidv7().slice(-6)}`,
        adapterKey: 'simulator',
        status: 'active',
      })
      .returning();
    providerEmail1 = pe1!;
  }, 120_000);

  afterAll(async () => {
    try {
      await h.clearRateLimits();
      // Remove assignments
      await h.admin.execute(sql`DELETE FROM message_attempts`).catch(() => {});
      await h.admin.execute(sql`DELETE FROM organization_provider_assignments`);

      // Remove created providers
      const pIds = [providerSms1?.id, providerSms2?.id, providerEmail1?.id].filter(Boolean);
      if (pIds.length > 0) {
        await h.admin.delete(schema.providers).where(inArray(schema.providers.id, pIds));
      }

      // Cleanup test users and roles
      const list = (values: string[]) =>
        sql.join(
          values.map((v) => sql`${v}`),
          sql`, `,
        );
      if (createdUsers.length > 0) {
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
            if (createdRoles.length > 0) {
              await tx.execute(
                sql`DELETE FROM role_permissions WHERE role_id IN (${list(createdRoles)})`,
              );
              await tx.execute(sql`DELETE FROM roles WHERE id IN (${list(createdRoles)})`);
            }
          } finally {
            await tx.execute(
              sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_reseller_admin_liveness`,
            );
            await tx.execute(
              sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
            );
          }
        });
        await purgeAudit(
          h.admin,
          sql`actor_user_id IN (${list(createdUsers)}) OR actor_api_key_id IS NOT NULL OR resource_type = 'organization_provider_assignments'`,
        );
        await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
        await h.admin.execute(sql`DELETE FROM users WHERE id IN (${list(createdUsers)})`);
      }

      await destroyTenant(h.admin, tenantA);
      await destroyTenant(h.admin, tenantB);
    } finally {
      await appPool.end();
      await adminPool.end();
      await h.close();
    }
  }, 120_000);

  describe('1. Platform Assignment Lifecycle & Audit Trail', () => {
    let createdAssignmentId: string;

    it('creates an assignment at platform scope and records audit log', async () => {
      const res = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      )
        .send({
          providerId: providerSms1.id,
          priority: 10,
          status: 'active',
        })
        .expect(201);

      const data = res.body.data;
      expect(data.orgId).toBe(tenantA.orgId);
      expect(data.providerId).toBe(providerSms1.id);
      expect(data.channelId).toBe(channelSmsId);
      expect(data.priority).toBe(10);
      expect(data.status).toBe('active');
      expect(data.id).toBeDefined();
      createdAssignmentId = data.id;

      // Verify audit trail row
      const [audit] = (
        await h.admin.execute<Record<string, unknown>>(
          sql`SELECT action, resource_id, org_id, actor_label FROM audit_logs WHERE resource_id = ${createdAssignmentId} AND action = ${AUDIT_ACTIONS.ORGANIZATION_PROVIDER_ASSIGNED}`,
        )
      ).rows;
      expect(audit).toBeDefined();
      expect(audit!.resource_id).toBe(createdAssignmentId);
      expect(audit!.org_id).toBeNull(); // Platform scope audit
    });

    it('lists assignments with optional channel and status filters', async () => {
      // List all for tenantA
      const res1 = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      ).expect(200);
      expect(res1.body.data).toHaveLength(1);
      expect(res1.body.data[0].id).toBe(createdAssignmentId);

      // Filter by channel match
      const res2 = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments?channelId=${channelSmsId}`,
      ).expect(200);
      expect(res2.body.data).toHaveLength(1);

      // Filter by channel mismatch
      const res3 = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments?channelId=${channelEmailId}`,
      ).expect(200);
      expect(res3.body.data).toHaveLength(0);

      // Filter by status active
      const res4 = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments?status=active`,
      ).expect(200);
      expect(res4.body.data).toHaveLength(1);

      // Filter by status disabled
      const res5 = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments?status=disabled`,
      ).expect(200);
      expect(res5.body.data).toHaveLength(0);
    });

    it('gets a single assignment by id', async () => {
      const res = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments/${createdAssignmentId}`,
      ).expect(200);
      expect(res.body.data.id).toBe(createdAssignmentId);
      expect(res.body.data.priority).toBe(10);
    });

    it('updates assignment priority and records audit log', async () => {
      const res = await call(
        'patch',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments/${createdAssignmentId}`,
      )
        .send({ priority: 25 })
        .expect(200);

      expect(res.body.data.priority).toBe(25);

      const [audit] = (
        await h.admin.execute<Record<string, unknown>>(
          sql`SELECT action, resource_id FROM audit_logs WHERE resource_id = ${createdAssignmentId} AND action = ${AUDIT_ACTIONS.ORGANIZATION_PROVIDER_UPDATED}`,
        )
      ).rows;
      expect(audit).toBeDefined();
    });

    it('disables an assignment and records audit log', async () => {
      const res = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments/${createdAssignmentId}/disable`,
      ).expect(200);

      expect(res.body.data.status).toBe('disabled');

      const [audit] = (
        await h.admin.execute<Record<string, unknown>>(
          sql`SELECT action, resource_id FROM audit_logs WHERE resource_id = ${createdAssignmentId} AND action = ${AUDIT_ACTIONS.ORGANIZATION_PROVIDER_DISABLED}`,
        )
      ).rows;
      expect(audit).toBeDefined();
    });

    it('enables an assignment and records audit log', async () => {
      const res = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments/${createdAssignmentId}/enable`,
      ).expect(200);

      expect(res.body.data.status).toBe('active');

      const [audit] = (
        await h.admin.execute<Record<string, unknown>>(
          sql`SELECT action, resource_id FROM audit_logs WHERE resource_id = ${createdAssignmentId} AND action = ${AUDIT_ACTIONS.ORGANIZATION_PROVIDER_ENABLED}`,
        )
      ).rows;
      expect(audit).toBeDefined();
    });
  });

  describe('2. Uniqueness, Priority Collision and Non-Existence Failures', () => {
    it('refuses duplicate provider assignment for the same organization (409 PROVIDER_ASSIGNMENT_CONFLICT)', async () => {
      const res = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      )
        .send({
          providerId: providerSms1.id,
          priority: 50,
        })
        .expect(409);

      expect(res.body.error.code).toBe(ERROR_CODES.PROVIDER_ASSIGNMENT_CONFLICT);
    });

    it('refuses duplicate priority for the same organization and channel (409 ASSIGNMENT_PRIORITY_CONFLICT)', async () => {
      const res = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      )
        .send({
          providerId: providerSms2.id,
          priority: 25, // already used by providerSms1
        })
        .expect(409);

      expect(res.body.error.code).toBe(ERROR_CODES.ASSIGNMENT_PRIORITY_CONFLICT);
    });

    it('refuses priority update that collides with another assignment in same org/channel', async () => {
      // 1. Create providerSms2 with priority 30
      const res1 = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      )
        .send({
          providerId: providerSms2.id,
          priority: 30,
        })
        .expect(201);
      const assignment2Id = res1.body.data.id;

      // 2. Try to update providerSms2 priority to 25 (which is held by providerSms1)
      const res2 = await call(
        'patch',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments/${assignment2Id}`,
      )
        .send({ priority: 25 })
        .expect(409);

      expect(res2.body.error.code).toBe(ERROR_CODES.ASSIGNMENT_PRIORITY_CONFLICT);
    });

    it('allows same priority across different channels within the same organization', async () => {
      // providerEmail1 has channel email, priority 25 should succeed despite sms having priority 25
      const res = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      )
        .send({
          providerId: providerEmail1.id,
          priority: 25,
        })
        .expect(201);

      expect(res.body.data.channelId).toBe(channelEmailId);
      expect(res.body.data.priority).toBe(25);
    });

    it('allows same provider and priority in a different organization', async () => {
      // Assign providerSms1 with priority 25 to tenantB
      const res = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantB.orgId}/provider-assignments`,
      )
        .send({
          providerId: providerSms1.id,
          priority: 25,
        })
        .expect(201);

      expect(res.body.data.orgId).toBe(tenantB.orgId);
    });

    it('returns 404 RESOURCE_NOT_FOUND when organization does not exist on create', async () => {
      const nonExistentOrg = uuidv7();
      const res = await call(
        'post',
        tokens.platform!,
        `/organizations/${nonExistentOrg}/provider-assignments`,
      )
        .send({
          providerId: providerSms2.id,
          priority: 99,
        })
        .expect(404);

      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('returns 404 RESOURCE_NOT_FOUND when provider does not exist on create', async () => {
      const nonExistentProvider = uuidv7();
      const res = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      )
        .send({
          providerId: nonExistentProvider,
          priority: 99,
        })
        .expect(404);

      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('returns 404 PROVIDER_ASSIGNMENT_NOT_FOUND when assignment does not exist on get/update/transition', async () => {
      const nonExistentAssignment = uuidv7();
      const resGet = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments/${nonExistentAssignment}`,
      ).expect(404);
      expect(resGet.body.error.code).toBe(ERROR_CODES.PROVIDER_ASSIGNMENT_NOT_FOUND);

      const resPatch = await call(
        'patch',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments/${nonExistentAssignment}`,
      )
        .send({ priority: 1 })
        .expect(404);
      expect(resPatch.body.error.code).toBe(ERROR_CODES.PROVIDER_ASSIGNMENT_NOT_FOUND);

      const resDisable = await call(
        'post',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments/${nonExistentAssignment}/disable`,
      ).expect(404);
      expect(resDisable.body.error.code).toBe(ERROR_CODES.PROVIDER_ASSIGNMENT_NOT_FOUND);
    });

    it('returns 404 when querying an assignment belonging to tenantA using tenantB URL path', async () => {
      // Find tenantA assignment
      const listA = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      ).expect(200);
      const assignmentAId = listA.body.data[0].id;

      // Access under tenantB orgId
      const res = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantB.orgId}/provider-assignments/${assignmentAId}`,
      ).expect(404);
      expect(res.body.error.code).toBe(ERROR_CODES.PROVIDER_ASSIGNMENT_NOT_FOUND);
    });

    it('refuses negative or zero priority (400 validation error)', async () => {
      await call('post', tokens.platform!, `/organizations/${tenantA.orgId}/provider-assignments`)
        .send({
          providerId: providerSms2.id,
          priority: 0,
        })
        .expect(400);

      await call('post', tokens.platform!, `/organizations/${tenantA.orgId}/provider-assignments`)
        .send({
          providerId: providerSms2.id,
          priority: -5,
        })
        .expect(400);
    });
  });

  describe('3. Scope Hierarchy & RBAC Enforcement (Platform Only)', () => {
    let testAssignmentId: string;

    beforeAll(async () => {
      const list = await call(
        'get',
        tokens.platform!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      ).expect(200);
      testAssignmentId = list.body.data[0].id;
    });

    it('permits platform reader with providers.read to list and get, but refuses write actions (403)', async () => {
      // GET list -> 200
      await call(
        'get',
        tokens.platformReader!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      )
        .set('x-acc-organization', tenantA.orgId)
        .expect(200);

      // GET detail -> 200
      await call(
        'get',
        tokens.platformReader!,
        `/organizations/${tenantA.orgId}/provider-assignments/${testAssignmentId}`,
      )
        .set('x-acc-organization', tenantA.orgId)
        .expect(200);

      // POST create -> 403
      await call(
        'post',
        tokens.platformReader!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      )
        .set('x-acc-organization', tenantA.orgId)
        .send({ providerId: providerSms2.id, priority: 99 })
        .expect(403);

      // PATCH update -> 403
      await call(
        'patch',
        tokens.platformReader!,
        `/organizations/${tenantA.orgId}/provider-assignments/${testAssignmentId}`,
      )
        .set('x-acc-organization', tenantA.orgId)
        .send({ priority: 99 })
        .expect(403);

      // POST disable -> 403
      await call(
        'post',
        tokens.platformReader!,
        `/organizations/${tenantA.orgId}/provider-assignments/${testAssignmentId}/disable`,
      )
        .set('x-acc-organization', tenantA.orgId)
        .expect(403);

      // POST enable -> 403
      await call(
        'post',
        tokens.platformReader!,
        `/organizations/${tenantA.orgId}/provider-assignments/${testAssignmentId}/enable`,
      )
        .set('x-acc-organization', tenantA.orgId)
        .expect(403);
    });

    it('refuses Organization Administrator (403 Forbidden)', async () => {
      await call(
        'get',
        tokens.orgAdmin!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      ).expect(403);
      await call('post', tokens.orgAdmin!, `/organizations/${tenantA.orgId}/provider-assignments`)
        .send({ providerId: providerSms2.id, priority: 99 })
        .expect(403);
    });

    it('refuses Reseller Administrator (403 Forbidden)', async () => {
      await call(
        'get',
        tokens.reseller!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      ).expect(403);
      await call('post', tokens.reseller!, `/organizations/${tenantA.orgId}/provider-assignments`)
        .send({ providerId: providerSms2.id, priority: 99 })
        .expect(403);
    });

    it('refuses Workspace-scoped user (403 Forbidden)', async () => {
      await call(
        'get',
        tokens.workspaceUser!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      ).expect(403);
      await call(
        'post',
        tokens.workspaceUser!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      )
        .send({ providerId: providerSms2.id, priority: 99 })
        .expect(403);
    });

    it('refuses Team-scoped user (403 Forbidden)', async () => {
      await call(
        'get',
        tokens.teamUser!,
        `/organizations/${tenantA.orgId}/provider-assignments`,
      ).expect(403);
      await call('post', tokens.teamUser!, `/organizations/${tenantA.orgId}/provider-assignments`)
        .send({ providerId: providerSms2.id, priority: 99 })
        .expect(403);
    });

    it('refuses API Key caller even with providers.manage scope (403 Forbidden)', async () => {
      let r = request(h.app.getHttpServer()).get(
        url(`/organizations/${tenantA.orgId}/provider-assignments`),
      );
      r = r.set('authorization', `Bearer ${apiKeyHeader}`);
      await r.expect(403);
    });

    it('refuses unauthenticated caller (401 Unauthorized)', async () => {
      await call('get', null, `/organizations/${tenantA.orgId}/provider-assignments`).expect(401);
    });
  });

  describe('4. Anti-Enumeration Boundary', () => {
    it('refuses unauthorized callers before testing organization existence (403 without existence leak)', async () => {
      const nonExistentOrg = uuidv7();
      // Tenant admin querying non-existent organization receives 403, NOT 404
      await call(
        'get',
        tokens.orgAdmin!,
        `/organizations/${nonExistentOrg}/provider-assignments`,
      ).expect(403);
      // Reseller admin querying non-existent organization receives 403, NOT 404
      await call(
        'get',
        tokens.reseller!,
        `/organizations/${nonExistentOrg}/provider-assignments`,
      ).expect(403);
    });

    it('platform admin accessing non-existent organization receives clean 404 without internal trace', async () => {
      const nonExistentOrg = uuidv7();
      const res = await call(
        'get',
        tokens.platform!,
        `/organizations/${nonExistentOrg}/provider-assignments`,
      ).expect(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });
  });

  describe('5. acc_dispatch Database Principal Isolation Proofs', () => {
    let client: PoolClient;

    beforeAll(async () => {
      client = await adminPool.connect();
    });

    afterAll(async () => {
      client.release();
    });

    const withDispatchContext = async <T>(
      orgId: string,
      messageId: string,
      claimToken: string,
      fn: () => Promise<T>,
    ): Promise<T> => {
      await client.query('BEGIN');
      try {
        await client.query('SET ROLE acc_dispatch');
        await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId]);
        await client.query('SELECT set_config($1, $2, true)', [
          'app.dispatch_message_id',
          messageId,
        ]);
        await client.query('SELECT set_config($1, $2, true)', [
          'app.dispatch_claim_token',
          claimToken,
        ]);
        const res = await fn();
        await client.query('ROLLBACK');
        return res;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    };

    it('sees only active assignments for app.current_org_id; disabled and other org rows are invisible', async () => {
      const messageId = uuidv7();
      const claimToken = uuidv7();

      // Ensure providerSms1 is active and providerSms2 is disabled in tenantA
      await h.admin
        .update(schema.organizationProviderAssignments)
        .set({ status: 'active' })
        .where(
          and(
            eq(schema.organizationProviderAssignments.orgId, tenantA.orgId),
            eq(schema.organizationProviderAssignments.providerId, providerSms1.id),
          ),
        );
      await h.admin
        .update(schema.organizationProviderAssignments)
        .set({ status: 'disabled' })
        .where(
          and(
            eq(schema.organizationProviderAssignments.orgId, tenantA.orgId),
            eq(schema.organizationProviderAssignments.providerId, providerSms2.id),
          ),
        );

      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        const rows = await client.query(
          'SELECT id, provider_id, status FROM organization_provider_assignments',
        );
        // Only active assignment for tenantA should be visible
        expect(rows.rows.length).toBeGreaterThanOrEqual(1);
        for (const row of rows.rows) {
          expect(row.status).toBe('active');
          expect(row.provider_id).not.toBe(providerSms2.id); // providerSms2 is disabled
        }

        // Cross-tenant: tenantB rows are invisible
        const tenantBCheck = await client.query(
          'SELECT id FROM organization_provider_assignments WHERE org_id = $1',
          [tenantB.orgId],
        );
        expect(tenantBCheck.rows).toHaveLength(0);
      });
    });

    it('sees only assigned providers in the providers table for the current organization', async () => {
      const messageId = uuidv7();
      const claimToken = uuidv7();

      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        const provs = await client.query('SELECT id, name FROM providers');
        const ids = provs.rows.map((r) => r.id);
        // providerSms1 is actively assigned to tenantA
        expect(ids).toContain(providerSms1.id);
        // providerSms2 is disabled for tenantA -> not visible
        expect(ids).not.toContain(providerSms2.id);
      });
    });

    it('can update observation columns on an assigned provider, but cannot update administrative columns', async () => {
      const messageId = uuidv7();
      const claimToken = uuidv7();

      // Observation columns update: succeeds
      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        const updateRes = await client.query(
          `UPDATE providers 
           SET health_state = 'healthy', health_changed_at = now()
           WHERE id = $1`,
          [providerSms1.id],
        );
        expect(updateRes.rowCount).toBe(1);
      });

      // Administrative column update: refused (no UPDATE grant on column "name")
      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        let caught: Error | null = null;
        try {
          await client.query(`UPDATE providers SET name = 'tampered' WHERE id = $1`, [
            providerSms1.id,
          ]);
        } catch (e) {
          caught = e as Error;
        }
        expect(caught).toBeDefined();
        expect(caught!.message).toMatch(/permission denied for/);
      });
    });

    it('can select static channels and organization status', async () => {
      const messageId = uuidv7();
      const claimToken = uuidv7();

      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        const channels = await client.query('SELECT id, code FROM channels');
        expect(channels.rows.length).toBeGreaterThan(0);

        const orgs = await client.query('SELECT id, status FROM organizations WHERE id = $1', [
          tenantA.orgId,
        ]);
        expect(orgs.rows).toHaveLength(1);
      });
    });

    it('strictly denies SELECT on Model B tenant content tables (permission denied)', async () => {
      const messageId = uuidv7();
      const claimToken = uuidv7();

      const forbiddenContentTables = [
        'contacts',
        'contact_identities',
        'consent_events',
        'templates',
        'suppressions',
      ];

      for (const tbl of forbiddenContentTables) {
        await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
          let err: Error | null = null;
          try {
            await client.query(`SELECT * FROM ${tbl} LIMIT 1`);
          } catch (e) {
            err = e as Error;
          }
          expect(err).toBeDefined();
          expect(err!.message).toMatch(/permission denied for table/);
        });
      }
    });

    it('strictly denies SELECT on IAM, authentication and credential tables (permission denied)', async () => {
      const messageId = uuidv7();
      const claimToken = uuidv7();

      const forbiddenIamTables = ['users', 'user_roles', 'api_keys', 'sessions', 'roles'];

      for (const tbl of forbiddenIamTables) {
        await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
          let err: Error | null = null;
          try {
            await client.query(`SELECT * FROM ${tbl} LIMIT 1`);
          } catch (e) {
            err = e as Error;
          }
          expect(err).toBeDefined();
          expect(err!.message).toMatch(/permission denied for table/);
        });
      }
    });

    it('strictly denies INSERT, UPDATE, DELETE on organization_provider_assignments (permission denied)', async () => {
      const messageId = uuidv7();
      const claimToken = uuidv7();

      // INSERT
      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        let errInsert: Error | null = null;
        try {
          await client.query(
            `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority)
             VALUES ($1, $2, $3, 100)`,
            [tenantA.orgId, providerSms1.id, channelSmsId],
          );
        } catch (e) {
          errInsert = e as Error;
        }
        expect(errInsert).toBeDefined();
        expect(errInsert!.message).toMatch(/permission denied for table/);
      });

      // UPDATE
      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        let errUpdate: Error | null = null;
        try {
          await client.query(
            `UPDATE organization_provider_assignments SET priority = 100 WHERE org_id = $1`,
            [tenantA.orgId],
          );
        } catch (e) {
          errUpdate = e as Error;
        }
        expect(errUpdate).toBeDefined();
        expect(errUpdate!.message).toMatch(/permission denied for table/);
      });

      // DELETE
      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        let errDelete: Error | null = null;
        try {
          await client.query(`DELETE FROM organization_provider_assignments WHERE org_id = $1`, [
            tenantA.orgId,
          ]);
        } catch (e) {
          errDelete = e as Error;
        }
        expect(errDelete).toBeDefined();
        expect(errDelete!.message).toMatch(/permission denied for table/);
      });
    });

    it('strictly denies DELETE and TRUNCATE everywhere (permission denied)', async () => {
      const messageId = uuidv7();
      const claimToken = uuidv7();

      // DELETE on providers
      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        let errProvDel: Error | null = null;
        try {
          await client.query(`DELETE FROM providers WHERE id = $1`, [providerSms1.id]);
        } catch (e) {
          errProvDel = e as Error;
        }
        expect(errProvDel).toBeDefined();
        expect(errProvDel!.message).toMatch(/permission denied for table/);
      });

      // TRUNCATE
      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        let errTrunc: Error | null = null;
        try {
          await client.query(`TRUNCATE providers`);
        } catch (e) {
          errTrunc = e as Error;
        }
        expect(errTrunc).toBeDefined();
        expect(errTrunc!.message).toMatch(/permission denied for table/);
      });
    });

    it('dispatch context functions app_dispatch_message_id and app_dispatch_claim_token enforce exact definitions, ACLs, and parameterless context extraction', async () => {
      // 1. Inspect pg_proc definition
      const { rows: procs } = await adminPool.query<{
        proname: string;
        owner: string;
        secdef: boolean;
        volatility: string;
        nargs: number;
        acl: string;
      }>(`
        SELECT 
          p.proname,
          pg_get_userbyid(p.proowner) AS owner,
          p.prosecdef AS secdef,
          p.provolatile AS volatility,
          p.pronargs AS nargs,
          p.proacl::text AS acl
        FROM pg_proc p 
        WHERE p.proname IN ('app_dispatch_message_id', 'app_dispatch_claim_token')
        ORDER BY p.proname
      `);

      expect(procs).toHaveLength(2);
      for (const p of procs) {
        expect(p.owner).toBe('postgres');
        expect(p.secdef).toBe(false); // Plain SQL / SECURITY INVOKER
        expect(p.volatility).toBe('s'); // STABLE
        expect(p.nargs).toBe(0); // Zero parameters: cannot accept injected IDs
        expect(p.acl).toBe('{postgres=X/postgres,acc_app=X/postgres,acc_dispatch=X/postgres}');
      }

      // 2. Behavioral extraction under dispatch context
      const messageId = uuidv7();
      const claimToken = uuidv7();
      await withDispatchContext(tenantA.orgId, messageId, claimToken, async () => {
        const res = await client.query(
          'SELECT app_dispatch_message_id() AS m_id, app_dispatch_claim_token() AS c_tok',
        );
        expect(res.rows[0].m_id).toBe(messageId);
        expect(res.rows[0].c_tok).toBe(claimToken);
      });

      // 3. Unset context returns NULL
      await withDispatchContext(tenantA.orgId, '', '', async () => {
        const res = await client.query(
          'SELECT app_dispatch_message_id() AS m_id, app_dispatch_claim_token() AS c_tok',
        );
        expect(res.rows[0].m_id).toBeNull();
        expect(res.rows[0].c_tok).toBeNull();
      });

      // 4. Unauthorized roles cannot execute
      for (const role of ['acc_auth', 'acc_relay']) {
        await client.query('BEGIN');
        try {
          await client.query(`SET ROLE ${role}`);
          let err: Error | null = null;
          try {
            await client.query('SELECT app_dispatch_message_id()');
          } catch (e) {
            err = e as Error;
          }
          expect(err).toBeDefined();
          expect(err!.message).toMatch(/permission denied for function/);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    });
  });

  describe('6. Tenancy Record (Model A) RLS and acc_app Least-Privilege Grants', () => {
    it('enforces Model A tenancy RLS: tenant context sees only its own org assignments, platform sees all', async () => {
      const appClient = await appPool.connect();
      try {
        // As tenantA
        await appClient.query('BEGIN');
        await appClient.query('SELECT set_config($1, $2, true)', [
          'app.current_org_id',
          tenantA.orgId,
        ]);
        await appClient.query('SELECT set_config($1, $2, true)', ['app.is_platform_admin', 'off']);
        const resA = await appClient.query('SELECT org_id FROM organization_provider_assignments');
        expect(resA.rows.length).toBeGreaterThan(0);
        for (const row of resA.rows) {
          expect(row.org_id).toBe(tenantA.orgId);
        }
        await appClient.query('ROLLBACK');

        // As tenantB
        await appClient.query('BEGIN');
        await appClient.query('SELECT set_config($1, $2, true)', [
          'app.current_org_id',
          tenantB.orgId,
        ]);
        await appClient.query('SELECT set_config($1, $2, true)', ['app.is_platform_admin', 'off']);
        const resB = await appClient.query('SELECT org_id FROM organization_provider_assignments');
        for (const row of resB.rows) {
          expect(row.org_id).toBe(tenantB.orgId);
        }
        await appClient.query('ROLLBACK');

        // As platform admin (requires app.current_user_id and app.is_platform_admin = 'on')
        await appClient.query('BEGIN');
        await appClient.query('SELECT set_config($1, $2, true)', [
          'app.current_user_id',
          platformUserId,
        ]);
        await appClient.query('SELECT set_config($1, $2, true)', ['app.is_platform_admin', 'on']);
        const resPlatform = await appClient.query(
          'SELECT org_id FROM organization_provider_assignments',
        );
        const orgIds = new Set(resPlatform.rows.map((r) => r.org_id));
        expect(orgIds.has(tenantA.orgId)).toBe(true);
        expect(orgIds.has(tenantB.orgId)).toBe(true);
        await appClient.query('ROLLBACK');
      } finally {
        appClient.release();
      }
    });

    it('acc_app holds zero DELETE and TRUNCATE grants on organization_provider_assignments', async () => {
      const appClient = await appPool.connect();
      try {
        // DELETE test
        await appClient.query('BEGIN');
        await appClient.query('SELECT set_config($1, $2, true)', [
          'app.current_user_id',
          platformUserId,
        ]);
        await appClient.query('SELECT set_config($1, $2, true)', ['app.is_platform_admin', 'on']);

        let errDel: Error | null = null;
        try {
          await appClient.query('DELETE FROM organization_provider_assignments');
        } catch (e) {
          errDel = e as Error;
        }
        expect(errDel).toBeDefined();
        expect(errDel!.message).toMatch(/permission denied for table/);
        await appClient.query('ROLLBACK');

        // TRUNCATE test
        await appClient.query('BEGIN');
        await appClient.query('SELECT set_config($1, $2, true)', [
          'app.current_user_id',
          platformUserId,
        ]);
        await appClient.query('SELECT set_config($1, $2, true)', ['app.is_platform_admin', 'on']);

        let errTrunc: Error | null = null;
        try {
          await appClient.query('TRUNCATE organization_provider_assignments');
        } catch (e) {
          errTrunc = e as Error;
        }
        expect(errTrunc).toBeDefined();
        expect(errTrunc!.message).toMatch(/permission denied for table/);
        await appClient.query('ROLLBACK');
      } finally {
        appClient.release();
      }
    });

    it('enforces parent-child channel integrity and tenant-key immutability at database level', async () => {
      // 1. Composite FK violation: provider belongs to SMS, cannot be assigned to Email channel
      const [mismatchProv] = await h.admin
        .insert(schema.providers)
        .values({
          channelId: channelSmsId,
          name: `p32-fk-prov-${uuidv7().slice(-6)}`,
          adapterKey: 'simulator',
          status: 'active',
        })
        .returning();

      let fkErr: unknown = null;
      try {
        await h.admin.insert(schema.organizationProviderAssignments).values({
          orgId: tenantA.orgId,
          providerId: mismatchProv!.id,
          channelId: channelEmailId, // Mismatched channel
          priority: 99,
        });
      } catch (e) {
        fkErr = e;
      }
      expect(fkErr).toBeDefined();
      const fkCause = ((fkErr as { cause?: unknown }).cause ?? fkErr) as {
        code?: string;
        constraint?: string;
        message?: string;
      };
      expect([fkCause.code, fkCause.constraint]).toEqual([
        '23503',
        'organization_provider_assignments_provider_channel_fk',
      ]);

      // 2. Immutability trigger: org_id, provider_id, channel_id cannot be mutated
      const [assignment] = await h.admin
        .select()
        .from(schema.organizationProviderAssignments)
        .where(
          and(
            eq(schema.organizationProviderAssignments.orgId, tenantA.orgId),
            eq(schema.organizationProviderAssignments.providerId, providerSms1.id),
          ),
        );
      expect(assignment).toBeDefined();

      const tempTenant = await createTenant(h.admin, 'p32-temp-immut', credentials);
      try {
        let immutOrgErr: unknown = null;
        try {
          await h.admin
            .update(schema.organizationProviderAssignments)
            .set({ orgId: tempTenant.orgId })
            .where(eq(schema.organizationProviderAssignments.id, assignment!.id));
        } catch (e) {
          immutOrgErr = e;
        }
        expect(immutOrgErr).toBeDefined();
        const orgCause = ((immutOrgErr as { cause?: unknown }).cause ?? immutOrgErr) as {
          code?: string;
          constraint?: string;
          message?: string;
        };
        expect([orgCause.code, orgCause.constraint]).toEqual([
          '42501',
          'organization_provider_assignments_org_id_immutable',
        ]);
        expect(orgCause.message).toMatch(/org_id of row .* is immutable/);

        let immutProvErr: unknown = null;
        try {
          await h.admin
            .update(schema.organizationProviderAssignments)
            .set({ providerId: mismatchProv!.id })
            .where(eq(schema.organizationProviderAssignments.id, assignment!.id));
        } catch (e) {
          immutProvErr = e;
        }
        expect(immutProvErr).toBeDefined();
        const provCause = ((immutProvErr as { cause?: unknown }).cause ?? immutProvErr) as {
          code?: string;
          constraint?: string;
          message?: string;
        };
        expect([provCause.code, provCause.constraint]).toEqual([
          '42501',
          'organization_provider_assignments_provider_id_immutable',
        ]);
        expect(provCause.message).toMatch(/provider_id of row .* is immutable/);
      } finally {
        await destroyTenant(h.admin, tempTenant);
        await h.admin.delete(schema.providers).where(eq(schema.providers.id, mismatchProv!.id));
      }
    });
  });
});
