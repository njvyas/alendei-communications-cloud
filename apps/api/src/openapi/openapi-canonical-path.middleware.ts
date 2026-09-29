import { Injectable, NotFoundException, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request } from 'express';

import { AppConfigService } from '../config/app-config.service';
import { OPENAPI_DOCUMENT_ROUTE } from './openapi-document';

/**
 * Exactly one spelling reaches the document (Phase 1C.3 ADR): `GET` or `HEAD`
 * on `/<prefix>/openapi.json`. Express matches routes case-insensitively and
 * with an optional trailing slash, so `/OpenAPI.json` and `/openapi.json/`
 * would otherwise reach the same handler; every such variant, and every other
 * method, gets the ordinary unknown-route `404` instead — before any guard
 * runs, so it discloses nothing about authentication either.
 */
@Injectable()
export class OpenApiCanonicalPathMiddleware implements NestMiddleware {
  constructor(private readonly config: AppConfigService) {}

  use(request: Request, _response: unknown, next: NextFunction): void {
    const canonical = `/${this.config.http.globalPrefix}/${OPENAPI_DOCUMENT_ROUTE}`;
    const path = request.originalUrl.split('?')[0];
    if (path !== canonical || (request.method !== 'GET' && request.method !== 'HEAD')) {
      // The message Nest's own router produces for an unknown route.
      throw new NotFoundException(`Cannot ${request.method} ${request.originalUrl}`);
    }
    next();
  }
}
