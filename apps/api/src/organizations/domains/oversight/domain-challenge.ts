/**
 * Pure derivations for platform domain oversight (U13.3). No I/O, so they are
 * unit-tested exhaustively and shared by the list, the summary and the filter.
 */
import {
  DOMAIN_CHALLENGE_EXPIRING_SOON_HOURS,
  DOMAIN_CHALLENGE_TTL_HOURS,
  type DnsLookupOutcome,
  type DnsPropagationState,
  type DomainChallengeState,
  type DomainChallengeSummary,
  type DomainVerificationMethod,
  type DomainVerificationStatus,
} from '@acc/contracts';

const HOUR_MS = 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = DOMAIN_CHALLENGE_TTL_HOURS * HOUR_MS;
export const CHALLENGE_EXPIRING_SOON_MS = DOMAIN_CHALLENGE_EXPIRING_SOON_HOURS * HOUR_MS;

export interface ChallengeInput {
  readonly verificationMethod: DomainVerificationMethod;
  readonly verificationStatus: DomainVerificationStatus;
  /**
   * When the challenge clock started. U12 measures challenge age from the
   * row's `updated_at` (`DomainsService.verifyDomain`), so this does too: the
   * registry must report the expiry U12 will actually enforce.
   */
  readonly challengeStartedAt: Date;
}

/**
 * The challenge state, in precedence order: not required (platform
 * subdomain, which never has a DNS challenge), verified, expired (TTL passed), failed, expiring soon, pending.
 * `challengeStateCutoffs` + the SQL predicates in the service mirror this.
 */
export function challengeState(input: ChallengeInput, now: Date): DomainChallengeState {
  if (input.verificationMethod === 'platform_subdomain') return 'not_required';
  if (input.verificationStatus === 'verified') return 'verified';
  const age = now.getTime() - input.challengeStartedAt.getTime();
  if (age > CHALLENGE_TTL_MS) return 'expired';
  if (input.verificationStatus === 'failed') return 'failed';
  if (age > CHALLENGE_TTL_MS - CHALLENGE_EXPIRING_SOON_MS) return 'expiring_soon';
  return 'pending';
}

export function challengeSummary(input: ChallengeInput, now: Date): DomainChallengeSummary {
  const state = challengeState(input, now);
  if (state === 'verified' || state === 'not_required') {
    return { state, issuedAt: null, expiresAt: null };
  }
  return {
    state,
    issuedAt: input.challengeStartedAt.toISOString(),
    expiresAt: new Date(input.challengeStartedAt.getTime() + CHALLENGE_TTL_MS).toISOString(),
  };
}

/**
 * Instants the SQL filter compares `updated_at` against, so a filter and the
 * per-row derivation agree for the same `now`.
 */
export function challengeStateCutoffs(now: Date): { expiredBefore: Date; expiringBefore: Date } {
  return {
    // age > TTL  ⇔  started < now − TTL
    expiredBefore: new Date(now.getTime() - CHALLENGE_TTL_MS),
    // age > TTL − soon  ⇔  started < now − (TTL − soon)
    expiringBefore: new Date(now.getTime() - (CHALLENGE_TTL_MS - CHALLENGE_EXPIRING_SOON_MS)),
  };
}

/** Flattens TXT chunks exactly as U12 verification does, and compares. */
export function txtOutcome(
  records: readonly (readonly string[])[],
  expected: string,
): {
  outcome: DnsLookupOutcome;
  recordCount: number;
} {
  const flattened = records.map((chunks) => chunks.join(''));
  if (flattened.length === 0) return { outcome: 'not_found', recordCount: 0 };
  const match = flattened.some((value) => value === expected || value.trim() === expected);
  return { outcome: match ? 'match' : 'mismatch', recordCount: flattened.length };
}

/** DNS error codes that mean "the name or record does not exist". */
const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);
const TIMEOUT_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT']);

export function lookupErrorOutcome(code: string | undefined): DnsLookupOutcome {
  if (code && NOT_FOUND_CODES.has(code)) return 'not_found';
  if (code && TIMEOUT_CODES.has(code)) return 'timeout';
  return 'error';
}

/** The overall verdict from each resolver's outcome. */
export function propagationState(outcomes: readonly DnsLookupOutcome[]): DnsPropagationState {
  const answered = outcomes.filter((o) => o === 'match' || o === 'mismatch' || o === 'not_found');
  if (answered.length === 0) return 'unreachable';
  const matches = answered.filter((o) => o === 'match').length;
  if (matches === answered.length) return 'propagated';
  if (matches > 0) return 'partial';
  if (answered.some((o) => o === 'mismatch')) return 'mismatch';
  return 'not_found';
}

export function propagationGuidance(
  state: DnsPropagationState,
  challenge: DomainChallengeState,
): string {
  const expired =
    'The challenge has expired. The organization must regenerate it from its domain settings and set the new TXT value in DNS before verification can succeed.';
  switch (state) {
    case 'not_applicable':
      return challenge === 'not_required'
        ? 'Platform subdomains are verified by convention; no DNS challenge applies.'
        : 'Ownership is already verified; the challenge record is no longer consulted.';
    case 'propagated':
      return challenge === 'expired'
        ? `Every resolver returns the expected record. ${expired}`
        : 'Every resolver returns the expected record. Verification can be run now.';
    case 'partial':
      return 'Some resolvers return the expected record and some do not yet. DNS is still propagating; check again later before verifying.';
    case 'mismatch':
      return challenge === 'expired'
        ? `A TXT record exists but does not carry the current challenge. ${expired}`
        : 'A TXT record exists at the challenge host but does not carry the current challenge value. The organization should replace it with the value shown in its domain settings.';
    case 'not_found':
      return challenge === 'expired'
        ? `No TXT record was found at the challenge host. ${expired}`
        : 'No TXT record was found at the challenge host. The organization has not created it yet, or it has not propagated.';
    case 'unreachable':
      return 'No resolver answered. This can mean outbound DNS from the platform is restricted; the result says nothing about the domain itself.';
  }
}
