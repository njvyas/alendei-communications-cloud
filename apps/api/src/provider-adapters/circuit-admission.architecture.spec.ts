import { join, relative, sep } from 'node:path';

import ts from 'typescript';

/**
 * ADR-015 R-13 — the structural half of the invariant (`PROVIDER_ADAPTER.md`
 * §6h): **Provider Router eligibility is advisory; circuit admission is
 * authoritative and mandatory immediately before provider submission.**
 *
 * Replaces the Gate D.3 regex pins (ADR-014 §17.3). The runtime refuses every
 * unsupported call (`circuit-admission.spec.ts`, `provider-adapters.spec.ts`,
 * `provider-router-contract.sec-spec.ts`); this suite keeps the *code* honest
 * with the TypeScript type checker, so aliasing, destructuring and element
 * access are seen exactly as calls are:
 *   - who may import the adapters, the registry, the ledger and the executor;
 *   - who may construct a ledger, an executor, a registry or an adapter;
 *   - who may reference `send` (on any adapter), `submit`, `claimIssuer`,
 *     `claimRedeemer`, `execute`, `probe`, `admit`, `recordSubmission` and
 *     the registry's `resolve`;
 *   - every adapter class extends `GuardedProviderAdapter`;
 *   - routing eligibility never touches an admission.
 * A scanner self-test runs the same rules over known-bad fixture files, so a
 * widened allowlist or a blind scanner fails here too.
 *
 * Limits (documented in §6h): a dynamic property name, `Reflect`, or a cast
 * to `any` resolves to no declaration and is not seen. Those are for review.
 */
const API = join(__dirname, '..', '..');
const SRC = join(API, 'src');
const CONTRACTS_ADAPTER = join(
  API,
  '..',
  '..',
  'packages',
  'contracts',
  'src',
  'provider-adapter.ts',
);

/** The reviewed submission paths. A future router is added here deliberately. */
const SUBMISSION_PATHS = ['providers/provider-registry.service.ts'];
const STORE = 'providers/provider-state.store.ts';
const EXECUTOR = 'provider-adapters/submission-executor.ts';
const LEDGER = 'provider-adapters/circuit-admission.ts';
const MODULE = 'provider-adapters/provider-adapters.module.ts';
const SIMULATOR = 'provider-adapters/simulator.adapter.ts';
const REGISTRY = 'provider-adapters/adapter-registry.ts';

type Allowlist = Readonly<Record<string, readonly string[]>>;

/**
 * Who may reference a member, by `Owner.member` (`ProviderAdapter.send` is
 * `send` on the port, on `GuardedProviderAdapter` or on any adapter class). An
 * entry ending in `/` is a directory. The ledger file holds the guard itself,
 * which compares `send` against the base's own.
 */
const MEMBER_RULES: Allowlist = {
  'ProviderAdapter.send': [EXECUTOR, LEDGER],
  'GuardedProviderAdapter.submit': [LEDGER],
  'CircuitAdmissions.claimIssuer': [STORE],
  'CircuitAdmissions.claimRedeemer': [EXECUTOR],
  'ProviderSubmissionExecutor.execute': SUBMISSION_PATHS,
  'ProviderSubmissionExecutor.probe': ['providers/provider-health.service.ts'],
  'ProviderStateStore.admit': SUBMISSION_PATHS,
  'ProviderStateStore.recordSubmission': SUBMISSION_PATHS,
  'ProviderAdapterRegistry.resolve': [EXECUTOR],
};

/** Who may import a module, and what. `*` is any name. */
const IMPORT_RULES: Readonly<Record<string, Allowlist>> = {
  [SIMULATOR]: { [MODULE]: ['*'], [EXECUTOR]: ['*'] },
  [REGISTRY]: {
    [EXECUTOR]: ['*'],
    [LEDGER]: ['*'],
    'providers/provider-registry.service.ts': ['ProviderAdapterNotRegistered'],
  },
  [LEDGER]: {
    [MODULE]: ['*'],
    [EXECUTOR]: ['*'],
    [SIMULATOR]: ['*'],
    [REGISTRY]: ['*'],
    [STORE]: ['*'],
  },
  [EXECUTOR]: {
    [MODULE]: ['*'],
    'providers/provider-registry.service.ts': ['ProviderSubmissionExecutor'],
    'providers/provider-health.service.ts': ['ProviderSubmissionExecutor'],
  },
  [MODULE]: { 'providers/providers.module.ts': ['ProviderAdaptersModule'] },
};

