import { ConfigurationError, DEVELOPMENT_DISPATCH_PASSWORD, validateEnv } from './env.schema';

/**
 * Configuration is a security boundary: a process that starts with invalid or
 * unsafe configuration is worse than one that refuses to start.
 */
const MINIMAL_ENV = {
  DATABASE_URL: 'postgres://acc_app:pw@localhost:5432/acc',
  DATABASE_AUTH_URL: 'postgres://acc_auth:pw@localhost:5432/acc',
  REDIS_URL: 'redis://localhost:6379',
  KAFKA_BROKERS: 'localhost:19092',
  AUTH_JWT_SECRET_REF: 'env:ACC_DEV_JWT_SECRET',
} as const;

describe('validateEnv', () => {
  it('accepts a minimal development environment and applies defaults', () => {
    const env = validateEnv({ ...MINIMAL_ENV });

    expect(env.APP_ENV).toBe('development');
    expect(env.API_PORT).toBe(3001);
    expect(env.API_GLOBAL_PREFIX).toBe('api/v1');
    expect(env.AUTH_WS_TICKET_TTL_SECONDS).toBe(30);
  });

  it('rejects a missing mandatory value', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = MINIMAL_ENV;

    expect(() => validateEnv(withoutDatabase)).toThrow(ConfigurationError);
    expect(() => validateEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('rejects a connection string that is not PostgreSQL', () => {
    expect(() => validateEnv({ ...MINIMAL_ENV, DATABASE_URL: 'mysql://localhost/acc' })).toThrow(
      /postgres:\/\/ connection string/,
    );
  });

  it('rejects a secret reference that is not a reference', () => {
    expect(() =>
      validateEnv({ ...MINIMAL_ENV, AUTH_JWT_SECRET_REF: 'a-literal-secret-value' }),
    ).toThrow(/secret reference/);
  });

  it('rejects an out-of-range numeric value rather than clamping it', () => {
    expect(() => validateEnv({ ...MINIMAL_ENV, API_PORT: '70000' })).toThrow(ConfigurationError);
    expect(() => validateEnv({ ...MINIMAL_ENV, OTEL_TRACES_SAMPLER_RATIO: '2' })).toThrow(
      ConfigurationError,
    );
  });

  it('parses boolean and list values from their string forms', () => {
    const env = validateEnv({
      ...MINIMAL_ENV,
      METRICS_ENABLED: 'yes',
      OTEL_ENABLED: 'off',
      CORS_ORIGINS: 'http://localhost:3000, http://localhost:3005 ,',
    });

    expect(env.METRICS_ENABLED).toBe(true);
    expect(env.OTEL_ENABLED).toBe(false);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3005']);
  });

  it('runs message dispatch by default at the ADR-014 D18 settings, and can switch it off', () => {
    const env = validateEnv({ ...MINIMAL_ENV });
    expect(env.DISPATCH_WORKER_ENABLED).toBe(true);
    expect(env.DISPATCH_WORKER_POLL_INTERVAL_MS).toBe(1_000);
    expect(env.DISPATCH_WORKER_BATCH_SIZE).toBe(10);

    expect(
      validateEnv({ ...MINIMAL_ENV, DISPATCH_WORKER_ENABLED: 'false' }).DISPATCH_WORKER_ENABLED,
    ).toBe(false);
  });

  it('refuses a dispatch batch larger than its 30 s lease is sized for, and a busy-loop poll interval', () => {
    expect(() => validateEnv({ ...MINIMAL_ENV, DISPATCH_WORKER_BATCH_SIZE: '11' })).toThrow(
      ConfigurationError,
    );
    expect(() => validateEnv({ ...MINIMAL_ENV, DISPATCH_WORKER_POLL_INTERVAL_MS: '10' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a boolean written as something unparseable', () => {
    expect(() => validateEnv({ ...MINIMAL_ENV, METRICS_ENABLED: 'maybe' })).toThrow(
      ConfigurationError,
    );
  });

  describe('dispatch credential (B3)', () => {
    const SECRET = 'a-staging-dispatch-credential';
    const STAGING = { ...MINIMAL_ENV, APP_ENV: 'staging' } as const;
    const PRODUCTION = {
      ...MINIMAL_ENV,
      APP_ENV: 'production',
      SECRETS_BACKEND: 'vault',
      CORS_ORIGINS: 'https://console.example.com',
      DATABASE_SSL: 'true',
      TRUSTED_PROXY_HOPS: '1',
    } as const;
    const problemsOf = (raw: Record<string, unknown>): string[] => {
      try {
        validateEnv(raw);
        return [];
      } catch (error) {
        return (error as ConfigurationError).problems as string[];
      }
    };

    it.each(['development', 'test'])(
      '%s may omit it: the local development password stands in',
      (appEnv) => {
        expect(problemsOf({ ...MINIMAL_ENV, APP_ENV: appEnv })).toEqual([]);
      },
    );

    it.each([
      ['staging', STAGING],
      ['production', PRODUCTION],
    ])('%s refuses to start without one', (_name, env) => {
      expect(problemsOf(env)).toEqual([
        expect.stringMatching(
          /DATABASE_DISPATCH_URL or DATABASE_DISPATCH_PASSWORD must be set when APP_ENV=(staging|production)/,
        ),
      ]);
    });

    it.each([
      ['staging', STAGING],
      ['production', PRODUCTION],
    ])('%s accepts a password of its own, or a URL that logs in as acc_dispatch', (_name, env) => {
      expect(problemsOf({ ...env, DATABASE_DISPATCH_PASSWORD: SECRET })).toEqual([]);
      expect(
        problemsOf({
          ...env,
          DATABASE_DISPATCH_URL: `postgres://acc_dispatch:${SECRET}@db.internal:5432/acc`,
        }),
      ).toEqual([]);
    });

    it('refuses the development password outside development and test, by either variable', () => {
      expect(
        problemsOf({ ...STAGING, DATABASE_DISPATCH_PASSWORD: DEVELOPMENT_DISPATCH_PASSWORD }),
      ).toEqual([
        expect.stringMatching(/DATABASE_DISPATCH_PASSWORD must not be the development password/),
      ]);
      expect(
        problemsOf({
          ...PRODUCTION,
          DATABASE_DISPATCH_URL: `postgres://acc_dispatch:${DEVELOPMENT_DISPATCH_PASSWORD}@db.internal/acc`,
        }),
      ).toEqual([
        expect.stringMatching(/DATABASE_DISPATCH_URL must not use the development password/),
      ]);
    });

    it('refuses a dispatch URL for another principal, or without a password', () => {
      expect(
        problemsOf({
          ...STAGING,
          DATABASE_DISPATCH_URL: `postgres://acc_app:${SECRET}@db.internal/acc`,
        }),
      ).toEqual([expect.stringMatching(/DATABASE_DISPATCH_URL must log in as acc_dispatch/)]);
      expect(
        problemsOf({
          ...STAGING,
          DATABASE_DISPATCH_URL: 'postgres://acc_dispatch@db.internal/acc',
        }),
      ).toEqual([expect.stringMatching(/DATABASE_DISPATCH_URL must carry a password/)]);
    });

    it('refuses an empty password and a non-PostgreSQL URL as invalid configuration', () => {
      expect(problemsOf({ ...STAGING, DATABASE_DISPATCH_PASSWORD: '' })).not.toEqual([]);
      expect(
        problemsOf({ ...STAGING, DATABASE_DISPATCH_URL: 'mysql://acc_dispatch:x@db/acc' }),
      ).not.toEqual([]);
    });

    it('never repeats a credential value in its messages', () => {
      const messages = [
        ...problemsOf({ ...STAGING, DATABASE_DISPATCH_PASSWORD: DEVELOPMENT_DISPATCH_PASSWORD }),
        ...problemsOf({ ...STAGING, DATABASE_DISPATCH_URL: `postgres://acc_app:${SECRET}@db/acc` }),
      ].join('\n');
      expect(messages).not.toContain(DEVELOPMENT_DISPATCH_PASSWORD);
      expect(messages).not.toContain(SECRET);
    });
  });

  describe('production hardening', () => {
    const PRODUCTION = {
      ...MINIMAL_ENV,
      APP_ENV: 'production',
      SECRETS_BACKEND: 'vault',
      CORS_ORIGINS: 'https://console.example.com',
      LOG_PRETTY: 'false',
      DATABASE_SSL: 'true',
      OPENAPI_UI_ENABLED: 'false',
      TRUSTED_PROXY_HOPS: '1',
      DATABASE_DISPATCH_PASSWORD: 'a-production-dispatch-credential',
    } as const;

    it('accepts a correctly hardened production environment', () => {
      expect(() => validateEnv({ ...PRODUCTION })).not.toThrow();
    });

    it('refuses to read raw secrets from the environment in production', () => {
      expect(() => validateEnv({ ...PRODUCTION, SECRETS_BACKEND: 'env' })).toThrow(
        /SECRETS_BACKEND=env is not permitted/,
      );
    });

    it('refuses a wildcard CORS origin in production', () => {
      expect(() => validateEnv({ ...PRODUCTION, CORS_ORIGINS: '*' })).toThrow(/must not contain/);
    });

    it('refuses a plaintext CORS origin in production', () => {
      expect(() =>
        validateEnv({ ...PRODUCTION, CORS_ORIGINS: 'http://console.example.com' }),
      ).toThrow(/https:\/\/ only/);
    });

    it('refuses an unencrypted database connection in production', () => {
      expect(() => validateEnv({ ...PRODUCTION, DATABASE_SSL: 'false' })).toThrow(
        /DATABASE_SSL must be true/,
      );
    });

    it('defaults to trusting no proxy hop', () => {
      expect(validateEnv({ ...MINIMAL_ENV }).TRUSTED_PROXY_HOPS).toBe(0);
    });

    it('refuses production without an explicit proxy hop count', () => {
      const { TRUSTED_PROXY_HOPS: _omitted, ...withoutHops } = PRODUCTION;
      void _omitted;
      expect(() => validateEnv({ ...withoutHops })).toThrow(/TRUSTED_PROXY_HOPS must be set/);
      expect(() => validateEnv({ ...PRODUCTION, TRUSTED_PROXY_HOPS: '0' })).not.toThrow();
    });

    it('refuses pretty logging in production', () => {
      expect(() => validateEnv({ ...PRODUCTION, LOG_PRETTY: 'true' })).toThrow(/LOG_PRETTY/);
    });

    it('reports every production problem at once rather than one at a time', () => {
      try {
        validateEnv({
          ...PRODUCTION,
          SECRETS_BACKEND: 'env',
          LOG_PRETTY: 'true',
          DATABASE_SSL: 'false',
        });
        throw new Error('expected validateEnv to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as ConfigurationError).problems).toHaveLength(3);
      }
    });
  });
});
