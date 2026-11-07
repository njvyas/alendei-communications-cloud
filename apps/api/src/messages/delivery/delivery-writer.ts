/**
 * Phase 5.0 — delivery-state persistence, shared by every writer (design spec Rev 2
 * §B.5, §B.7, §B.8, §E.6; implementation plan T6).
 *
 * Principal-agnostic: the caller owns the transaction and its context — `acc_dispatch`
 * at settlement (live claim, `app.current_org_id`), or `acc_delivery` at ingestion
 * (PR-C: `app.current_org_id`, `app.delivery_provider_id`, `app.delivery_message_id`).
 * RLS and the column grants of migration 0044 bound what either can touch.
 *
 * Lock order (§B.8, normative for every writer): the message row (`FOR UPDATE`) first,
 * then the affected attempt (`FOR UPDATE`), then `webhook_events`. `lockMessage` must be
 * the first lock a caller takes on these rows; every function below assumes it is held.
 *
 * Writes nothing outside the delivery columns, `message_events` and the outcome columns
 * of `webhook_events`; never the submission status, never an attempt, a requeue or a
 * send (§B.6a rules 3–4).
 */
import {
  MESSAGE_EVENT_TYPES,
  type DeliveryReceiptType,
  type MessageAttemptStatus,
  type MessageDeliveryStatus,
  type NormalizedDeliveryEventKind,
} from '@acc/contracts';
import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import {
  aggregateMessageDelivery,
  decideAttemptDelivery,
  type DeliveryDecision,
  type DeliveryEventEmission,
  type DeliveryOutcome,
} from './delivery-rules';

/**
 * The redacted envelope stored in `webhook_events.normalized` for a valid element (OD-5):
 * references and status only — never a recipient address or content.
 */
export interface StoredDeliveryEnvelope {
  readonly kind: NormalizedDeliveryEventKind;
  readonly providerMessageId?: string;
  readonly clientReference?: string;
  readonly occurredAt?: string;
  readonly providerStatus?: string;
  readonly providerErrorCode?: string;
}

const EMIT_TYPE: Readonly<Record<DeliveryEventEmission, string>> = {
  delivered: MESSAGE_EVENT_TYPES.DELIVERED,
  undelivered: MESSAGE_EVENT_TYPES.UNDELIVERED,
  read: MESSAGE_EVENT_TYPES.READ,
  delivery_conflict: MESSAGE_EVENT_TYPES.DELIVERY_CONFLICT,
};

interface MessageRow {
  readonly org_id: string;
  readonly current_attempt_id: string | null;
  readonly delivery_status: MessageDeliveryStatus | null;
  readonly delivered_at: Date | null;
  readonly read_at: Date | null;
  readonly delivered_attempt_id: string | null;
}

/** Takes the message row lock — the first lock of every delivery-state writer (§B.8). */
export async function lockMessage(client: PoolClient, messageId: string): Promise<MessageRow> {
  const { rows } = await client.query<MessageRow>(
    `SELECT org_id, current_attempt_id, delivery_status, delivered_at, read_at, delivered_attempt_id
       FROM messages WHERE id = $1 FOR UPDATE`,
    [messageId],
  );
  if (!rows[0]) throw new Error(`delivery: message ${messageId} is not visible to this principal`);
  return rows[0];
}

interface AttemptRow {
  readonly id: string;
  readonly message_id: string;
  readonly provider_id: string;
  readonly attempt_number: number;
  readonly status: MessageAttemptStatus;
  readonly provider_message_id: string | null;
  readonly delivery_status: MessageDeliveryStatus | null;
  readonly delivered_at: Date | null;
  readonly read_at: Date | null;
}

async function lockAttempt(client: PoolClient, attemptId: string): Promise<AttemptRow> {
  const { rows } = await client.query<AttemptRow>(
    `SELECT id, message_id, provider_id, attempt_number, status, provider_message_id,
            delivery_status, delivered_at, read_at
       FROM message_attempts WHERE id = $1 FOR UPDATE`,
    [attemptId],
  );
  if (!rows[0]) throw new Error(`delivery: attempt ${attemptId} is not visible to this principal`);
  return rows[0];
}

