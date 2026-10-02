'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  auditLogsApi,
  type AuditActorType,
  type AuditLogView,
  type AuditOutcome,
  type ListAuditLogsParams,
} from '@/lib/api-client';
import { useHasPermission, useSession } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { AuditLogDetailDialog } from '@/components/audit-logs/audit-log-detail-dialog';

const OUTCOME_TONES: Record<string, StatusTone> = {
  success: 'ok',
  failure: 'bad',
  denied: 'warn',
};

const SORT_OPTIONS = [
  { value: '-occurredAt', label: 'Newest first (Default)' },
  { value: 'occurredAt', label: 'Oldest first' },
] as const;

export default function AuditLogsPage() {
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);
  const canReadAudit = useHasPermission('audit.read');

  // Filter State
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | AuditOutcome>('all');
  const [actorTypeFilter, setActorTypeFilter] = useState<'all' | AuditActorType>('all');
  const [actionInput, setActionInput] = useState('');
  const [activeActionQuery, setActiveActionQuery] = useState('');
  const [resourceTypeInput, setResourceTypeInput] = useState('');
  const [activeResourceTypeQuery, setActiveResourceTypeQuery] = useState('');
  const [correlationIdInput, setCorrelationIdInput] = useState('');
  const [activeCorrelationIdQuery, setActiveCorrelationIdQuery] = useState('');
  const [occurredFromDate, setOccurredFromDate] = useState('');
  const [occurredToDate, setOccurredToDate] = useState('');
  const [sort, setSort] = useState<string>('-occurredAt');

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Detail Modal State
  const [selectedLog, setSelectedLog] = useState<AuditLogView | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Invariant: Organization switch resets pagination cursor and closes open detail dialog
  useEffect(() => {
    setCursorStack([]);
    setSelectedLog(null);
  }, [selectedOrgId]);

  // Construct query parameters
  const queryParams: ListAuditLogsParams = {
    cursor: currentCursor,
    limit: 25,
    sort,
    outcome: outcomeFilter === 'all' ? undefined : outcomeFilter,
    actorType: actorTypeFilter === 'all' ? undefined : actorTypeFilter,
    action: activeActionQuery || undefined,
    resourceType: activeResourceTypeQuery || undefined,
    correlationId: activeCorrelationIdQuery || undefined,
    occurredFrom: occurredFromDate
      ? new Date(`${occurredFromDate}T00:00:00.000Z`).toISOString()
      : undefined,
    occurredTo: occurredToDate
      ? new Date(`${occurredToDate}T23:59:59.999Z`).toISOString()
      : undefined,
  };

  // TanStack Query strictly scoped to selectedOrgId
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['audit-logs', 'list', selectedOrgId, queryParams],
    queryFn: ({ signal }) => auditLogsApi.list(queryParams, signal),
    enabled: !!selectedOrgId && canReadAudit,
  });

  const handleOutcomeChange = (newOutcome: 'all' | AuditOutcome) => {
    setOutcomeFilter(newOutcome);
    setCursorStack([]);
  };

  const handleActorTypeChange = (newActorType: 'all' | AuditActorType) => {
    setActorTypeFilter(newActorType);
    setCursorStack([]);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveActionQuery(actionInput.trim());
    setActiveResourceTypeQuery(resourceTypeInput.trim());
    setActiveCorrelationIdQuery(correlationIdInput.trim());
    setCursorStack([]);
  };

  const handleClearFilters = () => {
    setOutcomeFilter('all');
    setActorTypeFilter('all');
    setActionInput('');
    setActiveActionQuery('');
    setResourceTypeInput('');
    setActiveResourceTypeQuery('');
    setCorrelationIdInput('');
    setActiveCorrelationIdQuery('');
    setOccurredFromDate('');
    setOccurredToDate('');
    setSort('-occurredAt');
    setCursorStack([]);
  };

  const handleFilterByCorrelation = (correlationId: string) => {
    setCorrelationIdInput(correlationId);
    setActiveCorrelationIdQuery(correlationId);
    setCursorStack([]);
  };

  const handleSortChange = (newSort: string) => {
    setSort(newSort);
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

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback
    }
  };

  const isFiltered =
    outcomeFilter !== 'all' ||
    actorTypeFilter !== 'all' ||
    activeActionQuery !== '' ||
    activeResourceTypeQuery !== '' ||
    activeCorrelationIdQuery !== '' ||
    occurredFromDate !== '' ||
    occurredToDate !== '';

  const logs = data?.data ?? [];
  const pageInfo = data?.page;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">Audit Logs</h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Immutable, append-only security and operational audit trail scoped to this organization.
          </p>
        </div>
      </div>

      {/* Filter and Control Toolbar */}
      <div className="space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        {/* Outcome and Actor Type Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Outcome Filter */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-[var(--color-ink-muted)] mr-1">Outcome:</span>
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'success', label: 'Success' },
                { id: 'denied', label: 'Denied' },
                { id: 'failure', label: 'Failure' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleOutcomeChange(tab.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  outcomeFilter === tab.id
                    ? 'border border-[var(--color-border-subtle)] bg-[var(--color-surface)] text-[var(--color-ink)] shadow-xs'
                    : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Actor Type Filter */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--color-ink-muted)]">Actor:</span>
            <select
              value={actorTypeFilter}
              onChange={(e) => handleActorTypeChange(e.target.value as 'all' | AuditActorType)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              <option value="all">All Actors</option>
              <option value="user">User</option>
              <option value="api_key">API Key</option>
              <option value="oauth_client">OAuth Client</option>
              <option value="system">System</option>
            </select>
          </div>
        </div>

        {/* Search Inputs Form */}
        <form
          onSubmit={handleSearchSubmit}
          className="space-y-3 border-t border-[var(--color-border-subtle)] pt-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              type="text"
              placeholder="Action key (e.g. user_role.granted)"
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            />
            <input
              type="text"
              placeholder="Resource Type (e.g. RoleAssignment)"
              value={resourceTypeInput}
              onChange={(e) => setResourceTypeInput(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            />
            <input
              type="text"
              placeholder="Correlation ID (UUID)"
              value={correlationIdInput}
              onChange={(e) => setCorrelationIdInput(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--color-ink-muted)]">From:</span>
              <input
                type="date"
                value={occurredFromDate}
                onChange={(e) => {
                  setOccurredFromDate(e.target.value);
                  setCursorStack([]);
                }}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              />
              <span className="text-xs text-[var(--color-ink-muted)]">To:</span>
              <input
                type="date"
                value={occurredToDate}
                onChange={(e) => {
                  setOccurredToDate(e.target.value);
                  setCursorStack([]);
                }}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-ink-muted)]">Sort:</span>
              <select
                value={sort}
                onChange={(e) => handleSortChange(e.target.value)}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <button
                type="submit"
                className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90"
              >
                Apply Filters
              </button>

              {isFiltered && (
                <button
                  type="button"
                  onClick={handleClearFilters}
                  className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

      {/* Main Content Area */}
      {!canReadAudit ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
          <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            You do not hold the required <code className="font-mono">audit.read</code> permission in
            this organization.
          </p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12">
          <div className="flex items-center gap-3">
            <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            <p className="text-sm text-[var(--color-ink-muted)]">Loading audit trail…</p>
          </div>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
          {error instanceof ApiError && error.status === 403 ? (
            <>
              <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                You do not hold the required <code className="font-mono">audit.read</code>{' '}
                permission in this organization.
              </p>
            </>
          ) : error instanceof ApiError && error.status === 429 ? (
            <>
              <p className="text-base font-semibold text-[var(--color-warn)]">
                Rate Limit Exceeded
              </p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                Too many requests. Please wait a few moments before trying again.
              </p>
            </>
          ) : (
            <>
              <p className="text-base font-semibold text-[var(--color-bad)]">
                Failed to Load Audit Logs
              </p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                {error instanceof ApiError ? error.message : 'An unexpected error occurred.'}
              </p>
              <button
                type="button"
                onClick={() => refetch()}
                className="mt-4 rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
              >
                Retry
              </button>
            </>
          )}
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12 text-center">
          <p className="text-base font-semibold text-[var(--color-ink)]">
            {isFiltered ? 'No matching audit records' : 'No audit records recorded yet'}
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {isFiltered
              ? 'Try widening your date range or clearing search filters.'
              : 'Administrative, identity, and security operations write to this trail automatically.'}
          </p>
          {isFiltered && (
            <button
              type="button"
              onClick={handleClearFilters}
              className="mt-4 rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        /* Logs Table */
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Occurred At
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Action &amp; Outcome
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Actor
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Resource
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Scope
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Trace / Correlation
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {logs.map((log) => (
                  <tr
                    key={log.id}
                    className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                  >
                    <td className="px-4 py-3 text-[var(--color-ink-muted)] whitespace-nowrap">
                      {new Date(log.occurredAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-medium text-[var(--color-ink)]">
                          {log.action}
                        </span>
                        <span className="inline-flex items-center gap-1 capitalize">
                          <StatusDot
                            tone={OUTCOME_TONES[log.outcome] ?? 'unknown'}
                            label={log.outcome}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-[var(--color-ink)] capitalize">
                        {log.actorType}
                      </span>
                      {log.actorLabel ? (
                        <span className="block text-[11px] text-[var(--color-ink-muted)]">
                          {log.actorLabel}
                        </span>
                      ) : log.actorUserId ? (
                        <span className="block font-mono text-[10px] text-[var(--color-ink-muted)]">
                          {log.actorUserId.slice(0, 8)}…
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-[var(--color-ink)]">
                        {log.resourceType}
                      </span>
                      {log.resourceId && (
                        <span className="block font-mono text-[10px] text-[var(--color-ink-muted)]">
                          {log.resourceId.slice(0, 8)}…
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] font-medium capitalize text-[var(--color-ink)]">
                        {log.scopeType}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
                        <span title={log.correlationId}>{log.correlationId.slice(0, 8)}…</span>
                        <button
                          type="button"
                          onClick={() => handleCopy(log.correlationId, log.id)}
                          className="text-[10px] text-[var(--color-accent)] hover:underline"
                        >
                          {copiedId === log.id ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedLog(log)}
                        className="rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Toolbar */}
          {pageInfo && (cursorStack.length > 0 || pageInfo.hasMore) && (
            <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-3">
              <span className="text-xs text-[var(--color-ink-muted)]">
                Page {cursorStack.length + 1} {isFetching ? '• Updating…' : ''}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handlePrevPage}
                  disabled={cursorStack.length === 0 || isFetching}
                  className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={handleNextPage}
                  disabled={!pageInfo.hasMore || isFetching}
                  className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Inspect Modal */}
      <AuditLogDetailDialog
        isOpen={!!selectedLog}
        log={selectedLog}
        onClose={() => setSelectedLog(null)}
        onFilterByCorrelation={handleFilterByCorrelation}
      />
    </div>
  );
}
