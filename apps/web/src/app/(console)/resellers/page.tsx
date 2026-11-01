'use client';

import { useState } from 'react';

import Link from 'next/link';
import type { Route } from 'next';
import { useQuery } from '@tanstack/react-query';
import { ApiError, resellersApi, type ResellerStatus } from '@/lib/api-client';
import { useCanManageResellers, useCanReadResellers } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { CreateResellerDialog } from '@/components/resellers/create-reseller-dialog';

const STATUS_TONES: Record<ResellerStatus, StatusTone> = {
  active: 'ok',
  suspended: 'warn',
  closed: 'bad',
};

const SORT_OPTIONS = [
  { value: 'name', label: 'Name (A-Z)' },
  { value: '-createdAt', label: 'Newest first' },
  { value: 'createdAt', label: 'Oldest first' },
] as const;

export default function ResellersPage() {
  const canReadResellers = useCanReadResellers();
  const canManageResellers = useCanManageResellers();

  const [statusFilter, setStatusFilter] = useState<'all' | ResellerStatus>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<string>('name');

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const queryParams = {
    cursor: currentCursor,
    limit: 25,
    sort,
    status: statusFilter === 'all' ? undefined : statusFilter,
    search: search.trim() || undefined,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['resellers', 'list', queryParams],
    queryFn: ({ signal }) => resellersApi.list(queryParams, signal),
    enabled: canReadResellers,
  });

  const handleStatusChange = (newStatus: 'all' | ResellerStatus) => {
    setStatusFilter(newStatus);
    setCursorStack([]);
  };

  const handleSearchChange = (val: string) => {
    setSearch(val);
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

  const resellers = data?.data ?? [];
  const pageInfo = data?.page;

  if (!canReadResellers) {
    return (
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center">
        <h2 className="text-lg font-semibold text-[var(--color-ink)]">Access Restricted</h2>
        <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
          You do not have permission to view reseller partner administration.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">Resellers</h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Reseller partner management, markup rates, white-label branding, and hierarchy
            oversight.
          </p>
        </div>

        {canManageResellers && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary,#2563eb)] px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90"
            >
              <span>+ Add Reseller</span>
            </button>
          </div>
        )}
      </div>

      {/* Filters and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          {/* Status Tabs */}
          <div className="flex rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-0.5 text-xs">
            {(['all', 'active', 'suspended'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => handleStatusChange(s)}
                aria-pressed={statusFilter === s}
                className={`rounded px-2.5 py-1 font-medium capitalize transition-colors ${
                  statusFilter === s
                    ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-xs'
                    : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Search Input */}
          <div className="relative">
            <input
              type="search"
              aria-label="Search resellers"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search by name, slug, or domain…"
              className="w-64 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>
        </div>

        {/* Sort Filter */}
        <div className="flex items-center gap-2">
          <label htmlFor="reseller-sort" className="text-xs text-[var(--color-ink-muted)]">
            Sort by:
          </label>
          <select
            id="reseller-sort"
            value={sort}
            onChange={(e) => handleSortChange(e.target.value)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Content Area */}
      {isLoading ? (
        <div
          role="status"
          className="flex h-48 items-center justify-center rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]"
        >
          <p className="text-xs text-[var(--color-ink-muted)]">Loading resellers…</p>
        </div>
      ) : error ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-bad)] bg-[var(--color-bad-subtle,#fee2e2)] p-6 text-center"
        >
          <p className="text-sm font-semibold text-[var(--color-bad)]">Failed to load resellers</p>

          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {error instanceof ApiError ? error.message : 'An unexpected error occurred'}
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-3 rounded-md border border-[var(--color-bad)] px-3 py-1 text-xs font-medium text-[var(--color-bad)] hover:bg-[var(--color-surface)]"
          >
            Retry
          </button>
        </div>
      ) : resellers.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-12 text-center">
          <p className="text-sm font-medium text-[var(--color-ink)]">No resellers found</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {search || statusFilter !== 'all'
              ? 'Try adjusting your search query or filters.'
              : 'Add your first reseller partner to begin onboarding multi-tenant customers.'}
          </p>
          {canManageResellers && !search && statusFilter === 'all' && (
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="mt-4 inline-flex items-center rounded-md bg-[var(--color-primary,#2563eb)] px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90"
            >
              + Create First Reseller
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Reseller Name & Slug
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Portal Domain
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Markup (%)
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Customer Orgs
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
                {resellers.map((r) => (
                  <tr
                    key={r.id}
                    className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <Link
                          href={`/resellers/${r.id}` as Route}
                          className="font-semibold text-[var(--color-ink)] hover:underline"
                        >
                          {r.name}
                        </Link>
                        <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                          {r.slug}
                          {r.isPlatformDefault && (
                            <span className="ml-1.5 rounded bg-[var(--color-surface-raised)] px-1 py-0.2 text-[9px] text-[var(--color-ink-muted)]">
                              Platform Default
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <StatusDot tone={STATUS_TONES[r.status]} label={r.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
                      {r.domain ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-ink)]">
                      {r.defaultMarkupPct}%
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 font-mono text-[10px] font-medium text-[var(--color-ink)]">
                        {r.customerCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--color-ink-muted)]">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <Link
                        href={`/resellers/${r.id}` as Route}
                        className="rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                      >
                        View Details →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {pageInfo && (cursorStack.length > 0 || (pageInfo.hasMore && pageInfo.nextCursor)) && (
            <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-3 text-xs">
              <span className="text-[var(--color-ink-muted)]">
                Showing {resellers.length} reseller{resellers.length === 1 ? '' : 's'}
                {isFetching && ' (refreshing…)'}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handlePrevPage}
                  disabled={cursorStack.length === 0 || isFetching}
                  className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={handleNextPage}
                  disabled={!pageInfo.hasMore || !pageInfo.nextCursor || isFetching}
                  className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Creation Modal */}
      <CreateResellerDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={() => void refetch()}
      />
    </div>
  );
}
