import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  renderTemplate,
  type AuthPrincipal,
  type CampaignAudiencePreviewResponse,
  type CampaignChannel,
  type CampaignMetrics,
  type CampaignRecipientRecord,
  type CampaignRecipientSource,
  type CampaignRecordResponse,
  type CampaignStatus,
  type CampaignThrottling,
  type MaterializeAudienceResponse,
  type PageInfo,
  CAMPAIGN_EXECUTOR_CODES,
  type CampaignPauseReason,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { PrincipalRevalidator } from '../auth/principal-revalidation.service';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { AppConfigService } from '../config/app-config.service';
import { ContactsService } from '../contacts/contacts.service';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { requireOrganization } from '../workspaces/workspace-administration.service';
import type {
  CampaignAudiencePreviewDto,
  CreateCampaignDto,
  ListCampaignRecipientsDto,
  ScheduleCampaignDto,
  UpdateCampaignDto,
} from './campaigns.dto';

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

function stripRecipientSourceContactCount<T extends Record<string, unknown>>(
  source: T,
): Record<string, unknown> {
  const { contactCount: _discarded, ...criteria } = source;
  return criteria;
}

function campaignView(row: CampaignJoinedRow): CampaignRecordResponse {
  const rawRecipientSource = (row.recipientSource as Record<string, unknown>) ?? {
    type: 'all_contacts',
  };
  const { contactCount: _discarded, ...recipientSource } = rawRecipientSource;

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
    recipientSource: recipientSource as unknown as CampaignRecipientSource,
    scheduleMode: row.scheduleMode,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    throttling: row.throttling as CampaignThrottling,
    metrics: row.metrics as CampaignMetrics,
    createdBy: row.createdBy,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    pauseReason: (row.pauseReason as CampaignPauseReason | null) ?? null,
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
    private readonly contactsService: ContactsService,
    private readonly config: AppConfigService,
    private readonly revalidator: PrincipalRevalidator,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.campaigns.name, encode: (row) => String(row.name) },
      createdAt: { column: schema.campaigns.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.campaigns.id,
  };

  private readonly recipientListSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.campaignRecipients.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'createdAt',
    tieBreaker: schema.campaignRecipients.id,
  };

  private materializationBatchLimit = 500;

  /** @internal For testing concurrency and multi-batch behaviour */
  setMaterializationBatchLimitForTesting(limit: number): void {
    this.materializationBatchLimit = limit;
  }

  /** @internal Reset testing batch limit */
  resetMaterializationBatchLimitForTesting(): void {
    this.materializationBatchLimit = 500;
  }

  /** @internal Hook called synchronously after each materialisation batch is committed to test concurrent races */
  public onMaterializationBatchInsertedForTesting?: (
    batchIndex: number,
    insertedCount: number,
    campaignId: string,
  ) => Promise<void> | void;

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

  /**
   * Phase 8B-3b: asserts `permission` at the workspace against the caller's CURRENT grants, re-read
   * now (`PrincipalRevalidator`), not the snapshot taken when the request began. Used in the
   * transaction that commits a scheduled state: a scheduled campaign is later started under its
   * scheduler, so the scheduler must hold messages.send when the schedule commits, even if it was
   * revoked after the request's preflight.
   */
  private async assertCurrentWorkspacePermission(
    tx: Transaction,
    principal: AuthPrincipal,
    workspaceId: string,
    permission: string,
  ): Promise<void> {
    await this.assertWorkspaceAccess(
      tx,
      await this.revalidator.refreshed(principal),
      workspaceId,
      permission,
    );
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
          pauseReason: schema.campaigns.pauseReason,
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

      const view = campaignView(row as unknown as CampaignJoinedRow);
      if (row.status === 'draft' || row.status === 'scheduled') return view;
      return { ...view, metrics: await this.liveMetrics(tx, orgId, campaignId) };
    });
  }

  /**
   * Phase 8B-3b (PHASE-8B-3-HANDOVER-Rev2 §6.4): progress derived on read — recipients by status,
   * and the campaign's messages by delivery outcome — rather than counters on a hot row.
   */
  private async liveMetrics(tx: Transaction, orgId: string, campaignId: string) {
    const recipients = await tx.execute<{ status: string; n: number }>(
      sql`SELECT status::text AS status, count(*)::int AS n FROM campaign_recipients
           WHERE campaign_id = ${campaignId} AND org_id = ${orgId} GROUP BY 1`,
    );
    const by = Object.fromEntries(recipients.rows.map((r) => [r.status, Number(r.n)]));
    const [outcomes] = (
      await tx.execute<{ delivered: number; read: number; failed: number }>(
        sql`SELECT count(*) FILTER (WHERE delivery_status = 'delivered')::int AS delivered,
                   count(*) FILTER (WHERE read_at IS NOT NULL)::int AS read,
                   count(*) FILTER (WHERE status = 'failed' OR delivery_status = 'undelivered')::int AS failed
              FROM messages WHERE org_id = ${orgId} AND campaign_id = ${campaignId}`,
      )
    ).rows;
    const total = recipients.rows.reduce((a, r) => a + Number(r.n), 0);
    const sent = by.sent ?? 0;
    const delivered = Number(outcomes?.delivered ?? 0);
    return {
      totalRecipients: total,
      sent,
      delivered,
      read: Number(outcomes?.read ?? 0),
      failed: (by.failed ?? 0) + Number(outcomes?.failed ?? 0),
      deliveryRate: sent > 0 ? Math.round((delivered / sent) * 1000) / 10 : 0,
    } satisfies CampaignMetrics;
  }

  async create(
    principal: AuthPrincipal,
    workspaceId: string,
    dto: CreateCampaignDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: CampaignRecordResponse }>> {
    const orgId = requireOrganization(principal);
    const sanitizedRecipientSource = stripRecipientSourceContactCount(
      dto.recipientSource as unknown as Record<string, unknown>,
    );

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
          recipientSource: sanitizedRecipientSource,
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
            recipientSource: sanitizedRecipientSource,
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

      // Cannot update if running, completed, or cancelled
      if (
        campaign.status === 'running' ||
        campaign.status === 'completed' ||
        campaign.status === 'cancelled'
      ) {
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
        updates.recipientSource = stripRecipientSourceContactCount(
          dto.recipientSource as unknown as Record<string, unknown>,
        );
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

      // Phase 8B-3b: an update that leaves the campaign `scheduled` (a draft moved to scheduled, or
      // a scheduled campaign re-timed) is a schedule: the scheduler starts it later under the
      // caller, so the caller needs messages.send — asserted against current grants, in this
      // transaction, below — and is recorded as its scheduler. Moving back to draft clears the
      // recorded scheduler. Metadata-only updates are unchanged.
      const schedules = updates.status === 'scheduled';
      if (schedules) {
        updates.scheduledBy = principal.apiKeyId ? null : principal.userId;
        updates.scheduledByApiKeyId = principal.apiKeyId ?? null;
      } else if (updates.status === 'draft') {
        updates.scheduledBy = null;
        updates.scheduledByApiKeyId = null;
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
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
            inArray(schema.campaigns.status, ['draft', 'scheduled']),
          ),
        )
        .returning();

      if (!updatedRow) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message:
            'Cannot update campaign: campaign is in terminal state or was modified concurrently',
          details: { campaignId },
        });
      }

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
      if (schedules) {
        // Last, immediately before commit: a refusal rolls the update and its audit back.
        await this.assertCurrentWorkspacePermission(
          tx,
          principal,
          workspaceId,
          PERMISSIONS.MESSAGES_SEND,
        );
      }

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

      const [deletedRow] = await tx
        .update(schema.campaigns)
        .set({ deletedAt: sql`now()` })
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
            inArray(schema.campaigns.status, ['draft', 'scheduled', 'cancelled', 'completed']),
          ),
        )
        .returning({ id: schema.campaigns.id });

      if (!deletedRow) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: 'Cannot delete campaign: campaign is running or was already deleted',
          details: { campaignId },
        });
      }

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

  /**
   * `POST …/dispatch`. **Disabled by default** (`CAMPAIGN_DISPATCH_ENABLED`, refused outside tests
   * and without billing enforcement): it then answers `CAMPAIGN_DISPATCH_DISABLED`, exactly as
   * before 8B-3b. Enabled (Phase 8B-3b, PHASE-8B-3-HANDOVER-Rev2 §6.1): the caller needs
   * `campaigns.manage` AND `messages.send` at the workspace; a `draft` or `scheduled` campaign
   * with an approved template and pending recipients starts `running` under the caller as its
   * initiator, and its claim row is created for the executor. Nothing is sent here.
   */
  async dispatch(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
  ): Promise<CampaignRecordResponse> {
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
        .for('no key update')
        .limit(1);

      if (!campaign) throw campaignNotFound(campaignId);

      if (!this.config.campaigns.dispatchEnabled) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.CAMPAIGN_DISPATCH_DISABLED,
          message:
            'Campaign dispatch remains disabled pending Phase 8B.2 and Phase 7 billing acceptance.',
          logContext: { campaignId, workspaceId },
        });
      }

      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.MESSAGES_SEND);
      if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot dispatch a campaign in '${campaign.status}' state`,
          details: { currentStatus: campaign.status },
        });
      }
      const [template] = await tx
        .select({
          name: schema.templates.name,
          body: schema.templates.body,
          approvalStatus: schema.templates.approvalStatus,
        })
        .from(schema.templates)
        .where(eq(schema.templates.id, campaign.templateId))
        .limit(1);
      if (!template || template.approvalStatus !== 'approved') {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.TEMPLATE_NOT_APPROVED,
          message: 'The campaign template must be approved before dispatch',
          details: { templateId: campaign.templateId },
        });
      }
      const [pending] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.campaignRecipients)
        .where(
          and(
            eq(schema.campaignRecipients.campaignId, campaignId),
            eq(schema.campaignRecipients.status, 'pending'),
          ),
        );
      if (!pending || Number(pending.n) === 0) {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.CAMPAIGN_AUDIENCE_EMPTY,
          message: 'The campaign has no materialised pending recipients to send to',
          details: { campaignId },
        });
      }

      const [updatedRow] = await tx
        .update(schema.campaigns)
        .set({
          status: 'running',
          startedBy: principal.apiKeyId ? null : principal.userId,
          startedByApiKeyId: principal.apiKeyId ?? null,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.orgId, orgId),
            inArray(schema.campaigns.status, ['draft', 'scheduled']),
          ),
        )
        .returning();
      if (!updatedRow) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: 'Cannot dispatch campaign: it was modified concurrently',
          details: { campaignId },
        });
      }
      await tx.insert(schema.campaignDispatch).values({ campaignId, orgId });
      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: workspaceId,
          ...actorFromPrincipal(principal),
          action: 'campaign.dispatched',
          resourceType: 'Campaign',
          resourceId: campaignId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: { previousStatus: campaign.status, pendingRecipients: Number(pending.n) },
        },
        tx,
      );
      const channelResult = await tx.execute<{ code: string }>(
        sql`SELECT app_channel_code(${updatedRow.channelId}) AS code`,
      );
      return campaignView({
        ...updatedRow,
        channelCode: channelResult.rows[0]?.code ?? 'unknown',
        templateName: template.name,
        templateBody: template.body,
      });
    });
  }

  async previewAudience(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
    dto: CampaignAudiencePreviewDto = {},
  ): Promise<CampaignAudiencePreviewResponse> {
    const orgId = requireOrganization(principal);

    const campaign = await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_READ);

      const [row] = await tx
        .select({
          id: schema.campaigns.id,
          channelId: schema.campaigns.channelId,
          recipientSource: schema.campaigns.recipientSource,
        })
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

      if (!row) throw campaignNotFound(campaignId);
      return row;
    });

    const source = (campaign.recipientSource as Record<string, unknown>) ?? {};
    const campaignTags = Array.isArray(source.tags)
      ? (source.tags as string[])
      : typeof source.tag === 'string'
        ? [source.tag]
        : undefined;

    const effectiveTags = dto.tags ?? campaignTags;
    const effectiveTagMatchMode =
      dto.tagMatchMode ?? (source.tagMatchMode as 'any' | 'all' | undefined) ?? 'any';
    const effectiveRequireOptIn =
      dto.requireOptIn !== undefined ? dto.requireOptIn : Boolean(source.requireOptIn);

    const resolution = await this.contactsService.resolveAudience(
      principal,
      {
        channelId: campaign.channelId,
        tags: effectiveTags,
        tagMatchMode: effectiveTagMatchMode,
        requireOptIn: effectiveRequireOptIn,
        cursor: dto.cursor,
        limit: dto.limit ?? 10,
      },
      workspaceId,
    );

    return {
      data: resolution.data,
      totalCount: resolution.totalCount,
      page: resolution.page,
    };
  }

  async materializeAudience(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
  ): Promise<MaterializeAudienceResponse> {
    const orgId = requireOrganization(principal);

    const campaign = await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);

      const [row] = await tx
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

      if (!row) throw campaignNotFound(campaignId);

      if (row.status === 'completed' || row.status === 'cancelled') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot materialize audience for campaign in '${row.status}' state`,
          details: { currentStatus: row.status },
        });
      }

      return row;
    });

    // Prevent materialisation from adding recipients after a campaign has transitioned to scheduled.
    // Repeated materialisation remains idempotent: returns the authoritative materialized count.
    if (campaign.status !== 'draft') {
      const totalRecipients = await this.getMaterializedRecipientCount(
        orgId,
        workspaceId,
        campaign.id,
      );
      return {
        campaignId: campaign.id,
        totalRecipients,
        materialized: 0,
      };
    }

    const { totalRecipients, materialized } = await this.performMaterialization(
      principal,
      workspaceId,
      orgId,
      campaign,
    );

    return {
      campaignId: campaign.id,
      totalRecipients,
      materialized,
    };
  }

  private async performMaterialization(
    principal: AuthPrincipal,
    workspaceId: string,
    orgId: string,
    campaign: typeof schema.campaigns.$inferSelect,
  ): Promise<{ totalRecipients: number; materialized: number }> {
    const source = (campaign.recipientSource as Record<string, unknown>) ?? {};
    const tags = Array.isArray(source.tags)
      ? (source.tags as string[])
      : typeof source.tag === 'string'
        ? [source.tag]
        : undefined;
    const tagMatchMode = (source.tagMatchMode as 'any' | 'all' | undefined) ?? 'any';
    const requireOptIn = Boolean(source.requireOptIn);

    let cursor: string | undefined = undefined;
    let newlyMaterialized = 0;
    const batchLimit = this.materializationBatchLimit;
    let batchIndex = 0;

    do {
      const pageRes = await this.contactsService.resolveAudience(
        principal,
        {
          channelId: campaign.channelId,
          tags,
          tagMatchMode,
          requireOptIn,
          cursor,
          limit: batchLimit,
        },
        workspaceId,
      );

      if (pageRes.data.length > 0) {
        const eligibleRows = pageRes.data
          .map((member) => {
            const matchingIdentity =
              member.identities.find(
                (id) =>
                  id.channelId === campaign.channelId && id.isPrimary && id.status === 'active',
              ) ??
              member.identities.find(
                (id) => id.channelId === campaign.channelId && id.status === 'active',
              ) ??
              member.identities.find((id) => id.channelId === campaign.channelId && id.isPrimary) ??
              member.identities.find((id) => id.channelId === campaign.channelId);

            if (!matchingIdentity) {
              return null;
            }

            return {
              id: uuidv7(),
              campaignId: campaign.id,
              orgId,
              workspaceId,
              contactId: member.contactId,
              identityId: matchingIdentity.id,
              status: 'pending' as const,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null);

        if (eligibleRows.length > 0) {
          const batchResult = await this.db.withRequestTenant(async (tx) => {
            await this.assertWorkspaceAccess(
              tx,
              principal,
              workspaceId,
              PERMISSIONS.CAMPAIGNS_MANAGE,
            );

            // Row-level lock campaign row to serialize with concurrent lifecycle transitions
            const [lockedCampaign] = await tx
              .select({
                id: schema.campaigns.id,
                status: schema.campaigns.status,
              })
              .from(schema.campaigns)
              .where(
                and(
                  eq(schema.campaigns.id, campaign.id),
                  eq(schema.campaigns.workspaceId, workspaceId),
                  eq(schema.campaigns.orgId, orgId),
                  isNull(schema.campaigns.deletedAt),
                ),
              )
              .for('no key update')
              .limit(1);

            if (!lockedCampaign) {
              throw campaignNotFound(campaign.id);
            }

            if (lockedCampaign.status !== 'draft') {
              return {
                aborted: true as const,
                status: lockedCampaign.status,
                insertedCount: 0,
              };
            }

            const inserted = await tx
              .insert(schema.campaignRecipients)
              .values(eligibleRows)
              .onConflictDoNothing({
                target: [schema.campaignRecipients.campaignId, schema.campaignRecipients.contactId],
              })
              .returning({ id: schema.campaignRecipients.id });

            return {
              aborted: false as const,
              status: lockedCampaign.status,
              insertedCount: inserted.length,
            };
          });

          if (batchResult.aborted) {
            if (
              batchResult.status === 'cancelled' ||
              batchResult.status === 'completed' ||
              batchResult.status === 'running' ||
              batchResult.status === 'paused'
            ) {
              throw new AppException({
                status: HttpStatus.CONFLICT,
                code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
                message: `Cannot materialize audience for campaign in '${batchResult.status}' state`,
                details: { currentStatus: batchResult.status },
              });
            }
            // For 'scheduled', the campaign has transitioned to scheduled. Halt further materialization batches.
            break;
          }

          newlyMaterialized += batchResult.insertedCount;
          batchIndex++;

          if (this.onMaterializationBatchInsertedForTesting) {
            await this.onMaterializationBatchInsertedForTesting(
              batchIndex,
              batchResult.insertedCount,
              campaign.id,
            );
          }
        }
      }

      cursor =
        pageRes.page.hasMore && pageRes.page.nextCursor ? pageRes.page.nextCursor : undefined;
    } while (cursor);

    const totalRecipients = await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);

      const [lockedCampaign] = await tx
        .select({
          id: schema.campaigns.id,
          status: schema.campaigns.status,
          metrics: schema.campaigns.metrics,
        })
        .from(schema.campaigns)
        .where(
          and(
            eq(schema.campaigns.id, campaign.id),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
          ),
        )
        .for('no key update')
        .limit(1);

      if (!lockedCampaign) {
        throw campaignNotFound(campaign.id);
      }

      if (lockedCampaign.status === 'cancelled' || lockedCampaign.status === 'completed') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot materialize audience for campaign in '${lockedCampaign.status}' state`,
          details: { currentStatus: lockedCampaign.status },
        });
      }

      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.campaignRecipients)
        .where(
          and(
            eq(schema.campaignRecipients.campaignId, campaign.id),
            eq(schema.campaignRecipients.workspaceId, workspaceId),
            eq(schema.campaignRecipients.orgId, orgId),
          ),
        );

      const count = Number(countRow?.count ?? 0);

      // Guard: only update campaign metrics if the campaign is still in 'draft' state.
      // If a concurrent lifecycle transition (e.g. schedule, cancel) won, do not overwrite metrics.
      if (lockedCampaign.status === 'draft') {
        const currentMetrics = (lockedCampaign.metrics as Record<string, unknown>) ?? {};
        const updatedMetrics = {
          ...currentMetrics,
          totalRecipients: count,
        };

        await tx
          .update(schema.campaigns)
          .set({
            metrics: updatedMetrics,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.campaigns.id, campaign.id),
              eq(schema.campaigns.workspaceId, workspaceId),
              eq(schema.campaigns.orgId, orgId),
              eq(schema.campaigns.status, 'draft'),
            ),
          );

        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: workspaceId,
            ...actorFromPrincipal(principal),
            action: 'campaign.audience_materialized',
            resourceType: 'Campaign',
            resourceId: campaign.id,
            outcome: 'success',
            before: null,
            after: null,
            metadata: {
              totalRecipients: count,
              newlyMaterialized,
            },
          },
          tx,
        );
      }

      return count;
    });

    return { totalRecipients, materialized: newlyMaterialized };
  }

  private async getMaterializedRecipientCount(
    orgId: string,
    workspaceId: string,
    campaignId: string,
  ): Promise<number> {
    return this.db.withRequestTenant(async (tx) => {
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.campaignRecipients)
        .where(
          and(
            eq(schema.campaignRecipients.campaignId, campaignId),
            eq(schema.campaignRecipients.workspaceId, workspaceId),
            eq(schema.campaignRecipients.orgId, orgId),
          ),
        );
      return Number(countRow?.count ?? 0);
    });
  }

  async schedule(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
    dto: ScheduleCampaignDto = {},
  ): Promise<CampaignRecordResponse> {
    const orgId = requireOrganization(principal);

    const existing = await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);
      // Phase 8B-3b: a scheduled campaign is started automatically, so scheduling needs the
      // caller's messages.send (the journey activation precedent).
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.MESSAGES_SEND);

      const [row] = await tx
        .select({
          campaign: schema.campaigns,
          channelCode: sql<string>`app_channel_code(${schema.campaigns.channelId})`,
          template: schema.templates,
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
      return row;
    });

    const campaign = existing.campaign;
    const template = existing.template;

    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
        message: `Cannot schedule a campaign in '${campaign.status}' state`,
        details: { currentStatus: campaign.status },
      });
    }

    const effectiveScheduledAt =
      dto.scheduledAt ?? (campaign.scheduledAt ? campaign.scheduledAt.toISOString() : null);
    if (!effectiveScheduledAt) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'scheduledAt is required to schedule a campaign',
      });
    }

    const scheduledAtDate = new Date(effectiveScheduledAt);
    if (isNaN(scheduledAtDate.getTime()) || scheduledAtDate.getTime() < Date.now() + 60_000) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'scheduledAt must be a valid future ISO date string at least 60 seconds from now',
        logContext: { scheduledAt: effectiveScheduledAt },
      });
    }

    if (!template || template.deletedAt !== null) {
      throw templateNotFound(campaign.templateId);
    }

    if (template.orgId !== orgId) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Template does not belong to the active organization',
      });
    }

    if (template.channelId !== campaign.channelId) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Template channel does not match campaign channel',
        logContext: {
          templateChannelId: template.channelId,
          campaignChannelId: campaign.channelId,
        },
      });
    }

    if (template.approvalStatus !== 'approved') {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Template must be approved before scheduling campaign (current approval status: '${template.approvalStatus}')`,
        details: { approvalStatus: template.approvalStatus },
      });
    }

    const rendered = renderTemplate(
      template.body,
      (campaign.templateVariables as Record<string, unknown>) ?? {},
    );
    if (rendered.missingVariables.length > 0) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Missing required template variables: ${rendered.missingVariables.join(', ')}`,
        details: { missingVariables: rendered.missingVariables },
      });
    }

    // Scheduling must use the authoritative materialised snapshot.
    let totalRecipients = await this.getMaterializedRecipientCount(orgId, workspaceId, campaign.id);
    if (totalRecipients === 0) {
      const materialization = await this.performMaterialization(
        principal,
        workspaceId,
        orgId,
        campaign,
      );
      totalRecipients = materialization.totalRecipients;
    }

    if (totalRecipients === 0) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.CAMPAIGN_AUDIENCE_EMPTY,
        message: 'Campaign audience is empty. Cannot schedule campaign without recipients.',
        logContext: { campaignId },
      });
    }

    return this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);

      const [lockedCampaign] = await tx
        .select({
          id: schema.campaigns.id,
          status: schema.campaigns.status,
          metrics: schema.campaigns.metrics,
        })
        .from(schema.campaigns)
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
            inArray(schema.campaigns.status, ['draft', 'scheduled']),
          ),
        )
        .for('no key update')
        .limit(1);

      if (!lockedCampaign) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message:
            'Campaign lifecycle transition conflict: campaign status was modified concurrently or is not in a valid state',
          details: { campaignId },
        });
      }

      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.campaignRecipients)
        .where(
          and(
            eq(schema.campaignRecipients.campaignId, campaignId),
            eq(schema.campaignRecipients.workspaceId, workspaceId),
            eq(schema.campaignRecipients.orgId, orgId),
          ),
        );

      const recipientCount = Number(countRow?.count ?? 0);
      if (recipientCount === 0) {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.CAMPAIGN_AUDIENCE_EMPTY,
          message: 'Campaign audience is empty. Cannot schedule campaign without recipients.',
          logContext: { campaignId },
        });
      }

      const currentMetrics = (lockedCampaign.metrics as Record<string, unknown>) ?? {};
      const updatedMetrics = {
        ...currentMetrics,
        totalRecipients: recipientCount,
      };

      const [updatedRow] = await tx
        .update(schema.campaigns)
        .set({
          status: 'scheduled',
          scheduleMode: 'scheduled',
          scheduledAt: scheduledAtDate,
          // Phase 8B-3b: the initiator the scheduler starts it under (OD-8C-1).
          scheduledBy: principal.apiKeyId ? null : principal.userId,
          scheduledByApiKeyId: principal.apiKeyId ?? null,
          metrics: updatedMetrics,
          updatedAt: new Date(),
        })
        .where(eq(schema.campaigns.id, campaignId))
        .returning();

      if (!updatedRow) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message:
            'Campaign lifecycle transition conflict: campaign status was modified concurrently or is not in a valid state',
          details: { campaignId },
        });
      }

      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: workspaceId,
          ...actorFromPrincipal(principal),
          action: 'campaign.scheduled',
          resourceType: 'Campaign',
          resourceId: campaignId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: {
            scheduledAt: scheduledAtDate.toISOString(),
            totalRecipients: recipientCount,
          },
        },
        tx,
      );
      // Phase 8B-3b: re-asserted against the caller's CURRENT grants, last in the transaction that
      // commits the scheduled state — not the preflight snapshot, which audience materialisation
      // separates from this commit. A refusal rolls back the schedule and its audit row.
      await this.assertCurrentWorkspacePermission(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.MESSAGES_SEND,
      );

      const joinedRow: CampaignJoinedRow = {
        ...updatedRow!,
        channelCode: existing.channelCode,
        templateName: template.name,
        templateBody: template.body,
      };

      return campaignView(joinedRow);
    });
  }

  async cancel(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
  ): Promise<CampaignRecordResponse> {
    const orgId = requireOrganization(principal);

    return this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);

      // Lock campaign row first to serialize with concurrent operations
      const [campaignRow] = await tx
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
        .for('no key update')
        .limit(1);

      if (!campaignRow) throw campaignNotFound(campaignId);

      if (campaignRow.status === 'completed' || campaignRow.status === 'cancelled') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot cancel a campaign in '${campaignRow.status}' state`,
          details: { currentStatus: campaignRow.status },
        });
      }

      const [updatedRow] = await tx
        .update(schema.campaigns)
        .set({
          status: 'cancelled',
          pauseReason: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
            inArray(schema.campaigns.status, ['draft', 'scheduled', 'running', 'paused']),
          ),
        )
        .returning();

      if (!updatedRow) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot cancel campaign: campaign is already in terminal state or was modified concurrently`,
          details: { campaignId },
        });
      }

      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: workspaceId,
          ...actorFromPrincipal(principal),
          action: 'campaign.cancelled',
          resourceType: 'Campaign',
          resourceId: campaignId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: {
            previousStatus: campaignRow.status,
          },
        },
        tx,
      );
      // Phase 8B-3b: nothing more is sent — the claim row goes, and every recipient still
      // pending is skipped. Messages already created proceed (no recall).
      await tx
        .delete(schema.campaignDispatch)
        .where(eq(schema.campaignDispatch.campaignId, campaignId));
      await tx
        .update(schema.campaignRecipients)
        .set({
          status: 'skipped',
          skipReason: CAMPAIGN_EXECUTOR_CODES.CAMPAIGN_CANCELLED,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.campaignRecipients.campaignId, campaignId),
            eq(schema.campaignRecipients.orgId, orgId),
            eq(schema.campaignRecipients.status, 'pending'),
          ),
        );

      const [template] = await tx
        .select({
          name: schema.templates.name,
          body: schema.templates.body,
        })
        .from(schema.templates)
        .where(eq(schema.templates.id, campaignRow.templateId))
        .limit(1);

      const channelResult = await tx.execute<{ code: string }>(
        sql`SELECT app_channel_code(${campaignRow.channelId}) AS code`,
      );

      const joinedRow: CampaignJoinedRow = {
        ...updatedRow!,
        channelCode: channelResult.rows[0]?.code ?? 'unknown',
        templateName: template?.name ?? null,
        templateBody: template?.body ?? null,
      };

      return campaignView(joinedRow);
    });
  }

  async pause(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
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
      if (campaign.status !== 'running') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot pause a campaign that is not running (current status: '${campaign.status}')`,
          details: { currentStatus: campaign.status },
        });
      }

      const [updatedRow] = await tx
        .update(schema.campaigns)
        .set({
          status: 'paused',
          // Phase 8B-3b: an operator pause; the executor's claim row goes with it.
          pauseReason: 'operator',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
            eq(schema.campaigns.status, 'running'),
          ),
        )
        .returning();

      if (!updatedRow) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot pause campaign: campaign is not running or was modified concurrently`,
          details: { campaignId },
        });
      }

      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: workspaceId,
          ...actorFromPrincipal(principal),
          action: 'campaign.paused',
          resourceType: 'Campaign',
          resourceId: campaignId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: {},
        },
        tx,
      );
      await tx
        .delete(schema.campaignDispatch)
        .where(eq(schema.campaignDispatch.campaignId, campaignId));

      const joinedRow: CampaignJoinedRow = {
        ...updatedRow!,
        channelCode: existing.channelCode,
        templateName: existing.templateName,
        templateBody: existing.templateBody,
      };

      return campaignView(joinedRow);
    });
  }

  async resume(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
  ): Promise<CampaignRecordResponse> {
    const orgId = requireOrganization(principal);

    return this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_MANAGE);
      // Phase 8B-3b: resuming sends again, so the resuming caller must hold messages.send
      // (the journey activation precedent); the original initiator stays attributed.
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.MESSAGES_SEND);

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
      if (campaign.status !== 'paused') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot resume a campaign that is not paused (current status: '${campaign.status}')`,
          details: { currentStatus: campaign.status },
        });
      }

      const [updatedRow] = await tx
        .update(schema.campaigns)
        .set({
          status: 'running',
          pauseReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.campaigns.id, campaignId),
            eq(schema.campaigns.workspaceId, workspaceId),
            eq(schema.campaigns.orgId, orgId),
            isNull(schema.campaigns.deletedAt),
            eq(schema.campaigns.status, 'paused'),
          ),
        )
        .returning();

      if (!updatedRow) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT,
          message: `Cannot resume campaign: campaign is not paused or was modified concurrently`,
          details: { campaignId },
        });
      }

      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: workspaceId,
          ...actorFromPrincipal(principal),
          action: 'campaign.resumed',
          resourceType: 'Campaign',
          resourceId: campaignId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: { previousPauseReason: campaign.pauseReason ?? null },
        },
        tx,
      );
      await tx
        .insert(schema.campaignDispatch)
        .values({ campaignId, orgId })
        .onConflictDoNothing({ target: schema.campaignDispatch.campaignId });

      const joinedRow: CampaignJoinedRow = {
        ...updatedRow!,
        channelCode: existing.channelCode,
        templateName: existing.templateName,
        templateBody: existing.templateBody,
      };

      return campaignView(joinedRow);
    });
  }

  async listRecipients(
    principal: AuthPrincipal,
    workspaceId: string,
    campaignId: string,
    query: ListCampaignRecipientsDto = {},
  ): Promise<{ items: readonly CampaignRecipientRecord[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(query, this.recipientListSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CAMPAIGNS_READ);

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

      const predicates: SQL[] = [
        eq(schema.campaignRecipients.orgId, orgId),
        eq(schema.campaignRecipients.workspaceId, workspaceId),
        eq(schema.campaignRecipients.campaignId, campaignId),
      ];

      if (query.status) {
        predicates.push(eq(schema.campaignRecipients.status, query.status));
      }
      if (resolved.after) {
        predicates.push(resolved.after);
      }

      return tx
        .select()
        .from(schema.campaignRecipients)
        .where(and(...predicates))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });

    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.recipientListSpec,
      (row) => String(row.id),
    );

    return {
      items: items.map((r) => {
        const row = r as typeof schema.campaignRecipients.$inferSelect;
        return {
          id: row.id,
          campaignId: row.campaignId,
          orgId: row.orgId,
          workspaceId: row.workspaceId,
          contactId: row.contactId,
          identityId: row.identityId,
          status: row.status,
          messageId: row.messageId,
          skipReason: row.skipReason,
          errorCode: row.errorCode,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
      page,
    };
  }
}
