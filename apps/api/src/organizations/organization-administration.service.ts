import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  type AuditAction,
  type AuthPrincipal,
  type PageInfo,
  type TenantContext,
} from '@acc/contracts';
import { schema, tenantContextStatements, type TenantSession, type Transaction } from '@acc/db';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import { AuthorizationService } from '../auth/authorization.service';
import { organizationInactiveError, type OrganizationStatus } from '../auth/scope-resolver.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { TenantRoleProvisioner } from '../rbac/tenant-role-provisioner.service';
import type { CreateOrganizationDto, UpdateOrganizationDto } from './organization.dto';

/** The organization resource (`FRONTEND_API_CONTRACT.md` §31a). Exhaustive. */
export interface OrganizationView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly resellerId: string | null;
  readonly status: OrganizationStatus;
  readonly statusChangedAt: string | null;
  readonly billingMode: string;
  readonly billingPolicy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListOrganizationsFilter extends ListQueryInput {
  readonly status?: OrganizationStatus;
  readonly resellerId?: string;
}

type Transition = 'suspend' | 'reactivate' | 'close';

/** ADR-012 F-1: the only legal transitions. `closed` is terminal. */
const TRANSITIONS: Readonly<
  Record<
    Transition,
    { from: readonly OrganizationStatus[]; to: OrganizationStatus; action: AuditAction }
  >
> = {
  suspend: { from: ['active'], to: 'suspended', action: AUDIT_ACTIONS.ORGANIZATION_SUSPENDED },
  reactivate: { from: ['suspended'], to: 'active', action: AUDIT_ACTIONS.ORGANIZATION_REACTIVATED },
  close: { from: ['active', 'suspended'], to: 'closed', action: AUDIT_ACTIONS.ORGANIZATION_CLOSED },
};

/** The default workspace every organization is created with (ADR-012 F-3). */
const DEFAULT_WORKSPACE = { name: 'Default', slug: 'default' } as const;

/**
 * Organization administration and lifecycle (Phase 1C.1a, ADR-012).
 *
 * **Addressing an organization by id is not selecting it.** These routes carry
 * no `X-Acc-Organization`; the organization is named in the path, and whether
 * the caller may act on it is decided here, from grants, exactly as selection
 * would: a platform-grant holder may address any organization; anyone else only
 * one it is connected to and that is `active` — a connected principal naming a
 * suspended or closed one is told so (ADR-012 F-4), and everyone else gets a
 * `404` indistinguishable from an id that was never issued. The transaction then
 * runs with that organization as its tenant context, so RLS and the scope-chain
 * resolver see exactly what they would for a selected organization, and the
 * authorization decision itself is the ordinary `AuthorizationService.assert`.
 *
 * **Status is authorization, not RLS** (ADR-012 OD-3). Nothing here adds a
 * status term to any policy.
 */
@Injectable()
export class OrganizationAdministrationService {
  private readonly logger = new Logger(OrganizationAdministrationService.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly provisioner: TenantRoleProvisioner,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.organizations.name, encode: (row) => String(row.name) },
      createdAt: { column: schema.organizations.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.organizations.id,
  };

  // --- reads -------------------------------------------------------------------

