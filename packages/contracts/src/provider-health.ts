/**
 * Provider health and circuit breaker (Phase 2.3, `PROVIDER_ADAPTER.md` §5-§6,
 * ADR-013 F-6/F-7).
 *
 * Everything here is a fixed platform default: Phase 2 administers no
 * threshold. The state machines that consume these values live in
 * `apps/api/src/providers/provider-state-machine.ts`; this file is the
 * vocabulary they share with the database and the API.
 */
import { PROVIDER_FAILURE_CATEGORIES, type ProviderFailureCategory } from './provider-adapter';
import type { ProviderCircuitState } from './providers';

/** What produced a sample (`PROVIDER_ADAPTER.md` §5a). */
export const PROVIDER_HEALTH_SAMPLE_KINDS = ['submission', 'probe', 'override'] as const;
export type ProviderHealthSampleKind = (typeof PROVIDER_HEALTH_SAMPLE_KINDS)[number];

/** `automatic` for an observation, `manual` for an override. */
export const PROVIDER_HEALTH_SOURCES = ['automatic', 'manual'] as const;
export type ProviderHealthSource = (typeof PROVIDER_HEALTH_SOURCES)[number];

/** A submission's outcome: `accepted`, or its failure category in lower case. */
export const PROVIDER_SUBMISSION_SAMPLE_OUTCOMES = [
  'accepted',
  ...PROVIDER_FAILURE_CATEGORIES.map((c) => c.toLowerCase() as Lowercase<ProviderFailureCategory>),
] as const;
export type ProviderSubmissionSampleOutcome = 'accepted' | Lowercase<ProviderFailureCategory>;

/** A health-check probe's outcome. */
export const PROVIDER_PROBE_OUTCOMES = ['healthy', 'unhealthy', 'timeout'] as const;
export type ProviderProbeOutcome = (typeof PROVIDER_PROBE_OUTCOMES)[number];

export type ProviderHealthSampleOutcome =
  ProviderSubmissionSampleOutcome | ProviderProbeOutcome | 'manual';

/**
 * How a sample counts (`PROVIDER_ADAPTER.md` §5b). A `neutral` sample is
 * recorded but excluded from every window: it is neither evidence that the
 * provider works nor that it does not.
 */
export const PROVIDER_HEALTH_CLASSIFICATIONS = ['success', 'failure', 'neutral'] as const;
export type ProviderHealthClassification = (typeof PROVIDER_HEALTH_CLASSIFICATIONS)[number];

/**
 * The one failure classification, for health and circuit alike. Failures are
 * the outcomes that say the provider is unavailable, overloaded or failing in a
 * way nobody could classify; deterministic rejections of the request, the
 * credential or our own configuration are neutral.
 */
export const PROVIDER_SUBMISSION_CLASSIFICATION: Readonly<
  Record<ProviderSubmissionSampleOutcome, ProviderHealthClassification>
> = Object.freeze({
  accepted: 'success',
  timeout: 'failure',
  provider_error: 'failure',
  rate_limited: 'failure',
  unknown: 'failure',
  auth_error: 'neutral',
  invalid_request: 'neutral',
  invalid_recipient: 'neutral',
  unsupported_content: 'neutral',
  configuration_error: 'neutral',
});

export const PROVIDER_PROBE_CLASSIFICATION: Readonly<
  Record<ProviderProbeOutcome, ProviderHealthClassification>
> = Object.freeze({
  healthy: 'success',
  unhealthy: 'failure',
  timeout: 'failure',
});

/** Health derivation (`PROVIDER_ADAPTER.md` §5c). */
export const PROVIDER_HEALTH_DEFAULTS = Object.freeze({
  /** Samples older than this are outside the window. */
  WINDOW_MS: 300_000,
  /** At most this many counted samples, newest first. */
  WINDOW_MAX_SAMPLES: 20,
  /** Fewer counted samples than this concludes nothing: `healthy`. */
  MIN_SAMPLES: 5,
  /** This many consecutive failures at the head of the window: `offline`. */
  OFFLINE_CONSECUTIVE_FAILURES: 5,
  /** `failures × 100 ≥ this × samples`: `critical`. */
  CRITICAL_FAILURE_PERCENT: 50,
  /** `failures × 100 ≥ this × samples`: `degraded`. */
  DEGRADED_FAILURE_PERCENT: 20,
  /** Mean latency of the window's successes at or above this: `degraded`. */
  DEGRADED_LATENCY_MS: 1000,
  /** The health-check probe's timeout. */
  PROBE_TIMEOUT_MS: 3000,
});

/** The circuit breaker (`PROVIDER_ADAPTER.md` §6a). */
export const PROVIDER_CIRCUIT_DEFAULTS = Object.freeze({
  /** Submission samples older than this are outside the window. */
  WINDOW_MS: 60_000,
  /** At most this many counted submission samples, newest first. */
  WINDOW_MAX_SAMPLES: 20,
  /** The window must hold at least this many counted samples to open. */
  MIN_SAMPLES: 5,
  /** `failures × 100 ≥ this × samples` opens the circuit. */
  FAILURE_PERCENT: 50,
  /** Time spent `open` before the next submission may half-open it. */
  COOLDOWN_MS: 30_000,
  /** Probes admitted at once in `half_open`. The slot model holds exactly one. */
  HALF_OPEN_MAX_PROBES: 1,
  /** Successful probes, one after another, that close the circuit. */
  HALF_OPEN_SUCCESSES_TO_CLOSE: 2,
  /** A probe slot not released within this is reclaimable (timeout plus margin). */
  PROBE_LEASE_MS: 10_000,
});

/** The only four changes of circuit state (`PROVIDER_ADAPTER.md` §6b). */
export const PROVIDER_CIRCUIT_TRANSITIONS = Object.freeze({
  T1: { from: 'closed', to: 'open', cause: 'failure_threshold' },
  T2: { from: 'open', to: 'half_open', cause: 'cooldown_elapsed' },
  T3: { from: 'half_open', to: 'open', cause: 'probe_failed' },
  T4: { from: 'half_open', to: 'closed', cause: 'probes_succeeded' },
} as const satisfies Record<
  string,
  { from: ProviderCircuitState; to: ProviderCircuitState; cause: string }
>);
export type ProviderCircuitTransitionKey = keyof typeof PROVIDER_CIRCUIT_TRANSITIONS;
export type ProviderCircuitTransitionCause =
  (typeof PROVIDER_CIRCUIT_TRANSITIONS)[ProviderCircuitTransitionKey]['cause'];

/** The simulator's deterministic health-check answers (`POST /providers/:id/health-check`). */
export const SIMULATOR_HEALTH_BEHAVIORS = ['HEALTHY', 'UNHEALTHY', 'TIMEOUT'] as const;
export type SimulatorHealthBehavior = (typeof SIMULATOR_HEALTH_BEHAVIORS)[number];

/** `reason` on a manual override: free text for the audit trail, bounded. */
export const PROVIDER_HEALTH_OVERRIDE_REASON_MAX = 500;
