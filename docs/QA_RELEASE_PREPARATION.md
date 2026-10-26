# QA release preparation (Phase 4.2 / 4.3)

Prepared 24-Oct-2026 from the repository, CI and existing deployment records; updated 26-Oct-2026 with the owner's decision record (§5a) and QA evidence. Evidence is labelled by provenance (§5).

## 1. Release scope and hold

- **Scope:** the internal QA environment only (`qa/INTERNAL_QA_DEPLOYMENT.md`). Not the controlled MVP, not production.
- **Candidate:** a `develop` commit at or after `554dea370e84fd6b25589d9cb63309eaec03c636` with its own green CI run (`554dea3`: run `40067932448`, all five jobs). It adds migrations `0036` and `0037` and all of Phase 4.2 and 4.3 to date.
- **Hold:** this document authorizes nothing. Deploying to QA, applying migrations to the QA database and accessing the QA host each need a separate owner authorization. Gate F.2 acceptance is **pending** and Gate F.3 is **not accepted**.
- **Recorded QA state (Agent-run, 24-Oct-2026):** the owner-authorized upgrade deployed `2026.10.24-441a29a` (commit `441a29a`; application code identical to `554dea3`) at 08:11:30 UTC. The live history was read first (`36|093bfe92208baf0ff073f6b154c00c68`, equal to the committed `0000`–`0035`); `migrate` applied `0036` and `0037`; the proof after was `38|04b0fac738f24476e76b88a84fd04850`. Later `develop` commits up to `6735f72` are documentation only. Re-read the live state before any further upgrade (§6 step 3).

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
| Restore test | A named operator restores a dump into a scratch database and compares row counts (QA-I-04) **before** the next upgrade | Pending operator |

## 5. Gate F.2 / F.3 acceptance matrix

Evidence labels: **Observed** (verifiable in GitHub, CI or the repository); **Agent-run** (executed by Claude Code on QA; evidence package outside Git at `~/acc-evidence/2026-10-26-qa-acceptance/` on the operator workstation, with `MANIFEST.sha256`; not independent verification); **Proposed**; **Approved** (approver and record named); **Blocked**. An automated suite passing never marks a QA-host check as passed.

| # | Item | Automated evidence (Observed) | QA-host evidence | Owner direction (§5a) | Status |
|---|---|---|---|---|---|
| F.2-1 | SMS dispatch: approved template and bound DLT; simulator refuses a channel mismatch | PR #6 (CI `40002661592`); PR #11 | Agent-run 26-Oct-2026 (§5b): QA-K-01, K-02, K-03, K-05 PASS; K-04 documentation mismatch, corrected, observed behaviour meets the corrected expectation. Synthetic DLT IDs test format only | X-1: approved for QA simulator testing | Agent-run PASS; owner review pending. **Not** evidence of DLT registration or regulatory compliance |
| F.2-2 | RCS dispatch: payload re-validation; `rcs_message_types` enforced | PR #7 (CI `40053914870`); PR #11 | Agent-run 26-Oct-2026 (§5b): QA-K-06, K-07, K-08 PASS | X-2: approved for QA simulator testing | Agent-run PASS; owner review pending |
| F.2-3 | Provider assignments panel | API suites above | QA-D-08. Agent-run 24–26-Oct: the operator used the panel to add, disable, enable and re-prioritize assignments (audit log); no screenshots | — | Console screenshots outstanding |
| F.2-4 | Same-channel fallback over eligible providers | PR #7; PR #11 | WhatsApp: Agent-run 26-Oct-2026 QA-F-01 – F-05 PASS (`whatsapp/`, `fallback-f02-f04/`). SMS/RCS: Agent-run 26-Oct-2026 QA-K-05, K-09 PASS (same channel only; eligible providers only, K-08) | X-3: approved for QA simulator testing | Agent-run PASS (WhatsApp, SMS, RCS); owner review pending |
| F.3-1 | Email and voice sends refused (`422 CHANNEL_NOT_SUPPORTED`) | PR #10 | Agent-run 26-Oct-2026 (§5c): QA-K-10, K-11 PASS at API level; database-table no-storage check **VERIFIED (Agent-run, 26-Oct-2026 09:04 UTC)** | T-1: approved in principle; executed on an AI-agent acting-QA-lead decision (§5c), not a human sign-off | Agent-run PASS (API level; database check verified); owner review pending |
| F.3-2/3 | SMS/RCS worker, fencing, recovery, idempotency, isolation | PR #11 | Not practical on the host | X-4: automated-only exception approved in principle | Exception; residual risk: live-host concurrency **not verified** |
| F.3-4 | G-2 recipient re-check at dispatch (migration `0037`) | PR #12: 11 security and 8 integration tests; mutation checks; CI `40066676777` | No supported way to hold a queued message on QA | X-5: automated-only exception approved in principle | Exception; residual risk: the live race window between queueing and claim is not exercised |
| F.3-5 | BE-DISPATCH-02: no resubmission after an expired submission lease | PR #14: 6 tests (5 fail on the pre-fix code); 40/40 repeated runs under load; CI `40066664676` | Planned operator-window variant (QA-I-01 with `QA Sim Timeout` p1, `QA Sim OK` p2). It cannot force the claim-before-recovery path | X-6: approved to plan an operator window | Blocked: operator window not agreed |
| F.3-6 | BE-DISPATCH-01 circuit fix (migration `0036`) | Merged suites | Agent-run 26-Oct-2026: `QA Sim 500` circuit closed → open → half_open → open with no privilege errors (`whatsapp/evidence-run3.txt`, `fallback-f02-f04/`). QA-F-07 scenario not run | X-7: **deferred** | Open. To close: run QA-F-07 under a recorded policy-change decision and operator authorization, or record an explicit exception |
| F.3-7 | Migration history after upgrade | Disposable-clone proof `38\|04b0fac738f24476e76b88a84fd04850` | Agent-run 24-Oct-2026: before `36\|093bfe92…`, after `38\|04b0fac7…` | — | Agent-run PASS; owner review pending |
| F.3-8 | Full regression on the release commit | CI `40067932448` (`554dea3`); docs-only since | Agent-run API checks (sign-in, isolation, WhatsApp C/E/F, masking) and, on 26-Oct-2026, Agent-run console automation of 36 plan rows plus a read-only trace for G-06 (§5d). Platform-admin, other-persona and operator rows, I-01 – I-03 and usability (J) outstanding | Console checklist: proceed | Partial |
| F.3-9 | Deployment controls: exposure, TLS, startup checks, accounts, secrets, backup | — | Agent-run 24-Oct-2026: loopback-only ports, startup principal check, dispatch-credential refusal, health, restart, 0 secret values in logs. TLS, D2 and D5 items open | D1/D2 routed; D5 deferred | Partial; depends on D1, D2, D5 |

