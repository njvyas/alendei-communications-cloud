# Provider Abstraction Architecture

> **Phase 2 status (ADR-013): SCOPE FROZEN; increment 2.1 (the channel and provider registry, migration `0018`) IMPLEMENTED — Gate D.1 pending review; 2.2–2.6 not implemented.** Phase 2 builds the registry, the adapter contract with `SimulatorAdapter` only, health and circuit-breaker mechanics and hot reload, partitioned into increments 2.1–2.6 (`ROADMAP.md` §5a–§5c). Sections below say which parts are Phase 2 and which are later phases.

## 1. Purpose

No module outside `provider-adapters` may know a specific vendor's API shape. Adding, removing, or replacing a provider is a configuration + adapter-implementation change, never a change to campaign, journey, billing, or orchestrator logic.

## 2. Provider Adapter Interface

Every provider integration implements the same TypeScript interface (illustrative — **exact types are not yet finalized**; they are finalized in Phase 2.2, ADR-013. An earlier draft said "finalized in Phase 1"; Phase 1 built no provider code):

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
- **Phase 2 implementation boundary (ADR-013 PD-3, PD-6).** Phase 2 implements `capabilities()`, `healthCheck()` and `send()` (exercised only through the direct test-send, `ROADMAP.md` §5b 2.2). `estimateCost()` (billing, Phase 7), `checkStatus()` and `parseWebhook()` (message lifecycle, Phase 3) exist as interface members only; the simulator refuses them explicitly and they carry no Phase 2 behaviour.
- Failure taxonomy is normalized: every adapter maps vendor-specific error codes to a shared enum (`INVALID_RECIPIENT, UNSUPPORTED_CONTENT, RATE_LIMITED, PROVIDER_ERROR, AUTH_ERROR, TIMEOUT, UNKNOWN`) so the Fallback Engine and reporting never branch on vendor-specific codes.

### 2a. Provider-side idempotency (adapter responsibility, not a platform guarantee)

