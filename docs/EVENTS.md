# Event-Driven Architecture

## 1. Transport

A Kafka-wire-compatible event bus (Apache Kafka or Redpanda; abstracted so either satisfies the same producer/consumer contract) carries all domain events. Postgres is the source of truth; events are notifications *about* committed Postgres state, published via the **transactional outbox pattern** — a service writes its state change and an `outbox_events` row in the same DB transaction, and a separate relay process publishes outbox rows to Kafka and marks them sent. This guarantees an event is never published for a state change that didn't actually commit, and never lost if the broker is briefly unavailable.

## 2. Topic naming & schema

`alendei.<domain>.<event_name>.v<n>` — e.g. `alendei.messages.status_changed.v1`.

- Schemas are defined (JSON Schema initially, Avro/Protobuf evaluated for Phase 2+, tracked in `DECISIONS.md` as non-blocking) and enforced via a schema registry; producers cannot publish a payload that fails validation.
- Every event envelope carries: `event_id (UUIDv7)`, `event_type`, `event_version` (the schema version of this specific payload shape, independent of the topic's `.v<n>` suffix — allows additive payload evolution without a topic migration), `schema_version` (the registry schema id used to validate this payload), `occurred_at`, `aggregate_type` (e.g. `message`, `message_attempt`, `campaign`), `aggregate_id` (the id of that entity), `tenant_id` (`org_id`) + `workspace_id` where applicable, `correlation_id`, `causation_id` (the event/request that caused this one), `payload`.
- Partition key is `tenant_id` + `aggregate_id` where per-entity ordering matters, ensuring all events for one message/attempt/conversation land on the same partition and are consumed in order.

## 3. Ordering & idempotency at the event level

- Consumers are idempotent by design: a `processed_events` table (per consumer group) records `(consumer_group, event_id)` and skips reprocessing on redelivery (at-least-once delivery is assumed, exactly-once is not relied upon).
- Out-of-order delivery across partitions is expected for unrelated entities; within a partition (same `aggregate_id`) Kafka guarantees order, and consumers additionally apply a monotonic-state guard (an older lifecycle event cannot regress a newer state) as a second line of defense — see `ARCHITECTURE.md` §9b.

## 4. Event catalogue — attempt-level vs. message-level (do not conflate)

Two structurally different kinds of event exist, and the catalogue is organized by that split because it directly mirrors the `message_attempts` vs. `messages` ownership boundary (`DATABASE.md` §6, `ARCHITECTURE.md` §5):

### 4a. Attempt-level events — describe one physical provider/channel try

| Event | Emitted when |
|---|---|
| `alendei.attempts.started.v1` | A `message_attempts` row is created (initial send or fallback escalation) |
| `alendei.attempts.provider_accepted.v1` | Provider API acknowledged acceptance for this attempt |
| `alendei.attempts.provider_rejected.v1` | Provider explicitly rejected this attempt at submission time |
| `alendei.attempts.delivery_confirmed.v1` | Provider webhook confirms delivery for this attempt |
| `alendei.attempts.delivery_failed.v1` | Provider reports explicit delivery failure for this attempt |
| `alendei.attempts.timed_out.v1` | This attempt's `deadline_at` elapsed with no delivery confirmation (fired by the poller in §6, before any escalation decision is made) |

`aggregate_type=message_attempt`, `aggregate_id=message_attempts.id` for all of the above.

### 4b. Message-level events — describe the logical message's business-level disposition

| Event | Emitted when |
|---|---|
| `alendei.messages.created.v1` | Message intent persisted (post-validation, post-idempotency-check) |
| `alendei.messages.status_changed.v1` | Any `messages.status` transition — the umbrella projection event for subscribers who don't need per-attempt granularity |
| `alendei.messages.fallback_triggered.v1` | The Fallback Engine's conditional transition (`FALLBACK_ENGINE.md` §4) committed, creating a new attempt |
| `alendei.messages.completed.v1` | `messages.status` reached `DELIVERED`/`READ` |
| `alendei.messages.failed.v1` | `messages.status` reached `FAILED` (chain exhausted) or `EXPIRED` |

`aggregate_type=message`, `aggregate_id=messages.id` for all of the above. **`messages.status_changed` is always derived by the Orchestrator from attempt-level events per the derivation rule in `ARCHITECTURE.md` §6a — no consumer should infer message status by independently interpreting attempt events; consume `status_changed` for that, and attempt events only when attempt-level detail is specifically needed (e.g. billing, per-provider reporting).**

### 4c. Other domain events (representative)

| Event | Domain | Emitted when |
|---|---|---|
| `alendei.tenancy.organization_created.v1` | tenancy | New organization provisioned |
| `alendei.tenancy.user_role_granted.v1` | tenancy | Role assigned at a scope |
| `alendei.providers.health_changed.v1` | provider-registry | Provider health state transition |
| `alendei.providers.circuit_state_changed.v1` | provider-router | Breaker CLOSED/OPEN/HALF_OPEN transition |
| `alendei.routing.policy_activated.v1` | provider-router | A new `routing_policy_versions` row activated at some scope |
| `alendei.webhooks.received.v1` | webhooks | Raw inbound webhook persisted (pre-processing) |
| `alendei.webhooks.duplicate_detected.v1` | webhooks | Dedup constraint rejected a re-delivered inbound provider event |
| `alendei.webhooks.outbound_delivery_failed.v1` | webhooks | An outbound `webhook_deliveries` attempt exhausted retries and moved to `dead_letter` |
| `alendei.campaigns.launched.v1` / `.completed.v1` | campaigns | Campaign lifecycle |
| `alendei.journeys.execution_started.v1` / `.step_completed.v1` / `.exited.v1` | journeys | Journey execution lifecycle |
| `alendei.billing.ledger_entry_recorded.v1` | billing | Any `usage_ledger` row inserted (including `reservation`/`reservation_release`) |
| `alendei.billing.invoice_issued.v1` | billing | Invoice finalized |
| `alendei.billing.wallet_low_balance.v1` | billing | Available balance (`balance - reserved`) crosses configured threshold |
| `alendei.ai.usage_recorded.v1` | ai-gateway | AI call billed |
| `alendei.audit.action_recorded.v1` | audit | Umbrella event mirroring every `audit_logs` insert, for external SIEM export |

## 5. Consumer groups (representative)

- `orchestrator-lifecycle`: consumes attempt-level events (§4a), drives `message_attempts`/`messages` state per the derivation rule, emits `messages.status_changed`.
- `fallback-scheduler`: runs the `deadline_at` poll (§6) and the conditional escalation transaction (`FALLBACK_ENGINE.md` §4); consumes `attempts.timed_out` as a secondary trigger where the poller itself doesn't directly own firing (implementation detail resolved at Phase 5).
- `billing-ledger-writer`: consumes attempt/message events relevant to cost and charge, writes `usage_ledger` rows (including reservation finalization/release).
- `search-indexer`: consumes message/conversation events, updates OpenSearch inbox index.
- `webhook-outbound-dispatcher`: consumes every event type any `webhook_endpoints` row is subscribed to, creates/updates the corresponding `webhook_deliveries` row, and performs the HTTP delivery (§5a).
- `analytics-projector`: consumes broad event set, builds reporting read models.

### 5a. Outbound webhook dispatch (customer-facing)

For each event matching a `webhook_endpoints.subscribed_event_types` pattern, the dispatcher:
1. Upserts a `webhook_deliveries` row keyed `(endpoint_id, event_id)` — idempotent by construction, so redelivery of the same event to the same consumer group never creates a second delivery record (`DATABASE.md` §12).
2. Signs the payload (`X-Alendei-Signature`, `API.md` §6) and POSTs it, recording `last_http_status`/`last_error`.
3. On failure, schedules `next_retry_at` with exponential backoff up to a configurable attempt cap; on cap exhaustion, sets `status='dead_letter'` and emits `alendei.webhooks.outbound_delivery_failed.v1`.
4. After a configurable number of consecutive fully-failed deliveries (`webhook_endpoints.consecutive_failure_count`), the endpoint itself transitions to `status='auto_disabled'` — no further deliveries are attempted until an admin re-enables it (an audited action).
5. Dead-lettered deliveries are visible and manually replayable via the admin console/API (`RUNBOOK.md` §"Outbound webhook DLQ recovery").

### 5b. Provider webhook replay (inbound)

Replaying a `webhook_events` row means re-running its processing pipeline (verify → parse → emit attempt-level event) against the **same** persisted raw payload — used to recover from a downstream processing bug, not to simulate a new provider event. Because downstream consumers dedup on `(provider_id, provider_event_id)` (already recorded on the original row), replay cannot create a second business event or a second customer-visible action — at worst it reprocesses idempotently. Replay requires a privileged permission (`providers.manage` or higher) and is fully audit-logged (`SECURITY.md` §4) with the original `webhook_events.id` as the audit resource reference.

### 5c. Internal event replay (event-bus level)

Resetting a consumer group's offset to reprocess a range of already-published events. Safe for the same reason as §5b: every consumer in the platform is required to be idempotent via `processed_events` (`(consumer_group, event_id)` dedup, §3) — a correctly-implemented consumer treats replay identically to a duplicate at-least-once delivery. This operation is an infrastructure/ops action (`RUNBOOK.md`), not an API-exposed customer capability, and requires platform-admin authorization plus an audit log entry naming the consumer group, offset range, and operator.

### 5d. Outbound webhook replay (customer-facing)

Re-attempting delivery of an **existing** `webhook_deliveries` row — same `event_id`, same payload, a fresh HTTP attempt. This never regenerates the underlying domain event and never re-triggers any business action (e.g. it cannot cause a second message to be sent) — it only retries transmission of a fact that already happened. Because the delivery payload includes the original `event_id` and `occurred_at`, a customer's own downstream dedup (if they key off `event_id`) continues to work correctly across a replay. Available via `/api/v1/webhooks/deliveries/{id}/replay`, requiring the same permission tier as manually triggering any outbound side effect, audit-logged.

## 6. Delayed/scheduled events (fallback timers) — resolved: PostgreSQL-backed, not Redis-backed

Delivery-based fallback requires "wait N minutes, then act if no confirmation arrived." **Resolved (Phase-1-blocker decision, `DECISIONS.md`)**: the authoritative mechanism is a PostgreSQL `deadline_at` column on `message_attempts` polled with `FOR UPDATE SKIP LOCKED` (`FALLBACK_ENGINE.md` §4, `DATABASE.md` §13), not a Kafka delayed-topic or a Redis-only scheduler. A Redis sorted-set index MAY sit in front of the poller purely to avoid full-table scans at scale, but it is a derived, rebuildable cache — the poll query against Postgres is always correct on its own, just potentially slower without the accelerator. The contract this satisfies: a scheduled check only ever triggers `alendei.messages.fallback_triggered.v1` after successfully committing the conditional transaction in `FALLBACK_ENGINE.md` §4 against **current** database state, never against a stale in-memory or Redis-only assumption — this is what prevents the race against a delivery webhook arriving just before the timer fires.

## 7. Related

Full state machine and race-condition handling: `ARCHITECTURE.md` §§6a, 9. Fallback timer/transition mechanics: `FALLBACK_ENGINE.md` §4. Outbound webhook durable model: `DATABASE.md` §12, `API.md` §6.
