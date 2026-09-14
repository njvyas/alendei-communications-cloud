/**
 * `AuthorizationService` — the reusable authorization boundary
 * (Phase 1B.5.2, ADR-005 D-1/D-5).
 *
 * The boundary composes three things that used to be assembled per handler:
 * the target's authoritative ancestry, the coherent-grant decision, and the
 * `404`-not-`403` refusal for a target that does not resolve. These tests drive
 * the real service against real rows through the real tenant transaction.
 *
 * The central property — and the reason this increment exists — is that a
 * principal's *claims about ancestry* are worth nothing. A grant naming
 * Organization B cannot reach a workspace whose real parent is Organization A,
 * because the parent is read from `workspaces.org_id` and there is no argument
 * through which a caller could say otherwise.
 *
 * Tenant context and authority are deliberately varied independently here. A
 * platform tenant context is used in the forgery cases so the target row is
 * *visible*, which isolates the question being tested: not "can this principal
 * see the row" (RLS answers that) but "does the row's true ancestry decide the
 * outcome" (the resolver and evaluator answer that).
 */
import { PERMISSIONS, type AuthPrincipal, type RoleGrant, type ScopeType } from '@acc/contracts';
import { schema, type TenantSession } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AuthorizationService } from '../src/auth/authorization.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { CredentialService } from '../src/iam/credential.service';
import { AppException } from '../src/common/errors/app.exception';
import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  destroyUser,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const READ = PERMISSIONS.WORKSPACES_READ;
const url = (p: string) => `/${PREFIX}${p}`;

