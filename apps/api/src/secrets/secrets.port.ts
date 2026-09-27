/**
 * Secrets abstraction (`SECURITY.md` §3).
 *
 * Application code resolves secrets through this port and never reads raw secret
 * material directly, so the backing store (Vault, AWS Secrets Manager + KMS,
 * Azure Key Vault, GCP Secret Manager) is swappable per environment without a
 * code change. Configuration holds *references* of the form `<backend>:<locator>`.
 */
export const SECRETS_PORT = Symbol('SECRETS_PORT');

export interface SecretsPort {
  /** Resolves a `<backend>:<locator>` reference to its secret value. */
  resolve(reference: string): Promise<string>;
  /** The backend this instance is backed by, for startup reporting. */
  readonly backend: string;
}

export class SecretResolutionError extends Error {
  constructor(reference: string, reason: string) {
    // The reference (a locator, not a secret) is safe to name; the value is not.
    super(`Unable to resolve secret reference "${reference}": ${reason}`);
    this.name = 'SecretResolutionError';
  }
}

export function parseSecretReference(reference: string): { backend: string; locator: string } {
  const separator = reference.indexOf(':');
  if (separator <= 0 || separator === reference.length - 1) {
    throw new SecretResolutionError(reference, 'expected the form "<backend>:<locator>"');
  }
  return {
    backend: reference.slice(0, separator).toLowerCase(),
    locator: reference.slice(separator + 1),
  };
}
