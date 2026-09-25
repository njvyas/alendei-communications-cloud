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

## Roles & Permissions Administration (Gate B — Track 3B)

The Roles module (`/roles`, `/roles/[id]`) implements role management and permission composition:

- **List & Discovery**: Lists roles visible in the current organization (`GET /roles`), including organization-owned custom roles and platform definitions. Supports cursor pagination (`cursor`, `limit`), system/custom filtering (`isSystemRole`), exact key lookup (`key`), and sort orders (`key`, `-key`, `createdAt`, `-createdAt`).
- **Role Detail**: Accessible via `/roles/[id]`. Displays role identity, description, ownership, allowed scope types, and all bundled permissions grouped by domain.
- **Custom Role Creation**: `POST /roles` supports snake_case key validation (`^[a-z][a-z0-9_]{2,63}$`), name, description, allowed grant scope types (`organization`, `workspace`, `team`), and permission selection from the system catalogue (`GET /permissions`). Platform-only permissions are filtered out. Idempotency is preserved across retries via persistent `Idempotency-Key`.
- **Custom Role Editing**: `PATCH /roles/:id` updates mutable custom roles. Permissions are submitted as a **complete replacement set**, never a delta. System and platform roles are protected as immutable.
- **Custom Role Deletion**: `DELETE /roles/:id` requires explicit confirmation. In case of active grant references, surfaces `409 RESOURCE_CONFLICT` with actionable guidance to revoke assignments first.
- **Downward-Only Inheritance**: Role composition is bounded by the creator's authority covering organization scope (`RBAC.md` §7). Workspace- and team-level grants do not confer authority to compose permissions into an organization-scoped role.
- **Scope Model & Team Administration**: Adheres to the canonical 5-scope hierarchy (`PLATFORM → RESELLER → ORGANIZATION → WORKSPACE → TEAM`). `team` is selectable as an allowed scope type for custom roles per backend contract; tenant administration (including teams) is planned for Phase 1B.8 / later phases.

## Role Assignment Administration (Gate B — Track 3C)

Role assignment administration is integrated directly into the User Detail view (`/users/[id]`):

- **Grant Inspection**: Lists all role assignments granted to a user (`GET /role-assignments?userId=...`) within the active organization context. Renders role keys, scope types (`organization`, `workspace`, `team`, `platform`), target scope identifiers with human-readable workspace/organization labels, and grant timestamps.
- **Assign Role Flow**: Authorised users (`role_assignments.grant`) can grant custom tenant roles to users via the `AssignRoleDialog`.
  - Roles are selected from tenant custom roles (`rolesApi.list`); platform and system roles are protected from tenant assignment.
  - Admitted scope levels are derived from `role.allowedScopeTypes`.
  - Scope targets are pinned to authoritative metadata: `organization` targets the active organization ID, and `workspace` targets workspaces loaded via `GET /tenants/workspaces`. Team scope fails closed with an explanatory message noting roadmap scheduling (Phase 1B.8+).
  - Mutating operations attach a persistent `Idempotency-Key` across retries.
  - Structured backend error handling surfaces unheld permission rejections (`AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION`), inadmissible scope types (`AUTHZ_SCOPE_TYPE_NOT_ADMITTED`), and disabled user conflicts.
- **Revoke Role Flow**: Authorised operators (`role_assignments.revoke`) can revoke grants via `RevokeAssignmentDialog` with explicit confirmation (`DELETE /role-assignments/:id`).
  - Specially handles `AUTHZ_LAST_PLATFORM_ADMIN` (409 Conflict) without entering retry loops.
  - Successfully invalidated queries immediately refresh the assignment list and tenant cache.
- **Strict Tenant & Scope Isolation**: All requests pin `X-Acc-Organization` to the validated session store. React Query keys are partitioned by `selectedOrgId` and `userId`.

## API Key Administration (Gate B — Track 4)

The API Keys module (`/api-keys`) implements machine-to-machine credential administration for Gate B:

- **List & Discovery**: Lists API keys scoped to the active organization (`GET /api/v1/api-keys`). Supports opaque keyset cursor pagination (`cursor`, `limit`), status filtering (`active`, `expired`, `revoked`), scope filtering (`organization`, `workspace`), exact name lookup (`name`), and sort orders (`createdAt`, `-createdAt`, `name`, `-name`).
- **Key Detail Modal**: Displays comprehensive backend metadata: key ID, name, identifier prefix, lifecycle status, binding scope, granted scopes catalogue, creation timestamp, last used timestamp, expiration timestamp, createdBy attribution, and revocation audit details. Key hash and secrets are strictly absent.
- **Key Creation Flow**:
  - `POST /api/v1/api-keys` creates programmatic credentials with a name (1–120 characters), binding scope (`organization` or `workspace`), target scope ID, requested permission scopes, and optional future `expiresAt`.
  - **Scope Picker & Downward Inheritance**: The permission scopes picker filters available permissions to only those held by the creator at the target binding scope (`GET /auth/me/authorization`), preventing unheld permission rejections up-front.
  - **Idempotency**: Protects creation requests with a persistent `Idempotency-Key` preserved across retries of the same submission.
  - **One-Time Secret Display**: Fresh creation returns the plaintext secret once. The UI renders the joined credential (`<prefix>.<secret>`) with a copy-to-clipboard button and prominent warning. Users must acknowledge saving the key before the modal can be dismissed.
  - **Ephemeral Secret Invariant**: The plaintext secret is held strictly in ephemeral component memory. It is **never** written to `localStorage`, `sessionStorage`, client-accessible cookies, IndexedDB, Zustand persistence, React Query cache, or URL parameters. It is wiped immediately on modal close, component unmount, organization switch, or logout.
  - **Idempotent Replay Handling**: In accordance with ADR-008, idempotent replays return `secret: null` because plaintext secrets are never stored in idempotency response snapshots. The UI detects null secrets and displays an explanatory replay notice rather than an empty box or an error.
