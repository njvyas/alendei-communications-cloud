import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
  type PageInfo,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, type SQL } from 'drizzle-orm';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import {
  assertOrganizationActive,
  assertScopeAcceptsNewMembers,
  teamLifecycleConflict,
  workspaceLifecycleConflict,
} from '../tenancy/scope-lifecycle';
import type { CreateTeamDto, ScopeStatus, UpdateTeamDto } from './workspace.dto';
import {
  requireOrganization,
  WorkspaceAdministrationService,
} from './workspace-administration.service';

/** The team resource (`FRONTEND_API_CONTRACT.md` §31c). Exhaustive. */
export interface TeamView {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: ScopeStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListTeamsFilter extends ListQueryInput {
  readonly workspaceId?: string;
  readonly status?: ScopeStatus;
}

type TeamRow = typeof schema.teams.$inferSelect;

/**
 * Team administration and lifecycle (Phase 1C.1b, ADR-012 F-6, OD-5).
 *
 * Same model as workspaces (see `WorkspaceAdministrationService`): every route
 * acts in the selected organization, under RLS; a team id is read pinned to that
 * organization; its ancestry — team → workspace → organization → reseller — is
 * read from the database by `AuthorizationService`, never from the request. A
 * team's `org_id` is taken from its workspace's row on creation, and the
 * composite foreign key `teams_workspace_org_fk` makes a team whose organization
 * disagrees with its workspace unrepresentable.
 *
 * **Visibility is `teams.read` covering the team**; anything else is a `404`.
 * There is no hard delete (OD-5).
 */
@Injectable()
export class TeamAdministrationService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly workspaces: WorkspaceAdministrationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.teams.name, encode: (row) => String(row.name) },
      createdAt: { column: schema.teams.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.teams.id,
  };

  // --- reads -------------------------------------------------------------------

  /**
   * Teams of the selected organization, or of one workspace in it. With
   * `workspaceId` the list is authorized at that workspace — which must be
   * visible to the caller (`404` otherwise) — so a workspace-scoped principal can
   * list its own workspace's teams; without it, at the organization.
   */
  async list(
    principal: AuthPrincipal,
    filter: ListTeamsFilter = {},
  ): Promise<{ items: readonly TeamView[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      const predicates: SQL[] = [eq(schema.teams.orgId, orgId)];
      if (filter.workspaceId) {
        await this.workspaces.loadVisible(tx, principal, filter.workspaceId);
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.TEAMS_READ,
          target: { scopeType: 'workspace', scopeId: filter.workspaceId },
          resourceType: 'Workspace',
        });
        predicates.push(eq(schema.teams.workspaceId, filter.workspaceId));
      } else {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.TEAMS_READ,
          target: { scopeType: 'organization', scopeId: orgId },
          resourceType: 'Organization',
        });
      }
      if (filter.status) predicates.push(eq(schema.teams.status, filter.status));
      if (resolved.after) predicates.push(resolved.after);
      return tx
        .select()
        .from(schema.teams)
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
    return { items: items.map((row) => teamView(row as never)), page };
  }

  async get(principal: AuthPrincipal, id: string): Promise<TeamView> {
    return this.db.withRequestTenant(async (tx) => {
      const row = await this.loadVisible(tx, principal, id);
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEAMS_READ,
        target: { scopeType: 'team', scopeId: id },
        resourceType: 'Team',
      });
      return teamView(row);
    });
  }

  // --- creation ------------------------------------------------------------------

  /**
   * Creates a team in `workspaceId` (`teams.create` at that workspace). The
   * workspace must be visible (`404`), active (`409 WORKSPACE_LIFECYCLE_CONFLICT`),
   * and in the selected organization; the team's organization is the
   * workspace's.
   */
  async create(
    principal: AuthPrincipal,
    input: CreateTeamDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: TeamView }>> {
    const orgId = requireOrganization(principal);
    const authorize = async (tx: Transaction) => {
      await this.workspaces.loadVisible(tx, principal, input.workspaceId);
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEAMS_CREATE,
        target: { scopeType: 'workspace', scopeId: input.workspaceId },
        resourceType: 'Workspace',
      });
    };

    return this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: '/teams',
        orgId,
        principal,
        pathParams: {},
        query: {},
        body: { workspaceId: input.workspaceId, name: input.name },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);
        await assertOrganizationActive(tx, orgId);
        // `FOR SHARE` on the workspace: serializes against archiving it.
        await assertScopeAcceptsNewMembers(tx, {
          scopeType: 'workspace',
          scopeId: input.workspaceId,
        });
        const workspace = await this.workspaces.loadVisible(tx, principal, input.workspaceId);
        const row = await this.insert(tx, workspace.orgId, workspace.id, input.name);
        const view = teamView(row);
        await this.audit.record(
          {
            scopeType: 'team',
            scopeId: view.id,
            ...actorFromPrincipal(principal),
            action: AUDIT_ACTIONS.TEAM_CREATED,
            resourceType: 'Team',
            resourceId: view.id,
            outcome: 'success',
            before: null,
            after: { orgId: view.orgId, workspaceId: view.workspaceId, name: view.name },
            metadata: {},
          },
          tx,
        );
        return { data: view };
      },
    });
  }

  // --- update ----------------------------------------------------------------------

  /** Renames a team (`teams.update` at the team). Archived: `409`. */
  async update(principal: AuthPrincipal, id: string, input: UpdateTeamDto): Promise<TeamView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.loadVisible(tx, principal, id);
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEAMS_UPDATE,
        target: { scopeType: 'team', scopeId: id },
        resourceType: 'Team',
      });
      await assertOrganizationActive(tx, requireOrganization(principal));
      const before = await this.lock(tx, id);
      if (before.status !== 'active') throw teamLifecycleConflict(before.status);
      if (input.name === undefined || input.name === before.name) return teamView(before);

      const row = await this.rename(tx, id, input.name);
      await this.audit.record(
        {
          scopeType: 'team',
          scopeId: id,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTIONS.TEAM_UPDATED,
          resourceType: 'Team',
          resourceId: id,
          outcome: 'success',
          before: { name: before.name },
          after: { name: row.name },
          metadata: {},
        },
        tx,
      );
      return teamView(row);
    });
  }

  // --- lifecycle ---------------------------------------------------------------------

  /** Archives a team (`teams.update` at its **workspace**). Already archived: `409`. */
  async archive(principal: AuthPrincipal, id: string): Promise<TeamView> {
    return this.transition(principal, id, 'archive');
  }

  /**
   * Restores a team (`teams.update` at its workspace). `409
   * TEAM_LIFECYCLE_CONFLICT` unless archived; `409 WORKSPACE_LIFECYCLE_CONFLICT`
   * if its workspace is archived.
   */
  async restore(principal: AuthPrincipal, id: string): Promise<TeamView> {
    return this.transition(principal, id, 'restore');
  }

  private async transition(
    principal: AuthPrincipal,
    id: string,
    kind: 'archive' | 'restore',
  ): Promise<TeamView> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      const visible = await this.loadVisible(tx, principal, id);
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEAMS_UPDATE,
        target: { scopeType: 'workspace', scopeId: visible.workspaceId },
        resourceType: 'Team',
      });
      await assertOrganizationActive(tx, orgId);

      if (kind === 'restore') {
        // Lock order organization → workspace → team, as everywhere else. The
        // workspace's `FOR SHARE` serializes against archiving it.
        const [workspace] = await tx
          .select({ status: schema.workspaces.status })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, visible.workspaceId))
          .for('share');
        const before = await this.lock(tx, id);
        if (before.status !== 'archived') throw teamLifecycleConflict(before.status);
        if (workspace && workspace.status !== 'active') {
          throw workspaceLifecycleConflict(workspace.status);
        }
      } else {
        const before = await this.lock(tx, id);
        if (before.status !== 'active') throw teamLifecycleConflict(before.status);
      }

      const from: ScopeStatus = kind === 'archive' ? 'active' : 'archived';
      const to: ScopeStatus = kind === 'archive' ? 'archived' : 'active';
      const [row] = await tx
        .update(schema.teams)
        .set({ status: to })
        .where(eq(schema.teams.id, id))
        .returning();
      await this.audit.record(
        {
          scopeType: 'team',
          scopeId: id,
          ...actorFromPrincipal(principal),
          action: kind === 'archive' ? AUDIT_ACTIONS.TEAM_ARCHIVED : AUDIT_ACTIONS.TEAM_RESTORED,
          resourceType: 'Team',
          resourceId: id,
          outcome: 'success',
          before: { status: from },
          after: { status: to },
          metadata: { workspaceId: row!.workspaceId },
        },
        tx,
      );
      return teamView(row!);
    });
  }

  // --- internals ---------------------------------------------------------------------

  /**
   * The team `id` as the caller may see it: in the selected organization,
   * visible under RLS, and covered by a grant carrying `teams.read`. Anything
   * else is the same `404`.
   */
  private async loadVisible(
    tx: Transaction,
    principal: AuthPrincipal,
    id: string,
  ): Promise<TeamRow> {
    const orgId = requireOrganization(principal);
    const [row] = await tx
      .select()
      .from(schema.teams)
      .where(and(eq(schema.teams.id, id), eq(schema.teams.orgId, orgId)));
    const visible =
      row !== undefined &&
      (await this.authorization.allows(tx, {
        principal,
        permission: PERMISSIONS.TEAMS_READ,
        target: { scopeType: 'team', scopeId: id },
      }));
    if (!visible) throw teamNotFound(id);
    return row;
  }

  private async lock(tx: Transaction, id: string): Promise<TeamRow> {
    const [row] = await tx.select().from(schema.teams).where(eq(schema.teams.id, id)).for('update');
    if (!row) throw teamNotFound(id);
    return row;
  }

  private async insert(
    tx: Transaction,
    orgId: string,
    workspaceId: string,
    name: string,
  ): Promise<TeamRow> {
    return this.nameConflictAware(async () => {
      const [row] = await tx.insert(schema.teams).values({ orgId, workspaceId, name }).returning();
      return row!;
    });
  }

  private async rename(tx: Transaction, id: string, name: string): Promise<TeamRow> {
    return this.nameConflictAware(async () => {
      const [row] = await tx
        .update(schema.teams)
        .set({ name })
        .where(eq(schema.teams.id, id))
        .returning();
      return row!;
    });
  }

  private async nameConflictAware(write: () => Promise<TeamRow>): Promise<TeamRow> {
    try {
      return await write();
    } catch (error) {
      const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
      if (cause?.code === '23505' && cause.constraint === 'teams_workspace_name_key') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
          message: 'A team with this name already exists in the workspace',
        });
      }
      throw error;
    }
  }
}

function teamNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Team not found',
    logContext: { requestedTeamId: id },
  });
}

function teamView(row: TeamRow): TeamView {
  return {
    id: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
