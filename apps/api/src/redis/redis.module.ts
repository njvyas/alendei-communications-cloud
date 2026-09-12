import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

import { AppConfigService } from '../config/app-config.service';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Redis is an accelerator only — cache, locks and rate-limit counters. It is
 * never a system of record (`DATABASE.md` §1), so nothing in the platform loses
 * correctness if it is unavailable.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Redis =>
        new Redis(config.redis.url, {
          // Fail fast rather than queueing: a caller waiting on an accelerator
          // is worse than one proceeding without it.
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
          lazyConnect: false,
          connectTimeout: 5_000,
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    // An unhandled 'error' event would crash the process; Redis being down is a
    // degraded state, not a fatal one.
    this.redis.on('error', (error: Error) => {
      this.logger.warn(`Redis error: ${error.message}`);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
    this.logger.log('Redis connection closed');
  }
}
