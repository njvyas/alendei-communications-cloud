import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, primaryId, timestamps, tstz } from './_shared';

/**
 * Channel and provider catalogue (Phase 2.1, `DATABASE.md` §3, ADR-013).
 *
 * **Global, not tenant-scoped.** No table here carries `org_id`, `reseller_id`
 * or `workspace_id`: a provider is platform infrastructure, not tenant data.
 * Their RLS policies (migration `0018`) therefore do not filter by tenant
 * context; they admit only a transaction carrying a validated platform-scope
 * claim (`app_has_platform_scope()`), and name no role (ADR-013 F-3).
 *
 * `provider_credentials` is deliberately absent (ADR-013 PD-2, F-1).
 *
 * Phase 2.3 (migration `0022`) adds the health and circuit-breaker state to
 * `providers` and the append-only `provider_health` samples
 * (`PROVIDER_ADAPTER.md` §5-§6).
 */

export const channelCode = pgEnum('channel_code', ['whatsapp', 'rcs', 'sms', 'email', 'voice']);
export const channelStatus = pgEnum('channel_status', ['active', 'disabled']);
/** Administrative status — the only place `draining` exists (ADR-013 F-5). */
export const providerStatus = pgEnum('provider_status', ['active', 'disabled', 'draining']);
export const providerHealthState = pgEnum('provider_health_state', [
  'healthy',
  'degraded',
  'critical',
  'offline',
]);
export const providerCircuitState = pgEnum('provider_circuit_state', [
  'closed',
  'open',
  'half_open',
]);
export const providerHealthSampleKind = pgEnum('provider_health_sample_kind', [
  'submission',
  'probe',
  'override',
]);
export const providerHealthClassification = pgEnum('provider_health_classification', [
  'success',
  'failure',
  'neutral',
]);
export const providerHealthSource = pgEnum('provider_health_source', ['automatic', 'manual']);

