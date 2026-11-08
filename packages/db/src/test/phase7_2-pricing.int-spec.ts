import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import {
  connect,
  createTenant,
  destroyTenant,
  loadTestEnv,
  plantPlatformAdmin,
  removeIdentities,
  type Principals,
  type TenantFixture,
} from './harness';

/**
 * Phase 7 PR 7-2 — migration 0051, pricing and rating (DECISIONS.md §1zi; Phase 7.2 handover,
 * owner-approved 08-Nov-2026 with OD-P-1, OD-P-2, OD-P-3).
 *
 * The owner's nine financial rules, each proved here: integer 1/10,000-paisa rates; integer
 * arithmetic; half-up rounding once per component per rated transaction; no per-segment or
 * aggregate rounding; zero results recorded; SMS segments vs one WhatsApp/RCS unit; provider
 * cost only from provider_cost_rates; provider rule beats channel default and missing rates
 * fail closed; evaluations immutable and never re-rated. Plus: effective dating and no
 * backdating, idempotency and concurrency, privileges and RLS, invariant D, and Phase 7.1
 * untouched.
 *
 * Almost every case runs in an owner transaction that is always rolled back. The concurrency
 * case commits; afterAll removes its rows in one owner transaction with triggers suspended,
 * because pricing records are otherwise undeletable by design.
 */

const APP_ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch', 'acc_delivery'] as const;
const LOOKUP = 'app_price_lookup(uuid, uuid, uuid, integer, timestamptz, boolean, boolean)';
const RATE = 'app_rate_message(uuid, uuid, uuid, integer, boolean, boolean)';

