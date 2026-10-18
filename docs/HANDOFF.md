# Continuation handoff — ADR-015 remediation gate

**Updated:** 17-Oct-2026 (first captured 08-Oct-2026). **Status: Phase 3 is formally CLOSED (Gates E.1–E.5 APPROVED / CLOSED; `DECISIONS.md` §1r–§1v). Phase 4.1 (Gate F.1 Data & Regulatory Foundation) is APPROVED by project owner decision (17-Oct-2026; `DECISIONS.md` §1w, `ROADMAP.md` §7); its work is uncommitted in the working tree. Phase 4.2 (Gate F.2) and Phase 4.3 (Gate F.3) remain NOT STARTED and NOT AUTHORIZED.** This file is a pointer and evidence index for the next session. It records state; it decides nothing. The authoritative records are `DECISIONS.md` §1o (ADR-015), `DECISIONS.md` §1p (Gate D.6), `DECISIONS.md` §1q (Gate D / Phase 2 Closure), `DECISIONS.md` §1r (Gate E.1 / Phase 3.1 Closure), `DECISIONS.md` §1s (Gate E.2 / Phase 3.2 Closure), `DECISIONS.md` §1t (Gate E.3 / Phase 3.3 Closure), `DECISIONS.md` §1u (Phase 3.4 / Gate E.4 Closure), `DECISIONS.md` §1v (Phase 3.5 / Gate E.5 Closure), `DECISIONS.md` §1w (Phase 4.1 / Gate F.1 Approval), `TESTING.md` §6q, §6u, §6x, `SECURITY.md` §4b, `RBAC.md` §7–§8b and `PROVIDER_ADAPTER.md` §6h; where this file and those differ, those win.

Naming: the **ADR-015 pre-Phase-3 remediation gate** (09-Oct-2026), **Gate C** (Phase 1C acceptance, `ROADMAP.md` §4d; 02-Oct-2026), **Gate D.6** (Phase 2.6 provider console acceptance, `ROADMAP.md` §5c; 13-Oct-2026), **Gate D** (Phase 2 backend acceptance & overall Phase 2 closure, `ROADMAP.md` §5c; 13-Oct-2026), **Gate E.1** (Phase 3.1 Data Foundation acceptance, `ROADMAP.md` §6a; 14-Oct-2026), **Gate E.2** (Phase 3.2 Assignments & Principal Scopes acceptance, `ROADMAP.md` §6a; 14-Oct-2026), **Gate E.3** (Phase 3.3 Orchestrator & Dispatch Execution acceptance, `ROADMAP.md` §6a; 15-Oct-2026), **Gate E.4** (Phase 3.4 Fallback & Resilience acceptance, `ROADMAP.md` §6a; 15-Oct-2026), and **Gate E.5** (Phase 3.5 WhatsApp Management Console acceptance, `ROADMAP.md` §6a; 16-Oct-2026) are recorded as APPROVED / CLOSED. **Gate F.1 (Phase 4.1 Data & Regulatory Foundation)** is recorded as APPROVED (project owner decision, 17-Oct-2026). Do not reopen them without an explicit decision, except where new evidence requires investigation of a potential security defect, regression, or material change to the accepted risk.

## 1. Current phase and gate

- Phase: **Phase 2 is formally CLOSED** (Gate D and Gate D.6 both approved by project owner decision, 13-Oct-2026). **Phase 2.7 is undefined and unauthorized.**
- **Phase 3.0 architecture remains FROZEN under ADR-014.**
- **Phase 3.1 Data Foundation is formally CLOSED** (Gate E.1 approved by project owner decision, 14-Oct-2026; commit `f08b48e`).
- **Phase 3.2 Assignments & Principal Scopes is formally CLOSED** (Gate E.2 approved by project owner decision, 14-Oct-2026; commit `4d4c4b7`).
- **Phase 3.3 Orchestrator & Dispatch Execution is formally CLOSED** (Gate E.3 approved by project owner decision, 15-Oct-2026; `DECISIONS.md` §1t).
- **Phase 3.4 Fallback & Resilience is formally CLOSED** (Gate E.4 approved by project owner decision, 15-Oct-2026; `DECISIONS.md` §1u).
- **Phase 3.5 WhatsApp Management Console is formally CLOSED** (Gate E.5 approved by project owner decision, 16-Oct-2026; `DECISIONS.md` §1v, `ROADMAP.md` §6a). **Phase 3 of Alendei Communications Cloud is formally CLOSED.**
- **Phase 4.1 Data & Regulatory Foundation (Gate F.1)** is **APPROVED** (Gate F.1, project owner decision, 17-Oct-2026; ADR-016, `ROADMAP.md` §7, `DECISIONS.md` §1w). Uncommitted; commit only on explicit instruction. Recorded 17-Oct-2026: D-7 approved, voice E.164 acknowledged, interim variable limit, OpenAPI deferral, optional `headerId`, fixture delta assertion (`DECISIONS.md` §1w.10). Still open, each needing separate authorization: migration-history recovery, clone/process cleanup, migration-tooling separation. No migration `0035`+ may be written or applied until tooling separation and then history recovery are resolved.
- **Phase 4.2 (Gate F.2) and Phase 4.3 (Gate F.3) remain NOT STARTED and NOT AUTHORIZED.**
- HIGH-6 and MEDIUM-7 were resolved in Phase 3.3 (`DECISIONS.md` §1t); other MEDIUM/LOW findings are deferred, not designed.

## 2. Repository state

