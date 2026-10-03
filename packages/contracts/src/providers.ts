/**
 * Channel and provider catalogue (Phase 2.1, `DATABASE.md` §3, ADR-013).
 *
 * The catalogue is global — no row carries a tenant — and is read and
 * administered at platform scope only (ADR-013 PD-5, F-3).
 */

/** The seeded channel catalogue (ADR-013 F-2). Changed by migration, never by the API. */
export const CHANNEL_CODES = ['whatsapp', 'rcs', 'sms', 'email', 'voice'] as const;
export type ChannelCode = (typeof CHANNEL_CODES)[number];

export const CHANNEL_STATUSES = ['active', 'disabled'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/**
 * A provider's **administrative** status (ADR-013 F-5). `draining` lives here
 * and nowhere else: it is an operator decision, not an observation.
 */
export const PROVIDER_STATUSES = ['active', 'disabled', 'draining'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

/** Observed health (ADR-013 F-5): derived from samples or manually overridden (`PROVIDER_ADAPTER.md` §5, Phase 2.3). */
export const PROVIDER_HEALTH_STATES = ['healthy', 'degraded', 'critical', 'offline'] as const;
export type ProviderHealthState = (typeof PROVIDER_HEALTH_STATES)[number];

/** Computed breaker state (ADR-013 F-7): moved only by the circuit breaker (`PROVIDER_ADAPTER.md` §6, Phase 2.3). */
export const PROVIDER_CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const;
export type ProviderCircuitState = (typeof PROVIDER_CIRCUIT_STATES)[number];

/**
 * The adapter implementations a provider may bind to (ADR-013 F-9). Phase 2
 * registers exactly one; the adapter itself is built in 2.2. A key outside
 * this list is refused, and nothing branches on vendor names.
 */
export const PROVIDER_ADAPTER_KEYS = ['simulator'] as const;
export type ProviderAdapterKey = (typeof PROVIDER_ADAPTER_KEYS)[number];

/**
 * The legal status transitions (ADR-013 F-5), keyed by operation. A provider
 * is created `disabled`, so it carries no traffic until an administrator
 * enables it.
 */
export const PROVIDER_TRANSITIONS = {
  enable: { from: ['disabled', 'draining'], to: 'active' },
  disable: { from: ['active', 'draining'], to: 'disabled' },
  drain: { from: ['active'], to: 'draining' },
} as const satisfies Record<
  string,
  { readonly from: readonly ProviderStatus[]; readonly to: ProviderStatus }
>;
export type ProviderTransition = keyof typeof PROVIDER_TRANSITIONS;

/** Bounds on a provider's capability set (`PUT /providers/:id/capabilities`). */
export const PROVIDER_CAPABILITY_LIMITS = {
  MAX_ENTRIES: 50,
  /** Serialized size of one capability value, in bytes. */
  MAX_VALUE_BYTES: 4096,
} as const;

/** `capability_key`: lower-case snake case, starting with a letter, 2–64 characters. */
export const PROVIDER_CAPABILITY_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Capability keys that would name secret material. Capabilities are
 * non-secret, declared support (`PROVIDER_ADAPTER.md` §2); a key containing
 * one of these fragments is refused so a credential cannot be smuggled into
 * the catalogue under a capability name (ADR-013 PD-2).
 */
export const PROVIDER_CAPABILITY_FORBIDDEN_KEY_FRAGMENTS = [
  'secret',
  'password',
  'passwd',
  'token',
  'credential',
  'apikey',
  'api_key',
  'private_key',
] as const;
