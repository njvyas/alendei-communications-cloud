import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';

import { CorrelationMiddleware } from './common/context/correlation.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { validationPipe } from './common/http/validation.pipe';
import { AuditModule } from './audit/audit.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { HttpMetricsInterceptor } from './observability/http-metrics.interceptor';
import { LoggingModule } from './observability/logging.module';
import { ObservabilityModule } from './observability/observability.module';
import { RedisModule } from './redis/redis.module';
import { SecretsModule } from './secrets/secrets.module';

/**
 * Root module.
 *
 * Module boundaries follow `ARCHITECTURE.md` §4 — the modular monolith is
 * organized so that a module boundary is also a future service boundary. Phase 1
 * ships the platform foundation only; the communication modules (`comms-api`,
 * `orchestrator`, `provider-*`, ...) arrive in their own phases.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    ObservabilityModule,
    SecretsModule,
    DatabaseModule,
    AuditModule,
    RedisModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useValue: validationPipe() },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Correlation identity is established before any other middleware, guard or
    // handler runs, so nothing can log or fail without one.
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
