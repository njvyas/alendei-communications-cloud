import { Module } from '@nestjs/common';
import { ProviderAdaptersModule } from '../provider-adapters/provider-adapters.module';
import { ProvidersModule } from '../providers/providers.module';
import { DispatcherService } from './dispatch/dispatcher.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [ProvidersModule, ProviderAdaptersModule],
  controllers: [MessagesController],
  providers: [MessagesService, DispatcherService],
  exports: [MessagesService, DispatcherService],
})
export class MessagesModule {}
