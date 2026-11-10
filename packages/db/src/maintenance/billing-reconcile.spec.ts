import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { failedReport, parseReconcileArgs } from '../cli/billing-reconcile';
import {
  RECONCILE_DEFAULTS,
  evaluateBalances,
  evaluateMessages,
  exitCodeFor,
  partitionFindings,
  renderHuman,
  type AnchorRow,
  type CheckResult,
  type ReconcileReport,
} from './billing-reconcile';
import { evaluateLedgerPartitions, type LedgerPartitionReportRow } from './ledger-partitions';

/** Phase 7 PR 7-7a — `billing:reconcile`: the pure parts (handover §4–§6). */

const ORG = '0193a000-0000-7000-8000-000000000001';
const M = '0193a000-0000-7000-8000-0000000000a1';
const A1 = '0193a000-0000-7000-8000-0000000000b1';
const A2 = '0193a000-0000-7000-8000-0000000000b2';
const NOW = new Date('2026-11-10T12:00:00Z');

function anchor(over: Partial<AnchorRow>): AnchorRow {
  return {
    message_id: M,
    org_id: ORG,
    status: 'accepted',
    policy: 'charge_per_logical_message',
    created_at: '2026-11-10T00:00:00Z',
    anchor_id: M,
    anchor_kind: 'message',
    attempt_number: null,
    reached: null,
    price: null,
    cost: null,
    reservation: null,
    charge: null,
    charge_note: null,
    release: null,
    provider_cost: null,
    resolution_action: null,
    resolution_attempt_id: null,
    resolution_posts_cost: null,
    resolution_cost: null,
    ...over,
  };
}
const ids = (fs: readonly { id: string }[]) => fs.map((f) => f.id).sort();

describe('arguments', () => {
  it('defaults are the approved ones', () => {
    expect(parseReconcileArgs([])).toEqual({
      orgs: null,
      since: null,
      staleHours: 24,
      statementTimeoutMs: 120_000,
      json: null,
      quiet: false,
    });
    expect(RECONCILE_DEFAULTS).toMatchObject({ staleHours: 24, statementTimeoutMs: 120_000 });
  });

  it('accepts repeated organisations, a month, thresholds, JSON and quiet', () => {
    expect(
      parseReconcileArgs([
        '--org',
        ORG,
        '--org',
        M.toUpperCase(),
        '--since',
        '2026-10',
        '--stale-hours',
        '48',
        '--statement-timeout-ms',
        '5000',
        '--json',
        '-',
        '--quiet',
      ]),
    ).toEqual({
      orgs: [ORG, M],
      since: '2026-10',
      staleHours: 48,
      statementTimeoutMs: 5000,
      json: '-',
      quiet: true,
    });
  });

  it.each([
    [['--org', 'nope']],
    [['--org']],
    [['--since', '2026-13']],
    [['--since', '2026-1']],
    [['--stale-hours', '0']],
    [['--stale-hours', 'x']],
    [['--statement-timeout-ms', '0']],
    [['--json']],
    [['--ensure']],
    [['--check']],
  ])('refuses %j', (argv) => {
    expect(() => parseReconcileArgs(argv as string[])).toThrow(/usage: npm run billing:reconcile/);
  });
});

describe('exit codes', () => {
  const check = (status: CheckResult['status'], findings = 0): CheckResult => ({
    id: 'C-1',
    title: 't',
    status,
    durationMs: 0,
    findings: Array.from({ length: findings }, (_, i) => ({
      id: `C-1:r:${i}`,
      check: 'C-1',
      rule: 'r',
      severity: 'warning',
      orgId: null,
      subject: {},
      expected: 0,
      actual: 1,
      detail: '',
    })),
    info: {},
  });
  it('0 clean, 1 any finding (warnings included), 2 could not complete', () => {
    expect(exitCodeFor([check('pass'), check('pass')], true)).toBe(0);
    expect(exitCodeFor([check('pass'), check('findings', 1)], true)).toBe(1);
    expect(exitCodeFor([check('findings', 1), check('error')], true)).toBe(2);
    expect(exitCodeFor([check('pass')], false)).toBe(2);
  });
});

