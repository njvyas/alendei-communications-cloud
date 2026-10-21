'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  messagesApi,
  maskRecipientAddress,
  type ChannelView,
  type MessageAttemptStatus,
} from '@/lib/api-client';
import { AccessibleDialog } from '@/components/ui/dialog';
import { MessageStatusBadge } from '@/components/whatsapp/message-status-badge';
import { cn } from '@/lib/cn';

export interface MessageDetailDialogProps {
  readonly messageId: string | null;
  readonly onClose: () => void;
  readonly channels?: readonly ChannelView[];
}

function AttemptStatusBadge({ status }: { readonly status: MessageAttemptStatus | string }) {
  const styles: Record<string, { bg: string; dot: string; label: string }> = {
    submitting: {
      bg: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
      dot: 'bg-amber-400 animate-pulse',
      label: 'SUBMITTING',
    },
    accepted: {
      bg: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
      dot: 'bg-emerald-400',
      label: 'ACCEPTED',
    },
    failed: {
      bg: 'bg-rose-500/10 text-rose-400 border border-rose-500/20',
      dot: 'bg-rose-400',
      label: 'FAILED',
    },
    outcome_unknown: {
      bg: 'bg-purple-500/10 text-purple-400 border border-purple-500/20',
      dot: 'bg-purple-400',
      label: 'OUTCOME_UNKNOWN',
    },
  };

  const style = styles[status] ?? {
    bg: 'bg-slate-500/10 text-slate-400 border border-slate-500/20',
    dot: 'bg-slate-400',
    label: (status || 'UNKNOWN').toUpperCase(),
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide',
        style.bg,
      )}
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden="true" />
      <span>{style.label}</span>
    </span>
  );
}

