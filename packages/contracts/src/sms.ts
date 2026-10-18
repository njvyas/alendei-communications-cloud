/**
 * SMS contracts, DLT regulatory metadata, and GSM-7/UCS-2 segmentation rules (Phase 4.1, Gate F.1, ADR-016).
 */

/**
 * DLT (Distributed Ledger Technology) regulatory metadata required for SMS in regulated markets.
 * Per ADR-016 D-3, carried at payload-level and bound to approved templates without schema changes.
 */
export interface SmsDltMetadata {
  /** Principal Entity ID (numeric string, typically 10-25 digits). */
  readonly entityId: string;
  /** DLT Content Template ID (numeric string, typically 10-25 digits). */
  readonly templateId: string;
  /** Registered Header / Sender ID (alphanumeric string, 3-11 chars, typically 6-char uppercase). */
  readonly headerId?: string;
}

/** GSM-7 Basic Character Set (RFC 5233 / 3GPP TS 23.038). Each character occupies 1 septet. */
export const GSM7_BASIC_CHARS: ReadonlySet<string> = new Set([
  '@',
  '£',
  '$',
  '¥',
  'è',
  'é',
  'ù',
  'ì',
  'ò',
  'Ç',
  '\n',
  'Ø',
  'ø',
  '\r',
  'Å',
  'å',
  'Δ',
  '_',
  'Φ',
  'Γ',
  'Λ',
  'Ω',
  'Π',
  'Ψ',
  'Σ',
  'Θ',
  'Ξ',
  'Æ',
  'æ',
  'ß',
  'É',
  ' ',
  '!',
  '"',
  '#',
  '¤',
  '%',
  '&',
  "'",
  '(',
  ')',
  '*',
  '+',
  ',',
  '-',
  '.',
  '/',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  ':',
  ';',
  '<',
  '=',
  '>',
  '?',
  '¡',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
  'Ä',
  'Ö',
  'Ñ',
  'Ü',
  '§',
  '¿',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
  'ä',
  'ö',
  'ñ',
  'ü',
  'à',
]);

/** GSM-7 Extended Character Set (3GPP TS 23.038). Each requires an ESC (0x1B) prefix, taking 2 septets. */
export const GSM7_EXTENDED_CHARS: ReadonlySet<string> = new Set([
  '\f', // Form feed
  '^', // Circumflex
  '{', // Left curly bracket
  '}', // Right curly bracket
  '\\', // Backslash
  '[', // Left square bracket
  '~', // Tilde
  ']', // Right square bracket
  '|', // Vertical bar
  '€', // Euro sign
]);

export interface SmsEncodingAnalysis {
  readonly encoding: 'GSM-7' | 'UCS-2';
  readonly characterCount: number;
  readonly totalUnits: number;
  readonly segmentCount: number;
  readonly maxUnitsPerSegment: number;
  readonly remainingInCurrentSegment: number;
  readonly hasExtendedGsmChars: boolean;
  readonly nonGsmCharacters: readonly string[];
}

export interface SmsSegmentationOptions {
  /** Maximum allowable segments before failing validation (default: 10). */
  readonly maxSegments?: number;
}

export const SMS_CONSTRAINTS = {
  /** Single GSM-7 segment limit. */
  GSM7_SINGLE_MAX_UNITS: 160,
  /** Concatenated GSM-7 segment capacity (160 - 7 units reserved for UDH). */
  GSM7_CONCAT_MAX_UNITS: 153,
  /** Single UCS-2 Unicode segment limit. */
  UCS2_SINGLE_MAX_UNITS: 70,
  /** Concatenated UCS-2 Unicode segment capacity (70 - 3 chars reserved for UDH). */
  UCS2_CONCAT_MAX_UNITS: 67,
  /** Default maximum segment ceiling to prevent unbounded concatenation. */
  DEFAULT_MAX_SEGMENTS: 10,
  /** DLT Principal Entity ID pattern (10 to 25 numerical digits). */
  DLT_ENTITY_ID_PATTERN: /^\d{10,25}$/,
  /** DLT Content Template ID pattern (10 to 25 numerical digits). */
  DLT_TEMPLATE_ID_PATTERN: /^\d{10,25}$/,
  /** DLT Header / Sender ID pattern (3 to 11 alphanumeric characters). */
  DLT_HEADER_PATTERN: /^[A-Za-z0-9]{3,11}$/,
} as const;

