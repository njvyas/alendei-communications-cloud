# RBAC / ABAC & Authentication Architecture

## 1. Model

ACC combines role-based access control (coarse: "what can this kind of user generally do") with attribute-based access control (fine: "can this specific user act on this specific resource").

```
users ──< user_roles >── roles ──< role_permissions >── permissions
```

- `roles`: named bundles (e.g. `org_admin`, `workspace_manager`, `campaign_editor`, `read_only`, `reseller_admin`, `alendei_super_admin`). Roles are tenant-scoped except a small fixed set of platform-level roles.
- `permissions`: fine-grained action grants, named `{domain}.{action}` (e.g. `campaigns.create`, `billing.view_ledger`, `providers.manage`).
- `role_permissions`: many-to-many join, defines what a role can do.
- `user_roles`: assigns a role to a user **at a scope** — `scope_type` + `scope_id`, where `scope_type` takes one of the five values of the canonical hierarchy defined normatively in `TENANCY.md` §1a:

  ```
  platform | reseller | organization | workspace | team
  ```

  A user can hold different roles at different scopes. Grants inherit **downward only** (`TENANCY.md` §1a.4): an `organization`-scoped grant already covers every workspace and team beneath it and needs no additional workspace-level grant, while a `workspace`-scoped grant confers nothing at organization level and nothing in a sibling workspace.

## 2. Authorization decision

A request is authorized when:

1. RBAC check passes: the resolved tenant context (`TENANCY.md` §2a) plus the user's `user_roles` yields at least one role whose `role_permissions` include the permission required by the endpoint, **at a scope that covers the target resource's scope**. Coverage is the downward-only inheritance of `TENANCY.md` §1a.4: `platform` covers everything, `reseller` covers its organizations and below, `organization` covers its workspaces and teams, `workspace` covers its teams, `team` covers itself. Holding the permission somewhere is never sufficient — it must be held at a covering scope.
2. ABAC check passes: policy conditions evaluated against resource attributes and request context — e.g. `resource.workspace_id ∈ user.assigned_workspace_ids`, `resource.owner_id == user.id OR user.has(permission, scope=resource.workspace_id)`, business-hour or IP-range conditions for sensitive actions.

Both checks run server-side, after tenant context resolution, never based on client-asserted role/permission claims — and, per ADR-003 D-3, the signed token carries no role, permission or tenancy claim to assert in the first place.

**Where each check runs, and why it is split (ADR-003 D-5).** The endpoint-level *permission* check can be declarative, on a guard. The *target-scope coverage* check frequently cannot: a target's scope is often knowable only after the resource is loaded. A guard alone is therefore **not** sufficient authorization, and treating it as sufficient is the specific failure mode that turns workspace and team isolation into accidental filtering. Every scoped service operation performs an explicit target-scope check through the centralized `PermissionEvaluator`, using **one reusable mechanism** rather than ad-hoc checks repeated per call site. This is a mandatory application invariant, not a code-review convention — and below organization level it is the *only* enforcement that exists, because RLS carries no workspace or team term (`TENANCY.md` §3a).

`scopeCovers` and `PermissionEvaluator` both shipped in **Phase 1B.3**, not 1B.5 as `ROADMAP.md` originally scheduled them: the 1B.3 read surface had to authorize its own query, and the only alternative was the ad-hoc check this paragraph forbids (ADR-004 D-1). Phase 1B.5 builds role administration on them unchanged and closes the one over-approximation ADR-003 left in them — a principal holding a permission through any grant is currently treated as holding it through each, pending per-grant permission sets.

**This is a different question from the advisory-identifier cross-check** (`TENANCY.md` §2b, ADR-004 D-3), and the two are deliberately not merged. That one asks whether an identifier the *caller supplied* contradicts the context the server derived, and answers it before the handler runs, without touching the database. This one asks whether the principal may act on a *loaded* target, and needs that target's ancestry to answer. Collapsing them would mean either resolving tenancy from client input or authorizing without the resource in hand.

Policy evaluation is designed as pluggable (conceptually OPA/Rego-compatible rule shape) so ABAC rules can be authored/updated without a code deploy in a later phase — the interface is fixed in Phase 0/1; the policy authoring UI is a later-phase deliverable (see `ROADMAP.md`).

