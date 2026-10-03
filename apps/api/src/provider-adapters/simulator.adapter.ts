import { Inject, Injectable } from '@nestjs/common';
import {
  CHANNEL_CODES,
  PROVIDER_SUBMISSION_DEFAULTS,
  RETRYABLE_FAILURE_CATEGORIES,
  SIMULATOR_BEHAVIORS,
  type ProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderAdapterContext,
  type ProviderFailureCategory,
  type ProviderHealthProbe,
  type ProviderSubmission,
  type ProviderSubmissionOptions,
  type ProviderSubmissionResult,
  type SimulatorBehavior,
} from '@acc/contracts';

import { SUBMISSION_TIMER, type SubmissionTimer } from './submission-timer';

/** An adapter operation that has no Phase 2 behaviour (ADR-013 PD-6). */
export class ProviderAdapterUnsupportedOperation extends Error {
  constructor(adapterKey: string, operation: string) {
    super(`${adapterKey}: ${operation} is not implemented in Phase 2`);
    this.name = 'ProviderAdapterUnsupportedOperation';
  }
}

/** What each failing behaviour simulates, as the provider would answer it. */
const FAILURES: Readonly<
  Record<
    Exclude<SimulatorBehavior, 'SUCCESS' | 'SLOW_RESPONSE' | 'TIMEOUT'>,
    { category: ProviderFailureCategory; providerCode: string; message: string }
  >
> = {
  '500': {
    category: 'PROVIDER_ERROR',
    providerCode: 'SIM-500',
    message: 'Simulated provider server error',
  },
  '429': {
    category: 'RATE_LIMITED',
    providerCode: 'SIM-429',
    message: 'Simulated provider rate limit',
  },
  INVALID_CREDENTIALS: {
    category: 'AUTH_ERROR',
    providerCode: 'SIM-401',
    message: 'Simulated provider credential rejection',
  },
  INVALID_REQUEST: {
    category: 'INVALID_REQUEST',
    providerCode: 'SIM-400',
    message: 'Simulated provider request rejection',
  },
};

/**
 * The only Phase 2 adapter (`PROVIDER_ADAPTER.md` §7, ADR-013 PD-3): it never
 * opens a network connection and reproduces, on demand, the seven
 * submission-time behaviours. It is **deterministic**: the behaviour is chosen
 * explicitly per submission (`forBehavior`), the provider message id derives
 * from the submission id, and every wait goes through the injected timer.
 *
 * It holds and needs no credential; `INVALID_CREDENTIALS` is a simulated answer.
 * Delivery and webhook behaviours are Phase 3.
 */
@Injectable()
export class SimulatorAdapter implements ProviderAdapter {
  readonly adapterKey = 'simulator';

  constructor(@Inject(SUBMISSION_TIMER) private readonly timer: SubmissionTimer) {}

  capabilities(): ProviderAdapterCapabilities {
    return { channels: CHANNEL_CODES };
  }

  async healthCheck(): Promise<ProviderHealthProbe> {
    return { healthy: true, latencyMs: 0 };
  }

  /** A view of this adapter that answers every submission with `behavior`. */
  forBehavior(behavior: SimulatorBehavior): ProviderAdapter {
    return {
      adapterKey: this.adapterKey,
      capabilities: () => this.capabilities(),
      healthCheck: () => this.healthCheck(),
      send: (context, submission, options) => this.simulate(behavior, context, submission, options),
      estimateCost: () => this.estimateCost(),
      checkStatus: () => this.checkStatus(),
      parseWebhook: () => this.parseWebhook(),
    };
  }

  /**
   * Without a behaviour the simulator cannot know what to answer — that is a
   * configuration error of the caller, reported as such, never a success.
   */
  send(
    _context: ProviderAdapterContext,
    submission: ProviderSubmission,
  ): Promise<ProviderSubmissionResult> {
    return Promise.resolve(
      this.reject(
        submission,
        'CONFIGURATION_ERROR',
        null,
        'The simulator needs an explicit behaviour',
        0,
      ),
    );
  }

  estimateCost(): Promise<never> {
    return Promise.reject(new ProviderAdapterUnsupportedOperation(this.adapterKey, 'estimateCost'));
  }

  checkStatus(): Promise<never> {
    return Promise.reject(new ProviderAdapterUnsupportedOperation(this.adapterKey, 'checkStatus'));
  }

  parseWebhook(): Promise<never> {
    return Promise.reject(new ProviderAdapterUnsupportedOperation(this.adapterKey, 'parseWebhook'));
  }

  private async simulate(
    behavior: SimulatorBehavior,
    context: ProviderAdapterContext,
    submission: ProviderSubmission,
    options: ProviderSubmissionOptions,
  ): Promise<ProviderSubmissionResult> {
    const started = this.timer.now();
    const elapsed = () => Math.round(this.timer.now() - started);

    if (!(SIMULATOR_BEHAVIORS as readonly string[]).includes(behavior)) {
      return this.reject(submission, 'CONFIGURATION_ERROR', null, 'Unknown simulator behaviour', 0);
    }
    if (!this.capabilities().channels.includes(context.channel)) {
      return this.reject(
        submission,
        'CONFIGURATION_ERROR',
        null,
        'The simulator does not serve this channel',
        0,
      );
    }

    switch (behavior) {
      case 'SUCCESS':
        return this.accept(submission, elapsed());
      case 'SLOW_RESPONSE':
        await this.timer.sleep(
          PROVIDER_SUBMISSION_DEFAULTS.SIMULATOR_SLOW_RESPONSE_MS,
          options.signal,
        );
        return this.accept(submission, elapsed());
      case 'TIMEOUT':
        // Never answers. The executor's timeout decides the outcome; the wait
        // ends when the executor aborts it, so nothing is left running.
        await this.timer.sleep(Infinity, options.signal);
        return this.reject(
          submission,
          'TIMEOUT',
          null,
          'Simulated provider did not answer',
          elapsed(),
        );
      default: {
        const failure = FAILURES[behavior];
        return this.reject(
          submission,
          failure.category,
          failure.providerCode,
          failure.message,
          elapsed(),
        );
      }
    }
  }

  private accept(submission: ProviderSubmission, latencyMs: number): ProviderSubmissionResult {
    return {
      outcome: 'accepted',
      submissionId: submission.submissionId,
      correlationId: submission.correlationId,
      providerMessageId: `sim-${submission.submissionId}`,
      latencyMs,
    };
  }

  private reject(
    submission: ProviderSubmission,
    category: ProviderFailureCategory,
    providerCode: string | null,
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
        providerCode,
        message,
      },
      latencyMs,
    };
  }
}