| Item | Value |
|---|---|
| Branch | `develop` |
| HEAD | `423d122297ec7cfc593d54cc923359196d4a3c71` |
| `origin/develop` | `423d122` — pushed 16-Oct-2026; local HEAD matches remote |
| Working tree (17-Oct-2026) | **Not clean.** Uncommitted, unstaged Gate F.1 work. Modified: `.env.example`, `apps/api/openapi/openapi.v1.json`, `apps/api/src/config/app-config.service.ts`, `apps/api/src/config/env.schema.ts`, `apps/api/src/messages/messages.service.ts`, `apps/api/src/metadata.ts`, `apps/api/src/templates/templates.dto.ts`, `apps/api/src/templates/templates.service.ts`, `apps/api/test/dev-fixture.sec-spec.ts`, `apps/api/test/organization-administration.sec-spec.ts`, `docs/DECISIONS.md`, `docs/HANDOFF.md`, `docs/ROADMAP.md`, `packages/contracts/src/errors.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/templates.ts`. Untracked: `apps/api/src/messages/rcs/rcs-validation.spec.ts`, `apps/api/src/messages/sms/sms-segment.spec.ts`, `apps/api/test/phase4_1-data-foundation.sec-spec.ts`, `packages/contracts/src/rcs.ts`, `packages/contracts/src/sms.ts`. Nothing staged, committed or pushed. |
| Implementation | Phase 3 complete (commit `2c6f529`), CI stabilized (commits `6572820`, `423d122`; GitHub Actions run `38880983348` 5/5 green on `423d122`). Gate F.1 is in the working tree only. |

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
| `packages/db/migrations/0033_phase3_3_orchestrator_dispatch.sql` | `dfc05dad5d3d5e4782d5d1c78fe0d036b5b94907ad624e67f68a4cefedd1154c` |
| `packages/db/migrations/0034_phase3_4_fallback.sql` | `7692ee9349ddb810a4ed79a5f4926d939a38d15ffcc8118a2635745b0ea2ca6f` |
| `packages/db/migrations/meta/0033_snapshot.json` | `43b46793ba344be7178504499c385493546c482a1acfc83fe2cdef53bf2db96e` |
| `packages/db/migrations/meta/0034_snapshot.json` | `084d0fd620bcf764b485c9f7301667de5e6ac179dee9e1c0583037ef049e2044` |
| `packages/db/migrations/meta/_journal.json` | `1d860f59b2b906a39a789ee3749522f8df9ae26863084b86f5481b2933a47b9f` |
| `apps/api/openapi/openapi.v1.json` | `82a3f22870f34e3ff76d5a543526f2b95a099438edefd3ec63c520fc319f6b55` |
| `apps/api/src/metadata.ts` | `5cb77db663bdfaf644a27bb4d463b389b694dcb197881edb154bac82e883dc8d` |
| `packages/contracts/src/messages.ts` | `7fd7f47aa5b5603a9b13d672dfcccb2f62e935b8ad99c967610b84c368742460` |
| `packages/db/src/schema/messages.ts` | `a75144d347189e80197d6b28c219ae82ef196197a4c99c973be6d006f2071aa1` |
| `apps/api/src/messages/dispatch/dispatcher.service.ts` | `fbeaf509dc336bf2dea3c45e479c781c85a57a1af36e9a35b51c0d9cbbeffccc` |
| `apps/api/test/phase3_4-fallback-resilience.sec-spec.ts` | `3e8347397aa2ace47b96d438940b1fa29069c8ddb2a077ffe8dc32206b426224` |
| `apps/api/test/fallback-fencing-concurrency.int-spec.ts` | `cde66738f38368931d058cc87e74b9dd415fe0905c87cfde85376188bc543b7d` |
| `apps/web/src/app/(console)/layout.tsx` | `e6c73e8f09cba22ab8c0789287124abba357d73aa6516929d13c940e33735cba` |
| `apps/web/src/lib/api-client.ts` | `298f6f2ea21fa398cbf7d766ffdc3265f49d79acb9f0c20f5b8ad65f2bea5e90` |
| `apps/web/src/lib/session-store.ts` | `2c6357ee948dd62df134d3b031d208fa96e6b42d6eac40563b1d827e3e8981af` |
| `apps/web/src/app/(console)/templates/page.tsx` | `85f0077e98c55de142486e81bec51b0ce0a449772677dbf5b573faabb5178cda` |
| `apps/web/src/app/(console)/contacts/page.tsx` | `9592ba7b13578df18c509e2564b56ff521c0e07069ddeadcd3475706babe273f` |
| `apps/web/src/app/(console)/whatsapp/page.tsx` | `917299f68d816ec465282dbe090a7bb5064ec99ffff2c91ddf9d288f0fc88756` |
| `apps/web/src/components/templates/template-approval-dialog.tsx` | `12fe2a0dfe452168895efb2fe60004216dbe7c39c9bd0a912033e6ed21da6191` |
| `apps/web/src/components/templates/template-create-dialog.tsx` | `1c1b1faca292699eb2e002cf535bb26ba317b191a23412f9f75cd8c04bb19154` |
| `apps/web/src/components/templates/template-status-badge.tsx` | `6bccdbbbb6a4df2ab4c7eb41d6ca6554362b7da875def3be464a031a78d42520` |
| `apps/web/src/components/contacts/consent-status-badge.tsx` | `b8bb9bf664171a0938b943347142dff100fe24b42c0839d8672f23cdbefcd993` |
| `apps/web/src/components/contacts/contact-consent-dialog.tsx` | `7fda4a2ba619c1a5dae84c8649f085540ab347bae7f1aaee9e653fea639e19da` |
| `apps/web/src/components/contacts/contact-create-dialog.tsx` | `687cd1926beb213eafe25ba892c8c727ad0de38f69ece0be9380c569ab1611ce` |
| `apps/web/src/components/whatsapp/attempt-history-card.tsx` | `195b9652af39d261d6639988e848614bdb3b81f919d49bed884ca64613745d6e` |
| `apps/web/src/components/whatsapp/message-status-badge.tsx` | `8f53f11c6127113fd89caff534f19693cecd81e005cf569cabb746b0a208b071` |
| `apps/web/src/components/whatsapp/whatsapp-send-panel.tsx` | `fa133e4997ed9bd801ef90644d104960d2c2a92c26059ec943588ce297972f8c` |
| `apps/web/src/lib/whatsapp-management.test.ts` | `0cd85e3fcad5ea00996d6015c61b7cc4b7aa613378d7396422968018fbe29796` |
| `apps/web/src/lib/whatsapp-security.sec.test.ts` | `b83a06854bd29f8e58eecc7c57635d44f1ed8eb46b2ef1380b828d201566085b` |
| `apps/web/e2e/helpers/auth.ts` | `b981c35e8e21beb7d71718c22f94f7c52450aac29f687b8179f3cf730a4951b4` |
| `apps/web/e2e/whatsapp-console.spec.ts` | `21369519b6d67d2140999a4ab273a30a242d7fa0e9bbd0d48a10495974d8eb58` |
| `scripts/whatsapp-e2e-fixture.mjs` | `f8a5631f31caf5e422904a900f4f100436127ed87f354fd5b49bf1feef1f9cfb` |
| `package.json` (unchanged) | `94f659a133cf20e6f4842392e8e78e78f8e0fc92dea8d6a6196d0dc21eca8dfc` |
| `package-lock.json` | `e03da3b90da00df2d3c5a7efdc60c67ee0011adf0635cf65c489e6bcd89bdc5d` |
| `security/audit-exceptions.json` (unchanged) | `9601043e0ae63e20fa16d327045a844be4d59416f6a2d86e479125a18a3b89e6` |
| `scripts/mutation/run.mjs` (unchanged) | `d3ce5a550736a34b1ce4340764120c910c689b177f4bf6e36e704759670b50c4` |
| `scripts/with-db-clone.mjs` (unchanged) | `1ed8fed9673ae2820722489f485444c73a4059ed278e5c59025032d0e5da39a5` |
| `scripts/mutation/catalogue/step1-high1.json` … `step6-r11.json` | unchanged since `c8114b3` |
| `scripts/mutation/catalogue/item2-0029.json` | `73f716c2d5cf6a2bc4d5e250f83a39df8e302f840bbcd24bd51d0e5124ac6e86` |
| `scripts/mutation/catalogue/item4-0030.json` | `14ed42adabfdb10a2ef122214e5886d68243e7b7577e9709ac45e5c78e15facd` |
| `scripts/mutation/catalogue/item5-platform-asymmetry.json` | `bd775518918bd40ffa692c1dcb8357d33a523261eeff585fb8b48679d50d5e4c` |

