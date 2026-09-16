import { ERROR_CODES } from '@acc/contracts';

import { AppException } from '../common/errors/app.exception';
import { IdempotencyService } from './idempotency.service';

/**
 * `Idempotency-Key` validation (`API.md` §4).
 *
 * The key is opaque — the server assigns it no meaning and never parses it. All
 * that is checked is that it *could* be a key: a bounded length and a safe
 * alphabet. A malformed value is refused before any lookup, because nothing
 * should be read from a value that could not be a key in the first place.
 */
describe('Idempotency-Key validation', () => {
  const valid = (key: string) => IdempotencyService.validateKey(key);
  const rejected = (key: string) => {
    try {
      IdempotencyService.validateKey(key);
      return null;
    } catch (error) {
      return error as AppException;
    }
  };

  it('accepts a UUID, the recommended form', () => {
    expect(valid('01a0a7e4-5027-7b00-aee9-809a862e3af5')).toBe(
      '01a0a7e4-5027-7b00-aee9-809a862e3af5',
    );
  });

  it('accepts the documented alphabet', () => {
    expect(valid('abcDEF012_-.:xyzQ')).toBe('abcDEF012_-.:xyzQ');
  });

  it('trims surrounding whitespace rather than refusing it', () => {
    // A header value picked up with a stray space is a client mistake that
    // costs nothing to absorb, and refusing it would be a confusing failure.
    expect(valid('  01a0a7e4-5027-7b00-aee9-809a862e3af5  ')).toBe(
      '01a0a7e4-5027-7b00-aee9-809a862e3af5',
    );
  });

  it('refuses a key that is too short to be unguessable', () => {
    // Within one organization the key namespace is shared, so `1` would collide
    // with another principal's key and be refused as a mismatch — turning a
    // careless client into a confusing support ticket.
    expect(rejected('1')?.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
    expect(rejected('short')?.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
  });

  it('refuses a key beyond the documented maximum', () => {
    expect(rejected('a'.repeat(256))?.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
    expect(valid('a'.repeat(255))).toHaveLength(255);
  });

  it('refuses characters outside the alphabet', () => {
    for (const bad of [
      'key with spaces!',
      'key/with/slashes',
      "key'; DROP TABLE idempotency_keys--",
      'key\nwith\nnewlines',
      'ключ-которого-нет-здесь',
      '<script>alert(1)</script>',
    ]) {
      expect(rejected(bad)?.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
    }
  });

  it('refuses it as a 400, not as a server error', () => {
    expect(rejected('1')?.getStatus()).toBe(400);
  });

  it('does not echo the offending key back', () => {
    // A rejected key is caller input; echoing it invites reflected content in an
    // error surface for no benefit.
    const error = rejected('<script>alert(1)</script>');
    expect(error?.message).not.toContain('script');
  });
});
