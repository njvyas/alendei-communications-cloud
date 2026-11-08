import { parseLedgerPartitionsArgs } from '../cli/ledger-partitions';
import {
  ensureAndVerifyLedgerPartitions,
  evaluateLedgerPartitions,
  LEDGER_PARTITION_ENSURE_LOCK_TIMEOUT_MS,
  LEDGER_PARTITION_CRITICAL_BELOW_MONTHS,
  LEDGER_PARTITION_MONTHS_AHEAD,
  LEDGER_PARTITION_WARNING_BELOW_MONTHS,
  type LedgerPartitionReportRow,
} from './ledger-partitions';

/** Phase 7 PR 7-1 — the partition verdict (RQ-6 thresholds) and the operator command's arguments. */

const NOW = new Date('2026-11-08T10:00:00Z');

function month(offset: number): string {
  const d = new Date(Date.UTC(2026, 10 + offset, 1));
  return d.toISOString().slice(0, 10);
}

function partition(
  offset: number,
  overrides: Partial<LedgerPartitionReportRow> = {},
): LedgerPartitionReportRow {
  const start = month(offset);
  return {
    partitionName: `usage_ledger_p${start.slice(0, 4)}${start.slice(5, 7)}`,
    rangeStart: start,
    rangeEnd: month(offset + 1),
    attached: true,
    truncateGuarded: true,
    rowGuarded: true,
    rlsEnabled: true,
    privilegesRestricted: true,
    ...overrides,
  };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => partition(from + i));

describe('evaluateLedgerPartitions', () => {
  it('pins the approved thresholds and the default horizon', () => {
    expect(LEDGER_PARTITION_WARNING_BELOW_MONTHS).toBe(6);
    expect(LEDGER_PARTITION_CRITICAL_BELOW_MONTHS).toBe(2);
    expect(LEDGER_PARTITION_MONTHS_AHEAD).toBe(24);
  });

  it('current month + 24 is ok with 24 months of headroom', () => {
    const v = evaluateLedgerPartitions(range(0, 24), NOW);
    expect(v).toMatchObject({ headroomMonths: 24, currentMonthCovered: true, level: 'ok' });
    expect(v.gaps).toEqual([]);
  });

  it('headroom below six months is a warning; six is ok', () => {
    expect(evaluateLedgerPartitions(range(0, 5), NOW).level).toBe('warning');
    expect(evaluateLedgerPartitions(range(0, 6), NOW).level).toBe('ok');
  });

  it('headroom below two months is critical; two is a warning', () => {
    expect(evaluateLedgerPartitions(range(0, 1), NOW).level).toBe('critical');
    expect(evaluateLedgerPartitions(range(0, 2), NOW).level).toBe('warning');
  });

  it('a missing current month is critical with zero headroom', () => {
    const v = evaluateLedgerPartitions(range(1, 24), NOW);
    expect(v).toMatchObject({ headroomMonths: 0, currentMonthCovered: false, level: 'critical' });
  });

  it('headroom counts only contiguous months; a gap is reported and critical', () => {
    const rows = [...range(0, 3), ...range(5, 24)];
    const v = evaluateLedgerPartitions(rows, NOW);
    expect(v.headroomMonths).toBe(3);
    expect(v.gaps).toEqual(['2027-03']);
    expect(v.level).toBe('critical');
  });

  it.each([['truncateGuarded'], ['rowGuarded'], ['rlsEnabled'], ['privilegesRestricted']] as const)(
    'a partition lacking %s is unprotected and critical',
    (flag) => {
      const rows = range(0, 24);
      rows[7] = partition(7, { [flag]: false });
      const v = evaluateLedgerPartitions(rows, NOW);
      expect(v.unprotected).toEqual([rows[7]!.partitionName]);
      expect(v.level).toBe('critical');
    },
  );

  it('an unattached same-named table is an orphan and critical', () => {
    const rows = [
      ...range(0, 24),
      partition(30, { attached: false, rangeStart: null, rangeEnd: null }),
    ];
    const v = evaluateLedgerPartitions(rows, NOW);
    expect(v.orphans).toEqual(['usage_ledger_p202905']);
    expect(v.level).toBe('critical');
  });

  it('an empty report is critical', () => {
    expect(evaluateLedgerPartitions([], NOW)).toMatchObject({
      headroomMonths: 0,
      currentMonthCovered: false,
      level: 'critical',
    });
  });

  it('uses the UTC month: 23:30 IST on the last day of a month is still that month', () => {
    // 2026-11-30T18:00Z is 01-Dec-2026 IST, but the ledger's month is UTC.
    const v = evaluateLedgerPartitions(range(0, 24), new Date('2026-11-30T18:00:00Z'));
    expect(v.headroomMonths).toBe(24);
  });
});

