import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ERROR_CODES, isRetryableErrorCode, type ApiErrorResponse } from '@acc/contracts';

import { RequestContext } from '../context/request-context';
import { AppException } from '../errors/app.exception';

interface NormalizedError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  logContext?: Record<string, unknown>;
}

const STATUS_CODE_FALLBACKS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ERROR_CODES.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
  [HttpStatus.FORBIDDEN]: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
  [HttpStatus.NOT_FOUND]: ERROR_CODES.RESOURCE_NOT_FOUND,
  [HttpStatus.CONFLICT]: ERROR_CODES.RESOURCE_CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ERROR_CODES.RATE_LIMIT_EXCEEDED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ERROR_CODES.SERVICE_UNAVAILABLE,
};

/**
 * Turns every thrown value into the one error envelope the API contract defines
 * (`API.md` §7).
 *
 * Internal failure detail never reaches the client: an unexpected error is
 * reported as `INTERNAL_ERROR` with the correlation id, and the actual exception
 * is logged server-side under that same id. `details` is only ever populated
 * from deliberately-constructed structured validation output, never from an
 * exception's internal state.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const correlationId = RequestContext.correlationId();

    const normalized = this.normalize(exception);

    const body: ApiErrorResponse = {
      error: {
        code: normalized.code,
        message: normalized.message,
        correlationId,
        retryable: normalized.retryable,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
    };

    const logPayload = {
      correlationId,
      code: normalized.code,
      status: normalized.status,
      method: request.method,
      route: request.route?.path ?? request.path,
      ...normalized.logContext,
    };

    if (normalized.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(logPayload, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(logPayload);
    }

    response.status(normalized.status).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        retryable: exception.retryable,
        ...(exception.details ? { details: exception.details } : {}),
        ...(exception.logContext ? { logContext: exception.logContext } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const code = STATUS_CODE_FALLBACKS[status] ?? ERROR_CODES.INTERNAL_ERROR;
      return {
        status,
        code,
        message: this.messageFrom(payload, exception.message),
        retryable: isRetryableErrorCode(code),
        ...(this.detailsFrom(payload) ? { details: this.detailsFrom(payload)! } : {}),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      // Deliberately generic: an unexpected failure discloses nothing about
      // internal structure to the caller.
      message: 'An unexpected error occurred',
      retryable: false,
    };
  }

  private messageFrom(payload: string | object, fallback: string): string {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object' && 'message' in payload) {
      const message = (payload as { message: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return 'Request validation failed';
    }
    return fallback;
  }

  private detailsFrom(payload: string | object): Record<string, unknown> | undefined {
    if (payload && typeof payload === 'object' && 'message' in payload) {
      const message = (payload as { message: unknown }).message;
      if (Array.isArray(message)) {
        return { issues: message.filter((entry): entry is string => typeof entry === 'string') };
      }
    }
    return undefined;
  }
}
