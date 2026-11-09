import { randomBytes, randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS, ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Client } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AppConfigService } from '../src/config/app-config.service';
import { CredentialService } from '../src/iam/credential.service';
import { MetricsService } from '../src/observability/metrics.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

/**
 * Phase 7 PR 7-6d-1 — billing-account provisioning, credit limits, freeze and unfreeze
 * (`DECISIONS.md` §1zi.13 D-76d-1, D-76d-4; handover Rev 2 §10.1–10.5).
 *
 *   10.1 Concurrency: provisioning, approvals, duplicate pending requests, limit races,
 *        freeze against in-flight reservations.
 *   10.2 Idempotency: replay, changed request, missing key, per-organisation key reuse.
 *   10.3 Dual control: the D-76d-1 matrix with the threshold unset and set (measured on
 *        the increase), four eyes, binding, and the threshold never taken from a request.
 *   10.4 Frozen accounts: status only; new reservations refused; existing reservations
 *        settle; credit-limit changes permitted and never unfreeze; unfreeze dual.
 *   10.5 Tenant isolation and access.
 *   Plus audit, metrics and reads. No ledger fact is written by any operation here.
 */

const url = (p: string) => `/${PREFIX}${p}`;

describe('Phase 7-6d-1: billing-account operations', () => {
  let h: Harness;
  let credentials: CredentialService;
  let config: AppConfigService;
  let metrics: MetricsService;
  let channelId: string;
  const tenants: TenantFixture[] = [];
  const users: string[] = [];
  let requester: string;
  let approver: string;
  let approver2: string;
  let approverId: string;
  let support: string;
  let apiKey: string;
  let keyTenant: TenantFixture;
  const contacts = new Map<string, string>();

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    config = h.app.get(AppConfigService);
    metrics = h.app.get(MetricsService);
    const [c] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    channelId = c!.id;
    requester = await platformUser('req', PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
    approver = await platformUser('apr', PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
    approverId = users[users.length - 1]!;
    approver2 = await platformUser('apr2', PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
    support = await platformUser('support', PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT);
    keyTenant = await tenant('p76d1-key');
    const prefix = `ak_test_${hex(8)}`;
    const secret = `s${hex(16)}`;
    const perms = await h.admin
      .select({ key: schema.permissions.key })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.BILLING_MANAGE, PERMISSIONS.BILLING_READ]),
      );
    await h.admin.insert(schema.apiKeys).values({
      orgId: keyTenant.orgId,
      name: `p76d1-${hex(3)}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      scopes: perms.map((x) => x.key),
      createdBy: keyTenant.userId,
    });
    apiKey = `${prefix}.${secret}`;
  }, 240_000);

  afterEach(() => threshold(null));

  afterAll(async () => {
    try {
      const orgIds = tenants.map((t) => t.orgId);
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        const orgs = sql`ANY(${`{${orgIds.join(',')}}`}::uuid[])`;
        for (const table of [
          'billing_account_operations',
          'usage_ledger',
          'wallets',
          'credit_accounts',
          'messages',
          'contacts',
          'api_keys',
        ]) {
          await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${orgs}`);
        }
        await tx.execute(
          sql`DELETE FROM idempotency_keys WHERE org_id IS NULL AND endpoint LIKE 'POST /platform/billing/%' AND actor_user_id = ANY(${`{${users.join(',')}}`}::uuid[])`,
        );
        if (users.length > 0) {
          const ids = sql`ANY(${`{${users.join(',')}}`}::uuid[])`;
          await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${ids}`);
          await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${ids}`);
          await tx.execute(sql`DELETE FROM users WHERE id = ${ids}`);
        }
      });
      for (const t of tenants) await destroyTenant(h.admin, t);
    } finally {
      await h.close();
    }
  }, 120_000);

  // --- fixtures ---------------------------------------------------------------

  function hex(n: number): string {
    return randomBytes(n).toString('hex');
  }

  /** The server's dual-control threshold (BILLING_DUAL_CONTROL_THRESHOLD_PAISE). */
  function threshold(value: number | null): void {
    if (value === null) {
      if (config && Object.prototype.hasOwnProperty.call(config, 'billing')) {
        delete (config as unknown as Record<string, unknown>).billing;
      }
      return;
    }
    Object.defineProperty(config, 'billing', {
      configurable: true,
      get: () => ({ enforcementEnabled: false, dualControlThresholdPaise: value }),
    });
  }

  async function tenant(label: string): Promise<TenantFixture> {
    const t = await createTenant(h.admin, label, credentials);
    tenants.push(t);
    return t;
  }

  async function signIn(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  async function platformUser(label: string, roleKey: string): Promise<string> {
    const email = `p76d1-${label}-${hex(5)}@example.test`;
    const [u] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    users.push(u!.id);
    const [role] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, roleKey), isNull(schema.roles.orgId)));
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId: u!.id,
        roleId: role!.id,
        scopeType: 'platform',
        scopeId: null,
      });
    });
    return signIn(email);
  }

  const post = (
    token: string,
    path: string,
    body: Record<string, unknown>,
    key: string | null = randomUUID(),
  ) => {
    const r = request(h.app.getHttpServer())
      .post(url(`/platform/billing${path}`))
      .set('Authorization', `Bearer ${token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const op = (
    t: TenantFixture,
    path: string,
    body: Record<string, unknown> = {},
    token = requester,
    key?: string | null,
  ) => post(token, `/organizations/${t.orgId}${path}`, { reason: 'operator action', ...body }, key);
  const limit = (
    t: TenantFixture,
    newLimitPaise: number,
    previousLimitPaise: number,
    token = requester,
  ) => op(t, '/credit-limit', { newLimitPaise, previousLimitPaise }, token);
  const approve = (token: string, id: string, amount?: number) =>
    post(
      token,
      `/account-operations/${id}/approve`,
      amount === undefined ? {} : { expectedAmountPaise: amount },
    );
  const reject = (token: string, id: string) =>
    post(token, `/account-operations/${id}/reject`, { reason: 'not justified' });
  const accounts = (t: TenantFixture, token = requester) =>
    request(h.app.getHttpServer())
      .get(url(`/platform/billing/organizations/${t.orgId}/accounts`))
      .set('Authorization', `Bearer ${token}`);

  async function rawAccount(t: TenantFixture, table: 'wallets' | 'credit_accounts') {
    const { rows } = await h.admin.execute<Record<string, string>>(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE org_id = ${t.orgId}`,
    );
    return rows[0];
  }

  async function audits(resourceId: string): Promise<string[]> {
    const { rows } = await h.admin.execute<{ action: string }>(
      sql`SELECT action FROM audit_logs WHERE resource_id = ${resourceId} ORDER BY occurred_at, id`,
    );
    return rows.map((r) => r.action);
  }

  async function ledgerFacts(t: TenantFixture): Promise<number> {
    const { rows } = await h.admin.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM usage_ledger WHERE org_id = ${t.orgId}`,
    );
    return Number(rows[0]!.n);
  }

  /** Funds a provisioned wallet directly (recharge is PR 7-6d-2). */
  async function fund(t: TenantFixture, balance: number) {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(
        sql`UPDATE wallets SET balance_paise = ${balance} WHERE org_id = ${t.orgId}`,
      );
    });
  }

  /** An enforced prepaid message of `t`, ready for a reservation through the ledger writer. */
  async function message(t: TenantFixture): Promise<string> {
    let contact = contacts.get(t.orgId);
    const id = uuidv7();
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      if (!contact) {
        contact = uuidv7();
        contacts.set(t.orgId, contact);
        await tx.execute(
          sql`INSERT INTO contacts (id, org_id, workspace_id) VALUES (${contact}, ${t.orgId}, ${t.workspaceId})`,
        );
      }
      await tx.execute(sql`
        INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address,
                              correlation_id, completed_at, billable_units, billable_unit, billing_enforced,
                              billing_mode_snapshot, billing_policy_snapshot)
        VALUES (${id}, ${t.orgId}, ${t.workspaceId}, ${contact}, ${channelId}, 'outcome_unknown',
                '+12025550144', 'p76d1', now(), 1, 'message', true, 'prepaid', 'charge_per_logical_message')`);
    });
    return id;
  }

  const reservation = (t: TenantFixture, m: string, amount: number) =>
    sql`SELECT * FROM app_ledger_post(${t.orgId}, 'reservation', ${m}, ${amount}, 'wallet', ${m}, NULL, 'p76d1', NULL)`;

  async function reserveCode(t: TenantFixture, m: string, amount: number): Promise<string> {
    try {
      await h.admin.execute(reservation(t, m, amount));
      return 'OK';
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      return e.code ?? e.cause?.code ?? 'ERR';
    }
  }

  /** A direct owner connection, for holding a transaction open across an API call. */
  async function ownerClient(): Promise<Client> {
    const c = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    await c.connect();
    return c;
  }

  // --- provisioning, reads, audit ---------------------------------------------------------------

  it('provisions an empty wallet and credit account (single operator, audited); reads show them; no ledger fact', async () => {
    const t = await tenant('p76d1-prov');
    expect((await accounts(t).expect(200)).body.data).toEqual({
      orgId: t.orgId,
      wallet: null,
      creditAccount: null,
    });
    const w = await op(t, '/wallet').expect(201);
    expect(w.body.data.operation).toMatchObject({
      orgId: t.orgId,
      account: 'wallet',
      kind: 'provision',
      status: 'executed',
      dualControl: false,
      thresholdPaise: null,
    });
    expect(w.body.data.account).toMatchObject({
      account: 'wallet',
      status: 'active',
      balancePaise: 0,
      reservedPaise: 0,
      availablePaise: 0,
    });
    expect(await audits(w.body.data.operation.id)).toEqual([
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REQUESTED,
      AUDIT_ACTIONS.BILLING_WALLET_PROVISIONED,
    ]);
    const c = await op(t, '/credit-account').expect(201);
    expect(c.body.data.account).toMatchObject({
      account: 'credit_account',
      creditLimitPaise: 0,
      usedPaise: 0,
      availablePaise: 0,
    });
    expect(await audits(c.body.data.operation.id)).toContain(
      AUDIT_ACTIONS.BILLING_CREDIT_ACCOUNT_PROVISIONED,
    );
    const both = (await accounts(t).expect(200)).body.data;
    expect(both.wallet).toMatchObject({ status: 'active' });
    expect(both.creditAccount).toMatchObject({ creditLimitPaise: 0 });
    const again = await op(t, '/wallet');
    expect([again.status, again.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_ACCOUNT_OPERATION_CONFLICT,
    ]);
    expect(await ledgerFacts(t)).toBe(0);
    expect((await accounts({ ...t, orgId: uuidv7() })).status).toBe(404);
  });

  // --- 10.3 dual control ------------------------------------------------------------------------

  it('threshold unset: an increase waits; a decrease and a freeze execute; an unfreeze waits; four eyes and binding hold', async () => {
    const t = await tenant('p76d1-dual');
    await op(t, '/credit-account').expect(201);
    const inc = (await limit(t, 5000, 0).expect(201)).body.data.operation;
    expect(inc).toMatchObject({
      status: 'pending',
      dualControl: true,
      amountPaise: 5000,
      previousLimitPaise: 0,
    });
    expect(Number((await rawAccount(t, 'credit_accounts'))!.credit_limit_paise)).toBe(0);
    for (const res of [await approve(requester, inc.id, 5000), await reject(requester, inc.id)]) {
      expect([res.status, res.body.error?.code]).toEqual([
        403,
        ERROR_CODES.BILLING_RESOLUTION_SELF_APPROVAL,
      ]);
    }
    const stale = await approve(approver, inc.id, 4999);
    expect([stale.status, stale.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_ACCOUNT_OPERATION_STALE,
    ]);
    const done = await approve(approver, inc.id, 5000).expect(200);
    expect(done.body.data.operation).toMatchObject({ status: 'executed', approvedBy: approverId });
    expect(done.body.data.account).toMatchObject({ creditLimitPaise: 5000, availablePaise: 5000 });
    expect(await audits(inc.id)).toEqual([
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REQUESTED,
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_APPROVED,
      AUDIT_ACTIONS.BILLING_CREDIT_LIMIT_CHANGED,
    ]);
    // A decrease executes on request.
    expect((await limit(t, 3000, 5000).expect(201)).body.data.operation).toMatchObject({
      status: 'executed',
      dualControl: false,
    });
    // Freeze executes; unfreeze always waits — even under a huge threshold.
    expect((await op(t, '/credit-account/freeze').expect(201)).body.data.operation.status).toBe(
      'executed',
    );
    threshold(1_000_000_000);
    const un = (await op(t, '/credit-account/unfreeze').expect(201)).body.data.operation;
    expect(un).toMatchObject({ status: 'pending', dualControl: true, amountPaise: null });
    // An unfreeze carries no amount: an approval naming one is stale.
    expect((await approve(approver, un.id, 0)).status).toBe(409);
    expect((await approve(approver, un.id).expect(200)).body.data.account.status).toBe('active');
  });

  it('reject: a different user closes the request; nothing changes; a new request may follow', async () => {
    const t = await tenant('p76d1-rej');
    await op(t, '/credit-account').expect(201);
    const inc = (await limit(t, 400, 0).expect(201)).body.data.operation;
    const res = await reject(approver, inc.id).expect(200);
    expect(res.body.data.operation).toMatchObject({
      status: 'rejected',
      rejectedBy: approverId,
      rejectionReason: 'not justified',
    });
    expect(Number((await rawAccount(t, 'credit_accounts'))!.credit_limit_paise)).toBe(0);
    expect(await audits(inc.id)).toEqual([
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REQUESTED,
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REJECTED,
    ]);
    expect((await approve(approver2, inc.id, 400)).status).toBe(409);
    await limit(t, 400, 0).expect(201);
  });

  it('threshold set: an increase within it executes, above it waits — measured on the increase, not the new limit', async () => {
    const t = await tenant('p76d1-thr');
    await op(t, '/credit-account').expect(201);
    threshold(10_000_000);
    await limit(t, 9_000_000, 0).expect(201);
    threshold(100);
    // Increase of exactly 100 to a limit far above the threshold: executes.
    expect((await limit(t, 9_000_100, 9_000_000).expect(201)).body.data.operation).toMatchObject({
      status: 'executed',
      dualControl: false,
      thresholdPaise: 100,
    });
    // Increase of 101: waits.
    expect((await limit(t, 9_000_201, 9_000_100).expect(201)).body.data.operation).toMatchObject({
      status: 'pending',
      dualControl: true,
      thresholdPaise: 100,
    });
  });

  it('the threshold comes from server configuration only: a request carrying one is refused (400)', async () => {
    const t = await tenant('p76d1-cfg');
    await op(t, '/credit-account').expect(201);
    const res = await post(requester, `/organizations/${t.orgId}/credit-limit`, {
      newLimitPaise: 100,
      previousLimitPaise: 0,
      reason: 'x',
      thresholdPaise: 1_000_000,
    });
    expect(res.status).toBe(400);
    expect(Number((await rawAccount(t, 'credit_accounts'))!.credit_limit_paise)).toBe(0);
  });

  // --- 10.4 frozen accounts -----------------------------------------------------------------------

  it('freeze: status only; new reservations refused; an in-flight reservation settles; credit limits change but never unfreeze; unfreeze restores spending', async () => {
    const t = await tenant('p76d1-frz');
    await op(t, '/wallet').expect(201);
    await op(t, '/credit-account').expect(201);
    await fund(t, 1000);
    const inflight = await message(t);
    await h.admin.execute(reservation(t, inflight, 100));
    const before = await rawAccount(t, 'wallets');

    const f = (await op(t, '/wallet/freeze').expect(201)).body.data;
    expect(f.account.status).toBe('frozen');
    const after = await rawAccount(t, 'wallets');
    expect({ ...after, status: undefined, version: undefined, updated_at: undefined }).toEqual({
      ...before,
      status: undefined,
      version: undefined,
      updated_at: undefined,
    });
    expect(await audits(f.operation.id)).toContain(AUDIT_ACTIONS.BILLING_ACCOUNT_FROZEN);

    // New spending is refused by the existing writer rule.
    expect(await reserveCode(t, await message(t), 50)).toBe('BL002');
    // The in-flight message settles against its existing reservation.
    await h.admin.execute(
      sql`SELECT * FROM app_ledger_post(${t.orgId}, 'customer_charge', ${inflight}, 60, 'wallet', ${inflight}, NULL, 'p76d1', NULL)`,
    );
    await h.admin.execute(
      sql`SELECT * FROM app_ledger_post(${t.orgId}, 'reservation_release', ${inflight}, NULL, 'wallet', ${inflight}, NULL, 'p76d1', NULL)`,
    );
    const settled = await rawAccount(t, 'wallets');
    expect([settled!.balance_paise, settled!.reserved_paise, settled!.status]).toEqual([
      '940',
      '0',
      'frozen',
    ]);
    // Freezing twice is a conflict.
    expect((await op(t, '/wallet/freeze')).status).toBe(409);

    // Credit-limit changes while the credit account is frozen: permitted, status kept.
    await op(t, '/credit-account/freeze').expect(201);
    threshold(1_000_000);
    expect((await limit(t, 700, 0).expect(201)).body.data.account).toMatchObject({
      creditLimitPaise: 700,
      status: 'frozen',
    });
    threshold(null);
    const up = (await limit(t, 900, 700).expect(201)).body.data.operation;
    expect((await approve(approver, up.id, 900).expect(200)).body.data.account).toMatchObject({
      creditLimitPaise: 900,
      status: 'frozen',
    });
    expect((await limit(t, 100, 900).expect(201)).body.data.account.status).toBe('frozen');

    // Unfreeze (dual) restores reservations.
    const un = (await op(t, '/wallet/unfreeze').expect(201)).body.data.operation;
    expect(await reserveCode(t, await message(t), 50)).toBe('BL002');
    await approve(approver, un.id).expect(200);
    expect(await reserveCode(t, await message(t), 50)).toBe('OK');
    expect(await audits(un.id)).toEqual([
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REQUESTED,
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_APPROVED,
      AUDIT_ACTIONS.BILLING_ACCOUNT_UNFROZEN,
    ]);
  });

  // --- 10.1 concurrency -------------------------------------------------------------------------

  it('concurrent provisioning: exactly one succeeds', async () => {
    const t = await tenant('p76d1-cprov');
    const results = await Promise.all([op(t, '/wallet'), op(t, '/wallet'), op(t, '/wallet')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const { rows } = await h.admin.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM wallets WHERE org_id = ${t.orgId}`,
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('concurrent approvals: exactly one executes; concurrent duplicate requests: one pending', async () => {
    const t = await tenant('p76d1-capr');
    await op(t, '/credit-account').expect(201);
    const dup = await Promise.all([limit(t, 500, 0), limit(t, 600, 0)]);
    expect(dup.map((r) => r.status).sort()).toEqual([201, 409]);
    const pending = dup.find((r) => r.status === 201)!.body.data.operation;
    const both = await Promise.all([
      approve(approver, pending.id, pending.amountPaise),
      approve(approver2, pending.id, pending.amountPaise),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(Number((await rawAccount(t, 'credit_accounts'))!.credit_limit_paise)).toBe(
      pending.amountPaise,
    );
  });

  it('limit changes are serialised: while an increase awaits approval no other change is accepted; a request naming a stale limit is refused', async () => {
    // One pending operation per (organization, account, kind) means two limit changes can
    // never race: the handover's increase-against-decrease race resolves to a conflict.
    const t = await tenant('p76d1-race');
    await op(t, '/credit-account').expect(201);
    threshold(1_000_000);
    await limit(t, 1000, 0).expect(201);
    threshold(null);
    const inc = (await limit(t, 2000, 1000).expect(201)).body.data.operation; // pending (dual)
    const blocked = await limit(t, 800, 1000);
    expect([blocked.status, blocked.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_ACCOUNT_OPERATION_CONFLICT,
    ]);
    await reject(approver, inc.id).expect(200);
    // The requester's view of the limit is bound: a stale one is refused at request time.
    const stale = await limit(t, 800, 999);
    expect([stale.status, stale.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_ACCOUNT_OPERATION_STALE,
    ]);
    await limit(t, 800, 1000).expect(201);
    expect(Number((await rawAccount(t, 'credit_accounts'))!.credit_limit_paise)).toBe(800);
  });

  it('freeze against an in-flight reservation: the committed reservation persists; after the freeze, none succeeds', async () => {
    const t = await tenant('p76d1-cfrz');
    await op(t, '/wallet').expect(201);
    await fund(t, 1000);
    const m = await message(t);
    const holder = await ownerClient();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT * FROM app_ledger_post($1, 'reservation', $2, 200, 'wallet', $2, NULL, 'p76d1', NULL)`,
        [t.orgId, m],
      );
      // The freeze waits for the wallet lock the reservation holds.
      const freezing = op(t, '/wallet/freeze').then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      await holder.query('COMMIT');
      expect((await freezing).status).toBe(201);
    } finally {
      await holder.end();
    }
    const w = await rawAccount(t, 'wallets');
    expect([w!.reserved_paise, w!.status]).toEqual(['200', 'frozen']);
    const attempts = await Promise.all(
      [1, 2, 3].map(async () => reserveCode(t, await message(t), 10)),
    );
    expect(attempts).toEqual(['BL002', 'BL002', 'BL002']);
  });

  // --- 10.2 idempotency -------------------------------------------------------------------------

  it('idempotency: replay returns the original and executes nothing; a changed request is 422; no key is 400; a key is unique per organisation', async () => {
    const t = await tenant('p76d1-idem');
    const key = randomUUID();
    const first = await op(t, '/wallet', {}, requester, key).expect(201);
    const replay = await op(t, '/wallet', {}, requester, key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect((await op(t, '/wallet', { reason: 'different' }, requester, key)).status).toBe(422);
    const none = await op(t, '/credit-account', {}, requester, null);
    expect([none.status, none.body.error?.code]).toEqual([
      400,
      ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    ]);
    expect(await rawAccount(t, 'credit_accounts')).toBeUndefined();
    // RQ-3: the same key on another operation of the same organisation is refused.
    const reused = await op(t, '/credit-account', {}, requester, key);
    expect([reused.status, reused.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_ACCOUNT_OPERATION_CONFLICT,
    ]);
    const { rows } = await h.admin.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM billing_account_operations WHERE org_id = ${t.orgId}`,
    );
    expect(rows[0]!.n).toBe('1');
  });

  // --- reads ------------------------------------------------------------------------------------

  it('lists operations newest first with filters and a cursor, and reads one', async () => {
    const t = await tenant('p76d1-list');
    await op(t, '/wallet').expect(201);
    await op(t, '/credit-account').expect(201);
    await op(t, '/wallet/freeze').expect(201);
    await op(t, '/wallet/unfreeze').expect(201);
    const all = await request(h.app.getHttpServer())
      .get(url(`/platform/billing/account-operations?orgId=${t.orgId}&limit=100`))
      .set('Authorization', `Bearer ${requester}`)
      .expect(200);
    const ids = (all.body.data as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toHaveLength(4);
    expect([...ids].sort().reverse()).toEqual(ids);
    const pending = await request(h.app.getHttpServer())
      .get(
        url(
          `/platform/billing/account-operations?orgId=${t.orgId}&status=pending&kind=unfreeze&account=wallet`,
        ),
      )
      .set('Authorization', `Bearer ${requester}`)
      .expect(200);
    expect(pending.body.data).toHaveLength(1);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const res = await request(h.app.getHttpServer())
        .get(
          url(
            `/platform/billing/account-operations?orgId=${t.orgId}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          ),
        )
        .set('Authorization', `Bearer ${requester}`)
        .expect(200);
      seen.push(...(res.body.data as Array<{ id: string }>).map((x) => x.id));
      cursor = res.body.page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(ids);
    await request(h.app.getHttpServer())
      .get(url(`/platform/billing/account-operations/${ids[0]}`))
      .set('Authorization', `Bearer ${requester}`)
      .expect(200);
    await request(h.app.getHttpServer())
      .get(url(`/platform/billing/account-operations/${uuidv7()}`))
      .set('Authorization', `Bearer ${requester}`)
      .expect(404);
  });

  // --- 10.5 tenant isolation and access ---------------------------------------------------------

  it('access: platform support, tenant administrators and API keys are refused everywhere; no credential is 401', async () => {
    const t = await tenant('p76d1-acc');
    await op(t, '/wallet').expect(201);
    const tenantAdmin = await signIn(t.email);
    for (const [token, org] of [
      [support, undefined],
      [tenantAdmin, undefined],
      [tenantAdmin, t.orgId],
      [apiKey, keyTenant.orgId],
    ] as const) {
      const with$ = (r: request.Test) => (org ? r.set('X-Acc-Organization', org) : r);
      expect(
        (
          await with$(
            request(h.app.getHttpServer())
              .post(url(`/platform/billing/organizations/${t.orgId}/wallet/freeze`))
              .set('Authorization', `Bearer ${token}`)
              .set('Idempotency-Key', randomUUID()),
          ).send({ reason: 'x' })
        ).status,
      ).toBe(403);
      expect(
        (
          await with$(
            request(h.app.getHttpServer())
              .get(url(`/platform/billing/organizations/${t.orgId}/accounts`))
              .set('Authorization', `Bearer ${token}`),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await with$(
            request(h.app.getHttpServer())
              .get(url('/platform/billing/account-operations'))
              .set('Authorization', `Bearer ${token}`),
          )
        ).status,
      ).toBe(403);
    }
    expect((await rawAccount(t, 'wallets'))!.status).toBe('active');
    await request(h.app.getHttpServer())
      .post(url(`/platform/billing/organizations/${t.orgId}/wallet/freeze`))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'x' })
      .expect(401);
  });

  it('tenant isolation: a tenant reads only its own account (status visible), never operations or another tenant; nothing reaches its ledger', async () => {
    const a = await tenant('p76d1-ta');
    const b = await tenant('p76d1-tb');
    await op(a, '/wallet').expect(201);
    await op(b, '/wallet').expect(201);
    await op(b, '/wallet/freeze').expect(201);
    // As 7-6a: the tenant's organization-admin system role carries billing.read, as the
    // production org_admin does (granted as provisioning does).
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`UPDATE roles SET allowed_scope_types = '{organization}' WHERE id = ${a.roleId}`,
      );
      await tx.execute(sql`
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT ${a.roleId}, p.id FROM permissions p WHERE p.key = ${PERMISSIONS.BILLING_READ}`);
    });
    const tokenA = await signIn(a.email);
    const own = await request(h.app.getHttpServer())
      .get(url('/billing/account'))
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Acc-Organization', a.orgId)
      .expect(200);
    expect(own.body.data).toMatchObject({ status: 'active', balancePaise: 0 });
    expect(JSON.stringify(own.body)).not.toContain(b.orgId);
    // Selecting the other organization is refused.
    const cross = await request(h.app.getHttpServer())
      .get(url('/billing/account'))
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Acc-Organization', b.orgId);
    expect([403, 404]).toContain(cross.status);
    const ledger = await request(h.app.getHttpServer())
      .get(url('/billing/ledger'))
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Acc-Organization', a.orgId)
      .expect(200);
    expect(ledger.body.data).toEqual([]);
    expect(await ledgerFacts(a)).toBe(0);
    expect(await ledgerFacts(b)).toBe(0);
  });

  it('counts operations by action and outcome after commit', async () => {
    const counter = await metrics.billingAccountOperations.get();
    const value = (action: string, outcome: string) =>
      counter.values.find((v) => v.labels.action === action && v.labels.outcome === outcome)
        ?.value ?? 0;
    expect(value('provision', 'executed')).toBeGreaterThanOrEqual(10);
    expect(value('credit_limit_change', 'pending')).toBeGreaterThanOrEqual(3);
    expect(value('credit_limit_change', 'executed')).toBeGreaterThanOrEqual(5);
    expect(value('freeze', 'executed')).toBeGreaterThanOrEqual(4);
    expect(value('unfreeze', 'pending')).toBeGreaterThanOrEqual(2);
    expect(value('unfreeze', 'executed')).toBeGreaterThanOrEqual(2);
    expect(value('credit_limit_change', 'rejected')).toBeGreaterThanOrEqual(1);
  });
});
