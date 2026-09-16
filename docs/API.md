# API Architecture

## 1. Namespace & versioning

All public and console APIs are served under `/api/v1`. Breaking changes ship as `/api/v2` alongside `/api/v1` for a documented deprecation window; non-breaking additions never bump the version. Version is in the URL path, not a header, for cache/proxy/observability simplicity.

## 2. Resource areas

| Path | Module | Purpose |
|---|---|---|
| `/auth` | `iam` | Login, refresh, logout, session management, `/auth/me`. **Built in Phase 1B.3.** No MFA challenge — MFA is not implemented (ADR-003 D-6) |
| `/ws/ticket` | `iam` | Mints a single-use, short-lived WebSocket connection ticket (§9). Issuance ships in Phase 1B; ticket *consumption* and the socket gateway are deferred (`DECISIONS.md` D15) |
| `/tenants` | `tenancy` | Organization/workspace/team CRUD (scoped by caller's role) |
| `/users` | `tenancy` | User invite/management |
| `/roles` | `rbac` | Role CRUD (custom roles), plus read of the platform role definitions. **Built in Phase 1B.5.4** (§3c) |
| `/role-assignments` | `rbac` | Scope-bound role grant and revocation. **Phase 1B.5.5 — not implemented** (§3c) |
| `/permissions` | `rbac` | Permission catalogue (read-only, system-defined). **Built in Phase 1B.5.4** (§3c) |
| `/channels` | `provider-registry` | Supported channel catalogue |
| `/providers` | `provider-registry` | Provider CRUD, enable/disable/drain, capability config |
| `/routing` | `provider-router` | Routing policy CRUD, versioning, activation |
| `/fallback-policies` | `fallback-engine` | Fallback chain CRUD |
| `/messages` | `comms-api` | Send message, get message/attempt status |
| `/conversations` | `conversations` | Inbox thread listing/detail, reply |
| `/contacts` | `contacts` | Contact CRUD, identities, consent, suppression |
| `/campaigns` | `campaigns` | Campaign CRUD, launch, pause, progress |
| `/templates` | `templates` | Template CRUD, provider mapping, approval status |
| `/journeys` | `journeys` | Journey CRUD, versioning, activation, execution status |
| `/billing` | `billing` | Ledger read, invoices, GST detail |
| `/wallets` | `billing` | Wallet balance, recharge, auto-recharge config |
| `/resellers` | `resellers` | Reseller CRUD, markup config, branding |
| `/reports` | cross-module read models | Delivery/cost/quality reporting |
| `/audit` | `audit` | Audit log query (permissioned — `audit.read` within a tenant, `platform.audit.read` for platform-level records). Results are scope-filtered: a caller sees records at or below the scopes it holds, and platform-scoped records only with `platform.audit.read` (`DATABASE.md` §12) |
| `/webhooks/{provider}` | `webhooks` | Inbound provider webhook receivers, per-provider sub-path (`ARCHITECTURE.md` §10a) |
| `/webhook-endpoints` | `webhooks` | Customer-facing outbound webhook subscription CRUD (`ARCHITECTURE.md` §10b) |
| `/webhook-deliveries` | `webhooks` | Outbound delivery status query + replay (`EVENTS.md` §5d) |
| `/health` | platform | Liveness/readiness, unauthenticated, minimal detail |

### 2a. `POST /messages` — channel-pinning fields

`POST /messages` accepts an optional `requested_channel_id`. When supplied, it is a **hard channel constraint by default** — ACC never substitutes a different channel for that message unless the caller also sets `cross_channel_fallback_enabled: true`. This is the API-facing view of the mechanism defined canonically in `ROUTING_ENGINE.md` §1a; do not re-derive the semantics independently here. A caller sending a transactional OTP should never set `cross_channel_fallback_enabled`; a caller sending a marketing message that should be allowed to escalate across channels must set it explicitly — the platform default is the safer, non-escalating behavior.

## 3. Authentication & request identity

Every authenticated caller resolves to exactly one **identity type**, and `audit_logs.actor_type` (`DATABASE.md` §12) always records which:

| Identity type | Mechanism | Header | Use |
|---|---|---|---|
| Human user | Session JWT | `Authorization: Bearer <access_token>` | Web console, MFA-gated |
| Service account (API key) | Hashed API key | `Authorization: Bearer <api_key>` (distinguished by prefix, e.g. `ak_live_`) | Server-to-server integration, bound to one org and an explicit permission subset |
| OAuth2 client | Client credentials / auth-code bearer token | `Authorization: Bearer <token>` | Partner integrations (reserved, Phase 6+); a client is its own identity, distinct from any human user it may act on behalf of |
| System (background worker) | Internal, no HTTP request in the loop | n/a | Fallback escalation, scheduled jobs, event consumers — never presents an HTTP credential; its tenant context comes from the job/event payload per `TENANCY.md` §5, and its audit rows always carry `actor_type=system` |

These are not interchangeable for authorization purposes: a permission grant is checked against the actual identity type presenting the request, and an OAuth2 client is never silently treated as if it were the human user who authorized it (the human's identity, where relevant, is recorded separately as the authorizing party).

**An API key's effective permissions are an intersection, recomputed at use:**

```
effective_permissions =
      requested_key_scopes
    ∩ permissions_held_by_the_creator_at_the_key's_organization
    ∩ permissions_valid_for_the_target_operation
```

A key is permanently bound to its organization (`api_keys.org_id`) and nothing on a request widens that binding: an `X-Acc-Organization` naming any other organization is refused with `403 TENANCY_CONTEXT_MISMATCH` rather than ignored. A key bound to a workspace is restricted to it and cannot perform organization-wide operations. The creator intersection is recomputed on every request, so a key cannot outlive the authority that produced it (`RBAC.md` §5c).

Every successful API-key authentication emits an `api_key.authenticated` audit record, in the same transaction as the key's `last_used_at` bookkeeping. The record identifies the key by its row id only — never the presented credential, its secret half or its prefix.

The database enforces the same distinction rather than trusting the caller: `audit_logs_actor_shape` makes an actor identifier that contradicts `actor_type` unrepresentable — a `user` row cannot carry an API-key id, a `system` row cannot claim either, and an `oauth_client` row must carry an `actor_label` since it has no id column until OAuth2 ships (`DECISIONS.md` D6). An API-key actor is additionally tied to its own organization by a composite foreign key, so a key from one tenant can never appear as the actor on another tenant's record (`DATABASE.md` §12).

Every authenticated request resolves a `TenantContext` per `TENANCY.md` §2a before any handler executes; no handler trusts a body/query tenant identifier over the resolved context.

### 3a. Scope enforcement order

Authorization is two checks, not one, and both are mandatory (`TENANCY.md` §4a):

1. **Permission** — does the principal hold the permission this endpoint requires?
2. **Scope coverage** — does it hold that permission at a scope *covering the target resource's scope*, per the downward-only inheritance of `TENANCY.md` §1a.4?

Holding `workspaces.update` somewhere is never authority to update *this* workspace. A request that passes (1) and fails (2) is refused exactly as if it had failed (1).

**Enumeration follows the same rule as retrieval.** A list endpoint returns only what is within the caller's scope set; an out-of-scope resource is *absent* from the listing rather than present-and-forbidden. A direct fetch of an out-of-scope resource returns `404` — not `403` — and the error message never echoes the caller-supplied identifier, because either would confirm the resource exists.

**Path identifiers are advisory.** `/tenants/{org_id}/workspaces` may carry an `org_id` for readability and routing, but the authoritative organization is always the one resolved from the credential; a mismatch is `403` (`TENANCY.md` §2b). The same rule applies wherever the identifier arrives — path segment, query parameter, body field or header — and is enforced by one shared mechanism rather than a comparison per endpoint (ADR-004 D-3). Its outcomes are fixed:

| Supplied identifier | Response |
|---|---|
| Agrees with the resolved context | The request proceeds unchanged |
| Contradicts it | `403 TENANCY_CONTEXT_MISMATCH` — never substituted, never an empty `200` |
| Names something that does not exist | The **same** `403`, with an identical message, so the endpoint is not an existence oracle |
| Repeated or structured (`?org_id=A&org_id=B`) | `400 VALIDATION_FAILED` — refused, never resolved by parameter order |
| Malformed or empty | `400 VALIDATION_FAILED` — never treated as absent |
| Absent, where the endpoint declares it optional | The request proceeds under the resolved context |

An error never echoes the supplied identifier back.

**Selecting an organization when several are in scope.** A principal with grants in more than one organization sends the `X-Acc-Organization` header to choose which one the request acts in (`TENANCY.md` §2a, ADR-003 D-4). With exactly one organization in scope the header is optional. Absent while several are in scope → `400 TENANCY_CONTEXT_REQUIRED`. Naming an organization outside the principal's scope → `403 TENANCY_CONTEXT_MISMATCH`. The header selects among organizations already in scope; it never confers access, and a mismatch is never resolved by substituting a different organization or by returning an empty result.

**Scope-target authorization is not the guard's job alone.** The endpoint permission may be enforced declaratively, but the target-scope half is checked inside the service, through the shared evaluator, because a target's scope is often knowable only once it is loaded (`RBAC.md` §2, ADR-003 D-5).

**The endpoint guard is necessary and never sufficient**, and the two halves are wired so that omitting the second is a test failure rather than a silent hole. The declarative guard records the permission the route requires; the service-layer check asserts at runtime that the permission it is being asked about is the one the route declared, and that the target's scope is covered by a coherent grant (ADR-005 D-1) whose ancestry was resolved from the database (ADR-005 D-5). A scoped route that never reaches the service-layer check is caught by a test asserting every such route performs exactly one, rather than by review. Passing the guard alone authorizes nothing.

### 3b. Token transport, CORS and CSRF (Phase 1B, ADR-003 D-7)

**Access token** — returned in the login/refresh JSON response and presented as `Authorization: Bearer <token>`. Held in memory by the console. Never placed in a URL, a query parameter, `localStorage` or `sessionStorage`.

**Refresh token** — for the browser console, carried exclusively in a cookie:

| Attribute | Value | Why |
|---|---|---|
| `HttpOnly` | yes | JavaScript cannot read it, so an XSS foothold cannot exfiltrate a 30-day credential |
| `Secure` | yes | Never transmitted over plaintext HTTP |
| `SameSite` | `Lax` | Not attached to cross-site subrequests |
| `Path` | the refresh endpoint only | Not sent on ordinary API calls, so its exposure surface is one route |

`POST /auth/login` sets the cookie. `POST /auth/refresh` consumes it. **The refresh token is never returned as ordinary JSON to browser JavaScript.** Non-browser clients (server-to-server) authenticate with API keys and never use this flow at all.

**CORS.** Because the refresh call must send a cookie, it is a credentialed cross-origin request: the console sends `credentials: 'include'`, and the API must answer with an explicit `Access-Control-Allow-Origin` drawn from the configured `CORS_ORIGINS` allow-list plus `Access-Control-Allow-Credentials: true`. A wildcard origin is invalid on a credentialed request and must never be configured.

**CSRF.** `SameSite=Lax` is a mitigation, not a guarantee — it is not honoured uniformly by older user agents, and it does not cover same-site attacker-controlled content. The refresh endpoint therefore also requires a **non-simple request**: it accepts only `POST` carrying the header `X-Acc-Refresh`, which forces a CORS preflight and makes the endpoint undrivable by a cross-site HTML form post. Logout is protected the same way. This is a required control, not a defence-in-depth nicety: without it, `SameSite=Lax` alone is the only thing standing between a cross-site request and a token rotation.

The mechanism is the *absence* of a token rather than the presence of one: nothing is stored or compared, so there is no CSRF secret to leak, rotate or desynchronize. The protection comes entirely from the fact that a cross-origin caller must first pass a preflight that the origin allowlist refuses, and an HTML form cannot set a header at all.

**Refresh rotation.** Every refresh rotates the token and records lineage. Presenting an already-rotated refresh token is treated as theft: the entire session chain is revoked and the event is audited.

### 3c. Role and grant administration (Phase 1B.5)

**Implementation status.** **Roles** and **Permissions** ship in Phase 1B.5.4; **role assignments** ship in Phase 1B.5.5. All three are live. **Authorization introspection** is **Phase 1B.5.7 and NOT IMPLEMENTED** — specified here and marked, not built.

Nine endpoints, deliberately small. Every mutation writes its audit row **in the same transaction** as the change (ADR-003 D-2); every target scope is checked through the shared evaluator against a coherent grant (§3a); every out-of-scope target is `404` without echo rather than `403`.

**Roles** (module `rbac`) — **IMPLEMENTED, Phase 1B.5.4**

| Method | Path | Permission | Target scope | Request | Response | Errors | Audit | Idempotency | Transaction |
|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/roles` | `roles.read` | organization | — | `{roles:[{id,key,name,description,orgId,isSystemRole,allowedScopeTypes[],permissions[],createdAt,updatedAt}]}` — the organization's own roles plus the readable platform definitions | — | — | safe | one read-only tenant transaction |
| `GET` | `/roles/:id` | `roles.read` | organization | — | `200` role | `404` unknown or out-of-scope, with no echo of the id | — | safe | one read-only tenant transaction |
| `POST` | `/roles` | `roles.create` | organization | `{key,name,description?,allowedScopeTypes[],permissions[]}` | `201` role | `409` duplicate key; `403` a permission outside the actor's effective grant authority, a `platform.*` permission, or an `allowedScopeTypes` outside organization/workspace/team; `400` malformed key or unknown permission | `role.created` | not idempotent; duplicate key is `409`, never a silent success | one transaction: role + `role_permissions` + audit |
| `PATCH` | `/roles/:id` | `roles.update` | the role's organization | `{name?,description?,allowedScopeTypes?,permissions?}` | `200` role | `404` unknown/out-of-scope; `403` as above, **and `403` for any system or platform role** | `role.updated` with full `before`/`after` | naturally idempotent | one transaction |
| `DELETE` | `/roles/:id` | `roles.delete` | the role's organization | — | `204` | `404` unknown/out-of-scope; **`409` while any grant references it** (and `ON DELETE RESTRICT` beneath it); `403` system or platform role | `role.deleted` with `before` | `404` if already gone | one transaction |

`allowedScopeTypes` is persisted from Phase 1B.5.4 and returned on every role. It is **not enforced at grant time until Phase 1B.5.5** (`RBAC.md` §7) — a client must not infer that a grant outside it is currently refused.

These endpoints are **unpaginated, unfiltered and unsorted**, matching the conventions that exist today. Normalizing them onto a shared list convention is Phase 1B.5.8's; a local convention invented here is exactly the churn that phase exists to prevent.

`permissions` is a **complete replacement set**, not a delta. That is what lets the audit row describe the whole role rather than one edit, and it removes the add/remove endpoint pair that would otherwise need to stay consistent with each other.

**Permissions** (module `rbac`) — **IMPLEMENTED, Phase 1B.5.4**

| Method | Path | Permission | Target scope | Response | Notes |
|---|---|---|---|---|---|
| `GET` | `/permissions` | `permissions.read` | organization | `{permissions:[{key,domain,action,description}]}` | The catalogue is system-defined and read-only. There is no permission CRUD |

**Role assignments** (module `rbac`) — **IMPLEMENTED, Phase 1B.5.5**

| Method | Path | Permission | Target scope | Request | Response | Errors | Audit | Idempotency | Transaction |
|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/role-assignments` | `role_assignments.read` | organization | query `userId?`, `scopeType?`, `scopeId?` | `{assignments:[{id,userId,roleId,roleKey,orgId,scopeType,scopeId,grantedBy,createdAt}]}` | — | — | safe | one read-only tenant transaction |
| `GET` | `/role-assignments/:id` | `role_assignments.read` | organization | — | `200` assignment | `404` unknown or out-of-scope, with no echo of the id | — | safe | one read-only tenant transaction |
| `POST` | `/role-assignments` | `role_assignments.grant` | **the scope being granted at** | `{userId,roleId,scopeType,scopeId}` | `201` assignment | `404` scope or role out of reach (never confirmed to exist), or target user unreachable; `403 AUTHZ_SCOPE_DENIED` scope outside the actor's own scope set; `403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION` a permission outside its effective grant authority at that scope, naming the offending keys; `403 AUTHZ_PLATFORM_ROLE_REQUIRED` a platform role; `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED` scope type not admitted by the role; `409` duplicate, or a disabled target user | `user_role.granted` at the grant's scope | duplicate is `409`, decided by the unique index rather than by a check-then-insert | one transaction: guards → insert → audit |
| `DELETE` | `/role-assignments/:id` | `role_assignments.revoke` | the grant's scope, read from the stored row | — | `204` | `404` unknown, out-of-scope or already gone; `403` if the actor does not cover the grant's own scope; **`409 AUTHZ_LAST_PLATFORM_ADMIN` if it would remove the last active platform administrator** (Phase 1B.5.6) | `user_role.revoked` | `404` if already gone; two concurrent revocations yield one `204` and one `404` | one transaction: authorize → conditional delete → audit |

`POST /role-assignments` is the highest-risk endpoint in Phase 1B, and its target scope is **the scope being granted at** — not the actor's resolved context. That is what makes `RBAC.md` §7's non-escalation rule enforceable: the actor must cover the grant's scope and hold every permission the role carries *at that scope*, decided per coherent grant rather than against the flattened `principal.permissions`.

**`409 AUTHZ_LAST_PLATFORM_ADMIN`** is returned when revoking a grant would leave the platform with no active administrator (`RBAC.md` §7a). It is `409` rather than `403` deliberately: the actor held the authority and the request was well-formed — the platform may simply not enter that state, and the remedy is to appoint another administrator first, not to acquire more permission. The same condition is enforced by a database trigger beneath the service, so it holds for callers that never reach this API.

`scopeType` accepts `reseller`, `organization`, `workspace` and `team`. **`platform` is not representable**: a platform grant is made by the bootstrap CLI under a documented elevation (`RBAC.md` §5b), and leaving it out of the request shape means the refusal does not depend on a guard remembering to run.

**Query cost is constant per request**, independent of how many permissions the role carries: the scope chain is resolved once per check and the evaluator then decides in memory. `GET` list and `GET` detail are 2 queries, `DELETE` is 4, `POST` is 7 — plus the six `SET LOCAL` statements every tenant transaction issues. There is no N+1.

These endpoints are **unpaginated** and carry only the three filters named above; the list conventions are Phase 1B.5.8's.

**Authorization introspection** — **IMPLEMENTED, Phase 1B.5.7**

| Method | Path | Permission | Response |
|---|---|---|---|
| `GET` | `/auth/me/authorization` | none — self only, no target scope | `{actorType, userId, apiKeyId, grants:[{roleId,roleKey,scopeType,scopeId,orgId,permissions[]}], organizationIds[], isPlatformAdmin}` |

Grants are returned **as grants**, not flattened. A console cannot render a correct permissions UI from a union, and handing it one is how an incorrect flattened model gets reinvented client-side — each entry carries the scope its permissions are held at, and the response contains no union field at all. It discloses nothing the principal could not already derive, exactly as `authorizedOrganizationIds` on `/auth/me` already does.

**Self-only structurally.** The subject is the authenticated principal; there is no path segment, query parameter or body field that names anyone else, so there is nowhere to put a forged identifier (`DECISIONS.md` D23). For an API-key principal the grants are the key's *effective* authority, already intersected at its binding scope (§3).

**Field naming is camelCase**, as everywhere else in this API. This row previously showed snake_case, which the implementation has never used.

**Deliberately excluded from Phase 1B.5**

| Not built | Why |
|---|---|
| Permission create/update/delete | The catalogue is system-defined; a permission with no code enforcing it is a lie, and one enforced nowhere is a liability |
| Bulk grant/revoke | Defeats per-grant auditing: one request would produce either one row describing many privilege changes, or many rows with no way to tell which were intended |
| `PUT /users/:id/roles` (set replacement) | A set replacement hides individual revocations from the audit trail. Revocation is an explicit act with its own record (`RBAC.md` §8b) |
| Role permission add/remove endpoints | Subsumed by `PATCH /roles/:id`'s replacement set, with a complete `before`/`after` |

## 4. Idempotency

This section is the API-facing view of the tier-1 mechanism defined canonically in `DATABASE.md` §7.1 — see that section before implementing; do not re-derive the semantics independently here. **Implemented in Phase 1B.5.9** (ADR-006).

### 4a. What it is, and what it is not

Idempotency is **execution/replay coordination**: it records that a request ran and what it answered, so a retry after a network timeout returns the original answer instead of performing the work twice. It is **not** a business state machine — it never interprets, re-derives or re-validates the outcome, and the protected work is opaque to it.

**Supported today** (opt-in via the header; absent, the endpoint behaves exactly as before):

| Endpoint | Why |
|---|---|
| `POST /roles` | Creates a resource; a retry would otherwise be indistinguishable from a genuine duplicate |
| `POST /role-assignments` | Confers privilege; the same |

**Deliberately not supported, with reasons** — this is a classification, not an omission:

| Endpoint | Why not |
|---|---|
| `GET`, `HEAD`, `OPTIONS` | Safe. There is nothing to execute twice |
| `PATCH /roles/:id` | The permission set is a **complete replacement**, so the endpoint is already naturally idempotent — re-applying it converges on the same state |
| `DELETE /roles/:id`, `DELETE /role-assignments/:id`, `DELETE /auth/sessions/:id` | `204`, and already naturally idempotent: a repeat is `404` because the row is gone, which is the honest answer and needs no stored response |
| `POST /auth/login` | Replaying a login would replay a **token**, turning a stored response into a credential. Sessions are deliberately per-attempt |
| `POST /auth/refresh` | Rotation is single-use **by design** (ADR-003): replay-detection there revokes the token family. Idempotency would directly contradict it |
| `POST /auth/logout` | `204`, naturally idempotent |

An endpoint is added to the first table only when a duplicate would cause a second side effect. Requiring the header for frontend convenience where it buys nothing is how a mechanism becomes ceremony.

### 4b. The key, and what counts as "the same request"

`Idempotency-Key: <opaque>` — 16 to 255 characters of `A-Za-z0-9`, `-`, `_`, `.`, `:`. A UUIDv7/v4 is the recommended form. The server assigns the value no meaning; the minimum length exists so a careless `1` does not collide inside a shared organization namespace. A malformed key is `400 IDEMPOTENCY_KEY_INVALID`, refused before any lookup.

The key is stored against `(org_id, endpoint, idempotency_key)` — organization-wide so a caller cannot collide with itself across workspaces, and per endpoint so the same key on a different route is a separate request.

**The effective request** is fingerprinted with SHA-256 over a canonical serialization of:

`method` · `route pattern` · `orgId` · **the resolved principal's identity** (`actorType`, `actorUserId`, `actorApiKeyId`) · `pathParams` · `query` · `body`.

Deliberately **excluded**, because a retry is by definition a different transport event and hashing any of it would defeat the mechanism: `Date`, request id, correlation id, causation id, user agent, source address, the `Authorization` header, cookies, and every other header.

**Canonicalization**: object keys sorted at every depth, so a client library or proxy that reorders JSON does not turn a safe retry into a mismatch; array order preserved, because `[a,b]` and `[b,a]` are different requests; `undefined` and absent treated alike; explicit `null` distinct from absent.

**Why the principal is in the hash.** The key scope is organization-wide, so without it one principal could present another's key and receive that principal's stored response. Binding identity into the fingerprint means a different actor computes a different fingerprint and is refused. The principal's *identity* is hashed; its credential never is.

### 4c. Outcomes

| Situation | Result |
|---|---|
| First request | Executes, stores status + body, returns them |
| Identical repeat | **Replays the original status and body verbatim.** No re-execution, no marker added to the envelope |
| Same key, different effective request — including a different principal | `422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`. Nothing about the stored request is disclosed |
| Concurrent duplicate | Blocks on the original, then replays it. On exceeding the wait, `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` (retryable) |
| Any failure — validation, authorization, business `4xx`, `5xx`, crash | **Nothing is stored.** The key is free for a genuine retry |
| Key past its expiry | Reclaimed as a fresh request |
| No organization context | `400 TENANCY_CONTEXT_REQUIRED` — the key namespace is org-scoped |

**Only successes are stored**, and that is two guarantees at once. A transient database blip cannot permanently poison a key. And **a replay can never bypass authorization**: a refused request leaves nothing to replay, and a stored record is reached only *after* the current request has authenticated and had its own authorization evaluated, in the same transaction. A previously successful request is never a credential.

**Correlation ids.** A replay is its own request and carries **its own** `x-correlation-id`; the original's is kept on the record for diagnostics and is never returned as the current request's. Confusing the two would make a replay untraceable.

**Retention.** Records expire 24 hours after creation. Expiry is enforced at lookup — an expired record is reclaimed rather than replayed — so correctness does not depend on a sweeper. Physical deletion of expired rows is **not yet implemented**; see `DATABASE.md` §7.1.

## 5. Rate limiting## 5. Rate limiting

- Keyed by `(org_id, api_key_or_user, endpoint_class)`, using a Redis token bucket. **In Phase 1B this runs in-process in the API** — there is no API gateway in the Phase 1 deployment topology (`DEPLOYMENT.md`). Moving it to a gateway later is a deployment change, not a redesign; the key shape and limits are unchanged by where it runs.
- Authentication endpoints carry their own stricter bucket (`RATE_LIMIT_AUTH_*`), and apply **two independent buckets** — one keyed by source IP and one by the target account — so that neither address rotation nor a spray across many accounts defeats the control on its own. A refusal from *either* refuses the attempt.
- The account bucket is keyed by a hash of the identifier, not the identifier itself, so a dump of Redis keys is not a list of the addresses people have tried to sign in with.
- The IP key depends on `req.ip`, which depends in turn on how many proxy hops are trusted (`TRUSTED_PROXY_HOPS`). Trusting more hops than the deployment actually has lets a client forge `X-Forwarded-For` and choose its own bucket, so the value is configuration rather than a constant and `0` disables the trust entirely.
- **When Redis is unavailable the limiter fails open**, logs at `warn` on every degraded call, and flags the verdict. Redis is an accelerator and never a system of record (`DATABASE.md` §1): refusing every sign-in because a cache is down converts a degraded dependency into a total outage, and the limiter is a throttle rather than the authentication control itself — credentials are still verified and every failure is still audited. This is a tested decision, not the client's default error behaviour.
- Limits are tenant-configurable (plan-based defaults, override per organization); responses include standard `X-RateLimit-Limit/Remaining/Reset` headers and `429` with `Retry-After` on breach.

## 6. Webhooks — inbound vs. outbound (do not conflate; full model `DATABASE.md` §12, `EVENTS.md` §§4c, 5a–5d)

**Inbound** (`/webhooks/{provider}`): providers push delivery events to ACC. Verified, deduplicated, persisted to `webhook_events` before processing (`ARCHITECTURE.md` §10a).

**Outbound** (`/webhook-endpoints`, `/webhook-deliveries`): ACC pushes business events to customer-configured endpoints.

- `POST/GET/PATCH/DELETE /webhook-endpoints` manage a `webhook_endpoints` row: target URL, subscribed event types, status.
- Payloads are signed (`X-Alendei-Signature: t=<ts>,v1=<hmac>`), computed from the endpoint's `signing_secret_ref` (never exposed in plaintext after creation); the customer verifies using the secret shown once at creation/rotation time.
- Every delivery attempt is durably tracked on a `webhook_deliveries` row (`DATABASE.md` §12); failed deliveries retry with exponential backoff up to a configurable attempt cap, then move to `status=dead_letter` and the endpoint's `consecutive_failure_count` increments — after a configurable threshold the endpoint auto-disables (`EVENTS.md` §5a).
- `GET /webhook-deliveries` lists delivery status/history per endpoint; `POST /webhook-deliveries/{id}/replay` re-attempts a specific delivery (`EVENTS.md` §5d) — this **retries transmission only**, it never regenerates the underlying event or re-triggers a business action, and requires the same permission tier as any manual side-effect trigger, fully audit-logged.
- Replay protection on the *receiving* customer's side is enabled by the timestamp in the signature plus the stable `event_id` in every payload, which customers are expected to use for their own dedup on redelivery/replay.

## 7. Error contract

Consistent error envelope across all endpoints:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "human-readable message",
    "correlationId": "uuid",
    "retryable": false,
    "details": {}
  }
}
```

- `code`: stable, machine-readable, namespaced by domain (e.g. `MESSAGES_INVALID_RECIPIENT`, `BILLING_INSUFFICIENT_BALANCE`, `AUTH_MFA_REQUIRED`, `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`) and documented in the OpenAPI spec's shared error schema.
- `retryable`: `true` only for errors where an identical retry (same idempotency key, unchanged payload) is safe and may succeed (e.g. `429`, `503`); `false` for validation/authorization errors where retrying without changing the request is pointless. Clients should not blindly retry on any 4xx/5xx without checking this flag.
- `details`: structured validation failures where applicable (e.g. per-field messages), never a dump of internal exception state.

## 7a. Validation errors (Phase 1B.5.8)

A validation failure carries one issue **per failed rule**, not per field: a value can fail its type and its length at once, and collapsing those forces a form to re-derive which rule it was from prose.

```jsonc
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "correlationId": "uuid",
    "retryable": false,
    "details": {
      "issues": [
        { "field": "key",            "rule": "MATCHES",   "message": "key must be lower snake_case…" },
        { "field": "permissions.0",  "rule": "IS_IN",     "message": "each value must be one of…" }
      ]
    }
  }
}
```

- `field` — dotted path from the request root, so a form can address a nested member (`permissions.0`). Empty for an issue about the request as a whole.
- `rule` — stable screaming-snake code derived mechanically from the validator (`isUuid` → `IS_UUID`). Derived rather than hand-mapped, so a new decorator yields a sensible code without anyone remembering to extend a table.
- `message` — human-readable, and never load-bearing for a client's logic.

An unknown query or body parameter is **refused**, not ignored (`WHITELIST_VALIDATION`). Ignoring it is how a caller comes to believe a filter applied when it did not, which for a security-relevant filter is a silent widening.

## 8. Response envelope, pagination, filtering and sorting (Phase 1B.5.8)

Until this phase the API answered `{workspaces:[…]}` here, `{roles:[…]}` there, and a bare object for a single resource, with no pagination anywhere. Each shape was defensible alone; together they made a client guess per endpoint.

**The envelope.** One key at the top level, always:

| Response | Shape |
|---|---|
| Single resource | `{ "data": { … } }` |
| Collection | `{ "data": [ … ], "page": { … } }` |
| Error | `{ "error": { … } }` (§7, unchanged) |
| `204` | no body |

The symmetry between `data` and `error` is deliberate: a client branches on which key is present without knowing the endpoint. **The correlation id is not repeated in a success body** — it is on `x-correlation-id` for every response and is CORS-exposed, so there is one place for it to be right rather than two.

**Field naming is camelCase throughout**, request and response alike.

### 8a. Cursor pagination

```jsonc
"page": { "nextCursor": "eyJ…", "hasMore": true, "limit": 25 }
```

| Property | Rule |
|---|---|
| Parameters | `?limit=`, `?cursor=`, `?sort=` |
| Default page size | 25 |
| Maximum | 100 — a `limit` outside 1–100 is a `400` |
| `hasMore` | Derived by reading one row beyond the page. **There is no `COUNT(*)` and no total**: a count is a second scan of the same predicate on every page and no consumer needs one |
| `nextCursor` | Opaque, `null` on the last page. Passed back verbatim |
| Ordering | Always `(<sort field>, id)`. `id` is a UUIDv7, so the composite ordering is **total** and a row can neither be skipped nor repeated |
| Insert/delete mid-walk | Keyset resumes from a *value*, not an offset, so a row inserted or removed elsewhere cannot shift the window. A row inserted *behind* the cursor is not seen on this walk; one inserted ahead is |
| Invalid cursor | `400 PAGINATION_CURSOR_INVALID` — malformed, wrong signature, or minted under a different `sort`. One code for all three: which part of a forged cursor to fix is not information the API owes |

**Cursors are integrity-protected** (HMAC over the payload, keyed from the application signing secret and domain-separated). A cursor is a query continuation, and an editable one is a client-supplied predicate wearing the costume of server state. It is not the isolation boundary — the tenant predicate and RLS are — but treating a cursor as opaque only works if it actually is. A secret rotation invalidates outstanding cursors, which is correct: the client restarts from page one.

**Chronological sorts order by `id`, not by `created_at`.** This is a correctness requirement, not an optimisation: a cursor is text, and a `timestamptz` round-tripped through JavaScript loses the database's sub-millisecond precision, so the boundary lands *before* the row it was minted from and the same page repeats forever. `id` is a UUIDv7 — chronological by construction, and a string that round-trips exactly.

### 8b. Filters and sorts per endpoint

Filters and sort fields are **allow-listed per endpoint**. There is no generic filter language, no operator syntax, and no way to name a column: a client picks a key the endpoint publishes, and nothing else reaches SQL as an identifier.

`?sort=field` ascending, `?sort=-field` descending — one opaque token a client can round-trip without parsing.

| Endpoint | Filters | Sort fields | Default | Authorization |
|---|---|---|---|---|
| `GET /roles` | `isSystemRole`, `key` | `key`, `createdAt` | `key` | `roles.read` @ organization |
| `GET /permissions` | `domain` | `key`, `domain` | `key` | `permissions.read` @ organization |
| `GET /role-assignments` | `userId`, `scopeType`, `scopeId` | `createdAt`, `scopeType` | `-createdAt` | `role_assignments.read` @ organization |
| `GET /tenants/workspaces` | `status` (+ advisory `orgId`) | `name`, `createdAt` | `name` | `workspaces.read` @ organization |
| `GET /auth/sessions` | — | — | — | self only |

`GET /auth/sessions` is a deliberate exception: it is self-only and bounded by `AUTH_MAX_SESSIONS_PER_USER`, so it returns `{ data: [...] }` with no `page`. It is documented rather than quietly inconsistent.

**A filter narrows; it never widens.** Filters are applied inside what the tenant predicate and RLS already allow, so a caller naming another organization's key gets nothing rather than something.

### 8c. Where `Idempotency-Key` will fit

Nothing in these conventions conflicts with the idempotency mechanism §4 specifies, and none of it is implemented (Phase 1B.5.9). When it lands it is a **request header** on mutating endpoints, replaying the original **status and body verbatim** — which is exactly `{ "data": … }` or `{ "error": … }` as defined above. The envelope is what gets stored and replayed; pagination is unaffected, being safe and unkeyed.

## 9. API contract strategy (OpenAPI)

- Every NestJS controller is annotated (`@nestjs/swagger` decorators) so the OpenAPI 3.1 document is generated from source, never hand-maintained separately — the spec cannot drift from the implementation.
- The generated spec is published per environment (`/api/v1/openapi.json`, human-readable Swagger UI gated behind auth in non-dev environments) and is the input to generated client SDKs (Phase-dependent, tracked in `ROADMAP.md`).
- Contract tests run in CI against the generated spec (schema validation of real request/response pairs in integration tests) to catch undocumented or drifted fields before merge.

## 9a. Breaking changes introduced by Phase 1B.5.8

This is a pre-production system with no external consumer, so these ship without aliases. They are recorded because "internal" is not the same as "unnoticed" — the console work starts from this contract.

| Change | Before | After |
|---|---|---|
| Success envelope | `{roles:[…]}`, `{workspaces:[…]}`, bare object for a detail | `{data}` / `{data, page}` |
| `POST /auth/login`, `/auth/refresh` | `{accessToken, tokenType, expiresIn}` | `{data:{accessToken, tokenType, expiresIn}}` |
| `GET /auth/me`, `/auth/me/authorization`, `/auth/sessions` | payload at the top level | under `data` |
| List endpoints | unbounded | paginated, 25 by default |
| Validation issues | `{field, constraints:[string]}` | `{field, rule, message}`, one per failed rule |
| Unknown query parameter on `/tenants/workspaces` | silently ignored | `400 VALIDATION_FAILED`. The security property is unchanged and strictly stronger: the request carrying it no longer executes |

## 10. WebSockets

Real-time channels (inbox live updates, campaign progress, provider health dashboard) are served over WebSocket at `/api/v1/ws`, subscribed to tenant-scoped topics (`org:{org_id}:conversations`, `org:{org_id}:campaigns:{id}`).

**Connection authentication does not use a long-lived JWT placed in the URL** (a query-string token leaks into proxy/access logs and browser history). Instead:

1. An authenticated client first calls `POST /api/v1/ws/ticket` (standard session-JWT/API-key auth) which mints a `ws_tickets` row (`DATABASE.md` §2): a single-use, short-lived (~30s) opaque ticket bound to the caller's already-resolved `TenantContext` and an explicit topic scope.
2. The client opens the WebSocket connection and presents the ticket as its very first frame (or via `Sec-WebSocket-Protocol`, never as a URL query parameter).
3. The server consumes the ticket exactly once (`consumed_at` set — replay of the same ticket is rejected), binds the connection's tenant context to what the ticket recorded (never to anything the client sends afterward), and only then admits subscriptions within the ticket's topic scope.

The server never pushes data the connection's bound tenant context isn't authorized to see, and a connection can never widen its own scope after establishment.

### 10a. Scope enforcement on a WebSocket connection

The socket performs no scope resolution of its own — it inherits a decision already made over an authenticated HTTP call (`TENANCY.md` §4b). Four properties, each independently testable:

| Property | Consequence |
|---|---|
| Topic scope is computed at **ticket-issue** time from the caller's scope set, and recorded on the `ws_tickets` row | A user who could not subscribe to a topic over HTTP cannot obtain a ticket that admits it |
| The connection binds to the **ticket's** recorded `org_id`/`workspace_id`/`scope` | The client cannot assert tenancy on the socket at all — there is no field for it |
| Subscriptions are admitted only within the ticket's recorded scope | A subscription to another organization's, workspace's or team's topic is refused, not silently ignored |
| The ticket is consumed exactly once, is short-lived (~30s), and is stored only as a hash | Replay of a consumed ticket, use of an expired ticket, and a database read yielding a usable ticket are all closed |

A connection is **not** re-resolved against the user's current grants mid-session: it keeps the scope the ticket recorded. Revoking a grant therefore takes effect on the next ticket, and revoking the underlying session invalidates its outstanding tickets.

## 11. Related

Event-level contract (async, cross-service): `EVENTS.md`. Auth/session detail: `RBAC.md`. Provider-facing inbound webhook detail: `PROVIDER_ADAPTER.md`.
