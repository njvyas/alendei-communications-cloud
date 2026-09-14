# Architecture

Canonical system architecture for Alendei Communications Cloud (ACC). This is the document every other `/docs` file defers to for vocabulary, entity names, and structural decisions.

## 1. Architectural principle (non-negotiable)

> **Business logic must never directly call an external communications provider.**

Campaigns, journeys, the public API, and the inbox all speak to one internal contract — the Communication API — and know nothing about WhatsApp, RCS, SMS, email, voice, or any specific vendor. Providers are replaceable infrastructure, selected and invoked entirely inside the Provider Adapter layer.

This principle is not scoped only to the modules that exist today. Every future application-layer capability — campaigns, journeys/automation, the chatbot/flow builder, CRM/sales automation, commerce workflows, AI agents — is, architecturally, just another caller of the Communication API, subject to the exact same rule. None of them may special-case their way to a provider, a channel adapter, or a routing/billing shortcut. The full invariant and its enforcement points are stated once, normatively, in §26.

## 2. Request flow (the spine of the system)

```
Campaign Engine ─┐
Journey Engine ──┼──▶ Communication API ──▶ Communication Orchestrator ──▶ Channel Router
Public REST API ─┘                                                              │
                                                                                  ▼
                                                                        Eligibility Engine
                                                                                  │
                                                                                  ▼
                                                                          Fallback Engine
                                                                                  │
                                                                                  ▼
                                                                          Provider Router
                                                                                  │
                                                                                  ▼
                                                                         Provider Adapter
                                                                                  │
                                                                                  ▼
                                                                        External Provider
```

Each stage is a distinct module boundary (see §4) with its own contract, so any stage can change independently:

| Stage | Responsibility | Never does |
|---|---|---|
| Communication API | Validates request, resolves tenant/auth context, assigns `message_id`/`idempotency_key`, persists intent | Choose a provider |
| Communication Orchestrator | Owns the message lifecycle state machine, coordinates channel/fallback attempts, emits domain events | Speak HTTP to a provider |
| Channel Router | Decides candidate channel order (e.g. WhatsApp→RCS→SMS) from policy + contact capability | Know provider identities |
| Eligibility Engine | Filters candidates by consent, suppression, DLT registration, quota, provider capability | Score/rank providers |
| Fallback Engine | Owns delivery-outcome-based retry/escalation timers and state per attempt chain | Make the initial routing choice |
| Provider Router | Selects a specific provider among eligible ones per routing policy (priority/weighted/cost/quality/latency/geo/customer/campaign/hybrid) and circuit-breaker state | Format the provider payload |
| Provider Adapter | Translates the unified message into the provider's wire format, calls it, normalizes the response/webhook | Contain business/billing logic |

## 3. High-level system diagram

```
                        ┌───────────────────────────┐
                        │        Next.js Web         │  (admin console, inbox, campaigns)
                        └──────────────┬────────────┘
                                       │ HTTPS (REST + WS)
                        ┌──────────────▼────────────┐
                        │   API Gateway / BFF (Nest) │  authn, rate limit, idempotency
                        └──────────────┬────────────┘
        ┌──────────────┬───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼               ▼
   Tenant/IAM      Communication    Campaign/Journey   Billing/Wallet   AI Gateway
   Service          API + Orchestr.  Service            Service         Service
        │               │               │               │               │
        └───────┬───────┴───────┬───────┴───────┬───────┴───────┬───────┘
                ▼               ▼               ▼               ▼
          PostgreSQL        Redis           Kafka-compatible   OpenSearch
       (system of record)  (cache/locks/    event bus         (search/inbox
                            rate limit)      (outbox events)   index)
                                                   │
                                     ┌─────────────┴─────────────┐
                                     ▼                           ▼
                            Provider Router/Adapter      S3-compatible storage
                            (per-channel workers)         (media, exports, backups)
                                     │
                                     ▼
                            External Providers (simulated in dev/test; never
                            connected in Phase 0)
```

Cross-cutting: OpenTelemetry traces, Prometheus metrics, structured JSON logs, and the audit log wrap every service above.

## 3a. Initial send sequence (canonical, referenced by `ROUTING_ENGINE.md` and `FALLBACK_ENGINE.md`)

```
Logical Message Created (Communication API — validation, idempotency check, messages row persisted)
        ↓
Communication Orchestrator (owns the lifecycle state machine from here on)
        ↓
Routing Policy Resolution (resolve the single effective routing_policy per ROUTING_ENGINE.md §4 precedence)
        ↓
Channel Candidate Selection (Channel Router — ordered candidate channel list)
        ↓
Eligibility Evaluation (Eligibility Engine — consent/suppression/DLT/capability/quota filter)
        ↓
Provider Router (select a specific provider among eligible ones, per the resolved policy)
        ↓
Provider Adapter (translate + call)
        ↓
Provider Attempt (a message_attempts row, attempt_number = 1)
```

