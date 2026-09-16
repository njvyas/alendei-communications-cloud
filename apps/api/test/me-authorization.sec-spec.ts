/**
 * `GET /auth/me/authorization` — the self-only authorization view
 * (Phase 1B.5.7, `API.md` §3c, `DECISIONS.md` D23).
 *
 * Two properties carry the weight, and each is a way the endpoint could quietly
 * become something it must not be:
 *
 *   1. **Self-only, structurally.** There is nowhere to name another user — no
 *      path segment, no query parameter, no body. A cross-user variant would be
 *      an enumeration surface with no Phase 1B consumer, so the way to not build
 *      one is to leave nowhere to put the identifier. The negative cases below
 *      try anyway.
 *
 *   2. **Grants stay grants.** The response must not flatten permissions into a
 *      union, because a console rendering from a union reinvents client-side
 *      exactly the defect ADR-005 removed from the backend. Case 22b is the
 *      discriminator: an actor holding `teams.create` in one workspace and
 *      `role_assignments.grant` across the organization must be able to tell,
 *      from this response alone, that it cannot confer `teams.create` at the
 *      organization.
 *
 * And for an API key, the grants are the key's *effective* authority — the
 * Phase 1B.5.1 binding-scope intersection, not its creator's wider reach.
 */
import { PERMISSIONS, PLATFORM_ROLE_KEYS, type ScopeType } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
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

interface GrantView {
  roleId: string;
  roleKey: string;
  scopeType: ScopeType;
  scopeId: string | null;
  orgId: string | null;
  permissions: string[];
}

interface AuthorizationBody {
  actorType: string;
  userId: string | null;
  apiKeyId: string | null;
  grants: GrantView[];
  organizationIds: string[];
  isPlatformAdmin: boolean;
}

