// Instrumentation must patch http/pg/ioredis before those modules are first
// required, so tracing is started before every other import is evaluated.
import { startTracing, stopTracing } from './observability/tracing';

startTracing();

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { ConfigurationError } from './config/env.schema';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // The default Nest exception layer would otherwise print stack traces before
    // our filter can normalize them.
    abortOnError: false,
  });

  app.useLogger(app.get(PinoLogger));
  const config = app.get(AppConfigService);
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
  // only because the deployment terminates TLS at an ingress in front of this
  // process. Trusting them unconditionally would let any client spoof its
  // source address through `X-Forwarded-For` and walk straight past the
  // IP-keyed authentication rate limit, so the hop count is configuration
  // rather than a constant, and `0` disables the trust entirely.
  app.set('trust proxy', config.http.trustedProxyHops);

  app.enableCors({
    origin: config.http.corsOrigins.length > 0 ? config.http.corsOrigins : false,
    credentials: true,
    // Credentialed CORS: the refresh cookie must be sent cross-origin, which
    // makes a wildcard origin invalid. `false` when no origin is configured
    // denies every cross-origin request rather than defaulting to permissive.
    exposedHeaders: ['x-correlation-id', 'x-request-id'],
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
  // The API version lives in the URL path rather than a header (`API.md` §1);
  // the global prefix (`api/v1`) is what carries it.
  app.setGlobalPrefix(config.http.globalPrefix, {
    exclude: ['metrics', 'health', 'health/live', 'health/ready'],
  });

  if (config.http.openApiUiEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Alendei Communications Cloud API')
        .setDescription('ACC control-plane API')
        .setVersion('v1')
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'session')
        .build(),
    );
    SwaggerModule.setup(`${config.http.globalPrefix}/docs`, app, document, {
      jsonDocumentUrl: `${config.http.globalPrefix}/openapi.json`,
    });
    logger.log(`OpenAPI UI at /${config.http.globalPrefix}/docs`);
  }

  await app.listen(config.http.port, config.http.host);
  logger.log(
    `${config.serviceName} listening on ${config.http.host}:${config.http.port} ` +
      `(env=${config.appEnv}, prefix=/${config.http.globalPrefix})`,
  );

  // Signal handling is done here rather than through `app.enableShutdownHooks()`
  // so there is exactly one shutdown path, with a hard timeout guarding it.
  // `app.close()` runs every onModuleDestroy/onApplicationShutdown hook either
  // way — that is what drains the database pools and the Redis connection.
  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`${signal} received — shutting down`);
    const timer = setTimeout(() => {
      logger.error(`Graceful shutdown exceeded ${config.http.shutdownTimeoutMs}ms — forcing exit`);
      process.exit(1);
    }, config.http.shutdownTimeoutMs);
    timer.unref();

    try {
      await app.close();
      await stopTracing();
      // The logger's transport is torn down as part of `app.close()`, so the
      // final confirmation is written directly to stdout — still as one JSON
      // line, so log shipping treats it like any other record.
      writeShutdownLine(config.serviceName, config.appEnv, 'complete');
      process.exit(0);
    } catch (error) {
      writeShutdownLine(config.serviceName, config.appEnv, 'failed');
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

function writeShutdownLine(service: string, environment: string, outcome: string): void {
  process.stdout.write(
    `${JSON.stringify({
      level: outcome === 'complete' ? 'info' : 'error',
      time: new Date().toISOString(),
      service,
      environment,
      context: 'Bootstrap',
      msg: `Shutdown ${outcome}`,
    })}\n`,
  );
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    // A configuration problem is reported plainly and fails the process: an
    // instance never starts with partial or invalid configuration.
    console.error(error.message);
    process.exit(78); // EX_CONFIG
  }
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
