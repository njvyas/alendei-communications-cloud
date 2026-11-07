/**
 * U13.4 platform support (migration 0040), proven directly against PostgreSQL.
 *
 * Every probe runs as the real non-owner `acc_app` login (and `acc_auth` /
 * `acc_relay` where privilege is the question) with raw `set_config` claims,
 * exactly as production writes them; the owner only plants and removes
 * synthetic data. Nothing here goes through the API.
 *
 *  - app_platform_support_dispatch_diagnostics() returns operational metadata
 *    only: no recipient address, payload, failure text or anything derived from
 *    them (ADR-015 R-8 is not amended; the function's result IS the boundary).
 *  - Failure reasons are reduced to codes from a closed list that matches
 *    PLATFORM_SUPPORT_FAILURE_CODES.
 *  - Only an active `platform.support.read` holder may call it; only acc_app
 *    holds EXECUTE.
 *  - audit_logs_platform_support_read admits `platform.support.read` holders
 *    with no organization selected and nobody else; its checks are InitPlans.
 *  - The Model B content policies are unchanged: support still reads no
 *    message or attempt row through RLS.
 */
import { PLATFORM_SUPPORT_FAILURE_CODES } from '@acc/contracts';
import { Pool, type PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import {
  connect,
  createReseller,
  createTenant,
  destroyReseller,
  destroyTenant,
  loadTestEnv,
  plantPlatformAdmin,
  plantPlatformSupport,
  removeIdentities,
  type Principals,
  type TenantFixture,
} from './harness';

/** Planted strings that must never leave the database function. */
const RECIPIENT = '+919800000099';
const RECIPIENT_DIGITS = '9800000099';
const BODY = 'PLANTED-BODY-7731';
const PROVIDER_TEXT = 'provider echoed';
const CREDENTIAL = 'sk_live_PLANTED';

interface Ctx {
  readonly org?: string;
  readonly user?: string;
  readonly platform?: boolean;
}

const claims = (ctx: Ctx): [string, string][] => [
  ['app.current_org_id', ctx.org ?? ''],
  ['app.current_workspace_id', ''],
  ['app.current_reseller_id', ''],
  ['app.current_user_id', ctx.user ?? ''],
  ['app.is_platform_admin', ctx.platform ? 'on' : 'off'],
  ['app.provisioning', 'off'],
  ['app.current_api_key_id', ''],
];

async function code(work: Promise<unknown>): Promise<string | null> {
  return work.then(
    () => null,
    (e: { code?: string }) => e.code ?? 'no-code',
  );
}

interface DispatchResult {
  queue: Record<string, number>;
  recentMessages: Array<Record<string, unknown> & { attempts: Array<Record<string, unknown>> }>;
}

const MESSAGE_KEYS = [
  'attempts',
  'channel',
  'completedAt',
  'createdAt',
  'failureCode',
  'messageId',
  'status',
  'updatedAt',
];
const ATTEMPT_KEYS = [
  'adapterKey',
  'attemptNumber',
  'attemptedAt',
  'failureCode',
  'latencyMs',
  'providerId',
  'status',
];

describe('U13.4 platform support — direct PostgreSQL (migration 0040)', () => {
  let db: Principals;
  let relayPool: Pool;
  let reseller: string;
  let A: TenantFixture;
  let B: TenantFixture;
  let smsId: string;
  let providerId: string;
  const user: Record<string, string> = {};
  const role: Record<string, string> = {};
  const planted: string[] = [];
  const msg: Record<string, string> = {};
  let auditOnlyRole: string | undefined;

  const admin = (text: string, params: unknown[] = []) => db.adminPool.query(text, params);

  async function asApp<R>(ctx: Ctx, work: (c: PoolClient) => Promise<R>): Promise<R> {
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      for (const [name, value] of claims(ctx)) {
        await c.query('SELECT set_config($1, $2, true)', [name, value]);
      }
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  const diagnostics = (ctx: Ctx, orgId: string, limit: number | null = null) =>
    asApp(ctx, async (c) => {
      const { rows } = await c.query<{ d: DispatchResult }>(
        'SELECT app_platform_support_dispatch_diagnostics($1::uuid, NULL, NULL, $2::integer) AS d',
        [orgId, limit],
      );
      return rows[0]!.d;
    });

  const diagnosticsCode = (ctx: Ctx, orgId: string) =>
    asApp(ctx, (c) =>
      code(c.query('SELECT app_platform_support_dispatch_diagnostics($1::uuid)', [orgId])),
    );

  async function plantUser(label: string) {
    const { rows } = await admin(
      `INSERT INTO users (email, status, password_hash) VALUES ($1, 'active', 'not-a-login-credential') RETURNING id`,
      [`${label}-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`],
    );
    planted.push(rows[0].id);
    return rows[0].id as string;
  }

  async function plantMessage(
    t: TenantFixture,
    m: {
      status: string;
      reason: string | null;
      recipient?: string;
      body?: string;
      /** Phase 5.0 delivery status (planted by the owner, which the insert guard admits). */
      delivery?: 'pending' | 'delivered' | 'undelivered' | 'not_supported' | null;
    },
  ) {
    const contactId = uuidv7();
    await admin(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [
      contactId,
      t.orgId,
      t.workspaceId,
    ]);
    const id = uuidv7();
    await admin(
      `INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, payload,
                             recipient_address, failure_reason, correlation_id,
                             delivery_status, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11::message_delivery_status,
               CASE WHEN $11::text = 'delivered' THEN now() END)`,
      [
        id,
        t.orgId,
        t.workspaceId,
        contactId,
        smsId,
        m.status,
        JSON.stringify({ text: m.body ?? BODY }),
        m.recipient ?? RECIPIENT,
        m.reason,
        uuidv7(),
        m.delivery ?? null,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    loadTestEnv();
    db = connect();
    relayPool = new Pool({ connectionString: process.env.DATABASE_RELAY_URL!, max: 1 });

    reseller = await createReseller(db.admin, 'u134');
    A = await createTenant(db.admin, 'u134-a', { resellerId: reseller });
    B = await createTenant(db.admin, 'u134-b', { resellerId: reseller });

    for (const t of [A, B]) {
      const { rows } = await admin(
        `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
         VALUES ($1, 'u134_member', 'U13.4 member', false, '{organization}') RETURNING id`,
        [t.orgId],
      );
      role[t.orgId] = rows[0].id;
    }
    user.memberA = await plantUser('u134-member-a');
    await admin(
      `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'organization', $3)`,
      [user.memberA, role[A.orgId], A.orgId],
    );
    user.memberB = await plantUser('u134-member-b');
    await admin(
      `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'organization', $3)`,
      [user.memberB, role[B.orgId], B.orgId],
    );
    user.support = await plantPlatformSupport(db.admin, 'u134-support');
    user.supportDisabled = await plantPlatformSupport(db.admin, 'u134-support-off');
    user.superAdmin = await plantPlatformAdmin(db.admin, 'u134-super');
    planted.push(user.support, user.supportDisabled, user.superAdmin);

    // A platform role holding platform.audit.read but NOT platform.support.read
    // (the policy must not admit it, U13.4 review F-5).
    const c = await db.adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.provisioning','on',true)`);
      const { rows } = await c.query(
        `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
         VALUES (NULL, $1, 'U13.4 audit only', false, '{platform}') RETURNING id`,
        [`u134_audit_only_${uuidv7().replace(/-/g, '').slice(-8)}`],
      );
      auditOnlyRole = rows[0].id as string;
      await c.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE key = 'platform.audit.read'`,
        [auditOnlyRole],
      );
      await c.query(`SELECT set_config('app.is_platform_admin','on',true)`);
      user.auditOnly = await (async () => {
        const { rows: u } = await c.query(
          `INSERT INTO users (email, status, password_hash) VALUES ($1, 'active', 'not-a-login-credential') RETURNING id`,
          [`u134-audit-only-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`],
        );
        return u[0].id as string;
      })();
      await c.query(
        `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'platform', NULL)`,
        [user.auditOnly, auditOnlyRole],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    planted.push(user.auditOnly);
    await admin(`UPDATE users SET status = 'disabled' WHERE id = $1`, [user.supportDisabled]);

    smsId = (await admin(`SELECT id FROM channels WHERE code = 'sms'`)).rows[0].id;
    providerId = (
      await admin(
        `INSERT INTO providers (channel_id, name, adapter_key, status) VALUES ($1, $2, 'simulator', 'active') RETURNING id`,
        [smsId, `u134-provider-${uuidv7().slice(-8)}`],
      )
    ).rows[0].id;
    for (const t of [A, B]) {
      await admin(
        `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority) VALUES ($1, $2, $3, 1)`,
        [t.orgId, providerId, smsId],
      );
    }

    // Organization B: a failed message whose stored reason and attempt text echo
    // the recipient, the body and a credential; three in-flight messages, one
    // per queue state; and messages with platform-authored and unknown reasons.
    msg.failed = await plantMessage(B, {
      status: 'failed',
      reason: `INVALID_REQUEST: ${PROVIDER_TEXT} ${RECIPIENT} body="${BODY}"`,
    });
    await admin(
      `INSERT INTO message_attempts (message_id, org_id, provider_id, channel_id, attempt_number,
                                     fencing_epoch, claim_token, status, failure_reason, latency_ms)
       VALUES ($1, $2, $3, $4, 1, 1, $5, 'failed', $6, 120)`,
      [
        msg.failed,
        B.orgId,
        providerId,
        smsId,
        uuidv7(),
        `UNKNOWN: credential ${CREDENTIAL} rejected for ${RECIPIENT_DIGITS}`,
      ],
    );
    msg.closed = await plantMessage(B, { status: 'failed', reason: 'Organization is closed' });
    msg.junk = await plantMessage(B, {
      status: 'failed',
      reason: `OTP4821 ${BODY} for ${RECIPIENT}`,
    });
    msg.ready = await plantMessage(B, { status: 'queued', reason: null });
    msg.delayed = await plantMessage(B, { status: 'queued', reason: null });
    msg.claimed = await plantMessage(B, { status: 'routing', reason: null });
    await admin(
      `INSERT INTO message_dispatch_queue (message_id, org_id, available_at) VALUES ($1, $2, now() - interval '1 minute')`,
      [msg.ready, B.orgId],
    );
    await admin(
      `INSERT INTO message_dispatch_queue (message_id, org_id, available_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [msg.delayed, B.orgId],
    );
    await admin(
      `INSERT INTO message_dispatch_queue (message_id, org_id, available_at, claim_token, claimed_until, claimed_by)
       VALUES ($1, $2, now() - interval '1 minute', $3, now() + interval '5 minutes', 'u134-test')`,
      [msg.claimed, B.orgId, uuidv7()],
    );
    // Organization A: one failed message, which a diagnostic of B must not return.
    msg.otherOrg = await plantMessage(A, {
      status: 'failed',
      reason: 'TIMEOUT: Submission timed out',
    });

    // One audit row in each organization, with an IP address and user agent.
    for (const t of [A, B]) {
      await admin(
        `INSERT INTO audit_logs (correlation_id, actor_type, actor_label, action, resource_type, resource_id,
                                 scope_type, scope_id, outcome, metadata, ip, user_agent)
         VALUES ($1, 'system', 'u134', 'u134.probe', 'Organization', $2, 'organization', $2, 'success', '{}', '203.0.113.7', 'u134-agent')`,
        [uuidv7(), t.orgId],
      );
    }
  }, 120_000);

  afterAll(async () => {
    const orgIds = [A?.orgId, B?.orgId].filter(Boolean);
    if (orgIds.length > 0) {
      await admin(`DELETE FROM message_dispatch_queue WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(`DELETE FROM message_attempts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(`DELETE FROM messages WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(`DELETE FROM contacts WHERE org_id = ANY($1::uuid[])`, [orgIds]);
      await admin(`DELETE FROM organization_provider_assignments WHERE org_id = ANY($1::uuid[])`, [
        orgIds,
      ]);
    }
    if (providerId) await admin(`DELETE FROM providers WHERE id = $1`, [providerId]);
    await removeIdentities(db.admin, planted);
    if (auditOnlyRole) {
      const c = await db.adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.provisioning','on',true)`);
        await c.query(`DELETE FROM role_permissions WHERE role_id = $1`, [auditOnlyRole]);
        await c.query(`DELETE FROM roles WHERE id = $1`, [auditOnlyRole]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    }
    if (A) await destroyTenant(db.admin, A);
    if (B) await destroyTenant(db.admin, B);
    if (reseller) await destroyReseller(db.admin, reseller);
    await relayPool?.end();
    await db?.close();
  }, 120_000);

  // ===========================================================================
  describe('dispatch diagnostics: what support receives (F-1, F-2)', () => {
    it('support receives organization B metadata only: no recipient, body, provider text or credential', async () => {
      const d = await diagnostics({ user: user.support }, B.orgId);
      const text = JSON.stringify(d);
      for (const planted of [
        RECIPIENT,
        RECIPIENT_DIGITS,
        BODY,
        PROVIDER_TEXT,
        CREDENTIAL,
        'OTP4821',
      ]) {
        expect(text).not.toContain(planted);
      }
      expect(text).not.toMatch(/recipient|payload|failureReason|body/i);
      expect(text).not.toContain(msg.otherOrg);

      expect(Object.keys(d).sort()).toEqual(['queue', 'recentMessages']);
      expect(d.recentMessages.length).toBe(6);
      for (const m of d.recentMessages) {
        expect(Object.keys(m).sort()).toEqual(MESSAGE_KEYS);
        for (const a of m.attempts) expect(Object.keys(a).sort()).toEqual(ATTEMPT_KEYS);
      }
    });

    it('failure reasons become fixed codes; unknown or free-text reasons become OTHER', async () => {
      const d = await diagnostics({ user: user.support }, B.orgId);
      const byId = new Map(d.recentMessages.map((m) => [m.messageId as string, m]));
      expect(byId.get(msg.failed)!.failureCode).toBe('INVALID_REQUEST');
      expect(byId.get(msg.failed)!.attempts).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          providerId,
          adapterKey: 'simulator',
          status: 'failed',
          failureCode: 'UNKNOWN',
          latencyMs: 120,
        }),
      ]);
      expect(byId.get(msg.closed)!.failureCode).toBe('ORGANIZATION_CLOSED');
      expect(byId.get(msg.junk)!.failureCode).toBe('OTHER');
      expect(byId.get(msg.ready)!.failureCode).toBeNull();
    });

    it('queue counts come from the dispatch queue: ready, delayed and claimed', async () => {
      const d = await diagnostics({ user: user.support }, B.orgId);
      expect(d.queue).toEqual({ pendingCount: 1, delayedCount: 1, claimedCount: 1 });
      const a = await diagnostics({ user: user.support }, A.orgId);
      expect(a.queue).toEqual({ pendingCount: 0, delayedCount: 0, claimedCount: 0 });
    });

    it('the limit is clamped to 1..50 inside the function', async () => {
      expect((await diagnostics({ user: user.support }, B.orgId, -5)).recentMessages).toHaveLength(
        1,
      );
      expect((await diagnostics({ user: user.support }, B.orgId, 0)).recentMessages).toHaveLength(
        1,
      );
      expect(
        (await diagnostics({ user: user.support }, B.orgId, 2_000_000_000)).recentMessages,
      ).toHaveLength(6);
      const { rows } = await admin(
        `SELECT pg_get_functiondef('app_platform_support_dispatch_diagnostics(uuid,text,text,integer,text)'::regprocedure) AS d`,
      );
      expect(rows[0].d).toContain('least(greatest(coalesce(p_limit, 20), 1), 50)');
    });

    it('a super administrator (who holds platform.support.read) is admitted', async () => {
      const d = await diagnostics({ user: user.superAdmin, platform: true }, B.orgId);
      expect(d.recentMessages.length).toBe(6);
    });
  });

  // ===========================================================================
  describe('dispatch diagnostics: who is refused (42501)', () => {
    it('a tenant member — in its own organization or another — cannot execute it', async () => {
      expect(await diagnosticsCode({ org: A.orgId, user: user.memberA }, A.orgId)).toBe('42501');
      expect(await diagnosticsCode({ org: A.orgId, user: user.memberA }, B.orgId)).toBe('42501');
      expect(await diagnosticsCode({ user: user.memberB }, B.orgId)).toBe('42501');
    });

    it('a missing user, and a forged platform-admin flag, are refused', async () => {
      expect(await diagnosticsCode({}, B.orgId)).toBe('42501');
      expect(await diagnosticsCode({ platform: true }, B.orgId)).toBe('42501');
      expect(await diagnosticsCode({ user: user.memberA, platform: true }, B.orgId)).toBe('42501');
      expect(await diagnosticsCode({ user: uuidv7(), platform: true }, B.orgId)).toBe('42501');
    });

    it('a disabled support user and a platform.audit.read-only user are refused', async () => {
      expect(await diagnosticsCode({ user: user.supportDisabled }, B.orgId)).toBe('42501');
      expect(await diagnosticsCode({ user: user.auditOnly }, B.orgId)).toBe('42501');
    });

    it('EXECUTE is held by acc_app alone; acc_auth, acc_relay, acc_dispatch and acc_delivery are refused', async () => {
      const { rows } = await admin(
        `SELECT p.proname, p.prosecdef, p.proconfig,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app,
                has_function_privilege('acc_auth', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('acc_relay', p.oid, 'EXECUTE') AS relay,
                has_function_privilege('acc_dispatch', p.oid, 'EXECUTE') AS dispatch,
                has_function_privilege('acc_delivery', p.oid, 'EXECUTE') AS delivery
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('app_platform_support_dispatch_diagnostics', 'app_support_failure_code')
         ORDER BY p.proname`,
      );
      expect(rows).toEqual([
        {
          proname: 'app_platform_support_dispatch_diagnostics',
          prosecdef: true,
          proconfig: ['search_path=public, pg_temp'],
          pub: false,
          app: true,
          auth: false,
          relay: false,
          dispatch: false,
          delivery: false,
        },
        {
          proname: 'app_support_failure_code',
          prosecdef: false,
          proconfig: ['search_path=public, pg_temp'],
          pub: false,
          app: false,
          auth: false,
          relay: false,
          dispatch: false,
          delivery: false,
        },
      ]);
      const call = 'SELECT app_platform_support_dispatch_diagnostics($1::uuid)';
      expect(await code(db.authPool.query(call, [B.orgId]))).toBe('42501');
      expect(await code(relayPool.query(call, [B.orgId]))).toBe('42501');
    });
  });

  // ===========================================================================
  describe('dispatch diagnostics: the delivery-status filter (migration 0049)', () => {
    let C: TenantFixture;
    const dm: Record<string, string> = {};
    // A provider reference planted on an attempt: the function must never return it (OD-9).
    const PROVIDER_REF = `u134-ref-${uuidv7().replace(/-/g, '').slice(-12)}`;
    const DELIVERY = ['pending', 'delivered', 'undelivered', 'not_supported'] as const;

    const filtered = (
      ctx: Ctx,
      orgId: string,
      f: { delivery?: string | null; status?: string | null; channel?: string | null },
    ) =>
      asApp(ctx, async (c) => {
        const { rows } = await c.query<{ d: DispatchResult }>(
          'SELECT app_platform_support_dispatch_diagnostics($1::uuid, $2, $3, 50, $4) AS d',
          [orgId, f.channel ?? null, f.status ?? null, f.delivery ?? null],
        );
        return rows[0]!.d;
      });
    const filteredCode = (ctx: Ctx, orgId: string, delivery: string) =>
      asApp(ctx, (c) =>
        code(
          c.query(
            'SELECT app_platform_support_dispatch_diagnostics($1::uuid, NULL, NULL, 20, $2)',
            [orgId, delivery],
          ),
        ),
      );
    const idsOf = (d: DispatchResult) => d.recentMessages.map((m) => m.messageId as string).sort();
    const support = () => ({ user: user.support });

    beforeAll(async () => {
      C = await createTenant(db.admin, 'u134-c', { resellerId: reseller });
      await admin(
        `INSERT INTO organization_provider_assignments (org_id, provider_id, channel_id, priority) VALUES ($1, $2, $3, 1)`,
        [C.orgId, providerId, smsId],
      );
      dm.pending = await plantMessage(C, { status: 'accepted', reason: null, delivery: 'pending' });
      dm.delivered = await plantMessage(C, {
        status: 'accepted',
        reason: null,
        delivery: 'delivered',
      });
      dm.undelivered = await plantMessage(C, {
        status: 'accepted',
        reason: null,
        delivery: 'undelivered',
      });
      dm.notSupported = await plantMessage(C, {
        status: 'accepted',
        reason: null,
        delivery: 'not_supported',
      });
      // A superseded attempt reported delivered after the submission failed.
      dm.failedDelivered = await plantMessage(C, {
        status: 'failed',
        reason: 'PROVIDER_ERROR: x',
        delivery: 'delivered',
      });
      // Not tracked: legacy accepted, an in-flight queued and a failed message.
      dm.legacy = await plantMessage(C, { status: 'accepted', reason: null, delivery: null });
      dm.queued = await plantMessage(C, { status: 'queued', reason: null, delivery: null });
      dm.failedUntracked = await plantMessage(C, {
        status: 'failed',
        reason: 'TIMEOUT: x',
        delivery: null,
      });
      await admin(
        `INSERT INTO message_attempts (message_id, org_id, provider_id, channel_id, attempt_number,
                                       fencing_epoch, claim_token, status, latency_ms,
                                       provider_message_id, delivery_status, delivered_at)
         VALUES ($1, $2, $3, $4, 1, 1, $5, 'accepted', 40, $6, 'delivered', now())`,
        [dm.delivered, C.orgId, providerId, smsId, uuidv7(), PROVIDER_REF],
      );
      // Organization A: a delivered message, which a diagnostic of C must not return.
      dm.otherOrgDelivered = await plantMessage(A, {
        status: 'accepted',
        reason: null,
        delivery: 'delivered',
      });
    }, 60_000);

    afterAll(async () => {
      if (!C) return;
      await admin(`DELETE FROM message_attempts WHERE org_id = $1`, [C.orgId]);
      await admin(`DELETE FROM messages WHERE org_id = $1`, [C.orgId]);
      await admin(`DELETE FROM contacts WHERE org_id = $1`, [C.orgId]);
      await admin(`DELETE FROM organization_provider_assignments WHERE org_id = $1`, [C.orgId]);
      await destroyTenant(db.admin, C);
    }, 60_000);

    it('each delivery status returns exactly its messages, whatever their submission status', async () => {
      const expected: Record<(typeof DELIVERY)[number], string[]> = {
        pending: [dm.pending!],
        delivered: [dm.delivered!, dm.failedDelivered!],
        undelivered: [dm.undelivered!],
        not_supported: [dm.notSupported!],
      };
      for (const value of DELIVERY) {
        const d = await filtered(support(), C.orgId, { delivery: value });
        expect([value, idsOf(d)]).toEqual([value, [...expected[value]].sort()]);
      }
    });

    it('untracked messages (no delivery status) never match any filter value', async () => {
      const untracked = [dm.legacy!, dm.queued!, dm.failedUntracked!];
      for (const value of DELIVERY) {
        const ids = idsOf(await filtered(support(), C.orgId, { delivery: value }));
        for (const id of untracked) expect(ids).not.toContain(id);
      }
    });

    it('filter omitted: exactly the 0040 behaviour — the default status set; the four-argument call is identical', async () => {
      const omitted = await filtered(support(), C.orgId, {});
      expect(idsOf(omitted)).toEqual([dm.failedDelivered!, dm.queued!, dm.failedUntracked!].sort());
      const fourArgs = await asApp(support(), async (c) => {
        const { rows } = await c.query<{ d: DispatchResult }>(
          'SELECT app_platform_support_dispatch_diagnostics($1::uuid, NULL, NULL, 50) AS d',
          [C.orgId],
        );
        return rows[0]!.d;
      });
      expect(fourArgs).toEqual(omitted);
      // Organization B (no delivery state) is unchanged too: the six 0040 messages.
      expect((await filtered(support(), B.orgId, {})).recentMessages).toHaveLength(6);
    });

    it('composes with the status and channel filters', async () => {
      const del = (status: string) =>
        filtered(support(), C.orgId, { delivery: 'delivered', status }).then(idsOf);
      expect(await del('accepted')).toEqual([dm.delivered]);
      expect(await del('failed')).toEqual([dm.failedDelivered]);
      expect(await del('queued')).toEqual([]);
      expect(
        idsOf(await filtered(support(), C.orgId, { delivery: 'delivered', channel: 'rcs' })),
      ).toEqual([]);
    });

    it('never crosses organizations', async () => {
      const ids = idsOf(await filtered(support(), C.orgId, { delivery: 'delivered' }));
      expect(ids).not.toContain(dm.otherOrgDelivered);
      expect(idsOf(await filtered(support(), A.orgId, { delivery: 'delivered' }))).toEqual([
        dm.otherOrgDelivered,
      ]);
      expect(idsOf(await filtered(support(), B.orgId, { delivery: 'delivered' }))).toEqual([]);
    });

    it('returns the 0040 shape only: no delivery field and no provider message reference', async () => {
      const d = await filtered(support(), C.orgId, { delivery: 'delivered' });
      for (const m of d.recentMessages) {
        expect(Object.keys(m).sort()).toEqual(MESSAGE_KEYS);
        for (const a of m.attempts) expect(Object.keys(a).sort()).toEqual(ATTEMPT_KEYS);
      }
      const text = JSON.stringify(d);
      expect(text).not.toContain(PROVIDER_REF);
      expect(text).not.toMatch(/delivery|providerMessage|recipient|payload/i);
    });

    it('a value outside message_delivery_status is refused with 22023', async () => {
      for (const value of [
        'read',
        'not_tracked',
        'expired',
        'DELIVERED',
        '',
        ' delivered',
        "delivered' OR '1'='1",
      ]) {
        expect([value, await filteredCode(support(), C.orgId, value)]).toEqual([value, '22023']);
      }
    });

    it('the caller check still comes first: with any filter value, every non-support caller gets 42501', async () => {
      for (const value of ['delivered', 'not-a-status']) {
        for (const ctx of [
          { org: C.orgId, user: user.memberA },
          { user: user.memberB },
          {},
          { platform: true },
          { user: user.memberA, platform: true },
          { user: user.supportDisabled },
          { user: user.auditOnly },
        ] as Ctx[]) {
          expect(await filteredCode(ctx, C.orgId, value)).toBe('42501');
        }
      }
      const call = 'SELECT app_platform_support_dispatch_diagnostics($1::uuid, NULL, NULL, 20, $2)';
      expect(await code(db.authPool.query(call, [C.orgId, 'delivered']))).toBe('42501');
      expect(await code(relayPool.query(call, [C.orgId, 'delivered']))).toBe('42501');
    });

    it('one function remains: the 0040 four-argument signature is gone (no overload); security properties unchanged', async () => {
      const { rows } = await admin(
        `SELECT p.oid::regprocedure::text AS sig, p.prosecdef, p.provolatile, p.proconfig,
                pg_get_userbyid(p.proowner) AS owner,
                (SELECT pg_get_userbyid(s.proowner) FROM pg_proc s
                  WHERE s.proname = 'app_support_failure_code') AS sibling_owner,
                p.proacl::text[] AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'app_platform_support_dispatch_diagnostics'`,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        sig: 'app_platform_support_dispatch_diagnostics(uuid,text,text,integer,text)',
        prosecdef: true,
        provolatile: 's',
        proconfig: ['search_path=public, pg_temp'],
      });
      // Same owner as the rest of migration 0040; EXECUTE for that owner and acc_app only —
      // no PUBLIC entry ("=X/…") and no other grantee.
      expect(row.owner).toBe(row.sibling_owner);
      expect([...(row.acl as string[])].sort()).toEqual(
        [`${row.owner}=X/${row.owner}`, `acc_app=X/${row.owner}`].sort(),
      );
    });

    it('the database enum and the API filter list are the same closed list', async () => {
      const { rows } = await admin(
        `SELECT unnest(enum_range(NULL::message_delivery_status))::text AS v`,
      );
      expect(rows.map((r) => r.v)).toEqual([...DELIVERY]);
    });
  });

  // ===========================================================================
  describe('failure codes', () => {
    it('the database allowlist and PLATFORM_SUPPORT_FAILURE_CODES are the same closed list', async () => {
      const sentences: Record<string, string> = {
        ORGANIZATION_CLOSED: 'Organization is closed',
        ORGANIZATION_SUSPENDED: 'Organization was suspended before provider submission',
        NO_PROVIDER_ASSIGNMENT: 'No active provider assignment for channel',
        DISPATCH_LEASE_EXPIRED:
          'Dispatch lease expired during external submission (outcome_unknown)',
      };
      for (const expected of PLATFORM_SUPPORT_FAILURE_CODES) {
        if (expected === 'OTHER') continue;
        const inputs = sentences[expected]
          ? [sentences[expected]]
          : [expected, `${expected}: ${PROVIDER_TEXT} ${RECIPIENT}`, `${expected} detail`];
        for (const input of inputs) {
          const { rows } = await admin('SELECT app_support_failure_code($1) AS c', [input]);
          expect({ input, code: rows[0].c }).toEqual({ input, code: expected });
        }
      }
    });

    it('anything else is OTHER; NULL stays NULL', async () => {
      for (const input of [
        'TIMEOUTX: no',
        'timeout: lower case',
        'OTP4821 your code',
        `${RECIPIENT} rejected`,
        'Organization is closed!',
        'AB',
        '',
      ]) {
        const { rows } = await admin('SELECT app_support_failure_code($1) AS c', [input]);
        expect({ input, code: rows[0].c }).toEqual({ input, code: 'OTHER' });
      }
      const { rows } = await admin('SELECT app_support_failure_code(NULL) AS c');
      expect(rows[0].c).toBeNull();
    });
  });

  // ===========================================================================
  describe('audit_logs read (F-5)', () => {
    const visibleOrgs = (ctx: Ctx) =>
      asApp(ctx, async (c) => {
        const { rows } = await c.query<{ org_id: string }>(
          `SELECT DISTINCT org_id FROM audit_logs WHERE org_id = ANY($1::uuid[])`,
          [[A.orgId, B.orgId]],
        );
        return rows.map((r) => r.org_id).sort();
      });

    it('support with no organization selected reads every organization’s rows', async () => {
      expect(await visibleOrgs({ user: user.support })).toEqual([A.orgId, B.orgId].sort());
    });

    it('support with an organization selected reads only that organization (existing policy)', async () => {
      expect(await visibleOrgs({ org: A.orgId, user: user.support })).toEqual([A.orgId]);
    });

    it('tenant members, a disabled support user, an audit-read-only user and no user read nothing cross-tenant', async () => {
      expect(await visibleOrgs({ user: user.memberA })).toEqual([]);
      expect(await visibleOrgs({ org: A.orgId, user: user.memberA })).toEqual([A.orgId]);
      expect(await visibleOrgs({ user: user.supportDisabled })).toEqual([]);
      expect(await visibleOrgs({ user: user.auditOnly })).toEqual([]);
      expect(await visibleOrgs({})).toEqual([]);
      expect(await visibleOrgs({ user: user.memberA, platform: true })).toEqual([]);
    });

    it('the policy names platform.support.read only, and every check is a scalar sub-select', async () => {
      const { rows } = await admin(
        `SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies
         WHERE tablename = 'audit_logs' AND policyname LIKE 'audit_logs_platform_support_%'
         ORDER BY policyname`,
      );
      expect(rows.map((r) => [r.policyname, r.cmd, r.roles])).toEqual([
        ['audit_logs_platform_support_insert', 'INSERT', '{acc_app}'],
        ['audit_logs_platform_support_read', 'SELECT', '{acc_app}'],
      ]);
      const read = rows[1].qual as string;
      expect(read).not.toContain('platform.audit.read');
      expect(read).toContain(
        "( SELECT app_has_platform_permission('platform.support.read'::text) AS app_has_platform_permission)",
      );
      expect(read).toContain('( SELECT app_current_user_id() AS app_current_user_id)');
      expect(read).toContain('( SELECT app_current_org_id() AS app_current_org_id)');
      const insert = rows[0].with_check as string;
      expect(insert).toContain(
        "( SELECT app_has_platform_permission('platform.support.read'::text) AS app_has_platform_permission)",
      );
    });

    it('the support permission check runs as an InitPlan, once per statement', async () => {
      const plan = await asApp({ user: user.support }, async (c) => {
        const { rows } = await c.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF, VERBOSE)
           SELECT id FROM audit_logs ORDER BY id DESC LIMIT 21`,
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(plan).toMatch(
        /InitPlan \d+\n\s+->\s+Result \(actual rows=1 loops=1\)\n\s+Output: app_has_platform_permission\('platform\.support\.read'::text\)/,
      );
    });
  });

  // ===========================================================================
  describe('audit_logs diagnostic-read insert', () => {
    const insertRow = (
      c: PoolClient,
      row: { actor: string; action?: string; scopeType?: string; scopeId?: string | null },
    ) =>
      c.query(
        `INSERT INTO audit_logs (correlation_id, actor_type, actor_user_id, action, resource_type,
                                 resource_id, scope_type, scope_id, outcome, metadata)
         VALUES ($1, 'user', $2, $3, 'platform_support', NULL, $4, $5, 'success', '{"tool":"probe"}')`,
        [
          uuidv7(),
          row.actor,
          row.action ?? 'platform.support.diagnostic_read',
          row.scopeType ?? 'platform',
          row.scopeId ?? null,
        ],
      );

    it('support may record its own diagnostic read', async () => {
      await asApp({ user: user.support }, async (c) => {
        expect(await code(insertRow(c, { actor: user.support }))).toBeNull();
      });
    });

    it('another action, another actor, a tenant member or a disabled support user is refused (42501)', async () => {
      await asApp({ user: user.support }, async (c) => {
        expect(
          await code(insertRow(c, { actor: user.support, action: 'platform.support.other' })),
        ).toBe('42501');
      });
      await asApp({ user: user.support }, async (c) => {
        expect(await code(insertRow(c, { actor: user.memberA }))).toBe('42501');
      });
      await asApp({ user: user.memberA }, async (c) => {
        expect(await code(insertRow(c, { actor: user.memberA }))).toBe('42501');
      });
      await asApp({ user: user.supportDisabled }, async (c) => {
        expect(await code(insertRow(c, { actor: user.supportDisabled }))).toBe('42501');
      });
    });
  });

  // ===========================================================================
  describe('Model B content RLS is unchanged', () => {
    const contentCounts = (ctx: Ctx) =>
      asApp(ctx, async (c) => ({
        messages: Number(
          (await c.query<{ n: string }>('SELECT count(*) AS n FROM messages')).rows[0]!.n,
        ),
        attempts: Number(
          (await c.query<{ n: string }>('SELECT count(*) AS n FROM message_attempts')).rows[0]!.n,
        ),
      }));

    it('support — with or without an organization selected — reads no message or attempt row', async () => {
      expect(await contentCounts({ user: user.support })).toEqual({ messages: 0, attempts: 0 });
      expect(await contentCounts({ org: B.orgId, user: user.support })).toEqual({
        messages: 0,
        attempts: 0,
      });
      expect(await contentCounts({ org: B.orgId, user: user.superAdmin, platform: true })).toEqual({
        messages: 0,
        attempts: 0,
      });
    });

    it('a member of B still reads B’s content, and only B’s', async () => {
      expect(await contentCounts({ org: B.orgId, user: user.memberB })).toEqual({
        messages: 6,
        attempts: 1,
      });
      expect(await contentCounts({ org: A.orgId, user: user.memberB })).toEqual({
        messages: 0,
        attempts: 0,
      });
    });

    it('no content-table policy names platform or support authority', async () => {
      const { rows } = await admin(
        `SELECT tablename, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expr
         FROM pg_policies WHERE tablename IN ('messages', 'message_attempts')`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(`${r.policyname} ${r.expr}`).not.toMatch(
          /support|platform_permission|is_platform_admin/,
        );
      }
    });
  });
});
