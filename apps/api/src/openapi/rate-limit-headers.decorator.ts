import { SetMetadata } from '@nestjs/common';

/**
 * Which rate-limit response headers an operation actually sends — documentation
 * only (Phase 1C.3). Read by the OpenAPI factory; never by a guard or limiter.
 *
 * - `general` — the per-principal general limiter (`X-RateLimit-Limit`,
 *   `-Remaining`, `-Reset`): the default for every authenticated operation.
 * - `bucket` — a per-address authentication bucket (`X-RateLimit-Limit`,
 *   `-Remaining`, no `-Reset`): `POST /auth/login`, `POST /auth/refresh`.
 * - `general-or-bucket` — `POST /auth/logout`: the general limiter on the
 *   bearer path, the refresh bucket on the cookie path.
 * - `none` — no rate-limit headers: the default for a public operation.
 *
 * The runtime differences are documented as they are, not normalized (ADR
 * boundary).
 */
export type RateLimitHeaders = 'general' | 'bucket' | 'general-or-bucket' | 'none';

export const RATE_LIMIT_HEADERS = 'acc:openapi:rate-limit-headers';

export const DocumentedRateLimitHeaders = (kind: RateLimitHeaders) =>
  SetMetadata(RATE_LIMIT_HEADERS, kind);
