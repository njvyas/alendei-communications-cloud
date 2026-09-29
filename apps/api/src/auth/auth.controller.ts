import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';
import type { Request, Response } from 'express';

import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { AuthService, type AuthTokens, type RequestMeta } from './auth.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { LoginDto } from './auth.dto';
import { NoTenantContext, OptionalAuthentication, Public } from './public.decorator';
import { AuthorizationExempt } from './requires-permission.decorator';
import { RequireCsrfHeader, RequireJsonBody } from './csrf.guard';
import type { ResolvedPrincipal } from './auth.guard';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import {
  ApiData,
  ApiEmpty,
  ApiErrors,
  CLEARS_REFRESH_COOKIE,
  SETS_REFRESH_COOKIE,
} from '../openapi/openapi-responses';
import {
  AccessTokenSchema,
  EffectiveAuthorizationSchema,
  PrincipalSchema,
  RevokedCountSchema,
  SessionSchema,
} from '../openapi/openapi-schemas';
import { DocumentedRateLimitHeaders } from '../openapi/rate-limit-headers.decorator';

/** The cookie carrying the refresh token. Never readable by JavaScript. */
export const REFRESH_COOKIE = 'acc_refresh';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: AuthRateLimitService,
    private readonly config: AppConfigService,
  ) {}

  private meta(request: Request): RequestMeta {
    const store = RequestContext.get();
    return {
      ip: store?.ip ?? request.ip ?? null,
      userAgent: store?.userAgent ?? null,
      correlationId: store?.correlationId ?? 'no-correlation-id',
    };
  }

  private principal(): ResolvedPrincipal {
    const principal = RequestContext.get()?.principal as ResolvedPrincipal | null | undefined;
    if (!principal) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }
    return principal;
  }

  /**
   * Sets the refresh cookie (ADR-003 D-7).
   *
   * `httpOnly` so an XSS foothold cannot exfiltrate a 30-day credential;
   * `sameSite: lax` and a path scoped to `/auth` so it is not attached to
   * ordinary API calls; `secure` outside development, where there is no TLS to
   * carry it.
   */
  private setRefreshCookie(response: Response, token: string): void {
    response.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.appEnv !== 'development' && this.config.appEnv !== 'test',
      sameSite: 'lax',
      path: `/${this.config.http.globalPrefix}/auth`,
      maxAge: this.config.auth.refreshTokenTtlSeconds * 1000,
    });
  }

  private clearRefreshCookie(response: Response): void {
    response.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.config.appEnv !== 'development' && this.config.appEnv !== 'test',
      sameSite: 'lax',
      path: `/${this.config.http.globalPrefix}/auth`,
    });
  }

  /** The response body. Deliberately never contains the refresh token. */
  private body(tokens: AuthTokens) {
    return {
      data: {
        accessToken: tokens.accessToken,
        tokenType: 'Bearer' as const,
        expiresIn: tokens.expiresIn,
      },
    };
  }

  @Public()
  // Login-CSRF: a hostile page must not be able to sign a victim's browser into
  // an attacker's account with a cross-site form post (`RequireJsonBody`).
  @RequireJsonBody()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('none')
  @DocumentedRateLimitHeaders('bucket')
  @ApiOperation({ summary: 'Sign in' })
  @ApiData(AccessTokenSchema, {
    description: 'Signed in; sets the refresh cookie.',
    headers: SETS_REFRESH_COOKIE,
  })
  @ApiErrors(400, 401, 415, 429)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const meta = this.meta(request);
    const verdict = await this.rateLimit.consume({
      ip: meta.ip,
      accountIdentifier: dto.email.toLowerCase(),
    });

    response.setHeader('X-RateLimit-Limit', verdict.limit);
    response.setHeader('X-RateLimit-Remaining', verdict.remaining);

    if (!verdict.allowed) {
      response.setHeader('Retry-After', verdict.resetSeconds);
      throw new AppException({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message: 'Too many sign-in attempts; try again shortly',
      });
    }

    const tokens = await this.auth.login(dto.email, dto.password, meta);
    // The account bucket only — never the IP bucket (see `resetAccount`).
    await this.rateLimit.resetAccount(dto.email.toLowerCase());

    this.setRefreshCookie(response, tokens.refreshToken);
    return this.body(tokens);
  }

  /**
   * Rotates the refresh token.
   *
   * Public in the authentication sense — the access token has usually expired by
   * the time this is called, which is the whole point — but not unprotected: the
   * cookie is the credential, and `RequireCsrfHeader` forces a preflight that a
   * cross-site form post cannot satisfy.
   */
  @Public()
  @RequireCsrfHeader()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('refreshCookie')
  @DocumentedRateLimitHeaders('bucket')
  @ApiOperation({ summary: 'Rotate the refresh token' })
  @ApiData(AccessTokenSchema, {
    description: 'Rotated; sets the new refresh cookie. A refused rotation clears the cookie.',
    headers: SETS_REFRESH_COOKIE,
  })
  @ApiErrors(401, 403, 429)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    // Public, so the general per-principal limiter never sees this route; it is
    // throttled per source address here instead (Gate-B audit, Blocker 4).
    const verdict = await this.rateLimit.consumeRefresh(this.meta(request).ip);
    response.setHeader('X-RateLimit-Limit', verdict.limit);
    response.setHeader('X-RateLimit-Remaining', verdict.remaining);
    if (!verdict.allowed) {
      response.setHeader('Retry-After', verdict.resetSeconds);
      throw new AppException({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message: 'Too many refresh attempts; try again shortly',
      });
    }

    const presented = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!presented) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'No refresh credential was presented',
      });
    }

    try {
      const tokens = await this.auth.refresh(presented, this.meta(request));
      this.setRefreshCookie(response, tokens.refreshToken);
      return this.body(tokens);
    } catch (error) {
      // A refused rotation always clears the cookie: leaving a dead token in the
      // browser produces a client that retries forever against a revoked family.
      this.clearRefreshCookie(response);
      throw error;
    }
  }

  /**
   * Ends the caller's session (ADR-012 F-12).
   *
   * With a valid bearer token, the session it belongs to. Without one — the
   * usual case being an expired access token — the session the refresh cookie
   * belongs to; `X-Acc-Refresh` is required on both paths (`RequireCsrfHeader`).
   * The cookie path is unauthenticated, so it is throttled per source address
   * with the refresh bucket, like `/auth/refresh` itself. An unknown or
   * already-revoked cookie is answered exactly like a valid one: `204`, cookie
   * cleared.
   */
  @OptionalAuthentication()
  @NoTenantContext()
  @AuthorizationExempt(
    'identity: ends the caller’s own session — by bearer, or by the refresh cookie when no valid bearer is presented',
  )
  @RequireCsrfHeader()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AcceptedCredentials('userSession', 'apiKey', 'refreshCookie')
  @DocumentedRateLimitHeaders('general-or-bucket')
  @ApiOperation({
    summary: 'Sign out',
    description:
      'Ends the bearer session, or, without a valid bearer, the refresh cookie’s session. An API key has no session: `204`, nothing revoked. An unknown or already-revoked cookie is answered like a valid one.',
  })
  @ApiEmpty('Signed out; the refresh cookie is cleared.', CLEARS_REFRESH_COOKIE)
  @ApiErrors(401, 403, 429)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const meta = this.meta(request);
    const principal = RequestContext.get()?.principal ?? null;
    if (principal) {
      await this.auth.logout(principal, meta);
      this.clearRefreshCookie(response);
      return;
    }

    const presented = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!presented) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }

    const verdict = await this.rateLimit.consumeRefresh(meta.ip);
    response.setHeader('X-RateLimit-Limit', verdict.limit);
    response.setHeader('X-RateLimit-Remaining', verdict.remaining);
    if (!verdict.allowed) {
      response.setHeader('Retry-After', verdict.resetSeconds);
      throw new AppException({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message: 'Too many attempts; try again shortly',
      });
    }

    await this.auth.logoutWithRefreshToken(presented, meta);
    this.clearRefreshCookie(response);
  }

  /**
   * The current principal.
   *
   * Returns identity, tenancy and effective permissions — and no credential
   * material of any kind: no hashes, no tokens, no secret references.
   */
  @NoTenantContext()
  @AuthorizationExempt('identity: returns the caller’s own principal, which has no target scope')
  @Get('me')
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'The current principal' })
  @ApiData(PrincipalSchema)
  @ApiErrors(401, 429)
  me() {
    const principal = this.principal();
    return {
      data: {
        actorType: principal.actorType,
        authMethod: principal.authMethod,
        userId: principal.userId,
        apiKeyId: principal.apiKeyId,
        sessionId: principal.sessionId,
        authenticatedAt: principal.authenticatedAt.toISOString(),
        tenant: principal.tenant,
        authorizedOrganizationIds: principal.authorizedOrganizationIds,
        roles: principal.roles.map((r) => ({
          roleKey: r.roleKey,
          scopeType: r.scopeType,
          scopeId: r.scopeId,
          orgId: r.orgId,
        })),
        permissions: principal.permissions,
      },
    };
  }

  /**
   * The caller's own effective authorization (`API.md` §3c, Phase 1B.5.7).
   *
   * **Grants are returned as grants, never flattened.** A console cannot render
   * a correct permissions UI from a union, and handing it one is how the
   * flattened model ADR-005 removed from the backend gets reinvented in the
   * client. Each entry carries the scope its permissions are held at, so the
   * distinction that matters — holding `teams.create` in one workspace is not
   * holding it across the organization — survives the serialization.
   *
   * **Self-only, structurally.** The subject is `RequestContext`'s principal and
   * there is nowhere to name anyone else: no path segment, no query parameter,
   * no body. A cross-user variant would be an enumeration surface with no Phase
   * 1B consumer (`DECISIONS.md` D23), and the way to not build one is to leave
   * nowhere to put the identifier.
   *
   * It discloses nothing the caller could not already derive by attempting each
   * operation, exactly as `authorizedOrganizationIds` on `/auth/me` already
   * does — and no credential material of any kind.
   *
   * For an **API-key** principal these are the key's *effective* grants:
   * `AuthGuard` has already intersected its creator's authority at the key's own
   * binding scope (Phase 1B.5.1), so a permission the creator holds only
   * elsewhere is absent here exactly as it is absent everywhere else.
   */
  @NoTenantContext()
  @AuthorizationExempt(
    'identity: returns the caller’s own grants; the subject is the principal itself',
  )
  @Get('me/authorization')
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'The current principal’s effective grants' })
  @ApiData(EffectiveAuthorizationSchema)
  @ApiErrors(401, 429)
  authorization() {
    const principal = this.principal();
    return {
      data: {
        actorType: principal.actorType,
        userId: principal.userId,
        apiKeyId: principal.apiKeyId,
        grants: principal.roles.map((grant) => ({
          roleId: grant.roleId,
          roleKey: grant.roleKey,
          scopeType: grant.scopeType,
          scopeId: grant.scopeId,
          orgId: grant.orgId,
          permissions: [...grant.permissions].sort(),
        })),
        organizationIds: principal.authorizedOrganizationIds,
        isPlatformAdmin: principal.tenant.isPlatformAdmin,
      },
    };
  }

  @NoTenantContext()
  @AuthorizationExempt(
    'identity: lists the caller’s own sessions, scoped by user id rather than by tenant',
  )
  @Get('sessions')
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({
    summary: 'The caller’s live sessions',
    description: 'Always empty for an API key, which has no sessions.',
  })
  @ApiData(SessionSchema, { isArray: true })
  @ApiErrors(401, 429)
  async sessions() {
    const principal = this.principal();
    if (!principal.userId) return { data: [] };
    const sessions = await this.auth.listSessions(principal.userId, principal.sessionId);
    return {
      data: sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
        expiresAt: s.expiresAt.toISOString(),
        ip: s.ip,
        userAgent: s.userAgent,
        current: s.current,
      })),
    };
  }

  /**
   * Revokes every other live session of the caller, keeping the current one
   * (ADR-012 F-10). `200 {data:{revoked}}`, the count of live sessions revoked.
   */
  @NoTenantContext()
  @AuthorizationExempt(
    'identity: revokes the caller’s own other sessions; the subject is the principal itself',
  )
  @Post('sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession')
  @ApiOperation({ summary: 'Revoke every other session of the caller' })
  @ApiData(RevokedCountSchema)
  @ApiErrors(401, 403, 429)
  async revokeAllSessions(@Req() request: Request) {
    const revoked = await this.auth.revokeAllOwnSessions(this.principal(), this.meta(request));
    return { data: { revoked } };
  }

  @NoTenantContext()
  @AuthorizationExempt(
    'identity: revokes one of the caller’s own sessions; ownership is checked in AuthService',
  )
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AcceptedCredentials('userSession')
  @ApiOperation({
    summary: 'Revoke one of the caller’s sessions',
    description: 'An API key has no user, so it is `401`.',
  })
  @ApiEmpty()
  @ApiErrors(400, 401, 404, 429)
  async revokeSession(
    @Param('id', new ParseUUIDPipe({ version: undefined })) id: string,
    @Req() request: Request,
  ) {
    await this.auth.revokeSession(this.principal(), id, this.meta(request));
  }
}
