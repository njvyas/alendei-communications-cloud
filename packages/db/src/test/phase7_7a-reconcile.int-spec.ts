import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import {
  SQL_C1_WALLETS,
  SQL_C6_REGISTER,
  SQL_MESSAGE_ANCHORS,
  runReconcile,
  type ReconcileReport,
} from '../maintenance/billing-reconcile';
import {
  connect,
  createTenant,
  destroyTenant,
  type Principals,
  type TenantFixture,
} from './harness';

/**
 * Phase 7 PR 7-7a — `billing:reconcile` (handover `docs/PHASE-7-7A-RECONCILE-HANDOVER.md` §6–§7).
 *
 * Fixtures are built through the real paths: account operations and recharge (7-6d), the ledger
 * writer in the order 7.4/7.5 settlement posts, and 7-6c operator resolutions. Defects are then
 * injected as committed owner changes with triggers suspended, and removed in teardown.
 *
 *   A-1 clean run (both policies, both modes, accepted/failed/unknown, executed charge and
 *       write-off resolutions, recharges, a frozen account); C-6 parity with the register.
 *   A-2 … A-9 one seeded defect each; A-11 all at once; A-12 the command's exit code 2.
 *   R-1 statement log; R-2 no transaction id; R-3 before/after state identical.
 *   Partition pruning: EXPLAIN ANALYZE of the C-2/C-3 and C-6 queries.
 */
const run = promisify(execFile);
const PACKAGE_ROOT = resolve(__dirname, '../..');
const EVIDENCE = process.env.RECONCILE_EVIDENCE_DIR ?? null;
const DEFAULTS = { since: null, staleHours: 24, statementTimeoutMs: 120_000 };

