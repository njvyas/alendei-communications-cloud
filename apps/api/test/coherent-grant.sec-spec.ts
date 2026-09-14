/**
 * Coherent-grant authorization over real HTTP (Phase 1B.5.1, ADR-005 D-1).
 *
 * The evaluator's unit suite proves the algebra. This proves the same thing
 * through the whole request path — `AuthGuard` → `ScopeResolver` →
 * `PermissionEvaluator` → the real `/tenants/workspaces` endpoint — because the
 * defect was only ever reachable by a real principal with real grants, and a
 * unit test cannot show that the resolver actually carries permission provenance
 * as far as the decision.
 *
 * The attack uses the production endpoint unchanged. `listWorkspaces` requires
 * `workspaces.read` at **organization** scope, so a principal whose only
 * organization-scoped grant lacks that permission must be refused, no matter
 * what its other grants carry. Before this increment the same request returned
 * `200`.
 */
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

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

describe('coherent-grant authorization over HTTP', () => {
  let h: Harness;
  let orgA: TenantFixture;
  let credentials: CredentialService;

  /** An organization-scoped role in Organization A carrying no permissions. */
  let narrowRoleId: string;
  /** Holds narrowRole at the organization and org_admin at one workspace. */
  let crossUser: { userId: string; email: string };

  const tokenFor = async (email: string): Promise<string> => {
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const listWorkspaces = (token: string) =>
    request(h.app.getHttpServer())
      .get(url('/tenants/workspaces'))
      .set('authorization', `Bearer ${token}`);

  /** Attaches or detaches `workspaces.read` on the narrow organization role. */
  const setNarrowRolePermission = async (held: boolean): Promise<void> => {
    const [permission] = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, PERMISSIONS.WORKSPACES_READ));
    if (held) {
      await h.admin
        .insert(schema.rolePermissions)
        .values({ roleId: narrowRoleId, permissionId: permission!.id })
        .onConflictDoNothing();
    } else {
      await h.admin.execute(
        sql`DELETE FROM role_permissions WHERE role_id = ${narrowRoleId} AND permission_id = ${permission!.id}`,
      );
    }
  };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'coh-a', credentials);

    const [narrow] = await h.admin
      .insert(schema.roles)
      .values({ orgId: orgA.orgId, key: 'narrow_role', name: 'Narrow', isSystemRole: false })
      .returning({ id: schema.roles.id });
    narrowRoleId = narrow!.id;

    // org_admin (which carries workspaces.read) at the *workspace*...
    crossUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'coh-cross',
    );
    // ...and the permissionless role at the *organization*. Between them the
    // principal holds workspaces.read somewhere and covers the organization
    // somewhere — never in the same grant.
    await h.admin.insert(schema.userRoles).values({
      userId: crossUser.userId,
      roleId: narrowRoleId,
      scopeType: 'organization',
      scopeId: orgA.orgId,
    });
  }, 60_000);

  afterAll(async () => {
    await destroyUser(h.admin, crossUser.userId);
    await h.admin.execute(sql`DELETE FROM role_permissions WHERE role_id = ${narrowRoleId}`);
    await h.admin.execute(sql`DELETE FROM roles WHERE id = ${narrowRoleId}`);
    await destroyTenant(h.admin, orgA);
    await h.close();
  }, 60_000);

  afterEach(() => purgeAudit(h.admin, sql`true`));
  beforeEach(() => h.clearRateLimits());

  // ---------------------------------------------------------------------------
  it('refuses the cross-product principal on the real endpoint', async () => {
    const token = await tokenFor(crossUser.email);

    // The principal genuinely holds the permission and genuinely covers the
    // target — just never together. This returned 200 before ADR-005 D-1.
    const me = await request(h.app.getHttpServer())
      .get(url('/auth/me'))
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.permissions).toContain(PERMISSIONS.WORKSPACES_READ);
    expect(me.body.roles.map((r: { scopeType: string }) => r.scopeType).sort()).toEqual([
      'organization',
      'workspace',
    ]);

    const res = await listWorkspaces(token).expect(403);
    expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    // A refusal, not an empty listing — the two must stay distinguishable.
    expect(res.body).not.toHaveProperty('workspaces');
  });

  it('allows the ordinary organization-scoped principal on the same endpoint', async () => {
    // The positive control: the endpoint works, so the 403 above is an
    // authorization decision rather than a broken route.
    const token = await tokenFor(orgA.email);
    const res = await listWorkspaces(token).expect(200);
    expect(res.body.workspaces.map((w: { id: string }) => w.id)).toContain(orgA.workspaceId);
  });

  it('allows the same principal once one grant carries both halves', async () => {
    // Give the organization-scoped role the permission it lacked. Now a single
    // coherent grant exists, and the same request succeeds — proving the
    // refusal above was about coherence and not about the principal.
    await setNarrowRolePermission(true);
    try {
      const token = await tokenFor(crossUser.email);
      const res = await listWorkspaces(token).expect(200);
      expect(res.body.workspaces.map((w: { id: string }) => w.id)).toContain(orgA.workspaceId);
    } finally {
      await setNarrowRolePermission(false);
    }
  });

  it('refuses again on the next request once the permission is removed', async () => {
    // Authorization is re-derived per request from current database state
    // (ADR-003 D-3), so withdrawing the permission takes effect immediately
    // rather than at token expiry. This is the grant/role lifecycle case the
    // schema actually models: absence, not a flag.
    await setNarrowRolePermission(true);
    const token = await tokenFor(crossUser.email);
    await listWorkspaces(token).expect(200);

    await setNarrowRolePermission(false);
    // Same token, no re-login — the decision is re-derived, not cached.
    const res = await listWorkspaces(token).expect(403);
    expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
  });

  it('refuses once the coherent grant itself is revoked', async () => {
    await setNarrowRolePermission(true);
    const token = await tokenFor(crossUser.email);
    await listWorkspaces(token).expect(200);

    // A revoked grant is a deleted row — the schema models no revocation flag,
    // and absence is the whole mechanism.
    await h.admin.execute(
      sql`DELETE FROM user_roles WHERE user_id = ${crossUser.userId} AND role_id = ${narrowRoleId}`,
    );
    try {
      const res = await listWorkspaces(token).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    } finally {
      await h.admin.insert(schema.userRoles).values({
        userId: crossUser.userId,
        roleId: narrowRoleId,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      });
      await setNarrowRolePermission(false);
    }
  });
});
