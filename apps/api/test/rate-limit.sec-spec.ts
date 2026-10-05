/**
 * General API rate limiting (Phase 1B.6.4, `API.md` §5).
 *
 * The limiter buckets by `(org_id, principal, endpoint_class)`, and every one of
 * those three comes from server-side state: the first two from the authenticated
 * `RequestContext`, the third from the matched route's own metadata. **Nothing a
 * caller sends can select its bucket**, which is the property that separates a
 * throttle from a suggestion — and most of this suite exists to prove it by
 * trying.
 *
 * The isolation cases are driven with **real authenticated identities** rather
 * than by computing keys, so they assert the behaviour a tenant experiences
 * rather than the string the implementation happens to build. Where a key's
 * shape genuinely is the property under test, the key is discovered from Redis
 * rather than hardcoded, so the assertion cannot quietly stop matching.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import type Redis from 'ioredis';

import { CredentialService } from '../src/iam/credential.service';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

describe('general rate limiting', () => {
  let h: Harness;
  let credentials: CredentialService;
  let redis: Redis;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let limit: number;
  const plantedUsers: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    redis = h.app.get(REDIS_CLIENT) as Redis;

    orgA = await createTenant(h.admin, 'rl-a', credentials);
    orgB = await createTenant(h.admin, 'rl-b', credentials);
    await grant(orgA, [PERMISSIONS.USERS_READ, PERMISSIONS.WORKSPACES_READ]);
    await grant(orgB, [PERMISSIONS.USERS_READ, PERMISSIONS.WORKSPACES_READ]);

    tokenA = await tokenFor(orgA.email);
    tokenB = await tokenFor(orgB.email);

    // The configured ceiling, read from a real response rather than from the
    // environment, so the suite tests what the application actually applies.
    const probe = await get(tokenA, '/auth/me');
    limit = Number(probe.headers['x-ratelimit-limit']);
    expect(limit).toBeGreaterThan(0);
  }, 90_000);

  afterAll(async () => {
    await purgeAudit(h.admin, sql`true`);
    for (const id of plantedUsers) {
      await h.admin.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
      await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${id}`);
      await h.admin.execute(sql`DELETE FROM users WHERE id = ${id}`);
    }
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  // Each case starts from empty buckets, so "remaining" is deterministic and a
  // previous case cannot make a later one pass or fail for the wrong reason.
  beforeEach(() => clearGeneralBuckets());
  afterEach(() => purgeAudit(h.admin, sql`true`));

  // --- helpers -----------------------------------------------------------------

  async function grant(tenant: TenantFixture, permissions: readonly string[]): Promise<void> {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      for (const key of permissions) {
        const [permission] = await tx
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(eq(schema.permissions.key, key));
        if (permission) {
          await tx
            .insert(schema.rolePermissions)
            .values({ roleId: tenant.roleId, permissionId: permission.id })
            .onConflictDoNothing();
        }
      }
    });
  }

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  /** Every general bucket, regardless of tenant or class. */
  async function clearGeneralBuckets(): Promise<void> {
    const keys = await redis.keys('*ratelimit*');
    const general = keys.filter((k) => !k.includes(':ratelimit:auth:'));
    if (general.length > 0) await redis.del(...general);
  }

  const get = (token: string, path: string, headers: Record<string, string> = {}) => {
    const req = request(h.app.getHttpServer())
      .get(url(path))
      .set('authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req;
  };

  const remainingOf = (res: request.Response) => Number(res.headers['x-ratelimit-remaining']);

  /**
   * Pushes a bucket to its ceiling by discovering the key Redis actually holds.
   *
   * Discovery rather than reconstruction: a test that rebuilt the key string
   * would keep passing if the implementation changed its key shape, which is the
   * one thing this file most needs to notice.
   */
  async function exhaust(match: string): Promise<string> {
    // Filtered in JavaScript rather than globbed: the tenant namespace precedes
    // `ratelimit:` in the key (`{prefix}:t:{orgId}:ratelimit:…`), so a pattern
    // that assumed an ordering would quietly match nothing.
    const keys = await redis.keys('*ratelimit*');
    const general = keys.filter((k) => !k.includes(':ratelimit:auth:') && k.includes(match));
    expect(general).toHaveLength(1);
    await redis.incrby(general[0]!, limit);
    return general[0]!;
  }

  // ===========================================================================
  // The limiter actually engages
  // ===========================================================================
  it('engages on authenticated requests and decrements a real bucket', async () => {
    // Guards the whole suite: a limiter registered in the wrong order would see
    // no principal and silently limit nothing, and every isolation case below
    // would then pass for the wrong reason.
    const first = await get(tokenA, '/auth/me').expect(200);
    const second = await get(tokenA, '/auth/me').expect(200);

    expect(remainingOf(first)).toBe(limit - 1);
    expect(remainingOf(second)).toBe(limit - 2);
    expect(Number(first.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });

  // ===========================================================================
  // A/B/C — isolation across all three key dimensions
  // ===========================================================================
  it('case A — one organization cannot consume another’s bucket', async () => {
    for (let i = 0; i < 3; i += 1) await get(tokenA, '/auth/me').expect(200);
    const a = await get(tokenA, '/auth/me').expect(200);
    const b = await get(tokenB, '/auth/me').expect(200);

    expect(remainingOf(a)).toBe(limit - 4);
    // Organization B is untouched by A's four requests.
    expect(remainingOf(b)).toBe(limit - 1);
  });

  it('case B — principals within one organization have independent buckets', async () => {
    const second = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'organization',
      orgA.orgId,
      'rl-p2',
    );
    plantedUsers.push(second.userId);
    const tokenP2 = await tokenFor(second.email);
    await clearGeneralBuckets();

    for (let i = 0; i < 3; i += 1) await get(tokenA, '/auth/me').expect(200);
    const p1 = await get(tokenA, '/auth/me').expect(200);
    const p2 = await get(tokenP2, '/auth/me').expect(200);

    expect(remainingOf(p1)).toBe(limit - 4);
    expect(remainingOf(p2)).toBe(limit - 1);
  });

  it('case C — read and write buckets are independent', async () => {
    for (let i = 0; i < 3; i += 1) await get(tokenA, '/users').expect(200);
    const read = await get(tokenA, '/users').expect(200);

    // A write by the same principal in the same organization. It fails
    // validation, which is irrelevant — the guard runs before the handler, so
    // the bucket is charged either way, and that is what is being measured.
    const write = await request(h.app.getHttpServer())
      .post(url('/users'))
      .set('authorization', `Bearer ${tokenA}`)
      .send({});

    expect(remainingOf(read)).toBe(limit - 4);
    expect(remainingOf(write)).toBe(limit - 1);
  });

  // ===========================================================================
  // D/E — headers and exhaustion
  // ===========================================================================
  it('case D — every response carries the three documented headers', async () => {
    const res = await get(tokenA, '/auth/me').expect(200);
    expect(res.headers['x-ratelimit-limit']).toBe(String(limit));
    expect(res.headers['x-ratelimit-remaining']).toBe(String(limit - 1));
    // Seconds until the window resets, in the same unit as Retry-After.
    const reset = Number(res.headers['x-ratelimit-reset']);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(60);
  });

  it('case E — an exhausted bucket is 429 with Retry-After and the standard envelope', async () => {
    // `/users` is organization-scoped, so this exercises the tenant-namespaced
    // key shape rather than the platform one.
    await get(tokenA, '/users').expect(200);
    await exhaust(orgA.orgId);

    const res = await get(tokenA, '/users').expect(429);

    expect(res.body.error.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
    // The frozen envelope, unchanged: `error` with the documented keys.
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(res.body.error.retryable).toBe(true);
    expect(res.body.error.correlationId).toBeTruthy();

    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    // Retry-After and X-RateLimit-Reset describe the same instant.
    expect(retryAfter).toBe(Number(res.headers['x-ratelimit-reset']));
    expect(res.body.error.details.retryAfterSeconds).toBe(retryAfter);
    expect(remainingOf(res)).toBe(0);
  });

  it('case E — exhausting one bucket leaves the others serving', async () => {
    await get(tokenA, '/users').expect(200);
    await exhaust(orgA.orgId);

    await get(tokenA, '/users').expect(429);
    // Another organization, and another class for the same principal.
    await get(tokenB, '/users').expect(200);
    await request(h.app.getHttpServer())
      .post(url('/users'))
      .set('authorization', `Bearer ${tokenA}`)
      .send({})
      .expect(400);
  });

  // ===========================================================================
  // F — no caller-supplied dimension can select a bucket
  // ===========================================================================
  it('case F — spoofed identity headers cannot move the caller to a fresh bucket', async () => {
    const baseline = await get(tokenA, '/auth/me').expect(200);
    expect(remainingOf(baseline)).toBe(limit - 1);

    const spoofs: Record<string, string>[] = [
      { 'x-tenant-id': orgB.orgId },
      { 'x-organization-id': orgB.orgId },
      { 'x-principal-id': uuidv7() },
      { 'x-ratelimit-limit': '999999' },
      { 'x-ratelimit-remaining': '999999' },
      { 'x-ratelimit-reset': '0' },
      { 'x-ratelimit-bypass': 'true' },
      { 'x-endpoint-class': 'read' },
    ];

    let expected = limit - 1;
    for (const headers of spoofs) {
      expected -= 1;
      const res = await get(tokenA, '/auth/me', headers).expect(200);
      // The counter keeps descending: every spoof landed in the same bucket.
      expect(remainingOf(res)).toBe(expected);
      // And the server's own values are returned, not the ones sent.
      expect(res.headers['x-ratelimit-limit']).toBe(String(limit));
    }
  });

  it('case F — query and body identifiers cannot select a bucket', async () => {
    const baseline = await get(tokenA, '/auth/me').expect(200);
    let expected = remainingOf(baseline);

    for (const query of [
      `?orgId=${orgB.orgId}`,
      `?endpointClass=read`,
      `?principalId=${uuidv7()}`,
    ]) {
      expected -= 1;
      // `/auth/me` ignores unknown query parameters; the point is the bucket.
      const res = await get(tokenA, `/auth/me${query}`).expect(200);
      expect(remainingOf(res)).toBe(expected);
    }
  });

  it('case F — an endpoint class cannot be forged onto a route', async () => {
    // A write route stays a write bucket however the caller labels it. Charge
    // the write bucket once, then attempt to relabel it as a read.
    const first = await request(h.app.getHttpServer())
      .post(url('/users'))
      .set('authorization', `Bearer ${tokenA}`)
      .send({});
    const second = await request(h.app.getHttpServer())
      .post(url('/users'))
      .set('authorization', `Bearer ${tokenA}`)
      .set('x-endpoint-class', 'read')
      .set('x-ratelimit-class', 'read')
      .send({});

    expect(remainingOf(second)).toBe(remainingOf(first) - 1);
  });

  it('case F — a forwarded-for value cannot change the general bucket', async () => {
    // The general limiter does not key on IP at all, so this is asserting the
    // absence of a dimension rather than the correctness of one. It is the
    // reason mutation G is structurally not applicable here: there is nothing
    // IP-derived to corrupt. `TRUSTED_PROXY_HOPS` continues to govern the auth
    // limiter, which does key on IP.
    const baseline = await get(tokenA, '/auth/me').expect(200);
    let expected = remainingOf(baseline);

    for (const forwarded of ['203.0.113.1', '198.51.100.7, 203.0.113.1', '::1']) {
      expected -= 1;
      const res = await get(tokenA, '/auth/me', { 'x-forwarded-for': forwarded }).expect(200);
      expect(remainingOf(res)).toBe(expected);
    }
  });

  // ===========================================================================
  // G — API keys
  // ===========================================================================
  it('case G — an API key is bucketed by its own identity, not its creator’s', async () => {
    const secret = `secret-${uuidv7()}`;
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: orgA.orgId,
      name: `rl-key-${prefix}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      createdBy: orgA.userId,
      scopes: [PERMISSIONS.USERS_READ],
    });
    const credential = `${prefix}.${secret}`;
    await clearGeneralBuckets();

    // The creator spends four requests.
    for (let i = 0; i < 4; i += 1) await get(tokenA, '/users').expect(200);
    const creator = await get(tokenA, '/users').expect(200);
    // The key it created has its own budget — the same separation the binding
    // scope already gives it for authorization.
    const key = await get(credential, '/users').expect(200);

    expect(remainingOf(creator)).toBe(limit - 5);
    expect(remainingOf(key)).toBe(limit - 1);

    await purgeAudit(h.admin, sql`true`);
    await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${prefix}`);
  });

  // ===========================================================================
  // H — the authentication limiter is untouched and still independent
  // ===========================================================================
  it('case H — public auth endpoints are not charged to the general limiter', async () => {
    await clearGeneralBuckets();

    const login = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: orgA.email, password: PASSWORD });

    // Auth endpoints carry their own bucket and no general one: no general
    // header, and no general key created.
    expect(login.headers['x-ratelimit-reset']).toBeUndefined();
    const keys = await redis.keys('*ratelimit*');
    expect(keys.filter((k) => !k.includes(':ratelimit:auth:'))).toEqual([]);
  });

  it('case H — AuthRateLimitService remains independently effective', async () => {
    await h.clearRateLimits();
    await clearGeneralBuckets();

    // Drive the auth bucket to refusal with wrong passwords. The general
    // limiter plays no part: login resolves no principal.
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: orgA.email, password: 'wrong-password-entirely' });
      statuses.push(res.status);
      if (res.status === 429) break;
    }
    expect(statuses).toContain(429);

    // The refusal came from the auth buckets, and no general bucket exists.
    const keys = await redis.keys('*ratelimit*');
    expect(keys.some((k) => k.includes(':ratelimit:auth:'))).toBe(true);
    expect(keys.filter((k) => !k.includes(':ratelimit:auth:'))).toEqual([]);

    await h.clearRateLimits();
  });

  it('case H — no request is charged to both limiters', async () => {
    await h.clearRateLimits();
    await clearGeneralBuckets();

    // One successful login, then one authenticated request.
    const token = await tokenFor(orgA.email);
    await clearGeneralBuckets();
    await get(token, '/auth/me').expect(200);

    const keys = await redis.keys('*ratelimit*');
    const general = keys.filter((k) => !k.includes(':ratelimit:auth:'));
    // Exactly one general bucket, created by the authenticated request only.
    expect(general).toHaveLength(1);
    expect(Number(await redis.get(general[0]!))).toBe(1);
  });

  // ===========================================================================
  // I — Redis failure
  // ===========================================================================
  it('case I — a Redis outage fails open rather than refusing traffic', async () => {
    const failure = new Error('redis unavailable');
    const spy = jest.spyOn(redis, 'pipeline').mockImplementation(
      () =>
        ({
          incr: () => ({
            expire: () => ({ ttl: () => ({ exec: () => Promise.reject(failure) }) }),
          }),
        }) as never,
    );

    try {
      // The API keeps serving. A throttle that cannot be evaluated must not
      // become an outage (`API.md` §5) — the request is still authenticated and
      // still authorized.
      const res = await get(tokenA, '/auth/me').expect(200);
      // Headers still describe the configured ceiling, with nothing consumed.
      expect(res.headers['x-ratelimit-limit']).toBe(String(limit));
      expect(remainingOf(res)).toBe(limit);
    } finally {
      spy.mockRestore();
    }

    // And it recovers without intervention once Redis returns.
    const after = await get(tokenA, '/auth/me').expect(200);
    expect(remainingOf(after)).toBeLessThan(limit);
  });

  // ===========================================================================
  // J — metrics carry no tenant identity
  // ===========================================================================
  it('case J — no tenant or principal identifier reaches a metric label', async () => {
    await get(tokenA, '/users').expect(200);
    await get(tokenB, '/users').expect(200);

    const metrics = await request(h.app.getHttpServer()).get('/metrics').expect(200);
    const body = metrics.text;

    for (const identifier of [orgA.orgId, orgB.orgId, orgA.userId, orgB.userId]) {
      expect(body).not.toContain(identifier);
    }
    for (const label of ['org_id=', 'tenant_id=', 'principal_id=']) {
      expect(body).not.toContain(label);
    }
  });

  // ===========================================================================
  // Key shape — asserted from what Redis actually holds
  // ===========================================================================
  it('the bucket key carries the organization, the principal and the class', async () => {
    await get(tokenA, '/users').expect(200);

    const keys = await redis.keys('*ratelimit*');
    const general = keys.filter((k) => !k.includes(':ratelimit:auth:'));
    expect(general).toHaveLength(1);
    const key = general[0]!;

    // All three dimensions present, under the deployment prefix and the tenant
    // namespace `RedisKeyBuilder` applies.
    expect(key).toContain(`t:${orgA.orgId}`);
    expect(key).toContain('ratelimit:read:principal:');
    expect(key).toContain(orgA.userId);
    expect(key.startsWith(`${process.env.REDIS_KEY_PREFIX ?? 'acc'}:`)).toBe(true);
  });

  it('a principal with no resolved organization is bucketed at platform scope', async () => {
    /**
     * Both key shapes, and the routes that produce them.
     *
     * `/auth/me` carries `@NoTenantContext()`: it is about the caller rather
     * than a tenant, so `AuthGuard` resolves a principal with `orgId = null`.
     * That is the case §3 of the approved design reserves the platform bucket
     * for — a principal that must still be limited but has no organization to
     * charge. `/users` is ordinary organization-scoped traffic.
     *
     * The two must land in **different** buckets: if the no-org case silently
     * fell back to some organization, one principal's identity work would draw
     * down a tenant's budget.
     */
    await get(tokenA, '/auth/me').expect(200);
    await get(tokenA, '/users').expect(200);

    const keys = await redis.keys('*ratelimit*');
    const general = keys.filter((k) => !k.includes(':ratelimit:auth:')).sort();
    expect(general).toHaveLength(2);

    const platform = general.find((k) => k.includes(':platform:ratelimit:'));
    const tenant = general.find((k) => k.includes(`:t:${orgA.orgId}:`));
    expect(platform).toBeDefined();
    expect(tenant).toBeDefined();

    // The platform bucket names the principal and the class, and no tenant.
    expect(platform).toContain(`ratelimit:read:principal:${orgA.userId}`);
    expect(platform).not.toContain(orgA.orgId);
    // The tenant bucket names all three.
    expect(tenant).toContain(`ratelimit:read:principal:${orgA.userId}`);
  });
});
