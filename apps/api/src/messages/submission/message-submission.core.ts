import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  SMS_CONSTRAINTS,
  calculateSmsSegments,
  isDispatchableChannel,
  renderTemplate,
  validateDltMetadata,
  validateRcsPayload,
  validateSmsPayloadShape,
  validateSmsTemplateBody,
  validateSmsTemplateVariables,
  type SmsDltMetadata,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { MessageReservationService } from '../../billing/message-reservation.service';
import { AppException } from '../../common/errors/app.exception';
import { AppConfigService } from '../../config/app-config.service';
import { normalizeAddress } from '../../contacts/contacts.normalization';
import { assertSubmissionAuthorized } from './submission-authorization';
import type {
  SubmissionContext,
  SubmissionOrigin,
  SubmissionRequest,
  SubmissionResult,
} from './submission.types';

type BillingMode = (typeof schema.organizations.$inferSelect)['billingMode'];
type BillingPolicy = (typeof schema.organizations.$inferSelect)['billingPolicy'];

interface BillableUnits {
  readonly count: number;
  readonly unit: 'sms_segment' | 'message';
  readonly smsEncoding: 'GSM-7' | 'UCS-2' | null;
}

function channelNotFound(channelCode: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: `Channel '${channelCode}' not found`,
    logContext: { channelCode },
  });
}

/**
 * The shared message submission core (Phase 7 PR 7-3; `DECISIONS.md` §1zi.3
 * OD-7-10; handover `docs/PHASE-7-3-SEND-PATH-HANDOVER.md`).
 *
 * **The only code that creates a logical message.** `POST /messages` reaches it
 * through `MessagesService.sendMessage`; every later caller (campaign execution,
 * journeys) must call it too, never insert into `messages` or the dispatch
 * queue itself (`ARCHITECTURE.md` §26). A structural test enforces this.
 *
 * Contract:
 * - **Caller's transaction only.** It runs in `tx` and never opens, commits or
 *   releases a transaction; its only nesting is the contact savepoint. Any refusal
 *   throws, so the caller's whole transaction — contact, message, queue row, event
 *   and, on HTTP, the idempotency claim — rolls back together.
 * - **No request context.** Organization, correlation id and authorization come
 *   from `ctx`, which the caller builds from validated authentication material.
 * - **Authorized first.** `ctx.authorization` must be the send-permission proof
 *   minted for this `tx` and organization (`authorizeSubmission`); otherwise it
 *   refuses before reading anything.
 * - **Not idempotent by itself.** Each call creates one message; duplicate
 *   prevention belongs to the caller (on HTTP, the `Idempotency-Key`).
 * - **Behaviour-preserving extraction (7-3).** The checks run in the pre-7-3 order
 *   with the same errors; it calls no pricing, ledger, provider or dispatcher code.
 * - **Funds reservation (7-4, `DECISIONS.md` §1zi.7).** Every new message records
 *   its billable units. When billing enforcement is enabled
 *   (`BILLING_ENFORCEMENT_ENABLED`, read here so no caller can opt out), the
 *   message also records the organization's billing settings and, as the **last**
 *   step, reserves funds through `MessageReservationService` — the one reservation
 *   path for every caller. Every existing refusal therefore precedes money, and
 *   the billing account is the last lock the transaction takes. A refused
 *   reservation throws, so the whole submission rolls back.
 */
@Injectable()
export class MessageSubmissionCore {
  constructor(
    private readonly config: AppConfigService,
    private readonly reservation: MessageReservationService,
  ) {}