/** Who may construct what. */
const CONSTRUCTION_RULES: Allowlist = {
  CircuitAdmissions: [MODULE],
  ProviderSubmissionExecutor: [MODULE],
  ProviderAdapterRegistry: [EXECUTOR],
  'GuardedProviderAdapter subclass': [MODULE, SIMULATOR],
};

const allowed = (list: readonly string[] | undefined, rel: string) =>
  (list ?? []).some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));

const relOf = (fileName: string) => relative(SRC, fileName).split(sep).join('/');

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(join(API, 'tsconfig.json'), (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, API);
  // Sources, not the referenced projects' build output: `paths` maps @acc/* to src.
  return {
    ...parsed.options,
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    tsBuildInfoFile: undefined,
    rootDir: undefined,
    outDir: undefined,
  };
}

/** The application's non-spec sources, plus `fixtures` (path relative to src → code) in memory. */
function buildProgram(fixtures: Readonly<Record<string, string>> = {}) {
  const options = compilerOptions();
  const virtual = new Map(Object.entries(fixtures).map(([rel, code]) => [join(SRC, rel), code]));
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (p) => virtual.has(p) || fileExists.call(host, p);
  host.readFile = (p) => virtual.get(p) ?? readFile.call(host, p);
  host.getSourceFile = (p, language, ...rest) =>
    virtual.has(p)
      ? ts.createSourceFile(p, virtual.get(p)!, language, true)
      : getSourceFile.call(host, p, language, ...rest);
  const roots = ts.sys
    .readDirectory(SRC, ['.ts'], undefined, ['**/*.ts'])
    .filter((p) => !p.endsWith('.spec.ts'));
  const program = ts.createProgram({ rootNames: [...roots, ...virtual.keys()], options, host });
  return { program, options, host };
}

type Built = ReturnType<typeof buildProgram>;

interface Rules {
  readonly members: Allowlist;
  readonly imports: Readonly<Record<string, Allowlist>>;
  readonly construction: Allowlist;
}
const RULES: Rules = {
  members: MEMBER_RULES,
  imports: IMPORT_RULES,
  construction: CONSTRUCTION_RULES,
};

