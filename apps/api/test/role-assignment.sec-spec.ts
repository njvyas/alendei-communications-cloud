/**
 * Role-assignment administration (Phase 1B.5.5, `RBAC.md` §§7-8b).
 *
 * This is the API that confers privilege, so a gap here is not a bug in one
 * feature — it is a general escalation primitive. Every case is adversarial by
 * default; the positive controls exist so a refusal cannot be mistaken for a
 * broken query.
 *
 * The §6n cases this increment owns:
 *
 *   16 — a revoked grant is denied on the *next request*, not at token expiry
 *   21 — granting role R at scope s where the actor lacks R's permissions at s
 *   22 — granting a permission the actor holds only at a narrower scope
 *   26 — `fn_validate_user_role_scope` still raises with the service bypassed
 *   27 — a self-grant within the actor's own authority is allowed, and confers
 *        nothing new
 *   28 — a grant at a scope type `allowedScopeTypes` does not admit is refused
 *   29 — a duplicate grant is `409`
 *
 * Case 28 is the one this phase exists to close: Phase 1B.5.4 gave
 * `roles.allowed_scope_types` its value, and nothing consulted it until now.
 *
 * **Not asserted here:** the last-platform-admin invariant on revocation. It is
 * Phase 1B.5.6's, together with the advisory-lock trigger that makes it hold
 * under concurrency (ADR-005 D-7) — a service check alone would look like an
 * invariant while losing under exactly the conditions it exists for.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, type ScopeType } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
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

interface AssignmentBody {
  id: string;
  userId: string;
  roleId: string;
  roleKey: string;
  scopeType: string;
  scopeId: string | null;
  grantedBy: string | null;
}

describe('role-assignment administration', () => {
  let h: Harness;
  let credentials: CredentialService;
  let db: TenantDatabase;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  /** Organization A's admin — the actor for the positive controls. */
  let adminToken: string;
  /** A second workspace in Organization A, for sibling-scope cases. */
  let workspaceTwoId: string;
  /** A user in Organization A holding only a workspace-scoped grant. */
  let workspaceUser: { userId: string; email: string };
  /** A grantable custom role carrying only `workspaces.read`. */
  let narrowRoleId: string;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    db = h.app.get(TenantDatabase);

    orgA = await createTenant(h.admin, 'grant-a', credentials);
    orgB = await createTenant(h.admin, 'grant-b', credentials);

    // The fixture's org_admin carries three read permissions; give it the
    // grant-administration set so these tests exercise authorization rather
    // than a fixture gap.
    await addToFixtureRole(orgA, [
      PERMISSIONS.ROLE_ASSIGNMENTS_READ,
      PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
      PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE,
      PERMISSIONS.ROLES_READ,
    ]);
    await addToFixtureRole(orgB, [
      PERMISSIONS.ROLE_ASSIGNMENTS_READ,
      PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
      PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE,
    ]);

    const [second] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: orgA.orgId, name: 'Second', slug: 'second' })
      .returning({ id: schema.workspaces.id });
    workspaceTwoId = second!.id;

    workspaceUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'grant-ws',
    );

    narrowRoleId = await makeRole(
      orgA,
      'narrow_grantable',
      ['organization', 'workspace', 'team'],
      [PERMISSIONS.WORKSPACES_READ],
    );

    adminToken = await tokenFor(orgA.email);
  }, 90_000);

  afterAll(async () => {
    await destroyUser(h.admin, workspaceUser.userId);
    await h.admin.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceTwoId}`);
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(async () => {
    await purgeAudit(h.admin, sql`true`);
    // Remove every grant this suite made, leaving the fixtures' own intact.
    await h.admin.execute(
      sql`DELETE FROM user_roles WHERE role_id IN (
            SELECT id FROM roles WHERE org_id IN (${orgA.orgId}, ${orgB.orgId})
              AND key <> 'org_admin')`,
    );
    await h.admin.execute(
      sql`DELETE FROM user_roles WHERE user_id = ${workspaceUser.userId}
            AND scope_id <> ${orgA.workspaceId}`,
    );
  });

  // --- fixtures --------------------------------------------------------------

  async function addToFixtureRole(
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

  /** A non-system, grantable role in a tenant. */
  async function makeRole(
    tenant: TenantFixture,
    key: string,
    allowedScopeTypes: ScopeType[],
    permissions: readonly string[],
  ): Promise<string> {
    const [role] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: tenant.orgId,
        key,
        name: key,
        isSystemRole: false,
        allowedScopeTypes,
      })
      .returning({ id: schema.roles.id });

    for (const permissionKey of permissions) {
      const [permission] = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, permissionKey));
      if (permission) {
        await h.admin
          .insert(schema.rolePermissions)
          .values({ roleId: role!.id, permissionId: permission.id })
          .onConflictDoNothing();
      }
    }
    return role!.id;
  }

  async function makeUser(tenant: TenantFixture, label: string): Promise<string> {
    const [user] = await h.admin
      .insert(schema.users)
      .values({
        email: `${label}-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    // One grant so the user is reachable — the same reachability rule the
    // service applies, established through the fixture rather than asserted.
    await h.admin.insert(schema.userRoles).values({
      userId: user!.id,
      roleId: tenant.roleId,
      scopeType: 'organization',
      scopeId: tenant.orgId,
    });
    return user!.id;
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
    list: (query = '') =>
      request(h.app.getHttpServer())
        .get(url(`/role-assignments${query}`))
        .set('authorization', `Bearer ${token}`),
    get: (id: string) =>
      request(h.app.getHttpServer())
        .get(url(`/role-assignments/${id}`))
        .set('authorization', `Bearer ${token}`),
    grant: (body: unknown) =>
      request(h.app.getHttpServer())
        .post(url('/role-assignments'))
        .set('authorization', `Bearer ${token}`)
        .send(body),
    revoke: (id: string) =>
      request(h.app.getHttpServer())
        .delete(url(`/role-assignments/${id}`))
        .set('authorization', `Bearer ${token}`),
  });

  const auditRows = async (action: string) => {
    const { rows } = await h.admin.execute<{
      action: string;
      scope_type: string;
      scope_id: string | null;
      actor_user_id: string | null;
      resource_id: string;
      outcome: string;
    }>(sql`SELECT * FROM audit_logs WHERE action = ${action} ORDER BY occurred_at`);
    return rows;
  };

  /** Drizzle reports the failed query; the guard's reason is on `cause`. */
  const expectDbRefusal = async (work: Promise<unknown>, reason: RegExp): Promise<void> => {
    let failure: unknown;
    try {
      await work;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const cause = (failure as { cause?: { message?: string } }).cause;
    expect(cause?.message ?? (failure as Error).message).toMatch(reason);
  };

  // ===========================================================================
  describe('A. granting within the actor’s authority', () => {
    it('grants a role at the organization and returns it', async () => {
      const userId = await makeUser(orgA, 'a-grantee');
      const res = await api(adminToken)
        .grant({
          userId,
          roleId: narrowRoleId,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        })
        .expect(201);

      const body = res.body.data as AssignmentBody;
      expect(body.userId).toBe(userId);
      expect(body.roleId).toBe(narrowRoleId);
      expect(body.scopeType).toBe('organization');
      expect(body.grantedBy).toBe(orgA.userId);
    });

    it('grants at a child workspace — downward inheritance', async () => {
      const userId = await makeUser(orgA, 'a-ws');
      await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'workspace', scopeId: orgA.workspaceId })
        .expect(201);
    });

    it('grants at a child team', async () => {
      const userId = await makeUser(orgA, 'a-team');
      await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'team', scopeId: orgA.teamId })
        .expect(201);
    });

    it('lists the grants it made, and filters by user', async () => {
      const userId = await makeUser(orgA, 'a-list');
      await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(201);

      const all = await api(adminToken).list().expect(200);
      expect((all.body as { data: AssignmentBody[] }).data.length).toBeGreaterThan(0);

      const mine = await api(adminToken).list(`?userId=${userId}`).expect(200);
      const rows = (mine.body as { data: AssignmentBody[] }).data;
      // The filter's property is that it returns this user's grants and only
      // this user's — not a fixed count: `makeUser` plants a reachability grant,
      // so the user legitimately holds two.
      expect(rows.every((r) => r.userId === userId)).toBe(true);
      expect(rows.map((r) => r.roleKey)).toContain('narrow_grantable');
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it('reads one assignment by id', async () => {
      const userId = await makeUser(orgA, 'a-detail');
      const created = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(201);
      const id = (created.body.data as AssignmentBody).id;

      const res = await api(adminToken).get(id).expect(200);
      expect((res.body.data as AssignmentBody).id).toBe(id);
      expect((res.body.data as AssignmentBody).roleKey).toBe('narrow_grantable');
    });
  });

  // ===========================================================================
  describe('B. §6n case 28 — allowedScopeTypes', () => {
    let orgOnlyRoleId: string;

    beforeAll(async () => {
      // Admits `organization` only — the shape `org_admin` has.
      orgOnlyRoleId = await makeRole(
        orgA,
        'org_only_role',
        ['organization'],
        [PERMISSIONS.WORKSPACES_READ],
      );
    });

    it('refuses a grant at a scope type the role does not admit', async () => {
      const userId = await makeUser(orgA, 'c28-team');
      const res = await api(adminToken)
        .grant({ userId, roleId: orgOnlyRoleId, scopeType: 'team', scopeId: orgA.teamId })
        .expect(422);

      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_TYPE_NOT_ADMITTED);
      expect(res.body.error.details.allowedScopeTypes).toEqual(['organization']);
      expect(res.body.error.details.requested).toBe('team');
    });

    it('refuses it at workspace too, and writes no grant', async () => {
      const userId = await makeUser(orgA, 'c28-ws');
      await api(adminToken)
        .grant({ userId, roleId: orgOnlyRoleId, scopeType: 'workspace', scopeId: orgA.workspaceId })
        .expect(422);

      const rows = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.roleId, orgOnlyRoleId));
      expect(rows).toHaveLength(0);
    });

    it('allows the scope type the role does admit — the positive control', async () => {
      const userId = await makeUser(orgA, 'c28-ok');
      await api(adminToken)
        .grant({ userId, roleId: orgOnlyRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(201);
    });

    it('the refusal is 422, distinct from a 403 scope denial', async () => {
      // The actor *could* grant this role at the organization, so calling it a
      // scope denial would tell an administrator it lacks authority it has.
      const userId = await makeUser(orgA, 'c28-distinct');
      const refused = await api(adminToken)
        .grant({ userId, roleId: orgOnlyRoleId, scopeType: 'team', scopeId: orgA.teamId })
        .expect(422);
      expect(refused.body.error.code).not.toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

      await api(adminToken)
        .grant({ userId, roleId: orgOnlyRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(201);
    });
  });

  // ===========================================================================
  describe('C. §6n cases 21 and 22 — privilege escalation', () => {
    it('21. refuses a role carrying a permission the actor lacks at that scope', async () => {
      // `api_keys.create` is not in Organization A's org_admin fixture set.
      const wideRoleId = await makeRole(
        orgA,
        'wide_role',
        ['organization'],
        [PERMISSIONS.API_KEYS_CREATE],
      );
      const userId = await makeUser(orgA, 'c21');

      const res = await api(adminToken)
        .grant({ userId, roleId: wideRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION);
      expect(res.body.error.details.rejected).toContain(PERMISSIONS.API_KEYS_CREATE);
    });

    it('22. refuses conferring at the organization what the actor holds only in one workspace', async () => {
      // The workspace user holds its grant at workspace one only. Give that
      // role `role_assignments.grant` so it can reach this endpoint at all —
      // the escalation being tested is the *scope*, not the permission.
      const wsRoleId = await makeRole(
        orgA,
        'ws_granter',
        ['workspace'],
        [PERMISSIONS.ROLE_ASSIGNMENTS_GRANT, PERMISSIONS.ROLE_ASSIGNMENTS_READ],
      );
      await h.admin.insert(schema.userRoles).values({
        userId: workspaceUser.userId,
        roleId: wsRoleId,
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });

      try {
        const token = await tokenFor(workspaceUser.email);
        const userId = await makeUser(orgA, 'c22');

        // Positive control: within its own workspace it can grant.
        await api(token)
          .grant({
            userId,
            roleId: narrowRoleId,
            scopeType: 'workspace',
            scopeId: orgA.workspaceId,
          })
          .expect(201);

        // The escalation: the same permission, one level up.
        const res = await api(token)
          .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
          .expect(403);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      } finally {
        await h.admin.execute(sql`DELETE FROM user_roles WHERE role_id = ${wsRoleId}`);
      }
    });

    it('refuses a grant at a sibling workspace the actor does not control', async () => {
      const wsRoleId = await makeRole(
        orgA,
        'ws_granter_two',
        ['workspace'],
        [PERMISSIONS.ROLE_ASSIGNMENTS_GRANT],
      );
      await h.admin.insert(schema.userRoles).values({
        userId: workspaceUser.userId,
        roleId: wsRoleId,
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });

      try {
        const token = await tokenFor(workspaceUser.email);
        const userId = await makeUser(orgA, 'c22-sib');
        // Workspace two is a sibling: visible under RLS, not covered by the grant.
        await api(token)
          .grant({ userId, roleId: narrowRoleId, scopeType: 'workspace', scopeId: workspaceTwoId })
          .expect(403);
      } finally {
        await h.admin.execute(sql`DELETE FROM user_roles WHERE role_id = ${wsRoleId}`);
      }
    });

    it('22b. the composition guard is coherent-grant, not the flattened union', async () => {
      // The case the flattened union gets wrong, and the reason ADR-005 removed
      // it from the decision path.
      //
      // The actor holds two grants: `role_assignments.grant` across the
      // ORGANIZATION, and `teams.create` in ONE WORKSPACE. Its flattened
      // permission list therefore contains `teams.create` — but no single grant
      // both carries it and reaches the organization, so it may not confer it
      // there. A guard written against `principal.permissions` would allow this
      // grant; the coherent-grant rule refuses it.
      const granterRoleId = await makeRole(
        orgA,
        'x_org_granter',
        ['organization'],
        [PERMISSIONS.ROLE_ASSIGNMENTS_GRANT, PERMISSIONS.ROLE_ASSIGNMENTS_READ],
      );
      const narrowHolderRoleId = await makeRole(
        orgA,
        'x_ws_teams',
        ['workspace'],
        [PERMISSIONS.TEAMS_CREATE],
      );
      // The role being conferred, carrying exactly the contested permission.
      const conferredRoleId = await makeRole(
        orgA,
        'x_conferred',
        ['organization', 'workspace'],
        [PERMISSIONS.TEAMS_CREATE],
      );

      const email = `x22b-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const [actor] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      await h.admin.insert(schema.userRoles).values([
        {
          userId: actor!.id,
          roleId: granterRoleId,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        },
        {
          userId: actor!.id,
          roleId: narrowHolderRoleId,
          scopeType: 'workspace',
          scopeId: orgA.workspaceId,
        },
      ]);

      try {
        const token = await tokenFor(email);

        // The flattening really is present on the principal — so this test is
        // about which rule consults it, not about whether it exists.
        const me = await request(h.app.getHttpServer())
          .get(url('/auth/me'))
          .set('authorization', `Bearer ${token}`)
          .expect(200);
        expect(me.body.data.permissions).toContain(PERMISSIONS.TEAMS_CREATE);

        const target = await makeUser(orgA, 'x22b-target');

        // Refused at the ORGANIZATION: no one grant both carries
        // `teams.create` and reaches that scope.
        const refused = await api(token)
          .grant({
            userId: target,
            roleId: conferredRoleId,
            scopeType: 'organization',
            scopeId: orgA.orgId,
          })
          .expect(403);
        expect(refused.body.error.code).toBe(ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION);
        expect(refused.body.error.details.rejected).toContain(PERMISSIONS.TEAMS_CREATE);

        // Allowed in the WORKSPACE where one coherent grant does carry it.
        // Same actor, same role, same permission — only the scope differs, which
        // is precisely what the flattened union cannot distinguish.
        await api(token)
          .grant({
            userId: target,
            roleId: conferredRoleId,
            scopeType: 'workspace',
            scopeId: orgA.workspaceId,
          })
          .expect(201);
      } finally {
        await destroyUser(h.admin, actor!.id);
      }
    });

    it('27. a self-grant within the actor’s own authority is allowed and confers nothing new', async () => {
      const before = await api(adminToken).list().expect(200);

      await api(adminToken)
        .grant({
          userId: orgA.userId,
          roleId: narrowRoleId,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        })
        .expect(201);

      // `narrow_grantable` carries only `workspaces.read`, which org_admin
      // already holds — so the actor's effective authority is unchanged.
      const token = await tokenFor(orgA.email);
      const me = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body.data.permissions).not.toContain(PERMISSIONS.API_KEYS_CREATE);
      expect((before.body as { data: AssignmentBody[] }).data).toBeDefined();
    });
  });

  // ===========================================================================
  describe('D. cross-tenant and cross-reseller', () => {
    it('refuses a grant at another organization’s scope — 404, no existence leak', async () => {
      const userId = await makeUser(orgA, 'd-cross');
      const res = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgB.orgId })
        .expect(404);
      expect(JSON.stringify(res.body)).not.toContain(orgB.orgId);
    });

    it('a real foreign scope and a nonexistent one are indistinguishable', async () => {
      const userId = await makeUser(orgA, 'd-oracle');
      const foreign = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'workspace', scopeId: orgB.workspaceId })
        .expect(404);
      const unknown = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'workspace', scopeId: uuidv7() })
        .expect(404);

      const shape = (b: { error: Record<string, unknown> }) => ({
        ...b.error,
        correlationId: undefined,
      });
      expect(shape(foreign.body)).toEqual(shape(unknown.body));
    });

    it('cross-reseller: organizations sit under different resellers and neither reaches the other', async () => {
      expect(orgA.resellerId).not.toBe(orgB.resellerId);
      const other = await tokenFor(orgB.email);
      const userId = await makeUser(orgB, 'd-resell');
      await api(other)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgB.orgId })
        // `narrow_grantable` belongs to Organization A, so B cannot even see it.
        .expect(404);
    });

    it('refuses another organization’s role at its own scope', async () => {
      const foreignRoleId = await makeRole(
        orgB,
        'b_role',
        ['organization'],
        [PERMISSIONS.WORKSPACES_READ],
      );
      const userId = await makeUser(orgA, 'd-foreign-role');
      await api(adminToken)
        .grant({ userId, roleId: foreignRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(404);
    });

    it('cannot read another organization’s assignment', async () => {
      const other = await tokenFor(orgB.email);
      const userId = await makeUser(orgB, 'd-read');
      const bRole = await makeRole(
        orgB,
        'b_read_role',
        ['organization'],
        [PERMISSIONS.WORKSPACES_READ],
      );
      const created = await api(other)
        .grant({ userId, roleId: bRole, scopeType: 'organization', scopeId: orgB.orgId })
        .expect(201);

      await api(adminToken)
        .get((created.body.data as AssignmentBody).id)
        .expect(404);
    });
  });

  // ===========================================================================
  describe('E. platform boundary and system roles', () => {
    it('refuses a platform role through tenant administration', async () => {
      const [platformRole] = await h.admin
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.key, 'alendei_super_admin'));
      const userId = await makeUser(orgA, 'e-platform');

      const res = await api(adminToken)
        .grant({
          userId,
          roleId: platformRole!.id,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        })
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_PLATFORM_ROLE_REQUIRED);
    });

    it('platform scope is not even representable in the request', async () => {
      const userId = await makeUser(orgA, 'e-scope');
      await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'platform', scopeId: null })
        .expect(400);
    });

    it('26. fn_validate_user_role_scope still raises with the service bypassed', async () => {
      // A role belonging to Organization B, granted at Organization A's scope.
      const foreignRoleId = await makeRole(orgB, 'b_trigger_role', ['organization'], []);
      const userId = await makeUser(orgA, 'e-trigger');

      await expectDbRefusal(
        db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
          tx.insert(schema.userRoles).values({
            userId,
            roleId: foreignRoleId,
            scopeType: 'organization',
            scopeId: orgA.orgId,
          }),
        ),
        /cross-tenant grant refused|does not exist/,
      );
    });

    it('a tenant principal cannot grant a platform role even at reseller scope', async () => {
      const [platformRole] = await h.admin
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.key, 'reseller_admin'));
      const userId = await makeUser(orgA, 'e-reseller');

      const res = await api(adminToken).grant({
        userId,
        roleId: platformRole!.id,
        scopeType: 'reseller',
        scopeId: orgA.resellerId,
      });
      expect([403, 404]).toContain(res.status);
    });
  });

  // ===========================================================================
  describe('F. §6n case 29 — duplicates, and revocation', () => {
    it('29. a duplicate grant is 409', async () => {
      const userId = await makeUser(orgA, 'f-dup');
      const body = {
        userId,
        roleId: narrowRoleId,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      };
      await api(adminToken).grant(body).expect(201);
      const res = await api(adminToken).grant(body).expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
    });

    it('the same role at a different scope is not a duplicate', async () => {
      const userId = await makeUser(orgA, 'f-diff');
      await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(201);
      await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'workspace', scopeId: orgA.workspaceId })
        .expect(201);
    });

    it('revokes an assignment and it disappears', async () => {
      const userId = await makeUser(orgA, 'f-revoke');
      const created = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(201);
      const id = (created.body.data as AssignmentBody).id;

      await api(adminToken).revoke(id).expect(204);
      await api(adminToken).get(id).expect(404);
    });

    it('a repeated delete is 404, not a second success', async () => {
      const userId = await makeUser(orgA, 'f-twice');
      const created = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(201);
      const id = (created.body.data as AssignmentBody).id;

      await api(adminToken).revoke(id).expect(204);
      await api(adminToken).revoke(id).expect(404);
    });

    it('refuses revocation at a scope the actor does not cover', async () => {
      const wsRoleId = await makeRole(
        orgA,
        'ws_revoker',
        ['workspace'],
        [PERMISSIONS.ROLE_ASSIGNMENTS_READ],
      );
      await h.admin.insert(schema.userRoles).values({
        userId: workspaceUser.userId,
        roleId: wsRoleId,
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });

      try {
        const userId = await makeUser(orgA, 'f-scope');
        const created = await api(adminToken)
          .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
          .expect(201);

        const token = await tokenFor(workspaceUser.email);
        // It can see the assignment listed, but its grant does not cover the
        // organization the assignment lives at.
        await api(token)
          .revoke((created.body.data as AssignmentBody).id)
          .expect(403);
      } finally {
        await h.admin.execute(sql`DELETE FROM user_roles WHERE role_id = ${wsRoleId}`);
      }
    });
  });

  // ===========================================================================
  describe('G. §6n case 16 — a revoked grant stops working on the next request', () => {
    it('is denied on the next request, not at token expiry', async () => {
      const readRoleId = await makeRole(
        orgA,
        'read_grantable',
        ['organization'],
        [PERMISSIONS.WORKSPACES_READ],
      );
      const email = `c16-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const [user] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      // A second grant carrying nothing, so revoking the first removes the
      // *permission* without removing the user's tenant context. Without it the
      // next request would fail as `400 TENANCY_CONTEXT_REQUIRED` — a refusal,
      // but not the authorization refusal this case is about.
      const inertRoleId = await makeRole(orgA, 'c16_inert', ['organization'], []);
      await h.admin.insert(schema.userRoles).values([
        {
          userId: user!.id,
          roleId: readRoleId,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        },
        {
          userId: user!.id,
          roleId: inertRoleId,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        },
      ]);

      try {
        const token = await tokenFor(email);
        // Positive control: the grant works.
        await request(h.app.getHttpServer())
          .get(url('/tenants/workspaces'))
          .set('authorization', `Bearer ${token}`)
          .expect(200);

        // Revoke it through the API under test.
        const [assignment] = await h.admin
          .select({ id: schema.userRoles.id })
          .from(schema.userRoles)
          .where(
            and(eq(schema.userRoles.userId, user!.id), eq(schema.userRoles.roleId, readRoleId)),
          );
        await api(adminToken).revoke(assignment!.id).expect(204);

        // Same token, next request: denied. Authorization is re-derived per
        // request from current state (ADR-003 D-3).
        await request(h.app.getHttpServer())
          .get(url('/tenants/workspaces'))
          .set('authorization', `Bearer ${token}`)
          .expect(403);
      } finally {
        await destroyUser(h.admin, user!.id);
      }
    });
  });

  // ===========================================================================
  describe('H. disabled and deleted principals', () => {
    it('refuses granting to a disabled user', async () => {
      const userId = await makeUser(orgA, 'h-disabled');
      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, userId));

      const res = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
    });

    it('refuses granting to a user that does not exist', async () => {
      await api(adminToken)
        .grant({
          userId: uuidv7(),
          roleId: narrowRoleId,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        })
        .expect(404);
    });

    it('refuses a role that does not exist', async () => {
      const userId = await makeUser(orgA, 'h-norole');
      await api(adminToken)
        .grant({ userId, roleId: uuidv7(), scopeType: 'organization', scopeId: orgA.orgId })
        .expect(404);
    });

    it('a disabled actor cannot administer assignments at all', async () => {
      const email = `h-actor-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const [user] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      await h.admin.insert(schema.userRoles).values({
        userId: user!.id,
        roleId: orgA.roleId,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      });

      try {
        const token = await tokenFor(email);
        await api(token).list().expect(200); // positive control

        await h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, user!.id));

        const res = await api(token).list();
        expect([401, 403]).toContain(res.status);
      } finally {
        await destroyUser(h.admin, user!.id);
      }
    });
  });

  // ===========================================================================
  describe('I. API-key binding scope', () => {
    /** Issues a key bound to the organization, carrying `scopes`. */
    async function issueKey(scopes: string[]): Promise<{ credential: string; prefix: string }> {
      const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
      const secret = uuidv7();
      await h.admin.insert(schema.apiKeys).values({
        orgId: orgA.orgId,
        name: 'assignment-key',
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: orgA.userId,
        scopes,
      });
      return { credential: `${prefix}.${secret}`, prefix };
    }

    it('a key without role-assignment scopes cannot list, read, grant or revoke', async () => {
      const key = await issueKey([PERMISSIONS.WORKSPACES_READ]);
      try {
        const userId = await makeUser(orgA, 'i-key');
        // Built one at a time: constructing every supertest request up front
        // starts them all against the same ephemeral server and makes the sweep
        // flaky rather than adversarial.
        const calls: (() => Promise<{ status: number }>)[] = [
          () => api(key.credential).list(),
          () => api(key.credential).get(uuidv7()),
          () =>
            api(key.credential).grant({
              userId,
              roleId: narrowRoleId,
              scopeType: 'organization',
              scopeId: orgA.orgId,
            }),
          () => api(key.credential).revoke(uuidv7()),
        ];
        for (const call of calls) {
          const res = await call();
          expect([401, 403, 404]).toContain(res.status);
        }
      } finally {
        await purgeAudit(h.admin, sql`true`);
        await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${key.prefix}`);
      }
    });

    it('a key cannot exceed its binding scope through its creator’s wider authority', async () => {
      // The creator is Organization A's admin and holds grant authority at the
      // organization. The key requests it too — but a key's effective
      // permissions are the intersection taken at the key's *binding* scope,
      // and the binding here is the organization, so the key can never reach
      // beyond Organization A whatever its creator holds elsewhere.
      // `workspaces.read` is included because that is what `narrow_grantable`
      // carries: without it the key is refused by the composition guard, which
      // would pass this test for the wrong reason and never exercise the
      // binding at all.
      const key = await issueKey([
        PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
        PERMISSIONS.ROLE_ASSIGNMENTS_READ,
        PERMISSIONS.WORKSPACES_READ,
      ]);
      try {
        const userId = await makeUser(orgA, 'i-bound');

        // Within the binding: permitted.
        await api(key.credential)
          .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
          .expect(201);

        // Outside it: refused, with no confirmation the target exists.
        const outside = await api(key.credential).grant({
          userId,
          roleId: narrowRoleId,
          scopeType: 'organization',
          scopeId: orgB.orgId,
        });
        expect([403, 404]).toContain(outside.status);
      } finally {
        await purgeAudit(h.admin, sql`true`);
        await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${key.prefix}`);
      }
    });
  });

  // ===========================================================================
  describe('J. RLS backstop, with service authorization bypassed', () => {
    it('cross-organization assignment reads return zero rows', async () => {
      const other = await tokenFor(orgB.email);
      const userId = await makeUser(orgB, 'j-read');
      const bRole = await makeRole(orgB, 'j_role', ['organization'], [PERMISSIONS.WORKSPACES_READ]);
      await api(other)
        .grant({ userId, roleId: bRole, scopeType: 'organization', scopeId: orgB.orgId })
        .expect(201);

      const rows = await db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
        tx.select().from(schema.userRoles).where(eq(schema.userRoles.orgId, orgB.orgId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('a cross-organization insert is refused', async () => {
      const userId = await makeUser(orgA, 'j-insert');
      await expectDbRefusal(
        db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
          tx.insert(schema.userRoles).values({
            userId,
            roleId: narrowRoleId,
            scopeType: 'organization',
            scopeId: orgB.orgId,
          }),
        ),
        /cross-tenant grant refused|row-level security|violates/i,
      );
    });

    it('a cross-organization delete removes nothing', async () => {
      const other = await tokenFor(orgB.email);
      const userId = await makeUser(orgB, 'j-delete');
      const bRole = await makeRole(
        orgB,
        'j_del_role',
        ['organization'],
        [PERMISSIONS.WORKSPACES_READ],
      );
      const created = await api(other)
        .grant({ userId, roleId: bRole, scopeType: 'organization', scopeId: orgB.orgId })
        .expect(201);
      const id = (created.body.data as AssignmentBody).id;

      await db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
        tx.delete(schema.userRoles).where(eq(schema.userRoles.id, id)),
      );

      const [still] = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.id, id));
      expect(still).toBeDefined();
    });

    it('cross-reseller isolation holds at the database', async () => {
      const rows = await db.withTenant({ orgId: orgA.orgId, resellerId: orgA.resellerId }, (tx) =>
        tx.select().from(schema.userRoles).where(eq(schema.userRoles.scopeId, orgB.resellerId)),
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ===========================================================================
  describe('K. audit', () => {
    it('a successful grant writes user_role.granted at the grant’s scope', async () => {
      const userId = await makeUser(orgA, 'k-grant');
      const created = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'workspace', scopeId: orgA.workspaceId })
        .expect(201);

      const rows = await auditRows('user_role.granted');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scope_type).toBe('workspace');
      expect(rows[0]!.scope_id).toBe(orgA.workspaceId);
      expect(rows[0]!.actor_user_id).toBe(orgA.userId);
      expect(rows[0]!.resource_id).toBe((created.body.data as AssignmentBody).id);
      expect(rows[0]!.outcome).toBe('success');
    });

    it('a successful revocation writes user_role.revoked', async () => {
      const userId = await makeUser(orgA, 'k-revoke');
      const created = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(201);
      await purgeAudit(h.admin, sql`true`);

      await api(adminToken)
        .revoke((created.body.data as AssignmentBody).id)
        .expect(204);
      const rows = await auditRows('user_role.revoked');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_user_id).toBe(orgA.userId);
    });

    it('a refused grant writes authorization.denied with the actor’s own scope', async () => {
      const wsRoleId = await makeRole(
        orgA,
        'ws_denied',
        ['workspace'],
        [PERMISSIONS.ROLE_ASSIGNMENTS_READ],
      );
      await h.admin.insert(schema.userRoles).values({
        userId: workspaceUser.userId,
        roleId: wsRoleId,
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });

      try {
        const token = await tokenFor(workspaceUser.email);
        await purgeAudit(h.admin, sql`true`);
        const userId = await makeUser(orgA, 'k-denied');

        await api(token)
          .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
          .expect(403);

        const rows = await auditRows('authorization.denied');
        expect(rows.length).toBeGreaterThanOrEqual(1);
        // The actor is pinned to a workspace: the row says workspace, never the
        // organization it reached for (Phase 1B.5.3, ADR-005 D-6).
        expect(rows[0]!.scope_type).toBe('workspace');
        expect(rows[0]!.scope_id).toBe(orgA.workspaceId);
        expect(rows[0]!.actor_user_id).toBe(workspaceUser.userId);
      } finally {
        await h.admin.execute(sql`DELETE FROM user_roles WHERE role_id = ${wsRoleId}`);
      }
    });

    it('nothing is granted when the audit write fails — fail closed', async () => {
      const audit = h.app.get((await import('../src/audit/audit-writer.service')).AuditWriter) as {
        record: (...args: unknown[]) => Promise<void>;
      };
      const userId = await makeUser(orgA, 'k-failclosed');
      const spy = jest.spyOn(audit, 'record').mockRejectedValue(new Error('audit unavailable'));

      try {
        const res = await api(adminToken).grant({
          userId,
          roleId: narrowRoleId,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
      } finally {
        spy.mockRestore();
      }

      // The grant rolled back with its record.
      const rows = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.roleId, narrowRoleId)));
      expect(rows).toHaveLength(0);
    });
  });

  // ===========================================================================
  describe('L. concurrency', () => {
    it('two identical concurrent grants produce exactly one assignment', async () => {
      const userId = await makeUser(orgA, 'l-dup');
      const body = {
        userId,
        roleId: narrowRoleId,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      };

      const [a, b] = await Promise.all([api(adminToken).grant(body), api(adminToken).grant(body)]);
      const statuses = [a.status, b.status].sort();
      // Exactly one winner. The unique index decides it, not ordering.
      expect(statuses).toEqual([201, 409]);

      const rows = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.roleId, narrowRoleId)));
      expect(rows).toHaveLength(1);
    });

    it('a grant racing its role’s deletion cannot leave an orphan', async () => {
      const roleId = await makeRole(
        orgA,
        'l_race_role',
        ['organization'],
        [PERMISSIONS.WORKSPACES_READ],
      );
      const userId = await makeUser(orgA, 'l-race');

      const grant = api(adminToken)
        .grant({ userId, roleId, scopeType: 'organization', scopeId: orgA.orgId })
        .then((res) => res.status);
      const remove = h.admin
        .delete(schema.roles)
        .where(eq(schema.roles.id, roleId))
        .then(
          () => 'deleted' as const,
          () => 'refused' as const,
        );

      const [grantStatus, removeOutcome] = await Promise.all([grant, remove]);

      // Whatever the interleaving, the database is coherent: no grant survives
      // whose role is gone. `ON DELETE RESTRICT` plus the FK's row lock is what
      // makes that true, not the ordering of the two requests.
      const { rows } = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM user_roles ur
              LEFT JOIN roles r ON r.id = ur.role_id WHERE r.id IS NULL`,
      );
      expect(Number(rows[0]!.count)).toBe(0);
      expect([201, 404, 409, 500]).toContain(grantStatus);
      expect(['deleted', 'refused']).toContain(removeOutcome);
    });

    it('two concurrent revocations of one assignment yield one 204 and one 404', async () => {
      const userId = await makeUser(orgA, 'l-revoke');
      const created = await api(adminToken)
        .grant({ userId, roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId })
        .expect(201);
      const id = (created.body.data as AssignmentBody).id;

      const [a, b] = await Promise.all([api(adminToken).revoke(id), api(adminToken).revoke(id)]);
      expect([a.status, b.status].sort()).toEqual([204, 404]);
    });

    it('concurrent escalation attempts do not combine into an unheld grant', async () => {
      // Two simultaneous attempts to grant a role the actor cannot confer.
      const wideRoleId = await makeRole(
        orgA,
        'l_wide',
        ['organization'],
        [PERMISSIONS.API_KEYS_CREATE],
      );
      const userId = await makeUser(orgA, 'l-esc');
      const body = { userId, roleId: wideRoleId, scopeType: 'organization', scopeId: orgA.orgId };

      const results = await Promise.all([api(adminToken).grant(body), api(adminToken).grant(body)]);
      expect(results.every((r) => r.status === 403)).toBe(true);

      const rows = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.roleId, wideRoleId));
      expect(rows).toHaveLength(0);
    });
  });
});
