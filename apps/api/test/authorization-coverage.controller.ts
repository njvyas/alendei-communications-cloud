import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AUDIT_ACTIONS, PERMISSIONS } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';

import { actorFromPrincipal } from '../src/audit/audit-actor';
import { AuditWriter } from '../src/audit/audit-writer.service';

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
    private readonly audit: AuditWriter,
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

  // --- mutating probes (Gate C M02/M03 containment) -------------------------------
  //
  // Each writes a business row (a workspace whose slug carries the caller's
  // marker) and its success audit row inside one request tenant transaction —
  // the shape of every administration mutation. What differs is only the
  // authorization check, so the suite can read the database afterwards and see
  // whether the write survived.

  /** Declares, checks, writes — the control: the write must commit. */
  @Post('checked-write')
  @HttpCode(201)
  @RequiresPermission(PERMISSIONS.WORKSPACES_READ)
  async checkedWrite(@Body() body: { marker: string }) {
    const principal = this.principal();
    await this.db.withRequestTenant(async (tx) => {
      await this.assertOrg(tx, principal, PERMISSIONS.WORKSPACES_READ);
      await this.write(tx, principal, body.marker);
    });
    return { reached: true };
  }

  /** Declares, never checks, writes — M02's shape: the write must not survive. */
  @Post('forgotten-write')
  @HttpCode(201)
  @RequiresPermission(PERMISSIONS.WORKSPACES_READ)
  async forgottenWrite(@Body() body: { marker: string }) {
    const principal = this.principal();
    await this.db.withRequestTenant((tx) => this.write(tx, principal, body.marker));
    return { reached: true };
  }

  /** Declares one permission, checks another, writes — M03's shape. */
  @Post('mismatched-write')
  @HttpCode(201)
  @RequiresPermission(PERMISSIONS.ROLES_DELETE)
  async mismatchedWrite(@Body() body: { marker: string }) {
    const principal = this.principal();
    await this.db.withRequestTenant(async (tx) => {
      await this.assertOrg(tx, principal, PERMISSIONS.WORKSPACES_READ);
      await this.write(tx, principal, body.marker);
    });
    return { reached: true };
  }

  /**
   * Declares one permission and is refused on a *precondition* check before
   * reaching it — `POST /organizations`'s shape when `platform.tenants.manage`
   * is asserted first. The refusal must stay a `403` with its denial record.
   */
  @Post('refused-precondition')
  @HttpCode(201)
  @RequiresPermission(PERMISSIONS.ROLES_DELETE)
  async refusedPrecondition(@Body() body: { marker: string }) {
    const principal = this.principal();
    await this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
        target: { scopeType: 'platform', scopeId: null },
        resourceType: 'Organization',
      });
      await this.write(tx, principal, body.marker);
    });
    return { reached: true };
  }

  /** Reads before the check in an earlier transaction, then checks and writes. */
  @Post('read-then-checked-write')
  @HttpCode(201)
  @RequiresPermission(PERMISSIONS.WORKSPACES_READ)
  async readThenCheckedWrite(@Body() body: { marker: string }) {
    const principal = this.principal();
    await this.db.withRequestTenant((tx) => tx.select().from(schema.workspaces).limit(1));
    await this.db.withRequestTenant(async (tx) => {
      await this.assertOrg(tx, principal, PERMISSIONS.WORKSPACES_READ);
      await this.write(tx, principal, body.marker);
    });
    return { reached: true };
  }

  private assertOrg(tx: Transaction, principal: ResolvedPrincipal, permission: string) {
    return this.authorization.assert(tx, {
      principal,
      permission,
      target: { scopeType: 'organization', scopeId: principal.tenant.orgId },
      resourceType: 'Organization',
    });
  }

  private async write(tx: Transaction, principal: ResolvedPrincipal, marker: string) {
    const [workspace] = await tx
      .insert(schema.workspaces)
      .values({ orgId: principal.tenant.orgId!, name: `probe ${marker}`, slug: marker })
      .returning({ id: schema.workspaces.id });
    await this.audit.record(
      {
        scopeType: 'workspace',
        scopeId: workspace!.id,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.WORKSPACE_CREATED,
        resourceType: 'Workspace',
        resourceId: workspace!.id,
        outcome: 'success',
        before: null,
        after: { slug: marker },
        metadata: { probe: marker },
      },
      tx,
    );
  }
}
