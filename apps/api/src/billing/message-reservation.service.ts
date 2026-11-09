import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';
import type { Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';

/** What the reservation step did for one message. */
export interface MessageReservationResult {
  /** Paise held for the message; 0 when the price is zero and nothing was posted. */
  readonly reservedPaise: bigint;
  /** False when the price is zero, or the reservation already existed. */
  readonly inserted: boolean;
}

function sqlState(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  if (typeof e?.code === 'string') return e.code;
  return undefined;
}

/**
 * Phase 7 PR 7-4 — funds reservation at submission (`DECISIONS.md` §1zi.7;
 * `docs/PHASE-7-4-RESERVATION-HANDOVER.md`).
 *
 * **The only application code that reserves funds**, and the only caller of
 * `app_message_reserve` — the sole reservation entry point the application role
 * may execute (migration `0053`). It is called by `MessageSubmissionCore` as its
 * last step, in the submission's own transaction, so a reservation commits or
 * rolls back with its message, queue row, event, contact and pricing evaluation.
 *
 * It passes the message id and nothing else: the database derives the
 * organization (from the tenant context), the channel and units (from the
 * message), the account and policy (from the message's snapshot, checked against
 * the organization) and the amount (from rating). It never opens, commits or
 * retries a transaction.
 *
 * Errors (owner decision D-74-1, 09-Nov-2026). Every refusal aborts the
 * transaction; nothing is persisted and no amount is disclosed:
 *
 *   BL003 insufficient funds            → 402 BILLING_INSUFFICIENT_FUNDS
 *   BL007 no price configured           → 422 BILLING_PRICE_NOT_CONFIGURED
 *   BL001 no account of the mode        → 422 BILLING_ACCOUNT_NOT_CONFIGURED
 *   BL002 account frozen                → 403 BILLING_ACCOUNT_FROZEN
 *   55P03 / 40P01 / 40001 contention    → 503 BILLING_BUSY (retryable)
 *
 * Anything else (BL000, BL004, BL005, BL008, 22023, 42501) is a programming
 * error and is rethrown unchanged, so it surfaces as a 500.
 */
@Injectable()
export class MessageReservationService {
  /**
   * Bound on the wait for the organization's billing-account lock — the only
   * billing lock a submission can wait on, and the last lock it takes. `SET LOCAL`
   * replaces the idempotency claim's bound for the rest of the transaction, which
   * from here on writes only rows it owns.
   */
  static readonly ACCOUNT_LOCK_TIMEOUT_MS = 2_000;
  static readonly RETRY_AFTER_SECONDS = 1;

  private readonly logger = new Logger(MessageReservationService.name);

  async reserve(tx: Transaction, messageId: string): Promise<MessageReservationResult> {
    await tx.execute(
      sql`set local lock_timeout = ${sql.raw(String(MessageReservationService.ACCOUNT_LOCK_TIMEOUT_MS))}`,
    );
    try {
      const { rows } = await tx.execute<{ reserved_paise: string; inserted: boolean }>(
        sql`SELECT reserved_paise::text AS reserved_paise, inserted FROM app_message_reserve(${messageId}::uuid)`,
      );
      const row = rows[0];
      if (!row) throw new Error('app_message_reserve returned no row');
      return { reservedPaise: BigInt(row.reserved_paise), inserted: row.inserted };
    } catch (error) {
      throw this.translate(error, messageId);
    }
  }

  private translate(error: unknown, messageId: string): unknown {
    switch (sqlState(error)) {
      case 'BL003':
        return new AppException({
          status: HttpStatus.PAYMENT_REQUIRED,
          code: ERROR_CODES.BILLING_INSUFFICIENT_FUNDS,
          message: 'Insufficient funds to send this message',
        });
      case 'BL007':
        return new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.BILLING_PRICE_NOT_CONFIGURED,
          message: 'No price is configured for this message',
        });
      case 'BL001':
        return new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED,
          message: 'No billing account is configured for this organization',
        });
      case 'BL002':
        return new AppException({
          status: HttpStatus.FORBIDDEN,
          code: ERROR_CODES.BILLING_ACCOUNT_FROZEN,
          message: 'The billing account of this organization is frozen',
        });
      case '55P03':
      case '40P01':
      case '40001':
        this.logger.warn(`message ${messageId}: billing reservation contended; refused as busy`);
        return new AppException({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          code: ERROR_CODES.BILLING_BUSY,
          message: 'Billing is busy for this organization; retry shortly',
          details: { retryAfterSeconds: MessageReservationService.RETRY_AFTER_SECONDS },
        });
      default:
        this.logger.error(`message ${messageId}: billing reservation failed unexpectedly`);
        return error;
    }
  }
}
