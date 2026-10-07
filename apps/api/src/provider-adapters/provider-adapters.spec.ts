import {
  CHANNEL_CODES,
  PROVIDER_ADAPTER_KEYS,
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_HEALTH_DEFAULTS,
  PROVIDER_SUBMISSION_DEFAULTS,
  RETRYABLE_FAILURE_CATEGORIES,
  SIMULATOR_BEHAVIORS,
  type ChannelCode,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderHealthCheckOptions,
  type ProviderHealthProbe,
  type ProviderSubmission,
  type ProviderSubmissionResult,
  type SimulatorBehavior,
  type SimulatorHealthBehavior,
  type SubmissionPermit,
} from '@acc/contracts';

import { ProviderAdapterNotRegistered, ProviderAdapterRegistry } from './adapter-registry';
import {
  CircuitAdmission,
  CircuitAdmissionRequired,
  CircuitAdmissions,
  GuardedProviderAdapter,
  ProviderAdapterRefused,
  type AdapterSubmitOptions,
  type AdmissionGrant,
} from './circuit-admission';
import { ProviderAdapterUnsupportedOperation, SimulatorAdapter } from './simulator.adapter';
import { ProviderAdapterVariantRefused, ProviderSubmissionExecutor } from './submission-executor';
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

const PROVIDER = '01900000-0000-7000-8000-000000000001';

