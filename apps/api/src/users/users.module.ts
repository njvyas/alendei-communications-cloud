import { Module } from '@nestjs/common';

import { IamModule } from '../iam/iam.module';
import { RbacModule } from '../rbac/rbac.module';
import { UserAdministrationService } from './user-administration.service';
import { UsersController } from './users.controller';

/**
 * User administration (Phase 1B.6.1).
 *
 * Its own module rather than folded into `IamModule`, for a structural reason
 * rather than a stylistic one: `AuthModule` imports `IamModule` for the
 * credential, session and user-state primitives the guard needs, so a controller
 * living there that also needed `RoleAssignmentService` would close a cycle
 * through `RbacModule`. Keeping the control-plane surface above the primitives
 * it uses — `IamModule` for sessions and lifecycle, `RbacModule` for grants —
 * leaves the dependency graph one-directional.
 *
 * `AuthorizationService`, `AuditWriter`, `TenantDatabase`, `ListQuery` and
 * `IdempotencyService` all arrive from `@Global()` modules and are deliberately
 * not re-imported here.
 */
@Module({
  imports: [IamModule, RbacModule],
  controllers: [UsersController],
  providers: [UserAdministrationService],
  exports: [UserAdministrationService],
})
export class UsersModule {}
