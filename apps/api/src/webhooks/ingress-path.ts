/**
 * Phase 5.0 PR-C — the provider webhook ingress path and its redaction (design spec Rev 2
 * §E.1, §E.8; OD-19).
 *
 * The path segment after `/webhooks/providers/` IS the provider's ingress key: an opaque
 * bearer secret. It must never reach a log line, a span attribute, a metric label or an
 * error body. Every place the application might record the request URL routes it through
 * `redactIngressPath` first:
 *   - the pino-http request serializer (`observability/logging.module.ts`);
 *   - the OpenTelemetry HTTP instrumentation request hook (`observability/tracing.ts`);
 *   - the ingress body-parser error handler (`webhook-body-parsing.ts`).
 * The reverse proxy's access log is redacted by the operator configuration in
 * `deploy/nginx/acc-webhook-ingress-redaction.conf` (OD-19).
 */

/** The controller path under the global prefix. */
export const INGRESS_CONTROLLER_PATH = 'webhooks/providers';

/** The route template recorded wherever the request is identified. */
export const INGRESS_ROUTE_TEMPLATE = '/api/v1/webhooks/providers/:providerKey';

/** What replaces the key in a redacted path. */
export const INGRESS_KEY_PLACEHOLDER = ':providerKey';

/** Any path (any prefix, optional query) that addresses the ingress, capturing up to the key. */
const INGRESS_PATH = /(\/webhooks\/providers\/)[^/?#]*/i;

/** Exactly the ingress route: one key segment, an optional trailing slash, an optional query. */
const INGRESS_ROUTE = /\/webhooks\/providers\/[^/?#]+\/?(?:[?#].*)?$/i;

/**
 * Whether `url` is exactly the ingress route (`…/webhooks/providers/<one segment>`). Any other
 * URL that `isIngressPath` matches — extra segments — has no handler, and Nest's default 404
 * would echo the path (and the key) in its message: the ingress middleware answers those itself.
 */
export function isIngressRoute(url: string | undefined | null): boolean {
  return typeof url === 'string' && INGRESS_ROUTE.test(url);
}

/** Whether `url` addresses the provider webhook ingress. */
export function isIngressPath(url: string | undefined | null): boolean {
  return typeof url === 'string' && INGRESS_PATH.test(url);
}

/**
 * `url` with the ingress key replaced by `:providerKey` and the query string dropped;
 * any other URL unchanged. Total and side-effect free: safe in every serializer.
 */
export function redactIngressPath<T extends string | undefined | null>(url: T): T {
  if (typeof url !== 'string' || !INGRESS_PATH.test(url)) return url;
  const path = url.split(/[?#]/, 1)[0]!;
  return path.replace(INGRESS_PATH, `$1${INGRESS_KEY_PLACEHOLDER}`) as T;
}

/** The span attributes the HTTP instrumentation may fill with the request target. */
const URL_ATTRIBUTES = [
  'http.target',
  'http.url',
  'url.path',
  'url.full',
  'url.query',
  'http.route',
] as const;

/** The subset of an OpenTelemetry span the request hook needs. */
export interface RedactableSpan {
  setAttribute(key: string, value: string): unknown;
  updateName(name: string): unknown;
}

/**
 * The OpenTelemetry HTTP `requestHook` for incoming requests: on the ingress, overwrite
 * every URL-bearing attribute with the redacted path, set `http.route` to the template and
 * name the span after the template (spec §E.8). Any other request is left alone.
 */
export function redactIngressSpan(
  span: RedactableSpan,
  request: { url?: string; method?: string },
): void {
  if (!isIngressPath(request.url)) return;
  const redacted = redactIngressPath(request.url!);
  for (const attribute of URL_ATTRIBUTES) {
    span.setAttribute(
      attribute,
      attribute === 'http.route'
        ? INGRESS_ROUTE_TEMPLATE
        : attribute === 'url.query'
          ? ''
          : attribute === 'http.url' || attribute === 'url.full'
            ? `[redacted]${redacted}`
            : redacted,
    );
  }
  span.updateName(`${request.method ?? 'POST'} ${INGRESS_ROUTE_TEMPLATE}`);
}
