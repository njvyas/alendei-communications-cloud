import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
  type PageInfo,
  type TemplateApprovalStatus,
  type TemplateResponse,
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
import { requireOrganization } from '../workspaces/workspace-administration.service';
import type {
  CreateTemplateDto,
  SimulateApprovalDto,
  UpdateTemplateDto,
} from './templates.dto';

type TemplateRow = typeof schema.templates.$inferSelect;

function templateNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Template not found',
    logContext: { requestedTemplateId: id },
  });
}

function channelNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Channel not found',
    logContext: { requestedChannelId: id },
  });
}

function templateView(row: TemplateRow): TemplateResponse {
  return {
    id: row.id,
    orgId: row.orgId,
    channelId: row.channelId,
    name: row.name,
    body: row.body,
    variables: (row.variables as readonly string[]) ?? [],
    approvalStatus: row.approvalStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ListTemplatesFilter extends ListQueryInput {
  readonly channelId?: string;
  readonly approvalStatus?: TemplateApprovalStatus;
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.templates.name, encode: (row) => String(row.name) },
      createdAt: { column: schema.templates.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.templates.id,
  };

  async list(
    principal: AuthPrincipal,
    filter: ListTemplatesFilter = {},
  ): Promise<{ items: readonly TemplateResponse[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEMPLATES_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const predicates: SQL[] = [
        eq(schema.templates.orgId, orgId),
        isNull(schema.templates.deletedAt),
      ];
      if (filter.channelId) predicates.push(eq(schema.templates.channelId, filter.channelId));
      if (filter.approvalStatus) predicates.push(eq(schema.templates.approvalStatus, filter.approvalStatus));
      if (resolved.after) predicates.push(resolved.after);

      return tx
        .select()
        .from(schema.templates)
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
    return { items: items.map((r) => templateView(r as never)), page };
  }

  async get(principal: AuthPrincipal, id: string): Promise<TemplateResponse> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEMPLATES_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [row] = await tx
        .select()
        .from(schema.templates)
        .where(
          and(
            eq(schema.templates.id, id),
            eq(schema.templates.orgId, orgId),
            isNull(schema.templates.deletedAt),
          ),
        );
      if (!row) throw templateNotFound(id);
      return templateView(row);
    });
  }

  async create(
    principal: AuthPrincipal,
    dto: CreateTemplateDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: TemplateResponse }>> {
    const orgId = requireOrganization(principal);
    const authorize = (tx: Transaction) =>
      this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEMPLATES_MANAGE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

    return this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: '/templates',
        orgId,
        principal,
        pathParams: {},
        query: {},
        body: { channelId: dto.channelId, name: dto.name },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);

        const channelResult = await tx.execute<{ code: string }>(
          sql`SELECT app_channel_code(${dto.channelId}) AS code`,
        );
        if (!channelResult.rows[0]?.code) throw channelNotFound(dto.channelId);

        const templateId = uuidv7();
        try {
          const [row] = await tx
            .insert(schema.templates)
            .values({
              id: templateId,
              orgId,
              channelId: dto.channelId,
              name: dto.name,
              body: dto.body,
              variables: dto.variables ?? [],
              approvalStatus: 'draft',
            })
            .returning();

          // Privacy: zero PII in audit log
          await this.audit.record(
            {
              scopeType: 'organization',
              scopeId: orgId,
              ...actorFromPrincipal(principal),
              action: 'template.created',
              resourceType: 'Template',
              resourceId: templateId,
              outcome: 'success',
              before: null,
              after: null,
              metadata: {},
            },
            tx,
          );

          return { data: templateView(row!) };
        } catch (error) {
          const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
          if (cause?.code === '23505' && cause.constraint === 'uq_templates_org_name_active') {
            throw new AppException({
              status: HttpStatus.CONFLICT,
              code: ERROR_CODES.RESOURCE_CONFLICT,
              message: 'A template with this name already exists in the organization',
            });
          }
          throw error;
        }
      },
    });
  }

  async update(
    principal: AuthPrincipal,
    id: string,
    dto: UpdateTemplateDto,
  ): Promise<TemplateResponse> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEMPLATES_MANAGE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [existing] = await tx
        .select()
        .from(schema.templates)
        .where(
          and(
            eq(schema.templates.id, id),
            eq(schema.templates.orgId, orgId),
            isNull(schema.templates.deletedAt),
          ),
        )
        .for('update');
      if (!existing) throw templateNotFound(id);

      if (existing.approvalStatus === 'approved') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.TEMPLATE_APPROVAL_CONFLICT,
          message: 'Approved templates cannot be modified directly',
        });
      }

      const updates: Partial<typeof schema.templates.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.name !== undefined) updates.name = dto.name;
      if (dto.body !== undefined) updates.body = dto.body;
      if (dto.variables !== undefined) updates.variables = dto.variables;

      try {
        const [row] = await tx
          .update(schema.templates)
          .set(updates)
          .where(eq(schema.templates.id, id))
          .returning();

        // Privacy: zero PII in audit log
        await this.audit.record(
          {
            scopeType: 'organization',
            scopeId: orgId,
            ...actorFromPrincipal(principal),
            action: 'template.updated',
            resourceType: 'Template',
            resourceId: id,
            outcome: 'success',
            before: null,
            after: null,
            metadata: {},
          },
          tx,
        );

        return templateView(row!);
      } catch (error) {
        const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
        if (cause?.code === '23505' && cause.constraint === 'uq_templates_org_name_active') {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.RESOURCE_CONFLICT,
            message: 'A template with this name already exists in the organization',
          });
        }
        throw error;
      }
    });
  }

  async simulateApproval(
    principal: AuthPrincipal,
    id: string,
    dto: SimulateApprovalDto,
  ): Promise<TemplateResponse> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEMPLATES_MANAGE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [existing] = await tx
        .select()
        .from(schema.templates)
        .where(
          and(
            eq(schema.templates.id, id),
            eq(schema.templates.orgId, orgId),
            isNull(schema.templates.deletedAt),
          ),
        )
        .for('update');
      if (!existing) throw templateNotFound(id);

      const fromStatus = existing.approvalStatus;
      const toStatus = dto.targetStatus;

      // Legal state transitions:
      // draft -> pending
      // pending -> approved | rejected
      // rejected -> draft
      const isLegal =
        (fromStatus === 'draft' && toStatus === 'pending') ||
        (fromStatus === 'pending' && (toStatus === 'approved' || toStatus === 'rejected')) ||
        (fromStatus === 'rejected' && toStatus === 'pending') ||
        (fromStatus === 'rejected' && (toStatus as string) === 'draft');

      if (!isLegal) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.TEMPLATE_APPROVAL_CONFLICT,
          message: `Cannot transition template from status ${fromStatus} to ${toStatus}`,
          details: { currentStatus: fromStatus, requestedStatus: toStatus },
        });
      }

      const [row] = await tx
        .update(schema.templates)
        .set({ approvalStatus: toStatus, updatedAt: new Date() })
        .where(eq(schema.templates.id, id))
        .returning();

      // Privacy: zero PII in audit log
      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: 'template.approval_status_changed',
          resourceType: 'Template',
          resourceId: id,
          outcome: 'success',
          before: { status: fromStatus },
          after: { status: toStatus },
          metadata: {},
        },
        tx,
      );

      return templateView(row!);
    });
  }

  async delete(principal: AuthPrincipal, id: string): Promise<void> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.TEMPLATES_MANAGE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [existing] = await tx
        .select()
        .from(schema.templates)
        .where(
          and(
            eq(schema.templates.id, id),
            eq(schema.templates.orgId, orgId),
            isNull(schema.templates.deletedAt),
          ),
        )
        .for('update');
      if (!existing) throw templateNotFound(id);

      await tx
        .update(schema.templates)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.templates.id, id));

      // Privacy: zero PII in audit log
      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: 'template.deleted',
          resourceType: 'Template',
          resourceId: id,
          outcome: 'success',
          before: null,
          after: null,
          metadata: {},
        },
        tx,
      );
    });
  }
}
