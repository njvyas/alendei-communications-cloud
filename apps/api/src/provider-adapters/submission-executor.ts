import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  PROVIDER_FAILURE_CATEGORIES,
  RETRYABLE_FAILURE_CATEGORIES,
  type ProviderAdapter,
  type ProviderProbeOutcome,
  type ProviderAdapterContext,
  type ProviderSubmission,
  type ProviderSubmissionResult,
} from '@acc/contracts';

import { MetricsService } from '../observability/metrics.service';
import { CircuitAdmissionRequired, CircuitAdmissions } from './circuit-admission';
import { SUBMISSION_TIMER, type SubmissionTimer } from './submission-timer';

/**
 * Runs one adapter submission under the platform timeout and normalizes what
 * comes back (Phase 2.2).
 *
 * Everything an adapter can do is reduced to the contract's two outcomes:
 *   - no answer within `timeoutMs` → `rejected / TIMEOUT` (the adapter's wait is
 *     aborted, so nothing outlives the request);
 *   - a thrown error → `rejected / UNKNOWN` (logged for the operator; the
 *     caller learns only the category);
 *   - a result outside the taxonomy → `rejected / UNKNOWN`.
 * `retryable` is recomputed from the category — one definition, never an
 * adapter's opinion — and `latencyMs` is measured here, on the injected clock.
 */
const TIMED_OUT: unique symbol = Symbol('timeout');

@Injectable()
export class ProviderSubmissionExecutor {
  private readonly logger = new Logger(ProviderSubmissionExecutor.name);

  constructor(
    @Inject(SUBMISSION_TIMER) private readonly timer: SubmissionTimer,
    private readonly admissions: CircuitAdmissions,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Runs the submission and counts it, once, by channel and normalized outcome.
   *
   * **Circuit admission is mandatory** (`PROVIDER_ADAPTER.md` §6h): the first
   * argument must be the admission the circuit issued for this submission to
   * `context.providerId`, unused and fresh. It is redeemed before the adapter is
   * touched; anything else — a routing-eligibility verdict, a copy, a reused or
   * foreign admission — throws `CircuitAdmissionRequired` and nothing is sent.
   * This is the only path to an adapter's `send()`.
   */
  async execute(
    admission: unknown,
    adapter: ProviderAdapter,
    context: ProviderAdapterContext,
    submission: ProviderSubmission,
    timeoutMs: number,
  ): Promise<ProviderSubmissionResult> {
    try {
      this.admissions.consume(admission, context.providerId);
    } catch (error) {
      if (error instanceof CircuitAdmissionRequired) {
        this.logger.error({
          msg: 'provider submission refused: no valid circuit admission',
          reason: error.reason,
          providerId: context.providerId,
          submissionId: submission.submissionId,
          correlationId: submission.correlationId,
        });
      }
      throw error;
    }
    const result = await this.run(adapter, context, submission, timeoutMs);
    this.metrics?.providerSubmissions.inc({
      channel: context.channel,
      outcome: result.outcome === 'accepted' ? 'accepted' : result.failure.category.toLowerCase(),
    });
    return result;
  }

  /**
   * Runs one health check under `timeoutMs` (Phase 2.3) and counts it, once, by
   * channel and outcome. No answer in time is `timeout`; a thrown error or an
   * answer outside the contract is `unhealthy` — never `healthy`.
   */
  async probe(
    adapter: ProviderAdapter,
    context: ProviderAdapterContext,
    timeoutMs: number,
  ): Promise<{ outcome: ProviderProbeOutcome; latencyMs: number }> {
    const started = this.timer.now();
    const abort = new AbortController();
    const timeout = this.timer
      .sleep(timeoutMs, abort.signal)
      .then((): typeof TIMED_OUT => TIMED_OUT);
    let result: { outcome: ProviderProbeOutcome; latencyMs: number };
    try {
      const raced = await Promise.race([
        adapter.healthCheck(context, { timeoutMs, signal: abort.signal }),
        timeout,
      ]);
      const latencyMs = Math.round(this.timer.now() - started);
      if (raced === TIMED_OUT) result = { outcome: 'timeout', latencyMs: timeoutMs };
      else if (raced?.healthy === true) result = { outcome: 'healthy', latencyMs };
      else result = { outcome: 'unhealthy', latencyMs };
    } catch (error) {
      this.logger.error({
        msg: 'provider adapter threw during a health check',
        adapterKey: adapter.adapterKey,
        providerId: context.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
      result = { outcome: 'unhealthy', latencyMs: Math.round(this.timer.now() - started) };
    } finally {
      abort.abort();
    }
    this.metrics?.providerHealthChecks.inc({ channel: context.channel, outcome: result.outcome });
    return result;
  }

  private async run(
    adapter: ProviderAdapter,
    context: ProviderAdapterContext,
    submission: ProviderSubmission,
    timeoutMs: number,
  ): Promise<ProviderSubmissionResult> {
    const started = this.timer.now();
    const abort = new AbortController();
    const elapsed = () => Math.round(this.timer.now() - started);

    const timeout = this.timer
      .sleep(timeoutMs, abort.signal)
      .then((): typeof TIMED_OUT => TIMED_OUT);
    let raced: ProviderSubmissionResult | typeof TIMED_OUT;
    try {
      raced = await Promise.race([
        adapter.send(context, submission, { timeoutMs, signal: abort.signal }),
        timeout,
      ]);
    } catch (error) {
      abort.abort();
      this.logger.error({
        msg: 'provider adapter threw during a submission',
        adapterKey: adapter.adapterKey,
        providerId: context.providerId,
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
