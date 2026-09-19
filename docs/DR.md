# Disaster Recovery & Backup Strategy

Targets below (RTO/RPO) are Phase 0 architectural placeholders to be validated against actual business requirements with the product owner before Phase 12 hardening — see `DECISIONS.md`.

## 1. Data classification for DR purposes

| Data class | System | Loss impact |
|---|---|---|
| Financial (ledger, invoices) | Postgres (`usage_ledger`, `invoices`, `payments`) | Highest — must never be lost once committed |
| Audit | Postgres (`audit_logs`) | Highest — regulatory/compliance exposure if lost |
| Messaging system-of-record | Postgres (`messages`, `message_attempts`, `message_events`) | High — customer trust, billing reconciliation |
| Provider/routing config | Postgres (`providers`, `routing_policy_versions`, `fallback_policies`) | High — required to resume correct operation |
| Search index | OpenSearch | Low — fully rebuildable from Postgres |
| Cache/locks/rate-limit state | Redis | Lowest — transient by design, safe to lose. Redis locking is an optional contention-reduction optimization only, never the fallback-escalation correctness boundary (`ARCHITECTURE.md` §9c, `FALLBACK_ENGINE.md` §4): losing Redis on restart at worst means more workers concurrently poll/contend for the same fallback escalation (additional duplicate *attempts to escalate*, not duplicate *escalations*), which the PostgreSQL conditional state transition (compare-and-swap on `state_version`/`status`) still arbitrates safely — exactly one worker's transaction commits, every other worker's matching transaction affects zero rows and becomes a no-op. No unsafe state transition or duplicate business outcome is possible regardless of Redis availability; the authoritative current state is, and remains, in PostgreSQL |
| Media/exports | S3-compatible storage | High — often not regeneratable (customer-uploaded media) |

## 2. Backup strategy

| System | Method | Frequency (placeholder) | Retention (placeholder) |
|---|---|---|---|
| Postgres | Continuous WAL archiving + periodic full base backups | Continuous (WAL), daily (base) | 35 days online, longer-term cold archive per compliance need |
| S3-compatible storage | Cross-region/cross-bucket replication where the backend supports it | Continuous | Matches source retention policy |
| OpenSearch | Not backed up directly — reindexed from Postgres on recovery | N/A | N/A |
| Kafka | Short retention is acceptable for most topics (event bus is a relay, not a store) *except* where a topic is deliberately used as a durable log; those topics get longer retention + backup consideration, identified per-topic in Phase 2+ | Per-topic | Per-topic |
| Redis | Not backed up (transient state) | N/A | N/A |
| Secrets backend | Backend-native backup/replication (Vault/KMS-specific) | Per backend's own DR capability | Per backend's own DR capability |

All backups are encrypted at rest and access-restricted; backup restoration is periodically tested (not just taken and assumed valid) — a restore drill is a Phase 12 acceptance criterion, not deferred indefinitely.

## 3. Recovery objectives (placeholder — confirm with product owner)

| Scenario | Target RPO | Target RTO |
|---|---|---|
| Single-AZ/node failure | 0 (multi-AZ Postgres replica failover) | Minutes |
| Full region/datacenter loss | Minutes (last WAL shipped) | Hours (restore in secondary region) |
| Logical corruption (bad migration, bad data write) | Point-in-time recovery to just before the corrupting transaction | Hours, depends on detection latency |
| Accidental deletion (application bug, not malicious) | Same as logical corruption | Same as logical corruption |

## 3a. Shared versus dedicated deployment boundaries (ADR-009)

Backup and restore are **deployment-scoped**, so the two models differ in a way that matters operationally and commercially.

| Concern | Shared SaaS (Model A) | Dedicated / private (Models B, C) |
|---|---|---|
| Backup boundary | One cluster covering many tenants | One cluster covering one customer |
| Restore boundary | The whole deployment/database | That customer |
| Blast radius of a restore | Every tenant on the deployment | One customer |
| RPO/RTO | One platform-wide class | Potentially per-customer |

**The consequence worth stating before an incident rather than during one: in the shared model, point-in-time recovery for a single tenant is not available from PostgreSQL backup/restore alone.** PITR rewinds the cluster, and rewinding the cluster rewinds every other tenant with it. Recovering one tenant's logical corruption therefore means a logical export/repair path, not a restore — and no such tooling exists yet. In a dedicated deployment the restore boundary and the customer boundary coincide, so PITR is straightforwardly available.

Nothing here changes §2's backup strategy, which applies to any deployment.

**RPO/RTO becomes a deployment-class decision.** The placeholders in §3 are a single platform-wide set. Once dedicated deployments exist, recovery objectives are properly an attribute of a deployment class — shared SaaS as one class, each dedicated customer potentially its own, possibly contractual. Those values are a business input and are deliberately not invented here (`DECISIONS.md` §4, ADR-009).

## 4. Multi-region / multi-cloud posture

Phase 0 does not commit to active-active multi-region — it commits to *not architecturally precluding* it: no component assumes single-region affinity beyond what the chosen managed database/broker requires, and the cloud-portability principle (`ARCHITECTURE.md` §19) means a full redeploy to a secondary cloud/region is a Helm values change plus a data restore, not a rewrite. Whether to invest in active-active is a cost/business decision deferred to `DECISIONS.md`.

## 5. Related

Step-by-step recovery execution: `RUNBOOK.md` §"Disaster recovery runbooks". Rollback (routine, non-disaster) vs. DR (data-loss/outage) distinction: `DEPLOYMENT.md` §7.
