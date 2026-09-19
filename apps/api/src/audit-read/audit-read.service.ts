import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type ActorType,
  type AuditOutcome,
  type AuthPrincipal,
  type PageInfo,
  type ScopeRef,
  type ScopeType,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, gte, inArray, lt, ne, or, type SQL } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { AuthorizationService } from '../auth/authorization.service';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';

/**
 * An audit record as the read API presents it.
 *
 * The shape mirrors the row because an audit trail's value is its fidelity: a
 * read that summarised or reshaped it would be a second account of what
 * happened, and reconciling two accounts during an incident is exactly the work
 * an audit log exists to remove.
 *
 * `before`, `after` and `metadata` are returned **as stored**. They were passed
 * through the central redactor at write time (`SECURITY.md` §4), which is the
 * single redaction boundary; re-redacting here would be a second redactor and
 * the two would eventually disagree. What is *not* returned is anything the
 * table does not hold: there is no credential column on `audit_logs` to leak.
 */
export interface AuditLogView {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: AuditOutcome;

  readonly actorType: ActorType;
  readonly actorUserId: string | null;
  readonly actorApiKeyId: string | null;
  readonly actorLabel: string | null;

  readonly resourceType: string;
  readonly resourceId: string | null;

  /** Where the action happened, and the derived ancestry of that scope. */
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
  readonly resellerId: string | null;
  readonly orgId: string | null;
  readonly workspaceId: string | null;
  readonly teamId: string | null;

  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown>;

  readonly correlationId: string;
  readonly causationId: string | null;

