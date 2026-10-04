import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Phase 2.4 — hot reload is never authorization (`PROVIDER_ADAPTER.md` §3a).
 * The advisory configuration snapshot must be unreachable from every path that
 * authorizes, administers, enforces lifecycle, admits or submits; the only code
 * that reads it is the advisory catalogue read, and only after authorization.
 */
const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const files = sources(SRC).map((path) => ({ rel: relative(SRC, path), text: code(path) }));
const text = (rel: string) => files.find((f) => f.rel === rel)!.text;

describe('advisory configuration cache — structural isolation (Phase 2.4, §3a)', () => {
  it('only the declared files touch the cache', () => {
    const users = files
      .filter((f) => /provider-configuration\.cache|configuration-snapshot-cache/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(users).toEqual(
      [
        'providers/provider-catalogue.service.ts',
        'providers/provider-circuit-policy.service.ts',
        'providers/provider-configuration.cache.ts',
        'providers/provider-configuration.listener.ts',
        'providers/provider-registry.service.ts',
        'providers/providers.module.ts',
      ].sort(),
    );
  });

  it('nothing that authorizes, admits or submits can reach it', () => {
    for (const rel of [
      'providers/provider-state.store.ts',
      'providers/provider-access.service.ts',
      'providers/provider-health.service.ts',
      'providers/provider-state-machine.ts',
      'provider-adapters/submission-executor.ts',
      'provider-adapters/circuit-admission.ts',
    ]) {
      expect(`${rel}: ${/ProviderConfigurationCache|configuration\.read/.test(text(rel))}`).toBe(
        `${rel}: false`,
      );
    }
    for (const f of files.filter((f) => f.rel.startsWith('auth/') || f.rel.startsWith('rbac/'))) {
      expect(`${f.rel}: ${/ProviderConfigurationCache/.test(f.text)}`).toBe(`${f.rel}: false`);
    }
  });

  it('administration only invalidates it; only the advisory catalogue reads it, after authorization', () => {
    for (const rel of [
      'providers/provider-registry.service.ts',
      'providers/provider-circuit-policy.service.ts',
    ]) {
      expect(text(rel)).not.toMatch(/configuration\s*\.\s*(read|peek)\s*\(/);
      expect(text(rel)).toMatch(/configuration\s*\.\s*invalidateLocal\s*\(/);
    }
    const readers = files
      .filter((f) => /configuration\s*\.\s*read\s*\(/.test(f.text))
      .map((f) => f.rel);
    expect(readers).toEqual(['providers/provider-catalogue.service.ts']);
    const catalogue = text('providers/provider-catalogue.service.ts');
    const authorize = catalogue.indexOf('this.access.authorize(');
    const read = catalogue.indexOf('this.configuration.read(');
    expect(authorize).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(authorize);
  });

  it('a notification payload is only ever a hint', () => {
    const listener = text('providers/provider-configuration.listener.ts');
    expect(listener.match(/message\.payload/g)).toHaveLength(1);
    expect(listener).toMatch(/this\.cache\.hint\(message\.payload/);
  });
});
