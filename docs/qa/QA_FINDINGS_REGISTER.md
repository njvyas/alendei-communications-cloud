# QA findings register

The single list of findings from ACC QA testing. Each finding is traced to its evidence, classification, development issue or next action, and disposition. Created 26-Oct-2026; QA release under test `2026.10.24-441a29a`.

**Rules**

- **Classification:**
  - *Confirmed defect*: reproduced or established by code reading.
  - *Unconfirmed concern*: observed but not established as wrong.
  - *Test-plan/documentation issue*.
  - *Known limitation*: accepted current behaviour with a recorded decision path.
- **Evidence provenance:** labels as in `QA_RELEASE_PREPARATION.md` §5.
  - *Observed*: GitHub, CI or the repository.
  - *Agent-run*: executed by Claude Code. Not independent verification. The evidence package is kept outside Git and listed in `MANIFEST.sha256`. The manifest hash for each file set is quoted in `QA_RELEASE_PREPARATION.md` §5b and §5c.
- **Severity** uses the scale in `QA_TEST_PLAN.md`. Values marked *proposed* are not owner-approved; *—* means the evidence does not support assigning one.
- **Status:** a finding stays **Open** until its disposition is done and verified. Recording a finding does not close it.
- **Public repository:** no recipient data, credentials, addresses or evidence contents appear here.

## Open findings

