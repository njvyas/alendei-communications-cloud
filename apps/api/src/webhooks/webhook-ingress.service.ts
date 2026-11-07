/**
 * Phase 5.0 PR-C — the provider webhook ingress pipeline for one HTTP request (design spec
 * Rev 2 §E.2–§E.9; implementation plan §1.1–§1.3).
 *
 *  1. Global and per-source-IP rate limit, BEFORE the key is hashed or looked up (429).
 *  2. Hash the key (HMAC with the server pepper) and resolve it through the definer
 *     `app_webhook_provider_resolve` as acc_delivery: current key, or the previous key within
 *     its rotation grace. An unknown key, and a provider whose ingress is switched off
 *     (OD-12 kill switch), get the SAME uniform 401 as a bad signature (AC-SV-2).
 *  3. Per-provider and per-provider-and-IP rate limit (429).
 *  4. Verify with the provider's adapter over the exact raw bytes (§E.4). Failure: the same
 *     uniform 401, a metric and a security log line; NO database row (OD-13).
 *  5. Replay window: the signature timestamp within ±300 s (OD-14) — the adapter checks it,
 *     and it is re-checked here for any adapter that returns a timestamp.
 *  6. Parse (pure). A request malformed as a whole writes nothing: 400, or 413 for more
 *     than 100 elements, with a request-level metric and log line (plan §1.2).
 *  7. Each element in its own transaction (`DeliveryIngestionService`).
 *  8. 200 only once every element is durably recorded; on our own failure a 5xx, and the
 *     provider's retry of the whole request is idempotent element by element (AC-MB-2).
 *
 * Nothing here logs, traces or returns the key or the body.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  WEBHOOK_REPLAY_WINDOW_SECONDS,
  declaredDeliveryReceipts,
  type WebhookVerification,
} from '@acc/contracts';
import type { Pool } from 'pg';

import { AppException } from '../common/errors/app.exception';
import { DELIVERY_POOL } from '../database/database.tokens';
import { MetricsService } from '../observability/metrics.service';
import {
  ProviderSubmissionExecutor,
  WebhookVerificationUnavailable,
} from '../provider-adapters/submission-executor';
import {
  DeliveryIngestionService,
  type ResolvedIngressProvider,
} from './delivery-ingestion.service';
import { MAX_INGRESS_KEY_LENGTH } from './ingress-key';
import { IngressKeyHasher } from './webhook-key-material.module';
import { WebhookRateLimiter } from './webhook-rate-limiter';

export interface IngressRequest {
  readonly providerKey: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Buffer | undefined;
  readonly contentType: string | undefined;
  readonly ip: string;
  readonly receivedAt: Date;
}

export interface IngressResult {
  readonly received: number;
}

/** The one response for an unknown key, a disabled ingress and a failed signature. */
function notAccepted(): AppException {
  return new AppException({
    status: HttpStatus.UNAUTHORIZED,
    code: ERROR_CODES.WEBHOOK_NOT_ACCEPTED,
    message: 'The webhook was not accepted',
    retryable: false,
  });
}

@Injectable()
export class WebhookIngressService {
  private readonly logger = new Logger(WebhookIngressService.name);

  constructor(
    @Inject(DELIVERY_POOL) private readonly pool: Pool | null,
    private readonly limiter: WebhookRateLimiter,
    private readonly hasher: IngressKeyHasher,
    private readonly executor: ProviderSubmissionExecutor,
    private readonly ingestion: DeliveryIngestionService,
    private readonly metrics: MetricsService,
  ) {}

