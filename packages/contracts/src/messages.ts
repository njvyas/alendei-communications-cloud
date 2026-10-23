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

/** `POST /messages` body — mirrors `SendMessageDto`. */
export interface SendMessageRequest {
  readonly channelCode: string;
  readonly recipient: string;
  readonly templateId?: string;
  readonly workspaceId?: string;
  readonly payload: Record<string, unknown>;
}

export interface QueuedMessageResponse {
  readonly id: string;
  readonly status: 'queued';
  readonly createdAt: string;
  readonly correlationId: string;
}

/** One dispatch attempt as `GET /messages/:id` returns it, ordered by `attemptNumber`. */
export interface MessageAttemptResponse {
  readonly id: string;
  readonly attemptNumber: number;
  readonly providerId: string;
  readonly status: MessageAttemptStatus;
  readonly failureReason: string | null;
  readonly latencyMs: number | null;
  readonly completedAt: string | null;
}

/**
 * One row of `GET /messages` — metadata and an attempt count only. The payload
 * and per-attempt detail are on `GET /messages/:id`.
 */
export interface MessageSummaryResponse {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly contactId: string;
  readonly channelId: string;
  readonly channelCode: string;
  readonly templateId: string | null;
  readonly status: MessageStatus;
  readonly recipientAddress: string;
  readonly failureReason: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/** `GET /messages/:id` — exactly the fields `MessagesService.getMessage` returns. */
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
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly attempts: readonly MessageAttemptResponse[];
}

const TWO_DIGIT_CC = new Set([
  '20',
  '27',
  '28',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '81',
  '82',
  '84',
  '86',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '98',
]);

/**
 * Masks a recipient address (phone number or email) while preserving prefix/suffix context.
 *
 * Invariants:
 * 1. Permanent masking: API ordinary list and detail responses never return full unmasked numbers.
 * 2. Idempotent: If address is already masked (contains '•'), returns it unchanged without double-masking.
 *
 * Examples:
 * - Phone: `+12025550199` -> `+1 •••• 0199`
 * - Phone: `+447911123456` -> `+44 •••• 3456`
 * - Email: `user@example.com` -> `u••••r@example.com`
 * - Short email: `ab@c.com` -> `a•••@c.com`
 */
export function maskRecipientAddress(address: string | null | undefined): string {
  if (!address) return '';
  const trimmed = address.trim();
  if (!trimmed) return '';

  // Idempotency check: if already masked, do not re-mask
  if (trimmed.includes('•')) {
    return trimmed;
  }

  // Email masking: user@example.com -> u••••r@example.com
  if (trimmed.includes('@')) {
    const atIndex = trimmed.indexOf('@');
    const local = trimmed.slice(0, atIndex);
    const domain = trimmed.slice(atIndex + 1);

    if (!domain) return trimmed;

    const maskedLocal =
      local.length <= 2 ? `${local[0] ?? ''}•••` : `${local[0]}••••${local[local.length - 1]}`;

    return `${maskedLocal}@${domain}`;
  }

  // E.164 phone or raw numeric address:
  // E.164: + followed by 7-15 digits
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1);
    if (digits.length >= 7) {
      let cc = '+1';
      if (digits.startsWith('1') || digits.startsWith('7')) {
        cc = `+${digits[0]}`;
      } else if (TWO_DIGIT_CC.has(digits.slice(0, 2))) {
        cc = `+${digits.slice(0, 2)}`;
      } else if (digits.length >= 8) {
        cc = `+${digits.slice(0, 3)}`;
      } else {
        cc = `+${digits.slice(0, 2)}`;
      }
      const suffix = trimmed.slice(-4);
      return `${cc} •••• ${suffix}`;
    }
  }

  if (trimmed.length > 6) {
    const prefix = trimmed.slice(0, 3);
    const suffix = trimmed.slice(-4);
    return `${prefix} •••• ${suffix}`;
  }

  return '••••••';
}
