import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps, tstz } from './_shared';
import { organizations, workspaces } from './tenancy';
import { channels } from './providers';
import { templates } from './templates';
import { contacts, contactIdentities } from './contacts';
import { users } from './iam';
import { messages } from './messages';

/** Campaign lifecycle status machine (Phase 8B.1, DATABASE.md §8). */
export const campaignStatus = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
]);

/** Scheduling mode (Phase 8B.1, DATABASE.md §8). */
export const campaignScheduleMode = pgEnum('campaign_schedule_mode', ['immediate', 'scheduled']);

/** Recipient source specification type (Phase 8B.1, DATABASE.md §8). */
export const campaignRecipientSourceType = pgEnum('campaign_recipient_source_type', [
  'all_contacts',
  'tag_segment',
  'custom_list',
]);

/** Recipient dispatch lifecycle status (Phase 8B.1, DATABASE.md §8). */
export const campaignRecipientStatus = pgEnum('campaign_recipient_status', [
  'pending',
  'enqueued',
  'sent',
  'skipped',
  'failed',
]);

/**
 * Campaigns Table (Phase 8B.1, DATABASE.md §8).
 * Tenant-content table protected by Model B RLS.
 */
export const campaigns = pgTable(
  'campaigns',
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
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'restrict' }),
    templateVariables: jsonb('template_variables')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: campaignStatus('status').notNull().default('draft'),
    recipientSource: jsonb('recipient_source').notNull(),
    scheduleMode: campaignScheduleMode('schedule_mode').notNull().default('immediate'),
    scheduledAt: tstz('scheduled_at'),
    throttling: jsonb('throttling')
      .notNull()
      .default(sql`'{"rateLimitPerSecond": 25, "maxAttemptsPerRecipient": 1}'::jsonb`),
    routingPolicyId: uuid('routing_policy_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    metrics: jsonb('metrics')
      .notNull()
      .default(
        sql`'{"totalRecipients": null, "sent": 0, "delivered": 0, "read": 0, "failed": 0, "deliveryRate": 0}'::jsonb`,
      ),
    startedAt: tstz('started_at'),
    completedAt: tstz('completed_at'),
    deletedAt: tstz('deleted_at'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'campaigns_workspace_org_fk',
      columns: [table.workspaceId, table.orgId],
      foreignColumns: [workspaces.id, workspaces.orgId],
    }).onDelete('restrict'),
    unique('uq_campaigns_id_org_id').on(table.id, table.orgId),
    index('campaigns_org_workspace_status_idx').on(table.orgId, table.workspaceId, table.status),
    index('campaigns_scheduled_idx')
      .on(table.status, table.scheduledAt)
      .where(sql`${table.status} = 'scheduled' AND ${table.deletedAt} IS NULL`),
    index('campaigns_org_id_id_desc_idx').on(table.orgId, table.id.desc()),
  ],
);

/**
 * Campaign Recipients Table (Phase 8B.1, DATABASE.md §8).
 * Stores materialized intended audience members, status, and message lineage.
 */
export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: primaryId(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    identityId: uuid('identity_id').references(() => contactIdentities.id, {
      onDelete: 'set null',
    }),
    status: campaignRecipientStatus('status').notNull().default('pending'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'restrict' }),
    skipReason: text('skip_reason'),
    errorCode: text('error_code'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'campaign_recipients_campaign_org_fk',
      columns: [table.campaignId, table.orgId],
      foreignColumns: [campaigns.id, campaigns.orgId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'campaign_recipients_contact_workspace_org_fk',
      columns: [table.contactId, table.workspaceId, table.orgId],
      foreignColumns: [contacts.id, contacts.workspaceId, contacts.orgId],
    }).onDelete('restrict'),
    uniqueIndex('uq_campaign_recipients_campaign_contact').on(table.campaignId, table.contactId),
    index('campaign_recipients_campaign_status_idx').on(table.campaignId, table.status),
    index('campaign_recipients_message_id_idx')
      .on(table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
  ],
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type NewCampaignRecipient = typeof campaignRecipients.$inferInsert;
