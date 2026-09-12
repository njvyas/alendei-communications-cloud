# Operational Runbooks

These are Phase 0 procedural placeholders describing the *shape* of each runbook (what it must cover, what tooling it assumes) — exact step-by-step commands are written against real tooling starting in Phase 1, once that tooling exists. No runbook here assumes a real external provider is connected.

## 1. Development workflow

1. Branch from `develop` (`DEPLOYMENT.md` §5).
2. Bring up local stack via Docker Compose.
3. Implement against the module boundary owning the change (`ARCHITECTURE.md` §4); do not reach across module boundaries directly.
4. Run unit + integration tests locally.
5. Open PR into `develop`; CI runs the full pipeline (`DEPLOYMENT.md` §4).
6. Code review + (for security-sensitive changes) security review.
7. Merge; CI deploys to Dev automatically, Staging/Production require manual gates.

## 2. Provider incident response (a provider goes `CRITICAL`/`OFFLINE`)

1. Alert fires from `alendei.providers.health_changed.v1` / Grafana threshold (`OBSERVABILITY.md` §5).
2. On-call confirms via the admin control center's provider health dashboard (`PROVIDER_ADAPTER.md` §4).
3. If not already automatic, admin sets the provider to `DRAINING` or `OFFLINE` to stop new routing.
4. Confirm the Fallback/Routing Engine is correctly diverting traffic to the next eligible provider/channel (check fallback-trigger rate metric, `OBSERVABILITY.md` §3).
5. Once the provider recovers, admin runs a canary re-enable (`ROUTING_ENGINE.md` §6) rather than an immediate 100% cutover back.
6. Post-incident: audit log review confirms no duplicate customer charges or duplicate deliveries occurred during the incident (`TESTING.md` §3 scenario is the template for this verification).

## 3. Webhook processing backlog / consumer lag

1. Alert fires on consumer lag threshold breach (`OBSERVABILITY.md` §5).
2. Check whether the cause is upstream volume spike (scale consumers) or a downstream fault (DB contention, a bad message poison-pilling a partition).
3. If a poison message is identified, it is moved to a dead-letter topic for offline inspection — never silently dropped, and never blocking the rest of the partition indefinitely.
4. Resume normal processing; verify `webhook_events.processed_at` backlog drains.

## 4. Suspected duplicate customer charge

1. Pull all `usage_ledger` rows for the `message_id` in question (never infer from a dashboard aggregate — `BILLING.md` §1).
2. Cross-reference `message_attempts` to confirm whether multiple attempts legitimately reached a provider (expected under fallback) versus an actual bug (e.g., the same attempt double-charged).
3. If a genuine duplicate is confirmed, issue a `refund`/`adjustment` ledger entry (never edit/delete the erroneous entry) with a documented reason.
4. File the root cause for engineering follow-up; do not treat the manual refund as the fix.

## 5. Additional operational scenarios

**Provider credential failure (auth errors spiking for one provider):**
1. Alert on elevated `AUTH_ERROR`-classified failures for one `provider_id` (`PROVIDER_ADAPTER.md` §2 normalized failure taxonomy).
2. Check `provider_credentials` for the resolved credential at the affected scope (`PROVIDER_ADAPTER.md` §4a) — expired, revoked, or rotated-but-not-propagated are the common causes.
3. If rotation is the cause, verify the new credential's `credential_ref` actually resolves in the secrets backend before assuming the rotation itself is broken.
4. Until resolved, drain or disable the affected provider so the Fallback Engine routes around it rather than repeatedly failing attempts against a known-broken credential.

**Outbound webhook DLQ recovery:**
1. `GET /webhook-deliveries?status=dead_letter` to enumerate affected deliveries for an endpoint.
2. Confirm the customer's endpoint is actually reachable again (the auto-disablement in `EVENTS.md` §5a exists precisely to stop hammering a dead endpoint) before replaying.
3. Re-enable the `webhook_endpoints` row (audited action), then replay dead-lettered deliveries individually or in bulk via `POST /webhook-deliveries/{id}/replay` (`EVENTS.md` §5d) — this only retries transmission, never regenerates the underlying event.
4. Monitor `consecutive_failure_count` resets to confirm recovery before considering the incident closed.

**Wallet/ledger inconsistency (materialized balance disagrees with a fresh ledger aggregation):**
1. Per `BILLING.md` §1, the ledger aggregation is correct by definition — this is a materialized-view bug, not a financial-truth ambiguity.
2. Recompute the affected org's `wallets.balance`/`reserved` directly from `usage_ledger` and compare to the stored materialized value to confirm the divergence and its magnitude.
3. Correct the materialized value to match the ledger aggregation (a cache-repair operation, not a financial adjustment — no new ledger row is needed for this specific correction, since nothing about the underlying financial facts changed, only the cached projection of them).
4. File the root cause (likely a missed event in the ledger-writer consumer, or a race in the materialization job) for engineering follow-up.

**Fallback storm (a widely-used provider degrades, causing a spike in concurrent escalations):**
1. Recognize via the fallback-trigger-rate metric spike (`OBSERVABILITY.md` §5) correlated with one provider's health/circuit transition.
2. Confirm the `deadline_at` poller (`FALLBACK_ENGINE.md` §4) is keeping up — check for growing backlog on the partial index it scans (`DATABASE.md` §13); scale poller workers horizontally if needed (safe to do so, since `FOR UPDATE SKIP LOCKED` makes additional workers purely additive, never a correctness risk).
3. If the degrading provider is the *first* step of many chains, consider proactively setting it to `DRAINING` so new sends route around it immediately rather than each individually waiting out a full wait-window before escalating.
4. Verify downstream fallback providers (the next 1-2 steps in affected chains) are not themselves being overwhelmed by the sudden traffic shift — this is exactly the scenario the canary-migration mechanism (`ROUTING_ENGINE.md` §6) exists to ramp gradually instead of all-at-once, so consider whether a manual, gradual re-route is safer than letting every affected chain escalate simultaneously.

