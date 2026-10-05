'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, channelsApi, type ListChannelsParams } from '@/lib/api-client';
import { useCanReadProviders } from '@/lib/session-store';
import { ChannelStatusBadge } from '@/components/providers/provider-status-badge';

export default function ChannelsPage() {
  const canReadProviders = useCanReadProviders();

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  const queryParams: ListChannelsParams = {
    cursor: currentCursor,
    limit: 25,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['channels', 'list', queryParams],
    queryFn: ({ signal }) => channelsApi.list(queryParams, signal),
    enabled: canReadProviders,
    refetchInterval: 15_000,
  });

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
          You do not have permission to view the communication channels catalogue. This section
          requires platform-level read authorization.
        </p>
      </div>
    );
  }

  const channels = data?.data ?? [];
  const pageInfo = data?.page;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
            Communication Channels
          </h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Global communication channel catalogue and status. Seeded and managed at platform level.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors disabled:opacity-50"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Main Content */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="size-6 animate-spin rounded-full border-2 border-[var(--color-ink-muted)] border-t-transparent" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-surface)] p-6 text-center shadow-xs">
          <p className="text-xs font-medium text-[var(--color-bad,#ef4444)]">
            Failed to load channels catalogue.
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
      ) : channels.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
          <p className="text-sm font-medium text-[var(--color-ink)]">No channels found</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            The platform channel catalogue has not been seeded yet.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Channel
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Code
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
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
                {channels.map((channel) => (
                  <tr
                    key={channel.id}
                    className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/channels/${channel.id}`}
                        className="font-medium text-[var(--color-ink)] hover:underline"
                      >
                        {channel.displayName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
                      {channel.code}
                    </td>
                    <td className="px-4 py-3">
                      <ChannelStatusBadge status={channel.status} />
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)] whitespace-nowrap">
                      {new Date(channel.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/channels/${channel.id}`}
                        className="rounded border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                      >
                        View details
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
                Showing {channels.length} channels
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
    </div>
  );
}
