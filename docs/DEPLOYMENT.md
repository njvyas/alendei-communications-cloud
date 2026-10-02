# Deployment Architecture

> **Reading rule.** Every artifact in this document is marked **CURRENT** (it exists in the repository today) or **PLANNED** (it is a design commitment with no artifact yet). An earlier version of this document described Helm charts, Kubernetes manifests, container images and several infrastructure services in the present tense when none of them existed. Where this document and the repository disagree, the repository is right.

## 0. Deployment topology (normative)

### 0a. What a deployment is

**A deployment is one application process set plus the backing services it is configured to use** — its PostgreSQL, Redis, event broker, object storage, search and secrets backend. Nothing else defines it. There is no deployment record in the database and no deployment column on any table (§0c).

A deployment contains **whole tenants**, never fragments of one. The unit of separation is a subtree of the canonical hierarchy (`TENANCY.md` §1a), rooted at one or more resellers.

### 0b. The three supported models

**MODEL A — SHARED MULTI-TENANT SaaS** (the default commercial model)

```
ACC Shared Production
  ├── Alendei Direct            (the seeded platform-default reseller)
  │     ├── Organization A
  │     └── Organization B
  ├── Reseller A
  │     ├── Customer A1
  │     └── Customer A2
  └── Reseller B
        └── Customer B1
```

One deployment, many resellers, many organizations. Isolation is PostgreSQL RLS beneath the authorization boundary — the same enforcement described in `TENANCY.md` §3. **Organizations sharing a reseller are isolated from each other**: before the Gate-B remediation (ADR-011) they were not, because every member's session carried its organization's reseller as an RLS claim; that derivation is removed and the database now validates the claim.

**Operational requirements this model depends on (ADR-011):**

- `DATABASE_URL` / `DATABASE_AUTH_URL` must log in as `acc_app` / `acc_auth`. The API **refuses to start** if either principal is a superuser, has `BYPASSRLS`, owns (or is a member of the owner of) any table, or is a member of any other role.
- `TRUSTED_PROXY_HOPS` defaults to `0` (the socket address is the client address; `X-Forwarded-For` is ignored) and **must be set explicitly in production** to the exact number of reverse proxies in front of the API — over-trusting lets clients choose their own rate-limit bucket.
- The schema owner used for migrations may be a superuser or a managed-PostgreSQL non-superuser; either way it owns the tables and is exempt from RLS (not forced), which is what seeding and bootstrap rely on.

**MODEL B — DEDICATED DEPLOYMENT**

```
ACC Deployment: customer-x
  └── Enterprise X
        ├── Organization X1
        └── Organization X2
```

An independent deployment for one customer or reseller, running the **same images and the same schema**. What differs is configuration: database, Redis, broker, secrets backend, hostnames.

**MODEL C — PRIVATE / ON-PREM**

The same codebase inside customer or private infrastructure. Every backing service is self-hostable (PostgreSQL, Redis, a Kafka-wire broker, S3-compatible storage, OpenSearch), and `SecretsPort` already abstracts the secrets backend, which is usually what blocks on-prem. **PLANNED**: no offline bundle exists.

### 0c. What is common and what is deployment-specific

| Layer | Status |
|---|---|
| Hierarchy, RBAC model, permission catalogue, API contract, migration history, images | **Shared logically** — this is the codebase, identical in every model |
| PostgreSQL, Redis, broker, storage, search | **Deployment-local.** In Model A they are shared *physically* by many tenants under RLS |
| Every secret, endpoint and environment value | **Deployment-local** |
| Resellers, organizations, workspaces, teams, users, roles, grants, API keys, audit, idempotency | **Tenant-scoped rows** inside a deployment |

**One codebase, one core architecture, multiple deployment topologies.** There is no shared-only, white-label-only, enterprise-only or on-prem-only application code, and introducing any would be a regression against this section.

### 0d. White-label is not a deployment boundary (normative)

**A white-label reseller is a tenant, not a deployment.** Shared deployment is the default and supported model for white-label, and the schema already carries what it needs: `resellers.brand_config`, `resellers.domain` (uniquely indexed), `workspaces.brand_config`, `resellers.default_markup_pct`.

White-label is branding, domain, pricing, reseller identity, customer management, feature and provider configuration, and customer-facing presentation — all *inside* the existing hierarchy, all subject to the same isolation. A dedicated deployment is a separate infrastructure decision, taken for commercial or regulatory reasons, and never a prerequisite for white-labelling.

