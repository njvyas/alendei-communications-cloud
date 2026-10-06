# Phase 3 — architecture decision proposal (P3-D01 … P3-D30)

**Status: REVIEW RECORD — superseded by `ADR-014-PHASE-3-WHATSAPP-ORCHESTRATION.md` for every decision frozen at the Phase 3.0 freeze (06-Oct-2026).** For the decisions the ADR records as APPROVED or ESTABLISHED (D02, D06, D09, D16–D21, D23 mechanism, D29, D30, and the established parts of D01, D04 and D13) the ADR governs; in particular the D06 design here (claim columns on `messages`, cross-tenant message claim) and the D23 mutable-consent design were **replaced** at the final review by the token-bound per-message model, the content-free dispatch queue, the evidence-bound circuit branch and append-only consent events recorded in the ADR. For the decisions still open (D03, D05, D07, D08, D10–D12, D22, D24–D26, D28, and D01 reseller/platform defaults, D04 workspace/team use, D13 positive triggers, D14, D15, D27) the recommendations below remain proposals awaiting approval. Originally written 06-Oct-2026. Companion to `ADR-014-PHASE-3-WHATSAPP-ORCHESTRATION.md` (frozen decisions F1–F19) and `PHASE-3-OPEN-DECISIONS.md` (the questions). No application, schema, migration, OpenAPI or frontend change is made or authorized by this document.

**Classification.** `DERIVED — should be adopted`: follows directly from a frozen v9 decision or an existing canonical contract. `RECOMMENDED — user approval required`: a design choice that fits every constraint but is not forced by them. `REQUIRES USER DECISION`: the evidence does not distinguish the alternatives.

**Evidence order used** (as instructed): (1) ADR-014 F1–F19; (2) canonical documents; (3) Phase 1–2 implementation patterns; (4) established PostgreSQL/RLS/concurrency constraints; (5) recommendation.

## 1. Executive summary

The proposal keeps Phase 3 small and conservative:

- **Provider assignments** are organization-owned rows that point at the platform catalogue. They are administered only by platform holders of `providers.manage`. They are ordered by a unique integer priority, and every workspace in the organization uses them as they are. Inheriting the configuration never confers authority to send (D01–D05).
- **A dedicated, least-privilege dispatch principal** (`acc_dispatch`) runs the PostgreSQL poller.
  - It sees only the providers assigned to the organization whose message it is processing.
  - It may write only the provider observation columns the Phase 2 guard already permits test-send to write.
  - It is never used by an HTTP request.
  - The tenant `acc_app` policies and the catalogue RLS stay exactly as they are, and no `SECURITY DEFINER` function is added (D06, D18).
- **The workspace** is named explicitly with `workspaceId`, following the Teams API precedent. It is resolved and authorized server-side: a workspace in another organization is 404; a workspace in the same organization but outside the caller's grant is an audited 403. Team grants do not cover workspace-owned resources (D07, D08).
- **Execution.** A send is accepted synchronously and dispatched asynchronously; the client polls the message (D24).
  - **Durable record before every invocation.** Before any simulator call the dispatcher writes a `submitting` attempt under a fencing epoch. Timeouts, unknown outcomes and crashes during an invocation are therefore never re-submitted and never fall back. They end in an explicit "outcome unknown" terminal state (D10, D16, D17).
  - **When fallback happens.** Only definite provider-side non-acceptance (`provider_error`, `rate_limited`) and pre-submission skips move to the next assigned provider.
  - **When fallback never happens.** Customer, configuration, authentication and invalid-request outcomes fail the message without fallback (D13, D14).
  - **No retry engine.** There is no same-provider retry (D15).
- **Phase 3 completes at provider acceptance.** Delivery receipts, webhooks and wait-window fallback stay outside Phase 3.1 (D20, D30).
- **Ten items need your explicit decision.** They are listed in §7.

## 2. Decisions

### Provider assignments

#### P3-D01 — Ownership and catalogue relationship — `DERIVED — should be adopted`

- **Recommended:** `organization_provider_assignments(org_id NOT NULL → organizations, provider_id NOT NULL → providers, …)`. The row is organization-owned and references a platform `providers` row. It is unique on `(org_id, provider_id)`. There are no reseller- or platform-level defaults in Phase 3.
- **Rationale:** The v9 name (F19). The rule that every tenant-scoped table carries `org_id` (`DATABASE.md` §1). Reseller and white-label provider administration were excluded in Phase 2 (ADR-013 PD-6), and Phase 3 does not reopen that.
- **Security:** Tenant RLS by organization applies unchanged. The provider reference discloses only an id.
- **Integrity:** Providers are never deleted (ADR-013), so the FK is stable.
- **Rejected:** reseller defaults (re-introduces excluded reseller provider administration; needs a second RLS model).

#### P3-D02 — Eligibility — `RECOMMENDED — user approval required` (one sub-point `REQUIRES USER DECISION`)

- **Recommended:** A provider is a candidate for a message attempt only when every one of these holds:
  1. An assignment exists for the message's organization.
  2. The provider's channel is the message's channel (WhatsApp, F1).
  3. The provider's lifecycle is `active`. `draining` and `disabled` are excluded, by lifecycle precedence in `PROVIDER_ADAPTER.md` §6f and the meaning of draining in §4.
  4. It has not already been attempted or skipped for this message (D14).
  5. Its circuit is not `excluded_open` by the advisory `routingEligibility()` (§6h). The authoritative decision is CircuitAdmission at submission (F16).
- **Health and capability:**
  - Health is **not** consulted. This follows `PROVIDER_ADAPTER.md` §5.0, §6f: health never gates a submission.
  - No capability filter applies in 3.1, because no capability vocabulary is frozen.
- **Assignment status — REQUIRES USER DECISION:** existence-only (unassign = delete, kept in audit before/after) versus an `active|disabled` status column (unassign without deletion).
- **Security:** A tenant cannot reach an unassigned provider.
- **Concurrency:** Eligibility is re-read at each attempt (`FALLBACK_ENGINE.md` §2 re-evaluation principle), so a provider disabled mid-chain is not used.
- **Rejected:**
  - Health gating (contradicts §5.0).
  - Treating draining as eligible for new messages (contradicts §4).

#### P3-D03 — Priority and order — `RECOMMENDED — user approval required`

- **Recommended:** An integer `priority ≥ 1` on the assignment, unique per `(org_id, channel_id)`. `channel_id` is denormalized from the provider and kept consistent by a composite FK `(provider_id, channel_id) → providers(id, channel_id)`.
  - Candidates are tried in ascending priority. There are no ties, so no tiebreak is needed.
  - The order is re-read at each attempt.
- **Rationale:** F6 (deterministic). F18 excludes routing policies, weights and fallback-policy CRUD; a single ordered list per organization is the smallest deterministic model.
- **Concurrency:** A priority change during a chain applies from the next attempt. Every attempt records the provider actually used.
- **Rejected:**
  - `fallback_steps` (Phase 5 scope).
  - Weights (F18).
  - Non-unique priority with a provider-id tiebreak (an order nobody chose explicitly).

#### P3-D04 — Workspace inheritance and team behaviour — `DERIVED — should be adopted`

- **Recommended:** Assignments are organization-level configuration, used unchanged by every send in that organization, whatever the workspace or team. There are no workspace or team overrides in Phase 3.
- **Rationale:** D01; F18.
- **Separation of configuration and authority:**
  - Inheriting the configuration confers **no** authority.
  - The right to send comes only from `messages.send` covering the message's workspace (D09), evaluated by the existing five-scope evaluator with downward-only inheritance (`TENANCY.md` §1a.4).
- **Rejected:** per-workspace narrowing. It needs application-layer enforcement below the RLS boundary and is not needed for Phase 3.

#### P3-D05 — CRUD authority — `RECOMMENDED — user approval required`

- **Recommended:**
  - **Writes:** create, update (priority) and delete/disable require the existing `providers.manage` at **platform** scope. No new permission key.
  - **Reads:** platform `providers.read` reads assignments.
  - **No tenant HTTP surface for assignments in Phase 3.1.** Tenants see which provider served each attempt through the message-attempt read (D11), not through the assignment list.
  - **Route:** a platform route naming the organization as a path parameter. The organization is a target the platform principal is authorized for, never a tenant claim.
  - **Audit:** at platform scope (ADR-013 F-4).
- **Rationale:** Provider administration is platform-only (ADR-013 PD-5). Organization self-service would be new scope.
- **Security:** Prevents vertical escalation, because a tenant cannot attach a provider to itself.
- **Rejected:**
  - Organization-administrator self-service.
  - A new `provider_assignments.*` key (not needed while administration is platform-only).

#### P3-D06 — RLS, isolation and catalogue access in tenant execution — `RECOMMENDED — user approval required`

**Problem.** In Phase 2, catalogue reads require a validated platform-scope claim, and observation writes (circuit state, probe slots, `provider_health` samples) require platform `providers.test_send` (`providers_platform_observation_update`, migration `0022`). The Phase 3 dispatcher acts for a tenant message and holds neither. ADR-013 2.4 residual (e)(4) anticipated this.

**Recommended: a dedicated database principal `acc_dispatch`.** It is used only by the dispatcher process and never by an HTTP request. It follows the purpose-specific-principal precedent of `acc_auth` and `acc_relay` (`DATABASE.md` §principals). It runs every per-message transaction with `SET LOCAL app.current_org_id` derived from the claimed message row (`TENANCY.md` §5, steps 3–7; `withTenantTransaction`).

Its grants and policies:

| Area | `acc_dispatch` access |
|---|---|
| `messages` | Cross-tenant `SELECT`/`UPDATE` restricted to the claim columns and dispatchable states, for the claim step only (D18) |
| Tenant tables under organization context | messages, attempts, events |
| `providers` | `SELECT` only where an assignment exists for `app_current_org_id()` |
| `provider_capabilities` | `SELECT` on the same assigned providers |
| `provider_circuit_policy` | `SELECT` |
| Provider observation state | `UPDATE` of the observation columns of an assigned provider. The existing `fn_providers_state_guard` is extended so `acc_dispatch` is treated exactly as a `providers.test_send` holder: administrative columns stay refused, and the circuit can move only along its four edges. |
| `provider_health` | `INSERT` of `submission` samples only |

What does **not** change:
- No `acc_app` policy changes. HTTP requests still cannot read the catalogue.
- No `SECURITY DEFINER` function.
- `acc_auth` and `acc_relay` get nothing.

