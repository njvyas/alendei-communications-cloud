/**
 * Contacts, identities and consent contracts (Phase 3.1, ADR-014 §6, §11).
 *
 * Workspace-owned resources under `/workspaces/:workspaceId/...`.
 */

export const CONTACT_IDENTITY_STATUSES = ['active', 'inactive'] as const;
export type ContactIdentityStatus = (typeof CONTACT_IDENTITY_STATUSES)[number];

export const CONSENT_EVENT_TYPES = ['grant', 'revoke'] as const;
export type ConsentEventType = (typeof CONSENT_EVENT_TYPES)[number];

export const EFFECTIVE_CONSENT_STATES = ['opted_in', 'opted_out', 'unconsented'] as const;
export type EffectiveConsentState = (typeof EFFECTIVE_CONSENT_STATES)[number];

export interface ContactResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContactIdentityResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly contactId: string;
  readonly channelId: string;
  readonly rawAddress: string;
  readonly normalizedAddress: string;
  readonly isPrimary: boolean;
  readonly status: ContactIdentityStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConsentEventResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly contactId: string;
  readonly channelId: string;
  readonly consentType: string;
  readonly event: ConsentEventType;
  readonly occurredAt: string;
  readonly source: string;
  readonly createdAt: string;
}

export interface EffectiveConsentResponse {
  readonly contactId: string;
  readonly channelId: string;
  readonly consentType: string;
  readonly effectiveState: EffectiveConsentState;
  readonly evaluatedAt: string;
}

export const CONTACT_ACTIVITY_EVENT_TYPES = [
  'contact_created',
  'contact_updated',
  'identity_added',
  'identity_updated',
  'consent_granted',
  'consent_revoked',
  'message_pending',
  'message_sent',
  'message_delivered',
  'message_read',
  'message_failed',
  'message_outcome_unknown',
] as const;
export type ContactActivityEventType = (typeof CONTACT_ACTIVITY_EVENT_TYPES)[number];

export const CONTACT_ACTIVITY_CATEGORIES = ['message', 'consent', 'identity', 'profile'] as const;
export type ContactActivityCategory = (typeof CONTACT_ACTIVITY_CATEGORIES)[number];

export interface ContactActivityResponse {
  readonly id: string;
  readonly contactId: string;
  readonly workspaceId: string;
  readonly type: ContactActivityEventType;
  readonly category: ContactActivityCategory;
  readonly title: string;
  readonly description: string;
  readonly timestamp: string;
  readonly channelId?: string | null;
  readonly channelCode?: string | null;
  readonly statusTone: 'success' | 'warning' | 'error' | 'neutral' | 'accent';
  readonly metadata?: Record<string, unknown>;
}
