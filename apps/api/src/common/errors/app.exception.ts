import { HttpException, HttpStatus } from '@nestjs/common';

import { ERROR_CODES, isRetryableErrorCode, type ErrorCode } from '@acc/contracts';

export interface AppExceptionOptions {
  readonly status: HttpStatus;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  /** Overrides the code's default retryability where the situation warrants. */
  readonly retryable?: boolean;
  /** Extra context for the audit/log record; never serialized to the client. */
  readonly logContext?: Record<string, unknown>;
}

/**
 * Base class for every error ACC raises deliberately. Carries the stable
 * machine-readable code and retryability flag the error contract requires
 * (`API.md` §7); the correlation id is attached by the exception filter.
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly logContext: Record<string, unknown> | undefined;

  constructor(options: AppExceptionOptions) {
    super(options.message, options.status);
    this.code = options.code;
    this.retryable = options.retryable ?? isRetryableErrorCode(options.code);
    this.details = options.details;
    this.logContext = options.logContext;
  }
}

export class ValidationFailedException extends AppException {
  constructor(details: Record<string, unknown>) {
    super({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Request validation failed',
      details,
    });
  }
}

export class ResourceNotFoundException extends AppException {
  constructor(resourceType: string, resourceId?: string) {
    super({
      status: HttpStatus.NOT_FOUND,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      // The message never echoes back a caller-supplied identifier, so a probe
      // cannot distinguish "does not exist" from "exists in another tenant".
      message: `${resourceType} not found`,
      logContext: resourceId ? { resourceType, resourceId } : { resourceType },
    });
  }
}

export class ResourceConflictException extends AppException {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      status: HttpStatus.CONFLICT,
      code: ERROR_CODES.RESOURCE_CONFLICT,
      message,
      details,
    });
  }
}
