# Testing Strategy

## 1. Layers

| Layer | Scope | Tooling direction |
|---|---|---|
| Unit | Pure logic: routing scoring, fallback state transitions, billing math, permission evaluation | Jest |
| Integration | Module-boundary contracts against real Postgres/Redis/Kafka in Docker Compose | Jest + Testcontainers-style ephemeral infra |
| Contract | API responses validated against the generated OpenAPI spec (`API.md` §8) | schema validation in CI |
| End-to-end | Full request flow through the simulator-backed provider layer | Playwright (console UI) + API-level e2e suite |
| Chaos | Fault injection at provider/queue/DB layers | see §4 |
| Load/performance | Throughput and latency under realistic and peak volumes | k6 or similar, against the simulator |
| Security | SAST/dependency scanning + targeted abuse-case tests | see §5 |

No layer above ever calls a real external provider. All provider-facing tests run against the Provider Simulator (§2).

## 2. Provider simulator

A first-class `SimulatorAdapter` (`PROVIDER_ADAPTER.md` §7) configurable per test to return, on demand:

| Behavior | Simulates |
|---|---|
| `SUCCESS` | Normal acceptance + eventual delivery webhook |
| `TIMEOUT` | No response within adapter timeout |
| `500` | Provider server error |
| `429` | Provider rate-limit rejection |
| `INVALID_CREDENTIALS` | Auth failure at the provider |
| `INVALID_REQUEST` | Malformed/rejected payload |
| `SLOW_RESPONSE` | High-latency success (tests latency-based routing/circuit behavior) |
| `DELIVERY_DELAY` | Accepted, delivery webhook arrives late (tests fallback timer edge behavior) |
| `DELIVERY_FAILURE` | Accepted, then explicit delivery-failure webhook |
| `DUPLICATE_WEBHOOK` | Same webhook delivered twice (tests dedup, `EVENTS.md` §3) |
| `OUT_OF_ORDER_WEBHOOK` | Delivery-state webhooks arrive out of chronological order (tests the monotonic-state guard, `ARCHITECTURE.md` §9) |

Simulator behavior is configured per test (and, in dev, per admin "test this provider" action, `PROVIDER_ADAPTER.md` §4) via request metadata or provider config — never via hard-coded branching in adapter code.

## 3. Critical scenario test (mandatory, automated, run in CI on every change touching routing/fallback)

```
WhatsApp Provider A → FAIL
WhatsApp Provider B → FAIL
RCS Provider A       → FAIL
RCS Provider B       → FAIL
SMS Provider A       → SUCCESS
```

Asserts, end-to-end against the simulator:

