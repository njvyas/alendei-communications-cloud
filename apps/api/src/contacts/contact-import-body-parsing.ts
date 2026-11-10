import type { INestApplication } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';
import type { NextFunction, Request, Response } from 'express';

export const CONTACT_IMPORT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

type ReadResult = { ok: true; body: Buffer } | { ok: false; tooLarge: boolean };

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
    request.on('end', () => finish({ ok: true, body: Buffer.concat(chunks) }));
    request.on('error', () => finish({ ok: false, tooLarge: false }));
  });
}

function isContactImportRoute(url: string): boolean {
  // Matches e.g. /v1/workspaces/:workspaceId/contacts/import or /workspaces/:workspaceId/contacts/import
  return /\/workspaces\/[^/]+\/contacts\/import(?:\?.*)?$/i.test(url);
}

/**
 * Route-scoped body parsing for contact imports up to 5 MB.
 * Handles both JSON payloads and raw CSV streams.
 * Prevents Express's default 100kb limit from aborting the request.
 */
export function configureContactImportBodyParsing(app: INestApplication): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const url = request.originalUrl ?? request.url;
    if (request.method !== 'POST' || !isContactImportRoute(url)) {
      return next();
    }

    void readBounded(request, CONTACT_IMPORT_MAX_BODY_BYTES).then((result) => {
      if (!result.ok) {
        response.status(result.tooLarge ? 413 : 400).json({
          error: {
            code: result.tooLarge
              ? ERROR_CODES.IMPORT_PAYLOAD_TOO_LARGE
              : ERROR_CODES.VALIDATION_FAILED,
            message: result.tooLarge
              ? 'Import payload exceeds 5 MB limit'
              : 'The import body could not be read',
            retryable: false,
          },
        });
        return;
      }

      const contentType = (request.headers['content-type'] ?? '').toLowerCase();
      const rawText = result.body.toString('utf-8');

      if (contentType.includes('application/json')) {
        try {
          request.body = rawText.trim() === '' ? {} : JSON.parse(rawText);
        } catch {
          response.status(400).json({
            error: {
              code: ERROR_CODES.VALIDATION_FAILED,
              message: 'Invalid JSON payload',
              retryable: false,
            },
          });
          return;
        }
      } else {
        // Assume text/csv or plain text
        request.body = { csv: rawText };
      }

      (request as Request & { _body?: boolean })._body = true;
      next();
    });
  });
}
