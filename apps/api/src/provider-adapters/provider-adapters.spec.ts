import {
  CHANNEL_CODES,
  PROVIDER_ADAPTER_KEYS,
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_HEALTH_DEFAULTS,
  PROVIDER_SUBMISSION_DEFAULTS,
  RETRYABLE_FAILURE_CATEGORIES,
  SIMULATOR_BEHAVIORS,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderSubmission,
  type ProviderSubmissionResult,
  type SimulatorBehavior,
} from '@acc/contracts';

import { ProviderAdapterNotRegistered, ProviderAdapterRegistry } from './adapter-registry';
import { ProviderAdapterUnsupportedOperation, SimulatorAdapter } from './simulator.adapter';
import { ProviderSubmissionExecutor } from './submission-executor';
import type { SubmissionTimer } from './submission-timer';

/**
 * A virtual clock: `sleep` registers a wake-up, `advance` moves time and wakes
 * every sleeper that is due, in order. Nothing here waits on the wall clock, so
 * every latency below is exact.
 */
class VirtualTimer implements SubmissionTimer {
  private time = 0;
  private sleepers: { at: number; wake: () => void }[] = [];

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const sleeper = { at: this.time + ms, wake: resolve };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        'abort',
        () => {
          this.sleepers = this.sleepers.filter((s) => s !== sleeper);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Moves time forward, letting each woken sleeper's continuation run before the next. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await flush();
      const due = this.sleepers.filter((s) => s.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.time = due.at;
      this.sleepers = this.sleepers.filter((s) => s !== due);
      due.wake();
    }
    this.time = target;
    await flush();
  }

