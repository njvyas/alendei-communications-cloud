# Provider Abstraction Architecture

> **Phase 2 status (ADR-013): SCOPE FROZEN; 2.1 (channel and provider registry, migrations `0018`–`0019`) CLOSED (Gate D.1); 2.2 (adapter contract and `SimulatorAdapter`, migration `0020`) IMPLEMENTED — Gate D.2 pending review; 2.3–2.6 not implemented.**

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
- **The finalized port (Phase 2.2).** `send(context, submission, options)` takes a `ProviderAdapterContext` — provider id, adapter key, channel and the provider's declared capabilities; **no credential**, ever — a `ProviderSubmission` (`submissionId` assigned by ACC and stable for the attempt, `correlationId`, channel, recipient, content) and `{ timeoutMs, signal }`, and returns `accepted` (with the provider's `providerMessageId`) or `rejected` (with a normalized `ProviderFailure`: `category`, `retryable`, `providerCode`, `message`), each carrying the submission and correlation ids and `latencyMs`. `capabilities()` declares the channels an adapter serves; `healthCheck(context)` returns `{ healthy, latencyMs }` (used from 2.3). The `ProviderSubmissionExecutor` (`apps/api/src/provider-adapters/`) runs every submission: it enforces the platform timeout (`PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS`, 3000 ms) by aborting the adapter's wait, maps a thrown error or an out-of-contract result to `UNKNOWN`, recomputes `retryable` from the category, stamps the ids and measures latency on an injectable clock, and counts the submission (`acc_provider_submissions_total{channel, outcome}`).
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