Promotion from shared to dedicated is possible because a reseller's data is a closed subtree: everything under Reseller A is reachable from `resellers.id` through `organizations.reseller_id` and downward. Promotion is therefore an export/import of that subtree, not a schema change. **PLANNED**: no export tooling exists.

### 0e. Deployment identity is operational, not a database concept (normative)

**`deployment_id` must not be added to any tenant or business table, and must not appear in any RLS policy.** The reasoning is recorded in ADR-009, and in short:

- A deployment contains whole tenants, so the hierarchy already provides every reachability such a column would.
- It would create a second isolation axis that every policy, index and future query must carry — and a forgotten predicate would become a new leak class.
- Cross-deployment queries cannot exist: separate deployments have separate databases, so the column could never be the thing that prevents one.

Deployment identity **is** needed operationally, for telemetry from several deployments arriving in one place. It belongs in deployment configuration and flows to logs, traces and operational diagnostics. **PLANNED** — see §0h and `OBSERVABILITY.md`.

### 0f. Secrets, and the provider-credential direction (normative)

**Tenant-scoped secrets are stored as references into the deployment's secrets backend, never as secret values.** The precedent exists: `users.mfa_secret_ref` is a pointer, never the TOTP seed, and `api_keys.key_hash` is an Argon2id digest rather than a key. Configuration likewise holds `<backend>:<locator>` references resolved through `SecretsPort`, never values.

| Secret | Plane |
|---|---|
| Database, Redis, broker, object-storage credentials | Deployment |
| JWT signing secret, cookie/CSRF secrets, encryption keys | Deployment |
| Provider credentials, webhook signing secrets, tenant encryption material | **Tenant row holding a reference** |

**`provider_credentials` — NOT IMPLEMENTED, and the ownership model below is NOT FROZEN (ADR-013 PD-2, F-1, 02-Oct-2026).** This paragraph conflicts with `DATABASE.md` §3 / `PROVIDER_ADAPTER.md` §4a (a platform/reseller/organization configuration scope with a NULL platform `scope_id`); neither model is adopted until the channel-phase ADR that builds the table, and it is not built in Phase 2. The reference-only rule and multi-owner coexistence in one shared deployment remain binding. As previously drafted: when the channel phases build it, it will be a tenant-scoped table carrying a scope within the existing five-level hierarchy, `org_id` for RLS, and a `credential_ref` resolved through `SecretsPort`. The credential value must never be stored in PostgreSQL. This must support Alendei-owned, Reseller-A-owned, Reseller-B-owned and organization-owned credentials coexisting in **one shared deployment**; a dedicated deployment uses a different backend or namespace without any application change.

### 0g. Hostname never determines tenancy

Frozen normatively in `TENANCY.md` §7a: a hostname may select branding and must never select tenancy or authorization.

### 0h. Deployment artifacts — all PLANNED

None of the following exists in the repository today. They are the deployment-artifacts track (`ROADMAP.md`), deliberately out of scope for Phase 1B.6.3:

1. Dockerfile(s) for API and workers · 2. image publication · 3. digest pinning · 4. migration job (pre-upgrade hook) · 5. Helm chart / Kubernetes manifests · 6. per-deployment values files · 7. secret references wired to a real backend · 8. health/readiness wiring (the endpoints exist; the probes do not) · 9. backup/restore automation · 10. rollback automation · 11. shared-deployment promotion pipeline · 12. dedicated-deployment provisioning · 13. private/on-prem bundle.

**Nothing can currently be deployed anywhere**, shared included, until at least items 1–5 exist.

## 1. Environment strategy

| Environment | Purpose | Infra |
|---|---|---|
| Local | Individual developer machine | Docker Compose |
| Dev (shared) | Integration point for `develop` branch | Kubernetes (small), or Compose for lightweight iteration |
| Staging | Pre-production validation, mirrors prod topology | Kubernetes (Helm), production-like data volume (synthetic, never real customer/provider data in Phase 0–2) |
| Production | Live tenants | Kubernetes (Helm), multi-AZ where the target cloud supports it |

Cloud target is portable by design (`ARCHITECTURE.md` §19) — **PLANNED**: the intent is that one set of Helm charts and container images deploys to AWS, Azure, GCP, private cloud or on-prem Linux Kubernetes, differing only in environment-specific values (storage class, ingress class, secrets backend endpoint). The *application's* portability is real and exercised today: it is configured entirely through `env.schema.ts`, has no cloud-specific dependency, and reaches infrastructure through ports. The charts and images themselves do not exist yet (§0h).

## 2. Docker / Compose (development)

**CURRENT.** `docker-compose.yml` brings up exactly: Postgres 17, Redis 7, Redpanda (Kafka-wire broker) with its console, an OTel collector, Prometheus and Grafana.

