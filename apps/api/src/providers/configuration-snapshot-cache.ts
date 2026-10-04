import { PROVIDER_CONFIGURATION_CACHE } from '@acc/contracts';

/**
 * The advisory snapshot cache at the heart of Phase 2.4 hot reload
 * (`PROVIDER_ADAPTER.md` §3a.4), independent of where its data comes from so
 * every rule is unit-testable on a manual clock.
 *
 * **Advisory only.** Nothing that authorizes, administers, enforces lifecycle,
 * admits a submission or submits reads it (§3a.1); a stale snapshot can at
 * worst make an advisory read briefly out of date.
 *
 * On each `read`, in order:
 *   1. reload when there is no snapshot (`startup`), it is dirty (`notification`,
 *      `local`, `listener`), or it is at least `MAX_AGE_MS` old (`ttl`);
 *   2. otherwise, when the revision was last checked at least `RECONCILE_MS`
 *      ago, read it, and reload when it is newer (`reconcile`);
 *   3. a reloaded snapshot is installed only if its revision is not lower than
 *      the installed one — a slow reload never replaces newer configuration.
 */
export interface Revisioned {
  readonly revision: number;
}

export interface SnapshotSource<S extends Revisioned, Tx> {
  /** The current revision (one row). */
  revision(tx: Tx): Promise<number>;
  /** The whole snapshot. Reads the revision first, then the data, so the data is never older than its label. */
  load(tx: Tx): Promise<S>;
}

export type ReloadCause = 'startup' | 'notification' | 'local' | 'listener' | 'reconcile' | 'ttl';
export type ReloadOutcome = 'success' | 'failure' | 'discarded';
export type HintOutcome = 'applied' | 'duplicate' | 'malformed';

export interface SnapshotObserver<S> {
  reloaded(cause: ReloadCause, outcome: ReloadOutcome, snapshot: S | null): void;
}

interface Installed<S> {
  readonly snapshot: S;
  readonly loadedAt: number;
  checkedAt: number;
}

const REVISION_HINT = /^[1-9][0-9]{0,17}$/;

export class ConfigurationSnapshotCache<S extends Revisioned, Tx> {
  private current: Installed<S> | null = null;
  private dirty: ReloadCause | null = null;
  /**
   * Advanced by every hint or invalidation that marks the snapshot dirty. A
   * reload clears `dirty` only if no new mark arrived while it ran — so a
   * genuine notification landing mid-reload is never lost, and a bogus one
   * (forged, or ahead of anything committed) costs exactly one reload.
   */
  private epoch = 0;

  constructor(
    private readonly source: SnapshotSource<S, Tx>,
    private readonly clock: { now(): Date },
    private readonly observer?: SnapshotObserver<S>,
  ) {}

  /** The snapshot to serve, reloading first when the rules say so. Call only inside an authorized transaction. */
  async read(tx: Tx): Promise<S> {
    const now = this.clock.now().getTime();
    let cause: ReloadCause | null = null;
    if (!this.current) cause = 'startup';
    else if (this.dirty) cause = this.dirty;
    else if (now - this.current.loadedAt >= PROVIDER_CONFIGURATION_CACHE.MAX_AGE_MS) cause = 'ttl';
    else if (now - this.current.checkedAt >= PROVIDER_CONFIGURATION_CACHE.RECONCILE_MS) {
      const revision = await this.source.revision(tx);
      this.current.checkedAt = now;
      if (revision > this.current.snapshot.revision) cause = 'reconcile';
    }
    if (!cause) return this.current!.snapshot;

    const startedAt = this.epoch;
    let loaded: S;
    try {
      loaded = await this.source.load(tx);
    } catch (error) {
      this.observer?.reloaded(cause, 'failure', null);
      throw error;
    }
    if (this.current && loaded.revision < this.current.snapshot.revision) {
      // A reload that read older configuration than is already installed.
      this.observer?.reloaded(cause, 'discarded', loaded);
      return this.current.snapshot;
    }
    this.current = { snapshot: loaded, loadedAt: now, checkedAt: now };
    if (this.epoch === startedAt) this.dirty = null;
    this.observer?.reloaded(cause, 'success', loaded);
    return loaded;
  }

  /**
   * A notification. The payload is the announced revision — a hint, never
   * data: it can only mark the snapshot dirty. Not greater than the installed
   * revision (duplicate, out of order, stale): ignored. Malformed: dirty,
   * conservatively.
   */
  hint(payload: string): HintOutcome {
    if (!REVISION_HINT.test(payload)) {
      this.mark('notification');
      return 'malformed';
    }
    const revision = Number(payload);
    if (this.current && revision <= this.current.snapshot.revision) return 'duplicate';
    this.mark('notification');
    return 'applied';
  }

  /** This instance committed a change (`local`), or its listener lost notifications (`listener`). */
  invalidate(cause: 'local' | 'listener'): void {
    this.mark(cause);
  }

  private mark(cause: ReloadCause): void {
    this.dirty ??= cause;
    this.epoch++;
  }

  /** The installed snapshot without any refresh — diagnostics and tests only. */
  peek(): S | null {
    return this.current?.snapshot ?? null;
  }

  isDirty(): boolean {
    return this.dirty !== null;
  }
}
