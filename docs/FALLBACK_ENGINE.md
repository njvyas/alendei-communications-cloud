# Fallback Engine Architecture

## 1. Core principle

Fallback is triggered by **delivery outcome**, not API acceptance. A provider returning HTTP 200 / "accepted" means only that the provider has queued the message for delivery attempt — it is not evidence the recipient received anything. The Fallback Engine's job is to hold each attempt to account against an actual delivery confirmation (or explicit failure) within a bounded window, and escalate when that doesn't happen.

Example (matches the platform requirement verbatim):

```
WhatsApp API accepted
  → wait 5 minutes
  → if not delivered → attempt RCS
      → wait 3 minutes
      → if not delivered → attempt SMS
```

## 2. Fallback policy model, and why it is configuration of *intent*, not a runtime plan

`fallback_policies` + `fallback_steps` (see `DATABASE.md` §4): an ordered list of steps, each naming a channel (and optionally a specific provider — otherwise "any eligible provider on this channel" is resolved fresh at that step), a `wait_window_seconds`, and an `escalation_condition` (`no_delivery`, `explicit_failure`, or `either`).

**`fallback_steps` is never executed blindly.** When the Fallback Engine reaches step N, it does not simply "call the provider named in step N" — it re-runs the full decision sequence from `ARCHITECTURE.md` §3b:

```
Fallback Engine reads fallback_steps[N] (channel + optional pinned provider — the configured INTENT)
        ↓
Eligibility Engine RE-EVALUATES the target (consent/suppression/DLT/capability/quota, using CURRENT data)
        ↓
Channel Router RE-CONFIRMS or substitutes the next viable channel if step N's channel has become wholly ineligible
        ↓
Provider Router RE-RESOLVES the effective routing policy (ROUTING_ENGINE.md §4) and selects among CURRENTLY eligible providers
        ↓
Provider Adapter sends the next attempt
```

This matters concretely: a fallback chain authored as "WhatsApp Provider A → WhatsApp Provider B → RCS → SMS" does not send to WhatsApp Provider B at step 2 if Provider B has since gone `OFFLINE` — eligibility/routing re-evaluation at that step substitutes the next currently-eligible provider on the same channel (or, if the step pins a specific provider with no substitution allowed — an org-configurable strictness setting — the step is skipped and the chain moves to step N+1). Consent and suppression are re-checked too: a contact who opted out between the initial send and a fallback step 5 minutes later must not receive the fallback message.

**Channel substitution is bounded by `requested_channel_id` hard-constraint semantics (`ROUTING_ENGINE.md` §1a).** If the message's `requested_channel_id` is non-null and `cross_channel_fallback_enabled` is not set, the Channel Router re-evaluation step above may only ever re-select among providers on that same channel — it must never substitute a different channel, even if every provider on the pinned channel is currently ineligible. In that case the chain fails at that step per the org's failure policy rather than escalating to a different channel. This is the same re-evaluation machinery described above; the hard constraint only narrows what the Channel Router is permitted to consider, it does not change how re-evaluation itself works.

This directly supports the required chain shapes:

- Simple cross-channel: `WhatsApp → RCS → SMS`, `SMS → RCS → WhatsApp`, `RCS → WhatsApp → SMS`.
- Combined cross-provider **and** cross-channel: `WhatsApp Provider A → WhatsApp Provider B → RCS Provider A → RCS Provider B → SMS Provider A → SMS Provider B` — expressed as six ordered steps, the first two pinned to specific providers on the WhatsApp channel, the next two pinned on RCS, the last two pinned on SMS — each still re-evaluated at the moment it is reached.

## 3. Attempt numbering (single convention, used everywhere)

**`message_attempts.attempt_number` is one global, monotonically increasing integer per message: 1, 2, 3, ...** — there is no second "fallback attempt number." Attempt 1 is the initial send; attempt 2 is the first fallback escalation; attempt 3 is the second; and so on, regardless of how many channels or providers are involved. This single counter is authoritative everywhere (`DATABASE.md` §6, `ARCHITECTURE.md` §5); earlier drafts of this document set additionally proposed a `messages.fallback_attempt_number` field — that field is **removed**, replaced by `messages.current_attempt_number`, a denormalized mirror of `current_attempt_id.attempt_number` (`DATABASE.md` §6), so there is exactly one counter, not two overlapping ones.