- **Revocation Flow**:
  - `POST /api/v1/api-keys/:id/revoke`: Revocation is a terminal lifecycle state transition (there is no `DELETE`, no un-revoke, and no rotation).
  - Explicit confirmation modal warns operators that revocation takes effect immediately and causes all workloads using the key to receive `401 Unauthorized`.
  - Handles concurrent or prior revocation conflicts (`409 API_KEY_LIFECYCLE_CONFLICT`) gracefully by treating the server's status as authoritative and refreshing the table without retry loops.
- **Authorization Gating**:
  - `api_keys.read`: view key list and details
  - `api_keys.create`: mint new API keys
  - `api_keys.revoke`: revoke active API keys
  - Gated to `org_admin` (and `alendei_support` for read-only); `reseller_admin` and `workspace_manager` hold no API key permissions.
- **Known Limitations & Deferred Scope**:
  - In-place key rotation, secret recovery/reveal, usage analytics, quotas, per-key rate limits, and IP allowlists are deferred and not implemented in Phase 1B.

## Audit Log Administration (Gate B — Track 5)

The Audit Logs module (`/audit-logs`) implements forensic observation and causality trace discovery:

- **List & Discovery**: Lists immutable audit log events scoped to the active organization (`GET /api/v1/audit-logs`). Supports keyset cursor pagination (`cursor`, `limit`), sort ordering (`-occurredAt` [default] and `occurredAt`), outcome filtering (`success`, `failure`, `denied`), actor type filtering (`user`, `api_key`, `oauth_client`, `system`), action lookup, resource type lookup, correlation ID lookup, and ISO-8601 date range filtering (`occurredFrom`, `occurredTo`).
- **Keyset Cursor Pagination**: Built around monotonic UUIDv7 keysets that preserve millisecond precision without offset drift. The UI tracks cursor history stacks for forward and backward navigation, resetting the cursor stack when query filters or sort directions change.
- **Log Detail Dialog**: Accessible by inspecting any log row. Renders comprehensive event attributes:
  - Event ID, occurred timestamp, action code, and outcome status dot (`ok` for success, `bad` for failure, `warn` for denied).
  - Actor identity: actor type (`user`, `api_key`, `oauth_client`, `system`), user ID, API key ID, and human-readable actor label.
  - Resource: target resource type and optional target resource ID.
  - Scope and Ancestry: binding scope level (`organization`, `workspace`, `team`, `platform`) and full ancestry hierarchy (`orgId`, `workspaceId`, `teamId`, `resellerId`).
  - Network Origin: client origin IP and user-agent string.
  - Causal Tracing: correlation ID (with one-click clipboard copy and quick-filter action) and optional direct parent causation ID.
- **Safe Payload Rendering (XSS Prevention)**:
  - Mutation state snapshots (`before`, `after`) and event `metadata` represent untrusted arbitrary strings captured during past operations.
  - All audit payloads are rendered strictly as inert text nodes within preformatted `<pre>` blocks using `JSON.stringify(data, null, 2)`.
  - Zero `dangerouslySetInnerHTML`, zero HTML/script parsing, zero client-side evaluation, completely neutralizing stored XSS attacks.
- **Authorization Gating**:
  - Gated strictly by `audit.read` (`PERMISSIONS.AUDIT_READ`).
  - Held by `org_admin`, `reseller_admin`, `alendei_support`, and `platform_super_admin`.
  - Accounts lacking `audit.read` (such as `workspace_manager`) or unauthenticated visitors fail closed with an explicit unauthorized boundary banner; query execution is completely blocked (`enabled: false`).
- **Strict Tenant Isolation**:
  - All requests pin `X-Acc-Organization` to the validated active session store.
  - React Query keys are partitioned by `selectedOrgId`, ensuring immediate eviction and zero cross-tenant cache contamination on organization switch.

## Testing & Verification

```bash
# Run all frontend tests
npm run test -w @acc/web

# Run unit tests
npm run test:unit -w @acc/web

# Run security invariant tests
npm run test:security -w @acc/web
```
