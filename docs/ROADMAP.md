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

**Status: COMPLETE.** Gate C (§4d) APPROVED / CLOSED, 02-Oct-2026 (`DECISIONS.md` ADR-012, "Gate C closure"). Phase 2 is authorized to begin after its read-only scope audit.

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
| **1B.6** | Identity and credentials surface, in four increments (below): user lifecycle, API-key management, `/audit-logs` read, general rate limiting | 1B.5 | The minimum endpoint set is live, audited, **rate-limited** and IDOR-safe. **No longer blocked on `DECISIONS.md` D16** — ADR-007 D-5 separates the lifecycle API from credential delivery, so 1B.6.1 ships without it and only *delivery* waits |
| **1B.7** | Vertical slice, minimal console, Gate B | 1B.6 | Every Gate B criterion below is met |

#### 1B.5 increments

Sequenced by dependency, and the order is load-bearing: the evaluator correction ships **before** any endpoint consumes it. Building role and grant administration on the current evaluator would embed a privilege-escalation primitive in the foundation of the privilege-management API (ADR-005). Each increment is one commit.

| Step | Objective | Schema | Exit criterion |
|---|---|---|---|
| **1B.5.0** | ADR-005 and documentation reconciliation. No code | none | The decisions are recorded and every affected document agrees with them; test counts unchanged |
| **1B.5.1** | Authorization model correction: `RoleGrant` carries its own permissions; the evaluator reads both halves off one grant; the API-key intersection moves to the key's binding scope. No new endpoints | **none** — `role_permissions` already is the per-grant relation | ✅ complete — §6n cases 10–12 and 15 pass; all four mutations fail the suite and were restored; 427 → 480 tests, none weakened |
| **1B.5.2** | Target-scope evaluator: `ScopeChainResolver`, `AuthorizationService`; `TenancyController` migrated onto it. `@RequiresPermission` deferred — target extraction has no established convention and inventing one was rejected | none | ✅ complete — §6n cases 1–9, 13, 14 pass; all five ancestry/boundary mutations fail the suite and were restored; 480 → 530 tests, none weakened |
| **1B.5.3** | Denial auditing: `authorization.denied` written on every refusal of a resolved target, in its own transaction committed before the refusal (ADR-005 D-6), added to `SECURITY_SENSITIVE_AUDIT_ACTIONS` | none — `audit_logs_insert` constrains `acc_app` by tenancy only, not by action vocabulary, so the action was already writable | ✅ complete — §6n cases 23–24 pass; all six denial-audit mutations fail the suite and were restored; 530 → 555 tests, none weakened |
| **1B.5.4** | Role and permission administration: `/roles` CRUD, `/permissions` read, `TenantRoleProvisioner` for tenant-role seeding, `roles.allowed_scope_types` and system-role protection | `0004` — `user_roles.role_id` to `ON DELETE RESTRICT`, `roles.allowed_scope_types`, system-role triggers | ✅ complete — §6n cases 17 and 18 pass; all six role-administration mutations fail the suite and were restored; 555 → 601 tests, none weakened |
| **1B.5.5** | Grant administration and escalation guards: `/role-assignments`, effective-grant-authority enforcement, `allowedScopeTypes` **grant-time** enforcement against the column 1B.5.4 added | none — `roles.allowed_scope_types` ships in `0004`, and the duplicate/race semantics rest on `0000`'s unique indexes and `0004`'s `ON DELETE RESTRICT` | ✅ complete — §6n cases 16, 21, 22, 26, 27, **28** and 29 pass; the flattened-union guard fails the suite, as do all eight security mutations; 601 → 648 tests, none weakened |
| **1B.5.6** | Last-platform-admin protection | `0005` — `fn_assert_platform_admin_remains`, row-level `AFTER` triggers on `user_roles` (DELETE) and `users` (UPDATE OF status), and `PLATFORM_ADMIN_LOCK_KEY` exported from `@acc/db` | ✅ complete — §6n cases 19–20 pass, including six concurrent cases that assert the **final database state** rather than status codes; all eight security mutations fail the suite and were restored; 648 → 675 tests, none weakened |
| **1B.5.7** | Adversarial closure: `GET /auth/me/authorization`, the declarative `@RequiresPermission` plus `AuthorizationCoverageInterceptor` and §6n case 30's route-table assertion (both deferred from 1B.5.2, and both needing the target-extraction convention the administration endpoints established), mutation table recorded | none | ✅ complete — case 30 passes against the container's own route table; 23 routes classified with none silent; all eight security mutations fail the suite and were restored; 675 → 707 tests, none weakened |
| **1B.5.8** | API conventions: the `{data}` / `{data, page}` envelope, signed cursor pagination, allow-listed filters and sorts, field-level validation issues — applied to every list endpoint rather than a representative one, because a convention applied selectively is not one | `0006` — one composite index per list's default ordering, matching the keyset predicate | ✅ complete — every list endpoint normalized; eight convention mutations accounted for; 707 → 748 tests, none weakened; `FRONTEND_API_CONTRACT.md` stays **DRAFT** with its remaining blockers named |
| **1B.5.9** | HTTP idempotency: `Idempotency-Key` on the two creating endpoints, claim/mutate/finalize in **one** transaction, concurrency settled by the existing unique index, only successes stored | `0007` — actor and correlation columns on `idempotency_keys`, diagnostic rather than a uniqueness term | ✅ complete — 748 → 807 tests; twelve mutations executed, ten detected end to end and two only at unit level because the unique index is the real boundary there; `FRONTEND_API_CONTRACT.md` stays **DRAFT** |

**§6n case 28 belongs to 1B.5.5, not 1B.5.4.** The 1B.5.4 row previously listed it, which contradicted `RBAC.md` §7 ("enforced from Phase 1B.5.5"), `DECISIONS.md` ADR-005's debt table and 1B.5.5's own scope cell. The contradiction is resolved in favour of the three: case 28 tests a *grant*, and there is no grant API until 1B.5.5. The split is that 1B.5.4 gives `allowed_scope_types` its value — column, constraints, seeding and role CRUD all persist it — and 1B.5.5 is what consults it at grant time. Adding the column in `0004` rather than later is what lets 1B.5.4 seed `TENANT_ROLE_DEFINITIONS` without discarding the property.

**Idempotency is one transaction, and that decision cost the documented `409`-while-in-flight.** `API.md` §4 previously promised an immediate `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` to a concurrent duplicate. That answer is only reachable if the claim commits separately from the mutation — which is exactly the crash window the mechanism exists to close. Sharing one transaction means a duplicate *blocks* on the original and then replays it, which is also the better answer: the caller gets the real result instead of polling. The `409` is retained for the one case that remains reachable, the wait exceeding `lock_timeout` (ADR-006 D-1).

**The conventions were applied to every list endpoint, not a representative subset.** The brief asked for roles, role assignments and at least one more. Stopping there would have left `/permissions`, `/tenants/workspaces` and `/auth/sessions` on the old shapes — and a convention that holds for three endpoints out of six is not a convention, it is a fourth shape. `/auth/sessions` is the one documented exception: self-only and bounded by `AUTH_MAX_SESSIONS_PER_USER`, it carries `{data}` with no `page`.