/**
 * SMS template and payload safeguards (Phase 4.1, Gate F.1 remediation).
 *
 * These are application safeguards, not statements of law or operator policy.
 * The variable-length default is deliberately conservative and is overridable
 * through `SMS_TEMPLATE_VARIABLE_MAX_LENGTH`; the regulator/operator limit has
 * not been verified and must be confirmed before production use.
 */
export const SMS_TEMPLATE_CONSTRAINTS = {
  /** Default maximum characters (Unicode code points) per substituted variable value. */
  DEFAULT_VARIABLE_MAX_LENGTH: 30,
  /** Upper bound an operator may configure for the per-variable maximum. */
  VARIABLE_MAX_LENGTH_CEILING: 500,
  /** Placeholder names inside `{{…}}`: 1–32 ASCII letters, digits or underscores. */
  PLACEHOLDER_NAME_PATTERN: /^[A-Za-z0-9_]{1,32}$/,
  /** Maximum distinct placeholders an SMS template may declare. */
  MAX_PLACEHOLDERS: 25,
  /** Fields an SMS `payload` may carry; everything else is rejected. */
  PAYLOAD_FIELDS: ['variables', 'dlt', 'maxSegments', 'text'] as const,
  /** Maximum serialized SMS payload size in UTF-8 bytes. */
  MAX_PAYLOAD_BYTES: 8192,
} as const;

