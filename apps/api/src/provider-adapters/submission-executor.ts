import { Logger } from '@nestjs/common';
import {
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_HEALTH_DEFAULTS,
  RETRYABLE_FAILURE_CATEGORIES,
  type ProviderAdapterContext,
  type ProviderProbeOutcome,
  type ProviderSubmission,
  type ProviderSubmissionResult,
  type SimulatorBehavior,
  type SimulatorHealthBehavior,
  type SubmissionPermit,
} from '@acc/contracts';

import type { MetricsService } from '../observability/metrics.service';
import { ProviderAdapterRegistry } from './adapter-registry';
import {
  CircuitAdmissionRequired,
  assertGuardedAdapter,
  type AdmissionRedeemer,
  type CircuitAdmission,
  type CircuitAdmissions,
  type GuardedProviderAdapter,
  type Redemption,
  type SettledSubmission,
} from './circuit-admission';
import { SimulatorAdapter } from './simulator.adapter';
import type { SubmissionTimer } from './submission-timer';

/** A behaviour was named for an adapter that takes none (only the simulator does). */
export class ProviderAdapterVariantRefused extends Error {
  constructor(readonly adapterKey: string) {
    super(`Provider adapter "${adapterKey}" takes no simulator behaviour`);
    this.name = 'ProviderAdapterVariantRefused';
  }
}

/**
 * Runs one adapter submission under the platform timeout and normalizes what
 * comes back (Phase 2.2), and is the only holder of the adapters (ADR-015
 * R-13).
 *
 * Everything an adapter can do is reduced to the contract's two outcomes:
 *   - no answer within the admission's timeout → `rejected / TIMEOUT` (the
 *     adapter's wait is aborted, so nothing outlives the request);
 *   - a thrown error → `rejected / UNKNOWN` (logged for the operator; the
 *     caller learns only the category);
 *   - a result outside the taxonomy → `rejected / UNKNOWN`.
 * `retryable` is recomputed from the category — one definition, never an
 * adapter's opinion — and `latencyMs` is measured here, on the injected clock.
 *
 * Built by the module's factory with its adapters; the registry is held in a
 * private field and no method returns an adapter.
 */
const TIMED_OUT: unique symbol = Symbol('timeout');

export class ProviderSubmissionExecutor {
  readonly #logger = new Logger(ProviderSubmissionExecutor.name);
  readonly #timer: SubmissionTimer;
  readonly #redeemer: AdmissionRedeemer;
  readonly #registry: ProviderAdapterRegistry;
  readonly #metrics: MetricsService | undefined;

  constructor(
    timer: SubmissionTimer,
    admissions: CircuitAdmissions,
    adapters: readonly GuardedProviderAdapter[],
    metrics?: MetricsService,
  ) {
    this.#timer = timer;
    this.#redeemer = admissions.claimRedeemer();
    this.#registry = new ProviderAdapterRegistry(adapters);
    this.#metrics = metrics;
  }

  /** The registered adapter keys (for the `422` an unregistered key is answered with). */
  adapterKeys(): readonly string[] {
    return this.#registry.keys();
  }

  /**
   * Whether `adapterKey`'s adapter takes a simulator behaviour, or
   * `ProviderAdapterNotRegistered` when no adapter is registered for it.
   */
  isSimulator(adapterKey: string): boolean {
    return this.#registry.resolve(adapterKey) instanceof SimulatorAdapter;
  }

