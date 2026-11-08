import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  maskRecipientAddress,
  sanitizeRecipientContent,
  sanitizeRecipientData,
  type AuthPrincipal,
  type MessageDetailResponse,
  type MessageDeliveryStatus,
  type MessageStatus,
  type MessageSummaryResponse,
  type PageInfo,
  type QueuedMessageResponse,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm';

import { AuthorizationService } from '../auth/authorization.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { requireOrganization } from '../workspaces/workspace-administration.service';
import type { SendMessageDto } from './dto/send-message.dto';
import { authorizeSubmission } from './submission/submission-authorization';
import { MessageSubmissionCore } from './submission/message-submission.core';

/**
 * Phase 5.0 delivery fields of a message or attempt row, always present: `null` delivery
 * status means not tracked. Read-only projection; the submission `status` is untouched.
 */
export function deliveryView(row: {
  readonly deliveryStatus: MessageDeliveryStatus | null;
  readonly deliveredAt: Date | null;
  readonly readAt: Date | null;
}): {
  deliveryStatus: MessageDeliveryStatus | null;
  deliveredAt: string | null;
  readAt: string | null;
} {
  return {
    deliveryStatus: row.deliveryStatus ?? null,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}

/** Allow-listed filters for `GET /messages`. */
export interface ListMessagesFilter extends ListQueryInput {
  readonly status?: MessageStatus;
  readonly deliveryStatus?: MessageDeliveryStatus;
  readonly channelCode?: string;
  readonly workspaceId?: string;
  readonly templateId?: string;
  readonly providerId?: string;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
}

function messageNotFound(messageId: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Message not found',
    logContext: { messageId },
  });
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly idempotency: IdempotencyService,
    private readonly submission: MessageSubmissionCore,
    private readonly lists: ListQuery,
  ) {}

  /** Newest first by the UUIDv7 id, which orders by creation. */
  private readonly listSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.messages.id, encode: (row) => String(row.id) },
    },
    defaultSort: '-createdAt',
    tieBreaker: schema.messages.id,
  };

  /**
   * `POST /messages`: the HTTP adapter over the shared submission core (Phase 7
   * PR 7-3). It owns what is HTTP-specific — the organization from the principal,
   * the `messages.send` check, the optional `Idempotency-Key` (fingerprint, replay,
   * `202`) and the response shape — and nothing else. Message creation itself is
   * `MessageSubmissionCore.submit`, in the same transaction.
   */
  async sendMessage(
    principal: AuthPrincipal,
    dto: SendMessageDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: QueuedMessageResponse }>> {
    const orgId = requireOrganization(principal);

    const authorize = (tx: Transaction) =>
      authorizeSubmission(this.authorization, tx, principal, orgId);

    return this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.ACCEPTED,
      request: {
        method: 'POST',
        route: '/messages',
        orgId,
        principal,
        pathParams: {},
        query: {},
        body: {
          channelCode: dto.channelCode,
          recipient: dto.recipient,
          templateId: dto.templateId,
          workspaceId: dto.workspaceId,
          payload: dto.payload,
        },
      },
      // A replay re-runs the same check; its proof is not needed there.
      authorize: async (tx) => {
        await authorize(tx);
      },
      work: async (tx) => {
        const authorization = await authorize(tx);
        const created = await this.submission.submit(
          tx,
          { orgId, correlationId: RequestContext.correlationId(), authorization },
          {
            channelCode: dto.channelCode,
            recipient: dto.recipient,
            templateId: dto.templateId,
            workspaceId: dto.workspaceId,
            payload: dto.payload,
          },
        );
        return {
          data: {
            id: created.messageId,
            status: created.status,
            createdAt: created.createdAt.toISOString(),
            correlationId: created.correlationId,
          },
        };
      },
    });
  }

  async getMessage(principal: AuthPrincipal, messageId: string): Promise<MessageDetailResponse> {
    const orgId = requireOrganization(principal);

    return this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.MESSAGES_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [row] = await tx
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.id, messageId), eq(schema.messages.orgId, orgId)))
        .limit(1);

      if (!row) throw messageNotFound(messageId);

      const attempts = await tx
        .select()
        .from(schema.messageAttempts)
        .where(
          and(
            eq(schema.messageAttempts.messageId, messageId),
            eq(schema.messageAttempts.orgId, orgId),
          ),
        )
        .orderBy(schema.messageAttempts.attemptNumber);

      return {
        id: row.id,
        orgId: row.orgId,
        workspaceId: row.workspaceId,
        contactId: row.contactId,
        channelId: row.channelId,
        templateId: row.templateId,
        status: row.status,
        recipientAddress: maskRecipientAddress(row.recipientAddress),
        payload: sanitizeRecipientData(
          (row.payload as Record<string, unknown>) ?? {},
          row.recipientAddress,
        ),
        failureReason: sanitizeRecipientContent(row.failureReason, row.recipientAddress) || null,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        ...deliveryView(row),
        attempts: attempts.map((a) => ({
          id: a.id,
          attemptNumber: a.attemptNumber,
          providerId: a.providerId,
          status: a.status,
          failureReason: sanitizeRecipientContent(a.failureReason, row.recipientAddress) || null,
          latencyMs: a.latencyMs,
          completedAt: a.completedAt ? a.completedAt.toISOString() : null,
          ...deliveryView(a),
        })),
      };
    });
  }
  /**
   * `GET /messages` — one page of the request organization's messages: metadata
   * and an attempt count, never the payload. Every filter narrows within the
   * organization; the tenant transaction and the `org_id` predicate bound it.
   */
  async listMessages(
    principal: AuthPrincipal,
    filter: ListMessagesFilter = {},
  ): Promise<{ items: readonly MessageSummaryResponse[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.MESSAGES_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const predicates: SQL[] = [eq(schema.messages.orgId, orgId)];
      if (filter.channelCode) {
        const result = await tx.execute<{ id: string }>(
          sql`SELECT id FROM app_channel_resolve(${filter.channelCode}::text)`,
        );
        const channel = result.rows[0];
        if (!channel) return [];
        predicates.push(eq(schema.messages.channelId, channel.id));
      }
      if (filter.status) predicates.push(eq(schema.messages.status, filter.status));
      if (filter.deliveryStatus) {
        predicates.push(eq(schema.messages.deliveryStatus, filter.deliveryStatus));
      }
      if (filter.workspaceId) predicates.push(eq(schema.messages.workspaceId, filter.workspaceId));
      if (filter.templateId) predicates.push(eq(schema.messages.templateId, filter.templateId));
      if (filter.createdFrom) predicates.push(gte(schema.messages.createdAt, filter.createdFrom));
      if (filter.createdTo) predicates.push(lt(schema.messages.createdAt, filter.createdTo));
      if (filter.providerId) {
        predicates.push(
          sql`EXISTS (SELECT 1 FROM ${schema.messageAttempts} WHERE ${schema.messageAttempts.messageId} = ${schema.messages.id} AND ${schema.messageAttempts.orgId} = ${schema.messages.orgId} AND ${schema.messageAttempts.providerId} = ${filter.providerId})`,
        );
      }
      if (resolved.after) predicates.push(resolved.after);

      return tx
        .select({
          id: schema.messages.id,
          orgId: schema.messages.orgId,
          workspaceId: schema.messages.workspaceId,
          contactId: schema.messages.contactId,
          channelId: schema.messages.channelId,
          channelCode: sql<string>`app_channel_code(${schema.messages.channelId})`,
          templateId: schema.messages.templateId,
          status: schema.messages.status,
          recipientAddress: schema.messages.recipientAddress,
          failureReason: schema.messages.failureReason,
          // Drizzle renders select-list columns unqualified, where `id` and
          // `org_id` would bind to the attempts table; the outer columns are
          // therefore named explicitly.
          attemptCount: sql<number>`(SELECT count(*)::int FROM ${schema.messageAttempts} WHERE ${schema.messageAttempts.messageId} = ${schema.messages}.${sql.identifier('id')} AND ${schema.messageAttempts.orgId} = ${schema.messages}.${sql.identifier('org_id')})`,
          createdAt: schema.messages.createdAt,
          completedAt: schema.messages.completedAt,
          deliveryStatus: schema.messages.deliveryStatus,
          deliveredAt: schema.messages.deliveredAt,
          readAt: schema.messages.readAt,
        })
        .from(schema.messages)
        .where(and(...predicates))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });

    const { items, page } = this.lists.paginate(rows, resolved, this.listSpec, (row) => row.id);
    return {
      items: items.map((row) => ({
        ...row,
        recipientAddress: maskRecipientAddress(row.recipientAddress),
        failureReason: sanitizeRecipientContent(row.failureReason, row.recipientAddress) || null,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        ...deliveryView(row),
      })),
      page,
    };
  }
}
