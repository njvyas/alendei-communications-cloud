import { Injectable, type INestApplication } from '@nestjs/common';
import { ApplicationConfig, HttpAdapterHost, ModulesContainer } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';

import { buildOpenApiDocument } from './openapi-document';

/**
 * Builds the served OpenAPI document on first use and keeps it (Phase 1C.3).
 *
 * The Swagger scanner needs only the module container, the application config
 * (for the global prefix) and the HTTP adapter; all three are injectable, so
 * the document comes from the running module graph — the same factory the
 * generator and the contract tests use. It is built lazily: the first request
 * that reaches the handler has already passed authentication.
 */
@Injectable()
export class OpenApiDocumentService {
  private document?: Promise<OpenAPIObject>;

  constructor(
    private readonly modules: ModulesContainer,
    private readonly applicationConfig: ApplicationConfig,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  get(): Promise<OpenAPIObject> {
    this.document ??= buildOpenApiDocument(this.application());
    return this.document;
  }

  private application(): INestApplication {
    return {
      container: { getModules: () => this.modules, isGlobalModule: () => false },
      config: this.applicationConfig,
      getHttpAdapter: () => this.adapterHost.httpAdapter,
    } as unknown as INestApplication;
  }
}
