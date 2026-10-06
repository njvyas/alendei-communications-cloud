# ADR-014 — Phase 3: WhatsApp-first message orchestration

**Status: FROZEN — Phase 3.0 architecture (approved by the user, 06-Oct-2026).** Documentation only: no Phase 3 code, migration, API or OpenAPI change exists. Phase 3.1 starts only on the user's explicit approval. The increment-level decisions listed in §15 remain open by design and are decided at their increment; they are not blockers to this architecture freeze.

**Source of authority.** The approved architecture is referred to as ADR-014/v9. The full v9 text was not supplied; §1 records exactly the v9 decisions the user stated explicitly (F1–F19). §3–§13 record the decisions approved at the Phase 3.0 review (06-Oct-2026), whose analysis, alternatives and proofs are in `PHASE-3-ARCHITECTURE-DECISION-PROPOSAL.md`. Where that proposal and this ADR differ, **this ADR governs**. If the full v9 text is later supplied, this ADR is to be re-checked against it.

Markers: **FROZEN (v9)** — a v9 decision; **APPROVED (D-n)** — approved at the Phase 3.0 review; **APPROVED with the architecture (D-n)** — a derived decision the approved proofs depend on, frozen by the user's approval of the Phase 3.0 architecture as a whole; **EXISTING CONTRACT** — implemented in Phases 1–2; **OPEN (D-n)** — an increment-level decision, `PHASE-3-OPEN-DECISIONS.md`.

## 1. Decisions frozen from ADR-014/v9

| # | Decision | Status |
|---|---|---|
| F1 | **WhatsApp-first.** Phase 3 builds the message path for the WhatsApp channel first. | FROZEN (v9) |
| F2 | **SimulatorAdapter only.** No real provider adapter. | FROZEN (v9) |
| F3 | **No real credentials and no vendor network calls.** Credential architecture stays governed by the documentation-only contract of Phase 2.5 (`PROVIDER_ADAPTER.md` §4a). | FROZEN (v9); contract EXISTING |
| F4 | **Provider-to-provider fallback is in Phase 3** — between providers of the same channel. | FROZEN (v9) |
| F5 | **No cross-channel fallback** in Phase 3. | FROZEN (v9) |
| F6 | **Fallback principle:** provider-to-provider only; deterministic; subject to provider-assignment eligibility, provider lifecycle, health and circuit state, and authoritative CircuitAdmission; no unsafe duplicate submission. | FROZEN (v9); rules frozen in §8 (D13–D16) |
| F7 | **PostgreSQL is the correctness boundary.** | FROZEN (v9); consistent with `ARCHITECTURE.md` §9c, `FALLBACK_ENGINE.md` §4 |
| F8 | **Redis is advisory only** — never required for correctness. | FROZEN (v9); consistent with `ARCHITECTURE.md` §9c |
| F9 | **PostgreSQL polling and recovery** — work is found and recovered by polling PostgreSQL. | FROZEN (v9); mechanism frozen in §9 (D17, D18) |
| F10 | **Durable simulator invocation fencing.** | FROZEN (v9); representation frozen in §9 (D17) |
| F11 | **No Kafka and no transactional outbox** in Phase 3. | FROZEN (v9) |
| F12 | **No WebSocket execution** in Phase 3. | FROZEN (v9) |
| F13 | **No campaigns, no journeys.** | FROZEN (v9) |
| F14 | **No billing** (no rating, pricing, ledger or charges). | FROZEN (v9) |
| F15 | **Phase 1C idempotency is reused** (no new idempotency mechanism). | FROZEN (v9); mechanism EXISTING (§3) |
| F16 | **Phase 2 CircuitAdmission is authoritative** before every provider submission. | FROZEN (v9); EXISTING (`PROVIDER_ADAPTER.md` §6h) |
| F17 | **Canonical hierarchy: PLATFORM → RESELLER → ORGANIZATION → WORKSPACE → TEAM.** | FROZEN (v9); EXISTING (`TENANCY.md` §1a) |
| F18 | **Advanced routing stays out of Phase 3:** dynamic routing weights, routing-policy CRUD, optimization, canary routing, advanced routing strategy. | FROZEN (v9) |
| F19 | A provider-assignment entity named **`organization_provider_assignments`** is part of Phase 3. | FROZEN (v9); ownership, status and isolation frozen in §4 (D01, D02, D04, D06); priority and administration open (D03, D05) |

