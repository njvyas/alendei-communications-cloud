import { ConfigurationError, validateEnv } from './env.schema';

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

  it('rejects a boolean written as something unparseable', () => {
    expect(() => validateEnv({ ...MINIMAL_ENV, METRICS_ENABLED: 'maybe' })).toThrow(
      ConfigurationError,
    );
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
