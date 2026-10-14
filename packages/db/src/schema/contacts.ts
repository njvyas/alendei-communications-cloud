import { sql } from 'drizzle-orm';
import {
  boolean,
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

import { createdAt, primaryId, timestamps, tstz } from './_shared';
import { organizations, workspaces } from './tenancy';
import { channels } from './providers';

/** Contact identity lifecycle status (Phase 3.1). */
export const contactIdentityStatus = pgEnum('contact_identity_status', [
  'active',
  'inactive',
]);

/** Consent event type: grant or revoke (Phase 3.1, ADR-014 §11). */
export const consentEventType = pgEnum('consent_event_type', ['grant', 'revoke']);

/**
 * Workspace-owned contacts table (Phase 3.1, `DATABASE.md` §3).
 *
 * Denormalized `org_id` with composite FK to `workspaces(id, org_id)`.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'contacts_workspace_org_fk',
      columns: [table.workspaceId, table.orgId],
      foreignColumns: [workspaces.id, workspaces.orgId],
    }).onDelete('restrict'),
    unique('contacts_id_workspace_org_key').on(table.id, table.workspaceId, table.orgId),
    index('contacts_org_id_idx').on(table.orgId),
    index('contacts_workspace_id_idx').on(table.workspaceId),
    index('contacts_workspace_created_at_id_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * Contact identities (Phase 3.1, P3-D25).
 *
 * Child of `contacts` with composite FK to `contacts(id, workspace_id, org_id)`.
 * Partial unique index on active identities per workspace, channel and normalized address.
 */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    rawAddress: text('raw_address').notNull(),
    normalizedAddress: text('normalized_address').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    status: contactIdentityStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'contact_identities_contact_fk',
      columns: [table.contactId, table.workspaceId, table.orgId],
      foreignColumns: [contacts.id, contacts.workspaceId, contacts.orgId],
    }).onDelete('restrict'),
    uniqueIndex('uq_contact_identities_workspace_active')
      .on(table.workspaceId, table.channelId, table.normalizedAddress)
      .where(sql`${table.status} = 'active'`),
    index('contact_identities_org_id_idx').on(table.orgId),
    index('contact_identities_contact_id_idx').on(table.contactId),
    index('contact_identities_workspace_id_idx').on(table.workspaceId),
  ],
);

/**
 * Append-only consent event trail (Phase 3.1, ADR-014 §11, D23).
 *
 * Child of `contacts` with composite FK to `contacts(id, workspace_id, org_id)`.
 * Immutable: guarded by trigger `trg_consent_events_immutable`.
 */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    consentType: text('consent_type').notNull(),
    event: consentEventType('event').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'consent_events_contact_fk',
      columns: [table.contactId, table.workspaceId, table.orgId],
      foreignColumns: [contacts.id, contacts.workspaceId, contacts.orgId],
    }).onDelete('restrict'),
    index('consent_events_org_id_idx').on(table.orgId),
    index('consent_events_contact_channel_type_idx').on(
      table.contactId,
      table.channelId,
      table.consentType,
      table.occurredAt,
      table.id,
    ),
  ],
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ContactIdentity = typeof contactIdentities.$inferSelect;
export type NewContactIdentity = typeof contactIdentities.$inferInsert;
export type ConsentEvent = typeof consentEvents.$inferSelect;
export type NewConsentEvent = typeof consentEvents.$inferInsert;
