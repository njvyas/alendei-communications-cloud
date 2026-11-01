import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  maskRecipientAddress,
  type AuthPrincipal,
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
          createdAt: string;
          updatedAt: string;
        }>(
          sql`SELECT id, name, slug, status, reseller_id as "resellerId", created_at as "createdAt", updated_at as "updatedAt" FROM organizations WHERE id = ${orgId}`,
        );

        const org = orgResult.rows[0];
        if (!org) {
          throw new AppException({
            status: HttpStatus.NOT_FOUND,
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: `Organization ${orgId} not found`,
          });
        }

        let brandConfig: Record<string, unknown> | null = null;

        // Parent reseller if applicable
        let parentReseller: { id: string; name: string; slug: string } | null = null;
        if (org.resellerId) {
          const resResult = await tx.execute<{
            id: string;
            name: string;
            slug: string;
            brandConfig: Record<string, unknown> | null;
          }>(
            sql`SELECT id, name, slug, brand_config as "brandConfig" FROM resellers WHERE id = ${org.resellerId}`,
          );
          if (resResult.rows[0]) {
            parentReseller = {
              id: resResult.rows[0].id,
              name: resResult.rows[0].name,
              slug: resResult.rows[0].slug,
            };
            brandConfig = resResult.rows[0].brandConfig;
          }
        }

        // Child customer organizations if organization is a reseller
        let customerOrganizations: { id: string; name: string; slug: string; status: string }[] =
          [];
        const resOrgResult = await tx.execute<{
          id: string;
          brandConfig: Record<string, unknown> | null;
        }>(sql`SELECT id, brand_config as "brandConfig" FROM resellers WHERE id = ${orgId}`);
        if (resOrgResult.rows.length > 0) {
          brandConfig = resOrgResult.rows[0]?.brandConfig ?? brandConfig;
          const custResult = await tx.execute<{
            id: string;
            name: string;
            slug: string;
            status: string;
          }>(
            sql`SELECT id, name, slug, status FROM organizations WHERE reseller_id = ${orgId} ORDER BY name ASC`,
          );
          customerOrganizations = custResult.rows;
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
            type: org.resellerId ? 'customer' : 'direct',
            resellerId: org.resellerId,
            brandConfig,
            createdAt: org.createdAt,
            updatedAt: org.updatedAt,
          },
          parentReseller,
          customerOrganizations,
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
          circuitState: string;
          failureCount: number;
          lastFailureAt: string | null;
        }>(
          sql`
            SELECT
              p.id as "providerId",
              p.name as "providerName",
              c.code as "channel",
              p.status,
              p.health_state as "healthState",
              p.circuit_state as "circuitState",
              coalesce(p.circuit_generation, 0)::int as "failureCount",
              p.circuit_changed_at as "lastFailureAt"
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

        const limit = query.limit ?? 20;
        const diagResult = await tx.execute<{
          diagnostics: {
            queue: {
              pendingCount: number;
              claimedCount: number;
              delayedCount: number;
            };
            recentFailures: {
              messageId: string;
              channel: string;
              status: string;
              failureReason: string | null;
              failureCategory: string | null;
              recipientAddress: string;
              createdAt: string;
              updatedAt: string;
              lastAttemptAt: string | null;
              providerAttempts: {
                attemptNumber: number;
                providerId: string;
                providerType: string;
                errorType: string | null;
                httpStatus: number | null;
                latencyMs: number | null;
                attemptedAt: string;
              }[];
            }[];
          };
        }>(
          sql`SELECT app_platform_support_dispatch_diagnostics(
            ${orgId}::uuid,
            ${query.channel ?? null},
            ${query.status ?? null},
            ${limit}::integer
          ) AS diagnostics`,
        );

        const data = diagResult.rows[0]?.diagnostics ?? {
          queue: { pendingCount: 0, claimedCount: 0, delayedCount: 0 },
          recentFailures: [],
        };

        const recentFailures = (data.recentFailures ?? []).map((f) => ({
          messageId: f.messageId,
          channel: f.channel,
          status: f.status,
          failureReason: f.failureReason,
          failureCategory: f.failureCategory,
          attemptCount: f.providerAttempts?.length ?? 0,
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
          lastAttemptAt: f.lastAttemptAt,
          maskedRecipient: maskRecipientAddress(f.recipientAddress),
          providerAttempts: f.providerAttempts ?? [],
        }));

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
              limit: query.limit,
            },
            outcome: 'success',
            before: null,
            after: null,
          },
          tx,
        );

        return {
          queue: data.queue,
          recentFailures,
        };
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
            ip: schema.auditLogs.ip,
            userAgent: schema.auditLogs.userAgent,
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
            metadata: {
              tool: 'audit_search',
              orgId: query.orgId ?? null,
              action: query.action ?? null,
              limit: query.limit,
              cursor: query.cursor ?? null,
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
      ip: string | null;
      userAgent: string | null;
    }

    const auditRowsTyped = rawItems as unknown as RawAuditRow[];

    // Released tenant transaction connection before querying auth database
    const actorUserIds = [
      ...new Set(
        auditRowsTyped.map((r) => r.actorUserId).filter((id): id is string => Boolean(id)),
      ),
    ];
    const emailMap = new Map<string, string>();

    if (actorUserIds.length > 0) {
      const usersResult = await this.db.auth
        .select({ id: schema.users.id, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, actorUserIds));
      for (const u of usersResult) {
        emailMap.set(u.id, u.email);
      }
    }

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
      actorEmail: r.actorUserId ? (emailMap.get(String(r.actorUserId)) ?? null) : null,
      resourceType: String(r.resourceType),
      resourceId: r.resourceId ? String(r.resourceId) : null,
      scopeType: String(r.scopeType),
      scopeId: r.scopeId ? String(r.scopeId) : null,
      orgId: r.orgId ? String(r.orgId) : null,
      orgName: r.orgId ? (orgNameMap.get(String(r.orgId)) ?? null) : null,
      metadata: (r.metadata ? redact(r.metadata) : {}) as Record<string, unknown>,
      ip: r.ip ? String(r.ip) : null,
      userAgent: r.userAgent ? String(r.userAgent) : null,
    }));

    return { data: items, page };
  }
}
