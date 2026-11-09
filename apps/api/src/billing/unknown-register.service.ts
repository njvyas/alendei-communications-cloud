import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import {
  CHANNEL_CODES,
  ERROR_CODES,
  PAGE_LIMITS,
  PERMISSIONS,
  type AuthPrincipal,
  type PageInfo,
} from '@acc/contracts';
import type { Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';

import { AuthorizationService } from '../auth/authorization.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { CursorCodec } from '../common/http/cursor';
import { TenantDatabase } from '../database/tenant-database.service';
import { MetricsService } from '../observability/metrics.service';
import type { ListUnknownOutcomesQueryDto } from './unknown-register.dto';

const PLATFORM = { scopeType: 'platform', scopeId: null } as const;
/** The register's only order: oldest first (longest-open first), then message id. */
const SORT = 'completedAt';

export interface UnknownOutcomeView {
  readonly messageId: string;
  readonly orgId: string;
  readonly channelCode: string;
  readonly billingPolicy: string;
  readonly completedAt: string;
  readonly ageSeconds: number;
  readonly attemptId: string | null;
  readonly providerId: string | null;
  /** Estimates for reconciliation only — never ledger entries (Policy U). */
  readonly estimatedExposure: {
    readonly customerPaise: number | null;
    readonly providerCostPaise: number | null;
  };
  readonly evidence: 'evidenced' | 'unevidenced';
  readonly status: string;
}

interface RegisterRow extends Record<string, unknown> {
  message_id: string;
  org_id: string;
  channel_code: string;
  billing_policy: string;
  completed_at: string | Date;
  age_seconds: string;
  attempt_id: string | null;
  provider_id: string | null;
  estimated_customer_paise: string | null;
  estimated_provider_cost_paise: string | null;
  evidence: 'evidenced' | 'unevidenced';
  status: string;
}

const paiseOrNull = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * Phase 7 PR 7-6b — the unknown-outcome register (`DECISIONS.md` §1zi.9 D-76-5;
 * handover Rev 2 §5; baseline §6.5 Policy U).
 *
 * Platform read only: `billing.manage` at platform scope, signed-in users only.
 * The data is read exclusively through `app_billing_unknown_register` and
 * `app_billing_unknown_open_counts` (migration `0056`), SECURITY DEFINER read
 * functions that check the caller again; no platform policy exists on any
 * financial table. Exposure figures are estimates from the evaluations, never
 * ledger entries. Nothing here writes, charges or resolves.
 */
@Injectable()
export class UnknownOutcomeRegisterService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly cursors: CursorCodec,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async list(
    principal: AuthPrincipal,
    query: ListUnknownOutcomesQueryDto,
  ): Promise<{ items: readonly UnknownOutcomeView[]; page: PageInfo }> {
    if (principal.actorType !== 'user' || !principal.userId || !principal.sessionId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'The unknown-outcome register requires a signed-in user session',
      });
    }
    const limit = query.limit ?? PAGE_LIMITS.DEFAULT;
    const after = query.cursor ? this.cursors.decode(query.cursor, SORT) : null;

    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal);
      const { rows } = await tx.execute<RegisterRow>(sql`
        SELECT * FROM app_billing_unknown_register(
          ${query.orgId ?? null}::uuid,
          ${query.channelCode ?? null}::text,
          ${query.evidence ?? null}::text,
          ${query.status ?? null}::text,
          ${query.minAgeHours === undefined ? null : query.minAgeHours * 3600}::integer,
          ${after?.v ?? null}::timestamptz,
          ${after?.i ?? null}::uuid,
          ${limit + 1}::integer)`);

      // The gauge of open items per channel, as of this read.
      const counts = await tx.execute<{ channel_code: string; open_items: string }>(
        sql`SELECT * FROM app_billing_unknown_open_counts()`,
      );
      const open = new Map(counts.rows.map((r) => [r.channel_code, Number(r.open_items)]));
      for (const channel of CHANNEL_CODES) {
        this.metrics?.billingOutcomeUnknownOpen.set({ channel }, open.get(channel) ?? 0);
      }

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();
      return {
        items: page.map((r) => ({
          messageId: r.message_id,
          orgId: r.org_id,
          channelCode: r.channel_code,
          billingPolicy: r.billing_policy,
          completedAt: iso(r.completed_at),
          ageSeconds: Number(r.age_seconds),
          attemptId: r.attempt_id,
          providerId: r.provider_id,
          estimatedExposure: {
            customerPaise: paiseOrNull(r.estimated_customer_paise),
            providerCostPaise: paiseOrNull(r.estimated_provider_cost_paise),
          },
          evidence: r.evidence,
          status: r.status,
        })),
        page: {
          nextCursor:
            hasMore && last
              ? this.cursors.encode({ s: SORT, v: iso(last.completed_at), i: last.message_id })
              : null,
          hasMore,
          limit,
        },
      };
    });
  }

  /** billing.manage at platform scope, as the pricing catalogue authorizes. */
  private async authorize(tx: Transaction, principal: AuthPrincipal) {
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
