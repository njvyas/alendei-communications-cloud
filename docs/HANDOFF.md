# Continuation handoff — ADR-015 remediation gate

**Updated:** 09-Oct-2026 (first captured 08-Oct-2026). **Status: final consolidated validation complete and accepted; the ADR-015 remediation gate remains OPEN.** This file is a pointer and evidence index for the next session. It records state; it decides nothing. The authoritative records are `DECISIONS.md` §1o (ADR-015), `TESTING.md` §6q, `SECURITY.md` §4b, `RBAC.md` §7–§8b and `PROVIDER_ADAPTER.md` §6h; where this file and those differ, those win.

Naming: **Gate C** (Phase 1C acceptance, `ROADMAP.md` §4d) was APPROVED / CLOSED on 02-Oct-2026 and is not reopened. The gate still open is the **ADR-015 pre-Phase-3 remediation gate**.

## 1. Current phase and gate

- Phase: **pre-Phase-3 foundation remediation (ADR-015)**. Every mandatory item (steps 1–6) and the follow-up items 2, 4 and 5 are implemented locally, uncommitted, and validated on a final candidate (§4). **Outstanding before the gate decision:** commit and push authorization, a green CI run on the pushed commit, and the user's gate decision.
- **Phase 3.1 has NOT started and is NOT authorized.** Item 6 has not started.
- HIGH-6 and MEDIUM-7 remain deferred to immediately before the dispatcher increment (R-15); other MEDIUM/LOW findings are deferred, not designed.

## 2. Repository state

| Item | Value |
|---|---|
| Branch | `develop` |
| HEAD | `c8114b3d4d7cf06631d4e24b49fca20a1d81e9d3` (unchanged since 08-Oct-2026) |
| `origin/develop` | `6d4b178` — local is **33 ahead, 0 behind**; nothing pushed |
| Working tree | 41 modified tracked files and 12 untracked files (items 2, 4, 5, the dependency remediation, the documentation); nothing staged; `git diff --check` clean |
| `main` | untouched |
| `stash@{0}` | "PAUSED phase 2.1 provider registry WIP" — protected; never apply, drop or inspect without explicit instruction; never run `git stash` in this repo |
| Branch `r13-structural-admission` | R-13 work, cherry-picked onto `develop` as `a461385 357cd9f e6ad6cd b089d4f ac226fc 93ec78f`. Kept, not merged |
| Worktree `wt-0024` | detached at `1bc7fd9` under a previous session's `/tmp` scratchpad; source of the `acc_r015_base` build. Kept |
| Validation objects | two unreferenced commit objects in `.git` built from a temporary index for validation only — `c27a435` (final candidate) and `12e9f37` (aborted run). On no branch, never pushed; removable only by garbage collection |

Committed checkpoint (`6d4b178..c8114b3`, ADR-015 steps 1–6):

| Step | Scope | Commits |
|---|---|---|
| decisions | ADR-015 record | `742214d` |
| 1 | R-1, R-12 (HIGH-1) | `cea5081 1344f11 59abfcb 72147a3 1bc7fd9` |
| 2 | R-2, R-3, R-4 — migration `0025` | `5889605 a0ef7b7 1f6fbeb 9ef8dc1 54d4feb ae1b023` |
| 3 | R-5, R-6 grant side — migration `0026` | `29ea42e 616b4b6 fd078c2 3df2b5d c8114b3` |
| 4 | R-7 … R-10 — migration `0027` | `01797cf 476ac64 1cf7c4a a44c440 c4a8ca1` |
| 5 | R-13 (HIGH-3), application only | `a461385 357cd9f e6ad6cd b089d4f ac226fc 93ec78f` |
| 6 | R-11, R-6 revoke side — migration `0028` | `8e36905 196baf9 bb354c5 10ac969 26cb5b8` |

Uncommitted on top of `c8114b3` (all accepted, `DECISIONS.md` §1o):

| Work | Content |
|---|---|
| Item 2 — PASS / CLOSED | migration `0029` (`roles_allowed_scope_types_non_empty` → `cardinality(...) >= 1`), Drizzle schema and snapshot, `roles-scope-types.int-spec.ts`, catalogue `item2-0029.json` |
| Item 4 — PASS / CLOSED | migration `0030` (last-reseller-administrator protection), `reseller-admin-liveness.ts`, revoke and disable changes, `AUTHZ_LAST_RESELLER_ADMIN` (contracts and one OpenAPI enum value), `reseller-admin-liveness.sec-spec.ts`, catalogue `item4-0030.json`, teardown adaptations |
| Item 5 — PASS / CLOSED | `platform-role-asymmetry.sec-spec.ts`, catalogue `item5-platform-asymmetry.json` (tests and documentation only) |
| Dependency remediation | `package-lock.json` only: `next` 16.3.8, `sharp` 0.35.5, `handlebars` 4.7.10 |
| Harness fix | `destroyUser` (`apps/api/test/auth-harness.ts`) toggles the reseller liveness trigger only when it exists — the step 1 catalogues run against an unmigrated (`0024`) clone |

