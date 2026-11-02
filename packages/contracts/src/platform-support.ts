import type { PageInfo } from './api';

export interface PlatformSupportOrgOverview {
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: string;
    readonly resellerId: string | null;
    /** The organization's own branding configuration (`organizations.brand_config`). */
    readonly brandConfig: Record<string, unknown>;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  /** The reseller the organization belongs to, when it has one. */
  readonly parentReseller: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  } | null;
  readonly workspaces: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: string;
    readonly createdAt: string;
  }[];
  readonly teams: readonly {
    readonly id: string;
    readonly name: string;
    readonly workspaceId: string;
    readonly createdAt: string;
  }[];
  readonly metrics: {
    readonly totalUsers: number;
    readonly activeUsers: number;
    readonly disabledUsers: number;
    readonly activeApiKeys: number;
    readonly activeSessions: number;
    readonly verifiedDomains: number;
  };
}

export interface PlatformSupportRoutingDiagnostics {
  readonly channels: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly status: string;
    readonly defaultProviderId: string | null;
    readonly fallbackProviderId: string | null;
  }[];
  readonly assignments: readonly {
    readonly id: string;
    readonly channel: string;
    readonly providerId: string;
    readonly providerName: string;
    readonly providerType: string;
    readonly status: string;
    readonly priority: number;
    readonly isFallback: boolean;
    readonly assignedAt: string;
  }[];
  readonly providerHealth: readonly {
    readonly providerId: string;
    readonly providerName: string;
    readonly channel: string;
    readonly status: string;
    readonly healthState: string;
    readonly healthChangedAt: string | null;
    readonly circuitState: string;
    /** Incremented on every circuit transition (not a failure count). */
    readonly circuitGeneration: number;
    readonly circuitChangedAt: string | null;
  }[];
}

/**
 * The closed set of failure codes support diagnostics may return (U13.4, F-2).
 * Mirrors `app_support_failure_code()` in migration `0040`; a stored failure
 * reason that is not one of these is reported as `OTHER`. The stored failure
 * text itself — provider free text — never leaves the database function.
 */
export const PLATFORM_SUPPORT_FAILURE_CODES = [
  // ProviderFailureCategory
  'TIMEOUT',
  'PROVIDER_ERROR',
  'RATE_LIMITED',
  'AUTH_ERROR',
  'INVALID_REQUEST',
  'INVALID_RECIPIENT',
  'UNSUPPORTED_CONTENT',
  'CONFIGURATION_ERROR',
  'UNKNOWN',
  // Dispatcher
  'NO_ELIGIBLE_PROVIDER',
  'CHANNEL_UNSUPPORTED',
  'SMS_PAYLOAD_INVALID',
  'RCS_PAYLOAD_INVALID',
  'RECIPIENT_SUPPRESSED',
  'CONSENT_REVOKED',
  // Platform-authored reasons, mapped by exact text
  'ORGANIZATION_CLOSED',
  'ORGANIZATION_SUSPENDED',
  'NO_PROVIDER_ASSIGNMENT',
  'DISPATCH_LEASE_EXPIRED',
  // Anything else
  'OTHER',
] as const;
export type PlatformSupportFailureCode = (typeof PLATFORM_SUPPORT_FAILURE_CODES)[number];

/** One provider attempt: operational metadata only. */
export interface PlatformSupportDispatchAttempt {
  readonly attemptNumber: number;
  readonly providerId: string;
  readonly adapterKey: string;
  readonly status: string;
  readonly failureCode: PlatformSupportFailureCode | null;
  readonly latencyMs: number | null;
  readonly attemptedAt: string;
}

/**
 * One recent message: identifiers, status and timing only. No recipient,
 * payload, template, contact or failure text (ADR-015 R-8).
 */
export interface PlatformSupportDispatchMessage {
  readonly messageId: string;
  readonly channel: string;
  readonly status: string;
  readonly failureCode: PlatformSupportFailureCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly attemptCount: number;
  readonly attempts: readonly PlatformSupportDispatchAttempt[];
}

export interface PlatformSupportDispatchDiagnostics {
  /** From the dispatch queue (in-flight messages only). */
  readonly queue: {
    /** Ready to be claimed. */
    readonly pendingCount: number;
    /** Waiting for a retry/backoff time. */
    readonly delayedCount: number;
    /** Under a live dispatcher claim. */
    readonly claimedCount: number;
  };
  readonly recentMessages: readonly PlatformSupportDispatchMessage[];
}

export interface PlatformSupportAuditItem {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: string;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly scopeType: string;
  readonly scopeId: string | null;
  readonly orgId: string | null;
  readonly orgName: string | null;
  /** Redacted (`audit-redactor`). IP address, user agent and actor email are not returned (F-4). */
  readonly metadata: Record<string, unknown>;
}

export interface PlatformSupportAuditSearchResponse {
  readonly data: readonly PlatformSupportAuditItem[];
  readonly page: PageInfo;
}
