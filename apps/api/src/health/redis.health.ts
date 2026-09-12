import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Readiness check for Redis.
 *
 * Redis is an accelerator, never a system of record (`DATABASE.md` §1), so its
 * absence degrades performance rather than correctness. It is reported so the
 * degradation is visible, and deliberately does not fail readiness on its own.
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly health: HealthIndicatorService,
  ) {}

  async check(key = 'redis') {
    const indicator = this.health.check(key);
    try {
      const reply = await this.redis.ping();
      return indicator.up({ ping: reply, role: 'accelerator' });
    } catch (error) {
      return indicator.up({
        ping: 'unavailable',
        role: 'accelerator',
        degraded: true,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
