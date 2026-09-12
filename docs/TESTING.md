# Testing Strategy

## 1. Layers

| Layer | Scope | Tooling direction |
|---|---|---|
| Unit | Pure logic: routing scoring, fallback state transitions, billing math, permission evaluation | Jest |
| Integration | Module-boundary contracts against real Postgres/Redis/Kafka in Docker Compose | Jest + Testcontainers-style ephemeral infra |
| Contract | API responses validated against the generated OpenAPI spec (`API.md` §8) | schema validation in CI |
| End-to-end | Full request flow through the simulator-backed provider layer | Playwright (console UI) + API-level e2e suite |
| Chaos | Fault injection at provider/queue/DB layers | see §4 |
| Load/performance | Throughput and latency under realistic and peak volumes | k6 or similar, against the simulator |
| Security | SAST/dependency scanning + targeted abuse-case tests | see §5 |

No layer above ever calls a real external provider. All provider-facing tests run against the Provider Simulator (§2).

## 2. Provider simulator

A first-class `SimulatorAdapter` (`PROVIDER_ADAPTER.md` §7) configurable per test to return, on demand:

| Behavior | Simulates |
|---|---|
| `SUCCESS` | Normal acceptance + eventual delivery webhook |
| `TIMEOUT` | No response within adapter timeout |
| `500` | Provider server error |
| `429` | Provider rate-limit rejection |
| `INVALID_CREDENTIALS` | Auth failure at the provider |
| `INVALID_REQUEST` | Malformed/rejected payload |
| `SLOW_RESPONSE` | High-latency success (tests latency-based routing/circuit behavior) |
| `DELIVERY_DELAY` | Accepted, delivery webhook arrives late (tests fallback timer edge behavior) |
| `DELIVERY_FAILURE` | Accepted, then explicit delivery-failure webhook |
| `DUPLICATE_WEBHOOK` | Same webhook delivered twice (tests dedup, `EVENTS.md` §3) |
| `OUT_OF_ORDER_WEBHOOK` | Delivery-state webhooks arrive out of chronological order (tests the monotonic-state guard, `ARCHITECTURE.md` §9) |

Simulator behavior is configured per test (and, in dev, per admin "test this provider" action, `PROVIDER_ADAPTER.md` §4) via request metadata or provider config — never via hard-coded branching in adapter code.

## 3. Critical scenario test (mandatory, automated, run in CI on every change touching routing/fallback)

```
WhatsApp Provider A → FAIL
WhatsApp Provider B → FAIL
RCS Provider A       → FAIL
RCS Provider B       → FAIL
SMS Provider A       → SUCCESS
```

Asserts, end-to-end against the simulator:

1. **No unintended duplicate logical message** — exactly one `messages` row exists for the whole chain; nothing about escalation creates a second logical message.
2. **Correct attempt numbering** — five `message_attempts` rows exist with `attempt_number = 1..5` (the single global counter, `FALLBACK_ENGINE.md` §3), each with the correct `channel_id`/`provider_id`.
3. **Eligibility re-evaluation occurred at every step** — the test asserts the Eligibility/Channel/Provider Router sequence was actually invoked fresh at each escalation (`ARCHITECTURE.md` §3b), not that a precomputed plan was replayed; a variant of this test injects a mid-chain health/consent change (e.g. WhatsApp Provider B goes `OFFLINE` between attempt 1 and attempt 2) and asserts the chain correctly substitutes rather than blindly following stale config.
4. **Correct provider routing** at every step, per the resolved effective routing policy (`ROUTING_ENGINE.md` §4), with each `message_attempts` row's `routing_policy_id`/`routing_policy_version_id` snapshot (`DATABASE.md` §6) correctly recording the policy/version actually used for that specific attempt.
5. **No duplicate delivery** — the four failed attempts remain `FAILED`/`PROVIDER_REJECTED`/`timed_out` on their own immutable `message_attempts` rows; only attempt 5 reaches `delivered`.
6. **Correct final message state** — `messages.status = DELIVERED`, `messages.current_provider_id` = SMS Provider A, `messages.current_attempt_number = 5`.
7. **Billing — phase-scoped assertion.** At **Phase 5** (`ROADMAP.md` §8), before the immutable ledger and Pricing & Rating Engine exist, this assertion is an **integration-contract check only**: the orchestrator emits the correct billing-shaped event/call exactly once per attempt that reached a provider and exactly once at chain terminal state, matching the org's configured `billing_policy` (`DATABASE.md` §2) — asserted against the defined contract (`EVENTS.md` §5, `BILLING.md` §§1–2), not against a real ledger, since none exists yet. No temporary ledger/wallet implementation is built to satisfy this early. At **Phase 7** (`ROADMAP.md` §10), once `usage_ledger`/wallets/the Pricing & Rating Engine exist, this same scenario is re-run with the assertion extended to full financial correctness: a `provider_cost` ledger entry exists for all five attempts; `customer_charge` entries match the org's configured `billing_policy` exactly per the worked example in `BILLING.md` §5; the up-front reservation (`BILLING.md` §8) is correctly released down to the actual charge. Phase 5's passing this test never implies Phase 7's billing work is already done — the two are the same scenario asserting different things at different phases, not the same requirement.
8. **Correct audit trail** — `audit_logs`/`message_events` fully reconstruct the five-step chain with accurate timestamps and no gaps, correctly split between attempt-level and message-level events (`EVENTS.md` §4).
9. **Complete traceability** — a single `correlation_id` ties every attempt, event, ledger entry, and audit row together; traces show the full re-evaluation sequence at each step, not just the final outcome.
10. **Correct webhook behavior** — the delivery-confirmation webhook for attempt 5 is processed exactly once even if the simulator redelivers it (`DUPLICATE_WEBHOOK`), and does not affect the now-superseded attempts 1–4.