## 2. Existing contracts Phase 3 inherits unchanged

| Contract | Where established |
|---|---|
| `ProviderAdapter` port; `SimulatorAdapter` (the only adapter); submission-time behaviours `SUCCESS`, `TIMEOUT`, `500`, `429`, `INVALID_CREDENTIALS`, `INVALID_REQUEST`, `SLOW_RESPONSE`; the 3000 ms platform submission timeout | `PROVIDER_ADAPTER.md` §2, §7; `ROADMAP.md` §5b 2.2 |
| Normalized failure taxonomy and its classification (§6 below) | `PROVIDER_ADAPTER.md` §5b; `packages/contracts/src/provider-health.ts` |
| CircuitAdmission: process-local, single-use, provider-bound, short-lived token; `ProviderSubmissionExecutor.execute` redeems one before any adapter `send()`; routing eligibility is advisory | `PROVIDER_ADAPTER.md` §6h; ADR-013 "Gate D.3 final remediation" |
| Provider lifecycle (`active`, `disabled`, `draining`), health and circuit state machines, the platform-wide circuit policy | `PROVIDER_ADAPTER.md` §5–§6 |
| Hot reload: advisory configuration snapshot, never an authorization or admission source | `PROVIDER_ADAPTER.md` §3a |
| Credential reference contract CR-1–CR-8 (documentation only) | `PROVIDER_ADAPTER.md` §4a |
| Tenancy: five-scope hierarchy, downward-only inheritance, RLS isolates to the organization and the application layer enforces workspace and team | `TENANCY.md` §1a, §1a.4; `RBAC.md` |
| Organization selection by `X-Acc-Organization`, validated server-side (`TENANCY_CONTEXT_MISMATCH` on a mismatch) | `API.md`; `FRONTEND_API_CONTRACT.md`; `scope-resolver.service.ts` |
| Workspace context derived only from a grant that names a workspace — no client workspace selector exists | `scope-resolver.service.ts` (Phase 1C) |
| Permission keys are `{domain}.{action}`; authorization never depends on a role name | `packages/contracts/src/permissions.ts`; `RBAC.md` |
| API idempotency: `Idempotency-Key`, stored per `(org_id, endpoint, key)`, request hash, replay, in-progress and mismatch codes | `API.md` §4a; ADR-006; `DATABASE.md` §7.1 |
| Response envelope `{data}` / `{data, page}`, keyset pagination, error envelope `{error:{code, message, correlationId, retryable, details?}}` | `API.md`; `FRONTEND_API_CONTRACT.md` |
| Every mutation audited in its own transaction; refusals audited as `authorization.denied` | `SECURITY.md` §4; ADR-005 |

## 3. Approved decisions — index

| Id | Decision | Status | Section |
|---|---|---|---|
| D01 | Assignments are organization-owned and reference the platform catalogue | APPROVED with the architecture | §4 |
| D02 | Assignment `active`/`disabled` status; no hard delete | APPROVED | §4 |
| D04 | Assignments apply unchanged to every workspace and team of the organization; configuration, never authority | APPROVED with the architecture | §4 |
| D06 | Dedicated `acc_dispatch` principal; token-bound per-message RLS; evidence-bound circuit writes | APPROVED | §9 |
| D09 | Eight permission keys; scopes as tabled; reseller, team and platform excluded | APPROVED | §6 |
| D13 | Fallback triggers | APPROVED with the architecture | §8 |
| D14 | Deterministic termination | APPROVED with the architecture | §8 |
| D15 | No same-provider retry | APPROVED with the architecture | §8 |
| D16 | `OUTCOME_UNKNOWN` is terminal; never retried, never a fallback trigger | APPROVED | §7 |
| D17 | Durable fencing: claim token and epoch; `submitting` attempt written before invocation | APPROVED with the architecture | §9 |
| D18 | Poll 1 s, batch 10, lease 30 s — operational configuration | APPROVED | §9 |
| D19 | `simulator_behavior` capability on simulator providers, platform-administered | APPROVED | §10 |
| D20 | No delivery or webhook processing in Phase 3 | APPROVED | §10 |
| D21 | `templates.approval_status` is a simulated, internal state only | APPROVED | §11 |
| D23 | Consent mechanism (append-only events); category/consent policy left to product/compliance | APPROVED (mechanism) | §11 |
| D27 | No conversations in Phase 3 | APPROVED with the architecture | §7 |
| D29 | Suspended organizations hold queued work; closed organizations fail it; narrow `acc_dispatch` exception; advisory-lock serialization | APPROVED | §12 |
| D30 | Phase 3 / Phase 5 boundary | APPROVED with the architecture | §8 |

