import { ERROR_CODES, type CampaignPauseReason } from '@acc/contracts';

/**
 * Phase 8B PR 8B-3b: what the campaign executor does with a refusal of the shared core
 * (PHASE-8B-3-HANDOVER-Rev2 §6.3, owner decision OD-8B3-3):
 *
 * - `skip`: the recipient is skipped (suppression, revoked consent);
 * - `fail`: the recipient failed (a per-recipient validation problem, or a contact/identity
 *   mismatch refused by the database);
 * - `pause`: the refusal concerns the WHOLE campaign (billing, provider assignment, template,
 *   channel). The campaign is paused automatically with this reason, the recipient stays
 *   pending, and nothing else is sent until an operator resumes it;
 * - `transient`: nothing is recorded; the claim is released with backoff;
 * - `unexpected`: counted on the recipient, which fails after `unexpectedAttempts`.
 */
export type CampaignRefusal =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'fail'; readonly code: string }
  | { readonly kind: 'pause'; readonly pauseReason: CampaignPauseReason }
  | { readonly kind: 'transient' }
  | { readonly kind: 'unexpected' };

const PAUSE: Readonly<Record<string, CampaignPauseReason>> = {
  [ERROR_CODES.BILLING_INSUFFICIENT_FUNDS]: 'insufficient_funds',
  [ERROR_CODES.BILLING_ACCOUNT_FROZEN]: 'billing_account',
  [ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED]: 'billing_account',
  [ERROR_CODES.BILLING_PRICE_NOT_CONFIGURED]: 'billing_account',
  [ERROR_CODES.NO_ACTIVE_PROVIDER_ASSIGNMENT]: 'no_provider_assignment',
  [ERROR_CODES.TEMPLATE_NOT_APPROVED]: 'template_not_approved',
  [ERROR_CODES.CHANNEL_NOT_SUPPORTED]: 'channel_not_supported',
};
const SKIP = new Set<string>([ERROR_CODES.RECIPIENT_SUPPRESSED, ERROR_CODES.CONSENT_REVOKED]);
const FAIL = new Set<string>([
  ERROR_CODES.VALIDATION_FAILED,
  ERROR_CODES.RESOURCE_NOT_FOUND,
  // The database refused the message for this recipient: its contact or identity no longer
  // matches (composite FK 23503) or the core tried to create a contact (RLS 42501).
  '23503',
  '42501',
]);
/** `BILLING_BUSY` and the runner's transient SQLSTATEs (`journeys/runner/runner-errors.ts`). */
const TRANSIENT = new Set<string>([
  ERROR_CODES.BILLING_BUSY,
  '40001',
  '40P01',
  '55P03',
  '57014',
  '53300',
  '57P01',
  '08000',
  '08003',
  '08006',
]);

export function campaignRefusal(code: string | null): CampaignRefusal {
  if (code === null) return { kind: 'unexpected' };
  const pause = PAUSE[code];
  if (pause) return { kind: 'pause', pauseReason: pause };
  if (SKIP.has(code)) return { kind: 'skip', reason: code.toLowerCase() };
  if (TRANSIENT.has(code)) return { kind: 'transient' };
  if (FAIL.has(code) || code.startsWith('SMS_')) return { kind: 'fail', code };
  return { kind: 'unexpected' };
}

/** The application or SQLSTATE code of an error (Drizzle wraps the driver error in `cause`). */
export function refusalCode(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0 && code.length <= 100) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** The DETAIL of a mint refusal (`app_automation_capability_mint`, 0068), e.g. `AUTOMATION_PAUSED`. */
export function mintRefusalDetail(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    const { code, detail } = e as { code?: unknown; detail?: unknown };
    if (code === '42501' && typeof detail === 'string') return detail;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