- **Rationale:**
  - It is least privilege, expressed in RLS.
  - It keeps the catalogue sealed from tenant HTTP paths.
  - It reuses the Phase 2 guard rather than reimplementing admission in SQL.
  - The cross-tenant claim is a narrow, reviewable exception, in the same way `acc_relay` is cross-tenant by necessity.
- **Security:** A new principal and connection string (deployment secret reference) need review. Tests must prove:
  - `acc_dispatch` reads no unassigned provider;
  - it writes no administrative column;
  - it reads no other organization's message outside the claim columns.
- **Concurrency:** The lock order is message row, then provider row. Phase 2's "one provider row per transaction" holds.
- **Rejected:**
  - SECURITY DEFINER read and admission functions. They have a wider blast radius, would duplicate the admission logic, and every new definer requires a stop-and-report under the Phase 2 rule.
  - `acc_app` policies for assigned providers. They would expose catalogue state to every tenant HTTP transaction, which you prohibited.
  - Running the dispatcher as the owner or with `BYPASSRLS`. That violates the principal rule of `DATABASE.md`.
  - Transaction-local `app.is_platform_admin` elevation. That is a CLI-only mechanism (`RBAC.md` §5b).

### Tenancy

#### P3-D07 — Workspace selection for organization-scoped users — `DERIVED — should be adopted`

- **Recommended:** Follow the existing Teams contract.
  - **Creates** name the workspace in the body (`workspaceId`, required).
  - **Lists** take an optional `workspaceId` query filter. Without it, a list returns everything the caller's grants cover in the selected organization.
  - **Reads by id** derive the workspace from the row.
  - The organization still comes only from `X-Acc-Organization`. No workspace header.
- **Server-side resolution:** the server resolves `workspaceId` with `ScopeChainResolver` inside the request's RLS-enforced transaction, then asserts the permission at the workspace target (`RBAC.md` §2a).
  - An organization grant covers every workspace downward.
  - The client's identifier selects a target. It never establishes ownership or authority.
- **Rationale:**
  - `CreateTeamDto.workspaceId` and `ListTeamsDto.workspaceId` already work this way (`teams.controller.ts`).
  - Composite FKs `(workspace_id, org_id) → workspaces(id, org_id)` make a mismatched pair unrepresentable (`DATABASE.md` §1C.6).
- **Rejected:**
  - A workspace header (a second ambient selector, with mismatch ambiguity).
  - Path nesting under `/workspaces/:id` (breaks the existing list conventions; no precedent).

#### P3-D08 — Workspace- and team-scoped users; mismatches — `DERIVED — should be adopted`

| Case | Result | Basis |
|---|---|---|
| Workspace grant, its own workspace | allowed (permission permitting) | downward coverage |
| Workspace grant, another workspace of the same organization | `403 AUTHZ_SCOPE_DENIED`, audited | the target resolves under organization RLS; authorization denies |
| A team grant only | `403`: a team grant does not cover workspace-owned resources | downward-only, `TENANCY.md` §1a.4 |
| `workspaceId` of another organization, or nonexistent | `404` that confirms nothing | `API.md` §3a, `ScopeChainResolver` |
| `workspaceId` missing on a create | `400 VALIDATION_FAILED` | required field |
| `X-Acc-Organization` outside the caller's scope | `403 TENANCY_CONTEXT_MISMATCH` | existing |
| Archived workspace | `409` (existing workspace lifecycle semantics) | Phase 1C |

- **Security:** Covers scope substitution and enumeration. Both rely on the resolver's "invisible means 404" rule.

### Permissions

#### P3-D09 — Keys and scopes — `RECOMMENDED — user approval required`; reseller coverage `REQUIRES USER DECISION`

**Evaluation.**
- Phase 1 uses fine-grained verbs (`create`/`update`/`delete`).
- Phase 2 established `read` / `manage` plus a named action (`providers.test_send`).
- Phase 3 is closer to Phase 2: a small domain where the split between create, update and delete has no distinct risk. The eight proposed keys match that convention.

**Recommended keys** (no others):

| Key | Covers | Allowed grant scopes |
|---|---|---|
| `contacts.read` | contacts, identities, consents | organization, workspace |
| `contacts.manage` | create/update/delete of contacts, identities, consents | organization, workspace |
| `templates.read` | templates | organization |
| `templates.manage` | create/update/delete and the approval action (D21) | organization |
| `suppressions.read` | suppressions | organization |
| `suppressions.manage` | create and lift suppressions | organization |
| `messages.read` | messages, attempts, events | organization, workspace |
| `messages.send` | `POST /messages` | organization, workspace |

**Scope rules:**
- **Team scope is excluded.** The resources are workspace- or organization-owned, and inheritance is downward only.
- **Platform scope is excluded.** Platform principals hold no tenant-data permission (`platform.*` is separate).
- **Grant level must match resource ownership.** Organization-owned resources (templates, suppressions) require an organization grant. A workspace grant does not cover them, because coverage never goes upward.
- **Using a template is not reading it.** A workspace-scoped sender may reference an approved template in its organization. The send service validates the reference; the sender needs no `templates.read`.
- **No role names.** Authorization uses no role name. Seeded role mapping is done by migration (D22 precedent).

**Reseller coverage — REQUIRES USER DECISION.** Whether reseller-scope grants cover these permissions for organizations under the reseller is open. Recommendation: exclude them in Phase 3, consistent with the reseller and white-label exclusions.

**Rejected:**
- Separate identity or consent keys (no distinct risk).
- `messages.cancel` (no cancellation in Phase 3).

### Message lifecycle

#### P3-D10 — Message state machine — `RECOMMENDED — user approval required`

States are a subset of the canonical names in `ARCHITECTURE.md` §6, plus one added terminal state.

```
QUEUED ──claim──▶ ROUTING ──attempt accepted──────────────▶ PROVIDER_ACCEPTED   (terminal, success)
   ▲                 │──fallback-eligible failure, next candidate──▶ ROUTING (new attempt)
   │                 │──non-fallback failure / candidates exhausted / no candidate──▶ FAILED (terminal)
   │                 └──ambiguous outcome or crash during invocation──▶ OUTCOME_UNKNOWN (terminal; D16)
   └── lease expired, no attempt in flight: back to QUEUED for re-claim (D18)
```

- **No `CREATED`/`VALIDATED` state.** Validation and refusal happen before the row exists (D22).
- **States not present in 3.1:**
  - `DELIVERED`, `READ` and `EXPIRED`, unless D20 adds delivery.
  - No cancellation.
- **Writes:** every transition is a state-guarded conditional `UPDATE … WHERE status = :expected AND dispatch_epoch = :epoch` (F7; `FALLBACK_ENGINE.md` §4 conditional-transition pattern).
- **Naming of the ambiguous terminal state:** `REQUIRES USER DECISION` (D16).
- **Rejected:**
  - Marking ambiguous outcomes as `FAILED`. A message that was possibly sent would be reported as not sent.
  - `SENT`. It implies delivery semantics the simulator does not model.

#### P3-D11 — Attempt identity and lifecycle — `DERIVED` for numbering and keys; `RECOMMENDED` for states

- **`attempt_number`:** one global, monotonic counter per message, unique `(message_id, attempt_number)` (`FALLBACK_ENGINE.md` §3; `DATABASE.md` §6). DERIVED.
- **Columns:**
  - `provider_id`, `channel_id`
  - `fencing_epoch` (D17)
  - circuit ticket fields: `circuit_generation`, `circuit_probe` flag
- **Idempotency:** `provider_idempotency_key` = the attempt id, and the Phase 2 `ProviderSubmission.submissionId` is set to it (`DATABASE.md` §7.3; `PROVIDER_ADAPTER.md` §2a). It is never regenerated. DERIVED.
- **Statuses:** `submitting` (written before invocation, D17) → `accepted` | `rejected` (with the Phase 2 category, retryability and latency) | `outcome_unknown`.
- **Creation:** an attempt row is created **only after CircuitAdmission granted**. A refused admission or an ineligible provider is a message event (`provider_skipped`), not an attempt.
- **Timestamps:** `created_at` (intent), `submitted_at`, `completed_at`.
- **Not copied from `DATABASE.md` §6:** no `routing_policy_*`, `pricing_*` or `retry_count` columns (F14, F18, D15).
- **CircuitAdmission (F16):** issued in the claim transaction, redeemed by `ProviderSubmissionExecutor.execute`, and recorded in a second transaction that applies Phase 2's stale-ticket rules (§6d).

#### P3-D12 — Event types and ordering — `RECOMMENDED — user approval required`

- **Storage:** `message_events` is append-only, protected by a trigger and RLS (existing audit pattern). It is written in the same transaction as the state change it describes.
- **Event types** (names follow `EVENTS.md` §4 without the topic prefix):

| Level | Event types |
|---|---|
| Message | `message.queued`, `message.fallback_triggered`, `message.completed` (provider accepted), `message.failed`, `message.outcome_unknown` |
| Attempt | `attempt.started`, `attempt.provider_accepted`, `attempt.provider_rejected`, `attempt.outcome_unknown` |
| Dispatch | `provider.skipped` (lifecycle, circuit or half-open refusal), `dispatch.lease_expired` |

- **Ordering:** a per-message `sequence` (1, 2, 3 …) is assigned under the message row lock. It is gapless and monotonic. `recorded_at` is informational only.
- **Fields:** `source` (`api` or `dispatcher`), `correlation_id` (from the send request), `attempt_id` and `provider_id` where applicable, and `provider_message_id` on acceptance.
- **Not an event bus:** no consumer, no subscription, no publication (F11, F12). The table is read only through the API.

### Execution and fallback

#### P3-D13 — What triggers fallback — `DERIVED — should be adopted`

| Outcome (Phase 2 taxonomy, `PROVIDER_ADAPTER.md` §5b) | Fallback? |
|---|---|
| `provider_error` (5xx, outage, connection refused before answer) | **yes** — definite non-acceptance by the provider |
| `rate_limited` (429) | **yes** |
| Pre-submission skip: lifecycle not active, circuit `open`, half-open slots full | **yes** — skip, no submission happened |
| `timeout` | **no** — ambiguous (D16) |
| `unknown` | **no** — ambiguous (D16) |
| `auth_error` | **no** — the message fails (authentication is not outage; your requirement) |
| `configuration_error` | **no** — fails |
| `invalid_request`, `invalid_recipient`, `unsupported_content` | **no** — fails; it would fail identically anywhere (§5b) |

The circuit is unaffected: Phase 2 classification still drives the circuit (timeout and unknown count as failures there). The fallback rule and the circuit rule are separate tables.

