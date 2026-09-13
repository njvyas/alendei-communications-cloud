# Open Decisions, Risks & Contradictions Log

This is the living register of everything flagged as needing a product-owner decision, carrying scalability/security risk, or representing a tension between requirements that this document set resolved with an explicit, stated choice rather than silently picking one side. As of Phase 0.1 (the consolidated architecture consistency & hardening pass), every item that would have blocked a correct, unambiguous Phase 1 implementation has been resolved and is recorded in §1. Items in §2 are explicitly confirmed non-blocking — none of them affect the correctness of Phase 1 Foundation work. Phase 0.2 (final documentation-hardening pass before Phase 1 implementation — transaction-specific pricing, `requested_channel_id` hard-constraint semantics, attempt-level routing/pricing snapshots, idempotency `failed`-status semantics, and the broader engagement-platform product architecture, `ARCHITECTURE.md` §21) added B19–B22 below, all resolved. A follow-up Phase 0.2 correction pass added B23–B25 (multi-component pricing evaluation model, billable-transaction terminology generalization, and a residual reservation-accounting wording fix). Phase 0.3 (surgical documentation-consistency pass) added B26–B28 (Phase 5/Phase 7 billing-dependency de-conflation, removal of "distributed lock" as an implied Phase 5 deliverable, and an explicit Pricing-Evaluation-vs-Usage-Ledger HOW-vs-WHAT boundary statement). Phase 0.4 (final documentation freeze pass) added B29–B30 (made `usage_ledger.pricing_evaluation_id` the authoritative concrete foreign key to the pricing calculation that produced each ledger amount, demoting `rate_card_ref` to descriptive metadata; clarified `DR.md`'s Redis-loss wording so it cannot be read as Redis participating in fallback correctness). No Phase 0.2–0.4 change reopened or contradicted any earlier resolution; the architecture is frozen as of Phase 0.4.

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
- Two session variables join `app.current_org_id`: `app.current_reseller_id` and `app.is_platform_admin`. Both are set only from resolved authentication material.
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
| D12 | Password reset / account recovery | No mail transport exists in Phase 1, and the flow is not in `API.md` §2's resource areas | Deferred; required before external users self-serve |
| D13 | Account lockout (`users.locked_until`) beyond rate limiting | Redis rate limiting plus `auth.login.failed` audit covers Phase 1B's threat model; lockout adds a denial-of-service vector against a known address | Deferred; rate limiting only |
| D14 | API-key rotation as a first-class operation with lineage | Revoke-plus-create already produces two audit rows describing the same change | Deferred |
| D15 | WebSocket ticket consumption and the socket gateway | There is no real-time consumer until Phase 8; building consumption now means a socket server with nothing to serve. Ticket *issuance* is in Phase 1B | Issuance only in Phase 1B; consumption deferred, so `TESTING.md` §6i is only partly satisfiable at Gate B |
| D7 | RTO/RPO targets in `DR.md` §3 | A business-input number, not an engineering ambiguity — the mechanisms (WAL archiving, cross-region replication) are already fully specified regardless of the exact target number | Placeholder targets pending business/product-owner confirmation before Phase 12 |
| D8 | Data-subject request handling (DPDP/GDPR erasure/export) | No real contact PII is processed before Phase 3, and even then only simulator-backed test data through Phase 12 — there is no Phase 1 code path this blocks | Not yet designed; required before any real customer PII is processed |
| D9 | Modular monolith vs. early service extraction for `provider-adapters` under high throughput | Module boundaries are already drawn specifically so this is a deployment-topology change later, not a Phase 1 architectural fork | Modular monolith through Phase 2–8 |

## 3. Risks explicitly accepted by design (not oversights)

- **A fallback chain can theoretically result in a recipient receiving more than one physical message** if a deprioritized channel's delivery lands after escalation already occurred (no provider offers reliable recall). Accepted because preventing it entirely is not possible against external providers; mitigated by keeping wait windows sane and by billing/audit correctly reflecting only one authoritative delivery (`FALLBACK_ENGINE.md` §5).
- **Exactly-once delivery is not guaranteed** at the transport level; only exactly-once *business outcome* is guaranteed, and this distinction is now stated identically across `PRD.md` §8a, `ARCHITECTURE.md` §9, and `DATABASE.md` §7.3 (Phase 0.1 verified these three do not drift from one another).
- **No certification is claimed** for SOC 2/ISO 27001/DPDP/GDPR — only control-objective alignment, explicitly and repeatedly disclaimed in `SECURITY.md`.
- **The audit log is not tamper-evident against an owner or superuser** (ADR-002, `SECURITY.md` §4a). Any in-database control can be removed by whoever owns the database; the trigger stops accident and application compromise, not a privileged operator. Accepted because the mitigation is external (SIEM export, WAL archiving, infrastructure-level audit of administrative access), not because the risk is small. Hash-chaining rows so a deletion is detectable is the obvious strengthening if it is ever needed.
- **A workspace- or team-scoped audit row is visible to any principal the authorization layer admits to that organization's audit trail.** The database guarantees organization-level isolation only (`TENANCY.md` §3a); restricting a record to its workspace or team is a required RBAC/ABAC check in the request path, on every read including list endpoints and exports, and is never satisfied by UI filtering or a client-supplied predicate. Unchanged by ADR-002, which records the finer scope without filtering on it. Accepted as a layering decision, not as a licence to omit the check: omitting it is a security defect.
- **Workspace and team isolation has no database backstop.** RLS enforces organization-level isolation only (`TENANCY.md` §3a), so below that level the service layer is the entire enforcement. A single missing target-scope check opens cross-workspace access while every database test stays green and RLS remains fully satisfied. This is the highest residual risk in Phase 1B. Mitigated by ADR-003 D-5's single reusable mechanism and by isolation tests written to pass only when application-layer enforcement is present.
- **An access token remains valid for up to its TTL after its session is revoked**, unless `sessions.revoked_at` is checked on the same query that resolves grants. Because ADR-003 D-3 already requires a per-request session/grant read, that check is nearly free and is the recommended implementation; if it is ever skipped for performance, the window must be documented rather than assumed away.
- **`AuditWriter`'s non-transactional branch is unreachable until authentication exists.** It calls `withRequestTenant()`, which fails closed without a resolved principal, so it has never carried real traffic. `ROADMAP.md` §4a records the end-to-end chain that must be proven before it does.
- **Four of the five `AUTH_ROLE_AUDIT_ACTIONS` accompany a business mutation that `acc_auth` itself performs** — `auth.login.succeeded` (inserts `sessions`, touches `users.last_login_at`), `auth.logout` and `auth.token.refreshed` (update `sessions`), and `api_key.authenticated` (updates `api_keys.last_used_at`). Their audit rows must therefore be written inside the caller's `acc_auth` transaction, not beside it. `AuditWriter` honours a supplied transaction for exactly this reason; a caller in 1B.3 that omits one would get an audit row that can commit while its mutation rolls back. Only `auth.login.failed` has no mutation to join. Covered by tests at both the unit and integration layer.
- **The anonymous-login-failure audit path (R4) is specified but not yet writable.** The `acc_auth` RLS policy rejects it until a migration replaces that policy. Until then, unknown-email login failures have no audit representation.
- **Synchronous-versus-asynchronous audit writes are not yet implemented.** `SECURITY.md` §4 specifies the distinction and `SECURITY_SENSITIVE_AUDIT_ACTIONS` in `@acc/contracts` names the set, but no service-layer code consumes it yet — there is no audit-writing service before Phase 2. The schema does not constrain it either way.

## 4. Scalability concerns flagged for later phases

- High-cardinality metric labels are now structurally prevented by the Prometheus cardinality rule (§1, B15) — this row is retained here only to note the rule must be enforced in code review going forward, not merely documented.
- `messages`/`message_attempts`/`usage_ledger` partitioning strategy (`DATABASE.md` §13) needs a concrete retention/archival policy decided with the business before Phase 7/12, not left as "partition and hope."
- Canary migration (`ROUTING_ENGINE.md` §6) assumes routing-policy-version activation is cheap/fast; needs load-testing at high policy-change frequency before Phase 6 acceptance.

## 5. How to use this document going forward

Every phase's `ACCEPTANCE` gate (`ROADMAP.md` §1) should review this file. New entries in §2 should only be added when a genuine new tension or risk is discovered, not as a dumping ground for routine implementation TODOs (those belong in issue tracking). If any future addition would, if left unresolved, produce conflicting implementation assumptions between two engineers (the Phase 0.1 quality bar), it belongs in §1 as a blocker, not in §2 — do not reclassify a real ambiguity as "non-blocking" merely to avoid resolving it before Phase 1 begins.
