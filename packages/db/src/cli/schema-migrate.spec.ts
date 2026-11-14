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

describe('three barriers (U14.1a 0042, U14.1b 0043, Phase 5.0 0045) — journal order, one locked session', () => {
  const G43 = '0043_messages_org_id_created_at_guard';
  const G45 = '0045_message_attempts_delivery_indexes_guard';
  const at43 = expected.findIndex((m) => m.tag === G43);
  const at45 = expected.findIndex((m) => m.tag === G45);
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

  // Pins the journal shape at the time of Phase 8B.1: 0042, 0043, then 0044 (the prefix of
  // the third barrier), the 0045 guard, 0046, the forward fix 0047, 0048 (resolver facts), 0049
  // (support delivery filter), 0050 (ledger foundation), 0051 (pricing and rating), 0052 (campaign foundation), 0053 (funds reservation), 0054 (settlement), 0055 (tenant billing reads), 0056 (unknown-outcome register), 0057 (operator resolution), 0058 (Phase 8A.1 segments), 0059 (account provisioning), 0060 (wallet recharge), 0061 (contact import/export), 0062 (journey foundation), 0063 (journey lifecycle and executions), 0064 (journey runner) and 0065 (journey events and schedules) as the newest.
  // Update when a later migration is added.
  it('0043 follows 0042; the 0045 guard follows 0044; 0046 to 0067 are the newest', () => {
    expect(at43).toBe(guardAt + 1);
    expect(at45).toBe(at43 + 2);
    expect(expected[at45 - 1]?.tag).toBe('0044_phase5_0_delivery_foundation');
    expect(expected[at45 + 1]?.tag).toBe('0046_phase5_0_delivered_attempt_fk');
    expect(expected[at45 + 2]?.tag).toBe('0047_phase5_0_dispatch_settled_event_visibility');
    expect(expected[at45 + 3]?.tag).toBe('0048_phase5_0_ingress_resolver_facts');
    expect(expected[at45 + 4]?.tag).toBe('0049_phase5_0_support_delivery_filter');
    expect(expected[at45 + 5]?.tag).toBe('0050_phase7_1_ledger_foundation');
    expect(expected[at45 + 6]?.tag).toBe('0051_phase7_2_pricing_rating');
    expect(expected[at45 + 7]?.tag).toBe('0052_phase8b_campaign_foundation');
    expect(expected[at45 + 8]?.tag).toBe('0053_phase7_4_funds_reservation');
    expect(expected[at45 + 9]?.tag).toBe('0054_phase7_5_settlement');
    expect(expected[at45 + 10]?.tag).toBe('0055_phase7_6a_tenant_billing_reads');
    expect(expected[at45 + 11]?.tag).toBe('0056_phase7_6b_unknown_outcome_register');
    expect(expected[at45 + 12]?.tag).toBe('0057_phase7_6c_operator_resolution');
    expect(expected[at45 + 13]?.tag).toBe('0058_phase8a_segments');
    expect(expected[at45 + 14]?.tag).toBe('0059_phase7_6d1_account_provisioning');
    expect(expected[at45 + 15]?.tag).toBe('0060_phase7_6d2_wallet_recharge');
    expect(expected[at45 + 16]?.tag).toBe('0061_phase8a_contact_import_export');
    expect(expected[at45 + 17]?.tag).toBe('0062_phase8c1_journey_foundation');
    expect(expected[at45 + 18]?.tag).toBe('0063_phase8c2_journey_lifecycle_executions');
    expect(expected[at45 + 19]?.tag).toBe('0064_phase8c3_journey_runner');
    expect(expected[at45 + 20]?.tag).toBe('0065_phase8c4_journey_events_schedules');
    expect(expected[at45 + 21]?.tag).toBe('0066_phase8c5_journey_send_attribution');
    expect(expected[at45 + 22]?.tag).toBe('0067_phase8c5b_journey_send_node');
    expect(expected).toHaveLength(at45 + 23);
  });

  it.each<[string, Row[] | null, string[]]>([
    [
      'fresh database',
      null,
      [`apply:${guardAt}`, 'barrier:a', 'apply:1', 'barrier:b', 'apply:2', 'barrier:c', 'apply:23'],
    ],
    [
      'database at 0041',
      rowsFor(guardAt),
      ['barrier:a', 'apply:1', 'barrier:b', 'apply:2', 'barrier:c', 'apply:23'],
    ],
    [
      'database at 0042 (U14.1a applied)',
      rowsFor(guardAt + 1),
      ['verify:a', 'barrier:b', 'apply:2', 'barrier:c', 'apply:23'],
    ],
    [
      'database at 0044 (Phase 5.0 M1 applied)',
      rowsFor(at45),
      ['verify:a', 'verify:b', 'barrier:c', 'apply:23'],
    ],
    ['up to date', rowsFor(expected.length), ['verify:a', 'verify:b', 'verify:c']],
  ])(
    '%s: each barrier runs right before its own guard; given out of order, still journal order',
    async (_label, rows, middle) => {
      const db = fakeDatabase(rows);
      const a = barrierFor(db.events, GUARD, 'a');
      const b = barrierFor(db.events, G43, 'b');
      const c = barrierFor(db.events, G45, 'c');
      await migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [c, b, a] });
      expect(db.events).toEqual(['lock', ...middle, 'verify:a', 'verify:b', 'verify:c', 'unlock']);
      expect(db.history()).toHaveLength(expected.length);
      expect(db.pool.connect).toHaveBeenCalledTimes(1);
    },
  );

  it('a refusal at the 0043 barrier leaves 0042 recorded and 0043 not recorded', async () => {
    const db = fakeDatabase(rowsFor(guardAt));
    const a = barrierFor(db.events, GUARD, 'a');
    const b = barrierFor(db.events, G43, 'b');
    const c = barrierFor(db.events, G45, 'c');
    (b.prepare as jest.Mock).mockImplementation(async () => {
      db.events.push('barrier:b');
      throw new Error('refused b');
    });
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [a, b, c] }),
    ).rejects.toThrow('refused b');
    expect(db.events).toEqual(['lock', 'barrier:a', 'apply:1', 'barrier:b', 'unlock']);
    expect(db.history()).toHaveLength(guardAt + 1);
    expect(c.prepare).not.toHaveBeenCalled();
  });

  it('a refusal at the 0045 barrier leaves 0044 recorded and 0045/0046 not recorded', async () => {
    const db = fakeDatabase(rowsFor(guardAt + 2));
    const a = barrierFor(db.events, GUARD, 'a');
    const b = barrierFor(db.events, G43, 'b');
    const c = barrierFor(db.events, G45, 'c');
    (c.prepare as jest.Mock).mockImplementation(async () => {
      db.events.push('barrier:c');
      throw new Error('refused c');
    });
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [a, b, c] }),
    ).rejects.toThrow('refused c');
    expect(db.events).toEqual(['lock', 'verify:a', 'verify:b', 'apply:1', 'barrier:c', 'unlock']);
    expect(db.history()).toHaveLength(at45);
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

  it('with 0045 recorded, drifted delivery indexes stop the run before anything else is applied', async () => {
    const db = fakeDatabase(rowsFor(at45 + 1));
    const a = barrierFor(db.events, GUARD, 'a');
    const b = barrierFor(db.events, G43, 'b');
    const c = barrierFor(db.events, G45, 'c');
    (c.verifyApplied as jest.Mock).mockRejectedValue(new Error('0045 indexes missing'));
    await expect(
      migrateSchema(db.pool, REPO_MIGRATIONS, { apply: db.apply, barriers: [a, b, c] }),
    ).rejects.toThrow('0045 indexes missing');
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
