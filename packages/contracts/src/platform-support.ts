import type { PageInfo } from './api';

export interface PlatformSupportOrgOverview {
  readonly organization: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: string;
    readonly type: string;
    readonly resellerId: string | null;
    readonly brandConfig: Record<string, unknown> | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly parentReseller: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  } | null;
  readonly customerOrganizations: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: string;
  }[];
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
    readonly circuitState: string;
    readonly failureCount: number;
    readonly lastFailureAt: string | null;
  }[];
}

export interface PlatformSupportDispatchAttempt {
  readonly attemptNumber: number;
  readonly providerId: string;
  readonly providerType: string;
  readonly errorType: string | null;
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly attemptedAt: string;
}

export interface PlatformSupportDispatchFailure {
  readonly messageId: string;
  readonly channel: string;
  readonly status: string;
  readonly failureReason: string | null;
  readonly failureCategory: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAttemptAt: string | null;
  readonly maskedRecipient: string;
  readonly providerAttempts: readonly PlatformSupportDispatchAttempt[];
}

export interface PlatformSupportDispatchDiagnostics {
  readonly queue: {
    readonly pendingCount: number;
    readonly claimedCount: number;
    readonly delayedCount: number;
  };
  readonly recentFailures: readonly PlatformSupportDispatchFailure[];
}

export interface PlatformSupportAuditItem {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: string;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly scopeType: string;
  readonly scopeId: string | null;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly metadata: Record<string, unknown>;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface PlatformSupportAuditSearchResponse {
  readonly data: readonly PlatformSupportAuditItem[];
  readonly page: PageInfo;
}