## 3b. Fallback sequence — re-evaluated, never blindly replayed

A critical distinction from the initial send: **the Fallback Engine does not execute a precomputed provider/channel chain blindly.** `fallback_steps` (`DATABASE.md` §4) records the *configured intent* (e.g. "WhatsApp Provider A → WhatsApp Provider B → RCS → SMS"), but by the time a fallback step is actually reached — possibly minutes after the original attempt — provider health, credentials, quotas, consent, and even the recipient's channel capability may have changed. Re-executing a stale plan without re-checking any of that would silently violate the Eligibility Engine's own guarantees. The fallback sequence is therefore:

```
Attempt outcome / delivery timer fires (see §9c, FALLBACK_ENGINE.md §4 for the DB-transition guard)
        ↓
Fallback Engine (determine next configured step; this is a *lookup*, not a decision)
        ↓
Eligibility Evaluation — RE-RUN (the target channel/provider from the configured step must still pass every Eligibility Engine check now, not merely have passed it originally)
        ↓
Channel Router — RE-RUN (if the configured step names a channel without a pinned provider, or if that channel has become wholly ineligible, the Channel Router re-derives the next viable candidate — bounded by `requested_channel_id` hard-constraint semantics, `ROUTING_ENGINE.md` §1a: a hard-pinned channel is never substituted, regardless of eligibility)
        ↓
Provider Router — RE-RUN (re-resolves the effective routing policy and selects among currently eligible providers — a provider that was healthy when the fallback policy was authored but is now OFFLINE is never selected merely because a config row names it)
        ↓
Provider Adapter
        ↓
Next Attempt (message_attempts row, attempt_number = previous + 1)
```

Every step of this sequence — including the initial send — is re-runnable and produces the same class of decision object (an ordered, currently-eligible candidate list), which is why the same Channel Router / Eligibility Engine / Provider Router modules serve both the initial send and every fallback escalation with no special-cased "fallback mode" logic inside them.

## 4. Service / module boundaries

ACC is built as a modular monolith-first NestJS codebase organized into bounded modules, deployable initially as one process per logical service and independently extractable later without an API contract change (module boundaries == future service boundaries):

| Module | Owns | Depends on |
|---|---|---|
| `iam` | Auth, sessions, API keys. MFA and SSO are reserved here but **not built in Phase 1B** (ADR-003 D-6, `DECISIONS.md` D6/D10) | `audit` |
| `auth` | Request authentication and tenant-context resolution: `AuthGuard`, access-token issue/verify, `ScopeResolver`, `X-Acc-Organization` selection, `PermissionEvaluator`, auth rate limiting, CSRF. Registered globally so the API denies by default. All of it shipped in Phase 1B.3, including the parts `ROADMAP.md` originally scheduled for 1B.4/1B.5 — the 1B.3 exit criterion is the authenticated chain proven end to end, which is not demonstrable without them (ADR-004 D-1) | `iam`, `audit` |
| `tenancy` | Orgs, resellers, workspaces, teams, RBAC/ABAC. Owns the advisory-identifier cross-check (`AdvisoryTenantGuard`), registered globally so any handler gets it by declaring the identifiers it accepts (`TENANCY.md` §2b, ADR-004 D-3). `PermissionEvaluator` itself lives in `auth`, alongside the scope resolution it depends on | `iam`, `audit` |
| `contacts` | Contacts, identities, consent, suppression | `tenancy` |
| `comms-api` | Public/internal message intake, idempotency | `tenancy`, `contacts` |
| `orchestrator` | Message lifecycle state machine | `comms-api` |
| `channel-router` | Channel ordering policy evaluation | `orchestrator`, `contacts` |
| `eligibility` | Consent/suppression/DLT/quota checks | `channel-router` |
| `fallback-engine` | Delivery-outcome timers, escalation | `orchestrator` |
| `provider-router` | Routing policy evaluation, circuit breaker | `fallback-engine` |
| `provider-registry` | Provider CRUD, credentials, capabilities, health | `provider-router` |
| `provider-adapters` | Per-provider/per-channel adapter implementations + simulator | `provider-registry` |
| `webhooks` | Inbound provider webhook intake/verification/replay protection **and** outbound customer webhook subscriptions, dispatch, retry/DLQ (`ARCHITECTURE.md` §10) | `provider-adapters` |
| `conversations` | Unified inbox threading | `comms-api`, `webhooks` |
| `templates` | Message template management, provider template mapping | `provider-registry` |
| `campaigns` | Bulk send orchestration | `comms-api`, `templates`, `contacts` |
| `journeys` | Workflow/journey execution engine | `comms-api`, `campaigns` |
| `billing` | Usage ledger, wallets, invoices, GST, reseller markup | `tenancy` |
| `resellers` | Reseller-scoped config, white-label | `tenancy`, `billing` |
| `ai-gateway` | AI provider/model abstraction | `tenancy` |
| `audit` | Immutable audit log — append-only, scope-aware, enforced at the database (`DATABASE.md` §12, `SECURITY.md` §4a, ADR-002) | all modules (write-only dependency) |
| `admin-control` | Provider/routing/fallback live configuration UI+API | `provider-registry`, `provider-router` |