## 3. Integrity record (sha256 of the current working tree)

| File | sha256 |
|---|---|
| `packages/db/migrations/0025_adr015_column_backstops_lifecycle.sql` | `362928870ce05f25394143aed5fe790633409013fabd2e76057763d577f7279f` |
| `packages/db/migrations/0026_adr015_permission_classification.sql` | `d31c7b3acb26a3696fc6175f01093fa6bc43896721e28c0e97f9139ef0e8c4e0` |
| `packages/db/migrations/0027_adr015_content_context.sql` | `1d05a001db4a285983d6a05da5991a3a82bd06ab2ececff452bb3f5877121345` |
| `packages/db/migrations/0028_adr015_org_admin_liveness.sql` | `dc67f945e8e044d52a1a014f28c4fc2bb5b592d7f09f4cfed0ae5240944d3158` |
| `packages/db/migrations/0029_adr015_roles_scope_types_non_empty.sql` | `111384595caa261e0f11c5dc54d6b8e98f5b4447d79979a287d2af5af16e6fa0` |
| `packages/db/migrations/0030_adr015_reseller_admin_liveness.sql` | `29ffe4524ca3d913a86baeea44cb1939c40e6eb5deba3e96c74dc97805d3900c` |
| `packages/db/migrations/meta/_journal.json` | `0a46fea03efe9092e8bdbfc122a470f8669b1875687d0492712e3f711d9e8210` |
| `apps/api/openapi/openapi.v1.json` | `a3ff1808cc7a530039c6bebe972ed0c561266d73fdc318d9dcf3e25e4c08000d` |
| `apps/api/src/metadata.ts` | `899b68c09319f581c0d83b853e3c29de5b192f81ca243c701fd2490b2cb1add2` |
| `package.json` (unchanged) | `94f659a133cf20e6f4842392e8e78e78f8e0fc92dea8d6a6196d0dc21eca8dfc` |
| `package-lock.json` | `e03da3b90da00df2d3c5a7efdc60c67ee0011adf0635cf65c489e6bcd89bdc5d` |
| `security/audit-exceptions.json` (unchanged) | `9601043e0ae63e20fa16d327045a844be4d59416f6a2d86e479125a18a3b89e6` |
| `scripts/mutation/run.mjs` (unchanged) | `d3ce5a550736a34b1ce4340764120c910c689b177f4bf6e36e704759670b50c4` |
| `scripts/with-db-clone.mjs` (unchanged) | `1ed8fed9673ae2820722489f485444c73a4059ed278e5c59025032d0e5da39a5` |
| `scripts/mutation/catalogue/step1-high1.json` … `step6-r11.json` | unchanged since `c8114b3` |
| `scripts/mutation/catalogue/item2-0029.json` | `73f716c2d5cf6a2bc4d5e250f83a39df8e302f840bbcd24bd51d0e5124ac6e86` |
| `scripts/mutation/catalogue/item4-0030.json` | `14ed42adabfdb10a2ef122214e5886d68243e7b7577e9709ac45e5c78e15facd` |
| `scripts/mutation/catalogue/item5-platform-asymmetry.json` | `bd775518918bd40ffa692c1dcb8357d33a523261eeff585fb8b48679d50d5e4c` |

- **Schema:** migrations `0000`–`0028` unchanged; `0029` and `0030` added with their snapshots and journal entries.
- **OpenAPI:** against `6d4b178`, `openapi.v1.json` adds `platform.roles.delegate_tenant` in three permission enums (step 3) and `AUTHZ_LAST_ORGANIZATION_ADMIN` (step 6) and `AUTHZ_LAST_RESELLER_ADMIN` (item 4) to `ErrorBody.code`. `metadata.ts` unchanged. No operation added or removed.
- **Dependencies:** manifests unchanged; `package-lock.json` changed only for `next`, `sharp`, `handlebars` and their own sub-packages.

## 4. Final consolidated validation (09-Oct-2026) — accepted

**Isolation.** A candidate commit object `c27a435` was built from a temporary `GIT_INDEX_FILE` (`read-tree HEAD`, `add -A`, `write-tree`, `commit-tree`) — byte-identical to the working tree, on no branch — and checked out as a detached worktree outside the repository. The unmodified `scripts/mutation/run.mjs` ran from it against disposable clones of `acc_r015_base`. `develop`, HEAD and the real index were unchanged throughout.

