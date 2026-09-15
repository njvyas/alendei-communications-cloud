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

**Multi-grant cross-product cases (ADR-005 D-1).** The single-grant cases above are necessary and were never sufficient: a principal holding several grants can be widened by the *combination* even when each grant alone is correctly bounded. These are the cases that fail against a flattened permission union, and they are stated explicitly because a suite containing only the single-grant cases stays green while the defect is live:

- **`read_only` @ organization + `workspace_manager` @ workspace, asking `role_assignments.grant` at organization scope → denied.** Neither grant confers it: the organization grant lacks the permission, the workspace grant cannot reach the organization. The same shape with `teams.create`, `workspaces.update` and `users.invite`.
- **The same permission held through two grants, one of which covers the target → allowed.** The correction must not over-correct: coherence means *some* grant satisfies both halves, not that every grant must.
- **Different permissions across grants, no single grant satisfying both halves → denied**, for each pairing of (organization, workspace) and (workspace, team).
- **A permission held only at a narrower scope, used at a wider one → denied** — the general statement of the case above, asserted at every adjacent pair.
- **A principal holding no grant at all → denied**, not defaulted.

The full adversarial matrix, its layers and its mutations are in §6n.

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
- A grant at a scope level the role's `allowedScopeTypes` does not admit (`org_admin` at `team`, say) → refused. Currently a documented constraint enforced nowhere; the test lands with the enforcement in Phase 1B.5.
- Removing the last active platform administrator — by revoking the grant, by disabling the holder, and by deleting the role — → refused in all three forms, and the administrator is still able to authenticate afterwards.
- **Concurrent last-admin removal**: two genuinely concurrent transactions on **two independent connection pools** each remove a *different* platform administrator, when exactly two exist. Exactly one succeeds; at least one administrator remains. This is the case an application-level count cannot pass, because neither transaction sees the other's uncommitted delete and no row they wrote overlaps (ADR-005 D-7). A negative control disables the guard and asserts that both then succeed, leaving zero administrators — without it the test cannot distinguish "the lock works" from "the two transactions happened not to interleave".

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

**The pooled-connection half is implemented (Phase 1B.4); the worker half is deferred (ADR-004 D-5).** Phase 1B has no consumer, poller or job to wrap, so the shared worker harness — and the contamination tests that would exercise *it* — arrive in Phase 2 with the first real consumer. The database guarantee underneath is not deferred with it and is proven here now, through the same `withTenantTransaction` helper a worker will use. This partial satisfaction is recorded rather than quietly passed over, as §6i's is.

Implemented in `packages/db/src/test/tenant-context.int-spec.ts`, against a real `max: 1` pool so "the same pooled connection" is a fact rather than a hope — asserted with `pg_backend_pid()`:

- Two organizations' work run back-to-back on one connection: A sees only A's rows, B sees only B's, and neither sees the other's (`TENANCY.md` §5, `DATABASE.md` §14a). Real row visibility is the assertion; reading `current_setting()` back would prove only that a value was written, not that RLS acted on it.
- **The bare probe** — a query on the same connection with *no* context established at all — returns nothing, before and after each tenant's transaction. This is the load-bearing case: a connection-level `SET` is invisible to every transaction that establishes its own context, because each one overwrites all six variables, so it surfaces only in a query that deliberately establishes none.
- Reused connection after an error/exception path, not just the happy path: a fault injected mid-transaction after a real write rolls the write back, leaves no context behind, and leaves the connection immediately usable — the next organization's transaction sees only itself.
- **Mutation-sensitive**: changing `set_config(..., true)` to the connection-level `set_config(..., false)` fails all three integration tests and the `SET LOCAL` unit assertion.

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

### 6k.3 The authenticated request pipeline (Phase 1B.3)

Implemented in `apps/api/test/auth.sec-spec.ts` (the security project, 41 tests) and `apps/api/test/auth-chain.int-spec.ts` (14 tests), plus unit suites for the token service, scope coverage, the permission evaluator, the rate limiter and trusted-proxy handling.

