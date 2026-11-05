/**
 * `npm run db:index:messages-org-created-at --workspace @acc/db -- [--check | --recover-invalid]`
 *
 * The standalone concurrent-index runner for U14.1b's `messages_org_id_created_at_idx`
 * (same policy as U14.1a: owner decisions U-1, U-3). Logic: `index-runner.ts`.
 */
import type { Pool } from 'pg';

import { MESSAGES_ORG_ID_CREATED_AT } from '../maintenance/messages-org-id-created-at';
import {
  parseRunnerArgs as parseArgs,
  runIndexCli,
  runIndexRunnerFor,
  type RunnerMode,
} from './index-runner';

const COMMAND = 'db:index:messages-org-created-at';

export const parseCreatedAtRunnerArgs = (argv: readonly string[]): RunnerMode =>
  parseArgs(argv, COMMAND);

export const runCreatedAtIndexRunner = (
  pool: Pool,
  mode: RunnerMode,
  options: { lockWaitMs?: number; log?: (line: string) => void } = {},
): Promise<{ ok: boolean; summary: string }> =>
  runIndexRunnerFor(MESSAGES_ORG_ID_CREATED_AT, pool, mode, options);

if (require.main === module) {
  runIndexCli(MESSAGES_ORG_ID_CREATED_AT, COMMAND).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
