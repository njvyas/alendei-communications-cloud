# Multi-Tenant Architecture

## 1. Hierarchy

```
Alendei (platform operator — not a tenant row; represented by a "system" scope)
  └─ Reseller            (resellers)                 optional layer
       └─ Organization    (organizations)              "the customer" — paying tenant
            └─ Workspace  (workspaces)                 brand/business-unit scope
                 └─ Team  (teams)                       permission-scoping group
                      └─ User (users)
```

- Every `organizations` row has a nullable `reseller_id`. Organizations with no reseller belong to the implicit **Alendei Direct** reseller (a real `resellers` row seeded at bootstrap, not a null-check special case) — this avoids "reseller_id IS NULL" branching throughout the codebase.
- `workspaces` belong to exactly one `organizations` row. Workspaces exist to support multi-brand customers (e.g., a customer running two distinct consumer brands under one legal entity/contract) and are the unit of white-label branding below the reseller level.
- `teams` belong to exactly one `workspaces` row and exist purely for permission scoping (e.g., "Support Team" vs. "Marketing Team" within the same workspace) — they carry no billing or branding meaning.
- `users` authenticate at the platform level (one user identity) but are granted access via `user_roles` scoped at any level of the five-scope hierarchy (`platform | reseller | organization | workspace | team`, §1a) — see `RBAC.md`.

## 1a. Canonical scope model (normative)

This section is the **single normative definition of the scope hierarchy**. Every other document — `RBAC.md`, `DATABASE.md`, `SECURITY.md`, `API.md`, `TESTING.md` — defers to it and must not restate a conflicting set of scope levels. Resolved in `DECISIONS.md` B31.

```
PLATFORM          Alendei itself. Not a tenant row; represented by a scope with no scope_id.
   ↓
RESELLER          A book of organizations under one brand (resellers.id).
   ↓
ORGANIZATION      The paying tenant, "the Customer" (organizations.id).
   ↓
WORKSPACE         A brand / business unit inside one organization (workspaces.id).
   ↓
TEAM              A permission-scoping group inside one workspace (teams.id).
   ↓
USER              A platform-level identity, granted access via user_roles at one or more scopes.
```

### 1a.1 What each scope represents, and what it does not

| Scope | Represents | `scope_id` refers to | Deliberately does **not** carry |
|---|---|---|---|
| `platform` | Alendei's own control plane | `NULL` — there is exactly one platform | Any tenant data ownership |
| `reseller` | One reseller and every organization beneath it | `resellers.id` | Direct ownership of workspaces/teams (it reaches them only through its organizations) |
| `organization` | One paying tenant | `organizations.id` | Billing identity for a *sub-unit* (that is the organization itself) |
| `workspace` | One brand/business unit | `workspaces.id` | Billing *identity* — there is no per-workspace wallet, credit account, invoice or contract; those exist only at organization level (`DATABASE.md` §10). Usage may still be attributed to, priced by, and reported per workspace |
| `team` | A permission-scoping group | `teams.id` | Any billing or branding meaning at all |

`USER` is deliberately **not** a scope. A user is the subject of a grant, never its scope: there is no `scope_type='user'`, and per-resource ownership checks ("is this row mine?") are an ABAC concern (`RBAC.md` §2), not a scope level.

### 1a.2 Valid `scope_type` values

`user_roles.scope_type` is an enum of exactly five values, in hierarchy order:

```
platform | reseller | organization | workspace | team
```

**This is the authorization scope enum.** Two other tables carry a column also named `scope_type`, and they are deliberately *different* enums that must never be conflated with this one or with each other:

| Column | Values | Purpose |
|---|---|---|
| `user_roles.scope_type` | `platform, reseller, organization, workspace, team` | **Authorization.** Where a role grant applies. |
| `routing_policies.scope_type` | `platform, reseller, organization, workspace, channel, campaign, journey, message` | **Configuration.** Which routing policy is effective (`ROUTING_ENGINE.md` §4). Its first four values align with the tenancy hierarchy; `channel`/`campaign`/`journey`/`message` are message-origination dimensions, not tenancy levels, and confer no access. |
| `provider_credentials.scope_type` | `platform, reseller, organization` | **Configuration.** Which credential resolves for a send (`PROVIDER_ADAPTER.md` §4a). It stops at organization because credentials are never workspace- or team-owned. |

A value appearing in one of these enums grants nothing in another. Holding a role at `scope_type='workspace'` does not, for instance, make a `routing_policies` row with `scope_type='workspace'` administrable — that requires the relevant permission at a scope covering it.

### 1a.3 Parent–child constraints

Each level has exactly one parent, and the chain is walkable in both directions:

