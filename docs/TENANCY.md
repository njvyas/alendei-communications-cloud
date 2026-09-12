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

## 2. Tenant context resolution

Tenant context is a server-derived triple `{org_id, workspace_id?, reseller_id?}` (workspace/reseller optional depending on the call). It is resolved exactly once per request, immediately after authentication, from:

- A validated JWT's claims (for user sessions), or
- An API key's bound tenant scope (`api_keys.org_id`), or
- An OAuth2 client credential's bound scope.

**Rule**: any `org_id`/`workspace_id`/`tenant_id` appearing in a URL path, query string, or request body is advisory only. The server always re-derives the authoritative tenant context from the auth layer and rejects (`403`) any request where a client-supplied identifier does not match — it never "trusts and proceeds" and never silently substitutes the correct value.

## 3. Isolation by layer

| Layer | Mechanism | Notes |
|---|---|---|
| API | Middleware resolves and attaches `TenantContext` before any handler runs; NestJS guards reject missing/mismatched context | Applies uniformly; no handler opts out |
| Database | PostgreSQL Row-Level Security (RLS) policies on every tenant-scoped table, keyed on `current_setting('app.current_org_id')` (and workspace where applicable), set via `SET LOCAL` inside the request's transaction | RLS is defense-in-depth *under* application-layer filtering, not instead of it |
| Cache | Redis keys always namespaced `t:{org_id}:{...}`; a shared key builder utility is the only sanctioned way to construct a Redis key | Prevents ad-hoc unnamespaced key bugs |
| Queues | Kafka message keys/headers include `tenant_id`; consumers assert expected tenant scope for the topic they own (some topics are intentionally cross-tenant, e.g. provider health, and are documented as such) | Large tenants may later get dedicated topics/partitions (capacity-driven decision, see `DECISIONS.md`) |
| Object storage | Keys prefixed `{org_id}/{workspace_id}/{domain}/...`; bucket policy/IAM conditions enforce prefix match where the storage backend supports it | MinIO in dev enforces this at the application layer only |
| Search | Every OpenSearch document includes `tenant_id`; query builder injects a mandatory `term` filter — there is no code path that issues a tenant-unfiltered query against tenant data indices | Index-per-tenant vs. shared-index-with-filter is a scale-driven decision, see `DECISIONS.md` |
| Analytics/logs | Every structured log line and analytics fact row carries `tenant_id`, `correlation_id` | Physical separation is not assumed by default |

## 4. Reseller & white-label scoping

A reseller admin's auth context resolves to `{reseller_id}` with implicit access to all `organizations` beneath it; this is enforced the same way org-level access is enforced (RLS + API guard), not via a separate code path. White-label configuration (branding, domain, allowed sender identities) lives on `workspaces`/`organizations` and is resolved at request time by host/domain or by the authenticated reseller context — see `ARCHITECTURE.md` §16.

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

## 6. Open decisions

Tracked in `DECISIONS.md`: physical per-tenant log isolation for regulated/enterprise customers; dedicated Kafka topics/partitions for high-volume tenants; whether `workspace_id` should be mandatory (vs. optional) on every tenant-scoped table for simpler RLS policies.
