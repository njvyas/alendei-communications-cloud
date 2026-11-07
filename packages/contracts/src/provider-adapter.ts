/**
 * Provider adapter contract (Phase 2.2, `PROVIDER_ADAPTER.md` §2, ADR-013).
 *
 * The one shape every provider integration implements, for every channel
 * (WhatsApp, SMS, RCS, email, voice). Nothing here names a vendor, carries a
 * vendor SDK type, or carries a credential: an adapter receives a provider's
 * *configuration reference* (its catalogue row and declared capabilities), never
 * a secret (ADR-013 PD-2). Phase 2 implements only `SimulatorAdapter`.
 *
 * `send()` reports **acceptance**, never delivery: delivery is a separate,
 * later signal (webhook or status poll, Phase 3).
 */
import type { ChannelCode } from './providers';
import type { RcsBasicPayload } from './rcs';
import type { SmsDltMetadata, SmsEncodingAnalysis } from './sms';

/**
 * The normalized failure taxonomy (`PROVIDER_ADAPTER.md` §2). Every adapter maps
 * its vendor-specific errors onto exactly one of these, so nothing downstream
 * ever branches on a vendor code. Independent of HTTP status codes: a provider's
 * `500` and a timeout are both retryable, but they are not the same failure.
 */
export const PROVIDER_FAILURE_CATEGORIES = [
  /** No answer within the submission timeout. */
  'TIMEOUT',
  /** The provider failed on its side (a 5xx, an outage). */
  'PROVIDER_ERROR',
  /** The provider refused for rate (a 429, a throughput cap). */
  'RATE_LIMITED',
  /** The provider rejected the credentials it was given. */
  'AUTH_ERROR',
  /** The provider rejected the request as malformed. */
  'INVALID_REQUEST',
  /** The provider rejected the recipient (Phase 3+; no Phase 2 adapter produces it). */
  'INVALID_RECIPIENT',
  /** The provider cannot carry this content (Phase 3+; no Phase 2 adapter produces it). */
  'UNSUPPORTED_CONTENT',
  /** The adapter or its configuration cannot perform the submission (ours, not the provider's). */
  'CONFIGURATION_ERROR',
  /** Anything an adapter could not classify. */
  'UNKNOWN',
] as const;
export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number];

/** Whether a later attempt could succeed unchanged. Fixed per category, never per vendor. */
export const RETRYABLE_FAILURE_CATEGORIES: readonly ProviderFailureCategory[] = Object.freeze([
  'TIMEOUT',
  'PROVIDER_ERROR',
  'RATE_LIMITED',
]);

/**
 * What the adapter is told about the provider it acts for: identity and
 * configuration references from the catalogue, and nothing secret.
 */
