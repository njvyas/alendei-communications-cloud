/**
 * `npm run db:index:messages-org-id-desc --workspace @acc/db -- [--check | --recover-invalid]`
 *
 * The standalone concurrent-index runner for U14.1a's `messages_org_id_id_desc_idx`
 * (owner decisions U-1, U-3). Logic: `index-runner.ts`.
 */
import type { Pool } from 'pg';

import { MESSAGES_ORG_ID_ID_DESC } from '../maintenance/messages-org-id-id-desc';
import {
  parseRunnerArgs as parseArgs,
  runIndexCli,
  runIndexRunnerFor,
  type RunnerMode,
} from './index-runner';

export type { RunnerMode } from './index-runner';

const COMMAND = 'db:index:messages-org-id-desc';

export const parseRunnerArgs = (argv: readonly string[]): RunnerMode => parseArgs(argv, COMMAND);

export const runIndexRunner = (
  pool: Pool,
  mode: RunnerMode,
  options: { lockWaitMs?: number; log?: (line: string) => void } = {},
): Promise<{ ok: boolean; summary: string }> =>
  runIndexRunnerFor(MESSAGES_ORG_ID_ID_DESC, pool, mode, options);

if (require.main === module) {
  runIndexCli(MESSAGES_ORG_ID_ID_DESC, COMMAND).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
