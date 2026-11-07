import { createHash } from 'node:crypto';
import type { ProviderAdapterContext } from '@acc/contracts';

import {
  SIMULATOR_SIGNATURE_HEADER,
  SimulatorWebhookFactory,
  canonicalJson,
  parseSimulatorWebhook,
  signSimulatorWebhook,
  verifySimulatorWebhook,
} from './simulator-webhook';
import { SimulatorAdapter } from './simulator.adapter';
import type { SubmissionTimer } from './submission-timer';

/** A non-production, test-only simulator signing key (spec §E.4). */
const KEY = new TextEncoder().encode('simulator-test-signing-key-0123456789abcdef');
const NOW_MS = Date.parse('2026-11-07T12:00:00.000Z');
const ATTEMPT = '01a1b400-0000-7000-8000-000000000001';
const enc = (s: string) => new TextEncoder().encode(s);
const factory = new SimulatorWebhookFactory(KEY);

const received = (
  signed: { headers: Record<string, string>; rawBody: Uint8Array },
  nowMs = NOW_MS,
) => ({
  headers: signed.headers,
  rawBody: signed.rawBody,
  receivedAt: new Date(nowMs),
});

describe('simulator webhook signature (spec §E.4, §E.5)', () => {
  const body = [{ type: 'delivery', eventId: 'e1', clientReference: ATTEMPT, status: 'DELIVERED' }];

  it('a valid signature over the exact bytes verifies and returns the signature timestamp', () => {
    const signed = factory.request(body, { nowMs: NOW_MS });
    expect(verifySimulatorWebhook(KEY, received(signed))).toEqual({
      verified: true,
      signatureTimestamp: new Date(Math.floor(NOW_MS / 1000) * 1000),
    });
  });

  it('missing, malformed and forged signatures are refused with their reason', () => {
    const signed = factory.request(body, { nowMs: NOW_MS });
    expect(verifySimulatorWebhook(KEY, { ...received(signed), headers: {} })).toEqual({
      verified: false,
      reason: 'missing_signature',
    });
    expect(
      verifySimulatorWebhook(KEY, {
        ...received(signed),
        headers: { [SIMULATOR_SIGNATURE_HEADER]: 'v1=abc' },
      }),
    ).toEqual({ verified: false, reason: 'malformed' });
    expect(
      verifySimulatorWebhook(
        KEY,
        received(factory.request(body, { nowMs: NOW_MS, signature: 'INVALID' })),
      ),
    ).toEqual({
      verified: false,
      reason: 'bad_signature',
    });
    const otherKey = new SimulatorWebhookFactory(enc('another-simulator-key-xxxxxxxxxxxxxxxxx'));
    expect(
      verifySimulatorWebhook(KEY, received(otherKey.request(body, { nowMs: NOW_MS }))),
    ).toEqual({
      verified: false,
      reason: 'bad_signature',
    });
  });

  it('AC-SV-3: re-serialising the JSON breaks verification — only the raw bytes count', () => {
    const signed = factory.request(body, { nowMs: NOW_MS });
    const reserialised = enc(
      JSON.stringify(JSON.parse(new TextDecoder().decode(signed.rawBody)), null, 2),
    );
    expect(verifySimulatorWebhook(KEY, { ...received(signed), rawBody: reserialised })).toEqual({
      verified: false,
      reason: 'bad_signature',
    });
  });

  it('a timestamp outside ±300 s is stale — checked only after the signature (OD-14)', () => {
    expect(
      verifySimulatorWebhook(
        KEY,
        received(factory.request(body, { nowMs: NOW_MS, signature: 'STALE' })),
      ),
    ).toEqual({
      verified: false,
      reason: 'stale_timestamp',
    });
    const signed = factory.request(body, { nowMs: NOW_MS });
    expect(verifySimulatorWebhook(KEY, received(signed, NOW_MS + 299_000)).verified).toBe(true);
    expect(verifySimulatorWebhook(KEY, received(signed, NOW_MS + 302_000))).toEqual({
      verified: false,
      reason: 'stale_timestamp',
    });
  });

  it('header names are case-insensitive; the HMAC is over "<t>." followed by the raw body', () => {
    const raw = enc('{"events":[]}');
    const t = Math.floor(NOW_MS / 1000);
    const v1 = signSimulatorWebhook(KEY, t, raw);
    expect(
      verifySimulatorWebhook(KEY, {
        headers: { 'X-ACC-SIM-SIGNATURE': `t=${t},v1=${v1}` },
        rawBody: raw,
        receivedAt: new Date(NOW_MS),
      }).verified,
    ).toBe(true);
  });
});