describe('C-1 balances', () => {
  it('derives wallet and credit fields from the ledger; operator charges do not draw on the reservation', () => {
    const ok = evaluateBalances(
      [
        {
          account_id: 'w',
          org_id: ORG,
          balance: '880',
          reserved: '30',
          recharged: '1000',
          charged: '120',
          auto_charged: '70',
          reserved_in: '150',
          released: '50',
        },
      ],
      [
        {
          account_id: 'c',
          org_id: ORG,
          used: '120',
          reserved: '0',
          charged: '120',
          auto_charged: '120',
          reserved_in: '120',
          released: '0',
        },
      ],
    );
    expect(ok).toEqual([]);
    const drift = evaluateBalances(
      [
        {
          account_id: 'w',
          org_id: ORG,
          balance: '881',
          reserved: '31',
          recharged: '1000',
          charged: '120',
          auto_charged: '70',
          reserved_in: '150',
          released: '50',
        },
      ],
      [
        {
          account_id: 'c',
          org_id: ORG,
          used: '119',
          reserved: '1',
          charged: '120',
          auto_charged: '120',
          reserved_in: '120',
          released: '0',
        },
      ],
    );
    expect(ids(drift)).toEqual([
      'C-1:credit_reserved:c/credit_account',
      'C-1:credit_used:c/credit_account',
      'C-1:wallet_balance:w/wallet',
      'C-1:wallet_reserved:w/wallet',
    ]);
    expect(drift.find((f) => f.rule === 'wallet_balance')).toMatchObject({
      expected: 880,
      actual: 881,
      severity: 'error',
    });
  });
});

describe('C-2, C-3, C-4 messages', () => {
  it('a correctly settled accepted per-message chain has no findings', () => {
    const rows = [
      anchor({ price: '50', reservation: '50', charge: '50', release: null }),
      anchor({
        anchor_id: A1,
        anchor_kind: 'attempt',
        attempt_number: 1,
        reached: true,
        cost: '20',
        provider_cost: '20',
      }),
    ];
    const e = evaluateMessages(rows, NOW, 24);
    expect([...e.c2, ...e.c3, ...e.c4]).toEqual([]);
  });

  it('per attempt: every reached attempt is charged its E_a; others are not', () => {
    const base = { policy: 'charge_per_attempt' };
    const rows = [
      anchor({ ...base, reservation: '120' }),
      anchor({
        ...base,
        anchor_id: A1,
        anchor_kind: 'attempt',
        attempt_number: 1,
        reached: true,
        price: '60',
        cost: '20',
        charge: '60',
        provider_cost: '20',
      }),
      anchor({
        ...base,
        anchor_id: A2,
        anchor_kind: 'attempt',
        attempt_number: 2,
        reached: true,
        price: '60',
        cost: '20',
        charge: '60',
        provider_cost: '20',
      }),
    ];
    expect(evaluateMessages(rows, NOW, 24).c2).toEqual([]);
    rows[2] = { ...rows[2]!, charge: null };
    const e = evaluateMessages(rows, NOW, 24);
    expect(ids(e.c2)).toEqual([`C-2:charge_mismatch:${A2}`, `C-2:outstanding_reservation:${M}`]);
  });

  it('failed: any charge is unexpected; unknown: operator charges need an executed charge resolution', () => {
    const failed = evaluateMessages(
      [anchor({ status: 'failed', price: '50', reservation: '50', charge: '50' })],
      NOW,
      24,
    );
    expect(ids(failed.c2)).toEqual([`C-2:unexpected_charge:${M}`]);
    const unknown = evaluateMessages(
      [
        anchor({
          status: 'outcome_unknown',
          price: '50',
          reservation: '50',
          release: '50',
          charge: '50',
          charge_note: 'outcome_unknown_resolved',
        }),
      ],
      NOW,
      24,
    );
    expect(ids(unknown.c2)).toEqual([`C-2:unauthorised_operator_charge:${M}`]);
    const resolved = evaluateMessages(
      [
        anchor({
          status: 'outcome_unknown',
          price: '50',
          reservation: '50',
          release: '50',
          charge: '50',
          charge_note: 'outcome_unknown_resolved',
          resolution_action: 'charge',
          resolution_attempt_id: A1,
          resolution_posts_cost: true,
          resolution_cost: '20',
        }),
        anchor({
          status: 'outcome_unknown',
          anchor_id: A1,
          anchor_kind: 'attempt',
          attempt_number: 1,
          reached: false,
          cost: '20',
          provider_cost: '20',
          resolution_action: 'charge',
          resolution_attempt_id: A1,
          resolution_posts_cost: true,
          resolution_cost: '20',
        }),
      ],
      NOW,
      24,
    );
    expect([...resolved.c2, ...resolved.c3]).toEqual([]);
  });

  it('C-3: cost on reached attempts only; C-4: stale only past the threshold', () => {
    const e = evaluateMessages(
      [
        anchor({ status: 'failed', reservation: '50', release: '50', price: '50' }),
        anchor({
          status: 'failed',
          anchor_id: A1,
          anchor_kind: 'attempt',
          attempt_number: 1,
          reached: true,
          cost: '20',
        }),
        anchor({
          status: 'failed',
          anchor_id: A2,
          anchor_kind: 'attempt',
          attempt_number: 2,
          reached: false,
          cost: '20',
          provider_cost: '20',
        }),
      ],
      NOW,
      24,
    );
    expect(ids(e.c3)).toEqual([
      `C-3:provider_cost_mismatch:${A1}`,
      `C-3:unexpected_provider_cost:${A2}`,
    ]);
    const young = evaluateMessages(
      [anchor({ status: 'queued', reservation: '50', created_at: '2026-11-09T13:00:00Z' })],
      NOW,
      24,
    );
    expect(young.c4).toEqual([]);
    const old = evaluateMessages(
      [anchor({ status: 'queued', reservation: '50', created_at: '2026-11-09T11:00:00Z' })],
      NOW,
      24,
    );
    expect(ids(old.c4)).toEqual([`C-4:stale_reservation:${M}`]);
    expect(old.c4[0]).toMatchObject({ severity: 'warning', actual: 50 });
  });
});

