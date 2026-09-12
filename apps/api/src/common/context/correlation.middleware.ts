import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';

import { RequestContext, type RequestContextStore } from './request-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';
/** Links this request to the event or request that caused it (`EVENTS.md` §2). */
export const CAUSATION_ID_HEADER = 'x-causation-id';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Establishes the request's correlation identity before anything else runs.
 *
 * A caller-supplied correlation id is honoured only when it is a well-formed
 * UUID; anything else is replaced rather than propagated, so a caller cannot
 * inject arbitrary text into log lines, event envelopes or audit records.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const supplied = firstHeader(req.headers[CORRELATION_ID_HEADER]);
    const correlationId =
      supplied && UUID_PATTERN.test(supplied) ? supplied.toLowerCase() : uuidv7();

    const suppliedCausation = firstHeader(req.headers[CAUSATION_ID_HEADER]);
    const causationId =
      suppliedCausation && UUID_PATTERN.test(suppliedCausation)
        ? suppliedCausation.toLowerCase()
        : null;

    const store: RequestContextStore = {
      correlationId,
      requestId: uuidv7(),
      causationId,
      traceId: null,
      principal: null,
      ip: req.ip ?? null,
      userAgent: firstHeader(req.headers['user-agent']),
    };

    res.setHeader(CORRELATION_ID_HEADER, store.correlationId);
    res.setHeader(REQUEST_ID_HEADER, store.requestId);

    RequestContext.run(store, () => {
      next();
    });
  }
}
