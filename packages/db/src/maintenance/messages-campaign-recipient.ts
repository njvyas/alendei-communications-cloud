/**
 * Phase 8B PR 8B-3a — K1, the one-message-per-campaign-recipient backstop (DEP-5;
 * PHASE-8B-3-HANDOVER-Rev2 §4.3, owner decision OD-8B3-2):
 *
 *   uq_messages_campaign_recipient: UNIQUE (org_id, campaign_id, campaign_recipient_id)
 *                                   WHERE campaign_recipient_id IS NOT NULL
 *
 * A partial unique index on the large, hot `messages` table, so it is built CONCURRENTLY
 * outside any transaction and verified against the catalogue (never the journal). Same
 * policy as U14.1 and Phase 5.0 (`concurrent-index.ts`): absent → built; exact and valid →
 * accepted; an interrupted build (exact definition, not valid/ready/live) → refused unless
 * `--recover-invalid`, which drops that verified target CONCURRENTLY and rebuilds it;
 * anything else → refused, nothing dropped.
 *
 * Used by the barrier in `db:migrate` after migration 0068 (which adds the column) and before
 * guard migration `0069_phase8b3_campaign_recipient_unique_guard`, and by the standalone
 * runner (`npm run db:index:messages-campaign-recipient`).
 */
import type { ClientBase } from 'pg';

import {
  ensureIndexFor,
  verifyIndexExactFor,
  type ConcurrentIndexSpec,
  type EnsureOptions,
  type EnsureResult,
} from './concurrent-index';

/** The migration that adds `messages.campaign_recipient_id`. */
export const CAMPAIGN_ATTRIBUTION_MIGRATION =
  '0068_phase8b3_automation_identity_campaign_attribution';

export const MESSAGES_CAMPAIGN_RECIPIENT_UQ = {
  schema: 'public',
  table: 'messages',
  name: 'uq_messages_campaign_recipient',
  columns: [
    { name: 'org_id', type: 'uuid', opclassType: 'uuid' },
    { name: 'campaign_id', type: 'uuid', opclassType: 'uuid', nullable: true },
    { name: 'campaign_recipient_id', type: 'uuid', opclassType: 'uuid', nullable: true },
  ],
  indoption: [0, 0, 0],
  orderLabel: '(org_id ASC, campaign_id ASC, campaign_recipient_id ASC)',
  unique: true,
  partial: true,
  definition:
    'CREATE UNIQUE INDEX uq_messages_campaign_recipient ON public.messages USING btree (org_id, campaign_id, campaign_recipient_id) WHERE (campaign_recipient_id IS NOT NULL)',
  recoveryCommand:
    'npm run db:index:messages-campaign-recipient --workspace @acc/db -- --recover-invalid',
  requiresMigration: CAMPAIGN_ATTRIBUTION_MIGRATION,
} as const satisfies ConcurrentIndexSpec;

export const verifyMessagesCampaignRecipientIndex = (
  client: ClientBase,
  context: string,
): Promise<void> => verifyIndexExactFor(MESSAGES_CAMPAIGN_RECIPIENT_UQ, client, context);

export const ensureMessagesCampaignRecipientIndex = (
  client: ClientBase,
  options: EnsureOptions = {},
): Promise<EnsureResult> => ensureIndexFor(MESSAGES_CAMPAIGN_RECIPIENT_UQ, client, options);
