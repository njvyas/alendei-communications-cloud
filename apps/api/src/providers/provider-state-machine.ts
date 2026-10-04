/**
 * The provider health and circuit-breaker state machines (Phase 2.3), as pure
 * functions of a state snapshot, the observations and the clock. Canonical
 * specification: `PROVIDER_ADAPTER.md` §5-§6 — every rule below cites the row
 * it implements. Nothing here reads the database, the wall clock or a random
 * source; `ProviderStateStore` supplies all three under the provider row lock.
 */
import {
  PROVIDER_CIRCUIT_TRANSITIONS,
  PROVIDER_HEALTH_DEFAULTS,
  PROVIDER_PROBE_CLASSIFICATION,
  PROVIDER_SUBMISSION_CLASSIFICATION,
  type ProviderCircuitPolicy,
  type ProviderCircuitState,
  type ProviderStatus,
  type ProviderCircuitTransitionKey,
  type ProviderHealthClassification,
  type ProviderHealthState,
  type ProviderProbeOutcome,
  type ProviderSubmissionResult,
  type ProviderSubmissionSampleOutcome,
} from '@acc/contracts';

// --- classification (§5b) ------------------------------------------------------

/** A submission result's sample outcome: `accepted`, or the failure category in lower case. */
export function submissionOutcome(
  result: ProviderSubmissionResult,
): ProviderSubmissionSampleOutcome {
  return result.outcome === 'accepted'
    ? 'accepted'
    : (result.failure.category.toLowerCase() as ProviderSubmissionSampleOutcome);
}

export function classifySubmission(
  outcome: ProviderSubmissionSampleOutcome,
): ProviderHealthClassification {
  return PROVIDER_SUBMISSION_CLASSIFICATION[outcome];
}

export function classifyProbe(outcome: ProviderProbeOutcome): ProviderHealthClassification {
  return PROVIDER_PROBE_CLASSIFICATION[outcome];
}

// --- health (§5c) -----------------------------------------------------------------

/** One counted (success or failure) sample of the health window. */
export interface HealthWindowSample {
  readonly classification: 'success' | 'failure';
  readonly latencyMs: number;
}

/**
 * The derived health state. `window` is the health window, **newest first**:
 * at most `WINDOW_MAX_SAMPLES` counted samples inside `WINDOW_MS`. The first
 * matching rule of §5c wins.
 */
export function deriveHealth(window: readonly HealthWindowSample[]): ProviderHealthState {
  const d = PROVIDER_HEALTH_DEFAULTS;
  const n = window.length;
  // Rule 1: too few observations to conclude anything.
  if (n < d.MIN_SAMPLES) return 'healthy';

  let streak = 0;
  while (streak < n && window[streak]!.classification === 'failure') streak++;
  // Rule 2: a run of consecutive failures at the head.
  if (streak >= d.OFFLINE_CONSECUTIVE_FAILURES) return 'offline';

  const failures = window.filter((s) => s.classification === 'failure').length;
  // Rules 3 and 4: failure rate, meets-or-exceeds, in integer arithmetic.
  if (failures * 100 >= d.CRITICAL_FAILURE_PERCENT * n) return 'critical';
  if (failures * 100 >= d.DEGRADED_FAILURE_PERCENT * n) return 'degraded';

  // Rule 5: slow successes.
  const successes = window.filter((s) => s.classification === 'success');
  if (successes.length > 0) {
    const total = successes.reduce((sum, s) => sum + s.latencyMs, 0);
    if (total >= d.DEGRADED_LATENCY_MS * successes.length) return 'degraded';
  }
  // Rule 6.
  return 'healthy';
}

/** The stored state: the override when one is set, otherwise the derived state (§5c). */
export function effectiveHealth(
  override: ProviderHealthState | null,
  window: readonly HealthWindowSample[],
): ProviderHealthState {
  return override ?? deriveHealth(window);
}

// --- circuit (§6) -------------------------------------------------------------------

/** One live `half_open` probe slot (§6c). */
export interface ProbeSlot {
  readonly id: string;
  readonly leaseUntil: Date;
}

/** The circuit columns of one provider row. */
export interface CircuitSnapshot {
  readonly state: ProviderCircuitState;
  readonly generation: number;
  readonly changedAt: Date | null;
  readonly probes: readonly ProbeSlot[];
  readonly probeSuccesses: number;
}

/**
 * What an admitted submission carries from admission to recording (§6d): the
 * episode it was admitted in, and — for a half-open probe — its slot id.
 */
export interface CircuitTicket {
  readonly generation: number;
  readonly probeId: string | null;
}

