import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@acc/contracts';
import type { Request } from 'express';

import { AppException } from '../common/errors/app.exception';

export const REQUIRE_CSRF = 'acc:auth:require-csrf';

/** The non-simple header that forces a CORS preflight (`API.md` §3b). */
export const CSRF_HEADER = 'x-acc-refresh';

/**
 * Marks an endpoint whose authority comes from a cookie rather than from an
 * `Authorization` header, and which therefore needs CSRF protection.
 */
export const RequireCsrfHeader = () => SetMetadata(REQUIRE_CSRF, true);

/**
 * CSRF protection for the cookie-authenticated endpoints (`API.md` §3b).
 *
 * `/auth/refresh` and `/auth/logout` are the only endpoints whose authority can
 * come from an ambient credential the browser attaches automatically, which is
 * precisely the shape CSRF exploits. `SameSite=Lax` mitigates it but does not
 * close it — it is not honoured uniformly by older agents and does not cover
 * same-site attacker-controlled content — so a custom header is additionally
 * required.
 *
 * The mechanism is the absence of a token, not the presence of one: a custom
 * header makes the request "non-simple", so a cross-origin caller must pass a
 * CORS preflight that the origin allowlist will refuse. An HTML form post, the
 * classic CSRF vector, cannot set a header at all.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_CSRF, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[CSRF_HEADER];
    const present = Array.isArray(header) ? header.length > 0 : typeof header === 'string';

    if (!present) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
        message: `This endpoint requires the ${CSRF_HEADER} header`,
      });
    }
    return true;
  }
}