- **JWT** — valid; expired; wrong issuer; wrong audience; `alg=none`; a different algorithm with the same secret; a different secret; a tampered subject; five malformed shapes; a well-signed token missing required claims. The issued claim set is asserted as an **exact key set**, so adding `org_id`, roles or permissions to the payload fails the suite rather than quietly becoming an authorization source.
- **Authentication** — valid login; wrong password; unknown address; disabled user holding a valid password. Unknown address and wrong password are asserted to return an identical code *and* message. No response body contains a credential.
- **Session revocation** — a validly-signed token is refused once its session is revoked, and once its user is disabled, both with the token still cryptographically valid.
- **Refresh** — rotation issues a new token; replay of a spent token is refused and revokes the whole family (asserted against that family, not merely the user); two concurrent refreshes of one token yield exactly one 200 and one 401; an unknown token is refused.
- **CSRF** — refresh and logout both refused without `X-Acc-Refresh` and accepted with it. The refusal case sends exactly the request a cross-site form post could make.
- **CORS** — an unlisted origin is never reflected, and a wildcard origin is never combined with credentials.
- **Tenant context** — single organization implicit; multiple organizations without a selector → `400 TENANCY_CONTEXT_REQUIRED`; authorized selector accepted; unauthorized selector → `403 TENANCY_CONTEXT_MISMATCH` with **no** `workspaces` key in the body, so a refusal and genuine emptiness stay distinguishable; a non-existent organization refused identically.
- **Cross-tenant isolation** — another tenant's organization id in a query parameter is refused; another tenant's workspace id returns `404` without echoing the id, with a positive control on the same route proving the 404 is isolation rather than a broken endpoint.
- **Session management** — listing returns only the caller's sessions; revoking another user's session returns `404` and leaves it live.
- **Rate limiting** — the threshold is enforced and stays enforced within the window; both buckets are independently effective; an IPv6 address produces a usable key; Redis unavailability fails open *and* flags the verdict; the account identifier never appears in a key.
- **Trusted proxy** — a forged `X-Forwarded-For` is ignored at zero trusted hops, the nearest untrusted hop wins at one, and over-configuring the hop count is shown to let a client forge its address.
- **Audit** — login success, login failure (anonymous actor, with the attempted address asserted *absent*), logout, refresh and session revocation all recorded; session and audit row commit together; breaking the `acc_auth` insert policy rolls the session back.

### 6k.4 API-key authentication and authorization (Phase 1B.3)

`apps/api/test/api-key.sec-spec.ts` (22 tests). Added after an independent review found API-key principals authenticated and then denied everything, with the whole method untested.

- **Intersection** — creator holds the permission → authorized; creator does not → the scope is absent from the principal and the operation is denied; a key requesting only unheld permissions authenticates but authorizes nothing; revoking the creator's permission denies the *existing* key on its next request; a key whose creator is unknown resolves to no permissions.
- **Synthesized grant** — exactly one grant, at the key's own binding, never `platform`; a workspace-bound key is scoped to its workspace and is refused an organization-wide operation.
- **Organization binding** — reaches only its own organization; a selector for another organization is `403 TENANCY_CONTEXT_MISMATCH` with no body payload; its own organization is accepted; another organization's workspace id returns `404` without echoing it.
- **Credential failures** — revoked, expired, wrong secret, unknown prefix and three malformed shapes all `401`; an unknown prefix and a wrong secret return an identical code *and* message, so key existence is not disclosed; no error echoes the presented credential.
- **Audit** — `api_key.authenticated` written with `actor_type='api_key'`, the key id, `scope_type='platform'`, and no credential material anywhere; a failed authentication writes nothing; `last_used_at` and the audit row share a transaction, proven by refusing the audit policy and asserting `last_used_at` stays null.
- **Mutation-sensitive** — emptying `roles` fails 8 tests; ignoring the creator intersection fails 3; removing organization binding fails 1; removing audit emission fails 3; removing the bookkeeping fails 1.

### 6k.5 Advisory tenant identifiers (Phase 1B.4)