- **Schema:** migrations `0000`–`0028` unchanged; `0029`, `0030`, `0031`, `0032`, `0033`, and `0034` added with their snapshots and journal entries.
- **OpenAPI:** `openapi.v1.json` covers all application routes; `openapi:check` passes with zero drift against `metadata.ts`.
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

### Gate E.1 sign-off record and Phase 3.1 Closure — APPROVED (project owner decision, 14-Oct-2026)

**Decision.** Gate E.1 (Phase 3.1 Data Foundation Acceptance) is **APPROVED** by the project owner following final technical closure and evidence audit. Phase 3.1 of Alendei Communications Cloud is formally **CLOSED** under `ROADMAP.md` §6a and ADR-014 §17.1.

**Accepted evidence baseline:**
- **Phase 3.1 Security Suite (`phase3_1-data-foundation.sec-spec.ts`):** 18/18 tests passed across 1 suite.
- **Provider Registry Security Regression (`provider-registry.sec-spec.ts`):** 31/31 tests passed across 1 suite.
- **Schema & Migrations:** Migration `0031_phase3_1_data_foundation.sql` creates 5 Model B content tables (`contacts`, `contact_identities`, `consent_events`, `templates`, `suppressions`) registered with Model B RLS (`app_content_context_valid()`) and least privilege.
- **Commit:** `f08b48e89e7683530b9bc81c757cd6089817f3f6` on branch `develop`, pushed to `origin/develop`.

### Gate E.2 sign-off record and Phase 3.2 Closure — APPROVED (project owner decision, 14-Oct-2026)

**Decision.** Gate E.2 (Phase 3.2 Assignments & Principal Scopes Acceptance) is **APPROVED** by the project owner following final technical closure and authorization review. Phase 3.2 of Alendei Communications Cloud is formally **CLOSED** under `ROADMAP.md` §6a and ADR-014 §17.1.

**Accepted evidence baseline:**
- **Phase 3.2 Security Suite (`phase3_2-assignments-principal.sec-spec.ts`):** 37/37 tests passed across 1 suite covering assignment lifecycle, priority collision/uniqueness, RBAC scope enforcement, anti-enumeration, `acc_dispatch` principal isolation, Model A tenancy RLS, and context function definitions.
- **`app_session_bypasses_rls()` Privilege Audit:** Evaluated to `false` for `acc_dispatch`, pinned to `search_path = public, pg_temp`, reading `session_user` in `pg_roles`; verified safe and explicitly mandated by ADR-014 §9.2 line 142.
- **Regressions & Integrity:** `provider-registry.sec-spec.ts` (31/31), `phase3_1-data-foundation.sec-spec.ts` (18/18), API unit (528/528), API integration (125/125), DB integration (222/222), `openapi:check` (0 drift), `lint`/`typecheck` (0 errors).
- **Schema & Migrations:** Migration `0032_phase3_2_assignments_principal.sql` creates `organization_provider_assignments`, `assignment_status` enum, parent-child FK `(provider_id, channel_id)`, immutability triggers, `acc_dispatch` DB role and RLS policies, and dispatch context functions.
- **Commit:** `4d4c4b75fee7c07d573e383ddfad23abd4731db7` on branch `develop`, pushed to `origin/develop`.

