/**
 * RCS contracts, payload schemas, and action safety validation (Phase 4.1, Gate F.1, ADR-016).
 * Per ADR-016 D-4, covers basic text/media and single rich cards with safe suggested replies/actions.
 * Carousels and multi-turn chatbot flows are explicitly deferred to Phase 8E.
 */

export const RCS_MESSAGE_TYPES = ['text', 'media', 'rich_card'] as const;
export type RcsMessageType = (typeof RCS_MESSAGE_TYPES)[number];

export const RCS_MEDIA_HEIGHTS = ['SHORT', 'MEDIUM', 'TALL'] as const;
export type RcsMediaHeight = (typeof RCS_MEDIA_HEIGHTS)[number];

export const RCS_SUGGESTION_TYPES = [
  'reply',
  'action_open_url',
  'action_dial',
  'action_view_location',
] as const;
export type RcsSuggestionType = (typeof RCS_SUGGESTION_TYPES)[number];

export interface RcsMedia {
  readonly url: string;
  readonly mimeType?: string;
  readonly height?: RcsMediaHeight;
  readonly thumbnailUri?: string;
}

export interface RcsSuggestedReply {
  readonly type: 'reply';
  readonly text: string;
  readonly postbackData: string;
}

export interface RcsActionOpenUrl {
  readonly type: 'action_open_url';
  readonly text: string;
  readonly postbackData: string;
  readonly url: string;
}

export interface RcsActionDial {
  readonly type: 'action_dial';
  readonly text: string;
  readonly postbackData: string;
  readonly phoneNumber: string;
}

export interface RcsActionViewLocation {
  readonly type: 'action_view_location';
  readonly text: string;
  readonly postbackData: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly label?: string;
}

export type RcsSuggestion =
  RcsSuggestedReply | RcsActionOpenUrl | RcsActionDial | RcsActionViewLocation;

export interface RcsRichCard {
  readonly title?: string;
  readonly description?: string;
  readonly media?: RcsMedia;
  readonly suggestions?: readonly RcsSuggestion[];
}

export interface RcsBasicPayload {
  readonly messageType: RcsMessageType;
  readonly text?: string;
  readonly media?: RcsMedia;
  readonly card?: RcsRichCard;
  readonly suggestions?: readonly RcsSuggestion[];
}

export const RCS_CONSTRAINTS = {
  MAX_TEXT_LENGTH: 3072,
  MAX_CARD_TITLE_LENGTH: 200,
  MAX_CARD_DESCRIPTION_LENGTH: 2000,
  MAX_SUGGESTIONS: 10,
  MAX_SUGGESTION_TEXT_LENGTH: 25,
  MAX_POSTBACK_DATA_BYTES: 2048,
  ALLOWED_URL_PROTOCOLS: ['http:', 'https:'] as const,
} as const;

/**
 * Validates that an action URL uses a safe web protocol (http or https)
 * and prevents script injection schemes (javascript:, data:, vbscript:).
 */
