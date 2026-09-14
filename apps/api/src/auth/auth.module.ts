import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { IamModule } from '../iam/iam.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthService } from './auth.service';
import { AuthorizationService } from './authorization.service';
import { CsrfGuard } from './csrf.guard';
import { AccessTokenService } from './jwt.service';
import { PermissionEvaluator } from './permission-evaluator.service';
import { ScopeChainResolver } from './scope-chain-resolver.service';
import { ScopeResolver } from './scope-resolver.service';

/**
 * Authentication and request-context module (`ARCHITECTURE.md` §4: `iam`).
 *
 * Both guards are registered globally and in a fixed order. That order is a
 * security property, not a detail: `CsrfGuard` runs first so a cookie-bearing
 * cross-site request is refused before any credential work happens, then
 * `AuthGuard` establishes identity and tenancy. Registering `AuthGuard` globally
 * is what makes the API deny by default — a new endpoint is protected unless
 * someone writes `@Public()`, rather than exposed unless someone remembers a
 * decorator.
 */
@Global()
@Module({
  imports: [IamModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    ScopeResolver,
    ScopeChainResolver,
    PermissionEvaluator,
    AuthorizationService,
    AuthRateLimitService,
    AuthService,
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [
    AccessTokenService,
    ScopeResolver,
    ScopeChainResolver,
    PermissionEvaluator,
    AuthorizationService,
    AuthService,
  ],
})
export class AuthModule {}
