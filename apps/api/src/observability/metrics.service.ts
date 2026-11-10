import { Injectable, type OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import { AppConfigService } from '../config/app-config.service';

/**
 * Prometheus metrics with a hard cardinality boundary (`OBSERVABILITY.md` §3).
 *
 * Labels are drawn only from the bounded set: `environment`, `service`,
 * `operation`, `channel`, `provider`, `status`, `route`, `method`. High
 * cardinality identifiers — `org_id`/`tenant_id`, `contact_id`, `message_id`,
 * `campaign_id`, `journey_id`, `provider_message_id` — never appear as a label
 * on any metric. Per-tenant and per-message detail belongs in logs, traces and
 * business analytics, which are per-event records rather than continuously
 * aggregated time series.
 *
 * `assertBoundedLabels` enforces this at construction time, so the rule is a
 * runtime guarantee rather than a review convention.
 */
const ALLOWED_LABELS = new Set([
  'environment',
  'service',
  'operation',
  'channel',
  'provider',
  'status',
  'route',
  'method',
  'outcome',
  'consumer_group',
  'event_type',
  // Phase 2.3: the two ends of a provider health or circuit transition — each a
  // fixed enum of at most four values (`PROVIDER_ADAPTER.md` §6g).
  'from_state',
  'to_state',
  // Phase 5.0 PR-C (spec Rev 2 §E.8): the provider adapter key (a registered adapter, today
  // only `simulator`, or `unknown` before a key resolves), a verification-failure reason
  // (four fixed values) and the delivery status a transition reached (three fixed values).
  'adapter',
  'reason',
  'to',
  // Phase 7 PR 7-6c (handover Rev 2 §5): the operator resolution action — `charge` or
  // `write_off`, two fixed values.
  'action',
]);

/** Labels that would create one time series per tenant/message/campaign. */
export const FORBIDDEN_LABELS = [
  'tenant_id',
  'org_id',
  'organization_id',
  'workspace_id',
  'user_id',
  'customer_id',
  'contact_id',
  'message_id',
  'campaign_id',
  'journey_id',
  'conversation_id',
  'provider_message_id',
  'correlation_id',
  'trace_id',
  'request_id',
  'api_key_id',
  'session_id',
] as const;

export function assertBoundedLabels(metricName: string, labels: readonly string[]): void {
  for (const label of labels) {
    if (!ALLOWED_LABELS.has(label)) {
      throw new Error(
        `Metric "${metricName}" declares label "${label}", which is not in the bounded label set. ` +
          'High-cardinality identifiers must never become Prometheus labels (OBSERVABILITY.md §3).',
      );
    }
  }
}

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly dbPoolConnections: Gauge<'status'>;
  readonly eventsPublished: Counter<'event_type' | 'outcome'>;
  readonly eventsProcessed: Counter<'consumer_group' | 'event_type' | 'outcome'>;
  readonly outboxBacklog: Gauge<'status'>;
  /** Requests refused because the organization is suspended or closed (ROADMAP §4d, ADR-012 F-4/F-5). */
  readonly organizationStatusRefusals: Counter<'status' | 'operation'>;
  /** Live sessions revoked at sign-in to stay within `AUTH_MAX_SESSIONS_PER_USER` (ROADMAP §4d, ADR-012 F-11). */
  readonly sessionCapEvictions: Counter<never>;
  /** Every provider adapter submission, by channel and normalized outcome (Phase 2.2). */
  readonly providerSubmissions: Counter<'channel' | 'outcome'>;
  /** Provider health checks, by channel and probe outcome (Phase 2.3). */
  readonly providerHealthChecks: Counter<'channel' | 'outcome'>;
  /** 1 for each provider's current health state, 0 for the others (Phase 2.3). */
  readonly providerHealthState: Gauge<'provider' | 'status'>;
  readonly providerHealthTransitions: Counter<'provider' | 'from_state' | 'to_state'>;
  /** 1 for each provider's current circuit state, 0 for the others (Phase 2.3). */
  readonly providerCircuitState: Gauge<'provider' | 'status'>;
  readonly providerCircuitTransitions: Counter<'provider' | 'from_state' | 'to_state'>;
  /** Submissions refused by the circuit without calling the adapter (Phase 2.3). */
  readonly providerCircuitRejections: Counter<'provider' | 'status'>;
  /** Half-open probe results, and probe slots reclaimed after their lease (Phase 2.3). */
  readonly providerCircuitProbes: Counter<'provider' | 'outcome'>;
  /** Phase 2.4 hot reload (`PROVIDER_ADAPTER.md` §3a.6). */
  readonly providerConfigLocalInvalidations: Counter<'operation'>;
  readonly providerConfigNotifications: Counter<'outcome'>;
  readonly providerConfigReloads: Counter<'operation' | 'outcome'>;
  readonly providerConfigRevision: Gauge<never>;
  readonly providerConfigConvergence: Histogram<never>;
  readonly providerConfigListenerConnected: Gauge<never>;
  readonly providerConfigListenerEvents: Counter<'outcome'>;
  // Phase 5.0 PR-C — provider webhook ingress (spec Rev 2 §E.8, plan §1.1–§1.2).
  readonly webhookRequests: Counter<'adapter' | 'outcome'>;
  readonly webhookEvents: Counter<'adapter' | 'outcome'>;
  readonly webhookVerificationFailures: Counter<'adapter' | 'reason'>;
  readonly deliveryTransitions: Counter<'channel' | 'to'>;
  readonly deliveryReceiptLatency: Histogram<'channel'>;
  // Phase 7 PR 7-1 — read-only ledger partition startup verification (DECISIONS.md §1zi RQ-4, RQ-6).
  readonly ledgerPartitionHeadroomMonths: Gauge<never>;
  readonly ledgerPartitionUnprotected: Gauge<never>;
  readonly ledgerPartitionCheckFailures: Counter<never>;
  // Phase 7 PR 7-5 — the bounded retry of the dispatcher's settlement transaction (OD-7-2).
  readonly dispatchSettlementRetries: Counter<'outcome'>;
  // Phase 7 PR 7-6b — the unknown-outcome register (baseline §6.5, Policy U).
  readonly billingOutcomeUnknownOpen: Gauge<'channel'>;
  // Phase 7 PR 7-6c — operator resolution of unknown outcomes.
  readonly billingOutcomeUnknownResolutions: Counter<'action' | 'outcome'>;
  // Phase 7 PR 7-6d-1 — billing-account operations.
  readonly billingAccountOperations: Counter<'action' | 'outcome'>;
  // Phase 7 PR 7-6d-2 (PR #101 review): approval refusals that could not be recorded.
  readonly billingAccountRefusalRecordFailures: Counter<string>;

  constructor(private readonly config: AppConfigService) {
    this.registry.setDefaultLabels({
      environment: this.config.appEnv,
      service: this.config.serviceName,
    });

    this.httpRequests = this.counter({
      name: 'acc_http_requests_total',
      help: 'HTTP requests handled, by route pattern and response status class.',
      labelNames: ['method', 'route', 'status'],
    });

    this.httpDuration = this.histogram({
      name: 'acc_http_request_duration_seconds',
      help: 'HTTP request latency in seconds.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });

    this.dbPoolConnections = this.gauge({
      name: 'acc_db_pool_connections',
      help: 'PostgreSQL pool connections by state.',
      labelNames: ['status'],
    });

    this.eventsPublished = this.counter({
      name: 'acc_events_published_total',
      help: 'Domain events published from the transactional outbox.',
      labelNames: ['event_type', 'outcome'],
    });

    this.eventsProcessed = this.counter({
      name: 'acc_events_processed_total',
      help: 'Domain events consumed, by consumer group and outcome.',
      labelNames: ['consumer_group', 'event_type', 'outcome'],
    });

    this.outboxBacklog = this.gauge({
      name: 'acc_outbox_backlog',
      help: 'Outbox rows awaiting publication, by status.',
      labelNames: ['status'],
    });

    this.organizationStatusRefusals = this.counter({
      name: 'acc_organization_status_refusals_total',
      help: 'Requests refused because the organization is suspended or closed, by organization status and by operation (access: the organization could not be selected or used; mutation: a change to its data was refused).',
      labelNames: ['status', 'operation'],
    });

    this.sessionCapEvictions = this.counter({
      name: 'acc_session_cap_evictions_total',
      help: 'Live sessions revoked at sign-in because the user reached AUTH_MAX_SESSIONS_PER_USER.',
      labelNames: [],
    });

    this.providerSubmissions = this.counter({
      name: 'acc_provider_submissions_total',
      help: 'Provider adapter submissions (Phase 2.2: test-sends to the simulator), by channel and normalized outcome: accepted, or the failure category in lower case (timeout, provider_error, rate_limited, auth_error, invalid_request, configuration_error, unknown).',
      labelNames: ['channel', 'outcome'],
    });

    // Phase 2.3 (`PROVIDER_ADAPTER.md` §6g). `provider` is the catalogue id: the
    // platform catalogue is bounded (a few dozen providers), never per tenant.
    this.providerHealthChecks = this.counter({
      name: 'acc_provider_health_checks_total',
      help: 'Provider health checks (POST /providers/:id/health-check), by channel and probe outcome: healthy, unhealthy or timeout.',
      labelNames: ['channel', 'outcome'],
    });

    this.providerHealthState = this.gauge({
      name: 'acc_provider_health_state',
      help: "A provider's health state as last written by this instance: 1 for the current state, 0 for the others.",
      labelNames: ['provider', 'status'],
    });

    this.providerHealthTransitions = this.counter({
      name: 'acc_provider_health_transitions_total',
      help: 'Provider health state changes, automatic or manual, by provider and from/to state.',
      labelNames: ['provider', 'from_state', 'to_state'],
    });

    this.providerCircuitState = this.gauge({
      name: 'acc_provider_circuit_state',
      help: "A provider's circuit-breaker state as last written by this instance: 1 for the current state, 0 for the others.",
      labelNames: ['provider', 'status'],
    });

    this.providerCircuitTransitions = this.counter({
      name: 'acc_provider_circuit_transitions_total',
      help: 'Circuit-breaker transitions (closed>open, open>half_open, half_open>open, half_open>closed), by provider. Circuit-open events are to_state="open".',
      labelNames: ['provider', 'from_state', 'to_state'],
    });

    this.providerCircuitRejections = this.counter({
      name: 'acc_provider_circuit_rejections_total',
      help: 'Submissions refused by the circuit breaker without calling the adapter, by provider and circuit state (open, or half_open with the probe slot held).',
      labelNames: ['provider', 'status'],
    });

    this.providerCircuitProbes = this.counter({
      name: 'acc_provider_circuit_probes_total',
      help: 'Half-open probe results by provider: success, failure, neutral, stale (answered after the episode ended or the slot was reclaimed), or abandoned (slot reclaimed after its lease).',
      labelNames: ['provider', 'outcome'],
    });

    // Phase 2.4 hot reload (`PROVIDER_ADAPTER.md` §3a.6). The configuration
    // snapshot is advisory; these count its convergence, never a decision.
    this.providerConfigLocalInvalidations = this.counter({
      name: 'acc_provider_config_local_invalidations_total',
      help: 'Provider configuration mutations committed through this instance, each followed by a local invalidation of its advisory snapshot (the database announces the change to every instance).',
      labelNames: ['operation'],
    });
    this.providerConfigNotifications = this.counter({
      name: 'acc_provider_config_notifications_total',
      help: 'Configuration NOTIFY messages received by this instance: applied (marked the snapshot dirty), duplicate (not newer than the installed revision), malformed.',
      labelNames: ['outcome'],
    });
    this.providerConfigReloads = this.counter({
      name: 'acc_provider_config_reloads_total',
      help: 'Advisory configuration snapshot reloads, by cause (startup, notification, local, listener, reconcile, ttl) and outcome (success, failure, discarded = older than the installed snapshot).',
      labelNames: ['operation', 'outcome'],
    });
    this.providerConfigRevision = this.gauge({
      name: 'acc_provider_config_revision',
      help: 'The configuration revision of the advisory snapshot installed in this instance.',
      labelNames: [],
    });
    this.providerConfigConvergence = this.histogram({
      name: 'acc_provider_config_convergence_seconds',
      help: 'Time from the commit of a configuration revision to its installation in this instance.',
      labelNames: [],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120],
    });
    this.providerConfigListenerConnected = this.gauge({
      name: 'acc_provider_config_listener_connected',
      help: '1 while this instance holds its LISTEN connection for configuration notifications, 0 otherwise.',
      labelNames: [],
    });
    this.providerConfigListenerEvents = this.counter({
      name: 'acc_provider_config_listener_events_total',
      help: 'Configuration LISTEN connection events: connected, lost.',
      labelNames: ['outcome'],
    });

    // Phase 5.0 PR-C: provider webhook ingress. No organization, provider id or key label.
    this.webhookRequests = this.counter({
      name: 'acc_webhook_requests_total',
      help: 'Webhook ingress requests by adapter and outcome: accepted, rate_limited, not_accepted (unknown key, ingress disabled or failed verification), malformed, too_large, unsupported_media_type, error.',
      labelNames: ['adapter', 'outcome'],
    });
    this.webhookEvents = this.counter({
      name: 'acc_webhook_events_total',
      help: 'Webhook events by adapter and outcome: applied, no_change, deferred, unmatched, rejected_malformed, conflict, informational, or duplicate (counted on the original row, never stored).',
      labelNames: ['adapter', 'outcome'],
    });
    this.webhookVerificationFailures = this.counter({
      name: 'acc_webhook_verification_failures_total',
      help: 'Webhook requests refused by the adapter signature check, by reason: missing_signature, bad_signature, stale_timestamp, malformed.',
      labelNames: ['adapter', 'reason'],
    });
    this.deliveryTransitions = this.counter({
      name: 'acc_delivery_transitions_total',
      help: 'Attempt delivery-status changes applied from provider receipts, by channel and the status reached (delivered, undelivered; read sets read_at on a delivered attempt).',
      labelNames: ['channel', 'to'],
    });
    this.deliveryReceiptLatency = this.histogram({
      name: 'acc_delivery_receipt_latency_seconds',
      help: 'Time from the provider-reported event time to its receipt by the ingress, for receipts that changed delivery state.',
      labelNames: ['channel'],
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 300, 900, 3600, 21600, 86400],
    });

    this.ledgerPartitionHeadroomMonths = this.gauge({
      name: 'acc_billing_ledger_partition_headroom_months',
      help: 'Whole months of contiguous usage_ledger partitions after the current month, at the last startup verification.',
      labelNames: [],
    });
    this.ledgerPartitionUnprotected = this.gauge({
      name: 'acc_billing_ledger_partition_unprotected',
      help: 'usage_ledger partitions or same-named tables failing a protection or attachment check, at the last startup verification.',
      labelNames: [],
    });
    this.ledgerPartitionCheckFailures = this.counter({
      name: 'acc_billing_ledger_partition_check_failures_total',
      help: 'Startup partition verifications that could not read the partition report.',
      labelNames: [],
    });
    this.dispatchSettlementRetries = this.counter({
      name: 'acc_dispatch_settlement_retries_total',
      help: 'Dispatcher settlement transactions (T3) that failed at least once, by outcome: succeeded (committed on a retry), exhausted (deadlock or serialization failure past the bounded retry, or too little lease left), non_retryable (any other error). The provider call is never repeated; an unsettled submission is left to lease recovery.',
      labelNames: ['outcome'],
    });
    this.billingOutcomeUnknownOpen = this.gauge({
      name: 'acc_billing_outcome_unknown_open',
      help: 'Open unknown-outcome register items (billed under enforcement, outcome_unknown, not charged), by channel, as of the last register read.',
      labelNames: ['channel'],
    });
    this.billingOutcomeUnknownResolutions = this.counter({
      name: 'acc_billing_outcome_unknown_resolutions_total',
      help: 'Operator resolutions of unknown outcomes, by action (charge, write_off) and outcome: executed, pending (awaiting a second approver), rejected, refused (insufficient funds or account state). Counted after commit.',
      labelNames: ['action', 'outcome'],
    });
    this.billingAccountOperations = this.counter({
      name: 'acc_billing_account_operations_total',
      help: 'Billing-account operations by action (provision, credit_limit_change, freeze, unfreeze, recharge) and outcome: executed, pending (awaiting a second approver), rejected, refused (recharge refused for the wallet state). Counted after commit.',
      labelNames: ['action', 'outcome'],
    });
    this.billingAccountRefusalRecordFailures = this.counter({
      name: 'acc_billing_account_refusal_record_failures_total',
      help: 'Recharge approval refusals that could not be recorded (on the operation or in the audit log) after bounded retries. Each is also logged at error level and reported to the caller (refusalRecorded: failed). Alert on any increase.',
      labelNames: [],
    });
  }

  onModuleInit(): void {
    if (this.config.observability.metricsEnabled) {
      collectDefaultMetrics({ register: this.registry, prefix: 'acc_' });
    }
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  private counter<T extends string>(options: {
    name: string;
    help: string;
    labelNames: readonly T[];
  }): Counter<T> {
    assertBoundedLabels(options.name, options.labelNames);
    return new Counter({
      name: options.name,
      help: options.help,
      labelNames: [...options.labelNames],
      registers: [this.registry],
    });
  }

  private gauge<T extends string>(options: {
    name: string;
    help: string;
    labelNames: readonly T[];
  }): Gauge<T> {
    assertBoundedLabels(options.name, options.labelNames);
    return new Gauge({
      name: options.name,
      help: options.help,
      labelNames: [...options.labelNames],
      registers: [this.registry],
    });
  }

  private histogram<T extends string>(options: {
    name: string;
    help: string;
    labelNames: readonly T[];
    buckets: number[];
  }): Histogram<T> {
    assertBoundedLabels(options.name, options.labelNames);
    return new Histogram({
      name: options.name,
      help: options.help,
      labelNames: [...options.labelNames],
      buckets: options.buckets,
      registers: [this.registry],
    });
  }
}
