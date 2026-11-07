/**
 * Phase 5.0 (M2) — the two UNIQUE indexes on `public.message_attempts` that the
 * delivery foundation needs, built CONCURRENTLY outside any transaction and
 * verified against the catalogue (never against the journal). Same policy as
 * U14.1a/U14.1b (`concurrent-index.ts`).
 *
 *   1. `message_attempts_provider_message_uq` — (provider_id, provider_message_id)
 *      WHERE provider_message_id IS NOT NULL: one attempt per provider message id,
 *      the correlation key of delivery receipts (design spec Rev 2 §C.1).
 *   2. `uq_message_attempts_id_message_id` — (id, message_id): the unique target of
 *      the composite foreign key `messages_delivered_attempt_fk` (0046). Migration
 *      0046 attaches it as the UNIQUE constraint of the same name (`USING INDEX`, so
 *      no rename), after which both constraints legitimately depend on it.
 *
 * Used by the barrier in `db:migrate` before guard migration
 * `0045_message_attempts_delivery_indexes_guard`, and by the standalone runner
 * (`npm run db:index:message-attempts-delivery`).
 */
import type { ClientBase } from 'pg';

import {
  ensureIndexFor,
  verifyIndexExactFor,
  type ConcurrentIndexSpec,
  type EnsureOptions,
  type EnsureResult,
} from './concurrent-index';

/** The migration that adds `message_attempts.provider_message_id`. */
export const DELIVERY_FOUNDATION_MIGRATION = '0044_phase5_0_delivery_foundation';
const RECOVERY =
  'npm run db:index:message-attempts-delivery --workspace @acc/db -- --recover-invalid';

export const MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ = {
  schema: 'public',
  table: 'message_attempts',
  name: 'message_attempts_provider_message_uq',
  columns: [
    { name: 'provider_id', type: 'uuid', opclassType: 'uuid' },
    {
      name: 'provider_message_id',
      type: 'text',
      opclassType: 'text',
      nullable: true,
      collation: 100,
    },
  ],
  indoption: [0, 0],
  orderLabel: '(provider_id ASC, provider_message_id ASC)',
  unique: true,
  partial: true,
  definition:
    'CREATE UNIQUE INDEX message_attempts_provider_message_uq ON public.message_attempts USING btree (provider_id, provider_message_id) WHERE (provider_message_id IS NOT NULL)',
  recoveryCommand: RECOVERY,
  requiresMigration: DELIVERY_FOUNDATION_MIGRATION,
} as const satisfies ConcurrentIndexSpec;

export const MESSAGE_ATTEMPTS_ID_MESSAGE_ID_UQ = {
  schema: 'public',
  table: 'message_attempts',
  name: 'uq_message_attempts_id_message_id',
  columns: [
    { name: 'id', type: 'uuid', opclassType: 'uuid' },
    { name: 'message_id', type: 'uuid', opclassType: 'uuid' },
  ],
  indoption: [0, 0],
  orderLabel: '(id ASC, message_id ASC)',
  unique: true,
  definition:
    'CREATE UNIQUE INDEX uq_message_attempts_id_message_id ON public.message_attempts USING btree (id, message_id)',
  recoveryCommand: RECOVERY,
  requiresMigration: DELIVERY_FOUNDATION_MIGRATION,
  // 0046 attaches the index as this UNIQUE constraint and adds the FK that references it.
  allowedConstraints: ['uq_message_attempts_id_message_id', 'messages_delivered_attempt_fk'],
} as const satisfies ConcurrentIndexSpec;

export const MESSAGE_ATTEMPTS_DELIVERY_INDEXES: readonly ConcurrentIndexSpec[] = [
  MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ,
  MESSAGE_ATTEMPTS_ID_MESSAGE_ID_UQ,
];

const RANK: Record<EnsureResult, number> = { present: 0, created: 1, recovered: 2 };

/** Ensures both indexes, in order; the combined result is the "strongest" individual one. */
export async function ensureMessageAttemptsDeliveryIndexes(
  client: ClientBase,
  options: EnsureOptions = {},
): Promise<EnsureResult> {
  let combined: EnsureResult = 'present';
  for (const spec of MESSAGE_ATTEMPTS_DELIVERY_INDEXES) {
    const result = await ensureIndexFor(spec, client, options);
    if (RANK[result] > RANK[combined]) combined = result;
  }
  return combined;
}

/** Throws unless both exact, valid indexes exist now. */
export async function verifyMessageAttemptsDeliveryIndexes(
  client: ClientBase,
  context: string,
): Promise<void> {
  for (const spec of MESSAGE_ATTEMPTS_DELIVERY_INDEXES) {
    await verifyIndexExactFor(spec, client, context);
  }
}
