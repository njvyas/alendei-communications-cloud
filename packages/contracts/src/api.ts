/**
 * The canonical HTTP conventions every ACC endpoint obeys (`API.md` §§7-9,
 * Phase 1B.5.8).
 *
 * These exist as one shared definition because the alternative is what the API
 * had until this phase: `GET /tenants/workspaces` answering `{workspaces:[...]}`
 * and `GET /tenants/workspaces/:id` answering the bare object, with no
 * pagination anywhere and a different wrapper key per resource. Each shape was
 * defensible alone; together they made a client guess per endpoint.
 */

/**
 * A successful response.
 *
 * `data` is the payload and the only place a payload ever appears — a single
 * resource is the object, a collection is the array. The symmetry with
 * `ApiErrorResponse`'s `error` is deliberate: a client can branch on which key
 * is present without knowing the endpoint.
 *
 * The correlation id is **not** repeated here. It is on `x-correlation-id` for
 * every response, success and failure alike, and is CORS-exposed; duplicating it
 * in each body would create a second place for it to be wrong.
 */
export interface ApiDataResponse<T> {
  readonly data: T;
}

/** A page of a collection. `page` is absent on non-paginated payloads. */
export interface ApiPagedResponse<T> extends ApiDataResponse<readonly T[]> {
  readonly page: PageInfo;
}

export interface PageInfo {
  /**
   * Opaque cursor for the next page, or `null` at the end.
   *
   * Clients pass it back verbatim as `?cursor=`. Its contents are an
   * implementation detail and are integrity-protected — see `API.md` §8a.
   */
  readonly nextCursor: string | null;
  /**
   * Whether another page exists.
   *
   * Derived by over-fetching one row, never by `COUNT(*)`: a count is a second
   * scan of the whole predicate on every page, and no current consumer needs a
   * total. An endpoint that genuinely needs one will add it explicitly rather
   * than every endpoint paying for it speculatively.
   */
  readonly hasMore: boolean;
  /** The page size actually applied, after defaulting and clamping. */
  readonly limit: number;
}

/** Pagination bounds, shared so a client and the server agree on the limits. */
export const PAGE_LIMITS = Object.freeze({
  DEFAULT: 25,
  MIN: 1,
  MAX: 100,
});

/**
 * One field-level validation failure.
 *
 * Three parts because a form needs all three and they are not interchangeable:
 * `field` says where to put the message, `rule` is the stable machine-readable
 * reason a client may branch on, and `message` is the human-readable text.
 * Before this phase only the human text existed, so a client wanting to react
 * to "too long" versus "wrong format" had to match on prose.
 */
export interface ValidationIssue {
  /** Dotted path from the request root — `permissions.0`, `scopeType`. */
  readonly field: string;
  /** Stable, screaming-snake: `IS_UUID`, `MAX_LENGTH`, `IS_NOT_EMPTY`. */
  readonly rule: string;
  readonly message: string;
}

/**
 * Sort direction syntax: `?sort=key` ascending, `?sort=-key` descending.
 *
 * A leading `-` rather than a second `order` parameter, so a sort is one opaque
 * token a client can round-trip without parsing it.
 */
export interface SortSpec {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export function parseSort(raw: string): SortSpec {
  return raw.startsWith('-')
    ? { field: raw.slice(1), direction: 'desc' }
    : { field: raw, direction: 'asc' };
}

export function formatSort(spec: SortSpec): string {
  return spec.direction === 'desc' ? `-${spec.field}` : spec.field;
}
