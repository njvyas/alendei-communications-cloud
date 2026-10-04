import {
  PROVIDER_CIRCUIT_DEFAULTS as C,
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_HEALTH_DEFAULTS as H,
  PROVIDER_PROBE_CLASSIFICATION,
  PROVIDER_PROBE_OUTCOMES,
  PROVIDER_SUBMISSION_CLASSIFICATION,
  PROVIDER_SUBMISSION_SAMPLE_OUTCOMES,
  type ProviderCircuitPolicy,
  type ProviderHealthClassification,
} from '@acc/contracts';

import {
  admit,
  classifyProbe,
  classifySubmission,
  cooldownUntil,
  deriveHealth,
  effectiveHealth,
  recordSubmission,
  routingEligibility,
  submissionOutcome,
  windowTrips,
  type CircuitSnapshot,
  type CircuitWindowSample,
  type HealthWindowSample,
} from './provider-state-machine';

/**
 * Phase 2.3 — the health and circuit state machines as pure functions
 * (`PROVIDER_ADAPTER.md` §5-§6). Every boundary is driven by explicit
 * timestamps: there is no clock to sleep on.
 */
const T0 = new Date('2026-10-03T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const closed = (generation = 0): CircuitSnapshot => ({
  state: 'closed',
  generation,
  changedAt: null,
  probes: [],
  probeSuccesses: 0,
});
const open = (generation = 1, changedAt = T0): CircuitSnapshot => ({
  state: 'open',
  generation,
  changedAt,
  probes: [],
  probeSuccesses: 0,
});
const halfOpen = (
  generation = 2,
  probes: { id: string; leaseUntil: Date }[] = [],
  probeSuccesses = 0,
): CircuitSnapshot => ({
  state: 'half_open',
  generation,
  changedAt: T0,
  probes,
  probeSuccesses,
});
/** The seeded policy, or a variation of it. The engine reads only what it is given. */
const policy = (overrides: Partial<ProviderCircuitPolicy> = {}): ProviderCircuitPolicy => ({
  ...C,
  ...overrides,
});
const P = policy();

const s = (n: number): HealthWindowSample[] =>
  Array.from({ length: n }, () => ({ classification: 'success', latencyMs: 0 }));
const f = (n: number): HealthWindowSample[] =>
  Array.from({ length: n }, () => ({ classification: 'failure', latencyMs: 0 }));
const cw = (failures: number, successes: number): CircuitWindowSample[] => [
  ...Array.from({ length: failures }, () => ({ classification: 'failure' as const })),
  ...Array.from({ length: successes }, () => ({ classification: 'success' as const })),
];

let ids = 0;
const nextId = () => `probe-${++ids}`;

