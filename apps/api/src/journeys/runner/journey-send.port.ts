import { Injectable } from '@nestjs/common';
import { ERROR_CODES, JOURNEY_RUNNER_LIMITS, type JourneyChannel } from '@acc/contracts';
import type { Transaction } from '@acc/db';

/**
 * Phase 8C PR 8C-5b: the journey send port (handover Rev 2 §7.1).
 *
 * The runner hands a `send_message` node to this port inside its claim-fenced transition
 * transaction (a savepoint of it). **The production binding is `UnavailableJourneySendPort`,
 * which never sends**: the real implementation — the automation capability of 8B-3 and the
 * shared submission core with a journey `SubmissionOrigin` — is 8C-6. Nothing in the journeys
 * module reaches the submission core.
 *
 * A port returns, and never throws for an expected outcome:
 * - `sent`: the message it created **in `tx`**, attributed to this execution (the composite
 *   FK of 0066 and the step <-> message guard prove it when the step is written);
 * - `refused`: the core's refusal code (`ERROR_CODES`), or a transient SQLSTATE;
 * - `unavailable`: sending is not possible in this deployment.
 */
export interface JourneySendInput {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly journeyId: string;
  readonly executionId: string;
  readonly contactId: string;
  readonly nodeKey: string;
  readonly channel: JourneyChannel;
  readonly templateId: string;
  /** The contact's active identity for the channel (primary first, then the oldest). */
  readonly recipient: string;
  /** Resolved from the contact's fields at send time. */
  readonly variables: Readonly<Record<string, string | null>>;
}

export type JourneySendResult =
  | { readonly kind: 'sent'; readonly messageId: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unavailable' };

export interface JourneySendPort {
  send(tx: Transaction, input: JourneySendInput): Promise<JourneySendResult>;
}

export const JOURNEY_SEND_PORT = Symbol('JOURNEY_SEND_PORT');

/** The production binding until 8C-6: every send is `unavailable`, and nothing is written. */
@Injectable()
export class UnavailableJourneySendPort implements JourneySendPort {
  async send(_tx: Transaction, _input: JourneySendInput): Promise<JourneySendResult> {
    return { kind: 'unavailable' };
  }
}

// --- refusal mapping (handover Rev 2 §7.3) --------------------------------------------------

/**
 * What the runner does with a core refusal:
 * - `skip`: step `skipped`, then the node's `onSuppressed` edge;
 * - `refuse`: step `refused`, then the node's `onRefused` edge;
 * - `fail`: step `failed`, and the execution ends `failed` (`node_failed`);
 * - `transient`: nothing recorded; the transition rolls back and retries (8C-3 bound);
 * - `poison`: nothing recorded; retried until the poison bound ends the execution.
 */
export type SendRefusalDisposition = 'skip' | 'refuse' | 'fail' | 'transient' | 'poison';

const SKIP = new Set<string>([ERROR_CODES.RECIPIENT_SUPPRESSED, ERROR_CODES.CONSENT_REVOKED]);
const REFUSE = new Set<string>([
  ERROR_CODES.BILLING_INSUFFICIENT_FUNDS,
  ERROR_CODES.BILLING_ACCOUNT_FROZEN,
  ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED,
  ERROR_CODES.BILLING_PRICE_NOT_CONFIGURED,
  ERROR_CODES.NO_ACTIVE_PROVIDER_ASSIGNMENT,
]);
const FAIL = new Set<string>([
  ERROR_CODES.TEMPLATE_NOT_APPROVED,
  ERROR_CODES.VALIDATION_FAILED,
  ERROR_CODES.RESOURCE_NOT_FOUND,
  ERROR_CODES.CHANNEL_NOT_SUPPORTED,
]);
/** `BILLING_BUSY` and the runner's transient SQLSTATEs (`runner-errors.ts`). */
const TRANSIENT = new Set<string>([
  ERROR_CODES.BILLING_BUSY,
  '40001',
  '40P01',
  '55P03',
  '57014',
  '53300',
  '57P01',
  '08000',
  '08003',
  '08006',
]);

export function sendRefusalDisposition(code: string): SendRefusalDisposition {
  if (SKIP.has(code)) return 'skip';
  if (REFUSE.has(code)) return 'refuse';
  if (TRANSIENT.has(code)) return 'transient';
  if (FAIL.has(code) || code.startsWith('SMS_')) return 'fail';
  return 'poison';
}

// --- outcome semantics (handover Rev 2 §7.4) ------------------------------------------------

/** The outcome columns `acc_journey` may read (0067 column grant). */
export interface SentMessageState {
  readonly status: string;
  readonly deliveryStatus: string | null;
  readonly readAt: Date | null;
}

/**
 * `delivered` ⇔ `delivery_status = 'delivered'`; `read` ⇔ `read_at` set; `failed` ⇔
 * `status = 'failed'` or `delivery_status = 'undelivered'`. `outcome_unknown`, `pending`,
 * `not_supported` and NULL are never an outcome — in particular an unknown outcome is never
 * treated as a failure (the money side stays with 7-6b/7-6c).
 */
export function messageOutcomeReached(
  message: SentMessageState,
  outcome: 'delivered' | 'read' | 'failed',
): boolean {
  switch (outcome) {
    case 'delivered':
      return message.deliveryStatus === 'delivered';
    case 'read':
      return message.readAt !== null;
    case 'failed':
      return message.status === 'failed' || message.deliveryStatus === 'undelivered';
  }
}

/**
 * The next re-check of an armed `wait_for_outcome`: 5-minutely in its first hour, then
 * hourly, never past the deadline.
 */
export function nextOutcomeRecheck(armedAt: Date, deadline: Date, now: Date): Date {
  const L = JOURNEY_RUNNER_LIMITS;
  const elapsed = (now.getTime() - armedAt.getTime()) / 1000;
  const step =
    elapsed < L.outcomeRecheckEarlyWindowSeconds
      ? L.outcomeRecheckEarlySeconds
      : L.outcomeRecheckLateSeconds;
  return new Date(Math.min(deadline.getTime(), now.getTime() + step * 1000));
}