  async handle(request: IngressRequest): Promise<IngressResult> {
    // 1. Before any key handling (AC-RL-1).
    const early = await this.limiter.beforeResolution(request.ip);
    if (!early.allowed) throw this.rateLimited('unknown', early.retryAfterSeconds);

    if (!request.rawBody || !isJson(request.contentType)) {
      this.metrics.webhookRequests.inc({ adapter: 'unknown', outcome: 'unsupported_media_type' });
      throw new AppException({
        status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        code: ERROR_CODES.WEBHOOK_UNSUPPORTED_MEDIA_TYPE,
        message: 'The webhook body must be application/json',
        retryable: false,
      });
    }

    // 2. Resolve the key (hash only; the key itself is never stored, logged or returned).
    const provider = await this.resolve(request.providerKey);
    if (!provider) {
      this.metrics.webhookRequests.inc({ adapter: 'unknown', outcome: 'not_accepted' });
      throw notAccepted();
    }

    // 3. Per provider, after resolution.
    const late = await this.limiter.afterResolution(provider.id, request.ip);
    if (!late.allowed) throw this.rateLimited(provider.adapterKey, late.retryAfterSeconds);

    // 4–5. Adapter-owned signature over the raw bytes; replay window.
    const context = {
      providerId: provider.id,
      adapterKey: provider.adapterKey,
      channel: provider.channel as never,
      capabilities: { delivery_receipts: [...provider.receipts] },
    };
    let verification: WebhookVerification;
    try {
      verification = await this.executor.verifyWebhook(context, {
        headers: request.headers,
        rawBody: request.rawBody,
        receivedAt: request.receivedAt,
      });
    } catch (error) {
      if (error instanceof WebhookVerificationUnavailable) {
        this.metrics.webhookRequests.inc({ adapter: provider.adapterKey, outcome: 'error' });
        throw new AppException({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          code: ERROR_CODES.WEBHOOK_INGRESS_NOT_CONFIGURED,
          message: 'Webhook verification is not configured for this provider',
          retryable: false,
        });
      }
      throw error;
    }
    if (verification.verified && verification.signatureTimestamp) {
      const skew = Math.abs(
        request.receivedAt.getTime() - verification.signatureTimestamp.getTime(),
      );
      if (skew > WEBHOOK_REPLAY_WINDOW_SECONDS * 1000) {
        verification = { verified: false, reason: 'stale_timestamp' };
      }
    }
    if (!verification.verified) {
      this.metrics.webhookVerificationFailures.inc({
        adapter: provider.adapterKey,
        reason: verification.reason,
      });
      this.metrics.webhookRequests.inc({ adapter: provider.adapterKey, outcome: 'not_accepted' });
      this.logger.warn({
        msg: 'webhook verification failed',
        providerId: provider.id,
        adapter: provider.adapterKey,
        reason: verification.reason,
      });
      throw notAccepted();
    }

    // 6. Parse; a request malformed as a whole writes nothing.
    const parsed = this.executor.parseWebhook(context, {
      rawBody: request.rawBody,
      receivedAt: request.receivedAt,
      ...(verification.signatureTimestamp
        ? { signatureTimestamp: verification.signatureTimestamp }
        : {}),
    });
    if (!parsed.ok) {
      const tooMany = parsed.reason === 'too_many_events';
      this.metrics.webhookRequests.inc({
        adapter: provider.adapterKey,
        outcome: tooMany ? 'too_large' : 'malformed',
      });
      this.logger.warn({
        msg: 'webhook request malformed',
        providerId: provider.id,
        adapter: provider.adapterKey,
        reason: parsed.reason,
        bodySha256: createHash('sha256').update(request.rawBody).digest('hex'),
      });
      throw new AppException({
        status: tooMany ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST,
        code: tooMany ? ERROR_CODES.WEBHOOK_PAYLOAD_TOO_LARGE : ERROR_CODES.WEBHOOK_PAYLOAD_INVALID,
        message: tooMany
          ? 'The webhook carries too many events'
          : 'The webhook body is not a valid batch of events',
        retryable: false,
      });
    }

    // 7–8. Each element durably recorded, in order, before the 200.
    const ingestion = {
      provider,
      requestId: randomUUID(),
      receivedAt: request.receivedAt,
      signatureTimestamp: verification.signatureTimestamp ?? null,
    };
    for (let index = 0; index < parsed.elements.length; index += 1) {
      try {
        const outcome = await this.ingestion.ingest(ingestion, parsed.elements[index]!, index);
        this.metrics.webhookEvents.inc({ adapter: provider.adapterKey, outcome });
      } catch (error) {
        this.metrics.webhookRequests.inc({ adapter: provider.adapterKey, outcome: 'error' });
        this.logger.error({
          msg: 'webhook event could not be recorded; the provider will retry the request',
          providerId: provider.id,
          adapter: provider.adapterKey,
          eventIndex: index,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new AppException({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          code: ERROR_CODES.SERVICE_UNAVAILABLE,
          message: 'The webhook could not be recorded; retry the request',
        });
      }
    }
    this.metrics.webhookRequests.inc({ adapter: provider.adapterKey, outcome: 'accepted' });
    return { received: parsed.elements.length };
  }

  /** The provider an ingress key names, or null (unknown, expired previous, or ingress off). */
  private async resolve(providerKey: string): Promise<ResolvedIngressProvider | null> {
    if (providerKey.length === 0 || providerKey.length > MAX_INGRESS_KEY_LENGTH) return null;
    if (!this.pool) return null;
    const hash = await this.hasher.hash(providerKey);
    const { rows } = await this.pool.query<{
      provider_id: string;
      adapter_key: string;
      channel_code: string;
      ingress_enabled: boolean;
      delivery_receipts: unknown;
    }>(
      `SELECT provider_id, adapter_key, channel_code, ingress_enabled, delivery_receipts
         FROM app_webhook_provider_resolve($1)`,
      [hash],
    );
    const row = rows[0];
    if (!row || !row.ingress_enabled) return null;
    return {
      id: row.provider_id,
      adapterKey: row.adapter_key,
      channel: row.channel_code,
      receipts: declaredDeliveryReceipts(row.delivery_receipts),
    };
  }

  private rateLimited(adapter: string, retryAfterSeconds?: number): AppException {
    this.metrics.webhookRequests.inc({ adapter, outcome: 'rate_limited' });
    return new AppException({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
      message: 'Too many webhook requests',
      ...(retryAfterSeconds ? { details: { retryAfterSeconds } } : {}),
    });
  }
}

function isJson(contentType: string | undefined): boolean {
  return (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}
