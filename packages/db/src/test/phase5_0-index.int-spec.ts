/**
 * Phase 5.0 (PR-A, M2) — the two UNIQUE indexes on `public.message_attempts` through the
 * third db:migrate barrier, the 0045 guard, 0046 (constraint attach + composite FK) and the
 * concurrent-index runner, against real PostgreSQL. Every scenario runs in its own throwaway
 * database (`acc_tmp_p50ix_<run>_<n>`, created on the test clone's cluster and dropped at the
 * end — only names matching this run's prefix).
 *
 * Proves (acceptance criteria AC-MG-2, AC-GR-2):
 *   - one db:migrate from 0043 applies 0044, builds both indexes CONCURRENTLY, records 0045 and
 *     0046; a rerun is a no-op that still verifies the indexes (with 0046's constraints attached);
 *   - indexes built first by the runner are adopted (same OIDs);
 *   - the 0045 guard fails closed when the barrier is bypassed (plain drizzle);
 *   - an interrupted concurrent build leaves an INVALID index that db:migrate refuses; only
 *     `--recover-invalid` repairs it; then db:migrate completes;
 *   - a recorded 0045 whose index drifted stops db:migrate;
 *   - the runner refuses on a history before 0044;
 *   - M1 applies on a cluster where acc_delivery does not yet exist (its grants follow the
 *     CREATE ROLE in the same migration) — exercised implicitly whenever the role is absent.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { Client, Pool } from 'pg';

import { runDeliveryIndexRunner } from '../cli/index-message-attempts-delivery';
import { loadExpectedMigrations } from '../cli/migration-history';
import {
  MIGRATION_LOCK_IDENTITY,
  acquireMigrationLock,
  releaseMigrationLock,
} from '../cli/migration-lock';
import { migrateSchema, readAppliedMigrations } from '../cli/schema-migrate';
import {
  classifyIndexFor,
  readIndexCatalogueFor,
  ensureIndexFor,
} from '../maintenance/concurrent-index';
import {
  MESSAGE_ATTEMPTS_ID_MESSAGE_ID_UQ,
  MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ,
} from '../maintenance/message-attempts-delivery';
import { ensureMessagesOrgIdCreatedAtIndex } from '../maintenance/messages-org-id-created-at';
import { ensureMessagesOrgIdIdDescIndex } from '../maintenance/messages-org-id-id-desc';

jest.setTimeout(300_000);

const FOLDER = resolve(__dirname, '../../migrations');
const expected = loadExpectedMigrations(FOLDER);
const AT42 = expected.findIndex((m) => m.tag === '0042_messages_org_id_id_desc_guard');
const AT44 = expected.findIndex((m) => m.tag === '0044_phase5_0_delivery_foundation');
const AT45 = expected.findIndex((m) => m.tag === '0045_message_attempts_delivery_indexes_guard');
const G45 = '0045_message_attempts_delivery_indexes_guard';
const RUN = randomBytes(4).toString('hex');
const PREFIX = `acc_tmp_p50ix_${RUN}_`;
const NAME = /^acc_tmp_p50ix_[0-9a-f]{8}_[a-z0-9]+$/;
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
async function clientFor(db: string, app = 'acc-p50ix-observer'): Promise<Client> {
  const c = new Client({ connectionString: urlFor(db), application_name: app });
  c.on('error', () => undefined);
  await c.connect();
  openClients.push(c);
  return c;
}
async function closeClients(): Promise<void> {
  const clients = openClients.splice(0);
  await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
}
afterEach(closeClients);
async function serverError(attempt: Promise<unknown>): Promise<string> {
  const e = (await attempt.then(
    () => undefined,
    (error: unknown) => error,
  )) as { cause?: { message?: string } } | undefined;
  if (!e) throw new Error('expected the statement to fail');
  return e.cause?.message ?? '(no server error)';
}
async function applyFirst(db: string, n: number): Promise<void> {
  const c = await clientFor(db, 'acc-p50ix-setup');
  const files: MigrationMeta[] = readMigrationFiles({ migrationsFolder: FOLDER }).slice(0, n);
  const d = drizzle(c) as unknown as {
    dialect: {
      migrate(m: MigrationMeta[], s: unknown, c: { migrationsFolder: string }): Promise<void>;
    };
    session: unknown;
  };
  await d.dialect.migrate(files, d.session, { migrationsFolder: FOLDER });
}
async function history(db: string): Promise<number> {
  return (await readAppliedMigrations(await clientFor(db))).length;
}
type Spec = typeof MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ | typeof MESSAGE_ATTEMPTS_ID_MESSAGE_ID_UQ;
async function stateOf(db: string, spec: Spec) {
  const c = await clientFor(db);
  const s = await readIndexCatalogueFor(spec, c);
  const { rows } = await c.query<{ oid: string | null }>(`SELECT to_regclass($1)::oid AS oid`, [
    `public.${spec.name}`,
  ]);
  return { oid: rows[0]?.oid ?? null, kind: classifyIndexFor(spec, s).kind };
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

/**
 * Leaves an INVALID exact-definition provider-message index: start the build, wait until the
 * build has committed its catalogue entry and is blocked on the blocker (the PR #75 lesson:
 * cancelling earlier leaves no index at all), then cancel it.
 */
