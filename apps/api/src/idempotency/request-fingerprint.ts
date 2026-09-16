import { createHash } from 'node:crypto';
import type { AuthPrincipal } from '@acc/contracts';

/**
 * Everything that makes two requests "the same request" for idempotency
 * purposes (`API.md` §4).
 *
 * What is *absent* matters as much as what is present. Transport and per-attempt
 * metadata are excluded deliberately: a retry is by definition a different
 * transport event, so hashing any of it would make every retry look like a new
 * request and defeat the mechanism entirely.
 *
 *   excluded — `Date`, request id, correlation id, causation id, user agent,
 *              source address, the `Authorization` header, cookies, and every
 *              other header except the key itself.
 *
 * The **resolved principal is included**, and that is a security property rather
 * than a detail. The documented key scope is organization-wide (`DATABASE.md`
 * §7.1) so that a caller cannot collide with itself across workspaces — but
 * org-wide scope alone would let one principal inside an organization present
 * another's key and receive that principal's stored response. Binding the
 * principal into the hash means a different actor computes a different
 * fingerprint and is refused, so a previously successful request can never
 * become a credential. The principal's *identity* is hashed; its credential
 * never is.
 */
export interface EffectiveRequest {
  /** `POST`, `PATCH`, … — uppercase. */
  readonly method: string;
  /**
   * The **route pattern**, not the concrete path: `/api/v1/roles/:id`, never
   * `/api/v1/roles/9f2…`. Path parameters travel in `pathParams` so two requests
   * to different resources differ, while the endpoint identity stays stable
   * enough to be a lookup key.
   */
  readonly route: string;
  /**
   * The resolved organization. `null` when the request has no organization
   * context, which `IdempotencyService` refuses before any lookup — the key
   * namespace is organization-scoped, so there is nowhere to put a record.
   */
  readonly orgId: string | null;
  readonly principal: AuthPrincipal;
  readonly pathParams: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
}

/**
 * Canonical JSON: a deterministic byte sequence for a value.
 *
 * Object keys are emitted in sorted order at every depth, so two semantically
 * identical bodies that merely serialise their keys in a different order produce
 * the same bytes. Without this a client library that reorders JSON — or a proxy
 * that re-encodes it — would turn a legitimate retry into a payload mismatch,
 * which is the failure mode most likely to be blamed on the server.
 *
 * Array order **is** preserved: `[a, b]` and `[b, a]` are different requests,
 * because for every list this API accepts the order is either meaningful or
 * irrelevant-but-caller-chosen, and treating them as equal would let a key be
 * reused for a request the caller did not make.
 *
 * `undefined` is normalised to `null` so that an absent property and an
 * explicitly-null one agree; both mean "not supplied" everywhere in this API.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined || value === null) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // A key whose value is `undefined` is absent, not present-and-empty, so it
      // is dropped rather than serialised — matching how JSON.stringify and the
      // validation pipe both already treat it.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }

  // Numbers, booleans and strings all have a single JSON rendering.
  return JSON.stringify(value);
}

/**
 * The stable fingerprint of an effective request.
 *
 * SHA-256, matching the posture used elsewhere in the platform for
 * integrity-bearing digests. It is not a secret and is never returned to a
 * caller — a fingerprint that differed would tell a caller what to change to
 * make its key match someone else's request.
 */
export function fingerprint(request: EffectiveRequest): string {
  // Versioned, so that a future change to what counts as "the same request"
  // invalidates old fingerprints loudly instead of silently comparing two
  // different definitions against each other.
  const payload = canonicalize({
    v: 1,
    method: request.method.toUpperCase(),
    route: request.route,
    orgId: request.orgId,
    // Identity only. The actor type is included because a user and an API key
    // are different principals even when one created the other.
    actorType: request.principal.actorType,
    actorUserId: request.principal.userId,
    actorApiKeyId: request.principal.apiKeyId,
    pathParams: request.pathParams,
    query: request.query,
    body: request.body,
  });

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
