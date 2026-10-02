'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  organizationsApi,
  type ListOrganizationsParams,
  type OrganizationStatus,
} from '@/lib/api-client';
import { useCanCreateOrganizations, useCanReadOrganizations } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { OrganizationCreateDialog } from '@/components/organizations/organization-create-dialog';

const STATUS_TONES: Record<OrganizationStatus, StatusTone> = {
  active: 'ok',
  suspended: 'warn',
  closed: 'bad',
};

const SORT_OPTIONS = [
  { value: 'name', label: 'Name (A-Z)' },
  { value: '-createdAt', label: 'Newest first' },
  { value: 'createdAt', label: 'Oldest first' },
] as const;

export default function OrganizationsPage() {
  const canReadOrganizations = useCanReadOrganizations();
  const canCreateOrganizations = useCanCreateOrganizations();

  const [statusFilter, setStatusFilter] = useState<'all' | OrganizationStatus>('all');
  const [sort, setSort] = useState<string>('name');

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Create Modal State
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const queryParams: ListOrganizationsParams = {
    cursor: currentCursor,
    limit: 25,
    sort,
    status: statusFilter === 'all' ? undefined : statusFilter,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['organizations', 'list', queryParams],
    queryFn: ({ signal }) => organizationsApi.list(queryParams, signal),
    enabled: canReadOrganizations,
  });

  const handleStatusChange = (newStatus: 'all' | OrganizationStatus) => {
    setStatusFilter(newStatus);
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

  const orgs = data?.data ?? [];
  const pageInfo = data?.page;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
            Organizations
          </h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Tenant organization administration, lifecycle management, and provisioning.
          </p>
        </div>

        {canCreateOrganizations && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            + Create Organization
          </button>
        )}
      </div>

      {/* Filter and Control Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-[var(--color-ink-muted)] mr-1">Status:</span>
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'active', label: 'Active' },
              { id: 'suspended', label: 'Suspended' },
              { id: 'closed', label: 'Closed' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => handleStatusChange(t.id)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                statusFilter === t.id
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="orgs-sort" className="text-xs text-[var(--color-ink-muted)]">
            Sort:
          </label>
          <select
            id="orgs-sort"
            value={sort}
            onChange={(e) => handleSortChange(e.target.value)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Content Area */}
      {!canReadOrganizations ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
          <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            You do not hold the required <code className="font-mono">organizations.read</code>{' '}
            permission.
          </p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12">
          <div className="flex items-center gap-3">
            <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            <p className="text-sm text-[var(--color-ink-muted)]">Loading organizations…</p>
          </div>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
          {error instanceof ApiError && error.status === 403 ? (
            <>
              <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                You do not hold permission to view organizations in this scope.
              </p>
            </>
          ) : (
            <>
              <p className="text-base font-semibold text-[var(--color-bad)]">
                Failed to Load Organizations
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
      ) : orgs.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12 text-center">
          <p className="text-base font-semibold text-[var(--color-ink)]">
            {statusFilter !== 'all'
              ? 'No organizations match the selected filter'
              : 'No organizations found'}
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {statusFilter !== 'all'
              ? 'Try selecting a different status filter.'
              : 'You do not currently have access to any organizations within your reach.'}
          </p>
          {canCreateOrganizations && statusFilter === 'all' && (
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="mt-4 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Provision Organization
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Organization
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Legal Entity
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Billing
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
                {orgs.map((org) => (
                  <tr
                    key={org.id}
                    className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/organizations/${org.id}`}
                        className="font-medium text-[var(--color-accent)] hover:underline"
                      >
                        {org.name}
                      </Link>
                      <span className="block font-mono text-[11px] text-[var(--color-ink-muted)]">
                        {org.slug}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusDot tone={STATUS_TONES[org.status]} label={org.status} />
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                      {org.legalName ? (
                        <>
                          <span className="text-[var(--color-ink)]">{org.legalName}</span>
                          {org.gstin && (
                            <span className="block font-mono text-[10px]">{org.gstin}</span>
                          )}
                        </>
                      ) : (
                        <span className="italic">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 capitalize text-[var(--color-ink-muted)]">
                      {org.billingMode}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)] whitespace-nowrap">
                      {new Date(org.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/organizations/${org.id}`}
                        className="rounded border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                      >
                        Manage
                      </Link>
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

      {/* Create Dialog */}
      <OrganizationCreateDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={() => {
          void refetch();
        }}
      />
    </div>
  );
}
