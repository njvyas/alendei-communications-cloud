import { Controller, Get, Header, HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';
import { ApiOkResponse, ApiOperation, ApiTags, type OpenAPIObject } from '@nestjs/swagger';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import { NoTenantContext, Public } from '../auth/public.decorator';
import { AuthorizationExempt } from '../auth/requires-permission.decorator';
import { AcceptedCredentials } from './accepted-credentials.decorator';
import { OPENAPI_DOCUMENT_ROUTE } from './openapi-document';
import { OpenApiDocumentService } from './openapi-document.service';
import { ApiErrors } from './openapi-responses';

const DOCUMENT_RESPONSE = {
  description: 'This OpenAPI 3.0.3 document.',
  schema: { type: 'object', additionalProperties: true },
} as const;

/**
 * `GET /api/v1/openapi.json` outside development (Phase 1C.3 ADR, G1 option C):
 * the only route that produces the document, for a signed-in user session.
 *
 * Authentication is the unchanged global pipeline (`AuthGuard`); the handler
 * then admits only a user principal with a live session — the same rule and
 * refusal `POST /ws/ticket` applies — so an API key is `403`. It needs no
 * permission and resolves no organization: the contract is not tenant data.
 */
@ApiTags('openapi')
@Controller()
export class OpenApiDocumentController {
  constructor(private readonly documents: OpenApiDocumentService) {}

  @Get(OPENAPI_DOCUMENT_ROUTE)
  @NoTenantContext()
  @AuthorizationExempt(
    'documentation: any signed-in user session may read the API contract, which is not tenant data',
  )
  @Header('Cache-Control', 'no-store')
  @AcceptedCredentials('userSession')
  @ApiOperation({
    operationId: 'OpenApiDocument_get',
    summary: 'The OpenAPI document',
    description:
      'Outside development: a signed-in user session only (an API key is `403`). In development with `OPENAPI_UI_ENABLED=true` it is served without authentication, alongside the Swagger UI.',
  })
  @ApiOkResponse(DOCUMENT_RESPONSE)
  @ApiErrors(401, 403, 429)
  async get(): Promise<OpenAPIObject> {
    const principal = RequestContext.get()?.principal as ResolvedPrincipal | null | undefined;
    if (!principal || principal.actorType !== 'user' || !principal.userId || !principal.sessionId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
        message: 'Only a signed-in user session can read the API document',
        logContext: { actorType: principal?.actorType ?? null },
      });
    }
    return this.documents.get();
  }
}

/**
 * The same route in development only (`APP_ENV=development` and
 * `OPENAPI_UI_ENABLED=true`, ADR G4): public, for the development Swagger UI,
 * which fetches the document from here and never embeds it. Documented exactly
 * as the protected route, whose contract is the one that ships.
 */
@ApiTags('openapi')
@Controller()
export class OpenApiDevelopmentDocumentController {
  constructor(private readonly documents: OpenApiDocumentService) {}

  @Get(OPENAPI_DOCUMENT_ROUTE)
  @Public()
  @Header('Cache-Control', 'no-store')
  @AcceptedCredentials('userSession')
  @ApiOperation({
    operationId: 'OpenApiDocument_get',
    summary: 'The OpenAPI document',
    description:
      'Outside development: a signed-in user session only (an API key is `403`). In development with `OPENAPI_UI_ENABLED=true` it is served without authentication, alongside the Swagger UI.',
  })
  @ApiOkResponse(DOCUMENT_RESPONSE)
  @ApiErrors(401, 403, 429)
  get(): Promise<OpenAPIObject> {
    return this.documents.get();
  }
}