  /**
   * Runs the submission the circuit admitted and counts it, once, by channel
   * and normalized outcome.
   *
   * **Circuit admission is mandatory** (`PROVIDER_ADAPTER.md` §6h): `admission`
   * must be the one `ProviderStateStore.admit` issued, unused and fresh. It is
   * redeemed before any adapter is touched; anything else — a
   * routing-eligibility verdict, a copy, a reused or expired admission —
   * throws `CircuitAdmissionRequired` and nothing is sent. Provider, adapter,
   * context and timeout all come from the admission; there is no parameter
   * for any of them. `variant` is a simulator behaviour, refused for any other
   * adapter. Returns the settled submission — the only thing
   * `recordSubmission` accepts.
   */
  async execute(
    admission: CircuitAdmission,
    submission: ProviderSubmission,
    variant?: SimulatorBehavior,
    ...unexpected: never[]
  ): Promise<SettledSubmission> {
    if (unexpected.length > 0) {
      throw new TypeError(
        'ProviderSubmissionExecutor.execute takes no adapter, context or timeout: they come from the admission',
      );
    }
    let redemption: Redemption;
    try {
      redemption = this.#redeemer.redeem(admission, submission);
    } catch (error) {
      this.#refused(error, submission);
      throw error;
    }
    let adapter: GuardedProviderAdapter;
    try {
      adapter = this.#target(redemption.adapterKey, variant, (a, v) =>
        a.forBehavior(v as SimulatorBehavior),
      );
    } catch (error) {
      this.#redeemer.void(redemption);
      throw error;
    }
    const permit = this.#redeemer.authorize(redemption, adapter);
    const result = await this.#run(adapter, redemption, submission, permit);
    const settled = this.#redeemer.settle(redemption, result);
    this.#metrics?.providerSubmissions.inc({
      channel: redemption.channel,
      outcome: result.outcome === 'accepted' ? 'accepted' : result.failure.category.toLowerCase(),
    });
    return settled;
  }

  /**
   * Runs one health check under the platform probe timeout (Phase 2.3) and
   * counts it, once, by channel and outcome. No answer in time is `timeout`;
   * a thrown error or an answer outside the contract is `unhealthy` — never
   * `healthy`. A probe is a diagnostic, not a submission: it needs no
   * admission (§5e) and calls only the adapter's `healthCheck`, resolved here
   * from `binding.adapterKey`. `variant` is a simulator health behaviour.
   */
  async probe(
    binding: ProviderAdapterContext,
    variant?: SimulatorHealthBehavior,
    ...unexpected: never[]
  ): Promise<{ outcome: ProviderProbeOutcome; latencyMs: number }> {
    if (unexpected.length > 0) {
      throw new TypeError('ProviderSubmissionExecutor.probe takes no adapter or timeout');
    }
    const adapter = this.#target(binding.adapterKey, variant, (a, v) =>
      a.forHealthBehavior(v as SimulatorHealthBehavior),
    );
    const context: ProviderAdapterContext = Object.freeze({
      providerId: binding.providerId,
      adapterKey: binding.adapterKey,
      channel: binding.channel,
      capabilities: binding.capabilities,
    });
    const timeoutMs = PROVIDER_HEALTH_DEFAULTS.PROBE_TIMEOUT_MS;
    const started = this.#timer.now();
    const abort = new AbortController();
    const timeout = this.#timer
      .sleep(timeoutMs, abort.signal)
      .then((): typeof TIMED_OUT => TIMED_OUT);
    let result: { outcome: ProviderProbeOutcome; latencyMs: number };
    try {
      const raced = await Promise.race([
        adapter.healthCheck(context, { timeoutMs, signal: abort.signal }),
        timeout,
      ]);
      const latencyMs = Math.round(this.#timer.now() - started);
      if (raced === TIMED_OUT) result = { outcome: 'timeout', latencyMs: timeoutMs };
      else if (raced?.healthy === true) result = { outcome: 'healthy', latencyMs };
      else result = { outcome: 'unhealthy', latencyMs };
    } catch (error) {
      this.#logger.error({
        msg: 'provider adapter threw during a health check',
        adapterKey: adapter.adapterKey,
        providerId: context.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
      result = { outcome: 'unhealthy', latencyMs: Math.round(this.#timer.now() - started) };
    } finally {
      abort.abort();
    }
    this.#metrics?.providerHealthChecks.inc({ channel: context.channel, outcome: result.outcome });
    return result;
  }

  /** The registered adapter for `adapterKey`, or its simulator view for `variant`. */
  #target<V>(
    adapterKey: string,
    variant: V | undefined,
    view: (simulator: SimulatorAdapter, variant: V) => GuardedProviderAdapter,
  ): GuardedProviderAdapter {
    const adapter = this.#registry.resolve(adapterKey);
    if (variant === undefined) return adapter;
    if (!(adapter instanceof SimulatorAdapter)) throw new ProviderAdapterVariantRefused(adapterKey);
    const scenario = view(adapter, variant);
    assertGuardedAdapter(scenario);
    return scenario;
  }

  #refused(error: unknown, submission: ProviderSubmission): void {
    if (error instanceof CircuitAdmissionRequired) {
      this.#logger.error({
        msg: 'provider submission refused: no valid circuit admission',
        reason: error.reason,
        submissionId: submission?.submissionId,
        correlationId: submission?.correlationId,
      });
    }
  }

  async #run(
    adapter: GuardedProviderAdapter,
    redemption: Redemption,
    submission: ProviderSubmission,
    permit: SubmissionPermit,
  ): Promise<ProviderSubmissionResult> {
    const { timeoutMs } = redemption;
    const started = this.#timer.now();
    const abort = new AbortController();
    const elapsed = () => Math.round(this.#timer.now() - started);

    const timeout = this.#timer
      .sleep(timeoutMs, abort.signal)
      .then((): typeof TIMED_OUT => TIMED_OUT);
    let raced: ProviderSubmissionResult | typeof TIMED_OUT;
    try {
      raced = await Promise.race([
        adapter.send(redemption.context, submission, { timeoutMs, signal: abort.signal, permit }),
        timeout,
      ]);
    } catch (error) {
      abort.abort();
      if (error instanceof CircuitAdmissionRequired) {
        // The adapter's guard refused the permit: nothing was sent, and
        // nothing will be recorded.
        this.#redeemer.void(redemption);
        this.#refused(error, submission);
        throw error;
      }
      this.#logger.error({
        msg: 'provider adapter threw during a submission',
        adapterKey: adapter.adapterKey,
        providerId: redemption.providerId,
        submissionId: submission.submissionId,
        correlationId: submission.correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return rejected(submission, 'UNKNOWN', 'The adapter failed', elapsed());
    }
    abort.abort();

    if (raced === TIMED_OUT) {
      return rejected(submission, 'TIMEOUT', `No answer within ${timeoutMs} ms`, timeoutMs);
    }
    return normalize(raced, submission, elapsed());
  }
}