**`@RequiresPermission` declares; it does not enforce — and that is forced by ADR-005 D-5.** The obvious design is a guard that authorizes before the handler. It cannot be built safely: the chain a decision rests on must be read inside the request's own tenant transaction, which does not exist until the handler opens it. A guard would have to open its own, putting the decision and the mutation in different transactions and leaving a window between them. That time-of-check/time-of-use gap is exactly why 1B.5.2 deferred the decorator rather than shipping a guard that looked right. Enforcement therefore stays in `AuthorizationService.assert`; the decorator supplies the declaration case 30 asserts against, and `AuthorizationCoverageInterceptor` cross-checks at runtime that the declared permission was actually asked for.

**A fourth violation path was found and closed in 1B.5.6.** ADR-005 D-7 names three — revoking the grant, disabling the holder, deleting the role. Deleting the *user* is a fourth: `user_roles.user_id` cascades, so `DELETE FROM users` performs a real DELETE on the guarded table. The trigger catches it because it sits on `user_roles` rather than on the API path, which is the argument for putting it there.

**The last-platform-admin invariant is not part of 1B.5.5.** `API.md` §3c specifies `409` on a revocation that would remove the last active platform administrator, and `DELETE /role-assignments/:id` therefore ships in 1B.5.5 *without* it. That is deliberate: the invariant is "at least one row exists", which no application count can hold under concurrency, and 1B.5.6 ships the `pg_advisory_xact_lock` trigger (migration `0005`) that makes it true (ADR-005 D-7). A service-only check would look like an invariant while losing under exactly the conditions it exists for, which is worse than its absence.

**Organization-creation integration is deferred to Phase 1C (1C.1a, formerly 1B.8).** `TenantRoleProvisioner` ships in 1B.5.4 as the sanctioned seeding mechanism and is tested directly, but no organization-creation path exists to call it yet — 1C.1a wires it in. It deliberately does not create organizations and offers no HTTP surface.

Two deliberate departures from the obvious ordering. Denial auditing (1B.5.3) comes **before** administration, because it is part of every administrative endpoint's security contract rather than a follow-up to them. Escalation guards merge into 1B.5.5 rather than forming their own increment, because a grant endpoint without its non-escalation guard must not exist even transiently.

#### 1B.6 increments

| Step | Objective | Schema | Exit criterion |
|---|---|---|---|
| **1B.6.1** | User lifecycle administration: `GET/POST /users`, `GET/PATCH /users/:id`, `POST /users/:id/disable` and `/reactivate`; atomic create-and-initial-grant through the existing `RoleAssignmentService`; the `users.reactivate` permission; the `user.reactivated` audit action; the API-key creator-status fix | `0008` — `user_roles(org_id, user_id)` for the membership probe, the `users.reactivate` catalogue row and its attachment to the seeded roles. No column, no policy change | ✅ complete — 807 → 907 tests, none weakened; the disable path of `trg_users_platform_admin_liveness` proven end to end for the first time; 22 mutations executed, 20 detected and 2 recorded as surviving because a lower layer is the real boundary; `FRONTEND_API_CONTRACT.md` stays **DRAFT** with one blocker closed |
| **1B.6.2** | API-key management: `GET/POST /api-keys`, `GET /api-keys/:id`, `POST /api-keys/:id/revoke`. The binding-scope and creator-intersection semantics already existed and are enforced at authentication (`RBAC.md` §5c); this is the surface that mints and retires keys, with the secret shown exactly once | `0009` — two keyset indexes on `api_keys`. No column, no policy, no permission and no audit action: the catalogue already had `api_keys.read/create/revoke` and `api_key.created/revoked` | ✅ complete — 913 → 994 tests, none weakened; **ADR-008** resolves the one-time-secret/idempotency conflict raised as a stop condition before implementation; 14 mutations executed, 13 detected and 1 recorded as surviving |
| **1B.6.4** | General rate limiting: the `(org_id, principal, endpoint_class)` limiter `API.md` §5 has specified since Phase 0, as a global guard running after `AuthGuard`. Two endpoint classes (`read`/`write`) sharing one configured ceiling; `X-RateLimit-*` headers and `429` + `Retry-After`; `AuthRateLimitService` untouched | **none** — `RATE_LIMIT_DEFAULT_*` already existed in `env.schema.ts` and was plumbed into `AppConfigService` but never read. No table, no column, no policy | ✅ complete — 1027 → 1046 tests; seven mutations executed and all seven detected, with mutation G recorded as structurally non-applicable rather than fabricated |
| **1B.6.3** | `GET /audit-logs` and `GET /audit-logs/:id` under `audit.read`, with allow-listed filters and cursor pagination; **plus** deployment-topology documentation closure (ADR-009) | **none** — `audit_logs`, its RLS policy and its indexes all ship in `0001`, and `EXPLAIN` confirms the default ordering is served by the primary key | ✅ complete — 994 → 1027 tests; a **list/detail authorization inconsistency was found and fixed** during the phase (`SECURITY.md` §4); ADR-009 freezes the deployment topology, white-label, hostname and secret-boundary decisions |

**The 1B.6 exit criterion was narrowed by accident, and is restored here.** It originally read *"live, audited, **rate-limited** and IDOR-safe"*. Restructuring the row into increments in commit `f3ef8fa` (Phase 1B.6.1) dropped the word "rate-limited" — an unannounced weakening, since it made 1B.6 measurable against a bar that no longer mentioned a capability nobody had built. The word is restored above and 1B.6.4 is the increment that satisfies it. The narrowing is recorded rather than quietly corrected, because a criterion that can be edited without anyone noticing is not a criterion.

**1B.6.4 also resolves a documentation conflict.** `API.md` §5 has specified the general limiter since Phase 0, while `FRONTEND_API_CONTRACT.md` §23 assigned it to 1B.10. Both cannot be authoritative; **1B.6.4 is now the owner**, the FAC row is corrected, and the reasoning is recorded in ADR-010.

**1B.6.3 found a real defect in its own surface, which is the argument for building read surfaces late.** `audit_logs_select`'s reseller arm keys on `app_current_reseller_id()`, and that session variable is derived from the *selected organization's* reseller for every principal — so RLS alone showed an organization administrator its reseller's own audit trail. The detail route always refused it; the list did not, until the phase narrowed reseller rows to principals holding a genuine reseller-scope grant. The policy has been in place since 1B.0 and was unreachable until a read surface existed. A mutation test is what exposed it: "authorize detail at the caller's organization" survived the first suite, and constructing the case that would kill it produced the inconsistency.

**Credential delivery is still deferred, and that is what makes 1B.6.1 shippable.** `DECISIONS.md` D16 was recorded as blocking the whole of 1B.6. ADR-007 D-5 separates the two concerns instead: `POST /users` creates an `invited` identity and does not pretend to make it usable, so everything about lifecycle — listing, membership scoping, profile update, disable, reactivate, the liveness invariant, session revocation — ships and is tested now, and only the question of how a person first obtains a password waits for D16. Creating the user was never the hard part of that decision.

