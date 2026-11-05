/**
 * U14.1a — barrier-aware db:migrate, the 0042 guard and the concurrent-index runner,
 * against real PostgreSQL. Every scenario runs in its own throwaway database
 * (`acc_tmp_u141a_<run>_<n>`, created on the test clone's cluster through the admin
 * connection and dropped at the end — only names matching this run's prefix).
 *
 * Proves: one command for fresh / 0024 / 0041 / index-present databases; the journal
 * never records 0042 unless the exact index exists; refusal of every unexpected
 * catalogue state; interruption at every significant point (before, during and after
 * the concurrent build, during 0042, after 0042, drift afterwards); the same session
 * holds the migration lock while drizzle and CREATE INDEX CONCURRENTLY run; bounded
 * lock waits; --recover-invalid touches only the verified invalid target.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { Client, Pool } from 'pg';

import { MIGRATION_LOCK_IDENTITY, MigrationLockError } from '../cli/migration-lock';
import { migrateSchema, readAppliedMigrations, type Checkpoint } from '../cli/schema-migrate';
import { runIndexRunner } from '../cli/index-messages-org-id-desc';
import {
  MESSAGES_ORG_ID_ID_DESC,
  classifyIndex,
  ensureMessagesOrgIdIdDescIndex,
  readIndexCatalogue,
} from '../maintenance/messages-org-id-id-desc';
import { acquireMigrationLock, releaseMigrationLock } from '../cli/migration-lock';
import { loadExpectedMigrations } from '../cli/migration-history';
import {
  FOLLOWING_PROBE,
  FOLLOWING_TAG,
  migrationsWithFollowing,
} from './following-migration-fixture';

jest.setTimeout(300_000);

const FOLDER = resolve(__dirname, '../../migrations');
const expected = loadExpectedMigrations(FOLDER);
const GUARD_AT = expected.findIndex((m) => m.tag === '0042_messages_org_id_id_desc_guard');
const RUN = randomBytes(4).toString('hex');
const PREFIX = `acc_tmp_u141a_${RUN}_`;
const NAME = /^acc_tmp_u141a_[0-9a-f]{8}_[a-z0-9]+$/;
const adminUrl = process.env.DATABASE_ADMIN_URL!;

function urlFor(db: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

let admin: Client;
const created: string[] = [];
const pools: Pool[] = [];
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
  // Scenarios terminate backends on purpose; an idle client's late 'error' must not crash the run.
  pool.on('error', () => undefined);
  pools.push(pool);
  return pool;
}
async function clientFor(db: string, app = 'acc-u141a-observer'): Promise<Client> {
  const c = new Client({ connectionString: urlFor(db), application_name: app });
  c.on('error', () => undefined);
  await c.connect();
  openClients.push(c);
  return c;
}
/** Every client a scenario opened is closed after it, even when it failed midway (an open transaction rolls back). */
const openClients: Client[] = [];
afterEach(async () => {
  const clients = openClients.splice(0);
  await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
});
/** Sessions holding the migration lock in this database, independent of any build. */
async function lockHolders(observer: Client): Promise<number[]> {
  const { rows } = await observer.query<{ pid: number }>(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2 AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [MIGRATION_LOCK_IDENTITY.classid, MIGRATION_LOCK_IDENTITY.objid],
  );
  return rows.map((r) => Number(r.pid));
}
/** PostgreSQL's own message: drizzle wraps errors as "Failed query: <sql>" (which quotes the guard source) with the server error in `cause`. */
async function serverError(attempt: Promise<unknown>): Promise<string> {
  const e = (await attempt.then(
    () => undefined,
    (error: unknown) => error,
  )) as { cause?: { message?: string } } | undefined;
  if (!e) throw new Error('expected the statement to fail');
  return e.cause?.message ?? '(no server error)';
}
/** drizzle's own semantics: applies migrations 0..n-1 (as `db:migrate` would before any barrier). */
async function applyFirst(db: string, n: number): Promise<void> {
  const c = await clientFor(db, 'acc-u141a-setup');
  try {
    const files: MigrationMeta[] = readMigrationFiles({ migrationsFolder: FOLDER }).slice(0, n);
    const d = drizzle(c) as unknown as {
      dialect: {
        migrate(m: MigrationMeta[], s: unknown, c: { migrationsFolder: string }): Promise<void>;
      };
      session: unknown;
    };
    await d.dialect.migrate(files, d.session, { migrationsFolder: FOLDER });
  } finally {
    await c.end();
  }
}
async function history(db: string): Promise<number> {
  const c = await clientFor(db);
  try {
    return (await readAppliedMigrations(c)).length;
  } finally {
    await c.end();
  }
}
async function indexState(db: string) {
  const c = await clientFor(db);
  try {
    const s = await readIndexCatalogue(c);
    // The OID proves "not dropped": a drop and rebuild yields an identical definition under a new OID.
    const { rows } = await c.query<{ oid: string | null }>(
      `SELECT to_regclass('public.messages_org_id_id_desc_idx')::oid AS oid`,
    );
    return {
      oid: rows[0]?.oid ?? null,
      state: classifyIndex(s),
      equivalents: s.equivalents,
      def: s.target?.definition ?? null,
    };
  } finally {
    await c.end();
  }
}
async function sql(db: string, text: string): Promise<void> {
  const c = await clientFor(db);
  try {
    await c.query(text);
  } finally {
    await c.end();
  }
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
/** Backend running CREATE INDEX CONCURRENTLY on the messages index, and the advisory-lock holder, seen by an observer. */
async function cicAndLockHolder(
  observer: Client,
): Promise<{ cic: number; holder: number } | undefined> {
  const { rows } = await observer.query<{ cic: number | null; holder: number | null }>(
    `SELECT (SELECT pid FROM pg_stat_activity WHERE query LIKE 'CREATE INDEX CONCURRENTLY messages_org_id_id_desc_idx%' AND datname = current_database() LIMIT 1) AS cic,
            (SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2 AND objsubid = 1 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS holder`,
    [MIGRATION_LOCK_IDENTITY.classid, MIGRATION_LOCK_IDENTITY.objid],
  );
  const r = rows[0];
  return r?.cic && r.holder ? { cic: Number(r.cic), holder: Number(r.holder) } : undefined;
}
/** Holds a ROW EXCLUSIVE lock on messages in an open transaction, so a concurrent index build waits. */
async function blockConcurrentBuild(db: string): Promise<Client> {
  const blocker = await clientFor(db, 'acc-u141a-blocker');
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE public.messages IN ROW EXCLUSIVE MODE');
  return blocker;
}
/** Leaves an INVALID exact-definition index: start a build, cancel it while it waits. */
async function makeInvalidIndex(db: string): Promise<void> {
  const blocker = await blockConcurrentBuild(db);
  const pool = poolFor(db);
  const c = await pool.connect();
  try {
    await acquireMigrationLock(c);
    const build = ensureMessagesOrgIdIdDescIndex(c).catch((e: unknown) => e);
    const observer = await clientFor(db);
    const pids = await waitFor('the concurrent build', () => cicAndLockHolder(observer));
    await observer.query('SELECT pg_cancel_backend($1)', [pids.cic]);
    await observer.end();
    const error = await build;
    expect(String(error)).toMatch(/concurrent index build failed/);
    await releaseMigrationLock(c);
  } finally {
    c.release(true);
    await blocker.query('ROLLBACK');
    await blocker.end();
  }
  expect((await indexState(db)).state.kind).toBe('invalid');
}

let base41: string;
let base24: string;

beforeAll(async () => {
  admin = new Client({ connectionString: adminUrl, application_name: 'acc-u141a-admin' });
  await admin.connect();
  base41 = await createDb();
  await applyFirst(base41, GUARD_AT); // 0000…0041
  base24 = await createDb();
  await applyFirst(base24, 25); // 0000…0024, like acc_r015_base
});

afterAll(async () => {
  for (const p of pools) await p.end().catch(() => undefined);
  for (const name of created.reverse()) {
    if (!name.startsWith(PREFIX) || !NAME.test(name)) continue;
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
  await admin.end();
});

describe('U14.1a — one db:migrate for every starting point', () => {
  it('fresh database (CI): reaches 0042 with the exact index; a rerun is a no-op that still verifies the index', async () => {
    const db = await createDb();
    const r1 = await migrateSchema(poolFor(db), FOLDER);
    expect(r1.pending).toHaveLength(expected.length);
    expect(r1.barriers).toEqual([
      { tag: '0042_messages_org_id_id_desc_guard', result: 'created' },
      { tag: '0043_messages_org_id_created_at_guard', result: 'created' }, // U14.1b, the next barrier
    ]);
    expect(await history(db)).toBe(expected.length);
    const s = await indexState(db);
    expect(s.state).toEqual({ kind: 'exact' });
    expect(s.def).toBe(MESSAGES_ORG_ID_ID_DESC.definition);
    const r2 = await migrateSchema(poolFor(db), FOLDER);
    expect([r2.pending.length, r2.barriers.length]).toEqual([0, 0]);
  });

  it('template clone at 0024: applies 0024…0041, builds the index, records 0042', async () => {
    const db = await createDb(base24);
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.applied).toBe(25);
    expect(r.barriers[0]?.result).toBe('created');
    expect(await history(db)).toBe(expected.length);
  });

  it('existing database at 0041: builds the index and records 0042', async () => {
    const db = await createDb(base41);
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect([r.applied, r.barriers[0]?.result]).toEqual([GUARD_AT, 'created']);
    expect(await history(db)).toBe(expected.length);
  });

  it('existing database at 0041 where the exact index already exists: accepted, 0042 recorded', async () => {
    const db = await createDb(base41);
    await sql(
      db,
      'CREATE INDEX CONCURRENTLY messages_org_id_id_desc_idx ON public.messages USING btree (org_id, id DESC)',
    );
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers[0]?.result).toBe('present');
    expect(await history(db)).toBe(expected.length);
  });

  it('messages_org_id_idx is preserved', async () => {
    const db = await createDb(base41);
    await migrateSchema(poolFor(db), FOLDER);
    const c = await clientFor(db);
    const { rows } = await c.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='messages_org_id_idx'`,
    );
    await c.end();
    expect(rows).toEqual([
      { indexdef: 'CREATE INDEX messages_org_id_idx ON public.messages USING btree (org_id)' },
    ]);
  });
});

describe('U14.1a — catalogue discrepancies refuse; nothing is dropped; the journal does not advance', () => {
  it.each([
    ['ascending id', 'CREATE INDEX messages_org_id_id_desc_idx ON public.messages (org_id, id)'],
    [
      'reversed columns',
      'CREATE INDEX messages_org_id_id_desc_idx ON public.messages (id DESC, org_id)',
    ],
    [
      'unique',
      'CREATE UNIQUE INDEX messages_org_id_id_desc_idx ON public.messages (org_id, id DESC)',
    ],
    [
      'partial',
      `CREATE INDEX messages_org_id_id_desc_idx ON public.messages (org_id, id DESC) WHERE status = 'failed'`,
    ],
    [
      'include column',
      'CREATE INDEX messages_org_id_id_desc_idx ON public.messages (org_id, id DESC) INCLUDE (status)',
    ],
    [
      'hash method',
      'CREATE INDEX messages_org_id_id_desc_idx ON public.messages USING hash (org_id)',
    ],
    [
      'NULLS LAST',
      'CREATE INDEX messages_org_id_id_desc_idx ON public.messages (org_id, id DESC NULLS LAST)',
    ],
  ])('%s under the expected name → refused', async (_label, ddl) => {
    const db = await createDb(base41);
    await sql(db, ddl);
    const before = await indexState(db);
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /does not match the expected definition/,
    );
    expect(await history(db)).toBe(GUARD_AT);
    expect(await indexState(db)).toEqual(before); // same OID: nothing dropped or rebuilt
  });

  it('an equivalent index under another name → refused, not adopted', async () => {
    const db = await createDb(base41);
    await sql(db, 'CREATE INDEX messages_tenant_newest_idx ON public.messages (org_id, id DESC)');
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /same definition under another name \(messages_tenant_newest_idx\)/,
    );
    expect(await history(db)).toBe(GUARD_AT);
  });

  it('the name taken by a table → refused', async () => {
    const db = await createDb(base41);
    await sql(db, 'CREATE TABLE public.messages_org_id_id_desc_idx (x int)');
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(/is not an index/);
    expect(await history(db)).toBe(GUARD_AT);
  });
});

describe('U14.1a — the 0042 guard fails closed when the barrier is bypassed', () => {
  it('plain drizzle on a 0041 database: guard raises, 0042 not recorded', async () => {
    const db = await createDb(base41);
    expect(await serverError(applyFirst(db, expected.length))).toMatch(
      /^U14\.1a guard: index public\.messages_org_id_id_desc_idx is absent/,
    );
    expect(await history(db)).toBe(GUARD_AT);
  });

  it('plain drizzle on a 0024 database: the whole batch rolls back (why the barrier exists)', async () => {
    const db = await createDb(base24);
    expect(await serverError(applyFirst(db, expected.length))).toMatch(
      /^U14\.1a guard: index public\.messages_org_id_id_desc_idx is absent/,
    );
    expect(await history(db)).toBe(25);
  });

  it('plain drizzle with a wrong-definition index: guard raises', async () => {
    const db = await createDb(base41);
    await sql(db, 'CREATE INDEX messages_org_id_id_desc_idx ON public.messages (org_id, id)');
    expect(await serverError(applyFirst(db, expected.length))).toMatch(
      /^U14\.1a guard: public\.messages_org_id_id_desc_idx is not as required: .*sort options are not \(org_id ASC, id DESC\)/,
    );
    expect(await history(db)).toBe(GUARD_AT);
  });

  it('plain drizzle with an INVALID index: guard raises', async () => {
    const db = await createDb(base41);
    await makeInvalidIndex(db);
    expect(await serverError(applyFirst(db, expected.length))).toMatch(
      /^U14\.1a guard: public\.messages_org_id_id_desc_idx is not as required: .*not usable \(indisvalid=f/,
    );
    expect(await history(db)).toBe(GUARD_AT);
  });
});

describe('U14.1a — interruption at every significant point; reruns converge', () => {
  it.each<[string, Checkpoint, number, string]>([
    ['before the concurrent build (after the prefix)', 'before-barrier', 25, 'absent'],
    ['after the build, before 0042', 'after-barrier', 25, 'exact'],
  ])('interrupted %s', async (_label, point, startAt, indexAfter) => {
    const db = await createDb(startAt === 25 ? base24 : base41);
    await expect(
      migrateSchema(poolFor(db), FOLDER, {
        checkpoint: async (p, tag) => {
          if (p === point && tag === '0042_messages_org_id_id_desc_guard') {
            throw new Error(`interrupted at ${p}`);
          }
        },
      }),
    ).rejects.toThrow('interrupted');
    expect(await history(db)).toBe(GUARD_AT);
    expect((await indexState(db)).state.kind).toBe(indexAfter);
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers[0]?.result).toBe(indexAfter === 'exact' ? 'present' : 'created');
    expect(await history(db)).toBe(expected.length);
  });

  it('interrupted during the concurrent build (cancelled while it waits): INVALID index, journal not advanced, the same session holds the lock; refuse → --recover-invalid → db:migrate', async () => {
    const db = await createDb(base41);
    const blocker = await blockConcurrentBuild(db);
    const run = migrateSchema(poolFor(db), FOLDER).catch((e: unknown) => e);
    const observer = await clientFor(db);
    const pids = await waitFor('the concurrent build', () => cicAndLockHolder(observer));
    expect(pids.cic).toBe(pids.holder); // CREATE INDEX CONCURRENTLY runs on the session that holds the migration lock
    await observer.query('SELECT pg_cancel_backend($1)', [pids.cic]);
    const error = await run;
    await blocker.query('ROLLBACK');
    await blocker.end();
    expect(String(error)).toMatch(/concurrent index build failed.*not usable/);
    expect(await history(db)).toBe(GUARD_AT);
    expect((await indexState(db)).state.kind).toBe('invalid');
    // the lock was released (the run ended): nobody holds it now
    expect(await lockHolders(observer)).toEqual([]);
    await observer.end();
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /interrupted concurrent build.*--recover-invalid/,
    );
    expect(await history(db)).toBe(GUARD_AT);
    const check = await runIndexRunner(poolFor(db), 'check');
    expect(check.ok).toBe(false);
    await expect(runIndexRunner(poolFor(db), 'ensure')).rejects.toThrow(/--recover-invalid/);
    const rec = await runIndexRunner(poolFor(db), 'recover-invalid');
    expect(rec).toEqual({
      ok: true,
      summary: 'messages_org_id_id_desc_idx: recovered, exact and valid',
    });
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers[0]?.result).toBe('present');
    expect(await history(db)).toBe(expected.length);
  });

  it('build lock_timeout expiry also leaves an INVALID index and no journal advance', async () => {
    const db = await createDb(base41);
    const blocker = await blockConcurrentBuild(db);
    const pool = poolFor(db);
    const c = await pool.connect();
    try {
      await acquireMigrationLock(c);
      await expect(ensureMessagesOrgIdIdDescIndex(c, { buildLockTimeoutMs: 500 })).rejects.toThrow(
        /lock timeout|concurrent index build failed/,
      );
      await releaseMigrationLock(c);
    } finally {
      c.release(true);
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
    expect((await indexState(db)).state.kind).toBe('invalid');
    expect(await history(db)).toBe(GUARD_AT);
  });

  it('interrupted during 0042 (between the guard and the history row; backend terminated): rolled back, then a rerun records it', async () => {
    const db = await createDb(base41);
    let holderClient: Client | undefined;
    const run = migrateSchema(poolFor(db), FOLDER, {
      checkpoint: async (p, tag) => {
        // Since U14.1b, 0042 is applied as the prefix of the next barrier (0043): block exactly there.
        if (p !== 'before-prefix' || tag !== '0043_messages_org_id_created_at_guard') return;
        // SHARE blocks drizzle's INSERT into the history (after the guard ran) but not its SELECT.
        holderClient = await clientFor(db, 'acc-u141a-history-lock');
        await holderClient.query('BEGIN');
        await holderClient.query('LOCK TABLE drizzle.__drizzle_migrations IN SHARE MODE');
      },
    }).catch((e: unknown) => e);
    const observer = await clientFor(db);
    const blocked = await waitFor('the blocked history insert', async () => {
      const { rows } = await observer.query<{ pid: number }>(
        `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
          WHERE a.datname = current_database() AND l.locktype = 'advisory' AND l.granted
            AND l.classid = $1 AND l.objid = $2 AND a.wait_event_type = 'Lock' AND a.query ILIKE 'insert into%__drizzle_migrations%'`,
        [MIGRATION_LOCK_IDENTITY.classid, MIGRATION_LOCK_IDENTITY.objid],
      );
      return rows[0]?.pid;
    });
    // The drizzle transaction is on the lock-holding session; terminate it mid-0042.
    await observer.query('SELECT pg_terminate_backend($1)', [blocked]);
    const error = await run;
    expect(error).toBeInstanceOf(Error);
    await holderClient!.query('ROLLBACK');
    await waitFor('the terminated session to release the lock', async () =>
      (await lockHolders(observer)).length === 0 ? true : undefined,
    );
    expect(await history(db)).toBe(GUARD_AT);
    expect((await indexState(db)).state.kind).toBe('exact');
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers[0]?.result).toBe('present');
    expect(await history(db)).toBe(expected.length);
  });

  it('after 0042: the journal is not proof — a dropped index makes db:migrate exit non-zero; the runner recreates it', async () => {
    const db = await createDb(base41);
    await migrateSchema(poolFor(db), FOLDER);
    await sql(db, 'DROP INDEX public.messages_org_id_id_desc_idx');
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /0042_messages_org_id_id_desc_guard is recorded, but the index is not as required.*absent/,
    );
    expect((await runIndexRunner(poolFor(db), 'check')).ok).toBe(false);
    expect((await runIndexRunner(poolFor(db), 'ensure')).summary).toBe(
      'messages_org_id_id_desc_idx: created, exact and valid',
    );
    await expect(migrateSchema(poolFor(db), FOLDER)).resolves.toMatchObject({ pending: [] });
  });

  it('after 0042: an INVALID index makes db:migrate exit non-zero; only --recover-invalid repairs it', async () => {
    const db = await createDb(base41);
    await migrateSchema(poolFor(db), FOLDER);
    await sql(db, 'DROP INDEX public.messages_org_id_id_desc_idx');
    await makeInvalidIndex(db);
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /recorded, but the index is not as required.*not usable/,
    );
    await expect(runIndexRunner(poolFor(db), 'ensure')).rejects.toThrow(/--recover-invalid/);
    await runIndexRunner(poolFor(db), 'recover-invalid');
    await expect(migrateSchema(poolFor(db), FOLDER)).resolves.toMatchObject({ pending: [] });
  });

  it.each<['missing' | 'invalid' | 'redefined', RegExp]>([
    ['missing', /recorded, but the index is not as required.*absent/],
    ['invalid', /recorded, but the index is not as required.*not usable/],
    ['redefined', /does not match the expected definition/],
  ])(
    'after 0042 with a LATER migration pending: a %s index stops db:migrate BEFORE the later migration; lock released; rerun after repair applies it',
    async (state, refusal) => {
      const fixture = migrationsWithFollowing();
      try {
        const db = await createDb(base41);
        await migrateSchema(poolFor(db), FOLDER); // 0000…0042 recorded, index exact
        await sql(db, 'DROP INDEX public.messages_org_id_id_desc_idx');
        if (state === 'invalid') await makeInvalidIndex(db);
        if (state === 'redefined') {
          await sql(db, 'CREATE INDEX messages_org_id_id_desc_idx ON public.messages (org_id, id)');
        }
        const probe = async () => {
          const c = await clientFor(db);
          const { rows } = await c.query<{ present: boolean }>(
            `SELECT to_regclass('${FOLLOWING_PROBE}') IS NOT NULL AS present`,
          );
          return rows[0]!.present;
        };

        // The test-only migration after 0042 is pending; the recorded barrier no longer holds.
        await expect(migrateSchema(poolFor(db), fixture.folder)).rejects.toThrow(refusal);
        expect(await history(db)).toBe(expected.length); // nothing after 0042 was recorded …
        expect(await probe()).toBe(false); // … or executed
        expect(await lockHolders(await clientFor(db))).toEqual([]); // the lock was released

        // Repair through the supported path, then the same db:migrate applies the later migration.
        if (state === 'redefined') {
          await expect(runIndexRunner(poolFor(db), 'recover-invalid')).rejects.toThrow(
            /Nothing was dropped/,
          );
          await sql(db, 'DROP INDEX public.messages_org_id_id_desc_idx'); // operator decision
          await runIndexRunner(poolFor(db), 'ensure');
        } else if (state === 'invalid') {
          await runIndexRunner(poolFor(db), 'recover-invalid');
        } else {
          await runIndexRunner(poolFor(db), 'ensure');
        }
        const r = await migrateSchema(poolFor(db), fixture.folder);
        expect(r.pending.map((m) => m.tag)).toEqual([FOLLOWING_TAG]);
        expect(await history(db)).toBe(expected.length + 1);
        expect(await probe()).toBe(true);
        expect((await indexState(db)).state.kind).toBe('exact');
      } finally {
        fixture.cleanup();
      }
    },
  );

  it('after 0042: a redefined index makes db:migrate exit non-zero and the runner refuses to touch it', async () => {
    const db = await createDb(base41);
    await migrateSchema(poolFor(db), FOLDER);
    await sql(db, 'DROP INDEX public.messages_org_id_id_desc_idx');
    await sql(db, 'CREATE INDEX messages_org_id_id_desc_idx ON public.messages (org_id, id)');
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /does not match the expected definition/,
    );
    await expect(runIndexRunner(poolFor(db), 'recover-invalid')).rejects.toThrow(
      /Nothing was dropped/,
    );
    expect((await indexState(db)).def).toBe(
      'CREATE INDEX messages_org_id_id_desc_idx ON public.messages USING btree (org_id, id)',
    );
  });
});

describe('U14.1a — --recover-invalid drops only the verified invalid target', () => {
  it('never drops a valid index (no-op, same OID) and reruns safely', async () => {
    const db = await createDb(base41);
    await migrateSchema(poolFor(db), FOLDER);
    const before = await indexState(db);
    expect((await runIndexRunner(poolFor(db), 'recover-invalid')).summary).toBe(
      'messages_org_id_id_desc_idx: present, exact and valid',
    );
    expect(await indexState(db)).toEqual(before);
    expect(before.oid).not.toBeNull();
    await runIndexRunner(poolFor(db), 'recover-invalid');
    expect(await indexState(db)).toEqual(before);
  });

  it('refuses an invalid index of a DIFFERENT definition (invalid unique build); nothing dropped', async () => {
    const db = await createDb(base41);
    const blocker = await blockConcurrentBuild(db);
    const c = await clientFor(db, 'acc-u141a-manual-build');
    const build = c
      .query(
        'CREATE UNIQUE INDEX CONCURRENTLY messages_org_id_id_desc_idx ON public.messages (org_id, id DESC)',
      )
      .catch((e: unknown) => e);
    const observer = await clientFor(db);
    const pid = await waitFor('the manual build', async () => {
      const { rows } = await observer.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE query LIKE 'CREATE UNIQUE INDEX CONCURRENTLY%' AND datname = current_database()`,
      );
      return rows[0]?.pid;
    });
    await observer.query('SELECT pg_cancel_backend($1)', [pid]);
    await build;
    await c.end();
    await observer.end();
    await blocker.query('ROLLBACK');
    await blocker.end();
    const before = await indexState(db);
    expect(before.state.kind).toBe('mismatch');
    await expect(runIndexRunner(poolFor(db), 'recover-invalid')).rejects.toThrow(
      /UNIQUE.*Nothing was dropped/,
    );
    expect(await indexState(db)).toEqual(before); // same OID
  });

  it('refuses while another session is building an index on messages', async () => {
    const db = await createDb(base41);
    await makeInvalidIndex(db);
    const blocker = await blockConcurrentBuild(db);
    const other = await clientFor(db, 'acc-u141a-other-build');
    const otherBuild = other
      .query('CREATE INDEX CONCURRENTLY messages_unrelated_tmp_idx ON public.messages (status)')
      .catch((e: unknown) => e);
    const observer = await clientFor(db);
    await waitFor('the other build', async () => {
      const { rows } = await observer.query(
        `SELECT 1 FROM pg_stat_progress_create_index p JOIN pg_class c ON c.oid = p.relid WHERE c.relname = 'messages'`,
      );
      return rows[0] ? true : undefined;
    });
    const before = await indexState(db);
    await expect(runIndexRunner(poolFor(db), 'recover-invalid')).rejects.toThrow(
      /in progress in another session/,
    );
    expect(before.state.kind).toBe('invalid');
    expect(await indexState(db)).toEqual(before); // same OID
    await observer.query(
      `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = 'acc-u141a-other-build'`,
    );
    await otherBuild;
    await other.end();
    await observer.end();
    await blocker.query('ROLLBACK');
    await blocker.end();
  });

  it('the runner refuses on a database whose history predates public.messages', async () => {
    const db = await createDb(base24); // history 0000…0024: public.messages does not exist yet
    const empty = await createDb(); // no history at all
    for (const target of [db, empty]) {
      for (const mode of ['check', 'ensure', 'recover-invalid'] as const) {
        await expect(runIndexRunner(poolFor(target), mode)).rejects.toThrow(
          /public\.messages is created by 0033/,
        );
      }
    }
    expect(await history(db)).toBe(25);
  });

  it('catalogue verification does not depend on search_path (pg_get_indexdef always qualifies the table)', async () => {
    const db = await createDb(base41);
    await migrateSchema(poolFor(db), FOLDER);
    const c = await clientFor(db);
    for (const path of ['public', '"$user", public', 'pg_catalog', 'pg_catalog, public']) {
      await c.query(`SET search_path = ${path}`);
      const snapshot = await readIndexCatalogue(c);
      expect(snapshot.target?.definition).toBe(MESSAGES_ORG_ID_ID_DESC.definition);
      expect(classifyIndex(snapshot)).toEqual({ kind: 'exact' });
    }
  });
});

describe('U14.1a — serialization: one migrator at a time, bounded wait', () => {
  it('a second db:migrate refuses after the bounded wait, naming the holder; the first completes', async () => {
    const db = await createDb(base41);
    const blocker = await blockConcurrentBuild(db);
    const first = migrateSchema(poolFor(db), FOLDER);
    const observer = await clientFor(db);
    const pids = await waitFor('the first run to build', () => cicAndLockHolder(observer));
    const second = await migrateSchema(poolFor(db), FOLDER, {
      lock: { waitMs: 1_000, intervalMs: 200 },
    }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(MigrationLockError);
    expect(String(second)).toContain(`held by pid ${pids.holder}`);
    // and the runner is excluded by the same lock
    await expect(runIndexRunner(poolFor(db), 'check', { lockWaitMs: 500 })).rejects.toBeInstanceOf(
      MigrationLockError,
    );
    await blocker.query('ROLLBACK');
    await blocker.end();
    await observer.end();
    await expect(first).resolves.toMatchObject({
      barriers: [{ result: 'created' }, { result: 'created' }],
    });
    expect(await history(db)).toBe(expected.length);
  });
});
