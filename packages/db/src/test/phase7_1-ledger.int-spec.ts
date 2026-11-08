import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Pool, type PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { runLedgerPartitions } from '../cli/ledger-partitions';
import {
  connect,
  createTenant,
  destroyTenant,
  loadTestEnv,
  type Principals,
  type TenantFixture,
} from './harness';

/**
 * Phase 7 PR 7-1 — migration 0050, the ledger and billing-account foundation
 * (DECISIONS.md §1zi; PR 7-1 design, owner-approved 08-Nov-2026).
 *
 * Covers: partitions and their protections (P-1 … P-9, P-12), the single writer
 * and its allowlist (F-1, F-2, F-4, F-8 … F-10, BL000–BL006), the table
 * constraints C1–C5, the composite and non-cascading foreign keys (safeguard 1),
 * immutability, privileges for every application role on the parent and every
 * partition (safeguard 2), and the permission catalogue and role grants.
 *
 * Almost every case runs in an owner transaction that is always rolled back. The
 * concurrency cases commit; `afterAll` removes their rows in one owner
 * transaction with triggers suspended, as other suites do for append-only
 * tables, because ledger rows are otherwise undeletable by design.
 */

const run = promisify(execFile);
const PACKAGE_ROOT = resolve(__dirname, '../..');
const APP_ROLES = ['acc_app', 'acc_auth', 'acc_relay', 'acc_dispatch', 'acc_delivery'] as const;
const DISABLED_TYPES = ['recharge', 'refund', 'adjustment', 'tax', 'discount', 'reseller_markup'];
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const WRITER =
  'app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text)';

