import { CAMPAIGN_PAUSE_REASONS, ERROR_CODES } from '@acc/contracts';

import { campaignRefusal, mintRefusalDetail, refusalCode } from './campaign-refusals';

/** Phase 8B PR 8B-3b: the refusal policy of the campaign executor (OD-8B3-3, Rev 2 §6.3). */
describe('Phase 8B-3b: campaign refusal mapping', () => {
  it.each([
    [ERROR_CODES.BILLING_INSUFFICIENT_FUNDS, 'insufficient_funds'],
    [ERROR_CODES.BILLING_ACCOUNT_FROZEN, 'billing_account'],
    [ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED, 'billing_account'],
    [ERROR_CODES.BILLING_PRICE_NOT_CONFIGURED, 'billing_account'],
    [ERROR_CODES.NO_ACTIVE_PROVIDER_ASSIGNMENT, 'no_provider_assignment'],
    [ERROR_CODES.TEMPLATE_NOT_APPROVED, 'template_not_approved'],
    [ERROR_CODES.CHANNEL_NOT_SUPPORTED, 'channel_not_supported'],
  ])('%s pauses the whole campaign (%s)', (code, reason) => {
    expect(campaignRefusal(code)).toEqual({ kind: 'pause', pauseReason: reason });
    expect(CAMPAIGN_PAUSE_REASONS).toContain(reason);
  });

  it.each([ERROR_CODES.RECIPIENT_SUPPRESSED, ERROR_CODES.CONSENT_REVOKED])(
    '%s skips the recipient',
    (code) => {
      expect(campaignRefusal(code)).toEqual({ kind: 'skip', reason: code.toLowerCase() });
    },
  );

  it.each([
    ERROR_CODES.VALIDATION_FAILED,
    ERROR_CODES.RESOURCE_NOT_FOUND,
    '23503',
    '42501',
    'SMS_DLT_TEMPLATE_MISMATCH',
  ])('%s fails the recipient', (code) => {
    expect(campaignRefusal(code)).toEqual({ kind: 'fail', code });
  });

  it.each([
    ERROR_CODES.BILLING_BUSY,
    '40001',
    '40P01',
    '55P03',
    '57014',
    '53300',
    '57P01',
    '08006',
  ])('%s is transient: nothing is recorded', (code) => {
    expect(campaignRefusal(code)).toEqual({ kind: 'transient' });
  });

  it('anything else, or no code at all, is unexpected (counted toward the poison bound)', () => {
    expect(campaignRefusal(null)).toEqual({ kind: 'unexpected' });
    expect(campaignRefusal('23505')).toEqual({ kind: 'unexpected' });
    expect(campaignRefusal('SOMETHING_NEW')).toEqual({ kind: 'unexpected' });
  });

  it('every pause reason except operator and automation_paused is reachable from a core refusal', () => {
    const reachable = new Set(
      Object.values(ERROR_CODES)
        .map((c) => campaignRefusal(c))
        .filter((r) => r.kind === 'pause')
        .map((r) => (r as { pauseReason: string }).pauseReason),
    );
    expect([...reachable].sort()).toEqual(
      CAMPAIGN_PAUSE_REASONS.filter((r) => r !== 'operator' && r !== 'automation_paused').sort(),
    );
  });

  it('reads the code through Drizzle cause chains, and only bounded string codes', () => {
    expect(refusalCode({ code: 'X1' })).toBe('X1');
    expect(refusalCode({ message: 'wrapped', cause: { cause: { code: '23503' } } })).toBe('23503');
    expect(refusalCode({ code: 42 })).toBeNull();
    expect(refusalCode({ code: 'x'.repeat(101) })).toBeNull();
    expect(refusalCode(new Error('plain'))).toBeNull();
    expect(refusalCode(null)).toBeNull();
  });

  it('reads a mint refusal DETAIL only from an insufficient_privilege error', () => {
    expect(mintRefusalDetail({ cause: { code: '42501', detail: 'AUTOMATION_PAUSED' } })).toBe(
      'AUTOMATION_PAUSED',
    );
    expect(mintRefusalDetail({ code: '23514', detail: 'AUTOMATION_PAUSED' })).toBeNull();
    expect(mintRefusalDetail(new Error('plain'))).toBeNull();
  });
});
