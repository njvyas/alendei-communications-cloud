import { Module } from '@nestjs/common';

import { ProviderAdaptersModule } from '../provider-adapters/provider-adapters.module';
import { ChannelsController } from './channels.controller';
import { ProviderAccess } from './provider-access.service';
import { ProviderCatalogueService } from './provider-catalogue.service';
import { ProviderConfigurationCache } from './provider-configuration.cache';
import { ProviderConfigurationListener } from './provider-configuration.listener';
import { OrganizationProviderAssignmentsController } from './organization-provider-assignments.controller';
import { OrganizationProviderAssignmentsService } from './organization-provider-assignments.service';
import { ProviderCircuitPolicyController } from './provider-circuit-policy.controller';
import { ProviderCircuitPolicyService } from './provider-circuit-policy.service';
import { PROVIDER_CLOCK, SystemProviderClock } from './provider-clock';
import { ProviderHealthService } from './provider-health.service';
import { ProviderRegistryService } from './provider-registry.service';
import { ProviderStateStore } from './provider-state.store';
import { ProvidersController } from './providers.controller';

/**
 * Channel and provider registry (Phase 2.1), adapter test-send (Phase 2.2),
 * health and circuit breaker (Phase 2.3), and organization provider assignments
 * (Phase 3.2, ADR-014 §4), ADR-013.
 */
@Module({
  imports: [ProviderAdaptersModule],
  controllers: [
    ChannelsController,
    ProvidersController,
    ProviderCircuitPolicyController,
    OrganizationProviderAssignmentsController,
  ],
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
    OrganizationProviderAssignmentsService,
  ],
  exports: [OrganizationProviderAssignmentsService],
})
export class ProvidersModule {}
