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
import { users } from './iam';
import { organizations, workspaces } from './tenancy';

/**
 * Phase 8C PR 8C-1 (migration `0062`; `DATABASE.md` §9, `docs/PHASE-8C-JOURNEYS-HANDOVER.md` §5).
 *
 * Journey lifecycle. In 8C-1 every journey is `draft`; activation, pause and archive arrive
 * with 8C-2. The enum is complete now so that 8C-2 adds no type change.
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

export type Journey = typeof journeys.$inferSelect;
export type NewJourney = typeof journeys.$inferInsert;
export type JourneyVersion = typeof journeyVersions.$inferSelect;
export type NewJourneyVersion = typeof journeyVersions.$inferInsert;
