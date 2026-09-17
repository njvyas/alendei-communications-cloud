import { randomBytes } from 'node:crypto';

/**
 * API-key credential material (`SECURITY.md` §1, `RBAC.md` §5c).
 *
 * The presented credential is `<prefix>.<secret>`, the format `AuthGuard` has
 * parsed since Phase 1B.3 and which migration `0000`'s `api_keys_prefix_shape`
 * CHECK constrains. Neither half is invented here; this module only mints values
 * that fit the format already in force.
 *
 * The split is what makes verification a single indexed probe rather than a scan
 * over every row's Argon2id digest: the **prefix is public** and is the lookup
 * key (`api_keys_key_prefix_key`), and the **secret is never stored at all** —
 * only its hash. A database read therefore cannot yield a usable credential.
 */

/** `ak_live_` / `ak_test_` — the two forms `api_keys_prefix_shape` admits. */
export type ApiKeyEnvironment = 'live' | 'test';

/**
 * Alphabet for both halves: unambiguous base62.
 *
 * `api_keys_prefix_shape` requires `[A-Za-z0-9]{16}` for the prefix, so the
 * prefix half has no choice. The secret uses the same alphabet for one practical
 * reason — the credential is copied by hand out of a console exactly once, and a
 * character set that survives a double-click and a paste is worth more here than
 * the few bits base64url would add.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Fixed by `api_keys_prefix_shape`. Not a tunable. */
const PREFIX_RANDOM_LENGTH = 16;

/**
 * Secret length. 43 base62 characters is ~256 bits of entropy.
 *
 * Sized against an *offline* attacker holding the digest rather than against the
 * online path, because the online path is already bounded by Argon2id. At this
 * length the secret is not the weak half of the construction by any margin.
 */
const SECRET_LENGTH = 43;

/**
 * Rejection sampling over a CSPRNG.
 *
 * `randomBytes` rather than `Math.random`, and the modulo bias is removed rather
 * than tolerated: 256 is not a multiple of 62, so `byte % 62` would make the
 * first four characters of the alphabet measurably more likely. The bias is
 * small and would never be noticed in testing, which is exactly why it is
 * handled here instead of being left as a comment about it being negligible.
 */
function randomString(length: number): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * A freshly minted credential.
 *
 * `secret` is the plaintext half and exists **only** in memory, only on the
 * fresh creation path, and only until the HTTP response is written (ADR-008).
 * Nothing persists it, logs it, audits it or replays it.
 */
export interface MintedApiKey {
  /** Public, stored, and the lookup key at authentication. */
  readonly prefix: string;
  /** Plaintext. Never stored, never logged, returned exactly once. */
  readonly secret: string;
  /** What the client presents: `<prefix>.<secret>`. */
  readonly credential: string;
}

export function mintApiKey(environment: ApiKeyEnvironment): MintedApiKey {
  const prefix = `ak_${environment}_${randomString(PREFIX_RANDOM_LENGTH)}`;
  const secret = randomString(SECRET_LENGTH);
  return { prefix, secret, credential: `${prefix}.${secret}` };
}
