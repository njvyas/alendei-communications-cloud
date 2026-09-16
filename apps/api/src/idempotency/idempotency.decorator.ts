import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { IdempotencyService } from './idempotency.service';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * The validated `Idempotency-Key`, or `null` when the caller sent none.
 *
 * Validation happens here rather than in a DTO because the key is a header
 * rather than a field, and because a malformed key must be refused before any
 * lookup — nothing should be read from a value that could not be a key.
 *
 * `null` for absent is deliberate: idempotency is **opt-in** on the endpoints
 * that accept it (`API.md` §4). Requiring it would break every existing client
 * and, on endpoints whose duplicate is already refused by a unique constraint,
 * would buy nothing.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null => {
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers[IDEMPOTENCY_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value.trim() === '') return null;
    return IdempotencyService.validateKey(value);
  },
);
