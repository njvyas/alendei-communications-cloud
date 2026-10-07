import { Module } from '@nestjs/common';

import { MetricsService } from '../observability/metrics.service';
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
        metrics?: MetricsService,
      ) =>
        new ProviderSubmissionExecutor(timer, admissions, [new SimulatorAdapter(timer)], metrics),
      inject: [SUBMISSION_TIMER, CircuitAdmissions, { token: MetricsService, optional: true }],
    },
  ],
  exports: [ProviderSubmissionExecutor, CircuitAdmissions],
})
export class ProviderAdaptersModule {}