A **retry** is distinct from a **new attempt** and must never be confused with one:

| | New attempt (`attempt_number` increments) | Retry (`message_attempts.retry_count` increments) |
|---|---|---|
| Trigger | The Fallback Engine decides to escalate (§2) | The adapter itself times out/gets a transient error (e.g. `429`, connection reset) before ever learning whether the provider processed the request |
| Creates a new `message_attempts` row? | Yes | No — same row, `retry_count` bumped, a `message_events` row appended |
| Changes `channel_id`/`provider_id`? | Usually (escalates to next step) | Never — same channel, same provider |
| Governed by | `fallback_steps` config + re-evaluation (§2) | Adapter-level bounded retry policy with jittered backoff (`ARCHITECTURE.md` §9c) |

## 4. Timer mechanics — PostgreSQL is the source of correctness, Redis is an accelerator only

A wait window is implemented as `message_attempts.deadline_at` (`DATABASE.md` §6, §13) — a plain column, not a fact that only exists inside Redis or a message broker. The **authoritative** mechanism for firing a fallback escalation is a scheduled poller querying Postgres directly:

```sql
SELECT id, message_id, attempt_number
FROM message_attempts
WHERE status = 'provider_accepted'
  AND deadline_at <= now()
FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE SKIP LOCKED` lets multiple poller workers run concurrently without colliding — a row already claimed by one worker is invisible to another, so there is no need for an external lock just to distribute the polling work. Redis MAY additionally maintain a sorted-set index of `(deadline_at, attempt_id)` purely as a **performance accelerator** (avoiding a full-table scan under high volume) — but it is rebuildable from Postgres at any time and is never the thing a correctness argument depends on. If Redis is down, the poller falls back to the query above directly; escalation is slower under load, never wrong.

Once a candidate row is claimed, the escalation itself is a single conditional transaction — this is the actual "duplicate-escalation" guard, and it is a database compare-and-swap, not a distributed lock:

```sql
BEGIN;
UPDATE messages
SET current_attempt_id = NULL,   -- cleared until the new attempt row is created below; see note
    status = 'ROUTING',
    state_version = state_version + 1,
    updated_at = now()
WHERE id = :message_id
  AND current_attempt_id = :expected_current_attempt_id   -- the attempt this poll run believes is still current
  AND state_version = :expected_state_version              -- optimistic-concurrency guard
  AND status NOT IN ('DELIVERED', 'READ', 'FAILED', 'EXPIRED');  -- refuse to escalate a message already terminal
-- if the above UPDATE affected 0 rows: ROLLBACK and exit — another worker already
-- transitioned this message, or a delivery webhook already reached a terminal state.
-- The escalation is a no-op, not a duplicate.

-- if it affected 1 row: this worker owns the escalation.
INSERT INTO message_attempts (id, message_id, attempt_number, channel_id, provider_id, ...)
VALUES (:new_attempt_id, :message_id, :expected_current_attempt_number + 1, :resolved_channel_id, :resolved_provider_id, ...);

UPDATE messages
SET current_attempt_id = :new_attempt_id,
    current_channel_id = :resolved_channel_id,
    current_provider_id = :resolved_provider_id,
    current_attempt_number = :expected_current_attempt_number + 1
WHERE id = :message_id;
COMMIT;
```

This single transaction is what closes the race between "a delivery webhook arrives at t=4:59.9 of a 5-minute window" and "the timer fires at t=5:00": whichever writes first under this conditional guard wins — the delivery webhook's own write (marking the attempt/message terminal) makes the `status NOT IN (...)` predicate false for the escalation transaction that follows, so it affects 0 rows and aborts cleanly; conversely if escalation commits first, the late-arriving webhook's write still records against the now-superseded attempt (for audit/billing accuracy) but the `FALLBACK_ENGINE.md`-owned monotonic guard (`ARCHITECTURE.md` §9b) prevents it from un-escalating.

**This same pattern is what the Redis-lock-loss, duplicate-Kafka-event, duplicate-scheduler-execution, and worker-crash scenarios all reduce to**: every one of them can, at worst, cause the conditional transaction above to be *attempted* twice — never to *succeed* twice, because the second attempt's `WHERE` predicate no longer matches after the first attempt's commit. A worker crash between claiming a row (`FOR UPDATE SKIP LOCKED`) and committing simply releases the row lock at connection close, making it visible to the next poller pass — no partial state is ever left, because the whole escalation is one transaction.

