# Provider Abstraction Architecture

> **Phase 2 status (ADR-013): SCOPE FROZEN; 2.1 (channel and provider registry, migrations `0018`–`0019`) CLOSED (Gate D.1); 2.2 (adapter contract and `SimulatorAdapter`, migrations `0020`–`0021`) CLOSED (Gate D.2); 2.3 (health and circuit breaker, migration `0022`) IMPLEMENTED — Gate D.3 pending review; 2.4–2.6 not implemented.**

## 1. Purpose

No module outside `provider-adapters` may know a specific vendor's API shape. Adding, removing, or replacing a provider is a configuration + adapter-implementation change, never a change to campaign, journey, billing, or orchestrator logic.

## 2. Provider Adapter Interface

Every provider integration implements the same TypeScript interface. **Finalized in Phase 2.2** as `ProviderAdapter` in `packages/contracts/src/provider-adapter.ts` (the sketch below is the original shape; the finalized port differs as noted after it):

```ts
interface ProviderAdapter {
  readonly providerId: string;
  readonly channel: ChannelCode;

  capabilities(): ProviderCapabilities;              // static + dynamically-updatable declared support
  healthCheck(): Promise<ProviderHealthSnapshot>;     // lightweight synthetic probe
  estimateCost(msg: UnifiedMessage): Promise<Money>;  // pre-send cost estimate, for routing + billing preview

  send(msg: UnifiedMessage): Promise<ProviderSendResult>;      // acceptance, not delivery
  checkStatus(providerMessageId: string): Promise<ProviderStatusResult>; // polling fallback where no webhook exists

  parseWebhook(rawRequest: RawWebhookRequest): Promise<NormalizedProviderEvent[]>; // verify + normalize, no side effects
}
```

