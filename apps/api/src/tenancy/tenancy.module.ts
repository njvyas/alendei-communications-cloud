import { Module } from '@nestjs/common';

import { TenancyController } from './tenancy.controller';

/**
 * Tenancy read surface (`ARCHITECTURE.md` §4: `tenancy`).
 *
 * Phase 1B.3 ships only what makes the authentication-to-RLS chain provable
 * over HTTP. The administration endpoints arrive in Phase 1B.6.
 */
@Module({ controllers: [TenancyController] })
export class TenancyModule {}
