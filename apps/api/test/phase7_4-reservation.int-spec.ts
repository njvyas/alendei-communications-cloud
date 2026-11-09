// Must stay the first import: it switches billing enforcement on before the
// application module (and its validated configuration) is loaded.
import './billing-enforcement.env';

import { randomBytes, randomUUID } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, type SmsDltMetadata } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { Client } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AuthorizationService } from '../src/auth/authorization.service';
import { AppConfigService } from '../src/config/app-config.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { CredentialService } from '../src/iam/credential.service';
import { MessageSubmissionCore } from '../src/messages/submission/message-submission.core';
import { authorizeSubmission } from '../src/messages/submission/submission-authorization';
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
 * Phase 7 PR 7-4 — funds reservation at submission, over HTTP
 * (`DECISIONS.md` §1zi.7; handover §14). Billing enforcement is ON for this suite.
 *
 *   1. Reservation: one `reservation` fact per message, sized from the rate card
 *      and the organization's policy, on the account of its mode; units and the
 *      billing snapshot on the message; SMS rated once per transaction.
 *   2. Fail closed (owner decision D-74-1/2): insufficient funds, missing price,
 *      missing or frozen account — and nothing persisted in any table the path
 *      writes. Every existing refusal still comes first.
 *   3. Idempotency (D-4): the key is mandatory; replay, changed request,
 *      concurrent duplicates, a retry after a refusal, and keys created before
 *      enforcement was enabled.
 *   4. Concurrency: no overspend under contention; the account lock is bounded
 *      (`503 BILLING_BUSY`) and per organization.
 *   5. Atomicity: a failure after the reservation rolls everything back.
 *
 * Nothing is dispatched (the dispatch loop is off). Run through
 * `scripts/with-db-clone.mjs`.
 */

const url = (p: string) => `/${PREFIX}${p}`;
const DLT: SmsDltMetadata = {
  entityId: '1201159123456789012',
  templateId: '1207161234567890123',
  headerId: 'ALENDE',
};

// Rates in 1/10,000 paisa (migration 0051).
const WA_PRICE = 500_000; // 50 paise per message
const SMS_PRICE = 155_000; // 15.5 paise per segment
const RCS_PRICE = 300_000; // 30 paise per message

type Body = Record<string, unknown>;
interface Sender {
  readonly tenant: TenantFixture;
  readonly token: string;
}