**Deletion is not deferred; it is decided against** (ADR-007 D-1). `acc_app` has never held a `DELETE` grant on `users`, so the option was never available to the application role, and the audit trail must outlive the identity it describes. There is no `DELETE /users/:id` route and no `deleted_at` column.

**The one-time secret forced an amendment to ADR-006, and it was raised before implementation rather than decided in code.** A credential-creating endpoint must be idempotent, but `IdempotencyService` stores the response body verbatim in a plaintext column that is never purged — so the naive implementation would have persisted every API-key secret indefinitely. Implementation stopped and reported the conflict with four options; ADR-008 records the chosen one: a response field may be declared **non-persistable**, stored as `null` and therefore absent from any replay. `secret` is the first and only such field, the generic mechanism is unmodified, and the cost is stated plainly — a lost creation response means a lost credential, recovered by revoking and recreating.

**A fourth mutation-testing outcome worth recording.** Removing the service-level last-platform-admin check from the disable path is **not** detectable through the API, because migration `0005`'s trigger refuses the same transition and `translateLivenessViolation` maps its `restrict_violation` onto the identical `409`. That is stronger than 1B.5.6's equivalent mutation, where removing the service check cost the clean error. What the service check buys here is the ADR-005 D-7 lock ordering and avoiding an aborted transaction in the common case — not the guarantee, which is the trigger's. Recorded rather than papered over with a test written to detect it.

#### Deployment artifacts — a future track (ADR-009)

Not scheduled ahead of the approved core phases, and deliberately so: nothing in Phase 1B needs a container to be correct, and building charts against a moving surface means rebuilding them. But it is worth stating plainly that **nothing can currently be deployed anywhere, shared included** — the repository has no Dockerfile, no image, no chart and no manifest (`DEPLOYMENT.md` §0h).

| Step | Deliverable |
|---|---|
| **1B.D1** | Dockerfile(s) for API and workers; image build and publication; digest pinning |
| **1B.D2** | Migration job as a pre-upgrade hook, separate from the application rollout |
| **1B.D3** | Helm chart, environment-scoped values, secret references, health/readiness probes |
| **1B.D4** | Deployment identity in telemetry (ADR-009 D-2), per-deployment DR classes, supported version-skew policy |
| **later** | Backup/restore and rollback automation; shared-deployment promotion; dedicated-deployment provisioning; private/on-prem bundle |

**Sequencing constraint**: D1–D3 must land before the first real deployment of any kind; D4 before the first *dedicated* customer, because deployment identity, per-customer recovery objectives and a skew policy are all meaningless with one deployment and required with two.

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

> **Status: CLOSED by the project reviewer at `2b007224b66bf3917bde54c509d7ac1835082aad`.** The Gate-B read-only security audit (HEAD `df1ec74`) found seven blockers, including a live cross-tenant exposure between organizations sharing a reseller; they were remediated (ADR-011; `TESTING.md` §6o), the remaining items were classified (ADR-011 D-8), and the reviewer closed the gate on that evidence. Items carried forward are scheduled in Phase 1C (§4c, ADR-012) or explicitly deferred.

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
- **Tenant isolation** (§6a, §6c, §6d, §6f, §6g, §6h) — including the RLS negative control, the pooled-connection error path, and **sibling organizations sharing a reseller** (§6o, added after the Gate-B audit found them mutually visible). §6h's worker half is **not** required at Gate B: no worker exists in Phase 1B, and the harness is deferred with a recorded decision (ADR-004 D-5), exactly as §6i's WebSocket gateway is.
- **Workspace/team scope** — a workspace-scoped principal cannot reach a sibling workspace or the organization above it, proven **with RLS satisfied**, since RLS does not enforce below organization (`TENANCY.md` §3a).
- **Tenant-context selection** (§6l) and **bootstrap** (§6m).
- **API keys** — org binding, revoked/expired rejection, effective-permission intersection re-evaluated at use, secret shown exactly once and never audited.
- **Audit** (§6j plus Phase 1B actions) — every operation writes its specified action, actor, scope and outcome; security-sensitive writes roll back with their mutation; redaction proven against nested and array payloads; unknown-user failures recorded as the approved anonymous form.
- **Negative security** — the `security` Jest project is populated: IDOR sweep, token-in-query rejection, rate-limit bypass attempts, direct `user_roles`/`role_permissions` manipulation, revoked-session token reuse.
- **Frontend** — login → `/auth/me` → context render → logout smoke test; no token in `localStorage` or any URL.
- **Regression** — the full suite green, with Gate A's schema tests and the existing `@acc/api` tests unchanged.

**Explicitly not required at Gate B**, each deferred with a recorded decision: MFA (D10), password reset (D12), account lockout (D13), API-key rotation lineage (D14), WebSocket ticket consumption and the socket gateway (D15 — so `TESTING.md` §6i is only partly satisfiable), OAuth2/SSO (D6), scope-set caching (D11), ABAC attribute conditions and policy authoring (D21), cross-user authorization introspection (D23), the queued audit transport (ADR-003 D-2), and the worker/job tenant-context harness (ADR-004 D-5 — so `TESTING.md` §6h is satisfied for its pooled-connection half only).
- **API changes**: `/auth` (login, refresh, logout, sessions — no MFA challenge, ADR-003 D-6), `/tenants`, `/users`, `/roles`, `/role-assignments`, `/permissions`, `/api-keys`, `/audit-logs`, `/ws/ticket` (issuance only), `/health`.
- **Frontend changes**: Next.js app skeleton, login flow, tenant/user management console screens.
- **Tests**: unit + integration for auth/RBAC/tenant isolation, following the matrix in `TESTING.md` §6 — horizontal isolation at every scope level, vertical escalation between every adjacent pair, scope substitution, enumeration, role-assignment escalation, parent-child integrity, direct database RLS proof through the non-owner principal (including a negative control that would fail if RLS were absent), and WebSocket ticket expiry/reuse/binding. Phase 1B adds the audit-log matrix in `TESTING.md` §6j — append-only (UPDATE/DELETE/TRUNCATE), scope derivation and integrity, actor integrity, `acc_auth` confinement, organization-deletion behaviour, and its own RLS negative control.
- **Security checks**: session hardening review, RLS policy verification per table.
- **Observability**: base dashboards for API latency/errors, auth failure rate.
- **Documentation**: update `TENANCY.md`/`RBAC.md`/`DATABASE.md` with any implementation-driven refinements.
- **Acceptance criteria**: a user can register/log in, be assigned roles at any valid scope of the canonical hierarchy, and the full `TESTING.md` §6 isolation matrix passes — including the negative cross-tenant tests and the negative control proving the suite would fail if RLS were weakened.
- **Deployment requirements**: Dev environment stood up.
- **Rollback strategy**: standard app rollback (`DEPLOYMENT.md` §7); no external-facing risk yet.

### 4c. Phase 1C — tenant administration, session lifecycle, integrity and contract (ADR-012)

