/**
 * The provider health and circuit-breaker state machines (Phase 2.3), as pure
 * functions of a state snapshot, the observations and the clock. Canonical
 * specification: `PROVIDER_ADAPTER.md` §5-§6 — every rule below cites the row
 * it implements. Nothing here reads the database, the wall clock or a random
 * source; `ProviderStateStore` supplies all three under the provider row lock.
 */
import {
  PROVIDER_CIRCUIT_DEFAULTS,
  PROVIDER_CIRCUIT_TRANSITIONS,
  PROVIDER_HEALTH_DEFAULTS,
  PROVIDER_PROBE_CLASSIFICATION,
  PROVIDER_SUBMISSION_CLASSIFICATION,
  type ProviderCircuitState,
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

/** The circuit columns of one provider row. */
export interface CircuitSnapshot {
  readonly state: ProviderCircuitState;
  readonly generation: number;
  readonly changedAt: Date | null;
  readonly probeId: string | null;
  readonly probeLeaseUntil: Date | null;
  readonly probeSuccesses: number;
}

/**
 * What an admitted submission carries from admission to recording (§6d): the
 * episode it was admitted in, and — for the half-open probe — the slot id.
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

/** Applies one of T1–T4: generation +1, `changedAt = now`, probe slot and successes cleared (§6b). */
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
    next: {
      state: edge.to,
      generation,
      changedAt: now,
      probeId: null,
      probeLeaseUntil: null,
      probeSuccesses: 0,
    },
    transition: { key, from: edge.from, to: edge.to, cause: edge.cause, generation },
  };
}

export type AdmissionDecision =
  | {
      readonly admitted: true;
      readonly ticket: CircuitTicket;
      readonly next: CircuitSnapshot;
      readonly transitions: readonly CircuitTransition[];
      /** An expired probe lease was taken over (§6c). */
      readonly reclaimedProbe: boolean;
    }
  | {
      readonly admitted: false;
      readonly state: 'open' | 'half_open';
      /** Time left in the cooldown when `open`; `null` when `half_open`. */
      readonly retryAfterMs: number | null;
    };

/**
 * Admission of one submission (§6c). `newProbeId` mints the probe-slot id; it
 * is called only when a probe is admitted.
 */
export function admit(
  snapshot: CircuitSnapshot,
  now: Date,
  newProbeId: () => string,
): AdmissionDecision {
  const c = PROVIDER_CIRCUIT_DEFAULTS;
  let current = snapshot;
  const transitions: CircuitTransition[] = [];

  if (current.state === 'open') {
    const cooldownEnds = current.changedAt!.getTime() + c.COOLDOWN_MS;
    if (now.getTime() < cooldownEnds) {
      return { admitted: false, state: 'open', retryAfterMs: cooldownEnds - now.getTime() };
    }
    // T2, evaluated lazily by the first submission after the cooldown.
    const t2 = transition(current, 'T2', now);
    current = t2.next;
    transitions.push(t2.transition);
  }

  if (current.state === 'half_open') {
    const held = current.probeId !== null && current.probeLeaseUntil!.getTime() > now.getTime();
    if (held) return { admitted: false, state: 'half_open', retryAfterMs: null };
    const reclaimedProbe = current.probeId !== null;
    const probeId = newProbeId();
    current = {
      ...current,
      probeId,
      probeLeaseUntil: new Date(now.getTime() + c.PROBE_LEASE_MS),
    };
    return {
      admitted: true,
      ticket: { generation: current.generation, probeId },
      next: current,
      transitions,
      reclaimedProbe,
    };
  }

  return {
    admitted: true,
    ticket: { generation: current.generation, probeId: null },
    next: current,
    transitions,
    reclaimedProbe: false,
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

/** T1's guard: the window holds the minimum and meets the failure threshold (§6b). */
export function windowTrips(window: readonly CircuitWindowSample[]): boolean {
  const c = PROVIDER_CIRCUIT_DEFAULTS;
  const failures = window.filter((s) => s.classification === 'failure').length;
  return window.length >= c.MIN_SAMPLES && failures * 100 >= c.FAILURE_PERCENT * window.length;
}

/**
 * Recording one submission's answer (§6d). `window` is the circuit window of
 * the **current** generation including this sample when it counts — newest
 * first, at most `WINDOW_MAX_SAMPLES` inside `WINDOW_MS`; it is read only for a
 * current `closed` ticket.
 */
export function recordSubmission(
  snapshot: CircuitSnapshot,
  ticket: CircuitTicket,
  classification: ProviderHealthClassification,
  window: readonly CircuitWindowSample[],
  now: Date,
): RecordingDecision {
  const unchanged = (effect: RecordingEffect): RecordingDecision => ({
    next: snapshot,
    transitions: [],
    effect,
    window: null,
  });

  // A ticket from another episode, or a probe that no longer holds the slot,
  // records its sample and changes nothing in the circuit.
  if (ticket.generation !== snapshot.generation) return unchanged('stale');

  if (ticket.probeId !== null) {
    if (snapshot.state !== 'half_open' || snapshot.probeId !== ticket.probeId) {
      return unchanged('stale');
    }
    const released: CircuitSnapshot = { ...snapshot, probeId: null, probeLeaseUntil: null };
    if (classification === 'failure') {
      const t3 = transition(released, 'T3', now);
      return { next: t3.next, transitions: [t3.transition], effect: 'probe_failure', window: null };
    }
    if (classification === 'success') {
      const successes = released.probeSuccesses + 1;
      if (successes >= PROVIDER_CIRCUIT_DEFAULTS.HALF_OPEN_SUCCESSES_TO_CLOSE) {
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
  if (windowTrips(window)) {
    const t1 = transition(snapshot, 'T1', now);
    return { next: t1.next, transitions: [t1.transition], effect: 'evaluated', window: figures };
  }
  return { next: snapshot, transitions: [], effect: 'evaluated', window: figures };
}

/** When an `open` circuit's cooldown ends, or `null` when it is not `open`. */
export function cooldownUntil(snapshot: CircuitSnapshot): Date | null {
  if (snapshot.state !== 'open' || !snapshot.changedAt) return null;
  return new Date(snapshot.changedAt.getTime() + PROVIDER_CIRCUIT_DEFAULTS.COOLDOWN_MS);
}
