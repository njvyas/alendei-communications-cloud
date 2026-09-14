import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AdvisoryTenantGuard } from './advisory-tenant.guard';
import { TenancyController } from './tenancy.controller';

/**
 * Tenancy read surface and advisory-identifier cross-check
 * (`ARCHITECTURE.md` §4: `tenancy`).
 *
 * `AdvisoryTenantGuard` is registered globally so the cross-check is available
 * to every handler, present and future, by declaring `@AdvisoryTenantIds()` and
 * nothing else. It is registered after `AuthModule`'s guards, which is what
 * puts it downstream of the principal it compares against; registering it here
 * rather than in `AuthModule` keeps tenancy consistency separate from
 * authentication, which is the boundary ADR-004 draws.
 *
 * Phase 1B.3 shipped only the read surface that makes the authentication-to-RLS
 * chain provable over HTTP. The administration endpoints arrive in Phase 1B.6.
 */
@Module({
  controllers: [TenancyController],
  providers: [{ provide: APP_GUARD, useClass: AdvisoryTenantGuard }],
})
export class TenancyModule {}
