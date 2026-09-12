# Database Architecture

PostgreSQL is the system of record for all transactional and financial data. Redis is cache/locks/rate-limiting/scheduling-acceleration only (never system of record — see `FALLBACK_ENGINE.md` §4 for why fallback correctness is never allowed to depend on Redis alone). OpenSearch is a derived search index (never system of record). S3-compatible storage holds media/exports/backups (referenced by pointer, never inline).

## 1. Conventions

- Primary keys: `UUID` (UUIDv7 — time-sortable, generated application-side or via `pg_uuidv7`), column name `id`.
- Every tenant-scoped table carries `org_id UUID NOT NULL REFERENCES organizations(id)`, and where relevant `workspace_id UUID REFERENCES workspaces(id)`.
- Every table carries `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`; mutable tables use a trigger to bump `updated_at`.
- Financial/audit/event tables are **append-only**: no `UPDATE`/`DELETE` grants at the DB role level for the application user; corrections are new rows.
- Row-Level Security is enabled on every tenant-scoped table; policy pattern: `USING (org_id = current_setting('app.current_org_id')::uuid)`, applied per `TENANCY.md`. Session variables are set with `SET LOCAL` inside the request/job's transaction only (never `SET` at connection level) — see §14 for why this matters for pooled connections.
- Soft delete (`deleted_at TIMESTAMPTZ`) is used for tenant-manageable entities (contacts, templates, campaigns); hard delete is never used on tables with financial or audit references.
- Optimistic concurrency: any row that can be concurrently transitioned by more than one worker carries a monotonically incrementing `state_version INT NOT NULL DEFAULT 0`, bumped on every state-changing update, and used as a compare-and-swap guard (§8, §"Migration ownership").

## 2. Domain: Tenancy & IAM

**`organizations`** — the paying tenant ("Customer"). `id, reseller_id NULL FK resellers, name, legal_name, gstin NULL, billing_mode ENUM(prepaid,postpaid), billing_policy ENUM(charge_per_logical_message,charge_per_attempt) DEFAULT charge_per_logical_message, status ENUM(active,suspended,closed), created_at, updated_at`. `billing_policy` is the formal home of the fallback-charging decision — see `BILLING.md` §5.

**`resellers`** — `id, name, brand_config JSONB, domain, default_markup_pct, status`. The "Alendei Direct" row is seeded and used for organizations with no external reseller.

**`workspaces`** — `id, org_id FK, name, brand_config JSONB, status`. `workspace_id` remains optional on tenant-scoped tables (see `DECISIONS.md`, resolved non-blocking); every organization is seeded with one default workspace at creation so application code can always resolve a workspace without a null-check special case if desired.

**`teams`** — `id, workspace_id FK, name`.

**`users`** — `id, email, phone NULL, password_hash NULL (nullable — SSO-only users have none), mfa_enabled, status ENUM(active,invited,disabled), created_at`. Users are platform-level identities; tenant access is via `user_roles`.

**`roles`** — `id, org_id NULL (NULL = platform-level role), name, is_system_role BOOL`.

**`permissions`** — `id, key TEXT UNIQUE` (e.g. `campaigns.create`), `description`.

**`role_permissions`** — `role_id FK, permission_id FK`, PK `(role_id, permission_id)`.

**`user_roles`** — `id, user_id FK, role_id FK, scope_type ENUM(organization,workspace,team), scope_id UUID, granted_by FK users, created_at`.