describe('Phase 2.3 failure classification (§5b)', () => {
  it('classifies every submission outcome exactly as the frozen table says', () => {
    expect(PROVIDER_SUBMISSION_CLASSIFICATION).toEqual({
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
    // Every failure category of the adapter taxonomy has a classification.
    expect([...PROVIDER_SUBMISSION_SAMPLE_OUTCOMES].sort()).toEqual(
      ['accepted', ...PROVIDER_FAILURE_CATEGORIES.map((c) => c.toLowerCase())].sort(),
    );
    for (const outcome of PROVIDER_SUBMISSION_SAMPLE_OUTCOMES) {
      expect(classifySubmission(outcome)).toBe(PROVIDER_SUBMISSION_CLASSIFICATION[outcome]);
    }
  });

  it('classifies probes: healthy is a success, unhealthy and timeout are failures', () => {
    expect(PROVIDER_PROBE_CLASSIFICATION).toEqual({
      healthy: 'success',
      unhealthy: 'failure',
      timeout: 'failure',
    });
    for (const outcome of PROVIDER_PROBE_OUTCOMES) {
      expect(classifyProbe(outcome)).toBe(PROVIDER_PROBE_CLASSIFICATION[outcome]);
    }
  });

  it('derives the sample outcome from a submission result', () => {
    expect(
      submissionOutcome({
        outcome: 'accepted',
        submissionId: 'a',
        correlationId: 'b',
        providerMessageId: 'c',
        latencyMs: 1,
      }),
    ).toBe('accepted');
    expect(
      submissionOutcome({
        outcome: 'rejected',
        submissionId: 'a',
        correlationId: 'b',
        failure: { category: 'RATE_LIMITED', retryable: true, providerCode: null, message: 'x' },
        latencyMs: 1,
      }),
    ).toBe('rate_limited');
  });
});

describe('Phase 2.3 health derivation (§5c)', () => {
  it('rule 1: fewer than the minimum counted samples concludes nothing — healthy', () => {
    expect(H.MIN_SAMPLES).toBe(5);
    expect(deriveHealth([])).toBe('healthy');
    expect(deriveHealth(f(4))).toBe('healthy');
  });

  it('rule 2: five consecutive failures at the head is offline, four is not', () => {
    expect(deriveHealth(f(5))).toBe('offline');
    expect(deriveHealth([...f(5), ...s(15)])).toBe('offline');
    // Four at the head, then a success: the streak is 4 — critical by rate (5/9 ≥ 50 %), not offline.
    expect(deriveHealth([...f(4), ...s(1), ...f(1), ...s(3)])).toBe('critical');
    // The streak counts from the newest sample only.
    expect(deriveHealth([...s(1), ...f(5)])).toBe('critical');
  });

  it('rule 3: a failure rate of exactly 50 % is critical; just below is degraded', () => {
    expect(deriveHealth([...s(1), ...f(4), ...s(5), ...f(6), ...s(4)])).toBe('critical'); // 10/20
    expect(deriveHealth([...s(1), ...f(4), ...s(6), ...f(5), ...s(4)])).toBe('degraded'); // 9/20
  });

  it('rule 4: a failure rate of exactly 20 % is degraded; just below is healthy', () => {
    expect(deriveHealth([...s(4), ...f(1)])).toBe('degraded'); // 1/5
    expect(deriveHealth([...s(16), ...f(4)])).toBe('degraded'); // 4/20
    expect(deriveHealth([...s(17), ...f(3)])).toBe('healthy'); // 3/20
  });

  it('rule 5: a mean success latency of 1000 ms is degraded, 999 ms is not; failures do not count toward latency', () => {
    expect(H.DEGRADED_LATENCY_MS).toBe(1000);
    const slow = (ms: number) =>
      Array.from({ length: 5 }, () => ({ classification: 'success' as const, latencyMs: ms }));
    expect(deriveHealth(slow(1000))).toBe('degraded');
    expect(deriveHealth(slow(999))).toBe('healthy');
    expect(
      deriveHealth([
        { classification: 'success', latencyMs: 500 },
        { classification: 'success', latencyMs: 1500 },
        ...s(3).map(() => ({ classification: 'success' as const, latencyMs: 1000 })),
      ]),
    ).toBe('degraded'); // mean exactly 1000
    expect(deriveHealth([...s(17), { classification: 'failure', latencyMs: 3000 }, ...s(2)])).toBe(
      'healthy',
    );
  });

  it('rule 6: otherwise healthy; an override always wins', () => {
    expect(deriveHealth(s(20))).toBe('healthy');
    expect(effectiveHealth(null, f(5))).toBe('offline');
    expect(effectiveHealth('healthy', f(5))).toBe('healthy');
    expect(effectiveHealth('offline', s(20))).toBe('offline');
  });

  it('every pair of distinct states is reachable in one evaluation (health is not edge-driven)', () => {
    const windows = {
      healthy: s(5),
      degraded: [...s(4), ...f(1)],
      critical: [...s(1), ...f(3), ...s(1)],
      offline: f(5),
    } as const;
    for (const [state, window] of Object.entries(windows)) {
      expect(deriveHealth(window)).toBe(state);
    }
  });
});

describe('Phase 2.3 circuit admission (§6c) under the seeded policy', () => {
  it('closed: every submission is admitted as a normal submission of the current generation', () => {
    const before = closed(7);
    expect(admit(before, P, T0, nextId)).toEqual({
      admitted: true,
      ticket: { generation: 7, probeId: null },
      next: before,
      transitions: [],
      reclaimedProbes: 0,
    });
  });

  it('open inside the cooldown: refused with the exact time left, at every millisecond up to the boundary', () => {
    expect(P.cooldownMs).toBe(30_000);
    expect(admit(open(1), P, at(0), nextId)).toEqual({
      admitted: false,
      state: 'open',
      retryAfterMs: 30_000,
    });
    expect(admit(open(1), P, at(29_999), nextId)).toEqual({
      admitted: false,
      state: 'open',
      retryAfterMs: 1,
    });
  });

  it('open at exactly the cooldown: T2 to half_open (generation +1), and this submission is a probe', () => {
    const d = admit(open(1), P, at(30_000), () => 'P');
    expect(d.admitted).toBe(true);
    if (!d.admitted) return;
    expect(d.transitions).toEqual([
      { key: 'T2', from: 'open', to: 'half_open', cause: 'cooldown_elapsed', generation: 2 },
    ]);
    expect(d.next).toEqual({
      state: 'half_open',
      generation: 2,
      changedAt: at(30_000),
      probes: [{ id: 'P', leaseUntil: at(30_000 + P.probeLeaseMs) }],
      probeSuccesses: 0,
    });
    expect(d.ticket).toEqual({ generation: 2, probeId: 'P' });
    expect(d.reclaimedProbes).toBe(0);
  });

  it('half_open: a free slot admits a probe; the configured number held refuses, up to the lease boundary', () => {
    expect(admit(halfOpen(2), P, at(1), () => 'Q')).toMatchObject({
      admitted: true,
      ticket: { generation: 2, probeId: 'Q' },
    });
    const held = halfOpen(2, [{ id: 'Q', leaseUntil: at(10_000) }]);
    expect(admit(held, P, at(9_999), nextId)).toEqual({
      admitted: false,
      state: 'half_open',
      retryAfterMs: null,
    });
  });

  it('half_open with an expired lease: the slot is reclaimed by a new probe, and counted', () => {
    const held = halfOpen(2, [{ id: 'Q', leaseUntil: at(10_000) }], 1);
    const d = admit(held, P, at(10_000), () => 'R');
    expect(d).toMatchObject({
      admitted: true,
      ticket: { generation: 2, probeId: 'R' },
      reclaimedProbes: 1,
      transitions: [],
    });
    if (d.admitted) {
      expect(d.next.probeSuccesses).toBe(1);
      expect(d.next.probes.map((p) => p.id)).toEqual(['R']);
    }
  });

  it('only the configured probe count is ever in flight: one of five under the seeded policy', () => {
    expect(P.halfOpenMaxProbes).toBe(1);
    let snapshot = open(1);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const d = admit(snapshot, P, at(30_000 + i), nextId);
      outcomes.push(d.admitted);
      if (d.admitted) snapshot = d.next;
    }
    expect(outcomes).toEqual([true, false, false, false, false]);
  });
});

describe('Gate D.3 remediation: every circuit parameter is read from the policy, never a constant', () => {
  it('halfOpenMaxProbes = 3: exactly three of five concurrent admissions become probes', () => {
    const p = policy({ halfOpenMaxProbes: 3 });
    let snapshot = open(1);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const d = admit(snapshot, p, at(30_000 + i), nextId);
      outcomes.push(d.admitted);
      if (d.admitted) snapshot = d.next;
    }
    expect(outcomes).toEqual([true, true, true, false, false]);
    expect(snapshot.probes).toHaveLength(3);
  });

  it('cooldownMs and probeLeaseMs come from the policy', () => {
    const p = policy({ cooldownMs: 5_000, probeLeaseMs: 7_000 });
    expect(admit(open(1), p, at(4_999), nextId)).toMatchObject({
      admitted: false,
      retryAfterMs: 1,
    });
    const d = admit(open(1), p, at(5_000), () => 'L');
    expect(d).toMatchObject({ admitted: true });
    if (d.admitted) expect(d.next.probes).toEqual([{ id: 'L', leaseUntil: at(12_000) }]);
    expect(cooldownUntil(open(1), p)).toEqual(at(5_000));
  });

  it('minSamples and failurePercent come from the policy', () => {
    expect(windowTrips(cw(2, 0), policy({ minSamples: 2 }))).toBe(true);
    expect(windowTrips(cw(2, 0), P)).toBe(false);
    expect(windowTrips(cw(3, 2), policy({ failurePercent: 61 }))).toBe(false); // 60 %
    expect(windowTrips(cw(3, 2), policy({ failurePercent: 60 }))).toBe(true);
    expect(windowTrips(cw(1, 4), policy({ failurePercent: 20 }))).toBe(true);
    expect(windowTrips(cw(5, 0), policy({ failurePercent: 100 }))).toBe(true);
    expect(windowTrips(cw(4, 1), policy({ failurePercent: 100 }))).toBe(false);
  });

  it('halfOpenSuccessesToClose comes from the policy: one success closes when it is 1, three are needed when it is 3', () => {
    const one = recordSubmission(
      halfOpen(2, [{ id: 'P', leaseUntil: at(10_000) }]),
      { generation: 2, probeId: 'P' },
      'success',
      [],
      policy({ halfOpenSuccessesToClose: 1 }),
      at(1),
    );
    expect(one.next.state).toBe('closed');
    const three = recordSubmission(
      halfOpen(2, [{ id: 'P', leaseUntil: at(10_000) }], 1),
      { generation: 2, probeId: 'P' },
      'success',
      [],
      policy({ halfOpenSuccessesToClose: 3 }),
      at(1),
    );
    expect(three.next).toMatchObject({ state: 'half_open', probeSuccesses: 2 });
  });

  it('with several probes in flight, T3 clears every slot and the other probes become stale', () => {
    const many = halfOpen(2, [
      { id: 'A', leaseUntil: at(10_000) },
      { id: 'B', leaseUntil: at(10_000) },
    ]);
    const p = policy({ halfOpenMaxProbes: 2 });
    const failed = recordSubmission(many, { generation: 2, probeId: 'A' }, 'failure', [], p, at(1));
    expect(failed.next).toMatchObject({ state: 'open', generation: 3, probes: [] });
    const late = recordSubmission(
      failed.next,
      { generation: 2, probeId: 'B' },
      'success',
      [],
      p,
      at(2),
    );
    expect(late.effect).toBe('stale');
    // Without a transition, one probe's answer releases only its own slot.
    const released = recordSubmission(
      many,
      { generation: 2, probeId: 'A' },
      'neutral',
      [],
      p,
      at(1),
    );
    expect(released.next.probes.map((s) => s.id)).toEqual(['B']);
  });
});

