import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Phase 2 invariant — **Phase 2 contains no provider credential storage or
 * runtime credential implementation** (ADR-013 PD-2, F-1; `PROVIDER_ADAPTER.md`
 * §4a; D-2 hardening). The only secret resolution in the codebase is the
 * deployment plane behind `SecretsPort` (`apps/api/src/secrets/`); every other
 * use is pinned here by name, so a new credential type, port, resolver or
 * resolution path fails this test until it is reviewed.
 *
 * Comments are stripped before matching: documentation about credential
 * concepts is allowed; code is not.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const SECRETS = 'apps/api/src/secrets/';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path);
    return path.endsWith('.ts') && !/\.(spec|int-spec|sec-spec)\.ts$/.test(path) ? [path] : [];
  });
}
const strip = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^import\s[\s\S]*?;$/gm, '');
const files = ['apps/api/src', 'packages/contracts/src', 'packages/db/src']
  .flatMap((dir) => sources(join(ROOT, dir)))
  .map((path) => ({ rel: relative(ROOT, path), text: strip(readFileSync(path, 'utf8')) }));
const outsideSecrets = files.filter((f) => !f.rel.startsWith(SECRETS));
const matches = (pattern: RegExp, render: (f: { rel: string }, m: RegExpMatchArray) => string) =>
  [
    ...new Set(
      outsideSecrets.flatMap((f) => [...f.text.matchAll(pattern)].map((m) => render(f, m))),
    ),
  ].sort();

/** Provider code: the registry, the adapters, their contracts and the catalogue schema. */
const isProviderCode = (rel: string) =>
  /^apps\/api\/src\/(providers|provider-adapters)\//.test(rel) ||
  /^packages\/contracts\/src\/(provider[\w-]*|providers)\.ts$/.test(rel) ||
  rel === 'packages/db/src/schema/providers.ts';

