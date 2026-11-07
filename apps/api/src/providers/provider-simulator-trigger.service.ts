/**
 * Phase 5.0 PR-E (implementation plan T11; design spec Rev 2 §F.2(b); OD-16) — the operator
 * simulator trigger:
 *
 *   POST /api/v1/providers/:id/simulator/delivery-events
 *        X-Acc-Webhook-Ingress-Key: <the provider's ingress key>
 *        { "attemptId": "<uuid>", "scenario"?: { …simulator_delivery… } }
 *
 * Platform only (`providers.test_send`, session only), simulator providers only. It builds the
 * signed receipts the scenario specifies for the attempt (the shared `SimulatorWebhookFactory`,
 * client reference only — the attempt id, OD-8) and posts them, synchronously and in order,
 * through the REAL public ingress over loopback, so every receipt meets the same rate limits,
 * key resolution, signature and replay checks, deduplication and ingestion as a provider's.
 *
 * Owner decisions (07-Nov-2026):
 * - The operator supplies the ingress key transiently in `X-Acc-Webhook-Ingress-Key`; ACC keeps
 *   only its peppered hash and cannot recover it. The trigger forwards it ONLY in the same header
 *   of the header-form ingress route — never in a URL — to a fixed loopback destination: this
 *   process's own listening address and port, never a caller-supplied URL. The key is never
 *   stored, audited, logged (the header is redacted), traced or returned.
 * - Target: `attemptId` only. Platform principals read no tenant message or attempt row (Model
 *   B), so a `messageId` would need a definer resolver (a migration); it is not supported in 5.0.
 *   Strict correlation in the ingress decides whether the attempt is matched under this provider.
 * - Audit: the existing `provider.test_sent` action and policy, with
 *   `metadata.tool = 'simulator_delivery_events'`, the scenario, the element count and the
 *   per-request outcomes — never the key.
 *
 * Refused while `DELIVERY_WEBHOOKS_ENABLED` is off (409 WEBHOOK_INGRESS_DISABLED): the ingress it
 * exercises does not exist then. Nothing here sleeps (`delayMs` only offsets `occurredAt`), opens
 * any other connection or reaches a real provider.
 */
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  SIMULATOR_DELIVERY_CAPABILITY,
  validateSimulatorDeliveryCapability,
  type AuthPrincipal,
  type SimulatorDeliveryScenario,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { AppConfigService } from '../config/app-config.service';
import { TenantDatabase } from '../database/tenant-database.service';
import {
  SimulatorWebhookFactory,
  type SimulatorSignedRequest,
} from '../provider-adapters/simulator-webhook';
import { MAX_INGRESS_KEY_LENGTH } from '../webhooks/ingress-key';
import { INGRESS_HEADER_ROUTE_TEMPLATE, INGRESS_KEY_HEADER } from '../webhooks/ingress-path';
import {
  SIMULATOR_WEBHOOK_KEY_SOURCE,
  WebhookSigningKeyUnavailable,
  type SimulatorWebhookKeySourceFn,
} from '../webhooks/simulator-webhook-key';
import { ProviderAccess } from './provider-access.service';
import { ProviderRegistryService } from './provider-registry.service';
import { channelCodeOf, loadProvider } from './provider-views';

export const SIMULATOR_DELIVERY_EVENTS_TOOL = 'simulator_delivery_events';

/** How long one loopback ingress request may take. */
const LOOPBACK_TIMEOUT_MS = 10_000;

/** What the ingress answered to one signed request: the status and, on 200, the element count. */
export interface SimulatorDeliveryRequestOutcome {
  readonly index: number;
  readonly elements: number;
  readonly status: number;
  /** `data.received` on 200; null otherwise. */
  readonly received: number | null;
  /** The error code on a non-200 answer; null on 200. */
  readonly errorCode: string | null;
}

export interface SimulatorDeliveryEventsView {
  readonly providerId: string;
  readonly attemptId: string;
  readonly scenario: SimulatorDeliveryScenario;
  readonly elementCount: number;
  readonly requests: readonly SimulatorDeliveryRequestOutcome[];
}