## 3. Platform-level roles (fixed, not tenant-configurable)

These roles have `roles.org_id IS NULL`, which is what marks a role as platform-level (`DATABASE.md` §2). They are seeded, not editable by tenants, and may only be granted by an existing platform admin (§7).

| Role | Assignable at `scope_type` | Purpose |
|---|---|---|
| `alendei_super_admin` | `platform` | Full control-plane access: providers, routing, all tenants, billing |
| `alendei_support` | `platform` | Cross-tenant read plus limited write (audit view, impersonation-with-audit for support) |
| `reseller_admin` | `reseller` | Manage the organizations beneath one reseller, and that reseller's billing/markup |

**What platform-level access means**: a `platform` grant sets `app.is_platform_admin` and therefore satisfies `app_org_in_scope()` for every organization (`TENANCY.md` §3a). It is the only grant that does so. It is not a bypass of authorization — a platform role still only carries the permissions its `role_permissions` actually list, so `alendei_support` sees every tenant but can still only do what its read-oriented permission set allows.

**What reseller-level access means**: a `reseller` grant sets `app.current_reseller_id` and reaches exactly the organizations whose `reseller_id` matches — and, through them, their workspaces and teams. It reaches no other reseller's organizations, and it is not platform access: a reseller admin cannot see the control plane, cannot grant platform roles, and cannot reach an organization that has been moved to another reseller.

## 4. Tenant-configurable roles (seeded defaults, editable)

These roles have `roles.org_id` set to the owning organization and are seeded per organization when it is provisioned.

| Role | Assignable at `scope_type` | Default permissions focus |
|---|---|---|
| `org_admin` | `organization` | Full control within the organization: users, workspaces, teams, roles, API keys, audit |
| `workspace_manager` | `organization`, `workspace` | Manage a workspace's teams and members; contacts/templates/campaigns/journeys as those phases land |
| `campaign_editor` | `organization`, `workspace`, `team` | Create/edit campaigns and journeys; never billing or user management |
| `agent` | `organization`, `workspace`, `team` | Unified inbox access; cannot send campaigns |
| `read_only` | `organization`, `workspace`, `team` | Reporting/audit view only |

Organizations may define additional custom roles by composing existing `permissions`, subject to §7's constraints.

### 4a. Which roles may be assigned at which scopes

The complete assignability matrix. A blank cell is not merely unusual — it is refused, by `fn_validate_user_role_scope` as well as by the service layer (§6).

| Role | `platform` | `reseller` | `organization` | `workspace` | `team` |
|---|:---:|:---:|:---:|:---:|:---:|
| `alendei_super_admin` | ✓ | | | | |
| `alendei_support` | ✓ | | | | |
| `reseller_admin` | | ✓ | | | |
| `org_admin` | | | ✓ | | |
| `workspace_manager` | | | ✓ | ✓ | |
| `campaign_editor` | | | ✓ | ✓ | ✓ |
| `agent` | | | ✓ | ✓ | ✓ |
| `read_only` | | | ✓ | ✓ | ✓ |
| custom tenant role | | | ✓ | ✓ | ✓ |

Two structural rules generate this table, and the database enforces both independently of any list:

1. **A platform-level role (`roles.org_id IS NULL`) may only be granted at `platform` or `reseller` scope**, never at a tenant scope. Granting `alendei_super_admin` at `organization` scope is refused.
2. **A tenant role (`roles.org_id IS NOT NULL`) may only be granted at `organization`, `workspace` or `team` scope, and only where the target scope's ownership chain resolves to that same organization.** Granting Organization A's `org_admin` at a scope owned by Organization B is refused (§6).

### 4b. Who may administer which scopes

Administering a scope means creating, updating or deleting the resources at that scope, and granting roles within it. It requires the relevant permission held at a scope that **covers** the target (`TENANCY.md` §1a.4), and is additionally bounded by §7.

