'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, channelsApi, providersApi, type ListProvidersParams } from '@/lib/api-client';
import { useCanManageProviders, useCanReadProviders } from '@/lib/session-store';
import {
  ProviderCircuitBadge,
  ProviderHealthBadge,
  ProviderLifecycleBadge,
} from '@/components/providers/provider-status-badge';
import { ProviderCreateDialog } from '@/components/providers/provider-create-dialog';
import { CircuitPolicyDialog } from '@/components/providers/circuit-policy-dialog';
import type { ProviderStatus } from '@acc/contracts';

export default function ProvidersPage() {
  const canReadProviders = useCanReadProviders();
  const canManageProviders = useCanManageProviders();

  // Filters
  const [selectedChannelId, setSelectedChannelId] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Dialog states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCircuitPolicyOpen, setIsCircuitPolicyOpen] = useState(false);

  // Channels for filter dropdown
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'filter-list'],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50 }, signal),
    enabled: canReadProviders,
  });

  const channels = channelsData?.data ?? [];

  const queryParams: ListProvidersParams = {
    channelId: selectedChannelId === 'all' ? undefined : selectedChannelId,
    status: selectedStatus === 'all' ? undefined : (selectedStatus as ProviderStatus),
    cursor: currentCursor,
    limit: 25,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['providers', 'list', queryParams],
    queryFn: ({ signal }) => providersApi.list(queryParams, signal),
    enabled: canReadProviders,
    refetchInterval: 15_000,
  });

  const handleChannelFilterChange = (val: string) => {
    setSelectedChannelId(val);
    setCursorStack([]);
  };

  const handleStatusFilterChange = (val: string) => {
    setSelectedStatus(val);
    setCursorStack([]);
  };

  const handleNextPage = () => {
    if (data?.page.nextCursor) {
      setCursorStack((prev) => [...prev, data.page.nextCursor!]);
    }
  };

  const handlePrevPage = () => {
    setCursorStack((prev) => prev.slice(0, -1));
  };

  if (!canReadProviders) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to view the communication providers catalogue. This section
          requires platform-level read authorization.
        </p>
      </div>
    );
  }

  const providers = data?.data ?? [];
  const pageInfo = data?.page;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
            Communication Providers
          </h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Global provider registry, lifecycle status, circuit breaker states, and health
            monitoring.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManageProviders && (
            <>
              <button
                type="button"
                onClick={() => setIsCircuitPolicyOpen(true)}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors"
                data-testid="circuit-policy-btn"
              >
                Circuit Policy
              </button>
              <button
                type="button"
                onClick={() => setIsCreateOpen(true)}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition-opacity"
                data-testid="create-provider-btn"
              >
                + Create Provider
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors disabled:opacity-50"
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="filter-channel" className="text-xs text-[var(--color-ink-muted)]">
            Channel:
          </label>
          <select
            id="filter-channel"
            value={selectedChannelId}
            onChange={(e) => handleChannelFilterChange(e.target.value)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-hidden"
          >
            <option value="all">All Channels</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="filter-status" className="text-xs text-[var(--color-ink-muted)]">
            Status:
          </label>
          <select
            id="filter-status"
            value={selectedStatus}
            onChange={(e) => handleStatusFilterChange(e.target.value)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-hidden"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="draining">Draining</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      </div>

      {/* Table Content */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="size-6 animate-spin rounded-full border-2 border-[var(--color-ink-muted)] border-t-transparent" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-surface)] p-6 text-center shadow-xs">
          <p className="text-xs font-medium text-[var(--color-bad,#ef4444)]">
            Failed to load providers.
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {error instanceof ApiError ? error.message : 'Unknown communication error'}
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-4 rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Retry
          </button>
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
          <p className="text-sm font-medium text-[var(--color-ink)]">No providers found</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {selectedChannelId !== 'all' || selectedStatus !== 'all'
              ? 'Try adjusting your filters.'
              : 'No providers have been registered yet.'}
          </p>
          {canManageProviders && selectedChannelId === 'all' && selectedStatus === 'all' && (
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="mt-4 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              + Create Provider
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="providers-table">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Provider
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Channel
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
                  <th scope="col" className="px-4 py-3 font-medium">
                    Created
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
                    data-testid={`provider-row-${p.name.toLowerCase().replace(/\s+/g, '-')}`}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/providers/${p.id}`}
                        className="font-medium text-[var(--color-ink)] hover:underline"
                      >
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-ink-muted)] uppercase">
                      {p.channelCode}
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
                    <td className="px-4 py-3 text-[var(--color-ink-muted)] whitespace-nowrap">
                      {new Date(p.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/providers/${p.id}`}
                        className="rounded border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                      >
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {(pageInfo?.hasMore || cursorStack.length > 0) && (
            <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-3 bg-[var(--color-surface)]">
              <span className="text-xs text-[var(--color-ink-muted)]">
                Showing {providers.length} providers
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handlePrevPage}
                  disabled={cursorStack.length === 0}
                  className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={handleNextPage}
                  disabled={!pageInfo?.hasMore}
                  className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dialogs */}
      <ProviderCreateDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        defaultChannelId={selectedChannelId === 'all' ? undefined : selectedChannelId}
      />

      <CircuitPolicyDialog open={isCircuitPolicyOpen} onOpenChange={setIsCircuitPolicyOpen} />
    </div>
  );
}