| Child | Parent | Enforced by |
|---|---|---|
| `resellers` | platform | implicit — every reseller is under the platform |
| `organizations` | `organizations.reseller_id → resellers.id` | foreign key; nullable in schema, always populated in practice (the seeded "Alendei Direct" row, §1) |
| `workspaces` | `workspaces.org_id → organizations.id` | foreign key, `NOT NULL` |
| `teams` | `teams.workspace_id → workspaces.id`, plus a denormalized `teams.org_id` | a **composite** foreign key `(workspace_id, org_id) → workspaces(id, org_id)`, so a team whose organization disagrees with its workspace's organization is unrepresentable |
| `user_roles` grant | the scope named by `(scope_type, scope_id)` | the `fn_validate_user_role_scope` trigger (`RBAC.md` §6), which resolves the target row, verifies its ownership chain reaches the role's own organization, and **derives** `user_roles.org_id` rather than trusting the writer |
| `audit_logs` record | the scope named by `(scope_type, scope_id)` | the `fn_validate_audit_scope` trigger, which **derives** `reseller_id`/`org_id`/`workspace_id`/`team_id` from that pair, plus composite foreign keys `(workspace_id, org_id) → workspaces(id, org_id)` and `(team_id, org_id) → teams(id, org_id)` making a mismatched chain unrepresentable (`DATABASE.md` §12, ADR-002) |

A request that names a mismatched parent/child pair — a workspace that does not belong to the claimed organization, a team that does not belong to the claimed workspace — is rejected, never silently reinterpreted.

### 1a.4 Scope inheritance (downward only)

**A grant at a scope covers that scope and everything beneath it. It never confers anything above or sideways.**

```
platform     ──▶ every reseller, organization, workspace, team
reseller     ──▶ its organizations, and their workspaces and teams
organization ──▶ its workspaces and their teams
workspace    ──▶ its teams
team         ──▶ that team only
```

Concretely: an `organization`-scoped grant needs no additional workspace-level grant to act within that organization's workspaces. The inverse never holds — a `workspace`-scoped grant confers nothing at organization level, and a `team`-scoped grant confers nothing at workspace level. Sideways is likewise closed: a grant at Workspace A confers nothing at Workspace B, even within the same organization.

Inheritance is a property of the *grant*, not of the permission: a permission the role does not hold is not acquired by holding that role at a higher scope.

**Coherence — the third invariant, alongside downward-only and never-sideways.** A principal holding several grants holds several *independent* authorities, and they never combine. The permission and the covering scope in any one decision must come from the **same** grant (`RBAC.md` §2, ADR-005 D-1): a permission conferred by a grant at Workspace A reaches exactly what that grant reaches, and holding a second grant at the organization does not lift it there. Evaluating a flattened set of permissions against a union of covered scopes authorizes the cross-product of the two, which contains combinations no grant confers — and because the widening runs upward, it is vertical escalation rather than a harmless over-approximation.

## 1b. Deletion and retention of tenancy rows (normative)

**A tenancy row that has audit or financial history is never hard-deleted. It is deactivated and retained.** Every level of the hierarchy already carries the status column this requires: `resellers.status`, `organizations.status` (`active|suspended|closed`), `workspaces.status` (`active|archived`), and `users.status` (`active|invited|disabled`). Closing an organization means `status='closed'`, not a `DELETE`.

This is enforced, not merely intended. Foreign keys into tenancy rows are `ON DELETE RESTRICT` from `workspaces`, `teams`, `api_keys`, `ws_tickets` and — as of Phase 1B — `audit_logs`. An organization with audit history fails a `DELETE` with a plain foreign-key violation naming `audit_logs`.

`ON DELETE SET NULL` is specifically **not** used from `audit_logs`, and the reasoning generalizes to any future append-only table (ADR-002):

- It would mutate audit history as a side effect of deleting an unrelated row, silently destroying the tenancy attribution of past events — a row that recorded "this happened in Organization A" would quietly become "this happened at platform level".
- On an append-only table it does not even work: the cascade performs an internal UPDATE, which the append-only trigger refuses, so the delete fails anyway — but with a confusing `insufficient_privilege` error from a trigger instead of a clear foreign-key violation.

Hard deletion of tenancy rows remains available to the schema owner for development fixtures and for a genuine erasure request (`DECISIONS.md` D8), and in both cases it is an explicit, owner-level operation rather than something the application can do.

**Teams gain the same lifecycle in Phase 1C** (ADR-012 OD-5, F-6): `teams.status` with the existing `workspace_status` values `active | archived`. There is no team `DELETE`. *(IN PHASE 1C — not yet implemented; today `teams` has no status column.)*

## 1c. Organization, workspace and team lifecycle (ADR-012) — organizations IMPLEMENTED (1C.1a); workspaces/teams IN PHASE 1C

**Organizations: implemented in Phase 1C.1a** (`/organizations`, migration `0011`). **Workspaces and teams: not yet** — they are still created only by the owner (seed, bootstrap, fixtures) or as an organization's default workspace, and the workspace/team part of this section remains a frozen target.

**Organizations** (`organization_status`, no new values):

