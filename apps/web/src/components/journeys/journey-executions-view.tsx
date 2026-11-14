'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { journeysApi } from '@/lib/api-client';
import {
  ALL_JOURNEY_EXECUTION_STATUSES,
  formatStepDetails,
  getNodeTypeLabel,
  getStepOutcomeLabel,
  getTriggerKindLabel,
  type JourneyExecutionRecord,
  type JourneyExecutionStepRecord,
  type JourneyNodeType,
} from '@/lib/journeys';
import { JourneyExecutionStatusBadge } from './journey-status-badge';
import { Drawer } from '@/components/ui/drawer';
import { useCanManageJourneys } from '@/lib/session-store';
import { toast } from '@/lib/toast';

export interface JourneyExecutionsViewProps {
  readonly workspaceId: string;
  readonly journeyId: string;
}

export function JourneyExecutionsView({ workspaceId, journeyId }: JourneyExecutionsViewProps) {
  const queryClient = useQueryClient();
  const canManage = useCanManageJourneys();
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedExecution, setSelectedExecution] = useState<JourneyExecutionRecord | null>(null);
  const [isCancellingId, setIsCancellingId] = useState<string | null>(null);

  const { data: executionsData, isLoading } = useQuery({
    queryKey: ['journeys', workspaceId, journeyId, 'executions', { status: selectedStatus }],
    queryFn: async ({ signal }) => {
      try {
        const params = selectedStatus === 'all' ? undefined : { status: selectedStatus };
        return await journeysApi.listExecutions(workspaceId, journeyId, params, signal);
      } catch (_err) {
        // Return empty on 404 / 501 when 8C-2 runtime endpoint is awaiting deployment
        return { data: [], total: 0 };
      }
    },
    refetchInterval: 10000,
  });

  const executions: readonly JourneyExecutionRecord[] = executionsData?.data ?? [];

  // Query execution steps when execution drawer is open
  const { data: stepsData, isLoading: isStepsLoading } = useQuery({
    queryKey: ['journeys', workspaceId, journeyId, 'executions', selectedExecution?.id, 'steps'],
    queryFn: async ({ signal }) => {
      if (!selectedExecution) return [];
      try {
        const res = await journeysApi.getExecution(
          workspaceId,
          journeyId,
          selectedExecution.id,
          signal,
        );
        return res.data?.steps ?? [];
      } catch {
        return [];
      }
    },
    enabled: Boolean(selectedExecution),
  });

  const steps: readonly JourneyExecutionStepRecord[] = stepsData ?? [];

  const handleCancelExecution = async (executionId: string) => {
    if (!canManage || isCancellingId) return;
    setIsCancellingId(executionId);
    try {
      await journeysApi.cancelExecution(workspaceId, journeyId, executionId);
      toast.success('Execution cancelled by operator.');
      await queryClient.invalidateQueries({
        queryKey: ['journeys', workspaceId, journeyId, 'executions'],
      });
      if (selectedExecution?.id === executionId) {
        setSelectedExecution((prev) =>
          prev
            ? {
                ...prev,
                status: 'cancelled',
                endReason: 'operator_cancelled',
                endedAt: new Date().toISOString(),
              }
            : null,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to cancel execution.';
      toast.error(msg);
    } finally {
      setIsCancellingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* 8C-2 Handover Note */}
      <div className="flex items-center justify-between rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-300">
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
              clipRule="evenodd"
            />
          </svg>
          <span>
            <strong>Phase 8C-2 Coordinated Explorer:</strong> Real-time event triggers and queue
            execution histories stream directly from the workflow orchestrator.
          </span>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-acc-border pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSelectedStatus('all')}
            className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
              selectedStatus === 'all'
                ? 'bg-acc-accent text-white'
                : 'bg-acc-surface-raised text-acc-text-secondary hover:text-acc-text-primary'
            }`}
          >
            All Executions ({executions.length})
          </button>
          {ALL_JOURNEY_EXECUTION_STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setSelectedStatus(st)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                selectedStatus === st
                  ? 'bg-acc-accent text-white'
                  : 'bg-acc-surface-raised text-acc-text-secondary hover:text-acc-text-primary'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* Table / Empty State */}
      {isLoading ? (
        <div
          role="status"
          className="flex h-48 items-center justify-center rounded-xl border border-acc-border bg-acc-surface"
        >
          <p className="text-xs text-acc-text-secondary animate-pulse">Loading execution traces…</p>
        </div>
      ) : executions.length === 0 ? (
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
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          <h3 className="mt-3 text-sm font-semibold text-acc-text-primary">No Executions Found</h3>
          <p className="mt-1 max-w-sm text-xs text-acc-text-secondary">
            {selectedStatus === 'all'
              ? 'When the journey is activated, contacts entering via event triggers or segments will appear here.'
              : `No executions currently in "${selectedStatus}" state.`}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-acc-border bg-acc-surface">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-acc-border bg-acc-surface-raised/50 text-[11px] uppercase tracking-wider text-acc-text-secondary">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Contact
                </th>
                <th scope="col" className="px-4 py-3">
                  Status
                </th>
                <th scope="col" className="px-4 py-3">
                  Current Step
                </th>
                <th scope="col" className="px-4 py-3">
                  Version
                </th>
                <th scope="col" className="px-4 py-3">
                  Entered At
                </th>
                <th scope="col" className="px-4 py-3">
                  Transitions
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-acc-border font-sans">
              {executions.map((exec) => (
                <tr key={exec.id} className="hover:bg-acc-surface-raised/40 transition-colors">
                  <td className="px-4 py-3 font-medium text-acc-text-primary">
                    <p className="font-mono text-xs">{exec.contactId}</p>
                    <p className="font-mono text-[10px] text-acc-text-secondary">
                      Trigger: {getTriggerKindLabel(exec.entryKind)}
                      {exec.enrolledBy ? ` (${exec.enrolledBy})` : ''}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <JourneyExecutionStatusBadge status={exec.status} />
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-acc-text-secondary">
                    {exec.currentNodeKey ? exec.currentNodeKey : '(Completed / Exited)'}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px]" title={exec.journeyVersionId}>
                    v{exec.journeyVersionId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 text-acc-text-secondary">
                    {new Date(exec.enteredAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono">{exec.transitions}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {canManage && (exec.status === 'running' || exec.status === 'waiting') && (
                        <button
                          type="button"
                          onClick={() => handleCancelExecution(exec.id)}
                          disabled={isCancellingId === exec.id}
                          className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                        >
                          {isCancellingId === exec.id ? 'Cancelling…' : 'Cancel'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedExecution(exec)}
                        className="rounded-md border border-acc-border px-2.5 py-1 text-[11px] font-medium text-acc-accent hover:bg-acc-surface-raised"
                      >
                        View Steps
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Step History Drawer */}
      <Drawer
        isOpen={Boolean(selectedExecution)}
        onClose={() => setSelectedExecution(null)}
        titleId="execution-timeline-title"
        width="max-w-lg"
      >
        {selectedExecution && (
          <div className="flex h-full w-full flex-col text-acc-text-primary">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-acc-border pb-4">
              <div>
                <h3 id="execution-timeline-title" className="text-base font-semibold">
                  Execution Timeline
                </h3>
                <p className="font-mono text-xs text-acc-text-secondary">
                  Execution ID: {selectedExecution.id}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedExecution(null)}
                className="rounded-lg p-1.5 text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary"
                aria-label="Close step drawer"
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

            {/* Execution Metadata */}
            <div className="my-4 space-y-3 rounded-lg border border-acc-border bg-acc-surface-raised/40 p-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-acc-text-secondary">Status:</span>
                  <div className="mt-1">
                    <JourneyExecutionStatusBadge status={selectedExecution.status} />
                  </div>
                </div>
                <div>
                  <span className="text-acc-text-secondary">Version:</span>
                  <p
                    className="mt-1 font-mono font-semibold"
                    title={selectedExecution.journeyVersionId}
                  >
                    v{selectedExecution.journeyVersionId.slice(0, 8)}
                  </p>
                </div>
                <div>
                  <span className="text-acc-text-secondary">Entered:</span>
                  <p className="mt-1 text-[11px] text-acc-text-primary">
                    {new Date(selectedExecution.enteredAt).toLocaleString()}
                  </p>
                </div>
                <div>
                  <span className="text-acc-text-secondary">Ended:</span>
                  <p className="mt-1 text-[11px] text-acc-text-primary">
                    {selectedExecution.endedAt
                      ? new Date(selectedExecution.endedAt).toLocaleString()
                      : 'Still In Flight'}
                  </p>
                </div>
                <div className="col-span-2">
                  <span className="text-acc-text-secondary">Trigger:</span>
                  <p className="mt-1 text-[11px] font-mono text-acc-text-primary">
                    {getTriggerKindLabel(selectedExecution.entryKind)}
                    {selectedExecution.enrolledBy
                      ? ` (Enrolled by: ${selectedExecution.enrolledBy})`
                      : ''}
                  </p>
                </div>
              </div>

              {selectedExecution.endReason && (
                <div className="border-t border-acc-border/60 pt-2 text-[11px]">
                  <span className="text-acc-text-secondary">End Reason: </span>
                  <span className="font-mono text-acc-text-primary">
                    {selectedExecution.endReason}
                  </span>
                </div>
              )}

              {canManage &&
                (selectedExecution.status === 'running' ||
                  selectedExecution.status === 'waiting') && (
                  <div className="border-t border-acc-border/60 pt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => handleCancelExecution(selectedExecution.id)}
                      disabled={isCancellingId === selectedExecution.id}
                      className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                    >
                      {isCancellingId === selectedExecution.id
                        ? 'Cancelling Execution…'
                        : 'Cancel Execution (Operator)'}
                    </button>
                  </div>
                )}
            </div>

            {/* Steps Timeline List */}
            <div className="flex-1 overflow-y-auto space-y-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-acc-text-secondary">
                Step Sequence ({steps.length})
              </h4>

              {isStepsLoading ? (
                <p role="status" className="text-xs text-acc-text-secondary animate-pulse">
                  Loading step details…
                </p>
              ) : steps.length === 0 ? (
                <p className="text-xs text-acc-text-secondary italic">
                  No step records recorded yet.
                </p>
              ) : (
                <div className="relative border-l border-acc-border/80 pl-4 space-y-4 ml-2">
                  {steps.map((st) => (
                    <div key={`${st.seq}-${st.nodeKey}`} className="relative group">
                      <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border border-acc-accent bg-acc-surface" />
                      <div className="rounded-lg border border-acc-border bg-acc-surface-raised/40 p-3 text-xs space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-acc-text-primary">
                            #{st.seq} {st.nodeKey}
                          </span>
                          <span
                            className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase font-semibold ${
                              st.outcome === 'completed'
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : st.outcome === 'failed'
                                  ? 'bg-red-500/10 text-red-400'
                                  : 'bg-amber-500/10 text-amber-400'
                            }`}
                          >
                            {getStepOutcomeLabel(st.outcome)}
                          </span>
                        </div>
                        <p className="text-[11px] text-acc-text-secondary">
                          {getNodeTypeLabel(st.nodeType as JourneyNodeType)} · Attempt #{st.attempt}
                        </p>
                        {st.messageId && (
                          <p className="font-mono text-[10px] text-sky-400">
                            Dispatched Message: {st.messageId}
                          </p>
                        )}
                        {st.errorCode && (
                          <p className="font-mono text-[10px] text-red-400">
                            Error: {st.errorCode}
                          </p>
                        )}
                        {formatStepDetails(st.details) && (
                          <p className="font-medium text-[11px] text-acc-accent">
                            {formatStepDetails(st.details)}
                          </p>
                        )}
                        {st.details && Object.keys(st.details).length > 0 && (
                          <details className="mt-1">
                            <summary className="text-[10px] text-acc-text-tertiary cursor-pointer hover:text-acc-text-secondary">
                              Step Details
                            </summary>
                            <pre className="mt-1 max-h-24 overflow-auto rounded bg-acc-surface p-1.5 font-mono text-[10px] text-acc-text-secondary">
                              {JSON.stringify(st.details, null, 2)}
                            </pre>
                          </details>
                        )}
                        <p className="text-[10px] text-acc-text-secondary">
                          {new Date(st.startedAt).toLocaleTimeString()}
                          {st.finishedAt
                            ? ` → ${new Date(st.finishedAt).toLocaleTimeString()}`
                            : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