describe('Phase 7 PR 7-2 — pricing and rating (migration 0051)', () => {
  let db: Principals;
  let A: TenantFixture;
  let B: TenantFixture;
  let sms: string;
  let wa: string;
  let email: string | undefined;
  let p1: string; // sms provider
  let p2: string; // sms provider
  let pw: string; // whatsapp provider
  let platformUser: string;
  const contact: Record<string, string> = {};
  const committed: { plans: string[]; messages: string[] } = { plans: [], messages: [] };

  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  async function tx<R>(work: (c: PoolClient) => Promise<R>): Promise<R> {
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

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

  /** A plan with one active version (rules given), effective now. */
  async function plan(
    c: PoolClient,
    rules: Array<{ channel: string; provider?: string | null; price: number }>,
    effective = 'now()',
  ) {
    const planId = (
      await c.query(`INSERT INTO pricing_plans (name) VALUES ($1) RETURNING id`, [
        `p72-${uuidv7()}`,
      ])
    ).rows[0].id as string;
    const versionId = await version(c, planId, 1, rules);
    await c.query(
      `UPDATE pricing_plan_versions SET status = 'active', effective_from = ${effective} WHERE id = $1`,
      [versionId],
    );
    return { planId, versionId };
  }
  async function version(
    c: PoolClient,
    planId: string,
    n: number,
    rules: Array<{ channel: string; provider?: string | null; price: number }>,
  ) {
    const versionId = (
      await c.query(
        `INSERT INTO pricing_plan_versions (plan_id, version_number) VALUES ($1, $2) RETURNING id`,
        [planId, n],
      )
    ).rows[0].id as string;
    for (const r of rules) {
      await c.query(
        `INSERT INTO pricing_rules (plan_version_id, channel_id, provider_id, unit_price_e4) VALUES ($1, $2, $3, $4)`,
        [versionId, r.channel, r.provider ?? null, r.price],
      );
    }
    return versionId;
  }
  const assign = (c: PoolClient, org: string | null, planId: string, effective = 'now()') =>
    c.query(
      `INSERT INTO customer_pricing_assignments (org_id, plan_id, effective_from) VALUES ($1, $2, ${effective})`,
      [org, planId],
    );
  const costRate = (
    c: PoolClient,
    provider: string,
    channel: string,
    cost: number,
    effective = 'now()',
  ) =>
    c.query(
      `INSERT INTO provider_cost_rates (provider_id, channel_id, unit_cost_e4, effective_from) VALUES ($1, $2, $3, ${effective})`,
      [provider, channel, cost],
    );
  async function lookup(
    c: PoolClient,
    o: {
      org: string;
      channel: string;
      provider?: string | null;
      units: number;
      at?: string;
      customer?: boolean;
      cost?: boolean;
    },
  ) {
    const { rows } = await c.query(
      `SELECT unit, plan_version_id, pricing_rule_id, unit_price_e4::text, customer_exact_e4::text,
              customer_price_paise::text, provider_cost_rate_id, unit_cost_e4::text,
              cost_exact_e4::text, provider_cost_paise::text
         FROM app_price_lookup($1, $2, $3, $4, ${o.at ?? 'now()'}, $5, $6)`,
      [o.org, o.channel, o.provider ?? null, o.units, o.customer ?? true, o.cost ?? false],
    );
    return rows[0];
  }
  const lookupCode = (c: PoolClient, o: Parameters<typeof lookup>[1]) =>
    code(c, `SELECT * FROM app_price_lookup($1, $2, $3, $4, ${o.at ?? 'now()'}, $5, $6)`, [
      o.org,
      o.channel,
      o.provider ?? null,
      o.units,
      o.customer ?? true,
      o.cost ?? false,
    ]);
  async function plant(c: PoolClient, t: TenantFixture, channel: string, provider?: string) {
    const messageId = uuidv7();
    await c.query(
      `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id)
       VALUES ($1, $2, $3, $4, $5, 'accepted', '+12025550199', $6)`,
      [messageId, t.orgId, t.workspaceId, contact[t.orgId], channel, uuidv7()],
    );
    let attemptId: string | null = null;
    if (provider) {
      attemptId = uuidv7();
      await c.query(
        `INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number, fencing_epoch, claim_token, status)
         VALUES ($1, $2, $3, $4, $5, 1, 1, $6, 'accepted')`,
        [attemptId, messageId, t.orgId, provider, channel, uuidv7()],
      );
    }
    return { messageId, attemptId };
  }
  const rate = (
    c: PoolClient,
    org: string,
    message: string,
    attempt: string | null,
    units: number,
    customer = true,
    cost = false,
  ) =>
    c.query(
      `SELECT evaluation_id, inserted, total_customer_price_paise::text AS customer, total_provider_cost_paise::text AS cost
         FROM app_rate_message($1, $2, $3, $4, $5, $6)`,
      [org, message, attempt, units, customer, cost],
    );

  beforeAll(async () => {
    loadTestEnv();
    db = connect();
    A = await createTenant(db.admin, 'p72-a');
    B = await createTenant(db.admin, 'p72-b');
    const ch = async (codeName: string) =>
      (await admin(`SELECT id FROM channels WHERE code = $1`, [codeName])).rows[0]?.id as
        string | undefined;
    sms = (await ch('sms'))!;
    wa = (await ch('whatsapp'))!;
    email = await ch('email');
    const mk = async (channel: string, name: string) =>
      (
        await admin(
          `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
          [channel, `${name}-${uuidv7().slice(-8)}`],
        )
      ).rows[0].id as string;
    p1 = await mk(sms, 'p72-sms-1');
    p2 = await mk(sms, 'p72-sms-2');
    pw = await mk(wa, 'p72-wa');
    for (const t of [A, B]) {
      // Attempts need an organization provider assignment (message_attempts_assignment_fk).
      for (const [p, ch2] of [
        [p1, sms],
        [p2, sms],
        [pw, wa],
      ] as const) {
        await admin(
          `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority)
           VALUES ($1, $2, $3, (SELECT coalesce(max(priority), 0) + 1 FROM organization_provider_assignments WHERE org_id = $1))`,
          [t.orgId, p, ch2],
        );
      }
      contact[t.orgId] = uuidv7();
      await admin(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
        contact[t.orgId],
        t.orgId,
        t.workspaceId,
      ]);
    }
    platformUser = await plantPlatformAdmin(db.admin, 'p72-platform');
  }, 120_000);

  afterAll(async () => {
    const orgIds = [A?.orgId, B?.orgId].filter(Boolean) as string[];
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(
        `DELETE FROM pricing_evaluation_components WHERE evaluation_id IN (SELECT id FROM pricing_evaluations WHERE org_id = ANY($1::uuid[]))`,
        [orgIds],
      );
      await c.query(`DELETE FROM pricing_evaluations WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await c.query(`DELETE FROM customer_pricing_assignments WHERE plan_id = ANY($1::uuid[])`, [
        committed.plans,
      ]);
      await c.query(
        `DELETE FROM pricing_rules WHERE plan_version_id IN (SELECT id FROM pricing_plan_versions WHERE plan_id = ANY($1::uuid[]))`,
        [committed.plans],
      );
      await c.query(`DELETE FROM pricing_plan_versions WHERE plan_id = ANY($1::uuid[])`, [
        committed.plans,
      ]);
      await c.query(`DELETE FROM pricing_plans WHERE id = ANY($1::uuid[])`, [committed.plans]);
      await c.query(`DELETE FROM provider_cost_rates WHERE provider_id = ANY($1::uuid[])`, [
        [p1, p2, pw],
      ]);
      await c.query(`DELETE FROM message_attempts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
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
    for (const p of [p1, p2, pw]) if (p) await admin(`DELETE FROM providers WHERE id = $1`, [p]);
    await removeIdentities(db.admin, [platformUser].filter(Boolean));
    if (A) await destroyTenant(db.admin, A);
    if (B) await destroyTenant(db.admin, B);
    await db.close();
  }, 120_000);

  // ---------------------------------------------------------------------------
  describe('rules 1–4: integer rates, integer arithmetic, half-up once per component', () => {
    it.each([
      // [units, price e4, exact, paise]
      [1, 0, '0', '0'],
      [1, 4999, '4999', '0'],
      [1, 5000, '5000', '1'],
      [1, 14999, '14999', '1'],
      [1, 15000, '15000', '2'],
      [1, 1150000, '1150000', '115'], // ₹1.15
      // Three SMS segments at 0.3333 paisa: 0.9999 paisa rounds to 1 (per-segment rounding would give 0).
      [3, 3333, '9999', '1'],
      [7, 2143, '15001', '2'],
      [1000000, 1000000000000, '1000000000000000000', '100000000000000'],
    ])('%d unit(s) × %d e4 → exact %s → %s paise', async (units, price, exact, paise) => {
      await tx(async (c) => {
        const { planId } = await plan(c, [{ channel: sms, price }]);
        await assign(c, A.orgId, planId);
        const r = await lookup(c, { org: A.orgId, channel: sms, units });
        expect([r.unit, r.customer_exact_e4, r.customer_price_paise]).toEqual([
          'sms_segment',
          exact,
          paise,
        ]);
      });
    });

    it('a component row whose paise is not exactly half-up of its exact amount is refused', async () => {
      await tx(async (c) => {
        const { versionId } = await plan(c, [{ channel: sms, price: 5000 }]);
        await costRate(c, p1, sms, 5000);
        const m = await plant(c, A, sms, p1);
        // An attempt evaluation carrying the provider cost only, so a customer component may be probed.
        const ev = (await rate(c, A.orgId, m.messageId, m.attemptId, 1, false, true)).rows[0]
          .evaluation_id;
        const rule = (
          await c.query(`SELECT id FROM pricing_rules WHERE plan_version_id = $1`, [versionId])
        ).rows[0].id;
        const probe = (exact: number, paise: number) =>
          code(
            c,
            `INSERT INTO pricing_evaluation_components (evaluation_id, component, pricing_rule_id, quantity, unit, unit_rate_e4, amount_exact_e4, amount_paise)
             VALUES ($1, 'customer_price', $2, 1, 'sms_segment', 5000, $3, $4)`,
            [ev, rule, exact, paise],
          );
        expect(await probe(5000, 0)).toBe('23514'); // half rounded down: refused
        expect(await probe(5001, 1)).toBe('23514'); // exact ≠ quantity × rate: refused
        expect(await probe(5000, 1)).toBe('OK');
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('rules 5–8: zero results, units, provider cost source, precedence, fail closed', () => {
    it('rule 5: a zero-paise result is recorded on the evaluation', async () => {
      await tx(async (c) => {
        const { planId } = await plan(c, [{ channel: sms, price: 4999 }]);
        await assign(c, A.orgId, planId);
        const m = await plant(c, A, sms);
        const r = (await rate(c, A.orgId, m.messageId, null, 1)).rows[0];
        expect([r.inserted, r.customer]).toEqual([true, '0']);
        const comp = (
          await c.query(
            `SELECT amount_exact_e4::text, amount_paise::text FROM pricing_evaluation_components WHERE evaluation_id = $1`,
            [r.evaluation_id],
          )
        ).rows;
        expect(comp).toEqual([{ amount_exact_e4: '4999', amount_paise: '0' }]);
      });
    });

    it('rule 6: SMS takes the segment count; WhatsApp exactly one unit; unpriced channels are refused', async () => {
      await tx(async (c) => {
        const { planId } = await plan(c, [
          { channel: sms, price: 10000 },
          { channel: wa, price: 80000 },
        ]);
        await assign(c, A.orgId, planId);
        expect(
          (await lookup(c, { org: A.orgId, channel: sms, units: 4 })).customer_price_paise,
        ).toBe('4');
        const w = await lookup(c, { org: A.orgId, channel: wa, units: 1 });
        expect([w.unit, w.customer_price_paise]).toEqual(['message', '8']);
        expect(await lookupCode(c, { org: A.orgId, channel: wa, units: 2 })).toBe('22023');
        if (email)
          expect(await lookupCode(c, { org: A.orgId, channel: email, units: 1 })).toBe('22023');
        expect(await lookupCode(c, { org: A.orgId, channel: sms, units: 0 })).toBe('22023');
      });
    });

    it('rule 7: provider cost comes only from provider_cost_rates; a missing rate fails closed (BL008)', async () => {
      await tx(async (c) => {
        expect(
          await lookupCode(c, {
            org: A.orgId,
            channel: sms,
            provider: p1,
            units: 1,
            customer: false,
            cost: true,
          }),
        ).toBe('BL008');
        await costRate(c, p1, sms, 2500);
        const r = await lookup(c, {
          org: A.orgId,
          channel: sms,
          provider: p1,
          units: 3,
          customer: false,
          cost: true,
        });
        expect([r.unit_cost_e4, r.cost_exact_e4, r.provider_cost_paise]).toEqual([
          '2500',
          '7500',
          '1',
        ]);
        expect(
          await lookupCode(c, {
            org: A.orgId,
            channel: sms,
            units: 1,
            customer: false,
            cost: true,
          }),
        ).toBe('22023'); // no provider
        expect(
          await lookupCode(c, {
            org: A.orgId,
            channel: wa,
            provider: p1,
            units: 1,
            customer: false,
            cost: true,
          }),
        ).toBe('22023'); // provider not on channel
      });
    });

    it('rule 8: a provider rule beats the channel default; organization beats platform default; missing rates fail closed (BL007)', async () => {
      await tx(async (c) => {
        expect(await lookupCode(c, { org: A.orgId, channel: sms, units: 1 })).toBe('BL007'); // no assignment
        const platform = await plan(c, [{ channel: sms, price: 10000 }]);
        await assign(c, null, platform.planId);
        expect(
          (await lookup(c, { org: A.orgId, channel: sms, units: 1 })).customer_price_paise,
        ).toBe('1');
        const orgPlan = await plan(c, [
          { channel: sms, price: 20000 },
          { channel: sms, provider: p1, price: 30000 },
        ]);
        await assign(c, A.orgId, orgPlan.planId);
        expect(
          (await lookup(c, { org: A.orgId, channel: sms, units: 1 })).customer_price_paise,
        ).toBe('2'); // channel default
        expect(
          (await lookup(c, { org: A.orgId, channel: sms, provider: p1, units: 1 }))
            .customer_price_paise,
        ).toBe('3'); // provider rule
        expect(
          (await lookup(c, { org: A.orgId, channel: sms, provider: p2, units: 1 }))
            .customer_price_paise,
        ).toBe('2'); // falls back
        expect(
          (await lookup(c, { org: B.orgId, channel: sms, units: 1 })).customer_price_paise,
        ).toBe('1'); // B: platform default
        expect(await lookupCode(c, { org: A.orgId, channel: wa, units: 1 })).toBe('BL007'); // no rule for the channel
        // An assigned plan with no version in force fails closed rather than falling back.
        const empty = (
          await c.query(`INSERT INTO pricing_plans (name) VALUES ($1) RETURNING id`, [
            `p72-empty-${uuidv7()}`,
          ])
        ).rows[0].id;
        await assign(c, B.orgId, empty);
        expect(await lookupCode(c, { org: B.orgId, channel: sms, units: 1 })).toBe('BL007');
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('effective dating, versioning and no backdating', () => {
    it('future versions and assignments apply from their effective time (inclusive), not before', async () => {
      await tx(async (c) => {
        const { planId } = await plan(c, [{ channel: sms, price: 10000 }]);
        await assign(c, null, planId);
        const v2 = await version(c, planId, 2, [{ channel: sms, price: 50000 }]);
        await c.query(
          `UPDATE pricing_plan_versions SET status = 'active', effective_from = now() + interval '1 day' WHERE id = $1`,
          [v2],
        );
        const orgPlan = await plan(c, [{ channel: sms, price: 90000 }]);
        await assign(c, A.orgId, orgPlan.planId, `now() + interval '2 days'`);
        expect(
          (await lookup(c, { org: A.orgId, channel: sms, units: 1 })).customer_price_paise,
        ).toBe('1');
        expect(
          (
            await lookup(c, {
              org: A.orgId,
              channel: sms,
              units: 1,
              at: `now() + interval '1 day' - interval '1 microsecond'`,
            })
          ).customer_price_paise,
        ).toBe('1');
        expect(
          (
            await lookup(c, {
              org: A.orgId,
              channel: sms,
              units: 1,
              at: `now() + interval '1 day'`,
            })
          ).customer_price_paise,
        ).toBe('5');
        expect(
          (
            await lookup(c, {
              org: A.orgId,
              channel: sms,
              units: 1,
              at: `now() + interval '2 days'`,
            })
          ).customer_price_paise,
        ).toBe('9');
      });
    });

    it('activation, cost rates and assignments are never backdated; created_at is the database clock', async () => {
      await tx(async (c) => {
        const planId = (
          await c.query(`INSERT INTO pricing_plans (name) VALUES ($1) RETURNING id`, [
            `p72-${uuidv7()}`,
          ])
        ).rows[0].id;
        const v = await version(c, planId, 1, [{ channel: sms, price: 1 }]);
        expect(
          await code(
            c,
            `UPDATE pricing_plan_versions SET status = 'active', effective_from = now() - interval '1 second' WHERE id = $1`,
            [v],
          ),
        ).toBe('22023');
        // One draft per plan: a second draft while the first is open is refused.
        expect(
          await code(
            c,
            `INSERT INTO pricing_plan_versions (plan_id, version_number) VALUES ($1, 2)`,
            [planId],
          ),
        ).toBe('23505');
        expect(
          await code(
            c,
            `INSERT INTO provider_cost_rates (provider_id, channel_id, unit_cost_e4, effective_from) VALUES ($1, $2, 1, now() - interval '1 second')`,
            [p1, sms],
          ),
        ).toBe('23514');
        expect(
          await code(
            c,
            `INSERT INTO provider_cost_rates (provider_id, channel_id, unit_cost_e4, effective_from, created_at) VALUES ($1, $2, 1, now() - interval '1 day', now() - interval '2 days')`,
            [p1, sms],
          ),
        ).toBe('23514'); // a caller-supplied created_at is overwritten
        expect(
          await code(
            c,
            `INSERT INTO customer_pricing_assignments (org_id, plan_id, effective_from) VALUES ($1, $2, now() - interval '1 second')`,
            [A.orgId, planId],
          ),
        ).toBe('23514');
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('rule 9: immutability and never re-rating', () => {
    it('a rated subject is never re-rated: later versions, rates or arguments leave its evaluation unchanged', async () => {
      await tx(async (c) => {
        const { planId } = await plan(c, [{ channel: sms, price: 10000 }]);
        await assign(c, A.orgId, planId);
        await costRate(c, p1, sms, 3000);
        const m = await plant(c, A, sms, p1);
        const em = (await rate(c, A.orgId, m.messageId, null, 2)).rows[0];
        const ea = (await rate(c, A.orgId, m.messageId, m.attemptId, 2, true, true)).rows[0];
        expect([em.inserted, em.customer, em.cost]).toEqual([true, '2', null]);
        expect([ea.inserted, ea.customer, ea.cost]).toEqual([true, '2', '1']);
        const snapshot = async () =>
          (
            await c.query(
              `SELECT e.id, e.plan_version_id, e.rating_timestamp, e.units, e.total_customer_price_paise, e.total_provider_cost_paise,
                      json_agg(json_build_object('c', x.component, 'r', x.unit_rate_e4, 'p', x.amount_paise) ORDER BY x.component) AS comps
                 FROM pricing_evaluations e JOIN pricing_evaluation_components x ON x.evaluation_id = e.id
                WHERE e.message_id = $1 GROUP BY e.id ORDER BY e.subject`,
              [m.messageId],
            )
          ).rows;
        const before = await snapshot();
        // New version and cost rate later; re-rating with other arguments.
        const v2 = await version(c, planId, 2, [{ channel: sms, price: 99990000 }]);
        await c.query(
          `UPDATE pricing_plan_versions SET status = 'active', effective_from = now() + interval '1 hour' WHERE id = $1`,
          [v2],
        );
        await costRate(c, p1, sms, 99990000, `now() + interval '1 hour'`);
        const again = (await rate(c, A.orgId, m.messageId, null, 7)).rows[0];
        expect([again.evaluation_id, again.inserted, again.customer]).toEqual([
          em.evaluation_id,
          false,
          '2',
        ]);
        const againA = (await rate(c, A.orgId, m.messageId, m.attemptId, 9, true, true)).rows[0];
        expect([againA.evaluation_id, againA.inserted]).toEqual([ea.evaluation_id, false]);
        expect(await snapshot()).toEqual(before);
        expect(
          await code(c, `SELECT * FROM app_rate_message($1, $2, NULL, 1, true, true)`, [
            A.orgId,
            m.messageId,
          ]),
        ).toBe('22023'); // no cost on a message
      });
    });

    it('active versions, their rules, cost rates, assignments, evaluations and components cannot change; nothing can be truncated', async () => {
      await tx(async (c) => {
        const { planId, versionId } = await plan(c, [{ channel: sms, price: 1 }]);
        await assign(c, A.orgId, planId);
        await costRate(c, p1, sms, 1);
        const m = await plant(c, A, sms);
        await rate(c, A.orgId, m.messageId, null, 1);
        expect(
          await code(
            c,
            `UPDATE pricing_plan_versions SET effective_from = now() + interval '1 day' WHERE id = $1`,
            [versionId],
          ),
        ).toBe('42501');
        expect(await code(c, `DELETE FROM pricing_plan_versions WHERE id = $1`, [versionId])).toBe(
          '42501',
        );
        expect(
          await code(
            c,
            `INSERT INTO pricing_rules (plan_version_id, channel_id, unit_price_e4) VALUES ($1, $2, 5)`,
            [versionId, wa],
          ),
        ).toBe('42501');
        expect(
          await code(c, `DELETE FROM pricing_rules WHERE plan_version_id = $1`, [versionId]),
        ).toBe('42501');
        expect(
          await code(c, `UPDATE pricing_rules SET unit_price_e4 = 5 WHERE plan_version_id = $1`, [
            versionId,
          ]),
        ).toBe('42501');
        expect(await code(c, `DELETE FROM pricing_plans WHERE id = $1`, [planId])).toBe('42501');
        for (const t of [
          'provider_cost_rates',
          'customer_pricing_assignments',
          'pricing_evaluations',
          'pricing_evaluation_components',
        ]) {
          expect([t, await code(c, `UPDATE ${t} SET created_at = created_at`)]).toEqual([
            t,
            '42501',
          ]);
          expect([t, await code(c, `DELETE FROM ${t}`)]).toEqual([t, '42501']);
        }
        for (const t of [
          'pricing_plans',
          'pricing_plan_versions',
          'pricing_rules',
          'provider_cost_rates',
          'customer_pricing_assignments',
          'pricing_evaluations',
          'pricing_evaluation_components',
        ]) {
          expect([t, await code(c, `TRUNCATE ${t} CASCADE`)]).toEqual([t, '42501']);
        }
      });
    });

    it('a draft can be edited, then activated once; the activation race cannot slip a rule into an active version', async () => {
      await tx(async (c) => {
        const planId = (
          await c.query(`INSERT INTO pricing_plans (name) VALUES ($1) RETURNING id`, [
            `p72-${uuidv7()}`,
          ])
        ).rows[0].id;
        const v = await version(c, planId, 1, [{ channel: sms, price: 1 }]);
        expect(await code(c, `DELETE FROM pricing_rules WHERE plan_version_id = $1`, [v])).toBe(
          'OK',
        );
        expect(
          await code(
            c,
            `INSERT INTO pricing_rules (plan_version_id, channel_id, provider_id, unit_price_e4) VALUES ($1, $2, $3, 7)`,
            [v, sms, p1],
          ),
        ).toBe('OK');
        expect(
          await code(
            c,
            `INSERT INTO pricing_rules (plan_version_id, channel_id, provider_id, unit_price_e4) VALUES ($1, $2, $3, 8)`,
            [v, sms, p1],
          ),
        ).toBe('23505');
        expect(
          await code(
            c,
            `INSERT INTO pricing_rules (plan_version_id, channel_id, provider_id, unit_price_e4) VALUES ($1, $2, $3, 8)`,
            [v, wa, p1],
          ),
        ).toBe('23503'); // provider not on channel
        expect(
          await code(
            c,
            `INSERT INTO pricing_rules (plan_version_id, channel_id, unit_price_e4) VALUES ($1, $2, -1)`,
            [v, sms],
          ),
        ).toBe('23514');
        expect(
          await code(
            c,
            `UPDATE pricing_plan_versions SET status = 'active', effective_from = now() WHERE id = $1`,
            [v],
          ),
        ).toBe('OK');
        expect(
          await code(
            c,
            `UPDATE pricing_plan_versions SET status = 'active', effective_from = now() WHERE id = $1`,
            [v],
          ),
        ).toBe('42501');
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('idempotency and concurrency (committed fixtures)', () => {
    it('eight concurrent first ratings of one subject produce exactly one evaluation and identical results', async () => {
      const setup = await db.adminPool.connect();
      let m: { messageId: string; attemptId: string | null };
      try {
        await setup.query('BEGIN');
        const { planId } = await plan(setup, [{ channel: sms, price: 12345 }]);
        committed.plans.push(planId);
        await assign(setup, B.orgId, planId);
        await costRate(setup, p2, sms, 6789);
        m = await plant(setup, B, sms, p2);
        await setup.query('COMMIT');
      } catch (error) {
        await setup.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        setup.release();
      }
      const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 8 });
      try {
        const results = await Promise.all(
          Array.from({ length: 8 }, async () => {
            const c = await pool.connect();
            try {
              await c.query('BEGIN');
              const r = (await rate(c, B.orgId, m.messageId, m.attemptId, 3, true, true)).rows[0];
              await c.query('COMMIT');
              return r;
            } finally {
              c.release();
            }
          }),
        );
        expect(results.filter((r) => r.inserted)).toHaveLength(1);
        expect(new Set(results.map((r) => r.evaluation_id)).size).toBe(1);
        expect(new Set(results.map((r) => `${r.customer}/${r.cost}`))).toEqual(new Set(['4/2'])); // 37035 → 4; 20367 → 2
        const n = await admin(
          `SELECT (SELECT count(*)::int FROM pricing_evaluations WHERE message_attempt_id = $1) AS e,
                  (SELECT count(*)::int FROM pricing_evaluation_components x JOIN pricing_evaluations e ON e.id = x.evaluation_id
                    WHERE e.message_attempt_id = $1) AS x`,
          [m.attemptId],
        );
        expect(n.rows[0]).toEqual({ e: 1, x: 2 });
      } finally {
        await pool.end();
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('privileges, row security and invariant D', () => {
    it('no application role may execute the rating functions or touch evaluations', async () => {
      const granted: string[] = [];
      for (const role of APP_ROLES) {
        for (const fn of [LOOKUP, RATE]) {
          const { rows } = await admin(
            `SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`,
            [role, fn],
          );
          if (rows[0].ok) granted.push(`${role}:${fn}`);
        }
        for (const t of ['pricing_evaluations', 'pricing_evaluation_components']) {
          for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
            const { rows } = await admin(`SELECT has_table_privilege($1, $2, $3) AS ok`, [
              role,
              t,
              p,
            ]);
            if (rows[0].ok) granted.push(`${role}:${t}:${p}`);
          }
        }
      }
      expect(granted).toEqual([]);
      const pub = await admin(
        `SELECT p.proname FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.proname IN ('app_price_lookup', 'app_rate_message') AND a.grantee = 0`,
      );
      expect(pub.rows).toEqual([]);
    });

    it('acc_app reaches the catalogue only under a validated platform-scope claim', async () => {
      const asApp = async (userId: string | null, work: (c: PoolClient) => Promise<void>) => {
        const c = await db.appPool.connect();
        try {
          await c.query('BEGIN');
          if (userId) await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
          await work(c);
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      };
      await asApp(null, async (c) => {
        expect((await c.query(`SELECT count(*)::int AS n FROM pricing_plans`)).rows[0].n).toBe(0);
        expect(await code(c, `INSERT INTO pricing_plans (name) VALUES ('p72-tenant')`)).toBe(
          '42501',
        );
      });
      await asApp(A.userId, async (c) => {
        expect(await code(c, `INSERT INTO pricing_plans (name) VALUES ('p72-tenant-user')`)).toBe(
          '42501',
        );
      });
      await asApp(platformUser, async (c) => {
        const id = (
          await c.query(`INSERT INTO pricing_plans (name) VALUES ($1) RETURNING id`, [
            `p72-platform-${uuidv7()}`,
          ])
        ).rows[0].id;
        const v = (
          await c.query(
            `INSERT INTO pricing_plan_versions (plan_id, version_number) VALUES ($1, 1) RETURNING id`,
            [id],
          )
        ).rows[0].id;
        await c.query(
          `INSERT INTO pricing_rules (plan_version_id, channel_id, unit_price_e4) VALUES ($1, $2, 10)`,
          [v, sms],
        );
        await c.query(
          `UPDATE pricing_plan_versions SET status = 'active', effective_from = now() WHERE id = $1`,
          [v],
        );
        await c.query(
          `INSERT INTO customer_pricing_assignments (org_id, plan_id, effective_from) VALUES (NULL, $1, now())`,
          [id],
        );
        await c.query(
          `INSERT INTO provider_cost_rates (provider_id, channel_id, unit_cost_e4, effective_from) VALUES ($1, $2, 1, now())`,
          [p1, sms],
        );
        expect(
          await code(c, `SELECT * FROM app_price_lookup($1, $2, NULL, 1, now(), true, false)`, [
            A.orgId,
            sms,
          ]),
        ).toBe('42501');
        expect(await code(c, `SELECT 1 FROM pricing_evaluations LIMIT 1`)).toBe('42501');
      });
    });

    it('invariant D: the rating functions are SECURITY DEFINER and contain no dynamic SQL, ALTER or variable setting', async () => {
      const { rows } = await admin(
        `SELECT proname, prosecdef, provolatile, prosrc FROM pg_proc
          WHERE proname IN ('app_price_lookup', 'app_rate_message', 'app_pricing_unit_for_channel') ORDER BY proname`,
      );
      expect(rows.map((r) => [r.proname, r.prosecdef, r.provolatile])).toEqual([
        ['app_price_lookup', true, 's'],
        ['app_pricing_unit_for_channel', false, 's'],
        ['app_rate_message', true, 'v'],
      ]);
      for (const r of rows) {
        const src = (r.prosrc as string)
          .toLowerCase()
          .replace(/'(?:[^']|'')*'/g, "''")
          .replace(/--[^\n]*/g, '');
        for (const forbidden of [
          /\bexecute\s+(?!function)/,
          /(^|;|\s)alter\s/,
          /\bset_config\s*\(/,
          /(^|;|\s)grant\s/,
        ]) {
          expect([r.proname, forbidden.test(src)]).toEqual([r.proname, false]);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('Phase 7.1 untouched', () => {
    it('migration 0051 alters, replaces or drops no Phase 7.1 object', () => {
      const sql = readFileSync(
        join(__dirname, '../../migrations/0051_phase7_2_pricing_rating.sql'),
        'utf8',
      ).replace(/--[^\n]*/g, '');
      const touching = sql.match(
        /\b(ALTER\s+TABLE|DROP\s+\w+|CREATE\s+OR\s+REPLACE\s+FUNCTION|ALTER\s+FUNCTION)\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(usage_ledger\w*|wallets|credit_accounts|app_ledger_\w+|app_uuidv7_month|fn_billing_immutable)\b/gi,
      );
      expect(touching).toBeNull();
    });

    it('the ledger writer and the account tables are exactly as 0050 left them (no grant, no policy)', async () => {
      const grants = await admin(
        `SELECT count(*)::int AS n FROM information_schema.role_table_grants
          WHERE table_name IN ('usage_ledger', 'wallets', 'credit_accounts') AND grantee IN ('acc_app', 'acc_dispatch', 'acc_delivery', 'acc_auth', 'acc_relay')`,
      );
      expect(grants.rows[0].n).toBe(0);
      const writer = await admin(
        `SELECT has_function_privilege('acc_app', 'app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text)', 'EXECUTE') AS ok`,
      );
      expect(writer.rows[0].ok).toBe(false);
    });
  });
});