`apps/api/test/advisory-identifier.sec-spec.ts` (the security project) and `apps/api/src/tenancy/advisory-identifier.spec.ts` (unit). The HTTP suite drives the real guard through the real application; routes for the workspace and team levels come from a probe controller registered only in the test module, because the production surface does not accept those identifiers until Phase 1B.6 and a mechanism must be proven correct before it is handed them.

- **Organization** — a matching identifier is accepted; another tenant's is `403 TENANCY_CONTEXT_MISMATCH` with no handler output at all; a non-existent one is refused with an *identical* code and message, so the endpoint is not an existence oracle; the supplied value is never echoed back.
- **Workspace and team** — a principal whose only grant is at workspace or team level is pinned to it: its own is accepted, another tenant's is refused, and a **sibling team in its own organization** is refused, which is the case RLS cannot see at all (`TENANCY.md` §3a). A team-scoped principal's workspace is the one derived from its team, and another workspace is refused.
- **Unpinned levels** — an organization-scoped principal supplying a `workspace_id` is not refused here, because its grant covers every workspace beneath it and there is nothing to contradict without reading the database. The narrowing is decided by target-scope authorization and RLS instead, asserted by §6k.3's `404`-not-`403` case (ADR-004 D-3).
- **Sources** — the same cross-check runs on a query parameter, a path segment and a body field, so an identifier is judged the same way wherever it arrives.
- **Shape** — a repeated parameter is `400 VALIDATION_FAILED` in either order and even when the duplicates agree, never resolved by picking one; a malformed or empty identifier is refused rather than treated as absent; a hostile value is never echoed into the response. Array and object forms are asserted at the unit level, where the normalizer is exercised directly rather than through a parser setting.
- **Declaration** — an identifier no handler declared is not policed as a tenant identifier, and an undeclared parameter carrying another tenant's id demonstrably changes nothing about what the request returns.
- **Fail-closed boundary** — an unauthenticated request to a declaring route is `401` before any cross-check runs.
- **Mutation-sensitive** — bypassing the guard's cross-check fails 19 tests, including §6k.3's pre-existing cross-tenant case; removing the declaration from `TenancyController` alone fails 3. A suite that stays green when the protection is removed would prove nothing.

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

### 6n. Authorization coherence (Phase 1B.5)

The suite that makes `RBAC.md` §2's rule testable rather than aspirational. Every case asks one question: does a decision rest on **one** grant that supplies both the permission and the covering scope?

**Layers.** Unit tests over the evaluator for the algebra; integration tests over real HTTP with real grants for the request path; security tests for the escalation attempts. The algebra is cheap enough to enumerate exhaustively and is, so the integration layer asserts the wiring rather than re-deriving the matrix.

**Implemented for Phase 1B.5.1** (cases 1–12, 15, and the grant/role-state rows) in `apps/api/src/auth/permission-evaluator.spec.ts` (31 unit cases, permission sets read from `TENANT_ROLE_DEFINITIONS` rather than invented), `apps/api/test/coherent-grant.sec-spec.ts` (5 cases driving the real `/tenants/workspaces` endpoint) and `apps/api/test/api-key-binding-scope.sec-spec.ts` (17 cases).

**Extended for Phase 1B.5.2** (cases 1–9, 13, 14, and target-ancestry provenance) across three suites:

- `apps/api/test/scope-chain.int-spec.ts` (22 cases) — every level resolves to database truth, cross-checked against the rows independently of the fixture; nonexistent, id-less and wrong-kind targets all resolve to nothing rather than to a partial chain; cross-organization and cross-reseller targets are invisible; **the same target resolves identically under any tenant context that can see it**, which is what a resolver reading ancestry from the session rather than the row would fail; and a pooled-connection hygiene case re-asserting §6h across the new access path.
- `apps/api/test/authorization-service.sec-spec.ts` (22 cases) — the §6b matrix through the boundary, `404`-not-`403` for unresolvable targets with no identifier echoed, the forged-ancestry matrix below, and the 1B.5.1 coherence invariant re-proven through the service rather than only at the evaluator.
- `apps/api/src/auth/authorization-boundary.spec.ts` (6 cases) — structural: no controller imports `PermissionEvaluator`, no controller performs target-scope SQL, no hierarchy query inside the evaluator, no grant logic inside the resolver, and **`AuthorizationCheck` exposes no `chain` field**, so caller-supplied ancestry stays unrepresentable.

