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
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',

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
