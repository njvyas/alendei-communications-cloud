'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, channelsApi, providersApi } from '@/lib/api-client';
import { useCanReadProviders } from '@/lib/session-store';
import {
  ChannelStatusBadge,
  ProviderCircuitBadge,
  ProviderHealthBadge,
  ProviderLifecycleBadge,
} from '@/components/providers/provider-status-badge';
import { Card, CardTitle } from '@/components/ui/card';

export default function ChannelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const canReadProviders = useCanReadProviders();

  const {
    data: channelData,
    isLoading: isChannelLoading,
    error: channelError,
    refetch: refetchChannel,
  } = useQuery({
    queryKey: ['channels', 'detail', id],
    queryFn: ({ signal }) => channelsApi.get(id, signal),
    enabled: canReadProviders,
  });

  const {
    data: providersData,
    isLoading: isProvidersLoading,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['providers', 'by-channel', id],
    queryFn: ({ signal }) => providersApi.list({ channelId: id, limit: 50 }, signal),
    enabled: canReadProviders && !!channelData?.data,
    refetchInterval: 15_000,
  });

  if (!canReadProviders) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to view channel details.
        </p>
      </div>
    );
  }

  if (isChannelLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="size-6 animate-spin rounded-full border-2 border-[var(--color-ink-muted)] border-t-transparent" />
      </div>
    );
  }

  if (channelError) {
    return (
      <div className="rounded-xl border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-surface)] p-6 text-center shadow-xs">
        <p className="text-xs font-medium text-[var(--color-bad,#ef4444)]">
          Failed to load channel details.
        </p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          {channelError instanceof ApiError ? channelError.message : 'Unknown communication error'}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link
            href="/channels"
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Back to Channels
          </Link>
          <button
            type="button"
            onClick={() => void refetchChannel()}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const channel = channelData?.data;
  if (!channel) return null;

  const providers = providersData?.data ?? [];

  return (
    <div className="space-y-6">
      {/* Breadcrumb & Navigation */}
      <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <Link href="/channels" className="hover:underline">
          Channels
        </Link>
        <span>/</span>
        <span className="font-mono text-[var(--color-ink)]">{channel.displayName}</span>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
              {channel.displayName}
            </h1>
            <ChannelStatusBadge status={channel.status} />
          </div>
          <p className="text-xs text-[var(--color-ink-muted)] mt-1 font-mono">
            code: {channel.code}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void refetchChannel();
              void refetchProviders();
            }}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Channel Overview Card */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>Channel Information</CardTitle>
          <dl className="mt-4 divide-y divide-[var(--color-border-subtle)] text-xs">
            <div className="flex justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Display Name</dt>
              <dd className="font-medium text-[var(--color-ink)]">{channel.displayName}</dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Code</dt>
              <dd className="font-mono text-[var(--color-ink)]">{channel.code}</dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Status</dt>
              <dd>
                <ChannelStatusBadge status={channel.status} />
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardTitle>Metadata & Identity</CardTitle>
          <dl className="mt-4 divide-y divide-[var(--color-border-subtle)] text-xs">
            <div className="flex justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Channel ID</dt>
              <dd className="font-mono text-[11px] text-[var(--color-ink)]">{channel.id}</dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Created At</dt>
              <dd className="text-[var(--color-ink)]">
                {new Date(channel.createdAt).toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Updated At</dt>
              <dd className="text-[var(--color-ink)]">
                {new Date(channel.updatedAt).toLocaleString()}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      {/* Associated Providers Table */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--color-ink)]">Configured Providers</h2>
          <span className="text-xs text-[var(--color-ink-muted)]">
            {providers.length} provider{providers.length === 1 ? '' : 's'} serving {channel.displayName}
          </span>
        </div>

        {isProvidersLoading ? (
          <div className="flex justify-center py-8">
            <div className="size-5 animate-spin rounded-full border-2 border-[var(--color-ink-muted)] border-t-transparent" />
          </div>
        ) : providers.length === 0 ? (
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 text-center shadow-xs">
            <p className="text-xs font-medium text-[var(--color-ink)]">
              No providers configured for this channel.
            </p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Go to Providers to create a provider bound to this channel.
            </p>
            <div className="mt-4">
              <Link
                href="/providers"
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
              >
                Go to Providers
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Provider Name
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Adapter
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Lifecycle Status
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Health
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Circuit
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]">
                  {providers.map((p) => (
                    <tr
                      key={p.id}
                      className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-[var(--color-ink)]">
                        <Link href={`/providers/${p.id}`} className="hover:underline">
                          {p.name}
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
                        {p.adapterKey}
                      </td>
                      <td className="px-4 py-3">
                        <ProviderLifecycleBadge status={p.status} />
                      </td>
                      <td className="px-4 py-3">
                        <ProviderHealthBadge
                          healthState={p.healthState}
                          healthOverride={p.healthOverride}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <ProviderCircuitBadge
                          circuitState={p.circuitState}
                          cooldownUntil={p.circuitCooldownUntil}
                        />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/providers/${p.id}`}
                          className="rounded border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                        >
                          View Provider
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