#### P3-D14 — Termination — `DERIVED — should be adopted`

The chain ends deterministically at the first of:
1. an attempt accepted (`PROVIDER_ACCEPTED`);
2. a non-fallback outcome (`FAILED`);
3. an ambiguous outcome (`OUTCOME_UNKNOWN`);
4. no remaining candidate (`FAILED`, `NO_ELIGIBLE_PROVIDER`).

- **One pass:** a single pass over the ordered candidates, each provider at most once per message, whether attempted or skipped.
- **No waiting:** no wait for a circuit cooldown and no timer. This also bounds attempts by the number of assignments.
- **Basis:** F6 (deterministic). Wait windows are Phase 5 (D30).

#### P3-D15 — Same-provider retry — `DERIVED — should be adopted`

- **Recommended:** no same-provider retry in Phase 3. The Phase 2 executor submits once, and adding retry would create a retry engine.
- **Rejected:** `retry_count` from `FALLBACK_ENGINE.md` §3. Its risk is the same duplicate risk as D16.

#### P3-D16 — Timeout and unknown outcomes — `RECOMMENDED` (strongly implied by F6); terminal naming `REQUIRES USER DECISION`

A timeout, an `unknown` outcome, a missing acknowledgement, or a crash between "submitting" and recording means the provider may have processed the submission. Nothing in the fencing or idempotency model can prove otherwise across providers: the provider idempotency key de-duplicates only at the same provider, and `checkStatus` is a Phase 2 stub.

- **Rule:** such an attempt becomes `outcome_unknown`, the message becomes the terminal `OUTCOME_UNKNOWN`, and there is no fallback and no re-submission.
- **Simulator:** `TIMEOUT` is deterministic, so this path is testable.
- **What is not claimed:** "safe retry" is not claimed anywhere.
- **Open:** a later phase with real delivery receipts or `checkStatus` may resolve unknown outcomes.
- **Rejected:** falling back after a timeout (violates F6).

#### P3-D17 — Fencing representation — `RECOMMENDED — user approval required`

**Columns on `messages`:**
- `dispatch_epoch bigint`, incremented by every claim;
- `claimed_until timestamptz` (the lease).

**Claim transaction (as `acc_dispatch`, organization context from the row):**
1. Lock the message.
2. Increment the epoch.
3. Set the lease.
4. Select the candidate (D02, D03).
5. Lock the provider and take CircuitAdmission.
6. Insert the attempt with `status = submitting` and `fencing_epoch = epoch`, plus `attempt.started`.
7. Commit.

**Outside any transaction:** `executor.execute(admission, …)`.

**Record transaction:**
- Lock the message, then the provider.
- Conditional update: `… WHERE attempts.id = :id AND attempts.status = 'submitting' AND messages.dispatch_epoch = :epoch`.
  - **Zero rows (stale):** the result is not applied to the message. The health sample is still recorded, as in Phase 2 §6d. A `dispatch.stale_result` log line and metric are produced.
  - **Otherwise:** apply D13 and D14.

**Recovery.** A message whose lease has expired:
- with an attempt still `submitting` is treated per D16 (`outcome_unknown`), because the invocation may have happened;
- with no attempt in flight is re-claimed.

This is the "durable simulator invocation fencing" of F10: the intent is durable before the invocation, and only the current epoch can record.

- **Rejected:**
  - Redis locks (F8).
  - Advisory locks held across the invocation (lost on crash, invisible to recovery).

#### P3-D18 — Polling and worker model — `RECOMMENDED`; numeric values `REQUIRES USER DECISION`

**Process.** A dispatcher loop inside the API process, enabled by configuration. A separate deployable is deferred; this is the first real consumer of the TENANCY §5 harness (ADR-004 D-5). It connects as `acc_dispatch` (D06).

**Poll query:** `SELECT id, org_id … FROM messages WHERE (status = 'QUEUED') OR (status = 'ROUTING' AND claimed_until < now()) ORDER BY created_at, id LIMIT :batch FOR UPDATE SKIP LOCKED`. It runs in its own short transaction, which only stamps the lease. Each message is then processed in its own organization-scoped transaction (D17).

**Proposed defaults (decide):**

| Parameter | Proposed | Reason |
|---|---|---|
| Poll interval | 1 s, with jitter | — |
| Batch | 10 per instance | — |
| Lease | 30 s | Must exceed the 3 s submission timeout plus recording |
| CircuitAdmission validity | 5 s (existing) | The claim must invoke within it, or release and re-queue |

**Concurrency and safety:**
- `SKIP LOCKED` lets several instances poll without collision.
- A stale worker is excluded by the epoch (D17).
- There is no cross-instance coordination beyond PostgreSQL.
- Optional `LISTEN/NOTIFY` hints are not needed in 3.1.

**Rejected:**
- Redis queues (F8, F11).
- Kafka (F11).
- A transaction held across the invocation (Phase 2 §6e).

### Simulator

#### P3-D19 — Simulator behaviour for `POST /messages` — `RECOMMENDED — user approval required`

**Recommended:** provider-level simulator configuration. A reserved capability key, `simulator_behavior`, is set on a **simulator** provider through the existing platform capabilities route (`providers.manage`). It takes the Phase 2 enum and defaults to `SUCCESS`.

The dispatcher passes it to `SimulatorAdapter.forBehavior` for that provider's attempts:
- It is refused or ignored for any other adapter.
- It is never a message field and never a header.

Fallback tests become deterministic: provider A is configured with `500`, provider B with `SUCCESS`.

- **Rationale:**
  - Keeps simulator concerns out of the public message contract, so the future real-provider contract is unaffected.
  - Requires platform authority, so tenants cannot forge outcomes.
  - Reuses an existing administered surface.
- **Security:** the key must be validated against the behaviour enum. In production, simulator providers exist only by explicit platform configuration (F2).
- **Rejected:**
  - A request field or test header (leaks into the public API; tenant-forgeable).
  - Magic recipient addresses (pollutes contact data; collides with real numbers later).
  - Reusing test-send (it does not persist; ADR-014 §7).
- **Limitation:** behaviour is per provider, not per call. Scripted sequences on one provider are not possible, and none is needed for D13–D16.

#### P3-D20 — Delivery and webhooks — `REQUIRES USER DECISION` (recommendation given)

- **Recommendation:** exclude delivery events, webhooks and the delivery behaviours from Phase 3.1. "Completed" means `PROVIDER_ACCEPTED`: the provider accepted the submission, and nothing about delivery is asserted.
- **The open choice:** ROADMAP §6 still names webhook dedup tests and a signature review. Either:
  - add a later Phase 3 increment with deterministic simulated delivery events; or
  - move them to Phase 5 together with delivery-outcome fallback.
- **Rejected:** delivery in 3.1. It pulls Phase 5 wait-window semantics forward.

### Content and refusal

#### P3-D21 — Templates — `RECOMMENDED`; approval authority `REQUIRES USER DECISION`

- **Ownership and fields:** organization-owned (`DATABASE.md` §3 planned `org_id`), WhatsApp channel only. Fields: `name` (unique per organization and channel), `body`, `variables`, `approval_status`, `deleted_at`.
- **Lifecycle:** `draft → pending → approved | rejected`. A `rejected` template returns to `draft` on edit. Editing an `approved` template returns it to `draft`.
- **Approval:** simulated, by an explicit audited action. No vendor. `provider_template_map` is omitted in Phase 3 (no vendor ids).
- **Authority:** `templates.manage` at organization scope.
- **Use in sends:** Phase 3 sends are template-only. There is no inbound traffic or conversation window, so free-form session messages have no basis. A template that is not `approved` refuses the send synchronously, with no message row (D22).
- **Open — who may approve:**
  1. the same `templates.manage` holder (a simulation convenience); or
  2. a platform action (closer to the real Meta review).

#### P3-D22 — Refusal order and persistence — `RECOMMENDED — user approval required`

All checks happen synchronously, before anything is written:

1. **Authentication:** 401.
2. **Validation:** 400.
3. **Organization selection:** 403. Then `workspaceId` resolution: 404.
4. **Authorization:** `messages.send` at the workspace, 403, audited denial.
5. **Organization lifecycle:** suspended or closed gives `409 ORGANIZATION_LIFECYCLE_CONFLICT` (Phase 1C F-5).
6. **Idempotency:** replay or conflict (Phase 1C; F15).
7. **Contact:** the contact exists in the workspace (404) and has a WhatsApp identity (422).
8. **Suppression:** refused 422. Suppression always overrides consent.
9. **Consent:** refused 422 if there is no valid consent.
10. **Template:** approved, and the variables validate (422).
11. **Provider assignment:** at least one WhatsApp assignment exists for the organization (422). Catalogue state is evaluated at dispatch. A message with no live candidate then fails asynchronously (D14).

**What a refusal persists:**
- **Nothing is persisted** for a refusal at steps 1–11: no message, attempt or event row.
- **Audit:** only the authorization denial, through the existing mechanism.
- **Idempotency:** refusals are not stored (the Phase 1C stored-success semantics are reused).
- **Logs and metrics:** a metric and a log line, with a bounded reason label.

**Rationale:**
- Cheap and security checks come first.
- Suppression before consent: an opt-out must win even when stale consent exists.
- Persisting refusals would turn the message table into a request log.

**Rejected:**
- Accept-then-fail for business refusals. It creates rows for messages that were never eligible, and complicates idempotency.

#### P3-D23 — Consent and suppression — `DERIVED` for ownership; consent type mapping `REQUIRES USER DECISION`

- **Ownership (DERIVED):**
  - Consents belong to a contact; organization and workspace come through the contact's composite FK.
  - Suppressions are organization-owned (`DATABASE.md` §3). They apply to every workspace and need `suppressions.*` at organization scope.
- **Suppression shape:**
  - The target is a `contact_id` or a normalized `address`, with a CHECK that exactly one is set. Address suppression works before a contact exists.
  - `channel_id` NULL means all channels.
  - One active suppression per `(org_id, address-or-contact, channel)`.
  - Lifting is a recorded, audited end-date, not a delete.
- **Consent shape:**
  - Per `(contact, channel, consent_type)` with `granted_at` and `revoked_at`.
  - No row means no consent. WhatsApp is opt-in (`SECURITY.md` §7, Meta opt-in).
- **Precedence:** suppression, then consent (D22).
- **Composite FKs:** contact children carry `(contact_id, org_id)` composite FKs to `contacts(id, org_id)`, following the 1C.6 pattern.
- **Open — which `consent_type` a Phase 3 template send requires:** `marketing`, `transactional`, or a per-template category.

