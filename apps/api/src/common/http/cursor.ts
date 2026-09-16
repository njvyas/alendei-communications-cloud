import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';

import { AppException } from '../errors/app.exception';

/**
 * What a cursor carries: the ordering position of the last row on the previous
 * page, and nothing else.
 *
 * `sort` travels with it so a page cannot be continued under a different
 * ordering — a cursor minted for `-createdAt` handed to `?sort=key` describes a
 * position in a sequence that no longer exists, and silently resuming would skip
 * or repeat rows.
 */
export interface CursorPayload {
  /** The sort token the page was minted under (`key`, `-createdAt`, …). */
  readonly s: string;
  /** The sort field's value on the last row, as a string. Absent when sorting by id alone. */
  readonly v?: string;
  /** The last row's id — always present, and always the final tie-breaker. */
  readonly i: string;
}

/**
 * Opaque, integrity-protected cursors (`API.md` §8a).
 *
 * **Why signed.** A cursor is a query continuation, and an unsigned one is a
 * client-supplied predicate: a caller could edit the encoded position, or hand
 * a cursor minted in one tenant to a request in another. The tenant filter and
 * RLS still bound what such a request could read, so this is defence in depth
 * rather than the isolation boundary — but a cursor that can be edited is an
 * input that looks like server state, and treating it as opaque only works if
 * it actually is.
 *
 * **Why not encrypted.** The contents are a sort value and an id the caller has
 * already seen on the previous page. There is nothing to hide, only something
 * to protect from modification, and a MAC says exactly that.
 *
 * The key is derived from the application's existing signing secret, so cursors
 * minted by one instance verify on another and none survive a secret rotation —
 * which is correct: a rotation invalidates outstanding pagination, and a client
 * restarts from the first page.
 */
export class CursorCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Domain-separated from every other use of the same secret, so a cursor MAC
    // can never be confused for a token signature.
    this.key = createHmac('sha256', secret).update('acc:pagination:v1').digest();
  }

  encode(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /**
   * Decodes a cursor, or refuses it.
   *
   * Every failure — malformed, truncated, wrong signature, wrong sort — is the
   * same `400`, because distinguishing them would tell a caller which part of a
   * forged cursor to fix next.
   */
  decode(raw: string, expectedSort: string): CursorPayload {
    const parts = raw.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw this.invalid();

    const [body, signature] = parts as [string, string];
    const expected = this.sign(body);
    const given = Buffer.from(signature, 'utf8');
    const want = Buffer.from(expected, 'utf8');
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw this.invalid();

    let payload: CursorPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload;
    } catch {
      throw this.invalid();
    }

    if (typeof payload?.i !== 'string' || typeof payload?.s !== 'string') throw this.invalid();
    // Continuing under a different ordering would skip or repeat rows, which is
    // worse than refusing: the caller gets a wrong page and no indication.
    if (payload.s !== expectedSort) throw this.invalid();

    return payload;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }

  private invalid(): AppException {
    return new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.PAGINATION_CURSOR_INVALID,
      message: 'The pagination cursor is not valid for this request; start from the first page',
    });
  }
}
