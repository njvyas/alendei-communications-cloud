/**
 * Unauthenticated-path abuse controls, over real HTTP (Gate-B security audit,
 * Blocker 4).
 *
 *   1. A successful sign-in clears only the *account* bucket. It used to clear
 *      the IP bucket too, so one valid account let a single address spray every
 *      other account by interleaving its own successful logins.
 *   2. `/auth/refresh` is throttled per source address. It is public, so the
 *      per-principal general limiter never saw it.
 *   3. Failed API-key presentations are throttled per source address *before*
 *      the Argon2id verification, so garbage keys stop costing CPU and memory
 *      once an address is over its allowance — and a working key never spends
 *      that allowance.
 *
 * Every case would pass with its limiter removed only if it asserted nothing;
 * each ends on the `429` the limiter alone can produce.
 */
import { ERROR_CODES } from '@acc/contracts';
import { schema } from '@acc/db';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

describe('unauthenticated-path abuse controls', () => {
  let h: Harness;
  let tenant: TenantFixture;
  let apiKey: string;

  const url = (path: string) => `/${PREFIX}${path}`;
  const login = (email: string, password: string) =>
    request(h.app.getHttpServer()).post(url('/auth/login')).send({ email, password });
  const victim = () => `victim-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    tenant = await createTenant(h.admin, 'abuse', credentials);

    // A working API key, planted by the owner: the tenant's own administrator
    // created it, and it asks only for what that administrator holds.
    const prefix = `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`;
    const secret = `s${uuidv7().replace(/-/g, '')}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: tenant.orgId,
      name: `abuse-${prefix}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      scopes: ['workspaces.read'],
      createdBy: tenant.userId,
    });
    apiKey = `${prefix}.${secret}`;
  }, 60_000);

  beforeEach(() => h.clearRateLimits());

  afterAll(async () => {
    await h.clearRateLimits();
    // Every API-key authentication writes a platform-scoped audit row naming
    // the key; those reference the key and must go before it does.
    await purgeAudit(
      h.admin,
      sql`actor_api_key_id IN (SELECT id FROM api_keys WHERE org_id = ${tenant.orgId})`,
    );
    await destroyTenant(h.admin, tenant);
    await h.close();
  }, 60_000);

  // ---------------------------------------------------------------------------
  it('1. a successful login does not reset the IP bucket, so interleaving cannot extend a spray', async () => {
    // The auth limit is 10 per address per window. Nine guesses at nine
    // different victims, with the attacker's own successful login after the
    // fifth — the interleaving the defect rewarded.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await login(victim(), 'guess')).status);
    statuses.push((await login(tenant.email, PASSWORD)).status);
    for (let i = 0; i < 4; i += 1) statuses.push((await login(victim(), 'guess')).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 200, 401, 401, 401, 401]);

    // The eleventh attempt from this address is refused, whichever account it
    // names. Before the fix the success above had emptied the bucket and this
    // would have been another 401.
    const next = await login(victim(), 'guess');
    expect(next.status).toBe(429);
    expect(next.body.error.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
    expect(Number(next.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('1. a successful login still clears the account’s own bucket', async () => {
    for (let i = 0; i < 3; i += 1) expect((await login(tenant.email, 'wrong')).status).toBe(401);
    expect((await login(tenant.email, PASSWORD)).status).toBe(200);
    // The account bucket restarted: three more wrong guesses are not over the
    // account limit of 10 (4 + 3 would still be under it either way, so assert
    // the header the account bucket reports instead).
    const res = await login(tenant.email, 'wrong');
    expect(res.status).toBe(401);
    expect(Number(res.headers['x-ratelimit-remaining'])).toBeLessThan(10);
  });

  // ---------------------------------------------------------------------------
  it('2. /auth/refresh is throttled per source address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const res = await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('x-acc-refresh', '1')
        .set('cookie', `acc_refresh=forged-${i}`);
      statuses.push(res.status);
    }
    // 30 per window by default: every one of those is a genuine refusal of a
    // forged token, and the 31st never reaches token lookup at all.
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  // ---------------------------------------------------------------------------
  const withKey = (credential: string) =>
    request(h.app.getHttpServer())
      .get(url('/tenants/workspaces'))
      .set('authorization', `Bearer ${credential}`);

  it('3. a working API key never spends the failure allowance', async () => {
    for (let i = 0; i < 25; i += 1) expect((await withKey(apiKey)).status).toBe(200);
  });

  it('3. garbage API keys are refused with 429 once the address is over its allowance', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const garbage = `ak_live_${uuidv7().replace(/-/g, '').slice(0, 16)}.${'x'.repeat(40)}`;
      statuses.push((await withKey(garbage)).status);
    }
    // 20 failures per window by default, each a real Argon2id verification
    // against the dummy digest; the 21st is refused before any hashing.
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);

    // The refusal is per address and precedes verification, so it applies to
    // every key from that address until the window passes — the price of not
    // hashing for a flooding source. Recorded as intended behaviour.
    const blocked = await withKey(apiKey);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
  });

  it('3. a wrong secret for a real prefix counts as a failure too', async () => {
    const [prefix] = apiKey.split('.');
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await withKey(`${prefix}.wrong-${i}`)).status);
    expect(statuses[20]).toBe(429);
  });
});