async function makeInvalidProviderIndex(db: string): Promise<void> {
  const blocker = await clientFor(db, 'acc-p50ix-blocker');
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE public.message_attempts IN ROW EXCLUSIVE MODE');
  const c = await poolFor(db).connect();
  try {
    await acquireMigrationLock(c);
    const build = ensureIndexFor(MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ, c).catch((e: unknown) => e);
    const observer = await clientFor(db);
    const pid = await waitFor('the build to wait with an INVALID index', async () => {
      const { rows } = await observer.query<{
        pid: number | null;
        wait: string | null;
        valid: boolean | null;
      }>(
        `SELECT a.pid, a.wait_event_type AS wait,
                (SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = to_regclass('public.message_attempts_provider_message_uq')) AS valid
           FROM pg_stat_activity a
          WHERE a.query LIKE 'CREATE UNIQUE INDEX CONCURRENTLY message_attempts_provider_message_uq%' AND a.datname = current_database()
          LIMIT 1`,
      );
      const r = rows[0];
      return r?.pid && r.valid === false && r.wait === 'Lock' ? Number(r.pid) : undefined;
    });
    await admin.query('SELECT pg_cancel_backend($1)', [pid]);
    expect(String(await build)).toMatch(/concurrent index build failed/);
    await releaseMigrationLock(c);
  } finally {
    c.release(true);
    await blocker.query('ROLLBACK');
  }
  expect((await stateOf(db, MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ)).kind).toBe('invalid');
}

let base43: string; // 0000…0043, exactly what U14.1b's db:migrate leaves
let base44: string; // + 0044 (M1) by plain drizzle: the barrier has not run

