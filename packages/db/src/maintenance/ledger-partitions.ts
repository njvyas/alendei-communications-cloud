/**
 * `usage_ledger` partition maintenance (Phase 7 PR 7-1, migration `0050`,
 * `DECISIONS.md` §1zi OD-7-3, RQ-4, RQ-6).
 *
 * The database owns creation (`app_ledger_ensure_partitions`, SECURITY INVOKER
 * and executable only by the schema owner) and inspection
 * (`app_ledger_partition_report`, read-only). This module runs the first in its
 * own transaction and turns the second into a verdict.
 *
 * Partitions are created only by the schema owner: after every `db:migrate` and
 * by the operator command `db:ledger:partitions --ensure` (owner decision
 * 08-Nov-2026: invariant D of tenant-context-trust is kept without exception, so
 * no SECURITY DEFINER function creates partitions and the API never does). The
 * API's startup check is read-only. There is deliberately no timer or worker
 * (RQ-4).
 */

import type { ClientBase } from 'pg';

/** Months ahead each ensure run guarantees (current month + 24). */
export const LEDGER_PARTITION_MONTHS_AHEAD = 24;
/** Lock wait for the ensure run after `db:migrate` and by the operator command. */
export const LEDGER_PARTITION_ENSURE_LOCK_TIMEOUT_MS = 10_000;
/** Owner decision RQ-6: warning when headroom is below six months… */
export const LEDGER_PARTITION_WARNING_BELOW_MONTHS = 6;
/** …and critical when it is below two months. */
export const LEDGER_PARTITION_CRITICAL_BELOW_MONTHS = 2;

/** One row of `app_ledger_partition_report()`. */
export interface LedgerPartitionReportRow {
  readonly partitionName: string;
  /** First day of the partition's month; `null` for an unattached same-named table. */
  readonly rangeStart: string | null;
  readonly rangeEnd: string | null;
  readonly attached: boolean;
  readonly truncateGuarded: boolean;
  readonly rowGuarded: boolean;
  readonly rlsEnabled: boolean;
  readonly privilegesRestricted: boolean;
}

export type LedgerPartitionLevel = 'ok' | 'warning' | 'critical';

export interface LedgerPartitionVerdict {
  /** Contiguous months covered after the current month (0 when the current month is missing). */
  readonly headroomMonths: number;
  readonly currentMonthCovered: boolean;
  /** Months (YYYY-MM) missing between the first and the last attached partition. */
  readonly gaps: readonly string[];
  /** Attached partitions lacking any required protection. */
  readonly unprotected: readonly string[];
  /** Same-named tables that are not attached to `usage_ledger`. */
  readonly orphans: readonly string[];
  readonly level: LedgerPartitionLevel;
  readonly summary: string;
}

const monthKey = (year: number, month: number): string =>
  `${year}-${String(month + 1).padStart(2, '0')}`;

/** `YYYY-MM-DD` → absolute month index (year × 12 + month), from the string only. */
function monthIndex(date: string): number {
  const [y, m] = date.split('-').map(Number);
  return (y as number) * 12 + ((m as number) - 1);
}

/**
 * Evaluates a partition report against the current UTC month. Pure: no clock
 * or database access, so every rule is unit-tested.
 */
export function evaluateLedgerPartitions(
  report: readonly LedgerPartitionReportRow[],
  now: Date,
): LedgerPartitionVerdict {
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const attached = report.filter((r) => r.attached && r.rangeStart !== null);
  const months = new Set(attached.map((r) => monthIndex(r.rangeStart as string)));

  const currentMonthCovered = months.has(current);
  let headroomMonths = 0;
  if (currentMonthCovered) {
    while (months.has(current + headroomMonths + 1)) headroomMonths += 1;
  }

  const gaps: string[] = [];
  if (months.size > 0) {
    const first = Math.min(...months);
    const last = Math.max(...months);
    for (let m = first; m <= last; m += 1) {
      if (!months.has(m)) gaps.push(monthKey(Math.floor(m / 12), m % 12));
    }
  }

  const unprotected = attached
    .filter((r) => !(r.truncateGuarded && r.rowGuarded && r.rlsEnabled && r.privilegesRestricted))
    .map((r) => r.partitionName);
  const orphans = report.filter((r) => !r.attached).map((r) => r.partitionName);

  const critical =
    !currentMonthCovered ||
    headroomMonths < LEDGER_PARTITION_CRITICAL_BELOW_MONTHS ||
    gaps.length > 0 ||
    unprotected.length > 0 ||
    orphans.length > 0;
  const level: LedgerPartitionLevel = critical
    ? 'critical'
    : headroomMonths < LEDGER_PARTITION_WARNING_BELOW_MONTHS
      ? 'warning'
      : 'ok';

  const parts = [
    `headroom ${headroomMonths} month(s)${currentMonthCovered ? '' : ' (current month missing)'}`,
    `${attached.length} partition(s)`,
    gaps.length > 0 ? `gaps: ${gaps.join(', ')}` : 'no gaps',
    unprotected.length > 0 ? `unprotected: ${unprotected.join(', ')}` : 'all protected',
    orphans.length > 0 ? `orphans: ${orphans.join(', ')}` : 'no orphans',
  ];
  return {
    headroomMonths,
    currentMonthCovered,
    gaps,
    unprotected,
    orphans,
    level,
    summary: `usage_ledger partitions ${level}: ${parts.join('; ')}`,
  };
}

