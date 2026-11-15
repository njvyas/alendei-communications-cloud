/**
 * Phase 8B PR 8B-3a — K1, the one-message-per-campaign-recipient UNIQUE index on `messages`,
 * through the fourth db:migrate barrier, the 0069 guard and the concurrent-index runner, against
 * real PostgreSQL (owner acceptance condition 1). Every scenario runs in its own throwaway
 * database (`acc_tmp_p8b3ix_<run>_<n>`, created on the test clone's cluster and dropped at the
 * end — only names matching this run's prefix).
 *
 * Proves:
 *   - one db:migrate from 0067 applies 0068, builds K1 CONCURRENTLY, records 0069; a rerun is a
 *     no-op that still verifies K1; an index built first by the runner is adopted;
 *   - the 0069 guard FAILS CLOSED when K1 is absent (plain drizzle), not unique, or differently
 *     defined: it raises, the transaction rolls back and 0069 is not recorded;
 *   - an interrupted concurrent build leaves an INVALID index that db:migrate and the runner
 *     refuse; only `--recover-invalid` repairs it (drop CONCURRENTLY, rebuild, verify); then
 *     db:migrate completes;
 *   - a recorded 0069 whose index drifted stops db:migrate;
 *   - the runner refuses on a history before 0068.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { Client, Pool } from 'pg';

import { runCampaignRecipientIndexRunner } from '../cli/index-messages-campaign-recipient';
import { loadExpectedMigrations } from '../cli/migration-history';
import { acquireMigrationLock, releaseMigrationLock } from '../cli/migration-lock';
import { migrateSchema, readAppliedMigrations } from '../cli/schema-migrate';
import {
  classifyIndexFor,
  ensureIndexFor,
  readIndexCatalogueFor,
} from '../maintenance/concurrent-index';
import { ensureMessageAttemptsDeliveryIndexes } from '../maintenance/message-attempts-delivery';
import { MESSAGES_CAMPAIGN_RECIPIENT_UQ } from '../maintenance/messages-campaign-recipient';
import { ensureMessagesOrgIdCreatedAtIndex } from '../maintenance/messages-org-id-created-at';
import { ensureMessagesOrgIdIdDescIndex } from '../maintenance/messages-org-id-id-desc';

jest.setTimeout(300_000);

const FOLDER = resolve(__dirname, '../../migrations');
const expected = loadExpectedMigrations(FOLDER);
const at = (tag: string) => expected.findIndex((m) => m.tag === tag);
const AT42 = at('0042_messages_org_id_id_desc_guard');
const AT44 = at('0044_phase5_0_delivery_foundation');
const AT45 = at('0045_message_attempts_delivery_indexes_guard');
const AT68 = at('0068_phase8b3_automation_identity_campaign_attribution');
const AT69 = at('0069_phase8b3_campaign_recipient_unique_guard');
const G69 = '0069_phase8b3_campaign_recipient_unique_guard';
const RUN = randomBytes(4).toString('hex');
const PREFIX = `acc_tmp_p8b3ix_${RUN}_`;
const NAME = /^acc_tmp_p8b3ix_[0-9a-f]{8}_[a-z0-9]+$/;
const adminUrl = process.env.DATABASE_ADMIN_URL!;
const SPEC = MESSAGES_CAMPAIGN_RECIPIENT_UQ;

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
async function clientFor(db: string, app = 'acc-p8b3ix-observer'): Promise<Client> {
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
/** Plain drizzle (no barrier): applies the first `n` migrations. */
async function applyFirst(db: string, n: number): Promise<void> {
  const c = await clientFor(db, 'acc-p8b3ix-setup');
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
async function stateOf(db: string) {
  const c = await clientFor(db);
  const s = await readIndexCatalogueFor(SPEC, c);
  const { rows } = await c.query<{ oid: string | null }>(`SELECT to_regclass($1)::oid AS oid`, [
    `public.${SPEC.name}`,
  ]);
  return { oid: rows[0]?.oid ?? null, kind: classifyIndexFor(SPEC, s).kind };
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
 * Leaves an INVALID exact-definition K1: start the concurrent build, wait until it has committed
 * its catalogue entry and is blocked on a held ROW EXCLUSIVE lock (cancelling earlier leaves no
 * index at all), then cancel it — an interrupted build.
 */
async function makeInvalidIndex(db: string): Promise<void> {
  const blocker = await clientFor(db, 'acc-p8b3ix-blocker');
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE public.messages IN ROW EXCLUSIVE MODE');
  const c = await poolFor(db).connect();
  try {
    await acquireMigrationLock(c);
    const build = ensureIndexFor(SPEC, c).catch((e: unknown) => e);
    const observer = await clientFor(db);
    const pid = await waitFor('the build to wait with an INVALID index', async () => {
      const { rows } = await observer.query<{
        pid: number | null;
        wait: string | null;
        valid: boolean | null;
      }>(
        `SELECT a.pid, a.wait_event_type AS wait,
                (SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = to_regclass('public.uq_messages_campaign_recipient')) AS valid
           FROM pg_stat_activity a
          WHERE a.query LIKE 'CREATE UNIQUE INDEX CONCURRENTLY uq_messages_campaign_recipient%' AND a.datname = current_database()
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
  expect((await stateOf(db)).kind).toBe('invalid');
}

let base67: string; // 0000…0067 with every earlier barrier index, exactly what db:migrate leaves at 0067
let base68: string; // + 0068 by plain drizzle: the K1 barrier has not run

beforeAll(async () => {
  admin = new Client({ connectionString: adminUrl, application_name: 'acc-p8b3ix-admin' });
  await admin.connect();
  base67 = await createDb();
  await applyFirst(base67, AT42);
  const setup = new Pool({ connectionString: urlFor(base67), max: 1 });
  const c = await setup.connect();
  try {
    await acquireMigrationLock(c);
    await ensureMessagesOrgIdIdDescIndex(c);
    await ensureMessagesOrgIdCreatedAtIndex(c);
    await releaseMigrationLock(c);
  } finally {
    c.release();
  }
  await applyFirst(base67, AT45); // 0042, 0043 guards pass; 0044 applied
  const c2 = await setup.connect();
  try {
    await acquireMigrationLock(c2);
    await ensureMessageAttemptsDeliveryIndexes(c2);
    await releaseMigrationLock(c2);
  } finally {
    c2.release();
    await setup.end();
  }
  await applyFirst(base67, AT68); // through 0067
  expect(await history(base67)).toBe(AT68);
  await closeClients();
  base68 = await createDb(base67);
  await applyFirst(base68, AT69); // 0068 by plain drizzle
  expect(await history(base68)).toBe(AT69);
  await closeClients();
  expect(AT44).toBeGreaterThan(0);
});

afterAll(async () => {
  for (const p of pools) await p.end().catch(() => undefined);
  for (const name of created.reverse()) {
    if (!name.startsWith(PREFIX) || !NAME.test(name)) continue;
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
  await admin.end();
});

describe('8B-3a K1 — one db:migrate from 0067', () => {
  it('0068 is the barrier prefix and 0069 the guard; 8B-3b adds 0070 after them', () => {
    expect([AT68, AT69, expected.length]).toEqual([68, 69, 71]);
  });

  it('from 0067: applies 0068, builds K1, records 0069; a rerun verifies and changes nothing', async () => {
    const db = await createDb(base67);
    const r1 = await migrateSchema(poolFor(db), FOLDER);
    expect(r1.barriers).toEqual([{ tag: G69, result: 'created' }]);
    expect(await history(db)).toBe(expected.length);
    const k1 = await stateOf(db);
    expect(k1.kind).toBe('exact');
    const r2 = await migrateSchema(poolFor(db), FOLDER);
    expect([r2.pending.length, r2.barriers.length]).toEqual([0, 0]);
    expect(await stateOf(db)).toEqual(k1);
    expect((await runCampaignRecipientIndexRunner(poolFor(db), 'check')).ok).toBe(true);
  });

  it('an index built first by the runner (after 0068) is adopted: present, same OID', async () => {
    const db = await createDb(base68);
    expect((await runCampaignRecipientIndexRunner(poolFor(db), 'ensure')).ok).toBe(true);
    const before = await stateOf(db);
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers).toEqual([{ tag: G69, result: 'present' }]);
    expect(await stateOf(db)).toEqual(before);
    expect(await history(db)).toBe(expected.length);
  });
});

describe('8B-3a K1 — the 0069 guard fails closed when the barrier is bypassed', () => {
  it('plain drizzle without K1: the guard raises, 0069 is not recorded', async () => {
    const db = await createDb(base68);
    expect(await serverError(applyFirst(db, AT69 + 1))).toMatch(
      /8B-3a guard: index public\.uq_messages_campaign_recipient is absent/,
    );
    expect(await history(db)).toBe(AT69);
  });

  it.each([
    [
      'a non-unique index under the name',
      'CREATE INDEX uq_messages_campaign_recipient ON public.messages (org_id, campaign_id, campaign_recipient_id) WHERE campaign_recipient_id IS NOT NULL',
      /is not UNIQUE/,
    ],
    [
      'a unique index that is not partial',
      'CREATE UNIQUE INDEX uq_messages_campaign_recipient ON public.messages (org_id, campaign_id, campaign_recipient_id)',
      /is not partial/,
    ],
    [
      'a unique index on different keys',
      'CREATE UNIQUE INDEX uq_messages_campaign_recipient ON public.messages (campaign_recipient_id) WHERE campaign_recipient_id IS NOT NULL',
      /key columns are not/,
    ],
    [
      'a unique index with another predicate',
      'CREATE UNIQUE INDEX uq_messages_campaign_recipient ON public.messages (org_id, campaign_id, campaign_recipient_id) WHERE campaign_id IS NOT NULL',
      /definition is/,
    ],
  ])('%s: the guard raises, 0069 is not recorded', async (_label, ddl, reason) => {
    const db = await createDb(base68);
    await (await clientFor(db)).query(ddl);
    const message = await serverError(applyFirst(db, AT69 + 1));
    expect(message).toMatch(
      /8B-3a guard: public\.uq_messages_campaign_recipient is not as required/,
    );
    expect(message).toMatch(reason);
    expect(await history(db)).toBe(AT69);
    // db:migrate refuses it too (a mismatch is never dropped or adopted).
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(/Refusing/);
    expect(await history(db)).toBe(AT69);
  });

  it('an equivalent index under another name: the barrier refuses, nothing adopted', async () => {
    const db = await createDb(base68);
    await (
      await clientFor(db)
    ).query(
      'CREATE UNIQUE INDEX some_other_name ON public.messages (org_id, campaign_id, campaign_recipient_id) WHERE campaign_recipient_id IS NOT NULL',
    );
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(/another name/);
    expect(await history(db)).toBe(AT69);
  });
});

describe('8B-3a K1 — interruption and recovery', () => {
  it('an interrupted concurrent build: db:migrate refuses; --recover-invalid repairs only that target; db:migrate completes', async () => {
    const db = await createDb(base68);
    await makeInvalidIndex(db);
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /not usable.*--recover-invalid/s,
    );
    expect(await history(db)).toBe(AT69);
    // The guard itself also refuses the invalid index if 0069 is applied around the barrier.
    expect(await serverError(applyFirst(db, AT69 + 1))).toMatch(/not usable.*recover-invalid/s);
    expect(await history(db)).toBe(AT69);
    expect((await runCampaignRecipientIndexRunner(poolFor(db), 'check')).ok).toBe(false);
    await expect(runCampaignRecipientIndexRunner(poolFor(db), 'ensure')).rejects.toThrow(
      /Refusing:.*not usable/,
    );
    const recovered = await runCampaignRecipientIndexRunner(poolFor(db), 'recover-invalid');
    expect(recovered.summary).toMatch(/uq_messages_campaign_recipient: recovered, exact and valid/);
    const r = await migrateSchema(poolFor(db), FOLDER);
    expect(r.barriers).toEqual([{ tag: G69, result: 'present' }]);
    expect(await history(db)).toBe(expected.length);
    expect((await stateOf(db)).kind).toBe('exact');
  });

  it('a recorded 0069 whose index drifted stops db:migrate before anything else is applied', async () => {
    const db = await createDb(base67);
    await migrateSchema(poolFor(db), FOLDER);
    await (await clientFor(db)).query('DROP INDEX public.uq_messages_campaign_recipient');
    await expect(migrateSchema(poolFor(db), FOLDER)).rejects.toThrow(
      /0069_phase8b3_campaign_recipient_unique_guard is recorded, but the index is not as required.*absent/s,
    );
  });

  it('the runner refuses, in every mode, on a history before 0068', async () => {
    const db = await createDb(base67);
    for (const mode of ['check', 'ensure', 'recover-invalid'] as const) {
      await expect(runCampaignRecipientIndexRunner(poolFor(db), mode)).rejects.toThrow(
        /needs 0068_phase8b3_automation_identity_campaign_attribution/,
      );
    }
  });
});
