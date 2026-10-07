/**
 * Audit read (Phase 1B.6.3, `API.md` §3f, `SECURITY.md` §4a).
 *
 * The audit trail is the record of who did what, so a read surface over it is
 * worth more to an attacker than most of the data it describes: it names
 * administrators, enumerates privilege changes, and — through `correlationId` —
 * lets one observation be expanded into the whole causal fan-out of a request.
 *
 * Two boundaries hold it, and this suite checks both independently:
 *
 *   - **`audit_logs_select`** (migration `0001`) decides which rows exist for
 *     this transaction: platform admin sees all, an organization sees its own,
 *     a reseller sees its organizations' rows *and* its own reseller-scoped
 *     rows. The list carries no tenant predicate of its own, so the policy is
 *     genuinely load-bearing rather than redundant with an application filter.
 *   - **`AuthorizationService.assert`** decides whether the caller may read an
 *     audit trail at all, and for the detail route, at the scope the record was
 *     written at.
 *
 * Filters are checked for the property that matters: they narrow inside what
 * the policy already allows and can never reach past it.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
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
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

interface AuditBody {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  actorType: string;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  actorLabel: string | null;
  resourceType: string;
  resourceId: string | null;
  scopeType: string;
  scopeId: string | null;
  resellerId: string | null;
  orgId: string | null;
  workspaceId: string | null;
  teamId: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown>;
  correlationId: string;
  causationId: string | null;
  ip: string | null;
  userAgent: string | null;
}

describe('audit read', () => {
  let h: Harness;
  let credentials: CredentialService;
  let db: TenantDatabase;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let adminToken: string;
  let orgBAdminToken: string;
  let superAdminRoleId: string;
  const plantedUsers: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    db = h.app.get(TenantDatabase);

    orgA = await createTenant(h.admin, 'aud-a', credentials);
    orgB = await createTenant(h.admin, 'aud-b', credentials);
    await addToFixtureRole(orgA, [PERMISSIONS.AUDIT_READ, PERMISSIONS.USERS_READ]);
    await addToFixtureRole(orgB, [PERMISSIONS.AUDIT_READ]);

    const [role] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN));
    superAdminRoleId = role!.id;

    adminToken = await tokenFor(orgA.email);
    orgBAdminToken = await tokenFor(orgB.email);
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(cleanup);

  async function cleanup(): Promise<void> {
    await purgeAudit(h.admin, sql`true`);
    if (plantedUsers.length > 0) {
      const ids = plantedUsers.splice(0);
      await h.admin.transaction(async (tx) => {
        await tx.execute(
          sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
        try {
          for (const id of ids) {
            await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
            await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${id}`);
            await tx.execute(sql`DELETE FROM users WHERE id = ${id}`);
          }
        } finally {
          await tx.execute(
            sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
          );
        }
      });
    }
  }

  // --- fixtures ---------------------------------------------------------------

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

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  const api = (token: string, org?: string) => {
    const auth = <T extends request.Test>(r: T): T => {
      r.set('authorization', `Bearer ${token}`);
      if (org) r.set('x-acc-organization', org);
      return r;
    };
    return {
      list: (query = '') => auth(request(h.app.getHttpServer()).get(url(`/audit-logs${query}`))),
      get: (id: string) => auth(request(h.app.getHttpServer()).get(url(`/audit-logs/${id}`))),
    };
  };

  /**
   * Plants an audit row directly, as the schema owner.
   *
   * Direct insertion rather than driving a mutation: this suite is about the
   * *read* path, and planting lets a row be placed at an exact scope — including
   * `platform` and `reseller`, which no tenant-facing endpoint produces — without
   * depending on which other endpoint happens to write there.
   */
  async function plantAudit(options: {
    scopeType: 'platform' | 'reseller' | 'organization' | 'workspace' | 'team';
    scopeId: string | null;
    actorUserId?: string | null;
    action?: string;
    outcome?: 'success' | 'failure' | 'denied';
    resourceType?: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
    correlationId?: string;
    occurredAt?: Date;
  }): Promise<string> {
    const { rows } = await h.admin.execute<{ id: string }>(sql`
      INSERT INTO audit_logs
        (scope_type, scope_id, actor_type, actor_user_id, action, resource_type,
         resource_id, outcome, metadata, correlation_id, occurred_at, ip, user_agent)
      VALUES (
        ${options.scopeType}::role_scope_type,
        ${options.scopeId},
        'user'::audit_actor_type,
        ${options.actorUserId ?? orgA.userId},
        ${options.action ?? 'user.updated'},
        ${options.resourceType ?? 'User'},
        ${options.resourceId ?? null},
        ${options.outcome ?? 'success'}::audit_outcome,
        ${JSON.stringify(options.metadata ?? {})}::jsonb,
        ${options.correlationId ?? uuidv7()},
        ${(options.occurredAt ?? new Date()).toISOString()}::timestamptz,
        '203.0.113.7'::inet,
        'probe/1.0'
      )
      RETURNING id
    `);
    return rows[0]!.id;
  }

  /**
   * A user holding a genuine grant **at** `reseller` scope.
   *
   * `fn_validate_user_role_scope` admits a reseller grant only from a platform
   * admin, so the insert declares that transaction-locally exactly as `seed.ts`
   * does — the guard is not relaxed for tests.
   */
  async function plantResellerAdmin(
    label: string,
    resellerId: string,
    options: { alsoOrganization?: boolean } = {},
  ): Promise<string> {
    const email = `${label}-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
    const userId = await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [user] = await tx
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });

      const [role] = await tx
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.RESELLER_ADMIN));
      await tx.insert(schema.userRoles).values({
        userId: user!.id,
        roleId: role!.id,
        scopeType: 'reseller',
        scopeId: resellerId,
      });
      if (options.alsoOrganization) {
        await tx.insert(schema.userRoles).values({
          userId: user!.id,
          roleId: orgA.roleId,
          scopeType: 'organization',
          scopeId: orgA.orgId,
        });
      }
      return user!.id;
    });
    plantedUsers.push(userId);
    return tokenFor(email);
  }

  async function plantPlatformAdmin(label: string): Promise<string> {
    const email = `${label}-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
    const userId = await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [user] = await tx
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      await tx
        .insert(schema.userRoles)
        .values({ userId: user!.id, roleId: superAdminRoleId, scopeType: 'platform' });
      return user!.id;
    });
    plantedUsers.push(userId);
    return tokenFor(email);
  }

  // ===========================================================================
  // Tenant scope
  // ===========================================================================
  describe('tenant scope', () => {
    it('case 1 — an organization reads its own trail', async () => {
      const mine = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });
      const res = await api(adminToken).list().expect(200);
      expect((res.body.data as AuditBody[]).map((r) => r.id)).toContain(mine);
    });

    it('case 2/7 — another organization’s rows are invisible and its ids are 404', async () => {
      const mine = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });
      const theirs = await plantAudit({
        scopeType: 'organization',
        scopeId: orgB.orgId,
        actorUserId: orgB.userId,
      });

      const res = await api(adminToken).list().expect(200);
      const ids = (res.body.data as AuditBody[]).map((r) => r.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);

      const detail = await api(adminToken).get(theirs).expect(404);
      expect(detail.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('the isolation is mutual — B sees its own trail and none of A’s', async () => {
      // The mirror of the case above, so those refusals are scoping rather than
      // a query that returns nothing for everyone.
      const mine = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });
      const theirs = await plantAudit({
        scopeType: 'organization',
        scopeId: orgB.orgId,
        actorUserId: orgB.userId,
      });

      const res = await api(orgBAdminToken).list().expect(200);
      const ids = (res.body.data as AuditBody[]).map((r) => r.id);
      expect(ids).toContain(theirs);
      expect(ids).not.toContain(mine);

      await api(orgBAdminToken).get(theirs).expect(200);
      await api(orgBAdminToken).get(mine).expect(404);
    });

    it('a real foreign id is indistinguishable from an unknown one', async () => {
      const theirs = await plantAudit({
        scopeType: 'organization',
        scopeId: orgB.orgId,
        actorUserId: orgB.userId,
      });
      const real = await api(adminToken).get(theirs).expect(404);
      const unknown = await api(adminToken).get(uuidv7()).expect(404);
      const strip = (b: { error: Record<string, unknown> }) => ({
        ...b.error,
        correlationId: '<x>',
      });
      expect(strip(real.body)).toEqual(strip(unknown.body));
      expect(JSON.stringify(real.body)).not.toContain(theirs);
    });

    /**
     * The discriminator for the list/detail inconsistency found in this phase.
     *
     * `audit_logs_select` admits a reseller row when `reseller_id =
     * app_current_reseller_id()`, and that session variable is derived from the
     * *selected organization's* reseller for every principal — so RLS alone
     * shows an ordinary organization administrator its reseller's own trail.
     * The detail route always refused it (the recorded `{reseller, …}` scope is
     * above an organization grant, and nothing reaches upward); the list did
     * not, until `resellerVisibilityPredicate`.
     *
     * Both halves are asserted together, because the property is that the two
     * surfaces **agree** — either one alone would pass while the pair was
     * inconsistent.
     */
    it('case 3 — an organization caller sees neither its reseller’s rows nor another’s', async () => {
      const ownResellerRow = await plantAudit({
        scopeType: 'reseller',
        scopeId: orgA.resellerId,
      });
      const otherResellerRow = await plantAudit({
        scopeType: 'reseller',
        scopeId: orgB.resellerId,
        actorUserId: orgB.userId,
      });
      const ownOrgRow = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });

      const res = await api(adminToken).list().expect(200);
      const ids = (res.body.data as AuditBody[]).map((r) => r.id);

      // The organization's own trail is unaffected.
      expect(ids).toContain(ownOrgRow);
      // Its reseller's trail is not its own — this is the row RLS would show.
      expect(ids).not.toContain(ownResellerRow);
      // And another reseller's never was.
      expect(ids).not.toContain(otherResellerRow);
      expect(ids.every((id) => id === ownOrgRow)).toBe(true);

      // The detail route agrees with the list, which is the whole point. Both
      // reseller rows are now `404`: an organization grant confers no reseller
      // claim, so RLS no longer shows the organization its own reseller's row
      // at all (Gate-B audit, Blocker 1). It previously answered `403`, which
      // is exactly the existence oracle that widened claim produced — so a
      // `403` here means the reseller claim is being derived from the selected
      // organization again.
      await api(adminToken).get(ownResellerRow).expect(404);
      await api(adminToken).get(otherResellerRow).expect(404);
    });

    it('case 3 — a genuine reseller-scope caller keeps its own reseller trail', async () => {
      const ownResellerRow = await plantAudit({
        scopeType: 'reseller',
        scopeId: orgA.resellerId,
      });
      const otherResellerRow = await plantAudit({
        scopeType: 'reseller',
        scopeId: orgB.resellerId,
        actorUserId: orgB.userId,
      });

      const token = await plantResellerAdmin('aud-res', orgA.resellerId);
      const res = await api(token, orgA.orgId).list().expect(200);
      const ids = (res.body.data as AuditBody[]).map((r) => r.id);

      // The positive control: narrowing the list must not have removed the view
      // it exists to serve.
      expect(ids).toContain(ownResellerRow);
      // Reseller A cannot see Reseller B.
      expect(ids).not.toContain(otherResellerRow);

      await api(token, orgA.orgId).get(ownResellerRow).expect(200);
      await api(token, orgA.orgId).get(otherResellerRow).expect(404);
    });

    it('case 3 — a workspace-pinned caller reaches no reseller row by either route', async () => {
      const resellerRow = await plantAudit({ scopeType: 'reseller', scopeId: orgA.resellerId });

      const pinned = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'workspace',
        orgA.workspaceId,
        'aud-ws',
      );
      plantedUsers.push(pinned.userId);
      const token = await tokenFor(pinned.email);

      // Stronger than "sees no reseller rows": the list itself is refused,
      // because it authorizes `audit.read` at the organization and a workspace
      // grant never reaches upward. There is no page for a reseller row to
      // appear on.
      const list = await api(token).list().expect(403);
      expect(list.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

      // And the detail route cannot even see the reseller row: a workspace
      // grant carries no reseller claim, so RLS hides it (`404`, no oracle).
      const detail = await api(token).get(resellerRow).expect(404);
      expect(detail.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('case 3 — mixed grants do not broaden reseller visibility', async () => {
      // An actor holding an organization grant in A *and* a reseller grant in
      // A's reseller sees A's reseller rows — and still not B's. Holding a
      // reseller grant somewhere is not authority over every reseller.
      const ownResellerRow = await plantAudit({
        scopeType: 'reseller',
        scopeId: orgA.resellerId,
      });
      const otherResellerRow = await plantAudit({
        scopeType: 'reseller',
        scopeId: orgB.resellerId,
        actorUserId: orgB.userId,
      });

      const token = await plantResellerAdmin('aud-mixed', orgA.resellerId, {
        alsoOrganization: true,
      });
      const res = await api(token, orgA.orgId).list().expect(200);
      const ids = (res.body.data as AuditBody[]).map((r) => r.id);
      expect(ids).toContain(ownResellerRow);
      expect(ids).not.toContain(otherResellerRow);
    });

    it('case 3 — an API-key principal sees no reseller rows', async () => {
      // A key is bound to an organization or a workspace and never above
      // (`RBAC.md` §5c), so it holds no reseller grant and the predicate
      // excludes reseller rows — without consulting its creator's wider
      // authority.
      const resellerRow = await plantAudit({ scopeType: 'reseller', scopeId: orgA.resellerId });
      const orgRow = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });

      const secret = `secret-${uuidv7()}`;
      const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
      await h.admin.insert(schema.apiKeys).values({
        orgId: orgA.orgId,
        name: `aud-res-key-${prefix}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: orgA.userId,
        scopes: [PERMISSIONS.AUDIT_READ],
      });

      const res = await api(`${prefix}.${secret}`).list().expect(200);
      const ids = (res.body.data as AuditBody[]).map((r) => r.id);
      expect(ids).toContain(orgRow);
      expect(ids).not.toContain(resellerRow);

      await purgeAudit(h.admin, sql`true`);
      await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${prefix}`);
    });

    it('case 5 — a platform administrator sees platform-scoped rows', async () => {
      const platformRow = await plantAudit({ scopeType: 'platform', scopeId: null });
      const orgRow = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });

      // A tenant administrator never sees a platform row.
      const tenantView = await api(adminToken).list().expect(200);
      expect((tenantView.body.data as AuditBody[]).map((r) => r.id)).not.toContain(platformRow);
      await api(adminToken).get(platformRow).expect(404);

      const resellerRow = await plantAudit({ scopeType: 'reseller', scopeId: orgA.resellerId });

      const platformToken = await plantPlatformAdmin('aud-plat');
      const platformView = await api(platformToken, orgA.orgId).list().expect(200);
      const ids = (platformView.body.data as AuditBody[]).map((r) => r.id);
      expect(ids).toContain(platformRow);
      expect(ids).toContain(orgRow);
      // The reseller narrowing must not have touched the platform view.
      expect(ids).toContain(resellerRow);
      await api(platformToken, orgA.orgId).get(platformRow).expect(200);
      await api(platformToken, orgA.orgId).get(resellerRow).expect(200);
    });

    it('case 4 — detail authorizes at the scope the record was written at', async () => {
      // A second workspace, and an actor pinned to it.
      const [second] = await h.admin
        .insert(schema.workspaces)
        .values({ orgId: orgA.orgId, name: 'Audit Second', slug: 'audit-second' })
        .returning({ id: schema.workspaces.id });

      const rowInWorkspaceOne = await plantAudit({
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });

      const pinned = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'workspace',
        second!.id,
        'aud-pinned',
      );
      plantedUsers.push(pinned.userId);
      const pinnedToken = await tokenFor(pinned.email);

      // The row is visible to the policy — RLS carries no workspace term — so
      // this is the authorization layer's refusal, which is the whole point of
      // authorizing detail at the recorded scope.
      const res = await api(pinnedToken).get(rowInWorkspaceOne).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

      // `audit_logs_workspace_org_fk` is ON DELETE RESTRICT, so the trail has to
      // go before the workspace it attributes an action to — the append-only
      // design working, not a teardown inconvenience.
      await purgeAudit(h.admin, sql`true`);
      // A workspace cannot be deleted while a grant is scoped to it (migration
      // 0025, `fn_scope_parent_restrict`), so the pinned grant goes first.
      await h.admin.execute(
        sql`DELETE FROM user_roles WHERE scope_type = 'workspace' AND scope_id = ${second!.id}`,
      );
      await h.admin.execute(sql`DELETE FROM workspaces WHERE id = ${second!.id}`);
    });

    it('case 9 — a caller-supplied scope filter cannot reach another tenant', async () => {
      const theirs = await plantAudit({
        scopeType: 'organization',
        scopeId: orgB.orgId,
        actorUserId: orgB.userId,
      });

      // Naming organization B explicitly returns nothing: the filter narrows
      // inside the policy, it does not select a tenant.
      const res = await api(adminToken)
        .list(`?scopeType=organization&scopeId=${orgB.orgId}`)
        .expect(200);
      expect(res.body.data).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(theirs);
    });

    it('case 9 — a forged organization header is refused', async () => {
      const res = await api(adminToken, orgB.orgId).list().expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it('an unknown query parameter is refused rather than ignored', async () => {
      await api(adminToken).list(`?orgId=${orgB.orgId}`).expect(400);
      await api(adminToken).list(`?resellerId=${orgB.resellerId}`).expect(400);
      await api(adminToken).list(`?workspaceId=${orgB.workspaceId}`).expect(400);
    });
  });

  /**
   * The invariant the fix exists to establish, stated once over every scope
   * level rather than case by case:
   *
   *   **a row appears in the list if and only if the detail route serves it.**
   *
   * A list broader than its own detail route is the defect that was found
   * here; a list narrower than it would be a different bug. Walking all five
   * levels means a future scope type cannot quietly reintroduce either.
   */
  it('case 3 — list membership and detail access agree at every scope level', async () => {
    const [team] = await h.admin
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.orgId, orgA.orgId))
      .limit(1);

    const rows: { label: string; id: string }[] = [
      { label: 'platform', id: await plantAudit({ scopeType: 'platform', scopeId: null }) },
      {
        label: 'reseller',
        id: await plantAudit({ scopeType: 'reseller', scopeId: orgA.resellerId }),
      },
      {
        label: 'organization',
        id: await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId }),
      },
      {
        label: 'workspace',
        id: await plantAudit({ scopeType: 'workspace', scopeId: orgA.workspaceId }),
      },
      { label: 'team', id: await plantAudit({ scopeType: 'team', scopeId: team!.id }) },
    ];

    const list = await api(adminToken).list('?limit=100').expect(200);
    const listed = new Set((list.body.data as AuditBody[]).map((r) => r.id));

    const observed: Record<string, { listed: boolean; detail: number }> = {};
    for (const row of rows) {
      const detail = await api(adminToken).get(row.id);
      observed[row.label] = { listed: listed.has(row.id), detail: detail.status };
    }

    // An organization administrator: everything inside its organization, and
    // nothing at or above the reseller — not even the knowledge that its
    // reseller's row exists (`404`, since the reseller claim is never derived
    // from the selected organization).
    expect(observed).toEqual({
      platform: { listed: false, detail: 404 },
      reseller: { listed: false, detail: 404 },
      organization: { listed: true, detail: 200 },
      workspace: { listed: true, detail: 200 },
      team: { listed: true, detail: 200 },
    });

    // Stated as the invariant rather than only as the table above: listed
    // implies readable, and readable implies listed.
    for (const [label, result] of Object.entries(observed)) {
      expect(`${label}:${result.listed}`).toBe(`${label}:${result.detail === 200}`);
    }
  });

  // ===========================================================================
  // Authorization
  // ===========================================================================
  describe('authorization', () => {
    async function withoutAuditRead(): Promise<string> {
      const [role] = await h.admin
        .insert(schema.roles)
        .values({
          orgId: orgA.orgId,
          key: `aud_none_${uuidv7().replace(/-/g, '').slice(-6)}`,
          name: 'no-audit',
          isSystemRole: false,
          allowedScopeTypes: ['organization'],
        })
        .returning({ id: schema.roles.id });
      const email = `aud-none-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const [user] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      plantedUsers.push(user!.id);
      await h.admin.insert(schema.userRoles).values({
        userId: user!.id,
        roleId: role!.id,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      });
      return tokenFor(email);
    }

    it('reading without `audit.read` is refused on both routes', async () => {
      const row = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });
      const token = await withoutAuditRead();

      const list = await api(token).list().expect(403);
      expect(list.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      await api(token).get(row).expect(403);
    });

    it('unauthenticated access is refused', async () => {
      const row = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });
      for (const res of [
        await request(h.app.getHttpServer()).get(url('/audit-logs')),
        await request(h.app.getHttpServer()).get(url(`/audit-logs/${row}`)),
      ]) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTH_CREDENTIAL_REQUIRED);
      }
    });

    it('a refused read is itself audited as authorization.denied', async () => {
      const token = await withoutAuditRead();
      await purgeAudit(h.admin, sql`true`);
      await api(token).list().expect(403);

      const { rows } = await h.admin.execute<{ metadata: { permission: string } }>(
        sql`SELECT metadata FROM audit_logs WHERE action = 'authorization.denied'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata.permission).toBe(PERMISSIONS.AUDIT_READ);
    });

    it('case 6 — an API key without audit scopes cannot read', async () => {
      const secret = `secret-${uuidv7()}`;
      const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
      await h.admin.insert(schema.apiKeys).values({
        orgId: orgA.orgId,
        name: `aud-key-${prefix}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: orgA.userId,
        scopes: [PERMISSIONS.USERS_READ],
      });
      const credential = `${prefix}.${secret}`;

      const res = await api(credential).list().expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

      // `api_key.authenticated` rows reference the key under an ON DELETE
      // RESTRICT foreign key, so the trail goes first.
      await purgeAudit(h.admin, sql`true`);
      await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${prefix}`);
    });

    it('case 6 — an API key carrying `audit.read` within its binding may read', async () => {
      const row = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });
      const secret = `secret-${uuidv7()}`;
      const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
      await h.admin.insert(schema.apiKeys).values({
        orgId: orgA.orgId,
        name: `aud-key-ok-${prefix}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: orgA.userId,
        scopes: [PERMISSIONS.AUDIT_READ],
      });
      const credential = `${prefix}.${secret}`;

      const res = await api(credential).list().expect(200);
      expect((res.body.data as AuditBody[]).map((r) => r.id)).toContain(row);

      await purgeAudit(h.admin, sql`true`);
      await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${prefix}`);
    });
  });

  // ===========================================================================
  // Response shape and redaction
  // ===========================================================================
  describe('response', () => {
    it('case 10 — no credential material appears in a list or a detail', async () => {
      // A row whose payload would have carried credential material had the
      // write-time redactor not removed it.
      const row = await plantAudit({
        scopeType: 'organization',
        scopeId: orgA.orgId,
        metadata: { note: 'safe' },
      });

      const list = await api(adminToken).list().expect(200);
      const detail = await api(adminToken).get(row).expect(200);

      for (const res of [list, detail]) {
        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(/\$argon2/);
        for (const forbidden of [
          'passwordHash',
          'password_hash',
          'keyHash',
          'key_hash',
          'refreshTokenHash',
          'refresh_token_hash',
          'mfaSecretRef',
          'ticketHash',
        ]) {
          expect(text).not.toContain(forbidden);
        }
      }
    });

    it('the write-time redactor is what protects the payload, end to end', async () => {
      // Written through the real `AuditWriter` with a payload full of secrets,
      // then read back through the API. Nothing in the read path redacts, so a
      // leak here would mean the write-time boundary had failed.
      const { AuditWriter } = await import('../src/audit/audit-writer.service');
      const writer = h.app.get(AuditWriter);
      await db.withTenant(
        {
          orgId: orgA.orgId,
          workspaceId: null,
          resellerId: orgA.resellerId,
          userId: orgA.userId,
          isPlatformAdmin: false,
        },
        (tx) =>
          writer.record(
            {
              scopeType: 'organization',
              scopeId: orgA.orgId,
              actorType: 'user',
              actorUserId: orgA.userId,
              actorApiKeyId: null,
              actorLabel: null,
              action: 'user.updated',
              resourceType: 'User',
              resourceId: orgA.userId,
              outcome: 'success',
              before: null,
              after: {
                password: 'hunter2hunter2',
                nested: { password_hash: '$argon2id$nested-leak' },
              },
              metadata: { refresh_token: 'rt-leak', key_hash: '$argon2id$leak' },
              correlationId: uuidv7(),
            },
            tx,
          ),
      );

      const res = await api(adminToken).list('?action=user.updated').expect(200);
      const text = JSON.stringify(res.body);
      // Top level and nested, across `after` and `metadata`.
      expect(text).not.toContain('hunter2hunter2');
      expect(text).not.toContain('nested-leak');
      expect(text).not.toContain('rt-leak');
      expect(text).not.toMatch(/\$argon2/);
      expect(text).toContain('[redacted]');

      /**
       * The vocabulary asserted above is the one `audit-redactor.ts` actually
       * covers: `password`, `password_hash`, `key_hash`, `refresh_token_hash`,
       * `mfa_secret_ref`, `ticket_hash`, and anything matching `/secret|token/i`.
       *
       * It does **not** cover `api_key`, `apiKey` or `credential`, which the
       * *logger's* redaction list does cover — the two lists disagree. No caller
       * writes a secret under those keys today (Phase 1B.6.2's structural test
       * asserts the API-key audit payload carries only the public prefix), so
       * this is a latent gap rather than a live leak. It is recorded as a
       * finding for the next phase rather than asserted here, because a test
       * that pinned the current gap would make fixing it a failure.
       */
    });

    it('returns the documented projection and nothing else', async () => {
      const row = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });
      const res = await api(adminToken).get(row).expect(200);
      expect(Object.keys(res.body.data as object).sort()).toEqual([
        'action',
        'actorApiKeyId',
        'actorLabel',
        'actorType',
        'actorUserId',
        'after',
        'before',
        'causationId',
        'correlationId',
        'id',
        'ip',
        'metadata',
        'occurredAt',
        'orgId',
        'outcome',
        'resellerId',
        'resourceId',
        'resourceType',
        'scopeId',
        'scopeType',
        'teamId',
        'userAgent',
        'workspaceId',
      ]);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect(res.headers['x-correlation-id']).toBeTruthy();
    });

    it('preserves the actor / resource / scope / outcome distinctions', async () => {
      const resourceId = uuidv7();
      const row = await plantAudit({
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
        action: 'user_role.granted',
        outcome: 'denied',
        resourceType: 'RoleAssignment',
        resourceId,
      });
      const res = await api(adminToken).get(row).expect(200);
      const body = res.body.data as AuditBody;

      expect(body.action).toBe('user_role.granted');
      expect(body.outcome).toBe('denied');
      expect(body.actorType).toBe('user');
      expect(body.actorUserId).toBe(orgA.userId);
      expect(body.resourceType).toBe('RoleAssignment');
      expect(body.resourceId).toBe(resourceId);
      // Derived ancestry, computed by the database, not by the writer.
      expect(body.scopeType).toBe('workspace');
      expect(body.scopeId).toBe(orgA.workspaceId);
      expect(body.workspaceId).toBe(orgA.workspaceId);
      expect(body.orgId).toBe(orgA.orgId);
      expect(body.teamId).toBeNull();
    });
  });

  // ===========================================================================
  // List conventions
  // ===========================================================================
  describe('list conventions', () => {
    it('cases 12/13/11 — invalid filters, sorts and cursors are refused', async () => {
      await api(adminToken).list('?outcome=maybe').expect(400);
      await api(adminToken).list('?actorType=wizard').expect(400);
      await api(adminToken).list('?scopeType=galaxy').expect(400);
      await api(adminToken).list('?action=NOT%20A%20KEY').expect(400);
      await api(adminToken).list('?actorUserId=not-a-uuid').expect(400);

      const sort = await api(adminToken).list('?sort=ip').expect(400);
      expect(sort.body.error.details.issues[0].rule).toBe('SORT_NOT_ALLOWED');
      await api(adminToken).list('?sort=metadata').expect(400);

      const cursor = await api(adminToken).list('?cursor=forged.cursor').expect(400);
      expect(cursor.body.error.code).toBe(ERROR_CODES.PAGINATION_CURSOR_INVALID);
      await api(adminToken).list('?limit=0').expect(400);
      await api(adminToken).list('?limit=101').expect(400);
    });

    it('case 11 — a cursor cannot be replayed under a different sort', async () => {
      for (let i = 0; i < 3; i += 1) {
        await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });
      }
      const first = await api(adminToken).list('?limit=1').expect(200);
      const cursor = first.body.page.nextCursor as string;
      expect(cursor).toBeTruthy();

      const res = await api(adminToken)
        .list(`?limit=1&sort=occurredAt&cursor=${encodeURIComponent(cursor)}`)
        .expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.PAGINATION_CURSOR_INVALID);
    });

    it('case 14 — walks every row exactly once, newest first', async () => {
      const planted: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        planted.push(await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId }));
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 12; page += 1) {
        const query: string = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res: request.Response = await api(adminToken).list(query).expect(200);
        seen.push(...(res.body.data as AuditBody[]).map((r) => r.id));
        cursor = res.body.page.nextCursor as string | null;
        if (!cursor) break;
      }

      expect(new Set(seen).size).toBe(seen.length);
      for (const id of planted) expect(seen).toContain(id);
      // Newest first, in the documented order: by id descending (API.md §3f). The
      // database's UUIDv7 is chronological to the millisecond and random within
      // one, so rows planted in the same millisecond need not follow insertion
      // order — asserting insertion order was the flake. The order is total.
      const descending = (ids: string[]) => [...ids].sort().reverse();
      expect(seen).toEqual(descending(seen));
      expect(new Set(seen.slice(0, planted.length))).toEqual(new Set(planted));
      expect(seen.slice(0, planted.length)).toEqual(descending(planted));
    });

    it('filters narrow the caller’s own trail', async () => {
      const correlationId = uuidv7();
      const target = await plantAudit({
        scopeType: 'organization',
        scopeId: orgA.orgId,
        action: 'role.created',
        outcome: 'failure',
        resourceType: 'Role',
        correlationId,
      });
      await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId, action: 'user.updated' });

      for (const query of [
        '?action=role.created',
        '?outcome=failure',
        '?resourceType=Role',
        `?correlationId=${correlationId}`,
        `?actorUserId=${orgA.userId}&action=role.created`,
      ]) {
        const res = await api(adminToken).list(query).expect(200);
        expect((res.body.data as AuditBody[]).map((r) => r.id)).toEqual([target]);
      }
    });

    it('filters by a half-open occurrence window', async () => {
      const old = new Date(Date.now() - 86_400_000);
      const oldRow = await plantAudit({
        scopeType: 'organization',
        scopeId: orgA.orgId,
        occurredAt: old,
      });
      const recent = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });

      const since = new Date(Date.now() - 3_600_000).toISOString();
      const res = await api(adminToken)
        .list(`?occurredFrom=${encodeURIComponent(since)}`)
        .expect(200);
      const ids = (res.body.data as AuditBody[]).map((r) => r.id);
      expect(ids).toContain(recent);
      expect(ids).not.toContain(oldRow);

      const until = await api(adminToken)
        .list(`?occurredTo=${encodeURIComponent(since)}`)
        .expect(200);
      expect((until.body.data as AuditBody[]).map((r) => r.id)).toEqual([oldRow]);
    });
  });

  // ===========================================================================
  // RLS, with the application boundary bypassed
  // ===========================================================================
  describe('RLS backstop', () => {
    const context = (tenant: TenantFixture) => ({
      orgId: tenant.orgId,
      workspaceId: null,
      resellerId: tenant.resellerId,
      userId: tenant.userId,
      isPlatformAdmin: false,
    });

    it('case 8 — another organization’s audit rows are invisible under its own context', async () => {
      const theirs = await plantAudit({
        scopeType: 'organization',
        scopeId: orgB.orgId,
        actorUserId: orgB.userId,
      });

      const visible = await db.withTenant(context(orgA), (tx) =>
        tx
          .select({ id: schema.auditLogs.id })
          .from(schema.auditLogs)
          .where(eq(schema.auditLogs.id, theirs)),
      );
      expect(visible).toEqual([]);
    });

    it('case 8 — platform-scoped rows are invisible to a tenant context', async () => {
      const platformRow = await plantAudit({ scopeType: 'platform', scopeId: null });
      const visible = await db.withTenant(context(orgA), (tx) =>
        tx
          .select({ id: schema.auditLogs.id })
          .from(schema.auditLogs)
          .where(eq(schema.auditLogs.id, platformRow)),
      );
      expect(visible).toEqual([]);
    });

    it('RLS is enabled on audit_logs and `acc_app` is neither superuser nor BYPASSRLS', async () => {
      // The premise every other case in this file rests on. Asserted here so a
      // future migration that disabled either would fail loudly rather than
      // turning the isolation cases green for the wrong reason.
      const { rows } = await h.admin.execute<{
        relrowsecurity: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(sql`
        SELECT c.relrowsecurity, r.rolsuper, r.rolbypassrls
        FROM pg_class c, pg_roles r
        WHERE c.relname = 'audit_logs' AND r.rolname = 'acc_app'
      `);
      expect(rows[0]).toEqual({ relrowsecurity: true, rolsuper: false, rolbypassrls: false });
    });

    it('the trail stays append-only — `acc_app` cannot rewrite or remove a row', async () => {
      const row = await plantAudit({ scopeType: 'organization', scopeId: orgA.orgId });

      const update = await db
        .withTenant(context(orgA), (tx) =>
          tx
            .update(schema.auditLogs)
            .set({ action: 'tampered' })
            .where(eq(schema.auditLogs.id, row)),
        )
        .then(
          () => null,
          (error: unknown) => error as { cause?: { code?: string } },
        );
      const remove = await db
        .withTenant(context(orgA), (tx) =>
          tx.delete(schema.auditLogs).where(eq(schema.auditLogs.id, row)),
        )
        .then(
          () => null,
          (error: unknown) => error as { cause?: { code?: string } },
        );

      // `42501 insufficient_privilege` — the grant is absent, so these are
      // refused outright rather than filtered to zero rows.
      expect(update?.cause?.code).toBe('42501');
      expect(remove?.cause?.code).toBe('42501');

      const [still] = await h.admin
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.id, row));
      expect(still!.action).not.toBe('tampered');
    });
  });

  // Referenced so the import is not unused if a case is trimmed locally.
  void and;
});
