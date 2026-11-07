/**
 * Phase 5.0 — the delivery-axis rules, pure (design spec Rev 2 §B.3–§B.6a, Option B).
 *
 * One implementation for every writer: the dispatcher's settlement (PR-B, applying
 * receipts held while the attempt was `submitting`) and the webhook ingestion (PR-C).
 * The database enforces the same invariants independently (`fn_delivery_transition_guard`,
 * migration 0044): these rules decide; the guard refuses anything else.
 *
 * - The submission `status` is never touched (§B.5 rule 4).
 * - Rank: NULL / `pending` / `not_supported` (0) < `undelivered` (1) < `delivered` (2);
 *   it never decreases. `delivered` is terminal for the axis; `undelivered` yields to
 *   positive evidence, recorded as a conflict (§B.3).
 * - `delivered_at` and `read_at` are write-once; provider timestamps set them, never
 *   the ordering (§B.4). A timestamp in the future is clamped to the receive time.
 * - `read` is honoured only when the provider declares it, and implies `delivered`.
 */
import {
  deliveryRank,
  reportsDeliveryOutcome,
  type DeliveryReceiptType,
  type MessageAttemptStatus,
  type MessageDeliveryStatus,
  type NormalizedDeliveryEventKind,
} from '@acc/contracts';

/** The delivery state of one attempt, with its (unchanged) submission status. */
export interface AttemptDeliveryState {
  readonly status: MessageAttemptStatus;
  readonly deliveryStatus: MessageDeliveryStatus | null;
  readonly deliveredAt: Date | null;
  readonly readAt: Date | null;
}

export interface DeliveryEventInput {
  readonly kind: NormalizedDeliveryEventKind;
  readonly occurredAt: Date | null;
}

/** The `webhook_events.outcome` of one event (a duplicate is a counter, never an outcome). */
export type DeliveryOutcome = 'applied' | 'no_change' | 'conflict' | 'informational' | 'deferred';

/** The tenant-lineage events an applied decision appends to `message_events`. */
export type DeliveryEventEmission = 'delivered' | 'undelivered' | 'read' | 'delivery_conflict';

export type DeliveryFlag =
  | 'after_submission_failure'
  | 'unsolicited'
  | 'inferred_from_read'
  | 'read_not_declared'
  | 'clamped_future_timestamp';

export interface AttemptDeliveryChange {
  readonly deliveryStatus: MessageDeliveryStatus;
  readonly deliveredAt: Date | null;
  readonly readAt: Date | null;
}

export interface DeliveryDecision {
  readonly outcome: DeliveryOutcome;
  /** The attempt's new delivery state; absent when nothing changes. */
  readonly change?: AttemptDeliveryChange;
  readonly emit: readonly DeliveryEventEmission[];
  readonly flags: readonly DeliveryFlag[];
}

/** The status an attempt takes when it settles `accepted` or `outcome_unknown` (§B.3 row 1, OD-3). */
export function initialDeliveryStatus(
  receipts: ReadonlySet<DeliveryReceiptType>,
): 'pending' | 'not_supported' {
  return reportsDeliveryOutcome(receipts) ? 'pending' : 'not_supported';
}

/** Decides what one normalised event does to one attempt (§B.3, §B.4, §B.6a rule 1). */
export function decideAttemptDelivery(
  state: AttemptDeliveryState,
  event: DeliveryEventInput,
  receipts: ReadonlySet<DeliveryReceiptType>,
  now: Date,
): DeliveryDecision {
  if (state.status === 'submitting') return { outcome: 'deferred', emit: [], flags: [] };
  if (event.kind === 'informational') return { outcome: 'informational', emit: [], flags: [] };

  const flags: DeliveryFlag[] = [];
  let at = event.occurredAt ?? now;
  if (at.getTime() > now.getTime()) {
    at = now;
    flags.push('clamped_future_timestamp');
  }
  if (state.status === 'failed') flags.push('after_submission_failure');
  const current = state.deliveryStatus;
  const wasUndelivered = current === 'undelivered';

  if (event.kind === 'read') {
    if (!receipts.has('read')) {
      return { outcome: 'informational', emit: [], flags: [...flags, 'read_not_declared'] };
    }
    if (state.readAt !== null) return { outcome: 'no_change', emit: [], flags };
    if (current === 'delivered') {
      return {
        outcome: 'applied',
        change: { deliveryStatus: 'delivered', deliveredAt: state.deliveredAt, readAt: at },
        emit: ['read'],
        flags,
      };
    }
    // A read before (or instead of) delivered: positive evidence of delivery (§B.4).
    flags.push('inferred_from_read');
    return {
      outcome: 'applied',
      change: { deliveryStatus: 'delivered', deliveredAt: at, readAt: at },
      emit: wasUndelivered ? ['delivered', 'delivery_conflict', 'read'] : ['delivered', 'read'],
      flags,
    };
  }

  if (!receipts.has(event.kind)) flags.push('unsolicited');

  if (event.kind === 'delivered') {
    if (current === 'delivered') return { outcome: 'no_change', emit: [], flags };
    return {
      outcome: 'applied',
      change: { deliveryStatus: 'delivered', deliveredAt: at, readAt: state.readAt },
      emit: wasUndelivered ? ['delivered', 'delivery_conflict'] : ['delivered'],
      flags,
    };
  }

  // undelivered
  if (current === 'delivered') return { outcome: 'conflict', emit: ['delivery_conflict'], flags };
  if (current === 'undelivered') return { outcome: 'no_change', emit: [], flags };
  return {
    outcome: 'applied',
    change: { deliveryStatus: 'undelivered', deliveredAt: null, readAt: null },
    emit: ['undelivered'],
    flags,
  };
}