**PLANNED, and deliberately absent today**: OpenSearch, MinIO (S3-compatible), the application services (API, workers) and the Provider Simulator. The first two have no consumer yet — object storage and search are unimplemented — and the application currently runs on the host against these services rather than inside the compose network. No real provider connectivity is ever part of this stack.

## 3. Kubernetes / Helm (staging, production) — PLANNED

No chart, manifest or image exists yet (§0h). The design below is the commitment, not the current state.

One Helm chart per deployable service (aligned to the module boundaries in `ARCHITECTURE.md` §4, several of which may initially be co-deployed as a single "modular monolith" release and split into independent deployments later without an API change). Helm values are environment-scoped (`values-dev.yaml`, `values-staging.yaml`, `values-prod.yaml`); secrets are never inlined in values files — every secret reference resolves through the `SecretsPort` (`SECURITY.md` §3) via a Kubernetes external-secrets-style integration appropriate to the target cloud.

Horizontal Pod Autoscaling is applied to stateless services (API, workers) keyed on CPU + queue-consumer-lag custom metrics where supported. Background worker deployments (Kafka consumers, the `deadline_at` fallback poller, the outbound webhook dispatcher, billing/analytics/search-indexer consumers) are horizontally scalable by design — none of them hold tenant context in process memory or on the connection between jobs (`TENANCY.md` §5, `DATABASE.md` §14a), so adding replicas is always safe and never requires sharding workers by tenant.

## 4. CI/CD

**CURRENT**: `.github/workflows/ci.yml` runs lint/typecheck/build, integration + database + security tests, the OpenAPI contract drift check (`openapi-contract`: the committed snapshot and plugin metadata must equal what the code generates; nothing is regenerated in place — Phase 1C.3), a dependency audit and a secret scan. It builds **no** deployable artifact and deploys nowhere.

**PLANNED** pipeline stages, matching the development lifecycle (`ROADMAP.md` §2):

```
lint/typecheck → unit tests → integration tests (ephemeral infra) → contract tests
  → build container images → security scan (SAST + dependency) → push to registry
  → deploy to dev → smoke test → (manual gate) deploy to staging → smoke test
  → (manual gate) deploy to production → smoke test → post-deploy verification
```

Manual approval gates are required before staging→production regardless of automated test results, consistent with the "check before risky/hard-to-reverse actions" principle applied to production releases.

**OpenAPI exposure (`OPENAPI_UI_ENABLED`, Phase 1C.3).** Off by default and permitted in every environment. With it on, development serves the Swagger UI and the document without authentication. Every other environment serves only `GET /api/v1/openapi.json`, to a signed-in user session, and no UI (`API.md` §9).

## 5. Git branching strategy

- `main`: always production-released state; direct commits disallowed.
- `develop`: integration branch (current default branch of this repository); feature branches merge here first.
- `feature/*`: one per unit of work, branched from `develop`, merged via PR with required review + passing CI.
- `release/*` (as needed for hardening a phase before production): branched from `develop`, only bugfixes land here, merges to both `main` and back to `develop` on completion.
- `hotfix/*`: branched from `main` for urgent production fixes, merged to both `main` and `develop`.

## 6. Release strategy

Releases are cut from `main` after a `release/*` branch (or direct `develop`→`main` merge for low-risk phases) passes staging smoke tests and the manual approval gate. Each release is tagged (semver), and the corresponding container image digests are recorded against the tag for exact reproducibility.

## 7. Rollback strategy

- **Application**: Helm rollback to the prior release's chart+values revision (Kubernetes-native rollback, seconds-scale).
- **Database**: migrations are written to be backward-compatible for at least one release (expand/contract pattern) specifically so an application rollback never requires a simultaneous destructive schema rollback.
- **Provider/routing config**: rolled back independently of application deploys entirely, via routing policy version re-activation (`ROUTING_ENGINE.md` §4) — this is the primary reason provider/routing changes are modeled as versioned DB config rather than application config.
- **Feature-level**: additive features are gated so they can be disabled without a rollback where practical (tracked per-phase in `ROADMAP.md`, not a blanket feature-flag mandate for Phase 0).

## 8. Related

Deployment topology decisions: ADR-009 (`DECISIONS.md` §1i). Tenancy and the hostname rule: `TENANCY.md` §§4, 7a. Secret boundary: `SECURITY.md` §3. Disaster recovery (data-loss/outage scenarios, distinct from routine rollback): `DR.md`. Operational procedures: `RUNBOOK.md`.
