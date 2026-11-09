# ACC Phase 7.6d: Billing-Account Provisioning and Recharge, Implementation Handover

**Status:** **Rev 2, final review copy.** It incorporates the owner decisions D-76d-1 to D-76d-5 (09-Nov-2026). Documentation only: no code, migration, commit or PR. **Implementation is not authorised** until the owner says so explicitly.

**Date:** 09-Nov-2026

**Baseline:** `develop` at `f98fb24` (PR #98, 7-6c, merged).
- Migration history: `58|6fa278509fb2ffbad8e328f804dfec9a` (`0000`–`0057`).
- The migration number for 7-6d is not yet determinable (§12).

**Evidence markers:** **[V]** verified at `f98fb24`; **[I]** inferred, to confirm during implementation; **[P]** proposed design.

**Constraints, carried into both 7-6d PRs:**
- Billing enforcement stays disabled; the startup guard is unchanged.
- No QA or production changes.
- No payment-provider integration, gateway, webhook or credential. A recharge records money received outside the system; nothing collects money.
- Settled 7.6a–7.6c behaviour is unchanged. The single approved exception is the additive tenant visibility of recharge entries (D-76d-3).
- No implementation before explicit owner authorisation.

**Authority (binding):**
- `DECISIONS.md` §1zi.1: RQ-3.
- §1zi.3: OD-7-9, OD-7-5/DP-1, the writer allowlist, DP-4.
- §1zi.7: D-74-2 (fail closed, no automatic provisioning), D-74-4.
- §1zi.9: D-76-2, D-76-3, D-76-4, D-76-5, D-76-6.
- §1zi.12: the 7-6c pattern, the environment threshold O-2, the 10-argument writer C-1.
- §1zi.13 (draft in this review copy): D-76d-1 to D-76d-5.

---

## 1. Owner decisions (09-Nov-2026)

| ID | Decision |
|---|---|
| **D-76d-1** Dual control | Recharge and credit-limit **increases** need a second approver when the threshold is unset or the applicable amount exceeds it. For a limit increase the applicable amount is the **increase** (new − current). Credit-limit decreases and freezes are single-operator. **Unfreeze always needs a second approver.** |
| **D-76d-2** Recharge amount | The recorded amount is the **net spendable amount credited to the wallet**, in INR paise. Tax and accounting treatment stays with Phase 7.7 and professional review. |
| **D-76d-3** Tenant visibility | Recharge entries appear in the tenant ledger with **amount and timestamp only**. Payment references, approver identities and internal audit details are never exposed to tenants. |
| **D-76d-4** Freeze / unfreeze | In **7-6d-1**. A freeze blocks new spending and new reservations, and changes no existing balance or reservation. Unfreeze is dual-controlled. A recharge is refused while the wallet is frozen. |
| **D-76d-5** No reversal | There is no reversal path in 7-6d. Completed recharges can be neither edited nor deleted. Corrections and reversals are Phase 7.7 scope. |

These sit alongside the settled points:
- no automatic provisioning (D-74-2);
- no auto-recharge or payment integration (OD-7-12; constraints);
- platform-only access (DP-1, D-76-5);
- INR integer paise (OD-7-9);
- mandatory keys (RQ-3);
- accounts created empty;
- recharge for wallets only (postpaid repayment belongs to 7.7).

---

## 2. Scope

| PR 7-6d-1 (no ledger writer change) | PR 7-6d-2 (ledger integration) | Not in 7-6d |
|---|---|---|
| `billing_account_operations` (provisioning, credit-limit, freeze, unfreeze) | Recharge kind and its columns | Automatic provisioning |
| Create a wallet / credit account (empty) | Writer `recharge` branch (wallet only) | Payment collection, auto-recharge, low-balance events |
| Set a credit limit (increase dual-controlled, decrease single) | Recharge API with payment reference, dual-controlled | Postpaid repayment, invoices, GST, refunds, adjustments, reversals (7.7) |
| Freeze (single) / unfreeze (dual) either account | Tenant `SELECT` policy and the 7-6a entry-type list gain `recharge` (D-76d-3) | Reseller-initiated operations (Phase 9) |
| Platform reads of accounts and operations | Ledger-truth invariant tests | Enforcement enablement |

---

## 3. Current state relevant to the design (verified at `f98fb24`)

- **Accounts:**
  - `wallets` and `credit_accounts`: one each per organisation; `status` `active | frozen`; RLS on; tenant `SELECT` only (`0055`); no application-role write; undeletable [V].
  - Nothing creates them except tests [V].
- **Ledger:**
  - `recharge` is a defined entry type; CHECK C4 requires one account; C5 imposes no message linkage [V].
  - The fact key makes a fact idempotent per anchor [V].
  - The writer refuses `recharge` (allowlist) and requires a message on every call [V].
- **Frozen accounts are already refused by the writer** (`BL002`) on every new reservation, on a per-attempt top-up and on an operator charge (7-6c) [V].
  - A reservation at submission maps to `403 BILLING_ACCOUNT_FROZEN` [V].
  - A dispatcher top-up refusal fails the message before any provider call and releases its reservation [V].
  - Settlement charges against an existing reservation and releases **do not check status** [V].

  So D-76d-4's freeze semantics need **no writer change**: a freeze is a status update only.
- **Tenant ledger view (7-6a):**
  - returns `id`, `entryType`, `amountPaise`, `currency`, `messageId`, `attemptId`, `correlationId` and `occurredAt` [V];
  - the `0055` policy admits `reservation`, `reservation_release` and `customer_charge` only [V].
- **Organisations:** `billing_mode` `prepaid | postpaid`; `status` `active | suspended | closed` [V].
- **Patterns reused from 7-6c:** keyed `executePlatform`; request → approve/reject definers; four-eyes CHECKs; transition guard; binding to an expected amount; refusals recorded in a second transaction; `BILLING_DUAL_CONTROL_THRESHOLD_PAISE` with its startup log; the bounded metric label `action` [V].

---

## 4. Data model [P]

### 4.1 `billing_account_operations`
Created in 7-6d-1 and extended in 7-6d-2. Expand-only in both.

| Column | 7-6d-1 | 7-6d-2 | Notes |
|---|---|---|---|
| `id` uuid v7 PK | ✓ | | For a recharge, also the ledger anchor |
| `org_id` FK organisations | ✓ | | |
| `account` | ✓ | | `wallet` \| `credit_account` |
| `kind` | ✓ | CHECK widened | 7-6d-1: `provision`, `credit_limit_change`, `freeze`, `unfreeze`. 7-6d-2 adds `recharge` |
| `status` | ✓ | | `pending` \| `executed` \| `rejected` |
| `amount_paise` | ✓ | | Limit change: the **new** limit (≥ 0). Recharge: the net spendable amount (> 0, D-76d-2). NULL otherwise |
| `previous_limit_paise` | ✓ | | Limit change: the limit the requester saw (binding) |
| `dual_control`, `threshold_paise` | ✓ | | As in 7-6c |
| `reason` | ✓ | | 1–500 characters |
| `request_key` | ✓ | | `UNIQUE (org_id, request_key)` — RQ-3's per-organisation uniqueness |
| `requested_by/at`, `approved_by/at`, `rejected_by/at`, `rejection_reason`, `executed_at`, `last_refusal`, `last_refused_at` | ✓ | | As in 7-6c |
| `payment_reference` | | ✓ | Recharge only, required, 1–120 characters; **platform-only** |
| `received_on` | | ✓ | Recharge only, required; not in the future |
| `result_ledger_id` | | ✓ | The recharge's ledger row |

**Constraints:**
- **Four eyes:** `approved_by` and `rejected_by` are each distinct from `requested_by`.
- **Per-kind presence:** `account = 'wallet'` for a recharge; `account = 'credit_account'` for a limit change; amounts and previous limit only where meaningful.
- **Dual control (D-76d-1, enforced in the database given the recorded threshold):**
  - `unfreeze`: always.
  - `recharge`: unless the threshold is set and `amount ≤ threshold`.
  - `credit_limit_change` with `amount > previous`: unless the threshold is set and `amount − previous ≤ threshold`.
  - Decreases, unchanged limits, `freeze` and `provision`: not required (`dual_control = false`).
- **Indexes:** one `pending` operation per (org, account, kind). In 7-6d-2, a payment reference is unique per organisation among `pending` and `executed` recharges, so the same receipt cannot be credited twice.
- **Guard trigger:**
  - only pending → executed / rejected;
  - while pending, only the approval (once) and the last refusal may be recorded;
  - request columns are immutable;
  - an executed or rejected row is final;
  - no delete or truncate.

  Together with the ledger's own immutability, this is D-76d-5: a completed recharge can be neither edited nor deleted.
- **Access:** RLS on, no policy, no grant.

**History:** the executed rows are the history of limits, statuses and recharges. A limit or status change writes no ledger fact (neither is money).

---

## 5. Freeze semantics (D-76d-4)

| Effect while frozen | Mechanism | Changed in 7-6d? |
|---|---|---|
| New reservations at submission refused (`403 BILLING_ACCOUNT_FROZEN`) | Writer `BL002` | No |
| Per-attempt top-ups refused; the message fails before the provider call and its reservation is released | Writer `BL002`; 7.5 dispatcher | No |
| Operator charges (7-6c) refused | Writer `BL002` | No |
| Recharge refused (`403 BILLING_ACCOUNT_FROZEN`) | Writer `recharge` branch, `BL002` (7-6d-2) | New branch, same rule |
| Existing balance, used, limit and reservations unchanged | A freeze updates `status` (and `version`) only | — |
| In-flight messages settle against their existing reservations: charge and release | Settlement does not check status | No — existing reservations are honoured, not new spending |
| Credit-limit changes | Permitted while frozen (configuration, not spending) [P] | — |
| Freeze twice, unfreeze an active account | `409 BILLING_ACCOUNT_OPERATION_CONFLICT` | — |

---

## 6. Ledger integration (PR 7-6d-2) [P]

**The writer gains a `recharge` branch** through `CREATE OR REPLACE`. The 10-argument signature, owner and privileges are unchanged: no application-role `EXECUTE`.

**What the branch accepts:**
- `entry_type = 'recharge'`, `account = 'wallet'`, `amount > 0`;
- `message_id` and `attempt_id` NULL;
- `mode = 'automatic'`;
- `anchor` = the operation id, which must be a `recharge` operation of the same organisation that is pending and, where required, approved — checked in the writer, as for 7-6c's operator mode.

**Never written to the fact** (so nothing internal reaches the tenant view, D-76d-3): the correlation id and reference note are NULL. The payment reference lives only on the operation row.

**What it does:**
- message shape checks are skipped for this branch only;
- locks the wallet as the last row lock;
- refuses a frozen wallet (`BL002`);
- the fact key makes a repeat a no-op;
- effect: `balance_paise += amount`, `version + 1`; `reserved_paise` is unchanged.

**Unchanged:** every existing branch (reservation, release, automatic and operator charges, provider cost) is unchanged and remains pinned by the 7.1–7-6c suites.

**Only one caller:** the 7-6d executor is the only function that posts `recharge` (structural test over `pg_proc`).

**Tenant visibility (D-76d-3):**
- the tenant `SELECT` policy on `usage_ledger` is replaced (DROP and CREATE in the same migration) with `recharge` added to its entry-type list;
- `TENANT_LEDGER_ENTRY_TYPES` and the OpenAPI enumeration gain `recharge` (additive).

A tenant sees, for a recharge row: its id, `entryType: 'recharge'`, amount, currency and `occurredAt`; `messageId`, `attemptId` and `correlationId` are null. The operation id, payment reference, reason, requester and approver are never visible. The usage endpoint is unaffected (it sums customer charges only).

---

## 7. Database entry points [P]

**Common properties:**
- `SECURITY DEFINER`, pinned `search_path`, invariant D;
- `EXECUTE` for `acc_app` only, except the executor;
- each checks the caller first (a signed-in user with platform `billing.manage`, the `0049` pattern).

| Function | PR | Effect |
|---|---|---|
| `app_billing_account_request(org, account, kind, amount, previous_limit, reason, threshold, request_key)` | d-1 (d-2 adds `payment_reference`, `received_on` via a new overload or by dropping and recreating it [I]) | Validates, inserts, computes dual control; executes at once when not required |
| `app_billing_account_approve(id, expected_amount)` | d-1 | Locks; pending; four eyes (`BL011`); binding; executes |
| `app_billing_account_reject(id, reason)` | d-1 | Closes the request (four eyes) |
| `app_billing_account_note_refusal(id)` | d-1 | Re-derives a refusal after a rolled-back approval: frozen or missing account |
| `app_billing_accounts_get(org)`, `app_billing_account_operations_list(…)` | d-1 | Platform reads, with no platform RLS on the financial tables (7-6b principle) |
| `app_billing_account_execute(id)` (owner-only) | d-1, extended in d-2 | Provision: insert the account. Limit: `UPDATE credit_limit_paise`. Freeze/unfreeze: `UPDATE status`. Recharge (d-2): writer `recharge` branch |

**Eligibility:**
- the organisation exists and is not `closed` (a `suspended` organisation may be administered and funded) [P];
- provision only once per account (`BL013`);
- a limit change needs a credit account;
- freeze needs `active`, unfreeze needs `frozen`;
- a recharge needs an active wallet and an unused payment reference.

**Binding (`BL014`, stale):**
- approval `expected_amount` ≠ the request amount;
- a limit change whose live limit ≠ `previous_limit_paise`;
- the account's status no longer allowing the kind.

**Lock order:** operation row (`FOR UPDATE`) → organisation (`FOR KEY SHARE`) → account (last). No existing path takes an operation row after an account lock, so there is no cycle with submission or settlement (message → account) or with resolution (resolution → message → account).

---

## 8. API contracts [P]

**Common to every route:**
- `billing.manage` at platform scope; signed-in user sessions only, checked in the service.
- Platform support, tenant users and API keys are refused (`403`); no credential is `401`.
- `Idempotency-Key` is **required** on every POST, through `executePlatform`: the same key and request replays; a changed request is `422`; no key is `400`.

| Route | PR | Result |
|---|---|---|
| `GET /platform/billing/organizations/{orgId}/accounts` | d-1 | Wallet and credit account (balance, limit, used, reserved, available, status, version), or `null` each |
| `POST …/{orgId}/wallet` `{ reason }` | d-1 | `201`: executed operation and empty wallet |
| `POST …/{orgId}/credit-account` `{ reason }` | d-1 | `201`: executed operation and credit account with zero limit |
| `POST …/{orgId}/credit-limit` `{ newLimitPaise, previousLimitPaise, reason }` | d-1 | `201`: executed (decrease, or increase within the threshold) or pending |
| `POST …/{orgId}/wallet/freeze`, `…/credit-account/freeze` `{ reason }` | d-1 | `201`: executed |
| `POST …/{orgId}/wallet/unfreeze`, `…/credit-account/unfreeze` `{ reason }` | d-1 | `201`: pending (always dual) |
| `POST …/{orgId}/recharges` `{ amountPaise, paymentReference, receivedOn, reason }` | d-2 | `201`: executed or pending |
| `POST /platform/billing/account-operations/{id}/approve` `{ expectedAmountPaise }` | d-1 | `200`: executed. For freeze/unfreeze/provision, `expectedAmountPaise` is omitted and must be absent |
| `POST /platform/billing/account-operations/{id}/reject` `{ reason }` | d-1 | `200`: rejected |
| `GET /platform/billing/account-operations` (`orgId`, `account`, `kind`, `status`, cursor), `GET …/{id}` | d-1 | Reads |

**Errors** (no amount, balance, limit or payment reference is ever disclosed in an error body):

| Condition | Response |
|---|---|
| Not eligible, duplicate pending, reference reused | `409 BILLING_ACCOUNT_OPERATION_CONFLICT` (new) |
| Stale binding | `409 BILLING_ACCOUNT_OPERATION_STALE` (new) |
| Requester approves or rejects | `403 BILLING_RESOLUTION_SELF_APPROVAL` (reused) |
| Frozen wallet on recharge | `403 BILLING_ACCOUNT_FROZEN` |
| Unknown organisation or operation | `404` |
| Validation (amount range `0…Number.MAX_SAFE_INTEGER`, future `receivedOn`, reference format) | `400` |
| Contention | `503 BILLING_BUSY` (retryable with the same key) |

**Tenant API (D-76d-3):** `GET /billing/ledger` may return and filter `recharge` (7-6d-2). Nothing else in the tenant API changes.

---

## 9. Audit, metrics and logging

**Audit:** security-sensitive, platform scope, in the operation's transaction, with before/after, reason and amounts:
- `billing.account_operation.requested`, `.approved`, `.rejected`;
- `billing.wallet.provisioned`, `billing.credit_account.provisioned`;
- `billing.credit_limit.changed` (old and new);
- `billing.account.frozen`, `billing.account.unfrozen`;
- `billing.wallet.recharged` (7-6d-2; the payment reference is in the audit record only).

**Metric:** `acc_billing_account_operations_total{action,outcome}`. `action` is the kind (bounded); `outcome` is `executed | pending | rejected | refused`. Counted after commit.

**Logs:** no amount or payment reference at `info` and above.

---

## 10. Acceptance tests

Fixtures are created through the new APIs (not by direct inserts), so ledger-truth holds from creation.

### 10.1 Concurrency
- Two concurrent provisionings of the same account: one `201`, one `409`; one row.
- Two approvers approving the same pending operation: one executes, one gets `409`. For a recharge: one ledger fact and one balance increase.
- **Recharge versus reservation:** concurrent recharges and submissions on the same wallet. There is no deadlock, the final balance and reserved amounts are exact, and every reservation that succeeded was covered by the available funds at its own lock.
- **Freeze versus reservations:** freeze while reservations are in flight. Reservations committed before the freeze persist; after it commits, every new reservation gets `403`.
- **Duplicate payment reference:** two concurrent recharges with the same reference and different keys give one `201` and one `409`.
- A limit increase racing with a limit decrease: the second sees a stale `previous_limit` and gets `409`.

### 10.2 Idempotency
- On each POST: replay with the same key and body returns the original status and body and creates nothing; the same key with a changed body is `422`; no key is `400`.
- A refused approval (frozen) does not consume its key; a retry with the same key after unfreeze executes.
- At the database level, the recharge fact is a no-op on a repeated execution of the same operation id.

### 10.3 Dual control
- **Threshold unset:** recharge pending; limit increase pending; limit decrease executed; freeze executed; unfreeze pending.
- **Threshold set:**
  - recharge at the threshold executes; above it, pending;
  - a limit increase of exactly the threshold executes, and one above it is pending, measured on (new − previous), not on the new limit;
  - unfreeze is still pending.
- Self-approval and self-rejection: `403`.
- Approval with a wrong `expectedAmountPaise`: `409`, and nothing changes.
- The CHECKs refuse a direct insert that violates any D-76d-1 rule.

### 10.4 Frozen accounts
- A frozen wallet refuses a submission reservation (`403`), a per-attempt top-up (message failed, reservation released), an operator charge (`403`) and a recharge (`403`, with `last_refusal` recorded on a pending approval).
- A frozen account leaves balance, used, limit and reserved byte-identical.
- An in-flight message settles normally (charge and release) after the freeze.
- Unfreeze (dual) restores reservations.

### 10.5 Tenant isolation and visibility
- Tenant A sees its own recharge rows (amount, time, `entryType`, null message, attempt and correlation) and never B's.
- The tenant sees no operation rows, payment references, reasons, approver identities, limit or status history, or provider costs; checked against the response schema and raw row fields.
- Tenant users and API keys are refused on every platform route.
- The `billing.read` boundary (system roles only, D-76-4) is unchanged.

### 10.6 Ledger and balance consistency (invariants after mixed sequences)
- **Wallet balance:** `wallet.balance = Σ recharge − Σ customer_charge(wallet)`.
- **Wallet reserved:** `wallet.reserved = Σ reservation − Σ reservation_release − Σ automatic customer_charge(wallet)`. Operator charges carry the reference note `outcome_unknown_resolved` and do not draw from the reservation.
- **Credit account:** `used = Σ customer_charge(credit)` and `reserved` likewise; the limit equals the last executed limit change.
- **Coverage:** every recharge fact has exactly one executed operation, and vice versa.

### 10.7 Existing settlement behaviour unchanged
- The 7.1, 7.2, 7.4, 7.5, 7-6a, 7-6b and 7-6c suites pass unmodified, apart from deliberate count pins.
- Explicitly re-run against accounts provisioned and funded through 7-6d:
  - submission reservation;
  - accepted-chain charge;
  - failed and unknown-outcome release;
  - per-attempt top-up;
  - operator charge and write-off.
- The writer's automatic `BL004`/`BL006` and operator mode stay pinned.

### 10.8 Mutation checks
- recharge also changing `reserved`;
- payment-reference uniqueness removed;
- freeze not refusing a recharge;
- dual control not measuring the increase.

Each must be caught.

---

## 11. Implementation sequence (after explicit authorisation)

1. **PR 7-6d-1** (one migration; **no ledger writer change**):
   - the operations table and definers;
   - provisioning, credit-limit, freeze/unfreeze;
   - platform reads, API, audit and metric;
   - tests 10.1–10.5 and 10.7 for these kinds;
   - `DECISIONS.md` §1zi.13 and the `RELEASE.md` proof.

   Draft PR, full regression and CI; stop for owner review.
2. **PR 7-6d-2** (one migration):
   - the recharge kind and columns;
   - the writer `recharge` branch;
   - the tenant policy and entry-type list;
   - the recharge API;
   - tests 10.1–10.8 for recharge, including the ledger-truth invariants.

   Draft PR, full regression and CI; stop for owner review.

---

## 12. Unresolved technical issues

1. **Migration number: not determinable today.**
   - `develop` ends at `0057`.
   - Open draft PR #99 (Phase 8A.1) claims `0058_phase8a_segments.sql`; no other open PR adds a migration.
   - If #99 merges first, 7-6d-1 takes `0059`; otherwise `0058` and #99 must renumber.
   - The number is confirmed from the latest `develop` at authorisation, and the journal and count pins follow it.
2. **The request function's signature in 7-6d-2:** adding recharge parameters means an overload or a drop-and-recreate of the `acc_app` grant. This is a design choice for implementation, recorded in §1zi.13; it does not affect behaviour [I].

Verify with a qualified professional before acting on the financial, tax or accounting aspects of this design.
