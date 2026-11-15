import { Module } from '@nestjs/common';

import { ContactsModule } from '../contacts/contacts.module';
import { MessagesModule } from '../messages/messages.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignDispatchService } from './dispatch/campaign-dispatch.service';
import { CampaignDispatchWorker } from './dispatch/campaign-dispatch.worker';

/**
 * Phase 8B: campaign CRUD, audiences and lifecycle (8B-1, 8B-2) and, since 8B-3b, the campaign
 * executor and scheduler — disabled by default (`CAMPAIGN_DISPATCH_ENABLED`, refused outside
 * tests and without billing enforcement). The executor reaches the shared submission core only
 * with an automation-capability proof (migration 0068).
 */
@Module({
  imports: [ContactsModule, MessagesModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignDispatchService, CampaignDispatchWorker],
  exports: [CampaignsService, CampaignDispatchService, CampaignDispatchWorker],
})
export class CampaignsModule {}