/** One attempt as message-level aggregation sees it. */
export interface AggregateAttempt {
  readonly id: string;
  readonly attemptNumber: number;
  readonly deliveryStatus: MessageDeliveryStatus | null;
  readonly deliveredAt: Date | null;
  readonly readAt: Date | null;
}

export interface MessageDeliveryState {
  readonly currentAttemptId: string | null;
  readonly deliveryStatus: MessageDeliveryStatus | null;
  readonly deliveredAt: Date | null;
  readonly readAt: Date | null;
  readonly deliveredAttemptId: string | null;
}

export type MessageDeliveryTarget = Omit<MessageDeliveryState, 'currentAttemptId'>;

const earliest = (dates: readonly (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);

/**
 * The message's delivery state derived from its attempts (§B.5):
 *  1. any attempt `delivered` ⇒ the message is `delivered`; `delivered_attempt_id` the
 *     first to reach it, `delivered_at` the earliest, `read_at` the earliest read;
 *  2. otherwise it mirrors the current attempt (`current_attempt_id`).
 * Monotonic and write-once like the database guard: a target that would lower the rank,
 * swap two rank-0 values or clear a set value keeps the existing value. Returns `null`
 * when nothing changes.
 */
export function aggregateMessageDelivery(
  message: MessageDeliveryState,
  attempts: readonly AggregateAttempt[],
): MessageDeliveryTarget | null {
  const delivered = attempts.filter((a) => a.deliveryStatus === 'delivered');
  let target: MessageDeliveryTarget;
  if (delivered.length > 0) {
    const first = [...delivered].sort(
      (a, b) =>
        (a.deliveredAt?.getTime() ?? Infinity) - (b.deliveredAt?.getTime() ?? Infinity) ||
        a.attemptNumber - b.attemptNumber,
    )[0]!;
    target = {
      deliveryStatus: 'delivered',
      deliveredAttemptId: message.deliveredAttemptId ?? first.id,
      deliveredAt: message.deliveredAt ?? earliest(delivered.map((a) => a.deliveredAt)),
      readAt: message.readAt ?? earliest(attempts.map((a) => a.readAt)),
    };
  } else {
    const current = attempts.find((a) => a.id === message.currentAttemptId);
    target = {
      deliveryStatus: current?.deliveryStatus ?? null,
      deliveredAttemptId: null,
      deliveredAt: null,
      readAt: null,
    };
  }

  const from = message.deliveryStatus;
  const to = target.deliveryStatus;
  const lowers =
    from !== null &&
    (to === null ||
      deliveryRank(to) < deliveryRank(from) ||
      (deliveryRank(to) === 0 && to !== from));
  if (lowers) {
    target = {
      deliveryStatus: from,
      deliveredAttemptId: message.deliveredAttemptId,
      deliveredAt: message.deliveredAt,
      readAt: message.readAt,
    };
  }

  const same = (a: Date | null, b: Date | null) =>
    (a?.getTime() ?? null) === (b?.getTime() ?? null);
  const unchanged =
    target.deliveryStatus === message.deliveryStatus &&
    target.deliveredAttemptId === message.deliveredAttemptId &&
    same(target.deliveredAt, message.deliveredAt) &&
    same(target.readAt, message.readAt);
  return unchanged ? null : target;
}
