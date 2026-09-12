import { z } from 'zod';

/**
 * Environment contract. The process refuses to start when any of this fails to
 * validate — there is no "best effort" startup with partial configuration.
 *
 * Production-only requirements are enforced by `productionHardening` at the end
 * of this file rather than by weaker per-field rules, so a development default
 * can never silently survive into production.
 */

const booleanFromEnv = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']))
  .transform((value) => ['true', '1', 'yes', 'on'].includes(value));

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'must be a postgres:// connection string',
  );

/** A `<backend>:<locator>` pointer resolved through SecretsPort (`SECURITY.md` §3). */
const secretRef = z
  .string()
  .regex(/^[a-z0-9_-]+:.+$/i, 'must be a secret reference of the form "<backend>:<locator>"');

const commaSeparated = z.string().transform((value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

export const APP_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export const envSchema = z.object({
  // --- Runtime -------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(APP_ENVIRONMENTS).default('development'),
  SERVICE_NAME: z.string().min(1).default('acc-api'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanFromEnv.default(false),

  // --- HTTP ----------------------------------------------------------------
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: port.default(3001),
  API_GLOBAL_PREFIX: z.string().default('api/v1'),
  CORS_ORIGINS: commaSeparated.default([]),
  SHUTDOWN_TIMEOUT_SECONDS: positiveInt.max(300).default(15),
  OPENAPI_UI_ENABLED: booleanFromEnv.default(false),

  // --- PostgreSQL ----------------------------------------------------------
  DATABASE_URL: postgresUrl,
  DATABASE_AUTH_URL: postgresUrl,
  DATABASE_ADMIN_URL: postgresUrl.optional(),
  DATABASE_RELAY_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: positiveInt.max(500).default(10),
  DATABASE_POOL_IDLE_TIMEOUT_MS: positiveInt.default(30_000),
  DATABASE_STATEMENT_TIMEOUT_MS: positiveInt.default(15_000),
  DATABASE_SSL: booleanFromEnv.default(false),

  // --- Redis ---------------------------------------------------------------
  REDIS_URL: z.string().min(1).startsWith('redis'),
  REDIS_KEY_PREFIX: z.string().min(1).default('acc'),

  // --- Event bus -----------------------------------------------------------
  KAFKA_BROKERS: commaSeparated.refine(
    (brokers) => brokers.length > 0,
    'at least one broker is required',
  ),
  KAFKA_CLIENT_ID: z.string().min(1).default('acc-api'),
  KAFKA_SSL: booleanFromEnv.default(false),
  EVENT_TOPIC_PREFIX: z.string().min(1).default('alendei'),
  OUTBOX_RELAY_ENABLED: booleanFromEnv.default(true),
  OUTBOX_RELAY_POLL_INTERVAL_MS: positiveInt.min(50).default(1_000),
  OUTBOX_RELAY_BATCH_SIZE: positiveInt.max(1_000).default(100),
  OUTBOX_RELAY_MAX_ATTEMPTS: positiveInt.max(100).default(10),

  // --- Secrets -------------------------------------------------------------
  SECRETS_BACKEND: z.enum(['env', 'vault', 'aws', 'azure', 'gcp']).default('env'),
  AUTH_JWT_SECRET_REF: secretRef,

  // --- Auth ----------------------------------------------------------------
  AUTH_JWT_ISSUER: z.string().min(1).default('acc'),
  AUTH_JWT_AUDIENCE: z.string().min(1).default('acc-console'),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: positiveInt.max(3_600).default(900),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: positiveInt.default(2_592_000),
  AUTH_WS_TICKET_TTL_SECONDS: positiveInt.max(300).default(30),
  AUTH_MAX_SESSIONS_PER_USER: positiveInt.max(1_000).default(25),
  AUTH_ARGON2_MEMORY_KIB: positiveInt.min(8_192).default(19_456),
  AUTH_ARGON2_TIME_COST: positiveInt.min(2).max(10).default(2),
  AUTH_ARGON2_PARALLELISM: positiveInt.min(1).max(16).default(1),

  // --- Rate limiting -------------------------------------------------------
  RATE_LIMIT_ENABLED: booleanFromEnv.default(true),
  RATE_LIMIT_DEFAULT_WINDOW_SECONDS: positiveInt.default(60),
  RATE_LIMIT_DEFAULT_MAX: positiveInt.default(600),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: positiveInt.default(60),
  RATE_LIMIT_AUTH_MAX: positiveInt.default(10),

  // --- Observability -------------------------------------------------------
  OTEL_ENABLED: booleanFromEnv.default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://localhost:4318'),
  OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),
  METRICS_ENABLED: booleanFromEnv.default(true),
  METRICS_PATH: z.string().startsWith('/').default('/metrics'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Requirements that only apply outside development/test. Kept in one place so
 * the full production contract is reviewable at a glance.
 */
function productionHardening(env: Env): string[] {
  if (env.APP_ENV !== 'production') return [];
  const problems: string[] = [];

  if (env.SECRETS_BACKEND === 'env') {
    problems.push(
      'SECRETS_BACKEND=env is not permitted when APP_ENV=production: application code must ' +
        'not read raw secret material from the environment (SECURITY.md §3). No non-env ' +
        'backend is implemented yet, so production is intentionally not yet runnable.',
    );
  }
  if (env.CORS_ORIGINS.includes('*')) {
    problems.push('CORS_ORIGINS must not contain "*" when APP_ENV=production');
  }
  if (env.CORS_ORIGINS.some((origin) => origin.startsWith('http://'))) {
    problems.push('CORS_ORIGINS must be https:// only when APP_ENV=production');
  }
  if (env.LOG_PRETTY) {
    problems.push('LOG_PRETTY must be false when APP_ENV=production (structured JSON only)');
  }
  if (!env.DATABASE_SSL) {
    problems.push('DATABASE_SSL must be true when APP_ENV=production (SECURITY.md §2)');
  }
  if (env.OPENAPI_UI_ENABLED) {
    problems.push(
      'OPENAPI_UI_ENABLED must be false when APP_ENV=production unless the UI is placed behind ' +
        'authentication (API.md §8)',
    );
  }
  return problems;
}

export class ConfigurationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigurationError';
  }
}

/** Parses and hardens the environment, throwing `ConfigurationError` on any problem. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigurationError(problems);
  }

  const problems = productionHardening(parsed.data);
  if (problems.length > 0) {
    throw new ConfigurationError(problems);
  }

  return parsed.data;
}
