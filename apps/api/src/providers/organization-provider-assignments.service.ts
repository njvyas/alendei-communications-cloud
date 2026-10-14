import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  type AssignmentStatus,
  type AuthPrincipal,
  type OrganizationProviderAssignment,
  type PageInfo,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, ne, type SQL } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { ProviderAccess } from './provider-access.service';
import type {
  CreateOrganizationProviderAssignmentDto,
  ListOrganizationProviderAssignmentsQueryDto,
  UpdateOrganizationProviderAssignmentDto,
} from './organization-provider-assignments.dto';

export function formatAssignment(
  row: typeof schema.organizationProviderAssignments.$inferSelect,
): OrganizationProviderAssignment {
  return {
    id: row.id,
    orgId: row.orgId,
    providerId: row.providerId,
    channelId: row.channelId,
    priority: row.priority,
    status: row.status as AssignmentStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Organization Provider Assignments service (Phase 3.2, ADR-014 §4, P3-D01–D05).
 *
 * Couples the platform provider catalogue to tenant organizations.
 * Administration is platform-scoped only (`providers.manage` / `providers.read`).
 */
@Injectable()
export class OrganizationProviderAssignmentsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly access: ProviderAccess,
    private readonly lists: ListQuery,
  ) {}

  private readonly assignmentListSpec: ListQuerySpec = {
    sortable: {
      priority: {
        column: schema.organizationProviderAssignments.priority,
        encode: (row) => String((row as unknown as Record<string, unknown>).priority),
      },
      createdAt: {
        column: schema.organizationProviderAssignments.createdAt,
        encode: (row) => String((row as unknown as Record<string, unknown>).id),
      },
    },
    defaultSort: 'priority',
    tieBreaker: schema.organizationProviderAssignments.id,
  };

  /**
   * List assignments for an organization with optional filters.
   */
  async listAssignments(
    principal: AuthPrincipal,
    orgId: string,
    filter: ListOrganizationProviderAssignmentsQueryDto = {},
  ): Promise<{ items: readonly OrganizationProviderAssignment[]; page: PageInfo }> {
    const resolved = this.lists.resolve(filter, this.assignmentListSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);

      // Verify target organization exists
      const [org] = await tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      if (!org) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: `Organization ${orgId} was not found`,
        });
      }

      const conditions: SQL[] = [eq(schema.organizationProviderAssignments.orgId, orgId)];
      if (filter.channelId) {
        conditions.push(eq(schema.organizationProviderAssignments.channelId, filter.channelId));
      }
      if (filter.status) {
        conditions.push(eq(schema.organizationProviderAssignments.status, filter.status));
      }
      if (resolved.after) {
        conditions.push(resolved.after);
      }

      return tx
        .select()
        .from(schema.organizationProviderAssignments)
        .where(and(...conditions))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });

    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.assignmentListSpec,
      (row) => String(row.id),
    );

    return {
      items: items.map((row) => formatAssignment(row as never)),
      page,
    };
  }

  /**
   * Get an assignment by id.
   */
  async getAssignment(
    principal: AuthPrincipal,
    orgId: string,
    id: string,
  ): Promise<OrganizationProviderAssignment> {
    return this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);

      const [assignment] = await tx
        .select()
        .from(schema.organizationProviderAssignments)
        .where(
          and(
            eq(schema.organizationProviderAssignments.id, id),
            eq(schema.organizationProviderAssignments.orgId, orgId),
          ),
        );

      if (!assignment) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.PROVIDER_ASSIGNMENT_NOT_FOUND,
          message: `Provider assignment ${id} was not found for organization ${orgId}`,
        });
      }

      return formatAssignment(assignment);
    });
  }

  /**
   * Create an assignment for an organization.
   */
  async createAssignment(
    principal: AuthPrincipal,
    orgId: string,
    dto: CreateOrganizationProviderAssignmentDto,
  ): Promise<OrganizationProviderAssignment> {
    const created = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);

      // 1. Verify organization exists
      const [org] = await tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId));
      if (!org) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: `Organization ${orgId} was not found`,
        });
      }

      // 2. Verify provider exists and retrieve channelId
      const [provider] = await tx
        .select({ id: schema.providers.id, channelId: schema.providers.channelId })
        .from(schema.providers)
        .where(eq(schema.providers.id, dto.providerId));
      if (!provider) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: `Provider ${dto.providerId} was not found`,
        });
      }

      // 3. Check duplicate provider assignment conflict
      const [existingAssignment] = await tx
        .select({ id: schema.organizationProviderAssignments.id })
        .from(schema.organizationProviderAssignments)
        .where(
          and(
            eq(schema.organizationProviderAssignments.orgId, orgId),
            eq(schema.organizationProviderAssignments.providerId, dto.providerId),
          ),
        );
      if (existingAssignment) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.PROVIDER_ASSIGNMENT_CONFLICT,
          message: `Provider ${dto.providerId} is already assigned to organization ${orgId}`,
        });
      }

      // 4. Check duplicate priority conflict for (org_id, channel_id, priority)
      const [existingPriority] = await tx
        .select({ id: schema.organizationProviderAssignments.id })
        .from(schema.organizationProviderAssignments)
        .where(
          and(
            eq(schema.organizationProviderAssignments.orgId, orgId),
            eq(schema.organizationProviderAssignments.channelId, provider.channelId),
            eq(schema.organizationProviderAssignments.priority, dto.priority),
          ),
        );
      if (existingPriority) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.ASSIGNMENT_PRIORITY_CONFLICT,
          message: `Priority ${dto.priority} is already in use for channel ${provider.channelId} in organization ${orgId}`,
        });
      }

      // 5. Insert new assignment
      const [row] = await tx
        .insert(schema.organizationProviderAssignments)
        .values({
          orgId,
          providerId: dto.providerId,
          channelId: provider.channelId,
          priority: dto.priority,
          status: dto.status ?? 'active',
        })
        .returning();

      const formatted = formatAssignment(row!);

      // 6. Audit write at platform scope
      await this.access.recordAssignment(
        tx,
        principal,
        AUDIT_ACTIONS.ORGANIZATION_PROVIDER_ASSIGNED,
        formatted.id,
        null,
        formatted as unknown as Record<string, unknown>,
      );

      return formatted;
    });

    return created;
  }

  /**
   * Update an assignment (priority and/or status).
   */
  async updateAssignment(
    principal: AuthPrincipal,
    orgId: string,
    id: string,
    dto: UpdateOrganizationProviderAssignmentDto,
  ): Promise<OrganizationProviderAssignment> {
    const updated = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);

      const [current] = await tx
        .select()
        .from(schema.organizationProviderAssignments)
        .where(
          and(
            eq(schema.organizationProviderAssignments.id, id),
            eq(schema.organizationProviderAssignments.orgId, orgId),
          ),
        )
        .for('update');

      if (!current) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.PROVIDER_ASSIGNMENT_NOT_FOUND,
          message: `Provider assignment ${id} was not found for organization ${orgId}`,
        });
      }

      // If priority is changing, check for conflict
      if (dto.priority !== undefined && dto.priority !== current.priority) {
        const [conflict] = await tx
          .select({ id: schema.organizationProviderAssignments.id })
          .from(schema.organizationProviderAssignments)
          .where(
            and(
              eq(schema.organizationProviderAssignments.orgId, orgId),
              eq(schema.organizationProviderAssignments.channelId, current.channelId),
              eq(schema.organizationProviderAssignments.priority, dto.priority),
              ne(schema.organizationProviderAssignments.id, id),
            ),
          );
        if (conflict) {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.ASSIGNMENT_PRIORITY_CONFLICT,
            message: `Priority ${dto.priority} is already in use for channel ${current.channelId} in organization ${orgId}`,
          });
        }
      }

      const [row] = await tx
        .update(schema.organizationProviderAssignments)
        .set({
          priority: dto.priority ?? current.priority,
          status: dto.status ?? current.status,
        })
        .where(
          and(
            eq(schema.organizationProviderAssignments.id, id),
            eq(schema.organizationProviderAssignments.orgId, orgId),
          ),
        )
        .returning();

      const before = formatAssignment(current);
      const after = formatAssignment(row!);

      await this.access.recordAssignment(
        tx,
        principal,
        AUDIT_ACTIONS.ORGANIZATION_PROVIDER_UPDATED,
        after.id,
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
      );

      return after;
    });

    return updated;
  }

  /**
   * Enable or disable an assignment.
   */
  async transitionAssignment(
    principal: AuthPrincipal,
    orgId: string,
    id: string,
    targetStatus: 'active' | 'disabled',
  ): Promise<OrganizationProviderAssignment> {
    const updated = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);

      const [current] = await tx
        .select()
        .from(schema.organizationProviderAssignments)
        .where(
          and(
            eq(schema.organizationProviderAssignments.id, id),
            eq(schema.organizationProviderAssignments.orgId, orgId),
          ),
        )
        .for('update');

      if (!current) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.PROVIDER_ASSIGNMENT_NOT_FOUND,
          message: `Provider assignment ${id} was not found for organization ${orgId}`,
        });
      }

      if (current.status === targetStatus) {
        return formatAssignment(current);
      }

      const [row] = await tx
        .update(schema.organizationProviderAssignments)
        .set({ status: targetStatus })
        .where(
          and(
            eq(schema.organizationProviderAssignments.id, id),
            eq(schema.organizationProviderAssignments.orgId, orgId),
          ),
        )
        .returning();

      const before = formatAssignment(current);
      const after = formatAssignment(row!);
      const action =
        targetStatus === 'disabled'
          ? AUDIT_ACTIONS.ORGANIZATION_PROVIDER_DISABLED
          : AUDIT_ACTIONS.ORGANIZATION_PROVIDER_ENABLED;

      await this.access.recordAssignment(
        tx,
        principal,
        action,
        after.id,
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
      );

      return after;
    });

    return updated;
  }
}
