import { Module } from '@nestjs/common';

import { ProviderAdaptersModule } from '../provider-adapters/provider-adapters.module';
import { ChannelsController } from './channels.controller';
import { ProviderAccess } from './provider-access.service';
import { ProviderCatalogueService } from './provider-catalogue.service';
import { ProviderConfigurationCache } from './provider-configuration.cache';
import { ProviderConfigurationListener } from './provider-configuration.listener';
import { ProviderCircuitPolicyController } from './provider-circuit-policy.controller';
import { ProviderCircuitPolicyService } from './provider-circuit-policy.service';
import { PROVIDER_CLOCK, SystemProviderClock } from './provider-clock';
import { ProviderHealthService } from './provider-health.service';
import { ProviderRegistryService } from './provider-registry.service';
import { ProviderStateStore } from './provider-state.store';
import { ProvidersController } from './providers.controller';

/**
 * Channel and provider registry (Phase 2.1), adapter test-send (Phase 2.2) and
 * health and circuit breaker (Phase 2.3), ADR-013. No routing, credential,
 * scheduler or event code.
 */
@Module({
  imports: [ProviderAdaptersModule],
  controllers: [ChannelsController, ProvidersController, ProviderCircuitPolicyController],
  providers: [
    { provide: PROVIDER_CLOCK, useClass: SystemProviderClock },
    ProviderAccess,
    ProviderStateStore,
    ProviderRegistryService,
    ProviderHealthService,
    ProviderCircuitPolicyService,
    ProviderConfigurationCache,
    ProviderConfigurationListener,
    ProviderCatalogueService,
  ],
})
export class ProvidersModule {}
