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
import { apiKeys, users } from './iam';
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
    /**
     * Who owned this key. **Diagnostic, not a uniqueness term** (migration
     * `0007`).
     *
     * The scope stays organization-wide on purpose (`DATABASE.md` §7.1), and the
     * principal is bound by being part of the *request hash* instead — so a
     * different actor computes a different hash and is refused as a payload
     * mismatch rather than silently running the key as a separate mutation.
     * These columns answer "who owned it" when someone asks why a replay was
     * refused. Mutually exclusive, exactly as `audit_logs` models the same pair.
     */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorApiKeyId: uuid('actor_api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    /**
     * The correlation id of the request that *created* this record.
     *
     * Kept so an operator can find the original execution from a replay, and
     * deliberately never replayed to the client: a replay is its own request and
     * carries its own correlation id (`API.md` §4a).
     */
    correlationId: uuid('correlation_id'),
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
      'idempotency_keys_actor_shape',
      sql`num_nonnulls(${table.actorUserId}, ${table.actorApiKeyId}) <= 1`,
    ),
    check(
      'idempotency_keys_completed_shape',
      sql`${table.status} <> 'completed' OR (${table.responseStatusCode} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
