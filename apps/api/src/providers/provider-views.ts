import { HttpStatus } from '@nestjs/common';
import {
  ERROR_CODES,
  type ChannelCode,
  type ChannelStatus,
  type ProviderCircuitPolicy,
  type ProviderCircuitState,
  type ProviderHealthClassification,
  type ProviderHealthSampleKind,
  type ProviderHealthSource,
  type ProviderHealthState,
  type ProviderStatus,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { asc, eq } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { cooldownUntil, type CircuitSnapshot } from './provider-state-machine';

/**
 * The channel and provider resources and the lookups every provider service
 * shares (`FRONTEND_API_CONTRACT.md` §32). Extracted from the 2.1 registry
 * service in 2.3 so the health service answers with the same shapes.
 */

/** The channel resource (`FRONTEND_API_CONTRACT.md` §32a). Exhaustive. */
export interface ChannelView {
  readonly id: string;
  readonly code: ChannelCode;
  readonly displayName: string;
  readonly status: ChannelStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The provider resource (`FRONTEND_API_CONTRACT.md` §32b). Exhaustive. */
export interface ProviderView {
  readonly id: string;
  readonly channelId: string;
  readonly channelCode: ChannelCode;
  readonly name: string;
  readonly adapterKey: string;
  readonly status: ProviderStatus;
  /** Derived from samples, or the override when one is set (`PROVIDER_ADAPTER.md` §5). */
  readonly healthState: ProviderHealthState;
  /** The manual pin, or `null` when health is derived automatically. */
  readonly healthOverride: ProviderHealthState | null;
  readonly healthChangedAt: string | null;
  /** Moved only by the circuit breaker (`PROVIDER_ADAPTER.md` §6). */
  readonly circuitState: ProviderCircuitState;
  readonly circuitChangedAt: string | null;
  /** When an `open` circuit's cooldown ends; `null` in any other state. */
  readonly circuitCooldownUntil: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderCapabilityView {
  readonly key: string;
  readonly value: unknown;
}

/** `GET /providers/:id` and every mutation answer: the provider with its capability set. */
export interface ProviderDetailView extends ProviderView {
  readonly capabilities: readonly ProviderCapabilityView[];
}

/** One `provider_health` sample (`GET /providers/:id/health`). Exhaustive. */
export interface ProviderHealthSampleView {
  readonly id: string;
  readonly providerId: string;
  readonly kind: ProviderHealthSampleKind;
  readonly outcome: string;
  readonly classification: ProviderHealthClassification;
  readonly latencyMs: number | null;
  readonly healthState: ProviderHealthState;
  readonly circuitState: ProviderCircuitState;
  readonly circuitGeneration: number;
  readonly source: ProviderHealthSource;
  readonly observedAt: string;
  readonly createdAt: string;
}

export type ChannelRow = typeof schema.channels.$inferSelect;
export type ProviderRow = typeof schema.providers.$inferSelect;
export type ProviderHealthRow = typeof schema.providerHealth.$inferSelect;
export type CircuitPolicyRow = typeof schema.providerCircuitPolicy.$inferSelect;

/** `GET`/`PUT /provider-circuit-policy` (`PROVIDER_ADAPTER.md` §6i). Exhaustive: no internal field. */
export interface CircuitPolicyView extends ProviderCircuitPolicy {
  readonly version: number;
  readonly updatedAt: string;
}

/** Every catalogue decision is made at platform scope (ADR-013 F-3). */
export const PLATFORM = { scopeType: 'platform', scopeId: null } as const;

export function channelView(row: ChannelRow): ChannelView {
  return {
    id: row.id,
    code: row.code,
    displayName: row.displayName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function providerView(
  row: ProviderRow,
  channelCode: ChannelCode,
  policy: Pick<ProviderCircuitPolicy, 'cooldownMs'>,
): ProviderView {
  const cooldown = cooldownUntil(circuitSnapshot(row), policy);
  return {
    id: row.id,
    channelId: row.channelId,
    channelCode,
    name: row.name,
    adapterKey: row.adapterKey,
    status: row.status,
    healthState: row.healthState,
    healthOverride: row.healthOverride,
    healthChangedAt: row.healthChangedAt?.toISOString() ?? null,
    circuitState: row.circuitState,
    circuitChangedAt: row.circuitChangedAt?.toISOString() ?? null,
    circuitCooldownUntil: cooldown?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function healthSampleView(row: ProviderHealthRow): ProviderHealthSampleView {
  return {
    id: row.id,
    providerId: row.providerId,
    kind: row.kind,
    outcome: row.outcome,
    classification: row.classification,
    latencyMs: row.latencyMs,
    healthState: row.healthState,
    circuitState: row.circuitState,
    circuitGeneration: row.circuitGeneration,
    source: row.source,
    observedAt: row.observedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The circuit columns of a provider row, as the state machine reads them. */
export function circuitSnapshot(row: ProviderRow): CircuitSnapshot {
  return {
    state: row.circuitState,
    generation: row.circuitGeneration,
    changedAt: row.circuitChangedAt,
    probes: row.circuitProbes.map((p) => ({ id: p.id, leaseUntil: new Date(p.leaseUntil) })),
    probeSuccesses: row.circuitProbeSuccesses,
  };
}

/** The policy's eight parameters, as the circuit engine consumes them. */
export function circuitPolicyOf(row: CircuitPolicyRow): ProviderCircuitPolicy {
  return {
    windowMs: row.windowMs,
    windowMaxSamples: row.windowMaxSamples,
    minSamples: row.minSamples,
    failurePercent: row.failurePercent,
    cooldownMs: row.cooldownMs,
    halfOpenMaxProbes: row.halfOpenMaxProbes,
    probeLeaseMs: row.probeLeaseMs,
    halfOpenSuccessesToClose: row.halfOpenSuccessesToClose,
  };
}

export function circuitPolicyView(row: CircuitPolicyRow): CircuitPolicyView {
  return { ...circuitPolicyOf(row), version: row.version, updatedAt: row.updatedAt.toISOString() };
}

/**
 * The platform circuit policy as this transaction sees it (§6a). Read by every
 * circuit decision after the provider row lock is taken; `forUpdate` only by
 * the policy update itself. Its absence is a broken installation, not a
 * request error.
 */
export async function loadCircuitPolicy(
  tx: Transaction,
  options: { forUpdate?: boolean } = {},
): Promise<CircuitPolicyRow> {
  const query = tx
    .select()
    .from(schema.providerCircuitPolicy)
    .where(eq(schema.providerCircuitPolicy.scope, 'platform'));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row)
    throw new Error('provider_circuit_policy has no platform row (migration 0023 seeds it)');
  return row;
}

/** One provider row, optionally locked `FOR UPDATE`; `404` when it does not exist. */
export async function loadProvider(
  tx: Transaction,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<ProviderRow> {
  const query = tx.select().from(schema.providers).where(eq(schema.providers.id, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw notFound('Provider', id);
  return row;
}

export async function channelCodeOf(tx: Transaction, channelId: string): Promise<ChannelCode> {
  const [channel] = await tx
    .select({ code: schema.channels.code })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId));
  return channel!.code;
}

export async function readCapabilities(
  tx: Transaction,
  providerId: string,
): Promise<ProviderCapabilityView[]> {
  const rows = await tx
    .select({
      key: schema.providerCapabilities.capabilityKey,
      value: schema.providerCapabilities.value,
    })
    .from(schema.providerCapabilities)
    .where(eq(schema.providerCapabilities.providerId, providerId))
    .orderBy(asc(schema.providerCapabilities.capabilityKey));
  return rows.map((r) => ({ key: r.key, value: r.value }));
}

export async function providerDetail(
  tx: Transaction,
  row: ProviderRow,
): Promise<ProviderDetailView> {
  return {
    ...providerView(row, await channelCodeOf(tx, row.channelId), await loadCircuitPolicy(tx)),
    capabilities: await readCapabilities(tx, row.id),
  };
}

export function lifecycleConflict(status: ProviderStatus): AppException {
  return new AppException({
    status: HttpStatus.CONFLICT,
    code: ERROR_CODES.PROVIDER_LIFECYCLE_CONFLICT,
    message: `This provider is ${status}; the operation is not permitted in that state`,
    // Readable through `GET /providers/:id`, so naming it discloses nothing.
    details: { status },
  });
}

/**
 * The provider's catalogue `adapter_key` names no registered adapter: fail
 * closed (`422`), naming the registered keys (`PROVIDER_ADAPTER.md` §6f step 5).
 */
export function adapterNotRegistered(
  provider: Pick<ProviderRow, 'id' | 'adapterKey'>,
  adapterKeys: readonly string[],
): AppException {
  return new AppException({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ERROR_CODES.PROVIDER_ADAPTER_UNKNOWN,
    message: "The provider's adapter is not registered",
    details: { adapterKeys: [...adapterKeys] },
    logContext: { providerId: provider.id, adapterKey: provider.adapterKey },
  });
}

export function notFound(resource: 'Provider' | 'Channel', id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: `${resource} not found`,
    logContext: { [`requested${resource}Id`]: id },
  });
}
