import { Module } from '@nestjs/common';

import { ProviderAdaptersModule } from '../provider-adapters/provider-adapters.module';
import { DeliveryIngestionService } from './delivery-ingestion.service';
import { ProviderWebhooksController } from './provider-webhooks.controller';
import { WebhookIngressService } from './webhook-ingress.service';
import { WebhookRateLimiter } from './webhook-rate-limiter';

/**
 * Phase 5.0 PR-C — provider webhook ingress (design spec Rev 2 §E; implementation plan T8).
 * Off unless `DELIVERY_WEBHOOKS_ENABLED=true`. Its secrets (key pepper, simulator signing
 * key) live in the global `WebhookKeyMaterialModule`.
 */
@Module({
  imports: [ProviderAdaptersModule],
  controllers: [ProviderWebhooksController],
  providers: [WebhookIngressService, DeliveryIngestionService, WebhookRateLimiter],
})
export class WebhooksModule {}