/** Same grammar `renderTemplate` substitutes, so validation and rendering agree. */
const PLACEHOLDER_REGEX = /\{\{([^{}]+)\}\}/g;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export interface SmsValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** Distinct placeholder names (trimmed) referenced by a template body, in first-seen order. */
export function extractTemplatePlaceholders(body: string): readonly string[] {
  const names: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER_REGEX)) {
    const name = match[1]!.trim();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Validates an SMS template body: it must carry fixed (non-placeholder) content,
 * use only well-formed placeholders with valid names, and contain no stray braces.
 */
export function validateSmsTemplateBody(body: unknown): SmsValidationResult {
  if (typeof body !== 'string') {
    return { valid: false, errors: ['SMS template body must be a string'] };
  }
  const errors: string[] = [];
  const placeholders = extractTemplatePlaceholders(body);

  for (const name of placeholders) {
    if (!SMS_TEMPLATE_CONSTRAINTS.PLACEHOLDER_NAME_PATTERN.test(name)) {
      errors.push(
        `SMS template placeholder '{{${name}}}' must be 1-32 letters, digits or underscores`,
      );
    }
  }
  if (placeholders.length > SMS_TEMPLATE_CONSTRAINTS.MAX_PLACEHOLDERS) {
    errors.push(
      `SMS template declares more than ${SMS_TEMPLATE_CONSTRAINTS.MAX_PLACEHOLDERS} placeholders`,
    );
  }

  const fixedContent = body.replace(PLACEHOLDER_REGEX, '');
  if (fixedContent.includes('{{') || fixedContent.includes('}}')) {
    errors.push('SMS template body contains a malformed placeholder');
  }
  if (fixedContent.trim().length === 0) {
    errors.push('SMS template body must contain fixed content besides placeholders and whitespace');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates client-supplied variables against an SMS template body before rendering:
 * every placeholder must be supplied, no undeclared variable may be supplied, and every
 * value must be a non-empty string or finite number within `maxLength` code points,
 * free of control characters and placeholder braces.
 */
export function validateSmsTemplateVariables(
  body: string,
  variables: unknown,
  maxLength: number,
): SmsValidationResult {
  const errors: string[] = [];
  const placeholders = extractTemplatePlaceholders(body);

  let entries: Array<readonly [string, unknown]>;
  if (variables === undefined) {
    entries = [];
  } else if (Array.isArray(variables)) {
    entries = variables.map((value, index) => [String(index + 1), value] as const);
  } else if (variables !== null && typeof variables === 'object') {
    entries = Object.entries(variables as Record<string, unknown>);
  } else {
    return { valid: false, errors: ['SMS payload.variables must be an object or array'] };
  }

  const supplied = new Map(entries);
  for (const name of placeholders) {
    if (!supplied.has(name)) errors.push(`Missing required template variable '${name}'`);
  }

  for (const [name, value] of entries) {
    if (!placeholders.includes(name)) {
      errors.push(`Variable '${name}' is not declared by the template`);
      continue;
    }
    let text: string;
    if (typeof value === 'string') {
      text = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      text = String(value);
    } else {
      errors.push(`Variable '${name}' must be a string or finite number`);
      continue;
    }
    const length = Array.from(text).length;
    if (length === 0) {
      errors.push(`Variable '${name}' must not be empty`);
    } else if (length > maxLength) {
      errors.push(`Variable '${name}' exceeds the maximum length of ${maxLength} characters`);
    }
    if (CONTROL_CHARS.test(text)) {
      errors.push(`Variable '${name}' must not contain control characters`);
    }
    if (text.includes('{{') || text.includes('}}')) {
      errors.push(`Variable '${name}' must not contain placeholder braces`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates the shape of an SMS `payload` before any template work: a plain object,
 * only allowlisted fields, and within the serialized size limit.
 */
export function validateSmsPayloadShape(payload: unknown): SmsValidationResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['SMS payload must be a non-null object'] };
  }
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  } catch {
    return { valid: false, errors: ['SMS payload cannot be serialized to JSON'] };
  }
  if (bytes > SMS_TEMPLATE_CONSTRAINTS.MAX_PAYLOAD_BYTES) {
    return {
      valid: false,
      errors: [
        `SMS payload exceeds the maximum size of ${SMS_TEMPLATE_CONSTRAINTS.MAX_PAYLOAD_BYTES} bytes`,
      ],
    };
  }
  const allowed: readonly string[] = SMS_TEMPLATE_CONSTRAINTS.PAYLOAD_FIELDS;
  const errors = Object.keys(payload)
    .filter((key) => !allowed.includes(key))
    .map((key) => `SMS payload contains unknown field '${key}'`);
  return { valid: errors.length === 0, errors };
}

/**
 * Analyzes SMS message text and determines encoding (GSM-7 vs UCS-2) and exact segment count.
 * Compliant with 3GPP TS 23.038 / RFC 5233.
 *
 * Implements exact segment packing to ensure:
 * 1. GSM-7 extended characters (2 septets) are never split across concatenated segment boundaries (153 units).
 * 2. Unicode surrogate pairs (2 UTF-16 code units) are never split across concatenated segment boundaries (67 units).
 * 3. Astral plane characters in UCS-2 are counted as 2 UTF-16 code units.
 */
export function calculateSmsSegments(
  text: string,
  _options: SmsSegmentationOptions = {},
): SmsEncodingAnalysis {
  if (typeof text !== 'string') {
    throw new TypeError('SMS text must be a string');
  }

  const codePoints = Array.from(text);
  const characterCount = codePoints.length;

  if (characterCount === 0) {
    return {
      encoding: 'GSM-7',
      characterCount: 0,
      totalUnits: 0,
      segmentCount: 0,
      maxUnitsPerSegment: SMS_CONSTRAINTS.GSM7_SINGLE_MAX_UNITS,
      remainingInCurrentSegment: SMS_CONSTRAINTS.GSM7_SINGLE_MAX_UNITS,
      hasExtendedGsmChars: false,
      nonGsmCharacters: [],
    };
  }

  const nonGsm: string[] = [];
  let hasExtended = false;
  let gsmUnits = 0;

  for (const char of codePoints) {
    if (GSM7_BASIC_CHARS.has(char)) {
      gsmUnits += 1;
    } else if (GSM7_EXTENDED_CHARS.has(char)) {
      gsmUnits += 2;
      hasExtended = true;
    } else {
      nonGsm.push(char);
    }
  }

  const isGsm7 = nonGsm.length === 0;

  if (isGsm7) {
    const singleMax = SMS_CONSTRAINTS.GSM7_SINGLE_MAX_UNITS;
    const concatMax = SMS_CONSTRAINTS.GSM7_CONCAT_MAX_UNITS;

    if (gsmUnits <= singleMax) {
      return {
        encoding: 'GSM-7',
        characterCount,
        totalUnits: gsmUnits,
        segmentCount: 1,
        maxUnitsPerSegment: singleMax,
        remainingInCurrentSegment: singleMax - gsmUnits,
        hasExtendedGsmChars: hasExtended,
        nonGsmCharacters: [],
      };
    }

    // Concatenated GSM-7: simulate exact packing so 2-septet extended chars don't split across boundaries
    let segmentCount = 1;
    let currentSegmentUnits = 0;

    for (const char of codePoints) {
      const units = GSM7_EXTENDED_CHARS.has(char) ? 2 : 1;
      if (currentSegmentUnits + units > concatMax) {
        segmentCount += 1;
        currentSegmentUnits = units;
      } else {
        currentSegmentUnits += units;
      }
    }

    const remainingInCurrentSegment = concatMax - currentSegmentUnits;

    return {
      encoding: 'GSM-7',
      characterCount,
      totalUnits: gsmUnits,
      segmentCount,
      maxUnitsPerSegment: concatMax,
      remainingInCurrentSegment,
      hasExtendedGsmChars: hasExtended,
      nonGsmCharacters: [],
    };
  }

  // UCS-2 encoding: unit count is measured in UTF-16 code units (text.length)
  const totalUcs2Units = text.length;
  const singleMax = SMS_CONSTRAINTS.UCS2_SINGLE_MAX_UNITS;
  const concatMax = SMS_CONSTRAINTS.UCS2_CONCAT_MAX_UNITS;

  if (totalUcs2Units <= singleMax) {
    return {
      encoding: 'UCS-2',
      characterCount,
      totalUnits: totalUcs2Units,
      segmentCount: 1,
      maxUnitsPerSegment: singleMax,
      remainingInCurrentSegment: singleMax - totalUcs2Units,
      hasExtendedGsmChars: hasExtended,
      nonGsmCharacters: nonGsm,
    };
  }

  // Concatenated UCS-2: simulate exact packing so surrogate pairs (2 units) don't split across boundaries
  let segmentCount = 1;
  let currentSegmentUnits = 0;

  for (const char of codePoints) {
    const units = char.length; // 1 for BMP, 2 for surrogate pair
    if (currentSegmentUnits + units > concatMax) {
      segmentCount += 1;
      currentSegmentUnits = units;
    } else {
      currentSegmentUnits += units;
    }
  }

  const remainingInCurrentSegment = concatMax - currentSegmentUnits;

  return {
    encoding: 'UCS-2',
    characterCount,
    totalUnits: totalUcs2Units,
    segmentCount,
    maxUnitsPerSegment: concatMax,
    remainingInCurrentSegment,
    hasExtendedGsmChars: hasExtended,
    nonGsmCharacters: nonGsm,
  };
}

/**
 * Validates DLT metadata against regulatory formatting constraints.
 */
export function validateDltMetadata(dlt: unknown): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  if (!dlt || typeof dlt !== 'object' || Array.isArray(dlt)) {
    return { valid: false, errors: ['DLT metadata must be a non-null object'] };
  }

  const candidate = dlt as Record<string, unknown>;
  const allowedKeys = new Set(['entityId', 'templateId', 'headerId']);
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.has(key)) {
      errors.push(`DLT metadata contains unknown field '${key}'`);
    }
  }

  if (
    typeof candidate.entityId !== 'string' ||
    !SMS_CONSTRAINTS.DLT_ENTITY_ID_PATTERN.test(candidate.entityId)
  ) {
    errors.push('DLT entityId must be a numeric string between 10 and 25 digits');
  }

  if (
    typeof candidate.templateId !== 'string' ||
    !SMS_CONSTRAINTS.DLT_TEMPLATE_ID_PATTERN.test(candidate.templateId)
  ) {
    errors.push('DLT templateId must be a numeric string between 10 and 25 digits');
  }

  if (candidate.headerId !== undefined) {
    if (
      typeof candidate.headerId !== 'string' ||
      !SMS_CONSTRAINTS.DLT_HEADER_PATTERN.test(candidate.headerId)
    ) {
      errors.push('DLT headerId must be an alphanumeric string between 3 and 11 characters');
    }
  }

  return { valid: errors.length === 0, errors };
}
