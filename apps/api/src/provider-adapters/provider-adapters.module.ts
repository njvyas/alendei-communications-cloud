import { Module } from '@nestjs/common';

import { PROVIDER_ADAPTERS, ProviderAdapterRegistry } from './adapter-registry';
import { CircuitAdmissions } from './circuit-admission';
import { SimulatorAdapter } from './simulator.adapter';
import { ProviderSubmissionExecutor } from './submission-executor';
import { RealSubmissionTimer, SUBMISSION_TIMER } from './submission-timer';

/**
 * Provider adapters (Phase 2.2, ADR-013). The registry is the only way to an
 * adapter; Phase 2 registers exactly `SimulatorAdapter`.
 */
@Module({
  providers: [
    { provide: SUBMISSION_TIMER, useClass: RealSubmissionTimer },
    SimulatorAdapter,
    {
      provide: PROVIDER_ADAPTERS,
      useFactory: (simulator: SimulatorAdapter) => [simulator],
      inject: [SimulatorAdapter],
    },
    ProviderAdapterRegistry,
    CircuitAdmissions,
    ProviderSubmissionExecutor,
  ],
  exports: [
    ProviderAdapterRegistry,
    ProviderSubmissionExecutor,
    SimulatorAdapter,
    CircuitAdmissions,
  ],
})
export class ProviderAdaptersModule {}
