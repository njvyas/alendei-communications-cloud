import { Module } from '@nestjs/common';

import { JourneyAccess } from './journey-access';
import { JourneyExecutionsController } from './journey-executions.controller';
import { JourneyExecutionsService } from './journey-executions.service';
import { JourneyLifecycleService } from './journey-lifecycle.service';
import { JourneyValidation } from './journey-validation';
import { JourneysController } from './journeys.controller';
import { JourneysService } from './journeys.service';

/**
 * Phase 8C: journey definitions (8C-1), lifecycle, API enrolment, execution reads, operator
 * cancel and statistics (8C-2). No runner, trigger intake, scheduler or send provider exists.
 */
@Module({
  controllers: [JourneysController, JourneyExecutionsController],
  providers: [
    JourneyAccess,
    JourneyValidation,
    JourneysService,
    JourneyLifecycleService,
    JourneyExecutionsService,
  ],
})
export class JourneysModule {}
