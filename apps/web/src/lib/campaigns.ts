/**
 * Phase 8B: Campaigns Module (Frontend Slice)
 *
 * Implements Campaign domain contracts, status lifecycles, metrics,
 * preview fixtures, and filtering utilities.
 *
 * Architecture Invariants (ARCHITECTURE.md §11, §21b, §26):
 * 1. Campaigns are callers of core communication APIs; they do not possess
 *    private provider paths.
 * 2. Campaigns reference a template, recipient source (contact segment/list),
 *    and schedule/throttle configuration.
 * 3. Campaigns must never bypass consent or suppression rules.
 *
 * IMPORTANT BACKEND BLOCKER NOTICE:
 * Backend `/campaigns` endpoints and database tables (`campaigns`, `campaign_recipients`)
 * do not yet exist in @acc/contracts or apps/api.
 * All campaign data in this frontend slice is served via isolated in-memory preview
 * fixtures and is clearly flagged as preview mode.
 */

export type CampaignStatus =
  'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';

export const ALL_CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
] as const;

export type CampaignChannel = 'whatsapp' | 'sms' | 'email' | 'rcs';

export const ALL_CAMPAIGN_CHANNELS: readonly CampaignChannel[] = [
  'whatsapp',
  'sms',
  'email',
  'rcs',
] as const;

export type CampaignRecipientSourceType = 'all_contacts' | 'tag_segment' | 'custom_list';

export interface CampaignRecipientSource {
  readonly type: CampaignRecipientSourceType;
  readonly tag?: string;
  readonly contactCount: number | null;
  readonly segmentName?: string;
}

export type CampaignScheduleMode = 'immediate' | 'scheduled';

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

export interface CampaignRecord {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string;
  readonly channel: CampaignChannel;
  readonly templateId: string;
  readonly templateName: string;
  readonly templateBody: string;
  readonly templateVariables?: Record<string, string>;
  readonly status: CampaignStatus;
  readonly recipientSource: CampaignRecipientSource;
  readonly scheduleMode: CampaignScheduleMode;
  readonly scheduledAt?: string | null;
  readonly throttling: CampaignThrottling;
  readonly metrics: CampaignMetrics;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
  /** Explicitly flags local preview / mock fixtures */
  readonly isSimulatedPreview?: boolean;
}

export interface CreateCampaignParams {
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string;
  readonly channel: CampaignChannel;
  readonly templateId: string;
  readonly templateName: string;
  readonly templateBody: string;
  readonly templateVariables?: Record<string, string>;
  readonly recipientSource: CampaignRecipientSource;
  readonly scheduleMode: CampaignScheduleMode;
  readonly scheduledAt?: string | null;
  readonly throttling?: Partial<CampaignThrottling>;
}

/**
 * Explicit blocker descriptor identifying missing backend API contracts and schemas.
 */
export const BACKEND_CAMPAIGN_SUPPORT_STATUS = {
  isBackendAvailable: false,
  missingEndpoints: [
    'GET /workspaces/:workspaceId/campaigns',
    'POST /workspaces/:workspaceId/campaigns',
    'GET /workspaces/:workspaceId/campaigns/:id',
    'PATCH /workspaces/:workspaceId/campaigns/:id',
    'POST /workspaces/:workspaceId/campaigns/:id/dispatch',
  ],
  missingSchemaTables: ['campaigns', 'campaign_recipients'],
  billingDependency: {
    phase: 'Phase 7 (Billing)',
    isBillingEnforced: false,
    missingCapabilities: [
      'Wallets & credit balance authorization (/wallets)',
      'Pricing & Rating Engine evaluation',
      'Usage ledger reservation before dispatch',
    ],
    notice:
      'Phase 7 billing pipeline has not been implemented. Pre-dispatch wallet balance checks and per-message ledger rating are unavailable.',
  },
  audienceResolutionNotice:
    'Audience segmentation query engine (POST /workspaces/:workspaceId/audience/preview) is pending Phase 8B backend. Where an exact count cannot be established, counts are flagged as unavailable.',
  notice:
    'Preview mode: Backend campaign persistence and orchestration engine arrive with Phase 8B backend. Records created here exist only in the active browser session.',
} as const;

/**
 * Returns U15.1 design system badge tone for a campaign status.
 */
export function getCampaignStatusTone(
  status: CampaignStatus,
): 'neutral' | 'accent' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'draft':
      return 'neutral';
    case 'scheduled':
    case 'running':
      return 'accent';
    case 'completed':
      return 'success';
    case 'paused':
      return 'warning';
    case 'cancelled':
      return 'error';
  }
}

/**
 * Returns human-readable status label.
 */
