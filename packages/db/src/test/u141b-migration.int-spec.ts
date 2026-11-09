/**
 * U14.1b — `messages_org_id_created_at_idx (org_id, created_at)` through the second
 * db:migrate barrier, the 0043 guard and its concurrent-index runner, against real
 * PostgreSQL. Every scenario runs in its own throwaway database
 * (`acc_tmp_u141b_<run>_<n>`, created on the test clone's cluster through the admin
 * connection and dropped at the end — only names matching this run's prefix).
 *
 * Proves: one db:migrate for fresh / 0024 / 0041 / 0042 / index-present databases,
 * with U14.1a's index and history untouched; the journal never records 0043 unless
 * the exact index exists; refusal of every unexpected catalogue state (including the
 * originally named (org_id, created_at DESC, id DESC) shape under this name); the
 * plain-drizzle bypass fails at the guard; interruption during the concurrent build
 * and recovery; a recorded 0043 whose index drifted stops db:migrate before any later
 * migration; --recover-invalid touches only the verified invalid target.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { Client, Pool } from 'pg';

import { runCreatedAtIndexRunner } from '../cli/index-messages-org-created-at';
import { loadExpectedMigrations } from '../cli/migration-history';
import {
  MIGRATION_LOCK_IDENTITY,
  acquireMigrationLock,
  releaseMigrationLock,
} from '../cli/migration-lock';
import { migrateSchema, readAppliedMigrations } from '../cli/schema-migrate';
import { classifyIndexFor, readIndexCatalogueFor } from '../maintenance/concurrent-index';
import {
  MESSAGES_ORG_ID_CREATED_AT as SPEC,
  ensureMessagesOrgIdCreatedAtIndex,
} from '../maintenance/messages-org-id-created-at';
import {
  MESSAGES_ORG_ID_ID_DESC,
  ensureMessagesOrgIdIdDescIndex,
} from '../maintenance/messages-org-id-id-desc';
import {
  FOLLOWING_PROBE,
  FOLLOWING_TAG,
  migrationsWithFollowing,
} from './following-migration-fixture';

jest.setTimeout(300_000);

const FOLDER = resolve(__dirname, '../../migrations');
const expected = loadExpectedMigrations(FOLDER);
const AT42 = expected.findIndex((m) => m.tag === '0042_messages_org_id_id_desc_guard');
const AT43 = expected.findIndex((m) => m.tag === '0043_messages_org_id_created_at_guard');
const RUN = randomBytes(4).toString('hex');
const PREFIX = `acc_tmp_u141b_${RUN}_`;
const NAME = /^acc_tmp_u141b_[0-9a-f]{8}_[a-z0-9]+$/;
const adminUrl = process.env.DATABASE_ADMIN_URL!;

function urlFor(db: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

let admin: Client;
const created: string[] = [];
const pools: Pool[] = [];
const openClients: Client[] = [];
let counter = 0;

async function createDb(template?: string): Promise<string> {
  const name = `${PREFIX}${(counter++).toString(36)}`;
  if (!NAME.test(name)) throw new Error(`refusing database name ${name}`);
  await admin.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`);
  created.push(name);
  return name;
}
function poolFor(db: string): Pool {
  const pool = new Pool({
    connectionString: urlFor(db),
    max: 1,
    application_name: 'acc-migrate-test',
  });
  pool.on('error', () => undefined);
  pools.push(pool);
  return pool;
}
async function clientFor(db: string, app = 'acc-u141b-observer'): Promise<Client> {
  const c = new Client({ connectionString: urlFor(db), application_name: app });
  c.on('error', () => undefined);
  await c.connect();
  openClients.push(c);
  return c;
}
/** Closes every observer client (a database used as a template must have no other sessions). */
async function closeClients(): Promise<void> {
  const clients = openClients.splice(0);
  await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
}
afterEach(closeClients);
async function lockHolders(db: string): Promise<number[]> {
  const c = await clientFor(db);
  const { rows } = await c.query<{ pid: number }>(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2 AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [MIGRATION_LOCK_IDENTITY.classid, MIGRATION_LOCK_IDENTITY.objid],
  );
  return rows.map((r) => Number(r.pid));
}
async function serverError(attempt: Promise<unknown>): Promise<string> {
  const e = (await attempt.then(
    () => undefined,
    (error: unknown) => error,
  )) as { cause?: { message?: string } } | undefined;
  if (!e) throw new Error('expected the statement to fail');
  return e.cause?.message ?? '(no server error)';
}
/** drizzle's own semantics on the given migrations folder: applies migrations 0..n-1. */
async function applyFirst(db: string, n: number, folder = FOLDER): Promise<void> {
  const c = await clientFor(db, 'acc-u141b-setup');
  const files: MigrationMeta[] = readMigrationFiles({ migrationsFolder: folder }).slice(0, n);
  const d = drizzle(c) as unknown as {
    dialect: {
      migrate(m: MigrationMeta[], s: unknown, c: { migrationsFolder: string }): Promise<void>;
    };
    session: unknown;
  };
  await d.dialect.migrate(files, d.session, { migrationsFolder: folder });
}
async function history(db: string): Promise<number> {
  return (await readAppliedMigrations(await clientFor(db))).length;
}
/** State of an index by spec, with its OID ("same OID" = not dropped or rebuilt). */
async function stateOf(db: string, spec: typeof SPEC | typeof MESSAGES_ORG_ID_ID_DESC = SPEC) {
  const c = await clientFor(db);
  const s = await readIndexCatalogueFor(spec, c);
  const { rows } = await c.query<{ oid: string | null }>(`SELECT to_regclass($1)::oid AS oid`, [
    `public.${spec.name}`,
  ]);
  return {
    oid: rows[0]?.oid ?? null,
    kind: classifyIndexFor(spec, s).kind,
    equivalents: s.equivalents,
  };
}
async function sql(db: string, text: string): Promise<void> {
  await (await clientFor(db)).query(text);
}
async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  ms = 30_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
/** The backend running the U14.1b CIC and the migration-lock holder. */
async function cicAndLockHolder(db: string): Promise<{ cic: number; holder: number } | undefined> {
  const c = await clientFor(db);
  const { rows } = await c.query<{ cic: number | null; holder: number | null }>(
    `SELECT (SELECT pid FROM pg_stat_activity WHERE query LIKE 'CREATE INDEX CONCURRENTLY messages_org_id_created_at_idx%' AND datname = current_database() LIMIT 1) AS cic,
            (SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2 AND objsubid = 1 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS holder`,
    [MIGRATION_LOCK_IDENTITY.classid, MIGRATION_LOCK_IDENTITY.objid],
  );
  await c.end();
  const r = rows[0];
  return r?.cic && r.holder ? { cic: Number(r.cic), holder: Number(r.holder) } : undefined;
}
async function blockConcurrentBuild(db: string): Promise<Client> {
  const blocker = await clientFor(db, 'acc-u141b-blocker');
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE public.messages IN ROW EXCLUSIVE MODE');
  return blocker;
}
/** Leaves an INVALID exact-definition U14.1b index: start the build, cancel it while it waits. */
async function makeInvalidIndex(db: string): Promise<void> {
  const blocker = await blockConcurrentBuild(db);
  const c = await poolFor(db).connect();
  try {
    await acquireMigrationLock(c);
    const build = ensureMessagesOrgIdCreatedAtIndex(c).catch((e: unknown) => e);
    const pids = await waitFor('the concurrent build', () => cicAndLockHolder(db));
    await admin.query('SELECT pg_cancel_backend($1)', [pids.cic]);
    expect(String(await build)).toMatch(/concurrent index build failed/);
    await releaseMigrationLock(c);
  } finally {
    c.release(true);
    await blocker.query('ROLLBACK');
  }
  expect((await stateOf(db)).kind).toBe('invalid');
}

