import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { AppConfigService } from '../../config/app-config.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { RedisKeyBuilder } from '../../redis/redis-keys';
import type { RateLimitVerdict } from '../../auth/auth-rate-limit.service';
import type { RateLimitClass } from './rate-limit.decorator';

/**
 * The three dimensions of a general bucket (`API.md` §5).
 *
 * Every one of them is **server-derived**, and the type is the first line of
 * that guarantee: there is no field here a caller could populate. `orgId` and
 * `principalId` come from the authenticated `RequestContext`, and
 * `endpointClass` from the matched route's own metadata.
 */
export interface RateLimitSubject {
  /** The request's resolved organization, or `null` for a principal with none. */
  readonly orgId: string | null;
  /** The authenticated user or API-key id. Never an identifier from the request. */
  readonly principalId: string;
  readonly endpointClass: RateLimitClass;
}

/**
 * General API rate limiting (`API.md` §5, Phase 1B.6.4).
 *
 * The counterpart to `AuthRateLimitService`, which is untouched: that one
 * protects the pre-authentication surface with two stricter buckets keyed by IP
 * and account, and this one protects everything *after* authentication, keyed by
 * `(org_id, principal, endpoint_class)`.
 *
 * ---
 *
 * **The same mechanism, deliberately.** `INCR` + `EXPIRE NX` + `TTL` through one
 * pipeline — a **fixed-window counter**, which is what the auth limiter has
 * always been despite `API.md` previously calling it a token bucket (corrected
 * in this phase). A second algorithm would mean two things to reason about at
 * three in the morning for no behavioural gain at this scale, and a token bucket
 * would need either Lua or a read-modify-write that is not atomic.
 *
 * The window's edge is the known cost: a caller can spend its budget at the end
 * of one window and again at the start of the next, so the true short-term peak
 * is up to twice the configured limit. That is acceptable for a throttle whose
 * job is to bound sustained load rather than to police bursts precisely, and it
 * is the same property the auth limiter already has.
 *
 * **Fail open, loudly.** Redis is an accelerator and never a system of record
 * (`DATABASE.md` §1). Refusing every authenticated request because a cache is
 * unreachable converts a degraded dependency into a total outage, and this is a
 * throttle rather than an authorization control — the request has already been
 * authenticated and will still be authorized. The decision is logged at `warn`
 * on every degraded call and flagged on the verdict, exactly as the auth
 * limiter does, and it is tested rather than assumed.
 *
 * **Keys are built by `RedisKeyBuilder` and nothing else**, so the deployment
 * prefix and the tenant namespace both apply without this class knowing about
 * either.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly keys: RedisKeyBuilder;

  constructor(
    private readonly config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.keys = new RedisKeyBuilder(config.redis.keyPrefix);
  }

  /** Consumes one token from this subject's bucket. */
  async consume(subject: RateLimitSubject): Promise<RateLimitVerdict> {
    const { defaultWindowSeconds: window, defaultMax: limit, enabled } = this.config.rateLimit;
    if (!enabled) {
      return { allowed: true, limit, remaining: limit, resetSeconds: 0, degraded: false };
    }

    let key: string;
    try {
      key = this.bucketKey(subject);
    } catch (error) {
      // A key that cannot be built is a bug in this service, not an attack, and
      // it must not become a 500 on every authenticated request.
      this.logger.warn(
        `rate limiting degraded — key construction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { allowed: true, limit, remaining: limit, resetSeconds: 0, degraded: true };
    }

    try {
      const results = await this.redis
        .pipeline()
        .incr(key)
        .expire(key, window, 'NX')
        .ttl(key)
        .exec();
      if (!results) throw new Error('redis pipeline returned no result');

      const count = Number(results[0]?.[1] ?? 0);
      const ttl = Number(results[2]?.[1] ?? window);

      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetSeconds: ttl > 0 ? ttl : window,
        degraded: false,
      };
    } catch (error) {
      this.logger.warn(
        `rate limiting degraded — Redis unavailable, allowing the request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { allowed: true, limit, remaining: limit, resetSeconds: 0, degraded: true };
    }
  }

  /**
   * The bucket key, built through `RedisKeyBuilder`.
   *
   * Two shapes, and which one applies is decided by whether the request
   * resolved an organization — never by anything the caller sent:
   *
   *     org-scoped   {prefix}:t:{orgId}:ratelimit:{class}:principal:{principalId}
   *     no org       {prefix}:platform:ratelimit:{class}:principal:{principalId}
   *
   * The second covers the handful of authenticated routes that are about the
   * caller rather than a tenant — `/auth/me`, `/auth/sessions` — where a
   * principal exists but no organization has been selected. Bucketing those
   * under `platform` keeps them limited without inventing a tenant for them, and
   * keeps them separate from any organization's budget.
   *
   * `principalId` is a UUID and `endpointClass` is one of two literals, so
   * neither can carry the `:` that `RedisKeyBuilder` refuses — the segment
   * sanitisation the auth limiter needs for IPv6 addresses has no equivalent
   * hazard here.
   */
  private bucketKey(subject: RateLimitSubject): string {
    const segments = ['ratelimit', subject.endpointClass, 'principal', subject.principalId];
    return subject.orgId
      ? this.keys.tenant(subject.orgId, ...segments)
      : this.keys.platform(...segments);
  }
}