## 4. Organization provider assignments (F19; D01, D02, D04)

- **Ownership (D01):** `organization_provider_assignments(org_id NOT NULL → organizations, provider_id NOT NULL → providers, …)`, unique `(org_id, provider_id)`; organization-owned, referencing one platform `providers` row. No reseller or platform defaults.
- **Status (D02):** `active | disabled`; unassigning sets `disabled`; there is no hard delete and no `DELETE` route. A disabled assignment is never a candidate.
- **Inheritance (D04):** every send of the organization, in any workspace or team, uses the organization's active assignments unchanged; no workspace or team overrides. Inheriting configuration confers **no authority**: the right to send comes only from `messages.send` (§6).
- **Isolation:** tenant RLS by organization for HTTP; the dispatcher's access is defined in §9.
- **Priority and order:** OPEN (D03). **Administration (who creates, updates, disables; route):** OPEN (D05).

## 5. Workspace context

EXISTING CONTRACT: organization by `X-Acc-Organization`, validated server-side; a workspace context exists only when a grant names one. The mechanism for naming the workspace of a workspace-owned resource and the mismatch behaviour are OPEN (D07, D08). Whatever is decided keeps the server authoritative: a client-supplied identifier selects a target and never establishes authority.

## 6. Permissions (D09)

Authorization uses permissions only, never role names; inheritance is downward only (PLATFORM → RESELLER → ORGANIZATION → WORKSPACE → TEAM). No platform grant covers these keys.

| Permission | Resource | Action | Allowed scopes | Reseller | Organization | Workspace | Team |
|---|---|---|---|---|---|---|---|
| `contacts.read` | contacts, identities, consent history | read | organization, workspace | no | yes | yes | no |
| `contacts.manage` | contacts, identities, consent events | create / update / delete; consent grant and revoke | organization, workspace | no | yes | yes | no |
| `templates.read` | templates (organization-owned) | read | organization | no | yes | no | no |
| `templates.manage` | templates | create / update / delete; simulated approve and reject | organization | no | yes | no | no |
| `suppressions.read` | suppressions (organization-owned) | read | organization | no | yes | no | no |
| `suppressions.manage` | suppressions | create / lift | organization | no | yes | no | no |
| `messages.read` | messages, attempts, events | read | organization, workspace | no | yes | yes | no |
| `messages.send` | `POST /messages` | send | organization, workspace | no | yes | yes | no |

Reseller grants are excluded: reseller administration covers tenancy records, not end-customer content, and no reseller-aware tenant-data RLS exists (a reseller suppression list is a possible later feature with its own ownership model). Team grants are excluded because no Phase 3 resource is team-owned. A workspace sender may use an approved template of its organization through `messages.send`; using a template is not reading it.

## 7. Message lifecycle invariants (D16, D27)

The exact state names, transitions, attempt fields and event types are OPEN (D10, D11, D12). The following invariants are frozen and bind any D10–D12 answer; working state names below follow the proposal.

- **Terminal outcome-unknown (D16):** a `timeout`, an `unknown` outcome, an absent acknowledgement, or a crash between writing a `submitting` attempt and recording its result makes the attempt `outcome_unknown` and the message terminal `OUTCOME_UNKNOWN`. It is **never retried, never re-submitted and never a fallback trigger** in Phase 3: the poller selects only queued work or `ROUTING` with an expired lease; a new attempt requires a conditional `QUEUED → ROUTING` claim that affects no terminal row; recovery maps `submitting` only to `outcome_unknown`; a database transition guard rejects every transition out of a terminal state; no provider call is possible without a CircuitAdmission, which only a successful claim issues.
- **Terminal states never transition again**, for any non-owner principal.
- **Message-level fallback re-queues:** a fallback-eligible failure returns the message to `QUEUED`, so every attempt has its own claim, epoch and lease.
- **No conversations (D27):** there is no inbound path in Phase 3; conversations are deferred to the inbox phase.