/**
 * Re-derives the message's delivery state from its attempts (§B.5) under the held message
 * lock and writes it if it changed.
 */
async function refreshMessageDelivery(
  client: PoolClient,
  messageId: string,
  message: MessageRow,
): Promise<void> {
  const attemptResult = await client.query<{
    id: string;
    attempt_number: number;
    delivery_status: MessageDeliveryStatus | null;
    delivered_at: Date | null;
    read_at: Date | null;
  }>(
    `SELECT id, attempt_number, delivery_status, delivered_at, read_at
       FROM message_attempts WHERE message_id = $1 ORDER BY attempt_number`,
    [messageId],
  );
  const attempts = attemptResult.rows;
  const target = aggregateMessageDelivery(
    {
      currentAttemptId: message.current_attempt_id,
      deliveryStatus: message.delivery_status,
      deliveredAt: message.delivered_at,
      readAt: message.read_at,
      deliveredAttemptId: message.delivered_attempt_id,
    },
    attempts.map((a) => ({
      id: a.id,
      attemptNumber: a.attempt_number,
      deliveryStatus: a.delivery_status,
      deliveredAt: a.delivered_at,
      readAt: a.read_at,
    })),
  );
  if (!target) return;
  await client.query(
    `UPDATE messages
        SET delivery_status = $2, delivered_at = $3, read_at = $4, delivered_attempt_id = $5,
            updated_at = now()
      WHERE id = $1`,
    [
      messageId,
      target.deliveryStatus,
      target.deliveredAt,
      target.readAt,
      target.deliveredAttemptId,
    ],
  );
}

/**
 * Re-derives the message's delivery state from its attempts (§B.5). The caller holds the
 * message lock; used at settlement, after the attempt settled with its initial delivery
 * status (the provider message id and that status are written in the statement that settles
 * the attempt — the terminal guard admits no later provider reference).
 */
export async function refreshMessageDeliveryState(
  client: PoolClient,
  messageId: string,
): Promise<void> {
  const message = await lockMessage(client, messageId);
  await refreshMessageDelivery(client, messageId, message);
}

export interface ApplyDeliveryEventInput {
  readonly orgId: string;
  readonly messageId: string;
  readonly attemptId: string;
  readonly kind: NormalizedDeliveryEventKind;
  readonly occurredAt: Date | null;
  readonly receipts: ReadonlySet<DeliveryReceiptType>;
  /** The `webhook_events` row this event is recorded in, for lineage. */
  readonly webhookEventId: string;
  readonly now: Date;
}

/**
 * Applies one normalised event to one attempt and re-derives the message (§B.3–§B.6a),
 * appending the tenant-lineage `message_events`. The caller holds the message lock.
 * A semantic duplicate (`no_change`) appends nothing (AC-ID-2).
 */
export async function applyDeliveryEvent(
  client: PoolClient,
  input: ApplyDeliveryEventInput,
): Promise<DeliveryDecision> {
  const before = await lockMessage(client, input.messageId);
  const attempt = await lockAttempt(client, input.attemptId);
  if (attempt.message_id !== input.messageId) {
    throw new Error('delivery: the attempt does not belong to the locked message');
  }
  const decision = decideAttemptDelivery(
    {
      status: attempt.status,
      deliveryStatus: attempt.delivery_status,
      deliveredAt: attempt.delivered_at,
      readAt: attempt.read_at,
    },
    { kind: input.kind, occurredAt: input.occurredAt },
    input.receipts,
    input.now,
  );

  if (decision.change) {
    await client.query(
      `UPDATE message_attempts
          SET delivery_status = $2, delivered_at = $3, read_at = $4, delivery_updated_at = now()
        WHERE id = $1`,
      [
        input.attemptId,
        decision.change.deliveryStatus,
        decision.change.deliveredAt,
        decision.change.readAt,
      ],
    );
    await refreshMessageDelivery(client, input.messageId, before);
  }

  const lineage = {
    attemptId: input.attemptId,
    attemptNumber: attempt.attempt_number,
    webhookEventId: input.webhookEventId,
    ...(input.occurredAt ? { occurredAt: input.occurredAt.toISOString() } : {}),
    ...(decision.flags.length > 0 ? { flags: decision.flags } : {}),
  };
  for (const emission of decision.emit) {
    await insertMessageEvent(client, input, EMIT_TYPE[emission], {
      ...lineage,
      ...(emission === 'delivery_conflict'
        ? { previous: attempt.delivery_status, reported: input.kind }
        : {}),
    });
  }
  // §B.6: a second attempt reaching `delivered` while another already had — recorded, no action.
  if (
    decision.change?.deliveryStatus === 'delivered' &&
    attempt.delivery_status !== 'delivered' &&
    before.delivery_status === 'delivered' &&
    before.delivered_attempt_id !== null &&
    before.delivered_attempt_id !== input.attemptId
  ) {
    await insertMessageEvent(client, input, MESSAGE_EVENT_TYPES.DELIVERY_DUPLICATE, {
      attemptIds: [before.delivered_attempt_id, input.attemptId],
      webhookEventId: input.webhookEventId,
    });
  }
  return decision;
}

