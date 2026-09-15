# Phased Development Roadmap

## 1. Development lifecycle (applies to every phase, every unit of work within a phase)

```
DESIGN → IMPLEMENT → TEST → SECURITY REVIEW → DOCUMENT → BUILD → STAGING → SMOKE TEST → ACCEPTANCE → PROCEED
```

No phase's work proceeds to the next phase until its own ACCEPTANCE gate is signed off. A phase's `DOCUMENT` stage updates the relevant `/docs` files in place — documentation is not a one-time Phase 0 artifact, it evolves with the system.

## 2. Phase index

| Phase | Name |
|---|---|
| 0 | Architecture (this phase) |
| 1 | Foundation |
| 2 | Provider abstraction + simulator |
| 3 | WhatsApp |
| 4 | SMS + RCS |
| 5 | Provider/channel failover |
| 6 | Admin control center |
| 7 | Billing (usage ledger + Pricing & Rating Engine) |
| 8A | Contacts / CDP |
| 8B | Campaigns |
| 8C | Journeys / Automation |
| 8D | Unified Inbox / Conversations |
| 8E | Chatbot / Flow Builder |
| 8F | CRM / Sales |
| 8G | Commerce Integrations |
| 9 | Reseller + white-label |
| 10 | AI |
| 11 | Migration center |
| 12 | Production hardening |

Phase 8's sub-phases (8A–8G) implement the Engagement Layer and Experience Applications (`ARCHITECTURE.md` §21) as callers of the Communication Core built in Phases 1–7 — none of them introduce a new send path. 8A–8D are near-term (directly needed to reach feature parity with existing engagement tools); 8E–8G are architected for now but sequenced later, per `ARCHITECTURE.md` §21's "roadmap framing, not a Phase 1–7 commitment" note.

## 3. Phase 0 — Architecture

- **Objectives**: produce this document set; establish shared vocabulary, entity model, and non-negotiable principles (provider abstraction, immutable ledger, tenant isolation, delivery-based fallback).
- **Dependencies**: none.
- **Architecture / Implementation scope**: documentation only — no code, no infrastructure, no provider connections.
- **DB/API/Frontend changes**: none.
- **Tests / Security checks / Observability**: none (nothing to test yet).
- **Documentation**: this entire `/docs` set.
- **Acceptance criteria**: product owner reviews and explicitly approves this document set; open decisions in `DECISIONS.md` are acknowledged (not necessarily resolved) before Phase 1 begins.
- **Deployment requirements**: none.
- **Rollback strategy**: none (docs are freely revisable pre-approval).

## 4. Phase 1 — Foundation

- **Objectives**: repo scaffolding (NestJS modular monolith per `ARCHITECTURE.md` §4), CI pipeline skeleton, base Docker Compose stack, IAM/tenancy/RBAC foundation, initial migrations.
- **Dependencies**: Phase 0 sign-off.
- **Architecture**: implements `TENANCY.md`, `RBAC.md` module boundaries; adopts the migration tooling decision already resolved in Phase 0.1 (`DATABASE.md` §14 — Drizzle).
- **Implementation scope**: `iam`, `tenancy` modules; auth (session + API key, not yet SSO/OAuth2); WebSocket ticket issuance (`API.md` §9); base `/health` endpoint; OTel/Prometheus/logging scaffolding wired but with nothing meaningful to instrument yet beyond the foundation itself; the `fn_validate_user_role_scope` DB trigger (`RBAC.md` §6) ships with the first `user_roles` migration, not added later.
- **DB changes**: `organizations, resellers, workspaces, teams, users, roles, permissions, role_permissions, user_roles, api_keys, sessions, ws_tickets, idempotency_keys` (Phase 1A), then `audit_logs` (Phase 1B). `user_roles.scope_type` carries the five canonical scope values (`TENANCY.md` §1a, `DECISIONS.md` B31/ADR-001); `audit_logs.scope_type` carries the same five (`DECISIONS.md` B32/ADR-002). Every tenant-scoped table's RLS policy ships in the same migration as the table, never a later one.
  - **Phase 1A / Gate A** — tenancy, IAM and RBAC foundation (migration `0000`).
  - **Phase 1B** — the immutable audit log (migration `0001`), then identity, tenant context and authorization. `audit_logs` was previously listed only under `DATABASE.md` §12a's "Platform (already built)" domain map and was missing from this Phase 1 list; it is built here. Partitioning it is explicitly deferred with stated criteria (`DATABASE.md` §13, ADR-002), not silently skipped.

### 4a. Phase 1B sub-phases

The audit log (1B.0) is complete. The remaining sub-phases are sequenced by actual dependency: the audit write path comes first because every later step must call it, and retrofitting audit is how audit gaps are created. Decisions governing all of them: ADR-003 (`DECISIONS.md` §1c) and ADR-004 (§1d).

**The 1B.3/1B.4/1B.5 boundary below is the delivered one, corrected by ADR-004.** Phase 1B.3's exit criterion is the authenticated chain proven end to end, and that chain *is* scope resolution, organization selection, tenant context and an RLS-filtered query — so `ScopeResolver`, `X-Acc-Organization` selection, `TenantDatabase.withRequestTenant()` and real-request RLS were all built in 1B.3 rather than 1B.4, and `scopeCovers` and `PermissionEvaluator` came forward from 1B.5 for the same reason. They are not rebuilt or re-separated to match the original table; the table is corrected instead (ADR-004 D-1). The **worker envelope mapper and job tenant-context harness** are deferred from this phase to Phase 2, alongside the first real consumer that can define their execution semantics (ADR-004 D-5).

