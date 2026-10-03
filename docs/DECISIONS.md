# Open Decisions, Risks & Contradictions Log

This is the living register of everything flagged as needing a product-owner decision, carrying scalability/security risk, or representing a tension between requirements that this document set resolved with an explicit, stated choice rather than silently picking one side. As of Phase 0.1 (the consolidated architecture consistency & hardening pass), every item that would have blocked a correct, unambiguous Phase 1 implementation has been resolved and is recorded in §1. Items in §2 are explicitly confirmed non-blocking — none of them affect the correctness of Phase 1 Foundation work. Phase 0.2 (final documentation-hardening pass before Phase 1 implementation — transaction-specific pricing, `requested_channel_id` hard-constraint semantics, attempt-level routing/pricing snapshots, idempotency `failed`-status semantics, and the broader engagement-platform product architecture, `ARCHITECTURE.md` §21) added B19–B22 below, all resolved. A follow-up Phase 0.2 correction pass added B23–B25 (multi-component pricing evaluation model, billable-transaction terminology generalization, and a residual reservation-accounting wording fix). Phase 0.3 (surgical documentation-consistency pass) added B26–B28 (Phase 5/Phase 7 billing-dependency de-conflation, removal of "distributed lock" as an implied Phase 5 deliverable, and an explicit Pricing-Evaluation-vs-Usage-Ledger HOW-vs-WHAT boundary statement). Phase 0.4 (final documentation freeze pass) added B29–B30 (made `usage_ledger.pricing_evaluation_id` the authoritative concrete foreign key to the pricing calculation that produced each ledger amount, demoting `rate_card_ref` to descriptive metadata; clarified `DR.md`'s Redis-loss wording so it cannot be read as Redis participating in fallback correctness). No Phase 0.2–0.4 change reopened or contradicted any earlier resolution; the architecture is frozen as of Phase 0.4.

**Phase 1B.5 planning feedback (B35)**: the authorization review for Phase 1B.5 found that `PermissionEvaluator` evaluates the permission question and the scope question against *different* grants. `grantCarries()` ignores its `roleId` and returns the flattened union, so `allows(P, target)` reduces to "some grant carries P" AND "some grant covers the target" — a cross-product. Confirmed empirically against the real evaluator and the real seeded roles: a user holding `read_only` at an organization and `workspace_manager` at one workspace is granted `role_assignments.grant`, `teams.create`, `workspaces.update` and `users.invite` **at organization scope**, where no coherent grant authorizes any of them. Three corrections to the risk as previously recorded: the recorded mitigation reasons in the wrong direction (the over-approximation is *upward*, so "no endpoint below organization level" does not bound it); stock seeded roles reproduce it with no custom role; and it is latent only because the single live endpoint checks a permission every seeded role carries — Phase 1B.5 introduces `role_assignments.grant` as an endpoint permission and makes it directly exploitable inside the privilege-management API. Resolved in ADR-005 (§1e); the fix needs no schema change, because `role_permissions` already is the per-grant relation.

**Phase 1B.4 implementation feedback (B34)**: the Phase 1B.3 verification pass found that implementation and `ROADMAP.md` §4a had diverged — 1B.3 had necessarily absorbed the whole of 1B.4's scope-resolution and tenant-context deliverables, and had pulled `scopeCovers` and `PermissionEvaluator` forward from 1B.5, because the 1B.3 exit criterion (the authenticated chain proven end to end) is not demonstrable without them. Nothing was missing; the phase table was wrong. ADR-004 (§1d) records the delivered split, re-scopes 1B.4 to the three things genuinely unbuilt — this reconciliation, the pooled-connection hardening tests, and one generic advisory-identifier cross-check — and states why the worker/job tenant-context harness is deferred to Phase 2 rather than guessed at now.

**Phase 1B planning feedback (B33)**: the planning review for the identity/tenancy/RBAC half of Phase 1B found nine decisions that had to be settled before implementation — bootstrap of the first platform admin, audit synchronization with no outbox available, JWT claim contents, multi-organization selection, where target-scope authorization runs, MFA's actual phase, refresh-token transport, the audit representation of an unknown-user login failure, and the API-key effective-permission model. Several of these were *documented as settled* in ways the repository contradicted. All are resolved in ADR-003 (§1c) and the affected documents are reconciled in this pass. One consequence (R4) requires a schema change that is deliberately not made in a documentation-only pass and is recorded as pending.

**Phase 1B implementation feedback (B32)**: building the audit log surfaced a second set of genuine gaps — an over-broad `acc_auth` insert policy, an audit row that could not express three of the five canonical scope levels, a missing `causation_id`, a documented partitioning requirement the implementation did not meet, absent parent–child integrity, and an accidental interaction between `ON DELETE SET NULL` and the append-only trigger. All six are resolved in ADR-002 (§1b) and the affected documents are reconciled. As with B31, this is `ROADMAP.md` §1's `DOCUMENT` stage working as intended.

**Phase 1A implementation feedback (B31)**: building the IAM/tenancy foundation surfaced one genuine contradiction the Phase 0 passes had not caught — `user_roles.scope_type` was specified with three values while the tenancy hierarchy, the reseller model and the routing-precedence hierarchy all assumed five. It is resolved below and the affected documents have been reconciled. This is the documented mechanism working as `ROADMAP.md` §1 intends: a phase's `DOCUMENT` stage updates `/docs` in place when implementation reveals a real ambiguity, rather than the implementation silently diverging.

## 1. Phase-1 blockers — resolved in Phase 0.1 through Phase 0.4

| # | Issue | Resolution | Where documented |
|---|---|---|---|
| B1 | Idempotency conflated three distinct mechanisms | Split into API/logical-message idempotency (`idempotency_keys` table, `(org_id, endpoint, key)` scope), internal attempt idempotency (`message_attempts` unique `(message_id, attempt_number)`, guarded by the conditional transition), and provider-side idempotency (a documented, disclosed limitation, mitigated via `provider_idempotency_key`) | `DATABASE.md` §7, `ARCHITECTURE.md` §9, `API.md` §4, `PROVIDER_ADAPTER.md` §2a |
| B2 | Attempt numbering used two overlapping counters (`message_attempts.attempt_number` and `messages.fallback_attempt_number`) | Single global monotonic `attempt_number` (1, 2, 3, ...) across the whole chain; `messages.fallback_attempt_number` removed, replaced by a denormalized `messages.current_attempt_number` mirroring the current attempt; same-attempt retries use `retry_count`, never a new `attempt_number` | `FALLBACK_ENGINE.md` §3, `DATABASE.md` §6 |
| B3 | Ambiguous duplicated fields between `messages` and `message_attempts` (`provider_id`, `channel_id`, `provider_message_id`) | `message_attempts` is the sole authority; `messages.current_attempt_id` points to it, and `messages.current_channel_id`/`current_provider_id`/`current_provider_message_id`/`current_attempt_number` are explicitly-labeled denormalized copies written only in the same transaction as `current_attempt_id` | `DATABASE.md` §6, `ARCHITECTURE.md` §5 |
| B4 | Fallback correctness depended on Redis locking as the primary mechanism | Redis is an optional performance accelerator only; the actual correctness guarantee is a PostgreSQL conditional transaction (`state_version`/status compare-and-swap) that holds even if Redis is entirely unavailable | `FALLBACK_ENGINE.md` §4, `ARCHITECTURE.md` §9c |
| B5 | Fallback chains risked being executed as a blindly-replayed precomputed plan | Every fallback step re-runs Eligibility → Channel Router → Provider Router against *current* state; `fallback_steps` is documented explicitly as configuration of intent, not a runtime plan | `ARCHITECTURE.md` §3b, `FALLBACK_ENGINE.md` §2 |
| B6 | No single deterministic routing policy precedence when multiple scopes could apply | Fixed hierarchy: platform → reseller → organization → workspace → channel → campaign/journey → message-level override; most-specific *active* policy wins as a whole (no field-level merge); disabled policy falls through, never blocks | `ROUTING_ENGINE.md` §4 |
| B7 | Outbound (customer-facing) webhooks were only informally described, with no durable delivery/retry model | First-class `webhook_endpoints`/`webhook_deliveries` tables; retry/backoff/DLQ/auto-disablement/signing/replay fully specified, structurally distinguished from inbound provider webhooks | `DATABASE.md` §12, `API.md` §6, `EVENTS.md` §§4c, 5a |
| B8 | Webhook/event replay could plausibly re-trigger a business action if implemented naively | Three replay types (inbound provider, internal event-bus, outbound delivery) each explicitly defined with idempotency guarantees; none regenerates a domain event or re-sends a message | `EVENTS.md` §§5b–5d, `RUNBOOK.md` §8 |
| B9 | RLS tenant context assumed an HTTP request; background workers had no defined mechanism | Mandatory rule: every job/event carries authoritative tenant context from a trusted source; `SET LOCAL` inside each job's own transaction, never connection-level `SET`; enforced by a shared worker-harness utility | `TENANCY.md` §5, `DATABASE.md` §14a |
| B10 | `user_roles.scope_id` (polymorphic) had no defined cross-tenant integrity guarantee | Database trigger (`fn_validate_user_role_scope`) plus application-level pre-check, both required; the invalid "role from Org A, scope in Org B's workspace" state is structurally rejected | `RBAC.md` §6, `DATABASE.md` §2 |
| B11 | Provider credential ownership/precedence across platform/reseller/org scopes was undefined | Explicit `scope_type`/`scope_id` on `provider_credentials`; resolution always prefers organization → reseller → platform, most-specific-active-wins; plaintext never exposed to any frontend at any scope | `PROVIDER_ADAPTER.md` §4a, `DATABASE.md` §3 |
| B12 | Wallet/credit checks were a naive "read balance, then send" sequence vulnerable to concurrent overspend | Atomic reservation via `SELECT ... FOR UPDATE` + a `reservation`/`reservation_release` ledger entry pair in the same transaction as the balance check | `BILLING.md` §8, `DATABASE.md` §10a |
| B13 | `customer_charge` vs. `provider_cost` relationship, and fallback-chain charging, were left as "future billing policy" | Formal `organizations.billing_policy` field (`charge_per_logical_message` default / `charge_per_attempt` opt-in), worked example against the canonical five-attempt chain, and an explicit provider_cost → pricing engine → customer_charge → reseller_markup → tax/discount/adjustment relationship (never assumed equal) | `BILLING.md` §§5, 9 |
| B19 | Billing architecture assumed one universal price per message, with no defined separation between billing policy (how/when charged) and pricing policy (how much), no versioned pricing, and no attempt-level pricing/cost independence | Pricing & Rating Engine introduced as a concept independent of the immutable ledger (`Usage/Billable Transaction → Pricing & Rating Engine → Pricing Evaluation → Pricing Evaluation Components → Billing Decision/Financial Treatment → Immutable Usage Ledger → Wallet/Credit/Invoice`); `pricing_plans`/`pricing_plan_versions`/`pricing_rules`/`provider_cost_rates`/`customer_pricing_assignments` introduced as conceptual, versioned entities (Phase 7 design detail); `message_attempts` gained a `pricing_evaluation_id` snapshot reference (superseding an earlier, since-corrected `pricing_rule_id`/`pricing_plan_version_id` pair — see B23); billing policy vs. pricing policy formally distinguished | `BILLING.md` §§10–17, `DATABASE.md` §§6, 10b |
| B23 | A single `pricing_rule_id` per attempt could not explain a composite billable transaction (e.g. Voice AI: telephony + STT + LLM + TTS + platform fee), each part independently rated and costed | Introduced `pricing_evaluations`/`pricing_evaluation_components` (`Attempt → Pricing Evaluation → Pricing Components`); `message_attempts.pricing_evaluation_id` replaces the earlier single-rule reference; components remain referenced, never copied, onto the attempt | `BILLING.md` §16, `DATABASE.md` §§6, 10b |
| B24 | Billing terminology was implicitly scoped to "logical message," which does not naturally cover future Voice/Voice AI/AI/API-usage/platform-service billing | Terminology generalized to **billable transaction or logical communication lifecycle**, with logical message stated as the common (not universal) case; the message/attempt model itself is unchanged | `BILLING.md` §10 |
| B25 | `DATABASE.md` §10a described a reservation as "negative against available balance," which could be misread as decrementing `wallets.balance` directly, contradicting the `reserved`-only reservation model already stated elsewhere | Reworded to state plainly that a reservation increases `reserved` only, `balance` is untouched, and `available_balance = balance - reserved` is a derived quantity — consistent now across `BILLING.md` §8, `DATABASE.md` §§10, 10a | `DATABASE.md` §§10, 10a, `BILLING.md` §8 |
| B26 | `ROADMAP.md` Phase 5's acceptance criteria included an unscoped "correct billing" requirement, and `TESTING.md` §3's critical-scenario test asserted full ledger/reservation correctness — but the immutable ledger and Pricing & Rating Engine are not built until Phase 7, creating an artificial dependency (implying either billing must be partially built early and later replaced, or Phase 5 could never actually pass) | Phase 5's acceptance criteria and `TESTING.md` §3 item 7 rescoped to an integration-contract check only (correct billing-shaped event/call emitted once per attempt and once at chain terminal state, against the defined contract, not a real ledger); full financial correctness explicitly deferred to, and re-asserted at, Phase 7; Phase 5 explicitly barred from building a temporary ledger/wallet implementation | `ROADMAP.md` §8, §10, `TESTING.md` §3 |
| B27 | `ROADMAP.md` Phase 5's objectives named "the distributed lock" as a deliverable, which could be read as Redis distributed locking being the fundamental fallback-escalation correctness mechanism — contradicting the already-resolved position (B4) that PostgreSQL's conditional transaction is the sole correctness boundary | Reworded: Phase 5 implements the PostgreSQL conditional-transaction escalation guard as the correctness boundary; Redis is named explicitly as an optional fast-path accelerator only, never a required mechanism, consistent with `ARCHITECTURE.md` §9c and `FALLBACK_ENGINE.md` §4 | `ROADMAP.md` §8 |
| B28 | The boundary between a Pricing Evaluation (how an amount was calculated) and the Usage Ledger (what financially happened) was implied but not stated as an explicit, named invariant — risking the ledger being extended into a calculation-detail table over time | Explicit HOW-vs-WHAT boundary stated normatively: a Pricing Evaluation/its Components explain HOW; the Usage Ledger's fixed `entry_type` set records WHAT; the ledger references an evaluation (via `pricing_evaluation_id`, made authoritative in B29) but never inlines its component breakdown | `BILLING.md` §§10, 16, `DATABASE.md` §10b |
| B29 | `usage_ledger.rate_card_ref` was the only documented reference from a ledger entry to its pricing calculation, but was described ambiguously (sometimes "a pricing rule/rate-card version," sometimes generalized to "the pricing_plan_version/pricing_rule/pricing_evaluation") — an audit could not deterministically join a ledger amount back to the exact calculation that produced it | Added a concrete foreign key `usage_ledger.pricing_evaluation_id → pricing_evaluations.id → pricing_evaluation_components`, made explicitly authoritative; `rate_card_ref` redefined as historical/descriptive metadata only (a display label), never the field audit/reconciliation resolves against | `DATABASE.md` §10, `BILLING.md` §§9, 15, 16 |
| B30 | `DR.md` §1's Redis loss-impact note ("brief fallback-lock race window on restart") could be read as implying Redis participates in fallback correctness, contradicting the already-resolved position (B4) that PostgreSQL's conditional transaction is the sole correctness boundary | Reworded to state that Redis loss only causes additional scheduler contention/duplicate poll attempts, all safely arbitrated by the PostgreSQL conditional transaction (`FALLBACK_ENGINE.md` §4); no unsafe state transition is possible regardless of Redis availability | `DR.md` §1 |
| B20 | `requested_channel_id` had no defined hard-constraint semantics — whether/when the Fallback/Channel Router could substitute a different channel than the caller pinned was implicit | `requested_channel_id`, when non-null, is a hard channel constraint by default; cross-channel fallback requires explicit `cross_channel_fallback_enabled = true`; within-channel provider fallback is unaffected; a hard-pinned channel with no eligible provider fails per policy rather than silently switching channel | `ROUTING_ENGINE.md` §1a, `FALLBACK_ENGINE.md` §2, `DATABASE.md` §6, `API.md` §2a |
| B21 | `message_attempts` recorded which provider/channel was used but not *why* (which routing policy/version), making a fallback decision non-auditable after the fact | `message_attempts.routing_policy_id`/`routing_policy_version_id` snapshot references added, written once at attempt creation, never copied/duplicated policy config | `DATABASE.md` §6, `ARCHITECTURE.md` §5 |
| B22 | `idempotency_keys.status = failed` had no defined semantics distinguishing a definite pre-creation failure from an ambiguous outcome, risking either an unsafe blind retry or an unsafe blind refusal | Two cases formally distinguished: definite failure before logical-message creation (retry permitted, no `messages` row exists) vs. ambiguous outcome (retry deterministically checks for an existing `messages` row via the `(org_id, idempotency_key)` constraint before ever creating a new one — never inferred from `idempotency_keys.status` alone) | `DATABASE.md` §7.1 |
| B14 | Event catalogue mixed attempt-level and message-level events without a defined derivation rule between them | Catalogue split into §4a (attempt-level) and §4b (message-level); `messages.status_changed` is always derived by the Orchestrator from attempt events per one explicit rule, never inferred independently by other consumers | `EVENTS.md` §4, `ARCHITECTURE.md` §6a |
| B15 | No explicit Prometheus cardinality rule — tenant/message-level identifiers could leak into metric labels | Hard rule: metrics use only a bounded label set (environment, service, operation, channel, provider, status); tenant/message/campaign-level detail lives in logs/traces/business analytics, never Prometheus | `OBSERVABILITY.md` §3 |
| B16 | Provider test-send and other privileged provider/routing admin operations had no explicit authorization/audit requirement | All gated behind `providers.manage`/`providers.test_send`, all audit-logged without exception; test-send additionally rate-limited and environment-aware | `PROVIDER_ADAPTER.md` §4, `SECURITY.md` §1 |
| B17 | API contracts left identity types, error-contract completeness, and WebSocket auth underspecified | Four distinct identity types (human/API key/OAuth client/system) formalized; error envelope gained `retryable`; WebSocket auth uses a single-use short-lived ticket, never a JWT in the URL | `API.md` §§3, 7, 9, `DATABASE.md` §2 |
| B18 | ORM/migration tooling choice was left open, blocking Phase 1's ability to write real migrations | Resolved: Drizzle ORM (SQL-first control needed for RLS `SET LOCAL` patterns, partitioned tables, and the scope-integrity trigger), raw SQL as an escape hatch | `DATABASE.md` §14 |
| B31 | `user_roles.scope_type` was specified as `ENUM(organization, workspace, team)` in `DATABASE.md` §2 and restated as such in `RBAC.md` §1 — but `RBAC.md` §3 defines `alendei_super_admin` at platform scope and `reseller_admin` at reseller scope, giving those roles no representable scope. `TENANCY.md` §1, `ARCHITECTURE.md` §16, `PRD.md` §6 and `ROUTING_ENGINE.md` §4 all already assumed a five-level hierarchy. The three-value enum was the outlier, not the design | **Five-scope model adopted as canonical**: `platform → reseller → organization → workspace → team`. `TENANCY.md` §1a is now the single normative definition; every other document defers to it and none restates a conflicting set. See the ADR immediately below | `TENANCY.md` §§1a, 2a–2b, 3a, 4a–4b, 6; `RBAC.md` §§1, 2, 3, 4a–4b, 6, 7; `DATABASE.md` §§1, 2, 2a, 14; `ARCHITECTURE.md` §17; `API.md` §§3a, 9a; `SECURITY.md` §§1, 6; `TESTING.md` §6 |

## 1a. ADR-001 — Five-scope authorization hierarchy

**Status**: Accepted (Phase 1A review). Supersedes the three-value `user_roles.scope_type` enum in the Phase 0.4 text of `DATABASE.md` §2.

### Context — the original ambiguity

`DATABASE.md` §2 declared `user_roles.scope_type ENUM(organization, workspace, team)`, and `RBAC.md` §1 restated it. Yet:

- `RBAC.md` §3 defines `alendei_super_admin` with scope "platform" and `reseller_admin` with scope "reseller". Neither value existed in the enum, so neither role could actually be granted.
- `TENANCY.md` §1, `ARCHITECTURE.md` §16 and `PRD.md` §6 all describe the hierarchy as `Alendei → Reseller → Organization → Workspace → Team → User`.
- `ROUTING_ENGINE.md` §4 states its precedence hierarchy "matches the tenancy hierarchy (`TENANCY.md` §1)" and enumerates platform and reseller as its first two levels.
- `DATABASE.md` §2's own description of `fn_validate_user_role_scope` anticipated the gap, saying a platform-level role's `scope_type` "must be a value the platform role's design permits" — an acknowledgement that values outside the three-value enum were expected, without ever naming them.

Four documents assumed five levels; one enum said three. Two engineers reading the set would have implemented incompatible authorization models, which is exactly the bar §5 sets for a §1 blocker.

### Decision

The canonical authorization scope hierarchy is:

```
PLATFORM  →  RESELLER  →  ORGANIZATION  →  WORKSPACE  →  TEAM
```

`user_roles.scope_type` carries exactly these five values. `TENANCY.md` §1a is the single normative definition of what each scope means, which roles are assignable at each, how inheritance works, and how scope resolves from an authenticated identity.

### Why five scopes are required

- **`platform` is not optional.** Without it, Alendei's own operators have no representable identity, and cross-tenant control-plane access would have to be expressed as an out-of-band flag or a superuser database connection — both worse, because neither is auditable as a role grant.
- **`reseller` is not optional.** `ARCHITECTURE.md` §16 makes reseller scoping a first-class tenancy dimension enforced "the same way tenant scoping is". Collapsing it into `organization` would force a reseller admin to hold one grant per organization, which breaks the moment an organization is added — the grant set would silently fail to cover it.
- **`organization`, `workspace`, `team`** are unchanged from the original three, and keep their original meanings.

Adding a scope level is not free — each one is a boundary that must be tested in both directions — but four documents already depended on these two levels existing.

### Consequences for RBAC

- A role's assignable scopes are constrained by whether it is platform-level (`roles.org_id IS NULL`) or tenant-level; `RBAC.md` §4a is the complete matrix.
- A platform-level role may only be granted at `platform` or `reseller` scope, and only by an actor who already holds platform admin — enforced in `fn_validate_user_role_scope`, not only in the service layer.
- Inheritance is downward only. This is what makes an `organization` grant sufficient for the workspaces beneath it, and what makes a `workspace` grant insufficient for anything above it.
- A new escalation path had to be closed explicitly: composing a custom tenant role containing a `platform.*` permission. `fn_validate_role_permission` refuses it at the database.

### Consequences for RLS

- `user_roles.org_id` becomes nullable — `NULL` for `platform` and `reseller` grants, which belong to no organization — with a check constraint enforcing the per-scope shape, and the value **derived by the trigger** rather than trusted from the writer.
- Policies are built from one predicate, `app_org_in_scope()`, which encodes platform-admin and reseller-reach alongside the direct organization match.
- Two session variables join `app.current_org_id`: `app.current_reseller_id` and `app.is_platform_admin`. Both are set only from resolved authentication material — and, since ADR-011, only from a grant that confers them (a reseller-scope grant; `alendei_super_admin` at platform scope), with the database validating each claim independently. Until ADR-011 the reseller variable was derived from the selected organization for every principal, which made sibling organizations under one reseller mutually visible.
- **RLS enforces the boundary down to organization only.** Workspace and team are enforced by the authorization layer above it. This is a deliberate, stated limit (`TENANCY.md` §3a) rather than an unexamined gap, and it is listed as a residual risk; `DECISIONS.md` D3 is the decision that would change it.

### Consequences for API and WebSocket authorization

- Authorization becomes two checks, not one: the permission, *and* whether it is held at a scope covering the target (`API.md` §3a).
- Enumeration inherits the same rule: out-of-scope resources are absent from listings, and a direct fetch returns `404` rather than `403`, so an id's existence is not disclosed.
- A WebSocket connection's scope is fixed at ticket-issue time and recorded on the ticket row; the connection never re-resolves scope and can never widen it (`API.md` §9a).

### Migration and compatibility

None. The contradiction was found during Phase 1A, before any `user_roles` row existed outside a development database, so the five-value enum ships in the first migration rather than as an `ALTER TYPE`. No production data, no deployed API and no external integration depends on the three-value form. Had this been found later, the change would have required an `ALTER TYPE ... ADD VALUE` plus a backfill of `user_roles.org_id` — which is precisely the cost avoided by resolving it at the first implementation gate.

## 1b. ADR-002 — Audit-log scope, integrity and retention

**Status**: Accepted (Phase 1B implementation). Extends ADR-001 to the audit trail; supersedes the `audit_logs` column list in the Phase 0.4 text of `DATABASE.md` §12 and the unqualified "partitioned from the outset" wording in §13.

### Context

Phase 1B built `audit_logs`. Reviewing the change set before the Phase 1B checkpoint surfaced six issues that could not be settled by reading the Phase 0 documents, because the documents either did not address them or contradicted the implementation.

| # | Issue |
|---|---|
| 1 | `acc_auth` had `WITH CHECK (true)` — the identity role could write an audit row naming any tenant, any actor and any action, including a fabricated successful role grant in another organization. |
| 2 | The row carried only `org_id` and `workspace_id`, so an action at `platform`, `reseller` or `team` scope had nowhere to record where it happened — even though `c3b15d4` had just made the five-level hierarchy canonical. |
| 3 | `causation_id` was absent, although `RequestContext`, the event envelope and `EVENTS.md` §2 all carry it. |
| 4 | `DATABASE.md` §13 said these tables are partitioned "from the outset"; the implementation was a plain table. |
| 5 | Nothing prevented impossible rows: a workspace from another organization, an `actor_type` contradicting the actor id, an API key from another tenant named as the actor. |
| 6 | `ON DELETE SET NULL` on `org_id` combined with the append-only trigger so that deleting an organization with audit history would fail with a confusing `insufficient_privilege` error from a trigger — an accidental interaction rather than a decision. |

### Decision

**1. Scope is recorded on the canonical five-level hierarchy, using the same enum as `user_roles`.** `audit_logs.scope_type` is `role_scope_type` — `platform | reseller | organization | workspace | team`. The scope an action *occurred at* and the scope a grant *applies at* are the same axis, so they share one vocabulary rather than growing a second, subtly-different one. (`TENANCY.md` §1a.2 warns specifically against conflating the three existing `scope_type` enums; this is reuse of the authorization one, not a fourth.)

**2. Tenancy columns are derived, never accepted.** A writer supplies only `(scope_type, scope_id)`. `fn_validate_audit_scope` resolves that pair, walks its ownership chain, and derives `reseller_id`/`org_id`/`workspace_id`/`team_id`, discarding whatever the writer sent. This mirrors `fn_validate_user_role_scope` (ADR-001). It relies on a documented PostgreSQL ordering property — a `BEFORE ROW` trigger runs before the RLS `WITH CHECK` expression — so the tenancy RLS authorizes is always the derived tenancy. That ordering is verified by an integration test, not assumed.

**3. `acc_auth` is confined by shape and vocabulary, not by `org_id`.** It genuinely cannot be bounded by tenant, because a failed login happens before a tenant is known. It is bounded instead by three simultaneous conditions: `scope_type='platform'` (so it can never name a tenant), `actor_type IN ('user','api_key')` (so it cannot impersonate `system` or `oauth_client`), and membership of a five-action vocabulary (so it cannot record a privileged action). The SQL list mirrors `AUTH_ROLE_AUDIT_ACTIONS` in `@acc/contracts` and a test fails if they drift. `acc_auth` holds no `SELECT`.

**4. `causation_id` is added**, nullable, alongside the `NOT NULL` `correlation_id`. `correlation_id` groups a causal chain; `causation_id` orders it and is null at the origin.

**5. Impossible rows are unrepresentable, at the database.** Composite foreign keys `(workspace_id, org_id) → workspaces(id, org_id)`, `(team_id, org_id) → teams(id, org_id)` and `(actor_api_key_id, org_id) → api_keys(id, org_id)` — following the `teams_workspace_org_fk` pattern — plus two check constraints, `audit_logs_scope_shape` and `audit_logs_actor_shape`. `api_keys` gained a `UNIQUE(id, org_id)` to make the third reference possible. These hold with the trigger disabled, which is how they are tested.

**6. An organization with audit history is not hard-deleted.** Every foreign key out of `audit_logs` is `ON DELETE RESTRICT`, and deactivation (`organizations.status='closed'`) is the modelled path — now stated normatively in `TENANCY.md` §1b rather than left implicit. `SET NULL` was rejected on two grounds: it destroys the tenancy attribution of past events, and on an append-only table it does not work anyway, because the cascade's internal UPDATE trips the append-only trigger.

**7. Append-only is enforced in three layers, and its limit is stated rather than glossed.** No principal holds `UPDATE`/`DELETE`/`TRUNCATE`; no UPDATE or DELETE policy exists; and a trigger refuses all three for every principal including the owner — with a separate statement-level trigger for `TRUNCATE`, which a row-level trigger does not cover. **A database trigger is not tamper evidence**: the owner or a superuser can drop or disable it. That capability is deliberately left in place (retention/archival and test teardown use it), and the controls that actually survive an owner-level adversary are external — the SIEM export in `EVENTS.md` §4, WAL archiving, and cloud-provider audit logging of administrative access. `SECURITY.md` §4a states this in full.

**8. Partitioning is deferred, with criteria.** `audit_logs` ships as a plain table. See "Partitioning" below.

### Partitioning — why deferred rather than built

`DATABASE.md` §13 said "from the outset". That wording is now corrected to "designed for", because building it in Phase 1B would have been cost without benefit:

- The benefit is cheap retention/archival — dropping a partition rather than deleting rows. §4 of this document already records that the retention policy for these tables is an undecided business input. Partitioning before that decision delivers none of it.
- The cost is real: a range-partitioned table cannot have a primary key excluding the partition key, so `id` becomes `(occurred_at, id)`, breaking the single-column UUIDv7 convention every other table follows (`DATABASE.md` §1); a partition-maintenance job does not exist in Phase 1; and the `BEFORE TRUNCATE` guard must be attached to **every partition individually**, because a TRUNCATE trigger on a partitioned parent does not fire when a partition is truncated directly. (Verified empirically against PostgreSQL 17 during this pass — it is not documented behaviour anyone should have to rediscover.)
- Deferring stays cheap because **nothing holds a foreign key *to* `audit_logs`**. Conversion is create-copy-swap, not a dependency-bearing rewrite.

**Partition when the first of these is true**: the retention policy is agreed with the business; the table exceeds roughly 50M rows or 50 GB; or Phase 7 begins. Whoever does it must attach the TRUNCATE guard to every partition and to the partition-creation routine.

### Consequences

- `ROADMAP.md` Phase 1's DB-changes list now names `audit_logs` under a Phase 1B sub-phase; it had previously appeared only in `DATABASE.md` §12a's "already built" domain map, which is how it came to be built without being listed as Phase 1 scope.
- `TESTING.md` §6j adds the audit matrix, including an RLS negative control of its own.
- Sub-organization scope is now *recorded* even though RLS still does not *filter* on it (`TENANCY.md` §3a). Narrowing an audit read to a workspace or team is a mandatory RBAC/ABAC authorization-layer check, unchanged by this ADR — never UI filtering.
- The residual risks this pass leaves open are listed in §3 below.

### Migration and compatibility

None. `audit_logs` had not been committed when these decisions were made, so the corrected table ships in its first migration rather than as an `ALTER`. The one change to an already-committed table is additive: `api_keys` gains `UNIQUE(id, org_id)`.

## 1c. ADR-003 — Phase 1B authentication, tenant context and authorization

**Status**: Accepted (Phase 1B planning review against `db6337e`). Governs the identity/tenancy/RBAC half of Phase 1B. Extends ADR-001 (scope hierarchy) and ADR-002 (audit log). Supersedes the MFA and rate-limiting statements in the Phase 0.4 text of `RBAC.md` §5, `SECURITY.md` §1 and `API.md` §5.

### Context

The Phase 1B planning review established that the database, contracts and configuration for identity/tenancy/RBAC are effectively complete, while the request path is unimplemented: `apps/api` has no `iam`, `tenancy`, `auth` or `rbac` module, `RequestContext.setPrincipal()` is never called, and `TenantDatabase.withRequestTenant()` is unreachable code. Nine decisions had to be settled before implementation, because each one changes either a wire contract, a database policy, or the shape of the authorization path.

### Decisions

**D-1 — First platform-admin bootstrap: an owner-run, idempotent CLI.**

`fn_validate_user_role_scope` refuses a platform-role grant unless the actor already holds platform admin, and no user is seeded — so the first grant is otherwise impossible. The bootstrap is a CLI run by the schema owner, following the precedent `seed.ts` already sets when it declares `app.is_platform_admin` to seed platform role rows. It is **never** exposed through the API and there is no unauthenticated HTTP privilege-grant route. It creates the first platform-admin user, grants `alendei_super_admin` at `platform` scope, is safe to rerun, requires explicit confirmation to execute against production, and never installs a fixed or default production password. It writes its own audit records. It **does not weaken `fn_validate_user_role_scope`** for normal application requests: the trigger is unchanged and the elevation is a transaction-local GUC set by the owner, exactly as seeding already does.

**D-2 — Audit synchronization: everything synchronous in Phase 1B.**

`SECURITY.md` §4 specifies a synchronous/asynchronous split, but Phase 1 has no outbox or queue, so "asynchronous" has no transport. In Phase 1B **all** audit writes are synchronous. A security-sensitive mutation writes its audit row **in the same database transaction** as the business mutation: if the audit insert fails, the business mutation rolls back. Non-sensitive writes are synchronous too, for the same reason — no transport exists. No fake post-commit transport is invented. `SECURITY_SENSITIVE_AUDIT_ACTIONS` and `isSecuritySensitiveAction()` are retained and used, because they are what Phase 2 will switch on when the outbox introduces the queued path.

**D-3 — Access-token claims: identity and session only.**

The access JWT carries `sub`, `sid`, `actor_type`, `jti`, `iss`, `aud`, `iat`, `exp` — and nothing else. It **never** carries `org_id`, `reseller_id`, `workspace_id`, `team_id`, roles or permissions as authoritative values. Tenant context and authorization are re-derived server-side from the verified credential and session on every request. This is what makes `TESTING.md` §6c's forged-claim test structurally true rather than incidental: a tenancy claim cannot influence authorization because no code reads one. The cost is a grant resolution per request; caching is deferred (D-8).

**D-4 — Multi-organization context: implicit when unambiguous, explicit otherwise.**

A principal may hold grants in several organizations; the derivation table in `TENANCY.md` §2a did not say which one wins. Resolved: exactly one organization in scope may be selected implicitly. More than one requires an explicit selector, canonically the **`X-Acc-Organization`** request header. Absent selector with several organizations in scope → `400 TENANCY_CONTEXT_REQUIRED`. Selector naming an organization outside the principal's authorized scope → `403 TENANCY_CONTEXT_MISMATCH`. Never a silent substitution, and never a silently empty result used to hide a context mismatch — an empty list and a refused context must remain distinguishable to the caller.

**D-5 — Target-scope authorization: a mandatory service-layer invariant with one reusable mechanism.**

Authorization has two dimensions, permission and target-scope coverage (`API.md` §3a), and both are mandatory. `AuthorizationGuard` can enforce the endpoint-level permission, but it is **not** sufficient for the target, because a target's scope is often knowable only after the resource is loaded. Every scoped service operation therefore performs an explicit target-scope check through the centralized `PermissionEvaluator`. Workspace and team authorization is an application/service invariant — **not** UI filtering, and **not** merely a code-review convention. One reusable mechanism is built for this; ad-hoc per-call-site scope checks are the failure mode it exists to prevent. This matters because RLS contains no workspace or team term (`TENANCY.md` §3a): below organization level, the service layer is the only enforcement there is.

**D-6 — MFA is out of Phase 1B.**

`RBAC.md` §5, `SECURITY.md` §1, `PRD.md` §86 and `API.md` §2 described MFA as required and routed an MFA challenge, while the repository contains no TOTP library, no MFA configuration, no MFA table and no organization MFA-policy column — only the unused `users.mfa_enabled` and `users.mfa_secret_ref` columns. Phase 1B adds no MFA library, table, configuration, enrolment flow, challenge flow or login branching. The affected documents are corrected in this pass so that Phase 1B does not claim MFA is implemented or mandatory. The `users` columns remain as reserved space.

**D-7 — Refresh-token transport: httpOnly cookie for the browser console.**

The refresh token is delivered to and consumed from the browser as an `httpOnly; Secure; SameSite=Lax` cookie, scoped to the refresh path. It is **never** readable by browser JavaScript and is **never** placed in `localStorage`, `sessionStorage` or a URL. `POST /auth/login` sets the cookie; `POST /auth/refresh` consumes it; the refresh token is not returned as ordinary JSON to browser JavaScript. Consequences are recorded in `API.md` §3b: CORS must be credentialed with an explicit origin allow-list (never `*`), and because `SameSite=Lax` is a mitigation rather than a guarantee, the refresh endpoint additionally requires a non-simple request (a custom header) so it cannot be driven by a cross-site form post. Non-browser clients (server-to-server) use API keys and never the refresh-cookie flow.

**D-8 and onward — deferrals retained.** Scope-set Redis caching; API-key rotation lineage; password reset/recovery; `users.locked_until` account lockout; WebSocket ticket consumption and the socket gateway; OAuth2/SSO; ABAC policy authoring; real worker identity. Each is listed in §2 or §3 of this document rather than left implicit.

### R4 — Unknown-user login failures are audited, with a system actor

An authentication failure for an address that matches no user has no real identity to name. It is **not** omitted from the audit trail, and a fictitious `actor_user_id` is **never** invented. Such an attempt is recorded as:

| Field | Value |
|---|---|
| `action` | `auth.login.failed` |
| `actor_type` | `system` |
| `actor_label` | `anonymous_login_attempt` |
| `scope_type` | `platform` |
| `outcome` | `failure` |

A failure for a **known** user uses `actor_type='user'` with the real `actor_user_id`. The `acc_auth` database policy permits the system-actor form for this **exact** case only — `action = 'auth.login.failed'` **and** `actor_label = 'anonymous_login_attempt'` — and is not opened to arbitrary system audit writes.

**Implementation status: this requires a schema change that is not yet made.** Verified against the migrated database at `db6337e`: the `audit_logs_actor_shape` CHECK constraint already **accepts** this row shape (a `system` actor with both id columns null and any label), so no table constraint changes. The `audit_logs_auth_insert` RLS policy, however, restricts `acc_auth` to `actor_type IN ('user','api_key')` and **rejects** it. Implementing R4 therefore requires one new migration that replaces that single policy. Migration `0001` is committed and applied and is not edited. Until that migration exists, the anonymous-failure path is specified but not writable.

### Consequences

- `TENANCY.md` §2a gains the multi-organization selection rule it did not previously state, and §2b gains `X-Acc-Organization` as an authoritative-selector row.
- `SECURITY.md` §4 gains the Phase 1B synchronization semantics and the anonymous-actor rule; §1's MFA bullet is corrected.
- `API.md` gains §3b (refresh-token transport, CORS and CSRF), an `/ws/ticket` row in §2, the API-key effective-permission formula in §3, and a corrected §5 rate-limiting locus.
- `RBAC.md` §5 is corrected for MFA and refresh transport and gains §5a (tokens), §5b (bootstrap) and §5c (API-key effective permissions).
- `DATABASE.md` §2a records the narrow `acc_auth` exception and its pending-migration status; §2's column lists are brought level with the schema.
- `ROADMAP.md` gains the 1B.1–1B.7 sub-phase sequence and Gate B.
- `TESTING.md` gains the Phase 1B categories and §6j is moved into order.

### API-key effective permissions

Recorded here because it spans `RBAC.md`, `API.md` and `TENANCY.md`:

```
effective_permissions =
      requested_key_scopes
    ∩ permissions_held_by_the_creator_at_the_key's_organization
    ∩ permissions_valid_for_the_target_operation
```

An API key is permanently bound to its organization (`api_keys.org_id`) and that binding is never widened. A client-supplied `workspace_id` or `team_id` can **narrow** what a key acts on; it can never create authority the key does not already hold. A key cannot be created carrying a permission its creator does not hold — the intersection is computed at creation and re-checked at use, because the creator's own grants may since have been revoked.

## 1d. ADR-004 — Phase 1B.4 scope, tenant-context hardening and the deferred worker harness

**Status**: Accepted (Phase 1B.4, against `b8aebd3`). Records what Phase 1B.3 actually built versus what `ROADMAP.md` §4a assigned it, and re-scopes Phase 1B.4 accordingly. Extends ADR-003; supersedes nothing.

### Context

`ROADMAP.md` §4a assigned `ScopeResolver`, the `X-Acc-Organization` selector, `TenantDatabase.withRequestTenant()` and "RLS exercised by real requests" to Phase 1B.4, and `scopeCovers` plus `PermissionEvaluator` to Phase 1B.5.

Implementation did not follow that split, for a reason visible only once the work started: the 1B.3 exit criterion is the authenticated chain proven end to end (`ROADMAP.md` §4a), and that chain *is* scope resolution, organization selection, tenant context and an RLS-filtered query. The chain could not be demonstrated without building them, and a demonstration built on stubs would have proven nothing. `PermissionEvaluator` followed for the same reason: `TenancyController` had to authorize its read, and the alternative was an ad-hoc check — precisely what ADR-003 D-5 forbids, and precisely the thing that is never removed later.

So at `b8aebd3` the following are complete, tested and in production code rather than pending:

| Capability | Roadmap phase | Actually delivered |
|---|---|---|
| `ScopeResolver` | 1B.4 | 1B.3 — `apps/api/src/auth/scope-resolver.service.ts` |
| `X-Acc-Organization` selection | 1B.4 | 1B.3 — `ScopeResolver.selectOrganization` |
| `withRequestTenant()` | 1B.4 | 1B.3 — `apps/api/src/database/tenant-database.service.ts` |
| RLS exercised by real requests | 1B.4 | 1B.3 — `TenancyController`, proven in `auth-chain.int-spec.ts` |
| `scopeCovers` | 1B.5 | 1B.3 — `packages/contracts/src/roles.ts` |
| `PermissionEvaluator` | 1B.5 | 1B.3 — `apps/api/src/auth/permission-evaluator.service.ts` |

### Decisions

**D-1 — The phase boundary follows the code, not the plan.** These capabilities are not rebuilt, duplicated, renamed or artificially re-separated to make the repository match the original phase table. Re-deriving a working authorization path to satisfy a document is how a second authorization framework gets built, and two mechanisms that decide the same question are worse than one in the wrong phase. `ROADMAP.md` §4a is corrected to describe what happened instead.

**D-2 — Phase 1B.4 is re-scoped to tenant-context hardening and closure.** What remains genuinely unbuilt, and is the whole of this phase:

1. this documentation reconciliation;
2. pooled-connection tenant-context tests — the `TESTING.md` §6h cases, against a real pool and real RLS;
3. one generic advisory-identifier cross-check mechanism, replacing the hand-written comparison in `TenancyController`.

**D-3 — The advisory-identifier cross-check is a guard, and is an assertion rather than a resolver.** A client-supplied organization, workspace or team identifier is advisory (`TENANCY.md` §2b). `AdvisoryTenantGuard` cross-checks every declared identifier against the context already resolved by the authentication path, and refuses a contradiction with `403 TENANCY_CONTEXT_MISMATCH`. It reads no database, resolves nothing, and can only ever narrow or refuse — never widen, never substitute, and never convert a refusal into an empty result.

It is deliberately **not** a second authorization framework. `PermissionEvaluator` and `scopeCovers` are untouched: whether a principal may act *on* a scope is still their question, asked once the target and its ancestry are loaded. This answers only the narrower one — does the identifier the caller supplied contradict the context the server derived?

Where the resolved context does not pin a level — an organization-scoped principal supplying a `workspace_id`, say — the guard has nothing to contradict, and says so rather than inventing an answer. Deciding that case here would mean loading tenancy rows to validate a hint, which is the alternate tenant resolver this mechanism must not become. It is handed on to the layers that can answer it with the row in hand: `PermissionEvaluator` for target-scope coverage, RLS for organization isolation, and `404`-without-echo for a row that was never visible (`API.md` §3a).

**D-4 — A repeated or structured identifier is refused, never resolved.** `?org_id=A&org_id=B` has no defensible "the" value; choosing one would make a security decision depend on parameter order. Any non-string value — an array, or a structured parameter — is `400 VALIDATION_FAILED`, as is a malformed or empty one. Deterministic and fail-closed, in that order.

**D-5 — The worker/job tenant-context harness stays deferred to Phase 2.** *(Superseded in timing by ADR-013 PD-1, 02-Oct-2026: not Phase 2 scope; deferred to the first phase with a real consumer.)* `TENANCY.md` §5 requires a shared harness wrapping every consumer/job handler in steps 3-7, so no worker can opt out. Phase 1B has no worker: no Kafka consumer, no outbox relay, no fallback-timer poller, no scheduled job.

Building it now is rejected rather than forgotten. A harness with no consumer has no execution semantics to define and nothing to validate against — the shape of its envelope contract, its failure and retry behaviour, and its interaction with the outbox are all decided by the first real consumer, and a harness guessed at in advance would be rewritten by it or, worse, quietly worked around. The database-side guarantee it depends on is not deferred with it: `withTenantTransaction` is already the single sanctioned shape for both HTTP and worker access, and §6h's pooled-connection and error-path cases are proven in this phase against a real pool. What Phase 2 adds is the enforcement wrapper, not the mechanism.

Consequently `TESTING.md` §6h is satisfied for the connection-pooling half at Gate B and explicitly *not* for the worker half — recorded the same way §6i records the deferred WebSocket gateway, rather than passed over.

### Consequences

- `ROADMAP.md` §4a's 1B.4 and 1B.5 rows are corrected to the delivered split, and 1B.4's exit criteria become the three items in D-2.
- `TENANCY.md` §2b gains the shared mechanism as the named implementation of the advisory rule; §5 records the deferred harness and what is proven without it.
- `TESTING.md` §6h is split into its satisfied and deferred halves, and gains §6k.5 for the advisory-identifier matrix.
- `ARCHITECTURE.md` §4's `auth` and `tenancy` rows are corrected: `PermissionEvaluator` lives in `auth`, and `tenancy` owns the advisory cross-check.
- `API.md` §3a's advisory-identifier rule gains its concrete error semantics.
- `RBAC.md` §2 records that the one reusable target-scope mechanism shipped in 1B.3.
- `SECURITY.md` §3 records the cross-check as a named control.

### Residual risk

The over-approximation ADR-003 left in `PermissionEvaluator.grantCarries` is unchanged — a principal holding a permission through any grant is treated as holding it through each. It is out of scope here and closes in Phase 1B.5 with per-grant permission sets. The advisory cross-check narrows the blast radius but does not substitute for it: the two answer different questions.

## 1e. ADR-005 — Coherent-grant authorization

**Status**: Accepted (Phase 1B.5 planning review against `9d946f1`). **D-1 to D-4 implemented in Phase 1B.5.1; D-5 in Phase 1B.5.2; D-6 in Phase 1B.5.3; D-8's schema half in Phase 1B.5.4; the grant-administration and escalation guards in Phase 1B.5.5; D-7 in Phase 1B.5.6.** Every decision in this ADR is now implemented. Governs the authorization half of Phase 1B. Extends ADR-001 (scope hierarchy) and ADR-003 (D-5, target-scope authorization); supersedes nothing. Closes the over-approximation ADR-003 recorded and ADR-004 carried forward.

### Context

`PermissionEvaluator` asks two questions — does the principal hold the permission, and does it hold it at a scope covering the target — and ADR-003 D-5 made both mandatory. What neither ADR stated is that the two questions must be answered about the **same grant**.

They are not. `PermissionEvaluator.grantCarries()` ignores its `roleId` argument and returns `principal.permissions.includes(permission)`, the flattened union across every grant the principal holds. The whole of `allows()` therefore reduces to:

```
allows(P, target)  ⟺  (∃ g₁ : P ∈ permissions(g₁))  ∧  (∃ g₂ : scopeCovers(g₂, target))
```

`g₁` and `g₂` need not be the same grant. This is a cross-product, not a grant evaluation.

Verified empirically against the real evaluator and the real seeded role definitions:

```
Grant A: read_only          @ organization org-1
Grant B: workspace_manager  @ workspace    ws-1

role_assignments.grant @ ORGANIZATION org-1
  read_only carries it?              false
  workspace_manager carries it?      true
  workspace grant covers org target? false
  ⇒ no coherent grant authorizes it
  EVALUATOR SAYS ALLOWED:            true
```

`teams.create`, `workspaces.update` and `users.invite` behave identically at organization scope. A permission held by *neither* role is still correctly denied, so this is a scope-binding failure rather than allow-all.

Three corrections to the risk as previously recorded:

1. **The recorded mitigation reasons in the wrong direction.** Both `DECISIONS.md` §3 and the comment at `permission-evaluator.service.ts` bounded the risk on the grounds that no endpoint targets a scope *below* organization level. The over-approximation is *upward*: a permission conferred at a narrow scope is honoured at a wider one. It is vertical privilege escalation, which is `TESTING.md` §6b's own subject, and the "no endpoint below organization" argument does not bound it at all.
2. **No custom role is required.** Stock seeded roles reproduce it. The example above is the ordinary "organization-wide reporting access, plus manages one workspace" user.
3. **It is latent, not absent.** The only live endpoint checks `workspaces.read`, which every seeded role carries, so the cross-product currently has nothing to expose. Phase 1B.5 introduces `role_assignments.grant` as an endpoint permission — which turns this into a privilege-escalation primitive inside the privilege-management API itself.

The second-order consequence matters as much as the first: `RBAC.md` §7's "no granting a permission you do not hold" guard, if written against `principal.permissions`, **inherits the defect** rather than containing it.

The same class of error exists a second time, at the API-key creator intersection: it intersects against the creator's flattened union across all grants, while `RBAC.md` §5c specifies the creator's permissions *at the key's organization*.

### Decisions

**D-1 — A decision is authorized only when one grant supplies both the permission and the covering scope.**

```
ALLOW(P, target)  ⟺  ∃ g ∈ grants(principal) :
        P ∈ permissions(g.role)
    ∧   scopeCovers(g.scope, target.scope, target.chain)
    ∧   g is active
```

Existential over grants, conjunctive within a grant. Holding `P` through *any* grant is never sufficient. `scopeCovers` is correct as it stands and is **not** modified: the correction is entirely in what the evaluator is given to reason over.

Verified against the unmodified `scopeCovers`: this rule denies every escalation above while preserving every legitimate case — `role_assignments.grant` at workspace `ws-1` and at team `tm-1`, `audit.read` and `workspaces.read` at organization `org-1`, and `workspaces.read` at team `tm-1` all remain allowed; a sibling workspace remains denied.

**D-2 — `RoleGrant` carries its own permissions. No schema change is required.**

`role_permissions (role_id, permission_id)` already *is* the per-grant permission relation; the mapping is discarded in exactly one place, `ScopeResolver.permissionsForRoles`, which selects `DISTINCT key` and drops `role_id`. The correction is to stop discarding it: the resolver returns permissions per role, and each `RoleGrant` on the principal carries the set its own role confers. The query changes from `SELECT DISTINCT key` to `SELECT role_id, key` over the same index — not a new query, and not an N+1. `DECISIONS.md` D11 (no scope-set caching) is unaffected.

**D-3 — `AuthPrincipal.permissions` is retained, and is not authoritative for authorization.**

The flattened union has two legitimate consumers: the API-key creator intersection (`RBAC.md` §5c is defined on the creator's *held* permissions) and capability hints for rendering a console. It stays, and is documented as **not** an authorization input. The evaluator stops reading it as the deciding term. Removing it would break `RBAC.md` §5c; leaving it undocumented is how it gets read as a decision source again.

**D-4 — The API-key intersection is taken at the key's binding scope.**

```
effective = requested_key_scopes
          ∩ { P : ∃ coherent creator grant g,
                  P ∈ permissions(g) ∧ scopeCovers(g.scope, key.bindingScope) }
```

Today a creator who is `read_only` in Org-1 and `org_admin` in Org-2 can mint a key bound to Org-1 carrying `org_admin` permissions. This is D-1's defect wearing a different hat and is corrected in the same increment, so the two cannot drift apart.

**D-5 — A target's `ScopeChain` is resolved from the database, never from request input.**

`scopeCovers` is only as correct as the ancestry it is given, and coverage below organization level cannot be decided from ids alone. The chain is resolved inside the request's own tenant transaction, so RLS filters it: a target in another organization resolves to nothing, and that is a `404` without echo (`API.md` §3a), not a `403`. A chain taken from request input would be a complete bypass of the scope model, so this is stated as an invariant rather than left to each call site.

This composes with, and does not replace, the advisory-identifier cross-check (ADR-004 D-3). That one refuses a *supplied* identifier that contradicts the resolved context, before the handler runs. This one establishes the *authoritative* ancestry of a target the handler has loaded. Neither substitutes for the other.

**Implemented in Phase 1B.5.2**, with three notes worth recording because each was decided at implementation time rather than here:

- **Placement.** This ADR anticipated `ScopeChainResolver` living in `tenancy`. It ships in `auth`, beside `ScopeResolver` — which already reads `organizations`, `workspaces` and `teams` for exactly this purpose. Putting it in `tenancy` would have forced `AuthModule` to import `TenancyModule`, re-ordering the global `APP_GUARD` registration that `AdvisoryTenantGuard` depends on (ADR-004). The module graph is unchanged instead.
- **Ancestry is unrepresentable, not rejected.** `AuthorizationCheck` has no `chain` field, so there is no input through which forged ancestry could arrive. A test asserts the field's continued absence, because adding one would silently restore the whole class of attack.
- **A behaviour change, deliberately made.** The controller previously synthesized `chain: { orgId }`, omitting the reseller term — so `scopeCovers` compared `undefined` against a reseller grant's scope and a **reseller-scoped principal was refused at an endpoint that tenant selection and RLS had both already admitted it to**. Fail-closed, untested, and contrary to §1a.4 of `TENANCY.md`. A database-resolved chain carries the reseller term and the documented model now holds; both the widening and its boundary (another reseller's organization stays unreachable) are asserted.

The declarative `@RequiresPermission` half is **not** built *at 1B.5.2*. Extracting a target from a request has no established convention — the two live handlers target the resolved organization rather than a route parameter — and inventing one before the administration endpoints exist would fix the wrong shape. It moves to 1B.5.7 with §6n's route-table assertion, which depends on the same convention. The structural guarantee available today is enforced instead: no controller may import `PermissionEvaluator`.

**Resolved in Phase 1B.5.7.** The convention the administration endpoints established is that almost every scoped route targets the request's resolved organization, and exactly two — granting and revoking a role — target a scope knowable only from the body or the stored row. The decorator encodes that distinction (`organization` versus `deferred`, the latter requiring a stated reason).

It **declares** rather than enforces, and that is forced by D-5 rather than chosen: the chain must be read inside the request's own tenant transaction, which does not exist when a guard runs. A guard that authorized would open its own, splitting the decision from the mutation across two transactions and leaving a time-of-check/time-of-use window. Enforcement stays in `AuthorizationService.assert`; `AuthorizationCoverageInterceptor` cross-checks that the declared permission was actually asked for and fails the response closed otherwise, which suppresses an unauthorized read and — for a mutation, where the write has already committed — leaves the structural guarantee to §6n case 30.

**D-6 — Refused authorization is audited with the actor's own scope; successful checks are not audited.**

`authorization.denied` records `(scopeType, scopeId)` as the **actor's** resolved, legitimate scope. The attempted target lives in `metadata` and in `resourceType`/`resourceId`. An attacker-supplied target must never become the record of where the actor legitimately was, and an actor scope is never fabricated to make a row fit. The response carries `403 AUTHZ_SCOPE_DENIED` and echoes no target.

A denial has no business transaction to couple to, so it is written **synchronously in its own transaction**, and a failed audit write fails the request closed. The caller receives a refusal either way — the request was never going to succeed — so the coupling costs nothing and the record is guaranteed. `authorization.denied` is therefore added to `SECURITY_SENSITIVE_AUDIT_ACTIONS`, where it is currently missing.

**Successful authorization checks are deliberately not audited.** The *operation* is audited — `role.created`, `user_role.granted` and the rest. Recording every successful check would write a row per check per request and bury the trail that has forensic value. This is a rejection, not an omission. The same reasoning excludes the non-throwing capability probe used for listings and UI affordances: it asks a hypothetical, not an attempt.

**Implemented in Phase 1B.5.3**, owned by `AuthorizationService`. `PermissionEvaluator` and `ScopeChainResolver` remain free of audit concerns; the evaluator's refusal is caught, recorded, and rethrown untouched, so there is still exactly one definition of what a denial looks like to a caller.

Two notes worth recording because the separate transaction was challenged during implementation and re-confirmed:

- **Why the caller's transaction cannot be used.** The refusal is thrown *out of* the transaction the caller opened, which rolls it back. A denial record written there would be discarded on every single denial — the control would report nothing while appearing to work. The record is therefore committed in its own transaction *before* the refusal is raised. Its durability across a later rollback of the surrounding request is the intended behaviour, not a side effect: the attempt happened.
- **Actor scope is narrowest-first** — workspace, else organization, else reseller, else platform — and no fallback is invented. A principal with no resolved scope cannot be described honestly and the `audit_logs` RLS policy would refuse the row regardless, so that case fails closed and loudly. It is defensive: every reachable path resolves a tenant context before any authorization check.

**Residual risk accepted here:** the denial audit acquires a second pooled connection while the caller's transaction still holds one. Under enough *concurrent* denials to exhaust `DATABASE_POOL_MAX`, the second acquisition waits and is bounded by `connectionTimeoutMillis`, after which the request fails closed with a generic `500` rather than a `403`. Denials are rare relative to pool size, the failure direction is safe, and the alternative — coupling to the caller's transaction — loses the record entirely. Revisit if denial volume ever approaches pool capacity.

**D-7 — The at-least-one-active-platform-admin invariant is enforced by a database trigger taking `pg_advisory_xact_lock`.**

The invariant, stated exactly:

> At every committed state there exists at least one user `u` with `u.status = 'active'` holding a grant of a platform role at `platform` scope.

"Active" is load-bearing: a disabled user holding `alendei_super_admin` cannot authenticate and therefore does not satisfy it. Three operations can violate it — revoking the grant, disabling the user, deleting the role.

An application-level count cannot enforce it. Two concurrent transactions each count two admins, each decide the removal is safe, each remove a *different* admin, and both commit. Under `READ COMMITTED` neither sees the other's uncommitted delete and no row they wrote overlaps, so nothing serialises them. This is textbook write-skew.

| Mechanism | Why not / why |
|---|---|
| `SELECT … FOR UPDATE` on `user_roles` | **Rejected.** It locks rows that exist; the hazard here is the *absence* of rows, and a concurrent INSERT of a new admin is not blocked by it |
| `SERIALIZABLE` isolation | **Rejected.** Correct, but it changes the isolation level of the whole request path and forces retry-on-`40001` handling everywhere, for one invariant |
| Partial unique index / CHECK | **Rejected.** Constraints are per-row and cannot express "at least one row exists" |
| **`pg_advisory_xact_lock`** | **Chosen.** Serialises exactly the three mutators of this invariant, releases automatically on commit *and* rollback — the same property that makes `SET LOCAL` safe — requires no isolation change, and contends only between platform-admin mutations, which are rare |

The lock key is a fixed constant exported from `@acc/db` (`PLATFORM_ADMIN_LOCK_KEY`), so every call site takes the same lock; a second key would silently disable the guarantee, and the suite asserts the constant and the function body agree rather than trusting review. The service takes it **before** the DELETE, so that path's ordering is advisory lock first and row locks second; the trigger re-acquires the same key, which within one transaction is a no-op.

**Implemented in Phase 1B.5.6**, with three refinements worth recording:

- **A fourth violation path.** Deleting the *user* cascades to `user_roles` and so performs a real DELETE on the guarded table. It is covered because the trigger sits on the table rather than on an API path — which is the argument for putting it there.
- **Row-level `AFTER` triggers with `WHEN` clauses**, not statement-level with transition tables. PostgreSQL forbids transition tables on a trigger with a column list, and dropping `UPDATE OF status` would fire the guard on every `users` write, `last_login_at` on each sign-in included. `AFTER … FOR EACH ROW` is equivalent here because PostgreSQL queues AFTER-row triggers and fires them once the statement has completed, so every invocation observes the final state and a collectively-safe multi-row statement is never refused on an intermediate one. The `WHEN` clause is what keeps ordinary tenant revocation free of the lock entirely.
- **The invariant is one plain function** called by two thin trigger wrappers, rather than duplicated per path. A trigger function cannot be invoked from another trigger function in any case, and two copies would eventually disagree.

Enforcement lives in the database, for the reason `RBAC.md` §6 already gives for cross-tenant grants: a guard that exists only in the service is a different quality of assurance, and a migration script or admin tool bypasses it. The service keeps its own check for a clear `409`; the trigger is the guarantee.

**D-8 — Role deletion is refused while grants exist. No soft delete.**

`roles.id` is referenced by `user_roles.role_id` with `ON DELETE CASCADE`, so deleting a role today silently revokes every grant of it across the organization with **no audit row for any of those revocations** — an unbounded, unaudited privilege change from one statement. Deletion is instead refused with `409` while any grant exists; the administrator revokes explicitly and each revocation is audited individually. This mirrors `TENANCY.md` §1b, where an organization with history is closed rather than deleted.

Soft deletion is rejected. A `deleted_at` the evaluator must filter on is a new bypass surface: one query that forgets the predicate silently resurrects a revoked role. Refusing while referenced gives the same safety with no new state to keep consistent.

`role_permissions` still cascades — it is the role's own composition, and the `role.deleted` audit row carries the full permission set in `before`. `audit_logs` holds no foreign key to `roles`, so deletion never threatens audit integrity. System roles (`is_system_role`) and platform roles (`org_id IS NULL`) are never deletable through the API at all.

**D-9 — Grant revocation is a hard delete plus a security-sensitive audit row.**

No `revoked_at` column on `user_roles`. A revocation column would become a second source of truth the evaluator must filter on, and a missed predicate would silently restore authority — the same failure mode D-8 rejects soft deletion for. The `user_role.revoked` audit row, written in the same transaction as the delete, is the durable record.

### Consequences

- `RBAC.md` §2 gains the coherent-grant formula; §5c is corrected to the key's binding scope; §7's first two guards are restated as `(permission, scope)` pairs; a new §8 records the role and grant lifecycle.
- `SECURITY.md` §2a records per-grant decisions; §4 gains the `authorization.denied` semantics.
- `TENANCY.md` §1a.4 gains coherence as a fourth invariant; §3a cites it where workspace/team enforcement is described.
- `API.md` §2 marks `/roles`, `/role-assignments` and `/permissions` as Phase 1B.5; §3a clarifies that the endpoint guard is necessary but not sufficient; a new §3c specifies the endpoint surface.
- `ARCHITECTURE.md` §4 gains `AuthorizationService`/`@RequiresPermission` on `auth` and `ScopeChainResolver` on `tenancy`.
- `DATABASE.md` §2 records the planned migrations; §14a gains the advisory-lock ordering rule.
- `TESTING.md` §6b is replaced by the adversarial matrix, §6e gains the concurrency and scope-type cases, and §6n records the Phase 1B.5 suite and its mutation table.
- `ROADMAP.md` §4a replaces the 1B.5 row with seven increments and renumbers the identity surface to 1B.6 and the vertical slice to 1B.7; §4b gains the Gate B criteria this ADR implies.
- **Four statements in the repository are stale as of this ADR and are recorded here rather than changed in a documentation-only pass**, each with the increment that closes it:

  | Stale statement | Where | Closes in |
  |---|---|---|
  | The comment bounding the over-approximation on the grounds that no endpoint targets below organization level — the direction is inverted (see Context) | `apps/api/src/auth/permission-evaluator.service.ts` | ✅ 1B.5.1, with the correction itself |
  | The API-key creator intersection taken over the creator's flattened union, contradicting `RBAC.md` §5c | `apps/api/src/auth/auth.guard.ts` | ✅ 1B.5.1 (D-4) |
  | `RoleDefinition.allowedScopeTypes` — a documented constraint enforced nowhere. An unenforced documented constraint is worse than an absent one, so it is either enforced or deleted | `packages/contracts/src/roles.ts`, `RBAC.md` §7 | ✅ **closed.** Schema in 1B.5.4 (`roles.allowed_scope_types`, migration `0004`); grant-time enforcement in **1B.5.5**, which also closed §6n case 28 with `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED`. `ROADMAP.md` previously listed case 28 under 1B.5.4, contradicting this row and `RBAC.md` §7; corrected in 1B.5.4 in favour of this assignment, because case 28 tests a grant and no grant API existed until 1B.5.5 |
  | `TENANT_ROLE_DEFINITIONS` — defined, exported, and seeded by nothing. Only `PLATFORM_ROLE_DEFINITIONS` reaches the database | `packages/contracts/src/roles.ts`, `packages/db/src/cli/seed.ts` | 1B.5.4, seeding tenant roles at provisioning |
  | `AUDIT_ACTIONS.AUTHORIZATION_DENIED` — defined in the contract, written by no code path, and absent from `SECURITY_SENSITIVE_AUDIT_ACTIONS` | `packages/contracts/src/audit.ts` | 1B.5.3 (D-6) |

  None of them is edited in the 1B.5.0 pass: this increment records decisions, and changing code to match a decision is the next increment's work.

### Residual risk

- **Workspace and team isolation still has no database backstop.** RLS carries no workspace or team term (`TENANCY.md` §3a). D-1 makes the application layer *correct*; it does not make it *redundant*. This remains the highest residual risk in Phase 1B.
- **A future endpoint can still omit the target-scope call.** Mitigated by a test asserting every scoped route performs exactly one target-scope check, not eliminated.
- **ABAC is advertised and not implemented.** `RBAC.md` §1 describes RBAC *and* ABAC; only RBAC with scope coverage exists. Attribute conditions are deferred beyond Phase 1B (D20) and Gate B must say so rather than imply otherwise.
- **`TENANT_ROLE_DEFINITIONS.allowedScopeTypes` is a documented constraint enforced nowhere**, and `TENANT_ROLE_DEFINITIONS` itself is defined and never seeded. Both close in Phase 1B.5 (1B.5.5 and 1B.5.4 respectively); an unenforced documented constraint is worse than none. **1B.5.4 closed the seeding half** with `TenantRoleProvisioner` — transaction-bound, idempotent, emitting `role.created` only for a role actually created — and gave `allowedScopeTypes` a column to live in; its integration with organization creation is deferred to 1B.8, which is the phase that introduces organization creation.
- **Denial rows are attacker-influenceable in volume.** A valid principal can generate unbounded `authorization.denied` rows by probing. Accepted, and named as an additional trigger for the `audit_logs` partitioning decision deferred in ADR-002.

## 2. Non-blocking future decisions (confirmed — none of these affect Phase 1 correctness)

| # | Decision | Why it's genuinely deferrable | Current default |
|---|---|---|---|
| D1 | Physical per-tenant isolation for logs/search index at scale | Only matters at a scale/contractual tier Phase 1 does not reach | Logical isolation (tenant_id filter) for all tenants; revisit as an enterprise-tier feature |
| D2 | Dedicated Kafka topics/partitions for very high-volume tenants | A capacity-triggered optimization, not a correctness requirement — tenant-keyed partitioning on shared topics is correct at Phase 1–8 volumes | Shared topics with tenant-keyed partitioning |
| D3 | Whether `workspace_id` should be mandatory (not just optional) on every tenant-scoped table | Every org already gets a seeded default workspace (`TENANCY.md` §1); making the column itself `NOT NULL` later is a non-breaking tightening, not a blocking ambiguity now | Optional column, default workspace seeded per org |
| D4 | Event schema format (JSON Schema vs. Avro/Protobuf) | JSON Schema is sufficient through Phase 2; schema evolution pain, if it emerges, is addressable without redesigning the event envelope (`EVENTS.md` §2) | JSON Schema |
| D5 | Cross-channel conversation grouping (does a WhatsApp thread and an SMS thread with the same contact ever merge?) | Purely a Phase 8 inbox UX decision; the `conversations` grouping key is trivially changeable before Phase 8 without affecting Phases 1–7 | Grouped by `(org_id, contact_id, channel)` — no cross-channel merge yet |
| D6 | SSO/SAML/OIDC and full OAuth2 partner-integration implementation timing | Architecturally reserved (identity type defined in `API.md` §3); no Phase 1–8 work depends on it existing yet. Note: the per-organization IdP configuration column `DATABASE.md` §2 once implied is **not** present on `organizations` and is deferred with this decision | Reserved, not implemented; recommend deciding before Phase 9 |
| D10 | MFA/TOTP implementation phase | Resolved out of Phase 1B by ADR-003 D-6: no library, configuration, table or flow exists, and the login path is simpler without a challenge branch. Nothing in Phases 1–2 depends on it | Out of Phase 1B; `users.mfa_enabled`/`mfa_secret_ref` remain reserved columns. Decide the implementing phase before any real customer PII or production tenant is onboarded |
| D11 | Scope-set caching for per-request grant resolution | ADR-003 D-3 re-derives grants per request by design; caching is a measured optimization, not a correctness requirement, and a stale cache is an authorization risk | Uncached in Phase 1B; revisit with measurements |
| D16 | How an invited user receives the ability to set a password (re-confirmed **DEFERRED** out of Phase 1C by ADR-012 OD-9) | Phase 1B.2 implements `activate(userId, password)` as a service primitive, which is all the bootstrap CLI needs. A delivery mechanism requires either an invitation-token table or an administrator-set password, plus (for the token route) a mail transport that does not exist | **Still undecided, and no longer blocking the `/users` surface.** Phase 1B.6.1 ships user lifecycle *without* it (ADR-007 D-5): `POST /users` creates an `invited` identity, accepts no password, returns none and sends nothing, so a created user is exactly as usable as one the bootstrap CLI has not activated. What remains blocked is only credential *delivery* — a created user cannot sign in until this is decided. Options unchanged: an `invitation_tokens` table with a hashed, short-lived, single-use token; or administrator-set initial passwords with forced rotation on first login. Email change (ADR-007 D-3) needs the same machinery and is deferred with it. **On the naming**: `users.invite` and `user.invited` are retained as they are. Today the endpoint creates an identity in `invited` state and delivers nothing — so the vocabulary currently describes the *state reached*, not a message sent, and `API.md` §3d and `FRONTEND_API_CONTRACT.md` §30d both say so explicitly rather than leaving it to inference. The names are already part of the established permission catalogue, the seeded role definitions, the audit vocabulary and migration `0008`, so renaming them would churn every grant and every stored audit row for a semantic shade. When this decision lands, delivery attaches to that same endpoint and the existing terminology becomes literal. Do not change the vocabulary before then |
| D12 | Password reset / account recovery | No mail transport exists in Phase 1, and the flow is not in `API.md` §2's resource areas | Deferred; required before external users self-serve |
| D13 | Account lockout (`users.locked_until`) beyond rate limiting | Redis rate limiting plus `auth.login.failed` audit covers Phase 1B's threat model; lockout adds a denial-of-service vector against a known address | Deferred; rate limiting only |
| D14 | API-key rotation as a first-class operation with lineage | Revoke-plus-create already produces two audit rows describing the same change | Deferred |
| D15 | WebSocket ticket consumption and the socket gateway (re-confirmed **DEFERRED** by ADR-012 OD-11) | There is no real-time consumer until Phase 8; building consumption now means a socket server with nothing to serve. Ticket *issuance* is in Phase 1B | Issuance only in Phase 1B; consumption deferred, so `TESTING.md` §6i is only partly satisfiable at Gate B |
| D7 | RTO/RPO targets in `DR.md` §3 | A business-input number, not an engineering ambiguity — the mechanisms (WAL archiving, cross-region replication) are already fully specified regardless of the exact target number | Placeholder targets pending business/product-owner confirmation before Phase 12 |
| D8 | Data-subject request handling (DPDP/GDPR erasure/export) | No real contact PII is processed before Phase 3, and even then only simulator-backed test data through Phase 12 — there is no Phase 1 code path this blocks | Not yet designed; required before any real customer PII is processed |
| D9 | Modular monolith vs. early service extraction for `provider-adapters` under high throughput | Module boundaries are already drawn specifically so this is a deployment-topology change later, not a Phase 1 architectural fork | Modular monolith through Phase 2–8 |
| D17 | Grant revocation representation | A `revoked_at` column would be a second source of truth the evaluator must filter on, and a missed predicate would silently restore authority (ADR-005 D-9) | Hard `DELETE` on `user_roles` plus a security-sensitive `user_role.revoked` audit row in the same transaction; no revocation column |
| D18 | Role deletion representation | Soft deletion adds state the evaluator must filter on; refusing while referenced gives the same safety with none (ADR-005 D-8) | Deletion refused with `409` while any grant exists; no `deleted_at`. System and platform roles never deletable through the API |
| D19 | Transaction coupling for denial auditing | A refusal has no business transaction to couple to, and coupling it to one would turn a `403` into a `500` on audit failure (ADR-005 D-6) | `authorization.denied` written synchronously in its own transaction, failing the request closed; added to `SECURITY_SENSITIVE_AUDIT_ACTIONS` |
| D20 | Whether successful authorization checks are audited | One row per check per request buries the trail that carries forensic value; the *operation* is already audited (ADR-005 D-6) | Not audited. Only refusals and the operations themselves are recorded |
| D21 | ABAC attribute-condition evaluation | `RBAC.md` §1 describes RBAC *and* ABAC; only RBAC with scope coverage exists. No Phase 1B endpoint needs an attribute condition, and authoring them without a policy surface would be speculative | Deferred beyond Phase 1B, with `PermissionEvaluator` as the documented insertion point. Gate B states plainly that attribute conditions are not implemented |
| D22 | Platform-role administration through the API | Platform roles are the control plane's own authority; making them editable by any API caller would put the escalation guard inside the thing it guards | Immutable through the API. Administrable only by migration or seed, as `seed.ts` already does |
| D23 | Cross-user authorization introspection (**self-only endpoint shipped in 1B.5.7**; no cross-user variant, and no parameter exists to request one) | The console cannot render a correct permissions UI from a flattened union, but "effective permissions of another user" is an enumeration surface with no Phase 1B consumer | `GET /auth/me/authorization` is self-only, disclosing nothing the principal could not already derive. No cross-user variant in Phase 1B |

## 1f. ADR-006 — HTTP idempotency is one transaction, and only successes are stored

**Status**: Accepted (Phase 1B.5.9). Implements `API.md` §4 and `DATABASE.md` §7.1. Extends ADR-005 D-5 (authorization inside the request's transaction); supersedes nothing.

### Context

`idempotency_keys`, its RLS policy and its `(org_id, endpoint, idempotency_key)` unique index have existed since migration `0000`, and `DATABASE.md` §7.1 already specified claim → mutate → finalize. What was missing was the implementation and three decisions the specification left open.

### D-1 — The claim, the mutation and the finalize share **one** transaction

The failure this mechanism exists to prevent is: the mutation commits, the process dies, the record is never finalized, and the retry mutates again. Ordering the two writes carefully does not close that window; only making them inseparable does. All three run inside one `withRequestTenant` transaction, so either everything commits or nothing does and **there is no crash window at all**.

This is also why idempotency is **not an interceptor**. An interceptor runs outside the handler's transaction and would need one of its own — reopening exactly the gap. It is a service the handler's work is passed to as a closure, which keeps `AuthorizationService.assert` inside the request's own tenant transaction exactly as ADR-005 D-5 requires.

The cost is stated plainly: a duplicate **blocks** on the in-flight original rather than being told to come back. `API.md` §4 previously specified an immediate `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` for that case, which is only reachable if the claim commits separately — and that is the design this rejects. Blocking is also the better answer: the caller gets the real result instead of polling. The wait is bounded by `lock_timeout`, and exceeding it yields the documented retryable `409`.

### D-2 — Concurrency is the unique index, not an application lock

`INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now()`. The unique index *is* the mutex and it is transactional: a second writer blocks on the row lock until the first commits or rolls back, then either finds a completed record to replay or takes the claim itself.

| Mechanism | Why not / why |
|---|---|
| In-memory mutex | **Rejected.** Does not survive a second process, a second container, or a restart |
| Redis lock | **Rejected as the boundary.** Redis is an accelerator and never a system of record (`DATABASE.md` §1); a correctness guarantee that evaporates when a cache does is not one |
| Advisory lock | **Rejected.** A second lock to acquire and release for a guarantee the unique index already provides, transactionally |
| **`ON CONFLICT` on the existing unique index** | **Chosen.** Already present, already transactional, releases with the transaction, and needs no new state |

The `WHERE expires_at <= now()` clause makes expiry a *reclaim* rather than a collision: without it the unique index would refuse an expired key forever, and an expired key is by definition a fresh request.

### D-3 — Only successful responses are stored

Validation, authorization, business `4xx`, `5xx` and crashes all roll the transaction back, taking the claim with them. Nothing is cached and a retry is always permitted.

The alternative — recording failures — means a database blip permanently poisons a key, which is a worse failure than the duplicate it would prevent. And storing a failure buys nothing here: the deterministic ones (a duplicate key, a refused escalation) reproduce themselves on retry from the underlying constraint or check.

**The security consequence is the important one.** A refused request stores nothing, so there is nothing to replay; and a stored record is reached only after the *current* request has authenticated and been authorized, in the same transaction, by the same check the fresh path performs. A previously successful request is therefore never a credential. The replay path calls the endpoint's own `assertMay…` method rather than a second copy of the check, so the two cannot drift.

### D-4 — The principal is part of the request fingerprint

The key scope stays organization-wide (`DATABASE.md` §7.1's reasoning about workspace collisions stands), which alone would let one principal inside an organization present another's key and receive its stored response. The resolved principal's *identity* — never its credential — is therefore part of the SHA-256 fingerprint, so a different actor computes a different fingerprint and is refused as a payload mismatch.

Actor columns were added (migration `0007`) for **diagnostics only**, not as a uniqueness term: making them part of the unique index would silently let two principals run one key as two separate mutations, which is a worse answer than a deterministic refusal.

### Consequences

- `API.md` §4 is rewritten: §4a classifies every mutating endpoint, §4b defines the effective request and canonicalization, §4c the outcomes.
- The immediate-`409`-while-in-flight behaviour is replaced by bounded blocking, with `409` retained for the timeout.
- Migration `0007` adds `actor_user_id`, `actor_api_key_id` and `correlation_id`.
- Physical cleanup of expired records is **not** implemented; expiry is enforced at lookup, so correctness does not depend on a sweeper (§3).

## 1g. ADR-007 — User lifecycle is disable, not deletion, and creation confers identity without credentials

**Status**: Accepted (Phase 1B.6.1). Implements `API.md` §3d and `RBAC.md` §8c. Extends ADR-005 D-1/D-5/D-7; supersedes nothing. Does **not** resolve D16.

### Context

`users`, its three-state `status` enum and the `users_active_requires_credential` CHECK have existed since migration `0000`; `UserLifecycleService` has implemented `invite`/`activate`/`disable` as service primitives since Phase 1B.2. What was missing was an API, and four questions the schema left open: whether deletion exists, what reactivation restores, whether the login identity is editable, and whether a created user is usable.

### D-1 — There is no hard delete, and its absence is structural rather than a policy

`acc_app` holds no `DELETE` grant on `users` (migration `0000`), so the application role cannot perform one however the service is written — the security suite asserts the refusal is `42501 insufficient_privilege` rather than a policy returning zero rows. That grant was withheld deliberately and the reasoning still holds: users are referenced by `sessions`, `api_keys.created_by`, `user_roles`, `idempotency_keys.actor_user_id` and `audit_logs.actor_user_id`, and an audit trail must outlive the identity it describes. Deleting a user would either cascade those away or be refused, and the first is a silent, unbounded, unaudited change.

| Option | Verdict |
|---|---|
| Hard `DELETE /users/:id` | **Rejected.** Needs a grant the role does not have, and destroys audit attribution. `user_roles` cascades, so it would also be a mass privilege revocation with no record of any individual revocation — the same defect ADR-005 D-8 closed for roles |
| Soft delete (`deleted_at`) | **Rejected.** A second state the evaluator, the membership predicate and every future query must filter on, where one forgotten predicate silently resurrects an account. Identical to the reasoning in ADR-005 D-8 and `DECISIONS.md` D17 |
| A `DELETE` route that disables | **Rejected.** It would answer `204` while leaving the row, which is a lie in the route table and in the client that reads it |
| **Disable, with no `DELETE` route at all** | **Chosen.** The state already exists, already means something (the CHECK), and is already what the liveness trigger understands |

A caller looking for deletion finds no route, rather than one whose semantics they have to read the documentation to distrust.

### D-2 — Reactivation restores the state the CHECK admits, not always `active`

`users_active_requires_credential` refuses `active` for a user holding neither a password nor an MFA secret. A user disabled before they ever activated therefore cannot be returned to `active`, and the three available answers are not equal:

| Option | Verdict |
|---|---|
| Refuse with `409` | **Rejected.** D16 is unresolved, so there is no way to give them a credential — the user would be permanently unrecoverable, by a rule that exists to protect them |
| Force `active` anyway | **Rejected.** The database refuses it, so this is a `500` dressed as a feature |
| **Restore `invited` when no credential survives** | **Chosen.** It is exactly the state they were in before, the response says which state it reached, and the audit row records it |

### D-3 — The login identity is not editable, and that is deferred rather than omitted

`PATCH /users/:id` reaches `phone` and nothing else. Changing `email` would have to settle case-normalized global uniqueness, whether live sessions survive the change, what an API key created by the old identity means, whether the old address may be reclaimed, and how account recovery behaves across it. The honest mechanism is a verified change flow with a token, which does not exist and is the same missing machinery as D16. A `PATCH` that silently rewrote the identity would be that absence shipped as a feature.

The cost is admitted: the update endpoint reaches one column. Adding a display-name column to make it look fuller was rejected — that is a schema change driven by the shape of an API rather than by a requirement (`DATABASE.md` §1).

### D-4 — Creation and the initial grant are atomic, and the grant still goes through `RoleAssignmentService`

A user's organization *is* the set of grants it holds (`TENANCY.md` §1), so a user created with none is invisible to the administrator who created it, to `GET /users` and to the `users_select` policy — the only remaining trace would be a `409` the next time someone tried the address. `initialRole` is therefore required, and the grant is made in the same transaction.

It is made by calling `RoleAssignmentService.grant`, not by writing `user_roles`. A second writer of that table would be a second, unguarded way to confer privilege, which is precisely what `RBAC.md` §8b's five guards exist to prevent. One guard does not fit, and only one: guard 5 establishes reachability by requiring the target to already hold a grant this request can see, which a user created moments ago cannot — its first grant is the one under construction.

| Option | Verdict |
|---|---|
| Write `user_roles` from the user service | **Rejected.** A second grant path with none of the five guards |
| Weaken guard 5 for every caller (admit any user with no grants) | **Rejected.** That admits *any* unreferenced user in the database, from any tenant — it converts the probe into an enumeration surface |
| Create first, grant in a second request | **Rejected.** Leaves an invisible, unreachable user behind whenever the second request does not arrive |
| **Skip guard 5's probe only for a user this transaction created** | **Chosen.** Reachability is established by construction — the caller authorized `users.invite` at its own organization and inserted the row here. Guards 1-4 run unchanged, including guard 1, which is the escalation-bearing half |

The relaxation is an in-process option with no field on any DTO, so no request can ask for it, and a structural test asserts it has exactly one caller.

**A consequence worth stating: `INSERT … RETURNING` is not usable here.** PostgreSQL applies the `SELECT` policy to a `RETURNING` clause, and a user with no grant satisfies none of `users_select`'s three arms. The id is generated application-side, the insert returns nothing, and the row is read back after its grant exists — which doubles as the proof that it is reachable.

### D-5 — No credential is accepted, generated or returned, and D16 stays open

`POST /users` creates an `invited` identity: no password field, no password hash, no temporary credential, no invitation token, no email. That is what allows the lifecycle API to ship while D16 is undecided, and inventing any of those would be the unsafe workaround D16 exists to prevent. A created user is exactly as usable as one the bootstrap CLI has not activated.

### Consequences

- `API.md` gains §3d; `RBAC.md` gains §8c and §5a.1 is extended.
- Migration `0008`: one index, the `users.reactivate` catalogue row, and its attachment to `alendei_super_admin` and the seeded `org_admin` roles. No column, no lifecycle timestamp, no policy change.
- `users.reactivate` is a new permission, separate from `users.disable` (`RBAC.md` §8c).
- `user.reactivated` is a new audit action; `user.invited` and `user.reactivated` join `SECURITY_SENSITIVE_AUDIT_ACTIONS`, which forces both to be written inside the transaction that performs them.
- **One authentication change, and it is a fix rather than a feature**: the API-key creator-authority intersection now resolves to nothing when the creator is not `active`. Without it, disabling an administrator left every key they minted working — the exact outcome disabling is for (`SECURITY.md` §4).
- `trg_users_platform_admin_liveness` (migration `0005`) gets its first HTTP caller. The service adds the clean `409` and the ADR-005 D-7 lock ordering; the trigger remains the authority, and a lost race's `restrict_violation` is translated to the same `409`.
- **Accepted residual risk**: a global unique index on `email` makes `409` on creation a platform-wide existence signal for an address. Recorded in `SECURITY.md` §8 rather than mitigated; the alternatives are per-tenant identities or answering `201` for something not created.

## 1h. ADR-008 — A response field may be non-persistable; the API-key secret is the first

**Status**: Accepted (Phase 1B.6.2). **Amends ADR-006 (§1f)** on one point and leaves the rest of it authoritative. Implements `API.md` §3e.

### Context

`POST /api/v1/api-keys` must return the plaintext API-key secret exactly once, and must be protected by the existing `Idempotency-Key` mechanism — a credential-creating mutation is precisely the kind a client retries after a network timeout. Those two requirements collide.

`IdempotencyService.finalize` stores the handler's response body verbatim:

```ts
responseSnapshot: body as never,   // → idempotency_keys.response_snapshot
```

`response_snapshot` is plain `jsonb`. There is **no redaction anywhere on the idempotency path** — `redact()` belongs to `AuditWriter` and nothing else calls it. So the naive implementation writes every API-key secret into a plaintext column.

Two facts make that worse than a 24-hour exposure:

1. **Retention is indefinite.** §3 accepts that expired idempotency records are never physically deleted, on the stated grounds that *"what is deferred is only reclaiming space"*. That reasoning holds only while snapshots carry nothing sensitive. A secret-bearing snapshot silently converts a disk-space deferral into an indefinite plaintext credential store, invalidating the basis on which the risk was accepted.
2. **The row is broadly readable in principle.** `idempotency_keys_tenant` is `USING (app_org_in_scope(org_id))` and `acc_app` holds `SELECT`. No endpoint reads the table today, so the confinement rests on "nothing queries it" — a weaker guarantee than "the secret is not there". Backups, replicas and the eventual retention sweeper all encounter whatever is stored.

This was raised as a stop condition before implementation rather than resolved silently.

### D-1 — The secret is never persisted; the snapshot stores a placeholder

The governing invariant, which takes precedence over ADR-006's generic wording:

> **An API-key plaintext secret must never be persisted in `idempotency_keys.response_snapshot`.**

| Option | Verdict |
|---|---|
| Store the secret, shorten the TTL, purge after first replay | **Rejected.** Still plaintext at rest, still contradicts the credential-storage invariant, and adds a sweeper this phase is told not to build |
| Encrypt the snapshot | **Rejected.** Reversible encryption of a credential, and `SecretsPort` is an environment-reference resolver, not an encryption service. New architecture for one field |
| Drop `Idempotency-Key` on this endpoint | **Rejected.** Leaves the one credential-creating mutation unprotected against duplicate creation on retry — the exact case the mechanism exists for |
| **Keep the secret out of the stored envelope** | **Chosen.** Nothing sensitive is written, and the mechanism is untouched |

### D-2 — Response snapshots are replay-safe representations, not byte-copies

ADR-006 stated that "what is stored is byte-identical to what was sent". That is amended:

> Response snapshots are **replay-safe representations**, not necessarily byte-identical copies of every response field. A response field may be explicitly classified as **non-persistable**. Such a field is stored as a safe placeholder — `null` — and is therefore absent from any replay.

**ADR-006 remains authoritative** for everything that makes idempotency work: at-most-once execution, request fingerprinting, the single transaction, mutation serialization by the unique index, replay without re-execution, and current authentication *and* authorization on replay. None of it changes, and `IdempotencyService` is not modified — the field is kept out **at the call site**, so role and role-assignment creation behave exactly as before.

**`secret` on `POST /api-keys` is the first and currently only non-persistable field.** This is deliberately not a general response-transformation facility: there is no declarative list, no framework hook, and no way for a new field to acquire the behaviour by accident. Any future non-persistable field must be documented here and security-reviewed on its own terms.

### D-3 — "Exactly once" includes not re-presenting on replay

A replay returns the stored envelope, so `secret` is `null`. That is the correct reading of "presented exactly once" rather than a degradation of it: the fresh creation response is the single presentation, and a replay is a different request.

The consequence is stated plainly rather than hidden: **if the creation response is lost, the secret is unrecoverable.** There is no retrieval endpoint and no recovery path. The documented remedy is to revoke the key and create another — which is cheap, audited, and strictly safer than any mechanism that could hand a credential back.

### Consequences

- `API.md` §3e documents the endpoint, the one-time presentation and the replay shape; `FRONTEND_API_CONTRACT.md` §30e warns a console never to expect a secret from a replay.
- The fresh response and the persisted snapshot differ in **exactly one field**, asserted by test.
- `ApiKeyAdministrationService.create` returns `{ view, secret }` as two fields rather than folding the secret into the resource, so a caller must decide deliberately where the plaintext goes. `ApiKeyView` alone is always safe to persist, log or replay.
- A static test asserts the dataflow structurally: `minted.secret` occurs exactly twice in the service — the Argon2id hash and the return — and `IdempotencyService` is asserted to contain no knowledge of secrets at all.
- `DECISIONS.md` §3's accepted risk on idempotency retention keeps its original basis, because snapshots still carry nothing sensitive.

## 1i. ADR-009 — Deployment topology: one codebase, many topologies; deployment identity is operational

**Status**: Accepted (Phase 1B.6.3, documentation closure). Follows the deployment topology review performed against `782b8d7`. Implements no code. Constrains `DEPLOYMENT.md` §0, `TENANCY.md` §§4/7a, `SECURITY.md` §3, `ARCHITECTURE.md` §16.

### Context

ACC needs to serve three commercial models — shared multi-tenant SaaS, dedicated per-customer deployments, and private/on-prem — without maintaining three applications. A review of the repository found that the capability was already there but undocumented, and that three documents described it inaccurately. Four decisions are frozen here so later phases cannot quietly diverge from them.

### D-1 — White-label is not a deployment boundary

A white-label reseller is a **tenant**, and shared deployment is the default model for it. The schema already carries what white-label needs: `resellers.brand_config`, `resellers.domain` (uniquely indexed), `workspaces.brand_config`, `resellers.default_markup_pct`.

Forcing every white-label customer into its own deployment was rejected: it multiplies operational cost per customer, makes the common case the expensive one, and buys isolation the RLS boundary already provides. Dedicated deployment remains available as a commercial or regulatory choice, and promotion is tractable because a reseller's data is a closed subtree — an export, not a schema change.

### D-2 — Deployment identity is operational, not a database tenant concept

**No `deployment_id` on any tenant or business table, and none in any RLS policy.**

| Option | Verdict |
|---|---|
| `deployment_id` column + RLS predicate | **Rejected.** A deployment holds whole tenants, so the hierarchy already provides the reachability. It would add a second isolation axis every policy, index and query must carry, where a forgotten predicate becomes a new leak class. And cross-deployment queries cannot exist — separate deployments have separate databases — so the column could never be what prevents one. A column that can only ever hold one distinct value per database is not a control; it is a comment |
| Deployment identity in configuration and telemetry | **Chosen.** The place it is genuinely needed |

The real gap the review found is operational: traces carry `service.name` and `deployment.environment.name` (`APP_ENV`, i.e. `production`), and logs carry `service`/`environment` — so two production deployments shipping telemetry to one place are **indistinguishable**. That is a configuration value surfaced as an OTel resource attribute and a log base field, deferred to the deployment-hardening phase (`OBSERVABILITY.md`).

### D-3 — Hostname may select branding; it never selects tenancy or authorization

Frozen normatively in `TENANCY.md` §7a. A hostname is a client-supplied identifier: forgeable by anything that is not a browser, chosen by whoever controls DNS, and mediated by whatever `Host` a proxy forwards. `TENANCY.md` §2b already refuses to trust such identifiers for tenancy; a custom domain is not an exception to that rule, it is an instance of it.

The branding resolver will therefore run before authentication and return presentation data only; the tenancy chain runs after and ignores the host entirely.

### D-4 — Tenant-scoped secrets are references, never values

Frozen in `SECURITY.md` §3. Deployment-level infrastructure secrets (database, Redis, broker, JWT, cookie, object storage, encryption keys) stay deployment-level and resolve through `SecretsPort`. Tenant-scoped secrets — provider credentials, webhook signing secrets, tenant encryption material — are stored as a **reference** into that backend on a tenant-scoped row.

The precedent is already in the schema: `users.mfa_secret_ref` is documented as a pointer and never the seed. `provider_credentials` is **not implemented**; its contract is frozen in `DEPLOYMENT.md` §0f so the channel phases cannot store a credential inline for convenience.

### Consequences

- `DEPLOYMENT.md` gains §0 (topology, normative) and a CURRENT/PLANNED marker on every artifact claim. It previously described Helm charts, images and infrastructure services that do not exist.
- `TENANCY.md` §4 corrected — branding and domain live on `resellers`, not on `workspaces`/`organizations`; `organizations` has neither. §7a added for the hostname rule.
- `ARCHITECTURE.md` §16 corrected — `api_keys` binds to organization or workspace only, and `provider_credentials` does not exist.
- `DR.md` distinguishes shared from dedicated backup/restore boundaries; RPO/RTO becomes a deployment-class decision.
- `ROADMAP.md` gains the deployment-artifacts track, sequenced after the approved core phases.
- **No schema change, no migration, no code.** This ADR is a set of constraints on future work.

### Deliberately not decided here

The supported version-skew window for dedicated deployments, contractual RPO/RTO values, data-residency commitments, whether API keys should ever be reseller-scoped, and whether `EVENT_TOPIC_PREFIX` is wired or removed (`DEPLOYMENT.md` §0h, `EVENTS.md`). Each needs product input rather than an architectural guess.

## 1j. ADR-010 — General rate limiting: two classes, one ceiling, deployment-wide

**Status**: Accepted (Phase 1B.6.4). Implements `API.md` §5, which has specified this limiter since Phase 0 without it being built. Does not modify `AuthRateLimitService`.

### Context

Three things had to be settled before the limiter `API.md` §5 specifies could be built, and none of them was answered in the repository.

### D-1 — Ownership: 1B.6.4, not 1B.10

`API.md` §5 specified the limiter; `FRONTEND_API_CONTRACT.md` §23 assigned it to Phase 1B.10. Both could not be right, and the tiebreaker is that **1B.6's own exit criterion demanded it**: *"live, audited, rate-limited and IDOR-safe"*. That wording was narrowed by accident in `f3ef8fa` when the phase was restructured into increments (recorded in `ROADMAP.md`). Restoring the criterion makes 1B.6 incomplete without the limiter, so it belongs to 1B.6 — as 1B.6.4 — and the FAC row is corrected.

### D-2 — Two endpoint classes, sharing one ceiling

`API.md` §5 names `endpoint_class` as the third key term and **defines no taxonomy**. The configuration carries exactly one general limit pair, so no per-class *budget* is derivable from anything in the repository.

| Option | Verdict |
|---|---|
| One class | **Rejected.** Makes `endpoint_class` degenerate and cannot deliver the isolation that is the point: a write flood would exhaust the read budget |
| **`read` / `write`, split by HTTP method** | **Chosen.** Derived from the API's own shape rather than a product opinion, and the smallest split that isolates |
| `read` / `write` / `admin` | **Rejected as invention.** Nothing defines which routes are "admin" or what ceiling they would get. Adding config for it was out of scope |

Both classes draw on `RATE_LIMIT_DEFAULT_*`. **The split is isolation, not differentiation** — the same ceiling applied to two independent buckets. A route may override its class with `@RateLimit()`, a two-value literal union; no route needs it today, and the escape hatch exists so the first route whose cost does not match its verb can say so without changing the taxonomy.

### D-3 — A fixed-window counter, and the documentation corrected to match

`API.md` §5 called the mechanism a "token bucket". `AuthRateLimitService` has always implemented `INCR` + `EXPIRE NX` + `TTL`, which is a **fixed-window counter**. Rather than build a second algorithm to match prose, the prose is corrected and the existing mechanism reused.

The known cost is stated rather than hidden: a caller can spend its budget at the end of one window and again at the start of the next, so the short-term peak can reach twice the limit. Acceptable for a throttle bounding sustained load, and identical to the property the authentication buckets already have. A true token bucket would need Lua or a non-atomic read-modify-write for a smoothness this control does not require.

### D-4 — Limits are deployment-wide; tenant-configurable limits are future work

`API.md` §5 says limits are "tenant-configurable (plan-based defaults, override per organization)". **They are not, and this phase does not make them so.** Every tenant on a deployment shares one ceiling from `RATE_LIMIT_DEFAULT_*`.

Doing otherwise would have required a plan table, a per-organization override column or an entitlement model — all explicitly out of scope, and all decisions that belong with billing rather than with a throttle. The consequence is recorded plainly: a noisy tenant is bounded but not individually tunable, and no tenant can be granted a larger allowance without changing it for everyone. Per-class and per-tenant limits are future work.

### Consequences

- A global `RateLimitGuard` registered **after** `AuthGuard`, so the principal it keys on is already resolved. Import order in `AppModule` is load-bearing; the suite asserts the limiter actually engages, which is what would catch a regression there.
- Bucket identity is entirely server-derived: `RateLimitSubject` exposes no field a caller could populate, and the guard reads only the request's method.
- Requests with no principal pass through, which is what keeps `/auth/login`, `/auth/refresh`, `/health*` and `/metrics` out of the limiter without an exemption list.
- An API key is bucketed by its own key id, not its creator's.
- **Mutation G from the phase brief is structurally non-applicable**: the general limiter does not key on IP, so there is no forwarded-for-derived value to corrupt. A test asserts the absence directly instead.
- `API.md` §5 rewritten, `FRONTEND_API_CONTRACT.md` §23 reassigned and rewritten, `SECURITY.md`, `TESTING.md` and `ROADMAP.md` updated.

## 1k. ADR-011 — Gate-B security remediation: validated scope claims, one platform-administrator definition, organization as the database boundary

**Status:** accepted. Remediation of the seven blockers raised by the Gate-B read-only security audit (HEAD `df1ec74`). **Gate B is not declared passed by this ADR**; it produces evidence for the next security review.

### Context

The audit found that `ScopeResolver.tenantContextFor` filled `TenantContext.resellerId` — and therefore `app.current_reseller_id` — from the *selected organization's* reseller for every principal, while `app_org_in_scope()` admits every organization beneath that reseller. Organizations sharing a reseller (every direct customer shares "Alendei Direct") were mutually visible to RLS, and four list endpoints relied on RLS alone. Every test fixture gave each tenant its own reseller, so no test could see it. The same audit found that any grant at `platform` scope — including the read-only `alendei_support` — set `app.is_platform_admin`, which every policy treats as unrestricted read **and** write.

### D-1 — A session variable is a claim, and the database validates elevated claims

`app.current_reseller_id` means "acting **as** this reseller" and is set by the application only from a genuine `reseller`-scope grant on the selected organization's reseller. Independently, migration `0010` makes `app_current_reseller_id()` and `app_is_platform_admin()` honour the claim for an RLS-bound principal only while `app.current_user_id` holds the conferring grant (active user, re-read from current state). An unbacked claim resolves to NULL/false rather than raising: the organization arm still applies and nothing widens. Principals that already bypass RLS (superuser, `BYPASSRLS`, schema owner) remain trusted, so seeding and first-administrator bootstrap still work.

*Rejected:* fixing only the application (a regression would silently reopen the database boundary); adding only API predicates (the user explicitly required the RLS boundary to hold on its own, and the predicates would not protect other readers). *Not claimed:* defence against a compromised `acc_app` — `app.current_user_id` is itself a session variable (`SECURITY.md` §4b).

### D-2 — "Platform administrator" is `alendei_super_admin` at platform scope, everywhere

`TenantContext.isPlatformAdmin`, `app_is_platform_admin()`, the liveness invariant (`fn_assert_platform_admin_remains`) and both service-level liveness checks now share this definition. `alendei_support` keeps the ability to *select* any organization (its cross-tenant read, one organization at a time) but inside that organization RLS scopes it like a member, and it cannot grant platform roles at the trigger. Behavioural consequence, accepted: platform-scoped audit rows are no longer visible to support. Liveness also guards removal by `UPDATE` of a platform grant (scope, user or role changed), not only `DELETE`.

### D-3 — Lists pin to the selected organization as well

`GET /tenants/workspaces`, `GET /api-keys`, `GET /role-assignments` and `GET /tenants/workspaces/:id` gain an explicit predicate for the organization the request was authorized against, on top of RLS. The audit list keeps its RLS-driven reseller view (ADR-005, `SECURITY.md` §4), now correct because RLS only admits genuine reseller administrators.

### D-4 — Organization is the PostgreSQL isolation boundary; workspace and team are authorization-layer boundaries (Blocker 7)

Examined, not assumed. Extending RLS below the organization was rejected for Phase 1B on these grounds:

1. **A principal's workspace reach is a set, not a value.** A workspace manager may hold grants in several workspaces; an organization-level grant covers all of them. A single `app.current_workspace_id` cannot express that; an array claim would have to be validated per row against grants (the same per-row cost D-1 accepts only for the rare reseller/platform case), on every tenant table, for every principal.
2. **Several tenant tables have no workspace column, or a nullable one.** `roles`, `role_permissions`, `idempotency_keys` and organization-bound `api_keys` exist at organization level by design; `user_roles` and `audit_logs` carry a polymorphic scope. A workspace term would be a different predicate per table rather than one audited predicate (`app_org_in_scope`).
3. **It would not remove the application check.** Visibility at workspace level still would not decide *permission* (a read-only member of a workspace must not mutate it), so `AuthorizationService.assert` remains mandatory either way.

**What proves the workspace/team boundary instead:** every scoped route performs exactly one target-scope check, asserted against the live route table (§6n case 30); the chain every decision rests on is read from the database inside the request's transaction (ADR-005 D-5); and workspace/team denial is proven *with RLS satisfied* — `authorization-service.sec-spec.ts`, `api-key-binding-scope.sec-spec.ts`, `audit-read.sec-spec.ts`, `role-assignment.sec-spec.ts`, and the workspace- and team-scoped principals in `shared-reseller-isolation.sec-spec.ts`. This remains the highest residual risk and is revisited if `DECISIONS.md` D3 (mandatory `workspace_id`) is resolved in favour of mandatory.

**Verified, not only stated** (`workspace-team-boundary.sec-spec.ts`, 15 cases): over HTTP a workspace manager cannot grant at or revoke from a sibling workspace or its teams, a team lead (a custom team-scoped role holding grant/revoke) cannot act on a sibling team, workspace- and team-scoped readers cannot read sibling audit records, and none of them can grant at or read organization-level surfaces; directly as `acc_app`, under the context the resolver computes for those principals, RLS **does** admit sibling workspaces and teams of the same organization and admits nothing of another organization.

| Boundary | API authorization | DB / RLS | Intended boundary |
|---|---|---|---|
| Organization | Enforced (`AuthorizationService`, selection from grants) | **Enforced** (`app_org_in_scope`, validated claims) | PostgreSQL isolation boundary |
| Workspace | Enforced (DB-resolved chain, coherent grant) | Not enforced — rows of sibling workspaces in the same organization are visible | Application authorization boundary |
| Team | Enforced (DB-resolved chain, coherent grant) | Not enforced — rows of sibling teams in the same organization are visible | Application authorization boundary |

**Organization is the PostgreSQL isolation boundary; workspace and team are application authorization boundaries.** What the database guarantees for a workspace- or team-scoped principal: it can never read or write another organization's rows, even if the application's check is missing. What it does not guarantee: a missing or wrong application check inside one organization would expose sibling workspaces' and teams' rows, and nothing in the database would stop it.

### D-5 — Unauthenticated paths are throttled, and success no longer resets the address

Login success clears only the account bucket; `/auth/refresh` is throttled per address (`RATE_LIMIT_REFRESH_MAX`, default 30); failed API-key presentations are throttled per address **before** Argon2 verification (`RATE_LIMIT_API_KEY_FAILURE_MAX`, default 20). The existing `AuthRateLimitService` is extended; no new mechanism.

### D-6 — The HTTP edge is exercised through the production bootstrap; proxy trust is off by default

`createApp()` (`apps/api/src/app.factory.ts`) holds all HTTP-edge configuration and is what `main.ts` calls, so `real-bootstrap.sec-spec.ts` tests Helmet, CORS, CSRF assumptions and proxy trust as production serves them. `TRUSTED_PROXY_HOPS` defaults to `0` (was `1`) and must be set explicitly in production. Login refuses non-JSON bodies (`415`) to close login-CSRF without asking the console for a new header.

### D-7 — Start-up refuses a principal RLS would not bind; FORCE RLS is not used

`DatabaseModule` asserts at start-up that both request-serving pools log in as a principal that is not superuser, not `BYPASSRLS`, owns no table (nor is a member of an owner) and is a member of no role. `FORCE ROW LEVEL SECURITY` is deliberately not enabled: it only affects a non-superuser *owner*, and the owner must remain exempt for retention, teardown and seeding; the risk FORCE would mitigate (an application principal owning a table) is instead made undeployable by this check and asserted in `principals.int-spec.ts`.

### D-8 — Gate-B residual classification (final verification)

| Item | Classification | Why |
|---|---|---|
| Suspended/closed organization access | Deferred (Phase 1C) → **IN PHASE 1C (1C.1a, ADR-012 F-4)** | No organization lifecycle exists yet — nothing can suspend or close an organization through the product, so the state is unreachable. |
| `AUTH_MAX_SESSIONS_PER_USER` not enforced | Deferred (Phase 1C) → **IN PHASE 1C (1C.2)** | A resource-hygiene limit, not an isolation or authorization control; every session is still individually revocable and bounded by its TTL. |
| Logout after access-token expiry | Accepted Gate-B residual risk → **implemented in 1C.2 (ADR-012 F-12)**: `POST /auth/logout` accepts the refresh cookie with `X-Acc-Refresh` when no valid bearer is presented | Backend side done. Before 1C.2 the session stayed revocable (`DELETE /auth/sessions/:id`, user disable) and expired with its refresh TTL. Whether the console already reaches the cookie path when its access token has expired is a frontend matter, not changed here. |
| WebSocket tickets surviving session revocation | Deferred (with the gateway, D15) | Nothing consumes a ticket, so a surviving ticket confers nothing until the gateway exists, which must check the session at consumption. |
| WebSocket ticket issuance without a permission check | Deferred (with the gateway, D15) | The topic scope only matters when a gateway admits subscriptions; the ticket is still bound to the caller's own organization and session. |
| No composite `(workspace_id, org_id)` FK on `api_keys`/`ws_tickets` | Accepted Gate-B residual risk → **implemented in 1C.6 (migration `0014`); CLOSED (Gate C.6 PASS)** | Both writers derive the binding from the database, and RLS keeps a row inside its organization; a mismatched row needs an owner-level writer. |
| READ COMMITTED dependency for the last-admin race | Accepted Gate-B residual risk | No code path changes the isolation level, and the concurrency tests prove the invariant under the level actually used. |
| `allowed_scope_types` application-only | Accepted Gate-B residual risk → **implemented in 1C.6 (migration `0014`); CLOSED (Gate C.6 PASS)**; the database enforces it for every role and refuses narrowing that would strand a grant | Enforced on the only grant path (`RoleAssignmentService`, case 28); a bypassing writer is still confined to one organization by the trigger. |
| `acc_app` context trust | Accepted Gate-B residual risk | A threat-model assumption (`SECURITY.md` §4b): the process holding `acc_app` also holds `acc_auth` and the JWT key, so its compromise is platform compromise. |
| Outbox/SIEM absence | Deferred (not Phase 2 — ADR-013 PD-1) | No event producer exists in Phase 1B; audit tamper-evidence currently rests on infrastructure controls, which is documented. |
| OpenAPI contract drift | Deferred (Phase 1C) → **implemented in 1C.3** (Gate C.3 PASS / CLOSED) | The document is generated from the code, validated against real responses and snapshot-checked in CI; outside development only a signed-in user session can read it. |
| Browser E2E fixture gaps | Deferred (Phase 1C) → **IMPLEMENTED and CLOSED (PASS; 1C.4a backend, 1C.4b Gemini)** | Backend security properties are proven by API and database suites; the browser suite is backed by 1C.4a fixture and 1C.4b E2E corrections (`TESTING.md` §6p, §6r, §6s). |

None of the twelve is a Gate-B blocker.

### Consequences

- Migration `0010` (functions and one trigger; no table, no column, no policy text changed).
- Tests that previously ran `acc_app` with a bare `{ isPlatformAdmin: true }` or `{ resellerId }` now use real identities; three audit-read expectations changed from `403` to `404` (a sibling/reseller row is now invisible rather than visible-but-refused — the oracle closed).
- Frontend contract: `tenant.resellerId` on `/auth/me` is non-null only for a genuine reseller administrator; `tenant.isPlatformAdmin` is false for support; login requires `Content-Type: application/json` (the console already sends it).
- Not changed, recorded: DB-level enforcement of `roles.allowed_scope_types` at grant time remains **service-only** (the trigger does not check it); `api_keys`/`ws_tickets` have no composite `(workspace_id, org_id)` foreign key; `app.current_org_id` and `app.provisioning` claims are not validated in the database.

## 1l. ADR-012 — Phase 1C scope and architecture freeze

**Status:** accepted (scope freeze). **No Phase 1C implementation exists at the time of this ADR** — everything below marked *IN PHASE 1C* is a commitment, not a description of code. Base: Gate B freeze `2b007224b66bf3917bde54c509d7ac1835082aad`.

### Context

Phase 1B left three increments named but unscheduled — **1B.8** (organization, workspace and team administration, including wiring `TenantRoleProvisioner` into organization creation), **1B.9** (OpenAPI business schemas) and **1B.10** (development bootstrap) — plus Gate-B items classified "Deferred (Phase 1C)" in ADR-011 D-8. Phase 1C adopts them as its scope, builds on the Phase 1B architecture unchanged, and reopens none of it: the validated-claim model (migration `0010`), coherent-grant authorization, organization-level RLS (ADR-011 D-4) and the route-coverage, denial-audit, idempotency and rate-limit conventions all carry over as-is.

### Scope

| Increment | Content | Replaces |
|---|---|---|
| **1C.0** | This ADR and the documentation freeze | — |
| **1C.1a** | Organization create/read/update; suspend, close, reactivate; `TenantRoleProvisioner` integration; default workspace creation; authorization and audit | 1B.8 (part) |
| **1C.1b** | Workspace create/read/update/archive/restore; team create/read/update/archive/restore; no hard team deletion | 1B.8 (part) |
| **1C.2** | Session lifecycle: maximum sessions with oldest-session eviction; revoke-all; scoped administrator revocation; logout with an expired access token; CSRF preserved | — (ADR-011 D-8 items) |
| **1C.6** | Database integrity: composite `(workspace_id, org_id)` foreign keys on `api_keys`/`ws_tickets`; DB enforcement of `roles.allowed_scope_types`; `organizations.reseller_id` immutability; backfill verification; service-bypass tests | — (ADR-011 D-8 items) |
| **1C.3** | OpenAPI/API contract reconciliation: complete schemas, security schemes, headers, envelopes, idempotency and rate-limit documentation; generated spec; CI drift detection; authenticated UI outside development | 1B.9 |
| **1C.4a** | Deterministic development/test fixture and bootstrap command | 1B.10 — **authorized separately**, after the backend contract is stable |
| **1C.4b** | Gemini E2E corrections (`TESTING.md` §6p) | — ✅ **IMPLEMENTED and CLOSED (PASS)** (Gate C.4b, checkpoint `4e7effd`) |

**Execution order:** 1C.0 → 1C.1a → 1C.1b → 1C.6 → 1C.3, with 1C.2 in parallel after 1C.0. Backend implementation then stops and the finalized frontend contract is handed to Gemini; 1C.4a, 1C.4b and the Phase 1C console are authorized separately.

### Recorded decisions (OD-1 … OD-12)

| # | Decision | Status |
|---|---|---|
| OD-1 | 1B.8–1B.10 are grouped under Phase 1C | **APPROVED** |
| OD-2 | Reseller suspension and any cascade to its organizations | **DEFERRED** — reseller lifecycle/administration is a later phase (Phase 9) |
| OD-3 | Organization status is enforced by application authorization, **not** by an additional RLS predicate; platform principals can still inspect suspended and closed organizations | **APPROVED** |
| OD-4 | Resource-oriented endpoints: `/organizations`, `/organizations/:id`, `/workspaces`, `/workspaces/:id`, `/teams`, `/teams/:id`; no new `/tenants/workspaces` surface | **APPROVED** |
| OD-5 | No hard deletion of teams; an archived lifecycle consistent with the existing workspace model | **APPROVED** |
| OD-6 | At `AUTH_MAX_SESSIONS_PER_USER`, evict the oldest eligible session rather than reject the login; race-safe; concurrency-tested | **APPROVED** |
| OD-7 | An administrator may revoke another user's sessions only within the administrator's own authorization scope and only with `sessions.revoke`; no cross-scope revocation | **APPROVED** |
| OD-8 | OpenAPI UI available in development; authentication required outside development | **APPROVED** |
| OD-9 | Credential delivery / invitations | **DEFERRED** — users created administratively keep relying on the existing credential/bootstrap mechanism (`DECISIONS.md` D16 remains open) |
| OD-10 | Deployment artifacts (1B.D1–D4) | **SEPARATE TRACK** — not in Phase 1C |
| OD-11 | WebSocket gateway, consumption and subscription authorization | **DEFERRED** — ticket issuance stays as implemented (D15) |
| OD-12 | Closing an organization is terminal in Phase 1C; closing deletes no data, which is retained and inaccessible to organization principals; no physical deletion or retention automation | **APPROVED** |

### Freeze details (decisions made in this ADR to make the approved decisions implementable — reviewable)

Each is the narrowest reading consistent with the approved decisions and the existing schema; any can be revised before its increment starts.

- **F-1 — Organization lifecycle** (existing `organization_status` enum, no new values): `active → suspended` (suspend), `suspended → active` (reactivate), `active|suspended → closed` (close, terminal). Reactivation applies only to `suspended`; `closed` has no outgoing transition (OD-12). An illegal transition is `409 ORGANIZATION_LIFECYCLE_CONFLICT` with `details.status`, mirroring `USER_LIFECYCLE_CONFLICT`.
- **F-2 — Who may transition an organization's status:** `platform.tenants.manage` at `platform` scope only (today: `alendei_super_admin`). Reseller-initiated suspension is deferred with reseller lifecycle (OD-2). Organization principals cannot change their own organization's status.
- **F-3 — Who may create an organization:** `platform.tenants.manage` at platform scope (any reseller; defaults to the platform-default reseller), or `organizations.create` held at `reseller` scope, only beneath that same reseller. Creation seeds the tenant system roles (`TenantRoleProvisioner`) and one default workspace (`is_default = true`, slug `default`) in the same transaction, with audit rows.
- **F-4 — Status enforcement** (OD-3): for every principal without a platform-scope grant, a non-`active` organization is not selectable. Selecting it explicitly or implicitly, or presenting an API key bound to it, is refused with `403 TENANCY_ORGANIZATION_SUSPENDED` or `403 TENANCY_ORGANIZATION_CLOSED` — disclosed only to principals that hold a grant in (or beneath the reseller of) that organization; anyone else gets the existing `403 TENANCY_CONTEXT_MISMATCH`. Enforcement is per request, so there is no token-TTL window. Sign-in itself is unaffected (identity is platform-level).
- **F-5 — What platform principals may do in a non-active organization:** read everything their permissions allow, and perform lifecycle transitions permitted by F-1. **No tenant-data mutation is accepted in a `closed` organization by anyone** (terminal, retained); in a `suspended` organization, tenant-data mutations are refused for everyone in Phase 1C except the lifecycle transitions themselves. Refusal code: `409 ORGANIZATION_LIFECYCLE_CONFLICT`.
- **F-6 — Workspace and team lifecycle** (OD-5): the existing `workspace_status` values `active | archived` are the model; teams gain a `status` column using the **same** values (migration in 1C.1b). Both support `archive` and `restore`. The default workspace cannot be archived. An archived workspace or team cannot receive new teams, grants or API keys, and archiving a workspace is refused while it holds active teams (archive them first) — no cascading state change. Existing grants and keys are not revoked by archiving; they keep working, scoped as before.
- **F-7 — `/tenants/workspaces` compatibility** (OD-4): `GET /tenants/workspaces` and `GET /tenants/workspaces/:id` remain, unchanged, as **deprecated aliases** through Phase 1C so the current console keeps working; they gain `Deprecation`/`Link` headers in 1C.1b. Removal is a separate, later change after Gemini migrates to `/workspaces`.
- **F-8 — Immutable fields:** organization `slug`, `resellerId`; workspace `slug`; `isDefault`. Billing fields (`billingMode`, `billingPolicy`) are settable only by `platform.tenants.manage`.
- **F-9 — Administrator session revocation scope** (OD-7): the administrator needs `sessions.revoke` (and `sessions.read` to list) covering the organization, **and every grant the target user holds must lie within scopes the administrator covers**. Sessions are per identity, not per organization, so revoking them affects every organization the user belongs to; requiring coverage of all the target's grants is what makes the action non-cross-scope. A target holding any grant the administrator does not cover (another organization, a reseller or platform grant) is `403 AUTHZ_SCOPE_DENIED`.
- **F-10 — Revoke-all (self)** revokes every other live session and keeps the current one; returns the count.
- **F-11 — Eviction** (OD-6): eligible sessions are the user's live sessions (not revoked, not rotated, not expired); the oldest by `created_at` is revoked with reason `session_limit_exceeded` until the new session fits, inside the login transaction, serialized per user so concurrent logins cannot both exceed the cap. Each eviction writes `session.revoked`.
- **F-12 — Logout with an expired access token:** `POST /auth/logout` additionally accepts the refresh cookie **with** `X-Acc-Refresh` when no valid bearer token is presented, revoking the session that cookie belongs to; an unknown or already-revoked cookie still returns `204` and clears the cookie (no oracle).
- **F-13 — OpenAPI UI** (OD-8; **amended by the Phase 1C.3 ADR, G1 option C**): the Swagger UI is served only when `APP_ENV=development` and `OPENAPI_UI_ENABLED=true`. Outside development the UI is not served (`/api/v1/docs` is an unknown route, `404`), and the OpenAPI document, `/api/v1/openapi.json`, requires an authenticated user session. The production-hardening rule that refuses `OPENAPI_UI_ENABLED` is replaced by this requirement in 1C.3. *(Original wording: outside `APP_ENV=development`, `/api/v1/docs` and `/api/v1/openapi.json` require an authenticated user session.)*

### 1C.1a implementation notes (implemented; reviewable)

- **Addressing is not selecting.** `/organizations/:id` routes take no `X-Acc-Organization`; the service resolves the addressed organization from grants exactly as selection would (platform grant → any; otherwise connected and `active`; connected-inactive → status `403`; otherwise `404`) and runs the transaction with it as the tenant context, so RLS and the scope-chain resolver behave as for a selected organization. A denied attempt is audited at that organization — the caller is connected to it, or may select it as a platform-grant holder.
- **`OptionalTenantContext`** (new route decorator) for `GET/POST /organizations`: an organization is resolved when named or implied and none when ambiguous, only to attribute the actor. The F-5 mutation rule does not apply to such routes. The Gate-B rule that a denial is attributed only to a resolved scope is unchanged; a creation attempt by a principal with no resolved scope is refused before any target is evaluated.
- **`GET /organizations` is a two-stage read, so RLS remains a backstop** (remediation after the 1C.1a security review of `363e2a9`). *Stage 1:* `acc_auth` evaluates the caller's grant-derived reach, the `status`/`resellerId` narrowing and the signed cursor, and returns only candidate ids and sort keys; pagination (`limit + 1`, `hasMore`, `nextCursor`) is decided there exactly as before. *Stage 2:* the page's rows are read as `acc_app` under RLS, in one transaction, under contexts derived from the principal's own grants and independent of stage 1 — the database-validated platform-administrator claim, a database-validated reseller claim per reseller grant held, and an organization context per id in `authorizedOrganizationIds` (the caller's selection set; for support, every organization). RLS is the intentional backstop against an authorization-reach regression: a candidate it withholds fails the request closed (`500 INTERNAL_ERROR`, logged) rather than returning a partial page, because the cursor carries the last row's sort key and id and a shorter page would change `hasMore`. Proven by `organization-administration.sec-spec.ts` ("RLS backstop"), which reintroduces the Gate B reseller-derivation defect into the reach and fails if the row fetch returns to `acc_auth`. No grant, policy or schema change.
- **Creation idempotency** uses `IdempotencyService.executeOrganizationCreation` (advisory lock on `(endpoint, actor, key)`; lookup within the caller's RLS reach; record written in the new organization's namespace in the same transaction). The key is per-actor; an expired record means a reused key runs a new creation.
- **Provisioning elevation** reuses `app.provisioning` exactly as documented in migration `0000`: set, transaction-locally, only after authorization, together with `app.current_org_id` set to the new organization's pre-generated id.

### 1C.1b implementation notes (implemented; reviewable)

- **Selected organization, not addressing.** Unlike `/organizations/:id`, every workspace and team route runs in the organization `AuthGuard` selected, so the F-4/F-5 guard applies unchanged. Addressed workspaces and teams are read pinned to that organization and under RLS; a reseller administrator reaches a sibling organization's workspace only by selecting that organization.
- **Visibility and coverage are decided separately** (`SECURITY.md`, §31 common rules): not visible to the request's tenant (unknown, another organization, hidden by RLS) → `404`; visible but not covered → audited `403 AUTHZ_SCOPE_DENIED`, from the existing `AuthorizationService.assert` over the database-resolved chain — no second mechanism. A sibling workspace or team inside the organization is visible, so it is a `403`.
- **`orgId`** is advisory on the workspace routes (§31b) and not accepted on the team routes, which declare none (§31c): there it is an unknown field, `400`.
- **Archived targets (F-6)** are enforced by one helper (`tenancy/scope-lifecycle.ts`) called after authorization from team creation, `RoleAssignmentService.grant` and `ApiKeyAdministrationService.create`; it takes `FOR SHARE` on the workspace/team row. Archiving takes `FOR UPDATE` on the workspace before counting active teams, so the two serialize.
- **Organization status in the transaction.** Each workspace/team mutation re-reads the organization's status `FOR SHARE` (`409 ORGANIZATION_LIFECYCLE_CONFLICT`), closing the window between the guard's read and the write. Same rule as F-5, held at the row — not a new policy and not an RLS predicate.
- **Schema:** migration `0012` only (`teams.status`, reusing `workspace_status`, plus `teams_org_id_status_idx`). No RLS, policy or grant change; the 1C.6 integrity work is untouched.
- **Audit:** `workspace.archived/restored` and `team.archived/restored` added, and classified security-sensitive with the organization lifecycle actions.

### 1C.2 implementation notes (implemented; review PASS / CLOSED)

- **Audit routing — correction of a Phase 1B defect, approved as Option A.** Since Phase 1B.3, `DELETE /auth/sessions/:id` revoked the caller's own session as `acc_auth` and wrote `session.revoked` in that transaction, but `app_is_auth_audit_action()` never admitted that action: `audit_logs_auth_insert` refused the row and every successful self-revocation rolled back with a `500` (no test covered the success path). F-10 and F-11 need the same routing, before any tenant context exists. Migration `0013` adds exactly `session.revoked` and `session.revoked_all` to the `acc_auth` allowlist; the policy itself, its platform-scope and actor-shape confinement, and every grant are unchanged. The Gate B invariant "no security-sensitive action in the `acc_auth` vocabulary" is **refined, not dropped**: the overlap is pinned to those two actions (`AUTH_ROLE_TRANSACTIONAL_AUDIT_ACTIONS`), and `AuditWriter` refuses to write any `acc_auth` action that is also security-sensitive without the caller's transaction. Database enforcement constrains session revocation audit actions to the approved action/actor/scope boundary (the exact `app_is_auth_audit_action()` allowlist, platform-only scope, the user/api-key actor shape, and append-only `audit_logs`). Coupling the session audit event to the corresponding session mutation is enforced by the application transaction: all implemented application paths perform the mutation and the audit write atomically in the same transaction, an audit failure rolls the mutation back, and `AuditWriter` refuses to write either action without the caller's transaction. PostgreSQL itself does not make an independent session audit row impossible: a holder of the `acc_auth` database credential can technically insert an allowlisted session audit row inside an otherwise-valid `acc_auth` transaction. That is part of the accepted application-principal trust model (the same model under which `acc_auth` can write the pre-existing authentication events and `acc_app` any in-tenant action), and was approved over a database trigger in the 1C.2 review. Administrator revocation keeps the `acc_app` path, audited at the administrator's organization.
- **Live session** (F-11): not revoked, not rotated, not expired, judged by the database clock. `GET /auth/sessions`, `GET /users/:id/sessions`, the cap and every returned count use it; rotated, expired and revoked rows are history and are kept, never listed.
- **The revocation unit is the rotation chain** (`family_id`). A refresh replaces a session row with a successor, so an id a client listed may already be spent: revoking a session (self or administrator), logout on either path, eviction, revoke-all and user disable revoke every unrevoked row of each chain concerned. Revoking a chain with nothing live left is `404` (a repeat).
- **One serialization point per user.** Login (cap enforcement), refresh (rotation), revocation of every kind, revoke-all, logout and user disable take `pg_advisory_xact_lock` keyed on the user inside their own transaction — the primitive organization-creation idempotency already uses. Rotation re-reads its session after taking the lock, so a revocation that committed meanwhile is seen and no successor outlives it; whichever of two conflicting operations commits second sees the first. **Lock order:** a transaction that also writes the user's `users` row (login's `last_login_at`, disable's status) writes it *before* taking the advisory lock; no path takes them in the other order, and the per-request `touch` holds only a `sessions` row lock and waits on nothing else — there is no cycle, and the disable-vs-login race is exercised repeatedly by the suite. Login's `users` update is conditional on `status = 'active'`, so a disable committing between login's read and its write refuses the login instead of minting a session for a disabled account.
- **Cap enforcement** (F-11, OD-6): inside the login transaction and under the user's lock, the user's live sessions are ordered by `created_at`, then `id` (deterministic for identical timestamps), and the oldest chains are revoked with reason `session_limit_exceeded` until the new session fits; the new session is inserted afterwards, so it is never a candidate. Each eviction writes `session.revoked` (`acc_auth`, platform scope, actor = the user) in the login transaction. Concurrent logins therefore never leave more than `AUTH_MAX_SESSIONS_PER_USER` live sessions. Because a refresh gives its successor a new `created_at`, "oldest" means least recently established or refreshed.
- **F-9 complete-grant coverage.** The target's **complete** grant set is read from authoritative identity state (`ScopeResolver` through `acc_auth`), never through the administrator's RLS view, which would hide exactly the grants that must refuse. Each grant's ancestry is resolved on the same identity plane and judged by the ordinary coherent-grant evaluator (`AuthorizationService.assertCoversEveryScope`); only a yes/no leaves it. Order: permission at the selected organization (audited `403`) → target is a member (`404`) → every grant covered (audited `403 AUTHZ_SCOPE_DENIED`, filed at the administrator's scope and naming only the target user, never the uncovered grant's scope, which may be another tenant's). Revoke routes require a signed-in user session; an API key may list within its coverage. **Accepted race (permissive, carried forward):** a grant created after the grant set is read can be missed. The operation may then proceed on the earlier grant set — potentially disabling or revoking the target slightly earlier than ideal — but it does not grant the administrator additional authority over the newly created grant.
- **Frozen roles are unchanged.** `reseller_admin` and `workspace_manager` carry no session permission, so they cannot administer sessions; a workspace- or team-scoped role carrying the session permissions still fails the organization-level check. Only `org_admin` (organization), `alendei_super_admin` (everything) and `alendei_support` (`sessions.read` only) act here.
- **Logout (F-12)** is `@OptionalAuthentication()`: a bearer that authenticates is used; a missing, expired or revoked one leaves no principal, and the handler revokes the chain the refresh cookie belongs to. `X-Acc-Refresh` is required on both paths; the cookie path is throttled per address with the refresh bucket; an unknown or already-revoked cookie gets the same `204` and cleared cookie. `auth.logout` on the cookie path is written only when a live session was revoked; on the bearer path it is written for every bearer logout (as since Phase 1B), with `after.revoked` stating whether a live session was revoked — `false` only when a concurrent revocation of that session committed first. No cookie and no bearer is `401`.
- **Organization lifecycle — the behaviour this increment preserves, not new product policy.** Sessions belong to the identity, so login, refresh, logout, `GET /auth/sessions`, self revocation and self revoke-all work for a member of a suspended or closed organization (sign-in was already unaffected, §31a notes). Administrator session routes act in the selected organization and so inherit F-4/F-5: a member of a suspended organization cannot select it (`403 TENANCY_ORGANIZATION_SUSPENDED`), and a platform principal selecting it may list but every revocation is `409 ORGANIZATION_LIFECYCLE_CONFLICT`. Whether a suspended organization's members should be signed out, or its administrators allowed to revoke, is a product decision not made here. **Accepted lifecycle-policy residuals (review L-3):** F-9 coverage counts the *administrator's* grants in a suspended or closed organization as authority (grants have no inactive state), so an administrator of suspended organization B acting from active organization A can revoke the sessions of a user whose grants are in A and B; and no API path can revoke the sessions of a user whose only organization is suspended or closed (the organization's members cannot select it, and a platform principal's revocation there is `409`). Both are retained unchanged pending a lifecycle policy.
- **`users.disable` under F-9 (review M-2, fixed in the 1C.2 remediation).** `POST /users/:id/disable` (Phase 1B.6.1) authorized `users.disable` at the selected organization only, yet disabling an identity signs it out and blocks its sign-in in every organization — an organization administrator could achieve by disable exactly the cross-scope revocation F-9 refuses. `disable` now runs the same F-9 check, through the same helper and evaluator as session administration: the target's complete grant set read from authoritative identity state (not the caller's RLS view) must be covered for `users.disable`, or the request is an audited `403 AUTHZ_SCOPE_DENIED` — recorded before the refusal, with no status change and no session revoked. It runs after the membership check (`404`) and before the lifecycle conflict and the last-platform-admin guard, so an actor that may not disable the target never learns its status. Consequence: only a principal covering a platform grant — a platform administrator — can disable a platform administrator, and an organization administrator can disable only users whose every grant it covers (in practice, users of its organization alone). The Gate B last-platform-admin suite was adapted accordingly: its actors are now platform administrators, the invariant it proves is unchanged, and the organization-administrator refusal is asserted explicitly. `users.reactivate` was not changed in 1C.2 (carried forward as a residual); it was fixed by the later Phase 1C `users.reactivate` remediation (below).
- **API-key refusal on the administrator revoke routes (review L-1, retained).** `POST /users/:id/sessions/revoke-all` and `DELETE /users/:id/sessions/:sessionId` refuse a non-session principal with `403 AUTHZ_SCOPE_DENIED` before any authorization decision, and write no `authorization.denied`. That record describes a scope decision made by `AuthorizationService` (ADR-005 D-6); a refusal of the principal *type* is not one, as with the existing API-key refusals of organization creation and lifecycle transitions.
- **Rotation-chain integrity (review L-2, retained).** `family_id` is assigned at creation and copied to a successor only inside rotation, under the user's lock, for the same user; nothing else writes it. That is an application invariant — the schema does not enforce family immutability or one user per family — and is retained without a schema change.
- **Deterministic serialization evidence (remediation).** Besides the repeated races, `session-policy.sec-spec.ts` holds a user's lock on a separate connection, stages the other half of the race inside that transaction (a rotation or a chain revocation in flight), and proves from `pg_locks` that the real request is queued behind that advisory lock before asserting the final state: administrator revoke-all vs rotation, refresh vs chain revocation, and login vs rotation at the cap. Two logins for one user are serialized **twice** — by the advisory lock and by login's conditional `users`-row update, taken first — so the login-vs-rotation case (rotation takes only the advisory lock) is the one that proves the advisory lock is load-bearing for the cap.

