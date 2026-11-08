/**
 * Phase 5.0 PR-E (implementation plan T11; design spec Rev 2 §B.6a, §B.7, §B.8, §F.3) — the
 * escalation-race fixture against the REAL delivery ingestion (signed receipts over the HTTP
 * ingress, ingress enabled for this suite).
 *
 * - AC-LT-5: the fixture affects a message only when E1–E4 hold; it is a no-op for queued,
 *   routing, submitting, failed, outcome_unknown, not_supported and undelivered, for a stale
 *   expected attempt (E1), and when any attempt is delivered (E4).
 * - AC-LT-3: run against ingestion of a delivered receipt for the same attempt — forced in each
 *   order, then many concurrent iterations — exactly one of them acts on the eligible state
 *   first; the delivery outcome is never lost; the submission status is never rewritten; no
 *   deadlock or unhandled failure; no attempt is created, requeued or cancelled (§B.6a).
 *
 * What it does NOT prove: a real Phase 5 escalation (superseding the attempt, a new send), the
 * `message.delivered_after_escalation` event (5.0 has no escalation state to detect), or any
 * timer — none exists in 5.0. See `phase5_0-escalation-fixture.ts`.
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import type { Harness, TenantFixture } from './auth-harness';
import { runEscalationFixture } from './phase5_0-escalation-fixture';
import {
  channelId,
  cleanWorld,
  delivered,
  ingressProvider,
  plantMessage,
  post,
  webhookEnvironment,
  type WebhookWorld,
} from './phase5_0-webhook-fixtures';

jest.setTimeout(240_000);

const ITERATIONS = 40;

describe('Phase 5.0 PR-E — escalation-race fixture vs delivery ingestion (AC-LT-3, AC-LT-5)', () => {
  let restoreEnv: () => void;
  let h: Harness;
  let A: TenantFixture;
  let world: WebhookWorld;
  let provider: { id: string; key: string };
  let destroyTenant: typeof import('./auth-harness').destroyTenant;

  beforeAll(async () => {
    restoreEnv = webhookEnvironment({
      DELIVERY_WEBHOOKS_ENABLED: 'true',
      REDIS_KEY_PREFIX: `acc-test-p50e-esc-${randomBytes(4).toString('hex')}`,
    });
    const harness = await import('./auth-harness');
    destroyTenant = harness.destroyTenant;
    h = await harness.startHarness();
    A = await harness.createTenant(h.admin, 'p50e-esc', h.app.get(CredentialService));
    world = { channelId: await channelId(h, 'whatsapp'), providers: [], contacts: new Map() };
    provider = await ingressProvider(h, world);
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanWorld(h, world, A ? [A.orgId] : []);
      if (A) await destroyTenant(h.admin, A);
    } finally {
      await h?.close();
      restoreEnv?.();
    }
  });

  const message = async (id: string) =>
    (await h.admin.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;
  const attempts = async (messageId: string) =>
    h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, messageId))
      .orderBy(schema.messageAttempts.attemptNumber);
  /** A message accepted on one attempt whose delivery is pending: escalation-eligible. */
  const eligible = () =>
    plantMessage(h, world, A, [{ provider: provider.id, status: 'accepted' }]).then((m) => ({
      messageId: m.messageId,
      attemptId: m.attemptIds[0]!,
    }));
  /** An in-flight message with no attempt yet, planted directly in `status`. */
  const inFlight = async (status: 'queued' | 'routing') => {
    const m = await plantMessage(h, world, A, [], 'submitting');
    await h.admin.execute(sql`DELETE FROM messages WHERE id = ${m.messageId}`);
    const id = uuidv7();
    await h.admin.execute(sql`
      INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address,
                            payload, correlation_id)
      VALUES (${id}, ${A.orgId}, ${A.workspaceId}, ${world.contacts.get(A.orgId)!}, ${world.channelId},
              ${status}::message_status, '+12025550190', '{"text":"P50E"}'::jsonb, ${uuidv7()})`);
    return id;
  };
  /** Marks attempt `attemptId` (and its message) delivered as the owner would after a receipt. */
  const markDelivered = async (messageId: string, attemptId: string) => {
    await h.admin
      .execute(sql`UPDATE message_attempts SET delivery_status = 'delivered', delivered_at = now()
                               WHERE id = ${attemptId}`);
    await h.admin
      .execute(sql`UPDATE messages SET delivery_status = 'delivered', delivered_at = now(),
                                                  delivered_attempt_id = ${attemptId}
                               WHERE id = ${messageId}`);
  };
  /** The message row without updated_at (the only column the fixture writes). */
  const withoutUpdatedAt = (m: typeof schema.messages.$inferSelect) => {
    const { updatedAt: _u, ...rest } = m;
    return rest;
  };

  // ===========================================================================
  describe('AC-LT-5: eligibility (E1–E4)', () => {
    it('eligible: accepted, current attempt accepted and pending, nothing delivered — affects exactly the marker', async () => {
      const t = await eligible();
      const before = await message(t.messageId);
      const beforeAttempts = await attempts(t.messageId);
      const r = await runEscalationFixture(h, t.messageId, t.attemptId);
      expect(r).toEqual({ affected: 1, sawAttemptDelivery: 'pending' });
      // Only updated_at moved: no status, attempt or delivery column was touched.
      expect(withoutUpdatedAt(await message(t.messageId))).toEqual(withoutUpdatedAt(before));
      expect(await attempts(t.messageId)).toEqual(beforeAttempts);
    });

    it('E1: a stale expected attempt (another attempt is current) is a no-op', async () => {
      const m = await plantMessage(h, world, A, [
        { provider: provider.id, status: 'failed' },
        { provider: provider.id, status: 'accepted' },
      ]);
      expect((await runEscalationFixture(h, m.messageId, m.attemptIds[0]!)).affected).toBe(0);
      expect((await runEscalationFixture(h, m.messageId, uuidv7())).affected).toBe(0);
      expect((await runEscalationFixture(h, m.messageId, m.attemptIds[1]!)).affected).toBe(1);
    });

    it('not eligible: queued, routing, submitting, failed, outcome_unknown, not_supported, undelivered, any attempt delivered', async () => {
      const cases: [string, string, string][] = [];
      for (const status of ['queued', 'routing'] as const) {
        cases.push([status, await inFlight(status), uuidv7()]);
      }
      const submitting = await plantMessage(h, world, A, [
        { provider: provider.id, status: 'submitting' },
      ]);
      cases.push(['submitting', submitting.messageId, submitting.attemptIds[0]!]);
      const failed = await plantMessage(h, world, A, [{ provider: provider.id, status: 'failed' }]);
      cases.push(['failed', failed.messageId, failed.attemptIds[0]!]);
      const unknown = await plantMessage(h, world, A, [
        { provider: provider.id, status: 'outcome_unknown' },
      ]);
      cases.push(['outcome_unknown', unknown.messageId, unknown.attemptIds[0]!]);
      for (const delivery of ['not_supported', 'undelivered']) {
        const m = await plantMessage(h, world, A, [
          { provider: provider.id, status: 'accepted', delivery },
        ]);
        cases.push([delivery, m.messageId, m.attemptIds[0]!]);
      }
      // Attempt 1 (superseded) delivered; attempt 2 current, accepted and pending: E4 refuses.
      const late = await plantMessage(h, world, A, [
        { provider: provider.id, status: 'accepted' },
        { provider: provider.id, status: 'accepted' },
      ]);
      await markDelivered(late.messageId, late.attemptIds[0]!);
      cases.push(['an earlier attempt delivered', late.messageId, late.attemptIds[1]!]);
      // The current attempt itself delivered.
      const done = await eligible();
      await markDelivered(done.messageId, done.attemptId);
      cases.push(['current attempt delivered', done.messageId, done.attemptId]);

      for (const [label, messageId, expected] of cases) {
        const before = await message(messageId);
        const r = await runEscalationFixture(h, messageId, expected);
        expect([label, r.affected]).toEqual([label, 0]);
        expect([label, await message(messageId)]).toEqual([label, before]);
      }
    });

    it('safe to repeat: once a receipt is applied every later run is a no-op; before it, each run moves only the marker', async () => {
      const t = await eligible();
      expect((await runEscalationFixture(h, t.messageId, t.attemptId)).affected).toBe(1);
      expect((await runEscalationFixture(h, t.messageId, t.attemptId)).affected).toBe(1);
      expect((await post(h, provider.key, [delivered(t.attemptId)])).status).toBe(200);
      for (let i = 0; i < 3; i += 1) {
        expect((await runEscalationFixture(h, t.messageId, t.attemptId)).affected).toBe(0);
      }
      const m = await message(t.messageId);
      expect([m.status, m.deliveryStatus]).toEqual(['accepted', 'delivered']);
    });
  });

  // ===========================================================================
  describe('AC-LT-3: the race against real ingestion', () => {
    /** Asserts the end state every ordering must reach for one eligible message. */
    async function assertSettled(t: { messageId: string; attemptId: string }) {
      const m = await message(t.messageId);
      const as = await attempts(t.messageId);
      // The delivery outcome is never lost and the submission status never rewritten.
      expect([m.status, m.deliveryStatus, m.deliveredAttemptId]).toEqual([
        'accepted',
        'delivered',
        t.attemptId,
      ]);
      expect(m.deliveredAt).not.toBeNull();
      // No attempt created, requeued or cancelled (§B.6a).
      expect(as.map((a) => [a.id, a.status, a.deliveryStatus])).toEqual([
        [t.attemptId, 'accepted', 'delivered'],
      ]);
      const queued = await h.admin.execute(
        sql`SELECT 1 FROM message_dispatch_queue WHERE message_id = ${t.messageId}`,
      );
      expect(queued.rows).toHaveLength(0);
      const rows = (
        await h.admin.execute<{ outcome: string }>(
          sql`SELECT outcome FROM webhook_events WHERE matched_attempt_id = ${t.attemptId}`,
        )
      ).rows;
      expect(rows.map((r) => r.outcome)).toEqual(['applied']);
    }

    it('escalation first (holds the §B.8 locks): it wins; the receipt then waits, applies, and nothing is lost', async () => {
      const t = await eligible();
      let receipt: Promise<{ status: number }> | undefined;
      const escalation = runEscalationFixture(h, t.messageId, t.attemptId, {
        holdMs: 400,
        // The receipt is sent only once the escalation holds the locks: it must wait.
        onLocked: () => {
          receipt = post(h, provider.key, [delivered(t.attemptId)]).then((r) => ({
            status: r.status,
          }));
        },
      });
      const r = await escalation;
      expect(r).toEqual({ affected: 1, sawAttemptDelivery: 'pending' });
      expect((await receipt!).status).toBe(200);
      await assertSettled(t);
    });

    it('ingestion first: the receipt commits; the escalation that follows is a no-op', async () => {
      const t = await eligible();
      expect((await post(h, provider.key, [delivered(t.attemptId)])).status).toBe(200);
      const r = await runEscalationFixture(h, t.messageId, t.attemptId);
      expect(r).toEqual({ affected: 0, sawAttemptDelivery: 'delivered' });
      await assertSettled(t);
    });

    it(`${ITERATIONS} concurrent races: exactly one winner each time, consistent with what it saw; no lost outcome; no deadlock`, async () => {
      const tally = { escalationFirst: 0, ingestionFirst: 0 };
      const failures: string[] = [];
      for (let i = 0; i < ITERATIONS; i += 1) {
        const t = await eligible();
        const jitter = (maxMs: number) =>
          new Promise((r) => setTimeout(r, Math.floor(Math.random() * maxMs)));
        // The receipt's HTTP path is slower than the escalation's direct SQL: the escalation's
        // start is spread across the receipt's typical latency so both orders occur.
        const [esc, ing] = await Promise.allSettled([
          jitter(60).then(() => runEscalationFixture(h, t.messageId, t.attemptId)),
          jitter(5).then(() => post(h, provider.key, [delivered(t.attemptId)])),
        ]);
        if (esc.status === 'rejected') failures.push(`escalation ${i}: ${String(esc.reason)}`);
        if (ing.status === 'rejected') failures.push(`ingestion ${i}: ${String(ing.reason)}`);
        if (esc.status !== 'fulfilled' || ing.status !== 'fulfilled') continue;
        expect(ing.value.status).toBe(200);
        // Exactly one acted on the eligible state first, and the escalation's verdict matches what
        // it saw under its locks: it acts only on a pending attempt, never after the receipt.
        if (esc.value.affected === 1) {
          expect(esc.value.sawAttemptDelivery).toBe('pending');
          tally.escalationFirst += 1;
        } else {
          expect(esc.value).toEqual({ affected: 0, sawAttemptDelivery: 'delivered' });
          tally.ingestionFirst += 1;
        }
        await assertSettled(t);
      }
      expect(failures).toEqual([]);
      expect(tally.escalationFirst + tally.ingestionFirst).toBe(ITERATIONS);
      // Reported, not asserted: which side wins a free race depends on scheduling. Both orders
      // are forced deterministically by the two tests above.
      console.info(`escalation-race tally: ${JSON.stringify(tally)}`);
    });
  });
});
