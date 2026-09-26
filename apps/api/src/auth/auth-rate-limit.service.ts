import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';

import { AppConfigService } from '../config/app-config.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { RedisKeyBuilder } from '../redis/redis-keys';

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the window resets. */
  readonly resetSeconds: number;
  /** True when Redis was unreachable and the documented policy was applied. */
  readonly degraded: boolean;
}

/**
 * Authentication rate limiting (`API.md` §5, `SECURITY.md`).
 *
 * Two independent buckets are consulted for every authentication attempt:
 *
 *   - one keyed by **source IP**, which contains a single host spraying many
 *     accounts;
 *   - one keyed by **account identifier**, which contains a distributed attack
 *     on one account that rotates its source addresses.
 *
 * Either bucket alone is trivially defeated; a refusal from *either* refuses the
 * attempt. The account bucket is keyed by a truncated SHA-256 of the identifier
 * rather than the address itself, so a dump of Redis keys is not a plain list of
 * the email addresses people have tried to log in with. It is unsalted — a
 * namespacing device, not a secrecy control — and is described as such.
 *
 * **A successful login clears the account bucket only** (Gate-B audit,
 * Blocker 4). It previously cleared the IP bucket too, so an attacker holding
 * any one valid account could interleave its own successful logins between
 * guesses against other accounts and spray from a single address without ever
 * reaching the IP limit.
 *
 * Two further buckets throttle the other unauthenticated credential paths:
 *
 *   - **refresh**, keyed by source IP. `/auth/refresh` is public by necessity
 *     (the access token has expired by the time it is called), so the general
 *     per-principal limiter never sees it.
 *   - **API-key failures**, keyed by source IP. Every presented API key costs a
 *     full Argon2id verification — against the real digest or the dummy one —
 *     before anything is known about the caller, so unthrottled garbage keys are
 *     a CPU and memory exhaustion vector. Only *failures* are counted, and the
 *     check runs before the verification, so a well-behaved integration is
 *     never slowed and a flooding address stops costing Argon2 work once it is
 *     over the limit.
 *
 * **Behaviour when Redis is unavailable: fail open, loudly.** Redis is an
 * accelerator and never a system of record (`DATABASE.md` §1); refusing all
 * logins because a cache is down converts a degraded dependency into a total
 * outage, and rate limiting is a throttle rather than the authentication
 * control itself — credentials still have to be correct, and every failure is
 * still audited. The choice is logged at `warn` on every degraded call and is
 * surfaced on the verdict so a caller can react. This is a documented, tested
 * decision rather than an accident of the client's error handling.
 */
@Injectable()
export class AuthRateLimitService {
  private readonly logger = new Logger(AuthRateLimitService.name);
  private readonly keys: RedisKeyBuilder;

  constructor(
    private readonly config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.keys = new RedisKeyBuilder(config.redis.keyPrefix);
  }

  /**
   * Makes a value safe to use as one Redis key segment.
   *
   * `RedisKeyBuilder` refuses a segment containing `:`, which an IPv6 address
   * always has — including the IPv4-mapped `::ffff:127.0.0.1` form Node reports
   * for a local connection. Without this, every IPv6 client would fail the key
   * build, and because that happens before the counter is touched, the effect
   * is not a degraded limiter but no limiter at all.
   */
  private static keySegment(value: string): string {
    return value.replace(/[:\s]/g, '-');
  }

  /** Hashes an account identifier so Redis never holds a list of attempted emails. */
  private accountKey(identifier: string): string {
    // Namespacing, not secrecy: 96 bits of SHA-256 keeps collisions negligible
    // without putting the address itself into a key.
    return createHash('sha256').update(identifier, 'utf8').digest('hex').slice(0, 24);
  }

  /**
   * Consumes one token from both buckets. The attempt is allowed only if both
   * permit it; the returned verdict reflects whichever is closest to its limit.
   */
  async consume(params: {
    ip: string | null;
    accountIdentifier: string | null;
  }): Promise<RateLimitVerdict> {
    const { authWindowSeconds: window, authMax: limit } = this.config.rateLimit;
    return this.count(() => this.bucketKeys(params), limit, window);
  }

  /** One `/auth/refresh` attempt from `ip`. */
  async consumeRefresh(ip: string | null): Promise<RateLimitVerdict> {
    const { authWindowSeconds: window, refreshMax: limit } = this.config.rateLimit;
    return this.count(
      () =>
        ip
          ? [this.keys.platform('ratelimit', 'refresh', 'ip', AuthRateLimitService.keySegment(ip))]
          : [],
      limit,
      window,
    );
  }

