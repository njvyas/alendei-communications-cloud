/**
 * Phase 5.0 PR-C — records and applies ONE webhook element, in its own transaction, as the
 * `acc_delivery` principal (design spec Rev 2 §E.3 step 7, §E.5, §E.7, §B.3–§B.8;
 * implementation plan §1.1–§1.2).
 *
 * Per element:
 *  1. Insert-or-count (plan §1.1): one `webhook_events` row per DISTINCT provider event.
 *     The key is `(provider_id, provider_event_id)` when the provider gave an event id,
 *     otherwise `(provider_id, event_sha256)` of the element's canonical bytes. A repeat
 *     increments `duplicate_count` on the original row and stops — no state change, no
 *     new row (AC-ID-1a). Concurrent identical deliveries serialize on the unique index,
 *     so exactly one of them proceeds (AC-ID-3).
 *  2. A malformed element is recorded `rejected_malformed` with its reason code only.
 *     An informational element (an unsupported provider status) is recorded
 *     `informational` and needs no matching.
 *  3. Correlation through `app_delivery_resolve` (definer, strict since 0048): every
 *     reference the event carries must name the SAME attempt; the provider resolved from the
 *     ingress key is the routing boundary — an attempt of another provider can never match
 *     (AC-TI-1) — and the organization comes ONLY from the matched attempt, never from the
 *     payload (AC-TI-2). Contradictory references never match, so they never change delivery
 *     state or attribute an organization. No match: the row stays `unmatched`; settlement may
 *     apply it later under the same rule (§E.6).
 *  4. Matched: the transaction takes the message lock, then the attempt lock (§B.8, via
 *     the shared writer), and applies the receipt with the shared delivery rules — the same
 *     code the dispatcher's settlement uses. A still-`submitting` attempt is `deferred`; a
 *     closed organization's receipt is `informational` and changes no tenant row (plan
 *     §4.3 default). The row then records the outcome and the match.
 *
 * Lock order note: the new `webhook_events` row is inserted before the message lock. An
 * uncommitted new row is invisible to every other transaction, so it can never be part of
 * a lock cycle with settlement (which locks message → attempt → held rows); a duplicate
 * takes the existing row's lock and commits without touching message or attempt.
 *
 * Never creates, requeues or cancels an attempt; never writes the submission status
 * (§B.6a). Transaction-local context only — nothing survives the transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DELIVERY_SESSION_VARS, SESSION_VARS } from '@acc/db';
import type {
  DeliveryReceiptType,
  NormalizedDeliveryEvent,
  ParsedWebhookElement,
} from '@acc/contracts';
import type { Pool, PoolClient } from 'pg';

import { DELIVERY_POOL } from '../database/database.tokens';
import type { DeliveryOutcome } from '../messages/delivery/delivery-rules';
import {
  applyDeliveryEvent,
  lockMessage,
  type StoredDeliveryEnvelope,
} from '../messages/delivery/delivery-writer';
import { MetricsService } from '../observability/metrics.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The provider facts resolved from the ingress key (migration 0048). */
export interface ResolvedIngressProvider {
  readonly id: string;
  readonly adapterKey: string;
  readonly channel: string;
  readonly receipts: ReadonlySet<DeliveryReceiptType>;
}

export interface IngestionRequest {
  readonly provider: ResolvedIngressProvider;
  /** One id per HTTP request; groups its rows (`webhook_events.request_id`). */
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly signatureTimestamp: Date | null;
}

/** The outcome of one element; `duplicate` is a counter on the original row, never a row. */
export type ElementOutcome = DeliveryOutcome | 'rejected_malformed' | 'unmatched' | 'duplicate';

@Injectable()
export class DeliveryIngestionService {
  constructor(
    @Inject(DELIVERY_POOL) private readonly pool: Pool | null,
    private readonly metrics: MetricsService,
  ) {}

