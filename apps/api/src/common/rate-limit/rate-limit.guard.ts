import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@acc/contracts';
import type { Request, Response } from 'express';

import { AppException } from '../errors/app.exception';
import { RequestContext } from '../context/request-context';
import { RateLimitService } from './rate-limit.service';
import { RATE_LIMIT_CLASS, endpointClassFor, type RateLimitClass } from './rate-limit.decorator';

/**
 * The general rate limiter's admission point (`API.md` §5, Phase 1B.6.4).
 *
 * **A guard rather than an interceptor**, and the distinction is the whole
 * point: an interceptor wraps the handler, so the work would already be under
 * way before the verdict existed. A throttle has to decide *admission*, which is
 * what a guard does.
 *
 * It is registered after `AuthGuard` so the principal it keys on has already
 * been resolved from a verified credential. That ordering is not incidental —
 * without it the guard would see no principal and silently limit nothing.
 *
 * ---
 *
 * **What is not limited, and why it needs no exemption list.** The bucket key
 * requires an authenticated principal, so a request without one cannot be
 * bucketed at all and is passed through. That single structural rule covers
 * every case the specification calls out, without a list anyone has to remember
 * to maintain:
 *
 *   - `POST /auth/login` and `/auth/refresh` are `@Public()`. They resolve no
 *     principal here and keep their own stricter buckets in
 *     `AuthRateLimitService`, which this phase does not touch. **No request is
 *     charged to both limiters** (`API.md` §5).
 *   - `/health`, `/health/live`, `/health/ready` and `/metrics` are `@Public()`.
 *     Probes and scrapers must never be throttled, and they are not.
 *
 * A future authenticated route that must be exempt would need a decorator and a
 * recorded reason; none exists today, and one is not added speculatively.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    // No authenticated principal — a public route, or one refused upstream.
    // There is no key to build, so there is nothing to limit.
    const principal = RequestContext.get()?.principal;
    if (!principal) return true;

    // The principal's own id, from the credential `AuthGuard` verified. An
    // API-key request is bucketed by its key id, so a key gets its own budget
    // rather than drawing on its creator's — the same separation the binding
    // scope already gives it for authorization (`RBAC.md` §5c).
    const principalId = principal.userId ?? principal.apiKeyId;
    if (!principalId) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // Server-side metadata only: an explicit `@RateLimit()` on the route, else
    // the HTTP method Nest matched. Nothing the caller sent is consulted.
    const declared = this.reflector.getAllAndOverride<RateLimitClass | undefined>(
      RATE_LIMIT_CLASS,
      [context.getHandler(), context.getClass()],
    );
    const endpointClass = declared ?? endpointClassFor(request.method);

    const verdict = await this.limiter.consume({
      // The resolved organization, from the authenticated tenant context — not
      // from `X-Acc-Organization`, which `AuthGuard` has already validated
      // against the principal's scope set, and not from any other header.
      orgId: principal.tenant.orgId,
      principalId,
      endpointClass,
    });

    response.setHeader('X-RateLimit-Limit', verdict.limit);
    response.setHeader('X-RateLimit-Remaining', verdict.remaining);
    // Seconds until the window resets, matching `Retry-After`'s unit so a client
    // never has to guess whether a value is a duration or a timestamp.
    response.setHeader('X-RateLimit-Reset', verdict.resetSeconds);

    if (verdict.allowed) return true;

    response.setHeader('Retry-After', verdict.resetSeconds);
    throw new AppException({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
      message: 'Rate limit exceeded; retry after the interval in Retry-After',
      // The envelope is unchanged (`API.md` §7). `retryable` comes from the
      // code's own classification — `RATE_LIMIT_EXCEEDED` is already in
      // `RETRYABLE_ERROR_CODES` — rather than being asserted here.
      details: { retryAfterSeconds: verdict.resetSeconds },
      logContext: { endpointClass, orgId: principal.tenant.orgId },
    });
  }
}
