import { resolve } from 'node:path';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { ClientBase, Pool } from 'pg';

import { migrationsWithFollowing } from '../test/following-migration-fixture';
import { MigrationHistoryError, loadExpectedMigrations } from './migration-history';
import { MigrationLockError, acquireMigrationLock, lockWaitFromEnv } from './migration-lock';
import { migrateSchema, type Barrier, type Checkpoint } from './schema-migrate';

const REPO_MIGRATIONS = resolve(__dirname, '../../migrations');
const expected = loadExpectedMigrations(REPO_MIGRATIONS);
const GUARD = '0042_messages_org_id_id_desc_guard';
const guardAt = expected.findIndex((m) => m.tag === GUARD);

type Row = { id: number; hash: string; created_at: string };

/**
 * A pinned-client double: answers the lock, history and session statements, keeps
 * the history as state (the fake `apply` appends to it the way drizzle does), and
 * records every operation in order, so sequencing is asserted, not assumed.
 */
function fakeDatabase(initial: Row[] | null, opts: { lockFree?: boolean } = {}) {
  let history: Row[] | null = initial ? [...initial] : null;
  let lockHeld = false;
  const events: string[] = [];
  const statements: string[] = [];
  const released: Array<boolean | undefined> = [];
  const client = {
    query: jest.fn(async (text: string) => {
      statements.push(text);
      if (text.startsWith('SET client_connection_check_interval')) return { rows: [] };
      if (text.includes('pg_try_advisory_lock')) {
        const ok = opts.lockFree !== false;
        if (ok) lockHeld = true;
        events.push(ok ? 'lock' : 'lock-busy');
        return { rows: [{ ok }] };
      }
      if (text.includes('pg_advisory_unlock')) {
        events.push('unlock');
        const was = lockHeld;
        lockHeld = false;
        return { rows: [{ released: was }] };
      }
      if (text.includes('FROM pg_locks') && text.includes('pg_backend_pid()'))
        return { rows: [{ held: lockHeld }] };
      if (text.includes('FROM pg_locks')) return { rows: [] };
      if (text.includes('to_regclass')) return { rows: [{ present: history !== null }] };
      if (text.includes('FROM drizzle.__drizzle_migrations')) return { rows: history ?? [] };
      throw new Error(`unexpected statement: ${text}`);
    }),
    release: jest.fn((destroy?: boolean) => released.push(destroy)),
    on: jest.fn(),
    off: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client) } as unknown as Pool;
  /** drizzle semantics: apply the given migrations whose `when` is after the newest row. */
  const apply = jest.fn(async (_c: unknown, migrations: MigrationMeta[]) => {
    if (!lockHeld) throw new Error('apply without the lock');
    const rows = history ?? [];
    const last = rows[rows.length - 1];
    const fresh = migrations.filter((m) => !last || Number(last.created_at) < m.folderMillis);
    events.push(`apply:${fresh.length}`);
    history = [
      ...rows,
      ...fresh.map((m, i) => ({
        id: rows.length + i + 1,
        hash: m.hash,
        created_at: String(m.folderMillis),
      })),
    ];
  });
  return { pool, client, apply, events, statements, released, history: () => history };
}

const rowsFor = (upTo: number): Row[] =>
  expected.slice(0, upTo).map((m, i) => ({ id: i + 1, hash: m.hash, created_at: String(m.when) }));

function fakeBarrier(
  events: string[],
  behaviour: { prepare?: () => Promise<void>; verify?: () => Promise<void> } = {},
): Barrier {
  return {
    beforeTag: GUARD,
    label: 'fake-index',
    prepare: jest.fn(async (_client: ClientBase) => {
      events.push('barrier');
      await behaviour.prepare?.();
      return 'created' as const;
    }),
    verifyApplied: jest.fn(async () => {
      events.push('verify');
      await behaviour.verify?.();
    }),
  };
}

const ROLE_SQL = /\b(ALTER|CREATE|DROP)\s+(ROLE|USER)\b|\bPASSWORD\b|\bLOGIN\b/i;

