import type { Pool } from 'pg';

import { DEVELOPMENT_DELIVERY_PASSWORD, DEVELOPMENT_DISPATCH_PASSWORD } from '../config/env.schema';
import { DatabaseModule, resolveDeliveryUrl, resolveDispatchUrl } from './database.module';

const APP_URL = 'postgres://acc_app:app-secret@db.internal:5432/acc';

describe('resolveDispatchUrl (B3)', () => {
  it('uses DATABASE_DISPATCH_URL exactly as configured', () => {
    const dispatchUrl = 'postgres://acc_dispatch:s3cret@other.internal:6432/acc';
    expect(resolveDispatchUrl({ appUrl: APP_URL, dispatchUrl }, 'production')).toBe(dispatchUrl);
  });

  it('otherwise derives it from DATABASE_URL with the acc_dispatch user and its password', () => {
    const url = new URL(
      resolveDispatchUrl({ appUrl: APP_URL, dispatchPassword: 'p@ss/word' }, 'staging'),
    );
    expect(url.username).toBe('acc_dispatch');
    expect(decodeURIComponent(url.password)).toBe('p@ss/word');
    expect(url.host).toBe('db.internal:5432');
    expect(url.pathname).toBe('/acc');
  });

  it.each(['development', 'test'] as const)(
    '%s falls back to the local development password',
    (appEnv) => {
      const url = new URL(resolveDispatchUrl({ appUrl: APP_URL }, appEnv));
      expect(url.username).toBe('acc_dispatch');
      expect(url.password).toBe(DEVELOPMENT_DISPATCH_PASSWORD);
    },
  );

  it.each(['staging', 'production'] as const)(
    '%s refuses to build the pool without a credential, naming no value',
    (appEnv) => {
      expect(() => resolveDispatchUrl({ appUrl: APP_URL }, appEnv)).toThrow(
        /no dispatch credential is configured/,
      );
    },
  );
});

/** A pool whose principal-inspection query reports `role` as a clean, RLS-bound principal. */
function poolAs(role: string): Pool {
  return {
    query: async () => ({
      rows: [{ role, superuser: false, bypass_rls: false, owned_tables: null, member_of: null }],
    }),
  } as unknown as Pool;
}

describe('DatabaseModule startup check of the dispatch principal (B3)', () => {
  it('starts when the dispatch pool logs in as acc_dispatch', async () => {
    const module = new DatabaseModule(
      poolAs('acc_app'),
      poolAs('acc_auth'),
      poolAs('acc_dispatch'),
    );
    await expect(module.onModuleInit()).resolves.toBeUndefined();
  });

  it('refuses to start when the dispatch pool logs in as any other principal', async () => {
    const module = new DatabaseModule(poolAs('acc_app'), poolAs('acc_auth'), poolAs('acc_app'));
    await expect(module.onModuleInit()).rejects.toThrow(/logs in as acc_app, not acc_dispatch/);
  });

  it('refuses to start when the dispatch credential cannot log in', async () => {
    const failing = {
      query: async () => {
        throw new Error('password authentication failed for user "acc_dispatch"');
      },
    } as unknown as Pool;
    const module = new DatabaseModule(poolAs('acc_app'), poolAs('acc_auth'), failing);
    await expect(module.onModuleInit()).rejects.toThrow(/password authentication failed/);
  });
});

describe('resolveDeliveryUrl (Phase 5.0)', () => {
  it('uses DATABASE_DELIVERY_URL exactly as configured', () => {
    const deliveryUrl = 'postgres://acc_delivery:s3cret@other.internal:6432/acc';
    expect(resolveDeliveryUrl({ appUrl: APP_URL, deliveryUrl }, 'production')).toBe(deliveryUrl);
  });

  it('otherwise derives it from DATABASE_URL with the acc_delivery user and its password', () => {
    const url = new URL(
      resolveDeliveryUrl({ appUrl: APP_URL, deliveryPassword: 'x/y' }, 'staging'),
    );
    expect(url.username).toBe('acc_delivery');
    expect(decodeURIComponent(url.password)).toBe('x/y');
    expect(url.host).toBe('db.internal:5432');
  });

  it('falls back to the development password only in development and test', () => {
    expect(new URL(resolveDeliveryUrl({ appUrl: APP_URL }, 'test')).password).toBe(
      DEVELOPMENT_DELIVERY_PASSWORD,
    );
    expect(() => resolveDeliveryUrl({ appUrl: APP_URL }, 'production')).toThrow(
      /no delivery credential is configured/,
    );
  });
});

describe('DatabaseModule startup check of the delivery principal (Phase 5.0, AC-GR-3)', () => {
  it('with ingestion off (no delivery pool) starts exactly as before', async () => {
    const module = new DatabaseModule(
      poolAs('acc_app'),
      poolAs('acc_auth'),
      poolAs('acc_dispatch'),
      null,
    );
    await expect(module.onModuleInit()).resolves.toBeUndefined();
  });

  it('with ingestion on starts when the delivery pool logs in as acc_delivery', async () => {
    const module = new DatabaseModule(
      poolAs('acc_app'),
      poolAs('acc_auth'),
      poolAs('acc_dispatch'),
      poolAs('acc_delivery'),
    );
    await expect(module.onModuleInit()).resolves.toBeUndefined();
  });

  it('fails closed when acc_delivery cannot connect', async () => {
    const failing = {
      query: async () => {
        throw new Error('role "acc_delivery" is not permitted to log in');
      },
    } as unknown as Pool;
    const module = new DatabaseModule(
      poolAs('acc_app'),
      poolAs('acc_auth'),
      poolAs('acc_dispatch'),
      failing,
    );
    await expect(module.onModuleInit()).rejects.toThrow(/not permitted to log in/);
  });

  it('fails closed when the delivery pool logs in as another principal', async () => {
    const module = new DatabaseModule(
      poolAs('acc_app'),
      poolAs('acc_auth'),
      poolAs('acc_dispatch'),
      poolAs('acc_dispatch'),
    );
    await expect(module.onModuleInit()).rejects.toThrow(
      /logs in as acc_dispatch, not acc_delivery/,
    );
  });

  it('fails closed when acc_delivery is not RLS-bound', async () => {
    const bypassing = {
      query: async () => ({
        rows: [
          {
            role: 'acc_delivery',
            superuser: false,
            bypass_rls: true,
            owned_tables: null,
            member_of: null,
          },
        ],
      }),
    } as unknown as Pool;
    const module = new DatabaseModule(
      poolAs('acc_app'),
      poolAs('acc_auth'),
      poolAs('acc_dispatch'),
      bypassing,
    );
    await expect(module.onModuleInit()).rejects.toThrow();
  });
});