**Phase 2 partition (ADR-013 PD-5, PD-6).** In Phase 2: add, update, replace capabilities, enable, disable, drain (2.1); test a provider against the simulator (2.2 — **implemented**: `POST /providers/:id/test-send`, `providers.test_send` at platform scope, an `active` provider only, the adapter from the provider's catalogue row, a caller-chosen simulator behaviour and nothing else, a synthetic payload, no message persisted, `provider.test_sent` audited); run a health check and override health manually (2.3). **Not in Phase 2:** priority/weight, routing-policy assignment, traffic and canary migration, rollback via routing-policy versions, and per-provider health-threshold configuration (Phase 2 uses fixed platform defaults, ADR-013 F-6). Phase 2 administration is platform scope only: `AuthorizationService` enforces `providers.read`, `providers.manage` and `providers.test_send` at platform scope and RLS enforces platform-scope eligibility (ADR-013 F-3). The permissions are currently granted only to `alendei_super_admin`; that is a grant, not the boundary (F-4).

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

> **Status:** the model below was frozen before the 2.3 implementation was written (ADR-013 "2.3 design") and is implemented exactly as stated. Phase 2 uses only fixed platform defaults (ADR-013 F-6); no threshold is administrable.

### 5.0 Three independent axes

| Column(s) on `providers` | Values | Written by | Meaning |
|---|---|---|---|
| `status` | `active`, `disabled`, `draining` | `providers.manage` only (enable / disable / drain, 2.1) | Administrative lifecycle — an operator decision |
| `health_state`, `health_override`, `health_changed_at` | `healthy`, `degraded`, `critical`, `offline` | derived from samples (§5c) or set by a manual override (§5d) | Observed health over a slow window |
| `circuit_state`, `circuit_generation`, `circuit_changed_at`, `circuit_probe_token`, `circuit_probe_lease_until`, `circuit_probe_successes` | `closed`, `open`, `half_open` | the circuit breaker only (§6), from submission samples and the clock | Fast load-shedding over a short window |

No axis writes another: a lifecycle transition never changes health or circuit state, and health and circuit never change `status`. `DRAINING` is not a health state (ADR-013 F-5): a draining provider is excluded from *new* routing decisions while in-flight attempts complete — applied by the router in a later phase.

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

Each row also carries `classification` (§5b), `latency_ms` (null for `override`), `health_state` and `circuit_state` **after** the sample was applied, `circuit_generation` (the circuit episode the observation belongs to, §6d), `observed_at` (the injected clock) and `created_at` (database time). A test-send refused by the circuit (§6c) never reached the provider, so it is **not** a sample; it is audited and counted instead. A row can never be updated or deleted (append-only trigger; no `UPDATE`/`DELETE` grant).

### 5b. Failure classification (one table, used by health and circuit alike)

| Outcome | Classification | Why |
|---|---|---|
| `accepted` | **success** | The provider accepted the submission |
| `timeout` | **failure** | No answer: availability |
| `provider_error` | **failure** | The provider failed on its side (5xx, outage) |
| `rate_limited` | **failure** | The provider is shedding load; calling it again immediately is the harm a breaker exists to stop |
| `unknown` | **failure** | Unclassifiable — counted, so an unexplained failure mode fails safe |
| `auth_error` | neutral | The provider answered; a credential rejection is deterministic configuration, not availability, and waiting cannot fix it |
| `invalid_request`, `invalid_recipient`, `unsupported_content` | neutral | The request's fault, not the provider's |
| `configuration_error` | neutral | Ours: the provider was not reached |
| probe `healthy` | **success** | |
| probe `unhealthy`, `timeout` | **failure** | |
| `manual` | neutral | An override is a decision, not an observation |

A **neutral** sample is recorded but is neither a success nor a failure: it is excluded from every window, so a burst of bad requests can neither trip the circuit nor dilute a real provider failure rate. The classification is persisted on the sample, so history does not change meaning if the table ever does.

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

### 6a. Parameters (fixed platform defaults, `PROVIDER_CIRCUIT_DEFAULTS`)

| Parameter | Value |
|---|---|
| Window | counted `submission` samples of the **current generation** with `observed_at` in `(now − 60 s, now]`, most recent 20 |
| Minimum samples | 5 |
| Failure threshold | `failures × 100 ≥ 50 × samples` (meets-or-exceeds 50 %) |
| Cooldown | 30 s from entering `open` |
| Half-open probes in flight | 1 |
| Successful probes to close | 2 (sequential) |
| Probe lease | 10 s (the submission timeout plus margin) |

All times come from an injected clock (`PROVIDER_CLOCK`); nothing reads the wall clock directly, so every boundary is testable to the millisecond.

### 6b. Transition table — the only four edges

| # | From → To | Event | Guard | Cause recorded |
|---|---|---|---|---|
| T1 | `closed → open` | a counted submission sample of the current generation is recorded | window has `≥ 5` samples and meets the failure threshold | `failure_threshold` |
| T2 | `open → half_open` | a submission asks for admission | `now ≥ circuit_changed_at + 30 s` | `cooldown_elapsed` |
| T3 | `half_open → open` | the current probe's sample is recorded | classified **failure** | `probe_failed` |
| T4 | `half_open → closed` | the current probe's sample is recorded | classified **success** and it is the 2nd successful probe of this episode | `probes_succeeded` |

Every edge increments `circuit_generation` by exactly 1, sets `circuit_changed_at = now`, clears the probe slot and resets `circuit_probe_successes` to 0, and writes `provider.circuit_changed` (before/after state and generation, cause, and the window figures for T1). No other change of `circuit_state` exists: `closed → half_open`, `open → closed` and every self-transition are impossible, and the database refuses them (§6e). There is no manual circuit control in Phase 2; an `open` circuit recovers only through cooldown and probes. T1 is evaluated after **every** counted sample — including a success that brings the window to its minimum size — because the rule is about the window, not the last call.

### 6c. Admission (before the adapter is called)

| Circuit state | Condition | Decision |
|---|---|---|
| `closed` | — | admitted as a normal submission (ticket: current generation) |
| `open` | cooldown not elapsed | **refused** — `409 PROVIDER_CIRCUIT_OPEN`, `details.circuitState = "open"`, `details.retryAfterMs` |
| `open` | cooldown elapsed | T2, then as `half_open` below |
| `half_open` | probe slot free, or its lease expired | admitted as **the probe**: a fresh `circuit_probe_token`, `circuit_probe_lease_until = now + 10 s` (ticket: generation + token). Reclaiming an expired lease is logged and counted as an `abandoned` probe |
| `half_open` | probe slot held, lease not expired | **refused** — `409 PROVIDER_CIRCUIT_OPEN`, `details.circuitState = "half_open"` |

A refusal calls no adapter, writes no sample, and writes `provider.test_sent` with outcome `failure` and `after.outcome = "short_circuited"` (ADR-013 F-7: "recorded as such").

### 6d. Recording (after the adapter answered)

The sample is always inserted, tagged with the ticket's generation. Then, against the locked row:

- **Stale ticket** — its generation is not the current one, or it is a probe whose token is no longer the slot's: the sample is recorded (it still informs health) and **changes nothing in the circuit**. This is what stops a slow answer from an earlier episode, or an abandoned probe, from closing a re-opened circuit, re-opening a closed one, releasing someone else's probe slot or polluting the new episode's window.
- **`closed`**, current ticket: evaluate T1.
- **`half_open`**, the current probe: release the slot; **failure** → T3; **success** → `circuit_probe_successes + 1`, and T4 when it reaches 2; **neutral** → nothing more (the slot is free for the next probe).

### 6e. Concurrency and the database backstop

- **One lock per provider.** Every write of health or circuit state — admission, recording, probe, override — happens in a transaction that first takes `SELECT … FOR UPDATE` on the provider row, and reads the state and the windows only after the lock is held. Lifecycle transitions take the same lock, so all writers of a provider serialize; no transaction locks a second provider row, so there is no lock-order deadlock.
- **No transaction across the adapter call.** Test-send and health-check run the adapter between two short transactions; the ticket (generation, probe token) is how the second transaction recognizes that the world moved on (§6d).
- **Single probe slot.** In `half_open` exactly one submission holds the slot; concurrent requests see it held under the lock and are refused. A slot whose holder never records (process death, authority withdrawn before the second transaction) is reclaimed when its lease expires.
- **Database guard** (`fn_providers_state_guard`, migration `0022`, `SECURITY INVOKER`): for every principal except the owner/maintenance session, a change of `circuit_state` must be one of T1–T4 with `circuit_generation` exactly +1, and the generation never changes otherwise; administrative columns (`channel_id`, `name`, `adapter_key`, `status`) and `health_override` change only for a `providers.manage` holder. Column-level checks keep the derived columns consistent (`health_state = health_override` when set; a probe token only in `half_open`; successes only in `half_open`).

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

Metrics (bounded labels only; `provider` is the catalogue id): `acc_provider_health_checks_total{channel, outcome}` (`healthy`/`unhealthy`/`timeout`), `acc_provider_health_state{provider, status}` and `acc_provider_circuit_state{provider, status}` (1 for the current state, 0 for the others, as last written by this instance), `acc_provider_health_transitions_total{provider, from_state, to_state}`, `acc_provider_circuit_transitions_total{provider, from_state, to_state}` (circuit-open events are `to_state="open"`), `acc_provider_circuit_rejections_total{provider, status}` and `acc_provider_circuit_probes_total{provider, outcome}` (`success`, `failure`, `neutral`, `stale`, `abandoned`). One structured log line per health check, circuit transition (`warn` on entering `open`), circuit refusal and probe reclaim — never a recipient, content or credential. Grafana: `infra/observability/grafana-dashboards/providers.json`, provisioned by Compose.

## 7. Provider simulator (development/test only)

A first-class adapter implementation (`SimulatorAdapter`) satisfies the same `ProviderAdapter` interface and is the *only* adapter permitted to run in Phase 0–2 (no real vendor adapters are built or connected until later phases per the roadmap, and never in this repository without explicit, separate authorization). Full behavior catalogue: `TESTING.md` §"Provider simulator". **Implemented in Phase 2.2** (`apps/api/src/provider-adapters/simulator.adapter.ts`): no network, no credential, deterministic. A behaviour is chosen explicitly per submission (`forBehavior`); without one, or with an unknown one, or for a channel it does not serve, the simulator answers `CONFIGURATION_ERROR`, never success. `SUCCESS` and `SLOW_RESPONSE` (300 ms, inside the 3000 ms timeout) are accepted with `providerMessageId = sim-<submissionId>`; `TIMEOUT` never answers and becomes `TIMEOUT` when the executor's timeout aborts it; `500` → `PROVIDER_ERROR` (`SIM-500`), `429` → `RATE_LIMITED` (`SIM-429`), `INVALID_CREDENTIALS` → `AUTH_ERROR` (`SIM-401`), `INVALID_REQUEST` → `INVALID_REQUEST` (`SIM-400`). It is reached only through `POST /providers/:id/test-send` (§4). **Phase 2 implements only the submission-time behaviours** (`SUCCESS`, `TIMEOUT`, `500`, `429`, `INVALID_CREDENTIALS`, `INVALID_REQUEST`, `SLOW_RESPONSE`) through the direct test-send; the delivery/webhook behaviours are Phase 3 (ADR-013 PD-3).

## 8. Related

Routing decisions over eligible providers: `ROUTING_ENGINE.md`. Delivery-outcome escalation: `FALLBACK_ENGINE.md`. Credential storage: `SECURITY.md` §"Secrets management".
