'use client';

import type { MessageDetailWithAttempts } from '../../lib/api-client';
import { MessageStatusBadge } from './message-status-badge';
import { FailureReasonAlert } from '../messages/failure-reason-alert';
import { formatFailureReason, emptyAttemptsGuidance } from '../../lib/failure-reasons';

interface AttemptHistoryCardProps {
  message: MessageDetailWithAttempts;
  isPolling: boolean;
}

export function AttemptHistoryCard({ message, isPolling }: AttemptHistoryCardProps) {
  return (
    <div
      className="space-y-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5 shadow-xs"
      data-testid="attempt-history-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-ink)]">
              Message Settlement Monitor
            </h2>
            {isPolling && (
              <span className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-400">
                <span className="size-1 animate-ping rounded-full bg-sky-400" />
                Live Polling (1s)
              </span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-xs text-[var(--color-ink-muted)]">ID: {message.id}</p>
        </div>

        <div className="flex items-center gap-3">
          <MessageStatusBadge status={message.status} />
        </div>
      </div>

      {/* Meta Grid */}
      <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
        <div>
          <span className="text-[var(--color-ink-muted)]">Recipient:</span>
          <p className="font-mono font-medium text-[var(--color-ink)]">
            {message.recipientAddress}
          </p>
        </div>
        <div>
          <span className="text-[var(--color-ink-muted)]">Channel:</span>
          <p className="font-medium uppercase text-[var(--color-ink)]">WhatsApp</p>
        </div>
        <div>
          <span className="text-[var(--color-ink-muted)]">Created At:</span>
          <p className="text-[var(--color-ink)]">
            {new Date(message.createdAt).toLocaleTimeString()}
          </p>
        </div>
        <div>
          <span className="text-[var(--color-ink-muted)]">Completed At:</span>
          <p className="text-[var(--color-ink)]">
            {message.completedAt ? new Date(message.completedAt).toLocaleTimeString() : '—'}
          </p>
        </div>
      </div>

      {/* Failure reason callout if failed */}
      {message.failureReason && <FailureReasonAlert failureReason={message.failureReason} />}

      {/* Distinction Banner */}
      <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3 text-[11px] text-[var(--color-ink-muted)]">
        <span className="font-semibold text-indigo-400">Submission Boundary Rule:</span>{' '}
        <code className="text-[11px] font-semibold text-emerald-400">PROVIDER_ACCEPTED</code> means
        the provider submission adapter acknowledged receipt of the message payload. It is{' '}
        <strong>not a delivery receipt or delivery confirmation</strong> (inbound delivery webhooks
        and receipts are excluded from Phase 3 scope per ADR-014 D20).
      </div>

      {/* Attempts Table */}
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
          Provider Dispatch & Fallback History ({message.attempts.length}{' '}
          {message.attempts.length === 1 ? 'attempt' : 'attempts'})
        </h3>

        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]">
          <table className="w-full text-left text-xs" data-testid="attempts-table">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)] text-[11px] text-[var(--color-ink-muted)]">
                <th scope="col" className="px-3 py-2 font-medium">
                  Attempt #
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Provider ID
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Outcome
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Latency
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Completed
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Details / Reason
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-subtle)]">
              {message.attempts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-[var(--color-ink-muted)]">
                    {(() => {
                      const guidance = emptyAttemptsGuidance(message.status, message.failureReason);
                      return (
                        <div className="space-y-1">
                          <p>{guidance.message}</p>
                          {guidance.action && (
                            <p className="text-[11px] text-[var(--color-ink)] opacity-80">
                              {guidance.action}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              ) : (
                message.attempts.map((att) => (
                  <tr
                    key={att.id}
                    data-testid={`attempt-row-${att.attemptNumber}`}
                    className="hover:bg-[var(--color-surface)]"
                  >
                    <td className="px-3 py-2 font-mono font-medium text-[var(--color-ink)]">
                      #{att.attemptNumber}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-[var(--color-ink)]">
                      {att.providerId}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          att.status === 'accepted'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : att.status === 'failed'
                              ? 'bg-rose-500/10 text-rose-400'
                              : 'bg-purple-500/10 text-purple-400'
                        }`}
                      >
                        {att.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-[var(--color-ink)]">
                      {att.latencyMs !== null ? `${att.latencyMs} ms` : '—'}
                    </td>
                    <td className="px-3 py-2 text-[var(--color-ink-muted)]">
                      {att.completedAt
                        ? new Date(att.completedAt).toLocaleTimeString()
                        : 'In flight'}
                    </td>
                    <td
                      className="px-3 py-2 text-[var(--color-ink-muted)] text-[10px] max-w-xs truncate"
                      title={att.failureReason ?? undefined}
                    >
                      {att.failureReason ? (
                        <>
                          <span className="font-medium text-[var(--color-ink)]">
                            {formatFailureReason(att.failureReason)?.title || att.failureReason}
                          </span>
                          <span className="ml-1 font-mono text-[var(--color-ink-muted)]">
                            ({att.failureReason})
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
