/**
 * The runtime nested-acquisition guard (ADR-015 R-1), against real pools.
 *
 * A context that holds a connection and asks the same pool for another can
 * deadlock it: enough concurrent callers each hold one and wait for one that
 * only another of them can release. The guard refuses that acquisition at
 * once, as it does an `acc_app` acquisition under a held `acc_auth` one (the
 * only legal cross-pool order is `acc_app` → `acc_auth`). Each refusal is
 * asserted to arrive well inside the acquisition timeout, on a pool too small
 * to have served it anyway — so "refused" can never be confused with "waited
 * and timed out".
 */
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';

import { createDatabase, createPool, type Database } from '../client';
import { guardPool, NestedPoolAcquisitionError } from '../pool-guard';
import { loadTestEnv } from './harness';

/** The refusal, unwrapped from the query error Drizzle reports it in. */
function refusalOf(error: unknown): unknown {
  if (error instanceof NestedPoolAcquisitionError || !(error instanceof Error)) return error;
  return error.cause ? refusalOf(error.cause) : error;
}

describe('nested pool acquisition guard (ADR-015 R-1)', () => {
  const ACQUIRE_TIMEOUT_MS = 3_000;
  let appPool: Pool;
  let authPool: Pool;
  let app: Database;
  let auth: Database;

  beforeAll(() => {
    loadTestEnv();
    const make = (url: string, name: string, role: 'app' | 'auth') =>
      guardPool(
        createPool({
          connectionString: url,
          max: 1,
          connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
          applicationName: name,
        }),
        role,
      );
    appPool = make(process.env.DATABASE_URL!, 'acc-test-guard-app', 'app');
    authPool = make(process.env.DATABASE_AUTH_URL!, 'acc-test-guard-auth', 'auth');
    app = createDatabase(appPool);
    auth = createDatabase(authPool);
  });

  afterAll(async () => {
    await Promise.all([appPool.end(), authPool.end()]);
  });

  const refusedAtOnce = async (work: () => Promise<unknown>) => {
    const started = Date.now();
    const failure = await work().then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusalOf(failure)).toBeInstanceOf(NestedPoolAcquisitionError);
    expect(Date.now() - started).toBeLessThan(ACQUIRE_TIMEOUT_MS / 3);
  };

  it('refuses a transaction-less statement on the pool a transaction holds', async () => {
    await refusedAtOnce(() =>
      auth.transaction(async () => {
        await auth.execute(sql`select 1`);
      }),
    );
  });

  it('refuses a transaction-less insert on the pool a transaction holds', async () => {
    await refusedAtOnce(() =>
      auth.transaction(async () => {
        // Refused before it is sent: nothing reaches the table.
        await auth.execute(sql`insert into audit_logs default values`);
      }),
    );
  });

  it('refuses a transaction inside a transaction on the same pool', async () => {
    await refusedAtOnce(() => auth.transaction(() => auth.transaction(async () => 1)));
    await refusedAtOnce(() => app.transaction(() => app.transaction(async () => 1)));
  });

  it('refuses acc_app under a held acc_auth connection', async () => {
    await refusedAtOnce(() => auth.transaction(() => app.transaction(async () => 1)));
    await refusedAtOnce(() =>
      auth.transaction(async () => {
        await app.execute(sql`select 1`);
      }),
    );
  });

  it('allows acc_auth under a held acc_app connection', async () => {
    await expect(app.transaction(() => auth.transaction(async () => 'ok'))).resolves.toBe('ok');
    await expect(
      app.transaction(async () => (await auth.execute<{ n: number }>(sql`select 1 as n`)).rows[0]),
    ).resolves.toEqual({ n: 1 });
  });

  it('allows the same pool again once the transaction has settled', async () => {
    await auth.transaction(async () => undefined);
    await expect(auth.transaction(async () => 'again')).resolves.toBe('again');
    await expect(auth.execute(sql`select 1`)).resolves.toBeDefined();
    // Sequential transactions in one context never inherit each other's mark.
    for (let i = 0; i < 3; i += 1) {
      await expect(app.transaction(() => auth.transaction(async () => i))).resolves.toBe(i);
    }
  });

  it('reports the refusal with the requested and held principals', async () => {
    const failure = await auth
      .transaction(() => app.transaction(async () => 1))
      .then(
        () => null,
        (error: unknown) => error,
      );
    const refusal = refusalOf(failure) as NestedPoolAcquisitionError;
    expect(refusal.requested).toBe('app');
    expect(refusal.held).toEqual(['auth']);
    expect(refusal.message).toMatch(
      /acc_app connection was requested while this context holds \[acc_auth\]/,
    );
  });

  it('refuses to guard a pool twice', () => {
    expect(() => guardPool(appPool, 'app')).toThrow(/already guarded/);
  });

  it('leaves both pools idle and unqueued', () => {
    expect(appPool.waitingCount).toBe(0);
    expect(authPool.waitingCount).toBe(0);
    expect(appPool.totalCount - appPool.idleCount).toBe(0);
    expect(authPool.totalCount - authPool.idleCount).toBe(0);
  });
});
