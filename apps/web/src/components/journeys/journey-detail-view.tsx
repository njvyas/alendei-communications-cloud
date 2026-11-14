'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { journeysApi } from '@/lib/api-client';
import {
  formatTriggerSummary,
  JOURNEY_ENROLMENT_LIMITS,
  type JourneyEnrolmentResult,
  type JourneyRecord,
  type JourneyVersionRecord,
} from '@/lib/journeys';
import { useCanManageJourneys } from '@/lib/session-store';
import { toast } from '@/lib/toast';
import { JourneyStatusBadge, JourneyTriggerBadge } from './journey-status-badge';
import { JourneyGraphEditor } from './journey-graph-editor';
import { JourneyExecutionsView } from './journey-executions-view';
import { JourneyNodeStatisticsView } from './journey-node-statistics-view';
import { JourneyVersionsView } from './journey-versions-view';
import { AccessibleDialog } from '@/components/ui/dialog';

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
  const [isEnrolOpen, setIsEnrolOpen] = useState(false);
  const [contactIdsText, setContactIdsText] = useState('');
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [enrolResult, setEnrolResult] = useState<JourneyEnrolmentResult | null>(null);
  // Stable Idempotency-Key per enrolment attempt; preserved across network retry attempts
  const [enrolIdempotencyKey, setEnrolIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const handleCloseEnrol = () => {
    setIsEnrolOpen(false);
    setEnrolResult(null);
    setContactIdsText('');
    setEnrolIdempotencyKey(crypto.randomUUID());
  };

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

  const handleEnrol = async () => {
    if (!contactIdsText.trim() || isEnrolling) return;
    setIsEnrolling(true);
    setEnrolResult(null);
    try {
      const ids = [
        ...new Set(
          contactIdsText
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      if (ids.length === 0) {
        toast.error('Please enter at least one contact ID.');
        return;
      }
      if (ids.length > JOURNEY_ENROLMENT_LIMITS.maxContactsPerCall) {
        toast.error(
          `Exceeded maximum limit of ${JOURNEY_ENROLMENT_LIMITS.maxContactsPerCall} contacts per call.`,
        );
        return;
      }
      const res = await journeysApi.enrolContacts(
        journey.workspaceId,
        journey.id,
        {
          contactIds: ids,
        },
        enrolIdempotencyKey,
      );
      setEnrolResult(res.data);
      toast.success(
        `Enrolled ${res.data.enrolled} contacts (${res.data.alreadyEnrolled} already enrolled, ${res.data.contactNotFound} not found).`,
      );
      await queryClient.invalidateQueries({
        queryKey: ['journeys', journey.workspaceId, journey.id, 'executions'],
      });
      await queryClient.invalidateQueries({
        queryKey: ['journeys', journey.workspaceId, journey.id, 'stats'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to enrol contacts.';
      toast.error(msg);
    } finally {
      setIsEnrolling(false);
    }
  };

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
      <header className="border-b border-acc-border pb-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
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
              <p className="mt-2 text-xs text-acc-text-secondary max-w-2xl">
                {journey.description}
              </p>
            )}
          </div>

          {/* Lifecycle & Enrol Actions */}
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              {journey.status === 'active' && journey.trigger?.kind === 'api' && (
                <button
                  type="button"
                  onClick={() => {
                    setEnrolResult(null);
                    setContactIdsText('');
                    setIsEnrolOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3.5 py-1.5 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/20 focus:outline-hidden"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  Enrol Contacts
                </button>
              )}

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
        </div>

        {/* Additive 8C-2 Metadata Bar: Trigger & Active Version */}
        <div className="flex flex-wrap items-center gap-4 text-xs text-acc-text-secondary bg-acc-surface-raised/40 rounded-lg p-3 border border-acc-border/60">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-acc-text-tertiary uppercase tracking-wider">
              Trigger:
            </span>
            <JourneyTriggerBadge trigger={journey.trigger} />
            <span className="font-mono text-[11px] text-acc-text-secondary">
              {formatTriggerSummary(journey.trigger)}
            </span>
          </div>

          {journey.activeVersionId && (
            <div className="flex items-center gap-2 border-l border-acc-border/60 pl-4">
              <span className="text-[11px] font-semibold text-acc-text-tertiary uppercase tracking-wider">
                Active Version:
              </span>
              <span className="font-mono font-medium text-emerald-400">
                {journey.latestPublishedVersion?.id === journey.activeVersionId
                  ? `v${journey.latestPublishedVersion.versionNumber}`
                  : 'Active'}
              </span>
              {journey.activatedAt && (
                <span className="text-[11px] text-acc-text-tertiary">
                  (Activated {new Date(journey.activatedAt).toLocaleString()}
                  {journey.activatedBy ? ` by ${journey.activatedBy}` : ''})
                </span>
              )}
            </div>
          )}
        </div>
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
              activeVersionId={journey.activeVersionId}
              canManage={canManage}
              onSelectVersion={() => {
                void refetchVersion();
                setActiveTab('builder');
              }}
            />
          </div>
        )}
      </div>

      {/* Enrol Contacts Dialog (Phase 8C-2 API Trigger) */}
      <AccessibleDialog
        isOpen={isEnrolOpen}
        onClose={handleCloseEnrol}
        titleId="enrol-contacts-title"
        descriptionId="enrol-contacts-description"
        maxWidth="max-w-md"
        dismissible={!isEnrolling}
      >
        <div className="flex items-center justify-between border-b border-acc-border pb-3">
          <div>
            <h3 id="enrol-contacts-title" className="text-base font-semibold text-acc-text-primary">
              Enrol Contacts
            </h3>
            <p id="enrol-contacts-description" className="mt-0.5 text-xs text-acc-text-secondary">
              Enter contact IDs to initiate executions through this journey&apos;s API trigger.
            </p>
          </div>
          <button
            type="button"
            onClick={handleCloseEnrol}
            className="rounded-lg p-1.5 text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary"
            aria-label="Close enrolment dialog"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="mt-4 space-y-4 text-xs">
          <div>
            <label
              htmlFor="enrol-contact-ids"
              className="block font-medium text-acc-text-primary mb-1"
            >
              Contact IDs (UUIDs, one per line or comma-separated)
            </label>
            <textarea
              id="enrol-contact-ids"
              rows={5}
              placeholder="01900000-0000-7000-8000-000000000001&#10;01900000-0000-7000-8000-000000000002"
              value={contactIdsText}
              onChange={(e) => setContactIdsText(e.target.value)}
              disabled={isEnrolling || Boolean(enrolResult)}
              className="w-full rounded-lg border border-acc-border bg-acc-surface px-3 py-2 font-mono text-xs text-acc-text-primary placeholder:text-acc-text-tertiary focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-acc-text-secondary">
              Entry policy is once per contact. Contacts that have already entered will be recorded
              as already enrolled without creating duplicate executions.
            </p>
          </div>

          {enrolResult && (
            <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3.5 text-indigo-300 space-y-2">
              <h4 className="font-semibold text-xs text-indigo-200">Enrolment Batch Results:</h4>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded border border-indigo-500/20 bg-indigo-500/20 p-2">
                  <p className="text-[10px] uppercase font-semibold text-emerald-400">Enrolled</p>
                  <p className="font-mono text-lg font-bold text-white">{enrolResult.enrolled}</p>
                </div>
                <div className="rounded border border-indigo-500/20 bg-indigo-500/20 p-2">
                  <p className="text-[10px] uppercase font-semibold text-amber-300">
                    Already Enrolled
                  </p>
                  <p className="font-mono text-lg font-bold text-white">
                    {enrolResult.alreadyEnrolled}
                  </p>
                </div>
                <div className="rounded border border-indigo-500/20 bg-indigo-500/20 p-2">
                  <p className="text-[10px] uppercase font-semibold text-red-400">Not Found</p>
                  <p className="font-mono text-lg font-bold text-white">
                    {enrolResult.contactNotFound}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-acc-border pt-4">
          <button
            type="button"
            onClick={handleCloseEnrol}
            className="rounded-lg border border-acc-border bg-acc-surface-raised px-3.5 py-1.5 text-xs font-semibold text-acc-text-secondary hover:text-acc-text-primary"
          >
            {enrolResult ? 'Close' : 'Cancel'}
          </button>
          {!enrolResult && (
            <button
              type="button"
              onClick={handleEnrol}
              disabled={isEnrolling || !contactIdsText.trim()}
              className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-indigo-500 focus:outline-hidden disabled:opacity-50"
            >
              {isEnrolling ? 'Enrolling…' : 'Enrol Contacts'}
            </button>
          )}
        </div>
      </AccessibleDialog>
    </div>
  );
}
