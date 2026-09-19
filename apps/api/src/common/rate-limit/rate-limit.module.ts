import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';

/**
 * General API rate limiting (`API.md` §5, Phase 1B.6.4).
 *
 * Global, because a throttle applied per module is one a new module can forget:
 * registering the guard here means every authenticated route is limited by
 * default and an exception would have to be written deliberately.
 *
 * **Import order matters and is load-bearing.** `AppModule` imports this
 * *after* `AuthModule`, so `RateLimitGuard` runs after `AuthGuard` and sees a
 * resolved principal. Moving it earlier would not fail loudly — it would
 * silently limit nothing, because a request with no principal is passed
 * through. `rate-limit.sec-spec.ts` asserts the limiter actually engages, which
 * is what would catch that.
 *
 * `REDIS_CLIENT` and `AppConfigService` arrive from `@Global()` modules;
 * `AuthRateLimitService` is untouched and keeps its own separate buckets.
 */
@Global()
@Module({
  providers: [RateLimitService, { provide: APP_GUARD, useClass: RateLimitGuard }],
  exports: [RateLimitService],
})
export class RateLimitModule {}
