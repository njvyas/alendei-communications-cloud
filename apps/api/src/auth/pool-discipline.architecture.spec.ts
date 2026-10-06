import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * ADR-015 R-1 / R-12 — the static backstop to the runtime pool guard.
 *
 * The guard (`guardPool`, `packages/db`) refuses a nested acquisition when it
 * happens; this suite refuses the code shapes that produce one, before they
 * run, and pins the one shape that is meant to commit on its own:
 *
 *   1. `AuditWriter.record` without a transaction is a separate connection.
 *      Only the sign-in failure writer (`AuthService.recordLoginFailure`) may
 *      do it, and it is only ever reached with nothing held.
 *   2. No Argon2 work (`CredentialService.verify`, `verifyDummy`, `hash`)
 *      lexically inside a transaction callback: it would pin the connection for
 *      the whole hash.
 *   3. No identity-pool access (`db.auth`) and no tenant transaction
 *      (`withTenant`, `withRequestTenant`) lexically inside a transaction
 *      callback: each is a second acquisition while one is held. Work handed to
 *      `TenantDatabase.whenReleased` is exempt by construction — it runs after
 *      the transaction has released its connection.
 *
 * Lexical only, by design: a call reached through a method boundary is the
 * runtime guard's to catch, and the full API suites run under it.
 */
const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Calls that run their function argument while holding a pooled connection. */
const TRANSACTION_CALLS = new Set(['transaction', 'withTenant', 'withRequestTenant']);
const TRANSACTION_FUNCTIONS = new Set(['withTenantTransaction']);
/** Calls whose function argument runs after the connection is released. */
const RELEASED_CALLS = new Set(['whenReleased']);
const ARGON2_METHODS = new Set(['verify', 'verifyDummy', 'hash']);

/** The only places `AuditWriter.record` may be called without a transaction. */
const TX_LESS_AUDIT_ALLOWLIST = ['auth/auth.service.ts#recordLoginFailure'];

interface Finding {
  readonly where: string;
  readonly call: string;
}

interface Scan {
  readonly txLessAudit: Finding[];
  readonly argon2InTransaction: Finding[];
  readonly acquisitionInTransaction: Finding[];
  readonly transactionCallbacks: number;
}

function calleeName(call: ts.CallExpression): string | null {
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return null;
}

function receiverText(call: ts.CallExpression, source: ts.SourceFile): string {
  return ts.isPropertyAccessExpression(call.expression)
    ? call.expression.expression.getText(source)
    : '';
}

function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name) {
      return n.name.getText();
    }
  }
  return '<top>';
}

function isFunctionArgument(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function scan(rel: string, text: string): Scan {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const result: Scan = {
    txLessAudit: [],
    argon2InTransaction: [],
    acquisitionInTransaction: [],
    transactionCallbacks: 0,
  };
  const findings = result as {
    -readonly [K in keyof Scan]: Scan[K];
  };

  const visit = (node: ts.Node, inTransaction: boolean): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const receiver = receiverText(node, source);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const finding = {
        where: `${rel}#${enclosingName(node)}`,
        call: `${receiver}.${name}@${line}`,
      };

      if (
        name === 'record' &&
        /(^|\.)audit(Writer)?$/.test(receiver) &&
        node.arguments.length < 2
      ) {
        findings.txLessAudit.push(finding);
      }
      if (
        inTransaction &&
        name &&
        ARGON2_METHODS.has(name) &&
        /(^|\.)credentials$/.test(receiver)
      ) {
        findings.argon2InTransaction.push(finding);
      }
      if (
        inTransaction &&
        name &&
        (TRANSACTION_CALLS.has(name) || TRANSACTION_FUNCTIONS.has(name)) &&
        name !== 'transaction'
      ) {
        findings.acquisitionInTransaction.push(finding);
      }

      const opensTransaction =
        (name !== null &&
          TRANSACTION_CALLS.has(name) &&
          ts.isPropertyAccessExpression(node.expression)) ||
        (name !== null && TRANSACTION_FUNCTIONS.has(name));
      const released = name !== null && RELEASED_CALLS.has(name);
      if (opensTransaction || released) {
        visit(node.expression, inTransaction);
        for (const argument of node.arguments) {
          if (isFunctionArgument(argument)) {
            if (opensTransaction) findings.transactionCallbacks += 1;
            visit(argument, opensTransaction);
          } else {
            visit(argument, inTransaction);
          }
        }
        return;
      }
    }

    // `db.auth` — the identity pool — reached from inside a transaction
    // callback, whatever is then called on it (a statement or a transaction).
    if (
      inTransaction &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'auth' &&
      /(^|\.)db$/.test(node.expression.getText(source))
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      findings.acquisitionInTransaction.push({
        where: `${rel}#${enclosingName(node)}`,
        call: `${node.getText(source)}@${line}`,
      });
    }

    ts.forEachChild(node, (child) => visit(child, inTransaction));
  };

  visit(source, false);
  return result;
}