  async submit(
    tx: Transaction,
    ctx: SubmissionContext,
    request: SubmissionRequest,
  ): Promise<SubmissionResult> {
    assertSubmissionAuthorized(ctx.authorization, tx, ctx.orgId);
    const orgId = ctx.orgId;
    const billingEnforced = this.config.billing.enforcementEnabled;

    // 1. Channel preflight
    const channelResult = await tx.execute<{ id: string; code: string; status: string }>(
      sql`SELECT id, code, status FROM app_channel_resolve(${request.channelCode}::text)`,
    );
    const channel = channelResult.rows[0];
    if (!channel || channel.status !== 'active') throw channelNotFound(request.channelCode);
    // Fail closed (Phase 4.3, owner decision 24-Oct-2026): a catalogued channel
    // with no authorized send path is refused before anything is read or stored.
    if (!isDispatchableChannel(channel.code)) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.CHANNEL_NOT_SUPPORTED,
        message: `Channel '${channel.code}' does not support sending messages`,
        logContext: { channelCode: channel.code },
      });
    }

    // Determine workspace
    let workspaceId = request.workspaceId;
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
    const normalizedAddress = normalizeAddress(request.recipient, channel.code);

    // 3. Suppression preflight check (channel-specific or org-wide suppression)
    const [suppressed] = await tx
      .select({ id: schema.suppressions.id })
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.orgId, orgId),
          or(eq(schema.suppressions.channelId, channel.id), isNull(schema.suppressions.channelId)),
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
      // First send to this address in this workspace. A concurrent first send
      // can create the same identity (`uq_contact_identities_workspace_active`).
      // The insert runs in a savepoint, so the request that loses rolls back
      // only its own contact and identity and reuses the winner's — committed
      // by then, because the unique index made the loser wait for it.
      const newContactId = uuidv7();
      try {
        await tx.transaction(async (savepoint) => {
          await savepoint.insert(schema.contacts).values({
            id: newContactId,
            orgId,
            workspaceId,
          });
          await savepoint.insert(schema.contactIdentities).values({
            id: uuidv7(),
            orgId,
            workspaceId,
            contactId: newContactId,
            channelId: channel.id,
            rawAddress: request.recipient,
            normalizedAddress,
            isPrimary: true,
            status: 'active',
          });
        });
        contactId = newContactId;
      } catch (error) {
        const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
        if (
          cause?.code !== '23505' ||
          cause.constraint !== 'uq_contact_identities_workspace_active'
        ) {
          throw error;
        }
        const [winner] = await tx
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
        if (!winner) throw error;
        contactId = winner.contactId;
      }
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
    if (request.templateId) {
      const [foundTemplate] = await tx
        .select()
        .from(schema.templates)
        .where(
          and(
            eq(schema.templates.id, request.templateId),
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
          logContext: { templateId: request.templateId },
        });
      }

      if (foundTemplate.channelId !== channel.id) {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'Template does not match requested channel',
          logContext: { templateId: request.templateId, channelCode: request.channelCode },
        });
      }

      if (foundTemplate.approvalStatus !== 'approved') {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.TEMPLATE_NOT_APPROVED,
          message: 'Template is not approved',
          logContext: {
            templateId: request.templateId,
            approvalStatus: foundTemplate.approvalStatus,
          },
        });
      }

      template = foundTemplate;
    }

    // 6b. Channel-specific regulatory & payload validation (Phase 4.1 Gate F.1)
    let finalPayload: Record<string, unknown> = request.payload;
    // Billable units (Phase 7 PR 7-4): SMS segments after render; one per message
    // on WhatsApp and RCS (`app_pricing_unit_for_channel`, migration 0051).
    let units: BillableUnits | null =
      channel.code === 'whatsapp' || channel.code === 'rcs'
        ? { count: 1, unit: 'message', smsEncoding: null }
        : null;

    if (channel.code === 'sms') {
      const smsPayloadInvalid = (message: string, errors?: readonly string[]) =>
        new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.SMS_PAYLOAD_INVALID,
          message,
          logContext: errors ? { errors } : undefined,
        });

      // Payload shape first: allowlisted fields and bounded size, before any template work.
      const shape = validateSmsPayloadShape(request.payload);
      if (!shape.valid) {
        throw smsPayloadInvalid(`Invalid SMS payload: ${shape.errors.join('; ')}`, shape.errors);
      }

      // Owner policy D-7 (approved 17-Oct-2026, DECISIONS.md §1w.1): fail closed —
      // SMS requires an approved registered template with bound DLT metadata.
      if (!request.templateId || !template) {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.SMS_DLT_METADATA_REQUIRED,
          message: 'SMS dispatch requires an approved registered template with bound DLT metadata',
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
          logContext: { templateId: request.templateId },
        });
      }

      const templateDltValidation = validateDltMetadata(templateDlt);
      if (!templateDltValidation.valid) {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.SMS_DLT_METADATA_INVALID,
          message: `Approved template DLT metadata is invalid: ${templateDltValidation.errors.join('; ')}`,
          logContext: { templateId: request.templateId, errors: templateDltValidation.errors },
        });
      }

      const payloadDlt = request.payload.dlt;
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
          logContext: { templateId: request.templateId, errors: bodyValidation.errors },
        });
      }

      // Variables: names, types and lengths are checked before anything is rendered.
      const payloadVariables = request.payload.variables;
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
          logContext: { templateId: request.templateId, errors: variableValidation.errors },
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
          logContext: { templateId: request.templateId, missingVariables },
        });
      }

      // payload.text may only restate the rendered approved content, never replace it.
      const payloadText = request.payload.text;
      if (payloadText !== undefined) {
        if (typeof payloadText !== 'string') {
          throw smsPayloadInvalid('SMS payload.text must be a string');
        }
        if (payloadText !== renderedText) {
          throw smsPayloadInvalid('Payload text cannot override approved template content');
        }
      }

      // Server-enforced segment ceiling: a client value can only lower the limit.
      const clientMaxRaw = request.payload.maxSegments;
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

      units = { count: analysis.segmentCount, unit: 'sms_segment', smsEncoding: analysis.encoding };

      // Persist only server-derived content: rendered text and the template's own DLT.
      finalPayload = {
        text: renderedText,
        dlt: templateDlt,
        ...(payloadVariables !== undefined ? { variables: payloadVariables } : {}),
        ...(clientMaxRaw !== undefined ? { maxSegments } : {}),
      };
    }

    if (channel.code === 'rcs') {
      const rcsValidation = validateRcsPayload(request.payload);
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

    // 7b. Billing snapshot (enforcement only): the settings the reservation is sized
    // under; app_message_reserve refuses the message if they change before it runs.
    let billing: { mode: BillingMode; policy: BillingPolicy } | null = null;
    if (billingEnforced) {
      if (!units) {
        throw new Error(`message submission: no billable unit for channel '${channel.code}'`);
      }
      const [org] = await tx
        .select({
          mode: schema.organizations.billingMode,
          policy: schema.organizations.billingPolicy,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1);
      if (!org) throw new Error('message submission: organization not visible');
      billing = org;
    }

    // 8. Insert into messages
    const messageId = uuidv7();
    const correlationId = ctx.correlationId;
    const attribution = originColumns(ctx.origin);
    const [message] = await tx
      .insert(schema.messages)
      .values({
        id: messageId,
        orgId,
        workspaceId,
        contactId,
        channelId: channel.id,
        templateId: request.templateId ?? null,
        recipientAddress: normalizedAddress,
        payload: finalPayload,
        status: 'queued',
        correlationId,
        billableUnits: units?.count ?? null,
        billableUnit: units?.unit ?? null,
        smsEncoding: units?.smsEncoding ?? null,
        billingEnforced: billing !== null,
        billingModeSnapshot: billing?.mode ?? null,
        billingPolicySnapshot: billing?.policy ?? null,
        journeyId: attribution.journeyId,
        journeyExecutionId: attribution.journeyExecutionId,
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

    // 11. Reserve funds (enforcement only): the last step and the last lock.
    if (billing) await this.reservation.reserve(tx, messageId);

    return {
      messageId,
      status: 'queued',
      createdAt: message!.createdAt,
      correlationId,
      workspaceId,
      channelId: channel.id,
      channelCode: channel.code,
    };
  }
}

/**
 * The attribution columns of an origin (Phase 8C-5a). No origin (a direct submission) sets
 * none of them. Exhaustive: an unhandled variant fails to compile at the `never` assignment.
 */
function originColumns(origin: SubmissionOrigin | undefined): {
  journeyId: string | null;
  journeyExecutionId: string | null;
} {
  if (origin === undefined) return { journeyId: null, journeyExecutionId: null };
  const kind = origin.kind;
  switch (kind) {
    case 'journey':
      return { journeyId: origin.journeyId, journeyExecutionId: origin.executionId };
    default: {
      const unhandled: never = kind;
      throw new Error(`message submission: unhandled origin '${JSON.stringify(unhandled)}'`);
    }
  }
}
