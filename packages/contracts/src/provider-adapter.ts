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
}

export interface ProviderSubmissionOptions {
  /** The submission timeout. The executor enforces it; an adapter may also honour `signal`. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
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
 * Phase 2; `estimateCost` (billing, Phase 7), `checkStatus` and `parseWebhook`
 * (message lifecycle, Phase 3) are interface members only and carry no Phase 2
 * behaviour (ADR-013 PD-6).
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
  parseWebhook(context: ProviderAdapterContext, raw: unknown): Promise<never>;
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

/** Fixed platform defaults (ADR-013 F-6): no per-provider timing administration in Phase 2. */
export const PROVIDER_SUBMISSION_DEFAULTS = {
  /** The submission timeout every executor enforces. */
  TIMEOUT_MS: 3000,
  /** `SLOW_RESPONSE`'s latency — slow, but inside the timeout, so still accepted. */
  SIMULATOR_SLOW_RESPONSE_MS: 300,
} as const;
