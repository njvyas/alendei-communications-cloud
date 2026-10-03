import { Module } from '@nestjs/common';

import { ChannelsController } from './channels.controller';
import { ProviderRegistryService } from './provider-registry.service';
import { ProvidersController } from './providers.controller';

/** Channel and provider registry (Phase 2.1, ADR-013). No adapter, health or credential code. */
@Module({
  controllers: [ChannelsController, ProvidersController],
  providers: [ProviderRegistryService],
})
export class ProvidersModule {}
