# Deployment Architecture

## 1. Environment strategy

| Environment | Purpose | Infra |
|---|---|---|
| Local | Individual developer machine | Docker Compose |
| Dev (shared) | Integration point for `develop` branch | Kubernetes (small), or Compose for lightweight iteration |
| Staging | Pre-production validation, mirrors prod topology | Kubernetes (Helm), production-like data volume (synthetic, never real customer/provider data in Phase 0–2) |
| Production | Live tenants | Kubernetes (Helm), multi-AZ where the target cloud supports it |

Cloud target is portable by design (`ARCHITECTURE.md` §19): the same Helm charts and container images deploy to AWS, Azure, GCP, private cloud, or on-prem Linux Kubernetes, differing only in environment-specific values files (storage class, ingress class, secrets backend endpoint).

## 2. Docker / Compose (development)

`docker-compose.yml` (created in Phase 1, not Phase 0) will bring up: Postgres, Redis, a Kafka-wire-compatible broker (Redpanda recommended for lightweight local dev), OpenSearch, MinIO (S3-compatible), an OTel collector, Prometheus, Grafana, and the application services (API, workers) plus the Provider Simulator — no real provider connectivity is ever part of this stack.

## 3. Kubernetes / Helm (staging, production)

One Helm chart per deployable service (aligned to the module boundaries in `ARCHITECTURE.md` §4, several of which may initially be co-deployed as a single "modular monolith" release and split into independent deployments later without an API change). Helm values are environment-scoped (`values-dev.yaml`, `values-staging.yaml`, `values-prod.yaml`); secrets are never inlined in values files — every secret reference resolves through the `SecretsPort` (`SECURITY.md` §3) via a Kubernetes external-secrets-style integration appropriate to the target cloud.

Horizontal Pod Autoscaling is applied to stateless services (API, workers) keyed on CPU + queue-consumer-lag custom metrics where supported. Background worker deployments (Kafka consumers, the `deadline_at` fallback poller, the outbound webhook dispatcher, billing/analytics/search-indexer consumers) are horizontally scalable by design — none of them hold tenant context in process memory or on the connection between jobs (`TENANCY.md` §5, `DATABASE.md` §14a), so adding replicas is always safe and never requires sharding workers by tenant.

## 4. CI/CD

GitHub Actions (or an equivalent CI system) pipeline stages, matching the development lifecycle (`ROADMAP.md` §2):

```
lint/typecheck → unit tests → integration tests (ephemeral infra) → contract tests
  → build container images → security scan (SAST + dependency) → push to registry
  → deploy to dev → smoke test → (manual gate) deploy to staging → smoke test
  → (manual gate) deploy to production → smoke test → post-deploy verification
```

Manual approval gates are required before staging→production regardless of automated test results, consistent with the "check before risky/hard-to-reverse actions" principle applied to production releases.

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

Disaster recovery (data-loss/outage scenarios, distinct from routine rollback): `DR.md`. Operational procedures: `RUNBOOK.md`.
