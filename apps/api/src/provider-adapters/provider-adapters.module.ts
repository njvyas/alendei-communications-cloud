import { Module } from '@nestjs/common';

import { MetricsService } from '../observability/metrics.service';
import {
  SIMULATOR_WEBHOOK_KEY_SOURCE,
  type SimulatorWebhookKeySourceFn,
} from '../webhooks/simulator-webhook-key';
import { CircuitAdmissions } from './circuit-admission';
import { SimulatorAdapter } from './simulator.adapter';
import { ProviderSubmissionExecutor } from './submission-executor';
import { RealSubmissionTimer, SUBMISSION_TIMER, type SubmissionTimer } from './submission-timer';

/**
 * Provider adapters (Phase 2.2, ADR-013; structural admission, ADR-015 R-13).
 *
 * Exactly two things leave this module: the submission executor (`execute`,
 * `probe` and the registered keys) and the admission ledger (whose issuer
 * `ProviderStateStore` claims). The adapters and their registry are **not**
 * DI providers: they are built here, inside the executor's factory, and live
 * only in the executor's private registry, so neither `app.get()` nor any
 * exported service can hand out an adapter. Phase 2 registers exactly
 * `SimulatorAdapter`.
 */
@Module({
  providers: [
    { provide: SUBMISSION_TIMER, useClass: RealSubmissionTimer },
    {
      provide: CircuitAdmissions,
      useFactory: (timer: SubmissionTimer) => new CircuitAdmissions(timer),
      inject: [SUBMISSION_TIMER],
    },
    {
      provide: ProviderSubmissionExecutor,
      useFactory: (
        timer: SubmissionTimer,
        admissions: CircuitAdmissions,
        webhookKey: SimulatorWebhookKeySourceFn,
        metrics?: MetricsService,
      ) =>
        new ProviderSubmissionExecutor(
          timer,
          admissions,
          // Phase 5.0 PR-C: the simulator's receipt-signing key source, resolved in the
          // deployment plane (webhooks/webhook-key-material.module.ts) — never here (D-2).
          [new SimulatorAdapter(timer, { webhookKey })],
          metrics,
        ),
      inject: [
        SUBMISSION_TIMER,
        CircuitAdmissions,
        SIMULATOR_WEBHOOK_KEY_SOURCE,
        { token: MetricsService, optional: true },
      ],
    },
  ],
  exports: [ProviderSubmissionExecutor, CircuitAdmissions],
})
export class ProviderAdaptersModule {}
