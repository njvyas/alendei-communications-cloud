# Security Architecture

No certification (SOC 2, ISO 27001) is claimed anywhere in this document or by this platform merely because a control is implemented. Statements below describe *alignment with control objectives*, not audited/certified compliance status. Where a regulatory detail is inferred rather than confirmed from a current, dated source, it is flagged and verified with a qualified professional before acting.

## 1. Identity & access

- **Identity types**: human user, API key (service account), OAuth2 client, and system (background worker) are treated as distinct identity classes with independent authorization checks — never collapsed into one "authenticated caller" concept. Full definition: `API.md` §3.
- **MFA**: **not implemented, and not in Phase 1B** (ADR-003 D-6). TOTP is the intended mechanism and `users.mfa_enabled`/`users.mfa_secret_ref` reserve schema space, but no library, configuration, table, enrolment flow or login branching exists, and no organization-level enforcement policy column is present. Treat this as a planned control, not a shipped one; `RBAC.md` §5 records the phase decision.
- **SSO/SAML/OIDC**: architecturally reserved; implementation phase not yet committed (`DECISIONS.md` D6). Note that the per-organization IdP configuration column is **not** currently present on `organizations` — it is deferred with the feature rather than pre-created.
- **Scope model**: the canonical five-level hierarchy — `platform → reseller → organization → workspace → team` — is defined normatively in `TENANCY.md` §1a. Scope inheritance is downward only; no grant is ever widened by the scope it is exercised at.
- **RBAC/ABAC**: `RBAC.md`, including scope-integrity enforcement (`RBAC.md` §6) preventing a role grant from ever pointing at a scope outside its own organization, and the escalation guards in `RBAC.md` §7 — several of which are enforced by database trigger, so they hold even if the service layer is bypassed.
- **Database principals**: the running application connects only as non-owner roles that cannot bypass RLS (`DATABASE.md` §2a). The schema owner is used for migrations and seeding, never to serve a request.
- **Session revocation takes effect immediately, not at token expiry**: `AuthGuard` re-reads the session from PostgreSQL on every request, so a revoked session, a rotated session or a disabled user is refused with the token still cryptographically valid. There is deliberately no second session-state model in Redis — PostgreSQL remains the correctness boundary.
- **Session management**: short-lived JWT access tokens carrying identity and session claims only — never tenancy, roles or permissions (ADR-003 D-3) — plus server-revocable refresh tokens via `sessions`, per-device visibility (`GET /auth/sessions`), and "sign out this device" (`POST /auth/logout`, `DELETE /auth/sessions/:id`). Since Phase 1C.2: "sign out my other devices" (`POST /auth/sessions/revoke-all`, keeps the current session), administrator revocation under ADR-012 F-9, a per-user cap with oldest-first eviction, logout by refresh cookie when the access token has expired, and revocation by **rotation chain** so a refresh can never outlive a revocation (details in the Phase 1C table below). Disabling a user revokes all of that user's sessions. Revocation takes effect on the next request even for an already-issued access token, because `AuthGuard` re-reads the session every request. The browser receives its refresh token as an `httpOnly` cookie, never as JavaScript-readable JSON (ADR-003 D-7, `API.md` §3b).
- **API authentication**: hashed API keys (never stored or returned in plaintext after creation), permanently bound to one organization, and carrying an effective permission set that is the intersection of the key's requested scopes, the permissions its creator holds, and those valid for the operation — re-evaluated at use, so a key never outlives the authority that produced it (`RBAC.md` §5c).
- **WebSocket authentication**: never a long-lived JWT in the connection URL — a single-use, short-lived ticket minted over an authenticated HTTP call (`POST /ws/ticket`, implemented, `API.md` §10). **Consumption at connect time, the socket gateway and subscription authorization are DEFERRED** (`DECISIONS.md` D15): no gateway exists, so nothing yet consumes a ticket, enforces single use, or checks a revoked session against an outstanding ticket.
- **Background worker/job identity**: workers never present an HTTP credential; their authorization boundary is that they only ever act within a tenant context derived from a trusted, already-authenticated source (the job/event payload's designated authoritative field), never from arbitrary payload data — full rule: `TENANCY.md` §5.
- **Privileged provider/routing operations**: adding, testing, enabling/disabling, draining, re-prioritizing, or migrating a provider — and activating a routing/fallback policy version — are gated behind `providers.manage`/`providers.test_send`-class permissions and are audit-logged without exception, since they can redirect real traffic or (once real providers are connected) incur real cost. Full detail: `PROVIDER_ADAPTER.md` §4. **Phase 2 (ADR-013):** platform scope only, `providers.read`/`providers.manage`/`providers.test_send` held by `alendei_super_admin` only; controls in §3b.

## 2. Data protection

| Control | Approach |
|---|---|
| Encryption in transit | TLS 1.2+ everywhere (client↔API, service↔service, service↔DB/cache/broker); no plaintext internal traffic even inside the cluster |
| Encryption at rest | Postgres volume encryption (backend-provided, e.g. cloud-managed disk encryption or LUKS on-prem); S3-compatible storage server-side encryption; Redis persistence disabled or encrypted-at-rest where enabled |
| Secrets management | Provider credentials, DB credentials, signing keys never live in application config/env dumps in plaintext at rest — see §3 |
| PII masking | Contact PII fields (`contacts`, `contact_identities`, message `recipient`/`content`) flagged at the schema level; structured logs redact/mask these fields by default, full values require an explicit, audited "reveal" action |
| Provider credential encryption | Credentials stored via `credential_ref` pointer (`DATABASE.md` §3); actual secret material lives only in the secrets backend, fetched at call time, never persisted in application DB rows |

## 2a. Tenant-context controls

| Control | Approach |
|---|---|
| Tenant context is derived, never asserted | Resolved once per request from the verified credential and current `user_roles` state; no token claim carries tenancy (ADR-003 D-3, `TENANCY.md` §2a) |
| Context is transaction-local | Established with `SET LOCAL` inside the request's own transaction, so it resets at transaction end on commit **and** rollback. A connection-level `SET` is never used, and a pooled connection therefore cannot carry one tenant's context into another's work — proven against a real pool on both the commit and the fault-injected error path (`TESTING.md` §6h) |
| Client-supplied tenant identifiers are cross-checked | One declarative mechanism, `AdvisoryTenantGuard`, running after authentication and before the handler. A contradiction is `403 TENANCY_CONTEXT_MISMATCH`; a repeated, structured, malformed or empty identifier is `400 VALIDATION_FAILED`. Never substituted, never silently emptied, never resolved by parameter order (`TENANCY.md` §2b, ADR-004 D-3/D-4) |
| Organization selection cannot confer access | `X-Acc-Organization` selects among organizations already in scope; one outside scope is refused, not substituted (ADR-003 D-4) |
| Below organization level, the application is the only boundary | RLS carries no workspace or team term (`TENANCY.md` §3a), so target-scope authorization through `PermissionEvaluator` is mandatory on every scoped operation (`RBAC.md` §2, ADR-003 D-5) |
| Authorization decisions are made per coherent grant | A decision is allowed only when **one** grant supplies both the permission and the covering scope (`RBAC.md` §2, ADR-005 D-1). Every allow therefore names the grant that authorized it, which is what makes a decision explainable rather than merely monotonic — and what stops a permission conferred at a workspace being honoured at the organization above it |
| A target's ancestry is read from the database | `ScopeChainResolver` derives the `ScopeChain` a coverage decision rests on from the rows themselves, inside the request's own tenant transaction. `AuthorizationService` exposes no parameter through which a chain could be supplied, so a forged `organization_id` or `reseller_id` has nowhere to enter — it is unrepresentable rather than filtered (ADR-005 D-5, Phase 1B.5.2) |
| Visibility and coverage are decided separately | A target must both be visible in the request's tenant transaction (RLS) and be covered by a coherent grant (the evaluator). Failing the first is a `404` that confirms nothing about existence; failing the second is a `403`. Collapsing the two would turn an isolation boundary into an existence oracle (`API.md` §3a) |

## 3. Secrets management

Abstracted behind a `SecretsPort` so the backend is swappable across environments/clouds: HashiCorp Vault (self-hosted/private cloud), AWS Secrets Manager + KMS, Azure Key Vault, GCP Secret Manager. Application code never reads a raw secret from environment variables in production — env vars hold only the *reference* (e.g. a Vault path or ARN), resolved at startup/call-time with short-lived caching. Secret rotation is a first-class operation (`provider_credentials.rotated_at`), and rotation must not require a redeploy for provider-scoped secrets (consistent with `PROVIDER_ADAPTER.md` §4).

The same `SecretsPort` backs `webhook_endpoints.signing_secret_ref` (`DATABASE.md` §12) — an outbound webhook signing secret is shown to the customer exactly once at creation/rotation time and is never again retrievable in plaintext via the API; ACC's own outbound dispatcher resolves it server-side at delivery time, identically to how a provider credential is resolved at send time.


### 3a. Tenant-scoped secrets are references, never values (normative)

Frozen by ADR-009 D-4. Two planes, and the boundary between them is not negotiable for convenience:

| Secret | Plane | Where it lives |
|---|---|---|
| Database, Redis, broker, object-storage credentials | **Deployment** | Secrets backend, referenced from configuration |
| JWT signing secret, cookie/CSRF secrets, encryption keys | **Deployment** | Secrets backend (`AUTH_JWT_SECRET_REF`) |
| Provider credentials, webhook signing secrets, tenant encryption material | **Tenant row holding a reference** | `<backend>:<locator>` on the tenant-scoped row; the value never enters PostgreSQL |

The precedent is already in the schema and should be followed rather than re-argued: `users.mfa_secret_ref` is documented as *"Pointer into the secrets backend — never the TOTP seed"*, and `api_keys.key_hash` stores an Argon2id digest rather than a key. Configuration holds references of the form `<backend>:<locator>` and never values, which is what lets a dedicated or on-prem deployment substitute a different backend with no application change.

**`provider_credentials` is not implemented, and its ownership model is NOT FROZEN (ADR-013 PD-2, F-1).** `DEPLOYMENT.md` §0f described it as tenant-scoped, a scope within the existing hierarchy, `org_id` for RLS, and a `credential_ref`; `DATABASE.md` §3 / `PROVIDER_ADAPTER.md` §4a described a platform/reseller/organization configuration scope with a NULL platform `scope_id`. The two cannot both hold, and neither is adopted until the channel-phase ADR that builds the table; no hybrid is defined. **Binding now** (both agreed): the value is a `credential_ref` resolved through `SecretsPort`, never the credential; the secret never enters PostgreSQL, logs, metrics, audit rows, API responses or any frontend; a shared deployment must be able to hold Alendei-owned, reseller-owned and organization-owned credentials side by side, under database-enforced isolation. **Credential architecture requires a separate reviewed decision (its own ADR) before implementation**; Phase 2.5 records these requirements as documentation only — no port, type or code (ADR-013 PD-2).

### 3b. Phase 2 security controls (ADR-013 — frozen; the 2.1 controls IMPLEMENTED, Gate D.1 pending review)

The rows below are the Phase 2 requirements. Those that govern the registry — layered model, global-catalogue RLS, grants and denials, coverage containment, audit, no secret persistence, adapter binding — are **implemented by 2.1** (migration `0018`, `apps/api/src/providers/`, proven by `provider-registry.sec-spec.ts`); test-send and hot reload arrive with 2.2 and 2.4. Three 2.1 implementation facts the table does not state (Gate D.1 remediation, migration `0019`):

- **Writes and their audit records use one predicate.** Catalogue writes (`INSERT`/`UPDATE` on `providers`; `INSERT`/`UPDATE`/`DELETE` on `provider_capabilities`) and provider audit rows (`audit_logs_provider_insert`) require `app_has_platform_permission('providers.manage')` — an active user holding a platform-scope grant whose role carries the permission. Reads require platform scope only. No predicate names a role; a second platform role holding `providers.manage` performs every write with its audit row inserted, and `alendei_support` cannot write even with the service bypassed.
- **Refusals are audited through the ordinary mechanism.** A platform-scope principal without the permission (`alendei_support`, with or without `X-Acc-Organization`) is refused with an `authorization.denied` row at `platform` scope, admitted by `audit_logs_platform_self_denial_insert` only for the actor's own denial.
- **One refusal remains unaudited, by necessity.** A principal with no organization in context, no reseller grant and no platform-scope grant (a member of several organizations calling without `X-Acc-Organization`) has no scope a denial can be filed under; it cannot hold a platform permission, and the path only refuses. It answers `403`, logged at `warn` with the correlation id; naming an organization makes the refusal audited.

| Control | Requirement |
|---|---|
| Layered model (ADR-013 F-3) | Authenticated principal → validated permission (`providers.read`/`providers.manage`/`providers.test_send`, `AuthorizationService.assert`) → platform-scope target `{ scopeType: 'platform', scopeId: null }` inside the request's `TenantDatabase.withTenant` transaction → RLS platform-scope eligibility. No layer depends on a role name. No organization, workspace, team, reseller or white-label provider administration |
| Global-catalogue RLS | `channels`, `providers`, `provider_capabilities`, `provider_health` have no tenant column, so tenant RLS does not apply. RLS is enabled with `acc_app` policies: reads admit only a transaction with a **validated platform-scope claim** (an active platform-scope grant, validated against current grants); writes admit only a user whose platform-scope grant carries `providers.manage` (migration `0019`) — the predicate `AuthorizationService` enforces and that also admits the provider audit row. No predicate names a role. The role-name-bound `app_is_platform_admin()` (ADR-011's "platform administrator" definition, unchanged for its existing uses) is deliberately not the predicate; 2.1 introduces a reviewed role-name-independent primitive. `acc_auth`/`acc_relay` hold no grant; `provider_health` is append-only (trigger, every principal) and its `INSERT` is bound to the permission of the operation that observed it (a `submission` sample to `providers.test_send`, a `probe` or `override` sample to `providers.manage`, migration `0022`). Proven with the service bypassed (`DATABASE.md` §3) |
| Circuit policy (**implemented, Gate D.3 remediation**) | One platform-wide policy (`provider_circuit_policy`, migration `0023`). `GET`/`PUT /provider-circuit-policy` require `providers.manage` at platform scope; tenant, reseller, API-key, support, `test_send`-only and read-only principals are refused (`403`) and, with the service bypassed, update zero rows; nobody can insert or delete a policy row. Every bound is checked by the API and by database `CHECK`s; the version advances by exactly one per change (trigger, every principal); updates are optimistic (`expectedVersion`) on top of a row lock; every change writes `provider.circuit_policy_updated` in its own transaction under an exact-shape audit policy. No new SECURITY DEFINER function |
| Health and circuit (**implemented, Phase 2.3**) | The health check and the manual override require `providers.manage`, the sample history `providers.read`, all at platform scope; no route sets the circuit — it moves only through test-send samples and the clock (`PROVIDER_ADAPTER.md` §5–§6). Because test-send writes observation state, `providers.test_send` may `UPDATE` a provider at the database, but the `SECURITY INVOKER` guard trigger confines it to the health and circuit columns: administrative columns and the manual override need `providers.manage`, and the circuit can move only along its four edges, one generation at a time, for every application principal. Every state change is written under the provider row lock with its sample and its `provider.health_changed` / `provider.circuit_changed` row in one transaction; the health check re-reads the actor's authority before writing, as test-send does. No new SECURITY DEFINER function; no tenant, API key, reseller or support principal can reach any of it (proven) |
| Current grants and explicit denials | The three permissions are attached only to the seeded `alendei_super_admin` role — today's grant, not the boundary. Denied in Phase 2: `alendei_support` (RLS-eligible to read through its platform-scope grant; refused by `AuthorizationService` because it holds no `providers.*` permission — an audited `403` at platform scope — and refused by the database for any write); API keys (organization-bound, never platform-scoped — refused and RLS-ineligible); `acc_auth`/`acc_relay` (no grant). No support-role permission is added. A future privileged role is added through normal RBAC changes (platform role definition and permission attachment by migration, D22) with no RLS redesign |
| Coverage containment | Every new mutating route is inside the Gate C pre-commit authorization-coverage boundary (`RBAC.md` §2a) |
| Audit | Every mutation and state transition is security-sensitive and audited in the same transaction at scope `platform` (ADR-013 F-4); no credential, secret reference value or test-send payload body is recorded |
| No secret persistence | No Phase 2 table, column, log field, metric label, audit row or response carries a credential or secret value; `provider_credentials` does not exist; `SimulatorAdapter` uses no credential (`INVALID_CREDENTIALS` is simulated); no credential type, port or resolution code exists — 2.5 is documentation only, and credential architecture requires a separate reviewed ADR before implementation |
| Test-send (**implemented, Phase 2.2**) | `providers.test_send` at platform scope — a separate permission from `providers.manage`, proven both ways; explicit single target (the path's provider); refused for a `disabled` or `draining` provider (`409`) and for an unregistered catalogue adapter key (`422`), in both cases before any submission is attempted; the adapter comes from the provider's catalogue row through the code registry, never from input; the caller chooses only the simulator behaviour — adapter, provider, recipient, content and credential fields are refused (`400`); synthetic payload; persists no message; rate-limited by the general limiter. Authorization runs before the adapter in one transaction and again before the audit write in a second, so no transaction is held open across the submission. `provider.test_sent` is admitted by `audit_logs_provider_test_send_insert` (migrations `0020`, `0021`) under `app_has_platform_permission('providers.test_send')` — the same predicate model as `0019`, no new function — with outcome `success` (the provider accepted) or `failure` (it rejected), never `denied`. The second transaction re-reads the actor's authority from the database before writing, so a grant revoked or a user disabled while the submission ran ends with `403` and no audit row; the row's actor is always the requester (ADR-013 2.2 notes (f), (h)). Against the simulator only — a real-provider test-send is out of scope and requires separate authorization (`PROVIDER_ADAPTER.md` §4) |
| Hot reload | Best-effort configuration invalidation with bounded convergence, not transactional propagation: commit, then publish; subscribers evict on receipt; the TTL bounds staleness if a publication is lost. A security-relevant change (disable, drain) can therefore be honoured by another instance up to one TTL late if its publication is lost — accepted for Phase 2 (simulator only, no real traffic) and recorded as a residual in ADR-013 |
| Adapter binding | `adapter_key` must name an adapter registered in code (`simulator` only); unknown keys are refused, and no code branches on vendor names |


## 4. Audit architecture

`audit_logs` (see `DATABASE.md` §12) is append-only and captures actor, actor scope, action, resource, outcome, before/after state, correlation id, causation id, and timestamp for every privileged mutation across every module — not just security-relevant actions. A refused action is recorded as deliberately as a successful one: `outcome='denied'` exists precisely so that a rejected privilege escalation leaves a record (`RBAC.md` §7).

The scope an action occurred at is recorded on the canonical five-level hierarchy (`TENANCY.md` §1a) — `platform`, `reseller`, `organization`, `workspace` or `team` — and the tenancy columns backing it are **derived by the database** from the scope the writer names, never trusted from the writer. ADR-002 (`DECISIONS.md` §1b) is the full decision record.

**Who may read an audit record is enforced at two layers, and both are mandatory.** Row-Level Security guarantees **organization-level tenant isolation**: no principal reaches another organization's audit trail — including a sibling organization under the same reseller, which the Gate-B remediation (ADR-011) closed after the audit found it reachable — and platform-scoped records require a platform administrator. RLS deliberately stops there (`TENANCY.md` §3a). Finer visibility — restricting a workspace- or team-scoped record to principals holding a grant at that workspace or team — is a **required RBAC/ABAC authorization check in the request path**, applied to every audit read including list endpoints, exports and reports. It is **never** delivered by UI filtering or by a client-supplied query predicate: the console is not a security boundary, and a caller reaching the API directly sees whatever the authorization layer permits, not whatever the console chose to display. Treating workspace/team audit visibility as a presentation detail would be a security defect, not a cosmetic one.

The set classified as security-sensitive is `SECURITY_SENSITIVE_AUDIT_ACTIONS` in `packages/contracts/src/audit.ts` — role grants, credential changes, session revocations, user disablement, and (from Phase 7) billing adjustments.

**Write synchronization — Phase 1B (ADR-003 D-2).** All audit writes are **synchronous**. For a security-sensitive mutation the audit row is written **in the same database transaction as the business mutation**: if the audit insert fails, the business mutation rolls back. That is what makes "a role grant cannot succeed without leaving a record" a guarantee rather than an intention. Non-sensitive actions are written synchronously too, for a plain reason — Phase 1 has no outbox or queue, so there is no asynchronous transport to write to, and inventing a fire-and-forget path would silently lose records while appearing to satisfy the design.

The security-sensitive **classification is retained and used** even though both branches are currently synchronous, because it is what the outbox switches on (attributed here to Phase 2; **not Phase 2 scope** per ADR-013 PD-1 — it arrives with the first phase that needs it): when the transactional outbox arrives, non-sensitive writes move to the queued path and sensitive writes stay in-transaction. The classification is therefore live today as a routing decision, not a placeholder.

**Refused authorization (ADR-005 D-6).** Every refusal by the authorization layer writes an `authorization.denied` record. The field that matters most is the scope:

| Field | Value |
|---|---|
| `scope_type` / `scope_id` | **The actor's own resolved, legitimate scope** — never the scope it attempted to reach |
| `actor_type` / `actor_user_id` / `actor_api_key_id` | From the verified principal. Never fabricated |
| `resource_type` / `resource_id` | The attempted target |
| `metadata` | `{ permission, attempted_scope_type, attempted_scope_id }` |
| `outcome` | `denied` |

An attacker-supplied target must never become the record of where the actor legitimately was: the derived tenancy columns are what a later query filters on, so recording an attempted scope as the actor's scope would file the record under a tenant the actor was never in. The attempted target belongs in metadata, where it is operator context rather than a tenancy claim.

The record is written **synchronously, in its own transaction, and committed before the refusal is raised** (Phase 1B.5.3). The separate transaction is not a convenience: the refusal is thrown out of the caller's own transaction, which rolls it back — a record written there would be discarded every single time, and the control would report nothing while appearing to work. Committing separately is what makes the record exist.

The consequence is deliberate. The record **survives a later rollback of the surrounding request**, because the attempt happened and whether the request went on to fail for some other reason does not unmake it.

**Fail closed.** The audit failure is never caught and converted into an ordinary refusal: if the record cannot be written, that failure propagates instead of the `403`, the request still does not proceed, and the operator sees why in the logs. The requester sees a generic `500` carrying only a correlation id — the audit failure is observable to the operator, opaque to the caller (`API.md` §7). `authorization.denied` is classified security-sensitive for the same reason every other privilege event is.

**Only an attempted operation is recorded.** A target that never resolved is a `404` and writes nothing: no authorizable target was established, so there is nothing to deny — and auditing it would make the trail an existence oracle for anyone who can read it. The non-throwing capability probe used for listings and UI affordances writes nothing either; it asks a hypothetical, and recording it would put a row behind every rendered button.

### Role administration (Phase 1B.5.4)

Role administration composes privilege, so every mutation is security-sensitive and every one is audited inside its own transaction: `role.created`, `role.updated` and `role.deleted` already sit in `SECURITY_SENSITIVE_AUDIT_ACTIONS`, so an audit failure rolls the role change back with it.

Three properties are worth stating because each is enforced at two layers, and the second layer is what holds when the first is bypassed:

- **Composition never exceeds the actor's own authority.** A role may carry only permissions the actor itself holds at that organization, asked one at a time through `AuthorizationService` — never against `principal.permissions`, which ADR-005 removed from the decision path precisely so a permission held at a narrower scope cannot authorize composition at a wider one. Without this guard, `roles.create` is a universal escalation primitive: compose a role carrying anything, have it granted later.
- **System roles are untouchable by a tenant.** Service layer for the `403`; `fn_protect_system_roles` and `fn_protect_system_role_permissions` (migration `0004`) for the control. Both admit only a transaction declaring `app.is_platform_admin` or `app.provisioning`, neither of which an application principal can set.
- **Deletion is never a silent mass revocation.** `409` while grants exist, and `ON DELETE RESTRICT` underneath it, so each revocation stays an explicit, individually audited act (ADR-005 D-8).

A platform permission still cannot reach a tenant role: `fn_validate_role_permission` has refused that since migration `0000`, and the service refuses it first so the caller sees a `403` rather than a constraint error.

### Role assignment (Phase 1B.5.5)

`POST /role-assignments` is the highest-risk endpoint in Phase 1B: it is the API that confers privilege, so a gap is not a bug in one feature but a general escalation primitive. Four properties are worth stating plainly.

**Authorization is checked at the scope being granted at, not the actor's context.** That single substitution is what makes `RBAC.md` §7's non-escalation rule enforceable — an organization admin naming another organization's workspace is refused, and refused with `404`, so the endpoint does not confirm that the workspace exists.

**Composition authority is coherent-grant, and the suite proves it is.** Every permission the role carries must be held by the actor *at that scope*, asked through `AuthorizationService.unheldPermissions`. The case that separates this from the flattened union is asserted directly: an actor holding `role_assignments.grant` across the organization and `teams.create` in one workspace has `teams.create` in `principal.permissions`, and still may not confer it at the organization — only in the workspace where one coherent grant carries it. Replacing the check with `principal.permissions.includes(...)` fails the suite.

**A tenant principal cannot manufacture platform privilege.** Platform roles (`roles.org_id IS NULL`) are refused at this surface outright, and `platform` is not a representable scope type in the request DTO at all — the refusal does not depend on a guard remembering to run.

**The database remains the correctness boundary for every race.** Duplicate grants are settled by `user_roles`' partial unique indexes rather than by a check-then-insert; a grant racing its role's deletion is settled by the foreign key's row lock against `ON DELETE RESTRICT`, so no grant can survive whose role is gone; concurrent revocations are settled by the conditional delete's row lock. None of these rest on application-level ordering.

**Deliberately absent:** the last-platform-admin invariant on revocation. It is Phase 1B.5.6's, with the advisory-lock trigger that makes it hold under concurrency (ADR-005 D-7). A service-only count would look like an invariant while losing under write skew, which is worse than not having one.

### The last-platform-admin invariant (Phase 1B.5.6)

> At every committed state there exists at least one user with `status = 'active'` holding a grant at `platform` scope.

A platform with no administrator is unrecoverable through the API: nothing left can appoint one, and the only way back is the bootstrap CLI run by whoever holds database credentials. That is why this is a correctness invariant enforced in the database rather than a validation in a handler.

**It is enforced where it cannot be bypassed.** `fn_assert_platform_admin_remains` (migration `0005`) sits on `user_roles` DELETE and `users` UPDATE OF `status`, so it holds against the API, against a direct `acc_app` statement, against the cascade from deleting a user, and against a migration script or admin tool. `RoleAssignmentService` keeps its own check purely so the caller receives `409 AUTHZ_LAST_PLATFORM_ADMIN` rather than a `restrict_violation` rendered as a generic `500`.

**Concurrency is the whole difficulty.** An application count is write-skew-prone — two transactions each counting two administrators, each removing a different one, both committing. The function takes `pg_advisory_xact_lock` on a single key exported from `@acc/db` before counting, which serialises exactly the mutators of this invariant and releases on commit *and* rollback. The suite proves the property with six concurrent cases, and every one of them asserts the **final database state**, not the status codes: an invariant that returns the right errors while reaching a forbidden state has failed.

**No bypass exists.** A tenant principal cannot see a platform grant at all — RLS hides it — and an API key is bounded by its binding scope, so neither can reach the mutation. `acc_app` holds neither superuser nor `BYPASSRLS`, and the suite asserts both.

**"Platform administrator" has one definition** (ADR-011): an active holder of `alendei_super_admin` at `platform` scope. The liveness invariant, `app_is_platform_admin()` and `TenantContext.isPlatformAdmin` all use it. `alendei_support` is platform-scoped but read-only and does **not** count — before migration `0010` any platform-scope grant set the RLS flag, which gave the support role unrestricted read *and write* reach in the database and the trigger-level authority to grant platform roles. Removal of a grant by `UPDATE` (changing its scope, user or role) is guarded as well as removal by `DELETE`.

### Route authorization coverage (Phase 1B.5.7)

Every registered route declares its posture — `@Public()`, `@RequiresPermission`, or `@AuthorizationExempt` with a reason — and §6n case 30 asserts that against the container's own route table. A route that declares nothing fails the suite the moment it is registered, so an endpoint cannot ship unprotected by omission. The count recorded at Phase 1B.5.7 was 23 routes; the table has grown since (36 at the Gate-B audit), and the assertion is against the live table, not a number.

`@RequiresPermission` is a declaration, not the enforcement, and the reason is ADR-005 D-5: the chain a decision rests on must be read inside the request's own tenant transaction, which does not exist when a guard runs. A guard that authorized would split the decision and the mutation across two transactions and leave a window between them. Enforcement stays in `AuthorizationService.assert` inside the handler's transaction, before the mutation; `AuthorizationCoverageInterceptor` cross-checks at runtime that the declared permission was actually asked for, suppressing the response when it was not, and `TenantDatabase` repeats the check before a writing tenant transaction commits, so an unchecked mutation rolls back with its success audit row instead of committing behind a `500`. `RBAC.md` §2a states exactly what that buys for reads versus mutations, and its limits: it is containment of a missing check, not an authorization decision.

### Self-only authorization introspection (Phase 1B.5.7)

`GET /auth/me/authorization` returns the caller's own grants **as grants**, never flattened. A console cannot render a correct permissions UI from a union, and handing it one is how the defect ADR-005 removed from the backend gets reinvented in the client: an actor holding `teams.create` in one workspace and `role_assignments.grant` across the organization must be able to tell from the response that it cannot confer the former at the latter. Each entry carries the scope its permissions are held at, and the response contains no union at all.

**Self-only structurally, not by check.** The subject is the authenticated principal and there is nowhere to name anyone else — no path segment, no query parameter, no body. A cross-user variant would be an enumeration surface with no Phase 1B consumer (`DECISIONS.md` D23), and the way to not build one is to leave nowhere to put the identifier. The suite tries a path variant, a query parameter and a body field, and none changes the subject.

It discloses nothing the caller could not already derive by attempting each operation, and no credential material. For an API-key principal the grants are the key's *effective* authority — the Phase 1B.5.1 binding-scope intersection — so a permission its creator holds only elsewhere never appears.

### List conventions (Phase 1B.5.8)

Three properties of the pagination and filtering conventions carry security weight rather than being formatting.

**No caller input reaches SQL as an identifier.** Sort fields and filters are allow-listed per endpoint — a client names a key the endpoint publishes, which is bound to a column in code. There is no operator syntax, no column names and no expression language, so order-by and filter injection are not defended against so much as unrepresentable. The suite tries `key; DROP TABLE roles`, `(SELECT 1)` and `key ASC, id DESC` among others; all are `400`.

**Cursors are integrity-protected.** A cursor is a query continuation, and an editable one is a client-supplied predicate wearing the costume of server state. It is signed with an HMAC keyed from the application signing secret and domain-separated from every other use of it. This is defence in depth, not the isolation boundary — the tenant predicate and RLS bound what any cursor could reach — but treating a cursor as opaque only works if it actually is. A cursor minted under one sort is refused for another, because silently resuming a changed ordering skips or repeats rows.

**A filter narrows; it never widens.** Filters apply inside what the tenant predicate and RLS already allow, so a caller naming another organization's key gets an empty page rather than a row. An unknown parameter is **refused** rather than ignored: ignoring it is how a caller comes to believe a filter applied when it did not, which for a security-relevant filter is a silent widening.

One consequence worth recording: applying a query DTO to `GET /tenants/workspaces` means a bracketed parameter such as `orgId[]=` is now a `400` where it was previously ignored. The security property is unchanged and strictly stronger — before, the smuggled value had no effect; now the request carrying it does not execute (`API.md` §9a).

### Idempotency is never an authorization bypass (Phase 1B.5.9)

The way HTTP idempotency fails is not "a duplicate slips through" — it is "a previously successful request becomes a credential". Three properties prevent that, and each is asserted directly (ADR-006).

**A replay is authorized before anything stored is disclosed.** The stored record is read inside the same tenant transaction as the current request, *after* that request has authenticated and had the endpoint's own target-scope check run against it — the same `assertMay…` method the fresh path calls, not a second copy. An actor that has since lost its grant gets its refusal, not the old response.

**A refused request stores nothing.** Only successes are recorded, so a denial leaves no record to replay, and the `authorization.denied` audit row is still written exactly as Phase 1B.5.3 requires. Idempotency cannot suppress a required denial audit because it never reaches the point of storing one.

**A key belongs to one principal in one organization.** The resolved principal's identity is part of the request fingerprint — its credential never is — so another actor presenting the key computes a different fingerprint and is refused as a payload mismatch, learning neither that a record exists nor what it contains. The organization is enforced twice over: in the unique index and by the table's RLS policy, which hides another tenant's record from the service's own query.

The refusal deliberately discloses nothing: not the stored body, not the original actor, and not the fingerprint — which would say precisely what to change to make a key match someone else's request.

The error **response** carries `403 AUTHZ_SCOPE_DENIED` and echoes no target — the identifier appears in the audit row and in operator logs, never to the caller (`API.md` §3a).

Successful authorization checks are **not** audited. The operation is — `role.created`, `user_role.granted` and the rest. One row per check per request would bury the records that carry forensic value, so this is a deliberate rejection rather than an omission.

**Unknown-user authentication failures (ADR-003 R4).** A login attempt for an address matching no user still produces an audit record. It is never omitted, and a fictitious `actor_user_id` is never invented:

| Field | Known user | Unknown identity |
|---|---|---|
| `action` | `auth.login.failed` | `auth.login.failed` |
| `actor_type` | `user` | `system` |
| `actor_user_id` | the real user id | `NULL` |
| `actor_label` | — | `anonymous_login_attempt` |
| `scope_type` | `platform` | `platform` |
| `outcome` | `failure` | `failure` |

The `acc_auth` database policy permits the system-actor form for this **exact** case only — `action = 'auth.login.failed'` together with `actor_label = 'anonymous_login_attempt'`. It is not opened to arbitrary system-actor writes, because a role that could write any `system` row could fabricate a record of automated action it never took.

> **Implementation status: implemented.** Migration `0002` replaced `audit_logs_auth_insert` to admit exactly this form, and `AuthService` writes it for every unknown-address failure (`iam-session.int-spec.ts`, `auth.sec-spec.ts`).

**Redaction is the writer's responsibility.** The database does not and cannot inspect `before`/`after`/`metadata` for credential material, so a single centralized redactor strips it before any insert — recursively through nested objects and arrays, covering `password`, `password_hash`, `key_hash`, `refresh_token_hash`, `mfa_secret_ref`, `ticket_hash`, and any key matching `/secret|token/i` (§2). An audit row must never be the place a credential leaks.

### User lifecycle administration (Phase 1B.6.1)

The `/users` surface is the first API that reads the table holding every Argon2id digest on the platform, and the first that can revoke a person's access. Six properties carry that, and each is asserted directly.

**No credential material leaves the database.** Every read goes through one column projection — `id`, `email`, `phone`, `status`, `lastLoginAt`, `createdAt`, `updatedAt` — written once so that no query can select `password_hash` or `mfa_secret_ref` by accident; a bare `select()` on `users` would return both. `passwordUpdatedAt` and `mfaEnabled` are withheld as unnecessary security metadata, the second additionally because MFA is not implemented and publishing the flag would imply a shipped control (`RBAC.md` §5). Creation accepts no password, returns no password and mints no temporary credential: a created user is `invited`, which by `users_active_requires_credential` is precisely the state that cannot authenticate. The audit rows carry lifecycle state and counts only, and still pass through the central redactor.

**Membership is constructed, because the table has no tenant column.** `users` is platform-level and its tenancy is entirely the grants it holds, so every endpoint narrows to *users holding at least one grant in the request's organization*, with `users_select` RLS beneath it. The two are not redundant: RLS admits any user reachable through **any** organization in scope, so for a reseller administrator it is a wider set than the organization the request actually selected. A list that quietly widened with the reader's other memberships would be a cross-tenant disclosure that passes every RLS test.

**A hidden user stays hidden.** A user in another tenant, a user with no grant in this organization, and an id that was never issued are one `404` with one message and no echo of the identifier. The one place this is imperfect is stated rather than hidden: `users_email_key` is a **global** unique index, so creating a user with an address already registered anywhere on the platform is a `409`. That is inherent to a single identity namespace — the alternative is per-tenant identities, which would mean one person holding several — and what leaks is the existence of an address and nothing about who holds it or where. The message names no organization, no user and no status.

**Lifecycle is not authorization.** `PATCH /users/:id` reaches exactly one column, `phone`. `status`, `email`, roles, scopes and every credential column are absent from the DTO rather than rejected by a check, and the global pipe's `forbidNonWhitelisted` makes naming one a `400` — so there is no path by which a role change could arrive as a profile edit. Role assignment remains owned by `RoleAssignmentService`, including the initial grant at creation, which runs through `grant()` with its five guards; only guard 5's reachability *probe* is relaxed, for a user the same transaction created, and that relaxation is unreachable from any request shape (ADR-007 D-4).

**A disabled user is locked out at their next request, not at token expiry.** `AuthGuard` re-reads the user on every request and refuses a non-active one; that is the guarantee, and it holds even when the status is changed by something that never touched this API. The disable endpoint additionally revokes every live session through the existing `SessionService`, in the same transaction, so the stored state agrees with it — two controls, no second invalidation mechanism, and no token store anywhere. **API keys are covered too**: the creator-authority intersection is recomputed per request, and a key whose creator is no longer active now resolves to no permissions at all. Without that, disabling an administrator would leave every key they minted working, which is the exact outcome disabling is for.

**Disable is global to the identity, and the audit trail is not.** Both halves are deliberate and both are stated because the second is easy to miss. `users.status` and `sessions` are platform-level — neither carries an organization column — so disabling a user ends that person's access to *every* organization they belong to, under any reseller, and revokes every session they hold. Since the Phase 1C.2 remediation (ADR-012 F-9 applied to disable), the actor must therefore hold `users.disable` covering **every** grant the target holds — not merely in one organization the target belongs to; otherwise `403 AUTHZ_SCOPE_DENIED`, audited. That is the single-identity model doing what it says: one person is one account, and account state is shared by everyone who shares the account. The narrower operation exists and is separate — revoking the user's grants in one organization (`RBAC.md` §8b) — and `API.md` §3d and `FRONTEND_API_CONTRACT.md` §30d both require a console to distinguish them rather than presenting disable as a local removal.

The audit consequence is an asymmetry rather than a loss. The `user.disabled` record is written at the **acting** organization's scope, because that is where the actor legitimately was, and ADR-005 D-6 is explicit that a record must never be filed against a tenant the actor was not in. So an organization whose user is disabled by another organization's administrator has no audit row of its own for the event. No compensating record is synthesized: one would attribute an action to administrators who did not perform it, and `fn_validate_audit_scope` derives a row's tenancy from the scope its writer names, so there is no honest scope to file it under. **The limitation is recorded here and revisited when the audit read surface ships in Phase 1B.6.3**, which is the first phase in which an affected organization could read such a record at all. Nothing about audit architecture is changed for it now.

**The platform-admin liveness invariant reaches the new path unchanged.** Disabling the last active platform administrator is `409 AUTHZ_LAST_PLATFORM_ADMIN`, and `trg_users_platform_admin_liveness` (migration `0005`) is the authority beneath it — the `AFTER UPDATE OF status` trigger written for exactly this transition, which until now had no HTTP surface. The service takes the same advisory lock first for ADR-005 D-7's lock ordering and translates a lost race's `restrict_violation` into the same `409`; it does not replace the invariant with an application count, and the concurrency suite asserts the final database state rather than the responses.

### API-key administration (Phase 1B.6.2)

The surface that mints credentials. Six properties carry it, and the first is the one the phase was designed around.

**The plaintext secret exists in memory, for one response, and nowhere else — including the idempotency snapshot.** This is ADR-008. `IdempotencyService` persists a handler's response body verbatim into `idempotency_keys.response_snapshot`, a plaintext `jsonb` column whose rows are never physically deleted (`DATABASE.md` §7.1) — so the obvious implementation would have written every API-key secret into the database, permanently, and would have invalidated the stated basis on which §3 accepted that non-deletion ("only reclaiming space"). Instead the work closure returns the envelope with `secret: null`, that envelope is what is stored and replayed, and the real plaintext is merged into the HTTP response only on a fresh execution. `IdempotencyService` is unmodified: the field is kept out at the call site, so role, role-assignment and user creation are untouched. A replay therefore returns `secret: null`, and if the creation response is lost the credential is unrecoverable — the remedy is revoke and recreate, which is cheap and audited.

**The dataflow is asserted statically, not only behaviourally.** A behavioural test shows the secret is absent from the places it currently looks; only a structural assertion shows there is no path by which it could arrive. `minted.secret` occurs exactly twice in the service — the Argon2id hash and the return value — the audit payload for `api_key.created` is checked as a block for any mention of a secret or digest, `IdempotencyService` is asserted to contain no knowledge of secrets at all, and `mintApiKey` is asserted to have exactly one caller.

**Only the hash is stored, and no read path can return it.** The secret is 43 base62 characters (~256 bits) from a CSPRNG with the modulo bias removed by rejection sampling — measured by test, because a 1.6% skew toward the head of the alphabet would never fail a format check. `key_hash` is Argon2id under the same parameters as passwords, and every read goes through one projection that omits it: a bare `select()` on `api_keys` returns the digest, and the only reliable defence is never to write such a query.

**Authority is intersected, never inherited.** A key's effective permissions are its requested `scopes` ∩ what its creator holds **at the key's binding scope**, recomputed per request (ADR-005 D-4). Creation refuses a key that asks for more than the creator holds there, so `scopes` can never be a way to confer what the creator lacks. A key created by another key is refused outright: `created_by` references `users`, and a creator-less key confers nothing, so allowing it would produce a credential that authenticates and can do nothing.

**Lifecycle is derived where it can be and terminal where it matters.** There is no status column and no sweeper: `expired` is computed from `expires_at` at read and, independently, by the authentication query's own filter — so a key stops working when it expires whether or not anything has looked at it. Revocation is a conditional write (`WHERE revoked_at IS NULL`), so two concurrent revocations produce exactly one winner rather than two successes, and it is terminal — no un-revoke, no rotation, no deletion.

**Revocation and detail authorize against the key's stored binding scope, never the caller's.** Read from the row, so an actor that can see a key listed at the organization still cannot revoke one bound to a workspace it does not cover. Authorizing against a caller-supplied scope is the single mutation this surface most needed to be proof against, and it is asserted both behaviourally and structurally.

### Audit read, and the reseller-context distinction (Phase 1B.6.3)

The audit trail is the record of who did what, so a read surface over it is worth more to an attacker than much of the data it describes: it names administrators, enumerates privilege changes, and through `correlation_id` expands one observation into the whole causal fan-out of a request. Two boundaries hold it, and they are independent — `audit_logs_select` decides which rows exist for the transaction, and `AuthorizationService.assert` decides whether the caller may read an audit trail at all, and for a single record, at the scope that record was written at.

**History — superseded by ADR-011.** When this section was written, `ScopeResolver.tenantContextFor` populated `TenantContext.resellerId` for **every** principal from the selected organization's reseller, so an ordinary organization administrator had a non-null `resellerId` and `app_current_reseller_id()` returned it. Phase 1B.6.3 found one consequence (below) and corrected only that surface. The Gate-B security audit found the general one: `app_org_in_scope()` admits every organization beneath `app_current_reseller_id()`, so **every table it guards was readable across sibling organizations sharing a reseller**, and the workspace, API-key, role-assignment and audit lists — which carried no tenant predicate of their own — would have enumerated them. See "Shared-reseller isolation" below for the fix.

`audit_logs_select`'s third arm admits a reseller row when `reseller_id = app_current_reseller_id()`. Its intent, stated in migration `0001`, is that reseller rows belong to the reseller context — but because the session variable is broader than reseller-scope authority, RLS alone showed an organization administrator its own reseller's audit trail. The detail route was never affected: it authorizes at the row's recorded `{reseller, scope_id}`, and an organization-scope grant cannot cover it, because nothing in the model reaches upward. The list had no per-row equivalent, so the two surfaces disagreed about the same row and **the list was the permissive one**.

**The rule, now enforced:** reseller-level audit visibility requires a genuine grant **at** `reseller` scope. `AuditReadService` derives the admissible reseller set from `principal.roles` — the grants themselves — and never from `TenantContext.resellerId`. A platform administrator is exempt, because their policy arm already admits every row and narrowing would remove the platform operations view. An API-key principal holds exactly one synthesized grant at its binding scope, which is organization or workspace and never reseller (§5c), so a key resolves to an empty set and sees no reseller rows — the correct answer for a credential that cannot be bound above an organization.

This is a **visibility** narrowing layered above RLS, not a second authorization model: it decides which rows a page may contain, while `AuthorizationService.assert` remains the authoritative decision for the endpoint and for every record fetched individually. The flattened `principal.permissions` is not consulted, and no caller-supplied identifier reaches it. The invariant it establishes is asserted directly over all five scope levels: **a row appears in the list if and only if the detail route serves it.**

**Superseded.** The narrowing above remains in place, but it is no longer the fix: RLS itself now only honours a genuine reseller claim (ADR-011), so the reseller arm of `audit_logs_select` no longer admits an organization member at all.

### Shared-reseller isolation (Gate-B remediation, ADR-011)

**The rule.** `app.current_reseller_id` is a *claim of reseller authority*. It is set only when the principal holds a grant at `reseller` scope on the reseller that owns the selected organization — never because the selected organization happens to have a reseller. An organization-, workspace- or team-scoped principal therefore carries no reseller claim, and RLS scopes it to its own organization only.

**Two independent layers enforce it.**

1. **Application** — `ScopeResolver.tenantContextFor` derives `resellerId` from the principal's reseller-scope grants only (and `isPlatformAdmin` from an `alendei_super_admin` grant only).
2. **Database** — migration `0010` makes `app_current_reseller_id()` and `app_is_platform_admin()` validate the claim against current grants: for any RLS-bound principal, the reseller claim is honoured only while `app.current_user_id` holds an active reseller-scope grant on that reseller, and the platform flag only while it holds `alendei_super_admin` at platform scope. An unbacked claim resolves to NULL/false — the organization arm still applies, nothing widens. A principal that already bypasses RLS (superuser, `BYPASSRLS`, or the schema owner) is trusted as before, which keeps seeding and first-administrator bootstrap working.

The list endpoints that relied on RLS alone (`GET /tenants/workspaces`, `GET /api-keys`, `GET /role-assignments`) now also carry an explicit predicate for the selected organization, and `GET /tenants/workspaces/:id` is pinned to it, so a reseller administrator acting in one organization is not handed another's rows under a check made for the first.

**Proof.** `packages/db/src/test/shared-reseller.int-spec.ts` (direct PostgreSQL as `acc_app`, every tenant table, reads and writes, plus negative controls that restore the unvalidated accessors and watch the sibling reappear) and `apps/api/test/shared-reseller-isolation.sec-spec.ts` (HTTP lists, direct objects, the enrol-then-disable chain, and resolver-computed contexts applied to `acc_app`). Topology: Reseller A → Org A1, Org A2; Reseller B → Org B1.

**What the validation does not defend against.** `app.current_user_id` is itself a session variable. A principal able to run arbitrary SQL as `acc_app` can set it to a real administrator's id. The validation removes the class of defect found — application logic writing a claim the principal does not hold — and is not a defence against a compromised application role (§4b).

**Personal data in the response.** `ip` and `user_agent` are returned. They are personal data, and they are included deliberately: an audit trail that cannot say where a privilege change originated answers half the question an investigation asks. Access is gated by `audit.read`, an administrative permission, and the payload fields (`before`, `after`, `metadata`) carry whatever the **write-time** redactor left — re-redacting on read would be a second redactor, and two redactors drift.

### General rate limiting (Phase 1B.6.4)

A throttle is only as good as its bucket identity: if a caller can choose which bucket it lands in, it can always find an empty one. So the property that matters is not the counter but where the three key terms come from.

**Every term is server-derived, and the type system says so.** `org_id` and `principal` come from the authenticated `RequestContext` that `AuthGuard` populated from a verified credential — the same resolved context authorization uses, never a header. `endpoint_class` comes from the matched route's metadata: the HTTP method Nest routed on, or an explicit `@RateLimit()` whose parameter is a two-value literal union. `RateLimitSubject` has no field a caller could populate, and the guard reads nothing from the request but its method.

Asserted adversarially rather than assumed: `X-Tenant-ID`, `X-Organization-ID`, `X-Principal-ID`, `X-RateLimit-*` request headers, `X-Endpoint-Class`, a bypass header, and query identifiers are each sent in turn and the counter is observed continuing to descend in the *same* bucket. Forging the class onto a write route is tested separately.

**Isolation across all three dimensions**, each proven with real authenticated identities rather than by inspecting keys: one organization exhausting its bucket does not throttle another; two principals in one organization hold independent budgets; and `read` and `write` are separate buckets, so a write flood cannot exhaust the reads a console depends on. The mutation that removes any one term from the key fails the suite.

**An API key is bucketed by its own key id**, not its creator's, so a key cannot spend its creator's allowance — the same separation the binding scope gives it for authorization (`RBAC.md` §5c).

**The general limiter does not key on IP.** `X-Forwarded-For` therefore cannot influence it at all, which is asserted directly. `TRUSTED_PROXY_HOPS` continues to govern the authentication limiter, which does key on IP and where the trusted-hop count is the control that stops a client choosing its own bucket.

**No request is charged twice.** The general limiter applies only where a principal exists, so public routes — `POST /auth/login`, `POST /auth/refresh`, `/health*`, `/metrics` — pass through it untouched and keep their own arrangements (next section). That is structural rather than an exemption list: with no principal there is no key to build. Probes and scrapers are never throttled.

**Fail open, and tested.** A Redis outage allows the request, logs at `warn` and flags the verdict. Refusing all authenticated traffic because a cache is unreachable converts a degraded dependency into a total outage, and the limiter is a throttle rather than the authentication or authorization control — both of which still run. The mutation that flips this to fail-closed fails the suite.

**Limits are deployment-wide.** One ceiling for every tenant, from `RATE_LIMIT_DEFAULT_*`. There is no per-tenant override, so a noisy tenant is bounded but not individually tunable, and a tenant cannot be granted a larger allowance without changing it for everyone. Recorded as a limitation rather than implied away (ADR-010).

### Unauthenticated-path throttles (Gate-B remediation, ADR-011)

The routes that run before any principal exists are throttled by `AuthRateLimitService`, keyed on the client address (so `TRUSTED_PROXY_HOPS` is the control that decides what "address" means — it now defaults to `0`, and production must set it explicitly):

| Path | Buckets | Default (per `RATE_LIMIT_AUTH_WINDOW_SECONDS`, 60 s) |
|---|---|---|
| `POST /auth/login` | per IP **and** per account (truncated SHA-256 of the address) | 10 (`RATE_LIMIT_AUTH_MAX`) |
| `POST /auth/refresh` | per IP | 30 (`RATE_LIMIT_REFRESH_MAX`) |
| API-key presentation (`Authorization: Bearer ak_…`) | per IP, **failures only**, checked before Argon2 verification | 20 (`RATE_LIMIT_API_KEY_FAILURE_MAX`) |

- **A successful login clears the account bucket only.** It used to clear the IP bucket too, which let one valid account reset the address's allowance between guesses at every other account.
- **API-key failures are counted, not API-key uses,** and the check precedes the Argon2id verification, so a flooding address stops costing hashing work once it is over its allowance while a working integration never spends it. Consequence, accepted: once an address is over the failure allowance, every key from that address — including a valid one — is refused with `429` until the window passes.
- All three fail open on a Redis outage, logged at `warn`, like the other limiters.

Proven over HTTP in `auth-abuse.sec-spec.ts` (each case ends on the `429` only the limiter can produce) and at unit level in `auth-rate-limit.spec.ts`.

### Database principal posture at start-up (Gate-B remediation, ADR-011)

RLS binds a principal only while it is not a superuser, not `BYPASSRLS`, and not the owner (or a member of the owner) of a table — RLS is enabled but deliberately **not forced**, so an owner is exempt. Each of those is configuration that can drift without any application test noticing. `DatabaseModule` therefore calls `assertRlsBoundPrincipal` on both request-serving pools at start-up and **refuses to start** if either principal is a superuser, has `BYPASSRLS`, owns or can act as the owner of any `public` table, or is a member of any other role. The catalog itself is asserted in `principals.int-spec.ts`, including exact per-principal grant maps, no role memberships, no `SET ROLE` path, and negative controls proving that a weakened policy, `BYPASSRLS` or table ownership each re-open the boundary.

### Phase 1C security controls (ADR-012) — organization rows IMPLEMENTED (1C.1a); workspace/team row IMPLEMENTED (1C.1b); session rows IMPLEMENTED and CLOSED (1C.2); database-integrity rows IMPLEMENTED and CLOSED (1C.6, PASS); OpenAPI (1C.3), fixture (1C.4a) and browser E2E (1C.4b) CLOSED; Gate C decision pending

The first two rows and the API half of the third are **implemented (Phase 1C.1a)**, proven by `organization-administration.sec-spec.ts`; the workspace/team row is **implemented (Phase 1C.1b)**, proven by `workspace-team-administration.sec-spec.ts`; the three session rows are **implemented and closed (Phase 1C.2, PASS)**, proven by `session-policy.sec-spec.ts`; everything else is a frozen target. Each row is a Gate C criterion (`ROADMAP.md` §4d).

| Control | Target behaviour | Increment |
|---|---|---|
| Organization status as authorization | Non-platform principals of a `suspended`/`closed` organization are refused on the next request via session, API key and selection; platform principals can still read; no tenant-data mutation in a closed organization. **Not** an RLS predicate (OD-3) — RLS keeps deciding *which* organization; status decides *whether it is usable* | 1C.1a |
| Organization creation authority | Platform, or a reseller administrator beneath its own reseller only; seeding and default workspace in the same transaction | 1C.1a |
| Reseller immutability | `organizations.reseller_id` not changeable through the API (**implemented**: `PATCH` refuses the field with `400`), and refused by a database guard for any writer that is neither a validated platform administrator nor an RLS-bypassing principal (**implemented in 1C.6**: `trg_organizations_guard_reseller_id`, `42501`) | 1C.1a ✅ / 1C.6 ✅ |
| Workspace and team administration | Every route acts in the selected organization; targets read pinned to it, under RLS, with their ancestry from the database; targets not visible to the tenant are `404`, visible-but-not-covered an audited `403`; archived workspaces and teams refuse new teams, grants and API keys; organization status re-checked inside each mutation. Organization remains the RLS boundary; workspace/team isolation inside it is application authorization (ADR-011 D-4), and a widened application check still cannot reach another organization's rows | 1C.1b ✅ |
| Maximum sessions | At `AUTH_MAX_SESSIONS_PER_USER`, the oldest **live** session (not revoked, not rotated, not expired; `created_at` then `id`) is revoked with its rotation chain inside the login transaction, under a per-user `pg_advisory_xact_lock`, each eviction audited as `session.revoked` in that transaction; the new session is never a candidate, and concurrent logins cannot exceed the cap | 1C.2 ✅ |
| Revoke-all and scoped administrator revocation | Self revoke-all keeps the current session's chain and revokes every other; an administrator revokes another user's sessions only with `sessions.revoke` (`sessions.read` to list) covering the selected organization **and every grant the target holds**, the target's complete grant set read from authoritative identity state (never through the administrator's RLS view) and judged by the coherent-grant evaluator; refusals are an audited `403` naming only the target; revoke routes need a signed-in user session. Every revocation is by rotation chain and serialized with refresh under the same per-user lock, so a racing refresh leaves no usable successor | 1C.2 ✅ |
| Logout with an expired access token | Accepted via the refresh cookie **plus** `X-Acc-Refresh` (the CSRF control is unchanged) when no valid bearer is presented; the cookie path is throttled with the refresh bucket; unknown and already-revoked cookies answer `204` with the cookie cleared (no oracle) | 1C.2 ✅ |
| Referential integrity | Composite `(workspace_id, org_id)` FKs on `api_keys`/`ws_tickets`; `allowed_scope_types` enforced by `fn_validate_user_role_scope` for every role (platform included), with narrowing of a role refused while a grant would be stranded (decision §14.1, Option A) and supported at READ COMMITTED, with REPEATABLE READ and SERIALIZABLE narrowing attempts deliberately refused with SQLSTATE `25000`, because the current locking/snapshot design does not safely establish the invariant there (migration `0015`, review H-2); widening remains supported; a verifying backfill aborts migration `0014` on existing bad data; every SECURITY DEFINER trigger function executable by the owner only, so no application principal can call one or attach one to a table of its own (migration `0015` for the three 1C.6 functions, review H-1; migration `0016` for the six older ones, review H-3); each proven with the service bypassed (`database-integrity.sec-spec.ts`) | 1C.6 ✅ |
| OpenAPI UI | **Implemented and closed (1C.3, Gate C.3 PASS / CLOSED; ADR-012 F-13 as amended, G1 option C).** `OPENAPI_UI_ENABLED` enables the capability and is off by default; the production refusal is removed. The UI and an unauthenticated document exist only when `APP_ENV=development` with the flag. Elsewhere the only route is `GET /api/v1/openapi.json`, for a signed-in user session (API key `403`, no credential `401`), through the unchanged `AuthGuard` pipeline, with no UI. Exactly one route produces the document, the UI never embeds it, and no refusal body contains it (`openapi-access.sec-spec.ts`) | 1C.3 ✅ |

**Session audit routing (Phase 1C.2, correcting a Phase 1B defect).** `acc_auth` may write exactly seven audit actions, all at `platform` scope: the five authentication events plus `session.revoked` and `session.revoked_all` (migration `0013`). Those two are the only ones that are also security-sensitive. Database enforcement constrains session revocation audit actions to the approved action/actor/scope boundary (the exact `app_is_auth_audit_action()` allowlist, platform-only scope, the user/api-key actor shape, and append-only `audit_logs`). Coupling the session audit event to the corresponding session mutation is enforced by the application transaction: all implemented application paths perform the mutation and the audit write atomically in the same transaction, an audit failure rolls the mutation back, and `AuditWriter` refuses to write either action without the caller's transaction. PostgreSQL itself does not make an independent session audit row impossible: a holder of the `acc_auth` database credential can technically insert an allowlisted session audit row inside an otherwise-valid `acc_auth` transaction. That is part of the accepted application-principal trust model (the same model under which `acc_auth` can write the pre-existing authentication events and `acc_app` any in-tenant action), and was approved over a database trigger in the 1C.2 review. Every other sensitive, lifecycle, role, key or administrative action remains impossible for `acc_auth` (proven by `session-policy.sec-spec.ts`). Before `0013`, a user's successful `DELETE /auth/sessions/:id` failed with `500` and revoked nothing, because the policy refused its `session.revoked` row. Administrator session revocation is written through `acc_app` at the administrator's organization.

**`users.disable` follows F-9 (Phase 1C.2 remediation).** Disabling an identity now requires `users.disable` covering every grant the target holds, evaluated by the same helper and evaluator as session administration; an uncovered grant is an audited `403` with no status change and no session revoked. **`users.reactivate` follows F-9 too (Phase 1C security remediation).** Reactivation is globally effective — it restores sign-in in every organization the identity belongs to, its authority at every scope it holds a grant, and the effectiveness of every API key it created — so it requires `users.reactivate` covering **every** grant the target holds (ADR-012 F-9 complete-grant coverage, the same shared check as disable). An uncovered grant is a generic `403 AUTHZ_SCOPE_DENIED`, audited as `authorization.denied`, that names no grant, organization or scope — no target grant topology is disclosed — and changes nothing: no status, credential, session or API-key effect. `PATCH /users/:id` (`users.update`) is **not** changed and remains a separate deferred residual: it authorizes at the selected organization but writes `users.phone`, a field of the global identity. It is profile data today and is not used for authentication. **Lifecycle-policy residuals (retained):** an administrator's grants in a suspended or closed organization count as authority for F-9 coverage, and no API path revokes the sessions of a user whose only organization is suspended or closed.

**Phase 1C.2 carried-forward security residuals** (recorded at closure; `DECISIONS.md` ADR-012, "1C.2 closure"):

1. `users.reactivate` checks authorization only in the selected organization but has a global account-wide effect. This remains a Phase 1C security residual and must be reviewed before overall Phase 1C closure. — **Resolved** by the Phase 1C `users.reactivate` remediation: reactivation now requires F-9 complete-grant coverage (see above).
2. Session behavior for members of suspended or closed organizations remains a product/security decision for broader Phase 1C review.
3. API-key principals refused on administrator session-revocation routes do not currently produce an `authorization.denied` audit event. This is a documented residual.
4. `family_id` / session rotation-chain integrity is enforced by the application rather than by a database constraint. This is a documented residual.
5. Coupling between session audit rows and the corresponding session mutation is enforced by the application transaction model rather than by a database trigger/constraint. The accepted trust model and its limits are documented in the session audit routing paragraph above and in `DECISIONS.md`.
6. The F-9 complete-grant check has a concurrency race: a grant created after the grant set is read can be missed. This is permissive rather than conservative: the operation may proceed based on the earlier grant set, potentially disabling/revoking the target slightly earlier than ideal, but it does not grant the administrator additional authority over the newly-created grant.

**Phase 1C security residual identified after the 1C.2 closure** (by the `users.reactivate` remediation; not part of the 1C.2 closure record; `DECISIONS.md` ADR-012, "Phase 1C security remediation — `users.reactivate` under F-9"):

- `PATCH /users/:id` (`users.update`) is **not** changed and remains a separate deferred residual: it authorizes at the selected organization but writes `users.phone`, a field of the global identity. It is profile data today and is not used for authentication.

**SECURITY DEFINER trigger functions and the temporary-table attachment path (Phase 1C.6 security review, H-1, H-3 and H-4) — remediated.** Every principal holds the database `TEMP` privilege, and `CREATE TRIGGER` requires only ownership of the table and `EXECUTE` on the function. So any SECURITY DEFINER trigger function that PUBLIC can execute could be attached by `acc_app`, `acc_auth` or `acc_relay` to a temporary table of its own, and run as the owner (a superuser) on rows of its choosing. All nine SECURITY DEFINER trigger functions are now trigger-only: `{postgres=X/postgres}`, with no `EXECUTE` for PUBLIC or any application principal. Because `EXECUTE` is checked only when a trigger is created, every existing trigger still fires for every writer.

1. **The three functions added or replaced by 1C.6** (`fn_validate_user_role_scope`, `fn_roles_guard_allowed_scope_types`, `fn_organizations_guard_reseller_id`) are fixed by migration `0015` (H-1). Before it, they disclosed another tenant's grant scope types and organization ids, and let the caller hold `FOR SHARE` on any role row.
2. **The six pre-existing functions** are hardened by migration `0016` (H-3). What each exposed through a temporary table before `0016`, probed as `acc_app` with no tenant context:

| Function | Exposure before `0016` | Trigger(s) using it |
|---|---|---|
| `fn_validate_audit_scope` | Rewrote the caller's row with the `org_id`/`workspace_id` of any team or workspace id; confirmed whether any reseller, organization, workspace or team id exists | `trg_audit_logs_validate_scope` |
| `fn_validate_role_permission` | Rewrote the caller's row with the `org_id` of any role id; confirmed whether any role or permission id exists | `trg_role_permissions_validate` |
| `fn_protect_system_role_permissions` | Whether a role id is a system role, and its key | `trg_role_permissions_protect_system` |
| `fn_users_platform_admin_guard` | A weak oracle on whether a user id holds a platform grant | `trg_users_platform_admin_liveness` |
| `fn_user_roles_platform_admin_guard` | Ran the liveness check and its advisory lock (`pg_advisory_xact_lock` is PUBLIC anyway) | `trg_user_roles_platform_admin_liveness`, `trg_user_roles_platform_admin_liveness_update` |
| `fn_protect_system_roles` | Nothing beyond the caller's own rows and validated claims | `trg_roles_protect_system` |

None of them could take a row lock on another tenant's data or perform a privileged write. After `0016`, a direct call and a temporary-table attachment are both `42501` for every application principal, and each trigger's behaviour is proven unchanged through `acc_app` (and `acc_auth` for audit rows) in `database-integrity.sec-spec.ts` group I.

3. **The liveness helper** `fn_assert_platform_admin_remains()` (not a trigger function) is hardened by migration `0017` (H-4), and is now `{postgres=X/postgres}`. Before `0017`, any principal could call it directly (taking the platform-admin advisory lock and learning whether an active platform administrator exists), or reach it through an invoker trigger function of its own. Both are now `42501`. Its two callers are the SECURITY DEFINER liveness trigger functions, which run as the owner; the last-platform-admin invariant is proven unchanged through all three liveness triggers (`database-integrity.sec-spec.ts` group J).

4. **SECURITY DEFINER functions outside the hardened set.** These are separately reviewed security primitives, deliberately left unchanged by 1C.6 and recorded as residuals for review:

| Function | EXECUTE | Notes |
|---|---|---|
| `app_is_platform_admin()`, `app_current_reseller_id()` | PUBLIC and the three application principals | The validated-claim helpers every RLS policy calls, so the RLS-bound principals must be able to execute them (migration `0010`). No arguments; they return false/NULL for an unbacked claim (§4b C/D) |
| `app_session_bypasses_rls()` | The three application principals (not PUBLIC) | Reports whether `session_user` bypasses RLS; no arguments |
| `app_org_reseller(uuid)` | The three application principals (not PUBLIC) | The known bounded disclosure: any organization's reseller id, to a caller that already has the organization id (§4b D) |

**Unchanged by Phase 1C:** the validated-claim model (migration `0010`), organization-level RLS with workspace/team enforced by authorization (ADR-011 D-4), the `acc_app` trust assumption (§4b), and the unauthenticated-path throttles. WebSocket consumption (D15) and credential delivery (D16) remain DEFERRED.

### Phase 1C.4a development/test fixture — IMPLEMENTED and CLOSED (Gate C.4a PASS, 30-Sep-2026)

`npm run fixture:dev --workspace @acc/api` is a development/test operator tool, not an authorization mechanism; full description in `TESTING.md` §6r. It creates tenant objects, users and grants only through the real API as the signed-in bootstrap administrator. Its owner-level writes are two distinct groups, both pinned by a source write-set proof in `dev-fixture.sec-spec.ts` because a schema owner's forgery is indistinguishable in database state (§4a):

- **Existing bootstrap owner exception (ADR-003 D-1, unchanged)** — when no platform administrator exists: platform administrator creation and activation, the `alendei_super_admin` platform grant, and the two bootstrap audit records.
- **Phase 1C.4a fixture owner exceptions (new)** — Reseller B creation (reseller CRUD is Phase 9), and fixture-user activation through the unchanged `UserLifecycleService.activate` for `invited`, credential-less `@acc-fixture.test` identities only. The activation exists solely because D16 has not defined an application credential-establishment path; it is not a D16 decision and adds no route, delivery mechanism or production behaviour.

**Accepted residual (F-3).** The environment gate validates the declared `APP_ENV`/`NODE_ENV`, not the provenance of the database URL. An operator possessing production owner credentials could theoretically point a process declaring development/test at a production database. This is an operational credential/secret-management risk, not a fixture bypass in the application authorization model. There is no override or force flag, `NODE_ENV=production` is refused, the fixture has no HTTP route and is not imported by the application, production use is prohibited, and separating development, test and production database credentials remains an operational requirement.

### Phase 1C.4b frontend E2E corrections and browser security verification — IMPLEMENTED and CLOSED (Gate C.4b PASS, 01-Oct-2026)

The `apps/web/e2e` browser test suite provides full client-side security proofs against the deterministic Phase 1C.4a fixture (`TESTING.md` §6p, §6s; checkpoint `4e7effd`):
- **Exact-secret storage proof (E2E-08)**: Verifies that upon API key creation, the exact plaintext secret string is never persisted to `localStorage`, `sessionStorage`, `document.cookie`, `IndexedDB`, `CacheStorage`, `window.history.state`, or URL query/hash parameters, both during presentation and after modal dismissal.
- **Tenant boundary & header integrity (E2E-10)**: Verifies legitimate dispatch of `X-Acc-Organization` and proves backend refusal (`403 TENANCY_CONTEXT_MISMATCH`) when forged with an unheld organization ID.
- **Low-privilege route gating (E2E-11)**: Proves that low-privilege users (`a1-team-reader`) receive network `403 AUTHZ_SCOPE_DENIED` and explicit UI "Access Forbidden" boundaries with zero audit data disclosure.
- **Safe audit rendering (E2E-09)**: Proves that markup-bearing audit payloads render inertly in `<pre>` blocks with zero executable `<script>` injection and `window.__accFixtureMarkup === undefined`.
- **Exhaustive storage sweep (E2E-12)**: Proves zero token, secret, or dotted JWT leakage across all 8 console routes.

### Dependency exceptions — advisory-ID based (Gate C remediation, `4fb752e`)

`scripts/audit-check.mjs` fails the build on any high or critical advisory that is not accepted, and on any expired exception. **An exception accepts the advisory ids it lists and nothing else**: a package passes only when every advisory npm reports against it is listed by id; a new advisory on an excepted package is reported as `UNREVIEWED` and fails the gate. (Before `4fb752e` an exception matched by package name, so the five current `multer` advisories passed under an entry that had reviewed four different ids.)

The one exception is `multer` 2.2.0, transitive through `@nestjs/platform-express` 11.2.3, reviewed 02-Oct-2026, **expires 31-Oct-2026**:

| Advisory | Severity | Affected | Type | Reachable in `apps/api` |
|---|---|---|---|---|
| GHSA-wc9g-mqfw-jrwm | high (7.5) | `< 2.3.0` | DoS via crafted multipart field names (CWE-248) | no |
| GHSA-qfvm-cv95-jqjf | high (7.5) | `= 2.2.0` | DoS via file-descriptor leak on aborted uploads (CWE-400/459) | no |
| GHSA-535w-7cp7-47q4 | high (7.5) | `< 2.3.0` | DoS via oversized array index in field names (CWE-400) | no |
| GHSA-3pph-fpjx-jg34 | moderate (5.3) | `>= 2.2.0 < 2.4.0` | DoS via orphaned disk writes on aborted uploads (CWE-400/459) | no |
| GHSA-qvfw-j98x-7q72 | low (3.7) | `< 2.3.0` | File-size limit bypass via async `fileFilter` race (CWE-362) | no |

All five are defects of multer's multipart parser, which runs only when a route applies `FileInterceptor`/`FilesInterceptor`/`AnyFilesInterceptor` or registers `MulterModule` or multer middleware. `apps/api` does none of these — there is no multipart route in Phase 1C — and Express's own parsers handle JSON and urlencoded bodies only, so a multipart body is never parsed. **A fix is available**: `@nestjs/platform-express` ≥ 11.2.6 pins `multer` 2.4.0, outside every range above and within the declared `^11.2.3`; the short expiry exists so the upgrade is decided rather than deferred. The four scaffold-era ids previously listed (GHSA-4pg4-qvpc-4u3m, GHSA-g5hg-p3ph-g8qg, GHSA-44fp-w29j-9vj5, GHSA-fjgf-rc76-4x9p) no longer apply to the installed version and were removed.

### 4a. Append-only enforcement, and its threat model

Append-only is enforced in three layers, each covering something the others cannot:

| Layer | Mechanism | Stops |
|---|---|---|
| Privilege | No principal the application connects as (`acc_app`, `acc_auth`, `acc_relay`) holds `UPDATE`, `DELETE` or `TRUNCATE` | Every application code path, including a compromised one |
| Policy | No `UPDATE` or `DELETE` RLS policy exists on the table | A grant added later by mistake — RLS would still admit no row |
| Trigger | `fn_audit_logs_append_only` refuses `UPDATE`, `DELETE` and `TRUNCATE` for **every** principal, the schema owner included | A migration script, an admin tool, or a maintenance job rewriting history by accident |

**What is *not* claimed.** A database trigger is not tamper evidence. The table owner and any superuser can `DROP TRIGGER` or `ALTER TABLE ... DISABLE TRIGGER` and then mutate or delete rows freely; a superuser can also rewrite the table's files directly. This is not an oversight and it is not closed by adding more triggers — any in-database control can be removed by whoever owns the database. The capability is also *used*: it is how retention/archival will eventually prune rows, and how integration-test fixtures are torn down.

The controls that do survive an owner-level adversary live outside this database, and are what the audit trail's integrity actually rests on:

- **Off-box export — DEFERRED, not in force** (explicitly not Phase 2, ADR-013 PD-1). The design projects every `audit_logs` insert to `alendei.audit.action_recorded.v1` for external SIEM export (`EVENTS.md` §4), read by `acc_relay`. **None of it exists yet:** there is no outbox table, no relay process and no event producer, and although `acc_relay` holds `SELECT` on `audit_logs`, no RLS policy targets it, so it reads zero rows (asserted in `principals.int-spec.ts`). Until the relay ships, the audit trail has **no** off-box copy and tamper evidence against an owner-level adversary rests entirely on the infrastructure controls below.
- **Least privilege on the owner role.** The running application never connects as the owner (`DATABASE.md` §2a); owner credentials are operator-held and their use is an infrastructure-level event, not an application one.
- **Infrastructure-level controls** — WAL archiving and point-in-time recovery (`DR.md`), and cloud-provider audit logging of administrative database access — are what detect owner-level tampering.

Anyone strengthening this should target that outer layer (export lag, SIEM alerting on gaps, hash-chaining rows so a deletion is detectable) rather than adding further in-database guards, which would add the appearance of protection without the substance.

### 4b. Residual trust in the application database role — a threat-model assumption

**Assumption, stated precisely: the process holding `acc_app` credentials is trusted infrastructure.** RLS is a backstop against *faulty application code*, not against *a compromised application process*. This is deliberate, and it is measured rather than assumed (`packages/db/src/test/tenant-context-trust.int-spec.ts`, 17 cases, run as the real non-owner, non-`BYPASSRLS` `acc_app`).

**What `acc_app` can do with arbitrary SQL (i.e. if the API process is compromised):**

| Question | Result |
|---|---|
| A. `SET LOCAL app.current_org_id = '<victim>'` | **Yes** — PostgreSQL lets any principal set a custom variable |
| B. …then read the victim's rows | **Yes** — the organization claim is not validated in the database |
| C. Reseller claim | Only by *also* setting `app.current_user_id` to a user who genuinely holds that reseller grant (migration `0010`); an unbacked claim reads as NULL |
| C. Platform claim | Only by also naming a real active `alendei_super_admin`'s user id; unbacked it reads as false |
| C. Workspace claim | Settable and **inert** — no policy or function reads `app.current_workspace_id` |
| C. Team claim | No team variable exists; setting one is accepted by PostgreSQL and read by nothing |
| D. SECURITY DEFINER functions | None sets a variable, runs dynamic SQL, grants or alters anything (asserted by scanning their code, with a positive control); every trigger function refuses a direct call, and the three Phase 1C.6 trigger functions are executable by the owner only, so they cannot be attached to a temporary table either (migration `0015`). so do the six older ones (migration `0016`); no SECURITY DEFINER trigger function is executable by PUBLIC or any application principal, and neither is the liveness helper `fn_assert_platform_admin_remains()` (migration `0017`); the callable helpers return false/NULL for an unbacked claim. One bounded disclosure: `app_org_reseller(org)` returns any organization's reseller id to a caller that already knows the organization id |
| E. `SET ROLE` / `SET SESSION AUTHORIZATION` / `set_config('role', …)` to the owner, `acc_auth` or `acc_relay` | **No** — permission denied (`acc_app` is a member of no role) |
| F. A variable surviving the transaction | A session-level `SET` persists on *that connection* — but every sanctioned transaction writes all six variables first, so it is overwritten (asserted on a single pooled connection); persisting a variable as a role or database default (`ALTER ROLE/DATABASE … SET`) is **denied** |

**Why this is accepted rather than engineered away.** The API process that could be made to issue such SQL also holds, by design: the `acc_auth` credentials (which read every user, session and grant across all tenants), the JWT signing key (which mints a session for any user), and the Redis and configuration secrets. A compromise of that process is a compromise of the platform regardless of what RLS does, so hardening `acc_app` against its own process would buy no containment. The defences for that threat are the ones that keep the process uncompromised: parameterized queries only (§6), no dynamic SQL, least-privilege principals, secrets outside the environment in production (§3), and infrastructure controls.

**Three capability classes, kept distinct:**

1. **The authenticated application, operating normally.** Touches `acc_app` only through `withTenantTransaction`, which writes all six variables from the authenticated principal on every transaction (two construction sites: `withRequestTenant` and the denial-audit writer, both from `RequestContext.principal`). The bare pool is used only for the `SELECT 1` health probe. The reseller and platform claims it writes are additionally validated by the database.
2. **Arbitrary SQL as `acc_app` (compromised process).** The table above: organization context is choosable; reseller/platform context is choosable only with a real holder's user id; no role switch, no persistent default. Accepted, per the assumption.
3. **A normal API caller attempting scope substitution.** Cannot set any variable. The organization is chosen only from the principal's grant-derived list (`X-Acc-Organization` outside it → `403 TENANCY_CONTEXT_MISMATCH`); JWT tenancy claims are never read; advisory identifiers are cross-checked; credentials in query strings are refused; API keys cannot select another organization. Proven in `auth.sec-spec.ts`, `advisory-identifier.sec-spec.ts`, `me-authorization.sec-spec.ts` and `shared-reseller-isolation.sec-spec.ts`.

## 5. Webhook & API hardening

- Signed, verified inbound provider webhooks with replay protection (`ARCHITECTURE.md` §10).
- Signed outbound customer webhooks (`API.md` §6).
- Rate limiting per tenant/key/endpoint class (`API.md` §5).
- Idempotency keys prevent duplicate-side-effect replay attacks as a side benefit of the reliability mechanism (`API.md` §4).

## 6. OWASP Top 10 alignment

| Risk | Mitigation |
|---|---|
| Broken access control / IDOR | Tenant context always server-derived (`TENANCY.md` §2); every resource fetch scoped by resolved `org_id`/RLS, never by client-supplied ID alone. Out-of-scope fetches return `404` without echoing the supplied identifier, and list endpoints omit out-of-scope resources rather than returning `403` — a `403` on a specific id is itself a disclosure that the id exists (`TENANCY.md` §4a) |
| Vertical privilege escalation | Scope inheritance is downward only (`TENANCY.md` §1a.4); the escalation guard table in `RBAC.md` §7 names, per guard, whether the service layer or a database trigger enforces it |
| Horizontal (cross-scope) access | `TENANCY.md` §6 enumerates every prevention mechanism, from client-supplied identifiers through to WebSocket ticket replay |
| Cryptographic failures | TLS everywhere, encryption at rest, secrets never in plaintext config (§§2–3) |
| Injection (SQL, etc.) | ORM/parameterized queries exclusively; no raw string-concatenated SQL; input validation via DTO schemas (class-validator/zod) at every API boundary |
| Insecure design | Threat modeling per module during design review (dev lifecycle §"SECURITY REVIEW" stage, `ROADMAP.md`) |
| Security misconfiguration | Infrastructure-as-code for all environments; no manual prod config drift; secure defaults (deny-by-default RBAC, TLS-required) |
| Vulnerable/outdated components | Automated dependency scanning in CI (`DEPLOYMENT.md` §"CI/CD") |
| Auth failures | Session revocation; rate limiting on login (per IP and per account; a successful login clears only the account bucket), refresh (per IP) and failed API-key presentations (per IP, checked before Argon2 verification); generic error messages (no user enumeration). MFA is **DEFERRED** (§1). |
| Software/data integrity failures | Signed webhooks, signed CI artifacts/images, append-only financial/audit tables |
| Logging/monitoring failures | Structured logs + audit log + full trace correlation (`OBSERVABILITY.md`) |
| SSRF | Outbound webhook targets and any user-supplied URL fetch (e.g. media URLs) validated against an allowlist/deny-private-IP-range policy before the server ever issues the request |
| CSRF | Only `/auth/refresh` and `/auth/logout` accept an ambient (cookie) credential. They require the non-simple `X-Acc-Refresh` header, which forces a CORS preflight the origin allowlist refuses; the refresh cookie is `HttpOnly`, `SameSite=Lax`, path `/api/v1/auth`. Login refuses any non-JSON body (`415`), closing login-CSRF from a cross-site form. There are no CSRF tokens. Bearer-token and API-key calls are not cookie-based. Proven through the real bootstrap in `real-bootstrap.sec-spec.ts`. |
| XSS | React/Next.js default escaping, no `dangerouslySetInnerHTML` on user-supplied content. **CSP on the console app is DEFERRED** (not set by `next.config.ts`); the API sends Helmet's CSP in production only. |
| Privilege escalation | `RBAC.md` §6 |
| Secure file handling | Media uploads validated by content-type/magic-byte, size-limited, stored in S3-compatible storage (never on application hosts), served via signed/expiring URLs, never executed/interpreted |
| Secret leakage | Secrets never logged (structured logger has a redaction list); CI scans for committed secrets pre-merge |

## 7. Regulatory & policy alignment (not legal advice — verify with a qualified professional before acting)

| Framework | Relevance | Approach |
|---|---|---|
| India DPDP Act | Contact PII, consent | `consents`/`suppressions` as first-class, queried on every send; data subject request handling is a Phase-scoped feature (tracked in `ROADMAP.md`), not yet built |
| TRAI / DLT (India SMS) | SMS template/sender registration | Eligibility Engine checks DLT registration status before SMS routing (`ROUTING_ENGINE.md` §2); current DLT rules must be verified against the latest TRAI notification before Phase 3/4 SMS work begins |
| Meta / WhatsApp Business Policy | Template approval, messaging windows, opt-in requirements | `templates.approval_status` models provider approval state; policy-window logic (24-hour session window etc.) is enforced in the Eligibility Engine once WhatsApp adapters are built (Phase 3) |
| GDPR (where applicable to EU contacts) | Lawful basis, right to erasure | Same `consents` model extends to GDPR bases where an org has EU contacts; erasure support is a tracked future requirement, not yet designed in detail |
| OWASP | Application security baseline | §6 above |
| SOC 2 / ISO 27001 | Control objectives (not certification) | This document's controls map to common Trust Services Criteria / Annex A domains; formal certification is a separate business/audit process outside this repository's scope |

## 8. Explicit non-claims

**Known residual disclosure (Phase 1B.6.1).** `POST /users` returns `409` when the address is already registered **anywhere on the platform**, because `users_email_key` is global. A caller with `users.invite` in any organization can therefore learn whether an address has an account, though nothing about who holds it or where. It is accepted rather than mitigated: the alternatives are per-tenant identities, which break single sign-on across organizations, or answering `201` for an address that was not created, which is worse. Revisit if the identity namespace is ever partitioned.

This document does not assert: DPDP/GDPR legal compliance (a legal determination), TRAI/DLT current-rule accuracy (verify against the latest notification), or SOC 2/ISO 27001 certification. Engineering alignment with control objectives is not equivalent to any of the above, and this repository's documentation should never be cited as proof of certification.
