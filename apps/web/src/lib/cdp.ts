import {
  maskRecipientAddress,
  type ConsentEventResponse,
  type ContactIdentityResponse,
  type ContactResponse,
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
  | 'message_pending'
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
 * Authentic Message Activity Record interface for message events.
 * Only populated when real message records exist from API responses or persistence.
 */
export interface ContactMessageActivityRecord {
  readonly id: string;
  readonly channelCode: 'whatsapp' | 'sms' | 'email' | 'rcs' | 'voice';
  readonly recipientAddress: string;
  readonly status: 'pending' | 'submitted' | 'failed';
  readonly deliveryStatus?: 'pending' | 'delivered' | 'undelivered' | 'not_supported' | null;
  readonly createdAt: string;
  readonly deliveredAt?: string | null;
  readonly readAt?: string | null;
  readonly failureReason?: string | null;
  readonly templateName?: string | null;
}

/**
 * Synthesizes chronological timeline items strictly from authentic contact metadata,
 * identities, consent events, and genuine message records.
 *
 * NEVER fabricates synthetic messages, carrier delivery receipts, read receipts, or provider IDs.
 * If message records are not supplied, zero message events are generated.
 */
export function generateContactTimeline(
  contact: ContactResponse,
  identities: readonly ContactIdentityResponse[] = [],
  consentEvents: readonly ConsentEventResponse[] = [],
  messages: readonly ContactMessageActivityRecord[] = [],
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
    const maskedAddress = maskRecipientAddress(ident.normalizedAddress || ident.rawAddress);
    items.push({
      id: `event-identity-${ident.id}`,
      type: 'identity_added',
      category: 'identity',
      title: `Identity Added (${maskedAddress})`,
      description: `Channel identifier ${maskedAddress} linked${ident.isPrimary ? ' as primary address' : ''}.`,
      timestamp: ident.createdAt,
      statusTone: ident.status === 'active' ? 'accent' : 'warning',
      metadata: {
        maskedAddress,
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

  // 4. Authentic message events (only when real records are passed)
  for (const msg of messages) {
    const maskedRecipient = maskRecipientAddress(msg.recipientAddress);

    if (msg.readAt) {
      items.push({
        id: `event-msg-read-${msg.id}`,
        type: 'message_read',
        category: 'message',
        title: `${msg.channelCode.toUpperCase()} Message Read`,
        description: `Recipient read notification at ${new Date(msg.readAt).toLocaleTimeString()}`,
        timestamp: msg.readAt,
        channelCode: msg.channelCode,
        statusTone: 'accent',
        metadata: {
          messageId: msg.id,
          recipientAddress: maskedRecipient,
          templateName: msg.templateName,
        },
      });
    }

    if (msg.deliveredAt || msg.deliveryStatus === 'delivered') {
      items.push({
        id: `event-msg-deliv-${msg.id}`,
        type: 'message_delivered',
        category: 'message',
        title: `${msg.channelCode.toUpperCase()} Delivered`,
        description: `Confirmed delivered to recipient endpoint.`,
        timestamp: msg.deliveredAt || msg.createdAt,
        channelCode: msg.channelCode,
        statusTone: 'success',
        metadata: {
          messageId: msg.id,
          recipientAddress: maskedRecipient,
          deliveryStatus: msg.deliveryStatus,
        },
      });
    } else if (msg.deliveryStatus === 'undelivered' || msg.status === 'failed') {
      items.push({
        id: `event-msg-fail-${msg.id}`,
        type: 'message_failed',
        category: 'message',
        title: `${msg.channelCode.toUpperCase()} Delivery Failed`,
        description: msg.failureReason || 'Message failed or undelivered.',
        timestamp: msg.createdAt,
        channelCode: msg.channelCode,
        statusTone: 'error',
        metadata: {
          messageId: msg.id,
          recipientAddress: maskedRecipient,
          failureReason: msg.failureReason,
        },
      });
    }

    if (msg.status === 'submitted') {
      items.push({
        id: `event-msg-sent-${msg.id}`,
        type: 'message_sent',
        category: 'message',
        title: `${msg.channelCode.toUpperCase()} Dispatched`,
        description: `Outbound message dispatched to recipient ${maskedRecipient}.`,
        timestamp: msg.createdAt,
        channelCode: msg.channelCode,
        statusTone: 'neutral',
        metadata: {
          messageId: msg.id,
          recipientAddress: maskedRecipient,
          templateName: msg.templateName,
          status: msg.status,
        },
      });
    } else if (msg.status === 'pending') {
      items.push({
        id: `event-msg-pending-${msg.id}`,
        type: 'message_pending',
        category: 'message',
        title: `${msg.channelCode.toUpperCase()} Pending Dispatch`,
        description: `Outbound message pending dispatch to ${maskedRecipient}.`,
        timestamp: msg.createdAt,
        channelCode: msg.channelCode,
        statusTone: 'neutral',
        metadata: {
          messageId: msg.id,
          recipientAddress: maskedRecipient,
          templateName: msg.templateName,
          status: msg.status,
        },
      });
    }
  }

  // Sort descending: newest first
  return items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}
