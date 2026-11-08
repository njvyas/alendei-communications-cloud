import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  type AuditAction,
  type AuthPrincipal,
  type PageInfo,
  type PermissionKey,
  type PricingAssignmentResponse,
  type PricingPlanDetailResponse,
  type PricingPlanResponse,
  type PricingPlanVersionResponse,
  type PricingPlanVersionSummaryResponse,
  type PricingRuleResponse,
  type PricingUnit,
  type ProviderCostRateResponse,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import type {
  ActivatePricingVersionDto,
  CreatePricingAssignmentDto,
  CreatePricingPlanDto,
  CreateProviderCostRateDto,
  ListPricingAssignmentsQueryDto,
  ListProviderCostRatesQueryDto,
  ReplacePricingRulesDto,
} from './pricing.dto';

const PLATFORM = { scopeType: 'platform', scopeId: null } as const;

type PlanRow = typeof schema.pricingPlans.$inferSelect;
type VersionRow = typeof schema.pricingPlanVersions.$inferSelect;
type CostRateRow = typeof schema.providerCostRates.$inferSelect;
type AssignmentRow = typeof schema.customerPricingAssignments.$inferSelect;

const unitOf = (channelCode: string): PricingUnit =>
  channelCode === 'sms' ? 'sms_segment' : 'message';

const planView = (r: PlanRow): PricingPlanResponse => ({
  id: r.id,
  name: r.name,
  description: r.description,
  createdAt: r.createdAt.toISOString(),
});

const versionSummary = (r: VersionRow): PricingPlanVersionSummaryResponse => ({
  id: r.id,
  planId: r.planId,
  versionNumber: r.versionNumber,
  status: r.status,
  effectiveFrom: r.effectiveFrom ? r.effectiveFrom.toISOString() : null,
  activatedAt: r.activatedAt ? r.activatedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
});

const assignmentView = (r: AssignmentRow): PricingAssignmentResponse => ({
  id: r.id,
  orgId: r.orgId,
  planId: r.planId,
  effectiveFrom: r.effectiveFrom.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

function notFound(resource: string, id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: `${resource} not found`,
    logContext: { resource, id },
  });
}

function invalid(message: string): AppException {
  return new AppException({
    status: HttpStatus.BAD_REQUEST,
    code: ERROR_CODES.VALIDATION_FAILED,
    message,
  });
}

function conflict(message: string): AppException {
  return new AppException({
    status: HttpStatus.CONFLICT,
    code: ERROR_CODES.RESOURCE_CONFLICT,
    message,
  });
}

