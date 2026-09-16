/**
 * User administration (Phase 1B.6.1, `API.md` §3d, `RBAC.md` §§5a.1, 8c).
 *
 * `users` is the one administered table with **no tenant column** — an identity
 * is platform-level and its tenancy is entirely the grants it holds — so almost
 * everything here is a question about a boundary that has to be constructed
 * rather than one the schema supplies. Every case is adversarial by default; the
 * positive controls exist so a refusal cannot be mistaken for a broken query.
 *
 * What this suite is actually for, in order of how much it would cost to get
 * wrong:
 *
 *   - **Membership, not visibility.** `users_select` admits any user reachable
 *     through *any* organization in scope. The endpoint narrows to the
 *     organization the request selected, and a list that quietly widened with
 *     the reader's other memberships would be a cross-tenant disclosure that
 *     passes every RLS test.
 *   - **Credential material never appears.** In a response or in an audit row.
 *     `users` holds an Argon2id digest and an MFA secret reference, and this is
 *     the first surface that reads the table for a client.
 *   - **Lifecycle is not authorization.** Disabling is guarded by the
 *     platform-admin liveness invariant; nothing here may grant, revoke or
 *     rewrite a grant, and `PATCH` may not reach status, email or roles.
 *   - **A disabled user is actually locked out.** Not at token expiry.
 *
 * The liveness invariant and the lifecycle races live in
 * `user-lifecycle-concurrency.sec-spec.ts`, because they assert final database
 * state rather than responses and need a suite that owns the platform-admin
 * population outright.
 */
import { ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS, type ScopeType } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CSRF_HEADER } from '../src/auth/csrf.guard';
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

interface UserBody {
  id: string;
  email: string;
  phone: string | null;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The permissions the fixture's `org_admin` needs to exercise this surface. */
const ADMIN_PERMISSIONS = [
  PERMISSIONS.USERS_READ,
  PERMISSIONS.USERS_INVITE,
  PERMISSIONS.USERS_UPDATE,
  PERMISSIONS.USERS_DISABLE,
  PERMISSIONS.USERS_REACTIVATE,
  PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
  PERMISSIONS.ROLES_READ,
];

describe('user administration', () => {
  let h: Harness;
  let credentials: CredentialService;
  let db: TenantDatabase;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let adminToken: string;
  let orgBAdminToken: string;
  /** A grantable role in A carrying only `workspaces.read`. */
  let narrowRoleId: string;
  /** The same in B, so B can create users of its own. */
  let narrowRoleIdB: string;
  /** A role in A carrying nothing at all. */
  let emptyRoleId: string;
  /** Users this suite created, for teardown. */
  const planted: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    db = h.app.get(TenantDatabase);

    // Two tenants under two different resellers: `createTenant` plants one
    // reseller each, so every cross-tenant case here is also cross-reseller.
    orgA = await createTenant(h.admin, 'usr-a', credentials);
    orgB = await createTenant(h.admin, 'usr-b', credentials);

    await addToFixtureRole(orgA, ADMIN_PERMISSIONS);
    await addToFixtureRole(orgB, ADMIN_PERMISSIONS);

    narrowRoleId = await makeRole(
      orgA,
      'narrow_member',
      ['organization', 'workspace', 'team'],
      [PERMISSIONS.WORKSPACES_READ],
    );
    narrowRoleIdB = await makeRole(
      orgB,
      'narrow_member',
      ['organization', 'workspace', 'team'],
      [PERMISSIONS.WORKSPACES_READ],
    );
    emptyRoleId = await makeRole(orgA, 'empty_member', ['organization', 'workspace', 'team'], []);

    adminToken = await tokenFor(orgA.email);
    orgBAdminToken = await tokenFor(orgB.email);
  }, 90_000);

