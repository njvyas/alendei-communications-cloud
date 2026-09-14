/**
 * Pooled-connection tenant-context hardening (`TESTING.md` §6h).
 *
 * `SET LOCAL` is what makes connection pooling safe across tenants: the context
 * a transaction establishes is discarded when that transaction ends, on commit
 * and on rollback alike, so the next tenant's work on the same physical
 * connection starts from nothing (`TENANCY.md` §5 step 7, `DATABASE.md` §14a).
 *
 * Two properties have to be demonstrated, and neither can be demonstrated by
 * reading `current_setting()` back:
 *
 *   1. what a query can *see* changes with the context, and
 *   2. what a query can see with **no** context is nothing.
 *
 * Property 2 is the one that catches a connection-level `SET`. A GUC left on
 * the connection after commit is invisible to every transaction that
 * establishes its own context — every one of them overwrites all six variables
 * — so it only shows up in a query that deliberately establishes none. That
 * bare probe is therefore the load-bearing assertion in both tests here, and it
 * is written against real rows rather than against the setting.
 *
 * Everything runs through the production helper `withTenantTransaction` on a
 * `max: 1` pool, so the connection under test is the same physical backend
 * throughout — asserted with `pg_backend_pid()`, not assumed.
 */
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';

import { createDatabase, createPool, withTenantTransaction, type Database } from '../client';
import * as schema from '../schema';
import {
  connect,
  createTenant,
  destroyTenant,
  loadTestEnv,
  type Principals,
  type TenantFixture,
} from './harness';

/** The failure injected mid-transaction, distinguishable from a real fault. */
class InjectedFailure extends Error {
  constructor() {
    super('injected mid-transaction failure');
    this.name = 'InjectedFailure';
  }
}

describe('pooled-connection tenant context', () => {
  let principals: Principals;
  let pool: Pool;
  let db: Database;
  let orgA: TenantFixture;
  let orgB: TenantFixture;

  beforeAll(async () => {
    loadTestEnv();
    principals = connect();
    orgA = await createTenant(principals.admin, 'pool-a');
    orgB = await createTenant(principals.admin, 'pool-b');

    // One connection, so "the pooled connection is reused" is a fact about this
    // test rather than a hope about pool scheduling. It is built with the
    // production `createPool`/`createDatabase` pair, as the API does.
    pool = createPool({
      connectionString: process.env.DATABASE_URL!,
      max: 1,
      applicationName: 'acc-test-pool-context',
    });
    db = createDatabase(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await destroyTenant(principals.admin, orgA);
    await destroyTenant(principals.admin, orgB);
    await principals.close();
  }, 60_000);

  /** The backend process behind the single pooled connection. */
  const backendPid = async (): Promise<number> => {
    const { rows } = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    return Number(rows[0]!.pid);
  };

  /** Workspace ids visible to a query, RLS-filtered and nothing else. */
  const visibleWorkspaceIds = async (
    executor: Pick<Database, 'select'>,
  ): Promise<readonly string[]> => {
    const rows = await executor.select({ id: schema.workspaces.id }).from(schema.workspaces);
    return rows.map((r) => r.id);
  };

  /**
   * A query run on the pooled connection with **no** tenant context
   * established. Under `SET LOCAL` this must see nothing; under a
   * connection-level `SET` it would still see whatever the previous
   * transaction left behind.
   */
  const bareProbe = (): Promise<readonly string[]> => visibleWorkspaceIds(db);

  const nameOf = async (workspaceId: string): Promise<string> => {
    const [row] = await principals.admin
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    return row!.name;
  };

  // ---------------------------------------------------------------------------
  it('does not carry one organization’s context into the next on the same connection', async () => {
    const pidBefore = await backendPid();

    // 1-4. Organization A's transaction, through the sanctioned helper.
    const seenByA = await withTenantTransaction(db, { orgId: orgA.orgId }, (tx) =>
      visibleWorkspaceIds(tx),
    );
    expect(seenByA).toContain(orgA.workspaceId);
    expect(seenByA).not.toContain(orgB.workspaceId);

    // 5. The same pooled connection, with no context of its own. This is the
    //    assertion a connection-level `SET` fails: after A's transaction
    //    commits, a leaked GUC would still make A's rows visible here.
    expect(await bareProbe()).toHaveLength(0);

    // 6-9. Organization B reuses the connection and sees only B.
    const seenByB = await withTenantTransaction(db, { orgId: orgB.orgId }, (tx) =>
      visibleWorkspaceIds(tx),
    );
    expect(seenByB).toContain(orgB.workspaceId);
    expect(seenByB).not.toContain(orgA.workspaceId);

    // And A is still unreachable once the connection has moved on.
    expect(await bareProbe()).toHaveLength(0);
    expect(await backendPid()).toBe(pidBefore);
  });

  // ---------------------------------------------------------------------------
  it('clears context and rolls back when a transaction fails mid-flight', async () => {
    const pidBefore = await backendPid();
    const originalName = await nameOf(orgA.workspaceId);
    const mutatedName = `mutated-${orgA.slug}`;

    // The same two-organization sequence as above, starting from a committed
    // Organization A transaction so the error path is entered from a connection
    // that has genuinely carried A's work.
    const seenByA = await withTenantTransaction(db, { orgId: orgA.orgId }, (tx) =>
      visibleWorkspaceIds(tx),
    );
    expect(seenByA).toContain(orgA.workspaceId);
    expect(await bareProbe()).toHaveLength(0);

    // Fault injected after the context is established and after a real write,
    // so the rollback has something observable to undo.
    await expect(
      withTenantTransaction(db, { orgId: orgA.orgId }, async (tx) => {
        expect(await visibleWorkspaceIds(tx)).toContain(orgA.workspaceId);
        await tx
          .update(schema.workspaces)
          .set({ name: mutatedName })
          .where(eq(schema.workspaces.id, orgA.workspaceId));
        throw new InjectedFailure();
      }),
    ).rejects.toThrow(InjectedFailure);

    // The transaction rolled back: the write is gone.
    expect(await nameOf(orgA.workspaceId)).toBe(originalName);

    // The context did not survive the error path either.
    expect(await bareProbe()).toHaveLength(0);

    // The connection is safe to reuse, and the next tenant sees only itself.
    const seenByB = await withTenantTransaction(db, { orgId: orgB.orgId }, (tx) =>
      visibleWorkspaceIds(tx),
    );
    expect(seenByB).toContain(orgB.workspaceId);
    expect(seenByB).not.toContain(orgA.workspaceId);

    // Organization A remains inaccessible from the connection afterwards.
    expect(await bareProbe()).toHaveLength(0);
    expect(await backendPid()).toBe(pidBefore);
  });

  // ---------------------------------------------------------------------------
  it('keeps the connection usable for a full tenant cycle after a failure', async () => {
    // A failure is not a poisoned connection: A can still do ordinary work on
    // it immediately afterwards, which is what makes `SET LOCAL` sufficient
    // without a manual reset step that an error path could skip.
    await expect(
      withTenantTransaction(db, { orgId: orgA.orgId }, async () => {
        throw new InjectedFailure();
      }),
    ).rejects.toThrow(InjectedFailure);

    const seenByA = await withTenantTransaction(db, { orgId: orgA.orgId }, (tx) =>
      visibleWorkspaceIds(tx),
    );
    expect(seenByA).toContain(orgA.workspaceId);
    expect(seenByA).not.toContain(orgB.workspaceId);
    expect(await bareProbe()).toHaveLength(0);
  });
});