const context = (overrides: Partial<ProviderAdapterContext> = {}): ProviderAdapterContext => ({
  providerId: PROVIDER,
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

type Submit = (
  context: ProviderAdapterContext,
  submission: ProviderSubmission,
  options: AdapterSubmitOptions,
) => Promise<ProviderSubmissionResult>;

const acceptAll: Submit = async (_c, sub) => ({
  outcome: 'accepted',
  submissionId: sub.submissionId,
  correlationId: sub.correlationId,
  providerMessageId: 'p',
  latencyMs: 0,
});

/** A guarded test adapter: what `submit` does is the test's; `send` is the base's guard. */
class FakeAdapter extends GuardedProviderAdapter {
  readonly adapterKey: string;
  readonly #submit: Submit;
  readonly #health: (
    context: ProviderAdapterContext,
    options?: ProviderHealthCheckOptions,
  ) => Promise<ProviderHealthProbe>;

  constructor(
    options: {
      submit?: Submit;
      health?: FakeAdapter['healthCheck'];
      adapterKey?: string;
    } = {},
  ) {
    super();
    this.adapterKey = options.adapterKey ?? 'simulator';
    this.#submit = options.submit ?? acceptAll;
    this.#health = options.health ?? (async () => ({ healthy: true, latencyMs: 0 }));
    Object.freeze(this);
  }

  capabilities() {
    return { channels: ['sms'] as ChannelCode[] };
  }

  healthCheck(context: ProviderAdapterContext, options?: ProviderHealthCheckOptions) {
    return this.#health(context, options);
  }

  protected submit(
    context: ProviderAdapterContext,
    submission: ProviderSubmission,
    options: AdapterSubmitOptions,
  ) {
    return this.#submit(context, submission, options);
  }

  estimateCost(): Promise<never> {
    return Promise.reject(new Error('n/a'));
  }

  checkStatus(): Promise<never> {
    return Promise.reject(new Error('n/a'));
  }

  parseWebhook(): Promise<never> {
    return Promise.reject(new Error('n/a'));
  }
}

/**
 * A ledger, its executor, and an issuer standing in for the circuit's
 * admission (`ProviderStateStore.admit`, not under test here) — the executor
 * itself refuses any call without one (`PROVIDER_ADAPTER.md` §6h).
 */
function rig(
  timer: SubmissionTimer = new VirtualTimer(),
  options: { adapters?: GuardedProviderAdapter[]; submissionTimeoutMs?: number } = {},
) {
  const ledger = new CircuitAdmissions(timer, { submissionTimeoutMs: options.submissionTimeoutMs });
  const issuer = ledger.claimIssuer();
  const executor = new ProviderSubmissionExecutor(
    timer,
    ledger,
    options.adapters ?? [new SimulatorAdapter(timer)],
  );
  const admit = (overrides: Partial<AdmissionGrant> = {}) =>
    issuer.issue({
      providerId: PROVIDER,
      adapterKey: 'simulator',
      channel: 'sms',
      capabilities: {},
      ticket: { generation: 0, probeId: null },
      circuitPolicyVersion: 1,
      ...overrides,
    });
  return { ledger, issuer, executor, admit };
}

/** Counts every call that reached the simulated provider. */
const simulated = () =>
  jest.spyOn(SimulatorAdapter.prototype as unknown as { simulate: () => unknown }, 'simulate');

afterEach(() => jest.restoreAllMocks());

/** Runs one submission through the executor, driving the virtual clock until it settles. */
async function run(
  behavior: SimulatorBehavior | undefined,
  timeoutMs: number = PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS,
  grant: Partial<AdmissionGrant> = {},
): Promise<{ result: ProviderSubmissionResult; timer: VirtualTimer }> {
  const timer = new VirtualTimer();
  const { executor, admit } = rig(timer, { submissionTimeoutMs: timeoutMs });
  let settled: ProviderSubmissionResult | undefined;
  void executor.execute(admit(grant), submission(), behavior).then((s) => (settled = s.result));
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
    const scenario: ProviderAdapter = adapter.forBehavior('SUCCESS');
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
    const noBehaviour = (await run(undefined)).result;
    expect(noBehaviour.outcome === 'rejected' && noBehaviour.failure.category).toBe(
      'CONFIGURATION_ERROR',
    );
    const unknown = (await run('DELIVERY_DELAY' as SimulatorBehavior)).result;
    expect(unknown.outcome === 'rejected' && unknown.failure.category).toBe('CONFIGURATION_ERROR');
    const foreign = (await run('SUCCESS', undefined, { channel: 'fax' as never })).result;
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
  const executeWith = async (submit: Submit) => {
    const { executor, admit } = rig(new VirtualTimer(), {
      adapters: [new FakeAdapter({ submit })],
    });
    return (await executor.execute(admit(), submission())).result;
  };

  it('an adapter that throws becomes rejected / UNKNOWN, not an error and never a success', async () => {
    const result = await executeWith(() =>
      Promise.reject(new Error('boom: secret-looking detail')),
    );
    expect(result).toMatchObject({
      outcome: 'rejected',
      failure: { category: 'UNKNOWN', retryable: false, providerCode: null },
    });
    expect(JSON.stringify(result)).not.toContain('secret-looking detail');
  });

  it('a result outside the contract becomes rejected / UNKNOWN', async () => {
    for (const bogus of [
      { outcome: 'delivered' },
      { outcome: 'accepted' }, // no providerMessageId
      { outcome: 'rejected', failure: { category: 'VENDOR_SPECIFIC_E42' } },
      null,
    ]) {
      const result = await executeWith(() => Promise.resolve(bogus as never));
      expect(result.outcome === 'rejected' && result.failure.category).toBe('UNKNOWN');
    }
  });

  it('retryability and identifiers are the executor’s, not the adapter’s', async () => {
    const result = await executeWith(() =>
      Promise.resolve({
        outcome: 'rejected',
        submissionId: 'forged',
        correlationId: 'forged',
        failure: { category: 'AUTH_ERROR', retryable: true, providerCode: 'X', message: 'm' },
        latencyMs: 999,
      }),
    );
    expect(result).toMatchObject({
      submissionId: submission().submissionId,
      correlationId: submission().correlationId,
      failure: { category: 'AUTH_ERROR', retryable: false },
      latencyMs: 0,
    });
  });

  it('the settled result is frozen: what will be recorded cannot be changed afterwards', async () => {
    const { executor, admit } = rig();
    const settled = await executor.execute(admit(), submission(), '500');
    expect(Object.isFrozen(settled)).toBe(true);
    expect(Object.isFrozen(settled.result)).toBe(true);
    expect(() => {
      (settled.result as { outcome: string }).outcome = 'accepted';
    }).toThrow(TypeError);
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
    const extra = new FakeAdapter({ adapterKey: 'acme_sms' });
    expect(() => new ProviderAdapterRegistry([simulator(), extra])).toThrow(
      'do not match PROVIDER_ADAPTER_KEYS',
    );
  });

  it('an adapter that is not a GuardedProviderAdapter is refused: a plain object, a spread copy, an Object.create clone', () => {
    const genuine = simulator();
    const clone = Object.freeze(Object.create(SimulatorAdapter.prototype) as object);
    for (const fake of [
      { adapterKey: 'simulator', send: async () => ({}) },
      Object.freeze({ ...genuine, send: genuine.send }),
      clone,
    ]) {
      expect(() => new ProviderAdapterRegistry([fake as never])).toThrow(
        'is not a GuardedProviderAdapter',
      );
    }
    expect(() => new ProviderAdapterRegistry([{ adapterKey: 'simulator' } as never])).toThrow(
      ProviderAdapterRefused,
    );
  });

  it('a subclass that overrides send() is refused at construction; one that replaces it on the instance is refused by the registry', () => {
    class Overriding extends SimulatorAdapter {
      override async send(): Promise<ProviderSubmissionResult> {
        return acceptAll(context(), submission(), { timeoutMs: 1 });
      }
    }
    expect(() => new Overriding(new VirtualTimer())).toThrow('it overrides send()');

    // The inherited `send` is read-only (the base prototype is frozen), so an
    // instance can only shadow it by defining its own property before freezing.
    class Shadowing extends GuardedProviderAdapter {
      readonly adapterKey = 'simulator';
      constructor(replace: boolean) {
        super();
        if (replace) Object.defineProperty(this, 'send', { value: acceptAll });
        Object.freeze(this);
      }
      capabilities() {
        return { channels: ['sms'] as ChannelCode[] };
      }
      async healthCheck() {
        return { healthy: true, latencyMs: 0 };
      }
      protected submit = acceptAll;
      estimateCost(): Promise<never> {
        return Promise.reject(new Error('n/a'));
      }
      checkStatus(): Promise<never> {
        return Promise.reject(new Error('n/a'));
      }
      parseWebhook(): Promise<never> {
        return Promise.reject(new Error('n/a'));
      }
    }
    expect(() => new ProviderAdapterRegistry([new Shadowing(true)])).toThrow('it overrides send()');
    expect(() => new ProviderAdapterRegistry([new Shadowing(false)])).not.toThrow();
  });

  it('an adapter that is not frozen is refused', () => {
    class Thawed extends GuardedProviderAdapter {
      readonly adapterKey = 'simulator';
      constructor() {
        super();
      }
      capabilities() {
        return { channels: ['sms'] as ChannelCode[] };
      }
      async healthCheck() {
        return { healthy: true, latencyMs: 0 };
      }
      protected submit = acceptAll;
      estimateCost(): Promise<never> {
        return Promise.reject(new Error('n/a'));
      }
      checkStatus(): Promise<never> {
        return Promise.reject(new Error('n/a'));
      }
      parseWebhook(): Promise<never> {
        return Promise.reject(new Error('n/a'));
      }
    }
    expect(() => new ProviderAdapterRegistry([new Thawed()])).toThrow('it is not frozen');
    expect(Object.isFrozen(new SimulatorAdapter(new VirtualTimer()))).toBe(true);
    expect(Object.isFrozen(new SimulatorAdapter(new VirtualTimer()).forBehavior('SUCCESS'))).toBe(
      true,
    );
  });

  it('the guard itself cannot be replaced: the base prototype and class are frozen', () => {
    expect(Object.isFrozen(GuardedProviderAdapter.prototype)).toBe(true);
    expect(() => {
      (GuardedProviderAdapter.prototype as { send: unknown }).send = acceptAll;
    }).toThrow(TypeError);
  });
});