`send(msg)` receives `message_attempts.provider_idempotency_key` (`DATABASE.md` §6, deterministically derived from the attempt's own `id`, stable across retries of that same attempt). Every adapter implementation **must**:

- Pass this key through as the provider's own idempotency/dedup key wherever the provider's API accepts one (most modern messaging APIs do).
- Where the provider has no such mechanism, prefer calling `checkStatus()` (if the provider exposes any correlatable lookup) before re-sending after a timeout, and otherwise accept — and never silently hide — the residual duplicate-submission risk documented in `DATABASE.md` §7.3. This is why `ARCHITECTURE.md` §9 states plainly that ACC guarantees exactly-once *business outcome*, not exactly-once *external delivery*: the guarantee bottoms out at whatever the specific provider's own API actually supports, and no adapter may claim a stronger guarantee than its provider genuinely offers.

## 3. Provider Registry

`providers` + `provider_credentials` + `provider_capabilities` + `provider_health` (see `DATABASE.md` §3) back a registry service that:

- Resolves, for a given channel + tenant, the set of enabled, credentialed adapters and their current capabilities.
- Loads credentials by reference (`credential_ref`) from the secrets backend at call time — the credential's plaintext value never sits in application config, environment dumps, or logs (see `SECURITY.md`).
- Publishes `alendei.providers.health_changed.v1` on any health/circuit transition, and is invalidated/refreshed via a Redis pub/sub signal when an admin edits a provider — this is the mechanism behind "no redeploy required" for provider changes.

**Phase 2 (ADR-013).** The registry is built over `channels`, `providers` and `provider_capabilities` (2.1) and `provider_health` (2.3); **`provider_credentials` is not built** (§4a). Resolution "for a given channel + tenant" is a later-phase concern: Phase 2 has no tenant-facing resolution, because the catalogue is platform-only. **No event is published in Phase 2** — there is no outbox (ADR-013 PD-1); transitions are recorded in `audit_logs` and metrics. Redis pub/sub invalidation is built in 2.4 as **best-effort configuration invalidation with bounded convergence** — not transactional configuration propagation: the update commits first, the invalidation is published after commit, subscribers evict on receipt, and the cache TTL bounds staleness if a publication is lost. `providers.adapter_key` names an adapter registered in code; in Phase 2 the only key is `simulator` (ADR-013 F-9).

## 4. Admin operations (no deploy, no restart) — all privileged, all audited

**Phase 2 partition (ADR-013 PD-5, PD-6).** In Phase 2: add, update, replace capabilities, enable, disable, drain (2.1); test a provider against the simulator (2.2); run a health check and override health manually (2.3). **Not in Phase 2:** priority/weight, routing-policy assignment, traffic and canary migration, rollback via routing-policy versions, and per-provider health-threshold configuration (Phase 2 uses fixed platform defaults, ADR-013 F-6). Phase 2 administration is platform scope only: `AuthorizationService` enforces `providers.read`, `providers.manage` and `providers.test_send` at platform scope and RLS enforces platform-scope eligibility (ADR-013 F-3). The permissions are currently granted only to `alendei_super_admin`; that is a grant, not the boundary (F-4).

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

## 5. Provider health states

| State | Meaning | Effect on routing |
|---|---|---|
| `HEALTHY` | Normal operation | Fully eligible |
| `DEGRADED` | Elevated latency/error rate below critical threshold | Eligible but de-weighted by quality/latency-aware policies |
| `CRITICAL` | Error/latency breach approaching automatic circuit trip | Eligible only as last resort / excluded depending on policy config |
| `OFFLINE` | Health checks failing / manually marked down | Excluded from routing |

Health state is derived from `provider_health` samples (automatic) or set directly by an admin action (manual), both recorded with `source` for audit clarity.

**`DRAINING` is not a health state (ADR-013 F-5).** An earlier draft listed it here and also as a `providers.status` value. It is an administrative status only: `providers.status ∈ {active, disabled, draining}` (admin-set), `providers.health_state ∈ {healthy, degraded, critical, offline}` (observed or manually overridden), `providers.circuit_state ∈ {closed, open, half_open}` (computed). A draining provider is excluded from *new* routing decisions while in-flight attempts complete — that eligibility rule is applied by the router in a later phase.

**Phase 2 sample sources (ADR-013 F-6).** Only explicit test-sends, explicit admin health checks against the simulator, and manual overrides produce samples. There is no scheduler, background prober or worker in Phase 2; thresholds are fixed platform defaults.

## 6. Circuit breaker

Distinct, faster-reacting signal than health state — designed to shed load quickly during a transient spike rather than wait for a slower SLO-window health recalculation.

| State | Trigger | Behavior |
|---|---|---|
| `CLOSED` | Default; error rate within threshold | Requests flow normally |
| `OPEN` | Rolling error/timeout rate exceeds threshold within a short window | Requests short-circuit immediately to the Fallback Engine without calling the provider |
| `HALF_OPEN` | After a cooldown period | A limited number of probe requests are allowed through; success closes the breaker, failure re-opens it |

**Phase 2 (ADR-013 F-7):** transitions are computed from recorded samples and an injectable clock; `OPEN → HALF_OPEN` is evaluated lazily when the cooldown has elapsed (no timer); while `OPEN`, a test-send short-circuits without calling the adapter. Router integration is a later phase.

Circuit state and health state both feed the Provider Router's eligibility filter (`ROUTING_ENGINE.md`, later phase), but are tracked and transitioned independently — a provider can be `HEALTHY` (good rolling average) while momentarily `OPEN` (a fresh burst of errors not yet reflected in the longer health window), and vice versa.

## 7. Provider simulator (development/test only)

A first-class adapter implementation (`SimulatorAdapter`) satisfies the same `ProviderAdapter` interface and is the *only* adapter permitted to run in Phase 0–2 (no real vendor adapters are built or connected until later phases per the roadmap, and never in this repository without explicit, separate authorization). Full behavior catalogue: `TESTING.md` §"Provider simulator". **Phase 2 implements only the submission-time behaviours** (`SUCCESS`, `TIMEOUT`, `500`, `429`, `INVALID_CREDENTIALS`, `INVALID_REQUEST`, `SLOW_RESPONSE`) through the direct test-send; the delivery/webhook behaviours are Phase 3 (ADR-013 PD-3).

## 8. Related

Routing decisions over eligible providers: `ROUTING_ENGINE.md`. Delivery-outcome escalation: `FALLBACK_ENGINE.md`. Credential storage: `SECURITY.md` §"Secrets management".
