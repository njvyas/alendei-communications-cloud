import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  PLATFORM_SUPPORT_FAILURE_CODES,
  type AuthPrincipal,
  type PlatformSupportDispatchAttempt,
  type PlatformSupportDispatchMessage,
  type PlatformSupportFailureCode,
  type PlatformSupportAuditItem,
  type PlatformSupportAuditSearchResponse,
  type PlatformSupportDispatchDiagnostics,
  type PlatformSupportOrgOverview,
  type PlatformSupportRoutingDiagnostics,
} from '@acc/contracts';
import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { schema } from '@acc/db';

import { AppException } from '../common/errors/app.exception';
import { AuthorizationService } from '../auth/authorization.service';
import { TenantDatabase } from '../database/tenant-database.service';
import { AuditWriter } from '../audit/audit-writer.service';
import { actorFromPrincipal } from '../audit/audit-actor';
import { redact } from '../audit/audit-redactor';
import { ListQuery, type ListQuerySpec } from '../common/http/list-query';
import type {
  PlatformSupportAuditSearchQueryDto,
  PlatformSupportDispatchQueryDto,
} from './platform-support.dto';

@Injectable()
export class PlatformSupportService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
  ) {}

  private readonly auditListSpec: ListQuerySpec = {
    sortable: {
      occurredAt: { column: schema.auditLogs.id, encode: (row) => String(row.id) },
    },
    defaultSort: '-occurredAt',
    tieBreaker: schema.auditLogs.id,
  };

  /**
   * Diagnostic Overview for an organization.
   * Inspects organization configuration, hierarchy, workspaces, teams, and high-level metrics.
   */
  async getOrganizationOverview(
    principal: AuthPrincipal,
    orgId: string,
  ): Promise<PlatformSupportOrgOverview> {
    return this.db.withTenant(
      {
        orgId,
        userId: principal.userId,
        isPlatformAdmin: false,
      },
      async (tx) => {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.PLATFORM_SUPPORT_READ,
          target: { scopeType: 'platform', scopeId: null },
          resourceType: 'Platform support',
        });

        const orgResult = await tx.execute<{
          id: string;
          name: string;
          slug: string;
          status: string;
          resellerId: string | null;
          brandConfig: Record<string, unknown> | null;
          createdAt: string;
          updatedAt: string;
        }>(
          sql`SELECT id, name, slug, status, reseller_id as "resellerId", brand_config as "brandConfig", created_at as "createdAt", updated_at as "updatedAt" FROM organizations WHERE id = ${orgId}`,
        );

        const org = orgResult.rows[0];
        if (!org) {
          throw new AppException({
            status: HttpStatus.NOT_FOUND,
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: `Organization ${orgId} not found`,
          });
        }

        // The reseller the organization belongs to (organizations.reseller_id).
        let parentReseller: { id: string; name: string; slug: string } | null = null;
        if (org.resellerId) {
          const resResult = await tx.execute<{ id: string; name: string; slug: string }>(
            sql`SELECT id, name, slug FROM resellers WHERE id = ${org.resellerId}`,
          );
          const reseller = resResult.rows[0];
          if (reseller) {
            parentReseller = { id: reseller.id, name: reseller.name, slug: reseller.slug };
          }
        }

        // Workspaces
        const wsResult = await tx.execute<{
          id: string;
          name: string;
          slug: string;
          status: string;
          createdAt: string;
        }>(
          sql`SELECT id, name, slug, status, created_at as "createdAt" FROM workspaces WHERE org_id = ${orgId} ORDER BY name ASC`,
        );

        const workspaceList = wsResult.rows;
        const workspaceIds = workspaceList.map((w) => w.id);

        // Teams
        let teams: {
          id: string;
          name: string;
          workspaceId: string;
          createdAt: string;
        }[] = [];

        if (workspaceIds.length > 0) {
          const teamResult = await tx.execute<{
            id: string;
            name: string;
            workspaceId: string;
            createdAt: string;
          }>(
            sql`SELECT id, name, workspace_id as "workspaceId", created_at as "createdAt" FROM teams WHERE org_id = ${orgId} ORDER BY name ASC`,
          );
          teams = teamResult.rows;
        }

        const workspaces = workspaceList.map((w) => ({
          ...w,
          teamsCount: teams.filter((t) => t.workspaceId === w.id).length,
        }));

        // Counts & metrics
        const userCountResult = await tx.execute<{
          total_users: string;
          active_users: string;
          disabled_users: string;
        }>(
          sql`
            SELECT
              count(DISTINCT ur.user_id) as total_users,
              count(DISTINCT ur.user_id) filter (WHERE u.status = 'active') as active_users,
              count(DISTINCT ur.user_id) filter (WHERE u.status = 'disabled') as disabled_users
            FROM user_roles ur
            JOIN users u ON u.id = ur.user_id
            WHERE ur.org_id = ${orgId}
          `,
        );

        const apiKeyCountResult = await tx.execute<{ active_keys: string }>(
          sql`SELECT count(*) as active_keys FROM api_keys WHERE org_id = ${orgId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        );

        const sessionCountResult = await tx.execute<{ active_sessions: string }>(
          sql`
            SELECT count(DISTINCT s.id) as active_sessions
            FROM sessions s
            JOIN user_roles ur ON ur.user_id = s.user_id
            WHERE ur.org_id = ${orgId} AND s.expires_at > now() AND s.revoked_at IS NULL
          `,
        );

        const domainCountResult = await tx.execute<{ verified_domains: string }>(
          sql`SELECT count(*) filter (where verification_status = 'verified') as verified_domains FROM organization_domains WHERE org_id = ${orgId}`,
        );

        // Synchronously record diagnostic access
        await this.audit.record(
          {
            ...actorFromPrincipal(principal),
            action: 'platform.support.diagnostic_read',
            resourceType: 'platform_support',
            resourceId: orgId,
            scopeType: 'organization',
            scopeId: orgId,
            metadata: { tool: 'overview' },
            outcome: 'success',
            before: null,
            after: null,
          },
          tx,
        );

        return {
          organization: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            status: org.status,
            resellerId: org.resellerId,
            brandConfig: org.brandConfig ?? {},
            createdAt: org.createdAt,
            updatedAt: org.updatedAt,
          },
          parentReseller,
          workspaces,
          teams,
          metrics: {
            totalUsers: Number(userCountResult.rows[0]?.total_users ?? 0),
            activeUsers: Number(userCountResult.rows[0]?.active_users ?? 0),
            disabledUsers: Number(userCountResult.rows[0]?.disabled_users ?? 0),
            activeApiKeys: Number(apiKeyCountResult.rows[0]?.active_keys ?? 0),
            activeSessions: Number(sessionCountResult.rows[0]?.active_sessions ?? 0),
            verifiedDomains: Number(domainCountResult.rows[0]?.verified_domains ?? 0),
          },
        };
      },
    );
  }

  /**
   * Routing & Provider Assignment Diagnostics.
   * Returns effective channel configurations, active provider assignments, and provider circuit/health status.
   * Redacts all provider credentials, secrets, and auth tokens.
   */
  async getOrganizationRouting(
    principal: AuthPrincipal,
    orgId: string,
  ): Promise<PlatformSupportRoutingDiagnostics> {
    return this.db.withTenant(
      {
        orgId,
        userId: principal.userId,
        isPlatformAdmin: false,
      },
      async (tx) => {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.PLATFORM_SUPPORT_READ,
          target: { scopeType: 'platform', scopeId: null },
          resourceType: 'Platform support',
        });

        const orgResult = await tx.execute<{ id: string }>(
          sql`SELECT id FROM organizations WHERE id = ${orgId}`,
        );
        if (!orgResult.rows[0]) {
          throw new AppException({
            status: HttpStatus.NOT_FOUND,
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: `Organization ${orgId} not found`,
          });
        }

        // Channel configs
        const channelResult = await tx.execute<{
          id: string;
          code: string;
          name: string;
          status: string;
          defaultProviderId: string | null;
          fallbackProviderId: string | null;
        }>(
          sql`
            SELECT
              c.id,
              c.code,
              c.display_name as name,
              c.status,
              (SELECT a.provider_id FROM organization_provider_assignments a WHERE a.org_id = ${orgId} AND a.channel_id = c.id AND a.priority = 1 LIMIT 1) as "defaultProviderId",
              (SELECT a.provider_id FROM organization_provider_assignments a WHERE a.org_id = ${orgId} AND a.channel_id = c.id AND a.priority > 1 ORDER BY a.priority ASC LIMIT 1) as "fallbackProviderId"
            FROM channels c
            ORDER BY c.code ASC
          `,
        );

        // Provider assignments (no secrets / credentials selected!)
        const assignmentResult = await tx.execute<{
          id: string;
          channel: string;
          providerId: string;
          providerName: string;
          providerType: string;
          status: string;
          priority: number;
          isFallback: boolean;
          assignedAt: string;
        }>(
          sql`
            SELECT
              a.id,
              c.code as "channel",
              a.provider_id as "providerId",
              p.name as "providerName",
              p.adapter_key as "providerType",
              a.status,
              a.priority,
              (a.priority > 1) as "isFallback",
              a.created_at as "assignedAt"
            FROM organization_provider_assignments a
            JOIN providers p ON p.id = a.provider_id
            JOIN channels c ON c.id = a.channel_id
            WHERE a.org_id = ${orgId}
            ORDER BY c.code, a.priority ASC
          `,
        );

        // Provider health and circuit breaker status
        const healthResult = await tx.execute<{
          providerId: string;
          providerName: string;
          channel: string;
          status: string;
          healthState: string;
          healthChangedAt: string | null;
          circuitState: string;
          circuitGeneration: number;
          circuitChangedAt: string | null;
        }>(
          sql`
            SELECT
              p.id as "providerId",
              p.name as "providerName",
              c.code as "channel",
              p.status,
              p.health_state as "healthState",
              p.health_changed_at as "healthChangedAt",
              p.circuit_state as "circuitState",
              p.circuit_generation::int as "circuitGeneration",
              p.circuit_changed_at as "circuitChangedAt"
            FROM providers p
            JOIN channels c ON c.id = p.channel_id
            WHERE p.id IN (SELECT provider_id FROM organization_provider_assignments WHERE org_id = ${orgId})
            ORDER BY c.code, p.name ASC
          `,
        );

        // Audit log
        await this.audit.record(
          {
            ...actorFromPrincipal(principal),
            action: 'platform.support.diagnostic_read',
            resourceType: 'platform_support',
            resourceId: orgId,
            scopeType: 'organization',
            scopeId: orgId,
            metadata: { tool: 'routing' },
            outcome: 'success',
            before: null,
            after: null,
          },
          tx,
        );

        return {
          channels: channelResult.rows,
          assignments: assignmentResult.rows,
          providerHealth: healthResult.rows,
        };
      },
    );
  }

  /**
   * Message Dispatch Troubleshooting & Failure Diagnostics.
   * Returns queue counts, recent failed/pending messages, and provider attempt logs.
   * Strictly masks recipient PII and omits message bodies/payloads.
   */
  async getOrganizationDispatch(
    principal: AuthPrincipal,
    orgId: string,
    query: PlatformSupportDispatchQueryDto,
  ): Promise<PlatformSupportDispatchDiagnostics> {
    return this.db.withTenant(
      {
        orgId,
        userId: principal.userId,
        isPlatformAdmin: false,
      },
      async (tx) => {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.PLATFORM_SUPPORT_READ,
          target: { scopeType: 'platform', scopeId: null },
          resourceType: 'Platform support',
        });

        const orgResult = await tx.execute<{ id: string }>(
          sql`SELECT id FROM organizations WHERE id = ${orgId}`,
        );
        if (!orgResult.rows[0]) {
          throw new AppException({
            status: HttpStatus.NOT_FOUND,
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: `Organization ${orgId} not found`,
          });
        }

        // The database function is the content boundary (migration 0040): it
        // returns identifiers, statuses, timings and allowlisted failure codes
        // only. The view below is still built field by field, so nothing the
        // function might add later reaches a response unreviewed.
        const limit = query.limit ?? 20;
        const diagResult = await tx.execute<{ diagnostics: RawDispatchDiagnostics | null }>(
          sql`SELECT app_platform_support_dispatch_diagnostics(
            ${orgId}::uuid,
            ${query.channel ?? null},
            ${query.status ?? null},
            ${limit}::integer
          ) AS diagnostics`,
        );
        const raw = diagResult.rows[0]?.diagnostics;
        const queue = {
          pendingCount: Number(raw?.queue?.pendingCount ?? 0),
          delayedCount: Number(raw?.queue?.delayedCount ?? 0),
          claimedCount: Number(raw?.queue?.claimedCount ?? 0),
        };
        const recentMessages = (raw?.recentMessages ?? []).map(dispatchMessageView);

        // Audit log
        await this.audit.record(
          {
            ...actorFromPrincipal(principal),
            action: 'platform.support.diagnostic_read',
            resourceType: 'platform_support',
            resourceId: orgId,
            scopeType: 'organization',
            scopeId: orgId,
            metadata: {
              tool: 'dispatch',
              channel: query.channel ?? null,
              status: query.status ?? null,
              limit,
            },
            outcome: 'success',
            before: null,
            after: null,
          },
          tx,
        );

        return { queue, recentMessages };
      },
    );
  }

  /**
   * Cross-Tenant Audit Search.
   * Read-only search across audit trails for authorized platform operators.
   * Redacts sensitive credentials, tokens, and keys from payload metadata.
   */
  async searchAuditLogs(
    principal: AuthPrincipal,
    query: PlatformSupportAuditSearchQueryDto,
  ): Promise<PlatformSupportAuditSearchResponse> {
    const { rawItems, page } = await this.db.withTenant(
      {
        orgId: query.orgId ?? null,
        userId: principal.userId,
        isPlatformAdmin: false,
      },
      async (tx) => {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.PLATFORM_SUPPORT_READ,
          target: { scopeType: 'platform', scopeId: null },
          resourceType: 'Platform support',
        });

        if (query.orgId) {
          const orgResult = await tx.execute<{ id: string }>(
            sql`SELECT id FROM organizations WHERE id = ${query.orgId}`,
          );
          if (!orgResult.rows[0]) {
            throw new AppException({
              status: HttpStatus.NOT_FOUND,
              code: ERROR_CODES.RESOURCE_NOT_FOUND,
              message: `Organization ${query.orgId} not found`,
            });
          }
        }

        const resolved = this.lists.resolve(
          {
            cursor: query.cursor,
            limit: query.limit,
            sort: '-occurredAt',
          },
          this.auditListSpec,
        );

        const predicates: SQL[] = [];
        if (query.orgId) {
          predicates.push(eq(schema.auditLogs.orgId, query.orgId));
        }
        if (query.action) {
          predicates.push(eq(schema.auditLogs.action, query.action));
        }
        if (query.actorUserId) {
          predicates.push(eq(schema.auditLogs.actorUserId, query.actorUserId));
        }
        if (query.since) {
          predicates.push(gte(schema.auditLogs.occurredAt, query.since));
        }
        if (query.until) {
          predicates.push(lte(schema.auditLogs.occurredAt, query.until));
        }
        if (resolved.after) {
          predicates.push(resolved.after);
        }

        const auditRows = await tx
          .select({
            id: schema.auditLogs.id,
            occurredAt: schema.auditLogs.occurredAt,
            action: schema.auditLogs.action,
            outcome: schema.auditLogs.outcome,
            actorType: schema.auditLogs.actorType,
            actorUserId: schema.auditLogs.actorUserId,
            resourceType: schema.auditLogs.resourceType,
            resourceId: schema.auditLogs.resourceId,
            scopeType: schema.auditLogs.scopeType,
            scopeId: schema.auditLogs.scopeId,
            orgId: schema.auditLogs.orgId,
            metadata: schema.auditLogs.metadata,
          })
          .from(schema.auditLogs)
          .where(predicates.length > 0 ? and(...predicates) : undefined)
          .orderBy(...resolved.orderBy)
          .limit(this.lists.fetchSize(resolved));

        const paginatedResult = this.lists.paginate(
          auditRows as unknown as Record<string, unknown>[],
          resolved,
          this.auditListSpec,
          (row) => String(row.id),
        );

        // Audit log diagnostic read inside transaction
        await this.audit.record(
          {
            ...actorFromPrincipal(principal),
            action: 'platform.support.diagnostic_read',
            resourceType: 'platform_support',
            resourceId: query.orgId ?? null,
            scopeType: query.orgId ? 'organization' : 'platform',
            scopeId: query.orgId ?? null,
            // The filters as applied; the opaque cursor is reduced to which page.
            metadata: {
              tool: 'audit_search',
              orgId: query.orgId ?? null,
              action: query.action ?? null,
              actorUserId: query.actorUserId ?? null,
              since: query.since ? query.since.toISOString() : null,
              until: query.until ? query.until.toISOString() : null,
              limit: resolved.limit,
              page: query.cursor ? 'next' : 'first',
            },
            outcome: 'success',
            before: null,
            after: null,
          },
          tx,
        );

        return { rawItems: paginatedResult.items, page: paginatedResult.page };
      },
    );

    interface RawAuditRow {
      id: string;
      occurredAt: Date | string;
      action: string;
      outcome: string;
      actorType: string;
      actorUserId: string | null;
      resourceType: string;
      resourceId: string | null;
      scopeType: string;
      scopeId: string | null;
      orgId: string | null;
      metadata: unknown;
    }

    const auditRowsTyped = rawItems as unknown as RawAuditRow[];

    // Organization names, read after the tenant transaction has released its
    // connection. Actor emails, IP addresses and user agents are not returned
    // (data minimisation, U13.4 review F-4).
    const orgIds = [
      ...new Set(auditRowsTyped.map((r) => r.orgId).filter((id): id is string => Boolean(id))),
    ];
    const orgNameMap = new Map<string, string>();
    if (orgIds.length > 0) {
      const orgsResult = await this.db.auth
        .select({ id: schema.organizations.id, name: schema.organizations.name })
        .from(schema.organizations)
        .where(inArray(schema.organizations.id, orgIds));
      for (const o of orgsResult) {
        orgNameMap.set(o.id, o.name);
      }
    }

    const items: PlatformSupportAuditItem[] = auditRowsTyped.map((r) => ({
      id: String(r.id),
      occurredAt: r.occurredAt instanceof Date ? r.occurredAt.toISOString() : String(r.occurredAt),
      action: String(r.action),
      outcome: String(r.outcome),
      actorType: String(r.actorType),
      actorUserId: r.actorUserId ? String(r.actorUserId) : null,
      resourceType: String(r.resourceType),
      resourceId: r.resourceId ? String(r.resourceId) : null,
      scopeType: String(r.scopeType),
      scopeId: r.scopeId ? String(r.scopeId) : null,
      orgId: r.orgId ? String(r.orgId) : null,
      orgName: r.orgId ? (orgNameMap.get(String(r.orgId)) ?? null) : null,
      metadata: minimiseMetadata(r.metadata ? redact(r.metadata) : {}),
    }));

    return { data: items, page };
  }
}

/** The shape `app_platform_support_dispatch_diagnostics()` returns (migration 0040). */
interface RawDispatchDiagnostics {
  readonly queue?: { pendingCount?: number; delayedCount?: number; claimedCount?: number };
  readonly recentMessages?: readonly RawDispatchMessage[];
}
interface RawDispatchMessage {
  readonly messageId: string;
  readonly channel: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly attempts?: readonly RawDispatchAttempt[];
}
interface RawDispatchAttempt {
  readonly attemptNumber: number;
  readonly providerId: string;
  readonly adapterKey: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly latencyMs: number | null;
  readonly attemptedAt: string;
}

const FAILURE_CODES: ReadonlySet<string> = new Set(PLATFORM_SUPPORT_FAILURE_CODES);

/** A code from the closed list, `OTHER` for anything else, `null` for none. */
export function failureCodeView(
  code: string | null | undefined,
): PlatformSupportFailureCode | null {
  if (code === null || code === undefined) return null;
  return FAILURE_CODES.has(code) ? (code as PlatformSupportFailureCode) : 'OTHER';
}

function dispatchAttemptView(a: RawDispatchAttempt): PlatformSupportDispatchAttempt {
  return {
    attemptNumber: Number(a.attemptNumber),
    providerId: String(a.providerId),
    adapterKey: String(a.adapterKey),
    status: String(a.status),
    failureCode: failureCodeView(a.failureCode),
    latencyMs: a.latencyMs === null || a.latencyMs === undefined ? null : Number(a.latencyMs),
    attemptedAt: String(a.attemptedAt),
  };
}

export function dispatchMessageView(m: RawDispatchMessage): PlatformSupportDispatchMessage {
  const attempts = (m.attempts ?? []).map(dispatchAttemptView);
  return {
    messageId: String(m.messageId),
    channel: String(m.channel),
    status: String(m.status),
    failureCode: failureCodeView(m.failureCode),
    createdAt: String(m.createdAt),
    updatedAt: String(m.updatedAt),
    completedAt: m.completedAt ? String(m.completedAt) : null,
    attemptCount: attempts.length,
    attempts,
  };
}

/**
 * Personal-data keys removed from cross-tenant audit metadata (F-4), in
 * addition to the credential redaction `redact` applies. Today's writers keep
 * IP address and user agent in their own columns (not returned) and put no
 * email or recipient in metadata; this holds that for any future writer.
 */
const PERSONAL_METADATA_KEYS: ReadonlySet<string> = new Set([
  'ip',
  'ipaddress',
  'useragent',
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'recipient',
  'recipientaddress',
  'rawaddress',
]);

export function minimiseMetadata(value: unknown): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        if (PERSONAL_METADATA_KEYS.has(k.toLowerCase().replace(/[^a-z]/g, ''))) continue;
        out[k] = walk(inner);
      }
      return out;
    }
    return v;
  };
  const result = walk(value);
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}
