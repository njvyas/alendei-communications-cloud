/**
 * Message lifecycle and dispatch contracts (Phase 3.3, ADR-014 §7, §9, §13).
 */

export const MESSAGE_STATUSES = [
  'queued',
  'routing',
  'submitting',
  'accepted',
  'failed',
  'outcome_unknown',
] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_TERMINAL_STATUSES: readonly MessageStatus[] = Object.freeze([
  'accepted',
  'failed',
  'outcome_unknown',
]);

export function isTerminalMessageStatus(status: MessageStatus): boolean {
  return MESSAGE_TERMINAL_STATUSES.includes(status);
}

export const MESSAGE_ATTEMPT_STATUSES = [
  'submitting',
  'accepted',
  'failed',
  'outcome_unknown',
] as const;

export type MessageAttemptStatus = (typeof MESSAGE_ATTEMPT_STATUSES)[number];

export const MESSAGE_EVENT_TYPES = {
  QUEUED: 'message.queued',
  ROUTING: 'message.routing',
  SUBMITTING: 'message.submitting',
  ACCEPTED: 'message.accepted',
  FAILED: 'message.failed',
  OUTCOME_UNKNOWN: 'message.outcome_unknown',
} as const;

export type MessageEventType = (typeof MESSAGE_EVENT_TYPES)[keyof typeof MESSAGE_EVENT_TYPES];

export const ALL_MESSAGE_EVENT_TYPES: readonly MessageEventType[] = Object.freeze(
  Object.values(MESSAGE_EVENT_TYPES),
);

export interface SendMessageRequest {
  readonly recipientAddress: string;
  readonly templateId?: string | null;
  readonly workspaceId?: string | null;
  readonly payload?: Record<string, unknown>;
}

export interface QueuedMessageResponse {
  readonly id: string;
  readonly status: 'queued';
  readonly createdAt: string;
  readonly correlationId: string;
}

export interface MessageDetailResponse {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly contactId: string;
  readonly channelId: string;
  readonly templateId: string | null;
  readonly status: MessageStatus;
  readonly recipientAddress: string;
  readonly payload: Record<string, unknown>;
  readonly currentAttemptId: string | null;
  readonly failureReason: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}