**Denial auditing (Phase 1B.5.3, ADR-005 D-6).** `apps/api/test/authorization-denial-audit.sec-spec.ts` (25 cases), against real rows and the real `AuditWriter`:

- **Written** — a resolved target the principal cannot reach produces exactly one `authorization.denied` row, attributed to the authenticated principal, carrying the attempted permission, the attempted target in `resource_id` and `metadata`, the resource type (explicit, and defaulted to the target level), the request correlation id, and `outcome='denied'`.
- **Actor scope** — the row records where the actor *legitimately* was, never where it reached. A workspace-pinned principal denied at a sibling workspace records its own workspace, and the derived tenancy follows it; the attempted target never appears as the actor's scope. Narrowest-first selection is asserted separately.
- **Not written** — a successful authorization, a nonexistent target, an RLS-invisible foreign target, a cross-reseller target, and the non-throwing capability probe all write nothing. An unknown id and a real foreign one are indistinguishable in the audit trail as well as in the response, so the trail cannot become an existence oracle.
- **Audited because resolved** — a sibling workspace *is* resolvable (RLS carries no workspace term), so its refusal is a real attempt and is recorded.
- **API keys** — attributed by key id with no user actor, and the record is asserted to contain no credential material: not the key secret, not an Argon2 digest, not a key prefix, not a bearer or refresh token.
- **Metadata shape** — exactly four fields (`permission`, `attemptedScopeType`, `attemptedScopeId`, `denialReason`), `before`/`after` null, and no key the redactor would treat as sensitive. No request, headers, principal, token or cookies.
- **Fail closed** — with `AuditWriter` made to fail, the audit failure propagates rather than being swallowed into a plain `403`, nothing is recorded, and the request never proceeds.
- **Transaction semantics** — the record survives the surrounding transaction rolling back, both when the refusal itself causes the rollback and when something unrelated does; and it is committed *before* the refusal reaches the caller.
- **Pool exhaustion** — the record is written on a second connection checked out of the same pool the caller's transaction already holds one from, so `DATABASE_POOL_MAX=1` is the one configuration in which it can never obtain one. With a `max: 1` pool the denial fails closed and *bounded* — `pg` ends the queued acquisition at `connectionTimeoutMillis` (five seconds by default in `createPool`) rather than hanging — and the failure surfaces as a `500`, never as a plain `403` claiming an audited refusal. The same service on a `max: 2` pool records normally, so the condition is a resource limit and not a poisoned path.

**Forged ancestry (ADR-005 D-5).** Asserted as the strong property, not the weak one: it is not enough that bad input is rejected: the *authoritative* chain must decide. Each case runs under a tenant context that can see the target, so visibility is not the variable — a grant naming another organization cannot reach a workspace whose real parent is a different organization; the same for a grant naming another reseller, and for one naming another workspace as a team's parent; and a principal holding grants that between them name a wholly false chain still reaches nothing. Every case carries a positive control on the claimant's own rows, so a denial cannot be mistaken for a broken query.

