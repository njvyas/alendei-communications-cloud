/**
 * Phase 5.0 PR-C — the deployment-plane secrets of the provider webhook ingress, resolved
 * through SecretsPort (`SECURITY.md` §3) in this one file:
 *
 *   - `WEBHOOK_INGRESS_KEY_PEPPER_REF` — the server pepper of ingress-key hashes (OD-6);
 *   - `SIMULATOR_WEBHOOK_SIGNING_KEY_REF` — the simulator's NON-PRODUCTION receipt-signing
 *     key (spec §E.4). Not a provider credential: real provider credentials remain out of
 *     scope (Credential Reference Architecture, EX register).
 *
 * Global, so the providers module (key administration) and the provider-adapters module
 * (the simulator's key source, by token only) receive them without importing this module.
 * Both are resolved lazily, on first use — nothing is required while ingress is disabled.
 */
import { Global, HttpStatus, Inject, Injectable, Module } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';

import { AppException } from '../common/errors/app.exception';
import { AppConfigService } from '../config/app-config.service';
import { SECRETS_PORT, type SecretsPort } from '../secrets/secrets.port';
import { hashIngressKey } from './ingress-key';
import {
  SIMULATOR_WEBHOOK_KEY_SOURCE,
  WebhookSigningKeyUnavailable,
  type SimulatorWebhookKeySourceFn,
} from './simulator-webhook-key';

/** Resolves the pepper and hashes ingress keys with it. Never logs a key. */
@Injectable()
export class IngressKeyHasher {
  constructor(
    private readonly config: AppConfigService,
    @Inject(SECRETS_PORT) private readonly secrets: SecretsPort,
  ) {}

  /** `HMAC-SHA256(pepper, key)`; refuses (503) when no pepper is configured. */
  async hash(key: string): Promise<Buffer> {
    const reference = this.config.delivery.ingressKeyPepperRef;
    if (!reference) {
      throw new AppException({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ERROR_CODES.WEBHOOK_INGRESS_NOT_CONFIGURED,
        message: 'Webhook ingress keys are not configured on this deployment',
        retryable: false,
      });
    }
    return hashIngressKey(await this.secrets.resolve(reference), key);
  }
}

@Global()
@Module({
  providers: [
    IngressKeyHasher,
    {
      provide: SIMULATOR_WEBHOOK_KEY_SOURCE,
      inject: [AppConfigService, SECRETS_PORT],
      useFactory:
        (config: AppConfigService, secrets: SecretsPort): SimulatorWebhookKeySourceFn =>
        async () => {
          const reference = config.delivery.simulatorSigningKeyRef;
          if (!reference) throw new WebhookSigningKeyUnavailable();
          return new TextEncoder().encode(await secrets.resolve(reference));
        },
    },
  ],
  exports: [IngressKeyHasher, SIMULATOR_WEBHOOK_KEY_SOURCE],
})
export class WebhookKeyMaterialModule {}