| Actor holds | May administer | May **not** administer |
|---|---|---|
| `platform` grant | every reseller, organization, workspace and team; platform and reseller role grants | — (bounded only by the permissions the role actually carries) |
| `reseller` grant | organizations under that reseller, and their workspaces, teams and tenant role grants | any other reseller; its own reseller's *existence*; platform roles; the control plane |
| `organization` grant | that organization's workspaces, teams, tenant roles and role grants | the organization's own reseller; sibling organizations; platform or reseller role grants |
| `workspace` grant | that workspace's teams and grants within it | sibling workspaces; the parent organization; anything above |
| `team` grant | that team's grants only | sibling teams; the parent workspace; anything above |

The recurring pattern: **an actor may administer downward, never its own level's parent and never sideways.** A reseller admin creating an organization is administering downward. An organization admin changing which reseller owns their organization would be administering upward, and is refused.

## 5. Authentication architecture

| Mechanism | Use case | Notes |
|---|---|---|
| Session (JWT access + refresh) | Web console users | Short-lived access token (15 min default), refresh token bound to a `sessions` row for server-side revocation. **Built in Phase 1B.** |
| API keys | Server-to-server integration | Stored as Argon2id hash + visible prefix (`ak_live_xxxx...`), permanently bound to one `org_id` and an explicit permission subset, revocable. **Built in Phase 1B** (rotation lineage deferred, `DECISIONS.md` D14). |
| OAuth2 (authorization code + client credentials) | Third-party/partner integrations, future SSO token exchange | Architecture reserved for Phase 6+; not built in Phase 0/1. There is deliberately no `oauth_clients` table — only the `oauth_client` actor type reserves the space (`DATABASE.md` §12). |
| SSO (SAML / OIDC) | Enterprise organization login | Architecture reserved; implementation phase TBD — `DECISIONS.md` D6. The per-organization IdP configuration column is **not** present on `organizations` and is deferred with it. |
| MFA | Human users | **Not implemented, and not in Phase 1B** (ADR-003 D-6, `DECISIONS.md` D10). TOTP is the intended mechanism and `users.mfa_enabled`/`users.mfa_secret_ref` reserve space for it, but no library, configuration, table, enrolment flow, challenge flow or login branching exists. Phase 1B's login path has no MFA step. Do not read this row as a shipped control. |

### 5a. Access and refresh tokens (Phase 1B, ADR-003)

The **access token** is a short-lived JWT carrying identity and session claims only — `sub`, `sid`, `actor_type`, `jti`, `iss`, `aud`, `iat`, `exp`. It carries **no** `org_id`, `reseller_id`, `workspace_id`, `team_id`, roles or permissions (ADR-003 D-3). Tenant context and authorization are re-derived server-side from the verified credential on every request, which is precisely why a forged tenancy claim cannot influence a decision: no code path reads one.

The **refresh token** is an opaque random value stored only as a hash in `sessions.refresh_token_hash`. For the browser console it is carried in an `httpOnly; Secure; SameSite=Lax` cookie scoped to the refresh path — never readable by JavaScript, never in `localStorage`, never in a URL (ADR-003 D-7; transport, CORS and CSRF consequences in `API.md` §3b). Non-browser clients authenticate with API keys and never use the refresh-cookie flow.

Session/device management: `sessions` records device/IP/user-agent metadata and supports explicit revocation (single session or "all sessions for user"); revoking a session invalidates its refresh token immediately — `revoked_at` and `expires_at` are checked on **every** refresh, not merely at token expiry.

**Rotation and reuse detection** (Phase 1B.2). Every refresh rotates the token and records lineage on `sessions` (`DATABASE.md` §2): the spent session is marked `rotated_at` and points at its successor, which inherits the chain's `family_id`. Presenting an already-rotated token is treated as theft rather than as a retryable error — the entire family is revoked and `reuse_detected_at` is set. Concurrency is settled by the database, through a conditional `UPDATE ... WHERE rotated_at IS NULL` plus a unique constraint on the successor, so two simultaneous refreshes of one token cannot both succeed.

A **rotated** session is spent even though it is neither revoked nor expired; presentability is all three conditions, not just the two.

### 5a.1 User lifecycle and credential state (Phase 1B.2)

