# UI readiness handoff for QA round 1 (frontend track)

**Status (21-Oct-2026): Batch 1 is committed on `develop` (`fd9f13d`). FE-1, FE-4 and FE-5 are built (frontend). Backend B1–B4 and B6–B9 are done (§4). FE-2 (suppressions screen) is implemented and committed in Batch 2 (`dd1627a`, approved by project owner decision 21-Oct-2026; §3, "FE-2 status"). FE-3 (message list screen) is not built.** Nothing here has been QA-tested; `docs/qa/QA_TEST_PLAN.md` still classifies these workflows as API-only until QA confirms them.

**Ownership.** The frontend track (Gemini) owns console implementation, UI/UX and frontend tests. The backend track (Claude) owns APIs, authorization, tenancy, audit, database, OpenAPI and integration. Where this file and an authoritative document differ, the authoritative document wins.

## 1. Authoritative sources

| Topic | File |
|---|---|
| Field-level frontend contract, envelopes, errors, pagination, gating rules | `docs/FRONTEND_API_CONTRACT.md` (§9 envelope, §10 errors, §13 pagination, §14 filters, §28 security, §29 tenant isolation, §30d users, §32 providers) |
| Live route list and request schemas | `apps/api/openapi/openapi.v1.json` (`npm run openapi:check`) |
| Permission keys and system roles | `packages/contracts/src/permissions.ts`, `packages/contracts/src/roles.ts`, `docs/RBAC.md` |
| Error codes | `packages/contracts/src/errors.ts` |
| Shared types | `packages/contracts/src/{suppressions,assignments,messages,providers,provider-adapter}.ts` |
| Release scope and known limitations | `docs/RELEASE.md` §2, §11 |
| QA plan, UX audit, feedback template, QA environment | `docs/qa/QA_TEST_PLAN.md`, `docs/qa/UX_AUDIT_PLAN.md` (U-items), `docs/qa/USABILITY_FEEDBACK_TEMPLATE.md`, `docs/qa/INTERNAL_QA_DEPLOYMENT.md` |
| Test conventions and fixtures | `docs/TESTING.md` §6p/§6r/§6s (browser E2E and `fixture:dev`), §6v/§6x (`fixture:providers`) |
| Credential delivery decision (open) | `docs/DECISIONS.md` D16 |

## 2. Existing frontend architecture (reuse, do not replace)

- **Stack:** Next.js App Router (`apps/web`), React 19, TanStack Query (`src/lib/query-client.ts`, `src/components/providers.tsx`), Zustand session store (`src/lib/session-store.ts`), Tailwind 4 with CSS variables (`src/app/globals.css`).
- **API access:** only through `src/lib/api-client.ts` — `apiFetch` (token refresh, organization header, `ApiError`) and one resource object per area (`usersApi`, `organizationsApi`, `providersApi`, `templatesApi`, `contactsApi`, `messagesApi`, …). New areas get a new resource object in the same file and style. Provider-assignment methods were added in Batch 1 (`providerAssignmentsApi`). Suppression methods (`suppressionsApi.list`, `get`, `create`, `lift`) and the `tenantScoped` option of `channelsApi.list` (sends `X-Acc-Organization`) were added in Batch 2 (`dd1627a`). **Still missing:** message-list methods (FE-3).
- **Permission gating:** `useHasPermission(key)`, the provider helpers (`useCanReadProviders`, `useCanManageProviders`) and, in Batch 2, the suppression helpers (`useCanReadSuppressions`, `useCanManageSuppressions`) in `session-store.ts`; navigation filter in `src/app/(console)/layout.tsx` (`SECTIONS` + switch). UI gating is cosmetic; the backend is authoritative.
- **Screens:** `src/app/(console)/<area>/page.tsx` and `<area>/[id]/page.tsx`; dialogs in `src/components/<area>/*-dialog.tsx`; shared `components/ui/card.tsx`, `components/ui/status-dot.tsx`; status badges per area (e.g. `components/whatsapp/message-status-badge.tsx`, `components/providers/provider-status-badge.tsx`); message detail in `components/whatsapp/attempt-history-card.tsx`; organization picker in `components/org-selection-view.tsx` and `components/org-switcher.tsx`.
- **Not present:** shared dialog primitive (focus trap, Escape, focus return), toast/notification, table component. If introduced, keep them small and use them for the new screens first.
- **Tests:** `tsx --test` unit (`*.test.ts`) and security (`*.sec.test.ts`) suites under `src/`; Playwright E2E in `apps/web/e2e/` with `helpers/auth.ts` (`loginViaUi`, `assertNoTokensInStorage`). Fixtures do **not** seed provider assignments, suppressions or messages (see B5).

## 3. Prioritized UI requirements

### Essential before QA round 1

