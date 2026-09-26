/**
 * Shared-reseller tenant isolation, proven directly against PostgreSQL
 * (Gate-B security audit, Blocker 1).
 *
 * The defect: `app.current_reseller_id` was filled from the *selected
 * organization's* reseller for every principal, and `app_org_in_scope()` admits
 * every organization beneath that reseller — so two organizations sharing a
 * reseller (every direct customer shares "Alendei Direct") could read each
 * other. Every earlier fixture gave each tenant its own reseller, so no test
 * could see it.
 *
 * Topology built here, all planted by the owner:
 *
 *     Reseller A ── Org A1
 *                └─ Org A2
 *     Reseller B ── Org B1
 *
 * Every query below runs as the non-owner `acc_app` principal, through the
 * production `withTenantTransaction`, with **no application-side filter** — each
 * statement reads or writes the whole table and RLS alone decides what it
 * reaches. Fixture ids are only used afterwards to pick this suite's rows out of
 * whatever else the database holds.
 */
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { createDatabase, createPool, withTenantTransaction, type Database } from '../client';
import type { TenantSession } from '../tenant-context';
import {
  connect,
  createReseller,
  createTenant,
  destroyReseller,
  destroyTenant,
  loadTestEnv,
  plantPlatformAdmin,
  plantPlatformSupport,
  plantResellerAdmin,
  purgeAuditRows,
  removeIdentities,
  type Principals,
  type TenantFixture,
} from './harness';

/** Every tenant-bearing table, and the column that names its organization. */
const ORG_SCOPED: readonly { table: string; column: string }[] = [
  { table: 'organizations', column: 'id' },
  { table: 'workspaces', column: 'org_id' },
  { table: 'teams', column: 'org_id' },
  { table: 'api_keys', column: 'org_id' },
  { table: 'ws_tickets', column: 'org_id' },
  { table: 'idempotency_keys', column: 'org_id' },
  { table: 'roles', column: 'org_id' },
  { table: 'role_permissions', column: 'org_id' },
  { table: 'user_roles', column: 'org_id' },
  { table: 'audit_logs', column: 'org_id' },
];

class Rollback extends Error {}

/** Asserts a refusal by PostgreSQL itself — drizzle carries it on `cause`. */
async function expectRefusal(work: Promise<unknown>, reason: RegExp): Promise<void> {
  const failure = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(failure).toBeDefined();
  const cause = (failure as { cause?: { message?: string } }).cause;
  expect(cause?.message ?? (failure as Error).message).toMatch(reason);
}