describe('health check — simulator behaviours and the executor probe (Phase 2.3)', () => {
  /** Runs one health check through the executor, driving the virtual clock until it settles. */
  async function probe(
    variant?: SimulatorHealthBehavior,
    adapters?: GuardedProviderAdapter[],
  ): Promise<{ result: { outcome: string; latencyMs: number }; timer: VirtualTimer }> {
    const timer = new VirtualTimer();
    const { executor } = rig(timer, { adapters });
    let settled: { outcome: string; latencyMs: number } | undefined;
    void executor.probe(context(), variant).then((r) => (settled = r));
    await timer.advance(PROVIDER_HEALTH_DEFAULTS.PROBE_TIMEOUT_MS + 1000);
    return { result: settled!, timer };
  }

  it('HEALTHY and UNHEALTHY answer at once and deterministically, run after run', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await probe('HEALTHY')).result).toEqual({ outcome: 'healthy', latencyMs: 0 });
      expect((await probe('UNHEALTHY')).result).toEqual({ outcome: 'unhealthy', latencyMs: 0 });
    }
  });

  it('TIMEOUT never answers: the executor reports timeout at exactly the probe timeout, and leaves no waiter behind', async () => {
    const timer = new VirtualTimer();
    const { executor } = rig(timer);
    let settled: { outcome: string; latencyMs: number } | undefined;
    void executor.probe(context(), 'TIMEOUT').then((r) => (settled = r));
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
    expect((await probe('BOGUS' as never)).result.outcome).toBe('unhealthy');
    const adapter = (health: FakeAdapter['healthCheck']) => [new FakeAdapter({ health })];
    expect(
      (
        await probe(
          undefined,
          adapter(() => Promise.reject(new Error('boom'))),
        )
      ).result.outcome,
    ).toBe('unhealthy');
    expect(
      (
        await probe(
          undefined,
          adapter(async () => ({ healthy: 'yes', latencyMs: 0 }) as never),
        )
      ).result.outcome,
    ).toBe('unhealthy');
    expect(
      (
        await probe(
          undefined,
          adapter(async () => null as never),
        )
      ).result.outcome,
    ).toBe('unhealthy');
  });

  it('a health view never sends: without a permit its send() is refused, and the provider is never reached', async () => {
    const reached = simulated();
    const view = new SimulatorAdapter(new VirtualTimer()).forHealthBehavior('HEALTHY');
    await expect(
      view.send(context(), submission(), { timeoutMs: 10 } as never),
    ).rejects.toBeInstanceOf(CircuitAdmissionRequired);
    expect(reached).not.toHaveBeenCalled();
  });

  it('the probe resolves the adapter from the binding, takes no adapter or timeout, and a behaviour only for the simulator', async () => {
    const health = jest.fn(
      async (_c: ProviderAdapterContext, options?: ProviderHealthCheckOptions) => ({
        healthy: options?.timeoutMs === PROVIDER_HEALTH_DEFAULTS.PROBE_TIMEOUT_MS,
        latencyMs: 0,
      }),
    );
    const { executor } = rig(new VirtualTimer(), { adapters: [new FakeAdapter({ health })] });
    await expect(executor.probe(context())).resolves.toMatchObject({ outcome: 'healthy' });
    expect(health).toHaveBeenCalledTimes(1);
    await expect(executor.probe(context({ adapterKey: 'acme_sms' }))).rejects.toBeInstanceOf(
      ProviderAdapterNotRegistered,
    );
    await expect(executor.probe(context(), 'HEALTHY')).rejects.toBeInstanceOf(
      ProviderAdapterVariantRefused,
    );
    const legacy = executor.probe as unknown as (...args: unknown[]) => Promise<unknown>;
    await expect(legacy.call(executor, new FakeAdapter(), context(), 1)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(health).toHaveBeenCalledTimes(1);
  });
});

