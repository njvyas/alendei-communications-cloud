import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Structural guarantees of the `platform:support` CLI (ADR-015 Item 5 Amendment
 * A-1), asserted over the source with comments stripped:
 *
 *   S-01 no HTTP surface — nothing outside `src/cli/` imports it; no controller,
 *        module or the application entry point references it; no route path
 *        mentions platform-role provisioning;
 *   S-02 it never touches bootstrap credentials or the secrets port;
 *   S-03 no DDL, no arbitrary-SQL escape hatch, no write to `audit_logs`;
 *   S-04 no generic grant surface — one `INSERT INTO user_roles`, whose role is
 *        the `alendei_support` constant.
 */
const API_SRC = join(__dirname, '..');
const CLI_FILES = ['cli/platform-support.ts', 'cli/platform-support-provisioning.ts'];

const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !/\.(spec|int-spec|sec-spec)\.ts$/.test(path) ? [path] : [];
  });
}

const all = sources(API_SRC).map((path) => ({
  rel: relative(API_SRC, path).split('\\').join('/'),
  text: strip(readFileSync(path, 'utf8')),
}));
const cli = CLI_FILES.map((rel) => ({
  rel,
  text: strip(readFileSync(join(API_SRC, rel), 'utf8')),
}));

describe('platform:support architecture (ADR-015 A-1)', () => {
  it('S-01: no module outside src/cli imports it, and no controller, module or entry point refers to it', () => {
    const importers = all
      .filter((f) => !f.rel.startsWith('cli/'))
      .filter((f) =>
        /platform-support-provisioning|cli\/platform-support|['"]\.\/platform-support['"]/.test(
          f.text,
        ),
      )
      .map((f) => f.rel);
    expect(importers).toEqual([]);

    const httpFiles = all.filter(
      (f) =>
        /\.(controller|module)\.ts$/.test(f.rel) ||
        f.rel === 'main.ts' ||
        f.rel === 'app.factory.ts',
    );
    expect(httpFiles.length).toBeGreaterThan(10);
    for (const f of httpFiles) {
      expect([
        f.rel,
        /platformSupportStatus|createPlatformSupportUser|revokePlatformSupportUser/.test(f.text),
      ]).toEqual([f.rel, false]);
    }
    // Inside src/cli only the entry point imports the provisioning logic.
    const cliImporters = all
      .filter((f) => f.rel.startsWith('cli/') && f.rel !== 'cli/platform-support-provisioning.ts')
      .filter((f) => /platform-support-provisioning/.test(f.text))
      .map((f) => f.rel);
    expect(cliImporters).toEqual(['cli/platform-support.ts']);
  });

  it('S-02: it never references bootstrap credentials or the secrets port', () => {
    for (const f of cli) {
      expect([
        f.rel,
        /AUTH_BOOTSTRAP|BOOTSTRAP_PASSWORD|PASSWORD_REF|SecretsPort|EnvSecretsAdapter|secrets\.resolve/.test(
          f.text,
        ),
      ]).toEqual([f.rel, false]);
    }
  });

  it('S-03: no DDL, no raw-SQL escape hatch and no UPDATE/DELETE/TRUNCATE of audit_logs', () => {
    for (const f of cli) {
      expect([
        f.rel,
        /\b(ALTER|CREATE|DROP|TRUNCATE|GRANT|COMMENT ON|DISABLE TRIGGER)\b/.test(f.text),
      ]).toEqual([f.rel, false]);
      expect([f.rel, /sql\.raw|\.query\(|eval\(|new Function\(/.test(f.text)]).toEqual([
        f.rel,
        false,
      ]);
      expect([f.rel, /(UPDATE|DELETE FROM)\s+audit_logs/i.test(f.text)]).toEqual([f.rel, false]);
    }
  });

  it('S-04: exactly one grant insert, of the alendei_support constant, with no role parameter anywhere', () => {
    const logic = cli.find((f) => f.rel === 'cli/platform-support-provisioning.ts')!.text;
    expect(logic.match(/INSERT INTO user_roles/g)).toHaveLength(1);
    expect(logic).toMatch(/const SUPPORT_ROLE_KEY = PLATFORM_ROLE_KEYS\.ALENDEI_SUPPORT;/);
    expect(logic).toMatch(/WHERE key = \$\{SUPPORT_ROLE_KEY\} AND org_id IS NULL/);
    // The only DELETE is of the one grant row already proven to be the support grant.
    expect(logic.match(/DELETE FROM \w+/g)).toEqual(['DELETE FROM user_roles']);
    // No request or command-line field could carry a role, scope or permission.
    for (const f of cli) {
      expect([
        f.rel,
        /\b(roleKey|roleId|scopeType|scopeId|permission)\s*[:?]\s*(string|readonly)/.test(
          f.text
            .replace(/interface GrantRow[\s\S]*?\n\}/, '')
            .replace(/interface StatusResult[\s\S]*?\n\}/, ''),
        ),
      ]).toEqual([f.rel, false]);
    }
  });
});
