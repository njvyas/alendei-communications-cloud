import { Module } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { LoggerModule } from 'nestjs-pino';

import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { RequestContext } from '../common/context/request-context';

/**
 * Structured JSON logging (`OBSERVABILITY.md` §2).
 *
 * Every line carries the fixed base schema plus the correlation keys, so a
 * request can be reconstructed end to end from logs alone. Credential material
 * and PII-bearing headers are redacted by default: a log statement has to opt in
 * explicitly (and be reviewed) to carry anything sensitive.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'password_hash',
  'refreshToken',
  'refresh_token',
  'refreshTokenHash',
  'accessToken',
  'access_token',
  'apiKey',
  'api_key',
  'keyHash',
  'key_hash',
  'secret',
  'ticket',
  'ticketHash',
  'credential',
  '*.password',
  '*.secret',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
];

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logging.level,
          base: {
            service: config.serviceName,
            environment: config.appEnv,
          },
          redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
          // Correlation keys are attached to every line, including lines emitted
          // deep inside a call stack with no access to the request object.
          mixin() {
            const store = RequestContext.get();
            const span = trace.getActiveSpan();
            const traceId = span?.spanContext().traceId ?? store?.traceId ?? null;
            if (!store) return traceId ? { traceId } : {};
            return {
              correlationId: store.correlationId,
              requestId: store.requestId,
              ...(store.causationId ? { causationId: store.causationId } : {}),
              ...(traceId ? { traceId } : {}),
              ...(store.principal?.tenant.orgId ? { orgId: store.principal.tenant.orgId } : {}),
              ...(store.principal?.userId ? { userId: store.principal.userId } : {}),
              ...(store.principal?.actorType ? { actorType: store.principal.actorType } : {}),
            };
          },
          autoLogging: {
            ignore: (req) => {
              const url = req.url ?? '';
              return url.startsWith('/metrics') || url.startsWith('/health/live');
            },
          },
          customProps: () => ({}),
          ...(config.logging.pretty
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
                },
              }
            : {}),
        },
      }),
    }),
  ],
})
export class LoggingModule {}