**Status: SCOPE FROZEN; 1C.1a and 1C.1b IMPLEMENTED and REVIEWED; 1C.2 IMPLEMENTED and CLOSED (PASS); 1C.6 IMPLEMENTED and CLOSED (PASS; migrations `0014`–`0017`); 1C.3 IMPLEMENTED and CLOSED (PASS); 1C.4a IMPLEMENTED and CLOSED (PASS; `TESTING.md` §6r); 1C.4b IMPLEMENTED and CLOSED (PASS; checkpoint `4e7effd`).** The Gate C review of the 1C.1a/1C.1b backend and the Phase 1C console (27-Sep-2026) returned PASS on security, contract and regression, after the target-organization lifecycle, session-cache and documentation remediation and the repository-integrity cleanup were committed. The Phase 1C.2 session-policy review (27-Sep-2026; `19085bb`, remediation `b505ff7`) closed PASS, with six security residuals carried forward to the Phase 1C review (`DECISIONS.md` ADR-012, "1C.2 closure") — the `users.reactivate` residual among them has since been remediated (reactivation now requires F-9 complete-grant coverage), and `users.update` (global phone write) is recorded as a separate deferred residual. Gate C as defined in §4d also covers 1C.6 (database integrity) and 1C.3 (OpenAPI); those criteria are evaluated when those increments are built, and overall Phase 1C closure is not yet claimed. Phase 1C is the successor to the previously unscheduled 1B.8 (tenant administration), 1B.9 (OpenAPI) and 1B.10 (development bootstrap), plus the Gate-B items ADR-011 D-8 scheduled for it. It builds on the Phase 1B architecture unchanged.

**Phase 1C.6 — IMPLEMENTED AND CLOSED (PASS)** (Gate C.6, 28-Sep-2026; `7ab1b88` → `8f0c8c4` → `4f3e4cc` → `f49ce0f`; closure record in `DECISIONS.md` ADR-012, "1C.6 closure"). At that point overall Phase 1C remained open and the next frozen increment was Phase 1C.3 (since closed, below).

**Phase 1C.3 — IMPLEMENTED AND CLOSED (PASS)** (Gate C.3, 29-Sep-2026; `03de8c0` … `3f9a77f`, checkpoint `bbbc72c`; closure record in `DECISIONS.md` ADR-012, "1C.3 closure"). **Overall Phase 1C remains open**: Gate C (§4d) is not passed, Phase 1C.4a is IMPLEMENTED AND CLOSED (PASS) (Gate C.4a, 30-Sep-2026; checkpoint `91607aa`; closure record in `DECISIONS.md` ADR-012, "1C.4a closure"); Phase 1C.4b is IMPLEMENTED AND CLOSED (PASS) (Gate C.4b, 01-Oct-2026; checkpoint `4e7effd`; closure record in `DECISIONS.md` ADR-012, "1C.4b closure").

**Gate C (§4d) — APPROVED / CLOSED** (user decision, 02-Oct-2026; closure record in `DECISIONS.md` ADR-012, "Gate C closure"). Every ADR-012 increment is closed. The Gate C readiness audit's two failing criteria (Observability, Regression) were remediated at `c640e82` and `4fb752e`, and the M02/M03 authorization-coverage containment at `d16d46f`; evidence and the eleven named mutations are in `TESTING.md` §6t. All 26 current mutating `@RequiresPermission` routes are covered before commit; regression 1,577/1,577 with no skipped tests. **Phase 1C, and with it Phase 1 — Foundation, is complete.**

| Step | Objective | Schema | Exit criterion |
|---|---|---|---|
| **1C.0** | ADR-012 and this documentation freeze | none | Decisions recorded; every affected document agrees; no code changed |
| **1C.1a** ✅ implemented | Organization create/read/update; suspend, reactivate, close (terminal); `TenantRoleProvisioner` and default-workspace creation in the same transaction; status enforcement as application authorization (ADR-012 F-1…F-5, F-8) | migration `0011`: `status_changed_at`, `status_reason` | §31a contract implemented; status enforcement proven for sessions, API keys, selection and lists; shared-reseller isolation proven for every new route |
| **1C.1b** ✅ implemented | Workspace create/read/update/archive/restore; team create/read/update/archive/restore; `/tenants/workspaces` kept as a deprecated alias (ADR-012 F-6, F-7) | migration `0012`: `teams.status` using the existing `workspace_status` values | §31b–§31c implemented; no hard team deletion; archive rules proven |
| **1C.2** ✅ implemented — CLOSED (PASS) | Maximum sessions with race-safe oldest-session eviction; self revoke-all; scoped administrator revocation; logout with an expired access token; CSRF preserved (ADR-012 F-9…F-12); plus the correction of the Phase 1B session-audit routing defect, live-session listing and rotation-chain revocation | migration `0013`: `app_is_auth_audit_action()` admits `session.revoked`, `session.revoked_all` (planned as "none expected"; required by F-11, approved as Option A) | §31d implemented; eviction proven under concurrency; no cross-scope revocation |
| **1C.6** ✅ IMPLEMENTED and CLOSED (PASS) | Composite `(workspace_id, org_id)` FKs on `api_keys`/`ws_tickets`; DB enforcement of `roles.allowed_scope_types`, plus refusing role narrowing that would strand a grant (decision §14.1, Option A: `PATCH /roles/:id` → `409`); `organizations.reseller_id` immutability; backfill verification | migration `0014`: two foreign keys, one replaced and two new trigger functions, a verifying backfill; migration `0015` (review remediation): the three functions trigger-only (no PUBLIC `EXECUTE`), narrowing refused outside READ COMMITTED; migration `0016`: the six pre-existing SECURITY DEFINER trigger functions trigger-only; migration `0017`: `fn_assert_platform_admin_remains()` owner-only | each constraint proven with the service bypassed; migration applies on the Gate-B database |
| **1C.3** ✅ implemented and closed (PASS) | OpenAPI reconciliation: full schemas, security schemes, headers, envelopes, idempotency and rate-limit documentation; generated spec; CI drift gate; authenticated UI outside development (ADR-012 F-13) | none | generated spec matches the route table and §31; snapshot drift gate in CI |
| **1C.4a** | Deterministic dev/test fixture and bootstrap command | data only | ✅ **IMPLEMENTED and CLOSED (PASS)** (`npm run fixture:dev --workspace @acc/api`, `TESTING.md` §6r; checkpoint `91607aa`) |
| **1C.4b** | Gemini E2E corrections (`TESTING.md` §6p) | — | ✅ **IMPLEMENTED and CLOSED (PASS)** (Gate C.4b, checkpoint `4e7effd`) |

**Order:** 1C.0 → 1C.1a → 1C.1b → 1C.6 → 1C.3, with 1C.2 in parallel after 1C.0. Backend implementation then stops and the finalized frontend contract is handed to Gemini.

**Out of scope for Phase 1C:** credential delivery/invitations (D16), WebSocket gateway/consumption/subscriptions (D15), providers and provider health (Phase 2), outbox/event consumers/SIEM (attributed to Phase 2 here; re-scheduled by ADR-013 PD-1 — not Phase 2 scope), delivery state (Phase 3+), routing/fallback (Phases 5–6), billing (Phase 7), reseller lifecycle/CRUD and white-label (Phase 9), deployment artifacts (separate track), workspace/team-level RLS (ADR-011 D-4), physical data deletion or retention automation, MFA, password reset, lockout, SSO/OAuth2, API-key rotation, ABAC, scope-set caching.

