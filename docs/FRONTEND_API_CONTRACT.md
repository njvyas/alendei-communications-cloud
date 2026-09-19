# Frontend API Contract

> **STATUS: DRAFT — CONVENTIONS FROZEN, SURFACE INCOMPLETE.**
>
> This document is written against the repository at Phase 1B.6.4. It is the
> formal contract between the backend/core track and the future frontend track.
>
> **What changed at 1B.5.8, and what it means for you.** Every *convention* a
> frontend depends on is now defined, implemented and tested: the response
> envelope, cursor pagination, filtering, sorting, field-level validation errors,
> error codes, correlation ids, date and enum handling. Those sections are stable
> and are the ones you would otherwise have had to guess at. Building a client
> against them now is safe.
>
> **Why it is still DRAFT.** The conventions are complete; the *surface* is not.
> Freezing now would freeze a contract that is missing most of the endpoints a
> console needs, and a "frozen" document that keeps growing teaches people to
> ignore the label. The exact blockers, each tied to the phase that closes it:
>
> | Blocker | Closes in |
> |---|---|
> | ~~**No user lifecycle**~~ — **CLOSED in 1B.6.1** (§30d). List, detail, create, profile update, disable and reactivate are live. What is still missing is narrower and named there: a created user cannot yet *sign in*, because credential delivery is `DECISIONS.md` D16 | 1B.6.1 ✅ / D16 |
> | **No organization, workspace, team or reseller CRUD** — only workspace *reads* exist (§30) | 1B.8 |
> | ~~**No API-key management**~~ — **CLOSED in 1B.6.2** (§30e). List, detail, create and revoke are live. Rotation and secret recovery are deliberately absent and are not coming: see §30e | 1B.6.2 ✅ |
> | ~~**No audit read** endpoint~~ — **CLOSED in 1B.6.3** (§30f) | 1B.6.3 ✅ |
> | **No way for an invited user to obtain a password**, so a user the console creates cannot sign in yet (`DECISIONS.md` D16) | D16 |
> | **OpenAPI is effectively empty of business schemas** — 5 decorators, all on health. No typed client can be generated (§30) | 1B.9 |
> | ~~**No general rate limiting**~~ — **CLOSED in 1B.6.4** (§23). Every authenticated endpoint is limited and returns `X-RateLimit-*` | 1B.6.4 ✅ |
> | **No development bootstrap**: no one-command way to obtain a working tenant and credentials | 1B.10 |
> | **No WebSocket or webhook surface** — plan for polling (§§24-25) | later |
>
> When those are closed this becomes FROZEN, and changes to it then follow §27's
> breaking-change rules.
>
> **Reading rule.** Every section carries one of three markers:
>
> | Marker | Meaning |
> |---|---|
> | **IMPLEMENTED** | Present in the code, with the file cited. Safe to build against. |
> | **PLANNED / NOT IMPLEMENTED** | Described in `API.md` or another design document as an intention. **No code exists.** Do not build against it. |
>
> There is no longer a third marker. Every convention that was "NOT YET DEFINED"
> in the 1B.5.7 draft was decided and implemented in 1B.5.8.
>
> Nothing in this document describes behaviour invented to suit the frontend.
> Where `API.md` describes a target architecture that is not built, this document
> says so rather than repeating it.

---

## 1. API base and versioning — IMPLEMENTED

- Base path: `/api/v1`. The version lives in the URL path, carried by the Nest global
  prefix (`apps/api/src/main.ts`, `config.http.globalPrefix`).
- `/health`, `/health/live`, `/health/ready` and `/metrics` sit **outside** the version
  prefix deliberately, so probe and scrape configuration survives a version bump.
- Breaking changes are to ship as `/api/v2` alongside `/api/v1` (`API.md` §1). No second
  version exists and no deprecation has yet been exercised.

## 2. Authentication — IMPLEMENTED

Two identity types, both resolved by `AuthGuard` (`apps/api/src/auth/auth.guard.ts`).