describe('migrateSchema — schema only, verified first, one locked session', () => {
  it('the guard migration 0042 is in the committed journal', () => {
    expect(guardAt).toBe(42);
  });

  it('fresh database: prefix 0000…0041, then the barrier, then 0042, then the invariant — all under the lock', async () => {
    const db = fakeDatabase(null);
    const barrier = fakeBarrier(db.events);
    const result = await migrateSchema(db.pool, REPO_MIGRATIONS, {
      apply: db.apply,
      barriers: [barrier],
    });
    expect(db.events).toEqual([
      'lock',
      `apply:${guardAt}`,
      'barrier',
      `apply:${expected.length - guardAt}`,
      'verify',
      'unlock',
    ]);
    expect(result.pending).toHaveLength(expected.length);
    expect(db.history()).toHaveLength(expected.length);
    expect(db.pool.connect).toHaveBeenCalledTimes(1); // one pinned connection for the whole run
    expect(db.released).toEqual([undefined]);
    expect(db.statements.filter((s) => ROLE_SQL.test(s))).toEqual([]);
  });

  it('template at 0024: applies 0024…0041, the barrier, then the rest', async () => {
    const db = fakeDatabase(rowsFor(25));
    const barrier = fakeBarrier(db.events);
    await migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [barrier] });
    expect(db.events).toEqual([
      'lock',
      `apply:${guardAt - 25}`,
      'barrier',
      `apply:${expected.length - guardAt}`,
      'verify',
      'unlock',
    ]);
  });

  it('existing database at 0041: no prefix, the barrier, then 0042', async () => {
    const db = fakeDatabase(rowsFor(guardAt));
    const barrier = fakeBarrier(db.events);
    await migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [barrier] });
    expect(db.events).toEqual([
      'lock',
      'barrier',
      `apply:${expected.length - guardAt}`,
      'verify',
      'unlock',
    ]);
  });

  it('up to date: no apply, no build; the recorded barrier is verified up front (U-3) and again at the end', async () => {
    const db = fakeDatabase(rowsFor(expected.length));
    const barrier = fakeBarrier(db.events);
    await migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [barrier] });
    expect(db.events).toEqual(['lock', 'verify', 'verify', 'unlock']);
  });

  it('recorded barrier drifted and a LATER migration pending: refuses before applying anything (U-3, fail closed)', async () => {
    const fixture = migrationsWithFollowing();
    try {
      const db = fakeDatabase(rowsFor(expected.length)); // 0042 recorded; the fixture adds one after it
      const barrier = fakeBarrier(db.events, {
        verify: async () => {
          throw new Error('index missing');
        },
      });
      await expect(
        migrateSchema(db.pool, fixture.folder, { apply: db.apply, barriers: [barrier] }),
      ).rejects.toThrow('index missing');
      expect(db.apply).not.toHaveBeenCalled();
      expect(db.events).toEqual(['lock', 'verify', 'unlock']);
      expect(db.history()).toHaveLength(expected.length);
      expect(db.released).toEqual([true]);
    } finally {
      fixture.cleanup();
    }
  });

  it('recorded barrier holds and a later migration is pending: verify first, then apply, then verify again', async () => {
    const fixture = migrationsWithFollowing();
    try {
      const db = fakeDatabase(rowsFor(expected.length));
      const barrier = fakeBarrier(db.events);
      await migrateSchema(db.pool, fixture.folder, { apply: db.apply, barriers: [barrier] });
      expect(db.events).toEqual(['lock', 'verify', 'apply:1', 'verify', 'unlock']);
      expect(barrier.prepare).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it('up to date but the index drifted: exits with the barrier error, lock released, connection discarded', async () => {
    const db = fakeDatabase(rowsFor(expected.length));
    const barrier = fakeBarrier(db.events, {
      verify: async () => {
        throw new Error('index missing');
      },
    });
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [barrier] }),
    ).rejects.toThrow('index missing');
    expect(db.events).toEqual(['lock', 'verify', 'unlock']);
    expect(db.released).toEqual([true]);
  });

  it('a barrier refusal stops before 0042 is applied; the prefix stays committed', async () => {
    const db = fakeDatabase(rowsFor(25));
    const barrier = fakeBarrier(db.events, {
      prepare: async () => {
        throw new Error('refused');
      },
    });
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [barrier] }),
    ).rejects.toThrow('refused');
    expect(db.events).toEqual(['lock', `apply:${guardAt - 25}`, 'barrier', 'unlock']);
    expect(db.history()).toHaveLength(guardAt);
  });

  it.each<Checkpoint>(['after-prefix', 'before-barrier', 'after-barrier', 'before-remaining'])(
    'interruption at %s leaves a consistent state and a rerun completes',
    async (point) => {
      const db = fakeDatabase(rowsFor(25));
      const barrier = fakeBarrier(db.events);
      const boom = async (p: Checkpoint) => {
        if (p === point) throw new Error(`interrupted at ${p}`);
      };
      await expect(
        migrateSchema(db.pool, REPO_MIGRATIONS, {
          apply: db.apply,
          barriers: [barrier],
          checkpoint: boom,
        }),
      ).rejects.toThrow('interrupted');
      expect(db.events[db.events.length - 1]).toBe('unlock');
      expect(db.history()).toHaveLength(guardAt); // every checkpoint here is after the committed prefix
      // Rerun on the same state:
      const again = fakeDatabase(db.history());
      const barrier2 = fakeBarrier(again.events);
      await migrateSchema(again.pool, REPO_MIGRATIONS, {
        apply: again.apply,
        barriers: [barrier2],
      });
      expect(again.history()).toHaveLength(expected.length);
      expect(again.events).toContain('barrier');
      expect(again.events.slice(-2)).toEqual(['verify', 'unlock']);
    },
  );

  it('refuses when the lock is held elsewhere, after the bounded wait, without applying anything', async () => {
    const db = fakeDatabase(rowsFor(25), { lockFree: false });
    let clock = 0;
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, {
        apply: db.apply,
        barriers: [fakeBarrier(db.events)],
        lock: {
          waitMs: 1500,
          intervalMs: 500,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      }),
    ).rejects.toBeInstanceOf(MigrationLockError);
    expect(db.apply).not.toHaveBeenCalled();
    expect(db.events.filter((e) => e === 'lock-busy')).toHaveLength(4); // t = 0, 500, 1000, 1500
    expect(db.events).not.toContain('unlock');
    expect(db.released).toEqual([true]);
  });

  it('refuses, before anything is applied, when a recorded hash differs from the file', async () => {
    const rows = rowsFor(expected.length).map((r, i) =>
      i === 33 ? { ...r, hash: '914e'.padEnd(64, '0') } : r,
    );
    const db = fakeDatabase(rows);
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, {
        apply: db.apply,
        barriers: [fakeBarrier(db.events)],
      }),
    ).rejects.toBeInstanceOf(MigrationHistoryError);
    expect(db.apply).not.toHaveBeenCalled();
    expect(db.events).toEqual(['lock', 'unlock']);
  });

  it('refuses, before anything is applied, on an orphaned history row', async () => {
    const db = fakeDatabase([...rowsFor(3), { id: 4, hash: 'f'.repeat(64), created_at: '42' }]);
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, {
        apply: db.apply,
        barriers: [fakeBarrier(db.events)],
      }),
    ).rejects.toThrow('matches no journal entry');
    expect(db.apply).not.toHaveBeenCalled();
  });

  it('refuses if the prefix did not end exactly before the barrier', async () => {
    const db = fakeDatabase(rowsFor(25));
    const shortApply = jest.fn(async () => undefined); // records nothing
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, {
        apply: shortApply,
        barriers: [fakeBarrier(db.events)],
      }),
    ).rejects.toThrow(/next pending migration is/);
    expect(db.events).not.toContain('barrier');
  });
});

