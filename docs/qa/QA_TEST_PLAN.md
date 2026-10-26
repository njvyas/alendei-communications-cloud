# Internal QA test plan (round 1)

Environment and accounts: `INTERNAL_QA_DEPLOYMENT.md` (§7 personas, §8 data). Usability observations: `USABILITY_FEEDBACK_TEMPLATE.md`. QA release: `2026.10.24-441a29a` (commit `441a29a`; application code identical to the baseline `554dea370e84fd6b25589d9cb63309eaec03c636`). Record the deployed tag on every result.

**How to use.** Run each test with the stated persona. Fill **Actual** with `PASS`, or `FAIL — <what happened>`, or `BLOCKED — <why>`. Attach the evidence named. A failing test's **Severity** is the default; raise it if the impact is worse. Record usability friction separately even when a test passes.

**Severity:** S1 Critical (security/tenant breach, data loss, nothing works) · S2 Major (core task fails, no workaround) · S3 Minor (workaround exists) · S4 Cosmetic.

**Channel of execution:** **UI** = console; **API** = HTTP call (operator provides a `curl` snippet and a token, `INTERNAL_QA_DEPLOYMENT.md` §8a); **OPS** = operator command on the host. Marked **DEFERRED** = not implemented in this release; record nothing but confirm the gap is real if you encounter it.

**Organizations and personas (26-Oct-2026).** *QA Org A* (`qa-org-a`) is **closed** (a terminal state) and must not be used. This plan uses *QA Org A2* (`qa-org-a2`) and *QA Org B2* (`qa-org-b2`), created by the platform operator on 24-Oct-2026, and a new *QA Org C* (`qa-org-c`) for organization-lifecycle and assignment-administration tests that must not disturb A2 or B2. Personas follow the organizations: `qa-org-a2-admin`, `qa-org-a2-ws-manager`, `qa-org-a2-team-reader`, `qa-org-a2-agent`, `qa-org-a2-reader`, `qa-org-b2-admin`. `qa-platform-admin` is the single bootstrap platform administrator (`INTERNAL_QA_DEPLOYMENT.md` §7). Rows already marked **PASS** keep the names used when they were run.

**Findings.** Record every defect, concern or plan mismatch in `QA_FINDINGS_REGISTER.md`, with severity, reproduction steps, expected and actual behaviour, evidence and disposition.

**Evidence provenance.** Mark each result as tester-run, operator-run or **Agent-run** (executed by Claude Code; `QA_RELEASE_PREPARATION.md` §5). An Agent-run API result does not replace a console test or its screenshot.

**Evidence conventions:** screenshot of the final screen including the URL bar; for API tests the status line and response body (redact tokens); message/correlation IDs; `$C logs api` excerpt (operator) where noted.

---

