'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, usersApi, type UserStatus } from '@/lib/api-client';
import { useHasPermission, useSession } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { UserCreateDialog } from '@/components/users/user-create-dialog';

const STATUS_TONES: Record<string, StatusTone> = {
  active: 'ok',
  invited: 'warn',
  disabled: 'bad',
};

const SORT_OPTIONS = [
  { value: '-createdAt', label: 'Newest first (Default)' },
  { value: 'createdAt', label: 'Oldest first' },
  { value: 'email', label: 'Email (A–Z)' },
  { value: '-email', label: 'Email (Z–A)' },
  { value: 'status', label: 'Status (A–Z)' },
  { value: '-status', label: 'Status (Z–A)' },
] as const;

export default function UsersPage() {
  const queryClient = useQueryClient();
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);

  // Authorization checks
  const canInvite = useHasPermission('users.invite');

  // Filter and pagination state
  const [statusFilter, setStatusFilter] = useState<'all' | UserStatus>('all');
  const [emailInput, setEmailInput] = useState('');
  const [activeEmailQuery, setActiveEmailQuery] = useState('');
  const [sort, setSort] = useState<string>('-createdAt');

  // Cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Dialog state
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  // Active user query scoped strictly to the selected organization
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: [
      'users',
      'list',
      selectedOrgId,
      {
        status: statusFilter === 'all' ? undefined : statusFilter,
        email: activeEmailQuery || undefined,
        sort,
        cursor: currentCursor,
        limit: 25,
      },
    ],
    queryFn: ({ signal }) =>
      usersApi.list(
        {
          status: statusFilter === 'all' ? undefined : statusFilter,
          email: activeEmailQuery || undefined,
          sort,
          cursor: currentCursor,
          limit: 25,
        },
        signal,
      ),
    enabled: !!selectedOrgId,
  });

  const handleStatusChange = (newStatus: 'all' | UserStatus) => {
    setStatusFilter(newStatus);
    setCursorStack([]); // Reset pagination when filters change
  };

  const handleEmailSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveEmailQuery(emailInput.trim());
    setCursorStack([]); // Reset pagination when search query changes
  };

  const handleClearFilters = () => {
    setStatusFilter('all');
    setEmailInput('');
    setActiveEmailQuery('');
    setSort('-createdAt');
    setCursorStack([]);
  };

  const handleSortChange = (newSort: string) => {
    setSort(newSort);
    setCursorStack([]); // Reset pagination on sort change
  };

  const handleNextPage = () => {
    if (data?.page.nextCursor) {
      setCursorStack((prev) => [...prev, data.page.nextCursor!]);
    }
  };

  const handlePrevPage = () => {
    setCursorStack((prev) => prev.slice(0, -1));
  };

  const isFiltered = statusFilter !== 'all' || activeEmailQuery !== '';
  const users = data?.data ?? [];
  const pageInfo = data?.page;

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">Users</h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Manage user memberships, scopes, and lifecycle states in this organization.
          </p>
        </div>

        {canInvite && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90"
          >
            + Invite User
          </button>
        )}
      </div>

      {/* Filters and Controls Card */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Email Search Form */}
          <form onSubmit={handleEmailSearch} className="flex items-center gap-2">
            <input
              type="text"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="Lookup exact email…"
              aria-label="Lookup exact email"
              className="w-56 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] sm:w-64"
            />
            <button
              type="submit"
              className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
            >
              Lookup
            </button>
            {activeEmailQuery && (
              <button
                type="button"
                onClick={() => {
                  setEmailInput('');
                  setActiveEmailQuery('');
                  setCursorStack([]);
                }}
                className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                Clear
              </button>
            )}
          </form>

          {/* Status & Sort Selectors */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <label htmlFor="filter-status" className="text-xs font-medium text-[var(--color-ink-muted)]">
                Status:
              </label>
              <select
                id="filter-status"
                value={statusFilter}
                onChange={(e) => handleStatusChange(e.target.value as 'all' | UserStatus)}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="invited">Invited</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <label htmlFor="sort-users" className="text-xs font-medium text-[var(--color-ink-muted)]">
                Sort:
              </label>
              <select
                id="sort-users"
                value={sort}
                onChange={(e) => handleSortChange(e.target.value)}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {isFiltered && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
              >
                Reset filters
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      {isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12">
          <div className="flex items-center gap-3">
            <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            <p className="text-sm text-[var(--color-ink-muted)]">Loading users…</p>
          </div>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
          {error instanceof ApiError && error.status === 403 ? (
            <>
              <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                You do not hold the required <code className="font-mono">users.read</code> permission in this organization.
              </p>
            </>
          ) : error instanceof ApiError && error.status === 429 ? (
            <>
              <p className="text-base font-semibold text-[var(--color-warn)]">Rate Limit Exceeded</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                Too many requests. Please wait a few moments before trying again.
              </p>
            </>
          ) : (
            <>
              <p className="text-base font-semibold text-[var(--color-bad)]">Failed to Load Users</p>
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
      ) : users.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12 text-center">
          {isFiltered ? (
            <>
              <p className="text-base font-semibold text-[var(--color-ink)]">No Matching Users</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                No users match the active filter criteria in this organization.
              </p>
              <button
                type="button"
                onClick={handleClearFilters}
                className="mt-4 rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
              >
                Clear Filters
              </button>
            </>
          ) : (
            <>
              <p className="text-base font-semibold text-[var(--color-ink)]">No Users Found</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                There are no users holding grants in this organization yet.
              </p>
              {canInvite && (
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(true)}
                  className="mt-4 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                >
                  Invite First User
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]">
                  <th className="px-4 py-3 font-medium">User Identity</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Phone</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-[var(--color-surface)]/60">
                    <td className="px-4 py-3">
                      <p className="font-medium text-[var(--color-ink)]">{user.email}</p>
                      <p className="font-mono text-[10px] text-[var(--color-ink-muted)]">{user.id}</p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusDot tone={STATUS_TONES[user.status] ?? 'unknown'} label={user.status} />
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                      {user.phone ?? <span className="text-[var(--color-ink-muted)]/60">—</span>}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/users/${user.id}`}
                        className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface)] hover:text-[var(--color-accent)]"
                      >
                        View Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cursor Pagination Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] px-4 py-3 text-xs text-[var(--color-ink-muted)]">
            <div>
              <span>Page {cursorStack.length + 1}</span>
              {isFetching && <span className="ml-2 text-[var(--color-accent)]">Updating…</span>}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrevPage}
                disabled={cursorStack.length === 0 || isFetching}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)] disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={handleNextPage}
                disabled={!pageInfo?.hasMore || !pageInfo?.nextCursor || isFetching}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User Create Dialog */}
      <UserCreateDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: ['users', 'list', selectedOrgId] });
        }}
      />
    </div>
  );
}