```
            suspend                    close
 active ─────────────▶ suspended ─────────────▶ closed   (terminal)
   ▲                      │
   └──── reactivate ──────┘
 active ──────────────── close ───────────────▶ closed
```

- Transitions are performed only by a principal holding `platform.tenants.manage` at platform scope (F-2). Reseller-initiated suspension, and any cascade from a suspended reseller, are **DEFERRED** with reseller lifecycle (OD-2).
- Creation: by `platform.tenants.manage` (any reseller) or by `organizations.create` at `reseller` scope beneath that reseller only (F-3). The organization's tenant system roles (`TenantRoleProvisioner`) and **one default workspace** (`is_default = true`) are created in the same transaction. This is what makes `DECISIONS.md` D3's "every organization gets a seeded default workspace" true for API-created organizations.
- `resellerId` and `slug` are immutable (F-8); moving an organization between resellers is not a Phase 1C operation, and 1C.6 adds a database guard so a direct write cannot do it either.
- **Closing deletes nothing** (OD-12). Data is retained, inaccessible to organization principals, readable by platform principals, and no mutation of tenant data is accepted in a closed organization. Physical deletion and retention automation are out of scope.

**How status is enforced — application authorization, not RLS** (OD-3, F-4, F-5):

- For a principal without any platform-scope grant, a non-`active` organization is removed from the organizations it may select (§2a). If that leaves it no active organization and exactly one it is connected to, implicit selection is refused with that organization's status rather than treated as "no organization". Selecting it explicitly or implicitly, or presenting an API key bound to it, is refused on the **next request** with `403 TENANCY_ORGANIZATION_SUSPENDED` / `403 TENANCY_ORGANIZATION_CLOSED` (to principals who hold a grant in, or beneath the reseller of, that organization; anyone else receives the existing `403 TENANCY_CONTEXT_MISMATCH`). Grants and state are re-read on every request, so there is no token-TTL window.
- Platform principals (super admin and support) can still select and read a suspended or closed organization. Tenant-data mutations in a non-active organization are refused for everyone in Phase 1C, except the lifecycle transitions themselves.
- RLS is **unchanged**: `app_org_in_scope()` gains no status term. RLS keeps enforcing *which organization*; status decides *whether that organization is usable*, and that decision lives with the rest of authorization. The direct-database guarantees of `§3a` and ADR-011 are therefore unaffected by Phase 1C.

**Workspaces and teams** (`active | archived`, F-6): archive and restore; the default workspace cannot be archived; archiving a workspace is refused while it holds active teams; an archived workspace or team cannot receive new teams, grants or API keys, while existing grants and keys keep working. Cross-organization moves are not supported.

## 2. Tenant context resolution

Tenant context is a server-derived triple `{org_id, workspace_id?, reseller_id?}` (workspace/reseller optional depending on the call). It is resolved exactly once per request, immediately after authentication, from:

- A validated JWT's claims (for user sessions), or
- An API key's bound tenant scope (`api_keys.org_id`), or
- An OAuth2 client credential's bound scope.

**Rule**: any `org_id`/`workspace_id`/`tenant_id` appearing in a URL path, query string, or request body is advisory only. The server always re-derives the authoritative tenant context from the auth layer and rejects (`403`) any request where a client-supplied identifier does not match — it never "trusts and proceeds" and never silently substitutes the correct value.

### 2a. How scope is resolved from the authenticated identity

Resolution runs exactly once per request, immediately after authentication and before any handler, and produces the principal's **scope set**: every `user_roles` grant it holds, each as a `(scope_type, scope_id)` pair, together with the flattened permission keys those grants' roles carry.

```
credential (session JWT | API key)
        ↓  verified — an unverified credential resolves nothing
principal identity  (user_id | api_key_id, actor_type)
        ↓  read user_roles / api_keys.scopes
scope set  =  { (scope_type, scope_id), ... }  +  effective permissions
        ↓  derive the authoritative tenant triple
TenantContext { org_id, workspace_id?, reseller_id?, is_platform_admin }
        ↓  SET LOCAL inside the request transaction
PostgreSQL RLS
```

The tenant triple is derived from the scope set as follows, and from nothing else:

| Field | Derived from |
|---|---|
| `is_platform_admin` | true if and only if the scope set contains an `alendei_super_admin` grant at `platform` scope — **not** any platform-scope grant: `alendei_support` is platform-scoped and read-only (ADR-011 D-2) |
| `reseller_id` | the `scope_id` of a `reseller` grant **on the reseller that owns the selected organization**; with no organization selected, the single reseller grant if exactly one exists; otherwise `NULL`. **Never** the selected organization's reseller merely because it has one — that derivation made sibling organizations mutually visible to RLS and was removed (ADR-011 D-1) |
| `org_id` | an `organization` grant's `scope_id`; or the owning organization of a `workspace`/`team` grant; or, for an API key, `api_keys.org_id` |
| `workspace_id` | the first (by grant id) `workspace` grant in the selected organization, else the owning workspace of the first `team` grant there; otherwise `NULL`. Note: this is set even when the principal *also* holds an organization-level grant. No RLS policy reads it; it feeds the WebSocket ticket topic and the denial-audit actor scope |

