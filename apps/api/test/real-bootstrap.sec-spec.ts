/**
 * HTTP-edge security through the real production bootstrap (Gate-B security
 * audit, Blocker 5).
 *
 * Every other suite builds its application with `startHarness`, which never ran
 * `main.ts`: no Helmet, no CORS, no proxy trust. Tests of those controls passed
 * because the controls were absent. This suite builds the application with
 * `createApp()` — the exact function `main.ts` calls — so what is asserted here
 * is what production serves.
 *
 * Configuration is validated when `AppModule` is first imported, so each
 * configuration variant is loaded in an isolated module registry with its
 * environment set beforehand.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PREFIX } from './auth-harness';

const ALLOWED_ORIGIN = 'https://console.example.test';

type Loaded = { app: INestApplication; clear: () => Promise<void> };

/** Imports `createApp` fresh under `env`, and initializes (does not listen). */
async function boot(env: Record<string, string | undefined>): Promise<Loaded> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    let createApp!: () => Promise<INestApplication>;
    let redisToken!: symbol | string;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      createApp = require('../src/app.factory').createApp;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      redisToken = require('../src/redis/redis.module').REDIS_CLIENT;
    });
    const app = await createApp();
    try {
      await app.init();
    } catch (error) {
      // A refused start-up still opened its pools and Redis connection; close
      // them so a failed boot does not hold the process open.
      await app.close().catch(() => undefined);
      throw error;
    }
    const redis = app.get(redisToken) as {
      keys(p: string): Promise<string[]>;
      del(...k: string[]): Promise<number>;
    };
    return {
      app,
      async clear() {
        const keys = await redis.keys('*ratelimit:*');
        if (keys.length > 0) await redis.del(...keys);
      },
    };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const url = (path: string) => `/${PREFIX}${path}`;

describe('real bootstrap — HTTP-edge security as main.ts configures it', () => {
  let edge: Loaded;

  beforeAll(async () => {
    edge = await boot({ CORS_ORIGINS: ALLOWED_ORIGIN, TRUSTED_PROXY_HOPS: undefined });
    await edge.clear();
  }, 60_000);

  afterAll(async () => {
    await edge?.clear();
    await edge?.app.close();
  });

  const server = () => edge.app.getHttpServer();

  // ---------------------------------------------------------------------------
  describe('security headers (Helmet)', () => {
    it('sends the hardening headers and no framework fingerprint', async () => {
      const res = await request(server()).get('/health/live');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('applies them to API routes and error responses too', async () => {
      const res = await request(server()).get(url('/users')).expect(401);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('omits CSP outside production, as configured (recorded, not accidental)', async () => {
      const res = await request(server()).get('/health/live');
      expect(res.headers['content-security-policy']).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  describe('CORS', () => {
    const preflight = (origin: string) =>
      request(server())
        .options(url('/auth/refresh'))
        .set('origin', origin)
        .set('access-control-request-method', 'POST')
        .set('access-control-request-headers', 'x-acc-refresh,content-type');

    it('admits the configured origin with credentials, echoing it exactly', async () => {
      const res = await preflight(ALLOWED_ORIGIN);
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-headers']).toMatch(/x-acc-refresh/);
    });

    it('refuses any other origin — no allow-origin header at all', async () => {
      for (const origin of ['https://evil.example', 'http://console.example.test', 'null']) {
        const res = await preflight(origin);
        expect(`${origin}:${res.headers['access-control-allow-origin'] ?? 'absent'}`).toBe(
          `${origin}:absent`,
        );
      }
    });

    it('never answers with a wildcard origin', async () => {
      const res = await request(server()).get('/health/live').set('origin', 'https://evil.example');
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('exposes the rate-limit and correlation headers a browser client needs', async () => {
      const res = await request(server()).get('/health/live').set('origin', ALLOWED_ORIGIN);
      const exposed = String(res.headers['access-control-expose-headers'] ?? '').toLowerCase();
      for (const header of [
        'x-correlation-id',
        'retry-after',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
      ]) {
        expect(exposed).toContain(header);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('CSRF assumptions', () => {
    it('refresh without the custom header is refused before any credential work', async () => {
      const res = await request(server())
        .post(url('/auth/refresh'))
        .set('cookie', 'acc_refresh=anything');
      expect(res.status).toBe(403);
    });

    it('login refuses the content types an HTML form can send without a preflight', async () => {
      await edge.clear();
      const form = await request(server())
        .post(url('/auth/login'))
        .type('form')
        .send('email=victim%40example.test&password=whatever');
      expect(form.status).toBe(415);
      const text = await request(server())
        .post(url('/auth/login'))
        .set('content-type', 'text/plain')
        .send('{"email":"victim@example.test","password":"whatever"}');
      expect(text.status).toBe(415);
    });

    it('login with JSON reaches credential verification (a real 401, not the content-type refusal)', async () => {
      await edge.clear();
      const res = await request(server())
        .post(url('/auth/login'))
        .send({ email: `nobody-${Date.now()}@example.test`, password: 'not-the-password' });
      expect(res.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('client address and proxy trust', () => {
    /** Unknown accounts, a fresh one each time, so only the IP bucket can refuse. */
    const attempts = async (
      app: INestApplication,
      forwardedFor: (i: number) => string,
      n: number,
    ) => {
      const statuses: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const res = await request(app.getHttpServer())
          .post(url('/auth/login'))
          .set('x-forwarded-for', forwardedFor(i))
          .send({ email: `spray-${Date.now()}-${i}@example.test`, password: 'x' });
        statuses.push(res.status);
      }
      return statuses;
    };

    it('by default a spoofed X-Forwarded-For cannot buy a fresh rate-limit bucket', async () => {
      await edge.clear();
      // Eleven attempts, each claiming a different client address. With no
      // proxy hop trusted, every one is the same socket address, so the IP
      // bucket (limit 10) refuses the eleventh.
      const statuses = await attempts(edge.app, (i) => `203.0.113.${i + 1}`, 11);
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
      await edge.clear();
    });

    it('with one hop explicitly trusted, the forwarded address is honoured (the deliberate opt-in)', async () => {
      const proxied = await boot({ CORS_ORIGINS: ALLOWED_ORIGIN, TRUSTED_PROXY_HOPS: '1' });
      try {
        await proxied.clear();
        const statuses = await attempts(proxied.app, (i) => `198.51.100.${i + 1}`, 11);
        // Every attempt names a distinct client behind the trusted proxy, so no
        // single IP bucket fills — which is correct behind a real ingress and is
        // exactly why the default is not this.
        expect(statuses.every((s) => s === 401)).toBe(true);
      } finally {
        await proxied.clear();
        await proxied.app.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('database principal posture at start-up', () => {
    it('refuses to start when DATABASE_URL logs in as the schema owner', async () => {
      await expect(
        boot({ CORS_ORIGINS: ALLOWED_ORIGIN, DATABASE_URL: process.env.DATABASE_ADMIN_URL }),
      ).rejects.toThrow(/RLS would not bind its principal/);
    });
  });
});