| ID | Requirement | Persona / gate | Backend (status) | Replaces today |
|---|---|---|---|---|
| FE-1 | **Provider assignments panel** on `/organizations/[id]`: list (provider name, channel, priority, status), add (provider picker + priority), change priority, enable/disable with confirmation | Platform admin; show only with `providers.read`, actions only with `providers.manage` | `GET/POST /organizations/{orgId}/provider-assignments`, `GET/PATCH …/{assignmentId}`, `POST …/{assignmentId}/enable`, `…/disable` — **exists**; body `{providerId, priority, status?}`; statuses `active`/`disabled`; type `OrganizationProviderAssignment` | curl (QA-D-08, E-06, F-02–F-05) |
| FE-2 | **Suppressions screen** `/suppressions`: list with status (`active`/`cleared`) and channel filters, add (address, optional channel, reason), lift (reason, confirmation, **active rows only**) | Org admin; view with `suppressions.read`, actions with `suppressions.manage` | `GET/POST /suppressions`, `GET /suppressions/{id}`, `POST /suppressions/{id}/lift` — **exists**; `rawAddress` and `reason` 1–500 chars; type `SuppressionResponse`. No address search on the server: filter the loaded page client-side and say so | curl (QA-C-10, E-05) |
| FE-3 | **Message list** `/messages` with filters and a link to the existing detail view | Org admin; `messages.read` | `GET /messages` — **implemented** (B1, contract §33c). Keep "Inspect by UUID" | DB query (QA-E-09, J-05) |
| FE-4 | **Organization names** in picker and switcher; user email in header | Any multi-organization user | `GET /organizations` (no tenant context needed, limited to the caller's reach) — **exists**. Fall back to the ID when the caller lacks `organizations.read`. Selection must still validate against `authorizedOrganizationIds` | U1, U14 |
| FE-5 | **Readable errors and failure reasons** with next steps, code shown as secondary text; success feedback for FE-1–FE-3 actions | All | Codes in `errors.ts` (e.g. `NO_ACTIVE_PROVIDER_ASSIGNMENT`, `RECIPIENT_SUPPRESSED`, `CONSENT_REVOKED`, `TEMPLATE_NOT_APPROVED`, `SUPPRESSION_ALREADY_ACTIVE`, `PROVIDER_ASSIGNMENT_CONFLICT`, `ASSIGNMENT_PRIORITY_CONFLICT`); dispatch failure reasons `NO_ELIGIBLE_PROVIDER`, `PROVIDER_ERROR`, `RATE_LIMITED`, `TIMEOUT`, `UNKNOWN` | U5, U6 |

**Rules for every essential item:** no new permission keys, no client-side authorization logic beyond hiding controls; labelled inputs, `role="dialog"`, Escape and focus return, `aria-live` for status; loading, empty, error and success states; tenant users never see provider names (they lack `providers.read`) — label attempts "Attempt n" with a short provider reference.

**Tests per item:** unit test for new `api-client` methods and error mapping; security test that controls are hidden without the permission (pattern: `components/navigation-security.sec.test.ts`); one Playwright journey — FE-1: assign → org admin sends → disable → send refused; FE-2: suppress → send refused → lift → send accepted; FE-3: send → find in list by status filter; FE-4: multi-org user selects by name. Backend authorization is tested separately by the backend track; UI tests do not replace it.

**FE-2 status (21-Oct-2026): implemented and committed in Batch 2 (`dd1627a`, approved by project owner decision 21-Oct-2026); not QA-tested.**
- **Built:**
  - Route `/suppressions` (`src/app/(console)/suppressions/page.tsx`); navigation entry shown with `suppressions.read`.
  - List card with status (`active`/`cleared`/all) and channel filters.
  - Create dialog: address, optional channel, reason. Length and format pre-checks run in the browser; a fresh `Idempotency-Key` is generated per submission.
  - Lift dialog: reason and confirmation, offered on `active` rows only and only with `suppressions.manage`.
  - Detail dialog and status badge (`src/components/suppressions/`). All dialogs use the shared `AccessibleDialog` (`components/ui/dialog.tsx`).
  - `error-mapping.ts` adds `PHONE_MISSING_COUNTRY_CODE`, `INVALID_PHONE_NUMBER` and `INVALID_EMAIL_ADDRESS`.
- **Channel names.** The page lists channels with `channelsApi.list({ tenantScoped: true })`. For an org admin this depends on the tenant read of the channel list (backend Batch 2, approved 21-Oct-2026; `DECISIONS.md` §1x.2) and on migration `0035` having been applied to the target database. Approval did not apply it, and it is applied to no persistent database (`DECISIONS.md` §1x.3). If that call fails, the page still renders, without channel names.
- **Not built:**
  - The client-side address filter over the loaded page that the FE-2 row asks for.
  - The FE-2 Playwright journey: no spec under `apps/web/e2e/` covers suppressions.
- **Tests.** `src/lib/suppressions-administration.test.ts` (6), `src/lib/suppressions-security.sec.test.ts` (7) and `src/components/suppressions/suppression-components.sec.test.ts` (8): 21/21 on 21-Oct-2026 (`TESTING.md` §6y). Under §5, the `QA_TEST_PLAN.md` rows stay API-only until QA confirms the screen.

### Can wait for QA feedback

Accessibility sweep of existing dialogs and pages (U10); session screens (`/auth/sessions`, `/users/{id}/sessions` — APIs exist); contact edit and identities (APIs exist); template edit/delete (APIs exist); SMS/RCS console send (`POST /messages` supports `channelCode` `sms`/`rcs`; scope pending owner decision); dedicated simulator-behaviour control and provider rename (U8); environment badge (U11); task-oriented home (U13); reseller/raw-ID pickers (U7); guided onboarding (V1); dashboards (V4).

### Not to build

In-product activation, invitation or password reset (D16 open — the operator `activate-user` command stays); any provider credential field (none exists by design: `apps/api/src/providers/credential-absence.architecture.spec.ts`); reseller management; delivery receipts; analytics.

## 4. Backend dependencies (backend track)

Status as of 20-Oct-2026 (uncommitted working tree on `86a340c`). Field-level contract: `docs/FRONTEND_API_CONTRACT.md` §33.

| ID | Dependency | Needed by | Status |
|---|---|---|---|
| B1 | `GET /messages` list | FE-3 | **Implemented (uncommitted).** `messages.read` at the request organization; newest first; filters `status`, `channelCode`, `workspaceId`, `templateId`, `providerId`, `createdFrom`/`createdTo`; rows carry `channelCode` and `attemptCount`, never the payload. **No recipient filter** (query strings are logged; an address is personal data). Contract §33c |
| B2 | `MessageDetailResponse` / `SendMessageRequest` in `@acc/contracts` did not match the routes | FE-3, FE-5 | **Fixed.** Contract now equals `GET /messages/:id` (incl. `attempts: MessageAttemptResponse[]`) and the send DTO; the service is typed against it |
| B3 | No OpenAPI success schemas for suppressions and messages | FE-2, FE-3 | **Fixed** for suppressions and messages (`Suppression`, `QueuedMessage`, `MessageDetail`, `MessageAttempt`), validated against live responses. Contacts, templates, identities still undocumented |
| B4 | `FRONTEND_API_CONTRACT.md` had no section for assignments, suppressions, messages | FE-1–FE-3 | **Fixed** (§33) |
| B5 | Fixtures seed no assignments, suppressions or messages | FE-1–FE-3 E2E | Open; create data through the UI/API in E2E, or request a fixture extension |
| B6 | Lifting a cleared suppression overwrote `clearedAt`/`clearedReason` | FE-2 | **Fixed:** `409 SUPPRESSION_LIFECYCLE_CONFLICT`, `details.status`. Still offer lift on active rows only |
| B7 | Suppression create ignored `rawAddress` in its idempotency fingerprint: a reused key with a new address replayed the old `201` | FE-2 | **Fixed:** now `422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`. Use a fresh `Idempotency-Key` per distinct submission |
| B8 | Assignment list `sort=createdAt`/`-createdAt` returned `500` on page 2 | FE-1 | **Fixed** (orders by the UUIDv7 id) |
| B9 | `GET /auth/me` returned no email | FE-4 | **Implemented (uncommitted):** `email` is the session user's own address; `null` for an API-key principal. Backward-compatible with the console's optional `email?` |

**Console–backend conflicts found 20-Oct-2026: resolved in Batch 1.** The nonexistent `ORGANIZATION_NOT_ACTIVE` mapping was removed. The tenancy, suppression, idempotency and not-found codes are now mapped. The organization picker and switcher follow `page.nextCursor` (`organizationsApi.listAll`). **Remaining, non-blocking:** the assignment card reads one page of up to 100 providers, so beyond 100 a provider name falls back to its id.

Platform administrators hold no tenant-content permissions (`SUPER_ADMIN_PERMISSIONS` excludes them), so message, suppression and contact screens are org-admin screens; do not design platform-wide message views.

## 5. QA documentation rule

A `QA_TEST_PLAN.md` row moves from API/DEFERRED to UI only after the screen exists and has passed its tests. API-level security rows stay in the plan regardless.

## 6. Open owner decisions

1. Approve FE-1–FE-5 and backend B1–B4 (B5, B6 optional).
2. Activation for round 1: keep operator CLI (recommended) or authorize an admin route that deviates from D16.
3. SMS/RCS in round 1: API-only tests or out of scope.
