import { Module } from '@nestjs/common';

import { AutomationControlsController } from './automation-controls.controller';
import { AutomationControlsService } from './automation-controls.service';

/**
 * Phase 8B PR 8B-3a: the shared automation sending identity's administrator controls. The
 * identity itself (capabilities, mint, validity, reservation admission) lives in the database
 * (0068); the campaign executor that uses it is 8B-3b and stays disabled.
 */
@Module({
  controllers: [AutomationControlsController],
  providers: [AutomationControlsService],
})
export class AutomationModule {}
