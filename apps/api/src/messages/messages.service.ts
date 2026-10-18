import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  SMS_CONSTRAINTS,
  calculateSmsSegments,
  renderTemplate,
  validateDltMetadata,
  validateRcsPayload,
  validateSmsPayloadShape,
  validateSmsTemplateBody,
  validateSmsTemplateVariables,
  type AuthPrincipal,
  type QueuedMessageResponse,
  type SmsDltMetadata,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AuthorizationService } from '../auth/authorization.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { AppConfigService } from '../config/app-config.service';
import { normalizeAddress } from '../contacts/contacts.normalization';
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
    private readonly config: AppConfigService,
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

        // 2. Address normalization (canonical normalization path across all channels)
        const normalizedAddress = normalizeAddress(dto.recipient, channel.code);

        // 3. Suppression preflight check (channel-specific or org-wide suppression)
        const [suppressed] = await tx
          .select({ id: schema.suppressions.id })
          .from(schema.suppressions)
          .where(
            and(
              eq(schema.suppressions.orgId, orgId),
              or(
                eq(schema.suppressions.channelId, channel.id),
                isNull(schema.suppressions.channelId),
              ),
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
        let template: typeof schema.templates.$inferSelect | undefined;
        if (dto.templateId) {
          const [foundTemplate] = await tx
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

          if (!foundTemplate) {
            throw new AppException({
              status: HttpStatus.NOT_FOUND,
              code: ERROR_CODES.RESOURCE_NOT_FOUND,
              message: 'Template not found',
              logContext: { templateId: dto.templateId },
            });
          }

          if (foundTemplate.channelId !== channel.id) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.VALIDATION_FAILED,
              message: 'Template does not match requested channel',
              logContext: { templateId: dto.templateId, channelCode: dto.channelCode },
            });
          }

          if (foundTemplate.approvalStatus !== 'approved') {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.TEMPLATE_NOT_APPROVED,
              message: 'Template is not approved',
              logContext: {
                templateId: dto.templateId,
                approvalStatus: foundTemplate.approvalStatus,
              },
            });
          }

          template = foundTemplate;
        }

        // 6b. Channel-specific regulatory & payload validation (Phase 4.1 Gate F.1)
        let finalPayload: Record<string, unknown> = dto.payload;

        if (channel.code === 'sms') {
          const smsPayloadInvalid = (message: string, errors?: readonly string[]) =>
            new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.SMS_PAYLOAD_INVALID,
              message,
              logContext: errors ? { errors } : undefined,
            });

          // Payload shape first: allowlisted fields and bounded size, before any template work.
          const shape = validateSmsPayloadShape(dto.payload);
          if (!shape.valid) {
            throw smsPayloadInvalid(
              `Invalid SMS payload: ${shape.errors.join('; ')}`,
              shape.errors,
            );
          }

          // Owner policy D-7 (approved 17-Oct-2026, DECISIONS.md §1w.1): fail closed —
          // SMS requires an approved registered template with bound DLT metadata.
          if (!dto.templateId || !template) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.SMS_DLT_METADATA_REQUIRED,
              message:
                'SMS dispatch requires an approved registered template with bound DLT metadata',
              logContext: { channelCode: channel.code },
            });
          }

          // Unpack and validate template-bound DLT metadata
          let templateDlt: SmsDltMetadata | undefined;
          if (
            template.variables &&
            typeof template.variables === 'object' &&
            !Array.isArray(template.variables)
          ) {
            templateDlt = (template.variables as { dlt?: SmsDltMetadata }).dlt;
          }

          if (!templateDlt) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.SMS_DLT_METADATA_REQUIRED,
              message: 'SMS template dispatch requires DLT metadata bound to the approved template',
              logContext: { templateId: dto.templateId },
            });
          }

          const templateDltValidation = validateDltMetadata(templateDlt);
          if (!templateDltValidation.valid) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.SMS_DLT_METADATA_INVALID,
              message: `Approved template DLT metadata is invalid: ${templateDltValidation.errors.join('; ')}`,
              logContext: { templateId: dto.templateId, errors: templateDltValidation.errors },
            });
          }

          const payloadDlt = dto.payload.dlt;
          if (payloadDlt !== undefined) {
            const pValidation = validateDltMetadata(payloadDlt);
            if (!pValidation.valid) {
              throw new AppException({
                status: HttpStatus.UNPROCESSABLE_ENTITY,
                code: ERROR_CODES.SMS_DLT_METADATA_INVALID,
                message: `Invalid SMS payload DLT metadata: ${pValidation.errors.join('; ')}`,
                logContext: { errors: pValidation.errors },
              });
            }

            const pDlt = payloadDlt as SmsDltMetadata;
            const entityMatches = pDlt.entityId === templateDlt.entityId;
            const templateMatches = pDlt.templateId === templateDlt.templateId;
            const headerMatches =
              templateDlt.headerId !== undefined
                ? pDlt.headerId === templateDlt.headerId
                : pDlt.headerId === undefined;

            if (!entityMatches || !templateMatches || !headerMatches) {
              throw new AppException({
                status: HttpStatus.UNPROCESSABLE_ENTITY,
                code: ERROR_CODES.SMS_DLT_TEMPLATE_MISMATCH,
                message: 'Payload DLT metadata does not match approved template DLT metadata',
                logContext: { payloadDlt: pDlt, templateDlt },
              });
            }
          }

          // Re-validate the stored body: templates approved before these rules, or written
          // outside the API, must not dispatch placeholder-only or malformed content.
          const bodyValidation = validateSmsTemplateBody(template.body);
          if (!bodyValidation.valid) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.SMS_TEMPLATE_INVALID,
              message: `Approved SMS template is not dispatchable: ${bodyValidation.errors.join('; ')}`,
              logContext: { templateId: dto.templateId, errors: bodyValidation.errors },
            });
          }

          // Variables: names, types and lengths are checked before anything is rendered.
          const payloadVariables = dto.payload.variables;
          const variableValidation = validateSmsTemplateVariables(
            template.body,
            payloadVariables,
            this.config.sms.templateVariableMaxLength,
          );
          if (!variableValidation.valid) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.SMS_TEMPLATE_VARIABLE_INVALID,
              message: `Invalid SMS template variables: ${variableValidation.errors.join('; ')}`,
              logContext: { templateId: dto.templateId, errors: variableValidation.errors },
            });
          }

          const { text: renderedText, missingVariables } = renderTemplate(
            template.body,
            payloadVariables as Record<string, unknown> | readonly unknown[] | undefined,
          );
          // Defence in depth: the variable check above already guarantees both conditions.
          if (missingVariables.length > 0 || renderedText.trim().length === 0) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.SMS_TEMPLATE_VARIABLE_INVALID,
              message: 'SMS template could not be rendered from the supplied variables',
              logContext: { templateId: dto.templateId, missingVariables },
            });
          }

          // payload.text may only restate the rendered approved content, never replace it.
          const payloadText = dto.payload.text;
          if (payloadText !== undefined) {
            if (typeof payloadText !== 'string') {
              throw smsPayloadInvalid('SMS payload.text must be a string');
            }
            if (payloadText !== renderedText) {
              throw smsPayloadInvalid('Payload text cannot override approved template content');
            }
          }

          // Server-enforced segment ceiling: a client value can only lower the limit.
          const clientMaxRaw = dto.payload.maxSegments;
          let maxSegments: number = SMS_CONSTRAINTS.DEFAULT_MAX_SEGMENTS;
          if (clientMaxRaw !== undefined) {
            if (
              typeof clientMaxRaw !== 'number' ||
              clientMaxRaw <= 0 ||
              !Number.isInteger(clientMaxRaw)
            ) {
              throw smsPayloadInvalid('SMS payload.maxSegments must be a positive integer');
            }
            maxSegments = Math.min(clientMaxRaw, SMS_CONSTRAINTS.DEFAULT_MAX_SEGMENTS);
          }

          const analysis = calculateSmsSegments(renderedText, { maxSegments });
          if (analysis.segmentCount > maxSegments) {
            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code: ERROR_CODES.SMS_MAX_SEGMENTS_EXCEEDED,
              message: `SMS message length requires ${analysis.segmentCount} segments, exceeding maximum allowed limit of ${maxSegments}`,
              logContext: {
                segmentCount: analysis.segmentCount,
                maxSegments,
                encoding: analysis.encoding,
                characterCount: analysis.characterCount,
                totalUnits: analysis.totalUnits,
              },
            });
          }

          // Persist only server-derived content: rendered text and the template's own DLT.
          finalPayload = {
            text: renderedText,
            dlt: templateDlt,
            ...(payloadVariables !== undefined ? { variables: payloadVariables } : {}),
            ...(clientMaxRaw !== undefined ? { maxSegments } : {}),
          };
        }

        if (channel.code === 'rcs') {
          const rcsValidation = validateRcsPayload(dto.payload);
          if (!rcsValidation.valid) {
            const hasUnsafeUrl = rcsValidation.errors.some(
              (e) =>
                e.toLowerCase().includes('unsafe') ||
                e.toLowerCase().includes('protocol') ||
                e.toLowerCase().includes('http or https url'),
            );
            const code = hasUnsafeUrl
              ? ERROR_CODES.RCS_UNSAFE_ACTION_URL
              : ERROR_CODES.RCS_PAYLOAD_INVALID;

            throw new AppException({
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              code,
              message: `Invalid RCS payload: ${rcsValidation.errors.join('; ')}`,
              logContext: { errors: rcsValidation.errors },
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
            payload: finalPayload,
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
