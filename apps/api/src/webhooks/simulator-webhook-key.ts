/**
 * Phase 5.0 PR-C — the injection token for the simulator's receipt-signing key source.
 *
 * The key is resolved through SecretsPort in the deployment plane
 * (`webhook-key-material.module.ts`); provider code only receives this function and never
 * reaches the secrets module (D-2, `credential-absence.architecture.spec.ts`).
 */
export const SIMULATOR_WEBHOOK_KEY_SOURCE = Symbol('SIMULATOR_WEBHOOK_KEY_SOURCE');

/** Resolves the simulator's non-production signing key; throws when none is configured. */
export type SimulatorWebhookKeySourceFn = () => Promise<Uint8Array>;

/** No simulator signing key is configured (`SIMULATOR_WEBHOOK_SIGNING_KEY_REF` unset). */
export class WebhookSigningKeyUnavailable extends Error {
  constructor() {
    super('webhook signing key is not configured');
    this.name = 'WebhookSigningKeyUnavailable';
  }
}
