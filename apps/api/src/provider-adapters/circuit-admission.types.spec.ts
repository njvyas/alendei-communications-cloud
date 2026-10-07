import type {
  ProviderAdapterContext,
  ProviderSubmission,
  ProviderSubmissionResult,
  SubmissionPermit,
} from '@acc/contracts';

import { ProviderRegistryService } from '../providers/provider-registry.service';
import { ProviderStateStore } from '../providers/provider-state.store';
import {
  CircuitAdmission,
  CircuitAdmissions,
  GuardedProviderAdapter,
  SettledSubmission,
} from './circuit-admission';
import { SimulatorAdapter } from './simulator.adapter';
import { ProviderSubmissionExecutor } from './submission-executor';
import type { SubmissionTimer } from './submission-timer';

/**
 * ADR-015 R-13 — compile-time fixtures. Each `@ts-expect-error` below is
 * checked by `npm run typecheck` (this file is under `src/`, which the API
 * project compiles; Jest's ts-jest is transpile-only and checks none of
 * them): if one of these lines ever type-checks, the directive is unused and
 * the typecheck fails (TS2578). The types guide developers; they are not the
 * enforcement — so the test below also runs every fixture and asserts the
 * runtime refuses it, except the one documented residual: a cast reaches the
 * protected `submit()` at runtime (`PROVIDER_ADAPTER.md` §6h, residual
 * limits), which only the import-boundary test and review catch.
 */
const RESIDUAL = new Set(['submit() is protected']);
const timer: SubmissionTimer = { now: () => 0, sleep: () => new Promise(() => undefined) };
const ctx: ProviderAdapterContext = {
  providerId: 'p',
  adapterKey: 'simulator',
  channel: 'sms',
  capabilities: {},
};
const sub: ProviderSubmission = {
  submissionId: 's',
  correlationId: 'c',
  channel: 'sms',
  recipient: 'simulator:test-recipient',
  content: { text: 't' },
};
const result: ProviderSubmissionResult = {
  outcome: 'accepted',
  submissionId: 's',
  correlationId: 'c',
  providerMessageId: 'm',
  latencyMs: 0,
};

function rig() {
  const ledger = new CircuitAdmissions(timer);
  const executor = new ProviderSubmissionExecutor(timer, ledger, [new SimulatorAdapter(timer)]);
  const store = new ProviderStateStore({} as never, ledger, { now: () => new Date(0) });
  return { ledger, executor, store, adapter: new SimulatorAdapter(timer).forBehavior('SUCCESS') };
}

const FIXTURES: Record<string, () => unknown> = {
  'a permit cannot be written as a literal': () => {
    const { adapter } = rig();
    // @ts-expect-error — `SubmissionPermit` has an unnameable brand.
    const permit: SubmissionPermit = {};
    return adapter.send(ctx, sub, { timeoutMs: 1, permit });
  },
  'send() requires a permit': () => {
    const { adapter } = rig();
    // @ts-expect-error — `permit` is required.
    return adapter.send(ctx, sub, { timeoutMs: 1 });
  },
  'submit() is protected': () => {
    const { adapter } = rig();
    // @ts-expect-error — only the guarded base calls `submit`.
    return adapter.submit(ctx, sub, { timeoutMs: 1 });
  },
  'an admission cannot be constructed': () =>
    // @ts-expect-error — private constructor.
    new CircuitAdmission({}),
  'an admission cannot be written as a literal': () => {
    const { executor } = rig();
    // @ts-expect-error — the ES private slot `#record` cannot be written.
    const admission: CircuitAdmission = {
      providerId: 'p',
      adapterKey: 'simulator',
      channel: 'sms',
      generation: 0,
      probeId: null,
    };
    return executor.execute(admission, sub);
  },
  'a settled submission cannot be constructed': () =>
    // @ts-expect-error — private constructor.
    new SettledSubmission({}),
  'a ledger has no public issue()': () => {
    const { ledger } = rig();
    // @ts-expect-error — issuing goes through the one claimed issuer.
    return ledger.issue('p', { generation: 0, probeId: null });
  },
  'execute() takes no adapter, context or timeout': () => {
    const { executor, adapter } = rig();
    const admission = {} as CircuitAdmission;
    // @ts-expect-error — the Phase 2.2 signature is gone.
    return executor.execute(admission, adapter, ctx, sub, 3000);
  },
  'execute() takes no timeout after the behaviour': () => {
    const { executor } = rig();
    // @ts-expect-error — the rest parameter is `never[]`.
    return executor.execute({} as CircuitAdmission, sub, 'SUCCESS', 3000);
  },
  'probe() takes no adapter or timeout': () => {
    const { executor, adapter } = rig();
    // @ts-expect-error — the probe resolves the adapter itself.
    return executor.probe(adapter, ctx, 3000);
  },
  'recordSubmission() takes no plain ticket': () => {
    const { store } = rig();
    // @ts-expect-error — only a `SettledSubmission`.
    return store.recordSubmission({} as never, {} as never, { generation: 0, probeId: null });
  },
  'recordSubmission() takes no caller result': () => {
    const { store } = rig();
    const ticket = { generation: 0, probeId: null };
    // @ts-expect-error — the Phase 2.3 signature is gone.
    return store.recordSubmission({} as never, {} as never, 'p', ticket, result);
  },
  'the registry service hands out no adapter': () =>
    // @ts-expect-error — `simulatorFor()` was replaced by `assertSimulatorProvider()`.
    ProviderRegistryService.prototype.simulatorFor,
  'an adapter cannot be a plain object': () => {
    // @ts-expect-error — the registry takes `GuardedProviderAdapter`s only.
    const adapters: GuardedProviderAdapter[] = [{ adapterKey: 'simulator', send: () => result }];
    return new ProviderSubmissionExecutor(timer, new CircuitAdmissions(timer), adapters);
  },
};

describe('R-13 compile-time fixtures (checked by `npm run typecheck`) — and the runtime refuses each', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(name, async () => {
      let outcome: unknown;
      try {
        outcome = await fixture();
      } catch (error) {
        outcome = error;
      }
      if (RESIDUAL.has(name)) {
        // The documented limit, pinned so it is never mistaken for enforcement.
        expect(outcome).toMatchObject({ outcome: 'accepted' });
      } else {
        // Refused, or (for a member that no longer exists) absent.
        expect(outcome === undefined || outcome instanceof Error).toBe(true);
      }
    });
  }
});
