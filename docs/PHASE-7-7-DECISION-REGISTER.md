# Phase 7.7 Decision Register (open owner decisions)

**Status:** **Rev 2**, DRAFT for owner review, 10-Nov-2026 (architectural-review corrections: no void of issued invoices; payment allocation D-77-8 added; D-77-1, D-77-2 and D-77-4 aligned). A companion to `PHASE-7-7-IMPLEMENTATION-HANDOVER.md` (baseline `origin/develop` `36cd1e5`).
**Scope rule:** only decisions that 7.7 cannot be built correctly without, and that the billing decision record has not settled (handover §11 lists what is settled).
**Markers:** [I] marks inference; tax, invoice and numbering content needs professional confirmation.

Each slice lists the decisions that block it (handover §8). 7-7a (`billing:reconcile`) needs **none** and can proceed on authorisation.

---

## D-77-1 — Tax, discount and wallet principal (RQ-1, open since baseline Rev 2)

**Blocks:** 7-7c.

**Recommendation:** approve the baseline §6.6 separation for 7.7:
- `customer_charge` stays gross;
- discount is a separate fact (none generated automatically in 7.7);
- tax is written only at invoice issue, as `tax:<code>` facts, each anchored on its own invoice tax line, through a marked writer branch that admits no account and changes no wallet principal, `used` or `reserved` (handover §5.1);
- invoice issue is refused until an active tax configuration exists, and no default rate is assumed;
- rounding: integer paise, half up, once per tax line [I].

**Also to be settled** with professional advice (the D-76d-2 and RQ-1 open items):
- **(a)** whether a prepaid recharge is itself a taxable supply (an invoice or receipt at recharge) or tax arises on consumption;
- **(b)** how tax is collected from prepaid organisations: deducted from wallet principal, or settled against the invoice separately.

*Recommendation for 7.7 [I]:* invoice consumption (customer charges) for both billing modes; issue no recharge invoices; collect no tax from wallet principal — tax is shown on the invoice and settled per (b) outside the wallet until advised otherwise.

**Rationale:** keeps the three quantities independently auditable and reversible by credit note, and moves no customer money on a tax assumption.

**Alternatives:**
- tax deducted from the wallet at issue — needs a new fact effect and a funds rule;
- tax on recharge — needs a receipt document at every recharge.

**Consequence:** I-7. A tax configuration table and a professional sign-off are needed before 7-7c merges.

**Verify with a qualified professional before acting.**

## D-77-2 — Invoice particulars, numbering, corrections and the tax-configuration home

**Blocks:** 7-7c.

**Recommendation [I]:**
- **Configuration home:** a versioned, append-only `tax_configurations` table, changed by request → approve under always-dual control and audited. It holds the supplier's legal name, address, GSTIN, default SAC, the rate table and the place-of-supply rule.
- **Customer particulars:** the customer's legal name, GSTIN and state are snapshotted on the invoice at issue.
- **Numbering:** gapless per financial year, for example `<prefix>/<FY>/<seq>`. It is allocated at issue under a locked series row, never from a database sequence (which has gaps).
- **Corrections:** an issued invoice is never edited and **never voided** (statuses `draft`, `issued`, `discarded`; there is no void route, definer or audit event). A **draft** may be discarded and regenerated. An issued invoice is corrected only by a credit note in its own gapless series, referencing the adjustment(s).

**Rationale:** `BILLING.md` §4 (immutability; credit-note correction); avoids hard-coded tax content.

**Alternatives:**
- configuration through an environment setting, as O-2 did for the threshold — unsuitable for versioned, multi-field tax data.

(Voiding issued invoices is removed by the architectural review and is not offered.)

**Consequence:** the 7-7c data model and tests (gapless numbering under concurrency).

**Verify numbering, particulars and credit-note rules with a qualified professional.**

## D-77-3 — Invoice period, timezone and generation trigger

**Blocks:** 7-7c.

**Recommendation:**
- **Period:** calendar-month periods per organisation, with boundaries in **Asia/Kolkata** [I: business-date convention].
- **Coverage:** a fact is invoiced on the first invoice whose period end follows its `occurred_at` and that has not already taken it, so late facts carry forward (I-5).
- **Trigger:** generation and issue are operator actions — API, plus a `billing:invoices --generate --period` command. The roadmap's "invoice generation job" is satisfied by that command, which an external scheduler (for example host cron) may invoke. There is **no in-process worker or timer**, consistent with RQ-4 and the no-worker stance.

**Rationale:** deterministic, auditable, no new runtime component.

**Alternatives:**
- an in-process scheduled job — a new worker exception requiring owner approval;
- UTC month boundaries — simpler, but they misalign with Indian business dates.

**Consequence:** the 7-7c command, runbook entry and tests.

## D-77-4 — Postpaid payment ledger treatment

**Blocks:** 7-7d.

**Context:** the baseline records postpaid payments "against invoice" but defines no ledger fact. Without one, `credit_accounts.used` never falls and available credit is never restored. The `recharge` writer branch is wallet-only by design (7-6d-2).

**Recommendation:** a new ledger entry type **`payment`**, credit account only, anchored on `payments.id`:
- **amount:** the payment's **principal** allocation total (handover I-10). Tax allocations never post a fact, because tax never entered `used` (I-7);
- **effect:** `used −= amount`, `reserved` unchanged, `used ≥ 0` enforced;
- **controls:** the recharge-style dual control and evidence binding, and a unique external reference;
- **enum:** an expand-only `ALTER TYPE … ADD VALUE`;
- **writer:** a new marked branch; existing branches byte-identical.

