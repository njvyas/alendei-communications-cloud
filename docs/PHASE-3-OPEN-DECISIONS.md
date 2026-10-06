# Phase 3 — architecture decisions register

Companion to `ADR-014-PHASE-3-WHATSAPP-ORCHESTRATION.md`. Opened 06-Oct-2026 as the list of questions the stated ADR-014/v9 decisions did not settle; **updated at the Phase 3.0 freeze (06-Oct-2026)**. The ADR governs: for every decision marked FROZEN below, its text in the ADR supersedes the question and options recorded in §A. Analysis and proofs: `PHASE-3-ARCHITECTURE-DECISION-PROPOSAL.md`.

## Status at the Phase 3.0 freeze

| Status | Decisions |
|---|---|
| **FROZEN — approved** | D02, D06 (amended by ADR-015, ADR-014 §17), D09 (mechanism: ADR-014 §17.2), D16, D18, D19, D20, D21, D23 (mechanism only), D26 (**approved by ADR-015 R-14, 06-Oct-2026**: dispatcher circuit transitions write no `audit_logs` row), D29 |
| **ESTABLISHED** by an explicit prior approval or stated user requirement (cited in ADR-014 §3) | D01 (organization ownership, catalogue reference, uniqueness), D04 (configuration never authority), D13 (excluded triggers only), D17, D30 |
| **OPEN — increment-level, `REQUIRES USER APPROVAL`** (not freeze blockers) | D03, D05, D07, D08, D10, D11, D12, D22, D24, D25, D28; **moved back to OPEN by the governance correction of 06-Oct-2026 (no prior approval basis):** D01 (reseller/platform defaults), D04 (workspace/team use of assignments unchanged or overridable), D13 (positive fallback triggers: `provider_error`, `rate_limited`, pre-submission skips), D14 (termination), D15 (same-provider retry), D27 (conversations) |
| **OPEN — product/compliance, not architecture** | D23: template category set; category-to-consent mapping; workspace versus organization consent; withdrawal window (ADR-014 §11) |
| **OPEN — scope** | Target phase of delivery and webhook behaviours (excluded from Phase 3 by D20) |

The questions below are kept as the historical record; "Recommended: none" in an entry that is now FROZEN is superseded by the ADR.

## A. Decisions

### Provider assignments

**P3-D01 — Ownership and catalogue relationship of `organization_provider_assignments`.**
- *Question:* Is an assignment owned by exactly one organization, referencing one platform `providers` row? Can a reseller or the platform own assignments or defaults?
- *Why:* Determines the RLS key, who sees it, and whether reseller-level defaults exist.
- *Options:* (a) organization-owned only; (b) organization-owned with reseller or platform defaults.
- *Security:* Any non-organization owner needs a separate RLS model and cross-reseller isolation proof.
- *Recommended:* (a), because the v9 name says "organization" (F19). Confirm.

**P3-D02 — Eligibility.**
- *Question:* Is an unassigned provider ineligible for the organization? Do disabled or draining providers stay assigned but ineligible?
- *Why:* Defines the candidate set for every send and fallback.
- *Options:* assignment is required for use; or assignment only restricts an otherwise open catalogue.
- *Security:* An open default would let any organization use any provider.
- *Recommended:* none.

**P3-D03 — Priority and fallback order.**
- *Question:* What orders candidates — an assignment priority, `fallback_steps`, or something else? How are ties broken (determinism, F6)?
- *Why:* F6 requires deterministic fallback.
- *Options:* (a) integer priority on the assignment, unique per organization and channel; (b) priority plus a stable tiebreak; (c) fallback steps (conflicts with F18 if they are policy CRUD).
- *Security:* A non-deterministic order breaks replay and recovery reasoning.
- *Recommended:* none.

**P3-D04 — Workspace inheritance and team behaviour.**
- *Question:* Do workspaces inherit the organization's assignments unchanged? May a workspace or team narrow, reorder or exclude them?
- *Why:* Affects data model and authorization.
- *Options:* inherit only; inherit plus narrowing per workspace; per-team narrowing.
- *Security:* Narrowing at a lower scope must never widen; it needs app-layer enforcement (RLS stops at the organization).
- *Recommended:* none.

**P3-D05 — CRUD authority, permission keys and scope for assignments.**
- *Question:* Platform (`providers.manage`), organization administrators, or both? Which keys? At which scope?
- *Why:* An assignment couples the platform catalogue to tenant traffic.
- *Options:* platform-only administration; organization self-service among platform-offered providers.
- *Security:* Vertical escalation, if a tenant could assign a provider it was not offered.
- *Recommended:* none.