describe('shared-reseller isolation — direct PostgreSQL as acc_app', () => {
  let db: Principals;
  let pool: ReturnType<typeof createPool>;
  let app: Database;

  let resellerA: string;
  let resellerB: string;
  let a1: TenantFixture;
  let a2: TenantFixture;
  let b1: TenantFixture;
  let resellerAAdmin: string;
  let resellerBAdmin: string;
  let platformAdmin: string;
  let support: string;

  const orgs = (): Record<string, string> => ({ A1: a1.orgId, A2: a2.orgId, B1: b1.orgId });
  const labelOf = (id: string): string | undefined =>
    Object.entries(orgs()).find(([, v]) => v === id)?.[0];

  /** Plants one of each tenant-sensitive row a table-level policy governs. */
  async function plantRows(t: TenantFixture): Promise<void> {
    await db.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(sql`
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT ${t.roleId}, id FROM permissions WHERE key = 'workspaces.read'
        ON CONFLICT DO NOTHING`);
    });
    await db.admin.execute(sql`
      INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
      VALUES (${t.userId}, ${`h-${uuidv7()}`}, now() + interval '1 day')`);
    await db.admin.execute(sql`
      INSERT INTO ws_tickets (ticket_hash, user_id, org_id, expires_at)
      VALUES (${`t-${uuidv7()}`}, ${t.userId}, ${t.orgId}, now() + interval '30 seconds')`);
    await db.admin.execute(sql`
      INSERT INTO idempotency_keys (org_id, endpoint, idempotency_key, request_hash)
      VALUES (${t.orgId}, 'POST /test', ${`k-${uuidv7()}`}, 'x')`);
    await db.admin.execute(sql`
      INSERT INTO audit_logs (scope_type, scope_id, actor_type, actor_label, action,
                              resource_type, outcome, correlation_id)
      VALUES ('organization', ${t.orgId}, 'system', 'test', 'organization.updated',
              'organization', 'success', ${uuidv7()})`);
  }

  beforeAll(async () => {
    loadTestEnv();
    db = connect();
    pool = createPool({
      connectionString: process.env.DATABASE_URL!,
      max: 2,
      applicationName: 'acc-test-shared-reseller',
    });
    app = createDatabase(pool);

    resellerA = await createReseller(db.admin, 'shared-a');
    resellerB = await createReseller(db.admin, 'shared-b');
    a1 = await createTenant(db.admin, 'sr-a1', { resellerId: resellerA });
    a2 = await createTenant(db.admin, 'sr-a2', { resellerId: resellerA });
    b1 = await createTenant(db.admin, 'sr-b1', { resellerId: resellerB });
    for (const t of [a1, a2, b1]) await plantRows(t);

    resellerAAdmin = await plantResellerAdmin(db.admin, resellerA, 'sr-reseller-a');
    resellerBAdmin = await plantResellerAdmin(db.admin, resellerB, 'sr-reseller-b');
    platformAdmin = await plantPlatformAdmin(db.admin, 'sr-platform');
    support = await plantPlatformSupport(db.admin, 'sr-support');
  }, 60_000);

  afterAll(async () => {
    await removeIdentities(db.admin, [resellerAAdmin, resellerBAdmin, platformAdmin, support]);
    for (const t of [a1, a2, b1]) {
      await purgeAuditRows(db.admin, t.orgId);
      await destroyTenant(db.admin, t);
    }
    await destroyReseller(db.admin, resellerA);
    await destroyReseller(db.admin, resellerB);
    await pool.end();
    await db.close();
  }, 60_000);

  // --- contexts: exactly what the application now computes for each principal ---
  const member = (t: TenantFixture): TenantSession => ({ orgId: t.orgId, userId: t.userId });
  const asResellerA = (org: TenantFixture): TenantSession => ({
    orgId: org.orgId,
    resellerId: resellerA,
    userId: resellerAAdmin,
  });
  const asResellerB = (): TenantSession => ({
    orgId: b1.orgId,
    resellerId: resellerB,
    userId: resellerBAdmin,
  });
  const asPlatform = (): TenantSession => ({ isPlatformAdmin: true, userId: platformAdmin });

  /** Which fixture organizations each table exposes under `session`, unfiltered. */
  async function visibility(session: TenantSession): Promise<Record<string, string[]>> {
    return withTenantTransaction(app, session, async (tx) => {
      const out: Record<string, string[]> = {};
      for (const { table, column } of ORG_SCOPED) {
        const { rows } = await tx.execute<{ org: string | null }>(
          sql.raw(`SELECT DISTINCT ${column}::text AS org FROM ${table}`),
        );
        out[table] = rows
          .map((r) => (r.org ? labelOf(r.org) : undefined))
          .filter((l): l is string => l !== undefined)
          .sort();
      }
      const users = await tx.execute<{ id: string }>(sql`SELECT id::text AS id FROM users`);
      out.users = users.rows
        .map((r) => [a1, a2, b1].find((t) => t.userId === r.id))
        .filter((t): t is TenantFixture => t !== undefined)
        .map((t) => labelOf(t.orgId)!)
        .sort();
      const sessions = await tx.execute<{ user_id: string }>(
        sql`SELECT user_id::text FROM sessions`,
      );
      out.sessions = [
        ...new Set(
          sessions.rows
            .map((r) => [a1, a2, b1].find((t) => t.userId === r.user_id))
            .filter((t): t is TenantFixture => t !== undefined)
            .map((t) => labelOf(t.orgId)!),
        ),
      ].sort();
      const resellers = await tx.execute<{ id: string }>(sql`SELECT id::text AS id FROM resellers`);
      out.resellers = resellers.rows
        .map((r) => (r.id === resellerA ? 'RA' : r.id === resellerB ? 'RB' : undefined))
        .filter((l): l is string => l !== undefined)
        .sort();
      return out;
    });
  }

  const allTables = [...ORG_SCOPED.map((t) => t.table), 'users', 'sessions'];
  const expectEveryTable = (seen: Record<string, string[]>, expected: string[]): void => {
    for (const table of allTables)
      expect(`${table}=${seen[table]!.join(',')}`).toBe(`${table}=${expected.join(',')}`);
  };

  // ===========================================================================
  describe('reads, with no application filter', () => {
    it('Org A1 → Org A2 = DENY and Org A1 → Org B1 = DENY, on every tenant table', async () => {
      const seen = await visibility(member(a1));
      expectEveryTable(seen, ['A1']);
      // The parent reseller's own row is readable (branding), the sibling's is not.
      expect(seen.resellers).toEqual(['RA']);
    });

    it('Org A2 sees only A2, and Org B1 only B1', async () => {
      expectEveryTable(await visibility(member(a2)), ['A2']);
      expectEveryTable(await visibility(member(b1)), ['B1']);
    });

    it('Reseller A → Org A1 and Org A2 = ALLOW; Reseller A → Org B1 = DENY', async () => {
      const seen = await visibility(asResellerA(a1));
      for (const { table } of ORG_SCOPED)
        expect(`${table}=${seen[table]!.join(',')}`).toBe(`${table}=A1,A2`);
      expect(seen.users).toEqual(['A1', 'A2']);
      expect(seen.resellers).toEqual(['RA']);
    });

    it('Reseller B → Org A1/A2 = DENY', async () => {
      const seen = await visibility(asResellerB());
      expectEveryTable(seen, ['B1']);
      expect(seen.resellers).toEqual(['RB']);
    });

    it('Platform administrator = ALLOW across both resellers', async () => {
      const seen = await visibility(asPlatform());
      for (const { table } of ORG_SCOPED)
        expect(`${table}=${seen[table]!.join(',')}`).toBe(`${table}=A1,A2,B1`);
      expect(seen.resellers).toEqual(['RA', 'RB']);
    });
  });

  // ===========================================================================
  describe('the database refuses the unbacked claim on its own (migration 0010)', () => {
    it('the old derivation — Org A1 member claiming its org’s reseller — still sees only A1', async () => {
      // This is byte-for-byte the context the defective resolver produced.
      const forged = await visibility({
        orgId: a1.orgId,
        resellerId: resellerA,
        userId: a1.userId,
      });
      expectEveryTable(forged, ['A1']);
    });

    it('a reseller claim with no user at all confers nothing', async () => {
      const forged = await visibility({ resellerId: resellerA });
      for (const { table } of ORG_SCOPED) expect(forged[table]).toEqual([]);
    });

    it('alendei_support claiming the platform flag gets member-level reach in its selected org, not platform-wide', async () => {
      const forged = await visibility({ orgId: a1.orgId, isPlatformAdmin: true, userId: support });
      expectEveryTable(forged, ['A1']);
    });

    it('a platform claim with no user confers nothing', async () => {
      const forged = await visibility({ isPlatformAdmin: true });
      for (const { table } of ORG_SCOPED) expect(forged[table]).toEqual([]);
    });

    it('a disabled reseller administrator’s claim stops being honoured', async () => {
      await db.admin.execute(
        sql`UPDATE users SET status = 'disabled' WHERE id = ${resellerAAdmin}`,
      );
      try {
        expectEveryTable(await visibility(asResellerA(a1)), ['A1']);
      } finally {
        await db.admin.execute(
          sql`UPDATE users SET status = 'active' WHERE id = ${resellerAAdmin}`,
        );
      }
    });

    /**
     * Negative control: with the pre-0010 unvalidated accessor restored, the
     * same forged context reaches Org A2. So the refusal above is the
     * validation's doing, not an accident of the fixtures.
     */
    it('negative control — restoring the unvalidated accessor re-opens the sibling', async () => {
      const forged: TenantSession = { orgId: a1.orgId, resellerId: resellerA, userId: a1.userId };
      const { rows } = await db.admin.execute<{ def: string }>(
        sql`SELECT pg_get_functiondef('app_current_reseller_id()'::regprocedure) AS def`,
      );
      await db.admin.execute(sql`
        CREATE OR REPLACE FUNCTION app_current_reseller_id() RETURNS uuid
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ SELECT nullif(current_setting('app.current_reseller_id', true), '')::uuid $$`);
      try {
        const reopened = await visibility(forged);
        expect(reopened.workspaces).toEqual(['A1', 'A2']);
        expect(reopened.api_keys).toEqual(['A1', 'A2']);
      } finally {
        await db.admin.execute(sql.raw(rows[0]!.def));
      }
      expectEveryTable(await visibility(forged), ['A1']);
    });

    it('negative control — restoring the unvalidated platform flag hands support every tenant', async () => {
      const forged: TenantSession = { orgId: a1.orgId, isPlatformAdmin: true, userId: support };
      const { rows } = await db.admin.execute<{ def: string }>(
        sql`SELECT pg_get_functiondef('app_is_platform_admin()'::regprocedure) AS def`,
      );
      await db.admin.execute(sql`
        CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ SELECT coalesce(nullif(current_setting('app.is_platform_admin', true), ''), 'off') = 'on' $$`);
      try {
        expect((await visibility(forged)).workspaces).toEqual(['A1', 'A2', 'B1']);
      } finally {
        await db.admin.execute(sql.raw(rows[0]!.def));
      }
      expectEveryTable(await visibility(forged), ['A1']);
    });
  });

  // ===========================================================================
  describe('writes, with no application filter', () => {
    /** Runs `work` and always rolls back, returning what it produced. */
    const attempt = async <T>(
      session: TenantSession,
      work: (tx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0]) => Promise<T>,
    ): Promise<T> => {
      let result: T | undefined;
      await withTenantTransaction(app, session, async (tx) => {
        result = await work(tx);
        throw new Rollback();
      }).catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
      return result as T;
    };
    const touch =
      (table: string, orgId: string) =>
      async (tx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0]) =>
        (await tx.execute(sql.raw(`UPDATE ${table} SET org_id = org_id WHERE org_id = '${orgId}'`)))
          .rowCount ?? 0;

    const UPDATABLE = [
      'workspaces',
      'teams',
      'api_keys',
      'ws_tickets',
      'idempotency_keys',
      'roles',
      'role_permissions',
      'user_roles',
    ];

    it('Org A1 cannot update any Org A2 or Org B1 row', async () => {
      for (const table of UPDATABLE) {
        expect(`${table}:${await attempt(member(a1), touch(table, a2.orgId))}`).toBe(`${table}:0`);
        expect(`${table}:${await attempt(member(a1), touch(table, b1.orgId))}`).toBe(`${table}:0`);
      }
      // Its own rows remain writable — the control that the statement works.
      expect(await attempt(member(a1), touch('workspaces', a1.orgId))).toBeGreaterThan(0);
    });

    it('Org A1 cannot delete Org A2 rows, nor update Org A2’s users or sessions', async () => {
      const deleted = await attempt(
        member(a1),
        async (tx) =>
          (await tx.execute(sql`DELETE FROM role_permissions WHERE org_id = ${a2.orgId}`))
            .rowCount ?? 0,
      );
      expect(deleted).toBe(0);
      const users = await attempt(
        member(a1),
        async (tx) =>
          (await tx.execute(sql`UPDATE users SET phone = NULL WHERE id = ${a2.userId}`)).rowCount ??
          0,
      );
      expect(users).toBe(0);
      const sessions = await attempt(
        member(a1),
        async (tx) =>
          (
            await tx.execute(
              sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${a2.userId}`,
            )
          ).rowCount ?? 0,
      );
      expect(sessions).toBe(0);
    });

    it('Org A1 cannot place a row in Org A2', async () => {
      await expectRefusal(
        attempt(member(a1), (tx) =>
          tx.execute(
            sql`INSERT INTO workspaces (org_id, name, slug) VALUES (${a2.orgId}, 'x', ${`x-${uuidv7()}`})`,
          ),
        ),
        /row-level security/,
      );
    });

    it('Org A1 → Reseller A = DENY: no write to its own reseller, no new organization beneath it', async () => {
      const updated = await attempt(
        member(a1),
        async (tx) =>
          (await tx.execute(sql`UPDATE resellers SET name = name WHERE id = ${resellerA}`))
            .rowCount ?? 0,
      );
      expect(updated).toBe(0);
      await expectRefusal(
        attempt(member(a1), (tx) =>
          tx.execute(
            sql`INSERT INTO organizations (name, slug, reseller_id) VALUES ('x', ${`o-${uuidv7()}`}, ${resellerA})`,
          ),
        ),
        /row-level security/,
      );
    });

    it('Org A1 → Reseller B = DENY', async () => {
      const updated = await attempt(
        member(a1),
        async (tx) =>
          (await tx.execute(sql`UPDATE resellers SET name = name WHERE id = ${resellerB}`))
            .rowCount ?? 0,
      );
      expect(updated).toBe(0);
    });

    it('Reseller A may write in A1 and A2 but not in B1', async () => {
      expect(await attempt(asResellerA(a1), touch('workspaces', a2.orgId))).toBeGreaterThan(0);
      expect(await attempt(asResellerA(a1), touch('workspaces', a1.orgId))).toBeGreaterThan(0);
      expect(await attempt(asResellerA(a1), touch('workspaces', b1.orgId))).toBe(0);
    });

    it('alendei_support is not a platform writer: no cross-tenant write, no platform grant', async () => {
      const forged: TenantSession = { orgId: a1.orgId, isPlatformAdmin: true, userId: support };
      expect(await attempt(forged, touch('workspaces', b1.orgId))).toBe(0);
      await expectRefusal(
        attempt(forged, (tx) =>
          tx.execute(sql`
            INSERT INTO user_roles (user_id, role_id, scope_type)
            SELECT ${a1.userId}, id, 'platform' FROM roles WHERE key = 'alendei_super_admin' AND org_id IS NULL`),
        ),
        /may only be granted by a platform admin|row-level security/,
      );
    });
  });
});
