# Internal QA test plan (round 1)

Environment and accounts: `INTERNAL_QA_DEPLOYMENT.md` (§7 personas, §8 data). Usability observations: `USABILITY_FEEDBACK_TEMPLATE.md`. Baseline commit: `86a340c` (record the deployed tag on every result).

**How to use.** Run each test with the stated persona. Fill **Actual** with `PASS`, or `FAIL — <what happened>`, or `BLOCKED — <why>`. Attach the evidence named. A failing test's **Severity** is the default; raise it if the impact is worse. Record usability friction separately even when a test passes.

**Severity:** S1 Critical (security/tenant breach, data loss, nothing works) · S2 Major (core task fails, no workaround) · S3 Minor (workaround exists) · S4 Cosmetic.

**Channel of execution:** **UI** = console; **API** = HTTP call (operator provides a `curl` snippet and a token, `INTERNAL_QA_DEPLOYMENT.md` §8a); **OPS** = operator command on the host. Marked **DEFERRED** = not implemented in this release; record nothing but confirm the gap is real if you encounter it.

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
| QA-A-06 | OPS + qa-platform-admin; an invited user in QA Org A | Operator runs `activate-user` (deployment §7) with a 16+ character password piped on stdin | Output `User activated: <email> (organization <slug>)`; the user can now sign in | | S2 | operator output (no password) |
| QA-A-07 | OPS | Run `activate-user` again for the same user | `user activation refused: the user is active, not invited`; exit 1 | | S2 | operator output |
| QA-A-08 | OPS | Run `activate-user` with a password shorter than 12 characters | Refused with "at least 12 characters"; password not printed | | S2 | operator output |
| QA-A-09 | OPS | Activate a user of QA Org B while naming QA Org A | Refused "holds no grant in organization …" | | S1 | operator output |
| QA-A-10 | OPS | Run `activate-user` naming an org-admin (not platform admin) as `--operator` | Refused "operator must be an active platform administrator" | | S1 | operator output |
| QA-A-11 | signed-in user | Click "Sign out", then press the browser Back button and reload | Returns to `/login`; protected pages do not render data | | S2 | screenshot |
| QA-A-12 | signed-in user | Stay idle > 15 minutes, then act | Session is refreshed silently, or the user is sent to `/login` — never a broken page | | S3 | note + screenshot |
| QA-A-13 | qa-platform-admin | Disable a user (A-06's user) from `/users/[id]`, then that user tries to sign in | Disable requires confirmation; sign-in refused afterwards | | S1 | screenshots |
| QA-A-14 | — | Self-service password reset / invitation link | **DEFERRED** — not implemented (operator activation only) | | — | — |
| QA-A-15 | — | View or revoke own sessions in the console | **DEFERRED** — API exists, no console screen | | — | — |

## B. Organization, user and role management

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-B-01 | qa-platform-admin | `/organizations` → "+ Create Organization": name *QA Org A*, slug `qa-org-a`, reseller left default | Organization created with status active; appears in the list | | S2 | screenshot |
| QA-B-02 | qa-platform-admin | Create *QA Org B* the same way | Created; both listed | | S2 | screenshot |
| QA-B-03 | qa-platform-admin | Create an organization with an existing slug | Refused with a clear conflict message | | S3 | screenshot |
| QA-B-04 | qa-platform-admin, QA Org A selected | `/users` → "+ Invite User": email, role `org_admin`, scope organization | User created as **invited**; dialog states no email is sent | | S2 | screenshot |
| QA-B-05 | qa-org-a-admin (activated) | Sign in; check the nav | Organizations, Workspaces, Teams, Users, Roles, API Keys, Audit Logs, Templates, Contacts, WhatsApp visible; no Providers/Channels | | S2 | screenshot of nav |
| QA-B-06 | qa-org-a-admin | `/workspaces` → create *QA WS 2*; `/teams` → create *QA Team 1* in *QA WS 2* | Both created and listed | | S2 | screenshots |
| QA-B-07 | qa-org-a-admin | Invite `qa-org-a-ws-manager` with `workspace_manager` at workspace *QA WS 2* | Created invited; after OPS activation the user sees only what that scope allows | | S2 | screenshots |
| QA-B-08 | qa-org-a-admin | Invite `qa-org-a-team-reader` (`read_only`, team *QA Team 1*) and `qa-org-a-agent` (`agent`, team *QA Team 1*) | Created; after activation their nav is reduced accordingly | | S2 | screenshots of each nav |
| QA-B-09 | qa-org-a-admin | `/users/[id]` of the team reader → "+ Assign Role" → `read_only` at organization scope; then "Revoke" it | Grant appears in Role Assignments; revoke asks for confirmation and removes it | | S2 | screenshots |
| QA-B-10 | qa-org-a-admin | Try to revoke their **own last** `org_admin` grant | Refused: an organization must keep an administrator | | S1 | screenshot |
| QA-B-11 | qa-org-a-admin | `/roles` → "+ Create Custom Role" with `contacts.read`, `messages.read`; assign it to the team reader | Role created; assignment succeeds | | S3 | screenshots |
| QA-B-12 | qa-org-a-ws-manager | Try to create a custom role including `messages.send` | Refused (cannot confer a permission it does not hold) | | S1 | screenshot |
| QA-B-13 | qa-platform-admin | `/organizations/[QA Org B]` → "Suspend" with a reason, then "Reactivate" | Status changes each time; both appear in Audit Logs | | S2 | screenshots |
| QA-B-14 | qa-org-a-admin | Archive *QA Team 1*, then restore it | Archive/restore require confirmation; status updates | | S3 | screenshots |
| QA-B-15 | — | Reseller administrator appoints an organization administrator | **DEFERRED / not allowed in this MVP** (platform administrators onboard organizations) | | — | — |
| QA-B-16 | — | Create or manage resellers | **DEFERRED** — no reseller management exists; only the seeded *Alendei Direct* | | — | — |

## C. Contacts and templates

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-C-01 | qa-org-a-admin | `/contacts` → select the default workspace → "Create Contact" (name, phone `+12025550101`, WhatsApp identity, opt-in) | Contact listed | | S2 | screenshot |
| QA-C-02 | qa-org-a-admin | Create 9 more contacts (`+12025550102`…`110`), opt-in for half | All listed; pagination works | | S3 | screenshot |
| QA-C-03 | qa-org-a-admin | Create a contact with an invalid phone (`12345`) | Refused with a field-level message | | S3 | screenshot |
| QA-C-04 | qa-org-a-admin | "Manage Consent" on a contact → revoke | Consent shows revoked | | S2 | screenshot |
| QA-C-05 | qa-org-a-admin | `/templates` → "Create Template" `qa_welcome` with variable `{{1}}` | Template listed as draft | | S2 | screenshot |
| QA-C-06 | qa-org-a-admin | "Simulate Approval": draft → pending → approved; create `qa_promo` and move it to rejected | Status badges update; simulator disclaimer visible | | S2 | screenshots |
| QA-C-07 | qa-org-a-team-reader | Open `/templates` and `/contacts` | "Access Forbidden" (no content permissions at team scope) | | S1 | screenshots |
| QA-C-08 | qa-org-b-admin | Open `/contacts` and `/templates` | Only QA Org B data; nothing from QA Org A | | S1 | screenshots |
| QA-C-09 | — | Edit or delete a template; edit a contact; search contacts | **DEFERRED in the console** (API exists for templates; no console action) | | — | — |
| QA-C-10 | qa-org-a-admin, API | Add a suppression for `+12025550103` (`POST /suppressions`) | 201; **no console screen** for suppressions | | S3 | API response |

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
| QA-D-08 | qa-platform-admin, **API** | Assign providers: Org A → `QA Sim 500` p1, `QA Sim OK` p2; Org B → `QA Sim OK` p1 (`POST /organizations/{orgId}/provider-assignments`) | 201 each. The console's Provider Assignments panel on `/organizations/[id]` is **implemented (Batch 1) but not yet accepted in QA**, so this step stays API-driven until QA exercises and accepts the panel | | S2 | API responses |
| QA-D-09 | qa-org-a-admin | Try `/providers` and `/channels` | Not in nav; direct URL shows no provider administration | | S1 | screenshot |

## E. Message submission, dispatch, status and failure handling

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-E-01 | qa-org-b-admin; Org B → `QA Sim OK` | `/whatsapp` → recipient `+12025550201`, custom text → "Send WhatsApp Message" | Settlement monitor appears; status reaches `PROVIDER_ACCEPTED` within a few seconds; one attempt row | | S1 | screenshot incl. message ID |
| QA-E-02 | qa-org-b-admin | Send using approved template `qa_welcome` with its variable | Accepted; the rendered text uses the variable | | S2 | screenshot |
| QA-E-03 | qa-org-b-admin | Try to send with a draft or rejected template | Refused before sending (`TEMPLATE_NOT_APPROVED`) | | S2 | screenshot |
| QA-E-04 | qa-org-a-admin | Send to the contact whose consent was revoked (C-04) | Refused (`CONSENT_REVOKED`) | | S1 | screenshot |
| QA-E-05 | qa-org-a-admin | Send to the suppressed number (C-10) | Refused (`RECIPIENT_SUPPRESSED`) | | S1 | screenshot |
| QA-E-06 | qa-platform-admin | Temporarily disable Org B's assignment (API), Org B admin sends | Refused (`NO_ACTIVE_PROVIDER_ASSIGNMENT`); re-enable afterwards | | S2 | screenshot + API |
| QA-E-07 | qa-org-b-admin | "Inspect Existing Message by UUID" with E-01's ID | Same final state and attempts shown | | S2 | screenshot |
| QA-E-08 | qa-org-b-admin | Send twice quickly to a new number `+12025550299` | Both accepted; no error (concurrent first send) | | S2 | screenshots |
| QA-E-09 | — | Browse a list/history of sent messages | **DEFERRED** — no list exists; lookup by message ID only | | — | — |
| QA-E-10 | — | Delivery receipts (delivered/read) | **DEFERRED** — simulator submission outcomes only; `PROVIDER_ACCEPTED` is not delivery | | — | — |

## F. Fallback and retry behavior

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-F-01 | qa-org-a-admin; Org A → `QA Sim 500` p1, `QA Sim OK` p2 | Send a message | `PROVIDER_ACCEPTED`; attempts table shows #1 failed (500 provider), #2 accepted | | S1 | screenshot of attempts |
| QA-F-02 | qa-platform-admin + qa-org-a-admin | Disable `QA Sim OK` (or its assignment); Org A sends | `FAILED` with no eligible provider; one failed attempt | | S2 | screenshot |
| QA-F-03 | qa-platform-admin + qa-org-a-admin | Assign only `QA Sim Timeout` to Org A; send | `OUTCOME_UNKNOWN`; exactly one attempt; never retried | | S1 | screenshot |
| QA-F-04 | qa-platform-admin + qa-org-a-admin | Assign `QA Sim 429` p1, `QA Sim OK` p2; send | Falls back on rate limit; accepted on attempt #2 | | S2 | screenshot |
| QA-F-05 | qa-org-a-admin | Restore the D-08 assignments; send 5 messages | All accepted; one or two attempts each, never more than the number of providers | | S2 | screenshot of each |
| QA-F-06 | — | Cross-channel fallback (WhatsApp → SMS) or timed retries | **DEFERRED** (later phase) | | — | — |

## G. Audit logs and troubleshooting

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-G-01 | qa-org-a-admin | `/audit-logs`; find the organization creation, invitations, grants and activations of Org A | Each action present with actor, outcome and time | | S2 | screenshot |
| QA-G-02 | qa-org-a-admin | Filter by outcome "denied"; inspect a denied authorization (e.g. from B-12 if in Org A) | Denied events listed with reason metadata | | S3 | screenshot |
| QA-G-03 | qa-org-a-admin | "Inspect" an entry → copy its correlation ID → filter by it | Related events shown | | S3 | screenshot |
| QA-G-04 | qa-org-b-admin | Search Audit Logs for anything from Org A | Nothing from Org A visible | | S1 | screenshot |
| QA-G-05 | qa-org-a-team-reader | Open `/audit-logs` | `read_only` carries `audit.read` at its team scope: record what is listed; nothing outside QA Org A may appear | | S1 if another organization's entry appears, else S3 | screenshot |
| QA-G-06 | OPS | For E-01's message, find its lifecycle in `$C logs api` and the database (`INTERNAL_QA_DEPLOYMENT.md` §9) | Operator can trace the message end-to-end | | S3 | log excerpt |

## H. Cross-tenant and role-based security

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-H-01 | qa-org-b-admin | Inspect E-01-type message **of Org A** by its UUID on `/whatsapp` | Not found (404); no data leaked | | S1 | screenshot |
| QA-H-02 | qa-org-b-admin | Open `/users/<Org A user id>`, `/workspaces/<Org A ws id>` by URL | Not found / no data | | S1 | screenshots |
| QA-H-03 | qa-org-b-admin, API | Call any Org A resource with header `X-Acc-Organization: <Org A id>` | 403/404; no data | | S1 | API response |
| QA-H-04 | qa-org-a-team-reader | Try `/whatsapp`, `/templates`, `/contacts`, `/users` by URL | "Access Forbidden" where no permission; read-only views where permitted; no actions offered | | S1 | screenshots |
| QA-H-05 | qa-org-a-ws-manager | Try to grant `org_admin` to anyone | Refused | | S1 | screenshot |
| QA-H-06 | qa-org-a-admin | Try to create a provider or change the circuit policy (API) | 403 | | S1 | API response |
| QA-H-07 | qa-org-a-admin | Create an API key with a subset of permissions; use it (API) to read messages and to send | Allowed only within the key's permissions and organization; secret shown once | | S1 | screenshots + API |
| QA-H-08 | qa-org-a-admin | Revoke the API key; use it again | 401 | | S1 | API response |
| QA-H-09 | any | Check browser storage (DevTools → Application) after sign-in | No access/refresh token in localStorage/sessionStorage | | S1 | screenshot |
| QA-H-10 | — | Reseller-scope isolation | **DEFERRED** (no reseller persona can be activated in this release) | | — | — |

## I. Restart, recovery and operational behavior

| ID | Role / prerequisites | Steps | Expected result | Actual | Sev. if fail | Evidence |
|---|---|---|---|---|---|---|
| QA-I-01 | OPS + qa-org-b-admin | Tester sends; operator immediately runs `$C stop api && $C up -d --wait api` | Log ends `Shutdown complete`; API healthy; message ends in a final state (accepted, or `OUTCOME_UNKNOWN` if interrupted mid-submission) — never stuck | | S1 | log excerpt + screenshot |
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
| QA-J-03 | qa-org-a-admin | Send a templated message to a contact and find out whether it worked | Clarity of status and attempts | | S2 | feedback |
| QA-J-04 | qa-org-a-admin | A message failed: find out why and what to do | Clarity of failure reasons and next steps | | S2 | feedback |
| QA-J-05 | qa-org-a-admin | Find a message you sent yesterday | (no list exists — record the impact) | | S2 | feedback |
| QA-J-06 | any | Complete A-01, C-01 and E-01 using only the keyboard | Focus visible; dialogs usable; Escape behaviour | | S3 | feedback + recording |
| QA-J-07 | any | Use a screen reader (NVDA/VoiceOver) on Users, Audit Logs, WhatsApp | Inputs announced with names; status changes announced | | S3 | feedback |
| QA-J-08 | any | Zoom 200 % and a 1280 px wide window | No lost content or controls | | S4 | screenshots |
| QA-J-09 | any | Read every error you encountered in A–I | Were messages understandable without codes? | | S3 | feedback |

## Exit criteria for QA round 1

- Every non-deferred test executed with a result and evidence.
- No open S1; S2 findings triaged with an owner decision.
- Usability feedback collected from at least three testers covering journeys 1–5 (`UX_AUDIT_PLAN.md`).
