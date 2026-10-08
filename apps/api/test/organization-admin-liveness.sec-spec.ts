/**
 * The last-organization-administrator invariant (ADR-015 R-11, D-MEDIUM-3b;
 * `RBAC.md` §7c; migration `0028`) — the organization counterpart of
 * `platform-admin-liveness.sec-spec.ts`, whose structure it mirrors.
 *
 *   An organization administrator of O is an ACTIVE user holding O's seeded
 *   system role `org_admin` at scope (`organization`, O). A transaction that
 *   removes or deactivates such a grant and leaves O with none is refused —
 *   `409 AUTHZ_LAST_ORGANIZATION_ADMIN` through the API, `restrict_violation`
 *   (`organization_admin_liveness`) in the database, for every writer.
 *
 * It guards transitions, not absence: an organization that has never had an
 * administrator (every newly provisioned one) is legal. The only exemption is
 * the organization's own deletion. **Every race case asserts the final
 * database state**, and the races are made deterministic by parking the
 * contenders behind a lock an owner connection holds (`pg_blocking_pids`).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  TENANT_ROLE_DEFINITIONS,
  TENANT_ROLE_KEYS,
} from '@acc/contracts';
import { ORG_ADMIN_LOCK_CLASS, PLATFORM_ADMIN_LOCK_KEY, schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';

import { TenantDatabase } from '../src/database/tenant-database.service';
import { purgeAudit, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, url, type Org, type Person } from './revocation-fixtures';

const ORG_ADMIN_PERMISSIONS = TENANT_ROLE_DEFINITIONS.find(
  (r) => r.key === TENANT_ROLE_KEYS.ORG_ADMIN,
)!.permissions;
const REFUSAL = /refusing to leave organization .* with no active administrator/;

describe('last-organization-administrator invariant (ADR-015 R-11)', () => {
  let h: Harness;
  let w: RevocationWorld;
  let db: TenantDatabase;
  let owner: Pool;
  let superAdmin: Person;
  let superToken: string;
  let delegator: Person;
  let delegatorToken: string;

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    db = h.app.get(TenantDatabase);
    owner = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 6 });
    await w.init('liveness');
    superAdmin = await w.superAdmin('ola-super');
    superToken = await w.login(superAdmin.email);
    delegator = await w.person('ola-delegator');
    await w.grant(
      delegator.userId,
      await w.platformRole('ola_delegate', [
        PERMISSIONS.PLATFORM_ROLES_DELEGATE_TENANT,
        ...ORG_ADMIN_PERMISSIONS,
      ]),
      'platform',
      null,
    );
    delegatorToken = await w.login(delegator.email);
  }, 120_000);

  afterAll(async () => {
    await w.teardown();
    await owner.end();
    await h.close();
  }, 120_000);

  afterEach(() => purgeAudit(h.admin, sql`action = ${AUDIT_ACTIONS.USER_ROLE_REVOKED}`));

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
    expect([cause.code, cause.constraint]).toEqual(['23001', 'organization_admin_liveness']);
    expect(cause.message).toMatch(REFUSAL);
  };

  interface Held {
    readonly client: PoolClient;
    readonly pid: number;
    done: boolean;
  }

  /** An owner connection holding the organization's liveness lock, open. */
  async function holdLock(orgId: string): Promise<Held> {
    const client = await owner.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))', [
      ORG_ADMIN_LOCK_CLASS,
      orgId,
    ]);
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
   * as soon as any contender has settled without blocking (or after 8 s), so
   * that a contender that should have waited fails an assertion instead of a
   * timeout.
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
      const ok = await probe.query(text, [id]).then(
        (r) => r.rowCount === 1,
        () => false,
      );
      return ok;
    } finally {
      await probe.query('ROLLBACK').catch(() => undefined);
      probe.release();
    }
  }

  // ===========================================================================
  describe('A. the definition, the lock and the catalogue', () => {
    const FUNCTIONS = [
      'fn_assert_org_admin_remains',
      'fn_user_roles_org_admin_guard',
      'fn_users_org_admin_guard',
    ];

    it('the migration and @acc/db agree on the lock class, in the two-int4 form keyed by organization', async () => {
      const { rows } = await h.admin.execute<{ src: string }>(
        sql`SELECT prosrc AS src FROM pg_proc WHERE proname = 'fn_assert_org_admin_remains'`,
      );
      expect(rows[0]!.src).toContain(
        `pg_advisory_xact_lock(${ORG_ADMIN_LOCK_CLASS}, hashtext(p_org_id::text))`,
      );
    });

    it('the organization lock lives in a keyspace distinct from the platform lock (pg_locks)', async () => {
      const org = await w.org('keyspace');
      const a = await holdLock(org.orgId);
      const b = await owner.connect();
      try {
        await b.query('BEGIN');
        // The platform key does not collide with the organization lock …
        const platform = await b.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1::bigint) AS ok',
          [PLATFORM_ADMIN_LOCK_KEY.toString()],
        );
        expect(platform.rows[0]!.ok).toBe(true);
        // … while the same organization key does (positive control).
        const same = await b.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1::int4, hashtext($2::text)) AS ok',
          [ORG_ADMIN_LOCK_CLASS, org.orgId],
        );
        expect(same.rows[0]!.ok).toBe(false);
        const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        const { rows } = await owner.query<{ pid: number; classid: number; objsubid: number }>(
          `SELECT pid, classid::bigint::int AS classid, objsubid FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND pid = ANY ($1::int[]) ORDER BY objsubid DESC`,
          [[a.pid, bPid]],
        );
        // The organization lock: two-int4 form (objsubid 2). The platform key:
        // one-bigint form (objsubid 1), granted beside it.
        expect(rows.map((r) => [r.pid, r.objsubid])).toEqual([
          [a.pid, 2],
          [bPid, 1],
        ]);
        expect(rows[0]!.classid).toBe(ORG_ADMIN_LOCK_CLASS);
        await b.query('ROLLBACK');
      } finally {
        b.release();
        await release(a);
      }
    });

    it('the service takes the lock BEFORE it deletes the grant (lock first, row locks second)', async () => {
      const org = await w.org('ordering');
      const first = await w.admin(org, 'ord-1');
      const second = await w.admin(org, 'ord-2');
      const token = await w.login(first.email);
      const held = await holdLock(org.orgId);
      const pending = track(w.revoke(token, org.orgId, second.grantId).then((r) => r));
      try {
        const blocked = await untilBlocked(held.pid, 1, pending.settled);
        expect(blocked).not.toBeNull();
        // Parked on the organization lock …
        const { rows } = await owner.query<{ classid: number; objsubid: number }>(
          `SELECT classid::bigint::int AS classid, objsubid FROM pg_locks
            WHERE pid = $1 AND NOT granted AND locktype = 'advisory'`,
          [blocked![0]],
        );
        expect(rows).toEqual([{ classid: ORG_ADMIN_LOCK_CLASS, objsubid: 2 }]);
        // … and before the DELETE: the grant's row is not yet locked by it.
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

    it('disable takes the organization lock BEFORE it updates the user (lock first, row locks second)', async () => {
      const org = await w.org('ordering-disable');
      await w.admin(org, 'ordd-1');
      const second = await w.admin(org, 'ordd-2');
      const held = await holdLock(org.orgId);
      const pending = track(w.disable(superToken, org.orgId, second.userId).then((r) => r));
      try {
        const blocked = await untilBlocked(held.pid, 1, pending.settled);
        expect(blocked).not.toBeNull();
        const { rows } = await owner.query<{ classid: number; objsubid: number }>(
          `SELECT classid::bigint::int AS classid, objsubid FROM pg_locks
            WHERE pid = $1 AND NOT granted AND locktype = 'advisory'`,
          [blocked![0]],
        );
        expect(rows).toEqual([{ classid: ORG_ADMIN_LOCK_CLASS, objsubid: 2 }]);
        // The user's row is not yet locked by the disable.
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

    it('the trigger path itself parks behind the organization lock (service bypassed)', async () => {
      const org = await w.org('trigger-lock');
      const a = await w.admin(org, 'tl-a');
      await w.admin(org, 'tl-b');
      const held = await holdLock(org.orgId);
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
      expect(await w.admins(org.orgId)).toBe(2);
    }, 30_000);

    it('three triggers guard exactly the documented paths', async () => {
      const { rows } = await h.admin.execute<{ def: string }>(sql`
        SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
         WHERE NOT t.tgisinternal AND t.tgname LIKE '%org_admin_liveness%' ORDER BY t.tgname`);
      expect(rows.map((r) => r.def)).toEqual([
        "CREATE TRIGGER trg_user_roles_org_admin_liveness AFTER DELETE ON public.user_roles FOR EACH ROW WHEN ((old.scope_type = 'organization'::role_scope_type)) EXECUTE FUNCTION fn_user_roles_org_admin_guard()",
        "CREATE TRIGGER trg_user_roles_org_admin_liveness_update AFTER UPDATE OF scope_type, scope_id, user_id, role_id, org_id ON public.user_roles FOR EACH ROW WHEN ((old.scope_type = 'organization'::role_scope_type)) EXECUTE FUNCTION fn_user_roles_org_admin_guard()",
        "CREATE TRIGGER trg_users_org_admin_liveness AFTER UPDATE OF status ON public.users FOR EACH ROW WHEN (((old.status = 'active'::user_status) AND (new.status <> 'active'::user_status))) EXECUTE FUNCTION fn_users_org_admin_guard()",
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
          FROM pg_proc WHERE proname IN ('fn_assert_org_admin_remains',
            'fn_user_roles_org_admin_guard', 'fn_users_org_admin_guard') ORDER BY proname`);
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
             WHERE p.proname IN ('fn_assert_org_admin_remains',
                   'fn_user_roles_org_admin_guard', 'fn_users_org_admin_guard')
               AND r.rolname IN ('acc_app', 'acc_auth', 'acc_relay')
             ORDER BY 1, 2`,
      );
      expect(acl.rows.filter((r) => r.allowed)).toEqual([]);
      expect(acl.rows).toHaveLength(9);
      const publicAcl = await h.admin.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a
             WHERE p.proname IN ('fn_assert_org_admin_remains',
                   'fn_user_roles_org_admin_guard', 'fn_users_org_admin_guard')
               AND a.grantee = 0`,
      );
      expect(publicAcl.rows[0]!.n).toBe(0);
    });

    it('acc_app cannot call the invariant function directly', async () => {
      const org = await w.org('direct-call');
      await expect(
        db.withTenant({ orgId: org.orgId, userId: superAdmin.userId }, (tx) =>
          tx.execute(sql`SELECT fn_assert_org_admin_remains(${org.orgId}::uuid)`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    });
  });

  // ===========================================================================
  describe('B. revoking through the API', () => {
    let org: Org;
    beforeEach(async () => {
      org = await w.org('api');
    });

    it('the last administrator revoking itself: 409 AUTHZ_LAST_ORGANIZATION_ADMIN, the row and no audit row remain', async () => {
      const only = await w.admin(org, 'b-only');
      const token = await w.login(only.email);
      const res = await w.revoke(token, org.orgId, only.grantId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
      ]);
      expect(await w.grantExists(only.grantId)).toBe(true);
      expect(await w.revokedAudit(only.grantId)).toEqual([]);
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('a super administrator revoking the last administrator: 409, not a 403', async () => {
      const only = await w.admin(org, 'b-super');
      const res = await w.revoke(superToken, org.orgId, only.grantId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
      ]);
      expect(await w.grantExists(only.grantId)).toBe(true);
    });

    it('a delegated revocation of the last administrator (org_admin carrying a content key): 409', async () => {
      await w.attach(org.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, ['contacts.read']);
      const only = await w.admin(org, 'b-delegated');
      const res = await w.revoke(delegatorToken, org.orgId, only.grantId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
      ]);
      expect(await w.grantExists(only.grantId)).toBe(true);
    });

    it('a peer administrator, and oneself, may be revoked while another remains', async () => {
      const a = await w.admin(org, 'b-peer-a');
      const b = await w.admin(org, 'b-peer-b');
      const c = await w.admin(org, 'b-peer-c');
      const token = await w.login(a.email);
      expect((await w.revoke(token, org.orgId, b.grantId)).status).toBe(204);
      expect((await w.revoke(token, org.orgId, a.grantId)).status).toBe(204);
      expect(await w.admins(org.orgId)).toBe(1);
      const tokenC = await w.login(c.email);
      expect((await w.revoke(tokenC, org.orgId, c.grantId)).body.error?.code).toBe(
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
      );
    });

    it('a grant held by a user who is not active is not counted, so revoking it is allowed', async () => {
      const active = await w.admin(org, 'b-active');
      const invited = await w.person('b-invited', 'invited');
      const invitedGrant = await w.grant(
        invited.userId,
        org.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
        'organization',
        org.orgId,
      );
      const token = await w.login(active.email);
      expect((await w.revoke(token, org.orgId, invitedGrant)).status).toBe(204);
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('the lock is released on rollback: after a 409 the next revocation is not blocked', async () => {
      const only = await w.admin(org, 'b-lock');
      const token = await w.login(only.email);
      await w.revoke(token, org.orgId, only.grantId).expect(409);
      const spare = await w.admin(org, 'b-lock-spare');
      await w.revoke(token, org.orgId, spare.grantId).expect(204);
      expect(await w.admins(org.orgId)).toBe(1);
    }, 20_000);

    it('ordinary tenant revocation in an organization without administrators is unaffected', async () => {
      const member = await w.person('b-member');
      const grantId = await w.grant(
        member.userId,
        org.roles[TENANT_ROLE_KEYS.READ_ONLY]!,
        'organization',
        org.orgId,
      );
      expect((await w.revoke(superToken, org.orgId, grantId)).status).toBe(204);
      expect(await w.admins(org.orgId)).toBe(0);
    });
  });

  // ===========================================================================
  describe('C. disabling through the API', () => {
    it('disabling the last administrator: 409 AUTHZ_LAST_ORGANIZATION_ADMIN and the user stays active', async () => {
      const org = await w.org('disable');
      const only = await w.admin(org, 'c-only');
      const res = await w.disable(superToken, org.orgId, only.userId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
      ]);
      const [row] = await h.admin
        .select({ status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, only.userId));
      expect(row!.status).toBe('active');
    });

    it('disabling an administrator while another remains is allowed', async () => {
      const org = await w.org('disable-ok');
      const a = await w.admin(org, 'c-a');
      await w.admin(org, 'c-b');
      expect((await w.disable(superToken, org.orgId, a.userId)).status).toBe(200);
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('an administrator of two organizations, the last of one: refused for the identity as a whole', async () => {
      const x = await w.org('disable-x');
      const y = await w.org('disable-y');
      const both = await w.admin(x, 'c-both');
      await w.grant(both.userId, y.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, 'organization', y.orgId);
      await w.admin(x, 'c-x-spare');
      const res = await w.disable(superToken, x.orgId, both.userId);
      expect([res.status, res.body.error?.code]).toEqual([
        409,
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
      ]);
      expect([await w.admins(x.orgId), await w.admins(y.orgId)]).toEqual([2, 1]);
    });
  });

  // ===========================================================================
  describe('D. the database backstop, with the service bypassed', () => {
    let org: Org;
    let only: Person & { grantId: string };
    beforeEach(async () => {
      org = await w.org('db');
      only = await w.admin(org, 'd-only');
    });

    it('owner: deleting the last administrator grant is refused', async () => {
      await expectDbRefusal(
        h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, only.grantId)),
      );
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('owner: disabling the last administrator is refused', async () => {
      await expectDbRefusal(
        h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, only.userId)),
      );
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('owner: deleting the last administrator’s user row is refused through the cascade', async () => {
      await expectDbRefusal(h.admin.delete(schema.users).where(eq(schema.users.id, only.userId)));
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('owner: moving the last administrator grant to another role is refused', async () => {
      await expectDbRefusal(
        h.admin
          .update(schema.userRoles)
          .set({ roleId: org.roles[TENANT_ROLE_KEYS.READ_ONLY]! })
          .where(eq(schema.userRoles.id, only.grantId)),
      );
    });

    it('owner: reassigning the last administrator grant to an inactive user is refused; to an active one, allowed', async () => {
      const invited = await w.person('d-invited', 'invited');
      await expectDbRefusal(
        h.admin
          .update(schema.userRoles)
          .set({ userId: invited.userId })
          .where(eq(schema.userRoles.id, only.grantId)),
      );
      const active = await w.person('d-active');
      await h.admin
        .update(schema.userRoles)
        .set({ userId: active.userId })
        .where(eq(schema.userRoles.id, only.grantId));
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('acc_app: deleting the last administrator grant is refused', async () => {
      await expectDbRefusal(
        db.withTenant({ orgId: org.orgId, userId: only.userId }, (tx) =>
          tx.delete(schema.userRoles).where(eq(schema.userRoles.id, only.grantId)),
        ),
      );
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('acc_app: disabling the last administrator is refused', async () => {
      await expectDbRefusal(
        db.withTenant({ orgId: org.orgId, userId: only.userId }, (tx) =>
          tx
            .update(schema.users)
            .set({ status: 'disabled' })
            .where(eq(schema.users.id, only.userId)),
        ),
      );
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('with a second administrator present each removal is allowed', async () => {
      const second = await w.admin(org, 'd-second');
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, only.grantId));
      expect(await w.admins(org.orgId)).toBe(1);
      await expectDbRefusal(
        h.admin
          .update(schema.users)
          .set({ status: 'disabled' })
          .where(eq(schema.users.id, second.userId)),
      );
    });

    it('a suspended organization is not exempt (no status exemption)', async () => {
      await h.admin
        .update(schema.organizations)
        .set({ status: 'suspended', statusChangedAt: new Date(), statusReason: 'r11 test' })
        .where(eq(schema.organizations.id, org.orgId));
      await expectDbRefusal(
        h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, only.grantId)),
      );
      expect(await w.admins(org.orgId)).toBe(1);
    });

    it('the exemption: deleting the organization cascades its last administrator grant', async () => {
      await w.deleteOrg(org.orgId);
      expect(await w.grantExists(only.grantId)).toBe(false);
    });
  });

  // ===========================================================================
  describe('E. an organization that never had an administrator', () => {
    it('is created through the API, and granting and revoking in it are unaffected', async () => {
      const slug = `r11-never-${randomBytes(5).toString('hex')}`;
      const created = await request(h.app.getHttpServer())
        .post(url('/organizations'))
        .set('authorization', `Bearer ${superToken}`)
        .send({ name: 'Never administered', slug, resellerId: w.resellerId });
      expect(created.status).toBe(201);
      const orgId = created.body.data.id as string;
      w.createdOrgs.push(orgId);
      expect(await w.admins(orgId)).toBe(0);

      const [readOnly] = await h.admin
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(sql`org_id = ${orgId} AND key = 'read_only'`);
      const member = await w.person('e-member');
      const grantId = await w.grant(member.userId, readOnly!.id, 'organization', orgId);
      // Owner delete of a non-administrator grant, and a disable of its holder.
      await h.admin
        .update(schema.users)
        .set({ status: 'disabled' })
        .where(eq(schema.users.id, member.userId));
      await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.id, grantId));
      expect(await w.admins(orgId)).toBe(0);
    });
  });

  // ===========================================================================
  describe('F. concurrency — deterministic, contenders parked behind the lock', () => {
    /**
     * Parks `contenders` behind the organization lock, asserts every one of
     * them is waiting on it, releases it and returns what each answered. A
     * contender that does not wait is an assertion failure, not a timeout.
     */
    async function race<T>(orgId: string, contenders: (() => Promise<T>)[]): Promise<T[]> {
      const held = await holdLock(orgId);
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

    it('two administrators revoking each other: exactly one 204 and one 409', async () => {
      const org = await w.org('mutual');
      const a = await w.admin(org, 'f-a');
      const b = await w.admin(org, 'f-b');
      const [ta, tb] = [await w.login(a.email), await w.login(b.email)];
      const results = await race(org.orgId, [
        () => w.revoke(ta, org.orgId, b.grantId).then((r) => r),
        () => w.revoke(tb, org.orgId, a.grantId).then((r) => r),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
      );
      expect(await w.admins(org.orgId)).toBe(1);
    }, 30_000);

    it('a revocation racing a disable: one succeeds, the other is 409', async () => {
      const org = await w.org('revoke-disable');
      const a = await w.admin(org, 'f-rd-a');
      const b = await w.admin(org, 'f-rd-b');
      const [revoked, disabled] = await race(org.orgId, [
        () => w.revoke(superToken, org.orgId, a.grantId).then((r) => r.status),
        () => w.disable(superToken, org.orgId, b.userId).then((r) => r.status),
      ]);
      expect([revoked, disabled].filter((s) => s === 409)).toHaveLength(1);
      expect([revoked, disabled].filter((s) => s === 204 || s === 200)).toHaveLength(1);
      expect(await w.admins(org.orgId)).toBe(1);
    }, 30_000);

    it('four concurrent removals against two administrators leave one', async () => {
      const org = await w.org('four');
      const a = await w.admin(org, 'f-4a');
      const b = await w.admin(org, 'f-4b');
      const statuses = await race(
        org.orgId,
        [a.grantId, b.grantId, a.grantId, b.grantId].map(
          (id) => () => w.revoke(superToken, org.orgId, id).then((r) => r.status),
        ),
      );
      expect(statuses.filter((s) => s === 204)).toHaveLength(1);
      expect(statuses.every((s) => [204, 404, 409].includes(s))).toBe(true);
      expect(await w.admins(org.orgId)).toBe(1);
    }, 30_000);

    it('database: two owner connections each delete a different administrator — exactly one commits', async () => {
      const org = await w.org('db-race');
      const a = await w.admin(org, 'f-db-a');
      const b = await w.admin(org, 'f-db-b');
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
        expect([error?.code, error?.constraint]).toEqual(['23001', 'organization_admin_liveness']);
        expect(await w.admins(org.orgId)).toBe(1);
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
    }, 30_000);
  });
});

/** `md5(prosrc)` of the three functions of migration `0028`. */
const PINNED_MD5: Record<string, string> = {
  fn_assert_org_admin_remains: '2caae5a01200466453b7ee4213834629',
  fn_user_roles_org_admin_guard: 'a992bdeeadf06e5482a87a41ffa11caf',
  fn_users_org_admin_guard: 'dc316254087c5df43549969766c581ba',
};