### 4d. Gate C — Phase 1C acceptance

Objectively testable; each is pass/fail. Evidence runs on an isolated test database, never on the development database.

- **Functional** — every route in `FRONTEND_API_CONTRACT.md` §31a–§31d behaves as specified; organization creation atomically seeds the system roles and the default workspace with audit rows; every illegal lifecycle transition is refused with the specified code; no `DELETE` route exists for organizations, workspaces or teams.
- **Security** — non-platform principals of a suspended/closed organization are refused on the next request via session, API key, explicit and implicit selection, with no token-TTL window; platform principals can still read it; no tenant-data mutation succeeds in a closed organization; organization creation outside the creator's authority is refused; administrator session revocation is refused whenever the target holds a grant the administrator does not cover; the cookie logout path requires `X-Acc-Refresh`; every new route appears in the route-coverage test, authorizes through `AuthorizationService.assert`, writes denial audits and is rate-limited.
- **Isolation** — the shared-reseller topology (`TESTING.md` §6o) is applied to every new route: no list enumerates a sibling organization, every sibling id is `404`, and workspace/team boundaries hold over HTTP as in `workspace-team-boundary.sec-spec.ts`.
- **Session policy** — the maximum is never exceeded under concurrent logins on independent connections; eviction removes the oldest eligible session and audits it.
- **Database / RLS** — every Phase 1C migration applies from empty and on top of the Gate-B database, re-runs as a no-op and leaves drizzle reporting no drift; any new table ships RLS in its creating migration and is classified in `principals.int-spec.ts` with exact grants; the composite FKs, `allowed_scope_types` enforcement and `reseller_id` immutability are each proven with the service bypassed; the existing principal, shared-reseller, trust-model and workspace/team suites pass unchanged; no RLS predicate for organization status is added (ADR-012 OD-3).
- **API contract** — the generated OpenAPI covers every route with request/response/error/security schemas and matches the route table in both directions and `FRONTEND_API_CONTRACT.md` §31; the committed snapshot equals the generated spec in CI; the UI and JSON require authentication outside development.
- **WebSocket** — not applicable (deferred, ADR-012 OD-11); the existing ticket-issuance suite still passes and consumption remains documented as DEFERRED.
- **Mutation proof** — each of the following is executed and caught, with failing test names recorded: status check removed; creation authority widened; lifecycle permission widened; `reseller_id` guard dropped; composite FK dropped; `allowed_scope_types` check removed from the trigger; session cap removed; eviction made non-atomic; cross-scope administrator revocation allowed; logout CSRF requirement removed; spec drift introduced.
- **Regression** — the full backend suite is green with the 1,215 Gate-B tests intact (none weakened without a recorded reason) plus the Phase 1C suites; zero skipped backend security tests; lint, typecheck, build and the dependency audit pass; formatting passes for every non-frontend file.
- **Documentation** — `API.md`, `FRONTEND_API_CONTRACT.md` (§31 re-marked IMPLEMENTED per subsection), `TENANCY.md`, `RBAC.md`, `SECURITY.md`, `DATABASE.md`, `TESTING.md` and this roadmap describe exactly what exists; anything not built stays marked DEFERRED.
- **Observability** — audit actions exist for every organization lifecycle transition, workspace/team create/update/archive/restore, session eviction and revoke-all; structured logs carry `orgId` for the new routes; metrics count refusals caused by organization status and session-cap evictions.
- **Explicitly not required at Gate C:** everything listed as out of scope in §4c, plus 1C.4a/1C.4b and the Gemini console work, which are authorized and gated separately.

## 5. Phase 2 — Provider abstraction + simulator

**Status: SCOPE FROZEN (ADR-013, 02-Oct-2026). 2.1 CLOSED (migrations `0018`–`0019`; Gate D.1 approved). 2.2 CLOSED (migrations `0020`–`0021`; Gate D.2 approved). 2.3 CLOSED (migrations `0022`–`0023`; Gate D.3 approved). 2.4 CLOSED (migration `0024`; Gate D.4 approved). 2.5 CLOSED (documentation only; Gate D.5 approved). 2.6 not started.** Each increment requires its own authorization.

- **Objectives**: implement `provider-registry`, `provider-adapters` (interface + `SimulatorAdapter` only), health/circuit breaker mechanics, admin hot-reload plumbing.
- **Dependencies**: Phase 1 (Gate C closed): `TenantDatabase` and the pre-commit authorization-coverage containment, `AuthorizationService` + `@RequiresPermission`, transactional `AuditWriter`, the OpenAPI pipeline, `/metrics`, `SecretsPort`, Redis, the `with-db-clone` mutation harness.
- **Architecture**: `PROVIDER_ADAPTER.md`, as partitioned by ADR-013.
- **Implementation scope**: §5a/§5b. **Not** in Phase 2 (ADR-013 PD-1, PD-2, PD-6): transactional outbox, worker/job harness, SIEM export, `provider_credentials`, real vendor adapters, message lifecycle, routing/failover, billing, reseller/white-label provider administration.
- **DB changes**: `channels`, `providers`, `provider_capabilities` (2.1, migrations `0018`–`0019`); the `provider.test_sent` audit policy (2.2, `0020`–`0021`); `provider_health` and the health/circuit columns on `providers` (2.3, `0022`); `provider_circuit_policy` and the `circuit_probes` slots (Gate D.3 remediation, `0023`); `provider_configuration_revision` and its change triggers (2.4, `0024`). **Not** `provider_credentials` (deferred, ADR-013 F-1).
- **API changes**: `/channels` (read-only, 2.1); `/providers` — catalogue and lifecycle (2.1), test-send (2.2), health check, health override and health-sample history (2.3); `/provider-circuit-policy` (`GET`/`PUT`, Gate D.3 remediation). 2.4 and 2.5 add no route. Platform scope only; 74 application operations in the OpenAPI document.
- **Frontend changes**: the provider console over the whole Phase 2 contract (§5b 2.6), polling — increment 2.6, implemented by the frontend track (Gemini) and gated by D.6.
- **Tests**: the submission-time simulator matrix, health state machine, circuit breaker, hot reload without restart (`TESTING.md` §6u).
- **Security checks**: platform-only access proven at the application and RLS layers; no credential or secret value persisted anywhere (`SECURITY.md` §3b).
- **Observability**: bounded Prometheus health/circuit/test-send metrics and a provisioned Grafana dashboard; console polling. No live WebSocket dashboard (ADR-013 PD-8).
- **Documentation**: `PROVIDER_ADAPTER.md` refined with implementation specifics as each increment lands.
- **Acceptance criteria**: Gate D (§5c). In short — a platform administrator can add, disable and drain a simulated provider, test-send to it, and see its health and circuit state change, with no deploy and no restart.
- **Deployment requirements**: "Dev + Staging" means local Docker Compose execution and disposable-clone CI/integration testing (ADR-013 PD-7). No deployment-artifact or Kubernetes work.
- **Rollback strategy**: application-level rollback is standard; provider configuration is reversible by the admin operations themselves (enable/disable/drain). Routing-policy versioning and rollback are a later phase.