/** A UUIDv7 whose timestamp is `ms` (RFC 9562 layout: 48-bit ms, version 7, variant 10). */
function v7At(ms: number): string {
  const hex = ms.toString(16).padStart(12, '0');
  const rand = uuidv7().replace(/-/g, '').slice(13);
  const s = `${hex}7${rand}`;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

const utcMonth = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;

describe('Phase 7 PR 7-1 — ledger and billing-account foundation (migration 0050)', () => {
  let db: Principals;
  let A: TenantFixture;
  let B: TenantFixture;
  let smsId: string;
  let providerId: string;
  const contact: Record<string, string> = {};
  const committedOrgs: string[] = [];

  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  /** One owner transaction, always rolled back. */
  async function tx<R>(work: (c: PoolClient) => Promise<R>): Promise<R> {
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  /** Runs one statement under a savepoint; returns the SQLSTATE, or 'OK'. */
  async function code(c: PoolClient, text: string, params: unknown[] = []): Promise<string> {
    await c.query('SAVEPOINT s');
    try {
      await c.query(text, params);
      await c.query('RELEASE SAVEPOINT s');
      return 'OK';
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      return (error as { code?: string }).code ?? 'NO_CODE';
    }
  }

  interface Post {
    org: string;
    type: string;
    anchor: string;
    amount: number | null;
    account: 'wallet' | 'credit' | null;
    message: string;
    attempt?: string | null;
  }
  const postSql = `SELECT inserted, ledger_id, amount_paise::bigint AS amount_paise
                     FROM app_ledger_post($1, $2::usage_ledger_entry_type, $3, $4, $5, $6, $7, $8, $9)`;
  const postArgs = (p: Post) => [
    p.org,
    p.type,
    p.anchor,
    p.amount,
    p.account,
    p.message,
    p.attempt ?? null,
    'corr-test',
    null,
  ];
  async function post(c: PoolClient, p: Post) {
    const { rows } = await c.query(postSql, postArgs(p));
    return rows[0] as { inserted: boolean; ledger_id: string | null; amount_paise: string };
  }
  const postCode = (c: PoolClient, p: Post) => code(c, postSql, postArgs(p));

  /** A message (and attempts) planted by the owner in `c`. */
  async function plant(c: PoolClient, t: TenantFixture, attempts = 0) {
    const messageId = uuidv7();
    await c.query(
      `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id)
       VALUES ($1, $2, $3, $4, $5, 'accepted', '+12025550199', $6)`,
      [messageId, t.orgId, t.workspaceId, contact[t.orgId], smsId, uuidv7()],
    );
    const attemptIds: string[] = [];
    for (let n = 1; n <= attempts; n += 1) {
      const id = uuidv7();
      await c.query(
        `INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number, fencing_epoch, claim_token, status)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'accepted')`,
        [id, messageId, t.orgId, providerId, smsId, n, uuidv7()],
      );
      attemptIds.push(id);
    }
    return { messageId, attemptIds };
  }

  async function wallet(c: PoolClient, t: TenantFixture, balance: number, status = 'active') {
    const { rows } = await c.query(
      `INSERT INTO wallets (org_id, balance_paise, status) VALUES ($1, $2, $3) RETURNING id`,
      [t.orgId, balance, status],
    );
    return rows[0].id as string;
  }
  async function credit(c: PoolClient, t: TenantFixture, limit: number) {
    const { rows } = await c.query(
      `INSERT INTO credit_accounts (org_id, credit_limit_paise) VALUES ($1, $2) RETURNING id`,
      [t.orgId, limit],
    );
    return rows[0].id as string;
  }
  async function walletState(c: PoolClient, t: TenantFixture) {
    const { rows } = await c.query(
      `SELECT balance_paise::bigint AS balance, reserved_paise::bigint AS reserved, version::bigint AS version
         FROM wallets WHERE org_id = $1`,
      [t.orgId],
    );
    return {
      balance: Number(rows[0].balance),
      reserved: Number(rows[0].reserved),
      version: Number(rows[0].version),
    };
  }
  /** Fresh ledger derivation of a wallet (BILLING.md §1; ROADMAP §10 derivation test). */
  async function derived(c: PoolClient, walletId: string) {
    const { rows } = await c.query(
      `SELECT COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'reservation'), 0)
              - COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'customer_charge'), 0)
              - COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'reservation_release'), 0) AS reserved,
              COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'customer_charge'), 0) AS charged
         FROM usage_ledger WHERE wallet_id = $1`,
      [walletId],
    );
    return { reserved: Number(rows[0].reserved), charged: Number(rows[0].charged) };
  }

  beforeAll(async () => {
    loadTestEnv();
    db = connect();
    A = await createTenant(db.admin, 'p71-a');
    B = await createTenant(db.admin, 'p71-b');
    smsId = (await admin(`SELECT id FROM channels WHERE code = 'sms'`)).rows[0].id;
    providerId = (
      await admin(
        `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
        [smsId, `p71-provider-${uuidv7().slice(-8)}`],
      )
    ).rows[0].id;
    for (const t of [A, B]) {
      await admin(
        `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority) VALUES ($1, $2, $3, 1)`,
        [t.orgId, providerId, smsId],
      );
      contact[t.orgId] = uuidv7();
      await admin(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
        contact[t.orgId],
        t.orgId,
        t.workspaceId,
      ]);
    }
  }, 120_000);

  afterAll(async () => {
    const orgIds = [A?.orgId, B?.orgId].filter(Boolean) as string[];
    if (orgIds.length > 0) {
      // Ledger rows and accounts are undeletable by design; the owner removes the committed
      // concurrency fixtures with triggers suspended for this one transaction only.
      const c = await db.adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(`DELETE FROM usage_ledger WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query(`DELETE FROM wallets WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query(`DELETE FROM credit_accounts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query(`DELETE FROM message_attempts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query(`DELETE FROM message_events WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query(`DELETE FROM messages WHERE org_id = ANY($1::uuid[])`, [orgIds]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
      await admin(`DELETE FROM contacts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(`DELETE FROM organization_provider_assignments WHERE org_id = ANY($1::uuid[])`, [
        orgIds,
      ]);
    }
    if (providerId) await admin(`DELETE FROM providers WHERE id = $1`, [providerId]);
    if (A) await destroyTenant(db.admin, A);
    if (B) await destroyTenant(db.admin, B);
    expect(committedOrgs.every((o) => orgIds.includes(o))).toBe(true);
    await db.close();
  }, 120_000);

  // ---------------------------------------------------------------------------
  describe('app_uuidv7_month (P-12)', () => {
    it('matches the month of database and application UUIDv7 ids; NULL for non-v7 and NULL', async () => {
      const appId = uuidv7();
      const { rows } = await admin(
        `SELECT app_uuidv7_month(uuidv7())::text AS db_month,
                date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS now_month,
                app_uuidv7_month($1)::text AS app_month,
                app_uuidv7_month(gen_random_uuid()) AS v4,
                app_uuidv7_month(NULL) AS nul`,
        [appId],
      );
      expect(rows[0]).toEqual({
        db_month: rows[0].now_month,
        now_month: utcMonth(new Date()),
        app_month: rows[0].now_month,
        v4: null,
        nul: null,
      });
    });

    it('is exact at month boundaries (UTC, integer milliseconds)', async () => {
      const last = Date.UTC(2027, 0, 31, 23, 59, 59, 999);
      const first = Date.UTC(2027, 1, 1, 0, 0, 0, 0);
      const { rows } = await admin(
        `SELECT app_uuidv7_month($1)::text AS a, app_uuidv7_month($2)::text AS b`,
        [v7At(last), v7At(first)],
      );
      expect(rows[0]).toEqual({ a: '2027-01-01', b: '2027-02-01' });
    });

    it('is IMMUTABLE, STRICT and never uses uuid_extract_timestamp', async () => {
      const { rows } = await admin(
        `SELECT provolatile, proisstrict, prosrc FROM pg_proc WHERE proname = 'app_uuidv7_month'`,
      );
      expect(rows[0].provolatile).toBe('i');
      expect(rows[0].proisstrict).toBe(true);
      expect(rows[0].prosrc).not.toContain('uuid_extract_timestamp');
    });
  });

  // ---------------------------------------------------------------------------
  describe('partitions and their protections (OD-7-3, RQ-4, RQ-5, RQ-6; safeguard 2)', () => {
    it('P-1: the current month and the next 24 exist, contiguous, attached and fully protected; no DEFAULT partition', async () => {
      const { rows } = await admin(
        `SELECT partition_name, range_start::text AS range_start, attached, truncate_guarded, row_guarded,
                rls_enabled, privileges_restricted FROM app_ledger_partition_report()`,
      );
      const now = new Date();
      const expected = Array.from({ length: 25 }, (_, i) =>
        utcMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))),
      );
      const starts = rows.filter((r) => r.attached).map((r) => r.range_start as string);
      expect(starts.slice(0, 25)).toEqual(expected);
      for (const r of rows) {
        expect([
          r.partition_name,
          r.attached,
          r.truncate_guarded,
          r.row_guarded,
          r.rls_enabled,
          r.privileges_restricted,
        ]).toEqual([r.partition_name, true, true, true, true, true]);
      }
      const def = await admin(
        `SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'usage_ledger'::regclass AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
      );
      expect(def.rows[0].n).toBe(0);
    });

    it('P-2: ensure is idempotent and safe from two sessions at once', async () => {
      const again = await admin(
        `SELECT action, count(*)::int AS n FROM app_ledger_ensure_partitions(24) GROUP BY action`,
      );
      expect(again.rows).toEqual([{ action: 'exists', n: 25 }]);
      const [x, y] = await Promise.all([
        tx((c) =>
          c.query(
            `SELECT count(*)::int AS n FROM app_ledger_ensure_partitions(30) WHERE action = 'created'`,
          ),
        ),
        tx((c) =>
          c.query(
            `SELECT count(*)::int AS n FROM app_ledger_ensure_partitions(30) WHERE action = 'created'`,
          ),
        ),
      ]);
      // Both rolled back; each created the six months beyond 24 in its own transaction,
      // one after the other (the advisory lock serialises them), with no error.
      expect([x.rows[0].n, y.rows[0].n]).toEqual([6, 6]);
    });

    it('P-3: creates new months while another session holds an open ledger insert; waits (bounded) only on writers to the FK-referenced tables', async () => {
      // A committed message and attempt, so the holder's open transaction writes only the ledger.
      committedOrgs.push(A.orgId);
      const holderSetup = await db.adminPool.connect();
      let m: { messageId: string; attemptIds: string[] };
      try {
        await holderSetup.query('BEGIN');
        m = await plant(holderSetup, A, 1);
        await holderSetup.query('COMMIT');
      } finally {
        holderSetup.release();
      }
      const ensure28 = () =>
        tx(async (c) => {
          await c.query(`SET LOCAL lock_timeout = '2s'`);
          return (
            await c.query(
              `SELECT count(*)::int AS n FROM app_ledger_ensure_partitions(28) WHERE action = 'created'`,
            )
          ).rows[0].n as number;
        });
      const holder = await db.adminPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          postSql,
          postArgs({
            org: A.orgId,
            type: 'provider_cost',
            anchor: m.attemptIds[0]!,
            amount: 5,
            account: null,
            message: m.messageId,
            attempt: m.attemptIds[0]!,
          }),
        );
        // An open ledger insert (RowShare on messages, message_attempts) does not hold up ATTACH.
        expect(await ensure28()).toBe(4);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      // An open write to a referenced table (here messages) does: ATTACH clones the foreign keys,
      // which needs SHARE ROW EXCLUSIVE on the referenced tables. The lock timeout bounds the wait,
      // and the failed ensure leaves nothing behind.
      const writer = await db.adminPool.connect();
      try {
        await writer.query('BEGIN');
        await plant(writer, A);
        const before = (
          await admin(
            `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'usage_ledger'::regclass`,
          )
        ).rows[0].n;
        await expect(ensure28()).rejects.toMatchObject({ code: '55P03' });
        expect(
          (
            await admin(
              `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'usage_ledger'::regclass`,
            )
          ).rows[0].n,
        ).toBe(before);
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
    });

    it('P-4: a failure part-way leaves nothing behind, and an unattached same-named table is refused and reported', async () => {
      await tx(async (c) => {
        const before = (
          await c.query(
            `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'usage_ledger'::regclass`,
          )
        ).rows[0].n;
        const now = new Date();
        const m30 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 30, 1));
        const orphan = `usage_ledger_p${m30.getUTCFullYear()}${String(m30.getUTCMonth() + 1).padStart(2, '0')}`;
        await c.query(`CREATE TABLE ${orphan} (id uuid)`);
        expect(await code(c, `SELECT * FROM app_ledger_ensure_partitions(36)`)).toBe('55000');
        const after = (
          await c.query(
            `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'usage_ledger'::regclass`,
          )
        ).rows[0].n;
        expect(after).toBe(before); // months 25..29, created before the refusal, were rolled back
        const report = (
          await c.query(`SELECT * FROM app_ledger_partition_report() WHERE partition_name = $1`, [
            orphan,
          ])
        ).rows;
        expect(report).toHaveLength(1);
        expect(report[0].attached).toBe(false);
      });
    });

    it('P-5/P-6: TRUNCATE, UPDATE and DELETE are refused on the parent, on every partition and on a partition created later', async () => {
      await tx(async (c) => {
        await c.query(`SELECT * FROM app_ledger_ensure_partitions(26)`);
        const m = await plant(c, A);
        await wallet(c, A, 1000);
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 10,
          account: 'wallet',
          message: m.messageId,
        });
        expect(await code(c, `TRUNCATE usage_ledger`)).toBe('42501');
        const parts = (
          await c.query(
            `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'usage_ledger'::regclass`,
          )
        ).rows;
        expect(parts.length).toBe(27);
        for (const { relname } of parts) {
          expect([relname, await code(c, `TRUNCATE ${relname}`)]).toEqual([relname, '42501']);
        }
        const month = utcMonth(new Date()).replace(/-/g, '').slice(0, 6);
        expect(await code(c, `UPDATE usage_ledger SET amount_paise = 1`)).toBe('42501');
        expect(await code(c, `DELETE FROM usage_ledger`)).toBe('42501');
        expect(await code(c, `UPDATE usage_ledger_p${month} SET amount_paise = 1`)).toBe('42501');
        expect(await code(c, `DELETE FROM usage_ledger_p${month}`)).toBe('42501');
      });
    });

    it('P-7: no application role has any privilege on the parent or on any partition, nor on the accounts', async () => {
      const tables = (
        await admin(
          `SELECT 'usage_ledger' AS t UNION ALL SELECT 'wallets' UNION ALL SELECT 'credit_accounts'
           UNION ALL SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'usage_ledger'::regclass`,
        )
      ).rows.map((r) => r.t as string);
      expect(tables.length).toBe(28);
      const granted: string[] = [];
      for (const role of APP_ROLES) {
        for (const table of tables) {
          for (const p of PRIVILEGES) {
            const { rows } = await admin(`SELECT has_table_privilege($1, $2, $3) AS ok`, [
              role,
              `public.${table}`,
              p,
            ]);
            if (rows[0].ok) granted.push(`${role}:${table}:${p}`);
          }
        }
      }
      expect(granted).toEqual([]);
    });

    it('P-7: only the owner may execute the partition routine or the writer; acc_app may execute only the read-only report', async () => {
      const fns = [
        'app_ledger_ensure_partitions(integer)',
        'app_ledger_partition_report()',
        WRITER,
      ];
      const result: Record<string, string[]> = {};
      for (const fn of fns) {
        result[fn] = [];
        for (const role of [...APP_ROLES, 'public']) {
          const { rows } = await admin(
            role === 'public'
              ? `SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                    WHERE p.oid = $1::regprocedure AND a.grantee = 0) AS ok`
              : `SELECT has_function_privilege($2, $1::regprocedure, 'EXECUTE') AS ok`,
            role === 'public' ? [fn] : [fn, role],
          );
          if (rows[0].ok) result[fn]!.push(role);
        }
      }
      expect(result).toEqual({
        'app_ledger_ensure_partitions(integer)': [],
        'app_ledger_partition_report()': ['acc_app'],
        [WRITER]: [],
      });
    });

    it('P-7: as acc_app, the report works, partition creation is refused and the ledger is unreachable', async () => {
      const c = await db.appPool.connect();
      try {
        await c.query('BEGIN');
        const report = (await c.query(`SELECT * FROM app_ledger_partition_report()`)).rows;
        expect(report.length).toBeGreaterThanOrEqual(25);
        // The invoker's view of the catalogue matches the owner's: same rows, all protected.
        expect(
          report.every(
            (r) =>
              r.attached &&
              r.truncate_guarded &&
              r.row_guarded &&
              r.rls_enabled &&
              r.privileges_restricted,
          ),
        ).toBe(true);
        expect(await code(c, `SELECT * FROM app_ledger_ensure_partitions(24)`)).toBe('42501');
        expect(await code(c, `SELECT * FROM app_ledger_ensure_partitions(0)`)).toBe('42501');
        for (const t of ['usage_ledger', 'wallets', 'credit_accounts']) {
          expect([t, await code(c, `SELECT 1 FROM ${t} LIMIT 1`)]).toEqual([t, '42501']);
        }
        expect(
          await code(
            c,
            `SELECT * FROM app_ledger_post(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
          ),
        ).toBe('42501');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('P-8: an anchor in a month without a partition fails closed', async () => {
      await tx(async (c) => {
        const far = v7At(Date.UTC(2040, 0, 15));
        const r = await code(
          c,
          `INSERT INTO usage_ledger (anchor_month, anchor_id, fact_kind, entry_type, org_id, amount_paise)
           VALUES (app_uuidv7_month($1), $1, 'adjustment', 'adjustment', $2, 1)`,
          [far, A.orgId],
        );
        expect(r).toBe('23514'); // no partition of relation found for row
      });
    });

    it('P-9: the report detects a missing TRUNCATE guard, row security or a stray grant on a partition', async () => {
      await tx(async (c) => {
        const month = utcMonth(new Date()).replace(/-/g, '').slice(0, 6);
        const p = `usage_ledger_p${month}`;
        await c.query(`DROP TRIGGER trg_usage_ledger_no_truncate ON ${p}`);
        await c.query(`ALTER TABLE ${p} DISABLE ROW LEVEL SECURITY`);
        await c.query(`GRANT SELECT ON ${p} TO acc_app`);
        const r = (
          await c.query(`SELECT * FROM app_ledger_partition_report() WHERE partition_name = $1`, [
            p,
          ])
        ).rows[0];
        expect([r.truncate_guarded, r.rls_enabled, r.privileges_restricted, r.row_guarded]).toEqual(
          [false, false, false, true],
        );
      });
    });

    it('RLS is enabled with no policy on the parent, the accounts and every partition', async () => {
      const { rows } = await admin(
        `SELECT c.relname, c.relrowsecurity,
                (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c
          WHERE c.relname IN ('usage_ledger', 'wallets', 'credit_accounts')
             OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'usage_ledger'::regclass)`,
      );
      expect(rows.length).toBe(28);
      for (const r of rows)
        expect([r.relname, r.relrowsecurity, r.policies]).toEqual([r.relname, true, 0]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('owner-only creation: invariant D, db:migrate and the operator command (owner decision 08-Nov-2026)', () => {
    it('invariant D holds: the partition routine and report are SECURITY INVOKER; only the writer is SECURITY DEFINER', async () => {
      const { rows } = await admin(
        `SELECT proname, prosecdef FROM pg_proc
          WHERE proname IN ('app_ledger_ensure_partitions', 'app_ledger_partition_report', 'app_ledger_post',
                            'app_uuidv7_month', 'fn_billing_immutable')
          ORDER BY proname`,
      );
      expect(rows).toEqual([
        { proname: 'app_ledger_ensure_partitions', prosecdef: false },
        { proname: 'app_ledger_partition_report', prosecdef: false },
        { proname: 'app_ledger_post', prosecdef: true },
        { proname: 'app_uuidv7_month', prosecdef: false },
        { proname: 'fn_billing_immutable', prosecdef: false },
      ]);
    });

    it('db:migrate is idempotent: re-runs verify every migration, create no partition and keep 25 protected months', async () => {
      const count = async () =>
        (
          await admin(
            `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'usage_ledger'::regclass`,
          )
        ).rows[0].n;
      const before = await count();
      for (let i = 0; i < 2; i += 1) {
        const { stdout } = await run('npx', ['tsx', 'src/cli/migrate.ts'], {
          cwd: PACKAGE_ROOT,
          env: process.env,
          timeout: 300_000,
        });
        expect(stdout).toContain('Schema up to date (53 migrations verified).');
        expect(stdout).toContain('Ledger partitions: created 0 partition(s).');
        expect(stdout).toMatch(
          /usage_ledger partitions ok: headroom 24 month\(s\); 25 partition\(s\); no gaps; all protected; no orphans/,
        );
      }
      expect(await count()).toBe(before);
    }, 600_000);

    it('final review: a failed ensure with insufficient coverage fails db:migrate and the operator command visibly', async () => {
      const partitions = async () =>
        (
          await admin(
            `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
              WHERE i.inhparent = 'usage_ledger'::regclass ORDER BY c.relname`,
          )
        ).rows.map((r) => r.relname as string);
      const all = await partitions();
      expect(all).toHaveLength(25);
      // Keep the current and next month only: one month of headroom, below the critical threshold.
      const now = new Date();
      const keep = new Set(
        [0, 1].map((i) => {
          const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
          return `usage_ledger_p${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        }),
      );
      try {
        for (const p of all) if (!keep.has(p)) await admin(`DROP TABLE ${p}`);
        // A transaction writing messages holds the lock ATTACH needs, so every ensure fails.
        const writer = await db.adminPool.connect();
        try {
          await writer.query('BEGIN');
          await plant(writer, A);
          const failure = (await run('npx', ['tsx', 'src/cli/migrate.ts'], {
            cwd: PACKAGE_ROOT,
            env: process.env,
            timeout: 300_000,
          }).then(
            () => null,
            (error: unknown) => error,
          )) as { code?: number; stdout?: string; stderr?: string } | null;
          expect(failure).not.toBeNull();
          expect(failure!.code).toBe(1);
          expect(failure!.stderr).toMatch(/Ledger partition ensure failed: .*lock timeout/);
          expect(failure!.stderr).toMatch(
            /Refusing: usage_ledger partitions critical: headroom 1 month\(s\); 2 partition\(s\)/,
          );
          expect(`${failure!.stdout}${failure!.stderr}`).not.toMatch(/usage_ledger partitions ok/);

          const lines: string[] = [];
          expect(
            await runLedgerPartitions(db.adminPool, { kind: 'ensure', monthsAhead: 24 }, (l) =>
              lines.push(l),
            ),
          ).toBe(false);
          expect(lines.some((l) => /^ensure failed: .*lock timeout/.test(l))).toBe(true);
          expect(
            lines.some((l) => /^usage_ledger partitions critical: headroom 1 month/.test(l)),
          ).toBe(true);
          const checkLines: string[] = [];
          expect(
            await runLedgerPartitions(db.adminPool, { kind: 'check' }, (l) => checkLines.push(l)),
          ).toBe(false);
          expect(checkLines.some((l) => /^usage_ledger partitions critical/.test(l))).toBe(true);
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
      } finally {
        // Restore the 25 months through the operator command.
        const restored: string[] = [];
        expect(
          await runLedgerPartitions(db.adminPool, { kind: 'ensure', monthsAhead: 24 }, (l) =>
            restored.push(l),
          ),
        ).toBe(true);
        expect(await partitions()).toEqual(all);
      }
    }, 300_000);

    it('the operator command ensures as the owner and is refused under acc_app', async () => {
      const lines: string[] = [];
      expect(
        await runLedgerPartitions(db.adminPool, { kind: 'ensure', monthsAhead: 24 }, (l) =>
          lines.push(l),
        ),
      ).toBe(true);
      expect(lines).toContain('created 0 partition(s)');
      expect(await runLedgerPartitions(db.adminPool, { kind: 'check' }, () => undefined)).toBe(
        true,
      );

      const appLines: string[] = [];
      expect(
        await runLedgerPartitions(db.appPool, { kind: 'ensure', monthsAhead: 24 }, (l) =>
          appLines.push(l),
        ),
      ).toBe(false);
      expect(
        appLines.some((l) =>
          /ensure failed: permission denied for function app_ledger_ensure_partitions/.test(l),
        ),
      ).toBe(true);
      // --check is read-only and works under acc_app; nothing was created by the refused run.
      expect(await runLedgerPartitions(db.appPool, { kind: 'check' }, () => undefined)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('integrity: no cascading deletion, immutability (safeguard 1)', () => {
    it('every foreign key on or into the financial tables is ON DELETE RESTRICT; none cascades', async () => {
      const { rows } = await admin(
        `SELECT DISTINCT conname, confdeltype FROM pg_constraint
          WHERE contype = 'f'
            AND (conrelid IN ('usage_ledger'::regclass, 'wallets'::regclass, 'credit_accounts'::regclass)
                 OR confrelid IN ('usage_ledger'::regclass, 'wallets'::regclass, 'credit_accounts'::regclass)
                 OR conrelid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'usage_ledger'::regclass))`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(8);
      for (const r of rows) expect([r.conname, r.confdeltype]).toEqual([r.conname, 'r']);
    });

    it('a billed message, its attempt and a funded organization cannot be deleted; nor can an account', async () => {
      await tx(async (c) => {
        const m = await plant(c, A, 1);
        await wallet(c, A, 1000);
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 10,
          account: 'wallet',
          message: m.messageId,
        });
        await post(c, {
          org: A.orgId,
          type: 'provider_cost',
          anchor: m.attemptIds[0]!,
          amount: 3,
          account: null,
          message: m.messageId,
          attempt: m.attemptIds[0]!,
        });
        expect(
          await code(c, `DELETE FROM message_attempts WHERE id = $1`, [m.attemptIds[0]]),
        ).not.toBe('OK');
        expect(await code(c, `DELETE FROM messages WHERE id = $1`, [m.messageId])).not.toBe('OK');
        expect(await code(c, `DELETE FROM organizations WHERE id = $1`, [A.orgId])).not.toBe('OK');
        expect(await code(c, `DELETE FROM wallets WHERE org_id = $1`, [A.orgId])).toBe('42501');
        // Refused either by the FK from usage_ledger (0A000) or by the guard (42501).
        expect(await code(c, `TRUNCATE wallets`)).toMatch(/^(0A000|42501)$/);
        expect(await code(c, `TRUNCATE credit_accounts`)).toMatch(/^(0A000|42501)$/);
        const guards = await c.query(
          `SELECT tgrelid::regclass::text AS t FROM pg_trigger
            WHERE tgfoid = 'fn_billing_immutable()'::regprocedure AND tgrelid IN ('wallets'::regclass, 'credit_accounts'::regclass)
            ORDER BY 1`,
        );
        expect(guards.rows.map((r) => r.t)).toEqual([
          'credit_accounts',
          'credit_accounts',
          'wallets',
          'wallets',
        ]);
      });
    });

    it('accounts keep their organization and their non-negative balances', async () => {
      await tx(async (c) => {
        const w = await wallet(c, A, 5);
        expect(
          await code(c, `UPDATE wallets SET org_id = $1 WHERE id = $2`, [B.orgId, w]),
        ).not.toBe('OK');
        expect(await code(c, `UPDATE wallets SET balance_paise = -1 WHERE id = $1`, [w])).toBe(
          '23514',
        );
        expect(await code(c, `UPDATE wallets SET reserved_paise = -1 WHERE id = $1`, [w])).toBe(
          '23514',
        );
        expect(await code(c, `UPDATE wallets SET currency = 'USD' WHERE id = $1`, [w])).toBe(
          '23514',
        );
        expect(
          await code(
            c,
            `INSERT INTO credit_accounts (org_id, credit_limit_paise) VALUES ($1, -1)`,
            [A.orgId],
          ),
        ).toBe('23514');
        expect(await code(c, `INSERT INTO wallets (org_id) VALUES ($1)`, [A.orgId])).toBe('23505');
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('table constraints C1–C5 and composite foreign keys', () => {
    const insert = `INSERT INTO usage_ledger (anchor_month, anchor_id, fact_kind, entry_type, org_id, message_id,
                      message_attempt_id, wallet_id, credit_account_id, amount_paise, currency)
                    VALUES ($1, $2, $3, $4::usage_ledger_entry_type, $5, $6, $7, $8, $9, $10, $11)`;

    it('C1–C5, amount and currency are each enforced, each by its own constraint', async () => {
      await tx(async (c) => {
        const w = await wallet(c, A, 1000);
        const cr = await credit(c, A, 1000);
        const monthOf = async (id: string) =>
          (await c.query(`SELECT app_uuidv7_month($1)::text AS m`, [id])).rows[0].m as string;
        const next = (month: string) => {
          const d = new Date(`${month}T00:00:00Z`);
          d.setUTCMonth(d.getUTCMonth() + 1);
          return utcMonth(d);
        };
        /** Inserts directly as the owner; returns 'OK' or `<sqlstate>:<constraint>`. */
        const row = async (r: {
          month?: string;
          anchor: string;
          fact?: string;
          type: string;
          message?: string | null;
          attempt?: string | null;
          wallet?: string | null;
          credit?: string | null;
          amount?: number;
          currency?: string;
        }) => {
          await c.query('SAVEPOINT s');
          try {
            await c.query(insert, [
              r.month ?? (await monthOf(r.anchor)),
              r.anchor,
              r.fact ?? r.type,
              r.type,
              A.orgId,
              r.message ?? null,
              r.attempt ?? null,
              r.wallet ?? null,
              r.credit ?? null,
              r.amount ?? 10,
              r.currency ?? 'INR',
            ]);
            await c.query('RELEASE SAVEPOINT s');
            return 'OK';
          } catch (error) {
            await c.query('ROLLBACK TO SAVEPOINT s');
            const e = error as { code?: string; constraint?: string };
            return `${e.code}:${e.constraint}`;
          }
        };
        const fresh = async () => plant(c, A, 1);

        let m = await fresh();
        expect(
          await row({ anchor: m.messageId, type: 'reservation', message: m.messageId, wallet: w }),
        ).toBe('OK');

        m = await fresh();
        expect(
          await row({
            month: next(await monthOf(m.messageId)),
            anchor: m.messageId,
            type: 'reservation',
            message: m.messageId,
            wallet: w,
          }),
        ).toBe('23514:usage_ledger_anchor_month');
        const v4 = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
        expect(
          await row({
            month: await monthOf(m.messageId),
            anchor: v4,
            type: 'adjustment',
            wallet: w,
          }),
        ).toBe('23514:usage_ledger_anchor_month');

        m = await fresh();
        expect(
          await row({
            anchor: m.messageId,
            fact: 'customer_charge',
            type: 'reservation',
            message: m.messageId,
            wallet: w,
          }),
        ).toBe('23514:usage_ledger_fact_kind');
        expect(await row({ anchor: m.messageId, fact: 'tax', type: 'tax', wallet: w })).toBe(
          '23514:usage_ledger_fact_kind',
        );
        expect(await row({ anchor: m.messageId, fact: 'tax:', type: 'tax', wallet: w })).toBe(
          '23514:usage_ledger_fact_kind',
        );
        expect(await row({ anchor: m.messageId, fact: 'tax:1', type: 'tax', wallet: w })).toBe(
          'OK',
        );

        m = await fresh();
        expect(
          await row({
            anchor: m.messageId,
            type: 'reservation',
            message: m.messageId,
            wallet: w,
            credit: cr,
          }),
        ).toMatch(/^23514:usage_ledger_(one_account|account_presence)$/);
        expect(await row({ anchor: m.messageId, type: 'reservation', message: m.messageId })).toBe(
          '23514:usage_ledger_account_presence',
        );
        expect(
          await row({
            anchor: m.attemptIds[0]!,
            type: 'provider_cost',
            message: m.messageId,
            attempt: m.attemptIds[0]!,
            wallet: w,
          }),
        ).toBe('23514:usage_ledger_account_presence');

        m = await fresh();
        expect(
          await row({
            anchor: m.attemptIds[0]!,
            type: 'reservation',
            message: m.messageId,
            wallet: w,
          }),
        ).toBe('23514:usage_ledger_message_linkage');
        expect(
          await row({ anchor: m.messageId, type: 'provider_cost', message: m.messageId }),
        ).toBe('23514:usage_ledger_message_linkage');
        expect(
          await row({
            anchor: m.attemptIds[0]!,
            type: 'reservation_release',
            message: m.messageId,
            attempt: m.attemptIds[0]!,
            wallet: w,
          }),
        ).toBe('23514:usage_ledger_message_linkage');
        expect(
          await row({
            anchor: m.messageId,
            type: 'reservation',
            attempt: m.attemptIds[0]!,
            wallet: w,
          }),
        ).toBe('23514:usage_ledger_message_linkage');

        m = await fresh();
        expect(
          await row({
            anchor: m.messageId,
            type: 'reservation',
            message: m.messageId,
            wallet: w,
            amount: 0,
          }),
        ).toBe('23514:usage_ledger_amount_positive');
        expect(
          await row({
            anchor: m.messageId,
            type: 'reservation',
            message: m.messageId,
            wallet: w,
            amount: -5,
          }),
        ).toBe('23514:usage_ledger_amount_positive');
        expect(
          await row({
            anchor: m.messageId,
            type: 'reservation',
            message: m.messageId,
            wallet: w,
            currency: 'USD',
          }),
        ).toBe('23514:usage_ledger_currency_inr');
      });
    });

    it('composite foreign keys keep message, attempt and account in one organization', async () => {
      await tx(async (c) => {
        const mA = await plant(c, A, 1);
        const mB = await plant(c, B, 1);
        const wB = await wallet(c, B, 1000);
        const month = (await c.query(`SELECT app_uuidv7_month($1) AS m`, [mA.messageId])).rows[0].m;
        // A's message billed to B's wallet.
        expect(
          await code(c, insert, [
            month,
            mA.messageId,
            'reservation',
            'reservation',
            A.orgId,
            mA.messageId,
            null,
            wB,
            null,
            1,
            'INR',
          ]),
        ).toBe('23503');
        // B's message under A's organization.
        const mBMonth = (await c.query(`SELECT app_uuidv7_month($1) AS m`, [mB.messageId])).rows[0]
          .m;
        const wA = await wallet(c, A, 1000);
        expect(
          await code(c, insert, [
            mBMonth,
            mB.messageId,
            'reservation',
            'reservation',
            A.orgId,
            mB.messageId,
            null,
            wA,
            null,
            1,
            'INR',
          ]),
        ).toBe('23503');
        // B's attempt under A's message.
        const aMonth = (await c.query(`SELECT app_uuidv7_month($1) AS m`, [mB.attemptIds[0]]))
          .rows[0].m;
        expect(
          await code(c, insert, [
            aMonth,
            mB.attemptIds[0],
            'provider_cost',
            'provider_cost',
            A.orgId,
            mA.messageId,
            mB.attemptIds[0],
            null,
            null,
            1,
            'INR',
          ]),
        ).toBe('23503');
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('the single writer app_ledger_post (OD-7-2, allowlist, BL000–BL006)', () => {
    it('refuses every entry type outside the allowlist with BL000', async () => {
      await tx(async (c) => {
        const m = await plant(c, A);
        await wallet(c, A, 1000);
        for (const type of DISABLED_TYPES) {
          expect([
            type,
            await postCode(c, {
              org: A.orgId,
              type,
              anchor: m.messageId,
              amount: 1,
              account: 'wallet',
              message: m.messageId,
            }),
          ]).toEqual([type, 'BL000']);
        }
        expect(
          (
            await c.query(`SELECT count(*)::int AS n FROM usage_ledger WHERE org_id = $1`, [
              A.orgId,
            ])
          ).rows[0].n,
        ).toBe(0);
      });
    });

    it('validates its arguments (22023) before reading or locking anything', async () => {
      await tx(async (c) => {
        const m = await plant(c, A, 1);
        const mB = await plant(c, B, 1);
        await wallet(c, A, 1000);
        const base = { org: A.orgId, anchor: m.messageId, message: m.messageId };
        const bad: Array<[string, Post]> = [
          [
            'release with an amount (F-10)',
            { ...base, type: 'reservation_release', amount: 5, account: 'wallet' },
          ],
          ['zero amount', { ...base, type: 'reservation', amount: 0, account: 'wallet' }],
          ['no account', { ...base, type: 'reservation', amount: 5, account: null }],
          [
            'provider_cost with account',
            {
              ...base,
              type: 'provider_cost',
              anchor: m.attemptIds[0]!,
              attempt: m.attemptIds[0]!,
              amount: 5,
              account: 'wallet',
            },
          ],
          [
            'provider_cost without attempt',
            { ...base, type: 'provider_cost', amount: 5, account: null },
          ],
          [
            'anchor mismatch',
            {
              ...base,
              type: 'reservation',
              anchor: m.attemptIds[0]!,
              amount: 5,
              account: 'wallet',
            },
          ],
          [
            'release on attempt',
            {
              ...base,
              type: 'reservation_release',
              anchor: m.attemptIds[0]!,
              attempt: m.attemptIds[0]!,
              amount: null,
              account: 'wallet',
            },
          ],
          [
            'other organization message',
            {
              org: A.orgId,
              anchor: mB.messageId,
              message: mB.messageId,
              type: 'reservation',
              amount: 5,
              account: 'wallet',
            },
          ],
          [
            'other message attempt',
            {
              ...base,
              type: 'provider_cost',
              anchor: mB.attemptIds[0]!,
              attempt: mB.attemptIds[0]!,
              amount: 5,
              account: null,
            },
          ],
        ];
        for (const [label, p] of bad)
          expect([label, await postCode(c, p)]).toEqual([label, '22023']);
      });
    });

    it('wallet: reservation, charge and computed release with exactly-once effects (F-1, F-2, F-10)', async () => {
      await tx(async (c) => {
        const m = await plant(c, A, 1);
        const w = await wallet(c, A, 1000);
        const r1 = await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 300,
          account: 'wallet',
          message: m.messageId,
        });
        expect(r1.inserted).toBe(true);
        const r1again = await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 300,
          account: 'wallet',
          message: m.messageId,
        });
        expect([r1again.inserted, r1again.ledger_id]).toEqual([false, r1.ledger_id]);
        expect(await walletState(c, A)).toEqual({ balance: 1000, reserved: 300, version: 1 });
        // Provider cost: a separate fact, no account effect.
        const pc = await post(c, {
          org: A.orgId,
          type: 'provider_cost',
          anchor: m.attemptIds[0]!,
          amount: 120,
          account: null,
          message: m.messageId,
          attempt: m.attemptIds[0]!,
        });
        expect(pc.inserted).toBe(true);
        expect(await walletState(c, A)).toEqual({ balance: 1000, reserved: 300, version: 1 });
        // Per-message charge, then its retry.
        expect(
          (
            await post(c, {
              org: A.orgId,
              type: 'customer_charge',
              anchor: m.messageId,
              amount: 250,
              account: 'wallet',
              message: m.messageId,
            })
          ).inserted,
        ).toBe(true);
        expect(
          (
            await post(c, {
              org: A.orgId,
              type: 'customer_charge',
              anchor: m.messageId,
              amount: 250,
              account: 'wallet',
              message: m.messageId,
            })
          ).inserted,
        ).toBe(false);
        expect(await walletState(c, A)).toEqual({ balance: 750, reserved: 50, version: 2 });
        // Release: computed (300 − 250 = 50), then a no-op on retry.
        const rel = await post(c, {
          org: A.orgId,
          type: 'reservation_release',
          anchor: m.messageId,
          amount: null,
          account: 'wallet',
          message: m.messageId,
        });
        expect([rel.inserted, Number(rel.amount_paise)]).toEqual([true, 50]);
        const relAgain = await post(c, {
          org: A.orgId,
          type: 'reservation_release',
          anchor: m.messageId,
          amount: null,
          account: 'wallet',
          message: m.messageId,
        });
        expect([relAgain.inserted, Number(relAgain.amount_paise)]).toEqual([false, 50]);
        expect(await walletState(c, A)).toEqual({ balance: 750, reserved: 0, version: 3 });
        expect(await derived(c, w)).toEqual({ reserved: 0, charged: 250 });
        // F-2: four distinct facts, each identifiable by (anchor_id, fact_kind).
        const facts = (
          await c.query(
            `SELECT anchor_id, fact_kind FROM usage_ledger WHERE org_id = $1 ORDER BY fact_kind`,
            [A.orgId],
          )
        ).rows;
        expect(facts).toEqual([
          { anchor_id: m.messageId, fact_kind: 'customer_charge' },
          { anchor_id: m.attemptIds[0], fact_kind: 'provider_cost' },
          { anchor_id: m.messageId, fact_kind: 'reservation' },
          { anchor_id: m.messageId, fact_kind: 'reservation_release' },
        ]);
        // Once released, no new reservation or charge for the message (BL004); retries stay no-ops.
        expect(
          await postCode(c, {
            org: A.orgId,
            type: 'customer_charge',
            anchor: m.attemptIds[0]!,
            attempt: m.attemptIds[0]!,
            amount: 1,
            account: 'wallet',
            message: m.messageId,
          }),
        ).toBe('BL004');
        expect(
          (
            await post(c, {
              org: A.orgId,
              type: 'reservation',
              anchor: m.messageId,
              amount: 300,
              account: 'wallet',
              message: m.messageId,
            })
          ).inserted,
        ).toBe(false);
      });
    });

    it('per-attempt policy shape: reservation extension on an attempt (RQ-2) and per-attempt charges', async () => {
      await tx(async (c) => {
        const m = await plant(c, A, 2);
        const w = await wallet(c, A, 1000);
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 100,
          account: 'wallet',
          message: m.messageId,
        });
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.attemptIds[1]!,
          attempt: m.attemptIds[1]!,
          amount: 100,
          account: 'wallet',
          message: m.messageId,
        });
        await post(c, {
          org: A.orgId,
          type: 'customer_charge',
          anchor: m.attemptIds[0]!,
          attempt: m.attemptIds[0]!,
          amount: 100,
          account: 'wallet',
          message: m.messageId,
        });
        await post(c, {
          org: A.orgId,
          type: 'customer_charge',
          anchor: m.attemptIds[1]!,
          attempt: m.attemptIds[1]!,
          amount: 80,
          account: 'wallet',
          message: m.messageId,
        });
        const rel = await post(c, {
          org: A.orgId,
          type: 'reservation_release',
          anchor: m.messageId,
          amount: null,
          account: 'wallet',
          message: m.messageId,
        });
        expect(Number(rel.amount_paise)).toBe(20);
        expect(await walletState(c, A)).toMatchObject({ balance: 820, reserved: 0 });
        expect(await derived(c, w)).toEqual({ reserved: 0, charged: 180 });
      });
    });

    it('a fully charged message releases nothing and writes no row', async () => {
      await tx(async (c) => {
        const m = await plant(c, A);
        await wallet(c, A, 1000);
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 40,
          account: 'wallet',
          message: m.messageId,
        });
        await post(c, {
          org: A.orgId,
          type: 'customer_charge',
          anchor: m.messageId,
          amount: 40,
          account: 'wallet',
          message: m.messageId,
        });
        const rel = await post(c, {
          org: A.orgId,
          type: 'reservation_release',
          anchor: m.messageId,
          amount: null,
          account: 'wallet',
          message: m.messageId,
        });
        expect([rel.inserted, rel.ledger_id, Number(rel.amount_paise)]).toEqual([false, null, 0]);
        expect(
          (
            await c.query(
              `SELECT count(*)::int AS n FROM usage_ledger WHERE message_id = $1 AND entry_type = 'reservation_release'`,
              [m.messageId],
            )
          ).rows[0].n,
        ).toBe(0);
      });
    });

    it('an unknown outcome (OD-7-4U): reservation released in full, no charge, no provider cost', async () => {
      await tx(async (c) => {
        const m = await plant(c, A, 1);
        await wallet(c, A, 1000);
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 70,
          account: 'wallet',
          message: m.messageId,
        });
        const rel = await post(c, {
          org: A.orgId,
          type: 'reservation_release',
          anchor: m.messageId,
          amount: null,
          account: 'wallet',
          message: m.messageId,
        });
        expect(Number(rel.amount_paise)).toBe(70);
        expect(await walletState(c, A)).toMatchObject({ balance: 1000, reserved: 0 });
      });
    });

    it('BL001 no account; BL002 inactive account refuses reservations but accepts settlement', async () => {
      await tx(async (c) => {
        const m = await plant(c, A);
        expect(
          await postCode(c, {
            org: A.orgId,
            type: 'reservation',
            anchor: m.messageId,
            amount: 1,
            account: 'wallet',
            message: m.messageId,
          }),
        ).toBe('BL001');
        expect(
          await postCode(c, {
            org: A.orgId,
            type: 'reservation',
            anchor: m.messageId,
            amount: 1,
            account: 'credit',
            message: m.messageId,
          }),
        ).toBe('BL001');
        const w = await wallet(c, A, 1000);
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 60,
          account: 'wallet',
          message: m.messageId,
        });
        await c.query(`UPDATE wallets SET status = 'frozen' WHERE id = $1`, [w]);
        const m2 = await plant(c, A);
        expect(
          await postCode(c, {
            org: A.orgId,
            type: 'reservation',
            anchor: m2.messageId,
            amount: 1,
            account: 'wallet',
            message: m2.messageId,
          }),
        ).toBe('BL002');
        expect(
          (
            await post(c, {
              org: A.orgId,
              type: 'customer_charge',
              anchor: m.messageId,
              amount: 60,
              account: 'wallet',
              message: m.messageId,
            })
          ).inserted,
        ).toBe(true);
        expect(
          (
            await post(c, {
              org: A.orgId,
              type: 'reservation_release',
              anchor: m.messageId,
              amount: null,
              account: 'wallet',
              message: m.messageId,
            })
          ).inserted,
        ).toBe(false);
      });
    });

    it('BL003 insufficient funds (wallet and credit account); BL005 account mismatch; BL006 overcharge', async () => {
      await tx(async (c) => {
        const m = await plant(c, A);
        await wallet(c, A, 100);
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 100,
          account: 'wallet',
          message: m.messageId,
        });
        const m2 = await plant(c, A);
        expect(
          await postCode(c, {
            org: A.orgId,
            type: 'reservation',
            anchor: m2.messageId,
            amount: 1,
            account: 'wallet',
            message: m2.messageId,
          }),
        ).toBe('BL003');
        await credit(c, A, 50);
        expect(
          await postCode(c, {
            org: A.orgId,
            type: 'reservation',
            anchor: m2.messageId,
            amount: 51,
            account: 'credit',
            message: m2.messageId,
          }),
        ).toBe('BL003');
        expect(
          (
            await post(c, {
              org: A.orgId,
              type: 'reservation',
              anchor: m2.messageId,
              amount: 50,
              account: 'credit',
              message: m2.messageId,
            })
          ).inserted,
        ).toBe(true);
        expect(
          await postCode(c, {
            org: A.orgId,
            type: 'customer_charge',
            anchor: m.messageId,
            amount: 10,
            account: 'credit',
            message: m.messageId,
          }),
        ).toBe('BL005');
        expect(
          await postCode(c, {
            org: A.orgId,
            type: 'customer_charge',
            anchor: m.messageId,
            amount: 101,
            account: 'wallet',
            message: m.messageId,
          }),
        ).toBe('BL006');
        const m3 = await plant(c, A);
        expect(
          await postCode(c, {
            org: A.orgId,
            type: 'customer_charge',
            anchor: m3.messageId,
            amount: 1,
            account: 'wallet',
            message: m3.messageId,
          }),
        ).toBe('BL006');
      });
    });

    it('credit account: reservation, charge and release move reserved and used', async () => {
      await tx(async (c) => {
        const m = await plant(c, A);
        await credit(c, A, 500);
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 200,
          account: 'credit',
          message: m.messageId,
        });
        await post(c, {
          org: A.orgId,
          type: 'customer_charge',
          anchor: m.messageId,
          amount: 150,
          account: 'credit',
          message: m.messageId,
        });
        await post(c, {
          org: A.orgId,
          type: 'reservation_release',
          anchor: m.messageId,
          amount: null,
          account: 'credit',
          message: m.messageId,
        });
        const { rows } = await c.query(
          `SELECT used_paise::int AS used, reserved_paise::int AS reserved, version::int AS version FROM credit_accounts WHERE org_id = $1`,
          [A.orgId],
        );
        expect(rows[0]).toEqual({ used: 150, reserved: 0, version: 3 });
      });
    });

    it('F-8: a rolled-back post leaves neither a row nor a balance change', async () => {
      await tx(async (c) => {
        const m = await plant(c, A);
        await wallet(c, A, 1000);
        await c.query('SAVEPOINT p');
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 10,
          account: 'wallet',
          message: m.messageId,
        });
        await c.query('ROLLBACK TO SAVEPOINT p');
        expect(await walletState(c, A)).toEqual({ balance: 1000, reserved: 0, version: 0 });
        expect(
          (
            await c.query(`SELECT count(*)::int AS n FROM usage_ledger WHERE message_id = $1`, [
              m.messageId,
            ])
          ).rows[0].n,
        ).toBe(0);
      });
    });

    it('F-9: random interleavings with retries keep the materialised balances equal to the ledger derivation', async () => {
      await tx(async (c) => {
        const w = await wallet(c, A, 1_000_000);
        let seed = 7;
        const rnd = (n: number) => {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          return seed % n;
        };
        const messages = [];
        for (let i = 0; i < 12; i += 1) messages.push(await plant(c, A, 2));
        for (let step = 0; step < 150; step += 1) {
          const m = messages[rnd(messages.length)]!;
          const kind = rnd(5);
          const p: Post =
            kind === 0
              ? {
                  org: A.orgId,
                  type: 'reservation',
                  anchor: m.messageId,
                  amount: 1 + rnd(500),
                  account: 'wallet',
                  message: m.messageId,
                }
              : kind === 1
                ? {
                    org: A.orgId,
                    type: 'reservation',
                    anchor: m.attemptIds[1]!,
                    attempt: m.attemptIds[1]!,
                    amount: 1 + rnd(300),
                    account: 'wallet',
                    message: m.messageId,
                  }
                : kind === 2
                  ? {
                      org: A.orgId,
                      type: 'customer_charge',
                      anchor: m.attemptIds[0]!,
                      attempt: m.attemptIds[0]!,
                      amount: 1 + rnd(200),
                      account: 'wallet',
                      message: m.messageId,
                    }
                  : kind === 3
                    ? {
                        org: A.orgId,
                        type: 'provider_cost',
                        anchor: m.attemptIds[rnd(2)]!,
                        attempt: undefined,
                        amount: 1 + rnd(100),
                        account: null,
                        message: m.messageId,
                      }
                    : {
                        org: A.orgId,
                        type: 'reservation_release',
                        anchor: m.messageId,
                        amount: null,
                        account: 'wallet',
                        message: m.messageId,
                      };
          if (p.type === 'provider_cost') p.attempt = p.anchor;
          const result = await postCode(c, p); // refused (BL004/BL006) or posted; retried once
          if (result === 'OK') await postCode(c, p);
        }
        const state = await walletState(c, A);
        const d = await derived(c, w);
        expect({ reserved: state.reserved, spent: 1_000_000 - state.balance }).toEqual({
          reserved: d.reserved,
          spent: d.charged,
        });
        const facts = (
          await c.query(`SELECT count(*)::int AS n FROM usage_ledger WHERE wallet_id = $1`, [w])
        ).rows[0].n;
        expect(state.version).toBe(facts);
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('concurrency (committed fixtures)', () => {
    async function committed<R>(work: (c: PoolClient) => Promise<R>): Promise<R> {
      const c = await db.adminPool.connect();
      try {
        await c.query('BEGIN');
        const r = await work(c);
        await c.query('COMMIT');
        return r;
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
    }

    it('F-1: eight sessions posting the same reservation at once produce one row and one balance effect', async () => {
      committedOrgs.push(B.orgId);
      const m = await committed(async (c) => {
        await wallet(c, B, 10_000);
        return plant(c, B);
      });
      const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 8 });
      try {
        const results = await Promise.all(
          Array.from({ length: 8 }, async () => {
            const c = await pool.connect();
            try {
              await c.query('BEGIN');
              const r = await post(c, {
                org: B.orgId,
                type: 'reservation',
                anchor: m.messageId,
                amount: 123,
                account: 'wallet',
                message: m.messageId,
              });
              await c.query('COMMIT');
              return r.inserted;
            } finally {
              c.release();
            }
          }),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const s = (
          await admin(
            `SELECT reserved_paise::int AS r, version::int AS v FROM wallets WHERE org_id = $1`,
            [B.orgId],
          )
        ).rows[0];
        expect(s).toEqual({ r: 123, v: 1 });
        expect(
          (
            await admin(`SELECT count(*)::int AS n FROM usage_ledger WHERE anchor_id = $1`, [
              m.messageId,
            ])
          ).rows[0].n,
        ).toBe(1);
      } finally {
        await pool.end();
      }
    });

    it('F-4: concurrent reservations beyond the balance reserve exactly the affordable subset', async () => {
      committedOrgs.push(A.orgId);
      const messages = await committed(async (c) => {
        await wallet(c, A, 1_000);
        const ms = [];
        for (let i = 0; i < 10; i += 1) ms.push(await plant(c, A));
        return ms;
      });
      const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 10 });
      try {
        const outcomes = await Promise.all(
          messages.map(async (m) => {
            const c = await pool.connect();
            try {
              await c.query('BEGIN');
              const r = await postCode(c, {
                org: A.orgId,
                type: 'reservation',
                anchor: m.messageId,
                amount: 300,
                account: 'wallet',
                message: m.messageId,
              });
              await c.query('COMMIT');
              return r;
            } finally {
              c.release();
            }
          }),
        );
        expect(outcomes.filter((o) => o === 'OK')).toHaveLength(3);
        expect(outcomes.filter((o) => o === 'BL003')).toHaveLength(7);
        const s = (
          await admin(
            `SELECT balance_paise::int AS b, reserved_paise::int AS r FROM wallets WHERE org_id = $1`,
            [A.orgId],
          )
        ).rows[0];
        expect(s).toEqual({ b: 1000, r: 900 });
      } finally {
        await pool.end();
      }
    });

    /** Opens a transaction on its own connection and posts; `settle` commits or rolls back. */
    const open: Array<{ c: PoolClient; done: boolean }> = [];
    async function openPost(pool: Pool, p: Post) {
      const c = await pool.connect();
      const h = { c, done: false };
      open.push(h);
      await c.query('BEGIN');
      const outcome = postCode(c, p);
      return { ...h, h, outcome };
    }
    const settle = async (
      x: { h: { c: PoolClient; done: boolean } },
      how: 'COMMIT' | 'ROLLBACK',
    ) => {
      await x.h.c.query(how);
      x.h.done = true;
      x.h.c.release();
    };
    /** Never leaves a connection checked out, even when an assertion fails mid-test. */
    async function releaseOpen(): Promise<void> {
      for (const h of open.splice(0)) {
        if (h.done) continue;
        await h.c.query('ROLLBACK').catch(() => undefined);
        h.c.release();
      }
    }

    it('final review: concurrent first postings for one message to different accounts cannot split its reservation', async () => {
      committedOrgs.push(A.orgId);
      const m = await committed(async (c) => {
        // Self-sufficient: the wallet may already exist from F-4.
        await c.query(
          `INSERT INTO wallets (org_id, balance_paise) VALUES ($1, 1000) ON CONFLICT (org_id) DO NOTHING`,
          [A.orgId],
        );
        await c.query(
          `INSERT INTO credit_accounts (org_id, credit_limit_paise) VALUES ($1, 10000) ON CONFLICT (org_id) DO NOTHING`,
          [A.orgId],
        );
        return plant(c, A, 1);
      });
      const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
      try {
        // T1 reserves on the message, to the wallet, and stays open.
        const t1 = await openPost(pool, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.messageId,
          amount: 50,
          account: 'wallet',
          message: m.messageId,
        });
        expect(await t1.outcome).toBe('OK');
        // T2 reserves on the attempt, to the credit account, while T1 is still open.
        const t2 = await openPost(pool, {
          org: A.orgId,
          type: 'reservation',
          anchor: m.attemptIds[0]!,
          attempt: m.attemptIds[0]!,
          amount: 50,
          account: 'credit',
          message: m.messageId,
        });
        await new Promise((r) => setTimeout(r, 300));
        await settle(t1, 'COMMIT');
        // T2 must have waited for T1 (one message, one lock) and then refuse the other account.
        expect(await t2.outcome).toBe('BL005');
        await settle(t2, 'ROLLBACK');
        const accounts = (
          await admin(
            `SELECT count(DISTINCT coalesce(wallet_id, credit_account_id))::int AS n FROM usage_ledger WHERE message_id = $1`,
            [m.messageId],
          )
        ).rows[0].n;
        expect(accounts).toBe(1);
        const cr = (
          await admin(`SELECT reserved_paise::int AS r FROM credit_accounts WHERE org_id = $1`, [
            A.orgId,
          ])
        ).rows[0].r;
        expect(cr).toBe(0);
      } finally {
        await releaseOpen();
        await pool.end();
      }
    });

    it('final review: a concurrent charge and release on one reservation never consume it twice; retries are no-ops', async () => {
      const m = await committed(async (c) => {
        const mm = await plant(c, A);
        await post(c, {
          org: A.orgId,
          type: 'reservation',
          anchor: mm.messageId,
          amount: 100,
          account: 'credit',
          message: mm.messageId,
        });
        return mm;
      });
      const before = (
        await admin(
          `SELECT used_paise::int AS u, reserved_paise::int AS r FROM credit_accounts WHERE org_id = $1`,
          [A.orgId],
        )
      ).rows[0];
      const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
      try {
        const charge = {
          org: A.orgId,
          type: 'customer_charge',
          anchor: m.messageId,
          amount: 60,
          account: 'credit' as const,
          message: m.messageId,
        };
        const release = {
          org: A.orgId,
          type: 'reservation_release',
          anchor: m.messageId,
          amount: null,
          account: 'credit' as const,
          message: m.messageId,
        };
        const t1 = await openPost(pool, charge);
        expect(await t1.outcome).toBe('OK');
        const t2 = await openPost(pool, release);
        await new Promise((r) => setTimeout(r, 300));
        await settle(t1, 'COMMIT');
        expect(await t2.outcome).toBe('OK');
        await settle(t2, 'COMMIT');
        // Retries of both, and a second charge, change nothing.
        await committed(async (c) => {
          expect((await post(c, charge)).inserted).toBe(false);
          expect((await post(c, release)).inserted).toBe(false);
          const again = await post(c, { ...charge, amount: 1 });
          expect([again.inserted, Number(again.amount_paise)]).toEqual([false, 60]);
        });
        const facts = (
          await admin(
            `SELECT fact_kind, amount_paise::int AS a FROM usage_ledger WHERE message_id = $1 ORDER BY fact_kind`,
            [m.messageId],
          )
        ).rows;
        expect(facts).toEqual([
          { fact_kind: 'customer_charge', a: 60 },
          { fact_kind: 'reservation', a: 100 },
          { fact_kind: 'reservation_release', a: 40 },
        ]);
        const after = (
          await admin(
            `SELECT used_paise::int AS u, reserved_paise::int AS r FROM credit_accounts WHERE org_id = $1`,
            [A.orgId],
          )
        ).rows[0];
        expect(after).toEqual({ u: before.u + 60, r: before.r - 100 });
      } finally {
        await releaseOpen();
        await pool.end();
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('permissions and role grants (OD-7-5, DP-1, DP-2)', () => {
    it('catalogues the four keys with the approved classes and scopes', async () => {
      const { rows } = await admin(
        `SELECT key, classification, allowed_scope_types::text AS scopes FROM permissions
          WHERE key IN ('billing.read', 'billing.manage', 'pricing.read', 'pricing.manage') ORDER BY key`,
      );
      expect(rows).toEqual([
        { key: 'billing.manage', classification: 'tenancy_administration', scopes: '{platform}' },
        { key: 'billing.read', classification: 'tenant_content', scopes: '{organization}' },
        { key: 'pricing.manage', classification: 'platform_catalogue', scopes: '{platform}' },
        { key: 'pricing.read', classification: 'platform_catalogue', scopes: '{platform}' },
      ]);
    });

    it('platform roles: super admin holds the three platform keys; support holds pricing.read only', async () => {
      const held = async (role: string) =>
        (
          await admin(
            `SELECT p.key FROM roles r JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
              WHERE r.org_id IS NULL AND r.key = $1 AND (p.key LIKE 'billing.%' OR p.key LIKE 'pricing.%') ORDER BY p.key`,
            [role],
          )
        ).rows.map((r) => r.key);
      expect(await held('alendei_super_admin')).toEqual([
        'billing.manage',
        'pricing.manage',
        'pricing.read',
      ]);
      expect(await held('alendei_support')).toEqual(['pricing.read']);
      expect(await held('reseller_admin')).toEqual([]);
    });

    it("the migration's org_admin backfill grants billing.read to an existing organization's system org_admin", async () => {
      const migration = readFileSync(
        join(__dirname, '../../migrations/0050_phase7_1_ledger_foundation.sql'),
        'utf8',
      );
      const backfill = migration
        .split('--> statement-breakpoint')
        .find((s) => s.includes("r.key = 'org_admin'") && s.includes("p.key = 'billing.read'"));
      expect(backfill).toBeDefined();
      await tx(async (c) => {
        await c.query(`SELECT set_config('app.provisioning', 'on', true)`);
        // The harness plants this organization's system org_admin after the migration ran,
        // so it lacks billing.read until the backfill statement is applied.
        const role = A.roleId;
        const before = await c.query(
          `SELECT count(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = $1 AND p.key = 'billing.read'`,
          [role],
        );
        expect(before.rows[0].n).toBe(0);
        await c.query(backfill!);
        const { rows } = await c.query(
          `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = $1 AND (p.key LIKE 'billing.%' OR p.key LIKE 'pricing.%')`,
          [role],
        );
        expect(rows.map((r) => r.key)).toEqual(['billing.read']);
      });
    });

    it('the database refuses billing.read on a platform role and the platform keys on a tenant role', async () => {
      await tx(async (c) => {
        await c.query(`SELECT set_config('app.provisioning', 'on', true)`);
        const attach = (roleWhere: string, key: string) =>
          code(
            c,
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT r.id, p.id FROM roles r, permissions p WHERE ${roleWhere} AND p.key = $1`,
            [key],
          );
        expect(
          await attach(`r.org_id IS NULL AND r.key = 'alendei_super_admin'`, 'billing.read'),
        ).not.toBe('OK');
        const tenantRole = (
          await c.query(
            `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
             VALUES ($1, 'p71_custom', 'P71 custom', false, '{organization}') RETURNING id`,
            [A.orgId],
          )
        ).rows[0].id;
        for (const key of ['billing.manage', 'pricing.read', 'pricing.manage']) {
          expect([key, await attach(`r.id = '${tenantRole}'`, key)]).not.toEqual([key, 'OK']);
        }
        expect(await attach(`r.id = '${tenantRole}'`, 'billing.read')).toBe('OK');
      });
    });
  });
});
