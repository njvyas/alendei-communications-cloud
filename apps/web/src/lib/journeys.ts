/**
 * Phase 8C: Journeys / Automation Domain Module
 *
 * Authoritative contracts, lifecycle state disciplines, graph schema types,
 * node catalogue definitions, validation helpers, and execution models.
 *
 * Architecture Invariants:
 * 1. packages/contracts/src/journeys.ts is the sole authoritative graph contract.
 *    No competing schema or duplicate validation rules are introduced.
 * 2. Journeys are callers of the Communication Core; they cannot bypass
 *    consent, suppression, routing, fallback, or billing rules.
 * 3. A published version is immutable and can never be overwritten.
 * 4. In-flight executions run on their version to completion.
 */

import {
  JOURNEY_GRAPH_SCHEMA_VERSION,
  JOURNEY_GRAPH_LIMITS,
  JOURNEY_NODE_KEY_PATTERN,
  JOURNEY_CUSTOM_FIELD_PATTERN,
  JOURNEY_STANDARD_FIELDS,
  JOURNEY_STATUSES,
  JOURNEY_VERSION_STATUSES,
  JOURNEY_CHANNELS,
  JOURNEY_TRIGGER_EVENTS,
  JOURNEY_NODE_CATALOGUE,
  JOURNEY_NODE_EDGES,
  JOURNEY_NODE_TYPES,
  JOURNEY_GRAPH_ISSUE_CODES,
  defaultJourneyGraph,
  validateJourneyGraph,
  canonicalJourneyJson,
  isJourneyTimeZone,
  type JourneyStatus,
  type JourneyVersionStatus,
  type JourneyChannel,
  type JourneyTriggerEvent,
  type JourneyTrigger,
  type JourneyValueSource,
  type JourneyConditionRule,
  type JourneyContactUpdate,
  type JourneyNode,
  type JourneyNodeType,
  type JourneyGraph,
  type JourneyGraphIssue,
  type JourneyGraphIssueCode,
  type JourneyGraphValidationReport,
  type JourneyVersionSummary,
  type JourneyVersionRecord,
  type JourneyRecord,
} from '@acc/contracts';

// Re-export authoritative contracts
export {
  JOURNEY_GRAPH_SCHEMA_VERSION,
  JOURNEY_GRAPH_LIMITS,
  JOURNEY_NODE_KEY_PATTERN,
  JOURNEY_CUSTOM_FIELD_PATTERN,
  JOURNEY_STANDARD_FIELDS,
  JOURNEY_STATUSES,
  JOURNEY_VERSION_STATUSES,
  JOURNEY_CHANNELS,
  JOURNEY_TRIGGER_EVENTS,
  JOURNEY_NODE_CATALOGUE,
  JOURNEY_NODE_EDGES,
  JOURNEY_NODE_TYPES,
  JOURNEY_GRAPH_ISSUE_CODES,
  defaultJourneyGraph,
  validateJourneyGraph,
  canonicalJourneyJson,
  isJourneyTimeZone,
  type JourneyStatus,
  type JourneyVersionStatus,
  type JourneyChannel,
  type JourneyTriggerEvent,
  type JourneyTrigger,
  type JourneyValueSource,
  type JourneyConditionRule,
  type JourneyContactUpdate,
  type JourneyNode,
  type JourneyNodeType,
  type JourneyGraph,
  type JourneyGraphIssue,
  type JourneyGraphIssueCode,
  type JourneyGraphValidationReport,
  type JourneyVersionSummary,
  type JourneyVersionRecord,
  type JourneyRecord,
};

// --- Execution & Statistics Models (8C-2 Coordination) --------------------

export type JourneyExecutionStatus =
  'running' | 'waiting' | 'completed' | 'exited' | 'failed' | 'cancelled';

export const ALL_JOURNEY_EXECUTION_STATUSES: readonly JourneyExecutionStatus[] = [
  'running',
  'waiting',
  'completed',
  'exited',
  'failed',
  'cancelled',
] as const;

export interface JourneyExecutionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly contactId: string;
  readonly contactName?: string;
  readonly contactAddress?: string;
  readonly journeyId: string;
  readonly journeyVersionId: string;
  readonly versionNumber: number;
  readonly status: JourneyExecutionStatus;
  readonly currentNodeKey: string | null;
  readonly wakeAt: string | null;
  readonly stateVersion: number;
  readonly entryKind: string;
  readonly entryRef: string;
  readonly enteredAt: string;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly transitions: number;
}

export type JourneyStepOutcome =
  'success' | 'failed' | 'waited' | 'branch_true' | 'branch_false' | 'exited';

export interface JourneyExecutionStepRecord {
  readonly id: string;
  readonly executionId: string;
  readonly seq: number;
  readonly nodeKey: string;
  readonly nodeType: JourneyNodeType;
  readonly outcome: JourneyStepOutcome;
  readonly attempt: number;
  readonly messageId: string | null;
  readonly errorCode: string | null;
  readonly details: Record<string, unknown> | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface JourneyNodeStatistics {
  readonly nodeKey: string;
  readonly nodeType: JourneyNodeType;
  readonly enteredCount: number;
  readonly completedCount: number;
  readonly waitingCount: number;
  readonly failedCount: number;
  readonly branchedCounts?: {
    readonly onTrue?: number;
    readonly onFalse?: number;
    readonly onOutcome?: number;
    readonly onTimeout?: number;
  };
}

export interface JourneyKPIs {
  readonly totalJourneys: number;
  readonly activeCount: number;
  readonly draftCount: number;
  readonly pausedCount: number;
  readonly archivedCount: number;
}

// --- Presentation Helpers ------------------------------------------------

export function getJourneyStatusLabel(status: JourneyStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'active':
      return 'Active';
    case 'paused':
      return 'Paused';
    case 'archived':
      return 'Archived';
    default:
      return status;
  }
}

