'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  platformSupportApi,
  type PlatformSupportDispatchDiagnostics,
  type PlatformSupportDispatchMessage,
} from '@/lib/api-client';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { useModalDialog } from '@/components/ui/dialog';

/**
 * Dispatch troubleshooting (U13.4). The API returns operational metadata only —
 * identifiers, statuses, timings and fixed failure codes. No recipient, message
 * content or provider error text exists in the response, so none is rendered.
 */

const STATUS_FILTERS = [
  { value: 'all', label: 'Failed and in flight' },
  { value: 'failed', label: 'Failed' },
  { value: 'outcome_unknown', label: 'Outcome unknown' },
  { value: 'queued', label: 'Queued' },
  { value: 'routing', label: 'Routing' },
  { value: 'submitting', label: 'Submitting' },
] as const;

function statusTone(status: string): StatusTone {
  switch (status) {
    case 'failed':
      return 'bad';
    case 'outcome_unknown':
      return 'warn';
    default:
      return 'unknown';
  }
}

function codeTone(code: string | null): StatusTone {
  if (!code) return 'unknown';
  if (code === 'TIMEOUT' || code === 'RATE_LIMITED' || code === 'PROVIDER_ERROR') return 'warn';
  return 'bad';
}

export function SupportDispatchTab({ orgId }: { orgId: string }) {
  const [selected, setSelected] = useState<PlatformSupportDispatchMessage | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const limit = 25;
  const modal = useModalDialog(Boolean(selected));

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-support', 'dispatch', orgId, limit, statusFilter],
    queryFn: ({ signal }) =>
      platformSupportApi.getDispatch(
        orgId,
        { limit, status: statusFilter === 'all' ? undefined : statusFilter },
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

  const { queue, recentMessages } = dispatch;

  return (
    <div className="space-y-6" data-testid="support-dispatch-tab">
      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3.5 text-xs text-[var(--color-ink-muted)]">
        <span>
          <strong className="font-semibold text-[var(--color-ink)]">
            Read-only dispatch metadata:
          </strong>{' '}
          identifiers, statuses, timings and fixed failure codes only. Recipients, message content
          and provider error text are not available to platform support.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <QueueCard label="Ready to dispatch" value={queue.pendingCount} hint="awaiting pickup" />
        <QueueCard label="Delayed" value={queue.delayedCount} hint="waiting for a retry time" />
        <QueueCard label="Claimed" value={queue.claimedCount} hint="under a dispatcher claim" />
      </div>

      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--color-border-subtle)]">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Recent messages</h3>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Failed and in-flight messages with their provider attempts.
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <label htmlFor="dispatchStatusSelect" className="text-[var(--color-ink-muted)]">
              Status:
            </label>
            <select
              id="dispatchStatusSelect"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs"
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
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

        {recentMessages.length === 0 ? (
          <p className="py-6 text-center text-xs text-[var(--color-ink-muted)]">
            No messages match the current filter.
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
                    Channel
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Failure code
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Attempts
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Created
                  </th>
                  <th scope="col" className="pb-2 font-medium text-right">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {recentMessages.map((m) => (
                  <tr key={m.messageId} className="hover:bg-[var(--color-surface)]/50">
                    <td className="py-2.5 font-mono select-all font-medium">{m.messageId}</td>
                    <td className="py-2.5 uppercase">{m.channel}</td>
                    <td className="py-2.5">
                      <StatusDot tone={statusTone(m.status)} label={m.status} />
                    </td>
                    <td className="py-2.5 font-mono">
                      {m.failureCode ? (
                        <StatusDot tone={codeTone(m.failureCode)} label={m.failureCode} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2.5">{m.attemptCount}</td>
                    <td className="py-2.5 text-[var(--color-ink-muted)]">
                      {new Date(m.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => setSelected(m)}
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

      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="dispatch-message-inspector-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 focus:outline-none"
          {...modal.overlayProps(() => setSelected(null), true)}
          data-testid="failure-detail-modal"
        >
          <div
            ref={modal.panelRef}
            tabIndex={-1}
            className="w-full max-w-xl rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
              <div>
                <h4 id="dispatch-message-inspector-title" className="text-sm font-semibold">
                  Dispatch inspector
                </h4>
                <p className="mt-0.5 font-mono text-2xs text-[var(--color-ink-muted)]">
                  {selected.messageId}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close"
                className="rounded-md p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                ✕
              </button>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-[var(--color-ink-muted)]">Status</dt>
                <dd className="font-medium">{selected.status}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-ink-muted)]">Failure code</dt>
                <dd className="font-mono font-medium">{selected.failureCode ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-ink-muted)]">Created</dt>
                <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-ink-muted)]">Completed</dt>
                <dd>
                  {selected.completedAt ? new Date(selected.completedAt).toLocaleString() : '—'}
                </dd>
              </div>
            </dl>

            <div className="mt-4 text-xs">
              <h5 className="font-semibold text-[var(--color-ink)]">Provider attempts</h5>
              {selected.attempts.length === 0 ? (
                <p className="mt-1 text-2xs text-[var(--color-ink-muted)] italic">
                  No provider attempt was recorded.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {selected.attempts.map((attempt) => (
                    <li
                      key={attempt.attemptNumber}
                      className="rounded-md border border-[var(--color-border-subtle)] p-2.5 text-2xs"
                    >
                      <div className="flex items-center justify-between font-medium">
                        <span>
                          Attempt #{attempt.attemptNumber}: {attempt.adapterKey} ({attempt.status})
                        </span>
                        <span>{attempt.latencyMs !== null ? `${attempt.latencyMs} ms` : '—'}</span>
                      </div>
                      <p className="mt-1 font-mono text-[var(--color-ink-muted)]">
                        Provider {attempt.providerId}
                        {attempt.failureCode ? ` · ${attempt.failureCode}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setSelected(null)}
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

function QueueCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
      <p className="text-xs text-[var(--color-ink-muted)]">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight">{value}</span>
        <span className="text-xs text-[var(--color-ink-muted)]">{hint}</span>
      </div>
    </div>
  );
}