1. **No unintended duplicate logical message** — exactly one `messages` row exists for the whole chain; nothing about escalation creates a second logical message.
2. **Correct attempt numbering** — five `message_attempts` rows exist with `attempt_number = 1..5` (the single global counter, `FALLBACK_ENGINE.md` §3), each with the correct `channel_id`/`provider_id`.
3. **Eligibility re-evaluation occurred at every step** — the test asserts the Eligibility/Channel/Provider Router sequence was actually invoked fresh at each escalation (`ARCHITECTURE.md` §3b), not that a precomputed plan was replayed; a variant of this test injects a mid-chain health/consent change (e.g. WhatsApp Provider B goes `OFFLINE` between attempt 1 and attempt 2) and asserts the chain correctly substitutes rather than blindly following stale config.
4. **Correct provider routing** at every step, per the resolved effective routing policy (`ROUTING_ENGINE.md` §4), with each `message_attempts` row's `routing_policy_id`/`routing_policy_version_id` snapshot (`DATABASE.md` §6) correctly recording the policy/version actually used for that specific attempt.
5. **No duplicate delivery** — the four failed attempts remain `FAILED`/`PROVIDER_REJECTED`/`timed_out` on their own immutable `message_attempts` rows; only attempt 5 reaches `delivered`.
6. **Correct final message state** — `messages.status = DELIVERED`, `messages.current_provider_id` = SMS Provider A, `messages.current_attempt_number = 5`.
7. **Billing — phase-scoped assertion.** At **Phase 5** (`ROADMAP.md` §8), before the immutable ledger and Pricing & Rating Engine exist, this assertion is an **integration-contract check only**: the orchestrator emits the correct billing-shaped event/call exactly once per attempt that reached a provider and exactly once at chain terminal state, matching the org's configured `billing_policy` (`DATABASE.md` §2) — asserted against the defined contract (`EVENTS.md` §5, `BILLING.md` §§1–2), not against a real ledger, since none exists yet. No temporary ledger/wallet implementation is built to satisfy this early. At **Phase 7** (`ROADMAP.md` §10), once `usage_ledger`/wallets/the Pricing & Rating Engine exist, this same scenario is re-run with the assertion extended to full financial correctness: a `provider_cost` ledger entry exists for all five attempts; `customer_charge` entries match the org's configured `billing_policy` exactly per the worked example in `BILLING.md` §5; the up-front reservation (`BILLING.md` §8) is correctly released down to the actual charge. Phase 5's passing this test never implies Phase 7's billing work is already done — the two are the same scenario asserting different things at different phases, not the same requirement.
8. **Correct audit trail** — `audit_logs`/`message_events` fully reconstruct the five-step chain with accurate timestamps and no gaps, correctly split between attempt-level and message-level events (`EVENTS.md` §4).
9. **Complete traceability** — a single `correlation_id` ties every attempt, event, ledger entry, and audit row together; traces show the full re-evaluation sequence at each step, not just the final outcome.
10. **Correct webhook behavior** — the delivery-confirmation webhook for attempt 5 is processed exactly once even if the simulator redelivers it (`DUPLICATE_WEBHOOK`), and does not affect the now-superseded attempts 1–4.

This scenario is the acceptance gate for Phase 5 (`ROADMAP.md` §8, with item 7 scoped to the billing integration-contract as above) and is re-run as a regression test thereafter, including as Phase 7's own billing acceptance gate (`ROADMAP.md` §10) once item 7 can be asserted against the real ledger.

## 4. Idempotency tests