## 5. Duplicate-send prevention across a fallback chain

- Each attempt has its own `provider_idempotency_key` (`DATABASE.md` §7.3), so a retried *send* to a given provider within one attempt can never itself duplicate at the provider, where the provider supports such a key.
- The conditional transaction in §4 ensures only one process ever transitions a given message from "awaiting confirmation" to "escalating."
- Escalating to attempt N+1 does not cancel/recall a still-in-flight attempt N delivery at the transport level (most providers offer no such API) — instead, the *original* channel's late delivery is treated as informational: it updates that (now-superseded) attempt's own record but the message is already considered delivered via the channel/attempt that won, and no second customer-visible send occurs from ACC's side. This is a deliberate, disclosed design tradeoff (a recipient could theoretically receive both the original and the fallback message if the original message actually lands after being deprioritized) — see `DECISIONS.md` "risks explicitly accepted by design."

## 6. "Exactly-once business outcome" vs. transport delivery

The platform commits to: at most one *active* attempt is authoritative at any time (enforced by §4's conditional transaction), **a single financially authoritative billing lifecycle/outcome per billable transaction or logical communication lifecycle** (for a fallback chain, the billable transaction is the logical message, `BILLING.md` §10) — while the number, timing, and amount of customer-charge ledger entries produced within that outcome are determined by the applicable billing policy (§7 below) and pricing policy (`BILLING.md` §17), never assumed to be "exactly one charge" — and the customer-visible status is always reconciled to the best evidence available. It does **not** commit to preventing an external provider from ever double-delivering on its own network, or to guaranteeing a recipient's device never receives more than one physical message across a fallback chain — this is stated plainly rather than implied, consistent with `DATABASE.md` §7.3's provider-side-idempotency limitation.

## 7. Billing interaction (formal policy, not a deferred TODO)

There is one financially authoritative billing lifecycle/outcome for the billable transaction (here, the logical message) across a fallback chain. That does **not** mean one charge, one provider, or one cost — it means the *outcome* (what the org was ultimately, correctly billed) is singular and reconstructable, while the underlying attempts remain individually priced and costed. Every executed attempt that reaches the provider (i.e., was actually sent, not merely eligible) produces its own `usage_ledger` `provider_cost` entry, because the tenant's provider cost is real regardless of which attempt ultimately succeeds — and each attempt can carry a **different provider, a different provider cost, a different pricing evaluation/rating basis (potentially itself multi-component, `BILLING.md` §16), a different routing policy (version), and a different commercial context** (`BILLING.md` §§10–16), e.g.:

```
Attempt 1 → WhatsApp Provider A   (provider cost X1, routing policy version V1)
Attempt 2 → RCS Provider B        (provider cost X2, routing policy version V2)
Attempt 3 → SMS Provider A        (provider cost X3, routing policy version V1)
```

`organizations.billing_policy` (`DATABASE.md` §2) determines `customer_charge` behavior across the chain — see `BILLING.md` §5 for the full worked example against the canonical five-attempt chain:

- **`charge_per_logical_message`** (platform default): one `customer_charge` ledger entry, recorded when the chain reaches a terminal state (success — charge the standard rate; total failure — charge zero, or a configurable reduced "failed delivery" fee, per the org's rate card).
- **`charge_per_attempt`** (opt-in): a `customer_charge` entry per attempt that reached a provider, regardless of individual outcome.

Funds for the *maximum possible* chain cost are reserved up front via the reservation mechanism (`DATABASE.md` §10a, `BILLING.md` §8) at the initial send, and any unused reservation is released once the chain reaches a terminal state — this is what makes fallback-chain billing safe under concurrent sends without either overspending the wallet or under-reserving against a long chain.

## 8. Related

Provider/channel eligibility inputs and routing precedence: `ROUTING_ENGINE.md`. Timer/event mechanics and the attempt-vs-message event split: `EVENTS.md` §§4–6. Reservation/authorization flow: `BILLING.md` §8. The end-to-end automated test for the full-chain-exhaustion scenario, including the re-evaluation and no-duplicate-delivery assertions: `TESTING.md` §3.
