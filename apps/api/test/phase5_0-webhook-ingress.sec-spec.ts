/**
 * Phase 5.0 PR-C — the provider webhook ingress, end to end over real HTTP, with
 * `DELIVERY_WEBHOOKS_ENABLED=true` for this suite only (the deployment default is false).
 * Design spec Rev 2 §E; implementation plan §1.1–§1.3, T8.
 *
 * Acceptance criteria: AC-SV-1, -2, -3, -5 (grace), -6 (bodies, metrics); AC-IN-1, -2, -3
 * (ingress side), -4; AC-MB-1, -2, -3; AC-ID-1, -1a, -2, -3; AC-TI-1, -2; AC-ST-4, -5;
 * AC-LT-1, -2, -4; AC-RB-1. AC-RL-1: `phase5_0-webhook-ratelimit.sec-spec.ts`. Log and span redaction: `webhooks/ingress-path.spec.ts`.
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { DELIVERY_POOL } from '../src/database/database.tokens';
import {
  SIMULATOR_SIGNATURE_HEADER,
  signSimulatorWebhook,
} from '../src/provider-adapters/simulator-webhook';
import { generateIngressKey, hashIngressKey } from '../src/webhooks/ingress-key';
import { CredentialService } from '../src/iam/credential.service';
import { DeliveryIngestionService } from '../src/webhooks/delivery-ingestion.service';
import type { Harness, TenantFixture } from './auth-harness';
import {
  channelId,
  cleanWorld,
  delivered,
  factory,
  ingressProvider,
  plantMessage,
  post,
  INGRESS_PREFIX,
  postRaw,
  TEST_PEPPER,
  TEST_SIGNING_KEY,
  webhookEnvironment,
  type WebhookWorld,
} from './phase5_0-webhook-fixtures';

jest.setTimeout(120_000);

describe('Phase 5.0 PR-C — provider webhook ingress (enabled for this suite)', () => {
  let restoreEnv: () => void;
  let h: Harness;
  let A: TenantFixture;
  let B: TenantFixture;
  let world: WebhookWorld;
  let createTenant: typeof import('./auth-harness').createTenant;
  let destroyTenant: typeof import('./auth-harness').destroyTenant;

  beforeAll(async () => {
    restoreEnv = webhookEnvironment({
      DELIVERY_WEBHOOKS_ENABLED: 'true',
      // Isolated rate-limit buckets for this suite.
      REDIS_KEY_PREFIX: `acc-test-p50c-${randomBytes(4).toString('hex')}`,
    });
    // Loaded only now: ConfigModule.forRoot validates the environment when AppModule is
    // imported, so the harness must be imported after the suite's environment is set.
    const harness = await import('./auth-harness');
    ({ createTenant, destroyTenant } = harness);
    h = await harness.startHarness();
    const credentials = h.app.get(CredentialService);
    A = await createTenant(h.admin, 'p50c-a', credentials);
    B = await createTenant(h.admin, 'p50c-b', credentials);
    world = { channelId: await channelId(h, 'whatsapp'), providers: [], contacts: new Map() };
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanWorld(
        h,
        world,
        [A, B].filter(Boolean).map((t) => t.orgId),
      );
      for (const t of [A, B]) if (t) await destroyTenant(h.admin, t);
    } finally {
      await h?.close();
      restoreEnv?.();
    }
  });

  const rows = async (providerId: string) =>
    (
      await h.admin.execute<{
        id: string;
        request_id: string;
        event_index: number;
        provider_event_id: string | null;
        outcome: string;
        matched_attempt_id: string | null;
        matched_org_id: string | null;
        duplicate_count: number;
        normalized: Record<string, unknown>;
      }>(
        sql`SELECT id, request_id, event_index, provider_event_id, outcome, matched_attempt_id, matched_org_id,
                   duplicate_count, normalized
              FROM webhook_events WHERE provider_id = ${providerId} ORDER BY id`,
      )
    ).rows;
  const attempt = async (id: string) =>
    (
      await h.admin.select().from(schema.messageAttempts).where(eq(schema.messageAttempts.id, id))
    )[0]!;
  const message = async (id: string) =>
    (await h.admin.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;
  const events = async (messageId: string, type: string) =>
    h.admin
      .select()
      .from(schema.messageEvents)
      .where(
        and(
          eq(schema.messageEvents.messageId, messageId),
          eq(schema.messageEvents.eventType, type),
        ),
      );
  /** The response minus the per-request correlation id. */
  const shape = (res: request.Response) => {
    const body = JSON.parse(JSON.stringify(res.body)) as { error?: { correlationId?: string } };
    if (body.error) delete body.error.correlationId;
    return { status: res.status, body };
  };

  it('the acc_delivery pool exists only because the flag is on (fail-closed startup verified it)', () => {
    expect(h.app.get(DELIVERY_POOL)).not.toBeNull();
  });

  // ===========================================================================
  describe('a valid receipt is applied (AC-IN-1, AC-TI-2, AC-ST-4)', () => {
    it('delivered: attempt and message delivered in one transaction, one message.delivered; the payload organization is ignored', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const [a] = m.attemptIds;
      const res = await post(h, p.key, [
        // A forged organization field is not part of the format and is ignored for attribution.
        { ...delivered(a!, { occurredAt: '2026-11-07T08:00:00.000Z' }), orgId: B.orgId } as never,
      ]).expect(200);
      expect(res.body).toEqual({ data: { received: 1 } });
      expect(await attempt(a!)).toMatchObject({ status: 'accepted', deliveryStatus: 'delivered' });
      expect((await attempt(a!)).deliveredAt?.toISOString()).toBe('2026-11-07T08:00:00.000Z');
      expect(await message(m.messageId)).toMatchObject({
        status: 'accepted',
        deliveryStatus: 'delivered',
        deliveredAttemptId: a,
      });
      expect(await events(m.messageId, 'message.delivered')).toHaveLength(1);
      const [row] = await rows(p.id);
      expect(row).toMatchObject({
        outcome: 'applied',
        matched_attempt_id: a,
        matched_org_id: A.orgId,
        duplicate_count: 0,
      });
      // Redacted envelope: references and status only.
      expect(Object.keys(row!.normalized).sort()).toEqual([
        'clientReference',
        'kind',
        'occurredAt',
        'providerMessageId',
        'providerStatus',
      ]);
    });

    it('a delivered receipt after a submission timeout: delivered on the delivery axis, status stays outcome_unknown (AC-LT-1)', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [
        { provider: p.id, status: 'outcome_unknown', pmid: null },
      ]);
      const [a] = m.attemptIds;
      await post(h, p.key, [{ type: 'delivery', clientReference: a, status: 'DELIVERED' }]).expect(
        200,
      );
      expect(await attempt(a!)).toMatchObject({
        status: 'outcome_unknown',
        deliveryStatus: 'delivered',
      });
      expect(await message(m.messageId)).toMatchObject({
        status: 'outcome_unknown',
        deliveryStatus: 'delivered',
      });
    });

    it('a late receipt on attempt 1 after a same-channel fallback: attempt 1 updated, message delivered, no send created (AC-LT-2, AC-LT-4)', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [
        { provider: p.id, status: 'failed', pmid: null },
        { provider: p.id, status: 'accepted' },
      ]);
      const [a1, a2] = m.attemptIds;
      const before = await attempt(a2!);
      await post(h, p.key, [{ type: 'delivery', clientReference: a1, status: 'DELIVERED' }]).expect(
        200,
      );
      expect(await attempt(a1!)).toMatchObject({ status: 'failed', deliveryStatus: 'delivered' });
      expect(await attempt(a2!)).toEqual(before); // byte-unchanged
      expect(await message(m.messageId)).toMatchObject({
        status: 'accepted',
        deliveryStatus: 'delivered',
        deliveredAttemptId: a1,
      });
      const n = await h.admin.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM message_attempts WHERE message_id = ${m.messageId}`,
      );
      expect(n.rows[0]!.n).toBe(2);
      const queued = await h.admin.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM message_dispatch_queue WHERE message_id = ${m.messageId}`,
      );
      expect(queued.rows[0]!.n).toBe(0);
    });

    it('read: honoured only when the provider declares read; implies delivered (AC-ST-5)', async () => {
      const withRead = await ingressProvider(h, world);
      const noRead = await ingressProvider(h, world, { receipts: ['delivered', 'undelivered'] });
      const m1 = await plantMessage(h, world, A, [{ provider: withRead.id, status: 'accepted' }]);
      const m2 = await plantMessage(h, world, A, [{ provider: noRead.id, status: 'accepted' }]);
      await post(h, withRead.key, [
        { type: 'delivery', clientReference: m1.attemptIds[0], status: 'READ' },
      ]).expect(200);
      await post(h, noRead.key, [
        { type: 'delivery', clientReference: m2.attemptIds[0], status: 'READ' },
      ]).expect(200);
      const a1 = await attempt(m1.attemptIds[0]!);
      expect(a1.deliveryStatus).toBe('delivered');
      expect(a1.readAt).not.toBeNull();
      const a2 = await attempt(m2.attemptIds[0]!);
      expect(a2).toMatchObject({ deliveryStatus: 'pending', readAt: null });
      expect((await rows(noRead.id))[0]!.outcome).toBe('informational');
    });

    it('a still-submitting attempt: the receipt is recorded deferred, matched, and changes nothing (AC-IN-3, ingress side)', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [
        { provider: p.id, status: 'submitting', pmid: null },
      ]);
      const [a] = m.attemptIds;
      await post(h, p.key, [{ type: 'delivery', clientReference: a, status: 'DELIVERED' }]).expect(
        200,
      );
      expect((await attempt(a!)).deliveryStatus).toBeNull();
      expect((await rows(p.id))[0]).toMatchObject({
        outcome: 'deferred',
        matched_attempt_id: a,
        matched_org_id: A.orgId,
      });
    });

    it('a closed organization: recorded informational; none of its rows change (plan §4.3 default)', async () => {
      const credentials = h.app.get(CredentialService);
      const C = await createTenant(h.admin, 'p50c-closed', credentials);
      let providerId: string | undefined;
      try {
        const p = await ingressProvider(h, world);
        providerId = p.id;
        const m = await plantMessage(h, world, C, [{ provider: p.id, status: 'accepted' }]);
        await h.admin.execute(
          sql`UPDATE organizations SET status = 'closed', status_changed_at = now() WHERE id = ${C.orgId}`,
        );
        await post(h, p.key, [delivered(m.attemptIds[0]!)]).expect(200);
        expect((await attempt(m.attemptIds[0]!)).deliveryStatus).toBe('pending');
        expect((await rows(p.id))[0]!.outcome).toBe('informational');
      } finally {
        await cleanWorld(h, { ...world, providers: providerId ? [providerId] : [] }, [C.orgId]);
        await destroyTenant(h.admin, C);
      }
    });
  });

  // ===========================================================================
  describe('signature, key and replay (AC-SV-1, -2, -3, -5)', () => {
    it('missing, forged or stale signatures: one uniform 401, no row, a failure metric', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const element = delivered(m.attemptIds[0]!);
      const signed = factory.request([element], { nowMs: Date.now() });
      const missing = await postRaw(h, p.key, signed.rawBody, {
        'content-type': 'application/json',
      });
      const forged = await post(h, p.key, [element], { signature: 'INVALID' });
      const stale = await post(h, p.key, [element], { signature: 'STALE' });
      for (const res of [missing, forged, stale]) expect(shape(res)).toEqual(shape(forged));
      expect(forged.status).toBe(401);
      expect(forged.body.error.code).toBe('WEBHOOK_NOT_ACCEPTED');
      expect(await rows(p.id)).toEqual([]);
      expect((await attempt(m.attemptIds[0]!)).deliveryStatus).toBe('pending');
      const metrics = await request(h.app.getHttpServer()).get('/metrics');
      for (const reason of ['missing_signature', 'bad_signature', 'stale_timestamp']) {
        expect(metrics.text).toMatch(
          new RegExp(
            `acc_webhook_verification_failures_total\\{[^}]*adapter="simulator"[^}]*reason="${reason}"[^}]*\\} [1-9]`,
          ),
        );
      }
    });

    it('an unknown key, and a provider whose ingress is switched off, answer exactly like a bad signature', async () => {
      const p = await ingressProvider(h, world);
      const off = await ingressProvider(h, world, { enabled: false });
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const element = delivered(m.attemptIds[0]!);
      const bad = await post(h, p.key, [element], { signature: 'INVALID' });
      const unknown = await post(h, `x${p.key.slice(1)}`, [element]);
      const garbage = await post(h, 'not-a-key', [element]);
      const tooLong = await post(h, 'k'.repeat(200), [element]);
      const disabled = await post(h, off.key, [element]);
      for (const res of [unknown, garbage, tooLong, disabled])
        expect(shape(res)).toEqual(shape(bad));
      expect(await rows(off.id)).toEqual([]);
    });

    it('AC-SV-3: verification is over the raw bytes — the same JSON re-serialized is refused', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const signed = factory.request([delivered(m.attemptIds[0]!)], { nowMs: Date.now() });
      const reserialized = JSON.stringify(
        JSON.parse(Buffer.from(signed.rawBody).toString()),
        null,
        2,
      );
      await postRaw(h, p.key, reserialized, signed.headers).expect(401);
      await postRaw(h, p.key, signed.rawBody, signed.headers).expect(200);
    });

    it('AC-SV-5: after a rotation the previous key works until its grace expires, then is refused', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      // Rotate as the service does: current hash → previous (with an expiry), new hash current.
      const fresh = generateIngressKey();
      await h.admin.execute(sql`
        UPDATE providers SET webhook_ingress_key_previous_hash = webhook_ingress_key_hash,
                             webhook_ingress_key_previous_expires_at = now() + interval '1 hour',
                             webhook_ingress_key_hash = ${hashIngressKey(TEST_PEPPER, fresh)}
         WHERE id = ${p.id}`);
      await post(h, p.key, [delivered(m.attemptIds[0]!)]).expect(200); // previous key, in grace
      await post(h, fresh, [delivered(m.attemptIds[0]!)]).expect(200); // current key
      await h.admin.execute(
        sql`UPDATE providers SET webhook_ingress_key_previous_expires_at = now() - interval '1 second' WHERE id = ${p.id}`,
      );
      await post(h, p.key, [delivered(m.attemptIds[0]!)]).expect(401); // grace over
    });
  });

  // ===========================================================================
  describe('request shape (AC-IN-2, AC-IN-4, AC-MB-3, AC-RB-1)', () => {
    it('a body malformed as a whole after a valid signature: 400, no row', async () => {
      const p = await ingressProvider(h, world);
      for (const raw of ['not json', '[]', '{"events":{}}', '{"events":[]}']) {
        const t = Math.floor(Date.now() / 1000);
        const v1 = signSimulatorWebhook(
          new TextEncoder().encode(TEST_SIGNING_KEY),
          t,
          Buffer.from(raw),
        );
        const res = await postRaw(h, p.key, raw, {
          'content-type': 'application/json',
          [SIMULATOR_SIGNATURE_HEADER]: `t=${t},v1=${v1}`,
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('WEBHOOK_PAYLOAD_INVALID');
      }
      expect(await rows(p.id)).toEqual([]);
    });

    it('an unknown provider message id: 200, recorded unmatched', async () => {
      const p = await ingressProvider(h, world);
      await post(h, p.key, [
        {
          type: 'delivery',
          eventId: 'e-unknown',
          providerMessageId: 'sim-nobody',
          status: 'DELIVERED',
        },
      ]).expect(200);
      expect((await rows(p.id))[0]).toMatchObject({
        outcome: 'unmatched',
        matched_attempt_id: null,
        matched_org_id: null,
      });
    });

    it('over the body limit: 413; a wrong content type: 415; neither writes a row', async () => {
      const p = await ingressProvider(h, world);
      const big = '{"events":[' + '"x",'.repeat(20_000) + '"x"]}';
      const tooBig = await postRaw(h, p.key, big, { 'content-type': 'application/json' });
      expect(tooBig.status).toBe(413);
      expect(tooBig.body.error.code).toBe('WEBHOOK_PAYLOAD_TOO_LARGE');
      const signed = factory.request([delivered(uuidv7())], { nowMs: Date.now() });
      const wrongType = await postRaw(h, p.key, signed.rawBody, {
        ...signed.headers,
        'content-type': 'text/plain',
      });
      expect(wrongType.status).toBe(415);
      expect(await rows(p.id)).toEqual([]);
    });

    it('any other method, or extra path segments, get a uniform 404 that never echoes the key', async () => {
      const p = await ingressProvider(h, world);
      const server = h.app.getHttpServer();
      const base = `/${INGRESS_PREFIX}/webhooks/providers/${p.key}`;
      const responses = [
        await request(server).get(base),
        await request(server).put(base).set('content-type', 'application/json').send('{}'),
        await request(server).delete(`${base}?token=${p.key}`),
        await request(server)
          .post(`${base}/extra`)
          .set('content-type', 'application/json')
          .send('{}'),
      ];
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.error).toMatchObject({ code: 'RESOURCE_NOT_FOUND', message: 'Not found' });
        expect(JSON.stringify(res.body)).not.toContain(p.key);
      }
      expect(await rows(p.id)).toEqual([]);
    });

    it('more than 100 events: 413, nothing recorded (AC-MB-3)', async () => {
      const p = await ingressProvider(h, world);
      const many = Array.from({ length: 101 }, () => delivered(uuidv7()));
      const res = await post(h, p.key, many);
      expect(res.status).toBe(413);
      expect(await rows(p.id)).toEqual([]);
    });

    it('AC-RB-1: no other route retains raw bytes — a JSON route still parses JSON', async () => {
      const res = await request(h.app.getHttpServer())
        .post(`/${INGRESS_PREFIX}/auth/login`)
        .send({ email: 'nobody@example.test', password: 'wrong-password-value' });
      expect([400, 401, 429]).toContain(res.status); // parsed and processed as JSON, not as bytes
      expect(res.body.error).toBeDefined();
    });
  });

  // ===========================================================================
  describe('batches, deduplication and idempotency (AC-MB-1, -2; AC-ID-1, -1a, -2, -3)', () => {
    it('AC-MB-1: N events → N rows of one request (index 0..N-1), outcomes independent', async () => {
      const p = await ingressProvider(h, world);
      const m1 = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const m2 = await plantMessage(h, world, B, [{ provider: p.id, status: 'accepted' }]);
      await post(h, p.key, [
        delivered(m1.attemptIds[0]!),
        {
          type: 'delivery',
          eventId: 'e-nobody',
          providerMessageId: 'sim-unknown',
          status: 'DELIVERED',
        },
        { ...delivered(m2.attemptIds[0]!), status: 'UNDELIVERED' },
      ]).expect(200);
      const r = await rows(p.id);
      expect(r.map((x) => [x.event_index, x.outcome])).toEqual([
        [0, 'applied'],
        [1, 'unmatched'],
        [2, 'applied'],
      ]);
      expect(new Set(r.map((x) => x.request_id)).size).toBe(1);
      expect(r[2]!.matched_org_id).toBe(B.orgId); // attribution per event, from its own attempt
      expect((await attempt(m2.attemptIds[0]!)).deliveryStatus).toBe('undelivered');
    });

    it('AC-ID-1/1a: a repeated event id is counted on the original row; state written once', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const e = delivered(m.attemptIds[0]!);
      for (let i = 0; i < 3; i += 1) await post(h, p.key, [e]).expect(200);
      const r = await rows(p.id);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ outcome: 'applied', duplicate_count: 2 });
      expect(await events(m.messageId, 'message.delivered')).toHaveLength(1);
    });

    it('without event ids the element hash deduplicates — inside one batch too; different ids with identical bytes are both processed', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const noId = { type: 'delivery', clientReference: m.attemptIds[0], status: 'DELIVERED' };
      await post(h, p.key, [noId, noId]).expect(200);
      let r = await rows(p.id);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ provider_event_id: null, duplicate_count: 1 });
      await post(h, p.key, [
        { ...noId, eventId: 'same-bytes-1' },
        { ...noId, eventId: 'same-bytes-2' },
      ]).expect(200);
      r = await rows(p.id);
      expect(
        r.filter((x) => x.provider_event_id?.startsWith('same-bytes')).map((x) => x.outcome),
      ).toEqual(['no_change', 'no_change']);
    });

    it('AC-ID-2: a semantic duplicate (another event id, same effect) is no_change and appends no message event', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      await post(h, p.key, [delivered(m.attemptIds[0]!)]).expect(200);
      await post(h, p.key, [delivered(m.attemptIds[0]!)]).expect(200);
      expect((await rows(p.id)).map((x) => x.outcome)).toEqual(['applied', 'no_change']);
      expect(await events(m.messageId, 'message.delivered')).toHaveLength(1);
    });

    it('AC-ID-3: 8 concurrent identical deliveries change state exactly once', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const e = delivered(m.attemptIds[0]!);
      const results = await Promise.all(Array.from({ length: 8 }, () => post(h, p.key, [e])));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      const r = await rows(p.id);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ outcome: 'applied', duplicate_count: 7 });
      expect(await events(m.messageId, 'message.delivered')).toHaveLength(1);
    });

    it('AC-MB-2: a transient failure on event k → 5xx; the retried request deduplicates 0..k-1 and processes the rest once', async () => {
      const p = await ingressProvider(h, world);
      const ms = [
        await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]),
        await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]),
        await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]),
      ];
      const batch = ms.map((m) => delivered(m.attemptIds[0]!));
      const ingestion = h.app.get(DeliveryIngestionService);
      const original = ingestion.ingest.bind(ingestion);
      let calls = 0;
      const spy = jest.spyOn(ingestion, 'ingest').mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error('injected transient failure');
        return original(...args);
      });
      try {
        const first = await post(h, p.key, batch);
        expect(first.status).toBe(503);
        expect((await rows(p.id)).map((x) => x.event_index)).toEqual([0]);
      } finally {
        spy.mockRestore();
      }
      await post(h, p.key, batch).expect(200);
      const r = await rows(p.id);
      expect(r).toHaveLength(3);
      expect(r.map((x) => [x.outcome, x.duplicate_count])).toEqual([
        ['applied', 1],
        ['applied', 0],
        ['applied', 0],
      ]);
      for (const m of ms) expect(await events(m.messageId, 'message.delivered')).toHaveLength(1);
    });
  });

  // ===========================================================================
  describe('tenant and provider isolation (AC-TI-1, -2)', () => {
    it("a valid receipt under provider P cannot reach provider Q's attempt, even naming it exactly", async () => {
      const P = await ingressProvider(h, world);
      const Q = await ingressProvider(h, world);
      const mq = await plantMessage(h, world, B, [{ provider: Q.id, status: 'accepted' }]);
      const before = await attempt(mq.attemptIds[0]!);
      await post(h, P.key, [delivered(mq.attemptIds[0]!)]).expect(200);
      expect(await attempt(mq.attemptIds[0]!)).toEqual(before);
      expect((await rows(P.id))[0]).toMatchObject({ outcome: 'unmatched', matched_org_id: null });
      expect(await rows(Q.id)).toEqual([]);
    });
  });

  // ===========================================================================
  describe('strict correlation: contradictory references never apply or attribute (PR #81 review)', () => {
    /** Posts one receipt and returns its row; asserts the named attempts and messages are untouched. */
    async function expectUnmatched(
      p: { id: string; key: string },
      element: Record<string, unknown>,
      untouched: Array<{ messageId: string; attemptIds: string[] }>,
    ) {
      const before = await Promise.all(
        untouched.flatMap((m) => [message(m.messageId), ...m.attemptIds.map((a) => attempt(a))]),
      );
      const delivered = await Promise.all(
        untouched.map((m) => events(m.messageId, 'message.delivered')),
      );
      await post(h, p.key, [
        { type: 'delivery', status: 'DELIVERED', eventId: `evt-${uuidv7()}`, ...element },
      ]).expect(200);
      const r = await rows(p.id);
      const row = r.at(-1)!;
      expect(row).toMatchObject({
        outcome: 'unmatched',
        matched_attempt_id: null,
        matched_org_id: null,
      });
      const after = await Promise.all(
        untouched.flatMap((m) => [message(m.messageId), ...m.attemptIds.map((a) => attempt(a))]),
      );
      expect(after).toEqual(before); // no delivery state written anywhere
      for (const [i, m] of untouched.entries()) {
        expect(await events(m.messageId, 'message.delivered')).toHaveLength(delivered[i]!.length);
      }
    }

    it('both references naming the same attempt: applied', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const a = m.attemptIds[0]!;
      await post(h, p.key, [
        {
          type: 'delivery',
          status: 'DELIVERED',
          providerMessageId: `sim-${a}`,
          clientReference: a,
        },
      ]).expect(200);
      expect((await rows(p.id))[0]).toMatchObject({
        outcome: 'applied',
        matched_attempt_id: a,
        matched_org_id: A.orgId,
      });
      expect((await attempt(a)).deliveryStatus).toBe('delivered');
    });

    it('both references naming different attempts: unmatched, nothing applied, no organization attributed', async () => {
      const p = await ingressProvider(h, world);
      const ma = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const mb = await plantMessage(h, world, B, [{ provider: p.id, status: 'accepted' }]);
      await expectUnmatched(
        p,
        { providerMessageId: `sim-${ma.attemptIds[0]}`, clientReference: mb.attemptIds[0] },
        [ma, mb],
      );
    });

    it('provider message id of A with the client reference of B (NULL provider message id): unmatched', async () => {
      const p = await ingressProvider(h, world);
      const ma = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const mb = await plantMessage(h, world, B, [
        { provider: p.id, status: 'outcome_unknown', pmid: null },
      ]);
      await expectUnmatched(
        p,
        { providerMessageId: `sim-${ma.attemptIds[0]}`, clientReference: mb.attemptIds[0] },
        [ma, mb],
      );
      // An unknown provider message id does not fall back to the client reference either.
      await expectUnmatched(
        p,
        { providerMessageId: `sim-${uuidv7()}`, clientReference: mb.attemptIds[0] },
        [mb],
      );
    });

    it('each reference valid on its own, contradictory together: unmatched together; each alone applies', async () => {
      const p = await ingressProvider(h, world);
      const ma = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const mb = await plantMessage(h, world, A, [
        { provider: p.id, status: 'outcome_unknown', pmid: null },
      ]);
      await expectUnmatched(
        p,
        { providerMessageId: `sim-${ma.attemptIds[0]}`, clientReference: mb.attemptIds[0] },
        [ma, mb],
      );
      await post(h, p.key, [
        { type: 'delivery', status: 'DELIVERED', providerMessageId: `sim-${ma.attemptIds[0]}` },
      ]).expect(200);
      await post(h, p.key, [
        { type: 'delivery', status: 'UNDELIVERED', clientReference: mb.attemptIds[0] },
      ]).expect(200);
      expect((await attempt(ma.attemptIds[0]!)).deliveryStatus).toBe('delivered');
      expect((await attempt(mb.attemptIds[0]!)).deliveryStatus).toBe('undelivered');
    });

    it("cross-provider: no reference form under provider P reaches provider Q's attempt", async () => {
      const P = await ingressProvider(h, world);
      const Q = await ingressProvider(h, world);
      const mq = await plantMessage(h, world, B, [{ provider: Q.id, status: 'accepted' }]);
      const q = mq.attemptIds[0]!;
      for (const refs of [
        { providerMessageId: `sim-${q}` },
        { clientReference: q },
        { providerMessageId: `sim-${q}`, clientReference: q },
      ]) {
        await expectUnmatched(P, refs, [mq]);
      }
      expect(await rows(Q.id)).toEqual([]);
    });
  });

  // ===========================================================================
  describe('the key never leaves the request (AC-SV-6: bodies and metrics)', () => {
    it('no response body and no metric carries the key', async () => {
      const p = await ingressProvider(h, world);
      const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
      const responses = [
        await post(h, p.key, [delivered(m.attemptIds[0]!)]),
        await post(h, p.key, [delivered(m.attemptIds[0]!)], { signature: 'INVALID' }),
        await postRaw(h, p.key, 'not json', { 'content-type': 'text/plain' }),
        await postRaw(h, p.key, '{"events":[' + '"x",'.repeat(20_000) + '"x"]}', {
          'content-type': 'application/json',
        }),
      ];
      for (const res of responses) expect(JSON.stringify(res.body)).not.toContain(p.key);
      const metrics = await request(h.app.getHttpServer()).get('/metrics');
      expect(metrics.text).not.toContain(p.key);
      expect(metrics.text).toMatch(
        /acc_webhook_requests_total\{[^}]*adapter="simulator"[^}]*outcome="accepted"/,
      );
      expect(metrics.text).toMatch(/acc_webhook_events_total\{[^}]*outcome="applied"/);
      expect(metrics.text).toMatch(
        /acc_delivery_transitions_total\{[^}]*channel="whatsapp"[^}]*to="delivered"/,
      );
      expect(metrics.text).toMatch(/route="\/api\/v1\/webhooks\/providers\/:providerKey"/);
    });
  });
});