export function getCampaignStatusLabel(status: CampaignStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'scheduled':
      return 'Scheduled';
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/**
 * Returns human-readable channel display name.
 */
export function getChannelDisplayName(channel: CampaignChannel): string {
  switch (channel) {
    case 'whatsapp':
      return 'WhatsApp';
    case 'sms':
      return 'SMS';
    case 'email':
      return 'Email';
    case 'rcs':
      return 'RCS';
  }
}

/**
 * Computes high-level KPI aggregate metrics across a collection of campaigns.
 */
export function calculateCampaignKPIs(campaigns: readonly CampaignRecord[]): {
  readonly totalCampaigns: number;
  readonly activeCampaigns: number;
  readonly totalRecipientsTargeted: number;
  readonly totalDelivered: number;
  readonly avgDeliveryRate: number;
} {
  const totalCampaigns = campaigns.length;
  let activeCampaigns = 0;
  let totalRecipientsTargeted = 0;
  let totalDelivered = 0;
  let totalSent = 0;

  for (const cmp of campaigns) {
    if (cmp.status === 'running' || cmp.status === 'scheduled') {
      activeCampaigns += 1;
    }
    if (cmp.metrics.totalRecipients != null) {
      totalRecipientsTargeted += cmp.metrics.totalRecipients;
    }
    totalDelivered += cmp.metrics.delivered;
    totalSent += cmp.metrics.sent;
  }

  const avgDeliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 1000) / 10 : 0;

  return {
    totalCampaigns,
    activeCampaigns,
    totalRecipientsTargeted,
    totalDelivered,
    avgDeliveryRate,
  };
}

/**
 * Filters campaigns by workspace, channel, status, and query string.
 */