export interface CircuitTransition {
  readonly key: ProviderCircuitTransitionKey;
  readonly from: ProviderCircuitState;
  readonly to: ProviderCircuitState;
  readonly cause: string;
  /** The generation entered by this transition. */
  readonly generation: number;
}

/** Applies one of T1–T4: generation +1, `changedAt = now`, every probe slot and success cleared (§6b). */
function transition(
  snapshot: CircuitSnapshot,
  key: ProviderCircuitTransitionKey,
  now: Date,
): { next: CircuitSnapshot; transition: CircuitTransition } {
  const edge = PROVIDER_CIRCUIT_TRANSITIONS[key];
  if (snapshot.state !== edge.from) {
    throw new Error(`circuit transition ${key} is not defined from ${snapshot.state}`);
  }
  const generation = snapshot.generation + 1;
  return {
    next: { state: edge.to, generation, changedAt: now, probes: [], probeSuccesses: 0 },
    transition: { key, from: edge.from, to: edge.to, cause: edge.cause, generation },
  };
}

/** The probe slots whose lease has not expired at `now`. */
function liveProbes(snapshot: CircuitSnapshot, now: Date): readonly ProbeSlot[] {
  return snapshot.probes.filter((p) => p.leaseUntil.getTime() > now.getTime());
}

export type AdmissionDecision =
  | {
      readonly admitted: true;
      readonly ticket: CircuitTicket;
      readonly next: CircuitSnapshot;
      readonly transitions: readonly CircuitTransition[];
      /** How many expired probe slots were released by this admission (§6c). */
      readonly reclaimedProbes: number;
    }
  | {
      readonly admitted: false;
      readonly state: 'open' | 'half_open';
      /** Time left in the cooldown when `open`; `null` when `half_open`. */
      readonly retryAfterMs: number | null;
    };

/**
 * Admission of one submission (§6c), under `policy`. `newProbeId` mints a
 * probe-slot id; it is called only when a probe is admitted.
 */
export function admit(
  snapshot: CircuitSnapshot,
  policy: ProviderCircuitPolicy,
  now: Date,
  newProbeId: () => string,
): AdmissionDecision {
  let current = snapshot;
  const transitions: CircuitTransition[] = [];

  if (current.state === 'open') {
    const cooldownEnds = current.changedAt!.getTime() + policy.cooldownMs;
    if (now.getTime() < cooldownEnds) {
      return { admitted: false, state: 'open', retryAfterMs: cooldownEnds - now.getTime() };
    }
    // T2, evaluated lazily by the first submission after the cooldown.
    const t2 = transition(current, 'T2', now);
    current = t2.next;
    transitions.push(t2.transition);
  }

  if (current.state === 'half_open') {
    const live = liveProbes(current, now);
    if (live.length >= policy.halfOpenMaxProbes) {
      return { admitted: false, state: 'half_open', retryAfterMs: null };
    }
    const reclaimedProbes = current.probes.length - live.length;
    const probe = { id: newProbeId(), leaseUntil: new Date(now.getTime() + policy.probeLeaseMs) };
    current = { ...current, probes: [...live, probe] };
    return {
      admitted: true,
      ticket: { generation: current.generation, probeId: probe.id },
      next: current,
      transitions,
      reclaimedProbes,
    };
  }

  return {
    admitted: true,
    ticket: { generation: current.generation, probeId: null },
    next: current,
    transitions,
    reclaimedProbes: 0,
  };
}

/** One counted submission sample of the circuit window. */
export interface CircuitWindowSample {
  readonly classification: 'success' | 'failure';
}

/** What recording a submission did to the circuit (§6d). */
export type RecordingEffect =
  'stale' | 'evaluated' | 'probe_success' | 'probe_failure' | 'probe_neutral';

export interface RecordingDecision {
  readonly next: CircuitSnapshot;
  readonly transitions: readonly CircuitTransition[];
  readonly effect: RecordingEffect;
  /** The window figures T1 was evaluated on (`closed`, current ticket, counted sample). */
  readonly window: { readonly samples: number; readonly failures: number } | null;
}

/** T1's guard under `policy`: the window holds the minimum and meets the failure threshold (§6b). */
export function windowTrips(
  window: readonly CircuitWindowSample[],
  policy: ProviderCircuitPolicy,
): boolean {
  const failures = window.filter((s) => s.classification === 'failure').length;
  return (
    window.length >= policy.minSamples && failures * 100 >= policy.failurePercent * window.length
  );
}

/**
 * Recording one submission's answer (§6d), under `policy`. `window` is the
 * circuit window of the **current** generation including this sample when it
 * counts — newest first, at most `policy.windowMaxSamples` inside
 * `policy.windowMs`; it is read only for a current `closed` ticket.
 */
