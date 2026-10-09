/**
 * The platform-role grant/revoke asymmetry (ADR-015 follow-up item 5;
 * `RBAC.md` §7, guard 2; `API.md` §3c).
 *
 *   A platform-level role (`roles.org_id IS NULL`: `alendei_super_admin`,
 *   `alendei_support`, `reseller_admin`, any custom platform role) can never be
 *   granted through `POST /role-assignments` — `platform` scope is not even
 *   representable, and `RoleAssignmentService` refuses a platform role at any
 *   other scope (`403 AUTHZ_PLATFORM_ROLE_REQUIRED`). An existing grant of one
 *   **can** be revoked through `DELETE /role-assignments/:id` by an authorized
 *   actor: it is judged by guard 4 like any other grant, under the liveness
 *   rules, and audited.
 *
 * Platform-scope grants are visible only to a validated platform
 * administrator (RLS `user_roles_tenant`), so every other principal gets `404`.
 * The last-administrator protections that still bind these revocations are
 * proven where they live: `platform-admin-liveness.sec-spec.ts` (the last
 * `alendei_super_admin`) and `reseller-admin-liveness.sec-spec.ts` (the last
 * `reseller_admin`, and peer revocation). The INSERT backstop for a
 * platform-scope grant without the platform-administrator claim is proven by
 * `bootstrap.int-spec.ts` (owner) and `packages/db/src/test/shared-reseller.int-spec.ts`
 * (`acc_app` with a forged claim); the DELETE backstop is proven here.
 */