function rejected(
  submission: ProviderSubmission,
  category: (typeof PROVIDER_FAILURE_CATEGORIES)[number],
  message: string,
  latencyMs: number,
): ProviderSubmissionResult {
  return {
    outcome: 'rejected',
    submissionId: submission.submissionId,
    correlationId: submission.correlationId,
    failure: {
      category,
      retryable: RETRYABLE_FAILURE_CATEGORIES.includes(category),
      providerCode: null,
      message,
    },
    latencyMs,
  };
}

/** The adapter's result, held to the contract and stamped with this submission's ids and timing. */
function normalize(
  result: ProviderSubmissionResult,
  submission: ProviderSubmission,
  latencyMs: number,
): ProviderSubmissionResult {
  if (
    result?.outcome === 'accepted' &&
    typeof result.providerMessageId === 'string' &&
    result.providerMessageId
  ) {
    return {
      ...result,
      submissionId: submission.submissionId,
      correlationId: submission.correlationId,
      latencyMs,
    };
  }
  if (
    result?.outcome === 'rejected' &&
    (PROVIDER_FAILURE_CATEGORIES as readonly string[]).includes(result.failure?.category)
  ) {
    return {
      outcome: 'rejected',
      submissionId: submission.submissionId,
      correlationId: submission.correlationId,
      failure: {
        category: result.failure.category,
        retryable: RETRYABLE_FAILURE_CATEGORIES.includes(result.failure.category),
        providerCode: result.failure.providerCode ?? null,
        message: result.failure.message,
      },
      latencyMs,
    };
  }
  return rejected(
    submission,
    'UNKNOWN',
    'The adapter returned a result outside the contract',
    latencyMs,
  );
}
