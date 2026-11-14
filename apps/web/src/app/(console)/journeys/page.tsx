'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { journeysApi, workspacesApi } from '@/lib/api-client';
import { useCanManageJourneys, useCanReadJourneys, useSession } from '@/lib/session-store';
import { calculateJourneyKPIs, JOURNEY_STATUSES, type JourneyRecord } from '@/lib/journeys';
import {
  JourneyStatusBadge,
  JourneyTriggerBadge,
} from '@/components/journeys/journey-status-badge';
import { JourneyCreateDialog } from '@/components/journeys/journey-create-dialog';
import { StatCard } from '@/components/ui/stat-card';

export default function JourneysDirectoryPage() {
  const canReadJourneys = useCanReadJourneys();
  const canManageJourneys = useCanManageJourneys();
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);

  // Workspaces of the active organization
  const { data: workspacesData } = useQuery({
    queryKey: ['workspaces', 'list', selectedOrganizationId, { limit: 50 }],
    queryFn: ({ signal }) => workspacesApi.list({ limit: 50 }, signal),
    enabled: Boolean(canReadJourneys && selectedOrganizationId),
  });

  const workspaces = workspacesData?.data ?? [];
  const workspaceMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));

  // Filters
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  // Journeys list query
  const {
    data: journeysData,
    isLoading: isJourneysLoading,
    refetch: refetchJourneys,
  } = useQuery({
    queryKey: [
      'journeys',
      'list',
      selectedOrganizationId,
      selectedWorkspaceId,
      selectedStatus,
      searchQuery,
      workspaces.map((w) => w.id).join(','),
    ],
    queryFn: async ({ signal }) => {
      const statusParam = selectedStatus === 'all' ? undefined : selectedStatus;
      const queryParam = searchQuery || undefined;

      if (selectedWorkspaceId !== 'all') {
        return journeysApi.list(
          selectedWorkspaceId,
          { status: statusParam, query: queryParam },
          signal,
        );
      }

      if (workspaces.length === 0) {
        return { data: [], page: { hasMore: false, nextCursor: null, limit: 50 } };
      }

      const results = await Promise.all(
        workspaces.map((ws) =>
          journeysApi.list(ws.id, { status: statusParam, query: queryParam }, signal),
        ),
      );

      return {
        data: results.flatMap((r) => r.data),
        page: { hasMore: false, nextCursor: null, limit: 50 },
      };
    },
    enabled: Boolean(canReadJourneys && selectedOrganizationId),
  });

  const journeys: readonly JourneyRecord[] = journeysData?.data ?? [];
  const kpis = calculateJourneyKPIs(journeys);

  if (!canReadJourneys) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-300">
        <h2 className="font-semibold text-rose-200">Access Denied</h2>
        <p className="mt-1">
          You do not hold permissions to view automated journeys in this organization.
        </p>
      </div>
    );
  }

  if (!selectedOrganizationId) {
    return (
      <div className="rounded-xl border border-acc-border bg-acc-surface p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-acc-text-primary">
          Organization Context Required
        </h2>
        <p className="mt-1 text-xs text-acc-text-secondary">
          Please select an organization from the header switcher to view its journeys.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Directory Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-acc-border pb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-acc-text-primary">
            Automated Journeys
          </h1>
          <p className="mt-1 text-xs text-acc-text-secondary">
            Multi-step event-driven communication flows, conditional branching, and channel
            orchestrations.
          </p>
        </div>

        {canManageJourneys && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-acc-accent px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-acc-accent-hover focus:outline-hidden"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M12 4v16m8-8H4"
              />
            </svg>
            Create Journey
          </button>
        )}
      </div>

      {/* KPI Tiles */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <StatCard label="Total Journeys" value={kpis.totalJourneys} />
        <StatCard label="Active" value={kpis.activeCount} />
        <StatCard label="Draft" value={kpis.draftCount} />
        <StatCard label="Paused" value={kpis.pausedCount} />
        <StatCard label="Archived" value={kpis.archivedCount} />
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-acc-border bg-acc-surface p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Workspace Filter */}
          <div>
            <label htmlFor="filter-workspace" className="sr-only">
              Filter by Workspace
            </label>
            <select
              id="filter-workspace"
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="rounded-lg border border-acc-border bg-acc-surface-raised px-3 py-1.5 text-xs text-acc-text-primary focus:border-acc-accent focus:outline-hidden"
            >
              <option value="all">All Workspaces ({workspaces.length})</option>
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div>
            <label htmlFor="filter-status" className="sr-only">
              Filter by Status
            </label>
            <select
              id="filter-status"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="rounded-lg border border-acc-border bg-acc-surface-raised px-3 py-1.5 text-xs text-acc-text-primary capitalize focus:border-acc-accent focus:outline-hidden"
            >
              <option value="all">All Statuses</option>
              {JOURNEY_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st.charAt(0).toUpperCase() + st.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Search Input */}
        <div className="w-full sm:w-64">
          <label htmlFor="search-journeys" className="sr-only">
            Search journeys
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-acc-text-secondary">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </span>
            <input
              id="search-journeys"
              type="text"
              placeholder="Search by name…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="block w-full rounded-lg border border-acc-border bg-acc-surface-raised py-1.5 pl-9 pr-3 text-xs text-acc-text-primary placeholder:text-acc-text-tertiary focus:border-acc-accent focus:outline-hidden"
            />
          </div>
        </div>
      </div>

      {/* Journeys Data Table */}
      {isJourneysLoading ? (
        <div
          role="status"
          className="flex h-64 items-center justify-center rounded-xl border border-acc-border bg-acc-surface"
        >
          <p className="text-xs text-acc-text-secondary animate-pulse">Loading journeys…</p>
        </div>
      ) : journeys.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-acc-border bg-acc-surface/50 p-12 text-center">
          <svg
            className="h-10 w-10 text-acc-text-tertiary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <h3 className="mt-3 text-sm font-semibold text-acc-text-primary">No journeys found</h3>
          <p className="mt-1 max-w-sm text-xs text-acc-text-secondary">
            {searchQuery || selectedStatus !== 'all' || selectedWorkspaceId !== 'all'
              ? 'Try adjusting your search query or filters to find matching journeys.'
              : 'Create your first journey to automate communications triggered by contact behaviors and events.'}
          </p>
          {canManageJourneys && (
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-acc-accent px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-acc-accent-hover"
            >
              + Create Journey
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-acc-border bg-acc-surface shadow-xs">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-acc-border bg-acc-surface-raised/50 text-[11px] uppercase tracking-wider text-acc-text-secondary">
              <tr>
                <th scope="col" className="px-4 py-3.5">
                  Name
                </th>
                <th scope="col" className="px-4 py-3.5">
                  Status
                </th>
                <th scope="col" className="px-4 py-3.5">
                  Trigger
                </th>
                <th scope="col" className="px-4 py-3.5">
                  Workspace
                </th>
                <th scope="col" className="px-4 py-3.5">
                  Version
                </th>
                <th scope="col" className="px-4 py-3.5">
                  Updated
                </th>
                <th scope="col" className="px-4 py-3.5 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-acc-border font-sans">
              {journeys.map((j) => (
                <tr key={j.id} className="hover:bg-acc-surface-raised/40 transition-colors">
                  <td className="px-4 py-3.5">
                    <Link
                      href={`/journeys/${j.id}?workspaceId=${j.workspaceId}`}
                      className="font-semibold text-acc-text-primary hover:text-acc-accent hover:underline"
                    >
                      {j.name}
                    </Link>
                    {j.description && (
                      <p className="mt-0.5 line-clamp-1 max-w-md text-[11px] text-acc-text-secondary">
                        {j.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    <JourneyStatusBadge status={j.status} />
                  </td>
                  <td className="px-4 py-3.5">
                    <JourneyTriggerBadge trigger={j.trigger} />
                  </td>
                  <td className="px-4 py-3.5 text-acc-text-secondary">
                    {workspaceMap.get(j.workspaceId) || j.workspaceId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3.5 font-mono text-[11px] text-acc-text-secondary">
                    {j.activeVersionId ? (
                      <div className="flex flex-col">
                        <span className="font-semibold text-emerald-400">
                          {j.latestPublishedVersion?.id === j.activeVersionId
                            ? `v${j.latestPublishedVersion.versionNumber} (Active)`
                            : 'Active'}
                        </span>
                        {j.activatedAt && (
                          <span className="text-[10px] text-acc-text-tertiary">
                            {new Date(j.activatedAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    ) : j.latestPublishedVersion ? (
                      `v${j.latestPublishedVersion.versionNumber}`
                    ) : j.draftVersion ? (
                      `v${j.draftVersion.versionNumber} (Draft)`
                    ) : (
                      'Draft'
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-acc-text-secondary">
                    {new Date(j.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <Link
                      href={`/journeys/${j.id}?workspaceId=${j.workspaceId}`}
                      className="rounded-md border border-acc-border px-3 py-1 text-[11px] font-medium text-acc-text-primary hover:bg-acc-surface-raised"
                    >
                      Open Builder →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Creation Modal */}
      <JourneyCreateDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        workspaces={workspaces}
        defaultWorkspaceId={selectedWorkspaceId !== 'all' ? selectedWorkspaceId : undefined}
        onCreated={() => {
          void refetchJourneys();
        }}
      />
    </div>
  );
}
