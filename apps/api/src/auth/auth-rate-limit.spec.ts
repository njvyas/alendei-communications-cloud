import { AuthRateLimitService } from './auth-rate-limit.service';

const config = {
  redis: { keyPrefix: 'acc' },
  rateLimit: { enabled: true, authWindowSeconds: 60, authMax: 3 },
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
    del: () => Promise.resolve(1),
  };
}

const brokenRedis = {
  pipeline() {
    throw new Error('ECONNREFUSED');
  },
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

  it('does not throw from reset when Redis is unavailable', async () => {
    const svc = new AuthRateLimitService(config, brokenRedis as never);
    await expect(
      svc.reset({ ip: '198.51.100.1', accountIdentifier: 'a@b.test' }),
    ).resolves.toBeUndefined();
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