  /**
   * Whether `ip` has exhausted its API-key failure allowance. Read-only: the
   * allowance is spent by `recordApiKeyFailure`, never by a successful key.
   */
  async apiKeyFailuresExceeded(ip: string | null): Promise<RateLimitVerdict> {
    const { authWindowSeconds: window, apiKeyFailureMax: limit, enabled } = this.config.rateLimit;
    const open = (degraded: boolean): RateLimitVerdict => ({
      allowed: true,
      limit,
      remaining: limit,
      resetSeconds: 0,
      degraded,
    });
    if (!enabled || !ip) return open(false);
    try {
      const key = this.apiKeyFailureKey(ip);
      const [raw, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
      const used = Number(raw ?? 0);
      return {
        allowed: used < limit,
        limit,
        remaining: Math.max(0, limit - used),
        resetSeconds: ttl > 0 ? ttl : window,
        degraded: false,
      };
    } catch (error) {
      this.logger.warn(
        `api-key failure throttling degraded — Redis unavailable, allowing the attempt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return open(true);
    }
  }

  /** Spends one unit of `ip`'s API-key failure allowance. */
  async recordApiKeyFailure(ip: string | null): Promise<void> {
    if (!this.config.rateLimit.enabled || !ip) return;
    const { authWindowSeconds: window, apiKeyFailureMax: limit } = this.config.rateLimit;
    await this.count(() => [this.apiKeyFailureKey(ip)], limit, window);
  }

  private apiKeyFailureKey(ip: string): string {
    return this.keys.platform(
      'ratelimit',
      'apikey-fail',
      'ip',
      AuthRateLimitService.keySegment(ip),
    );
  }

  /** Increments every bucket; refuses when any is over `limit`. Fails open. */
  private async count(
    build: () => string[],
    limit: number,
    window: number,
  ): Promise<RateLimitVerdict> {
    if (!this.config.rateLimit.enabled) {
      return { allowed: true, limit, remaining: limit, resetSeconds: 0, degraded: false };
    }

    let buckets: string[];
    try {
      buckets = build();
    } catch (error) {
      // A key that cannot be built is a bug, not an attack. It must not become
      // a 500 on an authentication path.
      this.logger.warn(
        `auth rate limiting degraded — key construction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { allowed: true, limit, remaining: limit, resetSeconds: 0, degraded: true };
    }

    if (buckets.length === 0) {
      return { allowed: true, limit, remaining: limit, resetSeconds: 0, degraded: false };
    }

    try {
      const pipeline = this.redis.pipeline();
      for (const key of buckets) {
        pipeline.incr(key);
        pipeline.expire(key, window, 'NX');
        pipeline.ttl(key);
      }
      const results = await pipeline.exec();
      if (!results) throw new Error('redis pipeline returned no result');

      let worstRemaining = limit;
      let resetSeconds = window;
      let allowed = true;

      for (let b = 0; b < buckets.length; b += 1) {
        const countEntry = results[b * 3];
        const ttlEntry = results[b * 3 + 2];
        const count = Number(countEntry?.[1] ?? 0);
        const ttl = Number(ttlEntry?.[1] ?? window);

        const remaining = Math.max(0, limit - count);
        if (count > limit) allowed = false;
        if (remaining < worstRemaining) {
          worstRemaining = remaining;
          resetSeconds = ttl > 0 ? ttl : window;
        }
      }

      return { allowed, limit, remaining: worstRemaining, resetSeconds, degraded: false };
    } catch (error) {
      // Documented fail-open. Logged every time so a sustained outage is
      // visible rather than quietly removing a control.
      this.logger.warn(
        `auth rate limiting degraded — Redis unavailable, allowing the attempt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { allowed: true, limit, remaining: limit, resetSeconds: 0, degraded: true };
    }
  }

  private bucketKeys(params: { ip: string | null; accountIdentifier: string | null }): string[] {
    const keys: string[] = [];
    if (params.ip) {
      keys.push(
        this.keys.platform('ratelimit', 'auth', 'ip', AuthRateLimitService.keySegment(params.ip)),
      );
    }
    if (params.accountIdentifier) {
      keys.push(
        this.keys.platform('ratelimit', 'auth', 'acct', this.accountKey(params.accountIdentifier)),
      );
    }
    return keys;
  }

  /**
   * Clears the **account** bucket after a successful authentication.
   *
   * Never the IP bucket: a success proves the caller knows *this* account's
   * password, and says nothing about the other accounts the same address has
   * been guessing at.
   */
  async resetAccount(accountIdentifier: string | null): Promise<void> {
    if (!accountIdentifier) return;
    try {
      await this.redis.del(
        this.keys.platform('ratelimit', 'auth', 'acct', this.accountKey(accountIdentifier)),
      );
    } catch {
      // Nothing to do: the window will expire on its own.
    }
  }
}
