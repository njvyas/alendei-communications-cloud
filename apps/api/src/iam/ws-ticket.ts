import { createHash, randomBytes } from 'node:crypto';

/**
 * WebSocket connection-ticket material (`API.md` §10, `DATABASE.md` §2).
 *
 * The same construction as `refresh-token.ts`, and for the same reasons, stated
 * here rather than cross-imported so neither file's name has to lie about what
 * it mints: the value is opaque CSPRNG output with no structure to forge and no
 * claims to tamper with, and only its SHA-256 is persisted, so a database read
 * or a leaked backup yields nothing presentable.
 *
 * SHA-256 rather than Argon2id is deliberate and is not a weakening. The input
 * is 256 bits of random rather than a human-chosen secret, so there is no
 * guessable distribution for a slow KDF to defend; and the ticket is looked up
 * *by hash* at connect time, which a deliberately-slow function would make
 * pathological on a credential that lives about thirty seconds.
 */

/** Bytes of entropy in a ticket. Matches the refresh token. */
const TICKET_BYTES = 32;

export interface WsTicketMaterial {
  /** Returned to the caller exactly once, then unrecoverable. */
  readonly ticket: string;
  /** The only form ever persisted. */
  readonly hash: string;
}

export function hashWsTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

export function issueWsTicket(): WsTicketMaterial {
  const ticket = randomBytes(TICKET_BYTES).toString('base64url');
  return { ticket, hash: hashWsTicket(ticket) };
}