export interface ProviderAdapterContext {
  readonly providerId: string;
  readonly adapterKey: string;
  readonly channel: ChannelCode;
  /** The provider's declared capabilities (`provider_capabilities`), by key. */
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/**
 * A normalized submission. `submissionId` is assigned by ACC and is stable for
 * this one attempt (it is what a real adapter passes as the provider's own
 * idempotency key, `PROVIDER_ADAPTER.md` §2a); `correlationId` ties every log
 * line, metric and audit row of the request together.
 */
export interface ProviderSubmission {
  readonly submissionId: string;
  readonly correlationId: string;
  readonly channel: ChannelCode;
  /** A synthetic recipient in Phase 2; never a real contact. */
  readonly recipient: string;
  readonly content: { readonly text: string };
  /**
   * SMS regulatory metadata (Phase 4.2). Present on every SMS message the
   * dispatcher submits; absent on a provider test-send, which carries no
   * template. `content.text` is then the rendered approved template.
   */
  readonly sms?: ProviderSmsSubmission;
  /**
   * The validated RCS payload (Phase 4.2, ADR-016 D-4): text, media or a single
   * rich card, with its suggestions, exactly as the send path accepted it.
   * Present on every RCS message the dispatcher submits; `content.text` is then
   * its plain-text rendering.
   */
  readonly rcs?: RcsBasicPayload;
}

/**
 * What an SMS submission carries besides its text: the DLT metadata bound to the
 * approved template (copied, never taken from the client), the encoding and
 * segment count of the rendered text, computed at dispatch by the Phase 4.1
 * segmenter (Gate F.2 scope F.2.2), and the segment ceiling the send path
 * enforced, when the client lowered it.
 */
export interface ProviderSmsSubmission {
  readonly dlt: SmsDltMetadata;
  /** `GSM-7` or `UCS-2`, from the rendered text (`calculateSmsSegments`). */
  readonly encoding: SmsEncodingAnalysis['encoding'];
  /** Segments the rendered text needs; at least 1 and never above the ceiling. */
  readonly segments: number;
  readonly maxSegments?: number;
}

/**
 * The brand of a submission permit. Declared, never defined, and not exported:
 * no code outside this file can name it, so no value can be written that
 * type-checks as a permit without a cast (ADR-015 R-13).
 */
declare const SUBMISSION_PERMIT: unique symbol;

/**
 * Proof that the circuit admitted this one submission to this one provider
 * and adapter, redeemed by the submission executor immediately before the
 * call (`PROVIDER_ADAPTER.md` §6h, ADR-015 R-13). Opaque: it has no readable
 * field. The type is guidance only — what makes a permit genuine is the
 * runtime check `send()` performs against the admission ledger, which
 * refuses anything the ledger did not mint for this call.
 */
export interface SubmissionPermit {
  readonly [SUBMISSION_PERMIT]: true;
}

export interface ProviderSubmissionOptions {
  /** The submission timeout. The executor enforces it; an adapter may also honour `signal`. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * The redeemed circuit admission for this call (ADR-015 R-13). Required: an
   * adapter's `send()` refuses, before anything is sent, a call without a
   * genuine permit minted for this provider, adapter and submission.
   */
  readonly permit: SubmissionPermit;
}

/** The provider accepted the submission — acceptance, not delivery. */
export interface ProviderSubmissionAccepted {
  readonly outcome: 'accepted';
  readonly submissionId: string;
  readonly correlationId: string;
  /** The provider's own reference for the accepted message. */
  readonly providerMessageId: string;
  readonly latencyMs: number;
}

export interface ProviderFailure {
  readonly category: ProviderFailureCategory;
  readonly retryable: boolean;
  /** The provider's own code, for operators only (never branched on). */
  readonly providerCode: string | null;
  readonly message: string;
}

/** The provider (or the executor, on timeout) refused the submission. */
export interface ProviderSubmissionRejected {
  readonly outcome: 'rejected';
  readonly submissionId: string;
  readonly correlationId: string;
  readonly failure: ProviderFailure;
  readonly latencyMs: number;
}

export type ProviderSubmissionResult = ProviderSubmissionAccepted | ProviderSubmissionRejected;

/** What an adapter declares it can do, before any provider configuration is applied. */
export interface ProviderAdapterCapabilities {
  readonly channels: readonly ChannelCode[];
}

export interface ProviderHealthProbe {
  readonly healthy: boolean;
  readonly latencyMs: number;
}

/**
 * The health check's timeout (Phase 2.3, additive and optional). The executor
 * enforces it; an adapter may also honour `signal`, so an unanswered probe
 * leaves nothing running.
 */
export interface ProviderHealthCheckOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * The adapter port. `capabilities`, `healthCheck` and `send` are implemented in
 * Phase 2; `verifyWebhook` and `parseWebhook` in Phase 5.0 (delivery receipts,
 * design spec Rev 2 §D, §E.4; implementation plan §1.2). `estimateCost` (billing,
 * Phase 7) and `checkStatus` are interface members only and carry no behaviour
 * (ADR-013 PD-6).
 *
 * `verifyWebhook` checks the adapter-owned signature over the exact raw bytes;
 * `parseWebhook` is pure — it normalises an already verified body into one result
 * per element and never touches the database.
 */
export interface ProviderAdapter {
  readonly adapterKey: string;
  capabilities(): ProviderAdapterCapabilities;
  healthCheck(
    context: ProviderAdapterContext,
    options?: ProviderHealthCheckOptions,
  ): Promise<ProviderHealthProbe>;
  send(
    context: ProviderAdapterContext,
    submission: ProviderSubmission,
    options: ProviderSubmissionOptions,
  ): Promise<ProviderSubmissionResult>;
  estimateCost(context: ProviderAdapterContext, submission: ProviderSubmission): Promise<never>;
  checkStatus(context: ProviderAdapterContext, providerMessageId: string): Promise<never>;
  verifyWebhook(
    context: ProviderAdapterContext,
    request: RawWebhookRequest,
  ): Promise<WebhookVerification>;
  parseWebhook(context: ProviderAdapterContext, verified: VerifiedWebhook): ParsedWebhookRequest;
}

/** The submission-time behaviours the simulator reproduces on demand (ADR-013 PD-3). */
export const SIMULATOR_BEHAVIORS = [
  'SUCCESS',
  'TIMEOUT',
  '500',
  '429',
  'INVALID_CREDENTIALS',
  'INVALID_REQUEST',
  'SLOW_RESPONSE',
] as const;
export type SimulatorBehavior = (typeof SIMULATOR_BEHAVIORS)[number];

/**
 * Provider capability selecting the simulator's behaviour (ADR-014 D19). Its
 * value is exactly one of `SIMULATOR_BEHAVIORS`.
 */
export const SIMULATOR_BEHAVIOR_CAPABILITY = 'simulator_behavior';

/** Validates a `simulator_behavior` capability value as it is saved (QAF-003, #21). */
export function validateSimulatorBehaviorCapability(value: unknown): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  if (typeof value === 'string' && (SIMULATOR_BEHAVIORS as readonly string[]).includes(value)) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: [`simulator_behavior must be one of ${SIMULATOR_BEHAVIORS.join(', ')}`],
  };
}