  /**
   * Where the action came from. Personal data, deliberately included: an audit
   * trail that cannot say where a privilege change originated answers half the
   * question an investigation asks. Access is gated by `audit.read`, which is an
   * administrative permission (`SECURITY.md` §4a).
   */
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** Allow-listed filters for `GET /audit-logs` (`API.md` §8b). */
export interface ListAuditLogsFilter extends ListQueryInput {
  readonly action?: string;
  readonly actorType?: ActorType;
  readonly actorUserId?: string;
  readonly outcome?: AuditOutcome;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly scopeType?: ScopeType;
  readonly scopeId?: string;
  readonly correlationId?: string;
  readonly occurredFrom?: Date;
  readonly occurredTo?: Date;
}

/**
 * Audit read (Phase 1B.6.3, `API.md` §3f, `SECURITY.md` §4a).
 *
 * The last surface of the Phase 1B control plane, and the only one that reads a
 * table nothing may write through the API. It adds no audit machinery: the
 * writer, the redactor, the append-only triggers and the scope-derivation
 * trigger are all unchanged and unreferenced here.
 *
 * ---
 *
 * **Visibility is the policy's, not this service's.** `audit_logs_select`
 * (migration `0001`) already expresses exactly the four-way answer this endpoint
 * needs, and it expresses it in the database:
 *
 *     platform admin                          → every row
 *     org rows where `app_org_in_scope`       → the caller's organizations, and
 *                                               for a reseller admin, every
 *                                               organization beneath its reseller
 *     reseller rows for the current reseller  → the reseller's own trail
 *     everything else                         → invisible
 *
 * So the list query carries **no tenant predicate of its own**. That is the same
 * choice `/roles`, `/role-assignments` and `/api-keys` make, and it is the safer
 * one here for a reason specific to audit: a hand-written `org_id = :current`
 * would be narrower than the policy, and would silently hide reseller-scoped
 * rows from the reseller administrator they belong to. Filters narrow inside
 * what the policy allows; they never define it.
 *
 * **Detail authorizes at the row's own scope.** Not at the request's
 * organization — a row recorded at a workspace belongs to that workspace, and an
 * actor who covers the organization but not that workspace should not read it
 * because it happens to share a tenant. The scope comes from the row.
 *
 * **Nothing here is writable.** `acc_app` holds `SELECT, INSERT` on `audit_logs`
 * and no `UPDATE`, `DELETE` or `TRUNCATE` (migration `0001`), so this service
 * could not mutate the trail even if it tried to.
 */
@Injectable()
export class AuditReadService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly lists: ListQuery,
  ) {}

  /**
   * The ordering contract (`API.md` §8b).
   *
   * Newest first, and **only** newest first: an audit trail is read
   * chronologically, and every other dimension this endpoint offers is a filter
   * rather than an order. Offering `action` or `actorType` as sorts would add
   * index requirements and cursor surface for an ordering nobody investigates
   * by.
   *
   * Chronological ordering runs on `id`, not `occurred_at`. Both are assigned by
   * the same INSERT — `occurred_at` defaults to `now()` and `id` to `uuidv7()` —
   * so they are co-monotonic, and `id` is the one that survives a text cursor
   * exactly. A `timestamptz` round-tripped through JavaScript loses the
   * database's sub-millisecond precision, which would land the boundary before
   * the row it was minted from and repeat the page forever.
   */
  private readonly listSpec: ListQuerySpec = {
    sortable: {
      occurredAt: { column: schema.auditLogs.id, encode: (row) => String(row.id) },
    },
    defaultSort: '-occurredAt',
    tieBreaker: schema.auditLogs.id,
  };

  async list(
    tx: Transaction,
    principal: AuthPrincipal,
    filter: ListAuditLogsFilter = {},
  ): Promise<{ items: readonly AuditLogView[]; page: PageInfo }> {
    const orgId = this.requireOrg(principal);

    // Authorized at the caller's own organization: the question this endpoint
    // asks is "may you read an audit trail here at all", and which rows that
    // turns out to mean is the policy's answer, not this check's.
    await this.authorization.assert(tx, {
      principal,
      permission: 'audit.read',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'Audit log',
    });

    const resolved = this.lists.resolve(filter, this.listSpec);
    const predicates = this.filterPredicates(filter);

    // Reseller rows are admitted only to a principal that genuinely occupies
    // that reseller — the same question `get` asks through the authorization
    // boundary, asked once for the page instead of once per row.
    const resellerVisibility = this.resellerVisibilityPredicate(principal);
    if (resellerVisibility) predicates.push(resellerVisibility);

    if (resolved.after) predicates.push(resolved.after);

    const rows = await tx
      .select(this.columns())
      .from(schema.auditLogs)
      .where(predicates.length > 0 ? and(...predicates) : undefined)
      .orderBy(...resolved.orderBy)
      .limit(this.lists.fetchSize(resolved));

    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.listSpec,
      (row) => String(row.id),
    );

    return { items: items.map((row) => this.view(row as never)), page };
  }

  /**
   * One record, authorized against the scope it was recorded at.
   *
   * The row is loaded first, under RLS, so a record in another tenant is
   * invisible and answers `404` — indistinguishable from an id that was never
   * issued, and never a `403` that would confirm the record exists somewhere.
   */
  async get(tx: Transaction, principal: AuthPrincipal, id: string): Promise<AuditLogView> {
    this.requireOrg(principal);
    const row = await this.loadVisible(tx, id);

    await this.authorization.assert(tx, {
      principal,
      permission: 'audit.read',
      target: this.recordedScopeOf(row),
      resourceType: 'Audit log',
    });

    return this.view(row);
  }

  // --- internals ---------------------------------------------------------------

  private requireOrg(principal: AuthPrincipal): string {
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

  /**
   * Which reseller-scoped rows this principal may see, if any.
   *
   * **This closes a real inconsistency rather than adding defence in depth.**
   * `audit_logs_select`'s third arm admits a reseller row when
   * `reseller_id = app_current_reseller_id()`, and its comment reads "reseller
   * rows belong to the reseller context". But that session variable is set from
   * `TenantContext.resellerId`, which `ScopeResolver.tenantContextFor` derives
   * for **every** principal from the selected organization's reseller — not only
   * for one holding a reseller-scope grant. So an ordinary organization
   * administrator satisfied the policy for its own reseller's rows.
   *
   * The detail route was never affected: it authorizes at the row's recorded
   * `{reseller, resellerId}`, which an organization-scope grant cannot cover
   * (`SCOPE_DEPTH.organization > SCOPE_DEPTH.reseller` — nothing reaches
   * upward). The list had no per-row equivalent, so the two surfaces disagreed
   * about the same row, and the list was the permissive one. A list that is
   * broader than the detail route it links to is the defect; this makes them
   * agree.
   *
   * **`TenantContext.resellerId` is deliberately not consulted here.** It
   * identifies the reseller the selected organization belongs to, which is
   * exactly the value that was too broad. Authorization to read a reseller's own
   * trail comes from holding a grant **at** `reseller` scope, so the predicate
   * is built from `principal.roles` — the grants themselves, the same source
   * `ScopeResolver` derives its reseller set from.
   *
   * This is a *visibility* narrowing, not a second authorization model: it
   * decides which rows a page may contain, while
   * `AuthorizationService.assert` remains the authoritative decision for the
   * endpoint and for every individual record fetched through `get`. The
   * flattened `principal.permissions` is not read, and neither is any
   * caller-supplied identifier.
   *
   * Returns `undefined` for a platform administrator, whose policy arm already
   * admits every row and for whom narrowing would remove the platform
   * operations view.
   */
  private resellerVisibilityPredicate(principal: AuthPrincipal): SQL | undefined {
    if (principal.tenant.isPlatformAdmin) return undefined;

    // Grants held **at** reseller scope. An API-key principal carries exactly
    // one synthesized grant at its binding scope, which is organization or
    // workspace and never reseller (`RBAC.md` §5c) — so a key resolves to an
    // empty set here and sees no reseller rows, which is the correct answer for
    // a credential that cannot be bound above an organization.
    const held = [
      ...new Set(
        principal.roles
          .filter((grant) => grant.scopeType === 'reseller' && grant.scopeId)
          .map((grant) => grant.scopeId!),
      ),
    ];

    const notAResellerRow = ne(schema.auditLogs.scopeType, 'reseller');
    if (held.length === 0) return notAResellerRow;

    return or(notAResellerRow, inArray(schema.auditLogs.resellerId, held))!;
  }

  /**
   * Allow-listed filters, each an equality or a bounded range.
   *
   * No operator syntax, no free text, no column names from the caller — a client
   * names a key this endpoint publishes and nothing else reaches SQL as an
   * identifier.
   */
  private filterPredicates(filter: ListAuditLogsFilter): SQL[] {
    const predicates: SQL[] = [];
    if (filter.action) predicates.push(eq(schema.auditLogs.action, filter.action));
    if (filter.actorType) predicates.push(eq(schema.auditLogs.actorType, filter.actorType));
    if (filter.actorUserId) predicates.push(eq(schema.auditLogs.actorUserId, filter.actorUserId));
    if (filter.outcome) predicates.push(eq(schema.auditLogs.outcome, filter.outcome));
    if (filter.resourceType) {
      predicates.push(eq(schema.auditLogs.resourceType, filter.resourceType));
    }
    if (filter.resourceId) predicates.push(eq(schema.auditLogs.resourceId, filter.resourceId));
    if (filter.scopeType) predicates.push(eq(schema.auditLogs.scopeType, filter.scopeType));
    if (filter.scopeId) predicates.push(eq(schema.auditLogs.scopeId, filter.scopeId));
    if (filter.correlationId) {
      predicates.push(eq(schema.auditLogs.correlationId, filter.correlationId));
    }
    // Half-open [from, to): inclusive lower, exclusive upper, so consecutive
    // windows tile without double-counting a row on the boundary.
    if (filter.occurredFrom) predicates.push(gte(schema.auditLogs.occurredAt, filter.occurredFrom));
    if (filter.occurredTo) predicates.push(lt(schema.auditLogs.occurredAt, filter.occurredTo));
    return predicates;
  }

  private async loadVisible(tx: Transaction, id: string): Promise<AuditRow> {
    const [row] = await tx
      .select(this.columns())
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.id, id));

    if (!row) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Audit log not found',
        logContext: { requestedAuditLogId: id },
      });
    }
    return row as unknown as AuditRow;
  }

  /** The scope the row records, as an authorization target. Read from the row. */
  private recordedScopeOf(row: AuditRow): ScopeRef {
    return { scopeType: row.scopeType, scopeId: row.scopeId };
  }

  /**
   * The projection.
   *
   * Written out rather than `select()` for the same reason every other read
   * surface does it: an explicit column list is the thing that keeps a future
   * column out of the response by default. `audit_logs` holds no credential
   * material today, so this is a habit rather than a barrier here — but the
   * habit is what makes the barrier exist the day a column is added.
   */
  private columns() {
    return {
      id: schema.auditLogs.id,
      occurredAt: schema.auditLogs.occurredAt,
      action: schema.auditLogs.action,
      outcome: schema.auditLogs.outcome,
      actorType: schema.auditLogs.actorType,
      actorUserId: schema.auditLogs.actorUserId,
      actorApiKeyId: schema.auditLogs.actorApiKeyId,
      actorLabel: schema.auditLogs.actorLabel,
      resourceType: schema.auditLogs.resourceType,
      resourceId: schema.auditLogs.resourceId,
      scopeType: schema.auditLogs.scopeType,
      scopeId: schema.auditLogs.scopeId,
      resellerId: schema.auditLogs.resellerId,
      orgId: schema.auditLogs.orgId,
      workspaceId: schema.auditLogs.workspaceId,
      teamId: schema.auditLogs.teamId,
      before: schema.auditLogs.before,
      after: schema.auditLogs.after,
      metadata: schema.auditLogs.metadata,
      correlationId: schema.auditLogs.correlationId,
      causationId: schema.auditLogs.causationId,
      ip: schema.auditLogs.ip,
      userAgent: schema.auditLogs.userAgent,
    };
  }

  private view(row: AuditRow): AuditLogView {
    return {
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      action: row.action,
      outcome: row.outcome,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorApiKeyId: row.actorApiKeyId,
      actorLabel: row.actorLabel,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      resellerId: row.resellerId,
      orgId: row.orgId,
      workspaceId: row.workspaceId,
      teamId: row.teamId,
      before: (row.before as Record<string, unknown> | null) ?? null,
      after: (row.after as Record<string, unknown> | null) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      correlationId: row.correlationId,
      causationId: row.causationId,
      ip: row.ip,
      userAgent: row.userAgent,
    };
  }
}

interface AuditRow {
  id: string;
  occurredAt: Date;
  action: string;
  outcome: AuditOutcome;
  actorType: ActorType;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  actorLabel: string | null;
  resourceType: string;
  resourceId: string | null;
  scopeType: ScopeType;
  scopeId: string | null;
  resellerId: string | null;
  orgId: string | null;
  workspaceId: string | null;
  teamId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  correlationId: string;
  causationId: string | null;
  ip: string | null;
  userAgent: string | null;
}
