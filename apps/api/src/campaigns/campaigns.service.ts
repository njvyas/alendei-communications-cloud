import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
  type CampaignChannel,
  type CampaignMetrics,
  type CampaignRecipientSource,
  type CampaignRecordResponse,
  type CampaignStatus,
  type CampaignThrottling,
  type PageInfo,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { requireOrganization } from '../workspaces/workspace-administration.service';
import type { CreateCampaignDto, UpdateCampaignDto } from './campaigns.dto';

export interface ListCampaignsFilter extends ListQueryInput {
  readonly channel?: string;
  readonly status?: CampaignStatus;
  readonly query?: string;
}

type CampaignRow = typeof schema.campaigns.$inferSelect;

interface CampaignJoinedRow extends CampaignRow {
  readonly channelCode: string;
  readonly templateName: string | null;
  readonly templateBody: string | null;
}

function campaignNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.CAMPAIGN_NOT_FOUND,
    message: 'Campaign not found',
    logContext: { requestedCampaignId: id },
  });
}

function workspaceNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Workspace not found',
    logContext: { requestedWorkspaceId: id },
  });
}

function templateNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Template not found',
    logContext: { requestedTemplateId: id },
  });
}

function campaignView(row: CampaignJoinedRow): CampaignRecordResponse {
  return {
    id: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    channel: row.channelCode as CampaignChannel,
    channelId: row.channelId,
    templateId: row.templateId,
    templateName: row.templateName ?? '',
    templateBody: row.templateBody ?? '',
    templateVariables: (row.templateVariables as Record<string, string>) ?? {},
    status: row.status,
    recipientSource: row.recipientSource as CampaignRecipientSource,
    scheduleMode: row.scheduleMode,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    throttling: row.throttling as CampaignThrottling,
    metrics: row.metrics as CampaignMetrics,
    createdBy: row.createdBy,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    isSimulatedPreview: false,
  };
}

