import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { ProviderAdaptersModule } from '../provider-adapters/provider-adapters.module';
import { ProvidersModule } from '../providers/providers.module';
import { DispatchWorker } from './dispatch/dispatch.worker';
import { DispatcherService } from './dispatch/dispatcher.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MessageSubmissionCore } from './submission/message-submission.core';
import { MessageUsageController } from './usage/message-usage.controller';
import { MessageUsageService } from './usage/message-usage.service';

@Module({
  imports: [ProvidersModule, ProviderAdaptersModule, BillingModule],
  controllers: [MessagesController, MessageUsageController],
  providers: [
    MessagesService,
    MessageSubmissionCore,
    MessageUsageService,
    DispatcherService,
    DispatchWorker,
  ],
  // Phase 8B PR 8B-3b: the shared core is exported for its one admitted second consumer, the
  // campaign executor, which reaches it only with an automation-capability proof
  // (message-submission.architecture.spec.ts pins that no other module uses it).
  exports: [MessagesService, DispatcherService, MessageSubmissionCore],
})
export class MessagesModule {}
