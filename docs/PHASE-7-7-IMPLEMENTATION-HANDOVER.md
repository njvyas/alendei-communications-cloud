# ACC Phase 7.7: Invoicing and Reconciliation, Implementation Handover

**Status:** **Rev 2**, DRAFT for owner review (architectural-review corrections: invoice voiding removed, postpaid payment allocation, refund concurrency, the tax writer branch, read-only reconciliation). Documentation only: no code, migration, branch, commit or PR. **Implementation is not authorised.** The first slice has its own handover: `PHASE-7-7A-RECONCILE-HANDOVER.md`.
**Date:** 10-Nov-2026
**Baseline:** `origin/develop` at `36cd1e5` (PR #101 merged). Migration journal: 61 entries, last `0059_phase7_6d1_account_provisioning` and `0060_phase7_6d2_wallet_recharge`. History proof `61|da9371bb1f6a3e2cdc765f88823e8f02`.
**Companion files:**
- `PHASE-7-7-DECISION-REGISTER.md` (open owner decisions);
- `PHASE-7-7-TRACEABILITY.md` (requirement → source → existing → planned → evidence);
- `EVIDENCE-NOTE.md` (baseline and files inspected).

**Markers:** **[R]** required by the original roadmap or a normative document; **[S]** settled in the billing decision record; **[V]** verified at `36cd1e5`; **[P]** proposed here; **[I]** inferred, to confirm.

**Tax and invoicing note:** all GST, invoice-format, numbering and credit-note content is an architectural placeholder. Rates, HSN/SAC, place of supply, invoice particulars and numbering rules must be confirmed with a qualified professional before any implementation that issues a customer document.

---

## 1. Source of scope (not reinterpreted)

| Source | What it assigns to 7.7 |
|---|---|
| `ROADMAP.md` §10 (Phase 7) [R] | **Objective:** "invoicing, GST placeholder logic". **Scope:** "invoice generation job"; "wallet/auto-recharge threshold logic (no real payment processor connected)". **DB:** `invoices`, `payments`, `adjustments`. **Tests:** ledger-derivation consistency. **Security:** "adjustment/refund approval-flow review". **Observability:** "billing-specific dashboards (revenue, cost, margin)". **Rollback:** "corrective `adjustments`, never editing history" |
| Phase 7 baseline Rev 3 §8.1 (owner-approved PR plan) [S] | **PR 7-7:** "Invoices, payments, `billing:reconcile`, dashboards (bounded labels)", depending on 7-1 and 7-5. PR 7-8 holds Gate 7-A, the load test and the runbook |
| Baseline §6.5 (OD-7-4U, approved) [S] | "PR 7-7 adds the reconciliation section" (the unknown-outcome part of `billing:reconcile`) |
| Baseline §6.6 / §10.2 RQ-1 | Tax, discount and wallet principal: "Consequence: PR 7-7". **Still awaiting approval** |
| Baseline §7.3 [P], RQ-4 / RQ-6 (approved) [S] | `billing:reconcile`: read-only, report-only checks; partition checks at reconcile; warning below 6 months of headroom, critical below 2 |
| `DECISIONS.md` §1zi.9 deviation 6 [S] | "the `billing:reconcile` CLI stays in 7-7" |
| §1zi.13 D-76d-2, D-76d-5 [S] | Tax treatment of recharges "stays with Phase 7.7 and professional review"; "corrections and reversals are Phase 7.7 scope" |
| `BILLING.md` §§4, 7 [R] | Invoices aggregate the ledger, are immutable once issued, and are corrected by adjustment plus, where required, a credit note. Refunds and adjustments are new ledger rows with a justification record |

The roadmap's frontend items (wallet, invoice and ledger-detail console screens) are listed in §10 and §11 for completeness; the frontend belongs to Gemini.

---

## 2. Current state (verified at `36cd1e5`)

- **Ledger** (`usage_ledger`, `0050`) [V]:
  - append-only, partitioned by `anchor_month`; fact key `(anchor_month, anchor_id, fact_kind)`;
  - the entry-type enum already contains `refund`, `adjustment`, `tax`, `discount` and `reseller_markup`;
  - CHECK C4 requires one account for `refund` and `adjustment`; C2 requires `tax`/`discount` facts to carry a `tax:<line>` / `discount:<line>` kind.
- **Writer** `app_ledger_post` (10 arguments) [V]: allowlist `reservation`, `reservation_release`, `customer_charge`, `provider_cost`, `recharge`. `refund`, `adjustment`, `tax`, `discount` and `reseller_markup` are refused (`BL000`). Modes: `automatic`, `operator_resolution` (customer charge only); marked recharge block (`0060`).
- **Facts posted today:**

  | Fact | Posted by |
  |---|---|
  | Reservation and top-up | 7.4, 7.5 |
  | Release | 7.5 |
  | Customer charge | 7.5 settlement, 7-6c operator resolution |
  | Provider cost | 7.5, 7-6c |
  | Recharge | 7-6d-2 |

- **Accounts and operations:**
  - `wallets` and `credit_accounts` (`balance`/`used`, `reserved`, `status`, `version`);
  - `billing_account_operations` (provision, credit limit, freeze, unfreeze, recharge; four eyes; dual control by the server threshold);
  - `billing_unknown_resolutions` (7-6c).
- **Reads:**
  - tenant `/billing/account`, `/billing/ledger` (entry types `reservation`, `reservation_release`, `customer_charge`, `recharge`), `/billing/usage` (7-6a, 7-6d-2);
  - platform unknown-outcome register (7-6b), resolutions (7-6c), accounts and operations (7-6d).
- **Tooling:**
  - `db:ledger:partitions` (owner, `DATABASE_ADMIN_URL`; report and ensure) [V];
  - the startup partition check with its gauges [V];
  - test F-9 (random interleavings keep materialised balances equal to the ledger, `phase7_1-ledger.int-spec.ts:1654`) [V].
- **Absent** [V]:
  - `invoices`, `payments`, `adjustments` tables (deferred by DP-4);
  - any tax configuration;
  - `billing:reconcile`;
  - billing dashboards (only `providers.json`; Grafana has a Prometheus datasource only);
  - an event bus or outbox (`EVENTS.md`: "no event bus or outbox exists yet").
- **Organisation data** [V]: `organizations.legal_name` and `gstin` (format CHECK), `billing_mode`, `billing_policy`, `status`.

---

## 3. Deliverables

| ID | Deliverable | Source |
|---|---|---|
| **R-1** | **`billing:reconcile`**: a read-only, report-only operator command. Exit code `0` clean, `1` drift, `2` could not run. Checks listed in §6 | Baseline §7.3, §6.5, RQ-4/RQ-6; §1zi.9 |
| **R-2** | **Adjustments and refunds**: an `adjustments` record (reason, requester, approvers, request key) and ledger facts `refund` / `adjustment` through new marked writer branches; request → approve/reject with dual control; immutable | Roadmap DB and security checks; `BILLING.md` §7; D-76d-5 |
| **R-3** | **Invoices**: tax configuration (D-77-1, D-77-2), invoice generation from ledger facts for a period, draft → issued (a draft may be discarded; an issued invoice is never voided), immutability after issue, credit notes as the only correction of an issued invoice; tenant and platform reads | Roadmap "invoice generation job", "GST placeholder logic"; `BILLING.md` §4; RQ-1 |
| **R-4** | **Payments**: manual records only (no processor); unique external reference per organisation; allocation to issued invoices split into principal and tax (§5, D-77-8); the ledger effect on `credit_accounts.used` from the principal part only (D-77-4) | Roadmap DB; baseline §5.2, §9.3 [B] |
| **R-5** | **Dashboards**: revenue, cost and margin, with bounded labels | Roadmap observability; baseline §8.1 |
| **R-6** | **Low-balance threshold** (auto-recharge "threshold logic", no processor, no automatic credit) — **only if D-77-6 includes it** | Roadmap scope; OD-7-12 |

---

## 4. Financial invariants (each asserted by tests and by `billing:reconcile`)

| ID | Invariant |
|---|---|
| **I-1** | **Ledger truth:** wallet `balance = Σ recharge + Σ refund(wallet) ± Σ adjustment(wallet) − Σ customer_charge(wallet)`; wallet `reserved = Σ reservation − Σ release − Σ automatic customer_charge`; credit `used = Σ customer_charge(credit) − Σ refund(credit) ± Σ adjustment(credit) − Σ payment(credit)`, where each `payment` fact is the **principal** part of a payment's allocations (D-77-4). Tax never enters `used`, so a tax allocation never posts a fact. Operator charges carry `outcome_unknown_resolved` and do not draw on the reservation |
| **I-2** | **Single effect:** every money fact has one fact key; a retry posts nothing; every money-moving request carries a mandatory key (RQ-3) |
| **I-3** | **One-to-one:** each executed operation (recharge, refund, adjustment, payment) has exactly one ledger fact and vice versa; each executed outcome resolution has its policy-correct facts |
| **I-4** | **Refund ceiling:** Σ executed refunds against a customer charge ≤ that charge, **enforced atomically** inside the writer's refund branch under the account lock, which every posting to that account takes, so concurrent refunds serialise (§7) |
| **I-5** | **Invoice coverage:** every `customer_charge` fact is on exactly one invoice once invoiced (a per-fact mapping with a unique key). A fact posted late (its transaction committed after its period was invoiced) is never lost: it appears on the next invoice |
| **I-6** | **Invoice arithmetic and status:** `subtotal = Σ invoiced gross charges`; `total = subtotal − discounts + tax`, in integer paise, rounded per the approved rule (D-77-1). An issued invoice is immutable and is never voided; corrections are credit notes backed by adjustments. Invoice statuses are `draft`, `issued` and `discarded` (drafts only). `paid`, `partially paid` and `overdue` are derived at read from allocations and the due date |
| **I-7** | **Tax:** tax facts are written only at invoice issue, change no wallet principal, `used` or `reserved`, and never form part of a reservation (RQ-1 recommendation, pending D-77-1) |
| **I-8** | **Tenant confidentiality:** no provider cost, reseller markup, rate-card detail, payment reference of another tenant, approver identity or internal reason reaches a tenant |
| **I-10** | **Payment allocation:** per issued invoice, Σ principal allocations ≤ invoice principal (`subtotal − discount`), and Σ tax allocations ≤ invoice tax. The `payment` fact equals the payment's total principal allocation, so `used` can never fall by more than invoiced principal and never below 0. A payment is fully allocated in the transaction that records it: no unallocated balance and no overpayment in 7.7 [P] |
| **I-9** | **Nothing automatic:** no worker, timer or receipt moves money or issues a document. Generation and issue are operator actions; any external schedule only invokes the operator command (D-77-3) |

---

## 5. Data model [P] (expand-only; migration numbers per §9)

- **`adjustments`:**
  - `id` (v7, also the ledger anchor) and `org_id`;
  - `account` (`wallet` | `credit_account`) and `kind` (`refund` | `credit` | `debit`);
  - `amount_paise > 0`;
  - `refund_of_ledger_id` / `refund_of_anchor_month` (refunds; composite FK to the ledger);
  - `invoice_id` (optional link);
  - `reason`, `request_key` (`UNIQUE (org_id, request_key)`);
  - `dual_control`, `threshold_paise`;
  - requester, approver and rejector, with the four-eyes CHECK;
  - `status` (`pending` | `executed` | `rejected`), `result_ledger_id`, refusal columns.

  It follows the 7-6c and 7-6d pattern: guard trigger, append-only, RLS with no policy, definers only.
- **`tax_configurations`** (D-77-2; versioned, append-only; one active version):
  - supplier legal identity and GSTIN;
  - default SAC/HSN, rate table and place-of-supply rule — all configuration, no hard-coded rate;
  - `effective_from`, plus who set it and approved it.
- **`invoices`:**
  - `id`, `org_id`, `period_start`, `period_end` (`[start, end)`, timezone per D-77-3);
  - `status` (`draft` | `issued` | `discarded`). There is **no `void`**: an issued invoice is final, and only a credit note corrects it. A draft may be discarded, which releases its fact mappings back to the pool (the only deletion the mapping table admits, through the discard definer). `paid`, `partially paid` and `overdue` are derived at read;
  - `number` (assigned at issue, D-77-2) and `tax_configuration_id`;
  - `subtotal_paise`, `discount_paise`, `tax_paise`, `total_paise`;
  - snapshots of the customer's legal name, GSTIN and place of supply at issue;
  - `issued_at`, `issued_by`, `request_key`.
- **`invoice_lines`:** aggregated principal lines (per channel / unit).
- **`invoice_tax_lines`:** one row per tax component (for example a line code per tax head, D-77-1/D-77-2), each with its own UUIDv7 id, which is the anchor of its `tax:<code>` ledger fact (§5.1).
- **`invoice_ledger_items`:** `(invoice_id, ledger_anchor_month, ledger_id)`, `UNIQUE (ledger_anchor_month, ledger_id)` — the I-5 mapping. Partitioned or indexed by month [I: volume test in acceptance].
- **`credit_notes`:** against an issued invoice, referencing the adjustment(s) that justify it; numbered in their own series (D-77-2).
- **`payments`:**
  - `id` (v7, the anchor of its `payment` fact, D-77-4), `org_id`;
  - `amount_paise > 0`, `method` (manual, enumerated), `external_reference` (`UNIQUE (org_id, normalised reference)`, as 7-6d-2), `received_on` (calendar date);
  - `request_key`, recorded/approved by, `status`.
- **`payment_allocations`:** `(payment_id, invoice_id, principal_paise, tax_paise)`, created with the payment in one transaction and immutable afterwards.
  - Only issued invoices of the same organisation.
  - Σ allocations equals the payment amount.
  - The per-invoice ceilings of I-10 are checked under the invoice row locks.
  - **How a payment that does not cover the whole invoice is split between principal and tax is not decided** (D-77-8). 7-7d cannot be built until it is.
- **Ledger:**
  - **adjustments and refunds:** new marked writer branches for `refund` and `adjustment`, anchored on `adjustments.id`. The refund branch carries the ceiling check (§7);
  - **payments:** a marked `payment` branch (D-77-4), credit account only, amount = the payment's principal allocation;
  - **tax:** a marked `tax` branch (§5.1), only if D-77-1 approves tax facts.

  Every existing branch stays byte-identical, proved by the 7-6d-2 structural test technique.

### 5.1 The `tax` writer branch [P] (pending D-77-1)
- **What it admits:**
  - `p_entry_type = 'tax'`, `p_mode = 'automatic'`, `p_amount_paise > 0`;
  - **`p_account` NULL**;
  - `p_message_id`, `p_message_attempt_id` and `p_correlation_id` NULL;
  - `p_anchor_id` = an `invoice_tax_lines.id` whose invoice belongs to `p_org_id` and is being issued (status `draft`, row locked by the issue executor), and whose amount equals `p_amount_paise`.
- **What it writes:**
  - one row, `fact_kind = 'tax:' || line code` (CHECK C2) and `entry_type = 'tax'`, with `wallet_id` and `credit_account_id` NULL (CHECK C4 admits no account for tax);
  - nothing else. It reads no account row and takes no account lock.
- **Effects:** none on any account. The block contains no `UPDATE` and touches no `wallets` or `credit_accounts` row. The fact key makes a repeat a no-op.
- **Who calls it:** only the invoice-issue executor (structural test over `pg_proc`).
- **Tests:**
  - **structural:** the marked block contains no reference to `wallets` or `credit_accounts` and no `UPDATE`; every other branch is byte-identical to its previous definition;
  - **behavioural:** issuing invoices with tax lines (prepaid and postpaid, active and frozen accounts) leaves every account's `balance`, `used`, `reserved` and `version` byte-identical, and the issued invoice's tax facts equal its tax lines;
  - **refusals:** an account given; a message given; no or another organisation's line; a line not being issued; an amount mismatch; a non-automatic mode — each `22023`, posting nothing;
  - **mutations:** adding a wallet update to the branch, or accepting an account, must fail the tests.
- **Tenant RLS:** additive `SELECT` policies for the tenant's own issued invoices, lines, credit notes and payments (D-76-2 pattern). Whether `refund`/`adjustment` ledger facts become tenant-visible is part of D-77-5.

---

## 6. `billing:reconcile` (R-1)

**Read-only, report-only** (baseline §7.3); repairs only through audited adjustments.
- **Connection:** an operator command on the owner connection (`DATABASE_ADMIN_URL`, as `db:ledger:partitions`), needed to read across tenants.
- **Read-only transaction:** every check runs in **one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction** (one consistent snapshot), which PostgreSQL itself refuses to write in (`25006`). The run ends by asserting `txid_current_if_assigned() IS NULL` (no write was attempted that needed a transaction id) before `COMMIT`.
- **Partitions:** report-only. `billing:reconcile` reads `app_ledger_partition_report()` (STABLE, SECURITY INVOKER) and applies the shared pure verdict. It **never** calls `app_ledger_ensure_partitions`, `db:ledger:partitions --ensure` or any other write or DDL path (static test).
- **Output:** a human report and a JSON report. It writes nothing, and repairs nothing.

Its first implementation (C-1 … C-6) is specified in `PHASE-7-7A-RECONCILE-HANDOVER.md`.

| # | Check | Source |
|---|---|---|
| C-1 | Materialised balances = fresh ledger aggregation (I-1), per account | Roadmap test; baseline §7.3 |
| C-2 | Terminal billed messages: exactly one release, and the policy-correct charges | Baseline §7.3 |
| C-3 | One provider cost per attempt that reached a provider (`message_attempt_billing`) | Baseline §7.3 |
| C-4 | Open reservations older than a threshold on non-terminal messages | Baseline §7.3 |
| C-5 | Partition continuity, headroom (warn < 6, critical < 2 months), TRUNCATE guards, orphans — reusing the 7-1 report | RQ-4/RQ-6 |
| C-6 | Unknown-outcome section: every billed `outcome_unknown` message with state, estimated exposure and age — reusing the 7-6b derivation | OD-7-4U §6.5 |
| C-7 | One-to-one: executed operations, resolutions and adjustments ↔ ledger facts (I-3); refund ceiling (I-4). Added with 7-7b; the operation and resolution part from 7-7a | [P] from I-3/I-4 |
| C-8 | Invoice coverage and arithmetic (I-5, I-6); invoiced periods with late facts listed for the next invoice | [P] from I-5/I-6 |

- **Bounded runtime:** per organisation and per month, partition-pruned; `--org` and `--since` options [P].
- **Metrics:** reconcile gauges (drift count, unknown-outcome open count, last-run timestamp) only if D-77-7 chooses them.

---

## 7. Workflows, transactions, permissions, audit, idempotency

**Permissions [S]:**
- `billing.manage` at platform scope, signed-in users only, for every platform action;
- `billing.read` (system roles only, D-76-4) for tenant reads;
- no new permission key [P].

**Idempotency [S]:** `Idempotency-Key` is mandatory on every POST (RQ-3, `executePlatform`), with per-organisation request-key uniqueness in the database.

**Dual control [S]:** the D-76-3 / D-76d-1 mechanics (four eyes, binding to the exact amount and evidence, the server threshold `BILLING_DUAL_CONTROL_THRESHOLD_PAISE`):

| Action | Second approver required when |
|---|---|
| Refund, credit adjustment | Threshold unset, or amount > threshold |
| Debit adjustment | Always (if D-77-5 permits debits) |
| Payment record (postpaid) | Threshold unset, or amount > threshold — the D-76d-1 recharge rule |
| Tax configuration change | Always |
| Invoice issue | No: it is a deterministic document of posted facts; keyed and audited |
| Credit note | Always |
| Draft discard | No (no document was issued); keyed and audited |

**Transaction boundaries and lock order:**
- **Adjustment or refund execution:** adjustment row `FOR UPDATE` → organisation `FOR KEY SHARE` → the writer.
  - **Inside the writer's refund branch, after it locks the account row `FOR UPDATE`** (the account of the original charge; `BL005` otherwise):
    - it re-reads the original `customer_charge` fact (same organisation and account);
    - it sums the executed `refund` facts that reference it;
    - it refuses (`BL015` [P], `409 BILLING_REFUND_EXCEEDS_CHARGE`) when `sum + amount > charge`;
    - otherwise it inserts and applies the balance effect.
  - **Why this is atomic:** every posting to an account takes that same row lock first, so two concurrent refunds of one charge serialise on it. The second one's sum, read after the first commits and releases the lock, includes the first refund (READ COMMITTED; a fresh statement after the lock wait).
  - **Defence in depth:** the request-time check is advisory only; the binding check is the one inside the writer. The refund-to-original link is immutable and stored on the fact's `adjustments` row; `UNIQUE` on the adjustment's ledger anchor gives one fact per adjustment.
  - **Tests:** N concurrent executions whose total exceeds the charge — only a subset whose sum ≤ the charge executes, and the rest are refused and leave nothing; a mutation that moves the sum before the lock must fail.
- **Invoice generation (draft):**
  - one transaction per (organisation, period) with a unique key, so a re-run returns the existing draft;
  - selects every un-invoiced `customer_charge` fact with `occurred_at < period_end` (so late facts carry forward);
  - inserts the mapping (the unique key prevents double invoicing under concurrency) and the aggregate lines;
  - posts no ledger fact and moves no money.
- **Draft discard:** invoice row `FOR UPDATE` (status `draft` only) → delete its fact mappings → `discarded`. Keyed and audited; posts nothing.
- **Invoice issue:**
  - invoice row `FOR UPDATE` → number series row `FOR UPDATE` (gapless allocation, D-77-2) → tax lines → `tax:<code>` facts through the tax branch (§5.1, if D-77-1) → `issued`;
  - all one transaction, keyed;
  - refused while no active tax configuration exists [S: baseline proposal, part of D-77-1].
- **Payment:** in one transaction:
  - payment row;
  - organisation `FOR KEY SHARE`;
  - each allocated invoice `FOR UPDATE`, in id order, checking the I-10 ceilings;
  - the allocations;
  - the `payment` fact for the principal total, through the writer, which takes the credit account lock last and refuses an effect that would take `used` below 0.

  A tax allocation posts no fact.

**Failure and retry:**
- every POST rolls back whole on error, without consuming its key (the 7-6c / 7-6d pattern);
- refusals that leave a request pending are recorded and audited in a second transaction, using the PR #101 corrected `recordRefusal` pattern;
- transient errors (`40001`, `40P01`, `55P03`) return `503 BILLING_BUSY` and are retryable with the same key;
- generation is idempotent per (organisation, period); issue is idempotent per key and per invoice state;
- `billing:reconcile` retries nothing and fails closed (exit `2`) on any error.

**Audit:** security-sensitive, platform scope, same transaction, with before and after:
- `billing.adjustment.requested`, `.approved`, `.rejected`, `.refused`, `.executed`;
- `billing.invoice.generated`, `.issued`, `.draft_discarded`;
- `billing.credit_note.issued`;
- `billing.payment.recorded`, `.approved`, `.rejected`;
- `billing.tax_configuration.requested`, `.approved`.

`billing:reconcile` logs a run summary (no amounts at info level), not an audit row.

**APIs [P]** (platform under `/platform/billing`, tenant under `/billing`):
- adjustments: request, approve, reject, list, get;
- invoices: generate (per organisation, period), discard draft, issue, credit note (against an issued invoice), list, get, and the line view. There is **no void route**;
- payments: record, approve, reject, list;
- tax configuration: request, approve, read;
- tenant: `GET /billing/invoices`, `GET /billing/invoices/{id}`, `GET /billing/payments`.

No tenant write route.

**Errors:** existing codes are reused where they fit. New `409` codes: `BILLING_ADJUSTMENT_CONFLICT`/`_STALE`, `BILLING_INVOICE_CONFLICT`, `BILLING_TAX_NOT_CONFIGURED` (`422`), `BILLING_REFUND_EXCEEDS_CHARGE`. No amount appears in an error.

---

## 8. Implementation slices and PR boundaries [P]

Each slice is one draft PR, stopped for owner review before the next; a full regression and CI run with each. The order puts the safety net first and money movement before documents.

| PR | Slice | Migration | Depends on | Blocked by |
|---|---|---|---|---|
| **7-7a** | `billing:reconcile` (C-1 … C-6), read-only, report and exit codes, runbook entry (`PHASE-7-7A-RECONCILE-HANDOVER.md`) | None | — | — |
| **7-7b** | Adjustments and refunds: table, definers, writer branches, API, audit, tenant visibility per D-77-5; reconcile C-7 | Yes | 7-7a | D-77-5 |
| **7-7c** | Tax configuration and invoices: generation, issue, numbering, credit notes, reads; reconcile C-8 | Yes | 7-7b (credit notes reference adjustments) | D-77-1, D-77-2, D-77-3, **professional review** |
| **7-7d** | Payments: manual records, principal/tax allocation, postpaid ledger treatment | Yes | 7-7c | D-77-4, **D-77-8** |
| **7-7e** | Dashboards (Grafana JSON, provisioned like `providers.json`), metrics per D-77-7; low-balance threshold if D-77-6 | Only if D-77-6 | 7-7b (7-7a for gauges) | D-77-6, D-77-7 |

**Acceptance per slice (in addition to the full regression):**
- **7-7a:** each check proved by a seeded defect that it detects (a balance drifted by an owner-only update in a clone; a missing release; a duplicate provider cost; an unguarded partition; an old open reservation; an unknown outcome) and a clean run on a correct clone. Exit codes `0`/`1`/`2`. No write: a statement audit of the run shows `SELECT` only. A runtime bound on a seeded volume.
- **7-7b:**
  - the dual-control matrix, four eyes, binding;
  - the refund ceiling under concurrent refunds;
  - idempotency (replay, `422`, `400`);
  - a frozen account (per D-77-5);
  - the **refund ceiling under concurrency** (I-4; §7);
  - I-1 after mixed sequences;
  - the writer structural test (existing branches byte-identical);
  - tenant visibility and confidentiality;
  - mutation checks.
- **7-7c:**
  - generation idempotent and concurrent-safe (one draft; each fact on one invoice);
  - a discarded draft releases its facts to the next generation; no route or definer voids an issued invoice;
  - a late fact carried forward;
  - arithmetic and rounding;
  - gapless numbering under concurrent issue;
  - issue refused without tax configuration;
  - issued immutability (update, delete and truncate refused);
  - credit note flow;
  - no wallet, `used` or `reserved` change from tax (I-7; the §5.1 tests);
  - tenant reads of own invoices only;
  - a **professional-review sign-off recorded before merge**.
- **7-7d:** a unique external reference under concurrency; allocation ceilings (I-10) under concurrent payments to one invoice; the split per D-77-8; the `payment` fact equals the principal allocation; `used` never below 0; dual control; I-1 for postpaid.
- **7-7e:** dashboards load (JSON lint and provisioning test); metric label sets bounded (the existing label-boundary test); no tenant identifier labels.

**Evidence per PR:**
- the history proof in `RELEASE.md`;
- the before/after function, policy and grant fingerprint (7-6d-2 technique);
- mutation-check log;
- CI run;
- `~/acc-evidence/<date>-phase-7-7x-pr/` with SHA-256 manifest.

---

## 9. Migration sequencing

- `develop` ends at `0060_phase7_6d2_wallet_recharge`; the next free number on `develop` is `0061`.
- **Collision, documented:** `0060` is occupied on `develop` by PR #101 (`0060_phase7_6d2_wallet_recharge`, merged `36cd1e5`). Gemini's uncommitted Phase 8A-2 work in the main tree (`feat/phase-8a-2-contact-import-export`) names **`0060_phase8a_contact_import_export`**. **Gemini must coordinate its next migration number against current `develop`** before its PR. Gemini's files are not altered here.
- Each 7-7 slice takes the next free number **confirmed from `origin/develop` and open PRs at its authorisation**. Its journal `when` must follow the latest entry, as done for `0059`/`0060`. No number claimed by another PR is used.
- Gemini's work is not touched.

---

## 10. Outside 7.7

| Item | Where |
|---|---|
| Gate 7-A acceptance suite, load test (account-row contention, `occurred_at` scans), billing runbook | PR 7-8 (baseline §8.1) |
| Gate 7-B (cross-channel critical scenario) | Phase 5 acceptance (OD-7-1) |
| Reseller markup facts (OD-7-13, still open) | Separate handover. It changes 7.5 settlement, which 7.7 must not alter. Prerequisite for Phase 9 reseller billing |
| Revenue reporting `/reports` (`BILLING.md` §6) | Phase 9 |
| Event bus and outbox; `billing.invoice_issued`, `wallet_low_balance`, `ledger_entry_recorded` events | Not built (`EVENTS.md`); later phase |
| Payment gateway, automatic recharge crediting | Excluded by the roadmap ("no real payment processor") and OD-7-12 |
| Multi-currency, multi-component pricing, discounts from pricing rules | OD-7-9; roadmap ("implemented incrementally") |
| Enabling billing enforcement | Separate readiness report and owner approval (D-74-4) |
| Console screens (wallet, invoice, ledger detail) | Gemini (frontend), against the 7.7 API contracts |
| Entitlements and quotas | OD-7-14 |
| AI usage costing | Phase 10 |

---

## 11. Settled decisions relied on (not reopened)

- OD-7-1 (gates);
- OD-7-3 (ledger model);
- OD-7-4 / OD-7-4U (settlement; unknown outcomes);
- OD-7-5 / D-76-4 (permissions);
- OD-7-6 (provider cost from rates, §1zi.5);
- OD-7-7 / D-74-2 (fail closed; no automatic provisioning);
- OD-7-8 / D-74-1 (error contract);
- OD-7-9 (INR, paise);
- OD-7-11 / D-76-3 / D-76d-1 (dual control) and O-2 (environment threshold);
- RQ-2, RQ-3, RQ-4, RQ-5, RQ-6;
- D-76-1 … D-76-6;
- D-76d-1 … D-76d-5, including D-76d-5: no reversal of recharges in 7.6d. 7.7 corrections are new adjustment facts, never edits.

The open owner decisions are in `PHASE-7-7-DECISION-REGISTER.md`.

Verify with a qualified professional before acting on any tax, invoicing or financial aspect of this design.