const invalid = (field: string, message: string) =>
  new AppException({
    status: HttpStatus.BAD_REQUEST,
    code: ERROR_CODES.VALIDATION_FAILED,
    message: 'The request is not valid',
    details: { issues: [{ field, rule: 'INVALID_VALUE', message }] },
  });

@Injectable()
export class ProviderSimulatorTriggerService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly access: ProviderAccess,
    private readonly registry: ProviderRegistryService,
    private readonly config: AppConfigService,
    private readonly adapterHost: HttpAdapterHost,
    @Inject(SIMULATOR_WEBHOOK_KEY_SOURCE)
    private readonly signingKey: SimulatorWebhookKeySourceFn,
  ) {}

  async trigger(
    principal: AuthPrincipal,
    providerId: string,
    input: { attemptId: string; scenario?: Record<string, unknown> },
    ingressKey: string | undefined,
  ): Promise<SimulatorDeliveryEventsView> {
    // 1. Authority, the provider and its scenario — before anything is sent.
    const { scenario } = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_TEST_SEND);
      const provider = await loadProvider(tx, providerId);
      this.registry.assertSimulatorProvider(provider);
      const [stored] = await tx
        .select({ value: schema.providerCapabilities.value })
        .from(schema.providerCapabilities)
        .where(
          and(
            eq(schema.providerCapabilities.providerId, providerId),
            eq(schema.providerCapabilities.capabilityKey, SIMULATOR_DELIVERY_CAPABILITY),
          ),
        );
      const chosen = (input.scenario ?? stored?.value) as unknown;
      if (chosen === undefined || chosen === null) {
        throw invalid(
          'scenario',
          'No scenario: pass one, or configure the provider simulator_delivery capability',
        );
      }
      const check = validateSimulatorDeliveryCapability(chosen);
      if (!check.valid) throw invalid('scenario', check.errors.join('; '));
      const value = chosen as SimulatorDeliveryScenario;
      if (value.read === true && (await channelCodeOf(tx, provider.channelId)) === 'sms') {
        throw invalid('scenario', 'simulator_delivery.read is not available on the sms channel');
      }
      return { scenario: value };
    });

    // 2. The ingress it exercises must exist.
    if (!this.config.delivery.webhooksEnabled) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.WEBHOOK_INGRESS_DISABLED,
        message: 'Webhook ingress is disabled in this environment (DELIVERY_WEBHOOKS_ENABLED)',
        retryable: false,
      });
    }
    // 3. The key, transiently. Its value is never echoed, even in this error.
    if (
      typeof ingressKey !== 'string' ||
      ingressKey.length === 0 ||
      ingressKey.length > MAX_INGRESS_KEY_LENGTH
    ) {
      throw invalid(INGRESS_KEY_HEADER, 'The provider ingress key header is required');
    }

    // 4. Build the signed receipts (deterministic; nothing sleeps) and post them in order.
    let key: Uint8Array;
    try {
      key = await this.signingKey();
    } catch (error) {
      if (!(error instanceof WebhookSigningKeyUnavailable)) throw error;
      throw new AppException({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ERROR_CODES.WEBHOOK_INGRESS_NOT_CONFIGURED,
        message: 'The simulator signing key is not configured',
        retryable: false,
      });
    }
    const requests = new SimulatorWebhookFactory(key).requestsFor(scenario, {
      attemptId: input.attemptId,
      providerMessageId: null,
      nowMs: Date.now(),
    });
    const outcomes: SimulatorDeliveryRequestOutcome[] = [];
    for (const [index, signed] of requests.entries()) {
      outcomes.push({
        index,
        elements: countElements(signed),
        ...(await postToOwnIngress(
          this.adapterHost.httpAdapter.getHttpServer() as Server,
          signed,
          ingressKey,
        )),
      });
    }
    const elementCount = outcomes.reduce((n, o) => n + o.elements, 0);

    // 5. Audit (existing provider.test_sent action and policy) — never the key.
    await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_TEST_SEND);
      await this.access.record(
        tx,
        principal,
        AUDIT_ACTIONS.PROVIDER_TEST_SENT,
        providerId,
        null,
        {},
        'success',
        {
          tool: SIMULATOR_DELIVERY_EVENTS_TOOL,
          attemptId: input.attemptId,
          scenario,
          elementCount,
          requestCount: outcomes.length,
          outcomes: outcomes.map(({ status, received, errorCode }) => ({
            status,
            received,
            errorCode,
          })),
        },
      );
    });

    return { providerId, attemptId: input.attemptId, scenario, elementCount, requests: outcomes };
  }
}

