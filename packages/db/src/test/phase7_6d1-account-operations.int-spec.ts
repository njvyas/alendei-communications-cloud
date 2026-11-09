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
 * Phase 7 PR 7-6d-1 — billing-account provisioning, credit limits, freeze and unfreeze
 * (migration `0059`; DECISIONS.md §1zi.13 D-76d-1, D-76d-4). The database half:
 *
 *   1. Privileges: the five entry functions for acc_app only, the executor for no
 *      application role, never PUBLIC; every earlier billing function keeps its grants;
 *      the ledger writer is untouched by 0059.
 *   2. billing_account_operations: the D-76d-1 dual-control CHECK, four eyes, per-kind
 *      amounts, one pending per (organisation, account, kind), the transition guard and
 *      append-only; RLS on, no policy, no grant.
 *   3. Execution: provisioning once; a credit-limit change bound to the previous limit and
 *      never touching status; a freeze changing status only, after which the existing
 *      writer refuses new reservations while settlement of existing ones proceeds.
 *   4. Callers: 42501 without a user or without platform billing.manage.
 *
 * Behaviour over HTTP (dual control, idempotency, concurrency, access) is exercised in
 * `apps/api/test/phase7_6d1-account-operations.int-spec.ts`.
 */
const MIGRATION = readFileSync(
  join(resolve(__dirname, '../..'), 'migrations/0059_phase7_6d1_account_provisioning.sql'),
  'utf8',
);
const APP_ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch', 'acc_delivery'] as const;
const NEW_FUNCTIONS: Record<string, string[]> = {
  'app_billing_account_request(uuid, text, text, bigint, bigint, text, bigint, text)': ['acc_app'],
  'app_billing_account_approve(uuid, bigint)': ['acc_app'],
  'app_billing_account_reject(uuid, text)': ['acc_app'],
  'app_billing_accounts_get(uuid)': ['acc_app'],
  'app_billing_account_operations_list(uuid, uuid, text, text, text, uuid, integer)': ['acc_app'],
  'app_billing_account_execute(uuid)': [],
};
/** Privilege regression: every earlier billing function keeps exactly its grants. */
const EARLIER_FUNCTIONS: Record<string, string[]> = {
  'app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text, text)':
    [],
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
};

