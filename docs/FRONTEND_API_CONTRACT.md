# Frontend API Contract

> **STATUS: DRAFT — NOT YET A FROZEN CONTRACT.**
>
> This document is written against the repository at `6e84d7c` (Phase 1B.5.3). It is
> the formal contract between the backend/core track and the future frontend track,
> but it is **not binding yet**, because several conventions the frontend depends on
> most — pagination, filtering, sorting, list-envelope shape — **do not exist in the
> codebase at all**. They are marked below and are the subject of the
> frontend-ready-gate roadmap in `ROADMAP.md`.
>
> **Reading rule.** Every section carries one of three markers:
>
> | Marker | Meaning |
> |---|---|
> | **IMPLEMENTED** | Present in the code at `6e84d7c`, with the file cited. Safe to build against once frozen. |
> | **PLANNED / NOT IMPLEMENTED** | Described in `API.md` or another design document as an intention. **No code exists.** Do not build against it. |
> | **NOT YET DEFINED** | No implementation *and* no agreed convention. A decision is owed before the gate. |
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

## 9. Success response conventions — NOT YET DEFINED

**This is a known gap and a gate blocker.** The two existing tenant endpoints are already
inconsistent (`apps/api/src/tenancy/tenancy.controller.ts`):

- `GET /tenants/workspaces` → `{ "workspaces": [...] }` (named-key wrapper)
- `GET /tenants/workspaces/:id` → the bare object, unwrapped

No `data` envelope convention exists. The frontend must not infer one. A single
convention must be decided and applied before any list endpoint is frozen.

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

## 13. Pagination — NOT YET DEFINED

**No pagination exists anywhere in the codebase, and no convention is documented in any
design document.** `GET /tenants/workspaces` returns every visible row unbounded. This is
a gate blocker: a convention (cursor vs offset, parameter names, envelope shape) must be
decided, implemented and frozen before the frontend builds a single table.

## 14. Filtering — NOT YET DEFINED
## 15. Sorting — NOT YET DEFINED
## 16. Search — NOT YET DEFINED

None implemented; no conventions documented. Same gate treatment as §13.

## 17. Idempotency — PLANNED / NOT IMPLEMENTED

`API.md` §4 defines the full semantics, an `idempotency_keys` table exists in the schema,
and `idempotency-key` is in the CORS allow-list — but **no middleware, interceptor or
service reads the header**. Nothing is deduplicated today. The frontend must not assume
retry safety on any mutating endpoint.

## 18. Optimistic concurrency — NOT IMPLEMENTED

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

## 22. Validation semantics — IMPLEMENTED

A global `ValidationPipe` (`apps/api/src/common/http/validation.pipe.ts`) rejects unknown
properties. Failures return `400` / `VALIDATION_FAILED` with `details.issues` as an array
of human-readable strings. **`details.issues` is not yet per-field structured** — a
field-level shape is owed before form-heavy UI is built.

## 23. Rate limiting — PARTIAL

- **Implemented:** authentication endpoints only. Two independent buckets (source IP and
  target account, the latter keyed by a hash), Redis-backed
  (`apps/api/src/auth/auth-rate-limit.service.ts`). `POST /auth/login` returns
  `X-RateLimit-Limit` and `X-RateLimit-Remaining`, plus `Retry-After` on `429`.
- **Fails open** when Redis is unavailable — a deliberate, tested decision (`API.md` §5).
- **NOT IMPLEMENTED:** the general per-`(org, principal, endpoint_class)` limiter
  described in `API.md` §5. No non-auth endpoint is rate limited and no non-auth endpoint
  returns rate-limit headers.

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

## 31. Related

`API.md` (target architecture), `RBAC.md` (permission model), `TENANCY.md` (isolation),
`SECURITY.md`, `EVENTS.md`, `ROADMAP.md` (path to the frontend-ready gate).
