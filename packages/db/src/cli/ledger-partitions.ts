/**
 * `npm run db:ledger:partitions --workspace @acc/db -- --check | --ensure [--months N]`
 *
 * Operator command for `usage_ledger` partitions (Phase 7 PR 7-1, `DECISIONS.md`
 * §1zi RQ-4). Runs as the schema owner (`DATABASE_ADMIN_URL`).
 *
 * - `--check`: reports the partitions and exits non-zero on any gap, unprotected
 *   partition, orphan table, missing current month or headroom below the
 *   critical threshold (two months, RQ-6).
 * - `--ensure`: creates the missing months (default 24 ahead, at most 36), then
 *   checks as above.
 *
 * Only the schema owner may create partitions: `app_ledger_ensure_partitions`
 * grants EXECUTE to no other role, so `--ensure` under an application role's
 * credentials is refused by the database (42501).
 */
import { Pool } from 'pg';

import {
  ensureAndVerifyLedgerPartitions,
  evaluateLedgerPartitions,
  LEDGER_PARTITION_MONTHS_AHEAD,
  readLedgerPartitionReport,
} from '../maintenance/ledger-partitions';
import { loadCliEnv, requireEnv } from './_env';

const COMMAND = 'db:ledger:partitions';

export type LedgerPartitionsMode =
  { readonly kind: 'check' } | { readonly kind: 'ensure'; readonly monthsAhead: number };

export function parseLedgerPartitionsArgs(argv: readonly string[]): LedgerPartitionsMode {
  const usage = `usage: npm run ${COMMAND} --workspace @acc/db -- --check | --ensure [--months N]`;
  const args = [...argv];
  const check = args.includes('--check');
  const ensure = args.includes('--ensure');
  const monthsAt = args.indexOf('--months');
  const known = new Set(['--check', '--ensure', '--months']);
  for (let i = 0; i < args.length; i += 1) {
    if (i === monthsAt + 1 && monthsAt >= 0) continue;
    if (!known.has(args[i] as string)) throw new Error(`unknown argument ${args[i]}\n${usage}`);
  }
  if (check === ensure) throw new Error(usage);
  if (check) {
    if (monthsAt >= 0) throw new Error(`--months applies to --ensure only\n${usage}`);
    return { kind: 'check' };
  }
  let monthsAhead = LEDGER_PARTITION_MONTHS_AHEAD;
  if (monthsAt >= 0) {
    const raw = args[monthsAt + 1];
    if (raw === undefined || !/^\d+$/.test(raw))
      throw new Error(`--months needs a number\n${usage}`);
    monthsAhead = Number(raw);
    if (monthsAhead > 36) throw new Error(`--months must be between 0 and 36\n${usage}`);
  }
  return { kind: 'ensure', monthsAhead };
}

export async function runLedgerPartitions(
  pool: Pool,
  mode: LedgerPartitionsMode,
  log: (line: string) => void = (line) => console.log(line),
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const client = await pool.connect();
  try {
    // The operator asked for an ensure: its failure (for example 42501 under a role that is not
    // the schema owner, or an expired lock wait) fails the command even when headroom is ample.
    let ensureFailed = false;
    let verdict;
    if (mode.kind === 'ensure') {
      const result = await ensureAndVerifyLedgerPartitions(client, {
        monthsAhead: mode.monthsAhead,
        now: now(),
      });
      ensureFailed = result.ensureError !== null;
      if (ensureFailed) log(`ensure failed: ${result.ensureError}`);
      else log(`created ${result.created} partition(s)`);
      verdict = result.verdict;
    } else {
      verdict = evaluateLedgerPartitions(await readLedgerPartitionReport(client), now());
    }
    for (const r of await readLedgerPartitionReport(client)) {
      log(
        `${r.partitionName} ${r.rangeStart ?? '-'}..${r.rangeEnd ?? '-'} attached=${r.attached} ` +
          `truncate_guard=${r.truncateGuarded} row_guard=${r.rowGuarded} rls=${r.rlsEnabled} ` +
          `owner_only=${r.privilegesRestricted}`,
      );
    }
    log(verdict.summary);
    return !ensureFailed && verdict.level !== 'critical';
  } finally {
    client.release();
  }
}

if (require.main === module) {
  (async () => {
    loadCliEnv();
    const mode = parseLedgerPartitionsArgs(process.argv.slice(2));
    const pool = new Pool({
      connectionString: requireEnv('DATABASE_ADMIN_URL'),
      max: 1,
      application_name: 'acc-ledger-partitions',
    });
    pool.on('error', (error) => console.error(`database connection error: ${error.message}`));
    try {
      const ok = await runLedgerPartitions(pool, mode);
      if (!ok) process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
