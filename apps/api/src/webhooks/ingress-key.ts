/**
 * Phase 5.0 PR-C — provider webhook ingress keys (design spec Rev 2 §C.1(5), §E.2; OD-6).
 *
 * A key is 32 random bytes, base64url (43 characters, 256 bits — above the spec's 128-bit
 * floor). It is shown once, at creation or rotation, and never stored: the database holds
 * only `HMAC-SHA256(pepper, key)`, where the pepper is a server secret resolved through
 * SecretsPort (`WEBHOOK_INGRESS_KEY_PEPPER_REF`). A database copy alone therefore cannot
 * test candidate keys. The hash is 32 bytes, as migration 0044's CHECK requires.
 * Pure functions only; the pepper is resolved in `webhook-key-material.module.ts`.
 */
import { createHmac, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
/** The longest path segment ever hashed; anything longer is refused without a lookup. */
export const MAX_INGRESS_KEY_LENGTH = 128;

/** A fresh ingress key: 256 random bits, URL-safe. */
export function generateIngressKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url');
}

/** `HMAC-SHA256(pepper, key)` — the only form in which a key is ever stored or looked up. */
export function hashIngressKey(pepper: string, key: string): Buffer {
  return createHmac('sha256', pepper).update(key, 'utf8').digest();
}
