import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
 * Phase 7 PR 7-6b — the unknown-outcome register (migration `0056`;
 * DECISIONS.md §1zi.9 D-76-5). The database half: the two read functions are
 * executable by acc_app only and refuse (42501) any caller that is not a
 * signed-in user holding billing.manage at platform scope; 0056 adds no policy
 * or privilege on any financial table. Behaviour is exercised over HTTP in
 * `apps/api/test/phase7_6b-unknown-register.int-spec.ts`.
 */
const MIGRATION = readFileSync(
  join(resolve(__dirname, '../..'), 'migrations/0056_phase7_6b_unknown_outcome_register.sql'),
  'utf8',
);
const APP_ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch', 'acc_delivery'] as const;
const FUNCTIONS = [
  'app_billing_unknown_register(uuid, text, text, text, integer, timestamp with time zone, uuid, integer)',
  'app_billing_unknown_open_counts()',
];

describe('Phase 7 PR 7-6b — the unknown-outcome register (migration 0056)', () => {
  let db: Principals;
  let A: TenantFixture;
  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  beforeAll(async () => {
    db = connect();
    A = await createTenant(db.admin, 'p76b-db');
  }, 60_000);
  afterAll(async () => {
    if (A) await destroyTenant(db.admin, A);
    await db.close();
  });

  async function code(c: PoolClient, text: string): Promise<string> {
    await c.query('SAVEPOINT s');
    try {
      await c.query(text);
      await c.query('RELEASE SAVEPOINT s');
      return 'OK';
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      return (error as { code?: string }).code ?? 'NO_CODE';
    }
  }

  it('both functions: executable by acc_app only, never PUBLIC; SECURITY DEFINER with a pinned search_path', async () => {
    for (const fn of FUNCTIONS) {
      const { rows } = await admin(
        `SELECT r AS role FROM unnest($2::text[]) AS r WHERE has_function_privilege(r, $1, 'EXECUTE')`,
        [fn, APP_ROLES],
      );
      expect([fn, rows.map((r) => r.role)]).toEqual([fn, ['acc_app']]);
      const pub = await admin(
        `SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0`,
        [fn],
      );
      expect([fn, pub.rows]).toEqual([fn, []]);
      const def = await admin(
        `SELECT prosecdef, proconfig, provolatile FROM pg_proc WHERE oid = $1::regprocedure`,
        [fn],
      );
      expect([fn, def.rows[0]]).toEqual([
        fn,
        { prosecdef: true, proconfig: ['search_path=public, pg_temp'], provolatile: 's' },
      ]);
    }
  });

  it('0056 adds no policy, no table privilege and no write; only the two function grants', () => {
    const sqlText = MIGRATION.replace(/--[^\n]*/g, '');
    expect(sqlText).not.toMatch(
      /CREATE\s+POLICY|ALTER\s+TABLE|CREATE\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i,
    );
    expect(
      [...sqlText.matchAll(/\bGRANT\b[^;]*;/gi)].map((x) => x[0].replace(/\s+/g, ' ')),
    ).toEqual([
      'GRANT EXECUTE ON FUNCTION app_billing_unknown_register(uuid, text, text, text, integer, timestamptz, uuid, integer) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_unknown_open_counts() TO acc_app;',
    ]);
  });

  it('the financial tables keep exactly the 7-6a tenant policies', async () => {
    const { rows } = await admin(
      `SELECT policyname FROM pg_policies WHERE tablename IN ('wallets', 'credit_accounts', 'usage_ledger') ORDER BY 1`,
    );
    expect(rows.map((r) => r.policyname)).toEqual([
      'credit_accounts_tenant_select',
      'usage_ledger_tenant_select',
      'wallets_tenant_select',
    ]);
  });

  // --- PR #97 review: the open-items count names the ledger fact's partition key ----------

  /**
   * Plants, in `c` (an owner transaction the caller rolls back), enforced outcome_unknown
   * WhatsApp messages of organization A under both policies, with the given charges.
   */
  async function plantItems(c: PoolClient) {
    const channel = (await c.query(`SELECT id FROM channels WHERE code = 'whatsapp'`)).rows[0].id;
    const provider = (
      await c.query(
        `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
        [channel, `p76b-db-${uuidv7().slice(-8)}`],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority) VALUES ($1, $2, $3, 1)`,
      [A.orgId, provider, channel],
    );
    await c.query(`INSERT INTO wallets (org_id, balance_paise) VALUES ($1, 100000)`, [A.orgId]);
    const contact = uuidv7();
    await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
      contact,
      A.orgId,
      A.workspaceId,
    ]);
    const plant = async (policy: string, withAttempt = true) => {
      const id = uuidv7();
      await c.query(
        `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id,
                               completed_at, billable_units, billable_unit, billing_enforced, billing_mode_snapshot, billing_policy_snapshot)
         VALUES ($1, $2, $3, $4, $5, 'outcome_unknown', '+12025550133', 'c', now(), 1, 'message', true, 'prepaid', $6::billing_policy)`,
        [id, A.orgId, A.workspaceId, contact, channel, policy],
      );
      let attempt: string | null = null;
      if (withAttempt) {
        attempt = uuidv7();
        await c.query(
          `INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number, fencing_epoch, claim_token, status)
           VALUES ($1, $2, $3, $4, $5, 1, 1, $6, 'outcome_unknown')`,
          [attempt, id, A.orgId, provider, channel, uuidv7()],
        );
      }
      return { id, attempt };
    };
    /** Reserve 50 on the message, then charge 50 on `anchor` (the message or its attempt). */
    const charge = async (
      msg: { id: string; attempt: string | null },
      on: 'message' | 'attempt',
    ) => {
      await c.query(
        `SELECT * FROM app_ledger_post($1, 'reservation', $2, 50, 'wallet', $2, NULL, 'c', NULL)`,
        [A.orgId, msg.id],
      );
      const anchor = on === 'message' ? msg.id : msg.attempt;
      await c.query(
        `SELECT * FROM app_ledger_post($1, 'customer_charge', $2, 50, 'wallet', $3, $4, 'c', NULL)`,
        [A.orgId, anchor, msg.id, on === 'message' ? null : msg.attempt],
      );
    };
    const LOGICAL = 'charge_per_logical_message';
    const ATTEMPT = 'charge_per_attempt';
    const p1 = await plant(LOGICAL); // open
    const p2 = await plant(LOGICAL); // charged on its automatic anchor (the message)
    await charge(p2, 'message');
    const p3 = await plant(LOGICAL); // a charge on the attempt is not its anchor: open
    await charge(p3, 'attempt');
    const q1 = await plant(ATTEMPT); // open
    const q2 = await plant(ATTEMPT); // charged on its automatic anchor (the unknown attempt)
    await charge(q2, 'attempt');
    const q3 = await plant(ATTEMPT); // a charge on the message is not its anchor: open
    await charge(q3, 'message');
    const q4 = await plant(ATTEMPT, false); // no attempt, no anchor: open
    return { open: [p1, p3, q1, q3, q4], charged: [p2, q2] };
  }

  async function asPlatform<R>(work: (c: PoolClient) => Promise<R>): Promise<R> {
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [A.userId]);
      return await work(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  const whatsappOpen = async (c: PoolClient) =>
    Number(
      (
        await c.query(
          `SELECT open_items FROM app_billing_unknown_open_counts() WHERE channel_code = 'whatsapp'`,
        )
      ).rows[0]?.open_items ?? 0,
    );

  it('open counts: under both policies, only a charge on the automatic anchor closes an item', async () => {
    await asPlatform(async (c) => {
      const before = await whatsappOpen(c);
      const items = await plantItems(c);
      expect(await whatsappOpen(c)).toBe(before + items.open.length);
      expect(items.open).toHaveLength(5);
    });
  });

  it('open counts: the ledger lookup carries the partition key and is pruned to one monthly partition', async () => {
    const src = (
      await admin(
        `SELECT prosrc FROM pg_proc WHERE oid = 'app_billing_unknown_open_counts()'::regprocedure`,
      )
    ).rows[0].prosrc as string;
    expect(src).toMatch(/l\.anchor_month = app_uuidv7_month\(e\.expected_charge_anchor\)/);
    expect(src).toMatch(/l\.anchor_id = e\.expected_charge_anchor/);
    expect(src).toMatch(
      /CASE WHEN m\.billing_policy_snapshot = 'charge_per_attempt' THEN a\.id ELSE m\.id END/,
    );
    // The RETURN QUERY statement only, up to its own terminator — never past it (the
    // function's trailing `END;` would otherwise run as COMMIT).
    const start = src.indexOf('RETURN QUERY') + 'RETURN QUERY'.length;
    const query = src.slice(start, src.indexOf(';', start));
    expect(query).not.toMatch(/;|\bEND\b\s*$/);

    await asPlatform(async (c) => {
      await plantItems(c);
      const month = (await c.query(`SELECT to_char(now(), 'YYYYMM') AS m`)).rows[0].m as string;
      const plan = (await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`)).rows[0]['QUERY PLAN'];
      const partitions: Array<{ name: string; loops: number }> = [];
      let removed = 0;
      const walk = (node: Record<string, unknown>) => {
        const relation = node['Relation Name'];
        if (typeof relation === 'string' && /^usage_ledger_p\d{6}$/.test(relation)) {
          partitions.push({ name: relation, loops: Number(node['Actual Loops'] ?? 0) });
        }
        if (typeof node['Subplans Removed'] === 'number') removed += node['Subplans Removed'];
        for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
          walk(child);
      };
      walk(plan[0].Plan);
      const executed = [...new Set(partitions.filter((p) => p.loops > 0).map((p) => p.name))];
      // Only the anchors' own month is ever scanned; every other partition is pruned —
      // removed at initialisation or never executed — rather than probed.
      expect(executed).toEqual([`usage_ledger_p${month}`]);
      const pruned = removed + partitions.filter((p) => p.loops === 0).length;
      expect(pruned).toBeGreaterThanOrEqual(24);
    });
  });

  it('refuses (42501) a caller without a user, and a tenant user without platform billing.manage', async () => {
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      for (const call of [
        `SELECT * FROM app_billing_unknown_register(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)`,
        `SELECT * FROM app_billing_unknown_open_counts()`,
      ]) {
        expect([call.slice(14, 45), await code(c, call)]).toEqual([call.slice(14, 45), '42501']);
      }
      await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [A.orgId]);
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [A.userId]);
      for (const call of [
        `SELECT * FROM app_billing_unknown_register(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)`,
        `SELECT * FROM app_billing_unknown_open_counts()`,
      ]) {
        expect([call.slice(14, 45), await code(c, call)]).toEqual([call.slice(14, 45), '42501']);
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
