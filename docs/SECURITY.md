# Security Architecture

No certification (SOC 2, ISO 27001) is claimed anywhere in this document or by this platform merely because a control is implemented. Statements below describe *alignment with control objectives*, not audited/certified compliance status. Where a regulatory detail is inferred rather than confirmed from a current, dated source, it is flagged and verified with a qualified professional before acting.

## 1. Identity & access

- **Identity types**: human user, API key (service account), OAuth2 client, and system (background worker) are treated as distinct identity classes with independent authorization checks — never collapsed into one "authenticated caller" concept. Full definition: `API.md` §3.
- **MFA**: TOTP required for all human users by default, org-configurable enforcement policy; WebAuthn as a stretch target. Architecture: `RBAC.md` §5.
- **SSO/SAML/OIDC**: per-organization IdP configuration reserved on `organizations`; implementation phase not yet committed (see `DECISIONS.md`).
- **Scope model**: the canonical five-level hierarchy — `platform → reseller → organization → workspace → team` — is defined normatively in `TENANCY.md` §1a. Scope inheritance is downward only; no grant is ever widened by the scope it is exercised at.
- **RBAC/ABAC**: `RBAC.md`, including scope-integrity enforcement (`RBAC.md` §6) preventing a role grant from ever pointing at a scope outside its own organization, and the escalation guards in `RBAC.md` §7 — several of which are enforced by database trigger, so they hold even if the service layer is bypassed.
- **Database principals**: the running application connects only as non-owner roles that cannot bypass RLS (`DATABASE.md` §2a). The schema owner is used for migrations and seeding, never to serve a request.
- **Session management**: short-lived JWT access tokens, server-revocable refresh tokens via `sessions`, per-device visibility, explicit "sign out this device / sign out everywhere."
- **API authentication**: hashed API keys (never stored/returned in plaintext after creation), scoped to org + permission subset, rotatable.
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

`audit_logs` (see `DATABASE.md` §11) is append-only and captures actor, action, resource, before/after state, correlation id, and timestamp for every privileged mutation across every module — not just security-relevant actions. Audit writes are best-effort-synchronous (the triggering request fails if the audit write fails, for actions classified as security-sensitive: role grants, credential changes, billing adjustments) versus best-effort-asynchronous for lower-sensitivity actions, a distinction made explicitly per action type rather than uniformly, to balance integrity against latency.

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
