import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  ApproveAccountOperationDto,
  WalletRechargeDto,
  isCalendarDate,
} from './account-operations.dto';

/** PR #101 review: receivedOn / expectedReceivedOn are real calendar dates, not just YYYY-MM-DD. */
describe('calendar-date validation', () => {
  it.each([
    '2024-02-29', // leap year
    '2000-02-29', // leap year (divisible by 400)
    '1999-12-31', // historical
    '1900-01-01', // earliest accepted
    '2026-11-10',
    '2026-01-31',
    '2026-04-30',
  ])('accepts %s', (value) => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each([
    '2026-02-30',
    '2026-02-29', // not a leap year
    '2025-02-29',
    '1900-02-29', // not a leap year (divisible by 100, not 400)
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-32',
    '1899-12-31', // before 1900
    '0000-01-01',
    '2026-1-01',
    '2026/01/01',
    '20260101',
    ' 2026-01-01',
    '',
  ])('refuses %s', (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });

  it('refuses non-strings', () => {
    for (const value of [null, undefined, 20260101, new Date(), {}]) {
      expect(isCalendarDate(value)).toBe(false);
    }
  });

  const errorsOf = (cls: new () => object, body: Record<string, unknown>) =>
    validateSync(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true }).map(
      (e) => e.property,
    );

  it('applies to receivedOn and expectedReceivedOn', () => {
    const recharge = { amountPaise: 1, paymentReference: 'UTR1', reason: 'r' };
    expect(errorsOf(WalletRechargeDto, { ...recharge, receivedOn: '2026-02-30' })).toEqual([
      'receivedOn',
    ]);
    expect(errorsOf(WalletRechargeDto, { ...recharge, receivedOn: '2024-02-29' })).toEqual([]);
    expect(errorsOf(ApproveAccountOperationDto, { expectedReceivedOn: '2025-02-29' })).toEqual([
      'expectedReceivedOn',
    ]);
    expect(errorsOf(ApproveAccountOperationDto, { expectedReceivedOn: '2000-02-29' })).toEqual([]);
  });

  // PR #101 review: omission is valid; an explicit null is not.
  it('approval evidence: omitted is valid, explicit null is refused for either field', () => {
    expect(errorsOf(ApproveAccountOperationDto, {})).toEqual([]);
    expect(errorsOf(ApproveAccountOperationDto, { expectedAmountPaise: 5 })).toEqual([]);
    expect(errorsOf(ApproveAccountOperationDto, { expectedReceivedOn: null })).toEqual([
      'expectedReceivedOn',
    ]);
    expect(errorsOf(ApproveAccountOperationDto, { expectedPaymentReference: null })).toEqual([
      'expectedPaymentReference',
    ]);
    expect(
      errorsOf(ApproveAccountOperationDto, {
        expectedAmountPaise: 5,
        expectedPaymentReference: 'UTR1',
        expectedReceivedOn: '2024-02-29',
      }),
    ).toEqual([]);
  });
});