**Rationale:** keeps wallet recharge and postpaid settlement distinct, and is visible in the ledger (I-1).

**Alternatives:**
- reuse `recharge` on the credit account — conflates two meanings;
- no ledger effect, with payments only marking invoices paid — leaves available credit permanently consumed;
- a credit `adjustment` — misuses the correction mechanism.

**Consequence:** I-1 for postpaid; 7-7d writer branch and tests.

## D-77-8 — Splitting a postpaid payment between principal and tax (unresolved; professional advice required)

**Blocks:** 7-7d.

**Context:**
- An issued postpaid invoice has a principal part (`subtotal − discount`, already in `used`) and a tax part (not in `used`, I-7).
- A payment for the full total is unambiguous: principal and tax are allocated in full, and the `payment` fact equals the principal.
- A **partial** payment needs a rule for how much of it settles principal (restoring available credit) and how much settles tax.
- That rule is a tax and accounting matter and is **not decided here**.

**Options (no tax treatment is assumed by this register):**
- **(a) Operator-specified:** each payment request states its principal and tax allocation per invoice explicitly; the system enforces only the ceilings (I-10).
- **(b) Proportional:** each payment is split in the invoice's principal-to-tax ratio, with a defined rounding.
- **(c) Tax first:** the tax part is settled before principal.
- **(d) Principal first:** the principal part is settled before tax.

**Consequences:**
- (c) delays restoring available credit after a partial payment;
- (d) restores credit fastest, and leaves tax outstanding longest;
- (b) needs a rounding rule (residual paise);
- (a) needs the operator to know the correct treatment, and adds a dual-controlled field.

**Mechanical recommendation (not a tax treatment):** whatever rule is approved, the split is recorded explicitly on each allocation (`principal_paise`, `tax_paise`), validated against the ceilings, immutable after recording, and dual-controlled per D-76d-1. Until the rule is decided, 7-7d is not implemented, or it is implemented accepting only payments that settle invoices in full.

**Verify with a qualified professional before acting.**

## D-77-5 — Adjustment and refund policy

**Blocks:** 7-7b.

**Recommendation:**
- **(a) Kinds:** `refund` (against a specific customer charge, Σ ≤ the charge, I-4), credit `adjustment`, and **debit** `adjustment` (charging more). A debit is permitted but **always** dual-controlled, and needs available funds (prepaid) or limit (postpaid), as in operator charges.
- **(b) Frozen accounts:** refunds and credit adjustments are permitted (they only add customer funds); debits are refused.
- **(c) Tenant visibility:** `refund` and `adjustment` facts become visible in the tenant ledger with amount and time only (the D-76d-3 pattern) — an additive tenant-policy change.

**Rationale:** `BILLING.md` §7 ("either direction"); the roadmap rollback strategy relies on corrective adjustments; tenants should see credits to their balance.

**Alternatives:**
- credits and refunds only, with no debit adjustments — undercharges then cannot be corrected without re-rating;
- keep adjustments platform-only and invisible to tenants — balances would move without a visible line.

**Consequence:** 7-7b scope, dual-control matrix and tenant-policy change.

## D-77-6 — Low-balance threshold (OD-7-12, open)

**Blocks:** 7-7e (optional part).

**Recommendation:** include the minimum the roadmap names — "wallet/auto-recharge threshold logic (no real payment processor connected)":
- a per-wallet low-balance threshold set by `billing.manage` (keyed, audited);
- a `lowBalance` indicator in the tenant and platform account reads, computed at read time;
- a bounded metric;
- **no** automatic credit, recharge request or event (no outbox exists).

**Rationale:** satisfies the roadmap literally with no worker and no unbacked principal (the OD-7-12 rationale).

**Alternatives:**
- defer entirely to the phase that introduces the event bus;
- also record a "recharge request" entity.

**Consequence:** a small migration (threshold column) in 7-7e.

## D-77-7 — Dashboard data source and reconcile metrics

**Blocks:** 7-7e (and 7-7a gauges).

**Recommendation:**
- **Data source:** Prometheus only (the existing datasource). Add after-commit counters `acc_billing_posted_paise_total{entry_type, channel}` at the existing posting call sites in the API and dispatcher — observability only, with no change to transactions or behaviour, verified by the fingerprint and the regression suites.
- **Reconcile gauges:** `billing:reconcile` publishes nothing to Prometheus. The dashboards show revenue (customer charges), cost (provider cost) and margin as rates of those counters, labelled as **operational indicators, not financial truth** (`BILLING.md` §1).

**Rationale:** no new database exposure, and the bounded-label rule holds.

**Alternatives:**
- a read-only PostgreSQL datasource for Grafana — exact figures, but a new privileged reporting role and network path;
- dashboards from reconcile output only — point-in-time, operator-driven.

**Consequence:** 7-7e touches the dispatcher and service code for metric emission only. Approve explicitly, because 7.7 otherwise leaves settled paths unchanged.

---

**Not 7.7 decisions** (recorded so they are not mistaken for open 7.7 items):
- OD-7-13 reseller markup: open, but outside 7.7 (it changes 7.5 settlement);
- enabling enforcement (D-74-4).
