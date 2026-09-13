import { createHash } from 'node:crypto';

import { hashRefreshToken, issueRefreshToken, refreshTokenHashEquals } from './refresh-token';

describe('refresh tokens', () => {
  it('issues an opaque token and only ever persists its hash', () => {
    const { token, hash } = issueRefreshToken();
    expect(hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe(token);
    // The hash must not contain the token: a database read yields nothing usable.
    expect(hash).not.toContain(token);
  });

  it('carries at least 256 bits of entropy and never repeats', () => {
    const { token } = issueRefreshToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const issued = new Set(Array.from({ length: 500 }, () => issueRefreshToken().token));
    expect(issued.size).toBe(500);
  });

  it('has no structure to forge — it is a lookup key, not a claim carrier', () => {
    const { token } = issueRefreshToken();
    expect(token).not.toContain('.');
    expect(() => JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))).toThrow();
  });

  it('compares hashes without short-circuiting', () => {
    const { hash } = issueRefreshToken();
    expect(refreshTokenHashEquals(hash, hash)).toBe(true);
    expect(refreshTokenHashEquals(hash, hashRefreshToken('different'))).toBe(false);
    expect(refreshTokenHashEquals(hash, hash.slice(0, -1))).toBe(false);
    expect(refreshTokenHashEquals('', '')).toBe(true);
  });

  it('hashes deterministically so a presented token can be looked up', () => {
    expect(hashRefreshToken('abc')).toBe(hashRefreshToken('abc'));
    expect(hashRefreshToken('abc')).not.toBe(hashRefreshToken('abd'));
  });
});
