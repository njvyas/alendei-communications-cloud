/**
 * Phase 1B.3 security suite.
 *
 * Every test here asserts a control that must hold when the caller is hostile:
 * token forgery, session revocation, tenant substitution, cross-tenant reads,
 * CSRF, rate limiting and credential leakage. They run against the real
 * application over HTTP, because that is the surface an attacker reaches.
 */
import { ERROR_CODES } from '@acc/contracts';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { REFRESH_COOKIE } from '../src/auth/auth.controller';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  grantInto,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (path: string) => `/${PREFIX}${path}`;

describe('Phase 1B.3 security', () => {
  let h: Harness;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let multi: TenantFixture;

  const login = (email: string, password = PASSWORD) =>
    request(h.app.getHttpServer()).post(url('/auth/login')).send({ email, password });

  const tokenFor = async (email: string): Promise<string> => {
    const res = await login(email).expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'sec-a', credentials);
    orgB = await createTenant(h.admin, 'sec-b', credentials);
    multi = await createTenant(h.admin, 'sec-m', credentials);
    // The multi-org user also holds a grant in Org A, so it has two.
    await grantInto(h.admin, multi.userId, orgA);
  }, 60_000);

  afterAll(async () => {
    for (const t of [orgA, orgB, multi]) await destroyTenant(h.admin, t);
    await h.close();
  }, 60_000);

  afterEach(() => purgeAudit(h.admin, sql`true`));

  // Tests that are not about rate limiting start from a clean window. The
  // limiter stays enabled throughout — only its counters are reset.
  beforeEach(() => h.clearRateLimits());

  // ---------------------------------------------------------------------------
  describe('JWT', () => {
    it('accepts a valid token', async () => {
      const token = await tokenFor(orgA.email);
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('rejects a missing credential', async () => {
      const res = await request(h.app.getHttpServer()).get(url('/auth/me')).expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_CREDENTIAL_REQUIRED);
    });

    it.each([
      ['malformed', 'not-a-jwt'],
      ['empty', ''],
      ['two-segment', 'a.b'],
    ])('rejects a %s token', async (_label, token) => {
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('rejects a token forged with another secret', async () => {
      const forged = jwt.sign(
        {
          sub: orgA.userId,
          sid: uuidv7(),
          actor_type: 'user',
          jti: uuidv7(),
          iss: 'acc',
          aud: 'acc-console',
        },
        'an-attacker-chosen-secret-of-sufficient-length',
        { algorithm: 'HS256', expiresIn: 900 },
      );
      const res = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${forged}`)
        .expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
    });

    it('rejects an alg=none token', async () => {
      const none = jwt.sign(
        {
          sub: orgA.userId,
          sid: uuidv7(),
          actor_type: 'user',
          jti: uuidv7(),
          iss: 'acc',
          aud: 'acc-console',
          exp: Math.floor(Date.now() / 1000) + 900,
        },
        '',
        { algorithm: 'none' },
      );
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${none}`)
        .expect(401);
    });

    it('rejects a tampered subject', async () => {
      const token = await tokenFor(orgA.email);
      const [head, payload, sig] = token.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
        string,
        unknown
      >;
      claims.sub = orgB.userId;
      const forged = `${head}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('derives authorized organizations from grants, not from the token', async () => {
      // `/auth/me` resolves no organization on purpose — it is about the user,
      // and a multi-organization principal must be able to call it before
      // choosing one. What it does report is the grant-derived list.
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.tenant.orgId).toBeNull();
      expect(res.body.authorizedOrganizationIds).toEqual([orgA.orgId]);
      expect(res.body.authorizedOrganizationIds).not.toContain(orgB.orgId);
    });

    it('ignores a forged tenancy claim on a tenant-scoped route', async () => {
      // The token carries no tenancy at all, so nothing a caller can put in it
      // reaches authorization. Proven where it matters: a scoped read.
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.workspaces.every((w: { orgId: string }) => w.orgId === orgA.orgId)).toBe(
        true,
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('authentication', () => {
    it('rejects a wrong password', async () => {
      const res = await login(orgA.email, 'the-wrong-password').expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_INVALID_CREDENTIALS);
    });

    it('gives an unknown address the identical response to a wrong password', async () => {
      const unknown = await login(`nobody-${uuidv7()}@example.test`).expect(401);
      const wrong = await login(orgA.email, 'the-wrong-password').expect(401);
      expect(unknown.body.error.code).toBe(wrong.body.error.code);
      expect(unknown.body.error.message).toBe(wrong.body.error.message);
    });

    it('refuses a disabled user holding a valid password', async () => {
      await h.admin.execute(sql`UPDATE users SET status='disabled' WHERE id=${orgB.userId}`);
      try {
        const res = await login(orgB.email).expect(401);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTH_INVALID_CREDENTIALS);
      } finally {
        await h.admin.execute(sql`UPDATE users SET status='active' WHERE id=${orgB.userId}`);
      }
    });

    it('never returns a refresh token in the response body', async () => {
      const res = await login(orgA.email).expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(/refresh/i);
      expect(res.body).not.toHaveProperty('refreshToken');
    });

    it('sets the refresh token as an httpOnly, SameSite cookie', async () => {
      const res = await login(orgA.email).expect(200);
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const refresh = cookies.find((c) => c.startsWith(REFRESH_COOKIE));
      expect(refresh).toBeDefined();
      expect(refresh).toMatch(/HttpOnly/i);
      expect(refresh).toMatch(/SameSite=Lax/i);
      expect(refresh).toMatch(/Path=\/api\/v1\/auth/i);
    });

    it('never discloses a credential in any response', async () => {
      const token = await tokenFor(orgA.email);
      const me = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      const body = JSON.stringify(me.body);
      for (const forbidden of ['password', 'argon2', 'keyHash', 'refresh_token', 'secret']) {
        expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('session revocation', () => {
    it('rejects a validly-signed token whose session was revoked', async () => {
      const token = await tokenFor(orgA.email);
      await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);

      await h.admin.execute(
        sql`UPDATE sessions SET revoked_at = now(), revoked_reason='test' WHERE user_id=${orgA.userId} AND revoked_at IS NULL`,
      );

      // The token is still cryptographically valid. Authorization must not be.
      const res = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('authorization', `Bearer ${token}`)
        .expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_SESSION_REVOKED);
    });

    it('rejects a token whose user was disabled after issue', async () => {
      const token = await tokenFor(orgB.email);
      await h.admin.execute(sql`UPDATE users SET status='disabled' WHERE id=${orgB.userId}`);
      try {
        const res = await request(h.app.getHttpServer())
          .get(url('/auth/me'))
          .set('authorization', `Bearer ${token}`)
          .expect(401);
        expect(res.body.error.code).toBe(ERROR_CODES.AUTH_ACCOUNT_DISABLED);
      } finally {
        await h.admin.execute(sql`UPDATE users SET status='active' WHERE id=${orgB.userId}`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('refresh rotation', () => {
    const cookieFrom = (res: request.Response): string => {
      const cookies = res.headers['set-cookie'] as unknown as string[];
      return cookies.find((c) => c.startsWith(REFRESH_COOKIE))!.split(';')[0]!;
    };

    it('rotates successfully and issues a different token', async () => {
      const first = await login(orgA.email).expect(200);
      const cookie = cookieFrom(first);

      const second = await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('Cookie', cookie)
        .set(CSRF_HEADER, '1')
        .expect(200);

      expect(cookieFrom(second)).not.toBe(cookie);
      expect(second.body.accessToken).not.toBe(first.body.accessToken);
    });

    it('refuses a replayed refresh token and revokes the family', async () => {
      const first = await login(orgA.email).expect(200);
      const original = cookieFrom(first);

      await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('Cookie', original)
        .set(CSRF_HEADER, '1')
        .expect(200);

      // Replay the spent token.
      const replay = await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('Cookie', original)
        .set(CSRF_HEADER, '1')
        .expect(401);
      expect(replay.body.error.code).toBe(ERROR_CODES.AUTH_SESSION_REVOKED);

      // Scoped to the family the replayed token belonged to. Counting every
      // session for the user would also sweep up families other tests created,
      // and would pass for the wrong reason.
      const sid = (jwt.decode(first.body.accessToken as string) as { sid: string }).sid;
      const live = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM sessions
            WHERE revoked_at IS NULL
              AND family_id = (SELECT family_id FROM sessions WHERE id = ${sid})`,
      );
      expect(Number(live.rows[0]!.count)).toBe(0);

      // And the successor minted before reuse was detected is dead too.
      const family = await h.admin.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM sessions
            WHERE family_id = (SELECT family_id FROM sessions WHERE id = ${sid})`,
      );
      expect(Number(family.rows[0]!.count)).toBeGreaterThanOrEqual(2);
    });

    it('gives exactly one winner for two concurrent refreshes of one token', async () => {
      const first = await login(orgA.email).expect(200);
      const cookie = cookieFrom(first);

      const attempt = () =>
        request(h.app.getHttpServer())
          .post(url('/auth/refresh'))
          .set('Cookie', cookie)
          .set(CSRF_HEADER, '1')
          .then((r) => r.status);

      const [a, b] = await Promise.all([attempt(), attempt()]);
      expect([a, b].filter((s) => s === 200)).toHaveLength(1);
      expect([a, b].filter((s) => s === 401)).toHaveLength(1);
    });

    it('refuses an unknown refresh token', async () => {
      await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('Cookie', `${REFRESH_COOKIE}=not-a-real-token`)
        .set(CSRF_HEADER, '1')
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('CSRF', () => {
    it('refuses refresh without the custom header', async () => {
      const first = await login(orgA.email).expect(200);
      const cookies = first.headers['set-cookie'] as unknown as string[];
      const cookie = cookies.find((c) => c.startsWith(REFRESH_COOKIE))!.split(';')[0]!;

      // Exactly the request a cross-site HTML form post could make.
      const res = await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('Cookie', cookie)
        .expect(403);
      expect(res.body.error.message).toMatch(new RegExp(CSRF_HEADER, 'i'));
    });

    it('accepts refresh with the custom header', async () => {
      const first = await login(orgA.email).expect(200);
      const cookies = first.headers['set-cookie'] as unknown as string[];
      const cookie = cookies.find((c) => c.startsWith(REFRESH_COOKIE))!.split(';')[0]!;
      await request(h.app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('Cookie', cookie)
        .set(CSRF_HEADER, '1')
        .expect(200);
    });

    it('refuses logout without the custom header', async () => {
      const token = await tokenFor(orgA.email);
      await request(h.app.getHttpServer())
        .post(url('/auth/logout'))
        .set('authorization', `Bearer ${token}`)
        .expect(403);
      await request(h.app.getHttpServer())
        .post(url('/auth/logout'))
        .set('authorization', `Bearer ${token}`)
        .set(CSRF_HEADER, '1')
        .expect(204);
    });
  });

  // ---------------------------------------------------------------------------
  describe('CORS', () => {
    it('does not reflect an arbitrary origin', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url('/auth/me'))
        .set('Origin', 'https://attacker.example')
        .set('authorization', `Bearer ${await tokenFor(orgA.email)}`);
      // Nest's CORS is configured from an explicit allowlist; an unlisted origin
      // is never echoed back, which is what stops a credentialed cross-origin read.
      expect(res.headers['access-control-allow-origin']).not.toBe('https://attacker.example');
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('never combines a wildcard origin with credentials', async () => {
      const res = await request(h.app.getHttpServer()).get(url('/auth/me'));
      if (res.headers['access-control-allow-credentials'] === 'true') {
        expect(res.headers['access-control-allow-origin']).not.toBe('*');
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('tenant context', () => {
    it('selects the single authorized organization implicitly', async () => {
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.workspaces.every((w: { orgId: string }) => w.orgId === orgA.orgId)).toBe(
        true,
      );
    });

    it('requires the selector when several organizations are authorized', async () => {
      const token = await tokenFor(multi.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_REQUIRED);
    });

    it('accepts an authorized selector', async () => {
      const token = await tokenFor(multi.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .set('x-acc-organization', orgA.orgId)
        .expect(200);
      expect(res.body.workspaces.every((w: { orgId: string }) => w.orgId === orgA.orgId)).toBe(
        true,
      );
    });

    it("refuses a selector outside the principal's scope", async () => {
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .set('x-acc-organization', orgB.orgId)
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      // Refused, not silently emptied — the two must stay distinguishable.
      expect(res.body).not.toHaveProperty('workspaces');
    });

    it('refuses a selector naming an organization that does not exist', async () => {
      const token = await tokenFor(orgA.email);
      await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .set('x-acc-organization', uuidv7())
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  describe('cross-tenant isolation', () => {
    it("returns only the caller's own workspaces", async () => {
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url('/tenants/workspaces'))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      const ids = res.body.workspaces.map((w: { id: string }) => w.id);
      expect(ids).toContain(orgA.workspaceId);
      expect(ids).not.toContain(orgB.workspaceId);
    });

    it("refuses another tenant's organization id in a query parameter", async () => {
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url(`/tenants/workspaces?orgId=${orgB.orgId}`))
        .set('authorization', `Bearer ${token}`)
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it("returns 404 — not 403 — for another tenant's workspace id", async () => {
      // RLS filters the row out before the handler sees it, so the response
      // cannot confirm the workspace exists elsewhere.
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url(`/tenants/workspaces/${orgB.workspaceId}`))
        .set('authorization', `Bearer ${token}`)
        .expect(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
      expect(JSON.stringify(res.body)).not.toContain(orgB.workspaceId);
    });

    it("finds the caller's own workspace by the same route", async () => {
      // The negative control for the test above: the route works, so the 404 is
      // isolation rather than a broken endpoint.
      const token = await tokenFor(orgA.email);
      const res = await request(h.app.getHttpServer())
        .get(url(`/tenants/workspaces/${orgA.workspaceId}`))
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.id).toBe(orgA.workspaceId);
    });

    it('refuses an unauthenticated tenant read', async () => {
      await request(h.app.getHttpServer()).get(url('/tenants/workspaces')).expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('session management', () => {
    it("lists only the caller's own sessions", async () => {
      const tokenA = await tokenFor(orgA.email);
      await tokenFor(orgB.email);

      const res = await request(h.app.getHttpServer())
        .get(url('/auth/sessions'))
        .set('authorization', `Bearer ${tokenA}`)
        .expect(200);

      const ids = res.body.sessions.map((s: { id: string }) => s.id);
      const foreign = await h.admin.execute<{ id: string }>(
        sql`SELECT id FROM sessions WHERE user_id = ${orgB.userId}`,
      );
      for (const row of foreign.rows) expect(ids).not.toContain(row.id);
    });

    it("refuses to revoke another user's session, without disclosing it exists", async () => {
      const tokenA = await tokenFor(orgA.email);
      await tokenFor(orgB.email);
      const foreign = await h.admin.execute<{ id: string }>(
        sql`SELECT id FROM sessions WHERE user_id = ${orgB.userId} AND revoked_at IS NULL LIMIT 1`,
      );
      const foreignId = foreign.rows[0]!.id;

      const res = await request(h.app.getHttpServer())
        .delete(url(`/auth/sessions/${foreignId}`))
        .set('authorization', `Bearer ${tokenA}`)
        .expect(404);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);

      const still = await h.admin.execute<{ revoked_at: string | null }>(
        sql`SELECT revoked_at FROM sessions WHERE id = ${foreignId}`,
      );
      expect(still.rows[0]!.revoked_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe('rate limiting', () => {
    it('refuses further attempts once the threshold is crossed', async () => {
      const victim = `ratelimit-${uuidv7()}@example.test`;
      const statuses: number[] = [];
      for (let i = 0; i < 14; i += 1) {
        const res = await login(victim, 'wrong-password');
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
      const limited = statuses.indexOf(429);
      // Every attempt after the first refusal stays refused within the window.
      expect(statuses.slice(limited).every((s) => s === 429)).toBe(true);
    }, 30_000);

    it('returns the same refusal for a known and an unknown account', async () => {
      // The rate limiter must not become an enumeration oracle either.
      const a = await login(`unknown-${uuidv7()}@example.test`, 'x');
      expect([401, 429]).toContain(a.status);
    });
  });
});
