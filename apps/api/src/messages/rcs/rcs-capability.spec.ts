import {
  RCS_MESSAGE_TYPES,
  RCS_MESSAGE_TYPES_CAPABILITY,
  rcsProviderSupports,
  validateRcsMessageTypesCapability,
} from '@acc/contracts';

describe('rcs_message_types capability (Phase 4.2)', () => {
  it('is the published standard key', () => {
    expect(RCS_MESSAGE_TYPES_CAPABILITY).toBe('rcs_message_types');
  });

  describe('validateRcsMessageTypesCapability', () => {
    it.each([[['text']], [['media', 'rich_card']], [[...RCS_MESSAGE_TYPES]]])(
      'accepts %j',
      (value) => {
        expect(validateRcsMessageTypesCapability(value)).toEqual({ valid: true, errors: [] });
      },
    );

    it.each([
      ['an empty array', []],
      ['a string', 'text'],
      ['null', null],
      ['an object', { text: true }],
      ['an unknown type', ['text', 'carousel']],
      ['a wrong case', ['TEXT']],
      ['a non-string entry', ['text', 1]],
      ['a duplicate', ['text', 'text']],
    ])('refuses %s', (_label, value) => {
      const result = validateRcsMessageTypesCapability(value);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('rcsProviderSupports', () => {
    it('no declaration (or no capabilities) carries every type — backward compatible', () => {
      for (const type of RCS_MESSAGE_TYPES) {
        expect(rcsProviderSupports({}, type)).toBe(true);
        expect(rcsProviderSupports(undefined, type)).toBe(true);
        expect(rcsProviderSupports({ simulator_behavior: '500' }, type)).toBe(true);
      }
    });

    it('a valid declaration is enforced exactly', () => {
      const caps = { rcs_message_types: ['text', 'media'] };
      expect(rcsProviderSupports(caps, 'text')).toBe(true);
      expect(rcsProviderSupports(caps, 'media')).toBe(true);
      expect(rcsProviderSupports(caps, 'rich_card')).toBe(false);
    });

    it.each([[[]], ['rich_card'], [null], [['rich_card', 'carousel']]])(
      'an invalid declaration (%j) carries nothing — fail closed',
      (value) => {
        for (const type of RCS_MESSAGE_TYPES) {
          expect(rcsProviderSupports({ rcs_message_types: value }, type)).toBe(false);
        }
      },
    );
  });
});
