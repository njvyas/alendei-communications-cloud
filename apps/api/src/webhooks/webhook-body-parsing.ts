/**
 * Phase 5.0 PR-C — route-scoped raw-body capture for the webhook ingress (implementation
 * plan §1.3; spec §E.1, §E.4; AC-RB-1, AC-SV-3).
 *
 * Only `POST …/webhooks/providers/<key>` gets its exact bytes retained, as a Buffer in
 * `req.body`, bounded by `WEBHOOK_MAX_BODY_BYTES` (a declared `Content-Length` above it is
 * refused before anything is read). The request is then marked parsed (`req._body`, the
 * body-parser convention), so Nest's own JSON and urlencoded parsers skip it. Every other
 * route is parsed exactly as before — Nest's default parsers are not reconfigured, so no
 * other route retains raw bytes or changes behaviour. Signature verification uses these
 * bytes only; the adapter parses the body from the same bytes.
 *
 * A small stream read rather than `express.raw`: `express`/`body-parser` are not declared
 * dependencies of the API (the dependency set is pinned), and the behaviour needed is
 * exactly "read at most N bytes".
 *
 * `main.ts` (through `configureApp`) and the test harness both call this one function. A
 * read failure, and any request on the ingress path other than `POST …/<one key segment>` (no
 * handler; Nest's default 404 would echo the path), are answered here as uniform JSON — Nest's
 * exception filter never sees middleware — and never echo or log the path, which carries the key.
 */
import type { INestApplication } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';
import type { NextFunction, Request, Response } from 'express';

import type { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../observability/metrics.service';
import { isIngressHeaderRoute, isIngressPath, isIngressRoute } from './ingress-path';

/** The exact request bytes on an ingress request (`req.body` is then a Buffer). */
export function ingressRawBody(request: Request): Buffer | undefined {
  return Buffer.isBuffer(request.body) ? (request.body as Buffer) : undefined;
}

type ReadResult = { ok: true; body: Buffer } | { ok: false; tooLarge: boolean };

/** Reads at most `limit` bytes of the request body. */
function readBounded(request: Request, limit: number): Promise<ReadResult> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    return Promise.resolve({ ok: false, tooLarge: true });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: ReadResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.removeAllListeners('data');
        request.resume();
        finish({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish({ ok: true, body: Buffer.concat(chunks, size) }));
    request.on('error', () => finish({ ok: false, tooLarge: false }));
    request.on('aborted', () => finish({ ok: false, tooLarge: false }));
  });
}

export function configureWebhookBodyParsing(app: INestApplication, config: AppConfigService): void {
  const limit = config.delivery.maxBodyBytes;
  const metrics = (() => {
    try {
      return app.get(MetricsService, { strict: false });
    } catch {
      return undefined;
    }
  })();

  app.use((request: Request, response: Response, next: NextFunction) => {
    const url = request.originalUrl ?? request.url;
    const headerForm = isIngressHeaderRoute(url);
    if (!isIngressPath(url) && !headerForm) return next();
    if (request.method !== 'POST' || !(isIngressRoute(url) || headerForm)) {
      // No handler exists here, and Nest's default 404 message would echo the path — the key.
      // Answer with the same uniform, path-free 404 the disabled ingress gives.
      request.resume();
      response.status(404).json({
        error: { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Not found', retryable: false },
      });
      return;
    }
    void readBounded(request, limit).then((result) => {
      if (result.ok) {
        request.body = result.body;
        (request as Request & { _body?: boolean })._body = true;
        return next();
      }
      metrics?.webhookRequests.inc({
        adapter: 'unknown',
        outcome: result.tooLarge ? 'too_large' : 'malformed',
      });
      response.status(result.tooLarge ? 413 : 400).json({
        error: {
          code: result.tooLarge
            ? ERROR_CODES.WEBHOOK_PAYLOAD_TOO_LARGE
            : ERROR_CODES.WEBHOOK_PAYLOAD_INVALID,
          message: result.tooLarge
            ? 'The webhook body is too large'
            : 'The webhook body could not be read',
          retryable: false,
        },
      });
    });
  });
}