describe('simulator webhook parsing (plan §1.2) — per element, or a request-level refusal', () => {
  it('maps DELIVERED / UNDELIVERED / READ; any other status is a valid informational element', () => {
    const parsed = parseSimulatorWebhook(
      enc(
        JSON.stringify({
          events: [
            {
              type: 'delivery',
              eventId: 'e1',
              providerMessageId: 'sim-x',
              status: 'DELIVERED',
              occurredAt: '2026-11-07T11:00:00Z',
            },
            { clientReference: ATTEMPT.toUpperCase(), status: 'undelivered', errorCode: 'X1' },
            { clientReference: ATTEMPT, status: 'READ' },
            { clientReference: ATTEMPT, status: 'SENT_TO_CARRIER' },
          ],
        }),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.elements.map((e) => (e.ok ? e.event.kind : e.reason))).toEqual([
      'delivered',
      'undelivered',
      'read',
      'informational',
    ]);
    const first = parsed.elements[0]!;
    expect(first.ok && first.event).toEqual({
      kind: 'delivered',
      providerStatus: 'DELIVERED',
      providerEventId: 'e1',
      providerMessageId: 'sim-x',
      occurredAt: '2026-11-07T11:00:00.000Z',
    });
    const second = parsed.elements[1]!;
    expect(second.ok && second.event.clientReference).toBe(ATTEMPT);
  });

  it('a malformed element is reported with its reason (and event id when readable); the others are kept', () => {
    const parsed = parseSimulatorWebhook(
      enc(
        JSON.stringify({
          events: [
            { eventId: 'm1', status: 'DELIVERED' },
            { type: 'inbound', clientReference: ATTEMPT, status: 'DELIVERED' },
            { clientReference: ATTEMPT },
            { clientReference: 'not-a-uuid', status: 'DELIVERED' },
            { clientReference: ATTEMPT, status: 'DELIVERED', occurredAt: 'yesterday' },
            'not an object',
            { clientReference: ATTEMPT, status: 'DELIVERED' },
          ],
        }),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.elements.map((e) => (e.ok ? 'ok' : e.reason))).toEqual([
      'missing_reference',
      'unsupported_type',
      'unknown_kind',
      'invalid_field',
      'invalid_field',
      'invalid_field',
      'ok',
    ]);
    const m1 = parsed.elements[0]!;
    expect(!m1.ok && m1.providerEventId).toBe('m1');
  });

  it('a request malformed as a whole: not JSON, a bad envelope, an empty batch, more than 100 elements', () => {
    expect(parseSimulatorWebhook(enc('not json'))).toEqual({ ok: false, reason: 'not_json' });
    expect(parseSimulatorWebhook(new Uint8Array([0xff, 0xfe]))).toEqual({
      ok: false,
      reason: 'not_json',
    });
    expect(parseSimulatorWebhook(enc('[]'))).toEqual({ ok: false, reason: 'bad_envelope' });
    expect(parseSimulatorWebhook(enc('{"events":{}}'))).toEqual({
      ok: false,
      reason: 'bad_envelope',
    });
    expect(parseSimulatorWebhook(enc('{"events":[]}'))).toEqual({
      ok: false,
      reason: 'bad_envelope',
    });
    const many = Array.from({ length: 101 }, () => ({
      clientReference: ATTEMPT,
      status: 'DELIVERED',
    }));
    expect(parseSimulatorWebhook(enc(JSON.stringify({ events: many })))).toEqual({
      ok: false,
      reason: 'too_many_events',
    });
    expect(parseSimulatorWebhook(enc(JSON.stringify({ events: many.slice(0, 100) }))).ok).toBe(
      true,
    );
  });

  it('canonical bytes ignore key order, so the fallback hash identifies an element, not its formatting', () => {
    const a = parseSimulatorWebhook(
      enc('{"events":[{"status":"DELIVERED","clientReference":"' + ATTEMPT + '"}]}'),
    );
    const b = parseSimulatorWebhook(
      enc('{"events":[ {"clientReference":"' + ATTEMPT + '", "status":"DELIVERED"} ]}'),
    );
    const hash = (p: typeof a) =>
      p.ok ? createHash('sha256').update(p.elements[0]!.canonicalBytes).digest('hex') : '';
    expect(hash(a)).toBe(hash(b));
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});

describe('SimulatorWebhookFactory — the §F.1 scenarios, deterministically', () => {
  const target = { attemptId: ATTEMPT, providerMessageId: `sim-${ATTEMPT}`, nowMs: NOW_MS };
  const statuses = (scenario: Parameters<SimulatorWebhookFactory['elementsFor']>[0]) =>
    factory.elementsFor(scenario, target).map((e) => e.status);

  it('outcome, read, order and duplicates', () => {
    expect(statuses({ outcome: 'NONE' })).toEqual([]);
    expect(statuses({ outcome: 'DELIVERED' })).toEqual(['DELIVERED']);
    expect(statuses({ outcome: 'DELIVERED', read: true })).toEqual(['DELIVERED', 'READ']);
    expect(statuses({ outcome: 'DELIVERED', read: true, order: 'REVERSED' })).toEqual([
      'READ',
      'DELIVERED',
    ]);
    expect(statuses({ outcome: 'UNDELIVERED', duplicates: 2 })).toEqual([
      'UNDELIVERED',
      'UNDELIVERED',
      'UNDELIVERED',
    ]);
  });

  it('event ids derive from the attempt (stable across runs), or are omitted; delayMs offsets occurredAt only', () => {
    const [e] = factory.elementsFor({ outcome: 'DELIVERED', delayMs: 5_000 }, target);
    expect(e).toEqual({
      type: 'delivery',
      eventId: `simevt-${ATTEMPT}-delivered`,
      providerMessageId: `sim-${ATTEMPT}`,
      clientReference: ATTEMPT,
      status: 'DELIVERED',
      occurredAt: new Date(NOW_MS + 5_000).toISOString(),
    });
    expect(
      factory.elementsFor({ outcome: 'DELIVERED', withEventIds: false }, target)[0],
    ).not.toHaveProperty('eventId');
    expect(
      factory.elementsFor({ outcome: 'DELIVERED', clientReferenceOnly: true }, target)[0],
    ).not.toHaveProperty('providerMessageId');
    expect(factory.elementsFor({ outcome: 'DELIVERED' }, target)).toEqual(
      factory.elementsFor({ outcome: 'DELIVERED' }, target),
    );
  });

  it('batch, replay, invalid and stale signatures', () => {
    expect(factory.requestsFor({ outcome: 'DELIVERED', read: true }, target)).toHaveLength(2);
    const batch = factory.requestsFor({ outcome: 'DELIVERED', read: true, batch: true }, target);
    expect(batch).toHaveLength(1);
    const parsed = parseSimulatorWebhook(batch[0]!.rawBody);
    expect(parsed.ok && parsed.elements).toHaveLength(2);
    const replay = factory.requestsFor({ outcome: 'DELIVERED', signature: 'REPLAY' }, target);
    expect(replay).toHaveLength(2);
    expect(replay[1]).toBe(replay[0]);
    const invalid = factory.requestsFor({ outcome: 'DELIVERED', signature: 'INVALID' }, target);
    expect(verifySimulatorWebhook(KEY, received(invalid[0]!)).verified).toBe(false);
    const stale = factory.requestsFor({ outcome: 'DELIVERED', signature: 'STALE' }, target);
    expect(verifySimulatorWebhook(KEY, received(stale[0]!))).toEqual({
      verified: false,
      reason: 'stale_timestamp',
    });
  });
});

describe('SimulatorAdapter verify/parse and per-attempt provider message ids (T7)', () => {
  const timer: SubmissionTimer = {
    now: () => 0,
    sleep: () => Promise.resolve(),
  } as unknown as SubmissionTimer;
  const context: ProviderAdapterContext = {
    providerId: 'p',
    adapterKey: 'simulator',
    channel: 'whatsapp',
    capabilities: {},
  };

  it('verifies with the wired key source — views carry it — and parses purely', async () => {
    const adapter = new SimulatorAdapter(timer, { webhookKey: async () => KEY }).forBehavior(
      'SUCCESS',
    );
    const signed = factory.request([{ clientReference: ATTEMPT, status: 'DELIVERED' }], {
      nowMs: Date.now(),
    });
    const request = { headers: signed.headers, rawBody: signed.rawBody, receivedAt: new Date() };
    const verification = await adapter.verifyWebhook(context, request);
    expect(verification.verified).toBe(true);
    const parsed = adapter.parseWebhook(context, {
      rawBody: signed.rawBody,
      receivedAt: request.receivedAt,
    });
    expect(parsed.ok && parsed.elements[0]!.ok).toBe(true);
  });
  // AC-SIM-2 (unique provider message id per attempt) is proven end to end, in the database,
  // by test/phase5_0-settlement.int-spec.ts (same-channel fallback case).
});
