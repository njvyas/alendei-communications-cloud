import { HttpStatus, Inject, Injectable, forwardRef } from '@nestjs/common';
import {
  CUSTOM_FIELD_OPERATORS,
  ERROR_CODES,
  PERMISSIONS,
  type AudienceResolutionResponse,
  type AuthPrincipal,
  type PageInfo,
  type SegmentCriteria,
  type SegmentResponse,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import {
  requireOrganization,
  workspaceNotFound,
} from '../workspaces/workspace-administration.service';
import { ContactsService } from './contacts.service';
import {
  CreateSegmentDto,
  PreviewSegmentDto,
  SegmentCriteriaDto,
  UpdateSegmentDto,
} from './segments.dto';

type SegmentRow = typeof schema.segments.$inferSelect;

function segmentNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.SEGMENT_NOT_FOUND,
    message: 'Segment not found',
    logContext: { requestedSegmentId: id },
  });
}

function segmentView(row: SegmentRow): SegmentResponse {
  return {
    id: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    criteria: (row.criteria as SegmentCriteria) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const FORBIDDEN_CUSTOM_FIELDS = new Set([
  'tags',
  'tag_list',
  'id',
  'orgid',
  'org_id',
  'workspaceid',
  'workspace_id',
  'deletedat',
  'deleted_at',
  'createdat',
  'created_at',
  'updatedat',
  'updated_at',
]);

@Injectable()
export class SegmentsService {
  private readonly listSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.segments.id, encode: (row) => String(row.id) },
      name: { column: schema.segments.name },
      id: { column: schema.segments.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'createdAt',
    tieBreaker: schema.segments.id,
  };

  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly idempotency: IdempotencyService,
    private readonly lists: ListQuery,
    @Inject(forwardRef(() => ContactsService))
    private readonly contactsService: ContactsService,
  ) {}

  private async assertWorkspaceAccess(
    tx: Transaction,
    principal: AuthPrincipal,
    workspaceId: string,
    permission: string,
  ): Promise<void> {
    const orgId = requireOrganization(principal);
    const [workspaceRow] = await tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.orgId, orgId)));
    if (!workspaceRow) throw workspaceNotFound(workspaceId);

    await this.authorization.assert(tx, {
      principal,
      permission,
      target: { scopeType: 'workspace', scopeId: workspaceId },
      resourceType: 'Workspace',
    });
  }

  private validateCriteria(criteria?: SegmentCriteriaDto): void {
    if (!criteria) return;

    if (criteria.customFieldFilters && criteria.customFieldFilters.length > 0) {
      for (const filter of criteria.customFieldFilters) {
        const field = filter.field?.trim();
        if (!field || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(field)) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.SEGMENT_CRITERIA_INVALID,
            message: `Invalid custom field name '${filter.field}' in segment criteria`,
            logContext: { field: filter.field },
          });
        }

        if (FORBIDDEN_CUSTOM_FIELDS.has(field.toLowerCase())) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.SEGMENT_CRITERIA_INVALID,
            message: `Custom field filter cannot target reserved field '${field}'`,
            logContext: { field },
          });
        }

        if (!CUSTOM_FIELD_OPERATORS.includes(filter.operator)) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.SEGMENT_CRITERIA_INVALID,
            message: `Invalid operator '${filter.operator}' in segment criteria`,
            logContext: { operator: filter.operator },
          });
        }

        if (filter.operator !== 'exists' && filter.operator !== 'does_not_exist') {
          if (filter.value === undefined || filter.value === null) {
            throw new AppException({
              status: HttpStatus.BAD_REQUEST,
              code: ERROR_CODES.SEGMENT_CRITERIA_INVALID,
              message: `Operator '${filter.operator}' requires a non-null value in segment criteria`,
              logContext: { operator: filter.operator, field },
            });
          }
        }
      }
    }
  }

  async create(
    principal: AuthPrincipal,
    workspaceId: string,
    dto: CreateSegmentDto,
    idempotencyKey?: string | null,
  ): Promise<IdempotentOutcome<{ data: SegmentResponse }>> {
    const orgId = requireOrganization(principal);
    const trimmedName = dto.name.trim();

    if (!trimmedName) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Segment name cannot be empty',
      });
    }

    this.validateCriteria(dto.criteria);

    const authorize = (tx: Transaction) =>
      this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CONTACTS_MANAGE);

    return this.idempotency.execute({
      key: idempotencyKey ?? null,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: `/workspaces/${workspaceId}/segments`,
        orgId,
        principal,
        pathParams: { workspaceId },
        query: {},
        body: {
          name: trimmedName,
          description: dto.description?.trim() || null,
          criteria: dto.criteria || {},
        },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);

        // Check unique active segment name in workspace
        const [existing] = await tx
          .select({ id: schema.segments.id })
          .from(schema.segments)
          .where(
            and(
              eq(schema.segments.workspaceId, workspaceId),
              sql`lower(${schema.segments.name}) = lower(${trimmedName})`,
              isNull(schema.segments.deletedAt),
            ),
          );

        if (existing) {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.SEGMENT_NAME_EXISTS,
            message: `A segment named '${trimmedName}' already exists in this workspace`,
            logContext: { workspaceId, name: trimmedName },
          });
        }

        const segmentId = uuidv7();
        const [row] = await tx
          .insert(schema.segments)
          .values({
            id: segmentId,
            orgId,
            workspaceId,
            name: trimmedName,
            description: dto.description?.trim() || null,
            criteria: (dto.criteria as unknown as Record<string, unknown>) ?? {},
          })
          .returning();

        if (!row) throw new Error('Failed to insert segment');

        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: workspaceId,
            ...actorFromPrincipal(principal),
            action: 'segment.created',
            resourceType: 'Segment',
            resourceId: row.id,
            outcome: 'success',
            before: null,
            after: null,
            metadata: { name: row.name },
          },
          tx,
        );

        return { data: segmentView(row) };
      },
    });
  }

  async list(
    principal: AuthPrincipal,
    workspaceId: string,
    filter: ListQueryInput = {},
  ): Promise<{ data: readonly SegmentResponse[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CONTACTS_READ);

      const predicates: SQL[] = [
        eq(schema.segments.orgId, orgId),
        eq(schema.segments.workspaceId, workspaceId),
        isNull(schema.segments.deletedAt),
      ];
      if (resolved.after) predicates.push(resolved.after);

      return tx
        .select()
        .from(schema.segments)
        .where(and(...predicates))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });

    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.listSpec,
      (row) => String(row.id),
    );

    return {
      data: items.map((r) => segmentView(r as never)),
      page,
    };
  }

  async get(
    principal: AuthPrincipal,
    workspaceId: string,
    segmentId: string,
  ): Promise<SegmentResponse> {
    const orgId = requireOrganization(principal);

    const [row] = await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CONTACTS_READ);

      return tx
        .select()
        .from(schema.segments)
        .where(
          and(
            eq(schema.segments.id, segmentId),
            eq(schema.segments.orgId, orgId),
            eq(schema.segments.workspaceId, workspaceId),
            isNull(schema.segments.deletedAt),
          ),
        );
    });

    if (!row) throw segmentNotFound(segmentId);
    return segmentView(row);
  }

  async update(
    principal: AuthPrincipal,
    workspaceId: string,
    segmentId: string,
    dto: UpdateSegmentDto,
  ): Promise<SegmentResponse> {
    const orgId = requireOrganization(principal);
    if (dto.criteria) this.validateCriteria(dto.criteria);

    return this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CONTACTS_MANAGE);

      const [existing] = await tx
        .select()
        .from(schema.segments)
        .where(
          and(
            eq(schema.segments.id, segmentId),
            eq(schema.segments.orgId, orgId),
            eq(schema.segments.workspaceId, workspaceId),
            isNull(schema.segments.deletedAt),
          ),
        );

      if (!existing) throw segmentNotFound(segmentId);

      const updates: Partial<typeof schema.segments.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (dto.name !== undefined) {
        const trimmedName = dto.name.trim();
        if (!trimmedName) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.VALIDATION_FAILED,
            message: 'Segment name cannot be empty',
          });
        }

        if (trimmedName.toLowerCase() !== existing.name.toLowerCase()) {
          const [dup] = await tx
            .select({ id: schema.segments.id })
            .from(schema.segments)
            .where(
              and(
                eq(schema.segments.workspaceId, workspaceId),
                sql`lower(${schema.segments.name}) = lower(${trimmedName})`,
                sql`${schema.segments.id} != ${segmentId}`,
                isNull(schema.segments.deletedAt),
              ),
            );

          if (dup) {
            throw new AppException({
              status: HttpStatus.CONFLICT,
              code: ERROR_CODES.SEGMENT_NAME_EXISTS,
              message: `A segment named '${trimmedName}' already exists in this workspace`,
              logContext: { workspaceId, name: trimmedName },
            });
          }
        }
        updates.name = trimmedName;
      }

      if (dto.description !== undefined) {
        updates.description = dto.description?.trim() || null;
      }

      if (dto.criteria !== undefined) {
        updates.criteria = (dto.criteria as unknown as Record<string, unknown>) ?? {};
      }

      const [updated] = await tx
        .update(schema.segments)
        .set(updates)
        .where(
          and(
            eq(schema.segments.id, segmentId),
            eq(schema.segments.orgId, orgId),
            eq(schema.segments.workspaceId, workspaceId),
            isNull(schema.segments.deletedAt),
          ),
        )
        .returning();

      if (!updated) throw segmentNotFound(segmentId);

      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: workspaceId,
          ...actorFromPrincipal(principal),
          action: 'segment.updated',
          resourceType: 'Segment',
          resourceId: updated.id,
          outcome: 'success',
          before: null,
          after: null,
          metadata: { name: updated.name },
        },
        tx,
      );

      return segmentView(updated);
    });
  }

  async delete(principal: AuthPrincipal, workspaceId: string, segmentId: string): Promise<void> {
    const orgId = requireOrganization(principal);

    await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CONTACTS_MANAGE);

      const [existing] = await tx
        .select({ id: schema.segments.id, name: schema.segments.name })
        .from(schema.segments)
        .where(
          and(
            eq(schema.segments.id, segmentId),
            eq(schema.segments.orgId, orgId),
            eq(schema.segments.workspaceId, workspaceId),
            isNull(schema.segments.deletedAt),
          ),
        );

      if (!existing) throw segmentNotFound(segmentId);

      await tx
        .update(schema.segments)
        .set({ deletedAt: new Date() })
        .where(eq(schema.segments.id, segmentId));

      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: workspaceId,
          ...actorFromPrincipal(principal),
          action: 'segment.deleted',
          resourceType: 'Segment',
          resourceId: segmentId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: { name: existing.name },
        },
        tx,
      );
    });
  }

  async preview(
    principal: AuthPrincipal,
    workspaceId: string,
    segmentId: string,
    overrides: PreviewSegmentDto = {},
  ): Promise<AudienceResolutionResponse> {
    const segment = await this.get(principal, workspaceId, segmentId);

    return this.contactsService.resolveAudience(
      principal,
      {
        workspaceId,
        tags: segment.criteria.tags ? [...segment.criteria.tags] : undefined,
        tagMatchMode: segment.criteria.tagMatchMode,
        channel: overrides.channel ?? segment.criteria.channel,
        channelId: overrides.channelId ?? segment.criteria.channelId,
        consentType: segment.criteria.consentType,
        requireOptIn: segment.criteria.requireOptIn,
        customFieldFilters: segment.criteria.customFieldFilters
          ? [...segment.criteria.customFieldFilters]
          : undefined,
        cursor: overrides.cursor,
        limit: overrides.limit,
      },
      workspaceId,
    );
  }
}
