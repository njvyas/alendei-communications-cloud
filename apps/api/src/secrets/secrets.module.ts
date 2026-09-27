import { Global, Logger, Module, type Provider } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { EnvSecretsAdapter } from './env-secrets.adapter';
import { SECRETS_PORT, type SecretsPort } from './secrets.port';

const secretsProvider: Provider = {
  provide: SECRETS_PORT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): SecretsPort => {
    const backend = config.secrets.backend;
    if (backend === 'env') {
      return new EnvSecretsAdapter();
    }
    // Deliberately a hard failure rather than a silent fallback to `env`: a
    // deployment that asks for a managed backend must get one.
    throw new Error(
      `SECRETS_BACKEND="${backend}" is configured but no adapter is implemented for it yet. ` +
        'Phase 1 ships only the "env" backend (SECURITY.md §3).',
    );
  },
};

@Global()
@Module({
  providers: [secretsProvider],
  exports: [SECRETS_PORT],
})
export class SecretsModule {
  private readonly logger = new Logger(SecretsModule.name);

  constructor(private readonly config: AppConfigService) {
    this.logger.log(`Secrets backend: ${this.config.secrets.backend}`);
  }
}
