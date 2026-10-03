import { Module } from '@nestjs/common';

import { ProviderAdaptersModule } from '../provider-adapters/provider-adapters.module';
import { ChannelsController } from './channels.controller';
import { ProviderRegistryService } from './provider-registry.service';
import { ProvidersController } from './providers.controller';

/** Channel and provider registry (Phase 2.1) and adapter test-send (Phase 2.2), ADR-013. No health, routing or credential code. */
@Module({
  imports: [ProviderAdaptersModule],
  controllers: [ChannelsController, ProvidersController],
  providers: [ProviderRegistryService],
})
export class ProvidersModule {}