/** The only destinations the trigger ever posts to. */
export type LoopbackHost = '127.0.0.1' | '::1';

/**
 * The loopback address through which a server listening on `address` is reachable, or null.
 * Strict: the result is only ever `127.0.0.1` or `::1`. A wildcard bind is reached through the
 * loopback of its family; a loopback bind through itself (an IPv4-mapped `::ffff:127.0.0.1` as
 * `127.0.0.1`); any other bind — a specific non-loopback interface, or another 127.x address — is
 * not reachable through those two addresses, and is refused rather than used as a destination.
 */
export function loopbackHostFor(address: Pick<AddressInfo, 'address'>): LoopbackHost | null {
  switch (address.address) {
    case '0.0.0.0':
    case '127.0.0.1':
    case '::ffff:127.0.0.1':
      return '127.0.0.1';
    case '::':
    case '::1':
      return '::1';
    default:
      return null;
  }
}

const loopbackUnavailable = () =>
  new AppException({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ERROR_CODES.SERVICE_UNAVAILABLE,
    message: 'The ingress is not reachable over loopback',
    retryable: false,
  });

/**
 * POSTs one signed request to this process's own header-form ingress route, over loopback only:
 * the destination is `127.0.0.1` or `::1` (`loopbackHostFor`) on the port `server` listens on, the
 * path is the fixed route template, and the key travels only in the dedicated header. None of it
 * comes from the caller. A server that is not listening, or is bound only to a non-loopback
 * address, is refused (503) with nothing sent. Exported for the unit tests that pin exactly that.
 */
export async function postToOwnIngress(
  server: Server,
  signed: SimulatorSignedRequest,
  ingressKey: string,
): Promise<Omit<SimulatorDeliveryRequestOutcome, 'index' | 'elements'>> {
  const address = server.address() as AddressInfo | string | null;
  if (!address || typeof address === 'string') throw loopbackUnavailable();
  const host = loopbackHostFor(address);
  if (host === null) throw loopbackUnavailable();
  const body = Buffer.from(signed.rawBody);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host,
        port: address.port,
        method: 'POST',
        path: INGRESS_HEADER_ROUTE_TEMPLATE,
        headers: {
          ...signed.headers,
          'content-length': String(body.length),
          [INGRESS_KEY_HEADER]: ingressKey,
        },
        timeout: LOOPBACK_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          let parsed: { data?: { received?: unknown }; error?: { code?: unknown } } = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // A non-JSON answer is reported by its status alone.
          }
          resolve({
            status,
            received:
              status === 200 && typeof parsed.data?.received === 'number'
                ? parsed.data.received
                : null,
            errorCode:
              status !== 200 && typeof parsed.error?.code === 'string' ? parsed.error.code : null,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('loopback ingress timed out')));
    req.on('error', () =>
      reject(
        new AppException({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          code: ERROR_CODES.SERVICE_UNAVAILABLE,
          message: 'The loopback ingress request failed',
          retryable: true,
        }),
      ),
    );
    req.end(body);
  });
}

/** The number of receipt elements in one signed request. */
function countElements(signed: SimulatorSignedRequest): number {
  const parsed = JSON.parse(new TextDecoder().decode(signed.rawBody)) as { events: unknown[] };
  return parsed.events.length;
}
