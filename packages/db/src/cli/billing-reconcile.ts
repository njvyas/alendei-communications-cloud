/**
 * `npm run billing:reconcile -- [--org <uuid> ...] [--since <YYYY-MM>] [--stale-hours <n>]
 *                               [--statement-timeout-ms <n>] [--json <path|->] [--quiet]`
 *
 * Phase 7 PR 7-7a (`DECISIONS.md` §1zi.16): the read-only, report-only billing
 * reconciliation, checks C-1 to C-6 (`../maintenance/billing-reconcile.ts`). Runs as the
 * schema owner (`DATABASE_ADMIN_URL`), the only role that reads every tenant's billing
 * rows, inside one READ ONLY transaction. It never repairs or writes anything.
 *
 * Exit code: 0 clean; 1 one or more findings; 2 the run could not complete.
 */
import { writeFileSync } from 'node:fs';

import { Pool } from 'pg';

import {
  RECONCILE_DEFAULTS,
  RECONCILE_REPORT_VERSION,
  RECONCILE_RUNTIME_TARGET_MS,
  renderHuman,
  runReconcile,
  type ReconcileOptions,
  type ReconcileReport,
} from '../maintenance/billing-reconcile';
import { loadCliEnv, requireEnv } from './_env';

export const RECONCILE_USAGE =
  'usage: npm run billing:reconcile -- [--org <uuid> ...] [--since <YYYY-MM>] [--stale-hours <n>] ' +
  '[--statement-timeout-ms <n>] [--json <path|->] [--quiet]';

export interface ReconcileArgs extends ReconcileOptions {
  /** A file path, `-` for stdout (instead of the human report), or `null`. */
  readonly json: string | null;
  readonly quiet: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Parses the arguments; throws `Error(usage …)` on anything invalid (exit code 2). */
export function parseReconcileArgs(argv: readonly string[]): ReconcileArgs {
  const orgs: string[] = [];
  let since: string | null = null;
  let staleHours: number = RECONCILE_DEFAULTS.staleHours;
  let statementTimeoutMs: number = RECONCILE_DEFAULTS.statementTimeoutMs;
  let json: string | null = null;
  let quiet = false;
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--'))
      throw new Error(`${flag} needs a value\n${RECONCILE_USAGE}`);
    return v;
  };
  const positive = (raw: string, flag: string, max: number): number => {
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
      throw new Error(`${flag} must be an integer from 1 to ${max}\n${RECONCILE_USAGE}`);
    }
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--org': {
        const v = value(i, arg);
        if (!UUID.test(v)) throw new Error(`--org must be a UUID\n${RECONCILE_USAGE}`);
        orgs.push(v.toLowerCase());
        i += 1;
        break;
      }
      case '--since': {
        const v = value(i, arg);
        if (!MONTH.test(v)) throw new Error(`--since must be YYYY-MM\n${RECONCILE_USAGE}`);
        since = v;
        i += 1;
        break;
      }
      case '--stale-hours':
        staleHours = positive(value(i, arg), arg, 24 * 366);
        i += 1;
        break;
      case '--statement-timeout-ms':
        statementTimeoutMs = positive(value(i, arg), arg, 3_600_000);
        i += 1;
        break;
      case '--json':
        json = value(i, arg);
        i += 1;
        break;
      case '--quiet':
        quiet = true;
        break;
      default:
        throw new Error(`unknown argument ${arg}\n${RECONCILE_USAGE}`);
    }
  }
  return {
    orgs: orgs.length > 0 ? orgs : null,
    since,
    staleHours,
    statementTimeoutMs,
    json,
    quiet,
  };
}

/** The report for a run that could not even start (bad arguments, no connection). */
export function failedReport(error: string, args: ReconcileArgs | null): ReconcileReport {
  const now = new Date().toISOString();
  return {
    reportVersion: RECONCILE_REPORT_VERSION,
    command: 'billing:reconcile',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    complete: false,
    error,
    database: null,
    migrationProof: null,
    snapshotAt: null,
    readOnly: true,
    transactionIdAssigned: null,
    scope: {
      orgs: args?.orgs ?? null,
      since: args?.since ?? null,
      staleHours: args?.staleHours ?? RECONCILE_DEFAULTS.staleHours,
      statementTimeoutMs: args?.statementTimeoutMs ?? RECONCILE_DEFAULTS.statementTimeoutMs,
    },
    runtimeTargetMs: RECONCILE_RUNTIME_TARGET_MS,
    checks: [],
    summary: { findings: 0, critical: 0, error: 0, warning: 0 },
    exitCode: 2,
  };
}

/** Prints the report(s) as the arguments ask. */
export function emit(report: ReconcileReport, args: ReconcileArgs | null): void {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args?.json === '-') {
    process.stdout.write(json);
    return;
  }
  if (args?.json) writeFileSync(args.json, json, { mode: 0o600 });
  if (args?.quiet) {
    process.stdout.write(`${renderHuman(report).split('\n').slice(-3).join('\n')}\n`);
  } else {
    process.stdout.write(`${renderHuman(report)}\n`);
  }
}

if (require.main === module) {
  (async () => {
    let args: ReconcileArgs | null = null;
    try {
      args = parseReconcileArgs(process.argv.slice(2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      emit(failedReport('invalid arguments', null), null);
      process.exitCode = 2;
      return;
    }
    loadCliEnv();
    let pool: Pool | null = null;
    try {
      pool = new Pool({
        connectionString: requireEnv('DATABASE_ADMIN_URL'),
        max: 1,
        application_name: 'acc-billing-reconcile',
        connectionTimeoutMillis: 10_000,
      });
      pool.on('error', (error) => console.error(`database connection error: ${error.message}`));
      const client = await pool.connect();
      try {
        const report = await runReconcile(client, args);
        emit(report, args);
        process.exitCode = report.exitCode;
      } finally {
        client.release();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`billing:reconcile could not complete: ${message}`);
      emit(failedReport(message, args), args);
      process.exitCode = 2;
    } finally {
      await pool?.end().catch(() => undefined);
    }
  })();
}
