# QA release preparation (Phase 4.2 / 4.3)

Prepared 24-Oct-2026 from the repository, CI and existing deployment records; updated 26-Oct-2026 with the owner's decision record (§5a) and QA evidence; updated 31-Oct-2026 with the QA-F-07 execution (§5h), the QA-I-04 result (§4) and the Gate F.3 closeout reconciliation (`qa/GATE_F3_CLOSEOUT.md`). Evidence is labelled by provenance (§5).

## 1. Release scope and hold

- **Scope:** the internal QA environment only (`qa/INTERNAL_QA_DEPLOYMENT.md`). Not the controlled MVP, not production.
- **Candidate:** a `develop` commit at or after `554dea370e84fd6b25589d9cb63309eaec03c636` with its own green CI run (`554dea3`: run `40067932448`, all five jobs). It adds migrations `0036` and `0037` and all of Phase 4.2 and 4.3 to date.
- **Gate F.3 evidence candidate (owner decision, 31-Oct-2026; `DECISIONS.md` §1zc.3):** `2026.10.24-441a29a` is the historical F.3 QA evidence candidate. U8, U10, U1 and the fixes for #20, #21, #28 and #30 were merged to `develop` later; they are not deployed to QA and not tested on this candidate.
- **Hold:** this document authorizes nothing. Deploying to QA, applying migrations to the QA database and accessing the QA host each need a separate owner authorization. Gate F.2 is **ACCEPTED** (project owner decision, 30-Oct-2026; §8); Gate F.3 remains **not accepted**.
- **Recorded QA state (Agent-run, 24-Oct-2026):** the owner-authorized upgrade deployed `2026.10.24-441a29a` (commit `441a29a`; application code identical to `554dea3`) at 08:11:30 UTC. The live history was read first (`36|093bfe92208baf0ff073f6b154c00c68`, equal to the committed `0000`–`0035`); `migrate` applied `0036` and `0037`; the proof after was `38|04b0fac738f24476e76b88a84fd04850`. Later `develop` commits up to `6735f72` are documentation only. Re-read the live state before any further upgrade (§6 step 3).
- **QA host outage (Agent-run, 28-Oct-2026):** after an unplanned outage of the QA host between 27-Oct and 28-Oct-2026, the same release `2026.10.24-441a29a` was observed running, with the migration proof unchanged. The outage cause is not known; see §5f. This is not QA acceptance.

## 2. D1 — access and TLS

| Item | Position | Status |
|---|---|---|
| Access mode | **Temporary exception:** QA Round 1 may use IP-only HTTPS access, without an internal DNS name. Observed 24-Oct-2026 (Agent-run): QA serves HTTPS on its address with a certificate from a private QA root CA that QA browsers must trust | Routed for infrastructure-owner approval (owner direction, 26-Oct-2026); **not closed** |
| Conditions | (a) the certificate's source is recorded and QA browsers trust it, or an accepted untrusted certificate is recorded as a limitation; (b) inbound 443 only from the internal network/VPN ranges and 22 only from named operators (`qa/INTERNAL_QA_DEPLOYMENT.md` §4); (c) the named SSH operators are confirmed | Pending infrastructure input |
| Exception record | Owner of the exception, date, expiry (end of QA Round 1 unless renewed), and the conditions above, recorded in the release record | Pending |
| Moving to a DNS name | Not a configuration-only change: `NEXT_PUBLIC_API_BASE_URL` is compiled into the console image, so the console must be rebuilt; `CORS_ORIGINS` and `AUTH_JWT_ISSUER` change; existing sessions are expected to end (inferred, not tested). Revisit these before adopting a name | Deferred |

Infrastructure values (addresses, names, ranges, certificate details, operator identities) are recorded outside Git and never in this repository.

## 3. D2 — administrator identity

- **Status:** routed for approval (owner direction, 26-Oct-2026); **not closed** until the access-register entry and the bootstrap-password procedure are recorded.
- The QA platform administrator was created by `bootstrap` from `AUTH_BOOTSTRAP_EMAIL`; read-only inspection (24-Oct-2026) found exactly one platform administrator, the bootstrap account. Its individual owner is recorded in an **access register outside Git**; no account identifier is written here.
- Confirm that the account is used by that one person only and is not shared (`qa/INTERNAL_QA_DEPLOYMENT.md` §7).
- Re-assigning the administrator after bootstrap is not covered by the runbook (`bootstrap` runs once); it needs an owner-approved procedure.
- `AUTH_BOOTSTRAP_PASSWORD` is used only by the `bootstrap` command. Removing it from `release.env` after bootstrap is to be reviewed and, if approved, done through an approved procedure by an authorized operator. It is not done as part of this preparation.

## 4. D5 — backup and recovery

**Status: DEFERRED** (owner direction, 26-Oct-2026). Every value below is **proposed and pending infrastructure approval**. A full restore test passed on 24-Oct-2026 (Agent-run: 31 tables and 886 rows matched the live database), but the copy is on a developer workstation, which is **not** approved storage and is not evidence for closing D5.

