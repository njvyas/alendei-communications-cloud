import type { MetricsService } from '../observability/metrics.service';
import { LedgerPartitionStartupCheck } from './ledger-partition-startup.check';

/**
 * Phase 7 PR 7-1 — the read-only ledger partition startup verification (DECISIONS.md §1zi RQ-4,
 * RQ-6; owner decision 08-Nov-2026): exactly one statement, the report; gauges set; never throws;
 * never creates a partition, opens a transaction or touches the billing schema.
 */

function reportRows(months: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: months + 1 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10 + i, 1));
    const n = new Date(Date.UTC(2026, 11 + i, 1));
    return {
      partition_name: `usage_ledger_p${d.toISOString().slice(0, 7).replace('-', '')}`,
      range_start: d.toISOString().slice(0, 10),
      range_end: n.toISOString().slice(0, 10),
      attached: true,
      truncate_guarded: true,
      row_guarded: true,
      rls_enabled: true,
      privileges_restricted: true,
      ...(i === 3 ? overrides : {}),
    };
  });
}

function harness(
  options: {
    reportFails?: boolean;
    connectFails?: boolean;
    months?: number;
    overrides?: Record<string, unknown>;
  } = {},
) {
  const texts: string[] = [];
  const client = {
    query: jest.fn(async (text: string) => {
      texts.push(text.replace(/\s+/g, ' ').trim());
      if (options.reportFails) throw new Error('report failed');
      return { rows: reportRows(options.months ?? 24, options.overrides) };
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => {
      if (options.connectFails) throw new Error('connection refused');
      return client;
    }),
  };
  const metrics = {
    ledgerPartitionHeadroomMonths: { set: jest.fn() },
    ledgerPartitionUnprotected: { set: jest.fn() },
    ledgerPartitionCheckFailures: { inc: jest.fn() },
  };
  const check = new LedgerPartitionStartupCheck(
    pool as never,
    metrics as unknown as MetricsService,
  );
  return { check, texts, client, metrics };
}

const NOW = new Date('2026-11-08T10:00:00Z');

describe('LedgerPartitionStartupCheck (read-only)', () => {
  it('runs exactly one statement, the read-only report, and sets the gauges', async () => {
    const h = harness();
    await h.check.run(NOW);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toMatch(/^SELECT .* FROM app_ledger_partition_report\(\)$/);
    expect(h.metrics.ledgerPartitionHeadroomMonths.set).toHaveBeenCalledWith(24);
    expect(h.metrics.ledgerPartitionUnprotected.set).toHaveBeenCalledWith(0);
    expect(h.metrics.ledgerPartitionCheckFailures.inc).not.toHaveBeenCalled();
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  it('never creates partitions, opens a transaction or touches the billing schema', async () => {
    const h = harness();
    await h.check.run(NOW);
    for (const text of h.texts) {
      expect(text).not.toMatch(
        /\b(BEGIN|COMMIT|app_ledger_ensure_partitions|app_ledger_post|usage_ledger|wallets|credit_accounts|set_config)\b/i,
      );
    }
  });

  it('reports low headroom and an unprotected partition in the gauges', async () => {
    const h = harness({ months: 4, overrides: { truncate_guarded: false } });
    await h.check.run(NOW);
    expect(h.metrics.ledgerPartitionHeadroomMonths.set).toHaveBeenCalledWith(4);
    expect(h.metrics.ledgerPartitionUnprotected.set).toHaveBeenCalledWith(1);
  });

  it('a failed report is counted and never throws', async () => {
    const h = harness({ reportFails: true });
    await expect(h.check.run(NOW)).resolves.toBeUndefined();
    expect(h.metrics.ledgerPartitionCheckFailures.inc).toHaveBeenCalledTimes(1);
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  it('a failed connection is counted and never throws', async () => {
    const h = harness({ connectFails: true });
    await expect(h.check.run(NOW)).resolves.toBeUndefined();
    expect(h.metrics.ledgerPartitionCheckFailures.inc).toHaveBeenCalledTimes(1);
  });
});
