import { Module } from '@nestjs/common';

import { JourneyAccess } from './journey-access';
import { JourneyExecutionsController } from './journey-executions.controller';
import { JourneyExecutionsService } from './journey-executions.service';
import { JourneyLifecycleService } from './journey-lifecycle.service';
import { JourneyValidation } from './journey-validation';
import { JourneysController } from './journeys.controller';
import { JourneysService } from './journeys.service';
import { JourneyRunnerService } from './runner/journey-runner.service';
import { JourneyRunner } from './runner/journey-runner.worker';
import { JOURNEY_SEND_PORT, UnavailableJourneySendPort } from './runner/journey-send.port';
import { JourneyTriggerProcessingService } from './runner/journey-trigger-processing.service';

/**
 * Phase 8C: journey definitions (8C-1), lifecycle, API enrolment, execution reads, operator
 * cancel and statistics (8C-2), the runner (8C-3), event intake and schedules (8C-4), all
 * disabled by default. 8C-5b: the send node's port is bound to `UnavailableJourneySendPort`
 * (never sends); the real binding is 8C-6.
 */
@Module({
  controllers: [JourneysController, JourneyExecutionsController],
  providers: [
    JourneyAccess,
    JourneyValidation,
    JourneysService,
    JourneyLifecycleService,
    JourneyExecutionsService,
    // 8C-3: off unless JOURNEY_RUNNER_ENABLED (refused outside tests).
    JourneyRunnerService,
    // 8C-5b: the only production binding of the send port, until 8C-6.
    { provide: JOURNEY_SEND_PORT, useClass: UnavailableJourneySendPort },
    // 8C-4: event intake and scheduled firing, run only by the (disabled) runner loop.
    JourneyTriggerProcessingService,
    JourneyRunner,
  ],
  exports: [JourneyRunnerService, JourneyTriggerProcessingService, JourneyRunner],
})
export class JourneysModule {}
