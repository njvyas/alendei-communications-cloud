import { envSchema, type AppEnvironment } from '../config/env.schema';

/**
 * Which OpenAPI surface this process exposes (Phase 1C.3 ADR, G1 option C).
 *
 * - `off` — `OPENAPI_UI_ENABLED` is false: no documentation route exists.
 * - `public-development` — `APP_ENV=development` and the flag is on: the
 *   Swagger UI and the document are served without authentication.
 * - `protected` — any other environment with the flag on: only
 *   `GET /api/v1/openapi.json` exists, and it requires a signed-in user session.
 *   There is no UI.
 *
 * The flag enables the OpenAPI capability; it never means a UI exists outside
 * development.
 */
export type OpenApiMode = 'off' | 'public-development' | 'protected';

export function resolveOpenApiMode(input: {
  appEnv: AppEnvironment;
  enabled: boolean;
}): OpenApiMode {
  if (!input.enabled) return 'off';
  return input.appEnv === 'development' ? 'public-development' : 'protected';
}

/**
 * The same decision from raw environment variables, for the one place that
 * must decide before dependency injection exists: which documentation
 * controller the module graph registers (`ConditionalModule`). Parsed with the
 * validated schema's own field rules, so it can never disagree with
 * `AppConfigService`; a value the schema refuses has already stopped the
 * process in `ConfigModule` validation.
 */
export function openApiModeFromEnv(env: NodeJS.ProcessEnv): OpenApiMode {
  const appEnv = envSchema.shape.APP_ENV.safeParse(env.APP_ENV);
  const enabled = envSchema.shape.OPENAPI_UI_ENABLED.safeParse(env.OPENAPI_UI_ENABLED);
  if (!appEnv.success || !enabled.success) return 'off';
  return resolveOpenApiMode({ appEnv: appEnv.data, enabled: enabled.data });
}
