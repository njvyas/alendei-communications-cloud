import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, type SQL } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import { AuthorizationService } from '../auth/authorization.service';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import { ListQuery, type ListQuerySpec } from '../common/http/list-query';
import { AdvisoryTenantIds } from './advisory-identifier';
import { ListWorkspacesQueryDto } from './tenancy.dto';

/**
 * The minimum tenant-scoped read surface Phase 1B.3 needs.
 *
 * This exists to make the authentication-to-RLS chain demonstrable over real
 * HTTP rather than only in a service test — every link is exercised here:
 *
 *   AuthGuard → AuthPrincipal → ScopeResolver → TenantContext →
 *   X-Acc-Organization → withRequestTenant → SET LOCAL → acc_app → RLS → query
 *
 * Tenant administration proper (create/update/delete of organizations,
 * workspaces and teams) belongs to Phase 1B.6 and is deliberately absent.
 */
@Controller('tenants')
export class TenancyController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly lists: ListQuery,
  ) {}

  /**
   * The workspaces list's ordering contract (`API.md` §8b).
   *
   * `name` by default because that is how a workspace switcher reads; tie-broken
   * by `id`, so two workspaces sharing a name still have a total order and
   * neither is skipped across pages.
   */
  private readonly listSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.workspaces.name, encode: (row) => String(row.name) },
      // Chronological ordering runs on `id`, not on `created_at`, and that is a
      // correctness requirement rather than an optimisation. A cursor is text,
      // and a `timestamptz` round-tripped through JavaScript loses the
      // database's sub-millisecond precision — so the boundary lands *before*
      // the row it was minted from, the keyset predicate re-selects that row,
      // and the same page repeats forever. `id` is a UUIDv7: chronological by
      // construction, and a string that round-trips exactly.
      createdAt: { column: schema.workspaces.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.workspaces.id,
  };

  private principal(): ResolvedPrincipal {
    const principal = RequestContext.get()?.principal as ResolvedPrincipal | null | undefined;
    if (!principal) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }
    return principal;
  }

  /**
   * Workspaces in the current organization.
   *
   * The organization comes from the resolved tenant context and from nowhere
   * else. A caller-supplied `orgId` query parameter is advisory: the declaration
   * below hands it to `AdvisoryTenantGuard`, which refuses the request before
   * the handler runs if it disagrees with the resolved context, rather than
   * honouring it or quietly filtering to nothing (`TENANCY.md` §2b, ADR-004).
   * There is deliberately no comparison written here — one shared mechanism,
   * not a copy per endpoint.
   */
  @Get('workspaces')
  @RequiresPermission(PERMISSIONS.WORKSPACES_READ)
  @AdvisoryTenantIds({ level: 'organization', source: 'query', key: 'orgId' })
  async listWorkspaces(@Query() query: ListWorkspacesQueryDto) {
    const principal = this.principal();
    const orgId = principal.tenant.orgId;

    if (!orgId) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
        message: 'No organization context is established for this request',
      });
    }

    const resolved = this.lists.resolve(query, this.listSpec);

    // Authorization and the query share one tenant transaction, so the target's
    // ancestry is read under exactly the tenant context the query runs in
    // (ADR-005 D-5). The handler names the target and states no chain of its
    // own — there is no longer anywhere for one to be assembled.
    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.WORKSPACES_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      // The query still carries no tenant predicate of its own on purpose: RLS
      // is what scopes it, so a missing application-side filter cannot leak
      // another tenant's rows — and the filters below narrow that set, never
      // widen it.
      const predicates: SQL[] = [];
      if (query.status) predicates.push(eq(schema.workspaces.status, query.status));
      if (resolved.after) predicates.push(resolved.after);

      return tx
        .select({
          id: schema.workspaces.id,
          orgId: schema.workspaces.orgId,
          name: schema.workspaces.name,
          slug: schema.workspaces.slug,
          status: schema.workspaces.status,
          createdAt: schema.workspaces.createdAt,
        })
        .from(schema.workspaces)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });

    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.listSpec,
      (row) => String(row.id),
    );
    return { data: items, page };
  }

  /**
   * A single workspace by id.
   *
   * An id belonging to another organization returns `404`, not `403`: the row is
   * simply not visible to the query, because RLS filters it before the handler
   * ever sees it, and the response must not confirm that it exists somewhere
   * else (`API.md` §3a). The handler contains no ownership check of its own —
   * that absence is the point, and is what the cross-tenant test proves.
   */
  @Get('workspaces/:id')
  @RequiresPermission(PERMISSIONS.WORKSPACES_READ)
  async getWorkspace(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const orgId = principal.tenant.orgId;
    if (!orgId) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
        message: 'No organization context is established for this request',
      });
    }

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.WORKSPACES_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      return tx
        .select({
          id: schema.workspaces.id,
          orgId: schema.workspaces.orgId,
          name: schema.workspaces.name,
          slug: schema.workspaces.slug,
          status: schema.workspaces.status,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, id));
    });

    const workspace = rows[0];
    if (!workspace) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        // Never echoes the caller-supplied id back.
        message: 'Workspace not found',
        logContext: { requestedWorkspaceId: id },
      });
    }
    return { data: workspace };
  }
}
