/**
 * Shared support for the Phase 1C.3 OpenAPI suites. Opt-in: nothing here is
 * used by, or changes, any other suite.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/** The document's title — present in the document and in nothing else served. */
export const DOCUMENT_MARKER = 'Alendei Communications Cloud API';

/** True when a response body carries the OpenAPI document, in any form. */
export function carriesDocument(body: string): boolean {
  return body.includes(DOCUMENT_MARKER) || /"paths"\s*:/.test(body) || /\bopenapi:\s*3/.test(body);
}

export interface Booted {
  readonly app: INestApplication;
  /** A class from the isolated module registry the app was built from. */
  resolve<T>(path: string, exportName: string): T;
  clearRateLimits(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Builds the application through the real `createApp()` (`main.ts`'s path)
 * under `env`, in an isolated module registry so each configuration gets its
 * own module graph — including which OpenAPI module is registered.
 */
export async function bootApp(env: Record<string, string | undefined>): Promise<Booted> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const registry = new Map<string, Record<string, unknown>>();
  try {
    let createApp!: () => Promise<INestApplication>;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      createApp = require('../src/app.factory').createApp;
      for (const path of [
        '../src/redis/redis.module',
        '../src/auth/jwt.service',
        '../src/iam/credential.service',
      ]) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        registry.set(path, require(path) as Record<string, unknown>);
      }
    });
    const app = await createApp();
    try {
      await app.init();
    } catch (error) {
      await app.close().catch(() => undefined);
      throw error;
    }
    const redis = app.get(registry.get('../src/redis/redis.module')!.REDIS_CLIENT as symbol) as {
      keys(p: string): Promise<string[]>;
      del(...k: string[]): Promise<number>;
    };
    return {
      app,
      resolve<T>(path: string, exportName: string): T {
        const mod = registry.get(path);
        if (!mod) throw new Error(`module ${path} was not loaded into the registry`);
        return app.get(mod[exportName] as never) as T;
      },
      async clearRateLimits() {
        const keys = await redis.keys('*ratelimit:*');
        if (keys.length > 0) await redis.del(...keys);
      },
      close: () => app.close(),
    };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Signs in over HTTP and returns the access token and session id. */
export async function signIn(
  app: INestApplication,
  prefix: string,
  email: string,
  password: string,
): Promise<{ token: string; sessionId: string }> {
  const login = await request(app.getHttpServer())
    .post(`/${prefix}/auth/login`)
    .send({ email, password })
    .expect(200);
  const token = login.body.data.accessToken as string;
  const me = await request(app.getHttpServer())
    .get(`/${prefix}/auth/me`)
    .set('authorization', `Bearer ${token}`)
    .expect(200);
  return { token, sessionId: me.body.data.sessionId as string };
}