@Injectable()
export class CampaignsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.campaigns.name, encode: (row) => String(row.name) },
      createdAt: { column: schema.campaigns.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.campaigns.id,
  };

  /** Validates workspace existence within org and RLS, then authorizes permission. */
  async assertWorkspaceAccess(
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

  async list(
    principal: AuthPrincipal,
    workspaceId: string,
    filter: ListCampaignsFilter = {},
  ): Promise<{ items: readonly CampaignRecordResponse[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_READ);

      const predicates: SQL[] = [
        eq(schema.campaigns.orgId, orgId),
        eq(schema.campaigns.workspaceId, workspaceId),
        isNull(schema.campaigns.deletedAt),
      ];

      if (filter.channel) {
        const channelResult = await tx.execute<{ id: string }>(
          sql`SELECT id FROM app_channel_resolve(${filter.channel}::text)`,
        );
        const resolvedChannel = channelResult.rows[0];
        if (!resolvedChannel) return [];
        predicates.push(eq(schema.campaigns.channelId, resolvedChannel.id));
      }
      if (filter.status) {
        predicates.push(eq(schema.campaigns.status, filter.status));
      }
      if (filter.query) {
        predicates.push(ilike(schema.campaigns.name, `%${filter.query}%`));
      }
      if (resolved.after) {
        predicates.push(resolved.after);
      }

      return tx
        .select({
          id: schema.campaigns.id,
          orgId: schema.campaigns.orgId,
          workspaceId: schema.campaigns.workspaceId,
          name: schema.campaigns.name,
          description: schema.campaigns.description,
          channelId: schema.campaigns.channelId,
          templateId: schema.campaigns.templateId,
          templateVariables: schema.campaigns.templateVariables,
          status: schema.campaigns.status,
          recipientSource: schema.campaigns.recipientSource,
          scheduleMode: schema.campaigns.scheduleMode,
          scheduledAt: schema.campaigns.scheduledAt,
          throttling: schema.campaigns.throttling,
          routingPolicyId: schema.campaigns.routingPolicyId,
          createdBy: schema.campaigns.createdBy,
          metrics: schema.campaigns.metrics,
          startedAt: schema.campaigns.startedAt,
          completedAt: schema.campaigns.completedAt,
          deletedAt: schema.campaigns.deletedAt,
          createdAt: schema.campaigns.createdAt,
          updatedAt: schema.campaigns.updatedAt,
          channelCode: sql<string>`app_channel_code(${schema.campaigns.channelId})`,
          templateName: schema.templates.name,
          templateBody: schema.templates.body,
        })
        .from(schema.campaigns)
        .leftJoin(schema.templates, eq(schema.campaigns.templateId, schema.templates.id))
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
      items: items.map((r) => campaignView(r as unknown as CampaignJoinedRow)),
      page,
    };
  }

  async get(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
  ): Promise<CampaignRecordResponse> {
    const orgId = requireOrganization(principal);

    return this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_READ);

      const [row] = await tx
        .select({
          id: schema.campaigns.id,
          orgId: schema.campaigns.orgId,
          workspaceId: schema.campaigns.workspaceId,
          name: schema.campaigns.name,
          description: schema.campaigns.description,
          channelId: schema.campaigns.channelId,
          templateId: schema.campaigns.templateId,
          templateVariables: schema.campaigns.templateVariables,
          status: schema.campaigns.status,
          recipientSource: schema.campaigns.recipientSource,
          scheduleMode: schema.campaigns.scheduleMode,
          scheduledAt: schema.campaigns.scheduledAt,
          throttling: schema.campaigns.throttling,
          routingPolicyId: schema.campaigns.routingPolicyId,
          createdBy: schema.campaigns.createdBy,
          metrics: schema.campaigns.metrics,
          startedAt: schema.campaigns.startedAt,
          completedAt: schema.campaigns.completedAt,
          deletedAt: schema.campaigns.deletedAt,
          createdAt: schema.campaigns.createdAt,
          updatedAt: schema.campaigns.updatedAt,
          channelCode: sql<string>`app_channel_code(${schema.campaigns.channelId})`,
          templateName: schema.templates.name,
          templateBody: schema.templates.body,
        })
        .from(schema.campaigns)
        .leftJoin(schema.templates, eq(schema.campaigns.templateId, schema.templates.id))
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
          ),
        )
        .limit(1);

      if (!row) throw campaignNotFound(campaignId);

      return campaignView(row as unknown as CampaignJoinedRow);
    });
  }

  async create(
    principal: AuthPrincipal,
    workspaceId: string,
    dto: CreateCampaignDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: CampaignRecordResponse }>> {
    const orgId = requireOrganization(principal);

    const authorize = (tx: Transaction) =>
      this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);

    return this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: `/workspaces/${workspaceId}/campaigns`,
        orgId,
        principal,
        pathParams: { workspaceId },
        query: {},
        body: {
          name: dto.name,
          description: dto.description ?? null,
          channel: dto.channel ?? null,
          channelId: dto.channelId ?? null,
          templateId: dto.templateId,
          templateVariables: dto.templateVariables ?? {},
          recipientSource: dto.recipientSource,
          scheduleMode: dto.scheduleMode ?? 'immediate',
          scheduledAt: dto.scheduledAt ?? null,
          throttling: dto.throttling ?? null,
        },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);

        // 1. Verify template exists in the organization and active
        const [template] = await tx
          .select()
          .from(schema.templates)
          .where(
            and(
              eq(schema.templates.id, dto.templateId),
              eq(schema.templates.orgId, orgId),
              isNull(schema.templates.deletedAt),
            ),
          )
          .limit(1);

        if (!template) throw templateNotFound(dto.templateId);

        // 2. Resolve template's channel code
        const channelResult = await tx.execute<{ code: string }>(
          sql`SELECT app_channel_code(${template.channelId}) AS code`,
        );
        const channelCode = channelResult.rows[0]?.code;

        if (!channelCode) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.VALIDATION_FAILED,
            message: 'Channel associated with template not found',
          });
        }

        // If dto specifies channel, verify compatibility
        if (dto.channel && dto.channel !== channelCode) {
          throw new AppException({
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            code: ERROR_CODES.VALIDATION_FAILED,
            message: `Template channel (${channelCode}) does not match requested campaign channel (${dto.channel})`,
            logContext: { templateChannel: channelCode, requestedChannel: dto.channel },
          });
        }

        // 3. Scheduling validation
        const scheduleMode = dto.scheduleMode ?? 'immediate';
        let scheduledAtDate: Date | null = null;

        if (scheduleMode === 'scheduled') {
          if (!dto.scheduledAt) {
            throw new AppException({
              status: HttpStatus.BAD_REQUEST,
              code: ERROR_CODES.VALIDATION_FAILED,
              message: 'scheduledAt is required when scheduleMode is scheduled',
            });
          }
          scheduledAtDate = new Date(dto.scheduledAt);
          if (isNaN(scheduledAtDate.getTime()) || scheduledAtDate.getTime() <= Date.now()) {
            throw new AppException({
              status: HttpStatus.BAD_REQUEST,
              code: ERROR_CODES.VALIDATION_FAILED,
              message: 'scheduledAt must be a valid future ISO date string',
              logContext: { scheduledAt: dto.scheduledAt },
            });
          }
        }

        const initialStatus: CampaignStatus = scheduleMode === 'scheduled' ? 'scheduled' : 'draft';
        const campaignId = uuidv7();

        const throttling = {
          rateLimitPerSecond: dto.throttling?.rateLimitPerSecond ?? 25,
          maxAttemptsPerRecipient: dto.throttling?.maxAttemptsPerRecipient ?? 1,
        };

        const metrics = {
          totalRecipients: null,
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
          deliveryRate: 0,
        };

        const [createdRow] = await tx
          .insert(schema.campaigns)
          .values({
            id: campaignId,
            orgId,
            workspaceId,
            name: dto.name,
            description: dto.description ?? null,
            channelId: template.channelId,
            templateId: dto.templateId,
            templateVariables: dto.templateVariables ?? {},
            status: initialStatus,
            recipientSource: dto.recipientSource,
            scheduleMode,
            scheduledAt: scheduledAtDate,
            throttling,
            metrics,
            createdBy: principal.userId ?? null,
          })
          .returning();

        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: workspaceId,
            ...actorFromPrincipal(principal),
            action: 'campaign.created',
            resourceType: 'Campaign',
            resourceId: campaignId,
            outcome: 'success',
            before: null,
            after: null,
            metadata: {
              name: dto.name,
              channel: channelCode,
              status: initialStatus,
            },
          },
          tx,
        );

        const joinedRow: CampaignJoinedRow = {
          ...createdRow!,
          channelCode: channelCode,
          templateName: template.name,
          templateBody: template.body,
        };

        return { data: campaignView(joinedRow) };
      },
    });
  }

  async update(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
    dto: UpdateCampaignDto,
  ): Promise<CampaignRecordResponse> {
    const orgId = requireOrganization(principal);

    return this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);

      const [existing] = await tx
        .select({
          campaign: schema.campaigns,
          channelCode: sql<string>`app_channel_code(${schema.campaigns.channelId})`,
          templateName: schema.templates.name,
          templateBody: schema.templates.body,
        })
        .from(schema.campaigns)
        .leftJoin(schema.templates, eq(schema.campaigns.templateId, schema.templates.id))
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
          ),
        )
        .limit(1);

      if (!existing) throw campaignNotFound(campaignId);

      const campaign = existing.campaign;

      // Cannot update if running or completed
      if (campaign.status === 'running' || campaign.status === 'completed') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot update a campaign in '${campaign.status}' state`,
          details: { currentStatus: campaign.status },
        });
      }

      const updates: Partial<typeof schema.campaigns.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (dto.name !== undefined) updates.name = dto.name;
      if (dto.description !== undefined) updates.description = dto.description;
      if (dto.templateVariables !== undefined) updates.templateVariables = dto.templateVariables;
      if (dto.recipientSource !== undefined) {
        updates.recipientSource = dto.recipientSource;
      }

      const effectiveScheduleMode = dto.scheduleMode ?? campaign.scheduleMode;
      updates.scheduleMode = effectiveScheduleMode;

      if (dto.scheduledAt !== undefined) {
        if (dto.scheduledAt) {
          const parsed = new Date(dto.scheduledAt);
          if (isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
            throw new AppException({
              status: HttpStatus.BAD_REQUEST,
              code: ERROR_CODES.VALIDATION_FAILED,
              message: 'scheduledAt must be a valid future ISO date string',
              logContext: { scheduledAt: dto.scheduledAt },
            });
          }
          updates.scheduledAt = parsed;
          if (effectiveScheduleMode === 'scheduled') {
            updates.status = 'scheduled';
          }
        } else {
          if (effectiveScheduleMode === 'scheduled') {
            throw new AppException({
              status: HttpStatus.BAD_REQUEST,
              code: ERROR_CODES.VALIDATION_FAILED,
              message: 'scheduledAt cannot be null when scheduleMode is scheduled',
            });
          }
          updates.scheduledAt = null;
          updates.status = 'draft';
        }
      } else if (dto.scheduleMode !== undefined) {
        if (dto.scheduleMode === 'immediate' && campaign.status === 'scheduled') {
          updates.status = 'draft';
          updates.scheduledAt = null;
        } else if (dto.scheduleMode === 'scheduled' && campaign.status === 'draft') {
          if (!campaign.scheduledAt) {
            throw new AppException({
              status: HttpStatus.BAD_REQUEST,
              code: ERROR_CODES.VALIDATION_FAILED,
              message: 'scheduledAt is required when switching to scheduled mode',
            });
          }
          updates.status = 'scheduled';
        }
      }

      if (dto.throttling !== undefined) {
        const currentThrottling = campaign.throttling as CampaignThrottling;
        updates.throttling = {
          rateLimitPerSecond:
            dto.throttling.rateLimitPerSecond ?? currentThrottling.rateLimitPerSecond ?? 25,
          maxAttemptsPerRecipient:
            dto.throttling.maxAttemptsPerRecipient ??
            currentThrottling.maxAttemptsPerRecipient ??
            1,
        };
      }

      const [updatedRow] = await tx
        .update(schema.campaigns)
        .set(updates)
        .where(eq(schema.campaigns.id, campaignId))
        .returning();

      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: workspaceId,
          ...actorFromPrincipal(principal),
          action: 'campaign.updated',
          resourceType: 'Campaign',
          resourceId: campaignId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: {
            updatedFields: Object.keys(updates),
          },
        },
        tx,
      );

      const joinedRow: CampaignJoinedRow = {
        ...updatedRow!,
        channelCode: existing.channelCode,
        templateName: existing.templateName,
        templateBody: existing.templateBody,
      };

      return campaignView(joinedRow);
    });
  }

  async delete(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
  ): Promise<{ success: boolean }> {
    const orgId = requireOrganization(principal);

    return this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);

      const [campaign] = await tx
        .select()
        .from(schema.campaigns)
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
          ),
        )
        .limit(1);

      if (!campaign) throw campaignNotFound(campaignId);

      if (campaign.status === 'running') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: 'Cannot delete a running campaign',
          details: { currentStatus: campaign.status },
        });
      }

      await tx
        .update(schema.campaigns)
        .set({ deletedAt: sql`now()` })
        .where(eq(schema.campaigns.id, campaignId));

      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: workspaceId,
          ...actorFromPrincipal(principal),
          action: 'campaign.deleted',
          resourceType: 'Campaign',
          resourceId: campaignId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: {
            name: campaign.name,
          },
        },
        tx,
      );

      return { success: true };
    });
  }

  async dispatch(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
  ): Promise<never> {
    const orgId = requireOrganization(principal);

    await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);

      const [campaign] = await tx
        .select({ id: schema.campaigns.id })
        .from(schema.campaigns)
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
          ),
        )
        .limit(1);

      if (!campaign) throw campaignNotFound(campaignId);

      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.CAMPAIGN_DISPATCH_DISABLED,
        message:
          'Campaign dispatch remains disabled pending Phase 8B.2 and Phase 7 billing acceptance.',
        logContext: { campaignId, workspaceId },
      });
    });

    throw new Error('Unreachable');
  }
}