/** The SQLSTATE of a database error, unwrapped from the query builder's wrapper. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  return undefined;
}

/**
 * Phase 7 PR 7-2 — the platform pricing catalogue (DECISIONS.md §1zi; Phase 7.2
 * handover, OD-P-1 to OD-P-3).
 *
 * Every operation is a platform-scope action: the principal must hold
 * `pricing.read` / `pricing.manage` at `{ scopeType: 'platform' }`, decided by
 * `AuthorizationService.assert` inside the request's transaction, and must be a
 * signed-in user (API keys are organization-bound and cannot hold platform
 * authority; the routes also accept user sessions only). Beneath that, RLS
 * admits only a transaction whose user holds a validated platform-scope grant
 * (`app_has_platform_scope()`, migration `0051`).
 *
 * The database owns every financial rule: versions freeze when activated, rules
 * change only on drafts, cost rates and assignments are append-only, and no
 * effective date may be in the past. This service checks first so a caller gets
 * a named refusal, and maps the database's refusal when a race beats the check.
 * It never rates and never reads or writes pricing evaluations.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * A creating `POST` of the catalogue, through the repository's idempotency
   * mechanism in its platform namespace (`IdempotencyService.executePlatform`).
   *
   * The key is required. The same key and request replay the original response
   * and create nothing; the same key with a different request is `422`;
   * concurrent duplicates serialise on the key's unique index and the loser
   * replays the winner. `pricing.manage` is asserted before the key is claimed
   * and again before anything stored is replayed.
   */
  private keyed<T>(
    principal: AuthPrincipal,
    key: string | null,
    successStatus: number,
    route: string,
    pathParams: Record<string, unknown>,
    body: Record<string, unknown>,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<IdempotentOutcome<{ data: T }>> {
    return this.idempotency.executePlatform({
      key,
      successStatus,
      request: { method: 'POST', route, orgId: null, principal, pathParams, query: {}, body },
      authorize: (tx) => this.authorize(tx, principal, PERMISSIONS.PRICING_MANAGE),
      work: async (tx) => ({ data: await work(tx) }),
    });
  }

  private readonly planListSpec: ListQuerySpec = {
    sortable: { createdAt: { column: schema.pricingPlans.id, encode: (row) => String(row.id) } },
    defaultSort: 'createdAt',
    tieBreaker: schema.pricingPlans.id,
  };

  private readonly costRateListSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.providerCostRates.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'createdAt',
    tieBreaker: schema.providerCostRates.id,
  };

  private readonly assignmentListSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.customerPricingAssignments.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'createdAt',
    tieBreaker: schema.customerPricingAssignments.id,
  };

  // --- authorization and audit --------------------------------------------------

  private async authorize(
    tx: Transaction,
    principal: AuthPrincipal,
    permission: PermissionKey,
  ): Promise<void> {
    const { orgId, resellerId } = principal.tenant;
    const hasPlatformGrant = principal.roles.some((grant) => grant.scopeType === 'platform');
    if (
      !(orgId || resellerId || hasPlatformGrant) &&
      !(await this.authorization.allows(tx, {
        principal,
        permission,
        target: PLATFORM,
        resourceType: 'Pricing',
      }))
    ) {
      // No scope to attribute an audited refusal to: decided, not asserted (as the
      // provider catalogue does).
      RequestContext.recordAuthorizationCheck(permission);
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: { permission, targetScopeType: 'platform', reason: 'unattributable refusal' },
      });
    }
    await this.authorization.assert(tx, {
      principal,
      permission,
      target: PLATFORM,
      resourceType: 'Pricing',
    });
    if (principal.actorType !== 'user' || !principal.userId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: { permission, targetScopeType: 'platform', reason: 'not a signed-in user' },
      });
    }
  }

  private record(
    tx: Transaction,
    principal: AuthPrincipal,
    action: AuditAction,
    resourceType: string,
    resourceId: string,
    after: Record<string, unknown>,
    before: Record<string, unknown> | null = null,
  ): Promise<void> {
    return this.audit.record(
      {
        scopeType: 'platform',
        scopeId: null,
        ...actorFromPrincipal(principal),
        action,
        resourceType,
        resourceId,
        outcome: 'success',
        before,
        after,
        metadata: {},
      },
      tx,
    );
  }

  // --- plans ----------------------------------------------------------------------

  async listPlans(
    principal: AuthPrincipal,
    query: ListQueryInput,
  ): Promise<{ items: readonly PricingPlanResponse[]; page: PageInfo }> {
    const resolved = this.lists.resolve(query, this.planListSpec);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PRICING_READ);
      const rows = await tx
        .select()
        .from(schema.pricingPlans)
        .where(resolved.after)
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
      const { items, page } = this.lists.paginate(rows, resolved, this.planListSpec, (r) => r.id);
      return { items: items.map(planView), page };
    });
  }

  async getPlan(principal: AuthPrincipal, id: string): Promise<PricingPlanDetailResponse> {
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PRICING_READ);
      const [plan] = await tx
        .select()
        .from(schema.pricingPlans)
        .where(eq(schema.pricingPlans.id, id));
      if (!plan) throw notFound('Pricing plan', id);
      const versions = await tx
        .select()
        .from(schema.pricingPlanVersions)
        .where(eq(schema.pricingPlanVersions.planId, id))
        .orderBy(asc(schema.pricingPlanVersions.versionNumber));
      return { ...planView(plan), versions: versions.map(versionSummary) };
    });
  }

  async createPlan(
    principal: AuthPrincipal,
    input: CreatePricingPlanDto,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: PricingPlanDetailResponse }>> {
    return this.keyed(
      principal,
      key,
      HttpStatus.CREATED,
      '/platform/pricing/plans',
      {},
      { name: input.name, description: input.description ?? null },
      async (tx) => {
        const [row] = await tx
          .insert(schema.pricingPlans)
          .values({ name: input.name.trim(), description: input.description ?? null })
          .onConflictDoNothing()
          .returning();
        if (!row) throw conflict('A pricing plan with this name already exists');
        const view = planView(row);
        await this.record(
          tx,
          principal,
          AUDIT_ACTIONS.PRICING_PLAN_CREATED,
          'PricingPlan',
          row.id,
          {
            ...view,
          },
        );
        return { ...view, versions: [] };
      },
    );
  }

  // --- versions and rules ------------------------------------------------------------

  /**
   * Creates the next draft version of a plan. Keyed: a retry replays the original
   * draft even after it was activated. One draft per plan: a second draft is 409.
   */
  async createVersion(
    principal: AuthPrincipal,
    planId: string,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: PricingPlanVersionResponse }>> {
    return this.keyed(
      principal,
      key,
      HttpStatus.CREATED,
      '/platform/pricing/plans/:id/versions',
      { id: planId },
      {},
      async (tx) => {
        const [plan] = await tx
          .select({ id: schema.pricingPlans.id })
          .from(schema.pricingPlans)
          .where(eq(schema.pricingPlans.id, planId));
        if (!plan) throw notFound('Pricing plan', planId);
        const [{ next }] = (await tx
          .select({
            next: sql<number>`coalesce(max(${schema.pricingPlanVersions.versionNumber}), 0)::int + 1`,
          })
          .from(schema.pricingPlanVersions)
          .where(eq(schema.pricingPlanVersions.planId, planId))) as [{ next: number }];
        const [row] = await tx
          .insert(schema.pricingPlanVersions)
          .values({ planId, versionNumber: next })
          .onConflictDoNothing()
          .returning();
        if (!row)
          throw conflict('This plan already has a draft version; edit or activate it first');
        const view = versionSummary(row);
        await this.record(
          tx,
          principal,
          AUDIT_ACTIONS.PRICING_VERSION_CREATED,
          'PricingPlanVersion',
          row.id,
          {
            ...view,
          },
        );
        return { ...view, rules: [] };
      },
    );
  }

  async getVersion(principal: AuthPrincipal, id: string): Promise<PricingPlanVersionResponse> {
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PRICING_READ);
      return this.loadVersion(tx, id);
    });
  }

  private async loadVersion(tx: Transaction, id: string): Promise<PricingPlanVersionResponse> {
    const [version] = await tx
      .select()
      .from(schema.pricingPlanVersions)
      .where(eq(schema.pricingPlanVersions.id, id));
    if (!version) throw notFound('Pricing plan version', id);
    const rules = await tx
      .select({
        id: schema.pricingRules.id,
        channelId: schema.pricingRules.channelId,
        channelCode: schema.channels.code,
        providerId: schema.pricingRules.providerId,
        unitPriceE4: schema.pricingRules.unitPriceE4,
      })
      .from(schema.pricingRules)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.pricingRules.channelId))
      .where(eq(schema.pricingRules.planVersionId, id))
      .orderBy(asc(schema.channels.code), asc(schema.pricingRules.id));
    return {
      ...versionSummary(version),
      rules: rules.map((r): PricingRuleResponse => ({
        id: r.id,
        channelId: r.channelId,
        channelCode: r.channelCode,
        providerId: r.providerId,
        unit: unitOf(r.channelCode),
        unitPriceE4: r.unitPriceE4,
      })),
    };
  }

  /** Replaces every rule of a draft version. Refused (409) once the version is active. */
  async replaceRules(
    principal: AuthPrincipal,
    versionId: string,
    input: ReplacePricingRulesDto,
  ): Promise<PricingPlanVersionResponse> {
    const keys = new Set<string>();
    for (const rule of input.rules) {
      const key = `${rule.channelId}/${rule.providerId ?? '-'}`;
      if (keys.has(key)) throw invalid('Each (channel, provider) pair may appear only once');
      keys.add(key);
    }
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PRICING_MANAGE);
      const before = await this.loadVersion(tx, versionId);
      if (before.status !== 'draft') throw conflict('Only a draft version can be changed');
      try {
        await tx
          .delete(schema.pricingRules)
          .where(eq(schema.pricingRules.planVersionId, versionId));
        if (input.rules.length > 0) {
          await tx.insert(schema.pricingRules).values(
            input.rules.map((r) => ({
              planVersionId: versionId,
              channelId: r.channelId,
              providerId: r.providerId ?? null,
              unitPriceE4: r.unitPriceE4,
            })),
          );
        }
      } catch (error) {
        throw this.mapCatalogueError(error, 'rules');
      }
      const after = await this.loadVersion(tx, versionId);
      await this.record(
        tx,
        principal,
        AUDIT_ACTIONS.PRICING_RULES_REPLACED,
        'PricingPlanVersion',
        versionId,
        { rules: after.rules },
        { rules: before.rules },
      );
      return after;
    });
  }

  /**
   * Activates a draft: from `effectiveFrom` (default: now) it prices new
   * transactions and is frozen for ever. Never backdated; at least one rule.
   */
  async activateVersion(
    principal: AuthPrincipal,
    versionId: string,
    input: ActivatePricingVersionDto,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: PricingPlanVersionResponse }>> {
    return this.keyed(
      principal,
      key,
      HttpStatus.OK,
      '/platform/pricing/versions/:id/activate',
      { id: versionId },
      { effectiveFrom: input.effectiveFrom ?? null },
      async (tx) => {
        const before = await this.loadVersion(tx, versionId);
        if (before.status !== 'draft') throw conflict('The version is already active');
        if (before.rules.length === 0)
          throw invalid('A version needs at least one rule to be activated');
        const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
        await this.assertNotPast(tx, effectiveFrom);
        try {
          await tx
            .update(schema.pricingPlanVersions)
            .set({
              status: 'active',
              effectiveFrom: effectiveFrom ?? sql`now()`,
            })
            .where(eq(schema.pricingPlanVersions.id, versionId));
        } catch (error) {
          throw this.mapCatalogueError(error, 'version');
        }
        const after = await this.loadVersion(tx, versionId);
        await this.record(
          tx,
          principal,
          AUDIT_ACTIONS.PRICING_VERSION_ACTIVATED,
          'PricingPlanVersion',
          versionId,
          {
            status: after.status,
            effectiveFrom: after.effectiveFrom,
            activatedAt: after.activatedAt,
          },
          { status: before.status },
        );
        return after;
      },
    );
  }

  // --- provider cost rates ---------------------------------------------------------------

  async listProviderCostRates(
    principal: AuthPrincipal,
    query: ListProviderCostRatesQueryDto,
  ): Promise<{ items: readonly ProviderCostRateResponse[]; page: PageInfo }> {
    const resolved = this.lists.resolve(query, this.costRateListSpec);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PRICING_READ);
      const where: (SQL | undefined)[] = [resolved.after];
      if (query.providerId) where.push(eq(schema.providerCostRates.providerId, query.providerId));
      const rows = await tx
        .select({ rate: schema.providerCostRates, channelCode: schema.channels.code })
        .from(schema.providerCostRates)
        .innerJoin(schema.channels, eq(schema.channels.id, schema.providerCostRates.channelId))
        .where(and(...where))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
      const flat = rows.map((r) => ({ ...r.rate, channelCode: r.channelCode }));
      const { items, page } = this.lists.paginate(
        flat,
        resolved,
        this.costRateListSpec,
        (r) => r.id,
      );
      return { items: items.map((r) => this.costRateView(r, r.channelCode)), page };
    });
  }

  async createProviderCostRate(
    principal: AuthPrincipal,
    input: CreateProviderCostRateDto,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: ProviderCostRateResponse }>> {
    return this.keyed(
      principal,
      key,
      HttpStatus.CREATED,
      '/platform/pricing/provider-cost-rates',
      {},
      {
        providerId: input.providerId,
        unitCostE4: input.unitCostE4,
        effectiveFrom: input.effectiveFrom ?? null,
      },
      async (tx) => {
        const [provider] = await tx
          .select({
            id: schema.providers.id,
            channelId: schema.providers.channelId,
            code: schema.channels.code,
          })
          .from(schema.providers)
          .innerJoin(schema.channels, eq(schema.channels.id, schema.providers.channelId))
          .where(eq(schema.providers.id, input.providerId));
        if (!provider) throw notFound('Provider', input.providerId);
        const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
        await this.assertNotPast(tx, effectiveFrom);
        let row: CostRateRow | undefined;
        try {
          [row] = await tx
            .insert(schema.providerCostRates)
            .values({
              providerId: provider.id,
              channelId: provider.channelId,
              unitCostE4: input.unitCostE4,
              effectiveFrom: effectiveFrom ?? sql`now()`,
            })
            .returning();
        } catch (error) {
          throw this.mapCatalogueError(error, 'provider cost rate');
        }
        const view = this.costRateView(row!, provider.code);
        await this.record(
          tx,
          principal,
          AUDIT_ACTIONS.PRICING_PROVIDER_COST_RATE_CREATED,
          'ProviderCostRate',
          view.id,
          { ...view },
        );
        return view;
      },
    );
  }

  private costRateView(r: CostRateRow, channelCode: string): ProviderCostRateResponse {
    return {
      id: r.id,
      providerId: r.providerId,
      channelId: r.channelId,
      channelCode,
      unit: unitOf(channelCode),
      unitCostE4: r.unitCostE4,
      effectiveFrom: r.effectiveFrom.toISOString(),
      createdAt: r.createdAt.toISOString(),
    };
  }

  // --- assignments -----------------------------------------------------------------------

  async listAssignments(
    principal: AuthPrincipal,
    query: ListPricingAssignmentsQueryDto,
  ): Promise<{ items: readonly PricingAssignmentResponse[]; page: PageInfo }> {
    const resolved = this.lists.resolve(query, this.assignmentListSpec);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PRICING_READ);
      const where: (SQL | undefined)[] = [resolved.after];
      if (query.orgId) where.push(eq(schema.customerPricingAssignments.orgId, query.orgId));
      const rows = await tx
        .select()
        .from(schema.customerPricingAssignments)
        .where(and(...where))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
      const { items, page } = this.lists.paginate(
        rows,
        resolved,
        this.assignmentListSpec,
        (r) => r.id,
      );
      return { items: items.map(assignmentView), page };
    });
  }

  async createAssignment(
    principal: AuthPrincipal,
    input: CreatePricingAssignmentDto,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: PricingAssignmentResponse }>> {
    return this.keyed(
      principal,
      key,
      HttpStatus.CREATED,
      '/platform/pricing/assignments',
      {},
      {
        orgId: input.orgId ?? null,
        planId: input.planId,
        effectiveFrom: input.effectiveFrom ?? null,
      },
      async (tx) => {
        const [plan] = await tx
          .select({ id: schema.pricingPlans.id })
          .from(schema.pricingPlans)
          .where(eq(schema.pricingPlans.id, input.planId));
        if (!plan) throw notFound('Pricing plan', input.planId);
        const orgId = input.orgId ?? null;
        if (orgId) {
          const [org] = await tx
            .select({ id: schema.organizations.id })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, orgId));
          if (!org) throw notFound('Organization', orgId);
        }
        const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
        await this.assertNotPast(tx, effectiveFrom);
        let row: AssignmentRow | undefined;
        try {
          [row] = await tx
            .insert(schema.customerPricingAssignments)
            .values({ orgId, planId: plan.id, effectiveFrom: effectiveFrom ?? sql`now()` })
            .returning();
        } catch (error) {
          throw this.mapCatalogueError(error, 'assignment');
        }
        const view = assignmentView(row!);
        await this.record(
          tx,
          principal,
          AUDIT_ACTIONS.PRICING_ASSIGNMENT_CREATED,
          'PricingAssignment',
          view.id,
          {
            ...view,
          },
        );
        return view;
      },
    );
  }

  // --- shared ------------------------------------------------------------------------------

  /** Effective dates are never in the past (database clock); the database enforces it again. */
  private async assertNotPast(tx: Transaction, effectiveFrom: Date | null): Promise<void> {
    if (!effectiveFrom) return;
    const [{ past }] = (
      await tx.execute<{ past: boolean }>(
        sql`SELECT ${effectiveFrom.toISOString()}::timestamptz < now() AS past`,
      )
    ).rows as [{ past: boolean }];
    if (past) throw invalid('effectiveFrom must not be in the past');
  }

  private mapCatalogueError(error: unknown, what: string): unknown {
    switch (sqlState(error)) {
      case '23505':
        return conflict(`The ${what} conflicts with an existing one (same key or effective date)`);
      case '23503':
        return invalid(
          `The ${what} references an unknown channel or provider, or a provider not on that channel`,
        );
      case '22023':
      case '23514':
        return invalid(
          `The ${what} is not valid: the channel is not priced, or the date is in the past`,
        );
      case '42501':
        return conflict(`The ${what} can no longer be changed`);
      default:
        return error;
    }
  }
}
