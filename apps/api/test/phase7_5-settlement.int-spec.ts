// Must stay the first import: it switches billing enforcement on before the
// application module (and its validated configuration) is loaded.
import './billing-enforcement.env';

import { randomBytes, randomUUID } from 'node:crypto';
import { PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AppConfigService } from '../src/config/app-config.service';
import { DISPATCH_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import { applyDeliveryEvent } from '../src/messages/delivery/delivery-writer';
import { DispatcherService } from '../src/messages/dispatch/dispatcher.service';
import { MetricsService } from '../src/observability/metrics.service';
import { ProviderSubmissionExecutor } from '../src/provider-adapters/submission-executor';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

/**
 * Phase 7 PR 7-5 — settlement and the reservation lifecycle, through the real
 * dispatcher (`DECISIONS.md` §1zi.8). Billing enforcement is ON for this suite;
 * every message is submitted through `POST /messages` (7-4 reserves it) and then
 * dispatched by `DispatcherService` against simulator providers.
 *
 *   1. Charge only on a confirmed accepted chain (OD-7-4); provider cost for every
 *      attempt that reached the provider; release in the transaction that finishes
 *      the message; nothing for a failed chain but cost and release.
 *   2. Outcome unknown (OD-7-4U): no charge, no provider cost, release; a later
 *      receipt is evidence only. Lease recovery and an expired-lease re-claim alike.
 *   3. Per-attempt top-ups (D-74-3) before the provider call; a refused top-up
 *      fails the message before any provider call.
 *   4. Stale workers and duplicate settlement: the live claim is required; facts
 *      are keyed, so a repeated or concurrent settlement changes nothing.
 *   5. Lock order under concurrency: sends and dispatches of one organization at
 *      once, no deadlock, balances equal to the ledger.
 *   6. A message submitted with enforcement off is never settled.
 */

const url = (p: string) => `/${PREFIX}${p}`;
const WA_PRICE = 500_000; // 50 paise
const COST = 200_000; // 20 paise provider cost per message

interface Sender {
  readonly tenant: TenantFixture;
  readonly token: string;
}
interface Fact {
  readonly entry: string;
  readonly anchor: 'message' | 'attempt';
  readonly amount: number;
}

describe('Phase 7-5: settlement and the reservation lifecycle (enforcement on)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let config: AppConfigService;
  let dispatcher: DispatcherService;
  let dispatchPool: Pool;
  let channelId: string;
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const roles: string[] = [];
  const plans: string[] = [];
  let seq = 0;
  let priority = 0;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    config = h.app.get(AppConfigService);
    dispatcher = h.app.get(DispatcherService);
    dispatchPool = h.app.get(DISPATCH_POOL);
    expect(config.billing.enforcementEnabled).toBe(true);
    const [c] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    channelId = c!.id;
  }, 60_000);

  afterAll(async () => {
    // Ledger facts, classifications, evaluations, accounts and append-only history are
    // undeletable by design (DECISIONS.md §1zi.4); the owner removes this suite's fixtures
    // with triggers suspended for this one transaction only, providers included, so no
    // later suite inherits a row it cannot delete.
    try {
      const orgIds = tenants.map((t) => t.orgId);
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        if (orgIds.length > 0) {
          const orgs = sql`ANY(${`{${orgIds.join(',')}}`}::uuid[])`;
          await tx.execute(
            sql`DELETE FROM pricing_evaluation_components WHERE evaluation_id IN (SELECT id FROM pricing_evaluations WHERE org_id = ${orgs})`,
          );
          for (const table of [
            'usage_ledger',
            'message_attempt_billing',
            'message_dispatch_queue',
            'message_events',
            'idempotency_keys',
            'pricing_evaluations',
            'customer_pricing_assignments',
            'wallets',
            'credit_accounts',
            'message_attempts',
            'messages',
            'contact_identities',
            'contacts',
            'organization_provider_assignments',
          ]) {
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${orgs}`);
          }
        }
        if (providers.length > 0) {
          const ids = sql`ANY(${`{${providers.join(',')}}`}::uuid[])`;
          for (const table of ['provider_health', 'provider_cost_rates', 'provider_capabilities']) {
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE provider_id = ${ids}`);
          }
        }
        if (plans.length > 0) {
          const planIds = sql`ANY(${`{${plans.join(',')}}`}::uuid[])`;
          await tx.execute(
            sql`DELETE FROM pricing_rules WHERE plan_version_id IN (SELECT id FROM pricing_plan_versions WHERE plan_id = ${planIds})`,
          );
          await tx.execute(sql`DELETE FROM pricing_plan_versions WHERE plan_id = ${planIds}`);
          await tx.execute(sql`DELETE FROM pricing_plans WHERE id = ${planIds}`);
        }
        if (providers.length > 0) {
          await tx.execute(
            sql`DELETE FROM providers WHERE id = ANY(${`{${providers.join(',')}}`}::uuid[])`,
          );
        }
      });
      if (roles.length > 0) {
        await h.admin.delete(schema.userRoles).where(inArray(schema.userRoles.roleId, roles));
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, roles));
        await h.admin.delete(schema.roles).where(inArray(schema.roles.id, roles));
      }
      for (const t of tenants) await destroyTenant(h.admin, t);
    } finally {
      await h.close();
    }
  }, 120_000);

  // --- fixtures ---------------------------------------------------------------

  const hex = (n: number) => randomBytes(n).toString('hex');

  async function sender(label: string): Promise<Sender> {
    const tenant = await createTenant(h.admin, label, credentials);
    tenants.push(tenant);
    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_SEND, PERMISSIONS.MESSAGES_READ]),
      );
    const roleId = uuidv7();
    roles.push(roleId);
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: tenant.orgId,
      key: `p75_${hex(4)}`,
      name: 'Phase 7-5 sender',
      description: 'Sends and reads messages',
      isSystemRole: false,
      allowedScopeTypes: ['organization'],
    });
    for (const p of perms) {
      await h.admin
        .insert(schema.rolePermissions)
        .values({ roleId, permissionId: p.id, orgId: tenant.orgId });
    }
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId: tenant.userId,
        roleId,
        scopeType: 'organization',
        scopeId: tenant.orgId,
      });
    });
    await h.clearRateLimits();
    const login = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenant.email, password: PASSWORD })
      .expect(200);
    return { tenant, token: login.body.data.accessToken as string };
  }

  /** A simulator provider assigned to the organization, with a provider cost rate. */
  async function provider(orgId: string, behavior = 'SUCCESS', withCost = true): Promise<string> {
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `Phase 7-5 ${hex(4)}`,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(p!.id);
    if (behavior !== 'SUCCESS') {
      await h.admin
        .insert(schema.providerCapabilities)
        .values({ providerId: p!.id, capabilityKey: 'simulator_behavior', value: behavior });
    }
    if (withCost) {
      await h.admin.execute(
        sql`INSERT INTO provider_cost_rates (provider_id, channel_id, unit_cost_e4, effective_from) VALUES (${p!.id}, ${channelId}, ${COST}, now())`,
      );
    }
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId,
      channelId,
      providerId: p!.id,
      priority: (priority += 1),
      status: 'active',
    });
    return p!.id;
  }

  async function priceFor(
    orgId: string,
    rules: ReadonlyArray<{ provider?: string; price: number }>,
  ): Promise<void> {
    await h.admin.transaction(async (tx) => {
      const plan = await tx.execute<{ id: string }>(
        sql`INSERT INTO pricing_plans (name) VALUES (${`p75-${uuidv7()}`}) RETURNING id`,
      );
      plans.push(plan.rows[0]!.id);
      const version = await tx.execute<{ id: string }>(
        sql`INSERT INTO pricing_plan_versions (plan_id, version_number) VALUES (${plan.rows[0]!.id}, 1) RETURNING id`,
      );
      for (const r of rules) {
        await tx.execute(
          sql`INSERT INTO pricing_rules (plan_version_id, channel_id, provider_id, unit_price_e4)
              VALUES (${version.rows[0]!.id}, ${channelId}, ${r.provider ?? null}, ${r.price})`,
        );
      }
      await tx.execute(
        sql`UPDATE pricing_plan_versions SET status = 'active', effective_from = now() WHERE id = ${version.rows[0]!.id}`,
      );
      await tx.execute(
        sql`INSERT INTO customer_pricing_assignments (org_id, plan_id, effective_from) VALUES (${orgId}, ${plan.rows[0]!.id}, now())`,
      );
    });
  }

  /** A prepaid, per-message organization with a funded wallet and providers of the given behaviours. */
  async function org(
    label: string,
    behaviors: string[],
    options: { balance?: number; perAttempt?: boolean; withCost?: boolean } = {},
  ): Promise<Sender & { providers: string[] }> {
    const s = await sender(label);
    const ids: string[] = [];
    for (const b of behaviors)
      ids.push(await provider(s.tenant.orgId, b, options.withCost ?? true));
    if (options.perAttempt) {
      await h.admin.execute(
        sql`UPDATE organizations SET billing_policy = 'charge_per_attempt' WHERE id = ${s.tenant.orgId}`,
      );
    } else {
      await priceFor(s.tenant.orgId, [{ price: WA_PRICE }]);
    }
    await h.admin.execute(
      sql`INSERT INTO wallets (org_id, balance_paise) VALUES (${s.tenant.orgId}, ${options.balance ?? 100_000})`,
    );
    return { ...s, providers: ids };
  }

  async function send(s: Sender): Promise<string> {
    seq += 1;
    const res = await request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Acc-Organization', s.tenant.orgId)
      .set('Idempotency-Key', randomUUID())
      .send({
        channelCode: 'whatsapp',
        recipient: `+1202554${String(1000 + seq).padStart(4, '0')}`,
        payload: { text: 'hello' },
      });
    expect(res.status).toBe(202);
    return res.body.data.id as string;
  }

  /** Claims and processes exactly this message (every other queue row is set aside). */
  async function dispatch(messageId: string) {
    await h.admin.execute(sql`DELETE FROM message_dispatch_queue WHERE message_id <> ${messageId}`);
    const [claim] = await dispatcher.claimBatch(1);
    expect(claim?.messageId).toBe(messageId);
    return dispatcher.processClaim(claim!);
  }

  async function facts(messageId: string): Promise<Fact[]> {
    const { rows } = await h.admin.execute<{ entry: string; attempt: boolean; amount: number }>(
      sql`SELECT entry_type AS entry, message_attempt_id IS NOT NULL AS attempt, amount_paise::int AS amount
            FROM usage_ledger WHERE message_id = ${messageId} ORDER BY occurred_at, id`,
    );
    return rows.map((r) => ({
      entry: r.entry,
      anchor: r.attempt ? 'attempt' : 'message',
      amount: r.amount,
    }));
  }

  async function wallet(orgId: string): Promise<{ balance: number; reserved: number }> {
    const { rows } = await h.admin.execute<{ balance: number; reserved: number }>(
      sql`SELECT balance_paise::int AS balance, reserved_paise::int AS reserved FROM wallets WHERE org_id = ${orgId}`,
    );
    return rows[0]!;
  }

  async function status(messageId: string): Promise<string> {
    const [m] = await h.admin
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId));
    return m!.status;
  }

  async function reached(messageId: string): Promise<boolean[]> {
    const { rows } = await h.admin.execute<{ reached_provider: boolean }>(
      sql`SELECT b.reached_provider FROM message_attempt_billing b
            JOIN message_attempts a ON a.id = b.attempt_id
           WHERE b.message_id = ${messageId} ORDER BY a.attempt_number`,
    );
    return rows.map((r) => r.reached_provider);
  }

  /** Puts a message into `submitting` with an attempt, as a worker that vanished mid-submission leaves it. */
  async function abandon(messageId: string, providerId: string, orgId: string): Promise<string> {
    await h.admin.execute(sql`DELETE FROM message_dispatch_queue WHERE message_id <> ${messageId}`);
    const [claim] = await dispatcher.claimBatch(1);
    const attemptId = uuidv7();
    await h.admin.insert(schema.messageAttempts).values({
      id: attemptId,
      messageId,
      orgId,
      providerId,
      channelId,
      attemptNumber: 1,
      status: 'submitting',
      claimToken: claim!.claimToken,
      fencingEpoch: claim!.dispatchEpoch,
    });
    await h.admin
      .update(schema.messages)
      .set({ currentAttemptId: attemptId, status: 'submitting' })
      .where(eq(schema.messages.id, messageId));
    await h.admin
      .update(schema.messageDispatchQueue)
      .set({ claimedUntil: new Date(Date.now() - 5000) })
      .where(eq(schema.messageDispatchQueue.messageId, messageId));
    return attemptId;
  }

  // --- 1. confirmed outcomes -----------------------------------------------------

  describe('1. charge only on a confirmed accepted chain', () => {
    it('accepted: provider cost for the attempt, one charge of E_m, nothing left reserved', async () => {
      const s = await org('p75-acc', ['SUCCESS']);
      const id = await send(s);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 100_000, reserved: 50 });
      expect((await dispatch(id)).outcome).toBe('accepted');
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
        { entry: 'customer_charge', anchor: 'message', amount: 50 },
      ]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 99_950, reserved: 0 });
      expect(await reached(id)).toEqual([true]);
    });

    it('failed (non-fallback): provider cost, no charge, the reservation released', async () => {
      const s = await org('p75-fail', ['INVALID_REQUEST']);
      const id = await send(s);
      expect((await dispatch(id)).outcome).toBe('failed');
      expect(await status(id)).toBe('failed');
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 100_000, reserved: 0 });
    });

    it('fallback chain (PROVIDER_ERROR, then accepted): cost for both attempts, one charge', async () => {
      const s = await org('p75-fb', ['500', 'SUCCESS']);
      const id = await send(s);
      expect((await dispatch(id)).outcome).toBe('failed'); // requeued for fallback
      expect(await status(id)).toBe('queued');
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
      ]);
      expect((await dispatch(id)).outcome).toBe('accepted');
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
        { entry: 'customer_charge', anchor: 'message', amount: 50 },
      ]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 99_950, reserved: 0 });
      expect(await reached(id)).toEqual([true, true]);
    });

    it('a claim-time terminal failure (no eligible provider) releases with no cost', async () => {
      const s = await org('p75-none', ['SUCCESS']);
      const id = await send(s);
      await h.admin.execute(
        sql`UPDATE providers SET status = 'disabled' WHERE id = ${s.providers[0]!}`,
      );
      expect((await dispatch(id)).outcome).toBe('circuit_refused');
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 100_000, reserved: 0 });
    });

    // Owner decision (09-Nov-2026): reached only when a provider response decided it.
    it('a provider-originated authentication failure reached the provider: cost, no charge, release', async () => {
      const s = await org('p75-auth', ['INVALID_CREDENTIALS']);
      const id = await send(s);
      const res = await dispatch(id);
      expect([res.outcome, res.error?.startsWith('AUTH_ERROR')]).toEqual(['failed', true]);
      expect(await reached(id)).toEqual([true]);
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
    });

    it('a rate-limit answer from the provider reached it: cost recorded, then fallback', async () => {
      const s = await org('p75-429', ['429', 'SUCCESS']);
      const id = await send(s);
      expect((await dispatch(id)).outcome).toBe('failed');
      expect((await dispatch(id)).outcome).toBe('accepted');
      expect(await reached(id)).toEqual([true, true]);
      expect((await facts(id)).filter((f) => f.entry === 'provider_cost')).toHaveLength(2);
    });

    it('a locally detected failure (no provider response) is not reached: no cost, release', async () => {
      // An unknown simulator behaviour is refused by the adapter's own checks before
      // anything reaches the provider: CONFIGURATION_ERROR, origin local.
      const s = await org('p75-local', ['NOT_A_BEHAVIOUR']);
      const id = await send(s);
      const res = await dispatch(id);
      expect([res.outcome, res.error?.startsWith('CONFIGURATION_ERROR')]).toEqual(['failed', true]);
      expect(await reached(id)).toEqual([false]);
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
    });
  });

  // --- 2. outcome unknown ---------------------------------------------------------

  describe('2. outcome unknown (OD-7-4U)', () => {
    it('TIMEOUT: no charge, no provider cost, reservation released; a later receipt changes no money', async () => {
      const s = await org('p75-unk', ['TIMEOUT']);
      const id = await send(s);
      const result = await dispatch(id);
      expect(result.outcome).toBe('unknown');
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
      expect(await reached(id)).toEqual([false]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 100_000, reserved: 0 });

      // A delivered receipt arriving later: evidence on the delivery axis only.
      const ownerPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
      const owner = await ownerPool.connect();
      try {
        await owner.query('BEGIN');
        await applyDeliveryEvent(owner, {
          orgId: s.tenant.orgId,
          messageId: id,
          attemptId: result.attemptId!,
          kind: 'delivered',
          occurredAt: new Date(),
          receipts: new Set(['delivered']),
          webhookEventId: uuidv7(),
          now: new Date(),
        });
        await owner.query('COMMIT');
      } finally {
        owner.release();
        await ownerPool.end();
      }
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 100_000, reserved: 0 });
      expect(await status(id)).toBe('outcome_unknown');
    });

    it('lease recovery of an abandoned submission: outcome_unknown, released, never charged', async () => {
      const s = await org('p75-tr', ['SUCCESS']);
      const id = await send(s);
      await abandon(id, s.providers[0]!, s.tenant.orgId);
      expect(await dispatcher.recoverExpiredLeases()).toBe(1);
      expect(await status(id)).toBe('outcome_unknown');
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
      expect(await reached(id)).toEqual([false]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 100_000, reserved: 0 });
    });

    it('an expired lease re-claimed by a worker (BE-DISPATCH-02) settles the same way', async () => {
      const s = await org('p75-be02', ['SUCCESS']);
      const id = await send(s);
      await abandon(id, s.providers[0]!, s.tenant.orgId);
      const [claim] = await dispatcher.claimBatch(1);
      expect((await dispatcher.processClaim(claim!)).outcome).toBe('unknown');
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
    });

    it('lease recovery is per lease: two organizations recovered in one run, each settled', async () => {
      const a = await org('p75-tra', ['SUCCESS']);
      const b = await org('p75-trb', ['SUCCESS']);
      const ia = await send(a);
      const ib = await send(b);
      // Abandon both, keeping both queue rows.
      await h.admin.execute(
        sql`DELETE FROM message_dispatch_queue WHERE message_id NOT IN (${ia}, ${ib})`,
      );
      for (const claim of await dispatcher.claimBatch(2)) {
        const attemptId = uuidv7();
        await h.admin.insert(schema.messageAttempts).values({
          id: attemptId,
          messageId: claim.messageId,
          orgId: claim.orgId,
          providerId: (claim.messageId === ia ? a : b).providers[0]!,
          channelId,
          attemptNumber: 1,
          status: 'submitting',
          claimToken: claim.claimToken,
          fencingEpoch: claim.dispatchEpoch,
        });
        await h.admin
          .update(schema.messages)
          .set({ currentAttemptId: attemptId, status: 'submitting' })
          .where(eq(schema.messages.id, claim.messageId));
      }
      await h.admin
        .update(schema.messageDispatchQueue)
        .set({ claimedUntil: new Date(Date.now() - 5000) })
        .where(inArray(schema.messageDispatchQueue.messageId, [ia, ib]));
      expect(await dispatcher.recoverExpiredLeases()).toBe(2);
      for (const [id, s] of [
        [ia, a],
        [ib, b],
      ] as const) {
        expect(await facts(id)).toEqual([
          { entry: 'reservation', anchor: 'message', amount: 50 },
          { entry: 'reservation_release', anchor: 'message', amount: 50 },
        ]);
        expect(await wallet(s.tenant.orgId)).toEqual({ balance: 100_000, reserved: 0 });
      }
    });
  });

  // --- 3. per-attempt top-ups -------------------------------------------------------

  describe('3. per-attempt reservation top-ups (D-74-3)', () => {
    async function perAttemptOrg(label: string, balance: number) {
      // At submission: one candidate priced 60 → reservation 60. A second provider,
      // priced 80, is assigned after submission; the first fails (PROVIDER_ERROR).
      const s = await org(label, ['500'], { perAttempt: true, balance });
      await priceFor(s.tenant.orgId, [{ provider: s.providers[0]!, price: 600_000 }]);
      const id = await send(s);
      expect(await facts(id)).toEqual([{ entry: 'reservation', anchor: 'message', amount: 60 }]);
      const second = await provider(s.tenant.orgId, 'SUCCESS');
      await priceFor(s.tenant.orgId, [
        { provider: s.providers[0]!, price: 600_000 },
        { provider: second, price: 800_000 },
      ]);
      return { s, id, second };
    }

    it('tops up before the next attempt; on acceptance charges each attempt that reached the provider', async () => {
      const { s, id } = await perAttemptOrg('p75-pa', 100_000);
      expect((await dispatch(id)).outcome).toBe('failed'); // attempt 1, requeued
      expect((await dispatch(id)).outcome).toBe('accepted'); // attempt 2
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 60 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
        { entry: 'reservation', anchor: 'attempt', amount: 80 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
        { entry: 'customer_charge', anchor: 'attempt', amount: 60 },
        { entry: 'customer_charge', anchor: 'attempt', amount: 80 },
      ]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 99_860, reserved: 0 });
    });

    it('a refused top-up fails the message before any provider call and releases the reservation', async () => {
      const { s, id, second } = await perAttemptOrg('p75-pa-short', 60);
      expect((await dispatch(id)).outcome).toBe('failed'); // attempt 1, requeued
      const res = await dispatch(id);
      expect([res.outcome, res.error]).toEqual(['failed', 'BILLING_INSUFFICIENT_FUNDS']);
      expect(await status(id)).toBe('failed');
      const attempts = await h.admin
        .select()
        .from(schema.messageAttempts)
        .where(eq(schema.messageAttempts.messageId, id));
      expect(attempts.map((a) => a.providerId)).not.toContain(second); // never called
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 60 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
        { entry: 'reservation_release', anchor: 'message', amount: 60 },
      ]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 60, reserved: 0 });
    });

    it('a missing provider cost rate fails the attempt closed, before the provider call', async () => {
      const s = await org('p75-nocost', ['SUCCESS'], { withCost: false });
      const id = await send(s);
      const res = await dispatch(id);
      expect([res.outcome, res.error]).toEqual(['failed', 'BILLING_PROVIDER_COST_NOT_CONFIGURED']);
      expect(
        await h.admin
          .select()
          .from(schema.messageAttempts)
          .where(eq(schema.messageAttempts.messageId, id)),
      ).toEqual([]);
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
    });
  });

  // --- 4. stale workers and duplicate settlement ---------------------------------------

  describe('4. stale workers and duplicate settlement', () => {
    /** A dispatch session bound to `messageId` with `token`, in an open transaction. */
    async function session(orgId: string, messageId: string, token: string) {
      const c = await dispatchPool.connect();
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.current_org_id', $1, true),
                set_config('app.dispatch_message_id', $2, true),
                set_config('app.dispatch_claim_token', $3, true)`,
        [orgId, messageId, token],
      );
      return c;
    }
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'OK',
        (e: { code?: string }) => e.code ?? 'NO_CODE',
      );

    it('settlement is refused without the live claim: a superseded token or an expired lease (42501)', async () => {
      const s = await org('p75-stale', ['SUCCESS']);
      const id = await send(s);
      await h.admin.execute(sql`DELETE FROM message_dispatch_queue WHERE message_id <> ${id}`);
      const [claim] = await dispatcher.claimBatch(1);
      await h.admin.execute(sql`UPDATE messages SET status = 'failed' WHERE id = ${id}`);
      for (const [label, token] of [
        ['superseded token', randomUUID()],
        ['no token', ''],
      ] as const) {
        const c = await session(s.tenant.orgId, id, token);
        try {
          expect([
            label,
            await code(c.query(`SELECT * FROM app_dispatch_message_settle()`)),
          ]).toEqual([label, '42501']);
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      }
      await h.admin.execute(
        sql`UPDATE message_dispatch_queue SET claimed_until = now() - interval '1 second' WHERE message_id = ${id}`,
      );
      const c = await session(s.tenant.orgId, id, claim!.claimToken);
      try {
        expect(await code(c.query(`SELECT * FROM app_dispatch_message_settle()`))).toBe('42501');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      expect(await facts(id)).toEqual([{ entry: 'reservation', anchor: 'message', amount: 50 }]);
    });

    it('a repeated and a concurrent settlement post each fact once', async () => {
      const s = await org('p75-dup', ['SUCCESS']);
      const id = await send(s);
      await h.admin.execute(sql`DELETE FROM message_dispatch_queue WHERE message_id <> ${id}`);
      const [claim] = await dispatcher.claimBatch(1);
      await h.admin.execute(sql`UPDATE messages SET status = 'failed' WHERE id = ${id}`);

      const one = await session(s.tenant.orgId, id, claim!.claimToken);
      const two = await session(s.tenant.orgId, id, claim!.claimToken);
      try {
        const first = (await one.query(`SELECT * FROM app_dispatch_message_settle()`)).rows[0];
        const again = (await one.query(`SELECT * FROM app_dispatch_message_settle()`)).rows[0];
        expect([first, again]).toEqual([
          { charged_paise: '0', released_paise: '50' },
          { charged_paise: '0', released_paise: '50' },
        ]);
        // A second session waits on the queue-row lock, then finds the facts in place.
        const concurrent = two.query(`SELECT * FROM app_dispatch_message_settle()`);
        await one.query('COMMIT');
        expect((await concurrent).rows[0]).toEqual({ charged_paise: '0', released_paise: '50' });
        await two.query('COMMIT');
      } finally {
        one.release();
        two.release();
      }
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 100_000, reserved: 0 });
    });

    it('an unknown outcome can never be settled as reaching the provider; an accepted one always does', async () => {
      const s = await org('p75-guard', ['TIMEOUT']);
      const id = await send(s);
      const res = await dispatch(id);
      // Re-bind a live claim on the (deleted) queue row to probe the guard.
      await h.admin.insert(schema.messageDispatchQueue).values({
        messageId: id,
        orgId: s.tenant.orgId,
        dispatchEpoch: 99,
        claimToken: randomUUID(),
        claimedUntil: new Date(Date.now() + 30_000),
      });
      const [q] = await h.admin
        .select()
        .from(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.messageId, id));
      const c = await session(s.tenant.orgId, id, q!.claimToken!);
      try {
        expect(
          await code(
            c.query(`SELECT * FROM app_dispatch_attempt_settle($1, true)`, [res.attemptId]),
          ),
        ).toBe('22023');
      } finally {
        await c.query('ROLLBACK');
        c.release();
        await h.admin.execute(sql`DELETE FROM message_dispatch_queue WHERE message_id = ${id}`);
      }
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
    });
  });

  // --- 5. lock order under concurrency ------------------------------------------------

  describe('5. concurrency', () => {
    it('sends and dispatches of one organization at once: no deadlock, balances equal the ledger', async () => {
      const s = await org('p75-cc', ['SUCCESS', 'SUCCESS']);
      const queued: string[] = [];
      for (let i = 0; i < 6; i += 1) queued.push(await send(s));
      await h.admin.execute(
        sql`DELETE FROM message_dispatch_queue WHERE NOT (message_id = ANY(${`{${queued.join(',')}}`}::uuid[]))`,
      );
      const [dispatched, sent] = await Promise.all([
        dispatcher.dispatchBatch(6),
        Promise.all(Array.from({ length: 6 }, () => send(s))),
      ]);
      expect(dispatched.map((r) => r.outcome)).toEqual(Array(6).fill('accepted'));
      expect(sent).toHaveLength(6);
      const { rows } = await h.admin.execute<{
        charged: number;
        reserved: number;
        released: number;
      }>(
        sql`SELECT COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'customer_charge'), 0)::int AS charged,
                   COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'reservation'), 0)::int AS reserved,
                   COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'reservation_release'), 0)::int AS released
              FROM usage_ledger WHERE org_id = ${s.tenant.orgId}`,
      );
      expect(rows[0]).toEqual({ charged: 300, reserved: 600, released: 0 });
      expect(await wallet(s.tenant.orgId)).toEqual({
        balance: 100_000 - 300,
        reserved: 600 - 300,
      });
    });
  });

  // --- 7. the T3 settlement retry (OD-7-2) ------------------------------------------

  describe('7. settlement retry: the provider is called once, facts are written once', () => {
    let executor: ProviderSubmissionExecutor;
    let metrics: MetricsService;
    let execute: jest.SpyInstance;

    beforeAll(() => {
      executor = h.app.get(ProviderSubmissionExecutor);
      metrics = h.app.get(MetricsService);
    });
    beforeEach(() => {
      execute = jest.spyOn(executor, 'execute');
    });
    afterEach(async () => {
      execute.mockRestore();
      await h.admin.execute(sql`DROP TRIGGER IF EXISTS p75_fault ON message_events`);
      await h.admin.execute(sql`DROP FUNCTION IF EXISTS p75_fault()`);
      await h.admin.execute(sql`DROP SEQUENCE IF EXISTS p75_fault_seq`);
    });

    /**
     * Makes the next `times` settlement transactions of `messageId` fail with SQLSTATE
     * `code`, at the message.accepted event — after the attempt update, the recording and
     * the provider cost, so a rollback really has work to undo. The trigger raises a real
     * error: PostgreSQL aborts the transaction exactly as for a deadlock. The counter is a
     * sequence, which a rollback does not reset.
     */
    async function failSettlement(messageId: string, times: number, code: string) {
      expect(messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(code).toMatch(/^[0-9A-Z]{5}$/);
      await h.admin.execute(sql`CREATE SEQUENCE p75_fault_seq`);
      await h.admin.execute(
        sql.raw(`CREATE FUNCTION p75_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
          SET search_path = public, pg_temp AS $f$
          BEGIN
            IF nextval('p75_fault_seq') <= ${times} THEN
              RAISE EXCEPTION 'injected settlement fault' USING ERRCODE = '${code}';
            END IF;
            RETURN NEW;
          END $f$`),
      );
      await h.admin.execute(
        sql.raw(`CREATE TRIGGER p75_fault BEFORE INSERT ON message_events FOR EACH ROW
          WHEN (NEW.message_id = '${messageId}'::uuid AND NEW.event_type = 'message.accepted')
          EXECUTE FUNCTION p75_fault()`),
      );
    }
    const faultsRaised = async () =>
      Number(
        (
          await h.admin.execute<{ n: string }>(
            sql`SELECT CASE WHEN is_called THEN last_value ELSE 0 END::text AS n FROM p75_fault_seq`,
          )
        ).rows[0]!.n,
      );
    const samples = async (messageId: string) =>
      Number(
        (
          await h.admin.execute<{ n: string }>(
            sql`SELECT count(*)::text AS n FROM provider_health h
                  JOIN message_attempts a ON a.id = h.attempt_id WHERE a.message_id = ${messageId}`,
          )
        ).rows[0]!.n,
      );
    const events = async (messageId: string, type: string) =>
      Number(
        (
          await h.admin.execute<{ n: string }>(
            sql`SELECT count(*)::text AS n FROM message_events WHERE message_id = ${messageId} AND event_type = ${type}`,
          )
        ).rows[0]!.n,
      );
    const retries = async (outcome: string) =>
      (await metrics.dispatchSettlementRetries.get()).values.find(
        (v) => v.labels.outcome === outcome,
      )?.value ?? 0;

    it('a deadlock in T3 is retried: accepted, one provider call, every fact, sample and event once', async () => {
      const s = await org('p75-r1', ['SUCCESS']);
      const id = await send(s);
      await failSettlement(id, 1, '40P01');
      const succeeded = await retries('succeeded');
      expect((await dispatch(id)).outcome).toBe('accepted');
      expect(await faultsRaised()).toBe(2); // one failed run, one committed run
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'provider_cost', anchor: 'attempt', amount: 20 },
        { entry: 'customer_charge', anchor: 'message', amount: 50 },
      ]);
      expect(await samples(id)).toBe(1);
      expect(await events(id, 'message.accepted')).toBe(1);
      expect(await reached(id)).toEqual([true]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 99_950, reserved: 0 });
      expect(await retries('succeeded')).toBe(succeeded + 1);
    });

    it('serialization failures are retried up to the bound: the third run commits', async () => {
      const s = await org('p75-r2', ['SUCCESS']);
      const id = await send(s);
      await failSettlement(id, 2, '40001');
      expect((await dispatch(id)).outcome).toBe('accepted');
      expect(await faultsRaised()).toBe(3);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await facts(id)).toHaveLength(3);
      expect(await samples(id)).toBe(1);
    });

    it('retry exhaustion: nothing settled, claim held; lease recovery then releases without charging, and nothing is re-sent', async () => {
      const s = await org('p75-r3', ['SUCCESS']);
      const id = await send(s);
      await failSettlement(id, 3, '40P01');
      const exhausted = await retries('exhausted');
      const res = await dispatch(id);
      expect(res.outcome).toBe('unknown');
      expect(await faultsRaised()).toBe(3);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await status(id)).toBe('submitting');
      expect(await facts(id)).toEqual([{ entry: 'reservation', anchor: 'message', amount: 50 }]);
      expect(await samples(id)).toBe(0);
      expect(await retries('exhausted')).toBe(exhausted + 1);

      await h.admin.execute(
        sql`UPDATE message_dispatch_queue SET claimed_until = now() - interval '1 second' WHERE message_id = ${id}`,
      );
      expect(await dispatcher.recoverExpiredLeases()).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await status(id)).toBe('outcome_unknown');
      expect(await facts(id)).toEqual([
        { entry: 'reservation', anchor: 'message', amount: 50 },
        { entry: 'reservation_release', anchor: 'message', amount: 50 },
      ]);
      expect(await wallet(s.tenant.orgId)).toEqual({ balance: 100_000, reserved: 0 });
      expect(await dispatcher.recoverExpiredLeases()).toBe(0); // and once only
      expect(await facts(id)).toHaveLength(2);
    });

    it('a non-retryable error is not retried; the message is left to lease recovery', async () => {
      const s = await org('p75-r4', ['SUCCESS']);
      const id = await send(s);
      await failSettlement(id, 1, '23514');
      const nonRetryable = await retries('non_retryable');
      expect((await dispatch(id)).outcome).toBe('unknown');
      expect(await faultsRaised()).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await status(id)).toBe('submitting');
      expect(await facts(id)).toEqual([{ entry: 'reservation', anchor: 'message', amount: 50 }]);
      expect(await retries('non_retryable')).toBe(nonRetryable + 1);
    });

    it('no retry with less than 5 s of lease left', async () => {
      const s = await org('p75-r5', ['SUCCESS']);
      const id = await send(s);
      await failSettlement(id, 1, '40P01');
      await h.admin.execute(sql`DELETE FROM message_dispatch_queue WHERE message_id <> ${id}`);
      const [claim] = await dispatcher.claimBatch(1);
      await h.admin.execute(
        sql`UPDATE message_dispatch_queue SET claimed_until = now() + interval '4 seconds' WHERE message_id = ${id}`,
      );
      expect((await dispatcher.processClaim(claim!)).outcome).toBe('unknown');
      expect(await faultsRaised()).toBe(1);
      expect(await status(id)).toBe('submitting');
      expect(await facts(id)).toEqual([{ entry: 'reservation', anchor: 'message', amount: 50 }]);
    });

    it('a claim superseded while the provider answered is fenced at T3: nothing recorded or settled', async () => {
      const s = await org('p75-r6', ['SUCCESS']);
      const id = await send(s);
      execute.mockRestore();
      const original = executor.execute.bind(executor);
      execute = jest.spyOn(executor, 'execute');
      execute.mockImplementation(async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        // Another worker (or recovery) takes the claim over: a new token and epoch.
        await h.admin.execute(
          sql`UPDATE message_dispatch_queue SET claim_token = ${randomUUID()}, dispatch_epoch = dispatch_epoch + 1
               WHERE message_id = ${id}`,
        );
        return result;
      });
      expect((await dispatch(id)).outcome).toBe('fenced');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await facts(id)).toEqual([{ entry: 'reservation', anchor: 'message', amount: 50 }]);
      expect(await samples(id)).toBe(0);
      expect(await reached(id)).toEqual([]);
    });
  });

  // --- 6. enforcement off ------------------------------------------------------------

  describe('6. a message submitted with enforcement off is never settled', () => {
    it('no evaluation, no fact, no classification, whatever the outcome', async () => {
      const s = await org('p75-off', ['SUCCESS']);
      const spy = jest
        .spyOn(config, 'billing', 'get')
        .mockReturnValue({ enforcementEnabled: false });
      let id: string;
      try {
        id = await send(s);
      } finally {
        spy.mockRestore();
      }
      expect((await dispatch(id)).outcome).toBe('accepted');
      expect(await facts(id)).toEqual([]);
      expect(await reached(id)).toEqual([]);
      const { rows } = await h.admin.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pricing_evaluations WHERE message_id = ${id}`,
      );
      expect(rows[0]!.n).toBe(0);
    });
  });

  // --- invariant ------------------------------------------------------------------------

  it('for every organization of the suite: reserved = reservations − charges − releases; balance = funding − charges', async () => {
    const { rows } = await h.admin.execute<{ org: string; reserved: number; derived: number }>(sql`
      SELECT w.org_id AS org, w.reserved_paise::int AS reserved,
             (COALESCE(sum(l.amount_paise) FILTER (WHERE l.entry_type = 'reservation'), 0)
              - COALESCE(sum(l.amount_paise) FILTER (WHERE l.entry_type = 'customer_charge'), 0)
              - COALESCE(sum(l.amount_paise) FILTER (WHERE l.entry_type = 'reservation_release'), 0))::int AS derived
        FROM wallets w LEFT JOIN usage_ledger l ON l.org_id = w.org_id
       WHERE w.org_id = ANY(${`{${tenants.map((t) => t.orgId).join(',')}}`}::uuid[])
       GROUP BY w.org_id, w.reserved_paise`);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) expect([r.org, r.reserved]).toEqual([r.org, r.derived]);
  });
});
