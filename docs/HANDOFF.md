# Continuation handoff — ADR-015 remediation gate

**Updated:** 14-Oct-2026 (first captured 08-Oct-2026). **Status: ADR-015 pre-Phase-3 remediation gate APPROVED / CLOSED (09-Oct-2026); Gate C APPROVED / CLOSED (12-Oct-2026); Gate D.6 APPROVED / CLOSED (user decision, 13-Oct-2026; `DECISIONS.md` §1p); Gate D (Phase 2 Backend Acceptance) APPROVED / CLOSED and Phase 2 formally CLOSED (user decision, 13-Oct-2026; `DECISIONS.md` §1q); Gate E.1 (Phase 3.1 Data Foundation Acceptance) APPROVED / CLOSED (user decision, 14-Oct-2026; `DECISIONS.md` §1r; commit `f08b48e`).** This file is a pointer and evidence index for the next session. It records state; it decides nothing. The authoritative records are `DECISIONS.md` §1o (ADR-015), `DECISIONS.md` §1p (Gate D.6), `DECISIONS.md` §1q (Gate D / Phase 2 Closure), `DECISIONS.md` §1r (Gate E.1 / Phase 3.1 Closure), `TESTING.md` §6q, §6u, §6x, `SECURITY.md` §4b, `RBAC.md` §7–§8b and `PROVIDER_ADAPTER.md` §6h; where this file and those differ, those win.

Naming: the **ADR-015 pre-Phase-3 remediation gate** (09-Oct-2026), **Gate C** (Phase 1C acceptance, `ROADMAP.md` §4d; 02-Oct-2026), **Gate D.6** (Phase 2.6 provider console acceptance, `ROADMAP.md` §5c; 13-Oct-2026), **Gate D** (Phase 2 backend acceptance & overall Phase 2 closure, `ROADMAP.md` §5c; 13-Oct-2026), and **Gate E.1** (Phase 3.1 Data Foundation acceptance, `ROADMAP.md` §6a; 14-Oct-2026) are recorded as APPROVED / CLOSED. Do not reopen them without an explicit decision, except where new evidence requires investigation of a potential security defect, regression, or material change to the accepted risk.

## 1. Current phase and gate

- Phase: **Phase 2 is formally CLOSED** (Gate D and Gate D.6 both approved by project owner decision, 13-Oct-2026). **Phase 2.7 is undefined and unauthorized.**
- **Phase 3.0 architecture remains FROZEN under ADR-014.**
- **Phase 3.1 Data Foundation is formally CLOSED** (Gate E.1 approved by project owner decision, 14-Oct-2026; commit `f08b48e`).
- **Phase 3.2 has NOT started and is NOT authorized.** Separate explicit project-owner authorization is required before any Phase 3.2 work begins.
- HIGH-6 and MEDIUM-7 remain deferred to immediately before the dispatcher increment (R-15); other MEDIUM/LOW findings are deferred, not designed.

## 2. Repository state

| Item | Value |
|---|---|
| Branch | `develop` |
| HEAD | `f08b48e89e7683530b9bc81c757cd6089817f3f6` |
| `origin/develop` | `f08b48e` — pushed 14-Oct-2026; local level with it |
| Working tree | clean at `f08b48e` apart from canonical gate-closure documentation |

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

Committed in `7a9ed37` on top of `c8114b3` (all accepted, `DECISIONS.md` §1o):

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

**Regression (candidate, migrated clone):** DB unit 5/5, DB integration 222/222, API unit 498/498, API integration 125/125, API security 1,402/1,402 (53 suites); web regression reported at 183/183 for Phase 1C, with latest reported suite covering SEC-01 through SEC-08 frontend controls at 294/294 passed across 40 suites (latest verified run; future runs depend on working-tree test composition). Migration hashes 31/31; schema fingerprint after migrating the template to `0030`: `all=d37462efc2bdf14a06b874b1f5f861a7`.

**Static checks:** `build:packages`, lint, typecheck, Prettier, `openapi:check` (no diff), `drizzle-kit generate` (no pending change), `git diff --check` — all pass. Gitleaks: history clean; the only file-level finding is the three md5 trigger pins in `backstop-definitions.int-spec.ts`, already allowlisted for history.

