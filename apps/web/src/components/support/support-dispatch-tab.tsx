'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  platformSupportApi,
  type PlatformSupportDispatchDiagnostics,
  type PlatformSupportDispatchFailure,
} from '@/lib/api-client';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { useModalDialog } from '@/components/ui/dialog';

function getFailureTone(category: string): StatusTone {
  switch (category.toLowerCase()) {
    case 'timeout':
    case 'rate_limit':
      return 'warn';
    case 'auth':
    case 'provider_rejected':
    case 'bad_request':
      return 'bad';
    default:
      return 'unknown';
  }
}

export function SupportDispatchTab({ orgId }: { orgId: string }) {
  const [selectedFailure, setSelectedFailure] = useState<PlatformSupportDispatchFailure | null>(
    null,
  );
  const [failureCategoryFilter, setFailureCategoryFilter] = useState<string>('all');
  const limit = 25;
  const modal = useModalDialog(Boolean(selectedFailure));

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-support', 'dispatch', orgId, limit, failureCategoryFilter],
    queryFn: ({ signal }) =>
      platformSupportApi.getDispatch(
        orgId,
        {
          limit,
          failureCategory: failureCategoryFilter === 'all' ? undefined : failureCategoryFilter,
        },
        signal,
      ),
    enabled: Boolean(orgId),
  });

  if (isLoading) {
    return (
      <div
        role="status"
        className="py-12 text-center text-sm text-[var(--color-ink-muted)]"
        data-testid="support-dispatch-loading"
      >
        Loading message dispatch diagnostics…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-4 text-sm text-[var(--color-ink)]"
        data-testid="support-dispatch-error"
      >
        <p className="font-semibold text-[var(--color-bad)]">Failed to load dispatch diagnostics</p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">{(error as Error).message}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-3 rounded-md bg-[var(--color-surface-raised)] px-3 py-1 text-xs font-medium border border-[var(--color-border-subtle)]"
        >
          Retry
        </button>
      </div>
    );
  }

  const dispatch: PlatformSupportDispatchDiagnostics | undefined = data?.data;
  if (!dispatch) return null;

  const { queue, recentFailures } = dispatch;

  return (
    <div className="space-y-6" data-testid="support-dispatch-tab">
      {/* Safeguard & Read-Only Banner */}
      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3.5 text-xs text-[var(--color-ink-muted)]">
        <svg
          className="size-4 shrink-0 text-[var(--color-ok)]"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>
          <strong className="font-semibold text-[var(--color-ink)]">
            Read-Only Diagnostic Access:
          </strong>{' '}
          Platform support provides diagnostic inspection only. Recipient PII is masked, and no
          write-capable impersonation or message mutation is permitted.
        </span>
      </div>

      {/* Queue State */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <p className="text-xs text-[var(--color-ink-muted)]">Live Pending Queue Count</p>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-tight">{queue.pendingCount}</span>
            <span className="text-xs text-[var(--color-ink-muted)]">messages awaiting pickup</span>
          </div>
        </div>
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <p className="text-xs text-[var(--color-ink-muted)]">Claimed / Submitting Count</p>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-tight">{queue.claimedCount}</span>
            <span className="text-xs text-[var(--color-ink-muted)]">
              actively in-flight to providers
            </span>
          </div>
        </div>
      </div>

      {/* Recent Failures & Troubleshooting */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--color-border-subtle)]">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Recent Dispatch Failures</h3>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Diagnostic inspection of message failures and upstream provider attempts.
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <label htmlFor="failureCategorySelect" className="text-[var(--color-ink-muted)]">
              Category:
            </label>
            <select
              id="failureCategorySelect"
              value={failureCategoryFilter}
              onChange={(e) => setFailureCategoryFilter(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs"
            >
              <option value="all">All Categories</option>
              <option value="timeout">Timeout</option>
              <option value="provider_rejected">Provider Rejected</option>
              <option value="rate_limit">Rate Limit</option>
              <option value="auth">Auth / Bad Credentials</option>
              <option value="circuit_open">Circuit Open</option>
            </select>

            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs hover:bg-[var(--color-surface-raised)]"
            >
              {isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {recentFailures.length === 0 ? (
          <p className="py-6 text-center text-xs text-[var(--color-ink-muted)]">
            No recent dispatch failures found matching current filters.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="pb-2 font-medium">
                    Message ID
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Masked Recipient
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Category
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Error Code / Reason
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Attempts
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Timestamp
                  </th>
                  <th scope="col" className="pb-2 font-medium text-right">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {recentFailures.map((f) => (
                  <tr key={f.messageId} className="hover:bg-[var(--color-surface)]/50">
                    <td className="py-2.5 font-mono select-all font-medium">{f.messageId}</td>
                    <td className="py-2.5 font-mono text-[var(--color-ink)]">
                      {f.maskedRecipient}
                    </td>
                    <td className="py-2.5">
                      <StatusDot
                        tone={getFailureTone(f.failureCategory ?? 'unknown')}
                        label={f.failureCategory ?? 'Unknown'}
                      />
                    </td>
                    <td
                      className="py-2.5 max-w-xs truncate text-[var(--color-ink-muted)]"
                      title={f.failureReason ?? '—'}
                    >
                      {f.failureReason ?? '—'}
                    </td>
                    <td className="py-2.5">{f.providerAttempts.length}</td>
                    <td className="py-2.5 text-[var(--color-ink-muted)]">
                      {new Date(f.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedFailure(f)}
                        className="rounded-md border border-[var(--color-border-subtle)] px-2 py-0.5 text-2xs font-medium hover:bg-[var(--color-surface-raised)]"
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Failure Detail Inspector Modal */}
      {selectedFailure && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="dispatch-failure-inspector-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 focus:outline-none"
          {...modal.overlayProps(() => setSelectedFailure(null), true)}
          data-testid="failure-detail-modal"
        >
          <div
            ref={modal.panelRef}
            tabIndex={-1}
            className="w-full max-w-xl rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
              <div>
                <h4 id="dispatch-failure-inspector-title" className="text-sm font-semibold">
                  Dispatch Failure Inspector
                </h4>
                <p className="mt-0.5 font-mono text-2xs text-[var(--color-ink-muted)]">
                  {selectedFailure.messageId}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedFailure(null)}
                className="rounded-md p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-[var(--color-ink-muted)]">Recipient (Masked):</span>
                  <p className="font-mono font-medium">{selectedFailure.maskedRecipient}</p>
                </div>
                <div>
                  <span className="text-[var(--color-ink-muted)]">Failure Category:</span>
                  <p className="capitalize font-medium">
                    {selectedFailure.failureCategory ?? 'Unknown'}
                  </p>
                </div>
              </div>

              {selectedFailure.failureReason && (
                <div className="rounded-md bg-[var(--color-surface-raised)] p-2.5 font-mono text-2xs text-[var(--color-bad)]">
                  {selectedFailure.failureReason}
                </div>
              )}

              <div>
                <h5 className="font-semibold text-xs text-[var(--color-ink)]">
                  Provider Submission Attempts
                </h5>
                {selectedFailure.providerAttempts.length === 0 ? (
                  <p className="mt-1 text-2xs text-[var(--color-ink-muted)] italic">
                    No upstream attempts recorded prior to failure.
                  </p>
                ) : (
                  <div className="mt-2 space-y-2">
                    {selectedFailure.providerAttempts.map((attempt) => (
                      <div
                        key={attempt.attemptNumber}
                        className="rounded-md border border-[var(--color-border-subtle)] p-2.5 text-2xs"
                      >
                        <div className="flex items-center justify-between font-medium">
                          <span>
                            Attempt #{attempt.attemptNumber}: {attempt.providerId} (
                            {attempt.providerType})
                          </span>
                          <span>
                            HTTP {attempt.httpStatus ?? '—'} (
                            {attempt.latencyMs !== null ? `${attempt.latencyMs}ms` : '—'})
                          </span>
                        </div>
                        {attempt.errorType && (
                          <p className="mt-1 font-mono text-[var(--color-bad)]">
                            Error Type: {attempt.errorType}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedFailure(null)}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs font-medium hover:bg-[var(--color-surface-raised)]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
