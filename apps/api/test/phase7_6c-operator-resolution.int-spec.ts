import { randomBytes, randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS, ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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
 * Phase 7 PR 7-6c — operator resolution of unknown outcomes (`DECISIONS.md` §1zi.9
 * D-76-1, D-76-3, D-76-5 and §1zi.12; baseline §6.5 Policy U).
 *
 *   1. Dual control: with the threshold unset everything waits for a second approver; set,
 *      at or below it executes on request, above it waits; an unevidenced charge always
 *      waits. The requester can neither approve nor reject. Approval is bound to the amount.
 *   2. A charge posts the automatic path's identities — E_m on the message; under
 *      charge_per_attempt E_a on the unknown attempt and on every earlier attempt that
 *      reached the provider (D-76c-1) — and the provider cost only with evidence (O-1);
 *      balance or used moves, the reservation does not, and no reservation is posted.
 *   3. A write-off posts nothing. The register shows pending_approval and written_off; the
 *      open count keeps a pending item and drops an executed one (C-2).
 *   4. Refusals: insufficient funds and a frozen account (nothing on request; recorded on a
 *      pending approval), stale approvals, ineligible messages.
 *   5. Idempotency, concurrency, audit, metrics, listing and access.
 */

const url = (p: string) => `/${PREFIX}${p}`;

describe('Phase 7-6c: operator resolution of unknown outcomes', () => {
  let h: Harness;
  let credentials: CredentialService;
  let config: AppConfigService;
  let metrics: MetricsService;
  let channelId: string;
  let providerId: string;
  let planId: string;
  const tenants: TenantFixture[] = [];
  const users: string[] = [];
  let A: TenantFixture; // prepaid, charge_per_logical_message, wallet 10000
  let P: TenantFixture; // prepaid, charge_per_attempt, wallet 10000
  let C: TenantFixture; // postpaid, charge_per_logical_message, credit limit 10000
  let L: TenantFixture; // prepaid, wallet 30 (short of E_m = 50)
  let F: TenantFixture; // prepaid, frozen wallet
  let requester: string;
  let approver: string;
  let approver2: string;
  let approverId: string;
  let support: string;
  let tenantAdmin: string;
  let apiKey: string;

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
    A = await tenant('p76c-a');
    P = await tenant('p76c-p');
    C = await tenant('p76c-c');
    L = await tenant('p76c-l');
    F = await tenant('p76c-f');

    const [p] = await h.admin
      .insert(schema.providers)
      .values({
        channelId,
        name: `p76c ${hex(4)}`,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providerId = p!.id;
    // A rate card: the channel default 50 paise (E_m), the provider rule 60 (E_a), cost 20.
    await h.admin.transaction(async (tx) => {
      const plan = await tx.execute<{ id: string }>(
        sql`INSERT INTO pricing_plans (name) VALUES (${`p76c-${uuidv7()}`}) RETURNING id`,
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
      for (const t of tenants) {
        await tx.execute(
          sql`INSERT INTO customer_pricing_assignments (org_id, plan_id, effective_from) VALUES (${t.orgId}, ${planId}, now())`,
        );
      }
      await tx.execute(
        sql`INSERT INTO provider_cost_rates (provider_id, channel_id, unit_cost_e4, effective_from) VALUES (${providerId}, ${channelId}, 200000, now())`,
      );
    });
    for (const t of tenants) {
      await h.admin.insert(schema.organizationProviderAssignments).values({
        orgId: t.orgId,
        channelId,
        providerId,
        priority: 1,
        status: 'active',
      });
    }
    for (const [t, balance] of [
      [A, 10000],
      [P, 10000],
      [L, 30],
      [F, 10000],
    ] as const) {
      await h.admin.execute(
        sql`INSERT INTO wallets (org_id, balance_paise) VALUES (${t.orgId}, ${balance})`,
      );
    }
    await h.admin.execute(
      sql`INSERT INTO credit_accounts (org_id, credit_limit_paise) VALUES (${C.orgId}, 10000)`,
    );
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`UPDATE wallets SET status = 'frozen' WHERE org_id = ${F.orgId}`);
    });

    requester = await platformUser('req', PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
    approver = await platformUser('apr', PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
    approverId = users[users.length - 1]!;
    approver2 = await platformUser('apr2', PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
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
      name: `p76c-${hex(3)}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      scopes: perms.map((x) => x.key),
      createdBy: A.userId,
    });
    apiKey = `${prefix}.${secret}`;
  }, 240_000);

  afterEach(() => {
    threshold(null);
  });

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
          'billing_unknown_resolutions',
          'usage_ledger',
          'pricing_evaluations',
          'message_attempt_billing',
          'customer_pricing_assignments',
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

  /** The dual-control threshold the service reads (BILLING_DUAL_CONTROL_THRESHOLD_PAISE). */
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
    const email = `p76c-${label}-${hex(5)}@example.test`;
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

  interface Planted {
    id: string;
    attempt: string;
    earlier: string | null;
  }

  /**
   * An enforced message as 7.5 settlement leaves an unknown outcome: its unknown attempt
   * (with or without a provider receipt), its evaluations rated by app_rate_message, and —
   * prepaid — its reservation posted and released. Under charge_per_attempt an earlier
   * failed attempt can be planted, recorded as reaching the provider or not.
   */
  async function plant(
    t: TenantFixture,
    o: {
      evidenced?: boolean;
      perAttempt?: boolean;
      earlier?: 'reached' | 'not_reached';
      status?: string;
      postpaid?: boolean;
    } = {},
  ): Promise<Planted> {
    const status = o.status ?? 'outcome_unknown';
    const contact = uuidv7();
    const id = uuidv7();
    const earlier = o.earlier ? uuidv7() : null;
    const attempt = uuidv7();
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
                '+12025550144', ${`p76c-${hex(3)}`}, now(), 1, 'message', true,
                ${o.postpaid ? 'postpaid' : 'prepaid'}::billing_mode,
                ${o.perAttempt ? 'charge_per_attempt' : 'charge_per_logical_message'}::billing_policy)`);
      if (earlier) {
        await tx.execute(sql`
          INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number,
                                        fencing_epoch, claim_token, status)
          VALUES (${earlier}, ${id}, ${t.orgId}, ${providerId}, ${channelId}, 1, 1, ${uuidv7()}, 'failed')`);
        await tx.execute(sql`
          INSERT INTO message_attempt_billing (attempt_id, message_id, org_id, reached_provider)
          VALUES (${earlier}, ${id}, ${t.orgId}, ${o.earlier === 'reached'})`);
      }
      await tx.execute(sql`
        INSERT INTO message_attempts (id, message_id, org_id, provider_id, channel_id, attempt_number,
                                      fencing_epoch, claim_token, status, delivery_status, delivered_at)
        VALUES (${attempt}, ${id}, ${t.orgId}, ${providerId}, ${channelId}, ${earlier ? 2 : 1}, 1, ${uuidv7()},
                ${status === 'accepted' ? 'accepted' : 'outcome_unknown'}::message_attempt_status,
                ${o.evidenced ? 'delivered' : 'pending'}::message_delivery_status,
                ${o.evidenced ? new Date().toISOString() : null}::timestamptz)`);
    });
    await h.admin.execute(
      sql`SELECT * FROM app_rate_message(${t.orgId}, ${id}, NULL, 1, true, false)`,
    );
    for (const a of [earlier, attempt]) {
      if (a)
        await h.admin.execute(
          sql`SELECT * FROM app_rate_message(${t.orgId}, ${id}, ${a}, 1, ${!!o.perAttempt}, true)`,
        );
    }
    // L cannot cover a reservation and F is frozen: neither holds one.
    if (!o.postpaid && t !== F && t !== L) {
      await h.admin.execute(sql`
        SELECT * FROM app_ledger_post(${t.orgId}, 'reservation', ${id}, ${o.perAttempt ? 60 : 50},
          'wallet', ${id}, NULL, 'p76c', NULL)`);
      await h.admin.execute(sql`
        SELECT * FROM app_ledger_post(${t.orgId}, 'reservation_release', ${id}, NULL,
          'wallet', ${id}, NULL, 'p76c', NULL)`);
    }
    return { id, attempt, earlier };
  }

  const resolve = (
    token: string,
    messageId: string,
    body: Record<string, unknown>,
    key: string | null = randomUUID(),
  ) => {
    const r = request(h.app.getHttpServer())
      .post(url(`/platform/billing/unknown-outcomes/${messageId}/resolutions`))
      .set('Authorization', `Bearer ${token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const charge = (token: string, messageId: string) =>
    resolve(token, messageId, { action: 'charge', reason: 'operator reconciliation' });
  const writeOff = (token: string, messageId: string) =>
    resolve(token, messageId, { action: 'write_off', reason: 'goodwill' });
  const approve = (token: string, id: string, amount: number, key = randomUUID()) =>
    request(h.app.getHttpServer())
      .post(url(`/platform/billing/resolutions/${id}/approve`))
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ expectedAmountPaise: amount });
  const reject = (token: string, id: string, key = randomUUID()) =>
    request(h.app.getHttpServer())
      .post(url(`/platform/billing/resolutions/${id}/reject`))
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ reason: 'not justified' });
  const getResolution = (token: string, id: string) =>
    request(h.app.getHttpServer())
      .get(url(`/platform/billing/resolutions/${id}`))
      .set('Authorization', `Bearer ${token}`);

  /** The message's ledger facts as `type@anchor:amount` (anchor m = message, 1/2 = attempt). */
  async function facts(m: Planted): Promise<string[]> {
    const { rows } = await h.admin.execute<{
      entry_type: string;
      anchor_id: string;
      amount_paise: string;
    }>(
      sql`SELECT entry_type, anchor_id, amount_paise FROM usage_ledger WHERE message_id = ${m.id} ORDER BY occurred_at, id`,
    );
    const anchor = (a: string) => (a === m.id ? 'm' : a === m.earlier ? '1' : 'u');
    return rows.map((r) => `${r.entry_type}@${anchor(r.anchor_id)}:${r.amount_paise}`);
  }

  async function wallet(t: TenantFixture) {
    const { rows } = await h.admin.execute<{ balance_paise: string; reserved_paise: string }>(
      sql`SELECT balance_paise, reserved_paise FROM wallets WHERE org_id = ${t.orgId}`,
    );
    return { balance: Number(rows[0]!.balance_paise), reserved: Number(rows[0]!.reserved_paise) };
  }

  async function registerItem(t: TenantFixture, messageId: string) {
    const res = await request(h.app.getHttpServer())
      .get(url(`/platform/billing/unknown-outcomes?orgId=${t.orgId}&limit=100`))
      .set('Authorization', `Bearer ${requester}`)
      .expect(200);
    return (res.body.data as Array<Record<string, unknown>>).find((i) => i.messageId === messageId);
  }

  async function audits(resourceId: string): Promise<string[]> {
    const { rows } = await h.admin.execute<{ action: string }>(
      sql`SELECT action FROM audit_logs WHERE resource_id = ${resourceId} ORDER BY occurred_at, id`,
    );
    return rows.map((r) => r.action);
  }

  async function resolutionsOf(messageId: string): Promise<number> {
    const { rows } = await h.admin.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM billing_unknown_resolutions WHERE message_id = ${messageId}`,
    );
    return Number(rows[0]!.n);
  }

  async function whatsappOpenGauge(): Promise<number> {
    await request(h.app.getHttpServer())
      .get(url('/platform/billing/unknown-outcomes?limit=1'))
      .set('Authorization', `Bearer ${requester}`)
      .expect(200);
    const gauge = await metrics.billingOutcomeUnknownOpen.get();
    return gauge.values.find((v) => v.labels.channel === 'whatsapp')?.value ?? 0;
  }

  // --- 1–2. dual control and the charge ------------------------------------------------------

  it('threshold unset: an evidenced charge waits; the requester can neither approve nor reject; a wrong amount is stale; a second user charges E_m and the provider cost without touching the reservation', async () => {
    const m = await plant(A, { evidenced: true });
    const before = await wallet(A);
    const created = await charge(requester, m.id).expect(201);
    const r = created.body.data;
    expect(r).toMatchObject({
      messageId: m.id,
      orgId: A.orgId,
      attemptId: m.attempt,
      action: 'charge',
      status: 'pending',
      billingPolicy: 'charge_per_logical_message',
      customerAmountPaise: 50,
      providerCostPaise: 20,
      evidence: 'evidenced',
      postsProviderCost: true,
      dualControl: true,
      thresholdPaise: null,
      approvedBy: null,
      executedAt: null,
    });
    expect(await registerItem(A, m.id)).toMatchObject({ status: 'pending_approval' });
    expect(await facts(m)).toEqual(['reservation@m:50', 'reservation_release@m:50']);

    for (const res of [await approve(requester, r.id, 50), await reject(requester, r.id)]) {
      expect([res.status, res.body.error?.code]).toEqual([
        403,
        ERROR_CODES.BILLING_RESOLUTION_SELF_APPROVAL,
      ]);
    }
    const stale = await approve(approver, r.id, 49);
    expect([stale.status, stale.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_RESOLUTION_STALE,
    ]);
    expect(JSON.stringify(stale.body)).not.toMatch(/\b50\b/);

    const approved = await approve(approver, r.id, 50).expect(200);
    expect(approved.body.data).toMatchObject({
      status: 'executed',
      approvedBy: approverId,
      chargedPaise: 50,
      providerCostPostedPaise: 20,
    });
    expect(await facts(m)).toEqual([
      'reservation@m:50',
      'reservation_release@m:50',
      'customer_charge@m:50',
      'provider_cost@u:20',
    ]);
    expect(await wallet(A)).toEqual({ balance: before.balance - 50, reserved: before.reserved });
    const note = await h.admin.execute<{ reference_note: string }>(
      sql`SELECT reference_note FROM usage_ledger WHERE message_id = ${m.id} AND entry_type = 'customer_charge'`,
    );
    expect(note.rows[0]!.reference_note).toBe('outcome_unknown_resolved');
    expect(await registerItem(A, m.id)).toMatchObject({ status: 'charged' });
    expect(await audits(r.id)).toEqual([
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_REQUESTED,
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_APPROVED,
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_CHARGED,
    ]);

    // Single resolution: no further request, no second approval.
    const again = await charge(requester, m.id);
    expect([again.status, again.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_RESOLUTION_CONFLICT,
    ]);
    const twice = await approve(approver2, r.id, 50);
    expect([twice.status, twice.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_RESOLUTION_CONFLICT,
    ]);
  });

  it('an unevidenced charge waits for a second approver even under a high threshold, and posts no provider cost (charged_without_cost)', async () => {
    threshold(100_000);
    const m = await plant(A);
    const r = (await charge(requester, m.id).expect(201)).body.data;
    expect(r).toMatchObject({
      status: 'pending',
      dualControl: true,
      evidence: 'unevidenced',
      postsProviderCost: false,
      thresholdPaise: 100_000,
    });
    const done = await approve(approver, r.id, 50).expect(200);
    expect(done.body.data).toMatchObject({ chargedPaise: 50, providerCostPostedPaise: 0 });
    expect(await facts(m)).toEqual([
      'reservation@m:50',
      'reservation_release@m:50',
      'customer_charge@m:50',
    ]);
    expect(await registerItem(A, m.id)).toMatchObject({ status: 'charged_without_cost' });
  });

  it('threshold set: an evidenced charge at or below it executes on request; above it, it waits', async () => {
    threshold(50);
    const m = await plant(A, { evidenced: true });
    const r = (await charge(requester, m.id).expect(201)).body.data;
    expect(r).toMatchObject({
      status: 'executed',
      dualControl: false,
      approvedBy: null,
      chargedPaise: 50,
      providerCostPostedPaise: 20,
    });
    expect(await audits(r.id)).toEqual([
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_REQUESTED,
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_CHARGED,
    ]);
    threshold(49);
    const above = await plant(A, { evidenced: true });
    expect((await charge(requester, above.id).expect(201)).body.data).toMatchObject({
      status: 'pending',
      dualControl: true,
    });
    expect(await facts(above)).toEqual(['reservation@m:50', 'reservation_release@m:50']);
  });

  // --- 3. write-off, rejection, the register ------------------------------------------------------

  it('write-off: unset threshold waits; approval posts nothing; the item is written_off and leaves the open count (pending stays open)', async () => {
    const m = await plant(A);
    const open0 = await whatsappOpenGauge();
    const r = (await writeOff(requester, m.id).expect(201)).body.data;
    expect(r).toMatchObject({ action: 'write_off', status: 'pending', dualControl: true });
    expect(await whatsappOpenGauge()).toBe(open0); // C-2: pending is still open
    const done = await approve(approver, r.id, 50).expect(200);
    expect(done.body.data).toMatchObject({
      status: 'executed',
      chargedPaise: 0,
      providerCostPostedPaise: 0,
    });
    expect(await facts(m)).toEqual(['reservation@m:50', 'reservation_release@m:50']);
    expect(await registerItem(A, m.id)).toMatchObject({ status: 'written_off' });
    expect(await whatsappOpenGauge()).toBe(open0 - 1);
    expect(await audits(r.id)).toEqual([
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_REQUESTED,
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_APPROVED,
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_WRITTEN_OFF,
    ]);

    threshold(1000);
    const small = await plant(A);
    expect((await writeOff(requester, small.id).expect(201)).body.data).toMatchObject({
      status: 'executed',
      dualControl: false,
    });
  });

  it('reject: a different user closes the request; nothing is posted; the item is open again and can be re-requested', async () => {
    const m = await plant(A);
    const r = (await charge(requester, m.id).expect(201)).body.data;
    const rejected = await reject(approver, r.id).expect(200);
    expect(rejected.body.data).toMatchObject({
      status: 'rejected',
      rejectedBy: approverId,
      rejectionReason: 'not justified',
    });
    expect(await registerItem(A, m.id)).toMatchObject({ status: 'open' });
    expect(await facts(m)).toEqual(['reservation@m:50', 'reservation_release@m:50']);
    expect(await audits(r.id)).toEqual([
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_REQUESTED,
      AUDIT_ACTIONS.BILLING_OUTCOME_UNKNOWN_RESOLUTION_REJECTED,
    ]);
    await charge(requester, m.id).expect(201);
    expect(await resolutionsOf(m.id)).toBe(2);
  });

  // --- 2 (D-76c-1). charge_per_attempt ----------------------------------------------------------

  it('charge_per_attempt: charges the unknown attempt and every earlier attempt that reached the provider; the register exposure is the same total', async () => {
    const m = await plant(P, { perAttempt: true, earlier: 'reached', evidenced: true });
    expect(await registerItem(P, m.id)).toMatchObject({
      estimatedExposure: { customerPaise: 120, providerCostPaise: 20 },
    });
    const before = await wallet(P);
    const r = (await charge(requester, m.id).expect(201)).body.data;
    expect(r).toMatchObject({ customerAmountPaise: 120, status: 'pending' });
    await approve(approver, r.id, 120).expect(200);
    expect(await facts(m)).toEqual([
      'reservation@m:60',
      'reservation_release@m:60',
      'customer_charge@1:60',
      'customer_charge@u:60',
      'provider_cost@u:20',
    ]);
    expect(await wallet(P)).toEqual({ balance: before.balance - 120, reserved: before.reserved });
    expect(await registerItem(P, m.id)).toMatchObject({ status: 'charged' });

    // An earlier attempt that did not reach the provider is not charged.
    const n = await plant(P, { perAttempt: true, earlier: 'not_reached' });
    expect(await registerItem(P, n.id)).toMatchObject({
      estimatedExposure: { customerPaise: 60, providerCostPaise: 20 },
    });
    const s = (await charge(requester, n.id).expect(201)).body.data;
    expect(s).toMatchObject({ customerAmountPaise: 60 });
    await approve(approver, s.id, 60).expect(200);
    expect(await facts(n)).toEqual([
      'reservation@m:60',
      'reservation_release@m:60',
      'customer_charge@u:60',
    ]);
  });

  it('a credit account: used grows by the charge, reserved does not', async () => {
    threshold(1000);
    const m = await plant(C, { evidenced: true, postpaid: true });
    const read = async () =>
      (
        await h.admin.execute<{ used_paise: string; reserved_paise: string }>(
          sql`SELECT used_paise, reserved_paise FROM credit_accounts WHERE org_id = ${C.orgId}`,
        )
      ).rows[0]!;
    const before = await read();
    await charge(requester, m.id).expect(201);
    const after = await read();
    expect(Number(after.used_paise)).toBe(Number(before.used_paise) + 50);
    expect(after.reserved_paise).toBe(before.reserved_paise);
  });

  // --- 4. refusals ------------------------------------------------------------------------------

  it('insufficient funds: on request nothing is recorded (402); on approval the request stays pending with the refusal recorded, and succeeds once funded', async () => {
    threshold(1000);
    const m = await plant(L, { evidenced: true });
    const refused = await charge(requester, m.id);
    expect([refused.status, refused.body.error?.code]).toEqual([
      402,
      ERROR_CODES.BILLING_INSUFFICIENT_FUNDS,
    ]);
    expect(await resolutionsOf(m.id)).toBe(0);
    expect(await registerItem(L, m.id)).toMatchObject({ status: 'open' });

    threshold(null);
    const r = (await charge(requester, m.id).expect(201)).body.data;
    const short = await approve(approver, r.id, 50);
    expect([short.status, short.body.error?.code]).toEqual([
      402,
      ERROR_CODES.BILLING_INSUFFICIENT_FUNDS,
    ]);
    const kept = (await getResolution(requester, r.id).expect(200)).body.data;
    expect(kept).toMatchObject({
      status: 'pending',
      lastRefusal: 'insufficient_funds',
      approvedBy: null,
    });
    expect(kept.lastRefusedAt).toEqual(expect.any(String));
    expect(await facts(m)).toEqual([]);

    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`UPDATE wallets SET balance_paise = 1000 WHERE org_id = ${L.orgId}`);
    });
    await approve(approver, r.id, 50).expect(200);
  });

  it('a frozen account: 403 BILLING_ACCOUNT_FROZEN; the request stays pending with the refusal recorded', async () => {
    const m = await plant(F, { evidenced: true });
    const r = (await charge(requester, m.id).expect(201)).body.data;
    const frozen = await approve(approver, r.id, 50);
    expect([frozen.status, frozen.body.error?.code]).toEqual([
      403,
      ERROR_CODES.BILLING_ACCOUNT_FROZEN,
    ]);
    expect((await getResolution(approver, r.id).expect(200)).body.data).toMatchObject({
      status: 'pending',
      lastRefusal: 'account_frozen',
    });
    expect(await facts(m)).toEqual([]);
  });

  it('stale: a provider receipt arriving after the request makes the approval stale; nothing executes', async () => {
    const m = await plant(A);
    const r = (await charge(requester, m.id).expect(201)).body.data;
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(
        sql`UPDATE message_attempts SET delivery_status = 'delivered', delivered_at = now() WHERE id = ${m.attempt}`,
      );
    });
    const stale = await approve(approver, r.id, 50);
    expect([stale.status, stale.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_RESOLUTION_STALE,
    ]);
    expect(await facts(m)).toEqual(['reservation@m:50', 'reservation_release@m:50']);
    expect((await getResolution(requester, r.id).expect(200)).body.data.status).toBe('pending');
  });

  it('not resolvable: a confirmed message is 409; an unknown message or resolution 404; invalid bodies 400', async () => {
    const accepted = await plant(A, { status: 'accepted' });
    const res = await charge(requester, accepted.id);
    expect([res.status, res.body.error?.code]).toEqual([
      409,
      ERROR_CODES.BILLING_RESOLUTION_CONFLICT,
    ]);
    expect((await charge(requester, uuidv7())).status).toBe(404);
    expect((await approve(approver, uuidv7(), 1)).status).toBe(404);
    expect((await reject(approver, uuidv7())).status).toBe(404);
    const m = await plant(A);
    expect((await resolve(requester, m.id, { action: 'refund', reason: 'x' })).status).toBe(400);
    expect((await resolve(requester, m.id, { action: 'charge', reason: '' })).status).toBe(400);
    expect((await resolve(requester, m.id, { action: 'charge' })).status).toBe(400);
    expect(await resolutionsOf(m.id)).toBe(0);
  });

  // --- 5. idempotency, concurrency, listing, access, metrics ------------------------------------------

  it('idempotency: a replay returns the original and executes nothing; a changed request is 422; no key is 400', async () => {
    threshold(1000);
    const m = await plant(A, { evidenced: true });
    const key = randomUUID();
    const body = { action: 'charge', reason: 'replayed' };
    const first = await resolve(requester, m.id, body, key).expect(201);
    const replay = await resolve(requester, m.id, body, key).expect(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await resolutionsOf(m.id)).toBe(1);
    expect((await facts(m)).filter((f) => f.startsWith('customer_charge'))).toHaveLength(1);
    expect(
      (await resolve(requester, m.id, { action: 'charge', reason: 'different' }, key)).status,
    ).toBe(422);
    const n = await plant(A);
    const none = await resolve(requester, n.id, body, null);
    expect([none.status, none.body.error?.code]).toEqual([
      400,
      ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    ]);
    expect(await resolutionsOf(n.id)).toBe(0);
  });

  it('two approvers at once: exactly one approval executes, and one charge is posted', async () => {
    const m = await plant(A, { evidenced: true });
    const r = (await charge(requester, m.id).expect(201)).body.data;
    const results = await Promise.all([approve(approver, r.id, 50), approve(approver2, r.id, 50)]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await facts(m)).filter((f) => f.startsWith('customer_charge'))).toEqual([
      'customer_charge@m:50',
    ]);
  });

  it('lists resolutions newest first with filters and a cursor, and reads one', async () => {
    const list = await request(h.app.getHttpServer())
      .get(url(`/platform/billing/resolutions?orgId=${A.orgId}&limit=100`))
      .set('Authorization', `Bearer ${requester}`)
      .expect(200);
    const ids = (list.body.data as Array<{ id: string; orgId: string }>).map((x) => x.id);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect([...ids].sort().reverse()).toEqual(ids);
    expect((list.body.data as Array<{ orgId: string }>).every((x) => x.orgId === A.orgId)).toBe(
      true,
    );
    const pending = await request(h.app.getHttpServer())
      .get(url(`/platform/billing/resolutions?orgId=${A.orgId}&status=pending&limit=100`))
      .set('Authorization', `Bearer ${requester}`)
      .expect(200);
    expect(
      (pending.body.data as Array<{ status: string }>).every((x) => x.status === 'pending'),
    ).toBe(true);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      const res = await request(h.app.getHttpServer())
        .get(
          url(
            `/platform/billing/resolutions?orgId=${A.orgId}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          ),
        )
        .set('Authorization', `Bearer ${requester}`)
        .expect(200);
      seen.push(...(res.body.data as Array<{ id: string }>).map((x) => x.id));
      cursor = res.body.page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(ids);
    await getResolution(requester, ids[0]!).expect(200);
    await request(h.app.getHttpServer())
      .get(url('/platform/billing/resolutions?status=done'))
      .set('Authorization', `Bearer ${requester}`)
      .expect(400);
  });

  it('access: platform support, a tenant administrator and an API key are refused; no credential is 401', async () => {
    const m = await plant(A);
    for (const [token, org] of [
      [support, undefined],
      [tenantAdmin, undefined],
      [tenantAdmin, A.orgId],
      [apiKey, A.orgId],
    ] as const) {
      const r = request(h.app.getHttpServer())
        .post(url(`/platform/billing/unknown-outcomes/${m.id}/resolutions`))
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID());
      const res = await (org ? r.set('X-Acc-Organization', org) : r).send({
        action: 'write_off',
        reason: 'x',
      });
      expect(res.status).toBe(403);
      const list = request(h.app.getHttpServer())
        .get(url('/platform/billing/resolutions'))
        .set('Authorization', `Bearer ${token}`);
      expect((await (org ? list.set('X-Acc-Organization', org) : list)).status).toBe(403);
    }
    expect(await resolutionsOf(m.id)).toBe(0);
    await request(h.app.getHttpServer())
      .post(url(`/platform/billing/unknown-outcomes/${m.id}/resolutions`))
      .set('Idempotency-Key', randomUUID())
      .send({ action: 'write_off', reason: 'x' })
      .expect(401);
  });

  it('counts resolutions by action and outcome after commit', async () => {
    const counter = await metrics.billingOutcomeUnknownResolutions.get();
    const value = (action: string, outcome: string) =>
      counter.values.find((v) => v.labels.action === action && v.labels.outcome === outcome)
        ?.value ?? 0;
    expect(value('charge', 'pending')).toBeGreaterThanOrEqual(5);
    expect(value('charge', 'executed')).toBeGreaterThanOrEqual(5);
    expect(value('write_off', 'executed')).toBeGreaterThanOrEqual(2);
    expect(value('charge', 'rejected')).toBeGreaterThanOrEqual(1);
    expect(value('charge', 'refused')).toBeGreaterThanOrEqual(3);
  });
});
