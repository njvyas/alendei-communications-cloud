'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  messagesApi,
  workspacesApi,
  maskRecipientAddress,
  type ChannelCode,
  type ChannelView,
  type MessageStatus,
  type MessageSummaryResponse,
} from '@/lib/api-client';
import { useCanReadMessages } from '@/lib/session-store';
import { MessageStatusBadge } from '@/components/whatsapp/message-status-badge';
import { MessageDetailDialog } from './message-detail-dialog';

export interface MessageListCardProps {
  readonly orgId: string;
  readonly channels?: readonly ChannelView[];
}

export function MessageListCard({ orgId, channels = [] }: MessageListCardProps) {
  const canReadMessages = useCanReadMessages();

  // Filters
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedChannelCode, setSelectedChannelCode] = useState<string>('all');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('all');

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Detail inspection modal
  const [inspectMessageId, setInspectMessageId] = useState<string | null>(null);

  // Fetch workspaces for filter dropdown
  const { data: workspacesData } = useQuery({
    queryKey: ['workspaces', 'list', orgId],
    queryFn: ({ signal }) => workspacesApi.list({ limit: 50 }, signal),
    enabled: Boolean(orgId && canReadMessages),
  });

  const workspaces = workspacesData?.data ?? [];

  const queryParams = {
    status: selectedStatus === 'all' ? undefined : (selectedStatus as MessageStatus),
    channelCode: selectedChannelCode === 'all' ? undefined : (selectedChannelCode as ChannelCode),
    workspaceId: selectedWorkspaceId === 'all' ? undefined : selectedWorkspaceId,
    cursor: currentCursor,
    limit: 25,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['messages', 'list', orgId, queryParams],
    queryFn: ({ signal }) => messagesApi.list(queryParams, signal),
    enabled: Boolean(canReadMessages && orgId),
  });

  const handleStatusFilterChange = (val: string) => {
    setSelectedStatus(val);
    setCursorStack([]);
  };

  const handleChannelFilterChange = (val: string) => {
    setSelectedChannelCode(val);
    setCursorStack([]);
  };

  const handleWorkspaceFilterChange = (val: string) => {
    setSelectedWorkspaceId(val);
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

  const clearFilters = () => {
    setSelectedStatus('all');
    setSelectedChannelCode('all');
    setSelectedWorkspaceId('all');
    setCursorStack([]);
  };

  const messages: readonly MessageSummaryResponse[] = data?.data ?? [];
  const pageInfo = data?.page;

  return (
    <div className="space-y-4">
      {/* Filters bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          {/* Status filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="filter-status" className="text-xs text-[var(--color-ink-muted)]">
              Status:
            </label>
            <select
              id="filter-status"
              value={selectedStatus}
              onChange={(e) => handleStatusFilterChange(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs text-[var(--color-ink)]"
            >
              <option value="all">All Statuses</option>
              <option value="queued">Queued</option>
              <option value="routing">Routing</option>
              <option value="submitting">Submitting</option>
              <option value="accepted">Accepted (Provider)</option>
              <option value="failed">Failed</option>
              <option value="outcome_unknown">Outcome Unknown</option>
            </select>
          </div>

          {/* Channel filter */}
          <div className="flex items-center gap-2">
            <label htmlFor="filter-channel" className="text-xs text-[var(--color-ink-muted)]">
              Channel:
            </label>
            <select
              id="filter-channel"
              value={selectedChannelCode}
              onChange={(e) => handleChannelFilterChange(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs text-[var(--color-ink)]"
            >
              <option value="all">All Channels</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="sms">SMS</option>
              <option value="rcs">RCS</option>
              <option value="email">Email</option>
              <option value="voice">Voice</option>
            </select>
          </div>

          {/* Workspace filter (if workspaces available) */}
          {workspaces.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="filter-workspace" className="text-xs text-[var(--color-ink-muted)]">
                Workspace:
              </label>
              <select
                id="filter-workspace"
                value={selectedWorkspaceId}
                onChange={(e) => handleWorkspaceFilterChange(e.target.value)}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs text-[var(--color-ink)]"
              >
                <option value="all">All Workspaces</option>
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(selectedStatus !== 'all' ||
            selectedChannelCode !== 'all' ||
            selectedWorkspaceId !== 'all') && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline"
            >
              Clear filters
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] transition-colors disabled:opacity-50"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-400"
          role="alert"
        >
          <div className="flex items-center justify-between">
            <p>
              {error instanceof ApiError
                ? `Failed to load messages (${error.code}): ${error.message}`
                : 'An unexpected error occurred while loading messages.'}
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="ml-4 font-medium underline"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Messages Table */}
      <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="messages-table">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <th className="px-4 py-3 font-medium">Dispatched</th>
                <th className="px-4 py-3 font-medium">Channel</th>
                <th className="px-4 py-3 font-medium">Recipient Address</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Attempts</th>
                <th className="px-4 py-3 font-medium">Failure Reason</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-subtle)]">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-[var(--color-ink-muted)]">
                    <div className="flex items-center justify-center gap-2">
                      <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
                      <span>Loading messages…</span>
                    </div>
                  </td>
                </tr>
              ) : messages.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-[var(--color-ink-muted)]">
                    <p className="font-medium text-[var(--color-ink)]">No messages found</p>
                    <p className="mt-1 text-xs">
                      {selectedStatus !== 'all' ||
                      selectedChannelCode !== 'all' ||
                      selectedWorkspaceId !== 'all'
                        ? 'Try clearing active filters to view all dispatches.'
                        : 'Outbound messages dispatched by this organization will appear here.'}
                    </p>
                  </td>
                </tr>
              ) : (
                messages.map((msg) => {
                  const channelObj = channels.find((c) => c.id === msg.channelId);
                  const channelLabel = channelObj
                    ? channelObj.displayName
                    : msg.channelCode.toUpperCase();

                  return (
                    <tr
                      key={msg.id}
                      data-testid={`message-row-${msg.id}`}
                      className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                    >
                      <td className="px-4 py-3 text-[var(--color-ink)] whitespace-nowrap">
                        <div>{new Date(msg.createdAt).toLocaleDateString()}</div>
                        <div className="text-[10px] text-[var(--color-ink-muted)]">
                          {new Date(msg.createdAt).toLocaleTimeString()}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded bg-[var(--color-surface-raised)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-ink)] border border-[var(--color-border-subtle)]">
                          {channelLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="font-mono text-[11px] text-[var(--color-ink)]"
                          data-testid={`masked-recipient-${msg.id}`}
                        >
                          {maskRecipientAddress(msg.recipientAddress)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <MessageStatusBadge status={msg.status} />
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
                        {msg.attemptCount} {msg.attemptCount === 1 ? 'attempt' : 'attempts'}
                      </td>
                      <td className="px-4 py-3">
                        {msg.failureReason ? (
                          <span
                            className="font-mono text-[11px] text-rose-400"
                            title={msg.failureReason}
                          >
                            {msg.failureReason}
                          </span>
                        ) : (
                          <span className="text-[var(--color-ink-muted)] opacity-40">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setInspectMessageId(msg.id)}
                          data-testid={`inspect-message-btn-${msg.id}`}
                          className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors"
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Keyset Pagination Footer */}
        {pageInfo && (
          <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-3 text-xs text-[var(--color-ink-muted)]">
            <span>
              Limit: {pageInfo.limit}
              {cursorStack.length > 0 && ` • Page offset ${cursorStack.length + 1}`}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handlePrevPage}
                disabled={cursorStack.length === 0}
                className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 hover:bg-[var(--color-surface-raised)] disabled:opacity-40 transition-colors"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={handleNextPage}
                disabled={!pageInfo.hasMore}
                className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 hover:bg-[var(--color-surface-raised)] disabled:opacity-40 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail Dialog */}
      <MessageDetailDialog
        messageId={inspectMessageId}
        onClose={() => setInspectMessageId(null)}
        channels={channels}
      />
    </div>
  );
}
