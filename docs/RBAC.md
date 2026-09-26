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

1. RBAC check passes: **one single grant** supplies both halves of the answer (ADR-005 D-1):

   ```
   ALLOW(P, target)  ⟺  ∃ g ∈ grants(principal) :
           P ∈ permissions(g.role)
       ∧   scopeCovers(g.scope, target.scope, target.chain)
       ∧   g is active
   ```

   Existential over grants, conjunctive within a grant. Coverage is the downward-only inheritance of `TENANCY.md` §1a.4: `platform` covers everything, `reseller` covers its organizations and below, `organization` covers its workspaces and teams, `workspace` covers its teams, `team` covers itself.

   Implemented in Phase 1B.5.1: `RoleGrant` carries its own role's permissions and `PermissionEvaluator` reads both halves off one grant, which makes the cross-product unrepresentable rather than merely avoided.

   **Holding the permission through *any* grant is not sufficient**, and this is the part that is easy to get wrong. A principal's permissions are not a set it possesses — they are a set of `(permission, scope)` pairs, each one conferred by a particular grant and reaching no further than that grant does. Testing a flattened union of permissions against a union of covered scopes authorizes the cross-product of the two, which includes combinations no grant confers: a `workspace_manager` at one workspace, who also holds `read_only` across the organization, would be authorized for `role_assignments.grant` at organization scope. Neither grant permits that. Both halves must be read off the same grant.
2. ABAC check passes: policy conditions evaluated against resource attributes and request context — e.g. `resource.workspace_id ∈ user.assigned_workspace_ids`, `resource.owner_id == user.id OR user.has(permission, scope=resource.workspace_id)`, business-hour or IP-range conditions for sensitive actions.

Both checks run server-side, after tenant context resolution, never based on client-asserted role/permission claims — and, per ADR-003 D-3, the signed token carries no role, permission or tenancy claim to assert in the first place.

**One entry point (Phase 1B.5.2).** Every scoped operation asks its question through `AuthorizationService`, which resolves the target's ancestry from the database, refuses an unresolvable target as `404`, and then delegates the decision to `PermissionEvaluator` unchanged. The three responsibilities stay separate because merging any two loses a property: `ScopeChainResolver` answers *what is above this resource*, `PermissionEvaluator` answers *does one grant cover it*, and the service answers *may this request proceed*. A handler that assembled a chain of its own would be indistinguishable in review from one that did not — so there is no longer a chain for a handler to assemble, and a test asserts that no controller reaches for the evaluator directly.

**Where each check runs, and why it is split (ADR-003 D-5).** The endpoint-level *permission* check can be declarative, on a guard. The *target-scope coverage* check frequently cannot: a target's scope is often knowable only after the resource is loaded. A guard alone is therefore **not** sufficient authorization, and treating it as sufficient is the specific failure mode that turns workspace and team isolation into accidental filtering. Every scoped service operation performs an explicit target-scope check through the centralized `PermissionEvaluator`, using **one reusable mechanism** rather than ad-hoc checks repeated per call site. This is a mandatory application invariant, not a code-review convention — and below organization level it is the *only* enforcement that exists, because RLS carries no workspace or team term (`TENANCY.md` §3a).

`scopeCovers` and `PermissionEvaluator` both shipped in **Phase 1B.3**, not 1B.5 as `ROADMAP.md` originally scheduled them: the 1B.3 read surface had to authorize its own query, and the only alternative was the ad-hoc check this paragraph forbids (ADR-004 D-1). Phase 1B.5 built role administration on them and closed the one over-approximation ADR-003 left in them — permission and scope are now read off a single coherent grant (ADR-005 D-1, Phase 1B.5.1).

**This is a different question from the advisory-identifier cross-check** (`TENANCY.md` §2b, ADR-004 D-3), and the two are deliberately not merged. That one asks whether an identifier the *caller supplied* contradicts the context the server derived, and answers it before the handler runs, without touching the database. This one asks whether the principal may act on a *loaded* target, and needs that target's ancestry to answer. Collapsing them would mean either resolving tenancy from client input or authorizing without the resource in hand.

Policy evaluation is designed as pluggable (conceptually OPA/Rego-compatible rule shape) so ABAC rules can be authored/updated without a code deploy in a later phase — the interface is fixed in Phase 0/1; the policy authoring UI is a later-phase deliverable (see `ROADMAP.md`).

## 2a. Declaring a route's permission (Phase 1B.5.7)

Every route states its authorization posture on itself, and §6n case 30 asserts that against the container's own route table rather than by review.

| Decorator | Meaning |
|---|---|
| `@Public()` | No authentication. Login, refresh, health, metrics — and additionally allow-listed by path in the coverage suite, so marking a new route public is not by itself enough to pass unnoticed |
| `@RequiresPermission(p)` | A target-scope check is required, and `p` is named on the route |
| `@AuthorizationExempt(reason)` | Authenticated, but about the caller rather than a tenant resource, with the reason recorded on the route |

A route in none of them fails the suite. That is the whole of case 30: a new endpoint cannot ship unprotected by omission.