export function filterCampaigns(
  campaigns: readonly CampaignRecord[],
  filters: {
    readonly workspaceId?: string;
    readonly channel?: string;
    readonly status?: string;
    readonly query?: string;
  },
): CampaignRecord[] {
  const queryLower = filters.query?.trim().toLowerCase();

  return campaigns.filter((c) => {
    if (filters.workspaceId && c.workspaceId !== filters.workspaceId) {
      return false;
    }
    if (filters.channel && filters.channel !== 'all' && c.channel !== filters.channel) {
      return false;
    }
    if (filters.status && filters.status !== 'all' && c.status !== filters.status) {
      return false;
    }
    if (queryLower) {
      const matchName = c.name.toLowerCase().includes(queryLower);
      const matchDesc = c.description?.toLowerCase().includes(queryLower) ?? false;
      const matchTemplate = c.templateName.toLowerCase().includes(queryLower);
      const matchTag = c.recipientSource.tag?.toLowerCase().includes(queryLower) ?? false;
      if (!matchName && !matchDesc && !matchTemplate && !matchTag) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Isolated development preview fixtures for Phase 8B.
 */
export const INITIAL_MOCK_CAMPAIGNS: readonly CampaignRecord[] = [
  {
    id: 'cmp-001',
    orgId: 'org-demo',
    workspaceId: 'ws-prod',
    name: 'Diwali Festive Sale 2026',
    description: 'Festive promotion broadcast with special discounts for VIP and loyalty contacts.',
    channel: 'whatsapp',
    templateId: 'tmpl-diwali-01',
    templateName: 'diwali_sale_broadcast',
    templateBody:
      'Hello {{1}}, celebrate Diwali with 30% off across our catalog! Use code {{2}} at checkout.',
    templateVariables: {
      '1': 'Valued Customer',
      '2': 'FESTIVE30',
    },
    status: 'completed',
    recipientSource: {
      type: 'tag_segment',
      tag: 'VIP',
      contactCount: 24500,
      segmentName: 'VIP Club Members',
    },
    scheduleMode: 'immediate',
    scheduledAt: null,
    throttling: {
      rateLimitPerSecond: 25,
      maxAttemptsPerRecipient: 2,
    },
    metrics: {
      totalRecipients: 24500,
      sent: 24100,
      delivered: 23650,
      read: 21200,
      failed: 450,
      deliveryRate: 98.1,
    },
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-01T14:30:00.000Z',
    completedAt: '2026-11-01T14:30:00.000Z',
    isSimulatedPreview: true,
  },
  {
    id: 'cmp-002',
    orgId: 'org-demo',
    workspaceId: 'ws-prod',
    name: 'Black Friday Flash Sale Alert',
    description:
      'High-priority SMS broadcast alerting subscribed shoppers of a limited 6-hour flash event.',
    channel: 'sms',
    templateId: 'tmpl-sms-flash',
    templateName: 'black_friday_alert',
    templateBody:
      'Flash Sale Alert: 50% off select products for the next 6 hours only. Shop now: https://acc.io/s/bf26',
    status: 'running',
    recipientSource: {
      type: 'all_contacts',
      contactCount: 15000,
      segmentName: 'All Active Contacts',
    },
    scheduleMode: 'immediate',
    scheduledAt: null,
    throttling: {
      rateLimitPerSecond: 50,
      maxAttemptsPerRecipient: 1,
    },
    metrics: {
      totalRecipients: 15000,
      sent: 8200,
      delivered: 7950,
      read: 0,
      failed: 250,
      deliveryRate: 97.0,
    },
    createdAt: '2026-11-07T10:00:00.000Z',
    updatedAt: '2026-11-07T12:00:00.000Z',
    completedAt: null,
    isSimulatedPreview: true,
  },
  {
    id: 'cmp-003',
    orgId: 'org-demo',
    workspaceId: 'ws-prod',
    name: 'Monthly Product Digest — November',
    description: 'Rich email campaign highlighting product improvements and customer stories.',
    channel: 'email',
    templateId: 'tmpl-email-digest',
    templateName: 'newsletter_digest_nov',
    templateBody: 'Here is what is new in Alendei Communications Cloud for November 2026.',
    status: 'scheduled',
    recipientSource: {
      type: 'tag_segment',
      tag: 'Newsletter',
      contactCount: 42000,
      segmentName: 'Newsletter Subscribers',
    },
    scheduleMode: 'scheduled',
    scheduledAt: '2026-11-10T09:00:00.000Z',
    throttling: {
      rateLimitPerSecond: 100,
      maxAttemptsPerRecipient: 2,
    },
    metrics: {
      totalRecipients: 42000,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      deliveryRate: 0,
    },
    createdAt: '2026-11-06T11:30:00.000Z',
    updatedAt: '2026-11-06T11:30:00.000Z',
    completedAt: null,
    isSimulatedPreview: true,
  },
  {
    id: 'cmp-004',
    orgId: 'org-demo',
    workspaceId: 'ws-prod',
    name: 'Scheduled Infrastructure Maintenance Advisory',
    description: 'Operational advisory regarding upcoming planned provider window.',
    channel: 'whatsapp',
    templateId: 'tmpl-maint-01',
    templateName: 'maintenance_advisory',
    templateBody: 'Notice: Alendei systems will undergo scheduled maintenance on Sunday 02:00 UTC.',
    status: 'paused',
    recipientSource: {
      type: 'tag_segment',
      tag: 'High-Priority',
      contactCount: 8000,
      segmentName: 'High-Priority Enterprise Contacts',
    },
    scheduleMode: 'immediate',
    scheduledAt: null,
    throttling: {
      rateLimitPerSecond: 10,
      maxAttemptsPerRecipient: 1,
    },
    metrics: {
      totalRecipients: 8000,
      sent: 3200,
      delivered: 3100,
      read: 2800,
      failed: 100,
      deliveryRate: 96.9,
    },
    createdAt: '2026-11-05T14:00:00.000Z',
    updatedAt: '2026-11-05T15:20:00.000Z',
    completedAt: null,
    isSimulatedPreview: true,
  },
  {
    id: 'cmp-005',
    orgId: 'org-demo',
    workspaceId: 'ws-prod',
    name: 'Q4 Customer Experience Survey',
    description: 'Interactive rich card RCS survey sent to beta testers and loyalty members.',
    channel: 'rcs',
    templateId: 'tmpl-rcs-survey',
    templateName: 'rcs_feedback_prompt',
    templateBody: 'How was your experience with Alendei this quarter? Tap below to rate us 1-5.',
    status: 'draft',
    recipientSource: {
      type: 'tag_segment',
      tag: 'Beta-Tester',
      contactCount: null,
      segmentName: 'Beta Testers Community',
    },
    scheduleMode: 'immediate',
    scheduledAt: null,
    throttling: {
      rateLimitPerSecond: 15,
      maxAttemptsPerRecipient: 1,
    },
    metrics: {
      totalRecipients: null,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      deliveryRate: 0,
    },
    createdAt: '2026-11-07T09:15:00.000Z',
    updatedAt: '2026-11-07T09:15:00.000Z',
    completedAt: null,
    isSimulatedPreview: true,
  },
  {
    id: 'cmp-006',
    orgId: 'org-demo',
    workspaceId: 'ws-prod',
    name: 'Deprecating Legacy Sandbox Notice',
    description: 'Emergency broadcast cancelled prior to complete dispatch.',
    channel: 'sms',
    templateId: 'tmpl-sms-legacy',
    templateName: 'sandbox_notice',
    templateBody: 'Please update your webhook endpoints to v2 before end of month.',
    status: 'cancelled',
    recipientSource: {
      type: 'custom_list',
      contactCount: 5000,
      segmentName: 'Custom List (5,000)',
    },
    scheduleMode: 'immediate',
    scheduledAt: null,
    throttling: {
      rateLimitPerSecond: 20,
      maxAttemptsPerRecipient: 1,
    },
    metrics: {
      totalRecipients: 5000,
      sent: 120,
      delivered: 115,
      read: 0,
      failed: 5,
      deliveryRate: 95.8,
    },
    createdAt: '2026-11-03T16:00:00.000Z',
    updatedAt: '2026-11-03T16:05:00.000Z',
    completedAt: null,
    isSimulatedPreview: true,
  },
];