describe('Phase 2.3 circuit recording (§6d) and the transition table (§6b)', () => {
  const rec = (
    snapshot: CircuitSnapshot,
    ticket: { generation: number; probeId: string | null },
    classification: ProviderHealthClassification,
    window: CircuitWindowSample[] = [],
    now = T0,
  ) => recordSubmission(snapshot, ticket, classification, window, P, now);

  it('T1 thresholds under the seeded policy: below the minimum never opens; at the minimum, exactly 50 % opens', () => {
    expect(P.minSamples).toBe(5);
    expect(P.failurePercent).toBe(50);
    expect(windowTrips(cw(4, 0), P)).toBe(false);
    expect(windowTrips(cw(2, 3), P)).toBe(false);
    expect(windowTrips(cw(3, 2), P)).toBe(true);
    expect(windowTrips(cw(3, 3), P)).toBe(true);
    expect(windowTrips(cw(9, 11), P)).toBe(false);
    expect(windowTrips(cw(10, 10), P)).toBe(true);
  });

  it('T1: a counted sample of the current generation that brings the window over the threshold opens the circuit', () => {
    const d = rec(closed(4), { generation: 4, probeId: null }, 'failure', cw(3, 2), at(5));
    expect(d.transitions).toEqual([
      { key: 'T1', from: 'closed', to: 'open', cause: 'failure_threshold', generation: 5 },
    ]);
    expect(d.next).toEqual({
      state: 'open',
      generation: 5,
      changedAt: at(5),
      probes: [],
      probeSuccesses: 0,
    });
    expect(d.window).toEqual({ samples: 5, failures: 3 });
  });

  it('T1 is evaluated after a success too, once the window reaches its minimum', () => {
    expect(rec(closed(0), { generation: 0, probeId: null }, 'success', cw(4, 1)).next.state).toBe(
      'open',
    );
  });

  it('a neutral sample never evaluates T1', () => {
    const d = rec(closed(0), { generation: 0, probeId: null }, 'neutral', cw(5, 0));
    expect(d).toMatchObject({ transitions: [], effect: 'evaluated', window: null });
    expect(d.next.state).toBe('closed');
  });

  it('a stale generation changes nothing, whatever the sample says', () => {
    for (const snapshot of [closed(6), open(6), halfOpen(6)]) {
      for (const c of ['success', 'failure', 'neutral'] as const) {
        expect(rec(snapshot, { generation: 5, probeId: null }, c, cw(5, 0))).toEqual({
          next: snapshot,
          transitions: [],
          effect: 'stale',
          window: null,
        });
      }
    }
  });

  it('a probe that no longer holds a slot is stale: it neither closes, re-opens nor releases', () => {
    const held = halfOpen(2, [{ id: 'NEW', leaseUntil: at(10_000) }], 1);
    for (const c of ['success', 'failure', 'neutral'] as const) {
      expect(rec(held, { generation: 2, probeId: 'OLD' }, c)).toEqual({
        next: held,
        transitions: [],
        effect: 'stale',
        window: null,
      });
    }
  });

  it('T3: a failing probe re-opens the circuit (generation +1, cooldown restarts)', () => {
    const held = halfOpen(2, [{ id: 'P', leaseUntil: at(10_000) }], 1);
    const d = rec(held, { generation: 2, probeId: 'P' }, 'failure', [], at(3));
    expect(d.transitions).toEqual([
      { key: 'T3', from: 'half_open', to: 'open', cause: 'probe_failed', generation: 3 },
    ]);
    expect(d.next).toMatchObject({
      state: 'open',
      changedAt: at(3),
      probes: [],
      probeSuccesses: 0,
    });
    expect(cooldownUntil(d.next, P)).toEqual(at(3 + P.cooldownMs));
  });

  it('T4: the second successful probe closes the circuit; the first only counts and releases its slot', () => {
    expect(P.halfOpenSuccessesToClose).toBe(2);
    const first = rec(
      halfOpen(2, [{ id: 'P', leaseUntil: at(10_000) }]),
      { generation: 2, probeId: 'P' },
      'success',
    );
    expect(first).toMatchObject({ transitions: [], effect: 'probe_success' });
    expect(first.next).toMatchObject({ state: 'half_open', probes: [], probeSuccesses: 1 });
    const second = rec(
      { ...first.next, probes: [{ id: 'Q', leaseUntil: at(20_000) }] },
      { generation: 2, probeId: 'Q' },
      'success',
      [],
      at(9),
    );
    expect(second.transitions).toEqual([
      { key: 'T4', from: 'half_open', to: 'closed', cause: 'probes_succeeded', generation: 3 },
    ]);
    expect(second.next).toEqual({
      state: 'closed',
      generation: 3,
      changedAt: at(9),
      probes: [],
      probeSuccesses: 0,
    });
  });

  it('a neutral probe releases its slot and changes nothing else', () => {
    const d = rec(
      halfOpen(2, [{ id: 'P', leaseUntil: at(10_000) }], 1),
      { generation: 2, probeId: 'P' },
      'neutral',
    );
    expect(d).toMatchObject({ transitions: [], effect: 'probe_neutral' });
    expect(d.next).toMatchObject({
      state: 'half_open',
      probes: [],
      probeSuccesses: 1,
      generation: 2,
    });
  });

  it('no other edge exists: closed→half_open, open→closed and self-transitions are unreachable, under any valid policy', () => {
    const reached = new Set<string>();
    const lease = at(1);
    const snapshots = [
      closed(1),
      open(1),
      halfOpen(1),
      halfOpen(1, [{ id: 'P', leaseUntil: lease }]),
      halfOpen(1, [{ id: 'P', leaseUntil: lease }], 1),
      halfOpen(1, [
        { id: 'P', leaseUntil: lease },
        { id: 'Q', leaseUntil: lease },
      ]),
    ];
    for (const p of [
      P,
      policy({ halfOpenMaxProbes: 3, halfOpenSuccessesToClose: 1, minSamples: 1 }),
    ]) {
      for (const snapshot of snapshots) {
        for (const now of [at(0), at(p.cooldownMs), at(10 * p.cooldownMs)]) {
          const d = admit(snapshot, p, now, nextId);
          if (d.admitted) for (const t of d.transitions) reached.add(`${t.from}>${t.to}`);
          for (const c of ['success', 'failure', 'neutral'] as const) {
            for (const probeId of [null, 'P']) {
              for (const window of [cw(0, 0), cw(5, 0), cw(0, 5)]) {
                const r = recordSubmission(snapshot, { generation: 1, probeId }, c, window, p, now);
                for (const t of r.transitions) reached.add(`${t.from}>${t.to}`);
              }
            }
          }
        }
      }
    }
    expect([...reached].sort()).toEqual([
      'closed>open',
      'half_open>closed',
      'half_open>open',
      'open>half_open',
    ]);
  });

  it('a full episode under an injected clock: CLOSED → OPEN → HALF_OPEN → OPEN → HALF_OPEN → CLOSED', () => {
    let snapshot = closed(0);
    const trail: string[] = [snapshot.state];
    const window: CircuitWindowSample[] = [];
    for (let i = 0; i < 5; i++) {
      const a = admit(snapshot, P, at(i * 100), nextId);
      if (!a.admitted) throw new Error('should be admitted');
      window.unshift({ classification: 'failure' });
      snapshot = recordSubmission(snapshot, a.ticket, 'failure', window, P, at(i * 100 + 10)).next;
    }
    trail.push(snapshot.state);
    expect(admit(snapshot, P, at(410 + P.cooldownMs - 1), nextId).admitted).toBe(false);
    let a = admit(snapshot, P, at(410 + P.cooldownMs), nextId);
    if (!a.admitted) throw new Error('cooldown elapsed');
    snapshot = a.next;
    trail.push(snapshot.state);
    snapshot = recordSubmission(
      snapshot,
      a.ticket,
      'failure',
      [],
      P,
      at(410 + P.cooldownMs + 5),
    ).next;
    trail.push(snapshot.state);
    const reopened = snapshot.changedAt!.getTime();
    a = admit(snapshot, P, new Date(reopened + P.cooldownMs), nextId);
    if (!a.admitted) throw new Error('second cooldown elapsed');
    snapshot = a.next;
    trail.push(snapshot.state);
    snapshot = recordSubmission(
      snapshot,
      a.ticket,
      'success',
      [],
      P,
      new Date(reopened + P.cooldownMs + 1),
    ).next;
    a = admit(snapshot, P, new Date(reopened + P.cooldownMs + 2), nextId);
    if (!a.admitted) throw new Error('slot free again');
    snapshot = recordSubmission(
      a.next,
      a.ticket,
      'success',
      [],
      P,
      new Date(reopened + P.cooldownMs + 3),
    ).next;
    trail.push(snapshot.state);
    expect(trail).toEqual(['closed', 'open', 'half_open', 'open', 'half_open', 'closed']);
    expect(snapshot.generation).toBe(5);
  });
});

