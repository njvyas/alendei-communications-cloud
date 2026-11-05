/**
 * U14.1a — `public.messages (org_id, id DESC)` built CONCURRENTLY, outside any
 * transaction, and verified against the catalogue (never against the journal).
 *
 * Used by the barrier in `db:migrate` (`schema-migrate.ts`) before migration
 * `0042_messages_org_id_id_desc_guard`, and by the standalone runner
 * (`npm run db:index:messages-org-id-desc`). Both hold the session-level
 * migration lock on the same pinned connection. The policy (owner decisions
 * U-1, U-3) lives in `concurrent-index.ts`; this file is the index's spec.
 */
import type { ClientBase } from 'pg';

import {
  classifyIndexFor,
  describeFor,
  ensureIndexFor,
  readIndexCatalogueFor,
  tableProblemsFor,
  verifyIndexExactFor,
  type CatalogueSnapshot,
  type ConcurrentIndexSpec,
  type EnsureOptions,
  type EnsureResult,
  type IndexState,
} from './concurrent-index';

export {
  IndexMaintenanceError,
  type CatalogueSnapshot,
  type EnsureOptions,
  type EnsureResult,
  type IndexState,
  type TargetRow,
} from './concurrent-index';

export const MESSAGES_ORG_ID_ID_DESC = {
  schema: 'public',
  table: 'messages',
  name: 'messages_org_id_id_desc_idx',
  columns: [
    { name: 'org_id', type: 'uuid', opclassType: 'uuid' },
    { name: 'id', type: 'uuid', opclassType: 'uuid' },
  ],
  /** `pg_index.indoption`: org_id ASC NULLS LAST = 0; id DESC (NULLS FIRST by default) = 3. */
  indoption: [0, 3],
  orderLabel: '(org_id ASC, id DESC)',
  definition:
    'CREATE INDEX messages_org_id_id_desc_idx ON public.messages USING btree (org_id, id DESC)',
  recoveryCommand: 'npm run db:index:messages-org-id-desc --workspace @acc/db -- --recover-invalid',
} as const satisfies ConcurrentIndexSpec;

export const classifyIndex = (s: CatalogueSnapshot): IndexState =>
  classifyIndexFor(MESSAGES_ORG_ID_ID_DESC, s);
export const tableProblems = (s: CatalogueSnapshot): string[] =>
  tableProblemsFor(MESSAGES_ORG_ID_ID_DESC, s);
export const readIndexCatalogue = (client: ClientBase): Promise<CatalogueSnapshot> =>
  readIndexCatalogueFor(MESSAGES_ORG_ID_ID_DESC, client);
export const describe = (state: IndexState): string => describeFor(MESSAGES_ORG_ID_ID_DESC, state);
export const verifyIndexExact = (client: ClientBase, context: string): Promise<void> =>
  verifyIndexExactFor(MESSAGES_ORG_ID_ID_DESC, client, context);
export const ensureMessagesOrgIdIdDescIndex = (
  client: ClientBase,
  options: EnsureOptions = {},
): Promise<EnsureResult> => ensureIndexFor(MESSAGES_ORG_ID_ID_DESC, client, options);
