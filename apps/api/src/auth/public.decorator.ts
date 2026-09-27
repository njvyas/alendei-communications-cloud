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

export const OPTIONAL_AUTH = 'acc:auth:optional-authentication';

/**
 * Marks a route that authenticates a presented bearer credential as usual, but
 * proceeds **without** a principal when that credential is missing, expired or
 * revoked (a `401`) instead of refusing (Phase 1C.2, ADR-012 F-12).
 *
 * Used by `POST /auth/logout` only: a caller whose access token has expired can
 * still end its session with the refresh cookie. Only a `401` is absorbed; any
 * other refusal (a `429`, for instance) still propagates. A handler behind this
 * decorator must treat "no principal" as unauthenticated and act only on a
 * credential it verifies itself.
 */
export const OptionalAuthentication = () => SetMetadata(OPTIONAL_AUTH, true);
