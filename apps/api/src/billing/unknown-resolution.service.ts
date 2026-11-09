import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PAGE_LIMITS,
  PERMISSIONS,
  type AuditAction,
  type AuthPrincipal,
  type ErrorCode,
  type PageInfo,
} from '@acc/contracts';
import type { Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { CursorCodec } from '../common/http/cursor';
import { AppConfigService } from '../config/app-config.service';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { MetricsService } from '../observability/metrics.service';
import type {
  ApproveUnknownResolutionDto,
  CreateUnknownResolutionDto,
  ListUnknownResolutionsQueryDto,
  RejectUnknownResolutionDto,
} from './unknown-resolution.dto';

const PLATFORM = { scopeType: 'platform', scopeId: null } as const;
/** Newest first, by id (UUIDv7). */
const SORT = 'id';

export interface UnknownResolutionView {
  readonly id: string;
  readonly orgId: string;
  readonly messageId: string;
  readonly attemptId: string | null;
  readonly action: 'charge' | 'write_off';
  readonly status: 'pending' | 'executed' | 'rejected';
  readonly billingPolicy: string;
  /** Snapshot at request: the total customer charge a charge posts (or the amount written off). */
  readonly customerAmountPaise: number;
  /** Snapshot at request: the unknown attempt's evaluated provider cost. */
  readonly providerCostPaise: number | null;
  readonly evidence: 'evidenced' | 'unevidenced';
  /** Whether a charge posts the provider cost (only with evidence, O-1). */
  readonly postsProviderCost: boolean;
  readonly dualControl: boolean;
  readonly thresholdPaise: number | null;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly executedAt: string | null;
  readonly chargedPaise: number | null;
  readonly providerCostPostedPaise: number | null;
  readonly lastRefusal: string | null;
  readonly lastRefusedAt: string | null;
}

interface ResolutionRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  message_id: string;
  attempt_id: string | null;
  action: 'charge' | 'write_off';
  status: 'pending' | 'executed' | 'rejected';
  billing_policy: string;
  customer_amount_paise: string;
  provider_cost_paise: string | null;
  evidence: 'evidenced' | 'unevidenced';
  post_provider_cost: boolean;
  dual_control: boolean;
  threshold_paise: string | null;
  reason: string;
  requested_by: string;
  requested_at: string | Date;
  approved_by: string | null;
  approved_at: string | Date | null;
  rejected_by: string | null;
  rejected_at: string | Date | null;
  rejection_reason: string | null;
  executed_at: string | Date | null;
  charged_paise: string | null;
  provider_cost_posted_paise: string | null;
  last_refusal: string | null;
  last_refused_at: string | Date | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const iso = (v: string | Date | null): string | null =>
  v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString();

function view(r: ResolutionRow): UnknownResolutionView {
  return {
    id: r.id,
    orgId: r.org_id,
    messageId: r.message_id,
    attemptId: r.attempt_id,
    action: r.action,
    status: r.status,
    billingPolicy: r.billing_policy,
    customerAmountPaise: Number(r.customer_amount_paise),
    providerCostPaise: num(r.provider_cost_paise),
    evidence: r.evidence,
    postsProviderCost: r.post_provider_cost,
    dualControl: r.dual_control,
    thresholdPaise: num(r.threshold_paise),
    reason: r.reason,
    requestedBy: r.requested_by,
    requestedAt: iso(r.requested_at)!,
    approvedBy: r.approved_by,
    approvedAt: iso(r.approved_at),
    rejectedBy: r.rejected_by,
    rejectedAt: iso(r.rejected_at),
    rejectionReason: r.rejection_reason,
    executedAt: iso(r.executed_at),
    chargedPaise: num(r.charged_paise),
    providerCostPostedPaise: num(r.provider_cost_posted_paise),
    lastRefusal: r.last_refusal,
    lastRefusedAt: iso(r.last_refused_at),
  };
}

/** The SQLSTATE of a database error, unwrapped from the query builder's wrapper. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  return undefined;
}

/** Refusals that leave a pending approval pending, with the reason recorded on it. */
const FUNDS_REFUSALS = new Set(['BL001', 'BL002', 'BL003']);

function refusal(status: HttpStatus, code: ErrorCode, message: string): AppException {
  return new AppException({ status, code, message });
}

/** Maps the resolution functions' refusals; no amount is ever disclosed. */
function translate(error: unknown): unknown {
  if (error instanceof AppException) return error;
  switch (sqlState(error)) {
    case 'BL010':
    case '23505':
      return refusal(
        HttpStatus.CONFLICT,
        ERROR_CODES.BILLING_RESOLUTION_CONFLICT,
        'This outcome cannot be resolved now: it is not an unresolved unknown outcome, or a request is already pending',
      );
    case 'BL011':
      return refusal(
        HttpStatus.FORBIDDEN,
        ERROR_CODES.BILLING_RESOLUTION_SELF_APPROVAL,
        'A resolution must be approved or rejected by a different user than its requester',
      );
    case 'BL012':
      return refusal(
        HttpStatus.CONFLICT,
        ERROR_CODES.BILLING_RESOLUTION_STALE,
        'The resolution no longer matches the outcome or the approved amount; nothing was executed',
      );
    case 'BL003':
      return refusal(
        HttpStatus.PAYMENT_REQUIRED,
        ERROR_CODES.BILLING_INSUFFICIENT_FUNDS,
        'The organization has insufficient funds for this charge; nothing was charged',
      );
    case 'BL002':
      return refusal(
        HttpStatus.FORBIDDEN,
        ERROR_CODES.BILLING_ACCOUNT_FROZEN,
        "The organization's billing account is frozen; nothing was charged",
      );
    case 'BL001':
      return refusal(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED,
        'The organization has no billing account of its billing mode; nothing was charged',
      );
    case 'P0002':
      return refusal(HttpStatus.NOT_FOUND, ERROR_CODES.RESOURCE_NOT_FOUND, 'Not found');
    case '55P03':
    case '40P01':
    case '40001':
      return refusal(
        HttpStatus.SERVICE_UNAVAILABLE,
        ERROR_CODES.BILLING_BUSY,
        'The billing records are busy; retry with the same Idempotency-Key',
      );
    case '42501':
      return refusal(
        HttpStatus.FORBIDDEN,
        ERROR_CODES.AUTHZ_SCOPE_DENIED,
        'You do not have permission to perform this action',
      );
    default:
      return error;
  }
}

/**
 * Phase 7 PR 7-6c — operator resolution of unknown outcomes (`DECISIONS.md` §1zi.9
 * D-76-1, D-76-3, D-76-5 and §1zi.12; baseline §6.5 Policy U).
 *
 * Platform only: `billing.manage` at platform scope, signed-in user sessions only
 * (checked here; the routes' accepted-credentials declaration is documentation).
 * Every mutation requires an `Idempotency-Key` (RQ-3), is audited as
 * security-sensitive in its own transaction, and runs entirely inside the
 * migration `0057` SECURITY DEFINER functions, which check the caller again, decide
 * dual control, bind an approval to the request and post through the ledger
 * writer's operator-charge mode. This service never computes an amount.
 *
 * The dual-control threshold is `BILLING_DUAL_CONTROL_THRESHOLD_PAISE` (O-2), read
 * once per request and passed to the database, which records it on the request.
 * Nothing here runs automatically: no receipt, timer or worker resolves anything.
 */
@Injectable()
export class UnknownResolutionService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly idempotency: IdempotencyService,
    private readonly cursors: CursorCodec,
    private readonly config: AppConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // --- mutations --------------------------------------------------------------------

  async request(
    principal: AuthPrincipal,
    messageId: string,
    input: CreateUnknownResolutionDto,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: UnknownResolutionView }>> {
    this.requireUserSession(principal);
    const threshold = this.config.billing.dualControlThresholdPaise;
    try {
      const outcome = await this.idempotency.executePlatform({
        key,
        successStatus: HttpStatus.CREATED,
        request: {
          method: 'POST',
          route: '/platform/billing/unknown-outcomes/:messageId/resolutions',
          orgId: null,
          principal,
          pathParams: { messageId },
          query: {},
          body: { action: input.action, reason: input.reason },
        },
        authorize: (tx) => this.authorize(tx, principal),
        work: async (tx) => {
          const { rows } = await tx.execute<{ resolution_id: string; executed: boolean }>(sql`
            SELECT * FROM app_billing_resolution_request(
              ${messageId}::uuid, ${input.action}::text, ${input.reason}::text,
              ${threshold}::bigint, ${key}::text)`);
          const resolution = await this.load(tx, rows[0]!.resolution_id);
          await this.record(
            tx,
            principal,
            AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_REQUESTED,
            resolution,
          );
          if (resolution.status === 'executed')
            await this.recordExecution(tx, principal, resolution);
          return { data: resolution };
        },
      });
      if (!outcome.replayed) {
        this.count(input.action, outcome.body.data.status === 'executed' ? 'executed' : 'pending');
      }
      return outcome;
    } catch (error) {
      if (FUNDS_REFUSALS.has(sqlState(error) ?? '')) this.count(input.action, 'refused');
      throw translate(error);
    }
  }

  async approve(
    principal: AuthPrincipal,
    id: string,
    input: ApproveUnknownResolutionDto,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: UnknownResolutionView }>> {
    this.requireUserSession(principal);
    let action: string = 'charge';
    try {
      const outcome = await this.idempotency.executePlatform({
        key,
        successStatus: HttpStatus.OK,
        request: {
          method: 'POST',
          route: '/platform/billing/resolutions/:id/approve',
          orgId: null,
          principal,
          pathParams: { id },
          query: {},
          body: { expectedAmountPaise: input.expectedAmountPaise },
        },
        authorize: (tx) => this.authorize(tx, principal),
        work: async (tx) => {
          const before = await this.load(tx, id);
          action = before.action;
          this.refuseOwnRequest(before, principal);
          await tx.execute(sql`
            SELECT * FROM app_billing_resolution_approve(
              ${id}::uuid, ${input.expectedAmountPaise}::bigint)`);
          const after = await this.load(tx, id);
          await this.record(
            tx,
            principal,
            AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_APPROVED,
            after,
            before,
          );
          await this.recordExecution(tx, principal, after);
          return { data: after };
        },
      });
      if (!outcome.replayed) this.count(outcome.body.data.action, 'executed');
      return outcome;
    } catch (error) {
      if (FUNDS_REFUSALS.has(sqlState(error) ?? '')) {
        // The approval rolled back; the request stays pending with the refusal recorded on it
        // (re-derived by the database, never asserted by this service).
        await this.noteRefusal(id);
        this.count(action, 'refused');
      }
      throw translate(error);
    }
  }

  async reject(
    principal: AuthPrincipal,
    id: string,
    input: RejectUnknownResolutionDto,
    key: string | null,
  ): Promise<IdempotentOutcome<{ data: UnknownResolutionView }>> {
    this.requireUserSession(principal);
    try {
      const outcome = await this.idempotency.executePlatform({
        key,
        successStatus: HttpStatus.OK,
        request: {
          method: 'POST',
          route: '/platform/billing/resolutions/:id/reject',
          orgId: null,
          principal,
          pathParams: { id },
          query: {},
          body: { reason: input.reason },
        },
        authorize: (tx) => this.authorize(tx, principal),
        work: async (tx) => {
          const before = await this.load(tx, id);
          this.refuseOwnRequest(before, principal);
          await tx.execute(
            sql`SELECT app_billing_resolution_reject(${id}::uuid, ${input.reason}::text)`,
          );
          const after = await this.load(tx, id);
          await this.record(
            tx,
            principal,
            AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_REJECTED,
            after,
            before,
          );
          return { data: after };
        },
      });
      if (!outcome.replayed) this.count(outcome.body.data.action, 'rejected');
      return outcome;
    } catch (error) {
      throw translate(error);
    }
  }

  // --- reads --------------------------------------------------------------------------

  async list(
    principal: AuthPrincipal,
    query: ListUnknownResolutionsQueryDto,
  ): Promise<{ items: readonly UnknownResolutionView[]; page: PageInfo }> {
    this.requireUserSession(principal);
    const limit = query.limit ?? PAGE_LIMITS.DEFAULT;
    const after = query.cursor ? this.cursors.decode(query.cursor, SORT) : null;
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal);
      const { rows } = await tx.execute<ResolutionRow>(sql`
        SELECT * FROM app_billing_resolutions_list(
          NULL, ${query.status ?? null}::text, ${query.orgId ?? null}::uuid,
          ${query.messageId ?? null}::uuid, ${after?.i ?? null}::uuid, ${limit + 1}::integer)`);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(view),
        page: {
          nextCursor: hasMore && last ? this.cursors.encode({ s: SORT, i: last.id }) : null,
          hasMore,
          limit,
        },
      };
    });
  }

  async get(principal: AuthPrincipal, id: string): Promise<UnknownResolutionView> {
    this.requireUserSession(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal);
      return this.load(tx, id);
    });
  }

  // --- helpers --------------------------------------------------------------------------

  private async load(tx: Transaction, id: string): Promise<UnknownResolutionView> {
    const { rows } = await tx.execute<ResolutionRow>(
      sql`SELECT * FROM app_billing_resolutions_list(${id}::uuid, NULL, NULL, NULL, NULL, 1)`,
    );
    if (!rows[0]) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Billing resolution not found',
        logContext: { resource: 'BillingResolution', id },
      });
    }
    return view(rows[0]);
  }

  /** Dual control, first layer (the database's CHECK and definers are the second). */
  private refuseOwnRequest(resolution: UnknownResolutionView, principal: AuthPrincipal): void {
    if (resolution.status === 'pending' && resolution.requestedBy === principal.userId) {
      throw refusal(
        HttpStatus.FORBIDDEN,
        ERROR_CODES.BILLING_RESOLUTION_SELF_APPROVAL,
        'A resolution must be approved or rejected by a different user than its requester',
      );
    }
  }

  private async noteRefusal(id: string): Promise<void> {
    try {
      await this.db.withRequestTenant((tx) =>
        tx.execute(sql`SELECT app_billing_resolution_note_refusal(${id}::uuid)`),
      );
    } catch {
      // Best effort: the refusal itself is still returned to the caller.
    }
  }

  private recordExecution(
    tx: Transaction,
    principal: AuthPrincipal,
    resolution: UnknownResolutionView,
  ): Promise<void> {
    if (resolution.status !== 'executed') return Promise.resolve();
    return this.record(
      tx,
      principal,
      resolution.action === 'charge'
        ? AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_CHARGED
        : AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_WRITTEN_OFF,
      resolution,
      null,
      { reason: 'outcome_unknown_resolved' },
    );
  }

  private record(
    tx: Transaction,
    principal: AuthPrincipal,
    action: AuditAction,
    after: UnknownResolutionView,
    before: UnknownResolutionView | null = null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    return this.audit.record(
      {
        scopeType: 'platform',
        scopeId: null,
        ...actorFromPrincipal(principal),
        action,
        resourceType: 'BillingResolution',
        resourceId: after.id,
        outcome: 'success',
        before: before ? { ...before } : null,
        after: { ...after },
        metadata: { ...metadata, orgId: after.orgId, messageId: after.messageId },
      },
      tx,
    );
  }

  private count(action: string, outcome: 'executed' | 'pending' | 'rejected' | 'refused'): void {
    this.metrics?.billingOutcomeUnknownResolutions.inc({ action, outcome });
  }

  private requireUserSession(principal: AuthPrincipal): void {
    if (principal.actorType !== 'user' || !principal.userId || !principal.sessionId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'Resolving unknown outcomes requires a signed-in user session',
      });
    }
  }

  /** billing.manage at platform scope, as the register authorizes. */
  private async authorize(tx: Transaction, principal: AuthPrincipal): Promise<void> {
    const { orgId, resellerId } = principal.tenant;
    const hasPlatformGrant = principal.roles.some((grant) => grant.scopeType === 'platform');
    if (
      !(orgId || resellerId || hasPlatformGrant) &&
      !(await this.authorization.allows(tx, {
        principal,
        permission: PERMISSIONS.BILLING_MANAGE,
        target: PLATFORM,
        resourceType: 'Billing',
      }))
    ) {
      RequestContext.recordAuthorizationCheck(PERMISSIONS.BILLING_MANAGE);
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: {
          permission: PERMISSIONS.BILLING_MANAGE,
          targetScopeType: 'platform',
          reason: 'unattributable refusal',
        },
      });
    }
    await this.authorization.assert(tx, {
      principal,
      permission: PERMISSIONS.BILLING_MANAGE,
      target: PLATFORM,
      resourceType: 'Billing',
    });
  }
}
