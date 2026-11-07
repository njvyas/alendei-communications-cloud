/**
 * Phase 5.0 PR-C — rate limiting for the public webhook ingress (design spec Rev 2 §E.3
 * steps 1 and 3; AC-RL-1). The general `RateLimitGuard` passes every unauthenticated
 * request through, so the ingress has its own limiter.
 *
 * Two stages, fixed windows in Redis (the `RateLimitService` mechanism: INCR + EXPIRE NX +
 * TTL in one pipeline):
 *   1. `beforeResolution(ip)` — a global bucket and a per-source-IP bucket, consumed BEFORE
 *      the key is hashed or looked up, so a flood of unknown or garbage keys costs one
 *      Redis round trip and never a database query;
 *   2. `afterResolution(providerId, ip)` — a per-provider and a per-provider-and-IP bucket.
 * The source IP is Express's `req.ip`, which honours `TRUSTED_PROXY_HOPS`. Buckets are keyed
 * by a truncated SHA-256 of it: IPv6 addresses contain ':' (not allowed in a key segment),
 * and raw client addresses stay out of Redis key names.
 *
 * Fails open, loudly, on a Redis error — the platform policy for every limiter (Redis is an
 * accelerator, never a system of record): the request is still authenticated by its key
 * and signature, and the failure is logged on every degraded call.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { AppConfigService } from '../config/app-config.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { RedisKeyBuilder } from '../redis/redis-keys';

export interface WebhookRateVerdict {
  readonly allowed: boolean;
  /** The bucket that refused, for the metric and log (never the IP or the key). */
  readonly bucket?: 'global' | 'ip' | 'provider' | 'provider_ip';
  readonly retryAfterSeconds?: number;
}

@Injectable()
export class WebhookRateLimiter {
  private readonly logger = new Logger(WebhookRateLimiter.name);
  private readonly keys: RedisKeyBuilder;

  constructor(
    private readonly config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.keys = new RedisKeyBuilder(config.redis.keyPrefix);
  }

  /** Stage 1: before any key handling. */
  beforeResolution(ip: string): Promise<WebhookRateVerdict> {
    const limits = this.config.delivery.rateLimit;
    return this.consume([
      ['global', this.keys.platform('webhook-ingress', 'global'), limits.globalMax],
      ['ip', this.keys.platform('webhook-ingress', 'ip', ipKey(ip)), limits.ipMax],
    ]);
  }

  /** Stage 2: after the key resolved to a provider. */
  afterResolution(providerId: string, ip: string): Promise<WebhookRateVerdict> {
    const limits = this.config.delivery.rateLimit;
    return this.consume([
      [
        'provider',
        this.keys.platform('webhook-ingress', 'provider', providerId),
        limits.providerMax,
      ],
      [
        'provider_ip',
        this.keys.platform('webhook-ingress', 'provider-ip', providerId, ipKey(ip)),
        limits.providerIpMax,
      ],
    ]);
  }

  private async consume(
    buckets: ReadonlyArray<readonly [NonNullable<WebhookRateVerdict['bucket']>, string, number]>,
  ): Promise<WebhookRateVerdict> {
    const window = this.config.delivery.rateLimit.windowSeconds;
    try {
      const pipeline = this.redis.pipeline();
      for (const [, key] of buckets) pipeline.incr(key).expire(key, window, 'NX').ttl(key);
      const results = await pipeline.exec();
      if (!results) throw new Error('redis pipeline returned no result');
      for (let i = 0; i < buckets.length; i += 1) {
        const [bucket, , limit] = buckets[i]!;
        const count = Number(results[i * 3]?.[1] ?? 0);
        const ttl = Number(results[i * 3 + 2]?.[1] ?? window);
        if (count > limit) {
          return { allowed: false, bucket, retryAfterSeconds: ttl > 0 ? ttl : window };
        }
      }
      return { allowed: true };
    } catch (error) {
      this.logger.warn(
        `webhook ingress rate limiting degraded — Redis unavailable, allowing the request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { allowed: true };
    }
  }
}

/** A Redis-safe, non-reversible bucket key for a source address. */
function ipKey(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}
