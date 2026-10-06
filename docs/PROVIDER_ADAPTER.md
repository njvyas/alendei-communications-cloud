# Provider Abstraction Architecture

> **Phase 2 status (ADR-013): SCOPE FROZEN; 2.1 (migrations `0018`–`0019`) CLOSED (Gate D.1); 2.2 (migrations `0020`–`0021`) CLOSED (Gate D.2); 2.3 (health and circuit breaker, migrations `0022`–`0023`) CLOSED (Gate D.3); 2.4 (hot reload, migration `0024`, §3a) CLOSED (Gate D.4); 2.5 (credential reference contract, §4a, documentation only) CLOSED (Gate D.5); 2.6 not implemented.**

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
- Publishes `alendei.providers.health_changed.v1` on any health/circuit transition, and is invalidated/refreshed via a change signal when an admin edits a provider (built in Phase 2.4 as PostgreSQL `LISTEN/NOTIFY`, not Redis pub/sub — §3a) — this is the mechanism behind "no redeploy required" for provider changes.

**Phase 2 (ADR-013).** The registry is built over `channels`, `providers` and `provider_capabilities` (2.1) and `provider_health` (2.3); **`provider_credentials` is not built** (§4a). Resolution "for a given channel + tenant" is a later-phase concern: Phase 2 has no tenant-facing resolution, because the catalogue is platform-only. **No event is published in Phase 2** — there is no outbox (ADR-013 PD-1); transitions are recorded in `audit_logs` and metrics. **Phase 2.2:** `ProviderAdapterRegistry` (`apps/api/src/provider-adapters/adapter-registry.ts`) resolves `adapter_key → adapter`, built once from code at startup. It fails at construction if a key is registered twice or if the registered set and `PROVIDER_ADAPTER_KEYS` disagree, and `resolve` throws for any unregistered key (case- and whitespace-exact; no prototype keys), which the API answers `422 PROVIDER_ADAPTER_UNKNOWN`. A provider's adapter key always comes from its catalogue row, never from a request. Hot reload is built in 2.4 (§3a) with PostgreSQL `LISTEN/NOTIFY`, not Redis pub/sub (ADR-013 "2.4 design"): database triggers bump a transactional configuration revision and notify it only on commit; each instance's advisory configuration snapshot is invalidated by the notification, reconciled against the revision every `R` = 5 s and never served older than `T` = 60 s. It authorizes nothing. `providers.adapter_key` names an adapter registered in code; in Phase 2 the only key is `simulator` (ADR-013 F-9).

## 3a. Hot reload — runtime configuration convergence (Phase 2.4 — canonical)

> **Status:** frozen 04-Oct-2026, before any 2.4 code (ADR-013 "2.4 design", user decision at the 2.4 authorization). It replaces the frozen ROADMAP §5b transport (Redis pub/sub published by the application after commit) with PostgreSQL `LISTEN/NOTIFY` emitted by database triggers — no new infrastructure, and a notification that cannot be sent before commit or forgotten by an application path.

**Hot reload is a performance/convergence mechanism, never an authorization mechanism.** PostgreSQL is the source of truth. The authoritative path for every decision that matters is unchanged:

```
authenticated principal → authorization (AuthorizationService) → PostgreSQL / RLS
provider submission: … → locked provider row → lifecycle → circuit admission (§6c, §6h) → provider call
```

Nothing in this section is consulted by authorization, provider administration, tenant or scope access, lifecycle enforcement, circuit admission or a provider submission. A cached snapshot is never proof that a caller may read or change anything.

### 3a.1 What is cached — the advisory configuration snapshot

One process-local, immutable snapshot per application instance (`ProviderConfigurationCache`), replaced whole:

| Included (administrative configuration) | Excluded (DB-authoritative, never cached) |
|---|---|
| channels (`id`, `code`, `display_name`, `status`) | provider health state, override, circuit state, generation, probe slots, samples |
| providers (`id`, `channel_id`, `name`, `adapter_key`, `status`) and their capabilities | anything about principals, grants, permissions or tenants |
| the circuit policy (eight parameters, `version`) | audit data |
| the configuration **revision** the snapshot was read at, and when it was loaded | |