| Step | Deliverable | Depends on | Exit criteria |
|---|---|---|---|
| **1B.0** | `audit_logs` table, RLS, triggers, grants (migration `0001`) | — | ✅ complete at `db6337e`, 58 tests |
| **1B.1** | Audit write path: `AuditWriter`, centralized recursive redactor, audit module | 1B.0 | Every Phase 1B audit action is writable and asserted; a failed audit insert rolls back its accompanying mutation; `isSecuritySensitiveAction()` has a real caller |
| **1B.2** | Credentials and bootstrap: Argon2id credential service, refresh-token primitives, session service, user-lifecycle service, owner-run bootstrap CLI, `sessions` rotation lineage (migration `0003`) | 1B.1 | ✅ complete — a platform admin exists with a verifiable password; bootstrap is idempotent and audits itself inside its own transaction; concurrent refresh rotation is settled by the database |
| **1B.3** | Authentication and session lifecycle: login, refresh with rotation, logout, session revocation, `AuthGuard`, auth rate limiting | 1B.2 | `RequestContext.setPrincipal()` is called on every authenticated request; `/auth/me` returns a real principal; **plus the end-to-end chain criterion below** — ✅ complete, proven link by link in `auth-chain.int-spec.ts` |
| **1B.4** | Tenant-context hardening and closure: pooled-connection contamination and error-path tests, one generic advisory-identifier cross-check (`AdvisoryTenantGuard`), documentation reconciliation | 1B.3 | §6h's pooled-connection and rollback cases pass against a real pool; no hand-written advisory cross-check remains in any controller; the shared mechanism is declarative and reusable |
| **1B.5** | Authorization correctness and administration, in seven increments (below) | 1B.4 | Every increment's exit criterion met; the full §6b, §6e and §6n matrices pass, each with its mutation |
| **1B.6** | Identity and credentials surface: user invite/update/disable, API-key create/list/revoke, `/audit` read | 1B.5 | The minimum endpoint set is live, audited, rate-limited and IDOR-safe. **Blocked until `DECISIONS.md` D16 (invitation-token delivery) is settled** |
| **1B.7** | Vertical slice, minimal console, Gate B | 1B.6 | Every Gate B criterion below is met |

#### 1B.5 increments

Sequenced by dependency, and the order is load-bearing: the evaluator correction ships **before** any endpoint consumes it. Building role and grant administration on the current evaluator would embed a privilege-escalation primitive in the foundation of the privilege-management API (ADR-005). Each increment is one commit.

| Step | Objective | Schema | Exit criterion |
|---|---|---|---|
| **1B.5.0** | ADR-005 and documentation reconciliation. No code | none | The decisions are recorded and every affected document agrees with them; test counts unchanged |
| **1B.5.1** | Authorization model correction: `RoleGrant` carries its own permissions; the evaluator reads both halves off one grant; the API-key intersection moves to the key's binding scope. No new endpoints | **none** — `role_permissions` already is the per-grant relation | ✅ complete — §6n cases 10–12 and 15 pass; all four mutations fail the suite and were restored; 427 → 480 tests, none weakened |
| **1B.5.2** | Target-scope evaluator: `ScopeChainResolver`, `AuthorizationService`; `TenancyController` migrated onto it. `@RequiresPermission` deferred — target extraction has no established convention and inventing one was rejected | none | ✅ complete — §6n cases 1–9, 13, 14 pass; all five ancestry/boundary mutations fail the suite and were restored; 480 → 530 tests, none weakened |
| **1B.5.3** | Denial auditing: `authorization.denied` written on every refusal of a resolved target, in its own transaction committed before the refusal (ADR-005 D-6), added to `SECURITY_SENSITIVE_AUDIT_ACTIONS` | none — `audit_logs_insert` constrains `acc_app` by tenancy only, not by action vocabulary, so the action was already writable | ✅ complete — §6n cases 23–24 pass; all six denial-audit mutations fail the suite and were restored; 530 → 555 tests, none weakened |
| **1B.5.4** | Role and permission administration: `/roles` CRUD, `/permissions` read, tenant-role seeding at provisioning | `0004` — `user_roles.role_id` to `ON DELETE RESTRICT` | §6n cases 17, 18, 28 pass; `TENANT_ROLE_DEFINITIONS` is actually seeded |
| **1B.5.5** | Grant administration and escalation guards: `/role-assignments`, effective-grant-authority enforcement, `allowedScopeTypes` | none | §6n cases 16, 21, 22, 26, 27, 29 pass; a guard written against the flattened union fails the suite |
| **1B.5.6** | Last-platform-admin protection | `0005` — liveness trigger + advisory-lock key | §6n cases 19–20 pass, including the two-pool concurrent case; removing the lock fails 20 while 19 still passes |
| **1B.5.7** | Adversarial closure: the remaining §6n matrix, `GET /auth/me/authorization`, the declarative `@RequiresPermission` plus §6n case 30's route-table assertion (both deferred from 1B.5.2, and both needing the target-extraction convention the administration endpoints establish), mutation table recorded | none | 0 failed, 0 skipped; every mutation in §6n breaks the suite and is restored |

Two deliberate departures from the obvious ordering. Denial auditing (1B.5.3) comes **before** administration, because it is part of every administrative endpoint's security contract rather than a follow-up to them. Escalation guards merge into 1B.5.5 rather than forming their own increment, because a grant endpoint without its non-escalation guard must not exist even transiently.

#### 1B.3 exit criterion — the authenticated chain, proven end to end

