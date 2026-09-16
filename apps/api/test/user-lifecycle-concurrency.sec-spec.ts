/**
 * User lifecycle under concurrency, and the last-platform-admin invariant as the
 * new disable endpoint reaches it (Phase 1B.6.1, ADR-005 D-7).
 *
 * Phase 1B.5.6 proved the invariant through role revocation and through the
 * cascade from deleting a user. `POST /users/:id/disable` is the **first HTTP
 * surface for the second violation path** the trigger was written for —
 * `trg_users_platform_admin_liveness`, `AFTER UPDATE OF status` — so this suite
 * exists to prove that path end to end rather than to re-prove the trigger.
 *
 * **Every race case asserts the final database state, not the status codes.** A
 * lifecycle that returns the right answers while reaching a forbidden state has
 * failed, so `admins()` is re-read after each one. The status codes are asserted
 * too, because "both callers got a 409 and nothing happened" is also a failure —
 * just a different one.
 *
 * The suite owns the platform-admin population outright, for the reason
 * `platform-admin-liveness.sec-spec.ts` gives: reasoning about "the last
 * administrator" against a floating baseline is how a liveness test comes to
 * pass for the wrong reason.
 */
import { ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

describe('user lifecycle under concurrency', () => {
  let h: Harness;
  let credentials: CredentialService;
  let orgA: TenantFixture;
  let superAdminRoleId: string;
  let narrowRoleId: string;
  let adminToken: string;
  /** Every user this suite planted, for teardown. */
  const planted: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'lifecycle', credentials);

    const [role] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN));
    superAdminRoleId = role!.id;

    await addToFixtureRole([
      PERMISSIONS.USERS_READ,
      PERMISSIONS.USERS_INVITE,
      PERMISSIONS.USERS_DISABLE,
      PERMISSIONS.USERS_REACTIVATE,
      PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
      PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE,
    ]);
    narrowRoleId = await makeNarrowRole();

    adminToken = await tokenFor(orgA.email);
    await clearEveryAdmin();
  }, 90_000);

  afterAll(async () => {
    await removePlanted();
    await destroyTenant(h.admin, orgA);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(async () => {
    await purgeAudit(h.admin, sql`true`);
    await removePlanted();
    await clearEveryAdmin();
  });

  // --- fixtures ---------------------------------------------------------------

  async function addToFixtureRole(permissions: readonly string[]): Promise<void> {
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
            .values({ roleId: orgA.roleId, permissionId: permission.id })
            .onConflictDoNothing();
        }
      }
    });
  }

  async function makeNarrowRole(): Promise<string> {
    const [role] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: orgA.orgId,
        key: 'lifecycle_member',
        name: 'lifecycle_member',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      })
      .returning({ id: schema.roles.id });
    const [permission] = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, PERMISSIONS.WORKSPACES_READ));
    await h.admin
      .insert(schema.rolePermissions)
      .values({ roleId: role!.id, permissionId: permission!.id })
      .onConflictDoNothing();
    return role!.id;
  }

  /** An ordinary active member of Organization A. */
  async function plantMember(label: string): Promise<{ userId: string; email: string }> {
    const email = `${label}-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
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
    planted.push(user!.id);
    return { userId: user!.id, email };
  }

  /**
   * An active platform administrator who is **also** a member of Organization A.
   *
   * Both grants are needed and for different reasons: the platform grant is what
   * makes them an administrator for the invariant, and the organization grant is
   * what makes them a member the endpoint can reach. The insert declares
   * `app.is_platform_admin` transaction-locally exactly as `seed.ts` and the
   * bootstrap CLI do — `fn_validate_user_role_scope` refuses a platform grant
   * from anyone else, and that guard is not weakened for tests.
   */
  async function plantAdminMember(label: string): Promise<{ userId: string; email: string }> {
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
      await tx.insert(schema.userRoles).values({
        userId: user!.id,
        roleId: orgA.roleId,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      });
      return user!.id;
    });
    planted.push(userId);
    return { userId, email };
  }

  async function removePlanted(): Promise<void> {
    if (planted.length === 0) return;
    const ids = planted.splice(0);
    await purgeAudit(h.admin, sql`true`);
    await h.admin.transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        await tx.delete(schema.sessions).where(inArray(schema.sessions.userId, ids));
        await tx.delete(schema.userRoles).where(inArray(schema.userRoles.userId, ids));
        await tx.delete(schema.users).where(inArray(schema.users.id, ids));
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
    });
    await h.admin.execute(sql`DELETE FROM idempotency_keys WHERE true`);
  }

  async function clearEveryAdmin(): Promise<void> {
    await h.admin.transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        await tx.execute(sql`DELETE FROM user_roles WHERE scope_type = 'platform'`);
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
    });
  }

  /** The invariant's own count, exactly as the trigger computes it. */
  async function admins(): Promise<number> {
    const { rows } = await h.admin.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM user_roles ur
      JOIN users u ON u.id = ur.user_id
      WHERE ur.scope_type = 'platform' AND u.status = 'active'
    `);
    return Number(rows[0]!.count);
  }

  async function statusOf(userId: string): Promise<string> {
    const [row] = await h.admin
      .select({ status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return row!.status;
  }

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  const disable = (id: string, token = adminToken) =>
    request(h.app.getHttpServer())
      .post(url(`/users/${id}/disable`))
      .set('authorization', `Bearer ${token}`)
      .set('x-acc-organization', orgA.orgId);

  const reactivate = (id: string, token = adminToken) =>
    request(h.app.getHttpServer())
      .post(url(`/users/${id}/reactivate`))
      .set('authorization', `Bearer ${token}`)
      .set('x-acc-organization', orgA.orgId);

  const createUser = (email: string, key?: string) => {
    const r = request(h.app.getHttpServer())
      .post(url('/users'))
      .set('authorization', `Bearer ${adminToken}`)
      .set('x-acc-organization', orgA.orgId);
    if (key) r.set('idempotency-key', key);
    return r.send({
      email,
      initialRole: { roleId: narrowRoleId, scopeType: 'organization', scopeId: orgA.orgId },
    });
  };

  const revokeGrant = (assignmentId: string) =>
    request(h.app.getHttpServer())
      .delete(url(`/role-assignments/${assignmentId}`))
      .set('authorization', `Bearer ${adminToken}`)
      .set('x-acc-organization', orgA.orgId);

  async function platformAssignmentFor(userId: string): Promise<string> {
    const [row] = await h.admin
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(
        sql`${schema.userRoles.userId} = ${userId} AND ${schema.userRoles.scopeType} = 'platform'`,
      );
    return row!.id;
  }

  // ===========================================================================
  // The last platform administrator
  // ===========================================================================
  describe('last platform administrator', () => {
    it('case L — disabling the only active administrator is refused', async () => {
      const only = await plantAdminMember('only');
      expect(await admins()).toBe(1);

      const res = await disable(only.userId).expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_LAST_PLATFORM_ADMIN);
      // 409 rather than 403: the actor held the authority; the platform may not
      // enter that state.
      expect(res.body.error.code).not.toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);

      expect(await statusOf(only.userId)).toBe('active');
      expect(await admins()).toBe(1);
    });

    it('disabling one of two administrators succeeds', async () => {
      const first = await plantAdminMember('first');
      await plantAdminMember('second');
      expect(await admins()).toBe(2);

      await disable(first.userId).expect(200);
      expect(await statusOf(first.userId)).toBe('disabled');
      expect(await admins()).toBe(1);
    });

    it('the refusal leaves no audit record of a disable that did not happen', async () => {
      const only = await plantAdminMember('audit-none');
      await disable(only.userId).expect(409);
      const { rows } = await h.admin.execute(
        sql`SELECT 1 FROM audit_logs WHERE action = 'user.disabled'`,
      );
      expect(rows).toHaveLength(0);
    });

    it('the refusal rolls back the session revocation with it', async () => {
      const only = await plantAdminMember('sessions-intact');
      await tokenFor(only.email);
      await disable(only.userId).expect(409);

      const sessions = await h.admin
        .select({ revokedAt: schema.sessions.revokedAt })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, only.userId));
      expect(sessions.length).toBeGreaterThan(0);
      for (const s of sessions) expect(s.revokedAt).toBeNull();
    });

    it('case M — the trigger refuses it with the service bypassed entirely', async () => {
      const only = await plantAdminMember('bypass');

      const refusal = await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, only.userId))
        .then(
          () => null,
          (error: unknown) => error as { cause?: { code?: string; message?: string } },
        );

      expect(refusal).not.toBeNull();
      // `23001 restrict_violation`, raised by `fn_assert_platform_admin_remains`
      // — the database's own refusal, reached with no service in the path.
      expect(refusal!.cause?.code).toBe('23001');
      expect(refusal!.cause?.message).toMatch(/no active administrator/i);

      expect(await admins()).toBe(1);
    });

    it('once another administrator exists the same disable succeeds', async () => {
      const only = await plantAdminMember('blocked');
      await disable(only.userId).expect(409);

      await plantAdminMember('reinforcement');
      await disable(only.userId).expect(200);
      expect(await admins()).toBe(1);
    });

    it('a reactivated administrator counts again', async () => {
      const first = await plantAdminMember('cycle-a');
      await plantAdminMember('cycle-b');
      await disable(first.userId).expect(200);
      expect(await admins()).toBe(1);

      await reactivate(first.userId).expect(200);
      expect(await admins()).toBe(2);
    });
  });

  // ===========================================================================
  // Races. Final database state is the assertion.
  // ===========================================================================
  describe('races', () => {
    it('two simultaneous disables of the same user produce one winner', async () => {
      const member = await plantMember('race-same');
      const [a, b] = await Promise.all([
        disable(member.userId).then((r) => r.status),
        disable(member.userId).then((r) => r.status),
      ]);

      expect([a, b].filter((s) => s === 200)).toHaveLength(1);
      expect([a, b].filter((s) => s === 409)).toHaveLength(1);
      expect(await statusOf(member.userId)).toBe('disabled');
    });

    it('two simultaneous reactivations of the same user produce one winner', async () => {
      const member = await plantMember('race-react');
      await disable(member.userId).expect(200);

      const [a, b] = await Promise.all([
        reactivate(member.userId).then((r) => r.status),
        reactivate(member.userId).then((r) => r.status),
      ]);
      expect([a, b].filter((s) => s === 200)).toHaveLength(1);
      expect([a, b].filter((s) => s === 409)).toHaveLength(1);
      expect(await statusOf(member.userId)).toBe('active');
    });

    it('two administrators disabling each other cannot both succeed', async () => {
      // The textbook write skew: each transaction counts two administrators,
      // each decides its own removal is safe, each removes a *different* one.
      // Nothing about the rows they write overlaps, so only the advisory lock
      // serialises them.
      const first = await plantAdminMember('skew-a');
      const second = await plantAdminMember('skew-b');
      expect(await admins()).toBe(2);

      const [a, b] = await Promise.all([
        disable(first.userId).then((r) => r.status),
        disable(second.userId).then((r) => r.status),
      ]);

      expect([a, b].filter((s) => s === 200)).toHaveLength(1);
      expect([a, b].filter((s) => s === 409)).toHaveLength(1);
      // The invariant, read from the database rather than inferred.
      expect(await admins()).toBe(1);
    });

    it('disabling one administrator while the other’s grant is revoked keeps one alive', async () => {
      const first = await plantAdminMember('mixed-a');
      const second = await plantAdminMember('mixed-b');
      const secondAssignment = await platformAssignmentFor(second.userId);

      const [disabled, revoked] = await Promise.all([
        disable(first.userId).then((r) => r.status),
        revokeGrant(secondAssignment).then((r) => r.status),
      ]);

      // Whichever order they land in, exactly one of the two removals may
      // succeed — the other meets an invariant that is already at its floor.
      expect([disabled, revoked].filter((s) => s === 200 || s === 204)).toHaveLength(1);
      expect(await admins()).toBe(1);
    });

    it('three simultaneous disables of three administrators leave one', async () => {
      const a = await plantAdminMember('three-a');
      const b = await plantAdminMember('three-b');
      const c = await plantAdminMember('three-c');
      expect(await admins()).toBe(3);

      const results = await Promise.all(
        [a, b, c].map((u) => disable(u.userId).then((r) => r.status)),
      );
      expect(results.filter((s) => s === 200)).toHaveLength(2);
      expect(results.filter((s) => s === 409)).toHaveLength(1);
      expect(await admins()).toBe(1);
    });

    it('a concurrent grant to a user being disabled leaves a coherent state', async () => {
      const member = await plantMember('grant-vs-disable');

      const grant = () =>
        request(h.app.getHttpServer())
          .post(url('/role-assignments'))
          .set('authorization', `Bearer ${adminToken}`)
          .set('x-acc-organization', orgA.orgId)
          .send({
            userId: member.userId,
            roleId: narrowRoleId,
            scopeType: 'organization',
            scopeId: orgA.orgId,
          })
          .then((r) => r.status);

      const [granted, disabled] = await Promise.all([
        grant(),
        disable(member.userId).then((r) => r.status),
      ]);

      expect(disabled).toBe(200);
      expect(await statusOf(member.userId)).toBe('disabled');
      // The grant either landed before the disable (201) or was refused because
      // the user was already disabled (409). Both are coherent; a grant to a
      // user the same instant reported as disabled, with no record either way,
      // would not be.
      expect([201, 409]).toContain(granted);
      const grants = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(
          sql`${schema.userRoles.userId} = ${member.userId} AND ${schema.userRoles.roleId} = ${narrowRoleId}`,
        );
      expect(grants.length).toBe(granted === 201 ? 1 : 0);
    });

    it('two simultaneous creations of the same address produce exactly one user', async () => {
      const email = `race-create-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;

      const [a, b] = await Promise.all([
        createUser(email).then((r) => ({ status: r.status, id: r.body?.data?.id as string })),
        createUser(email).then((r) => ({ status: r.status, id: r.body?.data?.id as string })),
      ]);

      const statuses = [a.status, b.status];
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(1);

      const rows = await h.admin
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = lower(${email})`);
      expect(rows).toHaveLength(1);
      planted.push(rows[0]!.id);

      // And exactly one grant, so the loser left nothing behind.
      const grants = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.userId, rows[0]!.id));
      expect(grants).toHaveLength(1);
    });

    it('two simultaneous creations under one idempotency key produce one user and one answer', async () => {
      const email = `race-idem-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const key = `race-key-${uuidv7()}`;

      const [a, b] = await Promise.all([
        createUser(email, key).then((r) => ({ status: r.status, body: r.body })),
        createUser(email, key).then((r) => ({ status: r.status, body: r.body })),
      ]);

      // The duplicate blocks on the original's row lock and then replays it, so
      // both see the same created resource rather than one seeing a conflict.
      const created = [a, b].filter((r) => r.status === 201);
      expect(created).toHaveLength(2);
      expect(created[0]!.body).toEqual(created[1]!.body);

      const rows = await h.admin
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = lower(${email})`);
      expect(rows).toHaveLength(1);
      planted.push(rows[0]!.id);
    });

    it('a request in flight when its user is disabled does not survive the next one', async () => {
      const member = await plantMember('inflight');
      const token = await tokenFor(member.email);

      const [meBefore, disabled] = await Promise.all([
        request(h.app.getHttpServer())
          .get(url('/auth/me'))
          .set('authorization', `Bearer ${token}`)
          .then((r) => r.status),
        disable(member.userId).then((r) => r.status),
      ]);

      expect(disabled).toBe(200);
      // The concurrent request may have been admitted or refused depending on
      // which transaction committed first — both are correct, and asserting one
      // would be asserting a scheduling accident.
      expect([200, 401]).toContain(meBefore);

      // What is *not* ambiguous: after the disable has committed, the same
      // unexpired token is refused.
      const after = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(401);
      expect([ERROR_CODES.AUTH_ACCOUNT_DISABLED, ERROR_CODES.AUTH_SESSION_REVOKED]).toContain(
        after.body.error.code,
      );
    });

    it('a refresh racing a disable never yields a usable session', async () => {
      const member = await plantMember('refresh-race');
      await h.clearRateLimits();
      const login = await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: member.email, password: PASSWORD })
        .expect(200);
      const cookie = login.headers['set-cookie'] as unknown as string[];

      const [refreshStatus, disableStatus] = await Promise.all([
        request(h.app.getHttpServer())
          .post(url('/auth/refresh'))
          .set('cookie', cookie)
          .set(CSRF_HEADER, '1')
          .then((r) => ({ status: r.status, token: r.body?.data?.accessToken as string })),
        disable(member.userId).then((r) => r.status),
      ]);

      expect(disableStatus).toBe(200);

      // Whether the rotation won the race or not, nothing it produced works
      // afterwards: the user state is re-read on every request.
      if (refreshStatus.status === 200) {
        await request(h.app.getHttpServer())
          .get(url('/auth/me'))
          .set('authorization', `Bearer ${refreshStatus.token}`)
          .expect(401);
      } else {
        expect(refreshStatus.status).toBe(401);
      }

      // And a further refresh is refused outright.
      await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('cookie', cookie)
        .set(CSRF_HEADER, '1')
        .expect(401);
    });
  });
});