async function insertMessageEvent(
  client: PoolClient,
  input: { readonly orgId: string; readonly messageId: string; readonly attemptId: string },
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO message_events (id, org_id, message_id, attempt_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv7(), input.orgId, input.messageId, input.attemptId, eventType, JSON.stringify(payload)],
  );
}

export interface HeldReceiptResult {
  readonly webhookEventId: string;
  readonly outcome: DeliveryOutcome;
}

/**
 * Settlement (§E.6): applies the `deferred` and `unmatched` receipts held for the attempt
 * being settled, in this transaction, oldest first, and settles their outcome. A held row
 * belongs to this attempt when it was matched to it, or — unmatched — when its provider
 * message id equals the one just recorded, or its client reference is this attempt and it
 * names no different provider message id. Rows of another provider are never considered
 * (and RLS hides them from `acc_dispatch` regardless). Locks follow the message and the
 * attempt (§B.8). Never creates, requeues or cancels an attempt (§B.6a).
 */
export async function applyHeldReceipts(
  client: PoolClient,
  input: {
    readonly orgId: string;
    readonly messageId: string;
    readonly attemptId: string;
    readonly providerId: string;
    readonly providerMessageId: string | null;
    readonly receipts: ReadonlySet<DeliveryReceiptType>;
    readonly now: Date;
  },
): Promise<HeldReceiptResult[]> {
  const { rows } = await client.query<{
    id: string;
    matched_attempt_id: string | null;
    normalized: StoredDeliveryEnvelope;
  }>(
    `SELECT id, matched_attempt_id, normalized
       FROM webhook_events
      WHERE provider_id = $1
        AND outcome IN ('deferred', 'unmatched')
        AND (matched_attempt_id = $2
             OR (matched_attempt_id IS NULL AND (
                   ($3::text IS NOT NULL AND normalized->>'providerMessageId' = $3::text)
                   OR (normalized->>'clientReference' = $2::text
                       AND (normalized->>'providerMessageId' IS NULL
                            OR normalized->>'providerMessageId' = $3::text)))))
      ORDER BY received_at, request_id, event_index
      FOR UPDATE`,
    [input.providerId, input.attemptId, input.providerMessageId],
  );
  const results: HeldReceiptResult[] = [];
  for (const row of rows) {
    const envelope = row.normalized;
    const occurredAt = envelope.occurredAt ? new Date(envelope.occurredAt) : null;
    const decision = await applyDeliveryEvent(client, {
      orgId: input.orgId,
      messageId: input.messageId,
      attemptId: input.attemptId,
      kind: envelope.kind,
      occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
      receipts: input.receipts,
      webhookEventId: row.id,
      now: input.now,
    });
    await client.query(
      `UPDATE webhook_events
          SET outcome = $2, matched_attempt_id = $3, matched_org_id = $4, processed_at = now()
        WHERE id = $1`,
      [row.id, decision.outcome, input.attemptId, input.orgId],
    );
    results.push({ webhookEventId: row.id, outcome: decision.outcome });
  }
  return results;
}
