/**
 * Phase 1C.3 — OpenAPI exposure and access, over the real bootstrap
 * (`createApp()`, as `main.ts` builds the application).
 *
 * The approved matrix (ADR-012, "Phase 1C.3 Architecture Decision Record", G1
 * option C):
 *
 *   development + flag             → public development UI, public document
 *   test/staging/production + flag → no UI; the document for a signed-in user
 *                                    session only
 *   any env, flag off              → no documentation route at all
 *
 * `production` is booted here too, through the same `createApp()`, with
 * `APP_ENV=production` and `NODE_ENV=production`. It has exactly one test-only
 * substitution, at configuration validation (the `jest.mock` below): the real
 * `validateEnv` runs on the production environment and must refuse it for
 * exactly the two requirements a test host cannot meet — `SECRETS_BACKEND=env`
 * (no other backend is implemented yet) and `DATABASE_SSL=true` (the local
 * PostgreSQL has no TLS). Every other production rule must pass. Any other
 * problem, or a missing one, fails the boot. The configuration the
 * application then runs on is the schema's own parse of that same environment.
 *
 * Exactly one route produces the document: `GET /api/v1/openapi.json`. Every
 * alternate spelling, alias, UI script and static artifact is proven absent,
 * and no refusal body ever carries the document.
 */
import { randomBytes } from 'node:crypto';
import { createDatabase, createPool, schema, type Database } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  type TenantFixture,
} from './auth-harness';
import { bootApp, carriesDocument, signIn, type Booted } from './openapi-support';

/** What the production-mode validation below saw, one entry per production boot. */
interface ProductionValidation {
  problems: readonly string[];
}
const productionValidations = (): ProductionValidation[] =>
  ((
    globalThis as { __accProductionValidations?: ProductionValidation[] }
  ).__accProductionValidations ??= []);

/**
 * The single production-mode substitution (see the header). Outside
 * `APP_ENV=production` the real validator runs unchanged.
 */
jest.mock('../src/config/env.schema', () => {
  const actual = jest.requireActual<typeof import('../src/config/env.schema')>(
    '../src/config/env.schema',
  );
  const HOST_ONLY = [
    /^SECRETS_BACKEND=env is not permitted when APP_ENV=production:/,
    /^DATABASE_SSL must be true when APP_ENV=production /,
  ];
  return {
    ...actual,
    validateEnv(raw: Record<string, unknown>) {
      if (raw.APP_ENV !== 'production') return actual.validateEnv(raw);
      let problems: readonly string[] = [];
      try {
        actual.validateEnv(raw);
      } catch (error) {
        if (!(error instanceof actual.ConfigurationError)) throw error;
        problems = error.problems;
      }
      const record = globalThis as {
        __accProductionValidations?: { problems: readonly string[] }[];
      };
      (record.__accProductionValidations ??= []).push({ problems });
      const matched = HOST_ONLY.every((pattern) => problems.some((p) => pattern.test(p)));
      const unexpected = problems.filter((p) => !HOST_ONLY.some((pattern) => pattern.test(p)));
      if (!matched || unexpected.length > 0 || problems.length !== HOST_ONLY.length) {
        throw new actual.ConfigurationError([
          'production-mode test substitution: expected exactly the two host-only problems',
          ...problems,
        ]);
      }
      return actual.envSchema.parse(raw);
    },
  };
});

const DOCUMENT = `/${PREFIX}/openapi.json`;

/** Every URL that must never produce the document outside the one route. */
const ALTERNATES = [
  `/${PREFIX}/openapi.json/`,
  `/${PREFIX}/OpenAPI.json`,
  `/${PREFIX}/OPENAPI.JSON`,
  `/${PREFIX}/openapi%2Ejson`,
  `/${PREFIX}/openapi.json%2F`,
  `/${PREFIX}//openapi.json`,
  `/${PREFIX}/openapi.json/x`,
  `/${PREFIX}/openapi.yaml`,
  `/${PREFIX}/openapi`,
  `/${PREFIX}/swagger.json`,
  `/${PREFIX}/docs-json`,
  `/${PREFIX}/docs-yaml`,
  `/${PREFIX}/docs/swagger-ui-init.js`,
  `/${PREFIX}/docs/docs/swagger-ui-init.js`,
  `/api/openapi.json`,
  `/openapi.json`,
] as const;