Findings from QA testing, with their development issues and dispositions, are tracked in `qa/QA_FINDINGS_REGISTER.md`.

### 5a. Owner decision record (26-Oct-2026)

Recorded from the project owner's direction of 26-Oct-2026. These directions do not replace infrastructure-owner, QA-lead or other designated approvals.

| Item | Owner direction | Conditions |
|---|---|---|
| X-1 SMS | Approved for QA simulator testing | Synthetic data only; fake DLT IDs prove format validation, not registration or regulatory compliance |
| X-2 RCS | Approved for QA simulator testing | Simulator only; verify content validation and capability restrictions |
| X-3 SMS/RCS fallback | Approved for QA simulator testing | Same-channel fallback, eligible providers, attempt records |
| T-1 email/voice | Approved in principle | QA-lead confirmation before execution; prove no message record is stored |
| X-4 worker safety | Automated-only exception approved in principle | Live-host concurrency is not verified |
| X-5 G-2 re-check | Automated-only exception approved in principle | Live race window not exercised; CI `40066676777` |
| X-6 BE-DISPATCH-02 | Approved to plan an operator-supervised window | No service stop without a separately agreed window; the variant does not prove the claim path |
| X-7 provider circuit | Deferred | No acceptance decision |
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
- **Owner resolution needed:** `QA_TEST_PLAN.md` I-03 says "Readiness reports Redis down", and `RELEASE.md` §9 expects "PostgreSQL and Redis up". Confirm that a degraded-but-ready report satisfies I-03.

**Stop and recovery (all steps):**
- If the API is not healthy within 2 minutes: `$C up -d --wait api web`, then collect the logs.
- On any deviation, stop, restore the assignments and record it.
- No simulator configuration change, assignment change or SIGKILL happens before owner approval.

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
| Owner | | |
| Date (DD-MMM-YYYY) | | |
| Release commit and CI run | | |
| Automated evidence accepted (matrix rows) | | |
| QA-host checks passed (matrix rows, results) | | |
| Automated-only exceptions approved | | |
| Unresolved limitations | | |
| Decision | Pending | Not accepted |

Until these fields are completed by an explicit owner decision, Gate F.2 remains pending and Gate F.3 remains not accepted.