**The decorator declares; it does not enforce.** This is forced by ADR-005 D-5 and is worth stating plainly, because the opposite is the obvious design. The chain a coverage decision rests on must be read inside the request's **own tenant transaction** — the same `SET LOCAL` transaction the business query runs in — so RLS filters it and an out-of-tenant target is invisible rather than merely unauthorized. A Nest guard runs before the handler and therefore before that transaction exists. A guard that authorized would have to open one of its own, putting the decision and the mutation in two different transactions and leaving a window between them in which a grant can be revoked. That time-of-check/time-of-use gap is why 1B.5.2 deferred this decorator rather than shipping a guard that looked right.

Enforcement therefore stays in `AuthorizationService.assert`, inside the handler's transaction, before any mutation. The decorator supplies two things that were genuinely missing: the declaration case 30 asserts against, and a runtime cross-check.

**The runtime cross-check.** `AuthorizationCoverageInterceptor` compares the declared permission against the checks `AuthorizationService` recorded during the request, and fails the response closed on a mismatch. What it buys differs by method, and the difference matters:

- For a **read**, the response is suppressed before it reaches the caller, so no unauthorized data is disclosed.
- For a **mutation**, the write has already committed when the interceptor runs. The response still fails closed and the operator gets a loud error, but the guarantee that a mutation was authorized comes from the service's check running before it — not from here. The structural guarantee is case 30, which fails the build rather than the request.

It never authorizes anything: it compares what was declared with what was done, and a mismatch is a programming error reported as one. A refusal still counts as a check having happened, so a legitimate `403` is not converted into a `500`.

**Execution order**, end to end:

```
CorrelationMiddleware      correlation id, request context
  → CsrfGuard              non-simple header on cookie-credentialed routes
  → AuthGuard              credential → AuthPrincipal → RequestContext
                           → ScopeResolver → tenant context (X-Acc-Organization)
  → AdvisoryTenantGuard    advisory identifiers cross-checked, or refused
  → handler                opens the tenant transaction (SET LOCAL)
      → AuthorizationService.assert   chain read + coherent-grant decision,
                                      recorded for coverage; denial audited
      → the business query or mutation, in that same transaction
  → AuthorizationCoverageInterceptor  declared vs. performed; fail closed
```

Authorization happens inside the handler's transaction and **before** the mutation it guards; nothing in this phase moved a check after one.

**Deferred targets.** Six routes cannot name their target statically, and each says so on the route with a reason — granting a role (the scope named in the body), revoking one (the scope on the stored row), and the API-key detail, create and revoke routes and the audit-log detail route (each authorized at the scope read from the body or the stored row). Neither is knowable from route metadata, and guessing either would be the forged-target defect ADR-005 D-5 exists to prevent. Every other scoped route targets the request's resolved organization.

## 3. Platform-level roles (fixed, not tenant-configurable)

These roles have `roles.org_id IS NULL`, which is what marks a role as platform-level (`DATABASE.md` §2). They are seeded, not editable by tenants, and may only be granted by an existing platform admin (§7).

| Role | Assignable at `scope_type` | Purpose |
|---|---|---|
| `alendei_super_admin` | `platform` | Full control-plane access: providers, routing, all tenants, billing |
| `alendei_support` | `platform` | Cross-tenant read plus limited write (audit view, impersonation-with-audit for support) |
| `reseller_admin` | `reseller` | Manage the organizations beneath one reseller, and that reseller's billing/markup |

**What platform-level access means** (ADR-011 D-2): only an `alendei_super_admin` grant at platform scope sets `app.is_platform_admin`, and so satisfies `app_org_in_scope()` for every organization (`TENANCY.md` §3a); the database re-checks that grant before honouring the flag. `alendei_support`, though platform-scoped, does **not** set it: support may *select* any organization (`X-Acc-Organization`), and inside that organization RLS scopes it exactly like a member, while its read-only permission set bounds what it can do. Before migration `0010` any platform-scope grant set the flag, which gave the read-only support role unrestricted database read and write reach.

**What reseller-level access means**: a `reseller` grant — and only a `reseller` grant — sets `app.current_reseller_id` (ADR-011 D-1; the database validates the claim against the grant) and reaches exactly the organizations whose `reseller_id` matches — and, through them, their workspaces and teams. An organization, workspace or team grant never sets it, whatever reseller the organization belongs to. It reaches no other reseller's organizations, and it is not platform access: a reseller admin cannot see the control plane, cannot grant platform roles, and cannot reach an organization that has been moved to another reseller.

## 4. Tenant-configurable roles (seeded defaults, editable)

These roles have `roles.org_id` set to the owning organization and are seeded per organization when it is provisioned.

**Seeding mechanism (Phase 1B.5.4).** `TenantRoleProvisioner.seedTenantRoles(tx, orgId)` is the sanctioned way an organization receives them, and `TENANT_ROLE_DEFINITIONS` is its only source. Three properties define it:

- **Transaction-bound.** Everything runs inside the caller's transaction; it opens none of its own. A caller that fails part-way through — for any reason, including after the provisioner returned — rolls the whole seeding back with it, so a half-provisioned tenant cannot exist.
- **Idempotent, and deliberately non-reconciling.** A repeat run creates nothing. It does *not* rewrite an existing role back to the definition: these roles are tenant-editable by design, and overwriting a deliberate edit would be data loss disguised as idempotency.
- **`role.created` only for a role actually created.** A retry writes no audit rows at all. A trail that gained a creation record per retry would report creations that never happened, which is worse than a missing one because it cannot be told apart from a real one.