describe('C-5 partitions (A-10: thresholds with a shifted clock)', () => {
  const months = (from: string, count: number): LedgerPartitionReportRow[] => {
    const [y, m] = from.split('-').map(Number) as [number, number];
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(Date.UTC(y, m - 1 + i, 1));
      const e = new Date(Date.UTC(y, m + i, 1));
      const s = (x: Date) => x.toISOString().slice(0, 10);
      return {
        partitionName: `usage_ledger_p${s(d).slice(0, 7).replace('-', '')}`,
        rangeStart: s(d),
        rangeEnd: s(e),
        attached: true,
        truncateGuarded: true,
        rowGuarded: true,
        rlsEnabled: true,
        privilegesRestricted: true,
      };
    });
  };
  it('ok, warning below 6 months, critical below 2, current month missing', () => {
    const report = months('2026-11', 25);
    expect(partitionFindings(evaluateLedgerPartitions(report, NOW), NOW)).toEqual([]);
    const later = new Date('2028-08-15T00:00:00Z'); // 3 months of headroom left
    expect(ids(partitionFindings(evaluateLedgerPartitions(report, later), later))).toEqual([
      'C-5:headroom:usage_ledger',
    ]);
    expect(partitionFindings(evaluateLedgerPartitions(report, later), later)[0]!.severity).toBe(
      'warning',
    );
    const last = new Date('2028-10-15T00:00:00Z'); // 1 month left
    expect(partitionFindings(evaluateLedgerPartitions(report, last), last)[0]!.severity).toBe(
      'critical',
    );
    const gone = new Date('2029-02-15T00:00:00Z');
    expect(ids(partitionFindings(evaluateLedgerPartitions(report, gone), gone))).toEqual([
      'C-5:current_month_missing:2029-02',
    ]);
  });
  it('gaps, unprotected partitions and orphans are errors with stable ids', () => {
    const report = months('2026-11', 25);
    report.splice(3, 1);
    report[5] = { ...report[5]!, truncateGuarded: false };
    report.push({
      ...report[0]!,
      partitionName: 'usage_ledger_p209901',
      attached: false,
      rangeStart: null,
      rangeEnd: null,
    });
    expect(ids(partitionFindings(evaluateLedgerPartitions(report, NOW), NOW))).toEqual([
      'C-5:gap:2027-02',
      // The gap also ends the contiguous headroom after two months: a warning.
      'C-5:headroom:usage_ledger',
      'C-5:orphan:usage_ledger_p209901',
      `C-5:unprotected:${report[5]!.partitionName}`,
    ]);
  });
});

