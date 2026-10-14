import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
  type ContactResponse,
  type ContactIdentityResponse,
  type ConsentEventResponse,
  type EffectiveConsentResponse,
  type EffectiveConsentState,
  type PageInfo,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, desc, eq, lte, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { requireOrganization, workspaceNotFound } from '../workspaces/workspace-administration.service';
import type {
  CreateContactDto,
  CreateContactIdentityDto,
  CreateConsentEventDto,
  GetEffectiveConsentDto,
  UpdateContactDto,
  UpdateContactIdentityDto,
} from './contacts.dto';
import { normalizeAddress } from './contacts.normalization';

type ContactRow = typeof schema.contacts.$inferSelect;
type IdentityRow = typeof schema.contactIdentities.$inferSelect;
type ConsentEventRow = typeof schema.consentEvents.$inferSelect;

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
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.contacts.id, encode: (row) => String(row.id) },
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
      const row = await this.loadContact(tx, principal, contactId, PERMISSIONS.CONTACTS_READ, workspaceId);
      return contactView(row);
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
        if (cause?.code === '23505' && cause.constraint === 'uq_contact_identities_workspace_active') {
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
        .where(and(eq(schema.contactIdentities.id, identityId), eq(schema.contactIdentities.orgId, orgId)));
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
        if (cause?.code === '23505' && cause.constraint === 'uq_contact_identities_workspace_active') {
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
}