Module boundaries map to NestJS modules with explicit public interfaces (services/DTOs); no module reaches into another's repository/ORM layer directly.

## 5. Unified message model

Every send — API, campaign, or journey — produces exactly one canonical `messages` row (the **logical message**) plus one `message_attempts` row per provider/channel attempt. **Ownership is strict and non-overlapping**: `messages` owns intent and current customer-facing disposition; `message_attempts` owns the immutable history of every physical try. Full column-level schema (this table is a readable summary of it): `DATABASE.md` §6.

| Field | Notes |
|---|---|
| `message_id` | UUIDv7, primary identity, generated by Communication API |
| `tenant_id` (`org_id`) | Organization id; **never** trusted from client input — derived from auth context |
| `customer_id` | Alias for the recipient's `contacts.id` (the org's end-customer, not an Alendei "Organization" — see naming note below) |
| `conversation_id` | Groups messages into a thread for the unified inbox |
| `campaign_id` / `journey_id` | Nullable; set when originated by a campaign or journey |
| `requested_channel_id` | Caller-pinned channel, if any (e.g. an OTP that must be SMS); `NULL` means "let the Channel Router decide" — distinct from `current_channel_id` below, which is an *outcome*, not a request. When non-null, this is a **hard channel constraint by default** — see `cross_channel_fallback_enabled` and `ROUTING_ENGINE.md` §1a |
| `cross_channel_fallback_enabled` | Only meaningful when `requested_channel_id` is non-null. `false` (default) = the requested channel is a hard constraint, no channel substitution ever, only same-channel provider fallback. `true` = cross-channel fallback per `fallback_steps` is explicitly permitted despite the pin. Ignored when `requested_channel_id IS NULL` (channel selection is already unconstrained). `ROUTING_ENGINE.md` §1a |
| `message_type` | e.g. `template \| session \| notification \| otp \| media` |
| `content` / `template` / `media` / `metadata` | Rendered body, template reference, S3-compatible media pointers, free-form caller context |
| `priority` | `low \| normal \| high \| critical` — informs queue priority and routing |
| `routing_policy_id` | The single *effective* policy resolved for this message per `ROUTING_ENGINE.md` §4's precedence rule, recorded at send time |
| `current_attempt_id` | FK to the `message_attempts` row currently authoritative for this message's disposition; `NULL` until the first attempt is created |
| `current_channel_id` / `current_provider_id` / `current_provider_message_id` / `current_attempt_number` | **Denormalized, read-only copies** of the fields on the row `current_attempt_id` points to — written only in the same transaction that updates `current_attempt_id` (see `DATABASE.md` §6). These replace what earlier drafts modeled as independent `messages.provider_id`/`channel_id`/`provider_message_id` fields, removing the ambiguity of two independently-writable copies of the same fact. |
| `status` | See lifecycle state machine, §6 — the single authoritative customer-facing status |
| `state_version` | Optimistic-concurrency token; incremented on every status/attempt transition (`FALLBACK_ENGINE.md` §4) |
| `timestamps` | `created_at, queued_at, sent_at, delivered_at, read_at, failed_at, updated_at` |
| `failure_code` / `failure_reason` | Normalized failure taxonomy (see `PROVIDER_ADAPTER.md`), reflecting the current attempt |
| `cost` | Sum of provider cost across all attempts for this logical message (derived from `usage_ledger`, kept in sync, never independently authoritative — `BILLING.md` §1) |
| `customer_charge` | Amount billed to the tenant per the org's `billing_policy` (`BILLING.md` §5) |
| `idempotency_key` | Caller- or system-derived; unique per org; enforces **logical-message** dedup only — see the idempotency model in §9a, not attempt-level or provider-level dedup |
| `correlation_id` | Cross-system tracing key (propagated to logs/traces/events) |

`message_attempts` carries, per attempt: `attempt_number` (see §6a — a single global monotonic counter, replacing any separate "fallback attempt number"), `channel_id`, `provider_id`, `provider_message_id`, `status`, `retry_count` (transient same-attempt retries, distinct from escalation), `deadline_at` (delivery-confirmation window end, polled by the DB-backed fallback timer), a snapshot reference to the routing policy/version that selected this attempt (`routing_policy_id`/`routing_policy_version_id` — a reference, never a copy of the policy config, since fallback re-resolves routing against current configuration, §3b), and its own timestamps/failure detail. Attempt-level pricing/cost references (a single `pricing_evaluation_id` reference, itself potentially explaining several independent pricing components) are covered in `BILLING.md` §16. Full definition: `DATABASE.md` §6.