describe('Phase 7-4: funds reservation at submission (enforcement on)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let config: AppConfigService;
  const channel: Record<string, string> = {};
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const roles: string[] = [];
  let seq = 0;
  let priority = 0;
  const plans: string[] = [];

  // Organizations, one per scenario.
  let P: Sender; // prepaid, per message, funded; WhatsApp, SMS and RCS priced
  let Q: Sender; // postpaid, credit limit 1000
  let N: Sender; // priced; only a credit account although prepaid
  let F: Sender; // priced; frozen wallet
  let U: Sender; // funded; no rate card
  let Z: Sender; // a zero price; empty wallet
  let T: Sender; // charge_per_attempt; three WhatsApp providers
  let T2: Sender; // charge_per_attempt; one candidate unpriced
  let C: Sender; // wallet for exactly seven WhatsApp messages
  let L: Sender; // funded; its wallet is held by another session
  let X: Sender; // funded; isolation probe
  let smsLongTemplate: string;
  let smsUnicodeTemplate: string;
  let apiKey: string;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    config = h.app.get(AppConfigService);
    expect(config.billing.enforcementEnabled).toBe(true);
    for (const row of await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['sms', 'rcs', 'whatsapp']))) {
      channel[row.code] = row.id;
    }

    P = await sender('p74-p');
    Q = await sender('p74-q');
    N = await sender('p74-n');
    F = await sender('p74-f');
    U = await sender('p74-u');
    Z = await sender('p74-z');
    T = await sender('p74-t');
    T2 = await sender('p74-t2');
    C = await sender('p74-c');
    L = await sender('p74-l');
    X = await sender('p74-x');

    for (const code of ['whatsapp', 'sms', 'rcs']) await assign(P.tenant.orgId, code);
    for (const s of [Q, N, F, U, Z, C, L, X]) await assign(s.tenant.orgId, 'whatsapp');
    const standard = [
      { channel: 'whatsapp', price: WA_PRICE },
      { channel: 'sms', price: SMS_PRICE },
      { channel: 'rcs', price: RCS_PRICE },
    ];
    for (const s of [P, Q, N, F, C, L, X]) await priceFor(s.tenant.orgId, standard);
    await priceFor(Z.tenant.orgId, [{ channel: 'whatsapp', price: 0 }]);

    // charge_per_attempt: providers priced 60 and 40 paise by rule, the third at the
    // channel default of 50 → N = 3, reservation = 3 × 60 = 180.
    await setBilling(T.tenant.orgId, 'prepaid', 'charge_per_attempt');
    const t1 = await assign(T.tenant.orgId, 'whatsapp');
    const t2 = await assign(T.tenant.orgId, 'whatsapp');
    await assign(T.tenant.orgId, 'whatsapp');
    await priceFor(T.tenant.orgId, [
      { channel: 'whatsapp', price: WA_PRICE },
      { channel: 'whatsapp', provider: t1, price: 600_000 },
      { channel: 'whatsapp', provider: t2, price: 400_000 },
    ]);
    // charge_per_attempt with no channel default: the second candidate is unpriced.
    await setBilling(T2.tenant.orgId, 'prepaid', 'charge_per_attempt');
    const u1 = await assign(T2.tenant.orgId, 'whatsapp');
    await assign(T2.tenant.orgId, 'whatsapp');
    await priceFor(T2.tenant.orgId, [{ channel: 'whatsapp', provider: u1, price: WA_PRICE }]);

    await setBilling(Q.tenant.orgId, 'postpaid', 'charge_per_logical_message');
    await h.admin.execute(
      sql`INSERT INTO credit_accounts (org_id, credit_limit_paise) VALUES (${Q.tenant.orgId}, 1000)`,
    );
    await h.admin.execute(
      sql`INSERT INTO credit_accounts (org_id, credit_limit_paise) VALUES (${N.tenant.orgId}, 100000)`,
    );
    await h.admin.execute(
      sql`INSERT INTO wallets (org_id, balance_paise, status) VALUES (${F.tenant.orgId}, 100000, 'frozen')`,
    );
    for (const s of [P, U, T, T2, L, X]) await fund(s.tenant.orgId, 100_000);
    await fund(Z.tenant.orgId, 0);
    await fund(C.tenant.orgId, 7 * 50);

    smsLongTemplate = await template(P, 'sms', `${'A'.repeat(400)} {{1}}`);
    smsUnicodeTemplate = await template(P, 'sms', 'आपका कोड {{1}} है।');

    const perm = await h.admin
      .select({ key: schema.permissions.key })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, PERMISSIONS.MESSAGES_SEND));
    const prefix = `ak_test_${hex(8)}`;
    const secret = `s${hex(16)}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: P.tenant.orgId,
      name: `p74-${hex(3)}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      scopes: perm.map((p) => p.key),
      createdBy: P.tenant.userId,
    });
    apiKey = `${prefix}.${secret}`;
  }, 180_000);

  afterAll(async () => {
    // Messages that hold a reservation, their ledger facts, evaluations, accounts and
    // pricing assignments are undeletable by design (DECISIONS.md §1zi.4); the owner
    // removes this suite's fixtures with triggers suspended for one transaction only.
    try {
      const orgIds = tenants.map((t) => t.orgId);
      if (orgIds.length > 0) {
        await h.admin.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role = replica`);
          const orgs = sql`ANY(${`{${orgIds.join(',')}}`}::uuid[])`;
          for (const table of [
            'usage_ledger',
            'message_dispatch_queue',
            'message_events',
            'idempotency_keys',
          ]) {
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${orgs}`);
          }
          await tx.execute(
            sql`DELETE FROM pricing_evaluation_components WHERE evaluation_id IN (SELECT id FROM pricing_evaluations WHERE org_id = ${orgs})`,
          );
          for (const table of [
            'pricing_evaluations',
            'customer_pricing_assignments',
            'wallets',
            'credit_accounts',
            'messages',
            'contact_identities',
            'contacts',
            'suppressions',
            'templates',
            'organization_provider_assignments',
            'api_keys',
          ]) {
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${orgs}`);
          }
          // The suite's rate cards: provider-specific rules would otherwise keep its
          // providers (and every later suite that removes providers) from being deleted.
          if (plans.length > 0) {
            const planIds = sql`ANY(${`{${plans.join(',')}}`}::uuid[])`;
            await tx.execute(
              sql`DELETE FROM pricing_rules WHERE plan_version_id IN (SELECT id FROM pricing_plan_versions WHERE plan_id = ${planIds})`,
            );
            await tx.execute(sql`DELETE FROM pricing_plan_versions WHERE plan_id = ${planIds}`);
            await tx.execute(sql`DELETE FROM pricing_plans WHERE id = ${planIds}`);
          }
        });
      }
      if (roles.length > 0) {
        await h.admin.delete(schema.userRoles).where(inArray(schema.userRoles.roleId, roles));
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, roles));
        await h.admin.delete(schema.roles).where(inArray(schema.roles.id, roles));
      }
      for (const t of tenants) await destroyTenant(h.admin, t);
      if (providers.length > 0) {
        await h.admin.delete(schema.providers).where(inArray(schema.providers.id, providers));
      }
    } finally {
      await h.close();
    }
  }, 120_000);

  // --- fixtures ---------------------------------------------------------------

  function hex(n: number): string {
    return randomBytes(n).toString('hex');
  }

  async function sender(label: string): Promise<Sender> {
    const tenant = await createTenant(h.admin, label, credentials);
    tenants.push(tenant);
    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_SEND, PERMISSIONS.MESSAGES_READ]),
      );
    const roleId = uuidv7();
    roles.push(roleId);
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: tenant.orgId,
      key: `p74_${hex(4)}`,
      name: 'Phase 7-4 sender',
      description: 'Sends and reads messages',
      isSystemRole: false,
      allowedScopeTypes: ['organization'],
    });
    for (const p of perms) {
      await h.admin
        .insert(schema.rolePermissions)
        .values({ roleId, permissionId: p.id, orgId: tenant.orgId });
    }
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId: tenant.userId,
        roleId,
        scopeType: 'organization',
        scopeId: tenant.orgId,
      });
    });
    await h.clearRateLimits();
    const login = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenant.email, password: PASSWORD })
      .expect(200);
    return { tenant, token: login.body.data.accessToken as string };
  }

  async function assign(orgId: string, code: string): Promise<string> {
    const slug = `p74-${code}-${hex(4)}`;
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channel[code]!,
        name: `Phase 7-4 ${slug}`,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(p!.id);
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId,
      channelId: channel[code]!,
      providerId: p!.id,
      priority: (priority += 1),
      status: 'active',
    });
    return p!.id;
  }

  /** An organization rate card with one active version, in force from now. */
  async function priceFor(
    orgId: string,
    rules: ReadonlyArray<{ channel: string; provider?: string; price: number }>,
  ): Promise<void> {
    await h.admin.transaction(async (tx) => {
      const plan = await tx.execute<{ id: string }>(
        sql`INSERT INTO pricing_plans (name) VALUES (${`p74-${uuidv7()}`}) RETURNING id`,
      );
      plans.push(plan.rows[0]!.id);
      const version = await tx.execute<{ id: string }>(
        sql`INSERT INTO pricing_plan_versions (plan_id, version_number) VALUES (${plan.rows[0]!.id}, 1) RETURNING id`,
      );
      for (const r of rules) {
        await tx.execute(
          sql`INSERT INTO pricing_rules (plan_version_id, channel_id, provider_id, unit_price_e4)
              VALUES (${version.rows[0]!.id}, ${channel[r.channel]!}, ${r.provider ?? null}, ${r.price})`,
        );
      }
      await tx.execute(
        sql`UPDATE pricing_plan_versions SET status = 'active', effective_from = now() WHERE id = ${version.rows[0]!.id}`,
      );
      await tx.execute(
        sql`INSERT INTO customer_pricing_assignments (org_id, plan_id, effective_from) VALUES (${orgId}, ${plan.rows[0]!.id}, now())`,
      );
    });
  }

  async function fund(orgId: string, balance: number): Promise<void> {
    await h.admin.execute(
      sql`INSERT INTO wallets (org_id, balance_paise) VALUES (${orgId}, ${balance})`,
    );
  }

  async function setBilling(orgId: string, mode: string, policy: string): Promise<void> {
    await h.admin.execute(
      sql`UPDATE organizations SET billing_mode = ${mode}::billing_mode, billing_policy = ${policy}::billing_policy WHERE id = ${orgId}`,
    );
  }

  async function template(s: Sender, code: string, body: string): Promise<string> {
    const [t] = await h.admin
      .insert(schema.templates)
      .values({
        id: uuidv7(),
        orgId: s.tenant.orgId,
        channelId: channel[code]!,
        name: `p74_${code}_${hex(3)}`,
        body,
        variables: { names: ['1'], dlt: DLT },
        approvalStatus: 'approved',
      })
      .returning();
    return t!.id;
  }

  function recipient(): string {
    seq += 1;
    return `+1202556${String(1000 + seq).padStart(4, '0')}`;
  }

  function post(s: Sender | string, body: Body, key: string | null = randomUUID(), orgId?: string) {
    const token = typeof s === 'string' ? s : s.token;
    const org = orgId ?? (typeof s === 'string' ? P.tenant.orgId : s.tenant.orgId);
    const req = request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acc-Organization', org);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  }

  const wa = (to: string = recipient()) => ({
    channelCode: 'whatsapp',
    recipient: to,
    payload: { text: 'hello' },
  });

  /** Row counts of every table the submission path writes, for one organization. */
  async function footprint(orgId: string) {
    const n = async (table: string) =>
      Number(
        (
          await h.admin.execute<{ n: string }>(
            sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)} WHERE org_id = ${orgId}`,
          )
        ).rows[0]!.n,
      );
    return {
      messages: await n('messages'),
      queue: await n('message_dispatch_queue'),
      events: await n('message_events'),
      contacts: await n('contacts'),
      identities: await n('contact_identities'),
      keys: await n('idempotency_keys'),
      evaluations: await n('pricing_evaluations'),
      ledger: await n('usage_ledger'),
      ...(await account(orgId)),
    };
  }

  async function account(orgId: string): Promise<{ reserved: number; balance: number }> {
    const { rows } = await h.admin.execute<{ reserved: string; balance: string }>(
      sql`SELECT COALESCE((SELECT reserved_paise FROM wallets WHERE org_id = ${orgId}),
                          (SELECT reserved_paise FROM credit_accounts WHERE org_id = ${orgId}), 0)::text AS reserved,
                 COALESCE((SELECT balance_paise FROM wallets WHERE org_id = ${orgId}),
                          (SELECT used_paise FROM credit_accounts WHERE org_id = ${orgId}), 0)::text AS balance`,
    );
    return { reserved: Number(rows[0]!.reserved), balance: Number(rows[0]!.balance) };
  }

  async function ledgerFor(messageId: string) {
    const { rows } = await h.admin.execute<{
      entry_type: string;
      amount: number;
      wallet: boolean;
      credit: boolean;
    }>(
      sql`SELECT entry_type, amount_paise::int AS amount, wallet_id IS NOT NULL AS wallet,
                 credit_account_id IS NOT NULL AS credit
            FROM usage_ledger WHERE message_id = ${messageId}`,
    );
    return rows;
  }

  async function messageRow(messageId: string) {
    const [row] = await h.admin
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId));
    return row!;
  }

  async function evaluations(messageId: string) {
    const { rows } = await h.admin.execute<{ subject: string; units: number; price: number }>(
      sql`SELECT subject, units, total_customer_price_paise::int AS price
            FROM pricing_evaluations WHERE message_id = ${messageId}`,
    );
    return rows;
  }

  async function expectRefusedClean(
    s: Sender,
    body: Body,
    status: number,
    code: string,
    message: string,
  ): Promise<void> {
    const before = await footprint(s.tenant.orgId);
    const res = await post(s, body);
    expect([res.status, res.body.error?.code, res.body.error?.message]).toEqual([
      status,
      code,
      message,
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/paise|balance|reserved|price_e4/i);
    expect(await footprint(s.tenant.orgId)).toEqual(before);
  }

  // --- 1. reservation ----------------------------------------------------------

  describe('1. reservation', () => {
    it('prepaid, per message: reserves the rated price on the wallet, atomically with the message', async () => {
      const before = await footprint(P.tenant.orgId);
      const res = await post(P, wa()).expect(202);
      const id = res.body.data.id as string;
      expect(await messageRow(id)).toMatchObject({
        status: 'queued',
        billableUnits: 1,
        billableUnit: 'message',
        smsEncoding: null,
        billingEnforced: true,
        billingModeSnapshot: 'prepaid',
        billingPolicySnapshot: 'charge_per_logical_message',
      });
      expect(await ledgerFor(id)).toEqual([
        { entry_type: 'reservation', amount: 50, wallet: true, credit: false },
      ]);
      expect(await evaluations(id)).toEqual([{ subject: 'message', units: 1, price: 50 }]);
      const after = await footprint(P.tenant.orgId);
      expect(after).toEqual({
        ...before,
        messages: before.messages + 1,
        queue: before.queue + 1,
        events: before.events + 1,
        contacts: before.contacts + 1,
        identities: before.identities + 1,
        keys: before.keys + 1,
        evaluations: before.evaluations + 1,
        ledger: before.ledger + 1,
        reserved: before.reserved + 50,
      });
    });

    it('postpaid: reserves on the credit account; used is unchanged', async () => {
      const res = await post(Q, wa()).expect(202);
      expect(await ledgerFor(res.body.data.id)).toEqual([
        { entry_type: 'reservation', amount: 50, wallet: false, credit: true },
      ]);
      expect(await account(Q.tenant.orgId)).toEqual({ reserved: 50, balance: 0 });
      expect((await messageRow(res.body.data.id)).billingModeSnapshot).toBe('postpaid');
    });

    it('SMS, GSM-7, three segments: units persisted, rated once per transaction (47, not 3 × 16)', async () => {
      const res = await post(P, {
        channelCode: 'sms',
        recipient: recipient(),
        templateId: smsLongTemplate,
        payload: { variables: { '1': '123456' } },
      }).expect(202);
      const id = res.body.data.id as string;
      expect(await messageRow(id)).toMatchObject({
        billableUnits: 3,
        billableUnit: 'sms_segment',
        smsEncoding: 'GSM-7',
      });
      expect(await evaluations(id)).toEqual([{ subject: 'message', units: 3, price: 47 }]);
      expect((await ledgerFor(id))[0]!.amount).toBe(47);
    });

    it('SMS, UCS-2: one segment, encoding recorded', async () => {
      const res = await post(P, {
        channelCode: 'sms',
        recipient: recipient(),
        templateId: smsUnicodeTemplate,
        payload: { variables: { '1': '123456' } },
      }).expect(202);
      expect(await messageRow(res.body.data.id)).toMatchObject({
        billableUnits: 1,
        billableUnit: 'sms_segment',
        smsEncoding: 'UCS-2',
      });
      expect((await ledgerFor(res.body.data.id))[0]!.amount).toBe(16);
    });

    it('RCS: one unit per message', async () => {
      const res = await post(P, {
        channelCode: 'rcs',
        recipient: recipient(),
        payload: { messageType: 'text', text: 'hello' },
      }).expect(202);
      expect(await messageRow(res.body.data.id)).toMatchObject({
        billableUnits: 1,
        billableUnit: 'message',
      });
      expect((await ledgerFor(res.body.data.id))[0]!.amount).toBe(30);
    });

    it('charge_per_attempt: N candidate providers × the highest price; no message evaluation', async () => {
      const res = await post(T, wa()).expect(202);
      const id = res.body.data.id as string;
      expect(await ledgerFor(id)).toEqual([
        { entry_type: 'reservation', amount: 180, wallet: true, credit: false },
      ]);
      expect(await evaluations(id)).toEqual([]);
      expect((await messageRow(id)).billingPolicySnapshot).toBe('charge_per_attempt');
    });

    it('a zero price: accepted, evaluated at 0, nothing reserved', async () => {
      const res = await post(Z, wa()).expect(202);
      expect(await evaluations(res.body.data.id)).toEqual([
        { subject: 'message', units: 1, price: 0 },
      ]);
      expect(await ledgerFor(res.body.data.id)).toEqual([]);
      expect(await account(Z.tenant.orgId)).toEqual({ reserved: 0, balance: 0 });
    });

    it('an API-key principal reserves exactly as a user session does', async () => {
      const before = await account(P.tenant.orgId);
      const res = await post(apiKey, wa()).expect(202);
      expect(await ledgerFor(res.body.data.id)).toEqual([
        { entry_type: 'reservation', amount: 50, wallet: true, credit: false },
      ]);
      expect(await account(P.tenant.orgId)).toEqual({ ...before, reserved: before.reserved + 50 });
    });
  });

  // --- 2. fail closed ------------------------------------------------------------

  describe('2. fail closed, nothing persisted', () => {
    it('no rate card: 422 BILLING_PRICE_NOT_CONFIGURED', () =>
      expectRefusedClean(
        U,
        wa(),
        422,
        ERROR_CODES.BILLING_PRICE_NOT_CONFIGURED,
        'No price is configured for this message',
      ));

    it('charge_per_attempt with an unpriced candidate provider: 422 BILLING_PRICE_NOT_CONFIGURED', () =>
      expectRefusedClean(
        T2,
        wa(),
        422,
        ERROR_CODES.BILLING_PRICE_NOT_CONFIGURED,
        'No price is configured for this message',
      ));

    it('no account of the organization’s mode (only a credit account, prepaid): 422 BILLING_ACCOUNT_NOT_CONFIGURED', () =>
      expectRefusedClean(
        N,
        wa(),
        422,
        ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED,
        'No billing account is configured for this organization',
      ));

    it('a frozen account: 403 BILLING_ACCOUNT_FROZEN', () =>
      expectRefusedClean(
        F,
        wa(),
        403,
        ERROR_CODES.BILLING_ACCOUNT_FROZEN,
        'The billing account of this organization is frozen',
      ));

    it('postpaid beyond the credit limit: 402 BILLING_INSUFFICIENT_FUNDS', async () => {
      // 1000 limit: 19 more fit after the 50 reserved above; the 20th does not.
      for (let i = 0; i < 19; i += 1) await post(Q, wa()).expect(202);
      await expectRefusedClean(
        Q,
        wa(),
        402,
        ERROR_CODES.BILLING_INSUFFICIENT_FUNDS,
        'Insufficient funds to send this message',
      );
      expect(await account(Q.tenant.orgId)).toEqual({ reserved: 1000, balance: 0 });
    });

    it('every existing refusal still comes first (suppressed and unpriced: RECIPIENT_SUPPRESSED)', async () => {
      const to = recipient();
      await h.admin.insert(schema.suppressions).values({
        orgId: U.tenant.orgId,
        channelId: channel.whatsapp!,
        rawAddress: to,
        normalizedAddress: to,
        reason: 'opt-out',
        status: 'active',
      });
      await expectRefusedClean(
        U,
        wa(to),
        422,
        ERROR_CODES.RECIPIENT_SUPPRESSED,
        'Recipient is actively suppressed for this channel',
      );
      // And an unknown workspace precedes money too.
      await expectRefusedClean(
        U,
        { ...wa(), workspaceId: randomUUID() },
        404,
        ERROR_CODES.RESOURCE_NOT_FOUND,
        'Workspace not found',
      );
    });
  });

  // --- 3. idempotency (D-4) --------------------------------------------------------

  describe('3. idempotency', () => {
    it('a request without Idempotency-Key is refused, and nothing runs', async () => {
      const before = await footprint(P.tenant.orgId);
      const res = await post(P, wa(), null);
      expect([res.status, res.body.error.code, res.body.error.message]).toEqual([
        400,
        ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        'This operation requires an Idempotency-Key header',
      ]);
      expect(await footprint(P.tenant.orgId)).toEqual(before);
    });

    it('same key and request: the original response is replayed; nothing is reserved again', async () => {
      const key = randomUUID();
      const body = wa();
      const first = await post(P, body, key).expect(202);
      const before = await footprint(P.tenant.orgId);
      const again = await post(P, body, key).expect(202);
      expect(again.body).toEqual(first.body);
      expect(await footprint(P.tenant.orgId)).toEqual(before);
      expect(await ledgerFor(first.body.data.id)).toHaveLength(1);
    });

    it('same key, changed request: 422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH; nothing created', async () => {
      const key = randomUUID();
      await post(P, wa(), key).expect(202);
      const before = await footprint(P.tenant.orgId);
      const res = await post(P, wa(), key);
      expect([res.status, res.body.error.code]).toEqual([
        422,
        ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
      ]);
      expect(await footprint(P.tenant.orgId)).toEqual(before);
    });

    it('8 concurrent identical keyed requests: one message, one reservation', async () => {
      const key = randomUUID();
      const body = wa();
      const before = await footprint(P.tenant.orgId);
      const results = await Promise.all(Array.from({ length: 8 }, () => post(P, body, key)));
      for (const r of results) expect([202, 409]).toContain(r.status);
      const ids = new Set(results.filter((r) => r.status === 202).map((r) => r.body.data.id));
      expect(ids.size).toBe(1);
      const after = await footprint(P.tenant.orgId);
      expect([after.messages, after.ledger, after.reserved]).toEqual([
        before.messages + 1,
        before.ledger + 1,
        before.reserved + 50,
      ]);
    });

    it('a refusal is not stored: after a top-up the same key succeeds once', async () => {
      // C's wallet holds exactly seven messages, consumed in section 4; use a fresh key here.
      const empty = await sender('p74-topup');
      await assign(empty.tenant.orgId, 'whatsapp');
      await priceFor(empty.tenant.orgId, [{ channel: 'whatsapp', price: WA_PRICE }]);
      await fund(empty.tenant.orgId, 49);
      const key = randomUUID();
      const body = wa();
      const refused = await post(empty, body, key);
      expect([refused.status, refused.body.error.code]).toEqual([
        402,
        ERROR_CODES.BILLING_INSUFFICIENT_FUNDS,
      ]);
      await h.admin.execute(
        sql`UPDATE wallets SET balance_paise = balance_paise + 1 WHERE org_id = ${empty.tenant.orgId}`,
      );
      const ok = await post(empty, body, key).expect(202);
      const replay = await post(empty, body, key).expect(202);
      expect(replay.body).toEqual(ok.body);
      expect(await account(empty.tenant.orgId)).toEqual({ reserved: 50, balance: 50 });
    });

    it('enforcement off: unchanged (key optional), units recorded, no billing; a key created then replays after enforcement is on', async () => {
      const spy = jest
        .spyOn(config, 'billing', 'get')
        .mockReturnValue({ enforcementEnabled: false });
      let keyed: { id: string; body: unknown };
      const key = randomUUID();
      const body = wa();
      const before = await footprint(P.tenant.orgId);
      try {
        const one = await post(P, wa(), null).expect(202);
        const two = await post(P, wa(), null).expect(202);
        expect(one.body.data.id).not.toBe(two.body.data.id);
        for (const id of [one.body.data.id, two.body.data.id]) {
          expect(await messageRow(id)).toMatchObject({
            billableUnits: 1,
            billableUnit: 'message',
            billingEnforced: false,
            billingModeSnapshot: null,
            billingPolicySnapshot: null,
          });
          expect(await evaluations(id)).toEqual([]);
          expect(await ledgerFor(id)).toEqual([]);
        }
        const created = await post(P, body, key).expect(202);
        keyed = { id: created.body.data.id, body: created.body };
      } finally {
        spy.mockRestore();
      }
      expect(config.billing.enforcementEnabled).toBe(true);
      const replay = await post(P, body, key).expect(202);
      expect(replay.body).toEqual(keyed.body);
      expect(await ledgerFor(keyed.id)).toEqual([]);
      expect((await messageRow(keyed.id)).billingEnforced).toBe(false);
      const after = await footprint(P.tenant.orgId);
      expect([after.messages, after.ledger, after.evaluations, after.reserved]).toEqual([
        before.messages + 3,
        before.ledger,
        before.evaluations,
        before.reserved,
      ]);
    });
  });

  // --- 4. concurrency ----------------------------------------------------------------

  describe('4. concurrency', () => {
    it('20 concurrent sends against funds for exactly 7: 7 accepted, 13 refused, no overspend', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => post(C, wa())));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 202)).toHaveLength(7);
      expect(statuses.filter((s) => s === 402)).toHaveLength(13);
      const state = await footprint(C.tenant.orgId);
      expect([state.messages, state.ledger, state.reserved, state.balance]).toEqual([
        7, 7, 350, 350,
      ]);
    });

    it('6 concurrent first sends to one new recipient: one contact, six reservations', async () => {
      const to = recipient();
      const before = await footprint(P.tenant.orgId);
      const results = await Promise.all(Array.from({ length: 6 }, () => post(P, wa(to))));
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(202));
      const after = await footprint(P.tenant.orgId);
      expect([after.contacts, after.messages, after.ledger, after.reserved]).toEqual([
        before.contacts + 1,
        before.messages + 6,
        before.ledger + 6,
        before.reserved + 300,
      ]);
    });

    it('a held account lock is bounded: 503 BILLING_BUSY, nothing persisted; other organizations proceed; a retry succeeds', async () => {
      const holder = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
      await holder.connect();
      const key = randomUUID();
      const body = wa();
      const before = await footprint(L.tenant.orgId);
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM wallets WHERE org_id = $1 FOR UPDATE`, [L.tenant.orgId]);
        const started = Date.now();
        const [busy, other] = await Promise.all([
          post(L, body, key),
          (async () => {
            const t0 = Date.now();
            const r = await post(X, wa());
            return { status: r.status, ms: Date.now() - t0 };
          })(),
        ]);
        expect([busy.status, busy.body.error?.code, busy.body.error?.details]).toEqual([
          503,
          ERROR_CODES.BILLING_BUSY,
          { retryAfterSeconds: 1 },
        ]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
        expect(other.status).toBe(202);
        expect(other.ms).toBeLessThan(1_500);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
      expect(await footprint(L.tenant.orgId)).toEqual(before);
      await post(L, body, key).expect(202);
      expect((await account(L.tenant.orgId)).reserved).toBe(50);
    });
  });

  // --- 5. atomicity ----------------------------------------------------------------------

  describe('5. atomicity', () => {
    it('a caller failure after the reservation rolls back the message, evaluation, fact and balance', async () => {
      const db = h.app.get(TenantDatabase);
      const core = h.app.get(MessageSubmissionCore);
      // Stands in for an authorization decision already made by the caller.
      const allow = { assert: async () => undefined } as unknown as AuthorizationService;
      const before = await footprint(X.tenant.orgId);
      let reservedInside = -1;
      await expect(
        db.withTenant(
          { orgId: X.tenant.orgId, userId: X.tenant.userId, resellerId: X.tenant.resellerId },
          async (tx) => {
            const proof = await authorizeSubmission(allow, tx, {} as never, X.tenant.orgId);
            const created = await core.submit(
              tx,
              {
                orgId: X.tenant.orgId,
                correlationId: `p74-rollback-${hex(4)}`,
                authorization: proof,
              },
              wa(),
            );
            const seen = await tx.execute<{ n: string }>(
              sql`SELECT count(*)::text AS n FROM messages WHERE id = ${created.messageId}`,
            );
            reservedInside = Number(seen.rows[0]!.n);
            expect(created.status).toBe('queued');
            throw new Error('caller failed after submit');
          },
        ),
      ).rejects.toThrow('caller failed after submit');
      expect(reservedInside).toBe(1);
      expect(await footprint(X.tenant.orgId)).toEqual(before);
    });

    it('for every organization of the suite, reserved equals the sum of its reservation facts', async () => {
      const { rows } = await h.admin.execute<{
        org_id: string;
        reserved: string;
        facts: string;
      }>(sql`
        SELECT a.org_id, a.reserved_paise::text AS reserved,
               COALESCE((SELECT sum(l.amount_paise) FROM usage_ledger l
                          WHERE l.org_id = a.org_id AND l.entry_type = 'reservation'), 0)::text AS facts
          FROM (SELECT org_id, reserved_paise FROM wallets
                UNION ALL SELECT org_id, reserved_paise FROM credit_accounts) a
         WHERE a.org_id = ANY(${`{${tenants.map((t) => t.orgId).join(',')}}`}::uuid[])`);
      expect(rows.length).toBeGreaterThanOrEqual(10);
      for (const r of rows) expect([r.org_id, r.reserved]).toEqual([r.org_id, r.facts]);
      const settled = await h.admin.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM usage_ledger
             WHERE entry_type <> 'reservation'
               AND org_id = ANY(${`{${tenants.map((t) => t.orgId).join(',')}}`}::uuid[])`,
      );
      expect(settled.rows[0]!.n).toBe('0');
    });
  });
});