## 8. Provider fallback (D13, D14, D15, D30)

| Outcome (Phase 2 taxonomy, `PROVIDER_ADAPTER.md` §5b) | Fallback to the next provider? |
|---|---|
| `provider_error`, `rate_limited` | yes — definite non-acceptance |
| pre-submission skip: lifecycle not `active`, circuit `open`, half-open slots full | yes — no submission happened |
| `timeout`, `unknown` | **no** — `OUTCOME_UNKNOWN` (§7) |
| `auth_error`, `configuration_error`, `invalid_request`, `invalid_recipient`, `unsupported_content` | **no** — the message fails; never treated as provider outage |

The circuit classification is unchanged (timeout and unknown still count as circuit failures); fallback and circuit are separate rules.

- **Termination (D14):** at the first of accepted, non-fallback outcome, ambiguous outcome, or no remaining candidate; one pass over the ordered candidates, each provider at most once per message; no waiting and no timers.
- **No same-provider retry (D15).**
- **Boundary (D30):** Phase 3 = same-channel (WhatsApp), submission-outcome-driven, single-pass provider-to-provider fallback over the organization's assignments. Phase 5 = cross-channel fallback, delivery-outcome fallback with wait windows (`deadline_at`), `fallback_policies`/`fallback_steps`, combined chains. Routing policies, weights, canary and optimization stay out of Phase 3 (F18). Candidate order: OPEN (D03).

## 9. Dispatch execution, fencing and the `acc_dispatch` principal (D06, D17, D18)

### 9.1 Dispatch queue and fencing (D17)

- `message_dispatch_queue(message_id PK → messages, org_id, available_at, dispatch_epoch, claim_token, claimed_until, claimed_by)`, composite FK `(message_id, org_id) → messages(id, org_id)`; **no content, recipient or provider data**. A row exists only while the message is queued or routing and is deleted at a terminal state.
- **Claim:** a conditional `UPDATE … SET dispatch_epoch = dispatch_epoch + 1, claim_token = gen_random_uuid(), claimed_until = now() + lease, claimed_by = :instance … FOR UPDATE SKIP LOCKED … RETURNING message_id, org_id, dispatch_epoch, claim_token`. The claim token is generated by the database, never by a client.
- **Durable intent:** in the claim's processing transaction the attempt is inserted as `submitting` with `fencing_epoch` and `claim_token` **before** the provider is invoked; the invocation happens outside any transaction; the result is recorded only if the attempt is still `submitting` and the epoch and token are current.
- **Stale workers:** a takeover issues a new token and epoch; every read and write of the stale worker affects zero rows (§9.2); its result is not applied to the message.
- **Session context per message:** `SET LOCAL app.current_org_id`, `app.dispatch_message_id`, `app.dispatch_claim_token`, all taken from the claim's `RETURNING` row (`TENANCY.md` §5).

### 9.2 `acc_dispatch` (D06)

- **Role:** `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT n`; no role membership; owns nothing; credential through `SecretsPort`; host-restricted (`pg_hba`). Used only by the dispatcher, never by an HTTP request. **Every `acc_app` policy is unchanged.**
- **Functions:** `app_current_org_id`, `app_dispatch_message_id`, `app_dispatch_claim_token` (plain `STABLE` SQL), `uuidv7`, and the existing `app_session_bypasses_rls` (required by the guard). **No new `SECURITY DEFINER` function.** No sequences exist.
- **Per-message predicate:** `claim_valid(msg)` = a queue row for `msg` whose `message_id = app_dispatch_message_id()`, `org_id = app_current_org_id()`, `claim_token = app_dispatch_claim_token()` and `claimed_until > now()`.
- **Assignment proof:** `assignment_ok(org, provider)` = an `active` assignment for the pair; plus the composite FK `message_attempts(org_id, provider_id) → organization_provider_assignments(org_id, provider_id)`.

