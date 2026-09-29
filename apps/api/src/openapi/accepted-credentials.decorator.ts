import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiSecurity } from '@nestjs/swagger';

/**
 * The credentials an operation accepts, as documented in OpenAPI (Phase 1C.3
 * ADR, G8/G9).
 *
 * - `none` — the operation is reachable without a credential (`@Public`).
 * - `userSession` — `Authorization: Bearer <access token>` of a signed-in user.
 * - `apiKey` — `Authorization: Bearer ak_(live|test)_…` (an API key travels in
 *   the same header as a session token; it is not an OpenAPI `apiKey` header).
 * - `refreshCookie` — the `acc_refresh` cookie (always together with the
 *   `X-Acc-Refresh` header, documented as a header parameter).
 *
 * A credential is listed only when a request carrying it can succeed on this
 * operation.
 */
export const CREDENTIALS = ['none', 'userSession', 'apiKey', 'refreshCookie'] as const;
export type Credential = (typeof CREDENTIALS)[number];

export const ACCEPTED_CREDENTIALS = 'acc:openapi:accepted-credentials';

/**
 * **Documentation only.** It records, for OpenAPI and for the contract tests,
 * which credentials an operation accepts. It is never read by a guard,
 * interceptor or service, and it grants and refuses nothing: authentication
 * stays in `AuthGuard`, and each user-session-only restriction stays where it
 * is enforced today (the owning service). The behavioural contract suite
 * proves this metadata agrees with what the runtime actually does.
 */
export function AcceptedCredentials(...credentials: Credential[]) {
  if (credentials.length === 0) {
    throw new Error('AcceptedCredentials needs at least one credential');
  }
  if (credentials.includes('none') && credentials.length > 1) {
    throw new Error('AcceptedCredentials("none") cannot be combined with a credential');
  }
  return applyDecorators(
    SetMetadata(ACCEPTED_CREDENTIALS, [...credentials]),
    // One requirement object per credential: alternatives, not a conjunction.
    ...credentials.filter((c) => c !== 'none').map((c) => ApiSecurity(c)),
  );
}
