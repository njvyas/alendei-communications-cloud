# Provider Abstraction Architecture

## 1. Purpose

No module outside `provider-adapters` may know a specific vendor's API shape. Adding, removing, or replacing a provider is a configuration + adapter-implementation change, never a change to campaign, journey, billing, or orchestrator logic.

## 2. Provider Adapter Interface

Every provider integration implements the same TypeScript interface (illustrative — exact types finalized in Phase 1):

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

## 4. Admin operations (no deploy, no restart) — all privileged, all audited

All of the following are DB writes to `providers`/`provider_capabilities`/`routing_policies` plus a cache-invalidation broadcast — never a code or config-file change. **Every one of them is a privileged operation**: gated behind the `providers.manage` permission (or the narrower `providers.test_send` for test-sends specifically), and every invocation writes an `audit_logs` row with the actor, the exact before/after values, and the target provider — with no exception, since a mis-issued priority/weight/drain change can silently redirect real traffic and a test-send can incur real provider cost or generate a real customer-visible message once a real provider is connected.

- Add / enable / disable a provider.
- Drain a provider (health_state → `DRAINING`: stop accepting *new* messages, let in-flight attempts complete).
- **Test a provider**: sends a synthetic message through the simulator-backed test path in Phase 0–2 (`TESTING.md` §2); once real providers are connected (post-Phase-12 business decision, never in this repository without separate explicit authorization), a test-send is capable of incurring real cost or reaching a real recipient, so it additionally requires an explicit target (never a wildcard/broadcast test), environment awareness (a production test-send is a deliberately higher-friction action than a staging one — e.g. an additional confirmation step), and is subject to the same rate limiting as any other send path so a misconfigured test loop cannot itself become a cost or abuse incident.
- Change priority / weight / routing policy assignment.
- Configure health thresholds (error-rate/latency windows that drive automatic health/circuit transitions).
- Migrate traffic between providers, including canary migration (route X% to a new provider, monitor, ramp).
- Roll back a provider or routing change (activate a prior `routing_policy_versions` row; re-enable a disabled provider).

## 4a. Credential ownership & precedence

Per `DATABASE.md` §3, a provider credential is owned at exactly one of three scopes, and selection at send time always prefers the most specific match:

```
organization-owned credential (this org has its own contract/keys with the provider)
        ↓ (if none active)
reseller-owned credential (the org's reseller supplies a shared credential for its book of organizations)
        ↓ (if none active)
platform-owned credential (Alendei's own shared/default credential for the provider)
```

Only one credential per `(provider_id, scope_type, scope_id)` may be `is_active` at a time. Viewing/managing a credential requires a permission scoped to its own `scope_type` (an organization admin can manage only their own organization-scoped credentials, never a reseller- or platform-scoped one; a reseller admin can manage their reseller-scoped credentials but not another reseller's). **No credential's plaintext value is ever exposed to any frontend client at any scope** — only `credential_ref` metadata (a label, `rotated_at`, `scope_type`) is ever returned by the API; the raw secret is resolved server-side, at call time, directly from the secrets backend (`SECURITY.md` §3). Rotation and revocation follow `RUNBOOK.md` §"Provider credential rotation" regardless of which scope owns the credential.

## 5. Provider health states

| State | Meaning | Effect on routing |
|---|---|---|
| `HEALTHY` | Normal operation | Fully eligible |
| `DEGRADED` | Elevated latency/error rate below critical threshold | Eligible but de-weighted by quality/latency-aware policies |
| `CRITICAL` | Error/latency breach approaching automatic circuit trip | Eligible only as last resort / excluded depending on policy config |
| `OFFLINE` | Health checks failing / manually marked down | Excluded from routing |
| `DRAINING` | Being retired/migrated off | Excluded from *new* routing decisions; existing in-flight attempts complete normally |

Health state is derived from `provider_health` samples (automatic) or set directly by an admin action (manual), both recorded with `source` for audit clarity.

## 6. Circuit breaker

Distinct, faster-reacting signal than health state — designed to shed load quickly during a transient spike rather than wait for a slower SLO-window health recalculation.

| State | Trigger | Behavior |
|---|---|---|
| `CLOSED` | Default; error rate within threshold | Requests flow normally |
| `OPEN` | Rolling error/timeout rate exceeds threshold within a short window | Requests short-circuit immediately to the Fallback Engine without calling the provider |
| `HALF_OPEN` | After a cooldown period | A limited number of probe requests are allowed through; success closes the breaker, failure re-opens it |

Circuit state and health state both feed the Provider Router's eligibility filter (`ROUTING_ENGINE.md`), but are tracked and transitioned independently — a provider can be `HEALTHY` (good rolling average) while momentarily `OPEN` (a fresh burst of errors not yet reflected in the longer health window), and vice versa.

## 7. Provider simulator (development/test only)

A first-class adapter implementation (`SimulatorAdapter`) satisfies the same `ProviderAdapter` interface and is the *only* adapter permitted to run in Phase 0–2 (no real vendor adapters are built or connected until later phases per the roadmap, and never in this repository without explicit, separate authorization). Full behavior catalogue: `TESTING.md` §"Provider simulator".

## 8. Related

Routing decisions over eligible providers: `ROUTING_ENGINE.md`. Delivery-outcome escalation: `FALLBACK_ENGINE.md`. Credential storage: `SECURITY.md` §"Secrets management".
