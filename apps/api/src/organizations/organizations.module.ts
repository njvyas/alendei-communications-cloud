import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { DomainsModule } from './domains/domains.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OrganizationAdministrationService } from './organization-administration.service';
import { OrganizationsController } from './organizations.controller';

/** Organization administration and lifecycle (Phase 1C.1a, ADR-012, U12). */
@Module({
  imports: [RbacModule, DomainsModule, OnboardingModule],
  controllers: [OrganizationsController],
  providers: [OrganizationAdministrationService],
  exports: [DomainsModule, OnboardingModule],
})
export class OrganizationsModule {}
