# Phase 8C — Dependency and risk register

**Status:** Rev 2, 10-Nov-2026. 8C-1 to 8C-4 approved; owner decisions recorded (DEP-6, DEP-12 updated). **Baseline:** `develop` at `b5517bc`.

Tags:
- **[V]** verified in the repository at the baseline;
- **[I]** inference.

## 1. Dependencies

| ID | Dependency | Source | Status at baseline | Needed by | Notes |
|---|---|---|---|---|---|
| DEP-1 | Shared submission core `MessageSubmissionCore.submit` | PR 7-3 (`DECISIONS.md` §1zi.6) | Merged [V] | 8C-5 | The only permitted send path |
| DEP-2 | Consent and suppression at submission; re-check at every dispatch claim | 3.1 / 4.3 G-2 (`0037`) | Merged [V] | 8C-5 | Journeys inherit both; tests J-S1/J-S2 prove it |
| DEP-3 | Funds reservation in the core (`BILLING_ENFORCEMENT_ENABLED`) | PR 7-4 (`0053`) | Merged, enforcement **off** [V] | 8C-5 | Refusals map to step outcomes (handover §8.4) |
| DEP-4 | Settlement in the dispatcher | PR 7-5 (`0054`) | Merged [V] | 8C-6 parity | No journey code |
| DEP-5 | Origin attribution on core submissions (`messages.journey_id`, `journey_execution_id`) | `DATABASE.md` §6 | **Not built** [V] (`messages.campaign_id` exists, `journey_id` does not) | 8C-5 | 7-3 kept campaign fields out of the core; 8B-3 needs the same extension. Design it once, generically |
| DEP-6 | Automated sender principal (D-5) | 7-3 handover §8; OD-8B-5 | **Decided 10-Nov-2026** (owner decision 1): shared organisation-owned automation principal, built in **8B-3** | 8C-6 (reuse) | Short-lived execution-scoped capabilities, initiator attribution, admin pause/revocation; not built yet, so journey sends stay impossible |
| DEP-7 | Campaign execution (PR 8B-3) | `ROADMAP.md` §11c ("journeys can trigger campaign-like sends") | **Not built**; `CAMPAIGN_DISPATCH_DISABLED` [V] | "Trigger campaign" action (excluded from 8C) and the shared principal | PR #94 delivered audience materialisation, previews and scheduling validation, **not** dispatch |
| DEP-8 | Audience resolution `ContactsService.resolveAudience` | 8A-S / 8B-2 | Merged [V] | 8C-4 scheduled triggers | Keyset resolution reused |
| DEP-9 | In-process worker precedent (`DispatchWorker`) and the scope-creep "worker" exception | B1 (20-Oct-2026) | Merged [V] | 8C-3 | The runner adds a parallel, explicitly cited exception |
| DEP-10 | Delivery-outcome data (`messages.delivery_status`) | Phase 5.0 | Merged; **ingress disabled** (OD-19) [V] | 8C-4/8C-5 outcome triggers and branches | Verified with simulator receipts only; real outcomes need OD-19 and real adapters (out of scope) |
| DEP-11 | Templates: approval, channel compatibility, variable rules | 3.1 / 8B-2 | Merged [V] | 8C-1 validation | Reuse the 8B-2 rules, not a copy |
| DEP-12 | Migration numbering | `develop` | Latest `0061` [V]; no open PR claims `0062` at the time of writing [V: open PRs #85, #51 and #50 add no migration; #65 (open, last updated 02-Nov-2026) carries `0041_d2_branding_column_grant.sql`, a number already used on `develop`, and would need renumbering if revived, possibly into the 8C range] | 8C-1 | Re-confirm against `develop` and Gemini's open work at authorisation |
| DEP-13 | Frontend builder | Gemini (`apps/web`) | Not started [V: no journey route in `apps/web`] | 8C-FE | Starts from the 8C-1 contract |
| DEP-14 | `billing:reconcile` (read-only) | PR 7-7a (#103, merged `69b66ad`) | Merged [V] | 8C-6 parity check | Used only as a post-test check |

## 2. Risks

| ID | Risk | Likelihood / impact [I] | Mitigation | Residual |
|---|---|---|---|---|
| R-1 | Duplicate sends from runner races, crashes or lease expiry | Medium / high (financial, customer-facing) | Send, history and advance in one transaction; conditional `state_version` update with claim token and epoch; `UNIQUE (message_id)` on steps; J-C1–J-C3 plus mutation checks | A provider-side duplicate after an ambiguous provider timeout remains a dispatcher matter (existing `OUTCOME_UNKNOWN` handling) |
| R-2 | Executor identity weakens tenant isolation | Medium / critical | OD-8C-1: claim-bound principal, fail-closed; no definer that creates messages for an arbitrary org; J-S4 | Depends on the chosen option |
| R-3 | Journeys bypass consent or suppression | Low / critical | Core-only send path (structural test); dispatcher re-check; J-S1/J-S2 | Window between submission and claim already documented (`DECISIONS.md` §1za, ≤ 3 s) |
| R-4 | Runaway enrolment or sends (misconfigured trigger, large segment) | Medium / high (cost) | Re-entry policy default `once`; enrolment batch limits; per-org fairness; kill switches `JOURNEY_RUNNER_ENABLED` and `JOURNEY_SENDS_ENABLED`; reservation refusals under enforcement | No per-journey budget cap (candidate for later) |
| R-5 | Infinite loops or unbounded executions | Low / medium | DAG-only graphs in v1; 1,000-transition cap; poison handling | — |
| R-6 | Event-capture trigger on `messages` adds write amplification to the hot path | Medium / medium | Insert only when the organisation has an active trigger of that kind (indexed `EXISTS`); measured in the 8C-4 volume test; alternative: service-level writes in the delivery writer | Measured, not assumed |
| R-7 | `automation_events` growth | Medium / low | Retention purge [P 30 days]; partial index on unprocessed rows | — |
| R-8 | Editing a live journey changes behaviour for contacts mid-flight | Low / medium | Published versions immutable; in-flight executions stay on their version (J-V1) | — |
| R-9 | Contract drift between the builder (Gemini) and the backend | Medium / medium | One validator in `packages/contracts`; OpenAPI drift CI job; the server is authoritative | Coordination through the handover only |
| R-10 | Migration-number collision with Gemini's concurrent work | Medium / low | Confirm the number at each PR start; documented precedent (`0058`/`0060` collision) | — |
| R-11 | Scope creep into 8D/8E (handoff, chatbot) or outbound HTTP | Medium / medium | Stub nodes record `stubbed` and do nothing; scope-creep pins; OD-8C-3 | — |
| R-12 | Delivery-outcome branches untestable against real providers | High / low | Simulator receipts; documented as a limitation until OD-19 and real adapters | Real-provider behaviour not evidenced in 8C |
| R-13 | Time-zone and DST errors in waits and schedules | Medium / medium | UTC storage; organisation time zone for window and schedule nodes; DST unit tests | — |
| R-14 | Billing behaviour differs between journey and API sends | Low / high | Single core path; J-P2 with enforcement on and `billing:reconcile` = 0 | — |
