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

/**
 * Phase 5.0 PR-E (owner-approved contract correction): the header form of the same ingress.
 * The key travels in `INGRESS_KEY_HEADER` and the path carries no secret. Exactly one form per
 * request: a key in the path AND the header, or in neither, is the uniform 401.
 */
export const INGRESS_HEADER_ROUTE_TEMPLATE = '/api/v1/webhooks/providers';

/** The dedicated header that carries the ingress key in the header form (lower case, as Node exposes it). */
export const INGRESS_KEY_HEADER = 'x-acc-webhook-ingress-key';

/** What replaces the key in a redacted path. */
export const INGRESS_KEY_PLACEHOLDER = ':providerKey';

/** Any path (any prefix, optional query) that addresses the ingress, capturing up to the key. */
const INGRESS_PATH = /(\/webhooks\/providers\/)[^/?#]*/i;

/** Exactly the ingress route: one key segment, an optional trailing slash, an optional query. */
const INGRESS_ROUTE = /\/webhooks\/providers\/[^/?#]+\/?(?:[?#].*)?$/i;

/** Exactly the header-form route: no key segment, an optional trailing slash, an optional query. */
const INGRESS_HEADER_ROUTE = /\/webhooks\/providers\/?(?:[?#].*)?$/i;

/** Whether `url` is exactly the header-form ingress route (`…/webhooks/providers`). */
export function isIngressHeaderRoute(url: string | undefined | null): boolean {
  return typeof url === 'string' && INGRESS_HEADER_ROUTE.test(url);
}

/**
 * The ingress key a request carries, in exactly one form. `pathKey` is the path segment of the
 * URL form (null on the header form). Returns '' — which resolves to no provider, the uniform
 * 401 — when the request carries the key in both forms, in neither, or more than once.
 */
export function ingressKeyFrom(
  pathKey: string | null,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): string {
  const raw = headers[INGRESS_KEY_HEADER];
  if (Array.isArray(raw)) return '';
  const header = raw as string | undefined;
  if (pathKey !== null) return header === undefined ? pathKey : '';
  return header ?? '';
}

/** The request headers without the ingress-key header: nothing downstream ever sees the key. */
export function withoutIngressKeyHeader<T extends Readonly<Record<string, unknown>>>(
  headers: T,
): T {
  if (!(INGRESS_KEY_HEADER in headers)) return headers;
  const { [INGRESS_KEY_HEADER]: _key, ...rest } = headers;
  return rest as T;
}

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
 * Whether `url` addresses the ingress in either form: the URL form (`…/webhooks/providers/<key>`,
 * any extra segments) or the header form (`…/webhooks/providers`, PR-E). Every redaction point
 * uses this, so neither form's query string or key reaches a log line or a span.
 */
export function isIngressUrl(url: string | undefined | null): boolean {
  return isIngressHeaderRoute(url) || isIngressPath(url);
}

/**
 * `url` with the query string and fragment dropped on either ingress form, and, on the URL form,
 * the key replaced by `:providerKey`; any other URL unchanged. Total and side-effect free: safe
 * in every serializer.
 */
export function redactIngressPath<T extends string | undefined | null>(url: T): T {
  if (typeof url !== 'string' || !isIngressUrl(url)) return url;
  const path = url.split(/[?#]/, 1)[0]!;
  if (isIngressHeaderRoute(url)) return path as T;
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
 * The OpenTelemetry HTTP `requestHook` for incoming requests: on either ingress form, overwrite
 * every URL-bearing attribute with the redacted, query-free path, set `http.route` to the form's
 * template and name the span after it (spec §E.8). Any other request is left alone.
 */
export function redactIngressSpan(
  span: RedactableSpan,
  request: { url?: string; method?: string },
): void {
  if (!isIngressUrl(request.url)) return;
  const redacted = redactIngressPath(request.url!);
  const template = isIngressHeaderRoute(request.url)
    ? INGRESS_HEADER_ROUTE_TEMPLATE
    : INGRESS_ROUTE_TEMPLATE;
  for (const attribute of URL_ATTRIBUTES) {
    span.setAttribute(
      attribute,
      attribute === 'http.route'
        ? template
        : attribute === 'url.query'
          ? ''
          : attribute === 'http.url' || attribute === 'url.full'
            ? `[redacted]${redacted}`
            : redacted,
    );
  }
  span.updateName(`${request.method ?? 'POST'} ${template}`);
}
