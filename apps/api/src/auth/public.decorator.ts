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
