/**
 * Phase 1C.3 — OpenAPI exposure and access, over the real bootstrap
 * (`createApp()`, as `main.ts` builds the application).
 *
 * The approved matrix (ADR-012, "Phase 1C.3 Architecture Decision Record", G1
 * option C):
 *
 *   development + flag  → public development UI, public document
 *   test/staging + flag → no UI; the document for a signed-in user session only
 *   any env, flag off   → no documentation route at all
 *
 * (`production` cannot be booted in any suite — `SECRETS_BACKEND=env` is refused
 * there by design — so its row is proven at the unit level in
 * `src/openapi/openapi-mode.spec.ts`: it resolves to exactly the same
 * `protected` mode as `test` and `staging`.)
 *
 * Exactly one route produces the document: `GET /api/v1/openapi.json`. Every
 * alternate spelling, alias, UI script and static artifact is proven absent,
 * and no refusal body ever carries the document.
 */
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

const envFor = (appEnv: string, enabled: boolean) => ({
  APP_ENV: appEnv,
  OPENAPI_UI_ENABLED: enabled ? 'true' : 'false',
  // Staging has no production hardening of its own to satisfy; nothing else changes.
});

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
    const keyPrefix = `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`;
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
  for (const appEnv of ['test', 'staging'] as const) {
    describe(`${appEnv} + OPENAPI_UI_ENABLED=true — protected: the document for a user session only, no UI`, () => {
      let booted: Booted;
      let creds: Credentials;

      beforeAll(async () => {
        booted = await bootApp(envFor(appEnv, true));
        creds = await credentialsFor(booted, `oa-${appEnv}`);
      }, 120_000);
      afterAll(async () => {
        await booted?.close();
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
  for (const appEnv of ['development', 'test', 'staging'] as const) {
    describe(`${appEnv} + OPENAPI_UI_ENABLED=false — no documentation route exists`, () => {
      let booted: Booted;
      let creds: Credentials | undefined;

      beforeAll(async () => {
        booted = await bootApp(envFor(appEnv, false));
        if (appEnv !== 'development') creds = await credentialsFor(booted, `oa-off-${appEnv}`);
      }, 120_000);
      afterAll(async () => {
        await booted?.close();
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
