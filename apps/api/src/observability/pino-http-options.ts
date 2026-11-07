/**
 * The pino-http options of the API (`OBSERVABILITY.md` §2), in a file of their own so they
 * can be built — and tested — without importing the Nest configuration module (whose
 * `ConfigModule.forRoot` validates the environment at import time). `LoggingModule` uses
 * exactly these options.
 */
import { trace } from '@opentelemetry/api';

import { RequestContext } from '../common/context/request-context';
import type { AppConfigService } from '../config/app-config.service';
import { isIngressUrl, redactIngressPath } from '../webhooks/ingress-path';

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
  // Phase 5.0 PR-E: the provider webhook ingress key in its header form (and the operator
  // simulator trigger, which receives it the same way).
  'req.headers["x-acc-webhook-ingress-key"]',
  // …and wherever a headers object is logged ad hoc (one or two levels deep).
  'headers["x-acc-webhook-ingress-key"]',
  '*.headers["x-acc-webhook-ingress-key"]',
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

/**
 * The pino-http options (exported so a test can drive the real configuration).
 *
 * Phase 5.0 PR-C (OD-19, spec §E.8): the request serializer redacts the provider webhook
 * ingress key — the path segment after `/webhooks/providers/` — from `req.url` and drops
 * `req.params` and `req.query` on that path (a misbehaving client may repeat the key in the
 * query string), so no request log line ever carries the key. PR-E: the same for the header
 * form (`/webhooks/providers`): its query string is dropped too (`isIngressUrl`).
 */
export function pinoHttpOptions(config: AppConfigService) {
  return {
    level: config.logging.level,
    base: {
      service: config.serviceName,
      environment: config.appEnv,
    },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    serializers: {
      req: (req: { url?: string; params?: unknown; query?: unknown }) =>
        isIngressUrl(req.url)
          ? { ...req, url: redactIngressPath(req.url), params: undefined, query: undefined }
          : req,
    },
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
      ignore: (req: { url?: string }) => {
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
  };
}