import { AUDIT_ACTIONS, ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { TenantDatabase } from '../src/database/tenant-database.service';
import { purgeAudit, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, url, type Org, type Person } from './revocation-fixtures';

describe('platform-role grant/revoke asymmetry (ADR-015 follow-up item 5)', () => {
  let h: Harness;
  let w: RevocationWorld;
  let db: TenantDatabase;
  let org: Org;
  let superAdmin: Person;
  let superToken: string;

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    db = h.app.get(TenantDatabase);
    await w.init('asymmetry');
    org = await w.org('asymmetry');
    superAdmin = await w.superAdmin('pra-super');
    superToken = await w.login(superAdmin.email);
  }, 120_000);

  afterAll(async () => {
    await w.teardown();
    await h.close();
  }, 120_000);

  afterEach(() =>
    purgeAudit(
      h.admin,
      sql`action IN (${AUDIT_ACTIONS.USER_ROLE_REVOKED}, ${AUDIT_ACTIONS.USER_ROLE_GRANTED})`,
    ),
  );

  const grantRequest = (
    token: string,
    body: { userId: string; roleId: string; scopeType: string; scopeId: string },
  ) =>
    request(h.app.getHttpServer())
      .post(url('/role-assignments'))
      .set('authorization', `Bearer ${token}`)
      .set('x-acc-organization', org.orgId)
      .send(body);

  /** Grant rows of this user and role, and `user_role.granted` rows naming the user. */
  const traces = async (userId: string, roleId: string) => {
    const grants = await h.admin
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.roleId, roleId)));
    const granted = await h.admin.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_logs
           WHERE action = ${AUDIT_ACTIONS.USER_ROLE_GRANTED} AND metadata->>'grantedTo' = ${userId}`,
    );
    return { grants: grants.length, granted: granted.rows[0]!.n };
  };

  /**
   * The asymmetry for one platform role: the API refuses to create the grant
   * (at reseller scope with `403 AUTHZ_PLATFORM_ROLE_REQUIRED`, and at platform
   * scope already in the DTO), writing nothing; an existing grant of the same
   * role is revoked by a platform administrator — `204`, gone, audited.
   */
  async function expectAsymmetry(
    roleId: string,
    roleKey: string,
    scope: { scopeType: 'platform'; scopeId: null } | { scopeType: 'reseller'; scopeId: string },
  ): Promise<void> {
    const holder = await w.person(`pra-${roleKey.replace(/_/g, '-')}`);

    // Grant through the API: refused at reseller scope by the service …
    const atReseller = await grantRequest(superToken, {
      userId: holder.userId,
      roleId,
      scopeType: 'reseller',
      scopeId: w.resellerId,
    });
    expect([atReseller.status, atReseller.body.error?.code]).toEqual([
      403,
      ERROR_CODES.AUTHZ_PLATFORM_ROLE_REQUIRED,
    ]);
    // … and platform scope is not representable: a well-formed request whose
    // only fault is `scopeType: 'platform'` fails validation on that field.
    const atPlatform = await grantRequest(superToken, {
      userId: holder.userId,
      roleId,
      scopeType: 'platform',
      scopeId: uuidv7(),
    });
    expect([atPlatform.status, atPlatform.body.error?.code]).toEqual([
      400,
      ERROR_CODES.VALIDATION_FAILED,
    ]);
    expect(JSON.stringify(atPlatform.body.error)).toContain('scopeType');
    expect(await traces(holder.userId, roleId)).toEqual({ grants: 0, granted: 0 });

    // The same role, granted out of band (owner, platform-administrator claim) …
    const grantId = await w.grant(holder.userId, roleId, scope.scopeType, scope.scopeId);
    // … is revoked through the API by a platform administrator.
    const revoked = await w.revoke(superToken, org.orgId, grantId);
    expect(revoked.status).toBe(204);
    expect(await w.grantExists(grantId)).toBe(false);
    const audit = await w.revokedAudit(grantId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_user_id).toBe(superAdmin.userId);
    expect(audit[0]!.metadata).toMatchObject({ roleKey, revokedFrom: holder.userId });
    const [row] = (
      await h.admin.execute<{ scope_type: string }>(
        sql`SELECT scope_type::text FROM audit_logs
             WHERE action = ${AUDIT_ACTIONS.USER_ROLE_REVOKED} AND resource_id = ${grantId}`,
      )
    ).rows;
    expect(row!.scope_type).toBe(scope.scopeType);
  }

  // ===========================================================================
  describe('A. cannot be granted through the API; an existing grant can be revoked', () => {
    it('alendei_support', async () => {
      await expectAsymmetry(
        await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
        PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT,
        { scopeType: 'platform', scopeId: null },
      );
    });

    it('alendei_super_admin (another remains: the actor)', async () => {
      await expectAsymmetry(
        await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
        PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN,
        { scopeType: 'platform', scopeId: null },
      );
    });

    it('a custom platform role', async () => {
      const roleId = await w.platformRole('pra_custom', [PERMISSIONS.PLATFORM_TENANTS_READ]);
      const [role] = await h.admin
        .select({ key: schema.roles.key })
        .from(schema.roles)
        .where(eq(schema.roles.id, roleId));
      await expectAsymmetry(roleId, role!.key, { scopeType: 'platform', scopeId: null });
    });

    it('reseller_admin (the reseller keeps another administrator)', async () => {
      await w.resellerAdmin(w.resellerId, 'pra-reseller-keeper');
      await expectAsymmetry(
        await w.seededPlatformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
        PLATFORM_ROLE_KEYS.RESELLER_ADMIN,
        { scopeType: 'reseller', scopeId: w.resellerId },
      );
      expect(await w.resellerAdmins(w.resellerId)).toBe(1);
    });
  });

  // ===========================================================================
  describe('B. a principal that is not a platform administrator cannot revoke a platform-scope grant (404 — RLS hides it)', () => {
    let target: Person & { grantId: string };
    beforeEach(async () => {
      const holder = await w.person('pra-target');
      const grantId = await w.grant(
        holder.userId,
        await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
        'platform',
        null,
      );
      target = { ...holder, grantId };
    });

    const expectUntouched = async (token: string) => {
      const res = await w.revoke(token, org.orgId, target.grantId);
      expect([res.status, res.body.error?.code]).toEqual([404, ERROR_CODES.RESOURCE_NOT_FOUND]);
      expect(await w.grantExists(target.grantId)).toBe(true);
      expect(await w.revokedAudit(target.grantId)).toEqual([]);
    };

    it('an organization administrator', async () => {
      const admin = await w.admin(org, 'pra-orgadmin');
      await expectUntouched(await w.login(admin.email));
    });

    it('a reseller administrator', async () => {
      const resellerAdmin = await w.resellerAdmin(w.resellerId, 'pra-reseller');
      await expectUntouched(await w.login(resellerAdmin.email));
    });

    it('alendei_support (a platform-scope grant, but not a platform administrator)', async () => {
      const support = await w.person('pra-support');
      await w.grant(
        support.userId,
        await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
        'platform',
        null,
      );
      await expectUntouched(await w.login(support.email));
    });

    it('a custom platform role holding role_assignments.revoke', async () => {
      const operator = await w.person('pra-operator');
      await w.grant(
        operator.userId,
        await w.platformRole('pra_revoker', [
          PERMISSIONS.ROLE_ASSIGNMENTS_READ,
          PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE,
          PERMISSIONS.PLATFORM_TENANTS_READ,
        ]),
        'platform',
        null,
      );
      await expectUntouched(await w.login(operator.email));
    });
  });

  // ===========================================================================
  describe('C. the database backstop, with the service bypassed', () => {
    it('acc_app without the platform-administrator claim deletes nothing from a platform-scope grant', async () => {
      const holder = await w.person('pra-db');
      const grantId = await w.grant(
        holder.userId,
        await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
        'platform',
        null,
      );
      const admin = await w.admin(org, 'pra-db-admin');
      const deleted = await db.withTenant({ orgId: org.orgId, userId: admin.userId }, (tx) =>
        tx
          .delete(schema.userRoles)
          .where(eq(schema.userRoles.id, grantId))
          .returning({ id: schema.userRoles.id }),
      );
      expect(deleted).toEqual([]);
      expect(await w.grantExists(grantId)).toBe(true);
    });
  });
});
