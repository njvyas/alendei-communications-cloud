# UX audit plan (pre-QA baseline)

Status: **proposal — no UI change is approved or started.** Priorities are confirmed only after QA round 1 feedback (`QA_TEST_PLAN.md`, `USABILITY_FEEDBACK_TEMPLATE.md`) is reviewed with the owner.

Basis: a read-only inspection of `apps/web/src` at commit `86a340c` (every route under `app/(console)` and `app/(auth)`, `components/`, `lib/api-client.ts`, `lib/session-store.ts`), and the API surface (`apps/api/openapi/openapi.v1.json`). File references are given so each item can be re-checked.

## 1. Journeys in scope

| # | Journey | Main screens | Personas |
|---|---|---|---|
| 1 | Administrator onboarding | `/organizations`, `/users`, `/users/[id]`, org selection, operator activation | platform admin, org admin |
| 2 | Provider setup | `/providers`, `/providers/[id]`, `/channels`; assignments via API | platform admin |
| 3 | Contact and template management | `/contacts`, `/templates` | org admin |
| 4 | Message operations and delivery-status visibility | `/whatsapp` | org admin, sender |
| 5 | Troubleshooting failed messages | `/whatsapp` (attempts), `/audit-logs` | org admin, platform admin |

## 2. Findings

### 2a. Known problems backed by QA evidence

None yet — QA round 1 has not run. One automated-test observation supports item U1: in the WhatsApp E2E run on a template database with many organizations, a user who could see several organizations could not reach the WhatsApp screens because the organization picker lists only UUIDs (`apps/web/e2e`, 20-Oct-2026 run). QA findings will be added here with their `QA-*` / `UXF-*` IDs.

### 2b. Confirmed by code or interface inspection

| ID | Journey | Finding | Evidence |
|---|---|---|---|
| U1 | 1, all | Organization selection and switcher list **raw organization UUIDs**, no names | `components/org-selection-view.tsx:68-71`, `components/org-switcher.tsx:88-92` |
| U2 | 2 | **No console screen for provider assignments** — the step that makes an organization able to send is API-only | no client method or screen for `/organizations/{orgId}/provider-assignments` |
| U3 | 1 | **No in-product account activation**; invited users need the operator command | `UserCreateDialog` notes no email/credential is sent; no activation API |
| U4 | 4, 5 | **No message list or history**; a message is found only by pasting its UUID | `/whatsapp` "Inspect Existing Message by UUID"; no list API |
| U5 | 5 | Raw error codes shown on Templates, Contacts, WhatsApp; attempts table shows raw provider UUID; failure reasons are technical (`NO_ELIGIBLE_PROVIDER`) | `templates/page.tsx:133-135`, `contacts/page.tsx:152-154`, `whatsapp/page.tsx:71-73`, `attempt-history-card.tsx:117-118` |
| U6 | all | **No success feedback** after any action (dialogs close silently) | no toast/notification component in `components/` |
| U7 | 1, 3 | Raw IDs elsewhere: free-text **Reseller ID UUID** in create-organization; Organization/Reseller IDs on detail pages; team scope IDs on user role assignments; full contact UUID column; contact workspace picker shows UUID prefixes and only the first 50 workspaces | `organization-create-dialog.tsx:290-306`, `organizations/[id]:230`, `user-detail-view.tsx:455-465`, `contacts/page.tsx:210` |
| U8 | 2 | Simulator behaviour set through a generic key/JSON capability editor (`simulator_behavior` typed by hand); no provider rename UI | `providers/[id]` capabilities editor |
| U9 | 3 | Contacts: no edit, detail or search; consent type fixed to `transactional`. Templates: no edit/delete in the console (API exists) | `contact-consent-dialog.tsx:39,65`; `templates/page.tsx` |
| U10 | all | Accessibility: dialogs have no focus trap, Escape handling or focus return; 7 provider dialogs lack `role="dialog"`; unlabelled inputs on Roles, API Keys, Audit Logs and user phone edit; filter tabs lack `aria-pressed`; no `aria-live` for loading/status; table headers lack `scope` | `components/providers/*-dialog.tsx`; `roles/page.tsx:171-209`; `api-keys/page.tsx:171-213`; `audit-logs/page.tsx:205-284`; `user-detail-view.tsx:339-343` |
| U11 | all | No environment indicator (QA vs production); `NEXT_PUBLIC_APP_ENV` is set at build time but never read | no reference in `apps/web/src` |
| U12 | 2, 5 | No console screen for suppressions or own sessions (APIs exist) | `lib/api-client.ts:526-538` (sessions unused) |
| U13 | all | Home page shows a static "Phase 1 & 2" card and platform status; no task-oriented starting point | `app/(console)/page.tsx` |
| U14 | all | Dates follow the browser locale; header shows a truncated user UUID instead of the user's email/name | `layout.tsx:166-169` |

