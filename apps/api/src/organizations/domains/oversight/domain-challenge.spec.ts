import { DOMAIN_CHALLENGE_STATES, DNS_PROPAGATION_STATES } from '@acc/contracts';

import {
  CHALLENGE_TTL_MS,
  challengeState,
  challengeStateCutoffs,
  challengeSummary,
  lookupErrorOutcome,
  propagationGuidance,
  propagationState,
  txtOutcome,
  type ChallengeInput,
} from './domain-challenge';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-01T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
const custom = (
  hoursAgo: number,
  verificationStatus: ChallengeInput['verificationStatus'] = 'pending',
): ChallengeInput => ({
  verificationMethod: 'dns_txt',
  verificationStatus,
  challengeStartedAt: ago(hoursAgo),
});

describe('U13.3 challenge state', () => {
  it('reports a verified domain as verified whatever its age', () => {
    expect(challengeState(custom(500, 'verified'), NOW)).toBe('verified');
  });

  it('reports a platform subdomain as not requiring a challenge, verified or not', () => {
    expect(
      challengeState(
        {
          verificationMethod: 'platform_subdomain',
          verificationStatus: 'verified',
          challengeStartedAt: ago(1),
        },
        NOW,
      ),
    ).toBe('not_required');
    expect(
      challengeState(
        {
          verificationMethod: 'platform_subdomain',
          verificationStatus: 'pending',
          challengeStartedAt: ago(500),
        },
        NOW,
      ),
    ).toBe('not_required');
  });

  it('follows the 72-hour TTL U12 enforces, with a 24-hour warning window', () => {
    expect(challengeState(custom(1), NOW)).toBe('pending');
    expect(challengeState(custom(48), NOW)).toBe('pending');
    expect(challengeState(custom(48.01), NOW)).toBe('expiring_soon');
    expect(challengeState(custom(72), NOW)).toBe('expiring_soon');
    expect(challengeState(custom(72.01), NOW)).toBe('expired');
  });

  it('reports a failed attempt as failed until the TTL passes, then as expired', () => {
    expect(challengeState(custom(10, 'failed'), NOW)).toBe('failed');
    expect(challengeState(custom(60, 'failed'), NOW)).toBe('failed');
    expect(challengeState(custom(80, 'failed'), NOW)).toBe('expired');
  });

  it('gives issue and expiry instants only when a challenge applies', () => {
    expect(challengeSummary(custom(5, 'verified'), NOW)).toEqual({
      state: 'verified',
      issuedAt: null,
      expiresAt: null,
    });
    const summary = challengeSummary(custom(10), NOW);
    expect(summary.issuedAt).toBe(ago(10).toISOString());
    expect(Date.parse(summary.expiresAt!) - Date.parse(summary.issuedAt!)).toBe(CHALLENGE_TTL_MS);
  });

  it('cut-offs agree with the per-row derivation at every boundary', () => {
    const { expiredBefore, expiringBefore } = challengeStateCutoffs(NOW);
    expect(expiredBefore.toISOString()).toBe(ago(72).toISOString());
    expect(expiringBefore.toISOString()).toBe(ago(48).toISOString());
    // A row started exactly at a cut-off is not past it, in SQL (<) or here (>).
    expect(challengeState(custom(72), NOW)).not.toBe('expired');
    expect(challengeState(custom(48), NOW)).toBe('pending');
  });

  it('covers every challenge state in the contract', () => {
    const seen = new Set([
      challengeState(custom(1, 'verified'), NOW),
      challengeState(
        {
          verificationMethod: 'platform_subdomain',
          verificationStatus: 'pending',
          challengeStartedAt: NOW,
        },
        NOW,
      ),
      challengeState(custom(1), NOW),
      challengeState(custom(60), NOW),
      challengeState(custom(100), NOW),
      challengeState(custom(1, 'failed'), NOW),
    ]);
    expect([...seen].sort()).toEqual([...DOMAIN_CHALLENGE_STATES].sort());
  });
});

describe('U13.3 DNS diagnostics classification', () => {
  const expected = 'acc-domain-verification=0190abcd';

  it('matches TXT chunks the way U12 verification does', () => {
    expect(txtOutcome([['acc-domain-verification=', '0190abcd']], expected)).toEqual({
      outcome: 'match',
      recordCount: 1,
    });
    expect(txtOutcome([[' acc-domain-verification=0190abcd ']], expected).outcome).toBe('match');
    expect(txtOutcome([['v=spf1 -all'], ['other']], expected)).toEqual({
      outcome: 'mismatch',
      recordCount: 2,
    });
    expect(txtOutcome([], expected)).toEqual({ outcome: 'not_found', recordCount: 0 });
  });

  it('classifies DNS errors', () => {
    expect(lookupErrorOutcome('ENOTFOUND')).toBe('not_found');
    expect(lookupErrorOutcome('ENODATA')).toBe('not_found');
    expect(lookupErrorOutcome('ETIMEOUT')).toBe('timeout');
    expect(lookupErrorOutcome('ESERVFAIL')).toBe('error');
    expect(lookupErrorOutcome(undefined)).toBe('error');
  });

  it('derives the propagation verdict from the resolvers that answered', () => {
    expect(propagationState(['match', 'match', 'timeout'])).toBe('propagated');
    expect(propagationState(['match', 'not_found'])).toBe('partial');
    expect(propagationState(['mismatch', 'not_found'])).toBe('mismatch');
    expect(propagationState(['not_found', 'error'])).toBe('not_found');
    expect(propagationState(['timeout', 'error'])).toBe('unreachable');
    expect(propagationState([])).toBe('unreachable');
  });

  it('gives guidance for every verdict, and tells an expired challenge to regenerate', () => {
    for (const state of DNS_PROPAGATION_STATES) {
      expect(propagationGuidance(state, 'pending').length).toBeGreaterThan(20);
    }
    expect(propagationGuidance('propagated', 'expired')).toMatch(/regenerate/);
    expect(propagationGuidance('propagated', 'pending')).toMatch(/Verification can be run now/);
    expect(propagationGuidance('unreachable', 'pending')).toMatch(/outbound DNS/);
  });
});