## A. Authentication and account activation

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-A-01 | qa-platform-admin, activated | Sign in at `/login` with correct email and password | Console shell opens; nav shows platform sections | | S1 | screenshot |
| QA-A-02 | any active user | Sign in with a wrong password | Inline alert "invalid credentials" style message; no detail about whether the email exists | | S2 | screenshot |
| QA-A-03 | any | Sign in with an email that does not exist | Same message as A-02 (no account enumeration) | | S1 | screenshots A-02 and A-03 side by side |
| QA-A-04 | any | 11 wrong sign-ins within one minute from the same machine | 11th attempt shows a rate-limit message with a retry time | | S2 | screenshot |
| QA-A-05 | user created via "Invite User", **not** activated | Try to sign in | Refused; the account cannot sign in until activated | | S1 | screenshot |
| QA-A-06 | OPS + qa-platform-admin; an invited user in QA Org A2 | Operator runs `activate-user` (deployment §7) with a 16+ character password piped on stdin | Output `User activated: <email> (organization <slug>)`; the user can now sign in | | S2 | operator output (no password) |
| QA-A-07 | OPS | Run `activate-user` again for the same user | `user activation refused: the user is active, not invited`; exit 1 | | S2 | operator output |
| QA-A-08 | OPS | Run `activate-user` with a password shorter than 12 characters | Refused with "at least 12 characters"; password not printed | | S2 | operator output |
| QA-A-09 | OPS | Activate a user of QA Org B2 while naming QA Org A2 | Refused "holds no grant in organization …" | | S1 | operator output |
| QA-A-10 | OPS | Run `activate-user` naming an org-admin (not platform admin) as `--operator` | Refused "operator must be an active platform administrator" | | S1 | operator output |
| QA-A-11 | signed-in user | Click "Sign out", then press the browser Back button and reload | Returns to `/login`; protected pages do not render data | | S2 | screenshot |
| QA-A-12 | signed-in user | Stay idle > 15 minutes, then act | Session is refreshed silently, or the user is sent to `/login` — never a broken page | | S3 | note + screenshot |
| QA-A-13 | qa-platform-admin | Disable a user (A-06's user) from `/users/[id]`, then that user tries to sign in | Disable requires confirmation; sign-in refused afterwards | | S1 | screenshots |
| QA-A-14 | — | Self-service password reset / invitation link | **DEFERRED** — not implemented (operator activation only) | | — | — |
| QA-A-15 | — | View or revoke own sessions in the console | **DEFERRED** — API exists, no console screen | | — | — |

## B. Organization, user and role management

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-B-01 | qa-platform-admin | `/organizations` → "+ Create Organization": name *QA Org C*, slug `qa-org-c`, reseller left default | Organization created with status active; appears in the list | | S2 | screenshot |
| QA-B-02 | qa-platform-admin | Open `/organizations` | *QA Org A2*, *QA Org B2* and *QA Org C* listed as active; *QA Org A* listed as closed | | S2 | screenshot |
| QA-B-03 | qa-platform-admin | Create an organization with an existing slug | Refused with a clear conflict message | | S3 | screenshot |
| QA-B-04 | qa-platform-admin, QA Org A2 selected | `/users` → "+ Invite User": email, role `org_admin`, scope organization | User created as **invited**; dialog states no email is sent | | S2 | screenshot |
| QA-B-05 | qa-org-a2-admin (activated) | Sign in; check the nav | Organizations, Workspaces, Teams, Users, Roles, API Keys, Audit Logs, Templates, Contacts, WhatsApp visible; no Providers/Channels | | S2 | screenshot of nav |
| QA-B-06 | qa-org-a2-admin | `/workspaces` → create *QA WS 2*; `/teams` → create *QA Team 1* in *QA WS 2* | Both created and listed | | S2 | screenshots |
| QA-B-07 | qa-org-a2-admin | Invite `qa-org-a2-ws-manager` with `workspace_manager` at workspace *QA WS 2* | Created invited; after OPS activation the user sees only what that scope allows | | S2 | screenshots |
| QA-B-08 | qa-org-a2-admin | Invite `qa-org-a2-team-reader` (`read_only`, team *QA Team 1*) and `qa-org-a2-agent` (`agent`, team *QA Team 1*) | Created; after activation their nav is reduced accordingly | | S2 | screenshots of each nav |
| QA-B-09 | qa-org-a2-admin | `/users/[id]` of the team reader → "+ Assign Role" → `read_only` at organization scope; then "Revoke" it | Grant appears in Role Assignments; revoke asks for confirmation and removes it | | S2 | screenshots |
| QA-B-10 | qa-org-a2-admin | Try to revoke their **own last** `org_admin` grant | Refused: an organization must keep an administrator | | S1 | screenshot |
| QA-B-11 | qa-org-a2-admin | `/roles` → "+ Create Custom Role" with `contacts.read`, `messages.read`; assign it to the team reader | Role created; assignment succeeds | | S3 | screenshots |
| QA-B-12 | qa-org-a2-ws-manager | Try to create a custom role including `messages.send` | Refused (cannot confer a permission it does not hold) | | S1 | screenshot |
| QA-B-13 | qa-platform-admin | `/organizations/[QA Org C]` → "Suspend" with a reason, then "Reactivate" | Status changes each time; both appear in Audit Logs | | S2 | screenshots |
| QA-B-14 | qa-org-a2-admin | Archive *QA Team 1*, then restore it | Archive/restore require confirmation; status updates | | S3 | screenshots |
| QA-B-15 | — | Reseller administrator appoints an organization administrator | **DEFERRED / not allowed in this MVP** (platform administrators onboard organizations) | | — | — |
| QA-B-16 | — | Create or manage resellers | **DEFERRED** — no reseller management exists; only the seeded *Alendei Direct* | | — | — |

## C. Contacts and templates

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-C-01 | qa-org-a2-admin | `/contacts` → select the default workspace → "Create Contact" (name, phone `+12025550101`, WhatsApp identity, opt-in) | Contact listed | | S2 | screenshot |
| QA-C-02 | qa-org-a2-admin | Create 9 more contacts (`+12025550102`…`110`), opt-in for half | All listed; pagination works | | S3 | screenshot |
| QA-C-03 | qa-org-a2-admin | Create a contact with an invalid phone (`12345`) | Refused with a field-level message | | S3 | screenshot |
| QA-C-04 | qa-org-a2-admin | "Manage Consent" on a contact → revoke | Consent shows revoked | | S2 | screenshot |
| QA-C-05 | qa-org-a2-admin | `/templates` → "Create Template" `qa_welcome` with variable `{{1}}` | Template listed as draft | | S2 | screenshot |
| QA-C-06 | qa-org-a2-admin | "Simulate Approval": draft → pending → approved; create `qa_promo` and move it to rejected | Status badges update; simulator disclaimer visible | | S2 | screenshots |
| QA-C-07 | qa-org-a2-team-reader | Open `/templates` and `/contacts` | "Access Forbidden" (no content permissions at team scope) | | S1 | screenshots |
| QA-C-08 | qa-org-b2-admin | Open `/contacts` and `/templates` | Only QA Org B2 data; nothing from QA Org A2 | | S1 | screenshots |
| QA-C-09 | — | Edit or delete a template; edit a contact; search contacts | **DEFERRED in the console** (API exists for templates; no console action) | | — | — |
| QA-C-10 | qa-org-a2-admin | `/suppressions` → add a suppression for `+12025550103` (the API `POST /suppressions` is an alternative); after E-05, lift it with a reason | Created and listed as active; lifted with the reason recorded | | S3 | screenshots |

## D. Provider configuration

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-D-01 | qa-platform-admin | `/providers` → "+ Create Provider": WhatsApp, `QA Sim OK` | Created (disabled); detail page opens | | S2 | screenshot |
| QA-D-02 | qa-platform-admin | Provider detail → "Enable" | Status active after confirmation | | S2 | screenshot |
| QA-D-03 | qa-platform-admin | Create `QA Sim 500`; capabilities "Edit" → key `simulator_behavior`, value `"500"`; enable | Capability saved; provider active | | S2 | screenshot |
| QA-D-04 | qa-platform-admin | Create `QA Sim Timeout` (`"TIMEOUT"`) and `QA Sim 429` (`"429"`); enable | Saved; active | | S3 | screenshot |
| QA-D-05 | qa-platform-admin | Test-send panel on `QA Sim OK` with behavior SUCCESS, then 500 | Success, then a failure result; health history updates | | S2 | screenshots |
| QA-D-06 | qa-platform-admin | "Run Probe", "Override" health, "Drain", "Disable", "Enable" | Each transition confirmed and reflected in status and audit | | S2 | screenshots |
| QA-D-07 | qa-platform-admin | "Circuit Policy" → change a threshold and save | Saved; shown on reload | | S3 | screenshot |
| QA-D-08 | qa-platform-admin; `/organizations/[id]` | Open `/organizations/[id]` Provider Assignments panel. List existing assignments; "+ Assign Provider" (dialog with eligible provider selection, priority, initial status); "Change Routing Priority"; "Disable Assignment" / "Enable Assignment" toggle. | Provider Assignments panel renders seeded rows in ascending priority order; Add, Edit Priority, and Toggle status mutations persist to DB and across page reloads with action feedback banners. Client pre-filters assigned providers. Direct API duplicate provider/priority rejected with 409 conflict codes. Cross-tenant reads rejected with 404. Non-platform tenant operator cannot access or view provider assignments (DOM suppressed, API 403 AUTHZ_SCOPE_DENIED). | **PASS** — Real-browser QA acceptance executed on `develop` at tested commit `2c93f772d786b63962f19cecc91fef6e0ebce994` using disposable clone database and live Web/API stack. Scenarios 1–7 verified: listing seeded assignments (#1 QA Sim 500 active, #2 QA Sim OK active for Org A; #1 QA Sim OK active for Org B); adding QA Sim 429 at priority 3 with DB persistence; updating priority to #4 with ascending ordering and reload persistence; toggle disable/enable with reload persistence and DB status sync; client pre-filtering and backend 409 conflict responses (`PROVIDER_ASSIGNMENT_CONFLICT`, `ASSIGNMENT_PRIORITY_CONFLICT`); tenant isolation in UI/API (cross-tenant 404 `PROVIDER_ASSIGNMENT_NOT_FOUND`); and operator authorization boundary enforcement for tenant operator `qa-org-b-admin` (`<ProviderAssignmentsCard>` completely omitted from DOM, direct API calls return 403 `AUTHZ_SCOPE_DENIED`). Evidence captured via 11 screenshots in disposable run; clone DB cleanly dropped and template verified unchanged. | S2 | FE-1 real-browser QA acceptance run (2026-10-23); screenshots 01-09 |
| QA-D-09 | qa-org-a2-admin | Try `/providers` and `/channels` | Not in nav; direct URL shows no provider administration | | S1 | screenshot |

## E. Message submission, dispatch, status and failure handling

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-E-01 | qa-org-b2-admin; Org B2 → `QA Sim OK` | `/whatsapp` → recipient `+12025550201`, custom text → "Send WhatsApp Message" | Settlement monitor appears; status reaches `PROVIDER_ACCEPTED` within a few seconds; one attempt row | | S1 | screenshot incl. message ID |
| QA-E-02 | qa-org-b2-admin | Send using approved template `qa_welcome` with its variable | Accepted; the message records the `templateId` and stores the supplied variables unchanged in its payload. **WhatsApp template use in sends is UNRESOLVED (P3-D22/P3-D24):** the server does not render WhatsApp templates or validate their variables, and the provider submission has no structured template fields, so the dispatcher passes the payload as JSON text (`RELEASE.md` §11). A PASS here is **not** evidence of provider-ready template dispatch | | S2 | screenshot of the message detail (template ID and payload) |
| QA-E-03 | qa-org-b2-admin | Try to send with a draft or rejected template | Refused before sending (`TEMPLATE_NOT_APPROVED`) | | S2 | screenshot |
| QA-E-04 | qa-org-a2-admin | Send to the contact whose consent was revoked (C-04) | Refused (`CONSENT_REVOKED`) | | S1 | screenshot |
| QA-E-05 | qa-org-a2-admin | Send to the suppressed number (C-10) | Refused (`RECIPIENT_SUPPRESSED`) | | S1 | screenshot |
| QA-E-06 | qa-platform-admin + qa-org-b-admin | Temporarily disable Org B's assignment via console UI (`/organizations/[id]`), Org B admin sends WhatsApp message; re-enable assignment in console UI, Org B admin retries | Refused (`NO_ACTIVE_PROVIDER_ASSIGNMENT`); re-enable restores routing and message is accepted (`status: 'queued'`) | **PASS** — Real-browser QA acceptance executed on `develop` at tested commit `2c93f772d786b63962f19cecc91fef6e0ebce994` using disposable clone database and live Web/API stack. Platform admin disabled Org B's WhatsApp provider assignment via UI (`<ProviderAssignmentsCard>` toggle dialog). Message submission by `qa-org-b-admin` accurately refused with HTTP 422 Unprocessable Entity (error code `NO_ACTIVE_PROVIDER_ASSIGNMENT`, message 'No active provider assignment for this channel'). Platform admin re-enabled assignment via UI (status restored to Active). Retried message submission accepted and queued with HTTP 202 (`status: 'queued'`). Evidence captured via screenshots in disposable run; clone DB cleanly dropped. | S2 | QA-E-06 real-browser / API lifecycle acceptance run (2026-10-23); screenshots 10-11 |
| QA-E-07 | qa-org-b2-admin | "Inspect Existing Message by UUID" with E-01's ID | Same final state and attempts shown | | S2 | screenshot |
| QA-E-08 | qa-org-b2-admin | Send twice quickly to a new number `+12025550299` | Both accepted; no error (concurrent first send) | | S2 | screenshots |
| QA-E-09 | qa-org-a-admin / qa-org-b-admin; `/messages` | Browse list/history of dispatched messages (`/messages`); apply channel/status filters, pagination, inspection modal, and switch organizations | Message List Console renders with filters, keyset pagination, permanent recipient masking, attempt detail inspection, and tenant-scoped query isolation | **PASS** — 23-Oct-2026 disposable-stack acceptance run on branch `fix/fe-3-remediation` (33 synthetic messages): All checks passed (100% success). Spot checks M-01–M-04 passed (channel filter, status filter, badge semantics, detail modal inspection with 142 ms latency, and cross-tenant anti-enumeration 404). M-08 verified: advancing Org A to page 2 (5 rows), switching to Org B clears the cursor on all captured Org B requests, resets filter dropdowns to 'all', renders only Org B's 3 rows on page 1, and disables Previous/Next pagination. M-09 verified: API permanently masks recipient addresses in list and detail responses (`+1 •••• 0199`, `u••••r@example.com`), sanitizes failure reasons and nested payload recipients with zero raw recipient leaks, while strictly preserving unrelated business numbers (`+18005551234`), webhook URLs, and queues. Storage sweep confirmed zero tokens in localStorage/sessionStorage. Clone database dropped cleanly and template fingerprint verified unchanged. Shared QA VM environment remained untouched under read-only preflight guardrails. | S2 | FE-3 QA acceptance run (2026-10-23) |
| QA-E-10 | — | Delivery receipts (delivered/read) | **DEFERRED** — simulator submission outcomes only; `PROVIDER_ACCEPTED` is not delivery | | — | — |

## F. Fallback and retry behavior

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-F-01 | qa-org-a2-admin; Org A2 → `QA Sim 500` p1, `QA Sim OK` p2 | Send a message | `PROVIDER_ACCEPTED`; attempts table shows #1 failed (500 provider), #2 accepted | | S1 | screenshot of attempts |
| QA-F-02 | qa-platform-admin + qa-org-a2-admin | Disable `QA Sim OK` (or its assignment); Org A2 sends | `FAILED` with no eligible provider; one failed attempt | | S2 | screenshot |
| QA-F-03 | qa-platform-admin + qa-org-a2-admin | Assign only `QA Sim Timeout` to Org A2; send | `OUTCOME_UNKNOWN`; exactly one attempt; never retried | | S1 | screenshot |
| QA-F-04 | qa-platform-admin + qa-org-a2-admin | Assign `QA Sim 429` p1, `QA Sim OK` p2; send | Falls back on rate limit; accepted on attempt #2 | | S2 | screenshot |
| QA-F-05 | qa-org-a2-admin | Restore the D-08 assignments; send 5 messages | All accepted; one or two attempts each, never more than the number of providers | | S2 | screenshot of each |
| QA-F-06 | — | Cross-channel fallback (WhatsApp → SMS) or timed retries | **DEFERRED** (later phase) | | — | — |
| QA-F-07 | ops / automation; BE-DISPATCH-01 acceptance | Sim 500 scenario: 10 messages enqueued for a provider consistently returning HTTP 500 under default `min_samples=5` policy (5 physical provider attempts occur; remaining 5 messages refused by open circuit without provider attempts) and configured `min_samples=10` policy (all 10 messages execute physical attempts). One-off acceptance run archived under `scratch/`. | Breaker transitions `closed` -> `open` without SQLSTATE 42501 error; settlements commit under `acc_dispatch`; messages settle terminally as `failed`; exactly 0 messages in `outcome_unknown`; 0 unrecovered leases; clean clone cleanup | **PASS** — Verified on `develop` (HEAD `5a556cb`) via fresh disposable database clone (`acc_clone_3e2f28607884`) as a one-off acceptance run archived under `scratch/sim500-acceptance.int-spec.ts` (not a committed, repeatable test). Scenario 1 (default policy `min_samples=5`): 10 messages enqueued; five physical provider attempts occurred (msgs 1–5 failed with 500 `PROVIDER_ERROR`); attempt 5 tripped circuit from `closed` to `open` (gen 0 -> 1, health offline) under `acc_dispatch` with zero SQLSTATE 42501 errors; remaining five messages (6–10) were refused by the open circuit in-memory without provider attempts, settling terminally as `failed` (`NO_ELIGIBLE_PROVIDER`); exactly 0 messages in `outcome_unknown`. Scenario 2 (configured policy `min_samples=10`): all 10 messages executed physical attempts against HTTP 500 provider, all 10 failed (`PROVIDER_ERROR`), attempt 10 tripped circuit to `open`, exactly 0 messages in `outcome_unknown`. Zero SQLSTATE 42501 errors, zero unrecovered leases (`recoverExpiredLeases()` = 0), clone cleanly dropped `WITH (FORCE)`, template fingerprint unchanged. (PR #3, PR #4, Migration 0036). | S1 | BE-DISPATCH-01 Sim 500 one-off acceptance run archived under `scratch/sim500-acceptance.int-spec.ts` (2026-10-23); PR #3, PR #4 |
| QA-F-08 | ops / automation; BE-DISPATCH-02 acceptance | Expired lease on submitting message: message whose dispatch lease expired while in `submitting` status claimed by dispatcher before recovery sweep | Claim settles message `OUTCOME_UNKNOWN` via shared `settleAbandonedSubmission`, never resubmitted to next provider (duplicate send blocked) or marked failed leaving attempt in submitting state | **PASS** — Verified on `develop` (HEAD `554dea3`) via disposable database clone (6/6 tests passing in `be-dispatch-02-expired-submission.int-spec.ts`; PR #14). Duplicate submission blocked, single-provider settled `OUTCOME_UNKNOWN`, settlement matches sweeper, suspended/closed orgs settle `OUTCOME_UNKNOWN`, control unstarted expired lease dispatched once. Template row counts and fingerprint verified unchanged. | S1 | PR #14 (commit `554dea3`); `be-dispatch-02-expired-submission.int-spec.ts` (2026-10-24) |

## G. Audit logs and troubleshooting

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-G-01 | qa-org-a2-admin | `/audit-logs`; find the organization creation, invitations, grants and activations of Org A2 | Each action present with actor, outcome and time | | S2 | screenshot |
| QA-G-02 | qa-org-a2-admin | Filter by outcome "denied"; inspect a denied authorization (e.g. from B-12 if in Org A2) | Denied events listed with reason metadata | | S3 | screenshot |
| QA-G-03 | qa-org-a2-admin | "Inspect" an entry → copy its correlation ID → filter by it | Related events shown | | S3 | screenshot |
| QA-G-04 | qa-org-b2-admin | Search Audit Logs for anything from Org A2 | Nothing from Org A2 visible | | S1 | screenshot |
| QA-G-05 | qa-org-a2-team-reader | Open `/audit-logs` | `read_only` carries `audit.read` at its team scope: record what is listed; nothing outside QA Org A2 may appear | | S1 if another organization's entry appears, else S3 | screenshot |
| QA-G-06 | OPS | For E-01's message, find its lifecycle in `$C logs api` and the database (`INTERNAL_QA_DEPLOYMENT.md` §9) | Operator can trace the message end-to-end | | S3 | log excerpt |

## H. Cross-tenant and role-based security

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-H-01 | qa-org-b2-admin | Inspect E-01-type message **of Org A2** by its UUID on `/whatsapp` | Not found (404); no data leaked | | S1 | screenshot |
| QA-H-02 | qa-org-b2-admin | Open `/users/<Org A2 user id>`, `/workspaces/<Org A2 ws id>` by URL | Not found / no data | | S1 | screenshots |
| QA-H-03 | qa-org-b2-admin, API | Call any Org A2 resource with header `X-Acc-Organization: <Org A2 id>` | 403/404; no data | | S1 | API response |
| QA-H-04 | qa-org-a2-team-reader | Try `/whatsapp`, `/templates`, `/contacts`, `/users` by URL | "Access Forbidden" where no permission; read-only views where permitted; no actions offered | | S1 | screenshots |
| QA-H-05 | qa-org-a2-ws-manager | Try to grant `org_admin` to anyone | Refused | | S1 | screenshot |
| QA-H-06 | qa-org-a2-admin | Try to create a provider or change the circuit policy (API) | 403 | | S1 | API response |
| QA-H-07 | qa-org-a2-admin | Create an API key with a subset of permissions; use it (API) to read messages and to send | Allowed only within the key's permissions and organization; secret shown once | | S1 | screenshots + API |
| QA-H-08 | qa-org-a2-admin | Revoke the API key; use it again | 401 | | S1 | API response |
| QA-H-09 | any | Check browser storage (DevTools → Application) after sign-in | No access/refresh token in localStorage/sessionStorage | | S1 | screenshot |
| QA-H-10 | — | Reseller-scope isolation | **DEFERRED** (no reseller persona can be activated in this release) | | — | — |

## I. Restart, recovery and operational behavior

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-I-01 | OPS + qa-org-b2-admin | Tester sends; operator immediately runs `$C stop api && $C up -d --wait api` | Log ends `Shutdown complete`; API healthy; message ends in a final state (accepted, or `OUTCOME_UNKNOWN` if interrupted mid-submission) — never stuck | | S1 | log excerpt + screenshot |
| QA-I-02 | OPS | `$C restart web` while a tester is signed in | Console recovers after reload; no data loss | | S3 | note |
| QA-I-03 | OPS | Stop Redis briefly (`$C stop redis`), check `/health/ready`, start it again | Readiness reports Redis down, then recovers | | S2 | outputs |
| QA-I-04 | OPS | Take a dump and restore it into a scratch database (deployment §10) | Restore succeeds; row counts match | | S2 | operator output |
| QA-I-05 | OPS | Grep logs for any value from `release.env` (local script, counts only) | 0 occurrences | | S1 | count output |

## J. Usability and accessibility

Record findings with `USABILITY_FEEDBACK_TEMPLATE.md`. Each item is a task to attempt **without help**; note time, retries and confusion.

| ID | Role | Task | Observe | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-J-01 | qa-platform-admin | Onboard a new organization end to end (create org → create its admin → hand over) | Steps that need IDs, outside help or the operator | | S2 | feedback entries |
| QA-J-02 | user with several organizations | Pick the right organization at sign-in and switch later | Can the right organization be recognised? | | S2 | feedback |
| QA-J-03 | qa-org-a2-admin | Send a templated message to a contact and find out whether it worked | Clarity of status and attempts | | S2 | feedback |
| QA-J-04 | qa-org-a2-admin | A message failed: find out why and what to do | Clarity of failure reasons and next steps | | S2 | feedback |
| QA-J-05 | qa-org-a2-admin | Find a message you sent yesterday | Using `/messages` (filters, pagination); record time and difficulty | | S2 | feedback |
| QA-J-06 | any | Complete A-01, C-01 and E-01 using only the keyboard | Focus visible; dialogs usable; Escape behaviour | | S3 | feedback + recording |
| QA-J-07 | any | Use a screen reader (NVDA/VoiceOver) on Users, Audit Logs, WhatsApp | Inputs announced with names; status changes announced | | S3 | feedback |
| QA-J-08 | any | Zoom 200 % and a 1280 px wide window | No lost content or controls | | S4 | screenshots |
| QA-J-09 | any | Read every error you encountered in A–I | Were messages understandable without codes? | | S3 | feedback |

## K. SMS, RCS and unsupported channels (API, simulator)

Added 26-Oct-2026 (owner direction: X-1, X-2, X-3 approved for QA simulator testing; T-1 approved in principle, **QA-lead confirmation required before K-10 and K-11**). The console has no SMS or RCS send screen; these are **API** tests by `qa-org-a2-admin` unless stated.

**Prerequisites (platform operator, console):** WhatsApp is unaffected.
- SMS: `QA SMS OK` and `QA SMS 500` (`simulator_behavior` `"500"`), enabled. Assign to QA Org A2 on SMS: `QA SMS 500` priority 1, `QA SMS OK` priority 2.
- RCS: `QA RCS OK`, `QA RCS 500` (`"500"`) and `QA RCS Text Only` (capability `rcs_message_types` `["text"]`), enabled. Assign to QA Org A2 on RCS: `QA RCS 500` priority 1, `QA RCS OK` priority 2. Keep `QA RCS Text Only` unassigned until K-08.
- SMS template (org admin, API): `POST /templates` on the SMS channel with `variables: ["1"]` and `dlt: { entityId, templateId }`. Use **synthetic numeric strings of 10–25 digits**. These test format validation only. They are **not** DLT registrations and prove nothing about regulatory compliance. Move the template to approved with simulated approval.

The verifier checks the configuration read-only before each run. The operator restores or confirms the intended final configuration afterwards.

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-K-01 | qa-org-a2-admin; approved SMS template | `POST /messages` `channelCode: "sms"`, `templateId`, `payload: { variables: { "1": "QA" } }` | `202`; final `accepted` after a fallback (K-05 assignments); the stored payload holds the **server-rendered** text and the template's own `dlt` | PASS (Agent-run 26-Oct-2026): message `01a176ed-1913…` accepted; stored text server-rendered; stored `dlt` equals the template's; attempts `QA SMS 500` failed → `QA SMS OK` accepted. Synthetic DLT IDs: format only (`phase-b/01`, `02`) | S1 | request/response, message detail |
| QA-K-02 | qa-org-a2-admin | SMS send without `templateId` | `422 SMS_DLT_METADATA_REQUIRED`; no message stored | PASS (Agent-run 26-Oct-2026): `422 SMS_DLT_METADATA_REQUIRED`; no record stored (`phase-b/01`) | S1 | response; message count unchanged |
| QA-K-03 | qa-org-a2-admin | SMS send whose `payload.text` differs from the rendered template; then one with a missing variable | `422 SMS_PAYLOAD_INVALID`; `422 SMS_TEMPLATE_VARIABLE_INVALID` | PASS (Agent-run 26-Oct-2026): `422 SMS_PAYLOAD_INVALID`; `422 SMS_TEMPLATE_VARIABLE_INVALID`; message count 24 → 25 (K-01 only) (`phase-b/01`) | S2 | responses |
| QA-K-04 | qa-org-a2-admin | (a) Create an SMS template whose `dlt.entityId` has 5 digits. (b) Create an SMS template **without** `dlt`, move it to pending, then simulate approval | (a) Creation refused `400 VALIDATION_FAILED`, field `dlt.entityId` ("numeric string between 10 and 25 digits"). (b) Created as draft; approval refused `422 SMS_DLT_METADATA_REQUIRED`. In both cases **no template becomes approved** (the template in (b) stays `pending`) | Documentation mismatch, corrected 26-Oct-2026: the earlier expected result (refusal at approval) did not match. Observed (Agent-run): creation refused `400 VALIDATION_FAILED` on `dlt.entityId`; approval without DLT refused `422 SMS_DLT_METADATA_REQUIRED`; template stayed `pending`. Meets the corrected expected result (`phase-b/02`) | S2 | responses |
| QA-K-05 | qa-org-a2-admin; `QA SMS 500` p1, `QA SMS OK` p2 | Send as K-01; inspect attempts | Attempt 1 `failed` on `QA SMS 500`, attempt 2 `accepted` on `QA SMS OK`; no WhatsApp or RCS provider in the attempts | PASS (Agent-run 26-Oct-2026): message `01a176ed-239f…` accepted; `QA SMS 500` failed → `QA SMS OK` accepted; SMS providers only (`phase-b/01`) | S1 | message detail with attempts |
| QA-K-06 | qa-org-a2-admin; RCS assignments | `POST /messages` `channelCode: "rcs"`, `payload: { messageType: "text", text: "QA RCS" }` | `202`; final `accepted` | PASS (Agent-run 26-Oct-2026): message `01a176ed-2c30…` accepted (`QA RCS 500` failed → `QA RCS OK` accepted) (`phase-b/01`) | S1 | message detail |
| QA-K-07 | qa-org-a2-admin | RCS text with a suggestion `{ type: "action_open_url", text: "Open", postbackData: "p", url: "javascript:alert(1)" }`; then a payload with an unknown field | `422 RCS_UNSAFE_ACTION_URL`; `422 RCS_PAYLOAD_INVALID`; nothing stored | PASS (Agent-run 26-Oct-2026): `422 RCS_UNSAFE_ACTION_URL`; `422 RCS_PAYLOAD_INVALID`; message count 26 → 27 (K-06 only) (`phase-b/01`) | S1 | responses; message count unchanged |
| QA-K-08 | operator + qa-org-a2-admin | Operator disables both RCS assignments and assigns only `QA RCS Text Only`; send a valid single `rich_card` | Final `failed` `NO_ELIGIBLE_PROVIDER` with **no attempt** (an incompatible provider is skipped before submission); then a `text` message is accepted. Operator restores the K-06 assignments | PASS (Agent-run 26-Oct-2026): rich card `failed` `NO_ELIGIBLE_PROVIDER`, 0 attempts, event "No assigned RCS provider carries message type rich_card"; text accepted by `QA RCS Text Only`; operator restored the RCS assignments (`phase-b/03`–`05`) | S2 | message details; configuration before/after |
| QA-K-09 | qa-org-a2-admin; `QA RCS 500` p1, `QA RCS OK` p2 | Send as K-06; inspect attempts | Attempt 1 `failed` on `QA RCS 500`, attempt 2 `accepted` on `QA RCS OK`; only RCS providers | PASS (Agent-run 26-Oct-2026): message `01a176ed-34f1…` accepted; `QA RCS 500` failed → `QA RCS OK` accepted; RCS providers only (`phase-b/01`) | S1 | message detail with attempts |
| QA-K-10 | qa-org-a2-admin; **QA-lead confirmation** | `POST /messages` with `channelCode: "email"` | `422 CHANNEL_NOT_SUPPORTED`; **no message stored** (list count and, by the operator, the `messages` table unchanged) | BLOCKED: QA-lead confirmation (named and dated) not recorded; requested 26-Oct-2026 | S1 | response; before/after counts |
| QA-K-11 | as K-10 | Same with `channelCode: "voice"` | As K-10 | BLOCKED: as K-10 | S1 | as K-10 |

Wait at least 30 s after a `QA SMS 500` or `QA RCS 500` failure series before K-05 or K-09: a provider's circuit opens after five failures in a minute and admits one trial after 30 s (circuit policy). Fallback tests during that pause pass with one attempt and do not test fallback.

## Exit criteria for QA round 1

- Every non-deferred test executed with a result and evidence.
- No open S1; S2 findings triaged with an owner decision.
- Usability feedback collected from at least three testers covering journeys 1–5 (`UX_AUDIT_PLAN.md`).