### Gate E.3 sign-off record and Phase 3.3 Closure — APPROVED (project owner decision, 15-Oct-2026)

**Decision.** Gate E.3 (Phase 3.3 Orchestrator & Dispatch Execution Acceptance) is **APPROVED** by the project owner following final technical closure and acceptance audit. Phase 3.3 of Alendei Communications Cloud is formally **CLOSED** under `ROADMAP.md` §6a and ADR-014 §17.1.

**Implementation Baseline & Commit Relationship:**
- **Branch:** `develop`
- **Committed HEAD:** `423d122297ec7cfc593d54cc923359196d4a3c71` (integrated in commit `2c6f529`, stabilized in commits `6572820`, `423d122`)
- **Phase 3.3 Implementation Status:** Formally approved, committed, and pushed to `origin/develop`.

**Accepted Phase 3.3 Scope:**
- **Preflight Validation & Ingestion:** `POST /messages` implements the strict 5-stage preflight validation sequence (Channel exists -> Recipient not suppressed -> Consent not revoked -> Template approved -> Active provider assignment exists), returning `202 Accepted` with payload fingerprinting and idempotency replay deduplication (duplicate request returns identical 202; conflicting payload returns 422).
- **Anti-Enumeration:** `GET /messages/:id` strictly enforces Model B tenant boundary, returning 404 `RESOURCE_NOT_FOUND` for non-existent IDs and cross-tenant attempts.
- **Queue & Database Fencing:** Migration `0033_phase3_3_orchestrator_dispatch.sql` adds `messages`, `message_attempts`, `message_events` (Model B RLS), and `message_dispatch_queue` (Model A RLS). Dispatch claiming uses `FOR UPDATE SKIP LOCKED`, lease management, PostgreSQL session variables (`app.dispatch_message_id`, `app.dispatch_claim_token`), and fencing epoch verification (`dispatch_epoch`).
- **Authoritative Circuit Admission:** Provider submission via `ProviderSubmissionExecutor` strictly verifies Phase 2 `CircuitAdmission` tokens before provider dispatch; forged, expired, or reused admissions fail closed.
- **Dedicated Principal Isolation:** `acc_dispatch` database principal restricted to observation updates on active assigned providers for `app_current_org_id()`. Blocked from modifying administrative/content columns, deleting messages, or inserting audit logs. Fencing guards `fn_message_attempts_fencing_guard()` and `fn_provider_health_attempt_guard()` enforce attempt-to-claim binding.
- **Crash Recovery:** Leases that expire while in `submitting` status are recovered to terminal `failed` with attempt outcome `OUTCOME_UNKNOWN` (non-retryable, avoiding duplicate delivery).
- **Organization Lifecycle Serialization:** Advisory locks serialize organization lifecycle transitions (such as suspension) with active dispatch.
- **WhatsApp Cloud Adapter:** Contract implemented and executed against the deterministic `simulator` adapter.

**Audit & Context Resolution (HIGH-6 and MEDIUM-7):**
- **HIGH-6 (Least Privilege & Audit Suppression):** `acc_dispatch` database role intentionally lacks `INSERT` privilege on `audit_logs` to maintain least privilege. `ProviderStateStore` verifies `if (principal.actorType !== 'system')` prior to invoking `this.access.record()`. Dispatcher-originated system observations skip `audit_logs` insertion where required by least privilege, while the intended provider-health observations (`provider_health` table) and Prometheus metrics evidence remain available. Automated dispatcher observations do not produce audit-log rows.
- **MEDIUM-7 (Correlation ID Fallback):** `RequestContext.correlationId()` safely returns fallback `'no-correlation-id'` when executed outside HTTP request contexts (such as asynchronous background dispatch workers).

**Targeted Mutation Verification (Limited Scope):**
- *Note:* Targeted proofs on isolated critical paths; does not constitute comprehensive mutation coverage across Phase 3.3.
  - **Mutant M1 (Fencing Check Bypass):** Simulated removal of the token and epoch check in `dispatcher.service.ts` `processClaim`. KILLED by `dispatch-fencing-concurrency.int-spec.ts` (Test 3: "aborts settlement if fencing epoch or token was superseded by another worker").
  - **Mutant M2 (Claim Token Verification Bypass):** Simulated bypassing `fn_message_attempts_fencing_guard()`. KILLED by `phase3_3-orchestrator-dispatch.sec-spec.ts` (Test 13: "binds message_attempts insertion to matching dispatch claim token and active provider").

**Documented Test Isolation Constraint:**
- `message_dispatch_queue` is a global table across tenants. Test suites that claim from the queue (`messages-api.int-spec.ts` and `dispatch-fencing-concurrency.int-spec.ts`) require isolated database clones via `scripts/with-db-clone.mjs` to avoid shared queue state interference.

**Exact Validation Results:**
- `phase3_3-orchestrator-dispatch.sec-spec.ts`: 13/13 passed (1.7s)
- `dispatch-fencing-concurrency.int-spec.ts`: 5/5 passed (1.3s)
- `messages-api.int-spec.ts`: 10/10 passed (1.4s)
- `provider-state-dispatcher.int-spec.ts`: 2/2 passed (0.9s)
- `role-assignment.sec-spec.ts` + `platform-admin-liveness.sec-spec.ts`: 83/83 passed (6.6s)
- Database Package Tests (`@acc/db`): 227/227 passed (5 unit, 222 integration; 6.1s)
- API Unit Tests (`@acc/api`): 528/528 passed across 38 suites, including `circuit-admission.architecture.spec.ts` (6.3s)
- Static Checks: `npm run lint` (0 errors), `npm run format:check` (0 issues), `npm run typecheck` (0 errors), `npm run build` (clean monorepo build), `npm run openapi:check` (0 drift), `npm run db:generate -w @acc/db` (0 schema diffs).

