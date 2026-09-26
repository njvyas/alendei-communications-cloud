# API Architecture

## 1. Namespace & versioning

All public and console APIs are served under `/api/v1`. Breaking changes ship as `/api/v2` alongside `/api/v1` for a documented deprecation window; non-breaking additions never bump the version. Version is in the URL path, not a header, for cache/proxy/observability simplicity.

## 2. Resource areas

| Path | Module | Purpose |
|---|---|---|
| `/auth` | `iam` | Login, refresh, logout, session management, `/auth/me`. **Built in Phase 1B.3.** No MFA challenge — MFA is not implemented (ADR-003 D-6) |
| `/ws/ticket` | `iam` | Mints a single-use, short-lived WebSocket connection ticket (§9). Issuance ships in Phase 1B; ticket *consumption* and the socket gateway are deferred (`DECISIONS.md` D15) |
| `/organizations`, `/workspaces`, `/teams` | `tenancy` | Organization/workspace/team administration — **IN PHASE 1C** (§3g, ADR-012 OD-4). `/tenants/workspaces` exists today as a read-only surface and is kept as a deprecated alias through Phase 1C; no new `/tenants/*` route is added |
| `/audit-logs` | `audit-read` | Audit trail read: list and detail. **Built in Phase 1B.6.3** (§3f). Read-only — the write path is `AuditWriter` and is unchanged |
| `/api-keys` | `api-keys` | API-key administration: list, detail, create, revoke. **Built in Phase 1B.6.2** (§3e). Authentication of API keys is `auth`'s and is unchanged (§3) |
| `/users` | `users` | User lifecycle administration: list, detail, create, profile update, disable, reactivate. **Built in Phase 1B.6.1** (§3d). Its own module rather than `tenancy`: `AuthModule` imports `IamModule` for the credential and session primitives, so a user controller placed there and needing `RoleAssignmentService` would close a cycle through `RbacModule` |
| `/roles` | `rbac` | Role CRUD (custom roles), plus read of the platform role definitions. **Built in Phase 1B.5.4** (§3c) |
| `/role-assignments` | `rbac` | Scope-bound role grant and revocation. **Built in Phase 1B.5.5** (§3c) |
| `/permissions` | `rbac` | Permission catalogue (read-only, system-defined). **Built in Phase 1B.5.4** (§3c) |
| `/channels` | `provider-registry` | Supported channel catalogue |
| `/providers` | `provider-registry` | Provider CRUD, enable/disable/drain, capability config |
| `/routing` | `provider-router` | Routing policy CRUD, versioning, activation |
| `/fallback-policies` | `fallback-engine` | Fallback chain CRUD |
| `/messages` | `comms-api` | Send message, get message/attempt status |
| `/conversations` | `conversations` | Inbox thread listing/detail, reply |
| `/contacts` | `contacts` | Contact CRUD, identities, consent, suppression |
| `/campaigns` | `campaigns` | Campaign CRUD, launch, pause, progress |
| `/templates` | `templates` | Template CRUD, provider mapping, approval status |
| `/journeys` | `journeys` | Journey CRUD, versioning, activation, execution status |
| `/billing` | `billing` | Ledger read, invoices, GST detail |
| `/wallets` | `billing` | Wallet balance, recharge, auto-recharge config |
| `/resellers` | `resellers` | Reseller CRUD, markup config, branding |
| `/reports` | cross-module read models | Delivery/cost/quality reporting |
| `/webhooks/{provider}` | `webhooks` | Inbound provider webhook receivers, per-provider sub-path (`ARCHITECTURE.md` §10a) |
| `/webhook-endpoints` | `webhooks` | Customer-facing outbound webhook subscription CRUD (`ARCHITECTURE.md` §10b) |
| `/webhook-deliveries` | `webhooks` | Outbound delivery status query + replay (`EVENTS.md` §5d) |
| `/health` | platform | Liveness/readiness, unauthenticated, minimal detail |

### 2a. `POST /messages` — channel-pinning fields

`POST /messages` accepts an optional `requested_channel_id`. When supplied, it is a **hard channel constraint by default** — ACC never substitutes a different channel for that message unless the caller also sets `cross_channel_fallback_enabled: true`. This is the API-facing view of the mechanism defined canonically in `ROUTING_ENGINE.md` §1a; do not re-derive the semantics independently here. A caller sending a transactional OTP should never set `cross_channel_fallback_enabled`; a caller sending a marketing message that should be allowed to escalate across channels must set it explicitly — the platform default is the safer, non-escalating behavior.

## 3. Authentication & request identity

Every authenticated caller resolves to exactly one **identity type**, and `audit_logs.actor_type` (`DATABASE.md` §12) always records which:

| Identity type | Mechanism | Header | Use |
|---|---|---|---|
| Human user | Session JWT | `Authorization: Bearer <access_token>` | Web console (MFA is DEFERRED, `SECURITY.md` §1) |
| Service account (API key) | Hashed API key | `Authorization: Bearer <api_key>` (distinguished by prefix, e.g. `ak_live_`) | Server-to-server integration, bound to one org and an explicit permission subset |
| OAuth2 client | Client credentials / auth-code bearer token | `Authorization: Bearer <token>` | Partner integrations (reserved, Phase 6+); a client is its own identity, distinct from any human user it may act on behalf of |
| System (background worker) | Internal, no HTTP request in the loop | n/a | Fallback escalation, scheduled jobs, event consumers — never presents an HTTP credential; its tenant context comes from the job/event payload per `TENANCY.md` §5, and its audit rows always carry `actor_type=system` |