#### Principals holding grants in more than one organization (ADR-003 D-4)

The table above says where `org_id` comes from, not which one wins when a principal legitimately holds grants in several organizations — a reseller admin, an Alendei support user, or a consultant invited into two tenants. Resolved:

| Situation | Behaviour |
|---|---|
| Exactly one organization in scope | Selected implicitly; no selector required |
| More than one in scope, selector present and in scope | That organization is selected |
| More than one in scope, selector absent | **`400 TENANCY_CONTEXT_REQUIRED`** |
| Selector names an organization outside the principal's scope | **`403 TENANCY_CONTEXT_MISMATCH`** |

The canonical selector is the **`X-Acc-Organization`** request header, implemented in Phase 1B.3 by `ScopeResolver.selectOrganization`. The authorized set is derived from `user_roles` on every request — a platform grant reaches every organization, a reseller grant the organizations beneath it, everything else exactly the organizations its grants name. An API key is bound to one organization and selects none: a selector naming a different one is refused rather than ignored. It is a *selection among organizations already in scope*, never a claim of access — it can only narrow, exactly like `workspace_id` in §2b.

Two behaviours are explicitly forbidden, because each converts a security refusal into something that looks like ordinary emptiness:

- **Never silently substitute** another organization the principal happens to hold.
- **Never silently return an empty result** to mask a context mismatch. An out-of-scope selector is a `403`; an in-scope selector that genuinely matches no rows is an empty `200`. A caller — and a test — must be able to tell those apart.

A platform admin is not exempt: holding `platform` scope puts every organization in scope, so a platform admin acting on tenant data supplies the selector like anyone else.

### 2b. Authoritative versus advisory identifiers

| Identifier | Authoritative source | Client-supplied value |
|---|---|---|
| `org_id` | `user_roles` / `api_keys.org_id`, via the resolved principal | **Never trusted.** Cross-checked; a mismatch is `403`, never a substitution |
| `workspace_id` | the principal's grants, or the workspace's own `org_id` chain | Accepted only as a *narrowing* selection among workspaces already in scope; anything else is `403` |
| `team_id` | `teams.workspace_id → workspaces.org_id` chain | Same — narrowing only, within scope |
| `reseller_id` | a `reseller` grant, or `organizations.reseller_id` | **Never trusted** |
| `X-Acc-Organization` (selector) | validated against the principal's own scope set | Accepted only as a *selection among organizations already in scope* (§2a). Out of scope is `403`, never a substitution |
| `user_id` (acting) | the verified credential | **Never trusted** from body, query or header |
| `scope_type` / `scope_id` on a role-assignment request | validated against the actor's own scope set, then re-validated by the database trigger | Treated as a *request*, never as an assertion |

The distinction matters for a specific, common case: a console user holding an organization-level grant may legitimately pass `workspace_id` to say "show me this workspace". That is a filter within an already-authorized scope. It is not, and can never become, a claim of access — if the named workspace is not beneath the resolved organization, the request is rejected rather than filtered to nothing.

#### How the cross-check is implemented (Phase 1B.4, ADR-004 D-3/D-4)

One mechanism, not a comparison per endpoint. A handler *declares* the advisory identifiers it accepts — their level, where they arrive from, and whether they are required — and `AdvisoryTenantGuard` cross-checks every one of them after authentication and before the handler runs. There is deliberately no check left to write at the call site, and therefore none to forget: per-handler copies are how one endpoint ends up with the check and the next one without it, with nothing visibly wrong in either file.

What it is, precisely:

- **An assertion against the already-resolved context, never a resolver.** It reads no database. It can refuse a request; it can never widen one, substitute an identifier, or return an empty result in place of a refusal.
- **Not authorization.** Whether a principal may act *on* a scope remains `PermissionEvaluator`'s question, asked with the target and its ancestry loaded (`RBAC.md` §2, ADR-003 D-5). This answers only whether the supplied identifier contradicts the derived context.
- **Silent about levels the context does not pin.** An organization-scoped principal's grant covers every workspace beneath it, so a supplied `workspace_id` contradicts nothing that can be known without reading tenancy rows — and reading them here is exactly the alternate resolver this must not become. That case is handed on to target-scope authorization, to RLS, and to a `404` that echoes no identifier (`API.md` §3a). A principal pinned to a workspace or a team *is* cross-checked against it, which matters because RLS carries no term below organization (§3a).
- **Deterministic and fail-closed about shape.** A repeated or structured identifier (`?org_id=A&org_id=B`) has no defensible single value, so it is `400 VALIDATION_FAILED` rather than resolved by parameter order. A malformed or empty identifier is refused, not treated as absent. A principal with no admissible identifier at a pinned level refuses every value rather than admitting any.

