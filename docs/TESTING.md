# Testing Strategy

## 1. Layers

| Layer | Scope | Tooling direction |
|---|---|---|
| Unit | Pure logic: routing scoring, fallback state transitions, billing math, permission evaluation | Jest |
| Integration | Module-boundary contracts against real Postgres/Redis/Kafka in Docker Compose | Jest + Testcontainers-style ephemeral infra |
| Contract | API responses validated against the generated OpenAPI document (`API.md` §9); the committed snapshot equals the generated document | `openapi-responses.sec-spec.ts` / `openapi-contract.sec-spec.ts` in the security project; the `openapi-contract` CI job (Phase 1C.3) |
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

- Org A → Org B: read, update, delete and enumerate, for every resource type → denied — **including sibling organizations under the same reseller**, the topology every direct customer is in. Until the Gate-B remediation no fixture built it (every tenant had its own reseller), and it was reachable; now proven by `shared-reseller.int-spec.ts` and `shared-reseller-isolation.sec-spec.ts` (§6o).
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
- `acc_app` cannot disable RLS, cannot `SET ROLE` to the owner, and is neither table owner nor superuser — asserted against the catalog, not assumed (`principals.int-spec.ts`, §6o; before the Gate-B remediation only the superuser/BYPASSRLS half was asserted).
- `acc_auth` and `acc_relay` hold exactly their intended grants and no others — asserted as an exact grant map against the catalog (`principals.int-spec.ts`), so a future migration that widens one is caught.
- **Negative control**: a deliberately weakened query (one that omits the application's own `org_id` filter) still returns nothing cross-tenant. Without this test the suite cannot distinguish "RLS works" from "the application filter happened to work".

### 6h. Worker and pooled-connection context

**The pooled-connection half is implemented (Phase 1B.4); the worker half is deferred (ADR-004 D-5).** Phase 1B has no consumer, poller or job to wrap, so the shared worker harness — and the contamination tests that would exercise *it* — arrive in Phase 2 with the first real consumer. The database guarantee underneath is not deferred with it and is proven here now, through the same `withTenantTransaction` helper a worker will use. This partial satisfaction is recorded rather than quietly passed over, as §6i's is.

Implemented in `packages/db/src/test/tenant-context.int-spec.ts`, against a real `max: 1` pool so "the same pooled connection" is a fact rather than a hope — asserted with `pg_backend_pid()`:

- Two organizations' work run back-to-back on one connection: A sees only A's rows, B sees only B's, and neither sees the other's (`TENANCY.md` §5, `DATABASE.md` §14a). Real row visibility is the assertion; reading `current_setting()` back would prove only that a value was written, not that RLS acted on it.
- **The bare probe** — a query on the same connection with *no* context established at all — returns nothing, before and after each tenant's transaction. This is the load-bearing case: a connection-level `SET` is invisible to every transaction that establishes its own context, because each one overwrites all six variables, so it surfaces only in a query that deliberately establishes none.
- Reused connection after an error/exception path, not just the happy path: a fault injected mid-transaction after a real write rolls the write back, leaves no context behind, and leaves the connection immediately usable — the next organization's transaction sees only itself.
- **Mutation-sensitive**: changing `set_config(..., true)` to the connection-level `set_config(..., false)` fails all three integration tests and the `SET LOCAL` unit assertion.

### 6o. Gate-B remediation suites (ADR-011)

| Suite | Cases | What it proves | Fails if… |
|---|---|---|---|
| `packages/db/src/test/shared-reseller.int-spec.ts` | 19 | Reseller A → {Org A1, Org A2}, Reseller B → {Org B1}. As the non-owner `acc_app`, with no application filter, on every tenant table: A1 sees only A1 (A2 and B1 denied), Reseller A sees A1+A2 and not B1, Reseller B only B1, platform all; A1 cannot update/delete/insert into A2 or B1, cannot write its own reseller or create an organization under it; support is neither a platform reader nor writer; a disabled reseller administrator's claim stops being honoured | the reseller claim is derived from the organization again **and** accepted by the database; the platform flag is honoured for support; a policy predicate is weakened. Two negative controls restore the pre-0010 unvalidated accessors and watch the sibling reappear |
| `apps/api/test/shared-reseller-isolation.sec-spec.ts` | 36 | Same topology over real HTTP: organization selection, six list endpoints enumerating nothing of a sibling, direct-object reads and writes with sibling ids all `404`, the enrol-then-disable chain closed, reseller/platform/support reach, workspace- and team-scoped principals refused organization lists; and the context `ScopeResolver` computes for each principal applied to `acc_app` with no filter | the resolver derives `resellerId` from the organization (2 cases fail, verified by mutation); the full original defect is restored — resolver + unvalidated accessor + no list predicates (14 cases fail, verified by mutation) |
| `packages/db/src/test/principals.int-spec.ts` | 26 | Every `public` table classified and RLS-enabled; no table owned by (or by a role granted to) an application principal; exact grant maps for `acc_app`/`acc_auth`/`acc_relay`; no role memberships; no column privileges or schema `CREATE`; `acc_relay` reads zero audit rows; no `SET ROLE`/`SET SESSION AUTHORIZATION` path; the start-up posture guard accepts the real principals and refuses the owner, a `BYPASSRLS` `acc_app` and a table-owning `acc_app` | negative controls: each of seven policies replaced by `USING (true)`, `ALTER ROLE acc_app BYPASSRLS`, and `ALTER TABLE … OWNER TO acc_app` each re-open the boundary (and are restored, grants included) |
| `packages/db/src/test/tenant-context-trust.int-spec.ts` | 17 | The trust model, measured as the real `acc_app`: organization claim settable and effective (the accepted residual); reseller/platform claims effective only with a real holder's user id; workspace variable inert; no team variable; no SECURITY DEFINER function sets a variable, runs dynamic SQL or grants/alters (scanner with positive control); trigger functions not callable; every SECURITY DEFINER trigger function executable by the owner only and not attachable to a temporary table, with the complete list pinned (migrations `0015`, `0016`); no `SET ROLE`/`SET SESSION AUTHORIZATION`; session-level `SET` overwritten by every sanctioned transaction; role/database defaults denied | the database starts honouring an unbacked reseller or platform claim (mutations M2, M3b), or a SECURITY DEFINER function gains a variable-setting or dynamic-SQL statement |
| `apps/api/test/workspace-team-boundary.sec-spec.ts` | 15 | Workspace 1 ↛ Workspace 2 and Team 1 ↛ Team 2 over HTTP (grant, revoke, audit detail), no escalation to the organization, another organization `404`; directly as `acc_app`, sibling workspaces/teams **visible** (RLS is organization-scoped by decision) and another organization not | the authorization layer stops enforcing below organization, or RLS stops enforcing the organization |
| `apps/api/test/platform-admin-liveness.sec-spec.ts` §G | 9 | With an `alendei_support` user present: revoking (API and DB), disabling, and `UPDATE`-ing away the last `alendei_super_admin` grant (to support role, to reseller scope, to a disabled user) are all refused; a legitimate reassignment to another active user is allowed; two concurrent API revocations and two concurrent `UPDATE`s on independent connections each leave exactly one administrator | the `UPDATE` trigger is dropped (4 fail, M11) or the count reverts to "any platform grant" (6 fail, M12) |
| `apps/api/test/auth-abuse.sec-spec.ts` | 6 | Successful login does not reset the IP bucket; refresh is throttled per address; API-key failures are throttled before Argon2 and a working key never spends the allowance | each limiter removed (4 cases fail, verified by mutation) |
| `apps/api/test/real-bootstrap.sec-spec.ts` | 13 | Through `createApp()` — the function `main.ts` calls: Helmet headers, CORS allow/deny with credentials and no wildcard, exposed rate-limit headers, CSRF header on refresh, login refusing form/text bodies (`415`), spoofed `X-Forwarded-For` ignored by default and honoured only with an explicit hop, and start-up refused when `DATABASE_URL` is the schema owner | the edge configuration or the principal guard regresses |

The API suites' `startHarness` still bypasses `main.ts` (by design, for speed); only `real-bootstrap.sec-spec.ts` is evidence for HTTP-edge controls, and the CORS assertions in `auth.sec-spec.ts` should not be cited.

### 6p. Browser E2E evidence — corrections required (Gemini; not changed in the backend remediation)

The Gate-B audit found the following in `apps/web/e2e` at `df1ec74`. They are recorded here for the frontend owner rather than edited, and **none of these tests may be cited as backend security evidence** until corrected:

| Test | Defect | Required correction |
|---|---|---|
| E2E-10 (forged `X-Acc-Organization`) | Vacuous: it never asserts that a request was sent or that the import of `/src/lib/api-client.ts` succeeded (the dev server does not serve raw source), so `capturedHeaderValue` stays `null` and the assertion passes regardless | Positive control first (a request *is* observed with the legitimate header), then assert the forged value never reaches the wire; separately, assert the backend's `403 TENANCY_CONTEXT_MISMATCH` for an unheld organization (a backend contract, already proven in `shared-reseller-isolation.sec-spec.ts`) |
| E2E-11 (low-privilege boundary) | Regex `/unauthorized|access denied/i` does not match the rendered "Access Forbidden" text; would fail if enabled, and asserts UI hiding only | Match the real text, and assert the backend refusal (network `403` with `AUTHZ_SCOPE_DENIED`), not only the rendered page |
| E2E-09 (audit payload XSS) | Builds its own `<pre>` and sets `textContent`; never renders `AuditLogDetailDialog` | Render the real dialog against a planted audit row containing markup |
| E2E-07, E2E-12 | Vacuous with zero organizations — only `ZeroOrgView` renders | Run against the fixture below |
| Storage helper (`e2e/helpers/auth.ts`) | Value regex `[A-Za-z0-9_-]{32,}` cannot match a dotted JWT; IndexedDB/Cache Storage not swept | Match `^[\w-]+\.[\w-]+\.[\w-]+$` (JWT) and sweep IndexedDB/Cache Storage |

**Backend fixture requirement for those corrections (provided by Phase 1C.4a, §6r — IMPLEMENTED and CLOSED, Gate C.4a PASS; exercised by Phase 1C.4b, §6s — IMPLEMENTED and CLOSED, Gate C.4b PASS):** a deterministic E2E seed with (a) two organizations under one reseller and one under another (the §6o topology), (b) an `org_admin` in each, (c) a low-privilege user (`read_only` at a team), (d) a user holding grants in two organizations, (e) at least one planted audit row per organization. Corrected in Phase 1C.4b (checkpoint `4e7effd`): all 12 browser E2E tests pass with zero skips; exact-secret storage proof and classified mutations verified.

### 6q. Phase 1C test plan (ADR-012) — 1C.1a and 1C.1b IMPLEMENTED; 1C.2 IMPLEMENTED and CLOSED; 1C.6 IMPLEMENTED and CLOSED (PASS); 1C.3 IMPLEMENTED and CLOSED (PASS); the rest IN PHASE 1C

Required for Gate C (`ROADMAP.md` §4d). All suites run on an isolated test database; destructive suites never run against the development database.

| Increment | Required suites and cases |
|---|---|
| 1C.1a — **IMPLEMENTED:** `apps/api/test/organization-administration.sec-spec.ts` (36 cases; the 24 required 1C.1a cases on the Gate-B shared-reseller topology, plus duplicate slug, billing-field authority, support/API-key refusal, concurrent transitions and the OD-3 no-RLS-predicate check, plus the 3 `GET /organizations` RLS-backstop cases added with the two-stage read — a wrongly derived reseller reach, a wrongly platform-wide reach, and identical paging at `limit=1` and `limit=100` for every legitimate reach); route-coverage counts updated (31 scoped, 13 deferred); 5 mutations executed and caught (status selection, API-key status, F-5 guard, forged-reseller creation, lifecycle authority) | Organization create/read/update/suspend/reactivate/close over HTTP for every §31a route; full lifecycle transition matrix including every illegal transition (`409 ORGANIZATION_LIFECYCLE_CONFLICT`); creation authority matrix (platform ✓, reseller beneath own reseller ✓, reseller for another reseller ✗, organization admin ✗, API key ✗); atomic seeding of system roles and the default workspace; status enforcement for sessions, API keys, explicit and implicit selection and lists, with no token-TTL window; platform read access to non-active organizations; no tenant mutation in a closed organization; shared-reseller isolation (§6o topology) for every new route; idempotent replay; audit rows at the correct scope; direct `acc_app` tests of the new write paths |
| 1C.1b — **IMPLEMENTED:** `apps/api/test/workspace-team-administration.sec-spec.ts` (37 cases: positive paths for org, workspace, team, reseller and platform principals; horizontal isolation org/workspace/team (another organization `404` indistinguishable from unknown, a visible sibling an audited `403`); vertical escalation team→workspace→organization→reseller→platform; `orgId`/`workspaceId`/`teamId` substitution (`orgId` advisory on workspaces, `400` on teams); parent-child integrity; list/detail/cursor/error enumeration; the full lifecycle incl. suspended/closed organizations and a concurrent archive-vs-create race, a suspension committed after the guard's read, a reseller grant held beside a foreign organization grant; an RLS backstop with the application's authorization deliberately widened); `workspace-administration-boundary.spec.ts` (structural and DTO guarantees); `schema.int-spec.ts` (migration `0012`); route-coverage counts updated (43 scoped, 21 deferred); mutations executed and reported in the 1C.1b review | Workspace and team create/read/update/archive/restore for every §31b–§31c route; default workspace not archivable; archive refused while active teams exist; archived targets refuse new teams, grants and API keys; existing grants keep working; no `DELETE` route; workspace/team boundaries as in `workspace-team-boundary.sec-spec.ts`; the deprecated `/tenants/workspaces` aliases unchanged plus `Deprecation`/`Link` headers |
| Gate C remediation — **IMPLEMENTED:** `apps/api/test/target-organization-lifecycle.sec-spec.ts` (11 cases, shared reseller with active A1, suspended A2, closed A3, unconnected reseller B); `apps/web/src/lib/session-cache.sec.test.ts` (7 cases); 5 backend and 1 frontend mutations executed and caught (see the Gate C remediation report) | **M-1 (ADR-012 F-5):** with A1 selected, a reseller administrator and a platform super administrator are refused (`409 ORGANIZATION_LIFECYCLE_CONFLICT`, `details.status`) when granting at A2/A3 (organization, workspace and team targets), revoking grants held there, and — for the super administrator — creating or revoking API keys bound there, with nothing changed in the database; the same operations against A1 succeed; a reseller administrator's API-key attempts are `403` (no API-key permission); an unconnected reseller administrator and A1's organization administrator get `404` with the target's status undisclosed; a reader's grant and key creation in A1 stay `403`; selecting A2/A3 directly is still `403 TENANCY_ORGANIZATION_*`; reactivating A2 re-admits the mutation, suspending it again refuses it, and closed A3 stays terminal. **M-2:** after sign-out, or any change of identity, no organization, workspace or team query of the previous identity remains in the React Query cache (including a fetch still in flight), pending mutations are discarded, the public `health` entry is kept, and a same-identity refresh keeps its cache |
| 1C.2 — **IMPLEMENTED; CLOSED (PASS, `19085bb` + `b505ff7`):** `apps/api/test/session-policy.sec-spec.ts` (50 cases after the review remediation and the `users.reactivate` remediation; `AUTH_MAX_SESSIONS_PER_USER=3` for the file): A cap — oldest live session evicted with reason `session_limit_exceeded`, audited, dead on its next request and refresh; revoked, expired and rotated sessions not counted; `created_at`-then-`id` tie-break; six concurrent logins × 3 rounds never exceed the cap, 15 evictions each audited once. B own sessions — `GET /auth/sessions` lists live sessions only and keeps history; `DELETE /auth/sessions/:id` revokes the whole rotation chain (an id listed before a refresh still signs the device out) with a transactional `acc_auth` `session.revoked` row — **the Phase 1B defect (a `500` that revoked nothing) is corrected and covered**; repeat and foreign ids `404`, byte-identical; revoke-all keeps the current chain, returns the live count, is audited, refuses an API key. E refresh — revoked, expired, forged and replayed tokens refused; replay kills the chain. F logout — an expired access token plus a valid cookie revokes the chain (F-12); unknown/already-revoked cookies get the same `204` with the cookie cleared and no audit; `X-Acc-Refresh` required (`403`), no credential `401`; the cookie path is throttled by the refresh bucket; the bearer path revokes a refreshed successor. G concurrency — refresh racing chain revocation, self revoke-all and administrator revoke-all never leaves a usable successor; logins racing every revocation kind keep the cap with no `5xx`; user disable racing that user's logins neither deadlocks nor leaves a live session. C F-9 — organization, workspace and team targets fully covered (list, revoke-all, single revoke, audited at the administrator's organization); a target with a grant in another organization, at a reseller or at platform is an audited `403` on all three routes, nothing revoked, no foreign id in the denial row; cross-reseller `404`; super admin covers all; support lists but cannot revoke; `reseller_admin`, workspace- and team-scoped session roles refused; API key may list, never revoke. D forged `X-Acc-Organization` `403`, query `orgId` inert, a stale context (grant removed, token still valid) confers nothing. H `acc_auth` may write exactly `session.revoked`/`session.revoked_all` at platform scope and none of 11 other sensitive/lifecycle/role/key/administrative actions, nor a session action at tenant scope; a failed audit write leaves the session live; a failure after the write rolls both back; an eviction whose audit fails aborts the login; no audit row carries a credential. L suspended organization: members keep self-service session control; administrator routes follow F-4/F-5. **Review remediation:** M-2 `users.disable` under F-9 — an organization administrator disables a user holding only that organization's grants; a target holding another organization's organization, workspace or team grant is refused with a `403` whose `authorization.denied` row is committed before the response (no foreign ids), status and every session byte-identical, no `user.disabled` row; a platform administrator disables a multi-organization user; an audit failure leaves status and sessions untouched. G2 deterministic serialization — the user's lock is held on a separate connection with the other half of the race staged inside that transaction, the real request is proven from `pg_locks` to be queued behind that advisory lock and unsettled, then the holder commits and the final state is asserted: administrator revoke-all vs an in-flight rotation (the successor is revoked), refresh vs an in-flight chain revocation (`401`, nothing minted), login vs an in-flight rotation at the cap (live count stays exactly at the cap; the oldest *live* session is evicted). `user-lifecycle-concurrency.sec-spec.ts` (19 cases): the last-platform-admin cases now use platform administrators as actors, because M-2 makes an organization administrator unable to disable one — which a new case asserts (audited `403`); the invariant proven is unchanged, and the mixed disable-vs-grant-revocation race now has two genuine contenders. Also: `audit-writer.spec.ts` (overlap pinned to the two actions; refused without a transaction), `audit-writer.int-spec.ts` (acc_auth routing only inside a transaction; rollback removes the row), route coverage 46 scoped / 7 exempt / 21 deferred, migration `0013` verified from an empty database (seeded; DB integration green) and on the test database. **Mutations executed and caught** (session suite): acc_auth allowlist returns true (1 failed); `session.revoked` removed from the allowlist (17); session audit on an independent connection (7); audit failure swallowed (2); live filter removed (2); chain revocation reduced to one row (2); per-user lock removed (caught 5/5 runs, 1–2 failed each); eviction removed (4); F-9 reduced to same-organization (2); client organization trusted (1); revoke-all drops the current session (2); expired-token logout path removed (2); F-9 denial not audited (1). The advisory lock removed from login alone was an equivalent mutant for login-vs-login (logins are also serialized by the conditional `users`-row update); since the remediation it is **caught deterministically** by G2-B, which stages the login-vs-rotation race only the advisory lock serializes. **Remediation mutations** (session + user-lifecycle suites, 64 cases): `users.disable` coverage removed — back to same-organization-only (2 failed); shared F-9 helper reduced to same-organization grants (4); per-user lock removed (5, including all three G2 cases); login's advisory lock alone removed (1, G2-B). **`users.reactivate` remediation** (group R — an organization administrator refused for a user also in another organization, with status, credential, sessions, sign-in and the target's other-organization API key all unchanged and the denial audited generically; refused for a disabled platform administrator; missing permission refused as before; a fully covered user still reactivated without session resurrection; a platform administrator reactivates the multi-organization user and its key works again). Mutations (69 cases): coverage check removed from reactivate (3 failed); coverage reduced to same-organization grants (7); caller-selected organization trusted instead of the target's grant set (7); denial swallowed into a successful reactivation (3); F-9 denial audit removed (4). | Session cap never exceeded under concurrent logins on independent connections; oldest eligible session evicted and audited; self revoke-all keeps the current session; administrator revocation refused whenever the target holds any grant the administrator does not cover (other organization, reseller, platform); expired-access-token logout via cookie + `X-Acc-Refresh`; cookie path without the header refused; unknown cookie `204` |
| 1C.6 — **IMPLEMENTED; CLOSED (PASS, `7ab1b88` → `8f0c8c4` → `4f3e4cc` → `f49ce0f`):** `apps/api/test/database-integrity.sec-spec.ts` (52 cases: 26 at `7ab1b88`, 5 in G and 9 in H for migration `0015`, 8 in I for migration `0016`, 4 in J for migration `0017`). **A** composite FKs — owner and `acc_app` may bind a same-organization workspace or none, a workspace of another organization is `23503 api_keys_workspace_org_fk` / `ws_tickets_workspace_org_fk`, a rewrite from either side (child `org_id`/`workspace_id`, parent `workspaces.org_id`) is refused. **B** `allowed_scope_types` — owner and `acc_app` inserts and updates at a non-admitted scope are `23514 user_roles_scope_type_admitted`; platform roles enforced uniformly; the API still answers `422` first. **C** `reseller_id` — reseller and organization writers refused (`42501 organizations_reseller_id_immutable`) while a name update still succeeds; a forged platform claim refused; the validated platform administrator and the owner allowed; `PATCH /organizations/:id` with `resellerId` `400`. **D** narrowing — `PATCH /roles/:id` past a grant is `409` with `details.scopeTypesInUse`, role and grants unchanged; a non-stranding narrowing, widening and renaming succeed; owner and `acc_app` direct narrowing (including a seeded system role) refused; after revoking the grant the same narrowing succeeds. **E** backfill — the migration's own first statement passes on the clean database and, for each invariant, raises a message naming it with the count and the offending id. **F** deterministic concurrency — both grant/narrowing orders, narrowing vs a direct grant mutation, direct SQL on both sides, FK child-first and parent-first. Fixture: the harness role admits `organization`/`workspace`/`team` (§14.3, test-only); the liveness test's expected message changed (§14.2). Migration `0014` verified from an empty database, re-run as a no-op, on the test database, and on a deliberately bad copy (it failed with the invariant, count and id, and left nothing applied, first for the key and then for the grant). **Review remediation (H-1/H-2, migration `0015`).** **G** trigger-only SECURITY DEFINER functions: `has_function_privilege` is false for PUBLIC, `acc_app`, `acc_auth` and `acc_relay` on all three; a direct call is `42501` for each principal; none can attach any of the three to a temporary table of its own (`42501`); the review's temp-table attack, run as `acc_app` inside another organization, discloses none of the victim's organization id, workspace id, role id or grant scope type, and holds no lock on the victim's role row (the owner's `FOR UPDATE NOWAIT` succeeds); the real triggers still admit, derive `org_id`, refuse and guard for `acc_app`, which holds no `EXECUTE`. **H** isolation: at READ COMMITTED, a non-stranding narrowing succeeds and a stranding one is refused for owner and `acc_app`, a grant committed after the narrowing transaction began is still seen, and a direct grant racing a held direct narrowing waits and is then refused. At REPEATABLE READ and at SERIALIZABLE, for owner and `acc_app`: any narrowing, even one that strands nothing, is refused (`25000`, `roles_allowed_scope_types_narrowing_isolation`), with the role, every grant and the stranded count unchanged; the review's attack (a grant committed after the snapshot, then a narrowing past it) is refused and strands nothing; widening is still allowed; a grant after a committed narrowing fails with `40001`. `tenant-context-trust.int-spec.ts` D now accepts either refusal of a direct call (`42501` or `0A000`), and adds three cases, now covering all nine SECURITY DEFINER trigger functions: no `EXECUTE` for PUBLIC or any application principal, no temporary-table attachment, and the trigger-only list equal to the complete set of SECURITY DEFINER trigger functions, so a new one fails until it is listed and revoked. Migration `0015` was verified from an empty database (re-run a no-op, hashes 16/16), on the test database, and on a clone before and after (the temp-table attack succeeded before and was refused after). A bad-fixture copy at `0013` failed at `0014`'s verification with nothing from `0014` or `0015` applied, then migrated cleanly once the row was removed.

