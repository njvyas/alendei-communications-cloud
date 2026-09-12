/**
 * The only sanctioned way to build a Redis key (`TENANCY.md` §3).
 *
 * Every tenant-scoped key is namespaced `t:{org_id}:...`, so an ad-hoc
 * unnamespaced key — the bug class this exists to prevent — cannot be
 * constructed by accident.
 */
export class RedisKeyBuilder {
  constructor(private readonly prefix: string) {}

  /** A key scoped to one organization. */
  tenant(orgId: string, ...segments: readonly string[]): string {
    if (!orgId) {
      throw new Error('RedisKeyBuilder.tenant requires an organization id');
    }
    return [this.prefix, 't', orgId, ...segments.map(sanitize)].join(':');
  }

  /**
   * A key that is genuinely platform-wide (e.g. provider health). Deliberately
   * named so that reaching for it over `tenant()` is a visible choice.
   */
  platform(...segments: readonly string[]): string {
    return [this.prefix, 'platform', ...segments.map(sanitize)].join(':');
  }
}

function sanitize(segment: string): string {
  if (segment.includes(':')) {
    throw new Error(`Redis key segment must not contain ":" (got "${segment}")`);
  }
  return segment;
}
