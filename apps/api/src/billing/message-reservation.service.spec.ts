import { Logger } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';
import type { Transaction } from '@acc/db';

import { AppException } from '../common/errors/app.exception';
import { MessageReservationService } from './message-reservation.service';

/**
 * Phase 7 PR 7-4: the reservation step's error contract (owner decision D-74-1).
 * The database behaviour is covered by the integration suites; this pins the
 * SQLSTATE → HTTP mapping, including the codes those suites cannot force
 * deterministically (deadlock, serialization failure).
 */
describe('MessageReservationService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  const failingTx = (code: string) => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // set local lock_timeout
      .mockRejectedValueOnce(Object.assign(new Error('Failed query'), { cause: { code } }));
    return { tx: { execute } as unknown as Transaction, execute };
  };

  it.each([
    ['BL003', 402, ERROR_CODES.BILLING_INSUFFICIENT_FUNDS],
    ['BL007', 422, ERROR_CODES.BILLING_PRICE_NOT_CONFIGURED],
    ['BL001', 422, ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED],
    ['BL002', 403, ERROR_CODES.BILLING_ACCOUNT_FROZEN],
    ['55P03', 503, ERROR_CODES.BILLING_BUSY],
    ['40P01', 503, ERROR_CODES.BILLING_BUSY],
    ['40001', 503, ERROR_CODES.BILLING_BUSY],
  ])('maps SQLSTATE %s to %i %s', async (code, status, errorCode) => {
    const { tx } = failingTx(code);
    const error = await new MessageReservationService().reserve(tx, 'm-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect([(error as AppException).getStatus(), (error as AppException).code]).toEqual([
      status,
      errorCode,
    ]);
    if (status === 503) {
      expect((error as AppException).details).toEqual({ retryAfterSeconds: 1 });
    }
  });

  it.each(['BL000', 'BL004', 'BL005', 'BL008', '22023', '42501'])(
    'rethrows %s unchanged (a programming error, surfaced as a 500)',
    async (code) => {
      const { tx } = failingTx(code);
      const error = await new MessageReservationService()
        .reserve(tx, 'm-1')
        .catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(AppException);
      expect((error as { cause: { code: string } }).cause.code).toBe(code);
    },
  );

  it('bounds the account lock before calling the entry point, with the message id only', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reserved_paise: '50', inserted: true }] });
    const result = await new MessageReservationService().reserve(
      { execute } as unknown as Transaction,
      'm-1',
    );
    expect(result).toEqual({ reservedPaise: 50n, inserted: true });
    const [first, second] = execute.mock.calls.map(([query]) =>
      JSON.stringify(query.queryChunks ?? query),
    );
    expect(first).toContain('set local lock_timeout');
    expect(first).toContain('2000');
    expect(second).toContain('app_message_reserve(');
    expect(second).toContain('m-1');
  });
});