It does **not** create organizations and has no HTTP surface: provisioning is a lifecycle step, not an endpoint. Wiring it into organization creation is Phase 1B.8's, which is the phase that introduces organization creation at all.

The `Assignable at scope_type` column below is `roles.allowed_scope_types` from Phase 1B.5.4 (migration `0004`); §7 records that its **grant-time enforcement** is Phase 1B.5.5's.

| Role | Assignable at `scope_type` | Default permissions focus |
|---|---|---|
| `org_admin` | `organization` | Full control within the organization: users, workspaces, teams, roles, API keys, audit |
| `workspace_manager` | `organization`, `workspace` | Manage a workspace's teams and members; contacts/templates/campaigns/journeys as those phases land |
| `campaign_editor` | `organization`, `workspace`, `team` | Create/edit campaigns and journeys; never billing or user management |
| `agent` | `organization`, `workspace`, `team` | Unified inbox access; cannot send campaigns |
| `read_only` | `organization`, `workspace`, `team` | Reporting/audit view only |

Organizations may define additional custom roles by composing existing `permissions`, subject to §7's constraints.

### 4a. Which roles may be assigned at which scopes

The complete assignability matrix. A blank cell is refused. **Which layer refuses it differs:** the platform/tenant split (rules 1–2 below) is enforced by `fn_validate_user_role_scope` as well as by the service; the per-role column (`roles.allowed_scope_types`, e.g. `org_admin` only at `organization`) is enforced by `RoleAssignmentService` only (§6n case 28). Database enforcement of `allowed_scope_types` is **DEFERRED** — the column exists and is constrained to its level (migration `0004`), but the trigger does not consult it at grant time.

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

Two structural rules generate the level split of this table, and the database enforces both independently of the service:

1. **A platform-level role (`roles.org_id IS NULL`) may only be granted at `platform` or `reseller` scope**, never at a tenant scope. Granting `alendei_super_admin` at `organization` scope is refused.
2. **A tenant role (`roles.org_id IS NOT NULL`) may only be granted at `organization`, `workspace` or `team` scope, and only where the target scope's ownership chain resolves to that same organization.** Granting Organization A's `org_admin` at a scope owned by Organization B is refused (§6).

### 4b. Who may administer which scopes

Administering a scope means creating, updating or deleting the resources at that scope, and granting roles within it. It requires the relevant permission held at a scope that **covers** the target (`TENANCY.md` §1a.4), and is additionally bounded by §7.

| Actor holds | May administer | May **not** administer |
|---|---|---|
| `platform` grant | every reseller, organization, workspace and team (bounded by the permissions the role carries). Platform and reseller role grants are administered by the owner-run bootstrap/seed path only — **no API grants a platform-level role** (`RoleAssignmentService` refuses them) | — |
| `reseller` grant | organizations under that reseller, and their workspaces, teams and tenant role grants | any other reseller; its own reseller's *existence*; platform roles; the control plane |
| `organization` grant | that organization's workspaces, teams, tenant roles and role grants | the organization's own reseller; sibling organizations; platform or reseller role grants |
| `workspace` grant | that workspace's teams and grants within it | sibling workspaces; the parent organization; anything above |
| `team` grant | that team's grants only | sibling teams; the parent workspace; anything above |

The recurring pattern: **an actor may administer downward, never its own level's parent and never sideways.** A reseller admin creating an organization is administering downward. An organization admin changing which reseller owns their organization would be administering upward, and is refused.

**The first two guards are `(permission, scope)` pairs, not permission sets**, and the distinction is the whole of §2 restated as an escalation rule. A guard written as "does the actor hold every permission in this role?" against `AuthPrincipal.permissions` reproduces the cross-product defect exactly: an actor holding a permission only at a workspace would pass the check for a grant at organization scope, and the guard meant to prevent escalation would itself become the escalation path. The actor's **effective grant authority** — the set of pairs it may confer — is `{(P, s) : ∃ coherent grant g, P ∈ permissions(g) ∧ scopeCovers(g.scope, s)}`, computed per grant and never from the flattened union.

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

The **refresh token** is an opaque random value stored only as a hash in `sessions.refresh_token_hash`. For the browser console it is carried in an `httpOnly; Secure; SameSite=Lax` cookie with `Path=/api/v1/auth` (so it is sent to the `/auth/*` routes, not to the rest of the API; `Secure` is omitted only in development and test) — never readable by JavaScript, never in `localStorage`, never in a URL (ADR-003 D-7; transport, CORS and CSRF consequences in `API.md` §3b). Non-browser clients authenticate with API keys and never use the refresh-cookie flow.

Session/device management: `sessions` records device/IP/user-agent metadata and supports explicit revocation of a single session (`DELETE /auth/sessions/:id`, `POST /auth/logout`); revoking all of a user's sessions happens when the user is disabled, and a self-service "sign out everywhere" endpoint is DEFERRED; revoking a session invalidates its refresh token immediately — `revoked_at` and `expires_at` are checked on **every** refresh, not merely at token expiry.

