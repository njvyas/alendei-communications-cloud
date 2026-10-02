import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@acc/contracts';

export const REQUIRES_PERMISSION = 'acc:authz:requires-permission';

/**
 * How a route's authorization target is derived.
 *
 * `organization` — the target is the request's own resolved organization. This
 * is the shape almost every administration route has: the resource lives in the
 * caller's organization and the question is whether the caller may act there.
 *
 * `deferred` — the target cannot be known before the handler runs. Two routes
 * are genuinely like this: granting a role targets **the scope named in the
 * body**, and revoking one targets **the scope on the stored row**. Neither is
 * knowable from route metadata, and guessing either would be the forged-target
 * defect ADR-005 D-5 exists to prevent.
 */
export type AuthorizationTargetKind = 'organization' | 'deferred';

export interface RequiredPermission {
  readonly permission: PermissionKey | string;
  readonly target: AuthorizationTargetKind;
  /** Why the target is deferred. Required for `deferred`, so the exception is argued rather than assumed. */
  readonly because?: string;
}

/**
 * Declares the permission a route requires (`RBAC.md` §2a, Phase 1B.5.7).
 *
 * **This is a declaration, not the enforcement.** That distinction is forced by
 * ADR-005 D-5, and it is worth stating plainly because the opposite is the
 * obvious design:
 *
 *   The chain a coverage decision rests on must be read inside **the request's
 *   own tenant transaction** — the same `SET LOCAL` transaction the business
 *   query runs in — so RLS filters it and an out-of-tenant target is invisible
 *   rather than merely unauthorized.
 *
 * A Nest guard runs before the handler and therefore before that transaction
 * exists. A guard that authorized would have to open a transaction of its own,
 * which puts the decision and the mutation in two different transactions and
 * opens a window between them in which a grant can be revoked. That is a
 * time-of-check/time-of-use defect, and it is the reason 1B.5.2 deferred this
 * decorator rather than shipping a guard that looked right.
 *
 * So the enforcement stays where it is correct — `AuthorizationService.assert`,
 * inside the handler's transaction, before the mutation — and this decorator
 * provides the two things that were actually missing:
 *
 *   1. **Declaration.** The required permission is visible on the route instead
 *      of buried in a service, so §6n case 30 can assert coverage against the
 *      registered route table rather than by review.
 *   2. **A runtime cross-check.** `AuthorizationCoverageInterceptor` verifies
 *      that the declared permission was actually asserted during the request,
 *      and fails the response closed if it was not; `TenantDatabase` repeats
 *      the comparison before a writing transaction commits, so an unchecked
 *      mutation rolls back.
 *
 * What the runtime cross-check does and does not buy is stated exactly in
 * `SECURITY.md`: it suppresses an unauthorized *response* and contains an
 * unchecked *write*, and the authorization guarantee remains the route-table
 * assertion plus the service's own check, which runs before the write.
 */
export const RequiresPermission = (
  permission: PermissionKey | string,
  options: { target?: AuthorizationTargetKind; because?: string } = {},
) =>
  SetMetadata<string, RequiredPermission>(REQUIRES_PERMISSION, {
    permission,
    target: options.target ?? 'organization',
    ...(options.because ? { because: options.because } : {}),
  });

export const AUTHZ_EXEMPT = 'acc:authz:exempt';

/**
 * Marks an authenticated route that performs no target-scope check, with the
 * reason recorded on the route itself.
 *
 * Only identity endpoints qualify: they are about the caller rather than about
 * a tenant resource, so there is no target to check. `@Public()` is a different
 * statement — that route needs no *authentication* — and the two are kept apart
 * because conflating them is how an unauthenticated route acquires an
 * authorization exemption by accident.
 *
 * §6n case 30's assertion treats a route with neither `@RequiresPermission` nor
 * this as a defect, so a new endpoint cannot ship unprotected by omission.
 */
export const AuthorizationExempt = (because: string) => SetMetadata(AUTHZ_EXEMPT, because);
