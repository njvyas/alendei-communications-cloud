/**
 * Phase 5.0 (PR-A) — the delivery foundation in the database: migrations 0044 (M1),
 * 0045 (M2, guard over the barrier-built indexes) and 0046 (M3).
 *
 * Design: PHASE-5.0-DESIGN-SPEC.md Rev 2 §B–§C, implementation plan §1.1–§1.2.
 * Acceptance criteria covered here: AC-ST-1..3, AC-GR-1, AC-FK-1, AC-ID-1/1a (database
 * level), AC-TI-1..3 (database level), AC-SV-5 (hash-only storage), AC-MG-* (schema shape).
 *
 * Mutations run inside transactions that are rolled back, so cases never leak into each
 * other. `acc_delivery` is reached through a real login (DATABASE_DELIVERY_PASSWORD, set
 * by db:roles:reconcile in CI): `app_session_bypasses_rls()` checks `session_user`, so a
 * `SET ROLE` from the owner would wrongly look like a maintenance session to the guards.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { DELIVERY_SESSION_VARS, DISPATCH_SESSION_VARS, SESSION_VARS } from '../constants';
import {
  connect,
  createTenant,
  destroyTenant,
  loadTestEnv,
  plantPlatformAdmin,
  plantPlatformSupport,
  removeIdentities,
  type Principals,
  type TenantFixture,
} from './harness';

const roleUrl = (role: string, passwordVariable: string): string => {
  const password = process.env[passwordVariable];
  if (!password) throw new Error(`${passwordVariable} must be set for the ${role} connection`);
  const url = new URL(process.env.DATABASE_URL!);
  url.username = role;
  url.password = password;
  return url.toString();
};

const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'NO_ERROR';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('Phase 5.0 delivery foundation (migrations 0044–0046)', () => {
  let db: Principals;
  let deliveryPool: Pool;
  let dispatchPool: Pool;
  let A: TenantFixture;
  let B: TenantFixture;
  let smsId: string;
  let providerP: string;
  let providerQ: string;
  const contact: Record<string, string> = {};
  const supportUsers: string[] = [];

  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  /** One transaction on the given pool with the given transaction-local settings; always rolled back. */
  async function inTx<R>(
    pool: Pool,
    settings: Record<string, string>,
    work: (c: PoolClient) => Promise<R>,
  ): Promise<R> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const [name, value] of Object.entries(settings)) {
        await c.query('SELECT set_config($1, $2, true)', [name, value]);
      }
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  /** A message (and optionally attempts) planted by the owner, inside the given transaction. */
  async function plant(
    c: PoolClient,
    t: TenantFixture,
    opts: {
      status?: string;
      attempts?: Array<{ provider: string; status: string; pmid?: string }>;
    } = {},
  ): Promise<{ messageId: string; attemptIds: string[] }> {
    const messageId = uuidv7();
    await c.query(
      `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, '+12025550199', $7)`,
      [
        messageId,
        t.orgId,
        t.workspaceId,
        contact[t.orgId],
        smsId,
        opts.status ?? 'accepted',
        uuidv7(),
      ],
    );
    const attemptIds: string[] = [];
    let n = 1;
    for (const a of opts.attempts ?? []) {
      const id = uuidv7();
      // The owner session (maintenance) may plant the provider message id directly; the
      // insert guard refuses delivery state on insert for every application principal.
      await c.query(
        `INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number, fencing_epoch, claim_token, status, provider_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)`,
        [id, messageId, t.orgId, a.provider, smsId, n, uuidv7(), a.status, a.pmid ?? null],
      );
      attemptIds.push(id);
      n += 1;
    }
    return { messageId, attemptIds };
  }

  /** Commits a planted message so other connections (acc_app, acc_delivery, acc_dispatch) can see it. */
  async function plantCommitted(
    t: TenantFixture,
    opts: Parameters<typeof plant>[2] = {},
  ): Promise<{ messageId: string; attemptIds: string[] }> {
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      const r = await plant(c, t, opts);
      await c.query('COMMIT');
      return r;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  const deliveryCtx = (t: TenantFixture, providerId: string, messageId: string) => ({
    [SESSION_VARS.ORG_ID]: t.orgId,
    [DELIVERY_SESSION_VARS.PROVIDER_ID]: providerId,
    [DELIVERY_SESSION_VARS.MESSAGE_ID]: messageId,
  });

  beforeAll(async () => {
    loadTestEnv();
    db = connect();
    deliveryPool = new Pool({
      connectionString: roleUrl('acc_delivery', 'DATABASE_DELIVERY_PASSWORD'),
      max: 2,
    });
    dispatchPool = new Pool({
      connectionString: roleUrl('acc_dispatch', 'DATABASE_DISPATCH_PASSWORD'),
      max: 2,
    });
    A = await createTenant(db.admin, 'p50-a');
    B = await createTenant(db.admin, 'p50-b');
    smsId = (await admin(`SELECT id FROM channels WHERE code = 'sms'`)).rows[0].id;
    const mk = async (name: string) =>
      (
        await admin(
          `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
          [smsId, `${name}-${uuidv7().slice(-8)}`],
        )
      ).rows[0].id as string;
    providerP = await mk('p50-provider-p');
    providerQ = await mk('p50-provider-q');
    for (const t of [A, B]) {
      for (const p of [providerP, providerQ]) {
        await admin(
          `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority)
           VALUES ($1, $2, $3, (SELECT coalesce(max(priority), 0) + 1 FROM organization_provider_assignments WHERE org_id = $1))`,
          [t.orgId, p, smsId],
        );
      }
      contact[t.orgId] = uuidv7();
      await admin(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
        contact[t.orgId],
        t.orgId,
        t.workspaceId,
      ]);
    }
  }, 120_000);

  afterAll(async () => {
    const orgIds = [A?.orgId, B?.orgId].filter(Boolean);
    if (orgIds.length > 0) {
      await admin(`DELETE FROM webhook_events WHERE provider_id = ANY($1::uuid[])`, [
        [providerP, providerQ].filter(Boolean),
      ]);
      await admin(`ALTER TABLE message_events DISABLE TRIGGER USER`);
      try {
        await admin(`DELETE FROM message_events WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      } finally {
        await admin(`ALTER TABLE message_events ENABLE TRIGGER USER`);
      }
      await admin(`DELETE FROM message_dispatch_queue WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(
        `UPDATE messages SET delivered_attempt_id = NULL WHERE org_id = ANY($1::uuid[]) AND delivered_attempt_id IS NOT NULL`,
        [orgIds],
      ).catch(() => undefined);
      await admin(`DELETE FROM messages WHERE org_id = ANY($1::uuid[])`, [orgIds]).catch(
        async () => {
          await admin(`ALTER TABLE messages DISABLE TRIGGER USER`);
          try {
            await admin(`DELETE FROM message_attempts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
            await admin(`DELETE FROM messages WHERE org_id = ANY($1::uuid[])`, [orgIds]);
          } finally {
            await admin(`ALTER TABLE messages ENABLE TRIGGER USER`);
          }
        },
      );
      await admin(`DELETE FROM message_attempts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(`DELETE FROM messages WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(`DELETE FROM contacts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(`DELETE FROM organization_provider_assignments WHERE org_id = ANY($1::uuid[])`, [
        orgIds,
      ]);
    }
    for (const p of [providerP, providerQ])
      if (p) await admin(`DELETE FROM providers WHERE id = $1`, [p]);
    await removeIdentities(db.admin, supportUsers);
    if (A) await destroyTenant(db.admin, A);
    if (B) await destroyTenant(db.admin, B);
    await deliveryPool?.end();
    await dispatchPool?.end();
    await db.close();
  }, 120_000);

  describe('schema shape (AC-ST-1, AC-MG)', () => {
    it('leaves the submission enums exactly as they were', async () => {
      const { rows } = await admin(
        `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname IN ('message_status', 'message_attempt_status', 'message_delivery_status', 'webhook_event_outcome')
          GROUP BY t.typname ORDER BY t.typname`,
      );
      expect(rows).toEqual([
        {
          typname: 'message_attempt_status',
          labels: ['submitting', 'accepted', 'failed', 'outcome_unknown'],
        },
        {
          typname: 'message_delivery_status',
          labels: ['pending', 'delivered', 'undelivered', 'not_supported'],
        },
        {
          typname: 'message_status',
          labels: ['queued', 'routing', 'submitting', 'accepted', 'failed', 'outcome_unknown'],
        },
        {
          typname: 'webhook_event_outcome',
          labels: [
            'applied',
            'no_change',
            'deferred',
            'unmatched',
            'rejected_malformed',
            'conflict',
            'informational',
          ],
        },
      ]);
    });

    it('adds only nullable delivery columns to messages and attempts, and the kill switch defaults off', async () => {
      const { rows } = await admin(
        `SELECT table_name, column_name, is_nullable, column_default, udt_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND (
                (table_name = 'messages' AND column_name IN ('delivery_status','delivered_at','read_at','delivered_attempt_id'))
             OR (table_name = 'message_attempts' AND column_name IN ('provider_message_id','delivery_status','delivered_at','read_at','delivery_updated_at'))
             OR (table_name = 'providers' AND column_name LIKE 'webhook_ingress%'))
          ORDER BY table_name, column_name`,
      );
      expect(
        rows
          .filter((r) => r.table_name !== 'providers')
          .every((r) => r.is_nullable === 'YES' && r.column_default === null),
      ).toBe(true);
      expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
        'message_attempts.delivered_at',
        'message_attempts.delivery_status',
        'message_attempts.delivery_updated_at',
        'message_attempts.provider_message_id',
        'message_attempts.read_at',
        'messages.delivered_at',
        'messages.delivered_attempt_id',
        'messages.delivery_status',
        'messages.read_at',
        'providers.webhook_ingress_enabled',
        'providers.webhook_ingress_key_hash',
        'providers.webhook_ingress_key_previous_expires_at',
        'providers.webhook_ingress_key_previous_hash',
        'providers.webhook_ingress_key_rotated_at',
      ]);
      const enabled = rows.find((r) => r.column_name === 'webhook_ingress_enabled');
      expect(enabled).toMatchObject({ is_nullable: 'NO', column_default: 'false' });
      // Providers store only hashes: no column could hold a plaintext key.
      expect(
        rows
          .filter((r) => r.table_name === 'providers' && /key/.test(r.column_name))
          .every((r) => /hash|expires|rotated/.test(r.column_name)),
      ).toBe(true);
    });

    it('validates every CHECK and the composite FK; both delivery indexes are valid; 0046 attached the unique constraint', async () => {
      const { rows } = await admin(
        `SELECT conname, contype::text AS t, convalidated FROM pg_constraint
          WHERE conname IN ('messages_delivered_attempt_fk','uq_message_attempts_id_message_id','messages_delivered_at_consistent',
                            'messages_read_implies_delivered','messages_delivered_attempt_consistent','message_attempts_delivered_at_consistent',
                            'message_attempts_read_implies_delivered','message_attempts_provider_message_id_length')
          ORDER BY conname`,
      );
      expect(rows).toHaveLength(8);
      expect(rows.every((r) => r.convalidated === true)).toBe(true);
      expect(rows.find((r) => r.conname === 'messages_delivered_attempt_fk')?.t).toBe('f');
      expect(rows.find((r) => r.conname === 'uq_message_attempts_id_message_id')?.t).toBe('u');
      const idx = await admin(
        `SELECT c.relname, i.indisvalid, i.indisunique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname IN ('message_attempts_provider_message_uq','uq_message_attempts_id_message_id') ORDER BY 1`,
      );
      expect(idx.rows).toEqual([
        { relname: 'message_attempts_provider_message_uq', indisvalid: true, indisunique: true },
        { relname: 'uq_message_attempts_id_message_id', indisvalid: true, indisunique: true },
      ]);
    });

    it('creates acc_delivery as an ordinary principal: no superuser, no BYPASSRLS, no role membership', async () => {
      const { rows } = await admin(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
                (SELECT count(*)::int FROM pg_auth_members am WHERE am.member = r.oid OR am.roleid = r.oid) AS memberships
           FROM pg_roles r WHERE rolname = 'acc_delivery'`,
      );
      expect(rows).toEqual([
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          memberships: 0,
        },
      ]);
    });
  });

  describe('grants (AC-GR-1, spec Rev 2 §C.2a, plan §1.1)', () => {
    const grants = async (grantee: string) => {
      const table = await admin(
        `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
           FROM information_schema.role_table_grants WHERE grantee = $1 AND table_schema = 'public'
          GROUP BY table_name ORDER BY table_name`,
        [grantee],
      );
      const column = await admin(
        `SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS cols
           FROM information_schema.column_privileges cp
          WHERE grantee = $1 AND table_schema = 'public' AND privilege_type = 'UPDATE'
            AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                             WHERE g.grantee = cp.grantee AND g.table_name = cp.table_name AND g.privilege_type = 'UPDATE')
          GROUP BY table_name ORDER BY table_name`,
        [grantee],
      );
      return {
        table: Object.fromEntries(table.rows.map((r) => [r.table_name, r.privs])),
        update: Object.fromEntries(column.rows.map((r) => [r.table_name, r.cols])),
      };
    };

    it('acc_delivery holds exactly its pipeline privileges and nothing else', async () => {
      expect(await grants('acc_delivery')).toEqual({
        table: {
          message_attempts: 'SELECT',
          message_events: 'INSERT',
          messages: 'SELECT',
          webhook_events: 'INSERT,SELECT',
        },
        update: {
          message_attempts: 'delivered_at,delivery_status,delivery_updated_at,read_at',
          messages: 'delivered_at,delivered_attempt_id,delivery_status,read_at,updated_at',
          webhook_events:
            'duplicate_count,last_duplicate_at,matched_attempt_id,matched_org_id,normalized,outcome,processed_at',
        },
      });
    });

    it('acc_dispatch gains only the settlement columns and the deferred/unmatched event settlement', async () => {
      const g = await grants('acc_dispatch');
      expect(g.table.webhook_events).toBe('SELECT');
      expect(g.update.webhook_events).toBe(
        'matched_attempt_id,matched_org_id,outcome,processed_at',
      );
      expect(g.update.messages).toBe(
        'completed_at,current_attempt_id,delivered_at,delivered_attempt_id,delivery_status,failure_reason,read_at,status,updated_at',
      );
      expect(g.update.message_attempts).toBe(
        'completed_at,delivered_at,delivery_status,delivery_updated_at,failure_reason,latency_ms,provider_message_id,read_at,status',
      );
    });

    it('no tenant-facing principal can touch webhook_events', async () => {
      const { rows } = await admin(
        `SELECT grantee FROM information_schema.role_table_grants
          WHERE table_name = 'webhook_events' AND grantee IN ('acc_app', 'acc_auth', 'acc_relay', 'PUBLIC')`,
      );
      expect(rows).toEqual([]);
    });

    it('the definer resolvers are executable by acc_delivery only, never by PUBLIC', async () => {
      const { rows } = await admin(
        `SELECT p.proname, p.prosecdef,
                has_function_privilege('acc_delivery', p.oid, 'EXECUTE') AS delivery,
                has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app,
                has_function_privilege('acc_dispatch', p.oid, 'EXECUTE') AS dispatch,
                (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('app_webhook_provider_resolve', 'app_delivery_resolve')
          ORDER BY p.proname`,
      );
      expect(rows).toEqual([
        {
          proname: 'app_delivery_resolve',
          prosecdef: true,
          delivery: true,
          app: false,
          dispatch: false,
          public_exec: false,
        },
        {
          proname: 'app_webhook_provider_resolve',
          prosecdef: true,
          delivery: true,
          app: false,
          dispatch: false,
          public_exec: false,
        },
      ]);
    });

    it('records the exact-shape audit policy for ingress administration (providers.manage)', async () => {
      const { rows } = await admin(
        `SELECT qual IS NULL AS no_using, with_check FROM pg_policies
          WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_provider_webhook_ingress_insert'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].with_check).toMatch(/provider\.webhook_ingress_key_rotated/);
      expect(rows[0].with_check).toMatch(/app_has_platform_permission\('providers\.manage'/);
    });
  });

  describe('terminal guards keep submission history immutable (AC-ST-3)', () => {
    it('on an accepted message: a delivery-only update passes; any non-delivery change still raises', async () => {
      await inTx(db.adminPool, {}, async (c) => {
        const { messageId, attemptIds } = await plant(c, A, {
          attempts: [{ provider: providerP, status: 'accepted', pmid: 'pm-1' }],
        });
        // Owner session (maintenance) — the delivery guard admits it; the terminal guard admits delivery-only.
        await c.query(`UPDATE message_attempts SET delivery_status = 'pending' WHERE id = $1`, [
          attemptIds[0],
        ]);
        await c.query(`UPDATE messages SET delivery_status = 'pending' WHERE id = $1`, [messageId]);
        await c.query('SAVEPOINT s');
        expect(
          await errorCode(
            c.query(`UPDATE messages SET failure_reason = 'x' WHERE id = $1`, [messageId]),
          ),
        ).toMatch(/MESSAGE_ALREADY_TERMINAL/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        expect(
          await errorCode(
            c.query(
              `UPDATE messages SET delivery_status = 'delivered', delivered_at = now(), status = 'failed' WHERE id = $1`,
              [messageId],
            ),
          ),
        ).toMatch(/MESSAGE_ALREADY_TERMINAL/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        expect(
          await errorCode(
            c.query(`UPDATE message_attempts SET latency_ms = 5 WHERE id = $1`, [attemptIds[0]]),
          ),
        ).toMatch(/ATTEMPT_ALREADY_TERMINAL/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        // provider_message_id is not a delivery column after settlement: immutable on a terminal attempt.
        expect(
          await errorCode(
            c.query(`UPDATE message_attempts SET provider_message_id = 'pm-2' WHERE id = $1`, [
              attemptIds[0],
            ]),
          ),
        ).toMatch(/ATTEMPT_ALREADY_TERMINAL|provider_message_id is write-once/);
      });
    });

    it('the existing non-terminal transition rules are unchanged', async () => {
      await inTx(db.adminPool, {}, async (c) => {
        const { messageId } = await plant(c, A, { status: 'queued' });
        expect(
          await errorCode(
            c.query(`UPDATE messages SET status = 'accepted' WHERE id = $1`, [messageId]),
          ),
        ).toMatch(/ILLEGAL_STATE_TRANSITION/);
      });
    });
  });

  describe('delivery transitions (spec Rev 2 §B.3; monotonic rank)', () => {
    const transition = async (from: string | null, to: string | null) =>
      inTx(db.adminPool, {}, async (c) => {
        const { attemptIds } = await plant(c, A, {
          attempts: [{ provider: providerP, status: 'accepted' }],
        });
        const id = attemptIds[0];
        if (from) {
          await c.query(
            `UPDATE message_attempts SET delivery_status = $1::message_delivery_status,
                    delivered_at = CASE WHEN $1 = 'delivered' THEN now() END WHERE id = $2`,
            [from, id],
          );
        }
        return errorCode(
          c.query(
            `UPDATE message_attempts SET delivery_status = $1::message_delivery_status,
                    delivered_at = CASE WHEN $1 = 'delivered' THEN coalesce(delivered_at, now()) ELSE delivered_at END WHERE id = $2`,
            [to, id],
          ),
        );
      });

    it.each<[string | null, string]>([
      [null, 'pending'],
      [null, 'not_supported'],
      ['pending', 'delivered'],
      ['pending', 'undelivered'],
      ['undelivered', 'delivered'],
      ['not_supported', 'delivered'],
    ])('allows %s → %s', async (from, to) => {
      expect(await transition(from, to)).toBe('NO_ERROR');
    });

    it.each<[string, string | null, RegExp]>([
      ['delivered', 'undelivered', /DELIVERY_TRANSITION_INVALID|delivered_at_consistent/],
      ['delivered', 'pending', /DELIVERY_TRANSITION_INVALID|delivered_at_consistent/],
      ['undelivered', 'pending', /DELIVERY_TRANSITION_INVALID/],
      ['pending', 'not_supported', /DELIVERY_TRANSITION_INVALID/],
      ['not_supported', 'pending', /DELIVERY_TRANSITION_INVALID/],
      ['pending', null, /DELIVERY_TRANSITION_INVALID/],
    ])('refuses %s → %s', async (from, to, message) => {
      expect(await transition(from, to)).toMatch(message);
    });

    it('delivered_at, read_at, delivered_attempt_id and provider_message_id are write-once; read implies delivered', async () => {
      await inTx(db.adminPool, {}, async (c) => {
        const { messageId, attemptIds } = await plant(c, A, {
          attempts: [
            { provider: providerP, status: 'submitting' },
            { provider: providerQ, status: 'submitting' },
          ],
        });
        await c.query(`UPDATE message_attempts SET provider_message_id = 'pm-a' WHERE id = $1`, [
          attemptIds[0],
        ]);
        await c.query('SAVEPOINT s');
        expect(
          await errorCode(
            c.query(`UPDATE message_attempts SET provider_message_id = 'pm-b' WHERE id = $1`, [
              attemptIds[0],
            ]),
          ),
        ).toMatch(/provider_message_id is write-once/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        expect(
          await errorCode(
            c.query(`UPDATE message_attempts SET read_at = now() WHERE id = $1`, [attemptIds[0]]),
          ),
        ).toMatch(/read_implies_delivered/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        await c.query(
          `UPDATE message_attempts SET status = 'accepted', delivery_status = 'delivered', delivered_at = now() - interval '1 minute', read_at = now() WHERE id = $1`,
          [attemptIds[0]],
        );
        await c.query(
          `UPDATE messages SET status = 'accepted', delivery_status = 'delivered', delivered_at = now(), delivered_attempt_id = $2 WHERE id = $1`,
          [messageId, attemptIds[0]],
        );
        await c.query('SAVEPOINT t');
        expect(
          await errorCode(
            c.query(`UPDATE message_attempts SET delivered_at = now() WHERE id = $1`, [
              attemptIds[0],
            ]),
          ),
        ).toMatch(/delivered_at is write-once/);
        await c.query('ROLLBACK TO SAVEPOINT t');
        expect(
          await errorCode(
            c.query(
              `UPDATE message_attempts SET read_at = now() + interval '1 second' WHERE id = $1`,
              [attemptIds[0]],
            ),
          ),
        ).toMatch(/read_at is write-once/);
        await c.query('ROLLBACK TO SAVEPOINT t');
        expect(
          await errorCode(
            c.query(`UPDATE messages SET delivered_attempt_id = $2 WHERE id = $1`, [
              messageId,
              attemptIds[1],
            ]),
          ),
        ).toMatch(/delivered_attempt_id is write-once/);
      });
    });

    it('the composite FK refuses a delivering attempt that belongs to another message (AC-FK-1)', async () => {
      await inTx(db.adminPool, {}, async (c) => {
        const one = await plant(c, A, { attempts: [{ provider: providerP, status: 'accepted' }] });
        const two = await plant(c, A, { attempts: [{ provider: providerP, status: 'accepted' }] });
        expect(
          await errorCode(
            c.query(
              `UPDATE messages SET delivery_status = 'delivered', delivered_at = now(), delivered_attempt_id = $2 WHERE id = $1`,
              [one.messageId, two.attemptIds[0]],
            ),
          ),
        ).toMatch(/messages_delivered_attempt_fk/);
      });
    });

    it('the (provider, provider message id) pair is unique; NULL ids never collide', async () => {
      await inTx(db.adminPool, {}, async (c) => {
        await plant(c, A, {
          attempts: [{ provider: providerP, status: 'accepted', pmid: 'dup-1' }],
        });
        await plant(c, A, {
          attempts: [{ provider: providerQ, status: 'accepted', pmid: 'dup-1' }],
        }); // another provider: fine
        await plant(c, A, {
          attempts: [
            { provider: providerP, status: 'accepted' },
            { provider: providerP, status: 'accepted' },
          ],
        }); // NULLs
        expect(
          await errorCode(
            plant(c, B, { attempts: [{ provider: providerP, status: 'accepted', pmid: 'dup-1' }] }),
          ),
        ).toMatch(/message_attempts_provider_message_uq/);
      });
    });
  });

  describe('only the delivery principals write delivery state', () => {
    // The fixture's API key is a valid content principal of its organization (0027); the
    // fixture user is only invited, so it would not establish a content context.
    const appCtx = (t: TenantFixture) => ({
      [SESSION_VARS.ORG_ID]: t.orgId,
      [SESSION_VARS.API_KEY_ID]: t.apiKeyId,
    });

    it('acc_app, with a valid content context, may not change delivery columns', async () => {
      const m = await plantCommitted(A, {
        attempts: [{ provider: providerP, status: 'accepted' }],
      });
      await inTx(db.appPool, appCtx(A), async (c) => {
        const visible = await c.query(`SELECT count(*)::int AS n FROM messages WHERE id = $1`, [
          m.messageId,
        ]);
        expect(visible.rows[0].n).toBe(1); // RLS admits the row: the refusal below is the delivery guard's
        await c.query('SAVEPOINT s');
        expect(
          await errorCode(
            c.query(`UPDATE messages SET delivery_status = 'pending' WHERE id = $1`, [m.messageId]),
          ),
        ).toMatch(/DELIVERY_WRITE_FORBIDDEN/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        expect(
          await errorCode(
            c.query(`UPDATE message_attempts SET delivery_status = 'pending' WHERE id = $1`, [
              m.attemptIds[0],
            ]),
          ),
        ).toMatch(/DELIVERY_WRITE_FORBIDDEN/);
      });
    });

    it('acc_app may not insert a message or attempt that already carries delivery state', async () => {
      await inTx(db.appPool, appCtx(A), async (c) => {
        await c.query('SAVEPOINT s');
        expect(
          await errorCode(
            c.query(
              `INSERT INTO messages (org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id, delivery_status)
               VALUES ($1, $2, $3, $4, 'queued', '+12025550199', $5, 'delivered')`,
              [A.orgId, A.workspaceId, contact[A.orgId], smsId, uuidv7()],
            ),
          ),
        ).toMatch(/DELIVERY_STATE_ON_INSERT/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        // Without delivery state the same insert is accepted (the guard adds no other restriction).
        const ok = await c.query(
          `INSERT INTO messages (org_id, workspace_id, contact_id, channel_id, status, recipient_address, correlation_id)
           VALUES ($1, $2, $3, $4, 'queued', '+12025550199', $5) RETURNING id`,
          [A.orgId, A.workspaceId, contact[A.orgId], smsId, uuidv7()],
        );
        expect(ok.rowCount).toBe(1);
      });
    });

    it('acc_dispatch may not set delivery state on a row it holds no claim for (RLS)', async () => {
      const m = await plantCommitted(A, {
        attempts: [{ provider: providerP, status: 'accepted' }],
      });
      const result = await inTx(
        dispatchPool,
        {
          [SESSION_VARS.ORG_ID]: A.orgId,
          [DISPATCH_SESSION_VARS.MESSAGE_ID]: m.messageId,
          [DISPATCH_SESSION_VARS.CLAIM_TOKEN]: uuidv7(),
        },
        async (c) =>
          (
            await c.query(`UPDATE message_attempts SET delivery_status = 'pending' WHERE id = $1`, [
              m.attemptIds[0],
            ])
          ).rowCount,
      );
      expect(result).toBe(0);
    });
  });

  describe('acc_delivery row-level security (AC-TI-1..3, database level)', () => {
    it('updates delivery state of the resolved message only, in its own organization', async () => {
      const m = await plantCommitted(A, {
        attempts: [{ provider: providerP, status: 'accepted', pmid: `pm-${uuidv7()}` }],
      });
      const other = await plantCommitted(A, {
        attempts: [{ provider: providerP, status: 'accepted' }],
      });
      await inTx(deliveryPool, deliveryCtx(A, providerP, m.messageId), async (c) => {
        const r1 = await c.query(
          `UPDATE message_attempts SET delivery_status = 'pending', delivery_updated_at = now() WHERE id = $1`,
          [m.attemptIds[0]],
        );
        expect(r1.rowCount).toBe(1);
        const r2 = await c.query(`UPDATE messages SET delivery_status = 'pending' WHERE id = $1`, [
          m.messageId,
        ]);
        expect(r2.rowCount).toBe(1);
        // Another message of the same organization: invisible to this transaction.
        const r3 = await c.query(`UPDATE messages SET delivery_status = 'pending' WHERE id = $1`, [
          other.messageId,
        ]);
        expect(r3.rowCount).toBe(0);
        // A non-delivery column: no privilege.
        await c.query('SAVEPOINT s');
        expect(
          await errorCode(
            c.query(`UPDATE messages SET failure_reason = 'x' WHERE id = $1`, [m.messageId]),
          ),
        ).toMatch(/permission denied/);
      });
    });

    it('cannot reach a message of another organization even when it names it', async () => {
      const mB = await plantCommitted(B, {
        attempts: [{ provider: providerP, status: 'accepted' }],
      });
      await inTx(deliveryPool, deliveryCtx(A, providerP, mB.messageId), async (c) => {
        const r = await c.query(`UPDATE messages SET delivery_status = 'pending' WHERE id = $1`, [
          mB.messageId,
        ]);
        expect(r.rowCount).toBe(0);
        const s = await c.query(
          `SELECT count(*)::int AS n FROM message_attempts WHERE message_id = $1`,
          [mB.messageId],
        );
        expect(s.rows[0].n).toBe(0);
      });
    });

    it('sees and writes webhook_events of its own provider only', async () => {
      const hash = randomBytes(32);
      await inTx(deliveryPool, { [DELIVERY_SESSION_VARS.PROVIDER_ID]: providerP }, async (c) => {
        await c.query(
          `INSERT INTO webhook_events (provider_id, request_id, event_index, event_sha256, outcome) VALUES ($1, $2, 0, $3, 'unmatched')`,
          [providerP, uuidv7(), hash],
        );
        await c.query('SAVEPOINT s');
        expect(
          await errorCode(
            c.query(
              `INSERT INTO webhook_events (provider_id, request_id, event_index, event_sha256, outcome) VALUES ($1, $2, 0, $3, 'unmatched')`,
              [providerQ, uuidv7(), randomBytes(32)],
            ),
          ),
        ).toMatch(/row-level security/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        const seen = await c.query(`SELECT provider_id FROM webhook_events`);
        expect(seen.rows.every((r) => r.provider_id === providerP)).toBe(true);
        // No DELETE privilege: events are never removed by the application.
        expect(await errorCode(c.query(`DELETE FROM webhook_events`))).toMatch(/permission denied/);
      });
    });

    it('acc_dispatch sees only the held receipts of the message it holds a live claim on (0044, bound by 0047)', async () => {
      const m = await plantCommitted(A, {
        status: 'submitting',
        attempts: [{ provider: providerP, status: 'submitting' }],
      });
      const token = uuidv7();
      await admin(
        `INSERT INTO message_dispatch_queue (message_id, org_id, available_at, claim_token, claimed_until, claimed_by)
         VALUES ($1, $2, now(), $3, now() + interval '5 minutes', 'p50-test')`,
        [m.messageId, A.orgId, token],
      );
      const pending = uuidv7();
      await admin(
        // 0047: a held receipt is attributable to the claimed message by its own reference.
        `INSERT INTO webhook_events (id, provider_id, request_id, event_index, event_sha256, outcome, normalized) VALUES
           ($1, $2, $3, 0, $4, 'deferred', jsonb_build_object('kind', 'delivered', 'clientReference', $10::text)),
           ($5, $2, $3, 1, $6, 'applied', jsonb_build_object('kind', 'delivered', 'clientReference', gen_random_uuid()::text)),
           ($7, $8, $3, 2, $9, 'unmatched', jsonb_build_object('kind', 'delivered', 'clientReference', $10::text))`,
        [
          pending,
          providerP,
          uuidv7(),
          randomBytes(32),
          uuidv7(),
          randomBytes(32),
          uuidv7(),
          providerQ,
          randomBytes(32),
          m.attemptIds[0],
        ],
      );
      const ids = await inTx(
        dispatchPool,
        {
          [SESSION_VARS.ORG_ID]: A.orgId,
          [DISPATCH_SESSION_VARS.MESSAGE_ID]: m.messageId,
          [DISPATCH_SESSION_VARS.CLAIM_TOKEN]: token,
        },
        async (c) =>
          (await c.query(`SELECT id FROM webhook_events ORDER BY id`)).rows.map((r) => r.id),
      );
      expect(ids).toEqual([pending]);
      const none = await inTx(
        dispatchPool,
        {
          [SESSION_VARS.ORG_ID]: A.orgId,
          [DISPATCH_SESSION_VARS.MESSAGE_ID]: m.messageId,
          [DISPATCH_SESSION_VARS.CLAIM_TOKEN]: uuidv7(),
        },
        async (c) => (await c.query(`SELECT count(*)::int AS n FROM webhook_events`)).rows[0].n,
      );
      expect(none).toBe(0);
    });

    describe('0047: acc_dispatch reaches only the receipts of the message it holds a live claim on', () => {
      // Provider P serves message M (org A, claimed by acc_dispatch) and message N (org A — the
      // hardest case: same organization, same provider) and message O (org B, same provider).
      let M: { messageId: string; attemptIds: string[] };
      let N: { messageId: string; attemptIds: string[] };
      let O: { messageId: string; attemptIds: string[] };
      let token: string;
      const r: Record<string, string> = {};

      const insertReceipt = async (
        key: string,
        provider: string,
        outcome: string,
        normalized: Record<string, unknown>,
        matched: { attemptId: string; orgId: string } | null = null,
      ) => {
        r[key] = uuidv7();
        await admin(
          `INSERT INTO webhook_events (id, provider_id, request_id, event_index, event_sha256, outcome,
                                       matched_attempt_id, matched_org_id, normalized)
           VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8)`,
          [
            r[key],
            provider,
            uuidv7(),
            randomBytes(32),
            outcome,
            matched?.attemptId ?? null,
            matched?.orgId ?? null,
            normalized,
          ],
        );
      };

      beforeAll(async () => {
        M = await plantCommitted(A, {
          status: 'submitting',
          attempts: [
            { provider: providerP, status: 'failed' },
            { provider: providerP, status: 'submitting', pmid: `pm-M-${uuidv7()}` },
          ],
        });
        N = await plantCommitted(A, {
          attempts: [{ provider: providerP, status: 'accepted', pmid: `pm-N-${uuidv7()}` }],
        });
        O = await plantCommitted(B, { attempts: [{ provider: providerP, status: 'accepted' }] });
        token = uuidv7();
        await admin(
          `INSERT INTO message_dispatch_queue (message_id, org_id, available_at, claim_token, claimed_until, claimed_by)
           VALUES ($1, $2, now(), $3, now() + interval '5 minutes', 'p50-0047')`,
          [M.messageId, A.orgId, token],
        );
        const [aM1, aM2] = M.attemptIds as [string, string];
        const aN = N.attemptIds[0]!;
        const aO = O.attemptIds[0]!;
        const pmM = (
          await admin(`SELECT provider_message_id FROM message_attempts WHERE id = $1`, [aM2])
        ).rows[0].provider_message_id;
        const pmN = (
          await admin(`SELECT provider_message_id FROM message_attempts WHERE id = $1`, [aN])
        ).rows[0].provider_message_id;
        // Receipts of M — visible to the claim.
        await insertReceipt(
          'mDeferred',
          providerP,
          'deferred',
          { kind: 'delivered', clientReference: aM2 },
          { attemptId: aM2, orgId: A.orgId },
        );
        await insertReceipt('mByReference', providerP, 'unmatched', {
          kind: 'delivered',
          clientReference: aM2,
        });
        await insertReceipt('mByProviderId', providerP, 'unmatched', {
          kind: 'read',
          providerMessageId: pmM,
        });
        await insertReceipt('mAttempt1', providerP, 'unmatched', {
          kind: 'undelivered',
          clientReference: aM1,
        });
        await insertReceipt(
          'mSettled',
          providerP,
          'applied',
          { kind: 'delivered', clientReference: aM2 },
          { attemptId: aM2, orgId: A.orgId },
        );
        // Receipts of other messages — invisible, matched or not.
        await insertReceipt(
          'nDeferredMatched',
          providerP,
          'deferred',
          { kind: 'delivered', clientReference: aN },
          { attemptId: aN, orgId: A.orgId },
        );
        await insertReceipt('nUnmatched', providerP, 'unmatched', {
          kind: 'delivered',
          providerMessageId: pmN,
        });
        await insertReceipt(
          'nSettled',
          providerP,
          'applied',
          { kind: 'delivered', clientReference: aN },
          { attemptId: aN, orgId: A.orgId },
        );
        await insertReceipt('oUnmatched', providerP, 'unmatched', {
          kind: 'delivered',
          clientReference: aO,
        });
        await insertReceipt(
          'oDeferredMatched',
          providerP,
          'deferred',
          { kind: 'delivered', clientReference: aO },
          { attemptId: aO, orgId: B.orgId },
        );
        // A reference to M's attempt under another provider, and a receipt naming nothing.
        await insertReceipt('otherProvider', providerQ, 'unmatched', {
          kind: 'delivered',
          clientReference: aM2,
        });
        await insertReceipt('noReference', providerP, 'unmatched', { kind: 'delivered' });
      });

      const claimCtx = (claimToken: string) => ({
        [SESSION_VARS.ORG_ID]: A.orgId,
        [DISPATCH_SESSION_VARS.MESSAGE_ID]: M.messageId,
        [DISPATCH_SESSION_VARS.CLAIM_TOKEN]: claimToken,
      });
      const visible = (c: PoolClient) =>
        c
          .query(`SELECT id FROM webhook_events`)
          .then((res) => new Set(res.rows.map((x) => x.id as string)));
      const name = (ids: Set<string>) =>
        Object.keys(r)
          .filter((k) => ids.has(r[k]!))
          .sort();

      it('sees exactly M’s receipts (held and settled); none of another message, organization or provider', async () => {
        const ids = await inTx(dispatchPool, claimCtx(token), visible);
        expect(name(ids)).toEqual([
          'mAttempt1',
          'mByProviderId',
          'mByReference',
          'mDeferred',
          'mSettled',
        ]);
      });

      it('settles each held receipt of M onto the attempt its own references name', async () => {
        const [aM1, aM2] = M.attemptIds as [string, string];
        await inTx(dispatchPool, claimCtx(token), async (c) => {
          const settle = (key: string, attemptId: string) =>
            c.query(
              `UPDATE webhook_events SET outcome = 'applied', matched_attempt_id = $2, matched_org_id = $3, processed_at = now()
                WHERE id = $1`,
              [r[key], attemptId, A.orgId],
            );
          expect((await settle('mDeferred', aM2)).rowCount).toBe(1);
          expect((await settle('mByReference', aM2)).rowCount).toBe(1);
          expect((await settle('mByProviderId', aM2)).rowCount).toBe(1);
          expect((await settle('mAttempt1', aM1)).rowCount).toBe(1);
          // Still visible once settled (the defect 0047 fixes), and final: never settled again.
          expect(name(await visible(c))).toEqual([
            'mAttempt1',
            'mByProviderId',
            'mByReference',
            'mDeferred',
            'mSettled',
          ]);
          const again = await c.query(
            `UPDATE webhook_events SET outcome = 'no_change' WHERE id = ANY($1::uuid[])`,
            [[r.mDeferred, r.mSettled]],
          );
          expect(again.rowCount).toBe(0);
        });
      });

      it('cannot settle a receipt of M onto another attempt, another message, unmatched, or another organization', async () => {
        const [aM1] = M.attemptIds as [string, string];
        const aN = N.attemptIds[0]!;
        const attempt = (set: string, params: unknown[]) =>
          inTx(dispatchPool, claimCtx(token), (c) =>
            errorCode(c.query(`UPDATE webhook_events SET ${set} WHERE id = $1`, params)),
          );
        const rls = /new row violates row-level security policy/;
        // A receipt naming attempt 2 cannot be matched to attempt 1 of the same message.
        expect(
          await attempt(`outcome = 'applied', matched_attempt_id = $2, matched_org_id = $3`, [
            r.mByReference,
            aM1,
            A.orgId,
          ]),
        ).toMatch(rls);
        // … nor to another message's attempt.
        expect(
          await attempt(`outcome = 'applied', matched_attempt_id = $2, matched_org_id = $3`, [
            r.mByReference,
            aN,
            A.orgId,
          ]),
        ).toMatch(rls);
        // … nor settled without a match, nor attributed to another organization.
        expect(
          await attempt(`outcome = 'applied', processed_at = now()`, [r.mByReference]),
        ).toMatch(rls);
        expect(
          await attempt(`outcome = 'applied', matched_attempt_id = $2, matched_org_id = $3`, [
            r.mByReference,
            M.attemptIds[1],
            B.orgId,
          ]),
        ).toMatch(rls);
      });

      it('cannot modify any receipt of another message, organization or provider — matched or not (0 rows)', async () => {
        const aN = N.attemptIds[0]!;
        const counts = await inTx(dispatchPool, claimCtx(token), async (c) => {
          const out: Record<string, number> = {};
          for (const key of [
            'nDeferredMatched',
            'nUnmatched',
            'nSettled',
            'oUnmatched',
            'oDeferredMatched',
            'otherProvider',
            'noReference',
          ]) {
            const res = await c.query(
              `UPDATE webhook_events SET outcome = 'applied', processed_at = now() WHERE id = $1`,
              [r[key]],
            );
            out[key] = res.rowCount ?? -1;
          }
          // Also by a broad statement: nothing outside M's receipts is ever touched.
          const broad = await c.query(
            `UPDATE webhook_events SET processed_at = now() WHERE matched_attempt_id = $1 OR provider_id = $2`,
            [aN, providerQ],
          );
          out.broad = broad.rowCount ?? -1;
          return out;
        });
        expect(counts).toEqual({
          nDeferredMatched: 0,
          nUnmatched: 0,
          nSettled: 0,
          oUnmatched: 0,
          oDeferredMatched: 0,
          otherProvider: 0,
          noReference: 0,
          broad: 0,
        });
        const untouched = await admin(
          `SELECT count(*)::int AS n FROM webhook_events WHERE id = ANY($1::uuid[]) AND processed_at IS NULL`,
          [
            [
              r.nDeferredMatched,
              r.nUnmatched,
              r.oUnmatched,
              r.oDeferredMatched,
              r.otherProvider,
              r.noReference,
            ],
          ],
        );
        expect(untouched.rows[0].n).toBe(6);
      });

      it('without a live claim (wrong token, expired lease) or under another organization context — sees and settles nothing', async () => {
        expect((await inTx(dispatchPool, claimCtx(uuidv7()), visible)).size).toBe(0);
        await admin(
          `UPDATE message_dispatch_queue SET claimed_until = now() - interval '1 second' WHERE message_id = $1`,
          [M.messageId],
        );
        try {
          const res = await inTx(dispatchPool, claimCtx(token), async (c) => ({
            seen: (await visible(c)).size,
            updated: (
              await c.query(
                `UPDATE webhook_events SET outcome = 'applied', matched_attempt_id = $2, matched_org_id = $3 WHERE id = $1`,
                [r.mByReference, M.attemptIds[1], A.orgId],
              )
            ).rowCount,
          }));
          expect(res).toEqual({ seen: 0, updated: 0 });
        } finally {
          await admin(
            `UPDATE message_dispatch_queue SET claimed_until = now() + interval '5 minutes' WHERE message_id = $1`,
            [M.messageId],
          );
        }
        // A claim on M under another organization context sees nothing either.
        const otherOrg = await inTx(
          dispatchPool,
          { ...claimCtx(token), [SESSION_VARS.ORG_ID]: B.orgId },
          visible,
        );
        expect(otherOrg.size).toBe(0);
      });

      it('the predicate is an invoker function executable by acc_dispatch only; the policies are exactly 0047’s', async () => {
        const fn = await admin(
          `SELECT p.prosecdef,
                  has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                  has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app,
                  has_function_privilege('acc_delivery', p.oid, 'EXECUTE') AS delivery,
                  has_function_privilege('acc_dispatch', p.oid, 'EXECUTE') AS dispatch
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'app_dispatch_owns_receipt'`,
        );
        expect(fn.rows).toEqual([
          { prosecdef: false, pub: false, app: false, delivery: false, dispatch: true },
        ]);
        const pol = await admin(
          `SELECT policyname, cmd, roles::text[] AS roles, qual, with_check FROM pg_policies
            WHERE tablename = 'webhook_events' AND 'acc_dispatch' = ANY(roles) ORDER BY policyname`,
        );
        expect(pol.rows).toEqual([
          {
            policyname: 'webhook_events_dispatch_select',
            cmd: 'SELECT',
            roles: ['acc_dispatch'],
            qual: 'app_dispatch_owns_receipt(provider_id, matched_attempt_id, normalized, false)',
            with_check: null,
          },
          {
            policyname: 'webhook_events_dispatch_update',
            cmd: 'UPDATE',
            roles: ['acc_dispatch'],
            qual: "((outcome = ANY (ARRAY['deferred'::webhook_event_outcome, 'unmatched'::webhook_event_outcome])) AND app_dispatch_owns_receipt(provider_id, matched_attempt_id, normalized, false))",
            with_check:
              '((matched_attempt_id IS NOT NULL) AND (matched_org_id = app_current_org_id()) AND app_dispatch_owns_receipt(provider_id, matched_attempt_id, normalized, true))',
          },
        ]);
      });
    });
  });

  describe('webhook_events deduplication and integrity (plan §1.1–§1.2)', () => {
    const insertOrCount = (
      c: PoolClient,
      providerId: string,
      eventId: string | null,
      hash: Buffer,
      requestId = uuidv7(),
      index = 0,
    ) =>
      c.query<{ id: string; inserted: boolean }>(
        eventId === null
          ? `INSERT INTO webhook_events (provider_id, request_id, event_index, provider_event_id, event_sha256, outcome)
             VALUES ($1, $2, $3, NULL, $4, 'unmatched')
             ON CONFLICT (provider_id, event_sha256) WHERE provider_event_id IS NULL
             DO UPDATE SET duplicate_count = webhook_events.duplicate_count + 1, last_duplicate_at = now()
             RETURNING id, (xmax = 0) AS inserted`
          : `INSERT INTO webhook_events (provider_id, request_id, event_index, provider_event_id, event_sha256, outcome)
             VALUES ($1, $2, $3, $5, $4, 'unmatched')
             ON CONFLICT (provider_id, provider_event_id) WHERE provider_event_id IS NOT NULL
             DO UPDATE SET duplicate_count = webhook_events.duplicate_count + 1, last_duplicate_at = now()
             RETURNING id, (xmax = 0) AS inserted`,
        eventId === null
          ? [providerId, requestId, index, hash]
          : [providerId, requestId, index, hash, eventId],
      );

    it('the provider event id is the primary key: repeats are counted on the original row, never stored (AC-ID-1a)', async () => {
      await inTx(deliveryPool, { [DELIVERY_SESSION_VARS.PROVIDER_ID]: providerP }, async (c) => {
        const first = await insertOrCount(c, providerP, 'evt-1', randomBytes(32));
        const again = await insertOrCount(c, providerP, 'evt-1', randomBytes(32));
        const third = await insertOrCount(c, providerP, 'evt-1', randomBytes(32));
        expect(first.rows[0]).toMatchObject({ inserted: true });
        expect(again.rows[0]).toEqual({ id: first.rows[0]!.id, inserted: false });
        expect(third.rows[0]!.inserted).toBe(false);
        const row = await c.query(
          `SELECT count(*)::int AS n, max(duplicate_count) AS d, bool_and(last_duplicate_at IS NOT NULL) AS seen FROM webhook_events WHERE provider_event_id = 'evt-1'`,
        );
        expect(row.rows[0]).toEqual({ n: 1, d: 2, seen: true });
      });
    });

    it('the hash is used only without an event id; identical bytes under different event ids are both processed', async () => {
      await inTx(deliveryPool, { [DELIVERY_SESSION_VARS.PROVIDER_ID]: providerP }, async (c) => {
        const bytes = createHash('sha256').update('same canonical event').digest();
        expect((await insertOrCount(c, providerP, null, bytes)).rows[0]!.inserted).toBe(true);
        expect((await insertOrCount(c, providerP, null, bytes)).rows[0]!.inserted).toBe(false);
        expect((await insertOrCount(c, providerP, 'evt-x', bytes)).rows[0]!.inserted).toBe(true);
        expect((await insertOrCount(c, providerP, 'evt-y', bytes)).rows[0]!.inserted).toBe(true);
      });
    });

    it('identity is immutable, the match is write-once, a settled outcome never changes, counters never decrease', async () => {
      await inTx(db.adminPool, {}, async (c) => {
        const { attemptIds } = await plant(c, A, {
          attempts: [{ provider: providerP, status: 'accepted' }],
        });
        const { rows } = await c.query(
          `INSERT INTO webhook_events (provider_id, request_id, event_index, event_sha256, outcome) VALUES ($1, $2, 0, $3, 'deferred') RETURNING id`,
          [providerP, uuidv7(), randomBytes(32)],
        );
        const id = rows[0].id;
        await c.query(
          `UPDATE webhook_events SET outcome = 'applied', matched_attempt_id = $2, matched_org_id = $3, processed_at = now() WHERE id = $1`,
          [id, attemptIds[0], A.orgId],
        );
        await c.query('SAVEPOINT s');
        for (const [statement, message] of [
          [
            `UPDATE webhook_events SET outcome = 'conflict' WHERE id = $1`,
            /WEBHOOK_EVENT_OUTCOME_SETTLED/,
          ],
          [`UPDATE webhook_events SET event_index = 5 WHERE id = $1`, /WEBHOOK_EVENT_IMMUTABLE/],
          [
            `UPDATE webhook_events SET provider_event_id = 'late' WHERE id = $1`,
            /WEBHOOK_EVENT_IMMUTABLE/,
          ],
          [
            `UPDATE webhook_events SET matched_attempt_id = NULL, matched_org_id = NULL WHERE id = $1`,
            /WEBHOOK_EVENT_MATCH_IMMUTABLE/,
          ],
          [
            `UPDATE webhook_events SET duplicate_count = -1 WHERE id = $1`,
            /duplicate_count|DUPLICATE_COUNT/,
          ],
        ] as const) {
          expect(await errorCode(c.query(statement, [id]))).toMatch(message);
          await c.query('ROLLBACK TO SAVEPOINT s');
        }
        expect(
          await errorCode(
            c.query(`UPDATE webhook_events SET matched_org_id = NULL WHERE id = $1`, [id]),
          ),
        ).toMatch(/match_consistent/);
      });
    });

    it('refuses more than 100 events per request and malformed hashes', async () => {
      await inTx(db.adminPool, {}, async (c) => {
        await c.query('SAVEPOINT s');
        expect(
          await errorCode(
            c.query(
              `INSERT INTO webhook_events (provider_id, request_id, event_index, event_sha256, outcome) VALUES ($1, $2, 100, $3, 'unmatched')`,
              [providerP, uuidv7(), randomBytes(32)],
            ),
          ),
        ).toMatch(/event_index/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        expect(
          await errorCode(
            c.query(
              `INSERT INTO webhook_events (provider_id, request_id, event_index, event_sha256, outcome) VALUES ($1, $2, 0, $3, 'unmatched')`,
              [providerP, uuidv7(), randomBytes(16)],
            ),
          ),
        ).toMatch(/event_sha256/);
      });
    });
  });

  describe('resolvers (spec Rev 2 §C.2, §E.2–§E.3)', () => {
    it('resolves an ingress key hash — current, previous within grace — and nothing else (AC-SV-5, database level)', async () => {
      const current = randomBytes(32);
      const previous = randomBytes(32);
      const expired = randomBytes(32);
      await inTx(db.adminPool, {}, async (c) => {
        await c.query(
          `UPDATE providers SET webhook_ingress_key_hash = $2, webhook_ingress_key_previous_hash = $3,
                  webhook_ingress_key_previous_expires_at = now() + interval '1 hour', webhook_ingress_enabled = true WHERE id = $1`,
          [providerP, current, previous],
        );
        await c.query(
          `UPDATE providers SET webhook_ingress_key_hash = $2, webhook_ingress_key_previous_hash = $3,
                  webhook_ingress_key_previous_expires_at = now() - interval '1 second' WHERE id = $1`,
          [providerQ, randomBytes(32), expired],
        );
        const resolve = async (h: Buffer | null) =>
          (
            await c.query(
              `SELECT provider_id, adapter_key, channel_code, ingress_enabled FROM app_webhook_provider_resolve($1)`,
              [h],
            )
          ).rows;
        expect(await resolve(current)).toEqual([
          {
            provider_id: providerP,
            adapter_key: 'simulator',
            channel_code: 'sms',
            ingress_enabled: true,
          },
        ]);
        expect((await resolve(previous))[0]?.provider_id).toBe(providerP);
        expect(await resolve(expired)).toEqual([]);
        expect(await resolve(randomBytes(32))).toEqual([]);
        expect(await resolve(randomBytes(16))).toEqual([]);
        expect(await resolve(null)).toEqual([]);
        // The previous hash can never equal the current one.
        expect(
          await errorCode(
            c.query(
              `UPDATE providers SET webhook_ingress_key_previous_hash = webhook_ingress_key_hash WHERE id = $1`,
              [providerP],
            ),
          ),
        ).toMatch(/providers_webhook_ingress_previous_consistent/);
      });
    });

    it('resolves a delivery event to one attempt of the given provider only (AC-TI-1, database level)', async () => {
      await inTx(db.adminPool, {}, async (c) => {
        const pmid = `pm-${uuidv7()}`;
        const m = await plant(c, A, {
          attempts: [{ provider: providerP, status: 'accepted', pmid }],
        });
        const noPmid = await plant(c, B, {
          attempts: [{ provider: providerP, status: 'outcome_unknown' }],
        });
        const resolve = async (
          provider: string,
          providerMessageId: string | null,
          clientReference: string | null,
        ) =>
          (
            await c.query(
              `SELECT attempt_id, message_id, org_id, attempt_status FROM app_delivery_resolve($1, $2, $3)`,
              [provider, providerMessageId, clientReference],
            )
          ).rows;
        expect(await resolve(providerP, pmid, null)).toEqual([
          {
            attempt_id: m.attemptIds[0],
            message_id: m.messageId,
            org_id: A.orgId,
            attempt_status: 'accepted',
          },
        ]);
        // Another provider never sees it, even with the right id.
        expect(await resolve(providerQ, pmid, null)).toEqual([]);
        expect(await resolve(providerQ, null, m.attemptIds[0]!)).toEqual([]);
        // The client reference (attempt id) resolves an attempt that has no provider message id (outcome unknown).
        expect(await resolve(providerP, null, noPmid.attemptIds[0]!)).toEqual([
          {
            attempt_id: noPmid.attemptIds[0],
            message_id: noPmid.messageId,
            org_id: B.orgId,
            attempt_status: 'outcome_unknown',
          },
        ]);
        // A provider message id wins over a client reference that points elsewhere.
        expect((await resolve(providerP, pmid, noPmid.attemptIds[0]!))[0]?.attempt_id).toBe(
          m.attemptIds[0],
        );
        expect(await resolve(providerP, 'unknown', null)).toEqual([]);
      });
    });
  });
  describe('platform support read of webhook_events (spec Rev 2 §C.2a, AC-TI-3)', () => {
    const asAppUser = async <R>(
      user: string | null,
      platform: boolean,
      work: (c: PoolClient) => Promise<R>,
    ): Promise<R> =>
      inTx(
        db.appPool,
        {
          'app.current_org_id': '',
          'app.current_user_id': user ?? '',
          'app.is_platform_admin': platform ? 'on' : 'off',
          'app.provisioning': 'off',
        },
        work,
      );
    const read = (
      c: PoolClient,
      provider: string,
      outcome: string | null = null,
      limit: number | null = null,
    ) =>
      c.query<{ d: Array<Record<string, unknown>> }>(
        'SELECT app_platform_support_webhook_events($1::uuid, $2::text, $3::integer) AS d',
        [provider, outcome, limit],
      );
    const sqlState = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { code?: string }) => e.code ?? 'no-code',
      );

    let providerS: string;
    let providerT: string;

    beforeAll(async () => {
      // Dedicated providers: other cases commit events for P and Q.
      const mk = async (name: string) =>
        (
          await admin(
            `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
            [smsId, `${name}-${uuidv7().slice(-8)}`],
          )
        ).rows[0].id as string;
      providerS = await mk('p50-provider-s');
      providerT = await mk('p50-provider-t');
      supportUsers.push(await plantPlatformSupport(db.admin, 'p50-support'));
      supportUsers.push(await plantPlatformAdmin(db.admin, 'p50-super'));
      const hash = () => createHash('sha256').update(randomBytes(16)).digest();
      for (let i = 0; i < 3; i++) {
        await admin(
          `INSERT INTO webhook_events (provider_id, request_id, event_index, provider_event_id, event_sha256, outcome, normalized)
           VALUES ($1, $2, 0, $3, $4, $5, '{"kind":"delivered"}')`,
          [providerS, uuidv7(), `evt-support-${i}`, hash(), i === 0 ? 'unmatched' : 'applied'],
        );
      }
      await admin(
        `INSERT INTO webhook_events (provider_id, request_id, event_index, event_sha256, outcome)
         VALUES ($1, $2, 0, $3, 'informational')`,
        [providerT, uuidv7(), hash()],
      );
    });

    afterAll(async () => {
      for (const p of [providerS, providerT].filter(Boolean)) {
        await admin(`DELETE FROM webhook_events WHERE provider_id = $1`, [p]);
        await admin(`DELETE FROM providers WHERE id = $1`, [p]);
      }
    });

    it('a platform.support.read holder reads the redacted columns of one provider only', async () => {
      const rows = await asAppUser(
        supportUsers[0]!,
        false,
        async (c) => (await read(c, providerS)).rows[0]!.d,
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.providerId === providerS)).toBe(true);
      expect(Object.keys(rows[0]!).sort()).toEqual([
        'duplicateCount',
        'eventIndex',
        'id',
        'lastDuplicateAt',
        'matchedAttemptId',
        'matchedOrgId',
        'normalized',
        'outcome',
        'processedAt',
        'providerEventId',
        'providerId',
        'receivedAt',
        'requestId',
        'signatureTimestamp',
      ]);
      const unmatched = await asAppUser(
        supportUsers[0]!,
        false,
        async (c) => (await read(c, providerS, 'unmatched')).rows[0]!.d,
      );
      expect(unmatched.map((r) => r.providerEventId)).toEqual(['evt-support-0']);
      const one = await asAppUser(
        supportUsers[1]!,
        true,
        async (c) => (await read(c, providerS, null, 1)).rows[0]!.d,
      );
      expect(one).toHaveLength(1);
    });

    it('anyone else is refused (42501): no user, a forged platform flag, a tenant member', async () => {
      expect(await asAppUser(null, true, (c) => sqlState(read(c, providerS)))).toBe('42501');
      expect(await asAppUser(uuidv7(), true, (c) => sqlState(read(c, providerS)))).toBe('42501');
      expect(await asAppUser(A.userId, false, (c) => sqlState(read(c, providerS)))).toBe('42501');
    });

    it('is a definer function executable by acc_app alone', async () => {
      const { rows } = await admin(
        `SELECT p.prosecdef, p.proconfig,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app,
                has_function_privilege('acc_auth', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('acc_relay', p.oid, 'EXECUTE') AS relay,
                has_function_privilege('acc_dispatch', p.oid, 'EXECUTE') AS dispatch,
                has_function_privilege('acc_delivery', p.oid, 'EXECUTE') AS delivery
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'app_platform_support_webhook_events'`,
      );
      expect(rows).toEqual([
        {
          prosecdef: true,
          proconfig: ['search_path=public, pg_temp'],
          pub: false,
          app: true,
          auth: false,
          relay: false,
          dispatch: false,
          delivery: false,
        },
      ]);
    });
  });
});
