'use client';

import { use, useState, useEffect } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  teamsApi,
  workspacesApi,
  type ScopeStatus,
  type TeamView,
} from '@/lib/api-client';
import { useHasPermission, useSession } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { WorkspaceEditDialog } from '@/components/workspaces/workspace-edit-dialog';
import { WorkspaceArchiveDialog } from '@/components/workspaces/workspace-archive-dialog';
import { WorkspaceRestoreDialog } from '@/components/workspaces/workspace-restore-dialog';
import { TeamCreateDialog } from '@/components/teams/team-create-dialog';
import { TeamEditDialog } from '@/components/teams/team-edit-dialog';
import { TeamArchiveDialog } from '@/components/teams/team-archive-dialog';
import { TeamRestoreDialog } from '@/components/teams/team-restore-dialog';

const STATUS_TONES: Record<ScopeStatus, StatusTone> = {
  active: 'ok',
  archived: 'warn',
};

export default function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);
  const canReadWorkspaces = useHasPermission('workspaces.read');
  const canUpdateWorkspaces = useHasPermission('workspaces.update');
  const canReadTeams = useHasPermission('teams.read');
  const canCreateTeams = useHasPermission('teams.create');
  const canUpdateTeams = useHasPermission('teams.update');

  // Dialogs
  const [isEditWsOpen, setIsEditWsOpen] = useState(false);
  const [isArchiveWsOpen, setIsArchiveWsOpen] = useState(false);
  const [isRestoreWsOpen, setIsRestoreWsOpen] = useState(false);

  const [isCreateTeamOpen, setIsCreateTeamOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<TeamView | null>(null);
  const [archivingTeam, setArchivingTeam] = useState<TeamView | null>(null);
  const [restoringTeam, setRestoringTeam] = useState<TeamView | null>(null);

  // Reset dialogs if organization switches
  useEffect(() => {
    setIsEditWsOpen(false);
    setIsArchiveWsOpen(false);
    setIsRestoreWsOpen(false);
    setIsCreateTeamOpen(false);
    setEditingTeam(null);
    setArchivingTeam(null);
    setRestoringTeam(null);
  }, [selectedOrgId]);

  // Fetch Workspace detail
  const {
    data: wsData,
    isLoading: wsLoading,
    error: wsError,
    refetch: refetchWs,
  } = useQuery({
    queryKey: ['workspaces', 'detail', selectedOrgId, id],
    queryFn: ({ signal }) => workspacesApi.get(id, signal),
    enabled: !!selectedOrgId && canReadWorkspaces && !!id,
  });

  const workspace = wsData?.data;

  // Fetch teams within this workspace (Strictly no orgId in params!)
  const {
    data: teamsData,
    isLoading: teamsLoading,
    error: teamsError,
    refetch: refetchTeams,
  } = useQuery({
    queryKey: ['teams', 'workspace', selectedOrgId, id],
    queryFn: ({ signal }) => teamsApi.list({ workspaceId: id }, signal),
    enabled: !!selectedOrgId && canReadTeams && !!workspace,
  });

  const teams = teamsData?.data ?? [];

  if (!selectedOrgId) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center text-xs text-[var(--color-ink-muted)]">
        Please select an active organization context.
      </div>
    );
  }

  if (!canReadWorkspaces) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
        <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          You do not hold permission to view this workspace.
        </p>
        <Link
          href="/workspaces"
          className="mt-4 inline-block rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
        >
          ← Back to Workspaces
        </Link>
      </div>
    );
  }

  if (wsLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12">
        <div className="flex items-center gap-3">
          <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
          <p className="text-sm text-[var(--color-ink-muted)]">Loading workspace details…</p>
        </div>
      </div>
    );
  }

  if (wsError) {
    const isNotFound = wsError instanceof ApiError && wsError.status === 404;
    const isForbidden = wsError instanceof ApiError && wsError.status === 403;

    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
        <p className="text-base font-semibold text-[var(--color-bad)]">
          {isNotFound ? 'Workspace Not Found' : isForbidden ? 'Access Forbidden' : 'Failed to Load Workspace'}
        </p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          {isNotFound
            ? 'The requested workspace does not exist in this organization or is not accessible.'
            : isForbidden
            ? 'You do not have permission to access this workspace.'
            : wsError instanceof ApiError
            ? wsError.message
            : 'An unexpected error occurred.'}
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link
            href="/workspaces"
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
          >
            ← Back to Workspaces
          </Link>
          {!isNotFound && !isForbidden && (
            <button
              type="button"
              onClick={() => refetchWs()}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!workspace) return null;

  const isArchived = workspace.status === 'archived';

  return (
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
      <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <Link href="/workspaces" className="hover:underline">
          Workspaces
        </Link>
        <span>/</span>
        <span className="font-mono text-[var(--color-ink)]">{workspace.slug}</span>
      </div>

      {/* Header and Actions */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-[var(--color-ink)]">{workspace.name}</h1>
            <StatusDot tone={STATUS_TONES[workspace.status]} label={workspace.status} />
            {workspace.isDefault && (
              <span className="rounded bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--color-ink-muted)]">
                Default Workspace
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">ID: {workspace.id}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canUpdateWorkspaces && !isArchived && (
            <>
              <button
                type="button"
                onClick={() => setIsEditWsOpen(true)}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
              >
                Edit Name
              </button>
              {!workspace.isDefault && (
                <button
                  type="button"
                  onClick={() => setIsArchiveWsOpen(true)}
                  className="rounded-md border border-[var(--color-warn)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-warn)] hover:bg-[var(--color-warn)]/10"
                >
                  Archive Workspace
                </button>
              )}
            </>
          )}

          {canUpdateWorkspaces && isArchived && (
            <button
              type="button"
              onClick={() => setIsRestoreWsOpen(true)}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Restore Workspace
            </button>
          )}
        </div>
      </div>

      {/* Archived Notice */}
      {isArchived && (
        <div className="rounded-xl border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-4 text-xs text-[var(--color-warn)]">
          <p className="font-semibold">Workspace Archived</p>
          <p className="mt-1 leading-relaxed">
            This workspace is archived. Creating new teams, granting new roles, or generating API keys targeting this workspace is blocked.
          </p>
        </div>
      )}

      {/* Details Card */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Workspace Information</h2>
        <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <dt className="text-[var(--color-ink-muted)]">Slug</dt>
            <dd className="font-mono text-[var(--color-ink)] mt-0.5">{workspace.slug}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Organization ID</dt>
            <dd className="font-mono text-[var(--color-ink)] mt-0.5">{workspace.orgId}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Created</dt>
            <dd className="text-[var(--color-ink)] mt-0.5">{new Date(workspace.createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Updated</dt>
            <dd className="text-[var(--color-ink)] mt-0.5">{new Date(workspace.updatedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </div>

      {/* Embedded Teams Section */}
      <div className="space-y-4 pt-4 border-t border-[var(--color-border-subtle)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-ink)]">Teams in Workspace</h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Teams partition operators and routing scopes within {workspace.name}.
            </p>
          </div>

          {canCreateTeams && (
            <button
              type="button"
              disabled={isArchived}
              onClick={() => setIsCreateTeamOpen(true)}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              + Add Team
            </button>
          )}
        </div>

        {!canReadTeams ? (
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6 text-center text-xs text-[var(--color-ink-muted)]">
            You do not have permission to view teams in this workspace.
          </div>
        ) : teamsLoading ? (
          <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8">
            <div className="flex items-center gap-3">
              <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
              <p className="text-xs text-[var(--color-ink-muted)]">Loading teams…</p>
            </div>
          </div>
        ) : teamsError ? (
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6 text-center">
            <p className="text-xs text-[var(--color-bad)]">Failed to load teams for this workspace.</p>
          </div>
        ) : teams.length === 0 ? (
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
            <p className="text-sm font-semibold text-[var(--color-ink)]">No teams in this workspace</p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              {isArchived
                ? 'This workspace is archived and holds no teams.'
                : 'Create a team to organize routing and agents within this workspace.'}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Team Name</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Created</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {teams.map((team) => (
                  <tr key={team.id} className="hover:bg-[var(--color-surface-raised)]/50 transition-colors">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/teams/${team.id}`}
                        className="font-medium text-[var(--color-accent)] hover:underline"
                      >
                        {team.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusDot tone={STATUS_TONES[team.status]} label={team.status} />
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-ink-muted)] whitespace-nowrap">
                      {new Date(team.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
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
        )}
      </div>

      {/* Workspace Dialogs */}
      <WorkspaceEditDialog
        isOpen={isEditWsOpen}
        workspace={workspace}
        onClose={() => setIsEditWsOpen(false)}
        onSuccess={() => {
          void refetchWs();
        }}
      />

      <WorkspaceArchiveDialog
        isOpen={isArchiveWsOpen}
        workspace={workspace}
        onClose={() => setIsArchiveWsOpen(false)}
        onSuccess={() => {
          void refetchWs();
        }}
      />

      <WorkspaceRestoreDialog
        isOpen={isRestoreWsOpen}
        workspace={workspace}
        onClose={() => setIsRestoreWsOpen(false)}
        onSuccess={() => {
          void refetchWs();
        }}
      />

      {/* Team Dialogs */}
      <TeamCreateDialog
        isOpen={isCreateTeamOpen}
        initialWorkspaceId={workspace.id}
        onClose={() => setIsCreateTeamOpen(false)}
        onSuccess={() => {
          void refetchTeams();
        }}
      />

      <TeamEditDialog
        isOpen={!!editingTeam}
        team={editingTeam}
        onClose={() => setEditingTeam(null)}
        onSuccess={() => {
          void refetchTeams();
        }}
      />

      <TeamArchiveDialog
        isOpen={!!archivingTeam}
        team={archivingTeam}
        onClose={() => setArchivingTeam(null)}
        onSuccess={() => {
          void refetchTeams();
        }}
      />

      <TeamRestoreDialog
        isOpen={!!restoringTeam}
        team={restoringTeam}
        onClose={() => setRestoringTeam(null)}
        onSuccess={() => {
          void refetchTeams();
        }}
      />
    </div>
  );
}