interface RawReportRow {
  partition_name: string;
  range_start: string | null;
  range_end: string | null;
  attached: boolean;
  truncate_guarded: boolean;
  row_guarded: boolean;
  rls_enabled: boolean;
  privileges_restricted: boolean;
}

/** Reads `app_ledger_partition_report()` (dates as text, so no time-zone conversion). */
export async function readLedgerPartitionReport(
  client: ClientBase,
): Promise<LedgerPartitionReportRow[]> {
  const { rows } = await client.query<RawReportRow>(
    `SELECT partition_name, range_start::text AS range_start, range_end::text AS range_end,
            attached, truncate_guarded, row_guarded, rls_enabled, privileges_restricted
       FROM app_ledger_partition_report()`,
  );
  return rows.map((r) => ({
    partitionName: r.partition_name,
    rangeStart: r.range_start,
    rangeEnd: r.range_end,
    attached: r.attached,
    truncateGuarded: r.truncate_guarded,
    rowGuarded: r.row_guarded,
    rlsEnabled: r.rls_enabled,
    privilegesRestricted: r.privileges_restricted,
  }));
}

/**
 * Runs `app_ledger_ensure_partitions(monthsAhead)` in its own transaction with
 * a bounded lock wait. Returns the number of partitions it created. Throws on
 * failure after rolling back, so nothing is left half-created (the routine
 * itself is all-or-nothing inside the transaction).
 */
export async function ensureLedgerPartitions(
  client: ClientBase,
  options: { monthsAhead?: number; lockTimeoutMs?: number } = {},
): Promise<number> {
  const monthsAhead = options.monthsAhead ?? LEDGER_PARTITION_MONTHS_AHEAD;
  const lockTimeoutMs = options.lockTimeoutMs ?? 2000;
  if (!Number.isInteger(monthsAhead) || monthsAhead < 0 || monthsAhead > 36) {
    throw new Error('monthsAhead must be an integer between 0 and 36');
  }
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new Error('lockTimeoutMs must be a positive integer');
  }
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${lockTimeoutMs}ms`]);
    const { rows } = await client.query<{ action: string }>(
      'SELECT action FROM app_ledger_ensure_partitions($1)',
      [monthsAhead],
    );
    await client.query('COMMIT');
    return rows.filter((r) => r.action === 'created').length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export interface LedgerPartitionMaintenanceResult {
  /** Partitions this run created; `null` when the ensure failed. */
  readonly created: number | null;
  /** The ensure failure, when there was one (the verdict is still computed). */
  readonly ensureError: string | null;
  readonly verdict: LedgerPartitionVerdict;
}

/**
 * The owner's maintenance run: ensure `monthsAhead` months, then verify. Used
 * after every `db:migrate` and by `db:ledger:partitions --ensure`. A failed
 * ensure (for example a lock wait that expired) is reported, not thrown: the
 * caller decides from the verdict, so a transient lock never fails a deploy that
 * still has ample, fully protected headroom.
 */
export async function ensureAndVerifyLedgerPartitions(
  client: ClientBase,
  options: { monthsAhead?: number; lockTimeoutMs?: number; now?: Date } = {},
): Promise<LedgerPartitionMaintenanceResult> {
  let created: number | null = null;
  let ensureError: string | null = null;
  try {
    created = await ensureLedgerPartitions(client, {
      monthsAhead: options.monthsAhead ?? LEDGER_PARTITION_MONTHS_AHEAD,
      lockTimeoutMs: options.lockTimeoutMs ?? LEDGER_PARTITION_ENSURE_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    ensureError = error instanceof Error ? error.message : String(error);
  }
  const verdict = evaluateLedgerPartitions(
    await readLedgerPartitionReport(client),
    options.now ?? new Date(),
  );
  return { created, ensureError, verdict };
}
