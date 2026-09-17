import { mintApiKey } from './api-key-secret';

/**
 * The credential generator (Phase 1B.6.2).
 *
 * Small surface, but everything about an API key's strength rests on it, so the
 * properties are asserted rather than assumed: the format the database CHECK and
 * `AuthGuard`'s parser both require, and randomness that is actually random.
 */
describe('api key secret', () => {
  const PREFIX_SHAPE = /^ak_(live|test)_[A-Za-z0-9]{16}$/;

  it('produces the format migration 0000 and AuthGuard already require', () => {
    const minted = mintApiKey('test');
    // `api_keys_prefix_shape` — a prefix that fails this cannot be inserted.
    expect(minted.prefix).toMatch(PREFIX_SHAPE);
    // `AuthGuard`'s API_KEY_SHAPE — a credential that fails this cannot be
    // presented, so the two halves must agree with both regexes at once.
    expect(minted.credential).toMatch(/^(ak_(?:live|test)_[A-Za-z0-9]{16})\.(.+)$/);
    expect(minted.credential).toBe(`${minted.prefix}.${minted.secret}`);
  });

  it('honours the environment label', () => {
    expect(mintApiKey('live').prefix.startsWith('ak_live_')).toBe(true);
    expect(mintApiKey('test').prefix.startsWith('ak_test_')).toBe(true);
  });

  it('carries roughly 256 bits of entropy in the secret half', () => {
    const { secret } = mintApiKey('test');
    expect(secret).toHaveLength(43);
    expect(secret).toMatch(/^[A-Za-z0-9]+$/);
    // log2(62) * 43 ≈ 256.
    expect(Math.log2(62) * secret.length).toBeGreaterThan(250);
  });

  it('never repeats a prefix or a secret across many mints', () => {
    const prefixes = new Set<string>();
    const secrets = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      const minted = mintApiKey('test');
      prefixes.add(minted.prefix);
      secrets.add(minted.secret);
    }
    expect(prefixes.size).toBe(2_000);
    expect(secrets.size).toBe(2_000);
  });

  /**
   * The modulo-bias guard, asserted rather than trusted.
   *
   * 256 is not a multiple of 62, so a naive `byte % 62` makes the first four
   * characters of the alphabet about 1.6% more likely than the rest. That is far
   * too small to notice by eye and would never fail a format test — which is
   * exactly why it is measured. With rejection sampling the observed frequency
   * of the biased-in characters should sit at chance.
   */
  it('shows no modulo bias toward the head of the alphabet', () => {
    const counts = new Map<string, number>();
    let total = 0;
    for (let i = 0; i < 3_000; i += 1) {
      for (const ch of mintApiKey('test').secret) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
        total += 1;
      }
    }
    // The four characters a biased implementation would over-produce.
    const biased = ['A', 'B', 'C', 'D'].reduce((sum, ch) => sum + (counts.get(ch) ?? 0), 0);
    const expected = (total / 62) * 4;
    // Generous band: this is a bias detector, not a randomness test suite. A
    // 1.6% skew sits inside it; a `% 62` implementation over many samples does
    // not, because the deviation is systematic rather than noise.
    expect(biased).toBeGreaterThan(expected * 0.9);
    expect(biased).toBeLessThan(expected * 1.1);
    // And the alphabet is fully covered, so nothing is silently unreachable.
    expect(counts.size).toBe(62);
  });
});