### 5a. Phase 2 increments (ADR-013)

| Step | Objective | Schema | Exit criterion |
|---|---|---|---|
| **2.0** | Scope freeze (this section, ADR-013) | — | ✅ frozen 02-Oct-2026 |
| **2.1** | Channel & Provider Registry | `channels` (seeded), `providers`, `provider_capabilities`; permissions `providers.read`, `providers.manage` (and `providers.test_send` defined, unused until 2.2) | ✅ CLOSED — migrations `0018`, `0019`; Gate D.1 approved |
| **2.2** | Adapter Contract & Simulator | none; migration `0020` adds the `provider.test_sent` audit policy (permission `providers.test_send` already defined by 2.1) | ✅ CLOSED — migrations `0020`, `0021`; Gate D.2 approved |
| **2.3** | Health & Circuit Breaker | `provider_health`; health/circuit columns on `providers` | ✅ CLOSED — migrations `0022`, `0023`; Gate D.3 approved |
| **2.4** | Hot Reload | `provider_configuration_revision` (migration `0024`) | ✅ CLOSED — migration `0024`; Gate D.4 approved |
| **2.5** | Credential Reference Contract — documentation only | none | ✅ CLOSED — documentation only (`PROVIDER_ADAPTER.md` §4a); Gate D.5 approved |
| **2.6** | Frontend console — separately authorized | none | Gate D.6 |

**Execution order:** 2.1 → 2.2 → 2.3 → 2.4; 2.5 may run alongside 2.2; 2.6 after the 2.1–2.4 contract is stable. **Phase 2 closes as a whole (user decision, 05-Oct-2026): Gate D (backend, §5c) and Gate D.6 (console).**

### 5b. Increment specifications

Common to every backend increment: every route declares `@RequiresPermission` and asserts at `{ scopeType: 'platform', scopeId: null }` inside the request's `TenantDatabase.withTenant` transaction; every mutation is security-sensitive and audits in the same transaction at scope `platform` (ADR-013 F-4); the new routes appear in the route-coverage test, the committed OpenAPI snapshot and `FRONTEND_API_CONTRACT.md`; the general rate limiter applies; evidence runs on disposable clones only.

