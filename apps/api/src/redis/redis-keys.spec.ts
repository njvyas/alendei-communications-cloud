import { RedisKeyBuilder } from './redis-keys';

/**
 * `TENANCY.md` §3: a shared key builder is the only sanctioned way to construct
 * a Redis key, specifically to prevent ad-hoc unnamespaced keys.
 */
describe('RedisKeyBuilder', () => {
  const keys = new RedisKeyBuilder('acc');

  it('namespaces every tenant key with the organization id', () => {
    expect(keys.tenant('org-1', 'ratelimit', 'messages')).toBe('acc:t:org-1:ratelimit:messages');
  });

  it('refuses to build a tenant key without an organization id', () => {
    expect(() => keys.tenant('', 'ratelimit')).toThrow(/requires an organization id/);
  });

  it('keeps genuinely platform-wide keys in their own namespace', () => {
    expect(keys.platform('provider-health')).toBe('acc:platform:provider-health');
  });

  it('refuses a segment that would forge extra key structure', () => {
    // Without this, a value such as an attacker-influenced name could escape its
    // tenant namespace by embedding a separator.
    expect(() => keys.tenant('org-1', 'evil:t:org-2')).toThrow(/must not contain/);
  });

  it('cannot produce a tenant key that collides across organizations', () => {
    expect(keys.tenant('org-1', 'x')).not.toBe(keys.tenant('org-2', 'x'));
  });
});
