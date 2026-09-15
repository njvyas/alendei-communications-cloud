import { Controller, Get } from '@nestjs/common';
import { PERMISSIONS } from '@acc/contracts';

import { RequestContext } from '../src/common/context/request-context';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { AuthorizationService } from '../src/auth/authorization.service';
import { RequiresPermission } from '../src/auth/requires-permission.decorator';
import type { ResolvedPrincipal } from '../src/auth/auth.guard';

/**
 * Routes that exist only to exercise `AuthorizationCoverageInterceptor` over
 * real HTTP.
 *
 * The interceptor's whole purpose is to catch a handler that *declares* a
 * permission and then does not check it — a mistake no production handler
 * currently makes, which is exactly why it cannot be demonstrated against one.
 * Writing the mistake deliberately here is the only honest way to prove the
 * mechanism fires, and it follows the precedent `AdvisoryProbeController`
 * already sets.
 *
 * Nothing here stands in for the interceptor: the guard chain in front, the
 * interceptor itself and the exception filter behind it are all the real ones.
 * Only the handler is the test's own.
 */
@Controller('test-authz-coverage')
export class AuthorizationCoverageProbeController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
  ) {}

  private principal(): ResolvedPrincipal {
    return RequestContext.get()!.principal as ResolvedPrincipal;
  }

  /** Declares a permission and checks it — the control. */
  @Get('checked')
  @RequiresPermission(PERMISSIONS.WORKSPACES_READ)
  async checked() {
    const principal = this.principal();
    await this.db.withRequestTenant((tx) =>
      this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.WORKSPACES_READ,
        target: { scopeType: 'organization', scopeId: principal.tenant.orgId },
        resourceType: 'Organization',
      }),
    );
    return { reached: true };
  }

  /** Declares a permission and never checks it — the defect under test. */
  @Get('forgotten')
  @RequiresPermission(PERMISSIONS.WORKSPACES_READ)
  forgotten() {
    return { reached: true, leaked: 'data the caller was never authorized for' };
  }

  /**
   * Declares one permission and checks a *different* one.
   *
   * The subtler defect: a handler that authorizes something, so the request
   * looks checked, but not the thing the route said it required.
   */
  @Get('mismatched')
  @RequiresPermission(PERMISSIONS.ROLES_DELETE)
  async mismatched() {
    const principal = this.principal();
    await this.db.withRequestTenant((tx) =>
      this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.WORKSPACES_READ,
        target: { scopeType: 'organization', scopeId: principal.tenant.orgId },
        resourceType: 'Organization',
      }),
    );
    return { reached: true };
  }
}
