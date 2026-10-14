import { sql } from 'drizzle-orm';
import {
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps, tstz } from './_shared';
import { organizations } from './tenancy';
import { channels } from './providers';

/** Suppression status lifecycle (Phase 3.1). */
export const suppressionStatus = pgEnum('suppression_status', ['active', 'cleared']);

/**
 * Organization-owned suppressions table (Phase 3.1, ADR-014 §6, D09, P3-D22).
 *
 * Dual partial unique indexes on status = 'active':
 * - When channel_id IS NOT NULL: (org_id, channel_id, normalized_address)
 * - When channel_id IS NULL: (org_id, normalized_address)
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'restrict' }),
    rawAddress: text('raw_address').notNull(),
    normalizedAddress: text('normalized_address').notNull(),
    reason: text('reason').notNull(),
    status: suppressionStatus('status').notNull().default('active'),
    clearedAt: tstz('cleared_at'),
    clearedReason: text('cleared_reason'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('uq_suppressions_channel_active')
      .on(table.orgId, table.channelId, table.normalizedAddress)
      .where(sql`${table.status} = 'active' AND ${table.channelId} IS NOT NULL`),
    uniqueIndex('uq_suppressions_org_active')
      .on(table.orgId, table.normalizedAddress)
      .where(sql`${table.status} = 'active' AND ${table.channelId} IS NULL`),
    index('suppressions_org_id_idx').on(table.orgId),
    index('suppressions_channel_id_idx').on(table.channelId),
  ],
);

export type Suppression = typeof suppressions.$inferSelect;
export type NewSuppression = typeof suppressions.$inferInsert;
