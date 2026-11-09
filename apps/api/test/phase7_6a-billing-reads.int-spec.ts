import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
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
 * Phase 7 PR 7-6a — tenant billing reads over HTTP (`DECISIONS.md` §1zi.9;
 * handover Rev 2 §4, §9). Isolation itself is proved at the database layer in
 * `packages/db/src/test/phase7_6a-billing-reads.int-spec.ts`; this suite proves
 * the API on top of it:
 *
 *   1. `GET /billing/account`: prepaid and postpaid shapes, exact paise; 404 with
 *      no account.
 *   2. `GET /billing/ledger`: tenant-visible entries only, newest first, complete
 *      cursor pagination without duplicates, filters.
 *   3. `GET /billing/usage`: charges by channel and day, units, period validation.
 *   4. Never a provider cost, reseller markup or rate-card detail in any response.
 *   5. Access: billing.read through a system role, user sessions only; a user
 *      without it is refused; another organization's data is unreachable; no write
 *      route exists.
 */

const url = (p: string) => `/${PREFIX}${p}`;

interface Login {
  readonly tenant: TenantFixture;
  readonly token: string;
}

describe('Phase 7-6a: tenant billing reads', () => {
  let h: Harness;
  let credentials: CredentialService;
  const channel: Record<string, string> = {};
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const roles: string[] = [];
  let P: Login; // prepaid, three messages
  let Q: Login; // postpaid, one charge
  let E: Login; // no billing account
  let N: Login; // a user without billing.read
  const pMessages: string[] = [];
  let qMessage: string;
  let apiKey: string;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    for (const row of await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['sms', 'whatsapp']))) {
      channel[row.code] = row.id;
    }
    P = await login('p76a-p', true);
    Q = await login('p76a-q', true);
    E = await login('p76a-e', true);
    N = await login('p76a-n', false);

    await h.admin.execute(
      sql`INSERT INTO wallets (org_id, balance_paise) VALUES (${P.tenant.orgId}, 10000)`,
    );
    await h.admin.execute(
      sql`UPDATE organizations SET billing_mode = 'postpaid' WHERE id = ${Q.tenant.orgId}`,
    );
    await h.admin.execute(
      sql`INSERT INTO credit_accounts (org_id, credit_limit_paise) VALUES (${Q.tenant.orgId}, 1000)`,
    );
    await h.admin.execute(
      sql`INSERT INTO wallets (org_id, balance_paise) VALUES (${N.tenant.orgId}, 10000)`,
    );

    // P: WhatsApp accepted (50, with a provider cost of 20 that must never surface);
    // SMS of 3 segments accepted (47); WhatsApp failed (reserved 50, released).
    pMessages.push(await message(P, 'whatsapp', 1));
    await fact(P, 'reservation', pMessages[0]!, 50, 'wallet');
    const attempt = await attemptOf(P, pMessages[0]!, 'whatsapp');
    await fact(P, 'provider_cost', pMessages[0]!, 20, null, attempt);
    await fact(P, 'customer_charge', pMessages[0]!, 50, 'wallet');
    pMessages.push(await message(P, 'sms', 3));
    await fact(P, 'reservation', pMessages[1]!, 47, 'wallet');
    await fact(P, 'customer_charge', pMessages[1]!, 47, 'wallet');
    pMessages.push(await message(P, 'whatsapp', 1));
    await fact(P, 'reservation', pMessages[2]!, 50, 'wallet');
    await fact(P, 'reservation_release', pMessages[2]!, null, 'wallet');

    qMessage = await message(Q, 'whatsapp', 1);
    await fact(Q, 'reservation', qMessage, 50, 'credit');
    await fact(Q, 'customer_charge', qMessage, 50, 'credit');

    const perm = await h.admin
      .select({ key: schema.permissions.key })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_READ, PERMISSIONS.BILLING_READ]),
      );
    const prefix = `ak_test_${hex(8)}`;
    const secret = `s${hex(16)}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: P.tenant.orgId,
      name: `p76a-${hex(3)}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      scopes: perm.map((p) => p.key),
      createdBy: P.tenant.userId,
    });
    apiKey = `${prefix}.${secret}`;
  }, 180_000);

  afterAll(async () => {
    try {
      const orgIds = tenants.map((t) => t.orgId);
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        const orgs = sql`ANY(${`{${orgIds.join(',')}}`}::uuid[])`;
        for (const table of [
          'usage_ledger',
          'wallets',
          'credit_accounts',
          'message_attempts',
          'messages',
          'contacts',
          'organization_provider_assignments',
          'api_keys',
        ]) {
          await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${orgs}`);
        }
        if (providers.length > 0) {
          await tx.execute(
            sql`DELETE FROM providers WHERE id = ANY(${`{${providers.join(',')}}`}::uuid[])`,
          );
        }
      });
      if (roles.length > 0) {
        await h.admin.delete(schema.userRoles).where(inArray(schema.userRoles.roleId, roles));
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, roles));
        await h.admin.delete(schema.roles).where(inArray(schema.roles.id, roles));
      }
      for (const t of tenants) await destroyTenant(h.admin, t);
    } finally {
      await h.close();
    }
  }, 120_000);

  // --- fixtures ---------------------------------------------------------------

  function hex(n: number): string {
    return randomBytes(n).toString('hex');
  }

  /**
   * A tenant whose user signs in. With `billingRead`, its organization-admin
   * **system** role carries billing.read, as the production org_admin definition
   * does (`TENANT_ROLE_DEFINITIONS`); granted as provisioning does. Without it,
   * the user keeps the harness's organization-admin role, which lacks billing.read.
   */
  async function login(label: string, billingRead: boolean): Promise<Login> {
    const tenant = await createTenant(h.admin, label, credentials);
    tenants.push(tenant);
    if (billingRead) {
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.provisioning','on',true)`);
        // The harness's stand-in org_admin admits every tenant scope; the production
        // org_admin admits organization only, which billing.read requires. Match it.
        await tx.execute(
          sql`UPDATE roles SET allowed_scope_types = '{organization}' WHERE id = ${tenant.roleId}`,
        );
        await tx.execute(sql`
          INSERT INTO role_permissions (role_id, permission_id)
          SELECT ${tenant.roleId}, p.id FROM permissions p WHERE p.key = ${PERMISSIONS.BILLING_READ}`);
      });
    }
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenant.email, password: PASSWORD })
      .expect(200);
    return { tenant, token: res.body.data.accessToken as string };
  }

  async function message(s: Login, code: string, units: number): Promise<string> {
    const contact = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contact,
      orgId: s.tenant.orgId,
      workspaceId: s.tenant.workspaceId,
    });
    const id = uuidv7();
    await h.admin.insert(schema.messages).values({
      id,
      orgId: s.tenant.orgId,
      workspaceId: s.tenant.workspaceId,
      contactId: contact,
      channelId: channel[code]!,
      recipientAddress: '+12025550155',
      status: 'accepted',
      payload: { text: 'x' },
      correlationId: `p76a-${id}`,
      billableUnits: units,
      billableUnit: code === 'sms' ? 'sms_segment' : 'message',
      smsEncoding: code === 'sms' ? 'GSM-7' : null,
    });
    return id;
  }

  async function attemptOf(s: Login, messageId: string, code: string): Promise<string> {
    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channel[code]!,
        name: `p76a ${hex(4)}`,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(p!.id);
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: s.tenant.orgId,
      channelId: channel[code]!,
      providerId: p!.id,
      priority: 1,
      status: 'active',
    });
    const id = uuidv7();
    await h.admin.insert(schema.messageAttempts).values({
      id,
      messageId,
      orgId: s.tenant.orgId,
      providerId: p!.id,
      channelId: channel[code]!,
      attemptNumber: 1,
      status: 'accepted',
      claimToken: uuidv7(),
      fencingEpoch: 1,
    });
    return id;
  }

  async function fact(
    s: Login,
    type: string,
    messageId: string,
    amount: number | null,
    account: 'wallet' | 'credit' | null,
    attempt: string | null = null,
  ) {
    await h.admin.execute(sql`
      SELECT * FROM app_ledger_post(${s.tenant.orgId}, ${type}::usage_ledger_entry_type,
        ${attempt ?? messageId}, ${amount}, ${account}, ${messageId}, ${attempt},
        ${`p76a-${messageId}`}, NULL)`);
  }

  function get(s: Login | string, path: string, orgId?: string) {
    const req = request(h.app.getHttpServer()).get(url(path));
    if (typeof s === 'string')
      return req
        .set('Authorization', `Bearer ${s}`)
        .set('X-Acc-Organization', orgId ?? P.tenant.orgId);
    return req
      .set('Authorization', `Bearer ${s.token}`)
      .set('X-Acc-Organization', orgId ?? s.tenant.orgId);
  }

  const today = () => {
    const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  };

  const FORBIDDEN =
    /provider_?cost|reseller|markup|rate_?card|plan_?version|pricing_rule|unit_?(price|cost)/i;

  // --- 1. account ------------------------------------------------------------------

  describe('GET /billing/account', () => {
    it('prepaid: balance, reserved and available in paise', async () => {
      const res = await get(P, '/billing/account').expect(200);
      expect(res.body.data).toEqual({
        billingMode: 'prepaid',
        billingPolicy: 'charge_per_logical_message',
        status: 'active',
        currency: 'INR',
        balancePaise: 10000 - 97,
        creditLimitPaise: null,
        usedPaise: null,
        reservedPaise: 0,
        availablePaise: 10000 - 97,
      });
    });

    it('postpaid: credit limit, used, reserved and available', async () => {
      const res = await get(Q, '/billing/account').expect(200);
      expect(res.body.data).toEqual({
        billingMode: 'postpaid',
        billingPolicy: 'charge_per_logical_message',
        status: 'active',
        currency: 'INR',
        balancePaise: null,
        creditLimitPaise: 1000,
        usedPaise: 50,
        reservedPaise: 0,
        availablePaise: 950,
      });
    });

    it('no account: 404 BILLING_ACCOUNT_NOT_CONFIGURED; an empty ledger and usage', async () => {
      const res = await get(E, '/billing/account').expect(404);
      expect(res.body.error.code).toBe(ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED);
      const ledger = await get(E, '/billing/ledger').expect(200);
      expect(ledger.body.data).toEqual([]);
      const usage = await get(E, `/billing/usage?${today()}`).expect(200);
      expect(usage.body.data.totals).toEqual({ chargedPaise: 0, messages: 0, units: 0 });
      expect(usage.body.data.byChannel).toEqual([]);
    });
  });

  // --- 2. ledger --------------------------------------------------------------------

  describe('GET /billing/ledger', () => {
    it('lists the tenant-visible entries only, newest first, with no provider cost', async () => {
      const res = await get(P, '/billing/ledger?limit=100').expect(200);
      const rows = res.body.data as Array<Record<string, unknown>>;
      expect(rows.map((r) => [r.entryType, r.amountPaise])).toEqual([
        ['reservation_release', 50],
        ['reservation', 50],
        ['customer_charge', 47],
        ['reservation', 47],
        ['customer_charge', 50],
        ['reservation', 50],
      ]);
      expect(Object.keys(rows[0]!).sort()).toEqual(
        [
          'amountPaise',
          'attemptId',
          'correlationId',
          'currency',
          'entryType',
          'id',
          'messageId',
          'occurredAt',
        ].sort(),
      );
      expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
    });

    it('paginates completely by cursor, without duplicates or gaps', async () => {
      const all = (await get(P, '/billing/ledger?limit=100').expect(200)).body.data.map(
        (r: { id: string }) => r.id,
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const res = await get(
          P,
          `/billing/ledger?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ).expect(200);
        seen.push(...res.body.data.map((r: { id: string }) => r.id));
        cursor = res.body.page.nextCursor ?? null;
        if (!cursor) break;
      }
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(6);
    });

    it('filters by entry type and message; refuses provider_cost as a filter', async () => {
      const charges = await get(P, '/billing/ledger?entryType=customer_charge').expect(200);
      expect(charges.body.data.map((r: { amountPaise: number }) => r.amountPaise)).toEqual([
        47, 50,
      ]);
      const one = await get(P, `/billing/ledger?messageId=${pMessages[2]}`).expect(200);
      expect(one.body.data.map((r: { entryType: string }) => r.entryType)).toEqual([
        'reservation_release',
        'reservation',
      ]);
      await get(P, '/billing/ledger?entryType=provider_cost').expect(400);
    });

    it("another organization's entries are unreachable, even by message id", async () => {
      const res = await get(Q, `/billing/ledger?messageId=${pMessages[0]}`).expect(200);
      expect(res.body.data).toEqual([]);
      const own = await get(Q, '/billing/ledger').expect(200);
      expect(own.body.data.every((r: { messageId: string }) => r.messageId === qMessage)).toBe(
        true,
      );
    });
  });

  // --- 3. usage ----------------------------------------------------------------------

  describe('GET /billing/usage', () => {
    it('aggregates charges by channel and day, with units; nothing for released messages', async () => {
      const res = await get(P, `/billing/usage?${today()}`).expect(200);
      const data = res.body.data;
      expect(data.currency).toBe('INR');
      expect(data.totals).toEqual({ chargedPaise: 97, messages: 2, units: 4 });
      expect(data.byChannel).toEqual([
        { channelCode: 'sms', chargedPaise: 47, messages: 1, units: 3 },
        { channelCode: 'whatsapp', chargedPaise: 50, messages: 1, units: 1 },
      ]);
      expect(
        data.daily.reduce((t: number, d: { chargedPaise: number }) => t + d.chargedPaise, 0),
      ).toBe(97);
      expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
    });

    it('filters by channel', async () => {
      const res = await get(P, `/billing/usage?${today()}&channelCode=sms`).expect(200);
      expect(res.body.data.totals).toEqual({ chargedPaise: 47, messages: 1, units: 3 });
    });

    it('validates the period: at most 92 days, to after from, a known time zone', async () => {
      const from = new Date('2026-01-01T00:00:00Z').toISOString();
      // 92 days exactly is admitted; 93 is not.
      await get(
        P,
        `/billing/usage?from=${from}&to=${new Date('2026-04-03T00:00:00Z').toISOString()}`,
      ).expect(200);
      await get(
        P,
        `/billing/usage?from=${from}&to=${new Date('2026-04-04T00:00:00Z').toISOString()}`,
      ).expect(400);
      await get(P, `/billing/usage?from=${from}&to=${from}`).expect(400);
      await get(P, `/billing/usage?${today()}&timeZone=Mars%2FOlympus`).expect(400);
      await get(P, '/billing/usage').expect(400);
    });
  });

  // --- 4. access -------------------------------------------------------------------------

  describe('access', () => {
    it.each([
      '/billing/account',
      '/billing/ledger',
      `/billing/usage?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`,
    ])('%s: a user without billing.read is refused (403)', async (path) => {
      const res = await get(N, path);
      expect(res.status).toBe(403);
    });

    // The key's scopes include billing.read — planted directly, since the API refuses to
    // issue it (INERT_PERMISSION_KEYS) — and it is still refused: user sessions only (D-76-4).
    it.each([
      '/billing/account',
      '/billing/ledger',
      '/billing/usage?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
    ])('%s: an API key is refused, even one carrying billing.read', async (path) => {
      const res = await get(apiKey, path, P.tenant.orgId);
      expect([res.status, res.body.error?.code]).toEqual([403, ERROR_CODES.AUTHZ_SCOPE_DENIED]);
      expect(JSON.stringify(res.body)).not.toMatch(/balance|reserved/i);
    });

    it("a member of one organization cannot read another's account by switching the header", async () => {
      const res = await get(Q, '/billing/account', P.tenant.orgId);
      expect([403, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toMatch(/balancePaise/);
    });

    it.each([
      ['POST', '/billing/account'],
      ['PUT', '/billing/account'],
      ['PATCH', '/billing/account'],
      ['DELETE', '/billing/account'],
      ['POST', '/billing/ledger'],
      ['DELETE', '/billing/ledger'],
    ])('%s %s: no write route exists', async (method, path) => {
      const res = await request(h.app.getHttpServer())
        [method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete'](url(path))
        .set('Authorization', `Bearer ${P.token}`)
        .set('X-Acc-Organization', P.tenant.orgId)
        .send({});
      expect(res.status).toBe(404);
    });
  });
});
