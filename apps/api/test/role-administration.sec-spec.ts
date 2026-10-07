/**
 * Role and permission administration (Phase 1B.5.4, `RBAC.md` §§7-8).
 *
 * Role administration is the API that composes privilege, so every case here is
 * adversarial by default: the happy paths exist only as positive controls, so a
 * refusal cannot be mistaken for a broken query.
 *
 * Four properties carry the weight, and each is asserted at both layers where
 * `RBAC.md` §7 names two:
 *
 *   1. **A tenant never rewrites a system role.** Refused by the service for a
 *      clear `403`, and refused again by migration `0004`'s trigger with the
 *      service bypassed entirely.
 *   2. **Composition never exceeds the actor's own authority.** A role cannot be
 *      given a permission the actor does not hold at that organization — the
 *      escalation primitive `roles.create` would otherwise be.
 *   3. **Deletion never becomes a silent mass revocation.** `409` while grants
 *      exist, and `ON DELETE RESTRICT` when the service is bypassed
 *      (ADR-005 D-8, §6n case 18).
 *   4. **Authorization is re-derived per request.** A permission removed from a
 *      role is gone on the next request, not at token expiry (§6n case 17).
 *
 * And one thing deliberately *not* asserted: that a grant at a scope type
 * `allowedScopeTypes` does not admit is refused (§6n case 28). This phase gives
 * that column its value; enforcing it at grant time is Phase 1B.5.5's, and there
 * is no grant API here to enforce it through.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, TENANT_ROLE_DEFINITIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { RequestContext } from '../src/common/context/request-context';
import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  destroyUser,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

interface RoleBody {
  id: string;
  key: string;
  name: string;
  isSystemRole: boolean;
  allowedScopeTypes: string[];
  permissions: string[];
  orgId: string | null;
}

describe('role administration', () => {
  let h: Harness;
  let credentials: CredentialService;
  let db: TenantDatabase;
  let provisioner: TenantRoleProvisioner;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  /** Organization A's admin, holding the full org_admin permission set. */
  let adminToken: string;
  /** A workspace-scoped principal in Organization A: no role administration. */
  let workspaceUser: { userId: string; email: string };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    db = h.app.get(TenantDatabase);
    provisioner = h.app.get(TenantRoleProvisioner);

    orgA = await createTenant(h.admin, 'roleadm-a', credentials);
    orgB = await createTenant(h.admin, 'roleadm-b', credentials);

    // The fixture's org_admin carries only three read permissions, which is not
    // enough to administer roles. Give it the administration set it is defined
    // with, so the tests exercise authorization rather than a fixture gap.
    await grantToFixtureRole(orgA, [
      PERMISSIONS.ROLES_READ,
      PERMISSIONS.ROLES_CREATE,
      PERMISSIONS.ROLES_UPDATE,
      PERMISSIONS.ROLES_DELETE,
      PERMISSIONS.PERMISSIONS_READ,
      PERMISSIONS.TEAMS_READ,
    ]);
    await grantToFixtureRole(orgB, [
      PERMISSIONS.ROLES_READ,
      PERMISSIONS.ROLES_CREATE,
      PERMISSIONS.ROLES_UPDATE,
      PERMISSIONS.ROLES_DELETE,
    ]);

    workspaceUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'roleadm-ws',
    );

    adminToken = await tokenFor(orgA.email);
  }, 90_000);

  afterAll(async () => {
    await destroyUser(h.admin, workspaceUser.userId);
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(async () => {
    await purgeAudit(h.admin, sql`true`);
    // Remove every role this suite created, leaving the fixture roles alone.
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`DELETE FROM role_permissions WHERE role_id IN (
              SELECT id FROM roles WHERE org_id IN (${orgA.orgId}, ${orgB.orgId})
                AND key <> 'org_admin')`,
      );
      await tx.execute(
        sql`DELETE FROM user_roles WHERE role_id IN (
              SELECT id FROM roles WHERE org_id IN (${orgA.orgId}, ${orgB.orgId})
                AND key <> 'org_admin')`,
      );
      await tx.execute(
        sql`DELETE FROM roles WHERE org_id IN (${orgA.orgId}, ${orgB.orgId}) AND key <> 'org_admin'`,
      );
    });
  });

  // --- helpers ---------------------------------------------------------------

  async function grantToFixtureRole(
    tenant: TenantFixture,
    permissions: readonly string[],
  ): Promise<void> {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      for (const key of permissions) {
        const [permission] = await tx
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(eq(schema.permissions.key, key));
        if (permission) {
          await tx
            .insert(schema.rolePermissions)
            .values({ roleId: tenant.roleId, permissionId: permission.id })
            .onConflictDoNothing();
        }
      }
    });
  }

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  const api = (token: string) => ({
    list: () =>
      request(h.app.getHttpServer()).get(url('/roles')).set('authorization', `Bearer ${token}`),
    get: (id: string) =>
      request(h.app.getHttpServer())
        .get(url(`/roles/${id}`))
        .set('authorization', `Bearer ${token}`),
    create: (body: unknown) =>
      request(h.app.getHttpServer())
        .post(url('/roles'))
        .set('authorization', `Bearer ${token}`)
        .send(body),
    update: (id: string, body: unknown) =>
      request(h.app.getHttpServer())
        .patch(url(`/roles/${id}`))
        .set('authorization', `Bearer ${token}`)
        .send(body),
    remove: (id: string) =>
      request(h.app.getHttpServer())
        .delete(url(`/roles/${id}`))
        .set('authorization', `Bearer ${token}`),
    permissions: (query = '') =>
      request(h.app.getHttpServer())
        .get(url(`/permissions${query}`))
        .set('authorization', `Bearer ${token}`),
  });

  /** A valid custom-role body composed only of permissions org_admin holds. */
  const customRole = (key: string, permissions: string[] = [PERMISSIONS.WORKSPACES_READ]) => ({
    key,
    name: 'Custom',
    description: 'A tenant-composed role',
    allowedScopeTypes: ['organization', 'workspace'],
    permissions,
  });

  /**
   * Asserts a database-level refusal, matching the reason rather than the
   * wrapper. Drizzle reports the failed query as the message and carries the
   * PostgreSQL error — the part that names the guard — as `cause`.
   */
  const expectDbRefusal = async (work: Promise<unknown>, reason: RegExp): Promise<void> => {
    let failure: unknown;
    try {
      await work;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const cause = (failure as { cause?: { message?: string } }).cause;
    const message = cause?.message ?? (failure as Error).message;
    expect(message).toMatch(reason);
  };

  const auditRows = async (action: string) => {
    const { rows } = await h.admin.execute<{
      action: string;
      scope_type: string;
      scope_id: string;
      actor_user_id: string | null;
      resource_id: string;
      outcome: string;
    }>(sql`SELECT * FROM audit_logs WHERE action = ${action} ORDER BY occurred_at`);
    return rows;
  };

  // ===========================================================================
  describe('A. reading roles and permissions', () => {
    it('lists the organization’s own roles and the platform definitions', async () => {
      const res = await api(adminToken).list().expect(200);
      const body = res.body as { data: RoleBody[] };
      const keys = body.data.map((r) => r.key);

      expect(keys).toContain('org_admin');
      // Platform roles are readable — RBAC needs them — but carry no org.
      const platform = body.data.filter((r) => r.orgId === null);
      expect(platform.length).toBeGreaterThan(0);
      // And nothing from the other tenant.
      expect(body.data.every((r) => r.orgId === null || r.orgId === orgA.orgId)).toBe(true);
    });

    it('returns the permission catalogue', async () => {
      const res = await api(adminToken).permissions('?limit=100').expect(200);
      const body = res.body as { data: { key: string }[] };
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.map((p) => p.key)).toContain(PERMISSIONS.WORKSPACES_READ);
    });

    it('exposes allowedScopeTypes on every role', async () => {
      const res = await api(adminToken).list().expect(200);
      const body = res.body as { data: RoleBody[] };
      for (const role of body.data) {
        expect(Array.isArray(role.allowedScopeTypes)).toBe(true);
        expect(role.allowedScopeTypes.length).toBeGreaterThan(0);
      }
    });

    it('refuses a principal without roles.read', async () => {
      const token = await tokenFor(workspaceUser.email);
      await api(token).list().expect(403);
    });
  });

  // ===========================================================================
  describe('B. creating a role', () => {
    it('creates one, persisting allowedScopeTypes and its permissions', async () => {
      const res = await api(adminToken).create(customRole('custom_one')).expect(201);
      const body = res.body.data as RoleBody;

      expect(body.key).toBe('custom_one');
      expect(body.orgId).toBe(orgA.orgId);
      expect(body.isSystemRole).toBe(false);
      expect(body.allowedScopeTypes).toEqual(['organization', 'workspace']);
      expect(body.permissions).toEqual([PERMISSIONS.WORKSPACES_READ]);
    });

    it('writes one role.created audit row attributed to the actor', async () => {
      await api(adminToken).create(customRole('custom_audited')).expect(201);
      const rows = await auditRows('role.created');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scope_type).toBe('organization');
      expect(rows[0]!.scope_id).toBe(orgA.orgId);
      expect(rows[0]!.actor_user_id).toBe(orgA.userId);
      expect(rows[0]!.outcome).toBe('success');
    });

    it('refuses a duplicate key in the same organization with 409', async () => {
      await api(adminToken).create(customRole('custom_dup')).expect(201);
      const res = await api(adminToken).create(customRole('custom_dup')).expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
    });

    it('allows the same key in a different organization', async () => {
      await api(adminToken).create(customRole('custom_shared')).expect(201);
      const other = await tokenFor(orgB.email);
      await api(other).create(customRole('custom_shared')).expect(201);
    });

    it('rejects a malformed key', async () => {
      await api(adminToken)
        .create({ ...customRole('Bad Key'), key: 'Bad Key' })
        .expect(400);
    });

    it('rejects an unknown permission key', async () => {
      await api(adminToken)
        .create({ ...customRole('custom_unknown'), permissions: ['not.a_permission'] })
        .expect(400);
    });

    it('rejects an empty allowedScopeTypes', async () => {
      await api(adminToken)
        .create({ ...customRole('custom_empty'), allowedScopeTypes: [] })
        .expect(400);
    });
  });

  // ===========================================================================
  describe('C. composition cannot exceed the actor’s authority', () => {
    it('refuses a permission the actor does not hold at this organization', async () => {
      // org_admin here does not carry `api_keys.create`.
      const res = await api(adminToken)
        .create({ ...customRole('custom_escalate'), permissions: [PERMISSIONS.API_KEYS_CREATE] })
        .expect(403);

      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION);
      expect(res.body.error.details.rejected).toContain(PERMISSIONS.API_KEYS_CREATE);
    });

    it('refuses a platform permission on a tenant role', async () => {
      const res = await api(adminToken)
        .create({
          ...customRole('custom_platform'),
          permissions: [PERMISSIONS.PLATFORM_AUDIT_READ],
        })
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION);
    });

    it('refuses the escalation on update as well as on create', async () => {
      const created = await api(adminToken).create(customRole('custom_upd_esc')).expect(201);
      await api(adminToken)
        .update((created.body.data as RoleBody).id, { permissions: [PERMISSIONS.API_KEYS_CREATE] })
        .expect(403);
    });

    it('nothing is created when composition is refused', async () => {
      await api(adminToken)
        .create({ ...customRole('custom_none'), permissions: [PERMISSIONS.API_KEYS_CREATE] })
        .expect(403);
      const res = await api(adminToken).list().expect(200);
      expect((res.body as { data: RoleBody[] }).data.map((r) => r.key)).not.toContain(
        'custom_none',
      );
    });

    it('a workspace-scoped principal cannot compose at the organization', async () => {
      // Even if it held roles.create, its grant does not cover the organization.
      const token = await tokenFor(workspaceUser.email);
      await api(token).create(customRole('custom_ws')).expect(403);
    });
  });

  // ===========================================================================
  describe('D. system and platform roles are protected', () => {
    const systemRoleId = async (): Promise<string> => {
      const [row] = await h.admin
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(and(eq(schema.roles.orgId, orgA.orgId), eq(schema.roles.key, 'org_admin')));
      return row!.id;
    };

    const platformRoleId = async (): Promise<string> => {
      const [row] = await h.admin
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.key, 'alendei_super_admin'));
      return row!.id;
    };

    it('refuses to update a tenant system role', async () => {
      const res = await api(adminToken)
        .update(await systemRoleId(), { name: 'Hijacked' })
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_PERMISSION_DENIED);
    });

    it('refuses to delete a tenant system role', async () => {
      await api(adminToken)
        .remove(await systemRoleId())
        .expect(403);
    });

    it('refuses to update a platform role', async () => {
      await api(adminToken)
        .update(await platformRoleId(), { name: 'Hijacked' })
        .expect(403);
    });

    it('refuses to delete a platform role', async () => {
      await api(adminToken)
        .remove(await platformRoleId())
        .expect(403);
    });

    it('the database refuses it too, with the service bypassed entirely', async () => {
      // The service guard is a message; this is the control. `acc_app` acting
      // in Organization A's context, going straight at the table.
      const id = await systemRoleId();
      await expectDbRefusal(
        db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
          tx.update(schema.roles).set({ name: 'Hijacked' }).where(eq(schema.roles.id, id)),
        ),
        /system role .* cannot be modified/,
      );
    });

    it('the database refuses a system role’s permission set being edited', async () => {
      const id = await systemRoleId();
      await expectDbRefusal(
        db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
          tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, id)),
        ),
        /fixed permission set/,
      );
    });

    it('a role cannot be promoted into a system role after creation', async () => {
      const created = await api(adminToken).create(customRole('custom_promote')).expect(201);
      const id = (created.body.data as RoleBody).id;
      await expectDbRefusal(
        db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
          tx.update(schema.roles).set({ isSystemRole: true }).where(eq(schema.roles.id, id)),
        ),
        // Since migration 0025 (ADR-015 R-3) `is_system_role` is not a column
        // acc_app may write at all; fn_protect_system_roles stays the backstop
        // for every writer that may.
        /permission denied for table roles/,
      );
    });
  });

  // ===========================================================================
  describe('E. cross-tenant isolation', () => {
    it('cannot read another organization’s role — 404, not 403', async () => {
      const other = await tokenFor(orgB.email);
      const created = await api(other).create(customRole('custom_b')).expect(201);
      const id = (created.body.data as RoleBody).id;

      // Organization A asking for it must not learn that it exists.
      const res = await api(adminToken).get(id).expect(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
      expect(JSON.stringify(res.body)).not.toContain(id);
    });

    it('a real foreign id and an unknown id are indistinguishable', async () => {
      const other = await tokenFor(orgB.email);
      const created = await api(other).create(customRole('custom_b2')).expect(201);
      const foreign = await api(adminToken)
        .get((created.body.data as RoleBody).id)
        .expect(404);
      const unknown = await api(adminToken).get(uuidv7()).expect(404);
      // Everything but the correlation id, which is per-request by design and
      // is the one field that is meant to differ.
      const shape = (body: { error: Record<string, unknown> }) => ({
        ...body.error,
        correlationId: undefined,
      });
      expect(shape(foreign.body)).toEqual(shape(unknown.body));
    });

    it('cannot update another organization’s role', async () => {
      const other = await tokenFor(orgB.email);
      const created = await api(other).create(customRole('custom_b3')).expect(201);
      await api(adminToken)
        .update((created.body.data as RoleBody).id, { name: 'Taken' })
        .expect(404);
    });

    it('cannot delete another organization’s role', async () => {
      const other = await tokenFor(orgB.email);
      const created = await api(other).create(customRole('custom_b4')).expect(201);
      await api(adminToken)
        .remove((created.body.data as RoleBody).id)
        .expect(404);
    });

    it('RLS still blocks the row with application authorization bypassed', async () => {
      // §6n case 25, re-asserted across the new surface: Organization A's
      // context querying Organization B's role directly sees nothing.
      const other = await tokenFor(orgB.email);
      const created = await api(other).create(customRole('custom_b5')).expect(201);
      const id = (created.body.data as RoleBody).id;

      const rows = await db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
        tx.select().from(schema.roles).where(eq(schema.roles.id, id)),
      );
      expect(rows).toHaveLength(0);
    });

    it('cross-reseller: organization B lives under its own reseller and stays invisible', async () => {
      expect(orgA.resellerId).not.toBe(orgB.resellerId);
      const rows = await db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
        tx.select().from(schema.roles).where(eq(schema.roles.orgId, orgB.orgId)),
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ===========================================================================
  describe('F. §6n case 17 — a permission removed from a role', () => {
    it('is denied on the next request, not at token expiry', async () => {
      // A user whose only grant is a custom role carrying workspaces.read.
      const created = await api(adminToken).create(customRole('custom_revoke')).expect(201);
      const roleId = (created.body.data as RoleBody).id;

      const email = `revoke-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const [user] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      await h.admin
        .insert(schema.userRoles)
        .values({ userId: user!.id, roleId, scopeType: 'organization', scopeId: orgA.orgId });

      try {
        const token = await tokenFor(email);
        // Positive control: the grant works before the permission is removed.
        await request(h.app.getHttpServer())
          .get(url('/tenants/workspaces'))
          .set('authorization', `Bearer ${token}`)
          .expect(200);

        // Strip it through the administration API — the path under test.
        await api(adminToken).update(roleId, { permissions: [] }).expect(200);

        // Same token, next request: denied. Authorization is re-derived per
        // request from current state (ADR-003 D-3), so nothing is snapshotted.
        const after = await request(h.app.getHttpServer())
          .get(url('/tenants/workspaces'))
          .set('authorization', `Bearer ${token}`)
          .expect(403);
        expect(after.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      } finally {
        await destroyUser(h.admin, user!.id);
      }
    });

    it('the removal is audited as role.updated carrying before and after', async () => {
      const created = await api(adminToken).create(customRole('custom_upd')).expect(201);
      await purgeAudit(h.admin, sql`true`);
      await api(adminToken)
        .update((created.body.data as RoleBody).id, { permissions: [] })
        .expect(200);

      const rows = await auditRows('role.updated');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_user_id).toBe(orgA.userId);
    });
  });

  // ===========================================================================
  describe('G. §6n case 18 — deleting a role while grants exist', () => {
    let roleId: string;
    let holderId: string;

    beforeEach(async () => {
      const created = await api(adminToken).create(customRole('custom_granted')).expect(201);
      roleId = (created.body.data as RoleBody).id;

      const [user] = await h.admin
        .insert(schema.users)
        .values({
          email: `holder-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      holderId = user!.id;
      await h.admin
        .insert(schema.userRoles)
        .values({ userId: holderId, roleId, scopeType: 'organization', scopeId: orgA.orgId });
    });

    afterEach(async () => {
      await destroyUser(h.admin, holderId);
    });

    it('is refused with 409 and the grants are intact', async () => {
      const res = await api(adminToken).remove(roleId).expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);

      const grants = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.roleId, roleId));
      expect(grants).toHaveLength(1);
    });

    it('the role itself is intact', async () => {
      await api(adminToken).remove(roleId).expect(409);
      await api(adminToken).get(roleId).expect(200);
    });

    it('ON DELETE RESTRICT refuses it with the service bypassed', async () => {
      // The service check is the message; the constraint is the control.
      await expect(
        db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
          tx.delete(schema.roles).where(eq(schema.roles.id, roleId)),
        ),
      ).rejects.toThrow();

      const [still] = await h.admin
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.id, roleId));
      expect(still).toBeDefined();
    });

    it('succeeds once the grant is revoked', async () => {
      await h.admin.execute(sql`DELETE FROM user_roles WHERE role_id = ${roleId}`);
      await api(adminToken).remove(roleId).expect(204);
      await api(adminToken).get(roleId).expect(404);
    });

    it('writes a role.deleted audit row only on the successful deletion', async () => {
      await api(adminToken).remove(roleId).expect(409);
      expect(await auditRows('role.deleted')).toHaveLength(0);

      await h.admin.execute(sql`DELETE FROM user_roles WHERE role_id = ${roleId}`);
      await api(adminToken).remove(roleId).expect(204);
      expect(await auditRows('role.deleted')).toHaveLength(1);
    });

    it('a concurrent grant and delete cannot both win', async () => {
      // The delete-vs-grant race: the constraint decides it, not ordering. One
      // of the two must fail, and a role can never end up deleted with a live
      // grant pointing at it.
      await h.admin.execute(sql`DELETE FROM user_roles WHERE role_id = ${roleId}`);

      const grant = h.admin
        .insert(schema.userRoles)
        .values({ userId: holderId, roleId, scopeType: 'organization', scopeId: orgA.orgId })
        .then(
          () => 'granted' as const,
          () => 'refused' as const,
        );
      const remove = api(adminToken)
        .remove(roleId)
        .then((res) => (res.status === 204 ? ('deleted' as const) : ('refused' as const)));

      const [grantOutcome, removeOutcome] = await Promise.all([grant, remove]);
      expect([grantOutcome, removeOutcome]).not.toEqual(['granted', 'deleted']);

      // Whatever happened, the database is coherent: no grant survives whose
      // role is gone.
      const { rows } = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM user_roles ur
              LEFT JOIN roles r ON r.id = ur.role_id WHERE r.id IS NULL`,
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });
  });

  // ===========================================================================
  describe('H. API-key-scoped role administration', () => {
    it('an API key carrying no role permissions cannot administer roles', async () => {
      const keyPrefix = `ak_test_${randomBytes(8).toString('hex')}`;
      const secret = uuidv7();
      await h.admin.insert(schema.apiKeys).values({
        orgId: orgA.orgId,
        name: 'roleadm-key',
        keyPrefix,
        keyHash: await credentials.hash(secret),
        createdBy: orgA.userId,
        scopes: [PERMISSIONS.WORKSPACES_READ],
      });

      try {
        // The key's effective permissions intersect its creator's authority at
        // the binding scope, and `scopes` withholds role administration — so it
        // cannot reach this surface however wide its creator is.
        const res = await request(h.app.getHttpServer())
          .get(url('/roles'))
          .set('authorization', `Bearer ${keyPrefix}.${secret}`);
        expect([401, 403]).toContain(res.status);
      } finally {
        // `api_key.authenticated` rows reference the key, so the trail is
        // purged before the key can go.
        await purgeAudit(h.admin, sql`true`);
        await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${keyPrefix}`);
      }
    });
  });

  // ===========================================================================
  describe('I. authorization denial auditing still holds on the new surface', () => {
    it('a refused role read writes authorization.denied with the actor’s own scope', async () => {
      const token = await tokenFor(workspaceUser.email);
      await api(token).list().expect(403);

      const rows = await auditRows('authorization.denied');
      expect(rows).toHaveLength(1);
      // The actor is pinned to a workspace, so the row says workspace — never
      // the organization it reached for (Phase 1B.5.3, ADR-005 D-6).
      expect(rows[0]!.scope_type).toBe('workspace');
      expect(rows[0]!.scope_id).toBe(orgA.workspaceId);
      expect(rows[0]!.actor_user_id).toBe(workspaceUser.userId);
    });
  });

  // ===========================================================================
  describe('J. TenantRoleProvisioner', () => {
    const provisioningSession = (tenant: TenantFixture) => ({
      orgId: tenant.orgId,
      resellerId: tenant.resellerId,
      provisioning: true,
    });

    const inRequest = <T>(work: () => Promise<T>): Promise<T> =>
      RequestContext.run(
        {
          correlationId: uuidv7(),
          requestId: uuidv7(),
          causationId: null,
          traceId: null,
          principal: null,
          ip: null,
          userAgent: null,
        },
        work,
      );

    const tenantRoleKeys = async (tenant: TenantFixture): Promise<string[]> => {
      const rows = await h.admin
        .select({ key: schema.roles.key })
        .from(schema.roles)
        .where(eq(schema.roles.orgId, tenant.orgId));
      return rows.map((r) => r.key).sort();
    };

    it('seeds every canonical tenant role', async () => {
      const result = await inRequest(() =>
        db.withTenant(provisioningSession(orgA), (tx) =>
          provisioner.seedTenantRoles(tx, orgA.orgId),
        ),
      );

      // `org_admin` already exists from the fixture, so it is reported existing
      // rather than created — which is the idempotency property, observed on a
      // first run.
      expect(result.existing).toContain('org_admin');
      const keys = await tenantRoleKeys(orgA);
      for (const definition of TENANT_ROLE_DEFINITIONS) {
        expect(keys).toContain(definition.key);
      }
    });

    it('persists allowedScopeTypes and the permission set from the definitions', async () => {
      await inRequest(() =>
        db.withTenant(provisioningSession(orgA), (tx) =>
          provisioner.seedTenantRoles(tx, orgA.orgId),
        ),
      );

      const definition = TENANT_ROLE_DEFINITIONS.find((d) => d.key === 'read_only')!;
      const [role] = await h.admin
        .select()
        .from(schema.roles)
        .where(and(eq(schema.roles.orgId, orgA.orgId), eq(schema.roles.key, 'read_only')));

      expect(role!.allowedScopeTypes.sort()).toEqual([...definition.allowedScopeTypes].sort());
      expect(role!.isSystemRole).toBe(true);

      const permissions = await h.admin
        .select({ key: schema.permissions.key })
        .from(schema.rolePermissions)
        .innerJoin(
          schema.permissions,
          eq(schema.permissions.id, schema.rolePermissions.permissionId),
        )
        .where(eq(schema.rolePermissions.roleId, role!.id));
      expect(permissions.map((p) => p.key).sort()).toEqual([...definition.permissions].sort());
    });

    it('is idempotent: a second run creates nothing', async () => {
      await inRequest(() =>
        db.withTenant(provisioningSession(orgA), (tx) =>
          provisioner.seedTenantRoles(tx, orgA.orgId),
        ),
      );
      const before = await tenantRoleKeys(orgA);

      const second = await inRequest(() =>
        db.withTenant(provisioningSession(orgA), (tx) =>
          provisioner.seedTenantRoles(tx, orgA.orgId),
        ),
      );

      expect(second.created).toEqual([]);
      expect(await tenantRoleKeys(orgA)).toEqual(before);
    });

    it('a repeat run writes no further role.created audit rows', async () => {
      await inRequest(() =>
        db.withTenant(provisioningSession(orgA), (tx) =>
          provisioner.seedTenantRoles(tx, orgA.orgId),
        ),
      );
      const afterFirst = (await auditRows('role.created')).length;
      expect(afterFirst).toBeGreaterThan(0);

      await inRequest(() =>
        db.withTenant(provisioningSession(orgA), (tx) =>
          provisioner.seedTenantRoles(tx, orgA.orgId),
        ),
      );

      // Not "roughly the same" — exactly the same. A `role.created` per retry
      // would report creations that never happened.
      expect((await auditRows('role.created')).length).toBe(afterFirst);
    });

    it('rolls back entirely when the caller’s transaction fails', async () => {
      const before = await tenantRoleKeys(orgB);

      await expect(
        inRequest(() =>
          db.withTenant(provisioningSession(orgB), async (tx) => {
            await provisioner.seedTenantRoles(tx, orgB.orgId);
            // The caller fails after provisioning returned — the case that
            // matters, because the roles are already written at this point.
            throw new Error('caller failed after provisioning');
          }),
        ),
      ).rejects.toThrow('caller failed after provisioning');

      expect(await tenantRoleKeys(orgB)).toEqual(before);
      expect(await auditRows('role.created')).toHaveLength(0);
    });

    it('creates no organization of its own', async () => {
      const before = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM organizations`,
      );
      await inRequest(() =>
        db.withTenant(provisioningSession(orgA), (tx) =>
          provisioner.seedTenantRoles(tx, orgA.orgId),
        ),
      );
      const after = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM organizations`,
      );
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    });

    it('reports what is still missing without writing', async () => {
      const missing = await db.withTenant(provisioningSession(orgB), (tx) =>
        provisioner.missingRoles(tx, orgB.orgId),
      );
      expect(missing).not.toContain('org_admin');
      expect(missing).toContain('read_only');
      // And nothing was written by asking.
      expect(await tenantRoleKeys(orgB)).toEqual(['org_admin']);
    });
  });
});
