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
| F.2-1 | SMS dispatch: approved template and bound DLT; simulator refuses a channel mismatch | PR #6 (CI `40002661592`); PR #11 | QA-K-01 – K-05 (simulator; synthetic DLT IDs test format only) | X-1: approved for QA simulator testing | Blocked: SMS simulator providers not yet created |
| F.2-2 | RCS dispatch: payload re-validation; `rcs_message_types` enforced | PR #7 (CI `40053914870`); PR #11 | QA-K-06 – K-09 | X-2: approved for QA simulator testing | Blocked: RCS simulator providers not yet created |
| F.2-3 | Provider assignments panel | API suites above | QA-D-08. Agent-run 24–26-Oct: the operator used the panel to add, disable, enable and re-prioritize assignments (audit log); no screenshots | — | Console screenshots outstanding |
| F.2-4 | Same-channel fallback over eligible providers | PR #7; PR #11 | WhatsApp: Agent-run 26-Oct-2026 QA-F-01 – F-05 PASS (`whatsapp/`, `fallback-f02-f04/`). SMS/RCS: QA-K-05, K-09 | X-3: approved for QA simulator testing | WhatsApp agent-run PASS; SMS/RCS blocked as F.2-1/2 |
| F.3-1 | Email and voice sends refused (`422 CHANNEL_NOT_SUPPORTED`) | PR #10 | QA-K-10, K-11 | T-1: approved in principle | Blocked: QA-lead confirmation |
| F.3-2/3 | SMS/RCS worker, fencing, recovery, idempotency, isolation | PR #11 | Not practical on the host | X-4: automated-only exception approved in principle | Exception; residual risk: live-host concurrency **not verified** |
| F.3-4 | G-2 recipient re-check at dispatch (migration `0037`) | PR #12: 11 security and 8 integration tests; mutation checks; CI `40066676777` | No supported way to hold a queued message on QA | X-5: automated-only exception approved in principle | Exception; residual risk: the live race window between queueing and claim is not exercised |
| F.3-5 | BE-DISPATCH-02: no resubmission after an expired submission lease | PR #14: 6 tests (5 fail on the pre-fix code); 40/40 repeated runs under load; CI `40066664676` | Planned operator-window variant (QA-I-01 with `QA Sim Timeout` p1, `QA Sim OK` p2). It cannot force the claim-before-recovery path | X-6: approved to plan an operator window | Blocked: operator window not agreed |
| F.3-6 | BE-DISPATCH-01 circuit fix (migration `0036`) | Merged suites | Agent-run 26-Oct-2026: `QA Sim 500` circuit closed → open → half_open → open with no privilege errors (`whatsapp/evidence-run3.txt`, `fallback-f02-f04/`). QA-F-07 scenario not run | X-7: **deferred** | Open. To close: run QA-F-07 under a recorded policy-change decision and operator authorization, or record an explicit exception |
| F.3-7 | Migration history after upgrade | Disposable-clone proof `38\|04b0fac738f24476e76b88a84fd04850` | Agent-run 24-Oct-2026: before `36\|093bfe92…`, after `38\|04b0fac7…` | — | Agent-run PASS; owner review pending |
| F.3-8 | Full regression on the release commit | CI `40067932448` (`554dea3`); docs-only since | Agent-run API checks (sign-in, isolation, WhatsApp C/E/F, masking). Console sections A–J outstanding | Console checklist: proceed | Partial |
| F.3-9 | Deployment controls: exposure, TLS, startup checks, accounts, secrets, backup | — | Agent-run 24-Oct-2026: loopback-only ports, startup principal check, dispatch-credential refusal, health, restart, 0 secret values in logs. TLS, D2 and D5 items open | D1/D2 routed; D5 deferred | Partial; depends on D1, D2, D5 |

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
