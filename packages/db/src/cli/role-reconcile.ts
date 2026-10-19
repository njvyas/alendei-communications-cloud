/**
 * Role reconciliation: grants LOGIN and sets the password of the four
 * application roles. This is the ONLY module that changes PostgreSQL roles.
 *
 * Roles are cluster-global: `ALTER ROLE` affects every database on the server,
 * whichever database the connection names. Schema migration therefore never
 * does this (`migrate.ts` is schema-only); it is a separate, deliberate
 * command (`npm run db:roles:reconcile`) guarded by `planRoleReconcile`.
 */
import type { Pool } from 'pg';

import { DB_ROLES } from '../constants';

/** Reference/template databases that must never be the target. */
export const REFERENCE_DATABASES: readonly string[] = Object.freeze([
  'acc_r015_base',
  'acc_gateb',
  'acc_p23',
  'acc_p23_fresh',
  'acc_p24',
  'acc_p24_fresh',
]);

/** `scripts/with-db-clone.mjs` clones: `<template>_clone_<12 hex>`. */
const CLONE_DATABASE = /_clone_[0-9a-f]{12}$/;
/** Throwaway databases (`TESTING.md` §6q naming rule). */
const THROWAWAY_DATABASE = /^acc_tmp_/;

/** Which environment variable carries each role's password. No defaults exist. */
export const ROLE_PASSWORD_VARIABLES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  [DB_ROLES.APP, 'DATABASE_APP_PASSWORD'],
  [DB_ROLES.AUTH, 'DATABASE_AUTH_PASSWORD'],
  [DB_ROLES.RELAY, 'DATABASE_RELAY_PASSWORD'],
  [DB_ROLES.DISPATCH, 'DATABASE_DISPATCH_PASSWORD'],
] as const);

export interface RoleCredential {
  readonly role: string;
  readonly password: string;
}

export interface RoleReconcilePlan {
  readonly database: string;
  readonly credentials: readonly RoleCredential[];
}

export class RoleReconcileRefused extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`Refusing role reconciliation:\n${reasons.map((r) => `  - ${r}`).join('\n')}`);
    this.name = 'RoleReconcileRefused';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function databaseOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1)) || null;
  } catch {
    return null;
  }
}

/**
 * Decides whether reconciliation may run, and with which credentials. Pure.
 *
 * Refuses unless ALL hold:
 * - `ACC_ROLE_RECONCILE_TARGET` names exactly the database in `DATABASE_ADMIN_URL`
 *   (deliberate enablement plus an explicit target);
 * - the target is not a with-db-clone clone, an `acc_tmp_*` database or a
 *   reference database;
 * - the context is not a test (`APP_ENV`/`NODE_ENV` = `test`), except an
 *   ephemeral CI service container: `CI=true` and `ACC_ROLE_RECONCILE_EPHEMERAL_CI=1`;
 *   the CI flag is itself refused anywhere else;
 * - every role's password variable is set and non-blank (no fallback exists).
 */
export function planRoleReconcile(env: Env): RoleReconcilePlan {
  const reasons: string[] = [];
  const adminUrl = env.DATABASE_ADMIN_URL;
  const database = adminUrl ? databaseOf(adminUrl) : null;
  if (!adminUrl) reasons.push('DATABASE_ADMIN_URL must be set');
  else if (!database) reasons.push('DATABASE_ADMIN_URL must name a database');

  const target = env.ACC_ROLE_RECONCILE_TARGET;
  if (!target) {
    reasons.push('ACC_ROLE_RECONCILE_TARGET must be set to the target database name');
  } else if (database && target !== database) {
    reasons.push(
      `ACC_ROLE_RECONCILE_TARGET (${target}) does not match the DATABASE_ADMIN_URL database (${database})`,
    );
  }

  if (database) {
    if (CLONE_DATABASE.test(database)) reasons.push(`${database} is a with-db-clone clone`);
    if (THROWAWAY_DATABASE.test(database)) reasons.push(`${database} is a throwaway database`);
    if (REFERENCE_DATABASES.includes(database)) reasons.push(`${database} is a reference database`);
  }

  const ephemeralCi = env.ACC_ROLE_RECONCILE_EPHEMERAL_CI === '1';
  const isCi = env.CI === 'true';
  if (ephemeralCi && !isCi) {
    reasons.push('ACC_ROLE_RECONCILE_EPHEMERAL_CI is only accepted when CI=true');
  }
  const testContext = env.APP_ENV === 'test' || env.NODE_ENV === 'test';
  if (testContext && !(ephemeralCi && isCi)) {
    reasons.push('test contexts are refused (only an ephemeral CI container may opt in)');
  }

  const credentials: RoleCredential[] = [];
  for (const [role, variable] of ROLE_PASSWORD_VARIABLES) {
    const password = env[variable];
    if (!password || password.trim() === '') reasons.push(`${variable} must be set for ${role}`);
    else credentials.push({ role, password });
  }

  if (reasons.length > 0) throw new RoleReconcileRefused(reasons);
  return { database: database!, credentials };
}

/** Rejects an identifier that is not one of our own fixed role names. */
function assertKnownRole(role: string): void {
  const known: readonly string[] = Object.values(DB_ROLES);
  if (!known.includes(role)) {
    throw new Error(`refusing to alter unknown role "${role}"`);
  }
}

/**
 * Grants LOGIN and sets each password. Every role must already exist (the
 * migrations create them NOLOGIN); a missing role is refused, never created.
 */
export async function reconcileRoles(
  pool: Pool,
  credentials: readonly RoleCredential[],
): Promise<void> {
  for (const { role } of credentials) assertKnownRole(role);
  const { rows } = await pool.query<{ rolname: string }>(
    'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])',
    [credentials.map((c) => c.role)],
  );
  const present = new Set(rows.map((r) => r.rolname));
  const missing = credentials.filter((c) => !present.has(c.role)).map((c) => c.role);
  if (missing.length > 0) {
    throw new Error(`roles missing (run npm run db:migrate first): ${missing.join(', ')}`);
  }

  for (const { role, password } of credentials) {
    // `ALTER ROLE` takes no bind parameters, so the password is escaped by
    // PostgreSQL itself via quote_literal rather than by string handling here.
    // The role name is safe by construction: it came from the allowlist above.
    const literal = (
      await pool.query<{ literal: string }>('SELECT quote_literal($1::text) AS literal', [password])
    ).rows[0]?.literal;
    if (!literal) throw new Error(`failed to quote password for role ${role}`);
    await pool.query(`ALTER ROLE ${role} LOGIN PASSWORD ${literal}`);
  }
}
