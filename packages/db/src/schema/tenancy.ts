import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './_shared';

/**
 * Tenancy domain (`DATABASE.md` §2, `TENANCY.md` §1):
 *
 *   Alendei (platform) -> Reseller -> Organization -> Workspace -> Team -> User
 */

export const resellerStatus = pgEnum('reseller_status', ['active', 'suspended', 'closed']);
export const organizationStatus = pgEnum('organization_status', ['active', 'suspended', 'closed']);
export const workspaceStatus = pgEnum('workspace_status', ['active', 'archived']);
export const billingMode = pgEnum('billing_mode', ['prepaid', 'postpaid']);
export const billingPolicy = pgEnum('billing_policy', [
  'charge_per_logical_message',
  'charge_per_attempt',
]);

export const resellers = pgTable(
  'resellers',
  {
    id: primaryId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    domain: text('domain'),
    brandConfig: jsonb('brand_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    defaultMarkupPct: numeric('default_markup_pct', { precision: 6, scale: 3 })
      .notNull()
      .default('0'),
    status: resellerStatus('status').notNull().default('active'),
    /**
     * The seeded "Alendei Direct" row (`TENANCY.md` §1). Organizations with no
     * external reseller are attached to it, so no code path branches on
     * `reseller_id IS NULL`.
     */
    isPlatformDefault: boolean('is_platform_default').notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('resellers_slug_key').on(table.slug),
    uniqueIndex('resellers_domain_key')
      .on(table.domain)
      .where(sql`${table.domain} IS NOT NULL`),
    // At most one platform-default reseller may ever exist.
    uniqueIndex('resellers_single_platform_default')
      .on(table.isPlatformDefault)
      .where(sql`${table.isPlatformDefault}`),
    check('resellers_markup_range', sql`${table.defaultMarkupPct} >= 0`),
  ],
);

export const organizations = pgTable(
  'organizations',
  {
    id: primaryId(),
    /**
     * Nullable per `DATABASE.md` §2. Application code always assigns one —
     * defaulting to the seeded "Alendei Direct" reseller (`TENANCY.md` §1).
     */
    resellerId: uuid('reseller_id').references(() => resellers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    legalName: text('legal_name'),
    gstin: text('gstin'),
    billingMode: billingMode('billing_mode').notNull().default('prepaid'),
    /** Home of the fallback-charging decision (`BILLING.md` §5). */
    billingPolicy: billingPolicy('billing_policy').notNull().default('charge_per_logical_message'),
    status: organizationStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('organizations_slug_key').on(table.slug),
    index('organizations_reseller_id_idx').on(table.resellerId),
    index('organizations_status_idx').on(table.status),
    // GSTIN is 15 chars: 2 state + 10 PAN + 1 entity + 1 'Z' + 1 checksum.
    check(
      'organizations_gstin_format',
      sql`${table.gstin} IS NULL OR ${table.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'`,
    ),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    brandConfig: jsonb('brand_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: workspaceStatus('status').notNull().default('active'),
    /** Every organization is seeded with exactly one default workspace. */
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('workspaces_org_slug_key').on(table.orgId, table.slug),
    uniqueIndex('workspaces_single_default_per_org')
      .on(table.orgId)
      .where(sql`${table.isDefault}`),
    // Target of the composite FK on `teams`, which is what makes a team's
    // denormalized org_id structurally unable to disagree with its workspace.
    // Declared as a constraint rather than an index so it is created with the
    // table, before the foreign key that depends on it.
    unique('workspaces_id_org_id_key').on(table.id, table.orgId),
    index('workspaces_org_id_idx').on(table.orgId),
  ],
);

export const teams = pgTable(
  'teams',
  {
    id: primaryId(),
    workspaceId: uuid('workspace_id').notNull(),
    /**
     * Denormalized from `workspaces.org_id` so this tenant-scoped table carries
     * `org_id` as `DATABASE.md` §1 requires, and so its RLS policy is a direct
     * comparison rather than a join. The composite foreign key below makes the
     * two physically incapable of disagreeing.
     */
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'teams_workspace_org_fk',
      columns: [table.workspaceId, table.orgId],
      foreignColumns: [workspaces.id, workspaces.orgId],
    }).onDelete('restrict'),
    uniqueIndex('teams_workspace_name_key').on(table.workspaceId, table.name),
    unique('teams_id_org_id_key').on(table.id, table.orgId),
    index('teams_org_id_idx').on(table.orgId),
    index('teams_workspace_id_idx').on(table.workspaceId),
  ],
);

export type Reseller = typeof resellers.$inferSelect;
export type NewReseller = typeof resellers.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