describe('Phase 7 PR 7-7a — billing:reconcile', () => {
  let db: Principals;
  let channel: string;
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  beforeAll(async () => {
    db = connect();
    channel = (await admin(`SELECT id FROM channels WHERE code = 'whatsapp'`)).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    try {
      const orgs = tenants.map((t) => t.orgId);
      if (orgs.length > 0) {
        const c = await db.adminPool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SET LOCAL session_replication_role = replica');
          for (const table of [
            'usage_ledger',
            'billing_unknown_resolutions',
            'billing_account_operations',
            'pricing_evaluations',
            'message_attempt_billing',
            'message_attempts',
            'messages',
            'contacts',
            'wallets',
            'credit_accounts',
            'organization_provider_assignments',
          ]) {
            await c.query(`DELETE FROM ${table} WHERE org_id = ANY($1::uuid[])`, [orgs]);
          }
          await c.query(`DELETE FROM providers WHERE id = ANY($1::uuid[])`, [providers]);
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      }
      for (const t of tenants) await destroyTenant(db.admin, t);
    } finally {
      await db.close();
    }
  }, 120_000);

  // --- fixtures -----------------------------------------------------------------------------

  /** An owner transaction acting as the tenant's user (the definers' caller check). */
  async function asOwner<R>(t: TenantFixture, work: (c: PoolClient) => Promise<R>): Promise<R> {
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [t.userId]);
      const out = await work(c);
      await c.query('COMMIT');
      return out;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  /** Committed owner changes with triggers suspended (defect injection only). */
  async function replica(work: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await work(c);
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  interface Org {
    t: TenantFixture;
    provider: string;
    contact: string;
    account: 'wallet' | 'credit';
  }

  async function org(
    label: string,
    account: 'wallet' | 'credit' = 'wallet',
    funds = 100_000,
  ): Promise<Org> {
    const t = await createTenant(db.admin, label);
    tenants.push(t);
    const provider = (
      await admin(
        `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
        [channel, `p77a-${uuidv7().slice(-10)}`],
      )
    ).rows[0].id as string;
    providers.push(provider);
    await admin(
      `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority) VALUES ($1, $2, $3, 1)`,
      [t.orgId, provider, channel],
    );
    const contact = uuidv7();
    await admin(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
      contact,
      t.orgId,
      t.workspaceId,
    ]);
    // Accounts through the real 7-6d paths.
    await asOwner(t, async (c) => {
      if (account === 'wallet') {
        await c.query(
          `SELECT * FROM app_billing_account_request($1, 'wallet', 'provision', NULL, NULL, 'p77a', NULL, $2)`,
          [t.orgId, uuidv7()],
        );
        await c.query(
          `SELECT * FROM app_billing_account_request_recharge($1, $2, $3, current_date, 'p77a', 1000000000, $4)`,
          [t.orgId, funds, `P77A${uuidv7().slice(-12).toUpperCase()}`, uuidv7()],
        );
      } else {
        await c.query(
          `SELECT * FROM app_billing_account_request($1, 'credit_account', 'provision', NULL, NULL, 'p77a', NULL, $2)`,
          [t.orgId, uuidv7()],
        );
        await c.query(
          `SELECT * FROM app_billing_account_request($1, 'credit_account', 'credit_limit_change', $2, 0, 'p77a', 1000000000, $3)`,
          [t.orgId, funds, uuidv7()],
        );
      }
    });
    return { t, provider, contact, account };
  }

  interface Msg {
    id: string;
    attempts: string[];
  }

  /**
   * A billed message with attempts (status per attempt), its evaluations (E_m, E_a, provider
   * cost) and the reached classification, planted by the owner as dispatch would leave them.
   */
  async function message(
    o: Org,
    status: string,
    policy: 'charge_per_logical_message' | 'charge_per_attempt',
    attempts: {
      status: string;
      reached: boolean | null;
      price?: number;
      cost?: number;
      evidenced?: boolean;
    }[],
    opts: { em?: number; createdHoursAgo?: number } = {},
  ): Promise<Msg> {
    const id = uuidv7();
    const ids = attempts.map(() => uuidv7());
    const created = new Date(Date.now() - (opts.createdHoursAgo ?? 0) * 3_600_000).toISOString();
    await replica(async (c) => {
      await c.query(
        `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id,
                               created_at, completed_at, billable_units, billable_unit, billing_enforced,
                               billing_mode_snapshot, billing_policy_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6::message_status, '+12025550177', 'p77a', $7::timestamptz,
                 CASE WHEN $6 IN ('accepted','failed','outcome_unknown') THEN now() END, 1, 'message', true,
                 $8::billing_mode, $9::billing_policy)`,
        [
          id,
          o.t.orgId,
          o.t.workspaceId,
          o.contact,
          channel,
          status,
          created,
          o.account === 'wallet' ? 'prepaid' : 'postpaid',
          policy,
        ],
      );
      await c.query(
        `INSERT INTO pricing_evaluations (org_id, message_id, subject, plan_version_id, rating_timestamp, units, unit,
                                          total_customer_price_paise)
         VALUES ($1, $2, 'message', $3, now(), 1, 'message', $4)`,
        [o.t.orgId, id, uuidv7(), opts.em ?? 50],
      );
      for (let i = 0; i < attempts.length; i += 1) {
        const a = attempts[i]!;
        await c.query(
          `INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number, fencing_epoch,
                                         claim_token, status, delivery_status, delivered_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8::message_attempt_status,
                   $9::message_delivery_status, $10::timestamptz)`,
          [
            ids[i],
            id,
            o.t.orgId,
            o.provider,
            channel,
            i + 1,
            uuidv7(),
            a.status,
            a.evidenced ? 'delivered' : 'pending',
            a.evidenced ? new Date().toISOString() : null,
          ],
        );
        const perAttempt = policy === 'charge_per_attempt';
        await c.query(
          `INSERT INTO pricing_evaluations (org_id, message_id, message_attempt_id, subject, plan_version_id,
                                            rating_timestamp, units, unit, total_customer_price_paise,
                                            total_provider_cost_paise)
           VALUES ($1, $2, $3, 'attempt', $4, now(), 1, 'message', $5, $6)`,
          [
            o.t.orgId,
            id,
            ids[i],
            perAttempt ? uuidv7() : null,
            perAttempt ? (a.price ?? 60) : null,
            a.cost ?? 20,
          ],
        );
        if (a.reached !== null) {
          await c.query(
            `INSERT INTO message_attempt_billing (attempt_id, message_id, org_id, reached_provider) VALUES ($1, $2, $3, $4)`,
            [ids[i], id, o.t.orgId, a.reached],
          );
        }
      }
    });
    return { id, attempts: ids };
  }

  /** The writer, automatic mode, in the order settlement posts. */
  const post = (
    o: Org,
    type: string,
    anchor: string,
    msg: string,
    attempt: string | null,
    amount: number | null,
    note: string | null = null,
  ) =>
    admin(
      `SELECT * FROM app_ledger_post($1, $2::usage_ledger_entry_type, $3, $4, $5, $6, $7, 'p77a', $8)`,
      [
        o.t.orgId,
        type,
        anchor,
        amount,
        type === 'provider_cost' ? null : o.account,
        msg,
        attempt,
        note,
      ],
    );
  const reserve = (o: Org, m: string, amount: number, attempt: string | null = null) =>
    post(o, 'reservation', attempt ?? m, m, attempt, amount);
  const charge = (o: Org, m: string, amount: number, attempt: string | null = null) =>
    post(o, 'customer_charge', attempt ?? m, m, attempt, amount);
  const release = (o: Org, m: string) => post(o, 'reservation_release', m, m, null, null);
  const cost = (o: Org, m: string, attempt: string, amount: number) =>
    post(o, 'provider_cost', attempt, m, attempt, amount);

  /** An accepted per-message message, settled: reservation 50, charge 50, cost 20. */
  async function acceptedPerMessage(o: Org, reservation = 50): Promise<Msg> {
    const m = await message(o, 'accepted', 'charge_per_logical_message', [
      { status: 'accepted', reached: true },
    ]);
    await reserve(o, m.id, reservation);
    await cost(o, m.id, m.attempts[0]!, 20);
    await charge(o, m.id, 50);
    await release(o, m.id);
    return m;
  }

  /** A raw ledger fact (defect injection), with the fact key's month derived from the anchor. */
  async function rawFact(
    o: Org,
    type: string,
    anchor: string,
    msg: string,
    attempt: string | null,
    amount: number,
    note: string | null = null,
  ) {
    await replica(async (c) => {
      const account = type === 'provider_cost' ? null : o.account;
      await c.query(
        `INSERT INTO usage_ledger (anchor_month, anchor_id, fact_kind, entry_type, org_id, message_id, message_attempt_id,
                                   wallet_id, credit_account_id, amount_paise, reference_note)
         VALUES (app_uuidv7_month($1), $1, $2::text, $9::usage_ledger_entry_type, $3, $4, $5,
                 CASE WHEN $6::text = 'wallet' THEN (SELECT id FROM wallets WHERE org_id = $3) END,
                 CASE WHEN $6::text = 'credit' THEN (SELECT id FROM credit_accounts WHERE org_id = $3) END, $7, $8)`,
        [anchor, type, o.t.orgId, msg, attempt, account, amount, note, type],
      );
    });
  }
  const dropFact = (anchor: string, kind: string) =>
    replica(async (c) => {
      await c.query(`DELETE FROM usage_ledger WHERE anchor_id = $1 AND fact_kind = $2`, [
        anchor,
        kind,
      ]);
    });

  /** One reconcile run on its own connection; R-2 asserted for every run. */
  async function reconcile(
    orgs: string[] | null,
    over: Partial<typeof DEFAULTS> = {},
    log?: string[],
  ): Promise<ReconcileReport> {
    const c = await db.adminPool.connect();
    try {
      const client = log
        ? (new Proxy(c, {
            get(target, prop) {
              if (prop === 'query') {
                return (text: unknown, params?: unknown) => {
                  log.push(typeof text === 'string' ? text : (text as { text: string }).text);
                  return (target.query as (t: unknown, p?: unknown) => Promise<unknown>).call(
                    target,
                    text,
                    params,
                  );
                };
              }
              const v = (target as unknown as Record<string | symbol, unknown>)[prop];
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          }) as PoolClient)
        : c;
      const report = await runReconcile(client, { orgs, ...DEFAULTS, ...over });
      if (report.complete) expect(report.transactionIdAssigned).toBe(false); // R-2
      return report;
    } finally {
      c.release();
    }
  }
  const findingIds = (r: ReconcileReport, check?: string) =>
    r.checks
      .flatMap((c) => c.findings)
      .filter((f) => !check || f.check === check)
      .map((f) => f.id);

  /** R-3: everything reconcile could conceivably touch, summarised. */
  async function stateFingerprint(): Promise<string> {
    const { rows } = await admin(`
      SELECT (SELECT count(*) || ':' || COALESCE(sum(amount_paise), 0) FROM usage_ledger) AS ledger,
             (SELECT count(*) || ':' || COALESCE(sum(balance_paise + reserved_paise + version), 0) FROM wallets) AS wallets,
             (SELECT count(*) || ':' || COALESCE(sum(used_paise + reserved_paise + credit_limit_paise + version), 0) FROM credit_accounts) AS credit,
             (SELECT count(*) FROM billing_account_operations) AS operations,
             (SELECT count(*) FROM billing_unknown_resolutions) AS resolutions,
             (SELECT count(*) FROM idempotency_keys) AS keys,
             (SELECT string_agg(c.relname || ':' || (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid = c.oid), ',' ORDER BY c.relname)
                FROM pg_class c WHERE c.relname LIKE 'usage_ledger_p%') AS partitions`);
    return JSON.stringify(rows[0]);
  }

  // --- A-1: the clean run ---------------------------------------------------------------------

  const clean: Org[] = [];

  it('A-1 clean run: exit 0, no findings; C-6 lists the unknown outcomes exactly as the register does; R-1 and R-3', async () => {
    // Prepaid, per message: accepted, failed, unknown (open), unknown charged, unknown written off,
    // and a young non-terminal message holding its reservation.
    const p1 = await org('p77a-p1');
    clean.push(p1);
    await acceptedPerMessage(p1);
    const failed = await message(p1, 'failed', 'charge_per_logical_message', [
      { status: 'failed', reached: true },
    ]);
    await reserve(p1, failed.id, 50);
    await cost(p1, failed.id, failed.attempts[0]!, 20);
    await release(p1, failed.id);
    const open = await message(p1, 'outcome_unknown', 'charge_per_logical_message', [
      { status: 'outcome_unknown', reached: false },
    ]);
    await reserve(p1, open.id, 50);
    await release(p1, open.id);
    const charged = await message(p1, 'outcome_unknown', 'charge_per_logical_message', [
      { status: 'outcome_unknown', reached: false, evidenced: true },
    ]);
    await reserve(p1, charged.id, 50);
    await release(p1, charged.id);
    const writtenOff = await message(p1, 'outcome_unknown', 'charge_per_logical_message', [
      { status: 'outcome_unknown', reached: false },
    ]);
    await reserve(p1, writtenOff.id, 50);
    await release(p1, writtenOff.id);
    await asOwner(p1.t, async (c) => {
      await c.query(
        `SELECT * FROM app_billing_resolution_request($1, 'charge', 'p77a', 1000000000, $2)`,
        [charged.id, uuidv7()],
      );
      await c.query(
        `SELECT * FROM app_billing_resolution_request($1, 'write_off', 'p77a', 1000000000, $2)`,
        [writtenOff.id, uuidv7()],
      );
    });
    const young = await message(
      p1,
      'submitting',
      'charge_per_logical_message',
      [{ status: 'submitting', reached: null }],
      { createdHoursAgo: 1 },
    );
    await reserve(p1, young.id, 50);

    // Prepaid, per attempt: an accepted two-attempt chain with a top-up, and an unknown chain
    // charged by the operator across its reached and unknown attempts (D-76c-1).
    const p2 = await org('p77a-p2');
    clean.push(p2);
    const chain = await message(p2, 'accepted', 'charge_per_attempt', [
      { status: 'failed', reached: true },
      { status: 'accepted', reached: true },
    ]);
    await reserve(p2, chain.id, 60);
    await cost(p2, chain.id, chain.attempts[0]!, 20);
    await reserve(p2, chain.id, 60, chain.attempts[1]!);
    await cost(p2, chain.id, chain.attempts[1]!, 20);
    await charge(p2, chain.id, 60, chain.attempts[0]!);
    await charge(p2, chain.id, 60, chain.attempts[1]!);
    await release(p2, chain.id);
    const unknownChain = await message(p2, 'outcome_unknown', 'charge_per_attempt', [
      { status: 'failed', reached: true },
      { status: 'outcome_unknown', reached: false, evidenced: true },
    ]);
    await reserve(p2, unknownChain.id, 60);
    await cost(p2, unknownChain.id, unknownChain.attempts[0]!, 20);
    await reserve(p2, unknownChain.id, 60, unknownChain.attempts[1]!);
    await release(p2, unknownChain.id);
    await asOwner(p2.t, async (c) => {
      await c.query(
        `SELECT * FROM app_billing_resolution_request($1, 'charge', 'p77a', 1000000000, $2)`,
        [unknownChain.id, uuidv7()],
      );
    });

    // Postpaid, per message; and a frozen prepaid account.
    const c1 = await org('p77a-c1', 'credit');
    clean.push(c1);
    await acceptedPerMessage(c1);
    const f1 = await org('p77a-f1');
    clean.push(f1);
    await acceptedPerMessage(f1);
    await asOwner(f1.t, async (c) => {
      await c.query(
        `SELECT * FROM app_billing_account_request($1, 'wallet', 'freeze', NULL, NULL, 'p77a', NULL, $2)`,
        [f1.t.orgId, uuidv7()],
      );
    });

    const orgs = clean.map((o) => o.t.orgId);
    const before = await stateFingerprint();
    const statements: string[] = [];
    const report = await reconcile(orgs, {}, statements);
    expect(await stateFingerprint()).toBe(before); // R-3

    expect(findingIds(report)).toEqual([]);
    expect(report).toMatchObject({
      complete: true,
      exitCode: 0,
      readOnly: true,
      transactionIdAssigned: false,
    });
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      'C-1:pass',
      'C-2:pass',
      'C-3:pass',
      'C-4:pass',
      'C-5:pass',
      'C-6:pass',
    ]);
    expect(report.migrationProof).toMatch(/^\d+\|[0-9a-f]{32}$/);

    // R-1: one read-only transaction, nothing that writes.
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements[statements.length - 1]).toBe('COMMIT');
    for (const s of statements) {
      expect([
        s.slice(0, 60),
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY|CREATE|ALTER|DROP|GRANT|REVOKE)\b|set_config|ensure_partitions|app_ledger_post/i.test(
          s,
        ),
      ]).toEqual([s.slice(0, 60), false]);
    }

    // C-6 parity with app_billing_unknown_register (the register's own semantics, unchanged).
    const items = (
      report.checks.find((c) => c.id === 'C-6')!.info as { items: Record<string, unknown>[] }
    ).items;
    expect(items).toHaveLength(4);
    const register: Record<string, unknown>[] = [];
    for (const o of clean) {
      await asOwner(o.t, async (c) => {
        register.push(
          ...(
            await c.query(
              `SELECT * FROM app_billing_unknown_register($1, NULL, NULL, NULL, NULL, NULL, NULL, 201)`,
              [o.t.orgId],
            )
          ).rows,
        );
      });
    }
    const norm = (r: Record<string, unknown>) => ({
      message: r.message_id,
      org: r.org_id,
      channel: r.channel_code,
      policy: String(r.billing_policy),
      attempt: r.attempt_id,
      provider: r.provider_id,
      customer: r.estimated_customer_paise == null ? null : String(r.estimated_customer_paise),
      cost:
        r.estimated_provider_cost_paise == null ? null : String(r.estimated_provider_cost_paise),
      evidence: r.evidence,
      status: r.status,
    });
    const key = (x: { message: unknown }) => String(x.message);
    expect(items.map(norm).sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      register.map(norm).sort((a, b) => key(a).localeCompare(key(b))),
    );
    expect(items.map((i) => i.status).sort()).toEqual([
      'charged',
      'charged',
      'open',
      'written_off',
    ]);
    if (EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      writeFileSync(join(EVIDENCE, 'a1-clean-report.json'), JSON.stringify(report, null, 2));
      writeFileSync(join(EVIDENCE, 'a1-statements.txt'), statements.join('\n----\n'));
    }
  }, 180_000);

  // --- A-2 … A-8: one seeded defect each ---------------------------------------------------------

  const defects: { orgs: string[]; expect: string[] } = { orgs: [], expect: [] };
  async function expectDefect(o: Org, expected: string[], extraAllowed = true) {
    defects.orgs.push(o.t.orgId);
    defects.expect.push(...expected);
    const r = await reconcile([o.t.orgId]);
    const got = findingIds(r);
    for (const id of expected) expect(got).toContain(id);
    if (!extraAllowed) expect(got.sort()).toEqual([...expected].sort());
    expect(r.exitCode).toBe(1);
    return r;
  }

  it('A-2 wallet balance +1 → C-1 error with exact expected and actual', async () => {
    const o = await org('p77a-a2');
    await acceptedPerMessage(o);
    await admin(`UPDATE wallets SET balance_paise = balance_paise + 1 WHERE org_id = $1`, [
      o.t.orgId,
    ]);
    const wallet = (
      await admin(`SELECT id, balance_paise FROM wallets WHERE org_id = $1`, [o.t.orgId])
    ).rows[0];
    const r = await expectDefect(o, [`C-1:wallet_balance:${wallet.id}/wallet`], false);
    const f = r.checks[0]!.findings[0]!;
    expect([f.severity, f.expected, f.actual]).toEqual([
      'error',
      Number(wallet.balance_paise) - 1,
      Number(wallet.balance_paise),
    ]);
  });

  it('A-3 wallet reserved, credit used and credit reserved drift → C-1 errors', async () => {
    const w = await org('p77a-a3w');
    await acceptedPerMessage(w);
    await admin(`UPDATE wallets SET reserved_paise = reserved_paise + 1 WHERE org_id = $1`, [
      w.t.orgId,
    ]);
    const wid = (await admin(`SELECT id FROM wallets WHERE org_id = $1`, [w.t.orgId])).rows[0].id;
    await expectDefect(w, [`C-1:wallet_reserved:${wid}/wallet`], false);
    const c = await org('p77a-a3c', 'credit');
    await acceptedPerMessage(c);
    await admin(
      `UPDATE credit_accounts SET used_paise = used_paise + 1, reserved_paise = reserved_paise + 2 WHERE org_id = $1`,
      [c.t.orgId],
    );
    const cid = (await admin(`SELECT id FROM credit_accounts WHERE org_id = $1`, [c.t.orgId]))
      .rows[0].id;
    await expectDefect(
      c,
      [`C-1:credit_used:${cid}/credit_account`, `C-1:credit_reserved:${cid}/credit_account`],
      false,
    );
  });

  it('A-4 a terminal message whose release is missing → C-2 outstanding reservation', async () => {
    const o = await org('p77a-a4');
    const m = await acceptedPerMessage(o, 60); // reservation 60, charge 50, release 10
    await dropFact(m.id, 'reservation_release');
    const r = await expectDefect(o, [`C-2:outstanding_reservation:${m.id}`]);
    expect(r.checks[1]!.findings.find((f) => f.rule === 'outstanding_reservation')!.actual).toBe(
      10,
    );
  });

  it('A-5 wrong charge amount, a missing charge, a charge on an attempt under charge_per_logical_message → C-2', async () => {
    const o = await org('p77a-a5');
    const wrong = await acceptedPerMessage(o);
    await replica(async (c) => {
      await c.query(
        `UPDATE usage_ledger SET amount_paise = 49 WHERE anchor_id = $1 AND fact_kind = 'customer_charge'`,
        [wrong.id],
      );
    });
    const missing = await acceptedPerMessage(o);
    await dropFact(missing.id, 'customer_charge');
    const onAttempt = await acceptedPerMessage(o);
    await rawFact(
      o,
      'customer_charge',
      onAttempt.attempts[0]!,
      onAttempt.id,
      onAttempt.attempts[0]!,
      5,
    );
    await expectDefect(o, [
      `C-2:charge_mismatch:${wrong.id}`,
      `C-2:charge_mismatch:${missing.id}`,
      `C-2:unexpected_charge:${onAttempt.attempts[0]}`,
    ]);
  });

  it('A-6 a failed message with an automatic charge; an unknown message with an operator charge but no executed resolution → C-2', async () => {
    const o = await org('p77a-a6');
    const failed = await message(o, 'failed', 'charge_per_logical_message', [
      { status: 'failed', reached: true },
    ]);
    await reserve(o, failed.id, 50);
    await cost(o, failed.id, failed.attempts[0]!, 20);
    await release(o, failed.id);
    await rawFact(o, 'customer_charge', failed.id, failed.id, null, 50);
    const unknown = await message(o, 'outcome_unknown', 'charge_per_logical_message', [
      { status: 'outcome_unknown', reached: false },
    ]);
    await reserve(o, unknown.id, 50);
    await release(o, unknown.id);
    await rawFact(
      o,
      'customer_charge',
      unknown.id,
      unknown.id,
      null,
      50,
      'outcome_unknown_resolved',
    );
    await expectDefect(o, [
      `C-2:unexpected_charge:${failed.id}`,
      `C-2:unauthorised_operator_charge:${unknown.id}`,
    ]);
  });

  it('A-7 reached attempt without cost; unreached attempt with cost; cost ≠ evaluation → C-3', async () => {
    const o = await org('p77a-a7');
    const noCost = await acceptedPerMessage(o);
    await dropFact(noCost.attempts[0]!, 'provider_cost');
    const unreached = await message(o, 'failed', 'charge_per_logical_message', [
      { status: 'failed', reached: false },
    ]);
    await reserve(o, unreached.id, 50);
    await release(o, unreached.id);
    await rawFact(
      o,
      'provider_cost',
      unreached.attempts[0]!,
      unreached.id,
      unreached.attempts[0]!,
      20,
    );
    const wrong = await acceptedPerMessage(o);
    await replica(async (c) => {
      await c.query(
        `UPDATE usage_ledger SET amount_paise = 21 WHERE anchor_id = $1 AND fact_kind = 'provider_cost'`,
        [wrong.attempts[0]],
      );
    });
    await expectDefect(
      o,
      [
        `C-3:provider_cost_mismatch:${noCost.attempts[0]}`,
        `C-3:unexpected_provider_cost:${unreached.attempts[0]}`,
        `C-3:provider_cost_mismatch:${wrong.attempts[0]}`,
      ],
      false,
    );
  });

  it('A-8 non-terminal messages holding reservations: only the one older than 24 h is a C-4 warning', async () => {
    const o = await org('p77a-a8');
    const old = await message(
      o,
      'submitting',
      'charge_per_logical_message',
      [{ status: 'submitting', reached: null }],
      { createdHoursAgo: 30 },
    );
    await reserve(o, old.id, 50);
    const young = await message(o, 'queued', 'charge_per_logical_message', [], {
      createdHoursAgo: 23,
    });
    await reserve(o, young.id, 50);
    const r = await expectDefect(o, [`C-4:stale_reservation:${old.id}`], false);
    expect(r.checks[3]!.findings[0]!.severity).toBe('warning');
  });

  // --- A-9 / A-11: partitions, and every defect at once ------------------------------------

  it('A-9 an unguarded partition and an orphan table → C-5; A-11 all defects at once, no early stop', async () => {
    const target = (
      await admin(
        `SELECT partition_name FROM app_ledger_partition_report() WHERE attached ORDER BY range_start DESC LIMIT 1`,
      )
    ).rows[0].partition_name as string;
    const triggers = (
      await admin(
        `SELECT g.tgname, pg_get_triggerdef(g.oid) AS def FROM pg_trigger g WHERE g.tgrelid = $1::regclass AND NOT g.tgisinternal AND (g.tgtype & 32) <> 0`,
        [target],
      )
    ).rows as { tgname: string; def: string }[];
    expect(triggers.length).toBeGreaterThan(0);
    try {
      for (const t of triggers) await admin(`DROP TRIGGER ${t.tgname} ON ${target}`);
      await admin(`CREATE TABLE usage_ledger_p209901 (x integer)`);
      const r = await reconcile([tenants[0]!.orgId]);
      expect(findingIds(r, 'C-5').sort()).toEqual(
        [`C-5:orphan:usage_ledger_p209901`, `C-5:unprotected:${target}`].sort(),
      );

      const all = await reconcile(defects.orgs);
      const got = findingIds(all);
      for (const id of [
        ...defects.expect,
        `C-5:orphan:usage_ledger_p209901`,
        `C-5:unprotected:${target}`,
      ]) {
        expect(got).toContain(id);
      }
      // Every check ran and reported; C-6 lists unknown outcomes and never has findings.
      expect(all.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
        'C-1:findings',
        'C-2:findings',
        'C-3:findings',
        'C-4:findings',
        'C-5:findings',
        'C-6:pass',
      ]);
      expect(all).toMatchObject({ complete: true, exitCode: 1 });
      if (EVIDENCE)
        writeFileSync(join(EVIDENCE, 'a11-all-defects-report.json'), JSON.stringify(all, null, 2));
    } finally {
      await admin(`DROP TABLE IF EXISTS usage_ledger_p209901`);
      for (const t of triggers) {
        const exists = (
          await admin(`SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`, [
            target,
            t.tgname,
          ])
        ).rows.length;
        if (!exists) await admin(t.def);
      }
    }
    // Restored: C-5 is clean again.
    expect(findingIds(await reconcile([tenants[0]!.orgId]), 'C-5')).toEqual([]);
  }, 120_000);

  // --- A-12: the command ------------------------------------------------------------------------

  const cli = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
    run('npx', ['tsx', 'src/cli/billing-reconcile.ts', ...args], {
      cwd: PACKAGE_ROOT,
      env,
      timeout: 120_000,
    })
      .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }))
      .catch((e: { code?: number; stdout?: string; stderr?: string }) => ({
        code: e.code ?? -1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
      }));

  it('A-12 the command: clean exit 0 with a JSON report; invalid arguments, no database and a statement timeout exit 2', async () => {
    const ok = await cli([...clean.flatMap((o) => ['--org', o.t.orgId]), '--json', '-']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({
      reportVersion: 1,
      exitCode: 0,
      complete: true,
      transactionIdAssigned: false,
    });
    const human = await cli(clean.flatMap((o) => ['--org', o.t.orgId]));
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/read-only transaction: yes {2}transaction id assigned: no/);
    expect(human.stdout).toMatch(/exit code 0/);

    const findings = await cli(['--org', defects.orgs[0]!]);
    expect(findings.code).toBe(1);

    const bad = await cli(['--org', 'not-a-uuid']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/--org must be a UUID/);

    const noDb = await cli(['--json', '-'], {
      ...process.env,
      DATABASE_ADMIN_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
    });
    expect(noDb.code).toBe(2);
    expect(JSON.parse(noDb.stdout)).toMatchObject({ complete: false, exitCode: 2 });

    const timeout = await cli(['--statement-timeout-ms', '1', '--json', '-']);
    expect(timeout.code).toBe(2);
    expect(JSON.parse(timeout.stdout)).toMatchObject({ complete: false, exitCode: 2 });
  }, 300_000);

  // --- partition pruning (EXPLAIN evidence) ---------------------------------------------------

  it('the C-2/C-3/C-4 and C-6 ledger lookups are pruned to the anchors’ monthly partition; the C-1 plan is recorded', async () => {
    const orgs = clean.map((o) => o.t.orgId);
    const month = (await admin(`SELECT to_char(now(), 'YYYYMM') AS m`)).rows[0].m as string;
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const explain = async (name: string, text: string, params: unknown[]) => {
        const plan = (await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params)).rows[0][
          'QUERY PLAN'
        ];
        if (EVIDENCE)
          writeFileSync(join(EVIDENCE, `explain-${name}.json`), JSON.stringify(plan, null, 2));
        const nodes: { name: string; loops: number; type: string }[] = [];
        let removed = 0;
        const walk = (n: Record<string, unknown>) => {
          const rel = n['Relation Name'];
          if (typeof rel === 'string' && /^usage_ledger_p\d{6}$/.test(rel)) {
            nodes.push({
              name: rel,
              loops: Number(n['Actual Loops'] ?? 0),
              type: String(n['Node Type']),
            });
          }
          if (typeof n['Subplans Removed'] === 'number') removed += n['Subplans Removed'];
          for (const child of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
        };
        walk(plan[0].Plan);
        return { nodes, removed };
      };
      for (const [name, text] of [
        ['c2-c3-c4-message-anchors', SQL_MESSAGE_ANCHORS],
        ['c6-register', SQL_C6_REGISTER],
      ] as const) {
        const { nodes, removed } = await explain(name, text, [orgs, null]);
        const executed = [...new Set(nodes.filter((n) => n.loops > 0).map((n) => n.name))];
        expect([name, executed]).toEqual([name, [`usage_ledger_p${month}`]]);
        expect(removed + nodes.filter((n) => n.loops === 0).length).toBeGreaterThanOrEqual(24);
      }
      // C-1 cannot prune by month (a balance needs full history); its plan is recorded as evidence.
      const c1 = await explain('c1-wallets', SQL_C1_WALLETS, [orgs]);
      expect(c1.nodes.length).toBeGreaterThanOrEqual(25);
      await c.query('COMMIT');
    } catch (error) {
      // Never hand the pooled connection back inside the READ ONLY transaction.
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }, 120_000);
});
