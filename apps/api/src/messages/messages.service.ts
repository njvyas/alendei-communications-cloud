import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
  type QueuedMessageResponse,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AuthorizationService } from '../auth/authorization.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { normalizeEmailAddress, normalizePhoneNumber } from '../contacts/contacts.normalization';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { requireOrganization } from '../workspaces/workspace-administration.service';
import type { SendMessageDto } from './dto/send-message.dto';

function channelNotFound(channelCode: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: `Channel '${channelCode}' not found`,
    logContext: { channelCode },
  });
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
  ) {}

  async sendMessage(
    principal: AuthPrincipal,
    dto: SendMessageDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: QueuedMessageResponse }>> {
    const orgId = requireOrganization(principal);

    const authorize = (tx: Transaction) =>
      this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.MESSAGES_SEND,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

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
      authorize,
      work: async (tx) => {
        await authorize(tx);

        // 1. Channel preflight
        const channelResult = await tx.execute<{ id: string; code: string; status: string }>(
          sql`SELECT id, code, status FROM app_channel_resolve(${dto.channelCode}::text)`,
        );
        const channel = channelResult.rows[0];
        if (!channel || channel.status !== 'active') throw channelNotFound(dto.channelCode);

        // Determine workspace
        let workspaceId = dto.workspaceId;
        if (workspaceId) {
          const [targetWs] = await tx
            .select({ id: schema.workspaces.id })
            .from(schema.workspaces)
            .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.orgId, orgId)))
            .limit(1);
          if (!targetWs) {
            throw new AppException({
              status: HttpStatus.NOT_FOUND,
              code: ERROR_CODES.RESOURCE_NOT_FOUND,
              message: 'Workspace not found',
              logContext: { workspaceId },
            });
          }
        } else {
          const [defaultWs] = await tx
            .select({ id: schema.workspaces.id })
            .from(schema.workspaces)
            .where(and(eq(schema.workspaces.orgId, orgId), eq(schema.workspaces.isDefault, true)))
            .limit(1);
          if (!defaultWs) {
            throw new AppException({
              status: HttpStatus.INTERNAL_SERVER_ERROR,
              code: ERROR_CODES.INTERNAL_ERROR,
              message: 'Default workspace not found for organization',
            });
          }
          workspaceId = defaultWs.id;
        }

        // 2. Address normalization
        let normalizedAddress: string;
        if (channel.code === 'whatsapp' || channel.code === 'sms') {
          normalizedAddress = normalizePhoneNumber(dto.recipient);
        } else if (channel.code === 'email') {
          normalizedAddress = normalizeEmailAddress(dto.recipient);
        } else {
          normalizedAddress = dto.recipient.trim();
        }

        // 3. Suppression preflight check
        const [suppressed] = await tx
          .select({ id: schema.suppressions.id })
          .from(schema.suppressions)
          .where(
            and(
              eq(schema.suppressions.orgId, orgId),
              eq(schema.suppressions.channelId, channel.id),
              eq(schema.suppressions.normalizedAddress, normalizedAddress),
              eq(schema.suppressions.status, 'active'),
            ),
          )
          .limit(1);

        if (suppressed) {
          throw new AppException({
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            code: ERROR_CODES.RECIPIENT_SUPPRESSED,
            message: 'Recipient is actively suppressed for this channel',
            logContext: { channelCode: channel.code, suppressionId: suppressed.id },
          });
        }

        // 4. Resolve or create contact and identity
        let contactId: string;
        const [identity] = await tx
          .select({ contactId: schema.contactIdentities.contactId })
          .from(schema.contactIdentities)
          .where(
            and(
              eq(schema.contactIdentities.orgId, orgId),
              eq(schema.contactIdentities.workspaceId, workspaceId),
              eq(schema.contactIdentities.channelId, channel.id),
              eq(schema.contactIdentities.normalizedAddress, normalizedAddress),
              eq(schema.contactIdentities.status, 'active'),
            ),
          )
          .limit(1);

        if (identity) {
          contactId = identity.contactId;
        } else {
          const newContactId = uuidv7();
          await tx.insert(schema.contacts).values({
            id: newContactId,
            orgId,
            workspaceId,
          });
          await tx.insert(schema.contactIdentities).values({
            id: uuidv7(),
            orgId,
            workspaceId,
            contactId: newContactId,
            channelId: channel.id,
            rawAddress: dto.recipient,
            normalizedAddress,
            isPrimary: true,
            status: 'active',
          });
          contactId = newContactId;
        }

        // 5. Consent preflight check
        const consentRows = await tx
          .select({
            event: schema.consentEvents.event,
            occurredAt: schema.consentEvents.occurredAt,
          })
          .from(schema.consentEvents)
          .where(
            and(
              eq(schema.consentEvents.orgId, orgId),
              eq(schema.consentEvents.channelId, channel.id),
              eq(schema.consentEvents.contactId, contactId),
            ),
          )
          .orderBy(
            desc(schema.consentEvents.occurredAt),
            desc(schema.consentEvents.createdAt),
            desc(schema.consentEvents.id),
          );

        if (consentRows.length > 0) {
          const maxOccurredAt = consentRows[0]!.occurredAt.getTime();
          const latestGroup = consentRows.filter((r) => r.occurredAt.getTime() === maxOccurredAt);
          const hasGrant = latestGroup.some((r) => r.event === 'grant');
          const hasRevoke = latestGroup.some((r) => r.event === 'revoke');

          if (hasRevoke || (hasGrant && hasRevoke)) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.CONSENT_REVOKED,
              message: 'Recipient has revoked consent for this channel',
              logContext: { channelCode: channel.code, contactId },
            });
          }
        }

        // 6. Template preflight check (if templateId specified)
        if (dto.templateId) {
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

          if (!template) {
            throw new AppException({
              status: HttpStatus.NOT_FOUND,
              code: ERROR_CODES.RESOURCE_NOT_FOUND,
              message: 'Template not found',
              logContext: { templateId: dto.templateId },
            });
          }

          if (template.channelId !== channel.id) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.VALIDATION_FAILED,
              message: 'Template does not match requested channel',
              logContext: { templateId: dto.templateId, channelCode: dto.channelCode },
            });
          }

          if (template.approvalStatus !== 'approved') {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.TEMPLATE_NOT_APPROVED,
              message: 'Template is not approved',
              logContext: { templateId: dto.templateId, approvalStatus: template.approvalStatus },
            });
          }
        }

        // 7. Active Provider Assignment preflight check
        const assignments = await tx
          .select({ id: schema.organizationProviderAssignments.id })
          .from(schema.organizationProviderAssignments)
          .where(
            and(
              eq(schema.organizationProviderAssignments.orgId, orgId),
              eq(schema.organizationProviderAssignments.channelId, channel.id),
              eq(schema.organizationProviderAssignments.status, 'active'),
            ),
          )
          .limit(1);

        if (assignments.length === 0) {
          throw new AppException({
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            code: ERROR_CODES.NO_ACTIVE_PROVIDER_ASSIGNMENT,
            message: 'No active provider assignment for this channel',
            logContext: { channelCode: channel.code, orgId },
          });
        }

        // 8. Insert into messages
        const messageId = uuidv7();
        const correlationId = RequestContext.correlationId();
        const [message] = await tx
          .insert(schema.messages)
          .values({
            id: messageId,
            orgId,
            workspaceId,
            contactId,
            channelId: channel.id,
            templateId: dto.templateId ?? null,
            recipientAddress: normalizedAddress,
            payload: dto.payload,
            status: 'queued',
            correlationId,
          })
          .returning();

        // 9. Enqueue into message_dispatch_queue
        await tx.insert(schema.messageDispatchQueue).values({
          messageId,
          orgId,
          availableAt: new Date(),
          dispatchEpoch: 0,
        });

        // 10. Record event in message_events
        await tx.insert(schema.messageEvents).values({
          id: uuidv7(),
          orgId,
          messageId,
          eventType: 'message.queued',
          payload: {
            channelCode: channel.code,
            recipient: normalizedAddress,
          },
        });

        return {
          data: {
            id: messageId,
            status: 'queued',
            createdAt: message!.createdAt.toISOString(),
            correlationId,
          },
        };
      },
    });
  }

  async getMessage(
    principal: AuthPrincipal,
    messageId: string,
  ): Promise<{
    id: string;
    orgId: string;
    workspaceId: string;
    contactId: string;
    channelId: string;
    templateId: string | null;
    status: string;
    recipientAddress: string;
    payload: Record<string, unknown>;
    failureReason: string | null;
    createdAt: string;
    completedAt: string | null;
    attempts: Array<{
      id: string;
      attemptNumber: number;
      providerId: string;
      status: string;
      failureReason: string | null;
      latencyMs: number | null;
      completedAt: string | null;
    }>;
  }> {
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
        recipientAddress: row.recipientAddress,
        payload: row.payload as Record<string, unknown>,
        failureReason: row.failureReason,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        attempts: attempts.map((a) => ({
          id: a.id,
          attemptNumber: a.attemptNumber,
          providerId: a.providerId,
          status: a.status,
          failureReason: a.failureReason,
          latencyMs: a.latencyMs,
          completedAt: a.completedAt ? a.completedAt.toISOString() : null,
        })),
      };
    });
  }
}
