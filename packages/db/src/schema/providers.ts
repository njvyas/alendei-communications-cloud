import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './_shared';

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
    /** Read-only in 2.1; set by the health mechanism in 2.3. */
    healthState: providerHealthState('health_state').notNull().default('healthy'),
    /** Read-only in 2.1; set by the circuit breaker in 2.3. */
    circuitState: providerCircuitState('circuit_state').notNull().default('closed'),
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
