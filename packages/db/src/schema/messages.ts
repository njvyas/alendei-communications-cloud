import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId, timestamps, tstz } from './_shared';
import { organizations, workspaces } from './tenancy';
import { channels, providers } from './providers';
import { contacts } from './contacts';
import { templates } from './templates';
import { organizationProviderAssignments } from './assignments';

/** Message lifecycle status (Phase 3.3, ADR-014 §7, P3-D10). */
export const messageStatus = pgEnum('message_status', [
  'queued',
  'routing',
  'submitting',
  'accepted',
  'failed',
  'outcome_unknown',
]);

/** Message attempt status (Phase 3.3, ADR-014 §7, P3-D11). */
export const messageAttemptStatus = pgEnum('message_attempt_status', [
  'submitting',
  'accepted',
  'failed',
  'outcome_unknown',
]);

/**
 * Messages table (Phase 3.3, ADR-014 §7, §9, §17.1).
 *
 * Tenant-content table (Model B RLS enforced via app_content_context_valid).
 * Denormalized org_id and workspace_id with composite FKs.
 */
export const messages = pgTable(
  'messages',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id').references(() => templates.id, { onDelete: 'restrict' }),
    status: messageStatus('status').notNull().default('queued'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    recipientAddress: text('recipient_address').notNull(),
    currentAttemptId: uuid('current_attempt_id'),
    failureReason: text('failure_reason'),
    correlationId: text('correlation_id').notNull(),
    completedAt: tstz('completed_at'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'messages_workspace_org_fk',
      columns: [table.workspaceId, table.orgId],
      foreignColumns: [workspaces.id, workspaces.orgId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'messages_contact_workspace_org_fk',
      columns: [table.contactId, table.workspaceId, table.orgId],
      foreignColumns: [contacts.id, contacts.workspaceId, contacts.orgId],
    }).onDelete('restrict'),
    unique('uq_messages_id_org_id').on(table.id, table.orgId),
    index('messages_org_id_idx').on(table.orgId),
    index('messages_workspace_id_idx').on(table.workspaceId),
    index('messages_contact_id_idx').on(table.contactId),
    index('messages_status_idx').on(table.status),
  ],
);

/**
 * Message attempts table (Phase 3.3, ADR-014 §7, §9, P3-D11).
 *
 * Tenant-content table (Model B RLS).
 * Records each invocation attempt with fencing epoch and claim token.
 */
export const messageAttempts = pgTable(
  'message_attempts',
  {
    id: primaryId(),
    messageId: uuid('message_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    attemptNumber: integer('attempt_number').notNull().default(1),
    fencingEpoch: integer('fencing_epoch').notNull(),
    claimToken: uuid('claim_token').notNull(),
    status: messageAttemptStatus('status').notNull().default('submitting'),
    failureReason: text('failure_reason'),
    latencyMs: integer('latency_ms'),
    completedAt: tstz('completed_at'),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'message_attempts_message_org_fk',
      columns: [table.messageId, table.orgId],
      foreignColumns: [messages.id, messages.orgId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'message_attempts_assignment_fk',
      columns: [table.orgId, table.providerId],
      foreignColumns: [
        organizationProviderAssignments.orgId,
        organizationProviderAssignments.providerId,
      ],
    }).onDelete('restrict'),
    unique('uq_message_attempts_id_provider_id').on(table.id, table.providerId),
    unique('uq_message_attempts_message_attempt_num').on(table.messageId, table.attemptNumber),
    check(
      'message_attempts_latency_ms_nonnegative',
      sql`${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0`,
    ),
    index('message_attempts_message_id_idx').on(table.messageId),
    index('message_attempts_org_id_idx').on(table.orgId),
    index('message_attempts_provider_id_idx').on(table.providerId),
    index('message_attempts_claim_token_idx').on(table.claimToken),
  ],
);

/**
 * Message events table (Phase 3.3, ADR-014 §7, §9, P3-D12).
 *
 * Append-only tenant-content table (Model B RLS).
 * Tracks lifecycle events atomically with state transitions.
 */
export const messageEvents = pgTable(
  'message_events',
  {
    id: primaryId(),
    messageId: uuid('message_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    attemptId: uuid('attempt_id').references(() => messageAttempts.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'message_events_message_org_fk',
      columns: [table.messageId, table.orgId],
      foreignColumns: [messages.id, messages.orgId],
    }).onDelete('restrict'),
    index('message_events_message_id_idx').on(table.messageId),
    index('message_events_org_id_idx').on(table.orgId),
    index('message_events_attempt_id_idx').on(table.attemptId),
  ],
);

/**
 * Message dispatch queue table (Phase 3.3, ADR-014 §9.1, P3-D17, P3-D18).
 *
 * Control-plane queue table (Model A Tenancy RLS; non-content data only).
 * Carries zero message payload, recipient phone or provider configuration.
 */
export const messageDispatchQueue = pgTable(
  'message_dispatch_queue',
  {
    messageId: uuid('message_id')
      .primaryKey()
      .references(() => messages.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    availableAt: tstz('available_at')
      .notNull()
      .default(sql`now()`),
    dispatchEpoch: integer('dispatch_epoch').notNull().default(0),
    claimToken: uuid('claim_token'),
    claimedUntil: tstz('claimed_until'),
    claimedBy: text('claimed_by'),
  },
  (table) => [
    foreignKey({
      name: 'message_dispatch_queue_message_org_fk',
      columns: [table.messageId, table.orgId],
      foreignColumns: [messages.id, messages.orgId],
    }).onDelete('cascade'),
    index('message_dispatch_queue_claim_idx').on(
      table.availableAt,
      table.claimedUntil,
      table.messageId,
    ),
    index('message_dispatch_queue_org_id_idx').on(table.orgId),
  ],
);
