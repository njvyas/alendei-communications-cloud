import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, primaryId, tstz } from './_shared';
import { messageAttempts } from './messages';
import { providers } from './providers';
import { organizations } from './tenancy';

/**
 * Phase 5.0 (migration 0044): the processing outcome of one distinct provider event.
 * A duplicate is not an outcome — it is counted on the original row (`duplicate_count`).
 */
export const webhookEventOutcome = pgEnum('webhook_event_outcome', [
  'applied',
  'no_change',
  'deferred',
  'unmatched',
  'rejected_malformed',
  'conflict',
  'informational',
]);

/**
 * Inbound provider delivery events (Phase 5.0, design spec Rev 2 §C.1, plan §1.1–§1.2).
 *
 * One row per distinct provider event; duplicates increment `duplicate_count`. A request
 * malformed as a whole writes no row. No raw payload: `normalized` is a redacted envelope.
 * Deduplication: `(provider_id, provider_event_id)` when the provider supplies an event id,
 * otherwise `(provider_id, event_sha256)`. `matched_org_id` is attribution metadata derived
 * from the matched attempt, never from the payload. Control-plane table: no tenant role reads it.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: primaryId(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id').notNull(),
    eventIndex: integer('event_index').notNull(),
    providerEventId: text('provider_event_id'),
    eventSha256: bytea('event_sha256').notNull(),
    signatureTimestamp: tstz('signature_timestamp'),
    receivedAt: tstz('received_at')
      .notNull()
      .default(sql`now()`),
    outcome: webhookEventOutcome('outcome').notNull(),
    matchedAttemptId: uuid('matched_attempt_id').references(() => messageAttempts.id, {
      onDelete: 'restrict',
    }),
    matchedOrgId: uuid('matched_org_id').references(() => organizations.id, {
      onDelete: 'restrict',
    }),
    normalized: jsonb('normalized')
      .notNull()
      .default(sql`'{}'::jsonb`),
    processedAt: tstz('processed_at'),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    lastDuplicateAt: tstz('last_duplicate_at'),
  },
  (table) => [
    unique('webhook_events_request_event_uq').on(table.requestId, table.eventIndex),
    uniqueIndex('webhook_events_provider_event_uq')
      .on(table.providerId, table.providerEventId)
      .where(sql`${table.providerEventId} IS NOT NULL`),
    uniqueIndex('webhook_events_provider_hash_uq')
      .on(table.providerId, table.eventSha256)
      .where(sql`${table.providerEventId} IS NULL`),
    index('webhook_events_pending_idx')
      .on(table.providerId, table.outcome)
      .where(sql`${table.outcome} IN ('deferred', 'unmatched')`),
    index('webhook_events_matched_attempt_idx')
      .on(table.matchedAttemptId)
      .where(sql`${table.matchedAttemptId} IS NOT NULL`),
    index('webhook_events_received_at_idx').on(table.receivedAt),
    check(
      'webhook_events_event_index_nonnegative',
      sql`${table.eventIndex} >= 0 AND ${table.eventIndex} < 100`,
    ),
    check('webhook_events_duplicate_count_nonnegative', sql`${table.duplicateCount} >= 0`),
    check(
      'webhook_events_match_consistent',
      sql`(${table.matchedAttemptId} IS NULL) = (${table.matchedOrgId} IS NULL)`,
    ),
  ],
);
