'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  teamsApi,
  workspacesApi,
  type ListTeamsParams,
  type ScopeStatus,
  type TeamView,
} from '@/lib/api-client';
import { useHasPermission, useSession } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { TeamCreateDialog } from '@/components/teams/team-create-dialog';
import { TeamEditDialog } from '@/components/teams/team-edit-dialog';
import { TeamArchiveDialog } from '@/components/teams/team-archive-dialog';
import { TeamRestoreDialog } from '@/components/teams/team-restore-dialog';

const STATUS_TONES: Record<ScopeStatus, StatusTone> = {
  active: 'ok',
  archived: 'warn',
};

const SORT_OPTIONS = [
  { value: 'name', label: 'Name (A-Z)' },
  { value: '-createdAt', label: 'Newest first' },
  { value: 'createdAt', label: 'Oldest first' },
] as const;

export default function TeamsPage() {
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);
  const canReadTeams = useHasPermission('teams.read');
  const canCreateTeams = useHasPermission('teams.create');
  const canUpdateTeams = useHasPermission('teams.update');

  const [workspaceFilter, setWorkspaceFilter] = useState<'all' | string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ScopeStatus>('all');
  const [sort, setSort] = useState<string>('name');

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Dialogs state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<TeamView | null>(null);
  const [archivingTeam, setArchivingTeam] = useState<TeamView | null>(null);
  const [restoringTeam, setRestoringTeam] = useState<TeamView | null>(null);

  // Reset state on org change
  useEffect(() => {
    setCursorStack([]);
    setWorkspaceFilter('all');
    setStatusFilter('all');
    setEditingTeam(null);
    setArchivingTeam(null);
    setRestoringTeam(null);
  }, [selectedOrgId]);

  // Fetch workspaces for filter dropdown
  const { data: workspacesData } = useQuery({
    queryKey: ['workspaces', 'all', selectedOrgId],
    queryFn: ({ signal }) => workspacesApi.list(signal),
    enabled: !!selectedOrgId && canReadTeams,
  });

  const workspaces = workspacesData?.data ?? [];
  const workspaceMap = new Map(workspaces.map((w) => [w.id, w.name]));

  // Invariant: Do NOT include orgId in queryParams
  const queryParams: ListTeamsParams = {
    cursor: currentCursor,
    limit: 25,
    sort,
    status: statusFilter === 'all' ? undefined : statusFilter,
    workspaceId: workspaceFilter === 'all' ? undefined : workspaceFilter,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['teams', 'list', selectedOrgId, queryParams],
    queryFn: ({ signal }) => teamsApi.list(queryParams, signal),
    enabled: !!selectedOrgId && canReadTeams,
  });

  const handleWorkspaceChange = (newWs: 'all' | string) => {
    setWorkspaceFilter(newWs);
    setCursorStack([]);
  };

  const handleStatusChange = (newStatus: 'all' | ScopeStatus) => {
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

  const teams = data?.data ?? [];
  const pageInfo = data?.page;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">Teams</h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Configure agent routing, operator groups, and workspace communications.
          </p>
        </div>

        {canCreateTeams && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            + Create Team
          </button>
        )}
      </div>

      {/* Filter and Control Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Workspace Filter */}
          <div className="flex items-center gap-1.5">
            <label htmlFor="team-ws-filter" className="text-xs text-[var(--color-ink-muted)]">
              Workspace:
            </label>
            <select
              id="team-ws-filter"
              value={workspaceFilter}
              onChange={(e) => handleWorkspaceChange(e.target.value)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              <option value="all">All Workspaces</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'active', label: 'Active' },
                { id: 'archived', label: 'Archived' },
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
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="teams-sort" className="text-xs text-[var(--color-ink-muted)]">
            Sort:
          </label>
          <select
            id="teams-sort"
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
      {!selectedOrgId ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center text-xs text-[var(--color-ink-muted)]">
          Please select an active organization context to view teams.
        </div>
      ) : !canReadTeams ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
          <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            You do not hold the required <code className="font-mono">teams.read</code> permission.
          </p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12">
          <div className="flex items-center gap-3">
            <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            <p className="text-sm text-[var(--color-ink-muted)]">Loading teams…</p>
          </div>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
          <p className="text-base font-semibold text-[var(--color-bad)]">Failed to Load Teams</p>
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
        </div>
      ) : teams.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12 text-center">
          <p className="text-base font-semibold text-[var(--color-ink)]">
            {statusFilter !== 'all' || workspaceFilter !== 'all'
              ? 'No matching teams found'
              : 'No teams created yet'}
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {statusFilter !== 'all' || workspaceFilter !== 'all'
              ? 'Try widening your filters to see more results.'
              : 'Create a team to organize routing and agents within your workspaces.'}
          </p>
          {canCreateTeams && (
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="mt-4 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Create Team
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Team</th>
                  <th scope="col" className="px-4 py-3 font-medium">Workspace</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Created</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {teams.map((team) => (
                  <tr key={team.id} className="hover:bg-[var(--color-surface-raised)]/50 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        href={`/teams/${team.id}`}
                        className="font-medium text-[var(--color-accent)] hover:underline"
                      >
                        {team.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                      <Link
                        href={`/workspaces/${team.workspaceId}`}
                        className="text-[var(--color-ink)] hover:underline"
                      >
                        {workspaceMap.get(team.workspaceId) ?? (
                          <span className="font-mono text-[10px]">{team.workspaceId.slice(0, 8)}…</span>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusDot tone={STATUS_TONES[team.status]} label={team.status} />
                    </td>
                    <td className="px-4 py-3 text-[var(--color-ink-muted)] whitespace-nowrap">
                      {new Date(team.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {canUpdateTeams && team.status === 'active' && (
                          <>
                            <button
                              type="button"
                              onClick={() => setEditingTeam(team)}
                              className="rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => setArchivingTeam(team)}
                              className="rounded border border-[var(--color-warn)]/40 px-2 py-1 text-[11px] text-[var(--color-warn)] hover:bg-[var(--color-warn)]/10"
                            >
                              Archive
                            </button>
                          </>
                        )}
                        {canUpdateTeams && team.status === 'archived' && (
                          <button
                            type="button"
                            onClick={() => setRestoringTeam(team)}
                            className="rounded border border-[var(--color-accent)]/40 px-2 py-1 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10"
                          >
                            Restore
                          </button>
                        )}
                        <Link
                          href={`/teams/${team.id}`}
                          className="rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                        >
                          Inspect
                        </Link>
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

      {/* Create Dialog */}
      <TeamCreateDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={() => {
          void refetch();
        }}
      />

      {/* Edit Dialog */}
      <TeamEditDialog
        isOpen={!!editingTeam}
        team={editingTeam}
        onClose={() => setEditingTeam(null)}
        onSuccess={() => {
          void refetch();
        }}
      />

      {/* Archive Dialog */}
      <TeamArchiveDialog
        isOpen={!!archivingTeam}
        team={archivingTeam}
        onClose={() => setArchivingTeam(null)}
        onSuccess={() => {
          void refetch();
        }}
      />

      {/* Restore Dialog */}
      <TeamRestoreDialog
        isOpen={!!restoringTeam}
        team={restoringTeam}
        onClose={() => setRestoringTeam(null)}
        onSuccess={() => {
          void refetch();
        }}
      />
    </div>
  );
}
