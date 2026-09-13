# Security Architecture

No certification (SOC 2, ISO 27001) is claimed anywhere in this document or by this platform merely because a control is implemented. Statements below describe *alignment with control objectives*, not audited/certified compliance status. Where a regulatory detail is inferred rather than confirmed from a current, dated source, it is flagged and verified with a qualified professional before acting.

## 1. Identity & access

- **Identity types**: human user, API key (service account), OAuth2 client, and system (background worker) are treated as distinct identity classes with independent authorization checks — never collapsed into one "authenticated caller" concept. Full definition: `API.md` §3.
- **MFA**: **not implemented, and not in Phase 1B** (ADR-003 D-6). TOTP is the intended mechanism and `users.mfa_enabled`/`users.mfa_secret_ref` reserve schema space, but no library, configuration, table, enrolment flow or login branching exists, and no organization-level enforcement policy column is present. Treat this as a planned control, not a shipped one; `RBAC.md` §5 records the phase decision.
- **SSO/SAML/OIDC**: architecturally reserved; implementation phase not yet committed (`DECISIONS.md` D6). Note that the per-organization IdP configuration column is **not** currently present on `organizations` — it is deferred with the feature rather than pre-created.
- **Scope model**: the canonical five-level hierarchy — `platform → reseller → organization → workspace → team` — is defined normatively in `TENANCY.md` §1a. Scope inheritance is downward only; no grant is ever widened by the scope it is exercised at.
- **RBAC/ABAC**: `RBAC.md`, including scope-integrity enforcement (`RBAC.md` §6) preventing a role grant from ever pointing at a scope outside its own organization, and the escalation guards in `RBAC.md` §7 — several of which are enforced by database trigger, so they hold even if the service layer is bypassed.
- **Database principals**: the running application connects only as non-owner roles that cannot bypass RLS (`DATABASE.md` §2a). The schema owner is used for migrations and seeding, never to serve a request.
- **Session management**: short-lived JWT access tokens carrying identity and session claims only — never tenancy, roles or permissions (ADR-003 D-3) — plus server-revocable refresh tokens via `sessions`, per-device visibility, and explicit "sign out this device / sign out everywhere." The browser receives its refresh token as an `httpOnly` cookie, never as JavaScript-readable JSON (ADR-003 D-7, `API.md` §3b).
- **API authentication**: hashed API keys (never stored or returned in plaintext after creation), permanently bound to one organization, and carrying an effective permission set that is the intersection of the key's requested scopes, the permissions its creator holds, and those valid for the operation — re-evaluated at use, so a key never outlives the authority that produced it (`RBAC.md` §5c).
- **WebSocket authentication**: never a long-lived JWT in the connection URL — a single-use, short-lived ticket minted over an authenticated HTTP call and consumed exactly once at connect time (`API.md` §9, `DATABASE.md` §2 `ws_tickets`).
- **Background worker/job identity**: workers never present an HTTP credential; their authorization boundary is that they only ever act within a tenant context derived from a trusted, already-authenticated source (the job/event payload's designated authoritative field), never from arbitrary payload data — full rule: `TENANCY.md` §5.
- **Privileged provider/routing operations**: adding, testing, enabling/disabling, draining, re-prioritizing, or migrating a provider — and activating a routing/fallback policy version — are gated behind `providers.manage`/`providers.test_send`-class permissions and are audit-logged without exception, since they can redirect real traffic or (once real providers are connected) incur real cost. Full detail: `PROVIDER_ADAPTER.md` §4.

## 2. Data protection

| Control | Approach |
|---|---|
| Encryption in transit | TLS 1.2+ everywhere (client↔API, service↔service, service↔DB/cache/broker); no plaintext internal traffic even inside the cluster |
| Encryption at rest | Postgres volume encryption (backend-provided, e.g. cloud-managed disk encryption or LUKS on-prem); S3-compatible storage server-side encryption; Redis persistence disabled or encrypted-at-rest where enabled |
| Secrets management | Provider credentials, DB credentials, signing keys never live in application config/env dumps in plaintext at rest — see §3 |
| PII masking | Contact PII fields (`contacts`, `contact_identities`, message `recipient`/`content`) flagged at the schema level; structured logs redact/mask these fields by default, full values require an explicit, audited "reveal" action |
| Provider credential encryption | Credentials stored via `credential_ref` pointer (`DATABASE.md` §3); actual secret material lives only in the secrets backend, fetched at call time, never persisted in application DB rows |

## 3. Secrets management

Abstracted behind a `SecretsPort` so the backend is swappable across environments/clouds: HashiCorp Vault (self-hosted/private cloud), AWS Secrets Manager + KMS, Azure Key Vault, GCP Secret Manager. Application code never reads a raw secret from environment variables in production — env vars hold only the *reference* (e.g. a Vault path or ARN), resolved at startup/call-time with short-lived caching. Secret rotation is a first-class operation (`provider_credentials.rotated_at`), and rotation must not require a redeploy for provider-scoped secrets (consistent with `PROVIDER_ADAPTER.md` §4).

The same `SecretsPort` backs `webhook_endpoints.signing_secret_ref` (`DATABASE.md` §12) — an outbound webhook signing secret is shown to the customer exactly once at creation/rotation time and is never again retrievable in plaintext via the API; ACC's own outbound dispatcher resolves it server-side at delivery time, identically to how a provider credential is resolved at send time.

## 4. Audit architecture

`audit_logs` (see `DATABASE.md` §12) is append-only and captures actor, actor scope, action, resource, outcome, before/after state, correlation id, causation id, and timestamp for every privileged mutation across every module — not just security-relevant actions. A refused action is recorded as deliberately as a successful one: `outcome='denied'` exists precisely so that a rejected privilege escalation leaves a record (`RBAC.md` §7).

The scope an action occurred at is recorded on the canonical five-level hierarchy (`TENANCY.md` §1a) — `platform`, `reseller`, `organization`, `workspace` or `team` — and the tenancy columns backing it are **derived by the database** from the scope the writer names, never trusted from the writer. ADR-002 (`DECISIONS.md` §1b) is the full decision record.

**Who may read an audit record is enforced at two layers, and both are mandatory.** Row-Level Security guarantees **organization-level tenant isolation**: no principal reaches another organization's audit trail, and platform-scoped records require platform admin. RLS deliberately stops there (`TENANCY.md` §3a). Finer visibility — restricting a workspace- or team-scoped record to principals holding a grant at that workspace or team — is a **required RBAC/ABAC authorization check in the request path**, applied to every audit read including list endpoints, exports and reports. It is **never** delivered by UI filtering or by a client-supplied query predicate: the console is not a security boundary, and a caller reaching the API directly sees whatever the authorization layer permits, not whatever the console chose to display. Treating workspace/team audit visibility as a presentation detail would be a security defect, not a cosmetic one.

The set classified as security-sensitive is `SECURITY_SENSITIVE_AUDIT_ACTIONS` in `packages/contracts/src/audit.ts` — role grants, credential changes, session revocations, user disablement, and (from Phase 7) billing adjustments.

**Write synchronization — Phase 1B (ADR-003 D-2).** All audit writes are **synchronous**. For a security-sensitive mutation the audit row is written **in the same database transaction as the business mutation**: if the audit insert fails, the business mutation rolls back. That is what makes "a role grant cannot succeed without leaving a record" a guarantee rather than an intention. Non-sensitive actions are written synchronously too, for a plain reason — Phase 1 has no outbox or queue, so there is no asynchronous transport to write to, and inventing a fire-and-forget path would silently lose records while appearing to satisfy the design.

The security-sensitive **classification is retained and used** even though both branches are currently synchronous, because it is what Phase 2 switches on: when the transactional outbox arrives, non-sensitive writes move to the queued path and sensitive writes stay in-transaction. The classification is therefore live today as a routing decision, not a placeholder.

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

> **Implementation status.** As of `db6337e` this is specified but **not yet writable**: the `audit_logs_actor_shape` CHECK constraint already accepts the row shape, but the `audit_logs_auth_insert` RLS policy restricts `acc_auth` to `actor_type IN ('user','api_key')` and rejects it. One migration replacing that single policy is required; migration `0001` is committed and is not edited. Until it lands, unknown-email login failures have no audit representation.

**Redaction is the writer's responsibility.** The database does not and cannot inspect `before`/`after`/`metadata` for credential material, so a single centralized redactor strips it before any insert — recursively through nested objects and arrays, covering `password`, `password_hash`, `key_hash`, `refresh_token_hash`, `mfa_secret_ref`, `ticket_hash`, and any key matching `/secret|token/i` (§2). An audit row must never be the place a credential leaks.

### 4a. Append-only enforcement, and its threat model

Append-only is enforced in three layers, each covering something the others cannot:

| Layer | Mechanism | Stops |
|---|---|---|
| Privilege | No principal the application connects as (`acc_app`, `acc_auth`, `acc_relay`) holds `UPDATE`, `DELETE` or `TRUNCATE` | Every application code path, including a compromised one |
| Policy | No `UPDATE` or `DELETE` RLS policy exists on the table | A grant added later by mistake — RLS would still admit no row |
| Trigger | `fn_audit_logs_append_only` refuses `UPDATE`, `DELETE` and `TRUNCATE` for **every** principal, the schema owner included | A migration script, an admin tool, or a maintenance job rewriting history by accident |

**What is *not* claimed.** A database trigger is not tamper evidence. The table owner and any superuser can `DROP TRIGGER` or `ALTER TABLE ... DISABLE TRIGGER` and then mutate or delete rows freely; a superuser can also rewrite the table's files directly. This is not an oversight and it is not closed by adding more triggers — any in-database control can be removed by whoever owns the database. The capability is also *used*: it is how retention/archival will eventually prune rows, and how integration-test fixtures are torn down.

The controls that do survive an owner-level adversary live outside this database, and are what the audit trail's integrity actually rests on:

- **Off-box export.** Every `audit_logs` insert is projected to `alendei.audit.action_recorded.v1` for external SIEM export (`EVENTS.md` §4), read by `acc_relay`. A row deleted from PostgreSQL after export is still in the SIEM.
- **Least privilege on the owner role.** The running application never connects as the owner (`DATABASE.md` §2a); owner credentials are operator-held and their use is an infrastructure-level event, not an application one.
- **Infrastructure-level controls** — WAL archiving and point-in-time recovery (`DR.md`), and cloud-provider audit logging of administrative database access — are what detect owner-level tampering.

Anyone strengthening this should target that outer layer (export lag, SIEM alerting on gaps, hash-chaining rows so a deletion is detectable) rather than adding further in-database guards, which would add the appearance of protection without the substance.

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
| Auth failures | MFA, session revocation, rate-limited login/credential endpoints, generic error messages on auth failure (no user enumeration) |
| Software/data integrity failures | Signed webhooks, signed CI artifacts/images, append-only financial/audit tables |
| Logging/monitoring failures | Structured logs + audit log + full trace correlation (`OBSERVABILITY.md`) |
| SSRF | Outbound webhook targets and any user-supplied URL fetch (e.g. media URLs) validated against an allowlist/deny-private-IP-range policy before the server ever issues the request |
| CSRF | Console (browser) session auth uses SameSite cookies + CSRF tokens on state-changing requests; API-key/bearer-token API calls are not cookie-based and are inherently CSRF-exempt |
| XSS | React/Next.js default escaping, strict CSP headers on the console app, no `dangerouslySetInnerHTML` on user-supplied content |
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

This document does not assert: DPDP/GDPR legal compliance (a legal determination), TRAI/DLT current-rule accuracy (verify against the latest notification), or SOC 2/ISO 27001 certification. Engineering alignment with control objectives is not equivalent to any of the above, and this repository's documentation should never be cited as proof of certification.
