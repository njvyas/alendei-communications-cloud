# Gate F.3 closeout: reconciliation and remaining work

Prepared 31-Oct-2026 after the QA-F-07 acceptance; updated the same day with the owner's closeout decisions (`DECISIONS.md` §1zc.3). It reconciles every Gate F.3 criterion against the evidence that exists, and lists the work left with its owner and blocker.

**Gate F.3 is NOT ACCEPTED**, and this document does not accept it. Phase 5 is NOT AUTHORIZED.

Evidence labels follow `QA_RELEASE_PREPARATION.md` §5 (Observed, Agent-run, Approved). Evidence packages are outside Git on the operator workstation, each with a `MANIFEST.sha256`.

## 1. Criterion reconciliation (historical F.3 evidence candidate `2026.10.24-441a29a`, code = `554dea3`)

Owner decision (31-Oct-2026): `441a29a` is the historical F.3 QA evidence candidate. U8 (PR #44), U10 (PR #45), U1 (PR #46) and the fixes for #20, #21, #28 and #30 were merged to `develop` afterwards. They are not deployed to QA and not tested on the candidate.


| # | Criterion | Evidence that exists | Assessment | What closes it |
|---|---|---|---|---|
| F.3-1 | Email and voice refused (`422 CHANNEL_NOT_SUPPORTED`), nothing stored | PR #10 (Observed); QA-K-10/K-11 PASS at API level and database no-storage check (Agent-run, 26-Oct-2026; `QA_RELEASE_PREPARATION.md` §5c) | **Evidence accepted** (owner decision, 31-Oct-2026). Confirmation was by an **AI-agent acting QA lead (T-1), not an independent human sign-off** | None |
| F.3-2/3 | SMS/RCS worker safety, fencing, recovery, idempotency, isolation | PR #11 suites, 1,538 lines (Observed); X-4 automated-only verification **approved** 30-Oct-2026 (`DECISIONS.md` §1zc.1) | **Closed by approved exception.** Residual: live multi-worker concurrency unverified | None (residual carried to the sign-off) |
| F.3-4 | G-2 recipient re-check at dispatch (`0037`) | PR #12, CI `40066676777` (Observed); `0037` applied on QA (proof `38\|04b0fac7…`, Agent-run); X-5 **approved** 30-Oct-2026 | **Closed by approved exception.** Residual: the live queue-to-claim race is not exercised | None (residual carried) |
| F.3-5 | BE-DISPATCH-02: no resubmission after an expired submission lease | PR #14 suites, CI `40066664676` (Observed); **X-6 executed 31-Oct-2026** (Agent-run, owner as named operator; `QA_RELEASE_PREPARATION.md` §5i) | **Closed: X-6 ACCEPTED** (owner decision, 31-Oct-2026). Residuals: the claim-time race remains automated-test-only evidence; Docker automatic restart unverified | None |
| F.3-6 | BE-DISPATCH-01 circuit fix (`0036`) | QA-F-07 executed 31-Oct-2026 and **ACCEPTED** by the owner (§5h; `DECISIONS.md` §1zc.2) | **Closed.** Residuals: R-AUD-1, QAF-021, QAF-022 | None |
| F.3-7 | Migration history after upgrade | Disposable-clone proof (Observed); QA before `36\|093bfe92…`, after `38\|04b0fac7…` (Agent-run, 24-Oct-2026); re-observed `38\|04b0fac7…` on 28-Oct (after the outage), in the QA-I-04 scratch restore, and in every 31-Oct preflight | **Evidence accepted** (owner decision, 31-Oct-2026) | None |
| F.3-8 | Full regression on the release commit | CI `40067932448` (Observed); Agent-run API checks and console automation of 36 rows; QA-F-07, X-6; **Section J AI evaluation (Claude), 31-Oct-2026** (`QA_RELEASE_PREPARATION.md` §5j) | **Partial.** AI evaluation: J-03, J-05, J-08, J-09 pass; J-04 and J-06 fail (QAF-026; pre-U10 dialog behaviour; QAF-018); J-07 automated only; J-01/J-02 blocked. No Gemini, human usability or screen-reader evaluation. Platform-admin, other-persona and operator rows and I-01 – I-03 not run | See §6 |
| F.3-9 | Deployment controls (exposure, TLS, startup checks, accounts, secrets, backup) | Agent-run 24-Oct-2026 controls; QA-I-04 PASS (28-Oct-2026); **read-only re-verification 31-Oct-2026** (TLS 1.2/1.3 only; loopback-only app ports; only 443 and 22 exposed; `ufw` active, rules unreadable) | **Partial.** D1 IP restriction unverified (needs `sudo`); D2 register and D5 off-host encrypted backups not implemented (inputs missing) | See §6 |

**Summary:**
- **Closed** (by evidence or approved exception): F.3-2/3, F.3-4, F.3-5 (X-6 accepted 31-Oct-2026), F.3-6.
- **Evidence accepted:** F.3-1 (AI-agent QA-lead confirmation, not human sign-off), F.3-7.
- **Open:** F.3-8, F.3-9.

## 2. X-6 (and I-01 – I-03): the exact operational authorization needed

**X-6 was executed and ACCEPTED on 31-Oct-2026** (`QA_RELEASE_PREPARATION.md` §5i; `DECISIONS.md` §1zc.5). The authorization fields below were completed in the evidence package. They remain the template for I-01 – I-03, which are not authorized.

Materials are ready:
- `QA_X6_OPERATOR_RUNBOOK.md` v2.1;
- `scripts/qa/x6-watcher.sh` (harness `scripts/qa/test-x6-watcher.sh`, 26/26 offline; the watcher's SQL was validated against the schema);
- `QA_RELEASE_PREPARATION.md` §5e (I-01 – I-03).

Read-only state on 31-Oct-2026: `QA Sim Timeout` and `QA Sim OK` are both `active`, `closed` (generation 0) and `healthy`; `QA Sim Timeout` has `simulator_behavior "TIMEOUT"`.

Owner direction (31-Oct-2026): prepare the live drill and keep every safeguard; **no execution** until the named operator and window are recorded and explicit operational authorization is given. The fields to record are in `QA_X6_OPERATOR_RUNBOOK.md` §9. One owner authorization must name **all** of the following:

1. **Window:** date, start and end time (UTC), and the **named QA operator** present throughout. The operator opens the SSH control socket.
2. **Procedure:** approval of runbook v2.1 as written.
3. **Temporary routing change by the platform administrator (qa-org-a2 WhatsApp):**
   - change, in this order: `QA Sim 500` priority 1 → 10 and disabled; then `QA Sim Timeout` priority 3 → 1 and enabled; `QA Sim OK` stays at priority 2;
   - restore in reverse order after the test.
4. **SIGKILL:** one `docker kill` of the api container, issued only by the watcher (exactly once, only when the X-6 message is `submitting` within the 2.5 s age limit; otherwise it exits without killing).
5. **API restart:** `$C up -d --wait api` immediately afterwards. Whether Docker's `unless-stopped` policy restarts a killed container on its own is **unverified**; the runbook restarts it explicitly.
6. **Expected side effects accepted:**
   - one QA message ends `outcome_unknown`;
   - a brief API outage (QA only);
   - no other qa-org-a2 traffic during the window.
7. **Scope acknowledgement:** X-6 evidences sweeper recovery of an abandoned submission, not the claim-time race of BE-DISPATCH-02.
8. **Optional, same window:**
   - I-01 (graceful API restart);
   - I-02 (`$C restart web`);
   - I-03 (`$C stop redis` then `start`). Expected result decided 31-Oct-2026: degraded readiness is acceptable only if it is reported accurately, liveness stays healthy for operations that do not need Redis, and dispatch readiness is not falsely reported.

If the owner chooses not to run X-6, the alternative is an automated-only exception for F.3-5 recorded like X-4/X-5 (R-2).

## 3. Infrastructure evidence

| Item | Evidence | Status | Needs owner input? |
|---|---|---|---|
| QA-I-04 restore drill (scratch database, live cluster) | Executed 28-Oct-2026 (Agent-run): counts, migration proof, ACLs, owners and RLS identical (`QA_RELEASE_PREPARATION.md` §4) | **Done** | No |
| QAF-007 fresh-cluster restore drill / QAF-008 restore command | Drill proposal v3 prepared outside Git (`~/acc-evidence/2026-10-28-d5-drill-proposal/`; its RLS comparison query already corrected) | Pending | Yes, with D5: approved recovery host and a named operator |
| D1 access and TLS exception | `QA_RELEASE_PREPARATION.md` §2 | Open | **Yes (infrastructure owner):** approve the IP-only HTTPS exception, its expiry, CA trust, network ranges and the named SSH operators |
| D2 administrator identity | `QA_RELEASE_PREPARATION.md` §3; exactly one platform administrator (the bootstrap account) | Open | **Yes:** record the accountable person in the access register (outside Git); approve the bootstrap-password procedure |
| D5 backup and recovery | `QA_RELEASE_PREPARATION.md` §4 (proposals: 30-day retention, weekly plus pre-upgrade, encrypted) | Deferred | **Yes (infrastructure owner):** approved off-host storage, access, encryption, retention, schedule, restore operator |
| QA-I-04 dump on the QA host | Recorded as retained on 28-Oct (SHA-256 `7e22c84f…`) under a relative path. **Not found on 31-Oct-2026** (read-only search). Inferred lost when `/tmp` was cleared by the undocumented host boot of 28-Oct 09:37:44 UTC | **Lost (backup incident).** Replaced by an owner-approved **local recovery copy**, 31-Oct-2026 06:40 UTC: `~/acc-backups/acc-qa-20261031T0640Z-recovery-copy.dump`, SHA-256 `b503d7c2dbe03bafe4db44e8e1e2970345d916c05546222ae0a48522b881a31f`, `pg_restore -l` verified. Not off-host; does not satisfy D5 | D5 decision (R-6) |
| Agent-created empty file `/tmp/.no` on the QA host (28-Oct-2026) | Removal approved 31-Oct-2026 subject to confirming the exact file; it was **already absent** (`/tmp` cleared at the 28-Oct 09:37 boot). Nothing removed | **Closed** | No |
| QA host disk at 86 % (5.1 GB free of 38 GB) | Read-only analysis 31-Oct-2026: Docker images 15.4 GB, of which 9.7 GB reclaimable (unused: `acc-web`/`acc-api` `2026.10.23-9cf5872` and `2026.10.22-869971e`, about 5.5 GB per release pair, and `hello-world`); build cache 12.55 GB, all reclaimable; containers and volumes about 72 MB; `~/acc-backups` holds two dumps (about 0.35 MB each) | **Done (owner-approved scope, 31-Oct-2026):** build cache and `869971e` images removed; `9cf5872` kept as the rollback target; `/` now 48% used (19 GB free) | No |

## 4. Remaining-work register

`R-` items are owner decisions; `W-` items are work that follows a decision or needs people. Only items that genuinely need the owner are marked *Owner*.

| ID | Item | Owner action needed | Who executes | Evidence / reference | Blocker |
|---|---|---|---|---|---|
| R-1 | F.3-1 and F.3-7 evidence | **Decided 31-Oct-2026:** accepted; F.3-1 marked as AI-agent QA-lead confirmation, not human sign-off | — | `DECISIONS.md` §1zc.3 | — |
| R-2 | F.3-5 route | **Done 31-Oct-2026:** X-6 authorized, executed (owner as named operator) and **accepted** | — | `QA_RELEASE_PREPARATION.md` §5i | — |
| R-3 | Release commit for Gate F.3 | **Decided 31-Oct-2026:** `441a29a` is the historical evidence candidate; U8, U10, U1 and the #20/#21/#28/#30 fixes are later merges, not deployed or tested on it. The #22 fix (PR #34) is not merged | — | §1 | — |
| R-4 | I-03 expected result | **Decided 31-Oct-2026:** degraded readiness acceptable only with accurate reporting, healthy liveness for independent operations, and no false dispatch readiness | — | `QA_RELEASE_PREPARATION.md` §5e | — |
| R-5 | Section J set-up | **Decided 31-Oct-2026:** qa-org-a2; the owner operates the platform-admin screen for J-01 while E1 directs; build `441a29a`. **Still needed (owner input):** nominate evaluators E1–E3 and a facilitator (J-D4); the platform administrator creates E1's multi-organization user (J-02) | Owner | `QA_J_EVALUATOR_PACKAGE.md` §2, §7 | Evaluator nominations |
| R-6 | D1, D2, D5 approvals (the recovery copy and the disk clean-up were done on 31-Oct-2026 and do not satisfy D5) | *Infrastructure owner* | Infrastructure owner, operator | §3 | Infrastructure input |
| R-7 | QAF-021 (circuit reset capability) and QAF-004 (recipient in event payloads; privacy), each a product decision | *Owner* | Owner | `QA_FINDINGS_REGISTER.md` | None. Not F.3 blockers unless the owner says so |
| R-8 | Publish the governance record (including `a511949`, the Gate F.2 acceptance) | **Decided 31-Oct-2026:** commit, push and draft PR; no merge | Claude Code | This document | Merge stays an owner decision |
| W-1 | X-6 window | **Done 31-Oct-2026** (accepted). I-01 – I-03 not run; they need their own authorization if the owner requires them for F.3-8 | Operator, Claude Code | §2 | Authorization for I-01 – I-03 |
| W-2 | Section J sessions with three independent evaluators | — | Evaluators, facilitator, operator (accounts) | `QA_J_EVALUATOR_PACKAGE.md` | R-5 |
| W-3 | Outstanding console rows needing the platform administrator, other personas or the operator | — | Testers with those personas | `QA_RELEASE_PREPARATION.md` §5d | Personas (D2, J-D2) |
| W-4 | QAF-007 fresh-cluster drill and QAF-008 restore command | — | Named operator | §3 | D5 (R-6) |
| W-5 | Verify the `develop` fixes for QAF-002/003/018/019 (#20, #21, #28, #30) on QA (each issue stays open until verified). QAF-005 (#22): its fix, PR #34, is not merged | — | Claude Code / testers after an upgrade | `QA_FINDINGS_REGISTER.md` | R-3 |
| W-6 | Issues for QAF-022, QAF-009, QAF-010: **filed 31-Oct-2026** (#47, #48, #49, sanitized). Remaining: disable the stray invited accounts (QAF-012) | — | Operator | `QA_FINDINGS_REGISTER.md` | None |
| W-7 | Complete the Gate F.3 sign-off fields (`QA_RELEASE_PREPARATION.md` §8) | *Owner decision* | Owner | §8 | R-1 – R-6 and W-1 – W-4 as the owner requires |

## 5. Residuals to carry into the F.3 sign-off

- **F.3-2/3:** live multi-worker concurrency unverified (X-4).
- **F.3-4:** live queue-to-claim race not exercised (X-5).
- **F.3-5:** the claim-time race is evidenced by automated tests only; Docker automatic restart of a killed container unverified; one accepted `outcome_unknown` QA message retained.
- **F.3-6:** R-AUD-1 (dispatcher circuit and health transitions not audited, by design); QAF-021 (no supported circuit reset; the original `QA Sim 500` remains open); QAF-022 (the refusal log has no message id).
- **Providers and templates:** simulator-only providers; template approval is simulated (no Meta/WhatsApp approval); synthetic DLT format validation only (from F.2).
- **QA host logs:** API log `--since` reads are unreliable after the 27/28-Oct outage; the current API start line is unreadable.
- **Retained QA data:** `QA Sim 500 F07` (assignment disabled), QA-F-07 test messages and contacts, the D08/D08B suspended tenants and the active D08B administrator.

## 6. Status at final closeout (31-Oct-2026)

| Criterion | Status |
|---|---|
| F.3-1 | Evidence accepted (AI-agent QA-lead confirmation, not human sign-off) |
| F.3-2/3, F.3-4 | Closed by approved automated-only exceptions (residuals carried) |
| F.3-5 | Closed (X-6 accepted) |
| F.3-6 | Closed (QA-F-07 accepted) |
| F.3-7 | Evidence accepted |
| F.3-8 | **Open** (partial: AI evaluation recorded; human, Gemini, persona, operator and J-01/J-02 work outstanding) |
| F.3-9 | **Open** (D1 unverified; D2 and D5 not implemented) |

**Blockers that need the owner or the infrastructure owner (nothing else is waiting on Claude Code):**

| ID | Blocker | What is needed |
|---|---|---|
| B-1 | D5 off-host encrypted backups | The approved **off-host storage target** on company infrastructure (host and path, or bucket) and how the QA host or operator reaches it; the **encryption key custody** (whose public key encrypts, who holds the private key); confirmation of retention (proposed 30 days) and schedule (weekly plus pre-upgrade). The local recovery copy stays until an off-host restore is verified |
| B-2 | D1 IP-restricted access | The approved **network ranges** for 443 and the **named SSH operators** for 22 (recorded outside Git), plus an operator with `sudo` to apply or show the `ufw` rules. The agent has no passwordless `sudo` |
| B-3 | D2 access register | The **accountable person** for the bootstrap administrator and the **register location** (outside Git); approval of the bootstrap-password procedure |
| B-4 | J-01 and platform-admin console rows | An owner-operated platform-admin session with the AI evaluator directing (A-01, A-13, B-01 – B-04, B-13, D-01 – D-08, E-06, J-01) |
| B-5 | J-02, E-09 and other-persona rows | Platform-administrator creation of a multi-organization user and of the `qa-org-a2` ws-manager, team-reader, agent and reader personas, with operator activation (B-07 – B-09, B-11, B-12, C-07, G-05, H-04, H-05) |
| B-6 | Gemini AI evaluation | Run Gemini on `QA_J_EVALUATOR_PACKAGE.md` with the handoff in the AI evaluation record |
| B-7 | Human usability and screen-reader evaluation | Required for the round 1 exit criterion; AI evaluation does not replace it |
| B-8 | PR #51 | An independent review; no CI applies to the stacked PR |

**Recommendation: do NOT accept Gate F.3 yet.**
- **Ready:** F.3-1 to F.3-7 have accepted evidence or approved exceptions. The functional and dispatch-safety criteria are therefore satisfied for the historical candidate `441a29a`.
- **Not ready:**
  - **F.3-9** has no implemented off-host backup (B-1) and no verified network restriction (B-2). These are deployment controls the gate requires; they are not usability items.
  - **F.3-8:** the AI evaluation found two failures on the candidate (J-04, J-06), and the human evaluation required by the QA round 1 exit criterion has not happened.
- **Smallest path to acceptance:**
  1. Close B-1 and B-2, which are mandatory controls.
  2. Then either complete B-4 – B-7, or record an explicit owner exception for F.3-8 accepting AI evaluation in place of human usability and screen-reader sign-off on `441a29a`, with J-04, J-06 and QAF-026 as accepted residuals. Their U10/QAF-018 parts are already fixed on `develop`.

