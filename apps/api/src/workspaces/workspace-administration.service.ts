import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
  type PageInfo,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, count, eq, type SQL } from 'drizzle-orm';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { assertOrganizationActive, workspaceLifecycleConflict } from '../tenancy/scope-lifecycle';
import type { CreateWorkspaceDto, ScopeStatus, UpdateWorkspaceDto } from './workspace.dto';

/** The workspace resource (`FRONTEND_API_CONTRACT.md` §31b). Exhaustive. */
export interface WorkspaceView {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: ScopeStatus;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListWorkspacesFilter extends ListQueryInput {
  readonly status?: ScopeStatus;
}

type WorkspaceRow = typeof schema.workspaces.$inferSelect;

/**
 * Workspace administration and lifecycle (Phase 1C.1b, ADR-012 F-6).
 *
 * **Every route acts in the selected organization** (`X-Acc-Organization`, or
 * implicitly) — the tenant context `AuthGuard` resolved, run through
 * `withRequestTenant`, so RLS holds the organization boundary beneath
 * everything here. A workspace id is a target inside that organization: it is
 * read pinned to the selected organization *and* under RLS, so another
 * organization's workspace is a `404` even for a principal whose RLS view spans
 * several (a reseller administrator), and its ancestry for authorization comes
 * from the database via `AuthorizationService`, never from the request.
 *
 * **Visibility and coverage are decided separately** (`SECURITY.md`,
 * `FRONTEND_API_CONTRACT.md` §31 common rules). A workspace that is not visible
 * to the request's tenant — unknown, in another organization, or hidden by RLS
 * — is a `404` that never echoes the id. A workspace that is visible but not
 * covered by a coherent grant carrying the route's permission is `403
 * AUTHZ_SCOPE_DENIED` with an `authorization.denied` audit row, decided by
 * `AuthorizationService`. Inside one organization that is the whole of
 * workspace isolation — application authorization, not RLS (ADR-011 D-4).
 */
@Injectable()
export class WorkspaceAdministrationService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.workspaces.name, encode: (row) => String(row.name) },
      // `id` (UUIDv7) rather than `created_at`: a cursor must round-trip exactly
      // (see `TenancyController`).
      createdAt: { column: schema.workspaces.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.workspaces.id,
  };

  // --- reads -------------------------------------------------------------------

  /**
   * Workspaces of the selected organization. Authorized at the organization, so
   * a workspace- or team-scoped principal is refused (`403`) and reads its own
   * workspace through `get`.
   */
  async list(
    principal: AuthPrincipal,
    filter: ListWorkspacesFilter = {},
  ): Promise<{ items: readonly WorkspaceView[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.WORKSPACES_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });
      // Pinned to the organization the list was authorized against; RLS beneath
      // it holds the tenant boundary if this predicate is ever lost.
      const predicates: SQL[] = [eq(schema.workspaces.orgId, orgId)];
      if (filter.status) predicates.push(eq(schema.workspaces.status, filter.status));
      if (resolved.after) predicates.push(resolved.after);
      return tx
        .select()
        .from(schema.workspaces)
        .where(and(...predicates))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });

    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.listSpec,
      (row) => String(row.id),
    );
    return { items: items.map((row) => workspaceView(row as never)), page };
  }

  async get(principal: AuthPrincipal, id: string): Promise<WorkspaceView> {
    return this.db.withRequestTenant(async (tx) => {
      const row = await this.loadVisible(tx, principal, id);
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.WORKSPACES_READ,
        target: { scopeType: 'workspace', scopeId: id },
        resourceType: 'Workspace',
      });
      return workspaceView(row);
    });
  }

  // --- creation ------------------------------------------------------------------

  /** Creates a workspace in the selected organization (`workspaces.create` there). */
  async create(
    principal: AuthPrincipal,
    input: CreateWorkspaceDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: WorkspaceView }>> {
    const orgId = requireOrganization(principal);
    const authorize = (tx: Transaction) =>
      this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.WORKSPACES_CREATE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

    return this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: '/workspaces',
        orgId,
        principal,
        pathParams: {},
        query: {},
        body: { name: input.name, slug: input.slug },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);
        await assertOrganizationActive(tx, orgId);
        const row = await this.insert(tx, orgId, input);
        const view = workspaceView(row);
        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: view.id,
            ...actorFromPrincipal(principal),
            action: AUDIT_ACTIONS.WORKSPACE_CREATED,
            resourceType: 'Workspace',
            resourceId: view.id,
            outcome: 'success',
            before: null,
            after: { orgId, name: view.name, slug: view.slug, isDefault: false },
            metadata: {},
          },
          tx,
        );
        return { data: view };
      },
    });
  }

  // --- update ----------------------------------------------------------------------

  /** Renames a workspace (`workspaces.update` at the workspace). Archived: `409`. */
  async update(
    principal: AuthPrincipal,
    id: string,
    input: UpdateWorkspaceDto,
  ): Promise<WorkspaceView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.loadVisible(tx, principal, id);
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.WORKSPACES_UPDATE,
        target: { scopeType: 'workspace', scopeId: id },
        resourceType: 'Workspace',
      });
      await assertOrganizationActive(tx, requireOrganization(principal));
      const before = await this.lock(tx, id);
      if (before.status !== 'active') throw workspaceLifecycleConflict(before.status);
      if (input.name === undefined || input.name === before.name) return workspaceView(before);

      const [row] = await tx
        .update(schema.workspaces)
        .set({ name: input.name })
        .where(eq(schema.workspaces.id, id))
        .returning();
      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: id,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTIONS.WORKSPACE_UPDATED,
          resourceType: 'Workspace',
          resourceId: id,
          outcome: 'success',
          before: { name: before.name },
          after: { name: row!.name },
          metadata: {},
        },
        tx,
      );
      return workspaceView(row!);
    });
  }

  // --- lifecycle ---------------------------------------------------------------------

  /**
   * Archives a workspace (ADR-012 F-6): `workspaces.update` at the
   * **organization**, so a workspace manager cannot archive its own workspace.
   * Refused (`409`) when already archived, when it is the default workspace, or
   * while it holds active teams — no cascading state change.
   *
   * The workspace row is locked `FOR UPDATE` before its teams are counted, and
   * every path that makes a team active in it (create, restore) takes `FOR SHARE`
   * on the same row first — so a team cannot become active between the count
   * and the archive.
   */
  async archive(principal: AuthPrincipal, id: string): Promise<WorkspaceView> {
    return this.transition(principal, id, 'archive');
  }

  /** Restores an archived workspace; the organization must be active (F-5). */
  async restore(principal: AuthPrincipal, id: string): Promise<WorkspaceView> {
    return this.transition(principal, id, 'restore');
  }

  private async transition(
    principal: AuthPrincipal,
    id: string,
    kind: 'archive' | 'restore',
  ): Promise<WorkspaceView> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.loadVisible(tx, principal, id);
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.WORKSPACES_UPDATE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Workspace',
      });
      await assertOrganizationActive(tx, orgId);
      const before = await this.lock(tx, id);

      if (kind === 'archive') {
        if (before.status !== 'active') throw workspaceLifecycleConflict(before.status);
        if (before.isDefault) throw workspaceLifecycleConflict(before.status, { isDefault: true });
        const [{ value: activeTeams } = { value: 0 }] = await tx
          .select({ value: count() })
          .from(schema.teams)
          .where(and(eq(schema.teams.workspaceId, id), eq(schema.teams.status, 'active')));
        if (activeTeams > 0) throw workspaceLifecycleConflict(before.status, { activeTeams });
      } else if (before.status !== 'archived') {
        throw workspaceLifecycleConflict(before.status);
      }

      const to: ScopeStatus = kind === 'archive' ? 'archived' : 'active';
      const [row] = await tx
        .update(schema.workspaces)
        .set({ status: to })
        .where(eq(schema.workspaces.id, id))
        .returning();
      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: id,
          ...actorFromPrincipal(principal),
          action:
            kind === 'archive'
              ? AUDIT_ACTIONS.WORKSPACE_ARCHIVED
              : AUDIT_ACTIONS.WORKSPACE_RESTORED,
          resourceType: 'Workspace',
          resourceId: id,
          outcome: 'success',
          before: { status: before.status },
          after: { status: to },
          metadata: {},
        },
        tx,
      );
      return workspaceView(row!);
    });
  }

  // --- shared with teams ---------------------------------------------------------------

  /**
   * The workspace `id` if it is visible to this request's tenant: in the
   * selected organization and admitted by RLS. Anything else is the same `404`,
   * which never echoes the id. Whether the caller may act on it is not decided
   * here — that is the caller's `AuthorizationService.assert`, whose refusal is
   * a `403`.
   */
  async loadVisible(tx: Transaction, principal: AuthPrincipal, id: string): Promise<WorkspaceRow> {
    const orgId = requireOrganization(principal);
    const [row] = await tx
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.orgId, orgId)));
    if (!row) throw workspaceNotFound(id);
    return row;
  }

  /** Re-reads a workspace already proven visible, locked for a state change. */
  private async lock(tx: Transaction, id: string): Promise<WorkspaceRow> {
    const [row] = await tx
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .for('update');
    if (!row) throw workspaceNotFound(id);
    return row;
  }

  private async insert(
    tx: Transaction,
    orgId: string,
    input: CreateWorkspaceDto,
  ): Promise<WorkspaceRow> {
    try {
      const [row] = await tx
        .insert(schema.workspaces)
        .values({ orgId, name: input.name, slug: input.slug, isDefault: false })
        .returning();
      return row!;
    } catch (error) {
      const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
      if (cause?.code === '23505' && cause.constraint === 'workspaces_org_slug_key') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
          message: 'A workspace with this slug already exists in the organization',
        });
      }
      throw error;
    }
  }
}

/** The selected organization, or `400` — every workspace and team route acts in one. */
export function requireOrganization(principal: AuthPrincipal): string {
  const orgId = principal.tenant.orgId;
  if (!orgId) {
    throw new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
      message: 'No organization context is established for this request',
    });
  }
  return orgId;
}

export function workspaceNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Workspace not found',
    logContext: { requestedWorkspaceId: id },
  });
}

function workspaceView(row: WorkspaceRow): WorkspaceView {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    slug: row.slug,
    status: row.status,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
