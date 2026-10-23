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
 * 3. Fail-safe: Malformed or unusually short addresses fail to generic mask '••••••' without exposing raw values.
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

    // Fail safe on malformed emails lacking local or domain part
    if (!local || !domain || !domain.includes('.')) {
      return '••••••';
    }

    const maskedLocal =
      local.length <= 2 ? `${local[0] ?? ''}•••` : `${local[0]}••••${local[local.length - 1]}`;

    return `${maskedLocal}@${domain}`;
  }

  // E.164 phone or raw numeric address with leading +
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
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
      const suffix = digits.slice(-4);
      return `${cc} •••• ${suffix}`;
    }
    // Leading + with fewer than 7 digits is malformed/short; fail safely
    return '••••••';
  }

  // Pure numeric address without leading +
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length >= 7 && digitsOnly === trimmed) {
    let cc = '';
    if (digitsOnly.startsWith('1') || digitsOnly.startsWith('7')) {
      cc = digitsOnly[0] ?? '';
    } else if (TWO_DIGIT_CC.has(digitsOnly.slice(0, 2))) {
      cc = digitsOnly.slice(0, 2);
    } else if (digitsOnly.length >= 8) {
      cc = digitsOnly.slice(0, 3);
    } else {
      cc = digitsOnly.slice(0, 2);
    }
    const suffix = digitsOnly.slice(-4);
    return `${cc} •••• ${suffix}`;
  }

  if (trimmed.length >= 7) {
    const prefix = trimmed.slice(0, 3);
    const suffix = trimmed.slice(-4);
    return `${prefix} •••• ${suffix}`;
  }

  return '••••••';
}

/**
 * Context-aware removal of a known message recipient from free-text failure reasons or strings.
 *
 * Invariants:
 * 1. Targeted: Only redacts the specific message recipient, its canonical form, and normalized equivalent forms
 *    (e.g., digits without leading '+', URL-encoded forms).
 * 2. Non-destructive: Strictly preserves unrelated phone/business numbers, queue names, URLs, HTTP status codes,
 *    and other payload text.
 * 3. Fail-safe & Idempotent: If rawRecipient is already masked (contains '•') or empty, preserves text safely.
 */
export function sanitizeRecipientContent(
  text: string | null | undefined,
  rawRecipient: string | null | undefined,
): string {
  if (!text || typeof text !== 'string') return '';
  if (!rawRecipient || typeof rawRecipient !== 'string') return text;

  const trimmedRecipient = rawRecipient.trim();
  // If rawRecipient is already masked or empty, no raw unmasked value is available to match
  if (!trimmedRecipient || trimmedRecipient.includes('•')) {
    return text;
  }

  const masked = maskRecipientAddress(trimmedRecipient);

  // Email matching: case-insensitive, word-bounded
  if (trimmedRecipient.includes('@')) {
    const atIdx = trimmedRecipient.indexOf('@');
    const local = trimmedRecipient.slice(0, atIdx);
    const domain = trimmedRecipient.slice(atIdx + 1);
    if (local && domain) {
      const escaped = trimmedRecipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const emailRegex = new RegExp(`(?<=^|[^a-zA-Z0-9._%+-])${escaped}(?=[^a-zA-Z0-9.-]|$)`, 'gi');
      return text.replaceAll(emailRegex, masked);
    }
    return text;
  }

  // E.164 phone matching
  if (trimmedRecipient.startsWith('+')) {
    const rawDigits = trimmedRecipient.slice(1).replace(/\D/g, '');
    if (rawDigits.length >= 7) {
      const canonical = `+${rawDigits}`;
      const urlEncoded = `%2B${rawDigits}`;
      let result = text;

      // 1. URL-encoded canonical form e.g. %2B12025550199
      result = result.replaceAll(urlEncoded, masked);

      // 2. Canonical form e.g. +12025550199
      result = result.replaceAll(canonical, masked);

      // 3. Digits without leading + e.g. 12025550199 (bounded to avoid substring matches in longer numbers)
      const noPlusRegex = new RegExp(`(?<![0-9+])${rawDigits}(?![0-9])`, 'g');
      result = result.replaceAll(noPlusRegex, masked);

      return result;
    }
  }

  // Non-+ numeric address of length >= 7
  const digitsOnly = trimmedRecipient.replace(/\D/g, '');
  if (digitsOnly.length >= 7 && digitsOnly === trimmedRecipient) {
    const noPlusRegex = new RegExp(`(?<![0-9+])${digitsOnly}(?![0-9])`, 'g');
    return text.replaceAll(noPlusRegex, masked);
  }

  // Exact fallback for short values (avoid loose substring matching)
  if (trimmedRecipient.length >= 4 && text.includes(trimmedRecipient)) {
    return text.replaceAll(trimmedRecipient, masked);
  }

  return text;
}

/**
 * Recursively sanitizes nested message payloads.
 *
 * Invariants:
 * 1. Context-aware: Only masks occurrences of the known message recipient (or its equivalent forms).
 * 2. Does NOT blindly redact arbitrary fields named 'to', 'phone', 'destination', or 'recipient'.
 * 3. Preserves URLs, queue names, business contact numbers, and unrelated message content intact.
 */
export function sanitizeRecipientData<T>(
  data: T,
  rawRecipient: string | null | undefined,
): T {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    return sanitizeRecipientContent(data, rawRecipient) as unknown as T;
  }
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeRecipientData(item, rawRecipient)) as unknown as T;
  }
  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      result[key] = sanitizeRecipientData(val, rawRecipient);
    }
    return result as T;
  }
  return data;
}