**Mutations executed and caught — on isolated databases.** Each mutant ran on its own `CREATE DATABASE c6_mut TEMPLATE acc_gateb` clone, with every `DATABASE_*_URL` pointed at the clone. The clone was dropped `WITH (FORCE)` after the run and verified gone. The canonical database was never mutated: its catalog, ACL, journal, row-count and stranded-grant fingerprint was identical before and after, and mutated source files were restored byte-identical. Suites: `database-integrity.sec-spec.ts` (40) and `tenant-context-trust.int-spec.ts` (17). Baseline on a clone: 40/40 and 17/17. Failed-test counts are given as integrity/trust:
- M1, both composite FKs dropped: 6/0.
- M2, `fn_validate_user_role_scope` restored to its pre-`0014` body: 11/0.
- M3, reseller trigger dropped: 4/0.
- M4a, narrowing trigger dropped: 9/0.
- M4b, API narrowing pre-check removed: 2/0. The database guard still refuses and maps to the same `409`; M4b fails only on the missing `details.scopeTypesInUse`, so it shows the pre-check is exercised, not API-only protection.
- M4c, both removed: 15/0.
- M5, one `0014` backfill `RAISE EXCEPTION` → `RAISE NOTICE` (the migration file, restored): 1/0.
- M6, isolation guard removed: 4/0.
- M7a, isolation check weakened to SERIALIZABLE only: 2/0, the REPEATABLE READ cases.
- M7b, isolation check weakened to REPEATABLE READ only: 2/0, the SERIALIZABLE cases.
- M8a–M8c, PUBLIC `EXECUTE` restored on each function in turn: 5/3, 5/3 and 4/3.
- M9, all three revocations removed: 5/3.
- M10, `EXECUTE` granted to `acc_app` alone, re-enabling the temp-table attack: 5/2.
- M11, `FOR SHARE` removed from the grant trigger (lock only): 7/0, the concurrency cases.

**Review remediation H-3 (migration `0016`).** Group **I**:
- For each of the six pre-existing SECURITY DEFINER trigger functions, the owner and SECURITY DEFINER status are unchanged, and `has_function_privilege` is false for PUBLIC, `acc_app`, `acc_auth` and `acc_relay`.
- A direct call is `42501` and a temporary-table attachment is `42501` for every application principal.
- The six attacks demonstrated before `0016` are no longer reachable: attachment is refused with no identifier in the error; without the trigger, the caller's own row derives nothing; no advisory lock is taken.
- Every trigger that uses them still fires, with its existing behaviour, for a principal that holds no `EXECUTE`:
  - `trg_audit_logs_validate_scope` derives `org_id`/`workspace_id`/`team_id`, refuses a missing scope (`23503`), and lets RLS refuse another organization's scope, as `acc_app`; as `acc_auth` it admits a platform row and refuses a platform row carrying a `scope_id`.
  - `trg_role_permissions_validate` derives `org_id` and refuses a platform permission on a tenant role.
  - `trg_role_permissions_protect_system` refuses adding to or removing from a system role's permission set.
  - `trg_roles_protect_system` refuses modifying or deleting a system role, and allows a custom role.
  - `trg_users_platform_admin_liveness`, `trg_user_roles_platform_admin_liveness` and `trg_user_roles_platform_admin_liveness_update` admit a non-administrator's disable and the removal of other super-admin grants, then refuse with `23001` disabling the last administrator, deleting the last grant, and moving it to another role.

