import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { Pool } from 'pg';

import { APP_POOL, AUTH_POOL } from '../database/database.tokens';
import { MetricsService } from '../observability/metrics.service';

/**
 * Readiness check for PostgreSQL: the correctness boundary. If it is
 * unreachable the instance cannot serve correctly and must not receive traffic.
 */
@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    @Inject(APP_POOL) private readonly appPool: Pool,
    @Inject(AUTH_POOL) private readonly authPool: Pool,
    private readonly health: HealthIndicatorService,
    private readonly metrics: MetricsService,
  ) {}

  async check(key = 'postgres') {
    const indicator = this.health.check(key);
    try {
      await Promise.all([this.appPool.query('SELECT 1'), this.authPool.query('SELECT 1')]);

      this.metrics.dbPoolConnections.set({ status: 'total' }, this.appPool.totalCount);
      this.metrics.dbPoolConnections.set({ status: 'idle' }, this.appPool.idleCount);
      this.metrics.dbPoolConnections.set({ status: 'waiting' }, this.appPool.waitingCount);

      return indicator.up({
        pool: {
          total: this.appPool.totalCount,
          idle: this.appPool.idleCount,
          waiting: this.appPool.waitingCount,
        },
      });
    } catch (error) {
      return indicator.down({
        // Readiness output is unauthenticated (`API.md` §2), so it carries a
        // reason class rather than the driver's message.
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
