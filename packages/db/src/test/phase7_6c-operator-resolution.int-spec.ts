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
 * Phase 7 PR 7-6c — operator resolution of unknown outcomes (migration `0057`;
 * DECISIONS.md §1zi.9 D-76-1/D-76-3 and §1zi.12). The database half:
 *
 *   1. The ledger writer gained a defaulted tenth argument, p_mode (C-1), and kept its
 *      privileges: no EXECUTE for PUBLIC or any application role. Mode 'automatic' is
 *      unchanged (BL004 after a release is pinned); mode 'operator_resolution' posts only a
 *      customer charge on an enforced outcome_unknown message under a pending charge
 *      resolution, checks the account state and available funds, and moves balance or used
 *      without touching the reservation. Only app_billing_resolve_unknown passes it.
 *   2. billing_unknown_resolutions: four-eyes and dual-control CHECKs, one pending and one
 *      executed per message, the transition guard, append-only; RLS on, no policy, no grant.
 *   3. The entry functions: acc_app only, each refusing (42501) a caller without a user or
 *      without platform billing.manage; the execution and assessment helpers: owner only.
 *
 * Behaviour end to end (dual control, binding, funds, audit) is exercised over HTTP in
 * `apps/api/test/phase7_6c-operator-resolution.int-spec.ts`.
 */
const MIGRATION = readFileSync(
  join(resolve(__dirname, '../..'), 'migrations/0057_phase7_6c_operator_resolution.sql'),
  'utf8',
);
const APP_ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch', 'acc_delivery'] as const;
const WRITER =
  'app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text, text)';
const FUNCTIONS: Record<string, string[]> = {
  [WRITER]: [],
  'app_billing_resolution_request(uuid, text, text, bigint, text)': ['acc_app'],
  'app_billing_resolution_approve(uuid, bigint)': ['acc_app'],
  'app_billing_resolution_reject(uuid, text)': ['acc_app'],
  'app_billing_resolution_note_refusal(uuid)': ['acc_app'],
  'app_billing_resolutions_list(uuid, text, uuid, uuid, uuid, integer)': ['acc_app'],
  'app_billing_resolve_unknown(uuid)': [],
  'app_billing_unknown_assess(uuid)': [],
  'app_billing_unknown_charge_lines(uuid, uuid)': [],
  // 0056, replaced in place: privileges unchanged.
  'app_billing_unknown_register(uuid, text, text, text, integer, timestamp with time zone, uuid, integer)':
    ['acc_app'],
  'app_billing_unknown_open_counts()': ['acc_app'],
};

