import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

/**
 * Integration tests run against the real Docker Compose stack, using the same
 * `.env` the application uses. `APP_ENV=test` keeps destructive helpers (such as
 * `db:reset`) willing to run and production hardening rules inapplicable.
 */
loadEnv({ path: resolve(__dirname, '../../../.env'), quiet: true });
loadEnv({ path: resolve(__dirname, '../.env'), quiet: true, override: false });

process.env.APP_ENV = 'test';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.LOG_PRETTY = 'false';
process.env.OTEL_ENABLED = 'false';
// Off unless a suite turns it on, so a developer's `.env` cannot change which
// routes exist under test (the OpenAPI document route, Phase 1C.3).
process.env.OPENAPI_UI_ENABLED = 'false';

// Rate limits are pinned to the documented values (`env.schema.ts` defaults,
// `.env.example`), so a developer's `.env` cannot change what the rate-limit
// suites assert: with a raised local limit they never see the `429` they test
// for (Gate C readiness audit). Test-only; production configuration and its
// limits are untouched. A suite that needs other values still sets its own
// before it boots, since this file runs first.
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_DEFAULT_WINDOW_SECONDS = '60';
process.env.RATE_LIMIT_DEFAULT_MAX = '600';
process.env.RATE_LIMIT_AUTH_WINDOW_SECONDS = '60';
process.env.RATE_LIMIT_AUTH_MAX = '10';
process.env.RATE_LIMIT_REFRESH_MAX = '30';
process.env.RATE_LIMIT_API_KEY_FAILURE_MAX = '20';
