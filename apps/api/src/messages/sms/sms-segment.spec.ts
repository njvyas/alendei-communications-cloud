import {
  calculateSmsSegments,
  extractTemplatePlaceholders,
  validateDltMetadata,
  validateSmsPayloadShape,
  validateSmsTemplateBody,
  validateSmsTemplateVariables,
  renderTemplate,
  SMS_CONSTRAINTS,
  SMS_TEMPLATE_CONSTRAINTS,
} from '@acc/contracts';

describe('SMS Segmentation and DLT Validation (Phase 4.1 Gate F.1)', () => {
  describe('calculateSmsSegments — GSM-7 Basic Encoding', () => {
    it('returns 0 segments for empty text', () => {
      const res = calculateSmsSegments('');
      expect(res.encoding).toBe('GSM-7');
      expect(res.characterCount).toBe(0);
      expect(res.totalUnits).toBe(0);
      expect(res.segmentCount).toBe(0);
      expect(res.remainingInCurrentSegment).toBe(SMS_CONSTRAINTS.GSM7_SINGLE_MAX_UNITS);
    });

    it('calculates 1 segment for GSM-7 text within 160 characters', () => {
      const text = 'Hello world, this is a standard GSM-7 message within 160 characters limit.';
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('GSM-7');
      expect(res.characterCount).toBe(text.length);
      expect(res.totalUnits).toBe(text.length);
      expect(res.segmentCount).toBe(1);
      expect(res.maxUnitsPerSegment).toBe(160);
      expect(res.remainingInCurrentSegment).toBe(160 - text.length);
      expect(res.hasExtendedGsmChars).toBe(false);
      expect(res.nonGsmCharacters).toEqual([]);
    });

    it('handles exact 160 GSM-7 character boundary as 1 segment', () => {
      const text = 'a'.repeat(160);
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('GSM-7');
      expect(res.totalUnits).toBe(160);
      expect(res.segmentCount).toBe(1);
      expect(res.remainingInCurrentSegment).toBe(0);
    });

    it('splits into 2 concatenated segments at 161 GSM-7 characters with 153 capacity per segment', () => {
      const text = 'a'.repeat(161);
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('GSM-7');
      expect(res.totalUnits).toBe(161);
      expect(res.segmentCount).toBe(2);
      expect(res.maxUnitsPerSegment).toBe(153);
      // Segment 1: 153 chars, Segment 2: 8 chars -> remaining: 153 - 8 = 145
      expect(res.remainingInCurrentSegment).toBe(153 - (161 % 153));
    });

    it('calculates exact segments for multi-part GSM-7 text (e.g. 306 chars = exactly 2 segments)', () => {
      const text = 'a'.repeat(306); // 153 * 2
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('GSM-7');
      expect(res.totalUnits).toBe(306);
      expect(res.segmentCount).toBe(2);
      expect(res.remainingInCurrentSegment).toBe(0);
    });

    it('transitions to 3 segments at 307 characters', () => {
      const text = 'a'.repeat(307);
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('GSM-7');
      expect(res.totalUnits).toBe(307);
      expect(res.segmentCount).toBe(3);
    });
  });

  describe('calculateSmsSegments — GSM-7 Extended Characters', () => {
    it('counts extended characters as 2 units (septets)', () => {
      // Extended characters: ^ { } \ [ ~ ] | €
      const text = 'Price: 100€ [urgent]';
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('GSM-7');
      expect(res.hasExtendedGsmChars).toBe(true);
      // 'Price: 100' (10) + '€' (2) + ' ' (1) + '[' (2) + 'urgent' (6) + ']' (2) = 23 units
      // Character count: 20
      expect(res.characterCount).toBe(20);
      expect(res.totalUnits).toBe(23);
      expect(res.segmentCount).toBe(1);
    });

    it('properly triggers concatenation boundary when extended characters cause total units to exceed 160', () => {
      // 158 basic chars + 1 extended char (€ = 2 units) -> 160 units (1 segment)
      const text160 = 'a'.repeat(158) + '€';
      const res160 = calculateSmsSegments(text160);
      expect(res160.totalUnits).toBe(160);
      expect(res160.segmentCount).toBe(1);

      // 159 basic chars + 1 extended char (€ = 2 units) -> 161 units (2 segments)
      const text161 = 'a'.repeat(159) + '€';
      const res161 = calculateSmsSegments(text161);
      expect(res161.totalUnits).toBe(161);
      expect(res161.segmentCount).toBe(2);
    });
    it('prevents escape characters from being split across 153-unit concatenated boundaries', () => {
      // 152 basic chars + 1 extended char (€ = 2 units) + 1 basic char = 155 units (> 160 units total when padded to concat)
      // Segment 1 holds 152 chars; € requires 2 units so it must move to Segment 2
      const prefix = 'a'.repeat(152);
      const text = prefix + '€' + 'b'.repeat(10);
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('GSM-7');
      expect(res.segmentCount).toBe(2);
      expect(res.hasExtendedGsmChars).toBe(true);
    });
  });

  describe('calculateSmsSegments — UCS-2 Unicode Encoding & Surrogate Pair Packing', () => {
    it('detects Unicode characters and switches to UCS-2 encoding', () => {
      const text = 'Hello 👋 world'; // emoji is non-GSM
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('UCS-2');
      expect(res.nonGsmCharacters.length).toBeGreaterThan(0);
      expect(res.maxUnitsPerSegment).toBe(SMS_CONSTRAINTS.UCS2_SINGLE_MAX_UNITS); // 70
    });

    it('calculates 1 segment for UCS-2 up to 70 code units', () => {
      const text = 'नमस्ते दुनिया!'; // Hindi text (all BMP characters)
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('UCS-2');
      expect(res.totalUnits).toBe(text.length);
      expect(res.segmentCount).toBe(1);
      expect(res.maxUnitsPerSegment).toBe(70);
    });

    it('counts astral plane emoji as 2 UTF-16 code units (surrogate pair) in UCS-2', () => {
      // 35 emojis = 70 UTF-16 code units -> exactly 1 segment
      const text35 = '👋'.repeat(35);
      const res35 = calculateSmsSegments(text35);
      expect(res35.encoding).toBe('UCS-2');
      expect(res35.characterCount).toBe(35); // 35 code points
      expect(res35.totalUnits).toBe(70); // 70 UTF-16 code units
      expect(res35.segmentCount).toBe(1);

      // 36 emojis = 72 UTF-16 code units -> exceeds 70 single capacity
      // Concat capacity = 67. 33 emojis = 66 units; 34th emoji (2 units) moves to Segment 2.
      const text36 = '👋'.repeat(36);
      const res36 = calculateSmsSegments(text36);
      expect(res36.totalUnits).toBe(72);
      expect(res36.segmentCount).toBe(2);

      // 70 emojis = 140 UTF-16 code units -> 3 segments (66 + 66 + 8 units)
      const text70 = '👋'.repeat(70);
      const res70 = calculateSmsSegments(text70);
      expect(res70.totalUnits).toBe(140);
      expect(res70.segmentCount).toBe(3);
    });

    it('prevents surrogate pairs from being split across 67-unit concatenated boundaries', () => {
      // 66 BMP chars (66 units) + 1 emoji (2 units) = 68 units
      // Emoji cannot fit in Segment 1 without splitting its surrogate pair, so it must move to Segment 2
      const text = '★'.repeat(66) + '🚀' + '★'.repeat(5);
      const res = calculateSmsSegments(text);
      expect(res.segmentCount).toBe(2);
      // Segment 1: 66 units (remaining: 1 unit)
      // Segment 2: 2 units (🚀) + 5 units (★★★★★) = 7 units
      expect(res.remainingInCurrentSegment).toBe(67 - 7);
    });

    it('splits into 2 concatenated segments at 71 BMP UCS-2 characters with 67 capacity per segment', () => {
      const text = 'Привет мир! ' + 'а'.repeat(60); // Cyrillic
      const res = calculateSmsSegments(text);
      expect(res.encoding).toBe('UCS-2');
      expect(res.totalUnits).toBe(text.length);
      expect(res.segmentCount).toBe(2);
      expect(res.maxUnitsPerSegment).toBe(67);
      expect(res.remainingInCurrentSegment).toBe(67 - (text.length % 67));
    });

    it('calculates exact 3 segments for 135 BMP UCS-2 characters (67 * 2 = 134 -> 2 segments, 135 -> 3 segments)', () => {
      const text134 = '★'.repeat(134);
      const res134 = calculateSmsSegments(text134);
      expect(res134.segmentCount).toBe(2);

      const text135 = '★'.repeat(135);
      const res135 = calculateSmsSegments(text135);
      expect(res135.segmentCount).toBe(3);
    });

    it('throws TypeError if text is not a string', () => {
      expect(() => calculateSmsSegments(123 as unknown as string)).toThrow(TypeError);
      expect(() => calculateSmsSegments(null as unknown as string)).toThrow(TypeError);
      expect(() => calculateSmsSegments({} as unknown as string)).toThrow(TypeError);
    });
  });

  describe('validateDltMetadata', () => {
    it('accepts valid entityId, templateId, and headerId', () => {
      const res = validateDltMetadata({
        entityId: '1201159123456789012',
        templateId: '1207161234567890123',
        headerId: 'ALENDE',
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('accepts valid DLT metadata without optional headerId', () => {
      const res = validateDltMetadata({
        entityId: '1201159123456789012',
        templateId: '1207161234567890123',
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });

    it('rejects null, array, or non-object input', () => {
      expect(validateDltMetadata(null).valid).toBe(false);
      expect(validateDltMetadata([]).valid).toBe(false);
      expect(validateDltMetadata('string').valid).toBe(false);
      expect(validateDltMetadata(12345).valid).toBe(false);
    });

    it('rejects unknown fields in DLT metadata', () => {
      const res = validateDltMetadata({
        entityId: '1201159123456789012',
        templateId: '1207161234567890123',
        unknownField: 'malicious',
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("unknown field 'unknownField'");
    });

    it('rejects entityId that is not 10-25 numerical digits', () => {
      const tooShort = validateDltMetadata({
        entityId: '123456789', // 9 digits
        templateId: '1207161234567890123',
      });
      expect(tooShort.valid).toBe(false);
      expect(tooShort.errors[0]).toContain('entityId');

      const nonDigits = validateDltMetadata({
        entityId: '1201159ABC123456789',
        templateId: '1207161234567890123',
      });
      expect(nonDigits.valid).toBe(false);
      expect(nonDigits.errors[0]).toContain('entityId');
    });

    it('rejects templateId that is not 10-25 numerical digits', () => {
      const tooLong = validateDltMetadata({
        entityId: '1201159123456789012',
        templateId: '1'.repeat(26), // 26 digits
      });
      expect(tooLong.valid).toBe(false);
      expect(tooLong.errors[0]).toContain('templateId');
    });

    it('rejects invalid headerId format', () => {
      const invalidHeader = validateDltMetadata({
        entityId: '1201159123456789012',
        templateId: '1207161234567890123',
        headerId: 'AB', // too short (< 3)
      });
      expect(invalidHeader.valid).toBe(false);
      expect(invalidHeader.errors[0]).toContain('headerId');

      const specialCharsHeader = validateDltMetadata({
        entityId: '1201159123456789012',
        templateId: '1207161234567890123',
        headerId: 'ALEN-DE', // hyphen not allowed
      });
      expect(specialCharsHeader.valid).toBe(false);
      expect(specialCharsHeader.errors[0]).toContain('headerId');
    });
  });

  describe('renderTemplate deterministic variable substitution', () => {
    it('substitutes named variables correctly', () => {
      const res = renderTemplate('Hello {{name}}, your code is {{code}}.', {
        name: 'Alice',
        code: '123456',
      });
      expect(res.text).toBe('Hello Alice, your code is 123456.');
      expect(res.missingVariables).toEqual([]);
    });

    it('substitutes numeric 1-indexed variables correctly from dictionary or array', () => {
      const resDict = renderTemplate('OTP: {{1}}', { '1': '999888' });
      expect(resDict.text).toBe('OTP: 999888');
      expect(resDict.missingVariables).toEqual([]);

      const resArr = renderTemplate('OTP: {{1}}', ['999888']);
      expect(resArr.text).toBe('OTP: 999888');
      expect(resArr.missingVariables).toEqual([]);
    });

    it('detects missing variables and leaves placeholders un-rendered', () => {
      const res = renderTemplate('Hello {{name}}, code is {{1}}', { name: 'Bob' });
      expect(res.text).toBe('Hello Bob, code is {{1}}');
      expect(res.missingVariables).toEqual(['1']);
    });
  });

  describe('validateSmsTemplateBody — fixed content and placeholder grammar', () => {
    it('accepts a body with fixed content and valid placeholders', () => {
      expect(validateSmsTemplateBody('Your code is {{1}}.').valid).toBe(true);
      expect(validateSmsTemplateBody('Hi {{first_name}}, ref {{Ref2}}').valid).toBe(true);
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   \n\t '],
      ['single placeholder', '{{1}}'],
      ['placeholders and whitespace only', ' {{1}}  {{name}}\n'],
      ['padded placeholder only', '{{ msg }}'],
    ])('rejects a %s body', (_label, body) => {
      const res = validateSmsTemplateBody(body);
      expect(res.valid).toBe(false);
      expect(res.errors.join(' ')).toContain('fixed content');
    });

    it('rejects invalid placeholder names and malformed braces', () => {
      expect(validateSmsTemplateBody('Code {{a-b}}').valid).toBe(false);
      expect(validateSmsTemplateBody(`Code {{${'x'.repeat(33)}}}`).valid).toBe(false);
      expect(validateSmsTemplateBody('Code {{1}} and {{2').valid).toBe(false);
      expect(validateSmsTemplateBody('Code }} here').valid).toBe(false);
    });

    it('rejects more placeholders than the configured maximum', () => {
      const n = SMS_TEMPLATE_CONSTRAINTS.MAX_PLACEHOLDERS + 1;
      const body = 'X ' + Array.from({ length: n }, (_, i) => `{{v${i}}}`).join(' ');
      expect(validateSmsTemplateBody(body).valid).toBe(false);
    });

    it('rejects a non-string body', () => {
      expect(validateSmsTemplateBody(42).valid).toBe(false);
    });

    it('extracts distinct trimmed placeholder names in order', () => {
      expect(extractTemplatePlaceholders('{{ a }} {{b}} {{a}}')).toEqual(['a', 'b']);
    });
  });

  describe('validateSmsTemplateVariables — names, types and lengths', () => {
    const body = 'Code {{1}} for {{name}}';
    const max = SMS_TEMPLATE_CONSTRAINTS.DEFAULT_VARIABLE_MAX_LENGTH;

    it('accepts values exactly at the maximum length', () => {
      const res = validateSmsTemplateVariables(body, { '1': 'a'.repeat(max), name: 'Bo' }, max);
      expect(res.valid).toBe(true);
    });

    it('measures length in code points, so an astral character counts once', () => {
      const res = validateSmsTemplateVariables(body, { '1': '😀'.repeat(max), name: 'x' }, max);
      expect(res.valid).toBe(true);
    });

    it('rejects a value one character over the maximum', () => {
      const res = validateSmsTemplateVariables(body, { '1': 'a'.repeat(max + 1), name: 'Bo' }, max);
      expect(res.valid).toBe(false);
      expect(res.errors.join(' ')).toContain('maximum length');
    });

    it('honours a configured maximum', () => {
      expect(validateSmsTemplateVariables(body, { '1': 'abcdef', name: 'x' }, 5).valid).toBe(false);
      expect(validateSmsTemplateVariables(body, { '1': 'abcde', name: 'x' }, 5).valid).toBe(true);
    });

    it.each([
      ['object', { nested: 'x' }],
      ['array', ['x']],
      ['boolean', true],
      ['null', null],
      ['empty string', ''],
    ])('rejects a %s value', (_label, value) => {
      expect(validateSmsTemplateVariables(body, { '1': value, name: 'Bo' }, max).valid).toBe(false);
    });

    it('accepts finite numbers', () => {
      expect(validateSmsTemplateVariables(body, { '1': 123456, name: 'Bo' }, max).valid).toBe(true);
    });

    it('rejects missing, undeclared, and non-object variables', () => {
      expect(validateSmsTemplateVariables(body, { '1': 'x' }, max).valid).toBe(false);
      expect(
        validateSmsTemplateVariables(body, { '1': 'x', name: 'y', extra: 'z' }, max).valid,
      ).toBe(false);
      expect(validateSmsTemplateVariables(body, 'x', max).valid).toBe(false);
      expect(validateSmsTemplateVariables(body, undefined, max).valid).toBe(false);
    });

    it('rejects control characters and placeholder braces in values', () => {
      expect(validateSmsTemplateVariables(body, { '1': 'a\nb', name: 'x' }, max).valid).toBe(false);
      expect(validateSmsTemplateVariables(body, { '1': '{{name}}', name: 'x' }, max).valid).toBe(
        false,
      );
    });

    it('maps arrays to 1-indexed placeholders and rejects surplus entries', () => {
      expect(validateSmsTemplateVariables('OTP {{1}}', ['42'], max).valid).toBe(true);
      expect(validateSmsTemplateVariables('OTP {{1}}', ['42', '43'], max).valid).toBe(false);
    });

    it('accepts no variables for a body without placeholders', () => {
      expect(validateSmsTemplateVariables('Static notice', undefined, max).valid).toBe(true);
    });
  });

  describe('validateSmsPayloadShape — allowlist and size', () => {
    it('accepts allowlisted fields', () => {
      const res = validateSmsPayloadShape({
        variables: { '1': 'x' },
        dlt: { entityId: '1234567890', templateId: '1234567890' },
        maxSegments: 2,
        text: 'x',
      });
      expect(res.valid).toBe(true);
    });

    it('rejects unknown fields', () => {
      const res = validateSmsPayloadShape({ variables: {}, senderOverride: 'X' });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain('senderOverride');
    });

    it('rejects payloads over the byte limit, counting UTF-8 bytes', () => {
      const limit = SMS_TEMPLATE_CONSTRAINTS.MAX_PAYLOAD_BYTES;
      expect(validateSmsPayloadShape({ text: 'é'.repeat(limit / 2) }).valid).toBe(false);
      expect(validateSmsPayloadShape({ text: 'a'.repeat(limit - 20) }).valid).toBe(true);
    });

    it('rejects non-object payloads', () => {
      expect(validateSmsPayloadShape(null).valid).toBe(false);
      expect(validateSmsPayloadShape([]).valid).toBe(false);
    });
  });
});