describe('GET /auth/me/authorization', () => {
  let h: Harness;
  let credentials: CredentialService;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let workspaceUser: { userId: string; email: string };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'meauthz-a', credentials);
    orgB = await createTenant(h.admin, 'meauthz-b', credentials);
    workspaceUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'meauthz-ws',
    );
  }, 90_000);

  afterAll(async () => {
    await destroyUser(h.admin, workspaceUser.userId);
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(() => purgeAudit(h.admin, sql`true`));

  // --- fixtures --------------------------------------------------------------

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  const get = (credential: string, path = '/auth/me/authorization') =>
    request(h.app.getHttpServer()).get(url(path)).set('authorization', `Bearer ${credential}`);

  async function makeRole(
    tenant: TenantFixture,
    key: string,
    allowedScopeTypes: ScopeType[],
    permissions: readonly string[],
  ): Promise<string> {
    const [role] = await h.admin
      .insert(schema.roles)
      .values({ orgId: tenant.orgId, key, name: key, isSystemRole: false, allowedScopeTypes })
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

  // ===========================================================================
  describe('A. shape and self-only', () => {
    it('returns the caller’s own grants, as grants', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get(token).expect(200);
      const body = res.body.data as AuthorizationBody;

      expect(body.actorType).toBe('user');
      expect(body.userId).toBe(orgA.userId);
      expect(body.apiKeyId).toBeNull();
      expect(body.grants.length).toBeGreaterThan(0);
      for (const grant of body.grants) {
        expect(grant.scopeType).toBeDefined();
        expect(Array.isArray(grant.permissions)).toBe(true);
      }
      expect(body.organizationIds).toContain(orgA.orgId);
    });

    it('requires authentication', async () => {
      await request(h.app.getHttpServer()).get(url('/auth/me/authorization')).expect(401);
    });

    it('has nowhere to name another user — no path variant exists', async () => {
      const token = await tokenFor(orgA.email);
      // The route is a literal; a user id in the path matches no route at all.
      await get(token, `/auth/me/authorization/${workspaceUser.userId}`).expect(404);
      await get(token, `/auth/${workspaceUser.userId}/authorization`).expect(404);
    });

    it('ignores a forged user identifier in the query string', async () => {
      const token = await tokenFor(orgA.email);
      const forged = await get(
        token,
        `/auth/me/authorization?userId=${workspaceUser.userId}&user_id=${workspaceUser.userId}`,
      ).expect(200);

      // The subject is the principal, and the query changed nothing.
      expect((forged.body.data as AuthorizationBody).userId).toBe(orgA.userId);
      expect((forged.body.data as AuthorizationBody).userId).not.toBe(workspaceUser.userId);
    });

    it('ignores a forged identifier in the body', async () => {
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/auth/me/authorization'))
        .set('authorization', `Bearer ${token}`)
        .send({ userId: workspaceUser.userId })
        .expect(200);
      expect((res.body.data as AuthorizationBody).userId).toBe(orgA.userId);
    });

    it('two principals see only their own grants', async () => {
      const adminToken = await tokenFor(orgA.email);
      const wsToken = await tokenFor(workspaceUser.email);

      const asAdmin = (await get(adminToken).expect(200)).body.data as AuthorizationBody;
      const asWorkspace = (await get(wsToken).expect(200)).body.data as AuthorizationBody;

      expect(asAdmin.userId).toBe(orgA.userId);
      expect(asWorkspace.userId).toBe(workspaceUser.userId);
      expect(asWorkspace.grants.every((g) => g.scopeType === 'workspace')).toBe(true);
    });

    it('discloses no credential material', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get(token).expect(200);
      const serialized = JSON.stringify(res.body);
      for (const forbidden of [
        '$argon2',
        'passwordHash',
        'password',
        'secret',
        'refresh',
        'keyHash',
        'token',
        PASSWORD,
      ]) {
        expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });
  });

  // ===========================================================================
  describe('B. case 22b — grants are not flattened', () => {
    it('a permission held in one workspace is not reported at the organization', async () => {
      // The exact shape from §6n case 22b: the union would say `teams.create`,
      // and a console rendering from the union would offer an action the
      // backend refuses.
      const orgRoleId = await makeRole(
        orgA,
        'mz_org_granter',
        ['organization'],
        [PERMISSIONS.ROLE_ASSIGNMENTS_GRANT, PERMISSIONS.ROLE_ASSIGNMENTS_READ],
      );
      const wsRoleId = await makeRole(
        orgA,
        'mz_ws_teams',
        ['workspace'],
        [PERMISSIONS.TEAMS_CREATE],
      );

      const email = `mz22b-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const [user] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      await h.admin.insert(schema.userRoles).values([
        { userId: user!.id, roleId: orgRoleId, scopeType: 'organization', scopeId: orgA.orgId },
        { userId: user!.id, roleId: wsRoleId, scopeType: 'workspace', scopeId: orgA.workspaceId },
      ]);

      try {
        const token = await tokenFor(email);
        const body = (await get(token).expect(200)).body.data as AuthorizationBody;

        const orgGrant = body.grants.find((g) => g.scopeType === 'organization');
        const wsGrant = body.grants.find((g) => g.scopeType === 'workspace');
        expect(orgGrant).toBeDefined();
        expect(wsGrant).toBeDefined();

        // The discriminator: `teams.create` appears only under the workspace
        // grant, never under the organization one.
        expect(wsGrant!.permissions).toContain(PERMISSIONS.TEAMS_CREATE);
        expect(orgGrant!.permissions).not.toContain(PERMISSIONS.TEAMS_CREATE);
        expect(orgGrant!.permissions).toContain(PERMISSIONS.ROLE_ASSIGNMENTS_GRANT);

        // And the response carries no flattened union at all — a client cannot
        // reach for one even carelessly.
        expect(body).not.toHaveProperty('permissions');

        // The backend agrees with what the response implies: conferring
        // `teams.create` at the organization is refused.
        const conferred = await makeRole(
          orgA,
          'mz_conferred',
          ['organization', 'workspace'],
          [PERMISSIONS.TEAMS_CREATE],
        );
        const target = await createScopedUser(
          h.admin,
          orgA,
          credentials,
          'organization',
          orgA.orgId,
          'mz22b-target',
        );
        try {
          await request(h.app.getHttpServer())
            .post(url('/role-assignments'))
            .set('authorization', `Bearer ${token}`)
            .send({
              userId: target.userId,
              roleId: conferred,
              scopeType: 'organization',
              scopeId: orgA.orgId,
            })
            .expect(403);
        } finally {
          await destroyUser(h.admin, target.userId);
        }
      } finally {
        await destroyUser(h.admin, user!.id);
        await h.admin.execute(
          sql`DELETE FROM role_permissions WHERE role_id IN (${orgRoleId}, ${wsRoleId})`,
        );
        await h.admin.execute(sql`DELETE FROM roles WHERE id IN (${orgRoleId}, ${wsRoleId})`);
      }
    });

    it('every grant carries the scope its permissions are held at', async () => {
      const token = await tokenFor(workspaceUser.email);
      const body = (await get(token).expect(200)).body.data as AuthorizationBody;
      for (const grant of body.grants) {
        // Scope provenance is the whole value of the representation: a grant
        // without it is a union entry wearing a different shape.
        expect(grant).toHaveProperty('scopeType');
        expect(grant).toHaveProperty('scopeId');
        expect(grant).toHaveProperty('roleKey');
      }
    });
  });

  // ===========================================================================
  describe('C. API-key principals', () => {
    async function issueKey(scopes: string[]): Promise<{ credential: string; prefix: string }> {
      const prefix = `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`;
      const secret = uuidv7();
      await h.admin.insert(schema.apiKeys).values({
        orgId: orgA.orgId,
        name: 'meauthz-key',
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: orgA.userId,
        scopes,
      });
      return { credential: `${prefix}.${secret}`, prefix };
    }

    it('reports the key’s effective authority, not its creator’s', async () => {
      // The creator is an organization admin carrying far more than this.
      const key = await issueKey([PERMISSIONS.WORKSPACES_READ]);
      try {
        const body = (await get(key.credential).expect(200)).body.data as AuthorizationBody;

        expect(body.actorType).toBe('api_key');
        expect(body.userId).toBeNull();
        expect(body.apiKeyId).not.toBeNull();

        const everything = body.grants.flatMap((g) => g.permissions);
        expect(everything).toContain(PERMISSIONS.WORKSPACES_READ);
        // The creator holds these; the key was not granted them, so they must
        // not appear here any more than they take effect anywhere else.
        expect(everything).not.toContain(PERMISSIONS.ROLES_CREATE);
        expect(everything).not.toContain(PERMISSIONS.ROLE_ASSIGNMENTS_GRANT);
      } finally {
        await purgeAudit(h.admin, sql`true`);
        await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${key.prefix}`);
      }
    });

    it('a permission its creator holds only elsewhere never appears', async () => {
      // The binding-scope intersection made observable through this endpoint.
      // The creator is given `teams.create` at workspace two only; the key is
      // bound to the organization and *requests* `teams.create`. The
      // intersection is taken at the binding, so the key gets nothing — and if
      // the binding filter were removed, the creator's workspace-two authority
      // would widen into an organization-bound key and show up here.
      const [second] = await h.admin
        .insert(schema.workspaces)
        .values({ orgId: orgA.orgId, name: 'Second', slug: `second-${uuidv7().slice(-8)}` })
        .returning({ id: schema.workspaces.id });
      const elsewhereRoleId = await makeRole(
        orgA,
        `mz_elsewhere_${uuidv7().slice(-6)}`,
        ['workspace'],
        [PERMISSIONS.TEAMS_CREATE],
      );
      await h.admin.insert(schema.userRoles).values({
        userId: orgA.userId,
        roleId: elsewhereRoleId,
        scopeType: 'workspace',
        scopeId: second!.id,
      });

      const key = await issueKey([PERMISSIONS.TEAMS_CREATE, PERMISSIONS.WORKSPACES_READ]);
      try {
        const body = (await get(key.credential).expect(200)).body.data as AuthorizationBody;
        const everything = body.grants.flatMap((g) => g.permissions);

        // Requested, and held by the creator — but not at this key's binding.
        expect(everything).not.toContain(PERMISSIONS.TEAMS_CREATE);
        // The positive control, so an empty result cannot pass this vacuously.
        expect(everything).toContain(PERMISSIONS.WORKSPACES_READ);
      } finally {
        await purgeAudit(h.admin, sql`true`);
        await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${key.prefix}`);
        await h.admin.execute(sql`DELETE FROM user_roles WHERE role_id = ${elsewhereRoleId}`);
        await h.admin.execute(sql`DELETE FROM role_permissions WHERE role_id = ${elsewhereRoleId}`);
        await h.admin.execute(sql`DELETE FROM roles WHERE id = ${elsewhereRoleId}`);
        await h.admin.execute(sql`DELETE FROM workspaces WHERE id = ${second!.id}`);
      }
    });

    it('is bounded by the key’s binding scope', async () => {
      const key = await issueKey([PERMISSIONS.WORKSPACES_READ]);
      try {
        const body = (await get(key.credential).expect(200)).body.data as AuthorizationBody;
        // Bound to Organization A and nothing wider.
        expect(body.organizationIds).toEqual([orgA.orgId]);
        expect(body.organizationIds).not.toContain(orgB.orgId);
        expect(body.isPlatformAdmin).toBe(false);
      } finally {
        await purgeAudit(h.admin, sql`true`);
        await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${key.prefix}`);
      }
    });

    it('discloses no key material', async () => {
      const key = await issueKey([PERMISSIONS.WORKSPACES_READ]);
      try {
        const res = await get(key.credential).expect(200);
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain(key.prefix);
        expect(serialized).not.toContain('$argon2');
      } finally {
        await purgeAudit(h.admin, sql`true`);
        await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${key.prefix}`);
      }
    });
  });

  // ===========================================================================
  describe('D. tenant isolation', () => {
    it('never reports another organization’s grants', async () => {
      const token = await tokenFor(orgA.email);
      const body = (await get(token).expect(200)).body.data as AuthorizationBody;

      expect(body.organizationIds).not.toContain(orgB.orgId);
      for (const grant of body.grants) {
        if (grant.orgId !== null) expect(grant.orgId).toBe(orgA.orgId);
        if (grant.scopeType === 'organization') expect(grant.scopeId).toBe(orgA.orgId);
      }
    });

    it('a tenant principal is never reported as a platform admin', async () => {
      const token = await tokenFor(orgA.email);
      const body = (await get(token).expect(200)).body.data as AuthorizationBody;
      expect(body.isPlatformAdmin).toBe(false);
      expect(body.grants.every((g) => g.scopeType !== 'platform')).toBe(true);
      expect(body.grants.every((g) => g.roleKey !== PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN)).toBe(
        true,
      );
    });

    it('writes no authorization.denied row — it performs no target-scope check', async () => {
      const token = await tokenFor(orgA.email);
      await get(token).expect(200);
      const { rows } = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM audit_logs WHERE action = 'authorization.denied'`,
      );
      // The endpoint is `@AuthorizationExempt`: there is no target, so there is
      // nothing to deny and no audit noise to add.
      expect(Number(rows[0]!.count)).toBe(0);
    });
  });
});
