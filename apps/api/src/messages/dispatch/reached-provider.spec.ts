import { PROVIDER_FAILURE_CATEGORIES, type ProviderSubmissionResult } from '@acc/contracts';

import { reachedProvider } from './dispatcher.service';

/**
 * Phase 7 PR 7-5 (owner decision, 09-Nov-2026): an attempt reached the provider —
 * and so carries provider cost, and under charge_per_attempt a charge on an accepted
 * chain — only when a provider response decided it. Every category, both origins.
 */
describe('reachedProvider', () => {
  const rejected = (category: string, origin: 'provider' | 'local'): ProviderSubmissionResult =>
    ({
      outcome: 'rejected',
      submissionId: 's',
      correlationId: 'c',
      failure: { category, retryable: false, providerCode: null, message: 'm', origin },
      latencyMs: 1,
    }) as ProviderSubmissionResult;

  it('an accepted submission reached the provider', () => {
    expect(
      reachedProvider({
        outcome: 'accepted',
        submissionId: 's',
        correlationId: 'c',
        providerMessageId: 'p',
        latencyMs: 1,
      }),
    ).toBe(true);
  });

  it.each(PROVIDER_FAILURE_CATEGORIES.filter((c) => c !== 'TIMEOUT' && c !== 'UNKNOWN'))(
    '%s: reached only with a provider response',
    (category) => {
      expect(reachedProvider(rejected(category, 'provider'))).toBe(true);
      expect(reachedProvider(rejected(category, 'local'))).toBe(false);
    },
  );

  it.each(['TIMEOUT', 'UNKNOWN'])(
    '%s is never reached, whatever the origin (OD-7-4U)',
    (category) => {
      expect(reachedProvider(rejected(category, 'provider'))).toBe(false);
      expect(reachedProvider(rejected(category, 'local'))).toBe(false);
    },
  );

  it('covers every category of the taxonomy', () => {
    expect(PROVIDER_FAILURE_CATEGORIES).toHaveLength(9);
  });
});