export function isSafeActionUrl(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return false;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates an RCS suggestion (reply or action).
 */
/**
 * Validates an RCS suggestion (reply or action).
 */
export function validateRcsSuggestion(suggestion: unknown): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  if (!suggestion || typeof suggestion !== 'object' || Array.isArray(suggestion)) {
    return { valid: false, errors: ['Suggestion must be a non-null object'] };
  }

  const s = suggestion as Record<string, unknown>;
  const type = s.type as string;

  if (!type || !(RCS_SUGGESTION_TYPES as readonly string[]).includes(type)) {
    errors.push(`Invalid suggestion type '${type}'. Allowed: ${RCS_SUGGESTION_TYPES.join(', ')}`);
    return { valid: false, errors };
  }

  let allowedKeys: readonly string[];
  if (type === 'reply') {
    allowedKeys = ['type', 'text', 'postbackData'];
  } else if (type === 'action_open_url') {
    allowedKeys = ['type', 'text', 'postbackData', 'url'];
  } else if (type === 'action_dial') {
    allowedKeys = ['type', 'text', 'postbackData', 'phoneNumber'];
  } else if (type === 'action_view_location') {
    allowedKeys = ['type', 'text', 'postbackData', 'latitude', 'longitude', 'label'];
  } else {
    allowedKeys = ['type'];
  }

  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(s)) {
    if (!allowedSet.has(key)) {
      errors.push(`Suggestion of type '${type}' contains forbidden or unknown field '${key}'`);
    }
  }

  if (typeof s.text !== 'string' || s.text.trim().length === 0) {
    errors.push('Suggestion text is required and cannot be empty');
  } else if (s.text.length > RCS_CONSTRAINTS.MAX_SUGGESTION_TEXT_LENGTH) {
    errors.push(
      `Suggestion text exceeds maximum length of ${RCS_CONSTRAINTS.MAX_SUGGESTION_TEXT_LENGTH} chars`,
    );
  }

  if (typeof s.postbackData !== 'string') {
    errors.push('Suggestion postbackData must be a string');
  } else if (
    new TextEncoder().encode(s.postbackData).length > RCS_CONSTRAINTS.MAX_POSTBACK_DATA_BYTES
  ) {
    errors.push(
      `Suggestion postbackData exceeds maximum size of ${RCS_CONSTRAINTS.MAX_POSTBACK_DATA_BYTES} bytes`,
    );
  }

  if (type === 'action_open_url') {
    const url = s.url;
    if (typeof url !== 'string' || url.trim().length === 0) {
      errors.push('Action open_url requires a valid url string');
    } else if (!isSafeActionUrl(url)) {
      errors.push(`Unsafe action URL '${url}': only http and https protocols are permitted`);
    }
  }

  if (type === 'action_dial') {
    const phone = s.phoneNumber;
    if (typeof phone !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(phone.replace(/[\s\-()]/g, ''))) {
      errors.push('Action dial requires a valid phone number');
    }
  }

  if (type === 'action_view_location') {
    const lat = s.latitude;
    const lng = s.longitude;
    if (typeof lat !== 'number' || lat < -90 || lat > 90) {
      errors.push('Action view_location latitude must be a number between -90 and 90');
    }
    if (typeof lng !== 'number' || lng < -180 || lng > 180) {
      errors.push('Action view_location longitude must be a number between -180 and 180');
    }
    if (s.label !== undefined && typeof s.label !== 'string') {
      errors.push('Action view_location label must be a string');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates an RCS media object.
 */
export function validateRcsMedia(media: unknown): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return { valid: false, errors: ['Media must be a non-null object'] };
  }
  const m = media as Record<string, unknown>;
  const allowedKeys = new Set(['url', 'mimeType', 'height', 'thumbnailUri']);
  for (const key of Object.keys(m)) {
    if (!allowedKeys.has(key)) {
      errors.push(`Media contains forbidden or unknown field '${key}'`);
    }
  }

  if (typeof m.url !== 'string' || !isSafeActionUrl(m.url)) {
    errors.push(`Media url must be a valid http or https URL: received '${m.url}'`);
  }

  if (m.mimeType !== undefined) {
    if (typeof m.mimeType !== 'string' || m.mimeType.length > 100) {
      errors.push('Media mimeType must be a string under 100 characters');
    }
  }

  if (
    m.thumbnailUri !== undefined &&
    (typeof m.thumbnailUri !== 'string' || !isSafeActionUrl(m.thumbnailUri))
  ) {
    errors.push(
      `Media thumbnailUri must be a valid http or https URL: received '${m.thumbnailUri}'`,
    );
  }

  if (
    m.height !== undefined &&
    !(RCS_MEDIA_HEIGHTS as readonly string[]).includes(m.height as string)
  ) {
    errors.push(`Invalid media height '${m.height}'. Allowed: ${RCS_MEDIA_HEIGHTS.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates an RCS message payload (basic text, media, or single rich card).
 */
export function validateRcsPayload(payload: unknown): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['RCS payload must be a non-null object'] };
  }

  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length > 65536) {
      return { valid: false, errors: ['RCS payload exceeds maximum allowed size of 64KB'] };
    }
  } catch {
    return { valid: false, errors: ['RCS payload cannot be serialized to JSON'] };
  }

  const p = payload as Record<string, unknown>;
  const messageType = p.messageType as string;

  if (!messageType || !(RCS_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    errors.push(
      `Invalid RCS messageType '${messageType}'. Allowed: ${RCS_MESSAGE_TYPES.join(', ')}`,
    );
    return { valid: false, errors };
  }

  // Explicit field allowlists per messageType
  let allowedKeys: readonly string[];
  if (messageType === 'text') {
    allowedKeys = ['messageType', 'text', 'suggestions'];
  } else if (messageType === 'media') {
    allowedKeys = ['messageType', 'media', 'suggestions'];
  } else if (messageType === 'rich_card') {
    allowedKeys = ['messageType', 'card', 'suggestions'];
  } else {
    allowedKeys = ['messageType'];
  }

  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(p)) {
    if (!allowedSet.has(key)) {
      errors.push(
        `RCS payload of type '${messageType}' contains forbidden or unknown field '${key}'`,
      );
    }
  }

  if (messageType === 'text') {
    if (typeof p.text !== 'string' || p.text.trim().length === 0) {
      errors.push('RCS text message requires a non-empty text string');
    } else if (p.text.length > RCS_CONSTRAINTS.MAX_TEXT_LENGTH) {
      errors.push(
        `RCS text exceeds maximum length of ${RCS_CONSTRAINTS.MAX_TEXT_LENGTH} characters`,
      );
    }
  }

  if (messageType === 'media') {
    if (!p.media || typeof p.media !== 'object' || Array.isArray(p.media)) {
      errors.push('RCS media message requires a media object');
    } else {
      const mediaRes = validateRcsMedia(p.media);
      if (!mediaRes.valid) errors.push(...mediaRes.errors);
    }
  }

  if (messageType === 'rich_card') {
    if (!p.card || typeof p.card !== 'object' || Array.isArray(p.card)) {
      errors.push('RCS rich_card message requires a card object');
    } else {
      const card = p.card as Record<string, unknown>;
      const cardAllowed = new Set(['title', 'description', 'media', 'suggestions']);
      for (const key of Object.keys(card)) {
        if (!cardAllowed.has(key)) {
          errors.push(`RCS rich card contains forbidden or unknown field '${key}'`);
        }
      }

      if (card.title !== undefined && typeof card.title !== 'string') {
        errors.push('Card title must be a string');
      }
      if (card.description !== undefined && typeof card.description !== 'string') {
        errors.push('Card description must be a string');
      }
      if (
        card.media !== undefined &&
        (typeof card.media !== 'object' || card.media === null || Array.isArray(card.media))
      ) {
        errors.push('Card media must be a non-null object');
      }

      const hasTitle = typeof card.title === 'string' && card.title.trim().length > 0;
      const hasDescription =
        typeof card.description === 'string' && card.description.trim().length > 0;
      const hasMedia = card.media !== undefined && card.media !== null;

      if (!hasTitle && !hasDescription && !hasMedia) {
        errors.push('RCS single rich card must have at least one of: title, description, or media');
      }

      if (hasTitle && (card.title as string).length > RCS_CONSTRAINTS.MAX_CARD_TITLE_LENGTH) {
        errors.push(
          `Card title exceeds maximum length of ${RCS_CONSTRAINTS.MAX_CARD_TITLE_LENGTH} characters`,
        );
      }

      if (
        hasDescription &&
        (card.description as string).length > RCS_CONSTRAINTS.MAX_CARD_DESCRIPTION_LENGTH
      ) {
        errors.push(
          `Card description exceeds maximum length of ${RCS_CONSTRAINTS.MAX_CARD_DESCRIPTION_LENGTH} characters`,
        );
      }

      if (hasMedia) {
        const mediaRes = validateRcsMedia(card.media);
        if (!mediaRes.valid) errors.push(...mediaRes.errors);
      }

      if (card.suggestions !== undefined) {
        if (!Array.isArray(card.suggestions)) {
          errors.push('Card suggestions must be an array');
        } else if (card.suggestions.length > RCS_CONSTRAINTS.MAX_SUGGESTIONS) {
          errors.push(
            `Card suggestions exceed maximum allowed (${RCS_CONSTRAINTS.MAX_SUGGESTIONS})`,
          );
        } else {
          for (let i = 0; i < card.suggestions.length; i++) {
            const sugRes = validateRcsSuggestion(card.suggestions[i]);
            if (!sugRes.valid) {
              errors.push(...sugRes.errors.map((e) => `Card suggestion [${i}]: ${e}`));
            }
          }
        }
      }
    }
  }

  // Top-level message suggestions
  if (p.suggestions !== undefined) {
    if (!Array.isArray(p.suggestions)) {
      errors.push('Top-level suggestions must be an array');
    } else if (p.suggestions.length > RCS_CONSTRAINTS.MAX_SUGGESTIONS) {
      errors.push(
        `Top-level suggestions exceed maximum allowed (${RCS_CONSTRAINTS.MAX_SUGGESTIONS})`,
      );
    } else {
      for (let i = 0; i < p.suggestions.length; i++) {
        const sugRes = validateRcsSuggestion(p.suggestions[i]);
        if (!sugRes.valid) {
          errors.push(...sugRes.errors.map((e) => `Top-level suggestion [${i}]: ${e}`));
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Provider capability declaring which RCS message types a provider carries
 * (Phase 4.2). Its value is a non-empty list of distinct `RCS_MESSAGE_TYPES`.
 */
export const RCS_MESSAGE_TYPES_CAPABILITY = 'rcs_message_types';

/** Validates a `rcs_message_types` capability value as it is saved. */
export function validateRcsMessageTypesCapability(value: unknown): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  if (!Array.isArray(value) || value.length === 0) {
    return { valid: false, errors: ['rcs_message_types must be a non-empty array'] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !(RCS_MESSAGE_TYPES as readonly string[]).includes(entry)) {
      errors.push(
        `rcs_message_types entry ${JSON.stringify(entry)} is not one of ${RCS_MESSAGE_TYPES.join(', ')}`,
      );
    } else if (seen.has(entry)) {
      errors.push(`rcs_message_types lists '${entry}' more than once`);
    } else {
      seen.add(entry);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Whether a provider with these capabilities carries an RCS message of `type`.
 * No declaration means every type (providers configured before Phase 4.2 keep
 * working); a declaration is enforced, and one that is not valid carries nothing.
 */
export function rcsProviderSupports(
  capabilities: Readonly<Record<string, unknown>> | undefined,
  type: RcsMessageType,
): boolean {
  const declared = capabilities?.[RCS_MESSAGE_TYPES_CAPABILITY];
  if (declared === undefined) return true;
  if (!validateRcsMessageTypesCapability(declared).valid) return false;
  return (declared as readonly string[]).includes(type);
}
