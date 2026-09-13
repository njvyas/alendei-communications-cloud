import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment, Env } from './env.schema';

/**
 * Typed accessor over validated configuration. Feature code injects this rather
 * than reading `process.env`, so every value it sees has passed validation.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get appEnv(): AppEnvironment {
    return this.get('APP_ENV');
  }

  get isProduction(): boolean {
    return this.appEnv === 'production';
  }

  get isTest(): boolean {
    return this.appEnv === 'test';
  }

  get serviceName(): string {
    return this.get('SERVICE_NAME');
  }

  get http() {
    return {
      host: this.get('API_HOST'),
      port: this.get('API_PORT'),
      globalPrefix: this.get('API_GLOBAL_PREFIX'),
      corsOrigins: this.get('CORS_ORIGINS'),
      trustedProxyHops: this.get('TRUSTED_PROXY_HOPS'),
      shutdownTimeoutMs: this.get('SHUTDOWN_TIMEOUT_SECONDS') * 1_000,
      openApiUiEnabled: this.get('OPENAPI_UI_ENABLED'),
    } as const;
  }

  get logging() {
    return {
      level: this.get('LOG_LEVEL'),
      pretty: this.get('LOG_PRETTY'),
    } as const;
  }

  get database() {
    return {
      appUrl: this.get('DATABASE_URL'),
      authUrl: this.get('DATABASE_AUTH_URL'),
      relayUrl: this.get('DATABASE_RELAY_URL'),
      poolMax: this.get('DATABASE_POOL_MAX'),
      idleTimeoutMs: this.get('DATABASE_POOL_IDLE_TIMEOUT_MS'),
      statementTimeoutMs: this.get('DATABASE_STATEMENT_TIMEOUT_MS'),
      ssl: this.get('DATABASE_SSL'),
    } as const;
  }

  get redis() {
    return {
      url: this.get('REDIS_URL'),
      keyPrefix: this.get('REDIS_KEY_PREFIX'),
    } as const;
  }

  get events() {
    return {
      brokers: this.get('KAFKA_BROKERS'),
      clientId: this.get('KAFKA_CLIENT_ID'),
      ssl: this.get('KAFKA_SSL'),
      topicPrefix: this.get('EVENT_TOPIC_PREFIX'),
      relayEnabled: this.get('OUTBOX_RELAY_ENABLED'),
      relayPollIntervalMs: this.get('OUTBOX_RELAY_POLL_INTERVAL_MS'),
      relayBatchSize: this.get('OUTBOX_RELAY_BATCH_SIZE'),
      relayMaxAttempts: this.get('OUTBOX_RELAY_MAX_ATTEMPTS'),
    } as const;
  }

  get secrets() {
    return {
      backend: this.get('SECRETS_BACKEND'),
      jwtSecretRef: this.get('AUTH_JWT_SECRET_REF'),
    } as const;
  }

  get auth() {
    return {
      issuer: this.get('AUTH_JWT_ISSUER'),
      audience: this.get('AUTH_JWT_AUDIENCE'),
      accessTokenTtlSeconds: this.get('AUTH_ACCESS_TOKEN_TTL_SECONDS'),
      refreshTokenTtlSeconds: this.get('AUTH_REFRESH_TOKEN_TTL_SECONDS'),
      wsTicketTtlSeconds: this.get('AUTH_WS_TICKET_TTL_SECONDS'),
      maxSessionsPerUser: this.get('AUTH_MAX_SESSIONS_PER_USER'),
      argon2: {
        memoryCost: this.get('AUTH_ARGON2_MEMORY_KIB'),
        timeCost: this.get('AUTH_ARGON2_TIME_COST'),
        parallelism: this.get('AUTH_ARGON2_PARALLELISM'),
      },
    } as const;
  }

  /** Owner-run bootstrap only (ADR-003 D-1); never read by a request path. */
  get bootstrap() {
    return {
      email: this.get('AUTH_BOOTSTRAP_EMAIL'),
      passwordRef: this.get('AUTH_BOOTSTRAP_PASSWORD_REF'),
    } as const;
  }

  get rateLimit() {
    return {
      enabled: this.get('RATE_LIMIT_ENABLED'),
      defaultWindowSeconds: this.get('RATE_LIMIT_DEFAULT_WINDOW_SECONDS'),
      defaultMax: this.get('RATE_LIMIT_DEFAULT_MAX'),
      authWindowSeconds: this.get('RATE_LIMIT_AUTH_WINDOW_SECONDS'),
      authMax: this.get('RATE_LIMIT_AUTH_MAX'),
    } as const;
  }

  get observability() {
    return {
      otelEnabled: this.get('OTEL_ENABLED'),
      otelEndpoint: this.get('OTEL_EXPORTER_OTLP_ENDPOINT'),
      tracesSamplerRatio: this.get('OTEL_TRACES_SAMPLER_RATIO'),
      metricsEnabled: this.get('METRICS_ENABLED'),
      metricsPath: this.get('METRICS_PATH'),
    } as const;
  }
}
