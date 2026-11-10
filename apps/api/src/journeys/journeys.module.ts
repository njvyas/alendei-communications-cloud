import { Module } from '@nestjs/common';

import { JourneysController } from './journeys.controller';
import { JourneysService } from './journeys.service';

/** Phase 8C PR 8C-1: journey definitions only. No runner, trigger or send provider exists. */
@Module({
  controllers: [JourneysController],
  providers: [JourneysService],
})
export class JourneysModule {}
