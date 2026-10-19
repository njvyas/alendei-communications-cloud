import type { Pool } from 'pg';

import {
  REFERENCE_DATABASES,
  RoleReconcileRefused,
  planRoleReconcile,
  reconcileRoles,
} from './role-reconcile';

const PASSWORDS = {
  DATABASE_APP_PASSWORD: 'app-secret',
  DATABASE_AUTH_PASSWORD: 'auth-secret',
  DATABASE_RELAY_PASSWORD: 'relay-secret',
  DATABASE_DISPATCH_PASSWORD: 'dispatch-secret',
};

const base = (database = 'acc') => ({
  APP_ENV: 'development',
  DATABASE_ADMIN_URL: `postgres://owner:pw@localhost:5432/${database}`,
  ACC_ROLE_RECONCILE_TARGET: database,
  ...PASSWORDS,
});

const refusal = (env: Record<string, string | undefined>): string => {
  try {
    planRoleReconcile(env);
    return '';
  } catch (error) {
    expect(error).toBeInstanceOf(RoleReconcileRefused);
    return (error as RoleReconcileRefused).reasons.join('\n');
  }
};

describe('planRoleReconcile — deliberate, targeted, never in tests, clones or references', () => {
  it('allows an explicitly confirmed development target with every password', () => {
    const plan = planRoleReconcile(base());
    expect(plan.database).toBe('acc');
    expect(plan.credentials.map((c) => c.role)).toEqual([
      'acc_app',
      'acc_auth',
      'acc_relay',
      'acc_dispatch',
    ]);
  });

  it('refuses without the explicit target confirmation', () => {
    expect(refusal({ ...base(), ACC_ROLE_RECONCILE_TARGET: undefined })).toContain(
      'ACC_ROLE_RECONCILE_TARGET must be set',
    );
  });

  it('refuses when the confirmation names a different database', () => {
    expect(refusal({ ...base(), ACC_ROLE_RECONCILE_TARGET: 'acc_other' })).toContain(
      'does not match',
    );
  });

  it('refuses without DATABASE_ADMIN_URL', () => {
    expect(refusal({ ...base(), DATABASE_ADMIN_URL: undefined })).toContain(
      'DATABASE_ADMIN_URL must be set',
    );
  });

  it.each([
    ['a with-db-clone clone', 'acc_clone_436072f90852', 'with-db-clone clone'],
    [
      'a clone of the reference template',
      'acc_r015_base_clone_0123456789ab',
      'with-db-clone clone',
    ],
    ['a throwaway database', 'acc_tmp_rebuild', 'throwaway database'],
  ])('refuses %s', (_label, database, message) => {
    expect(refusal(base(database))).toContain(message);
  });

  it.each(REFERENCE_DATABASES.map((d) => [d]))('refuses the reference database %s', (database) => {
    expect(refusal(base(database))).toContain('reference database');
  });

  it.each([
    ['APP_ENV=test', { APP_ENV: 'test' }],
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
    ['APP_ENV=test with CI=true but no opt-in', { APP_ENV: 'test', CI: 'true' }],
    [
      'APP_ENV=test with the opt-in but not on CI',
      { APP_ENV: 'test', ACC_ROLE_RECONCILE_EPHEMERAL_CI: '1' },
    ],
  ])('refuses a test context: %s', (_label, extra) => {
    expect(refusal({ ...base(), ...extra })).toContain('test contexts are refused');
  });

  it('refuses the CI opt-in outside CI, even in development', () => {
    expect(refusal({ ...base(), ACC_ROLE_RECONCILE_EPHEMERAL_CI: '1' })).toContain(
      'only accepted when CI=true',
    );
  });

  it('allows only the ephemeral CI container: CI=true, the opt-in and the confirmation', () => {
    const plan = planRoleReconcile({
      ...base(),
      APP_ENV: 'test',
      NODE_ENV: 'test',
      CI: 'true',
      ACC_ROLE_RECONCILE_EPHEMERAL_CI: '1',
    });
    expect(plan.credentials).toHaveLength(4);
  });

  it.each(Object.keys(PASSWORDS))(
    'refuses when %s is missing — there is no fallback password',
    (variable) => {
      expect(refusal({ ...base(), [variable]: undefined })).toContain(`${variable} must be set`);
    },
  );

  it.each(Object.keys(PASSWORDS))('refuses when %s is blank', (variable) => {
    expect(refusal({ ...base(), [variable]: '   ' })).toContain(`${variable} must be set`);
  });

  it('never invents the old dispatch default', () => {
    const reasons = refusal({ ...base(), DATABASE_DISPATCH_PASSWORD: undefined });
    expect(reasons).toContain('DATABASE_DISPATCH_PASSWORD must be set for acc_dispatch');
  });
});

describe('reconcileRoles — alters only existing, allowlisted roles', () => {
  const fakePool = (existing: string[]) => {
    const statements: string[] = [];
    const pool = {
      query: jest.fn(async (text: string, params?: unknown[]) => {
        statements.push(text);
        if (text.startsWith('SELECT rolname FROM pg_roles')) {
          return { rows: existing.map((rolname) => ({ rolname })) };
        }
        if (text.startsWith('SELECT quote_literal'))
          return { rows: [{ literal: `'${String(params?.[0])}'` }] };
        return { rows: [] };
      }),
    };
    return { pool: pool as unknown as Pool, statements };
  };
  const credentials = planRoleReconcile(base()).credentials;

  it('issues exactly one ALTER ROLE … LOGIN PASSWORD per role and never creates a role', async () => {
    const { pool, statements } = fakePool(['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch']);
    await reconcileRoles(pool, credentials);
    const alters = statements.filter((s) => s.startsWith('ALTER ROLE'));
    expect(alters.map((s) => s.split(' ')[2])).toEqual([
      'acc_app',
      'acc_auth',
      'acc_relay',
      'acc_dispatch',
    ]);
    expect(alters.every((s) => / LOGIN PASSWORD '/.test(s))).toBe(true);
    expect(statements.some((s) => /CREATE\s+ROLE/i.test(s))).toBe(false);
  });

  it('refuses, altering nothing, when a role does not exist', async () => {
    const { pool, statements } = fakePool(['acc_app', 'acc_auth', 'acc_relay']);
    await expect(reconcileRoles(pool, credentials)).rejects.toThrow('roles missing');
    expect(statements.some((s) => s.startsWith('ALTER ROLE'))).toBe(false);
  });

  it('refuses a role outside the fixed allowlist before any statement', async () => {
    const { pool, statements } = fakePool(['postgres']);
    await expect(reconcileRoles(pool, [{ role: 'postgres', password: 'x' }])).rejects.toThrow(
      'unknown role',
    );
    expect(statements).toEqual([]);
  });
});
