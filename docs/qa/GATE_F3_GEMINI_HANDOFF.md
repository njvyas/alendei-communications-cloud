# Gate F.3: consolidated handoff for Gemini independent review

Prepared 31-Oct-2026. The owner submits this **once**, when every row in §2 is marked Ready. Until then it is a checklist. Gate F.3 remains **NOT ACCEPTED**.

**Candidate under review:** `2026.10.24-441a29a` (historical; code identical to `554dea3`; migrations `38|04b0fac738f24476e76b88a84fd04850`).
- It does **not** contain later `develop` fixes (U1, U8, U10, #20, #21, #28, #30, QAF-026).
- Any later candidate is separately identified, deployed only with owner approval, and tested against its deployed commit.

## 1. Accepted and frozen (review for completeness only; not reopened)

| Item | Evidence | Manifest SHA-256 (outside Git) |
|---|---|---|
| F.3-1 – F.3-7 | `GATE_F3_CLOSEOUT.md` §1, §6; `DECISIONS.md` §1zc | — |
| QA-F-07 (F.3-6) | `QA_RELEASE_PREPARATION.md` §5h | `~/acc-evidence/2026-10-31-qa-f07/MANIFEST-run-and-restore` `4dcc0996…` |
| X-6 (F.3-5) | `QA_RELEASE_PREPARATION.md` §5i; `QA_X6_OPERATOR_RUNBOOK.md` | `~/acc-evidence/2026-10-31-qa-x6/MANIFEST-x6-final` `1b9450c1…` |
| Local recovery copy (not D5) | `GATE_F3_CLOSEOUT.md` §3 | `~/acc-evidence/2026-10-31-qa-recovery-copy/` `25a18cb4…` |
| AI usability evaluation (informative; not a substitute for human evaluation) | `QA_RELEASE_PREPARATION.md` §5j | `~/acc-evidence/2026-10-31-qa-j-ai/` `bd0b7ddc…` |

## 2. Evidence to complete before submission

| Area | Status (31-Oct-2026) | Evidence to attach when done |
|---|---|---|
| F.3-8 human evaluation (E1–E3, journeys 1–5, keyboard, NVDA/VoiceOver, J-01, J-02) | **Pending:** evaluators not nominated | Three signed summaries, feedback entries, `QA_TEST_PLAN.md` J results, evidence manifest (`QA_J_EVALUATOR_PACKAGE.md` §9) |
| QAF-026 | Fixed in PR #52 (draft, CI green); **not merged, not deployed** | Merge commit on `develop`. QA verification only on an owner-approved deployed candidate; otherwise carried as an accepted residual against `441a29a` |
| D1 firewall | Script staged, offline-tested; **not applied** | `before.txt`, `after.txt`, `actions.txt` (privileged `ufw`/`sshd -T`), new-SSH-session and HTTPS checks, denied-path probe, with hashes |
| D2 access register | Procedure written; **vault entry and named human custodian pending** | Owner confirmation of the entry and date (no vault content) |
| D5 encrypted off-host backup | Tool tested locally only (**not D5 acceptance**); destination, access, public key and custodian pending | `d5-backup.sh` logs for a real backup (destination hash verified) and `restore-verify` (row counts identical); cron entry |
| Fresh-cluster restore (QAF-007/W-4) | Proposal ready; **not authorized** | Drill record, or an owner exception carrying it as a residual |
| PR #50 (closeout record) | Draft | Final head commit |
| PR #51 (watcher dry-run fix; not part of X-6 acceptance evidence) | Draft; review and branch-target decision pending | Review outcome; harness rerun result |

## 3. Exceptions and residual risks to review

- **F.3-2/3, F.3-4:** automated-only exceptions. Live multi-worker concurrency (X-4) and the live queue-to-claim race (X-5) were not exercised.
- **F.3-5:** the claim-time race is evidenced by automated tests only. Docker automatic restart was not verified. One accepted `outcome_unknown` message is retained.
- **F.3-6:**
  - R-AUD-1: system-actor circuit transitions are not audited.
  - QAF-021: no supported circuit reset.
  - QAF-022: refusal logs lack `messageId`.
- **Providers and templates:** simulator-only providers, simulated template approval, synthetic DLT validation.
- **F.3-8:** J-04 and J-06 failed in the AI evaluation on `441a29a`. Their U10/QAF-018 parts are fixed on `develop`, not on the candidate.
- **QA host:** API `--since` log reads are unreliable; the undocumented reboot of 28-Oct 09:37:44 UTC; the lost QA-I-04 dump.
- **Retained QA data:** listed in `GATE_F3_CLOSEOUT.md` §5.

## 4. Questions for the reviewer

1. Does the evidence in §2 meet F.3-8 and F.3-9 as written in the gate criteria?
2. Are the §3 residuals acceptable for an internal QA release, or does any one block acceptance?
3. Is any evidence inconsistent with the frozen items in §1?