**Rotation and reuse detection** (Phase 1B.2). Every refresh rotates the token and records lineage on `sessions` (`DATABASE.md` §2): the spent session is marked `rotated_at` and points at its successor, which inherits the chain's `family_id`. Presenting an already-rotated token is treated as theft rather than as a retryable error — the entire family is revoked and `reuse_detected_at` is set. Concurrency is settled by the database, through a conditional `UPDATE ... WHERE rotated_at IS NULL` plus a unique constraint on the successor, so two simultaneous refreshes of one token cannot both succeed.

A **rotated** session is spent even though it is neither revoked nor expired; presentability is all three conditions, not just the two.

### 5a.1 User lifecycle and credential state (Phase 1B.2)

`users.status` is load-bearing, not descriptive, because `users_active_requires_credential` enforces at the database that an `active` user holds a password or an MFA secret:

```
invited  ──activate(password)──▶  active  ──disable()──▶  disabled
```

An `invited` user has no credential and cannot authenticate. A `disabled` user retains their digest — which is precisely why status is checked independently of password verification, and why a correct password for a disabled account is still a failed login.

**How an invited user comes to set their password is still not decided.** It requires either an invitation token delivered out of band or an administrator setting it directly, and neither is documented. Phase 1B.2 implemented neither: `activate(userId, password)` takes the password directly, which is what the bootstrap CLI needs, and the delivery mechanism is `DECISIONS.md` D16. No invitation-token table is invented and no mail transport is assumed.

**Phase 1B.6.1 ships the lifecycle API without resolving D16**, which is what lets the two be separated at all. `POST /users` creates an `invited` identity and stops there: it accepts no password, returns no password, mints no temporary credential and sends nothing. The created user is exactly as usable as one the bootstrap CLI has not activated — which is to say not at all — and the credential-delivery question is answered when D16 is, without the API having guessed at it in the meantime. The transitions the API does own are `disable()` and a `reactivate()` that restores the state the CHECK admits:

```
invited  ──activate(password), out of band──▶  active  ──disable()──▶  disabled
   ▲                                              ▲                        │
   └──────────────── reactivate() ────────────────┴────────────────────────┘
```

`reactivate()` returns a user to `active` when a credential survives and to `invited` when none does. It is not a choice: `users_active_requires_credential` makes `active` unrepresentable for a credential-less user, and leaving them `disabled` would make a user who was disabled before ever activating permanently unrecoverable (ADR-007 D-2).

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
    ∩ { P : ∃ coherent creator grant g,
            P ∈ permissions(g) ∧ scopeCovers(g.scope, key.binding_scope) }
    ∩ permissions_valid_for_the_target_operation
