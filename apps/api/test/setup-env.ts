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