/** Seeded by migration `0018`; read-only through the API (ADR-013 F-2). */
export const channels = pgTable(
  'channels',
  {
    id: primaryId(),
    code: channelCode('code').notNull(),
    displayName: text('display_name').notNull(),
    status: channelStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (table) => [uniqueIndex('channels_code_key').on(table.code)],
);

export const providers = pgTable(
  'providers',
  {
    id: primaryId(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Names an adapter registered in code (`PROVIDER_ADAPTER_KEYS`; ADR-013 F-9). */
    adapterKey: text('adapter_key').notNull(),
    /** A new provider carries no traffic until an administrator enables it. */
    status: providerStatus('status').notNull().default('disabled'),
    /** Observed health: the override when set, otherwise derived from samples (`PROVIDER_ADAPTER.md` §5c). */
    healthState: providerHealthState('health_state').notNull().default('healthy'),
    /** A manual pin of `health_state` (§5d); written only by a `providers.manage` holder. */
    healthOverride: providerHealthState('health_override'),
    /** When `health_state` last changed (injected clock). */
    healthChangedAt: tstz('health_changed_at'),
    /** Moved only along the four circuit edges (§6b). */
    circuitState: providerCircuitState('circuit_state').notNull().default('closed'),
    /** +1 on every circuit transition; a ticket from an older generation is stale (§6d). */
    circuitGeneration: bigint('circuit_generation', { mode: 'number' }).notNull().default(0),
    /** When `circuit_state` last changed (injected clock); the cooldown runs from here. */
    circuitChangedAt: tstz('circuit_changed_at'),
    /** The holder of the single `half_open` probe slot, and its lease (§6c). */
    circuitProbeId: uuid('circuit_probe_id'),
    circuitProbeLeaseUntil: tstz('circuit_probe_lease_until'),
    /** Successful probes in the current `half_open` episode. */
    circuitProbeSuccesses: integer('circuit_probe_successes').notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    // One provider of a given name per channel, case-insensitively. This is
    // what makes `POST /providers` naturally idempotent: a retried create is a
    // `409`, never a second provider (`API.md` §4a).
    uniqueIndex('providers_channel_name_key').on(table.channelId, sql`lower(${table.name})`),
    index('providers_status_idx').on(table.status),
    check(
      'providers_name_length',
      sql`char_length(${table.name}) BETWEEN 1 AND 200 AND ${table.name} = btrim(${table.name})`,
    ),
    check('providers_adapter_key_format', sql`${table.adapterKey} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    // Phase 2.3: the stored state is internally consistent whoever writes it.
    check(
      'providers_health_override_applied',
      sql`${table.healthOverride} IS NULL OR ${table.healthState} = ${table.healthOverride}`,
    ),
    check('providers_circuit_generation_nonnegative', sql`${table.circuitGeneration} >= 0`),
    check(
      'providers_circuit_changed_at_present',
      sql`${table.circuitState} = 'closed' OR ${table.circuitChangedAt} IS NOT NULL`,
    ),
    check(
      'providers_circuit_probe_slot',
      sql`(${table.circuitProbeId} IS NULL) = (${table.circuitProbeLeaseUntil} IS NULL) AND (${table.circuitProbeId} IS NULL OR ${table.circuitState} = 'half_open')`,
    ),
    check(
      'providers_circuit_probe_successes',
      sql`${table.circuitProbeSuccesses} >= 0 AND (${table.circuitProbeSuccesses} = 0 OR ${table.circuitState} = 'half_open')`,
    ),
  ],
);

/** Declared, non-secret capabilities; replaced as a whole set (`PUT /providers/:id/capabilities`). */
export const providerCapabilities = pgTable(
  'provider_capabilities',
  {
    id: primaryId(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    capabilityKey: text('capability_key').notNull(),
    value: jsonb('value').notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('provider_capabilities_provider_key_key').on(table.providerId, table.capabilityKey),
    check(
      'provider_capabilities_key_format',
      sql`${table.capabilityKey} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
    check('provider_capabilities_value_size', sql`octet_length(${table.value}::text) <= 4096`),
  ],
);

/**
 * One row per health observation (Phase 2.3, `PROVIDER_ADAPTER.md` §5a).
 * Append-only: no `UPDATE`/`DELETE` grant, and a trigger refuses both (and
 * `TRUNCATE`) for every principal, migration `0022`.
 *
 * `classification` is fixed by `outcome` (§5b), and the database checks it, so
 * a sample can never be recorded as something other than what it was.
 */
export const providerHealth = pgTable(
  'provider_health',
  {
    id: primaryId(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    kind: providerHealthSampleKind('kind').notNull(),
    outcome: text('outcome').notNull(),
    classification: providerHealthClassification('classification').notNull(),
    latencyMs: integer('latency_ms'),
    /** The provider's health and circuit state after this sample was applied. */
    healthState: providerHealthState('health_state').notNull(),
    circuitState: providerCircuitState('circuit_state').notNull(),
    /** The circuit episode the observation belongs to (§6d). */
    circuitGeneration: bigint('circuit_generation', { mode: 'number' }).notNull(),
    source: providerHealthSource('source').notNull(),
    /** The injected clock: what every window is measured on. */
    observedAt: tstz('observed_at').notNull(),
    /** Database time, for forensics. */
    createdAt: createdAt(),
  },
  (table) => [
    index('provider_health_window_idx').on(table.providerId, table.observedAt, table.id),
    index('provider_health_provider_id_idx').on(table.providerId, table.id),
    check(
      'provider_health_outcome_by_kind',
      sql`(${table.kind} = 'submission' AND ${table.outcome} IN ('accepted','timeout','provider_error','rate_limited','auth_error','invalid_request','invalid_recipient','unsupported_content','configuration_error','unknown'))
       OR (${table.kind} = 'probe' AND ${table.outcome} IN ('healthy','unhealthy','timeout'))
       OR (${table.kind} = 'override' AND ${table.outcome} = 'manual')`,
    ),
    check(
      'provider_health_classification_by_outcome',
      sql`${table.classification} = CASE
        WHEN ${table.kind} = 'override' THEN 'neutral'
        WHEN ${table.kind} = 'probe' AND ${table.outcome} = 'healthy' THEN 'success'
        WHEN ${table.kind} = 'probe' THEN 'failure'
        WHEN ${table.outcome} = 'accepted' THEN 'success'
        WHEN ${table.outcome} IN ('timeout','provider_error','rate_limited','unknown') THEN 'failure'
        ELSE 'neutral' END::provider_health_classification`,
    ),
    check(
      'provider_health_source_by_kind',
      sql`(${table.source} = 'manual') = (${table.kind} = 'override')`,
    ),
    check(
      'provider_health_latency',
      sql`(${table.latencyMs} IS NULL) = (${table.kind} = 'override') AND (${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0)`,
    ),
    check('provider_health_generation_nonnegative', sql`${table.circuitGeneration} >= 0`),
  ],
);