### 2c. Improvements that need validation with users

| ID | Question to validate | Method |
|---|---|---|
| V1 | Should onboarding be a guided flow (create org → admin → provider → first send) rather than separate screens? | QA-J-01 observation, 3+ testers |
| V2 | What do operators need from a message list (filters by status, recipient, date; export)? | QA-J-05 + interviews |
| V3 | How should failure reasons and next steps be worded for non-technical users? | QA-J-04 + card sort of current codes |
| V4 | Is a dashboard (volumes, failure rate, provider health) needed for the MVP? | interviews |
| V5 | Language/localisation needs (English only today) | owner/market decision |
| V6 | Self-service invitation vs operator activation for the external MVP | owner decision |

## 3. Proposed ranking (to confirm after QA)

Scores: **Impact** and **Frequency** 1–3 (3 = high), **Severity** 1–3 (3 = blocks the journey), **Effort** S/M/L. Priority = Impact + Frequency + Severity, ties broken by lower effort. *API* = needs a backend change.

| Rank | ID | Change | Impact | Freq. | Sev. | Score | Effort |
|---|---|---|---|---|---|---|---|
| 1 | U1 | Show organization names in the picker and switcher | 3 | 3 | 3 | 9 | S–M |
| 2 | U5 | Human-readable errors and failure reasons; provider names in attempts | 3 | 3 | 2 | 8 | S–M |
| 3 | U2 | Provider-assignment screen (list, add, priority, enable/disable) for platform admins | 3 | 2 | 3 | 8 | M |
| 4 | U4 | Message list with status filter (*API*: list endpoint) | 3 | 3 | 2 | 8 | M–L |
| 5 | U10 | Accessibility fixes (dialogs, labels, aria) | 2 | 3 | 2 | 7 | S–M |
| 6 | U3 | In-product activation (depends on V6) | 3 | 1 | 3 | 7 | M–L |
| 7 | U6 | Consistent success feedback | 2 | 3 | 1 | 6 | S |
| 8 | U7 | Replace raw IDs with names/pickers (reseller, org, team, workspace) | 2 | 2 | 2 | 6 | M |
| 9 | U11 | Environment badge | 1 | 3 | 1 | 5 | S |
| 10 | U13/U14 | Task-oriented home; user identity in header; date format | 1 | 3 | 1 | 5 | S |
| 11 | U9 | Contact edit/search; template edit/delete | 2 | 2 | 1 | 5 | M |
| 12 | U8 | Dedicated simulator-behaviour control; provider rename | 2 | 1 | 1 | 4 | S |
| 13 | U12 | Suppressions and sessions screens | 2 | 1 | 1 | 4 | M |

Scores are provisional and are re-scored with QA frequency data (how many testers hit each issue) before approval.

## 4. Review process

1. **QA round 1** on the internal environment: execute `QA_TEST_PLAN.md`, collect `UXF-*` entries (≥ 3 testers, journeys 1–5).
2. **Triage** (QA lead + owner): link each `UXF-*`/`QA-*` finding to a U-item or create one; separate functional/security defects (fixed first) from UX changes.
3. **Re-score** §3 with evidence; the owner **approves the priority list**.
4. **Design proposals** for the approved top items (short written spec or wireframe per item), reviewed before implementation.
5. **Implementation in small increments**, each with unit/E2E coverage and the full CI suite; no architecture change; backend changes (e.g. message list) reviewed separately.
6. **Regression + QA round 2** on the same internal environment; compare journey completion and difficulty scores with round 1.
7. External MVP readiness decided only after round 2.