describe('AuthorizationService', () => {
  let h: Harness;
  let authz: AuthorizationService;
  let db: TenantDatabase;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let workspaceTwoId: string;
  let resellerUser: { userId: string; email: string };

  beforeAll(async () => {
    h = await startHarness();
    authz = h.app.get(AuthorizationService);
    db = h.app.get(TenantDatabase);
    const credentials = h.app.get(CredentialService);
    // Two tenants under two different resellers — `createTenant` gives each its
    // own, which is what makes the cross-reseller cases meaningful.
    orgA = await createTenant(h.admin, 'authz-a', credentials);
    orgB = await createTenant(h.admin, 'authz-b', credentials);

    const [second] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: orgA.orgId, name: 'Second', slug: 'second' })
      .returning({ id: schema.workspaces.id });
    workspaceTwoId = second!.id;

    // A real, loggable principal whose only grant is at reseller scope over
    // Organization A's reseller.
    resellerUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'organization',
      orgA.orgId,
      'authz-reseller',
    );
    await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${resellerUser.userId}`);
    const [resellerRole] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, 'reseller_admin'));
    // The scope trigger admits a platform-level role only for a platform admin;
    // the GUC is transaction-local, so it must share the insert's transaction.
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId: resellerUser.userId,
        roleId: resellerRole!.id,
        scopeType: 'reseller',
        scopeId: orgA.resellerId,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await destroyUser(h.admin, resellerUser.userId);
    await h.admin.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceTwoId}`);
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  // --- fixtures -------------------------------------------------------------

  const grant = (
    scopeType: ScopeType,
    scopeId: string | null,
    orgId: string | null,
    permissions: readonly string[] = [READ],
  ): RoleGrant => ({
    roleId: `role-${scopeType}-${scopeId ?? 'platform'}`,
    roleKey: scopeType,
    scopeType,
    scopeId,
    orgId,
    permissions,
  });

  const principalOf = (roles: RoleGrant[]): AuthPrincipal => ({
    actorType: 'user',
    userId: 'u1',
    apiKeyId: null,
    sessionId: 's1',
    tenant: { orgId: orgA.orgId, workspaceId: null, resellerId: null, isPlatformAdmin: false },
    roles,
    permissions: [...new Set(roles.flatMap((r) => r.permissions))],
  });

  /** Tenant context that can see everything, so visibility is not the variable. */
  const SEES_ALL: TenantSession = { isPlatformAdmin: true };
  const sessionFor = (t: TenantFixture): TenantSession => ({
    orgId: t.orgId,
    resellerId: t.resellerId,
  });

  const allows = (
    session: TenantSession,
    principal: AuthPrincipal,
    scopeType: ScopeType,
    scopeId: string | null,
    permission: string = READ,
  ): Promise<boolean> =>
    db.withTenant(session, (tx) =>
      authz.allows(tx, { principal, permission, target: { scopeType, scopeId } }),
    );

  /** The thrown status, so `403` and `404` can be told apart. */
  const statusOf = async (
    session: TenantSession,
    principal: AuthPrincipal,
    scopeType: ScopeType,
    scopeId: string | null,
  ): Promise<number | 'allowed'> => {
    try {
      await db.withTenant(session, (tx) =>
        authz.assert(tx, {
          principal,
          permission: READ,
          target: { scopeType, scopeId },
          resourceType: 'Workspace',
        }),
      );
      return 'allowed';
    } catch (error) {
      return (error as AppException).getStatus();
    }
  };

  // ---------------------------------------------------------------------------
  describe('1-2. a grant authorizes its own scope and its descendants', () => {
    it('1. an organization grant authorizes its organization', async () => {
      const p = principalOf([grant('organization', orgA.orgId, orgA.orgId)]);
      expect(await allows(sessionFor(orgA), p, 'organization', orgA.orgId)).toBe(true);
    });

    it('2. an organization grant authorizes a descendant workspace and team', async () => {
      const p = principalOf([grant('organization', orgA.orgId, orgA.orgId)]);
      expect(await allows(sessionFor(orgA), p, 'workspace', orgA.workspaceId)).toBe(true);
      expect(await allows(sessionFor(orgA), p, 'team', orgA.teamId)).toBe(true);
    });

    it('a workspace grant authorizes its own workspace and its teams', async () => {
      const p = principalOf([grant('workspace', orgA.workspaceId, orgA.orgId)]);
      expect(await allows(sessionFor(orgA), p, 'workspace', orgA.workspaceId)).toBe(true);
      expect(await allows(sessionFor(orgA), p, 'team', orgA.teamId)).toBe(true);
    });

    it('but a workspace grant does not reach the organization above it', async () => {
      const p = principalOf([grant('workspace', orgA.workspaceId, orgA.orgId)]);
      expect(await allows(sessionFor(orgA), p, 'organization', orgA.orgId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('3-4. horizontal isolation below the organization', () => {
    it('3. a workspace grant cannot authorize a sibling workspace', async () => {
      // RLS carries no workspace term (`TENANCY.md` §3a), so this boundary is
      // the authorization layer's alone — and the sibling is fully visible.
      const p = principalOf([grant('workspace', orgA.workspaceId, orgA.orgId)]);
      expect(await allows(sessionFor(orgA), p, 'workspace', workspaceTwoId)).toBe(false);
      expect(await statusOf(sessionFor(orgA), p, 'workspace', workspaceTwoId)).toBe(403);
    });

    it('4. a workspace grant cannot authorize a workspace in another organization', async () => {
      const p = principalOf([grant('workspace', orgA.workspaceId, orgA.orgId)]);
      // Under its own context the foreign row is invisible, so this is a 404 —
      // the response must not confirm the workspace exists elsewhere.
      expect(await statusOf(sessionFor(orgA), p, 'workspace', orgB.workspaceId)).toBe(404);
      // And even where it *is* visible, the decision is still deny.
      expect(await allows(SEES_ALL, p, 'workspace', orgB.workspaceId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('5-6. reseller scope', () => {
    it('5. a reseller grant authorizes an organization beneath that reseller', async () => {
      const p = principalOf([grant('reseller', orgA.resellerId, null)]);
      expect(await allows(sessionFor(orgA), p, 'organization', orgA.orgId)).toBe(true);
      expect(await allows(sessionFor(orgA), p, 'workspace', orgA.workspaceId)).toBe(true);
    });

    it('6. a reseller grant cannot authorize another reseller’s organization', async () => {
      const p = principalOf([grant('reseller', orgA.resellerId, null)]);
      expect(await allows(SEES_ALL, p, 'organization', orgB.orgId)).toBe(false);
      expect(await allows(SEES_ALL, p, 'workspace', orgB.workspaceId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('7-8. forged ancestry has no influence — the DB-derived chain wins', () => {
    /**
     * The attack in ADR-005 D-5, stated as the strong property rather than the
     * weak one. It is not enough that malformed input is rejected: what must
     * hold is that the *authoritative* chain decides, whatever the caller
     * asserts. The tenant context here can see every row, so the only thing
     * deciding the outcome is the ancestry the resolver reads.
     *
     * Real database:   reseller-A → org-A → workspace-A
     * Claimed by actor: org-B, reseller-B
     */
    it('7. a grant naming another organization cannot reach this workspace', async () => {
      const claimsOrgB = principalOf([grant('organization', orgB.orgId, orgB.orgId)]);
      // The grant is real, carries the permission, and is at the right *level*.
      // It fails only because workspace-A's true parent is org-A.
      expect(await allows(SEES_ALL, claimsOrgB, 'workspace', orgA.workspaceId)).toBe(false);
      expect(await allows(SEES_ALL, claimsOrgB, 'team', orgA.teamId)).toBe(false);
      // Positive control: the same grant does reach its own organization's rows.
      expect(await allows(SEES_ALL, claimsOrgB, 'workspace', orgB.workspaceId)).toBe(true);
    });

    it('8. a grant naming another reseller cannot reach this organization', async () => {
      const claimsResellerB = principalOf([grant('reseller', orgB.resellerId, null)]);
      expect(await allows(SEES_ALL, claimsResellerB, 'organization', orgA.orgId)).toBe(false);
      expect(await allows(SEES_ALL, claimsResellerB, 'workspace', orgA.workspaceId)).toBe(false);
      // Positive control on its own reseller's organization.
      expect(await allows(SEES_ALL, claimsResellerB, 'organization', orgB.orgId)).toBe(true);
    });

    it('a grant naming another workspace as the parent cannot reach this team', async () => {
      const claimsOtherWorkspace = principalOf([grant('workspace', workspaceTwoId, orgA.orgId)]);
      // team-A's real parent is workspace-A, not workspace-two.
      expect(await allows(SEES_ALL, claimsOtherWorkspace, 'team', orgA.teamId)).toBe(false);
    });

    it('the decision follows the row, not the claim, at every level at once', async () => {
      // A principal holding grants that between them name org-B, reseller-B and
      // workspace-two — a wholly false chain for team-A — still reaches nothing
      // of Organization A's.
      const wholesaleForgery = principalOf([
        grant('organization', orgB.orgId, orgB.orgId),
        grant('reseller', orgB.resellerId, null),
        grant('workspace', workspaceTwoId, orgA.orgId),
      ]);
      expect(await allows(SEES_ALL, wholesaleForgery, 'team', orgA.teamId)).toBe(false);
      expect(await allows(SEES_ALL, wholesaleForgery, 'workspace', orgA.workspaceId)).toBe(false);
      expect(await allows(SEES_ALL, wholesaleForgery, 'organization', orgA.orgId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('9-10. the 1B.5.1 coherent-grant invariant still holds through the service', () => {
    it('9. permission from one grant and scope from another still does not authorize', async () => {
      // read_only-shaped grant at the organization (no admin permission) plus a
      // manager-shaped grant at one workspace (has it, wrong scope).
      const crossProduct = principalOf([
        grant('organization', orgA.orgId, orgA.orgId, [READ]),
        grant('workspace', orgA.workspaceId, orgA.orgId, [PERMISSIONS.ROLE_ASSIGNMENTS_GRANT]),
      ]);
      expect(
        await allows(
          sessionFor(orgA),
          crossProduct,
          'organization',
          orgA.orgId,
          PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
        ),
      ).toBe(false);
    });

    it('10. a coherent grant still authorizes through the service', async () => {
      const coherent = principalOf([
        grant('organization', orgA.orgId, orgA.orgId, [PERMISSIONS.ROLE_ASSIGNMENTS_GRANT]),
      ]);
      expect(
        await allows(
          sessionFor(orgA),
          coherent,
          'organization',
          orgA.orgId,
          PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
        ),
      ).toBe(true);
    });

    it('a platform grant covers every level, but only for permissions it carries', async () => {
      const platform = principalOf([grant('platform', null, null, [READ])]);
      expect(await allows(SEES_ALL, platform, 'organization', orgA.orgId)).toBe(true);
      expect(await allows(SEES_ALL, platform, 'team', orgA.teamId)).toBe(true);
      expect(await allows(SEES_ALL, platform, 'team', orgA.teamId, PERMISSIONS.ROLES_DELETE)).toBe(
        false,
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('unresolvable targets are 404, never 403', () => {
    it('refuses a nonexistent target without confirming anything', async () => {
      const p = principalOf([grant('organization', orgA.orgId, orgA.orgId)]);
      expect(await statusOf(sessionFor(orgA), p, 'workspace', uuidv7())).toBe(404);
    });

    it('returns the same 404 for another tenant’s target as for one that does not exist', async () => {
      // The two must be indistinguishable, or the endpoint is an existence
      // oracle (`API.md` §3a).
      const p = principalOf([grant('organization', orgA.orgId, orgA.orgId)]);
      const unknown = await statusOf(sessionFor(orgA), p, 'workspace', uuidv7());
      const foreign = await statusOf(sessionFor(orgA), p, 'workspace', orgB.workspaceId);
      expect(unknown).toBe(foreign);
      expect(foreign).toBe(404);
    });

    it('never echoes the target identifier in the message', async () => {
      const p = principalOf([grant('organization', orgA.orgId, orgA.orgId)]);
      let thrown: unknown;
      try {
        await db.withTenant(sessionFor(orgA), (tx) =>
          authz.assert(tx, {
            principal: p,
            permission: READ,
            target: { scopeType: 'workspace', scopeId: orgB.workspaceId },
            resourceType: 'Workspace',
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).toBe('Workspace not found');
      expect((thrown as Error).message).not.toContain(orgB.workspaceId);
    });

    it('the non-throwing form denies an unresolvable target rather than allowing it', async () => {
      const platform = principalOf([grant('platform', null, null, [READ])]);
      // Even a platform grant, which covers every target, is denied one that
      // does not resolve — fail closed.
      expect(await allows(SEES_ALL, platform, 'workspace', uuidv7())).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('behaviour change: a reseller principal now reaches its organizations', () => {
    /**
     * **This is a deliberate widening, recorded rather than slipped in.**
     *
     * Before 1B.5.2 the controller synthesized `chain: { orgId }`, omitting the
     * reseller term — so `scopeCovers({reseller, R}, {organization, org}, chain)`
     * compared `undefined === R` and a reseller-scoped principal was refused at
     * an endpoint that tenant selection and RLS had both already admitted it to.
     * That was fail-closed, untested, and contradicted `TENANCY.md` §1a.4.
     *
     * With the chain resolved from the database the reseller term is present and
     * the documented model holds. Both directions are asserted, because a
     * widening is only safe if its boundary is proven at the same time.
     */
    const tokenFor = async (email: string): Promise<string> => {
      const res = await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email, password: PASSWORD })
        .expect(200);
      return (res.body as { accessToken: string }).accessToken;
    };

    beforeEach(() => h.clearRateLimits());

    it('reaches the organizations beneath its own reseller', async () => {
      const token = await tokenFor(resellerUser.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.workspaces.map((w: { id: string }) => w.id)).toContain(orgA.workspaceId);
    });

    it('cannot select another reseller’s organization', async () => {
      // The boundary on the widening: Organization B is beneath a different
      // reseller, so it is not in this principal's authorized set at all and
      // the selector is refused before any target is considered.
      const token = await tokenFor(resellerUser.email);
      await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .set('x-acc-organization', orgB.orgId)
        .expect(403);
    });

    it('never sees another reseller’s workspaces in the listing', async () => {
      const token = await tokenFor(resellerUser.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.workspaces.map((w: { id: string }) => w.id)).not.toContain(orgB.workspaceId);
    });
  });
});
