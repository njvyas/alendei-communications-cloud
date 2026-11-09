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
 * Phase 7 PR 7-6d-2 — wallet recharge and ledger integration (migration `0060`;
 * DECISIONS.md §1zi.13 D-76d-1 to D-76d-5). The database half:
 *
 *   1. Privileges: the three new entry functions for acc_app only; every earlier billing
 *      function keeps exactly its grants and owner.
 *   2. Structure: the ledger writer, the 7-6d-1 executor and the generic approval differ
 *      from their previous definitions only by the marked 7-6d-2 blocks; only the executor
 *      posts a recharge.
 *   3. The writer's recharge branch: only for an executing recharge operation of that
 *      organization and amount; wallet only, no message, correlation or note; frozen
 *      wallet refused; balance up, reserved unchanged; idempotent on the operation id.
 *   4. The table: the recharge dual-control CHECK, evidence, the executed-result rule, the
 *      normalised payment-reference uniqueness (pending and executed only), immutability.
 *   5. The tenant ledger policy admits recharge; callers without billing.manage: 42501.
 */
const MIGRATIONS = resolve(__dirname, '../../migrations');
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');
const M0057 = read('0057_phase7_6c_operator_resolution.sql');
const M0059 = read('0059_phase7_6d1_account_provisioning.sql');
const M0060 = read('0060_phase7_6d2_wallet_recharge.sql');
const APP_ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch', 'acc_delivery'] as const;
const WRITER =
  'app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text, text)';

const FUNCTIONS: Record<string, string[]> = {
  // New in 0060.
  'app_billing_account_request_recharge(uuid, bigint, text, date, text, bigint, text)': ['acc_app'],
  'app_billing_account_approve_recharge(uuid, bigint, text, date)': ['acc_app'],
  'app_billing_account_note_refusal(uuid)': ['acc_app'],
  // Earlier, unchanged grants (privilege regression).
  [WRITER]: [],
  'app_rate_message(uuid, uuid, uuid, integer, boolean, boolean)': [],
  'app_message_reserve(uuid)': ['acc_app'],
  'app_dispatch_attempt_reserve(uuid, integer)': ['acc_dispatch'],
  'app_dispatch_attempt_settle(uuid, boolean)': ['acc_dispatch'],
  'app_dispatch_message_settle()': ['acc_dispatch'],
  'app_billing_unknown_register(uuid, text, text, text, integer, timestamp with time zone, uuid, integer)':
    ['acc_app'],
  'app_billing_unknown_open_counts()': ['acc_app'],
  'app_billing_resolution_request(uuid, text, text, bigint, text)': ['acc_app'],
  'app_billing_resolution_approve(uuid, bigint)': ['acc_app'],
  'app_billing_resolution_reject(uuid, text)': ['acc_app'],
  'app_billing_resolution_note_refusal(uuid)': ['acc_app'],
  'app_billing_resolutions_list(uuid, text, uuid, uuid, uuid, integer)': ['acc_app'],
  'app_billing_resolve_unknown(uuid)': [],
  'app_billing_account_request(uuid, text, text, bigint, bigint, text, bigint, text)': ['acc_app'],
  'app_billing_account_approve(uuid, bigint)': ['acc_app'],
  'app_billing_account_reject(uuid, text)': ['acc_app'],
  'app_billing_accounts_get(uuid)': ['acc_app'],
  'app_billing_account_operations_list(uuid, uuid, text, text, text, uuid, integer)': ['acc_app'],
  'app_billing_account_execute(uuid)': [],
};

