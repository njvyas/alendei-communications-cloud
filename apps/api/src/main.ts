// Instrumentation must patch http/pg/ioredis before those modules are first
// required, so tracing is started before every other import is evaluated.
import { startTracing, stopTracing } from './observability/tracing';

startTracing();

import { Logger } from '@nestjs/common';

import { createApp } from './app.factory';
import { ConfigurationError } from './config/env.schema';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  // Every piece of HTTP-edge security configuration lives in `createApp`, which
  // the real-bootstrap security suite exercises through the same code path.
  const app = await createApp();
  const config = app.get(AppConfigService);
  const logger = new Logger('Bootstrap');

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
