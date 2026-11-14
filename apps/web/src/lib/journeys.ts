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
  // 8C-2 Lifecycle, Triggers & Executions
  JOURNEY_AUDIT_ACTIONS,
  JOURNEY_LIFECYCLE_ACTIONS,
  JOURNEY_LIFECYCLE_TRANSITIONS,
  journeyLifecycleTarget,
  JOURNEY_TRIGGER_KINDS,
  JOURNEY_TRIGGER_STATUSES,
  JOURNEY_EXECUTION_STATUSES,
  JOURNEY_LIVE_EXECUTION_STATUSES,
  JOURNEY_STEP_OUTCOMES,
  JOURNEY_END_REASONS,
  JOURNEY_ENROLMENT_LIMITS,
  JOURNEY_ENROLMENT_OUTCOMES,
  deriveJourneyTrigger,
  journeyGraphHasSendNode,
  type JourneyLifecycleAction,
  type JourneyTriggerKind,
  type JourneyTriggerStatus,
  type JourneyExecutionStatus,
  type JourneyStepOutcome,
  type JourneyEnrolmentOutcome,
  type DerivedJourneyTrigger,
  type JourneyTriggerRecord,
  type JourneyExecutionRecord,
  type JourneyExecutionStepRecord,
  type JourneyExecutionDetailRecord,
  type JourneyEnrolmentResult,
  type JourneyNodeStats,
  type JourneyVersionStats,
  type JourneyStatsRecord,
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
  JOURNEY_AUDIT_ACTIONS,
  JOURNEY_LIFECYCLE_ACTIONS,
  JOURNEY_LIFECYCLE_TRANSITIONS,
  journeyLifecycleTarget,
  JOURNEY_TRIGGER_KINDS,
  JOURNEY_TRIGGER_STATUSES,
  JOURNEY_EXECUTION_STATUSES,
  JOURNEY_LIVE_EXECUTION_STATUSES,
  JOURNEY_STEP_OUTCOMES,
  JOURNEY_END_REASONS,
  JOURNEY_ENROLMENT_LIMITS,
  JOURNEY_ENROLMENT_OUTCOMES,
  deriveJourneyTrigger,
  journeyGraphHasSendNode,
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
  type JourneyLifecycleAction,
  type JourneyTriggerKind,
  type JourneyTriggerStatus,
  type JourneyExecutionStatus,
  type JourneyStepOutcome,
  type JourneyEnrolmentOutcome,
  type DerivedJourneyTrigger,
  type JourneyTriggerRecord,
  type JourneyExecutionRecord,
  type JourneyExecutionStepRecord,
  type JourneyExecutionDetailRecord,
  type JourneyEnrolmentResult,
  type JourneyNodeStats,
  type JourneyVersionStats,
  type JourneyStatsRecord,
};

export const ALL_JOURNEY_EXECUTION_STATUSES: readonly JourneyExecutionStatus[] =
  JOURNEY_EXECUTION_STATUSES;

export type JourneyNodeStatistics = JourneyNodeStats;

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
      return 'Draft';
    case 'published':
      return 'Published';
    case 'retired':
      return 'Retired';
    default:
      return status;
  }
}