`users.status` is load-bearing, not descriptive, because `users_active_requires_credential` enforces at the database that an `active` user holds a password or an MFA secret:

```
invited  ──activate(password)──▶  active  ──disable()──▶  disabled
```

An `invited` user has no credential and cannot authenticate. A `disabled` user retains their digest — which is precisely why status is checked independently of password verification, and why a correct password for a disabled account is still a failed login.

**How an invited user comes to set their password is not yet decided.** It requires either an invitation token delivered out of band or an administrator setting it directly, and neither is documented. Phase 1B.2 deliberately implements neither: `activate(userId, password)` takes the password directly, which is what the bootstrap CLI needs, and the delivery mechanism is recorded as a decision required before the `/users` invitation endpoint ships in Phase 1B.6 (`DECISIONS.md`). No invitation-token table is invented and no mail transport is assumed.

### 5b. Bootstrapping the first platform admin (ADR-003 D-1)

`fn_validate_user_role_scope` refuses a platform-level role grant unless the actor already holds platform admin (§7). Combined with a database that seeds no users, this makes the first platform grant impossible through any ordinary path — which is the intended property, not a gap, and it means the bootstrap must be explicit rather than incidental.

The first platform admin is created by an **owner-run, idempotent CLI**, following the precedent `seed.ts` already sets when it declares `app.is_platform_admin` in order to seed platform role rows. Its properties, each testable:

- It is **never** reachable through the API. There is no unauthenticated HTTP privilege-grant route, and no "first-run setup" endpoint.
- It creates the first platform-admin user and grants `alendei_super_admin` at `platform` scope.
- It is safe to rerun: a second run against an already-bootstrapped database changes nothing.
- Executing it against a production environment requires explicit confirmation.
- It never installs a fixed or default production password.
- It writes its own audit records, so the existence of the first administrator is itself accounted for.
- It **does not weaken `fn_validate_user_role_scope`**. The trigger is unchanged; the elevation is a transaction-local session variable set by the schema owner, and no application principal can set it.

### 5c. API-key effective permissions

An API key never carries more authority than the person who created it, and never more than the operation allows:

```
effective_permissions =
      requested_key_scopes
    ∩ permissions_held_by_the_creator_at_the_key's_organization
    ∩ permissions_valid_for_the_target_operation
```

The intersection is **recomputed on every request**, not snapshotted at creation: a key whose creator has since lost a permission loses it on the next request, and a key whose creator no longer exists resolves to no permissions at all. A key must not outlive the authority that produced it.

**How a key is authorized.** The principal carries exactly one synthesized grant — `roleKey: 'api_key'`, scoped to the key's own binding (its workspace when it has one, otherwise its organization) — so an API key passes through the same `PermissionEvaluator` and the same `scopeCovers` rule as a user, with no special branch anywhere. The grant is never `platform`, so a key can never reach the control plane, and downward-only inheritance then means a workspace-bound key cannot perform an organization-wide operation. Authentication and authorization are both operational in Phase 1B.3; *administration* of keys (creation, rotation, revocation endpoints) is Phase 1B.6.

A key is permanently bound to its organization (`api_keys.org_id`), and that binding is never widened by anything on the request. A client-supplied `workspace_id` or `team_id` may **narrow** what the key acts on; it can never create authority the key does not already hold. This is the same authoritative-versus-advisory rule as for user sessions (`TENANCY.md` §2b), applied to a credential whose tenancy is fixed at creation rather than resolved per request.

## 6. Scope integrity — `user_roles.scope_id` cannot point cross-tenant

`user_roles.scope_type`/`scope_id` is a polymorphic reference (organization, workspace, or team), which means it cannot be a single physical foreign key. Two independent guards apply, neither sufficient alone:

