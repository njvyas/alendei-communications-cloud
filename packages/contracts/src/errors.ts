/**
 * Error contract (`API.md` §7). Every error response uses this envelope, with a
 * stable machine-readable `code` namespaced by domain.
 */

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
  /**
   * `true` only where an identical retry (same idempotency key, unchanged
   * payload) is safe and may succeed. Clients must not blindly retry a 4xx/5xx
   * without checking this flag (`API.md` §7).
   */
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  readonly error: ApiErrorBody;
}

export const ERROR_CODES = {
  // --- Auth ----------------------------------------------------------------
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_SESSION_REVOKED: 'AUTH_SESSION_REVOKED',
  AUTH_CREDENTIAL_REQUIRED: 'AUTH_CREDENTIAL_REQUIRED',
  AUTH_ACCOUNT_DISABLED: 'AUTH_ACCOUNT_DISABLED',
  AUTH_API_KEY_INVALID: 'AUTH_API_KEY_INVALID',
  AUTH_API_KEY_REVOKED: 'AUTH_API_KEY_REVOKED',
  AUTH_API_KEY_EXPIRED: 'AUTH_API_KEY_EXPIRED',

  // --- Authorization -------------------------------------------------------
  AUTHZ_PERMISSION_DENIED: 'AUTHZ_PERMISSION_DENIED',
  AUTHZ_SCOPE_DENIED: 'AUTHZ_SCOPE_DENIED',
  AUTHZ_PLATFORM_ROLE_REQUIRED: 'AUTHZ_PLATFORM_ROLE_REQUIRED',
  AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION: 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION',
  /**
   * The role was granted at a scope level its `allowedScopeTypes` does not
   * admit (`RBAC.md` §7, Phase 1B.5.5). Distinct from `AUTHZ_SCOPE_DENIED`,
   * which says the *actor* could not reach the scope: this says the request was
   * well-formed and the actor was entitled, but the role was never designed to
   * exist at that level. `API.md` §3c renders it `422`.
   */
  AUTHZ_SCOPE_TYPE_NOT_ADMITTED: 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED',
  /**
   * The operation would leave the platform with no active administrator
   * (ADR-005 D-7, Phase 1B.5.6). Rendered `409`: the actor was authorized and
   * the request well-formed — the platform simply may not enter that state, and
   * the caller's remedy is to appoint another administrator first, not to
   * acquire more authority. Reporting it as `403` would send an administrator
   * looking for a permission it already holds.
   */
  AUTHZ_LAST_PLATFORM_ADMIN: 'AUTHZ_LAST_PLATFORM_ADMIN',

  // --- Tenancy -------------------------------------------------------------
  TENANCY_CONTEXT_REQUIRED: 'TENANCY_CONTEXT_REQUIRED',
  /** A client-supplied tenant identifier disagreed with the resolved context. */
  TENANCY_CONTEXT_MISMATCH: 'TENANCY_CONTEXT_MISMATCH',
  TENANCY_SCOPE_OUT_OF_TENANT: 'TENANCY_SCOPE_OUT_OF_TENANT',

  // --- WebSocket tickets ---------------------------------------------------
  WS_TICKET_INVALID: 'WS_TICKET_INVALID',
  WS_TICKET_EXPIRED: 'WS_TICKET_EXPIRED',
  WS_TICKET_ALREADY_CONSUMED: 'WS_TICKET_ALREADY_CONSUMED',

  // --- Idempotency (`API.md` §4) -------------------------------------------
  /**
   * A duplicate arrived while the original was still executing and the wait for
   * it exceeded the lock timeout. Retryable: the original is committing or
   * rolling back, and the next attempt gets a definite answer.
   */
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  /**
   * The key was already used for a *different* effective request — a different
   * body, a different route, or a different principal. The same key must always
   * mean the same request; accepting it would either replay someone else's
   * result or silently perform a second, different mutation.
   */
  IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
  /**
   * The supplied `Idempotency-Key` is not a well-formed key. Distinct from a
   * mismatch: nothing was looked up, because the value could not be one.
   */
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',

  // --- Pagination (`API.md` §8a) -------------------------------------------
  /**
   * The cursor was malformed, its signature did not verify, or it was minted
   * under a different sort than the request asks for. One code for all three:
   * telling a caller which part of a forged cursor to fix is not information
   * the API owes it.
   */
  PAGINATION_CURSOR_INVALID: 'PAGINATION_CURSOR_INVALID',

  // --- Generic -------------------------------------------------------------
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  RESOURCE_CONFLICT: 'RESOURCE_CONFLICT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Error codes for which an identical retry is safe and may succeed. */
export const RETRYABLE_ERROR_CODES: readonly ErrorCode[] = Object.freeze([
  ERROR_CODES.IDEMPOTENCY_REQUEST_IN_PROGRESS,
  ERROR_CODES.RATE_LIMIT_EXCEEDED,
  ERROR_CODES.SERVICE_UNAVAILABLE,
]);

export function isRetryableErrorCode(code: string): boolean {
  return (RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}
