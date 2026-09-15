import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';

import { RequestContext } from '../common/context/request-context';
import { REQUIRES_PERMISSION, type RequiredPermission } from './requires-permission.decorator';

/**
 * Verifies that a route which declared a permission actually checked it
 * (Phase 1B.5.7).
 *
 * **Why this exists, and what it is not.** `@RequiresPermission` cannot enforce
 * from a guard: the chain a decision rests on must be read inside the request's
 * own tenant transaction (ADR-005 D-5), which does not exist until the handler
 * opens it. Enforcement therefore stays in `AuthorizationService.assert`, inside
 * that transaction, before any mutation. The gap that leaves is a handler that
 * declares a permission and then forgets to ask for it — which review catches
 * unreliably and nothing else catches at all.
 *
 * This closes that gap at runtime by comparing the declaration against the
 * checks `AuthorizationService` recorded. Stated precisely, because the
 * difference matters:
 *
 *   - For a **read**, the response is suppressed before it reaches the caller,
 *     so no unauthorized data is disclosed.
 *   - For a **mutation**, the write has already committed by the time this runs.
 *     The response still fails closed and the operator gets a loud error, but
 *     the guarantee that a mutation was authorized comes from the service's own
 *     check running before it — not from here. The structural guarantee is §6n
 *     case 30's route-table assertion, which fails the build rather than the
 *     request.
 *
 * It never authorizes anything. It compares what was declared with what was
 * done, and a mismatch is a programming error reported as one.
 */
@Injectable()
export class AuthorizationCoverageInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuthorizationCoverageInterceptor.name);

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const required = this.reflector.getAllAndOverride<RequiredPermission | undefined>(
      REQUIRES_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return next.handle();

    return next.handle().pipe(
      map((body) => {
        const performed = RequestContext.authorizationChecks();
        if (performed.includes(String(required.permission))) return body;

        // Deliberately not an `AppException` with a specific code: this is not a
        // condition a caller can do anything about, and naming it would tell an
        // attacker which route is misconfigured. The exception filter renders it
        // as a generic `500` carrying only the correlation id.
        this.logger.error({
          msg: 'route declared a permission it never checked — failing closed',
          route: `${context.getClass().name}.${context.getHandler().name}`,
          declared: required.permission,
          target: required.target,
          performed,
        });
        throw new Error('authorization coverage: declared permission was never checked');
      }),
    );
  }
}