  /** Records and applies element `index` of a verified request; throws on our own failure. */
  async ingest(
    request: IngestionRequest,
    element: ParsedWebhookElement,
    index: number,
  ): Promise<ElementOutcome> {
    if (!this.pool) throw new Error('delivery ingestion is disabled: no acc_delivery pool');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config($1, $2, true)`, [
        DELIVERY_SESSION_VARS.PROVIDER_ID,
        request.provider.id,
      ]);
      const outcome = await this.process(client, request, element, index);
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async process(
    client: PoolClient,
    request: IngestionRequest,
    element: ParsedWebhookElement,
    index: number,
  ): Promise<ElementOutcome> {
    const eventSha256 = createHash('sha256').update(element.canonicalBytes).digest();
    const providerEventId = element.ok ? element.event.providerEventId : element.providerEventId;
    const initial: ElementOutcome = !element.ok
      ? 'rejected_malformed'
      : element.event.kind === 'informational'
        ? 'informational'
        : 'unmatched';
    const normalized = element.ok ? envelopeOf(element.event) : { reason: element.reason };

    const conflictTarget = providerEventId
      ? `(provider_id, provider_event_id) WHERE provider_event_id IS NOT NULL`
      : `(provider_id, event_sha256) WHERE provider_event_id IS NULL`;
    const { rows } = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO webhook_events (provider_id, request_id, event_index, provider_event_id, event_sha256,
                                   signature_timestamp, received_at, outcome, normalized, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               CASE WHEN $8::webhook_event_outcome IN ('unmatched') THEN NULL ELSE now() END)
       ON CONFLICT ${conflictTarget}
       DO UPDATE SET duplicate_count = webhook_events.duplicate_count + 1, last_duplicate_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        request.provider.id,
        request.requestId,
        index,
        providerEventId ?? null,
        eventSha256,
        request.signatureTimestamp,
        request.receivedAt,
        initial,
        normalized,
      ],
    );
    const row = rows[0]!;
    if (!row.inserted) return 'duplicate';
    if (!element.ok || initial === 'informational') return initial;

    const event = element.event;
    // A client reference that is present but not an attempt id cannot name any attempt: the
    // event is unmatched — it is never dropped so that the provider message id alone decides.
    if (event.clientReference !== undefined && !UUID.test(event.clientReference))
      return 'unmatched';
    const reference = event.clientReference ?? null;
    const resolved = await client.query<{
      attempt_id: string;
      message_id: string;
      org_id: string;
      attempt_status: string;
      org_status: string;
    }>(
      `SELECT attempt_id, message_id, org_id, attempt_status, org_status
         FROM app_delivery_resolve($1, $2, $3::uuid)`,
      [request.provider.id, event.providerMessageId ?? null, reference],
    );
    const match = resolved.rows[0];
    if (!match) return 'unmatched';

    // Tenant context comes from the matched attempt only (§E.7), never from the payload.
    await client.query(`SELECT set_config($1, $2, true), set_config($3, $4, true)`, [
      SESSION_VARS.ORG_ID,
      match.org_id,
      DELIVERY_SESSION_VARS.MESSAGE_ID,
      match.message_id,
    ]);

    let outcome: DeliveryOutcome;
    if (match.org_status === 'closed') {
      outcome = 'informational';
    } else {
      await lockMessage(client, match.message_id); // §B.8: message first
      const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;
      const now = new Date();
      const decision = await applyDeliveryEvent(client, {
        orgId: match.org_id,
        messageId: match.message_id,
        attemptId: match.attempt_id,
        kind: event.kind,
        occurredAt,
        receipts: request.provider.receipts,
        webhookEventId: row.id,
        now,
      });
      outcome = decision.outcome;
      if (decision.change) {
        const to =
          decision.emit.includes('read') && !decision.emit.includes('delivered')
            ? 'read'
            : decision.change.deliveryStatus;
        this.metrics.deliveryTransitions.inc({ channel: request.provider.channel, to });
        if (occurredAt) {
          this.metrics.deliveryReceiptLatency.observe(
            { channel: request.provider.channel },
            Math.max(0, (now.getTime() - occurredAt.getTime()) / 1000),
          );
        }
      }
    }

    await client.query(
      `UPDATE webhook_events
          SET outcome = $2, matched_attempt_id = $3, matched_org_id = $4,
              processed_at = CASE WHEN $2::webhook_event_outcome = 'deferred' THEN NULL ELSE now() END
        WHERE id = $1`,
      [row.id, outcome, match.attempt_id, match.org_id],
    );
    return outcome;
  }
}

/** The redacted envelope stored for a valid element (OD-5): references and status only. */
function envelopeOf(event: NormalizedDeliveryEvent): StoredDeliveryEnvelope {
  return {
    kind: event.kind,
    ...(event.providerMessageId ? { providerMessageId: event.providerMessageId } : {}),
    ...(event.clientReference ? { clientReference: event.clientReference } : {}),
    ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
    ...(event.providerStatus ? { providerStatus: event.providerStatus } : {}),
    ...(event.providerErrorCode ? { providerErrorCode: event.providerErrorCode } : {}),
  };
}
