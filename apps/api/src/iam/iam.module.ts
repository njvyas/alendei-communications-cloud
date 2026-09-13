import { Module } from '@nestjs/common';

import { CredentialService } from './credential.service';
import { SessionService } from './session.service';
import { UserLifecycleService } from './user-lifecycle.service';

/**
 * Identity and access module (`ARCHITECTURE.md` §4: `iam`).
 *
 * Phase 1B.2 ships the persistence and credential foundation only — hashing,
 * session lifecycle, refresh rotation and user state transitions. The request
 * pipeline that uses them (`AuthGuard`, login/refresh/logout, API-key
 * authentication) is Phase 1B.3, and nothing here presumes its shape.
 */
@Module({
  providers: [CredentialService, SessionService, UserLifecycleService],
  exports: [CredentialService, SessionService, UserLifecycleService],
})
export class IamModule {}