  /**
   * The organizations the caller may read (ADR-012; `FRONTEND_API_CONTRACT.md`
   * §31a): every organization for a platform-grant holder whose grant carries
   * `organizations.read`; every organization beneath a reseller the caller holds
   * `organizations.read` at; and, for any other grant carrying it, that grant's
   * organization while it is `active`.
   *
   * **Two stages, so RLS remains a backstop.** A single RLS context expresses
   * one organization and one reseller claim, and a support principal is
   * deliberately not an RLS platform administrator (ADR-011 D-2), so no one
   * `acc_app` context can show a principal every organization it may list.
   *
   *   1. *Candidates* — the identity principal (`acc_auth`) evaluates the
   *      grant-derived reach, the `status`/`resellerId` narrowing and the signed
   *      cursor, and returns only ids and sort keys. Pagination (`limit + 1`,
   *      `hasMore`, `nextCursor`) is decided here, exactly as before.
   *   2. *Rows* — the page's rows are read as `acc_app` under RLS, under contexts
   *      the caller legitimately holds and that do not come from stage 1 (see
   *      `fetchUnderRls`).
   *
   * A candidate RLS withholds means the reach admitted an organization the
   * caller holds no context for — an authorization defect. The request fails
   * closed rather than returning a partial page: the cursor carries the last
   * row's sort key and id, so a page anchored on a withheld row would disclose
   * it, and a page silently shorter than its candidates would change `hasMore`
   * semantics.
   */
  async list(
    principal: ResolvedPrincipal,
    filter: ListOrganizationsFilter = {},
  ): Promise<{ items: readonly OrganizationView[]; page: PageInfo }> {
    RequestContext.recordAuthorizationCheck(PERMISSIONS.ORGANIZATIONS_READ);
    const reach = this.readReach(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const predicates: SQL[] = [];
    if (!reach.everything) {
      const arms: SQL[] = [];
      if (reach.resellerIds.length > 0) {
        arms.push(inArray(schema.organizations.resellerId, reach.resellerIds));
      }
      if (reach.activeOrganizationIds.length > 0) {
        arms.push(
          and(
            inArray(schema.organizations.id, reach.activeOrganizationIds),
            eq(schema.organizations.status, 'active'),
          )!,
        );
      }
      // No reach at all is an empty page, produced by the same query path so the
      // page metadata is shaped exactly as for any other result.
      predicates.push(arms.length > 0 ? or(...arms)! : sql`false`);
    }
    if (filter.status) predicates.push(eq(schema.organizations.status, filter.status));
    if (filter.resellerId) predicates.push(eq(schema.organizations.resellerId, filter.resellerId));
    if (resolved.after) predicates.push(resolved.after);

    // Stage 1: ids and sort keys only — no tenant row content leaves `acc_auth`.
    const candidates = await this.db.auth
      .select({ id: schema.organizations.id, name: schema.organizations.name })
      .from(schema.organizations)
      .where(predicates.length > 0 ? and(...predicates) : undefined)
      .orderBy(...resolved.orderBy)
      .limit(this.lists.fetchSize(resolved));

    const { items, page } = this.lists.paginate(candidates, resolved, this.listSpec, (row) =>
      String(row.id),
    );

    // Stage 2: the rows themselves, under RLS.
    const ids = items.map((row) => row.id);
    const rows = await this.fetchUnderRls(principal, ids);
    const withheld = ids.filter((id) => !rows.has(id));
    if (withheld.length > 0) {
      this.logger.error(
        `organization list: RLS withheld ${withheld.length} of ${ids.length} candidate(s) the authorization reach admitted`,
      );
      throw new AppException({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'The organization list could not be produced',
        logContext: { withheldOrganizationIds: withheld },
      });
    }
    return { items: ids.map((id) => this.view(rows.get(id)!)), page };
  }

  async get(principal: ResolvedPrincipal, id: string): Promise<OrganizationView> {
    const addressed = await this.address(principal, id);
    return this.db.withTenant(addressed.session, async (tx) => {
      await this.authorization.assert(tx, {
        principal: addressed.actor,
        permission: PERMISSIONS.ORGANIZATIONS_READ,
        target: { scopeType: 'organization', scopeId: id },
        resourceType: 'Organization',
      });
      return this.load(tx, id);
    });
  }

  // --- creation ------------------------------------------------------------------

  /**
   * Creates an organization with its system roles and default workspace, in one
   * transaction (ADR-012 F-3).
   *
   * Authority, decided from grants and never from the body:
   *   - `platform.tenants.manage` at `platform` — any reseller, defaulting to
   *     the platform-default reseller; the creator must also hold
   *     `organizations.create` covering that reseller (a super admin does);
   *   - otherwise `organizations.create` held **at** the target reseller — a
   *     reseller administrator beneath its own reseller only.
   * `resellerId` in the body is a target; asserting coverage of it is what
   * refuses a reseller administrator naming another reseller (which it cannot
   * even see: `404`). Billing fields additionally require
   * `platform.tenants.manage`.
   *
   * Order inside the transaction: authorize under the caller's own context →
   * replay if the idempotency key was already used → elevate to the
   * provisioning context for exactly the new organization → insert the
   * organization → seed its system roles → create its default workspace →
   * audit. Any failure rolls all of it back.
   */
  async create(
    principal: ResolvedPrincipal,
    input: CreateOrganizationDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: OrganizationView }>> {
    if (principal.actorType !== 'user' || !principal.userId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'Organizations can only be created by a signed-in user',
      });
    }
    this.requireAttributableActor(principal);