## 3. Isolation by layer

| Layer | Mechanism | Notes |
|---|---|---|
| API | Middleware resolves and attaches `TenantContext` before any handler runs; NestJS guards reject missing/mismatched context | Applies uniformly; no handler opts out |
| Database | PostgreSQL Row-Level Security (RLS) policies on every tenant-scoped table, keyed on `app.current_org_id` plus the validated reseller/platform claims, set via `SET LOCAL` inside the request's transaction — see §3a. No policy has a workspace or team term | RLS is defense-in-depth *under* application-layer filtering, not instead of it |
| Cache | **Implemented.** Redis keys built only through `RedisKeyBuilder` — tenant keys `{prefix}:t:{org_id}:{...}`, platform keys `{prefix}:platform:{...}`; `:` refused inside a segment. Current users: the rate limiters | Prevents ad-hoc unnamespaced key bugs |
| Queues | **DEFERRED — nothing implemented.** No Kafka producer or consumer exists. Design: message keys/headers include the organization id; consumers assert expected tenant scope for the topic they own (some topics intentionally cross-tenant, e.g. provider health) | Large tenants may later get dedicated topics/partitions (`DECISIONS.md`) |
| Object storage | **DEFERRED — nothing implemented.** Design: keys prefixed `{org_id}/{workspace_id}/{domain}/...`; bucket policy/IAM conditions enforce prefix match where supported | MinIO in dev would enforce this at the application layer only |
| Search | **DEFERRED — nothing implemented.** Design: every OpenSearch document includes the organization id; the query builder injects a mandatory `term` filter | Index-per-tenant vs. shared-index is a scale-driven decision (`DECISIONS.md`) |
| Analytics/logs | Structured log lines carry `orgId` and `correlationId` where a request context exists; analytics facts do not exist yet (DEFERRED) | Physical separation is not assumed by default |

### 3a. How scope maps onto PostgreSQL RLS

RLS enforces the **tenancy** dimension of the scope model. It is the boundary that still holds when application filtering is wrong, missing, or bypassed.

**Session variables** — all transaction-local, written with `set_config(..., is_local => true)`, never a connection-level `SET` (`DATABASE.md` §14a):

| Variable | Set from | Meaning when empty |
|---|---|---|
| `app.current_org_id` | resolved `TenantContext.org_id` | no organization in context — org-scoped rows are invisible |
| `app.current_workspace_id` | resolved `TenantContext.workspace_id` | no workspace narrowing applied |
| `app.current_reseller_id` | resolved `TenantContext.reseller_id` — a genuine reseller-scope grant only (§2a) | not acting in a reseller capacity |
| `app.current_user_id` | the verified principal's `user_id` | not a human-user request |
| `app.is_platform_admin` | `'on'` only when the principal holds `alendei_super_admin` at platform scope | not a platform admin |

**Elevated claims are validated by the database (migration `0010`, ADR-011 D-1).** For any principal RLS binds, `app_current_reseller_id()` returns the claimed reseller only while `app.current_user_id` holds an active `reseller`-scope grant on it, and `app_is_platform_admin()` returns true only while that user holds `alendei_super_admin` at platform scope. An unbacked claim reads as NULL/false. `app.current_org_id` and `app.provisioning` are not validated (`SECURITY.md` §4b).
| `app.provisioning` | `'on'` only inside the tenant-provisioning path, alongside `app.current_org_id` set to the organization being created | not provisioning |

Every variable is written on **every** transaction, including empty values for absent ones, so a pooled connection can never inherit context from the work that ran on it before.

**The one predicate every org-scoped policy is built from** — `app_org_in_scope(target_org)`:

```
app_is_platform_admin()                                   -- platform covers everything
OR target_org = app_current_org_id()                      -- the organization in context
OR app_org_reseller(target_org) = app_current_reseller_id()  -- an organization under my reseller
```

This is exactly §1a.4's downward inheritance expressed in SQL. Note what it does *not* contain: no workspace or team term. **RLS enforces isolation down to the organization; workspace and team are enforced above it, by the authorization layer.** That is a deliberate boundary, not an omission — a workspace is not a tenant, and modelling it as one would make every policy a join and still not remove the need for the authorization check. Documented as a residual risk and revisited if `DECISIONS.md` D3 (making `workspace_id` mandatory on every tenant-scoped table) is ever resolved in favour of mandatory.

**RLS stopping at organization does not mean sub-organization scope is unrecorded.** `audit_logs` records the exact scope an action occurred at — including `workspace` and `team` — and enforces the parent–child chain physically (§1a.3). What RLS does not do is *filter* on those levels.

**Dividing line, stated once and normative for every module:** the database guarantees **organization-level tenant isolation** and nothing finer. Any narrower visibility — workspace, team, or per-resource — is a **mandatory authorization-layer requirement**, enforced by the RBAC/ABAC check in the request path (`RBAC.md` §2, `API.md` §3a) on every read and every write, for API responses, enumerations, exports and reports alike.