### API and phasing

#### P3-D24 — `POST /messages` — `RECOMMENDED — user approval required`

- **Request:** `POST /api/v1/messages` with `X-Acc-Organization`, a **required** `Idempotency-Key`, and body `{workspaceId, contactId, templateId, variables}`. The channel is implicitly WhatsApp in Phase 3. No raw address, no free content, no simulator field.
- **Response:** `202 {data: message}` with status `QUEUED`. The client polls `GET /messages/:id`, `/messages/:id/attempts` and `/messages/:id/events` (keyset-paginated).
- **Credentials:** sessions and API keys holding `messages.send`. API keys are already organization- or workspace-bound and are the machine-to-machine surface.
- **Rate limit:** the general limiter. No per-tenant quota in 3.1.
- **Rationale:**
  - Asynchronous, because dispatch is a poller (F9).
  - The key is required because the send is the duplicate-sensitive endpoint.
- **Rejected:**
  - A synchronous send (holds a request across the simulator).
  - An optional key.
  - Address-based sends (bypass the contact, consent and suppression model).

#### P3-D25 — Contact identities — `RECOMMENDED — user approval required`

- **Shape:** an identity belongs to one contact (and through it to a workspace). Channel WhatsApp in Phase 3. The address is normalized to E.164 (`+` and 8–15 digits) server-side.
- **Uniqueness:** unique `(workspace_id, channel_id, address)`. A duplicate is `409 RESOURCE_CONFLICT`.
  - The existing contact id may be named, since it is visible to the same workspace reader.
  - At most one `is_primary` per `(contact, channel)`.
- **Verification:** `verified_at` is unused in Phase 3.
- **Rejected:** organization-wide uniqueness. It conflicts with workspace ownership and would leak existence across workspaces.

#### P3-D26 — Audit versus events — `RECOMMENDED — user approval required`

There are three stores, each with one job:

| Store | Records | Phase 3 actions |
|---|---|---|
| `audit_logs` | Who did what through the API (existing rule, `SECURITY.md` §4) | contact, identity, consent, suppression, template and assignment mutations; template approval; `message.send_requested` (one row per accepted send, referencing the message id); authorization denials |
| `message_events` | What happened to a message | lifecycle only (D12), written by the API (`message.queued`) and the dispatcher. Never duplicated into audit |
| `message_attempts` | Each provider invocation | its own record; `provider_health` keeps circuit samples as in Phase 2 |

Dispatcher actions are system lifecycle, not security actions, and are not audited.

#### P3-D27 — Conversations — `DERIVED — should be adopted`

- **Recommended:** no conversations in Phase 3. There is no inbound path, so nothing creates a conversation. `messages.conversation_id` is not added in 3.1.
- **Deferred to:** the inbox phase (the seeded role text already says "Conversation permissions arrive with Phase 8D").

#### P3-D28 — Increments and gates — `RECOMMENDED — user approval required`

| Increment | Scope | Gate |
|---|---|---|
| **3.0** | This decision set approved and frozen into ADR-014; the OpenAPI and `FRONTEND_API_CONTRACT.md` §33 drafts written | E.0 (documentation review) |
| **3.1** | Contacts, identities, consents, suppressions, templates: tables, RLS, composite FKs, permission keys, CRUD, audit | E.1 |
| **3.2** | `organization_provider_assignments`, `acc_dispatch` principal and policies, guard extension; platform assignment API | E.2 (security review of the new principal) |
| **3.3** | `POST /messages` and reads; message, attempt and event tables; the dispatcher (claim, fencing, single attempt, no fallback); `OUTCOME_UNKNOWN`; recovery | E.3 (crash, stale-worker, duplicate and idempotency evidence) |
| **3.4** | Provider-to-provider fallback (D13, D14), simulator configuration (D19) | E.4 (deterministic fallback matrix) |
| **3.5** | Console (frontend track) | E.5 |
| **3.6** | Delivery simulation, only if D20 chooses it | E.6 |

Each gate follows the Phase 2 pattern: mutation proofs with assertion evidence, full regression three times, migrations from empty, the scope-creep and credential-absence checks extended, CI green.

#### P3-D29 — Suspended organizations — `DERIVED` for API behaviour; queued-message handling `REQUIRES USER DECISION`

- **API (DERIVED from Phase 1C F-5):**
  - A send and every tenant mutation are refused with `409 ORGANIZATION_LIFECYCLE_CONFLICT`.
  - Tenant reads follow the existing scope-resolver behaviour (`403 TENANCY_ORGANIZATION_*`).
  - Platform principals may still read.
  - Assignment administration (platform) continues.
- **In flight:** an attempt already `submitting` is recorded truthfully.
- **Recovery:** proceeds normally (D16, D17).
- **Open — what happens to `QUEUED` messages of a suspended organization:**
  - **(a) Hold** (the dispatcher skips them until reactivation). Recommended for suspended.
  - **(b) Fail** with `ORGANIZATION_SUSPENDED`. Recommended for closed, which is terminal.

#### P3-D30 — Phase 3 / Phase 5 boundary — `DERIVED — should be adopted`

- **Phase 3:**
  - same-channel (WhatsApp) provider-to-provider fallback;
  - triggered only by submission-time outcomes (D13);
  - a single deterministic pass over the organization's assignment order (D03, D14);
  - no timers or wait windows, no `fallback_policies`/`fallback_steps`, no routing policies.
- **Phase 5:**
  - cross-channel fallback;
  - delivery-outcome-driven fallback with wait windows (`deadline_at` poller, `FALLBACK_ENGINE.md` §4);
  - `fallback_policies`/`fallback_steps` CRUD;
  - combined provider-and-channel chains and the `TESTING.md` §3 critical scenario.
- **Routing-policy phase:** routing policies, weights, canary and optimization (F18).
- **Basis:** F4, F5, F18.

## 3. Evidence used (by decision)

| Source | Decisions it informs |
|---|---|
| ADR-014 F1–F19 | all |
| `PROVIDER_ADAPTER.md` §2, §2a, §4a, §5b, §5.0, §6c–§6h | D02, D06, D11, D13, D16, D17 |
| `FALLBACK_ENGINE.md` §2–§4 | D02, D03, D10, D11, D15, D17, D30 |
| `DATABASE.md` §1, §3, §6, §7, principals | D01, D06, D11, D21, D23 |
| `TENANCY.md` §1a.4, §5; `RBAC.md` §2a, §5b | D04, D06–D09, D18 |
| `ARCHITECTURE.md` §6, §6a, §9c | D10, D17 |
| `EVENTS.md` §4 | D12 |
| Phase 1C F-5; `scope-resolver`/`ScopeChainResolver`; Teams API | D07, D08, D29 |
| ADR-006 / Phase 1C idempotency | D22, D24 |
| ADR-013 PD-5, PD-6, F-3, F-4, 2.4 residual (e)(4) | D01, D05, D06 |

## 4–6. Security, concurrency, alternatives

Covered per decision above. The cross-cutting points (your ten concerns):

1. **Catalogue access in tenant execution:** a dedicated `acc_dispatch` principal; no `acc_app` change; no definer function (D06).
2. **No unsafe duplicate on timeout or unknown:** terminal `OUTCOME_UNKNOWN`; no fallback, no re-submission (D16).
3. **Crash-safe fencing:** a durable `submitting` attempt plus a message epoch; recovery never re-invokes (D17).
4. **Assignment inheritance is never authorization:** send authority comes only from `messages.send` at the workspace (D04).
5. **Client identifiers select, never authorize:** the resolver plus the permission evaluator decide; 404 or 403 as specified (D07, D08).
6. **`message_events` is not a bus:** no consumers or subscriptions; read only through the API (D12).
7. **No Kafka or outbox** (D12, D18).
8. **Redis has no role** in Phase 3 correctness (D17, D18).
9. **CircuitAdmission stays authoritative:** issued at claim, redeemed by the executor (D11, D17).
10. **No routing policy:** one priority-ordered list per organization (D03, D30).

## 7. Items requiring your explicit decision

1. **D02:** whether an assignment has a status column, or is deleted to unassign.
2. **D06:** approve the new `acc_dispatch` database principal and the guard-trigger extension.
3. **D09:** whether reseller-scope grants cover the Phase 3 keys (recommendation: no). Approve the eight key names.
4. **D16:** the name of the ambiguous terminal state (`OUTCOME_UNKNOWN` proposed).
5. **D18:** poll interval, batch size and lease values.
6. **D19:** simulator selection by provider-level configuration (`simulator_behavior` capability) versus another mechanism.
7. **D20:** delivery simulation in a later Phase 3 increment, or in Phase 5.
8. **D21:** who approves a template under simulation.
9. **D23:** which `consent_type` a Phase 3 template send requires.
10. **D29:** hold or fail `QUEUED` messages of a suspended organization.

## 8. Proposed gate sequence

See D28: 3.0 → 3.1 data foundation → 3.2 assignments and dispatch principal → 3.3 persisted single-attempt send with fencing → 3.4 provider fallback → 3.5 console → (3.6 delivery, if chosen).

## 9. Scope exclusions (Phase 3)

The following are out of Phase 3:
- real credentials or vendor calls; credential storage
- cross-channel fallback; wait-window or delivery-outcome fallback
- `fallback_policies`/`fallback_steps`
- routing policies, weights, canary, optimization
- campaigns, journeys, billing and pricing
- Kafka, outbox, event subscriptions, WebSocket
- inbound messages, conversations, the inbox
- free-form or address-based sends
- reseller or white-label provider administration
- per-workspace assignment overrides
- same-provider retry
- per-tenant quotas
- template vendor approval (`provider_template_map`)
- bulk import and segments

## 10. Residual risks

- **`OUTCOME_UNKNOWN` messages** are a real, customer-visible category. Customers may resend, and the API key and idempotency key do not protect a *new* request.
- **Shared circuit state.** One organization's traffic can open a shared provider's circuit for all organizations. This is by design (`PROVIDER_ADAPTER.md` §5b), but it is now cross-tenant in effect.
- **New cross-tenant principal.** `acc_dispatch` reads the claim columns across organizations, a new principal of that kind (as `acc_relay` was meant to be). It needs a dedicated security review.
- **Process-local admission.** The dispatcher must run in the process that issues admissions. A separate worker deployable later must keep that true.
- **No fairness.** No per-tenant fairness or back-pressure exists: a large organization's queue can delay others (oldest first).
- **Global simulator configuration.** Simulator configuration is per provider and global. Concurrent test suites sharing providers can interfere and must use dedicated providers.
- **Acceptance is not delivery.** "Completed" means accepted, not delivered, until delivery is modelled (D20).