describe('parseLedgerPartitionsArgs', () => {
  it('accepts --check and --ensure [--months N]', () => {
    expect(parseLedgerPartitionsArgs(['--check'])).toEqual({ kind: 'check' });
    expect(parseLedgerPartitionsArgs(['--ensure'])).toEqual({ kind: 'ensure', monthsAhead: 24 });
    expect(parseLedgerPartitionsArgs(['--ensure', '--months', '30'])).toEqual({
      kind: 'ensure',
      monthsAhead: 30,
    });
  });

  it.each([
    [[]],
    [['--check', '--ensure']],
    [['--check', '--months', '3']],
    [['--ensure', '--months']],
    [['--ensure', '--months', '-1']],
    [['--ensure', '--months', '37']],
    [['--ensure', '--months', '2.5']],
    [['--ensure', '--force']],
  ])('refuses %j', (argv) => {
    expect(() => parseLedgerPartitionsArgs(argv)).toThrow();
  });
});

describe('ensureAndVerifyLedgerPartitions (the owner run after db:migrate and by the command)', () => {
  function client(opts: { ensureFails?: boolean; months?: number }) {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    return {
      calls,
      query: jest.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes('app_ledger_ensure_partitions')) {
          if (opts.ensureFails)
            throw new Error('permission denied for function app_ledger_ensure_partitions');
          return { rows: [{ action: 'created' }, { action: 'exists' }] };
        }
        if (text.includes('app_ledger_partition_report')) {
          return {
            rows: range(0, opts.months ?? 24).map((r) => ({
              partition_name: r.partitionName,
              range_start: r.rangeStart,
              range_end: r.rangeEnd,
              attached: true,
              truncate_guarded: true,
              row_guarded: true,
              rls_enabled: true,
              privileges_restricted: true,
            })),
          };
        }
        return { rows: [] };
      }),
    };
  }

  it('ensures 24 months under a 10 s lock timeout in its own transaction, then verifies', async () => {
    const c = client({});
    const result = await ensureAndVerifyLedgerPartitions(c as never, { now: NOW });
    expect(c.calls.map((x) => x.text.replace(/\s+/g, ' ').trim().split(' ')[0])).toEqual([
      'BEGIN',
      'SELECT',
      'SELECT',
      'COMMIT',
      'SELECT',
    ]);
    expect(c.calls[1]!.values).toEqual([`${LEDGER_PARTITION_ENSURE_LOCK_TIMEOUT_MS}ms`]);
    expect(c.calls[2]!.values).toEqual([24]);
    expect(result).toMatchObject({ created: 1, ensureError: null });
    expect(result.verdict.level).toBe('ok');
  });

  it('a failed ensure is rolled back and reported, and the verdict is still computed', async () => {
    const c = client({ ensureFails: true, months: 1 });
    const result = await ensureAndVerifyLedgerPartitions(c as never, { now: NOW });
    expect(c.calls.map((x) => x.text)).toContain('ROLLBACK');
    expect(result.created).toBeNull();
    expect(result.ensureError).toMatch(/permission denied/);
    expect(result.verdict.level).toBe('critical');
  });
});
