import { Injectable } from '@nestjs/common';
import { PERMISSIONS, type AuthPrincipal, type ChannelCode } from '@acc/contracts';

import { TenantDatabase } from '../database/tenant-database.service';
import { ProviderAccess } from './provider-access.service';
import { ProviderConfigurationCache } from './provider-configuration.cache';
import { notFound } from './provider-views';

/** The advisory routing-candidate view (Phase 2.4, `PROVIDER_ADAPTER.md` §3a.1). Internal: no HTTP route serves it. */
export interface RoutingCandidatesView {
  readonly channelId: string;
  readonly channelCode: ChannelCode;
  /** Always true: a candidate list is advisory; circuit admission decides (`PROVIDER_ADAPTER.md` §6h). */
  readonly advisory: true;
  /** The configuration revision this answer was read at. */
  readonly configurationRevision: number;
  readonly circuitPolicyVersion: number;
  /** Lifecycle-active providers of the channel, by name. Health and circuit state are not here. */
  readonly providers: readonly {
    readonly providerId: string;
    readonly name: string;
    readonly adapterKey: string;
  }[];
}

/**
 * Advisory catalogue reads served from the instance's configuration snapshot
 * (Phase 2.4, `PROVIDER_ADAPTER.md` §3a.1) — the candidate view the future
 * Provider Router consumes, in-process; it has no HTTP route and no
 * controller injects it. **Authorize first**: the snapshot is read (and, if
 * due, refreshed) only after `providers.read` at platform scope has been
 * granted in this transaction, never before and never for anyone else.
 */
@Injectable()
export class ProviderCatalogueService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly access: ProviderAccess,
    private readonly configuration: ProviderConfigurationCache,
  ) {}

  async routingCandidates(
    principal: AuthPrincipal,
    channelId: string,
  ): Promise<RoutingCandidatesView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
      const snapshot = await this.configuration.read(tx);
      const channel = snapshot.channels.find((c) => c.id === channelId);
      if (!channel) throw notFound('Channel', channelId);
      return {
        channelId: channel.id,
        channelCode: channel.code,
        advisory: true as const,
        configurationRevision: snapshot.revision,
        circuitPolicyVersion: snapshot.circuitPolicy.version,
        providers: snapshot.providers
          .filter((p) => p.channelId === channel.id && p.status === 'active')
          .map((p) => ({ providerId: p.id, name: p.name, adapterKey: p.adapterKey })),
      };
    });
  }
}
