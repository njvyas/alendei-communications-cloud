import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PAGE_LIMITS,
  PERMISSIONS,
  isTerminalMessageStatus,
  maskRecipientAddress,
  sanitizeRecipientContent,
  type AudienceMemberIdentity,
  type AudienceMemberResponse,
  type AudienceResolutionResponse,
  type AuthPrincipal,
  type ContactActivityResponse,
  type ContactResponse,
  type ContactIdentityResponse,
  type ConsentEventResponse,
  type EffectiveConsentResponse,
  type EffectiveConsentState,
  type MessageStatus,
  type PageInfo,
} from '@acc/contracts';

import { schema, type Transaction } from '@acc/db';
import { and, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { CursorCodec } from '../common/http/cursor';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import {
  requireOrganization,
  workspaceNotFound,
} from '../workspaces/workspace-administration.service';
import type {
  CreateContactDto,
  CreateContactIdentityDto,
  CreateConsentEventDto,
  GetEffectiveConsentDto,
  ListContactActivitiesDto,
  ResolveAudienceDto,
  UpdateContactDto,
  UpdateContactIdentityDto,
} from './contacts.dto';
import { normalizeAddress } from './contacts.normalization';

type ContactRow = typeof schema.contacts.$inferSelect;
type IdentityRow = typeof schema.contactIdentities.$inferSelect;
type ConsentEventRow = typeof schema.consentEvents.$inferSelect;

function extractContactTagsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const m = metadata as Record<string, unknown>;
  const rawTags = m.tags ?? m.tag_list;
  if (Array.isArray(rawTags)) {
    return rawTags
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim());
  }
  if (typeof rawTags === 'string') {
    return rawTags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

function contactNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Contact not found',
    logContext: { requestedContactId: id },
  });
}

function identityNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Contact identity not found',
    logContext: { requestedIdentityId: id },
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

