/**
 * Audit payload redaction (`SECURITY.md` §2, §4).
 *
 * `before`, `after` and `metadata` are free-form JSON assembled by callers from
 * domain objects, and `audit_logs` is append-only — a credential written into a
 * row cannot later be edited out. The database cannot inspect JSONB for secret
 * material, so this is the only thing standing between a domain object and a
 * permanent record of its contents.
 *
 * It is deliberately one function used by one caller (`AuditWriter`). A second
 * redactor, or a caller that redacts its own payload before handing it over,
 * would reintroduce exactly the drift this centralization exists to prevent.
 */

/** The placeholder written in place of a redacted value. */
export const REDACTED = '[redacted]';

/**
 * Credential field names, removed wherever they appear. Matching is
 * case-insensitive, ignores `_`/`-`/`.` separators, and is **substring-based**
 * rather than exact: `password_hash`, `passwordHash`, `newPassword`,
 * `userPassword` and `passwordConfirmation` all normalize to something
 * containing `password`, and an exact-match list would have caught only the
 * first two.
 *
 * That deliberately over-redacts a few innocuous names (`passwordless` is a
 * boolean flag, not a secret). The asymmetry is the point: a false positive
 * costs one field of audit detail, while a false negative writes a credential
 * into an append-only row that can never be edited afterwards.
 */
const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'passwordhash',
  'keyhash',
  'refreshtokenhash',
  'mfasecretref',
  'tickethash',
];

/**
 * Any key containing `secret` or `token` anywhere in its name. This is the
 * catch-all for fields nobody enumerated: `clientSecret`, `access_token`,
 * `signingSecretRef`, `tokenFamily`.
 */
const SENSITIVE_KEY_PATTERN = /secret|token/i;

/** `Refresh-Token_Hash` and `refreshtokenhash` normalize to the same string. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-.\s]/g, '');
}

const NORMALIZED_FRAGMENTS: readonly string[] = SENSITIVE_KEY_FRAGMENTS.map(normalizeKey);

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    NORMALIZED_FRAGMENTS.some((fragment) => normalized.includes(fragment)) ||
    SENSITIVE_KEY_PATTERN.test(key)
  );
}

/**
 * Returns a redacted deep copy. The caller's object is never mutated — an audit
 * write must not alter the domain object it is describing, or a failed audit
 * would leave the caller holding a half-scrubbed entity.
 *
 * Cycles are replaced with `'[circular]'` rather than throwing: a
 * self-referential payload is a caller bug, but it must not be able to take
 * down the audit write that would have recorded what happened.
 */
export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    // Arrays carry no key of their own, so entries are descended into rather
    // than tested: `{ credentials: [{ password: 'x' }] }` must still be caught.
    return value.map((entry) => redactValue(entry, seen));
  }

  // Dates, Maps, Sets and class instances are not JSON payload shapes. Passing
  // them through untouched would mean descending into something whose contents
  // we cannot reason about, so they are stringified defensively instead.
  if (!isPlainObject(value)) {
    return String(value);
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(entry, seen);
  }
  return result;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
