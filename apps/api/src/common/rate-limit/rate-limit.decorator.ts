import { SetMetadata } from '@nestjs/common';

/**
 * The endpoint classes the general limiter buckets by (`API.md` §5).
 *
 * **Two, and deliberately no more.** `API.md` §5 names `endpoint_class` as the
 * third term of the bucket key but defines no taxonomy, and the configuration
 * carries exactly one general limit pair (`RATE_LIMIT_DEFAULT_*`) — so no
 * per-class *budget* is derivable from anything in the repository. Inventing an
 * `admin` class would have meant inventing both its membership and its ceiling.
 *
 * What the split does buy, and the reason it exists at all, is **isolation**: a
 * client hammering writes cannot exhaust the budget its reads depend on, which
 * is the failure that makes a shared limiter feel arbitrary. Both classes draw
 * on the same configured limit; differentiating the ceilings is future work
 * (`DECISIONS.md` §3).
 */
export type RateLimitClass = 'read' | 'write';

export const RATE_LIMIT_CLASS = 'acc:ratelimit:class';

/**
 * Overrides the endpoint class a route is bucketed under.
 *
 * Rarely needed: the default derives from the HTTP method, which is already
 * correct for every route in the API today. It exists because "the class is
 * whatever the verb says" is a rule with no escape hatch, and the first route
 * whose cost does not match its verb — a `GET` that runs an expensive report,
 * say — should be able to say so on the route rather than forcing the taxonomy
 * to change.
 *
 * The parameter is the `RateLimitClass` union, so a value outside it is a
 * compile error rather than a silently-new bucket.
 */
export const RateLimit = (endpointClass: RateLimitClass) =>
  SetMetadata<string, RateLimitClass>(RATE_LIMIT_CLASS, endpointClass);

/**
 * The class a request falls into, from its HTTP method.
 *
 * **This is the whole of the trusted derivation.** The method comes from the
 * route Nest matched, not from anything the caller can assert: there is no
 * header, query parameter, body field or path segment that reaches this
 * function, and the return type admits exactly two values. A caller therefore
 * cannot select its own bucket, which is the property that keeps the limiter
 * from being trivially sidestepped by whoever wants a fresh one.
 *
 * Anything that is not a read is treated as a write — including a method this
 * API does not currently expose. Defaulting the unknown case to the *stricter*
 * side is the fail-closed direction for a throttle.
 */
export function endpointClassFor(method: string): RateLimitClass {
  return method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD' ? 'read' : 'write';
}
