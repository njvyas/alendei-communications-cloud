/**
 * Phase 5.0 (PR-B, T7) — the simulator's delivery-receipt wire format: its signature
 * scheme, its parser and a factory that builds signed requests. Design spec Rev 2 §E.4,
 * §F; implementation plan §1.2.
 *
 * Signature (adapter-owned; the webhooks module never parses it):
 *   header `x-acc-sim-signature: t=<unix seconds>,v1=<hex>`,
 *   `v1 = HMAC-SHA256(key, "<t>." || rawBody)`, compared in constant time, and the
 *   timestamp must lie within ±`WEBHOOK_REPLAY_WINDOW_SECONDS` of the receive time.
 *
 * Body: `{"events": [ { "type": "delivery", "eventId"?, "providerMessageId"?,
 *   "clientReference"?, "status", "occurredAt"?, "errorCode"? }, … ] }` with 1–100
 * elements. `status` DELIVERED / UNDELIVERED / READ map to the delivery kinds; any other
 * status string is a valid, informational element (plan §1.2).
 *
 * The key is a non-production simulator key resolved through `SecretsPort`; it is not a
 * provider credential. Nothing here opens a connection, sleeps or reads the clock except
 * through the values passed in, so every result is deterministic.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  WEBHOOK_MAX_EVENTS_PER_REQUEST,
  WEBHOOK_REPLAY_WINDOW_SECONDS,
  type MalformedWebhookElementReason,
  type NormalizedDeliveryEvent,
  type NormalizedDeliveryEventKind,
  type ParsedWebhookElement,
  type ParsedWebhookRequest,
  type RawWebhookRequest,
  type SimulatorDeliveryScenario,
  type WebhookVerification,
} from '@acc/contracts';

export const SIMULATOR_SIGNATURE_HEADER = 'x-acc-sim-signature';

const STATUS_KINDS: Readonly<Record<string, NormalizedDeliveryEventKind>> = {
  DELIVERED: 'delivered',
  UNDELIVERED: 'undelivered',
  READ: 'read',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;
const ENCODER = new TextEncoder();

/** One simulator receipt element as it appears on the wire. */
export interface SimulatorReceiptElement {
  readonly type?: string;
  readonly eventId?: string;
  readonly providerMessageId?: string;
  readonly clientReference?: string;
  readonly status?: string;
  readonly occurredAt?: string;
  readonly errorCode?: string;
}

/** A signed request as the simulator would send it. */
export interface SimulatorSignedRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Uint8Array;
}

/** `HMAC-SHA256(key, "<t>." || rawBody)` as lower-case hex. */
export function signSimulatorWebhook(
  key: Uint8Array,
  timestampSeconds: number,
  rawBody: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(ENCODER.encode(`${timestampSeconds}.`))
    .update(rawBody)
    .digest('hex');
}

function headerValue(headers: RawWebhookRequest['headers'], name: string): string | null {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const found =
    direct ?? Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  if (found === undefined) return null;
  if (typeof found === 'string') return found;
  return found.length === 1 ? (found[0] ?? null) : '';
}

/**
 * Verifies the simulator signature over the exact raw bytes. The signature is checked
 * before the timestamp, so a forged request is always `bad_signature`, never a hint
 * about the clock.
 */
export function verifySimulatorWebhook(
  key: Uint8Array,
  request: RawWebhookRequest,
): WebhookVerification {
  const header = headerValue(request.headers, SIMULATOR_SIGNATURE_HEADER);
  if (header === null) return { verified: false, reason: 'missing_signature' };
  const match = SIGNATURE.exec(header.trim());
  if (!match) return { verified: false, reason: 'malformed' };
  const timestampSeconds = Number(match[1]);
  const expected = Buffer.from(signSimulatorWebhook(key, timestampSeconds, request.rawBody), 'hex');
  const given = Buffer.from(match[2]!, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { verified: false, reason: 'bad_signature' };
  }
  const skewSeconds = Math.abs(request.receivedAt.getTime() / 1000 - timestampSeconds);
  if (skewSeconds > WEBHOOK_REPLAY_WINDOW_SECONDS) {
    return { verified: false, reason: 'stale_timestamp' };
  }
  return { verified: true, signatureTimestamp: new Date(timestampSeconds * 1000) };
}

