# @acc/web — Alendei Communications Cloud Console

Next.js App Router web console for Alendei Communications Cloud (ACC).

## Architecture

- **Framework**: Next.js 16 (Turbopack) App Router
- **Runtime**: React 19, TypeScript 5.9
- **Design System**: Tailwind CSS v4 with OKLCH theme tokens
- **Client Session State**: Zustand (in-memory presentation state only, no persistence)
- **Server Cache State**: TanStack React Query
- **Testing**: Node.js native test runner via `tsx` (zero additional dependencies)

## Security Invariants

1. **Token & Credential Storage**:
   - Access tokens and application-managed credentials are never persisted by JavaScript. The refresh token remains exclusively in the backend-issued `httpOnly` cookie.
   - Access tokens are stored exclusively in memory via `api-client.ts` and `session-store.ts`.
   - Access tokens are never placed in `localStorage`, `sessionStorage`, client-accessible cookies, IndexedDB, or URL strings.
   - Frontend JavaScript never accesses, reads, or generates refresh cookies.
2. **Refresh Credential Isolation**:
   - Refresh tokens are delivered and managed strictly as backend `httpOnly` cookies (`acc_refresh`, path-scoped to `/api/v1/auth`).
   - JavaScript has zero access to the refresh cookie.
3. **CSRF Protection**:
   - `POST /auth/refresh` and `POST /auth/logout` enforce the non-simple header `X-Acc-Refresh: 1`.
4. **Tenant & Organization Context**:
   - `GET /auth/me` is a `@NoTenantContext()` route; `tenant.orgId` is always `null`.
   - The frontend maintains client-side in-memory selected organization state validated against `authorizedOrganizationIds`.
   - Tenant-scoped requests supply `X-Acc-Organization: <selectedOrganizationId>`.
   - Arbitrary, unverified, or client-forged organization identifiers are rejected.
5. **Controlled 401 Silent Refresh**:
   - Simultaneous 401 responses deduplicate into a single in-flight `POST /auth/refresh` request.
   - Retried original requests execute once; failing refresh terminates cleanly without loops.
   - Logout invalidates in-flight refresh requests to prevent race conditions.
6. **Zero Secrets Logging**:
   - Credentials, passwords, bearer tokens, and Authorization headers are never emitted to logs or telemetry.

## Users Administration (Gate B — Track 2)

The Users module (`/users`, `/users/[id]`) implements the complete user management surface for Gate B:

- **List & Discovery**: Lists users holding grants in the active organization (`GET /users`). Supports opaque cursor pagination (`cursor`, `limit`), exact identity lookup (`email`), status filtering (`invited`, `active`, `disabled`), and sort order (`createdAt`, `email`, `status`).
- **Creation / Invite**: `POST /users` requires an `initialRole` scoped to the current organization or an accessible workspace (`GET /tenants/workspaces`). Protects creations with a persistent `Idempotency-Key` preserved across retries of the same submission. Newly invited accounts enter the `invited` state without credentials or email delivery.
- **User Detail**: Accessible via `/users/[id]`. Displays the exhaustive 7 published user fields, user role assignments (`GET /role-assignments?userId=<id>`), and inline phone update (`PATCH /users/:id`).
- **Lifecycle Management**:
  - `POST /users/:id/disable`: Globals account deactivation that immediately revokes all sessions across all organizations. Displays an explicit global warning prior to confirmation.
  - `POST /users/:id/reactivate`: Restores accounts globally (returning credentialed users to `active` and uncredentialed users to `invited`). Prior sessions are not restored.
- **Authorization Gating**: Actions and views are strictly gated using active organization grants from `GET /auth/me/authorization`:
  - `users.read`: view user list and details
  - `users.invite`: invite new users
  - `users.update`: edit phone number
  - `users.disable`: disable account
  - `users.reactivate`: reactivate account
  - `role_assignments.read`: view role assignments table

## Testing & Verification

```bash
# Run all frontend tests
npm run test -w @acc/web

# Run unit tests
npm run test:unit -w @acc/web

# Run security invariant tests
npm run test:security -w @acc/web
```
