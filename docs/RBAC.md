# RBAC / ABAC & Authentication Architecture

## 1. Model

ACC combines role-based access control (coarse: "what can this kind of user generally do") with attribute-based access control (fine: "can this specific user act on this specific resource").

```
users ──< user_roles >── roles ──< role_permissions >── permissions
```

- `roles`: named bundles (e.g. `org_admin`, `workspace_manager`, `campaign_editor`, `read_only`, `reseller_admin`, `alendei_super_admin`). Roles are tenant-scoped except a small fixed set of platform-level roles.
- `permissions`: fine-grained action grants, named `{domain}.{action}` (e.g. `campaigns.create`, `billing.view_ledger`, `providers.manage`).
- `role_permissions`: many-to-many join, defines what a role can do.
- `user_roles`: assigns a role to a user **at a scope** — `scope_type ∈ {organization, workspace, team}` + `scope_id`. A user can hold different roles at different scopes (e.g. `org_admin` at the org level, plus nothing extra needed at workspace level since org-level roles cascade downward).

## 2. Authorization decision

A request is authorized when:

1. RBAC check passes: the resolved tenant context (`TENANCY.md`) plus the user's `user_roles` yields at least one role whose `role_permissions` include the permission required by the endpoint, at a scope that covers the resource's scope (org-level role covers all workspaces/teams beneath it).
2. ABAC check passes: policy conditions evaluated against resource attributes and request context — e.g. `resource.workspace_id ∈ user.assigned_workspace_ids`, `resource.owner_id == user.id OR user.has(permission, scope=resource.workspace_id)`, business-hour or IP-range conditions for sensitive actions.

Both checks run server-side, after tenant context resolution, never based on client-asserted role/permission claims beyond what's in the signed token/session.

Policy evaluation is designed as pluggable (conceptually OPA/Rego-compatible rule shape) so ABAC rules can be authored/updated without a code deploy in a later phase — the interface is fixed in Phase 0/1; the policy authoring UI is a later-phase deliverable (see `ROADMAP.md`).

## 3. Platform-level roles (fixed, not tenant-configurable)

| Role | Scope | Purpose |
|---|---|---|
| `alendei_super_admin` | platform | Full control plane access: providers, routing, all tenants, billing |
| `alendei_support` | platform | Read + limited write (e.g., audit view, impersonation-with-audit for support) |
| `reseller_admin` | reseller | Manage organizations under a reseller, reseller billing/markup |

## 4. Tenant-configurable roles (seeded defaults, editable)

| Role | Default permissions focus |
|---|---|
| `org_admin` | Full control within the organization: users, workspaces, billing view, API keys |
| `workspace_manager` | Manage a workspace's teams, contacts, templates, campaigns, journeys |
| `campaign_editor` | Create/edit campaigns and journeys, cannot manage billing or users |
| `agent` | Unified inbox access, cannot send campaigns |
| `read_only` | Reporting/audit view only |

Organizations may define additional custom roles by composing existing `permissions`.

## 5. Authentication architecture

| Mechanism | Use case | Notes |
|---|---|---|
| Session (JWT access + refresh) | Web console users | Short-lived access token (minutes), refresh token bound to a `sessions` row for server-side revocation |
| API keys | Server-to-server integration | Stored as salted hash + visible prefix (`ak_live_xxxx...`), scoped to one `org_id` and an explicit permission subset, rotatable, revocable |
| OAuth2 (authorization code + client credentials) | Third-party/partner integrations, future SSO token exchange | Architecture reserved for Phase 6+; not built in Phase 0/1 |
| SSO (SAML / OIDC) | Enterprise organization login | Architecture reserved; per-organization IdP config lives on `organizations`; implementation phase TBD — flagged in `DECISIONS.md` |
| MFA | All human users, enforced by org policy | TOTP at minimum; WebAuthn as a stretch target |

Session/device management: `sessions` records device/IP/user-agent metadata and supports explicit revocation (single session or "all sessions for user"); revoking a session invalidates its refresh token immediately (checked on every refresh, not just at token expiry).

## 6. Scope integrity — `user_roles.scope_id` cannot point cross-tenant

`user_roles.scope_type`/`scope_id` is a polymorphic reference (organization, workspace, or team), which means it cannot be a single physical foreign key. Two independent guards apply, neither sufficient alone:

1. **Database constraint (defense-in-depth, always on)**: a `BEFORE INSERT/UPDATE` trigger on `user_roles` (`fn_validate_user_role_scope`, `DATABASE.md` §2) resolves the target row named by `(scope_type, scope_id)` and verifies its ownership chain traces back to the same organization as the `role` being granted (`roles.org_id`) — directly for `scope_type=organization`, via `workspaces.org_id` for `scope_type=workspace`, via `teams.workspace_id → workspaces.org_id` for `scope_type=team`. A role with `org_id IS NULL` (platform-level, §3) is exempt from this org-match check but is still restricted to being assignable only by an existing platform-level admin (§7 below). The invalid state this specifically prevents:

   ```
   Role belongs to Organization A
   scope_id points to a Workspace belonging to Organization B   ← trigger raises, transaction aborts
   ```

2. **Application-level validation (first line of defense, better error messages)**: the role-assignment service re-derives the same ownership chain from the *actor's own* resolved tenant context before ever attempting the write, rejecting with a clear `403`/`422` — so a well-formed but invalid request never even reaches the trigger in the common case. The trigger exists specifically so that this guarantee holds even if a future code path (a migration script, an internal admin tool, a bug in a different service) bypasses the application-level service layer — the database itself refuses the invalid row regardless of which code wrote it.

Frontend validation is UX-only and never trusted as an authorization boundary for this or any other RBAC rule.

## 7. Privilege escalation guards

- Role/permission assignment endpoints require the actor to already hold every permission being granted (no granting permissions you don't have).
- Cross-tenant role assignment is structurally impossible: `user_roles.scope_id` is validated against the actor's own tenant context at write time (§6).
- Platform-level roles (`alendei_super_admin`, `alendei_support`) can only be assigned by an existing platform-level admin, via a path that is itself audit-logged with no exceptions.

## 8. Related

Full table definitions: `DATABASE.md` §"IAM & RBAC domain". Security controls (encryption, session hardening, audit): `SECURITY.md`.
