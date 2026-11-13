'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { journeysApi } from '@/lib/api-client';
import { type JourneyRecord, type JourneyVersionRecord } from '@/lib/journeys';
import { useCanManageJourneys } from '@/lib/session-store';
import { toast } from '@/lib/toast';
import { JourneyStatusBadge } from './journey-status-badge';
import { JourneyGraphEditor } from './journey-graph-editor';
import { JourneyExecutionsView } from './journey-executions-view';
import { JourneyNodeStatisticsView } from './journey-node-statistics-view';
import { JourneyVersionsView } from './journey-versions-view';

export interface JourneyDetailViewProps {
  readonly journey: JourneyRecord;
  readonly workspaceName?: string;
}

export type JourneyDetailTab = 'builder' | 'statistics' | 'executions' | 'versions';

export function JourneyDetailView({
  journey: initialJourney,
  workspaceName,
}: JourneyDetailViewProps) {
  const queryClient = useQueryClient();
  const canManage = useCanManageJourneys();
  const [activeTab, setActiveTab] = useState<JourneyDetailTab>('builder');
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Poll journey state
  const { data: journeyData } = useQuery({
    queryKey: ['journeys', initialJourney.workspaceId, initialJourney.id],
    queryFn: ({ signal }) => journeysApi.get(initialJourney.workspaceId, initialJourney.id, signal),
    initialData: { data: initialJourney },
  });

  const journey = journeyData?.data ?? initialJourney;

  // Fetch current version (draft or latest published)
  const {
    data: versionData,
    isLoading: isVersionLoading,
    refetch: refetchVersion,
  } = useQuery({
    queryKey: ['journeys', journey.workspaceId, journey.id, 'current-version'],
    queryFn: async ({ signal }) => {
      let targetVersionId = journey.draftVersion?.id || journey.latestPublishedVersion?.id;
      if (!targetVersionId) {
        const list = await journeysApi.listVersions(journey.workspaceId, journey.id, signal);
        const candidate =
          list.data.find((v) => v.status === 'draft') ||
          list.data.find((v) => v.status === 'published') ||
          list.data[0];
        targetVersionId = candidate?.id;
      }

      if (!targetVersionId) return null;
      return journeysApi.getVersion(journey.workspaceId, journey.id, targetVersionId, signal);
    },
  });

  const currentVersion: JourneyVersionRecord | null = versionData?.data ?? null;

  const handleLifecycleAction = async (action: 'activate' | 'pause' | 'resume' | 'archive') => {
    if (!canManage || isTransitioning) return;
    setIsTransitioning(true);
    try {
      if (action === 'activate') {
        if (!journey.latestPublishedVersion && currentVersion?.status === 'draft') {
          toast.error('Please publish a journey version before activating.');
          return;
        }
        await journeysApi.activate(journey.workspaceId, journey.id);
        toast.success('Journey activated.');
      } else if (action === 'pause') {
        await journeysApi.pause(journey.workspaceId, journey.id);
        toast.success('Journey paused.');
      } else if (action === 'resume') {
        await journeysApi.resume(journey.workspaceId, journey.id);
        toast.success('Journey resumed.');
      } else if (action === 'archive') {
        await journeysApi.archive(journey.workspaceId, journey.id);
        toast.success('Journey archived.');
      }
      await queryClient.invalidateQueries({
        queryKey: ['journeys', journey.workspaceId, journey.id],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed to ${action} journey.`;
      toast.error(msg);
    } finally {
      setIsTransitioning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-acc-border pb-6">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-acc-text-primary">
              {journey.name}
            </h1>
            <JourneyStatusBadge status={journey.status} />
            {currentVersion && (
              <span className="flex items-center gap-1.5 rounded-full border border-acc-border bg-acc-surface-raised px-2.5 py-0.5 text-xs font-mono text-acc-text-secondary">
                v{currentVersion.versionNumber} ({currentVersion.status})
              </span>
            )}
            {workspaceName && (
              <span className="rounded-md border border-acc-border/60 bg-acc-surface px-2 py-0.5 text-xs text-acc-text-secondary">
                {workspaceName}
              </span>
            )}
          </div>
          {journey.description && (
            <p className="mt-2 text-xs text-acc-text-secondary max-w-2xl">{journey.description}</p>
          )}
        </div>

        {/* Lifecycle Actions */}
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {journey.status === 'draft' && (
              <button
                type="button"
                onClick={() => handleLifecycleAction('activate')}
                disabled={isTransitioning}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-500 focus:outline-hidden disabled:opacity-50"
              >
                Activate Journey
              </button>
            )}

            {journey.status === 'active' && (
              <button
                type="button"
                onClick={() => handleLifecycleAction('pause')}
                disabled={isTransitioning}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-1.5 text-xs font-semibold text-amber-400 hover:bg-amber-500/20 focus:outline-hidden disabled:opacity-50"
              >
                Pause Journey
              </button>
            )}

            {journey.status === 'paused' && (
              <button
                type="button"
                onClick={() => handleLifecycleAction('resume')}
                disabled={isTransitioning}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-500 focus:outline-hidden disabled:opacity-50"
              >
                Resume Journey
              </button>
            )}

            {journey.status !== 'archived' && (
              <button
                type="button"
                onClick={() => handleLifecycleAction('archive')}
                disabled={isTransitioning}
                className="inline-flex items-center gap-1.5 rounded-lg border border-acc-border bg-acc-surface-raised px-3 py-1.5 text-xs font-medium text-acc-text-secondary hover:text-acc-text-primary focus:outline-hidden disabled:opacity-50"
              >
                Archive
              </button>
            )}
          </div>
        )}
      </header>

      {/* Tabs */}
      <div className="border-b border-acc-border">
        <nav className="-mb-px flex space-x-6" aria-label="Journey Tabs">
          {[
            { id: 'builder', label: 'Graph Builder' },
            { id: 'statistics', label: 'Statistics & Funnel' },
            { id: 'executions', label: 'Executions' },
            { id: 'versions', label: 'Versions & History' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as JourneyDetailTab)}
              className={`pb-3 text-xs font-semibold transition-colors border-b-2 ${
                activeTab === tab.id
                  ? 'border-acc-accent text-acc-text-primary'
                  : 'border-transparent text-acc-text-secondary hover:text-acc-text-primary hover:border-acc-border'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Panels */}
      <div>
        {activeTab === 'builder' && (
          <div>
            {isVersionLoading ? (
              <div
                role="status"
                className="flex h-96 items-center justify-center rounded-xl border border-acc-border bg-acc-surface"
              >
                <p className="text-xs text-acc-text-secondary animate-pulse">
                  Loading journey graph…
                </p>
              </div>
            ) : currentVersion ? (
              <JourneyGraphEditor
                workspaceId={journey.workspaceId}
                journeyId={journey.id}
                versionId={currentVersion.id}
                initialGraph={currentVersion.graph}
                initialGraphSha256={currentVersion.graphSha256}
                versionStatus={currentVersion.status}
                readOnly={journey.status === 'archived'}
                canManage={canManage}
                onSaved={() => {
                  void refetchVersion();
                  void queryClient.invalidateQueries({
                    queryKey: ['journeys', journey.workspaceId, journey.id],
                  });
                }}
                onPublished={() => {
                  void refetchVersion();
                  void queryClient.invalidateQueries({
                    queryKey: ['journeys', journey.workspaceId, journey.id],
                  });
                }}
              />
            ) : (
              <div className="p-8 text-center text-xs text-acc-text-secondary">
                No active or draft version found. Initialize one in the Versions tab.
              </div>
            )}
          </div>
        )}

        {activeTab === 'statistics' && (
          <div>
            {currentVersion ? (
              <JourneyNodeStatisticsView
                workspaceId={journey.workspaceId}
                journeyId={journey.id}
                graph={currentVersion.graph}
              />
            ) : (
              <p className="text-xs text-acc-text-secondary">No graph version loaded.</p>
            )}
          </div>
        )}

        {activeTab === 'executions' && (
          <div>
            <JourneyExecutionsView workspaceId={journey.workspaceId} journeyId={journey.id} />
          </div>
        )}

        {activeTab === 'versions' && (
          <div>
            <JourneyVersionsView
              workspaceId={journey.workspaceId}
              journeyId={journey.id}
              canManage={canManage}
              onSelectVersion={() => {
                void refetchVersion();
                setActiveTab('builder');
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