Recorded during the Phase 1B.1 verification pass. `AuditWriter`'s non-transactional branch calls `TenantDatabase.withRequestTenant()`, which today is unreachable: no principal is ever resolved, so it fails closed with `AUTH_CREDENTIAL_REQUIRED`. That branch must not carry its first real traffic unproven.

**Before any authenticated, tenant-scoped API uses the non-transactional `AuditWriter` path, this chain must be demonstrated end to end by an automated test:**

```
AuthGuard
  → RequestContext.setPrincipal()
    → ScopeResolver
      → TenantContext
        → TenantDatabase.withRequestTenant()
          → SET LOCAL
            → acc_app
              → RLS
                → AuditWriter
```

Each link asserted, not merely exercised: the guard resolves a principal from a verified credential only; the principal reaches `RequestContext`; the scope resolver derives tenancy from grants rather than from any claim; `withRequestTenant` establishes that tenancy with `SET LOCAL` inside one transaction; the row written is RLS-filtered under `acc_app`; and the audit row lands with the derived tenancy. A failure at any link must fail closed rather than fall through to an unscoped write.

Until that test exists, callers use the transactional `record(input, tx)` form, which is in any case what ADR-003 D-2 requires for every security-sensitive action.

### 4b. Gate B — Phase 1B acceptance

Objectively testable; each is pass/fail.

- **Build and hygiene** — `format:check`, `lint`, `typecheck`, `build` and `audit` all clean.
- **Migrations** — `db:reset` from empty applies and seeds; `db:migrate` re-run is a no-op; `drizzle-kit generate` reports no drift; any new tenant-scoped table ships RLS in its creating migration; bootstrap is idempotent.
- **Authentication** (§6k) — login/refresh/logout/revocation, rotation-reuse chain revocation, no user enumeration, no token in any URL, refresh cookie not JavaScript-readable, auth rate limiting effective on both buckets.
- **Authorization** (§6b, §6e, §6n) — the full `scopeCovers` matrix including positive downward inheritance; vertical escalation refused at every adjacent pair; role-assignment escalation refused; cross-tenant grant refused by the service **and** independently by the trigger with the service bypassed.
- **Authorization coherence** (§6n) — no decision is reachable by combining a permission from one grant with a scope from another. Proven by the multi-grant cases in §6b, and by the mutation that restores the flattened union failing the suite.
- **Chain provenance** — every `ScopeChain` a coverage decision rests on originates from a database read inside the request's own tenant transaction; the mutation substituting request input fails the suite.
- **Target-scope coverage is mechanical** — every scoped route performs exactly one target-scope check, asserted against the registered route table rather than by review.
- **Non-escalation** — no actor confers a `(permission, scope)` pair outside its own effective grant authority, tested at organization, workspace and team level.
- **Platform-admin liveness** — at least one active platform administrator exists at every committed state, enforced by a database trigger and proven under genuine concurrency on two independent pools.
- **Role lifecycle** — role deletion refused while grants exist; every revocation individually audited; no unaudited cascade.
- **Denial auditing** — every refusal writes `authorization.denied` carrying the actor's own legitimate scope, with the attempted target in metadata and in neither the response body nor the actor's scope.
- **API-key intersection** — taken at the key's binding scope, not the creator's widest scope, and re-evaluated at use.

**What "authorization" means at Gate B, stated plainly.** Phase 1B ships **RBAC with scope coverage**: permissions bundled into roles, granted at a scope, evaluated per coherent grant against a target whose ancestry is resolved from the database. **ABAC attribute conditions are not implemented.** `RBAC.md` §1 describes RBAC *and* ABAC, and the attribute half — `resource.owner_id == user.id`, business-hour and IP-range conditions, the pluggable policy shape — exists as a documented insertion point on `PermissionEvaluator` and nothing more (`DECISIONS.md` D21). Gate B is not weakened to accommodate this; it is stated so that "authorization is production-grade" is a claim about something specific rather than about everything `RBAC.md` §1 mentions.
- **Tenant isolation** (§6a, §6c, §6d, §6f, §6g, §6h) — including the RLS negative control and the pooled-connection error path. §6h's worker half is **not** required at Gate B: no worker exists in Phase 1B, and the harness is deferred with a recorded decision (ADR-004 D-5), exactly as §6i's WebSocket gateway is.
- **Workspace/team scope** — a workspace-scoped principal cannot reach a sibling workspace or the organization above it, proven **with RLS satisfied**, since RLS does not enforce below organization (`TENANCY.md` §3a).
- **Tenant-context selection** (§6l) and **bootstrap** (§6m).
- **API keys** — org binding, revoked/expired rejection, effective-permission intersection re-evaluated at use, secret shown exactly once and never audited.
- **Audit** (§6j plus Phase 1B actions) — every operation writes its specified action, actor, scope and outcome; security-sensitive writes roll back with their mutation; redaction proven against nested and array payloads; unknown-user failures recorded as the approved anonymous form.
- **Negative security** — the `security` Jest project is populated: IDOR sweep, token-in-query rejection, rate-limit bypass attempts, direct `user_roles`/`role_permissions` manipulation, revoked-session token reuse.
- **Frontend** — login → `/auth/me` → context render → logout smoke test; no token in `localStorage` or any URL.
- **Regression** — the full suite green, with Gate A's schema tests and the existing `@acc/api` tests unchanged.