**Boundaries & Next Increments:**
- Phase 2 is formally CLOSED. Phase 2.7 remains undefined and unauthorized.
- Phase 3.0 architecture remains FROZEN under ADR-014.
- Phase 3.1 Data Foundation is formally CLOSED (Gate E.1 approved by project owner decision, 14-Oct-2026; commit `f08b48e`).
- Phase 3.2 Assignments & Principal Scopes is formally CLOSED (Gate E.2 approved by project owner decision, 14-Oct-2026; commit `4d4c4b7`).
- Phase 3.3 Orchestrator & Dispatch Execution is formally CLOSED (Gate E.3 approved by project owner decision, 15-Oct-2026; commit `2c6f529`).
- Phase 3.4 Fallback & Resilience is formally CLOSED (Gate E.4 approved by project owner decision, 15-Oct-2026; commit `2c6f529`).

### Gate E.4 sign-off record and Phase 3.4 Closure — APPROVED (project owner decision, 15-Oct-2026)

**Decision.** Gate E.4 (Phase 3.4 Fallback & Resilience Acceptance) is **APPROVED** by the project owner following formal acceptance review and verification audit. Phase 3.4 of Alendei Communications Cloud is formally **CLOSED** under `ROADMAP.md` §6a and ADR-014 §17.4.

**Implementation Baseline & Commit Relationship:**
- **Branch:** `develop`
- **Committed HEAD:** `423d122297ec7cfc593d54cc923359196d4a3c71` (integrated in commit `2c6f529`, stabilized in commits `6572820`, `423d122`)
- **Working-Tree Status:** Phase 3.4 is committed and pushed to `origin/develop` (`2c6f529`…`423d122`). The working tree now carries uncommitted Gate F.1 changes (§2).

**Approved Decisions & Implemented Scope:**
- **P3-D13 (Fallback Eligibility):** Definite failures (`PROVIDER_ERROR`, `RATE_LIMITED`) trigger fallback; in-memory circuit skips advance candidates without attempts; ambiguous outcomes (`TIMEOUT`, `UNKNOWN`) settle terminally as `outcome_unknown` with zero fallback; non-fallback errors (`AUTH_ERROR`, etc.) terminate immediately.
- **P3-D14 (Candidate Exhaustion & Single-Pass Routing):** Ascending priority evaluation (`priority ASC`) excluding previously attempted providers (`provider_id NOT IN (SELECT provider_id FROM message_attempts WHERE message_id = $3)`). Fast terminal failure (`NO_ELIGIBLE_PROVIDER`, 0 attempts, queue deleted) when all circuits open. Terminal failure when fallback candidates exhausted. Zero delayed retry timers.
- **P3-D15 (Timeout Non-Retryability):** `TIMEOUT` and `UNKNOWN` adapter outcomes transition message terminally to `outcome_unknown` and delete queue row.
- **P3-D03 (Dispatcher Crash Recovery):** `recoverExpiredLeases()` transitions expired submitting leases to terminal `outcome_unknown` and deletes queue row; zero blind retry.
- **Option A State Transition Guard (Migration `0034_phase3_4_fallback.sql`):** Replaces `fn_messages_terminal_guard()` restricting `submitting -> queued` strictly to `acc_dispatch` under active claim with verified failed attempt matching claim token and epoch with fallback-eligible reason. Terminal states (`accepted`, `failed`, `outcome_unknown`) remain absolutely immutable.

**Targeted Mutation Proofs (Verified Killed):**
- **Mutant M1 (Database Fallback Authorization Boundary):** Removing Guard 1 (`current_user = 'acc_dispatch' OR app_session_bypasses_rls()`) allows `acc_app` to bypass the boundary and requeue in-flight messages; killed by `phase3_4-fallback-resilience.sec-spec.ts` (`toThrow(/UNAUTHORIZED_REQUEUE/)`).
- **Mutant M2 (Fencing Token & Epoch Settlement Verification):** Disabling fencing check in `processClaim` settlement transaction; killed by `fallback-fencing-concurrency.int-spec.ts` (Test 8) and `dispatch-fencing-concurrency.int-spec.ts` (Test 3).
- **Mutant M3 (Recovery Stale-Worker Protection):** Omitting queue deletion upon terminal recovery in `recoverExpiredLeases()`; killed by `dispatch-fencing-concurrency.int-spec.ts` (Test 4) and `fallback-fencing-concurrency.int-spec.ts` (Test 10).

**Exact Validation Results:**
- `phase3_4-fallback-resilience.sec-spec.ts`: 8/8 passed (1.6s)
- `fallback-fencing-concurrency.int-spec.ts`: 11/11 passed across all 11 scenarios (1.4s)
- `phase3_3-orchestrator-dispatch.sec-spec.ts`: 13/13 passed (1.7s)
- `dispatch-fencing-concurrency.int-spec.ts`: 5/5 passed (1.3s)
- `messages-api.int-spec.ts`: 10/10 passed (1.4s)
- `provider-state-dispatcher.int-spec.ts`: 2/2 passed (0.9s)
- `role-assignment.sec-spec.ts` + `platform-admin-liveness.sec-spec.ts`: 83/83 passed (6.6s)
- Database Package Tests (`@acc/db`): 227/227 passed (5 unit, 222 integration)
- API Unit Tests (`@acc/api`): 528/528 passed across 38 suites
- Static Checks: `npm run lint` (0 errors), `npm run format:check` (0 issues), `npm run typecheck` (0 errors), `npm run build` (clean monorepo build), `npm run openapi:check` (0 drift), `npm run db:generate -w @acc/db` (0 schema diffs), `git diff --check` (0 errors).