- Duplicate API request with an identical `Idempotency-Key` and identical payload → original response replayed verbatim, no second `messages` row (`API.md` §4, `DATABASE.md` §7.1).
- Same `Idempotency-Key`, different payload → `422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, no message created or mutated.
- Concurrent duplicate requests racing on the same key → exactly one proceeds to create the resource; the other(s) receive `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`.
- Duplicate worker execution of the same job (simulated double-delivery of a Kafka message) → `processed_events`/attempt-uniqueness prevents a second side effect (`EVENTS.md` §3, `DATABASE.md` §7.2).
- Duplicate attempt creation attempted by two racing processes for the same escalation → exactly one `message_attempts` row is created, verified against the conditional-transaction guard (`FALLBACK_ENGINE.md` §4).
- Provider timeout after acceptance, followed by a retry using the same `provider_idempotency_key` → asserted against the simulator's `TIMEOUT` behavior, verifying the adapter reuses the same key rather than minting a new one (`DATABASE.md` §7.3).

## 5. Fallback concurrency tests

- Concurrent fallback-poller workers racing on the same `deadline_at`-expired attempt → `FOR UPDATE SKIP LOCKED` ensures exactly one worker claims the row; the other sees nothing to process.
- Redis lock loss/unavailability during escalation → escalation still proceeds correctly via the Postgres conditional transaction alone (degraded performance, not degraded correctness), verified by running the critical scenario test with the Redis accelerator forcibly disabled.
- Duplicate fallback-timer fire (the same `deadline_at` check triggered twice, e.g. by a retried scheduler tick) → the second conditional `UPDATE` affects 0 rows and is a verified no-op, not a duplicate escalation.
- Late delivery confirmation arriving after fallback has already escalated → recorded on the superseded attempt, does not regress `messages.status` or trigger a second customer-visible send (`ARCHITECTURE.md` §9b).
- Out-of-order attempt-level events (e.g. `delivered` arrives before `provider_accepted` due to network reordering) → monotonic-state guard prevents an invalid regression.
- A message reaching a terminal state (e.g. via a fast delivery webhook) *just before* its fallback timer fires → the conditional transaction's `status NOT IN (terminal states)` predicate correctly aborts the escalation.
- A hard-pinned channel (`requested_channel_id` set, `cross_channel_fallback_enabled = false`, `ROUTING_ENGINE.md` §1a) with every provider on that channel ineligible → the chain fails per the org's failure policy at that step; the Channel Router never substitutes a different channel, verified by asserting no `message_attempts` row for this message ever has a `channel_id` other than the requested one.
- The same scenario with `cross_channel_fallback_enabled = true` → the Channel Router substitutes the next channel per `fallback_steps`, verified by asserting a subsequent attempt's `channel_id` differs from the requested channel.

## 6. Tenant and scope isolation tests

These exercise the canonical scope hierarchy `platform → reseller → organization → workspace → team` (`TENANCY.md` §1a). They are organized by the *direction* of the attempted access, because horizontal and vertical failures have different causes and different fixes.

### 6a. Horizontal isolation (sideways, at the same level)

- Org A → Org B: read, update, delete and enumerate, for every resource type → denied.
- Workspace A → Workspace B **within the same organization** → denied. This one matters precisely because RLS does not cover it (`TENANCY.md` §3a); it is the authorization layer's own boundary and is tested as such.
- Team A → Team B within the same workspace → denied.
- Reseller A → Reseller B's organizations → denied.

### 6b. Vertical privilege escalation (upward)

Each of these asserts that a grant is never widened by the scope it is used at (`TENANCY.md` §1a.4):

- team-scoped grant attempting a workspace-scoped action → denied.
- workspace-scoped grant attempting an organization-scoped action → denied.
- organization-scoped grant attempting a reseller-scoped action → denied.
- reseller-scoped grant attempting a platform-scoped action → denied.

The mirror-image positive tests are equally necessary: an organization-scoped grant *does* reach its own workspaces and teams without any additional grant, or the model has been implemented as isolation-by-accident rather than as inheritance.

### 6c. Scope substitution

An authenticated caller supplies another `org_id` / `workspace_id` / `team_id` / `reseller_id` in a path, query, body or header → rejected, never silently substituted and never silently filtered to an empty result (`TENANCY.md` §2b). Includes a forged tenant id in a JWT claim: rejected because tenancy is re-derived from `user_roles` against the *verified* credential, not read from the claim.

### 6d. Enumeration

List organizations, workspaces, teams, users and roles as principals at each scope level, and assert that out-of-scope resources are **absent from the listing** rather than returned-and-forbidden — and that a direct fetch by a known out-of-scope id returns `404` without echoing the identifier (`TENANCY.md` §4a). A test that only checks the `403` misses the disclosure.

### 6e. Role-assignment escalation

- A lower-scope actor granting a role at a higher scope → denied.
- Any non-platform actor granting `alendei_super_admin`, `alendei_support` or `reseller_admin` → denied.
- Granting a platform role at `organization` scope to "scope it down" → denied.
- Granting a permission the actor does not itself hold → denied.
- Composing a custom tenant role containing a `platform.*` permission → refused by `fn_validate_role_permission`.
- Cross-tenant grant (Organization A's role at a scope owned by Organization B, `RBAC.md` §6's invalid state) → rejected at the application-validation layer **and**, independently, at the database trigger when that layer is deliberately bypassed. Both paths are tested separately; a test that only exercises the service layer proves nothing about the trigger.
- A forged `org_id` on a grant insert → overwritten by the trigger's derived value, not merely rejected.

### 6f. Parent–child integrity

- A workspace that does not belong to the claimed organization → rejected.
- A team that does not belong to the claimed workspace or organization → rejected, including at the database, where the composite foreign key makes the inconsistent row unrepresentable (`TENANCY.md` §1a.3).
- A role-grant scope whose ownership chain does not reach the role's organization → rejected.

### 6g. Database-level RLS proof

These connect **directly as the non-owner principal**, bypassing the application entirely, because the point is to prove the guarantee survives the application being wrong:

- `acc_app` with another tenant's context set → sees nothing of this tenant's data, for select, update and delete alike.
- `acc_app` with *no* tenant context set → sees nothing at all (fails closed, not open).
- `acc_app` attempting to write a row into another tenant → refused by the policy's `WITH CHECK`, not merely filtered on read.
- `acc_app` cannot disable RLS, cannot `SET ROLE` to the owner, and is neither table owner nor superuser — asserted against the catalog, not assumed.
- `acc_auth` and `acc_relay` hold exactly their intended grants and no others — also asserted against the catalog, so a future migration that widens one is caught.
- **Negative control**: a deliberately weakened query (one that omits the application's own `org_id` filter) still returns nothing cross-tenant. Without this test the suite cannot distinguish "RLS works" from "the application filter happened to work".

### 6h. Worker and pooled-connection context

- Worker tenant-context contamination: two jobs for two different organizations run back-to-back on the same pooled connection; the second never sees the first's RLS context (`TENANCY.md` §5, `DATABASE.md` §14a) — this specifically tests that `SET LOCAL` truly resets at transaction boundary under the pooling strategy actually used.
- Reused connection after an error/exception path (not just the happy path) → context still cleared, verified with a fault-injected mid-transaction failure.

### 6i. WebSocket authorization

**Phase 1B satisfies the issuance half only.** Ticket *consumption* and the socket gateway are deferred (`DECISIONS.md` D15), so the consumption, replay and subscription cases below are not exercisable at Gate B. They remain required and become testable in the phase that builds the gateway; this partial satisfaction is recorded rather than quietly passed over.

- Ticket expiry → refused.
- Ticket reuse/replay after consumption → refused.
- Ticket bound to the issuing user, session and tenant context → a ticket cannot be used by a different principal.
- Ticket issued for Workspace A used to subscribe to Workspace B's topic → refused.
- Subscription outside the ticket's recorded topic scope → refused, not silently ignored.
- Revoking the underlying session invalidates its outstanding tickets.

### 6j. Audit-log isolation and integrity

`audit_logs` is the one table where a write is itself a security claim ("this actor did this, at this scope"), so it is tested as a boundary in its own right (`DATABASE.md` §12, ADR-002). Implemented in `packages/db/src/test/audit.int-spec.ts`, all against a real database:

- **Structure** — table, every column, every index, every foreign key (including the three composite ones), RLS enabled, the expected policies and *no* UPDATE/DELETE policy, all three triggers, and the grant set asserted against the catalog so a later migration that widens it is caught.
- **Append-only** — `UPDATE`, `DELETE` and `TRUNCATE` each refused for the schema owner as well as for `acc_app`; the row is then re-read to confirm it is unchanged.
- **Tenant isolation** — Org A reads its own trail; Org A cannot read Org B's and vice versa; a tenant cannot insert a record for another tenant; a tenant cannot create a platform-level (`org_id IS NULL`) record.
- **Platform isolation** — a platform admin reads platform-level records, a tenant cannot see them, and a reseller sees exactly the organizations beneath it.
- **Actor integrity** — valid user and API-key actors accepted; an actor id contradicting `actor_type` rejected; an API key belonging to another organization rejected by the composite foreign key; a non-existent actor rejected.
- **Scope integrity** — each of the five scope levels derives the correct tenancy chain; a forged `org_id` is overwritten by the derived value rather than honoured; a non-existent scope, a `platform` scope carrying a `scope_id`, and a non-platform scope missing one are all rejected; and with the trigger deliberately disabled, the composite foreign keys and `audit_logs_scope_shape` still refuse an impossible row — proving the constraint, not just the trigger.
- **`acc_auth` confinement** — a pre-tenant authentication record is accepted; an organization- or reseller-scoped record, a non-auth action, an invented action, and an attempt to impersonate the `system` or `oauth_client` actor are each refused; `acc_auth` cannot read the table at all; and the SQL action vocabulary is asserted to match `AUTH_ROLE_AUDIT_ACTIONS` in `@acc/contracts`, so the two cannot drift.
- **Organization deletion** — with every other child removed, deleting an organization that has audit history fails with a foreign-key violation naming `audit_logs`, and the organization is closed instead (`TENANCY.md` §1b).
- **Negative control** — the SELECT policy is weakened to `USING (true)` mid-test; Org B's rows must then become visible from Org A, and must disappear again when it is restored. Without this the isolation assertions could not be distinguished from an incidental absence of data.

### 6k. Authentication and credential lifecycle (Phase 1B)

Implemented across the `@acc/api` integration and `security` Jest projects; the latter exists and is CI-wired but is currently empty.

- Valid login succeeds; wrong password, unknown email and a disabled user each fail — and unknown email and wrong password return an **identical** body with comparable timing, so the endpoint is not a user-enumeration oracle.
- Argon2id parameters come from configuration; a stored hash with outdated parameters is rehashed on successful login.
- Access token expires at its configured TTL; its claims carry `sub`/`sid`/`actor_type`/`jti`/`iss`/`aud`/`iat`/`exp` and **nothing else** — asserted positively, so adding a tenancy or role claim fails the test (ADR-003 D-3).
- A forged `org_id`, role or permission claim in an otherwise valid token changes nothing, because tenancy and authorization are re-derived (§6c).
- Refresh rotates; the rotated token is rejected on reuse and revokes the whole session chain; `revoked_at`/`expires_at` are checked on every refresh, not only at access-token expiry.
- Logout revokes only the presenting session; revoke-all revokes every session for the user.
- The refresh token is delivered only as an `httpOnly` cookie and never appears in a JSON body readable by browser JavaScript; the refresh endpoint rejects a request without its required custom header, so a cross-site form post cannot drive it (`API.md` §3b).
- No route accepts a token in a query parameter — asserted by scanning the registered routes, not by spot-checking.
- `/auth/*` rate limiting returns `429` with `Retry-After`; the per-IP and per-account buckets are each independently effective.
- Revoked and expired API keys are rejected; a key acts only within its bound organization; a key's effective permissions are the intersection in `RBAC.md` §5c, re-evaluated at use — a key whose creator has since lost a permission loses it too.

### 6k.1 The authenticated chain (Phase 1B.3 gate)

One test asserting every link of the request-to-database chain, required before any authenticated tenant-scoped endpoint uses `AuditWriter`'s non-transactional path (`ROADMAP.md` §4a):

`AuthGuard` → `RequestContext.setPrincipal()` → `ScopeResolver` → `TenantContext` → `TenantDatabase.withRequestTenant()` → `SET LOCAL` → `acc_app` → RLS → `AuditWriter`.

- A verified credential resolves a principal; an unverified or revoked one resolves none and the request fails closed.
- Tenancy is derived from `user_roles`, never from a token claim — asserted with a token carrying a forged `org_id`.
- `withRequestTenant` establishes context with `SET LOCAL` inside one transaction, and the audit row written through it lands with the derived tenancy.
- With no principal, the path refuses rather than writing unscoped.

### 6k.2 Credentials, sessions and rotation (Phase 1B.2)

Implemented in `apps/api/src/iam/*.spec.ts` (unit) and `apps/api/test/iam-session.int-spec.ts` / `bootstrap.int-spec.ts` (integration).

- **Credentials** — Argon2id digest asserted by its `$argon2id$` prefix and configured `m`/`t`/`p`; correct password verifies, wrong password and empty password do not; the same password salts differently each time; a corrupt digest reads as "wrong password" rather than throwing; `needsRehash` is true below the configured cost and for any unparseable or foreign digest; no method returns or retains the plaintext.
- **Refresh tokens** — 32 bytes of CSPRNG entropy, never repeating; only the SHA-256 is persisted; the stored row contains no substring of the raw token; the token has no parseable structure to forge; hash comparison does not short-circuit.
- **User lifecycle** — an invited user has no credential and cannot authenticate; activation sets a digest and moves to `active`; a **disabled user cannot authenticate even though their password still verifies** (the test that proves status is checked independently of the digest); the database refuses an `active` user with no credential.
- **Sessions** — creation, lookup by token hash, idempotent revocation preserving the original reason, revoke-all, and presentability covering revoked, expired **and rotated**.
- **Rotation** — the successor inherits the family and issues a different token; the predecessor is marked spent; replaying a rotated token is detected and revokes the entire family.
- **Concurrency** — two genuinely concurrent transactions on **two independent connection pools** rotate the same token; exactly one wins. Plus the constraints beneath it: two successors replacing one predecessor is refused, and contradictory lineage columns are refused.
- **Bootstrap** — creates the first platform administrator; is idempotent; a second run with a *different* email still creates no second administrator; both audit rows are written inside the bootstrap transaction; an audit failure rolls the administrator back; a missing platform role aborts with a clear message; and `fn_validate_user_role_scope` is **not** weakened — an ordinary `acc_app` principal still cannot grant a platform role afterwards.
- **Principal boundary** — `acc_auth` is refused INSERT on `users`; its grants on `sessions` are exactly `INSERT, SELECT, UPDATE` with no DELETE, asserted against the catalog.
- **RLS** — `sessions` still carries both policies after the lineage migration, a user sees only their own sessions through `acc_app`, and a negative control weakens `sessions_self` mid-test to prove the isolation assertions measure the policy.

### 6l. Tenant-context selection (Phase 1B)

- A principal with exactly one organization in scope resolves it implicitly.
- A principal with several in scope and **no** `X-Acc-Organization` header → `400 TENANCY_CONTEXT_REQUIRED`.
- `X-Acc-Organization` naming an organization outside scope → `403 TENANCY_CONTEXT_MISMATCH`, **never** a substitution and **never** an empty `200`.
- An in-scope selector matching no rows returns an empty `200` — asserted alongside the case above, because the whole point is that a refusal and genuine emptiness stay distinguishable.
- A platform admin is not exempt from supplying the selector when acting on tenant data.

### 6m. Bootstrap (Phase 1B)

- The bootstrap CLI creates the first platform admin and grants `alendei_super_admin` at `platform` scope.
- Rerunning it against an already-bootstrapped database changes nothing.
- It installs no fixed or default password.
- It writes its own audit records.
- `fn_validate_user_role_scope` is unchanged by it: after bootstrap, an ordinary application principal still cannot grant a platform role.
- No HTTP route performs a privilege grant without authentication — asserted against the registered route table.

## 7. Billing tests

- Concurrent wallet spending: N concurrent sends for one org, each individually within budget but collectively exceeding available balance → exactly the affordable subset is authorized via the `FOR UPDATE` reservation (`BILLING.md` §8, `DATABASE.md` §10a), never an overspend.
- Duplicate billing event (the ledger-writer consumer receives the same event twice) → exactly one ledger row results, per its own idempotent-consumer guarantee.
- Fallback charging under both `billing_policy` values, matching the worked example in `BILLING.md` §5 exactly.
- Provider failure mid-chain → `provider_cost` entries recorded for failed attempts; `customer_charge` behavior matches policy; reservation correctly released to the actual final amount.
- Refund and adjustment → each produces a new, independently auditable `usage_ledger` row; no historical row is ever mutated.
- Retry of a billing-affecting operation with the same idempotency key → no double charge.
- Pricing versioning (Phase 7+, `BILLING.md` §15): a pricing plan version activated after a transaction was rated does not alter that transaction's already-recorded `usage_ledger` entries; re-querying the historical transaction returns the original `pricing_plan_version`/`pricing_rule` reference, not the currently-active one.
- Attempt-level pricing (`BILLING.md` §16): a fallback chain spanning multiple providers/channels correctly records an independent `pricing_evaluation`/`provider_cost` per attempt, never one shared cost/price across the whole chain.
- Multi-component pricing evaluation (`BILLING.md` §16): a composite transaction (e.g. a simulated Voice AI attempt) correctly records one `pricing_evaluations` row whose `total_customer_price`/`total_provider_cost` equals the sum of its `pricing_evaluation_components` rows — no component is silently dropped or double-counted.

## 8. Webhook tests

- Duplicate provider webhook (`DUPLICATE_WEBHOOK` simulator behavior) → processed exactly once, second delivery acknowledged but not reprocessed (`DATABASE.md` §12 unique constraint).
- Forged webhook (invalid/missing signature) → rejected `401`, never persisted as a verified event.
- Provider webhook replay (an admin replays a `webhook_events` row) → reprocesses idempotently, produces no second business event (`EVENTS.md` §5b).
- Out-of-order webhook (`OUT_OF_ORDER_WEBHOOK` simulator behavior) → monotonic-state guard prevents an invalid status regression.
- Outbound webhook retry → correct exponential backoff sequence, correct `webhook_deliveries` state transitions.
- Outbound webhook replay → re-delivers the same `event_id`/payload, does not regenerate the underlying domain event or trigger a second send (`EVENTS.md` §5d).
- Outbound endpoint sustained failure → correctly transitions to `dead_letter`/`auto_disabled` per configured thresholds, and is recoverable via the DLQ replay path (`RUNBOOK.md`).

## 9. Chaos testing

Fault injection targets: kill a Kafka broker/partition leader mid-flow, inject Postgres connection pool exhaustion, inject Redis latency/unavailability (verifying the Postgres-conditional-transaction path in `FALLBACK_ENGINE.md` §4 still guarantees correctness — see §5 above), and simulate a provider flapping between `HEALTHY`/`CRITICAL` to verify circuit breaker stability (no rapid open/close oscillation — hysteresis in threshold config).

## 10. Security testing

- SAST and dependency vulnerability scanning in CI (blocking on high/critical findings).
- Targeted abuse-case tests per `SECURITY.md` §6: the full tenant- and scope-isolation matrix in §6 above, webhook signature bypass/replay attempts, rate-limit bypass attempts, privilege-escalation attempts via `user_roles`/`role_permissions` manipulation (`RBAC.md` §§6-7), unauthorized provider test-send/admin-operation attempts (`PROVIDER_ADAPTER.md` §4).
- **Every security defect found gets a regression test before it gets a fix**, named for the behaviour it prevents rather than for the incident.
- Periodic manual review (`code-review`/security-review discipline) before any phase's production release gate.

## 11. Load/performance testing

Baseline and peak-volume throughput tests against the simulator, measuring API p50/p95/p99 latency, queue consumer lag under sustained load, and Fallback Engine timer accuracy under load (does a 5-minute window still fire within an acceptable jitter bound when the `deadline_at` poller is under load) — thresholds finalized per environment capacity plan in later phases.

## 12. Related

Development lifecycle gate ordering (`TEST` and `SECURITY REVIEW` as explicit stages before `DOCUMENT`/`BUILD`): `ROADMAP.md` §2.
