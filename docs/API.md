# API Architecture

## 1. Namespace & versioning

All public and console APIs are served under `/api/v1`. Breaking changes ship as `/api/v2` alongside `/api/v1` for a documented deprecation window; non-breaking additions never bump the version. Version is in the URL path, not a header, for cache/proxy/observability simplicity.

## 2. Resource areas

| Path | Module | Purpose |
|---|---|---|
| `/auth` | `iam` | Login, refresh, logout, MFA challenge, session management |
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
| `/audit` | `audit` | Audit log query (permissioned) |
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

Every authenticated request resolves a `TenantContext` per `TENANCY.md` before any handler executes; no handler trusts a body/query tenant identifier over the resolved context.

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

- Enforced at the API gateway layer, keyed by `(org_id, api_key_or_user, endpoint_class)`, using a Redis token-bucket.
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

## 10. Related

Event-level contract (async, cross-service): `EVENTS.md`. Auth/session detail: `RBAC.md`. Provider-facing inbound webhook detail: `PROVIDER_ADAPTER.md`.