**Boundaries & Next Increments:**
- Phase 3.3 is formally CLOSED (Gate E.3 approved).
- Phase 3.4 is formally CLOSED (Gate E.4 approved).
- Phase 3.5 is formally CLOSED (Gate E.5 approved by project owner decision, 16-Oct-2026; `DECISIONS.md` §1v). Phase 3 of Alendei Communications Cloud is formally CLOSED.

### Gate E.5 sign-off record and Phase 3 Closure — APPROVED (project owner decision, 16-Oct-2026)

**Decision.** Gate E.5 (Phase 3.5 WhatsApp Management Console Acceptance) is **APPROVED** by the project owner following final acceptance review and verification audit. Together with Gates E.1 through E.4, Phase 3 of Alendei Communications Cloud is formally **CLOSED** under `ROADMAP.md` §6a and ADR-014 §17.5.

**Accepted Implementation Scope & Verification:**
- **Navigation Shell Integration (`apps/web/src/app/(console)/layout.tsx`):**
  - Added `WhatsApp` (`/whatsapp`), `Templates` (`/templates`), and `Contacts` (`/contacts`) sections.
  - Dynamically gated navigation items using centralized permission checks (`canReadMessages || canSendMessages`, `canReadTemplates`, `canReadContacts`).
- **Template Management (`/templates`):**
  - Template listing with channel, status, and search filters; keyset pagination; empty/loading/error states.
  - Template creation dialog (`template-create-dialog.tsx`) with dynamic token detection (`{{1}}`, `{{name}}`), channel selector, and idempotency key generation.
  - Simulated approval dialog (`template-approval-dialog.tsx`) supporting internal state progression (`draft` -> `pending` -> `approved` / `rejected`) with explicit disclaimer distinguishing internal simulation from Meta provider approval.
  - Status badges with simulator notices (`template-status-badge.tsx`).
- **Contact & Consent Management (`/contacts`):**
  - Workspace selector enforcing Model B tenancy boundaries.
  - Contact directory listing with phone identity and effective consent badges (`opted_in`, `opted_out`, `unconsented`).
  - Contact creation dialog (`contact-create-dialog.tsx`) with phone identity attachment and initial consent declaration.
  - Consent event modal (`contact-consent-dialog.tsx`) for appending immutable grant/revoke records.
- **WhatsApp Send-Test & Settlement Monitor (`/whatsapp`):**
  - Workspace selector and approved template dropdown with dynamic variable inputs or custom JSON payload option.
  - Recipient phone validation, visible idempotency key input with automatic generation and reuse across retry attempts.
  - Real-time submission via `POST /messages` returning `202 Accepted`.
  - Settlement Monitor (`attempt-history-card.tsx`): 1-second bounded polling that displays live message status, duration/latency, settled provider, failure reason/code, and full attempt history.
  - Explicit delivery disclaimer: clearly warns operators that `PROVIDER_ACCEPTED` confirms gateway/provider acceptance only, NOT delivery to recipient handset.
  - Polling lifecycle guard: polling terminates immediately upon reaching terminal state (`accepted`, `failed`, `outcome_unknown`), error, or component unmount.
- **API Client & Session Infrastructure (`apps/web/src/lib/`):**
  - `templatesApi`, `contactsApi`, `messagesApi` in `api-client.ts` with typed error handling and `X-Acc-Organization` pinning.
  - Session store permission helpers: `useCanReadTemplates()`, `useCanManageTemplates()`, `useCanReadContacts()`, `useCanManageContacts()`, `useCanReadMessages()`, `useCanSendMessages()`.

**Verification Evidence:**
- **WhatsApp Management Unit Suite (`apps/web/src/lib/whatsapp-management.test.ts`):** 8/8 tests passed (templates, contacts, messages API client methods and idempotency headers).
- **WhatsApp Security Suite (`apps/web/src/lib/whatsapp-security.sec.test.ts`):** 11/11 tests passed (SEC-WA-01 through SEC-WA-11: organization pinning, header forgery rejection, organization switching, idempotency key preservation across retries, fail-closed permissions, platform-admin tenant boundary, in-memory credential confinement, terminal state polling cancellation, outcome type separation, cross-tenant 404 anti-enumeration without metadata leakage, and permission-denied 403 fail-closed non-retryable ApiError).
- **Web Package Regression:** 314/314 tests passed across 45 suites (`npm run test -w @acc/web`), including 195/195 security tests across 27 suites (`npm run test:security -w @acc/web`).
- **Database Package Regression:** 227/227 tests passed (5 unit, 222 integration; `@acc/db`).
- **API Unit Regression:** 528/528 tests passed across 38 suites (`@acc/api`).
- **Role-Assignment / Admin-Liveness Regression:** 83/83 tests passed.
- **Next.js Production Build:** Clean build with 16/16 routes compiled (`npm run build -w @acc/web`).
- **WhatsApp Playwright E2E Suite (`apps/web/e2e/whatsapp-console.spec.ts`):** 6/6 tests passed in 9.8s against a disposable database clone (`scripts/with-db-clone.mjs`) provisioned with `scripts/whatsapp-e2e-fixture.mjs`:
  - `E2E-WA-01`: Direct URL navigation to `/templates`, `/contacts`, `/whatsapp` enforces canonical zero-organization boundary (`No Organization Access`) for persona holding zero org memberships (`zeroOrg`).
  - `E2E-WA-02`: Tenant admin views WhatsApp templates table with filter controls (search, channel, status).
  - `E2E-WA-03`: Exercises full simulated approval lifecycle (`draft` -> `pending` -> `approved`) with simulator disclaimer visibility.
  - `E2E-WA-04`: Creates contact with phone identity and records append-only consent event.
  - `E2E-WA-05`: Dispatches message via WhatsApp send panel (`POST /messages` -> `202 Accepted`), verifies real-time Settlement Monitor with latency, status badge, and attempt history table.
  - `E2E-WA-06`: Unauthorized tenant user lacking content permissions (`teamReader`) is denied access at UI boundary (`Access Forbidden`) upon direct navigation to `/templates`, `/contacts`, and `/whatsapp`.
