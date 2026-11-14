'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { journeysApi } from '@/lib/api-client';
import {
  getNodeDisplayLabel,
  getNodeTypeLabel,
  getStepOutcomeLabel,
  type JourneyGraph,
  type JourneyNodeStats,
  type JourneyStatsRecord,
  type JourneyStepOutcome,
  type JourneyVersionStats,
} from '@/lib/journeys';
import { JourneyNodeIcon, getNodeTypeColorClass } from './journey-node-icon';

export interface JourneyNodeStatisticsViewProps {
  readonly workspaceId: string;
  readonly journeyId: string;
  readonly graph: JourneyGraph;
  readonly defaultVersionId?: string;
}

export function JourneyNodeStatisticsView({
  workspaceId,
  journeyId,
  graph,
  defaultVersionId,
}: JourneyNodeStatisticsViewProps) {
  const [selectedVersionId, setSelectedVersionId] = useState<string | undefined>(defaultVersionId);

  const { data: statsData, isLoading } = useQuery({
    queryKey: ['journeys', workspaceId, journeyId, 'stats', selectedVersionId],
    queryFn: async ({ signal }) => {
      try {
        const res = await journeysApi.getStats(workspaceId, journeyId, selectedVersionId, signal);
        return res.data;
      } catch {
        return null;
      }
    },
    refetchInterval: 15000,
  });

  const statsRecord: JourneyStatsRecord | null = statsData ?? null;
  const versions: readonly JourneyVersionStats[] = statsRecord?.versions ?? [];

  // Current active version stats
  const activeVersionStats: JourneyVersionStats | null =
    (selectedVersionId ? versions.find((v) => v.versionId === selectedVersionId) : versions[0]) ??
    null;

  const executions = activeVersionStats?.executions;
  const totalExecutions = executions?.total ?? 0;
  const completedExecutions = executions?.completed ?? 0;
  const runningExecutions = executions?.running ?? 0;
  const waitingExecutions = executions?.waiting ?? 0;
  const failedExecutions = executions?.failed ?? 0;

  const nodeStatsMap = new Map<string, JourneyNodeStats>(
    (activeVersionStats?.nodes ?? []).map((n) => [n.nodeKey, n]),
  );

  const overallCompletionRate =
    totalExecutions > 0 ? Math.round((completedExecutions / totalExecutions) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* 8C-2 Telemetry Info Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 text-xs text-indigo-300">
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
              clipRule="evenodd"
            />
          </svg>
          <span>
            <strong>Phase 8C-2 Statistics & Funnel:</strong> Execution totals and per-node step
            outcomes aggregated across published journey versions.
          </span>
        </div>

        {versions.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="stats-version-select" className="text-acc-text-secondary font-medium">
              Version:
            </label>
            <select
              id="stats-version-select"
              value={activeVersionStats?.versionId || ''}
              onChange={(e) => setSelectedVersionId(e.target.value)}
              className="rounded-md border border-acc-border bg-acc-surface px-2.5 py-1 text-xs text-acc-text-primary focus:border-acc-accent focus:outline-hidden"
            >
              {versions.map((v) => (
                <option key={v.versionId} value={v.versionId}>
                  v{v.versionNumber} ({v.executions.total} executions)
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Aggregate KPI Tiles */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-acc-border bg-acc-surface p-4">
          <p className="text-xs text-acc-text-secondary">Total Executions</p>
          <p className="mt-1 font-mono text-2xl font-bold text-acc-text-primary">
            {totalExecutions.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-acc-text-tertiary">Contacts enrolled</p>
        </div>

        <div className="rounded-xl border border-acc-border bg-acc-surface p-4">
          <p className="text-xs text-acc-text-secondary">Completed Flow</p>
          <p className="mt-1 font-mono text-2xl font-bold text-emerald-400">
            {completedExecutions.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-acc-text-tertiary">
            {overallCompletionRate}% completion rate
          </p>
        </div>

        <div className="rounded-xl border border-acc-border bg-acc-surface p-4">
          <p className="text-xs text-acc-text-secondary">In Flight (Running/Waiting)</p>
          <p className="mt-1 font-mono text-2xl font-bold text-amber-400">
            {(runningExecutions + waitingExecutions).toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-acc-text-tertiary">
            {runningExecutions} running · {waitingExecutions} in delay
          </p>
        </div>

        <div className="rounded-xl border border-acc-border bg-acc-surface p-4">
          <p className="text-xs text-acc-text-secondary">Failed Executions</p>
          <p className="mt-1 font-mono text-2xl font-bold text-red-400">
            {failedExecutions.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-acc-text-tertiary">Terminal error state</p>
        </div>
      </div>

      {/* Per-Node Funnel Breakdown */}
      <div className="rounded-xl border border-acc-border bg-acc-surface p-5">
        <h3 className="text-sm font-semibold text-acc-text-primary">Node Funnel & Throughput</h3>
        <p className="text-xs text-acc-text-secondary mt-0.5">
          Live executions positioned at each step and historical step outcome distributions.
        </p>

        {isLoading ? (
          <p
            role="status"
            className="py-8 text-center text-xs text-acc-text-secondary animate-pulse"
          >
            Loading metrics…
          </p>
        ) : !activeVersionStats ? (
          <p className="py-8 text-center text-xs text-acc-text-secondary italic">
            No statistics recorded for this version yet.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {Object.keys(graph.nodes).map((nodeKey) => {
              const node = graph.nodes[nodeKey]!;
              const stats = nodeStatsMap.get(nodeKey);
              const running = stats?.running ?? 0;
              const waiting = stats?.waiting ?? 0;
              const outcomes = stats?.outcomes ?? {};
              const completedOutcomes = outcomes.completed ?? 0;
              const enteredOutcomes = outcomes.entered ?? 0;
              const failedOutcomes = outcomes.failed ?? 0;
              const exitedOutcomes = outcomes.exited ?? 0;

              const totalProcessed =
                completedOutcomes + exitedOutcomes + failedOutcomes + enteredOutcomes;
              const rate =
                totalExecutions > 0 ? Math.round((totalProcessed / totalExecutions) * 100) : 0;

              return (
                <div
                  key={nodeKey}
                  className="rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-4 text-xs space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`rounded-md border p-1.5 ${getNodeTypeColorClass(node.type)}`}
                      >
                        <JourneyNodeIcon type={node.type} className="h-4 w-4" />
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-acc-text-primary">
                            {getNodeDisplayLabel(nodeKey, node)}
                          </span>
                          <span className="font-mono text-[10px] text-acc-text-secondary">
                            ({nodeKey})
                          </span>
                        </div>
                        <span className="text-[10px] text-acc-text-secondary">
                          {getNodeTypeLabel(node.type)}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 font-mono text-xs">
                      {running > 0 && (
                        <div>
                          <span className="text-acc-text-secondary">Running: </span>
                          <span className="font-semibold text-sky-400">{running}</span>
                        </div>
                      )}
                      {waiting > 0 && (
                        <div>
                          <span className="text-acc-text-secondary">Waiting: </span>
                          <span className="font-semibold text-amber-400">{waiting}</span>
                        </div>
                      )}
                      {completedOutcomes > 0 && (
                        <div>
                          <span className="text-acc-text-secondary">Completed: </span>
                          <span className="font-semibold text-emerald-400">
                            {completedOutcomes}
                          </span>
                        </div>
                      )}
                      {failedOutcomes > 0 && (
                        <div>
                          <span className="text-acc-text-secondary">Failed: </span>
                          <span className="font-semibold text-red-400">{failedOutcomes}</span>
                        </div>
                      )}
                      {exitedOutcomes > 0 && (
                        <div>
                          <span className="text-acc-text-secondary">Exited: </span>
                          <span className="font-semibold text-acc-text-tertiary">
                            {exitedOutcomes}
                          </span>
                        </div>
                      )}
                      <div className="rounded bg-acc-surface px-2 py-0.5 text-acc-text-primary border border-acc-border">
                        {rate}% Throughput
                      </div>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-acc-surface-raised">
                    <div
                      className="h-full bg-acc-accent transition-all duration-500"
                      style={{ width: `${Math.min(rate, 100)}%` }}
                    />
                  </div>

                  {/* Outcome Breakdown Tags */}
                  {Object.keys(outcomes).length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {Object.entries(outcomes).map(([outcomeKey, count]) => (
                        <span
                          key={outcomeKey}
                          className="rounded border border-acc-border bg-acc-surface px-2 py-0.5 font-mono text-[10px] text-acc-text-secondary"
                        >
                          {getStepOutcomeLabel(outcomeKey as JourneyStepOutcome)}: {count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
