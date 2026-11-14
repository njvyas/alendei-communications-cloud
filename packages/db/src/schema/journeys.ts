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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps, tstz } from './_shared';
import { contacts } from './contacts';
import { users } from './iam';
import { organizations, workspaces } from './tenancy';

/**
 * Phase 8C PR 8C-1 (migration `0062`; `DATABASE.md` §9, `docs/PHASE-8C-JOURNEYS-HANDOVER.md` §5).
 *
 * Journey lifecycle: `draft → active ↔ paused → archived` (8C-2, `trg_journeys_lifecycle_guard`
 * in `0063`); a draft may also be archived directly.
 */
export const journeyStatus = pgEnum('journey_status', ['draft', 'active', 'paused', 'archived']);

/** Version lifecycle: a draft is editable; `published` is frozen (trigger); `retired` is set by 8C-2. */
export const journeyVersionStatus = pgEnum('journey_version_status', [
  'draft',
  'published',
  'retired',
]);

/** Journeys (tenant content, Model B RLS). Soft-deleted through `deleted_at`. */
export const journeys = pgTable(
  'journeys',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    status: journeyStatus('status').notNull().default('draft'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * 8C-2 (`0063`): the published version new enrolments use. Set at activation and moved
     * when a new version is published while the journey is active or paused; never cleared
     * (`trg_journeys_lifecycle_guard`). The composite FK `journeys_active_version_fk` binds it
     * to this journey; it is declared in the migration only, because the two tables reference
     * each other.
     */
    activeVersionId: uuid('active_version_id'),
    activatedAt: tstz('activated_at'),
    /** The activating user; `NULL` for an API-key principal (the audit log names the actor). */
    activatedBy: uuid('activated_by').references(() => users.id, { onDelete: 'restrict' }),
    deletedAt: tstz('deleted_at'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'journeys_workspace_org_fk',
      columns: [table.workspaceId, table.orgId],
      foreignColumns: [workspaces.id, workspaces.orgId],
    }).onDelete('restrict'),
    unique('uq_journeys_id_workspace_org').on(table.id, table.workspaceId, table.orgId),
    index('journeys_org_workspace_status_idx').on(table.orgId, table.workspaceId, table.status),
    check('journeys_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check(
      'journeys_active_version_shape',
      sql`${table.status} NOT IN ('active', 'paused') OR (${table.activeVersionId} IS NOT NULL AND ${table.activatedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Journey versions. The graph is validated by the API (`validateJourneyGraph` plus referential
 * checks) before publication; the database guarantees immutability once published
 * (`trg_journey_versions_guard`) and at most one draft per journey.
 */
export const journeyVersions = pgTable(
  'journey_versions',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').notNull(),
    journeyId: uuid('journey_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    status: journeyVersionStatus('status').notNull().default('draft'),
    graphSchemaVersion: integer('graph_schema_version').notNull(),
    graph: jsonb('graph').notNull(),
    graphSha256: text('graph_sha256').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    publishedAt: tstz('published_at'),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'journey_versions_journey_fk',
      columns: [table.journeyId, table.workspaceId, table.orgId],
      foreignColumns: [journeys.id, journeys.workspaceId, journeys.orgId],
    }).onDelete('restrict'),
    unique('uq_journey_versions_id_journey_org').on(table.id, table.journeyId, table.orgId),
    uniqueIndex('uq_journey_versions_journey_number').on(table.journeyId, table.versionNumber),
    uniqueIndex('uq_journey_versions_one_draft')
      .on(table.journeyId)
      .where(sql`${table.status} = 'draft'`),
    check('journey_versions_number_positive', sql`${table.versionNumber} >= 1`),
    check('journey_versions_sha256_hex', sql`${table.graphSha256} ~ '^[0-9a-f]{64}$'`),
    check('journey_versions_graph_object', sql`jsonb_typeof(${table.graph}) = 'object'`),
    check(
      'journey_versions_published_shape',
      sql`(${table.status} = 'draft') = (${table.publishedAt} IS NULL)`,
    ),
  ],
);

// --- Phase 8C PR 8C-2 (migration `0063`) ------------------------------------------------------

export const journeyTriggerKind = pgEnum('journey_trigger_kind', ['api', 'event', 'schedule']);
export const journeyTriggerStatus = pgEnum('journey_trigger_status', [
  'active',
  'paused',
  'retired',
]);
export const journeyExecutionStatus = pgEnum('journey_execution_status', [
  'running',
  'waiting',
  'completed',
  'exited',
  'failed',
  'cancelled',
]);
export const journeyStepOutcome = pgEnum('journey_step_outcome', [
  'entered',
  'completed',
  'waited',
  'skipped',
  'refused',
  'failed',
  'stubbed',
  'exited',
  'cancelled',
]);

/**
 * The trigger derived from a version's entry node at activation (one per version; at most one
 * non-retired per journey). Nothing reads it in 8C-2: event intake and scheduled processing
 * are 8C-4.
 */
export const journeyTriggers = pgTable(
  'journey_triggers',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').notNull(),
    journeyId: uuid('journey_id').notNull(),
    journeyVersionId: uuid('journey_version_id').notNull(),
    kind: journeyTriggerKind('kind').notNull(),
    eventKind: text('event_kind'),
    eventTag: text('event_tag'),
    segmentId: uuid('segment_id'),
    schedule: jsonb('schedule'),
    nextFireAt: tstz('next_fire_at'),
    status: journeyTriggerStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'journey_triggers_journey_fk',
      columns: [table.journeyId, table.workspaceId, table.orgId],
      foreignColumns: [journeys.id, journeys.workspaceId, journeys.orgId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'journey_triggers_version_fk',
      columns: [table.journeyVersionId, table.journeyId, table.orgId],
      foreignColumns: [journeyVersions.id, journeyVersions.journeyId, journeyVersions.orgId],
    }).onDelete('restrict'),
    uniqueIndex('uq_journey_triggers_version').on(table.journeyVersionId),
    uniqueIndex('uq_journey_triggers_one_live')
      .on(table.journeyId)
      .where(sql`${table.status} <> 'retired'`),
    index('journey_triggers_due_idx')
      .on(table.nextFireAt)
      .where(sql`${table.status} = 'active'`),
    index('journey_triggers_org_event_idx')
      .on(table.orgId, table.eventKind)
      .where(sql`${table.status} = 'active' AND ${table.kind} = 'event'`),
  ],
);

/** One contact's passage through one journey version (`trg_journey_executions_guard`). */
export const journeyExecutions = pgTable(
  'journey_executions',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').notNull(),
    journeyId: uuid('journey_id').notNull(),
    journeyVersionId: uuid('journey_version_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    status: journeyExecutionStatus('status').notNull().default('running'),
    /** The node the execution runs next; `NULL` only once it has ended. */
    currentNodeKey: text('current_node_key'),
    wakeAt: tstz('wake_at'),
    stateVersion: integer('state_version').notNull().default(0),
    transitions: integer('transitions').notNull().default(0),
    entryKind: journeyTriggerKind('entry_kind').notNull(),
    entryRef: text('entry_ref').notNull(),
    enrolledBy: uuid('enrolled_by').references(() => users.id, { onDelete: 'restrict' }),
    enteredAt: tstz('entered_at')
      .notNull()
      .default(sql`now()`),
    endedAt: tstz('ended_at'),
    endReason: text('end_reason'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'journey_executions_journey_fk',
      columns: [table.journeyId, table.workspaceId, table.orgId],
      foreignColumns: [journeys.id, journeys.workspaceId, journeys.orgId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'journey_executions_version_fk',
      columns: [table.journeyVersionId, table.journeyId, table.orgId],
      foreignColumns: [journeyVersions.id, journeyVersions.journeyId, journeyVersions.orgId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'journey_executions_contact_fk',
      columns: [table.contactId, table.workspaceId, table.orgId],
      foreignColumns: [contacts.id, contacts.workspaceId, contacts.orgId],
    }).onDelete('restrict'),
    unique('uq_journey_executions_id_workspace_org').on(table.id, table.workspaceId, table.orgId),
    unique('uq_journey_executions_id_org').on(table.id, table.orgId),
    uniqueIndex('uq_journey_executions_live_contact')
      .on(table.journeyId, table.contactId)
      .where(sql`${table.status} IN ('running', 'waiting')`),
    uniqueIndex('uq_journey_executions_entry').on(table.journeyId, table.contactId, table.entryRef),
    index('journey_executions_journey_id_idx').on(table.journeyId, table.id),
    index('journey_executions_version_status_idx').on(table.journeyVersionId, table.status),
    index('journey_executions_contact_idx').on(table.orgId, table.contactId),
    check('journey_executions_state_version_nonnegative', sql`${table.stateVersion} >= 0`),
    check('journey_executions_transitions_bounded', sql`${table.transitions} BETWEEN 0 AND 1000`),
    check(
      'journey_executions_entry_ref_length',
      sql`char_length(${table.entryRef}) BETWEEN 1 AND 200`,
    ),
    check(
      'journey_executions_end_shape',
      sql`(${table.status} IN ('running', 'waiting')) = (${table.endedAt} IS NULL) AND (${table.endedAt} IS NULL) = (${table.endReason} IS NULL)`,
    ),
    check(
      'journey_executions_end_reason_length',
      sql`${table.endReason} IS NULL OR char_length(${table.endReason}) BETWEEN 1 AND 100`,
    ),
    check(
      'journey_executions_live_node',
      sql`${table.status} NOT IN ('running', 'waiting') OR ${table.currentNodeKey} IS NOT NULL`,
    ),
  ],
);

/** Content-free claim rows (one per live execution), as `message_dispatch_queue`. Unclaimed in 8C-2. */
export const journeyExecutionQueue = pgTable(
  'journey_execution_queue',
  {
    executionId: uuid('execution_id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    availableAt: tstz('available_at')
      .notNull()
      .default(sql`now()`),
    epoch: integer('epoch').notNull().default(0),
    claimToken: uuid('claim_token'),
    claimedUntil: tstz('claimed_until'),
    claimedBy: text('claimed_by'),
    /** 8C-3 (`0064`): claims since the last committed transition (retry and poison bound). */
    attempts: integer('attempts').notNull().default(0),
    /** 8C-3: the last failure's stable code or SQLSTATE; no message text. */
    lastErrorCode: text('last_error_code'),
  },
  (table) => [
    foreignKey({
      name: 'journey_execution_queue_execution_org_fk',
      columns: [table.executionId, table.orgId],
      foreignColumns: [journeyExecutions.id, journeyExecutions.orgId],
    }).onDelete('restrict'),
    index('journey_execution_queue_claim_idx').on(
      table.availableAt,
      table.claimedUntil,
      table.executionId,
    ),
    index('journey_execution_queue_org_id_idx').on(table.orgId),
    check('journey_execution_queue_epoch_nonnegative', sql`${table.epoch} >= 0`),
    check('journey_execution_queue_attempts_nonnegative', sql`${table.attempts} >= 0`),
    check(
      'journey_execution_queue_error_code_length',
      sql`${table.lastErrorCode} IS NULL OR char_length(${table.lastErrorCode}) BETWEEN 1 AND 100`,
    ),
    check(
      'journey_execution_queue_claim_shape',
      sql`(${table.claimToken} IS NULL) = (${table.claimedUntil} IS NULL)`,
    ),
  ],
);

/**
 * Append-only step history (`trg_journey_execution_steps_guard`). `seq` equals the
 * execution's `state_version` after the step. `messageId` is reserved for the send node
 * (8C-5), which adds its foreign key.
 */
export const journeyExecutionSteps = pgTable(
  'journey_execution_steps',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').notNull(),
    executionId: uuid('execution_id').notNull(),
    seq: integer('seq').notNull(),
    nodeKey: text('node_key').notNull(),
    nodeType: text('node_type').notNull(),
    outcome: journeyStepOutcome('outcome').notNull(),
    attempt: integer('attempt').notNull().default(1),
    messageId: uuid('message_id'),
    errorCode: text('error_code'),
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    startedAt: tstz('started_at')
      .notNull()
      .default(sql`now()`),
    finishedAt: tstz('finished_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    foreignKey({
      name: 'journey_execution_steps_execution_fk',
      columns: [table.executionId, table.workspaceId, table.orgId],
      foreignColumns: [
        journeyExecutions.id,
        journeyExecutions.workspaceId,
        journeyExecutions.orgId,
      ],
    }).onDelete('restrict'),
    uniqueIndex('uq_journey_execution_steps_seq').on(table.executionId, table.seq),
    uniqueIndex('uq_journey_execution_steps_message')
      .on(table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
    check('journey_execution_steps_seq_positive', sql`${table.seq} >= 1`),
    check('journey_execution_steps_attempt_positive', sql`${table.attempt} >= 1`),
    check(
      'journey_execution_steps_details_bounded',
      sql`jsonb_typeof(${table.details}) = 'object' AND octet_length(${table.details}::text) <= 4096`,
    ),
    check(
      'journey_execution_steps_text_bounded',
      sql`char_length(${table.nodeKey}) BETWEEN 1 AND 64 AND char_length(${table.nodeType}) BETWEEN 1 AND 32 AND (${table.errorCode} IS NULL OR char_length(${table.errorCode}) BETWEEN 1 AND 100)`,
    ),
    check('journey_execution_steps_time_order', sql`${table.finishedAt} >= ${table.startedAt}`),
  ],
);

export type JourneyTriggerRow = typeof journeyTriggers.$inferSelect;
export type JourneyExecution = typeof journeyExecutions.$inferSelect;
export type JourneyExecutionStep = typeof journeyExecutionSteps.$inferSelect;

export type Journey = typeof journeys.$inferSelect;
export type NewJourney = typeof journeys.$inferInsert;
export type JourneyVersion = typeof journeyVersions.$inferSelect;
export type NewJourneyVersion = typeof journeyVersions.$inferInsert;