**Advisory consumers only** (Phase 2): `ProviderCatalogueService.routingCandidates`, in-process — the read-only view the future Provider Router uses to pick candidates (active providers of a channel, and the policy version). **No HTTP route serves the snapshot**; every admin read and mutation keeps reading PostgreSQL directly. The routing contract of §6h is unchanged: a candidate list is advisory; circuit admission under the row lock remains mandatory immediately before a submission.

**The snapshot is only ever read or refreshed inside an authorized request transaction** — after `AuthorizationService` has granted `providers.read` at platform scope — so loading runs under that principal's RLS. Every eligible principal sees the same catalogue rows (the catalogue RLS predicate does not vary among platform-scope principals, §F-3), so a snapshot loaded by one authorized request is safe to serve to another authorized request; it is never served before authorization, and an unauthorized request neither reads nor refreshes it. There is no background database read.

### 3a.2 Revision — the authoritative change signal

`provider_configuration_revision` (migration `0024`): one row, `revision bigint`, increased by exactly the database, never by the application:

- **Statement-level `AFTER` triggers** (`fn_provider_configuration_changed`, `SECURITY INVOKER`) on every relevant change: `providers` insert, delete, and update **of** `channel_id`, `name`, `adapter_key`, `status` (not of health or circuit columns); `provider_capabilities` insert/update/delete; `channels` insert/update/delete; `provider_circuit_policy` update. Each bumps `revision` by one in the **same transaction** as the change and calls `pg_notify('acc_provider_configuration', revision)`.
- **Transactional and monotonic.** The revision is visible only when the change commits; a rolled-back change leaves no revision and sends no notification. A trigger refuses any update that does not increase it. Because the revision row is updated inside the change's transaction, readers can never observe a revision whose change is not yet visible.
- RLS: `SELECT` on `app_has_platform_scope()`; `UPDATE` on `app_has_platform_permission('providers.manage')` (the only application writers of the watched columns are `providers.manage` holders); no `INSERT`/`DELETE`; nothing to `acc_auth`/`acc_relay`. **No SECURITY DEFINER function.**

### 3a.3 Notification — an accelerator, never a source of state

- PostgreSQL delivers `NOTIFY` **only after commit**, in commit order; a notification can therefore never announce a change that is not yet visible.
- Each instance holds one dedicated `LISTEN acc_provider_configuration` connection (`ProviderConfigurationListener`, application name `acc-provider-config-listener`), opened as `acc_app` outside the request pool (`LISTEN` needs no table privilege). It never blocks or fails application start. **When it connects — the first time and after every reconnect — and when it is lost, it marks the snapshot dirty** (reload operation `listener`): anything announced while it was not listening is unknown. After a failed connect or a loss it retries with exponential backoff, 1 s doubling to at most 30 s (`PROVIDER_CONFIGURATION_CACHE.LISTENER_RECONNECT_MIN_MS`/`MAX_MS`); the retry timer does not keep the process alive.
- A notification's payload is a **hint**: the revision number, used only to decide whether to mark the snapshot dirty. It is never applied as data. A payload not greater than the snapshot's revision (duplicate, out of order, stale) is ignored; a malformed payload marks the snapshot dirty (conservative); a forged payload can at most cause one extra reload from PostgreSQL.
- The instance that commits a change also marks its own snapshot dirty immediately after commit (read-your-writes on that instance, without waiting for its own notification).

### 3a.4 Reconciliation, TTL and the convergence guarantee

On every advisory read (inside the authorized transaction), at time `now` on the provider clock:

1. **Reload** if there is no snapshot (startup), it is dirty (notification, local change, listener loss), or it is older than **`T` = 60 s** (hard TTL).
2. Otherwise, if the revision was last checked **`R` = 5 s** or longer ago, read the revision (one row): if it is newer than the snapshot's, reload.
3. A reload reads the revision **first**, then the configuration, in the same transaction, so the data is never older than the revision it is labelled with. A reloaded snapshot is installed only if its revision is **not lower** than the installed one — a slow reload can never replace newer configuration with older.

