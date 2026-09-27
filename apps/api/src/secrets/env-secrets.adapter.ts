import { Injectable } from '@nestjs/common';

import { parseSecretReference, SecretResolutionError, type SecretsPort } from './secrets.port';

/**
 * Development/test secrets backend: resolves `env:VAR_NAME` from the process
 * environment.
 *
 * This backend is rejected at startup when `APP_ENV=production`
 * (`config/env.schema.ts`), because `SECURITY.md` §3 requires production secret
 * material to live in a secrets manager rather than the environment.
 */
@Injectable()
export class EnvSecretsAdapter implements SecretsPort {
  readonly backend = 'env';

  private readonly cache = new Map<string, string>();

  async resolve(reference: string): Promise<string> {
    const cached = this.cache.get(reference);
    if (cached !== undefined) return cached;

    const { backend, locator } = parseSecretReference(reference);
    if (backend !== this.backend) {
      throw new SecretResolutionError(
        reference,
        `this deployment is configured with the "${this.backend}" secrets backend`,
      );
    }

    const value = process.env[locator];
    if (value === undefined || value.trim() === '') {
      throw new SecretResolutionError(reference, `environment variable ${locator} is not set`);
    }
    if (value.length < 32) {
      throw new SecretResolutionError(
        reference,
        `environment variable ${locator} is shorter than the 32-character minimum`,
      );
    }

    this.cache.set(reference, value);
    return value;
  }
}