| Item | Proposal | Status |
|---|---|---|
| Storage | An approved off-host location; a developer workstation is not one | Pending |
| Access | Restricted to named operators; dump files mode 600 | Pending |
| Retention | 30 days | Proposed |
| Schedule | Weekly while QA is active; additionally before every upgrade and before every QA round | Proposed |
| Encryption | Dumps encrypted at rest (they contain QA account password hashes) | Proposed |
| Restore test | A named operator restores a dump into a scratch database and compares row counts (QA-I-04) **before** the next upgrade | **QA-I-04 executed 28-Oct-2026 05:38–05:42 UTC (Agent-run, owner-instructed):** fresh dump restored into a scratch database on the live cluster. Row counts equal to the live database (31 tables); migration proof `38\|04b0fac738f24476e76b88a84fd04850`; ACLs and owners identical; RLS policies identical as sets (a query-ordering defect in the drill SQL, corrected in drill proposal v3). Scratch database dropped. The dump (450,756 bytes, SHA-256 `7e22c84f151b2af2be5aa0ce404a9813a0b8b6ce99078e6a91c7655bc05cdf76`) was recorded as retained (mode 600) at 05:41:33 UTC under a relative path. **On 31-Oct-2026 it could not be located on the QA host** (read-only search of the operator's home directory). *Inference, not verified:* it was written relative to a working directory under `/tmp` and was removed when `/tmp` was cleared by the host reboot of 28-Oct-2026 09:37:44 UTC (§5f). The newest dumps on the host are the 23-Oct and 24-Oct pre-upgrade dumps; QA data written since 24-Oct has no backup. Evidence `~/acc-evidence/2026-10-28-qa-i-04/` (manifest `eac3fb37767d7d28119dc7e94f0d23518287fe218cd4e0e773b3aa765151617a`). **Not** the fresh-cluster drill (QAF-007), which remains pending |

## 5. Gate F.2 / F.3 acceptance matrix

Evidence labels: **Observed** (verifiable in GitHub, CI or the repository); **Agent-run** (executed by Claude Code on QA; evidence package outside Git at `~/acc-evidence/2026-10-26-qa-acceptance/` on the operator workstation, with `MANIFEST.sha256`; not independent verification); **Proposed**; **Approved** (approver and record named); **Blocked**. An automated suite passing never marks a QA-host check as passed.

| # | Item | Automated evidence (Observed) | QA-host evidence | Owner direction (§5a) | Status |
|---|---|---|---|---|---|
| F.2-1 | SMS dispatch: approved template and bound DLT; simulator refuses a channel mismatch | PR #6 (CI `40002661592`); PR #11 | Agent-run 26-Oct-2026 (§5b): QA-K-01, K-02, K-03, K-05 PASS; K-04 documentation mismatch, corrected, observed behaviour meets the corrected expectation. Synthetic DLT IDs test format only | X-1: approved for QA simulator testing | **ACCEPTED** (owner decision, 30-Oct-2026; §8). Simulator-only, synthetic DLT format validation |
| F.2-2 | RCS dispatch: payload re-validation; `rcs_message_types` enforced | PR #7 (CI `40053914870`); PR #11 | Agent-run 26-Oct-2026 (§5b): QA-K-06, K-07, K-08 PASS | X-2: approved for QA simulator testing | **ACCEPTED** (owner decision, 30-Oct-2026; §8). Simulator-only |
| F.2-3 | Provider assignments panel | API suites above | QA-D-08. Verified on QA host: S1–S4 passed; S5 passed (picker prefiltering, 409 conflict codes); S6 passed (path containment 404); S7 passed 30-Oct-2026 (runbook v2.5, non-platform admin DOM suppression, API 403 `AUTHZ_SCOPE_DENIED`, Org A2/B2 isolation confirmed; manifest `2c0fbb7c…`) | QA-D-08 (runbook v2.5 accepted) | **ACCEPTED** (owner decision, 30-Oct-2026; §8). Console screenshots captured (§5g) |
| F.2-4 | Same-channel fallback over eligible providers | PR #7; PR #11 | WhatsApp: Agent-run 26-Oct-2026 QA-F-01 – F-05 PASS (`whatsapp/`, `fallback-f02-f04/`). SMS/RCS: Agent-run 26-Oct-2026 QA-K-05, K-09 PASS (same channel only; eligible providers only, K-08) | X-3: approved for QA simulator testing | **ACCEPTED** (owner decision, 30-Oct-2026; §8). Simulator-only |
| F.3-1 | Email and voice sends refused (`422 CHANNEL_NOT_SUPPORTED`) | PR #10 | Agent-run 26-Oct-2026 (§5c): QA-K-10, K-11 PASS at API level; database-table no-storage check **VERIFIED (Agent-run, 26-Oct-2026 09:04 UTC)** | T-1: approved in principle; executed on an AI-agent acting-QA-lead decision (§5c), not a human sign-off | **Evidence accepted** (owner decision, 31-Oct-2026; `DECISIONS.md` §1zc.3). Confirmation was by an AI-agent acting QA lead, **not** an independent human sign-off |
| F.3-2/3 | SMS/RCS worker, fencing, recovery, idempotency, isolation | PR #11 | Not practical on the host | X-4: APPROVED (owner decision, 30-Oct-2026) | Automated-only verification accepted; residual risk: live-host multi-worker concurrency explicitly unverified |
| F.3-4 | G-2 recipient re-check at dispatch (migration `0037`) | PR #12: 11 security and 8 integration tests; mutation checks; CI `40066676777` | No supported way to hold a queued message on QA | X-5: APPROVED (owner decision, 30-Oct-2026) | Automated-only verification accepted; residual risk: live queue-to-claim race window explicitly unverified |
| F.3-5 | BE-DISPATCH-02: no resubmission after an expired submission lease | PR #14: 6 tests (5 fail on the pre-fix code); 40/40 repeated runs under load; CI `40066664676` | Planned operator-window variant (QA-I-01 with `QA Sim Timeout` p1, `QA Sim OK` p2). It cannot force the claim-before-recovery path | X-6: Local preparation only authorized (owner decision, 30-Oct-2026) | Runbook v2.1 and watcher corrected 31-Oct-2026 (`qa/QA_X6_OPERATOR_RUNBOOK.md` §0: database role, UUID run id, header name, provider-state preflight; watcher harness 26/26). Host execution **blocked** pending a separate operator-window authorization |
| F.3-6 | BE-DISPATCH-01 circuit fix (migration `0036`) | Merged suites | **QA-F-07 executed 31-Oct-2026** (Agent-run, owner-authorized; §5h): dedicated `QA Sim 500 F07`, 10 gated messages. Circuit tripped at message 5 (generation 0 → 1, health `offline`); messages 6–10 made 0 provider calls and created 0 attempt rows; 0 SQLSTATE 42501 errors; queue drained; routing restored | X-7: QA-F-07 live test required (30-Oct-2026) → **QA-F-07 ACCEPTED** (owner decision, 31-Oct-2026; `DECISIONS.md` §1zc.2) | **QA-host evidence accepted.** Residuals: R-AUD-1 (dispatcher transitions not audited, by design); C6b corrected count accepted. Gate decision pending |
| F.3-7 | Migration history after upgrade | Disposable-clone proof `38\|04b0fac738f24476e76b88a84fd04850` | Agent-run 24-Oct-2026: before `36\|093bfe92…`, after `38\|04b0fac7…`; re-observed 28-Oct (after the outage), in the QA-I-04 restore and in the 31-Oct preflights | — | **Evidence accepted** (owner decision, 31-Oct-2026) |
| F.3-8 | Full regression on the release commit | CI `40067932448` (`554dea3`); docs-only since | Agent-run API checks (sign-in, isolation, WhatsApp C/E/F, masking) and, on 26-Oct-2026, Agent-run console automation of 36 plan rows plus a read-only trace for G-06 (§5d). Platform-admin, other-persona and operator rows, I-01 – I-03 and usability (J) outstanding. QA still runs `441a29a`; later `develop` code fixes (#20, #21, #28, #30, U8, U10, U1) are not deployed; the #22 fix (PR #34) is not merged and not regression-tested on QA | Console checklist: proceed | Partial. Candidate fixed at `441a29a` (owner decision, 31-Oct-2026); later merges are not part of it |
| F.3-9 | Deployment controls: exposure, TLS, startup checks, accounts, secrets, backup | — | Agent-run 24-Oct-2026: loopback-only ports, startup principal check, dispatch-credential refusal, health, restart, 0 secret values in logs. QA-I-04 scratch restore PASS (28-Oct-2026, §4). TLS, D2 and D5 items open | D1/D2 routed; D5 deferred | Partial; depends on D1, D2, D5 |

Findings from QA testing, with their development issues and dispositions, are tracked in `qa/QA_FINDINGS_REGISTER.md`.

### 5a. Owner decision record (26-Oct-2026)

Recorded from the project owner's direction of 26-Oct-2026. These directions do not replace infrastructure-owner, QA-lead or other designated approvals.

| Item | Owner direction | Conditions |
|---|---|---|
| X-1 SMS | Approved for QA simulator testing | Synthetic data only; fake DLT IDs prove format validation, not registration or regulatory compliance |
| X-2 RCS | Approved for QA simulator testing | Simulator only; verify content validation and capability restrictions |
| X-3 SMS/RCS fallback | Approved for QA simulator testing | Same-channel fallback, eligible providers, attempt records |
| T-1 email/voice | Approved in principle | QA-lead confirmation before execution; prove no message record is stored |
| X-4 worker safety | APPROVED (owner decision, 30-Oct-2026) | Automated-only verification accepted; live multi-worker concurrency explicitly unverified |
| X-5 G-2 re-check | APPROVED (owner decision, 30-Oct-2026) | Automated-only verification accepted; live queue-to-claim race window explicitly unverified |
| X-6 BE-DISPATCH-02 | Local preparation only authorized (owner decision, 30-Oct-2026) | Runbook v2.1 and watcher prepared and corrected locally (31-Oct-2026); no host operations, container restarts or SIGKILL authorized |
| X-7 provider circuit | QA-F-07 live test required (owner decision, 30-Oct-2026); **QA-F-07 ACCEPTED (owner decision, 31-Oct-2026)** | Executed 31-Oct-2026 (§5h); C0–C9 PASS, corrected C6b accepted, routing restoration verified |
| D1 | Record and route for approval | Infrastructure owner approves the exception, expiry, CA trust, network access and SSH operators |
| D2 | Record and route for approval | Accountable owner and bootstrap-password procedure in the authorized access register |
| D5 | Deferred | The workstation copy is not approved storage |
| Console checklist | Proceed | Named testers, screenshots, at least three usability testers |
| P3-D22/P3-D24 | Open | No real WhatsApp provider integration authorized |

### 5b. Phase B results: SMS, RCS and fallback (26-Oct-2026)

**Agent-run** (executed by Claude Code; not independent verification) on `2026.10.24-441a29a`, 06:35–06:40 UTC. Organization *QA Org A2*, persona `qa-org-a2-admin`, through the API, simulator providers only, synthetic recipients `+1 202 555 03xx`. Evidence: `~/acc-evidence/2026-10-26-qa-acceptance/phase-b/` on the operator workstation, listed in `MANIFEST.sha256` (manifest SHA-256 `33c763d59bd49632e0dc7b45bdcb74054b36b2e371b89cd8c223379616ebc1bd`); not copied into Git.

| Test | Result | Evidence file |
|---|---|---|
| QA-K-01 SMS template send (server-rendered text, template DLT stored) | PASS | `01-run-k01-k07-k09.txt`, `02-run-k01-recheck-k04.txt` |
| QA-K-02 SMS without template refused | PASS | `01-…` |
| QA-K-03 text override and missing variable refused; nothing stored | PASS | `01-…` |
| QA-K-04 invalid DLT never approved | **Documentation mismatch, corrected.** The previous expected result (refusal at approval) did not match. Observed: refused at creation (`400 VALIDATION_FAILED`, `dlt.entityId`); approval without DLT refused (`422 SMS_DLT_METADATA_REQUIRED`). Meets the corrected expectation | `02-…` |
| QA-K-05 SMS fallback, SMS providers only | PASS | `01-…` |
| QA-K-06 RCS text send | PASS | `01-…` |
| QA-K-07 unsafe URL and unknown field refused; nothing stored | PASS | `01-…` |
| QA-K-08 `rcs_message_types` restriction (no attempt) | PASS | `03-…`, `04-run-k08.txt`, `04-k08-logs-events.txt` |
| QA-K-09 RCS fallback, RCS providers only | PASS | `01-…` |
| QA-K-10, K-11 email/voice refusal (T-1) | Run later the same day: see §5c | — |

- **Record counts:** Org A2's messages went from 24 to 30, exactly the six accepted or failed test sends; no refusal stored a record. The queue is empty, and no API error-level log was recorded from 06:30 UTC.
- **Configuration:** before and after states, with the operator's audit trail, are in `00-config-before.txt`, `00-audit-setup.txt` and `05-config-after.txt`. An operator slip (two WhatsApp assignments enabled at 06:32) was reversed by the operator at 06:39. Final Org A2 state: SMS `QA SMS 500` p1, `QA SMS OK` p2; RCS `QA RCS 500` p1, `QA RCS OK` p2, `QA RCS Text Only` p3 disabled; WhatsApp `QA Sim 500` p1, `QA Sim OK` p2, others disabled.
- **Synthetic DLT limitation:** the DLT identifiers are fabricated numeric strings. They show format validation only, not DLT registration or TRAI compliance.

### 5c. T-1 decision and QA-K-10 / QA-K-11 results (26-Oct-2026)

- **Decision author:** Claude Code (AI agent), acting in the QA-lead role assigned by the project owner for this task. **This is AI-agent authorization, not a human QA-lead sign-off.** The owner may require a human countersignature when reviewing Gate F.3.
- **Basis:**
  - The owner's direction in §5a (T-1 approved in principle, subject to QA-lead confirmation).
  - No individual QA lead is named in any ACC document, so the condition was an unfilled role, not an operational prerequisite. K-10 and K-11 need no operator, configuration, provider or service change.
- **Decision:** the existing owner authorization, together with the acting-QA-lead assignment, is sufficient to run QA-K-10 and QA-K-11 on QA. It was taken immediately before the run and recorded immediately after.
- **Scope:** QA only, *QA Org A2*, `qa-org-a2-admin`, two API sends with synthetic recipients. No configuration change; no production access.

| Test | Result | Evidence |
|---|---|---|
| QA-K-10 email | **PASS at API level**: `422 CHANNEL_NOT_SUPPORTED` ("Channel 'email' does not support sending messages"); no message ID returned | `t1/01-run-k10-k11.txt` |
| QA-K-11 voice | **PASS at API level**: `422 CHANNEL_NOT_SUPPORTED` ("Channel 'voice' does not support sending messages"); no message ID returned | `t1/01-run-k10-k11.txt` |
| No record stored | API level: organization-scoped message list 30 before and 30 after; email 0 → 0; voice 0 → 0. **Database check: VERIFIED (Agent-run, 26-Oct-2026 09:04 UTC)**: read-only database check: Org A2 total 30 (unchanged); Org A2 email/voice 0/0; email/voice across all organizations 0; `messages` and `message_events` rows created in the test window (08:52:30–08:53:30 UTC) 0; dispatch queue 0 | `t1/01-run-k10-k11.txt`, `t1/02-db-check.txt` |

Authorization record: `t1/00-decision-record.md`. Evidence location as §5b; the manifest was regenerated after this run (manifest SHA-256 `d70c8ffb1682b4192e80623dc3372d3d0cd3332b532b2dbe85abb2f945c3ffe4`, 44 files). The hash quoted in §5b identifies the earlier file set. After the database check the manifest was regenerated again; its hash, as reported by the agent, is `15b9ccac…021277a` (45 files). This record does not independently verify the evidence file or its checksum.

### 5d. Console checks by browser automation (26-Oct-2026)

- **Who ran them:** **Agent-run** by Claude Code, assigned QA lead and test executor, using headless Chromium (Playwright) against the QA console. This is not independent verification, and it is not human testing. Gemini is assigned as independent reviewer.
- **Release, personas and data:** `2026.10.24-441a29a`; `qa-org-a2-admin` and `qa-org-b2-admin` only; synthetic data.
- **Credentials:** read from owner-filled mode-600 files and never logged. An API key secret used for H-07 was held in memory and a temporary mode-600 file only, then deleted.
- **TLS:** the browser skipped CA trust (private QA CA); the server key was pinned before each run.
- **Evidence:** `console/` in the evidence package (`MANIFEST.sha256`); per-row results are in the `QA_TEST_PLAN.md` Actual column.

| Result | Plan rows |
|---|---|
| PASS | A-02, A-03, A-04, A-11, A-12, B-05, B-06, B-10, B-14, C-01 – C-06, C-08, C-10, D-09, E-01 – E-05, E-07, E-08, E-09 (masking, filters, pagination, detail), F-01 (console), G-01 – G-04, G-06, H-01, H-02, H-07, H-08, H-09 |
| BLOCKED | E-09 organization switch: no multi-organization persona available to the agent |
| Not run (needs another role) | Platform administrator: A-01, A-13, B-01 – B-04, B-13, D-01 – D-08, E-06. Other personas: B-07 – B-09, B-11, B-12, C-07, G-05, H-04, H-05. Operator: A-05 – A-10, I-01 – I-05 |
| Not run (human only) | Section J usability (at least three testers) |
| New findings | QAF-018 (#28), QAF-019 (#30) (`QA_FINDINGS_REGISTER.md`) |

- **Counting:**
  - **Rows:** 36 plan rows were run by browser automation (E-09 included, with its organization-switch sub-check BLOCKED). G-06 was a read-only database and log trace. F-02 – F-05 were API runs (§5).
  - **Sub-checks:** several rows hold more than one sub-check (for example E-09 five, E-01, C-10, D-09 and H-02 two each), so the run recorded **44 granular PASS sub-checks**, 1 BLOCKED sub-check and 1 observed finding (QAF-018). An earlier statement of "38 plan rows" in this PR was a miscount and is corrected here.
- **H-07 evidence:**
  - **What is evidenced:** the one-time display of the API-key secret rests on API and DOM evidence. The secret was present in the creation dialog and absent from the later list and detail views.
  - **What is not:** no screenshot of the secret dialog exists; it was deliberately not captured. The H-07 and H-08 screenshots are byte-identical (same SHA-256) post-revocation list views and do not show the secret display.
  - **If a visual record is required:** it needs an owner-approved procedure that never records a live secret.

### 5e. Operator-supervised session procedure (draft; nothing here is authorized)

Covers X-6 and QA-I-01 – I-03. It runs only after the project owner approves this exact procedure and a window, with an authorized QA operator present. Host commands use `$C` as in `qa/INTERNAL_QA_DEPLOYMENT.md`. Claude sends test messages through the API and records read-only state; the operator runs host and console actions.

**Before the session (Claude, read-only):** image tag, `/health/ready`, Org A2/B2 assignments, circuit states, queue (0), message counts, and PostgreSQL sessions and locks:
- `pg_stat_activity` for the `acc` database (state, `xact_start`);
- `pg_locks`, ungranted and advisory.

**X-6: crash recovery of an in-flight submission**

- **Scope:**
  - **What it shows:** general crash and lease recovery by the expired-lease sweeper (`recoverExpiredLeases`). An abandoned submission is settled `outcome_unknown` and **never resubmitted**.
  - **What it does not show:** the BE-DISPATCH-02 claim-time race fix (a claim landing before the sweep). The evidence for that fix remains the automated suite: `apps/api/test/be-dispatch-02-expired-submission.int-spec.ts`, 6 tests, 5 failing on the pre-fix code, CI `40066664676`.
- **Why a graceful stop does not meet this objective:** shutdown waits for the dispatch cycle in progress (`dispatch.worker.ts`, `onModuleDestroy`), so an in-flight submission finishes (here as a timeout) and no lease is abandoned. A graceful stop is tested by I-01. Only a hard interruption (`$C kill api`, SIGKILL) leaves a lease for the sweeper. **SIGKILL needs explicit owner approval.**
- **In-flight window:** bounded by the fixed provider submission timeout of 3 s (`PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS`), which is not configurable per environment. A longer simulated request would need a code or configuration change, not proposed for this release.
- **Removing the timing dependence:** the kill is triggered by an operator-run **watcher**, not by hand. The watcher polls PostgreSQL read-only every 100 ms for the X-6 message (Org A2, recipient `+12025550186`, created after the watcher starts) reaching status `submitting`, then issues `$C kill api`. If nothing reaches `submitting` within 10 s, it stops without killing.
- **Preconditions:**
  - owner approval of the procedure, SIGKILL and the assignment change;
  - no other Org A2 traffic;
  - queue 0.
  - **Assignment change (operator, console, Org A2 WhatsApp):** `QA Sim 500` priority 1 → 10, disabled; `QA Sim Timeout` priority 3 → 1, enabled; `QA Sim OK` p2 active. Claude verifies read-only.
- **Steps:**
  1. Operator starts the watcher.
  2. Claude sends one message to `+12025550186` (record T0 and the message ID).
  3. The watcher kills the API at T1 (status `submitting` observed).
  4. Operator runs `$C up -d --wait api`.
- **Expected:**
  - the API is healthy;
  - within the 30 s lease plus one poll, the log shows `recovered expired dispatch leases`;
  - the message is `outcome_unknown` with **exactly one attempt** (`QA Sim Timeout`) and no attempt on `QA Sim OK`;
  - queue 0.
- **Post-restart checks:**
  - `/health/ready`, message, attempts, events, queue;
  - `pg_stat_activity`: no `idle in transaction` dispatch sessions;
  - `pg_locks`: no ungranted locks, and no advisory locks held by sessions that no longer exist.
- **Fail rule:** if the message is not final within 90 s of restart, record **FAIL**. Never edit the database.
- **Clean-up (operator):** `QA Sim Timeout` disabled, priority 1 → 3; `QA Sim 500` priority 10 → 1, enabled. Claude verifies read-only.

**I-01: graceful API restart during a send**
- **Steps:** Claude sends one message from Org B2 (`QA Sim OK`); the operator runs `$C stop api && $C up -d --wait api`.
- **Expected log:** `SIGTERM received — shutting down`, then `Shutdown complete`. **Not** `Graceful shutdown exceeded … forcing exit` or `Shutdown failed`.
- **Expected outcome:**
  - the message reaches a documented terminal state (`accepted`, `failed` or `outcome_unknown`; `RELEASE.md` §7, ADR-014 D16), never stuck;
  - queue 0;
  - API healthy;
  - the same PostgreSQL session and lock checks as X-6.

**I-02: console restart**
- **Steps:** `$C restart web` with a signed-in console session.
- **Expected:** the console works after reload.

**I-03: Redis outage**
- **Steps:** `$C stop redis`, observe, then `$C start redis`.
- **Expected, per the documented contract:**
  - Rate limiters fail open, logged at `warn` (`API.md` §5c "Both limiters fail open"; `SECURITY.md`, "General rate limiting"). Sessions are in PostgreSQL. So sign-in and authenticated reads should continue during the outage, with `warn` logs.
  - Readiness: `redis.health.ts` deliberately does **not** fail readiness. It reports Redis `ping: "unavailable"`, `degraded: true`, with overall status `ok`. After `start redis` it reports `ping: "PONG"`.
- **Owner decision (31-Oct-2026; `DECISIONS.md` §1zc.3):** a degraded-but-ready report satisfies I-03 **only if** (1) the degradation is reported accurately, (2) liveness stays healthy for operations independent of Redis, and (3) dispatch readiness is not falsely reported. Otherwise I-03 fails.

**Stop and recovery (all steps):**
- If the API is not healthy within 2 minutes: `$C up -d --wait api web`, then collect the logs.
- On any deviation, stop, restore the assignments and record it.
- No simulator configuration change, assignment change or SIGKILL happens before owner approval.

### 5f. QA host outage and recovery (27–28-Oct-2026)

**Agent-run** (executed by Claude Code; not independent verification), read-only, on 28-Oct-2026 between 04:38 and 04:52 UTC. Evidence packages on the operator workstation, outside Git: `~/acc-evidence/2026-10-28-qa-recovery-preflight/` (manifest SHA-256 `3be402b82aba03d91d4b9bd253af4b8e2dfa181ec1acced97ccb6af0c6341286`) and `~/acc-evidence/2026-10-28-qa-api-log-inspection/` (manifest SHA-256 `d680870270c28275c17a1c2ad631d71887c8fd2b26039c4eb07c730f81eabab6`). Each statement below is marked as an *observation* (seen in command output saved in those packages), an *inference* or a *hypothesis*. The cause of the outage is **not known**.

**Timeline (UTC)**

| Time | Event | Basis |
|---|---|---|
| 27-Oct 05:19:42 | Last API container log entry before the outage | Observation: container log, forward read |
| 27-Oct 05:19:58 | Last host journal entry of the previous boot; no shutdown record in `last -x` | Observation |
| Between 27-Oct 05:19:58 and 28-Oct 04:35:05 | The host stopped at a time that was not recorded. The missing shutdown record and the PostgreSQL recovery below support an unclean stop; they do not establish when it happened | Inference |
| 28-Oct 04:35:05 | Host boot (first journal entry) | Observation |
| 28-Oct 04:35:12 | All four containers start (`restart: unless-stopped`); 0 container restarts | Observation: `docker inspect` |
| 28-Oct 04:35:14.60–14.68 | PostgreSQL: "database system was not properly shut down; automatic recovery in progress"; redo `0/28A4480`–`0/28A4550`; end-of-recovery checkpoint complete; ready to accept connections | Observation: PostgreSQL container log |
| 28-Oct 04:35:21.70 | API: `Database principals verified RLS-bound: acc_app, acc_auth, acc_dispatch`, `message dispatch started`, `Nest application successfully started` | Observation: API container log, bounded tail read (see *Log reading*) |

PostgreSQL also logged "last known up at 2026-10-26 11:49:55 UTC". *Interpretation:* this is the time of the last checkpoint record before the stop, not a measured outage time; it is not used in the timeline.

**State observed after recovery (28-Oct, 04:42–04:43 UTC, on the host)**

- **Containers:** all four `running (healthy)`; api and web run image tag `2026.10.24-441a29a` with revision label `441a29ad…`. That the image IDs equal those deployed on 24-Oct is *agent-reported* from the agent's 24-Oct session record; the evidence packages do not contain that comparison.
- **Readiness:** loopback `/health/ready` returned 200 with `"status":"ok"` (PostgreSQL up, Redis `PONG`); the loopback console `/login` returned 200.
- **Migration proof:** `38|04b0fac738f24476e76b88a84fd04850`, equal to the 24-Oct proof (§1, §6 step 5).
- **Dispatch state** (read-only queries): queue 0; no message `queued` or `submitting`; no attempt in `submitting`.
- **Roles:** the four `acc_*` roles can log in; none is superuser or bypasses RLS.
- **API severity since boot:** 0 error-level entries and 2 warning-level entries, both the agent's own unauthenticated probe requests (`GET /api/v1/health/ready` and `GET /api/v1/auth/me`).

**Log reading after the outage**

- *Observations:*
  - The API container logs through Docker's `json-file` driver with no configured size or rotation options. No `/etc/docker/daemon.json` and no logrotate rule for Docker were found, and the inspections did not identify any rotated segments. The log file itself (size, permissions, content) could not be read: `sudo` required a password that was not available to the agent.
  - Forward reads (full, or `--since`) stop silently at 27-Oct 05:19:42 and return no post-boot entries.
  - Backward reads (`--tail` up to 277 entries at 04:51 UTC) return the post-boot range starting at 04:35:21.70, including the startup lines in the timeline. Larger tails return only pre-outage entries.
- *Hypothesis (not verified):* the unclean stop left a partial record at the end of the pre-outage log data, and the Docker log reader stops there. The cause of the discontinuity remains **unexplained**.
- *Consequence for later checks:* until this is resolved, post-outage log checks on this container must use a bounded `--tail`; `--since` under-reports.

**Later observation (31-Oct-2026, read-only):** the host booted again on **28-Oct-2026 at 09:37:44 UTC** (`uptime -s`); all containers started at 09:37:55, which matches every container start time observed since. This second boot was not recorded at the time and its cause is **not known**. It cleared `/tmp`, which explains why `/tmp/.no` was absent on 31-Oct and, by inference, the loss of the QA-I-04 dump (§4).

**Agent actions on the host (disclosure)**

- A stderr redirect in an agent command **unintentionally created** an empty file `/tmp/.no` (0 bytes) on the QA host at 28-Oct 04:50:51 UTC. Removal was approved on 31-Oct-2026 subject to confirming the exact file; it was **already absent** (`/tmp` cleared by the 09:37 boot), so nothing was removed.
- One read-only query named a column that does not exist (`suppressions.lifted_at`). It is the only PostgreSQL `ERROR` logged since boot (04:42:54 UTC) and changed nothing.

**Remaining constraints**

- **Disk:** `/` is 86% used with 5.1 GB free; Docker reports 9.7 GB of reclaimable images and 12.5 GB of build cache. No clean-up has been done; it needs owner authorization.
- **Backups:** the newest dump on the host is from 24-Oct (before `441a29a`) and predates the 26-Oct test activity. Approved storage is undecided (D5 deferred, §4).
- **Pending, unchanged by the recovery:** QA-I-04 (executed later the same day, 05:38 UTC; §4), the D5 fresh-cluster restore drill, QAF-007 (#23), QAF-008 and the operator session (§5e). Functional QA results recorded before 27-Oct were not re-run.

**This record documents the recovery of the QA environment only. It is not QA acceptance:** Gate F.2 and Gate F.3 remain **NOT ACCEPTED**, and no finding, decision or test result changes because of it.

### 5g. Gate F.2 closeout and QA-D-08 S1–S7 reconciliation (30-Oct-2026)

- **Owner decision:** Gate F.2 (Phase 4.2 — Provider Adapters & Eligibility) is formally **ACCEPTED** (30-Oct-2026; §8). Gate F.3 remains **NOT ACCEPTED**. Phase 5 remains **NOT AUTHORIZED**.
- **QA-D-08 execution on QA host:**
  - S1–S4: Seeded assignments, priority reordering, and enable/disable persistence across browser reloads verified.
  - S5: Picker prefiltering and backend 409 conflict codes (`PROVIDER_ASSIGNMENT_CONFLICT`, `ASSIGNMENT_PRIORITY_CONFLICT`) verified; follow-up screenshots captured.
  - S6: Path containment verified (cross-tenant assignment reads return 404 `PROVIDER_ASSIGNMENT_NOT_FOUND`).
  - S7: Verified 30-Oct-2026 under runbook v2.5 (`d08-client-v2.5.sh`). Non-platform administrator signed into disposable tenant D08B (`qa-disposable-d08b`) has the Provider Assignments panel completely suppressed in DOM; direct API calls return 403 `AUTHZ_SCOPE_DENIED`. Org A2/B2 isolation unchanged. Evidence in `~/acc-evidence/2026-10-30-qa-d-08-s7/` (manifest SHA-256 `2c0fbb7c6f6525da17a4d5c3912102a7a50953d38a89831f9130fd5d8728b59e`).
- **Accepted scope boundaries:**
  - Simulator-only providers (SMS, RCS, WhatsApp): no real third-party vendor credentials, endpoints, or carrier networks are authorized or exercised.
  - Synthetic DLT format validation (X-1): DLT entity and template IDs are synthetically generated and validated for structure/presence; does not prove telecom registration or regulatory compliance.
  - Fallback is strictly provider-to-provider within the same channel; cross-channel fallback remains deferred to Phase 5.
- **Documented environmental residuals:**
  - **Retained active D08B administrator:** Organization `QA Disposable D08B` (`01a18d2a-17de-7ebe-8048-895a9ed4ba19`) was suspended at C-3 (`cleanup/C-3-suspended.png`). Its administrator `qa-disposable-d08b-admin@example.test` (`01a18d2c-740b-74f2-828b-92317c9653cb`) is retained active because the product prohibits disabling the last active administrator of an organization (HTTP 409 `AUTHZ_LAST_ORGANIZATION_ADMIN`, `cleanup/C-2-disable-refused.png`). The tenant is suspended, password file was wiped (`shred -u` at C-6), and non-platform access is rejected across all endpoints per ADR-012 F-1.
  - **Unattributed failed login audit events:** The S7 audit set difference recorded 35 new rows, of which 33 were attributed to verified test operations and exactly 2 recorded `action = 'auth.login.failed'` with `actor_id = NULL`. Anonymous login failure records do not capture an actor ID; zero baseline rows were lost and zero rows reference Org A2/B2/C.

### 5h. QA-F-07 provider circuit breaker: execution and acceptance (31-Oct-2026)

**Agent-run** (executed by Claude Code under explicit owner authorization; not independent verification). Gemini performed an independent review of the procedure (ACCEPT WITH SPECIFIC CORRECTIONS, incorporated as v2.2.3). Procedure: `qa/QA_F07_TEST_PROCEDURE.md` (v2.2.3); driver: `scripts/qa/f07-v223.sh`. Owner decisions: `DECISIONS.md` §1zc.2.

**Preparation (all on release `2026.10.24-441a29a`, migration proof `38|04b0fac738f24476e76b88a84fd04850`)**

- **Procedure:** v2.1 was corrected before any message was sent (see `DECISIONS.md` §1zc.2 for the defects).
- **Dedicated provider:** the original `QA Sim 500` circuit was `open` (generation 9) since 26-Oct and the application has no supported reset, so the test used `QA Sim 500 F07` (`01a19087-ddf5-79bc-97ab-6e2cc4c535fc`, created through the API by the owner; `closed`, generation 0).
- **Template:** `qa_f07_circuit_test` (`01a1907a-e323-740e-9fc1-15ca1d1d01a8`), simulator-approved only.
- **Temporary routing:** qa-org-a2 WhatsApp routed to the F07 assignment `01a19087-df30-7a0b-baee-55472c150a5a` only; the original `QA Sim 500` (priority 1) and `QA Sim OK` (priority 2) assignments disabled for the window.
- **Final preflight:** P1–P11 PASS, including the sole-active (P4c) and exact-template (P8b) gates (`preflight-20261031T060240Z`).

**Execution**

- **Run:** `edb1bc78-9b97-4b02-8c29-b074f3cef2e5`, 31-Oct-2026 06:08:01–06:08:18 UTC.
- **Submission:** one message at a time, each terminal before the next. This defeats the concurrent batch processing in `dispatchBatch`.

| Criterion | Result |
|---|---|
| C0 timing (60 s window, 30 s cooldown) | PASS (messages 1–5 in about 4.5 s; message 10 settled 5.1 s after the trip) |
| C1 sequence 1–10 | PASS |
| C2 messages 1–5: one failed attempt each on the provider (`PROVIDER_ERROR: Simulated provider server error`) | PASS |
| C3 circuit `closed` → `open`, generation 0 → 1, health `offline` (06:08:10.757) | PASS |
| C4a / C4b SQLSTATE 42501 / `insufficient_privilege` in PostgreSQL and API logs (both logs proven to cover the window) | PASS (0 / 0) |
| C5 messages 6–10: 0 attempt rows, `NO_ELIGIBLE_PROVIDER`, refusal event | PASS |
| C6 exactly 5 provider attempt rows in the window, all from the run | PASS |
| C6b refusal-log corroboration | 0 as scripted (driver filter defect: the warning carries `providerId`, not `messageId`); corrected provider-and-time count **5**, one per message 6–10. **Accepted by the owner** |
| C6c executor admission refusals | PASS (0) |
| C7 all 10 `failed`, none `outcome_unknown` | PASS |
| C8 queue drained | PASS |
| C9 sole-active routing throughout the window | PASS |
| C3b `provider.circuit_changed` audit rows (informational) | 0, by design (R-AUD-1) |
| C3c dispatcher trip log line (informational) | 1 |

**Zero provider calls for messages 6–10, confirmed against the implementation:**
- the dispatcher returns on circuit refusal (`dispatcher.service.ts:516–522`), before the only attempt insert (`:546`) and the executor call (`:594`);
- adapters are reachable only through `GuardedProviderAdapter.send()` with an admission-minted permit (`circuit-admission.ts`, ADR-015 R-13);
- the only other executor caller is provider test-send, and the preflight required zero test-sends.

**Restoration (mandatory, done):**
- **What the owner ran (06:11:53–54 UTC):** re-enabled the original `QA Sim 500` and `QA Sim OK` assignments; disabled the F07 assignment.
- **Checked afterwards:** `routing-check` reported every qa-org-a2 WhatsApp assignment RESTORED. Messages increased by exactly 10 (47 → 57). Other providers, capabilities and the circuit policy are unchanged (fingerprints equal to the pre-setup baseline).

**Owner decision (31-Oct-2026): QA-F-07 ACCEPTED** (C0–C9 PASS, corrected C6b accepted, routing restoration verified). Gate F.3 remains **NOT ACCEPTED**.

**Residuals**

- **R-AUD-1:** system-dispatcher circuit and health transitions are intentionally not written to `audit_logs` (HIGH-6 privilege design). Metrics and a warning log line are still emitted. Informational.
- **No supported circuit reset:** the original `QA Sim 500` circuit remains `open` (generation 9) and can only close through two successful half-open probes, which it cannot produce. Recorded as finding QAF-021.
- **Correlation:** the dispatcher's circuit-refusal warning carries no `messageId`, which makes message-level log correlation impossible. Recorded as finding QAF-022.
- **Retained QA data:**
  - `QA Sim 500 F07` stays active (circuit `open`, generation 1, `offline`) with its assignment disabled;
  - 10 failed test messages and 10 synthetic contacts in qa-org-a2;
  - the template stays simulator-approved.
- **Earlier residuals:** API `--since` log reads remain unreliable (the run used the `--tail` fallback); the current API start line is unreadable.

**Evidence** (outside Git, `~/acc-evidence/2026-10-31-qa-f07/`):
- `MANIFEST-run-and-restore.sha256`: `4dcc09961fc0dbfc95a3880abd1c3d293649799a585833d6e20ba24cc6a5495e`
- `MANIFEST-v2.2.3-final.sha256` (procedure and final preflight): `2940fe7181bf2a4a72b905cd518b989d7e7127875da4028109cd155a3764e469`
- `MANIFEST-remediation3.sha256` (provider set-up and routing): `279398a98fc3c3845cabda68e4cef8ddd0efcbf8af43ec5ebb96c62d5d444af9`

## 6. Upgrade sequence

Run only within an authorized QA upgrade window. Steps 3–5 follow `RELEASE.md` §6.

1. **Release commit:** confirm the commit and its green CI run; build and record both image IDs (`RELEASE.md` §5.1).
2. **Backup and restore:** take the pre-upgrade dump, copy it to the approved off-host location (§4), and confirm it restores.
3. **Actual QA state:** record the running image tag and the current migration history (`RELEASE.md` §5.2 query). Do not assume 36 entries; the recorded count decides what the upgrade applies.
4. **Migrations before code:** `$C run --rm migrate` with the new `ACC_VERSION`, before `api` and `web` are started on the new version. The new dispatcher calls `app_dispatch_recipient_block()` from `0037` and cannot claim messages without it.
5. **History proof:** compare the actual proof with `38|04b0fac738f24476e76b88a84fd04850` (for `0000`–`0037`). On any difference, stop and do not start the new application.
6. **Start and accept:** `$C up -d --wait api web`; run `RELEASE.md` §9 and `qa/INTERNAL_QA_DEPLOYMENT.md` §13.
7. **Record:** commit, CI run, image IDs, backup location reference and checksum, the before and after history results, and every check's outcome, in the release record.

## 7. Rollback

- **No migration applied:** an application-only rollback (previous `ACC_VERSION`) is safe.
- **After any migration:** do **not** assume an application-only rollback is safe. Use the approved restore procedure (`RELEASE.md` §7): stop `api` and `web`, restore the pre-upgrade dump, then start the previous version. Data written after the dump is lost.
- `0037` can also be dropped manually after reverting the dispatcher (`DECISIONS.md` §1za); restoring the dump remains the default.

## 8. Final sign-off

Gate F.2 is decided before Gate F.3. Each sign-off records:

| Field | Gate F.2 | Gate F.3 |
|---|---|---|
| Owner | Project Owner | |
| Date (DD-MMM-YYYY) | 30-Oct-2026 | |
| Release commit and CI run | `441a29a` (CI `40053914870`, `40067932448`) | |
| Automated evidence accepted (matrix rows) | F.2-1, F.2-2, F.2-3, F.2-4 (PR #6, PR #7, PR #11) | |
| QA-host checks passed (matrix rows, results) | F.2-1 (QA-K-01..K-05 PASS), F.2-2 (QA-K-06..K-08 PASS), F.2-3 (QA-D-08 S1–S7 PASS), F.2-4 (QA-F-01..F-05, QA-K-05, QA-K-09 PASS) | |
| Automated-only exceptions approved | None (all Gate F.2 items possess verified QA-host evidence) | |
| Unresolved limitations | Simulator-only providers (X-1, X-2, X-3); synthetic DLT formatting validation only (X-1); retained suspended disposable tenants D08 and D08B with D08B active admin residual | |
| Decision | **ACCEPTED** | Not accepted |

Gate F.2 was accepted by project owner decision on 30-Oct-2026. Gate F.3 remains not accepted until its sign-off fields are completed by a separate owner decision.