export function MessageDetailDialog({
  messageId,
  onClose,
  channels = [],
}: MessageDetailDialogProps) {
  const [isCopied, setIsCopied] = useState(false);
  const [isAddressRevealed, setIsAddressRevealed] = useState(false);
  const [showPayload, setShowPayload] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['messages', 'detail', messageId],
    queryFn: ({ signal }) => messagesApi.get(messageId!, signal),
    enabled: Boolean(messageId),
  });

  const message = data?.data;

  const handleCopyId = async () => {
    if (!messageId) return;
    try {
      await navigator.clipboard.writeText(messageId);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Ignore clipboard write failure
    }
  };

  // Find channel display name if known
  const channelObj = message ? channels.find((c) => c.id === message.channelId) : undefined;
  const channelLabel = channelObj ? channelObj.displayName : message?.channelId;

  return (
    <AccessibleDialog
      isOpen={Boolean(messageId)}
      onClose={onClose}
      titleId="message-detail-title"
      descriptionId="message-detail-desc"
      maxWidth="max-w-2xl"
    >
      <div className="space-y-5">
        {/* Header */}
        <div className="border-b border-[var(--color-border-subtle)] pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="message-detail-title"
                className="text-base font-semibold text-[var(--color-ink)]"
              >
                Message Details
              </h2>
              <p id="message-detail-desc" className="text-xs text-[var(--color-ink-muted)]">
                Inspect dispatch lifecycle, provider attempts, and outcome settlement.
              </p>
            </div>
            {message && <MessageStatusBadge status={message.status} />}
          </div>

          {messageId && (
            <div className="mt-2.5 flex items-center gap-2 font-mono text-xs text-[var(--color-ink-muted)]">
              <span className="truncate max-w-[280px] sm:max-w-none">ID: {messageId}</span>
              <button
                type="button"
                onClick={handleCopyId}
                className="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors"
                aria-label="Copy Message ID"
              >
                {isCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
        </div>

        {/* Loading state */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-12 text-xs text-[var(--color-ink-muted)]">
            <div className="size-6 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            <p className="mt-3">Loading message details…</p>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div
            className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-400"
            role="alert"
          >
            {error instanceof ApiError
              ? `Failed to load message (${error.code}): ${error.message}`
              : 'Failed to retrieve message details. Please try again.'}
          </div>
        )}

        {/* Loaded Content */}
        {message && !isLoading && (
          <div className="space-y-4 text-xs">
            {/* Failure Alert Banner (if failed) */}
            {message.failureReason && (
              <div
                className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-rose-400"
                role="alert"
              >
                <p className="font-semibold">Dispatch Failure: {message.failureReason}</p>
                <p className="mt-0.5 text-[11px] opacity-90">
                  The orchestrator was unable to settle this message with the assigned provider(s).
                </p>
              </div>
            )}

            {/* Core Metadata Grid */}
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 sm:grid-cols-2">
              <div>
                <span className="block text-[11px] font-medium text-[var(--color-ink-muted)]">
                  Recipient Address
                </span>
                <div className="mt-1 flex items-center gap-2">
                  <span className="font-mono text-xs text-[var(--color-ink)]">
                    {isAddressRevealed
                      ? message.recipientAddress
                      : maskRecipientAddress(message.recipientAddress)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsAddressRevealed((prev) => !prev)}
                    className="text-[10px] text-[var(--color-accent)] hover:underline"
                    aria-label="Toggle recipient address visibility"
                  >
                    {isAddressRevealed ? 'Hide' : 'Reveal'}
                  </button>
                </div>
              </div>

              <div>
                <span className="block text-[11px] font-medium text-[var(--color-ink-muted)]">
                  Channel
                </span>
                <span className="mt-1 inline-block font-mono text-xs text-[var(--color-ink)]">
                  {channelLabel}
                </span>
              </div>

              <div>
                <span className="block text-[11px] font-medium text-[var(--color-ink-muted)]">
                  Created At
                </span>
                <span className="mt-1 block text-xs text-[var(--color-ink)]">
                  {new Date(message.createdAt).toLocaleString()}
                </span>
              </div>

              <div>
                <span className="block text-[11px] font-medium text-[var(--color-ink-muted)]">
                  Completed At
                </span>
                <span className="mt-1 block text-xs text-[var(--color-ink)]">
                  {message.completedAt
                    ? new Date(message.completedAt).toLocaleString()
                    : 'In progress / In flight'}
                </span>
              </div>

              {message.workspaceId && (
                <div>
                  <span className="block text-[11px] font-medium text-[var(--color-ink-muted)]">
                    Workspace ID
                  </span>
                  <span className="mt-1 block font-mono text-[11px] text-[var(--color-ink-muted)]">
                    {message.workspaceId}
                  </span>
                </div>
              )}

              {message.templateId && (
                <div>
                  <span className="block text-[11px] font-medium text-[var(--color-ink-muted)]">
                    Template ID
                  </span>
                  <span className="mt-1 block font-mono text-[11px] text-[var(--color-ink-muted)]">
                    {message.templateId}
                  </span>
                </div>
              )}
            </div>

            {/* Provider Attempt History */}
            <div>
              <div className="flex items-center justify-between pb-2">
                <h3 className="font-semibold text-[var(--color-ink)]">Dispatch Attempts</h3>
                <span className="text-[11px] text-[var(--color-ink-muted)]">
                  {message.attempts.length} {message.attempts.length === 1 ? 'attempt' : 'attempts'}
                </span>
              </div>

              {message.attempts.length === 0 ? (
                <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 text-center text-xs text-[var(--color-ink-muted)]">
                  No dispatch attempts recorded yet. Message is currently queued.
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs" data-testid="attempts-table">
                      <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                        <tr>
                          <th className="px-3 py-2 font-medium">#</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Provider Ref</th>
                          <th className="px-3 py-2 font-medium">Latency</th>
                          <th className="px-3 py-2 font-medium">Failure Reason</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border-subtle)]">
                        {message.attempts.map((att) => (
                          <tr
                            key={att.id}
                            data-testid={`attempt-row-${att.attemptNumber}`}
                            className="hover:bg-[var(--color-surface-raised)]/50"
                          >
                            <td className="px-3 py-2 font-medium text-[var(--color-ink)]">
                              {att.attemptNumber}
                            </td>
                            <td className="px-3 py-2">
                              <AttemptStatusBadge status={att.status} />
                            </td>
                            <td className="px-3 py-2 font-mono text-[11px] text-[var(--color-ink-muted)]">
                              {att.providerId ? `${att.providerId.slice(0, 8)}…` : '—'}
                            </td>
                            <td className="px-3 py-2 text-[var(--color-ink-muted)]">
                              {att.latencyMs !== null && att.latencyMs !== undefined
                                ? `${att.latencyMs} ms`
                                : '—'}
                            </td>
                            <td className="px-3 py-2 text-[var(--color-ink-muted)]">
                              {att.failureReason ? (
                                <span className="text-rose-400 font-mono text-[11px]">
                                  {att.failureReason}
                                </span>
                              ) : (
                                <span className="opacity-50">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Payload View (Collapsible) */}
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3">
              <button
                type="button"
                onClick={() => setShowPayload((prev) => !prev)}
                className="flex w-full items-center justify-between text-left font-medium text-[var(--color-ink)]"
              >
                <span>Message Payload</span>
                <span className="text-xs text-[var(--color-ink-muted)]">
                  {showPayload ? 'Collapse ▲' : 'Expand ▼'}
                </span>
              </button>

              {showPayload && (
                <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-2">
                  <pre className="max-h-48 overflow-auto rounded bg-[var(--color-surface-raised)] p-2.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
                    {JSON.stringify(message.payload, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex justify-end border-t border-[var(--color-border-subtle)] pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--color-border-subtle)] px-3.5 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </AccessibleDialog>
  );
}