let base24: string;
let base41: string;
let base42: string;

beforeAll(async () => {
  admin = new Client({ connectionString: adminUrl, application_name: 'acc-u141b-admin' });
  await admin.connect();
  base24 = await createDb();
  await applyFirst(base24, 25); // 0000…0024, like acc_r015_base
  await closeClients();
  base41 = await createDb(base24);
  await applyFirst(base41, AT42); // 0000…0041
  await closeClients();
  // 0000…0042: the U14.1a index, then its guard (exactly what U14.1a's db:migrate leaves).
  base42 = await createDb(base41);
  const setup = new Pool({ connectionString: urlFor(base42), max: 1 });
  const c = await setup.connect();
  try {
    await acquireMigrationLock(c);
    await ensureMessagesOrgIdIdDescIndex(c);
    await releaseMigrationLock(c);
  } finally {
    c.release();
    await setup.end();
  }
  await applyFirst(base42, AT43);
  expect(await history(base42)).toBe(AT43);
  await closeClients();
});

afterAll(async () => {
  for (const p of pools) await p.end().catch(() => undefined);
  for (const name of created.reverse()) {
    if (!name.startsWith(PREFIX) || !NAME.test(name)) continue;
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
  await admin.end();
});

describe('U14.1b — one db:migrate for every starting point; U14.1a untouched', () => {
  // Pinned at U14.1b; updated by Phase 5.0 (PR-A: 0044 M1, the 0045 guard (M2, a third barrier),
  // 0046 M3; PR-B: the forward fix 0047; PR-C: 0048; PR-D: 0049; Phase 7 PR 7-1: 0050; PR 7-2: 0051; Phase 8B.1: 0052). Update when a later migration
  // is added.
  it('0043 directly follows 0042; Phase 5.0 adds 0044–0049, Phase 7 adds 0050–0051, Phase 8B.1 adds 0052 and Phase 7 PRs 7-4, 7-5 and 7-6a add 0053–0055 after it', () => {
    expect([AT42, AT43, expected.length]).toEqual([42, 43, 56]);
  });

  it.each<[string, () => string]>([
    ['fresh', () => ''],
    ['0024 (acc_r015_base shape)', () => base24],
    ['0041', () => base41],
    ['0042 (U14.1a applied, U14.1b pending)', () => base42],
  ])(
    'from %s: reaches 0043 with both exact indexes; rerun is a no-op',
    async (_label, template) => {
      const t = template();
      const db = await createDb(t || undefined);
      const before42 = t === base42 ? await stateOf(db, MESSAGES_ORG_ID_ID_DESC) : null;
      const r = await migrateSchema(poolFor(db), FOLDER);
      expect(await history(db)).toBe(expected.length);
      expect(
        r.barriers.find((b) => b.tag === '0043_messages_org_id_created_at_guard')?.result,
      ).toBe('created');
      expect((await stateOf(db)).kind).toBe('exact');
      const u141a = await stateOf(db, MESSAGES_ORG_ID_ID_DESC);
      expect(u141a.kind).toBe('exact');
      if (before42) expect(u141a.oid).toBe(before42.oid); // U14.1a's index is not rebuilt
      const c = await clientFor(db);
      const { rows } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'messages_org_id_idx'`,
      );
      expect(rows[0]!.n).toBe(1);
      const again = await migrateSchema(poolFor(db), FOLDER);
      expect([again.pending.length, again.barriers.length]).toEqual([0, 0]);
    },
  );

  it('index already present (built by the runner first): db:migrate adopts it, same OID', async () => {
    const db = await createDb(base42);
    expect(await runCreatedAtIndexRunner(poolFor(db), 'check')).toEqual({
      ok: false,
      summary: 'index public.messages_org_id_created_at_idx is absent',
    });
    expect((await runCreatedAtIndexRunner(poolFor(db), 'ensure')).summary).toBe(
      'messages_org_id_created_at_idx: created, exact and valid',
    );
    expect(await runCreatedAtIndexRunner(poolFor(db), 'check')).toEqual({
      ok: true,
      summary: 'index public.messages_org_id_created_at_idx is present, exact and valid',
    });
    const before = await stateOf(db);
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers).toEqual([
      { tag: '0043_messages_org_id_created_at_guard', result: 'present' },
      { tag: '0045_message_attempts_delivery_indexes_guard', result: 'created' }, // Phase 5.0 (M2)
    ]);
    expect(await stateOf(db)).toEqual(before);
    expect(await history(db)).toBe(expected.length);
  });
});

describe('U14.1b — every unexpected catalogue state is refused; nothing dropped; 0043 not recorded', () => {
  it.each<[string, string]>([
    [
      'the originally named (org_id, created_at DESC, id DESC)',
      'CREATE INDEX messages_org_id_created_at_idx ON public.messages (org_id, created_at DESC, id DESC)',
    ],
    [
      'created_at DESC',
      'CREATE INDEX messages_org_id_created_at_idx ON public.messages (org_id, created_at DESC)',
    ],
    [
      'reversed columns',
      'CREATE INDEX messages_org_id_created_at_idx ON public.messages (created_at, org_id)',
    ],
    [
      'INCLUDE (id)',
      'CREATE INDEX messages_org_id_created_at_idx ON public.messages (org_id, created_at) INCLUDE (id)',
    ],
    [
      'UNIQUE',
      'CREATE UNIQUE INDEX messages_org_id_created_at_idx ON public.messages (org_id, created_at)',
    ],
    [
      'partial',
      "CREATE INDEX messages_org_id_created_at_idx ON public.messages (org_id, created_at) WHERE status = 'failed'",
    ],
    ['hash', 'CREATE INDEX messages_org_id_created_at_idx ON public.messages USING hash (org_id)'],
  ])('%s under the expected name → refused, same OID', async (_label, ddl) => {
    const db = await createDb(base42);
    await sql(db, ddl);
    const before = await stateOf(db);
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /does not match the expected definition/,
    );
    expect(await history(db)).toBe(AT43);
    expect(await stateOf(db)).toEqual(before);
    await expect(runCreatedAtIndexRunner(poolFor(db), 'recover-invalid')).rejects.toThrow(
      /Nothing was dropped/,
    );
    expect(await stateOf(db)).toEqual(before);
  });

  it('an equivalent index under another name → refused, not adopted', async () => {
    const db = await createDb(base42);
    await sql(
      db,
      'CREATE INDEX messages_created_at_by_org ON public.messages (org_id, created_at)',
    );
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /same definition under another name/,
    );
    const check = await runCreatedAtIndexRunner(poolFor(db), 'check');
    expect(check.ok).toBe(false);
    expect(check.summary).toMatch(
      /absent; equivalent index\(es\) under another name: messages_created_at_by_org/,
    );
    expect(await history(db)).toBe(AT43);
    expect((await stateOf(db)).kind).toBe('absent');
  });

  it('a table (not an index) with the name → refused', async () => {
    const db = await createDb(base42);
    await sql(db, 'CREATE TABLE public.messages_org_id_created_at_idx (x int)');
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(/is not an index/);
    expect(await history(db)).toBe(AT43);
  });
});

describe('U14.1b — the 0043 guard fails closed when the barrier is bypassed (plain drizzle)', () => {
  it('index absent: guard raises, 0043 not recorded', async () => {
    const db = await createDb(base42);
    expect(await serverError(applyFirst(db, expected.length))).toMatch(
      /^U14\.1b guard: index public\.messages_org_id_created_at_idx is absent/,
    );
    expect(await history(db)).toBe(AT43);
  });

  it('the originally named shape under the name: guard raises', async () => {
    const db = await createDb(base42);
    await sql(
      db,
      'CREATE INDEX messages_org_id_created_at_idx ON public.messages (org_id, created_at DESC, id DESC)',
    );
    expect(await serverError(applyFirst(db, expected.length))).toMatch(
      /^U14\.1b guard: public\.messages_org_id_created_at_idx is not as required: .*not exactly two key columns/,
    );
    expect(await history(db)).toBe(AT43);
  });

  it('an INVALID index: guard raises', async () => {
    const db = await createDb(base42);
    await makeInvalidIndex(db);
    expect(await serverError(applyFirst(db, expected.length))).toMatch(
      /^U14\.1b guard: public\.messages_org_id_created_at_idx is not as required: .*not usable \(indisvalid=f/,
    );
    expect(await history(db)).toBe(AT43);
  });

  it('an equivalent index under another name: guard raises', async () => {
    const db = await createDb(base42);
    await sql(
      db,
      'CREATE INDEX messages_org_id_created_at_idx ON public.messages (org_id, created_at)',
    );
    await sql(db, 'CREATE INDEX messages_created_at_dup ON public.messages (org_id, created_at)');
    expect(await serverError(applyFirst(db, expected.length))).toMatch(
      /equivalent index under another name: messages_created_at_dup/,
    );
    expect(await history(db)).toBe(AT43);
  });

  it('from 0024 by plain drizzle: the whole batch rolls back at the first guard', async () => {
    const db = await createDb(base24);
    // The first guard in the batch is U14.1a's 0042: its index is absent, so everything rolls back.
    expect(await serverError(applyFirst(db, expected.length))).toMatch(
      /^U14\.1a guard: index public\.messages_org_id_id_desc_idx is absent/,
    );
    expect(await history(db)).toBe(25);
  });
});

describe('U14.1b — interruption and recovery', () => {
  it('interrupted during the concurrent build: the CIC runs on the lock-holding session; INVALID; 0043 not recorded; refuse → --recover-invalid → db:migrate', async () => {
    const db = await createDb(base42);
    const blocker = await blockConcurrentBuild(db);
    const run = migrateSchema(poolFor(db), FOLDER).catch((e: unknown) => e);
    const pids = await waitFor('the concurrent build', () => cicAndLockHolder(db));
    expect(pids.cic).toBe(pids.holder);
    await admin.query('SELECT pg_cancel_backend($1)', [pids.cic]);
    const error = await run;
    await blocker.query('ROLLBACK');
    expect(String(error)).toMatch(
      /interrupted concurrent build.*db:index:messages-org-created-at.*--recover-invalid/,
    );
    expect(await history(db)).toBe(AT43);
    expect((await stateOf(db)).kind).toBe('invalid');
    expect(await lockHolders(db)).toEqual([]);
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(/--recover-invalid/);
    await expect(runCreatedAtIndexRunner(poolFor(db), 'ensure')).rejects.toThrow(
      /--recover-invalid/,
    );
    const invalidOid = (await stateOf(db)).oid;
    const u141aBefore = await stateOf(db, MESSAGES_ORG_ID_ID_DESC);
    expect((await runCreatedAtIndexRunner(poolFor(db), 'check')).ok).toBe(false);
    expect((await runCreatedAtIndexRunner(poolFor(db), 'recover-invalid')).summary).toBe(
      'messages_org_id_created_at_idx: recovered, exact and valid',
    );
    const after = await stateOf(db);
    expect(after.kind).toBe('exact');
    // Only the verified invalid target was touched: U14.1a's index keeps its OID.
    expect(await stateOf(db, MESSAGES_ORG_ID_ID_DESC)).toEqual(u141aBefore);
    expect(after.oid).not.toBe(invalidOid);
    await migrateSchema(poolFor(db), FOLDER);
    expect(await history(db)).toBe(expected.length);
    // safe rerun of the recovery on a valid index: no-op, same OID
    await runCreatedAtIndexRunner(poolFor(db), 'recover-invalid');
    expect((await stateOf(db)).oid).toBe(after.oid);
  });

  it('interrupted after the 0043 barrier, before its guard: rerun adopts the index (present) and records 0043', async () => {
    const db = await createDb(base42);
    await expect(
      migrateSchema(poolFor(db), FOLDER, {
        checkpoint: async (p, tag) => {
          if (p === 'after-barrier' && tag === '0043_messages_org_id_created_at_guard')
            throw new Error('stop');
        },
      }),
    ).rejects.toThrow('stop');
    expect(await history(db)).toBe(AT43);
    expect((await stateOf(db)).kind).toBe('exact');
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers).toEqual([
      { tag: '0043_messages_org_id_created_at_guard', result: 'present' },
      { tag: '0045_message_attempts_delivery_indexes_guard', result: 'created' }, // Phase 5.0 (M2)
    ]);
    expect(await history(db)).toBe(expected.length);
  });

  it('runner refusals: a history before public.messages exists, in every mode', async () => {
    for (const mode of ['check', 'ensure', 'recover-invalid'] as const) {
      await expect(runCreatedAtIndexRunner(poolFor(base24), mode)).rejects.toThrow(
        /public\.messages is created by 0033/,
      );
    }
  });
});

describe('U14.1b — a recorded 0043 is verified before anything later is applied (U-3)', () => {
  it.each<['missing' | 'invalid' | 'redefined', RegExp]>([
    [
      'missing',
      /0043_messages_org_id_created_at_guard is recorded, but the index is not as required.*absent/,
    ],
    [
      'invalid',
      /0043_messages_org_id_created_at_guard is recorded, but the index is not as required.*not usable/,
    ],
    ['redefined', /does not match the expected definition/],
  ])(
    '%s index with a later migration pending: stopped before it; lock released; rerun after repair applies it',
    async (state, refusal) => {
      const fixture = migrationsWithFollowing();
      try {
        const db = await createDb(base42);
        await migrateSchema(poolFor(db), FOLDER);
        await sql(db, 'DROP INDEX public.messages_org_id_created_at_idx');
        if (state === 'invalid') await makeInvalidIndex(db);
        if (state === 'redefined') {
          await sql(
            db,
            'CREATE INDEX messages_org_id_created_at_idx ON public.messages (org_id, created_at DESC)',
          );
        }
        const probe = async () =>
          (
            await (
              await clientFor(db)
            ).query<{ p: boolean }>(`SELECT to_regclass('${FOLLOWING_PROBE}') IS NOT NULL AS p`)
          ).rows[0]!.p;
        await expect(migrateSchema(poolFor(db), fixture.folder)).rejects.toThrow(refusal);
        expect(await history(db)).toBe(expected.length);
        expect(await probe()).toBe(false);
        expect(await lockHolders(db)).toEqual([]);
        if (state === 'redefined') {
          await sql(db, 'DROP INDEX public.messages_org_id_created_at_idx'); // operator decision
          await runCreatedAtIndexRunner(poolFor(db), 'ensure');
        } else {
          await runCreatedAtIndexRunner(
            poolFor(db),
            state === 'invalid' ? 'recover-invalid' : 'ensure',
          );
        }
        const r = await migrateSchema(poolFor(db), fixture.folder);
        expect(r.pending.map((m) => m.tag)).toEqual([FOLLOWING_TAG]);
        expect(await probe()).toBe(true);
        expect((await stateOf(db)).kind).toBe('exact');
      } finally {
        fixture.cleanup();
      }
    },
  );

  it('with 0042 recorded, a drifted U14.1a index stops db:migrate before the U14.1b build', async () => {
    const db = await createDb(base42);
    await sql(db, 'DROP INDEX public.messages_org_id_id_desc_idx');
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /0042_messages_org_id_id_desc_guard is recorded, but the index is not as required/,
    );
    expect((await stateOf(db)).kind).toBe('absent'); // the U14.1b build never started
    expect(await history(db)).toBe(AT43);
  });
});
