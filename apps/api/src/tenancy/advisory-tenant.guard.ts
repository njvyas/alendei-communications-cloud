import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, type AuthPrincipal } from '@acc/contracts';
import type { Request } from 'express';

import { AppException, ValidationFailedException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import {
  ADVISORY_TENANT_IDS,
  admissibleAdvisoryIds,
  normalizeAdvisoryValue,
  type AdvisoryIdentifierSpec,
} from './advisory-identifier';

/**
 * The one place a client-supplied tenant identifier is cross-checked
 * (`TENANCY.md` §2b, ADR-004).
 *
 * It runs after `AuthGuard`, which is the only point at which both halves of
 * the comparison exist: the authoritative context the server derived, and the
 * advisory identifier the client sent. Being a guard also means it runs before
 * the handler — a request whose identifier contradicts its context never
 * reaches code that could act on either one.
 *
 * Ordering is fail-closed rather than assumed. If this guard ever ran before
 * `AuthGuard`, no principal would be in `RequestContext` and every declaring
 * route would refuse with `401` — loudly, rather than by silently skipping the
 * check.
 *
 * It replaces the hand-written comparison that previously lived in
 * `TenancyController`. That is the point: per-handler copies of this logic are
 * how one endpoint ends up with the check and the next one without it, and the
 * gap is invisible in review because nothing is *wrong* in either file.
 */
@Injectable()
export class AdvisoryTenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const specs = this.reflector.getAllAndOverride<AdvisoryIdentifierSpec[] | undefined>(
      ADVISORY_TENANT_IDS,
      [context.getHandler(), context.getClass()],
    );
    if (!specs || specs.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const principal = RequestContext.get()?.principal;
    if (!principal) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }

    for (const spec of specs) this.crossCheck(principal, request, spec);
    return true;
  }

  private crossCheck(
    principal: AuthPrincipal,
    request: Request,
    spec: AdvisoryIdentifierSpec,
  ): void {
    const supplied = normalizeAdvisoryValue(this.read(request, spec));

    switch (supplied.state) {
      case 'absent':
        if (spec.required) {
          throw new AppException({
            status: HttpStatus.BAD_REQUEST,
            code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
            message: `A ${spec.level} identifier is required for this request`,
          });
        }
        return;

      case 'ambiguous':
      case 'malformed':
        // The parameter name is echoed; the value never is.
        throw new ValidationFailedException({
          parameter: spec.key,
          reason:
            supplied.state === 'ambiguous' ? 'must_be_a_single_value' : 'must_be_an_identifier',
        });

      case 'ok':
        break;
    }

    if (!principal.tenant.orgId) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
        message: 'No organization context is established for this request',
      });
    }

    const admissible = admissibleAdvisoryIds(principal, spec.level);
    if (admissible === null || admissible.includes(supplied.value)) return;

    throw new AppException({
      status: HttpStatus.FORBIDDEN,
      code: ERROR_CODES.TENANCY_CONTEXT_MISMATCH,
      // Never substituted, never filtered to an empty result, and never
      // confirming whether the identifier names anything that exists.
      message: `The requested ${spec.level} does not match your resolved context`,
      logContext: { parameter: spec.key, level: spec.level, suppliedId: supplied.value },
    });
  }

  private read(request: Request, spec: AdvisoryIdentifierSpec): unknown {
    switch (spec.source) {
      case 'query':
        return (request.query as Record<string, unknown> | undefined)?.[spec.key];
      case 'param':
        return (request.params as Record<string, unknown> | undefined)?.[spec.key];
      case 'body':
        return (request.body as Record<string, unknown> | undefined)?.[spec.key];
      case 'header':
        return request.headers[spec.key.toLowerCase()];
    }
  }
}