- **Database & Environment Isolation:** E2E tests executed strictly against disposable clones via `scripts/with-db-clone.mjs`; disposable clone dropped `WITH (FORCE)` on exit and verified gone; template `acc_r015_base` row-count fingerprint unchanged; background processes and listeners cleanly terminated.

### Phase 3 Finalization & CI Remediation Record (16-Oct-2026)

**Commit History:**
- **Commit `2c6f52915d30c1ecaf92244b75852dd1554b28af`:** Atomic implementation commit covering Phase 3.3, 3.4, and 3.5, and documentation closure of Gates E.3–E.5.
- **Commit `6572820f01d805f3b10417cb95a3ebcdb3c44479`:** CI remediation commit 1.
  - *Root Cause 1 (Gitleaks):* Synthetic test fixture variable `idemKey` in `apps/web/src/lib/whatsapp-security.sec.test.ts` triggered Gitleaks rule `generic-api-key`. Remediated by adding targeted rule exception in `.gitleaksignore` and disambiguating variable name.
  - *Root Cause 2 (Provider Configuration Listener):* Unhandled promise rejection / event listener leak in provider configuration listener during concurrent queue tests. Remediated by robust error handling in listener.
- **Commit `423d122297ec7cfc593d54cc923359196d4a3c71`:** CI remediation commit 2.
  - *Root Cause 3 (Shared DB Container Fixture Pollution):* In GitHub Actions workflow `integration / database / security`, integration tests (`test:integration`) and security tests (`test:security`) run sequentially against a single persistent PostgreSQL container. Phase 3 integration suites (`messages-api.int-spec.ts`, `dispatch-fencing-concurrency.int-spec.ts`, `fallback-fencing-concurrency.int-spec.ts`, `provider-state-dispatcher.int-spec.ts`) created tenant fixtures, provider assignments, and messages that persisted after suite completion, causing foreign-key constraint violations and unexpected provider counts in subsequent suites (`provider-registry.sec-spec.ts`, `phase3_2-assignments-principal.sec-spec.ts`, etc.). Remediated by extending `destroyTenant()` in `apps/api/test/auth-harness.ts` to cascade-clean Phase 3 tables (`message_attempts`, `message_events`, `messages`, `message_dispatch_queue`, `organization_provider_assignments`, `consent_events`, `suppressions`, `contact_identities`, `contacts`, `templates`) and implementing exhaustive `afterAll` teardown routines across all Phase 3 integration suites.

**CI Verification Evidence:**
- **GitHub Actions Workflow Run:** `38880983348` (triggered via push of commit `423d122297ec7cfc593d54cc923359196d4a3c71`) passed with **100% success** across all five jobs:
  1. `integration / database / security`: passed (4m 16s)
  2. `OpenAPI contract drift`: passed (31s)
  3. `lint / typecheck / build`: passed (1m 15s)
  4. `secret scan`: passed (8s)
  5. `dependency audit`: passed (27s)

## 7. Residual risks (documented, accepted — not closed)