Migration `0016` was verified on a clone before and after (all six attachments succeeded before and were refused after), then applied to the test database (hashes 17/17, re-run a no-op). **Mutations on disposable clones** (integrity 48 / trust 17): M12a–M12f, PUBLIC `EXECUTE` restored on each of the six in turn: 8/3 each; M13, all six revocations removed: 8/3; M14, `EXECUTE` granted to `acc_app` alone on the two disclosing functions: 8/2. The per-function detection comes from the ACL, direct-call and attachment cases, which iterate every function; the trigger cases also fail because they assert that none of the six is executable. The canonical fingerprint was identical before and after, and every clone was dropped.

**Review remediation H-4 (migration `0017`).** Group **J**:
- `fn_assert_platform_admin_remains()` keeps its owner, SECURITY DEFINER status and `void` return type, and `has_function_privilege` is false for PUBLIC, `acc_app`, `acc_auth` and `acc_relay`.
- A direct call is `42501` for every application principal.
- `acc_app` cannot name it in `CREATE TRIGGER` (`42501`). An invoker trigger function of its own in `pg_temp` that calls it is refused when it fires (`42501`, permission denied).
- Its triggers still invoke it, through `acc_app`, which holds no `EXECUTE`. Removing a non-last administrator's grant, reassigning it to another role, and disabling a non-last administrator are allowed. Disabling the last administrator, deleting the last grant, and reassigning it are each refused with `23001`.

The Gate B liveness suites (`platform-admin-liveness.sec-spec.ts`, `user-lifecycle-concurrency.sec-spec.ts`) are unchanged and green. The probe on clones showed a direct call ran for all three principals before `0017` and was `42501` after. **Mutations on disposable clones** (integrity 52 / trust 17): M15, PUBLIC `EXECUTE` restored: 4/0; M16, `EXECUTE` granted to `acc_app` alone: 4/0. The canonical fingerprint was identical before and after, and every clone was dropped.

**Gate C.6 closure regression (final, at `f49ce0f`).**
- API unit 300/300, API integration 124/124, API security 855/855.
- DB unit 4/4, DB integration 136/136.
- Web unit 161/161, web security 87/87.
- No skipped tests. Typecheck, lint and build pass.
- Dependency audit: no unaccepted high or critical advisories.
- Schema drift clean.
- Empty-database bootstrap: 18/18 migration hashes; re-running the migrator is a no-op.
- The last-platform-admin liveness suites pass 55/55.
- `format:check` is clean for every non-frontend file; the repository-wide check still reports 60 existing `apps/web` files.
- Mutation tests ran only on disposable database clones. The canonical test database was never left mutated: its catalog matches a fresh `0000`–`0017` bootstrap, and it holds 0 stranded grants.

**Pre-existing test-quality residual (retained, not fixed).** `audit-read.sec-spec.ts` case 14 ("walks every row exactly once, newest first") can fail when its four planted rows fall in the same millisecond. Rows are ordered by `id`, and the database's `uuidv7()` is not monotonic within a millisecond (989 of 2,000 same-call pairs were out of order when measured). The case dates from Gate B, is unrelated to migrations `0014`–`0017`, and passed on reruns.

The `7ab1b88` report's M4c run, by contrast, committed a stranded grant into the canonical test database for one run; that is no longer possible with this runner. | Each new constraint and trigger proven with the service bypassed (owner and `acc_app` writers as appropriate); migration verified on empty and on the Gate-B database; backfill failure mode demonstrated on a deliberately bad fixture; `allowed_scope_types` fixtures reworked so no test grants a role at a scope it does not admit |
| 1C.3 — **IMPLEMENTED; CLOSED (PASS, `03de8c0` … `3f9a77f`, checkpoint `bbbc72c`):** `apps/api/test/openapi-access.sec-spec.ts` (33), `openapi-contract.sec-spec.ts` (17), `openapi-responses.sec-spec.ts` (19), `src/openapi/openapi-mode.spec.ts` (unit, 12). **Access** (real bootstrap, per environment): development plus flag serves a public document and a UI whose page and initializer never contain the document; test, staging and production plus flag serve the document to a signed-in user session only, through the ordinary pipeline (correlation, general limiter, `Cache-Control: no-store`); no credential, a malformed, expired or revoked token and a disabled user are `401`; an API key is `403`; no refusal body carries the document; 16 alternate URLs (case, trailing-slash and encoded variants, `-json`, `-yaml`, both init scripts, prefix-less copies) and every UI asset are unknown routes; other methods are unknown routes; flag off means no route at all in development, test, staging or production. Each boot also asserts the configuration the application runs on (`appEnv`, `isProduction`, the OpenAPI mode) and the documentation paths in the Express route table itself: none when off, only `/api/v1/openapi.json` when protected. **Production** boots through the same `createApp()` with `APP_ENV=production` and `NODE_ENV=production`, with one test-only substitution at configuration validation. The real `validateEnv` must refuse that environment for exactly `SECRETS_BACKEND=env` and `DATABASE_SSL=false`, which a test host cannot satisfy, and every other production rule (https-only CORS, `LOG_PRETTY=false`, explicit `TRUSTED_PROXY_HOPS`) must pass; any other or missing problem fails the boot. **Contract:** the served document (ts-jest path) is byte-identical to the committed snapshot the CLI (`tsc` path) generates, so the two paths are equivalent; the plugin is absent from `nest-cli.json` and the committed metadata is loaded; routes and operations match in both directions, with exact totals: the module graph's 60 controller handler routes (one per method and path, with no middleware or framework routes) are 58 application operations (including the three health routes), plus the document operation `GET /api/v1/openapi.json`, plus `GET /metrics`, the sole exclusion. The document therefore has exactly 59 operations, equal as a set to the 58 + 1. The Express route table's single-handler routes equal the discovered handlers, so no route exists outside the controller graph, and there is no other exclusion metadata; operation ids are the handlers'; `@AcceptedCredentials` is consistent with `@Public` and equals each operation's `security`; the schemes match the wire protocol; error responses follow each posture; `X-Acc-Organization` and `X-Acc-Refresh` appear exactly where the runtime resolves or enforces them; `Idempotency-Key` appears exactly on the 7 handlers that read it; every body and query DTO matches its class-validator rules (this caught plugin gaps: `@Matches` patterns, `@IsIn` enums narrower than the TypeScript union, integer page limit); every `$ref` resolves; the error-code enum is complete. **Responses:** every operation succeeds with every credential its document declares, and every response is validated (documented status, closed schema, required headers); an API key never succeeds on a user-session-only operation; error sweeps cover every operation (no credential, malformed id, unknown id, unknown body field or query parameter, unprivileged principal), plus lifecycle `409`, idempotency replay, mismatch `422` and invalid key `400`, admissibility `422`, CSRF `403`, media type `415`, and `429` from each limiter. It corrected three documentation errors, with the runtime unchanged: an idempotency mismatch is `422`, a created key's `secret` is the secret half, and an API key's grant `roleId` is `api_key:<id>`. **Mutations executed and caught** (16). Each mutant was a temporary source edit, restored byte-identical and verified. The first execution ran on the canonical test database. A run that fails or is interrupted skips its teardown, and it left 22 authentication audit rows that then failed `packages/db` `audit.int-spec.ts` (DECISIONS 1C.3 residual 7). The mutants were therefore re-executed as described below. Failed-test counts are per suite:
Re-executed after the remediation, each mutant on its own disposable clone (below); counts are access/contract/responses/mode:
- M1, protected handler admits any principal: 3/0/2/0.
- M2, document route made `@Public`: 9/2/3/0.
- M3, `SwaggerModule.setup` re-added: 20/1/0/0.
- M4, canonical-path middleware removed: 4/0/0/0.
- M5, development initializer embeds the document: 1/0/0/0.
- M6, development UI mounted outside development: 6/1/0/0.
- M7, development exception widened to staging: 5/0/0/1.
- M8, `@ApiExcludeEndpoint` on a route: 0/9/1/0.
- M9, DTO constraint changed without regenerating: 0/1/0/0, and `openapi:check` exits 1.
- M10, user-session-only route declared as accepting API keys: 0/1/1/0.
- M11, stale snapshot: 0/1/0/0, and `openapi:check` exits 1.
- M12, an operation stops documenting `401`: 0/2/1/0.
- M13, response schema drift: 0/1/1/0.
- M14, the CLI drift check forced to pass with a stale snapshot: the CLI wrongly exits 0, but contract fails 1, so the snapshot gate is not the only defence.
- M15, `X-Acc-Organization` on `@NoTenantContext` routes: 0/2/0/0.
- M16, `Idempotency-Key` removed from a handler that reads it: 0/2/0/0.
- P1, production resolves to the public development mode: 5/0/0/2.
- P2, production with the flag off still registers the protected route: 2/0/0/1.
- P3, the development UI mounted in production: 4/0/0/0.
- R1, an extra controller route (documented by the scanner): 0/4/4/0 (exact totals, snapshot), and `openapi:check` exits 1.
- R2, a route mounted directly on Express, outside the controller graph: 0/1/0/0 (the Express route-table reconciliation; the document is unchanged).
- R3, a phantom operation injected into the built document: 0/3/2/0.

**Isolation for mutation and other destructive runs.** `node scripts/with-db-clone.mjs -- <command>` runs the command against `CREATE DATABASE <template>_clone_<random> TEMPLATE <template>`, where the template is the database in `DATABASE_ADMIN_URL`. All four `DATABASE_*_URL` variables point at the clone, and the command runs in its own process group, which is reaped on exit. The runner prints the rows the command left behind, drops the clone `WITH (FORCE)` on every exit path and verifies it is gone. It fails if the template's per-table row counts changed. A run killed mid-suite (proven with `timeout -s KILL`) left 65 to 110 audit rows plus fixtures in its clone, none in the template. The DB audit suite then passed 58/58 on a fresh clone.

| Generated spec ⊇ route table and route table ⊇ spec; each route's security scheme matches its `@Public`/`@RequiresPermission`/`@AuthorizationExempt` declaration; integration request/response pairs validate against the spec; committed snapshot equals generated spec (CI); UI/JSON require authentication outside development (real-bootstrap test) |

**Mutations that must be executed and caught** (failing test names recorded): organization-status check removed; creation authority widened; lifecycle permission widened; `reseller_id` guard dropped; composite FK dropped; `allowed_scope_types` removed from the trigger; session cap removed; eviction made non-atomic; cross-scope administrator revocation allowed; logout CSRF requirement removed; spec drift introduced.

**Regression:** the 1,215 Gate-B tests stay green and unweakened (any changed expectation recorded with its reason), including `principals`, `shared-reseller`, `tenant-context-trust` and `workspace-team-boundary`.

### 6r. Phase 1C.4a — development/test fixture (IMPLEMENTED and CLOSED; Gate C.4a PASS, 30-Sep-2026, checkpoint `91607aa`)

**Purpose.** One idempotent command that builds the §6p topology on a development or test database through the real application paths, so the browser suite (1C.4b) and manual testing have organizations, users and grants that exercise authorization rather than an empty console. The fixture is itself a security test asset: `apps/api/test/dev-fixture.sec-spec.ts` proves that what it builds is isolated. **It must never be run against staging or production; it refuses to.**

**Command.**

```
npm run fixture:dev --workspace @acc/api      # builds apps/api, then runs dist/cli/dev-fixture.js
```

It runs from the compiled output because it boots the real Nest application, whose dependency injection needs the decorator metadata `tsx` does not emit. stdout carries only a JSON manifest (ids, slugs, emails, grant keys, the fingerprints and the *name* of the password reference); progress goes to stderr. Exit status 0 on success or no-op, 1 on any refusal.

**Topology** (natural keys; ids are whatever the database assigns). Five scopes, unchanged: PLATFORM → RESELLER → ORGANIZATION → WORKSPACE → TEAM.

| Object | Natural key | Parent |
|---|---|---|
| Reseller A | `alendei-direct` — the seeded platform-default reseller (not created by the fixture) | platform |
| Reseller B | `acc-fixture-reseller-b`, "ACC Fixture Reseller B" | platform |
| Organization A1, A2 | `acc-fixture-a1`, `acc-fixture-a2` | Reseller A |
| Organization B1 | `acc-fixture-b1` | Reseller B |
| Default workspace | `default` in each organization (created with the organization, ADR-012 F-3) | its organization |
| Team T | "ACC Fixture Team" + a harmless markup payload, in A1's default workspace | A1 / `default` |

| User | Grants |
|---|---|
| `a1-admin@acc-fixture.test` | `org_admin` at organization A1 |
| `a2-admin@acc-fixture.test` | `org_admin` at organization A2 |
| `b1-admin@acc-fixture.test` | `org_admin` at organization B1 |
| `a1-team-reader@acc-fixture.test` | `read_only` at team T (the low-privilege user) |
| `multi-org@acc-fixture.test` | `workspace_manager` at organization A1 **and** at organization A2 |

No fixture user holds a platform or reseller grant. The markup payload (`<img src=x onerror="window.__accFixtureMarkup=1"><script>window.__accFixtureMarkup=1</script>`) only sets a global flag and references nothing external; the `team.created` audit row that carries it in `after.name` is written by `POST /teams`.

