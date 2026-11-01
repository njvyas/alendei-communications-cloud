/**
 * Platform domain oversight (U13.3): API calls, permission hooks and display
 * helpers for the `/domains` console. Kept out of `api-client.ts` and
 * `session-store.ts` so the U13 workstreams do not edit the same files.
 *
 * Every call is platform-scoped (`skipTenant`): the registry spans every
 * organization and never depends on the selected one.
 */
import type {
  ApiDataResponse,
  ApiPagedResponse,
  DnsPropagationState,
  DomainChallengeState,
  DomainDnsDiagnostics,
  DomainHistoryEntry,
  DomainStatus,
  DomainType,
  DomainVerificationStatus,
  PlatformDomainSummary,
  PlatformDomainView,
} from '@acc/contracts';

import { apiFetch } from './api-client';
import { useSession } from './session-store';

export type {
  DnsPropagationState,
  DomainChallengeState,
  DomainDnsDiagnostics,
  DomainHistoryEntry,
  PlatformDomainSummary,
  PlatformDomainView,
} from '@acc/contracts';

export interface PlatformDomainFilter {
  readonly status?: DomainStatus;
  readonly domainType?: DomainType;
  readonly verificationStatus?: DomainVerificationStatus;
  readonly challengeState?: DomainChallengeState;
  readonly orgId?: string;
  readonly resellerId?: string;
  readonly q?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Characters the API accepts in `q` (hostname characters only). */
export const DOMAIN_SEARCH_PATTERN = /^[A-Za-z0-9.-]*$/;

export function platformDomainQuery(filter: PlatformDomainFilter): string {
  const query = new URLSearchParams();
  for (const key of [
    'status',
    'domainType',
    'verificationStatus',
    'challengeState',
    'orgId',
    'resellerId',
    'q',
    'cursor',
  ] as const) {
    const value = filter[key];
    if (value) query.set(key, value);
  }
  if (filter.limit !== undefined) query.set('limit', String(filter.limit));
  const text = query.toString();
  return text ? `?${text}` : '';
}

const path = (domainId: string, suffix = '') =>
  `/platform/domains/${encodeURIComponent(domainId)}${suffix}`;

export const platformDomainsApi = {
  list(filter: PlatformDomainFilter = {}, signal?: AbortSignal) {
    return apiFetch<ApiPagedResponse<PlatformDomainView>>(
      `/platform/domains${platformDomainQuery(filter)}`,
      { method: 'GET', signal, skipTenant: true },
    );
  },
  summary(signal?: AbortSignal) {
    return apiFetch<ApiDataResponse<PlatformDomainSummary>>('/platform/domains/summary', {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },
  get(domainId: string, signal?: AbortSignal) {
    return apiFetch<ApiDataResponse<PlatformDomainView>>(path(domainId), {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },
  diagnostics(domainId: string, signal?: AbortSignal) {
    return apiFetch<ApiDataResponse<DomainDnsDiagnostics>>(path(domainId, '/dns-diagnostics'), {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },
  history(domainId: string, signal?: AbortSignal) {
    return apiFetch<ApiDataResponse<DomainHistoryEntry[]>>(path(domainId, '/history'), {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },
};

// --- permissions ------------------------------------------------------------------

function usePlatformPermission(permission: string): boolean {
  return useSession((state) =>
    Boolean(
      state.authorization?.grants.some(
        (g) => g.scopeType === 'platform' && g.permissions.includes(permission),
      ),
    ),
  );
}

/** The registry and diagnostics: `platform.tenants.read` at platform scope. */
export function useCanReadPlatformDomains(): boolean {
  return usePlatformPermission('platform.tenants.read');
}

/** Lifecycle history: `platform.audit.read` at platform scope. */
export function useCanReadPlatformDomainHistory(): boolean {
  return usePlatformPermission('platform.audit.read');
}

/**
 * Suspend, activate and verify (the U12 routes): offered to holders of
 * `platform.tenants.manage`. The API remains the authority for each action.
 */
export function useCanManagePlatformDomains(): boolean {
  return usePlatformPermission('platform.tenants.manage');
}

// --- display ------------------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export const CHALLENGE_STATE_LABELS: Readonly<Record<DomainChallengeState, string>> = {
  verified: 'Verified',
  not_required: 'Not required',
  pending: 'Awaiting DNS record',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
  failed: 'Last check failed',
};

export const CHALLENGE_STATE_TONES: Readonly<Record<DomainChallengeState, Tone>> = {
  verified: 'ok',
  not_required: 'neutral',
  pending: 'neutral',
  expiring_soon: 'warn',
  expired: 'bad',
  failed: 'bad',
};

export const PROPAGATION_LABELS: Readonly<Record<DnsPropagationState, string>> = {
  propagated: 'Propagated',
  partial: 'Partially propagated',
  mismatch: 'Wrong value in DNS',
  not_found: 'No record found',
  unreachable: 'Resolvers unreachable',
  not_applicable: 'Not applicable',
};

export const PROPAGATION_TONES: Readonly<Record<DnsPropagationState, Tone>> = {
  propagated: 'ok',
  partial: 'warn',
  mismatch: 'bad',
  not_found: 'bad',
  unreachable: 'warn',
  not_applicable: 'neutral',
};

export const DOMAIN_STATUS_LABELS: Readonly<Record<DomainStatus, string>> = {
  active: 'Active',
  pending_verification: 'Pending verification',
  suspended: 'Suspended',
  revoked: 'Revoked',
};

export const HISTORY_ACTION_LABELS: Readonly<Record<string, string>> = {
  'domain.registered': 'Registered',
  'domain.verified': 'Ownership verified',
  'domain.activated': 'Activated',
  'domain.suspended': 'Suspended',
  'domain.removed': 'Removed',
};

/**
 * Time left until `expiresAt` in whole hours, or how long ago it passed:
 * `in 5 h`, `in 2 d 3 h`, `3 h ago`. `—` when there is no expiry.
 */
export function relativeExpiry(expiresAt: string | null, now: Date = new Date()): string {
  if (!expiresAt) return '—';
  const diff = Date.parse(expiresAt) - now.getTime();
  const hours = Math.floor(Math.abs(diff) / 3_600_000);
  const text =
    hours >= 24
      ? `${Math.floor(hours / 24)} d ${hours % 24} h`
      : hours < 1
        ? '< 1 h'
        : `${hours} h`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** Whether running U12 verification is worth offering for this domain. */
export function canAttemptVerification(domain: PlatformDomainView): boolean {
  return (
    domain.verificationMethod !== 'platform_subdomain' &&
    domain.verificationStatus !== 'verified' &&
    domain.status !== 'suspended' &&
    domain.status !== 'revoked' &&
    domain.challenge.state !== 'expired'
  );
}