| Table | `acc_dispatch` access |
|---|---|
| `message_dispatch_queue` | `SELECT`/`UPDATE` of identifiers and claim columns across organizations (discovery and claim); `DELETE` only under `claim_valid` |
| `messages` | `SELECT`, `UPDATE` of status/current-attempt/failure/completion columns, only under `claim_valid(id)`; **no `INSERT`, no `DELETE`** |
| `message_attempts` | `SELECT`, `INSERT`, `UPDATE` of outcome columns, only under `claim_valid` with the current token and epoch; `INSERT` also requires `assignment_ok` and an `active` organization (§12) |
| `message_events` | `INSERT` only, under `claim_valid`; append-only |
| `organization_provider_assignments` | `SELECT` of the claimed message's organization's active rows |
| `providers` | `SELECT` and `UPDATE` of the eight observation columns only (`health_state, health_changed_at, circuit_state, circuit_generation, circuit_changed_at, circuit_probe_successes, circuit_probes, updated_at`), only for providers with `assignment_ok` under a valid claim |
| `provider_capabilities`, `provider_health` | `SELECT` on the same providers; `provider_health` `INSERT` of `submission` samples only (§9.3) |
| `provider_circuit_policy`, `channels` | `SELECT` |
| `organizations` | `SELECT (id, status)` of the claimed message's organization only |
| everything else | none — no users, sessions, roles, API keys, audit, idempotency, contacts, consents, templates, suppressions or workspaces |

### 9.3 Circuit and health state written by the dispatcher

Provider health and circuit state are **platform-global**, shared by every organization using the provider (Phase 2 design).

- **Only through the authoritative path.** The dispatcher changes circuit and health state only by calling the existing `ProviderStateStore` (`admit`, `recordSubmission`) under the provider row lock, and reaches the adapter only through `ProviderSubmissionExecutor.execute(admission, …)`. The failure-threshold arithmetic stays in the TypeScript state machine; it is not reimplemented in SQL. Structural tests pin that no file other than `provider-state.store.ts` writes the observation columns and that the dispatcher calls `this.state.admit(` and `this.state.recordSubmission(` (§14).
- **Database enforcement (`fn_providers_state_guard`, `SECURITY INVOKER`, an `acc_dispatch` branch):** administrative columns and `health_override` are refused (also by column privileges); only the four legal edges with the generation advancing by exactly one; every failure or success edge, every `health_state` change and every `circuit_probe_successes` increment requires a `provider_health` `submission` sample inserted **in the same transaction** (`created_at = now()`) for that provider, tagged with the pre-transition `circuit_generation` — so one sample can drive at most one transition; `circuit_probes` may only gain or lose the slot whose id is the session's claim token, or drop expired slots.
- **Evidence is bound to the exact attempt:** `provider_health.attempt_id` with a composite FK `(attempt_id, provider_id) → message_attempts(id, provider_id)`, one `submission` sample per attempt (partial unique index), and an `INSERT` check requiring the attempt's organization, claim token, `submitting` status and fencing epoch to be current. A sample for another claim, provider, organization, or a stale or terminal attempt is rejected.
- **Cooldown:** `open → half_open` timing is enforced by the authoritative `ProviderStateStore` on the injected `ProviderClock` (as in Phase 2), **not by PostgreSQL `now()`** — a database clock check would contradict the injected clock the circuit runs on.

### 9.4 Operational configuration (D18)

Poll interval 1 s (±20 % jitter), batch 10 per instance, lease 30 s — operational configuration, not contract values. The lease must exceed the longest legitimate hold (claim, CircuitAdmission validity 5 s, the 3000 ms submission timeout, the record) by a wide margin. The dispatcher runs in the process that issues CircuitAdmissions.

### 9.5 Accepted residual risks (D06)

- **Compromised `acc_dispatch` credential or process:** it can list queued identifiers across organizations; claim queued messages one at a time and read each claimed message's content and recipient and its organization's assigned providers; record **fabricated** submission outcomes through the legitimate path, influencing shared provider health and circuit state and so affecting other organizations using those providers; set a claimed message to a terminal state, including `PROVIDER_ACCEPTED` without a provider call; and **advance `open → half_open` before the cooldown**, which only opens probe slots — closing a circuit still requires success evidence. It cannot read historical messages, contacts, consents, templates, users or audit, create messages, change provider configuration, or touch unassigned providers. **ACCEPTED for Phase 3** (simulator only, F2; shared circuit state is an approved Phase 2 property; credential and host separation; claim metrics). **Re-review is mandatory before any real provider is connected.**
- **Grant revocation after acceptance** does not stop dispatch of an already-accepted message.