```

The middle term is the creator's authority **at a scope covering the key's own binding** — not everything the creator holds anywhere. The distinction is load-bearing: a creator who is `read_only` in Organization A and `org_admin` in Organization B must not be able to mint a key bound to Organization A carrying `org_admin` permissions.

Implemented in Phase 1B.5.1 (ADR-005 D-4), together with §2's correction so the two cannot drift apart: each creator grant is tested for coverage of the key's binding scope with the same `scopeCovers` rule the evaluator uses, and only the grants that cover it contribute their own permissions. The chain the coverage is judged against is read from the key's own `org_id`/`workspace_id` columns, never from the request.

The intersection is **recomputed on every request**, not snapshotted at creation: a key whose creator has since lost a permission loses it on the next request, and a key whose creator no longer exists resolves to no permissions at all. A key must not outlive the authority that produced it.

**How a key is authorized.** The principal carries exactly one synthesized grant — `roleKey: 'api_key'`, scoped to the key's own binding (its workspace when it has one, otherwise its organization) — so an API key passes through the same `PermissionEvaluator` and the same `scopeCovers` rule as a user, with no special branch anywhere. The grant is never `platform`, so a key can never reach the control plane, and downward-only inheritance then means a workspace-bound key cannot perform an organization-wide operation. Authentication and authorization are both operational in Phase 1B.3; *administration* of keys (creation, rotation, revocation endpoints) is Phase 1B.6.

A key is permanently bound to its organization (`api_keys.org_id`), and that binding is never widened by anything on the request. A client-supplied `workspace_id` or `team_id` may **narrow** what the key acts on; it can never create authority the key does not already hold. This is the same authoritative-versus-advisory rule as for user sessions (`TENANCY.md` §2b), applied to a credential whose tenancy is fixed at creation rather than resolved per request.

## 6. Scope integrity — `user_roles.scope_id` cannot point cross-tenant

`user_roles.scope_type`/`scope_id` is a polymorphic reference across the five-scope model (`platform` with no id, `reseller`, `organization`, `workspace` or `team`), which means it cannot be a single physical foreign key. Two independent guards apply, neither sufficient alone:

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
| **No conferring a `(permission, scope)` pair you do not hold.** Assigning role `R` at scope `s` requires that for **every** permission `P` in `R`, the actor holds some coherent grant carrying `P` at a scope covering `s`. | Service layer, Phase 1B.5.5 (`RoleAssignmentService`). Asked through `AuthorizationService.unheldPermissions`, which resolves the scope chain once and decides every permission against the coherent-grant rule — never against `principal.permissions`. The distinguishing case, and the one the suite asserts: an actor holding `role_assignments.grant` across the organization and `teams.create` in one workspace has `teams.create` in its flattened list, and still may not confer it at the organization |
| **No granting at a scope you do not cover.** The grant's `(scope_type, scope_id)` must fall within the actor's own scope set, per the downward-only inheritance of `TENANCY.md` §1a.4. | Service layer, Phase 1B.5.5. `role_assignments.grant` is checked against **the scope being granted at**, not the actor's resolved context — that substitution is the whole of the guard, and an out-of-reach scope is `404` rather than a confirmation it exists |
| **No cross-tenant role assignment.** A role from Organization A can never be granted at a scope owned by Organization B. | Service layer **and** `fn_validate_user_role_scope` (§6) |
| **No self-granted platform access.** Platform-level roles are assignable only by an existing platform admin. | Service layer **and** `fn_validate_user_role_scope` |
| **No platform role at a tenant scope.** `alendei_super_admin` cannot be granted at `organization` scope to "scope it down" — the combination is refused outright. | Service layer **and** `fn_validate_user_role_scope` |
| **No smuggling platform power into a tenant role.** A `platform.*` permission cannot be attached to a role with `roles.org_id IS NOT NULL`, closing escalation by custom role composition. | `fn_validate_role_permission` (`DATABASE.md` §2) |
| **No forged `org_id` on a grant.** `user_roles.org_id` is derived by the trigger from the resolved scope chain, never taken from the writer. | `fn_validate_user_role_scope` |
| **No upward administration.** An actor cannot modify its own scope's parent — an organization admin cannot reassign their organization's reseller. | Service layer + RLS (`TENANCY.md` §3a) |
| **At least one active platform administrator always remains.** Revoking the last platform grant, disabling its holder, deleting its holder, or deleting the role is refused. | Service layer (clear `409 AUTHZ_LAST_PLATFORM_ADMIN`) **and** `fn_assert_platform_admin_remains` taking `pg_advisory_xact_lock` (migration `0005`), which is what makes it hold under concurrency (ADR-005 D-7). Phase 1B.5.6 — see §7a |
| **No unaudited mass revocation through role deletion.** Deleting a role while grants of it exist is refused, so every revocation is an explicit, individually audited act rather than a cascade. | Service layer (`409`) **and** `ON DELETE RESTRICT` (migration `0004`, ADR-005 D-8), Phase 1B.5.4. The service check is the message; the constraint is what holds with the service bypassed |
| **No rewriting a system role.** `roles.is_system_role` marks the seeded platform and tenant roles. A tenant principal holding `roles.update` composes roles *within* an organization; it does not get to redefine what `org_admin` means, nor promote a custom role into a system one. | Service layer (`403`) **and** `fn_protect_system_roles` / `fn_protect_system_role_permissions` (migration `0004`), Phase 1B.5.4. Both triggers admit only a transaction that has declared `app.is_platform_admin` (the seeder, the bootstrap CLI) or `app.provisioning` (`TenantRoleProvisioner`) — neither of which any application principal can set |
| **No grant at a scope level the role was never designed for.** `RoleDefinition.allowedScopeTypes` bounds where a seeded role may be granted — `org_admin` at `organization` only, `agent` at `organization`/`workspace`/`team`. | Schema from Phase 1B.5.4 (`roles.allowed_scope_types`, migration `0004`); **enforced at grant time from Phase 1B.5.5** in `RoleAssignmentService`, closing §6n case 28. The refusal is `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED`, deliberately **not** `403`: the actor was entitled and the request well-formed — the role simply does not exist at that level, and collapsing the two would tell an administrator it lacked authority it actually has |
| **No conferring authority a credential's creator never held at its binding.** An API key's effective permissions intersect its creator's authority *at the key's own binding scope*, so a creator cannot mint a key carrying permissions it holds only in another workspace or another organization (§5c). | Service layer (`AuthGuard`), Phase 1B.5.1 |

### 7a. The last-platform-admin invariant (Phase 1B.5.6)

**The definition, and there is only one.** A *valid platform administrator* is a user with `users.status = 'active'` holding a `user_roles` row at `scope_type = 'platform'`. That row necessarily references a platform role (`roles.org_id IS NULL`), because `fn_validate_user_role_scope` admits nothing else at that scope. It is the authorization model's own definition — `ScopeResolver` derives `isPlatformAdmin` as "holds some grant at platform scope" — and authorization, the invariant, the tests and this document all use it. No second notion of administrator exists.

Two consequences worth stating, because both are easy to assume the other way:

- **`alendei_support` does not count** (changed by ADR-011 D-2, migration `0010`). The invariant now preserves an active `alendei_super_admin` at platform scope — the same definition `isPlatformAdmin` and `app_is_platform_admin()` use. Previously any platform-scope grant counted, so the last real administrator could be removed while a read-only support grant kept the invariant nominally satisfied.
- **`reseller_admin` does not.** It is a platform role, but it is granted at `reseller` scope, and scope is what decides.

**"Active" is load-bearing.** A disabled user cannot authenticate, so a grant it holds confers nothing and must not satisfy the invariant.

**Five paths can violate it, and all five are closed:**

| # | Path | Closed by |
|---|---|---|
| 1 | Revoking the grant | `DELETE /role-assignments/:id` → `409 AUTHZ_LAST_PLATFORM_ADMIN`; trigger beneath it |
| 2 | Disabling the holder | `POST /users/:id/disable` → `409`; trigger on `users` (UPDATE OF `status`) beneath it |
| 3 | Deleting the holder | Cascade from `users` to `user_roles` fires the `user_roles` trigger. Not one of ADR-005 D-7's three; found in 1B.5.6 |
| 4 | Deleting the role | Already closed twice: system roles are immutable (1B.5.4) and `ON DELETE RESTRICT` refuses the delete while grants exist |
| 5 | Changing the grant (`UPDATE` of `scope_type`, `user_id` or `role_id`) | `trg_user_roles_platform_admin_liveness_update` (migration `0010`); no application path updates `user_roles` |

**Why the database and not only the service.** The same reason §6 gives for cross-tenant grants: a guard that exists only in the service is a different quality of assurance, and a migration script or admin tool bypasses it. The service check exists to turn a `restrict_violation` into a `409` a caller can act on; the trigger is the guarantee.

**Why `409` and not `403`.** The actor held the authority and the request was well-formed — the platform may simply not enter that state. The remedy is to appoint another administrator first, not to acquire more permission, and a `403` would send an administrator looking for authority it already has.

**Concurrency.** An application count cannot hold this invariant: two transactions each count two administrators, each remove a *different* one, and both commit, because under `READ COMMITTED` neither sees the other's uncommitted delete and no row they wrote overlaps. `fn_assert_platform_admin_remains` takes `pg_advisory_xact_lock(PLATFORM_ADMIN_LOCK_KEY)` before counting, which serialises exactly the mutators of this invariant and releases on commit *and* rollback. The key is a single constant exported from `@acc/db`; a second key would silently disable the guarantee, so the test suite asserts the constant and the function body agree.

**Contention is confined to platform-admin mutations.** Both triggers carry `WHEN` clauses — a deleted row that is not a platform grant, and a status change that is not a departure from `active`, never reach the function and so take no lock and run no count. Ordinary tenant role revocation is entirely unaffected.

Every role grant and revocation is audit-logged without exception, including the attempts that were refused (`SECURITY.md` §4) — a rejected escalation attempt is precisely the event worth having a record of. `audit_logs.outcome` carries `denied` for exactly this purpose, and the audit row records the scope the attempt was made at on the same five-level enum `user_roles.scope_type` uses (`DATABASE.md` §12, ADR-002), so a refused escalation and the grant it targeted are directly comparable.

The identity database role (`acc_auth`) cannot write a role-grant audit row at all: it is confined to platform scope and to the pre-tenant authentication vocabulary (`DATABASE.md` §2a), so an audit record claiming a privileged action can only have come from the application role acting inside a resolved tenant context.

Frontend validation is UX-only and is never an authorization boundary for any of the above.

## 8. Role and grant lifecycle

Every state change below is a privilege change, so each one is audited, and each audit row commits in the same transaction as the change it records (ADR-003 D-2).

### 8a. Roles

| Operation | Rule | Audit |
|---|---|---|
| Create | A tenant role only: `roles.org_id` is the actor's resolved organization, never `NULL`, and `is_system_role` is false. Its permission set must lie within the actor's effective grant authority at that organization (§7) | `role.created` |
| Update | Name, description and the permission set. The permission set is supplied as a **complete replacement**, not a delta, so the audit row's `before`/`after` describe the whole role rather than one edit. Adding a permission requires the actor to hold it; removing one does too, so an actor cannot strip authority it cannot itself see | `role.updated` |
| Delete | Refused with `409` while any `user_roles` row references the role, and refused again by `ON DELETE RESTRICT` with the service bypassed (migration `0004`). `role_permissions` is removed with the role — it is the role's own composition — and the `before` payload preserves what the role was | `role.deleted` |

**System roles are wholly immutable through the API from Phase 1B.5.4** — name and description included. This is stricter than this section previously stated, and deliberately so: the guard that makes it true is a database trigger (`fn_protect_system_roles`), and admitting a name edit would mean a column-level exception inside the control rather than a control with no exceptions. The cost is that an organization cannot rename its seeded `org_admin`; the benefit is that "a tenant cannot touch a system role" needs no qualifier. Relaxing it later is a product decision, and would be a change to the trigger, not to the service.

Platform roles (`org_id IS NULL`) are not administrable through the API at all; they are seeded, and changing them is a migration (`DECISIONS.md` D22). A custom role also cannot be *promoted* into a system role after creation — the same trigger refuses it.

**Why deletion is refused rather than cascaded.** `user_roles.role_id` cascaded at the schema level until migration `0004`, so an unguarded delete would have revoked every grant of that role across the organization and written no audit row for any of them — an unbounded privilege change from a single statement, invisible to the trail that exists to record exactly that. Refusing while referenced forces each revocation to be an explicit act with its own record. Soft deletion is rejected for a different reason: a `deleted_at` the evaluator must filter on is a new bypass surface, and one query that forgets the predicate silently restores a role that was meant to be gone (ADR-005 D-8).

### 8b. Grants

| Operation | Rule | Audit |
|---|---|---|
| Grant | `(user, role, scope_type, scope_id)`. `org_id` is derived by the trigger, never supplied (§6). The scope must be admitted by the role's `allowedScopeTypes`, must fall within the actor's own scope set, and every permission the role carries must be within the actor's effective grant authority at that scope (§7) | `user_role.granted` |
| Revoke | A hard `DELETE`. There is no `revoked_at` column: a revocation flag would be a second source of truth the evaluator must filter on, and a missed predicate would silently restore authority (`DECISIONS.md` D17) | `user_role.revoked` |

A duplicate grant is refused by the partial unique indexes on `user_roles` and surfaces as `409`, never as a silent success — a silent success hides a caller that is double-granting. **The conflict is caused and then translated, never predicted** (Phase 1B.5.5): the insert is attempted and the index decides it, because a check-then-insert leaves a window in which two concurrent identical grants both pass the check. The suite asserts that two simultaneous identical grants yield exactly one `201` and one `409`.

**Grant order of operations (Phase 1B.5.5).** `RoleAssignmentService` runs five guards in a fixed order inside one transaction, and the order is load-bearing — each is only meaningful once the previous has passed:

| # | Guard | Refusal |
|---|---|---|
| 1 | The actor may grant **at the scope being granted at** — not at its own resolved context | `403`, or `404` when the scope is out of reach and must not be confirmed to exist |
| 2 | The role is real, visible under RLS, and not a platform role | `404`, or `403 AUTHZ_PLATFORM_ROLE_REQUIRED` — a tenant principal must not manufacture platform privilege through role assignment |
| 3 | The role's `allowedScopeTypes` admits this level (§6n case 28) | `422 AUTHZ_SCOPE_TYPE_NOT_ADMITTED` |
| 4 | Every permission the role carries is within the actor's own authority **at that scope** (§6n cases 21, 22) | `403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION`, naming the offending keys |
| 5 | The target user exists, is reachable and is active | `404`, or `409` for a disabled user |

Revocation is authorized at **the grant's own scope**, read from the stored row rather than from anything the caller said — so an actor that can see a grant listed at the organization still cannot revoke one living in a workspace it does not cover. The delete is conditional and returns the deleted row, so two concurrent revocations yield one `204` and one `404` rather than two successes.

**`users` is platform-level and RLS cannot scope it**, so reachability of a grant target is established the only honest way available: the user must already hold at least one grant this request can see. A user in another tenant has none visible, so it is `404` — the same answer as an id that does not exist, which is what keeps the endpoint from becoming a user-enumeration oracle.

**The last-platform-admin invariant is enforced on revocation from Phase 1B.5.6** (§7a), and on user disable from Phase 1B.6.1 (§8c) — the same invariant, the same advisory lock, and the same trigger beneath both.

**Grants take effect on the next request, not mid-request.** Authorization is re-derived per request from current database state (ADR-003 D-3), so a grant committed during request *n* applies from request *n+1*. This is a consequence of re-derivation rather than a limitation to work around, and it means a revocation is effective immediately on the next call rather than at token expiry.

**Refused attempts are audited as deliberately as successful ones.** `audit_logs.outcome = 'denied'` exists for this, and a rejected escalation is precisely the event worth having a record of. A refusal by the authorization layer itself is recorded as `authorization.denied` with the actor's own legitimate scope and the attempted target in metadata (`SECURITY.md` §4, ADR-005 D-6), implemented in Phase 1B.5.3 and owned by `AuthorizationService`.

The actor's scope is recorded **narrowest-first** — workspace, else organization, else reseller, else platform — because that is the most truthful statement of where the actor was: a principal pinned to one workspace did not act "in the organization", and recording it that way would overstate its reach on a permanent record. No fallback scope is invented for a principal with no resolved context; the row is refused and the request fails closed, which is defensive only, since every reachable path resolves a tenant context before any authorization check.

### 8c. User lifecycle (Phase 1B.6.1)

A user's *identity* and a user's *authority* are administered separately, and the split is the point: `UserAdministrationService` owns the first and owns none of the second.

| Operation | Rule | Audit |
|---|---|---|
| Create | `users.invite` at the request's organization. Creates an `invited` identity — no credential is accepted, generated or returned — and confers its first grant **through `RoleAssignmentService.grant`**, in the same transaction, with guards 1-4 of §8b intact | `user.invited`, plus `user_role.granted` from the grant itself |
| Update | `users.update`. Reaches `phone` and nothing else. `status`, `email`, roles and scopes are absent from the DTO, so the global `forbidNonWhitelisted` pipe refuses them as `400` rather than a guard having to remember to | `user.updated`, only when a value actually changed |
| Disable | `users.disable`. Sets `status = 'disabled'`, revokes every live session in the same transaction, and is bounded by the liveness invariant (§7a) | `user.disabled` |
| Reactivate | `users.reactivate`. Restores `active` when a credential survives, otherwise `invited` (§5a.1). Sessions are **not** restored | `user.reactivated` |

**`users.reactivate` is a separate permission** rather than half of `users.disable`. Only reactivation can hand someone back the authority they held, including an administrator's; a permission named "disable" that also re-enabled would misdescribe what it confers, and every holder of it would silently acquire the other half. It is granted to `org_admin` (which already holds `users.disable`) and to `alendei_super_admin`, and to nothing else — withholding it from an organization that can disable would leave a tenant able to lock a colleague out with no path back.

**The initial grant is required, and that follows from §6 rather than from product taste.** A user's organization *is* the set of grants it holds, so a user created with none is invisible to the administrator who created it, to `GET /users` and to the `users_select` policy. Creating one would not be a lean default; it would be a row nobody can see and nobody can reach.

**Guard 5 is the one thing creation relaxes, and only for a user it created itself.** §8b's reachability probe asks whether the target already holds a grant this request can see — which a user created moments ago cannot, its first grant being the one under construction. The probe is skipped; the property is not. Reachability is established by construction: the caller authorized `users.invite` at its own organization and inserted the row in this transaction. Guards 1-4 run unchanged, and guard 1 — may this actor grant *at this scope* — is the escalation-bearing half. The relaxation is an in-process option with no field on any DTO, so no request can ask for it, and a structural test asserts it has exactly one caller (ADR-007 D-4).

**Disable reaches the identity, not the membership — an accepted consequence of §1's model.** `users.status` is a column on a platform-level table, and this document has said since §5a.1 that a user is one identity with grants in possibly several organizations. The consequences follow directly and are accepted rather than worked around:

- an administrator holding `users.disable` in **one** organization the user belongs to can disable them, which ends their access to **every** organization they belong to, including under other resellers;
- `SessionService.revokeAllForUser` carries no organization predicate, so every session goes, not only those used against the acting organization;
- the `user.disabled` audit row is filed at the acting organization's scope (§8, ADR-005 D-6), so an affected organization has no local record of it.

The alternative is per-membership status, which means a membership table and a second notion of "active" for the evaluator, the liveness invariant and every future query to filter on — the same objection §8a records against soft-deleting roles, and a larger change than the behaviour warrants. The organization-local operation already exists and is the right one for "this person should not have access here": revoke their grants (§8b), which is scoped, individually audited, and leaves the account alone. `API.md` §3d and `FRONTEND_API_CONTRACT.md` §30d both state the distinction so a console does not present disable as an organization-local removal.

**Deletion does not exist, at any layer.** `acc_app` holds no `DELETE` grant on `users` (migration `0000`), so it is unavailable rather than merely unimplemented, and the API offers no `DELETE` route to imply otherwise. Users are referenced by sessions, API keys, grants, idempotency records and audit rows; the trail must outlive the identity it describes (ADR-007 D-1).

### 8d. API keys (Phase 1B.6.2)

A key is a **credential, not a user**. It has its own identity, a creator, and a binding scope, and the three do different jobs (§5c).

| Operation | Rule | Audit |
|---|---|---|
| Create | `api_keys.create` at **the binding scope requested**. The key's `scopes` must lie within the creator's own authority at that scope — the same `unheldPermissions` question role composition asks, through the same boundary. Only a signed-in user may create one | `api_key.created`, at the binding scope |
| Read | `api_keys.read` — at the organization for the list, at **the key's own stored binding scope** for the detail | — |
| Revoke | `api_keys.revoke` at **the key's stored binding scope**, read from the row and never from the request. Terminal; the write is conditional (`WHERE revoked_at IS NULL`) so two concurrent revocations yield one `200` and one `409` | `api_key.revoked` |

**Who holds these permissions, and why only they.** `org_admin` holds all three, and `alendei_super_admin` holds them through the whole catalogue. `alendei_support` holds `api_keys.read` only — support can see that a key exists without being able to mint or destroy one. `reseller_admin`, `workspace_manager`, `campaign_editor`, `agent` and `read_only` hold **none**: minting a credential that can act unattended is organization-administrator authority, and a reseller administrator already reaches its organizations through its own grants without needing to create keys inside them. No permission was added and no role composition was changed in 1B.6.2 — the catalogue already expressed the right answer.

**Binding is organization or workspace, and immutable.** Those are the two levels the credential path can express, and there is no rebinding. A key never reaches above its binding: a workspace-bound key cannot perform an organization-wide operation, because `scopeCovers` refuses it in the ordinary evaluator with no key-specific branch.

**Deletion does not exist.** Revocation is terminal and the row stays: `audit_logs.actor_api_key_id` references it, so deleting a key would remove the attribution for everything it ever did.

**Disabling a creator does not revoke their keys** — it stops the keys conferring anything, which is checked at authentication (§5c, Phase 1B.6.1). The distinction is deliberate: the keys remain visible and individually revocable by an administrator, and the audit trail keeps naming them, while the authority they carried is gone from the next request onward.

## 9. Related

Full table definitions: `DATABASE.md` §"IAM & RBAC domain". Security controls (encryption, session hardening, audit): `SECURITY.md`.
