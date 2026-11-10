# Phase 8C — Journeys / Automation: implementation handover

**Status:** Rev 1, 10-Nov-2026. **Approved by the owner on 10-Nov-2026 for 8C-1 to 8C-4 only**, with the owner decisions recorded in §16 and in `PHASE-8C-DECISION-REGISTER.md`. 8C-5 and 8C-6 (sending) and 8B-3 are not authorised.
**Baseline:** `develop` at `b5517bc` (PR #94 merged 10-Nov-2026). Latest migration `0061` (PR #102); the history proof at this baseline is `62|7a3898277442949a5652454b5c12150c`.
**Companion documents:**
- `PHASE-8C-DEPENDENCY-RISK-REGISTER.md`: dependencies and risks;
- `PHASE-8C-DECISION-REGISTER.md`: owner decisions;
- `DECISIONS.md` §1zj: decision record entry.

Notation used throughout:
- **[V]** verified in the repository at the baseline;
- **[I]** inference or design proposal, not yet verified by implementation;
- **[P]** proposed default, changeable at review without an owner decision.

---

## 1. Summary

Phase 8C builds the journey/automation engine as a **caller of the Communication Core**. Journeys are versioned graphs that move one contact at a time through:
- entry triggers;
- conditions and branches;
- waits;
- actions, of which the main one is "send a message through the shared submission core".

Each contact's position is a durable, fenced execution record. Every step is written to an append-only history.

Three facts at the baseline shape the plan:
1. **The send path journeys need already exists and already enforces the hard rules [V].** It is `MessageSubmissionCore` (PR 7-3), with:
   - suppression and consent checks at submission (`message-submission.core.ts` step 3; consent check present);
   - funds reservation as the core's last step when `BILLING_ENFORCEMENT_ENABLED` (7-4);
   - a re-check of suppression and consent at every dispatch claim (`app_dispatch_recipient_block`, `0037`);
   - settlement in the dispatcher (7-5).

   A journey that calls the core cannot bypass consent, suppression, routing, fallback or billing.
2. **No automated sender identity exists yet [V].**
   - `app_content_context_valid()` admits only an org-level user session or an API key.
   - The campaign executor's identity (D-5) was deferred to PR 8B-3, and **8B-3 is not built**: `CAMPAIGN_DISPATCH_DISABLED` is still returned. PR #94 delivered audience materialisation, previews and scheduling validation, not dispatch.
   - A journey runner has exactly the same problem. This is the one decision 8C cannot design around (**OD-8C-1**).
3. **A background-execution precedent exists [V].** `DispatchWorker` is an in-process `setTimeout` loop over a PostgreSQL claim table, with a lease, claim token and fencing epoch, admitted by the scope-creep "worker" category. The journey runner follows that pattern. It adds no queue library, cron framework, Kafka or Redis correctness dependency.

---

## 2. Scope reconciliation against `ROADMAP.md` §11c

| `ROADMAP.md` §11c item | 8C disposition | Notes |
|---|---|---|
| `journeys` module | **In** | `apps/api/src/journeys/` |
| Versioning (`journeys`, `journey_versions`, `journey_executions`) | **In** | Plus history, queue, trigger and event tables (§5) |
| Event triggers | **In, limited to events the platform produces today** | Contact created; contact attribute or tag changed; message outcome (delivered/read/failed); API enrolment. Inbound-message and reply triggers need inbound processing (8D) and are **out**. Commerce events are 8G |
| Scheduled triggers | **In** | One-off and recurring (daily/weekly) enrolment of a segment snapshot |
| Conditions, branching | **In** | Attribute, tag, segment membership, consent state, outcome of an earlier send step |
| Delays | **In** | Fixed duration, until a timestamp, until a time-of-day window in the organisation's time zone |
| Retries | **In** | Per-step retry policy for transient failures (§9) |
| Action: send message | **In, built disabled** | Through the shared core only. **Enablement is blocked on OD-8C-1 and OD-8C-2** (mirrors `CAMPAIGN_DISPATCH_DISABLED`) |
| Action: update contact (tag add/remove, attribute set) | **In** | Through the existing contacts service rules |
| Actions: webhook/API calls | **Owner decision OD-8C-3** | Listed by the roadmap, but no outbound HTTP client exists and the scope-creep "network" category forbids one. Recommended: a contract-only stub node in 8C, with the real action in a later slice |
| Actions: CRM, human handoff, AI handoff | **Stub nodes (no-op, recorded)** | The roadmap says so explicitly: targets are no-ops or stubs until 8D (inbox), 8F (CRM) and Phase 10 (AI) exist |
| Frontend: journey builder (graph editor) | **In, owned by Gemini (`apps/web`)** | Backend owns the graph contract, validation and APIs (§10) |
| Tests: branching and versioning | **In** | Expanded in §12 |
| Security: cannot bypass consent and suppression | **In** | Inherited structurally from the core and proven by tests (§11) |
| Observability: progress dashboards | **In** | Bounded metrics plus per-node statistics API. The dashboard UI is Gemini's |
| Acceptance: drives messages through the full pipeline identically to a direct API call | **In** (parity suite, §12) | Requires send enablement, so it is gated by OD-8C-1 and OD-8C-2 |
| Rollback: `journey_executions` durable | **In** | Plus a runner kill switch (§8.6) |

**Explicitly excluded:**
- 8D (inbox, inbound processing, real human handoff);
- 8E (chatbot/flow builder);
- 8F/8G; Phase 9 reseller features; Phase 10 AI;
- real provider connections; enabling delivery-webhook ingress (OD-19 stays as is);
- **campaign dispatch enablement (8B-3)**;
- C-7/C-8 and other 7.7 slices;
- A/B splits, frequency caps and quiet-hour policies. These are not in the roadmap and are recorded as candidates only.
- QA or production deployment.

**Naming note [V]:** `API.md` lists `/journeys`. The campaign precedent is workspace-scoped (`/workspaces/:workspaceId/campaigns`). 8C follows the precedent (§7), and `API.md` is updated in the same PR.

---

## 3. Dependencies (detail in the register)

**Phase 8B:**
- 8B-1 (campaign tables, `campaigns.*` permissions) and 8B-2 (audience materialisation via `ContactsService.resolveAudience`) are merged [V]. 8C reuses the audience resolver for segment and scheduled enrolment.
- 8B-3 (campaign execution) is **not** built [V]. The roadmap's "journeys can trigger campaign-like sends" needs the same executor identity (D-5). **The "trigger a campaign" action is therefore out of 8C**; only the per-contact send node is in.

**Phase 7 — billing capabilities actually required:**

| Capability | Required? | Why |
|---|---|---|
| 7-3 shared submission core | **Required** | The only permitted send path |
| 7-4 reservation at submission | **Required, inherited** | Runs inside the core. The journey must handle its refusals (insufficient funds, frozen, not configured) |
| 7-5 settlement in the dispatcher | **Required, inherited** | No journey code is involved |
| 7-6a tenant billing reads | Not required | — |
| 7-6b/7-6c unknown-outcome register and resolution | Not required | Unknown outcomes surface as message status only |
| 7-6d provisioning and recharge | Required only to *test* enforced mode | Accounts must exist when enforcement is on |
| 7-7 reconcile (C-1..C-6) | Not required | Recommended as a post-test check in the parity suite (read-only) |
| Pricing by journey dimension | **Not required** | `messages.journey_id` gives reporting attribution without a rating change |
| Mandatory `Idempotency-Key` (D-4) | Applies to the HTTP adapter only | Internal journey sends are made idempotent by database uniqueness (§8.4) |

---

## 4. Architecture overview

```
Builder UI (Gemini, apps/web)
   │  REST (/workspaces/:wid/journeys…)
   ▼
JourneysController ─▶ JourneysService ─▶ graph validator (shared, packages/contracts)
                         │ publish/activate (audited)
                         ▼
                 journeys / journey_versions / journey_triggers
                         │
  producers (contacts, ─▶ automation_events (trigger inbox, DB triggers or service writes)
  messages delivery)            │
                                ▼
JourneyRunner (in-process setTimeout loop, flag JOURNEY_RUNNER_ENABLED, default off)
   ├─ trigger intake: automation_events + due scheduled triggers ─▶ enrol (idempotent)
   └─ executor: claim due journey_execution_queue rows (lease + token + epoch)
          └─ per node, one transaction:
               conditional UPDATE journey_executions (state_version, claim token)
               + INSERT journey_execution_steps (unique per execution/sequence)
               + [send node] MessageSubmissionCore.submit(tx, automationCtx, request)
```

**Boundaries:**
- `journeys` imports the core through a narrow exported port: the same contract as the HTTP adapter, plus an origin attribution (§8.4).
- `journeys` imports no provider-adapter, dispatcher, billing, pricing or ledger module. A structural test enforces this, extending the 7-3 test.

---

## 5. Data model (proposed migrations `0062`+; numbers to be confirmed against `develop` and Gemini's open work at authorisation)

All tables have:
- an `org_id` and `workspace_id` with composite foreign keys `(…, org_id)`, following the `0052` precedent;
- RLS enabled, with `acc_app` policies `org_id = app_current_org_id() AND app_content_context_valid()`;
- `uuidv7()` keys.

**Draft columns:**

| Table | Purpose and key columns | Integrity rules |
|---|---|---|
| `journeys` | `name`, `description`, `status (draft, active, paused, archived)`, `active_version_id NULL`, `created_by`, timestamps, `deleted_at` | `UNIQUE (id, org_id)`; `active_version_id` must belong to the journey (composite FK) |
| `journey_versions` | `journey_id`, `version_number`, `graph JSONB`, `graph_schema_version`, `graph_sha256`, `entry_policy JSONB`, `status (draft, published, retired)`, `published_at`, `published_by` | `UNIQUE (journey_id, version_number)`; at most one `draft` per journey (partial unique); a published version is immutable (trigger: no UPDATE of graph, policy or hash; status only `published → retired`) |
| `journey_triggers` | Derived from the published graph's entry node: `kind (event, schedule, api)`, `event_kind`, `schedule JSONB`, `next_fire_at`, `status` | Index `(next_fire_at) WHERE status = 'active'` |
| `automation_events` | Trigger inbox: `kind`, `contact_id`, `subject_id`, `occurred_at`, `dedupe_key`, `processed_at` | `UNIQUE (org_id, kind, dedupe_key)`; partial index on unprocessed rows; retention purge [P 30 days] |
| `journey_executions` | One contact × one version: `contact_id`, `journey_id`, `journey_version_id`, `status (running, waiting, completed, exited, failed, cancelled)`, `current_node_key`, `wake_at`, `state_version`, `entry_kind`, `entry_ref`, `entered_at`, `ended_at`, `end_reason`, `transitions` (counter) | **Partial unique** `(journey_id, contact_id) WHERE status IN ('running', 'waiting')` (no double enrolment); `UNIQUE (journey_id, contact_id, entry_ref)` (idempotent enrolment) |
| `journey_execution_queue` | Content-free claim rows, as in `message_dispatch_queue`: `execution_id`, `available_at`, `epoch`, `claim_token`, `claimed_until`, `claimed_by` | One row per live execution; index `(available_at)` |
| `journey_execution_steps` | Append-only history: `execution_id`, `seq`, `node_key`, `node_type`, `outcome`, `attempt`, `message_id NULL`, `error_code`, `details JSONB` (bounded, no message content or addresses), `started_at`, `finished_at` | `UNIQUE (execution_id, seq)`; `UNIQUE (message_id)` where not null; immutable (trigger) |
| `messages.journey_id`, `messages.journey_execution_id` | Attribution (in `DATABASE.md` §6, not yet built) | Nullable composite FKs with `org_id`; partial index `(org_id, journey_id)` |

**Event capture [I, design choice, see register R-6]:**
- Contact events are written by the contacts service in the producer's own transaction.
- Message-outcome events are written by an `AFTER UPDATE OF status, delivery_status` trigger on `messages`. The trigger is SECURITY DEFINER, owned by the schema owner, and inserts only when the organisation has an active journey trigger of that kind.
- This leaves the Phase 5 delivery writer and the dispatcher code unchanged.

---

## 6. Graph model (contract in `packages/contracts/src/journeys.ts`)

- A graph is `{schemaVersion: 1, entry: NodeKey, nodes: Record<NodeKey, Node>}`. Nodes carry typed `next` edges.
- **Node types (v1):**
  - `entry` (event / schedule / api);
  - `send_message` (template, channel, variables mapped from contact fields);
  - `wait_duration`, `wait_until`, `wait_window`;
  - `condition` (attribute / tag / segment / consent / prior-send-outcome, with `true` and `false` edges);
  - `wait_for_outcome` (a prior send's delivered/read/failed outcome, or a timeout edge);
  - `update_contact`;
  - `exit`;
  - stubs: `webhook` (OD-8C-3), `crm_action`, `human_handoff`, `ai_handoff`, which record `outcome = stubbed` and follow `next`.
- **Validation (shared by API and UI):**
  - every node is reachable from `entry`, and every non-exit node has a defined `next`;
  - **acyclic in v1** [P]: loops are rejected. This removes unbounded re-execution by construction;
  - at most 200 nodes [P];
  - templates exist, are approved and are channel-compatible, and required variables are mapped (the 8B-2 rules, reused);
  - segment ids belong to the workspace;
  - waits are ≤ 366 days [P].
- **Limits:** at most 1,000 transitions per execution [P]. This is defence in depth, since the DAG bounds it already.

---

## 7. APIs (workspace-scoped; `{data}` envelope; keyset lists; OpenAPI updated)

| Method and path | Purpose | Permission | Idempotency |
|---|---|---|---|
| `GET/POST /workspaces/:wid/journeys` | List, create | `journeys.read` / `journeys.manage` | `Idempotency-Key` required on POST [P, 7-2 precedent] |
| `GET/PATCH/DELETE …/journeys/:id` | Read, rename, archive (soft) | read / manage | — |
| `GET …/:id/versions`, `POST …/:id/versions` | List; create a draft (copy of latest) | read / manage | Key required |
| `PUT …/:id/versions/:vid/graph` | Replace the draft graph; `If-Match` on the draft's `graph_sha256` | manage | Converges (replace semantics) |
| `POST …/:id/versions/:vid/validate` | Validation report, no write | read | — |
| `POST …/:id/versions/:vid/publish` | Freeze the version | manage | Key required |
| `POST …/:id/activate`, `pause`, `resume`, `archive` | Lifecycle (§8.5) | manage (activate: see OD-8C-1) | Conditional transitions; repeat is a no-op |
| `POST …/:id/enrollments` | API trigger: enrol contact ids (≤ 1,000 per call [P]) | manage | Key required; per-contact `entry_ref` is derived from the key |
| `GET …/:id/executions`, `GET …/executions/:eid` | Executions; one execution with its steps | read | — |
| `POST …/executions/:eid/cancel` | Operator cancel | manage | Conditional; repeat is a no-op |
| `GET …/:id/stats` | Per-node counts and outcome totals for the version(s) | read | — |

**Permissions [P, 8B-1 precedent]:** new keys `journeys.read` and `journeys.manage`, at organisation and workspace scope. They are granted to `campaign_editor` (its description already names journeys [V]) and to the org/workspace administrator roles, following the `campaigns.*` grants. Classification, route-coverage and permission-classification tests are updated.

---

## 8. Execution semantics

### 8.1 Enrolment
- **Event trigger:** the runner reads unprocessed `automation_events`, matches active triggers, and inserts executions with `entry_ref = event id`. Unique keys make a re-read harmless. The event is marked processed in the same transaction.
- **Scheduled trigger:** the runner claims a due trigger (`next_fire_at <= now()`, `FOR UPDATE SKIP LOCKED`). It resolves the segment through `ContactsService.resolveAudience` in keyset batches and enrols with `entry_ref = trigger id + fire time`, then advances `next_fire_at`.
- **API trigger:** synchronous insert under the request's `Idempotency-Key`.
- **Re-entry policy** (`entry_policy`) [P]: default `once` (a contact enters a journey once ever). Alternatives are `after_exit` and `after_exit_with_cooldown`. A contact already in a live execution is never enrolled twice (partial unique).
- **Entry checks:** the contact is live and in the workspace, and the journey is `active`. A contact without a usable identity for the first send node still enters; the send node then records `skipped: no_identity`.

### 8.2 Claim and fencing (as in `DispatchWorker`)
- Claim: `UPDATE journey_execution_queue SET claim_token = gen, claimed_until = now() + lease, epoch = epoch + 1 WHERE … available_at <= now() AND (claimed_until IS NULL OR claimed_until < now()) … FOR UPDATE SKIP LOCKED`.
- Defaults [P]: batch ≤ 10, lease 30 s, poll 1 s ± 20 %, per-organisation share ≤ 5 per tick (fairness).
- Every transition is a conditional update: `UPDATE journey_executions SET current_node_key = :next, state_version = state_version + 1 … WHERE id = :id AND state_version = :expected AND status IN ('running', 'waiting')`. The update joins a queue row that still holds the claim token. Zero rows means another runner won or the execution ended, and the transition becomes a no-op.

### 8.3 Steps
- **One transaction per transition:** the node's effect, the history row and the execution advance commit together.
- **Waits** set `wake_at` and the queue `available_at`, then release the claim.
- **Conditions** read current contact state inside the transaction (no stale cache).
- **`wait_for_outcome`** reads the referenced step's `message_id` status. A non-terminal status re-arms the wait until the outcome or the timeout edge.

### 8.4 Sends: exactly-once business outcome
- The send node calls `MessageSubmissionCore.submit(tx, ctx, request)` **in the same transaction** that inserts the step row (with `message_id`) and advances the execution.
  - A crash before commit leaves nothing.
  - After commit, the step row exists, and a reclaim sees the advanced `state_version` and does not resend.
  - `UNIQUE (message_id)` on steps, together with the per-`(execution_id, seq)` uniqueness, is the database guard. No `Idempotency-Key` is needed on this internal path.
- **Request** built from the version's frozen node: channel, template, variables resolved from contact fields at send time, and the recipient's identity for that channel.
- **Origin attribution:** `journey_id` and `journey_execution_id` are passed to the core as an optional origin. This is a small, additive change to the core contract, shared with 8B-3's `campaign_id` need (register DEP-5).
- **Refusals** are mapped to step outcomes, never retried blindly:
  - suppression or consent → `skipped` (default: continue to `next`; configurable to exit);
  - billing refusal (insufficient funds, frozen, not configured) → `refused` (default: exit with reason; optional bounded retry after a delay);
  - validation (template no longer approved, missing variable) → `failed` (exit).
- **No new send path:** the 7-3 structural test (only the core inserts into `messages` or the dispatch queue) is kept and extended so that `journeys` never imports dispatcher, adapter or billing code.

### 8.5 Lifecycle
- **`draft → active`:** requires a published version. A trigger set is derived, and the activation is audited.
- **`active → paused`:**
  - triggers stop enrolling;
  - waiting executions keep their state, but are not claimed (the runner filters on the journey's status);
  - a send already committed is unaffected.
- **`paused → active`:** resumes. Executions whose `wake_at` has passed run on the next tick, with no burst cap beyond fairness [P].
- **Publishing a new version while active:** new enrolments use the new version, and **in-flight executions finish on their own version** (the roadmap's versioning requirement).
- **`archived`:** terminal. Live executions end `cancelled` (`journey_archived`).
- **Contact deleted, or identity removed, mid-journey:** the execution ends `exited` (`contact_unavailable`) at its next transition.

### 8.6 Kill switch and rollback
- `JOURNEY_RUNNER_ENABLED` (default **false**) stops all claiming.
- Sends are separately gated by `JOURNEY_SENDS_ENABLED` (default **false**), which returns `JOURNEY_SEND_DISABLED` at activation of any version containing a send node, until OD-8C-1 and OD-8C-2 are approved.
- Rollback is a standard app rollback: tables are durable and runner-only state is in PostgreSQL.

---

## 9. Failure handling and retries

| Failure | Behaviour |
|---|---|
| Transient (serialisation failure, lock or statement timeout, connection loss) | The transaction rolls back; the claim lapses; retry with jittered backoff [P: 3 attempts, then the execution fails with `RUNNER_RETRY_EXHAUSTED`] |
| Runner crash mid-step | Nothing committed, so the lease expires and another runner reclaims; the fencing epoch defeats a late commit from the old claim |
| Duplicate runner instances | `SKIP LOCKED` plus the conditional update give one winner per transition |
| Duplicate trigger event | `UNIQUE (org_id, kind, dedupe_key)` and `(journey_id, contact_id, entry_ref)` |
| Poison execution (repeated failure on one node) | After N [P: 5] failed claims, the execution ends `failed` with the error code, and an error-level log plus a bounded metric are emitted |
| Graph invalid at run time (deleted template, revoked segment) | The step fails and the execution exits `failed` with a stable code; the journey stays active for others |

---

## 10. Frontend / backend boundary

- **Backend (Claude):** contracts (`packages/contracts/src/journeys.ts`: graph types, node catalogue, validation result, DTOs), validation, APIs, runner, migrations, tests and documentation.
- **Frontend (Gemini, `apps/web`):** graph editor, node palette driven by the contract catalogue, inline validation via the validate endpoint, lifecycle controls, execution explorer, per-node statistics view.
- **Contract rule:** validation logic lives once, in `packages/contracts`. The UI may pre-validate with the same function, but the server is authoritative.

---

## 11. Security requirements

1. **Tenant isolation:** RLS on every new table, and composite foreign keys. Cross-org and cross-workspace ids return `404`, following precedent. Tests run as `acc_app` with two organisations.
2. **No bypass of consent or suppression:** proven by tests that send through a journey to:
   - a suppressed recipient;
   - a consent-revoked recipient;
   - a recipient suppressed *after* the message is queued (the dispatcher re-check applies).
3. **Executor identity (OD-8C-1):** fail-closed. Without the approved principal, a runner transaction cannot create a message; that RLS refusal is itself a test.
4. **Authorisation:** `journeys.manage` for mutations. Activation also requires the activating user to hold `messages.send` at the journey's workspace [P]. That rule keeps a journey from granting send rights its author lacks.
5. **No outbound network** in 8C, unless OD-8C-3 chooses otherwise.
6. **Confidentiality:**
   - step `details` hold no message content or addresses;
   - metrics carry no `journey_id` or `contact_id` labels (`OBSERVABILITY.md` §1 rule [V]);
   - logs carry the correlation set.
7. **Audit:** create, update, publish, activate, pause, resume, archive, enrol (API) and cancel are audited, with actor and target and no content.
8. **Scope-creep pins:** the new runner is added to the "worker" category exception with an explicit owner citation, exactly like `DispatchWorker`.

---

## 12. Test coverage and measurable acceptance criteria

**Unit:**
- graph validation (each rule, positive and negative);
- lifecycle state machine;
- refusal → outcome mapping;
- schedule next-fire computation (time zones, DST);
- argument and DTO validation.

**DB integration (disposable clones only):**
- RLS and composite foreign keys;
- immutability of published versions and steps;
- partial-unique enrolment;
- event-trigger capture (contact and message outcome);
- retention purge.

**API integration:**
- full CRUD, versioning and lifecycle;
- `Idempotency-Key` on creating POSTs (replay, mismatch `422`, concurrent duplicates);
- keyset pagination;
- OpenAPI contract and route-authorisation coverage.

**Concurrency and fault tests (named, each must pass):**
- **J-C1:** two runners on one due execution → exactly one transition and one step row.
- **J-C2:** crash after the core insert but before commit → no message; on reclaim, exactly one message.
- **J-C3:** a lease expires during a slow step → the old claim's commit is fenced out.
- **J-C4:** the same automation event is processed twice → one execution.
- **J-C5:** a scheduled trigger fires on two runners at the same instant → one enrolment per contact.
- **J-C6:** API enrolment replayed with the same key → the same response, no new executions.

**Versioning:**
- **J-V1:** an in-flight execution on v1 completes on v1 after v2 is published.
- **J-V2:** a published version is immutable.

**Branching:**
- **J-B1:** every condition kind routes true and false correctly, using live contact state.
- **J-B2:** a delivery-outcome branch with a timeout. This uses simulator receipts in tests, because delivery ingress stays disabled [V].

**Security:**
- **J-S1:** suppressed recipient.
- **J-S2:** consent-revoked recipient.
- **J-S3:** cross-tenant ids.
- **J-S4:** no message is created without the approved executor principal.
- **J-S5:** activation without `messages.send`.

**Parity (roadmap acceptance; requires send enablement):**
- **J-P1:** for the same contact, template and variables, a journey send and a `POST /messages` produce messages that are field-identical except origin attribution and correlation. Their routing/fallback attempts and dispatch outcome match.
- **J-P2:** with `BILLING_ENFORCEMENT_ENABLED` on a clone, the reservation, settlement and ledger facts match. `billing:reconcile` exits `0` after the run.

**Measurable targets [P]:**
- runner throughput ≥ 200 transitions/s on the development host with 10,000 waiting executions;
- wake latency p95 ≤ poll interval + 2 s;
- no duplicate message in 100 repeated J-C1/J-C2 runs;
- zero findings from `billing:reconcile` after J-P2;
- `journey_execution_steps` row count equals the committed transitions.

**Mutation checks** (each must fail the suite):
- remove the `state_version` predicate;
- drop the step `UNIQUE (message_id)`;
- send outside the transition transaction;
- skip the journey-status filter when claiming.

---

## 13. Implementation breakdown (independently reviewable draft PRs; each stops for review)

| PR | Content | Migration | Depends on |
|---|---|---|---|
| **8C-1** | Contracts (graph types, node catalogue, shared validator), `journeys`/`journey_versions`, permissions `journeys.read/manage`, CRUD, draft graph PUT, validate, publish (immutable), audit, OpenAPI | `0062` | Approval of this handover |
| **8C-2** | Lifecycle (activate/pause/resume/archive), `journey_triggers` derivation, `journey_executions` + queue + steps tables, API enrolment, executions read API, operator cancel, statistics | `0063` | 8C-1 |
| **8C-3** | `JourneyRunner` (flag off): claim, fencing, waits, conditions, `update_contact`, exit, stub nodes, retries, poison handling, J-C1/J-C3/J-V1/J-B1 suites | none [I] | 8C-2 |
| **8C-4** | Triggers: `automation_events` capture (contact service writes; `messages` outcome trigger), event intake, scheduled triggers through the audience resolver, retention purge, J-C4/J-C5 | `0064` | 8C-3 |
| **8C-5** | Send node: core origin attribution (`messages.journey_id`, `journey_execution_id`), refusal mapping, `wait_for_outcome`, J-C2/J-S1–S5, built with `JOURNEY_SENDS_ENABLED=false` | `0065` | 8C-4, and **OD-8C-1** for the principal (the node can be built and tested fail-closed before it) |
| **8C-6** | Enablement and parity: approved executor principal wired, J-P1/J-P2, volume measurement, runbook, metrics. Sends enabled only by flag, still off in every environment until owner approval | per OD-8C-1 | 8C-5, OD-8C-1, OD-8C-2 (8B-3 sequencing) |
| **8C-FE** (Gemini) | Builder, lifecycle UI, execution explorer, statistics | none | 8C-1 contract (can start on the contract), 8C-2 APIs |

Every PR:
- is a draft and unmerged until owner review;
- runs format, lint, typecheck, build, unit, DB/API/security suites on a fresh clone, and CI 5/5;
- records the migration history proof;
- includes an evidence folder with a SHA-256 manifest;
- is followed by `DECISIONS.md` "as built" entries.

---

## 14. Owner decisions (full text in `PHASE-8C-DECISION-REGISTER.md`)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| **OD-8C-1** | Automated sender identity for journey sends (joint with D-5 for 8B-3), including what happens when the activating user loses access | A claim-bound automation session admitted by RLS only while the runner holds a live claim; run-as = journey, with the activator's `messages.send` re-checked at activation and on resume. Decide once for both 8B-3 and 8C | 8C-5 (enable), 8C-6 |
| **OD-8C-2** | Sequencing against 8B-3 | Build 8C-1 to 8C-4 now (no sends). Decide the shared principal once, implement it in 8B-3 first, then enable journey sends in 8C-6 | 8C-6 |
| **OD-8C-3** | Webhook/API action nodes (roadmap scope, no outbound HTTP exists) | Contract-only stub in 8C; the real outbound action is a separate slice with SSRF controls, an allowlist, signing and secrets | 8C-1 node catalogue |

Everything marked [P] is a proposed default that can be changed at review; none needs an owner decision.

---

## 15. Documentation deliverables (per PR)

- `DECISIONS.md` §1zj ("as built" sub-entries);
- `API.md` (`/journeys` → workspace-scoped);
- `DATABASE.md` §9 (actual tables);
- `EVENTS.md` (journey events recorded as step history, not a bus);
- `RBAC.md` (journey keys);
- `RUNBOOK.md` (runner kill switch, poison executions);
- `OBSERVABILITY.md` (metrics);
- `ROADMAP.md` §11c status line.

---

## 16. Owner approval and decisions (10-Nov-2026)

**Implementation authorised:** 8C-1 to 8C-4 only, as the non-sending foundation. The runner and sending switches stay off. 8B-3, 8C-5/8C-6 sending, webhook execution and unrelated roadmap work are not authorised. A fresh migration number must be verified against `develop`, and PR #65's number must not be reused. PRs stay separate, draft and unmerged.

**Owner decisions:**
1. **OD-8C-1 (and D-5):** a **shared, organisation-owned automation sending principal** serves both campaigns and journeys. It uses **short-lived, execution-scoped capabilities**, preserves **initiator attribution**, and supports **administrator pause and revocation**. The initiating user's departure does **not** automatically terminate an authorised automation.
2. **OD-8C-2:** build 8C-1 to 8C-4 first. The shared campaign sending identity belongs in **8B-3**; journey sending in 8C-6 must **reuse** it.
3. **OD-8C-3:** webhook/API action steps are **placeholders only**. There is no outbound HTTP implementation in 8C.

**Effect on this handover:**
- §8.4 and §11.3 describe a claim-bound session as the recommendation. The binding design is now the owner's principal (decision 1), designed in 8B-3 and reused in 8C-6.
- §11.4's activation rule (the activator holds `messages.send`) remains a [P] default for 8C-2. Revocation and pause by an administrator are requirements on the 8B-3 principal.

