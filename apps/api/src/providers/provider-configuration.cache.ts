import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  ChannelCode,
  ChannelStatus,
  ProviderCircuitPolicy,
  ProviderStatus,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { asc } from 'drizzle-orm';

import { MetricsService } from '../observability/metrics.service';
import {
  ConfigurationSnapshotCache,
  type HintOutcome,
  type ReloadCause,
  type ReloadOutcome,
} from './configuration-snapshot-cache';
import { PROVIDER_CLOCK, type ProviderClock } from './provider-clock';
import { circuitPolicyOf } from './provider-views';

/** The advisory configuration snapshot (`PROVIDER_ADAPTER.md` §3a.1). Never health or circuit state. */
export interface ProviderConfigurationSnapshot {
  readonly revision: number;
  /** When the revision was committed (database time). */
  readonly changedAt: Date;
  readonly channels: readonly {
    readonly id: string;
    readonly code: ChannelCode;
    readonly displayName: string;
    readonly status: ChannelStatus;
  }[];
  readonly providers: readonly {
    readonly id: string;
    readonly channelId: string;
    readonly name: string;
    readonly adapterKey: string;
    readonly status: ProviderStatus;
    readonly capabilities: Readonly<Record<string, unknown>>;
  }[];
  readonly circuitPolicy: ProviderCircuitPolicy & { readonly version: number };
}

/**
 * Phase 2.4 hot reload (`PROVIDER_ADAPTER.md` §3a): the instance's advisory
 * configuration snapshot, loaded from PostgreSQL and reconciled against the
 * transactional configuration revision.
 *
 * **Advisory only — never authorization.** `read` may be called only inside a
 * request transaction whose principal `AuthorizationService` has already
 * authorized for `providers.read` at platform scope, so loading runs under
 * that principal's RLS; nothing that authorizes, administers, enforces
 * lifecycle, admits or submits calls it (an architecture test pins this).
 */
@Injectable()
export class ProviderConfigurationCache {
  private readonly logger = new Logger(ProviderConfigurationCache.name);
  private readonly cache: ConfigurationSnapshotCache<ProviderConfigurationSnapshot, Transaction>;

  constructor(
    @Inject(PROVIDER_CLOCK) clock: ProviderClock,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.cache = new ConfigurationSnapshotCache(
      { revision: (tx) => readRevision(tx).then((r) => r.revision), load: loadSnapshot },
      clock,
      { reloaded: (cause, outcome, snapshot) => this.observe(cause, outcome, snapshot) },
    );
  }

  /** The snapshot to serve. Only after authorization, inside the authorized transaction. */
  read(tx: Transaction): Promise<ProviderConfigurationSnapshot> {
    return this.cache.read(tx);
  }

  /** A configuration notification's payload (a revision hint). */
  hint(payload: string): HintOutcome {
    const outcome = this.cache.hint(payload);
    this.metrics?.providerConfigNotifications.inc({ outcome });
    return outcome;
  }

  /** This instance just committed a configuration change: read-your-writes without waiting for the notification. */
  invalidateLocal(operation: string): void {
    this.cache.invalidate('local');
    this.metrics?.providerConfigLocalInvalidations.inc({ operation });
  }

  /** The LISTEN connection was lost: notifications may have been missed. */
  invalidateListenerLost(): void {
    this.cache.invalidate('listener');
  }

  peek(): ProviderConfigurationSnapshot | null {
    return this.cache.peek();
  }

  isDirty(): boolean {
    return this.cache.isDirty();
  }

  private observe(
    cause: ReloadCause,
    outcome: ReloadOutcome,
    snapshot: ProviderConfigurationSnapshot | null,
  ): void {
    this.metrics?.providerConfigReloads.inc({ operation: cause, outcome });
    if (outcome === 'success' && snapshot) {
      this.metrics?.providerConfigRevision.set(snapshot.revision);
      this.metrics?.providerConfigConvergence.observe(
        Math.max(0, (Date.now() - snapshot.changedAt.getTime()) / 1000),
      );
    } else if (outcome === 'failure') {
      this.logger.warn({ msg: 'provider configuration reload failed', cause });
    } else if (outcome === 'discarded') {
      this.logger.log({
        msg: 'provider configuration reload discarded: older than the installed snapshot',
        cause,
        revision: snapshot?.revision,
      });
    }
  }
}

async function readRevision(tx: Transaction): Promise<{ revision: number; changedAt: Date }> {
  const [row] = await tx.select().from(schema.providerConfigurationRevision);
  if (!row) throw new Error('provider_configuration_revision has no row (migration 0024 seeds it)');
  return { revision: row.revision, changedAt: row.changedAt };
}

/** Revision first, then the configuration, in one transaction: the data is never older than its label. */
async function loadSnapshot(tx: Transaction): Promise<ProviderConfigurationSnapshot> {
  const { revision, changedAt } = await readRevision(tx);
  const channels = await tx.select().from(schema.channels).orderBy(asc(schema.channels.code));
  const providers = await tx
    .select({
      id: schema.providers.id,
      channelId: schema.providers.channelId,
      name: schema.providers.name,
      adapterKey: schema.providers.adapterKey,
      status: schema.providers.status,
    })
    .from(schema.providers)
    .orderBy(asc(schema.providers.name), asc(schema.providers.id));
  const capabilities = await tx
    .select({
      providerId: schema.providerCapabilities.providerId,
      key: schema.providerCapabilities.capabilityKey,
      value: schema.providerCapabilities.value,
    })
    .from(schema.providerCapabilities);
  const [policy] = await tx.select().from(schema.providerCircuitPolicy);
  if (!policy) throw new Error('provider_circuit_policy has no platform row');

  const byProvider = new Map<string, Record<string, unknown>>();
  for (const c of capabilities) {
    const entry = byProvider.get(c.providerId) ?? {};
    entry[c.key] = c.value;
    byProvider.set(c.providerId, entry);
  }
  return Object.freeze({
    revision,
    changedAt,
    channels: Object.freeze(
      channels.map((c) =>
        Object.freeze({ id: c.id, code: c.code, displayName: c.displayName, status: c.status }),
      ),
    ),
    providers: Object.freeze(
      providers.map((p) =>
        Object.freeze({ ...p, capabilities: Object.freeze(byProvider.get(p.id) ?? {}) }),
      ),
    ),
    circuitPolicy: Object.freeze({ ...circuitPolicyOf(policy), version: policy.version }),
  });
}
