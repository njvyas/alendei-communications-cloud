import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './_shared';
import { organizations } from './tenancy';
import { channels, providers } from './providers';

/** Assignment status (Phase 3.2, ADR-014 §4, D02). */
export const assignmentStatus = pgEnum('assignment_status', ['active', 'disabled']);

/**
 * Organization Provider Assignments table (Phase 3.2, ADR-014 §4, P3-D01–D05).
 *
 * Couples the platform provider catalogue to tenant organizations.
 * Unique on (org_id, provider_id) and unique on (org_id, channel_id, priority).
 * Priority is an integer >= 1.
 */
export const organizationProviderAssignments = pgTable(
  'organization_provider_assignments',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    priority: integer('priority').notNull(),
    status: assignmentStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'organization_provider_assignments_provider_channel_fk',
      columns: [table.providerId, table.channelId],
      foreignColumns: [providers.id, providers.channelId],
    }).onDelete('restrict'),
    unique('uq_org_provider_assignments_org_provider').on(table.orgId, table.providerId),
    unique('uq_org_provider_assignments_org_channel_priority').on(
      table.orgId,
      table.channelId,
      table.priority,
    ),
    check('org_provider_assignments_priority_check', sql`${table.priority} >= 1`),
    index('org_provider_assignments_org_id_idx').on(table.orgId),
    index('org_provider_assignments_provider_id_idx').on(table.providerId),
    index('org_provider_assignments_channel_id_idx').on(table.channelId),
  ],
);