**Explicitly not required at Gate B**, each deferred with a recorded decision: MFA (D10), password reset (D12), account lockout (D13), API-key rotation lineage (D14), WebSocket ticket consumption and the socket gateway (D15 — so `TESTING.md` §6i is only partly satisfiable), OAuth2/SSO (D6), scope-set caching (D11), ABAC attribute conditions and policy authoring (D21), cross-user authorization introspection (D23), the queued audit transport (ADR-003 D-2), and the worker/job tenant-context harness (ADR-004 D-5 — so `TESTING.md` §6h is satisfied for its pooled-connection half only).
- **API changes**: `/auth` (login, refresh, logout, sessions — no MFA challenge, ADR-003 D-6), `/tenants`, `/users`, `/roles`, `/role-assignments`, `/permissions`, `/api-keys`, `/audit`, `/ws/ticket` (issuance only), `/health`.
- **Frontend changes**: Next.js app skeleton, login flow, tenant/user management console screens.
- **Tests**: unit + integration for auth/RBAC/tenant isolation, following the matrix in `TESTING.md` §6 — horizontal isolation at every scope level, vertical escalation between every adjacent pair, scope substitution, enumeration, role-assignment escalation, parent-child integrity, direct database RLS proof through the non-owner principal (including a negative control that would fail if RLS were absent), and WebSocket ticket expiry/reuse/binding. Phase 1B adds the audit-log matrix in `TESTING.md` §6j — append-only (UPDATE/DELETE/TRUNCATE), scope derivation and integrity, actor integrity, `acc_auth` confinement, organization-deletion behaviour, and its own RLS negative control.
- **Security checks**: session hardening review, RLS policy verification per table.
- **Observability**: base dashboards for API latency/errors, auth failure rate.
- **Documentation**: update `TENANCY.md`/`RBAC.md`/`DATABASE.md` with any implementation-driven refinements.
- **Acceptance criteria**: a user can register/log in, be assigned roles at any valid scope of the canonical hierarchy, and the full `TESTING.md` §6 isolation matrix passes — including the negative cross-tenant tests and the negative control proving the suite would fail if RLS were weakened.
- **Deployment requirements**: Dev environment stood up.
- **Rollback strategy**: standard app rollback (`DEPLOYMENT.md` §7); no external-facing risk yet.

## 5. Phase 2 — Provider abstraction + simulator

- **Objectives**: implement `provider-registry`, `provider-adapters` (interface + `SimulatorAdapter` only), health/circuit breaker mechanics, admin hot-reload plumbing.
- **Dependencies**: Phase 1.
- **Architecture**: `PROVIDER_ADAPTER.md` in full.
- **Implementation scope**: registry CRUD, credential-reference storage (secrets backend integration), health state machine, circuit breaker, simulator behaviors (`TESTING.md` §2).
- **DB changes**: `channels, providers, provider_credentials, provider_capabilities, provider_health`.
- **API changes**: `/channels`, `/providers`.
- **Frontend changes**: provider list/detail console screens (read + basic admin actions).
- **Tests**: full simulator-behavior matrix; hot-reload verification (change provider config, confirm no restart needed).
- **Security checks**: credential-reference-only storage verified (no plaintext secret ever hits the app DB or logs).
- **Observability**: provider health/circuit dashboards live.
- **Documentation**: `PROVIDER_ADAPTER.md` refined with implementation specifics.
- **Acceptance criteria**: admin can add/disable/drain a simulated provider and see health/circuit state change with no deploy.
- **Deployment requirements**: Dev + Staging.
- **Rollback strategy**: provider config changes are already versioned/reversible by design; app-level rollback otherwise standard.

## 6. Phase 3 — WhatsApp

- **Objectives**: first real channel's routing/eligibility path built end-to-end (still against the simulator, unless/until explicit separate authorization is given to connect a real provider).
- **Dependencies**: Phase 2.
- **Architecture**: `ROUTING_ENGINE.md`, `EVENTS.md` message lifecycle events, `contacts`/`consents`/`suppressions`.
- **Implementation scope**: `comms-api`, `orchestrator`, `channel-router`, `eligibility` for a single channel; `contacts` module; template model with WhatsApp-specific approval-status handling.
- **DB changes**: `contacts, contact_identities, consents, suppressions, conversations, messages, message_attempts, message_events, templates`.
- **API changes**: `/messages`, `/contacts`, `/templates`.
- **Frontend changes**: contact management, template management, basic send-test console screen.
- **Tests**: full message lifecycle state machine tests; idempotency-key dedup tests; webhook dedup/replay tests against the simulator.
- **Security checks**: webhook signature verification path reviewed.
- **Observability**: message-funnel dashboard live for one channel.
- **Documentation**: `ARCHITECTURE.md` §§5–6, `EVENTS.md` catalogue refined against real implementation.
- **Acceptance criteria**: a message can be sent, tracked through lifecycle states, and appear correctly in `message_events`/`audit_logs`, entirely via the simulator.
- **Deployment requirements**: Dev + Staging.
- **Rollback strategy**: standard; no financial/fallback complexity yet (single channel, single attempt).

## 7. Phase 4 — SMS + RCS

- **Objectives**: extend the channel set; validate the abstraction genuinely generalizes to a second and third channel without core changes.
- **Dependencies**: Phase 3.
- **Architecture**: same as Phase 3, generalized; DLT-awareness placeholder in Eligibility Engine for SMS.
- **Implementation scope**: additional `SimulatorAdapter` configurations per channel; channel-specific template/capability handling.
- **DB/API/Frontend changes**: incremental (no new tables required beyond what Phase 3 established; `channels` rows added for `sms`, `rcs`).
- **Tests**: cross-channel eligibility tests (e.g., DLT-block suppression on SMS only).
- **Security checks**: none beyond Phase 3's baseline, reapplied.
- **Observability**: funnel dashboards extended per channel.
- **Documentation**: confirm no core-module change was needed to add these channels (validates the architectural principle in practice — call out any exception found).
- **Acceptance criteria**: same send/track/audit flow proven for SMS and RCS via the simulator.
- **Deployment requirements**: Dev + Staging.
- **Rollback strategy**: standard.

