import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';

import { CorrelationMiddleware } from './common/context/correlation.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { validationPipe } from './common/http/validation.pipe';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AuditModule } from './audit/audit.module';
import { AuditReadModule } from './audit-read/audit-read.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { HttpConventionsModule } from './common/http/http.module';
import { IamModule } from './iam/iam.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { HttpMetricsInterceptor } from './observability/http-metrics.interceptor';
import { LoggingModule } from './observability/logging.module';
import { ObservabilityModule } from './observability/observability.module';
import { RbacModule } from './rbac/rbac.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { RedisModule } from './redis/redis.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { UsersModule } from './users/users.module';
import { SecretsModule } from './secrets/secrets.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ProvidersModule } from './providers/providers.module';
import { ContactsModule } from './contacts/contacts.module';
import { TemplatesModule } from './templates/templates.module';
import { SuppressionsModule } from './suppressions/suppressions.module';
import { MessagesModule } from './messages/messages.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { PlatformSupportModule } from './platform-support/platform-support.module';
import { WebhookKeyMaterialModule } from './webhooks/webhook-key-material.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { BillingModule } from './billing/billing.module';
import { OPENAPI_MODULES } from './openapi/openapi.module';

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
    HttpConventionsModule,
    DatabaseModule,
    AuditModule,
    IamModule,
    IdempotencyModule,
    AuthModule,
    RedisModule,
    RateLimitModule,
    HealthModule,
    TenancyModule,
    RbacModule,
    UsersModule,
    ApiKeysModule,
    AuditReadModule,
    OrganizationsModule,
    WorkspacesModule,
    ProvidersModule,
    ContactsModule,
    TemplatesModule,
    SuppressionsModule,
    MessagesModule,
    CampaignsModule,
    PlatformSupportModule,
    // Phase 5.0 PR-C: provider webhook ingress — disabled unless DELIVERY_WEBHOOKS_ENABLED.
    WebhookKeyMaterialModule,
    WebhooksModule,
    // Phase 7 PR 7-1: the ledger partition startup check only (no routes).
    BillingModule,
    // The OpenAPI document route, when `OPENAPI_UI_ENABLED` is on (Phase 1C.3).
    ...OPENAPI_MODULES,
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
