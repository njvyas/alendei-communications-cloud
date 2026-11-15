/**
 * `npm run db:index:messages-campaign-recipient --workspace @acc/db -- [--check | --recover-invalid]`
 *
 * The standalone concurrent-index runner for Phase 8B-3a's K1 backstop,
 * `uq_messages_campaign_recipient` (`messages-campaign-recipient.ts`). Same policy as U14.1
 * (owner decisions U-1, U-3): `--recover-invalid` is the recovery path for an interrupted
 * concurrent build. Logic: `index-runner.ts`.
 */
import type { Pool } from 'pg';

import { MESSAGES_CAMPAIGN_RECIPIENT_UQ } from '../maintenance/messages-campaign-recipient';
import {
  parseRunnerArgs as parseArgs,
  runIndexCli,
  runIndexRunnerFor,
  type RunnerMode,
} from './index-runner';

const COMMAND = 'db:index:messages-campaign-recipient';

export const parseCampaignRecipientRunnerArgs = (argv: readonly string[]): RunnerMode =>
  parseArgs(argv, COMMAND);

export const runCampaignRecipientIndexRunner = (
  pool: Pool,
  mode: RunnerMode,
  options: { lockWaitMs?: number; log?: (line: string) => void } = {},
): Promise<{ ok: boolean; summary: string }> =>
  runIndexRunnerFor(MESSAGES_CAMPAIGN_RECIPIENT_UQ, pool, mode, options);

if (require.main === module) {
  runIndexCli(MESSAGES_CAMPAIGN_RECIPIENT_UQ, COMMAND).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
