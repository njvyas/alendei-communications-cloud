'use client';

import { useMemo, useState } from 'react';
import {
  JOURNEY_NODE_CATALOGUE,
  JOURNEY_GRAPH_LIMITS,
  validateJourneyGraph,
  canonicalJourneyJson,
  getNodeDisplayLabel,
  getNodeSummary,
  getNodeTypeLabel,
  type JourneyGraph,
  type JourneyGraphValidationReport,
  type JourneyNode,
  type JourneyNodeType,
  type JourneyNodeStatistics,
  type JourneyVersionRecord,
  type JourneyVersionStatus,
} from '@/lib/journeys';
import { journeysApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { AccessibleDialog } from '@/components/ui/dialog';
import { JourneyNodeIcon, getNodeTypeColorClass } from './journey-node-icon';
import { JourneyNodeInspector } from './journey-node-inspector';

export interface JourneyGraphEditorProps {
  readonly workspaceId: string;
  readonly journeyId: string;
  readonly versionId: string;
  readonly initialGraph: JourneyGraph;
  readonly initialGraphSha256: string;
  readonly readOnly?: boolean;
  readonly canManage?: boolean;
  readonly versionStatus?: JourneyVersionStatus;
  readonly nodeStats?: Record<string, JourneyNodeStatistics>;
  readonly onSaved?: (savedVersion: JourneyVersionRecord) => void;
  readonly onPublished?: (publishedVersion: JourneyVersionRecord) => void;
}

export function JourneyGraphEditor({
  workspaceId,
  journeyId,
  versionId,
  initialGraph,
  initialGraphSha256,
  readOnly = false,
  canManage = true,
  versionStatus = 'draft',
  nodeStats,
  onSaved,
  onPublished,
}: JourneyGraphEditorProps) {
  const [graph, setGraph] = useState<JourneyGraph>(initialGraph);
  const [currentSha256, setCurrentSha256] = useState<string>(initialGraphSha256);
  const [savedCanonical, setSavedCanonical] = useState<string>(() =>
    canonicalJourneyJson(initialGraph),
  );
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(initialGraph.entry || null);

  const [isSaving, setIsSaving] = useState(false);
  const [isValidatingServer, setIsValidatingServer] = useState(false);
  const [serverReport, setServerReport] = useState<JourneyGraphValidationReport | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  // Compute canonical diff to determine dirtiness
  const isDirty = useMemo(() => {
    return canonicalJourneyJson(graph) !== savedCanonical;
  }, [graph, savedCanonical]);

  // Real-time client-side authoritative validation
  const validationReport = useMemo(() => {
    return validateJourneyGraph(graph);
  }, [graph]);

  const activeReport = serverReport || validationReport;
  const isEffectiveReadOnly = readOnly || !canManage || versionStatus !== 'draft';

  // Helper to generate a unique key for new nodes
  const generateUniqueKey = (prefix: string): string => {
    let index = 1;
    let candidate = `${prefix}_${index}`;
    while (graph.nodes[candidate]) {
      index++;
      candidate = `${prefix}_${index}`;
    }
    return candidate;
  };

  const handleAddNode = (type: JourneyNodeType) => {
    if (isEffectiveReadOnly) return;
    const nodeCount = Object.keys(graph.nodes).length;
    if (nodeCount >= JOURNEY_GRAPH_LIMITS.maxNodes) {
      toast.error(`Graph has reached maximum limit of ${JOURNEY_GRAPH_LIMITS.maxNodes} nodes.`);
      return;
    }

    const prefix = type.slice(0, 4);
    const newKey = generateUniqueKey(prefix);

    let newNode: JourneyNode;
    switch (type) {
      case 'send_message':
        newNode = {
          type: 'send_message',
          channel: 'whatsapp',
          templateId: 'welcome_template',
          variables: {},
          onSuppressed: 'continue',
          onRefused: 'continue',
          next: '',
        };
        break;
      case 'wait_duration':
        newNode = {
          type: 'wait_duration',
          seconds: 3600,
          next: '',
        };
        break;
      case 'wait_until':
        newNode = {
          type: 'wait_until',
          at: new Date(Date.now() + 86400000).toISOString(),
          next: '',
        };
        break;
      case 'wait_window':
        newNode = {
          type: 'wait_window',
          startTime: '09:00',
          endTime: '18:00',
          timeZone: 'UTC',
          next: '',
        };
        break;
      case 'condition':
        newNode = {
          type: 'condition',
          rule: { kind: 'attribute', field: 'firstName', op: 'exists' },
          onTrue: '',
          onFalse: '',
        };
        break;
      case 'wait_for_outcome':
        newNode = {
          type: 'wait_for_outcome',
          sendNodeKey: '',
          outcome: 'delivered',
          timeoutSeconds: 86400,
          onOutcome: '',
          onTimeout: '',
        };
        break;
      case 'update_contact':
        newNode = {
          type: 'update_contact',
          operations: [{ op: 'add_tag', tag: 'onboarded' }],
          next: '',
        };
        break;
      case 'exit':
        newNode = { type: 'exit' };
        break;
      default:
        newNode = {
          type: type as 'webhook' | 'crm_action' | 'human_handoff' | 'ai_handoff',
          label: getNodeTypeLabel(type),
          next: '',
        };
        break;
    }

    setGraph((prev) => ({
      ...prev,
      nodes: {
        ...prev.nodes,
        [newKey]: newNode,
      },
    }));

    setSelectedNodeKey(newKey);
    setServerReport(null);
  };

  const handleNodeChange = (updatedNode: JourneyNode) => {
    if (isEffectiveReadOnly || !selectedNodeKey) return;
    setGraph((prev) => ({
      ...prev,
      nodes: {
        ...prev.nodes,
        [selectedNodeKey]: updatedNode,
      },
    }));
    setServerReport(null);
  };

  const handleDeleteNode = (nodeKey: string) => {
    if (isEffectiveReadOnly || nodeKey === graph.entry) return;

    setGraph((prev) => {
      const remainingNodes = { ...prev.nodes };
      delete remainingNodes[nodeKey];

      // Remove edges referencing deleted node
      for (const k of Object.keys(remainingNodes)) {
        const n = remainingNodes[k]!;
        if ('next' in n && n.next === nodeKey) {
          remainingNodes[k] = { ...n, next: '' } as JourneyNode;
        } else if ('onTrue' in n && (n.onTrue === nodeKey || n.onFalse === nodeKey)) {
          remainingNodes[k] = {
            ...n,
            onTrue: n.onTrue === nodeKey ? '' : n.onTrue,
            onFalse: n.onFalse === nodeKey ? '' : n.onFalse,
          } as JourneyNode;
        } else if ('onOutcome' in n && (n.onOutcome === nodeKey || n.onTimeout === nodeKey)) {
          remainingNodes[k] = {
            ...n,
            onOutcome: n.onOutcome === nodeKey ? '' : n.onOutcome,
            onTimeout: n.onTimeout === nodeKey ? '' : n.onTimeout,
          } as JourneyNode;
        }
      }

      return {
        ...prev,
        nodes: remainingNodes,
      };
    });

    if (selectedNodeKey === nodeKey) {
      setSelectedNodeKey(graph.entry);
    }
    setServerReport(null);
  };

  const handleSaveDraft = async () => {
    if (isEffectiveReadOnly || isSaving) return;
    setIsSaving(true);
    try {
      const res = await journeysApi.replaceGraph(workspaceId, journeyId, versionId, {
        graph,
        expectedGraphSha256: currentSha256,
      });
      setCurrentSha256(res.data.graphSha256);
      const newCanonical = canonicalJourneyJson(graph);
      setSavedCanonical(newCanonical);
      toast.success('Draft graph saved.');
      onSaved?.(res.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save graph.';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleServerValidate = async () => {
    setIsValidatingServer(true);
    try {
      // Auto-save first if dirty
      if (isDirty) {
        const saveRes = await journeysApi.replaceGraph(workspaceId, journeyId, versionId, {
          graph,
          expectedGraphSha256: currentSha256,
        });
        setCurrentSha256(saveRes.data.graphSha256);
        setSavedCanonical(canonicalJourneyJson(graph));
      }

      const res = await journeysApi.validate(workspaceId, journeyId, versionId);
      setServerReport(res.data);
      if (res.data.valid) {
        toast.success('Server validation passed: 0 errors.');
      } else {
        toast.error(`Server validation identified ${res.data.errors.length} errors.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Validation request failed.';
      toast.error(msg);
    } finally {
      setIsValidatingServer(false);
    }
  };

  const handlePublishSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validationReport.valid) {
      toast.error('Cannot publish a graph with validation errors.');
      return;
    }
    setIsPublishing(true);
    try {
      // Auto-save first if dirty
      let latestSha = currentSha256;
      if (isDirty) {
        const saveRes = await journeysApi.replaceGraph(workspaceId, journeyId, versionId, {
          graph,
          expectedGraphSha256: currentSha256,
        });
        latestSha = saveRes.data.graphSha256;
        setCurrentSha256(latestSha);
        setSavedCanonical(canonicalJourneyJson(graph));
      }

      const res = await journeysApi.publish(workspaceId, journeyId, versionId, {
        expectedGraphSha256: latestSha,
      });
      toast.success(`Published as Version ${res.data.versionNumber}.`);
      setShowPublishModal(false);
      onPublished?.(res.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to publish journey version.';
      toast.error(msg);
    } finally {
      setIsPublishing(false);
    }
  };

  const nodeKeys = Object.keys(graph.nodes);
  const selectedNode = selectedNodeKey ? graph.nodes[selectedNodeKey] : null;

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-[580px] w-full flex-col rounded-xl border border-acc-border bg-acc-bg overflow-hidden text-acc-text-primary">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-acc-border bg-acc-surface px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-acc-text-secondary">
            Graph Canvas
          </span>
          <span className="rounded-full bg-acc-surface-raised px-2.5 py-0.5 text-xs font-mono text-acc-text-secondary">
            {nodeKeys.length} / {JOURNEY_GRAPH_LIMITS.maxNodes} nodes
          </span>
          {isDirty && !isEffectiveReadOnly && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              Unsaved changes
            </span>
          )}
          {isEffectiveReadOnly && (
            <span className="rounded-md border border-acc-border bg-acc-surface-raised px-2 py-0.5 text-xs text-acc-text-secondary">
              Read-Only
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleServerValidate}
            disabled={isValidatingServer}
            className="rounded-lg border border-acc-border bg-acc-surface-raised px-3 py-1.5 text-xs font-medium text-acc-text-secondary hover:text-acc-text-primary focus:outline-hidden disabled:opacity-50"
          >
            {isValidatingServer ? 'Checking…' : 'Server Validate'}
          </button>

          {!isEffectiveReadOnly && (
            <>
              <button
                type="button"
                onClick={handleSaveDraft}
                disabled={!isDirty || isSaving}
                className="inline-flex items-center gap-1.5 rounded-lg border border-acc-border bg-acc-surface-raised px-3 py-1.5 text-xs font-medium text-acc-text-primary hover:bg-acc-surface-raised/80 focus:outline-hidden disabled:opacity-50"
              >
                {isSaving ? 'Saving…' : 'Save Draft'}
              </button>

              <button
                type="button"
                onClick={() => setShowPublishModal(true)}
                disabled={!validationReport.valid || isPublishing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-acc-accent px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-acc-accent-hover focus:outline-hidden disabled:opacity-50"
              >
                Publish Version
              </button>
            </>
          )}
        </div>
      </div>

      {/* Validation Alert Bar */}
      {(!activeReport.valid || activeReport.warnings.length > 0) && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-center justify-between border-b px-4 py-2 text-xs ${
            !activeReport.valid
              ? 'border-red-500/40 bg-red-500/10 text-red-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          }`}
        >
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <span>
              {!activeReport.valid
                ? `${activeReport.errors.length} validation errors must be resolved.`
                : `${activeReport.warnings.length} warnings detected.`}
            </span>
          </div>

          <div className="flex flex-wrap gap-2 text-[11px]">
            {activeReport.errors.map((err, i) => (
              <button
                key={i}
                type="button"
                onClick={() => err.nodeKey && setSelectedNodeKey(err.nodeKey)}
                className="rounded bg-red-950/60 px-2 py-0.5 font-mono text-red-200 hover:underline"
              >
                {err.nodeKey ? `[${err.nodeKey}] ` : ''}
                {err.message}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Workspace (Palette + Flow Canvas + Inspector) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Node Palette */}
        {!isEffectiveReadOnly && (
          <aside
            aria-label="Node Palette"
            className="flex w-56 flex-col border-r border-acc-border bg-acc-surface/60 p-3 overflow-y-auto"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wider text-acc-text-secondary pb-2">
              Add Steps
            </p>
            <div className="space-y-1.5">
              {(Object.keys(JOURNEY_NODE_CATALOGUE) as JourneyNodeType[]).map((type) => {
                if (type === 'entry') return null;
                const catInfo = JOURNEY_NODE_CATALOGUE[type];
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleAddNode(type)}
                    className="flex w-full items-center gap-2 rounded-lg border border-acc-border bg-acc-surface px-2.5 py-2 text-left text-xs transition-colors hover:border-acc-accent/60 hover:bg-acc-surface-raised"
                  >
                    <span
                      className={`rounded-md border p-1 shrink-0 ${getNodeTypeColorClass(type)}`}
                    >
                      <JourneyNodeIcon type={type} className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-acc-text-primary">
                        {getNodeTypeLabel(type)}
                      </p>
                      <p className="truncate text-[10px] text-acc-text-secondary">
                        {catInfo.category}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        {/* Visual Graph Canvas */}
        <main
          aria-label="Journey Canvas Flow"
          className="flex-1 overflow-y-auto p-6 bg-[radial-gradient(#334155_1px,transparent_1px)] [background-size:16px_16px]"
        >
          <div className="mx-auto max-w-2xl space-y-4">
            {nodeKeys.map((nodeKey) => {
              const node = graph.nodes[nodeKey]!;
              const isSelected = nodeKey === selectedNodeKey;
              const hasErrors = activeReport.errors.some((e) => e.nodeKey === nodeKey);
              const stats = nodeStats?.[nodeKey];

              return (
                <div key={nodeKey} className="relative group">
                  {/* Node Card */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedNodeKey(nodeKey)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        setSelectedNodeKey(nodeKey);
                      }
                    }}
                    className={`cursor-pointer rounded-xl border p-4 transition-all shadow-xs ${
                      isSelected
                        ? 'border-acc-accent bg-acc-surface ring-2 ring-acc-accent/30 shadow-md'
                        : hasErrors
                          ? 'border-red-500/60 bg-acc-surface hover:border-red-400'
                          : 'border-acc-border bg-acc-surface hover:border-acc-border-hover'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span
                          className={`rounded-lg border p-2 shrink-0 ${getNodeTypeColorClass(node.type)}`}
                        >
                          <JourneyNodeIcon type={node.type} className="h-5 w-5" />
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-semibold text-acc-text-primary">
                              {getNodeDisplayLabel(nodeKey, node)}
                            </h4>
                            <span className="font-mono text-[10px] text-acc-text-secondary">
                              ({nodeKey})
                            </span>
                            {nodeKey === graph.entry && (
                              <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                                Entry Trigger
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-acc-text-secondary">
                            {getNodeSummary(node)}
                          </p>
                        </div>
                      </div>

                      {/* Stats badge if available */}
                      {stats && (
                        <div className="flex items-center gap-2 font-mono text-[11px]">
                          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-400">
                            ✓ {(stats.outcomes.completed ?? 0) + (stats.outcomes.exited ?? 0)}
                          </span>
                          {(stats.waiting > 0 || (stats.outcomes.waited ?? 0) > 0) && (
                            <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-400">
                              ⏳ {stats.waiting + (stats.outcomes.waited ?? 0)}
                            </span>
                          )}
                          {(stats.outcomes.failed ?? 0) > 0 && (
                            <span className="rounded bg-red-500/10 px-2 py-0.5 text-red-400">
                              ✗ {stats.outcomes.failed}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Edge Routing Visual Pill */}
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-acc-border/60 pt-2 text-[11px]">
                      {node.type === 'exit' && (
                        <span className="text-acc-text-secondary italic">
                          Terminal step (finishes flow)
                        </span>
                      )}
                      {'next' in node && (
                        <span className="inline-flex items-center gap-1 text-acc-text-secondary">
                          <span>Next Step →</span>
                          <span className="font-mono font-medium text-acc-accent">
                            {node.next
                              ? getNodeDisplayLabel(
                                  node.next,
                                  graph.nodes[node.next] ?? { type: 'exit' },
                                )
                              : '(Unconnected / Flow Ends)'}
                          </span>
                        </span>
                      )}
                      {'onTrue' in node && (
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <span>True →</span>
                            <span className="font-mono">{node.onTrue || '(Unconnected)'}</span>
                          </span>
                          <span className="inline-flex items-center gap-1 text-rose-400">
                            <span>False →</span>
                            <span className="font-mono">{node.onFalse || '(Unconnected)'}</span>
                          </span>
                        </div>
                      )}
                      {'onOutcome' in node && (
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="inline-flex items-center gap-1 text-indigo-400">
                            <span>Outcome →</span>
                            <span className="font-mono">{node.onOutcome || '(Unconnected)'}</span>
                          </span>
                          <span className="inline-flex items-center gap-1 text-amber-400">
                            <span>Timeout →</span>
                            <span className="font-mono">{node.onTimeout || '(Unconnected)'}</span>
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Flow Connector Line */}
                  <div className="flex justify-center py-1">
                    <svg className="h-5 w-4 text-acc-border" viewBox="0 0 16 20" fill="none">
                      <line x1="8" y1="0" x2="8" y2="16" stroke="currentColor" strokeWidth="2" />
                      <polyline
                        points="4,12 8,18 12,12"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                </div>
              );
            })}
          </div>
        </main>

        {/* Selected Node Inspector Drawer */}
        {selectedNode && selectedNodeKey && (
          <JourneyNodeInspector
            nodeKey={selectedNodeKey}
            node={selectedNode}
            graph={graph}
            readOnly={isEffectiveReadOnly}
            onChange={handleNodeChange}
            onDelete={handleDeleteNode}
            onClose={() => setSelectedNodeKey(null)}
          />
        )}
      </div>

      {/* Publish Confirmation Modal */}
      <AccessibleDialog
        isOpen={showPublishModal}
        onClose={() => setShowPublishModal(false)}
        titleId="publish-version-title"
        maxWidth="max-w-md"
        dismissible={!isPublishing}
      >
        <div className="text-acc-text-primary">
          <h3 id="publish-version-title" className="text-base font-semibold">
            Publish Journey Version
          </h3>
          <p className="mt-1 text-xs text-acc-text-secondary">
            Publishing immutably freezes this graph structure as the authoritative active version.
            In-flight executions will finish on their registered version.
          </p>

          <form onSubmit={handlePublishSubmit} className="mt-4 space-y-4">
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowPublishModal(false)}
                disabled={isPublishing}
                className="rounded-lg border border-acc-border px-3 py-1.5 text-xs font-medium text-acc-text-secondary hover:bg-acc-surface-raised"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPublishing}
                className="rounded-lg bg-acc-accent px-4 py-1.5 text-xs font-semibold text-white hover:bg-acc-accent-hover"
              >
                {isPublishing ? 'Publishing…' : 'Confirm Publish'}
              </button>
            </div>
          </form>
        </div>
      </AccessibleDialog>
    </div>
  );
}