## Compact table

| Decision | Recommendation | Classification |
|---|---|---|
| P3-D01 | Organization-owned row referencing platform `providers`; unique `(org, provider)`; no reseller/platform defaults | DERIVED — should be adopted |
| P3-D02 | Assignment + same channel + lifecycle `active` + not yet tried + circuit not open (advisory); CircuitAdmission authoritative; health not consulted; no capability filter | RECOMMENDED (status-vs-delete: REQUIRES USER DECISION) |
| P3-D03 | Unique integer priority per (org, channel), ascending, re-read per attempt | RECOMMENDED — user approval required |
| P3-D04 | Organization config used unchanged by all workspaces and teams; no overrides; never authority | DERIVED — should be adopted |
| P3-D05 | Platform `providers.manage` writes, `providers.read` reads; no tenant assignment API in 3.1 | RECOMMENDED — user approval required |
| P3-D06 | Dedicated `acc_dispatch` principal with assigned-provider-only catalogue policies; guard reused; no definer; `acc_app` unchanged | RECOMMENDED — user approval required |
| P3-D07 | Body/query `workspaceId` (Teams precedent), resolved and authorized server-side; organization via existing header | DERIVED — should be adopted |
| P3-D08 | Same-organization out-of-grant → 403 audited; cross-organization/unknown → 404; team grant does not cover; missing → 400 | DERIVED — should be adopted |
| P3-D09 | Eight read/manage/send keys; organization+workspace (contacts, messages), organization-only (templates, suppressions); no team/platform | RECOMMENDED (reseller coverage: REQUIRES USER DECISION) |
| P3-D10 | QUEUED → ROUTING → PROVIDER_ACCEPTED / FAILED / OUTCOME_UNKNOWN; state-guarded updates | RECOMMENDED — user approval required |
| P3-D11 | Global attempt number; provider key = attempt id = submissionId; attempt only after admission; submitting → accepted/rejected/outcome_unknown | DERIVED (numbering, key) / RECOMMENDED (states) |
| P3-D12 | Append-only events with per-message gapless sequence; fixed type list; no bus | RECOMMENDED — user approval required |
| P3-D13 | Fallback only on `provider_error`, `rate_limited`, pre-submission skips; never on timeout/unknown/auth/config/invalid | DERIVED — should be adopted |
| P3-D14 | Single pass over ordered candidates; stop at accepted/non-fallback/ambiguous/exhausted | DERIVED — should be adopted |
| P3-D15 | No same-provider retry | DERIVED — should be adopted |
| P3-D16 | Ambiguous → terminal OUTCOME_UNKNOWN; no fallback, no re-submit | RECOMMENDED (naming: REQUIRES USER DECISION) |
| P3-D17 | `dispatch_epoch` + lease on message; durable `submitting` attempt before invoke; epoch-guarded record; recovery never re-invokes | RECOMMENDED — user approval required |
| P3-D18 | In-process poller as `acc_dispatch`; SKIP LOCKED claim; per-message organization transactions | RECOMMENDED (values: REQUIRES USER DECISION) |
| P3-D19 | Provider-level `simulator_behavior` capability on simulator providers; never per message | RECOMMENDED — user approval required |
| P3-D20 | No delivery/webhooks in 3.1; completion = provider accepted | REQUIRES USER DECISION |
| P3-D21 | Organization-owned WhatsApp templates; draft/pending/approved/rejected; simulated approval; template-only sends | RECOMMENDED (approver: REQUIRES USER DECISION) |
| P3-D22 | Synchronous ordered checks; suppression before consent; refusals persist nothing but denial audit | RECOMMENDED — user approval required |
| P3-D23 | Contact-owned consent; organization-owned suppressions (contact or address, channel or all); opt-in default | DERIVED (ownership) / REQUIRES USER DECISION (consent type) |
| P3-D24 | `POST /messages` → 202 QUEUED; required Idempotency-Key; contact + template only; poll reads | RECOMMENDED — user approval required |
| P3-D25 | E.164 identity, unique per (workspace, channel, address), one primary | RECOMMENDED — user approval required |
| P3-D26 | Audit = API actions; events = lifecycle; attempts = invocations; no duplication | RECOMMENDED — user approval required |
| P3-D27 | No conversations in Phase 3 | DERIVED — should be adopted |
| P3-D28 | 3.0 → 3.1 data → 3.2 assignments/principal → 3.3 send/dispatch → 3.4 fallback → 3.5 console (→ 3.6 delivery) | RECOMMENDED — user approval required |
| P3-D29 | Phase 1C refusal semantics; hold vs fail queued messages | DERIVED (API) / REQUIRES USER DECISION (queued) |
| P3-D30 | Phase 3 = same-channel, submission-driven, single-pass provider fallback; Phase 5 = cross-channel, delivery-driven, fallback policies | DERIVED — should be adopted |

---

# Part II — Decision review package (the ten decisions requiring approval)

Prepared 06-Oct-2026 for the user's decisions. **Nothing here is frozen or implemented.** Database facts below were read from the reference database `acc_p24_fresh` (migrations `0000`–`0024`) and the migrations themselves; inferences are marked as such.

## II.1 D02 — Assignment removal: status column or delete

**Recommended: an `active | disabled` status column; no hard delete.**

| Alternative | Description |
|---|---|
| A (recommended) | `status` column; unassign = `disabled`; re-assign = `active` |
| B | Existence-only; unassign = `DELETE` (history only in audit `before`) |
| C | Soft delete (`deleted_at`) with a partial unique index |

- **Why A:**
  - Keeps the row that historical attempts' providers were selected from.
  - Matches the repository rule that configuration rows with audit history are deactivated, not deleted (`TENANCY.md` "never hard-deleted" for tenancy rows; providers are disabled, never deleted, ADR-013).
  - Lets a disabled assignment keep its priority slot, or release it (decide in implementation).
  - C adds a third state with no benefit over A.
- **Impact:**
  - **Schema:** `status` enum NOT NULL DEFAULT `active`; uniqueness of `priority` per `(org_id, channel_id)` only among `active` rows (partial unique index).
  - **RLS:** `acc_dispatch` eligibility predicate adds `status = 'active'`.
  - **API:** `enable` and `disable` actions instead of `DELETE`; no `DELETE` route.
  - **Runtime:** a disabled assignment stops being a candidate at the next attempt.
- **Security and concurrency:** Status changes take the assignment row lock. The dispatcher re-reads eligibility per attempt, so no stale candidate is used after commit.
- **Tests:**
  - A disabled assignment is never attempted.
  - Re-enabling restores order.
  - Priority uniqueness among active rows.
  - No `DELETE` grant or route.
- **Reversible later:** yes, from A to B (add `DELETE`) without architectural change. B to A later needs a migration.

## II.2 D06 — `acc_dispatch`: security architecture review

### II.2.1 The problem, precisely

The Phase 3 dispatcher must, for a message owned by organization *O*:
- read *O*'s message, its attempts and events;
- read the providers assigned to *O* (lifecycle, circuit state, capabilities) and the circuit policy;
- take Phase 2 CircuitAdmission, which **writes** provider observation state (`circuit_state`, `circuit_generation`, `circuit_probes`, …) under the provider row lock;
- insert a `provider_health` `submission` sample.

Today, with `acc_app`:

- **Catalogue reads** (`providers`, `provider_capabilities`, `provider_health`, `provider_circuit_policy`, `channels`) are admitted only by `app_has_platform_scope()`. That function requires `app.current_user_id` to name an active user holding a platform-scope grant.
- **Observation writes** are admitted by `providers_platform_observation_update`, which requires `app_has_platform_permission('providers.test_send')`.
- **The dispatcher has no user.** It acts for a message accepted earlier under a tenant principal's `messages.send`. So under the existing model it reads zero catalogue rows and cannot take admission.

### II.2.2 Option A — `acc_app` only, existing model

Not possible without one of the changes in options C or D: the dispatcher holds no platform claim. Running it with an end user's identity is wrong (it is not that user's request, and that user has no platform grant).

### II.2.3 Option B (recommended) — dedicated principal `acc_dispatch`

**Role attributes:**

```
CREATE ROLE acc_dispatch LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT <n>
```

- No membership in any role; owns nothing.
- `NOINHERIT` differs from `acc_app` (`INHERIT`). It has no effect today, because no role grants membership, but it makes any accidental future membership inert.
- The password is supplied by a secret reference (`DATABASE_DISPATCH_URL` via `SecretsPort`), like the other principals.

**Schemas:** `USAGE` on `public` only. Nothing on the `drizzle` schema.

**Sequences:** none. The schema has no sequences; ids are UUIDv7 and versions are trigger-managed.

**Function EXECUTE:**

| Function | Why |
|---|---|
| `app_current_org_id()` | Plain SQL, PUBLIC; reads `app.current_org_id` |
| `app_session_bypasses_rls()` | Existing `SECURITY DEFINER` function, granted per principal today; needed because `fn_providers_state_guard` (`SECURITY INVOKER`) calls it first |
| `uuidv7()` | Column defaults |

It gets **no** EXECUTE on `app_has_platform_scope`, `app_has_platform_permission`, `app_is_platform_admin`, `app_org_reseller` or `app_current_reseller_id`. The guard trigger is amended (below) so `acc_dispatch` never reaches the `app_has_platform_permission` call.

**Table privileges and RLS policies** (`TO acc_dispatch` only; every `acc_app` policy is untouched):

| Table | Privileges | RLS policy (USING / WITH CHECK) | Columns |
|---|---|---|---|
| `messages` | `SELECT`; `UPDATE` (column-level) | Claim step, no organization context: `app_current_org_id() IS NULL AND status IN ('QUEUED','ROUTING')`. Processing step: `org_id = app_current_org_id()` | `UPDATE` only `status, dispatch_epoch, claimed_until, current_attempt_id, current_attempt_number, current_provider_id, failure_code, failure_reason, completed_at, updated_at`. **No `INSERT`, no `DELETE`.** |
| `message_attempts` | `SELECT`, `INSERT`, `UPDATE` (column-level) | `org_id = app_current_org_id()` (denormalized `org_id` + composite FK to the message) | `UPDATE` only `status, outcome, failure_category, retryable, latency_ms, provider_message_id, submitted_at, completed_at, updated_at`. No `DELETE`. |
| `message_events` | `SELECT`, `INSERT` | `org_id = app_current_org_id()`; append-only trigger refuses `UPDATE`/`DELETE`/`TRUNCATE` | — |
| `organization_provider_assignments` | `SELECT` | `org_id = app_current_org_id() AND status = 'active'` | — |
| `providers` | `SELECT`; `UPDATE` (column-level) | `EXISTS (SELECT 1 FROM organization_provider_assignments a WHERE a.provider_id = providers.id AND a.org_id = app_current_org_id() AND a.status = 'active')` for both, and WITH CHECK the same | `UPDATE` only `health_state, health_changed_at, circuit_state, circuit_generation, circuit_changed_at, circuit_probe_successes, circuit_probes, updated_at` |
| `provider_capabilities` | `SELECT` | the same "assigned to the current organization" predicate | — |
| `provider_health` | `SELECT`, `INSERT` | `SELECT`: assigned. `INSERT` WITH CHECK: assigned `AND kind = 'submission'` | — |
| `provider_circuit_policy` | `SELECT` | `true` (one platform-wide, non-sensitive row) | — |
| `channels` | `SELECT` | `true` (five seeded rows) | — |
| everything else | **none** | — | — |

