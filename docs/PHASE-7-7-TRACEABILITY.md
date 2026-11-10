# Phase 7.7 Traceability

**Baseline:** `origin/develop` `36cd1e5`, 10-Nov-2026. **Rev 2** (architectural-review corrections).
**Columns:**
- **Source:** where the requirement comes from (ROADMAP = `docs/ROADMAP.md` §10; BL = Phase 7 baseline Rev 3; DEC = `docs/DECISIONS.md`).
- **Existing:** what is merged today [V].
- **Planned:** the 7.7 slice (handover §8).
- **Evidence:** the acceptance evidence that closes it.

| # | Requirement | Source | Existing (merged) | Planned | Acceptance evidence |
|---|---|---|---|---|---|
| T-1 | Ledger-derivation consistency: materialised balance equals fresh ledger aggregation | ROADMAP Tests; BL §7.3, §9.3 F-9 | F-9 property test (`phase7_1-ledger.int-spec.ts:1654`); 7-6d-2 ledger-truth API test | 7-7a `billing:reconcile` C-1 (operator check over real data; `PHASE-7-7A-RECONCILE-HANDOVER.md`) | Seeded-drift clone detected (exit 1); clean clone exit 0; read-only transaction with no transaction id assigned |
| T-2 | One release and policy-correct charges per terminal billed message; one provider cost per reached attempt | BL §7.3 | 7.5 settlement and its suites | 7-7a C-2, C-3 | Seeded missing-release and duplicate-cost defects detected |
| T-3 | Open reservations older than a threshold | BL §7.3 | — | 7-7a C-4 | Seeded stale reservation reported |
| T-4 | Partition continuity, headroom (6 / 2 months), guards, orphans at reconcile | BL §9.1; RQ-4, RQ-6 | `db:ledger:partitions` report; startup check and gauges | 7-7a C-5 (reuses the 7-1 report) | Unguarded or orphan test partition reported; thresholds via a clock-shifted fixture |
| T-5 | Unknown-outcome reconciliation section | BL §6.5 (OD-7-4U); DEC §1zi.9 dev. 6 | 7-6b register and gauge; 7-6c resolutions | 7-7a C-6 | Every billed `outcome_unknown` listed with state, exposure and age; matches the register |
| T-6 | Adjustments and refunds as new ledger rows with a justification record | ROADMAP DB and Security; `BILLING.md` §7; DEC D-76d-5 | Enum values exist; writer refuses them; no `adjustments` table | 7-7b | Dual-control matrix; refund ceiling enforced atomically in the writer under the account lock, proved by N concurrent over-ceiling refunds (handover §7, I-4); idempotency; I-1; writer structural test; mutation checks |
| T-7 | Adjustment/refund approval-flow review | ROADMAP Security checks | Dual-control pattern (7-6c, 7-6d) | 7-7b | Four eyes, binding, refusal recording (the #101 pattern), audit rows; review notes in the PR |
| T-8 | Invoice generation from ledger aggregation | ROADMAP Scope ("invoice generation job"), DB; `BILLING.md` §4 | — | 7-7c (operator command and API, D-77-3) | Idempotent, concurrency-safe generation; each fact on one invoice; late fact carried forward |
| T-9 | GST placeholder logic: tax computed from configuration, not hard-coded | ROADMAP Objective; `BILLING.md` §4; BL §6.6 (RQ-1) | — | 7-7c (D-77-1, D-77-2) | Issue refused without configuration; arithmetic and rounding tests; marked `tax` writer branch (handover §5.1) with structural and behavioural tests proving no change to balance, `used`, `reserved` or `version` (I-7); professional sign-off recorded |
| T-10 | Invoices immutable once issued; corrections by adjustment plus credit note; no void | `BILLING.md` §4; architectural review | — | 7-7c | Update, delete and truncate refused on issued invoices; no void route or definer; draft discard releases facts; credit-note flow; gapless series under concurrency |
| T-11 | Payments (no real processor) | ROADMAP DB; BL §5.2, §9.3 [B] | Wallet recharge (7-6d-2) covers prepaid funding | 7-7d (D-77-4, D-77-8) | Unique external reference under concurrency; principal/tax allocation ceilings (I-10) under concurrent payments; `payment` fact = principal allocation; `used` never below 0; I-1 postpaid |
| T-12 | Mandatory keys on money-moving operations (refund, adjustment, recharge record, invoice issue) | BL §9.3 (RQ-3) | Recharge, resolutions, account operations keyed | 7-7b, 7-7c, 7-7d | Replay, `422`, `400` per POST; per-organisation key uniqueness in the database |
| T-13 | Billing dashboards: revenue, cost, margin; bounded labels | ROADMAP Observability; BL §8.1 | Billing gauges and counters exist (partition, unknown outcome, resolutions, operations) | 7-7e (D-77-7) | Dashboard provisioning test; the label-boundary test; no tenant labels |
| T-14 | Wallet / auto-recharge threshold logic, no processor | ROADMAP Scope; OD-7-12 | — | 7-7e, only if D-77-6 | Threshold keyed and audited; `lowBalance` at read; no automatic credit |
| T-15 | Financial-data access RBAC | ROADMAP Security | `billing.read` (system roles) / `billing.manage` (platform) | All slices reuse | Access tests per route (support, tenant, API key, none); route coverage pins |
| T-16 | Tenant confidentiality (no provider cost, markup, internal detail) | BL §7.1; DEC D-76d-3 | 7-6a policies; 7-6d-2 recharge visibility | 7-7b (D-77-5c), 7-7c tenant invoice reads | Raw-response confidentiality assertions, as in the 7-6d-2 tests |
| T-17 | Rollback by corrective adjustments, never editing history | ROADMAP Rollback | Append-only ledger and operation records | 7-7b provides the adjustment mechanism | Guard and immutability tests; no UPDATE or DELETE path |
| T-18 | `BILLING.md` refined | ROADMAP Documentation | — | Each slice updates `BILLING.md` §§4, 7 and `DECISIONS.md` | Documentation diff reviewed in each PR |
| T-19 | Console screens (wallet, invoice, ledger detail) | ROADMAP Frontend | — | **Not 7.7 backend:** Gemini, against the 7.7 API contracts | — |
| T-20 | Gate 7-A, load test, runbook | BL §8.1 (PR 7-8) | — | **Not 7.7** (PR 7-8) | — |
