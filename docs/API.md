# API Architecture

## 1. Namespace & versioning

All public and console APIs are served under `/api/v1`. Breaking changes ship as `/api/v2` alongside `/api/v1` for a documented deprecation window; non-breaking additions never bump the version. Version is in the URL path, not a header, for cache/proxy/observability simplicity.

## 2. Resource areas

| Path | Module | Purpose |
|---|---|---|
| `/auth` | `iam` | Login, refresh, logout, session management. **No MFA challenge in Phase 1B** — MFA is not implemented (ADR-003 D-6) |
| `/ws/ticket` | `iam` | Mints a single-use, short-lived WebSocket connection ticket (§9). Issuance ships in Phase 1B; ticket *consumption* and the socket gateway are deferred (`DECISIONS.md` D15) |
| `/tenants` | `tenancy` | Organization/workspace/team CRUD (scoped by caller's role) |
| `/users` | `tenancy` | User invite/management |
| `/roles` | `tenancy` | Role CRUD (custom roles) |
| `/permissions` | `tenancy` | Permission catalogue (read-only, system-defined) |
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

A key is permanently bound to its organization (`api_keys.org_id`) and nothing on a request widens that binding. A client-supplied `workspace_id` or `team_id` may **narrow** what the key acts on; it can never create authority the key does not hold. The creator intersection is re-evaluated at use, not only at creation, so a key cannot outlive the authority that produced it (`RBAC.md` §5c).

The database enforces the same distinction rather than trusting the caller: `audit_logs_actor_shape` makes an actor identifier that contradicts `actor_type` unrepresentable — a `user` row cannot carry an API-key id, a `system` row cannot claim either, and an `oauth_client` row must carry an `actor_label` since it has no id column until OAuth2 ships (`DECISIONS.md` D6). An API-key actor is additionally tied to its own organization by a composite foreign key, so a key from one tenant can never appear as the actor on another tenant's record (`DATABASE.md` §12).

Every authenticated request resolves a `TenantContext` per `TENANCY.md` §2a before any handler executes; no handler trusts a body/query tenant identifier over the resolved context.

### 3a. Scope enforcement order

Authorization is two checks, not one, and both are mandatory (`TENANCY.md` §4a):

1. **Permission** — does the principal hold the permission this endpoint requires?
2. **Scope coverage** — does it hold that permission at a scope *covering the target resource's scope*, per the downward-only inheritance of `TENANCY.md` §1a.4?

Holding `workspaces.update` somewhere is never authority to update *this* workspace. A request that passes (1) and fails (2) is refused exactly as if it had failed (1).

**Enumeration follows the same rule as retrieval.** A list endpoint returns only what is within the caller's scope set; an out-of-scope resource is *absent* from the listing rather than present-and-forbidden. A direct fetch of an out-of-scope resource returns `404` — not `403` — and the error message never echoes the caller-supplied identifier, because either would confirm the resource exists.

**Path identifiers are advisory.** `/tenants/{org_id}/workspaces` may carry an `org_id` for readability and routing, but the authoritative organization is always the one resolved from the credential; a mismatch is `403` (`TENANCY.md` §2b).

**Selecting an organization when several are in scope.** A principal with grants in more than one organization sends the `X-Acc-Organization` header to choose which one the request acts in (`TENANCY.md` §2a, ADR-003 D-4). With exactly one organization in scope the header is optional. Absent while several are in scope → `400 TENANCY_CONTEXT_REQUIRED`. Naming an organization outside the principal's scope → `403 TENANCY_CONTEXT_MISMATCH`. The header selects among organizations already in scope; it never confers access, and a mismatch is never resolved by substituting a different organization or by returning an empty result.

**Scope-target authorization is not the guard's job alone.** The endpoint permission may be enforced declaratively, but the target-scope half is checked inside the service, through the shared evaluator, because a target's scope is often knowable only once it is loaded (`RBAC.md` §2, ADR-003 D-5).

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

**CSRF.** `SameSite=Lax` is a mitigation, not a guarantee — it is not honoured uniformly by older user agents, and it does not cover same-site attacker-controlled content. The refresh endpoint therefore also requires a **non-simple request**: it accepts only `POST` carrying a custom header (for example `X-Acc-Refresh: 1`), which forces a CORS preflight and makes the endpoint undrivable by a cross-site HTML form post. Logout is protected the same way. This is a required control, not a defence-in-depth nicety: without it, `SameSite=Lax` alone is the only thing standing between a cross-site request and a token rotation.

**Refresh rotation.** Every refresh rotates the token and records lineage. Presenting an already-rotated refresh token is treated as theft: the entire session chain is revoked and the event is audited.

## 4. Idempotency

This section is the API-facing view of the tier-1 mechanism defined canonically in `DATABASE.md` §7.1 — see that section before implementing; do not re-derive the semantics independently here.

- **Required** on endpoints that create billable or externally-visible side effects: `POST /messages`, `POST /campaigns/{id}/launch`, `POST /wallets/recharge`. **Optional but honored** on other mutating endpoints that opt in.
- Callers supply `Idempotency-Key` (a caller-generated opaque string, recommended UUIDv4+). The key is scoped `(org_id, endpoint, key)` — never global, never workspace-only.
- **Duplicate request, same payload**: if the original request already completed, the identical response (status + body) is returned verbatim — no re-execution, no new side effect.
- **Duplicate request, first still in flight**: `409 Conflict`, error code `IDEMPOTENCY_REQUEST_IN_PROGRESS`, with a `Retry-After` hint. The server never guesses at what the in-flight request will produce.
- **Same key, different payload**: `422 Unprocessable Entity`, error code `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` — reusing a key across different request bodies is rejected outright, never silently treated as either a replay or a new send.
- **Retention**: keys expire 24h after creation by default, organization-configurable between a 1-hour minimum and 7-day maximum (`DATABASE.md` §7.1); a key reused after its own expiry is a fresh request with no collision.
- This is strictly a **logical-message/API-call** dedup mechanism. It has no bearing on internal attempt identity (`DATABASE.md` §7.2) or on provider-side deduplication (`DATABASE.md` §7.3) — those are independent mechanisms further down the stack, not extensions of this header.

## 5. Rate limiting

- Keyed by `(org_id, api_key_or_user, endpoint_class)`, using a Redis token bucket. **In Phase 1B this runs in-process in the API** — there is no API gateway in the Phase 1 deployment topology (`DEPLOYMENT.md`). Moving it to a gateway later is a deployment change, not a redesign; the key shape and limits are unchanged by where it runs.
- Authentication endpoints carry their own stricter bucket (`RATE_LIMIT_AUTH_*`), and apply **two independent buckets** — one keyed by source IP and one by the target account — so that neither address rotation nor a spray across many accounts defeats the control on its own.
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
    "correlation_id": "uuid",
    "retryable": false,
    "details": {}
  }
}
```

- `code`: stable, machine-readable, namespaced by domain (e.g. `MESSAGES_INVALID_RECIPIENT`, `BILLING_INSUFFICIENT_BALANCE`, `AUTH_MFA_REQUIRED`, `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`) and documented in the OpenAPI spec's shared error schema.
- `retryable`: `true` only for errors where an identical retry (same idempotency key, unchanged payload) is safe and may succeed (e.g. `429`, `503`); `false` for validation/authorization errors where retrying without changing the request is pointless. Clients should not blindly retry on any 4xx/5xx without checking this flag.
- `details`: structured validation failures where applicable (e.g. per-field messages), never a dump of internal exception state.

## 8. API contract strategy (OpenAPI)

- Every NestJS controller is annotated (`@nestjs/swagger` decorators) so the OpenAPI 3.1 document is generated from source, never hand-maintained separately — the spec cannot drift from the implementation.
- The generated spec is published per environment (`/api/v1/openapi.json`, human-readable Swagger UI gated behind auth in non-dev environments) and is the input to generated client SDKs (Phase-dependent, tracked in `ROADMAP.md`).
- Contract tests run in CI against the generated spec (schema validation of real request/response pairs in integration tests) to catch undocumented or drifted fields before merge.

## 9. WebSockets

Real-time channels (inbox live updates, campaign progress, provider health dashboard) are served over WebSocket at `/api/v1/ws`, subscribed to tenant-scoped topics (`org:{org_id}:conversations`, `org:{org_id}:campaigns:{id}`).

**Connection authentication does not use a long-lived JWT placed in the URL** (a query-string token leaks into proxy/access logs and browser history). Instead:

1. An authenticated client first calls `POST /api/v1/ws/ticket` (standard session-JWT/API-key auth) which mints a `ws_tickets` row (`DATABASE.md` §2): a single-use, short-lived (~30s) opaque ticket bound to the caller's already-resolved `TenantContext` and an explicit topic scope.
2. The client opens the WebSocket connection and presents the ticket as its very first frame (or via `Sec-WebSocket-Protocol`, never as a URL query parameter).
3. The server consumes the ticket exactly once (`consumed_at` set — replay of the same ticket is rejected), binds the connection's tenant context to what the ticket recorded (never to anything the client sends afterward), and only then admits subscriptions within the ticket's topic scope.

The server never pushes data the connection's bound tenant context isn't authorized to see, and a connection can never widen its own scope after establishment.

### 9a. Scope enforcement on a WebSocket connection

The socket performs no scope resolution of its own — it inherits a decision already made over an authenticated HTTP call (`TENANCY.md` §4b). Four properties, each independently testable:

| Property | Consequence |
|---|---|
| Topic scope is computed at **ticket-issue** time from the caller's scope set, and recorded on the `ws_tickets` row | A user who could not subscribe to a topic over HTTP cannot obtain a ticket that admits it |
| The connection binds to the **ticket's** recorded `org_id`/`workspace_id`/`scope` | The client cannot assert tenancy on the socket at all — there is no field for it |
| Subscriptions are admitted only within the ticket's recorded scope | A subscription to another organization's, workspace's or team's topic is refused, not silently ignored |
| The ticket is consumed exactly once, is short-lived (~30s), and is stored only as a hash | Replay of a consumed ticket, use of an expired ticket, and a database read yielding a usable ticket are all closed |

A connection is **not** re-resolved against the user's current grants mid-session: it keeps the scope the ticket recorded. Revoking a grant therefore takes effect on the next ticket, and revoking the underlying session invalidates its outstanding tickets.

## 10. Related

Event-level contract (async, cross-service): `EVENTS.md`. Auth/session detail: `RBAC.md`. Provider-facing inbound webhook detail: `PROVIDER_ADAPTER.md`.
