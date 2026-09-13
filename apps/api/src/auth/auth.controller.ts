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
import { NoTenantContext, Public } from './public.decorator';
import { RequireCsrfHeader } from './csrf.guard';
import type { ResolvedPrincipal } from './auth.guard';

/** The cookie carrying the refresh token. Never readable by JavaScript. */
export const REFRESH_COOKIE = 'acc_refresh';

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
      accessToken: tokens.accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: tokens.expiresIn,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
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
    await this.rateLimit.reset({ ip: meta.ip, accountIdentifier: dto.email.toLowerCase() });

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
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
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

  @NoTenantContext()
  @RequireCsrfHeader()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(this.principal(), this.meta(request));
    this.clearRefreshCookie(response);
  }

  /**
   * The current principal.
   *
   * Returns identity, tenancy and effective permissions — and no credential
   * material of any kind: no hashes, no tokens, no secret references.
   */
  @NoTenantContext()
  @Get('me')
  me() {
    const principal = this.principal();
    return {
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
    };
  }

  @NoTenantContext()
  @Get('sessions')
  async sessions() {
    const principal = this.principal();
    if (!principal.userId) return { sessions: [] };
    const sessions = await this.auth.listSessions(principal.userId, principal.sessionId);
    return {
      sessions: sessions.map((s) => ({
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

  @NoTenantContext()
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @Param('id', new ParseUUIDPipe({ version: undefined })) id: string,
    @Req() request: Request,
  ) {
    await this.auth.revokeSession(this.principal(), id, this.meta(request));
  }
}