/** The development UI's URLs — absent everywhere except development + flag. */
const UI = [
  `/${PREFIX}/docs`,
  `/${PREFIX}/docs/`,
  `/${PREFIX}/docs/index.html`,
  `/${PREFIX}/docs/swagger-initializer.js`,
  `/${PREFIX}/docs/swagger-ui-bundle.js`,
  `/${PREFIX}/docs/swagger-ui.css`,
  `/${PREFIX}/docs/swagger-ui-standalone-preset.js`,
  `/${PREFIX}/docs/favicon-32x32.png`,
] as const;

const envFor = (appEnv: string, enabled: boolean): Record<string, string> => ({
  APP_ENV: appEnv,
  OPENAPI_UI_ENABLED: enabled ? 'true' : 'false',
  // Staging has no production hardening of its own to satisfy; nothing else changes.
  // Production states every hardening requirement a test host can meet.
  ...(appEnv === 'production'
    ? {
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.test',
        LOG_PRETTY: 'false',
        TRUSTED_PROXY_HOPS: '0',
      }
    : {}),
});

/** Every documentation path each mode mounts — the whole route table's worth. */
const DOCUMENTATION_ROUTES: Readonly<Record<string, readonly string[]>> = {
  off: [],
  protected: [`/${PREFIX}/openapi.json`],
  'public-development': [
    `/${PREFIX}/docs`,
    `/${PREFIX}/docs/favicon-32x32.png`,
    `/${PREFIX}/docs/swagger-initializer.js`,
    `/${PREFIX}/docs/swagger-ui-bundle.js`,
    `/${PREFIX}/docs/swagger-ui-standalone-preset.js`,
    `/${PREFIX}/docs/swagger-ui.css`,
    `/${PREFIX}/openapi.json`,
  ],
};

/** The configuration a booted application actually runs on. */
const bootedConfig = (booted: Booted) =>
  booted.resolve<{ appEnv: string; isProduction: boolean; openApiMode: string }>(
    '../src/config/app-config.service',
    'AppConfigService',
  );

interface Credentials {
  session: string;
  sessionId: string;
  apiKey: string;
  expired: string;
  revoked: string;
  disabledUserToken: string;
}

