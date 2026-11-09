import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import {
  connect,
  createTenant,
  destroyTenant,
  type Principals,
  type TenantFixture,
} from './harness';

/**
 * Phase 7 PR 7-6a — tenant billing reads (migration `0055`; DECISIONS.md §1zi.9
 * D-76-2). Tenant isolation is the database's, so it is proved here, as `acc_app`
 * under a tenant context, independently of any API filter:
 *
 *   1. A tenant sees its own accounts and ledger, and nothing of another
 *      organization's, whatever the query asks for.
 *   2. Without a valid tenant content context it sees nothing.
 *   3. It never sees a provider cost — even its own — at the database layer.
 *   4. It cannot write: no INSERT, UPDATE, DELETE or TRUNCATE on any of the three
 *      tables, and no access to a ledger partition directly.
 *   5. The policies are exactly the three SELECT policies for acc_app, and every
 *      partition still reports its privileges restricted.
 */
describe('Phase 7 PR 7-6a — tenant billing reads (migration 0055)', () => {
  let db: Principals;
  let A: TenantFixture;
  let B: TenantFixture;
  let channelId: string;
  let providerId: string;
  const messages: Record<string, string> = {};
  const attempts: Record<string, string> = {};

  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  /** One acc_app transaction under a tenant context (the API-key arm), always rolled back. */
  async function asTenant<R>(
    context: { org?: string; apiKey?: string } | null,
    work: (c: PoolClient) => Promise<R>,
  ): Promise<R> {
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      if (context?.org)
        await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [context.org]);
      if (context?.apiKey) {
        await c.query(`SELECT set_config('app.current_api_key_id', $1, true)`, [context.apiKey]);
      }
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }
  const ctx = (t: TenantFixture) => ({ org: t.orgId, apiKey: t.apiKeyId });

  async function code(c: PoolClient, text: string, params: unknown[] = []): Promise<string> {
    await c.query('SAVEPOINT s');
    try {
      await c.query(text, params);
      await c.query('RELEASE SAVEPOINT s');
      return 'OK';
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      return (error as { code?: string }).code ?? 'NO_CODE';
    }
  }

  const post = (
    org: string,
    type: string,
    anchor: string,
    amount: number | null,
    account: string | null,
    message: string,
    attempt: string | null,
  ) =>
    admin(
      `SELECT * FROM app_ledger_post($1, $2::usage_ledger_entry_type, $3, $4, $5, $6, $7, 'c', NULL)`,
      [org, type, anchor, amount, account, message, attempt],
    );

  beforeAll(async () => {
    db = connect();
    A = await createTenant(db.admin, 'p76a-a');
    B = await createTenant(db.admin, 'p76a-b');
    channelId = (await admin(`SELECT id FROM channels WHERE code = 'whatsapp'`)).rows[0].id;
    providerId = (
      await admin(
        `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
        [channelId, `p76a-${uuidv7().slice(-8)}`],
      )
    ).rows[0].id;
    // A: prepaid wallet; B: postpaid credit account. Each gets one settled message:
    // reservation 50, provider cost 20, charge 50 (no release: fully charged).
    await admin(`INSERT INTO wallets (org_id, balance_paise) VALUES ($1, 1000)`, [A.orgId]);
    await admin(`INSERT INTO credit_accounts (org_id, credit_limit_paise) VALUES ($1, 500)`, [
      B.orgId,
    ]);
    for (const [t, account] of [
      [A, 'wallet'],
      [B, 'credit'],
    ] as const) {
      await admin(
        `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority) VALUES ($1, $2, $3, 1)`,
        [t.orgId, providerId, channelId],
      );
      const contact = uuidv7();
      await admin(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
        contact,
        t.orgId,
        t.workspaceId,
      ]);
      const message = uuidv7();
      messages[t.orgId] = message;
      await admin(
        `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id)
         VALUES ($1, $2, $3, $4, $5, 'accepted', '+12025550166', 'c')`,
        [message, t.orgId, t.workspaceId, contact, channelId],
      );
      const attempt = uuidv7();
      attempts[t.orgId] = attempt;
      await admin(
        `INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number, fencing_epoch, claim_token, status)
         VALUES ($1, $2, $3, $4, $5, 1, 1, $6, 'accepted')`,
        [attempt, message, t.orgId, providerId, channelId, uuidv7()],
      );
      await post(t.orgId, 'reservation', message, 50, account, message, null);
      await post(t.orgId, 'provider_cost', attempt, 20, null, message, attempt);
      await post(t.orgId, 'customer_charge', message, 50, account, message, null);
    }
  }, 120_000);

  afterAll(async () => {
    const orgIds = [A?.orgId, B?.orgId].filter(Boolean) as string[];
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      for (const table of [
        'usage_ledger',
        'wallets',
        'credit_accounts',
        'message_attempts',
        'messages',
        'contacts',
        'organization_provider_assignments',
      ]) {
        await c.query(`DELETE FROM ${table} WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      }
      if (providerId) await c.query(`DELETE FROM providers WHERE id = $1`, [providerId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    if (A) await destroyTenant(db.admin, A);
    if (B) await destroyTenant(db.admin, B);
    await db.close();
  }, 120_000);

  it('a tenant sees its own accounts and tenant-visible ledger entries', async () => {
    await asTenant(ctx(A), async (c) => {
      expect((await c.query(`SELECT org_id, balance_paise::int AS b FROM wallets`)).rows).toEqual([
        { org_id: A.orgId, b: 950 },
      ]);
      expect((await c.query(`SELECT count(*)::int AS n FROM credit_accounts`)).rows[0].n).toBe(0);
      const ledger = await c.query(
        `SELECT entry_type::text AS t, amount_paise::int AS a FROM usage_ledger ORDER BY id`,
      );
      expect(ledger.rows).toEqual([
        { t: 'reservation', a: 50 },
        { t: 'customer_charge', a: 50 },
      ]);
    });
    await asTenant(ctx(B), async (c) => {
      expect(
        (await c.query(`SELECT org_id, used_paise::int AS u FROM credit_accounts`)).rows,
      ).toEqual([{ org_id: B.orgId, u: 50 }]);
      expect((await c.query(`SELECT count(*)::int AS n FROM wallets`)).rows[0].n).toBe(0);
    });
  });

  it("another organization's rows are invisible, even when asked for by id", async () => {
    await asTenant(ctx(A), async (c) => {
      for (const [table, column] of [
        ['wallets', 'org_id'],
        ['credit_accounts', 'org_id'],
        ['usage_ledger', 'org_id'],
      ]) {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
          [B.orgId],
        );
        expect([table, rows[0].n]).toEqual([table, 0]);
      }
      const byMessage = await c.query(
        `SELECT count(*)::int AS n FROM usage_ledger WHERE message_id = $1`,
        [messages[B.orgId]],
      );
      expect(byMessage.rows[0].n).toBe(0);
    });
  });

  it('provider cost is invisible to a tenant at the database layer, even its own', async () => {
    const { rows } = await admin(
      `SELECT count(*)::int AS n FROM usage_ledger WHERE org_id = $1 AND entry_type = 'provider_cost'`,
      [A.orgId],
    );
    expect(rows[0].n).toBe(1); // it exists
    await asTenant(ctx(A), async (c) => {
      expect(
        (
          await c.query(
            `SELECT count(*)::int AS n FROM usage_ledger WHERE entry_type = 'provider_cost'`,
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await c.query(
            `SELECT count(*)::int AS n FROM usage_ledger WHERE message_attempt_id = $1`,
            [attempts[A.orgId]],
          )
        ).rows[0].n,
      ).toBe(0);
    });
  });

  it('without a valid tenant content context nothing is visible', async () => {
    for (const context of [null, { org: A.orgId }]) {
      await asTenant(context, async (c) => {
        for (const table of ['wallets', 'credit_accounts', 'usage_ledger']) {
          const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
          expect([table, rows[0].n]).toEqual([table, 0]);
        }
      });
    }
  });

  it('a tenant cannot write: every INSERT, UPDATE, DELETE and TRUNCATE is refused, and partitions are unreachable', async () => {
    const month = (await admin(`SELECT to_char(now(), 'YYYYMM') AS m`)).rows[0].m as string;
    await asTenant(ctx(A), async (c) => {
      for (const statement of [
        `INSERT INTO wallets (org_id, balance_paise) VALUES ('${A.orgId}', 1)`,
        `UPDATE wallets SET balance_paise = balance_paise + 1000000`,
        `DELETE FROM wallets`,
        `TRUNCATE wallets`,
        `INSERT INTO credit_accounts (org_id, credit_limit_paise) VALUES ('${A.orgId}', 1)`,
        `UPDATE credit_accounts SET credit_limit_paise = 1000000`,
        `DELETE FROM credit_accounts`,
        `UPDATE usage_ledger SET amount_paise = 1`,
        `DELETE FROM usage_ledger`,
        `TRUNCATE usage_ledger`,
        `INSERT INTO usage_ledger (anchor_month, anchor_id, fact_kind, entry_type, org_id, amount_paise) VALUES (current_date, gen_random_uuid(), 'refund', 'refund', '${A.orgId}', 1)`,
        `SELECT count(*) FROM usage_ledger_p${month}`,
      ]) {
        expect([statement.split(' ').slice(0, 3).join(' '), await code(c, statement)]).toEqual([
          statement.split(' ').slice(0, 3).join(' '),
          '42501',
        ]);
      }
    });
    expect(
      (await admin(`SELECT balance_paise::int AS b FROM wallets WHERE org_id = $1`, [A.orgId]))
        .rows[0].b,
    ).toBe(950);
  });

  it('the policies are exactly three tenant SELECT policies for acc_app', async () => {
    const { rows } = await admin(
      `SELECT tablename, policyname, cmd, roles::text AS roles FROM pg_policies
        WHERE tablename IN ('wallets', 'credit_accounts', 'usage_ledger') ORDER BY tablename`,
    );
    expect(rows).toEqual([
      {
        tablename: 'credit_accounts',
        policyname: 'credit_accounts_tenant_select',
        cmd: 'SELECT',
        roles: '{acc_app}',
      },
      {
        tablename: 'usage_ledger',
        policyname: 'usage_ledger_tenant_select',
        cmd: 'SELECT',
        roles: '{acc_app}',
      },
      {
        tablename: 'wallets',
        policyname: 'wallets_tenant_select',
        cmd: 'SELECT',
        roles: '{acc_app}',
      },
    ]);
  });

  it('every ledger partition still reports its privileges restricted, with RLS and guards', async () => {
    const { rows } = await admin(
      `SELECT bool_and(privileges_restricted) AS p, bool_and(rls_enabled) AS r,
              bool_and(truncate_guarded) AS t, bool_and(row_guarded) AS g, count(*)::int AS n
         FROM app_ledger_partition_report()`,
    );
    expect(rows[0]).toEqual({ p: true, r: true, t: true, g: true, n: expect.any(Number) });
    expect(rows[0].n).toBeGreaterThanOrEqual(25);
  });
});
