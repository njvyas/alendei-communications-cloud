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