## 8. Phase 5 — Provider/channel failover

- **Objectives**: implement `fallback-engine` in full, including delayed-timer scheduling and its PostgreSQL conditional-transaction escalation guard (the correctness boundary, `FALLBACK_ENGINE.md` §4); Redis MAY be added purely as an optional fast-path accelerator to reduce contention/duplicate scheduler work, never as a required correctness mechanism (`ARCHITECTURE.md` §9c).
- **Dependencies**: Phase 4 (needs ≥2 channels and ≥2 simulated providers per channel to exercise real chains).
- **Architecture**: `FALLBACK_ENGINE.md` in full.
- **Implementation scope**: `fallback_policies`/`fallback_steps` CRUD, the `deadline_at`-based Postgres poller (`FOR UPDATE SKIP LOCKED`) and its conditional-transaction escalation guard (`FALLBACK_ENGINE.md` §4 — the DB-is-source-of-correctness pattern resolved in Phase 0.1), the per-step re-evaluation sequence (`ARCHITECTURE.md` §3b), fallback-attempt chain persistence. **Billing is out of scope for implementation in this phase** — `usage_ledger`, wallets, and the Pricing & Rating Engine do not yet exist (Phase 7). Where the orchestrator needs a billing integration point (e.g. emitting a `provider_cost`/`customer_charge`-shaped event or call per attempt), it is wired against the architecture's defined contract (`EVENTS.md` §5, `BILLING.md` §§1–2) with a stub/no-op consumer on the billing side — Phase 5 must not build a temporary ledger, wallet, or reservation implementation of its own merely to make the critical scenario test's billing assertion pass early; doing so would create throwaway code that Phase 7 would then have to replace.
- **DB changes**: `fallback_policies, fallback_steps`.
- **API changes**: `/fallback-policies`.
- **Frontend changes**: fallback chain configuration console screens.
- **Tests**: the mandatory critical scenario test (`TESTING.md` §3) — this phase's primary acceptance gate, scoped per `TESTING.md` §3 item 7 to a billing *integration-contract* check (the correct event/call shape is emitted once per attempt and once at chain terminal state), not full financial correctness.
- **Security checks**: race-condition review of the DB conditional-transition escalation guard; Redis lock-contention review only to the extent Redis is used as an optional accelerator.
- **Observability**: fallback-trigger-rate metric live.
- **Documentation**: `FALLBACK_ENGINE.md` refined with real timer-implementation detail.
- **Acceptance criteria**: the critical scenario test passes, verifying routing correctness, eligibility correctness, provider failover, channel failover, combined provider+channel failover, attempt persistence, correct attempt numbering, idempotency, race-condition protection (the DB conditional transition, not Redis, determines which worker wins), correct late-webhook-vs-timer behavior, correct event emission, auditability, correct final message state, and no duplicate internal business outcome — plus the billing integration-contract check above. **Full financial correctness (real ledger entries, real reservation release, real billing-policy-accurate charges) is formally validated in Phase 7** (`ROADMAP.md` §10), once the immutable ledger and Pricing & Rating Engine exist; it is explicitly not a Phase 5 acceptance requirement.
- **Deployment requirements**: Dev + Staging; chaos testing (`TESTING.md` §4) run in Staging before sign-off.
- **Rollback strategy**: fallback policy changes versioned/reversible like routing policies; app-level rollback otherwise standard.

## 9. Phase 6 — Admin control center

- **Objectives**: full admin UI/API for provider/routing/fallback management, canary migration, health thresholds.
- **Dependencies**: Phases 2–5.
- **Architecture**: `ROUTING_ENGINE.md` §§4–6, `PROVIDER_ADAPTER.md` §4.
- **Implementation scope**: `routing_policies`/`routing_policy_versions` CRUD + activation UI, canary ramp tooling, provider test-send UI.
- **DB changes**: `routing_policies, routing_policy_versions`.
- **API changes**: `/routing`.
- **Frontend changes**: full admin control center screens (provider health board, routing policy editor with version history/diff/rollback, canary ramp UI).
- **Tests**: policy-version activation/rollback tests; canary ramp behavior tests.
- **Security checks**: RBAC review — only appropriately-privileged roles can reach these screens/endpoints.
- **Observability**: routing-decision distribution dashboard (which policy/provider was chosen, how often).
- **Documentation**: `ROUTING_ENGINE.md` refined.
- **Acceptance criteria**: an admin can perform every operation listed in `PROVIDER_ADAPTER.md` §4 without a deploy, including a full canary migration and rollback.
- **Deployment requirements**: Staging sign-off before Production.
- **Rollback strategy**: as above — this phase's whole point is making config changes safely reversible; verify that in practice.

## 10. Phase 7 — Billing