/** Fixed platform defaults (ADR-013 F-6): no per-provider timing administration in Phase 2. */
export const PROVIDER_SUBMISSION_DEFAULTS = {
  /** The submission timeout every executor enforces. */
  TIMEOUT_MS: 3000,
  /** `SLOW_RESPONSE`'s latency — slow, but inside the timeout, so still accepted. */
  SIMULATOR_SLOW_RESPONSE_MS: 300,
} as const;

// =============================================================================
// Phase 5.0 — delivery receipts (design spec Rev 2 §D–§F, implementation plan §1.1–§1.2).
// =============================================================================

/** Replay window for a webhook's signature timestamp, in seconds either side of now (OD-14). */
export const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

/** The raw inbound request an adapter verifies: exact bytes, never a re-serialised body. */
export interface RawWebhookRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Uint8Array;
  readonly receivedAt: Date;
}

export type WebhookVerificationFailure =
  'missing_signature' | 'bad_signature' | 'stale_timestamp' | 'malformed';

export type WebhookVerification =
  | {
      readonly verified: true;
      /** A request-level provider event id, when the provider's envelope carries one (spec §D). */
      readonly providerEventId?: string;
      readonly signatureTimestamp?: Date;
    }
  | { readonly verified: false; readonly reason: WebhookVerificationFailure };

export const NORMALIZED_DELIVERY_EVENT_KINDS = [
  'delivered',
  'undelivered',
  'read',
  'informational',
] as const;
export type NormalizedDeliveryEventKind = (typeof NORMALIZED_DELIVERY_EVENT_KINDS)[number];

/** One provider event, normalised by its adapter. Carries no recipient address and no content. */
export interface NormalizedDeliveryEvent {
  readonly providerEventId?: string;
  readonly providerMessageId?: string;
  /** ACC's client reference echoed by the provider (the attempt id). */
  readonly clientReference?: string;
  readonly kind: NormalizedDeliveryEventKind;
  readonly occurredAt?: string;
  readonly providerStatus?: string;
  readonly providerErrorCode?: string;
}

export const MALFORMED_WEBHOOK_ELEMENT_REASONS = [
  'missing_reference',
  'unknown_kind',
  'invalid_field',
  'unsupported_type',
] as const;
export type MalformedWebhookElementReason = (typeof MALFORMED_WEBHOOK_ELEMENT_REASONS)[number];

/**
 * The per-element result of `parseWebhook` (plan §1.2). `canonicalBytes` is the
 * adapter's canonical encoding of this element alone; its SHA-256 is the fallback
 * deduplication key when the provider supplies no event id.
 */
export type ParsedWebhookElement =
  | {
      readonly ok: true;
      readonly event: NormalizedDeliveryEvent;
      readonly canonicalBytes: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly reason: MalformedWebhookElementReason;
      readonly canonicalBytes: Uint8Array;
      readonly providerEventId?: string;
    };

/** At most this many elements in one request; more is a request-level 413 (plan §1.2, OD-18). */
export const WEBHOOK_MAX_EVENTS_PER_REQUEST = 100;

/** A request whose signature `verifyWebhook` has accepted: the same exact bytes, never re-serialised. */
export interface VerifiedWebhook {
  readonly rawBody: Uint8Array;
  readonly receivedAt: Date;
  readonly signatureTimestamp?: Date;
}

/**
 * Why a verified request is malformed as a whole (plan §1.2): no `webhook_events` row
 * is written — a request-level metric and log line only. `too_many_events` is a 413,
 * the others a 400.
 */
export const MALFORMED_WEBHOOK_REQUEST_REASONS = [
  'not_json',
  'bad_envelope',
  'too_many_events',
] as const;
export type MalformedWebhookRequestReason = (typeof MALFORMED_WEBHOOK_REQUEST_REASONS)[number];

/** The result of `parseWebhook`: one result per element, or a request-level refusal. */
export type ParsedWebhookRequest =
  | { readonly ok: true; readonly elements: readonly ParsedWebhookElement[] }
  | { readonly ok: false; readonly reason: MalformedWebhookRequestReason };

/** Provider capability declaring which delivery receipt types it sends (OD-3). Absent = none. */
export const DELIVERY_RECEIPTS_CAPABILITY = 'delivery_receipts';
export const DELIVERY_RECEIPT_TYPES = ['delivered', 'undelivered', 'read'] as const;
export type DeliveryReceiptType = (typeof DELIVERY_RECEIPT_TYPES)[number];

