import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Refresh-token material (`RBAC.md` §5a).
 *
 * The token itself is opaque random bytes with no structure to forge and no
 * claims to tamper with — it is a lookup key, not a bearer of meaning. Only its
 * SHA-256 is persisted, so a database read (or a leaked backup) yields nothing
 * that can be presented.
 *
 * SHA-256 rather than Argon2id here is deliberate and is not a weakening: the
 * input is 256 bits of CSPRNG output rather than a human-chosen password, so it
 * has no guessable distribution to slow an attacker down over. It also has to be
 * looked up by hash on every refresh, which a deliberately-slow KDF would make
 * pathological.
 */

/** Bytes of entropy in a refresh token. */
const TOKEN_BYTES = 32;

export interface RefreshTokenMaterial {
  /** Returned to the caller exactly once, then unrecoverable. */
  readonly token: string;
  /** The only form ever persisted. */
  readonly hash: string;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issueRefreshToken(): RefreshTokenMaterial {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/**
 * Constant-time comparison of two token hashes.
 *
 * Lookup is by unique index, so this is a belt-and-braces check for call sites
 * that have already fetched a row and want to confirm the presented token
 * really produced it, without a short-circuiting `===`.
 */
export function refreshTokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