Because that layer is the *whole* of the enforcement below organization level, it is not enough for the check to be present — it must also be correct. A check that is performed but evaluates a permission from one grant against a scope from another admits exactly the cross-workspace access this boundary exists to prevent, with RLS fully satisfied and every database test green. Workspace and team enforcement therefore rests on a **grant-coherent** evaluator (ADR-005 D-1, Phase 1B.5.1) whose target ancestry is resolved from the database rather than from request input (ADR-005 D-5, Phase 1B.5.2).

**A caller names the target; it never describes it.** `ScopeChainResolver` derives a target's ancestry from the rows themselves — `workspaces.org_id`, `teams.workspace_id`/`org_id` under their composite foreign key, `organizations.reseller_id` — and `AuthorizationService` has no parameter through which a chain could be supplied, so forged ancestry is unrepresentable rather than rejected. Two independent things then have to hold before a decision is made: the target must be *visible* in the request's own tenant transaction, which RLS decides, and it must be *covered* by a coherent grant, which the evaluator decides. A target that fails the first is a `404` that confirms nothing; one that fails the second is a `403`. It is **never** satisfied by UI filtering, by a client-supplied predicate, or by a query that merely happens to include a `workspace_id`: those are presentation and convenience, not boundaries, and a caller that bypasses the client reaches the unfiltered organization-level view. A workspace-scoped audit row is therefore visible to any principal the authorization layer admits to that organization's audit trail, and restricting it to the workspace is that layer's obligation to enforce, not an optional refinement.

**Scope levels are enforced at different layers, and each layer is load-bearing:**

| Boundary | Enforced by | Holds if the application layer is wrong? |
|---|---|---|
| platform vs. tenant | RLS (`app.is_platform_admin`) + API guard | Yes |
| reseller vs. reseller | RLS (`app_org_reseller`) + API guard | Yes |
| organization vs. organization — including siblings under one reseller | RLS (`org_id`, validated reseller claim) + API guard + list predicates | **Yes — this is the hard tenant boundary.** Proven for the shared-reseller topology in `shared-reseller.int-spec.ts` and `shared-reseller-isolation.sec-spec.ts` (before ADR-011 it did **not** hold for siblings) |
| workspace vs. workspace | API guard (`AuthorizationService.assert`, DB-resolved chain) | No — application-layer only, **by decision** (ADR-011 D-4) |
| team vs. team | API guard (`AuthorizationService.assert`, DB-resolved chain) | No — application-layer only, **by decision** (ADR-011 D-4) |
| role-grant scope integrity | `fn_validate_user_role_scope` trigger + service pre-check | **Yes — the trigger is a hard boundary** |
| platform permission on a tenant role | `fn_validate_role_permission` trigger | **Yes** |

**The running application holds no principal that can bypass RLS.** Migrations and seeding run as the schema owner; the API connects only as non-owner roles (`DATABASE.md` §2).

## 4. Reseller & white-label scoping

A reseller admin's auth context resolves to `{reseller_id}` with implicit access to all `organizations` beneath it; this is enforced the same way org-level access is enforced (RLS + API guard), not via a separate code path.

**Where white-label configuration actually lives**, corrected against the schema — an earlier version of this section named the wrong tables:

| Configuration | Column | Table |
|---|---|---|
| Reseller branding | `brand_config` (jsonb) | **`resellers`** |
| Reseller custom domain | `domain` (unique where not null) | **`resellers`** |
| Workspace branding | `brand_config` (jsonb) | **`workspaces`** |
| Reseller pricing/markup | `default_markup_pct` | **`resellers`** |

`organizations` carries **neither** branding nor a domain. Allowed sender identities are not modelled yet and arrive with the channel phases. See `ARCHITECTURE.md` §16 and `DEPLOYMENT.md` §0b.

**`TenantContext.resellerId` is context, not authority.** It is derived from the *selected organization's* reseller for every principal, so an ordinary organization administrator has one. It answers "which reseller does this request's organization belong to" and must never be read as evidence of reseller-scope authorization — that comes from holding a grant **at** `reseller` scope. The distinction is normative and its first enforcement is the audit read surface (`SECURITY.md` §4, Phase 1B.6.3).

### 4a. How the API enforces the hierarchy

Enforcement is ordered, and each step assumes nothing from the one before it beyond what that step actually established:

```
1. Authenticate            verify the credential; an unverified one resolves nothing
2. Resolve scope set       read the principal's grants (§2a) — never from request data
3. Bind tenant context     derive the authoritative triple; reject any mismatching
                           client-supplied identifier with 403 (§2b)
4. Check permission        does the principal hold the permission the endpoint requires?
5. Check scope coverage    does it hold that permission at a scope covering the TARGET
                           resource's scope, per §1a.4's downward-only inheritance?
6. Open transaction        SET LOCAL the context (§3a)
7. Query                   RLS applies underneath, independently of steps 3-5
```

