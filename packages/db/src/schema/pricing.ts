import { bigint, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryId, tstz } from './_shared';
import { channels, providers } from './providers';
import { organizations } from './tenancy';

/**
 * Phase 7 PR 7-2 — the pricing catalogue (migration `0051`; DECISIONS.md §1zi).
 *
 * Query models for the platform pricing API only. The schema is created by the
 * hand-written migration, which also owns every constraint and trigger:
 * versions are frozen once active, rules change only on drafts, cost rates and
 * assignments are append-only and never backdated. `pricing_evaluations` and
 * its components are not modelled: no application role may read or write them;
 * only the SECURITY DEFINER rating functions do.
 */

export const pricingVersionStatus = pgEnum('pricing_version_status', ['draft', 'active']);

export const pricingPlans = pgTable('pricing_plans', {
  id: primaryId(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: createdAt(),
});

export const pricingPlanVersions = pgTable('pricing_plan_versions', {
  id: primaryId(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => pricingPlans.id, { onDelete: 'restrict' }),
  versionNumber: integer('version_number').notNull(),
  status: pricingVersionStatus('status').notNull().default('draft'),
  effectiveFrom: tstz('effective_from'),
  activatedAt: tstz('activated_at'),
  createdAt: createdAt(),
});

export const pricingRules = pgTable('pricing_rules', {
  id: primaryId(),
  planVersionId: uuid('plan_version_id')
    .notNull()
    .references(() => pricingPlanVersions.id, { onDelete: 'restrict' }),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'restrict' }),
  providerId: uuid('provider_id'),
  unitPriceE4: bigint('unit_price_e4', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
});

export const providerCostRates = pgTable('provider_cost_rates', {
  id: primaryId(),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'restrict' }),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'restrict' }),
  unitCostE4: bigint('unit_cost_e4', { mode: 'number' }).notNull(),
  effectiveFrom: tstz('effective_from').notNull(),
  createdAt: createdAt(),
});

export const customerPricingAssignments = pgTable('customer_pricing_assignments', {
  id: primaryId(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'restrict' }),
  planId: uuid('plan_id')
    .notNull()
    .references(() => pricingPlans.id, { onDelete: 'restrict' }),
  effectiveFrom: tstz('effective_from').notNull(),
  createdAt: createdAt(),
});
