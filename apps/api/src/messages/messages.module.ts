import { Module } from '@nestjs/common';
import { ProviderAdaptersModule } from '../provider-adapters/provider-adapters.module';
import { ProvidersModule } from '../providers/providers.module';
import { DispatchWorker } from './dispatch/dispatch.worker';
import { DispatcherService } from './dispatch/dispatcher.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MessageUsageController } from './usage/message-usage.controller';
import { MessageUsageService } from './usage/message-usage.service';

@Module({
  imports: [ProvidersModule, ProviderAdaptersModule],
  controllers: [MessagesController, MessageUsageController],
  providers: [MessagesService, MessageUsageService, DispatcherService, DispatchWorker],
  exports: [MessagesService, DispatcherService],
})
export class MessagesModule {}
