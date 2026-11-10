import { randomBytes, randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS, ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AuditWriter } from '../src/audit/audit-writer.service';
import { AccountOperationsService } from '../src/billing/account-operations.service';
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
 * Phase 7 PR 7-6d-2 — wallet recharge and ledger integration (`DECISIONS.md` §1zi.13
 * D-76d-1 to D-76d-5; handover Rev 2 §10).
 *
 *   - One immutable ledger fact per executed recharge, anchored on the operation: the
 *     balance rises, reserved is unchanged; pending, rejected and refused recharges post
 *     nothing.
 *   - Dual control (threshold unset or exceeded), four eyes, approval bound to the exact
 *     amount and evidence snapshot.
 *   - Payment references unique per organization after normalisation, also under
 *     concurrency; idempotency; frozen wallets (request refused; approval refused and
 *     recorded, audited); ledger/balance consistency; tenant visibility of amount and time
 *     only; provider-cost confidentiality; access.
 */

const url = (p: string) => `/${PREFIX}${p}`;

describe('Phase 7-6d-2: wallet recharge', () => {
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
    keyTenant = await tenant('p76d2-key');
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
      name: `p76d2-${hex(3)}`,
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
          'message_attempts',
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
    const email = `p76d2-${label}-${hex(5)}@example.test`;
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
  const approve = (token: string, id: string, amount?: number) =>
    post(
      token,
      `/account-operations/${id}/approve`,
      amount === undefined ? {} : { expectedAmountPaise: amount },
    );
  const reject = (token: string, id: string) =>
    post(token, `/account-operations/${id}/reject`, { reason: 'not justified' });

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
                '+12025550144', 'p76d2', now(), 1, 'message', true, 'prepaid', 'charge_per_logical_message')`);
    });
    return id;
  }

  const reservation = (t: TenantFixture, m: string, amount: number) =>
    sql`SELECT * FROM app_ledger_post(${t.orgId}, 'reservation', ${m}, ${amount}, 'wallet', ${m}, NULL, 'p76d2', NULL)`;

  // --- recharge helpers ---------------------------------------------------------------------

  const today = () => new Date().toISOString().slice(0, 10);
  let refSeq = 0;
  const ref = () => `UTR${Date.now().toString(36).toUpperCase()}${(refSeq += 1)}`;

  const recharge = (
    t: TenantFixture,
    amountPaise: number,
    paymentReference = ref(),
    o: { token?: string; key?: string | null; receivedOn?: string; reason?: string } = {},
  ) =>
    post(
      o.token ?? requester,
      `/organizations/${t.orgId}/recharges`,
      {
        amountPaise,
        paymentReference,
        receivedOn: o.receivedOn ?? today(),
        reason: o.reason ?? 'payment received',
      },
      o.key === undefined ? randomUUID() : o.key,
    );

  const approveRecharge = (
    token: string,
    op: { id: string; amountPaise: number; paymentReference: string; receivedOn: string },
    override: Record<string, unknown> = {},
    key = randomUUID(),
  ) =>
    post(
      token,
      `/account-operations/${op.id}/approve`,
      {
        expectedAmountPaise: op.amountPaise,
        expectedPaymentReference: op.paymentReference,
        expectedReceivedOn: op.receivedOn,
        ...override,
      },
      key,
    );

  async function walletOf(t: TenantFixture) {
    const w = await rawAccount(t, 'wallets');
    return {
      balance: Number(w!.balance_paise),
      reserved: Number(w!.reserved_paise),
      status: w!.status,
    };
  }

  async function rechargeFacts(t: TenantFixture): Promise<number[]> {
    const { rows } = await h.admin.execute<{ amount_paise: string }>(
      sql`SELECT amount_paise FROM usage_ledger WHERE org_id = ${t.orgId} AND entry_type = 'recharge' ORDER BY occurred_at, id`,
    );
    return rows.map((r) => Number(r.amount_paise));
  }

  /** A tenant with a provisioned wallet. */
  async function walletTenant(label: string): Promise<TenantFixture> {
    const t = await tenant(label);
    await op(t, '/wallet').expect(201);
    return t;
  }

  // --- execution, ledger, reserved ----------------------------------------------------------------

  it('within the threshold a recharge executes at once: one ledger fact anchored on the operation, balance up, reserved unchanged, audited', async () => {
    const t = await walletTenant('p76d2-exec');
    await fund(t, 0);
    const m = await message(t);
    threshold(1_000_000);
    // A reservation already held must stay exactly as it is.
    await h.admin
      .execute(sql`UPDATE wallets SET balance_paise = 300 WHERE org_id = ${t.orgId}`)
      .catch(() => undefined);
    await fund(t, 300);
    await h.admin.execute(reservation(t, m, 120));
    const before = await walletOf(t);
    const reference = ref();
    const res = await recharge(t, 5000, reference).expect(201);
    const operation = res.body.data.operation;
    expect(operation).toMatchObject({
      kind: 'recharge',
      account: 'wallet',
      status: 'executed',
      amountPaise: 5000,
      paymentReference: reference,
      receivedOn: today(),
      dualControl: false,
      thresholdPaise: 1_000_000,
      lastRefusal: null,
    });
    expect(operation.resultLedgerId).toEqual(expect.any(String));
    expect(res.body.data.account).toMatchObject({
      balancePaise: before.balance + 5000,
      reservedPaise: before.reserved,
    });
    expect(await walletOf(t)).toEqual({ ...before, balance: before.balance + 5000 });
    const { rows } = await h.admin.execute<Record<string, unknown>>(
      sql`SELECT id, anchor_id, entry_type, amount_paise, message_id, correlation_id, reference_note
            FROM usage_ledger WHERE org_id = ${t.orgId} AND entry_type = 'recharge'`,
    );
    expect(rows).toEqual([
      {
        id: operation.resultLedgerId,
        anchor_id: operation.id,
        entry_type: 'recharge',
        amount_paise: '5000',
        message_id: null,
        correlation_id: null,
        reference_note: null,
      },
    ]);
    expect(await audits(operation.id)).toEqual([
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REQUESTED,
      AUDIT_ACTIONS.BILLING_WALLET_RECHARGED,
    ]);
  });

  // --- dual control and binding ----------------------------------------------------------------

  it('threshold unset or exceeded: the recharge waits; nothing is credited until a different user approves the exact amount and evidence', async () => {
    const t = await walletTenant('p76d2-dual');
    const reference = 'utr 9876 xy';
    const pending = (await recharge(t, 2500, reference).expect(201)).body.data.operation;
    expect(pending).toMatchObject({ status: 'pending', dualControl: true, thresholdPaise: null });
    expect(await rechargeFacts(t)).toEqual([]);
    expect((await walletOf(t)).balance).toBe(0);

    for (const res of [
      await approveRecharge(requester, pending),
      await reject(requester, pending.id),
    ]) {
      expect([res.status, res.body.error?.code]).toEqual([
        403,
        ERROR_CODES.BILLING_RESOLUTION_SELF_APPROVAL,
      ]);
    }
    // Every element of the snapshot is bound.
    for (const override of [
      { expectedAmountPaise: 2499 },
      { expectedPaymentReference: 'UTR9876XZ' },
      { expectedReceivedOn: '2020-01-01' },
    ]) {
      const stale = await approveRecharge(approver, pending, override);
      expect([stale.status, stale.body.error?.code]).toEqual([
        409,
        ERROR_CODES.BILLING_ACCOUNT_OPERATION_STALE,
      ]);
    }
    // Without the evidence, a recharge approval is refused outright.
    expect(
      (
        await post(approver, `/account-operations/${pending.id}/approve`, {
          expectedAmountPaise: 2500,
        })
      ).status,
    ).toBe(400);
    expect(await rechargeFacts(t)).toEqual([]);

    // The evidence is compared normalised (whitespace removed, upper case).
    const done = await approveRecharge(approver, pending, {
      expectedPaymentReference: 'UTR9876XY',
    }).expect(200);
    expect(done.body.data.operation).toMatchObject({ status: 'executed', approvedBy: approverId });
    expect(done.body.data.account).toMatchObject({ balancePaise: 2500, reservedPaise: 0 });
    expect(await rechargeFacts(t)).toEqual([2500]);
    expect(await audits(pending.id)).toEqual([
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REQUESTED,
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_APPROVED,
      AUDIT_ACTIONS.BILLING_WALLET_RECHARGED,
    ]);
    // Executed is final.
    expect((await approveRecharge(approver2, pending)).status).toBe(409);

    threshold(1000);
    expect((await recharge(t, 1001).expect(201)).body.data.operation).toMatchObject({
      status: 'pending',
      dualControl: true,
      thresholdPaise: 1000,
    });
  });

  it('a rejected recharge posts nothing and frees its payment reference', async () => {
    const t = await walletTenant('p76d2-rej');
    const reference = ref();
    const pending = (await recharge(t, 700, reference).expect(201)).body.data.operation;
    const res = await reject(approver, pending.id).expect(200);
    expect(res.body.data.operation).toMatchObject({ status: 'rejected', rejectedBy: approverId });
    expect(await rechargeFacts(t)).toEqual([]);
    expect((await walletOf(t)).balance).toBe(0);
    expect(await audits(pending.id)).toEqual([
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REQUESTED,
      AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REJECTED,
    ]);
    await recharge(t, 700, reference).expect(201);
  });

  // --- payment reference uniqueness ----------------------------------------------------------

  it('a payment reference credits at most once per organization, normalised; another organization may use it', async () => {
    const t = await walletTenant('p76d2-ref');
    const u = await walletTenant('p76d2-ref2');
    threshold(1_000_000);
    await recharge(t, 100, 'ab-12 34').expect(201);
    for (const variant of ['AB-1234', 'ab-12  34', 'Ab-12 34']) {
      const dup = await recharge(t, 100, variant);
      expect([dup.status, dup.body.error?.code]).toEqual([
        409,
        ERROR_CODES.BILLING_ACCOUNT_OPERATION_CONFLICT,
      ]);
    }
    await recharge(u, 100, 'AB-1234').expect(201);
    expect(await rechargeFacts(t)).toEqual([100]);
    // Malformed references (including leading whitespace) never reach the database.
    expect((await recharge(t, 100, 'bad;ref')).status).toBe(400);
    expect((await recharge(t, 100, ' AB-1234')).status).toBe(400);
    expect((await recharge(t, 100, '')).status).toBe(400);
  });

  it('concurrent recharges with one payment reference (different keys): exactly one credits', async () => {
    const t = await walletTenant('p76d2-cref');
    threshold(1_000_000);
    const results = await Promise.all([
      recharge(t, 300, 'SAME REF 1'),
      recharge(t, 300, 'same ref 1'),
      recharge(t, 300, 'SAMEREF1'),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    expect(statuses.slice(1)).toEqual([409, 409]);
    expect(await rechargeFacts(t)).toEqual([300]);
    expect((await walletOf(t)).balance).toBe(300);
  });

  // --- idempotency and concurrency --------------------------------------------------------------

  it('idempotency: a replay credits nothing more; a changed request is 422; no key is 400', async () => {
    const t = await walletTenant('p76d2-idem');
    threshold(1_000_000);
    const key = randomUUID();
    const reference = ref();
    const first = await recharge(t, 400, reference, { key }).expect(201);
    const replay = await recharge(t, 400, reference, { key }).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(await rechargeFacts(t)).toEqual([400]);
    expect((await recharge(t, 401, reference, { key })).status).toBe(422);
    const none = await recharge(t, 400, ref(), { key: null });
    expect([none.status, none.body.error?.code]).toEqual([
      400,
      ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    ]);
    expect((await walletOf(t)).balance).toBe(400);
  });

  it('two approvers at once: one approval executes, one fact is posted', async () => {
    const t = await walletTenant('p76d2-capr');
    const pending = (await recharge(t, 900).expect(201)).body.data.operation;
    const both = await Promise.all([
      approveRecharge(approver, pending),
      approveRecharge(approver2, pending),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await rechargeFacts(t)).toEqual([900]);
    expect((await walletOf(t)).balance).toBe(900);
  });

  // --- frozen wallets --------------------------------------------------------------------------

  it('frozen wallet: a request is refused and records nothing; an approval is refused, recorded and audited, and the same key succeeds after unfreeze', async () => {
    const t = await walletTenant('p76d2-frz');
    const pending = (await recharge(t, 600).expect(201)).body.data.operation;
    await op(t, '/wallet/freeze').expect(201);
    const before = await walletOf(t);
    const refused = await recharge(t, 100);
    expect([refused.status, refused.body.error?.code]).toEqual([
      403,
      ERROR_CODES.BILLING_ACCOUNT_FROZEN,
    ]);
    const key = randomUUID();
    const blocked = await approveRecharge(approver, pending, {}, key);
    expect([blocked.status, blocked.body.error?.code]).toEqual([
      403,
      ERROR_CODES.BILLING_ACCOUNT_FROZEN,
    ]);
    expect(blocked.body.error.details).toEqual({
      refusal: 'account_frozen',
      refusalRecorded: 'operation_and_audit',
    });
    const kept = (
      await request(h.app.getHttpServer())
        .get(url(`/platform/billing/account-operations/${pending.id}`))
        .set('Authorization', `Bearer ${requester}`)
        .expect(200)
    ).body.data;
    expect(kept).toMatchObject({
      status: 'pending',
      approvedBy: null,
      lastRefusal: 'account_frozen',
    });
    expect(kept.lastRefusedAt).toEqual(expect.any(String));
    expect(await audits(pending.id)).toContain(AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REFUSED);
    expect(await rechargeFacts(t)).toEqual([]);
    expect(await walletOf(t)).toEqual(before);
    const { rows } = await h.admin.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM billing_account_operations WHERE org_id = ${t.orgId} AND kind = 'recharge'`,
    );
    expect(rows[0]!.n).toBe('1'); // the refused request recorded nothing

    const un = (await op(t, '/wallet/unfreeze').expect(201)).body.data.operation;
    await approve(approver, un.id).expect(200);
    await approveRecharge(approver, pending, {}, key).expect(200);
    expect(await rechargeFacts(t)).toEqual([600]);
  });

  // --- PR #101 review: refusal recording is durable, raced safely and never silent -------------

  /** The refused-approval audit rows of an operation, with the metadata that matters here. */
  async function refusalAudits(id: string) {
    const { rows } = await h.admin.execute<{ outcome: string; metadata: Record<string, unknown> }>(
      sql`SELECT outcome, metadata FROM audit_logs WHERE resource_id = ${id} AND action = ${AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REFUSED} ORDER BY occurred_at, id`,
    );
    return rows;
  }

  async function operationRow(id: string) {
    const { rows } = await h.admin.execute<Record<string, unknown>>(
      sql`SELECT status, last_refusal, approved_by FROM billing_account_operations WHERE id = ${id}`,
    );
    return rows[0]!;
  }

  /** A pending recharge on a wallet that is then frozen. */
  async function frozenPending(label: string) {
    const t = await walletTenant(label);
    const pending = (await recharge(t, 450).expect(201)).body.data.operation;
    await op(t, '/wallet/freeze').expect(201);
    return { t, pending };
  }

  const setWalletStatus = (t: TenantFixture, status: 'active' | 'frozen') =>
    h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(
        sql`UPDATE wallets SET status = ${status}::billing_account_status WHERE org_id = ${t.orgId}`,
      );
    });

  it('race: the wallet is unfrozen between the refused approval and the refusal record — the refusal is still audited (audit only), the operation stays pending and approvable', async () => {
    const { t, pending } = await frozenPending('p76d2-race');
    const service = h.app.get(AccountOperationsService) as unknown as {
      recordRefusal: (...args: unknown[]) => Promise<unknown>;
    };
    // Capture the original before spying (a spy-bound original would recurse).
    const original = service.recordRefusal.bind(service);
    const spy = jest.spyOn(service, 'recordRefusal').mockImplementation(async (...args) => {
      await setWalletStatus(t, 'active'); // the unfreeze lands in between
      return original(...args);
    });
    try {
      const res = await approveRecharge(approver, pending);
      expect([res.status, res.body.error?.code, res.body.error?.details]).toEqual([
        403,
        ERROR_CODES.BILLING_ACCOUNT_FROZEN,
        { refusal: 'account_frozen', refusalRecorded: 'audit_only' },
      ]);
    } finally {
      spy.mockRestore();
    }
    // The database declined to record a state it can no longer confirm …
    expect(await operationRow(pending.id)).toMatchObject({
      status: 'pending',
      last_refusal: null,
      approved_by: null,
    });
    // … but the observed refusal is durably audited, marked as such.
    expect(await refusalAudits(pending.id)).toEqual([
      {
        outcome: 'failure',
        metadata: expect.objectContaining({
          refusal: 'account_frozen',
          recordedOnOperation: false,
          stateChangedBeforeRecording: true,
        }),
      },
    ]);
    expect(await rechargeFacts(t)).toEqual([]);
    // Nothing was lost or double-applied: the recharge can now be approved.
    await approveRecharge(approver, pending).expect(200);
    expect(await rechargeFacts(t)).toEqual([450]);
  });

  it('a recording failure is never silent: reported to the caller as failed, logged, counted; nothing half-recorded', async () => {
    const { t, pending } = await frozenPending('p76d2-fail');
    const audit = h.app.get(AuditWriter);
    const original = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (input, tx) => {
      if (input.action === AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REFUSED) {
        throw new Error('simulated audit store failure');
      }
      return original(input, tx);
    });
    const service = h.app.get(AccountOperationsService) as unknown as {
      logger: { error: (...args: unknown[]) => void };
    };
    const logged = jest.spyOn(service.logger, 'error');
    const failures = async () =>
      (await metrics.billingAccountRefusalRecordFailures.get()).values.reduce(
        (n, v) => n + v.value,
        0,
      );
    const before = await failures();
    try {
      const res = await approveRecharge(approver, pending);
      expect([res.status, res.body.error?.code, res.body.error?.details]).toEqual([
        403,
        ERROR_CODES.BILLING_ACCOUNT_FROZEN,
        { refusal: 'account_frozen', refusalRecorded: 'failed' },
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(await failures()).toBe(before + 1);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'billing account operation: an approval refusal could not be recorded',
        operationId: pending.id,
        refusal: 'account_frozen',
      }),
    );
    logged.mockRestore();
    // The recording transaction rolled back as a whole: no refusal on the row, no audit row.
    expect(await operationRow(pending.id)).toMatchObject({ status: 'pending', last_refusal: null });
    expect(await refusalAudits(pending.id)).toEqual([]);
    expect(await rechargeFacts(t)).toEqual([]);
    // A later refused approval records normally.
    const again = await approveRecharge(approver, pending);
    expect(again.body.error?.details).toEqual({
      refusal: 'account_frozen',
      refusalRecorded: 'operation_and_audit',
    });
    expect(await operationRow(pending.id)).toMatchObject({ last_refusal: 'account_frozen' });
  });

  it('a transient failure while recording is retried, and the refusal is then recorded in full', async () => {
    const { pending } = await frozenPending('p76d2-retry');
    const audit = h.app.get(AuditWriter);
    const original = audit.record.bind(audit);
    let failed = 0;
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (input, tx) => {
      if (input.action === AUDIT_ACTIONS.BILLING_ACCOUNT_OPERATION_REFUSED && failed < 2) {
        failed += 1;
        throw Object.assign(new Error('could not serialize access'), { code: '40001' });
      }
      return original(input, tx);
    });
    try {
      const res = await approveRecharge(approver, pending);
      expect(res.body.error?.details).toEqual({
        refusal: 'account_frozen',
        refusalRecorded: 'operation_and_audit',
      });
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(2);
    expect(await operationRow(pending.id)).toMatchObject({ last_refusal: 'account_frozen' });
    expect(await refusalAudits(pending.id)).toHaveLength(1);
  });

  // --- PR #101 review: strict calendar dates -------------------------------------------------------

  it('impossible calendar dates are refused with 400 (never a database conversion error); leap-day and historical dates are accepted', async () => {
    const t = await walletTenant('p76d2-dates');
    threshold(1_000_000);
    for (const receivedOn of [
      '2026-02-30',
      '2025-02-29',
      '1900-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
    ]) {
      const res = await recharge(t, 100, ref(), { receivedOn });
      expect([receivedOn, res.status, res.body.error?.code]).toEqual([
        receivedOn,
        400,
        ERROR_CODES.VALIDATION_FAILED,
      ]);
    }
    for (const receivedOn of ['2024-02-29', '2000-02-29', '1999-12-31']) {
      const res = await recharge(t, 100, ref(), { receivedOn });
      expect([receivedOn, res.status, res.body.data?.operation?.receivedOn]).toEqual([
        receivedOn,
        201,
        receivedOn,
      ]);
    }
    expect(await ledgerFacts(t)).toBe(3);
    // The approval's expectedReceivedOn is validated the same way (400, not 409 or 500).
    threshold(null);
    const pending = (await recharge(t, 100, ref(), { receivedOn: '2024-02-29' }).expect(201)).body
      .data.operation;
    for (const expectedReceivedOn of ['2024-02-30', '2023-02-29']) {
      const res = await approveRecharge(approver, pending, { expectedReceivedOn });
      expect([expectedReceivedOn, res.status, res.body.error?.code]).toEqual([
        expectedReceivedOn,
        400,
        ERROR_CODES.VALIDATION_FAILED,
      ]);
    }
    await approveRecharge(approver, pending).expect(200);
  });

  // --- PR #101 final review: explicit null evidence is refused; omission stays valid ------------

  it('approval evidence: omitted fields stay valid for non-recharge approvals; explicit null for either field is 400; valid recharge evidence still works; impossible dates stay 400', async () => {
    const t = await walletTenant('p76d2-null');
    await op(t, '/credit-account').expect(201);

    // Non-recharge flows with the evidence fields omitted: unchanged.
    await op(t, '/wallet/freeze').expect(201);
    const un = (await op(t, '/wallet/unfreeze').expect(201)).body.data.operation;
    // …but an explicit null is refused even here.
    for (const body of [{ expectedReceivedOn: null }, { expectedPaymentReference: null }]) {
      const res = await post(approver, `/account-operations/${un.id}/approve`, body);
      expect([JSON.stringify(body), res.status, res.body.error?.code]).toEqual([
        JSON.stringify(body),
        400,
        ERROR_CODES.VALIDATION_FAILED,
      ]);
    }
    await post(approver, `/account-operations/${un.id}/approve`, {}).expect(200);
    const inc = (
      await op(t, '/credit-limit', { newLimitPaise: 300, previousLimitPaise: 0 }).expect(201)
    ).body.data.operation;
    await post(approver, `/account-operations/${inc.id}/approve`, {
      expectedAmountPaise: 300,
    }).expect(200);

    // A recharge approval: explicit null for either evidence field is 400 and changes nothing.
    const pending = (await recharge(t, 640, ref(), { receivedOn: '2024-02-29' }).expect(201)).body
      .data.operation;
    for (const override of [
      { expectedPaymentReference: null },
      { expectedReceivedOn: null },
      { expectedPaymentReference: null, expectedReceivedOn: null },
    ]) {
      const res = await approveRecharge(approver, pending, override);
      expect([JSON.stringify(override), res.status, res.body.error?.code]).toEqual([
        JSON.stringify(override),
        400,
        ERROR_CODES.VALIDATION_FAILED,
      ]);
    }
    // Impossible calendar dates remain 400.
    const impossible = await approveRecharge(approver, pending, {
      expectedReceivedOn: '2023-02-29',
    });
    expect([impossible.status, impossible.body.error?.code]).toEqual([
      400,
      ERROR_CODES.VALIDATION_FAILED,
    ]);
    expect(await rechargeFacts(t)).toEqual([]);
    // Valid evidence still approves.
    await approveRecharge(approver, pending).expect(200);
    expect(await rechargeFacts(t)).toEqual([640]);
  });

  it('no wallet (only a credit account): a recharge is refused; credit accounts are never recharged', async () => {
    const t = await tenant('p76d2-nowal');
    await op(t, '/credit-account').expect(201);
    const res = await recharge(t, 100);
    expect([res.status, res.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_ACCOUNT_OPERATION_CONFLICT,
    ]);
    expect(await ledgerFacts(t)).toBe(0);
  });

  // --- ledger / balance consistency -------------------------------------------------------------

  it('ledger truth: after recharges, reservations, charges and releases the wallet equals its ledger', async () => {
    const t = await walletTenant('p76d2-truth');
    threshold(1_000_000);
    await recharge(t, 1000).expect(201);
    await recharge(t, 250).expect(201);
    const m1 = await message(t);
    const m2 = await message(t);
    await h.admin.execute(reservation(t, m1, 300));
    await h.admin.execute(reservation(t, m2, 200));
    await h.admin.execute(
      sql`SELECT * FROM app_ledger_post(${t.orgId}, 'customer_charge', ${m1}, 180, 'wallet', ${m1}, NULL, 'p76d2', NULL)`,
    );
    await h.admin.execute(
      sql`SELECT * FROM app_ledger_post(${t.orgId}, 'reservation_release', ${m1}, NULL, 'wallet', ${m1}, NULL, 'p76d2', NULL)`,
    );
    await recharge(t, 75).expect(201);
    const { rows } = await h.admin.execute<Record<string, string>>(sql`
      SELECT COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'recharge'), 0)::text AS recharged,
             COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'customer_charge'), 0)::text AS charged,
             COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'reservation'), 0)::text AS reserved,
             COALESCE(sum(amount_paise) FILTER (WHERE entry_type = 'reservation_release'), 0)::text AS released
        FROM usage_ledger WHERE org_id = ${t.orgId}`);
    const l = rows[0]!;
    const w = await walletOf(t);
    expect(w.balance).toBe(Number(l.recharged) - Number(l.charged));
    expect(w.reserved).toBe(Number(l.reserved) - Number(l.released) - Number(l.charged));
    expect([w.balance, w.reserved]).toEqual([1325 - 180, 200]);
    // Every recharge fact has exactly one executed operation, and vice versa.
    const pairs = await h.admin.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM billing_account_operations o
        JOIN usage_ledger l ON l.anchor_month = app_uuidv7_month(o.id) AND l.anchor_id = o.id AND l.fact_kind = 'recharge'
       WHERE o.org_id = ${t.orgId} AND o.kind = 'recharge' AND o.status = 'executed' AND o.result_ledger_id = l.id`);
    expect(pairs.rows[0]!.n).toBe('3');
    expect(await rechargeFacts(t)).toHaveLength(3);
  });

  // --- tenant visibility and confidentiality ---------------------------------------------------

  it('tenants see their recharges as amount and time only; never payment references, approvers, reasons, operations, provider cost or another tenant', async () => {
    const a = await walletTenant('p76d2-ta');
    const b = await walletTenant('p76d2-tb');
    const secretRef = 'CONFIDENTIAL-UTR-777';
    const pending = (
      await recharge(a, 1234, secretRef, { reason: 'internal note xyz' }).expect(201)
    ).body.data.operation;
    await approveRecharge(approver, pending).expect(200);
    threshold(1_000_000);
    await recharge(b, 999).expect(201);
    // A provider cost on one of a's messages: never visible to a tenant.
    const m = await message(a);
    const attempt = uuidv7();
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
        INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number, fencing_epoch, claim_token, status)
        VALUES (${attempt}, ${m}, ${a.orgId}, ${uuidv7()}, ${channelId}, 1, 1, ${uuidv7()}, 'accepted')`);
    });
    await h.admin.execute(
      sql`SELECT * FROM app_ledger_post(${a.orgId}, 'provider_cost', ${attempt}, 37, NULL, ${m}, ${attempt}, 'p76d2', NULL)`,
    );
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
    const ledger = await request(h.app.getHttpServer())
      .get(url('/billing/ledger?limit=100'))
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Acc-Organization', a.orgId)
      .expect(200);
    const rows = ledger.body.data as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.entryType)).toEqual(['recharge']);
    expect(rows[0]).toEqual({
      id: expect.any(String),
      entryType: 'recharge',
      amountPaise: 1234,
      currency: 'INR',
      messageId: null,
      attemptId: null,
      correlationId: null,
      occurredAt: expect.any(String),
    });
    const raw = JSON.stringify(ledger.body);
    for (const secret of [
      secretRef,
      'internal note xyz',
      pending.id,
      approverId,
      b.orgId,
      '"37"',
      'provider_cost',
    ]) {
      expect([secret, raw.includes(secret)]).toEqual([secret, false]);
    }
    const filtered = await request(h.app.getHttpServer())
      .get(url('/billing/ledger?entryType=recharge'))
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Acc-Organization', a.orgId)
      .expect(200);
    expect(filtered.body.data).toHaveLength(1);
    await request(h.app.getHttpServer())
      .get(url('/billing/ledger?entryType=provider_cost'))
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Acc-Organization', a.orgId)
      .expect(400);
    const account = await request(h.app.getHttpServer())
      .get(url('/billing/account'))
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Acc-Organization', a.orgId)
      .expect(200);
    expect(account.body.data).toMatchObject({ balancePaise: 1234 });
  });

  // --- access ------------------------------------------------------------------------------------

  it('access: platform support, tenant administrators and API keys cannot recharge; no credential is 401', async () => {
    const t = await walletTenant('p76d2-acc');
    const tenantAdmin = await signIn(t.email);
    for (const [token, org] of [
      [support, undefined],
      [tenantAdmin, t.orgId],
      [apiKey, keyTenant.orgId],
    ] as const) {
      const r = request(h.app.getHttpServer())
        .post(url(`/platform/billing/organizations/${t.orgId}/recharges`))
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID());
      const res = await (org ? r.set('X-Acc-Organization', org) : r).send({
        amountPaise: 100,
        paymentReference: ref(),
        receivedOn: today(),
        reason: 'x',
      });
      expect(res.status).toBe(403);
    }
    await request(h.app.getHttpServer())
      .post(url(`/platform/billing/organizations/${t.orgId}/recharges`))
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise: 100, paymentReference: ref(), receivedOn: today(), reason: 'x' })
      .expect(401);
    expect(await ledgerFacts(t)).toBe(0);
  });

  it('validation: a future received date, a zero amount and an unknown field (e.g. a threshold) are refused', async () => {
    const t = await walletTenant('p76d2-val');
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await recharge(t, 100, ref(), { receivedOn: tomorrow })).status).toBe(400);
    expect((await recharge(t, 0)).status).toBe(400);
    const extra = await post(requester, `/organizations/${t.orgId}/recharges`, {
      amountPaise: 100,
      paymentReference: ref(),
      receivedOn: today(),
      reason: 'x',
      thresholdPaise: 10_000_000,
    });
    expect(extra.status).toBe(400);
    expect(await ledgerFacts(t)).toBe(0);
  });

  it('counts recharges by outcome after commit', async () => {
    const counter = await metrics.billingAccountOperations.get();
    const value = (outcome: string) =>
      counter.values.find((v) => v.labels.action === 'recharge' && v.labels.outcome === outcome)
        ?.value ?? 0;
    expect(value('executed')).toBeGreaterThanOrEqual(10);
    expect(value('pending')).toBeGreaterThanOrEqual(5);
    expect(value('rejected')).toBeGreaterThanOrEqual(1);
    expect(value('refused')).toBeGreaterThanOrEqual(5);
  });
});
