/**
 * U14.1b — `public.messages (org_id, created_at)` built CONCURRENTLY, outside any
 * transaction, and verified against the catalogue (never against the journal).
 *
 * It serves the two statements with a `created_at` range: `GET /messages` with
 * `createdFrom`/`createdTo` (the order stays `id DESC` — UUIDv7, unchanged) and
 * `GET /usage/messages`. The owner approved this shape over the originally named
 * `(org_id, created_at DESC, id DESC)` on the plan evidence of 05-Nov-2026: no
 * statement orders by `created_at`, a btree scans either direction, and the
 * trailing `id` added size without benefit.
 *
 * Used by the barrier in `db:migrate` before migration
 * `0043_messages_org_id_created_at_guard`, and by the standalone runner
 * (`npm run db:index:messages-org-created-at`). Same policy as U14.1a
 * (`concurrent-index.ts`).
 */
import type { ClientBase } from 'pg';

import {
  ensureIndexFor,
  verifyIndexExactFor,
  type ConcurrentIndexSpec,
  type EnsureOptions,
  type EnsureResult,
} from './concurrent-index';

export const MESSAGES_ORG_ID_CREATED_AT = {
  schema: 'public',
  table: 'messages',
  name: 'messages_org_id_created_at_idx',
  columns: [
    { name: 'org_id', type: 'uuid', opclassType: 'uuid' },
    { name: 'created_at', type: 'timestamp with time zone', opclassType: 'timestamptz' },
  ],
  /** `pg_index.indoption`: both ASC NULLS LAST = 0. */
  indoption: [0, 0],
  orderLabel: '(org_id ASC, created_at ASC)',
  definition:
    'CREATE INDEX messages_org_id_created_at_idx ON public.messages USING btree (org_id, created_at)',
  recoveryCommand:
    'npm run db:index:messages-org-created-at --workspace @acc/db -- --recover-invalid',
} as const satisfies ConcurrentIndexSpec;

export const verifyMessagesOrgIdCreatedAtIndex = (
  client: ClientBase,
  context: string,
): Promise<void> => verifyIndexExactFor(MESSAGES_ORG_ID_CREATED_AT, client, context);
export const ensureMessagesOrgIdCreatedAtIndex = (
  client: ClientBase,
  options: EnsureOptions = {},
): Promise<EnsureResult> => ensureIndexFor(MESSAGES_ORG_ID_CREATED_AT, client, options);
