import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, tstz } from './_shared';
import { users } from './iam';
import { organizations } from './tenancy';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/**
 * Phase 8B PR 8B-3a (0068): the shared, organisation-owned automation sending identity
 * (OD-8C-1; PHASE-8B-3-HANDOVER-Rev2 §3). Both tables are definer-only: no application role
 * holds a privilege on them, and every access goes through the `app_automation_*` functions.
 */
export const automationSubjectKind = pgEnum('automation_subject_kind', [
  'campaign_recipient',
  'journey_execution',
]);

/**
 * One short-lived send authorisation per message, minted inside the claim-fenced send
 * transaction (`app_automation_capability_mint`). Only the token's sha256 is stored. Append-only
 * except a single revocation; kept 90 days (OD-8B3-6). Journey subjects are refused until 8C-6.
 */
export const automationCapabilities = pgTable(
  'automation_capabilities',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    subjectKind: automationSubjectKind('subject_kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    automationId: uuid('automation_id').notNull(),
    claimEpoch: integer('claim_epoch').notNull(),
    initiatorUserId: uuid('initiator_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    tokenHash: bytea('token_hash').notNull(),
    issuedAt: tstz('issued_at')
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
  },
  (table) => [
    unique('uq_automation_capabilities_token_hash').on(table.tokenHash),
    check('automation_capabilities_token_hash_length', sql`octet_length(${table.tokenHash}) = 32`),
    check(
      'automation_capabilities_lifetime',
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '30 seconds'`,
    ),
    check(
      'automation_capabilities_revoked_after_issue',
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.issuedAt}`,
    ),
    index('automation_capabilities_subject_idx').on(
      table.orgId,
      table.subjectKind,
      table.subjectId,
    ),
    index('automation_capabilities_open_idx')
      .on(table.orgId, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    index('automation_capabilities_issued_at_idx').on(table.issuedAt),
  ],
);

/**
 * The organisation's administrator controls: a sending pause and an organisation-wide revocation
 * instant. Changed only by `app_automation_apply_control` (FOR UPDATE, serialised against every
 * send's FOR SHARE), reached through `app_automation_control` (organisation-scope authority) or
 * the owner-run `automation:control` CLI.
 */
export const automationControls = pgTable(
  'automation_controls',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    sendingPaused: boolean('sending_paused').notNull().default(false),
    pausedAt: tstz('paused_at'),
    pausedByUserId: uuid('paused_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    pausedByLabel: text('paused_by_label'),
    pauseReason: text('pause_reason'),
    revokedBefore: tstz('revoked_before'),
    updatedAt: tstz('updated_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    check(
      'automation_controls_pause_shape',
      sql`${table.sendingPaused} = (${table.pausedAt} IS NOT NULL)`,
    ),
    check(
      'automation_controls_text_bounded',
      sql`(${table.pauseReason} IS NULL OR char_length(${table.pauseReason}) BETWEEN 1 AND 200) AND (${table.pausedByLabel} IS NULL OR char_length(${table.pausedByLabel}) BETWEEN 1 AND 100)`,
    ),
  ],
);
