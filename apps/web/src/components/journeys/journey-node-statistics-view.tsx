'use client';

import { useQuery } from '@tanstack/react-query';
import { journeysApi } from '@/lib/api-client';
import {
  getNodeDisplayLabel,
  getNodeTypeLabel,
  type JourneyGraph,
  type JourneyNodeStatistics,
} from '@/lib/journeys';
import { JourneyNodeIcon, getNodeTypeColorClass } from './journey-node-icon';

export interface JourneyNodeStatisticsViewProps {
  readonly workspaceId: string;
  readonly journeyId: string;
  readonly graph: JourneyGraph;
}

export function JourneyNodeStatisticsView({
  workspaceId,
  journeyId,
  graph,
}: JourneyNodeStatisticsViewProps) {
  const { data: statsData, isLoading } = useQuery({
    queryKey: ['journeys', workspaceId, journeyId, 'statistics'],
    queryFn: async ({ signal }) => {
      try {
        return await journeysApi.getNodeStatistics(workspaceId, journeyId, undefined, signal);
      } catch {
        return { data: [] };
      }
    },
    refetchInterval: 15000,
  });

  const statsList: readonly JourneyNodeStatistics[] = statsData?.data ?? [];
  const statsMap = new Map<string, JourneyNodeStatistics>(statsList.map((s) => [s.nodeKey, s]));

  // Aggregate totals
  const totalEntered = statsMap.get(graph.entry)?.enteredCount ?? 0;
  let totalCompleted = 0;
  let totalWaiting = 0;
  let totalFailed = 0;

  for (const s of statsList) {
    totalWaiting += s.waitingCount;
    totalFailed += s.failedCount;
    // Check if exit node
    if (graph.nodes[s.nodeKey]?.type === 'exit') {
      totalCompleted += s.completedCount;
    }
  }

  const overallCompletionRate =
    totalEntered > 0 ? Math.round((totalCompleted / totalEntered) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* 8C-2 Telemetry Info Banner */}
      <div className="flex items-center justify-between rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 text-xs text-indigo-300">
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
              clipRule="evenodd"
            />
          </svg>
          <span>
            <strong>Per-Node Statistics & Telemetry:</strong> Real-time event counts and branch
            funnels aggregated across all execution runs.
          </span>
        </div>
      </div>

      {/* Aggregate KPI Tiles */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-acc-border bg-acc-surface p-4">
          <p className="text-xs text-acc-text-secondary">Total Entries</p>
          <p className="mt-1 font-mono text-2xl font-bold text-acc-text-primary">
            {totalEntered.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-acc-text-tertiary">Contacts initiated</p>
        </div>

        <div className="rounded-xl border border-acc-border bg-acc-surface p-4">
          <p className="text-xs text-acc-text-secondary">Completed Flow</p>
          <p className="mt-1 font-mono text-2xl font-bold text-emerald-400">
            {totalCompleted.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-acc-text-tertiary">
            {overallCompletionRate}% completion rate
          </p>
        </div>

        <div className="rounded-xl border border-acc-border bg-acc-surface p-4">
          <p className="text-xs text-acc-text-secondary">Currently In Delays</p>
          <p className="mt-1 font-mono text-2xl font-bold text-amber-400">
            {totalWaiting.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-acc-text-tertiary">Awaiting timers / windows</p>
        </div>

        <div className="rounded-xl border border-acc-border bg-acc-surface p-4">
          <p className="text-xs text-acc-text-secondary">Errors / Drop-offs</p>
          <p className="mt-1 font-mono text-2xl font-bold text-red-400">
            {totalFailed.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-acc-text-tertiary">Failed step transitions</p>
        </div>
      </div>

      {/* Per-Node Funnel Breakdown */}
      <div className="rounded-xl border border-acc-border bg-acc-surface p-5">
        <h3 className="text-sm font-semibold text-acc-text-primary">Node Funnel & Throughput</h3>
        <p className="text-xs text-acc-text-secondary mt-0.5">
          Step-by-step conversion and branch distributions along the journey graph.
        </p>

        {isLoading ? (
          <p
            role="status"
            className="py-8 text-center text-xs text-acc-text-secondary animate-pulse"
          >
            Loading metrics…
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {Object.keys(graph.nodes).map((nodeKey) => {
              const node = graph.nodes[nodeKey]!;
              const stats = statsMap.get(nodeKey);
              const entered = stats?.enteredCount ?? 0;
              const completed = stats?.completedCount ?? 0;
              const waiting = stats?.waitingCount ?? 0;
              const failed = stats?.failedCount ?? 0;
              const rate = entered > 0 ? Math.round((completed / entered) * 100) : 0;

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

                    <div className="flex items-center gap-4 font-mono text-xs">
                      <div>
                        <span className="text-acc-text-secondary">Entered: </span>
                        <span className="font-semibold text-acc-text-primary">{entered}</span>
                      </div>
                      <div>
                        <span className="text-acc-text-secondary">Completed: </span>
                        <span className="font-semibold text-emerald-400">{completed}</span>
                      </div>
                      {waiting > 0 && (
                        <div>
                          <span className="text-acc-text-secondary">Waiting: </span>
                          <span className="font-semibold text-amber-400">{waiting}</span>
                        </div>
                      )}
                      {failed > 0 && (
                        <div>
                          <span className="text-acc-text-secondary">Failed: </span>
                          <span className="font-semibold text-red-400">{failed}</span>
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

                  {/* Branch Breakdown (if condition or outcome) */}
                  {stats?.branchedCounts && (
                    <div className="flex flex-wrap gap-4 border-t border-acc-border/40 pt-2 text-[11px] font-mono">
                      {stats.branchedCounts.onTrue !== undefined && (
                        <span className="text-emerald-400">
                          Match (True): {stats.branchedCounts.onTrue}
                        </span>
                      )}
                      {stats.branchedCounts.onFalse !== undefined && (
                        <span className="text-rose-400">
                          No Match (False): {stats.branchedCounts.onFalse}
                        </span>
                      )}
                      {stats.branchedCounts.onOutcome !== undefined && (
                        <span className="text-indigo-400">
                          Outcome Met: {stats.branchedCounts.onOutcome}
                        </span>
                      )}
                      {stats.branchedCounts.onTimeout !== undefined && (
                        <span className="text-amber-400">
                          Timeout: {stats.branchedCounts.onTimeout}
                        </span>
                      )}
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
