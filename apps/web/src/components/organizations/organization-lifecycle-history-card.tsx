'use client';

import { useQuery } from '@tanstack/react-query';
import { organizationsApi, type OrganizationLifecycleEventView } from '@/lib/api-client';

interface OrganizationLifecycleHistoryCardProps {
  readonly organizationId: string;
}

function StatusBadge({ status }: { readonly status: string }) {
  const normalized = status.toLowerCase();
  const colorClasses =
    normalized === 'active'
      ? 'border-[var(--color-ok)]/30 bg-[var(--color-ok)]/10 text-[var(--color-ok)]'
      : normalized === 'suspended'
        ? 'border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 text-[var(--color-warn)]'
        : normalized === 'closed'
          ? 'border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 text-[var(--color-bad)]'
          : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]';

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${colorClasses}`}
    >
      {status}
    </span>
  );
}

function formatActionTitle(action: string): string {
  switch (action) {
    case 'organization.created':
      return 'Organization Created';
    case 'organization.suspended':
      return 'Organization Suspended';
    case 'organization.reactivated':
      return 'Organization Reactivated';
    case 'organization.closed':
      return 'Organization Closed';
    default:
      return action;
  }
}

export function OrganizationLifecycleHistoryCard({
  organizationId,
}: OrganizationLifecycleHistoryCardProps) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['organization-lifecycle-history', organizationId],
    queryFn: ({ signal }) => organizationsApi.lifecycleHistory(organizationId, signal),
    staleTime: 30_000,
  });

  const events: readonly OrganizationLifecycleEventView[] = data?.data ?? [];

  return (
    <section
      aria-labelledby="lifecycle-history-heading"
      className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-4">
        <div>
          <h2
            id="lifecycle-history-heading"
            className="text-base font-semibold tracking-tight text-[var(--color-ink)]"
          >
            Lifecycle & Suspension History
          </h2>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Audit trail of platform lifecycle transitions, operator attribution, and reasons.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isLoading}
          className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
        >
          {isLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="mt-4">
        {isLoading && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center justify-center py-8 text-xs text-[var(--color-ink-muted)]"
          >
            <span className="mr-2 size-3 animate-spin rounded-full border border-[var(--color-ink-muted)] border-t-transparent" />
            Loading lifecycle history…
          </div>
        )}

        {isError && (
          <div
            role="alert"
            className="rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-4 text-xs text-[var(--color-bad)]"
          >
            <p className="font-semibold">Failed to load lifecycle history</p>
            <p className="mt-1">{error instanceof Error ? error.message : 'Unknown error'}</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="mt-2 font-medium underline hover:opacity-80"
            >
              Try again
            </button>
          </div>
        )}

        {!isLoading && !isError && events.length === 0 && (
          <p className="py-6 text-center text-xs text-[var(--color-ink-muted)]">
            No lifecycle events recorded for this organization.
          </p>
        )}

        {!isLoading && !isError && events.length > 0 && (
          <ol
            aria-label="Lifecycle events list"
            className="relative space-y-4 border-l border-[var(--color-border-subtle)] pl-4 ml-2"
          >
            {events.map((event) => {
              const formattedDate = new Date(event.occurredAt).toLocaleString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });

              return (
                <li key={event.id} className="relative">
                  <span
                    aria-hidden="true"
                    className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]"
                  />

                  <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-[var(--color-ink)]">
                          {formatActionTitle(event.action)}
                        </span>
                        {event.previousStatus ? (
                          <span className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
                            <StatusBadge status={event.previousStatus} />
                            <span aria-hidden="true">→</span>
                            <StatusBadge status={event.newStatus} />
                          </span>
                        ) : (
                          <StatusBadge status={event.newStatus} />
                        )}
                      </div>

                      <time
                        dateTime={event.occurredAt}
                        className="text-[11px] text-[var(--color-ink-muted)]"
                      >
                        {formattedDate}
                      </time>
                    </div>

                    <div className="mt-2 flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
                      <span>Operator:</span>
                      <span className="font-mono text-[11px] text-[var(--color-ink)]">
                        {event.actor.email ?? event.actor.id ?? 'System'}
                      </span>
                    </div>

                    {event.reason && (
                      <div className="mt-2.5 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2.5 text-xs text-[var(--color-ink)]">
                        <p className="font-medium text-[11px] text-[var(--color-ink-muted)]">
                          Operator Reason:
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap">{event.reason}</p>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