export function recordSubmission(
  snapshot: CircuitSnapshot,
  ticket: CircuitTicket,
  classification: ProviderHealthClassification,
  window: readonly CircuitWindowSample[],
  policy: ProviderCircuitPolicy,
  now: Date,
): RecordingDecision {
  const unchanged = (effect: RecordingEffect): RecordingDecision => ({
    next: snapshot,
    transitions: [],
    effect,
    window: null,
  });

  // A ticket from another episode, or a probe that no longer holds a slot,
  // records its sample and changes nothing in the circuit.
  if (ticket.generation !== snapshot.generation) return unchanged('stale');

  if (ticket.probeId !== null) {
    if (snapshot.state !== 'half_open' || !snapshot.probes.some((p) => p.id === ticket.probeId)) {
      return unchanged('stale');
    }
    const released: CircuitSnapshot = {
      ...snapshot,
      probes: snapshot.probes.filter((p) => p.id !== ticket.probeId),
    };
    if (classification === 'failure') {
      const t3 = transition(released, 'T3', now);
      return { next: t3.next, transitions: [t3.transition], effect: 'probe_failure', window: null };
    }
    if (classification === 'success') {
      const successes = released.probeSuccesses + 1;
      if (successes >= policy.halfOpenSuccessesToClose) {
        const t4 = transition(released, 'T4', now);
        return {
          next: t4.next,
          transitions: [t4.transition],
          effect: 'probe_success',
          window: null,
        };
      }
      return {
        next: { ...released, probeSuccesses: successes },
        transitions: [],
        effect: 'probe_success',
        window: null,
      };
    }
    return { next: released, transitions: [], effect: 'probe_neutral', window: null };
  }

  // A normal ticket of the current generation is only ever issued while closed.
  if (snapshot.state !== 'closed') return unchanged('stale');
  if (classification === 'neutral') return unchanged('evaluated');

  const figures = {
    samples: window.length,
    failures: window.filter((s) => s.classification === 'failure').length,
  };
  if (windowTrips(window, policy)) {
    const t1 = transition(snapshot, 'T1', now);
    return { next: t1.next, transitions: [t1.transition], effect: 'evaluated', window: figures };
  }
  return { next: snapshot, transitions: [], effect: 'evaluated', window: figures };
}

/** When an `open` circuit's cooldown ends under `policy`, or `null` when it is not `open`. */
export function cooldownUntil(
  snapshot: Pick<CircuitSnapshot, 'state' | 'changedAt'>,
  policy: Pick<ProviderCircuitPolicy, 'cooldownMs'>,
): Date | null {
  if (snapshot.state !== 'open' || !snapshot.changedAt) return null;
  return new Date(snapshot.changedAt.getTime() + policy.cooldownMs);
}

// --- the routing-eligibility contract (§6h) ------------------------------------------

/**
 * How the future Provider Router must treat a provider (`PROVIDER_ADAPTER.md`
 * §6h), evaluated Lifecycle → Health → Circuit. Read-only: it claims nothing
 * and applies no transition. Before sending, the router must still pass the
 * chosen provider through `admit` under the provider row lock — the only call
 * that claims a probe slot or applies T2 — and must never send where it
 * refuses. Phase 2.3 performs no routing; this is the contract it hands on.
 */
export type RoutingEligibility =
  | { readonly verdict: 'excluded_lifecycle'; readonly status: 'disabled' | 'draining' }
  | { readonly verdict: 'excluded_open'; readonly retryAfterMs: number }
  | { readonly verdict: 'probe_only'; readonly probeSlotsFree: number }
  | { readonly verdict: 'eligible' };

export function routingEligibility(
  status: ProviderStatus,
  snapshot: CircuitSnapshot,
  policy: ProviderCircuitPolicy,
  now: Date,
): RoutingEligibility {
  // Lifecycle first: a disabled or draining provider never consults the circuit.
  if (status !== 'active') return { verdict: 'excluded_lifecycle', status };
  // Health is informational in Phase 2 and never overrides the circuit.
  if (snapshot.state === 'open') {
    const ends = cooldownUntil(snapshot, policy)!.getTime();
    if (now.getTime() < ends)
      return { verdict: 'excluded_open', retryAfterMs: ends - now.getTime() };
    // Cooldown elapsed: admission would half-open it with every slot free.
    return { verdict: 'probe_only', probeSlotsFree: policy.halfOpenMaxProbes };
  }
  if (snapshot.state === 'half_open') {
    const free = Math.max(0, policy.halfOpenMaxProbes - liveProbes(snapshot, now).length);
    return { verdict: 'probe_only', probeSlotsFree: free };
  }
  return { verdict: 'eligible' };
}