**P3-D06 — RLS, integrity and isolation.**
- *Question:* What is the RLS predicate? How do composite FKs tie the assignment to its organization? How does a tenant-context send path read the platform catalogue, which it cannot do under today's RLS (ADR-013 2.4 residual (e)(4))?
- *Why:* This blocks the send path.
- *Options:* (a) a reviewed read predicate for assigned providers; (b) a SECURITY DEFINER read function (needs a stop-and-report, per prior rules); (c) denormalized provider fields on the assignment.
- *Security:* Cross-organization and cross-reseller isolation; catalogue disclosure.
- *Recommended:* none.

### Tenancy

**P3-D07 — Workspace selection for an organization-scoped user.**
- *Question:* By what mechanism does an organization-level principal name the workspace of a workspace-owned resource (contact, message, conversation)? Options include a path segment, a body field or a header.
- *Why:* The planned tables carry `workspace_id`; today no mechanism exists. This is the gap the frontend audit identified.
- *Options:* (a) path `/workspaces/:workspaceId/...`; (b) body or query `workspaceId`, validated; (c) a header analogous to `X-Acc-Organization`.
- *Security:* Scope substitution. Each option needs server-side validation that the workspace belongs to the selected organization and that the grant covers it.
- *Recommended:* none.

**P3-D08 — Workspace- and team-scoped users; mismatches.**
- *Question:* How are a workspace-scoped and a team-scoped principal's workspace resolved? What does a request naming a workspace the caller cannot reach, or one in another organization, return (403 versus 404)? What may a team-scoped user see of workspace-owned resources?
- *Why:* Defines isolation behaviour and enumeration resistance.
- *Options:* reuse `TENANCY_CONTEXT_MISMATCH` semantics; a 404 to avoid disclosure.
- *Security:* Enumeration and team isolation.
- *Recommended:* none.

### Permissions

**P3-D09 — Phase 3 permission keys and scope semantics.**
- *Question:* Keys, allowed scope types, and coverage for contacts, identities, consent, suppressions, templates, messages and assignments. Can platform or reseller grants cover them, or only organization, workspace and team grants? Is suppression organization-only (the planned table has `org_id` only)?
- *Why:* Nothing in v9 names them.
- *Options:* the candidate set `contacts.read|manage`, `templates.read|manage`, `suppressions.read|manage`, `messages.read|send` (convention `{domain}.{action}`), or a finer `create/update/delete` split as Phase 1 uses.
- *Security:* Vertical escalation and the seeded role mapping (by migration, D22).
- *Recommended:* none.

### Lifecycle

**P3-D10 — Message state machine.**
- *Question:* Phase 3's exact message states, transitions and terminal states, including dispatching, provider submission, fallback, success, failure, refusal and cancellation. Does the `ARCHITECTURE.md` §6 machine apply (it includes `DELIVERED`, `READ` and `EXPIRED`, which need delivery events)?
- *Why:* The core contract for the API, events and UI.
- *Options:* adopt §6; a submission-only subset; §6 plus refusal states.
- *Security:* Every transition must be a conditional (state-guarded) PostgreSQL update (F7).
- *Recommended:* none.

