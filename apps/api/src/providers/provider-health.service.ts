import { Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  PERMISSIONS,
  PROVIDER_HEALTH_DEFAULTS,
  type AuthPrincipal,
  type ChannelCode,
  type PageInfo,
  type ProviderCircuitState,
  type ProviderHealthState,
  type ProviderProbeOutcome,
  type SimulatorHealthBehavior,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq } from 'drizzle-orm';

import { RequestContext } from '../common/context/request-context';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { ProviderSubmissionExecutor } from '../provider-adapters/submission-executor';
import { ProviderAccess } from './provider-access.service';
import { ProviderRegistryService } from './provider-registry.service';
import { ProviderStateStore } from './provider-state.store';
import {
  channelCodeOf,
  healthSampleView,
  loadProvider,
  providerDetail,
  readCapabilities,
  type ProviderDetailView,
  type ProviderHealthSampleView,
} from './provider-views';

/** `POST /providers/:id/health-check` answer (`FRONTEND_API_CONTRACT.md` §32b). Exhaustive. */
export interface ProviderHealthCheckView {
  readonly providerId: string;
  readonly adapterKey: string;
  readonly channelCode: ChannelCode;
  readonly behavior: SimulatorHealthBehavior;
  /** The probe's answer. An unhealthy answer is data, not an HTTP error. */
  readonly outcome: ProviderProbeOutcome;
  readonly latencyMs: number;
  readonly correlationId: string;
  /** The provider's health after the probe was recorded; the circuit is untouched by a probe. */
  readonly healthState: ProviderHealthState;
  readonly circuitState: ProviderCircuitState;
}

/**
 * Provider health — the explicit health check, the manual override and the
 * sample history (Phase 2.3, `PROVIDER_ADAPTER.md` §5, ROADMAP §5b 2.3).
 *
 * Authorized exactly as the catalogue is (`ProviderAccess`): `providers.manage`
 * at platform scope to probe or override, `providers.read` to read the history.
 * State changes go through `ProviderStateStore` only.
 */
@Injectable()
export class ProviderHealthService {
  private readonly logger = new Logger(ProviderHealthService.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly access: ProviderAccess,
    private readonly lists: ListQuery,
    private readonly registry: ProviderRegistryService,
    private readonly executor: ProviderSubmissionExecutor,
    private readonly state: ProviderStateStore,
  ) {}

  private readonly sampleListSpec: ListQuerySpec = {
    sortable: {
      // `id` (UUIDv7) — insertion order, and a cursor that round-trips exactly.
      createdAt: { column: schema.providerHealth.id, encode: (row) => String(row.id) },
    },
    defaultSort: '-createdAt',
    tieBreaker: schema.providerHealth.id,
  };

  /**
   * Runs the adapter's health check (§5e) — a diagnostic, permitted in every
   * lifecycle status and every circuit state, that moves health only.
   *
   * As test-send does, it runs the adapter between two transactions so none is
   * held across the probe's timeout: the first authorizes and resolves the
   * adapter from the catalogue row; the second re-checks the authority fresh
   * from the database and records the `probe` sample, `provider.health_checked`
   * (`success` for a healthy answer, `failure` otherwise) and any
   * `provider.health_changed`.
   */
  async healthCheck(
    principal: AuthPrincipal,
    id: string,
    behavior: SimulatorHealthBehavior,
  ): Promise<ProviderHealthCheckView> {
    const target = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      const provider = await loadProvider(tx, id);
      const adapter = this.registry.simulatorFor(provider);
      const capabilities = await readCapabilities(tx, provider.id);
      return {
        provider,
        adapter,
        channel: await channelCodeOf(tx, provider.channelId),
        capabilities: Object.fromEntries(capabilities.map((c) => [c.key, c.value])),
      };
    });

    const probe = await this.executor.probe(
      target.adapter.forHealthBehavior(behavior),
      {
        providerId: target.provider.id,
        adapterKey: target.provider.adapterKey,
        channel: target.channel,
        capabilities: target.capabilities,
      },
      PROVIDER_HEALTH_DEFAULTS.PROBE_TIMEOUT_MS,
    );

    const recorded = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      await this.access.assertAuthorityCurrent(tx, PERMISSIONS.PROVIDERS_MANAGE, {
        reason: 'authority withdrawn while the health check ran; result not recorded',
        providerId: id,
      });
      const states = await this.state.recordProbe(tx, principal, id, probe);
      await this.access.record(
        tx,
        principal,
        AUDIT_ACTIONS.PROVIDER_HEALTH_CHECKED,
        id,
        null,
        {
          behavior,
          outcome: probe.outcome,
          latencyMs: probe.latencyMs,
          healthState: states.healthState,
        },
        probe.outcome === 'healthy' ? 'success' : 'failure',
      );
      return states;
    });

    const correlationId = RequestContext.correlationId();
    this.logger.log({
      msg: 'provider health check',
      providerId: id,
      adapterKey: target.provider.adapterKey,
      channel: target.channel,
      behavior,
      outcome: probe.outcome,
      latencyMs: probe.latencyMs,
      healthState: recorded.healthState,
      correlationId,
    });
    return {
      providerId: id,
      adapterKey: target.provider.adapterKey,
      channelCode: target.channel,
      behavior,
      outcome: probe.outcome,
      latencyMs: probe.latencyMs,
      correlationId,
      healthState: recorded.healthState,
      circuitState: recorded.circuitState,
    };
  }

  /**
   * Sets (`override` a state) or clears (`override: null`) the manual health
   * override (§5d). Naturally idempotent: the override already in force changes
   * nothing and records nothing. Never touches the circuit or the lifecycle.
   */
  async setOverride(
    principal: AuthPrincipal,
    id: string,
    override: ProviderHealthState | null,
    reason: string | null,
  ): Promise<ProviderDetailView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      const row = await this.state.setOverride(tx, principal, id, override, reason);
      return providerDetail(tx, row);
    });
  }

  /** The provider's samples, newest first (`GET /providers/:id/health`). */
  async listSamples(
    principal: AuthPrincipal,
    id: string,
    filter: ListQueryInput = {},
  ): Promise<{ items: readonly ProviderHealthSampleView[]; page: PageInfo }> {
    const resolved = this.lists.resolve(filter, this.sampleListSpec);
    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
      await loadProvider(tx, id);
      return tx
        .select()
        .from(schema.providerHealth)
        .where(and(eq(schema.providerHealth.providerId, id), resolved.after))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });
    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.sampleListSpec,
      (row) => String(row.id),
    );
    return { items: items.map((row) => healthSampleView(row as never)), page };
  }
}
