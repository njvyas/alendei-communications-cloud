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
  /** A provider, by its class in the isolated module registry the app was built from. */
  resolve<T>(path: string, exportName: string): T;
  /** A module's exports from that same isolated registry. */
  load<T = Record<string, unknown>>(path: string): T;
  clearRateLimits(): Promise<void>;
  close(): Promise<void>;
}

const REGISTRY_MODULES = [
  '../src/redis/redis.module',
  '../src/auth/jwt.service',
  '../src/iam/credential.service',
  '../src/openapi/openapi-document.service',
  '../src/rbac/tenant-role-provisioner.service',
  '../src/openapi/openapi-document',
  '../src/openapi/openapi-normalize',
  'class-validator',
  '@nestjs/common/constants',
];

/**
 * Builds the application through the real `createApp()` (`main.ts`'s path)
 * under `env`, in an isolated module registry so each configuration gets its
 * own module graph — including which OpenAPI module is registered.
 *
 * For exposure checks only: the committed plugin metadata loads DTO modules
 * through `import()`, which resolves after the isolation scope has closed, so a
 * document built here lacks DTO schemas. A suite that inspects document
 * *content* uses {@link bootAppInFileRegistry} instead.
 */
export async function bootApp(env: Record<string, string | undefined>): Promise<Booted> {
  return boot(env, true);
}

/**
 * The same, in the test file's own module registry (every Jest test file has a
 * fresh one), so the document is built exactly as in production. The
 * configuration is applied before the application is first required; call it
 * once per test file.
 */
export async function bootAppInFileRegistry(
  env: Record<string, string | undefined>,
): Promise<Booted> {
  return boot(env, false);
}

async function boot(env: Record<string, string | undefined>, isolated: boolean): Promise<Booted> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const registry = new Map<string, Record<string, unknown>>();
  try {
    let createApp!: () => Promise<INestApplication>;
    const load = () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      createApp = require('../src/app.factory').createApp;
      for (const path of REGISTRY_MODULES) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        registry.set(path, require(path) as Record<string, unknown>);
      }
    };
    if (isolated) jest.isolateModules(load);
    else load();
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
      load<T>(path: string): T {
        const mod = registry.get(path);
        if (!mod) throw new Error(`module ${path} was not loaded into the registry`);
        return mod as T;
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
