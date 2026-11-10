import { HttpStatus, Injectable } from '@nestjs/common';
import {
  CUSTOM_FIELD_OPERATORS,
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Response } from 'express';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { TenantDatabase } from '../database/tenant-database.service';
import {
  requireOrganization,
  workspaceNotFound,
} from '../workspaces/workspace-administration.service';
import type { ExportContactsDto } from './contacts.dto';
import {
  escapeCsvFormulaField,
  escapeCustomFieldsForCsv,
  escapeTagsForCsv,
} from './contacts.normalization';
import { serializeCsvRow } from './csv-parser';

const EXPORT_CEILING = 50000;
const CHUNK_SIZE = 1000;

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
    return rawTags.filter((t): t is string => typeof t === 'string' && t.length > 0);
  }
  if (typeof rawTags === 'string') {
    return rawTags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

function extractCustomFields(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {};
  const m = metadata as Record<string, unknown>;
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k !== 'tags' && k !== 'tag_list') {
      custom[k] = v;
    }
  }
  return custom;
}

@Injectable()
export class ContactExportService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  async exportContacts(
    principal: AuthPrincipal,
    workspaceId: string,
    dto: ExportContactsDto,
    response: Response,
  ): Promise<void> {
    const orgId = requireOrganization(principal);
    const format = dto.format ?? 'csv';

    let headersSent = false;

    try {
      // 1. Authorize contacts.export
      await this.db.withRequestTenant(async (tx) => {
        const [workspaceRecord] = await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.orgId, orgId)));
        if (!workspaceRecord) throw workspaceNotFound(workspaceId);

        await this.authorization.assert(tx, {
          principal,
          permission: PERMISSIONS.CONTACTS_EXPORT,
          target: { scopeType: 'workspace', scopeId: workspaceId },
          resourceType: 'Workspace',
        });
      });

      // 2. Build Query Predicates (merging segment criteria if segmentId specified)
      const { predicates } = await this.db.withRequestTenant(async (tx) => {
        let mergedDto = { ...dto };

        if (dto.segmentId) {
          const [segment] = await tx
            .select()
            .from(schema.segments)
            .where(
              and(
                eq(schema.segments.id, dto.segmentId),
                eq(schema.segments.workspaceId, workspaceId),
                eq(schema.segments.orgId, orgId),
                isNull(schema.segments.deletedAt),
              ),
            );

          if (!segment) {
            throw new AppException({
              status: HttpStatus.NOT_FOUND,
              code: ERROR_CODES.SEGMENT_NOT_FOUND,
              message: 'Segment not found',
            });
          }

          const criteria = (segment.criteria as Record<string, unknown>) ?? {};
          mergedDto = {
            tags: dto.tags ?? (criteria.tags as string[] | undefined),
            tagMatchMode: dto.tagMatchMode ?? (criteria.tagMatchMode as 'all' | 'any' | undefined),
            channel:
              dto.channel ?? (criteria.channel as 'whatsapp' | 'sms' | 'email' | 'rcs' | undefined),
            consentType: dto.consentType ?? (criteria.consentType as string | undefined),
            requireOptIn: dto.requireOptIn ?? (criteria.requireOptIn as boolean | undefined),
            customFieldFilters:
              dto.customFieldFilters ??
              (criteria.customFieldFilters as ExportContactsDto['customFieldFilters']),
            format: dto.format,
          };
        }

        return this.buildPredicates(tx, orgId, workspaceId, mergedDto);
      });

      // 3. Upfront 50,001st Record Probe
      const probeRows = await this.db.withRequestTenant(async (tx) => {
        return tx.execute<{ id: string }>(
          sql`SELECT ${schema.contacts.id}
              FROM ${schema.contacts}
              WHERE ${and(...predicates)}
              ORDER BY ${schema.contacts.id} ASC
              LIMIT 50001`,
        );
      });

      const probeCount = probeRows.rows.length;
      const isTruncated = probeCount === 50001;
      const totalCount = isTruncated ? EXPORT_CEILING : probeCount;

      // 4. Set Response Headers
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `contacts-${workspaceId}-${timestamp}.${format}`;

      response.setHeader('X-Export-Truncated', isTruncated ? 'true' : 'false');
      response.setHeader('X-Export-Total-Count', String(totalCount));
      response.setHeader('X-Export-Ceiling', String(EXPORT_CEILING));
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (format === 'csv') {
        response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      } else {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      response.setHeader('Transfer-Encoding', 'chunked');
      response.status(HttpStatus.OK);
      headersSent = true;

      // 5. Keyset Streaming
      if (format === 'csv') {
        response.write(
          serializeCsvRow([
            'id',
            'firstName',
            'lastName',
            'phone',
            'email',
            'tags',
            'customFields',
            'createdAt',
          ]) + '\r\n',
        );
      } else {
        response.write(
          `{"meta":{"totalExported":${totalCount},"truncated":${isTruncated},"ceiling":${EXPORT_CEILING}},"data":[`,
        );
      }

      let exportedCount = 0;
      let cursor: string | null = null;
      let isFirstJsonItem = true;

      while (exportedCount < totalCount) {
        const remaining = totalCount - exportedCount;
        const limit = Math.min(CHUNK_SIZE, remaining);

        const chunkRows = await this.db.withRequestTenant(async (tx) => {
          const chunkPredicates = [...predicates];
          if (cursor) {
            chunkPredicates.push(sql`${schema.contacts.id} > ${cursor}`);
          }

          const contactsRes = await tx.execute<{
            id: string;
            first_name: string | null;
            last_name: string | null;
            metadata: unknown;
            created_at: string;
          }>(
            sql`SELECT ${schema.contacts.id},
                       ${schema.contacts.firstName} AS first_name,
                       ${schema.contacts.lastName} AS last_name,
                       ${schema.contacts.metadata} AS metadata,
                       ${schema.contacts.createdAt} AS created_at
                FROM ${schema.contacts}
                WHERE ${and(...chunkPredicates)}
                ORDER BY ${schema.contacts.id} ASC
                LIMIT ${limit}`,
          );

          const contacts = contactsRes.rows;
          if (contacts.length === 0) return [];

          const contactIds = contacts.map((c) => c.id);

          const identitiesRes = await tx.execute<{
            contact_id: string;
            channel_code: string;
            raw_address: string;
            normalized_address: string;
            is_primary: boolean;
          }>(
            sql`SELECT ci.contact_id,
                       ch.code AS channel_code,
                       ci.raw_address,
                       ci.normalized_address,
                       ci.is_primary
                FROM ${schema.contactIdentities} ci
                JOIN app_channel_catalogue() ch ON ch.id = ci.channel_id
                WHERE ci.contact_id IN (${sql.join(
                  contactIds.map((id) => sql`${id}`),
                  sql`, `,
                )})
                  AND ci.status = 'active'
                ORDER BY ci.is_primary DESC, ci.created_at ASC`,
          );

          const identitiesByContact = new Map<string, typeof identitiesRes.rows>();
          for (const row of identitiesRes.rows) {
            const list = identitiesByContact.get(row.contact_id) ?? [];
            list.push(row);
            identitiesByContact.set(row.contact_id, list);
          }

          return contacts.map((c) => {
            const ids = identitiesByContact.get(c.id) ?? [];
            const phoneId = ids.find((i) =>
              ['sms', 'whatsapp', 'rcs', 'voice'].includes(i.channel_code),
            );
            const emailId = ids.find((i) => i.channel_code === 'email');

            return {
              id: c.id,
              firstName: c.first_name,
              lastName: c.last_name,
              phone: phoneId ? phoneId.normalized_address || phoneId.raw_address : null,
              email: emailId ? emailId.normalized_address || emailId.raw_address : null,
              tags: extractTags(c.metadata),
              customFields: extractCustomFields(c.metadata),
              createdAt: new Date(c.created_at).toISOString(),
            };
          });
        });

        if (chunkRows.length === 0) break;

        for (const contact of chunkRows) {
          if (format === 'csv') {
            const phoneEscaped = contact.phone ? escapeCsvFormulaField(contact.phone) : '';
            const emailEscaped = contact.email ? escapeCsvFormulaField(contact.email) : '';
            const firstEscaped = contact.firstName ? escapeCsvFormulaField(contact.firstName) : '';
            const lastEscaped = contact.lastName ? escapeCsvFormulaField(contact.lastName) : '';
            const tagsEscaped = escapeTagsForCsv(contact.tags);
            const escapedCustomFields = escapeCustomFieldsForCsv(contact.customFields);
            const customFieldsEscaped = escapedCustomFields
              ? JSON.stringify(escapedCustomFields)
              : '';

            const line =
              serializeCsvRow([
                contact.id,
                firstEscaped,
                lastEscaped,
                phoneEscaped,
                emailEscaped,
                tagsEscaped,
                customFieldsEscaped,
                contact.createdAt,
              ]) + '\r\n';

            response.write(line);
          } else {
            const item = JSON.stringify({
              id: contact.id,
              firstName: contact.firstName,
              lastName: contact.lastName,
              phone: contact.phone,
              email: contact.email,
              tags: contact.tags,
              customFields: contact.customFields,
              createdAt: contact.createdAt,
            });

            if (!isFirstJsonItem) {
              response.write(',');
            }
            response.write(item);
            isFirstJsonItem = false;
          }
        }

        const lastItem = chunkRows[chunkRows.length - 1];
        if (lastItem) {
          cursor = lastItem.id;
        }
        exportedCount += chunkRows.length;
      }

      // 6. Privacy: zero PII in audit log
      await this.db.withRequestTenant(async (tx) => {
        await this.audit.record(
          {
            scopeType: 'workspace',
            scopeId: workspaceId,
            ...actorFromPrincipal(principal),
            action: 'contact.exported',
            resourceType: 'Contact',
            resourceId: workspaceId,
            outcome: 'success',
            before: null,
            after: null,
            metadata: {
              format,
              totalExported: exportedCount,
              truncated: isTruncated,
              ceiling: EXPORT_CEILING,
            },
          },
          tx,
        );
      });

      // 7. Close Output Stream
      if (format === 'json') {
        response.write(']}\n');
      }
      response.end();
    } catch (error) {
      if (headersSent) {
        response.destroy(error as Error);

        try {
          await this.db.withRequestTenant(async (tx) => {
            await this.audit.record(
              {
                scopeType: 'workspace',
                scopeId: workspaceId,
                ...actorFromPrincipal(principal),
                action: 'contact.export_failed',
                resourceType: 'Contact',
                resourceId: workspaceId,
                outcome: 'failure',
                before: null,
                after: null,
                metadata: {
                  format,
                  reason: (error as Error).message || 'Export failed mid-stream',
                },
              },
              tx,
            );
          });
        } catch {
          // ignore audit error on destroyed response
        }
      } else {
        throw error;
      }
    }
  }

  private async buildPredicates(
    tx: Transaction,
    orgId: string,
    workspaceId: string,
    dto: ExportContactsDto,
  ): Promise<{ predicates: SQL[]; resolvedChannel?: { id: string; code: string } }> {
    const predicates: SQL[] = [
      eq(schema.contacts.orgId, orgId),
      eq(schema.contacts.workspaceId, workspaceId),
    ];

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

    // Custom Field Filtering (allowlist validated)
    if (dto.customFieldFilters && dto.customFieldFilters.length > 0) {
      for (const filter of dto.customFieldFilters) {
        const field = filter.field?.trim();
        if (!field || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(field)) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.VALIDATION_FAILED,
            message: `Invalid custom field name '${filter.field}'`,
          });
        }

        if (FORBIDDEN_CUSTOM_FIELDS.has(field.toLowerCase())) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.VALIDATION_FAILED,
            message: `Custom field filter cannot target reserved field '${field}'`,
          });
        }

        if (!CUSTOM_FIELD_OPERATORS.includes(filter.operator)) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.VALIDATION_FAILED,
            message: `Invalid operator '${filter.operator}' for custom field filter`,
          });
        }

        if (filter.operator === 'exists') {
          predicates.push(sql`${schema.contacts.metadata} ? ${field}`);
        } else if (filter.operator === 'does_not_exist') {
          predicates.push(sql`NOT (${schema.contacts.metadata} ? ${field})`);
        } else {
          if (filter.value === undefined || filter.value === null) {
            throw new AppException({
              status: HttpStatus.BAD_REQUEST,
              code: ERROR_CODES.VALIDATION_FAILED,
              message: `Operator '${filter.operator}' requires a non-null value`,
            });
          }

          if (filter.operator === 'equals') {
            if (typeof filter.value === 'boolean' || typeof filter.value === 'number') {
              predicates.push(
                sql`${schema.contacts.metadata}->${field} = ${JSON.stringify(filter.value)}::jsonb`,
              );
            } else {
              predicates.push(
                sql`lower(${schema.contacts.metadata}->>${field}) = lower(${String(filter.value)})`,
              );
            }
          } else if (filter.operator === 'not_equals') {
            if (typeof filter.value === 'boolean' || typeof filter.value === 'number') {
              predicates.push(
                sql`(${schema.contacts.metadata}->${field} IS NULL OR ${schema.contacts.metadata}->${field} != ${JSON.stringify(filter.value)}::jsonb)`,
              );
            } else {
              predicates.push(
                sql`(${schema.contacts.metadata}->>${field} IS NULL OR lower(${schema.contacts.metadata}->>${field}) != lower(${String(filter.value)}))`,
              );
            }
          } else if (filter.operator === 'contains') {
            predicates.push(
              sql`${schema.contacts.metadata}->>${field} ILIKE ${'%' + String(filter.value) + '%'}`,
            );
          }
        }
      }
    }

    // Channel Eligibility, Suppression & Consent
    let resolvedChannel: { id: string; code: string } | undefined = undefined;
    if (dto.channel) {
      const channelResult = await tx.execute<{ id: string; code: string; status: string }>(
        sql`SELECT id, code, status FROM app_channel_resolve(${dto.channel}::text)`,
      );
      const ch = channelResult.rows[0];
      if (!ch) {
        throw new AppException({
          status: HttpStatus.NOT_FOUND,
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: `Channel '${dto.channel}' not found`,
        });
      }
      resolvedChannel = { id: ch.id, code: ch.code };

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

    return { predicates, resolvedChannel };
  }
}