function contactView(row: ContactRow): ContactResponse {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    firstName: row.firstName,
    lastName: row.lastName,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function identityView(row: IdentityRow): ContactIdentityResponse {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    contactId: row.contactId,
    channelId: row.channelId,
    rawAddress: row.rawAddress,
    normalizedAddress: row.normalizedAddress,
    isPrimary: row.isPrimary,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function consentEventView(row: ConsentEventRow): ConsentEventResponse {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    contactId: row.contactId,
    channelId: row.channelId,
    consentType: row.consentType,
    event: row.event,
    occurredAt: row.occurredAt.toISOString(),
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
    private readonly cursors: CursorCodec,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.contacts.id, encode: (row) => String(row.id) },
      id: { column: schema.contacts.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'createdAt',
    tieBreaker: schema.contacts.id,
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

  /** Loads contact row, validates workspace if supplied, and authorizes permission. */
  async loadContact(
    tx: Transaction,
    principal: AuthPrincipal,
    contactId: string,
    permission: string,
    workspaceId?: string,
  ): Promise<ContactRow> {
    const orgId = requireOrganization(principal);
    const [row] = await tx
      .select()
      .from(schema.contacts)
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)));
    if (!row) throw contactNotFound(contactId);
    if (workspaceId && row.workspaceId !== workspaceId) throw contactNotFound(contactId);

    await this.authorization.assert(tx, {
      principal,
      permission,
      target: { scopeType: 'workspace', scopeId: row.workspaceId },
      resourceType: 'Workspace',
    });

    return row;
  }

  // --- Contacts CRUD -----------------------------------------------------------

  async list(
    principal: AuthPrincipal,
    workspaceId: string,
    filter: ListQueryInput = {},
  ): Promise<{ items: readonly ContactResponse[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CONTACTS_READ);

      const predicates: SQL[] = [
        eq(schema.contacts.orgId, orgId),
        eq(schema.contacts.workspaceId, workspaceId),
      ];
      if (resolved.after) predicates.push(resolved.after);

      return tx
        .select()
        .from(schema.contacts)
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
    return { items: items.map((r) => contactView(r as never)), page };
  }

  async get(
    principal: AuthPrincipal,
    contactId: string,
    workspaceId?: string,
  ): Promise<ContactResponse> {
    return this.db.withRequestTenant(async (tx) => {
      const row = await this.loadContact(
        tx,
        principal,
        contactId,
        PERMISSIONS.CONTACTS_READ,
        workspaceId,
      );
      return contactView(row);
    });
  }

  // --- Contact Activities -----------------------------------------------------

  async listActivities(
    principal: AuthPrincipal,
    contactId: string,
    filter: ListContactActivitiesDto = {},
    workspaceId?: string,
  ): Promise<{ items: readonly ContactActivityResponse[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const limit = Math.min(
      Math.max(filter.limit ?? PAGE_LIMITS.DEFAULT, PAGE_LIMITS.MIN),
      PAGE_LIMITS.MAX,
    );
    const category = filter.category && filter.category !== 'all' ? filter.category : undefined;

    return this.db.withRequestTenant(async (tx) => {
      const contact = await this.loadContact(
        tx,
        principal,
        contactId,
        PERMISSIONS.CONTACTS_READ,
        workspaceId,
      );

      const activities: ContactActivityResponse[] = [];
      const knownAddresses = new Set<string>();

      // 1. Profile events (contact_created from contacts.createdAt, contact_updated from audit_logs)
      if (!category || category === 'profile') {
        activities.push({
          id: `activity-contact-${contact.id}-created`,
          contactId: contact.id,
          workspaceId: contact.workspaceId,
          type: 'contact_created',
          category: 'profile',
          title: 'Contact Created',
          description: 'Contact record registered in workspace',
          timestamp: contact.createdAt.toISOString(),
          statusTone: 'neutral',
          metadata: {},
        });

        const contactAuditRows = await tx
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.orgId, orgId),
              eq(schema.auditLogs.resourceType, 'Contact'),
              eq(schema.auditLogs.resourceId, contact.id),
              eq(schema.auditLogs.action, 'contact.updated'),
              eq(schema.auditLogs.outcome, 'success'),
            ),
          );

        for (const auditRow of contactAuditRows) {
          activities.push({
            id: `activity-audit-${auditRow.id}`,
            contactId: contact.id,
            workspaceId: contact.workspaceId,
            type: 'contact_updated',
            category: 'profile',
            title: 'Contact Updated',
            description: auditRow.actorLabel
              ? `Contact record modified by ${auditRow.actorLabel}`
              : 'Contact record modified',
            timestamp: (auditRow.occurredAt ?? auditRow.createdAt).toISOString(),
            statusTone: 'neutral',
            metadata: (auditRow.metadata as Record<string, unknown>) ?? {},
          });
        }
      }

      // 2. Identity events (identity_added from contact_identities, identity_updated from audit_logs)
      // Also populates knownAddresses for failureReason PII sanitisation when category is 'message'
      if (!category || category === 'identity' || category === 'message') {
        const identityRows = await tx
          .select({
            identity: schema.contactIdentities,
            channelCode: schema.channels.code,
          })
          .from(schema.contactIdentities)
          .leftJoin(schema.channels, eq(schema.contactIdentities.channelId, schema.channels.id))
          .where(
            and(
              eq(schema.contactIdentities.orgId, orgId),
              eq(schema.contactIdentities.contactId, contact.id),
            ),
          );

        const identityIds: string[] = [];
        for (const row of identityRows) {
          const identity = row?.identity;
          if (!identity) continue;
          identityIds.push(identity.id);
          const rawOrNorm = identity.normalizedAddress || identity.rawAddress;
          if (rawOrNorm) {
            knownAddresses.add(rawOrNorm);
          }
          if (!category || category === 'identity') {
            const maskedAddress = maskRecipientAddress(rawOrNorm);
            activities.push({
              id: `activity-identity-${identity.id}-created`,
              contactId: contact.id,
              workspaceId: contact.workspaceId,
              type: 'identity_added',
              category: 'identity',
              title: `Identity Added (${maskedAddress})`,
              description: `Channel identifier ${maskedAddress} linked${identity.isPrimary ? ' as primary address' : ''}`,
              timestamp: identity.createdAt.toISOString(),
              channelId: identity.channelId,
              channelCode: row.channelCode ?? null,
              statusTone: identity.status === 'active' ? 'accent' : 'warning',
              metadata: {
                maskedAddress,
                isPrimary: identity.isPrimary,
                status: identity.status,
              },
            });
          }
        }

        if ((!category || category === 'identity') && identityIds.length > 0) {
          const identityAuditRows = await tx
            .select()
            .from(schema.auditLogs)
            .where(
              and(
                eq(schema.auditLogs.orgId, orgId),
                eq(schema.auditLogs.resourceType, 'ContactIdentity'),
                eq(schema.auditLogs.action, 'contact_identity.updated'),
                eq(schema.auditLogs.outcome, 'success'),
                inArray(schema.auditLogs.resourceId, identityIds),
              ),
            );

          for (const auditRow of identityAuditRows) {
            const rawMeta = (auditRow.metadata as Record<string, unknown>) ?? {};
            const sanitizedMeta: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(rawMeta)) {
              if (
                typeof v === 'string' &&
                [
                  'rawAddress',
                  'normalizedAddress',
                  'address',
                  'recipientAddress',
                  'recipient',
                ].includes(k)
              ) {
                sanitizedMeta[k] = maskRecipientAddress(v);
              } else {
                sanitizedMeta[k] = v;
              }
            }
            activities.push({
              id: `activity-audit-${auditRow.id}`,
              contactId: contact.id,
              workspaceId: contact.workspaceId,
              type: 'identity_updated',
              category: 'identity',
              title: 'Identity Updated',
              description: auditRow.actorLabel
                ? `Contact identity modified by ${auditRow.actorLabel}`
                : 'Contact identity modified',
              timestamp: (auditRow.occurredAt ?? auditRow.createdAt).toISOString(),
              statusTone: 'warning',
              metadata: sanitizedMeta,
            });
          }
        }
      }

      // 3. Consent events (consent_granted / consent_revoked from consent_events)
      if (!category || category === 'consent') {
        const consentRows = await tx
          .select({
            consent: schema.consentEvents,
            channelCode: schema.channels.code,
          })
          .from(schema.consentEvents)
          .leftJoin(schema.channels, eq(schema.consentEvents.channelId, schema.channels.id))
          .where(
            and(
              eq(schema.consentEvents.orgId, orgId),
              eq(schema.consentEvents.contactId, contact.id),
            ),
          );

        for (const { consent, channelCode } of consentRows) {
          const isGrant = consent.event === 'grant';
          activities.push({
            id: `activity-consent-${consent.id}`,
            contactId: contact.id,
            workspaceId: contact.workspaceId,
            type: isGrant ? 'consent_granted' : 'consent_revoked',
            category: 'consent',
            title: isGrant ? 'Consent Granted' : 'Consent Revoked',
            description: `${consent.consentType.toUpperCase()} consent ${isGrant ? 'granted' : 'revoked'} (Source: ${consent.source})`,
            timestamp: consent.occurredAt.toISOString(),
            channelId: consent.channelId,
            channelCode: channelCode ?? null,
            statusTone: isGrant ? 'success' : 'error',
            metadata: {
              consentType: consent.consentType,
              event: consent.event,
              source: consent.source,
            },
          });
        }
      }

      // 4. Message events (message_sent, message_delivered, message_read, message_failed from messages)
      if (!category || category === 'message') {
        const messageRows = await tx
          .select({
            message: schema.messages,
            channelCode: schema.channels.code,
            templateName: schema.templates.name,
          })
          .from(schema.messages)
          .leftJoin(schema.channels, eq(schema.messages.channelId, schema.channels.id))
          .leftJoin(schema.templates, eq(schema.messages.templateId, schema.templates.id))
          .where(and(eq(schema.messages.orgId, orgId), eq(schema.messages.contactId, contact.id)));

        for (const { message } of messageRows) {
          if (message.recipientAddress) {
            knownAddresses.add(message.recipientAddress);
          }
        }

        for (const { message, channelCode, templateName } of messageRows) {
          const channelLabel = (channelCode ?? 'message').toUpperCase();
          const maskedRecipient = maskRecipientAddress(message.recipientAddress);

          // 1. Dispatch event (message_sent) vs Pending Dispatch (message_pending)
          if (message.status === 'accepted') {
            // Established dispatch: message was submitted to and accepted by the upstream provider/carrier
            activities.push({
              id: `activity-msg-${message.id}-sent`,
              contactId: contact.id,
              workspaceId: contact.workspaceId,
              type: 'message_sent',
              category: 'message',
              title: `${channelLabel} Dispatched`,
              description: `Outbound message dispatched to recipient ${maskedRecipient}`,
              timestamp: message.createdAt.toISOString(),
              channelId: message.channelId,
              channelCode: channelCode ?? null,
              statusTone: 'neutral',
              metadata: {
                messageId: message.id,
                recipientAddress: maskedRecipient,
                status: message.status,
                templateName: templateName ?? null,
              },
            });
          } else if (!isTerminalMessageStatus(message.status as MessageStatus)) {
            // Not yet dispatched: message is pending dispatch
            activities.push({
              id: `activity-msg-${message.id}-pending`,
              contactId: contact.id,
              workspaceId: contact.workspaceId,
              type: 'message_pending',
              category: 'message',
              title: `${channelLabel} Pending Dispatch`,
              description: `Outbound message awaiting dispatch to ${maskedRecipient}`,
              timestamp: message.createdAt.toISOString(),
              channelId: message.channelId,
              channelCode: channelCode ?? null,
              statusTone: 'neutral',
              metadata: {
                messageId: message.id,
                recipientAddress: maskedRecipient,
                status: message.status,
                templateName: templateName ?? null,
              },
            });
          }

          // 2. Delivery event (message_delivered)
          if (message.deliveredAt || message.deliveryStatus === 'delivered') {
            activities.push({
              id: `activity-msg-${message.id}-delivered`,
              contactId: contact.id,
              workspaceId: contact.workspaceId,
              type: 'message_delivered',
              category: 'message',
              title: `${channelLabel} Delivered`,
              description: 'Confirmed delivered to recipient endpoint',
              timestamp: (message.deliveredAt ?? message.createdAt).toISOString(),
              channelId: message.channelId,
              channelCode: channelCode ?? null,
              statusTone: 'success',
              metadata: {
                messageId: message.id,
                recipientAddress: maskedRecipient,
                deliveryStatus: message.deliveryStatus,
              },
            });
          }

          // 3. Read event (message_read)
          if (message.readAt) {
            activities.push({
              id: `activity-msg-${message.id}-read`,
              contactId: contact.id,
              workspaceId: contact.workspaceId,
              type: 'message_read',
              category: 'message',
              title: `${channelLabel} Message Read`,
              description: 'Recipient read notification confirmed',
              timestamp: message.readAt.toISOString(),
              channelId: message.channelId,
              channelCode: channelCode ?? null,
              statusTone: 'accent',
              metadata: {
                messageId: message.id,
                recipientAddress: maskedRecipient,
              },
            });
          }

          // 4. Failure event (message_failed)
          if (message.status === 'failed' || message.deliveryStatus === 'undelivered') {
            const isDownstreamFailure =
              message.status === 'accepted' && message.deliveryStatus === 'undelivered';

            let sanitizedFailureReason = message.failureReason || null;
            if (sanitizedFailureReason) {
              sanitizedFailureReason =
                sanitizeRecipientContent(sanitizedFailureReason, message.recipientAddress) || null;
              for (const addr of knownAddresses) {
                if (sanitizedFailureReason && addr !== message.recipientAddress) {
                  sanitizedFailureReason =
                    sanitizeRecipientContent(sanitizedFailureReason, addr) || null;
                }
              }
            }

            activities.push({
              id: `activity-msg-${message.id}-failed`,
              contactId: contact.id,
              workspaceId: contact.workspaceId,
              type: 'message_failed',
              category: 'message',
              title: isDownstreamFailure
                ? `${channelLabel} Delivery Failed`
                : `${channelLabel} Submission Failed`,
              description: isDownstreamFailure
                ? sanitizedFailureReason || 'Message delivery failed at recipient endpoint'
                : sanitizedFailureReason || 'Message submission failed before dispatch',
              timestamp: (message.completedAt ?? message.createdAt).toISOString(),
              channelId: message.channelId,
              channelCode: channelCode ?? null,
              statusTone: 'error',
              metadata: {
                messageId: message.id,
                recipientAddress: maskedRecipient,
                failureReason: sanitizedFailureReason,
                status: message.status,
                deliveryStatus: message.deliveryStatus,
              },
            });
          } else if (message.status === 'outcome_unknown') {
            activities.push({
              id: `activity-msg-${message.id}-unknown`,
              contactId: contact.id,
              workspaceId: contact.workspaceId,
              type: 'message_outcome_unknown',
              category: 'message',
              title: `${channelLabel} Dispatch Outcome Unknown`,
              description: 'Message submission outcome unknown',
              timestamp: (message.completedAt ?? message.createdAt).toISOString(),
              channelId: message.channelId,
              channelCode: channelCode ?? null,
              statusTone: 'warning',
              metadata: {
                messageId: message.id,
                recipientAddress: maskedRecipient,
                status: message.status,
              },
            });
          }
        }
      }

      // Stable descending sort by timestamp, tie-break by ID descending
      activities.sort((a, b) => {
        const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        if (timeDiff !== 0) return timeDiff;
        return b.id.localeCompare(a.id);
      });

      // Keyset cursor pagination
      let startIndex = 0;
      if (filter.cursor) {
        const payload = this.cursors.decode(filter.cursor, '-timestamp');
        const cursorTime = payload.v ? new Date(payload.v).getTime() : 0;
        const cursorId = payload.i;
        const foundIdx = activities.findIndex((act) => {
          const actTime = new Date(act.timestamp).getTime();
          return actTime < cursorTime || (actTime === cursorTime && act.id < cursorId);
        });
        startIndex = foundIdx === -1 ? activities.length : foundIdx;
      }

      const pagedSlice = activities.slice(startIndex, startIndex + limit + 1);
      const hasMore = pagedSlice.length > limit;
      const items = hasMore ? pagedSlice.slice(0, limit) : pagedSlice;
      const lastItem = items[items.length - 1];

      const nextCursor =
        hasMore && lastItem
          ? this.cursors.encode({
              s: '-timestamp',
              v: lastItem.timestamp,
              i: lastItem.id,
            })
          : null;

      return {
        items,
        page: {
          nextCursor,
          hasMore,
          limit,
        },
      };
    });
  }

  async create(
    principal: AuthPrincipal,
    workspaceId: string,
    dto: CreateContactDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: ContactResponse }>> {
    const orgId = requireOrganization(principal);
    const authorize = (tx: Transaction) =>
      this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.CONTACTS_MANAGE);

    return this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: `/workspaces/${workspaceId}/contacts`,
        orgId,
        principal,
        pathParams: { workspaceId },
        query: {},
        body: { firstName: dto.firstName, lastName: dto.lastName },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);
        const contactId = uuidv7();
        const [row] = await tx
          .insert(schema.contacts)
          .values({
            id: contactId,
            orgId,
            workspaceId,
            firstName: dto.firstName ?? null,
            lastName: dto.lastName ?? null,
            metadata: dto.metadata ?? {},
          })
          .returning();

        // Privacy: zero PII in audit log (before: null, after: null)
        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: workspaceId,
            ...actorFromPrincipal(principal),
            action: 'contact.created',
            resourceType: 'Contact',
            resourceId: contactId,
            outcome: 'success',
            before: null,
            after: null,
            metadata: {},
          },
          tx,
        );

        return { data: contactView(row!) };
      },
    });
  }

  async update(
    principal: AuthPrincipal,
    contactId: string,
    dto: UpdateContactDto,
    workspaceId?: string,
  ): Promise<ContactResponse> {
    return this.db.withRequestTenant(async (tx) => {
      const existing = await this.loadContact(
        tx,
        principal,
        contactId,
        PERMISSIONS.CONTACTS_MANAGE,
        workspaceId,
      );

      const updates: Partial<typeof schema.contacts.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.firstName !== undefined) updates.firstName = dto.firstName;
      if (dto.lastName !== undefined) updates.lastName = dto.lastName;
      if (dto.metadata !== undefined) updates.metadata = dto.metadata;

      const [row] = await tx
        .update(schema.contacts)
        .set(updates)
        .where(eq(schema.contacts.id, contactId))
        .returning();

      // Privacy: zero PII in audit log
      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: existing.workspaceId,
          ...actorFromPrincipal(principal),
          action: 'contact.updated',
          resourceType: 'Contact',
          resourceId: contactId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: {},
        },
        tx,
      );

      return contactView(row!);
    });
  }

  // --- Contact Identities ------------------------------------------------------

  async createIdentity(
    principal: AuthPrincipal,
    contactId: string,
    dto: CreateContactIdentityDto,
    workspaceId?: string,
  ): Promise<ContactIdentityResponse> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      const contact = await this.loadContact(
        tx,
        principal,
        contactId,
        PERMISSIONS.CONTACTS_MANAGE,
        workspaceId,
      );

      // Validate channel exists
      const channelResult = await tx.execute<{ code: string }>(
        sql`SELECT app_channel_code(${dto.channelId}) AS code`,
      );
      const channelCode = channelResult.rows[0]?.code;
      if (!channelCode) throw channelNotFound(dto.channelId);

      const normalizedAddress = normalizeAddress(dto.rawAddress, channelCode);
      const isPrimary = !!dto.isPrimary;

      if (isPrimary) {
        // Demote other primary identities for this contact and channel
        await tx
          .update(schema.contactIdentities)
          .set({ isPrimary: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.contactIdentities.contactId, contactId),
              eq(schema.contactIdentities.channelId, dto.channelId),
              eq(schema.contactIdentities.isPrimary, true),
            ),
          );
      }

      const identityId = uuidv7();
      try {
        const [row] = await tx
          .insert(schema.contactIdentities)
          .values({
            id: identityId,
            orgId,
            workspaceId: contact.workspaceId,
            contactId,
            channelId: dto.channelId,
            rawAddress: dto.rawAddress,
            normalizedAddress,
            isPrimary,
            status: 'active',
          })
          .returning();

        // Privacy: zero PII in audit log
        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: contact.workspaceId,
            ...actorFromPrincipal(principal),
            action: 'contact_identity.created',
            resourceType: 'ContactIdentity',
            resourceId: identityId,
            outcome: 'success',
            before: null,
            after: null,
            metadata: {},
          },
          tx,
        );

        return identityView(row!);
      } catch (error) {
        const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
        if (
          cause?.code === '23505' &&
          cause.constraint === 'uq_contact_identities_workspace_active'
        ) {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.RESOURCE_CONFLICT,
            message: 'An active identity with this address already exists in the workspace',
          });
        }
        throw error;
      }
    });
  }

  async listIdentities(
    principal: AuthPrincipal,
    contactId: string,
    workspaceId?: string,
  ): Promise<readonly ContactIdentityResponse[]> {
    return this.db.withRequestTenant(async (tx) => {
      await this.loadContact(tx, principal, contactId, PERMISSIONS.CONTACTS_READ, workspaceId);

      const rows = await tx
        .select()
        .from(schema.contactIdentities)
        .where(eq(schema.contactIdentities.contactId, contactId))
        .orderBy(desc(schema.contactIdentities.createdAt));

      return rows.map(identityView);
    });
  }

  async updateIdentity(
    principal: AuthPrincipal,
    identityId: string,
    dto: UpdateContactIdentityDto,
  ): Promise<ContactIdentityResponse> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.contactIdentities)
        .where(
          and(
            eq(schema.contactIdentities.id, identityId),
            eq(schema.contactIdentities.orgId, orgId),
          ),
        );
      if (!existing) throw identityNotFound(identityId);

      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.CONTACTS_MANAGE,
        target: { scopeType: 'workspace', scopeId: existing.workspaceId },
        resourceType: 'Workspace',
      });

      if (dto.isPrimary) {
        await tx
          .update(schema.contactIdentities)
          .set({ isPrimary: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.contactIdentities.contactId, existing.contactId),
              eq(schema.contactIdentities.channelId, existing.channelId),
              eq(schema.contactIdentities.isPrimary, true),
            ),
          );
      }

      const updates: Partial<typeof schema.contactIdentities.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.isPrimary !== undefined) updates.isPrimary = dto.isPrimary;
      if (dto.status !== undefined) updates.status = dto.status;

      try {
        const [row] = await tx
          .update(schema.contactIdentities)
          .set(updates)
          .where(eq(schema.contactIdentities.id, identityId))
          .returning();

        // Privacy: zero PII in audit log
        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: existing.workspaceId,
            ...actorFromPrincipal(principal),
            action: 'contact_identity.updated',
            resourceType: 'ContactIdentity',
            resourceId: identityId,
            outcome: 'success',
            before: null,
            after: null,
            metadata: {},
          },
          tx,
        );

        return identityView(row!);
      } catch (error) {
        const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
        if (
          cause?.code === '23505' &&
          cause.constraint === 'uq_contact_identities_workspace_active'
        ) {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.RESOURCE_CONFLICT,
            message: 'An active identity with this address already exists in the workspace',
          });
        }
        throw error;
      }
    });
  }

  // --- Consent Events & Effective State ----------------------------------------

  async createConsentEvent(
    principal: AuthPrincipal,
    contactId: string,
    dto: CreateConsentEventDto,
    workspaceId?: string,
  ): Promise<ConsentEventResponse> {
    const occurredAtTime = new Date(dto.occurredAt).getTime();
    const fiveMinutesFuture = Date.now() + 5 * 60 * 1000;
    if (occurredAtTime > fiveMinutesFuture) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.CONSENT_FUTURE_TIMESTAMP,
        message: 'Consent event occurredAt cannot be more than 5 minutes in the future',
      });
    }

    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      // 1. Explicit contact row lock for update
      const [contact] = await tx
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)))
        .for('update');
      if (!contact) throw contactNotFound(contactId);
      if (workspaceId && contact.workspaceId !== workspaceId) throw contactNotFound(contactId);

      // 2. Authorize contacts.manage
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.CONTACTS_MANAGE,
        target: { scopeType: 'workspace', scopeId: contact.workspaceId },
        resourceType: 'Workspace',
      });

      // 3. Verify channel exists
      const channelResult = await tx.execute<{ code: string }>(
        sql`SELECT app_channel_code(${dto.channelId}) AS code`,
      );
      if (!channelResult.rows[0]?.code) throw channelNotFound(dto.channelId);

      const eventId = uuidv7();
      const [row] = await tx
        .insert(schema.consentEvents)
        .values({
          id: eventId,
          orgId,
          workspaceId: contact.workspaceId,
          contactId,
          channelId: dto.channelId,
          consentType: dto.consentType,
          event: dto.event,
          occurredAt: new Date(dto.occurredAt),
          source: dto.source,
        })
        .returning();

      // Privacy: zero PII in audit log
      await this.audit.record(
        {
          scopeType: 'workspace',
          scopeId: contact.workspaceId,
          ...actorFromPrincipal(principal),
          action: 'consent_event.recorded',
          resourceType: 'ConsentEvent',
          resourceId: eventId,
          outcome: 'success',
          before: null,
          after: null,
          metadata: {},
        },
        tx,
      );

      return consentEventView(row!);
    });
  }

  async listConsentEvents(
    principal: AuthPrincipal,
    contactId: string,
    workspaceId?: string,
  ): Promise<readonly ConsentEventResponse[]> {
    return this.db.withRequestTenant(async (tx) => {
      await this.loadContact(tx, principal, contactId, PERMISSIONS.CONTACTS_READ, workspaceId);

      const rows = await tx
        .select()
        .from(schema.consentEvents)
        .where(eq(schema.consentEvents.contactId, contactId))
        .orderBy(
          desc(schema.consentEvents.occurredAt),
          desc(schema.consentEvents.createdAt),
          desc(schema.consentEvents.id),
        );

      return rows.map(consentEventView);
    });
  }

  /**
   * Deterministic effective consent state evaluation algorithm:
   * 1. Query events bounded by now() + 5 minutes.
   * 2. If no events: unconsented.
   * 3. Group by max occurred_at:
   *    - If contradictory (both grant and revoke present at max occurred_at): fail closed to unconsented.
   *    - If only grant: opted_in.
   *    - If only revoke: opted_out.
   */
  async getEffectiveConsent(
    principal: AuthPrincipal,
    contactId: string,
    dto: GetEffectiveConsentDto,
    workspaceId?: string,
  ): Promise<EffectiveConsentResponse> {
    return this.db.withRequestTenant(async (tx) => {
      await this.loadContact(tx, principal, contactId, PERMISSIONS.CONTACTS_READ, workspaceId);

      const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
      const rows = await tx
        .select()
        .from(schema.consentEvents)
        .where(
          and(
            eq(schema.consentEvents.contactId, contactId),
            eq(schema.consentEvents.channelId, dto.channelId),
            eq(schema.consentEvents.consentType, dto.consentType),
            lte(schema.consentEvents.occurredAt, fiveMinutesFromNow),
          ),
        )
        .orderBy(
          desc(schema.consentEvents.occurredAt),
          desc(schema.consentEvents.createdAt),
          desc(schema.consentEvents.id),
        );

      let effectiveState: EffectiveConsentState = 'unconsented';
      if (rows.length > 0) {
        const maxOccurredAt = rows[0]!.occurredAt.getTime();
        const latestBatch = rows.filter((r) => r.occurredAt.getTime() === maxOccurredAt);
        const hasGrant = latestBatch.some((r) => r.event === 'grant');
        const hasRevoke = latestBatch.some((r) => r.event === 'revoke');

        if (hasGrant && hasRevoke) {
          // Contradiction at latest business timestamp: fail closed
          effectiveState = 'unconsented';
        } else if (hasGrant) {
          effectiveState = 'opted_in';
        } else if (hasRevoke) {
          effectiveState = 'opted_out';
        }
      }

      return {
        contactId,
        channelId: dto.channelId,
        consentType: dto.consentType,
        effectiveState,
        evaluatedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Resolves campaign audiences from contacts within an organization or workspace (Phase 8A-S).
   * Supports tag segmentation (any/all), channel eligibility, suppression preflight,
   * deterministic consent evaluation, exact counting, and keyset pagination.
   */
  async resolveAudience(
    principal: AuthPrincipal,
    dto: ResolveAudienceDto = {},
    targetWorkspaceId?: string,
  ): Promise<AudienceResolutionResponse> {
    const orgId = requireOrganization(principal);
    const effectiveWorkspaceId = targetWorkspaceId ?? dto.workspaceId;

    // Consent filters are evaluated per channel. Without a channel they would be silently
    // ignored and the audience would include unconsented and revoked contacts, so refuse
    // (fail closed) instead.
    if (
      (dto.requireOptIn === true || dto.consentType !== undefined) &&
      !dto.channelId &&
      !dto.channel
    ) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'requireOptIn and consentType require channel or channelId',
        logContext: { requireOptIn: dto.requireOptIn === true, consentType: dto.consentType },
      });
    }

    return this.db.withRequestTenant(async (tx) => {
      // 1. Tenancy & Workspace Access Assertion
      if (effectiveWorkspaceId) {
        await this.assertWorkspaceAccess(
          tx,
          principal,
          effectiveWorkspaceId,
          PERMISSIONS.CONTACTS_READ,
        );
      } else {
        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.CONTACTS_READ,
          target: { scopeType: 'organization', scopeId: orgId },
          resourceType: 'Organization',
        });
      }

      // 2. Channel Resolution (if requested)
      let resolvedChannel: { id: string; code: string } | undefined;
      if (dto.channelId) {
        const channelResult = await tx.execute<{ code: string }>(
          sql`SELECT app_channel_code(${dto.channelId}) AS code`,
        );
        const code = channelResult.rows[0]?.code;
        if (!code) throw channelNotFound(dto.channelId);
        resolvedChannel = { id: dto.channelId, code };
      } else if (dto.channel) {
        const channelResult = await tx.execute<{ id: string; code: string; status: string }>(
          sql`SELECT id, code, status FROM app_channel_resolve(${dto.channel}::text)`,
        );
        const ch = channelResult.rows[0];
        if (!ch) {
          throw new AppException({
            status: HttpStatus.NOT_FOUND,
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: `Channel '${dto.channel}' not found`,
            logContext: { requestedChannel: dto.channel },
          });
        }
        resolvedChannel = { id: ch.id, code: ch.code };
      }

      // 3. Build Predicates
      const predicates: SQL[] = [eq(schema.contacts.orgId, orgId)];
      if (effectiveWorkspaceId) {
        predicates.push(eq(schema.contacts.workspaceId, effectiveWorkspaceId));
      }

      // Tag Filtering
      const rawTags = dto.tags ?? [];
      const uniqueLowerTags = Array.from(
        new Set(rawTags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
      );

      if (uniqueLowerTags.length > 0) {
        const tagMode = dto.tagMatchMode ?? 'any';
        const tagsJsonbArrayExpr = sql`CASE
          WHEN jsonb_typeof(${schema.contacts.metadata}->'tags') = 'array' THEN ${schema.contacts.metadata}->'tags'
          WHEN jsonb_typeof(${schema.contacts.metadata}->'tag_list') = 'array' THEN ${schema.contacts.metadata}->'tag_list'
          ELSE '[]'::jsonb
        END`;

        const tagListSql = sql.join(
          uniqueLowerTags.map((t) => sql`${t}`),
          sql`, `,
        );

        if (tagMode === 'all') {
          predicates.push(
            sql`(
              SELECT count(DISTINCT lower(elem))
              FROM jsonb_array_elements_text(${tagsJsonbArrayExpr}) AS elem
              WHERE lower(elem) IN (${tagListSql})
            ) = ${uniqueLowerTags.length}`,
          );
        } else {
          predicates.push(
            sql`EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(${tagsJsonbArrayExpr}) AS elem
              WHERE lower(elem) IN (${tagListSql})
            )`,
          );
        }
      }

      // Channel Eligibility, Suppression & Consent
      if (resolvedChannel) {
        // Must have an active identity for this channel that is NOT actively suppressed
        predicates.push(
          sql`EXISTS (
            SELECT 1
            FROM ${schema.contactIdentities} ci
            WHERE ci.contact_id = ${schema.contacts.id}
              AND ci.channel_id = ${resolvedChannel.id}
              AND ci.status = 'active'
              AND NOT EXISTS (
                SELECT 1
                FROM ${schema.suppressions} s
                WHERE s.org_id = ${schema.contacts.orgId}
                  AND (s.channel_id = ${resolvedChannel.id} OR s.channel_id IS NULL)
                  AND s.normalized_address = ci.normalized_address
                  AND s.status = 'active'
              )
          )`,
        );

        // Consent evaluation bounded by now + 5 min
        const fiveMinutesFuture = new Date(Date.now() + 5 * 60 * 1000);
        const consentTypeFilter = dto.consentType
          ? sql`AND ce.consent_type = ${dto.consentType}`
          : sql``;
        const consentTypeInnerFilter = dto.consentType
          ? sql`AND ce_inner.consent_type = ${dto.consentType}`
          : sql``;

        if (dto.requireOptIn) {
          // Explicit opt-in required: must have grant at max occurred_at and no revoke at max occurred_at
          predicates.push(
            sql`EXISTS (
              SELECT 1
              FROM ${schema.consentEvents} ce
              WHERE ce.contact_id = ${schema.contacts.id}
                AND ce.channel_id = ${resolvedChannel.id}
                ${consentTypeFilter}
                AND ce.occurred_at <= ${fiveMinutesFuture}
                AND ce.occurred_at = (
                  SELECT MAX(ce_inner.occurred_at)
                  FROM ${schema.consentEvents} ce_inner
                  WHERE ce_inner.contact_id = ${schema.contacts.id}
                    AND ce_inner.channel_id = ${resolvedChannel.id}
                    ${consentTypeInnerFilter}
                    AND ce_inner.occurred_at <= ${fiveMinutesFuture}
                )
                AND ce.event = 'grant'
            )`,
          );
        }

        // Under both default and opt-in modes: must NOT have a revoke at max occurred_at
        predicates.push(
          sql`NOT EXISTS (
            SELECT 1
            FROM ${schema.consentEvents} ce
            WHERE ce.contact_id = ${schema.contacts.id}
              AND ce.channel_id = ${resolvedChannel.id}
              ${consentTypeFilter}
              AND ce.occurred_at <= ${fiveMinutesFuture}
              AND ce.occurred_at = (
                SELECT MAX(ce_inner.occurred_at)
                FROM ${schema.consentEvents} ce_inner
                WHERE ce_inner.contact_id = ${schema.contacts.id}
                  AND ce_inner.channel_id = ${resolvedChannel.id}
                  ${consentTypeInnerFilter}
                  AND ce_inner.occurred_at <= ${fiveMinutesFuture}
              )
              AND ce.event = 'revoke'
          )`,
        );
      }

      // 4. Exact Total Count (Never estimated or fabricated)
      const [countResult] = await tx
        .select({ count: sql<number>`count(DISTINCT ${schema.contacts.id})::int` })
        .from(schema.contacts)
        .where(and(...predicates));
      const totalCount = Number(countResult?.count ?? 0);

      // 5. Deterministic Keyset Pagination
      const resolved = this.lists.resolve(dto, this.listSpec);
      const pagePredicates = [...predicates];
      if (resolved.after) pagePredicates.push(resolved.after);

      const rows = await tx
        .select()
        .from(schema.contacts)
        .where(and(...pagePredicates))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));

      const { items, page } = this.lists.paginate(
        rows as unknown as Record<string, unknown>[],
        resolved,
        this.listSpec,
        (row) => String(row.id),
      );

      if (items.length === 0) {
        return { data: [], totalCount, page };
      }

      // 6. Hydrate Identities & Consent for returned page items
      const contactIds = items.map((r) => String(r.id));

      const identityPredicates = [
        inArray(schema.contactIdentities.contactId, contactIds),
        eq(schema.contactIdentities.status, 'active'),
      ];
      if (resolvedChannel) {
        identityPredicates.push(eq(schema.contactIdentities.channelId, resolvedChannel.id));
      }

      const identityRows = await tx
        .select({
          id: schema.contactIdentities.id,
          workspaceId: schema.contactIdentities.workspaceId,
          contactId: schema.contactIdentities.contactId,
          channelId: schema.contactIdentities.channelId,
          channelCode: sql<string>`app_channel_code(${schema.contactIdentities.channelId})`,
          rawAddress: schema.contactIdentities.rawAddress,
          normalizedAddress: schema.contactIdentities.normalizedAddress,
          isPrimary: schema.contactIdentities.isPrimary,
          status: schema.contactIdentities.status,
          createdAt: schema.contactIdentities.createdAt,
          updatedAt: schema.contactIdentities.updatedAt,
        })
        .from(schema.contactIdentities)
        .where(and(...identityPredicates))
        .orderBy(
          desc(schema.contactIdentities.isPrimary),
          desc(schema.contactIdentities.createdAt),
        );

      const identitiesByContact = new Map<string, AudienceMemberIdentity[]>();
      for (const idRow of identityRows) {
        const list = identitiesByContact.get(idRow.contactId) ?? [];
        list.push({
          id: idRow.id,
          channelId: idRow.channelId,
          channelCode: idRow.channelCode,
          rawAddress: idRow.rawAddress,
          normalizedAddress: idRow.normalizedAddress,
          isPrimary: idRow.isPrimary,
          status: idRow.status,
        });
        identitiesByContact.set(idRow.contactId, list);
      }

      // If channel is specified, compute effective consent state for each contact
      const consentByContact = new Map<string, EffectiveConsentState>();
      if (resolvedChannel) {
        const fiveMinutesFuture = new Date(Date.now() + 5 * 60 * 1000);
        const consentPredicates = [
          inArray(schema.consentEvents.contactId, contactIds),
          eq(schema.consentEvents.channelId, resolvedChannel.id),
          lte(schema.consentEvents.occurredAt, fiveMinutesFuture),
        ];
        if (dto.consentType) {
          consentPredicates.push(eq(schema.consentEvents.consentType, dto.consentType));
        }

        const consentRows = await tx
          .select()
          .from(schema.consentEvents)
          .where(and(...consentPredicates))
          .orderBy(
            desc(schema.consentEvents.occurredAt),
            desc(schema.consentEvents.createdAt),
            desc(schema.consentEvents.id),
          );

        // Group by contactId
        const eventsByContact = new Map<string, typeof consentRows>();
        for (const ce of consentRows) {
          const list = eventsByContact.get(ce.contactId) ?? [];
          list.push(ce);
          eventsByContact.set(ce.contactId, list);
        }

        for (const cId of contactIds) {
          const cEvents = eventsByContact.get(cId) ?? [];
          if (cEvents.length === 0) {
            consentByContact.set(cId, 'unconsented');
          } else {
            const maxOccurredAt = cEvents[0]!.occurredAt.getTime();
            const latestBatch = cEvents.filter((r) => r.occurredAt.getTime() === maxOccurredAt);
            const hasGrant = latestBatch.some((r) => r.event === 'grant');
            const hasRevoke = latestBatch.some((r) => r.event === 'revoke');

            if (hasGrant && hasRevoke) {
              consentByContact.set(cId, 'unconsented');
            } else if (hasGrant) {
              consentByContact.set(cId, 'opted_in');
            } else if (hasRevoke) {
              consentByContact.set(cId, 'opted_out');
            }
          }
        }
      }

      const members: AudienceMemberResponse[] = items.map((row) => {
        const c = row as unknown as ContactRow;
        return {
          contactId: c.id,
          workspaceId: c.workspaceId,
          firstName: c.firstName,
          lastName: c.lastName,
          tags: extractContactTagsFromMetadata(c.metadata),
          metadata: (c.metadata as Record<string, unknown>) ?? {},
          identities: identitiesByContact.get(c.id) ?? [],
          consentState: resolvedChannel ? (consentByContact.get(c.id) ?? 'unconsented') : null,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        };
      });

      return {
        data: members,
        totalCount,
        page,
      };
    });
  }
}
