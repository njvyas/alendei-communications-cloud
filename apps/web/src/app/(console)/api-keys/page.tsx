'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  apiKeysApi,
  type ApiKeyScopeType,
  type ApiKeyStatus,
  type ApiKeyView,
  type ListApiKeysParams,
} from '@/lib/api-client';
import { useHasPermission, useSession } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { CreateApiKeyDialog } from '@/components/api-keys/create-api-key-dialog';
import { RevokeApiKeyDialog } from '@/components/api-keys/revoke-api-key-dialog';
import { ApiKeyDetailDialog } from '@/components/api-keys/api-key-detail-dialog';

const STATUS_TONES: Record<string, StatusTone> = {
  active: 'ok',
  expired: 'warn',
  revoked: 'bad',
};

const SORT_OPTIONS = [
  { value: '-createdAt', label: 'Newest first (Default)' },
  { value: 'createdAt', label: 'Oldest first' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: '-name', label: 'Name (Z–A)' },
] as const;

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);

  // Permission checks (UX gating only; backend remains authoritative)
  const canRead = useHasPermission('api_keys.read');
  const canCreate = useHasPermission('api_keys.create');
  const canRevoke = useHasPermission('api_keys.revoke');

  // Filter and pagination state
  const [statusFilter, setStatusFilter] = useState<'all' | ApiKeyStatus>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | ApiKeyScopeType>('all');
  const [nameInput, setNameInput] = useState('');
  const [activeNameQuery, setActiveNameQuery] = useState('');
  const [sort, setSort] = useState<string>('-createdAt');

  // Cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Dialog State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKeyView | null>(null);
  const [keyToDetail, setKeyToDetail] = useState<ApiKeyView | null>(null);

  // Query parameters
  const queryParams: ListApiKeysParams = {
    status: statusFilter === 'all' ? undefined : statusFilter,
    scopeType: scopeFilter === 'all' ? undefined : scopeFilter,
    name: activeNameQuery || undefined,
    sort,
    cursor: currentCursor,
    limit: 25,
  };

  // TanStack Query partitioned strictly by selectedOrgId
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['api-keys', 'list', selectedOrgId, queryParams],
    queryFn: ({ signal }) => apiKeysApi.list(queryParams, signal),
    enabled: !!selectedOrgId && canRead,
  });

  const handleStatusChange = (newStatus: 'all' | ApiKeyStatus) => {
    setStatusFilter(newStatus);
    setCursorStack([]);
  };

  const handleScopeChange = (newScope: 'all' | ApiKeyScopeType) => {
    setScopeFilter(newScope);
    setCursorStack([]);
  };

  const handleNameSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveNameQuery(nameInput.trim());
    setCursorStack([]);
  };

  const handleClearFilters = () => {
    setStatusFilter('all');
    setScopeFilter('all');
    setNameInput('');
    setActiveNameQuery('');
    setSort('-createdAt');
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

  const isFiltered = statusFilter !== 'all' || scopeFilter !== 'all' || activeNameQuery !== '';
  const apiKeys = data?.data ?? [];
  const pageInfo = data?.page;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">API Keys</h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Programmatic access credentials scoped to this organization and its workspaces.
          </p>
        </div>

        {canCreate && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90 transition-opacity"
          >
            + Create API Key
          </button>
        )}
      </div>

      {/* Filter and Control Toolbar */}
      <div className="space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Status Tabs */}
          <div className="flex flex-wrap gap-1">
            {(
              [
                { id: 'all', label: 'All Statuses' },
                { id: 'active', label: 'Active' },
                { id: 'expired', label: 'Expired' },
                { id: 'revoked', label: 'Revoked' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleStatusChange(tab.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  statusFilter === tab.id
                    ? 'border border-[var(--color-border-subtle)] bg-[var(--color-surface)] text-[var(--color-ink)] shadow-xs'
                    : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Scope Filter */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--color-ink-muted)]">Scope:</span>
            <select
              value={scopeFilter}
              onChange={(e) => handleScopeChange(e.target.value as 'all' | ApiKeyScopeType)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              <option value="all">All Scopes</option>
              <option value="organization">Organization</option>
              <option value="workspace">Workspace</option>
            </select>
          </div>
        </div>

        {/* Search & Sort Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] pt-3">
          <form onSubmit={handleNameSearch} className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search key name exactly…"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className="w-48 sm:w-64 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            />
            <button
              type="submit"
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Search
            </button>
          </form>

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
      {!canRead ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
          <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            You do not hold the required <code className="font-mono">api_keys.read</code> permission
            in this organization.
          </p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12">
          <div className="flex items-center gap-3">
            <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            <p className="text-sm text-[var(--color-ink-muted)]">Loading API keys…</p>
          </div>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
          {error instanceof ApiError && error.status === 403 ? (
            <>
              <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                You do not hold the required <code className="font-mono">api_keys.read</code>{' '}
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
                Failed to Load API Keys
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
      ) : apiKeys.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12 text-center">
          {isFiltered ? (
            <>
              <p className="text-base font-semibold text-[var(--color-ink)]">
                No matching API keys found
              </p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                Try adjusting your filters, scope, or search query.
              </p>
              <button
                type="button"
                onClick={handleClearFilters}
                className="mt-4 rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
              >
                Clear all filters
              </button>
            </>
          ) : (
            <>
              <p className="text-base font-semibold text-[var(--color-ink)]">
                No API keys created yet
              </p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                Mint an API key to enable secure machine-to-machine integrations.
              </p>
              {canCreate && (
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(true)}
                  className="mt-4 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90"
                >
                  Create your first API key
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        /* Keys Table */
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Key Name &amp; Prefix
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Scope
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Last Used
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Expires
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {apiKeys.map((key) => (
                  <tr
                    key={key.id}
                    className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold text-[var(--color-ink)]">{key.name}</div>
                      <code className="font-mono text-[11px] text-[var(--color-ink-muted)]">
                        {key.prefix}…
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] font-medium capitalize text-[var(--color-ink)]">
                        {key.scopeType}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 capitalize text-[var(--color-ink)]">
                        <StatusDot
                          tone={STATUS_TONES[key.status] ?? 'unknown'}
                          label={key.status}
                        />
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                      {new Date(key.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                      {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                      {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setKeyToDetail(key)}
                          className="rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                        >
                          Details
                        </button>
                        {key.status === 'active' && canRevoke && (
                          <button
                            type="button"
                            onClick={() => setKeyToRevoke(key)}
                            className="rounded border border-[var(--color-bad)]/30 px-2 py-1 text-[11px] text-[var(--color-bad)] hover:bg-[var(--color-bad)]/10"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
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

      {/* Dialogs */}
      <CreateApiKeyDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
        }}
      />

      <RevokeApiKeyDialog
        isOpen={!!keyToRevoke}
        apiKey={keyToRevoke}
        onClose={() => setKeyToRevoke(null)}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
        }}
      />

      <ApiKeyDetailDialog
        isOpen={!!keyToDetail}
        apiKey={keyToDetail}
        onClose={() => setKeyToDetail(null)}
        onRevokeClick={(k) => setKeyToRevoke(k)}
      />
    </div>
  );
}
