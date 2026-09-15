import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PermissionsController, RolesController } from './roles.controller';
import { RoleAdministrationService } from './role-administration.service';
import { TenantRoleProvisioner } from './tenant-role-provisioner.service';

/**
 * Role and permission administration (`ARCHITECTURE.md` §4: `tenancy`).
 *
 * Kept as its own module rather than folded into `TenancyModule`: that module
 * owns the organization/workspace/team read surface and the advisory-identifier
 * guard, and RBAC administration is a different concern with a different
 * dependency — `AuthorizationService` and `AuditWriter` — that would otherwise
 * be pulled into it.
 *
 * `TenantRoleProvisioner` is exported because Phase 1B.8 wires it into
 * organization creation. It has no HTTP surface here and deliberately none is
 * offered: provisioning is a lifecycle step, not an endpoint.
 */
@Module({
  imports: [AuthModule],
  controllers: [RolesController, PermissionsController],
  providers: [RoleAdministrationService, TenantRoleProvisioner],
  exports: [RoleAdministrationService, TenantRoleProvisioner],
})
export class RbacModule {}
