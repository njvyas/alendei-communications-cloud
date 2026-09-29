import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';

import { OpenApiCanonicalPathMiddleware } from './openapi-canonical-path.middleware';
import {
  OpenApiDevelopmentDocumentController,
  OpenApiDocumentController,
} from './openapi-document.controller';
import { OPENAPI_DOCUMENT_ROUTE } from './openapi-document';
import { OpenApiDocumentService } from './openapi-document.service';
import { openApiModeFromEnv } from './openapi-mode';

function canonicalPath(consumer: MiddlewareConsumer): void {
  consumer
    .apply(OpenApiCanonicalPathMiddleware)
    .forRoutes({ path: OPENAPI_DOCUMENT_ROUTE, method: RequestMethod.ALL });
}

/** Registered only in `protected` mode: the authenticated document route. */
@Module({ controllers: [OpenApiDocumentController], providers: [OpenApiDocumentService] })
export class OpenApiProtectedModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    canonicalPath(consumer);
  }
}

/** Registered only in `public-development` mode: the public document route. */
@Module({
  controllers: [OpenApiDevelopmentDocumentController],
  providers: [OpenApiDocumentService],
})
export class OpenApiDevelopmentModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    canonicalPath(consumer);
  }
}

/**
 * The OpenAPI capability (Phase 1C.3 ADR, G1–G4). Exactly one of the two
 * document modules is registered — or neither, when `OPENAPI_UI_ENABLED` is
 * false, in which case no documentation route exists at all. The decision is
 * the validated schema's (`openApiModeFromEnv`), taken once the configuration
 * has loaded.
 */
export const OPENAPI_MODULES = [
  ConditionalModule.registerWhen(
    OpenApiProtectedModule,
    (env) => openApiModeFromEnv(env) === 'protected',
    { debug: false },
  ),
  ConditionalModule.registerWhen(
    OpenApiDevelopmentModule,
    (env) => openApiModeFromEnv(env) === 'public-development',
    { debug: false },
  ),
];