**Mutation evidence (standard runner, all nine catalogues):**

| Catalogue | Mutants | Caught |
|---|---|---|
| step1-high1 | 20 | 20 |
| step2-0025 | 33 | 33 |
| step3-r5-r6 | 32 | 32 |
| step4-r7 | 20 | 20 |
| step5-r13 | 46 | 46 |
| step6-r11 | 23 | 23 |
| item2-0029 | 2 | 2 |
| item4-0030 | 20 | 20 |
| item5-platform-asymmetry | 4 | 4 |
| **Total** | **200** | **200** |

- All 22 baseline commands passed; every report records head `c27a435`; every mutant applied; none survived.
- **197** were caught by an explicit assertion or a compile error (step 5 M28: TS2578 in the type fixtures); each failure was checked against the catalogue's `killedBy`, the accepted 08-Oct-2026 run's failing tests, or the named item 2 tests.
- **3** (step 3 M6, M6b, M6c — the race cases) were caught by the intended race tests through the test's wait-for-block exceeding Jest's 5-second limit, not an explicit assertion — identical to the accepted 08-Oct-2026 run.
- **E1** (item 5, guard 4 skipped for a platform-role revocation) is classified equivalent by documented reasoning and was not run; it is outside the 200 runnable mutants.
- **Item 4 M1** additionally logged a teardown suite failure (the mutant deletes the trigger that `RevocationWorld.teardown` toggles); its verdict rests on ten intended assertion failures and is unchanged.

**Regression (candidate, migrated clone):** DB unit 5/5, DB integration 222/222, API unit 498/498, API integration 125/125, API security 1,402/1,402 (53 suites), web 183/183. Migration hashes 31/31; schema fingerprint after migrating the template to `0030`: `all=d37462efc2bdf14a06b874b1f5f861a7`.

**Static checks:** `build:packages`, lint, typecheck, Prettier, `openapi:check` (no diff), `drizzle-kit generate` (no pending change), `git diff --check` — all pass. Gitleaks: history clean; the only file-level finding is the three md5 trigger pins in `backstop-definitions.int-spec.ts`, already allowlisted for history.

**Environmental incident (resolved, not a blocker).** The first attempt failed on EDQUOT: `/tmp` is a 7.4 GB tmpfs with a user quota, and Jest's transform cache (`/tmp/jest_rs`) grows with every mutant worktree path. The regenerable cache was removed and the run repeated in full with `TMPDIR` on the main disk; no repository or candidate change. Future mutation runs should set `TMPDIR` to a directory on disk.

## 5. Dependency audit (`npm run audit`, exit 0, 09-Oct-2026)

