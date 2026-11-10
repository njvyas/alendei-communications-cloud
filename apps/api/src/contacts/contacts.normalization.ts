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

function escapeAnyForCsv(value: unknown): unknown {
  if (typeof value === 'string') {
    return escapeCsvFormulaField(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => escapeAnyForCsv(item));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = escapeAnyForCsv(v);
    }
    return result;
  }
  return value;
}

function unescapeAnyFromCsv(value: unknown): unknown {
  if (typeof value === 'string') {
    return unescapeCsvFormulaField(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => unescapeAnyFromCsv(item));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = unescapeAnyFromCsv(v);
    }
    return result;
  }
  return value;
}

/**
 * Recursively escapes string values inside a customFields dictionary at any depth for spreadsheet-safe CSV export.
 */
export function escapeCustomFieldsForCsv(
  fields: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return null;
  }
  return escapeAnyForCsv(fields) as Record<string, unknown>;
}

/**
 * Recursively unescapes string values inside a customFields dictionary at any depth from CSV import.
 */
export function unescapeCustomFieldsFromCsv(
  fields: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return null;
  }
  return unescapeAnyFromCsv(fields) as Record<string, unknown>;
}

/**
 * Serializes tags into a lossless JSON array string for CSV export, with formula protection.
 * Preserves commas, semicolons, quotes, and line breaks within tags.
 */
export function escapeTagsForCsv(tags: string[] | null | undefined): string {
  if (!tags || tags.length === 0) {
    return '';
  }
  const escaped = tags.map((t) => escapeCsvFormulaField(t));
  return JSON.stringify(escaped);
}

/**
 * Deserializes tags from a CSV string. Supports lossless JSON array representation
 * as well as legacy comma/semicolon delimited strings.
 */
export function unescapeTagsFromCsv(raw: string | null | undefined): string[] | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const unescapedRaw = unescapeCsvFormulaField(raw.trim());
  try {
    const parsed = JSON.parse(unescapedRaw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => (typeof item === 'string' ? unescapeCsvFormulaField(item) : String(item)))
        .filter((item) => item.length > 0);
    }
  } catch {
    // Fallback for simple comma/semicolon delimited strings
  }
  return unescapedRaw
    .split(/[;,]/)
    .map((t) => unescapeCsvFormulaField(t.trim()))
    .filter((t) => t.length > 0);
}