    const platformMode = this.holdsAtPlatform(principal, PERMISSIONS.PLATFORM_TENANTS_MANAGE);
    const heldResellers = this.resellersHolding(principal, PERMISSIONS.ORGANIZATIONS_CREATE);
    const wantsBilling = input.billingMode !== undefined || input.billingPolicy !== undefined;

    let target = input.resellerId ?? null;
    if (!target && !platformMode) {
      if (heldResellers.length === 1) target = heldResellers[0]!;
      else if (heldResellers.length > 1) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
          message: 'You administer more than one reseller; specify resellerId',
        });
      }
    }

    // Authorization runs under the actor's own resolved context — exactly what
    // any request would carry — plus a reseller claim only for a reseller the
    // actor genuinely administers. The target is evaluated against that, so a
    // reseller the actor cannot see is a `404` and one it can see but does not
    // cover is an audited `403`.
    const authSession: TenantSession = {
      orgId: principal.tenant.orgId,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
      resellerId: target && heldResellers.includes(target) ? target : null,
    };

    return this.db.withTenant(authSession, async (tx) => {
      // With no reseller named or implied by a reseller grant, the only way to
      // create is platform authority: asserting it is what refuses (and audits)
      // an organization administrator or a support principal here.
      const needsPlatform = platformMode || wantsBilling || !target;
      if (needsPlatform) {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
          target: { scopeType: 'platform', scopeId: null },
          resourceType: 'Organization',
        });
      }
      if (!target) target = await this.platformDefaultReseller(tx);
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.ORGANIZATIONS_CREATE,
        target: { scopeType: 'reseller', scopeId: target },
        resourceType: 'Reseller',
      });

      const resellerId = target;
      return this.idempotency.executeOrganizationCreation(tx, {
        key: idempotencyKey,
        successStatus: HttpStatus.CREATED,
        request: {
          method: 'POST',
          route: '/organizations',
          orgId: null,
          principal,
          pathParams: {},
          query: {},
          body: input,
        },
        work: async (work) => {
          const orgId = uuidv7();
          // Elevate to the provisioning context for exactly this organization:
          // `organizations_insert` admits the one row whose id is in context,
          // and the system-role guard admits seeding under it. Nothing else is
          // widened, and the caller's own claims are carried unchanged.
          for (const statement of tenantContextStatements({
            ...authSession,
            orgId,
            provisioning: true,
          })) {
            await work.execute(statement);
          }
          const view = await this.insertOrganization(work, orgId, resellerId, input);
          await this.provisioner.seedTenantRoles(work, orgId);
          await this.createDefaultWorkspace(work, principal, orgId);
          await this.audit.record(
            {
              scopeType: 'organization',
              scopeId: orgId,
              ...actorFromPrincipal(principal),
              action: AUDIT_ACTIONS.ORGANIZATION_CREATED,
              resourceType: 'Organization',
              resourceId: orgId,
              outcome: 'success',
              before: null,
              after: { ...view },
              metadata: { resellerId, via: platformMode ? 'platform' : 'reseller' },
            },
            work,
          );
          return { body: { data: view }, orgId };
        },
      });
    });
  }

  /**
   * The default workspace (ADR-012 F-3), in the creation transaction. A
   * separate method so its failure path can be exercised directly.
   */
  async createDefaultWorkspace(
    tx: Transaction,
    principal: AuthPrincipal,
    orgId: string,
  ): Promise<string> {
    const [workspace] = await tx
      .insert(schema.workspaces)
      .values({
        orgId,
        name: DEFAULT_WORKSPACE.name,
        slug: DEFAULT_WORKSPACE.slug,
        isDefault: true,
      })
      .returning({ id: schema.workspaces.id });
    if (!workspace)
      throw new Error('organization creation: default workspace insert returned no row');
    await this.audit.record(
      {
        scopeType: 'workspace',
        scopeId: workspace.id,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.WORKSPACE_CREATED,
        resourceType: 'Workspace',
        resourceId: workspace.id,
        outcome: 'success',
        before: null,
        after: { orgId, ...DEFAULT_WORKSPACE, isDefault: true },
        metadata: { reason: 'organization_default' },
      },
      tx,
    );
    return workspace.id;
  }

  // --- update ----------------------------------------------------------------------

  /**
   * Updates the mutable fields (ADR-012 F-8): `name`, `legalName`, `gstin`, and —
   * with `platform.tenants.manage` — `billingMode` and `billingPolicy`. A
   * non-active organization is refused for everyone (F-5).
   */
  async update(
    principal: ResolvedPrincipal,
    id: string,
    input: UpdateOrganizationDto,
  ): Promise<OrganizationView> {
    const addressed = await this.address(principal, id);
    return this.db.withTenant(addressed.session, async (tx) => {
      await this.authorization.assert(tx, {
        principal: addressed.actor,
        permission: PERMISSIONS.ORGANIZATIONS_UPDATE,
        target: { scopeType: 'organization', scopeId: id },
        resourceType: 'Organization',
      });
      if (input.billingMode !== undefined || input.billingPolicy !== undefined) {
        await this.authorization.assert(tx, {
          principal: addressed.actor,
          permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
          target: { scopeType: 'platform', scopeId: null },
          resourceType: 'Organization',
        });
      }

      const before = await this.load(tx, id, { forUpdate: true });
      if (before.status !== 'active') throw this.lifecycleConflict(before.status);

      const changes: Partial<typeof schema.organizations.$inferInsert> = {};
      if (input.name !== undefined) changes.name = input.name;
      if (input.legalName !== undefined) changes.legalName = input.legalName;
      if (input.gstin !== undefined) changes.gstin = input.gstin;
      if (input.billingMode !== undefined) changes.billingMode = input.billingMode;
      if (input.billingPolicy !== undefined) changes.billingPolicy = input.billingPolicy;
      if (Object.keys(changes).length === 0) return before;

      const [row] = await tx
        .update(schema.organizations)
        .set(changes)
        .where(eq(schema.organizations.id, id))
        .returning();
      const after = this.view(row!);

      const changed = Object.keys(changes) as (keyof OrganizationView)[];
      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: id,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
          resourceType: 'Organization',
          resourceId: id,
          outcome: 'success',
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          after: Object.fromEntries(changed.map((k) => [k, after[k]])),
          metadata: {},
        },
        tx,
      );
      return after;
    });
  }

  // --- lifecycle ---------------------------------------------------------------------

  /**
   * `suspend`, `reactivate` or `close` (ADR-012 F-1, F-2): `platform.tenants.manage`
   * at `platform` only, a signed-in user only, as one conditional `UPDATE` — two
   * concurrent transitions cannot both succeed, and an illegal one changes
   * nothing. Closing deletes nothing (OD-12).
   */
  async transition(
    principal: ResolvedPrincipal,
    id: string,
    transition: Transition,
    reason: string | null,
  ): Promise<OrganizationView> {
    if (principal.actorType !== 'user') {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'Organization lifecycle changes require a signed-in platform administrator',
      });
    }
    const rule = TRANSITIONS[transition];
    const addressed = await this.address(principal, id);

    return this.db.withTenant(addressed.session, async (tx) => {
      await this.authorization.assert(tx, {
        principal: addressed.actor,
        permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
        target: { scopeType: 'platform', scopeId: null },
        resourceType: 'Organization',
      });

      const [row] = await tx
        .update(schema.organizations)
        .set({ status: rule.to, statusChangedAt: new Date(), statusReason: reason })
        .where(
          and(
            eq(schema.organizations.id, id),
            inArray(schema.organizations.status, [...rule.from]),
          ),
        )
        .returning();

      if (!row) {
        const current = await this.load(tx, id);
        throw this.lifecycleConflict(current.status);
      }

      const after = this.view(row);
      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: id,
          ...actorFromPrincipal(principal),
          action: rule.action,
          resourceType: 'Organization',
          resourceId: id,
          outcome: 'success',
          before: { status: rule.from.length === 1 ? rule.from[0] : 'active|suspended' },
          after: { status: after.status },
          metadata: reason ? { reason } : {},
        },
        tx,
      );
      return after;
    });
  }

  // --- internals ---------------------------------------------------------------------

  /**
   * Resolves the context for acting on organization `id`, exactly as selecting
   * it would (see the class comment). Returns the tenant session for the
   * transaction and the principal as it stands in that organization — the
   * latter is what attributes an `authorization.denied` row to the organization
   * the caller addressed, which it is connected to (or, as a platform-grant
   * holder, may select).
   */
  private async address(
    principal: ResolvedPrincipal,
    id: string,
  ): Promise<{ session: TenantSession; actor: AuthPrincipal }> {
    const [org] = await this.db.auth
      .select({ resellerId: schema.organizations.resellerId })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, id));
    if (!org) throw this.notFound(id);

    const platformGrant = principal.roles.some((g) => g.scopeType === 'platform');
    if (!platformGrant) {
      const inactive = principal.inactiveOrganizations[id];
      if (inactive) throw organizationInactiveError(id, inactive);
      if (!principal.authorizedOrganizationIds.includes(id)) throw this.notFound(id);
    }

    const heldResellers = principal.roles
      .filter((g) => g.scopeType === 'reseller' && g.scopeId)
      .map((g) => g.scopeId!);
    const tenant: TenantContext = {
      orgId: id,
      workspaceId: null,
      resellerId: org.resellerId && heldResellers.includes(org.resellerId) ? org.resellerId : null,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
    };
    return {
      session: { ...tenant, userId: principal.userId },
      actor: { ...principal, tenant },
    };
  }

  /**
   * A refusal on the creation route is audited at the actor's own resolved
   * scope; with none resolved (a principal holding several organizations and
   * naming none, and neither a platform administrator nor a reseller
   * administrator), there is nothing honest to attribute it to. Such a
   * principal cannot create an organization in any case, so it is refused
   * before any target is evaluated.
   */
  private requireAttributableActor(principal: ResolvedPrincipal): void {
    const { orgId, resellerId, isPlatformAdmin } = principal.tenant;
    if (orgId || resellerId || isPlatformAdmin) return;
    throw new AppException({
      status: HttpStatus.FORBIDDEN,
      code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
      message:
        'Creating an organization requires platform or reseller administration; to have a refusal attributed, select an organization with X-Acc-Organization',
    });
  }

  private readReach(principal: ResolvedPrincipal): {
    everything: boolean;
    resellerIds: string[];
    activeOrganizationIds: string[];
  } {
    const carrying = principal.roles.filter((g) =>
      g.permissions.includes(PERMISSIONS.ORGANIZATIONS_READ),
    );
    if (carrying.some((g) => g.scopeType === 'platform')) {
      return { everything: true, resellerIds: [], activeOrganizationIds: [] };
    }
    const resellerIds = [
      ...new Set(
        carrying.filter((g) => g.scopeType === 'reseller' && g.scopeId).map((g) => g.scopeId!),
      ),
    ];
    const activeOrganizationIds = [
      ...new Set(
        carrying
          .filter((g) => g.scopeType === 'organization' && g.orgId)
          .map((g) => g.orgId!)
          .filter((orgId) => principal.authorizedOrganizationIds.includes(orgId)),
      ),
    ];
    return { everything: false, resellerIds, activeOrganizationIds };
  }

  /**
   * Stage 2 of `list`: reads organizations `ids` as `acc_app`, under each RLS
   * context the caller legitimately holds, in one transaction. Every context is
   * derived from the principal's own grants — never from the stage-1 reach, the
   * request, or the organizations being read — and every claim is one the
   * database itself validates (migration `0010`):
   *
   *   - the platform-administrator claim, for a validated super admin;
   *   - a reseller claim per reseller-scope grant the user holds;
   *   - an organization context per id in `authorizedOrganizationIds` — the set
   *     `ScopeResolver` lets this caller select with `X-Acc-Organization`, which
   *     for a support principal is every organization (its selection right).
   *
   * Each context is applied only to the ids not yet read, so a caller with
   * broader authority pays for one query. Returns what RLS admitted.
   */
  private async fetchUnderRls(
    principal: ResolvedPrincipal,
    ids: readonly string[],
  ): Promise<Map<string, typeof schema.organizations.$inferSelect>> {
    const found = new Map<string, typeof schema.organizations.$inferSelect>();
    if (ids.length === 0) return found;

    const base: TenantSession = {
      orgId: null,
      workspaceId: null,
      resellerId: null,
      userId: principal.userId,
      isPlatformAdmin: false,
    };
    const pending = () => ids.filter((id) => !found.has(id));
    const heldResellers = [
      ...new Set(
        principal.roles
          .filter((g) => g.scopeType === 'reseller' && g.scopeId)
          .map((g) => g.scopeId!),
      ),
    ];

    await this.db.withTenant(base, async (tx) => {
      const read = async (session: TenantSession, wanted: readonly string[]) => {
        for (const statement of tenantContextStatements(session)) await tx.execute(statement);
        const rows = await tx
          .select()
          .from(schema.organizations)
          .where(inArray(schema.organizations.id, [...wanted]));
        for (const row of rows) found.set(row.id, row);
      };

      if (principal.tenant.isPlatformAdmin) await read({ ...base, isPlatformAdmin: true }, ids);
      for (const resellerId of heldResellers) {
        const wanted = pending();
        if (wanted.length === 0) break;
        await read({ ...base, resellerId }, wanted);
      }
      for (const orgId of pending()) {
        if (principal.authorizedOrganizationIds.includes(orgId)) {
          await read({ ...base, orgId }, [orgId]);
        }
      }
    });
    return found;
  }

  private holdsAtPlatform(principal: AuthPrincipal, permission: string): boolean {
    return principal.roles.some(
      (g) => g.scopeType === 'platform' && g.permissions.includes(permission),
    );
  }

  private resellersHolding(principal: AuthPrincipal, permission: string): string[] {
    return [
      ...new Set(
        principal.roles
          .filter(
            (g) => g.scopeType === 'reseller' && g.scopeId && g.permissions.includes(permission),
          )
          .map((g) => g.scopeId!),
      ),
    ];
  }

  private async platformDefaultReseller(tx: Transaction): Promise<string> {
    const [row] = await tx
      .select({ id: schema.resellers.id })
      .from(schema.resellers)
      .where(eq(schema.resellers.isPlatformDefault, true));
    if (!row) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'resellerId is required',
      });
    }
    return row.id;
  }

  private async insertOrganization(
    tx: Transaction,
    id: string,
    resellerId: string,
    input: CreateOrganizationDto,
  ): Promise<OrganizationView> {
    try {
      const [row] = await tx
        .insert(schema.organizations)
        .values({
          id,
          resellerId,
          name: input.name,
          slug: input.slug,
          legalName: input.legalName ?? null,
          gstin: input.gstin ?? null,
          ...(input.billingMode ? { billingMode: input.billingMode } : {}),
          ...(input.billingPolicy ? { billingPolicy: input.billingPolicy } : {}),
        })
        .returning();
      return this.view(row!);
    } catch (error) {
      const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
      if (cause?.code === '23505' && cause.constraint === 'organizations_slug_key') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
          message: 'An organization with this slug already exists',
        });
      }
      throw error;
    }
  }

  private async load(
    tx: Transaction,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<OrganizationView> {
    const query = tx.select().from(schema.organizations).where(eq(schema.organizations.id, id));
    const [row] = options.forUpdate ? await query.for('update') : await query;
    if (!row) throw this.notFound(id);
    return this.view(row);
  }

  private view(row: typeof schema.organizations.$inferSelect): OrganizationView {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      legalName: row.legalName ?? null,
      gstin: row.gstin ?? null,
      resellerId: row.resellerId ?? null,
      status: row.status,
      statusChangedAt: row.statusChangedAt ? row.statusChangedAt.toISOString() : null,
      billingMode: row.billingMode,
      billingPolicy: row.billingPolicy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private lifecycleConflict(status: OrganizationStatus): AppException {
    return new AppException({
      status: HttpStatus.CONFLICT,
      code: ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT,
      message: `This organization is ${status}; the operation is not permitted in that state`,
      // The caller can already read the status (`GET /organizations/:id`), so
      // naming it discloses nothing and makes the refusal actionable.
      details: { status },
    });
  }

  private notFound(id: string): AppException {
    return new AppException({
      status: HttpStatus.NOT_FOUND,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: 'Organization not found',
      logContext: { requestedOrganizationId: id },
    });
  }
}