**2.1 — Channel & Provider Registry**
- *Objective*: the global channel and provider catalogue, administered by platform administrators.
- *In scope*: `provider-registry` module (`apps/api/src/providers/` — controller, service, DTOs); schema and migration in `packages/db`; contracts (permission keys, audit actions, channel codes, status enums) in `packages/contracts`.
- *DB*: `channels` (`id, code, display_name, status`; seeded `whatsapp, rcs, sms, email, voice`; read-only), `providers` (`id, channel_id, name, adapter_key, status ∈ {active, disabled, draining}, health_state ∈ {healthy, degraded, critical, offline}` default `healthy`, `circuit_state ∈ {closed, open, half_open}` default `closed`, timestamps), `provider_capabilities` (`provider_id, capability_key, value JSONB`). RLS enabled in the creating migration with the global-catalogue posture (ADR-013 F-3); `principals.int-spec.ts` classification; permission rows attached to `alendei_super_admin` only (today's grant, not the boundary — ADR-013 F-3).
- *API*: `GET /channels`, `GET /channels/:id`; `GET /providers`, `GET /providers/:id`, `POST /providers` (naturally idempotent — ADR-013 2.1 notes (c)), `PATCH /providers/:id` (name only), `PUT /providers/:id/capabilities`, `POST /providers/:id/enable`, `/disable`, `/drain`. No `DELETE`.
- *Permissions*: `providers.read` (reads), `providers.manage` (writes).
- *Security*: the ADR-013 F-3 layering — authenticated principal → validated `providers.*` permission (`AuthorizationService`) → platform-scope target → RLS platform-scope eligibility. RLS names no role or permission; the role-name-bound `app_is_platform_admin()` is not used for these tables, and 2.1 introduces a reviewed role-name-independent platform-scope eligibility primitive. Tenant and API-key principals receive `403`/`404` per `API.md` §3a and see zero rows at the database; `alendei_support` is RLS-eligible and refused by authorization (`403`, audited); `adapter_key` validated against the code registry (ADR-013 F-9).
- *Audit*: `provider.created`, `provider.updated`, `provider.capabilities_replaced`, `provider.enabled`, `provider.disabled`, `provider.drained`, with before/after.
- *Tests*: CRUD and lifecycle transition matrix (illegal transition `409`, nothing changed); tenant/support/API-key refusal; RLS proof with the service bypassed; audit atomicity; idempotent create; OpenAPI.
- *Mutation proofs*: `providers.manage` assertion removed (detected and contained, zero rows); RLS predicate widened to `true`; status-transition guard removed; audit write removed; `adapter_key` validation removed; OpenAPI drift.
- *Acceptance*: a platform administrator creates, enables, disables and drains a provider; no other principal can read or change one.
- *Exclusions*: credentials, adapters, health, circuit, routing fields, priority/weight, organization/reseller ownership.

**2.2 — Adapter Contract & Simulator**
- *Objective*: the vendor-neutral adapter contract and the only Phase 2 implementation.
- *In scope*: `ProviderAdapter` and its value types in `packages/contracts`; the code-level adapter registry and `SimulatorAdapter` in `apps/api/src/provider-adapters/`; `POST /providers/:id/test-send`.
- *Contract*: `capabilities()`, `healthCheck()`, `send()` (acceptance only, normalized failure taxonomy `PROVIDER_ADAPTER.md` §2) are implemented; `estimateCost()`, `checkStatus()`, `parseWebhook()` exist as interface members whose simulator implementation refuses with an explicit "not implemented in Phase 2" error and no behaviour (ADR-013 PD-6).
- *Simulator*: `SUCCESS`, `TIMEOUT`, `500`, `429`, `INVALID_CREDENTIALS`, `INVALID_REQUEST`, `SLOW_RESPONSE`, selected per request (never by hard-coded branching); latency and timeout driven by an injectable clock/timer so tests are deterministic.
- *DB*: none (the `providers.test_send` permission row).
- *API*: `POST /providers/:id/test-send` — explicit single target, synthetic payload, rate-limited, returns the normalized result; persists **no** message and requires no `messages`/`message_attempts`/`webhook_events`.
- *Permissions*: `providers.test_send`.
- *Audit*: `provider.test_sent` (behaviour, normalized outcome, latency; never the payload body).
- *Tests*: the seven-behaviour matrix and taxonomy mapping; a disabled or draining provider refuses test-send (`409`); no row in any message table; determinism (no wall-clock sleeps).
- *Mutation proofs*: a behaviour mapped to the wrong outcome; `TIMEOUT` treated as success; test-send without `providers.test_send` (contained); a stub given behaviour; disabled-provider guard removed.
- *Acceptance*: every submission-time behaviour is reproducible on demand through test-send.
- *Exclusions*: delivery/webhook behaviours (Phase 3), real adapters, cost estimation, message persistence.

**2.3 — Health & Circuit Breaker**
- *Status*: **IMPLEMENTED** (03-Oct-2026; migration `0022`). **Gate D.3 remediation** (04-Oct-2026; migration `0023`): the circuit parameters are a persisted, platform-wide policy administered by `providers.manage` (`GET`/`PUT /provider-circuit-policy`); the half-open probe count is configurable; the production failure classification and the routing-eligibility contract consumed by the future Provider Router are canonical (`PROVIDER_ADAPTER.md` §5b, §6a, §6h). Phase 2.3 performs no traffic switching. The model is canonical in `PROVIDER_ADAPTER.md` §5–§6 (frozen before implementation, ADR-013 "2.3 design"); evidence `TESTING.md` §6u.
- *Objective*: the provider health state machine and the circuit breaker, deterministically testable.
- *In scope*: health and breaker services in `provider-registry`; `provider_health`; metrics; a Grafana dashboard provisioned under `infra/observability/`.
- *Sample sources (only)*: test-send outcomes; `POST /providers/:id/health-check` (simulator `healthCheck()`); `POST /providers/:id/health` manual override (`source = manual`). No scheduler or background prober (ADR-013 F-6).
- *DB*: `provider_health` (append-only: `id, provider_id, observed_at, outcome, latency_ms, health_state, circuit_state, source ∈ {automatic, manual}`), global-catalogue RLS, append-only trigger.
- *API*: `POST /providers/:id/health-check`, `POST /providers/:id/health`, `GET /providers/:id/health` (recent samples).
- *Permissions*: `providers.manage` (probe, override), `providers.read` (history).
- *Audit*: `provider.health_checked`, `provider.health_changed`, `provider.health_overridden`, `provider.circuit_changed`.
- *Tests*: full health transition matrix; breaker `CLOSED → OPEN → HALF_OPEN → CLOSED/OPEN` driven by an injected clock and fixed sample sequences; `OPEN` short-circuits test-send without calling the adapter; threshold boundaries; metrics.
- *Mutation proofs*: threshold off-by-one; `HALF_OPEN` skipped; cooldown ignores the injected clock; short-circuit removed; manual override not audited; append-only trigger dropped (clone only).
- *Acceptance*: a sequence of test-sends moves health and circuit state exactly as specified and is visible in metrics.
- *Exclusions*: router integration and any traffic switching or failover (the routing-eligibility **contract** is defined, `PROVIDER_ADAPTER.md` §6h; no router consumes it in Phase 2), routing policies, per-provider threshold overrides (the circuit policy is platform-wide; health thresholds stay fixed), event publication.

**2.4 — Hot Reload**
- *Status*: **CLOSED** (04-Oct-2026; migration `0024`; Gate D.4 approved after one remediation, `be71c6f`). **Design amended by user decision at the 2.4 authorization** (ADR-013 "2.4 design", canonical `PROVIDER_ADAPTER.md` §3a): PostgreSQL `LISTEN/NOTIFY` emitted by database triggers on a transactional revision, revision polling (`R` = 5 s), a hard TTL (`T` = 60 s) and startup reload replace the Redis pub/sub transport below; the cache is an advisory configuration snapshot that authorizes nothing. The bullets below are the original freeze, **superseded** by that decision and retained only for the record — they do not describe the implementation (no Redis pub/sub exists).
- *Objective*: provider configuration changes take effect without restart, as **best-effort configuration invalidation with bounded convergence** — not transactional configuration propagation.
- *Semantics*: (1) the update commits first; (2) the invalidation is published to Redis **after** commit; (3) a subscriber evicts the entry as soon as it receives the publication, and its next read reloads from the database; (4) if a publication is lost, the cache TTL bounds how long a stale entry can be served, after which the entry refreshes on its own. Outbox-backed transactional propagation remains deferred (ADR-013 PD-1).
- *In scope*: an in-process registry/adapter cache in `provider-registry`; the Redis pub/sub publisher and subscriber; the TTL (configurable, on an injectable clock).
- *DB / API / permissions*: none new.
- *Audit*: none new (the triggering change is already audited).
- *Tests*: two application instances in one test, no restart. **(a) Immediate propagation:** with pub/sub working, a change through instance A is observed by instance B on its next read after the publication arrives, before the TTL has elapsed on the injected clock (e.g. a provider disabled through A is refused by B's next test-send). **(b) Bounded convergence:** with the publication suppressed, B may serve the stale entry until the TTL elapses on the injected clock and must observe the change on its first read after it — never later.
- *Mutation proofs*: invalidation publish removed (caught by (a)); TTL removed or unbounded (caught by (b)); invalidation published before commit (a subscriber reloads the pre-commit value — caught by (a)).
- *Acceptance*: change, then observe — immediately on publication, or within the TTL if it is lost — with no restart and no deploy.
- *Exclusions*: transactional configuration propagation; outbox-backed invalidation (deferred, ADR-013 PD-1).

**2.5 — Credential Reference Contract (documentation only)**
- *Objective*: record what any future credential design must satisfy, without deciding it. **Credential architecture requires a separate reviewed decision (its own ADR) before any implementation.**
- *In scope (documentation only)*: in `PROVIDER_ADAPTER.md` §4a and `SECURITY.md` §3a/§3b — the future credential-reference contract requirements (a `<backend>:<locator>` reference resolved server-side at call time); the security invariants (the secret never enters PostgreSQL, logs, metrics, audit rows, API responses or any frontend; multi-owner coexistence in one shared deployment under database-enforced isolation); the unresolved ownership model, stated as unresolved (ADR-013 F-1); and the future `SecretsPort` integration boundary (resolution happens behind `SecretsPort`, never in adapter code).
- *Must not*: add a runtime resolver port, type or interface; add credential-resolution code; add `provider_credentials` or any credential column; establish credential ownership or scope semantics; or define anything that could freeze the unresolved model by accident. `SimulatorAdapter` uses no credential; `INVALID_CREDENTIALS` is a simulated behaviour.
- *DB / API / permissions / audit / code*: none.
- *Tests / mutation proofs*: none of its own — 2.5 adds no code. The absence of credential persistence is proven by the Gate D cross-cutting check (§5c), implemented with 2.1 and extended by each backend increment.
- *Acceptance*: the documentation review — requirements, invariants, the open ownership question and the `SecretsPort` boundary are recorded, and nothing in Phase 2 freezes an ownership or scope semantic.
- *Status (04-Oct-2026)*: documented in `PROVIDER_ADAPTER.md` §4a (binding requirements CR-1–CR-8, the `SecretsPort` boundary, the NOT FROZEN list, candidate input) and reconciled in `SECURITY.md` §3–§3b and `RUNBOOK.md` §5, §7; **PASS / CLOSED — documentation-only Credential Reference Contract** (Gate D.5 approved). **Follow-up outside 2.5:** credential-absence test hardening (ADR-013 "2.5 notes" (b)) — done 04-Oct-2026 (`TESTING.md` §6u, "D-2 hardening").
- *Exclusions*: `provider_credentials`, any ownership model, rotation, management, any real credential, any credential type in code.

**2.6 — Frontend console (separately authorized and gated; implemented by Gemini)**
- *Objective*: a platform administrator can do in the console everything the Phase 2 acceptance line names — add, disable and drain a simulated provider, test-send to it, and see its health and circuit state change — with no deploy and no restart.
- *Scope* (the whole Phase 2 contract, `FRONTEND_API_CONTRACT.md` §32; scope widened to the full acceptance surface by user decision, 05-Oct-2026): channels list and detail (read-only); provider list (channel and status filters, keyset pagination) and detail with capabilities; create (`disabled` on creation); rename; capability-set replacement; enable, disable, drain; test-send with a chosen simulator behaviour; health check; manual health override (set and clear); health-sample history; circuit-policy read and update (`expectedVersion`). Health and circuit are shown by polling (ADR-013 PD-8). No credential field, routing control or hot-reload control exists anywhere.
- *Authorization in the UI*: actions are shown or enabled from the capability hints in `GET /auth/me/authorization`; the server stays the authority, and every documented refusal is handled — `401`, `403`, `404`, `409` (`PROVIDER_LIFECYCLE_CONFLICT`, `PROVIDER_CIRCUIT_OPEN`, `RESOURCE_CONFLICT`), `422` (`PROVIDER_ADAPTER_UNKNOWN`), `400` validation details, `429`.
- *Fixture*: `fixture:dev` (`TESTING.md` §6r) then `fixture:providers` (§6v) provide representative providers and the platform administrator, `providers.read`-only, `providers.test_send`-only and denied (`alendei_support`) principals for browser tests — development tooling only.
- *No backend change*: `apps/api` and `packages` unchanged; the OpenAPI document unchanged. Follows the 1C.4b precedent.

### 5c. Gate D — Phase 2 acceptance

Objectively testable; each is pass/fail. Evidence runs on disposable clones, never on the canonical test database. Sub-gates D.1–D.6 close their increments; Gate D closes Phase 2.

- **Registry correctness** — every 2.1 route behaves as specified; the lifecycle transition matrix is exact; illegal transitions `409` and change nothing; the seeded channel catalogue is read-only.
- **Authorization and global-catalogue security** — only holders of the required `providers.*` permission at platform scope succeed; organization, workspace, team, reseller, `alendei_support` and API-key principals are refused; with the service bypassed, a transaction without a validated platform-scope claim sees zero catalogue rows and cannot write; the RLS predicate names no role or permission (a test grants the permissions to a second, test-only platform role and shows it succeeds with no policy change, and shows `alendei_support` is RLS-eligible yet refused by authorization); `acc_auth`/`acc_relay` hold no grant; every new route is in the route-coverage test and inside the pre-commit coverage boundary.
- **Simulator matrix** — the seven submission-time behaviours are reproducible on demand through test-send with the specified normalized outcomes; no message-table row is ever written.
- **Health state machine** — every specified transition, and no other, for automatic and manual sources.
- **Circuit breaker** — `CLOSED/OPEN/HALF_OPEN` transitions exact at threshold boundaries under an injected clock; `OPEN` short-circuits.
- **Hot reload** — **best-effort configuration invalidation with bounded convergence** — not transactional configuration propagation (as built in 2.4, `PROVIDER_ADAPTER.md` §3a): PostgreSQL stays authoritative; each instance keeps an advisory in-process snapshot that authorizes nothing; a PostgreSQL `LISTEN/NOTIFY` hint, sent on commit, marks it dirty; with no restart, a change through one instance is observed by a second instance (a) on its next advisory read after the notification arrives, (b) within `R` = 5 s on the injected clock when notifications are lost (revision reconciliation), and (c) never later than the hard TTL `T` = 60 s. Snapshots and notifications carry no credential material. No Redis pub/sub.
- **Audit coverage** — every mutation and transition writes its ADR-013 F-4 action in the same transaction, with before/after and no secret material.
- **OpenAPI consistency** — the generated spec covers every new route and matches the route table and `FRONTEND_API_CONTRACT.md`; `openapi:check` passes.
- **Observability** — bounded health/circuit/test-send metrics exist and are proven; the Grafana dashboard is provisioned.
- **Deterministic tests** — no wall-clock sleeps; clocks and latency are injected; repeated runs are identical.
- **Mutation proofs** — each increment's listed mutations executed on disposable clones and caught, with failing test names recorded; authorization mutations are detected **and contained**.
- **No credential secret persistence** — no table, column, log line, metric, audit row or response carries a credential or secret value; `provider_credentials` does not exist; no credential type, port or resolution code exists (a static cross-cutting check implemented with 2.1, extended by each increment).
- **No scope creep** — no outbox, worker harness, SIEM, routing, failover, billing, real adapter, message lifecycle, reseller/white-label or WebSocket code is introduced.
- **Regression** — the full backend suite (1,577 at Gate C, plus the Phase 2 suites) is green with zero skipped tests; lint, typecheck, build, dependency audit and non-frontend formatting pass; migrations apply from empty, re-run as a no-op and leave no drift.
- **Documentation** — `PROVIDER_ADAPTER.md`, `DATABASE.md`, `API.md`, `FRONTEND_API_CONTRACT.md`, `SECURITY.md`, `TESTING.md`, `OBSERVABILITY.md` and this roadmap describe exactly what exists.
- **Explicitly not required at Gate D:** everything excluded by ADR-013; 2.6 is gated separately (D.6).

**Gate D.6 — the provider console (2.6).** Phase 2 is closed only when Gate D **and** Gate D.6 pass. Each is pass/fail:

- **Coverage** — every operation in the 2.6 scope (§5b) is reachable in the console, against the unchanged `FRONTEND_API_CONTRACT.md` §32 contract.
- **Polling** — health and circuit state refresh by polling at a bounded interval; no WebSocket.
- **Authorization** — actions are hidden or disabled for a principal without the permission; a refusal from the server is shown, never retried silently. Browser tests for the platform administrator, a `providers.read`-only principal, a `providers.test_send`-only principal and a denied principal (no `providers.*`).
- **Error handling** — each documented status and error code of §32 has a defined presentation.
- **No credential surface** — no field, label or stored value for a credential or secret reference.
- **No backend change** — `git diff` of `apps/api` and `packages` is empty; `openapi:check` passes unchanged.
- **Quality** — web lint, typecheck, build and format pass; Playwright E2E against `fixture:dev` passes repeatably.

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
- **Handed forward by ADR-013 (for Phase 3's own scope freeze to decide, not committed here)**: the delivery/webhook simulator behaviours (`DELIVERY_DELAY`, `DELIVERY_FAILURE` webhook, `DUPLICATE_WEBHOOK`, `OUT_OF_ORDER_WEBHOOK`); `provider_credentials` and the ADR that freezes its ownership model (ADR-013 F-1); the transactional outbox and worker/job tenant-context harness if Phase 3's consumers require them (ADR-013 PD-1); the meaning of "Dev + Staging" while no deployment artifact exists (ADR-013 PD-7).

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
