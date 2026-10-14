import { sql } from 'drizzle-orm';
import { index, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { primaryId, timestamps, tstz } from './_shared';
import { organizations } from './tenancy';
import { channels } from './providers';

/** Internal simulated approval status (Phase 3.1, ADR-014 §11, D21). */
export const templateApprovalStatus = pgEnum('template_approval_status', [
  'draft',
  'pending',
  'approved',
  'rejected',
]);

/**
 * Organization-owned templates table (Phase 3.1, `DATABASE.md` §8).
 *
 * Case-insensitive uniqueness on (org_id, lower(name)) where deleted_at IS NULL.
 */
export const templates = pgTable(
  'templates',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    body: text('body').notNull(),
    variables: jsonb('variables')
      .notNull()
      .default(sql`'[]'::jsonb`),
    approvalStatus: templateApprovalStatus('approval_status').notNull().default('draft'),
    deletedAt: tstz('deleted_at'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_templates_org_name_active')
      .on(table.orgId, sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
    index('templates_org_id_idx').on(table.orgId),
    index('templates_channel_id_idx').on(table.channelId),
  ],
);

export type Template = typeof templates.$inferSelect;
export type NewTemplate = typeof templates.$inferInsert;
