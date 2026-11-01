import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  DOMAIN_CHALLENGE_ATTENTION_STATES,
  DOMAIN_CHALLENGE_STATES,
  DOMAIN_STATUSES,
  DOMAIN_TYPES,
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
  type DnsResolverResult,
  type DomainChallengeState,
  type DomainDnsDiagnostics,
  type DomainHistoryEntry,
  type DomainStatus,
  type DomainType,
  type PageInfo,
  type PermissionKey,
  type PlatformDomainSummary,
  type PlatformDomainView,
} from '@acc/contracts';
import { schema, type TenantSession, type Transaction } from '@acc/db';
import { and, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';

import { AuthorizationService } from '../../../auth/authorization.service';
import { RequestContext } from '../../../common/context/request-context';
import { AppException } from '../../../common/errors/app.exception';
import { ListQuery, type ListQuerySpec } from '../../../common/http/list-query';
import { TenantDatabase } from '../../../database/tenant-database.service';
import { DnsDiagnosticsProbe } from './dns-diagnostics.probe';
import {
  challengeStateCutoffs,
  challengeSummary,
  lookupErrorOutcome,
  propagationGuidance,
  propagationState,
  txtOutcome,
} from './domain-challenge';
import type { ListPlatformDomainsQueryDto } from './platform-domains.dto';

const PLATFORM = { scopeType: 'platform', scopeId: null } as const;
const DOMAIN_ACTIONS = [
  AUDIT_ACTIONS.DOMAIN_REGISTERED,
  AUDIT_ACTIONS.DOMAIN_VERIFIED,
  AUDIT_ACTIONS.DOMAIN_ACTIVATED,
  AUDIT_ACTIONS.DOMAIN_SUSPENDED,
  AUDIT_ACTIONS.DOMAIN_REMOVED,
] as const;
const HISTORY_LIMIT = 100;

type DomainRow = typeof schema.organizationDomains.$inferSelect;

/**
 * Platform domain oversight (Phase 4, U13.3): a cross-tenant, read-only view
 * of every U12 organization domain.
 *
 * **Authorization.** Every route is decided by `AuthorizationService` at
 * `platform` scope — `platform.tenants.read` for the registry and the DNS
 * diagnostics, `platform.audit.read` for lifecycle history. A tenant or
 * reseller administrator is refused with the ordinary `403` and audited denial;
 * no tenant permission confers access here.
 *
 * **RLS stays the backstop.** Domain rows are read as `acc_app` in the request
 * transaction; the platform-operator policy `organization_domains_platform_read`
 * (migration `0039`) admits them only for a user holding
 * `platform.tenants.read` through a platform-scope role, so an authorization
 * defect here would surface as an empty registry, not as a disclosure.
 * Organization and reseller *names* are read through the identity principal,
 * as the organization list's stage 1 does; no tenant content is read.
 *
 * **Nothing here writes.** Suspension, activation and verification remain the
 * U12 routes under `/organizations/{id}/domains/{domainId}/…`, with their own
 * authorization and audit; the console calls those.
 *
 * **Never returned:** the challenge value, observed TXT values, and audit
 * before/after images. Each view is built field by field.
 */
@Injectable()
export class PlatformDomainsService {
  private readonly listSpec: ListQuerySpec = {
    sortable: {
      domain: {
        column: schema.organizationDomains.domain,
        encode: (row) => String(row.domain),
      },
      createdAt: {
        column: schema.organizationDomains.id,
        encode: (row) => String(row.id),
      },
    },
    defaultSort: 'domain',
    tieBreaker: schema.organizationDomains.id,
  };

  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly lists: ListQuery,
    private readonly probe: DnsDiagnosticsProbe,
  ) {}

  // --- authorization -----------------------------------------------------------

  /**
   * `permission` at platform scope, decided by `AuthorizationService.assert`.
   * The same shape as `ProviderAccess.authorize`: a principal with no scope to
   * attribute a refusal to (no organization, reseller or platform grant) is
   * refused without an audit row it could not be filed under, and only after
   * the non-auditing `allows` agrees.
   */
  private async authorize(
    tx: Transaction,
    principal: AuthPrincipal,
    permission: PermissionKey,
  ): Promise<void> {
    const { orgId, resellerId } = principal.tenant;
    const hasPlatformGrant = principal.roles.some((grant) => grant.scopeType === 'platform');
    const attributable = Boolean(orgId || resellerId || hasPlatformGrant);
    const request = { principal, permission, target: PLATFORM, resourceType: 'OrganizationDomain' };
    if (!attributable && !(await this.authorization.allows(tx, request))) {
      RequestContext.recordAuthorizationCheck(permission);
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: {
          permission,
          targetScopeType: 'platform',
          reason:
            'refused; no organization, reseller or platform scope to attribute the refusal to',
        },
      });
    }
    await this.authorization.assert(tx, request);
    if (principal.actorType !== 'user' || !principal.userId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: { permission, targetScopeType: 'platform', reason: 'not a signed-in user' },
      });
    }
  }

  // --- registry ----------------------------------------------------------------

  async list(
    principal: AuthPrincipal,
    filter: ListPlatformDomainsQueryDto = {},
    now: Date = new Date(),
  ): Promise<{ items: readonly PlatformDomainView[]; page: PageInfo }> {
    const resolved = this.lists.resolve(filter, this.listSpec);
    const t = schema.organizationDomains;

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PLATFORM_TENANTS_READ);

      const predicates: SQL[] = [];
      if (filter.status) predicates.push(eq(t.status, filter.status));
      if (filter.domainType) predicates.push(eq(t.domainType, filter.domainType));
      if (filter.verificationStatus) {
        predicates.push(eq(t.verificationStatus, filter.verificationStatus));
      }
      if (filter.challengeState) {
        predicates.push(sql`${this.challengeStateSql(now)} = ${filter.challengeState}`);
      }
      if (filter.orgId) predicates.push(eq(t.orgId, filter.orgId));
      if (filter.resellerId) {
        const orgIds = await this.organizationsOfReseller(filter.resellerId);
        predicates.push(orgIds.length > 0 ? inArray(t.orgId, orgIds) : sql`false`);
      }
      if (filter.q) predicates.push(ilike(t.domain, `%${filter.q.toLowerCase()}%`));
      if (resolved.after) predicates.push(resolved.after);

      return tx
        .select()
        .from(t)
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
    const views = await this.views(items as unknown as DomainRow[], now);
    return { items: views, page };
  }

  async get(principal: AuthPrincipal, domainId: string, now = new Date()) {
    const row = await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PLATFORM_TENANTS_READ);
      return this.load(tx, domainId);
    });
    const [view] = await this.views([row], now);
    return view!;
  }

  async summary(principal: AuthPrincipal, now: Date = new Date()): Promise<PlatformDomainSummary> {
    const t = schema.organizationDomains;
    const grouped = await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PLATFORM_TENANTS_READ);
      const result = await tx.execute<{
        status: DomainStatus;
        domain_type: DomainType;
        challenge_state: DomainChallengeState;
        n: number;
      }>(sql`
        SELECT ${t.status} AS status,
               ${t.domainType} AS domain_type,
               ${this.challengeStateSql(now)} AS challenge_state,
               count(*)::int AS n
          FROM ${t}
         GROUP BY 1, 2, 3`);
      return result.rows;
    });

    const zero = <K extends string>(keys: readonly K[]) =>
      Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
    const byStatus = zero(DOMAIN_STATUSES);
    const byChallengeState = zero(DOMAIN_CHALLENGE_STATES);
    const byType = zero(DOMAIN_TYPES);
    let total = 0;
    for (const row of grouped) {
      const n = Number(row.n);
      total += n;
      byStatus[row.status] += n;
      byChallengeState[row.challenge_state] += n;
      byType[row.domain_type] += n;
    }
    const needsAttention = DOMAIN_CHALLENGE_ATTENTION_STATES.reduce(
      (sum, state) => sum + byChallengeState[state],
      0,
    );
    return { total, byStatus, byChallengeState, byType, needsAttention };
  }

  // --- DNS diagnostics -----------------------------------------------------------

  /**
   * Looks up `_alendei-challenge.<domain>` on each configured resolver and
   * compares what it finds with the stored challenge **on the server**. Only
   * the outcome and the record count leave this method. Read-only: it never
   * changes the domain, the challenge, or DNS; to act on the result, the
   * console calls U12's verification route.
   */
  async diagnostics(
    principal: AuthPrincipal,
    domainId: string,
    now: Date = new Date(),
  ): Promise<DomainDnsDiagnostics> {
    const row = await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PLATFORM_TENANTS_READ);
      return this.load(tx, domainId);
    });

    const challenge = challengeSummary(this.challengeInput(row), now);
    const challengeHost = `_alendei-challenge.${row.domain}`;
    const base = {
      domainId: row.id,
      domain: row.domain,
      challengeHost,
      checkedAt: now.toISOString(),
      challenge,
    };

    if (challenge.state === 'verified' || challenge.state === 'not_required') {
      return {
        ...base,
        propagation: 'not_applicable',
        results: [],
        guidance: propagationGuidance('not_applicable', challenge.state),
      };
    }

    const expected = row.verificationValue;
    const results: DnsResolverResult[] = await Promise.all(
      this.probe.list().map(async (resolver) => {
        const started = Date.now();
        try {
          const records = await this.probe.txt(resolver, challengeHost);
          const { outcome, recordCount } = txtOutcome(records, expected);
          return {
            resolver: resolver.label,
            outcome,
            recordCount,
            errorCode: null,
            durationMs: Date.now() - started,
          };
        } catch (err: unknown) {
          const code = (err as { code?: unknown }).code;
          const errorCode = typeof code === 'string' ? code.slice(0, 32) : null;
          return {
            resolver: resolver.label,
            outcome: lookupErrorOutcome(errorCode ?? undefined),
            recordCount: 0,
            errorCode,
            durationMs: Date.now() - started,
          };
        }
      }),
    );

    const propagation = propagationState(results.map((r) => r.outcome));
    return {
      ...base,
      propagation,
      results,
      guidance: propagationGuidance(propagation, challenge.state),
    };
  }

  // --- lifecycle history ---------------------------------------------------------

  /**
   * The domain's lifecycle events from the audit log, newest first. Read under
   * the owning organization's context, so `audit_logs_select` decides
   * visibility exactly as for that organization's own audit trail. Only
   * allowlisted scalar fields are returned.
   */
  async history(principal: AuthPrincipal, domainId: string): Promise<DomainHistoryEntry[]> {
    const row = await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PLATFORM_AUDIT_READ);
      return this.load(tx, domainId);
    });

    const session: TenantSession = {
      orgId: row.orgId,
      workspaceId: null,
      resellerId: null,
      userId: principal.userId,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
    };
    const a = schema.auditLogs;
    const events = await this.db.withTenant(session, (tx) =>
      tx
        .select({
          id: a.id,
          occurredAt: a.occurredAt,
          action: a.action,
          outcome: a.outcome,
          actorType: a.actorType,
          actorUserId: a.actorUserId,
          before: a.before,
          after: a.after,
          metadata: a.metadata,
        })
        .from(a)
        .where(
          and(
            eq(a.orgId, row.orgId),
            eq(a.resourceType, 'OrganizationDomain'),
            eq(a.resourceId, row.id),
            inArray(a.action, [...DOMAIN_ACTIONS]),
          ),
        )
        .orderBy(desc(a.occurredAt), desc(a.id))
        .limit(HISTORY_LIMIT),
    );

    return events.map((e) => {
      const before = asRecord(e.before);
      const after = asRecord(e.after);
      const metadata = asRecord(e.metadata);
      return {
        id: e.id,
        occurredAt: e.occurredAt.toISOString(),
        action: e.action,
        outcome: e.outcome,
        actorType: e.actorType,
        actorUserId: e.actorUserId ?? null,
        fromStatus: stringField(before, 'status'),
        toStatus: stringField(after, 'status'),
        fromVerificationStatus: stringField(before, 'verificationStatus'),
        toVerificationStatus: stringField(after, 'verificationStatus'),
        reason:
          e.action === AUDIT_ACTIONS.DOMAIN_SUSPENDED ? stringField(metadata, 'reason', 500) : null,
      };
    });
  }

  // --- helpers -------------------------------------------------------------------

  private async load(tx: Transaction, domainId: string): Promise<DomainRow> {
    const [row] = await tx
      .select()
      .from(schema.organizationDomains)
      .where(eq(schema.organizationDomains.id, domainId));
    if (!row) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.DOMAIN_NOT_FOUND,
        message: 'Domain not found',
      });
    }
    return row;
  }

  private challengeInput(row: DomainRow) {
    return {
      verificationMethod: row.verificationMethod,
      verificationStatus: row.verificationStatus,
      challengeStartedAt: row.updatedAt,
    };
  }

  /** The SQL twin of `challengeState`, evaluated against the same `now`. */
  private challengeStateSql(now: Date): SQL {
    const t = schema.organizationDomains;
    const { expiredBefore, expiringBefore } = challengeStateCutoffs(now);
    return sql`(CASE
      WHEN ${t.verificationMethod} = 'platform_subdomain' THEN 'not_required'
      WHEN ${t.verificationStatus} = 'verified' THEN 'verified'
      WHEN ${t.updatedAt} < ${expiredBefore.toISOString()}::timestamptz THEN 'expired'
      WHEN ${t.verificationStatus} = 'failed' THEN 'failed'
      WHEN ${t.updatedAt} < ${expiringBefore.toISOString()}::timestamptz THEN 'expiring_soon'
      ELSE 'pending' END)`;
  }

  private async organizationsOfReseller(resellerId: string): Promise<string[]> {
    const rows = await this.db.auth
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.resellerId, resellerId));
    return rows.map((r) => r.id);
  }

  /** Builds views field by field; names come from the identity principal. */
  private async views(
    domainRecords: readonly DomainRow[],
    now: Date,
  ): Promise<PlatformDomainView[]> {
    if (domainRecords.length === 0) return [];
    const orgIds = [...new Set(domainRecords.map((r) => r.orgId))];
    const orgs = await this.db.auth
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        status: schema.organizations.status,
        resellerId: schema.organizations.resellerId,
      })
      .from(schema.organizations)
      .where(inArray(schema.organizations.id, orgIds));
    const orgById = new Map(orgs.map((o) => [o.id, o]));

    const resellerIds = [...new Set(orgs.map((o) => o.resellerId).filter(Boolean))] as string[];
    const resellers =
      resellerIds.length === 0
        ? []
        : await this.db.auth
            .select({
              id: schema.resellers.id,
              name: schema.resellers.name,
              isPlatformDefault: schema.resellers.isPlatformDefault,
            })
            .from(schema.resellers)
            .where(inArray(schema.resellers.id, resellerIds));
    const resellerById = new Map(resellers.map((r) => [r.id, r]));

    return domainRecords.map((row) => {
      const org = orgById.get(row.orgId);
      const reseller = org?.resellerId ? resellerById.get(org.resellerId) : undefined;
      return {
        id: row.id,
        domain: row.domain,
        domainType: row.domainType,
        status: row.status,
        verificationMethod: row.verificationMethod,
        verificationStatus: row.verificationStatus,
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
        isPrimary: row.isPrimary,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        challenge: challengeSummary(this.challengeInput(row), now),
        organization: {
          id: row.orgId,
          name: org?.name ?? '',
          slug: org?.slug ?? '',
          status: org?.status ?? 'unknown',
        },
        reseller: reseller
          ? { id: reseller.id, name: reseller.name, isPlatformDefault: reseller.isPlatformDefault }
          : null,
      };
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string, max = 64): string | null {
  const value = record[key];
  return typeof value === 'string' ? value.slice(0, max) : null;
}
