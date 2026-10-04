import { PROVIDER_CONFIGURATION_CACHE as C } from '@acc/contracts';

import {
  ConfigurationSnapshotCache,
  type ReloadCause,
  type ReloadOutcome,
} from './configuration-snapshot-cache';

/**
 * Phase 2.4 — the advisory configuration snapshot's rules (`PROVIDER_ADAPTER.md`
 * §3a.4), on a manual clock and a fake source: every reload cause, the exact
 * `R` and `T` boundaries, hints, and the stale-install rule.
 */
interface Snap {
  readonly revision: number;
  readonly value: string;
}

class Clock {
  t = Date.parse('2026-10-04T00:00:00Z');
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

/** A source whose committed state the test controls; counts what the cache asks it. */
function source(initial = 1) {
  const db = { revision: initial, value: `v${initial}`, revisionReads: 0, loads: 0 };
  return {
    db,
    commit(value: string) {
      db.revision += 1;
      db.value = value;
    },
    impl: {
      revision: async () => {
        db.revisionReads++;
        return db.revision;
      },
      load: async () => {
        db.loads++;
        return { revision: db.revision, value: db.value };
      },
    },
  };
}

function cacheOn(src: ReturnType<typeof source>, clock = new Clock()) {
  const events: [ReloadCause, ReloadOutcome][] = [];
  const cache = new ConfigurationSnapshotCache<Snap, null>(src.impl, clock, {
    reloaded: (cause, outcome) => events.push([cause, outcome]),
  });
  return { cache, clock, events };
}

describe('Phase 2.4 configuration snapshot cache (§3a.4)', () => {
  it('startup: the first read always loads from the source; nothing is served before it', async () => {
    const src = source(7);
    const { cache, events } = cacheOn(src);
    expect(cache.peek()).toBeNull();
    expect(await cache.read(null)).toEqual({ revision: 7, value: 'v7' });
    expect(events).toEqual([['startup', 'success']]);
  });

  it('within R the snapshot is served without touching the source', async () => {
    const src = source();
    const { cache, clock } = cacheOn(src);
    await cache.read(null);
    src.commit('v2');
    clock.advance(C.RECONCILE_MS - 1);
    expect((await cache.read(null)).value).toBe('v1');
    expect([src.db.revisionReads, src.db.loads]).toEqual([0, 1]);
  });

  it('at exactly R the revision is checked: unchanged → served as is; newer → reloaded (reconcile)', async () => {
    const src = source();
    const { cache, clock, events } = cacheOn(src);
    await cache.read(null);
    clock.advance(C.RECONCILE_MS);
    expect((await cache.read(null)).value).toBe('v1');
    expect([src.db.revisionReads, src.db.loads]).toEqual([1, 1]);
    // The check resets the R timer: no second check until another R.
    clock.advance(C.RECONCILE_MS - 1);
    src.commit('v2');
    expect((await cache.read(null)).value).toBe('v1');
    clock.advance(1);
    expect((await cache.read(null)).value).toBe('v2');
    expect(events.at(-1)).toEqual(['reconcile', 'success']);
  });

  it('a notification marks the snapshot dirty: the next read reloads at once, before R', async () => {
    const src = source();
    const { cache, events } = cacheOn(src);
    await cache.read(null);
    src.commit('v2');
    expect(cache.hint('2')).toBe('applied');
    expect(cache.isDirty()).toBe(true);
    expect((await cache.read(null)).value).toBe('v2');
    expect(events.at(-1)).toEqual(['notification', 'success']);
    expect(cache.isDirty()).toBe(false);
  });

  it('duplicate, out-of-order and stale notifications are ignored; malformed ones only mark it dirty', async () => {
    const src = source(5);
    const { cache } = cacheOn(src);
    await cache.read(null);
    for (const payload of ['5', '4', '1']) expect(cache.hint(payload)).toBe('duplicate');
    expect(cache.isDirty()).toBe(false);
    for (const payload of ['', 'abc', '-3', '0', '1e3', '9'.repeat(19), '{"revision":9}', ' 6']) {
      expect(cache.hint(payload)).toBe('malformed');
    }
    expect(cache.isDirty()).toBe(true);
    expect((await cache.read(null)).revision).toBe(5); // one harmless reload, same data
    expect(src.db.loads).toBe(2);
  });

  it('a notification payload is never applied as state: a forged high revision costs exactly one reload, and cannot block a later real change', async () => {
    const src = source();
    const { cache, clock } = cacheOn(src);
    await cache.read(null);
    expect(cache.hint('999999999')).toBe('applied');
    expect((await cache.read(null)).revision).toBe(1); // the source says 1: that is what is installed
    expect(cache.isDirty()).toBe(false); // consumed by that one reload
    expect(src.db.loads).toBe(2);
    await cache.read(null);
    expect(src.db.loads).toBe(2); // no lingering reload-per-read
    src.commit('v2');
    cache.hint('2');
    expect((await cache.read(null)).value).toBe('v2');
    clock.advance(C.RECONCILE_MS);
    src.commit('v3');
    expect((await cache.read(null)).value).toBe('v3');
  });

  it('a notification that arrives while a reload is in flight keeps the snapshot dirty', async () => {
    const src = source(1);
    let release!: () => void;
    let hold = false;
    const gated = {
      revision: src.impl.revision,
      load: async () => {
        const snap = { revision: src.db.revision, value: src.db.value };
        if (hold) await new Promise<void>((r) => (release = r));
        return snap;
      },
    };
    const cache = new ConfigurationSnapshotCache<Snap, null>(gated, new Clock());
    await cache.read(null);
    src.commit('v2');
    cache.hint('2');
    hold = true;
    const inFlight = cache.read(null); // reads r2, held
    await new Promise((r) => setImmediate(r));
    src.commit('v3');
    cache.hint('3'); // arrives mid-reload
    release();
    expect((await inFlight).value).toBe('v2');
    expect(cache.isDirty()).toBe(true); // r3 not yet seen: still dirty
    hold = false;
    expect((await cache.read(null)).value).toBe('v3');
    expect(cache.isDirty()).toBe(false);
  });

  it('T is a hard bound: even with the revision signal broken, no snapshot older than T is served', async () => {
    const src = source();
    const { cache, clock, events } = cacheOn(src);
    await cache.read(null);
    src.db.value = 'changed-without-revision'; // the revision signal failed
    clock.advance(C.MAX_AGE_MS - 1);
    expect((await cache.read(null)).value).toBe('v1');
    clock.advance(1);
    expect((await cache.read(null)).value).toBe('changed-without-revision');
    expect(events.at(-1)).toEqual(['ttl', 'success']);
  });

  it('a slow reload never installs older configuration over newer', async () => {
    const src = source(1);
    let release!: () => void;
    let calls = 0;
    const slow = {
      revision: src.impl.revision,
      load: async () => {
        calls++;
        if (calls === 2) {
          const snap = { revision: src.db.revision, value: src.db.value }; // reads r2…
          await new Promise<void>((r) => (release = r)); // …and is held
          return snap;
        }
        return src.impl.load();
      },
    };
    const events: [ReloadCause, ReloadOutcome][] = [];
    const cache = new ConfigurationSnapshotCache<Snap, null>(slow, new Clock(), {
      reloaded: (c, o) => events.push([c, o]),
    });
    await cache.read(null); // r1
    src.commit('v2');
    cache.hint('2');
    const held = cache.read(null); // starts loading r2, held
    await new Promise((r) => setImmediate(r));
    src.commit('v3');
    cache.hint('3');
    expect((await cache.read(null)).value).toBe('v3'); // r3 installed
    release();
    expect((await held).value).toBe('v3'); // the r2 reload is discarded, r3 served
    expect(cache.peek()!.revision).toBe(3);
    expect(events).toContainEqual(['notification', 'discarded']);
  });

  it('a reload that fails propagates, is counted, and leaves the snapshot due for reload', async () => {
    const src = source();
    let fail = false;
    const flaky = {
      revision: src.impl.revision,
      load: async () => {
        if (fail) throw new Error('database unavailable');
        return src.impl.load();
      },
    };
    const events: [ReloadCause, ReloadOutcome][] = [];
    const cache = new ConfigurationSnapshotCache<Snap, null>(flaky, new Clock(), {
      reloaded: (c, o) => events.push([c, o]),
    });
    await cache.read(null);
    src.commit('v2');
    cache.hint('2');
    fail = true;
    await expect(cache.read(null)).rejects.toThrow('database unavailable');
    expect(cache.isDirty()).toBe(true);
    fail = false;
    expect((await cache.read(null)).value).toBe('v2');
    expect(events).toEqual([
      ['startup', 'success'],
      ['notification', 'failure'],
      ['notification', 'success'],
    ]);
  });

  it('local and listener invalidations force the next read to reload', async () => {
    const src = source();
    const { cache, events } = cacheOn(src);
    await cache.read(null);
    cache.invalidate('local');
    await cache.read(null);
    cache.invalidate('listener');
    await cache.read(null);
    expect(events.map((e) => e[0])).toEqual(['startup', 'local', 'listener']);
  });

  it('the published bounds are R = 5 s and T = 60 s', () => {
    expect([C.RECONCILE_MS, C.MAX_AGE_MS]).toEqual([5_000, 60_000]);
  });
});