describe('circuit admission is mandatory before any provider call (Gate D.3, PROVIDER_ADAPTER.md §6h)', () => {
  const recording = () => {
    const submit = jest.fn(acceptAll);
    return { adapters: [new FakeAdapter({ submit })], submit };
  };

  it('a genuine admission is redeemed once, and the adapter is called with the context and timeout of the admission', async () => {
    const { adapters, submit } = recording();
    const { executor, admit } = rig(new VirtualTimer(), { adapters, submissionTimeoutMs: 1234 });
    const settled = await executor.execute(
      admit({ capabilities: { region: { name: 'in' } }, channel: 'sms' }),
      submission(),
    );
    expect(settled.result.outcome).toBe('accepted');
    expect(submit).toHaveBeenCalledTimes(1);
    const [ctx, , options] = submit.mock.calls[0]!;
    expect(ctx).toEqual({
      providerId: PROVIDER,
      adapterKey: 'simulator',
      channel: 'sms',
      capabilities: { region: { name: 'in' } },
    });
    // Deep-frozen: an adapter cannot change what the next reader of the admission sees.
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen((ctx.capabilities as { region: object }).region)).toBe(true);
    expect(options.timeoutMs).toBe(1234);
    expect(options).not.toHaveProperty('permit');
  });

  it('no admission, a routing-eligibility verdict, or a forged copy of an admission: refused, the adapter never called', async () => {
    const { adapters, submit } = recording();
    const { executor, admit } = rig(new VirtualTimer(), { adapters });
    const genuine = admit();
    for (const fake of [
      undefined,
      null,
      {},
      { verdict: 'eligible' },
      { verdict: 'probe_only', probeSlotsFree: 1 },
      { ...genuine },
      JSON.parse(JSON.stringify(genuine)),
      structuredClone(genuine),
      Object.freeze({ providerId: PROVIDER, generation: 0, probeId: null }),
      Object.freeze(Object.create(CircuitAdmission.prototype) as object),
      Object.freeze(Object.create(genuine) as object),
    ]) {
      await expect(
        executor.execute(fake as unknown as CircuitAdmission, submission()),
      ).rejects.toThrow('not an admission issued by the circuit');
    }
    expect(submit).not.toHaveBeenCalled();
    // The genuine one was never consumed by any of that.
    await executor.execute(genuine, submission());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('an admission is single-use, and issued by this ledger only', async () => {
    const { adapters, submit } = recording();
    const { executor, admit } = rig(new VirtualTimer(), { adapters });
    const other = rig(new VirtualTimer());
    const once = admit();
    await executor.execute(once, submission());
    await expect(executor.execute(once, submission())).rejects.toThrow('admission already used');
    // Issued by another ledger (another process, in effect): not redeemable here.
    await expect(executor.execute(other.admit(), submission())).rejects.toThrow(
      'admission was issued by another ledger',
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('an admission must be redeemed immediately: at exactly MAX_AGE_MS it is accepted, one millisecond later it is refused and void', async () => {
    const timer = new VirtualTimer();
    const { adapters, submit } = recording();
    const { executor, admit } = rig(timer, { adapters });
    const fresh = admit();
    const stale = admit();
    await timer.advance(CircuitAdmissions.MAX_AGE_MS);
    await executor.execute(fresh, submission());
    await timer.advance(1);
    await expect(executor.execute(stale, submission())).rejects.toThrow('admission expired');
    await expect(executor.execute(stale, submission())).rejects.toThrow('admission already used');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('the executor takes no adapter, context or timeout: extra arguments are refused before the admission is touched', async () => {
    const { adapters, submit } = recording();
    const { executor, admit } = rig(new VirtualTimer(), { adapters });
    const rogue = new FakeAdapter();
    const genuine = admit();
    const legacy = executor.execute as unknown as (...args: unknown[]) => Promise<unknown>;
    for (const extra of [
      [rogue, context(), submission(), 1],
      [submission(), undefined, 1],
      [submission(), undefined, context({ providerId: 'other' })],
    ]) {
      await expect(legacy.call(executor, genuine, ...extra)).rejects.toBeInstanceOf(TypeError);
    }
    expect(submit).not.toHaveBeenCalled();
    await executor.execute(genuine, submission());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("the submission timeout is the admission's, not a constant and not the caller's", async () => {
    const timer = new VirtualTimer();
    const { executor, admit } = rig(timer, { submissionTimeoutMs: 1000 });
    let settled: ProviderSubmissionResult | undefined;
    void executor.execute(admit(), submission(), 'TIMEOUT').then((s) => (settled = s.result));
    await timer.advance(999);
    expect(settled).toBeUndefined();
    await timer.advance(1);
    expect(settled).toMatchObject({ outcome: 'rejected', latencyMs: 1000 });
    expect(timer.pending).toBe(0);
  });

  it('a behaviour is refused for an adapter that is not the simulator: nothing is sent, and the admission is void', async () => {
    const { adapters, submit } = recording();
    const { executor, admit } = rig(new VirtualTimer(), { adapters });
    const admission = admit();
    await expect(executor.execute(admission, submission(), 'SUCCESS')).rejects.toBeInstanceOf(
      ProviderAdapterVariantRefused,
    );
    await expect(executor.execute(admission, submission())).rejects.toThrow(
      'admission already used',
    );
    expect(submit).not.toHaveBeenCalled();
    expect(executor.isSimulator('simulator')).toBe(false);
    expect(rig().executor.isSimulator('simulator')).toBe(true);
    expect(() => executor.isSimulator('acme_sms')).toThrow(ProviderAdapterNotRegistered);
  });

  it('an admission for an unregistered adapter key fails closed, and is void', async () => {
    const reached = simulated();
    const { executor, admit } = rig();
    const admission = admit({ adapterKey: 'acme_sms' });
    await expect(executor.execute(admission, submission(), 'SUCCESS')).rejects.toBeInstanceOf(
      ProviderAdapterNotRegistered,
    );
    await expect(executor.execute(admission, submission(), 'SUCCESS')).rejects.toThrow(
      'admission already used',
    );
    expect(reached).not.toHaveBeenCalled();
  });

  it('a simulator view that is not guarded is refused before the call', async () => {
    class Leaky extends SimulatorAdapter {
      override forBehavior(): SimulatorAdapter {
        return Object.create(SimulatorAdapter.prototype) as SimulatorAdapter;
      }
    }
    const timer = new VirtualTimer();
    const reached = simulated();
    const { executor, admit } = rig(timer, { adapters: [new Leaky(timer)] });
    await expect(executor.execute(admit(), submission(), 'SUCCESS')).rejects.toBeInstanceOf(
      ProviderAdapterRefused,
    );
    expect(reached).not.toHaveBeenCalled();
  });

  it('a health-check probe is a diagnostic, not a submission, and needs no admission', async () => {
    const { executor } = rig(new VirtualTimer(), { adapters: recording().adapters });
    await expect(executor.probe(context())).resolves.toMatchObject({ outcome: 'healthy' });
  });

  it('the executor exposes no adapter: its public surface is execute, probe and the registered keys', () => {
    const { executor } = rig();
    expect(Object.getOwnPropertyNames(ProviderSubmissionExecutor.prototype).sort()).toEqual([
      'adapterKeys',
      'constructor',
      'execute',
      'isSimulator',
      'probe',
    ]);
    expect(Object.keys(executor)).toEqual([]);
    expect(executor.adapterKeys()).toEqual([...PROVIDER_ADAPTER_KEYS]);
  });
});

describe('a raw adapter send() is refused without a redeemed permit (ADR-015 R-13)', () => {
  it('no permit, a forged permit, an admission in place of a permit: refused, the provider never reached', async () => {
    const reached = simulated();
    const timer = new VirtualTimer();
    const { admit } = rig(timer);
    const adapter = new SimulatorAdapter(timer).forBehavior('SUCCESS');
    for (const permit of [
      undefined,
      null,
      {},
      admit(),
      JSON.parse(JSON.stringify({ permit: true })),
      Object.freeze(Object.create(null) as object),
    ]) {
      await expect(
        adapter.send(context(), submission(), {
          timeoutMs: 10,
          permit: permit as unknown as SubmissionPermit,
        }),
      ).rejects.toThrow('no submission permit');
    }
    await expect(adapter.send(context(), submission(), undefined as never)).rejects.toThrow(
      CircuitAdmissionRequired,
    );
    expect(reached).not.toHaveBeenCalled();
  });
});
