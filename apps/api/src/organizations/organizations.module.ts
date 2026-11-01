import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { DomainsModule } from './domains/domains.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OrganizationAdministrationService } from './organization-administration.service';
import { OrganizationsController } from './organizations.controller';
import { ResellersModule } from './resellers/resellers.module';

/** Organization administration and lifecycle (Phase 1C.1a, ADR-012, U12, U13). */
@Module({
  imports: [RbacModule, DomainsModule, OnboardingModule, ResellersModule],
  controllers: [OrganizationsController],
  providers: [OrganizationAdministrationService],
  exports: [DomainsModule, OnboardingModule, ResellersModule],
})
export class OrganizationsModule {}