**Browser session (the frontend's path).**

| Step | Contract |
|---|---|
| `POST /api/v1/auth/login` | Body `{ email, password }`. Returns `{ accessToken, tokenType: "Bearer", expiresIn }`. |
| Refresh credential | Set as an `httpOnly`, `sameSite=lax` cookie named `acc_refresh`, path-scoped to `/api/v1/auth`. **Never in the response body and never readable by JavaScript.** |
| Access token | Sent as `Authorization: Bearer <accessToken>`. **Never in a URL, never in `localStorage`.** |
| `POST /api/v1/auth/refresh` | Requires the cookie **and** the `X-Acc-Refresh` header (see §23). Rotates the token; a refused rotation clears the cookie. |
| `POST /api/v1/auth/logout` | Requires the `X-Acc-Refresh` header. `204 No Content`. |

**API key.** `Authorization: Bearer ak_...`, bound to one organization, permissions
intersected at the key's binding scope. Not a frontend path; documented so the frontend
never assumes `Bearer` implies a session.

Endpoints are authenticated by default. Only `@Public()` routes (`login`, `refresh`,
health, metrics) are open.

## 3. Authorization — IMPLEMENTED (backend authoritative)

- Backend authorization is authoritative and is evaluated per **coherent grant**: one
  active grant must supply the permission *and* cover the target scope
  (`apps/api/src/auth/permission-evaluator.service.ts`, ADR-005).
- A target's scope ancestry is resolved from the database inside the request's own
  tenant transaction — never from request input
  (`apps/api/src/auth/scope-chain-resolver.service.ts`).
- **The frontend must treat `permissions` from `/auth/me` as a rendering hint only.**
  It is a flattened convenience list. It is explicitly *not* the authorization decision,
  and hiding a button is not a security control. Every action is re-checked server-side.
- Scope hierarchy: `platform → reseller → organization → workspace → team`.

## 4. Tenant context — IMPLEMENTED

- Derived from the authenticated principal's grants (`ScopeResolver`), never from client
  input. Enforced at the database by PostgreSQL RLS under the `acc_app` role.
- A request carrying an advisory tenant identifier (e.g. `?orgId=`) that disagrees with
  the resolved context is **refused**, not filtered
  (`apps/api/src/tenancy/advisory-tenant.guard.ts`).

## 5. Organization selection — IMPLEMENTED

- `/auth/me` returns `authorizedOrganizationIds`.
- One organization → selected automatically.
- More than one → the request **must** carry `X-Acc-Organization: <orgId>`; without it the
  request is refused with `TENANCY_CONTEXT_REQUIRED`
  (`apps/api/src/auth/scope-resolver.service.ts:193`).
- A header naming an organization the principal does not hold is refused, not ignored.

## 6. Workspace selection — NOT IMPLEMENTED

There is **no** workspace-selection header. `tenant.workspaceId` is *derived* from the
principal's narrowest grant and is read-only to the client. A frontend workspace switcher
has no backend mechanism today. Deciding whether one is needed is a gate item.

## 7. User identity — IMPLEMENTED

`GET /api/v1/auth/me` returns exactly:

```jsonc
{
  "actorType": "user",
  "authMethod": "session",
  "userId": "uuid", "apiKeyId": null, "sessionId": "uuid",
  "authenticatedAt": "ISO-8601",
  "tenant": { "orgId": "uuid|null", "workspaceId": "uuid|null",
              "resellerId": "uuid|null", "isPlatformAdmin": false },
  "authorizedOrganizationIds": ["uuid"],
  "roles": [{ "roleKey": "...", "scopeType": "...", "scopeId": "...|null", "orgId": "...|null" }],
  "permissions": ["workspaces.read", "..."]
}
```

No credential material of any kind appears here — no hashes, no tokens, no secret refs.

## 8. Permissions — IMPLEMENTED

The catalogue is `packages/contracts/src/permissions.ts` (dotted `resource.action` keys,
e.g. `workspaces.read`, `roles.create`, `platform.audit.read`), and
`GET /api/v1/permissions` returns it from Phase 1B.5.4:

```jsonc
{ "permissions": [{ "key": "workspaces.read", "domain": "workspaces",
                    "action": "read", "description": null }] }
```

Requires `permissions.read` at the caller's organization. Read-only and
system-defined — there is no permission CRUD and none is planned.

## 9. Success response conventions — IMPLEMENTED (Phase 1B.5.8)

One key at the top level, always, and the same on every endpoint:

```jsonc
{ "data": { ... } }                          // a single resource
{ "data": [ ... ], "page": { ... } }         // a collection
{ "error": { ... } }                         // a failure (§10)
```

`204 No Content` carries no body. The symmetry between `data` and `error` is
deliberate — branch on which key is present, without knowing the endpoint.

**The correlation id is not in a success body.** It is `x-correlation-id` on
every response, CORS-exposed, and repeated inside `error` only. One place for it
to be right rather than two.

**camelCase everywhere**, request and response alike.

This resolves the inconsistency earlier drafts of this document recorded:
`{workspaces:[…]}` here, `{roles:[…]}` there, and a bare object for a detail.

## 10. Error response conventions — IMPLEMENTED

Every thrown value is normalised by `AllExceptionsFilter`
(`apps/api/src/common/filters/all-exceptions.filter.ts`) into:

```jsonc
{
  "error": {
    "code": "AUTHZ_SCOPE_DENIED",
    "message": "human-readable",
    "correlationId": "uuid",
    "retryable": false,
    "details": { "issues": ["..."] }
  }
}
```

- `code` is stable and machine-readable; the closed set lives in
  `packages/contracts/src/errors.ts`.
- `retryable` is authoritative — clients must branch on it, not on the status class.
- `details` appears only for structured validation output. Internal exception state is
  never disclosed; an unexpected failure is always `INTERNAL_ERROR` /
  `"An unexpected error occurred"`.

> **Known documentation defect:** `API.md` §7 renders this field as `correlation_id`
> (snake_case). The implementation and the `ApiErrorResponse` type both use
> **`correlationId`** (camelCase). The implementation is correct; `API.md` is to be
> corrected. The frontend must use `correlationId`.

## 11. HTTP status conventions — IMPLEMENTED

| Status | Meaning here |
|---|---|
| `400` | Validation failure, or missing tenant context (`TENANCY_CONTEXT_REQUIRED`) |
| `401` | No/invalid credential |
| `403` | Authenticated, but no coherent grant covers the target |
| `404` | Target does not exist **or is not visible to this tenant** — deliberately indistinguishable (`API.md` §3a) |
| `409` | Resource conflict |
| `429` | Rate limited (auth endpoints only today) |
| `500` | Unexpected failure; correlation id only |

**The `403`/`404` rule is a security property, not an accident.** The frontend must not
present "this exists but you lack access" for a `404`.

## 12. Correlation and request IDs — IMPLEMENTED

- Every response carries `x-correlation-id` and `x-request-id`
  (`apps/api/src/common/context/correlation.middleware.ts`), both CORS-exposed.
- A client may supply `x-correlation-id` / `x-causation-id`, **honoured only if a
  well-formed UUID**; anything else is replaced, so arbitrary text cannot be injected
  into logs, audit rows or event envelopes.
- The frontend should surface `correlationId` from an error body in support flows.

## 13. Pagination — IMPLEMENTED (Phase 1B.5.8)

Cursor-based. Every collection endpoint except `/auth/sessions` (§16a).

```jsonc
"page": { "nextCursor": "eyJzIjoia2V5...", "hasMore": true, "limit": 25 }
```

| Parameter | Meaning |
|---|---|
| `?limit=` | 1–100, default **25**. Outside that range is a `400` |
| `?cursor=` | The previous page's `nextCursor`, **passed back verbatim** |
| `?sort=` | See §15 |

- **`nextCursor` is `null` on the last page**, and `hasMore` is `false`. Loop until `nextCursor` is null; do not compute page counts.
- **There is no total.** `hasMore` is derived by reading one row beyond the page, not by `COUNT(*)`. If a screen needs "1–25 of 312", say so and it will be added deliberately to the endpoints that need it — do not synthesise it by walking every page.
- **Cursors are opaque and signed.** Do not parse, construct, cache across sorts, or store one long-term. A cursor minted under `?sort=key` handed to `?sort=-key` is a `400`, and so is an edited one.
- **Invalid cursor → `400 PAGINATION_CURSOR_INVALID`.** The correct response is to restart from page one, not to retry.
- **Ordering is total** — the sort field then `id` — so a row is never skipped or repeated across a walk. A row inserted *ahead* of your cursor will appear; one inserted *behind* it will not. That is inherent to keyset pagination, not a defect.

## 14. Filtering — IMPLEMENTED (Phase 1B.5.8)

Allow-listed per endpoint (§16a). There is no operator syntax, no `filter[...]`
language, and no way to name a column.

**An unknown parameter is a `400`, not an ignored one.** A typo'd filter fails
loudly rather than silently returning unfiltered data.

Filters narrow within what the caller may already see; they never widen it.

## 15. Sorting — IMPLEMENTED (Phase 1B.5.8)

`?sort=field` ascending, `?sort=-field` descending — one token, round-trippable
without parsing. Allowed fields are per endpoint (§16a); anything else is
`400 VALIDATION_FAILED` with `rule: "SORT_NOT_ALLOWED"` and the allowed keys in
the message.

**`createdAt` orders by the record's UUIDv7 id**, which is chronological by
construction. Sorting by `createdAt` and by insertion order are the same thing
here; the ids are also exactly what cursors carry.

## 16. Search — NOT IMPLEMENTED

No free-text search on any endpoint. It needs indexes the control-plane tables do
not have, and adding a filter nobody has asked for is how an allow-list stops
being one. Ask if a screen needs it.

## 16a. Per-endpoint filters and sorts

| Endpoint | Filters | Sort fields | Default sort |
|---|---|---|---|
| `GET /roles` | `isSystemRole`, `key` | `key`, `createdAt` | `key` |
| `GET /permissions` | `domain` | `key`, `domain` | `key` |
| `GET /role-assignments` | `userId`, `scopeType`, `scopeId` | `createdAt`, `scopeType` | `-createdAt` |
| `GET /users` | `status`, `email` (exact, case-insensitive) | `createdAt`, `email`, `status` | `-createdAt` |
| `GET /api-keys` | `status`, `scopeType`, `scopeId`, `name` (exact) | `createdAt`, `name` | `-createdAt` |
| `GET /audit-logs` | `action`, `actorType`, `actorUserId`, `outcome`, `resourceType`, `resourceId`, `scopeType`, `scopeId`, `correlationId`, `occurredFrom`, `occurredTo` | `occurredAt` | `-occurredAt` |
| `GET /tenants/workspaces` | `status` | `name`, `createdAt` | `name` |
| `GET /auth/sessions` | — | — | — |

`GET /auth/sessions` is deliberately unpaginated: self-only, and bounded by the
server's max-sessions-per-user. It returns `{ data: [...] }` with **no `page`**.

## 17. Idempotency — IMPLEMENTED (Phase 1B.5.9)

`Idempotency-Key: <opaque>` on the endpoints below. **Optional**; omit it and the
endpoint behaves exactly as it always has.

| Endpoint | Supported |
|---|---|
| `POST /api/v1/roles` | ✅ |
| `POST /api/v1/role-assignments` | ✅ |
| `POST /api/v1/users` | ✅ (Phase 1B.6.1) |
| `POST /api/v1/api-keys` | ✅ (Phase 1B.6.2) — **but a replay does not return the secret.** See §30e |
| Everything else | Not needed — see below |

`PATCH /users/:id` takes no key: sending the same body twice produces the same state. `POST /users/:id/disable` and `/reactivate` take none either — a second call is `409 USER_LIFECYCLE_CONFLICT` naming the current status, which is a definite answer you can act on, and a better one than replaying the first `200` as though the transition were happening now.

**Key format**: 16–255 characters of `A-Za-z0-9`, `-`, `_`, `.`, `:`. Use a
UUIDv4/v7. A malformed key is `400 IDEMPOTENCY_KEY_INVALID`.

**Generate one key per logical operation and reuse it for every retry of that
operation.** Do not generate a new key on retry — that is the one usage mistake
the mechanism cannot protect you from.

| You do | You get |
|---|---|
| Send a request with a key | It executes; the status and body are recorded |
| **Retry the identical request with the same key** | The **original status and body, byte-for-byte**. No marker, no envelope change, nothing re-executed |
| Send a *different* body with the same key | `422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` |
| Retry while the first is still in flight | It waits and then returns the original result. If the wait is too long, `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` — retryable, so try again |
| Retry after *any* failure (validation, `403`, `409`, `5xx`) | Nothing was stored; the key is still usable. A failed attempt never poisons a key |
| Reuse a key after 24 hours | Treated as a fresh request |

**Endpoints without idempotency are not oversights.** `PATCH /roles/:id` sends a
complete replacement, so re-applying it converges. The `DELETE`s return `204` and
a repeat is `404` — already idempotent. `POST /auth/login` and `/auth/refresh` are
excluded deliberately: replaying a login would replay a **token**, and refresh
rotation is single-use by design.

**A key is not a credential.** It is scoped to your organization *and* to the
principal that used it. Another user — even in the same organization, even with
the same permissions — presenting your key is refused, and learns nothing about
your request. Authorization is re-evaluated on **every** request including a
replay: if you lose access between the original and the retry, the retry is
refused rather than replaying the old success.

**Correlation ids**: a replay carries **its own** `x-correlation-id`, not the
original's. Do not expect them to match; quote the one you received.

## 18. Optimistic concurrency## 18. Optimistic concurrency — NOT IMPLEMENTED

No `ETag`/`If-Match` support and no `version` field on any API resource. `state_version`
is designed for the message lifecycle (`ARCHITECTURE.md`) but no resource is exposed.

## 19. Date and time conventions — IMPLEMENTED

All timestamps are **ISO-8601 UTC strings**, serialised explicitly with `.toISOString()`
at the controller boundary (`auth.controller.ts`). Identifiers are **UUIDv7**, so they
sort chronologically — relevant to any future cursor scheme.

## 20. Enum conventions — IMPLEMENTED

Enums are lowercase snake/dotted string literals exported from `@acc/contracts`
(`scopeType`: `platform|reseller|organization|workspace|team`; `actorType`:
`user|api_key|system`; permission keys as `resource.action`). Never numeric.
**Clients must tolerate unknown enum members** — additive values are non-breaking (§27).

## 21. Nullable and optional fields — IMPLEMENTED

Absent-but-known values are **explicit `null`**, not omitted keys
(`apiKeyId: null`, `lastUsedAt: null`). The frontend should treat a missing key as a
contract violation rather than as `null`.

## 22. Validation semantics — IMPLEMENTED (Phase 1B.5.8)

A global pipe rejects unknown properties and returns `400 VALIDATION_FAILED`
with one issue **per failed rule**:

```jsonc
"details": {
  "issues": [
    { "field": "key",           "rule": "MATCHES", "message": "key must be lower snake_case…" },
    { "field": "permissions.0", "rule": "IS_IN",   "message": "each value must be one of…" }
  ]
}
```

- **`field`** — dotted path from the request root, so a nested member is
  addressable (`permissions.0`). Empty string for an issue about the request as a
  whole. Map it straight onto a form field.
- **`rule`** — stable screaming-snake code (`IS_UUID`, `MAX_LENGTH`,
  `WHITELIST_VALIDATION`, `SORT_NOT_ALLOWED`). **Branch on this**, never on the
  message.
- **`message`** — human-readable, and safe to display, but its wording is not
  part of the contract.

A field can produce several issues at once; render them all.

## 23. Rate limiting — IMPLEMENTED (Phase 1B.6.4)

Two independent limiters. **Ownership note:** general rate limiting was previously listed against 1B.10 in this document; it is owned by **1B.6.4** and is now implemented (`DECISIONS.md` ADR-010).

### General limiter — every authenticated endpoint

Buckets by `(organization, principal, endpoint class)`. All three are server-derived; **nothing you send can change which bucket you are in** — not `X-Tenant-ID`, `X-Organization-ID`, `X-Principal-ID`, an `X-RateLimit-*` request header, a query parameter or a body field. Sending them is harmless and has no effect.

| Header (on every limited response) | Meaning |
|---|---|
| `X-RateLimit-Limit` | The ceiling for your bucket |
| `X-RateLimit-Remaining` | Tokens left this window, floored at `0` |
| `X-RateLimit-Reset` | **Seconds until reset** — a duration, not a Unix timestamp |

On exhaustion:

```jsonc
HTTP 429
Retry-After: 37
{ "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded; retry after the interval in Retry-After",
    "correlationId": "uuid",
    "retryable": true,
    "details": { "retryAfterSeconds": 37 } } }
```

**Two endpoint classes, `read` and `write`**, split by HTTP method — `GET` reads, `POST`/`PATCH`/`DELETE` writes. They are **separate buckets sharing the same ceiling**, so a burst of writes cannot exhaust the budget your reads need. Both are per-organization *and* per-principal, so one user cannot spend a colleague's allowance and one tenant cannot spend another's.

**What this means for the UI, concretely:**

- **Back off on `429` using `Retry-After`**, and do not retry sooner. `retryable: true` means a later identical retry may succeed — not that it may be retried immediately.
- **`X-RateLimit-Reset` is seconds, not a timestamp.** Adding it to `Date.now()` is the intended use; parsing it as an epoch is not.
- **Polling loops are the main risk.** Anything that polls a list endpoint is spending the shared `read` budget for that user in that organization. Prefer a longer interval, and stop polling on a hidden tab.
- A **background refresh and a user action compete for the same bucket** when they run as the same user in the same organization and the same class. Budget accordingly.
- Endpoints that are *not* limited: `POST /auth/login` and `POST /auth/refresh` (they have their own stricter limits, below), and `/health*` and `/metrics`.

### Authentication limiter — login

- Two independent buckets, source IP and target account, Redis-backed (`apps/api/src/auth/auth-rate-limit.service.ts`). `POST /auth/login` returns `X-RateLimit-Limit` and `X-RateLimit-Remaining`, plus `Retry-After` on `429`.
- Stricter than the general limiter, and **entirely separate** — a login is never charged to the general limiter, and general traffic never consumes login allowance.

### Both fail open

**When Redis is unavailable, neither limiter refuses traffic.** A cache outage must not become an API outage (`API.md` §5c). You will see requests succeed with `X-RateLimit-Remaining` equal to the full limit. This is deliberate and tested; do not treat it as a signal.

### Not implemented

**Tenant-configurable limits.** Every deployment uses one ceiling for every tenant (`RATE_LIMIT_DEFAULT_*`). There is no per-plan, per-organization or per-endpoint override, no quota accounting and no billing integration. Do not build UI that implies a customer-visible quota. Per-class and per-tenant limits are future work (ADR-010).

**CSRF.** `POST /auth/refresh` and `POST /auth/logout` require the non-simple header
`X-Acc-Refresh` (any value). It forces a CORS preflight that a cross-site form post
cannot satisfy (`apps/api/src/auth/csrf.guard.ts`).

**CORS.** Credentialed, with an explicit origin allow-list (no wildcard). Allowed headers:
`authorization`, `content-type`, `x-correlation-id`, `x-causation-id`,
`x-acc-organization`, `x-acc-refresh`, `idempotency-key`.

## 24. WebSockets — PLANNED / NOT IMPLEMENTED

`API.md` §9 specifies a ticket-based scheme and the `ws_tickets` table exists, but
**neither the `POST /ws/ticket` endpoint nor any gateway is implemented**
(`DECISIONS.md` D15). There is no real-time channel of any kind. The frontend must plan
for polling until this ships.

## 25. Webhook conventions — PLANNED / NOT IMPLEMENTED

Neither inbound provider receivers nor outbound customer webhooks exist. No
`webhook_events`, `webhook_endpoints` or `webhook_deliveries` table has been created.

## 26. Event conventions — CONTRACT ONLY

The envelope and catalogue are defined in `packages/contracts/src/events.ts`
(`EVENT_TYPES`, `EventEnvelope`, `partitionKeyFor`). **No `outbox_events` table, no
producer, no relay and no consumer exist.** Redpanda runs in development but the
application neither publishes nor consumes. Not a frontend dependency today.

## 27. Deprecation and versioning rules — CONVENTION PROPOSED

**Non-breaking (no version bump):** adding an endpoint; adding an optional request field;
adding a response field; adding an enum member; relaxing validation.

**Breaking (requires `/api/v2` or a negotiated migration):** removing or renaming any
response field; changing a field's type or nullability; adding a required request field;
removing an enum member; changing an error `code` for an existing condition; changing a
status code for an existing condition; changing pagination or envelope shape.

Every breaking change must be recorded in `API.md` and here before it is merged.

## 28. Security expectations for the frontend

1. Never store the access token in `localStorage` or `sessionStorage`; keep it in memory.
2. Never put a token in a URL, query string or fragment.
3. Never read or attempt to read `acc_refresh` — it is `httpOnly` by design.
4. Send `X-Acc-Refresh` on `/auth/refresh` and `/auth/logout`.
5. Treat `/auth/me` `permissions` as presentation only (§3).
6. Never display a raw `500` message; surface `correlationId` instead.
7. Do not reconstruct tenant scoping client-side — the server has already applied it.

## 29. Tenant isolation expectations

RLS is the correctness backstop, not an application filter: list queries deliberately
carry no tenant predicate, so a forgotten application-side filter cannot leak another
tenant's rows. The frontend must never send a tenant identifier expecting it to *select*
data — advisory identifiers are cross-checked and refused on mismatch (§4).

## 29a. Envelope note for the examples below

The resource shapes in §§30–30c are shown **unwrapped**, as the object itself.
Every one of them travels inside the §9 envelope on the wire: `{ "data": <the
object> }` for a single resource, `{ "data": [ <objects> ], "page": {...} }` for a
collection.

## 30. Frontend-specific API dependencies — CURRENT REALITY

The **entire** implemented API surface at `6e84d7c`:

| Method | Path | Status |
|---|---|---|
| `POST` | `/api/v1/auth/login` | IMPLEMENTED |
| `POST` | `/api/v1/auth/refresh` | IMPLEMENTED |
| `POST` | `/api/v1/auth/logout` | IMPLEMENTED |
| `GET` | `/api/v1/auth/me` | IMPLEMENTED |
| `GET` | `/api/v1/auth/sessions` | IMPLEMENTED |
| `DELETE` | `/api/v1/auth/sessions/:id` | IMPLEMENTED |
| `GET` | `/api/v1/tenants/workspaces` | IMPLEMENTED (unpaginated) |
| `GET` | `/api/v1/roles` | IMPLEMENTED, 1B.5.4 (unpaginated) |
| `POST` | `/api/v1/roles` | IMPLEMENTED, 1B.5.4 |
| `GET` | `/api/v1/roles/:id` | IMPLEMENTED, 1B.5.4 |
| `PATCH` | `/api/v1/roles/:id` | IMPLEMENTED, 1B.5.4 |
| `DELETE` | `/api/v1/roles/:id` | IMPLEMENTED, 1B.5.4 |
| `GET` | `/api/v1/permissions` | IMPLEMENTED, 1B.5.4 (unpaginated) |
| `GET` | `/api/v1/auth/me/authorization` | IMPLEMENTED, 1B.5.7 |

All list endpoints above are **paginated from 1B.5.8** (§13) except
`/auth/sessions` (§16a), and every response uses the §9 envelope.
| `GET` | `/api/v1/role-assignments` | IMPLEMENTED, 1B.5.5 (unpaginated; 3 filters) |
| `POST` | `/api/v1/role-assignments` | IMPLEMENTED, 1B.5.5 |
| `GET` | `/api/v1/role-assignments/:id` | IMPLEMENTED, 1B.5.5 |
| `DELETE` | `/api/v1/role-assignments/:id` | IMPLEMENTED, 1B.5.5 |
| `GET` | `/api/v1/tenants/workspaces/:id` | IMPLEMENTED |
| `GET` | `/health`, `/health/live`, `/health/ready` | IMPLEMENTED |
| `GET` | `/metrics` | IMPLEMENTED (Prometheus, not for UI) |

**Everything else listed in `API.md` §2 — `/users`,
`/organizations`, `/resellers`, `/teams`, `/api-keys`, `/audit`,
`/messages`, `/providers`, `/channels`, `/routing`, `/campaigns`, `/contacts`,
`/templates`, `/billing`, `/wallets`, `/reports`, `/webhook-endpoints` — is
PLANNED / NOT IMPLEMENTED.** `API.md` §2 is a target map, not an inventory.

### OpenAPI

`SwaggerModule` is wired (`/api/v1/docs`, `/api/v1/openapi.json`, gated by
`config.http.openApiUiEnabled`), but **only the health controller carries decorators** —
5 `@Api*` decorators exist in the whole application. The generated document is therefore
effectively empty of business schemas. `API.md` §8's claim that "the spec cannot drift
from the implementation" is **not true today**, because there is nothing in the spec to
drift. Annotating controllers is a gate requirement.

## 30a. Role administration — IMPLEMENTED (Phase 1B.5.4)

A role, as returned by every `/roles` endpoint:

```jsonc
{
  "id": "uuid", "key": "campaign_reviewer", "name": "Campaign Reviewer",
  "description": "string|null",
  "orgId": "uuid|null",            // null marks a platform-defined role
  "isSystemRole": false,
  "allowedScopeTypes": ["organization", "workspace"],
  "permissions": ["workspaces.read"],   // sorted, complete
  "createdAt": "ISO-8601", "updatedAt": "ISO-8601"
}
```

`GET /roles` wraps it as `{ "roles": [...] }`; the single-resource endpoints
return it bare — the existing inconsistency noted in §9, not a new one.

Four behaviours the frontend must build against:

- **`permissions` is a complete replacement set on `PATCH`, never a delta.** Send
  the whole intended set; omitting the field leaves it untouched.
- **`isSystemRole` or `orgId === null` means read-only.** Both are refused with
  `403` on update and delete. A UI should render them without edit affordances.
- **Composition is bounded by the caller's own authority.** A permission the
  caller does not itself hold at the organization is refused with `403`
  `AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION`, and `error.details.rejected` lists
  exactly which keys — usable directly as per-field form feedback.
- **`allowedScopeTypes` is not yet enforced at grant time.** It is persisted and
  returned from 1B.5.4, but nothing refuses a grant outside it until Phase
  1B.5.5. Do not present it as an active constraint yet.

Deletion returns `409` `RESOURCE_CONFLICT` while any user still holds the role —
revoke the grants first. There is no grant API yet (§30).

**Still unpaginated**, like every list today; §13 applies.

## 30b. Role assignments — IMPLEMENTED (Phase 1B.5.5)

An assignment, as returned by every `/role-assignments` endpoint:

```jsonc
{
  "id": "uuid", "userId": "uuid", "roleId": "uuid", "roleKey": "campaign_reviewer",
  "orgId": "uuid|null",                  // derived by the database, never sent
  "scopeType": "organization",           // reseller | organization | workspace | team
  "scopeId": "uuid",
  "grantedBy": "uuid|null", "createdAt": "ISO-8601"
}
```

`GET /role-assignments` wraps it as `{ "assignments": [...] }` and accepts
`userId`, `scopeType` and `scopeId` as query filters; the single-resource
endpoints return it bare.

`POST` takes `{ userId, roleId, scopeType, scopeId }`. Five things the frontend
must build against:

- **`platform` is not an accepted `scopeType`** — sending it is a `400`.
  Platform grants are made out of band (`RBAC.md` §5b).
- **`422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED` is not an authorization failure.** It
  means the role is not designed to exist at that level;
  `error.details.allowedScopeTypes` lists the levels it does admit, and
  `details.requested` echoes what was sent. Render it against the scope picker,
  not as "you lack permission". A role's `allowedScopeTypes` is readable from
  `/roles`, so a correct picker can prevent this case entirely.
- **`403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION` names the offending keys** in
  `error.details.rejected` — usable directly as field-level feedback. It means
  the role carries a permission the *caller* does not hold at that scope.
- **`404` covers three different situations deliberately** — an unknown scope, a
  scope in another tenant, and an unreachable target user are all `404` with no
  identifier echoed. The frontend must not present any of them as "exists but
  forbidden".
- **`409` means either a duplicate grant or a disabled target user**; the
  message distinguishes them, the code does not.

`DELETE` returns `204`, or `404` if the assignment is already gone — a repeated
delete is safe and idempotent from the caller's point of view. Revocation takes
effect on the **next request**, not at token expiry.

**`409 AUTHZ_LAST_PLATFORM_ADMIN`** — IMPLEMENTED (Phase 1B.5.6). A revocation
that would leave the platform with no active administrator is refused. It is a
`409`, not a `403`: the caller had the authority, and the remedy is to appoint
another administrator first, not to acquire more permission. A console should
say so rather than rendering it as an access error, and should keep at least one
administrator un-revocable in its own UI as a courtesy — though the backend is
what enforces it, including for callers that never touch this API.

**Still unpaginated**, like every list today; §13 applies.

## 30c. Authorization view — IMPLEMENTED (Phase 1B.5.7)

`GET /api/v1/auth/me/authorization` returns the caller's own effective
authorization. **This is the endpoint a console should build its permissions UI
from** — not `/auth/me`'s `permissions` list.

```jsonc
{
  "actorType": "user",                 // or "api_key"
  "userId": "uuid|null", "apiKeyId": "uuid|null",
  "grants": [
    {
      "roleId": "uuid", "roleKey": "org_admin",
      "scopeType": "organization",     // reseller | organization | workspace | team | platform
      "scopeId": "uuid|null",
      "orgId": "uuid|null",
      "permissions": ["roles.read", "workspaces.read"]   // sorted
    }
  ],
  "organizationIds": ["uuid"],
  "isPlatformAdmin": false
}
```

Four things the frontend must build against:

- **Grants are not flattened, and must not be flattened by the client.** A
  permission appears under the grant that carries it, at the scope that grant
  covers. Holding `teams.create` in one workspace is **not** holding it across
  the organization, and collapsing `grants` into a `Set` of permission strings
  reintroduces exactly the bug the backend removed. To decide whether an action
  is available at a scope, look for a **single grant** that both carries the
  permission and covers that scope — never a union across grants.
- **`/auth/me`'s `permissions` remains a rendering hint only** (§3), and is the
  flattened list. Prefer this endpoint wherever the scope matters.
- **Self-only.** There is no parameter for another user and no cross-user
  variant; a `userId` in the path, query or body is ignored or `404`s.
- **API keys** see the key's effective authority, already intersected at its
  binding scope — narrower than its creator's, by design.

The endpoint requires authentication and performs no target-scope check, so it
never returns `403` for scope reasons and writes no denial audit.

## 30d. User administration — IMPLEMENTED (Phase 1B.6.1)

The user resource, as returned by **every** `/users` endpoint. This list is exhaustive — no other field is ever present, and none will be added without §27's rules:

```jsonc
{
  "id": "uuid",
  "email": "person@example.test",
  "phone": "+919876543210",        // or null
  "status": "invited",             // invited | active | disabled
  "lastLoginAt": "ISO-8601|null",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

**There is deliberately no `passwordHash`, `passwordUpdatedAt`, `mfaSecretRef` or `mfaEnabled`**, and no session, token or API-key material. Do not build a UI that expects an MFA indicator: MFA is not implemented (`RBAC.md` §5), and the flag is withheld rather than returned as `false` so a console cannot render a control that does nothing.

**Role assignments are not embedded.** Use `GET /role-assignments?userId=<id>` — it is the same data with its own read model, and duplicating it here would give you two representations of authorization to keep in step.

| Method | Path | Permission | Success |
|---|---|---|---|
| `GET` | `/api/v1/users` | `users.read` | `200 { data: [user], page }` |
| `GET` | `/api/v1/users/:id` | `users.read` | `200 { data: user }` |
| `POST` | `/api/v1/users` | `users.invite` | `201 { data: user }`, `status: "invited"` |
| `PATCH` | `/api/v1/users/:id` | `users.update` | `200 { data: user }` |
| `POST` | `/api/v1/users/:id/disable` | `users.disable` | `200 { data: user }` |
| `POST` | `/api/v1/users/:id/reactivate` | `users.reactivate` | `200 { data: user }` |

**There is no `DELETE`, and there will not be one.** `acc_app` holds no delete grant on `users` and audit rows must outlive the identity they describe (ADR-007 D-1). Build "remove from organization" as **disable**, or as revoking the user's grants through `/role-assignments` — those are different actions and a console should offer whichever it means. A `DELETE` request returns `404` because no route exists, not because the user does not.

### Whose users you see

`users` has no organization column: a user's tenancy is entirely the grants they hold. Every endpoint here is scoped to **users holding at least one grant in the organization the request resolved to** — the one selected implicitly or named in `X-Acc-Organization` (§5). Two consequences to design around:

- A user who exists but holds no grant in this organization is `404`, byte-for-byte the same answer as an id that was never issued. **Never present it as "exists but forbidden."**
- A user who belongs to two organizations appears in both lists, and switching `X-Acc-Organization` changes which list they appear in. They are one identity with one id, not two records. **This matters for disable — see below.**

### Creating a user

```jsonc
POST /api/v1/users
{
  "email": "person@example.test",
  "phone": "+919876543210",                       // optional, E.164, or omit
  "initialRole": {                                // REQUIRED
    "roleId": "uuid",                             // from GET /roles
    "scopeType": "organization",                  // reseller|organization|workspace|team
    "scopeId": "uuid"
  }
}
```

Five things to build against:

- **`initialRole` is required**, not a convenience. A user with no grant would be invisible to the organization that created them — including to the very list you just created them in. Your create form must collect a role, and a role picker fed by `GET /roles` (whose `allowedScopeTypes` tells you which scope levels each role admits) is the right shape.
- **The created user cannot sign in yet.** They are `invited`, which by design holds no credential. **No email is sent** — nothing is sent on any channel. Say so in the UI rather than implying an invitation is on its way; how a person first obtains a password is `DECISIONS.md` D16 and is not built. When it is, this section changes and §27 applies.
- **No password field is accepted and none is returned.** Sending `password`, `passwordHash` or `status` is a `400`, and the response contains no credential of any kind. There is nothing for a "copy the temporary password" affordance to copy.
- **`platform` is not an accepted `scopeType`** — sending it is a `400`.
- **Creation is one atomic operation.** If the grant is refused, no user is created. You never have to clean up a half-created person.

| Failure | Code | Meaning for the UI |
|---|---|---|
| `409 RESOURCE_CONFLICT` | conflict | The address is already registered. The API deliberately does not say by whom or where — do not infer that they are in your organization. Offer "search existing users" rather than a retry |
| `404 RESOURCE_NOT_FOUND` | not found | The role or the scope is out of reach. Do not report the scope as existing |
| `403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION` | forbidden | The chosen role carries a permission *you* do not hold at that scope. `error.details.rejected` names the keys — usable directly as field feedback on the role picker |
| `403 AUTHZ_PLATFORM_ROLE_REQUIRED` | forbidden | A platform role was chosen. Filter platform roles out of the picker |
| `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED` | unprocessable | The role does not exist at that level. `details.allowedScopeTypes` lists the ones it does. **Not** an access error |
| `400 VALIDATION_FAILED` | bad request | Field-level issues in `details.issues` (§22) |

### Updating a user

```jsonc
PATCH /api/v1/users/:id
{ "phone": "+919876543210" }   // or { "phone": null } to clear
```

**`phone` is the only editable field, and the only one the DTO accepts.** Sending anything else — `status`, `email`, `roleId`, `orgId`, `scopeId` — is a `400`, not a silent ignore. Specifically:

- **Status is not a field.** Use the two lifecycle endpoints below. A console rendering an "active/disabled" toggle should call those, not `PATCH`.
- **Roles are not a field.** Use `/role-assignments`.
- **Email cannot be changed** (ADR-007 D-3). It is the login identity, and changing it needs a verified change flow that does not exist. Render it read-only. Do not build an edit affordance that has nowhere to send its value.

An empty `PATCH` is a `200` with the user unchanged and no audit entry, so an over-eager auto-save costs nothing.

### Disable and reactivate

```
POST /api/v1/users/:id/disable      → 200 { data: user }   // status: "disabled"
POST /api/v1/users/:id/reactivate   → 200 { data: user }   // status: "active" OR "invited"
```

- **Disabling signs the person out immediately.** Every live session is revoked in the same transaction, and their access token stops working on their next request — not at token expiry. Any API key created by that person also stops conferring permissions.
- **Disable is GLOBAL to the identity. It is not "remove from this organization".** A user may belong to several organizations, possibly under different resellers. `status` belongs to the person, not to a membership, so disabling them from your organization locks them out of **all** of them and revokes **all** their sessions — including ones they were using elsewhere. Do not label this button "Remove user", "Remove from organization" or "Revoke access"; label it as disabling the account and say what it reaches. If the user belongs to more than one organization, warn before confirming.
- **The organization-local action is a different one: revoke their grants.** `DELETE /api/v1/role-assignments/:id` (§30b), for each grant the user holds in your organization, ends their access *here* and leaves their account and their other organizations untouched. Offer both, and make the difference legible:

| What the operator means | Endpoint | Reach |
|---|---|---|
| "This person should not have access to **our** organization" | `DELETE /role-assignments/:id` | This organization only |
| "This person's **account** should be shut off" | `POST /users/:id/disable` | Every organization, every session |

  Most "remove this person" flows in a console mean the first. Defaulting to disable is the mistake this table exists to prevent.
- **Your organization may see a user disappear without having done anything.** Another organization that shares the identity can disable it, and there is no audit record in *your* organization when that happens (the record is filed under the acting organization). If a user's `status` reads `disabled` and nobody on your side did it, that is the explanation, not a bug. Reactivation is available to you if you hold `users.reactivate` — but note it restores the account globally too.
- **Reactivate does not always produce `active`.** A user who was disabled before they ever held a credential comes back as **`invited`**, because the database will not admit an `active` user with no credential. **Read `data.status` from the response** rather than assuming — this is the one place the endpoint's result is not fully predictable from the request.
- **Reactivation does not restore sessions.** The person must sign in again — and if they came back as `invited`, they cannot until D16 lands.
- **Repeating either is a `409 USER_LIFECYCLE_CONFLICT`**, with `error.details.status` carrying the current state. Use it to re-sync a stale list rather than showing a hard error: it usually means someone else got there first. Two *simultaneous* calls are the one case where both may answer `200` — the transition is checked and applied under read-committed isolation, so two overlapping callers can both observe the prior state. The committed result is the same either way, so treat `200` and `409` alike: re-read the row and render `data.status`. Do not count successes.

| Failure | Code | Meaning for the UI |
|---|---|---|
| `409 USER_LIFECYCLE_CONFLICT` | conflict | Already in that state. `details.status` is authoritative — refresh the row |
| `409 AUTHZ_LAST_PLATFORM_ADMIN` | conflict | This is the last active platform administrator. **Not an access error** — the caller had the authority. Say "appoint another administrator first"; do not offer a retry |
| `404 RESOURCE_NOT_FOUND` | not found | Not a member of this organization, or no such user |
| `403 AUTHZ_SCOPE_DENIED` | forbidden | The caller lacks the permission at this organization |

### Permissions to gate the UI on

Read them from `GET /auth/me/authorization` (§30c) — per grant, not from the flattened union:

| Action | Permission |
|---|---|
| See the user list and detail | `users.read` |
| Create a user | `users.invite` |
| Edit a phone number | `users.update` |
| Disable | `users.disable` |
| Reactivate | `users.reactivate` |

`users.reactivate` is **separate from `users.disable`** — a role may hold one without the other, so gate the two buttons independently. The seeded `org_admin` holds both; `reseller_admin` and `workspace_manager` hold neither.

## 30e. API-key administration — IMPLEMENTED (Phase 1B.6.2)

> **Read this section before building the create flow.** The secret is shown once and is then gone forever. A UI that assumes it can fetch it later, or that a retry will return it, will silently hand users unusable credentials.

The resource, as returned by **every** `/api-keys` endpoint. This list is exhaustive:

```jsonc
{
  "id": "uuid",
  "name": "CI deploy",
  "prefix": "ak_live_A1b2C3d4E5f6G7h8",   // public half — safe to display and log
  "status": "active",                      // active | expired | revoked  (derived)
  "scopeType": "organization",             // organization | workspace  — only these two
  "scopeId": "uuid",
  "orgId": "uuid",
  "scopes": ["workspaces.read"],           // requested, not effective — see below
  "expiresAt": "ISO-8601|null",
  "lastUsedAt": "ISO-8601|null",
  "revokedAt": "ISO-8601|null",
  "revokedReason": "string|null",
  "createdBy": "uuid|null",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

**There is no `secret` field on this resource.** It appears only on a fresh creation response, as an extra field, and nowhere else. There is also no `keyHash` and never will be.

| Method | Path | Permission | Success |
|---|---|---|---|
| `GET` | `/api/v1/api-keys` | `api_keys.read` | `200 { data: [apiKey], page }` |
| `GET` | `/api/v1/api-keys/:id` | `api_keys.read` | `200 { data: apiKey }` |
| `POST` | `/api/v1/api-keys` | `api_keys.create` | `201 { data: { …apiKey, secret } }` |
| `POST` | `/api/v1/api-keys/:id/revoke` | `api_keys.revoke` | `200 { data: apiKey }` |

**No `DELETE`, no un-revoke, no rotation.** Revocation is terminal. Build "delete key" as revoke, and "rotate" as revoke-then-create — there is no atomic rotation and no endpoint that replaces a secret in place.

### The secret — the one thing to get right

```jsonc
POST /api/v1/api-keys
{
  "name": "CI deploy",
  "scopeType": "organization",           // or "workspace"
  "scopeId": "uuid",
  "scopes": ["workspaces.read"],
  "expiresAt": "2027-01-01T00:00:00Z"    // optional; null/omitted = never expires
}
```

A **fresh** success returns the resource plus the plaintext:

```jsonc
{ "data": { …apiKey, "secret": "aB3xY…" } }
```

**Rules for the UI, in order of how much damage getting them wrong does:**

1. **Show the copy/save step only when `data.secret` is a non-null string.** Never render it unconditionally — on a replay the field is present and `null`, and a UI that renders it blindly will show an empty box where a credential should be.
2. **There is no way to retrieve it later.** Not from `GET /api-keys/:id`, not from a retry, not from support. Do not build a "reveal secret" affordance; there is no endpoint behind it.
3. **An idempotent replay returns `secret: null`.** If you send `Idempotency-Key` and retry after a timeout, the retry confirms the key was created and returns its metadata — but **not** the secret, because the server never stored one (ADR-008). Treat this as the expected outcome of a lost response, not an error.
4. **If the user loses the secret, the only path is revoke and create a new key.** Say so in the UI at creation time, before they dismiss the dialog. A confirmation step ("I have saved this key") is appropriate here in a way it rarely is.
5. The full credential the user needs is `"<prefix>.<secret>"` — present it joined, ready to paste. `prefix` alone is public and safe to show in the list afterwards so a user can tell their keys apart.

### Scopes are a request, not a grant

`scopes` is what the key *asks for*. Its effective authority is that set intersected with what **the creating user** holds at the key's binding scope, recomputed on every request. Two consequences:

- A key never outlives its creator's authority. If the creator loses a permission — or is **disabled** — the key loses it too, immediately, with no change to the key itself. A key whose creator is disabled still authenticates but can do nothing; it is **not** auto-revoked, and it stays visible and revocable in the list.
- Requesting more than you hold at that scope is refused up front: `403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION` with `error.details.rejected` naming the keys. Use it as field-level feedback on the scope picker. Populate that picker from `GET /auth/me/authorization` (§30c) filtered to grants covering the chosen binding scope — that way the refusal is unreachable.

### Binding scope

Only `organization` and `workspace`. Sending `platform`, `reseller` or `team` is a `400`. The binding is **immutable** — there is no rebinding endpoint — so make the scope picker part of the create form and show it read-only thereafter.

### Status is derived

`status` is computed from `revokedAt`, `expiresAt` and the current time; it is not a stored field you can filter on by writing to it. `revoked` wins over `expired`. Filter with `?status=active|expired|revoked`. Note that a key can move from `active` to `expired` with no request having occurred, so re-read rather than caching a status indefinitely.

### Errors

| Failure | Code | Meaning for the UI |
|---|---|---|
| `403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION` | forbidden | The requested `scopes` exceed your authority at that binding. `details.rejected` names them |
| `403 AUTHZ_SCOPE_DENIED` | forbidden | You lack the permission at that scope — including revoking a key bound to a workspace you do not cover |
| `403 AUTHZ_PERMISSION_DENIED` | forbidden | An API-key principal tried to create a key. Only signed-in users can |
| `404 RESOURCE_NOT_FOUND` | not found | Unknown key, or one in another tenant. **Never present it as "exists but forbidden"** |
| `409 API_KEY_LIFECYCLE_CONFLICT` | conflict | Already revoked. `details.status` is authoritative — refresh the row rather than showing a hard error |
| `400 VALIDATION_FAILED` | bad request | Field issues in `details.issues`, including a non-future `expiresAt` and an unknown permission in `scopes` |

### Permissions to gate the UI on

| Action | Permission |
|---|---|
| See the key list and detail | `api_keys.read` |
| Create a key | `api_keys.create` |
| Revoke a key | `api_keys.revoke` |

Held by `org_admin`; `alendei_support` holds `api_keys.read` only. `reseller_admin` and `workspace_manager` hold none — do not render the section for them.

### Deferred, so do not design around them

Rotation, secret recovery, secret delivery by email or any other channel, IP allowlists, network restrictions, usage analytics, quotas and per-key billing. None exists and none is planned in Phase 1B.

## 30f. Audit read — IMPLEMENTED (Phase 1B.6.3)

Read-only. There is no way to write, edit or delete an audit record through the API, and there never will be — the table is append-only at the database level.

```jsonc
{
  "id": "uuid",
  "occurredAt": "ISO-8601",
  "action": "user_role.granted",
  "outcome": "success",                  // success | failure | denied
  "actorType": "user",                   // user | api_key | oauth_client | system
  "actorUserId": "uuid|null",
  "actorApiKeyId": "uuid|null",
  "actorLabel": "string|null",           // set for oauth_client and anonymous login attempts
  "resourceType": "RoleAssignment",
  "resourceId": "uuid|null",
  "scopeType": "workspace",              // platform | reseller | organization | workspace | team
  "scopeId": "uuid|null",                // null only for platform
  "resellerId": "uuid|null",             // derived ancestry — server-computed, never sent
  "orgId": "uuid|null",
  "workspaceId": "uuid|null",
  "teamId": "uuid|null",
  "before": {…}|null,
  "after": {…}|null,
  "metadata": {…},
  "correlationId": "uuid",
  "causationId": "uuid|null",
  "ip": "string|null",
  "userAgent": "string|null"
}
```

| Method | Path | Permission | Success |
|---|---|---|---|
| `GET` | `/api/v1/audit-logs` | `audit.read` | `200 { data: [auditLog], page }` |
| `GET` | `/api/v1/audit-logs/:id` | `audit.read` | `200 { data: auditLog }` |

### What the caller can see

Not every audit record in the caller's tenant is visible to them, and the rule is not "same organization":

- An **organization administrator** sees their organization's rows and the workspace/team rows beneath them. They do **not** see their reseller's own rows, even though their organization belongs to that reseller.
- A **reseller-scope** principal additionally sees their reseller's own rows.
- A **platform administrator** sees everything, including `platform`-scoped rows.
- A **workspace-pinned** principal is refused the list entirely with `403` — a workspace grant does not cover the organization the list is authorized at. Do not render the audit section for them.
- An **API key** sees its organization's rows and never reseller rows.

**The guarantee you can build on: a row appears in the list if and only if `GET /audit-logs/:id` will serve it.** You never need to handle a row that lists but 403s on open.

### Filters and sorting

All filters are exact-match except the time window, and all of them narrow **within** what you can already see — a filter naming another tenant returns nothing rather than reaching it.

`action` · `actorType` · `actorUserId` · `outcome` · `resourceType` · `resourceId` · `scopeType` · `scopeId` · `correlationId` · `occurredFrom` · `occurredTo`

The window is half-open `[occurredFrom, occurredTo)`, so consecutive windows tile without showing a row twice.

**`correlationId` is the most useful filter here** and the one an investigation UI should build around: every record produced by one originating request shares it, so filtering by it reconstructs the whole causal fan-out. `causationId` gives the immediate parent within that chain, which is what lets you order it rather than merely group it.

**Sorting is `occurredAt` only** (`-occurredAt` default, newest first). Requesting any other sort is a `400`. This is deliberate — an audit trail is read chronologically, and everything else is a filter.

### Errors

| Failure | Code | Meaning for the UI |
|---|---|---|
| `403 AUTHZ_SCOPE_DENIED` | forbidden | No `audit.read` at this organization, or the record sits at a scope you do not cover (e.g. a reseller record) |
| `404 RESOURCE_NOT_FOUND` | not found | Unknown record, or one in another tenant. **Never present it as "exists but forbidden"** |
| `400 VALIDATION_FAILED` | bad request | Unknown filter, disallowed sort, malformed value. Unknown query parameters are refused, not ignored |
| `400 PAGINATION_CURSOR_INVALID` | bad request | Cursor malformed, tampered with, or reused under a different sort. Restart from page one |

### Displaying payloads safely

`before`, `after` and `metadata` are free-form JSON assembled by the backend and already passed through the server's redactor, which replaces credential-bearing values with `"[redacted]"`. Two things follow:

- **Render them as data, never as markup.** They contain values that originated from user input elsewhere in the system.
- **Do not build logic that depends on their shape.** They vary by `action` and are not a stable contract. Display them; do not parse them into UI state.

`ip` and `userAgent` are personal data. Show them where an investigation needs them, and treat them with the same care as any other personal field.

### Deferred, so do not design around them

Audit export or download, streaming/live tail, retention management, full-text search over payloads, and any aggregate or statistics endpoint. None exists.

## 30g. Branding and custom domains — NOT IMPLEMENTED

There is **no branding API and no custom-domain API**, and none is specified. Do not build against an assumed shape.

What is decided (ADR-009), so the eventual contract will not contradict it:

- **Branding is tenant data, not deployment configuration.** `resellers.brand_config`, `resellers.domain` and `workspaces.brand_config` already exist in the schema; no endpoint reads them yet.
- **Branding will be host-resolved and unauthenticated.** A login page must be branded before anyone has signed in, so the eventual resolver runs before authentication and returns presentation data only.
- **A hostname will never determine tenancy or authorization.** Arriving at `customer.example.com` or `portal.reseller.example` grants nothing. The authenticated principal remains the only source of tenant context, exactly as it is today (§4). Do not design a flow that assumes the host implies the tenant, and do not send a host-derived tenant identifier expecting the backend to honour it — it will not.

Until the contract exists, treat branding as static application configuration on the frontend side.

## 31. Related

`API.md` (target architecture), `RBAC.md` (permission model), `TENANCY.md` (isolation),
`SECURITY.md`, `EVENTS.md`, `ROADMAP.md` (path to the frontend-ready gate).