**Stuck fallback timers (attempts sitting past `deadline_at` with no escalation occurring):**
1. Check whether the poller process itself is alive and its consumer-group/worker-pool metrics show it processing (§ above, `OBSERVABILITY.md` §3).
2. Manually run the poll query (`FALLBACK_ENGINE.md` §4) to confirm whether qualifying rows exist and whether they are being claimed (`FOR UPDATE SKIP LOCKED` rows held by a crashed-but-not-yet-timed-out transaction can appear "stuck" until that transaction's connection is reaped) — if so, the fix is ensuring dead connections are reaped promptly (a connection-pool/keepalive configuration issue, not a Fallback Engine logic issue).
3. As a last resort, a stuck attempt can be manually escalated via an admin action that runs the same conditional transaction the poller would have run — never via a direct, unconditional status edit, which would bypass the very guard that prevents duplicate escalation.

**Kafka consumer lag (general, beyond the webhook-specific case in §3):**
1. Identify which consumer group is lagging and whether the cause is upstream volume or a downstream fault (§3 above covers the webhook-specific instance; the same diagnosis pattern applies to `orchestrator-lifecycle`, `billing-ledger-writer`, etc.).
2. Scale consumer instances for that group if the partition count allows it; if not, this surfaces a partition-count planning gap to address before the next capacity review.

**Redis outage:**
1. Confirm the system continues to function in degraded form: cache misses fall through to Postgres (higher latency, not incorrect results), rate limiting fails toward a conservative default (documented per-endpoint, never fails open to unlimited), and fallback-escalation correctness is entirely unaffected because it never depended on Redis for correctness in the first place (`FALLBACK_ENGINE.md` §4).
2. Restore Redis; caches repopulate naturally on next access — no manual cache-warming procedure is required for correctness, only for performance recovery speed.

**Database failover (primary Postgres instance lost, replica promoted):**
1. Confirm the promoted replica's replication lag at failover time to bound any potential data loss window (see `DR.md` §3 RPO placeholder).
2. Re-point application connection strings/service discovery to the new primary; connection pools reconnect, and `SET LOCAL`-based tenant context (never connection-level state) means no stale tenant context can survive the reconnect (`DATABASE.md` §14a).
3. Verify the `deadline_at` poller and other schedulers resume cleanly against the new primary — they are stateless with respect to which Postgres instance they poll, so no special recovery step is needed beyond reconnection.

**Stuck journey executions:**
1. Query `journey_executions` for rows stuck in `waiting`/`running` past an expected step duration.
2. Distinguish "waiting on a legitimate long delay step" (not stuck, working as designed) from "waiting on an event that will never arrive due to a bug" — check the journey version's graph definition for the step in question.
3. A genuinely stuck execution can be manually advanced or exited by an admin action, which is itself audit-logged the same as any other manual state override.

## 6. Disaster recovery runbooks (see `DR.md` for objectives/backup detail)

**Database restore (point-in-time):**
1. Identify the target recovery timestamp (just before the corrupting event).
2. Provision a recovery instance from the most recent base backup + WAL replay to the target timestamp.
3. Validate recovered data against known-good checkpoints (e.g., last known-correct `usage_ledger` aggregate for a sample org).
4. Cut application traffic over only after validation passes; never cut over to an unvalidated restore.

**Full region/datacenter loss:**
1. Declare DR per the (business-defined) incident severity process.
2. Stand up infrastructure in the secondary region/cloud via the same Helm charts + environment-specific values (`DEPLOYMENT.md` §1, §3).
3. Restore Postgres from the most recent cross-region-replicated backup/WAL.
4. Restore/re-point secrets backend, object storage, and DNS/ingress.
5. Reindex OpenSearch from Postgres (not restored from backup — rebuilt, per `DR.md` §1).
6. Run smoke tests before opening traffic; run the critical fallback scenario test (`TESTING.md` §3) as an operational-readiness check, not just a CI gate.

## 7. Provider credential rotation

1. Generate new credential in the provider's own console/system (outside ACC — never generated by ACC itself).
2. Store the new credential in the secrets backend; update `provider_credentials.credential_ref`/`rotated_at`.
3. Cache invalidation broadcasts the change; next call picks up the new credential with no restart (`SECURITY.md` §3, `PROVIDER_ADAPTER.md` §4).
4. Revoke the old credential at the provider only after confirming the new one is in successful use (avoids an accidental full outage if the new credential is misconfigured).

## 8. Webhook replay authorization (operational summary — full semantics `EVENTS.md` §§5b–5d)

Any replay operation (inbound provider webhook replay, internal event replay, or outbound delivery replay) requires: (1) a permission tier equivalent to `providers.manage` or higher, (2) an explicit, specific target (never a bulk/wildcard replay without an enumerated scope), and (3) an audit log entry naming the actor, the exact target(s), and the reason. None of the three replay types regenerates a business event or re-triggers a message send — operators should treat this as a hard invariant to verify, not merely assume, whenever building or extending replay tooling.

## 9. Related

Incident severity classification, on-call rotation, and paging tool configuration are business/ops decisions outside this repository's scope and are tracked as open items in `DECISIONS.md`.
