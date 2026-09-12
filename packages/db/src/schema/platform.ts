import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps, tstz } from './_shared';
import { organizations } from './tenancy';

/**
 * API-level (tier 1) idempotency (`DATABASE.md` §7.1, `API.md` §4).
 *
 * Deliberately separate from any per-resource uniqueness guard: this is a
 * generic API-replay cache usable by any idempotent endpoint, scoped
 * `(org_id, endpoint, idempotency_key)`.
 */
export const idempotencyStatus = pgEnum('idempotency_status', ['pending', 'completed', 'failed']);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Hash of the normalized request body; a mismatch is a caller error (422). */
    requestHash: text('request_hash').notNull(),
    status: idempotencyStatus('status').notNull().default('pending'),
    responseStatusCode: integer('response_status_code'),
    responseSnapshot: jsonb('response_snapshot'),
    /** e.g. the created resource's id, replayed verbatim on a duplicate. */
    resourceId: uuid('resource_id'),
    failureReason: text('failure_reason'),
    completedAt: tstz('completed_at'),
    /** Default 24h (`DATABASE.md` §7.1); org-configurable between 1h and 7d. */
    expiresAt: tstz('expires_at')
      .notNull()
      .default(sql`now() + interval '24 hours'`),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('idempotency_keys_scope_key').on(table.orgId, table.endpoint, table.idempotencyKey),
    index('idempotency_keys_expires_at_idx').on(table.expiresAt),
    check(
      'idempotency_keys_completed_shape',
      sql`${table.status} <> 'completed' OR (${table.responseStatusCode} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