"Everything else" includes `users`, `sessions`, `roles`, `user_roles`, `api_keys`, `audit_logs`, `idempotency_keys`, `organizations`, `workspaces`, `teams`, contacts and identities, consents, suppressions, templates and `provider_configuration_revision`. The send API stores the rendered content and the recipient address on the message at acceptance (D22, D24), so the dispatcher needs no contact, consent or template access.

**Guard trigger amendment** (`fn_providers_state_guard`, still `SECURITY INVOKER`):

```
IF session_user = 'acc_dispatch' THEN
  -- administrative columns and the override: always refused
  -- circuit: the same four edges and +1 generation as today
END IF
```

The check is placed before the existing `app_has_platform_permission` branch. Column privileges already prevent the administrative columns from being written; the trigger is the second layer, as in Phase 2.

**How the organization scope is established** (`TENANCY.md` §5 steps 1–7, `withTenantTransaction`):
1. **Claim transaction**, no organization context: `SELECT … FOR UPDATE SKIP LOCKED` sees only dispatchable rows. It stamps the lease and epoch and reads `org_id` from the row.
2. **Processing transaction:** `SET LOCAL app.current_org_id = <row.org_id>`, which is never request input. Every read and write in that transaction sees only organization *O*.
3. **Integrity:** the message row was created by `POST /messages` under the caller's validated organization context and `messages.send` authorization, with composite FKs tying `(workspace_id, org_id)`.

**How eligibility is enforced:**
- **By RLS:** a provider not actively assigned to *O* is invisible (`SELECT` returns no row) and unwritable (`UPDATE` affects 0 rows) in *O*'s context.
- **By the service:** lifecycle `active` and order (D02, D03).

**How CircuitAdmission stays authoritative:**
- The dispatcher calls the **same** `ProviderStateStore.admit` code under the provider row lock. The writes are permitted by the `acc_dispatch` policy above instead of the `providers.test_send` predicate.
- `ProviderSubmissionExecutor.execute(admission, …)` still redeems the single-use, provider-bound, short-lived token before any adapter call.
- The Gate D.3 architecture test is extended so the dispatcher is a pinned caller that can reach the adapter only through `execute` with an admission.

**Option A versus option B:**

| Property | A (`acc_app`, existing) | B (`acc_dispatch`) |
|---|---|---|
| Who connects | every HTTP request | the dispatcher loop only (separate pool, separate credential) |
| Catalogue rows readable | all providers, when a platform-scope user is in context | only providers actively assigned to the current organization |
| Observation writes | `providers.test_send` platform holders | assigned providers only, observation columns only |
| Tenant data | all tenancy, IAM and RBAC tables under organization RLS | messages, attempts, events of the current organization only |
| Can create a message | yes (API) | **no** (no `INSERT` on `messages`) |
| Audit writes | yes | **no** |
| Reached by a session variable set in an HTTP code path | — | **no**: HTTP code holds no `acc_dispatch` credential |

**Can `acc_dispatch` reach outside the message's organization?**
- **Claim step:** yes, by necessity. It sees the dispatchable rows of every organization (this is how a poller finds work).
- **Processing step:** no. RLS confines it to the organization in `app.current_org_id`.
- **Trust caveat (honest statement):** as for `acc_app`, the organization context is set by application code. A compromised dispatcher process could set any organization id and then act within `acc_dispatch`'s small privilege set for that organization. RLS does not defend against compromised application code; it defends against application *bugs*. This is the existing trust model of `TENANCY.md` §3, not a new one.

**SECURITY DEFINER:** none added. The only definer function executed is the existing `app_session_bypasses_rls()`.

**Is this a second authorization path?**
- **Not for users.** It authorizes no new action: no route, no principal, no message creation.
- **It is a second execution path:** it acts on intents authorized at acceptance. This is the job model `TENANCY.md` §5 prescribes, and it must be reviewed as such.
- **Accepted consequence:** a grant revoked after acceptance does not stop dispatch of an already-accepted message. Revocation applies to future sends only. Alternative: recheck `messages.send` at dispatch, which needs a user identity the dispatcher does not have; rejected.

**Attack scenarios:**

| # | Scenario | Expected result |
|---|---|---|
| 1 | An HTTP handler bug queries `providers` as `acc_app` without a platform grant | 0 rows (unchanged Phase 2 policies) |
| 2 | Dispatcher bug: wrong `app.current_org_id` for a message | The message is invisible in that context; the conditional `UPDATE` affects 0 rows and fails closed; no attempt is created |
| 3 | The dispatcher tries an unassigned provider | `SELECT` finds nothing; admission `UPDATE` affects 0 rows; no adapter call |
| 4 | The dispatcher changes `status`, `name` or `adapter_key` of a provider | Refused by column privilege, and again by the guard trigger |
| 5 | The dispatcher skips a circuit edge or the generation | Refused by the guard (unchanged rule) |
| 6 | Forged, reused or foreign CircuitAdmission | Refused by the executor (Gate D.3 behaviour) |
| 7 | Stale worker after a lease takeover | Epoch mismatch: 0 rows; result not applied (II.5) |
| 8 | `acc_dispatch` writes `audit_logs`, reads `users`, `contacts` or `api_keys` | Permission denied (no grant) |
| 9 | `acc_dispatch` inserts a message (fabricated send) | Permission denied (no `INSERT`) |
| 10 | `acc_dispatch` credential leaked | Attacker can read queued messages' content and recipients across organizations; read and alter observation state of providers assigned to any organization it names (could open circuits: a denial of service); mark messages failed or unknown. It **cannot** read identities, contacts, audit or users, create messages, change provider configuration, or call a provider (adapter calls are in-process) |
| 11 | A tenant user sends with another organization's `workspaceId` | 404 at acceptance (D08); no row is created, so nothing reaches the dispatcher |
| 12 | `acc_dispatch` reaches `acc_app` privileges by `SET ROLE` | Impossible: no membership; `NOINHERIT` |

### II.2.4 Option C — the dispatcher as a system user on `acc_app` (no new database role)

- **What it is:** a synthetic `users` row (no credential) with a platform grant of a seeded system role carrying `providers.read` + `providers.test_send`. The dispatcher sets `app.current_user_id` to it and `app.current_org_id` to the message's organization. Every existing predicate then admits it, with no RLS change and no guard change.
- **Same as B:**
  - CircuitAdmission is unchanged.
  - No definer function.
- **Weaker than B:**
  - The dispatcher sees **every** provider and all health history, not only assigned ones; eligibility is application-only.
  - It holds all `acc_app` table privileges, including tenancy, IAM and audit.
  - Any HTTP code path can obtain the dispatcher's catalogue access by setting a session variable, because it uses the same credential.
  - A platform-scope identity exists that is not a person. That interacts with the platform-administrator and support invariants and with audit actor semantics, and needs new exceptions.
- **Use it if:** you prefer not to add a database principal and accept application-only eligibility.

### II.2.5 Option D — SECURITY DEFINER functions

- **What it is:** fixed-signature owner functions, e.g. `fn_dispatch_candidates(org, channel)` and `fn_dispatch_admit(...)` / `fn_dispatch_record(...)`, executable by `acc_app`.
- **Strength:** the narrowest table surface.
- **Weaknesses:**
  - Re-implements the Phase 2 admission and recording logic, now TypeScript in `provider-state-machine.ts` and `provider-state.store.ts`, in PL/pgSQL: two implementations of the circuit.
  - Each function must be hardened (search_path, argument trust, ACL).
  - Any `acc_app` code can call them.
  - Every new definer requires a stop-and-report review under the Phase 2 rule.
- **Use it if:** you want no new principal and accept a SQL reimplementation of the admission logic.

### II.2.6 Why B

B is the only option where all three hold:
1. **Catalogue reach** is limited to assigned providers by the database, not only by code.
2. **HTTP code** cannot obtain dispatch privileges at all.
3. **CircuitAdmission** remains the single TypeScript implementation.

The costs:
- a new role and credential;
- column-level grants and about ten policies;
- a guard amendment;
- classification in `principals.int-spec.ts`;
- a dedicated security gate (E.2).

### II.2.7 Tests and reversibility

**Tests:**
- Principal classification: exact grants, column grants, no sequences, function ACLs, no membership, `NOINHERIT`.
- One case per attack scenario 1–12.
- RLS with the service bypassed:
  - other organization's message invisible in processing;
  - unassigned provider invisible and unwritable;
  - disabled assignment invisible.
- Guard: administrative columns refused for `acc_dispatch`.
- Mutation proofs:
  - widen the providers predicate to `true`;
  - grant `UPDATE(status)`;
  - drop the organization predicate on attempts;
  - remove the guard branch;
  - grant `INSERT` on messages.

**Reversible:** B to C later means deleting a principal. C or D to B later needs new policies but no data migration. The choice is reversible at moderate cost before Phase 3.3 ships.

## II.3 D09 — Permission keys and reseller coverage

**Recommended:** the eight keys of D09, with allowed grant scopes as tabled there. **Reseller-scope grants do not cover them** in Phase 3.

