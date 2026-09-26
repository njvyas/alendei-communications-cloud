import { AuthRateLimitService } from './auth-rate-limit.service';

const config = {
  redis: { keyPrefix: 'acc' },
  rateLimit: {
    enabled: true,
    authWindowSeconds: 60,
    authMax: 3,
    refreshMax: 2,
    apiKeyFailureMax: 2,
  },
} as never;

/** A Redis stub whose pipeline returns increasing counters. */
function workingRedis() {
  const counts = new Map<string, number>();
  return {
    counts,
    pipeline() {
      const ops: string[] = [];
      const api = {
        incr(key: string) {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          ops.push(key);
          return api;
        },
        expire() {
          return api;
        },
        ttl() {
          return api;
        },
        exec() {
          return Promise.resolve(
            ops.flatMap((key) => [
              [null, counts.get(key)],
              [null, 1],
              [null, 60],
            ]),
          );
        },
      };
      return api;
    },
    get: (key: string) => Promise.resolve(counts.has(key) ? String(counts.get(key)) : null),
    ttl: () => Promise.resolve(60),
    del: (...keys: string[]) => {
      for (const key of keys) counts.delete(key);
      return Promise.resolve(keys.length);
    },
  };
}

const brokenRedis = {
  pipeline() {
    throw new Error('ECONNREFUSED');
  },
  get: () => Promise.reject(new Error('ECONNREFUSED')),
  ttl: () => Promise.reject(new Error('ECONNREFUSED')),
  del: () => Promise.reject(new Error('ECONNREFUSED')),
};