**Guarantee.** For every instance: a configuration change is visible to its advisory reads on the first read after its notification is delivered (normally milliseconds after commit); **if notifications are lost, no later than `R` = 5 s after commit**; and, even if the revision signal itself failed, **no snapshot older than `T` = 60 s is ever served.** Worst-case staleness of an advisory read: `R` with a working revision trigger, `T` in any case. Authoritative decisions have **zero** staleness: they never read the snapshot.

### 3a.5 Failure and recovery

| Failure | Behaviour |
|---|---|
| Notification lost (network, overflow, listener down) | Reconciliation detects the newer revision within `R` |
| `LISTEN` connection lost / PostgreSQL restart | The snapshot is marked dirty at once (missed notifications cannot be trusted); the listener reconnects with backoff (1 s, doubling, at most 30 s), re-issues `LISTEN` and marks the snapshot dirty again on reconnect; meanwhile reconciliation bounds staleness by `R` |
| Application restart | The new process starts with no snapshot: its first advisory read loads from PostgreSQL (startup reconciliation) |
| Duplicate / out-of-order / stale / forged notification | Ignored, or one extra reload; never applied as state |
| Reload fails (database error) | The request fails as any database error does; the old snapshot is not marked fresh, so the next read retries |
| Revision trigger disabled or dropped | No notification and no revision change: the hard TTL still reloads within `T` |
| Redis unavailable | Irrelevant to 2.4: Redis is not used for configuration propagation |
| Concurrent administrators | Every change commits its own revision; changes serialize on the revision row; each instance converges to the latest committed revision |

### 3a.6 Observability

As implemented (`apps/api/src/observability/metrics.service.ts`; proven by `provider-hot-reload.sec-spec.ts` H):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `acc_provider_config_local_invalidations_total` | counter | `operation` | a configuration mutation committed through this instance, followed by a local invalidation of its snapshot |
| `acc_provider_config_notifications_total` | counter | `outcome` ∈ `applied`, `duplicate`, `malformed` | `NOTIFY` messages received |
| `acc_provider_config_reloads_total` | counter | `operation` ∈ `startup`, `notification`, `local`, `listener`, `reconcile`, `ttl`; `outcome` ∈ `success`, `failure`, `discarded` | snapshot reloads by cause; `discarded` = older than the installed snapshot |
| `acc_provider_config_revision` | gauge | — | the revision of the installed snapshot |
| `acc_provider_config_convergence_seconds` | histogram | — | commit of a revision to its installation in this instance |
| `acc_provider_config_listener_connected` | gauge | — | 1 while the `LISTEN` connection is held |
| `acc_provider_config_listener_events_total` | counter | `outcome` ∈ `connected`, `lost` | `LISTEN` connection events |

Logs: `warn` when the listener cannot connect (with the retry delay), when it is lost (snapshot marked dirty, reconnecting) and when a reload fails; `info` when a stale reload is discarded. The provisioned Grafana dashboard (`providers.json`) has no hot-reload panel; the metrics are scraped from `/metrics`.

### 3a.7 Acceptance criteria (Gate D.4)

1. A provider enabled, disabled, drained, renamed or re-capabilitied, or the circuit policy changed, through instance A is reflected in instance B's advisory read before `R` elapses on B's clock (notification path), with no restart.
2. With B's notifications suppressed, B serves the old configuration until `R` and the new one on its first read at `R` — never later.
3. With the revision signal disabled, B serves the new configuration on its first read at `T` — never later.
4. A provider disabled through A is refused by B's very next test-send even while B's snapshot still lists it (DB truth, §6h).
5. Duplicate, out-of-order, malformed and forged notifications change nothing; a forged high revision cannot stop a later real change from converging.
6. A new instance, started after a change, serves the new configuration on its first read.
7. `LISTEN` loss marks the snapshot dirty; the listener reconnects; notifications resume.
8. A change in an open transaction is invisible and unannounced until commit; a rollback leaves no trace.
9. Concurrent administrators and rapid successive changes converge to the last committed state on every instance; a slow reload never installs older configuration over newer.
10. Unauthorized, tenant, reseller, API-key and forged-scope requests are refused before the cache is read or refreshed; the revision table and the notification channel grant no capability.
11. Structural: the cache is not reachable from authorization, administration, lifecycle, admission or submission code.