const files = sources(SRC).map((path) => ({
  rel: relative(SRC, path).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8'),
}));
const scans = files.map((f) => ({ rel: f.rel, ...scan(f.rel, f.text) }));
const all = <K extends 'txLessAudit' | 'argon2InTransaction' | 'acquisitionInTransaction'>(
  key: K,
) => scans.flatMap((s) => s[key]);

describe('pool discipline — static backstop (ADR-015 R-1, R-12)', () => {
  it('scans the whole application source and recognizes its transactions', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => f.rel)).toEqual(
      expect.arrayContaining([
        'auth/auth.service.ts',
        'auth/auth.guard.ts',
        'auth/authorization.service.ts',
        'database/tenant-database.service.ts',
      ]),
    );
    expect(scans.reduce((n, s) => n + s.transactionCallbacks, 0)).toBeGreaterThan(40);
  });

  it('writes an audit record without a transaction only from the sign-in failure writer', () => {
    expect(all('txLessAudit').map((f) => f.where)).toEqual(TX_LESS_AUDIT_ALLOWLIST);
  });

  it('runs no Argon2 verification or hashing inside a transaction callback', () => {
    expect(all('argon2InTransaction')).toEqual([]);
  });

  it('acquires no identity connection and opens no tenant transaction inside a transaction callback', () => {
    expect(all('acquisitionInTransaction')).toEqual([]);
  });

  describe('the detector itself', () => {
    // Each rule is shown to fire on the shape it forbids, so a green run above
    // means "absent", not "undetectable".
    const fixture = (body: string) => scan('fixture.ts', `class F { async m() { ${body} } }`);

    it('flags a transaction-less audit record', () => {
      expect(fixture('await this.audit.record({});').txLessAudit).toHaveLength(1);
      expect(fixture('await this.audit.record({}, tx);').txLessAudit).toHaveLength(0);
    });

    it('flags Argon2 inside identity and tenant transactions, not outside', () => {
      expect(
        fixture(
          'await this.db.auth.transaction(async (tx) => { await this.credentials.verify(d, p); });',
        ).argon2InTransaction,
      ).toHaveLength(1);
      expect(
        fixture('await this.db.withRequestTenant(async (tx) => this.credentials.hash(p));')
          .argon2InTransaction,
      ).toHaveLength(1);
      expect(
        fixture(
          'await this.credentials.verifyDummy(p); await this.db.auth.transaction(async (tx) => 1);',
        ).argon2InTransaction,
      ).toHaveLength(0);
    });

    it('flags nested acquisitions, but not work deferred until release', () => {
      expect(
        fixture('await this.db.auth.transaction(async (tx) => { await this.db.auth.insert(t); });')
          .acquisitionInTransaction,
      ).toHaveLength(1);
      expect(
        fixture('await this.db.withTenant(s, async (tx) => this.db.withTenant(s, async () => 1));')
          .acquisitionInTransaction,
      ).toHaveLength(1);
      expect(
        fixture(
          'await this.db.withRequestTenant(async (tx) => this.db.auth.transaction(async () => 1));',
        ).acquisitionInTransaction,
      ).toHaveLength(1);
      expect(
        fixture('await this.db.whenReleased(async () => this.db.withTenant(s, async () => 1));')
          .acquisitionInTransaction,
      ).toHaveLength(0);
    });
  });
});