/** Every boundary violation in `fileName`, as `rel:line rule`. */
function scan({ program, options, host }: Built, fileName: string, rules: Rules = RULES): string[] {
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(fileName);
  if (!file) throw new Error(`not in the program: ${fileName}`);
  const rel = relOf(fileName);
  const out: string[] = [];
  const at = (node: ts.Node, rule: string) =>
    out.push(`${rel}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${rule}`);

  const resolved = (symbol: ts.Symbol | undefined) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  const declaredIn = (node: ts.Node, target: string) =>
    node.getSourceFile().fileName === target || relOf(node.getSourceFile().fileName) === target;

  /** Whether a class declaration is, or extends, `GuardedProviderAdapter`. */
  function isGuarded(owner: ts.ClassLikeDeclaration): boolean {
    const seen = new Set<ts.Type>();
    const walk = (type: ts.Type): boolean => {
      if (seen.has(type)) return false;
      seen.add(type);
      const symbol = type.getSymbol();
      if (
        symbol?.name === 'GuardedProviderAdapter' &&
        symbol.declarations?.some((d) => declaredIn(d, LEDGER))
      ) {
        return true;
      }
      return (checker.getBaseTypes(type as ts.InterfaceType) ?? []).some(walk);
    };
    return walk(checker.getTypeAtLocation(owner));
  }

  /** Whether a class declaration claims to implement `ProviderAdapter`. */
  function implementsAdapter(owner: ts.ClassLikeDeclaration): boolean {
    return (owner.heritageClauses ?? [])
      .filter((h) => h.token === ts.SyntaxKind.ImplementsKeyword)
      .some((h) =>
        h.types.some((t) =>
          resolved(checker.getSymbolAtLocation(t.expression))?.declarations?.some((d) =>
            declaredIn(d, CONTRACTS_ADAPTER),
          ),
        ),
      );
  }

  /** `Owner.member` for each declaration of a member symbol. */
  function memberKeys(symbol: ts.Symbol | undefined): string[] {
    const keys = new Set<string>();
    for (const decl of symbol?.declarations ?? []) {
      const owner = decl.parent;
      const name = symbol!.name;
      if (ts.isInterfaceDeclaration(owner)) {
        if (
          name === 'send' &&
          owner.name.text === 'ProviderAdapter' &&
          declaredIn(decl, CONTRACTS_ADAPTER)
        )
          keys.add('ProviderAdapter.send');
        else keys.add(`${owner.name.text}.${name}`);
      } else if (ts.isClassLike(owner)) {
        if (name === 'send' && (isGuarded(owner) || implementsAdapter(owner)))
          keys.add('ProviderAdapter.send');
        else if (name === 'submit' && isGuarded(owner)) keys.add('GuardedProviderAdapter.submit');
        else keys.add(`${owner.name?.text ?? '<anonymous>'}.${name}`);
      }
    }
    return [...keys];
  }

  function checkMember(node: ts.Node, symbol: ts.Symbol | undefined) {
    for (const key of memberKeys(symbol)) {
      if (key in rules.members && !allowed(rules.members[key], rel)) at(node, `references ${key}`);
    }
  }

  function checkImport(node: ts.Node, specifier: string, names: readonly string[]): void {
    const target = ts.resolveModuleName(specifier, fileName, options, host).resolvedModule;
    if (!target) return;
    const targetRel = relOf(target.resolvedFileName.replace(/\.d\.ts$/, '.ts'));
    const importers = rules.imports[targetRel];
    if (!importers || targetRel === rel) return;
    const permitted = importers[rel];
    if (!permitted) {
      at(node, `imports ${targetRel}`);
    } else if (!permitted.includes('*')) {
      for (const name of names.length > 0 ? names : ['*']) {
        if (!permitted.includes(name)) at(node, `imports ${name} from ${targetRel}`);
      }
    }
  }

  function constructedKey(symbol: ts.Symbol | undefined): string | undefined {
    const decl = symbol?.declarations?.find(ts.isClassLike);
    if (!decl) return undefined;
    const name = decl.name?.text ?? '';
    if (
      ['CircuitAdmissions', 'ProviderAdapterRegistry', 'ProviderSubmissionExecutor'].includes(name)
    ) {
      return decl.getSourceFile().fileName.startsWith(SRC) ? name : undefined;
    }
    return isGuarded(decl) ? 'GuardedProviderAdapter subclass' : undefined;
  }

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      checkMember(node.name, checker.getSymbolAtLocation(node.name));
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      const type = checker.getTypeAtLocation(node.expression);
      checkMember(node, checker.getPropertyOfType(type, node.argumentExpression.text));
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const nameNode = node.propertyName ?? node.name;
      if (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode)) {
        const type = checker.getTypeAtLocation(node.parent);
        checkMember(node, checker.getPropertyOfType(type, nameNode.text));
      }
    } else if (ts.isNewExpression(node)) {
      const key = constructedKey(resolved(checker.getSymbolAtLocation(node.expression)));
      if (key && !allowed(rules.construction[key], rel)) at(node, `constructs ${key}`);
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      const names =
        bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((e) => (e.propertyName ?? e.name).text)
          : [];
      checkImport(node, node.moduleSpecifier.text, names);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const names =
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
          : [];
      checkImport(node, node.moduleSpecifier.text, names);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      checkImport(node, node.arguments[0].text, []);
    } else if (ts.isClassLike(node) && implementsAdapter(node) && !isGuarded(node)) {
      at(node, 'declares an adapter that does not extend GuardedProviderAdapter');
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'routingEligibility' && node.body) {
      const inner = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) {
          const decl = resolved(checker.getSymbolAtLocation(n))?.declarations?.[0];
          if (decl && declaredIn(decl, LEDGER))
            at(n, 'routing eligibility references the admission ledger');
        }
        ts.forEachChild(n, inner);
      };
      inner(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** Known-bad files: each must be reported, with the rule named. */
const FIXTURES: Readonly<Record<string, { code: string; expect: string[] }>> = {
  'providers/rogue-import-simulator.ts': {
    code: `import { SimulatorAdapter } from '../provider-adapters/simulator.adapter';
export const make = (t: never) => new SimulatorAdapter(t);`,
    expect: [
      'imports provider-adapters/simulator.adapter.ts',
      'constructs GuardedProviderAdapter subclass',
    ],
  },
  'providers/rogue-send.ts': {
    code: `import type { ProviderAdapter } from '@acc/contracts';
export async function go(a: ProviderAdapter) {
  await a.send({} as never, {} as never, {} as never);
  const { send } = a;
  const alias = a['send'];
  return [send, alias];
}`,
    expect: [
      '3 references ProviderAdapter.send',
      '4 references ProviderAdapter.send',
      '5 references ProviderAdapter.send',
    ],
  },
  'messaging/rogue-registry.ts': {
    code: `export async function go() {
  const m = await import('../provider-adapters/adapter-registry');
  const r = require('../provider-adapters/simulator.adapter');
  return [m, r];
}`,
    expect: [
      'imports provider-adapters/adapter-registry.ts',
      'imports provider-adapters/simulator.adapter.ts',
    ],
  },
  'providers/rogue-ledger.ts': {
    code: `import { CircuitAdmissions } from '../provider-adapters/circuit-admission';
export const issuer = (l: CircuitAdmissions) => l.claimIssuer();
export const redeemer = (l: CircuitAdmissions) => l['claimRedeemer']();
export const second = (t: never) => new CircuitAdmissions(t);`,
    expect: [
      'imports provider-adapters/circuit-admission.ts',
      'references CircuitAdmissions.claimIssuer',
      'references CircuitAdmissions.claimRedeemer',
      'constructs CircuitAdmissions',
    ],
  },
  'providers/rogue-router.ts': {
    code: `import { ProviderSubmissionExecutor } from '../provider-adapters/submission-executor';
import { ProviderStateStore } from './provider-state.store';
export async function route(e: ProviderSubmissionExecutor, s: ProviderStateStore) {
  const a = await s.admit({} as never, {} as never, 'p');
  const settled = await e.execute({} as never, {} as never);
  await s.recordSubmission({} as never, {} as never, settled);
  return [a, e.probe({} as never), new ProviderSubmissionExecutor({} as never, {} as never, [])];
}`,
    expect: [
      'imports provider-adapters/submission-executor.ts',
      'references ProviderStateStore.admit',
      'references ProviderSubmissionExecutor.execute',
      'references ProviderStateStore.recordSubmission',
      'references ProviderSubmissionExecutor.probe',
      'constructs ProviderSubmissionExecutor',
    ],
  },
  'providers/rogue-adapter.ts': {
    code: `import type { ProviderAdapter } from '@acc/contracts';
export abstract class RawAdapter implements ProviderAdapter {
  abstract adapterKey: string;
  abstract capabilities(): never;
  abstract healthCheck(): never;
  async send() { return {} as never; }
  abstract estimateCost(): never;
  abstract checkStatus(): never;
  abstract parseWebhook(): never;
  relay() { return this.send(); }
}`,
    expect: [
      'declares an adapter that does not extend GuardedProviderAdapter',
      'references ProviderAdapter.send',
    ],
  },
  'provider-adapters/rogue-submit.ts': {
    code: `import { SimulatorAdapter } from './simulator.adapter';
export class Leak extends SimulatorAdapter {
  leak() { return this.submit({} as never, {} as never, {} as never); }
}`,
    expect: ['references GuardedProviderAdapter.submit'],
  },
  'providers/rogue-reexport.ts': {
    code: `export { ProviderAdapterRegistry } from '../provider-adapters/adapter-registry';`,
    expect: ['imports provider-adapters/adapter-registry.ts'],
  },
};

jest.setTimeout(120_000);

describe('circuit admission — structural invariant, by the type checker (ADR-015 R-13, PROVIDER_ADAPTER.md §6h)', () => {
  let built: Built;
  let realFiles: string[];

  beforeAll(() => {
    built = buildProgram(Object.fromEntries(Object.entries(FIXTURES).map(([p, f]) => [p, f.code])));
    const fixturePaths = new Set(Object.keys(FIXTURES).map((p) => join(SRC, p)));
    realFiles = built.program.getRootFileNames().filter((p) => !fixturePaths.has(p));
  });

  it('scans the whole application source, type-checked', () => {
    expect(realFiles.length).toBeGreaterThan(100);
    expect(realFiles.map(relOf)).toEqual(
      expect.arrayContaining([
        STORE,
        ...SUBMISSION_PATHS,
        EXECUTOR,
        LEDGER,
        SIMULATOR,
        REGISTRY,
        MODULE,
      ]),
    );
    // Resolution works: the program has no unresolved module or type errors.
    const diagnostics = ts
      .getPreEmitDiagnostics(built.program)
      .filter(
        (d) => d.file && !Object.keys(FIXTURES).some((p) => d.file!.fileName === join(SRC, p)),
      );
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual(
      [],
    );
  });

  it('the application source has no boundary violation', () => {
    expect(realFiles.flatMap((f) => scan(built, f))).toEqual([]);
  });

  it('the sanctioned uses are seen — the scanner is not blind', () => {
    // The member rules with nothing allowed, run on the sanctioned files only.
    const none: Rules = {
      ...RULES,
      members: Object.fromEntries(Object.keys(MEMBER_RULES).map((k) => [k, []])),
    };
    const seen = (f: string) =>
      scan(built, join(SRC, f), none)
        .map((v) => v.replace(/^.*:\d+ /, ''))
        .sort();
    const executor = seen(EXECUTOR);
    expect(executor.filter((v) => v === 'references ProviderAdapter.send')).toHaveLength(1);
    expect(new Set(executor)).toEqual(
      new Set([
        'references ProviderAdapter.send',
        'references CircuitAdmissions.claimRedeemer',
        'references ProviderAdapterRegistry.resolve',
      ]),
    );
    expect(seen(LEDGER)).toContain('references GuardedProviderAdapter.submit');
    expect(seen(STORE)).toEqual(['references CircuitAdmissions.claimIssuer']);
    expect(seen(SUBMISSION_PATHS[0]!)).toEqual([
      'references ProviderStateStore.admit',
      'references ProviderStateStore.recordSubmission',
      'references ProviderSubmissionExecutor.execute',
    ]);
    expect(seen('providers/provider-health.service.ts')).toEqual([
      'references ProviderSubmissionExecutor.probe',
    ]);
  });

  it('scanner self-test: every known-bad fixture is reported, with the rule it breaks', () => {
    for (const [path, fixture] of Object.entries(FIXTURES)) {
      const found = scan(built, join(SRC, path)).map((v) => v.slice(path.length + 1));
      for (const expected of fixture.expect) {
        expect(
          `${path}: ${found.some((v) => v === expected || v.endsWith(` ${expected}`)) ? 'reported' : `missing "${expected}" in ${JSON.stringify(found)}`}`,
        ).toBe(`${path}: reported`);
      }
    }
  });

  it('only the module and the simulator construct an adapter', () => {
    const none: Rules = {
      ...RULES,
      construction: { ...CONSTRUCTION_RULES, 'GuardedProviderAdapter subclass': [] },
    };
    const constructs = realFiles
      .flatMap((f) => scan(built, f, none))
      .filter((v) => v.endsWith('constructs GuardedProviderAdapter subclass'))
      .map((v) => v.replace(/:\d+ .*$/, ''));
    expect([...new Set(constructs)].sort()).toEqual([MODULE, SIMULATOR].sort());
  });
});
