# ACC Phase 7.6: Billing APIs and Operational Controls, Implementation Handover

**Status:** APPROVED by the owner, 09-Nov-2026, with decisions D-76-1 to D-76-6 (§11). Documentation only: no code, migration, commit or PR. Implementation of each PR needs its own authorisation. Billing enforcement stays disabled.
**Date:** 09-Nov-2026 (Rev 2: owner decisions applied).
**Baseline inspected:** `develop` at `ca3d20a` (PR #95 merged).
**Migration history on that commit:** `55|b34a6d943bbb01bbfa705d9267771665` (`0000`–`0054`).

**Evidence markers:** **[V]** verified in code or migrations at `ca3d20a`; **[I]** inferred, to be confirmed during implementation; **[P]** proposed here.

**Authority, in order of precedence:**
1. The owner decisions of 09-Nov-2026 (§11). They are recorded in `DECISIONS.md` §1zi.9 and override earlier text where they differ (§12).
2. `DECISIONS.md` §1zi:
   - OD-7-4 and OD-7-4U (Policy U);
   - OD-7-5 and DP-1/DP-2/DP-3;
   - OD-7-9;
   - RQ-3;
   - §1zi.3–§1zi.8 as built.
3. The Phase 7 consolidated baseline, Rev 3: §6.5, §7.1–§7.3, §8.1.

---

## 1. Purpose and boundaries

7.6 makes billing visible to tenants, and gives platform operators the explicit, audited, dual-controlled resolution of unknown outcomes that Policy U requires.

| In 7.6 (7-6a to 7-6c) | Not in 7.6 |
|---|---|
| Tenant read APIs: account, ledger entries, usage | Enabling billing enforcement (the startup guard stays) |
| Unknown-outcome register and metric (platform, `billing.manage` only) | Account provisioning and recharge: **7-6d**, with its own handover (D-76-6) |
| Operator resolution: charge or write-off, dual control, single resolution | Payments, refunds, adjustments, invoices, tax, markup, auto-recharge (7-7 / RQ-1 / OD-7-12 / OD-7-13) |
| | Any automatic charge, release, re-reservation or re-rating of an unknown outcome |
| | Any change to 7.4/7.5 settlement semantics |

---

## 2. Current state (verified on `ca3d20a`)

- **Financial tables:**
  - `wallets`, `credit_accounts` and `usage_ledger` (partitioned) have RLS on, no policy, and no application privilege (DP-3) [V];
  - `pricing_evaluations` and `message_attempt_billing` are definer-only [V].
- **Ledger writer:** `app_ledger_post` refuses:
  - a `customer_charge` for a message with a `reservation_release` (`BL004`);
  - a charge above the outstanding reservation (`BL006`) [V].
- **Settlement:** an `outcome_unknown` message gets no charge and no provider cost, and its reservation is released when it finishes (7.5) [V].
- **Evaluations:** every attempt made under enforcement has an evaluation carrying its provider cost, and its customer price under `charge_per_attempt` [V].
- **Permissions:**
  - `billing.read` is held by `org_admin`, and `billing.manage` by `alendei_super_admin` [V];
  - both are in `INERT_PERMISSION_KEYS`, so no custom role or API key can carry them [V].
- **Delivery evidence:** `message_attempts.delivery_status` is updated only by provider receipts and never touches billing [V].
- **Existing usage API:** `GET /usage/messages` gives message counts, not money [V].

---

## 3. Operator charge through the writer (D-76-1)

**Why a writer change is needed.** The approved resolution charge (Policy U) cannot pass the 7.1 writer unchanged. The reservation is released when the unknown message finishes, so the writer refuses the charge (`BL004`), and in any case limits it to the outstanding reservation, which is 0 (`BL006`).

**Approved (D-76-1): a narrow operator-charge mode of the existing writer.**
- **Who can reach it.** Only through `app_billing_resolve_unknown(resolution_id)`, the dedicated resolution function. No other caller can select the mode; a structural test and the function's caller check enforce this.
- **When it applies.** Only for a message whose status is `outcome_unknown`; any other status is refused (`22023`).
- **Funds.**
  - Available funds are checked under the account lock: prepaid `balance − reserved`, postpaid `credit_limit − used − reserved`; insufficient gives `BL003`.
  - The charge changes `balance` (prepaid) or `used` (postpaid) only, and **never** `reserved`.
  - **No reservation is recreated.**
- **Fact identities.**
  - The charge uses the automatic path's identities: `customer_charge` anchored on the message under `charge_per_logical_message`, or on the unknown attempt under `charge_per_attempt`.
  - The fact key and idempotency mean a second charge is impossible, even if automation is added later.
  - Single resolution per message is enforced (§6).
- **Provider cost.**
  - Posted **only with independent supporting evidence** that the provider handled the attempt: a provider delivery receipt on that attempt (`delivery_status` set by a receipt). O-1 asks you to confirm this meaning.
  - Without it, the charge posts no `provider_cost`, and the register keeps the provider cost as report-only exposure.
- **Unchanged.** Every automatic writer branch is unchanged. `BL004` and `BL006` stay in force for every caller outside the mode, and a pinned-behaviour regression test proves it.

---

## 4. Tenant read APIs (7-6a)

- **Access (D-76-2, D-76-4):** `billing.read` at organisation scope, through a user session held via a **system role**. API keys and custom roles cannot carry `billing.read` in this increment; the key stays in `INERT_PERMISSION_KEYS`.
- **Read path (D-76-2):** `0055` grants `SELECT`, **and nothing else**, on `wallets`, `credit_accounts` and the `usage_ledger` parent to `acc_app`, with tenant-scoped RLS policies:
  - `org_id = app_current_org_id()` **and** `app_content_context_valid()`;
  - on `usage_ledger`, additionally `entry_type IN ('reservation', 'reservation_release', 'customer_charge')`, so provider cost and reseller markup are never visible to a tenant;
  - no `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` grant, and no write policy. All writes stay with the SECURITY DEFINER writer;
  - partitions get no grant: tenant reads go through the parent, whose policies apply.

| Route | Returns |
|---|---|
| `GET /billing/account` | mode, status, currency; prepaid: `balance`, `reserved`, `available`; postpaid: `creditLimit`, `used`, `reserved`, `available` (integer paise). `404 BILLING_ACCOUNT_NOT_CONFIGURED` when none exists |
| `GET /billing/ledger` | Cursor-paginated tenant-visible entries, newest first. Filters: `from`, `to`, `entryType`, `messageId` |
| `GET /billing/usage` | Charges per channel for a period (maximum 92 days): total charged, message count, unit count, derived from the ledger and evaluations |

---

## 5. Unknown-outcome register (7-6b)

- **Access (D-76-5):** `billing.manage` at platform scope, user session only. There is **no** `alendei_support` access in this increment.
- **Read path:** a SECURITY DEFINER read function, `app_billing_unknown_register(filters…)`, with a caller check (validated platform scope with `billing.manage`). It needs no new platform policy on the financial tables, so the tenant policies in §4 remain the only policies [P].
- **Route:** `GET /platform/billing/unknown-outcomes`. One row per enforced `outcome_unknown` message:
  - organisation, message, unknown attempt, channel, policy snapshot;
  - **age** (now − `completed_at`);
  - **estimated exposure**, report-only: customer price (E_m, or the attempt's E_a) and provider cost (the attempt's evaluation);
  - **evidence**: `evidenced` when the attempt has a provider receipt, otherwise `unevidenced`;
  - **resolution status**: `open`, `pending_approval`, `charged`, `charged_without_cost` (charged with no evidence, so no provider cost), `written_off` or `rejected`.
- **Filters and paging:** status, evidence, organisation, channel, minimum age; cursor-paginated.
- **Metrics [P]:** `acc_billing_outcome_unknown_open{channel}`, a gauge of open items set on each register read, and `acc_billing_outcome_unknown_resolutions_total{action,outcome}`. Labels are bounded.
- The `billing:reconcile` CLI section stays in 7-7.

---

## 6. Operator resolution (7-6c)

- **Access:** `billing.manage` at platform scope, user session only.
- **Idempotency:** `Idempotency-Key` is **required** on every mutation (RQ-3), through `IdempotencyService.executePlatform`: same key and request replays; a changed request is `422`; no key is `400`.

| Route | Effect |
|---|---|
| `POST /platform/billing/unknown-outcomes/{messageId}/resolutions` `{ action: 'charge'\|'write_off', reason }` | Creates a request bound to the message, the unknown attempt, the action, and amount snapshots (customer price; provider cost and whether it would be posted) taken at request time from the evaluations and the evidence state. Executes immediately only when dual control is not required (below) |
| `POST /platform/billing/resolutions/{id}/approve` `{ expectedAmountPaise }` | A **different** user approves. Executes in the same transaction only if `expectedAmountPaise` equals the request's snapshot, the snapshot still equals the amount recomputed now, and the evidence state still allows the action. Otherwise `409 BILLING_RESOLUTION_STALE` and nothing executes |
| `POST /platform/billing/resolutions/{id}/reject` `{ reason }` | Closes the request; nothing posted |
| `GET /platform/billing/resolutions` | Requests and their status |

**Dual control (D-76-3):**
- **The threshold is configurable**: `BILLING_DUAL_CONTROL_THRESHOLD_PAISE`, unset by default (configuration home: O-2).
- **While unset, every charge and every write-off requires a second approver.**
- **Once set:**
  - a charge or write-off whose customer-price snapshot is at or below the threshold executes on request;
  - above it, a second approver is required.
- **An unevidenced outcome may be charged only with dual control, whatever the amount.**
- **The requester and the approver must be different users.** This is enforced in the service and by a table CHECK.
- **Approval is bound to the exact request** (its id, action, message, attempt) **and amount** (the snapshot, re-checked at execution).

**Execution:**
- **Order:** resolution row (`FOR UPDATE`), then message, then attempt, then billing account (last, taken by the writer), consistent with §1zi.1's operator path.
- **Charge:** through `app_billing_resolve_unknown`:
  - `customer_charge` on the automatic anchor;
  - `provider_cost` only if the attempt is evidenced (§3).
- **Insufficient funds:**
  - on request, the item stays open and nothing is recorded as executed;
  - on approval, the request stays `pending` with the refusal recorded on it;
  - either way `402 BILLING_INSUFFICIENT_FUNDS`.
- **Frozen account:** `403 BILLING_ACCOUNT_FROZEN`.
- **Write-off:** no ledger fact (Policy U); the executed resolution row and the audit entry are the record.
- **Single resolution:** at most one *executed* resolution per message (partial unique index), and at most one *pending* request per message. Charge facts are additionally protected by the fact keys.
- **Audit** (security-sensitive, platform scope, before/after state, reason, amounts):
  - `billing.outcome_unknown.resolution_requested`;
  - `.resolution_approved`;
  - `.resolution_rejected`;
  - `.charged` (reason `outcome_unknown_resolved`);
  - `.written_off`.
- Nothing in 7-6c runs automatically, and no receipt or timer triggers a resolution.

---

## 7. Security and tenant isolation

- **Tenant routes:**
  - organisation from the principal only;
  - `billing.read` asserted at organisation scope;
  - RLS on every read;
  - `SELECT` only;
  - provider cost and rate-card internals never reach a tenant (response-schema and data tests).
- **Platform routes:**
  - validated platform-scope claim with `billing.manage`;
  - user session only;
  - every mutation audited as security-sensitive.
- **New SECURITY DEFINER functions** (`app_billing_unknown_register`, `app_billing_resolve_unknown`): caller check first, invariant D kept, `EXECUTE` for `acc_app` only.
- **`INERT_PERMISSION_KEYS`:** unchanged. `billing.read` and `billing.manage` remain unavailable to custom roles and API keys (D-76-4).
- **Disclosure:** no amount in error bodies or logs at `info` and above. Approval-mismatch responses do not echo the snapshot to a principal who lacks `billing.manage`.

---

## 8. Migrations

**`0055` (7-6a):** `SELECT` grants and the tenant RLS policies of §4. No new table.

**7-6b:** `app_billing_unknown_register` (migration `0056`) [P].

**7-6c (`0057`):**
- table `billing_unknown_resolutions`:
  - **columns:** id, org_id, message_id, attempt_id, action, status (`pending`, `executed`, `rejected`); snapshots of the customer price, the provider cost and whether cost is posted; evidence state; reason; requested_by, approved_by, rejected_by; refusal; timestamps; `request_key`;
  - **constraints:** `CHECK (approved_by IS DISTINCT FROM requested_by)`; partial unique indexes for one executed and one pending request per message;
  - **guard trigger:** only the pending → executed/rejected transition, otherwise append-only;
  - **access:** RLS, reached only through definers;
- the writer's operator-charge mode (`CREATE OR REPLACE app_ledger_post` with an added, defaulted mode argument, or a sibling signature) [I: exact form at implementation, with every automatic branch pinned];
- `app_billing_resolve_unknown`.

Each migration is expand-only, records its history proof in `RELEASE.md`, and is added to the table and permission censuses.

---

## 9. Tests and acceptance

**7-6a:**
- account, ledger and usage per mode in exact paise;
- pagination and filters;
- provider cost and markup never returned;
- cross-tenant reads empty or `404`;
- no tenant write possible: grants census plus attempted `INSERT`/`UPDATE`/`DELETE` refused;
- a custom role or API key cannot be given `billing.read` (`422`);
- a user without the permission gets `403` with an audited denial.

**7-6b:**
- each evidence and status combination derived correctly;
- exposure matches the evaluations under both policies;
- age and filters;
- `billing.manage` only: platform support refused, tenants refused;
- metrics set.

**7-6c:**
- **Dual control:**
  - threshold unset: every charge and write-off waits for a second approver;
  - threshold set: at or below it executes on request, above it waits;
  - unevidenced charge: always waits;
  - the same user approving is refused;
  - approval with a wrong amount, or after the amount or evidence changed: `409`, nothing posted.
- **Charge:**
  - evidenced: `customer_charge` on the automatic anchor plus `provider_cost`;
  - unevidenced (dual-approved): `customer_charge` only;
  - `balance`/`used` change and `reserved` does not;
  - no reservation fact appears.
- **Refusals:** insufficient funds (`402`, nothing posted); frozen account (`403`).
- **Write-off:** no fact, audited.
- **Single resolution:**
  - a second request is refused;
  - concurrent approve against reject, and two concurrent approvals, each produce one execution;
  - a repeated charge is a no-op on the fact keys.
- **Idempotency:** replay, mismatch, missing key.
- **Mode isolation:** called outside `app_billing_resolve_unknown`, or for a non-`outcome_unknown` message, the mode is refused.

**Regression (all PRs):**
- the 7.1, 7.2, 7.4 and 7.5 suites (including fault injection) green unchanged;
- pinned `BL004`/`BL006` behaviour for automatic calls;
- trust suite D;
- censuses;
- deliberate OpenAPI drift only.

**Acceptance:**
- the above;
- no automatic path can charge an unknown outcome (structural);
- enforcement still refused at startup outside tests;
- CI 5/5;
- draft PRs until owner review.

---

## 10. PR sequence (retained by the owner)

| PR | Scope | Migration | Depends on |
|---|---|---|---|
| **7-6a** | Tenant billing reads | `0055` | — (D-76-2, D-76-4 decided) |
| **7-6b** | Unknown-outcome register and metrics | `0056` | 7-6a; D-76-5 decided |
| **7-6c** | Operator resolution with dual control | `0057` | 7-6b; D-76-1, D-76-3 decided; O-1, O-2 |
| **7-6d** | Account provisioning and recharge: **separate implementation handover first** (D-76-6) | — | Owner request for that handover |

Enabling enforcement still requires 7-6d (provisioning and funding), a readiness report and owner approval (D-74-4).

---

## 11. Owner decisions (09-Nov-2026)

- **D-76-1:** narrow operator-charge mode in the existing writer.
  - callable only through the dedicated resolution function, and only for `outcome_unknown` messages;
  - preserves available-funds checks, automatic-path fact identities, idempotency and single resolution;
  - recreates no reservation;
  - posts no provider cost without independent supporting evidence.
- **D-76-2:** tenant-scoped RLS `SELECT` policies on the financial tables; no tenant write permissions.
- **D-76-3:**
  - the threshold is configurable;
  - until configured, every charge and write-off requires a second approver;
  - an unevidenced outcome is charged only with dual control, whatever the amount;
  - requester ≠ approver;
  - approval is bound to the exact request and amount.
- **D-76-4:** API keys and custom roles cannot receive `billing.read`; system roles only.
- **D-76-5:** register access is `billing.manage` only; no platform-support access.
- **D-76-6:** provisioning and recharge are a separate PR with a separate handover.

**Open points for confirmation before 7-6c** (they do not block 7-6a or 7-6b):
- **O-1: what counts as independent supporting evidence for provider cost.**
  - *Proposed:* a provider delivery receipt (`delivered`, `read` or `undelivered`) recorded on the unknown attempt by the delivery axis; an operator's assertion alone never counts.
  - A related question: should provider cost for an item charged *without* evidence be postable later, if evidence then arrives? *Proposed:* no, not in 7.6; it remains report-only, and a later explicit operator action would need its own decision.
- **O-2: where the threshold is configured.**
  - *Proposed:* an environment setting, changed by deploy and logged at startup.
  - The alternative is an audited platform setting in the database, which needs its own API and audit trail.

---

## 12. Conflicts with the approved Phase 7 baseline (resolved by the owner decisions, recorded here)

| # | Baseline text | Decision now in force | Effect |
|---|---|---|---|
| C-1 | Policy U (§6.5) and test D-11: an operator charge posts `customer_charge` **and** `provider_cost` | D-76-1: provider cost only with independent supporting evidence | D-11 (evidenced item) is unchanged. An *unevidenced* dual-approved charge posts no provider cost; its cost stays report-only |
| C-2 | DP-3 (§1zi.3): the financial tables have "no privilege for any application role… until a policy is approved" | D-76-2 approves tenant `SELECT` policies | `acc_app` gains `SELECT` only; the census and DP-3 text are updated in 7-6a |
| C-3 | Policy U: dual control "above the OD-7-11 threshold" for charges; write-off audited only | D-76-3: until configured, all charges **and write-offs** need dual control; unevidenced charges always do | Stricter than the baseline; no relaxation |
| C-4 | §1zi.1 / §1zi.4: the writer refuses charges after release (`BL004`) and above the reservation (`BL006`) | D-76-1: a narrow mode bypasses both for `outcome_unknown` via the resolution function only | Automatic behaviour unchanged; proved by pinned tests |
| C-5 | Baseline §8.1: 7-6 includes `/wallets` money movement and request keys on recharge | D-76-6: provisioning and recharge move to 7-6d with their own handover | RQ-3 still applies to resolution mutations in 7-6c |
| C-6 | §6.5: the reconciliation register is part of `billing:reconcile` in 7-7, with metric `acc_billing_outcome_unknown_total{channel}` | Register API and metrics in 7-6b | The CLI section stays in 7-7; the metric is renamed to a gauge of open items (§5) [P] |

---

## 13. Risks

- **R-1:** the writer change touches the financial core. Mitigated by a single narrow mode, a caller restriction and full regression with pinned refusals.
- **R-2:** tenant policies on the partitioned ledger apply through the parent; partitions stay ungranted. Tested.
- **R-3:** register and usage queries scan the ledger. Indexing at volume will be checked in the 7-8 load test [I].
- **R-4:** unevidenced charges create revenue without a matching cost entry. This is deliberate under D-76-1, and visible in the register as `charged_without_cost`.

Verify with a qualified professional before acting on the financial-control aspects of this design.
