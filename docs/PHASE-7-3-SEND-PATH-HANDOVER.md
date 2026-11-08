# ACC Phase 7.3: Shared Message Submission Core, Implementation Handover

**Status:** APPROVED by the owner, 08-Nov-2026 (D-1, D-2 and D-3), with the clarifications recorded in `DECISIONS.md` §1zi.6. Implemented as one draft PR.

**Owner clarifications (binding where this document differs):**
- **Sequence:** 7.3 shared send-path refactor → 7.4 reservation → 7.5 settlement → Gate 7-A → 8B-3 campaign execution.
- **Reservation:** campaign-specific chunked reservation is withdrawn. There is one authoritative per-message reservation path, shared by ordinary and campaign-originated messages.
- **Pure refactor:** 7.3 stays a pure refactor. The core calls no billing, pricing or ledger function, and this PR introduces no reservation.
- **Campaign scope:** campaign ids, recipient fields and campaign-specific behaviour stay out of the core.
- **Documentation scope:** the PR is not broadened into documentation cleanup. Items C-5 and DEP-6, the `ARCHITECTURE.md` note, and the correction note to the 8B handover (D-1) are therefore **not** in this PR.
- **Blockers carried to 8B-3**, not 7.3 scope: DEP-4, DEP-5 and the executor identity (D-5).
- **Later decisions:** D-4 is decided before 7.4 starts; D-5 before 8B-3.
**Date:** 08-Nov-2026
**Baseline inspected:** `develop` at `f71395b` (PR #91 merged). PRs #87, #88, #90 and #91 are merged.
**Migration history proof on that commit:** `53|8b3f4018a42c3c46607b956d3dc7fdae` (`0000`–`0052`). This was computed on a disposable `with-db-clone` copy of `acc_r015_base` that has since been dropped. It is **not yet recorded in `RELEASE.md`** (§2.3).

**Authority, in order of precedence:**
1. `DECISIONS.md` §1zi, the owner-approved Phase 7 decisions. In particular, §1zi.3 records **OD-7-10: "PR 7-3 owns the shared send-path refactor."**
2. The Phase 7 consolidated baseline, Rev 3 (owner's evidence store), §4, §6.1 and §8.1.
3. `ROADMAP.md` §10 (Phase 7) and §11b (Phase 8B); `ARCHITECTURE.md` §§11, 22 and 26.
4. `docs/PHASE-8B-CAMPAIGNS-BACKEND-HANDOVER.md`, merged with PR #91. Where it conflicts with items 1–2, see §2.2 and decision D-1.

This document makes **no financial-policy decision**. Where it touches a later billing step, it records the constraint and names the open decision.

---

## 1. Purpose and outcome

Today exactly one code path creates a logical message: `MessagesService.sendMessage` (`apps/api/src/messages/messages.service.ts:110-657`). It is fused to the HTTP request. It reads the principal and correlation id from the request context, opens its own tenant transaction through the idempotency service, and shapes an HTTP response.

PR 7-3 extracts the **business core** of that path into one principal-independent, transaction-scoped component, `MessageSubmissionCore`. Every present and future caller must use it:
- `POST /messages` (now);
- the Phase 8B campaign executor (PR 8B-3);
- later, journeys and other engagement-layer callers (`ARCHITECTURE.md` §26).

The extraction is **behaviour-preserving**:
- the HTTP contract does not change: status codes, bodies, error codes, messages, headers and OpenAPI;
- the rows written do not change;
- there is no migration, contract or configuration change;
- there is no billing.

What it delivers is structural: one place where a message is created. PR 7-4 can then add units, rating and reservation **once**, and PR 8B-3 can call the same code instead of writing a second send path.

---

## 2. Reconciliation of sources

### 2.1 Consistent sources

| Source | What it says about 7-3 | Status |
|---|---|---|
| `DECISIONS.md` §1zi.3, OD-7-10 | PR 7-3 owns the shared send-path refactor | Approved, binding |
| Baseline Rev 3, §8.1 | "7-3: submission-core extraction, behaviour-preserving (shared with 8B-3, OD-7-10)". No dependency; parallel with 7-1/7-2 | Approved baseline |
| Baseline Rev 3, §8.1 | "7-4: units persistence, T0 rating and reservation, error contract, `BILLING_ENFORCEMENT_ENABLED` (default false)". Depends on 7-2 and 7-3 | Approved baseline |
| Baseline Rev 3, §4 and §6.1 | One shared submission core for `POST /messages`, campaigns and journeys. Reservation runs **after all existing checks**, in the same transaction as the message, queue and event inserts. API idempotent replay never re-runs T0 | Approved baseline (enforcement is 7-4) |
| Phase 7 plan, §6.1 | Extract `MessageSubmissionCore.submit(tx, ctx, input)` with no behaviour change. No caller-specific billing path is permitted | Plan, adopted by the baseline |
| `ROADMAP.md` §11b | A campaign must drive messages through the pipeline "identically to a direct API call" | Roadmap |
| `ARCHITECTURE.md` §§22, 26 | Engagement-layer features never get a private integration or send path | Normative |

### 2.2 Conflicts found (none is resolved silently here)

| # | Conflict | Effect | Proposed resolution |
|---|---|---|---|
| C-1 | `PHASE-8B-CAMPAIGNS-BACKEND-HANDOVER.md` (merged with #91) calls PR 7-3 "funds reservation and ledger posting" (Invariant 3; §1 diagram). Under the approved baseline, 7-3 has no billing and reservation is 7-4. | An 8B-3 gate written as "after 7-3" would open before reservation exists. | **D-1.** The baseline numbering stands. The 8B-3 gate becomes "after 7-4 and 7-5 and Gate 7-A". |
| C-2 | The same document (§6.2) proposes a **campaign-level** "chunked reservation via `app_ledger_post('reservation')`" and a bulk pre-dispatch funds check. | (a) This is the caller-specific billing path the baseline (§4) and plan (§6.1) forbid. (b) `app_ledger_post` is executable by no application role (`DECISIONS.md` §1zi.4), and per-message reservation is the approved design (`BILLING.md` §8; baseline §6.1). | **D-1.** Per-message reservation inside the core (7-4) is the only authoritative reservation. A campaign-level estimate can only ever be advisory. |
| C-3 | The same document (§6.1) shows the executor calling `messagesService.sendMessage(principal, {…, campaignId, idempotencyKey})`. | `sendMessage` is the HTTP adapter. It needs a request context, and its key is the HTTP `Idempotency-Key`. Called from a worker it would fail closed (`tenant-database.service.ts:172-180`), and per-recipient HTTP keys would be the wrong duplicate control (§7.3). | The executor calls `MessageSubmissionCore.submit` inside its own tenant transaction (8B-3). Recorded for 8B-3; nothing to decide for 7-3. |
| C-4 | `ROADMAP.md` §10 lists a "ledger-writer consumer (`EVENTS.md` §5)". | Superseded by OD-7-2: settlement inside the dispatcher's transactions, no event bus. | Already decided (§1zi.1). No action in 7-3. |
| C-5 | The `ROADMAP.md` §10 status line still says PR 7-2 "is implemented as a draft PR". | Stale: #90 is merged. | Documentation correction in the 7-3 PR (§10.1). |

### 2.3 Facts from PR #91 that constrain the core (verified on `f71395b`)
- **Campaign foreign key.** Migration `0052` adds `messages.campaign_id` with a **single-column** foreign key to `campaigns(id)`, not a composite `(campaign_id, org_id)` key. Foreign-key checks are not subject to RLS, so the database would accept a `campaign_id` belonging to another organisation. Every other cross-table reference on `messages` is composite (`messages_workspace_org_fk`, `messages_contact_workspace_org_fk`).
- **No duplicate backstop.** There is no `messages.campaign_recipient_id` column or unique backstop. `campaign_recipients.message_id` exists but is not unique.
- **Migration proof not recorded.** `RELEASE.md` §5.2 still lists `52|599f2005…` as the latest proof; the `0052` proof above is not recorded.
- **Dispatch disabled.** Campaign dispatch is disabled (`400 CAMPAIGN_DISPATCH_DISABLED`), and `CampaignsService` does not reference the send path.

---

## 3. Current send path (verified on `f71395b`)

`MessagesController.send` (`messages.controller.ts:38-53`) calls `MessagesService.sendMessage(principal, dto, idempotencyKey)`.

| Step | What happens | Lines |
|---|---|---|
| A | `orgId` comes from the authenticated principal (`requireOrganization`), never from input | 115 |
| B | The `authorize` closure asserts `messages.send` at **organisation** scope | 117-123 |
| C | `IdempotencyService.execute`:<br>• **key optional** (`API.md` §4); without one the work runs in a plain `withRequestTenant` transaction;<br>• with one: claim, work and finalize in one transaction; `lock_timeout` 3 s; replay re-authorizes, then replays; `422` on a different request; `409` while in flight;<br>• fingerprint body: `channelCode, recipient, templateId, workspaceId, payload` | 125-143; `idempotency.service.ts:148-215` |
| 1 | Channel resolve (`app_channel_resolve`). Inactive or unknown → `404 RESOURCE_NOT_FOUND`; not dispatchable → `422 CHANNEL_NOT_SUPPORTED` | 147-162 |
| — | Workspace: an explicit id must belong to the organisation (`404`); otherwise the default workspace (`500` if absent) | 164-194 |
| 2 | Address normalisation (`normalizeAddress`) | 197 |
| 3 | Suppression (channel-specific or organisation-wide, `active`) → `422 RECIPIENT_SUPPRESSED` | 199-223 |
| 4 | Contact and identity resolution. A first send creates the contact and identity **in a savepoint**; losing a concurrent race (`uq_contact_identities_workspace_active`) reuses the winner | 225-294 |
| 5 | Consent: the latest event group containing `revoke` → `422 CONSENT_REVOKED` | 296-330 |
| 6 | Template: not found `404`; channel mismatch `422 VALIDATION_FAILED`; not approved `422 TEMPLATE_NOT_APPROVED` | 332-378 |
| 6b | SMS rules:<br>• payload shape;<br>• D-7 template and DLT requirement;<br>• DLT validity and match;<br>• body re-validation;<br>• variables;<br>• render;<br>• `payload.text` restatement only;<br>• segment ceiling.<br>The persisted payload is server-derived. RCS: payload and URL safety | 380-584 |
| 7 | Active provider assignment on the channel → `422 NO_ACTIVE_PROVIDER_ASSIGNMENT` | 586-606 |
| 8–10 | Insert the `messages` row (`status='queued'`, `correlationId` from `RequestContext`), the `message_dispatch_queue` row (epoch 0) and the `message_events` row `message.queued` | 608-645 |
| — | Returns `{ data: { id, status:'queued', createdAt, correlationId } }`, `202` | 647-654 |

**Properties relied on later:**
- **One transaction for everything, including the idempotency record.** Any refusal rolls back the contact savepoint, the inserts and the key claim.
- **No row lock is taken explicitly.** The only waits are on the contact-identity unique index and, when keyed, on the idempotency key row.
- **No audit row, metric or log is written on success.** (Inferred from the imports and the code. No `AuditWriter` or metrics dependency is injected.)
- **RLS.** `messages`, `contacts`, `contact_identities` and `campaigns` admit `acc_app` only when `org_id = app_current_org_id()` **and** `app_content_context_valid()` (`0033:246-252`, `0031:146-157`, `0052:94-109`). `app_content_context_valid()` (`0027:85`) requires an active **user with an organisation-level role** or an **API key** in the session. A session without either cannot read or write these tables.
- **Authorization coverage.** `TenantDatabase` refuses to commit a write on a route whose declared permission was not checked (`tenant-database.service.ts:147-166`).
- **Units.** The dispatcher re-derives SMS segments independently (`dispatch/submission-mapping.ts:95`). Units are not persisted today. That is 7-4.

---

## 4. Target architecture

```
                 ┌──────────────────────── HTTP adapter (unchanged contract) ────────────────────────┐
POST /messages ─▶│ MessagesController.send                                                           │
                 │  └ MessagesService.sendMessage(principal, dto, key)                               │
                 │      • orgId ← principal                                                          │
                 │      • IdempotencyService.execute (fingerprint, replay, 202) ── one tenant txn ──┐ │
                 │      •   authorizeSubmission(tx, principal, orgId)  → SubmissionAuthorization    │ │
                 │      •   core.submit(tx, ctx, request)              → SubmissionResult           │ │
                 │      •   map result → { data: QueuedMessageResponse }                            │ │
                 └──────────────────────────────────────────────────────────────────────────────────┘ │
                                                                                                        │
Campaign executor (8B-3, NOT in 7-3) ─▶ own withTenant txn → its own authorization → core.submit ───────┤
Journeys (8C, NOT in 7-3)            ─▶ same rule                                                     │
                                                                                                        ▼
                        MessageSubmissionCore.submit(tx, ctx, request)   [apps/api/src/messages/submission/]
                          channel → workspace → normalise → suppression → contact → consent →
                          template → channel rules (SMS/RCS) → provider assignment →
                          ┊ (7-4 seam, see §6.3; nothing added in 7-3)
                          insert message → insert queue row → insert message.queued event
```

**Division of responsibility**

| Concern | HTTP adapter (`MessagesService.sendMessage`) | `MessageSubmissionCore` |
|---|---|---|
| Principal, `orgId`, correlation id | Derives them from the validated request | Receives them in `ctx`; never reads `RequestContext` |
| Authorization (`messages.send`) | Performs it (`authorizeSubmission`) | Requires the resulting proof (§5.2); never authorizes |
| Transaction | Owns it, through `IdempotencyService.execute` | Runs in the caller's `tx`; never opens, commits or releases one. Its only nesting is the existing contact savepoint |
| HTTP idempotency | Owns the fingerprint, replay and status | None. Each call creates one message (§7) |
| Business checks and inserts | None | All of steps 1–10, in today's order |
| Response shape | Maps `SubmissionResult` to `QueuedMessageResponse` | Returns a plain result object |
| Errors | Lets `AppException` propagate unchanged | Throws today's `AppException`s unchanged (§9) |

**Placement:**
- `apps/api/src/messages/submission/message-submission.core.ts`, with `submission.types.ts` beside it.
- `MessageSubmissionCore` is a provider of `MessagesModule`. It is **not exported** in 7-3: there is no second consumer yet. Exporting it is 8B-3's change, so the boundary does not widen ahead of need (safeguard 5, §1zi.3).

---

## 5. Interfaces (normative shape; names may be refined in review)

### 5.1 Types
```ts
/** What is being sent: exactly today's SendMessageDto fields, no more. */
export interface SubmissionRequest {
  readonly channelCode: string;
  readonly recipient: string;
  readonly templateId?: string;
  readonly workspaceId?: string;
  readonly payload: Record<string, unknown>;
}

/** Who is sending, and under what proof. Built by the caller from validated material only. */
export interface SubmissionContext {
  readonly orgId: string;               // from the authenticated principal or the executor's claimed envelope
  readonly correlationId: string;       // today: RequestContext.correlationId()
  readonly authorization: SubmissionAuthorization;
}

export interface SubmissionResult {
  readonly messageId: string;
  readonly status: 'queued';
  readonly createdAt: Date;
  readonly correlationId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelCode: string;
}

@Injectable()
export class MessageSubmissionCore {
  submit(tx: Transaction, ctx: SubmissionContext, request: SubmissionRequest): Promise<SubmissionResult>;
}
```

**Not in the 7-3 input:** `campaignId`, `campaignRecipientId`, an "origin" discriminant, units, a price or a billing flag. This is decision D-2. Adding fields with no caller is speculative (safeguard 5), and `messages.campaign_id` needs the cross-organisation safeguard in §2.3 before anything writes it.

### 5.2 Authorization proof (`SubmissionAuthorization`)
Without a guard, a future caller could reach `submit` without asserting `messages.send`. The authorization-coverage check (§3) catches that only on HTTP routes.

- **Minting.** `authorizeSubmission(tx, principal, orgId)` in the submission module calls `AuthorizationService.assert` exactly as today: `messages.send`, organisation scope, resource type `Organization`. It returns an opaque, module-private branded value bound to `{ tx, orgId }`.
- **Checking.** `submit` refuses, with an internal error and **before any read**, when:
  - `ctx.authorization` was not minted by this module;
  - its `tx` is not the `tx` passed in (reference equality);
  - its `orgId` differs from `ctx.orgId`.
- **Scope.** This is a programming-error guard, not a new authorization rule. Permission, scope, target and audit behaviour are unchanged.
- **Later callers.** 8B-3 will need an equivalent minting function for the executor's principal (D-5). That function is designed in 8B-3, not here.

### 5.3 HTTP adapter after 7-3 (illustrative)
```ts
async sendMessage(principal, dto, idempotencyKey) {
  const orgId = requireOrganization(principal);
  const authorize = (tx) => authorizeSubmission(tx, this.authorization, principal, orgId);
  return this.idempotency.execute({
    key: idempotencyKey, successStatus: HttpStatus.ACCEPTED,
    request: { method: 'POST', route: '/messages', orgId, principal, pathParams: {}, query: {},
               body: { channelCode: dto.channelCode, recipient: dto.recipient, templateId: dto.templateId,
                       workspaceId: dto.workspaceId, payload: dto.payload } },     // byte-identical fingerprint
    authorize,
    work: async (tx) => {
      const proof = await authorize(tx);
      const r = await this.core.submit(tx, { orgId, correlationId: RequestContext.correlationId(), authorization: proof }, dto);
      return { data: { id: r.messageId, status: r.status, createdAt: r.createdAt.toISOString(), correlationId: r.correlationId } };
    },
  });
}
```
The fingerprint body, route string, success status and replay behaviour must be **byte-identical**. Otherwise keys stored before the deploy would replay as `422` after it.

---

## 6. Transaction boundaries and ordering

### 6.1 Rules for the core
1. **Caller's transaction only.** The core never calls `withTenant`, `withRequestTenant`, `whenReleased`, `withAuth`, a pool or `COMMIT`. It uses `tx` and the existing contact savepoint (`tx.transaction`) only.
2. **No context reads.** It never reads `RequestContext` or `AsyncLocalStorage`. Everything comes from `ctx` and `request`.
3. **Order preserved exactly.** The order is steps 1 → workspace → 2 → 3 → 4 → 5 → 6 → 6b → 7 → 8 → 9 → 10. Error precedence is therefore unchanged: for example, a suppressed recipient with an unapproved template still gets `RECIPIENT_SUPPRESSED`.
4. **Atomic outcome.** Any throw rolls back the whole caller transaction: contact savepoint, inserts and, on the HTTP path, the idempotency claim. No partial message, queue row or event can commit.
5. **No new locks.** There is no `FOR UPDATE`/`FOR SHARE`, no advisory lock and no `lock_timeout` change. The lock profile in §3 is unchanged.

### 6.2 Database roles
- **Role.** The core runs as `acc_app` under the caller's tenant session. There are no new grants and no `SECURITY DEFINER` functions.
- **Functions it must not call.** `app_price_lookup`, `app_rate_message`, `app_ledger_post` and any `acc_dispatch` object. None is executable by `acc_app` today (§1zi.4, §1zi.5), and 7-3 does not change that.

### 6.3 The 7-4 seam (constraint recorded, nothing implemented)
For 7-4's design, not for 7-3:
- `app_ledger_post` locks the **message row and then the billing account** (§1zi.4).
- The billing account must be the **last row lock** in the transaction (§1zi.1).
- Reservation must follow **all** refusing checks (baseline §6.1).

The natural seam is therefore immediately after step 10, inside `submit` and before it returns: the message row exists, the account is locked last, and nothing after it waits on another row.

7-3 adds **no** hook, interface, flag or placeholder at this point. A no-op billing hook would be speculative and would itself be a caller-visible seam. The seam is fixed by a comment and by the order-pinning test (§11.3).

---

## 7. Idempotency

### 7.1 HTTP path (unchanged)
- `Idempotency-Key` stays **optional** on `POST /messages` (`API.md` §4).
- Organisation namespace, endpoint `POST /messages`, same five-field fingerprint, `202` stored and replayed.
- A replay re-authorizes and **never re-runs the core**. This is the property baseline §6.1 relies on: a replay never re-runs T0, and from 7-4 never re-reserves.

### 7.2 The core is not idempotent by itself
Each successful `submit` creates exactly one message. Duplicate prevention belongs to the caller, because only the caller knows what "the same request" means:
- **HTTP:** the `Idempotency-Key`.
- **Campaign executor (8B-3):**
  - lock the recipient row (`FOR UPDATE SKIP LOCKED`);
  - write `campaign_recipients.message_id` and its status in the **same transaction** as `submit`;
  - have a database backstop.

  The backstop **does not exist after `0052`** (§2.3). It is an 8B-3 dependency (DEP-5).

### 7.3 Existing gap, not changed by 7-3
An unkeyed `POST /messages` that the client retries creates a second message today. Once 7-4 reserves funds, it would also create a second reservation.
- **7-3 preserves this behaviour.** Changing it changes the public contract.
- Whether the key becomes mandatory before enforcement is switched on is decision **D-4**, needed **before 7-4**, not for 7-3.

---

## 8. Security and tenant isolation

| Invariant | How 7-3 keeps it | Test |
|---|---|---|
| The tenant comes only from validated authentication material (`TENANCY.md` §§2, 5) | `ctx.orgId` is set by the adapter from `requireOrganization(principal)`. The core takes no organisation from `request` | Parity: a cross-org `workspaceId` gives `404`, as today |
| RLS is the backstop | Caller's tenant session; `acc_app`; no definer or bypass | Existing RLS suites unchanged; a core call in a session without content context fails closed |
| Authorization before any write | `SubmissionAuthorization` proof (§5.2) plus the unchanged coverage check | Proof-mismatch tests; route-authorization coverage counts unchanged |
| A refused request writes nothing | Single transaction; savepoint inside it | Parity: a refusal after first-send contact creation leaves no contact or identity row |
| No new send path | Only the core inserts into `messages`, `message_dispatch_queue` or `message.queued` events | Structural test (§11.3) |
| No billing, rating or provider access | The core imports no billing, pricing, ledger, adapter or dispatcher module | Structural test; scope-creep spec |
| Logging and redaction | `logContext` contents byte-identical | Parity on error bodies; existing redaction tests |
| Workspace isolation | Unchanged:<br>• authorization at organisation scope;<br>• an explicit workspace is checked against the organisation;<br>• the default workspace is used otherwise.<br>Narrowing authorization to workspace scope is **out of scope** (it would change behaviour) | Parity |

**Constraint carried to 8B-3, not changed here:**
- `app_content_context_valid()` admits only a session with an active org-level user or an API key.
- A campaign executor running as a bare "system" session therefore cannot create a message through RLS, which is correct and fail-closed.
- 8B-3 must decide the executor's tenant session and authorization principal (D-5). 7-3 must not weaken RLS or add a definer to anticipate that.

---

## 9. Error handling

- **Unchanged errors.** Every status, `ERROR_CODES` value, message string and `logContext` is unchanged. No code is added, removed or remapped.
- **Codes in precedence order:**
  1. `RESOURCE_NOT_FOUND` (channel)
  2. `CHANNEL_NOT_SUPPORTED`
  3. `RESOURCE_NOT_FOUND` (workspace) / `INTERNAL_ERROR` (no default workspace)
  4. `PHONE_MISSING_COUNTRY_CODE` / `INVALID_PHONE_NUMBER` (`400`, address normalisation; added during implementation, as the original list omitted them)
  5. `RECIPIENT_SUPPRESSED`
  6. `CONSENT_REVOKED`
  7. `RESOURCE_NOT_FOUND` (template) / `VALIDATION_FAILED` / `TEMPLATE_NOT_APPROVED`
  8. SMS: `SMS_PAYLOAD_INVALID`, `SMS_DLT_METADATA_REQUIRED`, `SMS_DLT_METADATA_INVALID`, `SMS_DLT_TEMPLATE_MISMATCH`, `SMS_TEMPLATE_INVALID`, `SMS_TEMPLATE_VARIABLE_INVALID`, `SMS_MAX_SEGMENTS_EXCEEDED`; RCS: `RCS_PAYLOAD_INVALID` / `RCS_UNSAFE_ACTION_URL`
  9. `NO_ACTIVE_PROVIDER_ASSIGNMENT`

  Idempotency errors (`422`/`409`) stay in the adapter.
- **Propagation.** The core throws; it does not catch-and-map, except for the existing contact-race `23505` handling, which moves unchanged. Unknown database errors propagate as today (generic `500` with correlation id).
- **The proof-mismatch guard (§5.2) is a programming error.** It raises a generic internal error before any read, and must not be reachable from any HTTP input. A test proves this.
- **Not in 7-3.** Mapping core refusals to campaign-recipient outcomes (`skipped`/`failed`) is 8B-3. The billing refusals (`402 BILLING_INSUFFICIENT_FUNDS`, `503 BILLING_BUSY`, the `BL000`–`BL008` mapping) are 7-4 and OD-7-8.

---

## 10. Proposed PR scope (PR 7-3, one draft PR)

### 10.1 In scope
1. **The core.** New `apps/api/src/messages/submission/` with `message-submission.core.ts`, `submission.types.ts` and `submission-authorization.ts`. The code moves from `MessagesService.sendMessage` unchanged in logic.
2. **The adapter.** `MessagesService.sendMessage` reduced to the adapter in §5.3. `MessagesModule` registers `MessageSubmissionCore` (not exported).
3. **Tests.** The tests in §11, including characterisation tests committed **before** the refactor.
4. **Scope-creep spec.** Allowlist entries in `scope-creep.architecture.spec.ts` for vocabulary that **moves** from `messages.service.ts` to the new files (for example `messageDispatchQueue`, `queued`, `QueuedMessageResponse`), recorded as "moved by 7-3, no new behaviour". Entries no longer used by `messages.service.ts` are removed, so the census stays exact.
5. **Docs:**
   - `DECISIONS.md` §1zi.6 "PR 7-3 as built";
   - this handover.

   The other documentation items first proposed here (the C-5 status line, an `ARCHITECTURE.md` note, the DEP-6 proof and the 8B handover correction) were removed by the owner's instruction not to broaden the PR.

### 10.2 Out of scope (explicit)
- **Billing:**
  - units persistence or snapshot;
  - rating;
  - reservation, settlement or reservation extension;
  - `BILLING_ENFORCEMENT_ENABLED`;
  - any `BL*` or HTTP billing error;
  - grants on billing or pricing functions;
  - anything in the dispatcher (all 7-4 and 7-5).
- **Campaigns:**
  - campaign execution, executor, worker or scheduler;
  - campaign attribution on messages (`campaign_id`);
  - recipient backstop;
  - exporting the core to `CampaignsModule` (all 8B-3).
- **Public contract:**
  - making `Idempotency-Key` mandatory on `POST /messages` (D-4);
  - narrowing send authorization to workspace scope.
- **Other components:** migrations, `packages/contracts`, OpenAPI, configuration, environment schema, `apps/web` (Gemini-owned) and any merged 7.1 or 7.2 object.
- **Environments:** QA or production activity of any kind.

### 10.3 Size estimate (inferred)
- Production code moves about 540 lines and adds about 120 (types, proof, adapter).
- Tests add about 600–900 lines.
- No migration.

---

## 11. Required tests

### 11.1 Characterisation tests, committed first, against unmodified `develop` code
A new `apps/api/test/message-submission-parity.int-spec.ts`. It is committed and green **before** the refactor commit, then must stay green, **unchanged**, after it. It asserts complete observable output, not just status codes.

1. **Success, per channel and route:**
   - SMS with a template and DLT;
   - WhatsApp;
   - RCS;
   - explicit workspace;
   - default workspace;
   - an existing contact;
   - a first-send contact.

   For each, assert:
   - the response status and body shape;
   - the `messages` row columns (payload byte-equal; `status`, `correlationId`, `templateId`, `recipientAddress`, `campaignId IS NULL`);
   - the queue row (`dispatchEpoch` 0, organisation);
   - the `message.queued` event payload.
2. **Every refusal code in §9.** Status, code, message and the **absence** of any new row in `messages`, `message_dispatch_queue`, `message_events`, `contacts`, `contact_identities` and `idempotency_keys`.
3. **Precedence pairs.** For example: suppressed plus unapproved template → `RECIPIENT_SUPPRESSED`; consent revoked plus no provider assignment → `CONSENT_REVOKED`; template mismatch plus invalid SMS payload → `VALIDATION_FAILED`.
4. **Idempotency:**
   - keyed replay returns the same body and `202` and creates nothing;
   - a different body under the same key → `422`;
   - concurrent identical keyed requests → one message;
   - a key stored by the pre-refactor code replays after the refactor (same fingerprint);
   - unkeyed duplicates → two messages (pinned, D-4).
5. **Concurrency.** A first send to the same new address in parallel → one contact and one identity, both messages created (the existing race path).
6. **Principals.** User session and API key both succeed. A principal without `messages.send` → `403` with its `authorization.denied` audit row, and no write.

### 11.2 Existing suites, unchanged and green
- `messages-api.int-spec.ts`
- `phase4_1-data-foundation.sec-spec.ts`
- `phase4_2-sms-dispatch.int-spec.ts`
- `phase4_2-rcs-dispatch.int-spec.ts`
- `phase4_3-channel-gating.sec-spec.ts`
- `phase4_3-sms-rcs-isolation.sec-spec.ts`
- `phase4_3-sms-rcs-worker.int-spec.ts`
- `phase4_3-sms-rcs-dispatch-resilience.int-spec.ts`
- `phase4_3-g2-dispatch-recheck.int-spec.ts`
- `dispatch-worker*.int-spec.ts`
- `org-admin-onboarding.sec-spec.ts`
- `openapi-responses.sec-spec.ts`
- the full API, DB, security and unit suites

No test file in this list may be edited, except for allowlist bookkeeping in `scope-creep.architecture.spec.ts` (§10.1 item 4).

### 11.3 New structural and unit tests
1. **Single creation path.** Across `apps/api/src`, only `messages/submission/message-submission.core.ts` may contain `insert(schema.messages)`, `insert(schema.messageDispatchQueue)` or a `message.queued` event insert. The dispatcher's updates and inserts are a separately pinned set, unchanged.
2. **Core isolation.** The core file does not reference:
   - `RequestContext`, `withTenant`, `withRequestTenant`, `whenReleased` or `IdempotencyService`;
   - any billing, pricing, ledger, provider-adapter, dispatcher or campaign module;
   - `app_rate_message`, `app_price_lookup` or `app_ledger_post`.
3. **Order pinning.** The checks run in the §6.1 order. This is proved behaviourally by §11.1 item 3, and structurally by a test that pins the order of the step markers in the core.
4. **Proof guard.** `submit` refuses, before any query, when given:
   - a forged proof;
   - a proof minted on another `tx`;
   - a proof for another organisation.

   Verified with a spy transaction that records zero queries.
5. **Fail-closed RLS.** A core call inside a `withTenant` session with no user or API key fails, and nothing commits. This documents the D-5 constraint.

### 11.4 Gates
- `openapi:check` reports zero drift. `git diff develop -- apps/api/openapi packages/contracts packages/db/migrations` is empty.
- The history proof is unchanged at `53|8b3f4018a42c3c46607b956d3dc7fdae`. Migrating twice is idempotent.
- The route-authorization coverage counts and `APPLICATION_OPERATIONS` are unchanged.
- Lint, typecheck, format, build, the dependency audit and the secret scan pass. All five CI checks are green.
- Database runs happen only on `with-db-clone` copies of `acc_r015_base`. `db:roles:reconcile` is never run.

---

## 12. Acceptance criteria (PR 7-3)

1. `MessageSubmissionCore.submit(tx, ctx, request)` exists. `POST /messages` reaches message creation only through it, and the structural test proves no other creation path exists.
2. The characterisation suite, committed before the refactor, passes unchanged after it. All suites in §11.2 pass unedited.
3. Contracts, migrations and configuration are unchanged:
   - no migration (proof `53|8b3f4018…`);
   - no change to `packages/contracts`, OpenAPI, configuration or environment schema;
   - no change to any 7.1 or 7.2 object or behaviour;
   - no change to `apps/web`.
4. Billing and dispatch remain untouched:
   - no billing, pricing or ledger code path is called or granted;
   - `app_rate_message`, `app_price_lookup` and `app_ledger_post` remain executable by no application role;
   - the dispatcher is byte-identical.
5. The core never opens or ends a transaction and never reads request context. The authorization-proof guard is tested.
6. `IdempotencyService` behaviour on `POST /messages` is identical, including replay of keys stored before the deploy.
7. Documentation: `DECISIONS.md` §1zi.6 records the owner decisions, the as-built facts and any deviation.
8. PR state: a draft PR with CI green, not merged, awaiting owner review.

---

## 13. Dependencies

| ID | Dependency | Needed by | State |
|---|---|---|---|
| DEP-1 | OD-7-10 (7-3 owns the refactor) | 7-3 | **Met**: `DECISIONS.md` §1zi.3 |
| DEP-2 | PR #91 merged, so the core is designed against the final `messages` shape (`campaign_id`) | 7-3 | **Met**: `f71395b` |
| DEP-3 | Owner resolution of the 8B handover conflicts C-1/C-2 | 7-3 sign-off, 8B-3 | **Open**: D-1 |
| DEP-4 | Composite `(campaign_id, org_id)` foreign key, or an equivalent same-organisation guarantee, before anything writes `messages.campaign_id` | 8B-3 | Open (§2.3) |
| DEP-5 | Campaign-recipient duplicate backstop (a database constraint tying one message to one recipient) | 8B-3 | Open (§2.3, §7.2) |
| DEP-6 | `RELEASE.md` record of the `0052` proof `53|8b3f4018…` | Any deploy containing `0052`; the 7-3 gate | Open. Housekeeping from #91 |
| DEP-7 | OD-7-7 (fail-closed rules, account provisioning), OD-7-8 (error contract), D-4 (mandatory key) | 7-4 | Open, **not** needed for 7-3 |
| DEP-8 | Executor principal and tenant session (D-5; OD-8B-5 in the 8B plan) | 8B-3 | Open, **not** needed for 7-3 |
| DEP-9 | 7-4 and 7-5 merged and Gate 7-A accepted | 8B-3 dispatch | Per baseline §8 and OD-8B-3 |

---

## 14. Decisions requiring owner approval

**Needed before 7-3 starts:**
- **D-1: reconcile the merged Phase 8B handover with the approved Phase 7 baseline.**
  - **Recommendation:**
    1. PR numbering follows baseline §8.1: 7-3 is the behaviour-preserving extraction; reservation is 7-4; settlement is 7-5.
    2. The 8B-3 gate reads "after 7-4, 7-5 and Gate 7-A".
    3. Per-message reservation inside the shared core is the only authoritative reservation. Campaign-level chunked reservation through `app_ledger_post` is withdrawn, and any campaign pre-flight estimate is advisory.
  - **Delivery:** the 7-3 PR would add a short correction note to `PHASE-8B-CAMPAIGNS-BACKEND-HANDOVER.md`, or the owner may prefer Gemini or a separate docs PR to amend it.
  - **Why it is the owner's call:** two merged documents disagree on the financial architecture, and the choice determines where money is reserved.
- **D-2: no campaign attribution in 7-3.**
  - **Recommendation:** the 7-3 core input has no `campaignId` or recipient fields. They arrive with 8B-3, together with DEP-4 and DEP-5. The core is designed so that adding them is additive.
  - **Alternative:** add an unused optional `campaignId` now. Not recommended: there is no caller, and `0052`'s single-column foreign key would admit cross-organisation attribution.
- **D-3: authorise PR 7-3 implementation** as one draft PR on this handover, with the §10 scope and §12 acceptance.

**Recorded now, needed later (not blocking 7-3):**
- **D-4 (before 7-4): should `Idempotency-Key` become mandatory on `POST /messages` before billing enforcement is enabled?** Today an unkeyed retry creates a second message, and would create a second reservation. This is a public API contract change and a financial-exposure question. No recommendation is made here; it belongs in the 7-4 handover.
- **D-5 (before 8B-3): the campaign executor's tenant session and authorization principal.** RLS (`app_content_context_valid`) requires an org-level user or an API key. The options (launcher's identity, a dedicated principal, a constrained definer) carry security trade-offs and belong in the 8B-3 design.
- **OD-7-7, OD-7-8 and OD-7-11 to OD-7-13, RQ-1** remain as recorded in `DECISIONS.md` §1zi.2. 7-3 touches none of them.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Silent behaviour drift during the move: error precedence, payload bytes, the fingerprint | Characterisation suite committed before the refactor and unchanged after it; byte-equal payload and fingerprint replay tests |
| A later caller bypasses authorization | Branded, transaction-bound proof (§5.2) plus the coverage check |
| A second send path appears in 8B-3 (as the merged 8B handover sketches) | The single-creation-path structural test fails the build; D-1 |
| Cross-organisation `campaign_id` attribution | 7-3 never writes it; DEP-4 before 8B-3 |
| The scope-creep allowlist is widened carelessly | Only moved vocabulary, each entry annotated "moved by 7-3", and removals keep the census exact |
| Concurrent edits to `messages/` by another agent | Single owner for `apps/api/src/messages/` during 7-3, coordinated through the owner |
