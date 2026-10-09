/**
 * The last-reseller-administrator invariant (ADR-015 follow-up item 4;
 * `RBAC.md` §7d; migration `0030`) — the reseller counterpart of
 * `organization-admin-liveness.sec-spec.ts`, whose structure it mirrors.
 *
 *   A reseller administrator of R is an ACTIVE user holding the seeded system
 *   platform role `reseller_admin` at scope (`reseller`, R). A transaction that
 *   removes or deactivates such a grant and leaves R with none is refused —
 *   `409 AUTHZ_LAST_RESELLER_ADMIN` through the API, `restrict_violation`
 *   (`reseller_admin_liveness`) in the database, for every writer.
 *
 * It guards transitions, not absence: a reseller that has never had an
 * administrator is legal. Peer revocation within one reseller stays allowed
 * while another administrator remains; cross-reseller revocation stays
 * refused. Section R proves what a reseller principal can and cannot see under
 * RLS, which is why the service decides only when it sees every holder and
 * otherwise defers to the trigger. **Every race case asserts the final
 * database state**; the races are made deterministic by parking the
 * contenders behind a lock an owner connection holds (`pg_blocking_pids`).
 */
import { createHash } from 'node:crypto';
import { AUDIT_ACTIONS, ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import {
  ORG_ADMIN_LOCK_CLASS,
  PLATFORM_ADMIN_LOCK_KEY,
  RESELLER_ADMIN_LOCK_CLASS,
  schema,
} from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';

import { TenantDatabase } from '../src/database/tenant-database.service';
import { purgeAudit, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, type Org, type Person } from './revocation-fixtures';

const REFUSAL = /refusing to leave reseller .* with no active administrator/;
const FUNCTIONS = [
  'fn_assert_reseller_admin_remains',
  'fn_user_roles_reseller_admin_guard',
  'fn_users_reseller_admin_guard',
];

describe('last-reseller-administrator invariant (ADR-015 follow-up item 4)', () => {
  let h: Harness;
  let w: RevocationWorld;
  let db: TenantDatabase;
  let owner: Pool;
  let superAdmin: Person;
  let superToken: string;

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    db = h.app.get(TenantDatabase);
    owner = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 8 });
    await w.init('rliveness');
    superAdmin = await w.superAdmin('rla-super');
    superToken = await w.login(superAdmin.email);
  }, 120_000);

  afterAll(async () => {
    await w.teardown();
    await owner.end();
    await h.close();
  }, 120_000);

  afterEach(() =>
    purgeAudit(
      h.admin,
      sql`action IN (${AUDIT_ACTIONS.USER_ROLE_REVOKED}, ${AUDIT_ACTIONS.USER_DISABLED})`,
    ),
  );

  /** A reseller with one organization beneath it (the context reseller principals select). */
  async function world(label: string): Promise<{ resellerId: string; org: Org }> {
    const resellerId = await w.reseller(label);
    return { resellerId, org: await w.org(label, resellerId) };
  }

  /** Expects the database's refusal, by SQLSTATE and constraint, not only the text. */
  const expectDbRefusal = async (work: Promise<unknown>): Promise<void> => {
    let failure: unknown;
    try {
      await work;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const cause = ((failure as { cause?: unknown }).cause ?? failure) as {
      code?: string;
      constraint?: string;
      message?: string;
    };
    expect([cause.code, cause.constraint]).toEqual(['23001', 'reseller_admin_liveness']);
    expect(cause.message).toMatch(REFUSAL);
  };

  interface Held {
    readonly client: PoolClient;
    readonly pid: number;
    done: boolean;
  }

  /** An owner connection holding the reseller's liveness lock, open. */
  async function holdLock(resellerId: string): Promise<Held> {
    const client = await owner.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))', [
      RESELLER_ADMIN_LOCK_CLASS,
      resellerId,
    ]);
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    return { client, pid, done: false };
  }

  /** An owner connection holding a SHARE lock on audit_logs: any INSERT there waits. */
  async function holdAuditWrites(): Promise<Held> {
    const client = await owner.connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE audit_logs IN SHARE MODE');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    return { client, pid, done: false };
  }

  /** Commits and releases a held lock; safe to call again from `finally`. */
  async function release(held: Held | undefined): Promise<void> {
    if (!held || held.done) return;
    held.done = true;
    try {
      await held.client.query('COMMIT');
    } finally {
      held.client.release();
    }
  }

  /** A pending operation that reports whether it has already settled. */
  function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
    let done = false;
    const tracked = promise.finally(() => {
      done = true;
    });
    return { promise: tracked, settled: () => done };
  }

  /**
   * The backends blocked by `pid`, once there are `count` of them — or `null`
   * as soon as any contender has settled without blocking (or after 8 s).
   */
  async function untilBlocked(
    pid: number,
    count: number,
    settled: () => boolean = () => false,
  ): Promise<number[] | null> {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const { rows } = await owner.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))',
        [pid],
      );
      if (rows.length >= count) return rows.map((r) => r.pid);
      if (settled() || Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** A row-lock probe that must succeed at once; always leaves the client clean. */
  async function probeRowFree(text: string, id: string): Promise<boolean> {
    const probe = await owner.connect();
    try {
      await probe.query('BEGIN');
      await probe.query('SET LOCAL lock_timeout = 200');
      return await probe.query(text, [id]).then(
        (r) => r.rowCount === 1,
        () => false,
      );
    } finally {
      await probe.query('ROLLBACK').catch(() => undefined);
      probe.release();
    }
  }

  /**
   * An owner write to a platform-role grant: `fn_validate_user_role_scope`
   * admits one only under the platform-admin flag (as the fixture's `grant`),
   * so the update reaches the liveness trigger instead of stopping there.
   */
  const asPlatformOwner = (
    work: (tx: Parameters<Parameters<Harness['admin']['transaction']>[0]>[0]) => Promise<unknown>,
  ) =>
    h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await work(tx);
    });

  const status = async (userId: string) =>
    (
      await h.admin
        .select({ status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
    )[0]!.status;

  const liveSessions = async (userId: string) =>
    (
      await h.admin.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId} AND revoked_at IS NULL`,
      )
    ).rows[0]!.n;

  const disabledAudit = async (userId: string) =>
    (
      await h.admin.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_logs
             WHERE action = ${AUDIT_ACTIONS.USER_DISABLED} AND resource_id = ${userId}`,
      )
    ).rows[0]!.n;

  // ===========================================================================
  describe('A. the definition, the lock and the catalogue', () => {
    it('the migration and @acc/db agree on the lock class, in the two-int4 form keyed by reseller', async () => {
      const { rows } = await h.admin.execute<{ src: string }>(
        sql`SELECT prosrc AS src FROM pg_proc WHERE proname = 'fn_assert_reseller_admin_remains'`,
      );
      expect(rows[0]!.src).toContain(
        `pg_advisory_xact_lock(${RESELLER_ADMIN_LOCK_CLASS}, hashtext(p_reseller_id::text))`,
      );
      expect(RESELLER_ADMIN_LOCK_CLASS).not.toBe(ORG_ADMIN_LOCK_CLASS);
    });

    it('the reseller lock is distinct from the organization class and the platform key (pg_locks)', async () => {
      const { resellerId } = await world('keyspace');
      const a = await holdLock(resellerId);
      const b = await owner.connect();
      try {
        await b.query('BEGIN');
        // The same uuid under the organization class does not collide …
        const org = await b.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1::int4, hashtext($2::text)) AS ok',
          [ORG_ADMIN_LOCK_CLASS, resellerId],
        );
        expect(org.rows[0]!.ok).toBe(true);
        // … nor does the platform key …
        const platform = await b.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1::bigint) AS ok',
          [PLATFORM_ADMIN_LOCK_KEY.toString()],
        );
        expect(platform.rows[0]!.ok).toBe(true);
        // … while the same reseller key does (positive control).
        const same = await b.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1::int4, hashtext($2::text)) AS ok',
          [RESELLER_ADMIN_LOCK_CLASS, resellerId],
        );
        expect(same.rows[0]!.ok).toBe(false);
        const { rows } = await owner.query<{ classid: number; objsubid: number }>(
          `SELECT classid::bigint::int AS classid, objsubid FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND pid = $1`,
          [a.pid],
        );
        expect(rows).toEqual([{ classid: RESELLER_ADMIN_LOCK_CLASS, objsubid: 2 }]);
        await b.query('ROLLBACK');
      } finally {
        b.release();
        await release(a);
      }
    });

    it('revocation takes the reseller lock BEFORE it deletes the grant (lock first, row locks second)', async () => {
      const { resellerId, org } = await world('ordering');
      await w.resellerAdmin(resellerId, 'ord-1');
      const second = await w.resellerAdmin(resellerId, 'ord-2');
      const held = await holdLock(resellerId);
      const pending = track(w.revoke(superToken, org.orgId, second.grantId).then((r) => r));
      try {
        const blocked = await untilBlocked(held.pid, 1, pending.settled);
        expect(blocked).not.toBeNull();
        const { rows } = await owner.query<{ classid: number; objsubid: number }>(
          `SELECT classid::bigint::int AS classid, objsubid FROM pg_locks
            WHERE pid = $1 AND NOT granted AND locktype = 'advisory'`,
          [blocked![0]],
        );
        expect(rows).toEqual([{ classid: RESELLER_ADMIN_LOCK_CLASS, objsubid: 2 }]);
        expect(
          await probeRowFree('SELECT id FROM user_roles WHERE id = $1 FOR UPDATE', second.grantId),
        ).toBe(true);
        await release(held);
        expect((await pending.promise).status).toBe(204);
      } finally {
        await release(held);
        await pending.promise.catch(() => undefined);
      }
    }, 30_000);

    it('disable takes the reseller lock BEFORE it updates the user (lock first, row locks second)', async () => {
      const { resellerId, org } = await world('ordering-disable');
      await w.resellerAdmin(resellerId, 'ordd-1');
      const second = await w.resellerAdmin(resellerId, 'ordd-2', { memberOf: org });
      const held = await holdLock(resellerId);
      const pending = track(w.disable(superToken, org.orgId, second.userId).then((r) => r));
      try {
        const blocked = await untilBlocked(held.pid, 1, pending.settled);
        expect(blocked).not.toBeNull();
        const { rows } = await owner.query<{ classid: number; objsubid: number }>(
          `SELECT classid::bigint::int AS classid, objsubid FROM pg_locks
            WHERE pid = $1 AND NOT granted AND locktype = 'advisory'`,
          [blocked![0]],
        );
        expect(rows).toEqual([{ classid: RESELLER_ADMIN_LOCK_CLASS, objsubid: 2 }]);
        expect(
          await probeRowFree('SELECT id FROM users WHERE id = $1 FOR UPDATE', second.userId),
        ).toBe(true);
        await release(held);
        expect((await pending.promise).status).toBe(200);
      } finally {
        await release(held);
        await pending.promise.catch(() => undefined);
      }
    }, 30_000);

    it('the trigger path itself parks behind the reseller lock (service bypassed)', async () => {
      const { resellerId } = await world('trigger-lock');
      const a = await w.resellerAdmin(resellerId, 'tl-a');
      await w.resellerAdmin(resellerId, 'tl-b');
      const held = await holdLock(resellerId);
      const writer = await owner.connect();
      try {
        await writer.query('BEGIN');
        const deleting = track(
          writer.query('DELETE FROM user_roles WHERE id = $1', [a.grantId]).then(
            (r) => r.rowCount,
            () => null,
          ),
        );
        const blocked = await untilBlocked(held.pid, 1, deleting.settled);
        await release(held);
        expect(await deleting.promise).toBe(1);
        expect(blocked).not.toBeNull();
      } finally {
        await release(held);
        await writer.query('ROLLBACK').catch(() => undefined);
        writer.release();
      }
      expect(await w.resellerAdmins(resellerId)).toBe(2);
    }, 30_000);

    it('three triggers guard exactly the documented paths, and on users they fire organization → platform → reseller', async () => {
      const { rows } = await h.admin.execute<{ def: string }>(sql`
        SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
         WHERE NOT t.tgisinternal AND t.tgname LIKE '%reseller_admin_liveness%' ORDER BY t.tgname`);
      expect(rows.map((r) => r.def)).toEqual([
        "CREATE TRIGGER trg_user_roles_reseller_admin_liveness AFTER DELETE ON public.user_roles FOR EACH ROW WHEN ((old.scope_type = 'reseller'::role_scope_type)) EXECUTE FUNCTION fn_user_roles_reseller_admin_guard()",
        "CREATE TRIGGER trg_user_roles_reseller_admin_liveness_update AFTER UPDATE OF scope_type, scope_id, user_id, role_id, org_id ON public.user_roles FOR EACH ROW WHEN ((old.scope_type = 'reseller'::role_scope_type)) EXECUTE FUNCTION fn_user_roles_reseller_admin_guard()",
        "CREATE TRIGGER trg_users_reseller_admin_liveness AFTER UPDATE OF status ON public.users FOR EACH ROW WHEN (((old.status = 'active'::user_status) AND (new.status <> 'active'::user_status))) EXECUTE FUNCTION fn_users_reseller_admin_guard()",
      ]);
      // Same-event triggers fire in name order: the lock order the services follow.
      const order = await h.admin.execute<{ tgname: string }>(sql`
        SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'users'::regclass
           AND tgname LIKE '%_admin_liveness' ORDER BY tgname`);
      expect(order.rows.map((r) => r.tgname)).toEqual([
        'trg_users_org_admin_liveness',
        'trg_users_platform_admin_liveness',
        'trg_users_reseller_admin_liveness',
      ]);
    });

    it('function definitions are pinned, SECURITY DEFINER with a fixed search_path, and executable by no principal', async () => {
      const { rows } = await h.admin.execute<{
        proname: string;
        src: string;
        definer: boolean;
        config: string[] | null;
      }>(sql`
        SELECT proname, prosrc AS src, prosecdef AS definer, proconfig AS config
          FROM pg_proc WHERE proname IN ('fn_assert_reseller_admin_remains',
            'fn_user_roles_reseller_admin_guard', 'fn_users_reseller_admin_guard') ORDER BY proname`);
      expect(rows.map((r) => r.proname)).toEqual(FUNCTIONS);
      const md5 = Object.fromEntries(
        rows.map((r) => [r.proname, createHash('md5').update(r.src).digest('hex')]),
      );
      expect(md5).toEqual(PINNED_MD5);
      for (const row of rows) {
        expect([row.proname, row.definer, row.config]).toEqual([
          row.proname,
          true,
          ['search_path=public, pg_temp'],
        ]);
      }
      const acl = await h.admin.execute<{ proname: string; principal: string; allowed: boolean }>(
        sql`SELECT p.proname, r.rolname AS principal,
                   has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS allowed
              FROM pg_proc p CROSS JOIN pg_roles r
             WHERE p.proname IN ('fn_assert_reseller_admin_remains',
                   'fn_user_roles_reseller_admin_guard', 'fn_users_reseller_admin_guard')
               AND r.rolname IN ('acc_app', 'acc_auth', 'acc_relay')
             ORDER BY 1, 2`,
      );
      expect(acl.rows.filter((r) => r.allowed)).toEqual([]);
      expect(acl.rows).toHaveLength(9);
      const publicAcl = await h.admin.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a
             WHERE p.proname IN ('fn_assert_reseller_admin_remains',
                   'fn_user_roles_reseller_admin_guard', 'fn_users_reseller_admin_guard')
               AND a.grantee = 0`,
      );
      expect(publicAcl.rows[0]!.n).toBe(0);
    });

    it('acc_app cannot call the invariant function directly', async () => {
      const { resellerId, org } = await world('direct-call');
      await expect(
        db.withTenant({ orgId: org.orgId, userId: superAdmin.userId }, (tx) =>
          tx.execute(sql`SELECT fn_assert_reseller_admin_remains(${resellerId}::uuid)`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    });
  });

  // ===========================================================================
  describe('R. what a reseller principal sees under RLS (why the service may defer)', () => {
    it('it sees every reseller-scope grant of its reseller and the platform role, but not a peer whose only grant is the reseller grant', async () => {
      const { resellerId, org } = await world('rls');
      const other = await world('rls-other');
      const a = await w.resellerAdmin(resellerId, 'rls-a');
      const hiddenPeer = await w.resellerAdmin(resellerId, 'rls-hidden');
      const memberPeer = await w.resellerAdmin(resellerId, 'rls-member', { memberOf: org });
      await w.resellerAdmin(other.resellerId, 'rls-elsewhere');

      const seen = await db.withTenant(
        { orgId: org.orgId, userId: a.userId, resellerId },
        async (tx) => {
          const grants = await tx.execute<{ scope_id: string; n: number }>(sql`
            SELECT scope_id, count(*)::int AS n FROM user_roles
             WHERE scope_type = 'reseller' GROUP BY scope_id`);
          const role = await tx.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM roles
             WHERE org_id IS NULL AND key = ${PLATFORM_ROLE_KEYS.RESELLER_ADMIN} AND is_system_role`);
          const users = await tx.execute<{ id: string }>(sql`
            SELECT id FROM users WHERE id IN (${a.userId}, ${hiddenPeer.userId}, ${memberPeer.userId})`);
          return {
            grants: grants.rows,
            role: role.rows[0]!.n,
            users: users.rows.map((r) => r.id).sort(),
          };
        },
      );
      // Grants: exactly the three of its own reseller, all of them; none of the other reseller's.
      expect(seen.grants).toEqual([{ scope_id: resellerId, n: 3 }]);
      expect(seen.role).toBe(1);
      // Users: itself and the peer that is a member of an organization in reach — not the
      // peer holding only the reseller grant.
      expect(seen.users).toEqual([a.userId, memberPeer.userId].sort());
      expect(seen.users).not.toContain(hiddenPeer.userId);
    });

    it('a count of what is visible would refuse a self-revocation the database allows — the API answers 204', async () => {
      const { resellerId, org } = await world('rls-false');
      const a = await w.resellerAdmin(resellerId, 'rf-a');
      await w.resellerAdmin(resellerId, 'rf-hidden');
      // Visible to A: its own grant only has a visible, active holder; the peer's is hidden.
      const visible = await db.withTenant(
        { orgId: org.orgId, userId: a.userId, resellerId },
        (tx) =>
          tx.execute<{ active: number; hidden: number }>(sql`
          SELECT count(*) FILTER (WHERE u.status = 'active')::int AS active,
                 count(*) FILTER (WHERE u.id IS NULL)::int AS hidden
            FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            LEFT JOIN users u ON u.id = ur.user_id
           WHERE ur.scope_type = 'reseller' AND ur.scope_id = ${resellerId}
             AND r.key = ${PLATFORM_ROLE_KEYS.RESELLER_ADMIN}`),
      );
      expect(visible.rows[0]).toEqual({ active: 1, hidden: 1 });
      expect(await w.resellerAdmins(resellerId)).toBe(2);
      const token = await w.login(a.email);
      expect((await w.revoke(token, org.orgId, a.grantId)).status).toBe(204);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });
  });

  // ===========================================================================
  describe('B. revoking through the API', () => {
    it('a reseller administrator revokes a peer of the same reseller: 204 and an audit row', async () => {
      const { resellerId, org } = await world('peer');
      const a = await w.resellerAdmin(resellerId, 'b-peer-a');
      const b = await w.resellerAdmin(resellerId, 'b-peer-b');
      const token = await w.login(a.email);
      expect((await w.revoke(token, org.orgId, b.grantId)).status).toBe(204);
      expect(await w.grantExists(b.grantId)).toBe(false);
      const audit = await w.revokedAudit(b.grantId);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_user_id).toBe(a.userId);
      expect(audit[0]!.metadata).toMatchObject({
        roleKey: PLATFORM_ROLE_KEYS.RESELLER_ADMIN,
        revokedFrom: b.userId,
      });
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('self-revocation while a peer remains: 204', async () => {
      const { resellerId, org } = await world('self');
      const a = await w.resellerAdmin(resellerId, 'b-self-a', { memberOf: org });
      await w.resellerAdmin(resellerId, 'b-self-b', { memberOf: org });
      const token = await w.login(a.email);
      expect((await w.revoke(token, org.orgId, a.grantId)).status).toBe(204);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('the last administrator revoking itself: 409 AUTHZ_LAST_RESELLER_ADMIN, the grant and no audit row remain — decided before the audit write', async () => {
      const { resellerId, org } = await world('last-self');
      const only = await w.resellerAdmin(resellerId, 'b-only');
      const token = await w.login(only.email);
      // While audit_logs refuses new rows (SHARE lock), a request that reached
      // the audit write would wait on it; the refusal must come first.
      const held = await holdAuditWrites();
      const pending = track(w.revoke(token, org.orgId, only.grantId).then((r) => r));
      try {
        expect(await untilBlocked(held.pid, 1, pending.settled)).toBeNull();
        const res = await pending.promise;
        expect([res.status, res.body.error?.code, res.body.error?.message]).toEqual([
          409,
          ERROR_CODES.AUTHZ_LAST_RESELLER_ADMIN,
          'This is the last active administrator of the reseller; appoint another first',
        ]);
      } finally {
        await release(held);
        await pending.promise.catch(() => undefined);
      }
      expect(await w.grantExists(only.grantId)).toBe(true);
      expect(await w.revokedAudit(only.grantId)).toEqual([]);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    }, 30_000);

    it('decided by the trigger: the last active administrator, a disabled peer hidden from the service — 409, grant and no audit row remain', async () => {
      const { resellerId, org } = await world('deferred');
      const a = await w.resellerAdmin(resellerId, 'b-def-a');
      const peer = await w.resellerAdmin(resellerId, 'b-def-peer');
      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, peer.userId));
      const token = await w.login(a.email);
      const res = await w.revoke(token, org.orgId, a.grantId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_RESELLER_ADMIN,
      ]);
      expect(await w.grantExists(a.grantId)).toBe(true);
      expect(await w.revokedAudit(a.grantId)).toEqual([]);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('a platform administrator revoking the last reseller administrator: 409, not a 403', async () => {
      const { resellerId, org } = await world('platform');
      const only = await w.resellerAdmin(resellerId, 'b-platform');
      const res = await w.revoke(superToken, org.orgId, only.grantId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_RESELLER_ADMIN,
      ]);
      expect(await w.grantExists(only.grantId)).toBe(true);
      expect(await w.revokedAudit(only.grantId)).toEqual([]);
    });

    it('cross-reseller: an administrator of another reseller cannot revoke (404), and the grant stays', async () => {
      const r1 = await world('cross-1');
      const r2 = await world('cross-2');
      const target = await w.resellerAdmin(r1.resellerId, 'b-cross-target');
      await w.resellerAdmin(r1.resellerId, 'b-cross-spare');
      const intruder = await w.resellerAdmin(r2.resellerId, 'b-cross-intruder');
      const token = await w.login(intruder.email);
      expect((await w.revoke(token, r2.org.orgId, target.grantId)).status).toBe(404);
      // Nor by selecting the other reseller's organization.
      expect((await w.revoke(token, r1.org.orgId, target.grantId)).status).toBe(403);
      expect(await w.grantExists(target.grantId)).toBe(true);
    });

    it('a non-administrator reseller-scope grant is revoked as before, even when the reseller has one administrator', async () => {
      const { resellerId, org } = await world('non-admin');
      const only = await w.resellerAdmin(resellerId, 'b-na-admin');
      const member = await w.person('b-na-member');
      const role = await resellerScopeRole('na');
      const grantId = await w.grant(member.userId, role, 'reseller', resellerId);
      expect((await w.revoke(superToken, org.orgId, grantId)).status).toBe(204);
      expect(await w.grantExists(grantId)).toBe(false);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
      expect(only.grantId).toBeTruthy();
    });

    it('a grant held by a user who is not active is not counted, so revoking it is allowed', async () => {
      const { resellerId, org } = await world('inactive');
      const active = await w.resellerAdmin(resellerId, 'b-in-active');
      const invited = await w.resellerAdmin(resellerId, 'b-in-invited', { status: 'invited' });
      const token = await w.login(active.email);
      expect((await w.revoke(token, org.orgId, invited.grantId)).status).toBe(204);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('the lock is released on rollback: after a 409 the next revocation is not blocked', async () => {
      const { resellerId, org } = await world('rollback');
      const only = await w.resellerAdmin(resellerId, 'b-lock');
      await w.revoke(superToken, org.orgId, only.grantId).expect(409);
      const spare = await w.resellerAdmin(resellerId, 'b-lock-spare');
      await w.revoke(superToken, org.orgId, spare.grantId).expect(204);
      await w.revoke(superToken, org.orgId, only.grantId).expect(409);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    }, 20_000);
  });

  /** A custom platform role admitting `reseller` scope only, carrying no administration. */
  async function resellerScopeRole(label: string): Promise<string> {
    const [permission] = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, PERMISSIONS.RESELLERS_READ));
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: null,
          key: `r30_${label.replace(/[^a-z0-9]/g, '_')}_${Date.now().toString(36)}`,
          name: `R30 ${label}`,
          isSystemRole: false,
          allowedScopeTypes: ['reseller'],
        })
        .returning({ id: schema.roles.id });
      w.createdPlatformRoles.push(role!.id);
      await tx
        .insert(schema.rolePermissions)
        .values({ roleId: role!.id, permissionId: permission!.id });
      return role!.id;
    });
  }

  // ===========================================================================
  describe('C. disabling through the API', () => {
    it('disabling the last reseller administrator: 409, the user stays active, its session stays live, no audit row', async () => {
      const { resellerId, org } = await world('disable');
      const only = await w.resellerAdmin(resellerId, 'c-only', { memberOf: org });
      await w.login(only.email);
      expect(await liveSessions(only.userId)).toBe(1);
      const res = await w.disable(superToken, org.orgId, only.userId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_RESELLER_ADMIN,
      ]);
      expect(await status(only.userId)).toBe('active');
      expect(await liveSessions(only.userId)).toBe(1);
      expect(await disabledAudit(only.userId)).toBe(0);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('a platform administrator disabling one of two reseller administrators: 200', async () => {
      const { resellerId, org } = await world('disable-ok');
      const a = await w.resellerAdmin(resellerId, 'c-a', { memberOf: org });
      await w.resellerAdmin(resellerId, 'c-b');
      expect((await w.disable(superToken, org.orgId, a.userId)).status).toBe(200);
      expect(await status(a.userId)).toBe('disabled');
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('decided by the trigger: a platform principal that cannot see reseller grants gets the same 409 (not the platform code)', async () => {
      const { resellerId, org } = await world('disable-deferred');
      const only = await w.resellerAdmin(resellerId, 'c-def-only', { memberOf: org });
      // A platform-scope principal that is not a platform administrator: RLS
      // shows it no reseller-scope grant, so the service finds nothing to lock
      // or count and the trigger decides.
      const operator = await w.person('c-def-operator');
      await w.grant(
        operator.userId,
        await w.platformRole('r30_disabler', [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_DISABLE]),
        'platform',
        null,
      );
      const token = await w.login(operator.email);
      const res = await w.disable(token, org.orgId, only.userId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_RESELLER_ADMIN,
      ]);
      expect(await status(only.userId)).toBe('active');
      expect(await disabledAudit(only.userId)).toBe(0);
    });

    it('organization liveness is unchanged and answers first: the last org_admin keeps its own code', async () => {
      const { resellerId, org } = await world('unchanged');
      const orgAdmin = await w.admin(org, 'c-orgadmin');
      const res = await w.revoke(superToken, org.orgId, orgAdmin.grantId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
      ]);
      // A user who is the organization's last org_admin and one of two reseller
      // administrators: the organization rule (its lock and check come first)
      // refuses the disable with its own code.
      const both = await w.resellerAdmin(resellerId, 'c-both');
      await w.resellerAdmin(resellerId, 'c-both-r-spare');
      const org2 = await w.org('unchanged-2', resellerId);
      await w.grant(both.userId, org2.roles['org_admin']!, 'organization', org2.orgId);
      const disabled = await w.disable(superToken, org2.orgId, both.userId);
      expect([disabled.status, disabled.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
      ]);
      expect(await status(both.userId)).toBe('active');
      expect([await w.admins(org2.orgId), await w.resellerAdmins(resellerId)]).toEqual([1, 2]);
    });
  });

  // ===========================================================================
  describe('D. the database backstop, with the service bypassed', () => {
    let resellerId: string;
    let org: Org;
    let only: Person & { grantId: string };
    beforeEach(async () => {
      ({ resellerId, org } = await world('db'));
      only = await w.resellerAdmin(resellerId, 'd-only');
    });

    it('owner: deleting the last administrator grant is refused', async () => {
      await expectDbRefusal(
        h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, only.grantId)),
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('owner: disabling the last administrator is refused', async () => {
      await expectDbRefusal(
        h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, only.userId)),
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('owner: deleting the last administrator’s user row is refused through the cascade (missing user = qualifying)', async () => {
      await expectDbRefusal(h.admin.delete(schema.users).where(eq(schema.users.id, only.userId)));
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('owner: changing the role of the last administrator grant is refused', async () => {
      const otherRole = await resellerScopeRole('d-role');
      await expectDbRefusal(
        asPlatformOwner((tx) =>
          tx
            .update(schema.userRoles)
            .set({ roleId: otherRole })
            .where(eq(schema.userRoles.id, only.grantId)),
        ),
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('owner: moving the last administrator grant to another reseller is refused', async () => {
      const elsewhere = await w.reseller('d-elsewhere');
      await expectDbRefusal(
        asPlatformOwner((tx) =>
          tx
            .update(schema.userRoles)
            .set({ scopeId: elsewhere })
            .where(eq(schema.userRoles.id, only.grantId)),
        ),
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('owner: reassigning the last administrator grant to an inactive user is refused; to an active one, allowed', async () => {
      const invited = await w.person('d-invited', 'invited');
      await expectDbRefusal(
        asPlatformOwner((tx) =>
          tx
            .update(schema.userRoles)
            .set({ userId: invited.userId })
            .where(eq(schema.userRoles.id, only.grantId)),
        ),
      );
      const active = await w.person('d-active');
      await asPlatformOwner((tx) =>
        tx
          .update(schema.userRoles)
          .set({ userId: active.userId })
          .where(eq(schema.userRoles.id, only.grantId)),
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('owner with the platform-admin and provisioning flags (trusted writers) is not exempt', async () => {
      await expectDbRefusal(
        h.admin.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
          await tx.execute(sql`select set_config('app.provisioning','on',true)`);
          await tx.delete(schema.userRoles).where(eq(schema.userRoles.id, only.grantId));
        }),
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('acc_app (the reseller principal itself): deleting its own last grant is refused', async () => {
      await expectDbRefusal(
        db.withTenant({ orgId: org.orgId, userId: only.userId, resellerId }, (tx) =>
          tx.delete(schema.userRoles).where(eq(schema.userRoles.id, only.grantId)),
        ),
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('acc_app: disabling the last administrator (itself) is refused', async () => {
      await expectDbRefusal(
        db.withTenant({ orgId: org.orgId, userId: only.userId, resellerId }, (tx) =>
          tx
            .update(schema.users)
            .set({ status: 'disabled' })
            .where(eq(schema.users.id, only.userId)),
        ),
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('with a second administrator present each removal is allowed; the next is refused', async () => {
      const second = await w.resellerAdmin(resellerId, 'd-second');
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, only.grantId));
      expect(await w.resellerAdmins(resellerId)).toBe(1);
      await expectDbRefusal(
        h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, second.userId)),
      );
    });

    it('unrelated grants are unaffected: another reseller’s administrator and a non-administrator grant here', async () => {
      const other = await w.reseller('d-other');
      const x = await w.resellerAdmin(other, 'd-other-x');
      await w.resellerAdmin(other, 'd-other-y');
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, x.grantId));
      expect(await w.resellerAdmins(other)).toBe(1);
      const member = await w.person('d-member');
      const grantId = await w.grant(
        member.userId,
        await resellerScopeRole('d-unrelated'),
        'reseller',
        resellerId,
      );
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, grantId));
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });

    it('a suspended reseller is not exempt (no status exemption)', async () => {
      await h.admin
        .update(schema.resellers)
        .set({ status: 'suspended' })
        .where(eq(schema.resellers.id, resellerId));
      await expectDbRefusal(
        h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, only.grantId)),
      );
      await h.admin
        .update(schema.resellers)
        .set({ status: 'active' })
        .where(eq(schema.resellers.id, resellerId));
    });

    it('the exemption: the check returns when the reseller no longer exists — though 0025 refuses deleting a reseller that still has grants', async () => {
      // The reseller row cannot go while a grant references it (migration 0025) …
      await w.deleteOrg(org.orgId);
      const failure = await h.admin
        .delete(schema.resellers)
        .where(eq(schema.resellers.id, resellerId))
        .then(
          () => null,
          (e: { cause?: { code?: string; constraint?: string } }) => e.cause,
        );
      expect([failure?.code, failure?.constraint]).toEqual([
        '23503',
        'user_roles_scope_id_reseller_fk',
      ]);
      // … and for a reseller that does not exist the invariant has nothing to keep.
      const missing = '00000000-0000-7000-8000-000000000030';
      await expect(
        h.admin.execute(sql`SELECT fn_assert_reseller_admin_remains(${missing}::uuid)`),
      ).resolves.toBeDefined();
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    });
  });

  // ===========================================================================
  describe('E. a reseller that never had an administrator', () => {
    it('is legal: granting and revoking non-administrator grants, and disabling their holders, are unaffected', async () => {
      const { resellerId } = await world('never');
      expect(await w.resellerAdmins(resellerId)).toBe(0);
      const member = await w.person('e-member');
      const grantId = await w.grant(
        member.userId,
        await resellerScopeRole('e'),
        'reseller',
        resellerId,
      );
      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, member.userId));
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, grantId));
      expect(await w.resellerAdmins(resellerId)).toBe(0);
    });

    it('the seeded default reseller has no administrator and is legal', async () => {
      const [def] = await h.admin
        .select({ id: schema.resellers.id })
        .from(schema.resellers)
        .where(eq(schema.resellers.isPlatformDefault, true));
      expect(await w.resellerAdmins(def!.id)).toBe(0);
    });
  });

  // ===========================================================================
  describe('F. concurrency — deterministic, contenders parked behind the lock', () => {
    async function race<T>(resellerId: string, contenders: (() => Promise<T>)[]): Promise<T[]> {
      const held = await holdLock(resellerId);
      const pending = contenders.map((run) => track(run()));
      try {
        const blocked = await untilBlocked(held.pid, contenders.length, () =>
          pending.some((p) => p.settled()),
        );
        expect(blocked?.length ?? 0).toBe(contenders.length);
        await release(held);
        return await Promise.all(pending.map((p) => p.promise));
      } finally {
        await release(held);
        await Promise.allSettled(pending.map((p) => p.promise));
      }
    }

    it('two reseller administrators revoking each other: exactly one 204; the other is refused (404 — its own reseller reach is gone), never zero, never a 500', async () => {
      const { resellerId, org } = await world('mutual');
      const a = await w.resellerAdmin(resellerId, 'f-a');
      const b = await w.resellerAdmin(resellerId, 'f-b');
      const [ta, tb] = [await w.login(a.email), await w.login(b.email)];
      const results = await race(resellerId, [
        () => w.revoke(ta, org.orgId, b.grantId).then((r) => r),
        () => w.revoke(tb, org.orgId, a.grantId).then((r) => r),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
      expect(results.find((r) => r.status === 404)!.body.error.code).toBe(
        ERROR_CODES.RESOURCE_NOT_FOUND,
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    }, 30_000);

    it('two administrators each removing the other through a platform administrator: exactly one 204 and one 409', async () => {
      const { resellerId, org } = await world('mutual-platform');
      const a = await w.resellerAdmin(resellerId, 'f-mp-a');
      const b = await w.resellerAdmin(resellerId, 'f-mp-b');
      const results = await race(resellerId, [
        () => w.revoke(superToken, org.orgId, b.grantId).then((r) => r),
        () => w.revoke(superToken, org.orgId, a.grantId).then((r) => r),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
        ERROR_CODES.AUTHZ_LAST_RESELLER_ADMIN,
      );
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    }, 30_000);

    it('a revocation racing a disable: one succeeds, the other is 409', async () => {
      const { resellerId, org } = await world('revoke-disable');
      const a = await w.resellerAdmin(resellerId, 'f-rd-a');
      const b = await w.resellerAdmin(resellerId, 'f-rd-b', { memberOf: org });
      const [revoked, disabled] = await race(resellerId, [
        () => w.revoke(superToken, org.orgId, a.grantId).then((r) => r.status),
        () => w.disable(superToken, org.orgId, b.userId).then((r) => r.status),
      ]);
      expect([revoked, disabled].filter((s) => s === 409)).toHaveLength(1);
      expect([revoked, disabled].filter((s) => s === 204 || s === 200)).toHaveLength(1);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    }, 30_000);

    it('two simultaneous disables: one 200, one 409', async () => {
      const { resellerId, org } = await world('two-disables');
      const a = await w.resellerAdmin(resellerId, 'f-dd-a', { memberOf: org });
      const b = await w.resellerAdmin(resellerId, 'f-dd-b', { memberOf: org });
      const statuses = await race(resellerId, [
        () => w.disable(superToken, org.orgId, a.userId).then((r) => r.status),
        () => w.disable(superToken, org.orgId, b.userId).then((r) => r.status),
      ]);
      expect([...statuses].sort()).toEqual([200, 409]);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    }, 30_000);

    it('four concurrent removals against two administrators leave one', async () => {
      const { resellerId, org } = await world('four');
      const a = await w.resellerAdmin(resellerId, 'f-4a');
      const b = await w.resellerAdmin(resellerId, 'f-4b');
      const statuses = await race(
        resellerId,
        [a.grantId, b.grantId, a.grantId, b.grantId].map(
          (id) => () => w.revoke(superToken, org.orgId, id).then((r) => r.status),
        ),
      );
      expect(statuses.filter((s) => s === 204)).toHaveLength(1);
      expect(statuses.every((s) => [204, 404, 409].includes(s))).toBe(true);
      expect(await w.resellerAdmins(resellerId)).toBe(1);
    }, 30_000);

    it('different resellers do not serialize: with one reseller’s lock held, another reseller’s removal completes', async () => {
      const held = await world('held');
      const free = await world('free');
      await w.resellerAdmin(free.resellerId, 'f-free-a');
      const b = await w.resellerAdmin(free.resellerId, 'f-free-b');
      const lock = await holdLock(held.resellerId);
      try {
        const pending = track(w.revoke(superToken, free.org.orgId, b.grantId).then((r) => r));
        expect(await untilBlocked(lock.pid, 1, pending.settled)).toBeNull();
        expect((await pending.promise).status).toBe(204);
      } finally {
        await release(lock);
      }
      expect(await w.resellerAdmins(free.resellerId)).toBe(1);
    }, 30_000);

    it('database: two owner connections each delete a different administrator — exactly one commits', async () => {
      const { resellerId } = await world('db-race');
      const a = await w.resellerAdmin(resellerId, 'f-db-a');
      const b = await w.resellerAdmin(resellerId, 'f-db-b');
      const first = await owner.connect();
      const second = await owner.connect();
      try {
        await first.query('BEGIN');
        await first.query('DELETE FROM user_roles WHERE id = $1', [a.grantId]);
        const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0]
          .pid as number;
        await second.query('BEGIN');
        const losing = track(
          second.query('DELETE FROM user_roles WHERE id = $1', [b.grantId]).then(
            () => null,
            (error: { code?: string; constraint?: string }) => error,
          ),
        );
        const blocked = await untilBlocked(firstPid, 1, losing.settled);
        await first.query('COMMIT');
        const error = await losing.promise;
        await second.query('ROLLBACK');
        expect(blocked).not.toBeNull();
        expect([error?.code, error?.constraint]).toEqual(['23001', 'reseller_admin_liveness']);
        expect(await w.resellerAdmins(resellerId)).toBe(1);
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
    }, 30_000);

    it('database: a disable racing a revocation, service bypassed — never zero', async () => {
      const { resellerId } = await world('db-race-disable');
      const a = await w.resellerAdmin(resellerId, 'f-dbd-a');
      const b = await w.resellerAdmin(resellerId, 'f-dbd-b');
      const first = await owner.connect();
      const second = await owner.connect();
      try {
        await first.query('BEGIN');
        await first.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [a.userId]);
        const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0]
          .pid as number;
        await second.query('BEGIN');
        const losing = track(
          second.query('DELETE FROM user_roles WHERE id = $1', [b.grantId]).then(
            () => null,
            (error: { code?: string; constraint?: string }) => error,
          ),
        );
        const blocked = await untilBlocked(firstPid, 1, losing.settled);
        await first.query('COMMIT');
        const error = await losing.promise;
        await second.query('ROLLBACK');
        expect(blocked).not.toBeNull();
        expect([error?.code, error?.constraint]).toEqual(['23001', 'reseller_admin_liveness']);
        expect(await w.resellerAdmins(resellerId)).toBe(1);
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
    }, 30_000);
  });
});

/** `md5(prosrc)` of the three functions of migration `0030`. */
const PINNED_MD5: Record<string, string> = {
  fn_assert_reseller_admin_remains: '0db4aac5eefd9ef3cc2c58cc5f29840a',
  fn_user_roles_reseller_admin_guard: '40046702d889cc9a725d8aec3d06fad6',
  fn_users_reseller_admin_guard: 'b333f16d12e2df397a3ec8d2b6d46aaa',
};