beforeAll(async () => {
  admin = new Client({ connectionString: adminUrl, application_name: 'acc-p50ix-admin' });
  await admin.connect();
  base43 = await createDb();
  await applyFirst(base43, AT42);
  const setup = new Pool({ connectionString: urlFor(base43), max: 1 });
  const c = await setup.connect();
  try {
    await acquireMigrationLock(c);
    await ensureMessagesOrgIdIdDescIndex(c);
    await ensureMessagesOrgIdCreatedAtIndex(c);
    await releaseMigrationLock(c);
  } finally {
    c.release();
    await setup.end();
  }
  await applyFirst(base43, AT44); // 0042 and 0043 guards pass: their indexes exist
  expect(await history(base43)).toBe(AT44);
  await closeClients();
  base44 = await createDb(base43);
  await applyFirst(base44, AT45); // 0044 by plain drizzle
  expect(await history(base44)).toBe(AT45);
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

describe('Phase 5.0 M2 — one db:migrate from 0043; the indexes, the guard and 0046', () => {
  it('0044 is the barrier prefix, 0045 the guard; 0046 and the forward fix 0047 follow', () => {
    expect([AT44, AT45, expected.length]).toEqual([44, 45, 65]); // Phase 7: 0050, 0051; Phase 8B.1: 0052; Phase 7 PRs 7-4 to 7-6c: 0053–0057; Phase 8A.1: 0058; Phase 7 PRs 7-6d-1, 7-6d-2: 0059, 0060; Phase 8A.2: 0061; Phase 8C PRs 8C-1 to 8C-3: 0062–0064
  });

  it('from 0043: applies 0044, builds both indexes, records 0045 and 0046; a rerun verifies and changes nothing', async () => {
    const db = await createDb(base43);
    const r1 = await migrateSchema(poolFor(db), FOLDER);
    expect(r1.barriers).toEqual([{ tag: G45, result: 'created' }]);
    expect(await history(db)).toBe(expected.length);
    const a = await stateOf(db, MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ);
    const b = await stateOf(db, MESSAGE_ATTEMPTS_ID_MESSAGE_ID_UQ);
    expect([a.kind, b.kind]).toEqual(['exact', 'exact']);
    const c = await clientFor(db);
    const { rows } = await c.query(
      `SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('uq_message_attempts_id_message_id','messages_delivered_attempt_fk') ORDER BY 1`,
    );
    expect(rows).toEqual([
      { conname: 'messages_delivered_attempt_fk', convalidated: true },
      { conname: 'uq_message_attempts_id_message_id', convalidated: true },
    ]);
    const r2 = await migrateSchema(poolFor(db), FOLDER);
    expect([r2.pending.length, r2.barriers.length]).toEqual([0, 0]);
    expect(await stateOf(db, MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ)).toEqual(a);
    expect(await stateOf(db, MESSAGE_ATTEMPTS_ID_MESSAGE_ID_UQ)).toEqual(b);
    expect((await runDeliveryIndexRunner(poolFor(db), 'check')).ok).toBe(true);
  });

  it('indexes built first by the runner (after 0044) are adopted: present, same OIDs', async () => {
    const db = await createDb(base44);
    expect((await runDeliveryIndexRunner(poolFor(db), 'ensure')).ok).toBe(true);
    const before = [
      await stateOf(db, MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ),
      await stateOf(db, MESSAGE_ATTEMPTS_ID_MESSAGE_ID_UQ),
    ];
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers).toEqual([{ tag: G45, result: 'present' }]);
    expect([
      await stateOf(db, MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ),
      await stateOf(db, MESSAGE_ATTEMPTS_ID_MESSAGE_ID_UQ),
    ]).toEqual(before);
    expect(await history(db)).toBe(expected.length);
  });
});

describe('Phase 5.0 M2 — the 0045 guard fails closed when the barrier is bypassed', () => {
  it('plain drizzle without the indexes: the guard raises, 0045 is not recorded', async () => {
    const db = await createDb(base44);
    expect(await serverError(applyFirst(db, AT45 + 1))).toMatch(
      /Phase 5\.0 guard: index public\.message_attempts_provider_message_uq is absent/,
    );
    expect(await history(db)).toBe(AT45);
  });

  it('a non-unique index under the name: the guard raises', async () => {
    const db = await createDb(base44);
    await (
      await clientFor(db)
    ).query(
      'CREATE INDEX message_attempts_provider_message_uq ON public.message_attempts (provider_id, provider_message_id) WHERE provider_message_id IS NOT NULL',
    );
    await (
      await clientFor(db)
    ).query(
      'CREATE UNIQUE INDEX uq_message_attempts_id_message_id ON public.message_attempts (id, message_id)',
    );
    expect(await serverError(applyFirst(db, AT45 + 1))).toMatch(/is not as required/);
    expect(await history(db)).toBe(AT45);
  });
});

describe('Phase 5.0 M2 — interruption and recovery', () => {
  it('an interrupted concurrent build: db:migrate refuses; --recover-invalid repairs only that target; db:migrate completes', async () => {
    const db = await createDb(base44);
    await makeInvalidProviderIndex(db);
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /not usable.*--recover-invalid/s,
    );
    expect(await history(db)).toBe(AT45);
    const check = await runDeliveryIndexRunner(poolFor(db), 'check');
    expect(check.ok).toBe(false);
    await expect(runDeliveryIndexRunner(poolFor(db), 'ensure')).rejects.toThrow(
      /Refusing:.*not usable/,
    );
    const recovered = await runDeliveryIndexRunner(poolFor(db), 'recover-invalid');
    expect(recovered.summary).toMatch(
      /message_attempts_provider_message_uq: recovered, exact and valid/,
    );
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers).toEqual([{ tag: G45, result: 'present' }]);
    expect(await history(db)).toBe(expected.length);
  });

  it('a recorded 0045 whose index drifted stops db:migrate before anything else is applied', async () => {
    const db = await createDb(base43);
    await migrateSchema(poolFor(db), FOLDER);
    await (await clientFor(db)).query('DROP INDEX public.message_attempts_provider_message_uq');
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /0045_message_attempts_delivery_indexes_guard is recorded, but the indexes are not as required.*absent/s,
    );
  });

  it('the runner refuses, in every mode, on a history before 0044', async () => {
    const db = await createDb(base43);
    for (const mode of ['check', 'ensure', 'recover-invalid'] as const) {
      await expect(runDeliveryIndexRunner(poolFor(db), mode)).rejects.toThrow(
        /public\.message_attempts \(for message_attempts_provider_message_uq\) needs 0044_phase5_0_delivery_foundation/,
      );
    }
  });

  it('holds the migration lock: a second runner cannot start while a migration holds it', async () => {
    const db = await createDb(base44);
    const holder = await poolFor(db).connect();
    try {
      await acquireMigrationLock(holder);
      await expect(
        runDeliveryIndexRunner(poolFor(db), 'check', { lockWaitMs: 300 }),
      ).rejects.toThrow(/migration lock/i);
    } finally {
      await releaseMigrationLock(holder);
      holder.release();
    }
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2`,
      [MIGRATION_LOCK_IDENTITY.classid, MIGRATION_LOCK_IDENTITY.objid],
    );
    expect(rows[0].n).toBe(0);
  });
});
