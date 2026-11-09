import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { PoolClient } from 'pg';

import {
  connect,
  createTenant,
  destroyTenant,
  type Principals,
  type TenantFixture,
} from './harness';

/**
 * Phase 7 PR 7-6b — the unknown-outcome register (migration `0056`;
 * DECISIONS.md §1zi.9 D-76-5). The database half: the two read functions are
 * executable by acc_app only and refuse (42501) any caller that is not a
 * signed-in user holding billing.manage at platform scope; 0056 adds no policy
 * or privilege on any financial table. Behaviour is exercised over HTTP in
 * `apps/api/test/phase7_6b-unknown-register.int-spec.ts`.
 */
const MIGRATION = readFileSync(
  join(resolve(__dirname, '../..'), 'migrations/0056_phase7_6b_unknown_outcome_register.sql'),
  'utf8',
);
const APP_ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch', 'acc_delivery'] as const;
const FUNCTIONS = [
  'app_billing_unknown_register(uuid, text, text, text, integer, timestamp with time zone, uuid, integer)',
  'app_billing_unknown_open_counts()',
];

describe('Phase 7 PR 7-6b — the unknown-outcome register (migration 0056)', () => {
  let db: Principals;
  let A: TenantFixture;
  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  beforeAll(async () => {
    db = connect();
    A = await createTenant(db.admin, 'p76b-db');
  }, 60_000);
  afterAll(async () => {
    if (A) await destroyTenant(db.admin, A);
    await db.close();
  });

  async function code(c: PoolClient, text: string): Promise<string> {
    await c.query('SAVEPOINT s');
    try {
      await c.query(text);
      await c.query('RELEASE SAVEPOINT s');
      return 'OK';
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      return (error as { code?: string }).code ?? 'NO_CODE';
    }
  }

  it('both functions: executable by acc_app only, never PUBLIC; SECURITY DEFINER with a pinned search_path', async () => {
    for (const fn of FUNCTIONS) {
      const { rows } = await admin(
        `SELECT r AS role FROM unnest($2::text[]) AS r WHERE has_function_privilege(r, $1, 'EXECUTE')`,
        [fn, APP_ROLES],
      );
      expect([fn, rows.map((r) => r.role)]).toEqual([fn, ['acc_app']]);
      const pub = await admin(
        `SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0`,
        [fn],
      );
      expect([fn, pub.rows]).toEqual([fn, []]);
      const def = await admin(
        `SELECT prosecdef, proconfig, provolatile FROM pg_proc WHERE oid = $1::regprocedure`,
        [fn],
      );
      expect([fn, def.rows[0]]).toEqual([
        fn,
        { prosecdef: true, proconfig: ['search_path=public, pg_temp'], provolatile: 's' },
      ]);
    }
  });

  it('0056 adds no policy, no table privilege and no write; only the two function grants', () => {
    const sqlText = MIGRATION.replace(/--[^\n]*/g, '');
    expect(sqlText).not.toMatch(
      /CREATE\s+POLICY|ALTER\s+TABLE|CREATE\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i,
    );
    expect(
      [...sqlText.matchAll(/\bGRANT\b[^;]*;/gi)].map((x) => x[0].replace(/\s+/g, ' ')),
    ).toEqual([
      'GRANT EXECUTE ON FUNCTION app_billing_unknown_register(uuid, text, text, text, integer, timestamptz, uuid, integer) TO acc_app;',
      'GRANT EXECUTE ON FUNCTION app_billing_unknown_open_counts() TO acc_app;',
    ]);
  });

  it('the financial tables keep exactly the 7-6a tenant policies', async () => {
    const { rows } = await admin(
      `SELECT policyname FROM pg_policies WHERE tablename IN ('wallets', 'credit_accounts', 'usage_ledger') ORDER BY 1`,
    );
    expect(rows.map((r) => r.policyname)).toEqual([
      'credit_accounts_tenant_select',
      'usage_ledger_tenant_select',
      'wallets_tenant_select',
    ]);
  });

  it('refuses (42501) a caller without a user, and a tenant user without platform billing.manage', async () => {
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      for (const call of [
        `SELECT * FROM app_billing_unknown_register(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)`,
        `SELECT * FROM app_billing_unknown_open_counts()`,
      ]) {
        expect([call.slice(14, 45), await code(c, call)]).toEqual([call.slice(14, 45), '42501']);
      }
      await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [A.orgId]);
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [A.userId]);
      for (const call of [
        `SELECT * FROM app_billing_unknown_register(NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)`,
        `SELECT * FROM app_billing_unknown_open_counts()`,
      ]) {
        expect([call.slice(14, 45), await code(c, call)]).toEqual([call.slice(14, 45), '42501']);
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