| ID | Finding | Source | Classification | Severity (priority) | Evidence and verification | Issue / next action | Status |
|---|---|---|---|---|---|---|---|
| QAF-001 | WhatsApp template sends are not provider-ready. The server neither renders templates nor validates their variables; `ProviderSubmission` has no structured template fields; a payload without `text` is passed as JSON text | QA-E-02, 26-Oct-2026 | Known limitation | — (owner decision) | Agent-run (WhatsApp runs 4 and 5) plus code reading; recorded in PR #17 (`RELEASE.md` §11, `ROADMAP.md` Phase 4.3) | [#24](https://github.com/njvyas/alendei-communications-cloud/issues/24): P3-D22/P3-D24 decision before any real WhatsApp provider | Open: deferred to owner decision |
| QAF-002 | A disabled provider in an active assignment is logged as an error-level circuit-admission failure, and the message detail says "circuits refused admission". The outcome (`NO_ELIGIBLE_PROVIDER`, no attempt) is correct | WhatsApp run 2, 26-Oct-2026 | Confirmed defect (diagnostics) | S3 *proposed* (low) | Agent-run API logs (6 error entries) plus code reading (`dispatcher.service.ts` candidate loop; `ROUTING_ENGINE.md` §5) | [#20](https://github.com/njvyas/alendei-communications-cloud/issues/20) | Open |
| QAF-003 | The `simulator_behavior` capability accepts any value; an empty string was persisted. Only `rcs_message_types` is validated on save | Provider set-up, 26-Oct-2026 | Confirmed defect (validation gap). Whether the console produced the empty value is **unconfirmed** | S3 *proposed* (low) | Agent-run database and audit read plus code reading (`provider-registry.service.ts`) | [#21](https://github.com/njvyas/alendei-communications-cloud/issues/21); re-check D-03/D-04 on reload in the console round | Open |
| QAF-004 | `message.queued` event payloads store the full normalized recipient. The API does not return event payloads, and `message_events` is tenant content under the same RLS as `messages`, which also stores the address | Phase B, 26-Oct-2026 | Unconfirmed concern (data minimisation) | — | Agent-run database read (synthetic numbers only) plus `messages.service.ts` (`message.queued` insert) | Owner and privacy decision on whether event payloads may hold the full recipient. No issue until decided. Any legal or regulatory conclusion: verify with a qualified professional before acting | Open: decision needed |
| QAF-005 | Three dispatcher error logs drop the error object (`logger.error('<msg>', error)` through nestjs-pino) | BE-DISPATCH-01 diagnosis, 23-Oct-2026 | Confirmed defect (observability) | S3 *proposed* (low) | Code reading (`dispatcher.service.ts` ~L109, ~L911, ~L1082; nestjs-pino argument handling); earlier Agent-run observation | [#22](https://github.com/njvyas/alendei-communications-cloud/issues/22) | Open |
| QAF-007 | Restoring a dump into a **new** database fails until the application roles exist. `RELEASE.md` §7 and `INTERNAL_QA_DEPLOYMENT.md` §10 do not say so | Restore test, 24-Oct-2026 | Test-plan/documentation issue | — (affects D5 and QA-I-04) | Agent-run restore: failed at the first policy, then passed with roles pre-created and row counts matching | [#23](https://github.com/njvyas/alendei-communications-cloud/issues/23) | Open |
| QAF-008 | The documented restore command (`$C exec -T postgres pg_restore … < <dump>`) has not been run on the QA host. A related `pg_restore -l` read through `compose exec` stdin failed during the 24-Oct backup check | Deployment, 24-Oct-2026 | Unconfirmed concern | — | Agent-run (the listing attempt only) | Verify the exact documented command during the D5 restore drill; raise an issue if it fails | Open |
| QAF-009 | A refresh without the `X-Acc-Refresh` header returns `403 AUTHZ_PERMISSION_DENIED`. This is intentional in `csrf.guard.ts`, but `API.md` §3b does not name the code | Session tests, 24-Oct-2026 | Test-plan/documentation issue (no defect) | — | Agent-run (AUTH-07) plus code reading | Name the status and code in `API.md` §3b in a later documentation PR | Open |
| QAF-010 | Fallback tests can pass without exercising fallback while a failing provider's circuit is open (30 s cooldown; one trial after it). Section K documents this; section F does not | WhatsApp run 5, 26-Oct-2026 | Test-plan/documentation issue | — | Agent-run (runs 5 and 6, with circuit logs) | Add the cooldown note to `QA_TEST_PLAN.md` section F | Open |
| QAF-011 | During SMS set-up, two WhatsApp assignments of the same organization were enabled by mistake and later reversed by the operator. The assignments panel lists every channel together | Phase B set-up, 26-Oct-2026 | Unconfirmed concern (usability) | — | Agent-run audit-log read | Observe during QA-D-08 and the usability tasks (section J); raise an issue only if testers reproduce the confusion | Open |
| QAF-018 | The WhatsApp send form's approved-template list offered an approved **SMS** template in Org A2. Sending it was refused `422 VALIDATION_FAILED` ("Template does not match requested channel"). Org B2's list showed only WhatsApp templates | Console checks, 26-Oct-2026 | Confirmed defect (console) | S3 *proposed* (low) | Agent-run browser automation: dropdown contents and send response (`console/batch2/QAF-018-…png`) | [#28](https://github.com/njvyas/alendei-communications-cloud/issues/28); console owner (Gemini) | Open |
| QAF-019 | The contacts list is sorted oldest first (25 per page), so a newly created contact is not on page 1. There is no console search (QA-C-09 deferred) | Console checks, 26-Oct-2026 (QA-C-01) | Unconfirmed concern (usability) | — | Agent-run browser automation: new contact found on page 2 (`console/batch2/C-01-contact-found.png`) | Collect tester feedback in section J (J-03, J-05); raise an issue only if testers confirm the impact | Open |
| QAF-012 | Two stray **invited** QA accounts (email local parts equal to the organization slugs) and two refused activation attempts on 24-Oct-2026 | Account set-up, 24-Oct-2026 | QA data housekeeping (no product defect) | — | Agent-run database read; activations audited as `denied` | Operator disables both accounts through the console and records it | Open |

## Resolved findings (retained for traceability)

| ID | Finding | Source | Classification | Resolution | Remaining verification |
|---|---|---|---|---|---|
| QAF-006 | QA-K-04's expected result (refusal at approval) did not match: an invalid `dlt.entityId` is refused at creation (`400 VALIDATION_FAILED`); approval without DLT is refused (`422 SMS_DLT_METADATA_REQUIRED`) | Phase B, 26-Oct-2026 | Test-plan/documentation issue | Corrected by PR #19 (`5718b1a`) | None |
| QAF-013 | The message list and detail API returned full recipients (FE-3 M-08) | FE-3 QA-E-09, 23-Oct-2026 | Confirmed defect | Fixed: `1bd04e3`, `5d1bd3a` (PR #1, `2c93f77`) | Agent-run masking checks passed on `441a29a` (API and console list/detail, 26-Oct-2026) |
| QAF-014 | The message list kept the previous organization's cursor after an organization switch (FE-3 M-09) | FE-3 QA-E-09, 23-Oct-2026 | Confirmed defect | Fixed: `1bd04e3`, `5d1bd3a` (PR #1); QA-E-09 PASS on the fix branch | Console organization-switch check on `441a29a` **BLOCKED**: needs a multi-organization persona |
| QAF-015 | Suppression console defects D1–D4: dialog focus loss; stale list after a lift conflict; banner kept after an organization switch; viewers' organization lookup error, now an intentional fallback that shows the organization ID | Suppression acceptance, 23-Oct-2026 | Confirmed defects | Fixed: `bde108d` with regression and Playwright tests; browser re-acceptance passed 23-Oct-2026 on `9cf5872` | The header showing IDs rather than names remains a usability item (`UX_AUDIT_PLAN.md` U14) |
| QAF-016 | BE-DISPATCH-01: the provider circuit never opened, because the dispatch role could not execute the state guard | FE-3 disposable stack, 23-Oct-2026 | Confirmed defect | Fixed: migration `0036`, PR #3 (`886faa2`) | Live circuit transitions observed (Agent-run, 26-Oct-2026). Acceptance item X-7 **deferred** |
| QAF-017 | BE-DISPATCH-02: a message whose lease expired mid-submission could be resubmitted | Repeated worker test, 24-Oct-2026 | Confirmed defect | Fixed: PR #14 (`554dea3`), 6 regression tests | QA-host claim path not verifiable; X-6 operator window pending (the planned variant does not prove the claim path) |

## Acceptance dependencies (not findings)

| Dependency | Required before | Status |
|---|---|---|
| QA-lead confirmation for T-1 | QA-K-10, QA-K-11 | Resolved 26-Oct-2026 by an AI-agent acting-QA-lead decision, **not** a human sign-off (`QA_RELEASE_PREPARATION.md` §5c). K-10 and K-11 PASS at API level |
| Database-table no-storage check for QA-K-10 and K-11 | Completing the T-1 evidence | **VERIFIED (Agent-run, 26-Oct-2026 09:04 UTC)**: no email or voice rows in any organization; no rows created in the test window (`t1/02-db-check.txt`). The T-1 authorization remains an AI-agent decision, not a human QA-lead sign-off |
| Console sections A–I | Final QA | 26-Oct-2026: 38 plan rows executed by Agent-run browser automation as the two org-admin personas (`QA_RELEASE_PREPARATION.md` §5d). Rows needing the platform administrator, other personas or the operator remain open |
| Usability feedback from at least three human testers (section J) | Final QA | Not arranged; cannot be produced by an agent |
| Operator-supervised session (X-6, QA-I-01 – I-03) | F.3, final QA | Procedure drafted (`QA_RELEASE_PREPARATION.md` §5e); window not agreed |
| D1, D2 records and approvals | F.3-9 | Routed for approval; not closed |
| D5 storage, access, encryption, retention, frequency, restore operator | F.3-9, QAF-007, QAF-008 | Deferred |
| X-7 decision | F.3-6 | Deferred |
| P3-D22 / P3-D24 | QAF-001 | Open ([#24](https://github.com/njvyas/alendei-communications-cloud/issues/24)) |
| Owner review and separate gate decisions | Gates F.2 and F.3 | **F.2 NOT ACCEPTED; F.3 NOT ACCEPTED** |
