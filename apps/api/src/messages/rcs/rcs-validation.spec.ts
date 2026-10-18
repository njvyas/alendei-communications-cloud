import {
  validateRcsPayload,
  isSafeActionUrl,
  validateRcsSuggestion,
  validateRcsMedia,
  RCS_CONSTRAINTS,
} from '@acc/contracts';

describe('RCS Validation and URL Safety (Phase 4.1 Gate F.1)', () => {
  describe('isSafeActionUrl', () => {
    it('accepts valid http and https URLs', () => {
      expect(isSafeActionUrl('http://example.com')).toBe(true);
      expect(isSafeActionUrl('https://example.com/path?foo=bar#hash')).toBe(true);
      expect(isSafeActionUrl('https://sub.domain.co.uk:8080/deep/link')).toBe(true);
    });

    it('rejects unsafe script protocols and injection vectors', () => {
      expect(isSafeActionUrl('javascript:alert(1)')).toBe(false);
      expect(isSafeActionUrl('javascript:/*--></title></style></textarea></script>')).toBe(false);
      expect(isSafeActionUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
      expect(isSafeActionUrl('vbscript:msgbox("hello")')).toBe(false);
      expect(isSafeActionUrl('file:///etc/passwd')).toBe(false);
      expect(isSafeActionUrl('ftp://ftp.example.com/file')).toBe(false);
    });

    it('rejects empty, non-string, or malformed URLs', () => {
      expect(isSafeActionUrl('')).toBe(false);
      expect(isSafeActionUrl('   ')).toBe(false);
      expect(isSafeActionUrl(null as unknown as string)).toBe(false);
      expect(isSafeActionUrl('not-a-valid-url')).toBe(false);
    });
  });

  describe('validateRcsSuggestion', () => {
    it('accepts valid suggested reply', () => {
      const res = validateRcsSuggestion({
        type: 'reply',
        text: 'Yes, confirm',
        postbackData: 'action=confirm_booking',
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('accepts valid action_open_url with safe https URL', () => {
      const res = validateRcsSuggestion({
        type: 'action_open_url',
        text: 'Track Order',
        postbackData: 'action=track',
        url: 'https://orders.example.com/12345',
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('rejects action_open_url with unsafe scheme', () => {
      const res = validateRcsSuggestion({
        type: 'action_open_url',
        text: 'Click here',
        postbackData: 'action=exploit',
        url: 'javascript:alert(document.cookie)',
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('Unsafe action URL');
    });

    it('accepts valid action_dial with E.164 phone number', () => {
      const res = validateRcsSuggestion({
        type: 'action_dial',
        text: 'Call Support',
        postbackData: 'action=dial_support',
        phoneNumber: '+12025550199',
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('rejects action_dial with invalid phone number', () => {
      const res = validateRcsSuggestion({
        type: 'action_dial',
        text: 'Call Support',
        postbackData: 'action=dial_support',
        phoneNumber: 'not-a-phone',
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('phone number');
    });

    it('accepts valid action_view_location with coordinates', () => {
      const res = validateRcsSuggestion({
        type: 'action_view_location',
        text: 'View Store',
        postbackData: 'action=view_store',
        latitude: 37.7749,
        longitude: -122.4194,
        label: 'San Francisco Store',
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('rejects action_view_location with out-of-range latitude/longitude', () => {
      const res = validateRcsSuggestion({
        type: 'action_view_location',
        text: 'View Store',
        postbackData: 'action=view_store',
        latitude: 95.0, // max is 90
        longitude: -200.0, // min is -180
      });
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBe(2);
    });

    it('enforces suggestion text and postback data limits', () => {
      const resText = validateRcsSuggestion({
        type: 'reply',
        text: 'A'.repeat(RCS_CONSTRAINTS.MAX_SUGGESTION_TEXT_LENGTH + 1),
        postbackData: 'data',
      });
      expect(resText.valid).toBe(false);
      expect(resText.errors[0]).toContain('Suggestion text exceeds');

      const resPostback = validateRcsSuggestion({
        type: 'reply',
        text: 'Valid text',
        postbackData: 'A'.repeat(RCS_CONSTRAINTS.MAX_POSTBACK_DATA_BYTES + 1),
      });
      expect(resPostback.valid).toBe(false);
      expect(resPostback.errors[0]).toContain('postbackData exceeds');
    });
  });

  describe('validateRcsMedia', () => {
    it('accepts valid media with safe URL and height', () => {
      const res = validateRcsMedia({
        url: 'https://cdn.example.com/images/banner.jpg',
        mimeType: 'image/jpeg',
        height: 'MEDIUM',
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('rejects media with unsafe url', () => {
      const res = validateRcsMedia({
        url: 'javascript:alert(1)',
        height: 'SHORT',
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('Media url must be a valid http or https URL');
    });

    it('rejects invalid height value', () => {
      const res = validateRcsMedia({
        url: 'https://cdn.example.com/image.png',
        height: 'EXTRA_TALL',
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('Invalid media height');
    });
  });

  describe('validateRcsPayload', () => {
    it('accepts valid text payload', () => {
      const res = validateRcsPayload({
        messageType: 'text',
        text: 'Your flight is confirmed for tomorrow morning.',
      });
      expect(res.valid).toBe(true);
    });

    it('rejects text payload with empty text or exceeding max length', () => {
      const emptyRes = validateRcsPayload({ messageType: 'text', text: '   ' });
      expect(emptyRes.valid).toBe(false);
      expect(emptyRes.errors[0]).toContain('non-empty text');

      const oversizedRes = validateRcsPayload({
        messageType: 'text',
        text: 'A'.repeat(RCS_CONSTRAINTS.MAX_TEXT_LENGTH + 1),
      });
      expect(oversizedRes.valid).toBe(false);
      expect(oversizedRes.errors[0]).toContain('exceeds maximum length');
    });

    it('accepts valid media payload', () => {
      const res = validateRcsPayload({
        messageType: 'media',
        media: {
          url: 'https://cdn.example.com/video/trailer.mp4',
          mimeType: 'video/mp4',
        },
      });
      expect(res.valid).toBe(true);
    });

    it('accepts valid single rich card with title, description, media, and actions', () => {
      const res = validateRcsPayload({
        messageType: 'rich_card',
        card: {
          title: 'Special Summer Offer',
          description: 'Get 25% discount on all bookings completed before Friday.',
          media: {
            url: 'https://cdn.example.com/offers/summer.jpg',
            height: 'MEDIUM',
          },
          suggestions: [
            {
              type: 'action_open_url',
              text: 'Book Now',
              postbackData: 'action=book_summer_deal',
              url: 'https://alendei.example.com/summer-deal',
            },
            {
              type: 'reply',
              text: 'Remind Me',
              postbackData: 'action=remind_later',
            },
          ],
        },
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('rejects single rich card without title, description, or media', () => {
      const res = validateRcsPayload({
        messageType: 'rich_card',
        card: {
          suggestions: [{ type: 'reply', text: 'Ok', postbackData: 'ok' }],
        },
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('at least one of: title, description, or media');
    });

    it('rejects single rich card with unsafe suggestion URL', () => {
      const res = validateRcsPayload({
        messageType: 'rich_card',
        card: {
          title: 'Dangerous Offer',
          description: 'Click to exploit',
          suggestions: [
            {
              type: 'action_open_url',
              text: 'Click here',
              postbackData: 'exploit',
              url: 'javascript:alert(1)',
            },
          ],
        },
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('Unsafe action URL');
    });

    it('rejects payload with invalid messageType', () => {
      const res = validateRcsPayload({ messageType: 'carousel' });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("Invalid RCS messageType 'carousel'");
    });

    it('enforces maximum 10 suggestions per card', () => {
      const suggestions = Array.from({ length: 11 }, (_, i) => ({
        type: 'reply' as const,
        text: `Option ${i}`,
        postbackData: `opt_${i}`,
      }));

      const res = validateRcsPayload({
        messageType: 'rich_card',
        card: {
          title: 'Options',
          suggestions,
        },
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('Card suggestions exceed maximum allowed (10)');
    });

    it('rejects payload containing unexpected or forbidden fields for messageType text', () => {
      const res = validateRcsPayload({
        messageType: 'text',
        text: 'Hello',
        unexpectedField: 'forbidden',
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("contains forbidden or unknown field 'unexpectedField'");
    });

    it('rejects payload with card or media attached to messageType text', () => {
      const res = validateRcsPayload({
        messageType: 'text',
        text: 'Hello',
        card: { title: 'Sneaky card' },
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("contains forbidden or unknown field 'card'");
    });

    it('rejects card containing unknown fields', () => {
      const res = validateRcsPayload({
        messageType: 'rich_card',
        card: {
          title: 'Offer',
          forbiddenProperty: 'attack',
        },
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("contains forbidden or unknown field 'forbiddenProperty'");
    });

    it('rejects media containing unknown fields', () => {
      const res = validateRcsMedia({
        url: 'https://example.com/banner.jpg',
        maliciousKey: true,
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("contains forbidden or unknown field 'maliciousKey'");
    });

    it('rejects suggestions containing unknown fields', () => {
      const res = validateRcsSuggestion({
        type: 'reply',
        text: 'Yes',
        postbackData: 'ok',
        hiddenField: 'bad',
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("contains forbidden or unknown field 'hiddenField'");
    });

    it('rejects payloads exceeding 64KB size limit', () => {
      const res = validateRcsPayload({
        messageType: 'text',
        text: 'A',
        largePadding: 'x'.repeat(70000),
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('exceeds maximum allowed size of 64KB');
    });
  });
});
