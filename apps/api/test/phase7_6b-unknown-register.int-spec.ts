import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

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
 * Phase 7 PR 7-6b — the unknown-outcome register (`DECISIONS.md` §1zi.9 D-76-5;
 * handover Rev 2 §5; baseline §6.5 Policy U).
 *
 *   1. Exactly the enforced outcome_unknown messages, oldest first, with the unknown
 *      attempt, age, evidence and the derived status (open, charged,
 *      charged_without_cost).
 *   2. Exposure is the evaluations' estimate — E_m, or the attempt's E_a under
 *      charge_per_attempt — and the provider cost of the attempt; it is never a
 *      ledger entry, and reading the register writes nothing.
 *   3. Filters and cursor pagination.
 *   4. The open-items gauge.
 *   5. Access: billing.manage at platform scope only — not platform support, not a
 *      tenant administrator, not an API key.
 */

const url = (p: string) => `/${PREFIX}${p}`;
const DAY = 24 * 3600 * 1000;

describe('Phase 7-6b: the unknown-outcome register', () => {
  let h: Harness;
  let credentials: CredentialService;
  let channelId: string;
  let providerId: string;
  let planId: string;
  const tenants: TenantFixture[] = [];
  const users: string[] = [];
  let A: TenantFixture; // per message: M1 open/unevidenced, M2 open/evidenced; excluded M5, M6
  let B: TenantFixture; // per message: M3 charged, M4 charged_without_cost
  let C: TenantFixture; // per attempt: M7 open
  const m: Record<string, string> = {};
  const att: Record<string, string> = {};
  let superAdmin: string;
  let support: string;
  let tenantAdmin: string;
  let apiKey: string;

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    const [c] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    channelId = c!.id;
    A = await tenant('p76b-a');
    B = await tenant('p76b-b');
    C = await tenant('p76b-c');

    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `p76b ${hex(4)}`,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providerId = p!.id;
    // A rate card for the three organizations (50 paise; provider rule 60) and a cost of 20.
    await h.admin.transaction(async (tx) => {
      const plan = await tx.execute<{ id: string }>(
        sql`INSERT INTO pricing_plans (name) VALUES (${`p76b-${uuidv7()}`}) RETURNING id`,
      );
      planId = plan.rows[0]!.id;
      const v = await tx.execute<{ id: string }>(
        sql`INSERT INTO pricing_plan_versions (plan_id, version_number) VALUES (${planId}, 1) RETURNING id`,
      );
      await tx.execute(
        sql`INSERT INTO pricing_rules (plan_version_id, channel_id, unit_price_e4) VALUES (${v.rows[0]!.id}, ${channelId}, 500000)`,
      );
      await tx.execute(
        sql`INSERT INTO pricing_rules (plan_version_id, channel_id, provider_id, unit_price_e4) VALUES (${v.rows[0]!.id}, ${channelId}, ${providerId}, 600000)`,
      );
      await tx.execute(
        sql`UPDATE pricing_plan_versions SET status = 'active', effective_from = now() WHERE id = ${v.rows[0]!.id}`,
      );
      for (const t of [A, B, C]) {
        await tx.execute(
          sql`INSERT INTO customer_pricing_assignments (org_id, plan_id, effective_from) VALUES (${t.orgId}, ${planId}, now())`,
        );
      }
      await tx.execute(
        sql`INSERT INTO provider_cost_rates (provider_id, channel_id, unit_cost_e4, effective_from) VALUES (${providerId}, ${channelId}, 200000, now())`,
      );
    });
    for (const t of [A, B, C]) {
      await h.admin.insert(schema.organizationProviderAssignments).values({
        orgId: t.orgId,
        channelId,
        providerId,
        priority: 1,
        status: 'active',
      });
    }
    await h.admin.execute(
      sql`INSERT INTO wallets (org_id, balance_paise) VALUES (${B.orgId}, 10000)`,
    );

    await plant('M1', A, { daysAgo: 5 });
    await plant('M2', A, { daysAgo: 4, evidenced: true });
    await plant('M5', A, { daysAgo: 3, enforced: false });
    await plant('M6', A, { daysAgo: 3, status: 'accepted' });
    await plant('M3', B, { daysAgo: 2 });
    await plant('M4', B, { daysAgo: 1 });
    await plant('M7', C, { daysAgo: 0.5, perAttempt: true });

    // B: M3 charged with its provider cost; M4 charged without cost (no evidence).
    for (const key of ['M3', 'M4']) {
      await post(B, 'reservation', m[key]!, m[key]!, 50, 'wallet', null);
      await post(B, 'customer_charge', m[key]!, m[key]!, 50, 'wallet', null);
    }
    await post(B, 'provider_cost', m.M3!, att.M3!, 20, null, att.M3!);

    superAdmin = await platformUser('super', PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
    support = await platformUser('support', PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT);
    tenantAdmin = await signIn(A.email);
    const prefix = `ak_test_${hex(8)}`;
    const secret = `s${hex(16)}`;
    const perms = await h.admin
      .select({ key: schema.permissions.key })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.BILLING_MANAGE, PERMISSIONS.BILLING_READ]),
      );
    await h.admin.insert(schema.apiKeys).values({
      orgId: A.orgId,
      name: `p76b-${hex(3)}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      scopes: perms.map((x) => x.key),
      createdBy: A.userId,
    });
    apiKey = `${prefix}.${secret}`;
  }, 180_000);

  afterAll(async () => {
    try {
      const orgIds = tenants.map((t) => t.orgId);
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        const orgs = sql`ANY(${`{${orgIds.join(',')}}`}::uuid[])`;
        await tx.execute(
          sql`DELETE FROM pricing_evaluation_components WHERE evaluation_id IN (SELECT id FROM pricing_evaluations WHERE org_id = ${orgs})`,
        );
        for (const table of [
          'usage_ledger',
          'pricing_evaluations',
          'customer_pricing_assignments',
          'wallets',
          'message_attempts',
          'messages',
          'contacts',
          'organization_provider_assignments',
          'api_keys',
        ]) {
          await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${orgs}`);
        }
        await tx.execute(sql`DELETE FROM provider_cost_rates WHERE provider_id = ${providerId}`);
        await tx.execute(
          sql`DELETE FROM pricing_rules WHERE plan_version_id IN (SELECT id FROM pricing_plan_versions WHERE plan_id = ${planId})`,
        );
        await tx.execute(sql`DELETE FROM pricing_plan_versions WHERE plan_id = ${planId}`);
        await tx.execute(sql`DELETE FROM pricing_plans WHERE id = ${planId}`);
        await tx.execute(sql`DELETE FROM providers WHERE id = ${providerId}`);
        // The suite's platform users: the last-platform-administrator guard (a trigger)
        // would otherwise refuse removing the only super administrator of a fresh clone.
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
    const email = `p76b-${label}-${hex(5)}@example.test`;
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

  /**
   * A message as settlement would leave it, with its unknown attempt and its
   * evaluations rated by app_rate_message. The owner writes the terminal and delivery
   * fields with triggers suspended (the attempt guards admit them only through the
   * dispatcher and delivery paths).
   */
  async function plant(
    key: string,
    t: TenantFixture,
    o: {
      daysAgo: number;
      evidenced?: boolean;
      enforced?: boolean;
      status?: string;
      perAttempt?: boolean;
    },
  ) {
    const enforced = o.enforced ?? true;
    const status = o.status ?? 'outcome_unknown';
    const contact = uuidv7();
    const id = uuidv7();
    const attempt = uuidv7();
    m[key] = id;
    att[key] = attempt;
    const completed = new Date(Date.now() - o.daysAgo * DAY);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(
        sql`INSERT INTO contacts (id, org_id, workspace_id) VALUES (${contact}, ${t.orgId}, ${t.workspaceId})`,
      );
      await tx.execute(sql`
        INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address,
                              correlation_id, completed_at, billable_units, billable_unit, billing_enforced,
                              billing_mode_snapshot, billing_policy_snapshot)
        VALUES (${id}, ${t.orgId}, ${t.workspaceId}, ${contact}, ${channelId}, ${status}::message_status,
                '+12025550144', ${`p76b-${key}`}, ${completed.toISOString()}::timestamptz, 1, 'message',
                ${enforced}, ${enforced ? 'prepaid' : null}::billing_mode,
                ${enforced ? (o.perAttempt ? 'charge_per_attempt' : 'charge_per_logical_message') : null}::billing_policy)`);
      await tx.execute(sql`
        INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number,
                                      fencing_epoch, claim_token, status, delivery_status, delivered_at)
        VALUES (${attempt}, ${id}, ${t.orgId}, ${providerId}, ${channelId}, 1, 1, ${uuidv7()},
                ${status === 'accepted' ? 'accepted' : 'outcome_unknown'}::message_attempt_status,
                ${o.evidenced ? 'delivered' : 'pending'}::message_delivery_status,
                ${o.evidenced ? new Date().toISOString() : null}::timestamptz)`);
    });
    if (enforced) {
      await h.admin.execute(
        sql`SELECT * FROM app_rate_message(${t.orgId}, ${id}, NULL, 1, true, false)`,
      );
      await h.admin.execute(
        sql`SELECT * FROM app_rate_message(${t.orgId}, ${id}, ${attempt}, 1, ${!!o.perAttempt}, true)`,
      );
    }
  }

  async function post(
    t: TenantFixture,
    type: string,
    messageId: string,
    anchor: string,
    amount: number,
    account: string | null,
    attempt: string | null,
  ) {
    await h.admin.execute(sql`
      SELECT * FROM app_ledger_post(${t.orgId}, ${type}::usage_ledger_entry_type, ${anchor}, ${amount},
        ${account}, ${messageId}, ${attempt}, 'p76b', NULL)`);
  }

  const get = (token: string, query = '', org?: string) => {
    const r = request(h.app.getHttpServer())
      .get(url(`/platform/billing/unknown-outcomes${query}`))
      .set('Authorization', `Bearer ${token}`);
    return org ? r.set('X-Acc-Organization', org) : r;
  };
  type Item = Record<string, unknown> & { messageId: string };
  const ours = (items: Item[]) =>
    items.filter((i) => Object.values(m).includes(i.messageId)).map((i) => i.messageId);
  const ledgerCount = async () =>
    Number(
      (
        await h.admin.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM usage_ledger WHERE org_id = ANY(${`{${tenants.map((t) => t.orgId).join(',')}}`}::uuid[])`,
        )
      ).rows[0]!.n,
    );

  // --- 1–2. rows, status, exposure ------------------------------------------------------

  it('lists exactly the enforced unknown outcomes, oldest first, with status, evidence and estimated exposure', async () => {
    const before = await ledgerCount();
    const res = await get(superAdmin, '?limit=100').expect(200);
    const items = res.body.data as Item[];
    expect(ours(items)).toEqual([m.M1, m.M2, m.M3, m.M4, m.M7]);
    const byId = Object.fromEntries(items.map((i) => [i.messageId, i]));
    expect(byId[m.M1!]).toMatchObject({
      orgId: A.orgId,
      channelCode: 'whatsapp',
      billingPolicy: 'charge_per_logical_message',
      attemptId: att.M1,
      providerId,
      evidence: 'unevidenced',
      status: 'open',
      // E_m at the channel default (50); the provider cost rated for the attempt (20).
      estimatedExposure: { customerPaise: 50, providerCostPaise: 20 },
    });
    expect(byId[m.M1!]!.ageSeconds).toBeGreaterThanOrEqual(5 * 86400 - 60);
    expect(byId[m.M2!]).toMatchObject({ evidence: 'evidenced', status: 'open' });
    expect(byId[m.M3!]).toMatchObject({ status: 'charged' });
    expect(byId[m.M4!]).toMatchObject({ status: 'charged_without_cost' });
    // charge_per_attempt: the unknown attempt's own price (the provider rule, 60).
    expect(byId[m.M7!]).toMatchObject({
      billingPolicy: 'charge_per_attempt',
      estimatedExposure: { customerPaise: 60, providerCostPaise: 20 },
      status: 'open',
    });
    // Reading the register writes nothing.
    expect(await ledgerCount()).toBe(before);
  });

  // --- 3. filters and pagination -----------------------------------------------------------

  it.each([
    [`?orgId=ORG_A`, ['M1', 'M2']],
    [`?orgId=ORG_B&status=charged`, ['M3']],
    [`?orgId=ORG_B&status=charged_without_cost`, ['M4']],
    [`?orgId=ORG_A&evidence=evidenced`, ['M2']],
    [`?orgId=ORG_A&evidence=unevidenced`, ['M1']],
    [`?orgId=ORG_C&channelCode=whatsapp`, ['M7']],
    [`?orgId=ORG_C&channelCode=sms`, []],
    [`?orgId=ORG_A&status=pending_approval`, []],
    [`?orgId=ORG_A&status=written_off`, []],
  ])('filters %s', async (query, expected) => {
    const q = query.replace('ORG_A', A.orgId).replace('ORG_B', B.orgId).replace('ORG_C', C.orgId);
    const res = await get(superAdmin, q).expect(200);
    expect(ours(res.body.data)).toEqual(expected.map((k) => m[k]));
  });

  it('filters by minimum age', async () => {
    const res = await get(superAdmin, '?minAgeHours=72&limit=100').expect(200);
    expect(ours(res.body.data)).toEqual([m.M1, m.M2]);
  });

  it('paginates completely by cursor, without duplicates', async () => {
    const all = ours((await get(superAdmin, '?limit=100').expect(200)).body.data);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const res = await get(
        superAdmin,
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ).expect(200);
      seen.push(...ours(res.body.data));
      cursor = res.body.page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
  });

  it('refuses invalid filters and a forged cursor', async () => {
    await get(superAdmin, '?status=paid').expect(400);
    await get(superAdmin, '?evidence=maybe').expect(400);
    await get(superAdmin, '?cursor=not-a-cursor').expect(400);
  });

  // --- 4. gauge ------------------------------------------------------------------------------

  it('sets the open-items gauge per channel on each read', async () => {
    await get(superAdmin).expect(200);
    const { rows } = await h.admin.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM messages msg
       WHERE msg.billing_enforced AND msg.status = 'outcome_unknown' AND msg.channel_id = ${channelId}
         AND NOT EXISTS (
           SELECT 1 FROM usage_ledger l
            WHERE l.message_id = msg.id AND l.fact_kind = 'customer_charge'
              -- the automatic anchor: the message, or under charge_per_attempt its unknown attempt
              AND l.anchor_id = CASE WHEN msg.billing_policy_snapshot = 'charge_per_attempt'
                                     THEN (SELECT x.id FROM message_attempts x
                                            WHERE x.message_id = msg.id AND x.status = 'outcome_unknown'
                                            ORDER BY x.attempt_number DESC LIMIT 1)
                                     ELSE msg.id END)`);
    const gauge = await h.app.get(MetricsService).billingOutcomeUnknownOpen.get();
    const whatsapp = gauge.values.find((v) => v.labels.channel === 'whatsapp')?.value;
    expect(whatsapp).toBe(Number(rows[0]!.n));
    expect(whatsapp).toBeGreaterThanOrEqual(3); // M1, M2, M7
  });

  // --- 5. access ------------------------------------------------------------------------------

  it('platform support is refused (billing.manage only, D-76-5)', async () => {
    const res = await get(support);
    expect([res.status, res.body.error?.code]).toEqual([403, ERROR_CODES.AUTHZ_SCOPE_DENIED]);
  });

  it('a tenant administrator is refused, even with an organization selected', async () => {
    expect((await get(tenantAdmin)).status).toBe(403);
    expect((await get(tenantAdmin, '', A.orgId)).status).toBe(403);
  });

  it('an API key is refused, even one carrying billing.manage', async () => {
    const res = await get(apiKey, '', A.orgId);
    expect([res.status, res.body.error?.code]).toEqual([403, ERROR_CODES.AUTHZ_SCOPE_DENIED]);
  });

  it('no credential: 401', async () => {
    await request(h.app.getHttpServer()).get(url('/platform/billing/unknown-outcomes')).expect(401);
  });
});
