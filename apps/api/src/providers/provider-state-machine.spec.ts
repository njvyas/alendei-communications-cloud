import {
  PROVIDER_CIRCUIT_DEFAULTS as C,
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_HEALTH_DEFAULTS as H,
  PROVIDER_PROBE_CLASSIFICATION,
  PROVIDER_PROBE_OUTCOMES,
  PROVIDER_SUBMISSION_CLASSIFICATION,
  PROVIDER_SUBMISSION_SAMPLE_OUTCOMES,
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
  probeId: null,
  probeLeaseUntil: null,
  probeSuccesses: 0,
});
const open = (generation = 1, changedAt = T0): CircuitSnapshot => ({
  state: 'open',
  generation,
  changedAt,
  probeId: null,
  probeLeaseUntil: null,
  probeSuccesses: 0,
});
const halfOpen = (
  generation = 2,
  probe: { id: string; leaseUntil: Date } | null = null,
  probeSuccesses = 0,
): CircuitSnapshot => ({
  state: 'half_open',
  generation,
  changedAt: T0,
  probeId: probe?.id ?? null,
  probeLeaseUntil: probe?.leaseUntil ?? null,
  probeSuccesses,
});

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

describe('Phase 2.3 circuit admission (§6c)', () => {
  it('closed: every submission is admitted as a normal submission of the current generation', () => {
    const before = closed(7);
    const d = admit(before, T0, nextId);
    expect(d).toEqual({
      admitted: true,
      ticket: { generation: 7, probeId: null },
      next: before,
      transitions: [],
      reclaimedProbe: false,
    });
  });

  it('open inside the cooldown: refused with the exact time left, at every millisecond up to the boundary', () => {
    expect(C.COOLDOWN_MS).toBe(30_000);
    expect(admit(open(1), at(0), nextId)).toEqual({
      admitted: false,
      state: 'open',
      retryAfterMs: 30_000,
    });
    expect(admit(open(1), at(29_999), nextId)).toEqual({
      admitted: false,
      state: 'open',
      retryAfterMs: 1,
    });
  });

  it('open at exactly the cooldown: T2 to half_open (generation +1), and this submission is the probe', () => {
    const d = admit(open(1), at(30_000), () => 'P');
    expect(d.admitted).toBe(true);
    if (!d.admitted) return;
    expect(d.transitions).toEqual([
      { key: 'T2', from: 'open', to: 'half_open', cause: 'cooldown_elapsed', generation: 2 },
    ]);
    expect(d.next).toEqual({
      state: 'half_open',
      generation: 2,
      changedAt: at(30_000),
      probeId: 'P',
      probeLeaseUntil: at(30_000 + C.PROBE_LEASE_MS),
      probeSuccesses: 0,
    });
    expect(d.ticket).toEqual({ generation: 2, probeId: 'P' });
    expect(d.reclaimedProbe).toBe(false);
  });

  it('half_open with the slot free: the probe; with the slot held: refused, up to the lease boundary', () => {
    const d = admit(halfOpen(2), at(1), () => 'Q');
    expect(d).toMatchObject({ admitted: true, ticket: { generation: 2, probeId: 'Q' } });
    const held = halfOpen(2, { id: 'Q', leaseUntil: at(10_000) });
    expect(admit(held, at(9_999), nextId)).toEqual({
      admitted: false,
      state: 'half_open',
      retryAfterMs: null,
    });
  });

  it('half_open with an expired lease: the slot is reclaimed by a new probe, flagged as such', () => {
    const held = halfOpen(2, { id: 'Q', leaseUntil: at(10_000) }, 1);
    const d = admit(held, at(10_000), () => 'R');
    expect(d).toMatchObject({
      admitted: true,
      ticket: { generation: 2, probeId: 'R' },
      reclaimedProbe: true,
      transitions: [],
    });
    if (d.admitted) expect(d.next.probeSuccesses).toBe(1);
  });

  it('only one probe is ever in flight: the probe count is one by construction', () => {
    expect(C.HALF_OPEN_MAX_PROBES).toBe(1);
    let snapshot = open(1);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const d = admit(snapshot, at(30_000 + i), nextId);
      outcomes.push(d.admitted);
      if (d.admitted) snapshot = d.next;
    }
    expect(outcomes).toEqual([true, false, false, false, false]);
  });
});