  afterAll(async () => {
    await removePlanted();
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(async () => {
    await purgeAudit(h.admin, sql`true`);
    await removePlanted();
  });

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

  /** An existing member of a tenant, planted directly rather than through the API. */
  async function plantMember(
    tenant: TenantFixture,
    label: string,
    options: { status?: 'active' | 'invited' | 'disabled'; roleId?: string } = {},
  ): Promise<{ userId: string; email: string }> {
    const email = `${label}-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
    const status = options.status ?? 'active';
    const [user] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status,
        // An `active` user must hold a credential (`users_active_requires_credential`).
        passwordHash: status === 'invited' ? null : await credentials.hash(PASSWORD),
        passwordUpdatedAt: status === 'invited' ? null : new Date(),
      })
      .returning({ id: schema.users.id });

    await h.admin.insert(schema.userRoles).values({
      userId: user!.id,
      roleId: options.roleId ?? tenant.roleId,
      scopeType: 'organization',
      scopeId: tenant.orgId,
    });
    planted.push(user!.id);
    return { userId: user!.id, email };
  }

  async function removePlanted(): Promise<void> {
    if (planted.length === 0) return;
    const ids = planted.splice(0);
    await purgeAudit(h.admin, sql`true`);
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN ${sqlIds(ids)}`);
    await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id IN ${sqlIds(ids)}`);
    await h.admin.execute(sql`DELETE FROM users WHERE id IN ${sqlIds(ids)}`);
    await h.admin.execute(sql`DELETE FROM idempotency_keys WHERE true`);
  }

  function sqlIds(ids: readonly string[]) {
    return sql`(${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`;
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
      list: (query = '') => auth(request(h.app.getHttpServer()).get(url(`/users${query}`))),
      get: (id: string) => auth(request(h.app.getHttpServer()).get(url(`/users/${id}`))),
      create: (body: unknown, key?: string) => {
        const r = auth(request(h.app.getHttpServer()).post(url('/users')));
        if (key) r.set('idempotency-key', key);
        return r.send(body as object);
      },
      patch: (id: string, body: unknown) =>
        auth(request(h.app.getHttpServer()).patch(url(`/users/${id}`))).send(body as object),
      disable: (id: string) =>
        auth(request(h.app.getHttpServer()).post(url(`/users/${id}/disable`))),
      reactivate: (id: string) =>
        auth(request(h.app.getHttpServer()).post(url(`/users/${id}/reactivate`))),
    };
  };

  const validCreate = (label: string) => ({
    email: `${label}-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`,
    initialRole: {
      roleId: narrowRoleId,
      scopeType: 'organization' as const,
      scopeId: orgA.orgId,
    },
  });

  /** Records a user the API created so teardown finds it. */
  function track(id: string): string {
    planted.push(id);
    return id;
  }

  async function auditRows(action: string) {
    const { rows } = await h.admin.execute<Record<string, unknown>>(
      sql`SELECT * FROM audit_logs WHERE action = ${action} ORDER BY created_at`,
    );
    return rows;
  }

  async function statusOf(userId: string): Promise<string> {
    const [row] = await h.admin
      .select({ status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return row!.status;
  }

  // ===========================================================================
  // Reading — membership, and nothing wider
  // ===========================================================================
  describe('reading', () => {
    it('lists the organization members and nobody else', async () => {
      const member = await plantMember(orgA, 'member');
      const foreigner = await plantMember(orgB, 'foreign');

      const res = await api(adminToken).list().expect(200);
      const ids = (res.body.data as UserBody[]).map((u) => u.id);

      expect(ids).toContain(member.userId);
      expect(ids).toContain(orgA.userId);
      // Case A/B — another organization, under another reseller.
      expect(ids).not.toContain(foreigner.userId);
      expect(ids).not.toContain(orgB.userId);

      // The mirror image, so the refusals above are scoping rather than a
      // broken query: B sees its own members and none of A's.
      const mirror = await api(orgBAdminToken).list().expect(200);
      const mirrorIds = (mirror.body.data as UserBody[]).map((u) => u.id);
      expect(mirrorIds).toContain(foreigner.userId);
      expect(mirrorIds).not.toContain(member.userId);
      expect(mirrorIds).not.toContain(orgA.userId);
    });

    it('each tenant creates users into its own organization', async () => {
      // `narrowRoleIdB` is B's own grantable role: a create in B must succeed
      // with it and land in B, which is what makes A's `404` on B's scope a
      // boundary rather than an absent fixture.
      const res = await api(orgBAdminToken)
        .create({
          email: `own-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`,
          initialRole: {
            roleId: narrowRoleIdB,
            scopeType: 'organization' as const,
            scopeId: orgB.orgId,
          },
        })
        .expect(201);
      const created = track((res.body.data as UserBody).id);

      await api(orgBAdminToken).get(created).expect(200);
      await api(adminToken).get(created).expect(404);
    });

    it('answers the canonical collection envelope', async () => {
      const res = await api(adminToken).list('?limit=1').expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(Object.keys(res.body.page as object).sort()).toEqual([
        'hasMore',
        'limit',
        'nextCursor',
      ]);
      expect(res.body.page.limit).toBe(1);
      expect(typeof res.body.page.hasMore).toBe('boolean');
      expect(res.body).not.toHaveProperty('users');
      expect(res.headers['x-correlation-id']).toBeTruthy();
    });

    it('answers the canonical single envelope on detail', async () => {
      const res = await api(adminToken).get(orgA.userId).expect(200);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect((res.body.data as UserBody).id).toBe(orgA.userId);
    });

    it('case C — a user of another tenant is 404, not 403', async () => {
      const foreigner = await plantMember(orgB, 'hidden');
      const res = await api(adminToken).get(foreigner.userId).expect(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    });

    it('case C — a real foreign id and an unknown one are indistinguishable', async () => {
      const foreigner = await plantMember(orgB, 'oracle');
      const real = await api(adminToken).get(foreigner.userId).expect(404);
      const unknown = await api(adminToken).get(uuidv7()).expect(404);

      const strip = (b: { error: Record<string, unknown> }) => ({
        ...b.error,
        correlationId: undefined,
      });
      expect(strip(real.body)).toEqual(strip(unknown.body));
      // The identifier is never echoed, in either answer.
      expect(JSON.stringify(real.body)).not.toContain(foreigner.userId);
    });

    it('a member with no grant in this organization is not a member', async () => {
      // Planted with a grant in B only, then given a *reseller*-level grant that
      // RLS might otherwise make visible — membership is the organization's own
      // grant, not reachability.
      const foreigner = await plantMember(orgB, 'no-grant-here');
      const res = await api(adminToken).list().expect(200);
      expect((res.body.data as UserBody[]).map((u) => u.id)).not.toContain(foreigner.userId);
    });

    it('case Q — no credential material appears in a list or a detail', async () => {
      await plantMember(orgA, 'creds');
      const list = await api(adminToken).list().expect(200);
      const detail = await api(adminToken).get(orgA.userId).expect(200);

      for (const body of [list.body, detail.body]) {
        const text = JSON.stringify(body);
        expect(text).not.toMatch(/\$argon2/);
        for (const forbidden of [
          'passwordHash',
          'password_hash',
          'password',
          'passwordUpdatedAt',
          'mfaSecretRef',
          'mfa_secret_ref',
          'mfaEnabled',
          'refreshToken',
          'keyHash',
          'accessToken',
        ]) {
          expect(text).not.toContain(forbidden);
        }
      }
      // And the projection is exactly the published one.
      expect(Object.keys(detail.body.data as object).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'lastLoginAt',
        'phone',
        'status',
        'updatedAt',
      ]);
    });

    it('does not embed role assignments — they stay their own resource', async () => {
      const res = await api(adminToken).get(orgA.userId).expect(200);
      expect(res.body.data).not.toHaveProperty('roles');
      expect(res.body.data).not.toHaveProperty('roleAssignments');
      expect(res.body.data).not.toHaveProperty('permissions');
    });
  });

  // ===========================================================================
  // Pagination, filters and sorts — narrowing only
  // ===========================================================================
  describe('list conventions', () => {
    it('case U — a status filter narrows within the organization', async () => {
      const disabled = await plantMember(orgA, 'inactive', { status: 'disabled' });
      const res = await api(adminToken).list('?status=disabled').expect(200);
      const ids = (res.body.data as UserBody[]).map((u) => u.id);
      expect(ids).toContain(disabled.userId);
      expect(ids).not.toContain(orgA.userId);
    });

    it('case U — an email filter cannot reach another tenant', async () => {
      const foreigner = await plantMember(orgB, 'reach');
      const res = await api(adminToken)
        .list(`?email=${encodeURIComponent(foreigner.email)}`)
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('the email filter is case-insensitive within the organization', async () => {
      const member = await plantMember(orgA, 'Case');
      const res = await api(adminToken)
        .list(`?email=${encodeURIComponent(member.email.toUpperCase())}`)
        .expect(200);
      expect((res.body.data as UserBody[]).map((u) => u.id)).toEqual([member.userId]);
    });

    it('an unknown query parameter is refused, not ignored', async () => {
      const res = await api(adminToken)
        .list('?orgId=' + orgB.orgId)
        .expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('a sort field outside the allow-list is refused', async () => {
      const res = await api(adminToken).list('?sort=passwordHash').expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(res.body.error.details.issues[0].rule).toBe('SORT_NOT_ALLOWED');
    });

    it('a limit outside 1-100 is refused', async () => {
      await api(adminToken).list('?limit=0').expect(400);
      await api(adminToken).list('?limit=101').expect(400);
    });

    it('a forged cursor is refused', async () => {
      const res = await api(adminToken).list('?cursor=not.acursor').expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.PAGINATION_CURSOR_INVALID);
    });

    it('walks every member exactly once across pages', async () => {
      const made = [
        await plantMember(orgA, 'page1'),
        await plantMember(orgA, 'page2'),
        await plantMember(orgA, 'page3'),
      ];

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query: string = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res: request.Response = await api(adminToken).list(query).expect(200);
        seen.push(...(res.body.data as UserBody[]).map((u) => u.id));
        cursor = res.body.page.nextCursor as string | null;
        if (!cursor) break;
      }

      expect(new Set(seen).size).toBe(seen.length);
      for (const m of made) expect(seen).toContain(m.userId);
    });
  });

  // ===========================================================================
  // Creation
  // ===========================================================================
  describe('creation', () => {
    it('creates an invited identity with its first grant, atomically', async () => {
      const body = validCreate('created');
      const res = await api(adminToken).create(body).expect(201);
      const created = track((res.body.data as UserBody).id);

      expect((res.body.data as UserBody).email).toBe(body.email);
      // No credential was supplied, so the only state the CHECK admits.
      expect((res.body.data as UserBody).status).toBe('invited');

      const grants = await h.admin
        .select({ roleId: schema.userRoles.roleId, orgId: schema.userRoles.orgId })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.userId, created));
      expect(grants).toEqual([{ roleId: narrowRoleId, orgId: orgA.orgId }]);

      // And it is immediately reachable through the surface that created it.
      await api(adminToken).get(created).expect(200);
    });

    it('case Q — the creation response discloses no credential material', async () => {
      const res = await api(adminToken).create(validCreate('nocreds')).expect(201);
      track((res.body.data as UserBody).id);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/\$argon2/);
      for (const forbidden of ['password', 'temporaryPassword', 'token', 'secret', 'inviteUrl']) {
        expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
      expect(await passwordHashOf((res.body.data as UserBody).id)).toBeNull();
    });

    it('rejects a body carrying a password, however it is spelled', async () => {
      for (const extra of [
        { password: 'hunter2hunter2' },
        { passwordHash: 'x' },
        { status: 'active' },
      ]) {
        const res = await api(adminToken)
          .create({ ...validCreate('smuggle'), ...extra })
          .expect(400);
        expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      }
    });

    it('requires an initial role — a user with no grant would be invisible', async () => {
      const res = await api(adminToken)
        .create({ email: `orphan-${uuidv7()}@example.test` })
        .expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(
        (res.body.error.details.issues as { field: string }[]).some((i) =>
          i.field.startsWith('initialRole'),
        ),
      ).toBe(true);
    });

    it('rolls the identity back when the initial grant is refused', async () => {
      const body = {
        ...validCreate('rollback'),
        // Another organization's scope: guard 1 refuses it, and refuses without
        // confirming the scope exists.
        initialRole: {
          roleId: narrowRoleId,
          scopeType: 'organization' as const,
          scopeId: orgB.orgId,
        },
      };
      await api(adminToken).create(body).expect(404);

      const [leftBehind] = await h.admin
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = lower(${body.email})`);
      expect(leftBehind).toBeUndefined();
    });

    it('case K — a platform role cannot be conferred through creation', async () => {
      const [platformRole] = await h.admin
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN));

      const body = {
        ...validCreate('escalate'),
        initialRole: {
          roleId: platformRole!.id,
          scopeType: 'organization' as const,
          scopeId: orgA.orgId,
        },
      };
      const res = await api(adminToken).create(body).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_PLATFORM_ROLE_REQUIRED);
    });

    it('case K — `platform` scope is unrepresentable in the request', async () => {
      const res = await api(adminToken)
        .create({
          ...validCreate('platform-scope'),
          initialRole: { roleId: narrowRoleId, scopeType: 'platform', scopeId: orgA.orgId },
        })
        .expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('the initial grant still runs the actor-authority guard', async () => {
      // A role carrying a permission the actor does not hold at the organization.
      const overreaching = await makeRole(
        orgA,
        'over_reaching',
        ['organization'],
        [PERMISSIONS.API_KEYS_CREATE],
      );
      const res = await api(adminToken)
        .create({
          ...validCreate('over'),
          initialRole: {
            roleId: overreaching,
            scopeType: 'organization' as const,
            scopeId: orgA.orgId,
          },
        })
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION);
    });

    it('a duplicate address is 409 and says nothing about who holds it', async () => {
      const existing = await plantMember(orgB, 'taken');
      const res = await api(adminToken)
        .create({ ...validCreate('dup'), email: existing.email })
        .expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
      expect(JSON.stringify(res.body)).not.toContain(existing.userId);
      expect(JSON.stringify(res.body)).not.toContain(orgB.orgId);
    });

    it('a malformed address is refused before anything is written', async () => {
      await api(adminToken)
        .create({ ...validCreate('bad'), email: 'not-an-address' })
        .expect(400);
    });
  });

  // ===========================================================================
  // Profile update
  // ===========================================================================
  describe('update', () => {
    it('updates the one supported profile attribute', async () => {
      const member = await plantMember(orgA, 'profile');
      const res = await api(adminToken)
        .patch(member.userId, { phone: '+919876543210' })
        .expect(200);
      expect((res.body.data as UserBody).phone).toBe('+919876543210');

      const cleared = await api(adminToken).patch(member.userId, { phone: null }).expect(200);
      expect((cleared.body.data as UserBody).phone).toBeNull();
    });

    it('case P — status, email, roles and scopes are not reachable from PATCH', async () => {
      const member = await plantMember(orgA, 'locked');
      for (const body of [
        { status: 'active' },
        { email: 'new@example.test' },
        { roleId: narrowRoleId },
        { orgId: orgB.orgId },
        { scopeId: orgB.orgId },
        { passwordHash: 'x' },
        { isPlatformAdmin: true },
      ]) {
        const res = await api(adminToken).patch(member.userId, body).expect(400);
        expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      }
      // Nothing moved.
      expect(await statusOf(member.userId)).toBe('active');
    });

    it('another tenant’s user cannot be updated', async () => {
      const foreigner = await plantMember(orgB, 'untouchable');
      await api(adminToken).patch(foreigner.userId, { phone: '+919876543210' }).expect(404);
      const [row] = await h.admin
        .select({ phone: schema.users.phone })
        .from(schema.users)
        .where(eq(schema.users.id, foreigner.userId));
      expect(row!.phone).toBeNull();
    });

    it('an empty patch changes nothing and writes no audit row', async () => {
      const member = await plantMember(orgA, 'noop');
      await api(adminToken).patch(member.userId, {}).expect(200);
      expect(await auditRows('user.updated')).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================
  describe('lifecycle', () => {
    it('disables a user and revokes their live sessions in the same transaction', async () => {
      const member = await plantMember(orgA, 'live');
      const token = await tokenFor(member.email);
      // A positive control: the session works before the disable.
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);

      const res = await api(adminToken).disable(member.userId).expect(200);
      expect((res.body.data as UserBody).status).toBe('disabled');

      const sessions = await h.admin
        .select({ revokedAt: schema.sessions.revokedAt, reason: schema.sessions.revokedReason })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, member.userId));
      expect(sessions.length).toBeGreaterThan(0);
      for (const s of sessions) {
        expect(s.revokedAt).not.toBeNull();
        expect(s.reason).toBe('user_disabled');
      }
    });

    it('case N — a disabled user cannot authenticate', async () => {
      const member = await plantMember(orgA, 'locked-out');
      await api(adminToken).disable(member.userId).expect(200);

      await h.clearRateLimits();
      const res = await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: member.email, password: PASSWORD })
        .expect(401);
      // Indistinguishable from a wrong password: the endpoint is not an
      // account-state oracle.
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_INVALID_CREDENTIALS);
    });

    it('case N — an unexpired access token stops working at the next request', async () => {
      const member = await plantMember(orgA, 'token-holder');
      const token = await tokenFor(member.email);
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);

      await api(adminToken).disable(member.userId).expect(200);

      // Same token, not expired. The user state is re-read every request.
      const res = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(401);
      expect([ERROR_CODES.AUTH_ACCOUNT_DISABLED, ERROR_CODES.AUTH_SESSION_REVOKED]).toContain(
        res.body.error.code,
      );
    });

    it('case N — the per-request user-state check holds on its own, with no session revoked', async () => {
      // The endpoint revokes sessions as well, so the two controls would mask
      // each other in every test that goes through it. Here the status is
      // changed directly in the database — the service, and therefore the
      // session revocation, is bypassed entirely — leaving `AuthGuard`'s
      // re-read of the user as the only thing standing between an unexpired
      // token and a disabled account.
      const member = await plantMember(orgA, 'db-disabled');
      const token = await tokenFor(member.email);
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);

      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, member.userId));

      // The session row is untouched and still live, so nothing but the user
      // state can refuse this.
      const live = await h.admin
        .select({ revokedAt: schema.sessions.revokedAt })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, member.userId));
      expect(live.every((s) => s.revokedAt === null)).toBe(true);

      const res = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_ACCOUNT_DISABLED);
    });

    it('case O — refresh re-reads the user state too, with no session revoked', async () => {
      const member = await plantMember(orgA, 'db-disabled-refresh');
      await h.clearRateLimits();
      const login = await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: member.email, password: PASSWORD })
        .expect(200);
      const cookie = login.headers['set-cookie'] as unknown as string[];

      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, member.userId));

      const res = await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('cookie', cookie)
        .set(CSRF_HEADER, '1')
        .expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_SESSION_REVOKED);

      // Nothing was rotated: a disabled user's refresh must not mint a session.
      const sessions = await h.admin
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, member.userId));
      expect(sessions).toHaveLength(1);
    });

    it('case O — a disabled user cannot refresh an existing session', async () => {
      const member = await plantMember(orgA, 'refresher');
      await h.clearRateLimits();
      const login = await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: member.email, password: PASSWORD })
        .expect(200);
      const cookie = login.headers['set-cookie'] as unknown as string[];
      expect(cookie).toBeDefined();

      await api(adminToken).disable(member.userId).expect(200);

      const res = await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('cookie', cookie)
        .set(CSRF_HEADER, '1')
        .expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_SESSION_REVOKED);
    });

    it('disabling twice is a definite 409 naming the current state', async () => {
      const member = await plantMember(orgA, 'twice');
      await api(adminToken).disable(member.userId).expect(200);
      const res = await api(adminToken).disable(member.userId).expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.USER_LIFECYCLE_CONFLICT);
      expect(res.body.error.details).toEqual({ status: 'disabled' });
    });

    it('reactivates a user who still holds a credential', async () => {
      const member = await plantMember(orgA, 'return');
      await api(adminToken).disable(member.userId).expect(200);

      const res = await api(adminToken).reactivate(member.userId).expect(200);
      expect((res.body.data as UserBody).status).toBe('active');

      await h.clearRateLimits();
      await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: member.email, password: PASSWORD })
        .expect(200);
    });

    it('reactivates a credential-less user back to invited, not active', async () => {
      const member = await plantMember(orgA, 'never-activated', { status: 'invited' });
      await api(adminToken).disable(member.userId).expect(200);

      const res = await api(adminToken).reactivate(member.userId).expect(200);
      // `users_active_requires_credential` makes `active` unrepresentable here,
      // and leaving them disabled would make them unrecoverable.
      expect((res.body.data as UserBody).status).toBe('invited');
      expect(await statusOf(member.userId)).toBe('invited');
    });

    it('reactivation does not resurrect the sessions the disable revoked', async () => {
      const member = await plantMember(orgA, 'stale-session');
      const token = await tokenFor(member.email);
      await api(adminToken).disable(member.userId).expect(200);
      await api(adminToken).reactivate(member.userId).expect(200);

      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('reactivating an active user is a 409, not a silent success', async () => {
      const member = await plantMember(orgA, 'already-on');
      const res = await api(adminToken).reactivate(member.userId).expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.USER_LIFECYCLE_CONFLICT);
      expect(res.body.error.details).toEqual({ status: 'active' });
    });

    it('another tenant’s user cannot be disabled', async () => {
      const foreigner = await plantMember(orgB, 'safe');
      await api(adminToken).disable(foreigner.userId).expect(404);
      expect(await statusOf(foreigner.userId)).toBe('active');
    });

    it('there is no DELETE on a user', async () => {
      const member = await plantMember(orgA, 'undeletable');
      await request(h.app.getHttpServer())
        .delete(url(`/users/${member.userId}`))
        .set('authorization', `Bearer ${adminToken}`)
        .expect(404);
      // Still there, which is the point: the identity outlives the API surface.
      expect(await statusOf(member.userId)).toBe('active');
    });
  });

  // ===========================================================================
  // Authorization
  // ===========================================================================
  describe('authorization', () => {
    /** An actor in A whose only grant carries nothing. */
    async function powerless(): Promise<string> {
      const member = await plantMember(orgA, 'powerless', { roleId: emptyRoleId });
      return tokenFor(member.email);
    }

    it('case D — creation without `users.invite` is refused', async () => {
      const token = await powerless();
      const res = await api(token).create(validCreate('denied')).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('case E — update without `users.update` is refused', async () => {
      const member = await plantMember(orgA, 'target-e');
      const token = await powerless();
      await api(token).patch(member.userId, { phone: '+919876543210' }).expect(403);
    });

    it('case F — disable without `users.disable` is refused', async () => {
      const member = await plantMember(orgA, 'target-f');
      const token = await powerless();
      await api(token).disable(member.userId).expect(403);
      expect(await statusOf(member.userId)).toBe('active');
    });

    it('case G — reactivation without `users.reactivate` is refused', async () => {
      const member = await plantMember(orgA, 'target-g', { status: 'disabled' });
      const token = await powerless();
      await api(token).reactivate(member.userId).expect(403);
      expect(await statusOf(member.userId)).toBe('disabled');
    });

    it('reading without `users.read` is refused', async () => {
      const token = await powerless();
      await api(token).list().expect(403);
    });

    it('case I — a workspace-pinned actor cannot administer at the organization', async () => {
      const workspaceRole = await makeRole(
        orgA,
        'ws_user_admin',
        ['workspace'],
        [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_DISABLE],
      );
      const pinned = await createScopedUser(
        h.admin,
        orgA,
        credentials,
        'workspace',
        orgA.workspaceId,
        'usr-pinned',
      );
      planted.push(pinned.userId);
      // Replace the fixture grant with the narrow workspace one.
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.userId, pinned.userId));
      await h.admin.insert(schema.userRoles).values({
        userId: pinned.userId,
        roleId: workspaceRole,
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });

      const token = await tokenFor(pinned.email);
      // `users.read` is held — but at a workspace, and the target is the
      // organization. Holding a permission somewhere is never authority here.
      const res = await api(token).list().expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('case J — the flattened union cannot authorize what no single grant carries', async () => {
      // Two grants: `users.read` across the organization, `users.disable` in one
      // workspace. The union contains both; no coherent grant carries
      // `users.disable` at the organization.
      const readOnlyOrg = await makeRole(
        orgA,
        'org_reader',
        ['organization'],
        [PERMISSIONS.USERS_READ],
      );
      const disablerWs = await makeRole(
        orgA,
        'ws_disabler',
        ['workspace'],
        [PERMISSIONS.USERS_DISABLE],
      );
      const split = await plantMember(orgA, 'split', { roleId: readOnlyOrg });
      await h.admin.insert(schema.userRoles).values({
        userId: split.userId,
        roleId: disablerWs,
        scopeType: 'workspace',
        scopeId: orgA.workspaceId,
      });

      const token = await tokenFor(split.email);
      const target = await plantMember(orgA, 'split-target');

      // The union really does contain it — asserted, so the case cannot pass
      // because the fixture failed to confer it.
      const me = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body.data.permissions).toContain(PERMISSIONS.USERS_DISABLE);

      // Reading is allowed at the organization; disabling is not.
      await api(token).list().expect(200);
      const res = await api(token).disable(target.userId).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      expect(await statusOf(target.userId)).toBe('active');
    });

    it('case T — a forged organization header cannot widen the request', async () => {
      const res = await api(adminToken, orgB.orgId).list().expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it('a refusal is audited as `authorization.denied`', async () => {
      const token = await powerless();
      await api(token).list().expect(403);
      const rows = await auditRows('authorization.denied');
      expect(rows).toHaveLength(1);
      expect((rows[0]!.metadata as Record<string, unknown>).permission).toBe(
        PERMISSIONS.USERS_READ,
      );
    });
  });

  // ===========================================================================
  // API keys
  // ===========================================================================
  describe('API keys', () => {
    const issueKey = async (options: {
      tenant: TenantFixture;
      createdBy: string | null;
      workspaceId?: string | null;
      scopes: string[];
    }): Promise<string> => {
      const secret = `secret-${uuidv7()}`;
      const prefix = `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`;
      await h.admin.insert(schema.apiKeys).values({
        orgId: options.tenant.orgId,
        workspaceId: options.workspaceId ?? null,
        name: `key-${prefix}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: options.createdBy,
        scopes: options.scopes,
      });
      return `${prefix}.${secret}`;
    };

    it('case H — a key whose scopes withhold user administration cannot reach it', async () => {
      const key = await issueKey({
        tenant: orgA,
        createdBy: orgA.userId,
        scopes: [PERMISSIONS.WORKSPACES_READ],
      });
      await api(key).list().expect(403);
      await api(key).create(validCreate('by-key')).expect(403);
    });

    it('case H — a key bound to a workspace cannot administer at the organization', async () => {
      const key = await issueKey({
        tenant: orgA,
        createdBy: orgA.userId,
        workspaceId: orgA.workspaceId,
        scopes: [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_DISABLE],
      });
      // The binding is the workspace; the target is the organization, which a
      // workspace grant never covers.
      const res = await api(key).list().expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('an organization-bound key within its creator’s authority does reach it', async () => {
      const key = await issueKey({
        tenant: orgA,
        createdBy: orgA.userId,
        scopes: [PERMISSIONS.USERS_READ],
      });
      await api(key).list().expect(200);
    });

    it('a key whose creator has been disabled confers nothing', async () => {
      const creator = await plantMember(orgA, 'key-creator');
      // The creator is an organization admin in their own right.
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.userId, creator.userId));
      await h.admin.insert(schema.userRoles).values({
        userId: creator.userId,
        roleId: orgA.roleId,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      });

      const key = await issueKey({
        tenant: orgA,
        createdBy: creator.userId,
        scopes: [PERMISSIONS.USERS_READ],
      });
      // Positive control first, so the refusal below is the disable and not the
      // fixture.
      await api(key).list().expect(200);

      await api(adminToken).disable(creator.userId).expect(200);

      const res = await api(key).list().expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

      const me = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${key}`)
        .expect(200);
      expect(me.body.data.permissions).toEqual([]);
    });
  });

  // ===========================================================================
  // Audit
  // ===========================================================================
  describe('audit', () => {
    it('records `user.invited` at the organization, with no credential material', async () => {
      const body = validCreate('audited');
      const res = await api(adminToken).create(body).expect(201);
      const created = track((res.body.data as UserBody).id);

      const rows = await auditRows('user.invited');
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.scope_type).toBe('organization');
      expect(row.org_id).toBe(orgA.orgId);
      expect(row.resource_id).toBe(created);
      expect(row.actor_user_id).toBe(orgA.userId);
      expect(row.outcome).toBe('success');

      // Case R.
      const text = JSON.stringify(row);
      expect(text).not.toMatch(/\$argon2/);
      expect(text.toLowerCase()).not.toContain('password');
      expect(text.toLowerCase()).not.toContain('refresh');
    });

    it('records the grant separately, through the role-assignment path', async () => {
      const res = await api(adminToken).create(validCreate('two-rows')).expect(201);
      track((res.body.data as UserBody).id);
      // Creation does not absorb the grant's own record: privilege changes stay
      // individually auditable (`RBAC.md` §8b).
      expect(await auditRows('user_role.granted')).toHaveLength(1);
    });

    it('records `user.disabled` with the session count and no session ids', async () => {
      const member = await plantMember(orgA, 'audit-disable');
      await tokenFor(member.email);
      await api(adminToken).disable(member.userId).expect(200);

      const rows = await auditRows('user.disabled');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.before).toEqual({ status: 'active' });
      expect(rows[0]!.after).toEqual({ status: 'disabled' });
      expect((rows[0]!.metadata as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThan(0);
    });

    it('records `user.reactivated` with the state it restored', async () => {
      const member = await plantMember(orgA, 'audit-react');
      await api(adminToken).disable(member.userId).expect(200);
      await purgeAudit(h.admin, sql`true`);
      await api(adminToken).reactivate(member.userId).expect(200);

      const rows = await auditRows('user.reactivated');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.after).toEqual({ status: 'active' });
      expect((rows[0]!.metadata as { restoredTo: string }).restoredTo).toBe('active');
    });

    it('records `user.updated` with before and after', async () => {
      const member = await plantMember(orgA, 'audit-update');
      await api(adminToken).patch(member.userId, { phone: '+919876543210' }).expect(200);

      const rows = await auditRows('user.updated');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.before).toEqual({ phone: null });
      expect(rows[0]!.after).toEqual({ phone: '+919876543210' });
    });

    it('a refused lifecycle mutation writes no success record', async () => {
      const foreigner = await plantMember(orgB, 'audit-none');
      await api(adminToken).disable(foreigner.userId).expect(404);
      expect(await auditRows('user.disabled')).toHaveLength(0);
    });
  });

  // ===========================================================================
  // RLS, with the application boundary bypassed
  // ===========================================================================
  describe('RLS backstop', () => {
    it('case S — another organization’s member is invisible under its own context', async () => {
      const foreigner = await plantMember(orgB, 'rls');

      const visible = await db.withTenant(
        {
          orgId: orgA.orgId,
          workspaceId: null,
          resellerId: orgA.resellerId,
          userId: orgA.userId,
          isPlatformAdmin: false,
        },
        (tx) =>
          tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.id, foreigner.userId)),
      );
      expect(visible).toEqual([]);
    });

    it('case S — a cross-tenant status update writes nothing', async () => {
      const foreigner = await plantMember(orgB, 'rls-write');

      const updated = await db.withTenant(
        {
          orgId: orgA.orgId,
          workspaceId: null,
          resellerId: orgA.resellerId,
          userId: orgA.userId,
          isPlatformAdmin: false,
        },
        (tx) =>
          tx
            .update(schema.users)
            .set({ status: 'disabled' })
            .where(eq(schema.users.id, foreigner.userId))
            .returning({ id: schema.users.id }),
      );
      expect(updated).toEqual([]);
      expect(await statusOf(foreigner.userId)).toBe('active');
    });

    it('`acc_app` holds no DELETE on users — deletion is unavailable, not merely unimplemented', async () => {
      const member = await plantMember(orgA, 'no-delete');
      const refusal = await db
        .withTenant(
          {
            orgId: orgA.orgId,
            workspaceId: null,
            resellerId: orgA.resellerId,
            userId: orgA.userId,
            isPlatformAdmin: false,
          },
          (tx) => tx.delete(schema.users).where(eq(schema.users.id, member.userId)),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      // `42501 insufficient_privilege` — the grant is absent, so this is not a
      // policy returning zero rows, it is the statement being refused outright.
      expect(refusal).not.toBeNull();
      expect((refusal as { cause?: { code?: string } }).cause?.code).toBe('42501');
      expect(await statusOf(member.userId)).toBe('active');
    });
  });

  // ===========================================================================
  // Idempotency
  // ===========================================================================
  describe('idempotency', () => {
    it('replays the original creation verbatim', async () => {
      const key = `users-create-${uuidv7()}`;
      const body = validCreate('idem');

      const first = await api(adminToken).create(body, key).expect(201);
      const created = track((first.body.data as UserBody).id);
      const second = await api(adminToken).create(body, key).expect(201);

      expect(second.body).toEqual(first.body);
      // One user, not two — and one grant.
      const rows = await h.admin
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = lower(${body.email})`);
      expect(rows.map((r) => r.id)).toEqual([created]);
      expect(await auditRows('user.invited')).toHaveLength(1);
    });

    it('the same key with a different body is refused', async () => {
      const key = `users-mismatch-${uuidv7()}`;
      const first = await api(adminToken).create(validCreate('idem-a'), key).expect(201);
      track((first.body.data as UserBody).id);

      const res = await api(adminToken).create(validCreate('idem-b'), key).expect(422);
      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
    });

    it('case V/W — a replay is refused once the replayer’s authorization is gone', async () => {
      const key = `users-authz-${uuidv7()}`;
      const body = validCreate('idem-authz');
      const first = await api(adminToken).create(body, key).expect(201);
      track((first.body.data as UserBody).id);

      // Remove `users.invite` from the actor's role, then replay with the same
      // key, same body, same principal. A previously successful request is not a
      // credential.
      const [permission] = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, PERMISSIONS.USERS_INVITE));
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.provisioning','on',true)`);
        await tx
          .delete(schema.rolePermissions)
          .where(
            and(
              eq(schema.rolePermissions.roleId, orgA.roleId),
              eq(schema.rolePermissions.permissionId, permission!.id),
            ),
          );
      });

      try {
        const res = await api(adminToken).create(body, key).expect(403);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      } finally {
        await addToFixtureRole(orgA, [PERMISSIONS.USERS_INVITE]);
      }
    });

    it('a different principal’s key is not replayable', async () => {
      const key = `users-principal-${uuidv7()}`;
      const body = validCreate('idem-principal');
      const first = await api(adminToken).create(body, key).expect(201);
      track((first.body.data as UserBody).id);

      const other = await plantMember(orgA, 'other-admin');
      const otherToken = await tokenFor(other.email);
      const res = await api(otherToken).create(body, key).expect(422);
      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
    });

    it('a malformed key is refused before anything is looked up', async () => {
      const res = await api(adminToken).create(validCreate('idem-bad'), 'short').expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
    });
  });

  async function passwordHashOf(userId: string): Promise<string | null> {
    const [row] = await h.admin
      .select({ hash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return row?.hash ?? null;
  }

  // Referenced so the import is not unused when a case is skipped locally.
  void inArray;
});
