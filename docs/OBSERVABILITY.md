# Observability Architecture

## 1. Correlation model

Every log line, metric label set (where cardinality permits), trace span, and event envelope carries the same identifying keys, so any single message can be reconstructed end-to-end from any one observability system:

`correlation_id, trace_id, tenant_id (org_id), customer_id (contact_id), message_id, campaign_id, journey_id, provider_id, provider_message_id`

`correlation_id` originates at the API edge (generated if not supplied by the caller) and is propagated through every internal call, event, and log statement touching that request/message. `trace_id` is the OpenTelemetry trace identifier for the same request and is emitted alongside `correlation_id` (they are not assumed interchangeable — `trace_id` is transport/APM-specific, `correlation_id` is the stable business key kept even if a trace is sampled out).

## 2. Structured logging

- All services log structured JSON (no unstructured printf-style logs) with a fixed base schema: `timestamp, level, service, environment` + the correlation keys above + `message` + arbitrary `context`.
- PII fields are redacted by default per `SECURITY.md` §2; a log statement must explicitly opt in (and be reviewed) to include a raw contact address or message content, and even then only at levels gated for restricted access.
- Log shipping is backend-agnostic (any OTel-compatible or Loki/ELK-style collector); no application code assumes a specific log destination.

## 3. Metrics (Prometheus) — a strict cardinality boundary

**Rule (mandatory, not a style preference)**: Prometheus label sets are bounded and small. High-cardinality identifiers — `tenant_id`/`org_id`, `customer_id`/`contact_id`, `message_id`, `campaign_id`, `journey_id`, `provider_message_id` — **never** appear as Prometheus labels, on any metric, at any point. A single busy tenant or a single high-volume campaign must never be able to create a new time series per value, which is exactly what including any of those fields as a label would do at scale (cardinality blowup that degrades or crashes the metrics backend for everyone).

Safe, bounded labels for metrics: `environment`, `service`, `operation`, `channel`, `provider` (a few dozen providers at most, not unbounded), `status` (a small fixed enum), `routing_strategy`. This bounded set is what every metric in the table below is keyed on.

| Category | Representative metrics (labels drawn only from the bounded set above) |
|---|---|
| API | request latency histogram (by `route`, `status`), error rate, rate-limit rejections |
| Tenancy and sessions (Phase 1C, ROADMAP §4d) — **implemented** | `acc_organization_status_refusals_total` (by `status` = `suspended`/`closed`, `operation` = `access`/`mutation`): requests refused because the organization is suspended or closed (ADR-012 F-4/F-5), counted once per refused request where the API emits the refusal (`AllExceptionsFilter`); `acc_session_cap_evictions_total`: sessions revoked at sign-in to stay within `AUTH_MAX_SESSIONS_PER_USER` (F-11), counted after the login transaction commits. Proven by `apps/api/test/gate-c-metrics.sec-spec.ts` |
| Queue | depth per topic/consumer group, consumer lag, processing latency |
| Provider | per-provider send latency, success/failure rate (by `channel`, `provider`), circuit breaker state (as a gauge, by `provider`), health state (as a gauge, by `provider`). **Phase 2 (ADR-013 PD-8), frozen, not implemented:** health-state and circuit-state gauges and test-send count/latency by `provider` and normalized `outcome` (bounded — the provider label is the platform catalogue), with a Grafana dashboard provisioned under `infra/observability/`; console polling where needed; no live WebSocket dashboard |
| Delivery | delivery rate (delivered/sent) per `channel`/`provider`, fallback-trigger rate per `channel` |
| Webhooks | inbound webhook processing latency (by `provider`), verification-failure rate, duplicate-detected rate |
| Database | connection pool saturation, query latency (slow query threshold breaches), replication lag if applicable |
| Redis | latency, memory usage, eviction rate, lock-contention rate (fallback engine locks) |
| Infra | pod restarts, node resource saturation, HPA scaling events |
| AI | per-model latency, per-model error rate (by bounded `ai_model`/`ai_provider`), AI cost rate |

**Where per-tenant/per-message/per-campaign detail is genuinely needed**, it lives in one of two other systems, never in Prometheus:

