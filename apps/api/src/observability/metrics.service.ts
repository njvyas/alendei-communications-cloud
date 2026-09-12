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