**Inputs.** Passwords arrive only as `SecretsPort` references (`env:` backend, the adapter's 32-character minimum applies). There is no default, no generated value, and nothing is printed, logged or written to a file.

| Variable | Meaning |
|---|---|
| `APP_ENV` | Must be `development` or `test`. Anything else — including unset, `staging`, or a different case — is refused before any connection is opened. There is no override, confirmation or force flag. `NODE_ENV=production` is refused as well. |
| `DATABASE_ADMIN_URL` | The schema owner; used for read-only inspection and the owner-level exceptions below. The in-process API uses the ordinary `DATABASE_URL`/`DATABASE_AUTH_URL` principals. |
| `AUTH_BOOTSTRAP_EMAIL`, `AUTH_BOOTSTRAP_PASSWORD_REF` | The operator: the bootstrap platform administrator the fixture signs in as. Unchanged meaning (ADR-003 D-1). |
| `ACC_FIXTURE_USER_PASSWORD_REF` | Reference to the five fixture users' password (`.env.example`: `env:ACC_FIXTURE_USER_PASSWORD`, value left blank). Must differ from the operator's password. |

**Order of operations.** (1) environment gate and secret resolution; (2) read-only inspection as the owner — every fixture object is found by its natural key and checked; (3) if anything is missing or conflicting, stop; if nothing is missing, stop **as a no-op** — no write, no application boot, no sign-in, no session, no audit row; (4) otherwise: the platform bootstrap through the unchanged `runBootstrap` if no platform administrator exists; Reseller B; then organizations, the team, users and every grant through the real HTTP API of an in-process instance built by `createApp()` (the function `main.ts` uses), listening on an ephemeral loopback port, signed in once through `POST /auth/login` and signed out through `POST /auth/logout` even when a step fails; then credential activation; (5) verification by a fresh inspection plus the audit evidence. The in-process instance runs with the outbox relay off and logs limited to errors; nothing else about the application is changed. Every request carries `User-Agent: acc-dev-fixture/1 (Phase 1C.4a)` and one correlation id per run, which the real audit path stamps on every row the run causes.

**Owner-level writes.** Everything not listed here goes through the real API as the signed-in operator (`acc_app`/`acc_auth`): organizations with their system roles and default workspaces, the team, the users, all six fixture grants, their audit rows, the session and `users.last_login_at`. Planning and verification are owner-level **reads** only. The owner-level writes fall into two distinct groups.

*Existing bootstrap owner exception (ADR-003 D-1; unchanged; runs only when no platform administrator exists).* The fixture calls the committed `runBootstrap` without modification (the only edit to `bootstrap.ts` is exporting its audit-writer shim). As the schema owner, under its transaction-local `set_config('app.is_platform_admin', 'on', true)`, it writes:

| Write | Table / columns |
|---|---|
| Platform administrator creation (`UserLifecycleService.invite`) | `users`: `email`, `phone`, `status='invited'` |
| Platform administrator activation (`UserLifecycleService.activate`) | `users`: `password_hash`, `password_updated_at`, `status='active'`; `updated_at` by `trg_users_updated_at` |
| Platform role grant | `user_roles`: `alendei_super_admin` at `platform` scope for the operator — the only direct `user_roles` insert in the fixture's reach |
| Bootstrap audit records (`AuditWriter`, in the same transaction) | `audit_logs`: `user.invited` and `user_role.granted`, actor `system`/`platform_bootstrap`, `metadata.via='bootstrap-cli'` |

*Phase 1C.4a fixture owner exceptions (new; `apps/api/src/cli/dev-fixture/owner-operations.ts`).* Each is one short owner transaction that sets no tenant or platform session variable.

| Operation | Why no application path exists | Principal | Tables / columns | Audit |
|---|---|---|---|---|
| Create Reseller B | Reseller CRUD is deferred to Phase 9; no route, service or permission creates a reseller, and `seed.ts` creates only the platform default (and was not modified) | schema owner | `INSERT INTO resellers (name, slug)`; `id`, `status` (`active`), `is_platform_default` (`false`), `created_at`, `updated_at` take their defaults; only when the slug is absent, never an update | none — there is no reseller audit action, exactly as for the seeded reseller |
| Fixture-user activation | `POST /users` creates an `invited` identity with no credential, and D16 has not yet defined an application path by which an invited user establishes one | schema owner, through the unchanged `UserLifecycleService.activate` — the primitive the bootstrap CLI has used since Phase 1B.2 | `users`: the code sets `password_hash`, `password_updated_at` and `status` (`invited` → `active`); the existing `trg_users_updated_at` trigger additionally sets `updated_at`. No other column, no session, no grant | none — there is no activation audit action; the identity's creation is audited (`user.invited`) by the API |

**The D16 boundary.** Fixture-user activation is a development/test fixture-only exception, required solely because D16 has not yet defined an application credential-establishment path for invited users. It **does not implement or decide D16**: it adds no HTTP route, no user-facing activation mechanism, no credential delivery, no mail or token workflow, no production API behaviour and no change to `UserLifecycleService`. It applies only to `@acc-fixture.test` identities that are still `invited` and hold no credential (the row is locked and re-checked), in an owner-level transaction, in development or test only, and refuses — never overwrites — any conflicting credential or state. Fixture users' grants and audit rows are never written directly: no direct `user_roles` or `audit_logs` insert exists for them.

**Write-set proof.** A schema owner can forge an audit row, a grant or an identity that is byte-for-byte indistinguishable from one the application wrote, so database state alone cannot prove provenance against that principal (`SECURITY.md` §4a). The suite therefore pins the owner-level write set in source, and checks the result at runtime: (1) the fixture's own sources contain exactly one SQL write (`INSERT INTO resellers`) and exactly one lifecycle call (`activate`, in `owner-operations.ts`), no query-builder write, no `set_config`, no trigger or DDL statement and no audit write; (2) the fixture's import closure is pinned, and from `bootstrap.ts` it imports only `runBootstrap` and `ownerAuditWriter`, so no new writing helper can be added without failing; (3) `runBootstrap`'s write set is pinned — one `set_config` (`app.is_platform_admin`), one query-builder write (`insert userRoles`), no raw SQL write, lifecycle calls exactly `findByEmail`, `invite`, `activate`, exactly two audit records (`USER_INVITED`, `USER_ROLE_GRANTED`) — and `invite`/`activate` each write `users` once and nothing else; (4) at runtime the operator holds exactly one grant (`alendei_super_admin`, platform), exactly two `platform_bootstrap` audit rows exist, and the only other system-actor rows in the fixture's footprint are the 15 `role.created` rows `TenantRoleProvisioner` writes inside `POST /organizations`, each carrying the fixture user agent and the run's correlation id.

**Environment boundary and residual risk (accepted, F-3).** The fixture's environment gate validates the declared `APP_ENV`/`NODE_ENV`, not the provenance or intended environment of the database URL. An operator possessing production owner credentials could theoretically point a process declaring development/test at a production database. This is an operational credential/secret-management risk, not a fixture bypass in the application authorization model. There is no production override or force flag; `NODE_ENV=production` is explicitly rejected; the fixture has no HTTP route and is not imported by the application; production use is prohibited; and correct separation of development, test and production database credentials remains an operational requirement. No database-side production marker is added (decision, 30-Sep-2026).

**Idempotence and conflicts.** A creating run writes data by design; on a fresh database (no platform administrator yet) the first run changes exactly: `resellers` +1, `organizations` +3, `workspaces` +3, `teams` +1, `roles` +15, `role_permissions` +174, `users` +6 (five fixture users and the operator), `user_roles` +7 (six fixture grants through the API, one platform grant by the bootstrap), `sessions` +1 (revoked), `audit_logs` +37, plus in-place updates (the operator's `last_login_at`, the activations) — pinned by the suite. **A second (no-op) run against an already complete fixture leaves every table byte-identical to its state after the first completed run** (full-content hash of every table), with an identical manifest; it boots no application, signs in no one and writes no audit row. Identity is decided by natural key; UUIDs and Argon2 digests are not expected to match across databases, but the **logical fingerprint** (sha256 of the natural-key description) is pinned and is the same on every database. An existing object with the expected key but incompatible attributes is a conflict, and **any** conflict aborts the run with nothing written — the fixture never overwrites, renames, moves, re-parents, reactivates, revokes or re-credentials. Conflicts include: an organization under another reseller (for example B1 under Reseller A), a changed name or non-active status, a non-fixture organization under Reseller B, a missing default workspace, a duplicate or archived fixture team, a disabled fixture user, a fixture user whose credential does not match the configured reference, any grant on a fixture user beyond the expected set, an existing operator identity on an un-bootstrapped platform (bootstrap would overwrite its credential), and a platform bootstrapped with a different administrator. A partially built fixture (a run interrupted after some steps) is completed, because each missing object is created only through its normal path (by construction; the suite does not simulate an interruption); if audit evidence is missing the run fails verification and the fixture must be reset.

**Sessions (Phase 1C.2 model).** A creating run signs in once through `POST /auth/login` and signs out through `POST /auth/logout` (in a `finally`), so it leaves **one revoked session row, kept as a historical security record** — it is not a no-op mutation and is deliberately not deleted. A subsequent no-op run creates no session. No live fixture session remains after a completed run, and revoked rows do not count toward the live-session cap (`AUTH_MAX_SESSIONS_PER_USER` counts only live sessions); only if the operator already held the cap in live sessions would the sign-in evict its oldest, audited, as for any login. A process killed between sign-in and sign-out may leave one live session until it expires — an operational failure mode, not intended fixture behaviour. The sign-in and sign-out each write their normal audit row (`auth.login.succeeded`, `auth.logout`, platform-level, carrying the run's correlation id).

**Reset / removal.** There is deliberately no fixture reset command. On a development database: `npm run db:reset` (itself refused outside `development`/`test`; drops and rebuilds the schema, migrates and seeds), then `npm run fixture:dev --workspace @acc/api`, which also performs the platform bootstrap. On test databases, run through `node scripts/with-db-clone.mjs -- …` so the clone is dropped afterwards; `dev-fixture.sec-spec.ts` itself removes everything it created, by natural key, in `afterAll`, and refuses to start on a database that already holds any fixture object or a platform administrator, so it can never adopt or delete a developer's fixture.

**Use by the browser suite (Phase 1C.4b — IMPLEMENTED and CLOSED, Gate C.4b PASS; checkpoint `4e7effd`).** The corrected E2E-06/07/08/10/11/12 and E2E-09 run against this fixture: sign in as the manifest's users with the password behind `ACC_FIXTURE_USER_PASSWORD_REF`; E2E-09 renders `AuditLogDetailDialog` for the `team.created` row of team T and asserts `window.__accFixtureMarkup` stays unset; E2E-11 uses `a1-team-reader`; E2E-10 and the multi-organization cases use `multi-org`. See §6s for full execution and mutation evidence.

**Suite: `apps/api/test/dev-fixture.sec-spec.ts` (57 cases)** — **A** the real CLI refuses `APP_ENV` `production`, `staging`, `prod`, `Development` and `""` with nothing written and nothing on stdout; unset `APP_ENV` and `NODE_ENV=production` refused; a missing, empty, unresolvable, short or non-`env` password reference, a non-`env` `SECRETS_BACKEND`, a missing operator email or reference, and a fixture password equal to the operator's are all refused with every table unchanged, and no refusal prints a secret. **B** B1 pre-planted under Reseller A is refused before anything — including the bootstrap — is written. **C** the first run completes (a failed run is recorded rather than thrown, so every invariant below is still asserted against what it left behind); its per-table row deltas are exactly the documented set; the manifest's logical fingerprint equals the pinned constant; the natural-key topology, users and grants are exactly as tabled; parent/child and reseller ownership checked by id; every role granted belongs to the grant's organization; looked up by natural key (`@acc-fixture.test`) independently of the run's outcome and manifest, no fixture user holds a platform or reseller grant or any platform-level role, and the only platform-role grant in the database is the operator's `alendei_super_admin`; every fixture user signs in through the real login with the configured password, and none with any known default string in the repository or the operator's password; the operator's only session is revoked; no output contains a password or digest. **D** a second in-process run is `unchanged` with every table byte-identical; the real CLI's third run exits 0 with a parseable manifest and nothing changed. **E** the operator signed in once and out once; each organization, the team and each user has exactly one creation audit row with the operator as actor, the fixture user agent, `127.0.0.1` and the run's correlation id; each of the six grants has exactly one `user_role.granted` row from that chain at the grant's scope; every organization has audit rows at its own scope; the markup row is at team scope in A1 with exactly the `after` the team service writes, is readable by A1's administrator through `GET /audit-logs/:id` and `404` for A2 and B1; fixture-caused rows outside `auth.*` are all at organization/workspace/team scope in a fixture organization; the owner-level write-set proof above (fixture write set, pinned import closure, `runBootstrap` and lifecycle write sets, and the runtime bootstrap footprint). **F** for each of the three administrators: selecting either other organization is `403 TENANCY_CONTEXT_MISMATCH`; `GET /organizations`, `/workspaces`, `/teams`, `/users`, `/roles`, `/role-assignments` and `/audit-logs` (every page) enumerate none of the other organizations' objects while listing their own (positive control); detail reads of the other organizations' objects are `404` (same reseller and across resellers). **G** the team reader is refused nine administrative operations (`403`/`404`) with no tenant, identity or grant table changed and the denials audited; the multi-organization user must choose (`400 TENANCY_CONTEXT_REQUIRED`), can list and create teams in A1 and A2, and is `403` for B1; an organization administrator cannot grant itself a platform role (`400`, platform unrepresentable), a platform role at organization scope, or a role in A2, nor create a user with a platform grant — no grant row changes. **H** through the application's own `TenantDatabase.withTenant` — the `acc_app` pool (`APP_POOL`, checked at start-up by `assertRlsBoundPrincipal`) and the same transaction-local tenant context every request sets — plain SQL with no tenant predicate over `organizations`, `workspaces`, `teams`, `roles`, `user_roles` and `audit_logs` shows only that administrator's organization. The test constructs each administrator's `TenantSession` directly (the correct context for a single-organization administrator); `ScopeResolver`'s derivation of that context is covered by `shared-reseller-isolation.sec-spec.ts` and the other §6o suites, not duplicated here; the privilege map of `acc_app`/`acc_auth`/`acc_relay` (table grants, role attributes, memberships) is identical before and after; no route in the Express table matches `fixture|bootstrap|seed`, `POST` to such paths is `404`, and no module outside `src/cli` imports the CLI. **I** on the complete fixture, each of these is refused with every table unchanged, then restored: B1 moved under Reseller A, Reseller B renamed, a non-fixture organization under Reseller B, A2 suspended, an extra grant on A1's administrator, B1's administrator disabled, a different password reference, a different operator; afterwards a run is again a no-op.

**Mutation proofs** (30-Sep-2026, second round after the write-set remediation; 15 mutants, each on its own disposable clone via `scripts/with-db-clone.mjs`, every clone dropped, the template unchanged, the source restored and hash-verified after each). Failing cases out of 57, with the primary detector and whether detection is runtime, static or both:
- M1, environment gate removed: 9 — the five CLI `APP_ENV` refusals and the unset/`NODE_ENV` case (runtime).
- M2a, a default password when the reference is missing: 41 — the missing-reference refusal, then everything built on the default (runtime).
- M2b, a hard-coded default password: 20 — real login with the configured password, and the credential-mismatch refusal (runtime).
- M3, a fixture grant widened to platform (`alendei_support`): 39 — the dedicated natural-key invariant fails naming every offending grant, alongside the run's own refusal (runtime).
- M3b, the same widening with the fixture's own final check removed, so the run completes: 23 — the dedicated invariant still fails on its own assertion, naming every offending grant (runtime).
- M4a, conflict protection removed: 15 — B and the I refusals (runtime).
- M4b, existence check removed (non-idempotent creation): 42 — the first run cannot verify, the second hits `409` (runtime).
- M4c, a mismatched credential overwritten instead of refused: 2 — the changed-reference refusal and the final no-op (runtime).
- M5, B1 placed under Reseller A: 6 — pinned logical fingerprint, topology, reseller ownership (runtime).
- M6a, `POST /teams` replaced by direct `teams` + `audit_logs` inserts forging actor, user agent, IP, correlation id and `after`: 1 — the fixture write-set proof (**static, by design**). A schema owner can forge an audit row byte-for-byte indistinguishable from a legitimate one, so database state alone cannot prove provenance against that owner (`SECURITY.md` §4a); M6a is therefore correctly a source/write-set proof and is not weakened into a runtime test.
- M6b, the same bypass with an ordinary direct audit row: 4 — request-chain provenance, exact `after`, the runtime bootstrap-footprint check, and the write-set proof (**runtime and static**): the runtime proof against the ordinary direct-insert bypass.
- M7, `POST /role-assignments` replaced by a direct `user_roles` insert: 3 — no `user_role.granted` row for the grant, the row-delta pin, and the write-set proof (runtime and static).
- M8a, the fixture gains a direct `users` write: 1 — fixture write-set proof (static; the write is otherwise invisible in state).
- M8b, the fixture imports a new service that could write: 1 — pinned import closure (static).
- M8c, `runBootstrap` gains a `users` write: 1 — bootstrap write-set proof (static).

### 6s. Phase 1C.4b — frontend E2E corrections and security verification (IMPLEMENTED and CLOSED; Gate C.4b PASS, 01-Oct-2026, checkpoint `4e7effd`)

**Purpose.** Correct the `apps/web/e2e` browser test suite against the deterministic Phase 1C.4a fixture (`TESTING.md` §6r) to eliminate vacuous assertions, skips, and false positives, providing full browser-level security and authorization proofs (`apps/web/README.md`).

**Files modified:** Strictly four frontend files:
- `apps/web/e2e/helpers/auth.ts`: added `assertExactSecretNotInStorage(page, secret)` sweeping URL, `localStorage`, `sessionStorage`, `document.cookie`, `window.history.state`, `IndexedDB`, and `CacheStorage`; added `Set` snapshot comparator for React 18/19 `useSyncExternalStore`.
- `apps/web/e2e/security-storage-payloads.spec.ts`: updated `E2E-08` with dual-stage exact-secret storage assertion (dialog open and post-dismissal); updated `E2E-09` to filter by `team.created` action key before inspecting planted XSS markup.
- `apps/web/e2e/tenancy-navigation.spec.ts`: corrected `E2E-06` multi-org switching with `OrgSelectionView` client navigation; updated `E2E-07` navigation across all console routes; updated `E2E-10` with network observation of `X-Acc-Organization` and backend refusal (`403 TENANCY_CONTEXT_MISMATCH`) for unheld org header; updated `E2E-11` asserting network `403 AUTHZ_SCOPE_DENIED` and UI "Access Forbidden" boundary for team reader.
- `apps/web/README.md`: updated documentation of Phase 1C.4b test suite and verification requirements.

No backend, database, schema, migration, API contract, RBAC, RLS, or infrastructure files changed.

**Suite: `npm run test:e2e -w @acc/web` (12 cases, 28.2s execution time)**:
- **E2E-01**: Login establishes authenticated session through real UI form.
- **E2E-02**: Protected routes redirect unauthenticated visitors to `/login`.
- **E2E-03**: Authenticated identity does not expose tokens in URL or storage.
- **E2E-04**: Session continuity on reload via HttpOnly cookie isolation (`document.cookie` empty).
- **E2E-05**: Logout clears session and blocks console re-entry.
- **E2E-06**: Multi-organization selection (`OrgSelectionView`), console entry, and dynamic organization switching via header selector re-pinning `X-Acc-Organization`.
- **E2E-07**: Navigation across `/users`, `/roles`, `/workspaces`, `/teams`, `/api-keys`, `/audit-logs` confirming error-free boundary rendering, seeded resource visibility, and zero client-side crashes.
- **E2E-08**: API-key creation one-time secret display, with exhaustive plaintext exact-secret non-persistence check across all browser storage vectors.
- **E2E-09**: Safe audit payload text rendering inside `<pre>` for planted `team.created` markup-bearing row, proving zero `<script>` tag injection and `window.__accFixtureMarkup === undefined`.
- **E2E-10**: Tenant header integrity verification: positive control verifies legitimate `X-Acc-Organization` header dispatch; negative control proves backend returns `403 TENANCY_CONTEXT_MISMATCH` when forged with an unheld organization ID (`acc-fixture-b1`).
- **E2E-11**: Low-privilege authorization boundary proof: team-reader user receives network `403 AUTHZ_SCOPE_DENIED` on `/api/v1/audit-logs` and UI renders explicit "Access Forbidden" boundary with zero audit record disclosure.
- **E2E-12**: Full browser storage security sweep across all 8 console routes with dotted JWT regex matching (`^[\w-]+\.[\w-]+\.[\w-]+$`).

**Strengthened Exact-Secret Storage Proof (E2E-08).**
`assertExactSecretNotInStorage(page, secret)` verifies that the exact extracted plaintext secret string does not appear in:
1. URL pathname, search query parameters, or hash fragment.
2. `localStorage` keys or values.
3. `sessionStorage` keys or values.
4. `document.cookie` string.
5. `window.history.state` serialized structure.
6. `IndexedDB` database names, object store names, or stored record payloads (`getAll()`).
7. `CacheStorage` cache names, request URLs, or response body text payloads (`res.text()`).
Run both while the creation modal is open and after acknowledging and closing the dialog.

**Mutation Proofs (Explicitly Classified).**
- *Application-Behavior Mutations* (injecting real leaks/payloads and observing detector refusal):
  - **M1**: Injected dotted JWT into `localStorage` → caught by `assertNoTokensInStorage` (line 184).
  - **M2**: Injected `token_store` in `IndexedDB` → caught by `assertNoTokensInStorage` (line 208).
  - **M3**: Malicious script markup in audit payload → execution caught (`window.__accFixtureMarkup` set).
  - **M6a**: Exact secret string injected into `localStorage` (`acc_leaked_secret_test`) → `assertExactSecretNotInStorage` caught `localStorage value for key "acc_leaked_secret_test"`.
  - **M6b**: Exact secret string injected into `sessionStorage` (`acc_session_leak`) → `assertExactSecretNotInStorage` caught `sessionStorage value for key "acc_session_leak"`.
  - **M6c**: Exact secret string injected into `IndexedDB` (`acc_leak_test_db.secrets`) → `assertExactSecretNotInStorage` caught `IndexedDB [acc_leak_test_db.secrets] record contains secret`.
- *Assertion-Liveness Mutations* (mutating expected results to verify assertion sensitivity):
  - **M4**: Mutated expected forged header status in E2E-10 from 403 to 200 → test runner caught mismatch.
  - **M5**: Mutated expected low-privilege audit API status in E2E-11 from 403 to 200 → test runner caught mismatch.

**Regression Evidence.**
- Frontend unit tests: 161/161 passed.
- Frontend security tests: 87/87 passed.
- Typecheck: 0 errors (`tsc --noEmit`).
- Production build: clean Next.js Turbopack build (all 15 routes).

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

**Role administration (Phase 1B.5.4, `RBAC.md` §§7-8).** `apps/api/test/role-administration.sec-spec.ts` (46 cases), over real HTTP against real rows:

- **Reading** — an organization sees its own roles and the readable platform definitions, never another tenant's; `allowedScopeTypes` is exposed on every role; the permission catalogue is returned; a principal without `roles.read` is refused.
- **Creating** — key, name, `allowedScopeTypes` and the permission set persist; a duplicate key in the same organization is `409` while the same key in a different one is fine; malformed keys, unknown permissions and an empty `allowedScopeTypes` are `400`.
- **Composition authority** — a permission the actor does not hold at that organization is refused, on update as well as create, and nothing is created when it is. A `platform.*` permission on a tenant role is refused. A workspace-scoped principal cannot compose at the organization at all.
- **System-role protection, at both layers** — the service refuses update and delete of a tenant system role and of a platform role; and with the service bypassed entirely, migration `0004`'s triggers refuse the same mutation, refuse a system role's permission set being edited, and refuse a custom role being *promoted* into a system role.
- **Cross-tenant** — another organization's role is `404` rather than `403`, and a real foreign id is byte-for-byte indistinguishable from an unknown one apart from the correlation id; update and delete are `404` likewise; RLS returns zero rows with application authorization bypassed; the two tenants sit under different resellers.
- **§6n case 17** — a permission removed from a role through the administration API is denied on the **next request** with the same token, with a positive control before the removal, and the removal is audited as `role.updated`.
- **§6n case 18** — deletion while grants exist is `409` with the grants and the role intact; `ON DELETE RESTRICT` refuses it with the service bypassed; it succeeds once the grant is revoked; `role.deleted` is written only for the successful deletion. A concurrent grant-and-delete cannot both win, and no orphaned grant survives either way.
- **API keys** — a key whose scopes withhold role administration cannot reach the surface, however wide its creator.
- **Denial auditing still holds** — a refused role read writes `authorization.denied` carrying the actor's *own* workspace scope, not the organization it reached for (Phase 1B.5.3).
- **`TenantRoleProvisioner`** — seeds every canonical tenant role with its `allowedScopeTypes` and permission set; a second run creates nothing and writes **exactly** no further `role.created` rows; a caller failing *after* provisioning returned rolls the whole seeding back, audit rows included; it creates no organization; and `missingRoles` reports without writing.

**Not asserted here, deliberately:** §6n case 28. This phase gives `allowed_scope_types` its value; enforcing it at grant time is Phase 1B.5.5's, and there is no grant API to enforce it through yet.

**Role assignment (Phase 1B.5.5, `RBAC.md` §§7-8b).** `apps/api/test/role-assignment.sec-spec.ts` (47 cases), over real HTTP against real rows. It closes §6n cases 16, 21, 22, 26, 27, 28 and 29:

- **Granting within authority** — at the organization, at a child workspace and at a child team; listing with the `userId` filter; reading one by id.
- **§6n case 28** — a grant at a scope type the role does not admit is `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED` with the role's admitted levels in `details`, nothing is written, the admitted level is accepted as the positive control, and the refusal is asserted **not** to be `AUTHZ_SCOPE_DENIED` — the actor was entitled, so calling it a scope denial would misinform an administrator.
- **§6n cases 21, 22** — a role carrying a permission the actor lacks at that scope is refused; the same permission one level above the actor's grant is refused; a sibling workspace is refused. **Case 22b is the flattened-union discriminator**: an actor holding `role_assignments.grant` across the organization and `teams.create` in one workspace has `teams.create` in `principal.permissions` (asserted via `/auth/me`) and still may not confer it at the organization — only in the workspace where one coherent grant carries it. Same actor, same role, two scopes.
- **§6n case 27** — a self-grant within the actor's own authority is allowed and confers nothing new.
- **Cross-tenant and cross-reseller** — another organization's scope is `404` with no id echoed; a real foreign scope and a nonexistent one are byte-identical apart from the correlation id; another organization's role and another organization's assignment are both `404`.
- **Platform boundary** — a platform role is `403 AUTHZ_PLATFORM_ROLE_REQUIRED`; `platform` scope is `400`, unrepresentable in the DTO; **§6n case 26** re-asserts `fn_validate_user_role_scope` raising with the service bypassed.
- **§6n case 29 and revocation** — a duplicate is `409`; the same role at a different scope is not a duplicate; a repeated delete is `404`; revocation at a scope the actor does not cover is `403`.
- **§6n case 16** — a revoked grant is denied on the **next request** with the same token, with a permission-less second grant retained so the refusal is an authorization refusal rather than a lost tenant context.
- **Disabled and missing principals** — granting to a disabled user is `409`, to an unknown user `404`, an unknown role `404`; a disabled actor loses the surface entirely.
- **API-key binding scope** — a key without role-assignment scopes cannot list, read, grant or revoke; and a key whose creator is an organization admin can grant inside its binding but not outside it, whatever its creator holds elsewhere.
- **RLS backstop, service bypassed** — cross-organization reads return zero rows, a cross-organization insert is refused, a cross-organization delete removes nothing, and cross-reseller isolation holds.
- **Audit** — `user_role.granted` is written at the grant's own scope; `user_role.revoked` on revocation; a refused grant writes `authorization.denied` carrying the actor's *own* workspace scope; and with `AuditWriter` failing, the grant rolls back with its record.
- **Concurrency** — two identical concurrent grants yield exactly one `201` and one `409` with one row; a grant racing its role's deletion leaves no orphan; two concurrent revocations yield one `204` and one `404`; two concurrent escalation attempts both fail and write nothing.

**Not asserted here:** the last-platform-admin invariant on revocation — Phase 1B.5.6's, with the advisory-lock trigger that makes it hold under concurrency.

**Last-platform-admin invariant (Phase 1B.5.6, ADR-005 D-7, `RBAC.md` §7a).** `apps/api/test/platform-admin-liveness.sec-spec.ts` (27 cases). The suite clears every platform grant before it starts and between cases, so it owns the administrator population outright — reasoning about "the last administrator" against a floating baseline is how a liveness test comes to pass for the wrong reason.

- **The definition** — the advisory-lock constant in `@acc/db` and the function body are asserted equal, because a second key would silently disable the guarantee; both triggers are asserted present on the right tables; an `alendei_support` grant at platform scope counts and a `reseller_admin` grant at reseller scope does not; a disabled holder stops counting.
- **Through the API** — the last one is `409 AUTHZ_LAST_PLATFORM_ADMIN` and explicitly *not* `AUTHZ_SCOPE_DENIED`; removal succeeds while another remains; the second removal of a pair is refused; the refused attempt leaves the assignment intact and writes no `user_role.revoked` row; ordinary tenant revocation is untouched.
- **The database backstop, service bypassed** — the last grant's deletion, disabling the last holder, and deleting the last holder's user row through the cascade are each refused; disabling a non-administrator is allowed; path 4 stays closed; and `acc_app` cannot bypass it either.
- **Concurrency, six cases** — two concurrent removals of two different administrators when exactly two exist yield one `204` and one `409`; two concurrent removals of the same one yield `204` and `404`; a removal racing a disable; four concurrent removals against two administrators; and a removal racing a cascade delete. **Every one re-reads the database and asserts at least one administrator remains** — status codes alone would not show the invariant holding.
- **No bypass** — a tenant principal cannot reach a platform assignment, an API key cannot, and `acc_app` holds neither `rolsuper` nor `rolbypassrls`.
- **Rollback** — a refused revocation rolls back its assignment and its audit row together, and the advisory lock is released on rollback, so the next attempt is not blocked. A leaked lock would deadlock every subsequent platform-admin mutation, so that case would hang rather than fail.

**Route authorization coverage — §6n case 30 (Phase 1B.5.7).** `apps/api/test/route-authorization-coverage.sec-spec.ts` (8 cases). It builds its own application with `DiscoveryModule` and enumerates every registered controller method from Nest's own metadata — the container, not a hand-maintained list, because a list is the thing that goes stale and a stale list asserting nothing looks like coverage. Asserts: the enumeration is non-empty and contains known paths, so nothing passes vacuously; **no route is silent** (every one is public, scoped or exempt); no route declares two postures; the public set is exactly the allow-list; every exemption records a reason and lives on `AuthController`; every deferred target records why it cannot be static; every named permission is in the catalogue; and the posture counts are pinned — **23 routes: 12 scoped, 5 exempt, 6 public**, of which exactly 2 defer their target.

**Authorization coverage interceptor (Phase 1B.5.7).** `apps/api/test/authorization-coverage.sec-spec.ts` (8 cases), against `AuthorizationCoverageProbeController` — three deliberately-wrong handlers, following the precedent `AdvisoryProbeController` sets. The interceptor's purpose is to catch a handler that declares a permission and never checks it, which no production handler does, so writing the mistake on purpose is the only honest way to prove the mechanism fires. Asserts: a correct handler passes; one that declared and never checked fails closed with the body suppressed; one that checked a *different* permission than it declared also fails; the error names neither the route nor the permission; a genuine `403` is not converted into a `500`; and a route with no declaration is left alone.

**Self-only authorization view (Phase 1B.5.7).** `apps/api/test/me-authorization.sec-spec.ts` (16 cases): shape and self-only — a path variant, a query parameter and a body field each fail to change the subject; two principals see only their own; no credential material. **Case 22b through the response** — an actor holding `teams.create` in one workspace and `role_assignments.grant` across the organization sees `teams.create` under the workspace grant and *not* under the organization one, the response carries no flattened union at all, and the backend agrees by refusing the corresponding grant. API keys — effective authority only, a permission the creator holds only elsewhere never appears, bounded by binding scope, no key material. Tenant isolation — never another organization's grants, never reported as a platform admin, and no `authorization.denied` noise, since the endpoint performs no target-scope check.

**API conventions (Phase 1B.5.8, `API.md` §§7a-8).** `apps/api/test/api-conventions.sec-spec.ts` (31 cases) and `apps/api/src/common/http/list-query.spec.ts` (9 unit cases).

- **The envelope** — a collection answers exactly `{data, page}` and a single resource exactly `{data}`; an error still answers `{error}`; the correlation id is on every response as a header and matches the error body's; and the shape holds for *every* list endpoint rather than one.
- **Pagination** — default and explicit page sizes; a full walk returns **every row exactly once** and agrees with a single large page; the last page reports `hasMore:false` and a null cursor; limits outside 1–100 are refused; ordering is deterministic across identical requests; **rows sharing a sort value are walked, not skipped** — the case the tie-breaker exists for, and the one that caught a real defect during this phase; a row inserted after page one cannot duplicate a returned row; malformed, tampered and wrong-sort cursors are each `400`; and a cursor carried into another tenant's request reveals nothing.
- **Sorting** — ascending and descending on an allowed field are exact reverses; an unlisted field is `400 SORT_NOT_ALLOWED`; and six injection shapes are refused with the table still standing afterwards.
- **Filtering** — an allow-listed filter applies and combines with sort and paging; an unknown filter is refused rather than ignored; a wrongly-typed filter is refused; and a filter naming another organization's row returns nothing.
- **Validation** — field, machine-readable rule and message on every issue; every failing field reported, not just the first; nested fields addressed by path (`permissions.0`); no SQL, stack or internal token anywhere in the body; and the correlation id matches the header.
- **Unit** — `ListQuery` clamps above and below the bounds, reads exactly one row beyond the page, always orders by two terms, refuses unlisted sort fields, and carries no keyset predicate on page one. These assert what the HTTP suite structurally cannot: the DTO refuses an out-of-range `limit` before `ListQuery` ever sees it, so the clamp is unreachable from a request and invisible end to end.

**HTTP idempotency (Phase 1B.5.9, `API.md` §4, ADR-006).** `apps/api/test/idempotency.sec-spec.ts` (29 cases) plus `request-fingerprint.spec.ts` (22) and `idempotency-key.spec.ts` (8) as unit suites.

- **Unit — canonicalization** pulls in two directions and both are asserted: too strict and a client library reordering JSON turns a safe retry into a mismatch; too loose and two different requests share a fingerprint, which is the security failure. Key order insensitive at every depth, array order preserved, `undefined` and absent alike, explicit `null` distinct, number not confused with its string, nested object not confused with a flattened key.
- **Unit — binding** asserts the fingerprint differs for a different body, route, method, organization, user, API key, path parameter and query parameter — and is *stable* across a different session, different resolved grants and reordered body keys.
- **Unit — key validation**: alphabet and length bounds, whitespace trimmed rather than refused, injection-shaped keys refused, and the offending key never echoed back.
- **Execution and replay** — the first request records `completed` with its status and actor; an identical repeat replays byte-identically and mutates nothing; the replayed envelope carries no marker; a reordered body still replays; without a key the endpoint behaves exactly as before; and the second endpoint behaves the same.
- **A key is never a credential** — a different user in the *same organization* with the *same authority* is refused `422`; a different organization gets its own namespace rather than the other's response; RLS hides another tenant's record from the service's own query; an API key cannot replay the request of the user who created it; an unauthenticated caller gets `401`.
- **Authorization is re-evaluated every time** — a refused request stores nothing, *still writes its `authorization.denied` row with the actor's own scope*, and an actor that loses its grant after a success is refused on replay rather than handed the stored response.
- **Failures are not cached** — validation, business conflict and refused composition each leave no record, and the key remains usable for a corrected request.
- **Correlation ids** — a replay carries its **own** id, and the record retains the *original* for diagnostics.
- **Concurrency, six cases, each asserting the final database state rather than the statuses** — two and five concurrent identical requests each produce exactly one role and one record; the same key racing with different bodies yields `201`/`422` and at most one row; the same key racing across two organizations writes one row each; a rolled-back execution leaves the key free; and a first execution racing repeats never double-writes.

**User lifecycle (Phase 1B.6.1, `API.md` §3d, `RBAC.md` §8c).** Three suites, 105 cases, over real HTTP against real rows, plus one structural unit suite. `users` is the one administered table with **no tenant column**, so most of what is asserted here is a boundary the schema does not supply.

- `apps/api/test/user-administration.sec-spec.ts` (72 cases) — **membership, not visibility**: `users_select` admits any user reachable through *any* organization in scope, and the endpoint narrows to the organization the request selected, so a reseller admin's list does not widen with its other memberships. Cross-organization and cross-reseller users are absent from the list and `404` on detail, with a real foreign id byte-identical to an unknown one apart from the correlation id. **Credential material** is asserted absent from list, detail, creation and every audit row — no digest, no `passwordUpdatedAt`, no `mfaSecretRef`, no `mfaEnabled`, no token — and the detail projection is asserted to be exactly the seven published fields. **Creation** produces an `invited` user with its first grant atomically, rolls the identity back when the grant is refused, refuses a platform role, refuses a role carrying a permission the actor lacks at that scope, and refuses a body carrying `password`, `passwordHash` or `status`. **Update** reaches `phone` and refuses `status`, `email`, `roleId`, `orgId`, `scopeId`, `passwordHash` and `isPlatformAdmin` as `400`. **Lifecycle** covers disable, double-disable `409`, reactivation to `active` with a credential and to `invited` without one, and sessions not being resurrected. **Authorization** covers each of the five permissions independently, a workspace-pinned actor refused at the organization, a forged `X-Acc-Organization`, and the denial audit row. **API keys** cover scope withholding, binding scope, and a key whose creator has since been disabled. **RLS with the service bypassed** covers cross-tenant read and write, and asserts `acc_app`'s missing `DELETE` grant as `42501` rather than a policy returning zero rows. **Idempotency** covers verbatim replay, payload mismatch, a different principal, and a replay refused once the replayer's authorization is gone.
- `apps/api/test/user-lifecycle-concurrency.sec-spec.ts` (18 cases) — the liveness invariant through its **second** violation path, which until this phase had no HTTP surface: `trg_users_platform_admin_liveness`, `AFTER UPDATE OF status`. **Every race asserts the final database state**, not the status codes. Disabling the only active administrator is `409 AUTHZ_LAST_PLATFORM_ADMIN` with nothing written; the trigger refuses the same transition with the service bypassed entirely; two administrators disabling each other concurrently leave exactly one administrator; three concurrent disables leave one; a disable racing a role revocation leaves one; two concurrent creations of one address produce exactly one user and exactly one grant; concurrent disables and concurrent reactivations converge on the committed state; a disable racing an authenticated request and a disable racing a refresh both end with the user `disabled` and no live session.

  **Two of its cases are about what the suite does *not* prove, and are worth reading as a pair.** `a refused disable never reaches session revocation` is deliberately *not* the atomicity proof: the liveness guard throws before `setStatus` and before `revokeAllForUser`, so nothing is rolled back because nothing was written. It was previously named as though it proved atomicity, which is worse than having no test — the next person to reorder `disable` would have trusted it. The real proof is `an audit failure after the revocation rolls back the status and the sessions together`, which causes the one failure reachable *after* both writes (the audit insert, stubbed on the container's own `AuditWriter` exactly as the grant path already does) and asserts that the status **and** the session rows both survive intact. No production seam exists for it.

  **"Exactly one winner" is not a property of the lifecycle transitions, and the suite no longer claims it is.** `disable` and `reactivate` read the current status and then issue an unconditional `UPDATE … WHERE id = ?`, so under `READ COMMITTED` two overlapping callers both observe the prior state and both succeed. The original assertions demanded one `200` and one `409` and passed only because earlier cases in the file spaced the requests apart — run in isolation they failed every time. They now assert what holds: at least one success, every loser carrying exactly `409 USER_LIFECYCLE_CONFLICT` rather than a `500` or a silent no-op, and a deterministic committed state. Making it exactly-one would mean adding `AND status <> …` to the update; that is a production change with no security consequence (the committed state and the session revocation are identical either way) and is recorded as a deferred refinement rather than made silently.
- `apps/api/src/users/user-administration-boundary.spec.ts` (15 unit cases) — structural, because each of these would look entirely reasonable in review and no behavioural test necessarily catches it: the service never writes `user_roles`, never deletes a user, never selects the whole `users` row, reads the password digest only inside an `IS NOT NULL` test, never reads `principal.permissions` or `principal.roles`, records all four audit rows inside the caller's transaction, and is the **only** caller of the create-and-grant relaxation — which no DTO exposes.

**Two isolation cases exist because the controls would otherwise mask each other.** Disabling a user both changes `status` *and* revokes their sessions, so every test driven through the endpoint passes even with `AuthGuard`'s user-state check removed — the session check catches it instead. Two cases therefore change `status` **directly in the database**, leaving the session rows live, so the per-request re-read of the user is the only thing that can refuse the request. Without them the mutation "skip the current user-status check during authentication" survives, which is how it was found.

**API-key administration (Phase 1B.6.2, `API.md` §3e, ADR-008).** Two HTTP suites (57 cases) and two unit suites (24 cases). The governing invariant is ADR-008's: *a plaintext API-key secret is never persisted in `idempotency_keys.response_snapshot`* — nor in `api_keys`, an audit row, an error, or anywhere else.

- `apps/api/test/api-key-administration.sec-spec.ts` (50 cases) — **the secret**: a fresh creation returns one that actually authenticates; `api_keys` holds an Argon2id digest and not the plaintext; it is absent from list, detail, audit and from a refused creation's error; the read model has no `secret` field at all and the detail projection is asserted to be exactly the fifteen published fields; and there is no route that could return it. **ADR-008**: the persisted snapshot carries `secret: null`, the plaintext appears nowhere in the row at any depth, and the fresh response and the snapshot are asserted to differ in **exactly one field** — computed by diffing the two objects rather than by naming it, so a second divergence would fail. **Replay**: returns `secret: null`, creates no second key, mints no new secret, writes one audit row, and is byte-identical to what was stored; a different principal and a mismatched request are refused; a replay after authorization loss is refused and discloses nothing. **Credential lifecycle**: a revoked key and an expired key both stop authenticating, and a disabled creator's key still authenticates as an identity while conferring exactly nothing — the 1B.6.1 semantic, asserted here to be *not* auto-revocation. **Authorization**: each permission independently; cross-organization list, detail and revoke; a real foreign id byte-identical to an unknown one; a forged organization header; binding to another tenant's workspace; `platform`/`reseller`/`team` bindings unrepresentable; revoke refused for an actor in a sibling workspace, which is the stored-binding-scope case; and a creator unable to confer a permission held only at an unrelated scope, with a positive control proving the organization grant *does* cover its own workspace. **RLS with the service bypassed**, and a transactional-audit failure rolling the creation back.
- `apps/api/test/api-key-concurrency.sec-spec.ts` (7 cases, A–G) — final database state in every one. Two creations with different names both succeed and produce two distinct prefixes; one idempotency key with identical requests yields exactly one key where **exactly one of the two responses carries the secret and the other carries null**; a mismatched request creates nothing; concurrent revocations produce exactly one `200` and one `409 API_KEY_LIFECYCLE_CONFLICT` — deterministic here, unlike the user lifecycle, because the conditional `WHERE revoked_at IS NULL` lets the row lock decide; no authentication succeeds after a revocation commits; revocation racing expiry cannot resurrect the key; and a creation racing its creator's disable leaves no usable credential either way.
- `apps/api/src/api-keys/api-key-boundary.spec.ts` (19 structural cases) — the dataflow proof. `minted.secret` occurs **exactly twice** in the service (the hash and the return); the creation audit block is checked for any mention of a secret or digest; the controller's `work()` returns `secret: null` and the plaintext is merged only when `outcome.replayed` is false; `IdempotencyService` and the fingerprint are asserted to contain no knowledge of secrets, so ADR-008 cannot have leaked into the generic mechanism; `mintApiKey` has exactly one caller; the projection omits `key_hash`; both authorization targets come from `bindingScopeOf(row)` and that function is asserted to read only the row; `platform`/`reseller`/`team` are absent from the scope list; nothing writes `user_roles`; and no permission outside the existing three is named.
- `apps/api/src/api-keys/api-key-secret.spec.ts` (5 unit cases) — the format both `api_keys_prefix_shape` and `AuthGuard`'s parser require, ~256 bits of entropy, no repeats across 2,000 mints, and **no modulo bias**: a naive `byte % 62` skews the first four characters of the alphabet by ~1.6%, far too little to fail a format test, so the frequency is measured directly.

**Audit read (Phase 1B.6.3, `API.md` §3f).** `apps/api/test/audit-read.sec-spec.ts` (33 cases), over real HTTP against real rows.

The phase's defining case is the one that found a defect. `audit_logs_select` admits a reseller row when `reseller_id = app_current_reseller_id()`, and that session variable is derived from the *selected organization's* reseller for **every** principal — so RLS alone showed an organization administrator its own reseller's trail. The detail route always refused it, because it authorizes at the record's recorded `{reseller, …}` scope and nothing reaches upward; the list had no per-row equivalent. **The list was broader than the detail route it links to.**

- **The discriminator** — an organization caller sees neither its own reseller's rows nor another reseller's, in the list *and* on detail (`404` for both since ADR-011 — its own reseller's row was previously `403`, an existence oracle produced by the widened reseller claim), while its organization/workspace/team rows are unaffected. A genuine reseller-scope holder keeps its reseller trail and still cannot see another reseller's. A workspace-pinned caller is refused the list outright — stronger than "sees no reseller rows", because a workspace grant cannot cover the organization target. Mixed org+reseller grants do not broaden beyond the held reseller. An API-key principal, bound at organization or workspace and never above, sees no reseller rows at all.
- **The invariant, asserted directly** — *a row appears in the list if and only if the detail route serves it*, walked over all five scope levels with the reciprocal `listed === (detail === 200)` assertion, so a future scope type cannot reintroduce a gap in either direction.
- **Isolation** — cross-organization rows absent from the list and `404` on detail, with a real foreign id byte-identical to an unknown one; the mirror case proving B sees its own trail and none of A's; platform rows invisible to a tenant and visible to a platform administrator; a forged `X-Acc-Organization` refused; `orgId`/`resellerId`/`workspaceId` as query parameters refused rather than ignored.
- **Redaction, end to end** — a payload written through the real `AuditWriter` with `password`, nested `password_hash`, `refresh_token` and `key_hash` comes back `[redacted]`. Nothing in the read path redacts, so a leak would mean the write-time boundary had failed.
- **Append-only and RLS premise** — `acc_app` `UPDATE` and `DELETE` on `audit_logs` both refused with `42501`; `audit_logs.relrowsecurity`, `acc_app.rolsuper` and `acc_app.rolbypassrls` asserted directly, so the isolation cases cannot pass for the wrong reason.
- **List conventions** — invalid filters, sorts and cursors refused; a cursor refused when replayed under a different sort; every row walked exactly once newest-first; filters narrowing to the caller's own trail; a half-open `[from, to)` occurrence window.

**Credentials are never accepted from a URL (Phase 1B.7 prep, `SECURITY.md` §1).** Three cases in `apps/api/test/auth.sec-spec.ts`.

This property is invisible in the source: it is the *absence* of a fallback. Nothing in the suite would have failed if someone had later written `?? request.query.token` into `AuthGuard`, and a query-string credential is copied into proxy logs, access logs, browser history and `Referer` headers — so it is asserted directly. A **genuinely valid** token is minted and replayed through nine query spellings (`token`, `access_token`, `accessToken`, `authorization`, `auth`, `jwt`, `api_key`, `apiKey`, `bearer`) in both raw and `Bearer `-prefixed form, against `/users`, `/roles`, `/api-keys`, `/audit-logs`, `/tenants/workspaces` and `POST /ws/ticket`; a real API key gets the same treatment. Each must be `401`, with a header positive control in the same test proving the credential itself was good — otherwise every case would pass for the wrong reason. Mutation-verified: adding an `access_token` query fallback to `AuthGuard` fails three tests.

**WebSocket ticket issuance (Phase 1B.7 prep, `API.md` §10b).** `apps/api/test/ws-ticket.sec-spec.ts` (14 cases). Issuance only — there is no gateway and no consumption path to test.

- **The credential** — the plaintext is returned exactly once, the row stores only its SHA-256 (asserted by recomputing the digest and matching `/^[0-9a-f]{64}$/`), and the response projection is asserted to be exactly six keys, so a hash field could not be added unnoticed.
- **Scope is computed, never requested** — the endpoint takes no body, and scope-escalation attempts through body, query and header each yield the caller's own scope, with zero rows visible for the other organization. A workspace-pinned context yields the workspace topic and is asserted **not** to contain the organization topic.
- **Binding** — user, session and tenancy come from the resolved principal; a forged organization header is `403 TENANCY_CONTEXT_MISMATCH`; deleting the session cascades the ticket away; an API-key principal is refused `403`, because the row has no user to bind to.
- **Single use and lifetime** — `consumed_at` starts null, two issues mint distinct tickets, a duplicate hash insert is rejected by the unique index, and the TTL is ≤ 300s with `expiresAt > issuedAt`.
- **Audit and isolation** — `ws_ticket.issued` is written and carries neither the ticket nor its hash; cross-tenant rows are invisible under RLS; unauthenticated issuance is `401` and writes no row.

**General rate limiting (Phase 1B.6.4, `API.md` §5a).** `apps/api/test/rate-limit.sec-spec.ts` (19 cases).

The first case is the one the rest depend on: **the limiter actually engages**. A guard registered before `AuthGuard` would see no principal and silently limit nothing, and every isolation case would then pass for the wrong reason — so the suite opens by asserting that two real requests decrement a real counter.

- **Isolation on all three key dimensions**, driven with real authenticated identities rather than by computing keys: organization A exhausting its bucket leaves B untouched; two principals in one organization hold independent budgets; `read` and `write` are separate buckets for the same principal.
- **Bucket identity cannot be chosen by the caller** — `X-Tenant-ID`, `X-Organization-ID`, `X-Principal-ID`, `X-RateLimit-*` request headers, `X-Endpoint-Class`, a bypass header and query identifiers are each sent in turn while the counter is watched descending in the *same* bucket, and the server's own header values come back rather than the ones supplied. Forging a class onto a write route is tested separately.
- **`X-Forwarded-For` cannot move the bucket**, because the general limiter does not key on IP — the assertion is the absence of a dimension.
- **Headers and exhaustion** — the three headers on every response, `X-RateLimit-Reset` as seconds rather than a timestamp, and on exhaustion a `429` carrying `Retry-After`, the frozen error envelope, `retryable: true` and `details.retryAfterSeconds`, with `Retry-After` and `X-RateLimit-Reset` asserted equal. Exhausting one bucket leaves the other organization and the other class serving.
- **API keys** are bucketed by key id, proven by spending the creator's budget and observing the key's untouched.
- **The authentication limiter is untouched and independent** — a public login creates no general bucket, `AuthRateLimitService` still refuses after its own threshold, and one login followed by one authenticated request creates exactly one general bucket with a count of one. No request is charged twice.
- **Fail open** — with the Redis pipeline made to reject, the API keeps serving and reports the full limit; it recovers unaided.
- **Metrics carry no tenant identity** — `/metrics` is scraped after traffic from two organizations and asserted to contain neither organization id, neither user id, nor an `org_id=`/`tenant_id=`/`principal_id=` label.
- **Key shape, discovered from Redis rather than reconstructed**, so the assertion cannot silently stop matching: the organization-scoped key carries tenant, principal and class under the deployment prefix, and a `@NoTenantContext()` route's key is platform-scoped, names no organization, and is a *different* bucket from the same principal's tenant traffic.

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
| 31 | A user of another organization listed, read, updated or disabled | absent from the list; `404` on the rest, indistinguishable from an unknown id |
| 32 | A disabled user's unexpired access token, with **no session revoked** | `401` — the per-request user-state re-read is the only control in play |
| 33 | A disabled user's refresh, with **no session revoked** | `401`, and nothing rotated |
| 34 | Disabling the last active platform administrator | `409 AUTHZ_LAST_PLATFORM_ADMIN`; the trigger refuses it with the service bypassed |
| 35 | Two administrators concurrently disabling each other | exactly one succeeds; the final count is `1`, read from the database |
| 36 | An API key whose creator has since been disabled | no effective permissions at all |
| 37 | `PATCH /users/:id` naming `status`, `email`, `roleId` or a scope | `400`; nothing moves |
| 38 | Credential material in a user response or a user audit row | never present |
| 39 | An API-key plaintext secret in `idempotency_keys.response_snapshot` | never present; the snapshot stores `secret: null` |
| 40 | Fresh creation response vs. persisted snapshot | differ in exactly one field, the documented non-persistable `secret` |
| 41 | Idempotent replay of an API-key creation | `secret: null`, one key, one audit row, no new secret |
| 42 | API-key secret after creation — list, detail, replay, any route | unrecoverable |
| 43 | Revoke or read authorized against the key's **stored** binding scope | a sibling-workspace actor is refused |
| 44 | Revoked or expired key at authentication | refused regardless of creator status |
| 45 | Disabled creator's key | authenticates as an identity, confers nothing, is **not** auto-revoked |
| 46 | Concurrent revocations of one key | exactly one `200`, one `409`; the conditional write decides |
| 47 | Organization caller vs. a reseller-scoped audit row | absent from the list **and** `404` on detail (was `403` before ADR-011) |
| 48 | Audit list membership vs. detail access, all five scope levels | they agree — listed ⟺ readable |
| 49 | Genuine reseller-scope caller vs. its own reseller's audit rows | visible and readable; another reseller's is not |
| 50 | API-key principal vs. reseller-scoped audit rows | never visible — a key is never bound above an organization |
| 51 | Rate-limit bucket identity vs. caller-supplied headers, query and body | unchanged — the counter keeps descending in the same bucket |
| 56 | A valid access token supplied as `?token=` / `?access_token=` / seven other query spellings | `401` — no query parameter is ever consulted for credentials |
| 57 | A valid API key supplied as a query parameter | `401`, on every route tested including `POST /ws/ticket` |
| 58 | A WebSocket ticket in the issuing response vs. the stored row | the row holds only SHA-256; the plaintext is returned once and is nowhere else |
| 59 | A caller naming a topic, organization or workspace when requesting a ticket | ignored — the endpoint takes no body; the scope is the caller's own |
| 60 | A workspace-pinned user's ticket scope | the workspace topic **only**; it does not carry the organization topic |
| 52 | Rate-limit isolation across organization, principal and endpoint class | three independent buckets |
| 53 | Rate-limit exhaustion | `429`, `Retry-After`, frozen envelope; other buckets unaffected |
| 54 | Redis outage vs. the limiter | fails open; the API keeps serving |
| 55 | Authentication limiter vs. the general limiter | independent; no request charged to both |

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
| The role-composition authority guard removed | **executed at 1B.5.4: 3 security tests fail** |
| System-role protection removed from the service | **executed at 1B.5.4: 4 security tests fail** |
| The grants-exist check removed before role deletion | **executed at 1B.5.4: 3 security tests fail** |
| `TenantRoleProvisioner`'s already-present skip removed | **executed at 1B.5.4: 1 security test fails** — `onConflictDoNothing` still prevents the duplicate row and the early return still suppresses the audit, so only the idempotency assertion detects it, which is the layering working |
| `user_roles.role_id` reverted to `ON DELETE CASCADE` in the database | **executed at 1B.5.4: the `ON DELETE RESTRICT` case fails** |
| `trg_roles_protect_system` dropped from the database | **executed at 1B.5.4: the service-bypassed case fails** |
| `allowedScopeTypes` grant-time enforcement removed | **executed at 1B.5.5: 3 security tests fail** |
| The actor-authority (composition) check removed from grant | **executed at 1B.5.5: 2 security tests fail** |
| Grant authorized at the actor's own organization instead of the scope being granted at | **executed at 1B.5.5: 3 security tests fail** |
| Platform-role protection removed from grant | **executed at 1B.5.5: 1 security test fails** |
| `unheldPermissions` rewritten against the flattened `principal.permissions` | **executed at 1B.5.5: 1 security test fails** — case 22b, and *only* case 22b, which is why it exists: every other escalation case names a permission the actor lacks entirely, where the union and the coherent-grant rule agree |
| RLS disabled on `user_roles` | **executed at 1B.5.5: 2 security tests fail** |
| The denial-audit failure swallowed instead of propagated | **executed at 1B.5.5: 2 security tests fail** |
| API-key creator intersection taken at the creator's widest scope instead of the binding | **executed at 1B.5.5: 5 security tests fail** |
| The service last-admin check removed | **executed at 1B.5.6: 7 security tests fail** — the trigger still refuses, so the invariant holds; what is lost is the clean `409`, which is exactly what the service check is for |
| `pg_advisory_xact_lock` removed from `fn_assert_platform_admin_remains` | **executed at 1B.5.6: the race cases fail on roughly two runs in three, and the structural assertion fails every run** — which is why that assertion exists: a race detector alone is a probabilistic guard against the one mutation that matters most |
| Both liveness triggers dropped | **executed at 1B.5.6: all 27 fail** |
| Only the `user_roles` liveness trigger dropped | **executed at 1B.5.6: 6 security tests fail** |
| The `status = 'active'` term dropped from the count | **executed at 1B.5.6: 1 security test fails** |
| The `409` rendered as `403 AUTHZ_SCOPE_DENIED` | **executed at 1B.5.6: 7 security tests fail** |
| The authorization boundary removed from revoke | **executed at 1B.5.6: 1 security test fails** |
| API-key creator intersection taken at the creator's widest scope (re-run against this surface) | **executed at 1B.5.6: 5 security tests fail** |
| `@RequiresPermission` dropped from a protected route | **executed at 1B.5.7: 1 security test fails** — case 30 |
| A handler declares a permission and never checks it | **executed at 1B.5.7: 6 security tests fail** |
| `AuthorizationCoverageInterceptor` unregistered | **executed at 1B.5.7: 4 security tests fail** |
| `AuthorizationService.assert` stops recording coverage | **executed at 1B.5.7: 1 security test fails** — and fails *closed*: with nothing recorded every declared route is refused |
| The self-only restriction removed (a `userId` parameter honoured) | **executed at 1B.5.7: 1 security test fails** |
| The grant discriminator destroyed (each grant reports the flattened union) | **executed at 1B.5.7: 1 security test fails** — case 22b through the response |
| API-key creator intersection taken at the creator's widest scope (through `/auth/me/authorization`) | **executed at 1B.5.7: 1 security test fails** |
| `ScopeChainResolver` fabricates an organization chain instead of reading it | **executed at 1B.5.7: 4 security tests fail** — in the 1B.5.2 suites, which is where chain provenance is asserted; the 1B.5.7 surfaces resolve no chain of their own and correctly do not detect it |
| The sort allow-list removed | **executed at 1B.5.8: 1 security test fails** |
| Cursor signature verification removed | **executed at 1B.5.8: 1 security test fails** |
| The cursor's sort binding removed | **executed at 1B.5.8: 1 security test fails** |
| The page-size clamp removed | **executed at 1B.5.8: 2 unit tests fail** — not the HTTP suite, because the DTO refuses an out-of-range `limit` first; the clamp is the guarantee for a non-HTTP caller and is asserted where it is reachable |
| The tie-breaker dropped from the ordering | **executed at 1B.5.8: 1 unit test fails** — the HTTP walk still terminates because the *keyset predicate* retains the tie-breaker even when `ORDER BY` loses it, so the structural assertion is what detects it |
| `forbidNonWhitelisted` disabled (filter allow-listing) | **executed at 1B.5.8: 2 security tests fail** |
| Validation field/rule mapping flattened | **executed at 1B.5.8: 5 security tests fail** |
| The application tenant predicate removed from `GET /roles` | **executed at 1B.5.8: nothing fails — and that is the layering working.** RLS is the isolation boundary for this table, and the application predicate is redundant with it. Disabling RLS *as well* fails 5 tests, which is the honest demonstration of which layer holds |
| The idempotency lookup removed (every request executes) | **executed at 1B.5.9: 18 security tests fail** |
| The claim result ignored (work runs even on conflict) | **executed at 1B.5.9: 13 security tests fail** |
| The request-hash comparison removed | **executed at 1B.5.9: 5 security tests fail** |
| The **endpoint** dropped from the fingerprint | **executed at 1B.5.9: 1 unit test fails; the HTTP suite passes** — and that is honest layering: `endpoint` is part of the `(org_id, endpoint, key)` unique index, so the record is already per-endpoint and the hash term is belt-and-braces |
| The **organization** dropped from the fingerprint | **executed at 1B.5.9: 1 unit test fails; the HTTP suite passes** — same reason: `org_id` leads the unique index, and RLS is the isolation boundary beneath it |
| The **principal** dropped from the fingerprint | **executed at 1B.5.9: 3 unit and 2 security tests fail** — the principal is *not* in the unique index, so the fingerprint is the only enforcement, which is exactly why it is there |
| A replay returned without authorizing the current request | **executed at 1B.5.9: 8 security tests fail** |
| A fabricated response returned instead of the stored one | **executed at 1B.5.9: 6 security tests fail** |
| The record finalized *before* the work runs | **executed at 1B.5.9: 6 security tests fail** |
| The finalize moved into a separate transaction (crash window reopened) | **executed at 1B.5.9: 9 security tests fail** |
| The original correlation id replayed as the current one | **executed at 1B.5.9: 2 security tests fail** |
| RLS disabled on `idempotency_keys` | **executed at 1B.5.9: 1 security test fails** |
| `idempotency_keys_scope_key` unique index dropped | **executed at 1B.5.9: 27 security tests fail** — it is the mutex, not merely a constraint |
| The organization-membership predicate removed from `/users` | **executed at 1B.6.1: 56 security tests fail** — it is the whole tenant boundary for a table RLS scopes only by reachability |
| `AuthorizationService.assert` removed from disable | **executed at 1B.6.1: 24 security tests fail** |
| The coherent-grant rule replaced by the flattened `principal.permissions` | **executed at 1B.6.1: 3 security tests fail**, case J among them |
| The active-user check removed from `AuthGuard` | **executed at 1B.6.1: 2 security tests fail — and only after cases 32/33 were added.** Driven through the endpoint it survives, because the disable also revokes sessions and the session check catches it. The two cases that change `status` directly in the database are what isolate this control, and they exist because the mutation survived without them |
| The user-status check removed from refresh | **executed at 1B.6.1: 1 security test fails** — case 33, for the same reason |
| The service last-platform-admin check removed from disable | **executed at 1B.6.1: nothing fails, and that is the layering working.** `trg_users_platform_admin_liveness` refuses the same transition and `translateLivenessViolation` maps its `restrict_violation` onto the identical `409`, so the two are indistinguishable to a caller. Stronger than the equivalent 1B.5.6 mutation, where removing the service check cost the clean error. What the service check buys is ADR-005 D-7's lock ordering and avoiding an aborted transaction in the common case — not the guarantee. No test was written to force detection |
| Session revocation removed from disable | **executed at 1B.6.1: 3 security tests fail; 6 after the 1B.6.1 follow-up** — the two race cases gained final-state assertions, so a disable that changes the status without ending the sessions is now caught in the concurrent paths as well as the sequential one |
| The session revocation moved into its own transaction | **executed at 1B.6.1 follow-up: 1 security test fails — and exactly the right one.** Only the audit-failure atomicity case detects it: every other case observes a *successful* disable, where a second transaction commits the same rows and is indistinguishable from one. That single test is therefore the whole of the evidence for the one-transaction claim, which is why the case it replaced being vacuous mattered |
| `password_hash` added to the user projection | **executed at 1B.6.1: 2 security tests fail** |
| The `user.disabled` audit write removed | **executed at 1B.6.1: 1 security test fails** |
| `status` and `roleId` admitted by `UpdateUserDto` | **executed at 1B.6.1: 2 security tests fail** |
| `forbidNonWhitelisted` disabled | **executed at 1B.6.1: 3 security tests fail** |
| The requested id echoed in the not-found message | **executed at 1B.6.1: 1 security test fails** — the byte-identical-answers case, which is the only one that can see it |
| `Idempotency-Key` ignored on `POST /users` | **executed at 1B.6.1: 4 security tests fail** |
| A replay returned without authorizing the current request | **executed at 1B.6.1: 3 security tests fail** |
| The API-key creator status check removed | **executed at 1B.6.1: 1 security test fails** — the control this phase added, and the only case that exercises it |
| Reactivation forces `active` regardless of credential | **executed at 1B.6.1: 1 security test fails** |
| The create-and-grant relaxation removed (control mutation) | **executed at 1B.6.1: 10 security tests fail** — confirming guard 5 really is unsatisfiable for a just-created user, so the relaxation is load-bearing rather than defensive |
| RLS disabled on `users` | **executed at 1B.6.1: 2 security tests fail** |
| `trg_users_platform_admin_liveness` dropped | **executed at 1B.6.1: 7 security tests fail** |
| `users_email_key` dropped | **executed at 1B.6.1: 2 security tests fail** |
| `acc_app` granted `DELETE` on `users` | **executed at 1B.6.1: 3 security tests fail** — the grant's absence is the guarantee, so granting it is the mutation |
| The duplicate-address refusal carries the existing user's status in `details` | **executed at 1B.6.1 follow-up: 1 security test fails** — the indistinguishability case, and only it. Every other duplicate-address assertion still passes, because they check the code and the absence of identifiers rather than comparing the local and foreign refusals against each other |
| **1B.6.2** — the real secret persisted into `response_snapshot` | **executed: 6 security tests fail** — the ADR-008 invariant, caught by the snapshot, diff and concurrency cases |
| The stored secret returned on replay | **executed: 6 fail** |
| A fresh secret generated on replay | **executed: 5 fail** |
| The creator-status check removed from the API-key path | **executed: 2 fail** |
| The creator intersection taken over the creator's flattened union | **executed: 5 fail** — including the 1B.5.1 coherent-grant suite, which is the layer that owns it |
| RLS disabled on `api_keys` | **executed: 4 fail** |
| Revocation enforcement dropped from the authentication lookup | **executed: 4 fail** |
| Expiration enforcement dropped from the authentication lookup | **executed: 2 fail** |
| The creation audit write moved outside the transaction | **executed: 43 fail** — `AuditWriter` refuses a security-sensitive action with no transaction, so the endpoint fails closed everywhere at once |
| Revoke authorized against the caller's organization instead of the key's stored binding scope | **executed: 1 fails** — the sibling-workspace case, and only it, which is precisely why it exists: every other revoke case uses an actor who covers both scopes, where the two targets agree |
| `key_hash` added to the read projection | **executed: 4 fail** |
| The creator-authority guard on requested `scopes` removed | **executed: 5 fail** |
| The conditional `WHERE revoked_at IS NULL` dropped from revoke | **executed: 2 fail** — the concurrency case and the repeat-revocation case |
| `api_keys_prefix_shape` CHECK dropped | **executed: nothing fails — an honest survivor.** The generator always produces a conforming prefix, so no application path can violate the constraint; it defends against a *different* writer (a migration, an admin tool, a future import), which this suite does not exercise. Recorded rather than papered over with a test that inserts a malformed row solely to detect it |
| **1B.6.3** — audit detail authorized at the caller's organization instead of the record's recorded scope | **executed: survived the first suite, then 1 security test fails.** The survival is the finding: the original case used a workspace-pinned actor, which is denied under both the correct and mutated targets and therefore never discriminated. The case that kills it — an organization caller against a reseller-scoped row — is what exposed the list/detail inconsistency this phase fixed |
| The reseller-row list narrowing removed | **executed: 1 security test fails** — the regression guard for the fix |
| Reseller visibility derived from `TenantContext.resellerId` instead of held grants | **executed: 1 security test fails** — the precise defect, reintroduced deliberately: the session variable is derived from the selected organization's reseller and is not evidence of reseller-scope authority |
| Authorization removed from the audit list | **executed: 16 security tests fail** |
| The coherent-grant rule replaced by the flattened union, against the audit surface | **executed: 1 security test fails** |
| **1B.7 prep** — an `?access_token=` query fallback added to `AuthGuard` | **executed: 3 security tests fail** — the property is the absence of the fallback, so this is the only way to prove the cases are not vacuous |
| **1B.6.4** — `org_id` removed from the rate-limit bucket key | **executed: 4 security tests fail** |
| Principal removed from the bucket key | **executed: 5 security tests fail** |
| Endpoint class removed from the bucket key | **executed: 4 security tests fail** |
| The general limiter removed entirely | **executed: 19 security tests fail** |
| Redis failure changed from fail-open to fail-closed | **executed: 1 security test fails** — the fail-open case, which is the only one that can see it |
| A caller-supplied `X-Endpoint-Class` honoured as the bucket class | **executed: 1 security test fails** |
| A caller-supplied `X-Organization-ID` honoured as the bucket organization | **executed: 1 security test fails** |
| *(G)* A spoofed `X-Forwarded-For` trusted contrary to `TRUSTED_PROXY_HOPS` | **NOT APPLICABLE.** The general limiter does not derive bucket identity from IP, so there is no IP-derived value to corrupt; fabricating one would have meant adding an IP dimension purely to mutate it. A security test asserts directly that forwarded-for spoofing cannot change the bucket, and `TRUSTED_PROXY_HOPS` remains exercised by the authentication limiter, which does key on IP |
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