- **Logs/traces**: carry the full correlation set (§1) — `org_id, workspace_id, contact_id, message_id, campaign_id, journey_id, provider_id, provider_message_id, correlation_id, trace_id` — because a log line or a trace span is a per-event record, not a continuously-aggregated time series, so high cardinality there is expected and safe.
- **Business analytics**: per-tenant/per-campaign/per-message reporting, dashboards, and drill-downs are served from PostgreSQL read models, OpenSearch, or a dedicated analytics store (`ARCHITECTURE.md` §13, `/reports`) — **Prometheus is never used as, or extended to become, the customer-facing analytics database.** A product question like "how many messages did campaign X send this week" is answered by a query against `messages`/`campaign_recipients` or an analytics projection, never by a Prometheus query with a `campaign_id` label.

Metrics are exposed via a standard `/metrics` endpoint per service (Prometheus scrape format), visualized in Grafana dashboards organized per module (one dashboard per row of the table above, plus a cross-cutting "message funnel" dashboard: created → queued → sent → delivered → failed, by channel/provider — using aggregate counts, never per-message labels).

## 4. Distributed tracing

OpenTelemetry instrumentation across HTTP, DB, cache, and event-bus calls; spans are named per module boundary (`comms-api.create_message`, `orchestrator.transition_state`, `provider-adapter.send`, etc.) matching the module list in `ARCHITECTURE.md` §4, so a trace visually mirrors the architectural request flow. Sampling is head-based with a configurable rate in production and 100% in dev/staging; regardless of sampling, `correlation_id` remains the durable cross-reference for a message even when its trace was sampled out.

## 5. Alerting (representative, thresholds finalized per environment in later phases)

- Provider health/circuit transitions to `CRITICAL`/`OFFLINE`/`OPEN`.
- Fallback-trigger rate exceeding a baseline (signals an upstream provider degrading faster than health checks alone caught).
- Queue consumer lag exceeding a threshold (signals processing falling behind ingestion).
- Webhook verification-failure rate spike (potential spoofing attempt or provider signature-scheme change).
- Wallet low-balance / credit-limit-approaching events surfaced to the *organization*, not just internally.
- AI cost rate anomaly (guards against runaway AI spend).

## 6. Related

Event envelope fields: `EVENTS.md` §2. Audit (a distinct, permanent, permissioned record — not a substitute for operational observability): `SECURITY.md` §4.

## Operational views and deployment identity (ADR-009)

Four views are intended, and they are served by different signals on purpose.

| View | Signal today | Status |
|---|---|---|
| Platform operations | Metrics, logs, traces, audit | **CURRENT** |
| Deployment operations | — | **GAP** — see below |
| Reseller operations | Audit only (`audit_logs.reseller_id`) | **PARTIAL** |
| Organization operations | Logs (`orgId`) and audit (`org_id`) | **CURRENT** |

**Metrics carry no tenant dimension, deliberately.** `metrics.service.ts` forbids `tenant_id`, `org_id`, `contact_id`, `message_id` and similar labels at runtime, and a unit test enforces it. One time series per tenant is a cardinality bomb, and per-tenant operational detail belongs in logs and audit instead. This is not a gap to close; a reseller- or organization-level *metrics* view is not on the roadmap.

**Audit is the richest tenancy-aware signal.** `audit_logs` carries `reseller_id`, `org_id`, `workspace_id`, `team_id` and `scope_type`/`scope_id`, all derived by the database rather than supplied by the writer. It is the substrate for reseller- and organization-level operational views, and from Phase 1B.6.3 it is readable through `GET /api/v1/audit-logs` under `audit.read` — with reseller-scoped rows visible only to a genuine reseller-scope grant (`SECURITY.md` §4).

**Logs carry `orgId` but not `resellerId`.** So reseller-level triage from logs alone is not currently possible; it comes from audit. Adding the field is small and is listed below.

### The deployment-identity gap — PLANNED

Traces carry `service.name` and `deployment.environment.name` (from `APP_ENV`, i.e. `development`/`staging`/`production`); logs carry `service` and `environment`. **There is no deployment-instance identifier**, so two production deployments shipping telemetry to one place are indistinguishable — "which customer is down" is not answerable from the signals alone.

Per ADR-009 D-2 this is **operational identity, never a database column**. The fix is a deployment-scoped configuration value surfaced as an OTel resource attribute and a pino base field, distinguishing at least:

```
production shared          production customer-A
production customer-B      on-prem customer-Y
```

Deferred to the deployment-hardening phase, alongside the artifacts in `DEPLOYMENT.md` §0h, because a deployment identifier is only useful once more than one deployment exists.

Also deferred: `resellerId` on log lines, and a `resellerId` term on the event envelope (`EventEnvelope` carries `tenantId` and `workspaceId` but no reseller, while `audit_logs` carries all three).
