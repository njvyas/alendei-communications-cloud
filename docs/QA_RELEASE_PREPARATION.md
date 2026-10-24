# QA release preparation (Phase 4.2 / 4.3)

Prepared 24-Oct-2026 from the repository, CI and existing deployment records only. Nothing in this document comes from inspecting the QA host or its live database; where it describes the QA environment, it cites the last recorded upgrade (23-Oct-2026, `9cf5872`).

## 1. Release scope and hold

- **Scope:** the internal QA environment only (`qa/INTERNAL_QA_DEPLOYMENT.md`). Not the controlled MVP, not production.
- **Candidate:** a `develop` commit at or after `554dea370e84fd6b25589d9cb63309eaec03c636` with its own green CI run (`554dea3`: run `40067932448`, all five jobs). It adds migrations `0036` and `0037` and all of Phase 4.2 and 4.3 to date.
- **Hold:** this document authorizes nothing. Deploying to QA, applying migrations to the QA database and accessing the QA host each need a separate owner authorization. Gate F.2 acceptance is **pending** and Gate F.3 is **not accepted**.
- **Recorded QA state:** the 23-Oct-2026 upgrade recorded `9cf5872` and `Migrate: 36 verified`. Neither SMS (`fa9a5ed`) nor RCS (`eca81d0`) dispatch is in that commit. The live state must be re-read at the start of the upgrade (§6 step 3); this record is not a substitute.

## 2. D1 — access and TLS

| Item | Position | Status |
|---|---|---|
| Access mode | **Temporary exception:** QA Round 1 may use IP-only HTTPS access, without an internal DNS name | Pending owner record |
| Conditions | (a) the certificate's source is recorded and QA browsers trust it, or an accepted untrusted certificate is recorded as a limitation; (b) inbound 443 only from the internal network/VPN ranges and 22 only from named operators (`qa/INTERNAL_QA_DEPLOYMENT.md` §4); (c) the named SSH operators are confirmed | Pending infrastructure input |
| Exception record | Owner of the exception, date, expiry (end of QA Round 1 unless renewed), and the conditions above, recorded in the release record | Pending |
| Moving to a DNS name | Not a configuration-only change: `NEXT_PUBLIC_API_BASE_URL` is compiled into the console image, so the console must be rebuilt; `CORS_ORIGINS` and `AUTH_JWT_ISSUER` change; existing sessions are expected to end (inferred, not tested). Revisit these before adopting a name | Deferred |

Infrastructure values (addresses, names, ranges, certificate details, operator identities) are recorded outside Git and never in this repository.

## 3. D2 — administrator identity

- The QA platform administrator was created by `bootstrap` from `AUTH_BOOTSTRAP_EMAIL`. Its individual owner is recorded in an **access register outside Git**; no account identifier is written here.
- Confirm that the account is used by that one person only and is not shared (`qa/INTERNAL_QA_DEPLOYMENT.md` §7).
- Re-assigning the administrator after bootstrap is not covered by the runbook (`bootstrap` runs once); it needs an owner-approved procedure.
- `AUTH_BOOTSTRAP_PASSWORD` is used only by the `bootstrap` command. Removing it from `release.env` after bootstrap is to be reviewed and, if approved, done through an approved procedure by an authorized operator. It is not done as part of this preparation.

## 4. D5 — backup and recovery

Every value below is **proposed and pending infrastructure approval**.

| Item | Proposal | Status |
|---|---|---|
| Storage | An approved off-host location; a developer workstation is not one | Pending |
| Access | Restricted to named operators; dump files mode 600 | Pending |
| Retention | 30 days | Proposed |
| Schedule | Weekly while QA is active; additionally before every upgrade and before every QA round | Proposed |
| Encryption | Dumps encrypted at rest (they contain QA account password hashes) | Proposed |
| Restore test | A named operator restores a dump into a scratch database and compares row counts (QA-I-04) **before** the next upgrade | Pending operator |

## 5. Gate F.2 / F.3 acceptance matrix

Automated evidence and QA-host checks are recorded separately. Where an item has no possible or planned QA-host check, acceptance on automated evidence alone is an **exception that needs explicit owner approval**, recorded in the Decision column.

| # | Item | Automated evidence (CI / disposable clones) | QA-host check | Decision |
|---|---|---|---|---|
| F.2-1 | SMS dispatch: approved template and bound DLT; simulator refuses a channel mismatch | PR #6 (CI `40002661592`); PR #11 regression suite | None possible today: QA has no SMS providers, assignments, DLT templates or test case | Pending (automated-only exception) |
| F.2-2 | RCS dispatch: payload re-validation; `rcs_message_types` enforced | PR #7 (CI `40053914870`); PR #11 | None possible today: no RCS data or test case | Pending (automated-only exception) |
| F.2-3 | Provider assignments panel | API covered by the suites above | QA-D-08 | Pending QA run |
| F.2-4 | Same-channel fallback over eligible providers | PR #7; PR #11 | QA-F-01 – F-05 (WhatsApp only) | Pending QA run (WhatsApp); SMS/RCS automated-only exception |
| F.3-1 | Email and voice sends refused (`422 CHANNEL_NOT_SUPPORTED`) | PR #10 | Possible through the API; no test case yet | Pending test case |
| F.3-2/3 | SMS/RCS worker, fencing, recovery, idempotency, isolation | PR #11 | Not practical on the host | Pending (automated-only exception) |
| F.3-4 | G-2 recipient re-check at dispatch (migration `0037`) | PR #12: 11 security and 8 integration tests; mutation checks; CI `40066676777` | No supported way to hold a message in the queue on QA | Pending (automated-only exception) |
| F.3-5 | BE-DISPATCH-02: no resubmission after an expired submission lease | PR #14: 6 tests (5 fail on the pre-fix code); 40/40 repeated worker runs under load; CI `40066664676` | QA-F-08 (ops/automation) | Pending (automated-only exception) |
| F.3-6 | BE-DISPATCH-01 circuit fix (migration `0036`) | Merged suites | QA-F-07 (ops/automation) | Pending (automated-only exception) |
| F.3-7 | Migration history after upgrade | Disposable-clone proof `38\|04b0fac738f24476e76b88a84fd04850` for `0000`–`0037` | Actual QA proof recorded during the authorized upgrade (`RELEASE.md` §6 step 5) | Pending QA run |
| F.3-8 | Full regression on the release commit | CI `40067932448` at `554dea3` | `QA_TEST_PLAN.md` sections A–I, including I-01 – I-05 | Pending QA run |
| F.3-9 | Deployment controls: exposure, TLS, startup checks, accounts, secrets, backup | — | `qa/INTERNAL_QA_DEPLOYMENT.md` §13 checks 1–12 | Pending QA run; depends on D1, D2, D5 |

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