describe('Phase 2 has no provider credential storage or runtime credential implementation (D-2)', () => {
  it('scans the backend: provider code, the secrets module and both packages are in view', () => {
    const rels = files.map((f) => f.rel);
    expect(rels).toContain('apps/api/src/secrets/secrets.port.ts');
    expect(rels).toContain('apps/api/src/providers/provider-registry.service.ts');
    expect(rels).toContain('apps/api/src/provider-adapters/simulator.adapter.ts');
    expect(rels).toContain('packages/contracts/src/provider-adapter.ts');
    expect(rels).toContain('packages/db/src/schema/providers.ts');
    expect(files.filter((f) => isProviderCode(f.rel)).length).toBeGreaterThan(20);
  });

  it('only the pinned deployment-plane files reach the secrets module, and no provider code does', () => {
    const users = outsideSecrets
      .filter((f) =>
        /\b(SECRETS_PORT|SecretsPort|SecretsModule|EnvSecretsAdapter|parseSecretReference|SecretResolutionError)\b/.test(
          f.text,
        ),
      )
      .map((f) => f.rel)
      .sort();
    expect(users).toEqual([
      'apps/api/src/app.module.ts', // registers SecretsModule
      'apps/api/src/auth/jwt.service.ts', // the JWT signing secret
      'apps/api/src/cli/bootstrap.ts', // the bootstrap administrator password
      'apps/api/src/cli/dev-fixture/environment.ts', // the dev/test fixture passwords
      'apps/api/src/common/http/http.module.ts', // the cursor-signing key
    ]);
    expect(users.filter(isProviderCode)).toEqual([]);
  });

  it('every secret resolution outside the secrets module is a pinned deployment-plane reference — no new resolution path', () => {
    expect(
      matches(
        /\b(\w*secrets?\w*)\s*\.\s*resolve\s*\(\s*([^)]*?)\s*\)/gi,
        (f, m) => `${f.rel}: ${m[1]}.resolve(${m[2]})`,
      ),
    ).toEqual([
      'apps/api/src/auth/jwt.service.ts: secrets.resolve(this.config.secrets.jwtSecretRef)',
      'apps/api/src/cli/bootstrap.ts: secrets.resolve(passwordRef)',
      'apps/api/src/cli/dev-fixture/environment.ts: secrets.resolve(operatorRef)',
      'apps/api/src/cli/dev-fixture/environment.ts: secrets.resolve(userRef)',
      'apps/api/src/common/http/http.module.ts: secrets.resolve(config.secrets.jwtSecretRef)',
    ]);
  });

  it('no credential type, interface, class, enum or exported symbol is declared outside the secrets module beyond the pinned user-authentication ones', () => {
    expect(
      matches(
        /\b(?:(?:interface|type|class|enum)\s+|export\s+(?:const|function|let)\s+)(\w*(?:credential|secret)\w*)/gi,
        (f, m) => `${f.rel}: ${m[1]}`,
      ),
    ).toEqual([
      'apps/api/src/iam/credential.service.ts: CredentialService', // password hashing (identity)
      'apps/api/src/openapi/accepted-credentials.decorator.ts: ACCEPTED_CREDENTIALS', // request credentials
      'apps/api/src/openapi/accepted-credentials.decorator.ts: AcceptedCredentials',
      'apps/api/src/openapi/accepted-credentials.decorator.ts: CREDENTIALS',
      'apps/api/src/openapi/accepted-credentials.decorator.ts: Credential',
      'packages/db/src/cli/migrate.ts: RoleCredential', // database role passwords (deployment plane)
    ]);
  });

  it('provider code names no credential or secret beyond the pinned refusals, request-credential plumbing and the simulated rejection', () => {
    const found = [
      ...new Set(
        files
          .filter((f) => isProviderCode(f.rel))
          .flatMap((f) =>
            [...f.text.matchAll(/[\w-]*(?:credential|secret|passw|api_?key)[\w-]*/gi)].map(
              (m) => `${f.rel}: ${m[0]}`,
            ),
          ),
      ),
    ].sort();
    expect(found).toEqual(
      [
        // The simulated INVALID_CREDENTIALS behaviour and its message (no credential is held).
        'apps/api/src/provider-adapters/simulator.adapter.ts: INVALID_CREDENTIALS',
        'apps/api/src/provider-adapters/simulator.adapter.ts: credential',
        'packages/contracts/src/provider-adapter.ts: INVALID_CREDENTIALS',
        // Request authentication on the routes (the caller's session, not a provider credential).
        'apps/api/src/providers/channels.controller.ts: AUTH_CREDENTIAL_REQUIRED',
        'apps/api/src/providers/channels.controller.ts: AcceptedCredentials',
        'apps/api/src/providers/provider-circuit-policy.controller.ts: AcceptedCredentials',
        'apps/api/src/providers/providers.controller.ts: AcceptedCredentials',
        // The refusal of secret-named capability keys and its message.
        'apps/api/src/providers/provider-registry.service.ts: SECRET_KEY_FORBIDDEN',
        'apps/api/src/providers/provider-registry.service.ts: credential',
        'apps/api/src/providers/provider-registry.service.ts: non-secret',
        'packages/contracts/src/providers.ts: api_key',
        'packages/contracts/src/providers.ts: apikey',
        'packages/contracts/src/providers.ts: credential',
        'packages/contracts/src/providers.ts: passwd',
        'packages/contracts/src/providers.ts: password',
        'packages/contracts/src/providers.ts: secret',
      ].sort(),
    );
  });

  it('no code and no migration names provider_credentials, and the Phase 2 migrations declare nothing credential-shaped', () => {
    expect(
      files
        .filter((f) => /provider_?credentials?|providerCredentials?/i.test(f.text))
        .map((f) => f.rel),
    ).toEqual([]);
    const dir = join(ROOT, 'packages/db/migrations');
    const migrations = readdirSync(dir)
      .filter((n) => /^\d{4}_.*\.sql$/.test(n))
      .map((n) => ({
        n,
        sql: readFileSync(join(dir, n), 'utf8')
          .replace(/--.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, ''),
      }));
    expect(migrations.filter((m) => m.n.startsWith('0024_')).length).toBe(1);
    expect(migrations.filter((m) => /provider_credentials/i.test(m.sql)).map((m) => m.n)).toEqual(
      [],
    );
    const phase2 = migrations.filter((m) => Number(m.n.slice(0, 4)) >= 18);
    // 0018–0024 at the end of Phase 2; a later migration is checked the same way.
    expect(phase2.length).toBeGreaterThanOrEqual(7);
    // ADR-015 R-2 (migration 0025) narrows privileges on identity credential
    // columns that already exist; it creates no table or column. Its references
    // are exactly these existing identifiers — anything else still fails here.
    const IDENTITY_BACKSTOP_0025 = new Set([
      'actor_api_key_id',
      'api_keys',
      'mfa_secret_ref',
      'password_hash',
      'password_updated_at',
      'trg_api_keys_org_id_immutable',
      'trg_api_keys_revocation_terminal',
    ]);
    const adr015 = migrations.find((m) => m.n.startsWith('0025_'));
    expect(adr015).toBeDefined();
    expect(adr015!.sql).not.toMatch(/CREATE\s+TABLE|ADD\s+COLUMN/i);
    expect(
      phase2.flatMap((m) =>
        [...m.sql.matchAll(/\w*(?:credential|secret|passw|api_?key|token)\w*/gi)]
          .filter((x) => !(m === adr015 && IDENTITY_BACKSTOP_0025.has(x[0])))
          .map((x) => `${m.n}: ${x[0]}`),
      ),
    ).toEqual([]);
  });
});