**Naming note (resolved, not a contradiction):** the tenant hierarchy's "Organization" is also referred to as "Customer" (Alendei's paying customer). The message model's `customer_id` refers to a *different* concept — the org's own end-recipient, modeled as `contacts.id`. Everywhere ambiguity could arise, this document and `DATABASE.md` use **tenant/organization** for the paying customer and **contact** for the message recipient.

## 6. Message lifecycle state machine

```
CREATED → VALIDATED → QUEUED → ROUTING → PROVIDER_ACCEPTED → SENT
   → DELIVERED (terminal, success)
   → READ (terminal, success, channel-dependent)
   → PROVIDER_REJECTED → (fallback? → ROUTING on new attempt : FAILED)
   → DELIVERY_TIMEOUT → (fallback? → ROUTING on new attempt : FAILED)
   → FAILED (terminal, failure)
   → EXPIRED (terminal, TTL exceeded, e.g. OTP)
```

## 6a. Message state vs. attempt state — exactly how one derives from the other

A `message_attempts` row is created per provider/channel attempt, each independently progressing through its own `status` (`DATABASE.md` §6: `pending → sent → provider_accepted → {delivered | read | provider_rejected | delivery_failed | timed_out}`). The parent `messages.status` is **always derived from the current attempt's status by the Orchestrator, written transactionally alongside it** — no other code path sets `messages.status` directly. The derivation rule:

- `messages.status` mirrors `current_attempt_id`'s status while that attempt is active (e.g. attempt `provider_accepted` → message `PROVIDER_ACCEPTED`).
- When an attempt reaches a terminal *success* (`delivered`/`read`), `messages.status` becomes `DELIVERED`/`READ` and **no further attempt is created** for this message — the chain stops.
- When an attempt reaches a terminal *failure* condition that triggers escalation (`FALLBACK_ENGINE.md` §2), `messages.current_attempt_id` is reassigned to the new attempt and `messages.status` returns to `ROUTING` momentarily, then follows the new attempt.
- When an attempt fails and no further fallback step applies, `messages.status` becomes `FAILED`, permanently.

Every prior attempt's outcome remains permanently on its own immutable `message_attempts`/`message_events` rows regardless of which attempt is "current" — full lineage is always reconstructable for billing and audit, even though only the current attempt drives the customer-visible status. See `DATABASE.md` §6 for exactly which columns are denormalized onto `messages` for read convenience and why that denormalization cannot drift from this authoritative derivation.

## 7. Provider abstraction (summary — full detail in `PROVIDER_ADAPTER.md`)

- **Provider Adapter Interface**: `send()`, `checkStatus()`, `handleWebhook()`, `capabilities()`, `healthCheck()`, `estimateCost()`.
- **Provider Registry**: stores provider config, encrypted credentials, capabilities, and live health state; changes are hot-reloaded (DB row change + cache invalidation event), never requiring redeploy.
- **Provider Health States**: `HEALTHY, DEGRADED, CRITICAL, OFFLINE, DRAINING`.
- **Circuit Breaker States**: `CLOSED, OPEN, HALF_OPEN` — a distinct, faster-reacting signal from health state; breaker state is derived from a rolling error/latency window per provider, health state can also be set manually (e.g., admin drain) or by longer-window SLO breach.

## 8. Routing & fallback (summary — full detail in `ROUTING_ENGINE.md` / `FALLBACK_ENGINE.md`)

Routing policies support priority, weighted, cost-optimized, quality-optimized, latency-optimized, geographic, customer-specific, campaign-specific, channel-specific, and hybrid (weighted combination of the above) strategies, versioned via `routing_policy_versions` so policy changes are auditable and reversible. Exactly one policy is *effective* for any given message at any time, resolved by a fixed precedence hierarchy (platform → reseller → organization → workspace → channel → campaign/journey → message-level override) — `ROUTING_ENGINE.md` §4 is the single normative definition of this precedence; no other document defines a conflicting hierarchy.

Fallback is **delivery-outcome-based**, not acceptance-based: API acceptance by a provider only starts a delivery-confirmation timer; only a missed delivery confirmation (or explicit delivery failure) within the configured window triggers escalation to the next provider/channel in the configured chain, and that escalation always **re-evaluates** eligibility/routing rather than blindly replaying a precomputed plan (§3b). Chains are fully configurable, e.g.:

```
WhatsApp Provider A → WhatsApp Provider B → RCS Provider A → RCS Provider B
  → SMS Provider A → SMS Provider B
```

with per-step wait windows (e.g. 5 min WhatsApp → 3 min RCS → SMS as final step).

## 9. Idempotency, concurrency, and delivery semantics

ACC explicitly targets **exactly-once business outcome**, not exactly-once transport delivery — the latter is impossible to guarantee against external providers. This section summarizes the three distinct idempotency mechanisms; `DATABASE.md` §7 is the canonical, detailed definition and must be consulted before implementing any of them — they are not interchangeable and must not be conflated.

### 9a. Three tiers (summary — full detail `DATABASE.md` §7)

