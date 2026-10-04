import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Gate D.3 final remediation — the structural half of the invariant
 * (`PROVIDER_ADAPTER.md` §6h): **Provider Router eligibility is advisory;
 * circuit admission is authoritative and mandatory immediately before
 * provider submission.**
 *
 * The executor refuses any call without a genuine admission at runtime
 * (`provider-adapters.spec.ts`, `provider-router-contract.sec-spec.ts`); this
 * suite keeps the code honest about *who* may hold either end:
 *   - only `ProviderStateStore` issues an admission;
 *   - only the declared submission paths call `ProviderSubmissionExecutor.execute`,
 *     and each passes the admission its circuit admission returned.
 * A future Provider Router is added to `SUBMISSION_PATHS` deliberately, in a
 * reviewed change, and must pass `….admission` exactly as test-send does.
 */
const SRC = join(__dirname, '..');

/** The only files that may call `executor.execute(…)` — each a reviewed submission path. */
const SUBMISSION_PATHS = ['providers/provider-registry.service.ts'];
/** The only file that may issue an admission. */
const ISSUER = 'providers/provider-state.store.ts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Source text without comments, so a mention in prose is not mistaken for a call. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = sources(SRC).map((path) => ({ rel: relative(SRC, path), text: code(path) }));

describe('circuit admission — structural invariant (Gate D.3, PROVIDER_ADAPTER.md §6h)', () => {
  it('scans the whole application source', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => f.rel)).toEqual(
      expect.arrayContaining([
        ISSUER,
        ...SUBMISSION_PATHS,
        'provider-adapters/submission-executor.ts',
      ]),
    );
  });

  it('only ProviderStateStore issues an admission', () => {
    const issuers = files
      .filter((f) => /\.issue\s*\(/.test(f.text) && /CircuitAdmissions|admissions/.test(f.text))
      .map((f) => f.rel)
      .filter((rel) => rel !== 'provider-adapters/circuit-admission.ts');
    expect(issuers).toEqual([ISSUER]);
  });

  it('only the declared submission paths call ProviderSubmissionExecutor.execute', () => {
    const callers = files
      .filter((f) => /\bexecutor\s*\.\s*execute\s*\(/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(callers).toEqual([...SUBMISSION_PATHS].sort());
  });

  it('every submission path passes the admission its circuit admission returned, as the first argument', () => {
    for (const rel of SUBMISSION_PATHS) {
      const text = files.find((f) => f.rel === rel)!.text;
      const calls = [...text.matchAll(/\bexecutor\s*\.\s*execute\s*\(\s*([^,]+),/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(`${rel}: ${call[1]!.trim()}`).toMatch(/\.admission$/);
      // …and it obtained that admission from the circuit's admission step.
      expect(text).toMatch(/this\.state\.admit\s*\(/);
    }
  });

  it('the executor redeems the admission before it calls the adapter', () => {
    const text = files.find((f) => f.rel === 'provider-adapters/submission-executor.ts')!.text;
    const execute = text.slice(text.indexOf('async execute('));
    const consume = execute.indexOf('this.admissions.consume(');
    const run = execute.indexOf('this.run(');
    expect(consume).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(consume);
    // `run` is the only place `send` is called, and it is private.
    expect(text.match(/\.send\s*\(/g)).toHaveLength(1);
    expect(text).toMatch(/private async run\(/);
  });

  it('routing eligibility returns a verdict, never an admission', () => {
    const text = files.find((f) => f.rel === 'providers/provider-state-machine.ts')!.text;
    const eligibility = text.slice(text.indexOf('export function routingEligibility('));
    expect(eligibility).not.toMatch(/issue\s*\(|CircuitAdmission/);
  });
});