export function getJourneyVersionStatusLabel(status: JourneyVersionStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft Version';
    case 'published':
      return 'Published';
    case 'retired':
      return 'Retired';
    default:
      return status;
  }
}

export function getNodeTypeLabel(type: JourneyNodeType): string {
  switch (type) {
    case 'entry':
      return 'Entry Trigger';
    case 'send_message':
      return 'Send Message';
    case 'wait_duration':
      return 'Wait Duration';
    case 'wait_until':
      return 'Wait Until';
    case 'wait_window':
      return 'Wait Window';
    case 'condition':
      return 'Condition Branch';
    case 'wait_for_outcome':
      return 'Wait for Outcome';
    case 'update_contact':
      return 'Update Contact';
    case 'exit':
      return 'Exit Journey';
    case 'webhook':
      return 'Webhook (Placeholder)';
    case 'crm_action':
      return 'CRM Action (Placeholder)';
    case 'human_handoff':
      return 'Human Handoff (Placeholder)';
    case 'ai_handoff':
      return 'AI Handoff (Placeholder)';
    default:
      return type;
  }
}

export function getNodeCategoryLabel(category: string): string {
  switch (category) {
    case 'trigger':
      return 'Triggers';
    case 'action':
      return 'Actions';
    case 'wait':
      return 'Delays & Timing';
    case 'branch':
      return 'Conditions & Logic';
    case 'exit':
      return 'Terminations';
    default:
      return category;
  }
}

export function calculateJourneyKPIs(journeys: readonly JourneyRecord[]): JourneyKPIs {
  let activeCount = 0;
  let draftCount = 0;
  let pausedCount = 0;
  let archivedCount = 0;

  for (const j of journeys) {
    if (j.status === 'active') activeCount++;
    else if (j.status === 'draft') draftCount++;
    else if (j.status === 'paused') pausedCount++;
    else if (j.status === 'archived') archivedCount++;
  }

  return {
    totalJourneys: journeys.length,
    activeCount,
    draftCount,
    pausedCount,
    archivedCount,
  };
}

export function formatWaitSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  }
  if (seconds < 86400) {
    const hrs = Math.floor(seconds / 3600);
    const remMins = Math.floor((seconds % 3600) / 60);
    return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  }
  const days = Math.floor(seconds / 86400);
  const remHrs = Math.floor((seconds % 86400) / 3600);
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

export function parseWaitSeconds(
  unit: 'seconds' | 'minutes' | 'hours' | 'days',
  value: number,
): number {
  switch (unit) {
    case 'seconds':
      return Math.round(value);
    case 'minutes':
      return Math.round(value * 60);
    case 'hours':
      return Math.round(value * 3600);
    case 'days':
      return Math.round(value * 86400);
  }
}

export interface NodeEdgeTargets {
  readonly next?: string;
  readonly onTrue?: string;
  readonly onFalse?: string;
  readonly onOutcome?: string;
  readonly onTimeout?: string;
}

export function getNodeEdgeTargets(node: JourneyNode): NodeEdgeTargets {
  if ('next' in node) {
    return { next: node.next };
  }
  if ('onTrue' in node) {
    return { onTrue: node.onTrue, onFalse: node.onFalse };
  }
  if ('onOutcome' in node) {
    return { onOutcome: node.onOutcome, onTimeout: node.onTimeout };
  }
  return {};
}

export function updateNodeEdgeTarget(
  node: JourneyNode,
  slot: 'next' | 'onTrue' | 'onFalse' | 'onOutcome' | 'onTimeout',
  targetKey: string,
): JourneyNode {
  if (slot === 'next' && 'next' in node) {
    return { ...node, next: targetKey };
  }
  if (slot === 'onTrue' && 'onTrue' in node) {
    return { ...node, onTrue: targetKey };
  }
  if (slot === 'onFalse' && 'onFalse' in node) {
    return { ...node, onFalse: targetKey };
  }
  if (slot === 'onOutcome' && 'onOutcome' in node) {
    return { ...node, onOutcome: targetKey };
  }
  if (slot === 'onTimeout' && 'onTimeout' in node) {
    return { ...node, onTimeout: targetKey };
  }
  return node;
}

export function getNodeDisplayLabel(nodeKey: string, node: JourneyNode): string {
  if ('label' in node && node.label) {
    return node.label;
  }
  return `${getNodeTypeLabel(node.type)} (${nodeKey})`;
}

export function getNodeSummary(node: JourneyNode): string {
  switch (node.type) {
    case 'entry':
      return node.trigger.kind === 'api'
        ? 'Inbound API Trigger'
        : node.trigger.kind === 'event'
          ? `Event: ${node.trigger.event}`
          : 'Scheduled Segment';
    case 'send_message':
      return `${node.channel.toUpperCase()} · Template: ${node.templateId}`;
    case 'wait_duration':
      return `Wait ${formatWaitSeconds(node.seconds)}`;
    case 'wait_until':
      return `Wait until ${node.at}`;
    case 'wait_window':
      return `Window ${node.startTime} - ${node.endTime} (${node.timeZone})`;
    case 'condition':
      return `Rule: ${node.rule.kind}`;
    case 'wait_for_outcome':
      return `Wait for ${node.outcome} (max ${formatWaitSeconds(node.timeoutSeconds)})`;
    case 'update_contact':
      return `Update Contact (${node.operations.length} op)`;
    case 'exit':
      return node.reason ? `Exit (${node.reason})` : 'Exit Flow';
    default:
      return 'label' in node && node.label ? node.label : node.type;
  }
}