export function getJourneyExecutionStatusLabel(status: JourneyExecutionStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'waiting':
      return 'Waiting';
    case 'completed':
      return 'Completed';
    case 'exited':
      return 'Exited';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

export function getTriggerKindLabel(kind: JourneyTriggerKind): string {
  switch (kind) {
    case 'api':
      return 'API Enrolment';
    case 'event':
      return 'Event Trigger';
    case 'schedule':
      return 'Recurring Schedule';
    default:
      return kind;
  }
}

export function getTriggerStatusLabel(status: JourneyTriggerStatus): string {
  switch (status) {
    case 'active':
      return 'Armed';
    case 'paused':
      return 'Paused';
    case 'retired':
      return 'Retired';
    default:
      return status;
  }
}

export function getStepOutcomeLabel(outcome: JourneyStepOutcome): string {
  switch (outcome) {
    case 'entered':
      return 'Entered';
    case 'completed':
      return 'Completed';
    case 'waited':
      return 'Waiting';
    case 'skipped':
      return 'Skipped';
    case 'refused':
      return 'Refused';
    case 'failed':
      return 'Failed';
    case 'stubbed':
      return 'Stubbed';
    case 'exited':
      return 'Exited';
    case 'cancelled':
      return 'Cancelled';
    default:
      return outcome;
  }
}

export function formatTriggerSummary(trigger: JourneyTriggerRecord | null): string {
  if (!trigger) return 'No active trigger';
  if (trigger.kind === 'api') {
    return 'API Enrolment (POST /enrollments)';
  }
  if (trigger.kind === 'event') {
    const detail = trigger.eventKind ?? trigger.eventTag ?? 'domain event';
    return `Event: ${detail}`;
  }
  if (trigger.kind === 'schedule') {
    const nextText = trigger.nextFireAt
      ? ` (Next: ${new Date(trigger.nextFireAt).toLocaleString()})`
      : '';
    return `Schedule${nextText}`;
  }
  return trigger.kind;
}

const NODE_TYPE_LABELS: Record<JourneyNodeType, string> = {
  entry: 'Entry Point',
  send_message: 'Send Message',
  wait_duration: 'Wait Duration',
  wait_until: 'Wait Until',
  wait_window: 'Wait Window',
  condition: 'Condition Split',
  wait_for_outcome: 'Wait for Outcome',
  update_contact: 'Update Contact',
  exit: 'Journey Exit',
  webhook: 'Custom Webhook (Stub)',
  crm_action: 'CRM Action (Stub)',
  human_handoff: 'Human Handoff (Stub)',
  ai_handoff: 'AI Agent Handoff (Stub)',
};

export function getNodeTypeLabel(type: JourneyNodeType): string {
  return NODE_TYPE_LABELS[type] ?? type;
}

export function getNodeDisplayLabel(nodeKey: string, node: JourneyNode): string {
  switch (node.type) {
    case 'entry':
      return 'Start Journey';
    case 'send_message':
      return `Send ${node.channel?.toUpperCase() || 'Message'}`;
    case 'wait_duration':
      return `Delay: ${formatWaitSeconds(node.seconds || 0)}`;
    case 'wait_until':
      return `Wait until timestamp`;
    case 'wait_window':
      return `Wait for time window`;
    case 'condition':
      return 'Evaluate Condition';
    case 'wait_for_outcome':
      return 'Await User Action';
    case 'update_contact':
      return 'Update Contact Attributes';
    case 'exit':
      return 'End of Journey';
    case 'webhook':
      return 'Webhook Request';
    case 'crm_action':
      return 'CRM Update';
    case 'human_handoff':
      return 'Hand off to Human';
    case 'ai_handoff':
      return 'Hand off to AI Agent';
    default:
      return nodeKey;
  }
}

export function getNodeSummary(node: JourneyNode): string {
  switch (node.type) {
    case 'entry':
      return `Trigger: ${node.trigger?.kind || 'manual'}`;
    case 'send_message':
      return `Channel: ${node.channel || 'unassigned'} | Template: ${node.templateId ? node.templateId.slice(0, 8) + '…' : 'none'}`;
    case 'wait_duration':
      return `Wait for ${formatWaitSeconds(node.seconds || 0)}`;
    case 'wait_until':
      return `Resume at ${node.at || 'specified time'}`;
    case 'wait_window':
      return `${node.startTime || '09:00'} - ${node.endTime || '17:00'} (${node.timeZone || 'UTC'})`;
    case 'condition':
      return `Branch on ${node.rule?.kind || 'expression'}`;
    case 'wait_for_outcome':
      return `Timeout after ${formatWaitSeconds(node.timeoutSeconds || 0)}`;
    case 'update_contact':
      return `${(node.operations || []).length} field mutation(s)`;
    case 'exit':
      return `Reason: ${node.reason || 'completed'}`;
    default:
      return 'Step configuration';
  }
}

export function formatWaitSeconds(seconds: number): string {
  if (seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const remDays = seconds % 86400;
  const hours = Math.floor(remDays / 3600);
  const remHours = remDays % 3600;
  const minutes = Math.floor(remHours / 60);
  const secs = remHours % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0) parts.push(`${secs}s`);

  return parts.length > 0 ? parts.join(' ') : '0s';
}

export function parseWaitSeconds(
  unitOrValue: 'seconds' | 'minutes' | 'hours' | 'days' | number,
  valueOrUnit: number | 'seconds' | 'minutes' | 'hours' | 'days',
): number {
  const unit = (typeof unitOrValue === 'string' ? unitOrValue : valueOrUnit) as
    'seconds' | 'minutes' | 'hours' | 'days';
  const val = typeof unitOrValue === 'number' ? unitOrValue : (valueOrUnit as number);
  switch (unit) {
    case 'days':
      return val * 86400;
    case 'hours':
      return val * 3600;
    case 'minutes':
      return val * 60;
    default:
      return val;
  }
}

export function getNodeEdgeTargets(node: JourneyNode): Record<string, string> {
  const result: Record<string, string> = {};
  if ('next' in node && typeof node.next === 'string') {
    result.next = node.next;
  }
  if ('onTrue' in node && typeof node.onTrue === 'string') {
    result.onTrue = node.onTrue;
  }
  if ('onFalse' in node && typeof node.onFalse === 'string') {
    result.onFalse = node.onFalse;
  }
  if ('onOutcome' in node && typeof node.onOutcome === 'string') {
    result.onOutcome = node.onOutcome;
  }
  if ('onTimeout' in node && typeof node.onTimeout === 'string') {
    result.onTimeout = node.onTimeout;
  }
  return result;
}

export function updateNodeEdgeTarget(
  node: JourneyNode,
  slot: 'next' | 'onTrue' | 'onFalse' | 'onOutcome' | 'onTimeout',
  targetNodeKey: string | undefined,
): JourneyNode {
  const updated = { ...node } as Record<string, unknown>;
  if (targetNodeKey) {
    updated[slot] = targetNodeKey;
  } else {
    delete updated[slot];
  }
  return updated as unknown as JourneyNode;
}

export function calculateJourneyKPIs(journeys: readonly JourneyRecord[]): JourneyKPIs {
  let activeCount = 0;
  let draftCount = 0;
  let pausedCount = 0;
  let archivedCount = 0;

  for (const j of journeys) {
    switch (j.status) {
      case 'active':
        activeCount++;
        break;
      case 'draft':
        draftCount++;
        break;
      case 'paused':
        pausedCount++;
        break;
      case 'archived':
        archivedCount++;
        break;
    }
  }

  return {
    totalJourneys: journeys.length,
    activeCount,
    draftCount,
    pausedCount,
    archivedCount,
  };
}
