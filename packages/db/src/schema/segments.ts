import { sql } from 'drizzle-orm';
import { foreignKey, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { primaryId, timestamps, tstz } from './_shared';
import { organizations, workspaces } from './tenancy';

/**
 * Segments table (Phase 8A.1, `DATABASE.md` §12a, `ROADMAP.md` §11a).
 *
 * Workspace-owned saved audience definitions.
 * Denormalized `org_id` with composite FK to `workspaces(id, org_id)`.
 * Partial unique index on active segments per workspace and lowercase name.
 * Model B tenant-content RLS (`CONTENT_TABLES`).
 */
export const segments = pgTable(
  'segments',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    criteria: jsonb('criteria')
      .notNull()
      .default(sql`'{}'::jsonb`),
    deletedAt: tstz('deleted_at'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'segments_workspace_org_fk',
      columns: [table.workspaceId, table.orgId],
      foreignColumns: [workspaces.id, workspaces.orgId],
    }).onDelete('restrict'),
    uniqueIndex('uq_segments_workspace_name')
      .on(table.workspaceId, sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
    index('segments_org_id_idx').on(table.orgId),
    index('segments_workspace_id_idx').on(table.workspaceId),
    index('segments_workspace_created_at_id_idx').on(table.workspaceId, table.createdAt, table.id),
  ],
);

export type Segment = typeof segments.$inferSelect;
export type NewSegment = typeof segments.$inferInsert;