describe('Phase 7 PR 7-6c — operator resolution (migration 0057)', () => {
  let db: Principals;
  let A: TenantFixture;
  let B: TenantFixture;
  let channel: string;
  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  beforeAll(async () => {
    db = connect();
    A = await createTenant(db.admin, 'p76c-db-a');
    B = await createTenant(db.admin, 'p76c-db-b');
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

  /** One simulator provider assigned to `t`, per transaction. */
  const providers = new WeakMap<PoolClient, Map<string, string>>();

  /** An owner transaction, always rolled back, acting as `user` (a platform-bypassing session). */
  async function owner<R>(user: string, work: (c: PoolClient) => Promise<R>): Promise<R> {
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      // Pooled clients are reused: what an earlier, rolled-back transaction created is gone.
      providers.delete(c);
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [user]);
      return await work(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  async function providerFor(c: PoolClient, t: TenantFixture): Promise<string> {
    const known = providers.get(c) ?? new Map<string, string>();
    providers.set(c, known);
    const existing = known.get(t.orgId);
    if (existing) return existing;
    const provider = (
      await c.query(
        `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
        [channel, `p76c-db-${uuidv7().slice(-8)}`],
      )
    ).rows[0].id as string;
    await c.query(
      `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority) VALUES ($1, $2, $3, 1)`,
      [t.orgId, provider, channel],
    );
    known.set(t.orgId, provider);
    return provider;
  }

  /** An enforced message of `t` in `status`, with one outcome_unknown attempt. */
  async function plant(
    c: PoolClient,
    t: TenantFixture,
    o: { status?: string; mode?: 'prepaid' | 'postpaid' } = {},
  ) {
    const provider = await providerFor(c, t);
    const contact = uuidv7();
    const id = uuidv7();
    const attempt = uuidv7();
    await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
      contact,
      t.orgId,
      t.workspaceId,
    ]);
    await c.query(
      `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id,
                             completed_at, billable_units, billable_unit, billing_enforced, billing_mode_snapshot, billing_policy_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6::message_status, '+12025550133', 'c', now(), 1, 'message', true, $7::billing_mode,
               'charge_per_logical_message')`,
      [
        id,
        t.orgId,
        t.workspaceId,
        contact,
        channel,
        o.status ?? 'outcome_unknown',
        o.mode ?? 'prepaid',
      ],
    );
    await c.query(
      `INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number, fencing_epoch, claim_token, status)
       VALUES ($1, $2, $3, $4, $5, 1, 1, $6, 'outcome_unknown')`,
      [attempt, id, t.orgId, provider, channel, uuidv7()],
    );
    return { id, attempt };
  }

  /** A pending charge resolution for `messageId`, as the request function would leave it. */
  async function pending(c: PoolClient, t: TenantFixture, messageId: string, by = t.userId) {
    const { rows } = await c.query(
      `INSERT INTO billing_unknown_resolutions (org_id, message_id, action, billing_policy, customer_amount_paise,
         evidence, post_provider_cost, dual_control, reason, request_key, requested_by)
       VALUES ($1, $2, 'charge', 'charge_per_logical_message', 50, 'unevidenced', false, true, 'r', 'k', $3)
       RETURNING id`,
      [t.orgId, messageId, by],
    );
    return rows[0].id as string;
  }

  const post = (mode: string | null, type = 'customer_charge', amount = 50, account = 'wallet') =>
    mode === null
      ? `SELECT * FROM app_ledger_post($1, '${type}', $2, ${amount}, '${account}', $2, NULL, 'c', NULL)`
      : `SELECT * FROM app_ledger_post($1, '${type}', $2, ${amount}, '${account}', $2, NULL, 'c', NULL, '${mode}')`;

  // --- 1. privileges and shape ------------------------------------------------------------

  it('the writer has ten arguments (the old nine-argument form is gone) and no application-role privilege', async () => {
    const gone = await admin(
      `SELECT to_regprocedure('app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text)') AS f`,
    );
    expect(gone.rows[0].f).toBeNull();
    const def = await admin(
      `SELECT prosecdef, proconfig, pronargs, pronargdefaults, pg_get_userbyid(proowner) = (
              SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'app_rate_message(uuid, uuid, uuid, integer, boolean, boolean)'::regprocedure
            ) AS same_owner
         FROM pg_proc WHERE oid = $1::regprocedure`,
      [WRITER],
    );
    expect(def.rows[0]).toEqual({
      prosecdef: true,
      proconfig: ['search_path=public, pg_temp'],
      pronargs: 10,
      pronargdefaults: 1,
      same_owner: true,
    });
  });

  it('function privileges: the entry points for acc_app only, the writer and helpers for no application role, never PUBLIC', async () => {
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
        `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure`,
        [fn],
      );
      expect([fn, def.rows[0]]).toEqual([
        fn,
        { prosecdef: true, proconfig: ['search_path=public, pg_temp'] },
      ]);
    }
    expect(result).toEqual(FUNCTIONS);
  });

  it('billing_unknown_resolutions: RLS on, no policy, no privilege for any application role', async () => {
    const rls = await admin(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'billing_unknown_resolutions'::regclass`,
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const policies = await admin(
      `SELECT policyname FROM pg_policies WHERE tablename = 'billing_unknown_resolutions'`,
    );
    expect(policies.rows).toEqual([]);
    const granted = await admin(
      `SELECT r || ':' || p AS g FROM unnest($1::text[]) r,
              unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        WHERE has_table_privilege(r, 'billing_unknown_resolutions', p)`,
      [APP_ROLES],
    );
    expect(granted.rows).toEqual([]);
  });

  it('only app_billing_resolve_unknown passes the operator-resolution mode (structural, D-76-1)', async () => {
    const { rows } = await admin(
      `SELECT p.proname FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%operator_resolution%'
        ORDER BY 1`,
    );
    // The writer defines the mode; the resolution executor is its only user.
    expect(rows.map((r) => r.proname)).toEqual(['app_billing_resolve_unknown', 'app_ledger_post']);
    // In 0057 itself, exactly one writer call passes the mode: the executor's charge.
    const sqlText = MIGRATION.replace(/--[^\n]*/g, '');
    expect([...sqlText.matchAll(/app_ledger_post\([^;]*'operator_resolution'/g)]).toHaveLength(1);
  });

  it('0057 adds no policy and grants EXECUTE on the five entry functions only', () => {
    const sqlText = MIGRATION.replace(/--[^\n]*/g, '');
    expect(sqlText).not.toMatch(/CREATE\s+POLICY|GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
    expect(
      [...sqlText.matchAll(/\bGRANT\b[^;]*;/gi)].map((x) => x[0].replace(/\s+/g, ' ')),
    ).toEqual([
      'GRANT EXECUTE ON FUNCTION app_billing_resolution_request(uuid, text, text, bigint, text) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_resolution_approve(uuid, bigint) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_resolution_reject(uuid, text) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_resolution_note_refusal(uuid) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_resolutions_list(uuid, text, uuid, uuid, uuid, integer) TO acc_app;',
    ]);
  });

  // --- 2. the writer --------------------------------------------------------------------------

  it('automatic mode is unchanged: a customer charge after the release is still BL004, over the reservation BL006', async () => {
    await owner(A.userId, async (c) => {
      await c.query(`INSERT INTO wallets (org_id, balance_paise) VALUES ($1, 1000)`, [A.orgId]);
      const m = await plant(c, A);
      await c.query(post(null, 'reservation', 30), [A.orgId, m.id]);
      expect(await code(c, post(null, 'customer_charge', 40), [A.orgId, m.id])).toBe('BL006');
      await c.query(
        `SELECT * FROM app_ledger_post($1, 'reservation_release', $2, NULL, 'wallet', $2, NULL, 'c', NULL)`,
        [A.orgId, m.id],
      );
      expect(await code(c, post(null), [A.orgId, m.id])).toBe('BL004');
      expect(await code(c, post('automatic'), [A.orgId, m.id])).toBe('BL004');
    });
  });

  it('operator mode: charges a released outcome_unknown message under a pending charge resolution; reserved unchanged, no reservation posted; idempotent', async () => {
    await owner(A.userId, async (c) => {
      await c.query(
        `INSERT INTO wallets (org_id, balance_paise, reserved_paise) VALUES ($1, 1000, 0)`,
        [A.orgId],
      );
      const m = await plant(c, A);
      await c.query(post(null, 'reservation', 50), [A.orgId, m.id]);
      await c.query(
        `SELECT * FROM app_ledger_post($1, 'reservation_release', $2, NULL, 'wallet', $2, NULL, 'c', NULL)`,
        [A.orgId, m.id],
      );
      // Another message's live reservation must stay untouched.
      const other = await plant(c, A);
      await c.query(post(null, 'reservation', 70), [A.orgId, other.id]);

      // Without a pending charge resolution the mode refuses.
      expect(await code(c, post('operator_resolution'), [A.orgId, m.id])).toBe('22023');
      await pending(c, A, m.id);
      // Customer charges only.
      expect(await code(c, post('operator_resolution', 'reservation'), [A.orgId, m.id])).toBe(
        '22023',
      );
      expect(await code(c, post('no_such_mode'), [A.orgId, m.id])).toBe('22023');

      const first = await c.query(post('operator_resolution'), [A.orgId, m.id]);
      expect(first.rows[0]).toMatchObject({ inserted: true, amount_paise: '50' });
      const again = await c.query(post('operator_resolution'), [A.orgId, m.id]);
      expect(again.rows[0]).toMatchObject({ inserted: false, amount_paise: '50' });

      const w = await c.query(
        `SELECT balance_paise, reserved_paise FROM wallets WHERE org_id = $1`,
        [A.orgId],
      );
      expect(w.rows[0]).toEqual({ balance_paise: '950', reserved_paise: '70' });
      const facts = await c.query(
        `SELECT entry_type, amount_paise, reference_note FROM usage_ledger WHERE message_id = $1 ORDER BY occurred_at, id`,
        [m.id],
      );
      expect(facts.rows.map((r) => `${r.entry_type}:${r.amount_paise}`)).toEqual([
        'reservation:50',
        'reservation_release:50',
        'customer_charge:50',
      ]);
    });
  });

  it('operator mode on a credit account moves used only', async () => {
    await owner(B.userId, async (c) => {
      await c.query(
        `INSERT INTO credit_accounts (org_id, credit_limit_paise, used_paise, reserved_paise) VALUES ($1, 500, 100, 25)`,
        [B.orgId],
      );
      const m = await plant(c, B, { mode: 'postpaid' });
      await pending(c, B, m.id);
      await c.query(post('operator_resolution', 'customer_charge', 60, 'credit'), [B.orgId, m.id]);
      const a = await c.query(
        `SELECT used_paise, reserved_paise FROM credit_accounts WHERE org_id = $1`,
        [B.orgId],
      );
      expect(a.rows[0]).toEqual({ used_paise: '160', reserved_paise: '25' });
    });
  });

  it('operator mode refuses insufficient funds (BL003), a frozen account (BL002) and a message that is not an unknown outcome', async () => {
    await owner(A.userId, async (c) => {
      await c.query(
        `INSERT INTO wallets (org_id, balance_paise, reserved_paise) VALUES ($1, 100, 60)`,
        [A.orgId],
      );
      const m = await plant(c, A);
      await pending(c, A, m.id);
      // available = 100 − 60 = 40 < 50
      expect(await code(c, post('operator_resolution'), [A.orgId, m.id])).toBe('BL003');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE wallets SET status = 'frozen', reserved_paise = 0 WHERE org_id = $1`, [
        A.orgId,
      ]);
      await c.query(`SET LOCAL session_replication_role = origin`);
      expect(await code(c, post('operator_resolution'), [A.orgId, m.id])).toBe('BL002');

      const accepted = await plant(c, A, { status: 'accepted' });
      await pending(c, A, accepted.id);
      expect(await code(c, post('operator_resolution'), [A.orgId, accepted.id])).toBe('22023');
    });
  });

  // --- 3. the table ------------------------------------------------------------------------

  it('CHECKs: four eyes, dual control without a threshold or for an unevidenced charge, provider cost only with evidence', async () => {
    await owner(A.userId, async (c) => {
      const m = await plant(c, A);
      const insert = (vals: string, threshold: number | null = null) =>
        code(
          c,
          `INSERT INTO billing_unknown_resolutions (org_id, message_id, action, billing_policy, customer_amount_paise,
             evidence, post_provider_cost, dual_control, reason, request_key, requested_by, threshold_paise)
           VALUES ($1, $2, ${vals}, 'r', 'k', $3, $4)`,
          [A.orgId, m.id, A.userId, threshold],
        );
      // No threshold: dual control is mandatory.
      expect(
        await insert(`'write_off', 'charge_per_logical_message', 50, 'evidenced', false, false`),
      ).toBe('23514');
      // Above the threshold: dual control is mandatory.
      expect(
        await insert(
          `'write_off', 'charge_per_logical_message', 50, 'evidenced', false, false`,
          40,
        ),
      ).toBe('23514');
      // An unevidenced charge needs dual control whatever the threshold.
      expect(
        await insert(
          `'charge', 'charge_per_logical_message', 50, 'unevidenced', false, false`,
          100,
        ),
      ).toBe('23514');
      // At or below a threshold, without dual control: admitted.
      expect(
        await insert(`'charge', 'charge_per_logical_message', 50, 'evidenced', true, false`, 50),
      ).toBe('OK');
      // Provider cost without evidence.
      expect(
        await insert(`'charge', 'charge_per_logical_message', 50, 'unevidenced', true, true`),
      ).toBe('23514');
      // Four eyes (on a second message: the admitted row above holds this one's pending slot).
      const m2 = await plant(c, A);
      const id = await pending(c, A, m2.id);
      expect(
        await code(
          c,
          `UPDATE billing_unknown_resolutions SET approved_by = requested_by, approved_at = now() WHERE id = $1`,
          [id],
        ),
      ).toBe('23514');
      expect(
        await code(
          c,
          `UPDATE billing_unknown_resolutions SET status = 'rejected', rejected_by = requested_by, rejected_at = now(), rejection_reason = 'x' WHERE id = $1`,
          [id],
        ),
      ).toBe('23514');
    });
  });

  it('one pending and one executed per message; the guard makes a closed resolution final and the request immutable; nothing is deleted', async () => {
    await owner(A.userId, async (c) => {
      const m = await plant(c, A);
      const id = await pending(c, A, m.id);
      // A second pending request for the same message.
      expect(
        await code(
          c,
          `INSERT INTO billing_unknown_resolutions (org_id, message_id, action, billing_policy, customer_amount_paise,
             evidence, post_provider_cost, dual_control, reason, request_key, requested_by)
           VALUES ($1, $2, 'write_off', 'charge_per_logical_message', 50, 'unevidenced', false, true, 'r', 'k', $3)`,
          [A.orgId, m.id, A.userId],
        ),
      ).toBe('23505');
      // The request's own columns never change.
      expect(
        await code(c, `UPDATE billing_unknown_resolutions SET reason = 'other' WHERE id = $1`, [
          id,
        ]),
      ).toBe('42501');
      expect(
        await code(
          c,
          `UPDATE billing_unknown_resolutions SET customer_amount_paise = 1 WHERE id = $1`,
          [id],
        ),
      ).toBe('42501');
      // Reject it (a different user), then it is final.
      await c.query(
        `UPDATE billing_unknown_resolutions SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = 'no' WHERE id = $1`,
        [id, B.userId],
      );
      expect(
        await code(
          c,
          `UPDATE billing_unknown_resolutions SET rejection_reason = 'x' WHERE id = $1`,
          [id],
        ),
      ).toBe('42501');
      expect(await code(c, `DELETE FROM billing_unknown_resolutions WHERE id = $1`, [id])).toBe(
        '42501',
      );
      expect(await code(c, `TRUNCATE billing_unknown_resolutions`)).toBe('42501');
    });
  });

  // --- 4. callers ------------------------------------------------------------------------------

  it('every entry function refuses (42501) a caller without a user, and a tenant user without platform billing.manage', async () => {
    const calls = [
      `SELECT * FROM app_billing_resolution_request('${uuidv7()}', 'charge', 'r', NULL, 'k')`,
      `SELECT * FROM app_billing_resolution_approve('${uuidv7()}', 0)`,
      `SELECT app_billing_resolution_reject('${uuidv7()}', 'r')`,
      `SELECT app_billing_resolution_note_refusal('${uuidv7()}')`,
      `SELECT * FROM app_billing_resolutions_list(NULL, NULL, NULL, NULL, NULL, 10)`,
    ];
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      for (const call of calls) {
        expect([call.slice(0, 50), await code(c, call)]).toEqual([call.slice(0, 50), '42501']);
      }
      await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [A.orgId]);
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [A.userId]);
      for (const call of calls) {
        expect([call.slice(0, 50), await code(c, call)]).toEqual([call.slice(0, 50), '42501']);
      }
      // acc_app cannot reach the executor, the helpers or the writer at all.
      for (const call of [
        `SELECT * FROM app_billing_resolve_unknown('${uuidv7()}')`,
        `SELECT * FROM app_billing_unknown_assess('${uuidv7()}')`,
        `SELECT * FROM app_ledger_post('${uuidv7()}', 'customer_charge', '${uuidv7()}', 1, 'wallet', '${uuidv7()}', NULL, 'c', NULL, 'operator_resolution')`,
      ]) {
        expect([call.slice(0, 50), await code(c, call)]).toEqual([call.slice(0, 50), '42501']);
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