describe('reports', () => {
  it('the JSON report is versioned and complete in shape; a failed start is exit 2, marked incomplete', () => {
    const r: ReconcileReport = failedReport('connection refused', null);
    expect(Object.keys(r).sort()).toEqual(
      [
        'checks',
        'command',
        'complete',
        'database',
        'durationMs',
        'error',
        'exitCode',
        'finishedAt',
        'migrationProof',
        'readOnly',
        'reportVersion',
        'runtimeTargetMs',
        'scope',
        'snapshotAt',
        'startedAt',
        'summary',
        'transactionIdAssigned',
      ].sort(),
    );
    expect(r).toMatchObject({ reportVersion: 1, complete: false, exitCode: 2, readOnly: true });
    const text = renderHuman(r);
    expect(text).toMatch(/INCOMPLETE: connection refused/);
    expect(text).toMatch(/exit code 2/);
  });
  it('the human report shows each check status, finding ids and the runtime target', () => {
    const r: ReconcileReport = {
      ...failedReport('x', null),
      complete: true,
      error: null,
      exitCode: 1,
      scope: { orgs: [ORG], since: null, staleHours: 24, statementTimeoutMs: 120000 },
      durationMs: 1234,
      checks: [
        {
          id: 'C-1',
          title: 'Account balances equal the ledger',
          status: 'pass',
          durationMs: 1,
          findings: [],
          info: { wallets: 1 },
        },
        {
          id: 'C-4',
          title: 'Stale open reservations',
          status: 'findings',
          durationMs: 1,
          info: {},
          findings: [
            {
              id: `C-4:stale_reservation:${M}`,
              check: 'C-4',
              rule: 'stale_reservation',
              severity: 'warning',
              orgId: ORG,
              subject: { message: M },
              expected: 0,
              actual: 50,
              detail: 'd',
            },
          ],
        },
        {
          id: 'C-6',
          title: 'Unknown-outcome register (listing only)',
          status: 'pass',
          durationMs: 1,
          findings: [],
          info: { count: 2, byStatus: { open: 2 } },
        },
      ],
    };
    const text = renderHuman(r);
    expect(text).toMatch(/C-1 Account balances equal the ledger: PASS/);
    expect(text).toMatch(new RegExp(`WARNING C-4:stale_reservation:${M}`));
    expect(text).toMatch(/2 unknown-outcome item\(s\): open 2 \(listing only; never a finding\)/);
    expect(text).toMatch(/target per organisation: 60000 ms, met/);
  });
});

describe('R-4: the reconcile sources contain no write path', () => {
  const strip = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const sources = ['./billing-reconcile.ts', '../cli/billing-reconcile.ts'].map((p) =>
    strip(readFileSync(resolve(__dirname, p), 'utf8')),
  );
  it.each([
    /\bINSERT\b/i,
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bTRUNCATE\b/i,
    /\bMERGE\b/i,
    /\bCOPY\b/,
    /\bCREATE\b/i,
    /\bALTER\b/i,
    /\bDROP\b/i,
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /set_config/i,
    /app_ledger_ensure_partitions/,
    /ensureAndVerifyLedgerPartitions/,
    /app_ledger_post/,
    /app_billing_(account_(request|approve|reject|execute|note)|resolution_|resolve_)/,
  ])('%s', (pattern) => {
    for (const source of sources) expect(source).not.toMatch(pattern);
  });
  it('opens exactly one READ ONLY transaction', () => {
    expect(sources[0]).toContain("'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'");
    expect(sources[0]).toContain('txid_current_if_assigned()');
  });
});