describe('Phase 2.3 circuit recording (§6d) and the transition table (§6b)', () => {
  const rec = (
    snapshot: CircuitSnapshot,
    ticket: { generation: number; probeId: string | null },
    classification: ProviderHealthClassification,
    window: CircuitWindowSample[] = [],
    now = T0,
  ) => recordSubmission(snapshot, ticket, classification, window, now);

  it('T1 thresholds: below the minimum never opens; at the minimum, exactly 50 % opens', () => {
    expect(C.MIN_SAMPLES).toBe(5);
    expect(C.FAILURE_PERCENT).toBe(50);
    expect(windowTrips(cw(4, 0))).toBe(false); // 4 samples, all failures
    expect(windowTrips(cw(2, 3))).toBe(false); // 40 %
    expect(windowTrips(cw(3, 2))).toBe(true); // 60 %
    expect(windowTrips(cw(3, 3))).toBe(true); // exactly 50 %
    expect(windowTrips(cw(9, 11))).toBe(false); // 45 %
    expect(windowTrips(cw(10, 10))).toBe(true); // exactly 50 %
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
      probeId: null,
      probeLeaseUntil: null,
      probeSuccesses: 0,
    });
    expect(d.window).toEqual({ samples: 5, failures: 3 });
  });

  it('T1 is evaluated after a success too, once the window reaches its minimum', () => {
    const d = rec(closed(0), { generation: 0, probeId: null }, 'success', cw(4, 1));
    expect(d.next.state).toBe('open');
  });

  it('a neutral sample never evaluates T1', () => {
    const d = rec(closed(0), { generation: 0, probeId: null }, 'neutral', cw(5, 0));
    expect(d).toMatchObject({ transitions: [], effect: 'evaluated', window: null });
    expect(d.next.state).toBe('closed');
  });

  it('a stale generation changes nothing, whatever the sample says', () => {
    for (const snapshot of [closed(6), open(6), halfOpen(6)]) {
      for (const c of ['success', 'failure', 'neutral'] as const) {
        const d = rec(snapshot, { generation: 5, probeId: null }, c, cw(5, 0));
        expect(d).toEqual({ next: snapshot, transitions: [], effect: 'stale', window: null });
      }
    }
  });

  it('a probe that no longer holds the slot is stale: it neither closes, re-opens nor releases', () => {
    const held = halfOpen(2, { id: 'NEW', leaseUntil: at(10_000) }, 1);
    for (const c of ['success', 'failure', 'neutral'] as const) {
      expect(rec(held, { generation: 2, probeId: 'OLD' }, c)).toEqual({
        next: held,
        transitions: [],
        effect: 'stale',
        window: null,
      });
    }
  });

  it('T3: the probe failing re-opens the circuit (generation +1, cooldown restarts)', () => {
    const held = halfOpen(2, { id: 'P', leaseUntil: at(10_000) }, 1);
    const d = rec(held, { generation: 2, probeId: 'P' }, 'failure', [], at(3));
    expect(d.transitions).toEqual([
      { key: 'T3', from: 'half_open', to: 'open', cause: 'probe_failed', generation: 3 },
    ]);
    expect(d.next).toMatchObject({
      state: 'open',
      changedAt: at(3),
      probeId: null,
      probeSuccesses: 0,
    });
    expect(cooldownUntil(d.next)).toEqual(at(3 + C.COOLDOWN_MS));
  });

  it('T4: the second successful probe closes the circuit; the first only counts and releases the slot', () => {
    expect(C.HALF_OPEN_SUCCESSES_TO_CLOSE).toBe(2);
    const first = rec(
      halfOpen(2, { id: 'P', leaseUntil: at(10_000) }),
      { generation: 2, probeId: 'P' },
      'success',
    );
    expect(first).toMatchObject({ transitions: [], effect: 'probe_success' });
    expect(first.next).toMatchObject({
      state: 'half_open',
      probeId: null,
      probeLeaseUntil: null,
      probeSuccesses: 1,
    });
    const second = rec(
      { ...first.next, probeId: 'Q', probeLeaseUntil: at(20_000) },
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
      probeId: null,
      probeLeaseUntil: null,
      probeSuccesses: 0,
    });
  });

  it('a neutral probe releases the slot and changes nothing else', () => {
    const d = rec(
      halfOpen(2, { id: 'P', leaseUntil: at(10_000) }, 1),
      { generation: 2, probeId: 'P' },
      'neutral',
    );
    expect(d).toMatchObject({ transitions: [], effect: 'probe_neutral' });
    expect(d.next).toMatchObject({
      state: 'half_open',
      probeId: null,
      probeSuccesses: 1,
      generation: 2,
    });
  });

  it('no other edge exists: closed→half_open, open→closed and self-transitions are unreachable', () => {
    const reached = new Set<string>();
    // Every reachable kind of snapshot: each state, and half_open with and
    // without a held slot and with and without a prior successful probe.
    const snapshots = [
      closed(1),
      open(1),
      halfOpen(1),
      halfOpen(1, { id: 'P', leaseUntil: at(1) }),
      halfOpen(1, { id: 'P', leaseUntil: at(1) }, 1),
    ];
    for (const snapshot of snapshots) {
      for (const now of [at(0), at(C.COOLDOWN_MS), at(10 * C.COOLDOWN_MS)]) {
        const d = admit(snapshot, now, nextId);
        if (d.admitted) for (const t of d.transitions) reached.add(`${t.from}>${t.to}`);
        for (const c of ['success', 'failure', 'neutral'] as const) {
          for (const probeId of [null, 'P']) {
            for (const window of [cw(0, 0), cw(5, 0), cw(0, 5)]) {
              const r = recordSubmission(snapshot, { generation: 1, probeId }, c, window, now);
              for (const t of r.transitions) reached.add(`${t.from}>${t.to}`);
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
    // Five failures in the first second open the circuit on the fifth.
    for (let i = 0; i < 5; i++) {
      const a = admit(snapshot, at(i * 100), nextId);
      if (!a.admitted) throw new Error('should be admitted');
      window.unshift({ classification: 'failure' });
      const r = recordSubmission(snapshot, a.ticket, 'failure', window, at(i * 100 + 10));
      snapshot = r.next;
    }
    trail.push(snapshot.state);
    expect(admit(snapshot, at(410 + C.COOLDOWN_MS - 1), nextId).admitted).toBe(false);
    let a = admit(snapshot, at(410 + C.COOLDOWN_MS), nextId);
    if (!a.admitted) throw new Error('cooldown elapsed');
    snapshot = a.next;
    trail.push(snapshot.state);
    snapshot = recordSubmission(
      snapshot,
      a.ticket,
      'failure',
      [],
      at(410 + C.COOLDOWN_MS + 5),
    ).next;
    trail.push(snapshot.state);
    const reopened = snapshot.changedAt!.getTime();
    a = admit(snapshot, new Date(reopened + C.COOLDOWN_MS), nextId);
    if (!a.admitted) throw new Error('second cooldown elapsed');
    snapshot = a.next;
    trail.push(snapshot.state);
    snapshot = recordSubmission(
      snapshot,
      a.ticket,
      'success',
      [],
      new Date(reopened + C.COOLDOWN_MS + 1),
    ).next;
    a = admit(snapshot, new Date(reopened + C.COOLDOWN_MS + 2), nextId);
    if (!a.admitted) throw new Error('slot free again');
    snapshot = recordSubmission(
      (snapshot = a.next),
      a.ticket,
      'success',
      [],
      new Date(reopened + C.COOLDOWN_MS + 3),
    ).next;
    trail.push(snapshot.state);
    expect(trail).toEqual(['closed', 'open', 'half_open', 'open', 'half_open', 'closed']);
    expect(snapshot.generation).toBe(5);
  });
});
