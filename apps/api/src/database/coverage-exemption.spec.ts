import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The pre-commit coverage exemption has exactly one user (Gate C M02/M03).
 *
 * `TenantDatabase.withTenant` refuses to commit a write on a route whose
 * declared permission was never checked. `DENIAL_RECORD` switches that off for
 * one transaction — the `authorization.denied` record `AuthorizationService`
 * commits before raising a refusal — and anything else passing it would be a
 * mutation that escapes containment. Nothing about a second caller would look
 * wrong in review, so the rule is asserted mechanically, as the authorization
 * boundary is (`auth/authorization-boundary.spec.ts`).
 */

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

const files = sourceFiles(SRC);
const relativeTo = (f: string) => relative(SRC, f).replace(/\\/g, '/');

/** A file's code with comments removed, so prose naming the rule does not count. */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

describe('coverage exemption', () => {
  it('finds the source tree it is asserting over', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.map(relativeTo)).toContain('database/tenant-database.service.ts');
  });

  it('is named only where it is defined and in AuthorizationService', () => {
    const users = files
      .filter((f) =>
        /\bDENIAL_RECORD\b|\bcoverageExempt\b|authorization-denied-record/.test(codeOf(f)),
      )
      .map(relativeTo)
      .sort();
    expect(users).toEqual(['auth/authorization.service.ts', 'database/tenant-database.service.ts']);
  });

  it('is passed exactly once, by the denial record and nowhere else in that service', () => {
    const code = codeOf(join(SRC, 'auth/authorization.service.ts'));
    expect(count(code, /coverageExempt\s*:\s*DENIAL_RECORD/g)).toBe(1);
    expect(count(code, /\bcoverageExempt\b/g)).toBe(1);

    // The one use sits inside `recordDenial`, in the transaction that writes
    // `AUDIT_ACTIONS.AUTHORIZATION_DENIED` — not in `assert` or anywhere a
    // business mutation could run.
    const start = code.indexOf('private async recordDenial(');
    const end = code.indexOf('private actorScope(');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = code.slice(start, end);
    expect(body).toMatch(/coverageExempt\s*:\s*DENIAL_RECORD/);
    expect(body).toMatch(/AUDIT_ACTIONS\.AUTHORIZATION_DENIED/);
  });

  it('cannot reach an ordinary request transaction', () => {
    // `withRequestTenant` — what every controller and administration service
    // opens — takes no options, so it can never carry the exemption.
    const code = codeOf(join(SRC, 'database/tenant-database.service.ts'));
    expect(code).toMatch(/async withRequestTenant<T>\(work: \(tx: Transaction\) => Promise<T>\)/);
    expect(code).toMatch(/return this\.withTenant\(\s*\{[\s\S]*?\},\s*work,\s*\);/);
    // The exemption is a compile-time literal, never configuration.
    expect(code).toMatch(/export const DENIAL_RECORD = 'authorization-denied-record';/);
    expect(code).not.toMatch(/process\.env|ConfigService|Reflector/);
  });
});
