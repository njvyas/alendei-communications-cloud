/**
 * Phase 8B: Campaigns Domain Contracts
 *
 * Invariants (ARCHITECTURE.md §11, §21b, §26):
 * 1. Campaigns are callers of core communication APIs; they do not possess
 *    private provider paths.
 * 2. Campaigns reference an approved template, recipient source (contact segment/list),
 *    and schedule/throttling configuration.
 * 3. Campaigns must never bypass consent or suppression rules.
 * 4. Campaign dispatch remains disabled until Phase 7 billing acceptance.
 */

import type { PageInfo } from './api';
import type { AudienceMemberResponse } from './contacts';

export const ALL_CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
] as const;

export type CampaignStatus = (typeof ALL_CAMPAIGN_STATUSES)[number];

export const ALL_CAMPAIGN_SCHEDULE_MODES = ['immediate', 'scheduled'] as const;

export type CampaignScheduleMode = (typeof ALL_CAMPAIGN_SCHEDULE_MODES)[number];

export const ALL_CAMPAIGN_RECIPIENT_SOURCE_TYPES = [
  'all_contacts',
  'tag_segment',
  'custom_list',
] as const;

export type CampaignRecipientSourceType = (typeof ALL_CAMPAIGN_RECIPIENT_SOURCE_TYPES)[number];

export const ALL_CAMPAIGN_RECIPIENT_STATUSES = [
  'pending',
  'enqueued',
  'sent',
  'skipped',
  'failed',
] as const;

export type CampaignRecipientStatus = (typeof ALL_CAMPAIGN_RECIPIENT_STATUSES)[number];

/**
 * Phase 8B PR 8B-3b: why a campaign is paused (`campaigns.pause_reason`, CHECKed by migration 0068).
 * `operator` is a user pause; every other value is an automatic pause by the executor on a
 * refusal that concerns the whole campaign (owner decision OD-8B3-3), or the organisation's
 * automation pause.
 */
export const CAMPAIGN_PAUSE_REASONS = [
  'operator',
  'insufficient_funds',
  'billing_account',
  'no_provider_assignment',
  'template_not_approved',
  'channel_not_supported',
  'automation_paused',
] as const;
export type CampaignPauseReason = (typeof CAMPAIGN_PAUSE_REASONS)[number];

/** Phase 8B PR 8B-3b: the executor's recipient error and skip codes beyond the core's own. */
export const CAMPAIGN_EXECUTOR_CODES = Object.freeze({
  /** The materialised identity is no longer an active identity of the recipient's contact. */
  NO_ACTIVE_IDENTITY: 'no_active_identity',
  /** Left pending when the campaign was cancelled. */
  CAMPAIGN_CANCELLED: 'campaign_cancelled',
  /** An unmapped failure, after `CAMPAIGN_EXECUTOR_LIMITS.unexpectedAttempts` attempts. */
  SEND_UNEXPECTED: 'CAMPAIGN_SEND_UNEXPECTED',
});

/** Phase 8B PR 8B-3b: executor bounds (PHASE-8B-3-HANDOVER-Rev2 §§4.4, 6.3; [P] defaults). */
export const CAMPAIGN_EXECUTOR_LIMITS = Object.freeze({
  /** The throttle slot: a claim sends at most ceil(rateLimitPerSecond × slotSeconds) messages. */
  slotSeconds: 5,
  /** Unexpected failures of one recipient before it is failed. */
  unexpectedAttempts: 3,
  /** Capabilities purged per executor cycle (retention, OD-8B3-6). */
  capabilityPurgeBatch: 1_000,
  /** Due scheduled campaigns started per cycle. */
  scheduledStartsPerCycle: 10,
});

export const ALL_CAMPAIGN_CHANNELS = ['whatsapp', 'sms', 'email', 'rcs'] as const;

export type CampaignChannel = (typeof ALL_CAMPAIGN_CHANNELS)[number];

export interface CampaignRecipientSource {
  readonly type: CampaignRecipientSourceType;
  readonly tag?: string;
  readonly tags?: readonly string[];
  readonly tagMatchMode?: 'any' | 'all';
  readonly segmentName?: string;
  readonly requireOptIn?: boolean;
}

export interface CampaignThrottling {
  readonly rateLimitPerSecond: number;
  readonly maxAttemptsPerRecipient?: number;
}

export interface CampaignMetrics {
  readonly totalRecipients: number | null;
  readonly sent: number;
  readonly delivered: number;
  readonly read: number;
  readonly failed: number;
  readonly deliveryRate: number; // 0 to 100
}

export interface CampaignRecordResponse {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly channel: CampaignChannel;
  readonly channelId: string;
  readonly templateId: string;
  readonly templateName?: string;
  readonly templateBody?: string;
  readonly templateVariables?: Record<string, string>;
  readonly status: CampaignStatus;
  readonly recipientSource: CampaignRecipientSource;
  readonly scheduleMode: CampaignScheduleMode;
  readonly scheduledAt?: string | null;
  readonly throttling: CampaignThrottling;
  readonly metrics: CampaignMetrics;
  readonly createdBy?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  /** Phase 8B-3b: why the campaign is paused (`null` unless `status` is `paused`). */
  readonly pauseReason?: CampaignPauseReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Flags local preview fixtures when mock client is active */
  readonly isSimulatedPreview?: boolean;
}

export interface CreateCampaignRequest {
  readonly orgId?: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string;
  readonly channel: CampaignChannel;
  readonly templateId: string;
  readonly templateVariables?: Record<string, string>;
  readonly recipientSource: {
    readonly type: CampaignRecipientSourceType;
    readonly tag?: string;
    readonly tags?: readonly string[];
    readonly tagMatchMode?: 'any' | 'all';
    readonly contactCount?: number | null;
    readonly segmentName?: string;
    readonly requireOptIn?: boolean;
  };
  readonly scheduleMode: CampaignScheduleMode;
  readonly scheduledAt?: string | null;
  readonly throttling?: Partial<CampaignThrottling>;
}

export interface UpdateCampaignRequest {
  readonly name?: string;
  readonly description?: string;
  readonly templateVariables?: Record<string, string>;
  readonly recipientSource?: Partial<CampaignRecipientSource>;
  readonly scheduleMode?: CampaignScheduleMode;
  readonly scheduledAt?: string | null;
  readonly throttling?: Partial<CampaignThrottling>;
}

export interface CampaignRecipientRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly contactId: string;
  readonly identityId?: string | null;
  readonly status: CampaignRecipientStatus;
  readonly messageId?: string | null;
  readonly skipReason?: string | null;
  readonly errorCode?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CampaignAudiencePreviewRequest {
  readonly limit?: number;
  readonly cursor?: string;
  readonly tags?: readonly string[];
  readonly tagMatchMode?: 'any' | 'all';
  readonly requireOptIn?: boolean;
}

export interface CampaignAudiencePreviewResponse {
  readonly data: readonly AudienceMemberResponse[];
  readonly totalCount: number;
  readonly page: PageInfo;
}

export interface ScheduleCampaignRequest {
  readonly scheduledAt?: string;
}

export interface MaterializeAudienceResponse {
  readonly campaignId: string;
  readonly totalRecipients: number;
  readonly materialized: number;
}

export interface ListCampaignRecipientsQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: CampaignRecipientStatus;
}
