import { Module } from '@nestjs/common';

import { IamModule } from '../iam/iam.module';
import { ApiKeyAdministrationService } from './api-key-administration.service';
import { ApiKeysController } from './api-keys.controller';

/**
 * API-key administration (Phase 1B.6.2).
 *
 * Its own module for the same structural reason `users` is: `AuthModule`
 * imports `IamModule` for the credential primitives the guard needs, so a
 * control-plane controller placed there would risk closing a cycle. It imports
 * `IamModule` for `CredentialService` — the same Argon2id parameters that hash
 * passwords hash API-key secrets, so there is one credential-hashing policy
 * rather than two.
 *
 * It owns administration only. **Authentication of API keys stays in
 * `AuthGuard`**, where it has been since Phase 1B.3, including the creator
 * intersection at the binding scope and the creator-status check added in
 * 1B.6.1. Nothing here re-implements any of it.
 *
 * `AuthorizationService`, `AuditWriter`, `TenantDatabase`, `ListQuery`,
 * `IdempotencyService` and `AppConfigService` all arrive from `@Global()`
 * modules and are deliberately not re-imported.
 */
@Module({
  imports: [IamModule],
  controllers: [ApiKeysController],
  providers: [ApiKeyAdministrationService],
  exports: [ApiKeyAdministrationService],
})
export class ApiKeysModule {}