| Alternative | Description |
|---|---|
| A (recommended) | 8 keys, `read`/`manage`/`send`; reseller excluded |
| B | Phase 1 style: `contacts.create/update/delete`, `templates.create/update/delete/approve`, … (~16 keys) |
| C | A, plus reseller coverage (a reseller administrator manages its organizations' contacts and messages) |

- **Why A:**
  - Matches the Phase 2 convention for a small domain.
  - Fewer keys, less role-mapping error.
  - Reseller administration of tenant content is excluded scope (ADR-013 PD-6 spirit; reseller and white-label work deferred).
  - C would make reseller principals able to read customers' messages, a privacy expansion needing its own decision.
- **Impact:**
  - **Contracts:** keys added to `PERMISSIONS`. The allowed-scope rule is enforced by the existing `fn_validate_role_permission` / allowed-scope machinery (as for other tenant keys), with a test that a reseller-scope role cannot carry them.
  - **Database:** a seed migration attaches the keys to the system tenant roles (D22).
  - **API:** `@RequiresPermission` on each route.
- **Security:** vertical escalation is bounded by the existing creator-intersection and coherent-grant rules.
- **Concurrency:** none.
- **Tests:**
  - Route-authorization coverage.
  - Downward coverage (organization grant covers workspace resources; a workspace grant does not cover templates or suppressions).
  - Team grant refused.
  - Reseller grant refused.
  - Platform grant refused for tenant data.
- **Reversible:** adding keys later is additive. Splitting `manage` into finer keys later needs a role migration (moderate). Allowing reseller coverage later is additive.

## II.4 D16 and D17 — State machines, fencing, and the OUTCOME_UNKNOWN proof

### II.4.1 Message states

| From | Event | To | Writer |
|---|---|---|---|
| — | accepted by `POST /messages` | `QUEUED` | API (`acc_app`) |
| `QUEUED` | claimed; candidate found; admission granted; attempt inserted as `submitting` | `ROUTING` (epoch e) | dispatcher claim transaction |
| `QUEUED` | claimed; no candidate left | `FAILED` (`NO_ELIGIBLE_PROVIDER`) | dispatcher |
| `QUEUED` | claimed; every remaining candidate skipped | `FAILED` | dispatcher |
| `ROUTING` (e) | attempt accepted | `PROVIDER_ACCEPTED` | record transaction (epoch e) |
| `ROUTING` (e) | attempt rejected with a **provider failure** (`provider_error`, `rate_limited`), candidates remain | `QUEUED` | record transaction (epoch e); the next poll claims with epoch e+1 |
| `ROUTING` (e) | attempt rejected with a provider failure, no candidate remains | `FAILED` | record transaction |
| `ROUTING` (e) | attempt rejected with a **customer, request, configuration or authentication** failure | `FAILED` | record transaction |
| `ROUTING` (e) | attempt outcome `timeout` or `unknown` | `OUTCOME_UNKNOWN` | record transaction |
| `ROUTING` (e), lease expired | recovery claim finds the epoch-e attempt still `submitting` | `OUTCOME_UNKNOWN`; the attempt becomes `outcome_unknown` (`DISPATCH_INTERRUPTED`) | recovery claim (epoch e+1) |

**Terminal states:** `PROVIDER_ACCEPTED`, `FAILED` and `OUTCOME_UNKNOWN` have **no outgoing transition**.

**Fallback as a re-queue.** A fallback re-enters `QUEUED`, not `ROUTING`, so every attempt has its own claim, epoch and lease. A lease therefore covers exactly one invocation (II.6).

### II.4.2 Attempt states

| From | Event | To |
|---|---|---|
| — | inserted in the claim transaction, after admission | `submitting` |
| `submitting` | adapter accepted (record, epoch matches) | `accepted` |
| `submitting` | adapter rejected (record, epoch matches) | `rejected` (with category, retryable, latency) |
| `submitting` | `timeout` / `unknown` (record, epoch matches) | `outcome_unknown` |
| `submitting` | recovery after lease expiry | `outcome_unknown` (`DISPATCH_INTERRUPTED`) |

All three end states are terminal. A stale record (epoch mismatch) changes no attempt.

### II.4.3 Crash and timeout cases

| Case | What happens |
|---|---|
| Crash before the claim commits | Nothing visible; the message stays `QUEUED`; re-claimed later (no invocation happened) |
| Crash after the claim commits, before invocation | The attempt is `submitting`; recovery makes it `OUTCOME_UNKNOWN`. Conservative: it was not in fact sent. See refinement below. |
| Crash during invocation | `submitting` → recovery → `OUTCOME_UNKNOWN` (correct: may have been sent) |
| Crash after invocation, before record | The same (correct) |
| Simulator `TIMEOUT` (3000 ms) | Recorded `outcome_unknown` → `OUTCOME_UNKNOWN` (deterministic in tests) |
| Record transaction fails (database error) | Lease expires → recovery → `OUTCOME_UNKNOWN` |

**Refinement, optional:** a `prepared` state written at claim, flipped to `submitting` in a tiny transaction immediately before invocation. Recovery may then re-queue `prepared`, which provably never invoked. The cost is one extra transaction per attempt. **Recommendation:** not in 3.3, because the window is microseconds. Record it as a known false-unknown source.

### II.4.4 Proof that `OUTCOME_UNKNOWN` cannot cause a resend or fallback

Every path that could invoke a provider for message *m* requires all of the following, each enforced independently:

1. **Dispatch selection:** the poll predicate selects only `status = 'QUEUED'` or (`status = 'ROUTING' AND claimed_until < now()`). `OUTCOME_UNKNOWN` matches neither, and the `acc_dispatch` claim policy admits only those two statuses.
2. **Attempt creation:** it happens only in the claim transaction, after `UPDATE messages SET status='ROUTING', dispatch_epoch = dispatch_epoch + 1 … WHERE id = m AND status = 'QUEUED'` (or the expired-lease recovery form) affected exactly one row. For a message in `OUTCOME_UNKNOWN` that `UPDATE` affects 0 rows, so no attempt exists and no admission is taken.
3. **Recovery** maps a `submitting` attempt to `OUTCOME_UNKNOWN`. There is no code path from `submitting` to `QUEUED`.
4. **Database backstop (proposed):** a message-transition guard trigger (`SECURITY INVOKER`, in the style of `fn_providers_state_guard`) admits only the transitions in II.4.1 and rejects every transition out of a terminal state. A code defect that tried `OUTCOME_UNKNOWN → QUEUED` fails at the database.
5. **Invocation:** the adapter call requires a CircuitAdmission that only step 2 produces. Without it, the executor refuses (Gate D.3).

**Therefore** no transition, poll, recovery or admission path leads from `OUTCOME_UNKNOWN` to an invocation. Fallback (provider failure → `QUEUED`) is reachable only from a **recorded** `rejected` attempt whose category is a provider failure, and `timeout`/`unknown` are never recorded as `rejected`.

**Tests:**
- Mutation proofs:
  - (a) poll predicate widened to include `OUTCOME_UNKNOWN`;
  - (b) recovery maps `submitting` to `QUEUED`;
  - (c) `timeout` classified as fallback-eligible;
  - (d) the transition guard dropped;
  - (e) a terminal-to-`QUEUED` update allowed.
- Crash-injection cases at each point of II.4.3.
- An integration case: N concurrent pollers against one message; exactly one invocation.

### II.4.5 Naming and reversibility

- **Name:** `OUTCOME_UNKNOWN` (recommended) versus `UNCONFIRMED` or `FAILED` + `failure_code = OUTCOME_UNKNOWN`. A separate state is recommended because clients must not treat it as "not sent".
- **Reversible:** the name is reversible by a migration before any data exists. Folding it into `FAILED` later loses information and is not recommended.

## II.5 D18 — Poll interval, batch, lease

**Recommended:** poll every 1 s with ±20 % jitter; batch 10 per instance; lease 30 s.

| Alternative | Description |
|---|---|
| A (recommended) | 1 s / 10 / 30 s |
| B | 250 ms / 50 / 10 s (lower latency, more load, a tighter lease) |
| C | 5 s / 10 / 60 s (lower load, slower dispatch and recovery) |

**Reasoning:**
- **Latency:** dispatch latency from acceptance is the poll interval plus one claim: about 0.5 s average and 1 s worst at 1 s. Each fallback hop adds at most one poll interval, because fallback re-queues (II.4.1). A chain of k providers therefore takes about k s plus invocation time.
- **Database load:**
  - one indexed query per instance per second (partial index `messages(created_at, id) WHERE status IN ('QUEUED','ROUTING')`). The query is cheap and returns at most 10 rows;
  - plus two short transactions per attempt (claim, record);
  - with two instances, two empty polls per second when idle. That is negligible next to the existing request load.
- **Throughput per instance:**
  - Each attempt is three steps: a claim transaction of a few milliseconds, then an invocation of up to 3000 ms (the platform timeout), then a record transaction of a few milliseconds.
  - Processing the batch concurrently gives a worst case, every invocation timing out, of about 10 / 3.1 s ≈ 3 attempts/s per instance.
  - The simulator's normal latency is milliseconds, so typical throughput is far higher.
  - Phase 3 is simulator-only and low-volume, so 10 is ample. It also bounds the dispatcher pool: at most 10 short transactions in flight. Connections are not held across invocations.
- **Lease:**
  - The longest legitimate hold is the claim transaction, the 5 s admission validity window, the 3 s invocation and the record transaction: about 3.1 s typical, under 5 s worst.
  - 30 s gives a margin of more than 6× for pauses, garbage collection and database latency. It bounds recovery of a crashed worker's message to 30 s plus one poll.
  - CircuitAdmission (5 s) must be redeemed well within it.
  - A lease of 10 s (B) risks takeovers under transient stalls. Each takeover yields a false `OUTCOME_UNKNOWN`, so a takeover is costly, which argues for a generous lease.

### Lease-expiry race and stale-worker fencing

Worker W1 claims *m* (epoch 7), commits attempt *a* (`submitting`, fencing 7), and invokes. W1 then stalls for more than 30 s.

1. W2 polls: *m* is `ROUTING` with an expired lease. W2 claims: `UPDATE … SET dispatch_epoch = 8 … WHERE id = m AND status = 'ROUTING' AND claimed_until < now()` (1 row).
2. W2 sees attempt *a* still `submitting`. It marks *a* `outcome_unknown` (`DISPATCH_INTERRUPTED`) and *m* `OUTCOME_UNKNOWN`. It **does not invoke**.
3. W1 wakes and records: `UPDATE message_attempts … WHERE id = a AND status = 'submitting'` joined with `messages.dispatch_epoch = 7`. This affects 0 rows, because the attempt is no longer `submitting` and the epoch is 8. W1's result is discarded for the message.
   - Its health sample is still recorded, under Phase 2 stale-ticket semantics (it is true information about the provider).
   - Its circuit recording follows §6d: a stale ticket changes no circuit state.
   - A `dispatch.stale_result` metric and log line are produced.

**Outcome:** at most one invocation per attempt, and no double recording.
- **Cost:** if W1's invocation was in fact accepted, *m* reports `OUTCOME_UNKNOWN` although it was sent. This is conservative, and visible in metrics.
- **Why it cannot go wrong otherwise:** because the record is conditional on both the attempt state and the epoch, two workers can never both record.

**Tests:**
- Deterministic lease-takeover test (manual clock, held invocation).
- Concurrent pollers with `SKIP LOCKED` (no double claim).
- Mutation proofs: removing the epoch condition from the record; removing `SKIP LOCKED` (deadlock/serialization evidence).

**Reversible:** all three values are configuration. Changing them later needs no migration. They must keep lease ≫ invocation timeout + admission window.

## II.6 D19 — Simulator behaviour for persisted messages

**Recommended:** a reserved capability key `simulator_behavior` on a simulator provider.

- **Storage:** an existing `provider_capabilities` row (platform catalogue).
- **Authority:** the existing `PUT /providers/:id/capabilities` with `providers.manage` at platform scope, audited as `provider.capabilities_replaced`.
- **RLS:** unchanged for writes (platform `providers.manage`). The dispatcher reads it through the `acc_dispatch` assigned-provider policy (II.2).
- **Value:** one of the seven Phase 2 submission behaviours; default `SUCCESS` when absent.
- **Validation (new code in 3.4):**
  - The registry service refuses `simulator_behavior` unless the provider's `adapter_key = 'simulator'`.
  - It refuses any value outside the enum.
  - The dispatcher ignores the key for non-simulator adapters (defence in depth).

| Alternative | Description |
|---|---|
| A (recommended) | Capability key on the provider |
| B | A dedicated column `providers.simulator_behavior` (schema change; cleaner typing; same authority) |
| C | A separate platform table `simulator_profiles(provider_id, behavior, …)` permitting scripted sequences |

A request field, a test header and magic recipient addresses were all rejected in Part I (D19).

- **Why A:**
  - No schema change; reuses the audited, platform-only surface.
  - Never appears in the message contract, so the future real-provider contract is untouched.
  - Tenants cannot influence outcomes.
- **Against A:**
  - "Capabilities" were defined as declared provider support (`PROVIDER_ADAPTER.md` §2). Using a key for test configuration stretches that meaning. B is cleaner if you prefer explicit typing.
  - Per-provider, not per-call: scripted sequences ("fail, then succeed") need C.
- **Security:**
  - A platform administrator can make a simulator provider fail deliberately. That is acceptable for simulator-only Phase 3 (F2).
  - Simulator providers must not exist in a production deployment with real traffic. That is a deployment rule, not enforced by this mechanism.
- **Concurrency:** read per attempt (hot reload is irrelevant; the dispatcher reads PostgreSQL).
- **Tests:**
  - Refused for non-simulator adapters.
  - Enum validation.
  - Default `SUCCESS`.
  - Deterministic fallback matrix (A = 500, B = SUCCESS → accepted on attempt 2; A = TIMEOUT → `OUTCOME_UNKNOWN`, no attempt 2; A = INVALID_REQUEST → `FAILED`, no attempt 2).
  - Tenant cannot set it.
- **Reversible:** A to B or C later is a small migration plus code change. No contract exposure, so no API break.

## II.7 D20 — Delivery and webhooks

**Recommended:** none in Phase 3.1–3.5. "Completed" means `PROVIDER_ACCEPTED`. Delivery simulation is decided at the end of 3.4.

| Alternative | Description |
|---|---|
| A (recommended) | No delivery; a later increment 3.6 if ROADMAP §6's webhook tests are still wanted |
| B | Minimal deterministic delivery in Phase 3: a simulator-generated `delivered`/`delivery_failed` event per accepted attempt, ingested through an internal path (no HTTP webhook); adds `DELIVERED` and `DELIVERY_FAILED` states |
| C | A full inbound webhook path with signature verification and dedup/replay against the simulator (ROADMAP §6 as written) |

- **Trade-offs:**
  - **A:** smallest, no Phase 5 leakage. The console shows "accepted" only.
  - **B:** adds two states and one ingestion path. Customers would expect delivery-failure fallback, which is Phase 5. Without it, B shows failures that trigger nothing.
  - **C:** the largest. It introduces the first unauthenticated inbound surface (webhooks) and its security review. It also matches the original ROADMAP §6 text.
- **Impact of B or C:** new states (D10), event types (D12), and with C a public endpoint, a signature secret (credential contract CR-1–CR-8 applies), and dedup tables.
- **Reversible:** A to B or C later is additive. Choosing C now and removing it later is not cheap.

## II.8 D21 — Template approval under simulation

**Recommended:** approval by a holder of `templates.manage` at organization scope, through an explicit, audited `approve` / `reject` action labelled simulated (`after.simulated = true`).

| Alternative | Description |
|---|---|
| A (recommended) | Organization `templates.manage` approves its own templates |
| B | Platform approval (`providers.manage`, or a new platform key), simulating Meta's external review |
| C | Automatic approval on submit (`pending` → `approved` immediately) |

- **Trade-offs:**
  - **A:** simple; tests and console self-contained; honest labelling. Not a control, because the same people author and approve.
  - **B:** closer to reality (an external party approves). It needs a platform workflow and cross-tenant platform reads of templates, which no current permission allows. That is new platform scope.
  - **C:** removes the state machine's meaning. Tests of "not approved → refused" need a manual `reject`.
- **Impact:** A adds `POST /templates/:id/approve` and `/reject` under `templates.manage` (organization scope), audited, with a state-guarded update.
- **Security:** no external trust is implied. Documentation must say approval is simulated.
- **Tests:**
  - The lifecycle transition matrix.
  - Sends refused for draft, pending and rejected templates.
  - An approved template edited returns to draft.
  - Audit of approve and reject.
- **Reversible:** replacing A by real vendor approval later changes who moves the status (an adapter callback), not the state model.

## II.9 D23 — Which consent a Phase 3 send requires

**Recommended:** each template carries a `category` (`transactional` | `marketing`, mirroring the consent types). A send requires a granted, unrevoked consent of that type for `(contact, whatsapp)`. `otp` is not used in Phase 3.

| Alternative | Description |
|---|---|
| A (recommended) | Category on the template; consent type must match |
| B | Any granted WhatsApp consent suffices (channel-level opt-in) |
| C | Always `marketing` consent required (strictest) |

- **Trade-offs:**
  - **A:** precise; matches the planned three consent types (`DATABASE.md` §3). Adds one field and a check.
  - **B:** simplest. Loses the distinction the schema already plans, which later needs a migration of semantics.
  - **C:** over-restrictive for transactional messages.
- **Impact:** a `templates.category` enum; the D22 consent check compares types.
- **Policy note:** WhatsApp opt-in rules are a regulatory and policy matter (`SECURITY.md` §7). Verify with a qualified professional before acting on any production consent policy.
- **Tests:**
  - Each category against each consent state (granted, revoked, missing, other type).
  - Suppression overrides granted consent.
- **Reversible:** A to B later relaxes a check (easy). B to A later needs a backfill of template categories (moderate).

## II.10 D29 — Queued messages of a suspended or closed organization

**Recommended:**
- **Suspended:** hold. The dispatcher does not claim them (claim predicate excludes organizations whose status is not `active`), and they resume on reactivation.
- **Closed:** fail them at the next poll with `ORGANIZATION_CLOSED`. Closed is terminal (Phase 1C F-1).

| Alternative | Description |
|---|---|
| A (recommended) | Hold if suspended, fail if closed |
| B | Fail on suspension too |
| C | Keep dispatching (suspension blocks only new API mutations) |

- **Trade-offs:**
  - **A:** respects that suspension is reversible and non-destructive (Phase 1C). Queued messages may be sent long after acceptance on reactivation; some may be stale (an OTP, for example).
  - **B:** predictable, no stale sends. Converts a temporary administrative action into permanent customer-visible failures.
  - **C:** contradicts the intent of suspension (no tenant activity). Rejected.
- **Impact:**
  - **Claim predicate:** needs organization status. `acc_dispatch` would need `SELECT (id, status)` on `organizations` under a narrow policy, or the status is checked in the processing transaction. Recommended: a column-limited `SELECT (id, status)` grant with the organization-context policy, used in the processing transaction. The claim is then released without action for a suspended organization.
  - **Lease release:** for a held message, the claim transaction restores `QUEUED` and no attempt is created.
- **In flight:** an attempt already `submitting` is recorded truthfully (II.4).
- **Recovery:** recovery of `submitting` attempts proceeds normally whatever the organization status. A truthful record does not send anything.
- **Tests:**
  - Suspended: no claim, no attempt; reactivation resumes.
  - Closed: `FAILED` with no attempt.
  - An in-flight attempt during suspension is recorded.
  - The API refuses sends with `409` (existing).
- **Reversible:** switching A to B later is a dispatcher rule change only.

## II.11 Summary table

| Decision | Recommendation | My approval required? | Main risk |
|---|---|---|---|
| D02 | `active`/`disabled` status, no hard delete | Yes | Priority uniqueness rules among disabled rows need care |
| D06 | Dedicated `acc_dispatch` principal: column-level grants, assigned-provider RLS, guard amendment, no definer; alternatives C (system user on `acc_app`) and D (definer functions) documented | Yes — security architecture | A new cross-tenant claim principal; leaked credential exposes queued content and can disturb circuits |
| D09 | Eight keys (`contacts`/`templates`/`suppressions` `.read`/`.manage`, `messages.read`/`.send`); reseller grants excluded | Yes | Coarse `manage` may need splitting later |
| D16 | Terminal `OUTCOME_UNKNOWN`; never resent, never falls back (proof II.4.4) | Yes (name and semantics) | Messages actually sent but reported unknown (false unknowns after crashes) |
| D18 | Poll 1 s ± jitter, batch 10, lease 30 s; epoch-fenced records | Yes (values) | A long stall causes a takeover and a false unknown |
| D19 | `simulator_behavior` capability on simulator providers, platform-only, validated | Yes | Stretches "capability" semantics; per-provider, not per-call |
| D20 | No delivery or webhooks through 3.5; revisit after 3.4 | Yes | "Accepted" is mistaken for "delivered" by users |
| D21 | Organization `templates.manage` approves, labelled simulated | Yes | Approval is not a real control (self-approval) |
| D23 | Template `category` must match the consent type (`transactional`/`marketing`) | Yes | Consent policy correctness is a regulatory question (verify with a qualified professional) |
| D29 | Hold when suspended, fail when closed | Yes | Stale sends after a long suspension |