This scenario is the acceptance gate for Phase 5 (`ROADMAP.md` §8, with item 7 scoped to the billing integration-contract as above) and is re-run as a regression test thereafter, including as Phase 7's own billing acceptance gate (`ROADMAP.md` §10) once item 7 can be asserted against the real ledger.

## 4. Idempotency tests

- Duplicate API request with an identical `Idempotency-Key` and identical payload → original response replayed verbatim, no second `messages` row (`API.md` §4, `DATABASE.md` §7.1).
- Same `Idempotency-Key`, different payload → `422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, no message created or mutated.
- Concurrent duplicate requests racing on the same key → exactly one proceeds to create the resource; the other(s) receive `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`.
- Duplicate worker execution of the same job (simulated double-delivery of a Kafka message) → `processed_events`/attempt-uniqueness prevents a second side effect (`EVENTS.md` §3, `DATABASE.md` §7.2).
- Duplicate attempt creation attempted by two racing processes for the same escalation → exactly one `message_attempts` row is created, verified against the conditional-transaction guard (`FALLBACK_ENGINE.md` §4).
- Provider timeout after acceptance, followed by a retry using the same `provider_idempotency_key` → asserted against the simulator's `TIMEOUT` behavior, verifying the adapter reuses the same key rather than minting a new one (`DATABASE.md` §7.3).

## 5. Fallback concurrency tests

- Concurrent fallback-poller workers racing on the same `deadline_at`-expired attempt → `FOR UPDATE SKIP LOCKED` ensures exactly one worker claims the row; the other sees nothing to process.
- Redis lock loss/unavailability during escalation → escalation still proceeds correctly via the Postgres conditional transaction alone (degraded performance, not degraded correctness), verified by running the critical scenario test with the Redis accelerator forcibly disabled.
- Duplicate fallback-timer fire (the same `deadline_at` check triggered twice, e.g. by a retried scheduler tick) → the second conditional `UPDATE` affects 0 rows and is a verified no-op, not a duplicate escalation.
- Late delivery confirmation arriving after fallback has already escalated → recorded on the superseded attempt, does not regress `messages.status` or trigger a second customer-visible send (`ARCHITECTURE.md` §9b).
- Out-of-order attempt-level events (e.g. `delivered` arrives before `provider_accepted` due to network reordering) → monotonic-state guard prevents an invalid regression.
- A message reaching a terminal state (e.g. via a fast delivery webhook) *just before* its fallback timer fires → the conditional transaction's `status NOT IN (terminal states)` predicate correctly aborts the escalation.
- A hard-pinned channel (`requested_channel_id` set, `cross_channel_fallback_enabled = false`, `ROUTING_ENGINE.md` §1a) with every provider on that channel ineligible → the chain fails per the org's failure policy at that step; the Channel Router never substitutes a different channel, verified by asserting no `message_attempts` row for this message ever has a `channel_id` other than the requested one.
- The same scenario with `cross_channel_fallback_enabled = true` → the Channel Router substitutes the next channel per `fallback_steps`, verified by asserting a subsequent attempt's `channel_id` differs from the requested channel.

## 6. Tenant isolation tests

- Cross-org API attempt: an authenticated caller for Org A supplies Org B's id in a URL/body/header for any resource type → `403`, never a silent scope substitution or leakage (`TENANCY.md` §2).
- Cross-workspace/cross-org role assignment attempt (`RBAC.md` §6's invalid state) → rejected both at the application-validation layer and, if that layer is bypassed, at the database trigger layer — both paths are tested independently.
- Malicious/forged tenant ID in a JWT claim or API payload → rejected because tenant context is derived from the *validated* auth material, never trusted as supplied.
- Worker tenant-context contamination: a test harness deliberately runs two jobs for two different orgs back-to-back on the same pooled DB connection and asserts the second job never sees the first job's RLS context (`TENANCY.md` §5, `DATABASE.md` §14a) — this specifically tests that `SET LOCAL` truly resets at transaction boundary under the pooling strategy actually used.
- Reused DB connection after an error/exception path (not just the happy path) → context is still correctly cleared, verified with a fault-injected mid-transaction failure.

## 7. Billing tests

- Concurrent wallet spending: N concurrent sends for one org, each individually within budget but collectively exceeding available balance → exactly the affordable subset is authorized via the `FOR UPDATE` reservation (`BILLING.md` §8, `DATABASE.md` §10a), never an overspend.
- Duplicate billing event (the ledger-writer consumer receives the same event twice) → exactly one ledger row results, per its own idempotent-consumer guarantee.
- Fallback charging under both `billing_policy` values, matching the worked example in `BILLING.md` §5 exactly.
- Provider failure mid-chain → `provider_cost` entries recorded for failed attempts; `customer_charge` behavior matches policy; reservation correctly released to the actual final amount.
- Refund and adjustment → each produces a new, independently auditable `usage_ledger` row; no historical row is ever mutated.
- Retry of a billing-affecting operation with the same idempotency key → no double charge.
- Pricing versioning (Phase 7+, `BILLING.md` §15): a pricing plan version activated after a transaction was rated does not alter that transaction's already-recorded `usage_ledger` entries; re-querying the historical transaction returns the original `pricing_plan_version`/`pricing_rule` reference, not the currently-active one.
- Attempt-level pricing (`BILLING.md` §16): a fallback chain spanning multiple providers/channels correctly records an independent `pricing_evaluation`/`provider_cost` per attempt, never one shared cost/price across the whole chain.
- Multi-component pricing evaluation (`BILLING.md` §16): a composite transaction (e.g. a simulated Voice AI attempt) correctly records one `pricing_evaluations` row whose `total_customer_price`/`total_provider_cost` equals the sum of its `pricing_evaluation_components` rows — no component is silently dropped or double-counted.

## 8. Webhook tests

- Duplicate provider webhook (`DUPLICATE_WEBHOOK` simulator behavior) → processed exactly once, second delivery acknowledged but not reprocessed (`DATABASE.md` §12 unique constraint).
- Forged webhook (invalid/missing signature) → rejected `401`, never persisted as a verified event.
- Provider webhook replay (an admin replays a `webhook_events` row) → reprocesses idempotently, produces no second business event (`EVENTS.md` §5b).
- Out-of-order webhook (`OUT_OF_ORDER_WEBHOOK` simulator behavior) → monotonic-state guard prevents an invalid status regression.
- Outbound webhook retry → correct exponential backoff sequence, correct `webhook_deliveries` state transitions.
- Outbound webhook replay → re-delivers the same `event_id`/payload, does not regenerate the underlying domain event or trigger a second send (`EVENTS.md` §5d).
- Outbound endpoint sustained failure → correctly transitions to `dead_letter`/`auto_disabled` per configured thresholds, and is recoverable via the DLQ replay path (`RUNBOOK.md`).

## 9. Chaos testing

Fault injection targets: kill a Kafka broker/partition leader mid-flow, inject Postgres connection pool exhaustion, inject Redis latency/unavailability (verifying the Postgres-conditional-transaction path in `FALLBACK_ENGINE.md` §4 still guarantees correctness — see §5 above), and simulate a provider flapping between `HEALTHY`/`CRITICAL` to verify circuit breaker stability (no rapid open/close oscillation — hysteresis in threshold config).

## 10. Security testing

- SAST and dependency vulnerability scanning in CI (blocking on high/critical findings).
- Targeted abuse-case tests per `SECURITY.md` §6: tenant-isolation bypass attempts (cross-org ID substitution on every resource type, §6 above), webhook signature bypass/replay attempts, rate-limit bypass attempts, privilege-escalation attempts via `user_roles`/`role_permissions` manipulation (`RBAC.md` §6 invalid-scope tests), unauthorized provider test-send/admin-operation attempts (`PROVIDER_ADAPTER.md` §4).
- Periodic manual review (`code-review`/security-review discipline) before any phase's production release gate.

## 11. Load/performance testing

Baseline and peak-volume throughput tests against the simulator, measuring API p50/p95/p99 latency, queue consumer lag under sustained load, and Fallback Engine timer accuracy under load (does a 5-minute window still fire within an acceptable jitter bound when the `deadline_at` poller is under load) — thresholds finalized per environment capacity plan in later phases.

## 12. Related

Development lifecycle gate ordering (`TEST` and `SECURITY REVIEW` as explicit stages before `DOCUMENT`/`BUILD`): `ROADMAP.md` §2.
