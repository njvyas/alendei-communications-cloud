import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { uuidv7 } from 'uuidv7';

import {
  connect,
  createTenant,
  destroyTenant,
  type Principals,
  type TenantFixture,
} from './harness';

/**
 * Phase 7 PR 7-5 — settlement and the reservation lifecycle (migration `0054`;
 * DECISIONS.md §1zi.8).
 *
 * The database half: privileges (the dispatcher reaches money only through the
 * three settlement functions, executable by acc_dispatch alone; every earlier
 * financial function keeps exactly its grants), the definer properties, and the
 * immutability of the attempt classification. The behaviour — claim checks,
 * charges, releases, top-ups, idempotency, recovery and receipts — is exercised
 * through the real dispatcher in `apps/api/test/phase7_5-settlement.int-spec.ts`.
 */

const PACKAGE_ROOT = resolve(__dirname, '../..');
const MIGRATION = readFileSync(
  join(PACKAGE_ROOT, 'migrations/0054_phase7_5_settlement.sql'),
  'utf8',
);
const APP_ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch', 'acc_delivery'] as const;
const SETTLEMENT = [
  'app_dispatch_attempt_reserve(uuid, integer)',
  'app_dispatch_attempt_settle(uuid, boolean)',
  'app_dispatch_message_settle()',
];
const EARLIER = {
  // Phase 7 PR 7-6c (0057, C-1): the writer gained a defaulted tenth argument, p_mode.
  'app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text, text)':
    [],
  'app_rate_message(uuid, uuid, uuid, integer, boolean, boolean)': [],
  'app_price_lookup(uuid, uuid, uuid, integer, timestamp with time zone, boolean, boolean)': [],
  'app_message_reserve(uuid)': ['acc_app'],
} as const;

describe('Phase 7 PR 7-5 — settlement (migration 0054)', () => {
  let db: Principals;
  let A: TenantFixture;
  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  beforeAll(async () => {
    db = connect();
    A = await createTenant(db.admin, 'p75-a');
  }, 60_000);

  afterAll(async () => {
    if (A) await destroyTenant(db.admin, A);
    await db.close();
  });

  const executors = async (fn: string) =>
    (
      await admin(
        `SELECT r AS role FROM unnest($2::text[]) AS r WHERE has_function_privilege(r, $1, 'EXECUTE')`,
        [fn, APP_ROLES],
      )
    ).rows.map((r) => r.role as string);

  it('the three settlement functions are executable by acc_dispatch only, never PUBLIC', async () => {
    for (const fn of SETTLEMENT) {
      expect([fn, await executors(fn)]).toEqual([fn, ['acc_dispatch']]);
      const pub = await admin(
        `SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0`,
        [fn],
      );
      expect([fn, pub.rows]).toEqual([fn, []]);
    }
  });

  it('the claim helper is executable by no application role', async () => {
    expect(await executors('app_dispatch_billing_claim()')).toEqual([]);
  });

  it('every earlier financial function keeps exactly its grants', async () => {
    for (const [fn, roles] of Object.entries(EARLIER)) {
      expect([fn, await executors(fn)]).toEqual([fn, roles]);
    }
  });

  it('0054 neither redefines nor grants an earlier financial function or table', () => {
    const code = MIGRATION.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(
      /FUNCTION\s+(app_ledger_post|app_rate_message|app_price_lookup|app_message_reserve)\b/i,
    );
    expect(code).not.toMatch(
      /\bON\s+(TABLE\s+)?(usage_ledger|wallets|credit_accounts|pricing_\w+)\b/i,
    );
    expect([...code.matchAll(/\bGRANT\b[^;]*;/gi)].map((m) => m[0]).sort()).toEqual([
      'GRANT EXECUTE ON FUNCTION app_dispatch_attempt_reserve(uuid, integer) TO acc_dispatch;',
      'GRANT EXECUTE ON FUNCTION app_dispatch_attempt_settle(uuid, boolean) TO acc_dispatch;',
      'GRANT EXECUTE ON FUNCTION app_dispatch_message_settle() TO acc_dispatch;',
    ]);
  });

  it('the settlement functions are SECURITY DEFINER with a pinned search_path', async () => {
    for (const fn of SETTLEMENT) {
      const { rows } = await admin(
        `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure`,
        [fn],
      );
      expect([fn, rows[0]]).toEqual([
        fn,
        { prosecdef: true, proconfig: ['search_path=public, pg_temp'] },
      ]);
    }
  });

  it('message_attempt_billing: no application privilege, RLS on, append-only', async () => {
    const { rows } = await admin(
      `SELECT r AS role, p AS priv FROM unnest($1::text[]) AS r,
              unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p
        WHERE has_table_privilege(r, 'message_attempt_billing', p)`,
      [APP_ROLES],
    );
    expect(rows).toEqual([]);
    const rls = await admin(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'message_attempt_billing'::regclass`,
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);

    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      const channel = (await c.query(`SELECT id FROM channels WHERE code = 'whatsapp'`)).rows[0].id;
      const provider = (
        await c.query(
          `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
          [channel, `p75-${uuidv7().slice(-8)}`],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority) VALUES ($1, $2, $3, 1)`,
        [A.orgId, provider, channel],
      );
      const contact = uuidv7();
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
        contact,
        A.orgId,
        A.workspaceId,
      ]);
      const message = uuidv7();
      await c.query(
        `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id)
         VALUES ($1, $2, $3, $4, $5, 'failed', '+12025550177', 'c')`,
        [message, A.orgId, A.workspaceId, contact, channel],
      );
      const attempt = uuidv7();
      await c.query(
        `INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number, fencing_epoch, claim_token, status)
         VALUES ($1, $2, $3, $4, $5, 1, 1, $6, 'failed')`,
        [attempt, message, A.orgId, provider, channel, uuidv7()],
      );
      await c.query(
        `INSERT INTO message_attempt_billing (attempt_id, message_id, org_id, reached_provider) VALUES ($1, $2, $3, true)`,
        [attempt, message, A.orgId],
      );
      for (const statement of [
        `UPDATE message_attempt_billing SET reached_provider = false WHERE attempt_id = '${attempt}'`,
        `DELETE FROM message_attempt_billing WHERE attempt_id = '${attempt}'`,
        `TRUNCATE message_attempt_billing`,
      ]) {
        await c.query('SAVEPOINT s');
        const code = await c.query(statement).then(
          () => 'OK',
          (e: { code?: string }) => e.code,
        );
        await c.query('ROLLBACK TO SAVEPOINT s');
        expect([statement.split(' ')[0], code]).toEqual([statement.split(' ')[0], '42501']);
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