### 1C.2 closure — PASS / CLOSED

**Phase 1C.2 — Session Policy: PASS / CLOSED** (27-Sep-2026). Base `25edd0e`; implementation `19085bb`; review remediation `b505ff7`.

- **M-1 CLOSED:** application-level transaction coupling of the `acc_auth` session audit events accepted; the database allowlist, platform-scope and actor-shape restrictions retained; documentation corrected; no database trigger added.
- **M-2 CLOSED:** `users.disable` uses the authoritative shared F-9 complete-grant evaluator; an uncovered grant produces an audited `403`, with no status change and no session revocation.
- **Evidence:** deterministic concurrency tests (held per-user lock, `pg_locks`-proven queuing), mutation tests and the full regression suite all PASS; no schema drift. Nothing pushed.

**Carried-forward Phase 1C security residuals** (not 1C.2 blockers; reviewed with the rest of Phase 1C before Gate C):

1. `users.reactivate` checks authorization only in the selected organization but has a global account-wide effect. This remains a Phase 1C security residual and must be reviewed before overall Phase 1C closure. — **Resolved** by the Phase 1C `users.reactivate` remediation (below).
2. Session behavior for members of suspended or closed organizations remains a product/security decision for broader Phase 1C review.
3. API-key principals refused on administrator session-revocation routes do not currently produce an `authorization.denied` audit event. This is a documented residual.
4. `family_id` / session rotation-chain integrity is enforced by the application rather than by a database constraint. This is a documented residual.
5. Coupling between session audit rows and the corresponding session mutation is enforced by the application transaction model rather than by a database trigger/constraint. The accepted trust model and its limits are documented in the 1C.2 implementation notes above and in `SECURITY.md`.
6. The F-9 complete-grant check has a concurrency race: a grant created after the grant set is read can be missed. This is permissive rather than conservative: the operation may proceed based on the earlier grant set, potentially disabling/revoking the target slightly earlier than ideal, but it does not grant the administrator additional authority over the newly-created grant.

