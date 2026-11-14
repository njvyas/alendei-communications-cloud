import { HttpStatus } from '@nestjs/common';
import { CUSTOM_FIELD_OPERATORS, ERROR_CODES } from '@acc/contracts';
import { schema } from '@acc/db';
import { sql, type SQL } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';

/**
 * Audience membership predicates over `contacts` (Phase 8A; extracted from
 * `ContactsService.resolveAudience` unchanged in Phase 8C PR 8C-3 so the journey runner's
 * segment condition evaluates exactly the same rules for one contact).
 */

/** Custom-field names that name a reserved column or the tag list. */
export const FORBIDDEN_CUSTOM_FIELDS = new Set([
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

/** A contact's tags, from `metadata.tags` (array) or `metadata.tag_list` (array or comma list). */
export function contactTagsFromMetadata(metadata: unknown): string[] {
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

export interface AudienceCriteriaInput {
  readonly tags?: readonly string[];
  readonly tagMatchMode?: 'any' | 'all';
  readonly customFieldFilters?: readonly {
    readonly field: string;
    readonly operator: string;
    readonly value?: unknown;
  }[];
  readonly requireOptIn?: boolean;
  readonly consentType?: string;
}

/**
 * The tag, custom-field, channel-eligibility, suppression and consent predicates of an
 * audience, correlated on `contacts`. Throws `400 VALIDATION_FAILED` on an invalid filter.
 */
export function audienceContactPredicates(
  dto: AudienceCriteriaInput,
  resolvedChannel?: { readonly id: string },
): SQL[] {
  const predicates: SQL[] = [];
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
          logContext: { field: filter.field },
        });
      }

      if (FORBIDDEN_CUSTOM_FIELDS.has(field.toLowerCase())) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `Custom field filter cannot target reserved field '${field}'`,
          logContext: { field },
        });
      }

      if (!(CUSTOM_FIELD_OPERATORS as readonly string[]).includes(filter.operator)) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: `Invalid operator '${filter.operator}' for custom field filter`,
          logContext: { operator: filter.operator },
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
            logContext: { operator: filter.operator, field },
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
  return predicates;
}