1. **Database constraint (defense-in-depth, always on)**: a `BEFORE INSERT/UPDATE` trigger on `user_roles` (`fn_validate_user_role_scope`, `DATABASE.md` §2) resolves the target row named by `(scope_type, scope_id)`, verifies its ownership chain, and **derives `user_roles.org_id` from that chain rather than trusting the value the writer supplied** — so a forged `org_id` on the insert is overwritten, not merely rejected. Per scope type:

   | `scope_type` | Resolution | Requirement |
   |---|---|---|
   | `platform` | no target row; `scope_id` must be `NULL` | role must be platform-level; actor must be a platform admin |
   | `reseller` | `resellers.id = scope_id` must exist | role must be platform-level; actor must be a platform admin |
   | `organization` | `organizations.id = scope_id` | resolved org must equal `roles.org_id` |
   | `workspace` | `workspaces.id = scope_id → workspaces.org_id` | resolved org must equal `roles.org_id` |
   | `team` | `teams.id = scope_id → teams.org_id` | resolved org must equal `roles.org_id` |

   A role with `org_id IS NULL` (platform-level, §3) is exempt from the org-match check, because it belongs to no organization — but it is *not* exempt from scrutiny: it is restricted to `platform`/`reseller` scope and to platform-admin actors, both enforced in the trigger itself (§7). The invalid state this specifically prevents:

   ```
   Role belongs to Organization A
   scope_id points to a Workspace belonging to Organization B   ← trigger raises, transaction aborts
   ```

2. **Application-level validation (first line of defense, better error messages)**: the role-assignment service re-derives the same ownership chain from the *actor's own* resolved tenant context before ever attempting the write, rejecting with a clear `403`/`422` — so a well-formed but invalid request never even reaches the trigger in the common case. The trigger exists specifically so that this guarantee holds even if a future code path (a migration script, an internal admin tool, a bug in a different service) bypasses the application-level service layer — the database itself refuses the invalid row regardless of which code wrote it.

Frontend validation is UX-only and never trusted as an authorization boundary for this or any other RBAC rule.

## 7. Privilege escalation guards

Each guard names the layer that enforces it, because a guard that exists only in the service layer is a different quality of assurance from one the database refuses.

| Guard | Enforced by |
|---|---|
| **No granting a permission you do not hold.** Role/permission assignment requires the actor to already hold every permission being granted. | Service layer |
| **No granting at a scope you do not cover.** The grant's `(scope_type, scope_id)` must fall within the actor's own scope set, per the downward-only inheritance of `TENANCY.md` §1a.4. | Service layer |
| **No cross-tenant role assignment.** A role from Organization A can never be granted at a scope owned by Organization B. | Service layer **and** `fn_validate_user_role_scope` (§6) |
| **No self-granted platform access.** Platform-level roles are assignable only by an existing platform admin. | Service layer **and** `fn_validate_user_role_scope` |
| **No platform role at a tenant scope.** `alendei_super_admin` cannot be granted at `organization` scope to "scope it down" — the combination is refused outright. | Service layer **and** `fn_validate_user_role_scope` |
| **No smuggling platform power into a tenant role.** A `platform.*` permission cannot be attached to a role with `roles.org_id IS NOT NULL`, closing escalation by custom role composition. | `fn_validate_role_permission` (`DATABASE.md` §2) |
| **No forged `org_id` on a grant.** `user_roles.org_id` is derived by the trigger from the resolved scope chain, never taken from the writer. | `fn_validate_user_role_scope` |
| **No upward administration.** An actor cannot modify its own scope's parent — an organization admin cannot reassign their organization's reseller. | Service layer + RLS (`TENANCY.md` §3a) |

Every role grant and revocation is audit-logged without exception, including the attempts that were refused (`SECURITY.md` §4) — a rejected escalation attempt is precisely the event worth having a record of. `audit_logs.outcome` carries `denied` for exactly this purpose, and the audit row records the scope the attempt was made at on the same five-level enum `user_roles.scope_type` uses (`DATABASE.md` §12, ADR-002), so a refused escalation and the grant it targeted are directly comparable.

The identity database role (`acc_auth`) cannot write a role-grant audit row at all: it is confined to platform scope and to the pre-tenant authentication vocabulary (`DATABASE.md` §2a), so an audit record claiming a privileged action can only have come from the application role acting inside a resolved tenant context.

Frontend validation is UX-only and is never an authorization boundary for any of the above.

## 8. Related

Full table definitions: `DATABASE.md` §"IAM & RBAC domain". Security controls (encryption, session hardening, audit): `SECURITY.md`.
