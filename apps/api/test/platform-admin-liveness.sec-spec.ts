/**
 * The at-least-one-active-platform-admin invariant (Phase 1B.5.6, ADR-005 D-7).
 *
 * The invariant, stated exactly:
 *
 *   At every committed state there exists at least one user `u` with
 *   `u.status = 'active'` holding a grant of a platform role at `platform`
 *   scope.
 *
 * "Active" is load-bearing — a disabled user cannot authenticate, so the grant
 * confers nothing — and the definition is the authorization model's own:
 * `ScopeResolver` derives `isPlatformAdmin` as "holds some grant at platform
 * scope". This suite does not invent a second notion of administrator.
 *
 * **Every race case asserts the final database state, not just the HTTP status.**
 * An invariant that returns the right status codes while reaching a forbidden
 * state has failed, so `admins()` is re-read after each one and must be `>= 1`.
 *
 * The four paths that can violate it, and where each is closed:
 *
 *   1. revoking the grant        `DELETE /role-assignments/:id` → `409`;
 *                                trigger underneath it
 *   2. disabling the holder      no HTTP surface yet (Phase 1B.6); trigger
 *   3. deleting the holder       cascade to `user_roles`; trigger
 *   4. deleting the role         already closed by `ON DELETE RESTRICT` (0004)
 *                                and by platform roles being unmodifiable
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { PLATFORM_ADMIN_LOCK_KEY, schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import {
  PASSWORD,
  PREFIX,
  addSpareAdmin,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

describe('last-platform-admin invariant', () => {
  let h: Harness;
  let credentials: CredentialService;
  let db: TenantDatabase;
  let orgA: TenantFixture;
  let superAdminRoleId: string;
  let supportRoleId: string;
  /** Platform administrators this suite created, for teardown. */
  const planted: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    db = h.app.get(TenantDatabase);
    orgA = await createTenant(h.admin, 'liveness', credentials);
    // Case B revokes the fixture's own org_admin grant; a second administrator
    // keeps the last-organization-administrator rule (ADR-015 R-11) out of it.
    await addSpareAdmin(h.admin, orgA);

    const [role] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN));
    superAdminRoleId = role!.id;
    const [support] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT));
    supportRoleId = support!.id;

    // This suite owns the platform-admin population outright, so its counts are
    // absolute rather than relative to whatever a previous suite left behind.
    // Reasoning about "the last administrator" against a floating baseline is
    // how a liveness test comes to pass for the wrong reason.
    await clearEveryAdmin();
  }, 90_000);

  afterAll(async () => {
    await removeAllPlanted();
    await destroyTenant(h.admin, orgA);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(async () => {
    await purgeAudit(h.admin, sql`true`);
    await removeAllPlanted();
    // Each case starts from zero administrators, so "the last one" means it.
    await clearEveryAdmin();
  });

  // --- fixtures --------------------------------------------------------------

  /**
   * Plants an active platform administrator.
   *
   * The insert declares `app.is_platform_admin` transaction-locally, exactly as
   * `seed.ts` and the bootstrap CLI do: `fn_validate_user_role_scope` refuses a
   * platform grant from anyone else, and that guard is not weakened for tests.
   */
  async function plantAdmin(label: string): Promise<{ userId: string; email: string }> {
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
    planted.push(userId);
    return { userId, email };
  }

  /**
   * Tears every planted administrator down at once.
   *
   * One statement, because removing them one at a time would hit the very
   * invariant under test on the last one. The trigger is disabled for the
   * duration — the same capability `purgeAudit` already uses against the
   * append-only trigger, and the same reasoning: the honest way past a database
   * guarantee is table ownership, not a back door carved into the guard.
   */
  async function removeAllPlanted(): Promise<void> {
    if (planted.length === 0) return;
    const ids = planted.splice(0);
    // Audit rows reference the actor, so the trail goes before the identities.
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
  }

  /** The invariant's own count, as the trigger computes it. */
  /**
   * Removes every platform grant in the database, trigger disabled.
   *
   * The same capability `purgeAudit` already uses against the append-only
   * trigger, and the same reasoning: the honest way past a database guarantee is
   * table ownership, not a back door carved into the guard itself.
   */
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

  /**
   * The invariant's own count, as migration `0010` defines it: active holders of
   * `alendei_super_admin` at platform scope. A support grant is platform-scoped
   * and deliberately not counted.
   */
  async function admins(): Promise<number> {
    const { rows } = await h.admin.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM user_roles ur
      JOIN users u ON u.id = ur.user_id
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.scope_type = 'platform' AND u.status = 'active'
        AND r.org_id IS NULL AND r.key = 'alendei_super_admin'
    `);
    return Number(rows[0]!.count);
  }

  /** Plants an active user holding only `alendei_support` at platform scope. */
  async function plantSupport(label: string): Promise<{ userId: string; assignmentId: string }> {
    const email = `${label}-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
    const result = await h.admin.transaction(async (tx) => {
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
      const [grant] = await tx
        .insert(schema.userRoles)
        .values({ userId: user!.id, roleId: supportRoleId, scopeType: 'platform' })
        .returning({ id: schema.userRoles.id });
      return { userId: user!.id, assignmentId: grant!.id };
    });
    planted.push(result.userId);
    return result;
  }

  async function supportGrantsPresent(): Promise<number> {
    const { rows } = await h.admin.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM user_roles WHERE role_id = ${supportRoleId} AND scope_type = 'platform'`);
    return Number(rows[0]!.count);
  }

  async function assignmentIdFor(userId: string): Promise<string> {
    const [row] = await h.admin
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, userId));
    return row!.id;
  }

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  /**
   * Revokes as a platform administrator, naming the organization explicitly.
   *
   * A platform admin can see every organization, so when more than one exists it
   * has no *unambiguous* resolved organization and `RoleAssignmentService`
   * refuses with `400 TENANCY_CONTEXT_REQUIRED` — correctly, since that is the
   * documented multi-organization selection rule (`TENANCY.md` §2a). Without the
   * header this suite's result depended on how many organizations other suites
   * had left behind, which is a test defect rather than a behaviour.
   */
  const revoke = (token: string, id: string) =>
    request(h.app.getHttpServer())
      .delete(url(`/role-assignments/${id}`))
      .set('authorization', `Bearer ${token}`)
      .set('x-acc-organization', orgA.orgId);

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
  describe('A. the definition', () => {
    it('the migration and @acc/db agree on the advisory-lock key', async () => {
      // A second key would silently disable the guarantee, so the constant and
      // the trigger are asserted equal rather than trusted to stay in step.
      const { rows } = await h.admin.execute<{ src: string }>(
        sql`SELECT prosrc AS src FROM pg_proc WHERE proname = 'fn_assert_platform_admin_remains'`,
      );
      expect(rows[0]!.src).toContain(String(PLATFORM_ADMIN_LOCK_KEY));
    });

    it('the invariant is serialised by the advisory lock, not merely counted', async () => {
      // The race tests below catch the lock's removal only probabilistically —
      // that is what a race is. This catches it every time: without
      // `pg_advisory_xact_lock` the count is a bare read and the write skew
      // ADR-005 D-7 describes is reachable again.
      const { rows } = await h.admin.execute<{ src: string }>(
        sql`SELECT prosrc AS src FROM pg_proc WHERE proname = 'fn_assert_platform_admin_remains'`,
      );
      expect(rows[0]!.src).toContain('pg_advisory_xact_lock');
    });

    it('both mutator paths are guarded by triggers', async () => {
      const { rows } = await h.admin.execute<{ tgname: string; tgrelid: string }>(sql`
        SELECT tgname, tgrelid::regclass::text AS tgrelid FROM pg_trigger
        WHERE tgname IN ('trg_user_roles_platform_admin_liveness',
                         'trg_users_platform_admin_liveness')
          AND NOT tgisinternal
      `);
      expect(rows.map((r) => r.tgrelid).sort()).toEqual(['user_roles', 'users']);
    });

    it('counts only active users holding a grant at platform scope', async () => {
      const before = await admins();
      const admin = await plantAdmin('def-active');
      expect(await admins()).toBe(before + 1);

      // A disabled holder stops counting — but only while another remains, or
      // the invariant itself would refuse the disable.
      await plantAdmin('def-spare');
      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, admin.userId));
      expect(await admins()).toBe(before + 1);
    });

    it('a reseller-scoped grant of a platform role does not count', async () => {
      // `reseller_admin` is a platform role, but granted at reseller scope it
      // confers no platform reach — `isPlatformAdmin` is scope-based.
      const before = await admins();
      const [resellerRole] = await h.admin
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.key, PLATFORM_ROLE_KEYS.RESELLER_ADMIN));

      const email = `def-reseller-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
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
        await tx.insert(schema.userRoles).values({
          userId: user!.id,
          roleId: resellerRole!.id,
          scopeType: 'reseller',
          scopeId: orgA.resellerId,
        });
        return user!.id;
      });

      try {
        expect(await admins()).toBe(before);
      } finally {
        await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${userId}`);
        await h.admin.execute(sql`DELETE FROM users WHERE id = ${userId}`);
      }
    });
  });

  // ===========================================================================
  describe('B. revoking through the API', () => {
    it('refuses the last one with 409 and the documented code', async () => {
      const only = await plantAdmin('b-only');
      expect(await admins()).toBe(1);

      const token = await tokenFor(only.email);
      const res = await revoke(token, await assignmentIdFor(only.userId)).expect(409);

      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_LAST_PLATFORM_ADMIN);
      // Not a 403: the actor held the authority; the state is what is refused.
      expect(res.body.error.code).not.toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      expect(await admins()).toBe(1);
    });

    it('allows it when another remains', async () => {
      const first = await plantAdmin('b-first');
      const second = await plantAdmin('b-second');
      expect(await admins()).toBe(2);

      const token = await tokenFor(first.email);
      await revoke(token, await assignmentIdFor(second.userId)).expect(204);
      expect(await admins()).toBe(1);
    });

    it('refuses the second removal once only one is left', async () => {
      const first = await plantAdmin('b-chain-1');
      const second = await plantAdmin('b-chain-2');
      const token = await tokenFor(first.email);

      await revoke(token, await assignmentIdFor(second.userId)).expect(204);
      await revoke(token, await assignmentIdFor(first.userId)).expect(409);
      expect(await admins()).toBe(1);
    });

    it('a refused revocation leaves the assignment intact', async () => {
      const only = await plantAdmin('b-intact');
      const assignmentId = await assignmentIdFor(only.userId);
      const token = await tokenFor(only.email);

      await revoke(token, assignmentId).expect(409);

      const [still] = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.id, assignmentId));
      expect(still).toBeDefined();
    });

    it('writes no user_role.revoked audit row for the refused attempt', async () => {
      const only = await plantAdmin('b-audit');
      const token = await tokenFor(only.email);
      await purgeAudit(h.admin, sql`true`);

      await revoke(token, await assignmentIdFor(only.userId)).expect(409);

      const { rows } = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM audit_logs WHERE action = 'user_role.revoked'`,
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it('ordinary tenant revocation is entirely unaffected', async () => {
      // The guard must not touch anything but platform grants.
      await plantAdmin('b-untouched');
      const admin = await plantAdmin('b-tenant-actor');
      const token = await tokenFor(admin.email);

      const [assignment] = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.userId, orgA.userId));

      await revoke(token, assignment!.id).expect(204);
      expect(await admins()).toBe(2);

      // Put the fixture's own grant back for the suites that follow.
      await h.admin.insert(schema.userRoles).values({
        userId: orgA.userId,
        roleId: orgA.roleId,
        scopeType: 'organization',
        scopeId: orgA.orgId,
      });
    });
  });

  // ===========================================================================
  describe('C. the database backstop, with the service bypassed', () => {
    it('refuses the last grant’s deletion', async () => {
      const only = await plantAdmin('c-delete');
      await expectDbRefusal(
        h.admin.delete(schema.userRoles).where(eq(schema.userRoles.userId, only.userId)),
        /no active administrator/,
      );
      expect(await admins()).toBe(1);
    });

    it('refuses disabling the last administrator', async () => {
      // Path 2: no HTTP surface exists yet, and the database closes it anyway.
      const only = await plantAdmin('c-disable');
      await expectDbRefusal(
        h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, only.userId)),
        /no active administrator/,
      );
      expect(await admins()).toBe(1);
    });

    it('refuses deleting the last administrator’s user row, through the cascade', async () => {
      // Path 3: `user_roles.user_id` cascades, so the DELETE reaches the guarded
      // table even though the statement named `users`.
      const only = await plantAdmin('c-cascade');
      await expectDbRefusal(
        h.admin.delete(schema.users).where(eq(schema.users.id, only.userId)),
        /no active administrator/,
      );
      expect(await admins()).toBe(1);
    });

    it('allows disabling a non-administrator', async () => {
      await plantAdmin('c-spare');
      const email = `c-ordinary-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`;
      const [user] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      try {
        await h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, user!.id));
        expect(await admins()).toBe(1);
      } finally {
        await h.admin.execute(sql`DELETE FROM users WHERE id = ${user!.id}`);
      }
    });

    it('path 4 stays closed: the platform role cannot be deleted while granted', async () => {
      await plantAdmin('c-role');
      await expectDbRefusal(
        h.admin.delete(schema.roles).where(eq(schema.roles.id, superAdminRoleId)),
        // Closed twice over, and the *first* guard wins: 1B.5.4's system-role
        // trigger refuses the delete before `ON DELETE RESTRICT` is consulted.
        // Either refusal keeps the invariant; asserting only the FK would make
        // this fail if the order ever changed, for no security reason.
        /system role .* cannot be deleted|violates foreign key|still referenced/i,
      );
      expect(await admins()).toBe(1);
    });

    it('acc_app cannot bypass it either', async () => {
      const only = await plantAdmin('c-accapp');
      const assignmentId = await assignmentIdFor(only.userId);

      await expectDbRefusal(
        // The administrator's own, genuine platform context — the strongest
        // position `acc_app` can legitimately occupy — still cannot remove the
        // last grant.
        db.withTenant({ isPlatformAdmin: true, userId: only.userId }, (tx) =>
          tx.delete(schema.userRoles).where(eq(schema.userRoles.id, assignmentId)),
        ),
        /no active administrator/,
      );
      expect(await admins()).toBe(1);
    });
  });

  // ===========================================================================
  describe('D. concurrency — the write-skew the invariant exists for', () => {
    it('two concurrent removals of two different admins: exactly one succeeds', async () => {
      // The textbook race. Both transactions count two admins, both consider
      // their own removal safe, both remove a *different* one. Without the
      // advisory lock both commit and zero remain.
      const first = await plantAdmin('d-race-1');
      const second = await plantAdmin('d-race-2');
      expect(await admins()).toBe(2);

      const actor = await plantAdmin('d-race-actor');
      const token = await tokenFor(actor.email);
      // Remove the actor's own grant from the count by revoking it first, so the
      // race really is between the last two.
      await revoke(token, await assignmentIdFor(actor.userId)).expect(204);
      expect(await admins()).toBe(2);

      const tokenA = await tokenFor(first.email);
      const [idA, idB] = [
        await assignmentIdFor(first.userId),
        await assignmentIdFor(second.userId),
      ];

      const [resA, resB] = await Promise.all([revoke(tokenA, idA), revoke(tokenA, idB)]);

      const statuses = [resA.status, resB.status];
      expect(statuses.filter((s) => s === 204)).toHaveLength(1);
      /**
       * The loser is refused — but by which of two controls depends on which
       * transaction commits first, and both answers are correct.
       *
       * `409` when the liveness check refuses it: the invariant is at its floor.
       * `403` when the *actor's own* grant was the one already revoked — the
       * actor here is `first`, so removing `idA` removes its platform authority,
       * and grants are re-read from the database on every request (ADR-003 D-3).
       * The second request then arrives with no authority to revoke anything.
       *
       * `404` when that same loss of authority reaches the database first:
       * since migration `0010`, `app_is_platform_admin()` re-reads the grant
       * inside the second transaction, so once `idA`'s removal has committed
       * the platform claim is no longer honoured and RLS hides the platform
       * grant outright — the stronger form of the `403`.
       *
       * Pinning this to `409` asserted a scheduling accident, which is why it
       * failed on roughly half of runs. What the case is actually about is
       * below, and it is unconditional.
       */
      expect([403, 404, 409]).toContain(statuses.find((s) => s !== 204));
      // The assertion that matters: the final state, not the status codes.
      expect(await admins()).toBe(1);
    });

    it('two concurrent removals of the SAME final admin cannot reach zero', async () => {
      const only = await plantAdmin('d-same-1');
      const spare = await plantAdmin('d-same-2');
      const token = await tokenFor(only.email);
      const spareId = await assignmentIdFor(spare.userId);

      const [a, b] = await Promise.all([revoke(token, spareId), revoke(token, spareId)]);
      // One deletes it, the other finds it gone.
      expect([a.status, b.status].sort()).toEqual([204, 404]);
      expect(await admins()).toBe(1);
    });

    it('a removal racing a disable cannot reach zero', async () => {
      const first = await plantAdmin('d-mix-1');
      const second = await plantAdmin('d-mix-2');
      expect(await admins()).toBe(2);

      // A third administrator drives the race: an actor that is itself one of
      // the two subjects would disable its own session mid-request and fail
      // with `401`, which proves nothing about the invariant.
      const actor = await plantAdmin('d-mix-actor');
      const token = await tokenFor(actor.email);
      const idB = await assignmentIdFor(second.userId);

      const [revocation, disable] = await Promise.all([
        revoke(token, idB).then((r) => r.status),
        h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, first.userId))
          .then(
            () => 'disabled' as const,
            () => 'refused' as const,
          ),
      ]);

      // Whichever interleaving occurred, one of the two had to lose.
      expect([204, 409]).toContain(revocation);
      expect(['disabled', 'refused']).toContain(disable);
      expect(await admins()).toBeGreaterThanOrEqual(1);
    });

    it('four concurrent removals against two admins still leave one', async () => {
      const first = await plantAdmin('d-four-1');
      const second = await plantAdmin('d-four-2');
      const token = await tokenFor(first.email);
      const idA = await assignmentIdFor(first.userId);
      const idB = await assignmentIdFor(second.userId);

      const results = await Promise.all([
        revoke(token, idA),
        revoke(token, idB),
        revoke(token, idA),
        revoke(token, idB),
      ]);

      expect(results.some((r) => r.status === 204)).toBe(true);
      expect(await admins()).toBe(1);
    });

    it('a removal racing a cascade delete of the other admin cannot reach zero', async () => {
      // The two different mutators of the invariant, at once: the API revoking
      // one grant while the other administrator's user row is deleted outright.
      // Both mutators aimed at the same administrator, by different mechanisms,
      // while only one other remains. The actor is the survivor — it has to be,
      // because an actor that removed its own last grant would lose its tenant
      // context and fail the *next* request for an unrelated reason, proving
      // nothing about the invariant. The two-different-admins write-skew is the
      // preceding case; this one is the two-paths race.
      const survivor = await plantAdmin('d-cascade-1');
      const doomed = await plantAdmin('d-cascade-2');
      const token = await tokenFor(survivor.email);
      expect(await admins()).toBe(2);

      const [revocation, cascade] = await Promise.all([
        revoke(token, await assignmentIdFor(doomed.userId)).then((r) => r.status),
        h.admin
          .delete(schema.users)
          .where(eq(schema.users.id, doomed.userId))
          .then(
            () => 'deleted' as const,
            () => 'refused' as const,
          ),
      ]);

      // Either path may win; the loser finds its subject already gone.
      expect([204, 404, 409]).toContain(revocation);
      expect(['deleted', 'refused']).toContain(cascade);
      // The only assertion that matters.
      expect(await admins()).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  describe('E. no bypass', () => {
    it('a tenant principal cannot reach a platform assignment at all', async () => {
      const only = await plantAdmin('e-tenant');
      const assignmentId = await assignmentIdFor(only.userId);

      const tenantToken = await tokenFor(orgA.email);
      // RLS hides a platform grant from a tenant context entirely, so this is
      // `404` — never a confirmation that it exists.
      const res = await revoke(tenantToken, assignmentId);
      expect([403, 404]).toContain(res.status);
      expect(await admins()).toBe(1);
    });

    it('an API key cannot bypass it', async () => {
      const only = await plantAdmin('e-key');
      const assignmentId = await assignmentIdFor(only.userId);

      const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
      const secret = uuidv7();
      await h.admin.insert(schema.apiKeys).values({
        orgId: orgA.orgId,
        name: 'liveness-key',
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        createdBy: orgA.userId,
        scopes: [PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE],
      });

      try {
        const res = await revoke(`${prefix}.${secret}`, assignmentId);
        expect([401, 403, 404]).toContain(res.status);
        expect(await admins()).toBe(1);
      } finally {
        await purgeAudit(h.admin, sql`true`);
        await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${prefix}`);
      }
    });

    it('acc_app holds neither superuser nor BYPASSRLS', async () => {
      const { rows } = await h.admin.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'acc_app'`,
      );
      expect(rows[0]!.rolsuper).toBe(false);
      expect(rows[0]!.rolbypassrls).toBe(false);
    });
  });

  // ===========================================================================
  describe('F. rollback', () => {
    it('a refused revocation rolls its whole transaction back', async () => {
      const only = await plantAdmin('f-rollback');
      const assignmentId = await assignmentIdFor(only.userId);
      const token = await tokenFor(only.email);

      await revoke(token, assignmentId).expect(409);

      // Neither the assignment nor any audit row survives the refusal.
      const [still] = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.id, assignmentId));
      expect(still).toBeDefined();

      const { rows } = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM audit_logs WHERE action = 'user_role.revoked'`,
      );
      expect(Number(rows[0]!.count)).toBe(0);
      expect(await admins()).toBe(1);
    });

    it('the advisory lock is released on rollback, so the next attempt is not blocked', async () => {
      // `pg_advisory_xact_lock` releases on rollback as well as commit — the
      // same property that makes `SET LOCAL` safe. A leaked lock would deadlock
      // every subsequent platform-admin mutation.
      const only = await plantAdmin('f-lock');
      const token = await tokenFor(only.email);
      await revoke(token, await assignmentIdFor(only.userId)).expect(409);

      const spare = await plantAdmin('f-lock-spare');
      // If the lock had leaked, this would hang rather than return.
      await revoke(token, await assignmentIdFor(spare.userId)).expect(204);
      expect(await admins()).toBe(1);
    }, 20_000);
  });

  // ===========================================================================
  describe('G. a support grant is not a platform administrator (migration 0010)', () => {
    /**
     * Before `0010` the invariant counted *any* active platform-scope grant, so
     * with a support user present the last real administrator could be revoked
     * or disabled and the platform left administered by a read-only role.
     */
    it('revoking the last super admin through the API is refused although a support user exists', async () => {
      const only = await plantAdmin('g-api');
      await plantSupport('g-api-support');
      expect(await admins()).toBe(1);
      expect(await supportGrantsPresent()).toBe(1);

      const token = await tokenFor(only.email);
      const res = await revoke(token, await assignmentIdFor(only.userId)).expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_LAST_PLATFORM_ADMIN);
      expect(await admins()).toBe(1);
    });

    it('the database refuses deleting the last super-admin grant although a support grant remains', async () => {
      const only = await plantAdmin('g-delete');
      await plantSupport('g-delete-support');
      await expectDbRefusal(
        h.admin.delete(schema.userRoles).where(eq(schema.userRoles.userId, only.userId)),
        /no active administrator/,
      );
      expect(await admins()).toBe(1);
    });

    it('the database refuses disabling the last super admin although a support user remains', async () => {
      const only = await plantAdmin('g-disable');
      await plantSupport('g-disable-support');
      await expectDbRefusal(
        h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, only.userId)),
        /no active administrator/,
      );
      expect(await admins()).toBe(1);
    });

    it('UPDATE path: turning the last super-admin grant into a support grant is refused', async () => {
      const only = await plantAdmin('g-update-role');
      await plantSupport('g-update-role-support');
      const id = await assignmentIdFor(only.userId);
      await expectDbRefusal(
        h.admin.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
          await tx
            .update(schema.userRoles)
            .set({ roleId: supportRoleId })
            .where(eq(schema.userRoles.id, id));
        }),
        /no active administrator/,
      );
      expect(await admins()).toBe(1);
    });

    it('UPDATE path: moving the last super-admin grant to reseller scope is refused', async () => {
      const only = await plantAdmin('g-update-scope');
      await plantSupport('g-update-scope-support');
      const id = await assignmentIdFor(only.userId);
      await expectDbRefusal(
        h.admin.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
          await tx
            .update(schema.userRoles)
            .set({ scopeType: 'reseller', scopeId: orgA.resellerId })
            .where(eq(schema.userRoles.id, id));
        }),
        // Since migration 0014 (Phase 1C.6, decision §14.2) the move is refused
        // earlier and unconditionally: `alendei_super_admin` admits only
        // `platform`, so no super-admin grant can be moved to reseller scope at
        // all, last or not. The liveness trigger remains the guard for the
        // user and role reassignment paths below.
        /role alendei_super_admin does not admit scope_type reseller/,
      );
      expect(await admins()).toBe(1);
    });

    it('UPDATE path: reassigning the last super-admin grant to a disabled user is refused', async () => {
      const only = await plantAdmin('g-update-user');
      await plantSupport('g-update-user-support');
      const [disabled] = await h.admin
        .insert(schema.users)
        .values({
          email: `g-disabled-${uuidv7().replace(/-/g, '').slice(-10)}@example.test`,
          status: 'disabled',
        })
        .returning({ id: schema.users.id });
      planted.push(disabled!.id);
      const id = await assignmentIdFor(only.userId);
      await expectDbRefusal(
        h.admin.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
          await tx
            .update(schema.userRoles)
            .set({ userId: disabled!.id })
            .where(eq(schema.userRoles.id, id));
        }),
        /no active administrator/,
      );
      expect(await admins()).toBe(1);
    });

    it('UPDATE path is not over-broad: reassigning the grant to another active user keeps one admin and is allowed', async () => {
      const only = await plantAdmin('g-update-ok');
      const support = await plantSupport('g-update-ok-support');
      const id = await assignmentIdFor(only.userId);
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx
          .update(schema.userRoles)
          .set({ userId: support.userId })
          .where(eq(schema.userRoles.id, id));
      });
      expect(await admins()).toBe(1);
    });

    it('concurrency: two API revocations of the last two super admins leave one, with support present', async () => {
      const first = await plantAdmin('g-race-1');
      const second = await plantAdmin('g-race-2');
      await plantSupport('g-race-support');
      expect(await admins()).toBe(2);

      const token = await tokenFor(first.email);
      const [resA, resB] = await Promise.all([
        revoke(token, await assignmentIdFor(first.userId)),
        revoke(token, await assignmentIdFor(second.userId)),
      ]);
      expect([resA.status, resB.status].filter((s) => s === 204)).toHaveLength(1);
      expect(await admins()).toBe(1);
      expect(await supportGrantsPresent()).toBe(1);
    });

    it('concurrency: two independent connections each UPDATE a different admin away — exactly one commits', async () => {
      const first = await plantAdmin('g-uprace-1');
      const second = await plantAdmin('g-uprace-2');
      await plantSupport('g-uprace-support');
      const ids = [await assignmentIdFor(first.userId), await assignmentIdFor(second.userId)];
      const pools = [0, 1].map(
        () => new Pool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 1 }),
      );
      try {
        const outcomes = await Promise.allSettled(
          ids.map(async (id, i) => {
            const client = await pools[i]!.connect();
            try {
              await client.query('BEGIN');
              await client.query(`SELECT set_config('app.is_platform_admin','on',true)`);
              await client.query('UPDATE user_roles SET role_id = $1 WHERE id = $2', [
                supportRoleId,
                id,
              ]);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          }),
        );
        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
        const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
        expect(String(refused.reason)).toMatch(/no active administrator/);
        expect(await admins()).toBe(1);
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
    });
  });
});