## 4. Admin operations (no deploy, no restart) — all privileged, all audited

**Phase 2 partition (ADR-013 PD-5, PD-6).** In Phase 2: add, update, replace capabilities, enable, disable, drain (2.1); test a provider against the simulator (2.2 — **implemented**: `POST /providers/:id/test-send`, `providers.test_send` at platform scope, an `active` provider only, the adapter from the provider's catalogue row, a caller-chosen simulator behaviour and nothing else, a synthetic payload, no message persisted, `provider.test_sent` audited); run a health check and override health manually (2.3 — **implemented**: `POST /providers/:id/health-check`, `POST /providers/:id/health`, `GET /providers/:id/health`; §5–§6). **Not in Phase 2:** priority/weight, routing-policy assignment, traffic and canary migration, rollback via routing-policy versions, and per-provider health-threshold configuration (Phase 2 uses fixed platform defaults, ADR-013 F-6). Phase 2 administration is platform scope only: `AuthorizationService` enforces `providers.read`, `providers.manage` and `providers.test_send` at platform scope and RLS enforces platform-scope eligibility (ADR-013 F-3). The permissions are currently granted only to `alendei_super_admin`; that is a grant, not the boundary (F-4).

All of the following are DB writes to `providers`/`provider_capabilities`/`routing_policies` — never a code or config-file change. PostgreSQL stays authoritative: each change bumps the configuration revision in its own transaction and is announced by PostgreSQL `NOTIFY` on commit, a hint that only marks each instance's advisory snapshot dirty, with reconciliation and a hard TTL bounding staleness (§3a). **Every one of them is a privileged operation**: gated behind the `providers.manage` permission (or the narrower `providers.test_send` for test-sends specifically), and every invocation writes an `audit_logs` row with the actor, the exact before/after values, and the target provider — with no exception, since a mis-issued priority/weight/drain change can silently redirect real traffic and a test-send can incur real provider cost or generate a real customer-visible message once a real provider is connected.

- Add / enable / disable a provider.
- Drain a provider (`providers.status → draining`: stop accepting *new* messages, let in-flight attempts complete). Draining is an **administrative status**, not a health state (ADR-013 F-5).
- **Test a provider**: sends a synthetic message through the simulator-backed test path in Phase 0–2 (`TESTING.md` §2); once real providers are connected (post-Phase-12 business decision, never in this repository without separate explicit authorization), a test-send is capable of incurring real cost or reaching a real recipient, so it additionally requires an explicit target (never a wildcard/broadcast test), environment awareness (a production test-send is a deliberately higher-friction action than a staging one — e.g. an additional confirmation step), and is subject to the same rate limiting as any other send path so a misconfigured test loop cannot itself become a cost or abuse incident.
- Change priority / weight / routing policy assignment.
- Configure health thresholds (error-rate/latency windows that drive automatic health/circuit transitions).
- Migrate traffic between providers, including canary migration (route X% to a new provider, monitor, ramp).
- Roll back a provider or routing change (activate a prior `routing_policy_versions` row; re-enable a disabled provider).

## 4a. Credential reference contract (Phase 2.5 — documentation only)

> **Status:** requirements recorded by Phase 2.5 (ADR-013 PD-2, F-1); **documentation only**. No credential table, column, port, type, interface, resolution code, API or UI exists, and none is defined here. **Credential architecture requires a separate reviewed decision (its own ADR) before any implementation.** §4a.1–§4a.2 are binding on that ADR; §4a.3 lists what it alone decides; §4a.4 records candidate input, adopted by nothing.

### 4a.1 Binding requirements

These hold for every ownership, scope and precedence model the future ADR may choose. None of them selects one.

- **CR-1 — Reference, never value.** A provider credential is held only as a reference of the form `<backend>:<locator>` into the deployment's secrets backend (the form `SecretsPort` already accepts). The credential value is never stored by the platform.
- **CR-2 — Resolution boundary.** A reference is resolved server-side, at call time, through `SecretsPort` and nowhere else. Adapter code never resolves or fetches a credential; it receives resolved material only for the call that needs it. Whether a resolved value may be cached at all, and for how long, is **not frozen** (§4a.3); any policy the ADR adopts must still satisfy CR-3.
- **CR-3 — Where a value never appears.** A resolved credential value never enters PostgreSQL, logs, metrics or metric labels, audit rows, API responses, error messages or error details, any frontend, the Phase 2.4 configuration snapshot (§3a.1) or a configuration notification payload (§3a.3). Hot reload converges configuration only; it never carries, caches or announces credential material.
- **CR-4 — Coexistence and isolation.** One shared deployment must be able to hold credentials belonging to different owners — Alendei, a reseller, an organization — side by side, with isolation between owners enforced by the database and not by application convention alone. How owners are represented, scoped and isolated is **not frozen** (§4a.3).
- **CR-5 — No cross-owner use; fail closed.** A credential belonging to one owner is never used for another owner's traffic. If no eligible credential exists for a submission, the submission is refused; it never falls back to some other credential. Fallback across an ownership boundary is **prohibited** unless the future credential ADR explicitly defines it and it is approved. This requirement selects no precedence or selection rule.
- **CR-6 — Rotation and revocation without restart.** Rotating or revoking a credential takes effect without a restart or a redeploy. The propagation mechanism and its bound are decided by the ADR; whatever they are, they carry no resolved value (CR-3).
- **CR-7 — Audit, and the visibility of references.** Every change to a credential reference or its binding is audited, and the credential value never enters an audit record. **A locator or reference is itself potentially sensitive metadata** — it can reveal the secrets backend's layout, an owner's identity or a naming scheme. It is not safe to expose merely because it is not the secret: its visibility in API responses, the UI, audit rows, logs and metrics must be defined explicitly by the future credential ADR and its authorization model. Phase 2 exposes no reference on any surface.
- **CR-8 — A credential failure is not a provider failure.** A provider's rejection of a credential is normalized as `auth_error`, which is neutral for both the circuit and health (§5b): one owner's bad credential cannot change a shared provider's health or open its circuit. A future design must preserve this.

### 4a.2 The `SecretsPort` integration boundary

`SecretsPort` (`apps/api/src/secrets/secrets.port.ts`: `resolve(reference)`, `backend`) is the only place a reference may be resolved. Phase 2 adds nothing to it — no port, method, type or interface — and the adapter contract (§2) carries no credential field. `SimulatorAdapter` uses no credential; `INVALID_CREDENTIALS` is a simulated behaviour only.

### 4a.3 NOT FROZEN — decided only by the future credential ADR

1. The credential **ownership and scope model** (including whether and how an owner maps to `org_id`, a reseller, or the platform).
2. The credential **precedence and selection model**.
3. **Management authority** at each scope — which principals and permissions may create, view, rotate or revoke a credential.
4. **Selection without a tenant context** (for example, a platform-initiated health check or test-send).
5. **Retention and deletion** semantics.
6. The **resolved-value caching** policy (CR-2).
7. The credential **API and UI**, including the visibility of locators and references (CR-7). The existing `SecretResolutionError` names the reference in its message — written for deployment-plane references; whether that is acceptable for a provider credential reference is part of this decision.
8. The credential **storage implementation** (`provider_credentials` or anything else) and the revocation propagation bound (CR-6).

### 4a.4 Candidate input — NOT FROZEN, adopted by nothing

Two incompatible descriptions exist and are retained only as input to the ADR (ADR-013 F-1); no hybrid is defined:

- **Candidate A** (`DEPLOYMENT.md` §0f, ADR-009 D-4 wording): a tenant-scoped row, a scope within the five-level hierarchy, `org_id` for RLS.
- **Candidate B** (`DATABASE.md` §3): a configuration scope `platform | reseller | organization`, a NULL platform `scope_id`, one active credential per provider and scope, with selection preferring the most specific scope.

Neither is a commitment, and nothing in Phase 2 may be read as choosing one. Rotation and revocation procedures (`RUNBOOK.md` §"Provider credential rotation") describe a future operation, not current behaviour.

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
| An answer no adapter could classify | `unknown` | Not in the frozen list, deliberately counted: an unexplained failure mode fails **safe** (it can open the circuit) rather than silently keeping a failing provider in traffic. Approved at the Gate D.3 re-review |

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
| `probeLeaseMs` | Probe lease duration: a probe slot not released within it is reclaimable | 10 000 | 5 000 – 600 000 (above the 3 000 ms submission timeout; **correction, 06-Oct-2026:** an admission may be redeemed up to 5 000 ms after issue, so a lease below about 8 000 ms can expire while a probe is still in flight and be reclaimed — audit finding MEDIUM-6, open) |
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

- **Phase 3 dispatcher (ADR-014 §9.3; planned, not implemented):** the dispatch principal `acc_dispatch` changes circuit and health state only through this store. `fn_providers_state_guard` gains an `acc_dispatch` branch: administrative columns and `health_override` refused; legal edges and generation +1 as above; every failure or success edge, `health_state` change and probe-success increment requires a `provider_health` submission sample inserted in the same transaction and bound to the exact attempt, provider, claim and fencing epoch; probe slots may only gain or lose the session's own slot or drop expired ones. Cooldown timing remains the store's, on the injected `ProviderClock` — not PostgreSQL `now()`. Failure-threshold arithmetic stays in `provider-state-machine.ts`.

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

**Hard architectural invariant — Provider Router eligibility is advisory; circuit admission is authoritative and mandatory immediately before provider submission.**

> **Correction (06-Oct-2026, pre-Phase-3 audit HIGH-3; ADR-015 R-13).** The previous text claimed this invariant was "enforced in code, not by convention". **That was false.** At HEAD `6d4b178` it holds only for the code that exists today and is enforced by convention plus runtime checks inside the executor: the adapter registry, `SimulatorAdapter` and `CircuitAdmissions` are exported, `resolve()` returns an adapter with a public `send`, `CircuitAdmissions.issue()` can be called by any holder, `ProviderRegistryService.simulatorFor()` hands out a raw adapter, the executor trusts caller-supplied adapter, context and timeout, `recordSubmission` accepts a forgeable plain ticket, and the architecture test is a regex over one file. Structural enforcement (no raw `send` path, unforgeable capabilities, derived adapter/context/timeout, settled-capability recording, import/type/runtime tests) is being implemented under ADR-015 R-13; this section will be rewritten when it lands. Until then, the bullets below describe intent, not a guarantee.

The intended rules:

- **Admission issues a token.** `ProviderStateStore.admit` — and nothing else — issues a `CircuitAdmission` (`CircuitAdmissions.issue`) when, and only when, the circuit admits the submission under the provider row lock (§6c). A refusal issues nothing.
- **The provider call demands it.** `ProviderSubmissionExecutor.execute` — the only code path that calls an adapter's `send()` — takes the admission as its first argument and redeems it (`CircuitAdmissions.consume`) **before** the adapter is touched. It refuses (`CircuitAdmissionRequired`, no adapter call, no sample) anything that is not a genuine, unconsumed admission, issued in this process for **this** provider, no more than `CircuitAdmissions.MAX_AGE_MS` (5 s, on the submission clock) ago. An admission is single-use: a second call with it is refused.
- **Eligibility cannot stand in for it.** `routingEligibility()` returns a plain verdict; it is not an admission and cannot be redeemed. A verdict of `eligible` or `probe_only`, a copied or forged object with an admission's fields, an admission for another provider, a reused or an expired one — each is refused before the provider call.
- **Therefore the probe-slot limit cannot be bypassed** *(only through the supported path; see the correction above and MEDIUM-6)*. Each `HALF_OPEN` admission holds one of `halfOpenMaxProbes` slots under the row lock, and each provider call consumes exactly one admission, so concurrent routing requests can never place more submissions on a half-open provider than the policy admits, and an `OPEN` provider receives none.
- **Structurally guarded.** An architecture test fails if anything other than `ProviderStateStore` issues an admission, or if any code other than the declared submission paths calls `ProviderSubmissionExecutor.execute` (today only test-send; the future router must be added to that list, and must pass the admission the same way). Health-check probes (`executor.probe`) are diagnostics, not submissions, and need no admission (§5e).
- **Process-local by design.** An admission lives in the issuing process and cannot be serialized, cached or carried to another instance: admission and provider call happen in the same request.

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