| # | Case | Expected |
|---|---|---|
| 1–9 | The §6a/§6b single-grant matrix — same-org, cross-org, same/sibling workspace, same/sibling team, parent covers child, child covers neither sibling nor parent | as §6a/§6b |
| 10 | `read_only`@org + `workspace_manager`@ws asking `role_assignments.grant`@org | **denied** — the regression test for ADR-005 |
| 11 | Same permission via two grants, one covering | allowed |
| 12 | Different permissions across grants, none coherent | denied |
| 13 | Reseller A reaching Reseller B's organization | denied |
| 14 | Platform grant across all five levels | allowed |
| 15 | API-key creator intersection taken at the key's binding scope | the wider permission is absent from the principal |
| 16 | Grant revoked → next request | denied |
| 17 | Permission removed from a role → next request | denied |
| 18 | Role deleted while grants exist | `409`, grants intact |
| 19–20 | Last platform admin, sequential and concurrent | §6e |
| 21 | Granting role R at scope s where the actor lacks R's permissions *at s* | `403` |
| 22 | Granting a permission the actor holds only at a narrower scope | `403` — §6b's cross-product as an escalation attempt |
| 23 | A refusal writes `authorization.denied` | row carries the **actor's** scope |
| 24 | Denial metadata carries the attempted target; the response does not | both asserted |
| 25 | Application authorization bypassed → RLS still blocks cross-organization | zero rows |
| 26 | `fn_validate_user_role_scope` with the service bypassed | raises |
| 27 | Self-grant within the actor's own effective grant authority | allowed, and confers nothing new |
| 28 | Grant at a scope type `allowedScopeTypes` does not admit | refused |
| 29 | Duplicate grant | `409` |
| 30 | Every scoped route performs exactly one target-scope check | asserted against the registered route table, not by review |

**Mutation sensitivity.** Each mutation is applied, the suite is run, the named tests must fail, and the implementation is restored:

| Mutation | Must fail |
|---|---|
| `grantCarries` returns the flattened union (restores the pre-1B.5.1 behaviour) | 10, 12, 22 — **executed at 1B.5.1: 18 unit + 2 security tests fail** |
| Permission provenance and scope provenance taken from different grants | 10–12 — **executed at 1B.5.1: 17 unit + 2 security tests fail** |
| API-key creator intersection taken over the creator's flattened union | 15 — **executed at 1B.5.1: 5 security tests fail** |
| API-key binding-scope coverage widened to any grant in the same organization | 15 — **executed at 1B.5.1: 4 security tests fail** |
| Target organization ancestry taken from the caller-selected tenant context rather than the row | **executed at 1B.5.2: 2 integration + 1 security tests fail** |
| Target reseller ancestry taken from the caller-selected tenant context rather than the row | **executed at 1B.5.2: 3 integration + 1 security tests fail** |
| A caller-supplied `chain` permitted to override the resolved one | **executed at 1B.5.2: the boundary test fails** |
| A controller bypassing `AuthorizationService` to call the evaluator with its own chain | **executed at 1B.5.2: 1 unit + 2 security tests fail** |
| `principal.permissions` reintroduced as an authorization pre-check | **executed at 1B.5.2: 18 unit + 3 security tests fail** |
| The `authorization.denied` write removed | **executed at 1B.5.3: 17 security tests fail** |
| The denial record written into the caller's (rolling-back) transaction instead of its own | **executed at 1B.5.3: 16 security tests fail** |
| An `AuditWriter` failure swallowed instead of propagated | **executed at 1B.5.3: 1 security test fails** — the request still refuses, so only the non-swallowing assertion detects it, which is the precise property at stake |
| The attempted target scope written as the actor's scope | **executed at 1B.5.3: 3 security tests fail** |
| An unresolved (`404`) target audited as a denial | **executed at 1B.5.3: 3 security tests fail** |
| Credential-bearing request data added to denial metadata | **executed at 1B.5.3: 2 security tests fail** |
| `scopeCovers` term dropped from `allows` | 4, 6, 8, 9 |
| Permission term dropped from `allows` | 12 and every denial case |
| `ScopeChainResolver` returns the request-supplied chain | 2, 4, 6 |
| Advisory lock removed from the last-admin path | 20 only — 19 still passes, which is the point |
| Last-admin trigger removed, service check kept | 20 and the service-bypassed case |
| Escalation guard written against the flattened union | 21, 22 |
| API-key intersection taken at the creator's widest scope | 15 |
| `authorization.denied` write removed | 23, 24 |
| Denial records the *attempted* scope as the actor's scope | 23 |
| Role delete cascades instead of refusing | 18 |

The first mutation is the keystone: it is the behaviour in production today, so a suite that stays green under it has not fixed anything.

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