- `send()` returns acceptance/rejection only — never asserts delivery. Delivery confirmation is always a separate signal (webhook or `checkStatus` poll), enforcing the "acceptance ≠ delivery" principle load-bearing for `FALLBACK_ENGINE.md`.
- `parseWebhook()` is pure (verify signature, normalize payload) — persistence and state transition happen in the `webhooks` module, keeping adapters side-effect-free on the inbound path and easy to unit test.
- **The finalized port (Phase 2.2).** `send(context, submission, options)` takes a `ProviderAdapterContext` — provider id, adapter key, channel and the provider's declared capabilities; **no credential**, ever — a `ProviderSubmission` (`submissionId` assigned by ACC and stable for the attempt, `correlationId`, channel, recipient, content) and `{ timeoutMs, signal }`, and returns `accepted` (with the provider's `providerMessageId`) or `rejected` (with a normalized `ProviderFailure`: `category`, `retryable`, `providerCode`, `message`), each carrying the submission and correlation ids and `latencyMs`. `capabilities()` declares the channels an adapter serves; `healthCheck(context, options?)` returns `{ healthy, latencyMs }`; Phase 2.3 added the optional `options` (`{ timeoutMs, signal }`, additive — an existing adapter is unaffected) so an unanswered probe can be aborted, and the executor's `probe()` runs it under `PROVIDER_HEALTH_DEFAULTS.PROBE_TIMEOUT_MS` (3000 ms), mapping no answer to `timeout` and a thrown error or out-of-contract answer to `unhealthy`, never `healthy`. `SimulatorAdapter.forHealthBehavior('HEALTHY' | 'UNHEALTHY' | 'TIMEOUT')` answers deterministically. The `ProviderSubmissionExecutor` (`apps/api/src/provider-adapters/`) runs every submission: it enforces the platform timeout (`PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS`, 3000 ms) by aborting the adapter's wait, maps a thrown error or an out-of-contract result to `UNKNOWN`, recomputes `retryable` from the category, stamps the ids and measures latency on an injectable clock, and counts the submission (`acc_provider_submissions_total{channel, outcome}`).
- **Phase 2 implementation boundary (ADR-013 PD-3, PD-6).** Phase 2 implements `capabilities()`, `healthCheck()` and `send()` (exercised only through the direct test-send, `ROADMAP.md` §5b 2.2). `estimateCost()` (billing, Phase 7), `checkStatus()` and `parseWebhook()` (message lifecycle, Phase 3) exist as interface members only; the simulator refuses them explicitly and they carry no Phase 2 behaviour.
- Failure taxonomy is normalized: every adapter maps vendor-specific error codes to a shared enum (`PROVIDER_FAILURE_CATEGORIES`: `TIMEOUT, PROVIDER_ERROR, RATE_LIMITED, AUTH_ERROR, INVALID_REQUEST, INVALID_RECIPIENT, UNSUPPORTED_CONTENT, CONFIGURATION_ERROR, UNKNOWN`) so the Fallback Engine and reporting never branch on vendor-specific codes. `retryable` is fixed per category (`TIMEOUT`, `PROVIDER_ERROR`, `RATE_LIMITED`), never per vendor. Phase 2.2 added `INVALID_REQUEST` (a malformed request is not an unclassifiable failure) and `CONFIGURATION_ERROR` (the failure is ours — an adapter that cannot perform the submission — not the provider's). An **unregistered adapter key** is not a submission outcome: it is a resolution failure, refused before any adapter runs (`422 PROVIDER_ADAPTER_UNKNOWN`).

### 2a. Provider-side idempotency (adapter responsibility, not a platform guarantee)

`send(msg)` receives `message_attempts.provider_idempotency_key` (`DATABASE.md` §6, deterministically derived from the attempt's own `id`, stable across retries of that same attempt). Every adapter implementation **must**:

- Pass this key through as the provider's own idempotency/dedup key wherever the provider's API accepts one (most modern messaging APIs do).
- Where the provider has no such mechanism, prefer calling `checkStatus()` (if the provider exposes any correlatable lookup) before re-sending after a timeout, and otherwise accept — and never silently hide — the residual duplicate-submission risk documented in `DATABASE.md` §7.3. This is why `ARCHITECTURE.md` §9 states plainly that ACC guarantees exactly-once *business outcome*, not exactly-once *external delivery*: the guarantee bottoms out at whatever the specific provider's own API actually supports, and no adapter may claim a stronger guarantee than its provider genuinely offers.

## 3. Provider Registry

`providers` + `provider_credentials` + `provider_capabilities` + `provider_health` (see `DATABASE.md` §3) back a registry service that:

- Resolves, for a given channel + tenant, the set of enabled, credentialed adapters and their current capabilities.
- Loads credentials by reference (`credential_ref`) from the secrets backend at call time — the credential's plaintext value never sits in application config, environment dumps, or logs (see `SECURITY.md`).
- Publishes `alendei.providers.health_changed.v1` on any health/circuit transition, and is invalidated/refreshed via a Redis pub/sub signal when an admin edits a provider — this is the mechanism behind "no redeploy required" for provider changes.

**Phase 2 (ADR-013).** The registry is built over `channels`, `providers` and `provider_capabilities` (2.1) and `provider_health` (2.3); **`provider_credentials` is not built** (§4a). Resolution "for a given channel + tenant" is a later-phase concern: Phase 2 has no tenant-facing resolution, because the catalogue is platform-only. **No event is published in Phase 2** — there is no outbox (ADR-013 PD-1); transitions are recorded in `audit_logs` and metrics. **Phase 2.2:** `ProviderAdapterRegistry` (`apps/api/src/provider-adapters/adapter-registry.ts`) resolves `adapter_key → adapter`, built once from code at startup. It fails at construction if a key is registered twice or if the registered set and `PROVIDER_ADAPTER_KEYS` disagree, and `resolve` throws for any unregistered key (case- and whitespace-exact; no prototype keys), which the API answers `422 PROVIDER_ADAPTER_UNKNOWN`. A provider's adapter key always comes from its catalogue row, never from a request. Redis pub/sub invalidation is built in 2.4 as **best-effort configuration invalidation with bounded convergence** — not transactional configuration propagation: the update commits first, the invalidation is published after commit, subscribers evict on receipt, and the cache TTL bounds staleness if a publication is lost. `providers.adapter_key` names an adapter registered in code; in Phase 2 the only key is `simulator` (ADR-013 F-9).

## 4. Admin operations (no deploy, no restart) — all privileged, all audited

**Phase 2 partition (ADR-013 PD-5, PD-6).** In Phase 2: add, update, replace capabilities, enable, disable, drain (2.1); test a provider against the simulator (2.2 — **implemented**: `POST /providers/:id/test-send`, `providers.test_send` at platform scope, an `active` provider only, the adapter from the provider's catalogue row, a caller-chosen simulator behaviour and nothing else, a synthetic payload, no message persisted, `provider.test_sent` audited); run a health check and override health manually (2.3 — **implemented**: `POST /providers/:id/health-check`, `POST /providers/:id/health`, `GET /providers/:id/health`; §5–§6). **Not in Phase 2:** priority/weight, routing-policy assignment, traffic and canary migration, rollback via routing-policy versions, and per-provider health-threshold configuration (Phase 2 uses fixed platform defaults, ADR-013 F-6). Phase 2 administration is platform scope only: `AuthorizationService` enforces `providers.read`, `providers.manage` and `providers.test_send` at platform scope and RLS enforces platform-scope eligibility (ADR-013 F-3). The permissions are currently granted only to `alendei_super_admin`; that is a grant, not the boundary (F-4).

All of the following are DB writes to `providers`/`provider_capabilities`/`routing_policies` plus a cache-invalidation broadcast — never a code or config-file change. **Every one of them is a privileged operation**: gated behind the `providers.manage` permission (or the narrower `providers.test_send` for test-sends specifically), and every invocation writes an `audit_logs` row with the actor, the exact before/after values, and the target provider — with no exception, since a mis-issued priority/weight/drain change can silently redirect real traffic and a test-send can incur real provider cost or generate a real customer-visible message once a real provider is connected.

- Add / enable / disable a provider.
- Drain a provider (`providers.status → draining`: stop accepting *new* messages, let in-flight attempts complete). Draining is an **administrative status**, not a health state (ADR-013 F-5).
- **Test a provider**: sends a synthetic message through the simulator-backed test path in Phase 0–2 (`TESTING.md` §2); once real providers are connected (post-Phase-12 business decision, never in this repository without separate explicit authorization), a test-send is capable of incurring real cost or reaching a real recipient, so it additionally requires an explicit target (never a wildcard/broadcast test), environment awareness (a production test-send is a deliberately higher-friction action than a staging one — e.g. an additional confirmation step), and is subject to the same rate limiting as any other send path so a misconfigured test loop cannot itself become a cost or abuse incident.
- Change priority / weight / routing policy assignment.
- Configure health thresholds (error-rate/latency windows that drive automatic health/circuit transitions).
- Migrate traffic between providers, including canary migration (route X% to a new provider, monitor, ramp).
- Roll back a provider or routing change (activate a prior `routing_policy_versions` row; re-enable a disabled provider).

## 4a. Credential ownership & precedence

> **NOT FROZEN — superseded pending a channel-phase ADR (ADR-013 PD-2, F-1).** This section and `DEPLOYMENT.md` §0f / `SECURITY.md` §3a described two incompatible models (a platform/reseller/organization *configuration* scope with a NULL platform `scope_id`, versus a *tenant-scoped* five-level scope with `org_id` for RLS). Neither is adopted and no hybrid is defined; `provider_credentials` is not built in Phase 2. The text below is retained as input to that ADR, not as a commitment. Binding now, because both models agree: the value is a `<backend>:<locator>` reference resolved through `SecretsPort`; the secret never enters PostgreSQL, logs, metrics, audit rows, API responses or any frontend; Alendei-, reseller- and organization-owned credentials must be able to coexist in one shared deployment. Phase 2.5 is **documentation only** — no resolver port, type, interface or resolution code (`ROADMAP.md` §5b). **Credential architecture requires a separate reviewed decision (its own ADR) before implementation.** Future integration boundary: resolution happens server-side, at call time, behind `SecretsPort`, never in adapter code.

Per `DATABASE.md` §3, a provider credential is owned at exactly one of three scopes, and selection at send time always prefers the most specific match:

```
organization-owned credential (this org has its own contract/keys with the provider)
        ↓ (if none active)
reseller-owned credential (the org's reseller supplies a shared credential for its book of organizations)
        ↓ (if none active)
platform-owned credential (Alendei's own shared/default credential for the provider)
```

`provider_credentials.scope_type` is a **configuration** scope (`platform`, `reseller`, `organization` — it stops at organization because credentials are never workspace- or team-owned) and is a different enum from the five-value authorization scope on `user_roles` (`TENANCY.md` §1a.2). Only one credential per `(provider_id, scope_type, scope_id)` may be `is_active` at a time. Viewing/managing a credential requires a permission scoped to its own `scope_type` (an organization admin can manage only their own organization-scoped credentials, never a reseller- or platform-scoped one; a reseller admin can manage their reseller-scoped credentials but not another reseller's). **No credential's plaintext value is ever exposed to any frontend client at any scope** — only `credential_ref` metadata (a label, `rotated_at`, `scope_type`) is ever returned by the API; the raw secret is resolved server-side, at call time, directly from the secrets backend (`SECURITY.md` §3). Rotation and revocation follow `RUNBOOK.md` §"Provider credential rotation" regardless of which scope owns the credential.

## 5. Provider health (Phase 2.3 — canonical)

> **Status:** the model below was frozen before the 2.3 implementation was written (ADR-013 "2.3 design", commit `f09c4b2`) and implemented as stated (migration `0022`; `apps/api/src/providers/provider-state-machine.ts` — the pure functions, one per rule — and `provider-state.store.ts`, the only writer). **Amended at the Gate D.3 review** (ADR-013 "Gate D.3 remediation", migration `0023`): the circuit parameters became a persisted, administrable policy (§6a, §6i); the single probe slot became `halfOpenMaxProbes` slots (`circuit_probes`); the production failure classification (§5b) and the routing-eligibility contract (§6h) were made canonical. Phase 2.3 performs **no traffic switching**: it establishes the authoritative state the future Provider Router consumes (§6h).

### 5.0 Three independent axes

| Column(s) on `providers` | Values | Written by | Meaning |
|---|---|---|---|
| `status` | `active`, `disabled`, `draining` | `providers.manage` only (enable / disable / drain, 2.1) | Administrative lifecycle — an operator decision |
| `health_state`, `health_override`, `health_changed_at` | `healthy`, `degraded`, `critical`, `offline` | derived from samples (§5c) or set by a manual override (§5d) | Observed health over a slow window |
| `circuit_state`, `circuit_generation`, `circuit_changed_at`, `circuit_probes`, `circuit_probe_successes` | `closed`, `open`, `half_open` | the circuit breaker only (§6), from submission samples and the clock | Fast load-shedding over a short window |

The three are evaluated in a fixed order — **Lifecycle → Health → Circuit → future Provider Router eligibility** (§6h). No axis writes another: a lifecycle transition never changes health or circuit state, and health and circuit never change `status`. `DRAINING` is not a health state (ADR-013 F-5): a draining provider is excluded from *new* routing decisions while in-flight attempts complete — applied by the router in a later phase.

| Health state | Meaning | Effect on routing (later phase) |
|---|---|---|
| `healthy` | Normal operation, or too few observations to conclude otherwise | Fully eligible |
| `degraded` | Elevated failure rate or latency below the critical threshold | Eligible but de-weighted by quality/latency-aware policies |
| `critical` | Failure rate at or above the critical threshold | Eligible only as last resort / excluded depending on policy config |
| `offline` | A run of consecutive failures, or manually marked down | Excluded from routing |

**In Phase 2 health gates nothing**: no request is refused because of a health state. Health is recorded, audited and exported as metrics; routing eligibility (the conjunction of the three axes) is a later phase.

### 5a. Samples (`provider_health`, append-only)

One row per observation, written in the same transaction as the state it produced and its audit rows. Only three things produce a sample in Phase 2 (ADR-013 F-6) — there is no scheduler, prober or worker:

| `kind` | Produced by | `outcome` | `source` |
|---|---|---|---|
| `submission` | a test-send that reached the adapter (`POST /providers/:id/test-send`) | `accepted`, or the failure category in lower case (`timeout`, `provider_error`, `rate_limited`, `auth_error`, `invalid_request`, `invalid_recipient`, `unsupported_content`, `configuration_error`, `unknown`) | `automatic` |
| `probe` | an explicit health check (`POST /providers/:id/health-check`) | `healthy`, `unhealthy`, `timeout` | `automatic` |
| `override` | a manual override set or cleared (`POST /providers/:id/health`) | `manual` | `manual` |

Each row also carries `classification` (§5b), `latency_ms` (null for `override`), `health_state` and `circuit_state` **after** the sample was applied, `circuit_generation` (the circuit episode the observation belongs to, §6d), `circuit_policy_version` (the circuit policy the decision used, §6a), `observed_at` (the injected clock) and `created_at` (database time). A test-send refused by the circuit (§6c) never reached the provider, so it is **not** a sample; it is audited and counted instead. A row can never be updated or deleted (append-only trigger; no `UPDATE`/`DELETE` grant).

### 5b. Failure classification (one table, used by health and circuit alike)

**What drives the breaker.** In Phase 2 the only submissions are explicit test-sends to the simulator, so test-send outcomes are what the circuit consumes. **That is a source, not a design limit:** the circuit engine (`provider-state-machine.ts`, `ProviderStateStore`) consumes a normalized `ProviderSubmissionResult` and nothing else. When real providers carry production traffic (a later, separately authorized phase), every real submission's outcome is fed to the same engine, through the same admission and recording, with the same classification — no second breaker, no different rules. A real adapter must therefore map every vendor answer onto the normalized taxonomy (`PROVIDER_ADAPTER.md` §2) exactly as below.

**Counts as provider failure** — the provider is unavailable, overloaded, or failing in a way that sending again immediately cannot fix and may worsen. These are exactly the signals a breaker exists to act on:

| Production signal | Normalized outcome | Why it counts |
|---|---|---|
| No answer within the submission timeout | `timeout` | Availability: the provider did not answer at all |
| Connection or network failure (refused, reset, DNS, TLS handshake) before any answer | `provider_error` (adapter maps it) | Availability: the provider cannot be reached; every immediate retry will fail the same way |
| HTTP 5xx, provider outage | `provider_error` | The provider failed on its own side |
| Provider rate limiting, HTTP 429, throughput cap | `rate_limited` | The provider is shedding load; continuing to send is the harm the breaker prevents |
| Other provider-side transient errors (e.g. "temporarily unavailable", queue full) | `provider_error` | Transient provider-side unavailability |
| Any other provider availability failure an adapter explicitly classifies | `provider_error` | Same reason, by explicit classification |
| An answer no adapter could classify | `unknown` | Not in the frozen list, deliberately counted: an unexplained failure mode fails **safe** (it can open the circuit) rather than silently keeping a failing provider in traffic. Flagged for review at Gate D.3 |

**Does not count as provider failure** — the provider answered and is working; the rejection is about *this* request, credential or configuration, would be identical on any retry or any provider, and waiting cannot fix it. Counting it would let one bad client or bad template open the circuit and take a healthy provider out of traffic for everyone:

| Production signal | Normalized outcome | Why it is excluded |
|---|---|---|
| Invalid request (malformed payload, missing field) | `invalid_request` | The request's fault, not the provider's |
| Invalid recipient (bad number or address) | `invalid_recipient` | The request's fault |
| Unsupported content (media type, size, encoding) | `unsupported_content` | The request's fault |
| Authentication or credential rejection | `auth_error` | A deterministic configuration problem: the provider is up, and opening the circuit would not repair the credential. Surfaced by the test-send result, its audit row and logs |
| Configuration error (adapter cannot build the submission) | `configuration_error` | Ours; the provider was not reached |
| Customer or business-rule rejection (opt-out/DND, template not approved, sender not registered, content policy) | mapped by the adapter to `invalid_recipient`, `unsupported_content` or `invalid_request` | A rule about this message or this customer, not provider availability; no new category is needed for the breaker to treat it correctly |

Probes and overrides: probe `healthy` is a success; probe `unhealthy` and `timeout` are failures (they feed health only, never the circuit); an override (`manual`) is neutral — a decision, not an observation.

A **neutral** sample is recorded but is neither a success nor a failure: it is excluded from every window, so a burst of bad requests can neither trip the circuit nor dilute a real provider failure rate. The classification is persisted on the sample and checked by the database, so history does not change meaning if the table ever does.

### 5c. Automatic derivation — a pure function of the window

The **health window** is the most recent 20 counted (success or failure) samples of kind `submission` or `probe` with `observed_at` in `(now − 300 s, now]`, newest first. With `n` samples, `f` failures, and `streak` the number of consecutive failures at the head, the derived state is the first rule that matches:

| # | Condition | Derived state |
|---|---|---|
| 1 | `n < 5` | `healthy` (too few observations to conclude anything) |
| 2 | `streak ≥ 5` | `offline` |
| 3 | `f × 100 ≥ 50 × n` | `critical` |
| 4 | `f × 100 ≥ 20 × n` | `degraded` |
| 5 | at least one success, and the mean `latency_ms` of the successes `≥ 1000` | `degraded` |
| 6 | otherwise | `healthy` |

The effective state is `health_override` when one is set, otherwise the derived state. Health is therefore **not an edge-driven machine**: every change between two distinct states is permitted, and is made only by (a) recording a sample (automatic) or (b) setting or clearing an override (manual). It is re-evaluated **lazily** — only when one of those happens, never on a timer — so a stored state is the state as of its last evaluation (`health_changed_at` records when it last changed). Every change writes `provider.health_changed` (before, after, `source`, `cause`); an evaluation that changes nothing writes nothing.

### 5d. Manual override

`POST /providers/:id/health` (`providers.manage`) with `{ "override": "healthy" | "degraded" | "critical" | "offline" | null, "reason"?: string }`. A value pins `health_state` to it until cleared — automatic samples are still recorded but no longer move health. `null` clears the pin and the state is re-derived from the window at once. Setting the override already in force changes nothing and records nothing (naturally idempotent). A real change writes an `override` sample, `provider.health_overridden` (before/after override and state, the reason) and, if the effective state moved, `provider.health_changed`. An override never touches the circuit.

### 5e. Health check (synthetic probe)

`POST /providers/:id/health-check` (`providers.manage`) with `{ "behavior": "HEALTHY" | "UNHEALTHY" | "TIMEOUT" }` runs the adapter's `healthCheck()` under a 3000 ms timeout (the simulator answers deterministically per behaviour; no network, no credential). It is a diagnostic: permitted in **every** lifecycle status and **every** circuit state, it feeds health only — a probe never opens, half-opens or closes the circuit. The probe runs outside any transaction; a second transaction re-checks authority (`app_has_platform_permission('providers.manage')`, as test-send does) and writes the `probe` sample, `provider.health_checked` (`success` for `healthy`, `failure` for `unhealthy`/`timeout`) and any `provider.health_changed`.

## 6. Circuit breaker (Phase 2.3 — canonical)

A distinct, faster signal than health: it sheds load quickly during a burst rather than waiting for the slower health window. Circuit and health are tracked and transitioned independently — a provider can be `healthy` while `open`, and vice versa. **Only submission samples drive the circuit**; probes and overrides never do.

### 6a. The circuit policy — persisted, administrable, bounded

The parameters are a **persisted, platform-wide policy** (`provider_circuit_policy`, one row, migration `0023`), administered by `providers.manage` platform administrators (`GET`/`PUT /provider-circuit-policy`, §6i). They apply to every provider. There are no per-provider overrides in Phase 2. *(Amends ADR-013 F-6 at the Gate D.3 review: the circuit thresholds were fixed platform defaults; they are now administrable platform defaults. The health thresholds of §5c remain fixed.)*

| Parameter (API field) | Meaning | Seeded default | Safe bounds |
|---|---|---|---|
| `windowMs` | Evaluation window: counted submission samples of the current generation with `observed_at` in `(now − windowMs, now]` | 60 000 | 10 000 – 3 600 000 |
| `windowMaxSamples` | Maximum samples: at most this many of the most recent | 20 | 1 – 200, and `≥ minSamples` |
| `minSamples` | Minimum samples: the window must hold at least this many to open | 5 | 1 – 200, and `≤ windowMaxSamples` |
| `failurePercent` | Failure-rate threshold: opens when `failures × 100 ≥ failurePercent × samples` | 50 | 1 – 100 |
| `cooldownMs` | Cooldown duration in `open` before the next submission may half-open it | 30 000 | 1 000 – 3 600 000 |
| `halfOpenMaxProbes` | HALF_OPEN probe count: probes admitted at once | 1 | 1 – 10 |
| `probeLeaseMs` | Probe lease duration: a probe slot not released within it is reclaimable | 10 000 | 5 000 – 600 000 (always above the 3 000 ms submission timeout, so a live probe is never reclaimed) |
| `halfOpenSuccessesToClose` | Successful probes required to close | 2 | 1 – 20 |

The bounds are enforced by the API (`400` with per-field issues) **and** by database `CHECK` constraints, so no writer can persist an unsafe value. The row carries a `version` that increases by exactly one on every change (enforced by a trigger).

**How a change takes effect — deterministically.** Every circuit decision (an admission, a recording) reads the policy **inside its own transaction, after taking the provider row lock**, and uses that one version for the whole decision; the version is recorded on the sample (`circuit_policy_version`) and in every `provider.circuit_changed` row. A committed change therefore governs every decision made after it, and none made before it. Specifically: a new window, minimum, maximum or threshold applies at the next evaluation; a new cooldown applies to every `open` circuit at its next admission (measured from `circuit_changed_at`); a new probe count applies at the next admission — probes already in flight above a lowered count finish or expire, and no new one is admitted until the count is below the new limit; a new lease applies to probes claimed after it (a claim carries its own lease); a new success count applies at the next successful probe. No change rewrites a stored state, and no change by itself causes a transition.

**Concurrency-safe updates.** `PUT` carries `expectedVersion` (required). The update locks the policy row, compares the version and writes only on a match; a stale version is `409 RESOURCE_CONFLICT` with `details.currentVersion`, and nothing changes. Of two concurrent updates from the same version, exactly one succeeds. Re-sending the values already in force changes and records nothing.

### 6b. Transition table — the only four edges

| # | From → To | Event | Guard | Cause recorded |
|---|---|---|---|---|
| T1 | `closed → open` | a counted submission sample of the current generation is recorded | the window holds `≥ minSamples` samples and `failures × 100 ≥ failurePercent × samples` | `failure_threshold` |
| T2 | `open → half_open` | a submission asks for admission | `now ≥ circuit_changed_at + cooldownMs` | `cooldown_elapsed` |
| T3 | `half_open → open` | a current probe's sample is recorded | classified **failure** | `probe_failed` |
| T4 | `half_open → closed` | a current probe's sample is recorded | classified **success** and it brings the episode's successful probes to `halfOpenSuccessesToClose` | `probes_succeeded` |

Every edge increments `circuit_generation` by exactly 1, sets `circuit_changed_at = now`, clears every probe slot and resets `circuit_probe_successes` to 0, and writes `provider.circuit_changed` (before/after state and generation, cause, the policy version, and the window figures for T1). No other change of `circuit_state` exists: `closed → half_open`, `open → closed` and every self-transition are impossible, and the database refuses them (§6e). There is no manual circuit control; an `open` circuit recovers only through cooldown and probes. T1 is evaluated after **every** counted sample — including a success that brings the window to its minimum size — because the rule is about the window, not the last call. Probes still in flight when T3 or T4 fires become stale (§6d).

### 6c. Admission (before the adapter is called)

| Circuit state | Condition | Decision |
|---|---|---|
| `closed` | — | admitted as a normal submission (ticket: current generation) |
| `open` | cooldown not elapsed | **refused** — `409 PROVIDER_CIRCUIT_OPEN`, `details.circuitState = "open"`, `details.retryAfterMs` |
| `open` | cooldown elapsed | T2, then as `half_open` below |
| `half_open` | fewer than `halfOpenMaxProbes` live probe slots (expired leases do not count — they are released, logged and counted as `abandoned`) | admitted as **a probe**: a new slot `{ id, leaseUntil = now + probeLeaseMs }` (ticket: generation + probe id) |
| `half_open` | `halfOpenMaxProbes` live slots held | **refused** — `409 PROVIDER_CIRCUIT_OPEN`, `details.circuitState = "half_open"` |

A refusal calls no adapter, writes no sample, and writes `provider.test_sent` with outcome `failure` and `after.outcome = "short_circuited"` (ADR-013 F-7: "recorded as such").

### 6d. Recording (after the adapter answered)

The sample is always inserted, tagged with the ticket's generation and the policy version used. Then, against the locked row:

- **Stale ticket** — its generation is not the current one, or it is a probe whose id no longer holds a slot: the sample is recorded (it still informs health) and **changes nothing in the circuit**. This is what stops a slow answer from an earlier episode, or an abandoned probe, from closing a re-opened circuit, re-opening a closed one, releasing someone else's probe slot or polluting the new episode's window.
- **`closed`**, current ticket: evaluate T1.
- **`half_open`**, a current probe: release its slot; **failure** → T3; **success** → `circuit_probe_successes + 1`, and T4 when it reaches `halfOpenSuccessesToClose`; **neutral** → nothing more.

### 6e. Concurrency and the database backstop

- **One lock per provider.** Every write of health or circuit state — admission, recording, probe, override — happens in a transaction that first takes `SELECT … FOR UPDATE` on the provider row, and reads the policy, the state and the windows only after the lock is held. Lifecycle transitions take the same lock, so all writers of a provider serialize; no transaction locks a second provider row, so there is no lock-order deadlock.
- **No transaction across the adapter call.** Test-send and health-check run the adapter between two short transactions; the ticket (generation, probe id) is how the second transaction recognizes that the world moved on (§6d).
- **Probe slots.** `circuit_probes` holds the live slots (`[{ id, leaseUntil }]`); at most `halfOpenMaxProbes` are admitted, and concurrent requests beyond that see the slots held under the lock and are refused. A slot whose holder never records (process death, authority withdrawn before the second transaction) is reclaimed when its lease expires.
- **Database guard** (`fn_providers_state_guard`, migration `0022`, `SECURITY INVOKER`): for every principal except the owner/maintenance session, a change of `circuit_state` must be one of T1–T4 with `circuit_generation` exactly +1, and the generation never changes otherwise; administrative columns (`channel_id`, `name`, `adapter_key`, `status`) and `health_override` change only for a `providers.manage` holder. Column checks keep the derived columns consistent (`health_state = health_override` when set; probe slots only in `half_open`, at most 10 — the policy's upper bound; successes only in `half_open`). The policy row is guarded the same way: bounds as `CHECK`s, `version` exactly +1 per update, no `INSERT`/`DELETE`.

### 6f. Lifecycle versus circuit — precedence

For a submission the order is fixed, and each step is decided only if every earlier step passed:

1. authenticated principal (`401`)
2. `providers.test_send` at platform scope (`403`)
3. the provider exists (`404`)
4. **lifecycle**: `status = active` (`409 PROVIDER_LIFECYCLE_CONFLICT`)
5. the adapter is registered (`422 PROVIDER_ADAPTER_UNKNOWN`)
6. **circuit admission** (`409 PROVIDER_CIRCUIT_OPEN`, §6c)
7. the adapter call

Lifecycle therefore takes precedence over the circuit: a `disabled` or `draining` provider is refused on its status and **never consults the circuit** — it cannot trigger T2, claim a probe slot or be counted as a circuit refusal. Health is not consulted (§5.0). A provider disabled while a submission is in flight still has that submission's answer recorded truthfully, including its circuit effect. Re-enabling a provider leaves its circuit as it was: an `open` circuit stays open until cooldown and probes close it.

### 6g. Observability

Metrics (bounded labels only; `provider` is the catalogue id): `acc_provider_health_checks_total{channel, outcome}` (`healthy`/`unhealthy`/`timeout`), `acc_provider_health_state{provider, status}` and `acc_provider_circuit_state{provider, status}` (1 for the current state, 0 for the others, as last written by this instance), `acc_provider_health_transitions_total{provider, from_state, to_state}`, `acc_provider_circuit_transitions_total{provider, from_state, to_state}` (circuit-open events are `to_state="open"`), `acc_provider_circuit_rejections_total{provider, status}` and `acc_provider_circuit_probes_total{provider, outcome}` (`success`, `failure`, `neutral`, `stale`, `abandoned`). One structured log line per health check, circuit transition (`warn` on entering `open`), circuit refusal, probe reclaim and policy change — never a recipient, content or credential. Grafana: `infra/observability/grafana-dashboards/providers.json`, provisioned by Compose.

### 6h. The routing-eligibility contract (consumed by the future Channel Router / Provider Router)

**Phase 2.3 performs no traffic switching or failover.** It establishes the **authoritative** lifecycle, health and circuit state of each provider; the routing layer of a later phase (`ROUTING_ENGINE.md`) consumes it. The canonical order of evaluation is:

```
Lifecycle  →  Health  →  Circuit  →  Provider Router eligibility
```

| Stage | State | What the router must do |
|---|---|---|
| Lifecycle | `disabled` | Exclude. Never consult health or circuit |
| Lifecycle | `draining` | Exclude from **new** traffic; let in-flight attempts complete. Never consult the circuit |
| Lifecycle | `active` | Continue to health |
| Health | any | Informational in Phase 2. A future routing policy may de-weight `degraded`/`critical` and exclude `offline` (`§5.0` table); health never overrides the circuit |
| Circuit | **`OPEN`** | **Exclude the provider from normal traffic.** No submission is sent to it until the cooldown has elapsed |
| Circuit | **`HALF_OPEN`** | **Permit only the configured probe(s):** at most `halfOpenMaxProbes` submissions in flight, each admitted as a probe through the circuit's own admission (§6c); every other submission must be routed elsewhere (or fail over), never sent to this provider |
| Circuit | **`CLOSED`** | **Eligible**, subject to the lifecycle rule above and to the routing policy (priority, weight, cost — later phases) |

Two rules bind the router:

1. **One authority.** `routingEligibility()` (`provider-state-machine.ts`) is the read-only predicate a router uses to filter candidates: `excluded_lifecycle`, `excluded_open`, `probe_only` (with the free probe slots), or `eligible`. It claims nothing. Before sending, the router must still pass the chosen provider through the **same admission** the test-send uses (`ProviderStateStore.admit`, §6c), under the provider row lock: that call — and only that call — claims a probe slot or applies T2. The router never re-implements the breaker, never reads the thresholds itself, and never sends to a provider whose admission refused.
2. **Every outcome is recorded.** Each real submission's normalized outcome is recorded through the same recording (§6d) with its ticket, so the circuit sees production traffic exactly as it sees test-sends today.

What this contract deliberately does not define: routing weights, priorities, policies, multi-provider selection and failover orchestration (later phases, ADR-013 PD-6).

### 6i. Policy administration

| Method | Path | Permission | Request | Answer | Audit |
|---|---|---|---|---|---|
| `GET` | `/api/v1/provider-circuit-policy` | `providers.manage` at platform | — | `200 {data:circuitPolicy}` | — |
| `PUT` | `/api/v1/provider-circuit-policy` | `providers.manage` at platform | all eight parameters and `expectedVersion`, nothing else | `200 {data:circuitPolicy}`; values already in force: no change, no audit | `provider.circuit_policy_updated` (before/after, both versions) |

`circuitPolicy` is exactly the eight parameters, `version` and `updatedAt`. No internal field (row key, updater) is exposed; the updater is in the audit row.

## 7. Provider simulator (development/test only)

A first-class adapter implementation (`SimulatorAdapter`) satisfies the same `ProviderAdapter` interface and is the *only* adapter permitted to run in Phase 0–2 (no real vendor adapters are built or connected until later phases per the roadmap, and never in this repository without explicit, separate authorization). Full behavior catalogue: `TESTING.md` §"Provider simulator". **Implemented in Phase 2.2** (`apps/api/src/provider-adapters/simulator.adapter.ts`): no network, no credential, deterministic. A behaviour is chosen explicitly per submission (`forBehavior`); without one, or with an unknown one, or for a channel it does not serve, the simulator answers `CONFIGURATION_ERROR`, never success. `SUCCESS` and `SLOW_RESPONSE` (300 ms, inside the 3000 ms timeout) are accepted with `providerMessageId = sim-<submissionId>`; `TIMEOUT` never answers and becomes `TIMEOUT` when the executor's timeout aborts it; `500` → `PROVIDER_ERROR` (`SIM-500`), `429` → `RATE_LIMITED` (`SIM-429`), `INVALID_CREDENTIALS` → `AUTH_ERROR` (`SIM-401`), `INVALID_REQUEST` → `INVALID_REQUEST` (`SIM-400`). It is reached only through `POST /providers/:id/test-send` (§4). **Phase 2 implements only the submission-time behaviours** (`SUCCESS`, `TIMEOUT`, `500`, `429`, `INVALID_CREDENTIALS`, `INVALID_REQUEST`, `SLOW_RESPONSE`) through the direct test-send; the delivery/webhook behaviours are Phase 3 (ADR-013 PD-3).

## 8. Related

Routing decisions over eligible providers: `ROUTING_ENGINE.md`. Delivery-outcome escalation: `FALLBACK_ENGINE.md`. Credential storage: `SECURITY.md` §"Secrets management".
