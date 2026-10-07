import type {
  ChannelCode,
  ProviderAdapterContext,
  ProviderSubmission,
  ProviderSubmissionResult,
  SubmissionPermit,
} from '@acc/contracts';

import { ProviderStateStore } from '../providers/provider-state.store';
import {
  CircuitAdmissionRequired,
  CircuitAdmissions,
  GuardedProviderAdapter,
  type AdapterSubmitOptions,
  type AdmissionGrant,
  type SettledSubmission,
} from './circuit-admission';
import { SimulatorAdapter } from './simulator.adapter';
import { ProviderSubmissionExecutor } from './submission-executor';
import type { SubmissionTimer } from './submission-timer';

/**
 * ADR-015 R-13 — the admission ledger, the permit an adapter consumes and the
 * settled capability recording takes, exercised directly: each capability is
 * minted by one claim, bound to one adapter instance, provider and
 * submission, and usable once.
 */
class FixedTimer implements SubmissionTimer {
  time = 0;
  now() {
    return this.time;
  }
  sleep(): Promise<void> {
    return new Promise(() => undefined);
  }
}

const A = '01900000-0000-7000-8000-00000000000a';
const B = '01900000-0000-7000-8000-00000000000b';

const grant = (overrides: Partial<AdmissionGrant> = {}): AdmissionGrant => ({
  providerId: A,
  adapterKey: 'simulator',
  channel: 'sms',
  capabilities: { limits: { perSecond: 5 } },
  ticket: { generation: 3, probeId: 'slot-1' },
  circuitPolicyVersion: 7,
  ...overrides,
});

const submission = (submissionId = 's-1'): ProviderSubmission => ({
  submissionId,
  correlationId: 'c-1',
  channel: 'sms',
  recipient: 'simulator:test-recipient',
  content: { text: 'synthetic' },
});

const contextOf = (providerId: string): ProviderAdapterContext => ({
  providerId,
  adapterKey: 'simulator',
  channel: 'sms',
  capabilities: {},
});