describe('Phase 1C.3 — OpenAPI exposure and access (real bootstrap)', () => {
  let pool: ReturnType<typeof createPool>;
  let admin: Database;
  const tenants: TenantFixture[] = [];
  const extraUsers: string[] = [];

  beforeAll(() => {
    pool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 2,
      applicationName: 'acc-test-openapi-access',
    });
    admin = createDatabase(pool);
  });

  afterAll(async () => {
    for (const tenant of tenants) {
      await purgeAudit(
        admin,
        sql`org_id = ${tenant.orgId} OR actor_user_id = ${tenant.userId}
            OR actor_api_key_id IN (SELECT id FROM api_keys WHERE org_id = ${tenant.orgId})`,
      );
      await destroyTenant(admin, tenant);
    }
    if (extraUsers.length > 0) {
      await purgeAudit(
        admin,
        sql`actor_user_id IN (${sql.join(
          extraUsers.map((u) => sql`${u}`),
          sql`, `,
        )})`,
      );
      await admin.delete(schema.sessions).where(inArray(schema.sessions.userId, extraUsers));
      await admin.delete(schema.users).where(inArray(schema.users.id, extraUsers));
    }
    await pool.end();
  });

  /** A tenant, a live session, an API key, and one refused credential of each kind. */
  async function credentialsFor(booted: Booted, label: string): Promise<Credentials> {
    const credentialService = booted.resolve<{ hash(p: string): Promise<string> }>(
      '../src/iam/credential.service',
      'CredentialService',
    );
    const tokens = booted.resolve<{
      issue(p: { userId: string; sessionId: string }): { token: string };
    }>('../src/auth/jwt.service', 'AccessTokenService');
    const tenant = await createTenant(admin, label, credentialService);
    tenants.push(tenant);
    await booted.clearRateLimits();

    const live = await signIn(booted.app, PREFIX, tenant.email, PASSWORD);

    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now - 2 * 60 * 60 * 1000);
    const expired = tokens.issue({ userId: tenant.userId, sessionId: live.sessionId }).token;
    clock.mockRestore();

    const doomed = await signIn(booted.app, PREFIX, tenant.email, PASSWORD);
    await admin
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: 'test' })
      .where(eq(schema.sessions.id, doomed.sessionId));

    // A second identity, signed in and then disabled with its session still live.
    const email = `openapi-disabled-${uuidv7().slice(-12)}@example.test`;
    const [disabled] = await admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentialService.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    extraUsers.push(disabled!.id);
    const disabledSession = await signIn(booted.app, PREFIX, email, PASSWORD);
    await admin
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, disabled!.id));

    const secret = `secret-${uuidv7()}`;
    const keyPrefix = `ak_test_${randomBytes(8).toString('hex')}`;
    await admin.insert(schema.apiKeys).values({
      orgId: tenant.orgId,
      name: `openapi-${keyPrefix}`,
      keyPrefix,
      keyHash: await credentialService.hash(secret),
      createdBy: tenant.userId,
      scopes: ['workspaces.read'],
    });

    return {
      session: live.token,
      sessionId: live.sessionId,
      apiKey: `${keyPrefix}.${secret}`,
      expired,
      revoked: doomed.token,
      disabledUserToken: disabledSession.token,
    };
  }

  /**
   * The booted configuration is the one intended. For production, also: the
   * real validator ran on this boot and refused only the two host-only
   * requirements, and the application reports itself as production.
   */
  const expectBootedAs = (
    booted: Booted,
    appEnv: string,
    mode: string,
    validationsBefore: number,
  ) => {
    const config = bootedConfig(booted);
    expect(config.appEnv).toBe(appEnv);
    expect(config.isProduction).toBe(appEnv === 'production');
    expect(config.openApiMode).toBe(mode);
    // The route table itself, not only the URLs probed: every distinct path a
    // documentation route is mounted at. (The canonical-path middleware is
    // mounted on the document path for every method; those methods are the
    // unknown-route 404 proven by "no other method reaches the document route".)
    const http = booted.app.getHttpAdapter().getInstance() as {
      router: { stack: Array<{ route?: { path: string } }> };
    };
    const documentation = [
      ...new Set(
        http.router.stack
          .flatMap((layer) => (layer.route ? [layer.route.path] : []))
          .filter((path) => /openapi|swagger|docs|\.json|\.ya?ml/i.test(path)),
      ),
    ].sort();
    expect(documentation).toEqual(DOCUMENTATION_ROUTES[mode]);
    const seen = productionValidations().slice(validationsBefore);
    if (appEnv === 'production') {
      expect(seen.length).toBeGreaterThan(0);
      for (const { problems } of seen) {
        expect(problems).toHaveLength(2);
        expect(problems[0]).toMatch(/^SECRETS_BACKEND=env is not permitted/);
        expect(problems[1]).toMatch(/^DATABASE_SSL must be true/);
      }
    } else {
      expect(seen).toHaveLength(0);
    }
  };

  const get = (booted: Booted, path: string, bearer?: string) => {
    const r = request(booted.app.getHttpServer()).get(path);
    return bearer ? r.set('authorization', `Bearer ${bearer}`) : r;
  };

  /** The ordinary unknown-route answer, which every absent URL must match. */
  const expectUnknownRoute = (res: request.Response, label: string) => {
    expect(`${label} → ${res.status}`).toBe(`${label} → 404`);
    expect(res.body?.error?.code).toBe('RESOURCE_NOT_FOUND');
    // Correlation middleware runs below the versioned prefix only (pre-existing;
    // recorded as a residual in the 1C.3 notes): an unknown route outside it has
    // no `X-Correlation-Id`.
    if (label.includes(` /${PREFIX}/`)) expect(res.headers['x-correlation-id']).toBeDefined();
    expect(carriesDocument(res.text)).toBe(false);
  };

  // ===========================================================================
  for (const appEnv of ['test', 'staging', 'production'] as const) {
    describe(`${appEnv} + OPENAPI_UI_ENABLED=true — protected: the document for a user session only, no UI`, () => {
      let booted: Booted;
      let creds: Credentials;
      const validationsBefore = { count: 0 };

      beforeAll(async () => {
        validationsBefore.count = productionValidations().length;
        booted = await bootApp(envFor(appEnv, true));
        creds = await credentialsFor(booted, `oa-${appEnv}`);
      }, 120_000);
      afterAll(async () => {
        await booted?.close();
      });

      it(`the application runs in ${appEnv} mode, with the protected OpenAPI mode`, () => {
        expectBootedAs(booted, appEnv, 'protected', validationsBefore.count);
      });

      it('a signed-in user session gets the OpenAPI 3.0.3 document through the ordinary pipeline', async () => {
        const res = await get(booted, DOCUMENT, creds.session).expect(200);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(res.body.openapi).toBe('3.0.3');
        expect(res.body.info.title).toBe('Alendei Communications Cloud API');
        expect(Object.keys(res.body.paths)).toContain(`/${PREFIX}/organizations`);
        expect(res.headers['cache-control']).toBe('no-store');
        // The Nest pipeline, not a raw route: correlation and the general limiter.
        expect(res.headers['x-correlation-id']).toBeDefined();
        expect(res.headers['x-request-id']).toBeDefined();
        expect(res.headers['x-ratelimit-limit']).toBeDefined();
        expect(res.headers['x-ratelimit-reset']).toBeDefined();
      });

      it('HEAD on the document route is guarded exactly like GET', async () => {
        await request(booted.app.getHttpServer()).head(DOCUMENT).expect(401);
        const ok = await request(booted.app.getHttpServer())
          .head(DOCUMENT)
          .set('authorization', `Bearer ${creds.session}`)
          .expect(200);
        expect(ok.text ?? '').toBe('');
      });

      it('every refused credential is an ordinary error envelope with no document in it', async () => {
        const cases: Array<[string, string | undefined, number, string]> = [
          ['no credential', undefined, 401, 'AUTH_CREDENTIAL_REQUIRED'],
          ['malformed bearer', 'not-a-token', 401, 'AUTH_TOKEN_INVALID'],
          ['expired access token', creds.expired, 401, 'AUTH_TOKEN_EXPIRED'],
          ['revoked session', creds.revoked, 401, 'AUTH_SESSION_REVOKED'],
          ['disabled user', creds.disabledUserToken, 401, 'AUTH_ACCOUNT_DISABLED'],
          ['API key', creds.apiKey, 403, 'AUTHZ_PERMISSION_DENIED'],
        ];
        for (const [label, bearer, status, code] of cases) {
          const res = await get(booted, DOCUMENT, bearer);
          expect(`${label} → ${res.status} ${res.body?.error?.code}`).toBe(
            `${label} → ${status} ${code}`,
          );
          expect(res.body.error.correlationId).toBe(res.headers['x-correlation-id']);
          expect(carriesDocument(res.text)).toBe(false);
        }
      });

      it('no alternate spelling, alias, UI script or static artifact produces the document — with or without a session', async () => {
        for (const path of ALTERNATES) {
          expectUnknownRoute(await get(booted, path), `anonymous GET ${path}`);
          expectUnknownRoute(await get(booted, path, creds.session), `session GET ${path}`);
        }
      });

      it('there is no UI outside development: /docs and every asset are unknown routes', async () => {
        for (const path of UI) {
          expectUnknownRoute(await get(booted, path), `anonymous GET ${path}`);
          expectUnknownRoute(await get(booted, path, creds.session), `session GET ${path}`);
        }
      });

      it('no other method reaches the document route', async () => {
        const server = booted.app.getHttpServer();
        for (const method of ['post', 'put', 'patch', 'delete'] as const) {
          const res = await request(server)
            [method](DOCUMENT)
            .set('authorization', `Bearer ${creds.session}`);
          expectUnknownRoute(res, `${method.toUpperCase()} ${DOCUMENT}`);
        }
      });
    });
  }

  // ===========================================================================
  describe('development + OPENAPI_UI_ENABLED=true — the development exception', () => {
    let booted: Booted;

    beforeAll(async () => {
      booted = await bootApp(envFor('development', true));
    }, 120_000);
    afterAll(async () => {
      await booted?.close();
    });

    it('the application runs in development mode, with the public development OpenAPI mode', () => {
      expectBootedAs(booted, 'development', 'public-development', productionValidations().length);
    });

    it('the document is public, from the same single route', async () => {
      const res = await get(booted, DOCUMENT).expect(200);
      expect(res.body.openapi).toBe('3.0.3');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('the UI is served, and neither the page nor its initializer embeds the document', async () => {
      const page = await get(booted, `/${PREFIX}/docs`).expect(200);
      expect(page.headers['content-type']).toMatch(/^text\/html/);
      expect(page.text).toContain(`/${PREFIX}/docs/swagger-initializer.js`);
      expect(carriesDocument(page.text)).toBe(false);

      const init = await get(booted, `/${PREFIX}/docs/swagger-initializer.js`).expect(200);
      expect(init.text).toContain(`url: "/${PREFIX}/openapi.json"`);
      expect(carriesDocument(init.text)).toBe(false);
      expect(init.text).not.toMatch(/\bspec\s*:/);

      for (const asset of [
        'swagger-ui-bundle.js',
        'swagger-ui.css',
        'swagger-ui-standalone-preset.js',
      ]) {
        const res = await get(booted, `/${PREFIX}/docs/${asset}`).expect(200);
        expect(`${asset}: ${res.text.includes('Alendei Communications Cloud API')}`).toBe(
          `${asset}: false`,
        );
      }
    });

    it('even here, only the one route produces the document', async () => {
      for (const path of ALTERNATES) {
        expectUnknownRoute(await get(booted, path), `GET ${path}`);
      }
    });
  });

  // ===========================================================================
  for (const appEnv of ['development', 'test', 'staging', 'production'] as const) {
    describe(`${appEnv} + OPENAPI_UI_ENABLED=false — no documentation route exists`, () => {
      let booted: Booted;
      let creds: Credentials | undefined;
      const validationsBefore = { count: 0 };

      beforeAll(async () => {
        validationsBefore.count = productionValidations().length;
        booted = await bootApp(envFor(appEnv, false));
        if (appEnv !== 'development') creds = await credentialsFor(booted, `oa-off-${appEnv}`);
      }, 120_000);
      afterAll(async () => {
        await booted?.close();
      });

      it(`the application runs in ${appEnv} mode, with OpenAPI off`, () => {
        expectBootedAs(booted, appEnv, 'off', validationsBefore.count);
      });

      it('the document route, the UI and every alternate are unknown routes, signed in or not', async () => {
        for (const path of [DOCUMENT, ...UI, ...ALTERNATES]) {
          expectUnknownRoute(await get(booted, path), `anonymous GET ${path}`);
          if (creds)
            expectUnknownRoute(await get(booted, path, creds.session), `session GET ${path}`);
        }
      });
    });
  }
});