- **Objectives**: implement the immutable usage ledger, wallets, credit accounts, invoicing, GST placeholder logic, and the Pricing & Rating Engine (`BILLING.md` §§10–17) that separates transaction/usage from what it's worth from what is actually billed.
- **Dependencies**: Phase 3+ (needs real message/attempt cost data flowing) and Phase 5 (fallback billing interaction).
- **Architecture**: `BILLING.md` in full, including §§10–17 (Pricing & Rating Engine, pricing vs. billing policy separation, pricing versioning, attempt-level pricing).
- **Implementation scope**: `billing` module, ledger-writer consumer (`EVENTS.md` §5), the `FOR UPDATE`-based reservation/authorization flow (`BILLING.md` §8, `DATABASE.md` §10a — resolved in Phase 0.1), invoice generation job, wallet/auto-recharge threshold logic (no real payment processor connected), the Pricing & Rating Engine (`pricing_plans`/`pricing_plan_versions`/`pricing_rules`/`provider_cost_rates`/`customer_pricing_assignments`/`pricing_evaluations`/`pricing_evaluation_components`, `DATABASE.md` §10b) supporting at minimum `charge_per_logical_message`/`charge_per_attempt` billing policies against a per-message, single-component pricing evaluation (the minimum needed to prove the architecture's extensibility — multi-component evaluations and additional pricing models from `BILLING.md` §13 are implemented incrementally, not all in Phase 7).
- **DB changes**: `wallets, credit_accounts, usage_ledger, invoices, payments, adjustments, pricing_plans, pricing_plan_versions, pricing_rules, provider_cost_rates, customer_pricing_assignments, pricing_evaluations, pricing_evaluation_components`.
- **API changes**: `/billing`, `/wallets`.
- **Frontend changes**: wallet/invoice/ledger-detail console screens.
- **Tests**: ledger-derivation consistency tests (materialized balance must always equal fresh ledger aggregation); fallback-chain billing test (extends Phase 5's critical scenario); pricing-versioning test (a pricing plan edit does not alter a previously-rated transaction's ledger entries — `BILLING.md` §15).
- **Security checks**: financial-data access RBAC review; adjustment/refund approval-flow review.
- **Observability**: billing-specific dashboards (revenue, cost, margin).
- **Documentation**: `BILLING.md` refined.
- **Acceptance criteria**: the critical scenario test (`TESTING.md` §3) passes its billing assertions against real ledger data, not a stub.
- **Deployment requirements**: Staging sign-off with finance/product-owner review before Production (financial correctness gate, not just engineering QA).
- **Rollback strategy**: ledger is append-only — "rollback" of a bad billing deploy means shipping a fix plus corrective `adjustments`, never editing history.

## 11. Phase 8 — Engagement Layer & Experience Applications (8A–8G)

Phase 8 is a family of sub-phases building the Engagement Layer and Experience Applications (`ARCHITECTURE.md` §21) strictly as callers of the Communication Core (Phases 1–7) — none of them introduce a new send path or a parallel provider integration (`ARCHITECTURE.md` §§22, 26). 8A–8D carry forward what this document previously specified as a single "Campaigns + journeys + inbox" phase (now split for clearer sequencing and acceptance gates); 8E–8G are new, lighter-weight sub-phases establishing the remaining Experience Applications named in `ARCHITECTURE.md` §21a — architected for now, not necessarily built immediately after 8D.

### 11a. Phase 8A — Contacts / CDP

- **Objectives**: extend `contacts`/`contact_identities` (already present since Phase 3) into a full CDP: custom fields, tags, segments, imports/exports, customer timeline, identity resolution (`ARCHITECTURE.md` §21b).
- **Dependencies**: Phase 3 (`contacts` foundation).
- **Implementation scope**: `contacts` module extensions; segment definition/evaluation; import/export tooling.
- **DB changes**: extensions to `contacts` (custom fields/tags as JSONB or a normalized attributes table, finalized at this phase's design stage), a `segments` table (conceptual, `DATABASE.md` §12a).
- **API changes**: `/contacts` extended (segments, imports/exports).
- **Acceptance criteria**: contacts can be segmented and a segment can be resolved to a recipient set consumable by Phase 8B campaigns.

### 11b. Phase 8B — Campaigns

- **Objectives**: build the campaign send-orchestration layer as a caller of the existing core.
- **Dependencies**: Phase 8A (segments), Phase 7 (billing must exist so bulk sends are correctly charged).
- **Architecture**: `ARCHITECTURE.md` §11.
- **Implementation scope**: `campaigns` module.
- **DB changes**: `templates` (if not already present), `campaigns, campaign_recipients`.
- **API changes**: `/campaigns`.
- **Frontend changes**: campaign builder.
- **Tests**: campaign throttle/schedule tests.
- **Security checks**: verify campaigns cannot bypass consent/suppression (`ARCHITECTURE.md` §12 constraint).
- **Observability**: campaign progress dashboards.
- **Acceptance criteria**: a campaign can drive messages through the full routing/fallback/billing pipeline identically to a direct API call.
- **Deployment requirements**: Staging sign-off; load test bulk-campaign throughput before Production.
- **Rollback strategy**: standard app rollback; `campaign_recipients` is itself durable so a rollback does not lose send-progress bookkeeping.

### 11c. Phase 8C — Journeys / Automation

- **Objectives**: build the journey/automation workflow engine as a caller of the existing core.
- **Dependencies**: Phase 8B (journeys can trigger campaign-like sends), Phase 7 (billing).
- **Architecture**: `ARCHITECTURE.md` §12.
- **Implementation scope**: `journeys` module; event triggers, scheduled triggers, conditions, branching, delays, actions (webhook/API/CRM actions, human handoff, AI handoff — `ARCHITECTURE.md` §21b; CRM/AI handoff targets are no-ops or stubs until Phases 8F/10 exist).
- **DB changes**: `journeys, journey_versions, journey_executions`.
- **API changes**: `/journeys`.
- **Frontend changes**: journey builder (graph editor).
- **Tests**: journey branching/versioning tests.
- **Security checks**: verify journeys cannot bypass consent/suppression (`ARCHITECTURE.md` §12 constraint).
- **Observability**: journey progress dashboards.
- **Acceptance criteria**: a journey can drive messages through the full routing/fallback/billing pipeline identically to a direct API call.
- **Deployment requirements**: Staging sign-off.
- **Rollback strategy**: standard app rollback; `journey_executions` is itself durable.

### 11d. Phase 8D — Unified Inbox / Conversations

- **Objectives**: build the multi-channel unified inbox as a caller of the existing core, per `ARCHITECTURE.md` §21c.
- **Dependencies**: Phase 4 (≥2 channels needed for a meaningful multi-channel inbox), Phase 8A (contacts).
- **Architecture**: `ARCHITECTURE.md` §13, §21c.
- **Implementation scope**: `conversations` module; OpenSearch inbox indexing; team/agent assignment, routing, internal notes, SLA (`ARCHITECTURE.md` §21b Conversation Engine).
- **DB changes**: `conversations` (already present, extended with assignment/SLA fields at this phase's design stage), conceptual `conversation_participants` (`DATABASE.md` §12a).
- **API changes**: `/conversations`.
- **Frontend changes**: unified inbox UI, WebSocket-driven live updates.
- **Tests**: inbox threading/search tests.
- **Documentation**: this file and `ARCHITECTURE.md` updated with any scope refinement discovered (e.g., final decision on cross-channel conversation grouping, `DECISIONS.md`).
- **Acceptance criteria**: inbound/outbound messages across at least two channels thread correctly into one conversation model, with provider identity remaining metadata only (`ARCHITECTURE.md` §21c).
- **Deployment requirements**: Staging sign-off.
- **Rollback strategy**: standard app rollback.

### 11e. Phase 8E — Chatbot / Flow Builder

- **Objectives**: build the visual chatbot/flow builder described in `ARCHITECTURE.md` §23, strictly as a caller of the Communication API.
- **Dependencies**: Phase 8C (journeys — the flow builder shares the action/branching vocabulary), Phase 8D (inbox — human handoff target).
- **Architecture**: `ARCHITECTURE.md` §23.
- **Implementation scope**: flow definition/versioning, the node types listed in `ARCHITECTURE.md` §23; detailed schema/API finalized at this phase's design stage (deliberately not specified in this pass, per Part 28's "do not over-specify future features" principle).
- **Security checks**: verify no flow node can reach a provider adapter directly — every send/API-call node routes through the Communication API (`ARCHITECTURE.md` §26).
- **Acceptance criteria**: a flow can be authored, activated, and driven by inbound messages, with every send traceable through ordinary Eligibility → Routing → Fallback (`ARCHITECTURE.md` §23).
- **Deployment requirements**: Staging sign-off.
- **Rollback strategy**: standard app rollback; flow versioning mirrors journey versioning.

### 11f. Phase 8F — CRM / Sales

- **Objectives**: build leads/pipeline/stage/assignment capability on top of the existing `contacts` model, per `ARCHITECTURE.md` §21a, §24.
- **Dependencies**: Phase 8A (contacts), Phase 8D (conversation-to-lead conversion).
- **Implementation scope**: conceptual `leads`/`pipelines`/`pipeline_stages`/`assignments` (`DATABASE.md` §12a); schema/API finalized at this phase's design stage.
- **Security checks**: verify leads resolve to the same `contacts` row as inbox/campaign recipients — no parallel identity table (`ARCHITECTURE.md` §24).
- **Acceptance criteria**: a conversation can be converted to a lead and tracked through a pipeline without creating a second customer identity.
- **Deployment requirements**: Staging sign-off.
- **Rollback strategy**: standard app rollback.

### 11g. Phase 8G — Commerce Integrations

- **Objectives**: catalog messaging, order notifications, abandoned-cart and commerce workflows (`ARCHITECTURE.md` §21a), built as journey/campaign actions and channel-specific interactive message types, never a direct commerce-provider-to-messaging-provider integration.
- **Dependencies**: Phase 8C (journeys — commerce workflows are journeys with commerce-specific triggers/actions), Phase 3 (WhatsApp interactive/catalog message support, channel-specific).
- **Implementation scope**: commerce event triggers (order placed, cart abandoned) feeding into existing journey triggers; schema/API finalized at this phase's design stage.
- **Acceptance criteria**: a commerce event can trigger a journey that sends through the ordinary Communication API path.
- **Deployment requirements**: Staging sign-off.
- **Rollback strategy**: standard app rollback.

## 12. Phase 9 — Reseller + white-label

- **Objectives**: reseller-scoped management, markup, and branding.
- **Dependencies**: Phase 7 (billing markup, pricing plan assignment), Phase 1 (tenancy). Reseller-scoped ownership of Engagement Layer data (own templates/campaigns/inbox — `ARCHITECTURE.md` §16) rides on whichever of Phases 8A–8D have shipped by this point; it requires no schema change of its own since those modules are already `org_id`-scoped and a reseller's access is derived transitively via `reseller_id` (`TENANCY.md` §4).
- **Architecture**: `TENANCY.md` §4, `BILLING.md` §6, `ARCHITECTURE.md` §16.
- **Implementation scope**: `resellers` module, branding/domain resolution, reseller reporting, reseller-scoped `pricing_plan`/`customer_pricing_assignments` (`DATABASE.md` §10b), own API credentials (already supported by `provider_credentials` scope resolution, `PROVIDER_ADAPTER.md` §4a).
- **DB changes**: (largely already present — `resellers` from Phase 1; this phase is mostly service/API/frontend work atop it).
- **API changes**: `/resellers`.
- **Frontend changes**: reseller admin console, white-label theming.
- **Tests**: reseller-scoping isolation tests (a reseller admin cannot see another reseller's organizations).
- **Security checks**: reseller-scope RBAC review.
- **Observability**: reseller-level revenue/health dashboards.
- **Documentation**: `TENANCY.md` refined.
- **Acceptance criteria**: a reseller admin can manage their organizations end-to-end under their own branding with correct isolation and correct markup billing.
- **Deployment requirements**: Staging sign-off.
- **Rollback strategy**: standard.

## 13. Phase 10 — AI

- **Objectives**: build the AI Gateway as a provider-agnostic layer, mirroring the Communication Gateway pattern.
- **Dependencies**: Phase 7 (usage ledger pattern reused for AI cost).
- **Architecture**: `ARCHITECTURE.md` §18.
- **Implementation scope**: `ai-gateway` module, `ai_providers`/`ai_models`/`ai_usage`, at least one simulated AI adapter for testing (no real AI vendor connected without separate explicit authorization, same principle as messaging providers).
- **DB changes**: `ai_providers, ai_models, ai_usage`.
- **API changes**: internal AI Gateway API (external surface, if any, added under a versioned path at this phase's design stage).
- **Frontend changes**: AI usage/cost dashboards; any AI-assisted console features gated behind this gateway, never calling an AI vendor directly.
- **Tests**: AI-provider-abstraction swap test (mirrors the messaging provider-swap principle).
- **Security checks**: AI input/output handling reviewed for injection/data-leakage risk (e.g., not leaking cross-tenant content into a prompt).
- **Observability**: AI cost/latency dashboards.
- **Documentation**: this file and `ARCHITECTURE.md` refined.
- **Acceptance criteria**: an AI feature can have its underlying model/provider swapped via configuration, with zero business-logic change, and its cost recorded in the same ledger discipline as messaging.
- **Deployment requirements**: Staging sign-off.
- **Rollback strategy**: standard; AI provider swap itself is a config change per the abstraction, not a deploy.

## 14. Phase 11 — Migration center

- **Objectives**: build tooling to migrate customers off existing third-party/white-label platforms without a big-bang cutover.
- **Dependencies**: Phases 3–8D (need a functioning core plus contacts/campaigns/journeys/inbox to migrate customers onto; 8E–8G are not required for a migration to be viable).
- **Architecture**: dedicated migration-import pipeline (contacts, templates, conversation history) + dual-run period support (old platform and ACC both receiving read traffic/reporting while ACC ramps up send traffic via the same canary-ramp mechanism as provider migration, `ROUTING_ENGINE.md` §6).
- **Implementation scope**: import tooling (contacts/consents/templates/historical conversations), reconciliation reporting (does ACC's view of a migrated customer's data match the source system), staged cutover runbook.
- **DB changes**: possibly a `migration_jobs`/`migration_records` tracking table set (finalized at this phase's design stage).
- **API changes**: internal migration tooling API, not customer-facing.
- **Frontend changes**: migration status/reconciliation console screens (internal/admin only).
- **Tests**: import correctness/reconciliation tests against representative sample data shapes from prior platforms.
- **Security checks**: imported credential/PII handling review (imported contact data must immediately be subject to the same consent/suppression/masking rules as natively-created data).
- **Observability**: migration job progress/error dashboards.
- **Documentation**: a new `MIGRATION.md` authored at this phase's design stage.
- **Acceptance criteria**: a representative customer can be migrated with reconciled data and a controlled, reversible cutover (rollback = route traffic back to the prior platform, which the canary mechanism supports by construction).
- **Deployment requirements**: Staging sign-off; a real pilot migration executed and reviewed before general availability.
- **Rollback strategy**: staged cutover is designed to be reversible at every ramp step, mirroring provider canary rollback.

## 15. Phase 12 — Production hardening

- **Objectives**: close every "placeholder" flagged through Phases 0–11 (`DECISIONS.md`), validated DR drills, full security review, load/chaos testing at production-representative scale.
- **Dependencies**: all prior phases.
- **Architecture**: no new architecture — this phase validates and hardens existing architecture.
- **Implementation scope**: performance tuning, capacity planning, finalized RTO/RPO validated by an actual restore drill (`DR.md` §3), full OWASP/security-testing pass, finalized regulatory-alignment review with qualified professionals (`SECURITY.md` §7).
- **DB/API/Frontend changes**: hardening fixes only, no new features.
- **Tests**: full regression across all layers (`TESTING.md`); chaos and load tests at production-representative volumes.
- **Security checks**: full external or independent internal security review before general production launch with real providers.
- **Observability**: alerting thresholds finalized against real (not placeholder) SLOs.
- **Documentation**: every `/docs` file reviewed and reconciled against actual shipped behavior; any remaining `DECISIONS.md` items either resolved or explicitly accepted as ongoing risk by the product owner.
- **Acceptance criteria**: a DR drill succeeds within target RTO/RPO; the critical fallback scenario and full regression suite pass at production scale; product owner sign-off to connect the first real external provider (a decision explicitly outside this repository's Phase 0–12 engineering scope — connecting a real provider is a business/legal/commercial decision made separately, with real credentials never requested or handled casually).
- **Deployment requirements**: full production environment provisioned and validated.
- **Rollback strategy**: this phase is where rollback/DR procedures themselves get proven, not just documented.

## 16. Related

Open questions that could reshape specific phases above: `DECISIONS.md`.
