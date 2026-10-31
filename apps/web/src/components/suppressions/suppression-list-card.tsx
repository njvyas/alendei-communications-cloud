'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  suppressionsApi,
  type ChannelView,
  type SuppressionResponse,
  type SuppressionStatus,
} from '@/lib/api-client';
import { useCanManageSuppressions, useCanReadSuppressions } from '@/lib/session-store';
import { ActionFeedback, type ActionFeedbackMessage } from '@/components/ui/action-feedback';
import { toast } from '@/lib/toast';
import { humanizeApiError } from '@/lib/error-mapping';
import { SuppressionStatusBadge } from './suppression-status-badge';
import { SuppressionDetailDialog } from './suppression-detail-dialog';
import { LiftSuppressionDialog } from './lift-suppression-dialog';
import { CreateSuppressionDialog } from './create-suppression-dialog';

export interface SuppressionListCardProps {
  readonly orgId: string;
  readonly channels?: readonly ChannelView[];
}

export function SuppressionListCard({ orgId, channels = [] }: SuppressionListCardProps) {
  const canReadSuppressions = useCanReadSuppressions();
  const canManageSuppressions = useCanManageSuppressions();

  // Filters
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedChannelId, setSelectedChannelId] = useState<string>('all');
  const [addressFilter, setAddressFilter] = useState<string>('');

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Dialog states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<SuppressionResponse | null>(null);
  const [liftTarget, setLiftTarget] = useState<SuppressionResponse | null>(null);

  // Global action feedback
  const [feedback, setFeedback] = useState<ActionFeedbackMessage | null>(null);

  // Clear tenant-specific transient state and banners when organization context changes (D3)
  useEffect(() => {
    setFeedback(null);
    setDetailTarget(null);
    setLiftTarget(null);
    setIsCreateOpen(false);
    setCursorStack([]);
    setSelectedChannelId('all');
    setSelectedStatus('all');
    setAddressFilter('');
  }, [orgId]);

  const queryParams = {
    status: selectedStatus === 'all' ? undefined : (selectedStatus as SuppressionStatus),
    channelId: selectedChannelId === 'all' ? undefined : selectedChannelId,
    cursor: currentCursor,
    limit: 25,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['suppressions', 'list', orgId, queryParams],
    queryFn: ({ signal }) => suppressionsApi.list(queryParams, signal),
    enabled: canReadSuppressions && Boolean(orgId),
  });

  const handleStatusFilterChange = (val: string) => {
    setSelectedStatus(val);
    setCursorStack([]);
  };

  const handleChannelFilterChange = (val: string) => {
    setSelectedChannelId(val);
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

  const handleCreateSuccess = (newSuppression: SuppressionResponse) => {
    toast.success(
      'Suppression Added',
      `Suppression successfully created for ${newSuppression.rawAddress}.`,
    );
    setFeedback({
      type: 'success',
      title: 'Suppression Added',
      message: `Suppression successfully created for ${newSuppression.rawAddress}.`,
    });
    void refetch();
  };

  const handleLiftSuccess = (lifted: SuppressionResponse) => {
    toast.success(
      'Suppression Lifted',
      `Suppression lifted for ${lifted.rawAddress}. Future dispatches enabled.`,
    );
    setFeedback({
      type: 'success',
      title: 'Suppression Lifted',
      message: `Suppression lifted for ${lifted.rawAddress}. Future dispatches to this address are enabled.`,
    });
    void refetch();
  };

  const handleLiftConflict = (suppression: SuppressionResponse) => {
    setLiftTarget(null);
    toast.info(
      'Suppression Already Cleared',
      `Suppression for ${suppression.rawAddress} was already lifted.`,
    );
    setFeedback({
      type: 'info',
      title: 'Suppression Already Cleared',
      message: `This suppression for ${suppression.rawAddress} was already lifted by another session and is no longer active.`,
    });
    void refetch();
  };

  const clearFilters = () => {
    setSelectedStatus('all');
    setSelectedChannelId('all');
    setAddressFilter('');
    setCursorStack([]);
  };

  const items = data?.data ?? [];
  const filteredItems = useMemo(() => {
    const query = addressFilter.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        item.rawAddress.toLowerCase().includes(query) ||
        (item.normalizedAddress && item.normalizedAddress.toLowerCase().includes(query)),
    );
  }, [items, addressFilter]);
  const hasMore = Boolean(data?.page.hasMore);
  const pageIndex = cursorStack.length + 1;

  if (!canReadSuppressions) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to view suppressions for this organization.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Action feedback notification */}
      <ActionFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />

      {/* Top Filter & Action Bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label htmlFor="filter-status" className="sr-only">
              Filter by status
            </label>
            <select
              id="filter-status"
              value={selectedStatus}
              onChange={(e) => handleStatusFilterChange(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active Only</option>
              <option value="cleared">Cleared Only</option>
            </select>
          </div>

          <div>
            <label htmlFor="filter-channel" className="sr-only">
              Filter by channel
            </label>
            <select
              id="filter-channel"
              value={selectedChannelId}
              onChange={(e) => handleChannelFilterChange(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              <option value="all">All Channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName || c.code.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          {/* Client-side address filter over loaded page (FE-2) */}
          <div className="relative">
            <label htmlFor="filter-address" className="sr-only">
              Filter loaded addresses
            </label>
            <input
              id="filter-address"
              type="text"
              placeholder="Filter address…"
              value={addressFilter}
              onChange={(e) => setAddressFilter(e.target.value)}
              className="w-36 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              title="Filter addresses on the currently loaded page"
              data-testid="filter-address"
            />
            {addressFilter && (
              <button
                type="button"
                onClick={() => setAddressFilter('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                aria-label="Clear address filter"
              >
                ✕
              </button>
            )}
          </div>

          {(selectedStatus !== 'all' || selectedChannelId !== 'all' || addressFilter) && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline"
            >
              Clear filters
            </button>
          )}

          {addressFilter && (
            <span className="text-[11px] text-[var(--color-ink-muted)] italic">
              ({filteredItems.length} of {items.length} loaded)
            </span>
          )}

          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-label="Refresh suppressions"
            className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            {isFetching ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {canManageSuppressions && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            + Add Suppression
          </button>
        )}
      </div>

      {/* Main Table Card */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
        {error ? (
          <div role="alert" className="p-6">
            <ActionFeedback
              feedback={{
                type: 'error',
                ...humanizeApiError(
                  error,
                  'Failed to Load Suppressions',
                  'Unable to retrieve suppression records. Please try again.',
                ),
              }}
            />
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => void refetch()}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
              >
                Retry
              </button>
            </div>
          </div>
        ) : isLoading ? (
          <div role="status" className="p-12 text-center text-xs text-[var(--color-ink-muted)]">
            <p>Loading suppression records...</p>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-[var(--color-ink)]">No suppressions found</p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              {selectedStatus !== 'all' || selectedChannelId !== 'all'
                ? 'No suppression records match the selected filter criteria.'
                : 'No recipient addresses are currently suppressed for this organization.'}
            </p>
            <div className="mt-4 flex justify-center gap-3">
              {(selectedStatus !== 'all' || selectedChannelId !== 'all') && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                >
                  Clear filters
                </button>
              )}
              {canManageSuppressions && (
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(true)}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  Add First Suppression
                </button>
              )}
            </div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="p-12 text-center" data-testid="suppression-address-filter-empty">
            <p className="text-sm font-medium text-[var(--color-ink)]">
              No matching addresses found
            </p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              No loaded suppressions on this page match the filter &ldquo;{addressFilter}&rdquo;.
            </p>
            <button
              type="button"
              onClick={() => setAddressFilter('')}
              className="mt-4 rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Clear address filter
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Recipient Address
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Channel Scope
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Reason
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {filteredItems.map((row) => {
                  const channel = row.channelId
                    ? (channels.find((c) => c.id === row.channelId)?.displayName ??
                      channels.find((c) => c.id === row.channelId)?.code ??
                      'Channel')
                    : 'All Channels';

                  return (
                    <tr
                      key={row.id}
                      className="transition-colors hover:bg-[var(--color-surface-raised)]"
                    >
                      <td className="px-4 py-3 font-mono font-medium text-[var(--color-ink)]">
                        <div>{row.rawAddress}</div>
                        {row.normalizedAddress !== row.rawAddress && (
                          <div className="text-[11px] text-[var(--color-ink-muted)]">
                            {row.normalizedAddress}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[var(--color-ink)]">{channel}</td>
                      <td
                        className="max-w-xs truncate px-4 py-3 text-[var(--color-ink)]"
                        title={row.reason}
                      >
                        {row.reason}
                      </td>
                      <td className="px-4 py-3">
                        <SuppressionStatusBadge status={row.status} />
                      </td>
                      <td className="px-4 py-3 text-[var(--color-ink-muted)] font-mono text-[11px]">
                        {new Date(row.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setDetailTarget(row)}
                            className="rounded px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
                          >
                            Details
                          </button>
                          {row.status === 'active' && canManageSuppressions && (
                            <button
                              type="button"
                              onClick={() => setLiftTarget(row)}
                              className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-400 hover:bg-amber-500/20"
                            >
                              Lift
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Keyset Pagination Controls */}
        {items.length > 0 && (
          <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-3 text-xs text-[var(--color-ink-muted)]">
            <div>
              <span>Page {pageIndex}</span>
              {isFetching && (
                <span role="status" className="ml-2 italic">
                  (Updating...)
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrevPage}
                disabled={cursorStack.length === 0 || isFetching}
                className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)] disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={handleNextPage}
                disabled={!hasMore || isFetching}
                className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Creation Modal */}
      <CreateSuppressionDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={handleCreateSuccess}
        channels={channels}
      />

      {/* Lift Confirmation Modal */}
      <LiftSuppressionDialog
        isOpen={Boolean(liftTarget)}
        onClose={() => setLiftTarget(null)}
        onSuccess={handleLiftSuccess}
        onConflict={handleLiftConflict}
        suppression={liftTarget}
        channels={channels}
      />

      {/* Detail Record Modal */}
      <SuppressionDetailDialog
        isOpen={Boolean(detailTarget)}
        onClose={() => setDetailTarget(null)}
        suppression={detailTarget}
        channels={channels}
      />
    </div>
  );
}
