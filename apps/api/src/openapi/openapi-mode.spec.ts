import { APP_ENVIRONMENTS, validateEnv } from '../config/env.schema';
import { openApiModeFromEnv, resolveOpenApiMode } from './openapi-mode';

/**
 * The approved exposure matrix (Phase 1C.3 ADR, G1 option C, G3, G4) at the
 * unit level — including `production`. Its bootstrap-level proof is in
 * `test/openapi-access.sec-spec.ts`, which boots production with a single
 * validation substitution (`SECRETS_BACKEND=env` and `DATABASE_SSL` only).
 */
describe('OpenAPI exposure mode', () => {
  const MATRIX: ReadonlyArray<[string, boolean, string]> = [
    ['development', false, 'off'],
    ['development', true, 'public-development'],
    ['test', false, 'off'],
    ['test', true, 'protected'],
    ['staging', false, 'off'],
    ['staging', true, 'protected'],
    ['production', false, 'off'],
    ['production', true, 'protected'],
  ];

  it('covers every environment exactly', () => {
    expect([...new Set(MATRIX.map(([env]) => env))].sort()).toEqual([...APP_ENVIRONMENTS].sort());
  });

  it.each(MATRIX)('%s with OPENAPI_UI_ENABLED=%s → %s', (appEnv, enabled, mode) => {
    expect(resolveOpenApiMode({ appEnv: appEnv as never, enabled })).toBe(mode);
    expect(
      openApiModeFromEnv({ APP_ENV: appEnv, OPENAPI_UI_ENABLED: enabled ? 'true' : 'false' }),
    ).toBe(mode);
  });

  it('the unauthenticated development exception needs both conditions', () => {
    const publicModes = MATRIX.filter(([, , mode]) => mode === 'public-development');
    expect(publicModes).toEqual([['development', true, 'public-development']]);
  });

  it('parses the flag exactly as the validated schema does, and defaults to off', () => {
    for (const on of ['true', 'TRUE', ' yes ', '1', 'on']) {
      expect(openApiModeFromEnv({ APP_ENV: 'test', OPENAPI_UI_ENABLED: on })).toBe('protected');
    }
    for (const off of ['false', '0', 'no', 'off']) {
      expect(openApiModeFromEnv({ APP_ENV: 'test', OPENAPI_UI_ENABLED: off })).toBe('off');
    }
    expect(openApiModeFromEnv({ APP_ENV: 'test' })).toBe('off');
    expect(openApiModeFromEnv({})).toBe('off');
  });

  it('production no longer refuses OPENAPI_UI_ENABLED (G3): the protected mode applies instead', () => {
    const production = {
      DATABASE_URL: 'postgres://acc_app:pw@localhost:5432/acc',
      DATABASE_AUTH_URL: 'postgres://acc_auth:pw@localhost:5432/acc',
      REDIS_URL: 'redis://localhost:6379',
      KAFKA_BROKERS: 'localhost:19092',
      AUTH_JWT_SECRET_REF: 'vault:acc/jwt',
      APP_ENV: 'production',
      SECRETS_BACKEND: 'vault',
      CORS_ORIGINS: 'https://console.example.com',
      LOG_PRETTY: 'false',
      DATABASE_SSL: 'true',
      TRUSTED_PROXY_HOPS: '1',
      OPENAPI_UI_ENABLED: 'true',
    };
    const env = validateEnv(production);
    expect(env.OPENAPI_UI_ENABLED).toBe(true);
    expect(resolveOpenApiMode({ appEnv: env.APP_ENV, enabled: env.OPENAPI_UI_ENABLED })).toBe(
      'protected',
    );
  });
});