These are not interchangeable for authorization purposes: a permission grant is checked against the actual identity type presenting the request, and an OAuth2 client is never silently treated as if it were the human user who authorized it (the human's identity, where relevant, is recorded separately as the authorizing party).

**An API key's effective permissions are an intersection, recomputed at use:**

```
effective_permissions =
      requested_key_scopes
    ∩ permissions_held_by_the_creator_at_the_key's_binding_scope   (organization or workspace, RBAC.md §5c)
    ∩ permissions_valid_for_the_target_operation
```

A key is permanently bound to its organization (`api_keys.org_id`) and nothing on a request widens that binding: an `X-Acc-Organization` naming any other organization is refused with `403 TENANCY_CONTEXT_MISMATCH` rather than ignored. A key bound to a workspace is restricted to it and cannot perform organization-wide operations. The creator intersection is recomputed on every request, so a key cannot outlive the authority that produced it (`RBAC.md` §5c).

Every successful API-key authentication emits an `api_key.authenticated` audit record, in the same transaction as the key's `last_used_at` bookkeeping. The record identifies the key by its row id only — never the presented credential, its secret half or its prefix.

The database enforces the same distinction rather than trusting the caller: `audit_logs_actor_shape` makes an actor identifier that contradicts `actor_type` unrepresentable — a `user` row cannot carry an API-key id, a `system` row cannot claim either, and an `oauth_client` row must carry an `actor_label` since it has no id column until OAuth2 ships (`DECISIONS.md` D6). An API-key actor is additionally tied to its own organization by a composite foreign key, so a key from one tenant can never appear as the actor on another tenant's record (`DATABASE.md` §12).

Every authenticated request resolves a `TenantContext` per `TENANCY.md` §2a before any handler executes; no handler trusts a body/query tenant identifier over the resolved context.

### 3a. Scope enforcement order

Authorization is two checks, not one, and both are mandatory (`TENANCY.md` §4a):

1. **Permission** — does the principal hold the permission this endpoint requires?
2. **Scope coverage** — does it hold that permission at a scope *covering the target resource's scope*, per the downward-only inheritance of `TENANCY.md` §1a.4?

Holding `workspaces.update` somewhere is never authority to update *this* workspace. A request that passes (1) and fails (2) is refused exactly as if it had failed (1).

**Enumeration follows the same rule as retrieval.** A list endpoint returns only what is within the caller's scope set; an out-of-scope resource is *absent* from the listing rather than present-and-forbidden. A direct fetch of an out-of-scope resource returns `404` — not `403` — and the error message never echoes the caller-supplied identifier, because either would confirm the resource exists.

**Path identifiers are advisory.** `GET /tenants/workspaces?orgId=` may carry an `orgId` for readability, but the authoritative organization is always the one resolved from the credential; a mismatch is `403` (`TENANCY.md` §2b). The same rule applies wherever the identifier arrives — path segment, query parameter, body field or header — and is enforced by one shared mechanism rather than a comparison per endpoint (ADR-004 D-3). Its outcomes are fixed:

| Supplied identifier | Response |
|---|---|
| Agrees with the resolved context | The request proceeds unchanged |
| Contradicts it | `403 TENANCY_CONTEXT_MISMATCH` — never substituted, never an empty `200` |
| Names something that does not exist, at a level the context pins | The **same** `403`, with an identical message, so the endpoint is not an existence oracle. At a level the context does **not** pin (e.g. a `workspaceId` supplied by an organization-scoped principal) nothing is checked here; target-scope authorization and RLS decide, and an unreachable target is a `404` (`TENANCY.md` §2b) |
| Repeated or structured (`?org_id=A&org_id=B`) | `400 VALIDATION_FAILED` — refused, never resolved by parameter order |
| Malformed or empty | `400 VALIDATION_FAILED` — never treated as absent |
| Absent, where the endpoint declares it optional | The request proceeds under the resolved context |

An error never echoes the supplied identifier back.

**Selecting an organization when several are in scope.** A principal with grants in more than one organization sends the `X-Acc-Organization` header to choose which one the request acts in (`TENANCY.md` §2a, ADR-003 D-4). With exactly one organization in scope the header is optional. Absent while several are in scope → `400 TENANCY_CONTEXT_REQUIRED`. Naming an organization outside the principal's scope → `403 TENANCY_CONTEXT_MISMATCH`. The header selects among organizations already in scope; it never confers access, and a mismatch is never resolved by substituting a different organization or by returning an empty result.

**Scope-target authorization is not the guard's job alone.** The endpoint permission may be enforced declaratively, but the target-scope half is checked inside the service, through the shared evaluator, because a target's scope is often knowable only once it is loaded (`RBAC.md` §2, ADR-003 D-5).

**The endpoint guard is necessary and never sufficient**, and the two halves are wired so that omitting the second is a test failure rather than a silent hole. The declarative guard records the permission the route requires; the service-layer check asserts at runtime that the permission it is being asked about is the one the route declared, and that the target's scope is covered by a coherent grant (ADR-005 D-1) whose ancestry was resolved from the database (ADR-005 D-5). A scoped route that never reaches the service-layer check is caught by a test asserting every such route performs exactly one, rather than by review. Passing the guard alone authorizes nothing.

### 3b. Token transport, CORS and CSRF (Phase 1B, ADR-003 D-7)

**Access token** — returned in the login/refresh JSON response and presented as `Authorization: Bearer <token>`. Held in memory by the console. Never placed in a URL, a query parameter, `localStorage` or `sessionStorage`.

**Refresh token** — for the browser console, carried exclusively in a cookie:

| Attribute | Value | Why |
|---|---|---|
| `HttpOnly` | yes | JavaScript cannot read it, so an XSS foothold cannot exfiltrate a 30-day credential |
| `Secure` | yes | Never transmitted over plaintext HTTP |
| `SameSite` | `Lax` | Not attached to cross-site subrequests |
| `Path` | `/api/v1/auth` | Not sent on ordinary API calls; sent only to the `/auth/*` routes (login, refresh, logout, me, sessions) |

`POST /auth/login` sets the cookie, and accepts **only** `Content-Type: application/json` (`415` otherwise) so a cross-site HTML form cannot sign a browser in (login-CSRF, ADR-011 D-6). `POST /auth/refresh` consumes it. **The refresh token is never returned as ordinary JSON to browser JavaScript.** Non-browser clients (server-to-server) authenticate with API keys and never use this flow at all.

**CORS.** Because the refresh call must send a cookie, it is a credentialed cross-origin request: the console sends `credentials: 'include'`, and the API must answer with an explicit `Access-Control-Allow-Origin` drawn from the configured `CORS_ORIGINS` allow-list plus `Access-Control-Allow-Credentials: true`. A wildcard origin is invalid on a credentialed request and must never be configured.

**CSRF.** `SameSite=Lax` is a mitigation, not a guarantee — it is not honoured uniformly by older user agents, and it does not cover same-site attacker-controlled content. The refresh endpoint therefore also requires a **non-simple request**: it accepts only `POST` carrying the header `X-Acc-Refresh`, which forces a CORS preflight and makes the endpoint undrivable by a cross-site HTML form post. Logout is protected the same way. This is a required control, not a defence-in-depth nicety: without it, `SameSite=Lax` alone is the only thing standing between a cross-site request and a token rotation.

The mechanism is the *absence* of a token rather than the presence of one: nothing is stored or compared, so there is no CSRF secret to leak, rotate or desynchronize. The protection comes entirely from the fact that a cross-origin caller must first pass a preflight that the origin allowlist refuses, and an HTML form cannot set a header at all.

**Refresh rotation.** Every refresh rotates the token and records lineage. Presenting an already-rotated refresh token is treated as theft: the entire session chain is revoked and the event is audited.

### 3c. Role and grant administration (Phase 1B.5)

**Implementation status.** **Roles** and **Permissions** ship in Phase 1B.5.4; **role assignments** ship in Phase 1B.5.5; **authorization introspection** (`GET /auth/me/authorization`) ships in Phase 1B.5.7. All four are live.

All list endpoints in this section return the normalized envelope of §8 — `{data, page}` for a collection, `{data}` for a single resource — and obey §8b's per-endpoint filters and sorts. The unpaginated, named-key shapes described in earlier drafts of this section were superseded by Phase 1B.5.8.

Eleven endpoints, deliberately small: five on `/roles`, one on `/permissions`, four on `/role-assignments`, and the self-only introspection route. Every mutation writes its audit row **in the same transaction** as the change (ADR-003 D-2); every target scope is checked through the shared evaluator against a coherent grant (§3a); every out-of-scope target is `404` without echo rather than `403`.

**Roles** (module `rbac`) — **IMPLEMENTED, Phase 1B.5.4**

| Method | Path | Permission | Target scope | Request | Response | Errors | Audit | Idempotency | Transaction |
|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/roles` | `roles.read` | organization | filters `isSystemRole?`, `key?`, plus `limit`/`cursor`/`sort` (§8) | `{data:[{id,key,name,description,orgId,isSystemRole,allowedScopeTypes[],permissions[],createdAt,updatedAt}], page}` — the organization's own roles plus the readable platform definitions | `400` bad cursor, sort or unknown parameter | — | safe | one read-only tenant transaction |
| `GET` | `/roles/:id` | `roles.read` | organization | — | `200` role | `404` unknown or out-of-scope, with no echo of the id | — | safe | one read-only tenant transaction |
| `POST` | `/roles` | `roles.create` | organization | `{key,name,description?,allowedScopeTypes[],permissions[]}` | `201` role | `409` duplicate key; `403` a permission outside the actor's effective grant authority, or a `platform.*` permission; `400` malformed key, unknown permission, empty `allowedScopeTypes`, or an `allowedScopeTypes` outside organization/workspace/team | `role.created` | **`Idempotency-Key` supported** (§4); without one, a duplicate key is `409`, never a silent success | one transaction: role + `role_permissions` + audit |
| `PATCH` | `/roles/:id` | `roles.update` | the role's organization | `{name?,description?,allowedScopeTypes?,permissions?}` | `200` role | `404` unknown/out-of-scope; `403` as above, **and `403` for any system or platform role** | `role.updated` with full `before`/`after` | naturally idempotent | one transaction |
| `DELETE` | `/roles/:id` | `roles.delete` | the role's organization | — | `204` | `404` unknown/out-of-scope; **`409` while any grant references it** (and `ON DELETE RESTRICT` beneath it); `403` system or platform role | `role.deleted` with `before` | `404` if already gone | one transaction |

`allowedScopeTypes` is persisted from Phase 1B.5.4, returned on every role, and **enforced at grant time from Phase 1B.5.5** (`RBAC.md` §7): a grant naming a scope level the role does not admit is refused `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED`, with `details` carrying `roleKey`, `allowedScopeTypes` and `requested`. A client may present it as an active constraint.

`permissions` is a **complete replacement set**, not a delta. That is what lets the audit row describe the whole role rather than one edit, and it removes the add/remove endpoint pair that would otherwise need to stay consistent with each other.

**Permissions** (module `rbac`) — **IMPLEMENTED, Phase 1B.5.4**

| Method | Path | Permission | Target scope | Response | Notes |
|---|---|---|---|---|---|
| `GET` | `/permissions` | `permissions.read` | organization | `{data:[{key,domain,action,description}], page}` | The catalogue is system-defined and read-only. There is no permission CRUD. Filter `domain?`; sorts `key`, `domain`, default `key` (§8b) |

**Role assignments** (module `rbac`) — **IMPLEMENTED, Phase 1B.5.5**

| Method | Path | Permission | Target scope | Request | Response | Errors | Audit | Idempotency | Transaction |
|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/role-assignments` | `role_assignments.read` | organization | filters `userId?`, `scopeType?`, `scopeId?`, plus `limit`/`cursor`/`sort` (§8) | `{data:[{id,userId,roleId,roleKey,orgId,scopeType,scopeId,grantedBy,createdAt}], page}` | `400` bad cursor, sort or unknown parameter | — | safe | one read-only tenant transaction |
| `GET` | `/role-assignments/:id` | `role_assignments.read` | organization | — | `200` assignment | `404` unknown or out-of-scope, with no echo of the id | — | safe | one read-only tenant transaction |
| `POST` | `/role-assignments` | `role_assignments.grant` | **the scope being granted at** | `{userId,roleId,scopeType,scopeId}` | `201` assignment | `404` scope or role out of reach (never confirmed to exist), or target user unreachable; `403 AUTHZ_SCOPE_DENIED` scope outside the actor's own scope set; `403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION` a permission outside its effective grant authority at that scope, naming the offending keys; `403 AUTHZ_PLATFORM_ROLE_REQUIRED` a platform role; `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED` scope type not admitted by the role; `409` duplicate, or a disabled target user | `user_role.granted` at the grant's scope | duplicate is `409`, decided by the unique index rather than by a check-then-insert | one transaction: guards → insert → audit |
| `DELETE` | `/role-assignments/:id` | `role_assignments.revoke` | the grant's scope, read from the stored row | — | `204` | `404` unknown, out-of-scope or already gone; `403` if the actor does not cover the grant's own scope; **`409 AUTHZ_LAST_PLATFORM_ADMIN` if it would remove the last active platform administrator** (Phase 1B.5.6) | `user_role.revoked` | `404` if already gone; two concurrent revocations yield one `204` and one `404` | one transaction: authorize → conditional delete → audit |

`POST /role-assignments` is the highest-risk endpoint in Phase 1B, and its target scope is **the scope being granted at** — not the actor's resolved context. That is what makes `RBAC.md` §7's non-escalation rule enforceable: the actor must cover the grant's scope and hold every permission the role carries *at that scope*, decided per coherent grant rather than against the flattened `principal.permissions`.

**`409 AUTHZ_LAST_PLATFORM_ADMIN`** is returned when revoking a grant would leave the platform with no active administrator (`RBAC.md` §7a). It is `409` rather than `403` deliberately: the actor held the authority and the request was well-formed — the platform may simply not enter that state, and the remedy is to appoint another administrator first, not to acquire more permission. The same condition is enforced by a database trigger beneath the service, so it holds for callers that never reach this API.

`scopeType` accepts `reseller`, `organization`, `workspace` and `team`. **`platform` is not representable**: a platform grant is made by the bootstrap CLI under a documented elevation (`RBAC.md` §5b), and leaving it out of the request shape means the refusal does not depend on a guard remembering to run. Note that `reseller` is representable but **cannot succeed** through this API: every platform-level role (including `reseller_admin`) is refused with `403 AUTHZ_PLATFORM_ROLE_REQUIRED`, and no tenant role admits `reseller` scope.

**Query cost is constant per request**, independent of how many permissions the role carries: the scope chain is resolved once per check and the evaluator then decides in memory. `GET` list and `GET` detail are 2 queries, `DELETE` is 4, `POST` is 7 — plus the six `SET LOCAL` statements every tenant transaction issues. There is no N+1.

These endpoints carry the three filters named above and the shared `limit`/`cursor`/`sort` parameters; sorts are `createdAt` and `scopeType`, default `-createdAt` (§8b).

**Authorization introspection** — **IMPLEMENTED, Phase 1B.5.7**

| Method | Path | Permission | Response |
|---|---|---|---|
| `GET` | `/auth/me/authorization` | none — self only, no target scope | `{actorType, userId, apiKeyId, grants:[{roleId,roleKey,scopeType,scopeId,orgId,permissions[]}], organizationIds[], isPlatformAdmin}` |

Grants are returned **as grants**, not flattened. A console cannot render a correct permissions UI from a union, and handing it one is how an incorrect flattened model gets reinvented client-side — each entry carries the scope its permissions are held at, and the response contains no union field at all. It discloses nothing the principal could not already derive, exactly as `authorizedOrganizationIds` on `/auth/me` already does.

**Self-only structurally.** The subject is the authenticated principal; there is no path segment, query parameter or body field that names anyone else, so there is nowhere to put a forged identifier (`DECISIONS.md` D23). For an API-key principal the grants are the key's *effective* authority, already intersected at its binding scope (§3).

**Field naming is camelCase**, as everywhere else in this API. This row previously showed snake_case, which the implementation has never used.

**Deliberately excluded from Phase 1B.5**

| Not built | Why |
|---|---|
| Permission create/update/delete | The catalogue is system-defined; a permission with no code enforcing it is a lie, and one enforced nowhere is a liability |
| Bulk grant/revoke | Defeats per-grant auditing: one request would produce either one row describing many privilege changes, or many rows with no way to tell which were intended |
| `PUT /users/:id/roles` (set replacement) | A set replacement hides individual revocations from the audit trail. Revocation is an explicit act with its own record (`RBAC.md` §8b) |
| Role permission add/remove endpoints | Subsumed by `PATCH /roles/:id`'s replacement set, with a complete `before`/`after` |


### 3d. User lifecycle administration (Phase 1B.6.1)

**Implementation status.** **IMPLEMENTED, Phase 1B.6.1.** Six endpoints. API-key management and audit read remain out of scope; invitation *delivery* is still blocked on `DECISIONS.md` D16.

**The lifecycle model is the one migration `0000` already defined**, exposed rather than extended:

```
invited  ──(credential set out of band, D16)──▶  active  ──disable()──▶  disabled
   ▲                                                ▲                       │
   └──────────────── reactivate() ──────────────────┴───────────────────────┘
```

`users_active_requires_credential` enforces at the database that an `active` user holds a password or an MFA secret, so `invited` is precisely the state that cannot authenticate. That constraint is what makes the three states a model rather than a label, and it is why reactivation restores a credential-less user to `invited` rather than to `active` (ADR-007 D-2).

**There is no `DELETE /users/:id`, and its absence is structural.** `acc_app` holds no `DELETE` grant on `users` (migration `0000`), so the application role could not perform one however the service were written. Users are referenced by `sessions`, `api_keys.created_by`, `user_roles`, `idempotency_keys.actor_user_id` and `audit_logs.actor_user_id`; an audit trail must outlive the identity it describes. Disable is the deletion semantics this system has, and a `DELETE` returning `204` while merely disabling would be a lie in the route table (ADR-007 D-1).

**Tenancy, for a table that has none.** `users` carries no organization column: an identity is platform-level and its tenancy is entirely the grants it holds (`TENANCY.md` §1). Every endpoint here narrows to *users holding at least one grant in the request's organization*, beneath which `users_select` RLS still applies. The two are not redundant — RLS admits any user reachable through **any** organization in scope, which for a reseller admin is wider than the organization the request selected.

| Method | Path | Permission | Target scope | Request | Response | Errors | Audit | Idempotency | Transaction |
|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/users` | `users.read` | organization | `status?`, `email?`, plus `limit`/`cursor`/`sort` (§8) | `{data:[user], page}` | `400` bad cursor, sort or unknown parameter | — | safe | one read-only tenant transaction |
| `GET` | `/users/:id` | `users.read` | organization | — | `{data:user}` | `404` unknown or not a member of this organization, with no echo of the id | — | safe | one read-only tenant transaction |
| `POST` | `/users` | `users.invite` | organization | `{email, phone?, initialRole:{roleId, scopeType, scopeId}}` | `201 {data:user}` with `status: "invited"` | `409` address already registered; `404` role or scope out of reach; `403` the grant exceeds the actor's authority at that scope, or names a platform role; `422` scope type not admitted by the role; `400` malformed address or missing `initialRole` | `user.invited` **and** `user_role.granted`, both in the same transaction | **`Idempotency-Key` supported** (§4) | one transaction: authorize → insert → grant → audit |
| `PATCH` | `/users/:id` | `users.update` | organization | `{phone?}` — `null` clears | `200 {data:user}` | `404`; `400` any other property | `user.updated`, only when something changed | naturally idempotent; no key | one transaction |
| `POST` | `/users/:id/disable` | `users.disable` | organization | — | `200 {data:user}` | `404`; `409 USER_LIFECYCLE_CONFLICT` already disabled; **`409 AUTHZ_LAST_PLATFORM_ADMIN`** | `user.disabled` | not keyed — the transition is its own answer | one transaction: authorize → guard → status → revoke sessions → audit |
| `POST` | `/users/:id/reactivate` | `users.reactivate` | organization | — | `200 {data:user}` | `404`; `409 USER_LIFECYCLE_CONFLICT` not disabled | `user.reactivated` | not keyed | one transaction |

The user resource, in full — and the list is exhaustive:

```jsonc
{ "id": "uuid", "email": "a@b.test", "phone": "+91…|null",
  "status": "invited|active|disabled",
  "lastLoginAt": "ISO-8601|null", "createdAt": "ISO-8601", "updatedAt": "ISO-8601" }
```

**Nothing else is ever returned.** No `passwordHash`, no `passwordUpdatedAt`, no `mfaSecretRef`, no `mfaEnabled`, no session, token or API-key material. `password_hash` and `mfa_secret_ref` are credential material (`SECURITY.md` §1); `mfa_enabled` is withheld because MFA is not implemented at all (`RBAC.md` §5) and publishing the flag would imply a shipped control.

**Role assignments are not embedded.** They are their own resource with their own read model — `GET /role-assignments?userId=` — and copying them here would be a second representation of authorization to keep in step with the first.

**Creation takes no password, returns no password, and mints no credential.** A created user is `invited` and cannot authenticate. How an invited user comes to hold one is `DECISIONS.md` D16 and is still undecided; this phase neither guesses at it nor sends anything. No invitation email, SMS or WhatsApp message is sent by any code path.

**`initialRole` is required, and that is the data model rather than a preference.** A user with no grant is invisible to the administrator who created them, to `GET /users` and to the `users_select` policy — the only remaining trace would be a `409` the next time someone tried the same address. The grant is made through `RoleAssignmentService` in the same transaction, with its five guards intact; only guard 5's reachability *probe* is skipped, because the user this transaction just created cannot yet hold the visible grant it looks for (ADR-007 D-4).

**`email` is not editable.** Changing the login identity would have to settle case-normalized global uniqueness, whether live sessions survive, what an API key created by the old address means, whether the old address may be reclaimed, and how account recovery behaves across the change. The honest mechanism is a verified change flow that does not exist, and a `PATCH` that quietly rewrote the identity would be that flow's absence shipped as a feature. Deferred, explicitly.

**Disabling a platform administrator.** The last-active-administrator invariant applies to this endpoint exactly as it does to `DELETE /role-assignments/:id`: `409 AUTHZ_LAST_PLATFORM_ADMIN`, with `trg_users_platform_admin_liveness` (migration `0005`) as the final authority beneath it. The service takes the same advisory lock first for the lock ordering ADR-005 D-7 describes, and a `restrict_violation` from a lost race is translated to the same `409` rather than surfacing as a `500`.

**Disable is global to the identity, not local to the organization.** This is the one behaviour on this surface most likely to be misread, so it is stated plainly: `users.status` is a column on `users`, and `users` is a platform-level identity with no organization column (`TENANCY.md` §1). Disabling therefore:

- sets the status of **the identity**, not of a membership, so the user loses access to **every** organization they belong to — including organizations under other resellers, administered by people who were not party to the request;
- revokes **every** live session of that user, not only the ones used against the acting organization, because `sessions` carries no organization term either.

The permission needed is `users.disable` in **one** organization the target is a member of, so an administrator of Organization A can disable a user who also belongs to Organization B. That follows from the single-identity model rather than from a gap in this endpoint: one person is one account, so account-level state is shared by every organization that person belongs to. Changing it would require per-membership status — a second membership model that `TENANCY.md` deliberately does not have.

**So this operation must not be presented as "remove the user from this organization".** It is not. The organization-local action is revoking that user's grants in that organization (`DELETE /role-assignments/:id`, §3c), which ends their access *here* and leaves every other organization untouched. The two are different operations with different blast radii and a console should offer whichever it means.

**Audit asymmetry, recorded rather than hidden.** The `user.disabled` record is filed at the **acting** organization's scope, because that is where the actor legitimately was (ADR-005 D-6, and the audit scope rules in `SECURITY.md` §4). An organization that loses a user to someone else's disable therefore has no audit row of its own describing it. No second record is synthesized for the affected organizations: fabricating one would attribute an action to a tenant whose administrators did not perform it, and `fn_validate_audit_scope` derives tenancy from the scope the caller names. The visibility gap is real and is revisited when the audit read surface ships in Phase 1B.6.3.

**Sessions on disable: both controls, neither new.** `AuthGuard` re-reads the user on every request and refuses a non-active one, so a disabled user is locked out at their next request whatever happens to their session rows — that is the guarantee, and it does not depend on the endpoint. The endpoint additionally revokes every live session through the existing `SessionService`, in the same transaction, so the stored state agrees with it. Reactivation does **not** restore those sessions: it returns the ability to sign in, not the sessions that existed before.

**Query cost is bounded and constant-shaped.** `GET /users` is one query over `users` with an `EXISTS` semi-join into `user_roles`, supported by `user_roles_org_user_id_idx` (migration `0008`) and bounded by the organization's own membership; there is no `COUNT(*)` and no N+1. Detail is 1 query, `PATCH` 3, disable 6, reactivate 5, create 9 — plus the six `SET LOCAL` statements every tenant transaction issues.

**Deliberately excluded from Phase 1B.6.1**

| Not built | Why |
|---|---|
| `DELETE /users/:id` | `acc_app` has no such grant, and the audit trail must outlive the identity. Disable is the deletion semantics (ADR-007 D-1) |
| Invitation delivery, invitation tokens, administrator-set passwords | `DECISIONS.md` D16 is undecided. Inventing a token table or returning a temporary credential would be the unsafe workaround the decision exists to prevent |
| Email change | Needs a verified change flow that does not exist — see above |
| Free-text user search | Deferred with search generally (`FRONTEND_API_CONTRACT.md` §16). `email` is an exact, case-insensitive match, not a search |
| `mfaEnabled` on the resource | MFA is not implemented; publishing the flag would imply otherwise |
| API-key management, audit read | Phase 1B.6.2 and later |


### 3e. API-key administration (Phase 1B.6.2)

**Implementation status.** **IMPLEMENTED, Phase 1B.6.2.** Four endpoints. Rotation, secret recovery, secret delivery, IP allowlists, quotas and usage analytics are all out of scope and deferred.

**This surface administers keys; it does not authenticate them.** Authentication, the creator intersection at the binding scope and the creator-status check all live in `AuthGuard` and are unchanged since Phases 1B.3, 1B.5.1 and 1B.6.1 respectively (§3, `RBAC.md` §5c).

**Lifecycle**, with expiry derived rather than stored:

```
create ──▶ active ──revoke()──▶ revoked        (terminal)
              │
              └──expires_at passes──▶ expired  (derived, no transition)
```

| Method | Path | Permission | Target scope | Request | Response | Errors | Audit | Idempotency |
|---|---|---|---|---|---|---|---|---|
| `GET` | `/api-keys` | `api_keys.read` | the request's organization | `status?`, `scopeType?`, `scopeId?`, `name?`, plus `limit`/`cursor`/`sort` | `{data:[apiKey], page}` | `400` bad cursor, sort or unknown parameter | — | safe |
| `GET` | `/api-keys/:id` | `api_keys.read` | **the key's stored binding scope** | — | `{data:apiKey}` | `404` unknown or out of reach, no echo | — | safe |
| `POST` | `/api-keys` | `api_keys.create` | **the binding scope named in the body** | `{name, scopeType, scopeId, scopes[], expiresAt?}` | `201 {data:{…apiKey, secret}}` | `403` requested scopes exceed the creator's authority there, or the caller is an API key; `404` scope out of reach; `400` validation, unknown permission, non-future `expiresAt` | `api_key.created` | **`Idempotency-Key` supported** — see below |
| `POST` | `/api-keys/:id/revoke` | `api_keys.revoke` | **the key's stored binding scope** | — | `200 {data:apiKey}` | `404`; `409 API_KEY_LIFECYCLE_CONFLICT` already revoked | `api_key.revoked` | not keyed |

**There is no `DELETE`, no un-revoke and no rotation.** Revocation is terminal. `audit_logs.actor_api_key_id` references this table, so a deleted key would take the attribution for everything it ever did with it.

The resource, in full:

```jsonc
{ "id": "uuid", "name": "CI deploy", "prefix": "ak_live_A1b2C3d4E5f6G7h8",
  "status": "active|expired|revoked",
  "scopeType": "organization|workspace", "scopeId": "uuid", "orgId": "uuid",
  "scopes": ["workspaces.read"],
  "expiresAt": "ISO-8601|null", "lastUsedAt": "ISO-8601|null",
  "revokedAt": "ISO-8601|null", "revokedReason": "string|null",
  "createdBy": "uuid|null", "createdAt": "ISO-8601", "updatedAt": "ISO-8601" }
```

**`key_hash` is never returned and never selected.** Every read goes through one projection that does not contain it — a bare `select()` on `api_keys` would return the Argon2id digest, and the only reliable defence is never to write such a query.

#### The secret is presented exactly once (ADR-008)

`POST /api-keys` is the only response that ever contains `secret`, and only on a **fresh** execution:

```jsonc
{ "data": { …resource, "secret": "aB3…" } }     // fresh creation, once
{ "data": { …resource, "secret": null } }        // idempotent replay, always
```

**There is no endpoint that can recover it.** Not `GET /api-keys/:id`, not a replay, not anything. The plaintext exists in memory for the duration of one request; only its Argon2id hash reaches the database.

**An idempotent replay returns `secret: null`**, because the stored snapshot never contained one. Storing it would write a live credential into `idempotency_keys.response_snapshot` — a plaintext column whose rows are never physically deleted (§7.1) — which ADR-008 refuses. Everything else about §4 is unchanged: at-most-once creation, the request fingerprint, current authorization on replay.

**If the creation response is lost, the credential is unrecoverable by design.** The remedy is to revoke the key and create another.

#### Binding scope

A key binds to an **organization** or a **workspace**, and to nothing else. That is the existing model rather than a new restriction: `api_keys.org_id` is `NOT NULL` with a nullable `workspace_id`, and `AuthGuard` derives the key's grant scope as "its workspace when it has one, otherwise its organization". `platform`, `reseller` and `team` are unrepresentable in the request.

The binding is **immutable**: there is no rebinding and no scope migration. A key bound to Organization A can never act against Organization B.

**A key's effective authority is its `scopes` ∩ what its creator holds at the binding scope**, recomputed on every request (`RBAC.md` §5c, ADR-005 D-4). `scopes` is therefore a *request*, not a grant. Creation additionally refuses a key asking for more than the creator holds there — `403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION`, naming the keys in `details.rejected` — so a caller gets a named refusal instead of a key that silently does less than it asked for.

**Only a signed-in user may create a key.** `api_keys.created_by` references `users`, and a key with no creator resolves to no permissions at all — so a key minted by another key would authenticate and be able to do nothing. Refused with `403` rather than producing a dead credential.

#### Expiration is derived, not stored

There is no status column and no sweeper. `status` is computed from `revoked_at`, `expires_at` and the current time at read, and **independently** at authentication, where `findApiKeyByPrefix` filters on the same two conditions. A key therefore stops working the moment it expires, whether or not anything has looked at it. Revocation wins over expiry in the rendered status, because "someone took it away" is the fact an operator needs; both are terminal for authentication either way.

`expiresAt` must be in the future, judged against the **database** clock so client skew cannot widen it. `null` means no expiry.

#### Query cost

`GET /api-keys` is 1 query over `api_keys`, supported by `api_keys_org_id_id_idx` / `api_keys_org_name_id_idx` (migration `0009`), with no `COUNT(*)` and no N+1. Detail is 2 (load, then the chain resolve inside the authorization check), revoke is 4, create is 7 — constant in the number of permissions requested, because the chain is resolved once and the evaluator then decides in memory. Plus the six `SET LOCAL` statements every tenant transaction issues.


### 3f. Audit read (Phase 1B.6.3)

**Implementation status.** **IMPLEMENTED, Phase 1B.6.3.** Two endpoints, both read-only. Export, streaming and retention management are out of scope.

| Method | Path | Permission | Target scope | Response |
|---|---|---|---|---|
| `GET` | `/audit-logs` | `audit.read` | the request's organization | `{data:[auditLog], page}` |
| `GET` | `/audit-logs/:id` | `audit.read` | **the scope the record was written at** | `{data:auditLog}` |

There is no `POST`, `PATCH` or `DELETE`, and the absence is structural rather than a choice of surface: `acc_app` holds `SELECT, INSERT` on `audit_logs` and no `UPDATE`, `DELETE` or `TRUNCATE` (migration `0001`), so the append-only guarantee does not depend on this controller.

The record:

```jsonc
{ "id": "uuid", "occurredAt": "ISO-8601",
  "action": "user_role.granted", "outcome": "success",      // success | failure | denied
  "actorType": "user",                                       // user | api_key | oauth_client | system
  "actorUserId": "uuid|null", "actorApiKeyId": "uuid|null", "actorLabel": "string|null",
  "resourceType": "RoleAssignment", "resourceId": "uuid|null",
  "scopeType": "workspace", "scopeId": "uuid|null",          // where it happened
  "resellerId": "uuid|null", "orgId": "uuid|null",           // derived ancestry
  "workspaceId": "uuid|null", "teamId": "uuid|null",
  "before": {…}|null, "after": {…}|null, "metadata": {…},
  "correlationId": "uuid", "causationId": "uuid|null",
  "ip": "string|null", "userAgent": "string|null" }
```

**Payloads are returned as stored.** `before`, `after` and `metadata` passed through the central redactor at **write** time (`SECURITY.md` §4), which is the single redaction boundary. Re-redacting on read would be a second redactor, and two redactors drift. There is no credential column on `audit_logs` to withhold.

**`ip` and `userAgent` are included deliberately.** They are personal data, and an audit trail that cannot say where a privilege change originated answers half the question an investigation asks. Access is gated by `audit.read`, an administrative permission.

#### Who sees what

Visibility is decided by `audit_logs_select` (migration `0001`) under the request's tenant context, with one narrowing applied above it:

| Caller | Sees |
|---|---|
| Platform administrator | Every row, including `platform`-scoped |
| Reseller-scope grant holder | Their organizations' rows **and** their reseller's own rows |
| Organization administrator | Their organization's rows, and workspace/team rows beneath it |
| Workspace-pinned principal | Refused the list entirely — a workspace grant cannot cover the organization target |
| API key | Its organization's rows, within its binding; never reseller rows |

**Reseller-scoped rows require a genuine grant at `reseller` scope.** Since ADR-011 `TenantContext.resellerId` is itself set only from such a grant and the database validates it, so RLS already enforces this; the list keeps an explicit narrowing from the grants as a second layer, so that it agrees with the detail route, which authorizes at the record's own scope (`SECURITY.md` §4).

**The invariant:** *a row appears in the list if and only if the detail route serves it.* Asserted across all five scope levels, and — since the Gate-B remediation — for sibling organizations sharing a reseller (`shared-reseller-isolation.sec-spec.ts`).

#### Filters, sorting, cost

Filters — all allow-listed, all narrowing **inside** what the policy already permits, none an isolation mechanism: `action`, `actorType`, `actorUserId`, `outcome`, `resourceType`, `resourceId`, `scopeType`, `scopeId`, `correlationId`, `occurredFrom`, `occurredTo`. The occurrence window is half-open `[from, to)` so consecutive windows tile without double-counting. A filter naming another tenant's organization matches nothing rather than reaching it.

Sorting is `occurredAt` only, default `-occurredAt`. An audit trail is read chronologically and every other dimension here is a filter; offering more sorts would add cursor surface and index requirements for orderings nobody investigates by. Chronological ordering runs on `id` — a UUIDv7 assigned by the same INSERT that defaults `occurred_at`, so the two are co-monotonic and `id` is the one that round-trips exactly through a text cursor.

**Query cost**: list is 2 queries (the authorization chain resolve, then one page), detail is 1–2 (the row, then a chain resolve that is free for `platform` scope). No `COUNT(*)`, no N+1. `EXPLAIN` confirms the default ordering is served by `Index Scan Backward using audit_logs_pkey`, so **no index was added** — none would be used by the current predicate shape, since the RLS disjunction is not sargable. At scale the cost characteristic is filter selectivity rather than a missing index; the fix would be a sargable tenant predicate, which is deferred because it conflicts with the reseller view.

### 3g. Phase 1C resources (ADR-012) — organizations IMPLEMENTED (1C.1a); the rest IN PHASE 1C

**Implementation status:** the organization routes are **implemented (Phase 1C.1a)**; workspaces, teams and the session routes are **not yet implemented**. The field-level contract — schemas, request bodies, success and error responses, idempotency and audit — is frozen in **`FRONTEND_API_CONTRACT.md` §31**, which is the single authority for these routes. This section indexes it and states the server-side rules; it deliberately does not restate fields, so the two cannot drift. The OpenAPI document generated in 1C.3 is asserted against §31.

| Area | Routes | Increment | Target scope rule |
|---|---|---|---|
| Organizations — **IMPLEMENTED** | `GET/POST /organizations`, `GET/PATCH /organizations/:id`, `POST /organizations/:id/suspend` · `/reactivate` · `/close` | 1C.1a ✅ | read/update at the organization; create at platform or at the creator's reseller; lifecycle at platform only (ADR-012 F-2, F-3) |
| Workspaces | `GET/POST /workspaces`, `GET/PATCH /workspaces/:id`, `POST /workspaces/:id/archive` · `/restore` | 1C.1b | list/create/archive/restore at the organization; read/update at the workspace |
| Teams | `GET/POST /teams`, `GET/PATCH /teams/:id`, `POST /teams/:id/archive` · `/restore` | 1C.1b | create/archive/restore at the workspace; read/update at the team |
| Sessions | `POST /auth/sessions/revoke-all`; `GET /users/:id/sessions`; `POST /users/:id/sessions/revoke-all`; `DELETE /users/:id/sessions/:sessionId`; changed `POST /auth/login` (eviction) and `POST /auth/logout` (expired-token path) | 1C.2 | self, or `sessions.read`/`sessions.revoke` covering the organization **and** every grant the target holds (ADR-012 F-9) |

**Server-side rules that apply to all of them:**

- Authorization goes through `AuthorizationService.assert` inside the request's tenant transaction, with the target's ancestry read from the database; every route is declared for the §6n case 30 route-coverage test; refusals write `authorization.denied`.
- **Organization status is an authorization input, not an RLS predicate** (ADR-012 OD-3, F-4, F-5) — **implemented in 1C.1a**: `ScopeResolver` excludes non-active organizations from what a principal without a platform grant may select, `AuthGuard` refuses such a principal naming one it is connected to (`403 TENANCY_ORGANIZATION_SUSPENDED` / `…_CLOSED`) and refuses an API key bound to one after its secret verifies, and `AuthGuard` refuses any mutating request in a non-active organization's context (`409 ORGANIZATION_LIFECYCLE_CONFLICT`) — which only a platform principal can reach. Platform principals keep read access. No RLS policy changed.
- **`GET /organizations` is a two-stage read with PostgreSQL RLS as the tenant-data backstop.** No single RLS context can express a principal's full organization reach (one organization, one reseller claim), and support is deliberately not an RLS platform administrator (ADR-011 D-2). So `acc_auth` determines only the candidate reach — the caller's grant-derived reach, the `status`/`resellerId` narrowing and the signed cursor — and returns candidate ids and sort keys, never organization row data. The page's rows are then fetched through `acc_app` under RLS, under contexts derived from the caller's own grants (the database-validated platform-administrator claim, a database-validated reseller claim per reseller grant held, an organization context per organization the caller may select). An authorization-reach regression must not expose another tenant's organization row: a candidate RLS withholds fails the request closed (`500 INTERNAL_ERROR`) rather than returning it or a partial page (ADR-012, 1C.1a implementation notes). Detail and every mutation run as `acc_app` under RLS, with the addressed organization as the tenant context.
- **`POST /organizations` runs in one `acc_app` transaction**: authorize under the caller's own context → (replay, if the idempotency key was used) → elevate to the provisioning context for exactly the new organization id → insert the organization → seed its system roles (`TenantRoleProvisioner`) → create its default workspace → audit. Idempotency for this route uses a dedicated path (`IdempotencyService.executeOrganizationCreation`): a transaction-scoped advisory lock on `(endpoint, actor, key)`, a lookup within the caller's RLS reach, and the record written in the new organization's namespace in the same transaction — no schema or policy change.
- Creating routes accept `Idempotency-Key` (§4); lifecycle routes are not keyed.
- All routes are authenticated `read`/`write` for the general limiter (§5a).
- **Compatibility:** `GET /tenants/workspaces` and `GET /tenants/workspaces/:id` remain as deprecated aliases through Phase 1C (ADR-012 F-7); no new `/tenants/*` route is added.
- **Not in Phase 1C:** `DELETE` for organizations, workspaces or teams; reseller CRUD or suspension (Phase 9); invitation/credential delivery (D16).

## 4. Idempotency

This section is the API-facing view of the tier-1 mechanism defined canonically in `DATABASE.md` §7.1 — see that section before implementing; do not re-derive the semantics independently here. **Implemented in Phase 1B.5.9** (ADR-006).

### 4a. What it is, and what it is not

Idempotency is **execution/replay coordination**: it records that a request ran and what it answered, so a retry after a network timeout returns the original answer instead of performing the work twice. It is **not** a business state machine — it never interprets, re-derives or re-validates the outcome, and the protected work is opaque to it.

**Supported today** (opt-in via the header; absent, the endpoint behaves exactly as before):

| Endpoint | Why |
|---|---|
| `POST /roles` | Creates a resource; a retry would otherwise be indistinguishable from a genuine duplicate |
| `POST /role-assignments` | Confers privilege; the same |
| `POST /users` | Creates an identity (and its initial grant); the same (Phase 1B.6.1) |
| `POST /api-keys` | Mints a credential; the replay returns `secret: null` (ADR-008, Phase 1B.6.2) |

**Deliberately not supported, with reasons** — this is a classification, not an omission:

| Endpoint | Why not |
|---|---|
| `GET`, `HEAD`, `OPTIONS` | Safe. There is nothing to execute twice |
| `PATCH /roles/:id` | The permission set is a **complete replacement**, so the endpoint is already naturally idempotent — re-applying it converges on the same state |
| `DELETE /roles/:id`, `DELETE /role-assignments/:id`, `DELETE /auth/sessions/:id` | `204`, and already naturally idempotent: a repeat is `404` because the row is gone, which is the honest answer and needs no stored response |
| `POST /auth/login` | Replaying a login would replay a **token**, turning a stored response into a credential. Sessions are deliberately per-attempt |
| `POST /auth/refresh` | Rotation is single-use **by design** (ADR-003): replay-detection there revokes the token family. Idempotency would directly contradict it |
| `POST /auth/logout` | `204`, naturally idempotent |

An endpoint is added to the first table only when a duplicate would cause a second side effect. Requiring the header for frontend convenience where it buys nothing is how a mechanism becomes ceremony.

### 4b. The key, and what counts as "the same request"

`Idempotency-Key: <opaque>` — 16 to 255 characters of `A-Za-z0-9`, `-`, `_`, `.`, `:`. A UUIDv7/v4 is the recommended form. The server assigns the value no meaning; the minimum length exists so a careless `1` does not collide inside a shared organization namespace. A malformed key is `400 IDEMPOTENCY_KEY_INVALID`, refused before any lookup.

The key is stored against `(org_id, endpoint, idempotency_key)` — organization-wide so a caller cannot collide with itself across workspaces, and per endpoint so the same key on a different route is a separate request.

**The effective request** is fingerprinted with SHA-256 over a canonical serialization of:

`method` · `route pattern` · `orgId` · **the resolved principal's identity** (`actorType`, `actorUserId`, `actorApiKeyId`) · `pathParams` · `query` · `body`.

Deliberately **excluded**, because a retry is by definition a different transport event and hashing any of it would defeat the mechanism: `Date`, request id, correlation id, causation id, user agent, source address, the `Authorization` header, cookies, and every other header.

**Canonicalization**: object keys sorted at every depth, so a client library or proxy that reorders JSON does not turn a safe retry into a mismatch; array order preserved, because `[a,b]` and `[b,a]` are different requests; `undefined` and absent treated alike; explicit `null` distinct from absent.

**Why the principal is in the hash.** The key scope is organization-wide, so without it one principal could present another's key and receive that principal's stored response. Binding identity into the fingerprint means a different actor computes a different fingerprint and is refused. The principal's *identity* is hashed; its credential never is.

**Where the key is accepted.** `POST /roles`, `POST /role-assignments` (Phase 1B.5.9), `POST /users` (Phase 1B.6.1) and `POST /api-keys` (Phase 1B.6.2 — whose response carries a **non-persistable** field, see §3e and ADR-008). It is **not** accepted on `PATCH /users/:id`, whose repeat is already the same state, nor on the lifecycle operations `POST /users/:id/disable` and `/reactivate`, whose second call is a `409 USER_LIFECYCLE_CONFLICT` naming the current status — a definite answer a retrying client can act on, and a better one than replaying a `200` that reports a transition as happening now when it happened earlier.

### 4c. Outcomes

| Situation | Result |
|---|---|
| First request | Executes, stores status + body, returns them |
| Identical repeat | **Replays the original status and body verbatim.** No re-execution, no marker added to the envelope. One exception, declared per field rather than per endpoint: a **non-persistable** field is stored as `null` and therefore replays as `null` — today only `secret` on `POST /api-keys` (ADR-008) |
| Same key, different effective request — including a different principal | `422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`. Nothing about the stored request is disclosed |
| Concurrent duplicate | Blocks on the original, then replays it. On exceeding the wait, `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` (retryable) |
| Any failure — validation, authorization, business `4xx`, `5xx`, crash | **Nothing is stored.** The key is free for a genuine retry |
| Key past its expiry | Reclaimed as a fresh request |
| No organization context | `400 TENANCY_CONTEXT_REQUIRED` — the key namespace is org-scoped |

**Only successes are stored**, and that is two guarantees at once. A transient database blip cannot permanently poison a key. And **a replay can never bypass authorization**: a refused request leaves nothing to replay, and a stored record is reached only *after* the current request has authenticated and had its own authorization evaluated, in the same transaction. A previously successful request is never a credential.

**Correlation ids.** A replay is its own request and carries **its own** `x-correlation-id`; the original's is kept on the record for diagnostics and is never returned as the current request's. Confusing the two would make a replay untraceable.

**Retention.** Records expire 24 hours after creation. Expiry is enforced at lookup — an expired record is reclaimed rather than replayed — so correctness does not depend on a sweeper. Physical deletion of expired rows is **not yet implemented**; see `DATABASE.md` §7.1.

## 5. Rate limiting

**Implementation status.** The **authentication** buckets ship in Phase 1B.3; the **general** limiter ships in Phase 1B.6.4. Both are **CURRENT**. Tenant-configurable limits are **PLANNED** — see below.

### 5a. The general limiter (CURRENT, Phase 1B.6.4)

- Keyed by `(org_id, principal, endpoint_class)`, using a Redis **fixed-window counter** (`INCR` + `EXPIRE NX` + `TTL`). **In Phase 1B this runs in-process in the API** — there is no API gateway in the Phase 1 deployment topology (`DEPLOYMENT.md`). Moving it to a gateway later is a deployment change, not a redesign; the key shape and limits are unchanged by where it runs.
- **Every term is server-derived.** `org_id` and `principal` come from the authenticated `RequestContext` that `AuthGuard` populated from a verified credential; `endpoint_class` from the matched route's own metadata. No header, query parameter, body field or path segment can influence any of them, so a caller cannot select or reset its own bucket.
- **Two endpoint classes**, and deliberately no more: `read` for `GET`/`HEAD`, `write` for `POST`/`PATCH`/`DELETE`. A route may override with `@RateLimit('read'|'write')`, a server-side literal union. Both classes draw on the **same** configured limit — the split provides *isolation*, so a write flood cannot exhaust the read budget, not differentiated budgets.
- **Limits are deployment-wide**: `RATE_LIMIT_DEFAULT_MAX` requests per `RATE_LIMIT_DEFAULT_WINDOW_SECONDS`, per bucket. Per-class and per-tenant limits are **PLANNED** (ADR-010).
- **Applies only where a principal exists.** A request with no authenticated principal has no key and is passed through — which is what keeps `POST /auth/login`, `POST /auth/refresh`, `/health*` and `/metrics` out of it without an exemption list anyone has to maintain.
- **A request is never charged to both limiters.** Auth endpoints are public, resolve no principal, and carry their own stricter buckets (§5b).
- **The window's edge is the known cost**: a caller may spend its budget at the end of one window and again at the start of the next, so the short-term peak can reach twice the limit. Acceptable for a throttle that bounds sustained load, and the same property the auth buckets have always had.

**Key shapes**, both built through `RedisKeyBuilder` so the deployment prefix and tenant namespace apply:

```
organization-scoped   {prefix}:t:{orgId}:ratelimit:{class}:principal:{principalId}
no organization       {prefix}:platform:ratelimit:{class}:principal:{principalId}
```

The second covers authenticated routes that are about the caller rather than a tenant — `/auth/me`, `/auth/me/authorization`, `/auth/sessions`, `/auth/logout`, all marked `@NoTenantContext()` — where a principal exists but no organization was selected. They are limited, and separately from any tenant's budget.

**An API key is bucketed by its own key id**, not its creator's user id, so a key has its own budget — the same separation its binding scope already gives it for authorization (`RBAC.md` §5c).

**Response headers**, on every generally-limited response:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | The configured ceiling for this bucket |
| `X-RateLimit-Remaining` | Tokens left in the current window, floored at `0` |
| `X-RateLimit-Reset` | **Seconds until the window resets** — a duration, not a timestamp, in the same unit as `Retry-After` |

On exhaustion: **`429`** with `Retry-After` (seconds) and the standard error envelope (§7), `code: RATE_LIMIT_EXCEEDED`, `retryable: true`, and `details.retryAfterSeconds`.

### 5b. The authentication buckets (CURRENT, Phase 1B.3)

- `POST /auth/login` carries its own stricter limit (`RATE_LIMIT_AUTH_*`), and applies **two independent buckets** — one keyed by source IP and one by the target account — so that neither address rotation nor a spray across many accounts defeats the control on its own. A refusal from *either* refuses the attempt.
- The account bucket is keyed by a truncated SHA-256 of the identifier (unsalted — a namespacing device), not the identifier itself.
- **A successful login clears the account bucket only**, never the IP bucket (ADR-011 D-5).
- `POST /auth/refresh` is throttled per source address (`RATE_LIMIT_REFRESH_MAX`, default 30 per window).
- Failed API-key presentations are throttled per source address **before** Argon2 verification (`RATE_LIMIT_API_KEY_FAILURE_MAX`, default 20 per window); a successful key presentation never spends the allowance. Once exhausted, every API key from that address is refused with `429` for the rest of the window.
- `TRUSTED_PROXY_HOPS` defaults to `0` and must be set explicitly in production (ADR-011 D-6).
- The IP key depends on `req.ip`, which depends in turn on how many proxy hops are trusted (`TRUSTED_PROXY_HOPS`). Trusting more hops than the deployment actually has lets a client forge `X-Forwarded-For` and choose its own bucket, so the value is configuration rather than a constant and `0` disables the trust entirely. **The general limiter does not key on IP at all**, so a forwarded-for value cannot influence it.

### 5c. Both limiters fail open

**When Redis is unavailable the limiter fails open**, logs at `warn` on every degraded call, and flags the verdict. Redis is an accelerator and never a system of record (`DATABASE.md` §1): refusing every request because a cache is down converts a degraded dependency into a total outage, and a limiter is a throttle rather than the authentication or authorization control — credentials are still verified, authorization still runs, and every failure is still audited. This is a tested decision, not the client's default error behaviour.

## 6. Webhooks — inbound vs. outbound (do not conflate; full model `DATABASE.md` §12, `EVENTS.md` §§4c, 5a–5d)

**Inbound** (`/webhooks/{provider}`): providers push delivery events to ACC. Verified, deduplicated, persisted to `webhook_events` before processing (`ARCHITECTURE.md` §10a).

**Outbound** (`/webhook-endpoints`, `/webhook-deliveries`): ACC pushes business events to customer-configured endpoints.

- `POST/GET/PATCH/DELETE /webhook-endpoints` manage a `webhook_endpoints` row: target URL, subscribed event types, status.
- Payloads are signed (`X-Alendei-Signature: t=<ts>,v1=<hmac>`), computed from the endpoint's `signing_secret_ref` (never exposed in plaintext after creation); the customer verifies using the secret shown once at creation/rotation time.
- Every delivery attempt is durably tracked on a `webhook_deliveries` row (`DATABASE.md` §12); failed deliveries retry with exponential backoff up to a configurable attempt cap, then move to `status=dead_letter` and the endpoint's `consecutive_failure_count` increments — after a configurable threshold the endpoint auto-disables (`EVENTS.md` §5a).
- `GET /webhook-deliveries` lists delivery status/history per endpoint; `POST /webhook-deliveries/{id}/replay` re-attempts a specific delivery (`EVENTS.md` §5d) — this **retries transmission only**, it never regenerates the underlying event or re-triggers a business action, and requires the same permission tier as any manual side-effect trigger, fully audit-logged.
- Replay protection on the *receiving* customer's side is enabled by the timestamp in the signature plus the stable `event_id` in every payload, which customers are expected to use for their own dedup on redelivery/replay.

## 7. Error contract

Consistent error envelope across all endpoints:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "human-readable message",
    "correlationId": "uuid",
    "retryable": false,
    "details": {}
  }
}
```

- `code`: stable, machine-readable, namespaced by domain (e.g. `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, `TENANCY_CONTEXT_MISMATCH`; future domains add codes such as `MESSAGES_INVALID_RECIPIENT`). The implemented set is `ERROR_CODES` in `packages/contracts/src/errors.ts`.
- `retryable`: `true` only for errors where an identical retry (same idempotency key, unchanged payload) is safe and may succeed (e.g. `429`, `503`); `false` for validation/authorization errors where retrying without changing the request is pointless. Clients should not blindly retry on any 4xx/5xx without checking this flag.
- `details`: structured validation failures where applicable (e.g. per-field messages), never a dump of internal exception state.

## 7a. Validation errors (Phase 1B.5.8)

A validation failure carries one issue **per failed rule**, not per field: a value can fail its type and its length at once, and collapsing those forces a form to re-derive which rule it was from prose.

```jsonc
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "correlationId": "uuid",
    "retryable": false,
    "details": {
      "issues": [
        { "field": "key",            "rule": "MATCHES",   "message": "key must be lower snake_case…" },
        { "field": "permissions.0",  "rule": "IS_IN",     "message": "each value must be one of…" }
      ]
    }
  }
}
```

- `field` — dotted path from the request root, so a form can address a nested member (`permissions.0`). Empty for an issue about the request as a whole.
- `rule` — stable screaming-snake code derived mechanically from the validator (`isUuid` → `IS_UUID`). Derived rather than hand-mapped, so a new decorator yields a sensible code without anyone remembering to extend a table.
- `message` — human-readable, and never load-bearing for a client's logic.

An unknown query or body parameter is **refused**, not ignored (`WHITELIST_VALIDATION`). Ignoring it is how a caller comes to believe a filter applied when it did not, which for a security-relevant filter is a silent widening.

## 8. Response envelope, pagination, filtering and sorting (Phase 1B.5.8)

Until this phase the API answered `{workspaces:[…]}` here, `{roles:[…]}` there, and a bare object for a single resource, with no pagination anywhere. Each shape was defensible alone; together they made a client guess per endpoint.

**The envelope.** One key at the top level, always:

| Response | Shape |
|---|---|
| Single resource | `{ "data": { … } }` |
| Collection | `{ "data": [ … ], "page": { … } }` |
| Error | `{ "error": { … } }` (§7, unchanged) |
| `204` | no body |

The symmetry between `data` and `error` is deliberate: a client branches on which key is present without knowing the endpoint. **The correlation id is not repeated in a success body** — it is on `x-correlation-id` for every response and is CORS-exposed, so there is one place for it to be right rather than two.

**Field naming is camelCase throughout**, request and response alike.

### 8a. Cursor pagination

```jsonc
"page": { "nextCursor": "eyJ…", "hasMore": true, "limit": 25 }
```

| Property | Rule |
|---|---|
| Parameters | `?limit=`, `?cursor=`, `?sort=` |
| Default page size | 25 |
| Maximum | 100 — a `limit` outside 1–100 is a `400` |
| `hasMore` | Derived by reading one row beyond the page. **There is no `COUNT(*)` and no total**: a count is a second scan of the same predicate on every page and no consumer needs one |
| `nextCursor` | Opaque, `null` on the last page. Passed back verbatim |
| Ordering | Always `(<sort field>, id)`. `id` is a UUIDv7, so the composite ordering is **total** and a row can neither be skipped nor repeated |
| Insert/delete mid-walk | Keyset resumes from a *value*, not an offset, so a row inserted or removed elsewhere cannot shift the window. A row inserted *behind* the cursor is not seen on this walk; one inserted ahead is |
| Invalid cursor | `400 PAGINATION_CURSOR_INVALID` — malformed, wrong signature, or minted under a different `sort`. One code for all three: which part of a forged cursor to fix is not information the API owes |

**Cursors are integrity-protected** (HMAC over the payload, keyed from the application signing secret and domain-separated). A cursor is a query continuation, and an editable one is a client-supplied predicate wearing the costume of server state. It is not the isolation boundary — the tenant predicate and RLS are — but treating a cursor as opaque only works if it actually is. A secret rotation invalidates outstanding cursors, which is correct: the client restarts from page one.

**Chronological sorts order by `id`, not by `created_at`.** This is a correctness requirement, not an optimisation: a cursor is text, and a `timestamptz` round-tripped through JavaScript loses the database's sub-millisecond precision, so the boundary lands *before* the row it was minted from and the same page repeats forever. `id` is a UUIDv7 — chronological by construction, and a string that round-trips exactly.

### 8b. Filters and sorts per endpoint

Filters and sort fields are **allow-listed per endpoint**. There is no generic filter language, no operator syntax, and no way to name a column: a client picks a key the endpoint publishes, and nothing else reaches SQL as an identifier.

`?sort=field` ascending, `?sort=-field` descending — one opaque token a client can round-trip without parsing.

| Endpoint | Filters | Sort fields | Default | Authorization |
|---|---|---|---|---|
| `GET /roles` | `isSystemRole`, `key` | `key`, `createdAt` | `key` | `roles.read` @ organization |
| `GET /permissions` | `domain` | `key`, `domain` | `key` | `permissions.read` @ organization |
| `GET /role-assignments` | `userId`, `scopeType`, `scopeId` | `createdAt`, `scopeType` | `-createdAt` | `role_assignments.read` @ organization |
| `GET /users` | `status`, `email` (exact, case-insensitive) | `createdAt`, `email`, `status` | `-createdAt` | `users.read` @ organization |
| `GET /api-keys` | `status`, `scopeType`, `scopeId`, `name` (exact) | `createdAt`, `name` | `-createdAt` | `api_keys.read` @ organization |
| `GET /audit-logs` | `action`, `actorType`, `actorUserId`, `outcome`, `resourceType`, `resourceId`, `scopeType`, `scopeId`, `correlationId`, `occurredFrom`, `occurredTo` | `occurredAt` | `-occurredAt` | `audit.read` @ organization |
| `GET /tenants/workspaces` | `status` (+ advisory `orgId`) | `name`, `createdAt` | `name` | `workspaces.read` @ organization |
| `GET /auth/sessions` | — | — | — | self only |

`GET /auth/sessions` is a deliberate exception: it is self-only and bounded by `AUTH_MAX_SESSIONS_PER_USER`, so it returns `{ data: [...] }` with no `page`. It is documented rather than quietly inconsistent.

**A filter narrows; it never widens.** Filters are applied inside what the tenant predicate and RLS already allow, so a caller naming another organization's key gets nothing rather than something.

### 8c. Where `Idempotency-Key` will fit

Nothing in these conventions conflicts with the idempotency mechanism §4 specifies; it is implemented (Phase 1B.5.9) as a **request header** on the creating endpoints listed in §4, replaying the original **status and body verbatim** — which is exactly `{ "data": … }` or `{ "error": … }` as defined above. The envelope is what gets stored and replayed; pagination is unaffected, being safe and unkeyed.

## 9. API contract strategy (OpenAPI)

> **Implementation status.** `@nestjs/swagger` is wired in `createApp()`, but **no controller or DTO carries swagger decorators**, so the generated document lists routes without schemas. When `OPENAPI_UI_ENABLED=true` the UI (`/api/v1/docs`) and document (`/api/v1/openapi.json`) are served **unauthenticated**; production refuses to start with it enabled. There are **no** contract tests in CI. Everything below is **IN PHASE 1C (1C.3, ADR-012)** — not yet implemented. OD-8 changes the UI rule: available in development, **authenticated** elsewhere (replacing today's production refusal).

- Every NestJS controller is annotated (`@nestjs/swagger` decorators) so the OpenAPI 3.1 document is generated from source, never hand-maintained separately.
- The generated spec is published per environment and is the input to generated client SDKs (Phase-dependent, tracked in `ROADMAP.md`); the UI is gated behind authentication outside development.
- Contract tests run in CI against the generated spec to catch undocumented or drifted fields before merge.

## 9a. Breaking changes introduced by Phase 1B.5.8

This is a pre-production system with no external consumer, so these ship without aliases. They are recorded because "internal" is not the same as "unnoticed" — the console work starts from this contract.

| Change | Before | After |
|---|---|---|
| Success envelope | `{roles:[…]}`, `{workspaces:[…]}`, bare object for a detail | `{data}` / `{data, page}` |
| `POST /auth/login`, `/auth/refresh` | `{accessToken, tokenType, expiresIn}` | `{data:{accessToken, tokenType, expiresIn}}` |
| `GET /auth/me`, `/auth/me/authorization`, `/auth/sessions` | payload at the top level | under `data` |
| List endpoints | unbounded | paginated, 25 by default |
| Validation issues | `{field, constraints:[string]}` | `{field, rule, message}`, one per failed rule |
| Unknown query parameter on `/tenants/workspaces` | silently ignored | `400 VALIDATION_FAILED`. The security property is unchanged and strictly stronger: the request carrying it no longer executes |

## 10. WebSockets

> **Implementation status.** Only step 1 (ticket issuance, §10b) is implemented. The gateway, steps 2–3 and every property in §10a are **DEFERRED** (`DECISIONS.md` D15).

Real-time channels (inbox live updates, campaign progress, provider health dashboard) are served over WebSocket at `/api/v1/ws`, subscribed to tenant-scoped topics (`org:{org_id}:conversations`, `org:{org_id}:campaigns:{id}`).

**Connection authentication does not use a long-lived JWT placed in the URL** (a query-string token leaks into proxy/access logs and browser history). Instead:

1. An authenticated **user session** first calls `POST /api/v1/ws/ticket` (API-key principals are refused, §10b) which mints a `ws_tickets` row (`DATABASE.md` §2): a single-use, short-lived (~30s) opaque ticket bound to the caller's already-resolved `TenantContext` and an explicit topic scope.
2. The client opens the WebSocket connection and presents the ticket as its very first frame (or via `Sec-WebSocket-Protocol`, never as a URL query parameter).
3. The server consumes the ticket exactly once (`consumed_at` set — replay of the same ticket is rejected), binds the connection's tenant context to what the ticket recorded (never to anything the client sends afterward), and only then admits subscriptions within the ticket's topic scope.

The server never pushes data the connection's bound tenant context isn't authorized to see, and a connection can never widen its own scope after establishment.

### 10b. `POST /ws/ticket` — the implemented contract (Phase 1B.7 prep)

Issuance only. Steps 2 and 3 above do not exist yet: there is no socket gateway and no consumption path, so a ticket minted today expires unused. It ships ahead of the gateway so that nothing later has to negotiate its credential model under deadline.

```jsonc
POST /api/v1/ws/ticket        // no request body of any kind
201 Created
{ "data": {
    "id": "uuid",
    "ticket": "<opaque base64url, 32 random bytes>",
    "expiresAt": "ISO-8601",
    "scope": ["org:<uuid>"],
    "orgId": "uuid",
    "workspaceId": "uuid|null" } }
```

| Property | How it is obtained |
|---|---|
| Bound to the caller | `user_id` and `session_id` come from the authenticated principal. Sessions are revoked by `UPDATE` and never deleted, so revocation does **not** remove the ticket — the (deferred) gateway must check the session at consumption |
| Bound to authoritative tenancy | `org_id`/`workspace_id` come from the resolved `TenantContext` (§5), never from the request |
| Scope is computed, never requested | The endpoint **accepts no body**, so there is no field through which a caller could name a topic, an organization or a workspace. A workspace-pinned context yields `org:{org}:workspace:{ws}` **and not** `org:{org}`. **Known gaps (to close before a gateway trusts the ticket):** no permission is checked when computing the topic, so any organization member receives `org:{org}`; there is no team topic, so a team-scoped user receives its workspace's topic |
| Hashed at rest | Only SHA-256 of the ticket is stored (`ws_tickets.ticket_hash`, unique). The plaintext appears in the 201 body and nowhere else — not in the audit row, not in logs |
| Short-lived | `expiresAt = issuedAt + auth.wsTicketTtlSeconds` (≤ 300s; ~30s by default), enforced further by the `ws_tickets_ttl_positive` check |
| Single-use | Guaranteed structurally by the unique hash and `consumed_at`; the consuming half is what is deferred |
| Audited | `ws_ticket.issued`, written inside the issuing transaction, recording the scope and the session id — never the ticket or its hash |

Errors: `400 TENANCY_CONTEXT_REQUIRED` when the principal has no organization context (send `X-Acc-Organization`); `403 AUTHZ_PERMISSION_DENIED` for an **API-key** principal, because `ws_tickets.user_id` is `NOT NULL` and a key has no user to bind to — a schema consequence, not a policy choice; `403 TENANCY_CONTEXT_MISMATCH` for an organization header the caller has no grant in.

No `Idempotency-Key`: the route is not in the §4 list, and a replayed snapshot of a one-time credential is precisely the hazard ADR-008 exists to prevent. Two calls simply mint two tickets, which is correct and cheap. Rate-limited as an ordinary authenticated `write` (§5a).

Authorization posture: `@AuthorizationExempt` — the subject of the route is the authenticated principal itself, so there is no target resource to check (`§6n` case 30 allow-lists `WsTicketController` alongside `AuthController` for exactly this reason).

### 10a. Scope enforcement on a WebSocket connection

The socket performs no scope resolution of its own — it inherits a decision already made over an authenticated HTTP call (`TENANCY.md` §4b). Four properties are **required of the deferred gateway** (none is implemented or testable yet):

| Property | Consequence |
|---|---|
| Topic scope is computed at **ticket-issue** time from the caller's scope set, and recorded on the `ws_tickets` row | A user who could not subscribe to a topic over HTTP cannot obtain a ticket that admits it |
| The connection binds to the **ticket's** recorded `org_id`/`workspace_id`/`scope` | The client cannot assert tenancy on the socket at all — there is no field for it |
| Subscriptions are admitted only within the ticket's recorded scope | A subscription to another organization's, workspace's or team's topic is refused, not silently ignored |
| The ticket is consumed exactly once, is short-lived (~30s), and is stored only as a hash | Replay of a consumed ticket, use of an expired ticket, and a database read yielding a usable ticket are all closed |

A connection is **not** re-resolved against the user's current grants mid-session: it keeps the scope the ticket recorded. Revoking a grant therefore takes effect on the next ticket, and revoking the underlying session invalidates its outstanding tickets.

## 11. Related

Event-level contract (async, cross-service): `EVENTS.md`. Auth/session detail: `RBAC.md`. Provider-facing inbound webhook detail: `PROVIDER_ADAPTER.md`.