## 10. SimulatorAdapter (D19, D20)

- `POST /providers/:id/test-send` stays the Phase 2 direct, non-persisted test path. The Phase 3 send path (`POST /messages`) exercises the complete persisted lifecycle.
- **Behaviour selection (D19):** a reserved capability key `simulator_behavior` on a provider whose adapter is `simulator`, set through the existing platform `PUT /providers/:id/capabilities` (`providers.manage`, audited); value one of the seven Phase 2 behaviours, default `SUCCESS`; refused for any other adapter and ignored by the dispatcher for non-simulator adapters; never a message field or a header. The dispatcher reads it from PostgreSQL, never from the advisory hot-reload snapshot.
- **No delivery or webhooks (D20):** Phase 3 has no delivery events, no inbound webhook path and none of the delivery behaviours (`DELIVERY_DELAY`, `DELIVERY_FAILURE`, `DUPLICATE_WEBHOOK`, `OUT_OF_ORDER_WEBHOOK`). Acceptance means provider submission acceptance or result only — never delivery. Their target phase is OPEN.

## 11. Templates, consent, suppression (D21, D23)

- **Templates (D21):** organization-owned; `approval_status` (`draft`, `pending`, `approved`, `rejected`) is a **simulated, internal state**, moved by an explicit audited action under `templates.manage`; it does not represent and must not be presented as Meta or provider approval. No vendor approval workflow and no `provider_template_map` in Phase 3. Ownership detail beyond this and use in sends: OPEN (D22, D24).
- **Consent mechanism (D23):** `consent_events` — append-only (`id, org_id, workspace_id, contact_id, channel_id, consent_type, event ∈ {grant, revoke}, seq, occurred_at, recorded_at, source, recorded_by`), contact-scoped (and so workspace-scoped) through a composite FK, channel as a foreign key to `channels`. **Current consent** for `(contact_id, channel_id, consent_type)` exists only if the event with the highest `seq` is a `grant`; a later `revoke` supersedes an earlier `grant`; a later `grant` restores it; every row is retained. `UNIQUE (contact_id, channel_id, consent_type, seq)` gives each key a total order; a trigger requires `seq = max + 1` for the key, with the writer serialized on the contact row (`FOR UPDATE`) or retrying on a unique violation; a lookup index on `(contact_id, channel_id, consent_type, seq DESC)`. No mutable current-state column.
- **Product/compliance decisions — not architecture, not decided:** the template category set; the category-to-consent requirement mapping (transactional and promotional); workspace versus organization consent sharing; the withdrawal window for already-queued messages. These depend on WhatsApp Business policy and applicable law (for example India's DPDP Act): verify with a qualified professional before acting.
- **Default until decided (an engineering placeholder, not a compliance claim):** templates carry a category from `{transactional, marketing}`; a send requires a current grant of the identically named consent type for `(contact, whatsapp)`; absence refuses; no dispatch-time re-check. It must not be used for production traffic until the product/compliance decisions are made.
- **Suppressions:** organization-owned; precedence relative to consent, template validity and provider eligibility: OPEN (D22).

## 12. Organization lifecycle during dispatch (D29)

- **Phase 1C F-5 is unchanged for `acc_app` and every HTTP or application principal.** Sends in a suspended or closed organization are refused (`409 ORGANIZATION_LIFECYCLE_CONFLICT`).
- **Serialization:** a `BEFORE UPDATE OF status` trigger on `organizations` takes `pg_advisory_xact_lock(<org key>)` (exclusive); the `acc_dispatch` dispatch guards (`QUEUED → ROUTING`, attempt `INSERT`, the admission branch of the provider guard) take `pg_advisory_xact_lock_shared(<org key>)` before reading `organizations.status`. A claim committed before the lifecycle transition is in flight; a claim that starts after it waits and then sees the new status. No new definer function and no `UPDATE` privilege on `organizations`.
- **In a suspended or closed organization:** no new attempt, no new CircuitAdmission, and no `QUEUED → ROUTING` — all three require an `active` organization; no claim can become an executable dispatch.
- **Narrow `acc_dispatch` exception:** only an attempt that was already `submitting` before the lifecycle transition, under the **current** claim token and fencing epoch, may be terminalized (`accepted`, `rejected`, `outcome_unknown`), with its message moved to a terminal state (or, in a suspended organization, back to `QUEUED` and held after a fallback-eligible failure; in a closed organization to `FAILED`), its events and its Phase 2 observation recording. Lease-expiry recovery may only map a `submitting` attempt to `outcome_unknown`. A stale, fenced or non-`submitting` attempt cannot use the exception.
- **Queued work:** suspended — held (only the dispatcher's own claim is released; no message write), resumed on reactivation; closed — `QUEUED → FAILED` with `ORGANIZATION_CLOSED`, no attempt.
- **Terminal states cannot transition.** The exception is not a generic system bypass: it is limited to the principal, tables, columns and transitions above.

## 13. API contracts

No Phase 3 endpoint exists and the OpenAPI document is unchanged. Requirements are registered in `PHASE-3-API-CONTRACT-REGISTER.md`; general conventions (envelope, pagination, error body, idempotency header, audit in the same transaction) are EXISTING CONTRACT.

## 14. Required security and concurrency tests

Categories: horizontal and vertical isolation; scope substitution; enumeration; cross-reseller, cross-organization, workspace and team isolation; provider-assignment, message, contact, suppression and template isolation; RLS bypass with the service layer bypassed; CircuitAdmission forgery, reuse, foreign and expired tokens; stale execution; duplicate submission; idempotency replay; crash recovery.

**Gate E.3 requirements — D06 and D29 proofs (NOT implemented, no evidence claimed):**

- **D06:** structural tests that only `provider-state.store.ts` writes the observation columns and that the dispatcher calls `this.state.admit(` and `this.state.recordSubmission(` and is a pinned submission path; database cases rejecting direct circuit-state updates without evidence, illegal edges, generation manipulation, two transitions on one sample, probe-slot manipulation, `circuit_probe_successes` without evidence, `health_override` and administrative-column writes, unassigned providers, providers assigned only to another organization, disabled assignments, stale claim tokens, foreign or non-`submitting` `attempt_id`, a second sample per attempt; the legitimate store path matching Phase 2 transitions; mutation proofs removing each guard rule, predicate, grant restriction and structural pin.
- **D29:** deterministic two-connection tests of both lock orders (claim before suspension is terminalized; claim after suspension is rejected); no attempt, admission or `QUEUED → ROUTING` in suspended or closed organizations; closed `QUEUED → FAILED`; suspended `QUEUED` held and resumed; stale, fenced or non-`submitting` attempts refused the exception; recovery only to `outcome_unknown`; terminal re-transition refused; F-5 unchanged for `acc_app`; mutation proofs removing each `active` conjunct, each advisory lock, the epoch/token conjuncts and the terminal guard.

## 15. Open increment-level decisions (not freeze blockers)

D03 (candidate order), D05 (assignment administration), D07 and D08 (workspace context), D10–D12 (state names, attempt fields, event types), D22 (refusal order and persistence), D24 (send API shape), D25 (contact identities), D26 (audit versus events), D28 (increments and gates); the D23 product/compliance decisions; the target phase of delivery and webhook behaviours. Recorded in `PHASE-3-OPEN-DECISIONS.md`.

## 16. Documentation reconciled by this ADR

`ROADMAP.md` §6 and §8; `TESTING.md` §2; `DECISIONS.md` (ADR-012 F-5 note, ADR-013 PD-3 note, ADR-014 entry); `TENANCY.md` §1c; `ARCHITECTURE.md` §6; `SECURITY.md` §3c and §7; `DATABASE.md` (principals, templates, consent events, Phase 3 planned tables); `PROVIDER_ADAPTER.md` §6e; `RBAC.md`; `FALLBACK_ENGINE.md`, `ROUTING_ENGINE.md`, `EVENTS.md` phase notes; `PHASE-3-OPEN-DECISIONS.md`; `PHASE-3-API-CONTRACT-REGISTER.md`.