describe('Gate D.3 remediation: the routing-eligibility contract (§6h)', () => {
  it('lifecycle first: disabled and draining are excluded whatever the circuit', () => {
    for (const status of ['disabled', 'draining'] as const) {
      for (const snapshot of [closed(), open(1, at(-10 * P.cooldownMs)), halfOpen()]) {
        expect(routingEligibility(status, snapshot, P, T0)).toEqual({
          verdict: 'excluded_lifecycle',
          status,
        });
      }
    }
  });

  it('OPEN excludes the provider from normal traffic for exactly the configured cooldown', () => {
    const p = policy({ cooldownMs: 8_000 });
    expect(routingEligibility('active', open(1), p, at(0))).toEqual({
      verdict: 'excluded_open',
      retryAfterMs: 8_000,
    });
    expect(routingEligibility('active', open(1), p, at(7_999))).toEqual({
      verdict: 'excluded_open',
      retryAfterMs: 1,
    });
    // At the cooldown the next admission would half-open it: probes only.
    expect(routingEligibility('active', open(1), p, at(8_000))).toEqual({
      verdict: 'probe_only',
      probeSlotsFree: 1,
    });
  });

  it('HALF_OPEN permits only the configured probe count: free slots fall as probes are admitted, never above the policy', () => {
    const p = policy({ halfOpenMaxProbes: 3 });
    let snapshot = halfOpen(2);
    const free: number[] = [
      routingEligibility('active', snapshot, p, at(1)).verdict === 'probe_only' ? 3 : -1,
    ];
    for (let i = 0; i < 4; i++) {
      const d = admit(snapshot, p, at(1), nextId);
      if (d.admitted) snapshot = d.next;
      const e = routingEligibility('active', snapshot, p, at(1));
      free.push(e.verdict === 'probe_only' ? e.probeSlotsFree : -1);
    }
    expect(free).toEqual([3, 2, 1, 0, 0]);
    // Expired leases free their slots again.
    expect(routingEligibility('active', snapshot, p, at(1 + p.probeLeaseMs))).toEqual({
      verdict: 'probe_only',
      probeSlotsFree: 3,
    });
  });

  it('CLOSED is eligible, subject to lifecycle; eligibility is read-only and claims nothing', () => {
    const snapshot = closed(3);
    expect(routingEligibility('active', snapshot, P, T0)).toEqual({ verdict: 'eligible' });
    const held = halfOpen(2, [{ id: 'P', leaseUntil: at(10_000) }]);
    routingEligibility('active', held, P, T0);
    expect(held.probes).toHaveLength(1);
  });
});
