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
 * Phase 7 PR 7-4 — funds reservation at submission (migration `0053`;
 * DECISIONS.md §1zi.7; handover §§11, 12, 14.5).
 *
 *   1. Privileges: `app_message_reserve` is the only billing function the
 *      application role may execute; the 7.1 writer and the 7.2 rating functions
 *      remain executable by no application role, and 0053 does not touch them.
 *   2. The six new `messages` columns: shape constraints and immutability.
 *   3. The entry point's caller check and its refusals, before any money is read.
 *   4. A reservation is derived entirely from database state, posted once, and
 *      a repeated call changes nothing.
 *
 * The HTTP behaviour (atomicity with the submission, error mapping, idempotency,
 * concurrency) is in `apps/api/test/phase7_4-reservation.int-spec.ts`.
 */

const PACKAGE_ROOT = resolve(__dirname, '../..');
const MIGRATION = readFileSync(
  join(PACKAGE_ROOT, 'migrations/0053_phase7_4_funds_reservation.sql'),
  'utf8',
);
const APP_ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch', 'acc_delivery'] as const;
const RESERVE = 'app_message_reserve(uuid)';
const WRITER =
  'app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text)';
const RATE = 'app_rate_message(uuid, uuid, uuid, integer, boolean, boolean)';
const LOOKUP =
  'app_price_lookup(uuid, uuid, uuid, integer, timestamp with time zone, boolean, boolean)';