  get pending(): number {
    return this.sleepers.length;
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const context = (overrides: Partial<ProviderAdapterContext> = {}): ProviderAdapterContext => ({
  providerId: '01900000-0000-7000-8000-000000000001',
  adapterKey: 'simulator',
  channel: 'sms',
  capabilities: {},
  ...overrides,
});

const submission = (overrides: Partial<ProviderSubmission> = {}): ProviderSubmission => ({
  submissionId: '01900000-0000-7000-8000-0000000000aa',
  correlationId: '01900000-0000-7000-8000-0000000000bb',
  channel: 'sms',
  recipient: 'simulator:test-recipient',
  content: { text: 'synthetic' },
  ...overrides,
});

/** Runs one submission through the executor, driving the virtual clock until it settles. */
async function run(
  behavior: SimulatorBehavior,
  timeoutMs: number = PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS,
): Promise<{ result: ProviderSubmissionResult; timer: VirtualTimer }> {
  const timer = new VirtualTimer();
  const simulator = new SimulatorAdapter(timer);
  const executor = new ProviderSubmissionExecutor(timer);
  let settled: ProviderSubmissionResult | undefined;
  void executor
    .execute(simulator.forBehavior(behavior), context(), submission(), timeoutMs)
    .then((r) => (settled = r));
  await timer.advance(timeoutMs + 1000);
  return { result: settled!, timer };
}

describe('provider adapter contract (Phase 2.2)', () => {
  it('the simulator implements every member of the ProviderAdapter port', () => {
    const adapter: ProviderAdapter = new SimulatorAdapter(new VirtualTimer());
    for (const member of [
      'capabilities',
      'healthCheck',
      'send',
      'estimateCost',
      'checkStatus',
      'parseWebhook',
    ] as const) {
      expect(typeof adapter[member]).toBe('function');
    }
    expect(adapter.adapterKey).toBe('simulator');
    expect(adapter.capabilities().channels).toEqual(CHANNEL_CODES);
  });

  it('the Phase 3/7 members exist and refuse explicitly, with no behaviour', async () => {
    const adapter = new SimulatorAdapter(new VirtualTimer());
    await expect(adapter.estimateCost()).rejects.toBeInstanceOf(
      ProviderAdapterUnsupportedOperation,
    );
    await expect(adapter.checkStatus()).rejects.toThrow(
      'checkStatus is not implemented in Phase 2',
    );
    await expect(adapter.parseWebhook()).rejects.toThrow(
      'parseWebhook is not implemented in Phase 2',
    );
    const scenario = adapter.forBehavior('SUCCESS');
    await expect(scenario.estimateCost(context(), submission())).rejects.toBeInstanceOf(
      ProviderAdapterUnsupportedOperation,
    );
  });

  it('the failure taxonomy is closed, and retryability is fixed per category', () => {
    expect(PROVIDER_FAILURE_CATEGORIES).toEqual([
      'TIMEOUT',
      'PROVIDER_ERROR',
      'RATE_LIMITED',
      'AUTH_ERROR',
      'INVALID_REQUEST',
      'INVALID_RECIPIENT',
      'UNSUPPORTED_CONTENT',
      'CONFIGURATION_ERROR',
      'UNKNOWN',
    ]);
    expect([...RETRYABLE_FAILURE_CATEGORIES].sort()).toEqual([
      'PROVIDER_ERROR',
      'RATE_LIMITED',
      'TIMEOUT',
    ]);
  });
});

describe('SimulatorAdapter — the seven submission-time behaviours, deterministically', () => {
  const expectations: Record<
    SimulatorBehavior,
    {
      outcome: 'accepted' | 'rejected';
      category?: string;
      retryable?: boolean;
      providerCode?: string | null;
      latencyMs: number;
    }
  > = {
    SUCCESS: { outcome: 'accepted', latencyMs: 0 },
    SLOW_RESPONSE: {
      outcome: 'accepted',
      latencyMs: PROVIDER_SUBMISSION_DEFAULTS.SIMULATOR_SLOW_RESPONSE_MS,
    },
    TIMEOUT: {
      outcome: 'rejected',
      category: 'TIMEOUT',
      retryable: true,
      providerCode: null,
      latencyMs: PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS,
    },
    '500': {
      outcome: 'rejected',
      category: 'PROVIDER_ERROR',
      retryable: true,
      providerCode: 'SIM-500',
      latencyMs: 0,
    },
    '429': {
      outcome: 'rejected',
      category: 'RATE_LIMITED',
      retryable: true,
      providerCode: 'SIM-429',
      latencyMs: 0,
    },
    INVALID_CREDENTIALS: {
      outcome: 'rejected',
      category: 'AUTH_ERROR',
      retryable: false,
      providerCode: 'SIM-401',
      latencyMs: 0,
    },
    INVALID_REQUEST: {
      outcome: 'rejected',
      category: 'INVALID_REQUEST',
      retryable: false,
      providerCode: 'SIM-400',
      latencyMs: 0,
    },
  };

  it('covers exactly the frozen matrix', () => {
    expect(Object.keys(expectations).sort()).toEqual([...SIMULATOR_BEHAVIORS].sort());
  });

  for (const behavior of SIMULATOR_BEHAVIORS) {
    it(`${behavior} → ${expectations[behavior].outcome}${expectations[behavior].category ? ` / ${expectations[behavior].category}` : ''}`, async () => {
      const expected = expectations[behavior];
      const { result, timer } = await run(behavior);
      expect(result.outcome).toBe(expected.outcome);
      expect(result.submissionId).toBe(submission().submissionId);
      expect(result.correlationId).toBe(submission().correlationId);
      expect(result.latencyMs).toBe(expected.latencyMs);
      if (result.outcome === 'accepted') {
        // Derived from the submission id: the same submission always gets the same reference.
        expect(result.providerMessageId).toBe(`sim-${submission().submissionId}`);
        expect('failure' in result).toBe(false);
      } else {
        expect(result.failure).toMatchObject({
          category: expected.category,
          retryable: expected.retryable,
          providerCode: expected.providerCode,
        });
        expect('providerMessageId' in result).toBe(false);
      }
      // Nothing is left waiting: a timed-out wait is aborted, not abandoned.
      expect(timer.pending).toBe(0);
    });
  }

  it('is reproducible: the same behaviour and submission give the same result, run after run', async () => {
    for (const behavior of SIMULATOR_BEHAVIORS) {
      const a = await run(behavior);
      const b = await run(behavior);
      expect(b.result).toEqual(a.result);
    }
  });

  it('SLOW_RESPONSE is still accepted when the timeout is only just longer than its latency, and is a TIMEOUT when shorter', async () => {
    const slow = PROVIDER_SUBMISSION_DEFAULTS.SIMULATOR_SLOW_RESPONSE_MS;
    expect((await run('SLOW_RESPONSE', slow + 1)).result.outcome).toBe('accepted');
    const short = (await run('SLOW_RESPONSE', slow - 1)).result;
    expect(short.outcome).toBe('rejected');
    expect(short.outcome === 'rejected' && short.failure.category).toBe('TIMEOUT');
  });

  it('without an explicit behaviour, or with an unknown one, or for a channel it does not serve, the simulator answers CONFIGURATION_ERROR — never success', async () => {
    const timer = new VirtualTimer();
    const simulator = new SimulatorAdapter(timer);
    const noBehaviour = await simulator.send(context(), submission());
    expect(noBehaviour.outcome === 'rejected' && noBehaviour.failure.category).toBe(
      'CONFIGURATION_ERROR',
    );
    const unknown = await simulator
      .forBehavior('DELIVERY_DELAY' as SimulatorBehavior)
      .send(context(), submission(), { timeoutMs: 10 });
    expect(unknown.outcome === 'rejected' && unknown.failure.category).toBe('CONFIGURATION_ERROR');
    const foreign = await simulator
      .forBehavior('SUCCESS')
      .send(context({ channel: 'fax' as never }), submission(), { timeoutMs: 10 });
    expect(foreign.outcome === 'rejected' && foreign.failure.category).toBe('CONFIGURATION_ERROR');
  });

  it('health check is deterministic', async () => {
    await expect(new SimulatorAdapter(new VirtualTimer()).healthCheck()).resolves.toEqual({
      healthy: true,
      latencyMs: 0,
    });
  });
});

describe('ProviderSubmissionExecutor — normalization', () => {
  const adapterReturning = (send: ProviderAdapter['send']): ProviderAdapter => ({
    adapterKey: 'test',
    capabilities: () => ({ channels: ['sms'] }),
    healthCheck: async () => ({ healthy: true, latencyMs: 0 }),
    send,
    estimateCost: () => Promise.reject(new Error('n/a')),
    checkStatus: () => Promise.reject(new Error('n/a')),
    parseWebhook: () => Promise.reject(new Error('n/a')),
  });

  it('an adapter that throws becomes rejected / UNKNOWN, not an error and never a success', async () => {
    const timer = new VirtualTimer();
    const result = await new ProviderSubmissionExecutor(timer).execute(
      adapterReturning(() => Promise.reject(new Error('boom: secret-looking detail'))),
      context(),
      submission(),
      1000,
    );
    expect(result).toMatchObject({
      outcome: 'rejected',
      failure: { category: 'UNKNOWN', retryable: false, providerCode: null },
    });
    expect(JSON.stringify(result)).not.toContain('secret-looking detail');
  });

  it('a result outside the contract becomes rejected / UNKNOWN', async () => {
    const timer = new VirtualTimer();
    const executor = new ProviderSubmissionExecutor(timer);
    for (const bogus of [
      { outcome: 'delivered' },
      { outcome: 'accepted' }, // no providerMessageId
      { outcome: 'rejected', failure: { category: 'VENDOR_SPECIFIC_E42' } },
      null,
    ]) {
      const result = await executor.execute(
        adapterReturning(() => Promise.resolve(bogus as never)),
        context(),
        submission(),
        1000,
      );
      expect(result.outcome === 'rejected' && result.failure.category).toBe('UNKNOWN');
    }
  });

  it('retryability and identifiers are the executor’s, not the adapter’s', async () => {
    const timer = new VirtualTimer();
    const result = await new ProviderSubmissionExecutor(timer).execute(
      adapterReturning(() =>
        Promise.resolve({
          outcome: 'rejected',
          submissionId: 'forged',
          correlationId: 'forged',
          failure: { category: 'AUTH_ERROR', retryable: true, providerCode: 'X', message: 'm' },
          latencyMs: 999,
        }),
      ),
      context(),
      submission(),
      1000,
    );
    expect(result).toMatchObject({
      submissionId: submission().submissionId,
      correlationId: submission().correlationId,
      failure: { category: 'AUTH_ERROR', retryable: false },
      latencyMs: 0,
    });
  });
});

describe('ProviderAdapterRegistry', () => {
  const simulator = () => new SimulatorAdapter(new VirtualTimer());

  it('resolves simulator, and only the keys published in PROVIDER_ADAPTER_KEYS', () => {
    const registry = new ProviderAdapterRegistry([simulator()]);
    expect(registry.resolve('simulator')).toBeInstanceOf(SimulatorAdapter);
    expect([...registry.keys()]).toEqual([...PROVIDER_ADAPTER_KEYS]);
  });

  it('an unknown key fails closed — including case and whitespace variants', () => {
    const registry = new ProviderAdapterRegistry([simulator()]);
    for (const key of [
      'acme_sms',
      'Simulator',
      ' simulator',
      'simulator ',
      '',
      '__proto__',
      'constructor',
    ]) {
      expect(() => registry.resolve(key)).toThrow(ProviderAdapterNotRegistered);
    }
  });

  it('a key registered twice fails at construction, so registration order can never decide', () => {
    expect(() => new ProviderAdapterRegistry([simulator(), simulator()])).toThrow(
      'registered twice',
    );
  });

  it('the registered set must equal the published keys, in both directions', () => {
    expect(() => new ProviderAdapterRegistry([])).toThrow('do not match PROVIDER_ADAPTER_KEYS');
    const extra = { ...simulator(), adapterKey: 'acme_sms' } as unknown as ProviderAdapter;
    expect(() => new ProviderAdapterRegistry([simulator(), extra])).toThrow(
      'do not match PROVIDER_ADAPTER_KEYS',
    );
  });
});

describe('health check — simulator behaviours and the executor probe (Phase 2.3)', () => {
  /** Runs one health check through the executor, driving the virtual clock until it settles. */
  async function probe(
    adapter: ProviderAdapter,
    timeoutMs = PROVIDER_HEALTH_DEFAULTS.PROBE_TIMEOUT_MS,
  ) {
    const timer = new VirtualTimer();
    const executor = new ProviderSubmissionExecutor(timer);
    let settled: { outcome: string; latencyMs: number } | undefined;
    void executor.probe(adapter, context(), timeoutMs).then((r) => (settled = r));
    await timer.advance(timeoutMs + 1000);
    return { result: settled!, timer };
  }

  it('HEALTHY and UNHEALTHY answer at once and deterministically, run after run', async () => {
    for (let i = 0; i < 3; i++) {
      const sim = new SimulatorAdapter(new VirtualTimer());
      expect((await probe(sim.forHealthBehavior('HEALTHY'))).result).toEqual({
        outcome: 'healthy',
        latencyMs: 0,
      });
      expect((await probe(sim.forHealthBehavior('UNHEALTHY'))).result).toEqual({
        outcome: 'unhealthy',
        latencyMs: 0,
      });
    }
  });

  it('TIMEOUT never answers: the executor reports timeout at exactly the probe timeout, and leaves no waiter behind', async () => {
    const timer = new VirtualTimer();
    const sim = new SimulatorAdapter(timer);
    const executor = new ProviderSubmissionExecutor(timer);
    let settled: { outcome: string; latencyMs: number } | undefined;
    void executor
      .probe(sim.forHealthBehavior('TIMEOUT'), context(), PROVIDER_HEALTH_DEFAULTS.PROBE_TIMEOUT_MS)
      .then((r) => (settled = r));
    await timer.advance(PROVIDER_HEALTH_DEFAULTS.PROBE_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await timer.advance(1);
    expect(settled).toEqual({
      outcome: 'timeout',
      latencyMs: PROVIDER_HEALTH_DEFAULTS.PROBE_TIMEOUT_MS,
    });
    expect(timer.pending).toBe(0);
  });

  it('an unknown behaviour, a thrown error or an answer outside the contract is unhealthy — never healthy', async () => {
    const sim = new SimulatorAdapter(new VirtualTimer());
    expect((await probe(sim.forHealthBehavior('BOGUS' as never))).result.outcome).toBe('unhealthy');
    const adapter = (healthCheck: ProviderAdapter['healthCheck']): ProviderAdapter => ({
      ...sim.forHealthBehavior('HEALTHY'),
      healthCheck,
    });
    expect((await probe(adapter(() => Promise.reject(new Error('boom'))))).result.outcome).toBe(
      'unhealthy',
    );
    expect(
      (await probe(adapter(async () => ({ healthy: 'yes', latencyMs: 0 }) as never))).result
        .outcome,
    ).toBe('unhealthy');
    expect((await probe(adapter(async () => null as never))).result.outcome).toBe('unhealthy');
  });

  it('a health view never sends successfully: it has no submission behaviour', async () => {
    const result = await new SimulatorAdapter(new VirtualTimer())
      .forHealthBehavior('HEALTHY')
      .send(context(), submission(), { timeoutMs: 10 });
    expect(result.outcome === 'rejected' && result.failure.category).toBe('CONFIGURATION_ERROR');
  });
});