Scope integrity (`RBAC.md` §6): `scope_id` is polymorphic and cannot carry a single physical `FOREIGN KEY` across three possible target tables. Integrity is enforced by **both** of the following, not either alone:
- A `BEFORE INSERT/UPDATE` trigger (`fn_validate_user_role_scope`) that looks up the target row for the given `scope_type` (`organizations`, `workspaces`, or `teams`) and verifies its `org_id` (directly, or transitively via `workspaces.org_id`/`teams.workspace_id → workspaces.org_id`) equals `roles.org_id` for the role being granted (or that the role is a platform-level role, i.e. `roles.org_id IS NULL`, in which case `scope_type` must be a value the platform role's design permits). A trigger failure raises and the transaction aborts — this is a hard DB-level guarantee, not advisory.
- An application-level check at assignment time (`RBAC.md` §6) that re-derives the same chain from the actor's own resolved tenant context before even attempting the write, so invalid combinations are rejected with a clear `403`/`422` before ever reaching the trigger — the trigger is defense-in-depth, not the only line of defense.

**`api_keys`** — `id, org_id FK, name, key_prefix, key_hash, scopes JSONB (permission subset), last_used_at, revoked_at NULL, created_by FK users`.

**`sessions`** — `id, user_id FK, refresh_token_hash, device_info JSONB, ip, revoked_at NULL, expires_at, created_at`.

**`ws_tickets`** — single-use WebSocket connection tickets (`API.md` §9): `id, user_id FK, org_id FK, workspace_id NULL, scope JSONB (topics permitted), issued_at, expires_at (short, ~30s), consumed_at NULL`. A ticket is minted by an authenticated `POST /api/v1/ws/ticket` call and consumed exactly once at WebSocket connect time; the tenant context bound to the resulting connection comes from the ticket record, never from a client-supplied value on the socket.

## 3. Domain: Channels & Providers

**`channels`** — `id, code ENUM(whatsapp,rcs,sms,email,voice), display_name, status`.

**`providers`** — `id, channel_id FK, name, adapter_key (maps to a registered adapter implementation), status ENUM(active,disabled,draining), health_state ENUM(healthy,degraded,critical,offline,draining), circuit_state ENUM(closed,open,half_open), created_at`.

**`provider_credentials`** — ownership/precedence made explicit (`PROVIDER_ADAPTER.md` §8): `id, provider_id FK, scope_type ENUM(platform,reseller,organization) NOT NULL, scope_id UUID NULL (NULL only when scope_type=platform), credential_ref (pointer into secrets manager/KMS — never the raw secret), is_active BOOL, rotated_at, revoked_at NULL, created_by FK users`. Resolution order for a given `(provider_id, org_id)` pair is always **most specific active credential wins**: `organization` (scope_id = org_id) → `reseller` (scope_id = the org's reseller_id) → `platform` (scope_type=platform). Exactly one active credential may exist per `(provider_id, scope_type, scope_id)` — enforced by a partial unique index on `is_active = true`. The resolved credential is never returned to any frontend client; only `credential_ref` metadata (label, `rotated_at`, `scope_type`) is ever exposed via API.

**`provider_capabilities`** — `id, provider_id FK, channel_id FK, capability_key (e.g. media_support, template_support, max_message_size), value JSONB`.

**`provider_health`** — append-only time series: `id, provider_id FK, observed_at, error_rate, avg_latency_ms, sample_size, health_state, source ENUM(automatic,manual)`.

## 4. Domain: Routing & Fallback

**`routing_policies`** — precedence made explicit (`ROUTING_ENGINE.md` §4): `id, scope_type ENUM(platform,reseller,organization,workspace,channel,campaign,journey,message) NOT NULL, scope_id UUID NULL (NULL only when scope_type=platform), name, strategy ENUM(priority,weighted,cost,quality,latency,geo,customer,campaign,channel,hybrid), status ENUM(active,inactive)`. At most one `active` policy may exist per `(scope_type, scope_id)` at a time (partial unique index).

**`routing_policy_versions`** — `id, routing_policy_id FK, version_number, config JSONB (weights/priorities/thresholds), effective_at TIMESTAMPTZ NOT NULL, created_by FK users, created_at, activated_at NULL, deactivated_at NULL`. Exactly one version per policy has `activated_at IS NOT NULL AND deactivated_at IS NULL` at any time — this is the version the Provider Router reads. `effective_at` supports scheduling an activation for a future time; the activation job itself still flips `activated_at` transactionally so "currently effective" is always a simple, single predicate, never a runtime comparison against `effective_at` scattered across call sites.

**`fallback_policies`** — `id, org_id NULL, name, status`.

**`fallback_steps`** — `id, fallback_policy_id FK, step_order, channel_id FK, provider_id NULL (NULL = "any eligible provider on this channel, re-resolved at runtime"), wait_window_seconds, escalation_condition ENUM(no_delivery,explicit_failure,either)`. This table is **configuration of intent** (the preferred chain shape), not a precomputed runtime plan — see `FALLBACK_ENGINE.md` §2 for why every step is re-evaluated against live eligibility/routing state when it is actually reached, not blindly executed.

## 5. Domain: Contacts & Consent

**`contacts`** — `id, org_id FK, workspace_id FK, display_name, attributes JSONB, deleted_at NULL`.

**`contact_identities`** — `id, contact_id FK, channel_id FK, address (phone/email/etc.), verified_at NULL, is_primary BOOL`.

**`consents`** — `id, contact_id FK, channel_id FK, consent_type ENUM(marketing,transactional,otp), granted_at NULL, revoked_at NULL, source (how consent was captured)`.

**`suppressions`** — `id, org_id FK, contact_id NULL, address NULL (supports suppression by raw address before a contact record exists), channel_id NULL (NULL = all channels), reason ENUM(opt_out,bounce,complaint,dlt_block,manual), created_at`.

## 6. Domain: Messaging Core

**`conversations`** — `id, org_id FK, workspace_id FK, contact_id FK, channel_id FK, status ENUM(open,closed), last_message_at`.

**`messages`** — the canonical **logical message**. Ownership boundary (`ARCHITECTURE.md` §5, §6a): `messages` is authoritative for the caller's *intent* and the *current customer-facing state*; it is never authoritative for the history of individual provider/channel tries — that is `message_attempts`' job exclusively, and `messages` never duplicates attempt history, only a pointer to the current one.

```
id                        UUIDv7, PK
org_id                    FK organizations, NOT NULL
customer_id               FK contacts(id) — the recipient; see naming note, ARCHITECTURE.md §5
conversation_id           FK conversations, NULL
campaign_id               FK campaigns, NULL
journey_id                FK journeys, NULL
requested_channel_id      FK channels, NULL   -- caller-pinned channel (e.g. OTP must be SMS); NULL = "let the Channel Router decide". Non-null is a HARD CHANNEL CONSTRAINT by default — see cross_channel_fallback_enabled and ROUTING_ENGINE.md §1a
cross_channel_fallback_enabled  BOOLEAN NOT NULL DEFAULT false  -- only meaningful when requested_channel_id IS NOT NULL: false (default) = requested_channel_id is a hard constraint, no channel substitution ever; true = cross-channel fallback per fallback_steps is explicitly permitted despite the pin. Ignored when requested_channel_id IS NULL. ROUTING_ENGINE.md §1a
message_type              e.g. template | session | notification | otp | media
content                   rendered body (post-template-substitution)
template_id               FK templates, NULL
media                     JSONB (pointers into S3-compatible storage)
metadata                  JSONB (caller-supplied context)
priority                  ENUM(low,normal,high,critical)
routing_policy_id         FK routing_policies, NULL — the *resolved effective policy* recorded at send time (ROUTING_ENGINE.md §4)
current_attempt_id        FK message_attempts, NULL until the first attempt is created
current_channel_id        FK channels, NULL   -- DENORMALIZED from current_attempt_id.channel_id; see note below
current_provider_id       FK providers, NULL  -- DENORMALIZED from current_attempt_id.provider_id
current_provider_message_id  NULL             -- DENORMALIZED from current_attempt_id.provider_message_id
current_attempt_number    INT NOT NULL DEFAULT 0  -- DENORMALIZED from current_attempt_id.attempt_number, 0 = no attempt yet
status                    ENUM (ARCHITECTURE.md §6 lifecycle) — the authoritative customer-facing status
state_version             INT NOT NULL DEFAULT 0  -- optimistic-concurrency token, see FALLBACK_ENGINE.md §4
created_at, queued_at, sent_at, delivered_at, read_at, failed_at, updated_at
failure_code NULL, failure_reason NULL
cost NUMERIC(12,4) NULL           -- total provider cost across all attempts for this logical message (sum, kept in sync by the ledger writer, itself derivable from usage_ledger — see BILLING.md §1)
customer_charge NUMERIC(12,4) NULL
idempotency_key           -- see §7 "API-level idempotency" below; NOT the same concept as attempt identity
correlation_id
```

Unique constraint: `(org_id, idempotency_key)` where `idempotency_key IS NOT NULL`.

**The four `current_*` columns are denormalized read-optimizations, not a second source of truth.** They exist purely so a caller can read a message's current disposition without a join, and they are written **only** in the same transaction that updates `current_attempt_id` (i.e., only the code path described in `FALLBACK_ENGINE.md` §4 ever writes them — no other code path is permitted to set them independently). This is the resolution to the earlier ambiguity between `messages.provider_id`/`channel_id`/`provider_message_id` and the corresponding `message_attempts` columns: **`message_attempts` is always the authority; `messages.current_*` is always a same-transaction copy of the row `current_attempt_id` points to.**

**`message_attempts`** — the authoritative record of every physical provider/channel try:

```
id                UUIDv7, PK
message_id        FK messages, NOT NULL
attempt_number    INT NOT NULL             -- 1, 2, 3, ... GLOBALLY MONOTONIC across the entire fallback chain for this message (see FALLBACK_ENGINE.md §3 — this is the only attempt counter; messages.fallback_attempt_number is REMOVED, replaced by messages.current_attempt_number which mirrors this field on the current attempt)
channel_id        FK channels, NOT NULL
provider_id       FK providers, NOT NULL
provider_message_id   NULL                 -- set once the provider acknowledges acceptance
provider_idempotency_key   -- the key (if any) passed to the provider's own idempotency mechanism; see PROVIDER_ADAPTER.md §2a. Derived deterministically from this row's id, never randomly regenerated on retry.
status            ENUM(pending,sent,provider_accepted,provider_rejected,delivered,read,delivery_failed,timed_out)
retry_count       INT NOT NULL DEFAULT 0   -- transient network/timeout retries of THIS SAME attempt (e.g. adapter-level retry before any provider response was ever received) — these do NOT create a new attempt_number; see FALLBACK_ENGINE.md §3
deadline_at       TIMESTAMPTZ NULL         -- when this attempt's delivery-confirmation window expires; the DB-backed fallback timer polls on this column, see FALLBACK_ENGINE.md §4 / EVENTS.md §6
routing_policy_id         FK routing_policies, NULL          -- SNAPSHOT: the routing policy resolved for THIS attempt specifically (may differ from messages.routing_policy_id, since fallback re-resolves routing — ARCHITECTURE.md §3b). A reference, never a copy of the policy config.
routing_policy_version_id FK routing_policy_versions, NULL   -- SNAPSHOT: the specific activated version used to select this attempt's provider. Answers "why did this attempt use this provider/channel?" without re-deriving it from current (possibly since-changed) config. ROUTING_ENGINE.md §4, §13 below.
pricing_evaluation_id     FK pricing_evaluations, NULL       -- CONCEPTUAL (Phase 7 design detail, BILLING.md §§15–16, DATABASE.md §10b): the pricing evaluation that rated this attempt, where attempt-level pricing applies. A single evaluation may itself be composed of multiple pricing_evaluation_components (e.g. a Voice AI attempt's telephony + STT + LLM + TTS + platform-fee components) — this is why the attempt carries one reference to an evaluation rather than a single pricing_rule_id, which cannot by itself explain a multi-component transaction.
sent_at, delivered_at, failed_at
failure_code NULL, latency_ms NULL
created_at, updated_at
```

Unique constraint: `(message_id, attempt_number)`. Historical `message_attempts` rows are immutable except for the explicitly defined status/event transitions listed above (`status`, `provider_message_id`, timestamps, `failure_code`, `retry_count`, `deadline_at`) — no attempt row is ever deleted or have its `channel_id`/`provider_id`/`attempt_number` changed after creation. The three snapshot reference columns (`routing_policy_id`/`routing_policy_version_id`/`pricing_evaluation_id`) are written once, at attempt creation, and never updated afterward — they are foreign-key references to versioned config/evaluation rows, never copies of their contents, so no attempt duplicates an entire policy, pricing plan, or the individual pricing components a multi-component evaluation contains (§10b).

**`message_events`** — append-only raw lifecycle/event trail, now explicitly split by the entity it describes (`EVENTS.md` §4): `id, message_id FK, message_attempt_id FK NULL (NULL = a message-level/logical event; NOT NULL = an attempt-level event), event_type, payload JSONB, occurred_at (provider-reported time where available), recorded_at (our ingestion time), source ENUM(api,webhook,internal)`.

**`idempotency_keys`** — backs API-level idempotency (`API.md` §4, `ARCHITECTURE.md` §9a): `id, org_id FK, endpoint TEXT, idempotency_key TEXT, request_hash (hash of the normalized request payload), status ENUM(pending,completed,failed), response_snapshot JSONB NULL, resource_id NULL (e.g. the created message_id), created_at, completed_at NULL, expires_at (default now() + 24h, org-configurable)`. Unique constraint `(org_id, endpoint, idempotency_key)`. This table is deliberately **separate from `messages.idempotency_key`** — the former is a generic API-replay cache usable by any idempotent endpoint (`POST /messages`, `POST /campaigns/{id}/launch`, `POST /wallets/recharge`); the latter is specifically the uniqueness guard on the `messages` table itself for the message-creation endpoint. See §7 below for exactly how the two relate.

## 7. Idempotency — three distinct mechanisms (do not conflate)

This section is the canonical definition; `API.md` §4, `ARCHITECTURE.md` §9, `PROVIDER_ADAPTER.md` §2a, and `FALLBACK_ENGINE.md` §3 all refer back to it.

### 7.1 API / logical-message idempotency

**Protects**: the ACC API from a duplicate *customer/caller request* (e.g. a client's HTTP retry after a network timeout) resulting in two logical messages.

**Scope**: `(org_id, endpoint, idempotency_key)` — the same idempotency key is only meaningful within one organization and one endpoint; it is never globally unique and never workspace-scoped alone (an org-wide key means a caller can't accidentally collide across their own workspaces, which is the safer default — see `DECISIONS.md`).

**Mechanism**: on `POST /messages` (and other idempotency-key-accepting endpoints), the handler:
1. Computes `request_hash` from the normalized body.
2. Attempts to `INSERT` a row into `idempotency_keys` with `status='pending'`. If the insert succeeds, proceeds to create the `messages` row in the same transaction, then updates the `idempotency_keys` row to `status='completed'` with `response_snapshot` and `resource_id` set.
3. If the insert conflicts (`(org_id, endpoint, idempotency_key)` already exists):
   - If the existing row's `request_hash` **matches** and `status='completed'`: return the stored `response_snapshot` verbatim (same HTTP status, same body) — this is a true replay, not a new send.
   - If the existing row's `request_hash` **matches** and `status='pending'`: the original request is still being processed by another worker/request — return `409 Conflict` with `Retry-After` and error code `IDEMPOTENCY_REQUEST_IN_PROGRESS`; the caller is expected to retry after the hinted delay rather than the server guessing at a result.
   - If the existing row's `request_hash` **does not match**: return `422 Unprocessable Entity` with error code `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` — the same key must always mean the same request; reusing a key for a different payload is a caller error, not silently accepted as a new send or as a replay of the old one.
4. **Retention**: `idempotency_keys.expires_at` defaults to 24 hours from creation, organization-configurable within a platform-enforced minimum (1 hour) and maximum (7 days). Expired rows are purged by a scheduled job; a key reused after expiry is treated as brand new (no collision, no replay).
5. **`failed` status semantics** (`idempotency_keys.status = failed`): two structurally different situations both end with request processing not completing, and they must be handled differently, deterministically — never by falling back to "just try creating the message again and see":
   - **Definite failure before logical-message creation** — validation error, authorization failure, or any error raised before (or as part of, and rolled back with) the `messages` INSERT within the same transaction, such that no `messages` row was ever committed. The `idempotency_keys` row transitions to `status='failed'`. Because no logical message exists, a subsequent request presenting the same key is safe to treat as a fresh attempt — retry is permitted, and does not risk creating a second logical message for something that was never created once.
   - **Ambiguous outcome** — the handler process crashed, the connection was lost, or the transaction's outcome could not be confirmed *after* the point where the `messages` row may already have committed but *before* the `idempotency_keys` row itself was updated to `completed`. In this case ACC cannot determine from the `idempotency_keys` row alone whether logical-message creation succeeded. **ACC does not blindly create another logical message in this case.** The deterministic resolution: a retry presenting the same key first checks whether a `messages` row already exists for `(org_id, idempotency_key)` (the narrower guard on `messages` itself, described above) — if one exists, its state is reconstructed into a replay response (never a second send); only if no such row exists, and the original `idempotency_keys` row's own processing-timeout window has elapsed, is the key safe to treat as fresh. The `messages` table's own uniqueness constraint — not an inference from `idempotency_keys.status` — is what makes this deterministic rather than probabilistic.

The `messages.idempotency_key` column and its `(org_id, idempotency_key)` unique constraint remain as a **second, narrower belt-and-suspenders guard** specifically against a `messages` row ever being duplicated even if the `idempotency_keys` cache layer were somehow bypassed (e.g. an internal system caller that doesn't go through the public API handler) — it is not a duplicate concept, it is defense-in-depth at the table level under the API-level cache.

### 7.2 Internal attempt idempotency

**Protects**: against a provider/channel attempt being duplicated by a retried worker, a duplicate Kafka event, or a scheduler firing twice.

**Scope**: `(message_id, attempt_number)`, enforced by the unique constraint on `message_attempts` (§6).

**Mechanism**: a new attempt is only ever created via the single conditional-transition code path described in `FALLBACK_ENGINE.md` §4, which uses `messages.state_version` as a compare-and-swap guard — two workers racing to create "the next attempt" for the same message can both attempt the `INSERT`, but only one wins the preceding conditional `UPDATE` on `messages`, and the loser's insert is aborted before it happens (the transaction never reaches the `message_attempts` insert). This is stronger than relying on the unique constraint alone as a race-detector-after-the-fact — the constraint is the last-resort guarantee, not the primary mechanism.

A **retry** of the same attempt (e.g. the adapter times out waiting for the provider's HTTP response, or a `429` is retried after backoff) does **not** create a new `attempt_number` — it increments `message_attempts.retry_count` and appends a `message_events` row, because from the fallback chain's perspective this is still "trying channel/provider N," not "escalating to N+1." Only the Fallback Engine's escalation decision (`FALLBACK_ENGINE.md` §2–§4) creates a new `attempt_number`.

### 7.3 Provider-side idempotency (a limitation, not a guarantee)

ACC cannot guarantee exactly-once execution on the provider's own systems. The specific failure mode this section exists to name honestly: ACC calls `send()`, the provider receives and processes the request, but the response is lost to a network timeout before ACC observes it — ACC does not know whether the provider accepted the message, and a naive retry could cause the provider to process it twice.

Mitigations, in order of preference:
1. **Where the provider's own API supports an idempotency key**, the adapter passes `message_attempts.provider_idempotency_key` (deterministically derived from the attempt's `id`, never regenerated across retries of that same attempt) as that key — the provider itself then de-duplicates on its side.
2. **Where the provider does not support one**, the adapter first calls `checkStatus()` (if the provider exposes a lookup-by-some-correlatable-reference) before blindly re-sending, to reduce — not eliminate — the duplicate-submission window.
3. Where neither is available, ACC accepts and documents the residual risk explicitly rather than pretending it doesn't exist: a timeout-then-retry sequence against a provider with neither an idempotency key nor a status-lookup API carries a real, non-zero chance of a duplicate provider-side submission. This risk is disclosed to organizations in `PRD.md` §8a and is the reason `FALLBACK_ENGINE.md` bounds retry counts and prefers escalating to a *different* provider over repeatedly retrying a non-idempotent one after an ambiguous timeout.

**The precise, load-bearing distinction, stated once here and referenced everywhere else**: ACC guarantees **exactly-once business outcome** — one authoritative logical message, one financially-authoritative billing outcome per billable transaction or logical communication lifecycle (`BILLING.md` §10 — not necessarily one charge; the number of `customer_charge` entries is a billing-policy/pricing-policy question, `BILLING.md` §17), one correct audit trail, idempotent internal processing — built entirely from mechanisms ACC itself controls (§§7.1–7.2). ACC does **not** guarantee **exactly-once external delivery**, because that would require a guarantee about systems ACC does not control and cannot make binding on their behalf.

## 8. Domain: Templates & Campaigns

**`templates`** — `id, org_id FK, name, channel_id FK, body, variables JSONB, provider_template_map JSONB (per-provider template id mapping), approval_status ENUM(draft,pending,approved,rejected), deleted_at NULL`.

**`campaigns`** — `id, org_id FK, workspace_id FK, name, template_id FK, routing_policy_id FK NULL, schedule JSONB, throttle_config JSONB, status ENUM(draft,scheduled,running,paused,completed,cancelled), created_by FK users`.

**`campaign_recipients`** — `id, campaign_id FK, contact_id FK, status ENUM(pending,sent,skipped,failed), message_id FK NULL, skip_reason NULL`.

## 9. Domain: Journeys

**`journeys`** — `id, org_id FK, workspace_id FK, name, status ENUM(draft,active,paused,archived)`.

**`journey_versions`** — `id, journey_id FK, version_number, graph JSONB (steps/branches/waits), activated_at NULL`.

**`journey_executions`** — `id, journey_version_id FK, contact_id FK, current_step_key, status ENUM(running,waiting,completed,exited,failed), started_at, updated_at`.

## 10. Domain: Billing (see `BILLING.md` for the full financial model)

**`wallets`** — `id, org_id FK, balance NUMERIC(14,4) (materialized, recomputed from ledger), reserved NUMERIC(14,4) (materialized, sum of open reservations — see §10a), currency, auto_recharge_config JSONB NULL`. **Available balance = `balance - reserved`**, and it is *available balance* the Eligibility Engine checks before authorizing a prepaid send, never `balance` alone (`BILLING.md` §8).

**Reservation accounting — precise definition (Phase 0.2 clarification, consistent across `BILLING.md` §8, `API.md`, `PRD.md`)**: a reservation (`usage_ledger.entry_type='reservation'`) increases `wallets.reserved` only. It does **not** additionally decrease `wallets.balance` — `balance` is not touched by a reservation at all. `wallets.balance` changes only from ledger entries that represent an actual, realized financial fact: `recharge` (increases balance), `customer_charge` (decreases balance), `refund` (increases balance), `adjustment` (either direction, per its justification). `reservation_release` (`BILLING.md` §8) decreases `reserved` by the released amount once the real `customer_charge` is known — it never touches `balance` either. Both `reservation` and `reservation_release` remain permanent, independently auditable rows in the immutable ledger like every other entry type (§10 above) — a reservation is bookkeeping about *what might be charged*, not a financial event in itself; only `customer_charge`/`refund`/`adjustment`/`recharge` are.

**`credit_accounts`** — `id, org_id FK, credit_limit NUMERIC(14,4), used NUMERIC(14,4) (materialized), reserved NUMERIC(14,4) (materialized)`. Same reservation discipline applies to postpaid orgs against their credit limit: `reserved` tracks open reservations, `used` tracks realized charges, and a reservation increases `reserved` only, never `used` directly.

**`usage_ledger`** — append-only, immutable: `id, org_id FK, reseller_id NULL, message_id NULL FK, message_attempt_id NULL FK, ai_usage_id NULL FK, pricing_evaluation_id NULL FK pricing_evaluations (CONCEPTUAL, Phase 7 design detail, §10b), entry_type ENUM(provider_cost,customer_charge,reseller_markup,tax,discount,adjustment,refund,recharge,reservation,reservation_release), amount NUMERIC(14,4), currency, rate_card_ref NULL (historical/descriptive pricing-context label — e.g. a human-readable rate-card name/version snapshot kept for quick display and backward reference — NOT the authoritative pricing relationship, see below), occurred_at, reference_note NULL, created_at`. Never updated or deleted at the application layer. `reservation`/`reservation_release` entry types back the concurrency-safe authorization flow in §10a — a reservation is itself a ledger entry (not a separate mutable table), preserving the single-source-of-truth principle even for in-flight, not-yet-finalized spend.

**`pricing_evaluation_id` is the authoritative relational reference from a ledger entry to the pricing calculation that produced its `amount`** (§10b below) — a concrete foreign key, not an ambiguous polymorphic reference, precisely because a financial audit must be able to answer "exactly which pricing calculation produced this ledger amount?" without guessing at what a free-form field points to. It is `NULL` for entries a pricing evaluation never produced (e.g. a manual `adjustment`, a `recharge`, or a `refund` issued without re-rating). `rate_card_ref` is retained alongside it purely as historical/descriptive metadata (a display label or a legacy/external rate-card identifier) — it is never the field an audit or reconciliation process should join on; that is always `pricing_evaluation_id` → `pricing_evaluations.id` → `pricing_evaluation_components` (§10b). Every historical ledger entry retains this reference permanently (the row is append-only and never updated), so the pricing context used to produce any past amount remains reconstructable indefinitely, consistent with the immutable-ledger principle (§1 above, `BILLING.md` §1).

**`invoices`** — `id, org_id FK, period_start, period_end, subtotal, gst_amount, total, status ENUM(draft,issued,paid,overdue,void), issued_at NULL`. Generated from `usage_ledger` aggregation, not itself authoritative.

**`payments`** — `id, invoice_id FK NULL, org_id FK, amount, method, status, processed_at`.

**`adjustments`** — `id, org_id FK, usage_ledger_id FK, reason, approved_by FK users`. Adjustments always create a new `usage_ledger` row; this table records the business justification linking to it.

### 10a. Concurrency-safe reservation (see `BILLING.md` §8 for the full flow)

A send is authorized via: `SELECT ... FOR UPDATE` on the org's `wallets`/`credit_accounts` row (a genuine row lock, not merely an application-level check) → verify `available balance ≥ estimated charge` → insert a `usage_ledger` row `entry_type='reservation'`, `amount=estimated charge`, in the **same transaction** → commit, which releases the row lock and leaves `wallets.reserved` (a materialized sum of open reservations) increased by that amount, while `wallets.balance` itself is left untouched — this reservation entry increases `reserved` only; it is never "negative against `balance`"; it reduces *available balance* only in the derived sense that `available_balance = balance - reserved` (§10 above). This makes "read balance, then decide, then act" atomic against concurrent sends for the same org, closing the classic check-then-act overspend race without requiring an external lock service to be the source of correctness (Redis may still front this with a fast-path check, per `FALLBACK_ENGINE.md` §4's pattern, but the `FOR UPDATE` transaction is what actually prevents overspend).

### 10b. Pricing & Rating (conceptual — full schema finalized at Phase 7 design stage; `BILLING.md` §§10–17)

The Pricing & Rating Engine is conceptually independent of `usage_ledger`: it determines what a transaction is *worth*; the ledger records what was actually, financially charged. This independence must hold structurally — the engine is never hard-wired to compute one universal price per message. Conceptual entities (deliberately not exhaustively specified in this Phase 0.2 pass — Part 28's "do not over-specify future features" applies; these are named now only so `usage_ledger.pricing_evaluation_id` and `message_attempts.pricing_evaluation_id` above have a coherent target to reference):

- **`pricing_plans`** — a named commercial offering (an org's, reseller's, or the platform's rate card), scoped like `routing_policies`/`fallback_policies` (`scope_type`/`scope_id` — platform, reseller, organization, workspace, channel, contract).
- **`pricing_plan_versions`** — versioned, immutable once activated, exactly one version effective at a time per plan (mirrors `routing_policy_versions`, §4) — every rated transaction records which version priced it; historical transactions are never recomputed against a newer version (`BILLING.md` §15).
- **`pricing_rules`** — individual rating rules within a plan version, keyed by whichever dimensions actually apply to that rule (organization, reseller, workspace, channel, transaction type, provider, destination/country, message type, template/category, quantity, duration, billable units, campaign/journey, volume tier, contract/negotiated price, explicit override) — not every rule uses every dimension, and rating basis (per-message, per-unit, per-minute/second, per-conversation, volume-tiered, fixed/negotiated, hybrid — `BILLING.md` §13) is itself a rule attribute, not a schema-wide assumption.
- **`provider_cost_rates`** — the provider's own cost basis per unit/transaction type, tracked independently of what is charged to the customer (`BILLING.md` §14) — `provider_cost` on a `usage_ledger`/`message_attempts` row is never assumed equal to `customer_charge`.
- **`customer_pricing_assignments`** — which `pricing_plan` applies to which organization/reseller/workspace, resolved most-specific-active-wins (mirrors provider-credential and routing-policy scope resolution, `PROVIDER_ADAPTER.md` §4a, `ROUTING_ENGINE.md` §4).
- **`pricing_evaluations`** — one row per rated billable transaction/attempt (`BILLING.md` §16): records which `pricing_plan`/`pricing_plan_version` applied, a `rating_timestamp`, `currency`, an overall `rating_basis`, the evaluation's `total_provider_cost`/`total_customer_price`, and an optional `calculation_context` (a free-form field for negotiated-pricing context or other calculation context not captured by the structured columns, e.g. a contract reference or a manually-approved override reason) — the single point a `message_attempts` row (or, for non-messaging billable transactions, whatever row represents that transaction) references (`pricing_evaluation_id`) to explain **how** it was rated, without needing to know how many components that rating involved. This row explains a calculation; it is never itself a financial fact — that remains the ledger's job (§10 above, `BILLING.md` §16).
- **`pricing_evaluation_components`** — one row per independent pricing component within an evaluation (`component_type`, a `pricing_rule` reference, `quantity`, `unit`, `unit_price`, `amount`, and, where applicable, a `provider_cost` component and a `customer_price` component), FK'd to `pricing_evaluations`. This is what lets a single evaluation explain a composite transaction (e.g. a Voice AI attempt's telephony + STT + LLM + TTS + platform-fee components, `BILLING.md` §16) as several independently-inspectable rows rather than one opaque total. For the ordinary single-component case (most channel sends), the evaluation's totals are simply that one component's amounts — the model does not force multi-component bookkeeping where none is needed.

**`usage_ledger.pricing_evaluation_id` (§10 above) is the single authoritative foreign key from a ledger entry to the pricing calculation that produced it — never a hard-coded computation, and never resolved via the descriptive `rate_card_ref` field.** Walking `usage_ledger.pricing_evaluation_id → pricing_evaluations.id → pricing_evaluation_components` is what lets a historical charge be fully explained (which plan, which version, which rule(s)/component(s), provider cost, base price, markup, discount, tax, final charge, rating basis, currency) without re-deriving it from current, possibly-since-changed config (`BILLING.md` §15). This chain is a concrete, walkable relational path — not a polymorphic or ambiguous reference — precisely because financial audit and reconciliation must be able to answer "exactly which pricing calculation produced this ledger amount?" deterministically.

## 11. Domain: AI Gateway

**`ai_providers`** — `id, name, adapter_key, status, health_state`.

**`ai_models`** — `id, ai_provider_id FK, name, capability ENUM(completion,embedding,moderation), cost_per_unit, unit ENUM(token,request)`.

**`ai_usage`** — append-only: `id, org_id FK, ai_model_id FK, request_type, units_used, cost, correlation_id, occurred_at`.

## 12. Domain: Webhooks (inbound & outbound) & Audit

**`webhook_events`** — inbound provider webhooks, append-only: `id, provider_id FK, provider_event_id, raw_payload JSONB, parsed_envelope JSONB, verified BOOL, received_at, processed_at NULL`. Unique constraint `(provider_id, provider_event_id)` for dedup/replay protection.

**`webhook_endpoints`** — outbound, customer-facing subscriptions (`API.md` §6, `EVENTS.md` §5a): `id, org_id FK, workspace_id NULL, url, subscribed_event_types JSONB (array of event_type patterns), status ENUM(active,disabled,auto_disabled), signing_secret_ref (pointer into secrets backend, never the raw secret), consecutive_failure_count INT DEFAULT 0, created_by FK users, created_at, updated_at`.

**`webhook_deliveries`** — one row per (endpoint, event) delivery attempt lineage: `id, endpoint_id FK, event_id (the domain event being delivered), attempt_count INT DEFAULT 0, status ENUM(pending,delivering,delivered,retrying,failed,dead_letter), last_http_status NULL, last_error NULL, next_retry_at NULL, delivered_at NULL, created_at, updated_at`. Unique constraint `(endpoint_id, event_id)` — redelivering the same event to the same endpoint updates this same row's attempt history rather than creating a duplicate delivery record, which is what makes outbound replay safe (`EVENTS.md` §5b).

**`audit_logs`** — append-only: `id, org_id NULL (NULL = platform-level action), actor_user_id NULL, actor_type ENUM(user,api_key,oauth_client,system), action, resource_type, resource_id, before JSONB NULL, after JSONB NULL, correlation_id, ip NULL, occurred_at`. `actor_type=system` covers background workers/schedulers acting without a human/API-key request in the loop (e.g. an automatic fallback escalation or an automatic provider health transition) — every such row still carries `correlation_id` tracing it back to the request/event chain that ultimately caused it.

## 12a. Future domain boundaries (conceptual only — no migrations in this pass)

Phase 0.2 strategic update (`ARCHITECTURE.md` §21, `ROADMAP.md` Phase 8A–8G): naming these domain boundaries now is scoped to establishing where future entities belong, not specifying their schemas. **None of the tables below are created by this documentation pass** — they are placeholders for Phase 8+ design stages, listed so the domain map is complete and so nothing already built (Communication, Billing, Platform below) has to be reshaped to make room for them later.

- **Communication** (already built, §§3–4, 6): `messages`, `message_attempts`, `providers`, `routing_policies`/`routing_policy_versions`, `fallback_policies`/`fallback_steps`.
- **Engagement** (`contacts`/`contact_identities`/`conversations`/`templates`/`campaigns`/`journeys` already exist, §§5, 8–9; conceptual future additions): `conversation_participants` (multi-agent/team assignment on a conversation, extending `conversations`), `journey_steps` (normalized step rows alongside `journey_versions.graph JSONB`, if a relational view of steps proves necessary), `automation_events` (the trigger-event log driving journey/automation execution).
- **CRM** (entirely conceptual, no Phase 1–7 dependency): `leads`, `pipelines`, `pipeline_stages`, `assignments` — a future Layer 1 application (`ARCHITECTURE.md` §21a) resolving recipients through the existing `contacts` model (`ARCHITECTURE.md` §24), never a parallel identity table.
- **Billing** (already built, §10; conceptual pricing additions, §10b): `pricing_plans`, `pricing_plan_versions`, `pricing_rules`, `provider_cost_rates`, `customer_pricing_assignments`, `pricing_evaluations`, `pricing_evaluation_components`, alongside the existing `usage_ledger`/`wallets`/`reservations` machinery.
- **Platform** (already built, §§1–2, 11): `organizations`, `resellers`, `workspaces`, `teams`, `users`, RBAC (`roles`/`permissions`/`role_permissions`/`user_roles`), `audit_logs`.

## 13. Indexing & partitioning notes

- `messages`, `message_attempts`, `message_events`, `usage_ledger`, `audit_logs`, `webhook_events`, `webhook_deliveries` are high-volume, append-heavy tables — planned for time-range partitioning (monthly) from the outset, partitioned on `created_at`/`occurred_at`, to keep indexes small and enable cheap retention/archival.
- `messages` additionally indexed on `(org_id, conversation_id, created_at)`, `(org_id, campaign_id)`, `(org_id, journey_id)`, `(org_id, idempotency_key)` unique, `(current_provider_id, current_provider_message_id)`.
- `message_attempts` additionally indexed on `(message_id, attempt_number)` unique, and a partial index `(status, deadline_at) WHERE status = 'provider_accepted'` — this is the index the DB-backed fallback timer poller scans (`FALLBACK_ENGINE.md` §4, `EVENTS.md` §6).
- `usage_ledger` indexed on `(org_id, occurred_at)`, `(message_id)`.
- Full ERD is intentionally not hand-drawn in Phase 0 prose form; it is derived directly from this schema via the ORM's schema-diagram tooling once Phase 1 introduces the actual migrations, avoiding a second source of truth that can drift.

## 14. Migration ownership & tooling

Schema migrations are owned by each module (per `ARCHITECTURE.md` §4) but run through one shared migration tool/pipeline. **Resolved (Phase 1 blocker, `DECISIONS.md`)**: Drizzle ORM is the chosen schema/migration tool — its SQL-first, non-magic query builder gives explicit control over the `SET LOCAL` session-variable pattern RLS depends on (§1, §14a) and over the partitioned-table DDL in §13, both of which are awkward under a heavier active-record-style ORM. Raw SQL migrations remain an escape hatch for anything Drizzle's schema DSL can't express directly (e.g. RLS policies, partition attachment, the scope-integrity trigger in §2).

### 14a. Tenant context in pooled connections (background workers)

RLS session variables are set via `SET LOCAL ...` **inside the transaction**, never `SET ...` at the connection level, specifically because connections are pooled and reused across requests/jobs. `SET LOCAL` is automatically reset at transaction end (commit or rollback) — this is what makes it safe for a pooled connection to be reused immediately afterward by a different tenant's request/job without any explicit "reset tenant context" step that could be forgotten. No code path may use session-level `SET` for `app.current_org_id`/`app.current_workspace_id`. See `TENANCY.md` §5 for the full background-worker tenant-context rule this pattern supports.
