import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { OrganizationAdministrationService } from './organization-administration.service';
import { OrganizationsController } from './organizations.controller';

/** Organization administration and lifecycle (Phase 1C.1a, ADR-012). */
@Module({
  imports: [RbacModule],
  controllers: [OrganizationsController],
  providers: [OrganizationAdministrationService],
})
export class OrganizationsModule {}