**P3-D11 — Attempt lifecycle and identity.**
- *Question:* Attempt statuses (does `DATABASE.md` §6's set apply?), and how a circuit-refused or fenced-out attempt is represented. Is the provider idempotency key derived from the attempt id (`DATABASE.md` §7, `PROVIDER_ADAPTER.md` §2a) or from the Phase 2 `submissionId`? Which timestamps exist? How does the attempt relate to fallback (new attempt) and retry?
- *Why:* Determines duplicate-safety.
- *Security:* Duplicate submission and stale execution.
- *Recommended:* none.

**P3-D12 — Event types, ordering and sources.**
- *Question:* Which event types `message_events` records in Phase 3 (does the `EVENTS.md` §4 catalogue apply without Kafka, F11?), the ordering key (monotonic sequence versus timestamps), the sources, and the correlation and provider identifiers carried.
- *Why:* Feeds the timeline UI and audit reconstruction.
- *Security:* Append-only integrity (existing pattern: trigger plus RLS).
- *Recommended:* none.

### Fallback and execution

**P3-D13 — What triggers fallback.**
- *Question:* Which normalized outcomes trigger fallback to the next provider? Is fallback triggered only at submission time, or also by delivery outcome (`FALLBACK_ENGINE.md` §1)?
- *Why:* F6 freezes the principle, not the rule.
- *Options:* (a) only Phase 2 "provider failure" outcomes; (b) (a) plus circuit-refused or ineligible providers being skipped; (c) delivery-outcome triggers (needs P3-D20).
- *Security:* Neutral outcomes (`auth_error`, `invalid_request`, …) must not be treated as outage merely to trigger fallback (stated requirement).
- *Recommended:* none.

**P3-D14 — Termination conditions.**
- *Question:* When does a chain end — candidates exhausted, a non-fallback outcome, a maximum attempt count, a time limit, or the message's own expiry?
- *Why:* A missing bound means unbounded attempts.
- *Recommended:* none.

**P3-D15 — Same-provider retry.**
- *Question:* Does Phase 3 retry the same provider (`retry_count`, `FALLBACK_ENGINE.md` §3) before falling back, or never?
- *Why:* Phase 2 executes once with no retry.
- *Security:* Duplicate submission.
- *Recommended:* none.

**P3-D16 — Timeouts and unknown outcomes versus duplicate safety.**
- *Question:* After a `timeout` or `unknown` outcome the provider may have processed the request. May the next provider be tried, and under what proof?
- *Why:* F6 forbids unsafe duplicate submission.
- *Options:* never fall back on ambiguous outcomes; fall back only with fencing proof (F10); fall back and accept the documented risk (not compatible with F6).
- *Recommended:* none, beyond F6's constraint.

**P3-D17 — Durable simulator invocation fencing.**
- *Question:* How is it represented (fencing token or epoch on the attempt, its persistence, the compare-and-set) and when is it checked (before invocation, before recording)?
- *Why:* F10 is frozen as a principle only.
- *Security:* Stale execution after a crash or a lease takeover.
- *Recommended:* none.

**P3-D18 — Polling and recovery mechanism.**
- *Question:* Which process polls (the API process or a separate worker — ADR-004 D-5 deferred the worker harness "to the first phase with a worker")? Poll interval, claim (`FOR UPDATE SKIP LOCKED`, `FALLBACK_ENGINE.md` §4), lease duration, and recovery of claimed-but-unfinished work.
- *Why:* F9 is frozen as a principle only.
- *Security:* Crash recovery and duplicate claim.
- *Recommended:* none.

### Simulator

**P3-D19 — Selecting simulator behaviour for a persisted message.**
- *Question:* How a `POST /messages` determines the simulator outcome for each provider attempt: a request field, per-provider configuration, a recipient-address convention, or a test-only header.
- *Why:* Deterministic failure injection is needed to test fallback.
- *Security:* The mechanism must not be usable to forge outcomes outside development and test.
- *Recommended:* none.

**P3-D20 — Delivery and webhook behaviours.**
- *Question:* Are `DELIVERY_DELAY`, `DELIVERY_FAILURE`, `DUPLICATE_WEBHOOK` and `OUT_OF_ORDER_WEBHOOK` (handed forward by ADR-013 PD-3) in Phase 3? Is there an inbound webhook path and its signature verification (`ROADMAP.md` §6 "security checks")?
- *Why:* Decides whether delivery states exist.
- *Recommended:* none.

### Templates, consent, suppression

**P3-D21 — Templates.**
- *Question:* Ownership and scope (organization per `DATABASE.md`?); lifecycle and approval transitions under the simulator (manual action, automatic, or simulator-driven); whether Phase 3 sends require a template; what happens when a template is not approved; permissions.
- *Why:* WhatsApp business-initiated messages are template-based in practice; there is no vendor integration (F2, F3).
- *Recommended:* none.

**P3-D22 — Refusal precedence and persistence.**
- *Question:* The order of checks among suppression, consent, template validity and provider eligibility. For each refusal: is a `messages` row, an attempt, an event or an audit row created? Is it a synchronous 4xx or an accepted-then-failed message?
- *Why:* Affects idempotency and the UI.
- *Security:* Disclosure of suppression status; audit completeness.
- *Recommended:* none.

**P3-D23 — Consent and suppression semantics.**
- *Question:* Consent types and the default when no consent row exists; WhatsApp opt-in; suppression by raw address before a contact exists (planned); channel-specific versus all-channel suppression; who may lift a suppression.
- *Recommended:* none.

### API

**P3-D24 — Send API shape.**
- *Question:* `POST /messages`: synchronous result or `202` with polling? Must the request carry `Idempotency-Key`? What is the idempotency endpoint namespace? Are API keys accepted (today they are organization- or workspace-bound)? What rate limit applies?
- *Recommended:* none, beyond F15 (Phase 1C idempotency reused).

**P3-D25 — Contact identity rules.**
- *Question:* Address normalization (E.164 for WhatsApp), uniqueness scope (per workspace or organization), primary identity rules, verification.
- *Recommended:* none.

**P3-D26 — Audit versus message events.** *(APPROVED by ADR-015 R-14, 06-Oct-2026: dispatcher circuit transitions write no `audit_logs` row; `provider_health`, attempts/events and claim/fencing evidence are authoritative. ADR-014 §17.4 governs.)*
- *Question:* Which messaging actions write `audit_logs` (security-sensitive actions per `SECURITY.md` §4) and which only `message_events`?
- *Recommended:* none.

**P3-D27 — Conversations in Phase 3.**
- *Question:* `ROADMAP.md` §6 lists the `conversations` table. Is it in Phase 3, and with what behaviour?
- *Recommended:* none.

**P3-D28 — Phase 3 increments and gates.**
- *Question:* The Phase 3 increment list (3.1 …), each increment's scope and its gate criteria (as ADR-013 did for Phase 2).
- *Recommended:* none.

**P3-D29 — Organization lifecycle interaction.**
- *Question:* Behaviour of sends and pending work when an organization is suspended or closed (existing F-5 refuses tenant mutations in suspended organizations).
- *Recommended:* none.

**P3-D30 — Fallback-engine boundary between Phase 3 and Phase 5.**
- *Question:* Which `FALLBACK_ENGINE.md` components Phase 3 builds for provider-to-provider fallback — the `deadline_at` poller, the conditional escalation guard, the attempt chain — and which stay in Phase 5: cross-channel steps, `fallback_policies`/`fallback_steps` CRUD, delivery-window timers.
- *Why:* Needed to keep ROADMAP §6 and §8 consistent.
- *Recommended:* none, beyond F4, F5 and F18.

## B. Conflicts between v9 and existing documents

| # | Existing text | Conflict | Status at the freeze |
|---|---|---|---|
| C1 | `FALLBACK_ENGINE.md` §1: fallback triggered by delivery outcome | Phase 3 has no delivery, so no delivery-outcome fallback | **Resolved** by D20 and D30 (delivery-outcome fallback is Phase 5); which submission outcomes trigger fallback is OPEN (D13) |
| C2 | `FALLBACK_ENGINE.md` §2, `ROUTING_ENGINE.md` §4: order from `fallback_steps` and routing policies | Excluded from Phase 3 (F18, D30) | **Resolved in scope**; the Phase 3 candidate order remains OPEN (D03) |
| C3 | `DATABASE.md` §6 routing-policy, pricing, campaign and journey columns | Excluded (F13, F14, F18) | **Resolved in scope**; exact Phase 3 columns OPEN (D10, D11) |
| C4 | `ARCHITECTURE.md` §6 terminal `DELIVERED`, `READ`, `EXPIRED` | No delivery in Phase 3 | **Resolved** by D20 and D16 (Phase 3 note added to `ARCHITECTURE.md` §6) |
| C5 | `EVENTS.md` Kafka transport and consumers | No Kafka/outbox (F11) | **Resolved** for transport (note in `EVENTS.md`); event types OPEN (D12) |
| C6 | `FALLBACK_ENGINE.md` §3 adapter retry (`retry_count`) | Same-provider retry undecided | OPEN (D15) |
| C7 | ADR-013 2.4 residual (e)(4): tenant context cannot read the catalogue | — | **Resolved** by D06 (`acc_dispatch`) |
| C8 | `ROADMAP.md` §6 webhook tests and signature review | No webhooks in Phase 3 | **Resolved** by D20 (`ROADMAP.md` §6 corrected) |
| C9 | `DATABASE.md` §3 workspace-owned contacts; no client workspace mechanism | — | OPEN (D07) |
| C10 | `TESTING.md` §3 critical scenario (cross-channel, Phase 5 gate) | Consistent | — |
| C11 | `TESTING.md` §2 and ADR-013 PD-3: delivery behaviours "are Phase 3" | Excluded by D20 | **Resolved** (`TESTING.md` §2 corrected; PD-3 note) |
| C12 | `DATABASE.md` §3 `consents` with mutable `revoked_at` | Append-only consent events (D23) | **Resolved** (`DATABASE.md` updated) |
| C13 | `SECURITY.md` §7: `approval_status` "models provider approval state" | Simulated, internal state (D21) | **Resolved** (`SECURITY.md` §7 corrected) |
| C14 | Phase 1C F-5: no tenant-data mutation in a non-active organization | Dispatch must finalize in-flight work | **Resolved** by D29's narrow `acc_dispatch` exception; F-5 unchanged for `acc_app` (note in `TENANCY.md` §1c and ADR-012) |

## C. Resolved by the freeze (documentation changed)

| Contradiction | Change |
|---|---|
| `ROADMAP.md` §6 Phase 3: "no … fallback complexity yet (single channel, single attempt)" | Corrected: provider-to-provider fallback is Phase 3 (F4); single channel (WhatsApp, F1, F5) |
| `ROADMAP.md` §8 Phase 5 claimed provider failover | Corrected: basic same-channel provider-to-provider fallback is Phase 3; Phase 5 keeps cross-channel fallback and the rest of its scope, boundary P3-D30 |
| `ROADMAP.md` §6 "Architecture: EVENTS.md message lifecycle events" (Kafka-based) | Note: no Kafka/outbox in Phase 3 (F11); PostgreSQL polling (F9) |
