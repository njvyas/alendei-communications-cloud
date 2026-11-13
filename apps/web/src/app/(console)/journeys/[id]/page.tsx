'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { journeysApi, workspacesApi } from '@/lib/api-client';
import { useCanReadJourneys, useSession } from '@/lib/session-store';
import { JourneyDetailView } from '@/components/journeys/journey-detail-view';

interface JourneyDetailPageProps {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{ readonly workspaceId?: string }>;
}

export default function JourneyDetailPage({ params, searchParams }: JourneyDetailPageProps) {
  const { id } = use(params);
  const { workspaceId: queryWorkspaceId } = use(searchParams);
  const canReadJourneys = useCanReadJourneys();
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);

  // Fetch workspaces for this organization
  const { data: workspacesData } = useQuery({
    queryKey: ['workspaces', 'list', selectedOrganizationId, { limit: 50 }],
    queryFn: ({ signal }) => workspacesApi.list({ limit: 50 }, signal),
    enabled: Boolean(canReadJourneys && selectedOrganizationId),
  });

  const workspaces = workspacesData?.data ?? [];

  // Fetch journey: use workspaceId from query if provided, or search through available workspaces
  const {
    data: journeyData,
    isLoading: isJourneyLoading,
    error,
  } = useQuery({
    queryKey: ['journeys', 'detail', selectedOrganizationId, id, queryWorkspaceId],
    queryFn: async ({ signal }) => {
      if (queryWorkspaceId) {
        return journeysApi.get(queryWorkspaceId, id, signal);
      }
      for (const ws of workspaces) {
        try {
          const res = await journeysApi.get(ws.id, id, signal);
          if (res?.data) return res;
        } catch {
          // Continue searching remaining workspaces
        }
      }
      throw new Error('Journey not found in available workspaces.');
    },
    enabled: Boolean(
      canReadJourneys && selectedOrganizationId && (queryWorkspaceId || workspaces.length > 0),
    ),
  });

  const journey = journeyData?.data;
  const workspace = workspaces.find((ws) => ws.id === journey?.workspaceId);

  if (!canReadJourneys) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-300">
        <h2 className="font-semibold text-rose-200">Access Denied</h2>
        <p className="mt-1">You do not hold permissions to view journeys in this organization.</p>
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
          Please select an organization from the header switcher to view journey details.
        </p>
      </div>
    );
  }

  if (isJourneyLoading) {
    return (
      <div className="space-y-6">
        <div className="h-5 w-32 animate-pulse rounded bg-acc-surface-raised" />
        <div className="h-10 w-64 animate-pulse rounded bg-acc-surface-raised" />
        <div className="h-96 animate-pulse rounded-xl bg-acc-surface-raised" />
      </div>
    );
  }

  if (error || !journey) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-8 text-center">
        <h2 className="text-base font-semibold text-red-300">Journey Not Found</h2>
        <p className="mt-1 text-xs text-red-400">
          The requested journey does not exist, or you lack permissions to view it in this
          organization.
        </p>
        <Link
          href="/journeys"
          className="mt-4 inline-block rounded-lg border border-acc-border bg-acc-surface-raised px-4 py-1.5 text-xs font-semibold text-acc-text-primary hover:bg-acc-surface-raised/80"
        >
          ← Back to Journeys
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-acc-text-secondary">
        <Link href="/journeys" className="hover:text-acc-text-primary hover:underline">
          Journeys
        </Link>
        <span>/</span>
        <span className="truncate font-medium text-acc-text-primary">{journey.name}</span>
      </div>

      <JourneyDetailView journey={journey} workspaceName={workspace?.name} />
    </div>
  );
}
