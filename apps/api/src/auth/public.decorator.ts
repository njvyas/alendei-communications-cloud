import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'acc:auth:public';

/**
 * Marks a route as reachable without authentication.
 *
 * `AuthGuard` is registered globally and denies by default, so a new endpoint is
 * protected unless someone deliberately opts it out here. The inverse — opt-in
 * protection — is how an endpoint ships unauthenticated by omission.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const SKIP_TENANT = 'acc:auth:skip-tenant';

/**
 * Marks a route that authenticates but resolves no organization — the identity
 * endpoints (`/auth/me`, logout, session management), which are about the user
 * rather than about a tenant.
 */
export const NoTenantContext = () => SetMetadata(SKIP_TENANT, true);

export const OPTIONAL_TENANT = 'acc:auth:optional-tenant';

/**
 * Marks a route whose subject is not a selected organization but which should
 * still resolve one *when it is unambiguous* — named in `X-Acc-Organization`, or
 * the principal's only organization (Phase 1C.1a). Ambiguity resolves to no
 * organization instead of `400 TENANCY_CONTEXT_REQUIRED`; a named organization
 * outside scope, suspended or closed is still refused exactly as on any route.
 *
 * Used by `GET/POST /organizations`: the resolved context is only ever the
 * actor's own (it attributes a refused creation in the audit trail), never the
 * operation's target, and the non-active-organization mutation rule
 * (ADR-012 F-5) does not apply to it.
 */
export const OptionalTenantContext = () => SetMetadata(OPTIONAL_TENANT, true);