/** The body (between `AS $$` and `$$;`) of `CREATE … FUNCTION <name>(` in a migration. */
function body(migration: string, name: string): string {
  const start = migration.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION ${name}\\(`));
  expect(start).toBeGreaterThanOrEqual(0);
  const open = migration.indexOf('AS $$', start) + 'AS $$'.length;
  return migration.slice(open, migration.indexOf('$$;', open));
}

/** Removes the marked 7-6d-2 insertions (`-- >>> Phase 7 PR 7-6d-2` … `-- <<< Phase 7 PR 7-6d-2`). */
const withoutRechargeBlocks = (src: string) =>
  src.replace(/[ \t]*-- >>> Phase 7 PR 7-6d-2[\s\S]*?-- <<< Phase 7 PR 7-6d-2\n(\n)?/g, '');

describe('Phase 7 PR 7-6d-2 — wallet recharge (migration 0060)', () => {
  let db: Principals;
  let A: TenantFixture;
  let B: TenantFixture;
  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  beforeAll(async () => {
    db = connect();
    A = await createTenant(db.admin, 'p76d2-db-a');
    B = await createTenant(db.admin, 'p76d2-db-b');
  }, 60_000);
  afterAll(async () => {
    if (A) await destroyTenant(db.admin, A);
    if (B) await destroyTenant(db.admin, B);
    await db.close();
  });

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

  async function owner<R>(user: string, work: (c: PoolClient) => Promise<R>): Promise<R> {
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [user]);
      return await work(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  /** A pending recharge operation inserted directly (as the request function would). */
  async function pendingRecharge(
    c: PoolClient,
    amount: number,
    o: { ref?: string; dual?: boolean; threshold?: number | null } = {},
  ): Promise<string> {
    const { rows } = await c.query(
      `INSERT INTO billing_account_operations (org_id, account, kind, amount_paise, dual_control, threshold_paise,
         reason, request_key, requested_by, payment_reference, received_on)
       VALUES ($1, 'wallet', 'recharge', $2, $3, $4, 'r', $5, $6, $7, current_date) RETURNING id`,
      [
        A.orgId,
        amount,
        o.dual ?? true,
        o.threshold ?? null,
        `k-${uuidv7()}`,
        A.userId,
        o.ref ?? `UTR${uuidv7().slice(-8)}`,
      ],
    );
    return rows[0].id as string;
  }

  const post = (
    anchor: string,
    amount: number,
    extra = 'NULL, NULL, NULL, NULL',
    account = 'wallet',
  ) =>
    `SELECT * FROM app_ledger_post('${A.orgId}', 'recharge', '${anchor}', ${amount}, '${account}', ${extra})`;

  // --- 1. privileges -------------------------------------------------------------------------

  it('privileges: the new entry points for acc_app only; every earlier billing function keeps its grants; same owner, definer settings', async () => {
    const result: Record<string, string[]> = {};
    for (const fn of Object.keys(FUNCTIONS)) {
      const { rows } = await admin(
        `SELECT r AS role FROM unnest($2::text[]) AS r WHERE has_function_privilege(r, $1, 'EXECUTE')`,
        [fn, APP_ROLES],
      );
      const pub = await admin(
        `SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = $1::regprocedure AND a.grantee = 0`,
        [fn],
      );
      result[fn] = [...rows.map((r) => r.role as string), ...(pub.rows.length ? ['PUBLIC'] : [])];
      const def = await admin(
        `SELECT prosecdef, proconfig, proowner = (SELECT proowner FROM pg_proc WHERE oid = $2::regprocedure) AS same_owner
           FROM pg_proc WHERE oid = $1::regprocedure`,
        [fn, WRITER],
      );
      expect([fn, def.rows[0]]).toEqual([
        fn,
        { prosecdef: true, proconfig: ['search_path=public, pg_temp'], same_owner: true },
      ]);
    }
    expect(result).toEqual(FUNCTIONS);
  });

  it('0060 grants EXECUTE on the three new entry points only, and touches no table privilege', () => {
    const sqlText = M0060.replace(/--[^\n]*/g, '');
    expect(sqlText).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
    expect(
      [...sqlText.matchAll(/\bGRANT\b[^;]*;/gi)].map((x) => x[0].replace(/\s+/g, ' ')),
    ).toEqual([
      'GRANT EXECUTE ON FUNCTION app_billing_account_request_recharge(uuid, bigint, text, date, text, bigint, text) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_account_approve_recharge(uuid, bigint, text, date) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_account_note_refusal(uuid) TO acc_app;',
    ]);
  });

  // --- 2. structure ----------------------------------------------------------------------------

  it('the writer, the executor and the generic approval differ from their previous definitions only by the marked recharge blocks', async () => {
    const live = async (fn: string) =>
      (await admin(`SELECT prosrc FROM pg_proc WHERE oid = $1::regprocedure`, [fn])).rows[0]
        .prosrc as string;
    const writer = withoutRechargeBlocks(await live(WRITER)).replace(
      `'provider_cost', 'recharge')`,
      `'provider_cost')`,
    );
    expect(writer).toBe(body(M0057, 'app_ledger_post'));
    expect(withoutRechargeBlocks(await live('app_billing_account_execute(uuid)'))).toBe(
      body(M0059, 'app_billing_account_execute'),
    );
    expect(withoutRechargeBlocks(await live('app_billing_account_approve(uuid, bigint)'))).toBe(
      body(M0059, 'app_billing_account_approve'),
    );
  });

  it('only the account executor posts a recharge', async () => {
    const { rows } = await admin(
      `SELECT p.proname FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ 'app_ledger_post\\([^;]*''recharge'''
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['app_billing_account_execute']);
  });

  it('the tenant ledger policy admits recharge in addition to the 0055 types, and still never provider_cost', async () => {
    const { rows } = await admin(
      `SELECT qual FROM pg_policies WHERE tablename = 'usage_ledger' AND policyname = 'usage_ledger_tenant_select'`,
    );
    const qual = rows[0].qual as string;
    for (const t of ['reservation', 'reservation_release', 'customer_charge', 'recharge']) {
      expect(qual).toContain(`'${t}'`);
    }
    expect(qual).not.toContain('provider_cost');
    expect(qual).toContain('app_current_org_id()');
  });

  // --- 3. the writer's recharge branch -------------------------------------------------------

  it('posts one immutable wallet fact for an executing recharge: balance up, reserved unchanged, nothing internal on the row; idempotent', async () => {
    await owner(A.userId, async (c) => {
      await c.query(
        `INSERT INTO wallets (org_id, balance_paise, reserved_paise) VALUES ($1, 500, 120)`,
        [A.orgId],
      );
      const op = await pendingRecharge(c, 1000, { dual: false, threshold: 5000 });
      const first = await c.query(post(op, 1000));
      expect(first.rows[0]).toMatchObject({ inserted: true, amount_paise: '1000' });
      const again = await c.query(post(op, 1000));
      expect(again.rows[0]).toMatchObject({ inserted: false, amount_paise: '1000' });
      expect(
        (
          await c.query(`SELECT balance_paise, reserved_paise FROM wallets WHERE org_id = $1`, [
            A.orgId,
          ])
        ).rows[0],
      ).toEqual({ balance_paise: '1500', reserved_paise: '120' });
      const fact = (
        await c.query(
          `SELECT entry_type, message_id, message_attempt_id, correlation_id, reference_note, credit_account_id,
                  wallet_id IS NOT NULL AS has_wallet, anchor_id
             FROM usage_ledger WHERE org_id = $1`,
          [A.orgId],
        )
      ).rows;
      expect(fact).toEqual([
        {
          entry_type: 'recharge',
          message_id: null,
          message_attempt_id: null,
          correlation_id: null,
          reference_note: null,
          credit_account_id: null,
          has_wallet: true,
          anchor_id: op,
        },
      ]);
      // Immutable like every ledger row.
      expect(
        await code(c, `UPDATE usage_ledger SET amount_paise = 1 WHERE org_id = $1`, [A.orgId]),
      ).toBe('42501');
      expect(await code(c, `DELETE FROM usage_ledger WHERE org_id = $1`, [A.orgId])).toBe('42501');
    });
  });

  it('refuses a recharge without an executing operation, for another amount, unapproved under dual control, with a message, correlation or note, on a credit account, or on a frozen wallet', async () => {
    await owner(A.userId, async (c) => {
      await c.query(`INSERT INTO wallets (org_id, balance_paise) VALUES ($1, 0)`, [A.orgId]);
      expect(await code(c, post(uuidv7(), 100))).toBe('22023');
      const dual = await pendingRecharge(c, 100, { dual: true });
      expect(await code(c, post(dual, 100))).toBe('22023'); // not approved
      await c.query(
        `UPDATE billing_account_operations SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = 'x' WHERE id = $1`,
        [dual, B.userId],
      );
      const single = await pendingRecharge(c, 100, { dual: false, threshold: 100 });
      expect(await code(c, post(single, 99))).toBe('22023');
      expect(await code(c, post(single, 100, `'${uuidv7()}', NULL, NULL, NULL`))).toBe('22023');
      expect(await code(c, post(single, 100, `NULL, NULL, 'corr', NULL`))).toBe('22023');
      expect(await code(c, post(single, 100, `NULL, NULL, NULL, 'note'`))).toBe('22023');
      expect(await code(c, post(single, 100, 'NULL, NULL, NULL, NULL', 'credit'))).toBe('22023');
      // The operator-resolution mode never posts a recharge.
      expect(
        await code(c, post(single, 100, `NULL, NULL, NULL, NULL, 'operator_resolution'`)),
      ).toBe('22023');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE wallets SET status = 'frozen' WHERE org_id = $1`, [A.orgId]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      expect(await code(c, post(single, 100))).toBe('BL002');
      expect(
        (await c.query(`SELECT count(*)::int AS n FROM usage_ledger WHERE org_id = $1`, [A.orgId]))
          .rows[0].n,
      ).toBe(0);
    });
  });

  // --- 4. the table --------------------------------------------------------------------------

  it('CHECKs: recharge dual control, evidence presence and format, wallet only, executed result', async () => {
    await owner(A.userId, async (c) => {
      const insert = (vals: {
        amount?: number;
        dual: boolean;
        threshold?: number | null;
        ref?: string | null;
        on?: string | null;
        account?: string;
      }) =>
        code(
          c,
          `INSERT INTO billing_account_operations (org_id, account, kind, amount_paise, dual_control, threshold_paise,
             reason, request_key, requested_by, payment_reference, received_on)
           VALUES ($1, $2, 'recharge', $3, $4, $5, 'r', $6, $7, $8, $9::date)`,
          [
            A.orgId,
            vals.account ?? 'wallet',
            vals.amount ?? 100,
            vals.dual,
            vals.threshold ?? null,
            `k-${uuidv7()}`,
            A.userId,
            vals.ref === undefined ? `R${uuidv7().slice(-8)}` : vals.ref,
            vals.on === undefined ? '2026-11-01' : vals.on,
          ],
        );
      expect(await insert({ dual: false })).toBe('23514'); // no threshold
      expect(await insert({ dual: false, threshold: 99 })).toBe('23514'); // above it
      expect(await insert({ dual: false, threshold: 100, ref: 'R-EXACT' })).toBe('OK'); // at it
      expect(await insert({ dual: true, ref: null })).toBe('23514');
      expect(await insert({ dual: true, ref: '-starts-with-dash' })).toBe('23514');
      expect(await insert({ dual: true, ref: 'bad;char' })).toBe('23514');
      expect(await insert({ dual: true, on: null })).toBe('23514');
      expect(await insert({ dual: true, account: 'credit_account' })).toBe('23514');
      expect(await insert({ dual: true, amount: 0 })).toBe('23514');
      // Evidence columns only on a recharge.
      expect(
        await code(
          c,
          `INSERT INTO billing_account_operations (org_id, account, kind, dual_control, reason, request_key, requested_by, payment_reference)
           VALUES ($1, 'wallet', 'freeze', false, 'r', $2, $3, 'X1')`,
          [A.orgId, `k-${uuidv7()}`, A.userId],
        ),
      ).toBe('23514');
      // Executed without its ledger row.
      expect(
        await code(
          c,
          `INSERT INTO billing_account_operations (org_id, account, kind, amount_paise, dual_control, threshold_paise, reason,
             request_key, requested_by, payment_reference, received_on, status, executed_at)
           VALUES ($1, 'wallet', 'recharge', 10, false, 100, 'r', $2, $3, 'R-NORESULT', current_date, 'executed', now())`,
          [A.orgId, `k-${uuidv7()}`, A.userId],
        ),
      ).toBe('23514');
    });
  });

  it('a payment reference is unique per organization after normalisation, among pending and executed recharges only; the evidence is immutable', async () => {
    await owner(A.userId, async (c) => {
      const first = await pendingRecharge(c, 100, { ref: 'utr 1234 ab' });
      // Same reference, other whitespace and case: refused while pending.
      expect(
        await code(
          c,
          `INSERT INTO billing_account_operations (org_id, account, kind, amount_paise, dual_control, reason, request_key,
             requested_by, payment_reference, received_on)
           VALUES ($1, 'wallet', 'recharge', 50, true, 'r', $2, $3, 'UTR1234AB', current_date)`,
          [A.orgId, `k-${uuidv7()}`, A.userId],
        ),
      ).toBe('23505');
      expect(
        (
          await c.query(
            `SELECT payment_reference_normalized AS n FROM billing_account_operations WHERE id = $1`,
            [first],
          )
        ).rows[0].n,
      ).toBe('UTR1234AB');
      // Immutable evidence.
      expect(
        await code(
          c,
          `UPDATE billing_account_operations SET payment_reference = 'OTHER' WHERE id = $1`,
          [first],
        ),
      ).toBe('42501');
      expect(
        await code(
          c,
          `UPDATE billing_account_operations SET received_on = current_date - 1 WHERE id = $1`,
          [first],
        ),
      ).toBe('42501');
      // Rejected: the reference is free again; another organization may use it any time.
      await c.query(
        `UPDATE billing_account_operations SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = 'no' WHERE id = $1`,
        [first, B.userId],
      );
      expect(await pendingRecharge(c, 50, { ref: 'UTR1234AB' })).toEqual(expect.any(String));
      expect(
        await code(
          c,
          `INSERT INTO billing_account_operations (org_id, account, kind, amount_paise, dual_control, reason, request_key,
             requested_by, payment_reference, received_on)
           VALUES ($1, 'wallet', 'recharge', 50, true, 'r', $2, $3, 'utr1234ab', current_date)`,
          [B.orgId, `k-${uuidv7()}`, B.userId],
        ),
      ).toBe('OK');
    });
  });

  // --- 5. callers ------------------------------------------------------------------------------

  it('every new entry function refuses (42501) a caller without a user or without platform billing.manage', async () => {
    const calls = [
      `SELECT * FROM app_billing_account_request_recharge('${A.orgId}', 100, 'R1', current_date, 'r', NULL, 'k')`,
      `SELECT app_billing_account_approve_recharge('${uuidv7()}', 100, 'R1', current_date)`,
      `SELECT app_billing_account_note_refusal('${uuidv7()}')`,
    ];
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      for (const call of calls) {
        expect([call.slice(0, 48), await code(c, call)]).toEqual([call.slice(0, 48), '42501']);
      }
      await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [A.orgId]);
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [A.userId]);
      for (const call of calls) {
        expect([call.slice(0, 48), await code(c, call)]).toEqual([call.slice(0, 48), '42501']);
      }
      expect(await code(c, post(uuidv7(), 1))).toBe('42501');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
