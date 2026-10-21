import { existsSync } from 'node:fs';

/**
 * Refuses database-backed test runs aimed at a persistent database
 * (`TESTING.md` §6q; incident of 20-Oct-2026, when an unwrapped integration run
 * wrote fixtures into the shared development database `acc`).
 *
 * Called from the setup file of every database-backed Jest project — the API
 * `integration` and `security` projects and the `@acc/db` `integration`
 * project — after `.env` is loaded, so it judges the connections the suites
 * will actually open. The `@acc/db` `disposable` project has no setup file and
 * keeps its own cluster guard.
 *
 * A run proceeds only when every configured connection names one database and
 * that database is
 *
 *   - the disposable copy the current `scripts/with-db-clone.mjs` invocation
 *     created: a `<template>_clone_<12 hex>` name equal to the `ACC_TEST_CLONE`
 *     the runner passes to its child. The shape alone is not enough — a
 *     leftover or evidence clone (`acc_clone_436072f90852`) has it too — or
 *   - the CI service container: `CI=true` and `GITHUB_ACTIONS=true`, a loopback
 *     host, and no `.env` file in the checkout. CI's database is also named
 *     `acc`, so the name cannot tell it apart; a workstation, whose shared
 *     configuration lives in `.env`, is refused even with both flags set.
 *
 * Messages name variables and databases only — never a credential.
 */

/** Every variable a test connection is built from (`harness.ts`, `auth-harness.ts`, the app's database module). */
export const DATABASE_URL_VARIABLES = [
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'DATABASE_AUTH_URL',
  'DATABASE_RELAY_URL',
  'DATABASE_DISPATCH_URL',
] as const;

/** Read by every harness; a run without them cannot be judged and is refused. */
const REQUIRED_VARIABLES = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_AUTH_URL'] as const;

/** The name `with-db-clone.mjs` gives its copy: `${template}_clone_${randomBytes(6).hex}`. */
const DISPOSABLE_CLONE = /^[a-z0-9_]+_clone_[0-9a-f]{12}$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const REMEDY =
  'Run database-backed suites on a disposable copy: node scripts/with-db-clone.mjs -- <command> (docs/TESTING.md §6q).';

export interface DatabaseTargetInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether a `.env` file exists in the checkout (CI has none). */
  readonly envFilePresent: boolean;
}

/** Why the run must not proceed, or `null` when the target is disposable. */
export function databaseTargetProblem({ env, envFilePresent }: DatabaseTargetInput): string | null {
  const missing = REQUIRED_VARIABLES.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return `database test target is not configured (${missing.join(', ')} unset).`;
  }

  const targets: { name: string; database: string; host: string }[] = [];
  for (const name of DATABASE_URL_VARIABLES) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return `${name} is not a valid connection URL.`;
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      return `${name} is not a postgres:// connection URL.`;
    }
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!database) return `${name} names no database.`;
    targets.push({ name, database, host: url.hostname });
  }

  const databases = [...new Set(targets.map((t) => t.database))];
  if (databases.length > 1) {
    return `the connection variables name different databases (${targets
      .map((t) => `${t.name} → "${t.database}"`)
      .join(', ')}); every test connection must reach the same disposable database.`;
  }
  const database = databases[0]!;

  if (DISPOSABLE_CLONE.test(database)) {
    const approved = env.ACC_TEST_CLONE;
    if (approved === undefined || approved === '') {
      return `refusing database "${database}": it has a clone's name, but it is not the copy created by this run of scripts/with-db-clone.mjs (ACC_TEST_CLONE is unset).`;
    }
    if (!DISPOSABLE_CLONE.test(approved)) {
      return `refusing database "${database}": ACC_TEST_CLONE is not a with-db-clone.mjs copy name.`;
    }
    if (approved !== database) {
      return `refusing database "${database}": it is not the copy created by this run of scripts/with-db-clone.mjs ("${approved}").`;
    }
    return null;
  }

  const verifiedCi =
    env.CI === 'true' &&
    env.GITHUB_ACTIONS === 'true' &&
    !envFilePresent &&
    targets.every((t) => LOOPBACK_HOSTS.has(t.host));
  if (verifiedCi) return null;

  return `refusing database "${database}": it is not a disposable copy made by scripts/with-db-clone.mjs, and this is not the CI service container.`;
}

/** Throws before any suite connects when the target is not disposable. */
export function assertDisposableTestDatabase(envFiles: readonly string[]): void {
  const problem = databaseTargetProblem({
    env: process.env,
    envFilePresent: envFiles.some((path) => existsSync(path)),
  });
  if (problem) {
    throw new Error(`Database test guard: ${problem} ${REMEDY}`);
  }
}