`npm audit`: **0 critical, 2 high, 26 moderate, 0 low.** Both high findings are `multer` 2.2.0 and `@nestjs/platform-express` 11.2.3 (which only inherits `multer`'s advisories), covered by the existing documented exception in `security/audit-exceptions.json`: GHSA-wc9g-mqfw-jrwm, GHSA-qfvm-cv95-jqjf, GHSA-535w-7cp7-47q4, GHSA-3pph-fpjx-jg34, GHSA-qvfw-j98x-7q72 — reviewed 02-Oct-2026, **expires 31-Oct-2026**. The gate fails on an expired exception whether or not it still matches, so before that date either `@nestjs/platform-express` is updated to ≥ 11.2.6 (pins `multer` 2.4.0) and the exception removed, or the exception is re-reviewed.

Resolved by the lockfile-only remediation: `next` 16.3.6 → 16.3.8 (GHSA-cjq9-62q9-8jv4 and five lower), `sharp` 0.35.4 → 0.35.5 (GHSA-wq5f-xc86-pv6w), `handlebars` 4.7.9 → 4.7.10 (GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f critical; GHSA-xw65-4hp5-5hc7). The moderate findings (the `jest`/`ts-jest` chain, `drizzle-kit`/`esbuild`, `@nestjs/swagger`/`js-yaml`, `fast-uri`) are below the gate threshold.

## 6. Decision status

All five review items are decided (`DECISIONS.md` §1o):

1. Organization status in the content predicate — **DEFERRED** (review of the application-layer lifecycle model and ADR-014 / `TENANCY.md` first).
2. Empty `allowed_scope_types` — **PASS / CLOSED** (migration `0029`).
3. `delegate_tenant` structural admissibility — **DEFERRED** (application, seed and contract enforcement retained).
4. Reseller-administrator peer revocation kept; last-reseller-administrator protection added — **PASS / CLOSED** (migration `0030`). Recorded decisions: the mutual-revocation `404`, and the cross-scope lock-order residual.
5. Platform-role grant/revoke asymmetry kept — **PASS / CLOSED** (tests and documentation).

## 7. Residual risks (documented, accepted — not closed)

- **R-13 in-process bypass** — caught only by the static boundary test and review (`DECISIONS.md` §1o; `PROVIDER_ADAPTER.md` §6h).
- **`app.current_user_id` / `app.current_api_key_id` forgery** — confined to one organization's content (`SECURITY.md` §4b).
- **System role key or `is_system_role` rewrite** by an owner or seeder transaction — not guarded by `0028` / `0030` (the seed's conflict update does not set `is_system_role`).
- Role-widening guard at REPEATABLE READ/SERIALIZABLE checks through the transaction snapshot; the liveness rules rely on READ COMMITTED.
- **Cross-scope advisory-lock ordering** — owner-level multi-scope statements can deadlock against canonical-order paths; PostgreSQL aborts one (`40P01`; an API victim answers HTTP `500`); the invariant holds (`DECISIONS.md` §1o, item 4, decision 2).
- The reseller-deletion exemption is unreachable while `trg_resellers_grant_restrict` (`0025`) is in place.
- Real-provider health checks are un-admitted outbound calls by design; MEDIUM-6 unchanged; HIGH-6 and MEDIUM-7 deferred (R-15).
- Items 1 and 3 deferred (§6).

**Evidence qualifications (non-blocking):** the three step 3 race mutants are caught by wait timeouts rather than explicit assertions; E1 is equivalent by reasoning only; item 5's unauthorized-principal tests prove the absence of a revocation audit row, not of every audit event; `RevocationWorld.teardown`, both `removeIdentities` helpers and the inline teardown blocks still assume migration `0030` (every catalogue command that reaches them migrates first); `run.mjs` leaves an orphaned clone if it kills a command on timeout and does not remove its active worktree on SIGTERM; CI has not run.

## 8. Test infrastructure and databases

- **Template `acc_r015_base`** — `template0` + migrations `0000`–`0024` from worktree `wt-0024` at `1bc7fd9`, seeded; fingerprint `all=902f22bc20c8a3f9ce80f67407804cb5`. Clone source only; every validation run reported it unchanged.
- Databases present: `acc`, `acc_gateb`, `acc_p23`, `acc_p23_fresh`, `acc_p24`, `acc_r015_base` (+ system databases). No `acc_tmp_*` or clone database remains. `acc_gateb` (18 migrations, last 28-Sep-2026) was not used by this remediation. `acc_p24_fresh` was lost on 07-Oct-2026 (`TESTING.md` §6q, "Process incident"); never recreate it.
- **Rule** (`TESTING.md` §6q): a script that creates or drops a database hard-codes the name and refuses anything outside an allowlisted throwaway pattern or naming a reference database.
- Run DB-touching suites through `node scripts/with-db-clone.mjs -- <cmd>` with the four `DATABASE_*_URL` pointing at `acc_r015_base`, `NODE_ENV` unset, `RATE_LIMIT_AUTH_MAX=10 RATE_LIMIT_REFRESH_MAX=30`, and `TMPDIR` on disk. Mutation: `node scripts/mutation/run.mjs scripts/mutation/catalogue/<name>.json --out <dir>`; for uncommitted work, run it from a candidate worktree built as in §4. With `jest --selectProjects`, use `--testPathPatterns`, never a bare path.

## 9. Next actions (in order; each needs the user's explicit approval)

1. Review this documentation reconciliation.
2. Authorize a commit of the candidate (items 2, 4, 5, the dependency remediation, the harness fix, the documentation) and a push to `origin/develop`.
3. CI must be green on the pushed commit.
4. User decides the ADR-015 remediation gate.
5. Before 31-Oct-2026: decide the `multer` exception (§5).
6. Phase 3.1 only on separate explicit authorization.

## 10. DO NOT

- Do not commit, push, amend, rebase, squash or merge without explicit instruction.
- Do not change `package.json`, `package-lock.json`, `security/audit-exceptions.json` or dependencies without instruction.
- Do not alter migrations `0000`–`0030` or the OpenAPI snapshot.
- Do not reopen decided items or change code "while there"; items 1 and 3 stay deferred.
- Do not describe the ADR-015 remediation gate as passed before the user decides it; Gate C (Phase 1C) stays closed.
- Do not start Phase 3.1 or Item 6.
- Do not touch `main`, `stash@{0}`, `acc_gateb`, `acc_p24`, `acc_r015_base` or any reference database; mutations only on throwaway clones.
- Do not delete branch `r13-structural-admission` or worktree `wt-0024` without instruction.
