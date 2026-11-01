/**
 * Platform domain oversight (Phase 4, U13.3).
 *
 * A read-only, cross-tenant view of every organization domain registered
 * through U12, for platform operators holding `platform.tenants.read`.
 *
 * **What it never carries.** No view here includes the DNS verification
 * challenge value (`organization_domains.verification_value`), the TXT record
 * contents observed in DNS, or an audit row's raw before/after images. The
 * owning organization still reads its own challenge through the U12 route
 * `GET /organizations/{id}/domains/{domainId}/verification`.
 *
 * **What it does not claim.** Domain *status* here is the U12 lifecycle
 * (`pending_verification`, `active`, `suspended`, `revoked`) and ownership
 * verification. It says nothing about ingress routing or TLS certificates:
 * neither is provisioned by ACC today.
 */
import type {
  DomainStatus,
  DomainType,
  DomainVerificationMethod,
  DomainVerificationStatus,
} from './domains';

/** How long a DNS TXT challenge stays valid (U12: 72 hours). */
export const DOMAIN_CHALLENGE_TTL_HOURS = 72;

/** A pending challenge with less than this left is reported as expiring soon. */
export const DOMAIN_CHALLENGE_EXPIRING_SOON_HOURS = 24;

/**
 * The state of a domain's ownership challenge, derived on read.
 *
 * - `verified`       — a custom domain whose ownership is verified; no challenge outstanding.
 * - `not_required`   — a platform subdomain (`*.alendei.io`), which never has a DNS
 *                      challenge (takes precedence over `verified`).
 * - `pending`        — a custom domain awaiting its TXT record, within the TTL.
 * - `expiring_soon`  — pending, with less than 24 hours of the TTL left.
 * - `expired`        — the TTL has passed; U12 refuses verification until the
 *                      organization regenerates the challenge.
 * - `failed`         — the last verification attempt did not find a matching
 *                      record, and the TTL has not yet passed.
 */
export const DOMAIN_CHALLENGE_STATES = [
  'verified',
  'not_required',
  'pending',
  'expiring_soon',
  'expired',
  'failed',
] as const;
export type DomainChallengeState = (typeof DOMAIN_CHALLENGE_STATES)[number];

/** Challenge states an operator needs to act on or follow up. */
export const DOMAIN_CHALLENGE_ATTENTION_STATES: readonly DomainChallengeState[] = Object.freeze([
  'expiring_soon',
  'expired',
  'failed',
]);

export interface DomainChallengeSummary {
  readonly state: DomainChallengeState;
  /**
   * When the current challenge clock started, as U12 measures it (the row's
   * last update). `null` when no challenge applies.
   */
  readonly issuedAt: string | null;
  /** `issuedAt` plus the TTL; `null` when no challenge applies. */
  readonly expiresAt: string | null;
}

/** One domain in the platform registry. Exhaustive: no challenge value. */
export interface PlatformDomainView {
  readonly id: string;
  readonly domain: string;
  readonly domainType: DomainType;
  readonly status: DomainStatus;
  readonly verificationMethod: DomainVerificationMethod;
  readonly verificationStatus: DomainVerificationStatus;
  readonly verifiedAt: string | null;
  readonly isPrimary: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly challenge: DomainChallengeSummary;
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: string;
  };
  /** The organization's reseller; `null` only if the organization has none. */
  readonly reseller: {
    readonly id: string;
    readonly name: string;
    readonly isPlatformDefault: boolean;
  } | null;
}

/** Counts across the whole registry, for the console's status indicators. */
export interface PlatformDomainSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<DomainStatus, number>>;
  readonly byChallengeState: Readonly<Record<DomainChallengeState, number>>;
  readonly byType: Readonly<Record<DomainType, number>>;
  /** Domains in `expiring_soon`, `expired` or `failed`. */
  readonly needsAttention: number;
}

// --- DNS diagnostics -----------------------------------------------------------

/** The outcome of one resolver's TXT lookup of the challenge host. */
export const DNS_LOOKUP_OUTCOMES = ['match', 'mismatch', 'not_found', 'timeout', 'error'] as const;
export type DnsLookupOutcome = (typeof DNS_LOOKUP_OUTCOMES)[number];

/**
 * Overall propagation verdict.
 *
 * - `propagated`      — every resolver that answered returned the expected value.
 * - `partial`         — some resolvers return it and some do not yet.
 * - `mismatch`        — records exist but none carries the expected value.
 * - `not_found`       — no resolver returned a TXT record for the challenge host.
 * - `unreachable`     — no resolver answered (timeouts or errors only).
 * - `not_applicable`  — a platform subdomain, or a domain already verified
 *                       (the challenge record is no longer consulted).
 */
export const DNS_PROPAGATION_STATES = [
  'propagated',
  'partial',
  'mismatch',
  'not_found',
  'unreachable',
  'not_applicable',
] as const;
export type DnsPropagationState = (typeof DNS_PROPAGATION_STATES)[number];

export interface DnsResolverResult {
  /** A label for the resolver, e.g. `Cloudflare (1.1.1.1)`. Never user input. */
  readonly resolver: string;
  readonly outcome: DnsLookupOutcome;
  /** Number of TXT records returned at the challenge host. Values are never returned. */
  readonly recordCount: number;
  /** A DNS error code (`ENOTFOUND`, `ETIMEOUT`, …) when the lookup failed. */
  readonly errorCode: string | null;
  readonly durationMs: number;
}

export interface DomainDnsDiagnostics {
  readonly domainId: string;
  readonly domain: string;
  /** The host the challenge TXT record lives at: `_alendei-challenge.<domain>`. */
  readonly challengeHost: string;
  readonly checkedAt: string;
  readonly propagation: DnsPropagationState;
  readonly results: readonly DnsResolverResult[];
  /** Plain-language explanation and next step for the operator. */
  readonly guidance: string;
  /** Lifecycle state, so the caller can tell whether `verify` is worth trying. */
  readonly challenge: DomainChallengeSummary;
}

// --- Lifecycle history ---------------------------------------------------------

/**
 * One domain lifecycle event from the audit log. Only allowlisted fields of the
 * audit row are carried; the raw before/after images are not.
 */
export interface DomainHistoryEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: string;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly fromVerificationStatus: string | null;
  readonly toVerificationStatus: string | null;
  /** The suspension reason recorded with `domain.suspended`, if any. */
  readonly reason: string | null;
}