describe('two barriers (U14.1a 0042, U14.1b 0043) — journal order, one locked session', () => {
  const G43 = '0043_messages_org_id_created_at_guard';
  const at43 = expected.findIndex((m) => m.tag === G43);
  const barrierFor = (events: string[], tag: string, name: string): Barrier => ({
    beforeTag: tag,
    label: name,
    prepare: jest.fn(async () => {
      events.push(`barrier:${name}`);
      return 'created' as const;
    }),
    verifyApplied: jest.fn(async () => {
      events.push(`verify:${name}`);
    }),
  });

  // Pins 0043 as the newest migration at the time of U14.1b; update when a later migration is added.
  it('0043 directly follows 0042 in the committed journal', () => {
    expect(at43).toBe(guardAt + 1);
    expect(expected).toHaveLength(at43 + 1);
  });

  it.each<[string, Row[] | null, string[]]>([
    ['fresh database', null, [`apply:${guardAt}`, 'barrier:a', 'apply:1', 'barrier:b', 'apply:1']],
    ['database at 0041', rowsFor(guardAt), ['barrier:a', 'apply:1', 'barrier:b', 'apply:1']],
    [
      'database at 0042 (U14.1a applied)',
      rowsFor(guardAt + 1),
      ['verify:a', 'barrier:b', 'apply:1'],
    ],
    ['up to date', rowsFor(expected.length), ['verify:a', 'verify:b']],
  ])(
    '%s: each barrier runs right before its own guard; given out of order, still journal order',
    async (_label, rows, middle) => {
      const db = fakeDatabase(rows);
      const a = barrierFor(db.events, GUARD, 'a');
      const b = barrierFor(db.events, G43, 'b');
      await migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [b, a] });
      expect(db.events).toEqual(['lock', ...middle, 'verify:a', 'verify:b', 'unlock']);
      expect(db.history()).toHaveLength(expected.length);
      expect(db.pool.connect).toHaveBeenCalledTimes(1);
    },
  );

  it('a refusal at the 0043 barrier leaves 0042 recorded and 0043 not recorded', async () => {
    const db = fakeDatabase(rowsFor(guardAt));
    const a = barrierFor(db.events, GUARD, 'a');
    const b = barrierFor(db.events, G43, 'b');
    (b.prepare as jest.Mock).mockImplementation(async () => {
      db.events.push('barrier:b');
      throw new Error('refused b');
    });
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [a, b] }),
    ).rejects.toThrow('refused b');
    expect(db.events).toEqual(['lock', 'barrier:a', 'apply:1', 'barrier:b', 'unlock']);
    expect(db.history()).toHaveLength(guardAt + 1);
  });

  it('with 0042 recorded, a drifted U14.1a index stops the run before the 0043 barrier', async () => {
    const db = fakeDatabase(rowsFor(guardAt + 1));
    const a = barrierFor(db.events, GUARD, 'a');
    (a.verifyApplied as jest.Mock).mockRejectedValue(new Error('0042 index missing'));
    const b = barrierFor(db.events, G43, 'b');
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [a, b] }),
    ).rejects.toThrow('0042 index missing');
    expect(b.prepare).not.toHaveBeenCalled();
    expect(db.apply).not.toHaveBeenCalled();
  });
});

describe('migration lock wait is always bounded (U-2)', () => {
  it('ACC_MIGRATION_LOCK_WAIT_MS: unset means the default; only a non-negative integer is accepted', () => {
    expect(lockWaitFromEnv(undefined)).toBeUndefined();
    expect(lockWaitFromEnv('')).toBeUndefined();
    expect(lockWaitFromEnv('0')).toBe(0);
    expect(lockWaitFromEnv('45000')).toBe(45000);
    for (const bad of ['10s', 'none', '-1', '1.5', ' 5', 'NaN', 'Infinity', '1e3']) {
      expect(() => lockWaitFromEnv(bad)).toThrow(MigrationLockError);
    }
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])(
    'acquireMigrationLock refuses a wait of %s instead of looping without a deadline',
    async (waitMs) => {
      const client = { query: jest.fn(async () => ({ rows: [{ ok: false }] })) };
      await expect(
        acquireMigrationLock(client as unknown as ClientBase, { waitMs }),
      ).rejects.toBeInstanceOf(MigrationLockError);
      expect(client.query).not.toHaveBeenCalled();
    },
  );
});