| Tier | Protects against | Scope | Backing table |
|---|---|---|---|
| API / logical-message idempotency | Duplicate customer/caller request (e.g. an HTTP retry) creating two logical messages | `(org_id, endpoint, idempotency_key)` | `idempotency_keys`, plus a narrower `(org_id, idempotency_key)` guard on `messages` itself |
| Internal attempt idempotency | A retried worker, duplicate Kafka event, or double-firing scheduler creating a duplicate provider/channel attempt | `(message_id, attempt_number)` | `message_attempts` unique constraint, guarded upstream by the conditional transition in `FALLBACK_ENGINE.md` §4 |
| Provider-side idempotency | Duplicate submission to the *external* provider after an ambiguous timeout | Provider-specific (uses the provider's own idempotency key where supported) | `message_attempts.provider_idempotency_key` — **a mitigation, not a guarantee** |

`messages.idempotency_key` (tier 1) is never used to provide attempt-level dedup (tier 2) — a single logical message's idempotency key does not change across fallback escalations, precisely because it identifies the *logical* send, not any one physical attempt.

### 9b. Other dedup/ordering mechanisms

- **Webhook dedup**: unique constraint on `(provider_id, provider_event_id)` in `webhook_events`; duplicate webhooks are acknowledged (2xx) but not reprocessed. See `EVENTS.md` §5c for the distinction between this (inbound) and outbound webhook delivery dedup (`webhook_deliveries`, unique on `(endpoint_id, event_id)`).
- **Out-of-order events**: every inbound provider event carries (or is stamped with) a provider timestamp; the orchestrator applies a monotonic state machine guard — a "delivered" event arriving after a "read" event is recorded but does not regress `messages.status`.

### 9c. Concurrency control — database is the source of correctness, Redis is an accelerator only

- **Distributed locking**: Redis-based locks (Redlock pattern) MAY be used as a fast-path optimization to reduce contention on the fallback-escalation critical section, but **the actual correctness guarantee comes from a PostgreSQL conditional transaction** (`FALLBACK_ENGINE.md` §4): `UPDATE messages SET current_attempt_id = ..., state_version = state_version + 1 WHERE id = ... AND state_version = :expected AND status NOT IN (terminal states)`. A zero-row `UPDATE` result means another worker already won the race (or the message reached a terminal state), and the losing worker's escalation becomes a no-op — never a duplicate. If Redis is unavailable, this DB-level guard still holds; Redis's absence degrades performance (more contention, more no-op races), never correctness.
- **Retries/timeouts**: all provider adapter calls have bounded timeouts and bounded retries with jittered backoff; retries of the *same attempt* reuse that attempt's `provider_idempotency_key` (§9a) and increment `retry_count`, never creating a new `attempt_number`.
- **Race conditions** this design explicitly protects against (verified by the tests in `TESTING.md` §3/§7): duplicate scheduler execution, duplicate Kafka delivery of a fallback-trigger event, a worker crash mid-transition (the conditional `UPDATE` is atomic — a crash before commit leaves no partial state), Redis lock loss or expiry (falls back to DB-level contention, not corruption), two webhooks for the same attempt processed concurrently by different consumers, a fallback timer firing at the same instant a late delivery webhook arrives, and a late/out-of-order provider event arriving after escalation has already occurred (recorded on its own attempt, never regresses the message).

## 10. Webhook architecture

ACC has two structurally distinct webhook systems that must never be confused: **inbound** (providers telling ACC about delivery events) and **outbound** (ACC telling customer systems about business events). Full model, persistence, retry/DLQ, and replay semantics: `API.md` §6, `DATABASE.md` §12, `EVENTS.md` §5a–§5c. Summary:

### 10a. Inbound (provider → ACC)

- Provider webhooks land on provider-specific, signature-verified endpoints under `/api/v1/webhooks/{provider}`.
- Every accepted webhook is persisted verbatim to `webhook_events` (raw payload + parsed envelope) before any processing — the raw record is the audit source of truth even if parsing logic changes later.
- Signature verification (HMAC or provider-specific scheme) happens before persistence; unverified payloads are rejected with 401 and logged, never processed.
- Replay protection: `(provider_id, provider_event_id)` uniqueness, plus a timestamp/nonce staleness check where the provider scheme supports it.
- Processing is asynchronous: the webhook handler's only synchronous job is verify + persist + emit an internal event; the orchestrator consumes that event to update message/attempt state. This keeps webhook endpoints fast and decouples provider latency from internal processing.

### 10b. Outbound (ACC → customer systems)

- Customer-configured `webhook_endpoints`, each subscribed to specific domain event types, receive signed deliveries dispatched by the `webhook-outbound-dispatcher` consumer (`EVENTS.md` §5).
- Every delivery attempt is tracked on a durable `webhook_deliveries` row (one per `(endpoint, event)` pair), with retry/backoff, a dead-letter state, and auto-disablement of endpoints after sustained consecutive failure — never a fire-and-forget HTTP call with no persisted record.
- Outbound replay re-delivers an existing `webhook_deliveries` row's payload; it never regenerates the underlying domain event and never re-triggers a message send (`EVENTS.md` §5c).

## 11. Campaign architecture

Campaigns reference a `templates` row, a recipient source (contact segment/list), a routing policy, and a throttle/schedule config. Execution creates `campaign_recipients` rows first (the intended send set, enabling accurate progress/audit even before sending starts), then enqueues one Communication API call per recipient through the same orchestrator path as transactional messages — campaigns are a *caller* of the core, not a parallel send path.

## 12. Journey/workflow architecture

Journeys are versioned graphs (`journeys` + `journey_versions`) of steps: send, wait, branch-on-event, branch-on-attribute, exit. A `journey_executions` row tracks one contact's position in one version of a journey. Journeys emit the same domain events as any other message source and are subject to the same eligibility/consent checks — a journey cannot bypass suppression or consent rules.

## 13. Unified inbox / conversation architecture

`conversations` groups inbound + outbound `messages` by `(tenant_id, contact_id, channel)` (configurable grouping key, e.g. cross-channel conversation is a Phase 8+ decision — see `DECISIONS.md`). Inbound messages arrive via the webhook path, are matched to an existing open conversation or start a new one, and are indexed into OpenSearch for full-text inbox search, separate from the Postgres system-of-record copy.

## 14. Customer data architecture

`contacts` is the canonical end-customer record per tenant; `contact_identities` holds channel-specific addresses (phone, email, WhatsApp ID) many-to-one against a contact, enabling cross-channel recognition of "the same person." `consents` and `suppressions` are first-class, queried by the Eligibility Engine on every send — never assumed. PII fields are flagged at the column level for masking in logs/exports (see `SECURITY.md`).

## 15. Billing architecture (summary — full detail in `BILLING.md`)

`usage_ledger` is append-only and is the only source of financial truth; wallet balances, invoices, and dashboards are materialized/derived from it, never the reverse. Every billable event (provider cost incurred, customer charge applied, reseller markup) is its own ledger row with a reference back to the originating `message_id`/`message_attempt`.

## 16. Reseller & white-label architecture

Resellers own a set of organizations, their own pricing/markup configuration, and branding (logo, domain, sender identities where channel policy allows). Reseller scoping is enforced the same way tenant scoping is (§17) — a reseller admin's context is derived from auth, and queries are automatically scoped to `reseller_id` and the organizations beneath it.

**Long-term target (roadmap-level, not a Phase 1 commitment)**: the full tenant/application hierarchy the reseller layer is designed to eventually expose is `Alendei → Reseller → Organization → Workspace → Team → User` (`TENANCY.md` §1), with a reseller ultimately able to offer, under its own brand: branded login and UI, its own pricing (via a `pricing_plan` assigned at reseller scope, `BILLING.md` §17), its own customers (organizations), its own templates, campaigns, and inbox (Engagement Layer instances scoped to the reseller's organizations, §21), its own domains, its own API credentials (`provider_credentials`/`api_keys` scoping already supports reseller-level ownership, `DATABASE.md` §§2–3), and its own usage/billing reporting (`resellers.default_markup_pct`, `BILLING.md` §6). None of this changes the isolation model: every existing tenant-isolation and RBAC/ABAC principle (§17, `TENANCY.md`, `RBAC.md`) remains mandatory and unmodified as the reseller/white-label surface grows — white-labeling is a branding/config/pricing layer on top of the same enforced isolation, never a relaxation of it.

## 17. Multi-tenant isolation (summary — full detail in `TENANCY.md`)

The canonical tenancy/authorization scope hierarchy is **`platform → reseller → organization → workspace → team`**, defined normatively in `TENANCY.md` §1a and resolved in `DECISIONS.md` B31. No other document defines a conflicting set of scope levels; `user_roles.scope_type` carries exactly these five values, and the same-named columns on `routing_policies` and `provider_credentials` are separate configuration enums that confer no access (`TENANCY.md` §1a.2).

Tenant context (`org_id`, `workspace_id`, `reseller_id`) is derived exclusively from the authenticated session/token/API-key context on the server side. A client-supplied tenant ID in a URL, body, or header is **never** trusted for authorization — it may be present for readability/routing but is always cross-checked against the resolved auth context, and a mismatch is rejected (403), not silently corrected.

Isolation is enforced at:

| Layer | Mechanism |
|---|---|
| API | Auth middleware resolves tenant context once, injects it into every downstream call; handlers cannot query without it |
| Database | Postgres Row-Level Security keyed on session-local `app.current_org_id`/`app.current_workspace_id`/`app.current_reseller_id`, set with `SET LOCAL` inside the request or job's own transaction (never at connection level — `TENANCY.md` §3a, `DATABASE.md` §14a). RLS enforces the boundary down to organization; workspace and team are enforced by the authorization layer above it |
| Cache | Redis keys namespaced `t:{org_id}:...`; no cross-tenant key ever constructed |
| Queues | Kafka message keys/headers carry `tenant_id`; consumers assert tenant scope before acting |
| Storage | S3-compatible object keys prefixed `{org_id}/{workspace_id}/...`; bucket policy enforces prefix conditions |
| Search | OpenSearch documents carry `tenant_id`; all queries include a mandatory tenant filter clause injected server-side |
| Analytics/logs | Every structured log line and analytics fact table row carries `tenant_id`; there is no physically separate log store per tenant by default (documented as an open scale decision in `DECISIONS.md`) |

## 18. AI Gateway architecture

The AI Gateway mirrors the Communication Gateway pattern: an `ai-gateway` module exposes a provider-agnostic interface (`complete()`, `embed()`, `moderate()`) backed by an `ai_providers`/`ai_models` registry and per-call `ai_usage` ledger rows, so AI cost is tracked with the same rigor as messaging cost and no business feature is hard-wired to one AI vendor.

## 19. Cloud portability

No component may assume a specific cloud provider's proprietary API as a hard dependency:

- Object storage: any S3-compatible endpoint (AWS S3, MinIO on-prem, Azure Blob via S3 gateway, GCS via interop layer).
- Event bus: any Kafka-wire-compatible broker (Apache Kafka, Redpanda, Azure Event Hubs w/ Kafka protocol).
- Search: OpenSearch or Elasticsearch behind a thin internal abstraction (`SearchIndexPort`).
- Secrets: an abstraction over Vault / cloud KMS+Secrets Manager / Azure Key Vault / GCP Secret Manager (see `SECURITY.md`).
- Compute: containers only; Kubernetes + Helm as the only assumed orchestration layer.

## 20. Explicit contradictions / risks surfaced during Phase 0 and Phase 0.1

See `DECISIONS.md` for the full, tracked, now-categorized list (Phase-1 blockers, all resolved as of Phase 0.1 — vs. non-blocking future decisions). Non-blocking items folded into this document's design but flagged for product-owner sign-off: conversation grouping across channels, per-tenant physical log/index isolation at scale, and the boundary between "modular monolith" and "extracted service" for `provider-adapters` under high throughput.

## 21. Product architecture — layers beyond the communications core

Phase 0.2 strategic update: ACC's long-term product scope extends beyond the communications control plane (§§1–19) to a broader communications + customer-engagement platform, comparable in application-layer coverage to tools such as AiSensy, WATI, and WhatChimp, while retaining the deeper control-plane capabilities those tools do not have (`PRD.md` §1). **This section is architectural/roadmap framing, not a Phase 1–7 implementation commitment** — it exists so that the Communication Core built in Phases 1–7 is shaped correctly to carry this weight later, per `ROADMAP.md` Phase 8A onward. No new database migrations, APIs, or application code are introduced by this section.

The long-term product architecture is four layers, each only ever calling the layer beneath it:

```
Layer 1 — Experience Applications   (Marketing, Sales/CRM, Support, Automation, AI, Commerce)
        ↓ (via ACC APIs only — §22)
Layer 2 — Engagement Layer          (Contacts/CDP, Templates, Campaign Engine, Journey/Automation Engine, Conversation Engine)
        ↓
Layer 3 — Communication Core        (Communication API → Orchestrator → Channel Router → Eligibility → Fallback → Provider Router — §§1–14, this is what Phases 1–7 build)
        ↓
Layer 4 — Channel / Provider Fabric  (Provider Adapters, external providers — §7, `PROVIDER_ADAPTER.md`)
```

### 21a. Layer 1 — Experience Applications (future product surface, roadmap `ROADMAP.md` Phases 8B–8G, 10)

Product applications built *on* the Engagement Layer, never talking to providers or the Communication Core directly:

- **Marketing**: broadcast campaigns, campaign scheduling, audience targeting, personalization, campaign analytics, retargeting.
- **Sales / CRM**: leads, contacts, pipeline, stages, tasks, notes, lead assignment, conversation-to-lead conversion.
- **Customer support**: unified inbox, teams, agents, assignment, routing, internal notes, SLA, canned responses, conversation history.
- **Automation**: visual journey builder, triggers, conditions, branches, delays, actions, event-based automation, drip campaigns.
- **AI**: AI chatbot, AI sales agent, AI support agent, agent assist, conversation summarization, intent detection, lead qualification, AI-powered automation.
- **Commerce**: product/catalog messaging, order notifications, abandoned cart, commerce workflows, ecommerce integrations.

### 21b. Layer 2 — Engagement Layer (`ROADMAP.md` Phase 8A–8D)

- **Contacts / CDP**: contacts, custom fields, tags, attributes, segments, consent, suppression, imports/exports, customer timeline, identity resolution, conversation history references. Relationship chain: `Contact → Identity/channel address → Conversations → Messages → Campaigns → Journeys → Events → Conversions` — a single contact, never a separate customer record per channel (§14 already establishes `contacts`/`contact_identities`; this chain is the roadmap-level extension of that model to campaigns/journeys/events/conversions).
- **Templates**: WhatsApp/SMS/RCS/email templates, reusable message components, template versioning, approval/status lifecycle where applicable (extends `templates`, `DATABASE.md` §8).
- **Campaign Engine**: audience selection, scheduling, personalization, rate limiting, throttling, campaign state, delivery tracking, conversion metrics (extends §11).
- **Journey / Automation Engine**: event triggers, scheduled triggers, conditions, branching, delays, retries, actions — including webhook/API actions, CRM actions, human handoff, and AI handoff (extends §12).
- **Conversation Engine**: conversation lifecycle, participants, messages, assignment, team routing, internal notes, tags, status, SLA, handoff, history (extends §13).

### 21c. Unified inbox — channel/provider agnostic by design

The unified inbox is intended to ultimately cover WhatsApp, SMS, RCS, Email, Voice, and AI Voice, wherever channel semantics permit a conversational model. The `conversations`/`messages` model (§13, `DATABASE.md` §6) is already channel-agnostic at its core — a caller of the inbox never needs to know which provider handled a given message to render conversation history; `current_provider_id`/`current_provider_message_id` remain provider metadata on the message, not something inbox-rendering logic branches on.

## 22. API strategy — application features never get a private integration path

ACC remains API-first at every layer (§21). Application-layer features consume the same underlying communication APIs/orchestration services every other caller uses — there is no such thing as a "campaign provider integration," a "chatbot provider integration," or a "CRM provider integration" as a distinct architectural concept:

```
Application (Layer 1)
        ↓
ACC APIs
        ↓
Engagement Services (Layer 2)
        ↓
Communication Orchestrator (Layer 3)
        ↓
Channel/Provider Fabric (Layer 4)
```

This is the same invariant §26 states normatively below — stated here specifically to rule out the anti-pattern of a future application module growing its own provider client "for efficiency" or "because the generic path doesn't fit," which would silently bypass routing, failover, billing, security, and observability.

## 23. Chatbot / flow builder (future capability, `ROADMAP.md` Phase 8E)

A visual chatbot/flow builder is a Layer 1 (Experience Applications) capability, conceptually supporting node types: start/end, message, buttons, lists, user input, condition, API call, webhook, variable assignment, delay, branch, human handoff, AI handoff, and campaign/journey action. **The flow engine must never bypass Eligibility → Routing → Provider Adapter** — every send a flow triggers is an ordinary call into the Communication API (§22), subject to the same eligibility, routing, fallback, and billing treatment as any other message source (comparable to how §11/§12 already require campaigns and journeys to be callers of the core, not a parallel send path).

## 24. Contacts/CDP, campaigns, and CRM — no parallel identity or send path

Extending §14: as the Engagement Layer (§21b) and future CRM/commerce applications (§21a) are built, they must resolve recipients through the existing `contacts`/`contact_identities` model, never introduce a second per-application notion of "customer." A CRM lead, a commerce customer, and a support-inbox contact are the same `contacts` row, distinguished by which application-layer records (leads, orders, conversations) reference it — not by separate identity tables per application.

## 25. Reseller/white-label as a cross-cutting layer, not a fifth product layer

Reseller/white-label scoping (§16) is not a fifth layer above Layer 1 — it is a tenancy dimension that cuts across all four layers identically: a reseller's branded application surface (Layer 1), its own Engagement Layer data (Layer 2, scoped by `org_id`/`reseller_id`), and its own pricing/billing (`BILLING.md` §17) all resolve through the same tenant-context and RLS mechanisms already defined in §17 and `TENANCY.md` — white-labeling changes what a UI looks like and what a pricing plan charges, never how isolation or routing work underneath.

## 26. Architecture boundary — the core invariant, stated normatively once

**Business/application features MUST NOT directly call providers.** This restates and generalizes §1's principle for every future Layer 1/Layer 2 capability:

```
Campaign          ─┐
Journey            │
Chatbot            ├──▶ Communication API ──▶ Communication Orchestrator ──▶ Channel Router
CRM automation     │                                                              │
AI Agent          ─┘                                                              ▼
                                                                          Eligibility Engine
                                                                                    │
                                                                                    ▼
                                                                            Fallback Engine
                                                                                    │
                                                                                    ▼
                                                                            Provider Router
                                                                                    │
                                                                                    ▼
                                                                           Provider Adapter
```

Every one of the callers on the left is, architecturally, in the same position campaigns and journeys already occupy in §2's request flow — this section adds no new mechanism, it names the invariant explicitly so that a future feature's design review has a single, unambiguous rule to check against: if a proposed feature's design diagram shows an arrow from anything other than "Communication API" pointing at "Provider Adapter" or an external provider, the design is non-compliant regardless of how it is justified.
