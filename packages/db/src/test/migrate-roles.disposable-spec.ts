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
 * four application roles WITH passwords (as a shared cluster has them), then
 * proves migration leaves every role attribute and password hash untouched.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';

const CLUSTER_URL = process.env.ACC_DISPOSABLE_CLUSTER_URL;
const DATABASE = `acc_g_disposable_${randomBytes(4).toString('hex')}`;
const ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch'];
const PACKAGE_DIR = resolve(__dirname, '../..');

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

/** Every role's attributes, password hash and memberships, as one digest. */
const roleDigest = () =>
  withClient('postgres', async (c) => {
    const { rows } = await c.query<{ d: string }>(`
      SELECT md5(string_agg(row_to_json(a)::text || '|' || coalesce((
               SELECT string_agg(m.roleid::regrole::text, ',' ORDER BY m.roleid::regrole::text)
                 FROM pg_auth_members m WHERE m.member = a.oid), ''), E'\\n' ORDER BY a.rolname)) AS d
        FROM pg_authid a`);
    return rows[0]!.d;
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

  it('migrates a fresh database to the full journal without changing any role', async () => {
    const before = await roleDigest();
    const run = runMigrate();
    expect(run.output).not.toMatch(/Refusing|error/i);
    expect(run.status).toBe(0);
    expect(run.output).toContain('Roles were not changed');
    expect(await historyCount()).toBe(36);
    expect(await roleDigest()).toBe(before);
  }, 180_000);

  it('re-running is a verified no-op that still changes no role', async () => {
    const before = await roleDigest();
    const run = runMigrate();
    expect(run.status).toBe(0);
    expect(run.output).toContain('Schema up to date (36 migrations verified)');
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
    expect(await historyCount()).toBe(36);
    expect(await roleDigest()).toBe(before);
  }, 180_000);
});
