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
- `users` authenticate at the platform level (one user identity) but are granted access via `user_roles` scoped to one or more `(organization | workspace | team)` — see `RBAC.md`.

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

## 1b. Deletion and retention of tenancy rows (normative)

**A tenancy row that has audit or financial history is never hard-deleted. It is deactivated and retained.** Every level of the hierarchy already carries the status column this requires: `resellers.status`, `organizations.status` (`active|suspended|closed`), `workspaces.status` (`active|archived`), and `users.status` (`active|invited|disabled`). Closing an organization means `status='closed'`, not a `DELETE`.

This is enforced, not merely intended. Foreign keys into tenancy rows are `ON DELETE RESTRICT` from `workspaces`, `teams`, `api_keys`, `ws_tickets` and — as of Phase 1B — `audit_logs`. An organization with audit history fails a `DELETE` with a plain foreign-key violation naming `audit_logs`.

`ON DELETE SET NULL` is specifically **not** used from `audit_logs`, and the reasoning generalizes to any future append-only table (ADR-002):

- It would mutate audit history as a side effect of deleting an unrelated row, silently destroying the tenancy attribution of past events — a row that recorded "this happened in Organization A" would quietly become "this happened at platform level".
- On an append-only table it does not even work: the cascade performs an internal UPDATE, which the append-only trigger refuses, so the delete fails anyway — but with a confusing `insufficient_privilege` error from a trigger instead of a clear foreign-key violation.

Hard deletion of tenancy rows remains available to the schema owner for development fixtures and for a genuine erasure request (`DECISIONS.md` D8), and in both cases it is an explicit, owner-level operation rather than something the application can do.

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
| `is_platform_admin` | true if and only if the scope set contains a `platform` grant |
| `reseller_id` | a `reseller` grant's `scope_id`; otherwise the `reseller_id` of the resolved organization |
| `org_id` | an `organization` grant's `scope_id`; or the owning organization of a `workspace`/`team` grant; or, for an API key, `api_keys.org_id` |
| `workspace_id` | a `workspace` grant's `scope_id`, or the owning workspace of a `team` grant; `NULL` when the principal's grants are organization-level or above |

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
| Database | PostgreSQL Row-Level Security (RLS) policies on every tenant-scoped table, keyed on `current_setting('app.current_org_id')` (and workspace/reseller where applicable), set via `SET LOCAL` inside the request's transaction — see §3a | RLS is defense-in-depth *under* application-layer filtering, not instead of it |
| Cache | Redis keys always namespaced `t:{org_id}:{...}`; a shared key builder utility is the only sanctioned way to construct a Redis key | Prevents ad-hoc unnamespaced key bugs |
| Queues | Kafka message keys/headers include `tenant_id`; consumers assert expected tenant scope for the topic they own (some topics are intentionally cross-tenant, e.g. provider health, and are documented as such) | Large tenants may later get dedicated topics/partitions (capacity-driven decision, see `DECISIONS.md`) |
| Object storage | Keys prefixed `{org_id}/{workspace_id}/{domain}/...`; bucket policy/IAM conditions enforce prefix match where the storage backend supports it | MinIO in dev enforces this at the application layer only |
| Search | Every OpenSearch document includes `tenant_id`; query builder injects a mandatory `term` filter — there is no code path that issues a tenant-unfiltered query against tenant data indices | Index-per-tenant vs. shared-index-with-filter is a scale-driven decision, see `DECISIONS.md` |
| Analytics/logs | Every structured log line and analytics fact row carries `tenant_id`, `correlation_id` | Physical separation is not assumed by default |

### 3a. How scope maps onto PostgreSQL RLS

RLS enforces the **tenancy** dimension of the scope model. It is the boundary that still holds when application filtering is wrong, missing, or bypassed.

**Session variables** — all transaction-local, written with `set_config(..., is_local => true)`, never a connection-level `SET` (`DATABASE.md` §14a):

| Variable | Set from | Meaning when empty |
|---|---|---|
| `app.current_org_id` | resolved `TenantContext.org_id` | no organization in context — org-scoped rows are invisible |
| `app.current_workspace_id` | resolved `TenantContext.workspace_id` | no workspace narrowing applied |
| `app.current_reseller_id` | resolved `TenantContext.reseller_id` | not acting in a reseller capacity |
| `app.current_user_id` | the verified principal's `user_id` | not a human-user request |
| `app.is_platform_admin` | `'on'` only when the scope set contains a `platform` grant | not a platform admin |
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

**Dividing line, stated once and normative for every module:** the database guarantees **organization-level tenant isolation** and nothing finer. Any narrower visibility — workspace, team, or per-resource — is a **mandatory authorization-layer requirement**, enforced by the RBAC/ABAC check in the request path (`RBAC.md` §2, `API.md` §3a) on every read and every write, for API responses, enumerations, exports and reports alike. It is **never** satisfied by UI filtering, by a client-supplied predicate, or by a query that merely happens to include a `workspace_id`: those are presentation and convenience, not boundaries, and a caller that bypasses the client reaches the unfiltered organization-level view. A workspace-scoped audit row is therefore visible to any principal the authorization layer admits to that organization's audit trail, and restricting it to the workspace is that layer's obligation to enforce, not an optional refinement.

**Scope levels are enforced at different layers, and each layer is load-bearing:**

| Boundary | Enforced by | Holds if the application layer is wrong? |
|---|---|---|
| platform vs. tenant | RLS (`app.is_platform_admin`) + API guard | Yes |
| reseller vs. reseller | RLS (`app_org_reseller`) + API guard | Yes |
| organization vs. organization | RLS (`org_id`) + API guard | **Yes — this is the hard tenant boundary** |
| workspace vs. workspace | API guard + query predicate | No — application-layer only |
| team vs. team | API guard + query predicate | No — application-layer only |
| role-grant scope integrity | `fn_validate_user_role_scope` trigger + service pre-check | **Yes — the trigger is a hard boundary** |
| platform permission on a tenant role | `fn_validate_role_permission` trigger | **Yes** |

**The running application holds no principal that can bypass RLS.** Migrations and seeding run as the schema owner; the API connects only as non-owner roles (`DATABASE.md` §2).

## 4. Reseller & white-label scoping

A reseller admin's auth context resolves to `{reseller_id}` with implicit access to all `organizations` beneath it; this is enforced the same way org-level access is enforced (RLS + API guard), not via a separate code path. White-label configuration (branding, domain, allowed sender identities) lives on `workspaces`/`organizations` and is resolved at request time by host/domain or by the authenticated reseller context — see `ARCHITECTURE.md` §16.

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

Three properties follow, and each is tested independently:

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
| Widening a WebSocket connection's scope after connect | Scope is fixed by the ticket; subscriptions outside it are refused (§4b) |
| Replaying a WebSocket ticket | Single-use, short-lived, hash-stored (§4b) |

## 7. Open decisions

Tracked in `DECISIONS.md`: physical per-tenant log isolation for regulated/enterprise customers; dedicated Kafka topics/partitions for high-volume tenants; whether `workspace_id` should be mandatory (vs. optional) on every tenant-scoped table — which, if resolved in favour of mandatory, would also let RLS enforce the workspace boundary that §3a currently places in the authorization layer.
