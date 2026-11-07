/**
 * Phase 5.0 (PR-B, T6) — dispatcher settlement on the delivery axis, under the real
 * `acc_dispatch` and `acc_delivery` principals. Design spec Rev 2 §B.3, §B.5, §B.6a, §B.8,
 * §E.6; implementation plan T6; acceptance criteria AC-LK-1, AC-LK-2, AC-IN-3 (settlement
 * half), AC-SIM-2, AC-ST-4.
 *
 * The dispatcher is built over a thin wrapper of the real submission executor, so a test can
 * act while the attempt is `submitting` — between the committed intent transaction and the
 * settlement transaction — exactly where a receipt can be held (`deferred`) or race the
 * settlement. The receipt side uses the shared delivery writer that PR-C's ingestion will use,
 * as `acc_delivery` (a stand-in for the not-yet-built HTTP pipeline, step 7 of spec §E.3).
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { DISPATCH_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import { applyDeliveryEvent, lockMessage } from '../src/messages/delivery/delivery-writer';
import { DispatcherService } from '../src/messages/dispatch/dispatcher.service';
import { ProviderSubmissionExecutor } from '../src/provider-adapters/submission-executor';
import { ProviderStateStore } from '../src/providers/provider-state.store';
import {
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  purgeProviderHealth,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

jest.setTimeout(240_000);

type Hook = (submission: { submissionId: string }) => Promise<void> | void;

describe('Phase 5.0 settlement — delivery axis, held receipts, lock order (PR-B, T6)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let dispatchPool: Pool;
  let deliveryPool: Pool;
  let executor: ProviderSubmissionExecutor;
  let stateStore: ProviderStateStore;
  let channelId: string;
  let tenant: TenantFixture;
  const providers: string[] = [];

  /** A dispatcher whose executor runs `hook` while the attempt is submitting. */
  function dispatcherWith(hook?: Hook): DispatcherService {
    const wrapped = {
      execute: async (...args: Parameters<ProviderSubmissionExecutor['execute']>) => {
        if (hook) await hook(args[1] as { submissionId: string });
        return executor.execute(...args);
      },
    } as unknown as ProviderSubmissionExecutor;
    return new DispatcherService(dispatchPool, stateStore, wrapped);
  }

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    dispatchPool = h.app.get(DISPATCH_POOL);
    executor = h.app.get(ProviderSubmissionExecutor);
    stateStore = h.app.get(ProviderStateStore);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'acc_delivery';
    url.password = process.env.DATABASE_DELIVERY_PASSWORD ?? 'acc_delivery_dev_password';
    deliveryPool = new Pool({ connectionString: url.toString(), max: 4 });
    const [c] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    channelId = c!.id;
    tenant = await createTenant(h.admin, 'p50-settle', credentials);
  }, 60_000);

  beforeEach(async () => {
    await h.admin.delete(schema.messageDispatchQueue);
  });

  afterAll(async () => {
    try {
      await deliveryPool?.end();
      if (dispatchPool) await dispatchPool.end();
      if (providers.length > 0) {
        await h.admin.execute(
          sql`DELETE FROM webhook_events WHERE provider_id IN (${sql.join(
            providers.map((p) => sql`${p}::uuid`),
            sql`, `,
          )})`,
        );
        await purgeProviderHealth(h.admin, inArray(schema.providerHealth.providerId, providers));
      }
      if (tenant) {
        await h.admin.delete(schema.messageDispatchQueue).catch(() => {});
        await purgeMessageEvents(h.admin, eq(schema.messageEvents.orgId, tenant.orgId));
        // The write-once delivery guard refuses even the owner; teardown only.
        await h.admin.execute(sql`ALTER TABLE messages DISABLE TRIGGER USER`);
        try {
          await h.admin.execute(
            sql`UPDATE messages SET delivered_attempt_id = NULL WHERE org_id = ${tenant.orgId} AND delivered_attempt_id IS NOT NULL`,
          );
        } finally {
          await h.admin.execute(sql`ALTER TABLE messages ENABLE TRIGGER USER`);
        }
        await h.admin
          .delete(schema.messageAttempts)
          .where(eq(schema.messageAttempts.orgId, tenant.orgId));
        await h.admin.delete(schema.messages).where(eq(schema.messages.orgId, tenant.orgId));
        await h.admin.delete(schema.contacts).where(eq(schema.contacts.orgId, tenant.orgId));
        await h.admin
          .delete(schema.organizationProviderAssignments)
          .where(eq(schema.organizationProviderAssignments.orgId, tenant.orgId));
      }
      if (providers.length > 0) {
        await h.admin
          .delete(schema.providerCapabilities)
          .where(inArray(schema.providerCapabilities.providerId, providers));
        await h.admin.delete(schema.providers).where(inArray(schema.providers.id, providers));
      }
      if (tenant) await destroyTenant(h.admin, tenant);
    } finally {
      await h.close();
    }
  });

  async function provider(
    label: string,
    behavior: string,
    receipts: string[] | null = ['delivered', 'undelivered', 'read'],
  ): Promise<string> {
    const slug = `${label}-${randomBytes(4).toString('hex')}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `P50 settlement ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(p!.id);
    await h.admin
      .insert(schema.providerCapabilities)
      .values({ providerId: p!.id, capabilityKey: 'simulator_behavior', value: behavior });
    if (receipts) {
      await h.admin
        .insert(schema.providerCapabilities)
        .values({ providerId: p!.id, capabilityKey: 'delivery_receipts', value: receipts });
    }
    return p!.id;
  }

  /**
   * Makes exactly `providerIds` (in priority order) the tenant's active assignments. Earlier
   * assignments are disabled, not deleted: their attempts still reference them.
   */
  let nextPriority = 1;
  async function assignOnly(providerIds: string[]): Promise<void> {
    await h.admin
      .update(schema.organizationProviderAssignments)
      .set({ status: 'disabled' })
      .where(eq(schema.organizationProviderAssignments.orgId, tenant.orgId));
    for (const providerId of providerIds) {
      await h.admin.insert(schema.organizationProviderAssignments).values({
        orgId: tenant.orgId,
        channelId,
        providerId,
        priority: nextPriority++,
        status: 'active',
      });
    }
  }

  async function queued(): Promise<string> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: tenant.orgId,
      workspaceId: tenant.workspaceId,
      displayName: 'P50 settlement recipient',
    });
    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: tenant.orgId,
      workspaceId: tenant.workspaceId,
      contactId,
      channelId,
      recipientAddress: '+12025550181',
      status: 'queued',
      payload: { text: 'P50 settlement message' },
      correlationId: uuidv7(),
    });
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: tenant.orgId,
      priority: 1,
      dispatchEpoch: 0,
      claimedUntil: null,
      claimToken: null,
    });
    return messageId;
  }

  async function dispatchOnce(dispatcher: DispatcherService, messageId: string) {
    const [claim] = await dispatcher.claimBatch(1);
    expect(claim?.messageId).toBe(messageId);
    return dispatcher.processClaim(claim!);
  }

  const attemptsOf = (messageId: string) =>
    h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, messageId))
      .orderBy(schema.messageAttempts.attemptNumber);
  const messageOf = async (messageId: string) =>
    (await h.admin.select().from(schema.messages).where(eq(schema.messages.id, messageId)))[0]!;
  const eventsOf = async (messageId: string, type: string) =>
    h.admin
      .select()
      .from(schema.messageEvents)
      .where(
        and(
          eq(schema.messageEvents.messageId, messageId),
          eq(schema.messageEvents.eventType, type),
        ),
      );

  /** Plants a held receipt (as the owner) the way the ingress records one before settlement. */
  async function holdReceipt(
    providerId: string,
    outcome: 'deferred' | 'unmatched',
    envelope: Record<string, unknown>,
    matchedAttemptId: string | null = null,
  ): Promise<string> {
    const id = uuidv7();
    await h.admin.execute(sql`
      INSERT INTO webhook_events (id, provider_id, request_id, event_index, event_sha256, outcome,
                                  matched_attempt_id, matched_org_id, normalized)
      VALUES (${id}, ${providerId}, ${uuidv7()}, 0, ${createHash('sha256').update(randomBytes(16)).digest()},
              ${outcome}, ${matchedAttemptId}, ${matchedAttemptId ? tenant.orgId : null},
              ${JSON.stringify(envelope)}::jsonb)`);
    return id;
  }

  const webhookRow = async (id: string) =>
    (
      await h.admin.execute<{ outcome: string; matched_attempt_id: string | null }>(
        sql`SELECT outcome, matched_attempt_id FROM webhook_events WHERE id = ${id}`,
      )
    ).rows[0]!;

  // ===========================================================================
  describe('settlement writes the provider reference and the initial delivery status', () => {
    it('accepted: the attempt id is the submission reference; provider message id sim-<attemptId>; pending', async () => {
      const p = await provider('acc', 'SUCCESS');
      await assignOnly([p]);
      const messageId = await queued();
      let submissionId = '';
      const result = await dispatchOnce(
        dispatcherWith((s) => {
          submissionId = s.submissionId;
        }),
        messageId,
      );
      expect(result).toMatchObject({ messageId, outcome: 'accepted' });
      const [a] = await attemptsOf(messageId);
      expect(submissionId).toBe(a!.id); // OD-8
      expect(a).toMatchObject({
        status: 'accepted',
        providerMessageId: `sim-${a!.id}`,
        deliveryStatus: 'pending',
        deliveredAt: null,
        readAt: null,
      });
      expect(a!.deliveryUpdatedAt).not.toBeNull();
      expect(await messageOf(messageId)).toMatchObject({
        status: 'accepted',
        deliveryStatus: 'pending',
        deliveredAttemptId: null,
      });
    });

    it('a provider declaring no receipts settles not_supported, never "awaiting"', async () => {
      const p = await provider('norcpt', 'SUCCESS', null);
      await assignOnly([p]);
      const messageId = await queued();
      expect((await dispatchOnce(dispatcherWith(), messageId)).outcome).toBe('accepted');
      const [a] = await attemptsOf(messageId);
      expect(a!.deliveryStatus).toBe('not_supported');
      expect((await messageOf(messageId)).deliveryStatus).toBe('not_supported');
    });

    it('outcome unknown (timeout): delivery tracked as pending, no provider message id, status unchanged', async () => {
      const p = await provider('timeout', 'TIMEOUT');
      await assignOnly([p]);
      const messageId = await queued();
      expect((await dispatchOnce(dispatcherWith(), messageId)).outcome).toBe('unknown');
      const [a] = await attemptsOf(messageId);
      expect(a).toMatchObject({
        status: 'outcome_unknown',
        providerMessageId: null,
        deliveryStatus: 'pending',
      });
      expect(await messageOf(messageId)).toMatchObject({
        status: 'outcome_unknown',
        deliveryStatus: 'pending',
      });
    });

    it('same-channel fallback: each attempt gets its own provider message id; the failed attempt stays untracked (AC-SIM-2)', async () => {
      const p1 = await provider('fb500', '500');
      const p2 = await provider('fbok', 'SUCCESS');
      await assignOnly([p1, p2]);
      const messageId = await queued();
      const dispatcher = dispatcherWith();
      expect((await dispatchOnce(dispatcher, messageId)).outcome).toBe('failed');
      expect((await dispatchOnce(dispatcher, messageId)).outcome).toBe('accepted');
      const [a1, a2] = await attemptsOf(messageId);
      expect(a1).toMatchObject({ status: 'failed', providerMessageId: null, deliveryStatus: null });
      expect(a2).toMatchObject({
        status: 'accepted',
        providerMessageId: `sim-${a2!.id}`,
        deliveryStatus: 'pending',
      });
      expect(a1!.id).not.toBe(a2!.id);
      expect((await messageOf(messageId)).deliveryStatus).toBe('pending');
    });
  });

  // ===========================================================================
  describe('receipts held while submitting are applied by settlement, exactly once (§E.6)', () => {
    it('a deferred receipt matched to the attempt: delivered on attempt and message, one message.delivered', async () => {
      const p = await provider('held', 'SUCCESS');
      await assignOnly([p]);
      const messageId = await queued();
      let held = '';
      const dispatcher = dispatcherWith(async (s) => {
        held = await holdReceipt(
          p,
          'deferred',
          {
            kind: 'delivered',
            clientReference: s.submissionId,
            occurredAt: '2026-11-07T00:00:00.000Z',
          },
          s.submissionId,
        );
      });
      expect((await dispatchOnce(dispatcher, messageId)).outcome).toBe('accepted');
      const [a] = await attemptsOf(messageId);
      expect(a).toMatchObject({ status: 'accepted', deliveryStatus: 'delivered' });
      expect(a!.deliveredAt?.toISOString()).toBe('2026-11-07T00:00:00.000Z');
      const m = await messageOf(messageId);
      expect(m).toMatchObject({
        status: 'accepted',
        deliveryStatus: 'delivered',
        deliveredAttemptId: a!.id,
      });
      expect(await webhookRow(held)).toEqual({ outcome: 'applied', matched_attempt_id: a!.id });
      expect(await eventsOf(messageId, 'message.delivered')).toHaveLength(1);
    });

    it('an unmatched receipt naming the new provider message id is matched and applied; another provider’s is not', async () => {
      const p = await provider('unm', 'SUCCESS');
      const other = await provider('unm-other', 'SUCCESS');
      await assignOnly([p]);
      const messageId = await queued();
      let mine = '';
      let foreign = '';
      const dispatcher = dispatcherWith(async (s) => {
        mine = await holdReceipt(p, 'unmatched', {
          kind: 'undelivered',
          providerMessageId: `sim-${s.submissionId}`,
        });
        foreign = await holdReceipt(other, 'unmatched', {
          kind: 'delivered',
          clientReference: s.submissionId,
        });
      });
      expect((await dispatchOnce(dispatcher, messageId)).outcome).toBe('accepted');
      const [a] = await attemptsOf(messageId);
      expect(a!.deliveryStatus).toBe('undelivered');
      expect((await messageOf(messageId)).deliveryStatus).toBe('undelivered');
      expect(await webhookRow(mine)).toEqual({ outcome: 'applied', matched_attempt_id: a!.id });
      expect(await webhookRow(foreign)).toEqual({ outcome: 'unmatched', matched_attempt_id: null });
    });

    it('a held receipt on a terminally failed attempt: recorded on the delivery axis, submission status stays failed (AC-ST-4)', async () => {
      const p = await provider('failheld', 'INVALID_REQUEST');
      await assignOnly([p]);
      const messageId = await queued();
      let held = '';
      const dispatcher = dispatcherWith(async (s) => {
        held = await holdReceipt(
          p,
          'deferred',
          { kind: 'delivered', clientReference: s.submissionId },
          s.submissionId,
        );
      });
      expect((await dispatchOnce(dispatcher, messageId)).outcome).toBe('failed');
      const [a] = await attemptsOf(messageId);
      expect(a).toMatchObject({ status: 'failed', deliveryStatus: 'delivered' });
      expect(await messageOf(messageId)).toMatchObject({
        status: 'failed',
        deliveryStatus: 'delivered',
      });
      const [ev] = await eventsOf(messageId, 'message.delivered');
      expect((ev!.payload as { flags?: string[] }).flags).toContain('after_submission_failure');
      expect((await webhookRow(held)).outcome).toBe('applied');
    });

    it('a held receipt during a fallback requeue updates only the failed attempt and never cancels the requeue (§B.6a)', async () => {
      const p1 = await provider('rq500', '500');
      const p2 = await provider('rqok', 'SUCCESS');
      await assignOnly([p1, p2]);
      const messageId = await queued();
      let first = true;
      const dispatcher = dispatcherWith(async (s) => {
        if (!first) return;
        first = false;
        await holdReceipt(
          p1,
          'deferred',
          { kind: 'undelivered', clientReference: s.submissionId },
          s.submissionId,
        );
      });
      expect((await dispatchOnce(dispatcher, messageId)).outcome).toBe('failed');
      const afterFirst = await messageOf(messageId);
      expect(afterFirst.status).toBe('queued'); // the requeue proceeded
      expect(afterFirst.deliveryStatus).toBeNull(); // mirrors the (now absent) current attempt
      expect((await dispatchOnce(dispatcher, messageId)).outcome).toBe('accepted');
      const [a1, a2] = await attemptsOf(messageId);
      expect(a1).toMatchObject({ status: 'failed', deliveryStatus: 'undelivered' });
      expect(a2).toMatchObject({ status: 'accepted', deliveryStatus: 'pending' });
      expect((await messageOf(messageId)).deliveryStatus).toBe('pending');
    });
  });

  // ===========================================================================
  /** A receipt for `attemptId` as PR-C's ingestion will apply it (spec §E.3 step 7), as acc_delivery. */
  async function ingest(
    providerId: string,
    messageId: string,
    attemptId: string,
  ): Promise<'deferred' | string> {
    const c: PoolClient = await deliveryPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.current_org_id', $1, true),
                set_config('app.delivery_provider_id', $2, true),
                set_config('app.delivery_message_id', $3, true)`,
        [tenant.orgId, providerId, messageId],
      );
      await lockMessage(c, messageId); // §B.8: message first
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM message_attempts WHERE id = $1 FOR UPDATE`,
        [attemptId],
      );
      const eventId = uuidv7();
      const envelope = { kind: 'delivered', clientReference: attemptId };
      await c.query(
        `INSERT INTO webhook_events (id, provider_id, request_id, event_index, event_sha256, outcome, normalized)
         VALUES ($1, $2, $3, 0, $4, 'unmatched', $5)`,
        [
          eventId,
          providerId,
          uuidv7(),
          createHash('sha256').update(randomBytes(16)).digest(),
          envelope,
        ],
      );
      let outcome: string;
      if (rows[0]?.status === 'submitting') {
        outcome = 'deferred';
      } else {
        const decision = await applyDeliveryEvent(c, {
          orgId: tenant.orgId,
          messageId,
          attemptId,
          kind: 'delivered',
          occurredAt: null,
          receipts: new Set(['delivered', 'undelivered']),
          webhookEventId: eventId,
          now: new Date(),
        });
        outcome = decision.outcome;
      }
      await c.query(
        `UPDATE webhook_events SET outcome = $2, matched_attempt_id = $3, matched_org_id = $4, processed_at = now() WHERE id = $1`,
        [eventId, outcome, attemptId, tenant.orgId],
      );
      await c.query('COMMIT');
      return outcome;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  describe('lock order: message, then attempt (§B.8)', () => {
    it('AC-LK-2: with the message row held elsewhere, settlement waits before locking the attempt', async () => {
      const p = await provider('lk2', 'SUCCESS');
      await assignOnly([p]);
      const messageId = await queued();
      const admin = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 3 });
      const holder = await admin.connect();
      let attemptId = '';
      try {
        const dispatcher = dispatcherWith(async (s) => {
          attemptId = s.submissionId;
          await holder.query('BEGIN');
          await holder.query('SELECT 1 FROM messages WHERE id = $1 FOR UPDATE', [messageId]);
        });
        const settling = dispatchOnce(dispatcher, messageId);
        // Wait until settlement is blocked on the message row lock.
        const deadline = Date.now() + 20_000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const { rows } = await admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE usename = 'acc_dispatch' AND wait_event_type = 'Lock' AND query ILIKE '%FROM messages WHERE id%FOR UPDATE%'`,
          );
          waiting = rows[0]!.n > 0;
          if (!waiting) await new Promise((r) => setImmediate(r));
        }
        expect(waiting).toBe(true);
        // The attempt is not locked by the waiting settlement: a NOWAIT lock succeeds.
        const probe = await admin.connect();
        try {
          await probe.query('BEGIN');
          await expect(
            probe.query('SELECT 1 FROM message_attempts WHERE id = $1 FOR UPDATE NOWAIT', [
              attemptId,
            ]),
          ).resolves.toBeDefined();
          await probe.query('ROLLBACK');
        } finally {
          probe.release();
        }
        await holder.query('ROLLBACK');
        expect((await settling).outcome).toBe('accepted');
      } finally {
        holder.release();
        await admin.end();
      }
    });

    it('AC-LK-1: settlement racing a receipt for the same attempt, 200 times — no deadlock, applied exactly once', async () => {
      const p = await provider('lk1', 'SUCCESS', ['delivered', 'undelivered']);
      await assignOnly([p]);
      const tally: Record<string, number> = {};
      for (let i = 0; i < 200; i += 1) {
        const messageId = await queued();
        let receipt: Promise<string> | null = null;
        const dispatcher = dispatcherWith((s) => {
          const jitter = i % 4; // 0–3 ms: sometimes before settlement, sometimes during it
          receipt = new Promise<string>((resolve, reject) => {
            setTimeout(() => {
              ingest(p, messageId, s.submissionId).then(resolve, reject);
            }, jitter);
          });
        });
        const settled = await dispatchOnce(dispatcher, messageId);
        expect(settled.outcome).toBe('accepted');
        const path = await receipt!;
        tally[path] = (tally[path] ?? 0) + 1;
        const [a] = await attemptsOf(messageId);
        expect(a!.deliveryStatus).toBe('delivered');
        expect(await eventsOf(messageId, 'message.delivered')).toHaveLength(1);
        const { rows } = await h.admin.execute<{ outcome: string }>(
          sql`SELECT outcome FROM webhook_events WHERE matched_attempt_id = ${a!.id}`,
        );
        expect(rows.map((r) => r.outcome)).toEqual(['applied']);
      }
      expect(Object.values(tally).reduce((x, y) => x + y, 0)).toBe(200);
      // Both orders occur in practice; record the split in the test output.
      console.log(`AC-LK-1 receipt paths over 200 races: ${JSON.stringify(tally)}`);
    });
  });
});
