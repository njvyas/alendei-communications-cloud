import { bigint, char, date, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { tstz } from './_shared';

/**
 * Phase 7 — the billing accounts and the usage ledger (migration `0050`;
 * DECISIONS.md §1zi).
 *
 * Read-only query models for the tenant billing reads (PR 7-6a, migration
 * `0055`): `acc_app` holds SELECT only, under organization-scoped RLS policies,
 * and the ledger policy admits only the tenant-visible entry types. The schema —
 * partitioning, keys, constraints, guards — is owned by the hand-written
 * migrations; every write goes through the SECURITY DEFINER ledger writer, never
 * through these models.
 */

export const usageLedgerEntryType = pgEnum('usage_ledger_entry_type', [
  'reservation',
  'reservation_release',
  'customer_charge',
  'provider_cost',
  'reseller_markup',
  'recharge',
  'refund',
  'adjustment',
  'tax',
  'discount',
]);

export const billingAccountStatus = pgEnum('billing_account_status', ['active', 'frozen']);

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  balancePaise: bigint('balance_paise', { mode: 'bigint' }).notNull(),
  reservedPaise: bigint('reserved_paise', { mode: 'bigint' }).notNull(),
  status: billingAccountStatus('status').notNull(),
  version: bigint('version', { mode: 'bigint' }).notNull(),
  createdAt: tstz('created_at').notNull(),
  updatedAt: tstz('updated_at').notNull(),
});

export const creditAccounts = pgTable('credit_accounts', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  creditLimitPaise: bigint('credit_limit_paise', { mode: 'bigint' }).notNull(),
  usedPaise: bigint('used_paise', { mode: 'bigint' }).notNull(),
  reservedPaise: bigint('reserved_paise', { mode: 'bigint' }).notNull(),
  status: billingAccountStatus('status').notNull(),
  version: bigint('version', { mode: 'bigint' }).notNull(),
  createdAt: tstz('created_at').notNull(),
  updatedAt: tstz('updated_at').notNull(),
});

export const usageLedger = pgTable('usage_ledger', {
  id: uuid('id').notNull(),
  anchorMonth: date('anchor_month').notNull(),
  anchorId: uuid('anchor_id').notNull(),
  factKind: text('fact_kind').notNull(),
  entryType: usageLedgerEntryType('entry_type').notNull(),
  orgId: uuid('org_id').notNull(),
  resellerId: uuid('reseller_id'),
  messageId: uuid('message_id'),
  messageAttemptId: uuid('message_attempt_id'),
  walletId: uuid('wallet_id'),
  creditAccountId: uuid('credit_account_id'),
  amountPaise: bigint('amount_paise', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  correlationId: text('correlation_id'),
  referenceNote: text('reference_note'),
  occurredAt: tstz('occurred_at').notNull(),
  createdAt: tstz('created_at').notNull(),
});
