import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  grantConfers,
  type AuditAction,
  type PageInfo,
  type ResellerOrganizationView,
  type ResellerStatus,
  type ResellerView,
} from '@acc/contracts';
import { schema, type TenantSession } from '@acc/db';
import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../../audit/audit-actor';
import { AuditWriter } from '../../audit/audit-writer.service';
import type { ResolvedPrincipal } from '../../auth/auth.guard';
import { AuthorizationService } from '../../auth/authorization.service';
import { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../../common/http/list-query';
import { TenantDatabase } from '../../database/tenant-database.service';
import type { CreateResellerDto, ListResellersQueryDto, UpdateResellerDto } from './reseller.dto';

type ResellerTransition = 'suspend' | 'reactivate';

const TRANSITIONS: Readonly<
  Record<
    ResellerTransition,
    { from: readonly ResellerStatus[]; to: ResellerStatus; action: AuditAction }
  >
> = {
  suspend: { from: ['active'], to: 'suspended', action: AUDIT_ACTIONS.RESELLER_SUSPENDED },
  reactivate: { from: ['suspended'], to: 'active', action: AUDIT_ACTIONS.RESELLER_REACTIVATED },
};

@Injectable()
export class ResellersService {
  private readonly logger = new Logger(ResellersService.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.resellers.name, encode: (row) => String(row.name) },
      createdAt: { column: schema.resellers.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.resellers.id,
  };

  private readonly orgListSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.organizations.name, encode: (row) => String(row.name) },
      createdAt: { column: schema.organizations.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.organizations.id,
  };

  /**
   * Determine whether caller holds platform-wide read reach or specific reseller read reach.
   */
  private readReach(principal: ResolvedPrincipal): {
    everything: boolean;
    resellerIds: string[];
  } {
    if (principal.tenant.isPlatformAdmin) return { everything: true, resellerIds: [] };

    // Check grants conferring resellers.read or platform tenant read/manage
    const carrying = principal.roles.filter(
      (g) =>
        grantConfers(g, PERMISSIONS.RESELLERS_READ) ||
        grantConfers(g, PERMISSIONS.PLATFORM_TENANTS_READ) ||
        grantConfers(g, PERMISSIONS.PLATFORM_TENANTS_MANAGE),
    );

    if (carrying.some((g) => g.scopeType === 'platform')) {
      return { everything: true, resellerIds: [] };
    }

    const resellerIds = [
      ...new Set(
        carrying.filter((g) => g.scopeType === 'reseller' && g.scopeId).map((g) => g.scopeId!),
      ),
    ];

    if (resellerIds.length === 0) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to view resellers',
      });
    }

    return { everything: false, resellerIds };
  }

  /**
   * List resellers visible within caller reach.
   */
  async list(
    principal: ResolvedPrincipal,
    filter: ListResellersQueryDto = {},
  ): Promise<{ items: readonly ResellerView[]; page: PageInfo }> {
    RequestContext.recordAuthorizationCheck(PERMISSIONS.RESELLERS_READ);
    const reach = this.readReach(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const predicates: SQL[] = [];
    if (!reach.everything) {
      if (reach.resellerIds.length > 0) {
        predicates.push(inArray(schema.resellers.id, reach.resellerIds));
      } else {
        predicates.push(sql`false`);
      }
    }
    if (filter.status) {
      predicates.push(eq(schema.resellers.status, filter.status));
    }
    if (resolved.after) {
      predicates.push(resolved.after);
    }

    // Step 1: Query candidates with acc_auth
    const candidates = await this.db.auth
      .select({
        id: schema.resellers.id,
        name: schema.resellers.name,
      })
      .from(schema.resellers)
      .where(predicates.length > 0 ? and(...predicates) : undefined)
      .orderBy(...resolved.orderBy)
      .limit(this.lists.fetchSize(resolved));

    const { items, page } = this.lists.paginate(candidates, resolved, this.listSpec, (row) =>
      String(row.id),
    );

    const ids = items.map((r) => r.id);
    if (ids.length === 0) {
      return { items: [], page };
    }

    // Step 2: Fetch full rows under RLS as acc_app
    const rows = await this.fetchUnderRls(principal, ids);
    const ordered = ids.map((id) => rows.get(id)).filter((r): r is ResellerView => !!r);

    return { items: ordered, page };
  }

  /**
   * Retrieve a single reseller by ID.
   */
  async get(principal: ResolvedPrincipal, id: string): Promise<ResellerView> {
    RequestContext.recordAuthorizationCheck(PERMISSIONS.RESELLERS_READ);
    const reach = this.readReach(principal);
    if (!reach.everything && !reach.resellerIds.includes(id)) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESELLER_NOT_FOUND,
        message: 'Reseller not found',
      });
    }

    const rows = await this.fetchUnderRls(principal, [id]);
    const reseller = rows.get(id);
    if (!reseller) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESELLER_NOT_FOUND,
        message: 'Reseller not found',
      });
    }

    return reseller;
  }

  /**
   * Create a new reseller (platform administrator only).
   */
  async create(principal: ResolvedPrincipal, dto: CreateResellerDto): Promise<ResellerView> {
    RequestContext.recordAuthorizationCheck(PERMISSIONS.PLATFORM_TENANTS_MANAGE);
    if (!principal.userId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'Resellers can only be created by a signed-in user',
      });
    }

    const authSession: TenantSession = {
      orgId: null,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
      resellerId: null,
    };

    return this.db.withTenant(authSession, async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
        target: { scopeType: 'platform', scopeId: null },
        resourceType: 'Reseller',
      });

      // Check slug uniqueness
      const [existingSlug] = await tx
        .select({ id: schema.resellers.id })
        .from(schema.resellers)
        .where(eq(schema.resellers.slug, dto.slug))
        .limit(1);

      if (existingSlug) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
          message: `Reseller slug "${dto.slug}" is already in use`,
        });
      }

      // Check domain uniqueness if provided
      if (dto.domain) {
        const [existingDomain] = await tx
          .select({ id: schema.resellers.id })
          .from(schema.resellers)
          .where(eq(schema.resellers.domain, dto.domain.toLowerCase()))
          .limit(1);

        if (existingDomain) {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.RESOURCE_CONFLICT,
            message: `Domain "${dto.domain}" is already registered to another reseller`,
          });
        }
      }

      const resellerId = uuidv7();
      const markupPct = dto.defaultMarkupPct ? String(dto.defaultMarkupPct) : '0';
      const brandConfig = dto.brandConfig
        ? (dto.brandConfig as unknown as Record<string, unknown>)
        : {};

      const [inserted] = await tx
        .insert(schema.resellers)
        .values({
          id: resellerId,
          name: dto.name,
          slug: dto.slug,
          domain: dto.domain ? dto.domain.toLowerCase() : null,
          defaultMarkupPct: markupPct,
          brandConfig,
          status: 'active',
          isPlatformDefault: false,
        })
        .returning();

      if (!inserted) {
        throw new AppException({
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Failed to create reseller',
        });
      }

      const view: ResellerView = {
        id: inserted.id,
        name: inserted.name,
        slug: inserted.slug,
        domain: inserted.domain,
        brandConfig: inserted.brandConfig as Record<string, unknown>,
        defaultMarkupPct: inserted.defaultMarkupPct,
        status: inserted.status,
        isPlatformDefault: inserted.isPlatformDefault,
        customerCount: 0,
        createdAt: inserted.createdAt.toISOString(),
        updatedAt: inserted.updatedAt.toISOString(),
      };

      await this.audit.record(
        {
          scopeType: 'reseller',
          scopeId: inserted.id,
          action: AUDIT_ACTIONS.RESELLER_CREATED,
          resourceType: 'Reseller',
          resourceId: inserted.id,
          outcome: 'success',
          ...actorFromPrincipal(principal),
          before: null,
          after: { ...view },
          metadata: {
            name: dto.name,
            slug: dto.slug,
            domain: dto.domain ?? null,
            defaultMarkupPct: markupPct,
          },
        },
        tx,
      );

      return view;
    });
  }

  /**
   * Update reseller details.
   */
  async update(
    principal: ResolvedPrincipal,
    id: string,
    dto: UpdateResellerDto,
  ): Promise<ResellerView> {
    RequestContext.recordAuthorizationCheck(PERMISSIONS.RESELLERS_UPDATE);
    const isPlatformAdmin = principal.tenant.isPlatformAdmin || this.holdsPlatformManage(principal);

    const authSession: TenantSession = {
      orgId: null,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin,
      resellerId: id,
    };

    return this.db.withTenant(authSession, async (tx) => {
      // Must hold resellers.update at this reseller scope or platform.tenants.manage
      await this.authorization.assert(tx, {
        principal,
        permission: isPlatformAdmin
          ? PERMISSIONS.PLATFORM_TENANTS_MANAGE
          : PERMISSIONS.RESELLERS_UPDATE,
        target: isPlatformAdmin
          ? { scopeType: 'platform', scopeId: null }
          : { scopeType: 'reseller', scopeId: id },
        resourceType: 'Reseller',
      });

      const [existing] = await tx
        .select()
        .from(schema.resellers)
        .where(eq(schema.resellers.id, id))
        .limit(1);

      if (!existing) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESELLER_NOT_FOUND,
          message: 'Reseller not found',
        });
      }

      // Non-platform admin cannot modify domain
      if (dto.domain !== undefined && !isPlatformAdmin) {
        throw new AppException({
          status: HttpStatus.FORBIDDEN,
          code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
          message: 'Only platform administrators can modify reseller custom domains',
        });
      }

      if (dto.domain && dto.domain.toLowerCase() !== existing.domain) {
        const [domainConflict] = await tx
          .select({ id: schema.resellers.id })
          .from(schema.resellers)
          .where(eq(schema.resellers.domain, dto.domain.toLowerCase()))
          .limit(1);

        if (domainConflict && domainConflict.id !== id) {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.RESOURCE_CONFLICT,
            message: `Domain "${dto.domain}" is already registered to another reseller`,
          });
        }
      }

      const updates: Partial<typeof schema.resellers.$inferInsert> = {};
      if (dto.name !== undefined) updates.name = dto.name;
      if (dto.domain !== undefined) updates.domain = dto.domain ? dto.domain.toLowerCase() : null;
      if (dto.defaultMarkupPct !== undefined)
        updates.defaultMarkupPct = String(dto.defaultMarkupPct);
      if (dto.brandConfig !== undefined) {
        updates.brandConfig = {
          ...(existing.brandConfig as Record<string, unknown>),
          ...(dto.brandConfig as unknown as Record<string, unknown>),
        };
      }

      const [updated] = await tx
        .update(schema.resellers)
        .set(updates)
        .where(eq(schema.resellers.id, id))
        .returning();

      if (!updated) {
        throw new AppException({
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Failed to update reseller',
        });
      }

      const [customerCountRow] = await tx
        .select({ count: count() })
        .from(schema.organizations)
        .where(eq(schema.organizations.resellerId, id));

      const view: ResellerView = {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        domain: updated.domain,
        brandConfig: updated.brandConfig as Record<string, unknown>,
        defaultMarkupPct: updated.defaultMarkupPct,
        status: updated.status,
        isPlatformDefault: updated.isPlatformDefault,
        customerCount: Number(customerCountRow?.count ?? 0),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      };

      await this.audit.record(
        {
          scopeType: 'reseller',
          scopeId: id,
          action: AUDIT_ACTIONS.RESELLER_UPDATED,
          resourceType: 'Reseller',
          resourceId: id,
          outcome: 'success',
          ...actorFromPrincipal(principal),
          before: {
            name: existing.name,
            domain: existing.domain,
            defaultMarkupPct: existing.defaultMarkupPct,
          },
          after: { ...view },
          metadata: { updates: Object.keys(updates) },
        },
        tx,
      );

      return view;
    });
  }

  /**
   * Transition reseller lifecycle status (suspend, reactivate).
   */
  async transition(
    principal: ResolvedPrincipal,
    id: string,
    action: ResellerTransition,
    reason?: string | null,
  ): Promise<ResellerView> {
    RequestContext.recordAuthorizationCheck(PERMISSIONS.PLATFORM_TENANTS_MANAGE);
    const authSession: TenantSession = {
      orgId: null,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin: principal.tenant.isPlatformAdmin,
      resellerId: null,
    };

    return this.db.withTenant(authSession, async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.PLATFORM_TENANTS_MANAGE,
        target: { scopeType: 'platform', scopeId: null },
        resourceType: 'Reseller',
      });

      const [reseller] = await tx
        .select()
        .from(schema.resellers)
        .where(eq(schema.resellers.id, id))
        .limit(1);

      if (!reseller) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESELLER_NOT_FOUND,
          message: 'Reseller not found',
        });
      }

      if (reseller.isPlatformDefault) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
          message: 'The platform default reseller cannot be suspended or transitioned',
        });
      }

      const rule = TRANSITIONS[action];
      if (!rule.from.includes(reseller.status)) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESELLER_LIFECYCLE_CONFLICT,
          message: `Cannot ${action} reseller in "${reseller.status}" state`,
        });
      }

      const [updated] = await tx
        .update(schema.resellers)
        .set({
          status: rule.to,
        })
        .where(eq(schema.resellers.id, id))
        .returning();

      if (!updated) {
        throw new AppException({
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ERROR_CODES.INTERNAL_ERROR,
          message: `Failed to ${action} reseller`,
        });
      }

      const [customerCountRow] = await tx
        .select({ count: count() })
        .from(schema.organizations)
        .where(eq(schema.organizations.resellerId, id));

      const view: ResellerView = {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        domain: updated.domain,
        brandConfig: updated.brandConfig as Record<string, unknown>,
        defaultMarkupPct: updated.defaultMarkupPct,
        status: updated.status,
        isPlatformDefault: updated.isPlatformDefault,
        customerCount: Number(customerCountRow?.count ?? 0),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      };

      await this.audit.record(
        {
          scopeType: 'reseller',
          scopeId: id,
          action: rule.action,
          resourceType: 'Reseller',
          resourceId: id,
          outcome: 'success',
          ...actorFromPrincipal(principal),
          before: { status: reseller.status },
          after: { status: rule.to },
          metadata: {
            previousStatus: reseller.status,
            newStatus: rule.to,
            reason: reason ?? null,
          },
        },
        tx,
      );

      return view;
    });
  }

  /**
   * List customer organizations belonging to a reseller.
   */
  async listOrganizations(
    principal: ResolvedPrincipal,
    resellerId: string,
    filter: ListQueryInput = {},
  ): Promise<{ items: readonly ResellerOrganizationView[]; page: PageInfo }> {
    RequestContext.recordAuthorizationCheck(PERMISSIONS.RESELLERS_READ);
    const reach = this.readReach(principal);
    if (!reach.everything && !reach.resellerIds.includes(resellerId)) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESELLER_NOT_FOUND,
        message: 'Reseller not found',
      });
    }

    const existing = await this.fetchUnderRls(principal, [resellerId]);
    if (!existing.has(resellerId)) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESELLER_NOT_FOUND,
        message: 'Reseller not found',
      });
    }

    const isPlatformAdmin = principal.tenant.isPlatformAdmin || this.holdsPlatformManage(principal);

    const authSession: TenantSession = {
      orgId: null,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin,
      resellerId,
    };

    return this.db.withTenant(authSession, async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: isPlatformAdmin
          ? PERMISSIONS.PLATFORM_TENANTS_READ
          : PERMISSIONS.RESELLERS_READ,
        target: isPlatformAdmin
          ? { scopeType: 'platform', scopeId: null }
          : { scopeType: 'reseller', scopeId: resellerId },
        resourceType: 'Reseller',
      });

      const resolved = this.lists.resolve(filter, this.orgListSpec);

      const predicates: SQL[] = [eq(schema.organizations.resellerId, resellerId)];
      if (resolved.after) {
        predicates.push(resolved.after);
      }

      const rows = await tx
        .select({
          id: schema.organizations.id,
          name: schema.organizations.name,
          slug: schema.organizations.slug,
          status: schema.organizations.status,
          createdAt: schema.organizations.createdAt,
          updatedAt: schema.organizations.updatedAt,
        })
        .from(schema.organizations)
        .where(and(...predicates))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));

      const { items, page } = this.lists.paginate(rows, resolved, this.orgListSpec, (row) =>
        String(row.id),
      );

      const customerOrgs: ResellerOrganizationView[] = items.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        status: org.status,
        createdAt: org.createdAt.toISOString(),
        updatedAt: org.updatedAt.toISOString(),
      }));

      return { items: customerOrgs, page };
    });
  }

  private holdsPlatformManage(principal: ResolvedPrincipal): boolean {
    return principal.roles.some(
      (g) =>
        grantConfers(g, PERMISSIONS.PLATFORM_TENANTS_MANAGE) ||
        grantConfers(g, PERMISSIONS.PLATFORM_TENANTS_READ),
    );
  }

  /**
   * Read full reseller rows with customer counts under RLS as acc_app.
   */
  private async fetchUnderRls(
    principal: ResolvedPrincipal,
    ids: readonly string[],
  ): Promise<Map<string, ResellerView>> {
    const isPlatformAdmin = principal.tenant.isPlatformAdmin || this.holdsPlatformManage(principal);

    const authSession: TenantSession = {
      orgId: null,
      workspaceId: null,
      userId: principal.userId,
      isPlatformAdmin,
      resellerId: ids.length === 1 && !isPlatformAdmin ? ids[0]! : null,
    };

    return this.db.withTenant(authSession, async (tx) => {
      const resellerRows = await tx
        .select()
        .from(schema.resellers)
        .where(inArray(schema.resellers.id, [...ids]));

      if (resellerRows.length === 0) return new Map();

      // Query customer organization counts per reseller
      const customerCounts = await tx
        .select({
          resellerId: schema.organizations.resellerId,
          count: count(),
        })
        .from(schema.organizations)
        .where(
          inArray(
            schema.organizations.resellerId,
            resellerRows.map((r) => r.id),
          ),
        )
        .groupBy(schema.organizations.resellerId);

      const countMap = new Map<string, number>();
      for (const row of customerCounts) {
        if (row.resellerId) countMap.set(row.resellerId, Number(row.count));
      }

      const map = new Map<string, ResellerView>();
      for (const r of resellerRows) {
        map.set(r.id, {
          id: r.id,
          name: r.name,
          slug: r.slug,
          domain: r.domain,
          brandConfig: r.brandConfig as Record<string, unknown>,
          defaultMarkupPct: r.defaultMarkupPct,
          status: r.status,
          isPlatformDefault: r.isPlatformDefault,
          customerCount: countMap.get(r.id) ?? 0,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        });
      }

      return map;
    });
  }
}