- **Simulator-only limitation** — WhatsApp submissions are executed strictly against the deterministic simulator; no real Meta credentials or vendor endpoints connected in Phase 3.3.
- **Delivery and webhooks excluded** — No inbound webhooks, delivery receipts, delivery status simulation, or DLR handling exist in Phase 3.3.
- **Provider fallback delivered for same-channel WhatsApp** — Provider-to-provider fallback within the WhatsApp channel is implemented in Phase 3.4; cross-channel fallback (e.g. WhatsApp -> SMS) and delayed retry timers remain deferred to Phase 5.
- **R-13 in-process bypass** — caught only by the static boundary test and review (`DECISIONS.md` §1o; `PROVIDER_ADAPTER.md` §6h).
- **`app.current_user_id` / `app.current_api_key_id` forgery** — confined to one organization's content (`SECURITY.md` §4b).
- **System role key or `is_system_role` rewrite** by an owner or seeder transaction — not guarded by `0028` / `0030` (the seed's conflict update does not set `is_system_role`).
- Role-widening guard at REPEATABLE READ/SERIALIZABLE checks through the transaction snapshot; the liveness rules rely on READ COMMITTED.
- **Cross-scope advisory-lock ordering** — owner-level multi-scope statements can deadlock against canonical-order paths; PostgreSQL aborts one (`40P01`; an API victim answers HTTP `500`); the invariant holds (`DECISIONS.md` §1o, item 4, decision 2).
- The reseller-deletion exemption is unreachable while `trg_resellers_grant_restrict` (`0025`) is in place.
- Real-provider health checks are un-admitted outbound calls by design; MEDIUM-6 unchanged; HIGH-6 and MEDIUM-7 resolved under Phase 3.3.
- Items 1 and 3 deferred (§6).

**Evidence qualifications (non-blocking):** the three step 3 race mutants are caught by wait timeouts rather than explicit assertions; E1 is equivalent by reasoning only; item 5's unauthorized-principal tests prove the absence of a revocation audit row, not of every audit event; `RevocationWorld.teardown`, both `removeIdentities` helpers and the inline teardown blocks still assume migration `0030` (every catalogue command that reaches them migrates first); `run.mjs` leaves an orphaned clone if it kills a command on timeout and does not remove its active worktree on SIGTERM. Item 4 M1 produced teardown noise and was caught by its intended assertion failures. CI has since passed (run `37969162005`, §4; run `38880983348`, Gate E.5 / Phase 3 closure).

## 8. Test infrastructure and databases

- **Template `acc_r015_base`** — `template0` + migrations `0000`–`0024` from worktree `wt-0024` at `1bc7fd9`, seeded; fingerprint `all=902f22bc20c8a3f9ce80f67407804cb5`. Clone source only; intentionally frozen at migration `0024`. Every validation run reported it unchanged.
- Databases present (17-Oct-2026): `acc`, `acc_gateb`, `acc_p23`, `acc_p23_fresh`, `acc_p24`, `acc_r015_base`, and **one leftover clone, `acc_clone_436072f90852`** (created 16-Oct-2026 10:31 UTC by an earlier run; still held open by an idle `acc-provider-config-listener` connection; preserved as evidence for the 0033 discrepancy; disposal needs owner authorization). No `acc_tmp_*` database exists.
- **`acc` migration-history integrity: UNRESOLVED.** The 0033 row's hash was edited in place on 16-Oct-2026, and parts of 0033 were applied to `acc` outside the migration runner (`DECISIONS.md` §1w.8). Do not use `acc` as evidence of migration history. Do not edit `drizzle.__drizzle_migrations` rows. `acc_gateb` (18 migrations, last 28-Sep-2026) was not used by this remediation. `acc_p24_fresh` was lost on 07-Oct-2026 (`TESTING.md` §6q, "Process incident"); never recreate it.
- **Rule** (`TESTING.md` §6q): a script that creates or drops a database hard-codes the name and refuses anything outside an allowlisted throwaway pattern or naming a reference database.
- **Disposable database test procedure:** Run DB-touching suites through `node scripts/with-db-clone.mjs -- <cmd>` with the four `DATABASE_*_URL` pointing at `acc_r015_base`, `NODE_ENV` unset, `RATE_LIMIT_AUTH_MAX=10 RATE_LIMIT_REFRESH_MAX=30`, and `TMPDIR` on disk. Because `acc_r015_base` is intentionally frozen at migration `0024`, test suites that require migrations beyond `0024` (currently `0025`–`0034`, e.g., teardown trigger `trg_user_roles_reseller_admin_liveness` in `auth-harness.ts`) require that the disposable clone be migrated through the current migration set before running tests:
  ```bash
  node scripts/with-db-clone.mjs -- bash -c "npm run db:migrate --workspace @acc/db && npm --workspace=@acc/api run test:integration"
  node scripts/with-db-clone.mjs -- bash -c "npm run db:migrate --workspace @acc/db && npm --workspace=@acc/api run test:security"
  ```
  Migrations must never be applied to the persistent template `acc_r015_base` or to persistent development databases as part of test setup. **Caution:** `npm run db:migrate` ends with `ALTER ROLE … LOGIN PASSWORD` on `acc_app`, `acc_auth`, `acc_relay` and `acc_dispatch`. Those roles are cluster-wide and shared by every database, so running it inside a clone still changes shared state. Gate F.1 evidence instead used a migrator-only script with a clone-name guard, and confirmed with a role digest that no shared role changed (`DECISIONS.md` §1w.8). Whether to adopt that as the standard procedure is an open owner decision. The disposable clone is dropped `WITH (FORCE)` on every exit path and verified gone. Mutation: `node scripts/mutation/run.mjs scripts/mutation/catalogue/<name>.json --out <dir>`; for uncommitted work, run it from a candidate worktree built as in §4. With `jest --selectProjects`, use `--testPathPatterns`, never a bare path.

## 9. Next actions (in order; each needs the user's explicit approval)

1. Phase 3 is committed, pushed, and verified passing in CI on `develop` (`423d122297ec7cfc593d54cc923359196d4a3c71`).
2. Gate F.1 is APPROVED (17-Oct-2026); its working-tree changes are uncommitted. Commit and push only on explicit instruction.
3. Phase 4.2 (Gate F.2): a planning proposal has been presented for owner review. Implementation is NOT authorized.
4. Separately authorized operational tasks (`DECISIONS.md` §1w.10): G, separate schema migration from shared-role reconciliation; E, migration-history recovery; F, evidence preservation and cleanup of `acc_clone_436072f90852` and the orphaned test process. No migration `0035`+ until G and then E are resolved.
5. Items 1 and 3 stay deferred until the user schedules them.

## 10. DO NOT

- Do not commit, push, amend, rebase, squash or merge without explicit instruction.
- Do not change `package.json`, `package-lock.json`, `security/audit-exceptions.json` or dependencies without instruction.
- Do not alter migrations `0000`–`0034` or the OpenAPI snapshot.
- Do not reopen decided items or change code "while there"; items 1 and 3 stay deferred.
- The gates — the ADR-015 remediation gate (09-Oct-2026), Gate C (02-Oct-2026), Gate D/D.6 (13-Oct-2026), Gate E.1 (14-Oct-2026), Gate E.2 (14-Oct-2026), Gate E.3 (15-Oct-2026), Gate E.4 (15-Oct-2026), Gate E.5 (16-Oct-2026), and Gate F.1 (17-Oct-2026) — are recorded as APPROVED / CLOSED. Do not reopen them without an explicit decision, except where new evidence requires investigation of a potential security defect, regression, or material change to the accepted risk. Phase 3 is formally CLOSED.
- Do not start Phase 4 without explicit project-owner authorization.
- Do not touch `main`, `stash@{0}`, `acc_gateb`, `acc_p24`, `acc_r015_base` or any reference database; mutations only on throwaway clones.
- Do not delete branch `r13-structural-admission` or worktree `wt-0024` without instruction.
