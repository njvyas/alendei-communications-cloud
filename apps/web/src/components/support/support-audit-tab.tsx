'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { platformSupportApi, type PlatformSupportAuditItem } from '@/lib/api-client';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { useModalDialog } from '@/components/ui/dialog';

function getOutcomeTone(outcome: string): StatusTone {
  switch (outcome.toLowerCase()) {
    case 'success':
      return 'ok';
    case 'failure':
      return 'bad';
    case 'denied':
      return 'warn';
    default:
      return 'unknown';
  }
}

export function SupportAuditTab({ initialOrgId }: { initialOrgId?: string }) {
  const [orgIdFilter, setOrgIdFilter] = useState<string>(initialOrgId ?? '');
  const [actionFilter, setActionFilter] = useState<string>('');
  const [actorUserIdFilter, setActorUserIdFilter] = useState<string>('');
  const [sinceFilter, setSinceFilter] = useState<string>('');
  const [untilFilter, setUntilFilter] = useState<string>('');
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [selectedAuditItem, setSelectedAuditItem] = useState<PlatformSupportAuditItem | null>(null);
  const modal = useModalDialog(Boolean(selectedAuditItem));

  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: [
      'platform-support',
      'audit',
      orgIdFilter,
      actionFilter,
      actorUserIdFilter,
      sinceFilter,
      untilFilter,
      currentCursor,
    ],
    queryFn: ({ signal }) =>
      platformSupportApi.searchAudit(
        {
          orgId: orgIdFilter ? orgIdFilter.trim() : undefined,
          action: actionFilter ? actionFilter.trim() : undefined,
          actorUserId: actorUserIdFilter ? actorUserIdFilter.trim() : undefined,
          since: sinceFilter ? new Date(sinceFilter).toISOString() : undefined,
          until: untilFilter ? new Date(untilFilter).toISOString() : undefined,
          limit: 25,
          cursor: currentCursor,
        },
        signal,
      ),
  });

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCursorStack([]); // Reset pagination to first page
    void refetch();
  };

  const handleNextPage = () => {
    if (data?.page?.nextCursor) {
      setCursorStack((prev) => [...prev, data.page.nextCursor!]);
    }
  };

  const handlePrevPage = () => {
    setCursorStack((prev) => prev.slice(0, prev.length - 1));
  };

  const items = data?.data ?? [];
  const page = data?.page;

  return (
    <div className="space-y-6" data-testid="support-audit-tab">
      {/* Platform Audit Notification Banner */}
      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3.5 text-xs text-[var(--color-ink-muted)]">
        <svg
          className="size-4 shrink-0 text-[var(--color-ink)]"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
          />
        </svg>
        <span>
          <strong className="font-semibold text-[var(--color-ink)]">
            Audit Trail Surveillance:
          </strong>{' '}
          Support audit search operates across tenant boundaries under strict platform authorization
          (`platform.support.read`). All search activities are recorded synchronously in the
          platform audit log.
        </span>
      </div>

      {/* Filter Toolbar */}
      <form
        onSubmit={handleSearchSubmit}
        className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label
              htmlFor="auditOrgIdFilter"
              className="block text-2xs font-medium text-[var(--color-ink-muted)]"
            >
              Target Org ID (Optional)
            </label>
            <input
              id="auditOrgIdFilter"
              type="text"
              placeholder="e.g. 01a1... (Blank for all)"
              value={orgIdFilter}
              onChange={(e) => setOrgIdFilter(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-mono"
            />
          </div>

          <div>
            <label
              htmlFor="auditActionFilter"
              className="block text-2xs font-medium text-[var(--color-ink-muted)]"
            >
              Action Keyword
            </label>
            <input
              id="auditActionFilter"
              type="text"
              placeholder="e.g. organizations.create"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs"
            />
          </div>

          <div>
            <label
              htmlFor="auditActorFilter"
              className="block text-2xs font-medium text-[var(--color-ink-muted)]"
            >
              Actor User ID
            </label>
            <input
              id="auditActorFilter"
              type="text"
              placeholder="UUID"
              value={actorUserIdFilter}
              onChange={(e) => setActorUserIdFilter(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-mono"
            />
          </div>

          <div className="flex items-end gap-2">
            <button
              type="submit"
              disabled={isFetching}
              className="flex-1 rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-semibold text-[var(--color-surface)] hover:opacity-90 transition-opacity"
            >
              {isFetching ? 'Searching…' : 'Filter Audit'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOrgIdFilter('');
                setActionFilter('');
                setActorUserIdFilter('');
                setSinceFilter('');
                setUntilFilter('');
                setCursorStack([]);
              }}
              className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface)]"
            >
              Reset
            </button>
          </div>
        </div>
      </form>

      {/* Results Table */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h3 className="text-sm font-semibold tracking-tight">Cross-Tenant Audit Events</h3>
          {page && (
            <span className="text-2xs text-[var(--color-ink-muted)]">
              Page {cursorStack.length + 1}
            </span>
          )}
        </div>

        {isLoading ? (
          <div role="status" className="py-12 text-center text-xs text-[var(--color-ink-muted)]">
            Loading cross-tenant audit trail…
          </div>
        ) : error ? (
          <div role="alert" className="py-6 text-center text-xs text-[var(--color-bad)]">
            Failed to search audit logs: {(error as Error).message}
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-xs text-[var(--color-ink-muted)]">
            No audit records found matching the query.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="pb-2 font-medium">
                    Timestamp
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Action
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Outcome
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Actor
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Tenant / Org
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Resource
                  </th>
                  <th scope="col" className="pb-2 font-medium text-right">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-[var(--color-surface)]/50">
                    <td className="py-2.5 text-[var(--color-ink-muted)] whitespace-nowrap">
                      {new Date(item.occurredAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td className="py-2.5 font-mono text-xs font-medium">{item.action}</td>
                    <td className="py-2.5">
                      <StatusDot tone={getOutcomeTone(item.outcome)} label={item.outcome} />
                    </td>
                    <td className="py-2.5">
                      <span className="font-mono text-2xs text-[var(--color-ink-muted)]">
                        {item.actorUserId ?? item.actorType}
                      </span>
                    </td>
                    <td className="py-2.5">
                      {item.orgName ? (
                        <span className="font-medium">{item.orgName}</span>
                      ) : item.orgId ? (
                        <span className="font-mono text-2xs text-[var(--color-ink-muted)]">
                          {item.orgId}
                        </span>
                      ) : (
                        <span className="text-[var(--color-ink-muted)] italic">Platform</span>
                      )}
                    </td>
                    <td className="py-2.5 text-2xs font-mono text-[var(--color-ink-muted)]">
                      {item.resourceType}
                      {item.resourceId && `: ${item.resourceId.slice(0, 8)}…`}
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedAuditItem(item)}
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

        {/* Keyset Cursor Pagination */}
        {page && (
          <div className="mt-4 flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-3 text-xs">
            <button
              type="button"
              onClick={handlePrevPage}
              disabled={cursorStack.length === 0 || isFetching}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 font-medium disabled:opacity-40 hover:bg-[var(--color-surface)]"
            >
              Previous
            </button>
            <span className="text-[var(--color-ink-muted)] text-2xs">
              Showing up to {items.length} records
            </span>
            <button
              type="button"
              onClick={handleNextPage}
              disabled={!page.hasMore || isFetching}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 font-medium disabled:opacity-40 hover:bg-[var(--color-surface)]"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {/* Inspect Item Modal */}
      {selectedAuditItem && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="audit-inspect-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 focus:outline-none"
          {...modal.overlayProps(() => setSelectedAuditItem(null), true)}
          data-testid="audit-inspect-modal"
        >
          <div
            ref={modal.panelRef}
            tabIndex={-1}
            className="w-full max-w-2xl rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
              <div>
                <h4 id="audit-inspect-title" className="text-sm font-semibold">
                  {selectedAuditItem.action}
                </h4>
                <p className="mt-0.5 font-mono text-2xs text-[var(--color-ink-muted)]">
                  {selectedAuditItem.id}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAuditItem(null)}
                className="rounded-md p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[var(--color-ink-muted)]">Timestamp:</span>
                  <p className="font-medium">{selectedAuditItem.occurredAt}</p>
                </div>
                <div>
                  <span className="text-[var(--color-ink-muted)]">Outcome:</span>
                  <p className="capitalize font-medium">{selectedAuditItem.outcome}</p>
                </div>
                <div>
                  <span className="text-[var(--color-ink-muted)]">Actor:</span>
                  <p className="font-medium">
                    {selectedAuditItem.actorUserId ?? selectedAuditItem.actorType}
                  </p>
                </div>
                <div>
                  <span className="text-[var(--color-ink-muted)]">Organization:</span>
                  <p className="font-medium">
                    {selectedAuditItem.orgName ?? selectedAuditItem.orgId ?? 'Platform'}
                  </p>
                </div>
              </div>

              <div>
                <span className="text-[var(--color-ink-muted)]">Redacted Metadata Payload:</span>
                <pre className="mt-1 max-h-60 overflow-y-auto rounded-md bg-[var(--color-surface-raised)] p-3 font-mono text-2xs text-[var(--color-ink)]">
                  {JSON.stringify(selectedAuditItem.metadata, null, 2)}
                </pre>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedAuditItem(null)}
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
