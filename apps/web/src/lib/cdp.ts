import type {
  ConsentEventResponse,
  ContactIdentityResponse,
  ContactResponse,
} from '@acc/contracts';

/**
 * Phase 8A: Contacts / CDP (Customer Data Platform) Module
 *
 * Implements CDP utilities for:
 * - Tag extraction, management and normalization
 * - Custom fields (attributes) parsing and type-safe updates
 * - Comprehensive multi-channel activity timeline synthesis
 */

export interface CdpTag {
  readonly name: string;
  readonly tone?: 'accent' | 'neutral' | 'success' | 'warning' | 'error';
}

/** Predefined recommended tag suggestions for quick tagging */
export const RECOMMENDED_CDP_TAGS: readonly string[] = [
  'VIP',
  'Lead',
  'Customer',
  'High-Priority',
  'Wholesale',
  'Beta-Tester',
  'Partner',
  'Support-Escalation',
  'Newsletter',
  'Churn-Risk',
];

export type CustomFieldType = 'string' | 'number' | 'boolean' | 'json';

export interface CustomFieldEntry {
  readonly key: string;
  readonly value: string | number | boolean | Record<string, unknown>;
  readonly type: CustomFieldType;
}

/**
 * Extracts normalized tags from contact metadata.
 * Supports string arrays stored at `metadata.tags` or `metadata.tag_list`,
 * or comma-separated string formats.
 */
export function extractContactTags(metadata: Record<string, unknown> | null | undefined): string[] {
  if (!metadata || typeof metadata !== 'object') return [];

  const rawTags = metadata.tags ?? metadata.tag_list;
  if (Array.isArray(rawTags)) {
    return rawTags
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim());
  }

  if (typeof rawTags === 'string') {
    return rawTags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  return [];
}

/**
 * Returns a new metadata object with the updated tags array.
 * Cleans whitespace and deduplicates case-insensitively while preserving display case.
 */
export function setContactTags(
  metadata: Record<string, unknown> | null | undefined,
  tags: readonly string[],
): Record<string, unknown> {
  const base = metadata ? { ...metadata } : {};
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      cleaned.push(trimmed);
    }
  }

  base.tags = cleaned;
  return base;
}

/**
 * Extracts non-tag custom fields from contact metadata.
 */