describe('Phase 7 PR 7-6d-1 — billing-account operations (migration 0059)', () => {
  let db: Principals;
  let A: TenantFixture;
  let B: TenantFixture;
  let channel: string;
  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  beforeAll(async () => {
    db = connect();
    A = await createTenant(db.admin, 'p76d1-db-a');
    B = await createTenant(db.admin, 'p76d1-db-b');
    channel = (await admin(`SELECT id FROM channels WHERE code = 'whatsapp'`)).rows[0].id;
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

  /** An owner transaction, always rolled back, acting as `user`. */
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

  const request = (
    c: PoolClient,
    org: string,
    account: string,
    kind: string,
    amounts: [number | null, number | null] = [null, null],
    threshold: number | null = null,
  ) =>
    c.query(`SELECT * FROM app_billing_account_request($1, $2, $3, $4, $5, 'r', $6, $7)`, [
      org,
      account,
      kind,
      amounts[0],
      amounts[1],
      threshold,
      `k-${uuidv7()}`,
    ]);

  /** An insert as the request function would make it, for the CHECK tests. */
  const insertOp = (
    c: PoolClient,
    cols: {
      kind: string;
      account?: string;
      amount?: number | null;
      previous?: number | null;
      dual: boolean;
      threshold?: number | null;
    },
  ) =>
    code(
      c,
      `INSERT INTO billing_account_operations (org_id, account, kind, amount_paise, previous_limit_paise,
         dual_control, threshold_paise, reason, request_key, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'r', $8, $9)`,
      [
        A.orgId,
        cols.account ?? 'credit_account',
        cols.kind,
        cols.amount ?? null,
        cols.previous ?? null,
        cols.dual,
        cols.threshold ?? null,
        `k-${uuidv7()}`,
        A.userId,
      ],
    );

  async function grantsOf(fn: string): Promise<string[]> {
    const { rows } = await admin(
      `SELECT r AS role FROM unnest($2::text[]) AS r WHERE has_function_privilege(r, $1, 'EXECUTE')`,
      [fn, APP_ROLES],
    );
    const pub = await admin(
      `SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = $1::regprocedure AND a.grantee = 0`,
      [fn],
    );
    return [...rows.map((r) => r.role as string), ...(pub.rows.length ? ['PUBLIC'] : [])];
  }

  // --- 1. privileges ---------------------------------------------------------------------------

  it('new functions: entry points for acc_app only, the executor for none; SECURITY DEFINER, pinned search_path, owned like the ledger writer', async () => {
    const result: Record<string, string[]> = {};
    for (const fn of Object.keys(NEW_FUNCTIONS)) {
      result[fn] = await grantsOf(fn);
      const def = await admin(
        `SELECT prosecdef, proconfig,
                proowner = (SELECT proowner FROM pg_proc WHERE oid = 'app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text, text)'::regprocedure) AS same_owner
           FROM pg_proc WHERE oid = $1::regprocedure`,
        [fn],
      );
      expect([fn, def.rows[0]]).toEqual([
        fn,
        { prosecdef: true, proconfig: ['search_path=public, pg_temp'], same_owner: true },
      ]);
    }
    expect(result).toEqual(NEW_FUNCTIONS);
  });

  it('privilege regression: every earlier billing function keeps exactly its grants', async () => {
    const result: Record<string, string[]> = {};
    for (const fn of Object.keys(EARLIER_FUNCTIONS)) result[fn] = await grantsOf(fn);
    expect(result).toEqual(EARLIER_FUNCTIONS);
  });

  it('0059 leaves the ledger, the writer and every policy alone; it grants EXECUTE on the five entry points only', () => {
    const sqlText = MIGRATION.replace(/--[^\n]*/g, '');
    expect(sqlText).not.toMatch(/app_ledger_post|usage_ledger|CREATE\s+POLICY|DROP\s+POLICY/i);
    expect(sqlText).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
    expect(
      [...sqlText.matchAll(/\bGRANT\b[^;]*;/gi)].map((x) => x[0].replace(/\s+/g, ' ')),
    ).toEqual([
      'GRANT EXECUTE ON FUNCTION app_billing_account_request(uuid, text, text, bigint, bigint, text, bigint, text) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_account_approve(uuid, bigint) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_account_reject(uuid, text) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_accounts_get(uuid) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_account_operations_list(uuid, uuid, text, text, text, uuid, integer) TO acc_app;',
    ]);
  });

  it('billing_account_operations: RLS on, no policy, no privilege for any application role; financial-table policies unchanged', async () => {
    expect(
      (
        await admin(
          `SELECT relrowsecurity FROM pg_class WHERE oid = 'billing_account_operations'::regclass`,
        )
      ).rows[0].relrowsecurity,
    ).toBe(true);
    expect(
      (await admin(`SELECT 1 FROM pg_policies WHERE tablename = 'billing_account_operations'`))
        .rows,
    ).toEqual([]);
    const granted = await admin(
      `SELECT r || ':' || p AS g FROM unnest($1::text[]) r,
              unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        WHERE has_table_privilege(r, 'billing_account_operations', p)`,
      [APP_ROLES],
    );
    expect(granted.rows).toEqual([]);
    const { rows } = await admin(
      `SELECT policyname FROM pg_policies WHERE tablename IN ('wallets', 'credit_accounts', 'usage_ledger') ORDER BY 1`,
    );
    expect(rows.map((r) => r.policyname)).toEqual([
      'credit_accounts_tenant_select',
      'usage_ledger_tenant_select',
      'wallets_tenant_select',
    ]);
  });

  // --- 2. the table ------------------------------------------------------------------------------

  it('D-76d-1 CHECK: unfreeze always dual; an increase above (or without) the threshold dual, measured on the increase; decrease, freeze and provision single', async () => {
    await owner(A.userId, async (c) => {
      // Unfreeze without dual control.
      expect(await insertOp(c, { kind: 'unfreeze', account: 'wallet', dual: false })).toBe('23514');
      // Increase, no threshold, no dual control.
      expect(
        await insertOp(c, { kind: 'credit_limit_change', amount: 200, previous: 100, dual: false }),
      ).toBe('23514');
      // Increase of 101 over a threshold of 100 — the new limit (5101) is irrelevant.
      expect(
        await insertOp(c, {
          kind: 'credit_limit_change',
          amount: 5101,
          previous: 5000,
          dual: false,
          threshold: 100,
        }),
      ).toBe('23514');
      // Freeze or provisioning marked dual: not how the rule reads.
      expect(await insertOp(c, { kind: 'freeze', account: 'wallet', dual: true })).toBe('23514');
      // Amounts only on a limit change, which belongs to the credit account.
      expect(await insertOp(c, { kind: 'freeze', account: 'wallet', amount: 1, dual: false })).toBe(
        '23514',
      );
      expect(
        await insertOp(c, {
          kind: 'credit_limit_change',
          account: 'wallet',
          amount: 50,
          previous: 100,
          dual: false,
        }),
      ).toBe('23514');
      // Admitted: an increase of exactly the threshold, a decrease, a freeze, a provisioning.
      expect(
        await insertOp(c, {
          kind: 'credit_limit_change',
          amount: 5100,
          previous: 5000,
          dual: false,
          threshold: 100,
        }),
      ).toBe('OK');
      expect(await insertOp(c, { kind: 'freeze', account: 'credit_account', dual: false })).toBe(
        'OK',
      );
      expect(await insertOp(c, { kind: 'provision', account: 'wallet', dual: false })).toBe('OK');
      expect(await insertOp(c, { kind: 'unfreeze', account: 'wallet', dual: true })).toBe('OK');
      // One pending per (organisation, account, kind).
      expect(await insertOp(c, { kind: 'unfreeze', account: 'wallet', dual: true })).toBe('23505');
    });
  });

  it('four eyes, request immutability, finality, append-only', async () => {
    await owner(A.userId, async (c) => {
      const id = (
        await c.query(
          `INSERT INTO billing_account_operations (org_id, account, kind, dual_control, reason, request_key, requested_by)
           VALUES ($1, 'wallet', 'unfreeze', true, 'r', $2, $3) RETURNING id`,
          [A.orgId, `k-${uuidv7()}`, A.userId],
        )
      ).rows[0].id;
      const upd = (set: string, params: unknown[] = []) =>
        code(c, `UPDATE billing_account_operations SET ${set} WHERE id = $1`, [id, ...params]);
      expect(await upd(`approved_by = requested_by, approved_at = now()`)).toBe('23514');
      expect(
        await upd(
          `status = 'rejected', rejected_by = requested_by, rejected_at = now(), rejection_reason = 'x'`,
        ),
      ).toBe('23514');
      expect(await upd(`reason = 'changed'`)).toBe('42501');
      expect(await upd(`kind = 'freeze', dual_control = false`)).toBe('42501');
      expect(
        await upd(
          `status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = 'no'`,
          [B.userId],
        ),
      ).toBe('OK');
      expect(await upd(`rejection_reason = 'again'`)).toBe('42501');
      expect(await code(c, `DELETE FROM billing_account_operations WHERE id = $1`, [id])).toBe(
        '42501',
      );
      expect(await code(c, `TRUNCATE billing_account_operations`)).toBe('42501');
    });
  });

  // --- 3. execution ---------------------------------------------------------------------------

  it('provisioning creates an empty account once; a second request is BL013', async () => {
    await owner(A.userId, async (c) => {
      const r = await request(c, A.orgId, 'wallet', 'provision');
      expect(r.rows[0].executed).toBe(true);
      const w = await c.query(
        `SELECT balance_paise, reserved_paise, status FROM wallets WHERE org_id = $1`,
        [A.orgId],
      );
      expect(w.rows[0]).toEqual({ balance_paise: '0', reserved_paise: '0', status: 'active' });
      expect(
        await code(
          c,
          `SELECT * FROM app_billing_account_request($1, 'wallet', 'provision', NULL, NULL, 'r', NULL, 'k2')`,
          [A.orgId],
        ),
      ).toBe('BL013');
      await request(c, A.orgId, 'credit_account', 'provision');
      expect(
        (
          await c.query(
            `SELECT credit_limit_paise, used_paise, reserved_paise FROM credit_accounts WHERE org_id = $1`,
            [A.orgId],
          )
        ).rows[0],
      ).toEqual({ credit_limit_paise: '0', used_paise: '0', reserved_paise: '0' });
    });
  });

  it('a credit-limit change is bound to the previous limit, needs approval when dual, and never changes a frozen status', async () => {
    await owner(A.userId, async (c) => {
      await request(c, A.orgId, 'credit_account', 'provision');
      // Decrease from 0 is impossible; increase to 500, threshold 1000: single.
      expect(
        (await request(c, A.orgId, 'credit_account', 'credit_limit_change', [500, 0], 1000)).rows[0]
          .executed,
      ).toBe(true);
      // Stale previous limit.
      expect(
        await code(
          c,
          `SELECT * FROM app_billing_account_request($1, 'credit_account', 'credit_limit_change', 900, 0, 'r', 1000, 'k3')`,
          [A.orgId],
        ),
      ).toBe('BL014');
      await request(c, A.orgId, 'credit_account', 'freeze');
      // Decrease while frozen: executes; the account stays frozen.
      await request(c, A.orgId, 'credit_account', 'credit_limit_change', [300, 500]);
      // Increase while frozen, dual (no threshold): approved by B's user.
      const pending = (
        await request(c, A.orgId, 'credit_account', 'credit_limit_change', [800, 300])
      ).rows[0];
      expect(pending.executed).toBe(false);
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [B.userId]);
      expect(
        await code(c, `SELECT app_billing_account_approve($1, 799)`, [pending.operation_id]),
      ).toBe('BL014');
      await c.query(`SELECT app_billing_account_approve($1, 800)`, [pending.operation_id]);
      const acc = await c.query(
        `SELECT credit_limit_paise, status FROM credit_accounts WHERE org_id = $1`,
        [A.orgId],
      );
      expect(acc.rows[0]).toEqual({ credit_limit_paise: '800', status: 'frozen' });
    });
  });

  it('freeze changes status only; the writer then refuses new reservations while existing reservations still settle; unfreeze needs a second user', async () => {
    await owner(A.userId, async (c) => {
      await request(c, A.orgId, 'wallet', 'provision');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE wallets SET balance_paise = 1000 WHERE org_id = $1`, [A.orgId]);
      const contact = uuidv7();
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
        contact,
        A.orgId,
        A.workspaceId,
      ]);
      const plant = async () => {
        const id = uuidv7();
        await c.query(
          `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id,
                                 completed_at, billable_units, billable_unit, billing_enforced, billing_mode_snapshot, billing_policy_snapshot)
           VALUES ($1, $2, $3, $4, $5, 'outcome_unknown', '+12025550133', 'c', now(), 1, 'message', true, 'prepaid', 'charge_per_logical_message')`,
          [id, A.orgId, A.workspaceId, contact, channel],
        );
        return id;
      };
      await c.query(`SET LOCAL session_replication_role = origin`);
      const reserve = (m: string, amount = 100) =>
        `SELECT * FROM app_ledger_post('${A.orgId}', 'reservation', '${m}', ${amount}, 'wallet', '${m}', NULL, 'c', NULL)`;
      const inflight = await plant();
      await c.query(reserve(inflight, 100));
      const before = (
        await c.query(`SELECT balance_paise, reserved_paise FROM wallets WHERE org_id = $1`, [
          A.orgId,
        ])
      ).rows[0];

      await request(c, A.orgId, 'wallet', 'freeze');
      const frozen = (
        await c.query(
          `SELECT balance_paise, reserved_paise, status FROM wallets WHERE org_id = $1`,
          [A.orgId],
        )
      ).rows[0];
      expect(frozen).toEqual({ ...before, status: 'frozen' });

      // New reservations are refused (the existing writer rule, BL002).
      expect(await code(c, reserve(await plant(), 50))).toBe('BL002');
      // The in-flight message settles against its existing reservation.
      await c.query(
        `SELECT * FROM app_ledger_post($1, 'customer_charge', $2, 60, 'wallet', $2, NULL, 'c', NULL)`,
        [A.orgId, inflight],
      );
      await c.query(
        `SELECT * FROM app_ledger_post($1, 'reservation_release', $2, NULL, 'wallet', $2, NULL, 'c', NULL)`,
        [A.orgId, inflight],
      );
      expect(
        (
          await c.query(`SELECT balance_paise, reserved_paise FROM wallets WHERE org_id = $1`, [
            A.orgId,
          ])
        ).rows[0],
      ).toEqual({ balance_paise: '940', reserved_paise: '0' });

      // Unfreeze waits; the requester cannot approve; another user can.
      const un = (await request(c, A.orgId, 'wallet', 'unfreeze', [null, null], 1_000_000)).rows[0];
      expect(un.executed).toBe(false);
      expect(await code(c, `SELECT app_billing_account_approve($1, NULL)`, [un.operation_id])).toBe(
        'BL011',
      );
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [B.userId]);
      expect(await code(c, `SELECT app_billing_account_approve($1, 1)`, [un.operation_id])).toBe(
        'BL014',
      );
      await c.query(`SELECT app_billing_account_approve($1, NULL)`, [un.operation_id]);
      expect(await code(c, reserve(await plant(), 50))).toBe('OK');
    });
  });

  // --- 4. callers ---------------------------------------------------------------------------------

  it('every entry function refuses (42501) a caller without a user or without platform billing.manage; acc_app cannot reach the executor', async () => {
    const calls = [
      `SELECT * FROM app_billing_account_request('${A.orgId}', 'wallet', 'provision', NULL, NULL, 'r', NULL, 'k')`,
      `SELECT app_billing_account_approve('${uuidv7()}', NULL)`,
      `SELECT app_billing_account_reject('${uuidv7()}', 'r')`,
      `SELECT * FROM app_billing_accounts_get('${A.orgId}')`,
      `SELECT * FROM app_billing_account_operations_list(NULL, NULL, NULL, NULL, NULL, NULL, 10)`,
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
      expect(await code(c, `SELECT app_billing_account_execute('${uuidv7()}')`)).toBe('42501');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