### Phase 1C security remediation — `users.reactivate` under F-9

Decided after the pre-1C.3 read-only review, which found that `POST /users/:id/reactivate` (Phase 1B.6.1) authorized `users.reactivate` at the selected organization and checked only that the target was a member there, while reactivation restores the identity globally. After M-2 this was asymmetric: an organization administrator that may not disable a multi-organization user or a platform administrator could undo such a disable, and every API key the target had created — in any organization — regained its authority (a creator that cannot authenticate confers none).

- **Decision:** Reactivation is globally effective — it restores sign-in in every organization the identity belongs to, its authority at every scope it holds a grant, and the effectiveness of every API key it created — so it requires `users.reactivate` covering **every** grant the target holds (ADR-012 F-9 complete-grant coverage, the same shared check as disable). An uncovered grant is a generic `403 AUTHZ_SCOPE_DENIED`, audited as `authorization.denied`, that names no grant, organization or scope — no target grant topology is disclosed — and changes nothing: no status, credential, session or API-key effect.
- **Implementation:** one call to the existing shared helper (`assertCoversSubjectGrants`, the same evaluator and authoritative identity-side grant set as disable and session administration), after the membership check (`404`) and before the lifecycle conflict (`409`), so a caller that may not reactivate the target never learns its status. The permission check at the selected organization, target membership, the `active`/`invited` restoration rule, the single transaction and the `user.reactivated` audit row are unchanged. No schema change.
- **Tests:** `session-policy.sec-spec.ts` group R (organization administrator refused for a user also in another organization — status, credential and sessions untouched, no sign-in, the target's API key in the other organization still without authority, denial audited generically; refused for a disabled platform administrator; missing permission refused as before; a fully covered user still reactivated, sessions not resurrected; a platform administrator reactivates the multi-organization user and its key works again). The Gate B lifecycle case "a reactivated administrator counts again" now uses a platform administrator as the actor.
- **Residual recorded, not changed:** `PATCH /users/:id` (`users.update`) is **not** changed and remains a separate deferred residual: it authorizes at the selected organization but writes `users.phone`, a field of the global identity. It is profile data today and is not used for authentication.

### 1C.6 implementation notes (implemented; Gate C.6 PASS / CLOSED)

Migration `0014` (`DATABASE.md`). Decisions approved before implementation:

- **§14.1 — role narrowing: Option A (refuse).** Narrowing a role's `allowed_scope_types` while a grant exists at a scope type it would stop admitting is refused, not auto-revoked. That keeps the invariant literally true: no `user_roles` row exists at a scope type its role does not admit. The API checks first, inside the update transaction, after locking the role `FOR UPDATE`, and answers `409 RESOURCE_CONFLICT` with `details.scopeTypesInUse` (sorted), the same code as deleting a role that is still granted. The database guard (`trg_roles_guard_allowed_scope_types`) fails closed for every writer. Widening, renaming and a narrowing that strands nothing are unaffected.
- **§14.2 — uniform enforcement.** `fn_validate_user_role_scope` checks `allowed_scope_types` for platform roles too; there is no bypass. The seeded platform roles already comply. One Phase 1B test changed its expected message only: moving the last super-admin grant to reseller scope (`platform-admin-liveness.sec-spec.ts`) is still refused, now by the admissibility check, which fires before the liveness trigger.
- **§14.3 — test fixture only.** The harness's per-tenant fixture role (`auth-harness.ts` `createTenant`) now admits `organization`, `workspace` and `team`, so existing workspace- and team-scoped grants in the suites remain admissible. The production `org_admin` (`{organization}`) and every permission set are unchanged.
- **Error mapping (SQLSTATE → API).** `23514` with constraint `user_roles_scope_type_admitted` → `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED` (the service pre-check normally answers first; the mapping covers a narrowing that commits between the check and the insert). `23514` with `roles_allowed_scope_types_in_use` → `409 RESOURCE_CONFLICT` (`details.scopeTypesInUse` omitted when only the database knows). `42501` with `organizations_reseller_id_immutable` has no API mapping: no route writes `reseller_id` (`PATCH /organizations/:id` rejects the field with `400`), so reaching it is an internal error.
- **Reseller trust model.** The guard trusts only the validated claim `app_is_platform_admin()` (a real `alendei_super_admin` holder) or an RLS-bypassing principal (owner or migration). A forged platform or reseller claim, a reseller administrator and an organization administrator are refused, although RLS lets the latter two update other columns of the row. No reseller move is implemented (Phase 9). A race test is not relevant: the decision depends only on the writer's own validated claim and the row being changed, and it reads no other row that a concurrent transaction could change.
- **Concurrency.** The grant trigger's `FOR SHARE` on the role row conflicts with the narrowing's row lock. Both orders are proven deterministically with a held transaction and `pg_blocking_pids`: narrowing waits for an in-flight grant and then gets `409`; a grant waits for an in-flight narrowing and then gets `422`; a narrowing waits for an in-flight direct grant mutation and then gets `409`; with direct SQL on both sides at READ COMMITTED, the database refuses whichever write would break the invariant. Outside READ COMMITTED a narrowing is refused outright (migration `0015`, below). The composite FK serializes parent and child writes on the parent row's key lock, so the later writer is refused.
- **Residuals.** The FKs are MATCH SIMPLE by design, so an organization-bound key or ticket (`workspace_id IS NULL`) is checked only by its `org_id` FK. `family_id` integrity, suspended-organization session semantics and `users.update` remain carried-forward residuals, outside 1C.6.

### 1C.6 security review remediation — H-1 and H-2 (implemented; closed)

The read-only security review of `7ab1b88` returned HOLD with two findings, both accepted and fixed in migration `0015` (`DATABASE.md`). Migration `0014` is not edited.

- **H-1 — SECURITY DEFINER trigger functions executable by PUBLIC.** Decision: the three 1C.6 functions (`fn_validate_user_role_scope`, `fn_roles_guard_allowed_scope_types`, `fn_organizations_guard_reseller_id`) are trigger-only: `REVOKE ALL … FROM PUBLIC`, so no RLS-bound principal holds `EXECUTE`. PostgreSQL checks `EXECUTE` when a trigger is created, not when it fires, so the real triggers are unaffected and the function bodies are not weakened. **Correction of the 1C.6 implementation report:** the `REVOKE` originally planned for two of these functions was dropped because `tenant-context-trust` D pinned the exact trigger-only error message. That test was over-specific; it did not express an architectural need for `EXECUTE`. It now accepts either refusal (`42501` or `0A000`) and asserts the real invariant: no application principal holds `EXECUTE`, and none can attach one of these functions to a temporary table.
- **H-1, pre-existing functions — deferred at first, then fixed as H-3.** The six older SECURITY DEFINER trigger functions had the same attachment path. The first remediation (migration `0015`) recorded them as a separate residual; the remediation review then decided to fix them before Gate C.6 closure (H-3, below).
- **H-2 — narrowing invariant at REPEATABLE READ/SERIALIZABLE.** Decision (review Option A): the business invariant stays that every `user_roles.scope_type` is admitted by its role's `allowed_scope_types`. Narrowing is supported at READ COMMITTED. REPEATABLE READ and SERIALIZABLE narrowing attempts are deliberately refused with SQLSTATE `25000` (constraint `roles_allowed_scope_types_narrowing_isolation`), because the current locking/snapshot design does not safely establish the invariant at those isolation levels. Widening remains supported. No isolation setting is changed and nothing retries. The API runs at READ COMMITTED and is unaffected. This path has no API mapping, because no API transaction reaches it.
- **Correction — M4b.** The 1C.6 report described M4b (API narrowing pre-check removed) as proof of API-only protection. It is not. With the pre-check removed the database guard still refuses, and the service maps that refusal to the same `409`; the tests fail only because `details.scopeTypesInUse` is then absent. M4b shows the pre-check is exercised; the security property is the database guard, shown by M4a and M4c.
- **Mutation isolation.** The 1C.6 M4c run committed a stranded grant into the canonical test database for the duration of one run, cleaned up by fixture teardown. From this remediation on, every destructive mutant runs on a throwaway `CREATE DATABASE … TEMPLATE` clone that is dropped after the run. The canonical database's catalog-and-data fingerprint is compared before and after (`TESTING.md`).

### 1C.6 security review remediation — H-3 (implemented; closed)

- **Finding.** The six pre-existing SECURITY DEFINER trigger functions (`fn_validate_audit_scope`, `fn_validate_role_permission`, `fn_protect_system_role_permissions`, `fn_protect_system_roles`, `fn_user_roles_platform_admin_guard`, `fn_users_platform_admin_guard`) were executable by PUBLIC, so they had the same temporary-table attachment path as H-1. Two of them disclosed whether supplied cross-tenant ids exist, and which organization owns them.
- **Decision.** Fix now, at the privilege layer only: migration `0016`, `REVOKE ALL … FROM PUBLIC` on exactly those six. Function bodies, ownership, triggers, RLS policies, tables and application authorization are unchanged. The seven triggers that use them keep firing, because `EXECUTE` is checked only at `CREATE TRIGGER`. This is proven for each trigger through `acc_app` (and `acc_auth` for audit rows) in `database-integrity.sec-spec.ts` group I. Every SECURITY DEFINER trigger function is now trigger-only, and `tenant-context-trust.int-spec.ts` pins the complete list.
- **Not expanded.** The SECURITY DEFINER functions outside the nine trigger functions are reported, not changed (`SECURITY.md`): `app_is_platform_admin`, `app_current_reseller_id`, `app_session_bypasses_rls`, `app_org_reseller` and `fn_assert_platform_admin_remains`. The last was still PUBLIC-executable; the H-3 review decided to revoke it (H-4, below).

### 1C.6 security review remediation — H-4 (implemented; closed)

- **Finding.** `fn_assert_platform_admin_remains()` (SECURITY DEFINER, the last-platform-admin liveness check) kept PUBLIC `EXECUTE`. Any principal could call it directly, taking the platform-admin advisory lock and learning whether an active administrator exists, or reach it through an invoker trigger function of its own.
- **Decision.** Migration `0017` contains only `REVOKE ALL ON FUNCTION fn_assert_platform_admin_remains() FROM PUBLIC`. Its body, owner, SECURITY DEFINER status, triggers, tables, RLS, application code and authorization logic are unchanged. Its only callers are the two SECURITY DEFINER liveness trigger functions, which run as the owner, so the invariant is enforced exactly as before (proven in `database-integrity.sec-spec.ts` group J, alongside the unchanged Gate B liveness suites).
- **Scope boundary.** `app_is_platform_admin()`, `app_current_reseller_id()`, `app_session_bypasses_rls()` and `app_org_reseller(uuid)` are not changed. They are recorded in `SECURITY.md` as separately reviewed security primitives. The first two must stay executable by the RLS-bound principals, because every policy calls them.

### 1C.6 closure — PASS / CLOSED

**Phase 1C.6 — Database Integrity: IMPLEMENTED AND CLOSED (PASS)** (Gate C.6, 28-Sep-2026). Implementation `7ab1b88`; security-review remediation `8f0c8c4` (H-1, H-2), `4f3e4cc` (H-3), `f49ce0f` (H-4). Nothing pushed.

**Objective.** Database integrity and security closure: composite workspace/organization foreign keys for `api_keys` and `ws_tickets`; database enforcement of `roles.allowed_scope_types`; `organizations.reseller_id` immutability; migration backfill verification; role-narrowing concurrency and isolation behaviour; and SECURITY DEFINER trigger-function privilege hardening.

**Final implementation (migrations).**

| Migration | Content |
|---|---|
| `0014` | Database integrity controls: the verifying backfill (aborts on existing bad data); `api_keys_workspace_org_fk` and `ws_tickets_workspace_org_fk`; `fn_validate_user_role_scope` enforcing `allowed_scope_types` for every role; `trg_roles_guard_allowed_scope_types`, which refuses narrowing that would strand a grant; `trg_organizations_guard_reseller_id` |
| `0015` | The three new 1C.6 SECURITY DEFINER trigger functions made owner-only (H-1), and the narrowing isolation guard (H-2) |
| `0016` | The six pre-existing SECURITY DEFINER trigger functions made owner-only (H-3) |
| `0017` | The platform-admin liveness helper `fn_assert_platform_admin_remains()` made owner-only (H-4) |

**Final hardened set: owner-only `EXECUTE`** (`{postgres=X/postgres}`; no `EXECUTE` for PUBLIC, `acc_app`, `acc_auth` or `acc_relay`):
- The nine SECURITY DEFINER trigger functions: `fn_validate_user_role_scope`, `fn_roles_guard_allowed_scope_types`, `fn_organizations_guard_reseller_id`, `fn_validate_audit_scope`, `fn_validate_role_permission`, `fn_protect_system_role_permissions`, `fn_protect_system_roles`, `fn_user_roles_platform_admin_guard`, `fn_users_platform_admin_guard`.
- The liveness helper `fn_assert_platform_admin_remains`.

Every trigger using them still fires for every writer, because PostgreSQL checks `EXECUTE` only when a trigger is created.

**Where each guarantee lives.**
- *Database-level* (holds with the service bypassed, proven as the owner and as `acc_app`): the composite FKs; `allowed_scope_types` at grant time for every role; refusal of a narrowing that would strand a grant; refusal of narrowing outside READ COMMITTED; `reseller_id` immutability, except for a validated platform administrator or an RLS-bypassing principal; the aborting backfill; the owner-only function ACLs.
- *Application-level* (the API's own behaviour, backed by the database): the `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED` pre-check; the `409 RESOURCE_CONFLICT` narrowing pre-check with `details.scopeTypesInUse`, under a `FOR UPDATE` role lock; `400` for `resellerId` on `PATCH /organizations/:id`.

**Role narrowing.** Every `user_roles.scope_type` must be admitted by its role's `allowed_scope_types`. Narrowing is supported at READ COMMITTED. REPEATABLE READ and SERIALIZABLE narrowing attempts are deliberately refused with SQLSTATE `25000`, because the current locking/snapshot design does not safely establish the invariant at those isolation levels. Widening remains supported.

**Verification evidence (final regression at `f49ce0f`).**
- API unit 300/300; API integration 124/124; API security 855/855.
- DB unit 4/4; DB integration 136/136.
- Web unit 161/161; web security 87/87.
- No skipped tests. Typecheck, lint and build pass.
- Dependency audit acceptable: no unaccepted high or critical advisories.
- Schema drift clean.
- Empty bootstrap 18/18 migration hashes, and migration reruns are idempotent (the migrator re-run is a no-op).
- Last-platform-admin liveness 55/55.
- Mutation tests ran only on disposable database clones, and the canonical test database was not left mutated (its catalog matches a fresh `0000`–`0017` bootstrap), with 0 stranded grants.
- Details: `TESTING.md` §6q.

**Carried-forward residuals** (not Phase 1C.6 blockers):
1. `family_id` / rotation-chain integrity is enforced by the application, not by a database constraint.
2. Session behaviour for members of suspended or closed organizations.
3. `users.update` authorizes at the selected organization but writes a field of the global identity (`users.phone`).
4. API-key principals refused on administrator session-revocation routes produce no `authorization.denied` audit event.
5. The F-9 complete-grant check race is permissive: a grant created after the grant set is read can be missed.
6. The coupling of `acc_auth` session audit rows to their session mutation is enforced by the application transaction.
7. `audit-read.sec-spec.ts` case 14 has a UUIDv7 ordering flake (a test-quality residual).
8. The composite FKs are MATCH SIMPLE, so an organization-only row (`workspace_id IS NULL`) is checked only by its `org_id` FK.
9. The separately reviewed SECURITY DEFINER/RLS primitives `app_is_platform_admin()`, `app_current_reseller_id()`, `app_session_bypasses_rls()` and `app_org_reseller(uuid)` are unchanged by 1C.6 (`SECURITY.md`).

**Gate status.** Phase 1C.6 is closed. **Overall Phase 1C remains open**: Gate C (`ROADMAP.md` §4d) is not passed. The next frozen increment is **Phase 1C.3**.

### Phase 1C.3 Architecture Decision Record (APPROVED 28-Sep-2026; implementation authorized)

**Objective.** Reconcile the existing API with a deterministic OpenAPI 3.0.3 contract, protect the generated document outside development with authenticated user-session access, provide Swagger UI only in development, and enforce contract and snapshot drift in CI.

**Boundary.** Phase 1C.3 does not introduce new API capabilities, and does not change authorization, RBAC, RLS, sessions, business logic, response envelopes, WebSockets, billing, provider functionality or frontend behaviour. It documents the actual runtime contract. Where the runtime is inconsistent (headers, status codes, structures), the inconsistency is documented and, where appropriate, recorded as a residual; it is not normalized. A runtime defect found by the contract work is recorded, and work stops for a decision; it is not silently fixed.

**G1 — exposure model (option C: UI development-only, JSON-only elsewhere).** `OPENAPI_UI_ENABLED` enables the OpenAPI capability; it does not mean a UI exists in every environment.

| Environment | Flag | UI | JSON (`/api/v1/openapi.json`) |
|---|---|---|---|
| development | false | absent | absent |
| development | true | public development UI | public |
| test / staging / production | false | absent | absent |
| test / staging / production | true | absent (`/api/v1/docs` is an unknown route, `404`) | authenticated user session only |

Exactly one route produces the document: `GET /api/v1/openapi.json`. None of these may serve it: `/openapi.json/`, case or encoded variants, `-json`, `-yaml`, a Swagger init script embedding the document, a static copy or a downloadable artifact. The development UI obtains the document from that same route and never contains it. Outside development there are no UI routes, no Swagger UI assets and no init script.

**Decisions G2–G10.**
- **G2 — serving.** Nest controllers serve the document, so the existing `AuthGuard`, rate limiting, error envelope and correlation handling apply. There is no raw Express document route and no migration. The public development controller or the protected controller is registered at bootstrap according to the matrix, and neither when the flag is off.
- **G3 — flag.** `OPENAPI_UI_ENABLED` is kept and stays off by default. The production refusal is removed.
- **G4 — development exception.** Unauthenticated access only when `APP_ENV=development && OPENAPI_UI_ENABLED=true`, and tested.
- **G5 — schemas.** Swagger CLI plugin output is generated into a committed metadata file (`apps/api/src/metadata.ts`). That file is the single source for the build, Jest, the generator and CI. The plugin is removed from `nest-cli.json`, and a test proves the document is identical on the build and test/generator paths. Documentation-only response classes are used where interfaces cannot be reflected. The runtime response architecture is unchanged, and no Zod or other contract framework is added.
- **G6 — tooling.** `ajv` and `ajv-formats`, development dependencies of `@acc/api` only, used only by contract validation.
- **G7 — version.** OpenAPI **3.0.3**. A move to 3.1 needs separate approval.
- **G8 — schemes.** Two `http` bearer schemes model the wire protocol, `userSession` (JWT) and `apiKey` (`Authorization: Bearer ak_…`). `refreshCookie` is a cookie scheme on `acc_refresh`. `X-Acc-Refresh` is a required header parameter where `@RequireCsrfHeader` applies. The runtime credential format is unchanged.
- **G9 — credential metadata.** `@AcceptedCredentials(...)` is documentation-only metadata: never a guard, never part of authorization. The existing user-session checks stay in the services. Behavioural contract tests prove metadata and runtime agree.
- **G10 — contract validation.** A dedicated contract-validation suite, with an opt-in validator helper. There is no global hook and no change to the existing harness's semantics.

**Authentication model (outside development).** `GET /api/v1/openapi.json` passes through the unchanged global pipeline (`CsrfGuard`, `AuthGuard`, `RateLimitGuard`, exception filter, interceptors, correlation middleware). The route is `@AuthorizationExempt` (documentation), `@NoTenantContext` and `Cache-Control: no-store`. The handler admits only a user principal with a live session: an API key gets `403 AUTHZ_PERMISSION_DENIED` (the `POST /ws/ticket` precedent), and a missing, invalid, expired or revoked credential or a disabled user gets `401` from `AuthGuard`. No refusal body contains the document.

**Snapshot and CI.**
- **Snapshot:** `apps/api/openapi/openapi.v1.json`.
- **`openapi:generate`:** writes the normalized document (recursive key sort, sorted paths/methods/parameters/`required`, `enum` order kept, no environment values). It refuses to run in CI.
- **`openapi:check`:** generates into a temporary location, compares with the committed snapshot and metadata, and fails on any difference. It never writes committed files.
- **CI job:** a dedicated `openapi-contract` job runs the check.
- **Route exclusions:** exactly one, `GET /metrics` (`@ApiExcludeController`). It is explicit, documented and tested; no route may disappear silently.
- **CODEOWNERS:** created only if an owner can be established from existing repository configuration. None exists, so CODEOWNERS is a post-implementation repository-governance item.

**Mutation proofs.** These run on disposable copies or clones or isolated fixtures only. Each records the mutation, the expected detection, the actual detection, the test name and the result.

### 1C.3 implementation notes (implemented; Gate C.3 PASS / CLOSED — see "1C.3 closure")

Implemented as the approved ADR above describes (`API.md` §9, `TESTING.md` §6q).

**Deviations from the ADR's file plan** (none changes a decision):
- The document generator is `apps/api/src/openapi/openapi-cli.ts`, compiled with the API, rather than a file under `apps/api/scripts/`. Nest and the Swagger scanner need decorator metadata, which `tsx` (esbuild) does not emit. The metadata generator does run under `tsx` (`scripts/openapi-metadata.ts`), because it only walks the AST.
- The DTO-versus-schema check lives in `openapi-contract.sec-spec.ts`, not a unit spec, because it reads class-validator metadata from the booted module graph.
- `test/setup-env.ts` pins `OPENAPI_UI_ENABLED=false`, so a developer's `.env` (which enables it) cannot change the route table under test. It is test-environment configuration; no test's semantics change.
- A second documentation-only decorator, `@DocumentedRateLimitHeaders`, records which rate-limit headers a route actually sends. It is never read by a guard or the limiter.
- `app.factory.ts` exports `UNPREFIXED_ROUTES` so the generator applies the same global-prefix exclusions.

**Runtime changes, exactly:**
- the OpenAPI module and its two controllers, and a canonical-path middleware that returns the ordinary unknown-route `404` for variant spellings of the document route;
- the development-only UI mount;
- `SwaggerModule.setup` removed;
- the `OPENAPI_UI_ENABLED` production refusal removed;
- `AppConfigService.openApiMode`.

There is no change to authorization, `AuthGuard`, sessions, RBAC, RLS, the rate limiter, the envelopes, validation or idempotency; controllers and DTOs gained decorators only.

**Contract corrections found by the behavioural suite** (documentation corrected; runtime unchanged):
- an idempotency payload mismatch is `422`;
- a created key's `secret` is the secret half;
- an API key's grant `roleId` is `api_key:<id>`;
- the plugin had documented `@IsIn` enums wider than validation admits (all scope types where only tenant or grantable ones are valid), omitted `@Matches` patterns, and typed the page `limit` as a number without bounds.

**Residuals** (recorded, not fixed; outside 1C.3's scope):
1. An unknown route **outside** the versioned prefix (for example `/openapi.json`) answers without `X-Correlation-Id`, and its error body carries `correlationId: "no-correlation-id"`, because the correlation middleware runs below the prefix only. This is pre-existing.
2. The rate-limit headers differ by limiter (the per-address buckets send no `X-RateLimit-Reset`). This is documented as is, per the ADR, not normalized.
3. The served document is built from the running module graph through a minimal application facade (`ModulesContainer`, `ApplicationConfig`, `HttpAdapterHost`). That relies on what the Swagger scanner reads. The contract suite fails if the served document ever diverges from the snapshot.
4. Documented but not exercised by the behavioural suite: `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`, the guard's `409` for a mutation in a non-active organization (covered by the Phase 1C.1 suites), `503` from health, and `500`.
5. Production is booted in `openapi-access.sec-spec.ts` through the real `createApp()` (`APP_ENV=production`, `NODE_ENV=production`, both flag values), with one test-only substitution at configuration validation: the real `validateEnv` must refuse the production environment for exactly `SECRETS_BACKEND=env` (no other backend is implemented yet) and `DATABASE_SSL=false` (the local PostgreSQL has no TLS), and every other production rule must pass. The application then runs on the schema's parse of that same environment. A real production deployment remains unexercised until a secrets backend exists.
6. CODEOWNERS: no owner can be established from existing repository configuration, so it is a post-implementation repository-governance item.
7. `packages/db` `audit.int-spec.ts` ("accepts a pre-tenant authentication record") counts every `resource_type='auth'` audit row in the database. Rows left by an interrupted run (the first 1C.3 mutation runs used the canonical test database and left 22) fail it until another suite's audit purge removes them. Mutation and other destructive runs now go through `scripts/with-db-clone.mjs` (TESTING.md §6q), so they cannot reach the canonical database. The test itself is unchanged, because 1C.3 does not touch `packages/db`; making it purge before each case is a one-line, separately reviewable change.
8. The repository-wide `format:check` in the CI static job still fails on 60 existing `apps/web` files. That is frontend-owned and predates 1C.3; the drift check runs in its own job so it is not masked.

### 1C.3 closure — PASS / CLOSED

**Decision.** Gate C.3 **PASS / CLOSED** (user decision, 29-Sep-2026). The implementation is `03de8c0` … `3f9a77f`, and the review remediation is checkpoint `bbbc72c`. Nothing is pushed.

**Accepted.**
- The G1 option C exposure matrix: a public UI and document in development only; elsewhere only `GET /api/v1/openapi.json`, for a signed-in user session. An API key is refused, and the flag off means no route.
- No alternate document-bearing route, and no document embedded in the UI initializer.
- Exact route/specification reconciliation: 58 application operations + 1 document operation = 59, with `GET /metrics` the sole exclusion.
- OpenAPI 3.0.3, deterministic metadata and snapshot generation, and CI drift enforcement.
- Request, response, error and header contract coverage.
- The production-mode exposure proof, booted through `createApp()` with the single validation substitution in residual 5.
- Disposable database clones for destructive and mutation runs (`scripts/with-db-clone.mjs`).
- The cosmetic section-name mismatch in that script's header comment, accepted as is.

**Verification evidence (final regression of the checkpoint content).** Every database-touching suite ran on a disposable clone of the test database:
- API unit 312/312.
- API integration 124/124.
- API security 924/924.
- DB unit 4/4.
- DB integration 136/136: before and after the API suites, in the same clone, twice.
- Web unit 161/161 and web security 87/87.
- Typecheck, lint and build pass.
- `openapi:check`: the snapshot matches the generated document.
- Schema drift clean, and migration hashes 18/18.
- Dependency audit: no unaccepted high or critical advisories.
- Mutations: 22/22 caught, each on its own clone, with every source file restored byte-identical and the template unchanged (`TESTING.md` §6q).
- The rows an incorrectly invoked run left in the canonical test database (90 `@example.test` users and their 3 sessions) were removed by their recorded ids. The schema, the migration journal and every other table were unchanged.

**Carried-forward residuals** (not Phase 1C.3 blockers):
1. Residuals 1–8 above. For residual 7, making `audit.int-spec.ts` purge before each case is deferred to a separate `packages/db` review.
2. A complete sequential run of the other suites leaves 42 `users` rows behind: the OpenAPI suites leave none. The clone runner absorbs them, but a run against the canonical database accumulates them. This is pre-existing test-isolation debt.
3. The Phase 1C residuals recorded in "1C.6 closure" are unchanged by 1C.3.

**Gate status.** Phase 1C.3 is closed. **Overall Phase 1C remains open**: Gate C (`ROADMAP.md` §4d) is not passed. Phase 1C.4 is not started and requires explicit authorization.

### 1C.4a implementation notes (implemented 30-Sep-2026; Gate C.4a PASS / CLOSED — see "1C.4a closure")

Authorized 30-Sep-2026 for **1C.4a only**; 1C.4b stays a separately authorized Gemini increment. The approved scope decisions, as implemented (full description in `TESTING.md` §6r):

- **D1 scope.** One operator command, `npm run fixture:dev --workspace @acc/api` (`apps/api/src/cli/dev-fixture.ts`, `src/cli/dev-fixture/`), and one suite, `apps/api/test/dev-fixture.sec-spec.ts`. No API route, schema, migration, frontend or E2E change; `seed.ts` is unchanged. The only edit to existing code is exporting `ownerAuditWriter` from `bootstrap.ts`; no bootstrap behaviour or production safety rule changed.
- **D2 real paths.** Organizations, their default workspaces and system roles, the team, the users and every grant are created through the real HTTP API of an in-process `createApp()` instance, signed in as the bootstrap platform administrator through the real login. No principal, header, service path or production branch was added. Planning and verification are owner-level **reads** only.
- **D3 Reseller B** is the first owner-level exception: one guarded `INSERT INTO resellers`, never an update, unaudited because no reseller audit action exists.
- **Fixture-user activation — APPROVED (30-Sep-2026) as a development/test fixture-only owner exception.** Fixture users are created `invited` by `POST /users`, and D16 has not yet defined an application credential-establishment path for invited users. The fixture sets the credential with the unchanged `UserLifecycleService.activate` — the bootstrap CLI's primitive — for a row-locked, still-`invited`, credential-less `@acc-fixture.test` identity only: the code sets `password_hash`, `password_updated_at` and `status`; the existing `trg_users_updated_at` trigger additionally sets `updated_at` (F-2). No activation audit action exists. **This does not implement or decide D16**: no route, no user-facing activation, no delivery, no mail/token workflow, no production API change, no change to `UserLifecycleService`.
- **D4 secrets.** `ACC_FIXTURE_USER_PASSWORD_REF` (new) and the existing `AUTH_BOOTSTRAP_*` references, resolved through `EnvSecretsAdapter`; no default, no generated value, nothing printed or stored; the fixture password must differ from the operator's. The E2E helper is unchanged.
- **D5 idempotence.** Natural keys; any incompatible existing object aborts with nothing written; a complete fixture makes the run a no-op with no application boot, sign-in, session or audit row. A pinned logical fingerprint is database-independent.
- **D6 environment.** `APP_ENV` must be `development` or `test` (unset refused); `NODE_ENV=production` also refused (stricter than asked); no override of any kind. Decided before any connection or application module is loaded.
- **D7 audit.** The markup-bearing `team.created` row is written by `POST /teams`; nothing in the fixture writes `audit_logs` directly.
- **F-1 — bootstrap invocation: APPROVED, option (C) (30-Sep-2026).** The fixture keeps calling the unchanged `runBootstrap` when no platform administrator exists, so first-time setup stays one command. It is the existing ADR-003 D-1 owner exception (administrator creation/activation, the platform grant, two bootstrap audit rows), distinct from the two Phase 1C.4a fixture exceptions (Reseller B, fixture-user activation). The suite's write-set proof pins both groups: the fixture's own writes, its import closure, `runBootstrap`'s write set and the lifecycle primitives, with a runtime check of the bootstrap footprint.
- **F-3 — declared environment vs database: ACCEPTED as a documented residual (30-Sep-2026).** The gate validates `APP_ENV`/`NODE_ENV`, not the database URL's provenance; credential separation is an operational requirement (`SECURITY.md`, "Phase 1C.4a development/test fixture"). No database-side marker, migration or schema change.
- **Mutation proofs.** M6a (a byte-for-byte audit forgery) is intentionally a source/write-set proof, since database state cannot prove provenance against the owner; M6b is the runtime proof for the ordinary direct-insert bypass. The platform/reseller-scope invariant (M3) is asserted directly by natural key, independently of the run's outcome.

### 1C.4a closure — PASS / CLOSED

**Decision.** Gate C.4a PASS / CLOSED (user decision, 30-Sep-2026). Checkpoint commit `91607aa` on top of `f624846`; not pushed.

**Delivered.** `npm run fixture:dev --workspace @acc/api` — a deterministic, idempotent development/test fixture and bootstrap command — and `apps/api/test/dev-fixture.sec-spec.ts` (57 cases). Full description in `TESTING.md` §6r.

**Topology** (natural keys; five scopes unchanged, PLATFORM → RESELLER → ORGANIZATION → WORKSPACE → TEAM): Reseller A = the seeded `alendei-direct` → `acc-fixture-a1`, `acc-fixture-a2`; Reseller B = `acc-fixture-reseller-b` → `acc-fixture-b1`; a `default` workspace in each; team T (markup-bearing name) in A1's default workspace. Users: `a1-admin`, `a2-admin`, `b1-admin` (`org_admin` in their organization), `a1-team-reader` (`read_only` at team T), `multi-org` (`workspace_manager` in A1 and A2), all `@acc-fixture.test`. No fixture user holds platform or reseller scope.

**Command and environment boundary.** Runs only with `APP_ENV` `development` or `test` (unset refused); `NODE_ENV=production` refused; no override, confirmation or force flag; decided before any connection or application module is loaded. Passwords only through `SecretsPort` references (`AUTH_BOOTSTRAP_PASSWORD_REF`, new `ACC_FIXTURE_USER_PASSWORD_REF`); no default; never printed, logged or stored. No HTTP route; not imported by the application.

**Accepted owner-level exceptions.** *Existing bootstrap owner exception* (ADR-003 D-1, unchanged, only when no platform administrator exists): platform administrator creation and activation, the `alendei_super_admin` platform grant, two bootstrap audit records. *Phase 1C.4a fixture owner exceptions*: Reseller B creation (reseller CRUD is Phase 9); fixture-user activation through the unchanged `UserLifecycleService.activate` (the code sets `password_hash`, `password_updated_at`, `status`; `trg_users_updated_at` sets `updated_at`). Everything else — organizations, workspaces, system roles, the team, users, every fixture grant and every fixture audit row — goes through the real API. Pinned by a layered source write-set proof (fixture writes, import closure, `runBootstrap` and lifecycle write sets) and a runtime footprint check.

**Activation / D16 boundary.** Fixture-user activation is a development/test fixture-only exception required solely because D16 has not defined an application credential-establishment path. It does not implement or decide D16: no route, no user-facing activation, no delivery or mail/token workflow, no production API change, no change to `UserLifecycleService`; only `invited`, credential-less `@acc-fixture.test` identities; conflicts refused.

**Residual risk accepted (F-3).** The gate validates the declared `APP_ENV`/`NODE_ENV`, not the provenance of the database URL; an operator holding production owner credentials could point a process declaring development/test at a production database. This is an operational credential-management risk, not a fixture bypass of application authorization; separating credentials remains an operational requirement. No database marker, migration or schema change.

**Evidence.** Fixture suite 57/57; 15/15 mutants caught (M1, M2a, M2b, M3, M3b, M4a, M4b, M4c, M5, M6a static by design, M6b runtime and static, M7, M8a, M8b, M8c; the initial round was 11 mutants, earlier misreported as 12 and corrected); API integration + security 1,105/1,105; `packages/db` integration 136/136; unit 312/312; migration hashes 18/18; `openapi:check`, lint, typecheck and format clean. Every DB-touching run used a disposable `scripts/with-db-clone.mjs` clone, dropped afterwards; the canonical test database's full-content hash was identical before and after.

**Known limitations.** A byte-for-byte owner forgery is detectable only by the source write-set proof (`SECURITY.md` §4a); the RLS case constructs the `TenantSession` directly (ScopeResolver derivation is covered by the §6o suites); an interrupted run's completion is by construction, not simulated; each creating run leaves one revoked session row as a historical record, and a process killed between sign-in and sign-out may leave one live session until expiry; the full API regression still leaves 42 `users` rows from other suites (1C.3 residual 2).

**Gate status.** Phase 1C.4a is closed. **Phase 1C.4b is closed (PASS / CLOSED, checkpoint `4e7effd`).** Overall Phase 1C remains open: Gate C (`ROADMAP.md` §4d) is not passed.

### 1C.4b closure — PASS / CLOSED

**Decision.** Gate C.4b PASS / CLOSED (user decision, 01-Oct-2026). Checkpoint commit `4e7effd` on top of `617eea8`; not pushed.

**Delivered.** Browser E2E suite corrections in `apps/web/e2e` against the deterministic Phase 1C.4a fixture (`TESTING.md` §6p, §6r, §6s). All 12 browser E2E security proofs execute deterministically with zero skips, zero timeouts, and zero vacuous assertions.

**Scope & Files.** Strictly four frontend files modified:
- `apps/web/e2e/helpers/auth.ts`
- `apps/web/e2e/security-storage-payloads.spec.ts`
- `apps/web/e2e/tenancy-navigation.spec.ts`
- `apps/web/README.md`
No backend, database, schema, migration, API contract, RBAC, RLS, or infrastructure files changed.

**E2E Suite Evidence (12/12 passed, 0 skipped, 0 failed; 28.2s execution time).**
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

**Strengthened Exact-Secret Storage Proof (E2E-08).** `assertExactSecretNotInStorage(page, secret)` sweeps URL (pathname, search, hash), `localStorage` (keys and values), `sessionStorage` (keys and values), `document.cookie`, `window.history.state`, `IndexedDB` (database names, store names, record payloads), and `CacheStorage` (cache names, request URLs, response body text), searching for the exact extracted secret string both while the modal is open and after closing.

**Mutation Proofs (Explicitly Classified).**
- *Application-Behavior Mutations* (injecting real leaks/payloads and observing detector refusal):
  - **M1**: Injected dotted JWT into `localStorage` → caught by `assertNoTokensInStorage` (line 184).
  - **M2**: Injected `token_store` in `IndexedDB` → caught by `assertNoTokensInStorage` (line 208).
  - **M3**: Malicious script markup in audit payload → execution caught (`window.__accFixtureMarkup` set).
  - **M6a**: Exact secret string injected into `localStorage` → `assertExactSecretNotInStorage` caught `localStorage value for key "acc_leaked_secret_test"`.
  - **M6b**: Exact secret string injected into `sessionStorage` → `assertExactSecretNotInStorage` caught `sessionStorage value for key "acc_session_leak"`.
  - **M6c**: Exact secret string injected into `IndexedDB` → `assertExactSecretNotInStorage` caught `IndexedDB [acc_leak_test_db.secrets] record contains secret`.
- *Assertion-Liveness Mutations* (mutating expected results to verify assertion sensitivity):
  - **M4**: Mutated expected forged header status in E2E-10 from 403 to 200 → test runner caught mismatch.
  - **M5**: Mutated expected low-privilege audit API status in E2E-11 from 403 to 200 → test runner caught mismatch.

**Regression Evidence.**
- Frontend unit tests: 161/161 passed.
- Frontend security tests: 87/87 passed.
- Typecheck: 0 errors (`tsc --noEmit`).
- Production build: clean Next.js Turbopack build (all 15 routes).

**Gate status.** Phase 1C.4b is closed (PASS / CLOSED). **Overall Phase 1C remains open**: Gate C (`ROADMAP.md` §4d) is not passed. ADR-012 defines no further Phase 1C increment — what remains is the Gate C decision. D16 and reseller CRUD (Phase 9) remain deferred.

### Gate C readiness remediation (implemented 02-Oct-2026; Gate C APPROVED / CLOSED — see "Gate C closure")

A read-only Gate C audit (01-Oct-2026) found two §4d criteria failing — Observability (the two required metrics did not exist) and Regression (`npm run audit` failed; six rate-limit cases failed under a developer `.env`) — plus the logout-CSRF mutation unrecorded and nine historical mutations recorded by count only. Authorized remediation, evidence in `TESTING.md` §6t:

- **Technical checkpoint `c640e82`.** `acc_organization_status_refusals_total{status, operation}` and `acc_session_cap_evictions_total`; `next` 16.3.6, `@grpc/grpc-js` 1.14.5, `brace-expansion` patch releases; test-only pinning of the documented `RATE_LIMIT_*` defaults in `apps/api/test/setup-env.ts`. No schema, migration, OpenAPI artifact, RBAC/RLS or frontend source change.
- **Refusal-counter design (for acceptance).** Counted once per refused request at the response boundary (`AllExceptionsFilter`), attributed by the four genuine sources through `logContext.refusedOrganizationStatus`, rather than incremented at each of the ~14 throw sites, several of which are dependency-free functions. The filter itself contains no status literals and no new imports — see the enum-order residual below.
- **Dependency gate `4fb752e`.** `scripts/audit-check.mjs` accepts an exception by advisory id, not by package; the `multer` exception lists its five reviewed advisories and expires 31-Oct-2026 (shortened from 31-Dec-2026) because a fix exists — `@nestjs/platform-express` ≥ 11.2.6 pins `multer` 2.4.0, within the declared `^11.2.3`. The upgrade is not applied (not authorized); `SECURITY.md`, "Dependency exceptions".
- **Approved 1C.2 test change, recorded.** `audit-writer.spec.ts` "shares no action between the acc_auth vocabulary and the sensitive set" was replaced in `19085bb` by "overlaps the acc_auth vocabulary and the sensitive set in exactly the two approved session actions", because the approved 1C.2 audit-routing correction (Option A, migration `0013`) admits `session.revoked`/`session.revoked_all` to the `acc_auth` vocabulary. The new assertion is exact, not weaker.
- **Mutation evidence.** All eleven §4d mutations executed and caught, with failing test names (`TESTING.md` §6t).
- **Residuals proposed for acceptance.** (1) OpenAPI metadata enum order: the committed plugin metadata orders enum values by TypeScript literal-creation order, so innocuous early-loaded code can reorder an enum and fail `openapi:check` without a contract change (fails closed). (2) The response-boundary counter relies on sources setting `refusedOrganizationStatus`. (3) `AuthorizationCoverageInterceptor` runs after the handler, so a missing authorization check is answered `500` but a committed write may not be rolled back (observed in mutants M02/M03) — **remediated**, see "Gate C closure". (4) The `multer` exception until the `@nestjs/platform-express` upgrade.

### Gate C closure — APPROVED / CLOSED

**Decision.** Gate C (`ROADMAP.md` §4d) **APPROVED / CLOSED** (user decision, 02-Oct-2026). **Phase 1 — Foundation is complete.** Phase 2 is authorized to begin after its read-only scope audit; no Phase 2 implementation is authorized by this record.

- **M02/M03 containment remediation (checkpoint `d16d46f`).** The M02/M03 investigation confirmed that a missing service-level authorization check let the mutation commit — organization, roles, default workspace and success audit rows persisted behind the interceptor's `500`. `AuthorizationCoverageInterceptor` now publishes the route's declared permission into the request context before the handler runs, and `TenantDatabase.withTenant` runs `assertCoverageBeforeCommit` as the last step inside the transaction: a transaction that wrote (`pg_current_xact_id_if_assigned()` non-null) without the declared permission having been checked throws and rolls back. Reads are unaffected. The single exemption is the `authorization.denied` record transaction (`DENIAL_RECORD`), pinned to `AuthorizationService.recordDenial` by `coverage-exemption.spec.ts`. The service-level `AuthorizationService.assert` checks are unchanged and remain the authorization decision; the pre-commit check is containment (`RBAC.md` §2a). Under the M02 and M03 mutations, the same requests now leave zero business rows and zero success audit rows, and a wire-level trace shows `begin` → writes → coverage probe → `rollback`, with no `commit` (`TESTING.md` §6t).
- **Coverage-boundary audit.** All **26** current mutating `@RequiresPermission` routes write only inside the covered `TenantDatabase.withTenant` transaction (`withRequestTenant` delegates to it); no current route performs any part of its mutation on a secondary connection. `POST /organizations/:id/reactivate` is proven on its own terms (`organization-reactivate-containment.sec-spec.ts`), including containment of the actual reactivate write.
- **Regression.** **1,577/1,577** (`packages/db` unit 4 + integration 136; `apps/api` unit 316 + integration 124 + security 997), **no skipped tests**; lint, typecheck, build and `openapi:check` pass; canonical test-database hash unchanged.
- **Residuals carried forward (recorded, not closed).** The route → `withTenant` link is a convention established by audit, not a structural guarantee — a future mutation writing through the `acc_auth` connection or a new connection would get only post-commit detection; `DENIAL_RECORD` remains an exemption by design (statically pinned); authentication-guard bookkeeping writes (`sessions.last_used_at`, API-key `last_used_at` and its audit row) commit before the handler and are outside coverage; containment is not authorization (a check at the wrong target satisfies coverage); a detected coverage failure still answers a generic `500`. Residuals (1), (2) and (4) of the readiness remediation stand as recorded above.

### Explicitly out of scope

Credential delivery/invitations (OD-9, D16), WebSocket gateway/consumption/subscriptions (OD-11, D15), providers and provider health (Phase 2), outbox/event consumers/SIEM (attributed to Phase 2 here; re-scheduled by ADR-013 PD-1 — not Phase 2 scope), delivery state (Phase 3+), routing/fallback (Phases 5–6), billing (Phase 7), reseller lifecycle/CRUD and white-label (Phase 9, OD-2), deployment artifacts (OD-10), workspace/team-level RLS (ADR-011 D-4), physical data deletion or retention automation (OD-12), MFA, password reset, lockout, SSO/OAuth2, API-key rotation, ABAC, scope-set caching.

### Consequences

- `FRONTEND_API_CONTRACT.md` §31 is the authoritative field-level contract for every Phase 1C endpoint; `API.md` §3g indexes it. 1C.3's generated OpenAPI must agree with it, and a disagreement is a defect in whichever is wrong, resolved before Gemini implements.
- ADR-011 D-8's "Deferred (Phase 1C)" rows are now scheduled: organization status (1C.1a), session cap (1C.2), OpenAPI drift (1C.3), E2E fixtures (1C.4a); the composite FKs and `allowed_scope_types` DB enforcement move from *accepted residual* to *IN PHASE 1C* (1C.6); logout after expiry moves from *accepted residual* to *IN PHASE 1C* (1C.2).
- Gate C is defined in `ROADMAP.md` §4d; the lifecycle model in `TENANCY.md` §1c; the authority rules in `RBAC.md` §4b; the planned schema in `DATABASE.md` §2; the security targets in `SECURITY.md` §4 ("Phase 1C security controls"); the test plan in `TESTING.md` §6q.

## 1m. ADR-013 — Phase 2 scope freeze: provider and channel foundation

**Status:** accepted (scope freeze, user decision, 02-Oct-2026). **No Phase 2 implementation exists at the time of this ADR** — everything marked *IN PHASE 2* is a commitment, not a description of code. No migration, permission row, runtime code or frontend code is created by this freeze. Base: Gate C closure `5b56ca6` (`origin/develop`).

### Context

`ROADMAP.md` §5 states Phase 2's objective but no increments, no gate and no ADR. A read-only reconciliation (02-Oct-2026) found that other canonical text also attributes work to "Phase 2" (the transactional outbox, event consumers, SIEM export, the worker/job tenant-context harness), that the frozen provider-credential contract contradicts the provider-credential schema, that most of the simulator behaviour matrix depends on a message lifecycle Phase 2 does not build, and that several §5 items (routing changes, canary, rollback, cost estimation, "Dev + Staging" deployment, a live dashboard) belong to later phases or tracks. This ADR records the user's decisions on each and partitions the objective.

**Objective (unchanged, `ROADMAP.md` §5):** *implement `provider-registry`, `provider-adapters` (interface + `SimulatorAdapter` only), health/circuit breaker mechanics, admin hot-reload plumbing.*

### Scope

| Increment | Content | Gate |
|---|---|---|
| **2.0** | This ADR and the documentation freeze | — |
| **2.1** | Channel & Provider Registry: `channels`, `providers`, `provider_capabilities`; platform-only read and administration (create, update, capabilities, enable, disable, drain); `providers.read`/`providers.manage` | D.1 |
| **2.2** | Adapter Contract & Simulator: the `ProviderAdapter` contract, the code-level adapter registry, `SimulatorAdapter` with the seven submission-time behaviours, direct test-send (`providers.test_send`) | D.2 |
| **2.3** | Health & Circuit Breaker: `provider_health` samples, the health state machine, the circuit breaker, a deterministic synthetic probe, manual health override, bounded metrics and a provisioned Grafana dashboard | D.3 |
| **2.4** | Hot Reload: **best-effort configuration invalidation with bounded convergence** — not transactional configuration propagation: an in-process registry/adapter cache, invalidated by Redis pub/sub published after commit, with a bounded TTL for eventual refresh; proven across two application instances with no restart, for both immediate propagation and TTL convergence | D.4 |
| **2.5** | Credential Reference Contract — **documentation only**: future credential-reference requirements, security invariants, the unresolved ownership model and the future `SecretsPort` boundary. **No runtime port, type, interface, resolution code, table, persistence, management or ownership semantics** | D.5 |
| **2.6** | Frontend console (provider list/detail, basic admin actions, polling) — **separately authorized and gated**, after the 2.1–2.4 backend contract is stable | D.6 |

**Execution order:** 2.0 → 2.1 → 2.2 → 2.3 → 2.4. 2.5 may proceed alongside 2.2 (it is documentation only). Backend implementation then stops and the contract is handed to the frontend track; 2.6 is authorized separately. Each increment requires its own authorization.

### Recorded decisions (PD-1 … PD-9)

| # | Decision | Status |
|---|---|---|
| PD-1 | The **transactional outbox** and the **worker/job tenant-context harness** are **not** Phase 2 scope; **SIEM export** is explicitly deferred. They are not pulled in merely because later provider health/event architecture depends on them. Phase 2 uses existing infrastructure only where it already exists (PostgreSQL, Redis, `/metrics`, Prometheus/Grafana in Compose). Consequently **no domain event is published in Phase 2** — `alendei.providers.health_changed.v1` and `alendei.providers.circuit_state_changed.v1` remain designed, not emitted; every Phase 2 transition is recorded in `audit_logs` instead. ADR-004 D-5 (harness deferred) stands, now deferred past Phase 2 | **APPROVED** |
| PD-2 | **`provider_credentials` is not built in Phase 2.** Credential ownership, persistence and management are deferred to the channel/provider implementation phase in which the ownership and secret-reference model can be frozen correctly (the first real channel phase). The conflicting texts are reconciled below (F-1) **without** a hybrid model. Phase 2 may **document** the future credential-reference requirements only (2.5); *amended at the freeze review, 02-Oct-2026:* no runtime port, type or interface is defined, because any such shape would pre-empt the unresolved ownership model. **Credential architecture requires a separate reviewed decision (its own ADR) before any implementation** | **APPROVED** |
| PD-3 | **Simulator scope is submission-time only:** `SUCCESS`, `TIMEOUT`, `500`, `429`, `INVALID_CREDENTIALS`, `INVALID_REQUEST`, `SLOW_RESPONSE`, exercised through a direct provider test-send that requires no `messages`, `message_attempts` or `webhook_events`. `DELIVERY_DELAY`, `DUPLICATE_WEBHOOK`, `OUT_OF_ORDER_WEBHOOK`, `DELIVERY_FAILURE`'s webhook and every other message-lifecycle behaviour are **Phase 3** | **APPROVED** |
| PD-4 | The **health state machine and circuit breaker** mechanisms, and a deterministic synthetic/test harness, are built in Phase 2. **No provider-router integration and no routing-policy functionality**; routing/failover integration is the later routing phase. Phase 2 health samples are produced **only** by explicit admin/test actions and deterministic simulator/probe inputs (F-6) | **APPROVED** |
| PD-5 | Provider/channel catalogue access is **platform scope only**. Initial permissions: `providers.read`, `providers.manage`, `providers.test_send`. Only authorized platform administrators administer these resources. No organization, workspace or team provider administration in Phase 2. The global-catalogue RLS posture is specified explicitly (F-3), not assumed from tenant RLS | **APPROVED** |
| PD-6 | **Excluded from Phase 2:** routing weights/priorities, routing-policy assignment, canary migration, rollback, provider routing, failover orchestration, billing and `estimateCost()` implementation, reseller provider administration, white-label provider administration. Where the adapter interface requires a member, only a minimal interface-level stub/contract with no Phase 2 behaviour is retained | **APPROVED** |
| PD-7 | For Phase 2 acceptance, "Dev + Staging" means **local Docker Compose execution** and **disposable-clone CI/integration testing**. No deployment-artifact, Kubernetes or private-cloud work enters Phase 2 (`DEPLOYMENT.md` §0h stays a separate track) | **APPROVED** |
| PD-8 | Phase 2 health visibility is **Prometheus/Grafana health and circuit metrics** plus **console polling** where required. No live WebSocket dashboard (D15 stays deferred) | **APPROVED** |
| PD-9 | Stale and contradictory documentation is corrected in this freeze (F-8), and **Gate D** is defined as the Phase 2 acceptance gate (`ROADMAP.md` §5c) | **APPROVED** |

### Freeze details (decisions made in this ADR to make the approved decisions implementable — reviewable)

Each is the narrowest reading consistent with PD-1 … PD-9 and the existing schema; any can be revised before its increment starts.

- **F-1 — Credential models reconciled, not merged.** Two incompatible texts existed. **(A)** `DEPLOYMENT.md` §0f / `SECURITY.md` §3a (ADR-009 D-4): a *tenant-scoped* table with a scope within the five-level hierarchy and `org_id` for RLS. **(B)** `DATABASE.md` §3 / `PROVIDER_ADAPTER.md` §4a: a *configuration* scope `platform | reseller | organization` (never workspace or team), `scope_id` NULL for platform, most-specific-wins precedence. They cannot both hold: B's platform- and reseller-owned rows have no `org_id`, so A's "`org_id` for RLS" cannot apply to them, and A's five-level scope admits workspace/team ownership that B forbids. **Neither is adopted; no hybrid is defined.** Both are re-marked **NOT FROZEN — to be decided by the channel-phase ADR that builds `provider_credentials`**. What both already agree on is binding now and recorded by 2.5 as documentation (no code): the value is a `<backend>:<locator>` reference resolved through `SecretsPort`; the secret never enters PostgreSQL, logs, metrics, audit rows, API responses or the frontend; Alendei-, reseller- and organization-owned credentials must be able to coexist in one shared deployment.
- **F-2 — Channels are a seeded, read-only catalogue in Phase 2.** `channels` rows (`whatsapp`, `rcs`, `sms`, `email`, `voice`) are created by the 2.1 migration; Phase 2 exposes `GET /channels` and `GET /channels/:id` only. Changing the channel catalogue is a migration, not an API operation.
- **F-3 — Global-catalogue authorization and RLS posture** *(revised at the freeze review, 02-Oct-2026)*. `channels`, `providers`, `provider_capabilities` and `provider_health` hold **no tenant data and no tenant column** (`org_id`, `reseller_id`, `workspace_id` are absent by design). Tenant RLS — which filters rows by the request's tenant context — has nothing to filter on and would be either vacuous or wrong, so it is not applied. The security model is layered, and **no layer depends on a role name**:

  1. **Authenticated principal** — `AuthGuard`, unchanged.
  2. **Validated permission** — `AuthorizationService.assert` requires `providers.read`, `providers.manage` or `providers.test_send`, evaluated from the principal's current grants (ADR-005); every route declares it with `@RequiresPermission`.
  3. **Platform-scope authorization** — the assertion's target is `{ scopeType: 'platform', scopeId: null }`, inside the request's `TenantDatabase.withTenant` transaction, which also gives the Gate C pre-commit coverage containment.
  4. **RLS predicate — platform-scope eligibility.** RLS is enabled in the creating migration, as for every table (`DATABASE.md` §1). The `acc_app` policies admit a transaction only when it carries a **validated platform-scope claim**: the current user holds at least one active `platform`-scope grant, validated against current grants at query time as ADR-011's claims are. The predicate names **no role and no permission**. A transaction without such a claim sees zero rows and cannot write, even if a handler forgets its check.

  **RLS enforces platform-scope eligibility; `AuthorizationService` enforces the permission.** *(Refined by the Gate D.1 remediation, migration `0019`: writes and their audit records additionally require the permission at the database — `app_has_platform_permission('providers.manage')`, still naming no role; reads are unchanged. See "2.1 implementation notes" (a)–(b).)* The existing `app_is_platform_admin()` is **not** the catalogue predicate: it is bound to the role key `alendei_super_admin` (migration `0010`, ADR-011's single "platform administrator" definition, which keeps its existing uses), and adopting it would make a role name the RLS boundary. Increment 2.1 therefore introduces a reviewed, role-name-independent platform-scope eligibility primitive (and whatever tenant-context plumbing carries the claim), subject to the SECURITY DEFINER ACL rules of 1C.6 and the 2.1 review. `acc_auth` and `acc_relay` receive **no grant**; `channels` is `SELECT`-only for `acc_app`; `provider_health` is `SELECT, INSERT` only, with an append-only trigger as `audit_logs` has; each table is classified in `principals.int-spec.ts` with exact grants.

  **Grants and explicit Phase 2 denials.** The three permissions are currently attached **only** to the seeded `alendei_super_admin` role (F-4) — a fact about today's grants, not the architectural boundary. Denied in Phase 2: **`alendei_support`** holds a platform-scope grant, so it is RLS-eligible, but holds no `providers.*` permission and is refused by `AuthorizationService` (audited `403`), with the pre-commit containment behind it — the separation between platform principals is the permission layer by design; **API keys** are organization-bound, never platform-scoped, so they are refused by authorization and are RLS-ineligible; **`acc_auth` and `acc_relay`** hold no grant. No support-role permission is added. A future privileged role is introduced through the normal RBAC path (a platform role definition and its permission attachment by migration, D22) **without redesigning the RLS policy**.
- **F-4 — Permissions and audit.** `providers.read`, `providers.manage`, `providers.test_send` are added by the 2.1 migration (`test_send` may land with 2.2) to the permission catalogue and attached to the seeded `alendei_super_admin` role only — platform roles stay immutable through the API (D22). That attachment is the only place the role name appears; authorization and RLS are expressed in permissions and platform scope (F-3). Every mutation is **security-sensitive** (it can redirect real traffic once routing exists) and writes its `audit_logs` row in the same transaction at scope `platform`: `provider.created`, `provider.updated`, `provider.capabilities_replaced`, `provider.enabled`, `provider.disabled`, `provider.drained`, `provider.test_sent`, `provider.health_checked`, `provider.health_changed`, `provider.health_overridden`, `provider.circuit_changed`. Before/after values are recorded; no credential material, simulator payload body or secret reference value is recorded.
- **F-5 — Administrative status versus observed health (resolves the `draining` duplication).** `DATABASE.md` §3 carried `draining` in both `providers.status` and `providers.health_state`, and `PROVIDER_ADAPTER.md` §5 listed `DRAINING` as a health state while §4 described draining as `health_state → DRAINING`. Resolved: **`draining` is an administrative status only.** `providers.status ∈ {active, disabled, draining}` is set by `providers.manage`; `providers.health_state ∈ {healthy, degraded, critical, offline}` is observed (or manually overridden, F-6); `providers.circuit_state ∈ {closed, open, half_open}` is computed. The three are independent columns; future routing eligibility is their conjunction (later phase). Legal status transitions: `active → disabled | draining`, `draining → disabled | active`, `disabled → active`; anything else is `409` and changes nothing. No `DELETE` route (history and audit references are retained).
- **F-6 — What produces health samples in Phase 2.** Only: (a) the outcome of an explicit `POST /providers/:id/test-send` (`providers.test_send`); (b) an explicit `POST /providers/:id/health-check`, which runs the adapter's `healthCheck()` against the simulator (`providers.manage`); (c) an explicit manual override `POST /providers/:id/health` (`providers.manage`, `source = manual`). There is **no scheduler, no background prober and no worker** (PD-1). Each sample is a `provider_health` row written in the same request transaction as its audit row. Thresholds (error-rate and latency windows, minimum sample size, cooldown) are fixed platform defaults in configuration in Phase 2; per-provider threshold administration is not in Phase 2.
- **F-7 — Deterministic circuit breaker.** Transitions are computed from the recorded samples and an **injectable clock**: `CLOSED → OPEN` when the rolling error/timeout rate over the window meets the threshold at or above the minimum sample size; `OPEN → HALF_OPEN` evaluated lazily when the cooldown has elapsed on the injected clock (no timer); `HALF_OPEN → CLOSED` on the configured number of successful probes, `HALF_OPEN → OPEN` on a failure. While `OPEN`, a test-send short-circuits without calling the adapter (recorded as such) — the only Phase 2 "consumer" of breaker state; the router's use of it is a later phase.
- **F-8 — Documentation reconciliation in this freeze.** `PROVIDER_ADAPTER.md` §2 "exact types finalized in Phase 1" (they were not; finalized in 2.2); `DATABASE.md` §3 citing `PROVIDER_ADAPTER.md` §8 for credential ownership (it is §4a, and now F-1); the `draining` duplication (F-5); `RUNBOOK.md` §2 and §7 placeholders (marked with what is and is not operable in Phase 2); `EVENTS.md` provider events (designed, not emitted in Phase 2); `DEPLOYMENT.md` §0f "when the channel phases build it" versus `ROADMAP.md` §5's credential storage (resolved by PD-2); `RUNBOOK.md` §1 "CI deploys to Dev automatically" (no deployable artifact exists; PD-7); `API.md` §2 `/providers` "capability config" (2.1) and the routing/priority admin operations of `PROVIDER_ADAPTER.md` §4 (PD-6); `ROUTING_ENGINE.md` provider-eligibility rule 5 and the `ARCHITECTURE.md` glossary listing `DRAINING` as a health state (aligned to F-5); the ADR-012 out-of-scope list and `SECURITY.md` §4 attributing the outbox/SIEM to Phase 2 (annotated per PD-1).
- **F-9 — Adapter-key binding.** `providers.adapter_key` names an adapter implementation registered in code; in Phase 2 the registry contains exactly one key, `simulator`. An unknown key is refused (`422`) at create/update; adapter selection never branches on vendor names.

### Explicitly out of scope

The transactional outbox, event consumers and any domain-event publication; the worker/job tenant-context harness; SIEM export; `provider_credentials` and any real credential; real vendor adapters (WhatsApp, SMS, RCS, email, voice); `messages`, `message_attempts`, `webhook_events` and every delivery/webhook behaviour; provider routing, routing policies, weights/priorities, canary migration, rollback; failover orchestration; billing and `estimateCost()` behaviour; reseller and white-label provider administration; organization/workspace/team provider access; the WebSocket gateway and live dashboards; deployment artifacts, Kubernetes and private-cloud work; inbox/conversations, journeys, AI Gateway.

### Consequences

- `ROADMAP.md` §5 carries the increment table (§5a), the per-increment specification (§5b) and Gate D (§5c); `TESTING.md` §6u the test plan; `SECURITY.md` §3b the Phase 2 security controls; `DATABASE.md` §3 the per-table status.
- `ROADMAP.md` §6 (Phase 3) inherits: the full simulator matrix, `provider_credentials` and its ADR (F-1), and — if Phase 3's consumers need them — the outbox and worker harness.
- **2.1 implementation notes (03-Oct-2026; remediated at the Gate D.1 review; Gate D.1 APPROVED and CLOSED, pushed at `c2c0631`).** Migrations `0018` and `0019`; `apps/api/src/providers/`; evidence `TESTING.md` §6u. Implementation decisions, each reviewable:
  - (a) **One eligibility model, two predicates, no role name.** Catalogue *reads* require `app_has_platform_scope()` — an active user holding any platform-scope grant, validated against current grants (`0018`). Catalogue *writes* and their audit records require `app_has_platform_permission('providers.manage')` — an active user holding a platform-scope grant **whose role carries `providers.manage`** (`0019`): the same predicate the application enforces through `AuthorizationService`, now also enforced by the database. Neither consults a role key or the `app.is_platform_admin` flag. This refines F-3 (which had RLS gate writes on platform scope alone): a platform-scope principal without the permission (`alendei_support`) can read nothing it is not authorized to read through the API, and can write nothing even with the service bypassed.
  - (b) **Provider audit rows use the same predicate.** `audit_logs_provider_insert` (`0019`) admits exactly a provider mutation's success row — `platform` scope, the current user as actor, one of the six `provider.*` actions, `resource_type = 'Provider'` — for a user satisfying `app_has_platform_permission('providers.manage')`. `audit_logs_insert`, `audit_logs_select`, `audit_logs_auth_insert` and the audit triggers are unchanged. This removes the Gate D.1 blocker: a second platform role holding `providers.manage` now performs every write and its audit row is inserted (proven), where previously the write failed closed at `audit_logs_insert`'s `app_is_platform_admin()` check.
  - (c) **`POST /providers` is naturally idempotent, not keyed — an explicit decision (option B of the Gate D.1 review).** The canonical mechanism (ADR-006) stores its record in an organization's namespace: `idempotency_keys.org_id` is `NOT NULL` and its RLS is by organization. The catalogue has no organization; giving it one would change a Phase 1 table, its RLS and its proofs, and no new mechanism is introduced. The provider's natural key (one name per channel, case-insensitive) already makes a second side effect impossible, which is `API.md` §4a's criterion for keyed idempotency. Retry semantics: a repeated or concurrent duplicate create changes nothing and answers `409 RESOURCE_CONFLICT` with `details.providerId` naming the provider that exists, so a client retrying after a timeout can recognize and fetch what it created; `Idempotency-Key`, if sent, is not consumed. `INSERT … ON CONFLICT DO NOTHING` keeps the answer exact under concurrency (proven).
  - (d) **Refusals converge on the ordinary denial audit.** `AuthorizationService.actorScope` now files a refusal at `platform` for any principal holding a platform-scope grant (where it previously threw), and `audit_logs_platform_self_denial_insert` (`0019`) admits exactly that principal's own `authorization.denied` row at platform scope (actor = current user, outcome `denied`, `app_has_platform_scope()`). `alendei_support` without `X-Acc-Organization` is therefore refused with an audited `403`. The only remaining unaudited refusal is a principal with **no** organization in context, **no** reseller grant and **no** platform-scope grant (for example a member of several organizations calling without `X-Acc-Organization`): there is no scope its refusal could be filed under (ADR-005 D-6 files a denial at the actor's own scope), it cannot hold a platform permission (platform coverage requires a platform-scope grant), and the path also asks the non-auditing `allows`, so it can only refuse. It answers `403`, logged at `warn` with the correlation id; naming an organization makes the same refusal audited (proven).
  - (e) **A provider is created `disabled`**, so it carries no traffic until enabled. (f) Routes use `@OptionalTenantContext`: a selected organization only attributes a refusal; it is never a target and never widens anything. (g) A capability value is any JSON (`anyOf` the JSON types in OpenAPI 3.0, `null` admitted through the object member); capability keys naming secret material are refused.
  - (h) **Residuals.** `providers.*` are not in the `platform.` domain, so a super administrator can compose them into a tenant role or request them as API-key scopes; neither confers access (the decision is at platform scope and the RLS requires a platform grant; both proven). The unattributable refusal in (d) is logged, not audited.
- **2.2 implementation notes (03-Oct-2026; Gate D.2 pending review).** Migration `0020`; `packages/contracts/src/provider-adapter.ts`; `apps/api/src/provider-adapters/`; `POST /providers/:id/test-send`; evidence `TESTING.md` §6u. Implementation decisions, each reviewable:
  - (a) **The port** (`ProviderAdapter`) carries a provider *configuration reference* (`ProviderAdapterContext`: id, adapter key, channel, declared capabilities) and never a credential; a normalized `ProviderSubmission` (`submissionId` assigned by ACC per attempt — the future provider idempotency key — and `correlationId`); and answers `accepted` (with `providerMessageId`) or `rejected` (with a `ProviderFailure`), both with `latencyMs`. No vendor or SDK type appears; the same port serves every channel. `estimateCost`, `checkStatus` and `parseWebhook` are members that reject with `ProviderAdapterUnsupportedOperation` (ADR-013 PD-6).
  - (b) **Failure taxonomy.** `PROVIDER_FAILURE_CATEGORIES` extends `PROVIDER_ADAPTER.md` §2's list with `INVALID_REQUEST` and `CONFIGURATION_ERROR`; `retryable` is fixed per category and recomputed by the executor, never taken from an adapter. An **unknown adapter** is deliberately *not* a failure category: it is a resolution failure refused before any adapter runs (`422 PROVIDER_ADAPTER_UNKNOWN`), so no submission is attempted and nothing is recorded.
  - (c) **Execution.** `ProviderSubmissionExecutor` enforces one platform timeout (3000 ms, `PROVIDER_SUBMISSION_DEFAULTS`; fixed per ADR-013 F-6) by aborting the adapter's wait, maps a thrown error or an out-of-contract result to `UNKNOWN`, stamps ids and latency, and counts every submission. Time is an injected `SubmissionTimer`, so unit tests drive a virtual clock with no wall-clock sleeps; over HTTP the real timer is used and `TIMEOUT` therefore takes the full 3000 ms.
  - (d) **Behaviour selection** is a simulator concern, kept out of the generic port: `SimulatorAdapter.forBehavior(behavior)` returns a `ProviderAdapter` view. The API accepts a behaviour only for a simulator provider (`422` otherwise — unreachable in Phase 2, which registers only `simulator`).
  - (e) **Registry.** Built once from code; a duplicate key or a registered set that disagrees with `PROVIDER_ADAPTER_KEYS` fails application start; `resolve` is exact-match and fails closed.
  - (f) **Test-send flow and its audit outcome** *(revised at the Gate D.2 review)*. Authorization, the provider and its state are checked in one transaction; the submission runs outside any transaction (no connection held across a 3-second wait); a second transaction re-checks authorization and writes `provider.test_sent`. A simulated rejection is a `200` with `outcome: "rejected"`. The audit row uses the trail's established outcome semantics — `success`: authorized and achieved its purpose; `failure`: authorized and attempted but did not (as `auth.login.failed`); `denied`: refused by authorization before it ran (written only by `AuthorizationService`). A test-send's purpose is an accepted submission, so `SUCCESS` and `SLOW_RESPONSE` audit `success`, and `500`, `429`, `TIMEOUT`, `INVALID_CREDENTIALS`, `INVALID_REQUEST` (and any adapter error) audit `failure`. The first submission recorded `success` for every answer; migration `0021` widens `audit_logs_provider_test_send_insert` (`0020`, not edited) to admit exactly `success` or `failure`.
  - (h) **The two-transaction boundary (accepted, simulator-only TOCTOU).** The submission is authorized by the first transaction and runs on the authority the request held when it started; a change made while it is in flight cannot stop it. What the second transaction guarantees: no `provider.test_sent` row is ever written for an actor who does not hold `providers.test_send` at platform scope **at the moment of the write**, and the row's actor is always the requesting user. `AuthorizationService.assert` evaluates the request's grant snapshot, so the second transaction also reads the actor's authority fresh from the database (`app_has_platform_permission('providers.test_send')`, the predicate the RLS policy itself applies): a grant revoked or a user disabled mid-flight ends the request with `403`, no audit row and a `warn` log — the submission ran, its result is neither returned nor recorded, and it is counted in `acc_provider_submissions_total`. A provider disabled or drained mid-flight does not change authority: the test that ran is recorded truthfully and the next one is refused (`409`). Proven by `provider-test-send.sec-spec.ts` §F, which injects each change between the transactions. With the simulator this is an accepted residual; before a real provider is connected (no cost or recipient exists today) it must be revisited.
  - (g) **Observability.** The frozen 2.3 wording named a test-send counter; 2.2 counts at the adapter boundary instead — `acc_provider_submissions_total{channel, outcome}` — so a submission is counted wherever it originates (today only test-send). One structured log line per test-send; no recipient, content or credential is logged.
- **2.3 design (frozen 03-Oct-2026, before any 2.3 code was written).** The state machines, transition table, failure classification, window/threshold/cooldown semantics, concurrency strategy and lifecycle-versus-circuit precedence are canonical in `PROVIDER_ADAPTER.md` §5–§6 and are implemented exactly as written there. The authorization and database decisions that make them implementable:
  - (a) **Who may write observation state.** Test-send produces samples and moves the circuit, so a `providers.test_send` holder must be able to write them; `providers.manage` remains the only authority over administrative columns. Migration `0022` adds one permissive `UPDATE` policy on `providers` for `app_has_platform_permission('providers.test_send')`, and a `SECURITY INVOKER` guard trigger (`fn_providers_state_guard`) that refuses any change to `channel_id`, `name`, `adapter_key`, `status` or `health_override` by a principal without `providers.manage`, and any `circuit_state` change that is not one of the four edges with the generation exactly +1. The existing `providers.manage` policies are unchanged. **No new SECURITY DEFINER function**: the policies and the trigger reuse `app_has_platform_scope()` (`0018`), `app_has_platform_permission(text)` (`0019`) and `app_session_bypasses_rls()`.
  - (b) **`provider_health`** — global catalogue posture (F-3): no tenant column; RLS `SELECT` on `app_has_platform_scope()`; `INSERT` only of a `submission` sample by a `providers.test_send` holder, or of a `probe`/`override` sample by a `providers.manage` holder; `SELECT, INSERT` granted to `acc_app` only; nothing to `acc_auth`/`acc_relay`; an append-only trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`.
  - (c) **Audit** — one additional exact-shape `INSERT` policy, `audit_logs_provider_health_insert`: platform scope, the current user as actor, `resource_type = 'Provider'`, and `provider.health_checked` (`success`/`failure`) or `provider.health_overridden` (`success`) for `providers.manage`; `provider.health_changed` (`success`) for `providers.manage` or `providers.test_send`; `provider.circuit_changed` (`success`) for `providers.test_send`. A circuit refusal is a `provider.test_sent` row with outcome `failure`, already admitted by `0021`.
  - (d) **API** (ROADMAP §5b 2.3): `POST /providers/:id/health-check` (`providers.manage`), `POST /providers/:id/health` (`providers.manage`), `GET /providers/:id/health` (`providers.read`, the samples newest first, keyset-paginated); the provider resource gains `healthOverride`, `healthChangedAt`, `circuitChangedAt`, `circuitCooldownUntil`; a test-send answer gains `healthState`, `circuitState` and `circuitProbe`; a circuit refusal is `409 PROVIDER_CIRCUIT_OPEN`. No route changes a circuit directly.
  - (e) **Not in 2.3:** manual circuit control, per-provider thresholds, any scheduler/prober, routing use of health or circuit, event publication, hot reload (2.4).
- Residuals accepted by this freeze: (1) 2.4 is **best-effort configuration invalidation with bounded convergence** — not transactional configuration propagation: the update commits first, invalidation is published after commit, a subscriber refreshes as soon as it receives the publication, and if a publication is lost the TTL bounds how long a stale entry can be served; outbox-backed transactional event propagation remains deferred (PD-1); (2) with no events, provider transitions are observable through `audit_logs` and metrics only; (3) RLS does not distinguish among validated platform-scope principals; within that set, the boundary is the permission layer (`AuthorizationService` plus pre-commit containment) — so `alendei_support` is RLS-eligible and denied by authorization in Phase 2 (F-3).

## 3. Risks explicitly accepted by design (not oversights)

**Rate limits are deployment-wide, with no per-tenant override (Phase 1B.6.4, ADR-010 D-4).** Every tenant on a deployment shares one ceiling. A noisy tenant is bounded — it cannot exhaust another tenant's bucket, since organization is part of the key — but it cannot be throttled or exempted individually either, and a customer cannot be sold a larger allowance without raising it for everyone on that deployment. Accepted because per-tenant limits need a plan or entitlement model that belongs with billing, and because the isolation property that actually protects tenants from each other is already in place. Revisit when plan storage exists.


**Three items deferred from Phase 1B.6.3, recorded rather than silently carried.** Each was found during the audit-read phase and each is genuinely future work; none is a live defect today.

- **RESOLVED (ADR-011) — `app_current_reseller_id()` was broader than every policy arm intends.** It was derived from the selected organization's reseller for every principal. The Gate-B audit showed the consequence was not confined to audit rows: `app_org_in_scope()` made every sibling organization under the same reseller visible on every tenant table. Fixed in the resolver and, independently, in the database (migration `0010`).
- **The audit redactor's key list is narrower than the logger's.** `audit-redactor.ts` covers `password`, `password_hash`, `key_hash`, `refresh_token_hash`, `mfa_secret_ref`, `ticket_hash` and `/secret|token/i`; the pino configuration additionally covers `apiKey`, `api_key` and `credential`. No caller writes a secret under the keys only the logger covers — Phase 1B.6.2's structural test asserts the API-key audit payload carries only the public prefix — so this is a latent inconsistency rather than a leak. Its impact rose when audit payloads became readable in 1B.6.3, which is why it is recorded here. Aligning the two lists is a change to the audit **write** path and belongs to a phase that owns it.
- **The audit list's tenant predicate is not sargable.** Visibility comes entirely from RLS, whose disjunction over `current_setting()` and `app_org_reseller(org_id)` no index can serve; `EXPLAIN` confirms the ordering is served by `audit_logs_pkey` walked backwards, so no index was added. At volume the cost is filter selectivity, and the fix is a sargable tenant predicate — which conflicts with the reseller view that same policy arm provides, so it needs the first item resolved before it can be done well. Scalability work, not correctness work.


- **Expired idempotency records are not physically deleted.** Expiry is enforced at lookup — an expired record is reclaimed as a fresh request — so correctness never depends on a sweeper running. What is deferred is only reclaiming *space*: the table grows with one row per idempotent request until a retention job exists. Accepted because the volume at Phase 1B (two endpoints, control-plane traffic) is negligible, the index on `expires_at` is already in place for the eventual sweep, and a scheduler is out of scope for this phase (ADR-006).
- **A fallback chain can theoretically result in a recipient receiving more than one physical message** if a deprioritized channel's delivery lands after escalation already occurred (no provider offers reliable recall). Accepted because preventing it entirely is not possible against external providers; mitigated by keeping wait windows sane and by billing/audit correctly reflecting only one authoritative delivery (`FALLBACK_ENGINE.md` §5).
- **Exactly-once delivery is not guaranteed** at the transport level; only exactly-once *business outcome* is guaranteed, and this distinction is now stated identically across `PRD.md` §8a, `ARCHITECTURE.md` §9, and `DATABASE.md` §7.3 (Phase 0.1 verified these three do not drift from one another).
- **No certification is claimed** for SOC 2/ISO 27001/DPDP/GDPR — only control-objective alignment, explicitly and repeatedly disclaimed in `SECURITY.md`.
- **The audit log is not tamper-evident against an owner or superuser** (ADR-002, `SECURITY.md` §4a). Any in-database control can be removed by whoever owns the database; the trigger stops accident and application compromise, not a privileged operator. Accepted because the mitigation is external (SIEM export, WAL archiving, infrastructure-level audit of administrative access), not because the risk is small. Hash-chaining rows so a deletion is detectable is the obvious strengthening if it is ever needed.
- **A workspace- or team-scoped audit row is visible to any principal the authorization layer admits to that organization's audit trail.** The database guarantees organization-level isolation only (`TENANCY.md` §3a); restricting a record to its workspace or team is a required RBAC/ABAC check in the request path, on every read including list endpoints and exports, and is never satisfied by UI filtering or a client-supplied predicate. Unchanged by ADR-002, which records the finer scope without filtering on it. Accepted as a layering decision, not as a licence to omit the check: omitting it is a security defect.
- **Workspace and team isolation has no database backstop — a decision, ADR-011 D-4.** RLS enforces organization-level isolation only (`TENANCY.md` §3a), so below that level the service layer is the entire enforcement, and a cross-workspace failure leaves every database test green with RLS fully satisfied. This remains the highest residual risk in Phase 1B. Two distinct failure modes live here and only one of them was previously recorded. The first is a *missing* target-scope check on some endpoint — mitigated by ADR-003 D-5's single reusable mechanism, and by a Phase 1B.5 test asserting that every scoped route performs exactly one such check. The second needed no missing check at all: before ADR-005 D-1, the check that *was* performed could be satisfied by a permission from one grant and a scope from another, so a correctly-written call site still authorized an action no coherent grant conferred. **Closed in Phase 1B.5.1**, and the mutation restoring the flattened union now fails 18 unit and 2 security tests.
- **RESOLVED — an access token does not outlive its session.** `AuthGuard` re-reads the session (and the user's status) on every request, so a revoked session is refused immediately (`auth.sec-spec.ts`). If that read is ever skipped for performance, the window must be documented rather than assumed away.
- **Every successful API-key authentication writes an audit row.** Correct for traceability, and required because an API key has no session to anchor its activity to — but it is one audit row per request, where session authentication writes one per login. At Phase 1B volumes this is immaterial; before a high-throughput integration goes live it should be revisited (sampling, or aggregating to first-use-per-window), and that is a deliberate decision rather than something to discover from table growth.
- **`PermissionEvaluator` evaluates permission and scope against different grants.** `AuthPrincipal.permissions` is the flattened union, so a principal holding a permission through *any* grant is treated as holding it through *each* when checking scope coverage. A user with `read_only` at the organization and `workspace_manager` at one workspace passes an organization-level check for `role_assignments.grant`, `teams.create`, `workspaces.update` and `users.invite` — verified against the real evaluator and the real seeded roles. **The bound previously recorded here was wrong and is corrected**: this was described as safe because no endpoint targets a scope *below* organization level, but the over-approximation runs *upward* — a permission conferred narrowly is honoured widely — so that argument does not bound it. It is latent only because the single live endpoint checks `workspaces.read`, which every seeded role carries. Phase 1B.5 introduces `role_assignments.grant` as an endpoint permission and makes it directly exploitable inside the privilege-management API, and a naive "no granting a permission you do not hold" guard written against the same union would inherit the defect rather than contain it. **Closed in Phase 1B.5.1** by ADR-005 D-1: `RoleGrant` carries its own role's permissions and both halves of a decision are read off one grant, which makes the cross-product unrepresentable rather than merely avoided. The same class of error at the API-key creator intersection (ADR-005 D-4) was corrected in the same increment. Retained here as the record of a real defect that shipped, and of the mutations that now stop it returning.
- **Authentication rate limiting fails open when Redis is unavailable.** Deliberate and tested (`API.md` §5): Redis is an accelerator, the limiter is a throttle rather than the authentication control, and refusing every sign-in during a cache outage converts a degraded dependency into a total one. The cost is that a sustained Redis outage removes brute-force throttling — mitigated by logging every degraded call at `warn` so the condition is visible, and by the fact that credentials are still verified and every failure still audited. Revisit if a lockout mechanism (D13) ever lands.
- **Logout revokes the presenting session only.** "Sign out everywhere" is a separate, explicit action, so closing one browser tab cannot silently kill a user's other devices. `DELETE /auth/sessions/:id` revokes one named session; a bulk revoke-all endpoint is Phase 1B.6.
- **`acc_auth` holds no INSERT on `users`, so user creation is an `acc_app` operation.** Discovered while writing the Phase 1B.2 tests, and correct as it stands: the identity role resolves identities, it does not mint them, which keeps a compromised credential-verification path from provisioning itself an account. It does mean that any future flow creating a user before a tenant context exists (self-service signup, JIT provisioning from SSO) needs an explicit decision about which principal performs it, rather than widening `acc_auth`. Asserted by a test.
- **`AuditWriter`'s non-transactional branch is unreachable until authentication exists.** It calls `withRequestTenant()`, which fails closed without a resolved principal, so it has never carried real traffic. `ROADMAP.md` §4a records the end-to-end chain that must be proven before it does.
- **Four of the five `AUTH_ROLE_AUDIT_ACTIONS` accompany a business mutation that `acc_auth` itself performs** — `auth.login.succeeded` (inserts `sessions`, touches `users.last_login_at`), `auth.logout` and `auth.token.refreshed` (update `sessions`), and `api_key.authenticated` (updates `api_keys.last_used_at`). Their audit rows must therefore be written inside the caller's `acc_auth` transaction, not beside it. `AuditWriter` honours a supplied transaction for exactly this reason; a caller in 1B.3 that omits one would get an audit row that can commit while its mutation rolls back. Only `auth.login.failed` has no mutation to join. Covered by tests at both the unit and integration layer.
- **RESOLVED — the anonymous-login-failure audit path (R4) is writable.** Migration `0002` replaced the `acc_auth` policy; unknown-address failures are audited in the approved anonymous form.
- **Every audit write is synchronous today; the queued transport is DEFERRED.** `AuditWriter` exists and security-sensitive writes join the caller's transaction (`record(input, tx)`), so they roll back with their mutation. The asynchronous transport for non-sensitive actions (ADR-003 D-2) is not built.

## 4. Scalability concerns flagged for later phases

- High-cardinality metric labels are now structurally prevented by the Prometheus cardinality rule (§1, B15) — this row is retained here only to note the rule must be enforced in code review going forward, not merely documented.
- `messages`/`message_attempts`/`usage_ledger` partitioning strategy (`DATABASE.md` §13) needs a concrete retention/archival policy decided with the business before Phase 7/12, not left as "partition and hope."
- Canary migration (`ROUTING_ENGINE.md` §6) assumes routing-policy-version activation is cheap/fast; needs load-testing at high policy-change frequency before Phase 6 acceptance.

## 5. How to use this document going forward

Every phase's `ACCEPTANCE` gate (`ROADMAP.md` §1) should review this file. New entries in §2 should only be added when a genuine new tension or risk is discovered, not as a dumping ground for routine implementation TODOs (those belong in issue tracking). If any future addition would, if left unresolved, produce conflicting implementation assumptions between two engineers (the Phase 0.1 quality bar), it belongs in §1 as a blocker, not in §2 — do not reclassify a real ambiguity as "non-blocking" merely to avoid resolving it before Phase 1 begins.