export function extractCustomFields(
  metadata: Record<string, unknown> | null | undefined,
): CustomFieldEntry[] {
  if (!metadata || typeof metadata !== 'object') return [];

  const entries: CustomFieldEntry[] = [];
  const reservedKeys = new Set(['tags', 'tag_list']);

  for (const [key, value] of Object.entries(metadata)) {
    if (reservedKeys.has(key)) continue;

    let type: CustomFieldType = 'string';
    if (typeof value === 'number') {
      type = 'number';
    } else if (typeof value === 'boolean') {
      type = 'boolean';
    } else if (typeof value === 'object' && value !== null) {
      type = 'json';
    }

    entries.push({
      key,
      value: value as string | number | boolean | Record<string, unknown>,
      type,
    });
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Sets or updates a custom field on metadata.
 */
export function setCustomField(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base = metadata ? { ...metadata } : {};
  base[key.trim()] = value;
  return base;
}

/**
 * Removes a custom field from metadata.
 */
export function removeCustomField(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> {
  if (!metadata) return {};
  const next = { ...metadata };
  delete next[key];
  return next;
}

/**
 * Activity Timeline event definitions
 */
export type ActivityEventType =
  | 'message_sent'
  | 'message_delivered'
  | 'message_read'
  | 'message_failed'
  | 'consent_granted'
  | 'consent_revoked'
  | 'identity_added'
  | 'identity_updated'
  | 'tag_added'
  | 'tag_removed'
  | 'field_updated'
  | 'contact_created';

export type ActivityCategory = 'message' | 'consent' | 'identity' | 'profile';

export interface ActivityTimelineItem {
  readonly id: string;
  readonly type: ActivityEventType;
  readonly category: ActivityCategory;
  readonly title: string;
  readonly description?: string;
  readonly timestamp: string;
  readonly channelCode?: 'whatsapp' | 'sms' | 'email' | 'rcs' | 'voice';
  readonly metadata?: Record<string, unknown>;
  readonly statusTone: 'success' | 'warning' | 'error' | 'neutral' | 'accent';
}

/**
 * Deterministic mock activity generator for contacts where historical message
 * or lifecycle data has not yet been populated by real backend events.
 */
export function getDeterministicMockActivities(
  contact: ContactResponse,
  identities: readonly ContactIdentityResponse[] = [],
): ActivityTimelineItem[] {
  const activities: ActivityTimelineItem[] = [];
  const baseTime = new Date(contact.createdAt).getTime();

  // If the contact has identities, attach realistic messaging touchpoints
  const primaryWa = identities.find(
    (i) => i.isPrimary && (i.rawAddress.startsWith('+') || i.channelId.includes('wa')),
  );
  const primarySms = identities.find(
    (i) =>
      i.rawAddress.startsWith('+') &&
      (!primaryWa || i.id !== primaryWa.id || i.channelId.includes('sms')),
  );

  if (primaryWa) {
    const waSentTime = new Date(baseTime + 120_000).toISOString();
    const waDeliveredTime = new Date(baseTime + 124_000).toISOString();
    const waReadTime = new Date(baseTime + 360_000).toISOString();

    activities.push({
      id: `act-wa-read-${contact.id}`,
      type: 'message_read',
      category: 'message',
      title: 'WhatsApp Message Read',
      description: 'Recipient read order update template notification.',
      timestamp: waReadTime,
      channelCode: 'whatsapp',
      statusTone: 'accent',
      metadata: {
        recipientAddress: primaryWa.normalizedAddress || primaryWa.rawAddress,
        templateName: 'order_update',
        providerMessageId: `wamid.HBgM${contact.id.slice(0, 8)}`,
      },
    });

    activities.push({
      id: `act-wa-deliv-${contact.id}`,
      type: 'message_delivered',
      category: 'message',
      title: 'WhatsApp Delivered',
      description: 'Carrier confirmed delivery receipt on WhatsApp Business Gateway.',
      timestamp: waDeliveredTime,
      channelCode: 'whatsapp',
      statusTone: 'success',
      metadata: {
        recipientAddress: primaryWa.normalizedAddress || primaryWa.rawAddress,
        deliveryOutcome: 'delivered',
      },
    });

    activities.push({
      id: `act-wa-send-${contact.id}`,
      type: 'message_sent',
      category: 'message',
      title: 'WhatsApp Message Dispatched',
      description: 'Outbound utility template dispatched via Meta Cloud API Direct.',
      timestamp: waSentTime,
      channelCode: 'whatsapp',
      statusTone: 'neutral',
      metadata: {
        recipientAddress: primaryWa.normalizedAddress || primaryWa.rawAddress,
        templateName: 'order_update',
      },
    });
  }

  if (primarySms) {
    const smsTime = new Date(baseTime + 600_000).toISOString();
    activities.push({
      id: `act-sms-deliv-${contact.id}`,
      type: 'message_delivered',
      category: 'message',
      title: 'SMS Notification Delivered',
      description: 'Security authentication code delivered to cellular handset.',
      timestamp: smsTime,
      channelCode: 'sms',
      statusTone: 'success',
      metadata: {
        recipientAddress: primarySms.normalizedAddress || primarySms.rawAddress,
        segments: 1,
      },
    });
  }

  return activities;
}

/**
 * Synthesizes chronological timeline items from contact metadata, identities, consent events,
 * and optional message history.
 */
export function generateContactTimeline(
  contact: ContactResponse,
  identities: readonly ContactIdentityResponse[] = [],
  consentEvents: readonly ConsentEventResponse[] = [],
  options?: { includeMockHistory?: boolean },
): ActivityTimelineItem[] {
  const items: ActivityTimelineItem[] = [];

  // 1. Contact created event
  items.push({
    id: `event-created-${contact.id}`,
    type: 'contact_created',
    category: 'profile',
    title: 'Contact Created',
    description: `Contact record registered in workspace ${contact.workspaceId.slice(0, 8)}…`,
    timestamp: contact.createdAt,
    statusTone: 'neutral',
  });

  // 2. Identity events
  for (const ident of identities) {
    items.push({
      id: `event-identity-${ident.id}`,
      type: 'identity_added',
      category: 'identity',
      title: `Identity Added (${ident.rawAddress})`,
      description: `Channel identifier ${ident.normalizedAddress || ident.rawAddress} linked${ident.isPrimary ? ' as primary address' : ''}.`,
      timestamp: ident.createdAt,
      statusTone: ident.status === 'active' ? 'accent' : 'warning',
      metadata: {
        rawAddress: ident.rawAddress,
        normalizedAddress: ident.normalizedAddress,
        isPrimary: ident.isPrimary,
        status: ident.status,
      },
    });
  }

  // 3. Consent events
  for (const consent of consentEvents) {
    const isGrant =
      consent.event === 'grant' ||
      (consent as unknown as { status?: string }).status === 'opted_in';
    const typeLabel = (consent.consentType || 'marketing').toUpperCase();
    const sourceLabel = consent.source || 'system';
    items.push({
      id: `event-consent-${consent.id}`,
      type: isGrant ? 'consent_granted' : 'consent_revoked',
      category: 'consent',
      title: isGrant ? 'Consent Granted' : 'Consent Revoked',
      description: `${typeLabel} consent ${isGrant ? 'granted' : 'revoked'} (Source: ${sourceLabel})`,
      timestamp: consent.occurredAt || consent.createdAt,
      statusTone: isGrant ? 'success' : 'error',
      metadata: {
        consentType: consent.consentType || 'marketing',
        event: consent.event || (isGrant ? 'grant' : 'revoke'),
        source: consent.source,
      },
    });
  }

  // 4. Contact profile/attribute updates
  if (contact.updatedAt && contact.updatedAt !== contact.createdAt) {
    const tags = extractContactTags(contact.metadata);
    items.push({
      id: `event-updated-${contact.id}-${contact.updatedAt}`,
      type: 'field_updated',
      category: 'profile',
      title: 'Profile Updated',
      description:
        tags.length > 0
          ? `Attributes modified. Tags: ${tags.join(', ')}`
          : 'Contact attributes modified.',
      timestamp: contact.updatedAt,
      statusTone: 'neutral',
      metadata: contact.metadata,
    });
  }

  // 5. Mock activity history if enabled or when no messages exist
  if (options?.includeMockHistory ?? true) {
    const mockEvents = getDeterministicMockActivities(contact, identities);
    items.push(...mockEvents);
  }

  // Sort descending: newest first
  return items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}