describe('AuthRateLimitService', () => {
  it('allows attempts up to the limit and refuses beyond it', async () => {
    const svc = new AuthRateLimitService(config, workingRedis() as never);
    const verdicts = [];
    for (let i = 0; i < 5; i += 1) {
      verdicts.push(await svc.consume({ ip: '198.51.100.1', accountIdentifier: 'a@b.test' }));
    }
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false, false]);
    expect(verdicts[0]!.remaining).toBe(2);
  });

  it('refuses when either bucket is exhausted, not only both', async () => {
    // The account bucket must contain an attacker rotating source addresses.
    const svc = new AuthRateLimitService(config, workingRedis() as never);
    for (let i = 0; i < 3; i += 1) {
      await svc.consume({ ip: `198.51.100.${i}`, accountIdentifier: 'victim@b.test' });
    }
    const next = await svc.consume({ ip: '198.51.100.99', accountIdentifier: 'victim@b.test' });
    expect(next.allowed).toBe(false);
  });

  it('contains a single address spraying many accounts', async () => {
    const svc = new AuthRateLimitService(config, workingRedis() as never);
    for (let i = 0; i < 3; i += 1) {
      await svc.consume({ ip: '203.0.113.7', accountIdentifier: `victim${i}@b.test` });
    }
    const next = await svc.consume({ ip: '203.0.113.7', accountIdentifier: 'victim99@b.test' });
    expect(next.allowed).toBe(false);
  });

  it('builds a usable key for an IPv6 address', async () => {
    // `RedisKeyBuilder` refuses ':' in a segment. Without normalization every
    // IPv6 client would fail the key build — which, because it happens before
    // the counter is touched, means no rate limiting at all rather than a
    // degraded one.
    const redis = workingRedis();
    const svc = new AuthRateLimitService(config, redis as never);
    const verdict = await svc.consume({
      ip: '::ffff:127.0.0.1',
      accountIdentifier: 'v6@b.test',
    });
    expect(verdict.degraded).toBe(false);
    expect([...redis.counts.keys()].some((k) => k.includes('ffff-127.0.0.1'))).toBe(true);
  });

  it('fails open and flags the verdict when Redis is unavailable', async () => {
    // Documented policy: Redis is an accelerator, never a system of record, so
    // an outage must not convert a degraded dependency into a total inability
    // to sign in. Credentials are still verified and every failure still
    // audited — the throttle is what is lost, not the control.
    const svc = new AuthRateLimitService(config, brokenRedis as never);
    const verdict = await svc.consume({ ip: '198.51.100.1', accountIdentifier: 'a@b.test' });
    expect(verdict.allowed).toBe(true);
    expect(verdict.degraded).toBe(true);
  });

  it('does not throw from resetAccount when Redis is unavailable', async () => {
    const svc = new AuthRateLimitService(config, brokenRedis as never);
    await expect(svc.resetAccount('a@b.test')).resolves.toBeUndefined();
  });

  /**
   * Gate-B audit, Blocker 4 — the regression this pins: a successful login used
   * to delete the IP bucket as well, so one valid account let a single address
   * spray every other account without ever reaching the IP limit.
   */
  it('resetAccount clears the account bucket and leaves the IP bucket intact', async () => {
    const redis = workingRedis();
    const svc = new AuthRateLimitService(config, redis as never);
    const ip = '198.51.100.9';

    // Two guesses against two different victims, then the attacker's own
    // successful login in between — the interleaving the defect rewarded.
    await svc.consume({ ip, accountIdentifier: 'victim-1@b.test' });
    await svc.consume({ ip, accountIdentifier: 'victim-2@b.test' });
    await svc.consume({ ip, accountIdentifier: 'attacker@b.test' });
    await svc.resetAccount('attacker@b.test');

    // The IP bucket still carries all three attempts: the next one is over the
    // limit of 3 regardless of which account it names.
    const next = await svc.consume({ ip, accountIdentifier: 'victim-3@b.test' });
    expect(next.allowed).toBe(false);
    const ipKeys = [...redis.counts.keys()].filter((k) => k.includes(':ip:'));
    expect(ipKeys).toHaveLength(1);
    expect(redis.counts.get(ipKeys[0]!)).toBe(4);
  });

  it('throttles /auth/refresh per source address', async () => {
    const svc = new AuthRateLimitService(config, workingRedis() as never);
    const verdicts = [];
    for (let i = 0; i < 4; i += 1) verdicts.push(await svc.consumeRefresh('203.0.113.4'));
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, false, false]);
    // A different address has its own allowance.
    expect((await svc.consumeRefresh('203.0.113.5')).allowed).toBe(true);
  });

  it('counts only API-key failures, and refuses once the allowance is spent', async () => {
    const svc = new AuthRateLimitService(config, workingRedis() as never);
    const ip = '203.0.113.7';
    expect((await svc.apiKeyFailuresExceeded(ip)).allowed).toBe(true);
    // Checking is free: any number of checks spends nothing.
    for (let i = 0; i < 5; i += 1) await svc.apiKeyFailuresExceeded(ip);
    expect((await svc.apiKeyFailuresExceeded(ip)).allowed).toBe(true);

    await svc.recordApiKeyFailure(ip);
    expect((await svc.apiKeyFailuresExceeded(ip)).allowed).toBe(true);
    await svc.recordApiKeyFailure(ip);
    const refused = await svc.apiKeyFailuresExceeded(ip);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect((await svc.apiKeyFailuresExceeded('203.0.113.8')).allowed).toBe(true);
  });

  it('fails open for the refresh and API-key buckets when Redis is unavailable', async () => {
    const svc = new AuthRateLimitService(config, brokenRedis as never);
    expect(await svc.consumeRefresh('203.0.113.4')).toMatchObject({
      allowed: true,
      degraded: true,
    });
    expect(await svc.apiKeyFailuresExceeded('203.0.113.4')).toMatchObject({
      allowed: true,
      degraded: true,
    });
    await expect(svc.recordApiKeyFailure('203.0.113.4')).resolves.toBeUndefined();
  });

  it('never uses the raw account identifier as a key segment', async () => {
    // A Redis key dump must not be a list of the addresses people tried.
    const redis = workingRedis();
    const svc = new AuthRateLimitService(config, redis as never);
    await svc.consume({ ip: '198.51.100.1', accountIdentifier: 'victim@example.test' });
    for (const key of redis.counts.keys()) {
      expect(key).not.toContain('victim@example.test');
      expect(key).not.toContain('victim');
    }
  });

  it('is inert when disabled', async () => {
    const svc = new AuthRateLimitService(
      {
        redis: { keyPrefix: 'acc' },
        rateLimit: { enabled: false, authWindowSeconds: 60, authMax: 1 },
      } as never,
      brokenRedis as never,
    );
    const verdict = await svc.consume({ ip: '1.1.1.1', accountIdentifier: 'a@b.test' });
    expect(verdict.allowed).toBe(true);
    expect(verdict.degraded).toBe(false);
  });
});