/**
 * Validates a `delivery_receipts` capability value as it is saved: a non-empty array of
 * distinct receipt types. `read` implies the provider also reports `delivered`, and `read`
 * is refused on SMS (no read receipts on that channel, OD-3).
 */
export function validateDeliveryReceiptsCapability(
  value: unknown,
  /** The provider's channel; `null` checks the shape only (the channel rule needs the provider). */
  channel: ChannelCode | null,
): { readonly valid: boolean; readonly errors: readonly string[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return { valid: false, errors: ['delivery_receipts must be a non-empty array'] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      !(DELIVERY_RECEIPT_TYPES as readonly string[]).includes(entry)
    ) {
      errors.push(
        `delivery_receipts entry ${JSON.stringify(entry)} is not one of ${DELIVERY_RECEIPT_TYPES.join(', ')}`,
      );
      continue;
    }
    if (seen.has(entry)) errors.push(`delivery_receipts entry ${entry} is repeated`);
    seen.add(entry);
  }
  if (seen.has('read') && !seen.has('delivered')) {
    errors.push('delivery_receipts with read must also include delivered');
  }
  if (seen.has('read') && channel === 'sms') {
    errors.push('delivery_receipts read is not available on the sms channel');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * The receipt types a provider declares, read from its stored `delivery_receipts`
 * capability (OD-3). Absent or unreadable means none: delivery is then `not_supported`.
 */
export function declaredDeliveryReceipts(value: unknown): ReadonlySet<DeliveryReceiptType> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter((v): v is DeliveryReceiptType =>
      (DELIVERY_RECEIPT_TYPES as readonly unknown[]).includes(v),
    ),
  );
}

/** Whether a provider declaring `receipts` reports delivery outcomes at all (`pending` vs `not_supported`). */
export function reportsDeliveryOutcome(receipts: ReadonlySet<DeliveryReceiptType>): boolean {
  return receipts.has('delivered') || receipts.has('undelivered');
}

/** Simulator capability scripting delivery events (design spec Rev 2 §F.1). Absent = no events. */
export const SIMULATOR_DELIVERY_CAPABILITY = 'simulator_delivery';

export interface SimulatorDeliveryScenario {
  readonly outcome: 'DELIVERED' | 'UNDELIVERED' | 'NONE';
  readonly read?: boolean;
  readonly delayMs?: number;
  readonly duplicates?: number;
  readonly order?: 'IN_ORDER' | 'REVERSED';
  readonly signature?: 'VALID' | 'INVALID' | 'STALE' | 'REPLAY';
  readonly clientReferenceOnly?: boolean;
  readonly batch?: boolean;
  readonly withEventIds?: boolean;
}

const SIMULATOR_DELIVERY_KEYS: Readonly<Record<keyof SimulatorDeliveryScenario, true>> = {
  outcome: true,
  read: true,
  delayMs: true,
  duplicates: true,
  order: true,
  signature: true,
  clientReferenceOnly: true,
  batch: true,
  withEventIds: true,
};

/** Validates a `simulator_delivery` capability value as it is saved. */
export function validateSimulatorDeliveryCapability(value: unknown): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['simulator_delivery must be an object'] };
  }
  const v = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(v)) {
    if (!(key in SIMULATOR_DELIVERY_KEYS))
      errors.push(`simulator_delivery.${key} is not supported`);
  }
  if (!['DELIVERED', 'UNDELIVERED', 'NONE'].includes(v.outcome as string)) {
    errors.push('simulator_delivery.outcome must be one of DELIVERED, UNDELIVERED, NONE');
  }
  for (const key of ['read', 'clientReferenceOnly', 'batch', 'withEventIds'] as const) {
    if (v[key] !== undefined && typeof v[key] !== 'boolean') {
      errors.push(`simulator_delivery.${key} must be a boolean`);
    }
  }
  const intIn = (key: string, min: number, max: number) => {
    const n = v[key];
    if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)) {
      errors.push(`simulator_delivery.${key} must be an integer from ${min} to ${max}`);
    }
  };
  intIn('delayMs', 0, 600_000);
  intIn('duplicates', 0, 3);
  if (v.order !== undefined && !['IN_ORDER', 'REVERSED'].includes(v.order as string)) {
    errors.push('simulator_delivery.order must be IN_ORDER or REVERSED');
  }
  if (
    v.signature !== undefined &&
    !['VALID', 'INVALID', 'STALE', 'REPLAY'].includes(v.signature as string)
  ) {
    errors.push('simulator_delivery.signature must be one of VALID, INVALID, STALE, REPLAY');
  }
  if (v.read === true && v.outcome !== 'DELIVERED') {
    errors.push('simulator_delivery.read requires outcome DELIVERED');
  }
  return { valid: errors.length === 0, errors };
}