/** JSON with object keys sorted at every level: the canonical bytes of one element. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const isBoundedString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;

function parseElement(element: unknown): ParsedWebhookElement {
  const canonicalBytes = ENCODER.encode(canonicalJson(element));
  if (element === null || typeof element !== 'object' || Array.isArray(element)) {
    return { ok: false, reason: 'invalid_field', canonicalBytes };
  }
  const e = element as Record<string, unknown>;
  const providerEventId = isBoundedString(e.eventId, 255) ? e.eventId : undefined;
  const malformed = (reason: MalformedWebhookElementReason): ParsedWebhookElement => ({
    ok: false,
    reason,
    canonicalBytes,
    ...(providerEventId ? { providerEventId } : {}),
  });

  if (e.type !== undefined && e.type !== 'delivery') return malformed('unsupported_type');
  if (e.status === undefined) return malformed('unknown_kind');
  if (!isBoundedString(e.status, 64)) return malformed('invalid_field');
  if (e.eventId !== undefined && providerEventId === undefined) return malformed('invalid_field');
  if (e.providerMessageId !== undefined && !isBoundedString(e.providerMessageId, 255))
    return malformed('invalid_field');
  if (
    e.clientReference !== undefined &&
    !(typeof e.clientReference === 'string' && UUID.test(e.clientReference))
  )
    return malformed('invalid_field');
  if (
    e.occurredAt !== undefined &&
    !(typeof e.occurredAt === 'string' && !Number.isNaN(Date.parse(e.occurredAt)))
  )
    return malformed('invalid_field');
  if (e.errorCode !== undefined && !isBoundedString(e.errorCode, 64))
    return malformed('invalid_field');
  if (e.providerMessageId === undefined && e.clientReference === undefined)
    return malformed('missing_reference');

  const status = e.status.toUpperCase();
  const event: NormalizedDeliveryEvent = {
    kind: STATUS_KINDS[status] ?? 'informational',
    providerStatus: status,
    ...(providerEventId ? { providerEventId } : {}),
    ...(e.providerMessageId !== undefined
      ? { providerMessageId: e.providerMessageId as string }
      : {}),
    ...(e.clientReference !== undefined
      ? { clientReference: (e.clientReference as string).toLowerCase() }
      : {}),
    ...(e.occurredAt !== undefined
      ? { occurredAt: new Date(e.occurredAt as string).toISOString() }
      : {}),
    ...(e.errorCode !== undefined ? { providerErrorCode: e.errorCode as string } : {}),
  };
  return { ok: true, event, canonicalBytes };
}

/** Parses a verified simulator body (plan §1.2): per element, or a request-level refusal. */
export function parseSimulatorWebhook(rawBody: Uint8Array): ParsedWebhookRequest {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'bad_envelope' };
  }
  const events = (body as Record<string, unknown>).events;
  if (!Array.isArray(events) || events.length === 0) return { ok: false, reason: 'bad_envelope' };
  if (events.length > WEBHOOK_MAX_EVENTS_PER_REQUEST)
    return { ok: false, reason: 'too_many_events' };
  return { ok: true, elements: events.map(parseElement) };
}

/** What a scenario expansion needs to know about the attempt (OD-8: the client reference is the attempt id). */
export interface SimulatorReceiptTarget {
  readonly attemptId: string;
  readonly providerMessageId: string | null;
  /** The base time of the receipts, in epoch milliseconds (an injected clock). */
  readonly nowMs: number;
}

/**
 * Builds signed simulator requests — shared by the integration tests and, in PR-E, the
 * operator trigger (spec §F.2). Deterministic: event ids derive from the attempt id and
 * the event kind, timestamps from the injected clock, and `delayMs` only offsets
 * `occurredAt` (nothing sleeps).
 */
export class SimulatorWebhookFactory {
  constructor(private readonly key: Uint8Array) {}

  /** One signed request carrying `events`. `signature` INVALID corrupts it; STALE dates it outside the window. */
  request(
    events: readonly SimulatorReceiptElement[],
    options: { nowMs: number; signature?: 'VALID' | 'INVALID' | 'STALE' },
  ): SimulatorSignedRequest {
    const rawBody = ENCODER.encode(JSON.stringify({ events }));
    const signature = options.signature ?? 'VALID';
    const t =
      Math.floor(options.nowMs / 1000) -
      (signature === 'STALE' ? WEBHOOK_REPLAY_WINDOW_SECONDS + 1 : 0);
    let v1 = signSimulatorWebhook(this.key, t, rawBody);
    if (signature === 'INVALID') v1 = `${v1[0] === '0' ? '1' : '0'}${v1.slice(1)}`;
    return {
      headers: {
        'content-type': 'application/json',
        [SIMULATOR_SIGNATURE_HEADER]: `t=${t},v1=${v1}`,
      },
      rawBody,
    };
  }

  /** The receipt elements a `simulator_delivery` scenario produces, in sending order (spec §F.1). */
  elementsFor(
    scenario: SimulatorDeliveryScenario,
    target: SimulatorReceiptTarget,
  ): SimulatorReceiptElement[] {
    if (scenario.outcome === 'NONE') return [];
    const delay = scenario.delayMs ?? 0;
    const reference =
      scenario.clientReferenceOnly || target.providerMessageId === null
        ? { clientReference: target.attemptId }
        : { providerMessageId: target.providerMessageId, clientReference: target.attemptId };
    const element = (status: string, offsetMs: number): SimulatorReceiptElement => ({
      type: 'delivery',
      ...(scenario.withEventIds === false
        ? {}
        : { eventId: `simevt-${target.attemptId}-${status.toLowerCase()}` }),
      ...reference,
      status,
      occurredAt: new Date(target.nowMs + offsetMs).toISOString(),
      ...(status === 'UNDELIVERED' ? { errorCode: 'SIM-UNDELIVERABLE' } : {}),
    });
    const ordered: SimulatorReceiptElement[] = [
      element(scenario.outcome === 'DELIVERED' ? 'DELIVERED' : 'UNDELIVERED', delay),
    ];
    if (scenario.read === true && scenario.outcome === 'DELIVERED') {
      ordered.push(element('READ', delay + 1_000));
    }
    if (scenario.order === 'REVERSED') ordered.reverse();
    const copies = scenario.duplicates ?? 0;
    return ordered.flatMap((e) => Array.from({ length: copies + 1 }, () => e));
  }

  /**
   * The signed requests a scenario produces: one per element, or one batch (`batch`).
   * `signature` REPLAY re-sends the first signed request unchanged.
   */
  requestsFor(
    scenario: SimulatorDeliveryScenario,
    target: SimulatorReceiptTarget,
  ): SimulatorSignedRequest[] {
    const elements = this.elementsFor(scenario, target);
    if (elements.length === 0) return [];
    const signature =
      scenario.signature === 'INVALID' || scenario.signature === 'STALE'
        ? scenario.signature
        : 'VALID';
    const requests = scenario.batch
      ? [this.request(elements, { nowMs: target.nowMs, signature })]
      : elements.map((e) => this.request([e], { nowMs: target.nowMs, signature }));
    return scenario.signature === 'REPLAY' ? [...requests, requests[0]!] : requests;
  }
}
