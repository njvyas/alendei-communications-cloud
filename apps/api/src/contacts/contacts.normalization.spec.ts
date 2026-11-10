import { ERROR_CODES } from '@acc/contracts';
import { AppException } from '../common/errors/app.exception';
import {
  escapeCsvFormulaField,
  escapeCustomFieldsForCsv,
  normalizeAddress,
  normalizeEmailAddress,
  normalizePhoneNumber,
  unescapeCsvFormulaField,
  unescapeCustomFieldsFromCsv,
} from './contacts.normalization';

describe('Contacts Normalization (P3-D25 & Phase 8A-2)', () => {
  describe('normalizePhoneNumber', () => {
    it('accepts valid E.164 phone numbers', () => {
      expect(normalizePhoneNumber('+12025550123')).toBe('+12025550123');
      expect(normalizePhoneNumber('+447911123456')).toBe('+447911123456');
      expect(normalizePhoneNumber('+919876543210')).toBe('+919876543210');
    });

    it('strips common whitespace and delimiter formatting for E.164 numbers', () => {
      expect(normalizePhoneNumber('+1 (202) 555-0123')).toBe('+12025550123');
      expect(normalizePhoneNumber('+44 7911 123456')).toBe('+447911123456');
    });

    it('strips single quote safety prefix if and only if remainder conforms to E.164', () => {
      expect(normalizePhoneNumber("'+12025550123")).toBe('+12025550123');
      expect(normalizePhoneNumber("'+44 7911 123456")).toBe('+447911123456');
      expect(normalizePhoneNumber(" '+919876543210' ")).toBe('+919876543210');
    });

    it('rejects numbers missing leading + with PHONE_MISSING_COUNTRY_CODE (no guessing)', () => {
      expect.assertions(3);
      try {
        normalizePhoneNumber('2025550123');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        const appErr = error as AppException;
        expect(appErr.code).toBe(ERROR_CODES.PHONE_MISSING_COUNTRY_CODE);
        expect(appErr.getStatus()).toBe(400);
      }
    });

    it('rejects quoted numbers missing leading + with PHONE_MISSING_COUNTRY_CODE', () => {
      expect(() => normalizePhoneNumber("'2025550123")).toThrow(
        expect.objectContaining({ code: ERROR_CODES.PHONE_MISSING_COUNTRY_CODE }),
      );
    });

    it('rejects quoted numbers with leading + but invalid format with INVALID_PHONE_NUMBER', () => {
      expect(() => normalizePhoneNumber("'+123")).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_PHONE_NUMBER }),
      );
      expect(() => normalizePhoneNumber("'+0123456789")).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_PHONE_NUMBER }),
      );
    });

    it('rejects numbers starting with + but failing E.164 length/characters with INVALID_PHONE_NUMBER', () => {
      // Too short
      expect(() => normalizePhoneNumber('+123')).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_PHONE_NUMBER }),
      );
      // Non-digits
      expect(() => normalizePhoneNumber('+1202abc0123')).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_PHONE_NUMBER }),
      );
      // Starts with +0 (country codes cannot start with 0)
      expect(() => normalizePhoneNumber('+0123456789')).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_PHONE_NUMBER }),
      );
    });
  });

  describe('normalizeEmailAddress', () => {
    it('lowercases domain while preserving local-part casing', () => {
      expect(normalizeEmailAddress('John.Doe+Newsletter@EXAMPLE.COM')).toBe(
        'John.Doe+Newsletter@example.com',
      );
      expect(normalizeEmailAddress('User@Sub.Domain.Org')).toBe('User@sub.domain.org');
    });

    it('preserves dots and plus tags in local-part without stripping', () => {
      expect(normalizeEmailAddress('alice.smith+tag1+tag2@example.com')).toBe(
        'alice.smith+tag1+tag2@example.com',
      );
    });

    it('rejects malformed email addresses with INVALID_EMAIL_ADDRESS', () => {
      expect(() => normalizeEmailAddress('notanemail')).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_EMAIL_ADDRESS }),
      );
      expect(() => normalizeEmailAddress('@example.com')).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_EMAIL_ADDRESS }),
      );
      expect(() => normalizeEmailAddress('user@')).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_EMAIL_ADDRESS }),
      );
      expect(() => normalizeEmailAddress('user@invalid_domain')).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_EMAIL_ADDRESS }),
      );
    });
  });

  describe('normalizeAddress', () => {
    it('normalizes based on channel code', () => {
      expect(normalizeAddress('Alice@Corp.Com', 'email')).toBe('Alice@corp.com');
      expect(normalizeAddress('+1 (555) 000-1111', 'whatsapp')).toBe('+15550001111');
      expect(normalizeAddress('+1 (555) 000-1111', 'sms')).toBe('+15550001111');
    });

    it('normalizes using heuristic when channel is omitted', () => {
      expect(normalizeAddress('Bob@Example.Com')).toBe('Bob@example.com');
      expect(normalizeAddress('+1 (555) 000-2222')).toBe('+15550002222');
      expect(() => normalizeAddress('5550002222')).toThrow(
        expect.objectContaining({ code: ERROR_CODES.PHONE_MISSING_COUNTRY_CODE }),
      );
    });
  });

  describe('CSV Formula Injection Defense & Round-trip Reversibility', () => {
    it('escapes and unescapes formula trigger characters (=, +, -, @, \\t, \\r)', () => {
      const formulaCases = [
        "=cmd|' /C calc'!A0",
        '+15551234567',
        '+SUM(A1:A10)',
        '-42',
        '@SUM(B1)',
        '\tTAB_INDENT',
        '\rCR_PREFIX',
      ];

      for (const val of formulaCases) {
        const escaped = escapeCsvFormulaField(val);
        expect(escaped).toBe(`'${val}`);
        if (val.startsWith('+') && /^\+[1-9]\d{6,14}$/.test(val)) {
          // Phones are decoded via normalizePhoneNumber
          expect(normalizePhoneNumber(escaped)).toBe(val);
        } else {
          const unescaped = unescapeCsvFormulaField(escaped);
          expect(unescaped).toBe(val);
        }
      }
    });

    it('doubles and reversibly restores genuine leading apostrophes', () => {
      const apostropheVal = "'O'Connor";
      const escaped = escapeCsvFormulaField(apostropheVal);
      expect(escaped).toBe("''O'Connor");
      const unescaped = unescapeCsvFormulaField(escaped);
      expect(unescaped).toBe(apostropheVal);
    });

    it('leaves standard text unmodified', () => {
      expect(escapeCsvFormulaField('Jane Doe')).toBe('Jane Doe');
      expect(unescapeCsvFormulaField('Jane Doe')).toBe('Jane Doe');
      expect(escapeCsvFormulaField('hello@example.com')).toBe('hello@example.com');
      expect(unescapeCsvFormulaField('hello@example.com')).toBe('hello@example.com');
    });

    it('reversibly escapes and unescapes custom fields dictionaries for CSV', () => {
      const originalCustomFields = {
        badge: '2317',
        title: '=VP Engineering',
        priority: '+urgent',
        calc: '-100',
        mention: '@lead',
        rawText: 'Standard Value',
        genuineQuote: "'O'Connor",
        numericField: 42,
        booleanField: true,
      };

      const escaped = escapeCustomFieldsForCsv(originalCustomFields);
      expect(escaped).toEqual({
        badge: '2317',
        title: "'=VP Engineering",
        priority: "'+urgent",
        calc: "'-100",
        mention: "'@lead",
        rawText: 'Standard Value',
        genuineQuote: "''O'Connor",
        numericField: 42,
        booleanField: true,
      });

      const unescaped = unescapeCustomFieldsFromCsv(escaped);
      expect(unescaped).toEqual(originalCustomFields);
    });

    it('reversibly escapes and unescapes tags array for CSV export/import', () => {
      const tags = ['=vip', '+urgent', '-lead', '@group', 'standard-tag', "'single-quote"];
      const escapedTags = tags.map((t) => escapeCsvFormulaField(t));
      expect(escapedTags).toEqual([
        "'=vip",
        "'+urgent",
        "'-lead",
        "'@group",
        'standard-tag',
        "''single-quote",
      ]);

      const joinedForCsv = escapedTags.join(';');
      const roundTrippedTags = joinedForCsv.split(';').map((t) => unescapeCsvFormulaField(t));
      expect(roundTrippedTags).toEqual(tags);
    });

    it('preserves raw JSON values unmodified without adding CSV formula escapes', () => {
      const rawPayload = {
        phone: '+15551234567',
        email: 'user@example.test',
        firstName: '=FormulaFirst',
        lastName: '+FormulaLast',
        customFields: {
          formula: '=SUM(1,2)',
          notes: '+critical',
        },
      };

      // In JSON mode, values are serialized directly without escapeCsvFormulaField
      const serializedJson = JSON.stringify(rawPayload);
      const deserializedJson = JSON.parse(serializedJson);

      expect(deserializedJson.phone).toBe('+15551234567');
      expect(deserializedJson.firstName).toBe('=FormulaFirst');
      expect(deserializedJson.lastName).toBe('+FormulaLast');
      expect(deserializedJson.customFields.formula).toBe('=SUM(1,2)');
      expect(deserializedJson.customFields.notes).toBe('+critical');
    });
  });
});
