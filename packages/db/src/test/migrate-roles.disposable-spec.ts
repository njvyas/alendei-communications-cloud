/**
 * Real-PostgreSQL proof that `npm run db:migrate` is schema-only and fails
 * closed on a tampered history. DISPOSABLE CLUSTER ONLY.
 *
 *   ACC_DISPOSABLE_CLUSTER_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres \
 *     npm run test:disposable --workspace @acc/db
 *
 * Guard: refuses unless the cluster is pristine — no `acc_*` role and no
 * database besides postgres/template0/template1 — and not on port 5432. The
 * shared development cluster fails this by construction. The test creates the
 * four pre-Phase-5.0 application roles WITH passwords (as a shared cluster has
 * them), then proves migration leaves every one of them — attributes, password
 * hash, memberships — untouched.
 *
 * Phase 5.0 (AC-GR-2): migration 0044 creates `acc_delivery` NOLOGIN, before its
 * grants, when it does not exist (the 0032 precedent). On this pristine cluster
 * the role is absent, so the first run must create exactly that role — not
 * LOGIN, no password, no attribute, no membership — and nothing else.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';

import { loadExpectedMigrations } from '../cli/migration-history';

const CLUSTER_URL = process.env.ACC_DISPOSABLE_CLUSTER_URL;
const DATABASE = `acc_g_disposable_${randomBytes(4).toString('hex')}`;
const ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch'];
const PACKAGE_DIR = resolve(__dirname, '../..');
const JOURNAL_ENTRIES = loadExpectedMigrations(resolve(PACKAGE_DIR, 'migrations')).length;

function urlFor(database: string): string {
  const url = new URL(CLUSTER_URL!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(database: string, work: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Every role's attributes, password hash and memberships, as one digest — optionally
 * leaving out the roles a migration is expected to create.
 */
const roleDigest = (excluding: readonly string[] = []) =>
  withClient('postgres', async (c) => {
    const { rows } = await c.query<{ d: string }>(
      `
      SELECT md5(string_agg(row_to_json(a)::text || '|' || coalesce((
               SELECT string_agg(m.roleid::regrole::text, ',' ORDER BY m.roleid::regrole::text)
                 FROM pg_auth_members m WHERE m.member = a.oid), ''), E'\\n' ORDER BY a.rolname)) AS d
        FROM pg_authid a
       WHERE a.rolname <> ALL($1::text[])`,
      [excluding],
    );
    return rows[0]!.d;
  });

/** The created delivery role's attributes (Phase 5.0, AC-GR-2). */
const deliveryRole = () =>
  withClient('postgres', async (c) => {
    const { rows } = await c.query(
      `SELECT a.rolcanlogin, a.rolsuper, a.rolbypassrls, a.rolcreaterole, a.rolcreatedb,
              a.rolreplication, a.rolinherit, a.rolpassword IS NULL AS no_password,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = a.oid OR m.roleid = a.oid) AS memberships
         FROM pg_authid a WHERE a.rolname = 'acc_delivery'`,
    );
    return rows;
  });

const historyCount = () =>
  withClient(DATABASE, async (c) =>
    Number(
      (await c.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n,
    ),
  );

function runMigrate(): { status: number | null; output: string } {
  const result = spawnSync('npx', ['tsx', 'src/cli/migrate.ts'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, DATABASE_ADMIN_URL: urlFor(DATABASE) },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('db:migrate on a disposable cluster', () => {
  beforeAll(async () => {
    if (!CLUSTER_URL)
      throw new Error('ACC_DISPOSABLE_CLUSTER_URL is required (disposable cluster only)');
    if (new URL(CLUSTER_URL).port === '5432' || new URL(CLUSTER_URL).port === '') {
      throw new Error('refusing port 5432: the shared development cluster listens there');
    }
    await withClient('postgres', async (c) => {
      const roles = Number(
        (await c.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'acc\\_%'`))
          .rows[0].n,
      );
      const databases = Number(
        (
          await c.query(
            `SELECT count(*)::int AS n FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')`,
          )
        ).rows[0].n,
      );
      if (roles !== 0 || databases !== 0) {
        throw new Error(
          `refusing a non-pristine cluster (${roles} acc roles, ${databases} databases)`,
        );
      }
      for (const role of ROLES) {
        await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${randomBytes(12).toString('hex')}'`);
      }
      await c.query(`CREATE DATABASE ${DATABASE}`);
    });
  }, 60_000);

  it('migrates a fresh database to the full journal: no existing role changes; acc_delivery is created NOLOGIN', async () => {
    expect(await deliveryRole()).toEqual([]);
    const before = await roleDigest();
    const run = runMigrate();
    expect(run.output).not.toMatch(/Refusing|error/i);
    expect(run.status).toBe(0);
    expect(run.output).toContain('No role LOGIN or password was changed');
    expect(await historyCount()).toBe(JOURNAL_ENTRIES);
    // Every role that existed before is byte-identical (attributes, password hash, memberships).
    expect(await roleDigest(['acc_delivery'])).toBe(before);
    // 0044 created exactly one role, inert until db:roles:reconcile grants LOGIN.
    expect(await deliveryRole()).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolinherit: true,
        no_password: true,
        memberships: 0,
      },
    ]);
  }, 180_000);

  it('re-running is a verified no-op that still changes no role', async () => {
    const before = await roleDigest();
    const run = runMigrate();
    expect(run.status).toBe(0);
    expect(run.output).toContain(`Schema up to date (${JOURNAL_ENTRIES} migrations verified)`);
    expect(await roleDigest()).toBe(before);
  }, 180_000);

  it('refuses, applying nothing, after the 0033 history hash is rewritten', async () => {
    await withClient(DATABASE, (c) =>
      c.query(
        `UPDATE drizzle.__drizzle_migrations SET hash = repeat('0', 64) WHERE created_at = 1791996046914`,
      ),
    );
    const before = await roleDigest();
    const run = runMigrate();
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('Refusing to migrate');
    expect(run.output).toContain('0033_phase3_3_orchestrator_dispatch');
    expect(await historyCount()).toBe(JOURNAL_ENTRIES);
    expect(await roleDigest()).toBe(before);
  }, 180_000);
});
