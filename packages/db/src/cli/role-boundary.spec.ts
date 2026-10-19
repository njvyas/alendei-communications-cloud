/**
 * Architecture: the only executable path that changes PostgreSQL roles is the
 * explicit `db:roles:reconcile` command. Schema migration, reset, seed and the
 * clone/test tooling can neither contain nor reach it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(__dirname, '../../../..');
const ROLE_SQL = /\b(ALTER|CREATE|DROP)\s+(ROLE|USER)\b/i;
const ROLE_PATH = 'packages/db/src/cli/role-reconcile.ts';

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return ['node_modules', 'dist', 'test', '.next'].includes(name) ? [] : sourceFiles(full);
    }
    return /\.(ts|mjs|js)$/.test(name) && !/\.(spec|int-spec|sec-spec|test)\.ts$/.test(name)
      ? [full]
      : [];
  });
}

/** Comments may mention `ALTER ROLE`; only code counts. */
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

describe('role-change boundary', () => {
  it('only role-reconcile.ts contains role-changing SQL in application, package and script code', () => {
    const offenders = ['packages/db/src', 'apps/api/src', 'apps/web/src', 'scripts']
      .flatMap((d) => sourceFiles(join(REPO, d)))
      .filter((f) => ROLE_SQL.test(withoutComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([ROLE_PATH]);
  });

  it.each([
    'packages/db/src/cli/migrate.ts',
    'packages/db/src/cli/schema-migrate.ts',
    'packages/db/src/cli/migration-history.ts',
    'packages/db/src/cli/reset.ts',
    'packages/db/src/cli/seed.ts',
  ])('%s neither imports nor spawns role reconciliation', (path) => {
    // Mentions in comments or operator messages are fine; imports and spawns are not.
    const code = withoutComments(read(path));
    expect(code).not.toMatch(/from '\.\/(role-reconcile|reconcile-roles)'|require\([^)]*reconcile/);
    expect(code).not.toMatch(
      /(execFileSync|execSync|spawn\w*|exec)\([^)]*(reconcile-roles|roles:reconcile)/,
    );
    expect(code).not.toMatch(/ALTER\s+ROLE/i);
  });

  it('reset spawns only the schema migrator and the seed', () => {
    const spawned = [
      ...read('packages/db/src/cli/reset.ts').matchAll(/'src\/cli\/([\w-]+\.ts)'/g),
    ].map((m) => m[1]);
    expect(spawned).toEqual(['migrate.ts', 'seed.ts']);
  });

  it('no database-package code carries a fallback role password', () => {
    const hits = sourceFiles(join(REPO, 'packages/db/src')).filter((f) =>
      /acc_\w+_dev_password/.test(readFileSync(f, 'utf8')),
    );
    expect(hits.map((f) => relative(REPO, f))).toEqual([]);
  });

  it('only the db:roles:reconcile scripts point at the reconcile entry point', () => {
    const scripts = {
      ...(JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
      ...(JSON.parse(read('packages/db/package.json')) as { scripts: Record<string, string> })
        .scripts,
    };
    const callers = Object.entries(scripts)
      .filter(([, command]) => /reconcile-roles\.ts|db:roles:reconcile/.test(command))
      .map(([name]) => name);
    expect(callers).toEqual(['db:roles:reconcile']);
    expect(scripts['db:migrate']).not.toMatch(/reconcile/);
    expect(scripts['db:reset']).not.toMatch(/reconcile/);
  });

  it('clone and mutation tooling never reconciles roles', () => {
    const tooling = [
      ...sourceFiles(join(REPO, 'scripts')),
      ...readdirSync(join(REPO, 'scripts/mutation/catalogue')).map((f) =>
        join(REPO, 'scripts/mutation/catalogue', f),
      ),
    ];
    const hits = tooling.filter((f) =>
      /db:roles:reconcile|reconcile-roles/.test(readFileSync(f, 'utf8')),
    );
    expect(hits.map((f) => relative(REPO, f))).toEqual([]);
  });

  it('CI reconciles exactly once, after migrating, through the ephemeral-container opt-in', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci.match(/npm run db:roles:reconcile/g)).toHaveLength(1);
    const step = ci.slice(ci.indexOf('npm run db:roles:reconcile'));
    expect(step).toMatch(
      /^npm run db:roles:reconcile\s+env:\s+ACC_ROLE_RECONCILE_TARGET: acc\s+ACC_ROLE_RECONCILE_EPHEMERAL_CI: '1'/,
    );
    expect(ci.indexOf('npm run db:migrate')).toBeLessThan(ci.indexOf('npm run db:roles:reconcile'));
  });
});