**CI (09-Oct-2026):** run `37969162005` on the pushed commit `7a9ed37` — all five jobs successful: secret scan, dependency audit, OpenAPI contract drift, lint / typecheck / build, integration / database / security.

**Environmental incident (resolved, not a blocker).** The first attempt failed on EDQUOT: `/tmp` is a 7.4 GB tmpfs with a user quota, and Jest's transform cache (`/tmp/jest_rs`) grows with every mutant worktree path. The regenerable cache was removed and the run repeated in full with `TMPDIR` on the main disk; no repository or candidate change. Future mutation runs should set `TMPDIR` to a directory on disk.

## 5. Dependency audit (`npm run audit`, exit 0)

- **Current verified state:** `npm audit`: **0 critical, 0 high, 26 moderate, 0 low** with **0 active exceptions** ([`security/audit-exceptions.json`](file:///home/alendei-admin/Projects/alendei-communications-cloud/security/audit-exceptions.json) holds `"exceptions": []`). Remediated via workspace lockfile update: `@nestjs/platform-express` resolved to `11.2.7`, pinning `multer` `2.4.0`. All five reported `multer` advisories (GHSA-wc9g-mqfw-jrwm, GHSA-qfvm-cv95-jqjf, GHSA-535w-7cp7-47q4, GHSA-3pph-fpjx-jg34, GHSA-qvfw-j98x-7q72) are resolved and outside affected version ranges; obsolete sub-dependencies `concat-stream` and `typedarray` are pruned.
- **Historical record (09-Oct-2026 gate):** Previously reported 2 high findings under an exception expiring 31-Oct-2026 for `multer 2.2.0` / `@nestjs/platform-express 11.2.3`. That obligation is now closed.
- **Earlier lockfile remediations:** `next` 16.3.6 → 16.3.8 (GHSA-cjq9-62q9-8jv4 and five lower), `sharp` 0.35.4 → 0.35.5 (GHSA-wq5f-xc86-pv6w), `handlebars` 4.7.9 → 4.7.10 (GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f critical; GHSA-xw65-4hp5-5hc7).
- **Residual moderate advisories:** 26 moderate findings (the `jest`/`ts-jest` toolchain, `drizzle-kit`/`esbuild`, `@nestjs/swagger`/`sprintf-js`/`js-yaml`, `fast-uri`) remain below the high/critical gate threshold and are logged as non-blocking development dependency risks.

## 6. Decision status

All five review items are decided (`DECISIONS.md` §1o):

1. Organization status in the content predicate — **DEFERRED** (review of the application-layer lifecycle model and ADR-014 / `TENANCY.md` first).
2. Empty `allowed_scope_types` — **PASS / CLOSED** (migration `0029`).
3. `delegate_tenant` structural admissibility — **DEFERRED** (application, seed and contract enforcement retained).
4. Reseller-administrator peer revocation kept; last-reseller-administrator protection added — **PASS / CLOSED** (migration `0030`). Recorded decisions: the mutual-revocation `404`, and the cross-scope lock-order residual.
5. Platform-role grant/revoke asymmetry kept — **PASS / CLOSED** (tests and documentation).

### Gate C sign-off record — APPROVED (project owner decision, 12-Oct-2026)

**Decision.** Gate C is **APPROVED** by the project owner following the formal acceptance review.

**Accepted remediation & verification scope:**
- **Frontend security controls (SEC-01 through SEC-08):** All eight findings confirmed closed with regression test coverage (latest verified web suite: 294/294 passed across 40 suites).
- **Multer dependency remediation:** `@nestjs/platform-express@11.2.7` resolves `multer@2.4.0`; all five canonical advisories (GHSA-wc9g-mqfw-jrwm, GHSA-qfvm-cv95-jqjf, GHSA-535w-7cp7-47q4, GHSA-3pph-fpjx-jg34, GHSA-qvfw-j98x-7q72) are resolved; `security/audit-exceptions.json` holds 0 active exceptions.
- **Canonical criteria evaluation:** All twelve Gate C criteria (`ROADMAP.md` §4d) evaluated as PASS or PASS WITH LIMITATION.

**Preserved evidence limitations & operational constraints:**
- **Frontend mutation testing:** SEC-01 through SEC-03 have no reported mutation-testing evidence. SEC-04 mutation testing was performed in-place without pre-mutation hashes. SEC-05, SEC-07, and SEC-08 used disposable copies/worktrees in synthetic/mock DOM environments.
- **Dependency audit boundary:** Audit counts (0 critical, 0 high, 26 moderate) reflect earlier recorded execution logs, not a new run during the final review.
- **Moderate devDependency advisories:** 26 moderate development-dependency advisories remain documented and scheduled for modernization in Phase 3.
- **Phase 1C.5 status:** Phase 1C.5 remains unassigned and undefined pending future planning.
- **Database test procedure:** Database-backed test suites require applying migrations `0025`–`0030` to disposable clones via `scripts/with-db-clone.mjs`; canonical template `acc_r015_base` remains frozen at migration `0024`.

### Gate D.6 sign-off record — APPROVED (project owner decision, 13-Oct-2026)

**Decision.** Phase 2.6 Gate D.6 (Provider & Channel Console) is **APPROVED** by the project owner following the final read-only acceptance audit.

**Accepted implementation & verification scope:**
- **Playwright E2E suite (`apps/web/e2e/providers-console.spec.ts`):** All 8 tests passed repeatably (E2E-PROV-01 through E2E-PROV-08; 13.5s runtime, exit code 0) against a disposable clone of `acc_r015_base` migrated through `0030` with `fixture:dev` and `fixture:providers` loaded.
- **Provider administration & security unit suites:** 22/22 tests passed (13 in `apps/web/src/lib/providers-administration.test.ts`, 9 in `apps/web/src/lib/providers-security.sec.test.ts`; 0 failures, 130.5ms duration).
- **OpenAPI contract consistency:** `npm run openapi:check` passed cleanly; `apps/api/src/metadata.ts` and `apps/api/openapi/openapi.v1.json` are current and match generated metadata.
- **Direct-route authorization boundary enforcement:** Direct URL navigation to `/providers` and `/channels` verified to enforce `Access Forbidden` boundary for unauthorized persona (`platform-support@acc-fixture.test`), with zero disclosure of provider or channel configuration.
- **Tenant & session security invariants:** All operations adhere to in-memory session invariants (SEC-02); zero credentials or tokens in browser storage.
- **Database & environment isolation:** Executed strictly against disposable clones via `scripts/with-db-clone.mjs`; disposable clone `acc_r015_base_clone_4944ce913640` dropped and verified gone; persistent template `acc_r015_base` row-count fingerprint unchanged; listeners on ports 3000 and 3001 released.

**Preserved observations & operational constraints:**
- **Diagnostic observation in E2E-PROV-08:** The chained `.catch(() => {})` on `enterProvidersBtn.waitFor(...).then(() => enterProvidersBtn.click())` was accepted by the project owner as a minor diagnostic-quality observation rather than a demonstrated authorization defect.
- **Repository state:** 24 tracked modified files (23 pre-existing Gate C files + `apps/web/e2e/providers-console.spec.ts`) and exactly five untracked security test files preserved. No commit or push occurred.

### Gate D sign-off record and Phase 2 Closure — APPROVED (project owner decision, 13-Oct-2026)

**Decision.** Gate D (Phase 2 Backend Acceptance) is **APPROVED** by the project owner following formal acceptance review. Together with the previously approved Gate D.6, Phase 2 of Alendei Communications Cloud is formally **CLOSED** under `ROADMAP.md` §§5a and 5c.

**Accepted evidence baseline:**
- **Full backend regression:** 1,869/1,869 tests passing across three consecutive runs at freeze (`TESTING.md` §6u: db-unit 4, db-int 136, api-unit 426, api-int 124, api-sec 1,179). Expanded to 2,252/2,252 passing under ADR-015 candidate validation (`HANDOFF.md` §4: db-unit 5, db-int 222, api-unit 498, api-int 125, api-sec 1,402). CI run `37969162005` on pushed commit `7a9ed37` passed across all five jobs.
- **Mutation proofs:** 104/104 caught by assertion evidence on disposable clones (X01–X30, Y01–Y15, Z01–Z08, W01–W16, D01–D08, S01–S09, C01–C14, F01–F04; `TESTING.md` §6u).
- **Schema & migrations:** Migrations `0018` through `0024` apply cleanly from empty and re-run as a no-op with identical dump; template `acc_r015_base` row-count fingerprint verified.
- **OpenAPI & contract consistency:** `apps/api/openapi/openapi.v1.json` covers all 74 application operations; `openapi:check` passes with zero drift.
- **Security & boundary invariants:** Structural `CircuitAdmission` enforced (`PROVIDER_ADAPTER.md` §6h; ADR-015 R-13); zero credential secret persistence proven across all six Phase 2 provider tables and code (`credential-absence.architecture.spec.ts`); scope-creep checks pass (`scope-creep.architecture.spec.ts`).
- **Dependency audit:** Remediated via `@nestjs/platform-express@11.2.7` / `multer@2.4.0`; 0 critical, 0 high, 26 moderate, 0 active exceptions (`security/audit-exceptions.json`).

**Disclosed operational limitations & accepted residual risks:**
- Hot reload operates as best-effort configuration invalidation with bounded convergence (`R` = 5 s, `T` = 60 s) via PostgreSQL `LISTEN/NOTIFY`, not transactional propagation (ADR-013 PD-1, `PROVIDER_ADAPTER.md` §3a).
- Provider transitions are observable through `audit_logs` and metrics only (no event publishing; ADR-013 PD-2).
- RLS does not distinguish among validated platform-scope principals; `alendei_support` is RLS-eligible but refused by `AuthorizationService` (ADR-013 F-3).
- 26 moderate devDependency advisories remain documented and accepted as non-blocking development risks.
- HIGH-6 and MEDIUM-7 remain deferred until immediately before the Phase 3 dispatcher increment (R-15).

**Boundaries & Next Increments:**
- Phase 2 is formally CLOSED. Phase 2.7 remains undefined and unauthorized.
- Phase 3.0 architecture remains FROZEN under ADR-014.
- Phase 3.1 Data Foundation is formally CLOSED (Gate E.1 approved by project owner decision, 14-Oct-2026; commit `f08b48e`).
- Phase 3.2 remains NOT STARTED and NOT AUTHORIZED; separate explicit project-owner authorization is required.

## 7. Residual risks (documented, accepted — not closed)

- **R-13 in-process bypass** — caught only by the static boundary test and review (`DECISIONS.md` §1o; `PROVIDER_ADAPTER.md` §6h).
- **`app.current_user_id` / `app.current_api_key_id` forgery** — confined to one organization's content (`SECURITY.md` §4b).
- **System role key or `is_system_role` rewrite** by an owner or seeder transaction — not guarded by `0028` / `0030` (the seed's conflict update does not set `is_system_role`).
- Role-widening guard at REPEATABLE READ/SERIALIZABLE checks through the transaction snapshot; the liveness rules rely on READ COMMITTED.
- **Cross-scope advisory-lock ordering** — owner-level multi-scope statements can deadlock against canonical-order paths; PostgreSQL aborts one (`40P01`; an API victim answers HTTP `500`); the invariant holds (`DECISIONS.md` §1o, item 4, decision 2).
- The reseller-deletion exemption is unreachable while `trg_resellers_grant_restrict` (`0025`) is in place.
- Real-provider health checks are un-admitted outbound calls by design; MEDIUM-6 unchanged; HIGH-6 and MEDIUM-7 deferred (R-15).
- Items 1 and 3 deferred (§6).

**Evidence qualifications (non-blocking):** the three step 3 race mutants are caught by wait timeouts rather than explicit assertions; E1 is equivalent by reasoning only; item 5's unauthorized-principal tests prove the absence of a revocation audit row, not of every audit event; `RevocationWorld.teardown`, both `removeIdentities` helpers and the inline teardown blocks still assume migration `0030` (every catalogue command that reaches them migrates first); `run.mjs` leaves an orphaned clone if it kills a command on timeout and does not remove its active worktree on SIGTERM. Item 4 M1 produced teardown noise and was caught by its intended assertion failures. CI has since passed (run `37969162005`, §4).

## 8. Test infrastructure and databases

- **Template `acc_r015_base`** — `template0` + migrations `0000`–`0024` from worktree `wt-0024` at `1bc7fd9`, seeded; fingerprint `all=902f22bc20c8a3f9ce80f67407804cb5`. Clone source only; intentionally frozen at migration `0024`. Every validation run reported it unchanged.
- Databases present: `acc`, `acc_gateb`, `acc_p23`, `acc_p23_fresh`, `acc_p24`, `acc_r015_base` (+ system databases). No `acc_tmp_*` or clone database remains. `acc_gateb` (18 migrations, last 28-Sep-2026) was not used by this remediation. `acc_p24_fresh` was lost on 07-Oct-2026 (`TESTING.md` §6q, "Process incident"); never recreate it.
- **Rule** (`TESTING.md` §6q): a script that creates or drops a database hard-codes the name and refuses anything outside an allowlisted throwaway pattern or naming a reference database.
- **Disposable database test procedure:** Run DB-touching suites through `node scripts/with-db-clone.mjs -- <cmd>` with the four `DATABASE_*_URL` pointing at `acc_r015_base`, `NODE_ENV` unset, `RATE_LIMIT_AUTH_MAX=10 RATE_LIMIT_REFRESH_MAX=30`, and `TMPDIR` on disk. Because `acc_r015_base` is intentionally frozen at migration `0024`, test suites that require migrations beyond `0024` (currently `0025`–`0031`, e.g., teardown trigger `trg_user_roles_reseller_admin_liveness` in `auth-harness.ts`) require that the disposable clone be migrated through the current migration set before running tests:
  ```bash
  node scripts/with-db-clone.mjs -- bash -c "npm run db:migrate --workspace @acc/db && npm --workspace=@acc/api run test:integration"
  node scripts/with-db-clone.mjs -- bash -c "npm run db:migrate --workspace @acc/db && npm --workspace=@acc/api run test:security"
  ```
  Migrations must never be applied to the persistent template `acc_r015_base` or to persistent development databases as part of test setup. The disposable clone is dropped `WITH (FORCE)` on every exit path and verified gone. Mutation: `node scripts/mutation/run.mjs scripts/mutation/catalogue/<name>.json --out <dir>`; for uncommitted work, run it from a candidate worktree built as in §4. With `jest --selectProjects`, use `--testPathPatterns`, never a bare path.

## 9. Next actions (in order; each needs the user's explicit approval)

1. Review and commit this gate-closure documentation (only on instruction).
2. Phase 3.2 (WhatsApp Provider Adapter & Channel Router) only on separate explicit authorization.
3. Items 1 and 3 stay deferred until the user schedules them.

## 10. DO NOT

- Do not commit, push, amend, rebase, squash or merge without explicit instruction.
- Do not change `package.json`, `package-lock.json`, `security/audit-exceptions.json` or dependencies without instruction.
- Do not alter migrations `0000`–`0031` or the OpenAPI snapshot.
- Do not reopen decided items or change code "while there"; items 1 and 3 stay deferred.
- The gates — the ADR-015 remediation gate (09-Oct-2026), Gate C (02-Oct-2026), Gate D/D.6 (13-Oct-2026), and Gate E.1 (14-Oct-2026) — are recorded as APPROVED / CLOSED. Do not reopen them without an explicit decision, except where new evidence requires investigation of a potential security defect, regression, or material change to the accepted risk.
- Do not start Phase 3.2.
- Do not touch `main`, `stash@{0}`, `acc_gateb`, `acc_p24`, `acc_r015_base` or any reference database; mutations only on throwaway clones.

- Do not delete branch `r13-structural-admission` or worktree `wt-0024` without instruction.