Steps 4 and 5 are distinct and both mandatory. Holding `workspaces.update` somewhere is not authority to update *this* workspace; the grant's scope must cover the target's scope.

**Enumeration is subject to the same rule as retrieval.** A list endpoint returns only resources within the caller's scope set — an out-of-scope resource is absent from the listing rather than present-but-forbidden, because a `403` on a specific id is itself a disclosure that the id exists. Correspondingly, a direct fetch of an out-of-scope resource returns `404`, not `403`, and the message never echoes the caller-supplied identifier.

### 4b. How WebSocket connections enforce the hierarchy

> **Implementation status.** Only ticket **issuance** exists (`POST /ws/ticket`, Phase 1B). The gateway, ticket consumption, single-use enforcement, session-revocation checks and subscription authorization are **DEFERRED** (`DECISIONS.md` D15) — nothing below the first arrow is implemented or tested. Known gaps in issuance, to be closed before a gateway trusts the ticket: the topic scope is computed without a permission check (any member receives `org:{org}`), there is no team-level topic (a team-scoped user receives its workspace's topic), and revoking a session (an `UPDATE`) does not touch its outstanding tickets.

A WebSocket connection never performs its own scope resolution. It inherits a scope decision that was already made over an authenticated HTTP call (`API.md` §9):

```
authenticated HTTP request  →  POST /ws/ticket
        ↓  scope set resolved exactly as in §2a; topic scope narrowed to what the
           caller may actually subscribe to, and recorded on the ticket row
single-use, short-lived ticket  (ws_tickets: org_id, workspace_id, scope)
        ↓  presented as the connection's first frame — never in the URL
connection bound to the TICKET's recorded context
        ↓
subscriptions admitted only within the ticket's recorded topic scope
```

Three properties are required of the gateway when it is built (DEFERRED — none is testable yet):

- **The connection's tenant context comes from the ticket row, never from anything the socket sends.** A client cannot assert `org_id` on the socket at all.
- **A connection can never widen its own scope after establishment.** A subscription request outside the ticket's recorded scope is refused; the connection is not re-resolved against the user's current grants mid-session.
- **A ticket is consumed exactly once.** Replay of a consumed ticket, and use of an expired one, are both refused — and a revoked session's outstanding tickets are refused with it.

## 5. Tenant context for background workers (mandatory — RLS via request/session context alone is not sufficient)

Postgres RLS as described in §3 depends on `app.current_org_id` being set for the *querying transaction*. That is naturally true for an HTTP request (resolved once by API middleware). It is **not** automatically true for Kafka consumers, the fallback-timer poller, scheduled jobs, the outbound webhook dispatcher, billing workers, search indexers, analytics workers, or journey-execution workers — none of these have an inbound HTTP request to derive context from, and all of them run on pooled DB connections that are reused across many different tenants' work over the connection's lifetime.

**Mandatory rule**: every background job and every event envelope (`EVENTS.md` §2) carries an explicit, authoritative tenant context (`org_id`, `workspace_id` where applicable) that was captured from a trusted source **at the time the job/event was created** — e.g. the `org_id` already validated on the `messages` row that triggered a fallback timer, or the `tenant_id` field on the event envelope that was itself set by the producing service from its own already-resolved `TenantContext`. A worker never derives tenant context by re-parsing arbitrary business-data fields from a payload (e.g. never "whatever `org_id`-looking field happens to be in this JSON blob") — only from the envelope fields the platform itself designates as authoritative.

Every worker's DB access follows the same shape as an HTTP request handler, and no other shape is permitted:

```
1. Receive job/event
2. Validate the job/event's own authenticity (e.g. it came from a topic/queue this worker is entitled to consume — not from an untrusted external source)
3. Derive tenant context from the job/event's designated authoritative field(s) — never from end-user-suppliable data
4. BEGIN a transaction
5. SET LOCAL app.current_org_id = <derived>; SET LOCAL app.current_workspace_id = <derived, if applicable>
6. Perform the query/update (now RLS-enforced exactly as an HTTP request would be)
7. COMMIT (or ROLLBACK) — this automatically clears the SET LOCAL values (DATABASE.md §14a)
```

**Never** issue a session-level `SET` (as opposed to `SET LOCAL` inside a transaction) for tenant context, and never let a worker reuse a pooled connection across two different tenants' jobs without each job going through steps 4–7 independently — `SET LOCAL`'s automatic reset at transaction end is precisely what makes connection pooling safe here without a manual "reset context" step that could be forgotten under error/exception paths. This rule is enforced structurally (a shared worker-harness utility wraps every consumer/job handler with steps 3–7, so individual job implementations cannot opt out) rather than left to each worker's author to remember.

**Implementation status (ADR-004 D-5).** Steps 4–7 exist now, for HTTP and workers alike, as the single sanctioned helper `withTenantTransaction` — and the property this section depends on is proven against a real pool rather than assumed: two organizations' work on one physical connection stay isolated, a query with no context established sees nothing, and a fault injected mid-transaction leaves neither the write nor the context behind (`TESTING.md` §6h). The **harness that makes steps 3–7 non-optional for a worker** is deferred to Phase 2, with the first real consumer. Phase 1B has no consumer, poller or job, and a harness with none has no execution semantics to define and nothing to validate against — its envelope contract, retry behaviour and outbox interaction are all decided by the first consumer, and one guessed at in advance would be rewritten by it or worked around. The rule above is unchanged and binding; what is deferred is the wrapper, not the mechanism.

## 6. Preventing cross-tenant and cross-scope access — the complete list

Every mechanism that stops a principal reaching outside its scope, in one place, so a review has a single checklist:

| Attack | Prevented by |
|---|---|
| Supplying another organization's `org_id` in a path, body or header | Context is re-derived from the credential; a mismatch is `403` (§2b) |
| Forging `org_id` in a JWT claim | Claims are read only from a *verified* token, and tenancy is re-derived from `user_roles`, not taken from the claim |
| An API key acting outside its organization | `api_keys.org_id` is the key's entire tenant reach; it is bound at creation and never widened by a request |
| Reaching another organization's rows despite a missing application filter | RLS `app_org_in_scope(org_id)` on every org-scoped table |
| Reaching another reseller's organizations | `app_org_reseller()` comparison; a reseller grant covers only its own organizations |
| Escalating team → workspace → organization → reseller → platform | Inheritance is downward only (§1a.4); a grant is never widened by the scope it is used at |
| Granting a role at a scope in another tenant | `fn_validate_user_role_scope` derives and verifies the ownership chain, and aborts the transaction on mismatch (`RBAC.md` §6) |
| Granting a platform role without being a platform admin | Same trigger refuses it, independently of the service-layer check (`RBAC.md` §7) |
| Composing a custom role that includes a `platform.*` permission | `fn_validate_role_permission` refuses the row |
| Granting a permission the actor does not itself hold | Service-layer check (`RBAC.md` §7) |
| Discovering out-of-scope resources through a list endpoint | Listings are scope-filtered; absence rather than `403` (§4a) |
| Probing for existence by id | Out-of-scope fetch returns `404` with no echo of the supplied identifier (§4a) |
| A worker acting under the wrong tenant | Context comes from the event/job envelope's designated authoritative fields, inside the job's own transaction (§5) |
| Context leaking between tenants on a pooled connection | `SET LOCAL` resets at transaction end, on commit **and** rollback (§3a, `DATABASE.md` §14a); proven against a real pool on both paths (`TESTING.md` §6h) |
| Supplying a `workspace_id`/`team_id` that contradicts the resolved context | One declarative cross-check, `AdvisoryTenantGuard`, refusing with `403` before the handler runs (§2b, ADR-004 D-3) |
| Widening a WebSocket connection's scope after connect | **DEFERRED** — no gateway exists (§4b) |
| Replaying a WebSocket ticket | Short-lived and hash-stored at issuance (implemented); single-use enforcement **DEFERRED** with the gateway (§4b) |

## 7a. Hostname is branding input, never tenancy input (normative)

**A request's hostname may select branding. It may never select tenancy or authorization.**

Custom domains are coming — `resellers.domain` already exists and is uniquely indexed — and the rule has to be frozen before any resolver is built, because the wrong version of it is the obvious one:

- **Permitted**: resolving `portal.reseller.example` to a reseller's `brand_config` for the purpose of rendering a login page, logo, palette or product name. Presentation only.
- **Forbidden**: treating the host as evidence of *which tenant the caller belongs to*, or of *what the caller may do*. Arriving at `customer.example.com` grants nothing.

The authenticated principal and §2a's resolution chain remain the only source of tenant context, exactly as §2b already says of every other client-supplied identifier. A hostname is a client-supplied identifier with better marketing: it is trivially forgeable by anything that is not a browser, it is chosen by whoever controls DNS rather than by ACC, and a deployment behind a proxy sees whatever `Host` the proxy forwards. Anything that made it authoritative would be an authorization input the credential chain never validated.

The practical consequence for the eventual implementation: the branding resolver runs **before** authentication and returns presentation data only; the tenancy chain runs after, ignores the host entirely, and a mismatch between the two is not an error — a user of Organization A signing in through Reseller B's branded domain is simply an unusual-looking session, not an escalation. If branding ever needs to be restricted by tenant, that restriction is an authorization decision made after the principal resolves, not a routing decision made before it.

## 7. Open decisions

Tracked in `DECISIONS.md`: physical per-tenant log isolation for regulated/enterprise customers; dedicated Kafka topics/partitions for high-volume tenants; whether `workspace_id` should be mandatory (vs. optional) on every tenant-scoped table — which, if resolved in favour of mandatory, would also let RLS enforce the workspace boundary that §3a currently places in the authorization layer.
