import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { mountDevelopmentSwaggerUi } from './openapi/openapi-dev-ui';

/**
 * Builds the production application: the module graph plus every piece of
 * HTTP-edge security configuration (Helmet, CORS, proxy trust, cookie parsing,
 * the versioned prefix, the development-only OpenAPI UI).
 *
 * It exists as its own function for one reason: `main.ts` and the real-bootstrap
 * security suite (`test/real-bootstrap.sec-spec.ts`) must configure the
 * application through **the same code**. A test harness that assembled its own
 * application skipped all of this, so CORS, Helmet and proxy trust were never
 * exercised and their tests passed vacuously (Gate-B audit, Blocker 5).
 *
 * It does not listen; `main.ts` does, after this returns.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // The default Nest exception layer would otherwise print stack traces before
    // our filter can normalize them.
    abortOnError: false,
  });

  app.useLogger(app.get(PinoLogger));
  configureApp(app, app.get(AppConfigService));
  return app;
}

/** The HTTP-edge configuration, applied to an already-created application. */
export function configureApp(app: NestExpressApplication, config: AppConfigService): void {
  const logger = new Logger('Bootstrap');

  app.use(
    helmet({
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // The refresh token arrives as an httpOnly cookie (`API.md` §3b); nothing
  // else in the platform reads cookies.
  app.use(cookieParser());

  // Proxy headers are trusted for exactly the configured number of hops, and
  // `0` — the default — trusts none: the client address is the socket peer and
  // `X-Forwarded-For` is ignored. A deployment behind an ingress sets the real
  // hop count explicitly. Trusting a hop that is not there lets any client
  // choose its own source address and walk past the IP-keyed authentication
  // rate limits.
  app.set('trust proxy', config.http.trustedProxyHops);

  app.enableCors({
    origin: config.http.corsOrigins.length > 0 ? config.http.corsOrigins : false,
    credentials: true,
    // Credentialed CORS: the refresh cookie must be sent cross-origin, which
    // makes a wildcard origin invalid. `false` when no origin is configured
    // denies every cross-origin request rather than defaulting to permissive.
    exposedHeaders: [
      'x-correlation-id',
      'x-request-id',
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-correlation-id',
      'x-causation-id',
      'x-acc-organization',
      'x-acc-refresh',
      'idempotency-key',
    ],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });

  // `/metrics` and `/health` intentionally sit outside the versioned prefix so
  // scrape and probe configuration survives an API version bump.
  app.setGlobalPrefix(config.http.globalPrefix, {
    exclude: ['metrics', 'health', 'health/live', 'health/ready'],
  });

  // OpenAPI (Phase 1C.3 ADR, G1 option C). The document route is a Nest
  // controller registered by `OpenApiModule` according to the same mode; here
  // only the development Swagger UI is mounted, and only in development. Every
  // other environment has no UI route at all.
  if (config.openApiMode === 'public-development') {
    mountDevelopmentSwaggerUi(app, config.http.globalPrefix);
    logger.log(
      `OpenAPI (development): UI at /${config.http.globalPrefix}/docs, document at /${config.http.globalPrefix}/openapi.json — unauthenticated`,
    );
  } else if (config.openApiMode === 'protected') {
    logger.log(
      `OpenAPI: document at /${config.http.globalPrefix}/openapi.json for signed-in user sessions; no UI outside development`,
    );
  }
}