describe('Phase 7 PR 7-4 — funds reservation (migration 0053)', () => {
  let db: Principals;
  let A: TenantFixture;
  let B: TenantFixture;
  let waId: string;
  let smsId: string;
  let providerId: string;
  const contact: Record<string, string> = {};
  const plans: string[] = [];

  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  /** Runs one statement under a savepoint; returns the SQLSTATE, or 'OK'. */
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

  /** One owner transaction, always rolled back. */
  async function ownerTx<R>(work: (c: PoolClient) => Promise<R>): Promise<R> {
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  /**
   * One application-role transaction under a tenant context (the API-key arm of
   * `app_content_context_valid`); rolled back unless `commit`.
   */
  async function appTx<R>(
    context: { org?: string; apiKey?: string } | null,
    work: (c: PoolClient) => Promise<R>,
    commit = false,
  ): Promise<R> {
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      if (context?.org)
        await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [context.org]);
      if (context?.apiKey)
        await c.query(`SELECT set_config('app.current_api_key_id', $1, true)`, [context.apiKey]);
      const result = await work(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }
  const ctx = (t: TenantFixture) => ({ org: t.orgId, apiKey: t.apiKeyId });

  interface Planted {
    channel?: string;
    units?: number | null;
    unit?: 'message' | 'sms_segment' | null;
    encoding?: string | null;
    enforced?: boolean;
    mode?: 'prepaid' | 'postpaid' | null;
    policy?: 'charge_per_logical_message' | 'charge_per_attempt' | null;
  }
  /** A message planted (committed) by the owner, as the core would insert it. */
  async function plant(t: TenantFixture, o: Planted = {}): Promise<string> {
    const id = uuidv7();
    const enforced = o.enforced ?? true;
    await admin(
      `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address,
                             correlation_id, billable_units, billable_unit, sms_encoding, billing_enforced,
                             billing_mode_snapshot, billing_policy_snapshot)
       VALUES ($1, $2, $3, $4, $5, 'queued', '+12025550188', $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        t.orgId,
        t.workspaceId,
        contact[t.orgId],
        o.channel ?? waId,
        `p74-${id}`,
        o.units === undefined ? 1 : o.units,
        o.unit === undefined ? 'message' : o.unit,
        o.encoding ?? null,
        enforced,
        o.mode === undefined ? (enforced ? 'prepaid' : null) : o.mode,
        o.policy === undefined ? (enforced ? 'charge_per_logical_message' : null) : o.policy,
      ],
    );
    return id;
  }

  const reserve = (c: PoolClient, messageId: string) =>
    c.query(
      `SELECT reserved_paise::text AS reserved_paise, inserted, evaluation_id FROM app_message_reserve($1)`,
      [messageId],
    );

  beforeAll(async () => {
    db = connect();
    A = await createTenant(db.admin, 'p74-a');
    B = await createTenant(db.admin, 'p74-b');
    waId = (await admin(`SELECT id FROM channels WHERE code = 'whatsapp'`)).rows[0].id;
    smsId = (await admin(`SELECT id FROM channels WHERE code = 'sms'`)).rows[0].id;
    providerId = (
      await admin(
        `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
        [waId, `p74-provider-${uuidv7().slice(-8)}`],
      )
    ).rows[0].id;
    for (const t of [A, B]) {
      await admin(
        `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority) VALUES ($1, $2, $3, 1)`,
        [t.orgId, providerId, waId],
      );
      contact[t.orgId] = uuidv7();
      await admin(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
        contact[t.orgId],
        t.orgId,
        t.workspaceId,
      ]);
    }
    // A: a WhatsApp rate card at 50 paise per message, a funded wallet.
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      const planId = (
        await c.query(`INSERT INTO pricing_plans (name) VALUES ($1) RETURNING id`, [
          `p74-${uuidv7()}`,
        ])
      ).rows[0].id as string;
      plans.push(planId);
      const versionId = (
        await c.query(
          `INSERT INTO pricing_plan_versions (plan_id, version_number) VALUES ($1, 1) RETURNING id`,
          [planId],
        )
      ).rows[0].id as string;
      await c.query(
        `INSERT INTO pricing_rules (plan_version_id, channel_id, unit_price_e4) VALUES ($1, $2, 500000)`,
        [versionId, waId],
      );
      await c.query(
        `UPDATE pricing_plan_versions SET status = 'active', effective_from = now() WHERE id = $1`,
        [versionId],
      );
      await c.query(
        `INSERT INTO customer_pricing_assignments (org_id, plan_id, effective_from) VALUES ($1, $2, now())`,
        [A.orgId, planId],
      );
      await c.query(`INSERT INTO wallets (org_id, balance_paise) VALUES ($1, 1000)`, [A.orgId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    const orgIds = [A?.orgId, B?.orgId].filter(Boolean) as string[];
    if (orgIds.length > 0) {
      // Ledger rows, evaluations, accounts and pricing assignments are undeletable by
      // design; the owner removes this suite's fixtures with triggers suspended for this
      // one transaction only (as the 7.1 suite does).
      const c = await db.adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(`DELETE FROM usage_ledger WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query(
          `DELETE FROM pricing_evaluation_components WHERE evaluation_id IN
             (SELECT id FROM pricing_evaluations WHERE org_id = ANY($1::uuid[]))`,
          [orgIds],
        );
        await c.query(`DELETE FROM pricing_evaluations WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query(`DELETE FROM customer_pricing_assignments WHERE org_id = ANY($1::uuid[])`, [
          orgIds,
        ]);
        await c.query(`DELETE FROM wallets WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query(`DELETE FROM credit_accounts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query(`DELETE FROM messages WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
      await admin(`DELETE FROM contacts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(`DELETE FROM organization_provider_assignments WHERE org_id = ANY($1::uuid[])`, [
        orgIds,
      ]);
    }
    if (providerId) await admin(`DELETE FROM providers WHERE id = $1`, [providerId]);
    if (A) await destroyTenant(db.admin, A);
    if (B) await destroyTenant(db.admin, B);
    await db.close();
  }, 120_000);

  // ---------------------------------------------------------------------------
  describe('1. privileges', () => {
    it('app_message_reserve is executable by acc_app only (and the owner), never PUBLIC', async () => {
      const { rows } = await admin(
        `SELECT r AS role, has_function_privilege(r, $1, 'EXECUTE') AS can
           FROM unnest($2::text[]) AS r`,
        [RESERVE, APP_ROLES],
      );
      expect(Object.fromEntries(rows.map((r) => [r.role, r.can]))).toEqual({
        acc_app: true,
        acc_auth: false,
        acc_relay: false,
        acc_dispatch: false,
        acc_delivery: false,
      });
      const pub = await admin(
        `SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
          WHERE p.oid = $1::regprocedure AND a.grantee = 0`,
        [RESERVE],
      );
      expect(pub.rows).toEqual([]);
    });

    it('the 7.1 writer and the 7.2 rating functions stay executable by no application role', async () => {
      const { rows } = await admin(
        `SELECT f, r, has_function_privilege(r, f, 'EXECUTE') AS can
           FROM unnest($1::text[]) AS f, unnest($2::text[]) AS r`,
        [[WRITER, RATE, LOOKUP], APP_ROLES],
      );
      expect(rows.filter((r) => r.can)).toEqual([]);
    });

    it('0053 neither redefines nor grants a 7.1 or 7.2 function, nor any financial table', () => {
      const code = MIGRATION.replace(/--[^\n]*/g, '');
      expect(code).not.toMatch(/FUNCTION\s+(app_ledger_post|app_rate_message|app_price_lookup)\b/i);
      expect(code).not.toMatch(
        /\bON\s+(TABLE\s+)?(usage_ledger|wallets|credit_accounts|pricing_\w+)\b/i,
      );
      expect([...code.matchAll(/\bGRANT\b[^;]*;/gi)].map((m) => m[0])).toEqual([
        'GRANT EXECUTE ON FUNCTION app_message_reserve(uuid) TO acc_app;',
      ]);
    });

    it('is SECURITY DEFINER with a pinned search_path, and VOLATILE', async () => {
      const { rows } = await admin(
        `SELECT prosecdef, proconfig, provolatile FROM pg_proc WHERE oid = $1::regprocedure`,
        [RESERVE],
      );
      expect(rows[0]).toEqual({
        prosecdef: true,
        proconfig: ['search_path=public, pg_temp'],
        provolatile: 'v',
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('2. messages columns', () => {
    it('pre-existing rows carry no units and billing_enforced = false', async () => {
      const { rows } = await admin(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'messages' AND column_name = ANY($1::text[]) ORDER BY column_name`,
        [
          [
            'billable_unit',
            'billable_units',
            'billing_enforced',
            'billing_mode_snapshot',
            'billing_policy_snapshot',
            'sms_encoding',
          ],
        ],
      );
      expect(rows).toEqual([
        { column_name: 'billable_unit', is_nullable: 'YES', column_default: null },
        { column_name: 'billable_units', is_nullable: 'YES', column_default: null },
        { column_name: 'billing_enforced', is_nullable: 'NO', column_default: 'false' },
        { column_name: 'billing_mode_snapshot', is_nullable: 'YES', column_default: null },
        { column_name: 'billing_policy_snapshot', is_nullable: 'YES', column_default: null },
        { column_name: 'sms_encoding', is_nullable: 'YES', column_default: null },
      ]);
    });

    it.each<[string, Planted]>([
      ['an enforced message without a snapshot', { mode: null, policy: null }],
      ['a snapshot without enforcement', { enforced: false, mode: 'prepaid', policy: null }],
      ['an enforced message without units', { units: null, unit: null }],
      ['units without a unit', { unit: null }],
      ['two units of a per-message channel', { units: 2 }],
      ['zero units', { units: 0 }],
      ['an SMS encoding on a per-message unit', { encoding: 'GSM-7' }],
      ['an SMS segment unit without its encoding', { channel: 'sms', unit: 'sms_segment' }],
      ['an unknown encoding', { channel: 'sms', unit: 'sms_segment', encoding: 'UTF-8' }],
    ])('refuses %s (23514)', async (_label, o) => {
      await ownerTx(async (c) => {
        const id = uuidv7();
        const enforced = o.enforced ?? true;
        expect(
          await code(
            c,
            `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address,
                                   correlation_id, billable_units, billable_unit, sms_encoding, billing_enforced,
                                   billing_mode_snapshot, billing_policy_snapshot)
             VALUES ($1, $2, $3, $4, $5, 'queued', '+12025550188', 'c', $6, $7, $8, $9, $10, $11)`,
            [
              id,
              A.orgId,
              A.workspaceId,
              contact[A.orgId],
              o.channel === 'sms' ? smsId : waId,
              o.units === undefined ? 1 : o.units,
              o.unit === undefined ? 'message' : o.unit,
              o.encoding ?? null,
              enforced,
              o.mode === undefined ? 'prepaid' : o.mode,
              o.policy === undefined ? 'charge_per_logical_message' : o.policy,
            ],
          ),
        ).toBe('23514');
      });
    });

    it.each([
      ['billable_units', '1'],
      ['billable_unit', `'sms_segment'`],
      ['sms_encoding', `'UCS-2'`],
      ['billing_enforced', 'false'],
      ['billing_mode_snapshot', `'postpaid'`],
      ['billing_policy_snapshot', `'charge_per_attempt'`],
    ])('%s is immutable after insert, for every principal (42501)', async (column, value) => {
      const id = await plant(
        A,
        column === 'billable_units'
          ? { channel: smsId, units: 2, unit: 'sms_segment', encoding: 'GSM-7' }
          : {},
      );
      await ownerTx(async (c) => {
        expect(await code(c, `UPDATE messages SET ${column} = ${value} WHERE id = $1`, [id])).toBe(
          '42501',
        );
        // The dispatcher's and the API's own updates are unaffected.
        expect(await code(c, `UPDATE messages SET status = 'routing' WHERE id = $1`, [id])).toBe(
          'OK',
        );
      });
      await appTx(ctx(A), async (c) => {
        expect(await code(c, `UPDATE messages SET ${column} = ${value} WHERE id = $1`, [id])).toBe(
          '42501',
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('3. caller check and refusals (before any money is read)', () => {
    it('refuses without a tenant content context (42501)', async () => {
      const id = await plant(A);
      await appTx(null, async (c) =>
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [id])).toBe('42501'),
      );
      await appTx({ org: A.orgId }, async (c) =>
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [id])).toBe('42501'),
      );
    });

    it("refuses another organization's message, indistinguishably from a missing one (42501)", async () => {
      const id = await plant(A);
      await appTx(ctx(B), async (c) => {
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [id])).toBe('42501');
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [uuidv7()])).toBe('42501');
      });
    });

    it('refuses a message not submitted under enforcement, and units that contradict the channel (22023)', async () => {
      const plain = await plant(A, { enforced: false });
      const wrongUnit = await plant(A, { channel: smsId, unit: 'message', units: 1 });
      await appTx(ctx(A), async (c) => {
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [plain])).toBe('22023');
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [wrongUnit])).toBe('22023');
        expect(await code(c, `SELECT * FROM app_message_reserve(NULL)`)).toBe('22023');
      });
    });

    it('refuses a snapshot that is no longer the organization’s billing settings (40001)', async () => {
      const postpaid = await plant(A, { mode: 'postpaid' });
      const perAttempt = await plant(A, { policy: 'charge_per_attempt' });
      await appTx(ctx(A), async (c) => {
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [postpaid])).toBe('40001');
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [perAttempt])).toBe('40001');
      });
    });

    it('fails closed on missing pricing (BL007), before the account is read', async () => {
      const unpriced = await plant(B);
      await appTx(ctx(B), async (c) =>
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [unpriced])).toBe('BL007'),
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('4. reservation from database state', () => {
    it('reserves the rated price on the wallet, once; a repeat changes nothing', async () => {
      const id = await plant(A);
      const before = (
        await admin(
          `SELECT reserved_paise::int AS r, balance_paise::int AS b FROM wallets WHERE org_id = $1`,
          [A.orgId],
        )
      ).rows[0];
      const first = await appTx(ctx(A), async (c) => (await reserve(c, id)).rows[0], true);
      expect(first).toMatchObject({ reserved_paise: '50', inserted: true });
      expect(first.evaluation_id).toEqual(expect.any(String));
      const again = await appTx(ctx(A), async (c) => (await reserve(c, id)).rows[0], true);
      expect(again).toEqual({ ...first, inserted: false });

      const after = (
        await admin(
          `SELECT reserved_paise::int AS r, balance_paise::int AS b FROM wallets WHERE org_id = $1`,
          [A.orgId],
        )
      ).rows[0];
      expect(after).toEqual({ r: before.r + 50, b: before.b });
      const ledger = await admin(
        `SELECT entry_type, fact_kind, anchor_id, message_id, message_attempt_id, amount_paise::int AS amount,
                wallet_id IS NOT NULL AS wallet, credit_account_id IS NULL AS no_credit, correlation_id
           FROM usage_ledger WHERE message_id = $1`,
        [id],
      );
      expect(ledger.rows).toEqual([
        {
          entry_type: 'reservation',
          fact_kind: 'reservation',
          anchor_id: id,
          message_id: id,
          message_attempt_id: null,
          amount: 50,
          wallet: true,
          no_credit: true,
          correlation_id: `p74-${id}`,
        },
      ]);
      const evaluation = await admin(
        `SELECT subject, units, unit, total_customer_price_paise::int AS price, total_provider_cost_paise
           FROM pricing_evaluations WHERE message_id = $1`,
        [id],
      );
      expect(evaluation.rows).toEqual([
        {
          subject: 'message',
          units: 1,
          unit: 'message',
          price: 50,
          total_provider_cost_paise: null,
        },
      ]);
    });

    it('refuses insufficient funds (BL003) and leaves nothing behind', async () => {
      const { r, b } = (
        await admin(
          `SELECT reserved_paise::int AS r, balance_paise::int AS b FROM wallets WHERE org_id = $1`,
          [A.orgId],
        )
      ).rows[0];
      const room = b - r;
      // Fill the wallet to exactly the price, then one paisa short.
      const ids = Array.from({ length: Math.floor(room / 50) }, () => '');
      for (let i = 0; i < ids.length; i += 1) ids[i] = await plant(A);
      for (const id of ids) {
        await appTx(
          ctx(A),
          async (c) => expect((await reserve(c, id)).rows[0].inserted).toBe(true),
          true,
        );
      }
      const last = await plant(A);
      await appTx(ctx(A), async (c) =>
        expect(await code(c, `SELECT * FROM app_message_reserve($1)`, [last])).toBe('BL003'),
      );
      expect(
        (await admin(`SELECT count(*)::int AS n FROM usage_ledger WHERE message_id = $1`, [last]))
          .rows[0].n,
      ).toBe(0);
      expect(
        (
          await admin(
            `SELECT balance_paise::int - reserved_paise::int AS free FROM wallets WHERE org_id = $1`,
            [A.orgId],
          )
        ).rows[0].free,
      ).toBe(room % 50);
    });
  });
});
