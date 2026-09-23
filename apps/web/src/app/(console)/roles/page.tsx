'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { rolesApi, ApiError, type ListRolesParams, type RoleView } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useHasPermission, useSession } from '@/lib/session-store';
import { RoleCreateDialog } from '@/components/roles/role-create-dialog';
import { RoleDeleteDialog } from '@/components/roles/role-delete-dialog';
import { RoleEditDialog } from '@/components/roles/role-edit-dialog';

type SystemFilter = 'all' | 'system' | 'custom';
type SortOption = 'key' | '-key' | 'createdAt' | '-createdAt';

export default function RolesPage() {
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);
  const canReadRoles = useHasPermission('roles.read');
  const canCreateRole = useHasPermission('roles.create');
  const canUpdateRole = useHasPermission('roles.update');
  const canDeleteRole = useHasPermission('roles.delete');

  // Filters & Pagination State
  const [systemFilter, setSystemFilter] = useState<SystemFilter>('all');
  const [keySearch, setKeySearch] = useState('');
  const [appliedKeySearch, setAppliedKeySearch] = useState('');
  const [sortOption, setSortOption] = useState<SortOption>('key');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);

  // Dialog State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [roleToEdit, setRoleToEdit] = useState<RoleView | null>(null);
  const [roleToDelete, setRoleToDelete] = useState<RoleView | null>(null);

  // Construct query parameters
  const queryParams: ListRolesParams = {
    cursor,
    limit: 25,
    sort: sortOption,
    isSystemRole: systemFilter === 'system' ? true : systemFilter === 'custom' ? false : undefined,
    key: appliedKeySearch || undefined,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['roles', 'list', selectedOrgId, queryParams],
    queryFn: ({ signal }) => rolesApi.list(queryParams, signal),
    enabled: !!selectedOrgId && canReadRoles,
  });

  const roles = data?.data ?? [];
  const pageInfo = data?.page;

  const handleNextPage = () => {
    if (pageInfo?.nextCursor) {
      setCursorHistory((prev) => [...prev, cursor ?? '']);
      setCursor(pageInfo.nextCursor);
    }
  };

  const handlePrevPage = () => {
    if (cursorHistory.length > 0) {
      const prevCursor = cursorHistory[cursorHistory.length - 1];
      setCursorHistory((prev) => prev.slice(0, -1));
      setCursor(prevCursor || undefined);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCursor(undefined);
    setCursorHistory([]);
    setAppliedKeySearch(keySearch.trim().toLowerCase());
  };

  const handleFilterChange = (filter: SystemFilter) => {
    setSystemFilter(filter);
    setCursor(undefined);
    setCursorHistory([]);
  };

  const handleSortChange = (sort: SortOption) => {
    setSortOption(sort);
    setCursor(undefined);
    setCursorHistory([]);
  };

  // Fail-closed authorization check
  if (!canReadRoles) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center shadow-xs">
        <p className="text-sm font-semibold text-[var(--color-bad)]">Access Restricted</p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          You do not hold the required <code className="font-mono">roles.read</code> permission in this organization.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-ink)]">Roles & Permissions</h1>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Manage system and custom roles governing tenant authorization and permission bundles.
          </p>
        </div>

        {canCreateRole && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="rounded-md bg-[var(--color-brand)] px-3.5 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90"
          >
            + Create Custom Role
          </button>
        )}
      </div>

      {/* Control Bar: Filters, Search, Sort */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 shadow-xs">
        {/* System / Custom Tabs */}
        <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-0.5 text-xs">
          <button
            type="button"
            onClick={() => handleFilterChange('all')}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium transition-colors',
              systemFilter === 'all'
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-ink)] shadow-xs'
                : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            All Roles
          </button>
          <button
            type="button"
            onClick={() => handleFilterChange('system')}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium transition-colors',
              systemFilter === 'system'
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-ink)] shadow-xs'
                : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            System Roles
          </button>
          <button
            type="button"
            onClick={() => handleFilterChange('custom')}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium transition-colors',
              systemFilter === 'custom'
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-ink)] shadow-xs'
                : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            Custom Roles
          </button>
        </div>

        {/* Search & Sort */}
        <div className="flex flex-wrap items-center gap-3">
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
            <input
              type="text"
              value={keySearch}
              onChange={(e) => setKeySearch(e.target.value)}
              placeholder="Search by role key..."
              className="w-48 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
            />
            {appliedKeySearch && (
              <button
                type="button"
                onClick={() => {
                  setKeySearch('');
                  setAppliedKeySearch('');
                  setCursor(undefined);
                  setCursorHistory([]);
                }}
                className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                Clear
              </button>
            )}
            <button
              type="submit"
              className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
            >
              Search
            </button>
          </form>

          <select
            value={sortOption}
            onChange={(e) => handleSortChange(e.target.value as SortOption)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
          >
            <option value="key">Sort: Key (A-Z)</option>
            <option value="-key">Sort: Key (Z-A)</option>
            <option value="createdAt">Sort: Created (Oldest)</option>
            <option value="-createdAt">Sort: Created (Newest)</option>
          </select>
        </div>
      </div>

      {/* Main Table Content */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-xs overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-xs text-[var(--color-ink-muted)]">
            Loading roles...
          </div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm font-semibold text-[var(--color-bad)]">Failed to load roles</p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              {error instanceof ApiError ? error.message : 'An unexpected error occurred.'}
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="mt-4 rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
            >
              Retry
            </button>
          </div>
        ) : roles.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--color-ink-muted)]">
            <p className="font-semibold text-[var(--color-ink)]">No roles found</p>
            <p className="mt-1">
              {appliedKeySearch
                ? `No role matches key "${appliedKeySearch}".`
                : 'No roles found matching the selected filter.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] bg-[var(--color-surface)]/50">
                  <th className="px-6 py-3 font-medium">Role Name & Key</th>
                  <th className="px-6 py-3 font-medium">Type</th>
                  <th className="px-6 py-3 font-medium">Allowed Grant Scopes</th>
                  <th className="px-6 py-3 font-medium">Permissions</th>
                  <th className="px-6 py-3 font-medium">Last Updated</th>
                  <th className="px-6 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {roles.map((role) => {
                  const isPlatformRole = role.orgId === null;
                  const isSystemRole = role.isSystemRole;
                  const isCustomRole = !isPlatformRole && !isSystemRole;

                  return (
                    <tr key={role.id} className="hover:bg-[var(--color-surface)]/40 transition-colors">
                      <td className="px-6 py-3.5">
                        <Link
                          href={`/roles/${encodeURIComponent(role.id)}`}
                          className="font-semibold text-[var(--color-ink)] hover:text-[var(--color-brand)] underline-offset-2 hover:underline"
                        >
                          {role.name}
                        </Link>
                        <p className="mt-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">{role.key}</p>
                      </td>

                      <td className="px-6 py-3.5">
                        {isPlatformRole ? (
                          <span className="rounded bg-[var(--color-brand)]/15 px-2 py-0.5 font-mono text-[10px] font-medium text-[var(--color-brand)]">
                            Platform
                          </span>
                        ) : isSystemRole ? (
                          <span className="rounded bg-[var(--color-brand)]/10 px-2 py-0.5 font-mono text-[10px] font-medium text-[var(--color-brand)]">
                            System
                          </span>
                        ) : (
                          <span className="rounded bg-[var(--color-surface)] border border-[var(--color-border-subtle)] px-2 py-0.5 font-mono text-[10px] font-medium text-[var(--color-ink)]">
                            Custom
                          </span>
                        )}
                      </td>

                      <td className="px-6 py-3.5">
                        <div className="flex flex-wrap gap-1">
                          {role.allowedScopeTypes.map((scope) => (
                            <span
                              key={scope}
                              className="rounded bg-[var(--color-surface)] border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-muted)]"
                            >
                              {scope}
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className="px-6 py-3.5">
                        <span className="font-semibold text-[var(--color-ink)]">{role.permissions.length}</span>{' '}
                        <span className="text-[var(--color-ink-muted)]">
                          {role.permissions.length === 1 ? 'grant' : 'grants'}
                        </span>
                      </td>

                      <td className="px-6 py-3.5 text-[var(--color-ink-muted)]">
                        {new Date(role.updatedAt).toLocaleDateString()}
                      </td>

                      <td className="px-6 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            href={`/roles/${encodeURIComponent(role.id)}`}
                            className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
                          >
                            View
                          </Link>

                          {isCustomRole && canUpdateRole && (
                            <button
                              type="button"
                              onClick={() => setRoleToEdit(role)}
                              className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
                            >
                              Edit
                            </button>
                          )}

                          {isCustomRole && canDeleteRole && (
                            <button
                              type="button"
                              onClick={() => setRoleToDelete(role)}
                              className="rounded-md border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--color-bad)] hover:bg-[var(--color-bad)]/20"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Keyset Cursor Pagination Footer */}
        <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-6 py-3 text-xs text-[var(--color-ink-muted)]">
          <div>
            {isFetching && <span>Refreshing...</span>}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrevPage}
              disabled={cursorHistory.length === 0}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 hover:bg-[var(--color-surface)] disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={handleNextPage}
              disabled={!pageInfo?.hasMore}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 hover:bg-[var(--color-surface)] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <RoleCreateDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={() => void refetch()}
      />
      <RoleEditDialog
        role={roleToEdit}
        isOpen={!!roleToEdit}
        onClose={() => setRoleToEdit(null)}
        onSuccess={() => void refetch()}
      />
      <RoleDeleteDialog
        role={roleToDelete}
        isOpen={!!roleToDelete}
        onClose={() => setRoleToDelete(null)}
        onSuccess={() => void refetch()}
      />
    </div>
  );
}
