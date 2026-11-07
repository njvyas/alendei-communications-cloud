/**
 * Phase 5.0 PR-C (implementation plan T9) — administration of a provider's webhook ingress:
 * its ingress key and its per-provider kill switch (OD-6, OD-12). Platform only:
 * `providers.manage`, like every provider configuration change.
 *
 * - `issueKey` creates the provider's first ingress key or rotates it. The plaintext key is
 *   returned exactly once, in this response, and never again: only HMAC-SHA256(pepper, key)
 *   is stored (`IngressKeyHasher`). On rotation the outgoing key's hash stays valid until
 *   now + `WEBHOOK_KEY_ROTATION_GRACE_SECONDS` (default 24 h), so a provider can switch
 *   over without losing receipts; then it is refused.
 * - `setEnabled` switches the provider's ingress on or off. On requires a key.
 *
 * Every change is audited (`provider.webhook_ingress_key_rotated`, `…_enabled`,
 * `…_disabled`, migration 0044's exact-shape policy) — never with the key or a hash.
 * The key is never logged. Enabling a provider's ingress does not enable the ingress itself:
 * `DELIVERY_WEBHOOKS_ENABLED` stays the deployment-wide switch (OD-19).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS, ERROR_CODES, PERMISSIONS, type AuthPrincipal } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { AppConfigService } from '../config/app-config.service';
import { TenantDatabase } from '../database/tenant-database.service';
import { generateIngressKey } from '../webhooks/ingress-key';
import { IngressKeyHasher } from '../webhooks/webhook-key-material.module';
import { INGRESS_ROUTE_TEMPLATE } from '../webhooks/ingress-path';
import { ProviderAccess } from './provider-access.service';
import { loadProvider } from './provider-views';

/** A provider's ingress state — never a key or a hash. */
export interface ProviderWebhookIngressView {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly keyConfigured: boolean;
  readonly keyRotatedAt: string | null;
  /** While set and in the future, the previous key is still accepted (rotation grace). */
  readonly previousKeyValidUntil: string | null;
}

/** The one response that ever carries the plaintext key. */
export interface ProviderWebhookIngressKeyView extends ProviderWebhookIngressView {
  readonly key: string;
  /** Where the provider posts: the route with `:providerKey` replaced by `key`. */
  readonly ingressPathTemplate: string;
}

type ProviderRow = typeof schema.providers.$inferSelect;

function view(row: ProviderRow): ProviderWebhookIngressView {
  const previous = row.webhookIngressKeyPreviousExpiresAt;
  return {
    providerId: row.id,
    enabled: row.webhookIngressEnabled,
    keyConfigured: row.webhookIngressKeyHash !== null,
    keyRotatedAt: row.webhookIngressKeyRotatedAt?.toISOString() ?? null,
    previousKeyValidUntil: previous && previous > new Date() ? previous.toISOString() : null,
  };
}

/** The audit snapshot of the ingress state: no key, no hash. */
function auditState(row: ProviderRow): Record<string, unknown> {
  const { providerId: _id, ...state } = view(row);
  return state;
}

@Injectable()
export class ProviderWebhookIngressService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly access: ProviderAccess,
    private readonly hasher: IngressKeyHasher,
    private readonly config: AppConfigService,
  ) {}

  /** Creates or rotates the provider's ingress key; the plaintext is in this result only. */
  async issueKey(principal: AuthPrincipal, id: string): Promise<ProviderWebhookIngressKeyView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      const before = await loadProvider(tx, id, { forUpdate: true });
      const key = generateIngressKey();
      const hash = await this.hasher.hash(key);
      const now = new Date();
      const previousHash = before.webhookIngressKeyHash ?? null;
      const [row] = await tx
        .update(schema.providers)
        .set({
          webhookIngressKeyHash: hash,
          webhookIngressKeyPreviousHash: previousHash,
          webhookIngressKeyPreviousExpiresAt: previousHash
            ? new Date(now.getTime() + this.config.delivery.keyRotationGraceSeconds * 1000)
            : null,
          webhookIngressKeyRotatedAt: now,
        })
        .where(eq(schema.providers.id, id))
        .returning();
      await this.access.record(
        tx,
        principal,
        AUDIT_ACTIONS.PROVIDER_WEBHOOK_INGRESS_KEY_ROTATED,
        id,
        auditState(before),
        auditState(row!),
      );
      return { ...view(row!), key, ingressPathTemplate: INGRESS_ROUTE_TEMPLATE };
    });
  }

  /** Switches the provider's ingress on or off (OD-12). Idempotent; on requires a key. */
  async setEnabled(
    principal: AuthPrincipal,
    id: string,
    enabled: boolean,
  ): Promise<ProviderWebhookIngressView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      const before = await loadProvider(tx, id, { forUpdate: true });
      if (enabled && before.webhookIngressKeyHash === null) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.WEBHOOK_INGRESS_KEY_REQUIRED,
          message: 'Create an ingress key for this provider before enabling its webhook ingress',
          retryable: false,
        });
      }
      if (before.webhookIngressEnabled === enabled) return view(before);
      const [row] = await tx
        .update(schema.providers)
        .set({ webhookIngressEnabled: enabled })
        .where(eq(schema.providers.id, id))
        .returning();
      await this.access.record(
        tx,
        principal,
        enabled
          ? AUDIT_ACTIONS.PROVIDER_WEBHOOK_INGRESS_ENABLED
          : AUDIT_ACTIONS.PROVIDER_WEBHOOK_INGRESS_DISABLED,
        id,
        auditState(before),
        auditState(row!),
      );
      return view(row!);
    });
  }
}
