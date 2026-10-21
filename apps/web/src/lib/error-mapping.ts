import { ApiError } from './api-client';

export interface HumanizedError {
  readonly title: string;
  readonly message: string;
  readonly code?: string;
  readonly correlationId?: string;
  readonly details?: Record<string, unknown>;
}

const ERROR_CODE_MAP: Record<string, { title: string; message: string }> = {
  // --- Provider Assignments ---
  ASSIGNMENT_PRIORITY_CONFLICT: {
    title: 'Priority Conflict',
    message:
      'Another provider assignment already uses this priority for this channel. Select a different integer priority.',
  },
  PROVIDER_ASSIGNMENT_CONFLICT: {
    title: 'Provider Already Assigned',
    message: 'This provider is already assigned to this organization for this channel.',
  },
  PROVIDER_ASSIGNMENT_NOT_FOUND: {
    title: 'Assignment Not Found',
    message: 'The requested provider assignment does not exist or has been removed.',
  },
  NO_ACTIVE_PROVIDER_ASSIGNMENT: {
    title: 'No Active Provider',
    message:
      'No active provider assignment is configured for this channel. At least one active provider is required to route messages.',
  },

  // --- Authorization & Scope ---
  AUTHZ_PERMISSION_DENIED: {
    title: 'Permission Denied',
    message: 'Your account does not hold the required permission to perform this action.',
  },
  AUTHZ_SCOPE_DENIED: {
    title: 'Scope Denied',
    message:
      'Your account does not have sufficient authority at the requested scope level for this operation.',
  },
  AUTHZ_PLATFORM_ROLE_REQUIRED: {
    title: 'Platform Role Required',
    message: 'This operation requires a platform-scoped role.',
  },

  // --- Tenancy & Organization Lifecycle ---
  TENANCY_ORGANIZATION_SUSPENDED: {
    title: 'Organization Suspended',
    message:
      'This organization is currently suspended. Operational access and mutations are refused.',
  },
  TENANCY_ORGANIZATION_CLOSED: {
    title: 'Organization Closed',
    message:
      'This organization has been permanently closed. Operational access and mutations are refused.',
  },
  ORGANIZATION_LIFECYCLE_CONFLICT: {
    title: 'Organization Lifecycle Conflict',
    message: 'The organization is not in an active state to admit this operational change.',
  },
  TENANCY_CONTEXT_REQUIRED: {
    title: 'Organization Context Required',
    message: 'An active organization context must be selected to perform this operation.',
  },
  TENANCY_CONTEXT_MISMATCH: {
    title: 'Organization Context Mismatch',
    message: 'The specified organization context does not match the target resource.',
  },

  // --- Suppressions ---
  RECIPIENT_SUPPRESSED: {
    title: 'Recipient Suppressed',
    message:
      'The recipient address is currently on the organization suppression list. Dispatches to this address are blocked.',
  },
  SUPPRESSION_ALREADY_ACTIVE: {
    title: 'Recipient Already Suppressed',
    message: 'An active suppression entry already exists for this recipient address and channel.',
  },
  SUPPRESSION_LIFECYCLE_CONFLICT: {
    title: 'Suppression Lifecycle Conflict',
    message: 'This suppression is not in an active state and cannot be lifted.',
  },

  // --- Idempotency ---
  IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: {
    title: 'Idempotency Key Conflict',
    message:
      'This idempotency key was previously used with different request parameters. Use a fresh idempotency key.',
  },
  IDEMPOTENCY_REQUEST_IN_PROGRESS: {
    title: 'Request In Progress',
    message:
      'A duplicate request with this idempotency key is currently executing. Please wait a moment and retry.',
  },
  IDEMPOTENCY_KEY_INVALID: {
    title: 'Invalid Idempotency Key',
    message: 'The supplied idempotency key header is malformed or invalid.',
  },

  // --- Pagination ---
  PAGINATION_CURSOR_INVALID: {
    title: 'Invalid Pagination Cursor',
    message:
      'The pagination cursor is invalid or expired. Refresh the page to start from the beginning.',
  },

  // --- Messages & Templates ---
  CONSENT_REVOKED: {
    title: 'Consent Revoked',
    message: 'Recipient consent has expired or was revoked. Dispatches require verified consent.',
  },
  TEMPLATE_NOT_APPROVED: {
    title: 'Template Not Approved',
    message: 'The template must be approved before outbound messages can be dispatched.',
  },
  MESSAGE_NOT_FOUND: {
    title: 'Message Not Found',
    message: 'The requested message record does not exist or has been removed.',
  },

  // --- Generic ---
  RESOURCE_NOT_FOUND: {
    title: 'Resource Not Found',
    message: 'The requested resource does not exist or has been removed.',
  },
  RESOURCE_CONFLICT: {
    title: 'Resource Conflict',
    message: 'The requested resource operation conflicted with existing data.',
  },
  VALIDATION_FAILED: {
    title: 'Validation Failed',
    message: 'The submitted request contains invalid or missing values. Please verify all fields.',
  },
  RATE_LIMIT_EXCEEDED: {
    title: 'Rate Limit Exceeded',
    message:
      'Too many operations were submitted in a short time. Please wait a moment before retrying.',
  },
  INTERNAL_ERROR: {
    title: 'Internal Server Error',
    message: 'An unexpected system error occurred on the server. Please try again shortly.',
  },
  SERVICE_UNAVAILABLE: {
    title: 'Service Unavailable',
    message: 'The platform service is temporarily unavailable. Please retry after a brief delay.',
  },
};

/**
 * Translates an unknown error or ApiError into user-friendly actionable guidance,
 * while preserving machine-readable error codes and correlation IDs for troubleshooting.
 */
export function humanizeApiError(
  err: unknown,
  fallbackTitle = 'Operation Failed',
  fallbackMessage = 'An unexpected error occurred. Please try again.',
): HumanizedError {
  if (err instanceof ApiError) {
    const mapped = err.code ? ERROR_CODE_MAP[err.code] : undefined;
    return {
      title: mapped?.title ?? fallbackTitle,
      message: mapped?.message ?? err.message ?? fallbackMessage,
      code: err.code,
      correlationId: err.correlationId,
      details: err.details,
    };
  }

  if (typeof err === 'object' && err !== null) {
    const candidate = err as {
      code?: string;
      message?: string;
      correlationId?: string;
      details?: Record<string, unknown>;
    };

    if (candidate.code && ERROR_CODE_MAP[candidate.code]) {
      const mapped = ERROR_CODE_MAP[candidate.code]!;
      return {
        title: mapped.title,
        message: mapped.message,
        code: candidate.code,
        correlationId: candidate.correlationId,
        details: candidate.details,
      };
    }

    if (err instanceof Error) {
      return {
        title: fallbackTitle,
        message: err.message || fallbackMessage,
        code: candidate.code,
        correlationId: candidate.correlationId,
      };
    }
  }

  return {
    title: fallbackTitle,
    message: fallbackMessage,
  };
}
