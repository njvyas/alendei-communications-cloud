import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The authorization boundary is the only way in (Phase 1B.5.2).
 *
 * `AuthorizationService` exists so that no handler assembles a target scope, a
 * scope chain and an evaluator call for itself. That guarantee is worth nothing
 * if the next controller simply injects `PermissionEvaluator` again — and
 * nothing about doing so would look wrong in review, because it is exactly what
 * every controller did until this increment.
 *
 * So the rule is asserted mechanically rather than left to reviewers. It is a
 * source-level check because the property is structural: it is about which
 * modules may depend on which, not about any runtime value.
 *
 * `TESTING.md` §6n's route-table assertion (every scoped route performs exactly
 * one target-scope check) is the stronger, complementary form and is deferred
 * with the declarative decorator — see `ROADMAP.md` 1B.5.7. This is the part
 * that can be enforced today.
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

/**
 * A file's code with comments removed.
 *
 * These assertions are about what the code *does*, and every file here
 * deliberately explains the boundary in prose — so matching raw text would fail
 * on the documentation that exists to describe the very rule being enforced.
 */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('authorization boundary', () => {
  it('finds the source tree it is asserting over', () => {
    // Guards the guard: a scan that silently matched nothing would make every
    // assertion below vacuously true.
    expect(files.length).toBeGreaterThan(20);
    expect(files.map(relativeTo)).toContain('auth/authorization.service.ts');
  });

  it('is the only production consumer of PermissionEvaluator', () => {
    // `auth.module.ts` wires it, and `authorization.service.ts` calls it.
    // Anything else reaching for the evaluator directly is bypassing the
    // chain resolution that makes a decision trustworthy.
    const permitted = new Set(['auth/authorization.service.ts', 'auth/auth.module.ts']);

    const consumers = files
      .filter((f) => /\bPermissionEvaluator\b/.test(codeOf(f)))
      .map(relativeTo)
      .filter((f) => f !== 'auth/permission-evaluator.service.ts')
      .filter((f) => !permitted.has(f))
      // Documentation comments may name it; only real usage counts.
      .filter((f) => /import\s[^;]*PermissionEvaluator/.test(codeOf(join(SRC, f))));

    expect(consumers).toEqual([]);
  });

  it('keeps target-scope SQL out of controllers', () => {
    // A controller that resolves a target's parents itself is re-introducing
    // the per-handler chain assembly this increment removed.
    const offenders = files
      .filter((f) => f.endsWith('.controller.ts'))
      .filter((f) => /ScopeChainResolver|scopeCovers/.test(codeOf(f)))
      .map(relativeTo);

    expect(offenders).toEqual([]);
  });

  it('keeps hierarchy queries out of the evaluator', () => {
    // `PermissionEvaluator` decides coherent-grant algebra and nothing else;
    // a database read inside it would mean the decision and the ancestry are
    // no longer separable (`RBAC.md` §2).
    const evaluator = codeOf(join(SRC, 'auth/permission-evaluator.service.ts'));
    expect(evaluator).not.toMatch(/@acc\/db|schema\.|tx\./);
  });

  it('keeps grant and permission logic out of the chain resolver', () => {
    // The resolver answers "what is this target's ancestry", never "may this
    // principal act on it".
    const resolver = codeOf(join(SRC, 'auth/scope-chain-resolver.service.ts'));
    expect(resolver).not.toMatch(/scopeCovers|AuthPrincipal|principal\./);
  });

  it('exposes no way to supply a scope chain to the authorization boundary', () => {
    // The strongest form of the forgery guarantee: `AuthorizationCheck` has no
    // ancestry field, so caller-supplied ancestry is unrepresentable rather
    // than rejected. If a `chain` is ever added to this interface, the property
    // is gone and this test says so.
    const service = readFileSync(join(SRC, 'auth/authorization.service.ts'), 'utf8');
    // Read raw here on purpose: the interface body is what is being inspected.
    const check = /export interface AuthorizationCheck \{([\s\S]*?)\n\}/.exec(service);
    expect(check).not.toBeNull();
    expect(check![1]).not.toMatch(/\bchain\b\s*[?:]/);
  });
});
