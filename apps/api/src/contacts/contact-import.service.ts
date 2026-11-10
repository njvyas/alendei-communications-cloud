import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
  type DuplicateStrategy,
  type ImportContactRow,
  type ImportContactsResponse,
  type ImportMode,
  type ImportRowError,
  type ImportRowResult,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { TenantDatabase } from '../database/tenant-database.service';
import {
  requireOrganization,
  workspaceNotFound,
} from '../workspaces/workspace-administration.service';
import type { ImportContactsDto } from './contacts.dto';
import {
  normalizeEmailAddress,
  normalizePhoneNumber,
  unescapeCsvFormulaField,
} from './contacts.normalization';
import { parseCsvToObjects } from './csv-parser';

const MAX_IMPORT_ROWS = 5000;

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

function extractTags(metadata: unknown): string[] {
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

class AbortImportException extends Error {
  constructor(
    public readonly errors: ImportRowError[],
    public readonly totalCount: number,
  ) {
    super('Import aborted due to errors');
  }
}

@Injectable()
export class ContactImportService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  async importContacts(
    principal: AuthPrincipal,
    workspaceId: string,
    dto: ImportContactsDto,
  ): Promise<{ status: HttpStatus; body: ImportContactsResponse }> {
    const orgId = requireOrganization(principal);
    const mode: ImportMode = dto.mode ?? 'abort_on_error';
    const duplicateStrategy: DuplicateStrategy = dto.duplicateStrategy ?? 'skip';

    // 1. Authorize contacts.import
    await this.db.withRequestTenant(async (tx) => {
      const [workspaceRecord] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.orgId, orgId)));
      if (!workspaceRecord) throw workspaceNotFound(workspaceId);

      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.CONTACTS_IMPORT,
        target: { scopeType: 'workspace', scopeId: workspaceId },
        resourceType: 'Workspace',
      });
    });

    // 2. Parse Contacts Rows
    let rowsToImport: ImportContactRow[] = [];
    if (dto.csv) {
      rowsToImport = this.parseCsvRows(dto.csv);
    } else if (dto.contacts && Array.isArray(dto.contacts)) {
      rowsToImport = [...dto.contacts];
    }

    // 3. Enforce 5,000 Row Limit
    if (rowsToImport.length > MAX_IMPORT_ROWS) {
      await this.db.withRequestTenant(async (tx) => {
        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: workspaceId,
            ...actorFromPrincipal(principal),
            action: 'contact.import_failed',
            resourceType: 'Contact',
            resourceId: workspaceId,
            outcome: 'failure',
            before: null,
            after: null,
            metadata: {
              totalCount: rowsToImport.length,
              failed: rowsToImport.length,
              reason: 'row_limit_exceeded',
              mode,
              duplicateStrategy,
            },
          },
          tx,
        );
      });

      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.IMPORT_ROW_LIMIT_EXCEEDED,
        message: `Import row count (${rowsToImport.length}) exceeds maximum limit of ${MAX_IMPORT_ROWS} rows`,
        logContext: { count: rowsToImport.length, limit: MAX_IMPORT_ROWS },
      });
    }

    if (rowsToImport.length === 0) {
      return {
        status: HttpStatus.OK,
        body: {
          summary: {
            totalCount: 0,
            processedCount: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            failed: 0,
          },
          errors: [],
          results: [],
        },
      };
    }

    // 4. Execute Transaction
    try {
      const response = await this.db.withRequestTenant(async (tx) => {
        // Resolve default channels
        const { defaultPhoneChannelId, defaultEmailChannelId } = await this.resolveDefaultChannels(
          tx,
          dto,
        );

        const results: ImportRowResult[] = [];
        const errors: ImportRowError[] = [];

        let createdCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;

        for (let idx = 0; idx < rowsToImport.length; idx++) {
          const row = rowsToImport[idx]!;
          const rowNumber = row.rowNumber ?? idx + 1;
          const identifier = row.phone ?? row.email ?? `row-${rowNumber}`;

          if (mode === 'skip_invalid') {
            await tx.execute(sql.raw(`SAVEPOINT sp_${idx}`));
          }

          try {
            const outcome = await this.processRow(
              tx,
              orgId,
              workspaceId,
              row,
              rowNumber,
              duplicateStrategy,
              defaultPhoneChannelId,
              defaultEmailChannelId,
            );

            if (outcome.action === 'created') createdCount++;
            else if (outcome.action === 'updated') updatedCount++;
            else if (outcome.action === 'skipped') skippedCount++;

            results.push(outcome);

            if (mode === 'skip_invalid') {
              await tx.execute(sql.raw(`RELEASE SAVEPOINT sp_${idx}`));
            }
          } catch (error) {
            const rowErr = this.mapErrorToRowError(error, rowNumber, identifier);
            errors.push(rowErr);

            if (mode === 'abort_on_error') {
              if (error instanceof AppException && error.getStatus() === HttpStatus.CONFLICT) {
                throw error;
              }
              // Roll back entire transaction
              throw new AbortImportException(errors, rowsToImport.length);
            } else {
              // Roll back savepoint for this row only
              await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT sp_${idx}`));
            }
          }
        }

        // Privacy: zero PII in audit log
        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: workspaceId,
            ...actorFromPrincipal(principal),
            action: 'contact.imported',
            resourceType: 'Contact',
            resourceId: workspaceId,
            outcome: 'success',
            before: null,
            after: null,
            metadata: {
              totalCount: rowsToImport.length,
              processedCount: createdCount + updatedCount + skippedCount,
              created: createdCount,
              updated: updatedCount,
              skipped: skippedCount,
              failed: errors.length,
              mode,
              duplicateStrategy,
            },
          },
          tx,
        );

        return {
          status: HttpStatus.OK,
          body: {
            summary: {
              totalCount: rowsToImport.length,
              processedCount: createdCount + updatedCount + skippedCount,
              created: createdCount,
              updated: updatedCount,
              skipped: skippedCount,
              failed: errors.length,
            },
            errors,
            results,
          },
        };
      });

      return response;
    } catch (error) {
      if (error instanceof AbortImportException) {
        // Record failure audit log with zero PII inside transaction (ADR-015 R-1, R-12)
        await this.db.withRequestTenant(async (tx) => {
          await this.audit.record(
            {
              scopeType: 'workspace',
              scopeId: workspaceId,
              ...actorFromPrincipal(principal),
              action: 'contact.import_failed',
              resourceType: 'Contact',
              resourceId: workspaceId,
              outcome: 'failure',
              before: null,
              after: null,
              metadata: {
                totalCount: error.totalCount,
                failed: error.errors.length,
                mode,
                duplicateStrategy,
              },
            },
            tx,
          );
        });

        // 422 Unprocessable Entity on abort_on_error with row errors
        return {
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          body: {
            summary: {
              totalCount: error.totalCount,
              processedCount: 0,
              created: 0,
              updated: 0,
              skipped: 0,
              failed: error.errors.length,
            },
            errors: error.errors,
            results: [],
          },
        };
      }
      throw error;
    }
  }

  private parseCsvRows(csvText: string): ImportContactRow[] {
    const { records } = parseCsvToObjects(csvText);
    const parsedEntries: ImportContactRow[] = [];

    for (const record of records) {
      const data = record.data;
      const lowerMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        lowerMap[k.toLowerCase().replace(/[\s_-]/g, '')] = v;
      }

      const firstNameRaw =
        lowerMap['firstname'] ?? lowerMap['first'] ?? lowerMap['givenname'] ?? '';
      const lastNameRaw = lowerMap['lastname'] ?? lowerMap['last'] ?? lowerMap['familyname'] ?? '';
      const phoneRaw = lowerMap['phone'] ?? lowerMap['phonenumber'] ?? lowerMap['mobile'] ?? '';
      const emailRaw = lowerMap['email'] ?? lowerMap['emailaddress'] ?? '';
      const tagsRaw = lowerMap['tags'] ?? lowerMap['taglist'] ?? '';

      const tags = tagsRaw
        ? tagsRaw
            .split(/[;,]/)
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        : undefined;

      const customFields: Record<string, unknown> = {};
      const standardKeys = new Set([
        'firstname',
        'first',
        'givenname',
        'lastname',
        'last',
        'familyname',
        'phone',
        'phonenumber',
        'mobile',
        'email',
        'emailaddress',
        'tags',
        'taglist',
        'consentchannel',
        'consentchannelcode',
        'consenttype',
        'consentevent',
        'consentaction',
        'consentoccurredat',
        'consentsource',
      ]);

      for (const [origKey, origVal] of Object.entries(data)) {
        const cleanKey = origKey.toLowerCase().replace(/[\s_-]/g, '');
        if (!standardKeys.has(cleanKey) && origVal.trim().length > 0) {
          customFields[origKey] = unescapeCsvFormulaField(origVal);
        }
      }

      let consent: ImportContactRow['consent'] = undefined;
      const consentChannelCode = (
        lowerMap['consentchannel'] ??
        lowerMap['consentchannelcode'] ??
        ''
      ).toLowerCase();
      const consentType = lowerMap['consenttype'] ?? '';
      const consentEvent = (
        lowerMap['consentevent'] ??
        lowerMap['consentaction'] ??
        ''
      ).toLowerCase();

      if (
        consentChannelCode &&
        consentType &&
        (consentEvent === 'grant' || consentEvent === 'revoke')
      ) {
        consent = {
          channelCode: consentChannelCode as 'whatsapp' | 'sms' | 'email' | 'rcs',
          consentType,
          event: consentEvent,
          occurredAt: lowerMap['consentoccurredat'] || undefined,
          source: lowerMap['consentsource'] || 'import',
        };
      }

      parsedEntries.push({
        rowNumber: record.rowNumber,
        firstName: firstNameRaw ? unescapeCsvFormulaField(firstNameRaw) : null,
        lastName: lastNameRaw ? unescapeCsvFormulaField(lastNameRaw) : null,
        phone: phoneRaw ? phoneRaw : null,
        email: emailRaw ? emailRaw : null,
        tags,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
        consent,
      });
    }

    return parsedEntries;
  }

  private async resolveDefaultChannels(
    tx: Transaction,
    dto: ImportContactsDto,
  ): Promise<{ defaultPhoneChannelId: string; defaultEmailChannelId: string }> {
    let phoneId = dto.defaultPhoneChannelId;
    let emailId = dto.defaultEmailChannelId;

    const catalogueRes = await tx.execute<{ id: string; code: string; status: string }>(
      sql`SELECT id, code::text, status::text FROM app_channel_catalogue()`,
    );
    const catalogue = catalogueRes.rows;

    if (phoneId) {
      const found = catalogue.find((c) => c.id === phoneId);
      if (!found) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `Default phone channel '${phoneId}' not found`,
        });
      }
    } else {
      const smsCh = catalogue.find((c) => c.code === 'sms');
      const waCh = catalogue.find((c) => c.code === 'whatsapp');
      const found = smsCh ?? waCh;
      if (!found) {
        throw new AppException({
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'No default SMS/phone channel configured in the system',
        });
      }
      phoneId = found.id;
    }

    if (emailId) {
      const found = catalogue.find((c) => c.id === emailId);
      if (!found) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `Default email channel '${emailId}' not found`,
        });
      }
    } else {
      const emailCh = catalogue.find((c) => c.code === 'email');
      if (!emailCh) {
        throw new AppException({
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'No default email channel configured in the system',
        });
      }
      emailId = emailCh.id;
    }

    return {
      defaultPhoneChannelId: phoneId,
      defaultEmailChannelId: emailId,
    };
  }

  private async processRow(
    tx: Transaction,
    orgId: string,
    workspaceId: string,
    row: ImportContactRow,
    rowNumber: number,
    duplicateStrategy: DuplicateStrategy,
    defaultPhoneChannelId: string,
    defaultEmailChannelId: string,
  ): Promise<ImportRowResult> {
    const rawPhone = row.phone?.trim();
    const rawEmail = row.email?.trim();

    if (!rawPhone && !rawEmail) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.IDENTITY_REQUIRED,
        message: 'At least one contact identity (phone or email) is required',
      });
    }

    let normPhone: string | null = null;
    if (rawPhone) {
      normPhone = normalizePhoneNumber(rawPhone);
    }

    let normEmail: string | null = null;
    if (rawEmail) {
      normEmail = normalizeEmailAddress(rawEmail);
    }

    // Validate Custom Fields
    if (row.customFields) {
      for (const field of Object.keys(row.customFields)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(field)) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.VALIDATION_FAILED,
            message: `Invalid custom field name '${field}'`,
          });
        }
        if (FORBIDDEN_CUSTOM_FIELDS.has(field.toLowerCase())) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.VALIDATION_FAILED,
            message: `Custom field cannot use reserved name '${field}'`,
          });
        }
      }
    }

    // Validate Consent
    let consentChannelId: string | null = null;
    let consentOccurredAt = new Date();
    if (row.consent) {
      const { channelCode, consentType, event, occurredAt } = row.consent;
      if (!['whatsapp', 'sms', 'email', 'rcs'].includes(channelCode)) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `Invalid consent channel code '${channelCode}'`,
        });
      }
      if (!consentType || consentType.trim().length === 0 || consentType.length > 64) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'Consent type must be 1-64 characters',
        });
      }
      if (event !== 'grant' && event !== 'revoke') {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `Invalid consent event '${event}' (must be grant or revoke)`,
        });
      }
      if (occurredAt) {
        consentOccurredAt = new Date(occurredAt);
        if (isNaN(consentOccurredAt.getTime())) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.VALIDATION_FAILED,
            message: 'Invalid consent occurredAt timestamp',
          });
        }
        if (consentOccurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.CONSENT_FUTURE_TIMESTAMP,
            message: 'Consent occurredAt cannot be more than 5 minutes in the future',
          });
        }
      }

      const channelRes = await tx.execute<{ id: string }>(
        sql`SELECT id FROM app_channel_catalogue() WHERE code::text = ${channelCode} LIMIT 1`,
      );
      if (!channelRes.rows[0]) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `Channel '${channelCode}' is not configured`,
        });
      }
      consentChannelId = channelRes.rows[0].id;
    }

    // 5. Query matching active identities in this workspace
    let phoneMatchContactId: string | null = null;
    if (normPhone) {
      const phoneRes = await tx.execute<{ contact_id: string }>(
        sql`SELECT ci.contact_id
            FROM contact_identities ci
            JOIN app_channel_catalogue() ch ON ch.id = ci.channel_id
            WHERE ci.workspace_id = ${workspaceId}
              AND ci.status = 'active'
              AND ci.normalized_address = ${normPhone}
              AND ch.code IN ('sms', 'whatsapp', 'rcs', 'voice')
            LIMIT 1`,
      );
      if (phoneRes.rows[0]) {
        phoneMatchContactId = phoneRes.rows[0].contact_id;
      }
    }

    let emailMatchContactId: string | null = null;
    if (normEmail) {
      const emailRes = await tx.execute<{ contact_id: string }>(
        sql`SELECT ci.contact_id
            FROM contact_identities ci
            JOIN app_channel_catalogue() ch ON ch.id = ci.channel_id
            WHERE ci.workspace_id = ${workspaceId}
              AND ci.status = 'active'
              AND ci.normalized_address = ${normEmail}
              AND ch.code = 'email'
            LIMIT 1`,
      );
      if (emailRes.rows[0]) {
        emailMatchContactId = emailRes.rows[0].contact_id;
      }
    }

    // 6. Identity Conflict Check (Fail closed with 409 IDENTITY_CONFLICT)
    if (phoneMatchContactId && emailMatchContactId && phoneMatchContactId !== emailMatchContactId) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.IDENTITY_CONFLICT,
        message: `Identity conflict: phone belongs to contact ${phoneMatchContactId} and email belongs to contact ${emailMatchContactId}. Contacts cannot be merged.`,
        logContext: {
          phoneMatchContactId,
          emailMatchContactId,
          rowNumber,
        },
      });
    }

    const matchedContactId = phoneMatchContactId ?? emailMatchContactId;

    // 7. Handle Duplicate or Matched Contact
    if (matchedContactId) {
      if (duplicateStrategy === 'fail') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.DUPLICATE_IDENTITY_EXISTS,
          message: `Duplicate contact identity exists for contact ${matchedContactId}`,
          logContext: { contactId: matchedContactId, rowNumber },
        });
      }

      if (duplicateStrategy === 'skip') {
        return {
          row: rowNumber,
          action: 'skipped',
          contactId: matchedContactId,
          reason: 'Duplicate contact skipped',
        };
      }

      if (duplicateStrategy === 'update') {
        // Lock contact row for update
        const [existing] = await tx
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, matchedContactId))
          .for('update');

        if (!existing) {
          throw new AppException({
            status: HttpStatus.NOT_FOUND,
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: 'Matched contact not found during update',
          });
        }

        // Merge tags
        const existingTags = extractTags(existing.metadata);
        const newTags = row.tags ?? [];
        const mergedTags = Array.from(new Set([...existingTags, ...newTags]));

        // Merge custom fields
        const existingMeta =
          existing.metadata && typeof existing.metadata === 'object'
            ? (existing.metadata as Record<string, unknown>)
            : {};
        const mergedMeta: Record<string, unknown> = {
          ...existingMeta,
          ...(row.customFields ?? {}),
          tags: mergedTags,
        };

        const updates: Partial<typeof schema.contacts.$inferInsert> = {
          metadata: mergedMeta,
          updatedAt: new Date(),
        };
        if (row.firstName !== undefined && row.firstName !== null) {
          updates.firstName = row.firstName;
        }
        if (row.lastName !== undefined && row.lastName !== null) {
          updates.lastName = row.lastName;
        }

        await tx
          .update(schema.contacts)
          .set(updates)
          .where(eq(schema.contacts.id, matchedContactId));

        // Link secondary identity if missing
        if (normPhone && !phoneMatchContactId) {
          await tx.insert(schema.contactIdentities).values({
            id: uuidv7(),
            orgId,
            workspaceId,
            contactId: matchedContactId,
            channelId: defaultPhoneChannelId,
            rawAddress: rawPhone!,
            normalizedAddress: normPhone,
            isPrimary: false,
            status: 'active',
          });
        }

        if (normEmail && !emailMatchContactId) {
          await tx.insert(schema.contactIdentities).values({
            id: uuidv7(),
            orgId,
            workspaceId,
            contactId: matchedContactId,
            channelId: defaultEmailChannelId,
            rawAddress: rawEmail!,
            normalizedAddress: normEmail,
            isPrimary: false,
            status: 'active',
          });
        }

        // Append immutable consent event if provided
        if (row.consent && consentChannelId) {
          await tx.insert(schema.consentEvents).values({
            id: uuidv7(),
            orgId,
            workspaceId,
            contactId: matchedContactId,
            channelId: consentChannelId,
            consentType: row.consent.consentType,
            event: row.consent.event,
            occurredAt: consentOccurredAt,
            source: row.consent.source ?? 'import',
          });
        }

        return {
          row: rowNumber,
          action: 'updated',
          contactId: matchedContactId,
        };
      }
    }

    // 8. Create New Contact
    const newContactId = uuidv7();
    const tags = row.tags ? Array.from(new Set(row.tags)) : [];
    const meta: Record<string, unknown> = {
      tags,
      ...(row.customFields ?? {}),
    };

    await tx.insert(schema.contacts).values({
      id: newContactId,
      orgId,
      workspaceId,
      firstName: row.firstName ?? null,
      lastName: row.lastName ?? null,
      metadata: meta,
    });

    if (normPhone) {
      await tx.insert(schema.contactIdentities).values({
        id: uuidv7(),
        orgId,
        workspaceId,
        contactId: newContactId,
        channelId: defaultPhoneChannelId,
        rawAddress: rawPhone!,
        normalizedAddress: normPhone,
        isPrimary: true,
        status: 'active',
      });
    }

    if (normEmail) {
      await tx.insert(schema.contactIdentities).values({
        id: uuidv7(),
        orgId,
        workspaceId,
        contactId: newContactId,
        channelId: defaultEmailChannelId,
        rawAddress: rawEmail!,
        normalizedAddress: normEmail,
        isPrimary: true,
        status: 'active',
      });
    }

    if (row.consent && consentChannelId) {
      await tx.insert(schema.consentEvents).values({
        id: uuidv7(),
        orgId,
        workspaceId,
        contactId: newContactId,
        channelId: consentChannelId,
        consentType: row.consent.consentType,
        event: row.consent.event,
        occurredAt: consentOccurredAt,
        source: row.consent.source ?? 'import',
      });
    }

    return {
      row: rowNumber,
      action: 'created',
      contactId: newContactId,
    };
  }

  private mapErrorToRowError(
    error: unknown,
    rowNumber: number,
    identifier?: string,
  ): ImportRowError {
    if (error instanceof AppException) {
      return {
        row: rowNumber,
        identifier,
        code: error.code,
        message: error.message,
      };
    }
    const err = error as Error;
    return {
      row: rowNumber,
      identifier,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: err.message || 'Internal error processing row',
    };
  }
}
