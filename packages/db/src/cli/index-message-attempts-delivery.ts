/**
 * `npm run db:index:message-attempts-delivery --workspace @acc/db -- [--check | --recover-invalid]`
 *
 * The standalone concurrent-index runner for Phase 5.0's two UNIQUE indexes on
 * `public.message_attempts` (`message-attempts-delivery.ts`). Same policy as U14.1:
 * owner decisions U-1 (recover only with the flag) and U-3 (catalogue, not journal).
 * Each index is handled in turn, each under the session-level migration lock.
 * Logic: `index-runner.ts`.
 */
import type { Pool } from 'pg';

import { MESSAGE_ATTEMPTS_DELIVERY_INDEXES } from '../maintenance/message-attempts-delivery';
import { parseRunnerArgs, runIndexCli, runIndexRunnerFor, type RunnerMode } from './index-runner';

const COMMAND = 'db:index:message-attempts-delivery';

export const parseDeliveryIndexRunnerArgs = (argv: readonly string[]): RunnerMode =>
  parseRunnerArgs(argv, COMMAND);

/** Runs the given mode for both indexes in turn; `ok` only if both are ok. */
export async function runDeliveryIndexRunner(
  pool: Pool,
  mode: RunnerMode,
  options: { lockWaitMs?: number; log?: (line: string) => void } = {},
): Promise<{ ok: boolean; summary: string }> {
  const summaries: string[] = [];
  let ok = true;
  for (const spec of MESSAGE_ATTEMPTS_DELIVERY_INDEXES) {
    const result = await runIndexRunnerFor(spec, pool, mode, options);
    ok = ok && result.ok;
    summaries.push(result.summary);
  }
  return { ok, summary: summaries.join('\n') };
}

if (require.main === module) {
  runIndexCli(MESSAGE_ATTEMPTS_DELIVERY_INDEXES, COMMAND).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
