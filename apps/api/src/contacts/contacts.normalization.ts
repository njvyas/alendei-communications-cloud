import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';
import { AppException } from '../common/errors/app.exception';

export const FORMULA_TRIGGER_CHARS = ['=', '+', '-', '@', '\t', '\r'] as const;

/**
 * Normalizes phone numbers to standard E.164: `/^\+[1-9]\d{6,14}$/`.
 * If the input starts with a single quote prefix (') followed by +,
 * strip the leading quote if and only if the remainder conforms to E.164.
 * Rejects missing country code (no leading +) with 400 PHONE_MISSING_COUNTRY_CODE.
 * Rejects non-conforming numbers with 400 INVALID_PHONE_NUMBER.
 */
export function normalizePhoneNumber(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("'")) {
    let candidate = trimmed.slice(1).trim();
    if (candidate.endsWith("'")) {
      candidate = candidate.slice(0, -1).trim();
    }
    if (candidate.startsWith('+')) {
      const candidateCleaned = candidate.replace(/[\s\-()]/g, '');
      if (/^\+[1-9]\d{6,14}$/.test(candidateCleaned)) {
        return candidateCleaned;
      }
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.INVALID_PHONE_NUMBER,
        message: 'Phone number is invalid (must be E.164: + followed by 7-15 digits)',
      });
    }
  }

  if (!trimmed.startsWith('+')) {
    throw new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.PHONE_MISSING_COUNTRY_CODE,
      message: 'Phone number must start with a + and include country code',
    });
  }
  const cleaned = trimmed.replace(/[\s\-()]/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) {
    throw new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.INVALID_PHONE_NUMBER,
      message: 'Phone number is invalid (must be E.164: + followed by 7-15 digits)',
    });
  }
  return cleaned;
}

/**
 * Normalizes email addresses per RFC 5322:
 * Preserves local-part casing, dots, and plus tags.
 * Lowercases the domain part.
 * Rejects invalid format with 400 INVALID_EMAIL_ADDRESS.
 */
export function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === trimmed.length - 1) {
    throw new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.INVALID_EMAIL_ADDRESS,
      message: 'Email address must contain @ with non-empty local-part and domain',
    });
  }
  const localPart = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1).toLowerCase();
  const candidate = `${localPart}@${domain}`;

  // RFC 5322 check
  const emailRegex =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!emailRegex.test(candidate)) {
    throw new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.INVALID_EMAIL_ADDRESS,
      message: 'Invalid email address format',
    });
  }
  return candidate;
}

/**
 * Normalizes destination addresses based on channel code or heuristic.
 */
export function normalizeAddress(raw: string, channelCode?: string | null): string {
  if (channelCode === 'email') {
    return normalizeEmailAddress(raw);
  }
  if (channelCode && ['whatsapp', 'sms', 'rcs', 'voice'].includes(channelCode)) {
    return normalizePhoneNumber(raw);
  }
  // Heuristic when channel is null (e.g. org-wide suppression)
  if (raw.includes('@')) {
    return normalizeEmailAddress(raw);
  }
  return normalizePhoneNumber(raw);
}

/**
 * Escapes a text string for spreadsheet-safe CSV export (defending against CSV/formula injection).
 * - If string starts with `'`: prepend `'` -> `''...` (reversible escape for genuine leading apostrophe).
 * - If string starts with `=`, `+`, `-`, `@`, `\t`, or `\r`: prepend `'` -> `'=...`.
 * - Otherwise: return unmodified.
 */
export function escapeCsvFormulaField(value: string): string {
  if (value.startsWith("'")) {
    return `'${value}`;
  }
  const firstChar = value.charAt(0);
  if (FORMULA_TRIGGER_CHARS.includes(firstChar as (typeof FORMULA_TRIGGER_CHARS)[number])) {
    return `'${value}`;
  }
  return value;
}

/**
 * Reversibly unescapes a text string from a spreadsheet-safe CSV import.
 * - If string starts with `''`: strip the first `'` -> `'...` (recovers genuine leading apostrophe).
 * - If string starts with `'` followed by `=`, `+`, `-`, `@`, `\t`, or `\r`: strip `'` -> `=...`.
 * - Otherwise: return unmodified.
 */
export function unescapeCsvFormulaField(value: string): string {
  if (value.startsWith("''")) {
    return value.slice(1);
  }
  if (value.startsWith("'") && value.length > 1) {
    const secondChar = value.charAt(1);
    if (FORMULA_TRIGGER_CHARS.includes(secondChar as (typeof FORMULA_TRIGGER_CHARS)[number])) {
      return value.slice(1);
    }
  }
  return value;
}
