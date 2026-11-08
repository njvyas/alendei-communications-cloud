import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { evaluateLedgerPartitions, readLedgerPartitionReport } from '@acc/db';
import type { Pool } from 'pg';

import { APP_POOL } from '../database/database.tokens';
import { MetricsService } from '../observability/metrics.service';

/**
 * Phase 7 PR 7-1 — the read-only `usage_ledger` partition startup verification
 * (`DECISIONS.md` §1zi OD-7-3, RQ-4, RQ-6).
 *
 * Once, at application startup and never again (no timer, no worker): reads the
 * partition report through `app_ledger_partition_report()` and publishes the
 * headroom and protection gauges. It logs a warning below six months of
 * headroom and an error below two. A failure is counted and logged and never
 * stops startup.
 *
 * It creates nothing and touches no financial data. Partitions are created only
 * by the schema owner, after every `db:migrate` and by the operator command
 * `db:ledger:partitions --ensure` (owner decision 08-Nov-2026: no SECURITY
 * DEFINER function creates partitions). As `acc_app` it may execute only the
 * read-only report.
 */
@Injectable()
export class LedgerPartitionStartupCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(LedgerPartitionStartupCheck.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run(new Date());
  }

  /** One verification; exposed for tests. Never throws. */
  async run(now: Date): Promise<void> {
    let client;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.fail('could not connect for the ledger partition check', error);
      return;
    }
    try {
      const verdict = evaluateLedgerPartitions(await readLedgerPartitionReport(client), now);
      this.metrics.ledgerPartitionHeadroomMonths.set(verdict.headroomMonths);
      this.metrics.ledgerPartitionUnprotected.set(
        verdict.unprotected.length + verdict.orphans.length,
      );
      const message = `${verdict.summary}. Partitions are extended by db:migrate and by \`npm run db:ledger:partitions --workspace @acc/db -- --ensure\`.`;
      if (verdict.level === 'critical') this.logger.error(message);
      else if (verdict.level === 'warning') this.logger.warn(message);
      else this.logger.log(verdict.summary);
    } catch (error) {
      this.fail('usage_ledger partition check failed', error);
    } finally {
      client.release();
    }
  }

  private fail(msg: string, error: unknown): void {
    this.metrics.ledgerPartitionCheckFailures.inc();
    this.logger.error({ msg, error: error instanceof Error ? error.message : String(error) });
  }
}
