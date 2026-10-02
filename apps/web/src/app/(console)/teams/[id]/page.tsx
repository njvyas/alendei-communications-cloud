'use client';

import { use, useState, useEffect } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, teamsApi, workspacesApi, type ScopeStatus } from '@/lib/api-client';
import { useHasPermission, useSession } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { TeamEditDialog } from '@/components/teams/team-edit-dialog';
import { TeamArchiveDialog } from '@/components/teams/team-archive-dialog';
import { TeamRestoreDialog } from '@/components/teams/team-restore-dialog';

const STATUS_TONES: Record<ScopeStatus, StatusTone> = {
  active: 'ok',
  archived: 'warn',
};

export default function TeamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);
  const canReadTeams = useHasPermission('teams.read');
  const canUpdateTeams = useHasPermission('teams.update');

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [isRestoreOpen, setIsRestoreOpen] = useState(false);

  useEffect(() => {
    setIsEditOpen(false);
    setIsArchiveOpen(false);
    setIsRestoreOpen(false);
  }, [selectedOrgId]);

  const {
    data: teamData,
    isLoading: teamLoading,
    error: teamError,
    refetch,
  } = useQuery({
    queryKey: ['teams', 'detail', selectedOrgId, id],
    queryFn: ({ signal }) => teamsApi.get(id, signal),
    enabled: !!selectedOrgId && canReadTeams && !!id,
  });

  const team = teamData?.data;

  // Fetch parent workspace name
  const { data: parentWsData } = useQuery({
    queryKey: ['workspaces', 'detail', selectedOrgId, team?.workspaceId],
    queryFn: ({ signal }) =>
      team?.workspaceId ? workspacesApi.get(team.workspaceId, signal) : null,
    enabled: !!selectedOrgId && !!team?.workspaceId,
  });

  const parentWorkspace = parentWsData?.data;

  if (!selectedOrgId) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center text-xs text-[var(--color-ink-muted)]">
        Please select an active organization context.
      </div>
    );
  }

  if (!canReadTeams) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
        <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          You do not hold permission to view this team.
        </p>
        <Link
          href="/teams"
          className="mt-4 inline-block rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
        >
          ← Back to Teams
        </Link>
      </div>
    );
  }

  if (teamLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12">
        <div className="flex items-center gap-3">
          <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
          <p className="text-sm text-[var(--color-ink-muted)]">Loading team details…</p>
        </div>
      </div>
    );
  }

  if (teamError) {
    const isNotFound = teamError instanceof ApiError && teamError.status === 404;
    const isForbidden = teamError instanceof ApiError && teamError.status === 403;

    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
        <p className="text-base font-semibold text-[var(--color-bad)]">
          {isNotFound ? 'Team Not Found' : isForbidden ? 'Access Forbidden' : 'Failed to Load Team'}
        </p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          {isNotFound
            ? 'The requested team does not exist in this organization or is not accessible.'
            : isForbidden
              ? 'You do not have permission to access this team.'
              : teamError instanceof ApiError
                ? teamError.message
                : 'An unexpected error occurred.'}
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link
            href="/teams"
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
          >
            ← Back to Teams
          </Link>
          {!isNotFound && !isForbidden && (
            <button
              type="button"
              onClick={() => refetch()}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!team) return null;

  const isArchived = team.status === 'archived';

  return (
    <div className="space-y-6">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <Link href="/teams" className="hover:underline">
          Teams
        </Link>
        <span>/</span>
        <span className="font-medium text-[var(--color-ink)]">{team.name}</span>
      </div>

      {/* Header and Actions */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-[var(--color-ink)]">
              {team.name}
            </h1>
            <StatusDot tone={STATUS_TONES[team.status]} label={team.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">ID: {team.id}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canUpdateTeams && !isArchived && (
            <>
              <button
                type="button"
                onClick={() => setIsEditOpen(true)}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
              >
                Edit Name
              </button>
              <button
                type="button"
                onClick={() => setIsArchiveOpen(true)}
                className="rounded-md border border-[var(--color-warn)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-warn)] hover:bg-[var(--color-warn)]/10"
              >
                Archive Team
              </button>
            </>
          )}

          {canUpdateTeams && isArchived && (
            <button
              type="button"
              onClick={() => setIsRestoreOpen(true)}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Restore Team
            </button>
          )}
        </div>
      </div>

      {/* Archived Notice */}
      {isArchived && (
        <div className="rounded-xl border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-4 text-xs text-[var(--color-warn)]">
          <p className="font-semibold">Team Archived</p>
          <p className="mt-1 leading-relaxed">
            This team is archived. Granting new permissions or roles targeting this team scope is
            blocked.
          </p>
        </div>
      )}

      {/* Details Card */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">Team Information</h2>
        <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 text-xs">
          <div>
            <dt className="text-[var(--color-ink-muted)]">Parent Workspace</dt>
            <dd className="mt-0.5">
              <Link
                href={`/workspaces/${team.workspaceId}`}
                className="font-medium text-[var(--color-accent)] hover:underline"
              >
                {parentWorkspace
                  ? `${parentWorkspace.name} (${parentWorkspace.slug})`
                  : team.workspaceId}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Organization ID</dt>
            <dd className="font-mono text-[var(--color-ink)] mt-0.5">{team.orgId}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Created</dt>
            <dd className="text-[var(--color-ink)] mt-0.5">
              {new Date(team.createdAt).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Updated</dt>
            <dd className="text-[var(--color-ink)] mt-0.5">
              {new Date(team.updatedAt).toLocaleString()}
            </dd>
          </div>
        </dl>
      </div>

      {/* Dialogs */}
      <TeamEditDialog
        isOpen={isEditOpen}
        team={team}
        onClose={() => setIsEditOpen(false)}
        onSuccess={() => {
          void refetch();
        }}
      />

      <TeamArchiveDialog
        isOpen={isArchiveOpen}
        team={team}
        onClose={() => setIsArchiveOpen(false)}
        onSuccess={() => {
          void refetch();
        }}
      />

      <TeamRestoreDialog
        isOpen={isRestoreOpen}
        team={team}
        onClose={() => setIsRestoreOpen(false)}
        onSuccess={() => {
          void refetch();
        }}
      />
    </div>
  );
}