/** A guarded adapter that records what reached the provider. */
class Recorder extends GuardedProviderAdapter {
  readonly adapterKey = 'simulator';
  readonly calls: { context: ProviderAdapterContext; options: AdapterSubmitOptions }[] = [];
  constructor() {
    super();
    Object.freeze(this);
  }
  capabilities() {
    return { channels: ['sms'] as ChannelCode[] };
  }
  async healthCheck() {
    return { healthy: true, latencyMs: 0 };
  }
  protected async submit(
    context: ProviderAdapterContext,
    sub: ProviderSubmission,
    options: AdapterSubmitOptions,
  ): Promise<ProviderSubmissionResult> {
    this.calls.push({ context, options });
    return {
      outcome: 'accepted',
      submissionId: sub.submissionId,
      correlationId: sub.correlationId,
      providerMessageId: 'p',
      latencyMs: 0,
    };
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

/** A ledger whose issuer and redeemer this test holds — standing in for the store and the executor. */
function ledger(timer = new FixedTimer()) {
  const l = new CircuitAdmissions(timer);
  return { ledger: l, timer, issuer: l.claimIssuer(), redeemer: l.claimRedeemer() };
}

/** Admits, redeems and authorizes one submission for `target`. */
function permitted(
  l: ReturnType<typeof ledger>,
  target: GuardedProviderAdapter,
  g: Partial<AdmissionGrant> = {},
) {
  const admission = l.issuer.issue(grant(g));
  const redemption = l.redeemer.redeem(admission, submission());
  const permit = l.redeemer.authorize(redemption, target);
  return { admission, redemption, permit };
}

const accepted = (sub = submission()): ProviderSubmissionResult => ({
  outcome: 'accepted',
  submissionId: sub.submissionId,
  correlationId: sub.correlationId,
  providerMessageId: 'p',
  latencyMs: 0,
});

describe('the ledger: one issuer, one redeemer (ADR-015 R-13)', () => {
  it('a second claimIssuer() on a ledger throws — a second issuer fails at boot', () => {
    const l = new CircuitAdmissions(new FixedTimer());
    l.claimIssuer();
    expect(() => l.claimIssuer()).toThrow('the issuer is already claimed');
  });

  it('a second claimRedeemer() on a ledger throws — a second executor on the same ledger fails at construction', () => {
    const timer = new FixedTimer();
    const l = new CircuitAdmissions(timer);
    new ProviderSubmissionExecutor(timer, l, [new SimulatorAdapter(timer)]);
    expect(() => l.claimRedeemer()).toThrow('the redeemer is already claimed');
    expect(() => new ProviderSubmissionExecutor(timer, l, [new SimulatorAdapter(timer)])).toThrow(
      'the redeemer is already claimed',
    );
  });

  it('ProviderStateStore claims the issuer when it is built, so nothing else can issue — nor a second store', () => {
    const l = new CircuitAdmissions(new FixedTimer());
    const clock = { now: () => new Date(0) };
    new ProviderStateStore({} as never, l, clock);
    expect(() => l.claimIssuer()).toThrow('the issuer is already claimed');
    expect(() => new ProviderStateStore({} as never, l, clock)).toThrow(
      'the issuer is already claimed',
    );
  });

  it('the ledger itself is frozen: its claims cannot be replaced', () => {
    const l = new CircuitAdmissions(new FixedTimer());
    expect(Object.isFrozen(l)).toBe(true);
    expect(() => {
      (l as unknown as { claimIssuer: unknown }).claimIssuer = () => ({});
    }).toThrow(TypeError);
  });

  it('a ledger refuses a submission timeout that is not a positive finite number', () => {
    for (const submissionTimeoutMs of [0, -1, Infinity, Number.NaN]) {
      expect(() => new CircuitAdmissions(new FixedTimer(), { submissionTimeoutMs })).toThrow(
        'invalid submission timeout',
      );
    }
  });

  it('an admission copies and deep-freezes what was admitted: changing the grant afterwards changes nothing', async () => {
    const l = ledger();
    const source = grant();
    const admission = l.issuer.issue(source);
    (source.capabilities.limits as { perSecond: number }).perSecond = 999;
    (source.ticket as { probeId: string }).probeId = 'stolen';
    const redemption = l.redeemer.redeem(admission, submission());
    expect(redemption.context.capabilities).toEqual({ limits: { perSecond: 5 } });
    expect(Object.isFrozen(redemption.context.capabilities.limits)).toBe(true);
    expect(admission.probeId).toBe('slot-1');
    expect(Object.isFrozen(admission)).toBe(true);
  });
});

describe('the permit: bound to one adapter instance, one provider, one submission, used once', () => {
  it('a genuine permit reaches the provider once, with the context and timeout of the admission', async () => {
    const l = ledger();
    const adapter = new Recorder();
    const { permit } = permitted(l, adapter);
    // The caller's context and timeout are not what the provider receives.
    await expect(
      adapter.send({ ...contextOf(A), capabilities: { forged: true } }, submission(), {
        timeoutMs: 1,
        permit,
      }),
    ).resolves.toMatchObject({ outcome: 'accepted' });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.context.capabilities).toEqual({ limits: { perSecond: 5 } });
    expect(adapter.calls[0]!.options.timeoutMs).toBe(3000);
    // Replayed: refused, nothing more sent.
    await expect(
      adapter.send(contextOf(A), submission(), { timeoutMs: 1, permit }),
    ).rejects.toThrow('permit already used');
    expect(adapter.calls).toHaveLength(1);
  });

  it('a permit minted for adapter X is refused by adapter Y — even another instance of the same class', async () => {
    const l = ledger();
    const x = new Recorder();
    const y = new Recorder();
    const { permit } = permitted(l, x);
    await expect(y.send(contextOf(A), submission(), { timeoutMs: 1, permit })).rejects.toThrow(
      'permit was issued for another adapter',
    );
    expect(y.calls).toHaveLength(0);
    // Refusing did not spend it: X still accepts it.
    await x.send(contextOf(A), submission(), { timeoutMs: 1, permit });
    expect(x.calls).toHaveLength(1);
  });

  it('a permit for provider A is refused when presented for provider B (cross-provider)', async () => {
    const l = ledger();
    const adapter = new Recorder();
    const { permit } = permitted(l, adapter);
    await expect(
      adapter.send(contextOf(B), submission(), { timeoutMs: 1, permit }),
    ).rejects.toThrow('permit was issued for another provider');
    expect(adapter.calls).toHaveLength(0);
  });

  it('a permit for one submission is refused for another', async () => {
    const l = ledger();
    const adapter = new Recorder();
    const { permit } = permitted(l, adapter);
    await expect(
      adapter.send(contextOf(A), submission('s-other'), { timeoutMs: 1, permit }),
    ).rejects.toThrow('permit was issued for another submission');
    expect(adapter.calls).toHaveLength(0);
  });

  it('an admission, a redemption, a cast or a clone of a permit is not a permit', async () => {
    const l = ledger();
    const adapter = new Recorder();
    const { admission, redemption, permit } = permitted(l, adapter);
    for (const fake of [
      admission,
      redemption,
      { ...(permit as object) },
      structuredClone(permit),
      Object.freeze(Object.create(permit as object) as object),
    ]) {
      await expect(
        adapter.send(contextOf(A), submission(), {
          timeoutMs: 1,
          permit: fake as unknown as SubmissionPermit,
        }),
      ).rejects.toThrow('no submission permit');
    }
    expect(adapter.calls).toHaveLength(0);
  });

  it('a redemption is authorized for one adapter only: a second authorization is refused', () => {
    const l = ledger();
    const admission = l.issuer.issue(grant());
    const redemption = l.redeemer.redeem(admission, submission());
    l.redeemer.authorize(redemption, new Recorder());
    expect(() => l.redeemer.authorize(redemption, new Recorder())).toThrow(
      'admission is not awaiting its provider call',
    );
  });

  it("another ledger's redeemer cannot act on this ledger's redemption", () => {
    const one = ledger();
    const two = ledger();
    const redemption = one.redeemer.redeem(one.issuer.issue(grant()), submission());
    expect(() => two.redeemer.authorize(redemption, new Recorder())).toThrow(
      'not a redemption of this ledger',
    );
    expect(() => two.redeemer.settle(redemption, accepted())).toThrow(
      'not a redemption of this ledger',
    );
  });
});

describe('settling and recording: the result comes from the ledger, once', () => {
  async function settledOn(l: ReturnType<typeof ledger>) {
    const adapter = new Recorder();
    const { admission, redemption, permit } = permitted(l, adapter);
    const result = await adapter.send(contextOf(A), submission(), { timeoutMs: 1, permit });
    return { admission, settled: l.redeemer.settle(redemption, result) };
  }

  it('nothing settles without a provider call: a redeemed admission whose adapter was never invoked cannot be settled', () => {
    const l = ledger();
    const redemption = l.redeemer.redeem(l.issuer.issue(grant()), submission());
    expect(() => l.redeemer.settle(redemption, accepted())).toThrow(
      'no provider call was made under this admission',
    );
    l.redeemer.authorize(redemption, new Recorder());
    expect(() => l.redeemer.settle(redemption, accepted())).toThrow(
      'no provider call was made under this admission',
    );
  });

  it('takeForRecording returns provider, ticket and result from the ledger, and only once', async () => {
    const l = ledger();
    const { settled } = await settledOn(l);
    expect(l.issuer.takeForRecording(settled)).toEqual({
      providerId: A,
      ticket: { generation: 3, probeId: 'slot-1' },
      result: accepted(),
      circuitPolicyVersion: 7,
    });
    expect(() => l.issuer.takeForRecording(settled)).toThrow('settled submission already recorded');
  });

  it('a plain ticket, a forged handle, or the admission itself — even after its call settled — is not recordable', async () => {
    const l = ledger();
    const { admission, settled } = await settledOn(l);
    for (const fake of [
      { generation: 3, probeId: 'slot-1' },
      { providerId: A, ticket: { generation: 3, probeId: null }, result: accepted() },
      { ...settled },
      JSON.parse(JSON.stringify(settled)),
      Object.freeze(Object.create(settled) as object),
      admission,
    ]) {
      expect(() => l.issuer.takeForRecording(fake as unknown as SettledSubmission)).toThrow(
        'not a settled submission',
      );
    }
    // None of that consumed the genuine one.
    expect(l.issuer.takeForRecording(settled).providerId).toBe(A);
  });

  it("another ledger's settled submission is refused", async () => {
    const one = ledger();
    const two = ledger();
    const { settled } = await settledOn(one);
    expect(() => two.issuer.takeForRecording(settled)).toThrow(
      'settled submission belongs to another ledger',
    );
  });

  it('ProviderStateStore.recordSubmission refuses a plain ticket or a forged handle before it touches the transaction', async () => {
    const l = new CircuitAdmissions(new FixedTimer());
    const store = new ProviderStateStore({} as never, l, { now: () => new Date(0) });
    const touched: PropertyKey[] = [];
    const tx = new Proxy(
      {},
      {
        get: (_t, key) => {
          touched.push(key);
          throw new Error('the transaction was touched');
        },
      },
    );
    for (const fake of [
      { generation: 0, probeId: null },
      { providerId: A, ticket: { generation: 0, probeId: null }, result: accepted() },
    ]) {
      await expect(
        store.recordSubmission(tx as never, {} as never, fake as unknown as SettledSubmission),
      ).rejects.toBeInstanceOf(CircuitAdmissionRequired);
    }
    expect(touched).toEqual([]);
  });
});
