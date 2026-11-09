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
