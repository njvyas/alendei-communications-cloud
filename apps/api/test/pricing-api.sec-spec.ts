import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUDIT_ACTIONS, PLATFORM_ROLE_KEYS, isSecuritySensitiveAction } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  removeIdentities,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

/**
 * Phase 7 PR 7-2 — the platform pricing API (DECISIONS.md §1zi; Phase 7.2 handover, OD-P-1 to
 * OD-P-3).
 *
 * Proves: platform scope only (super admin manages; support reads; tenant administrators,
 * resellers and API keys are refused); signed-in users only; every mutation audited as
 * security-sensitive; drafts editable, activation freezes; effective dates never in the past;
 * natural idempotency (409 on retry); validation of rules and rates; and that no route rates a
 * transaction or exposes pricing evaluations.
 */
describe('Phase 7 PR 7-2 — platform pricing API', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenant: TenantFixture;
  const tokens: Record<string, string> = {};
  const users: string[] = [];
  const plans: string[] = [];
  let apiKey: string;
  let apiKeyId: string;
  let channels: Record<string, string> = {};
  let smsProvider: string;
  let waProvider: string;

  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => uuidv7().replace(/-/g, '').slice(-10);
  const call = (method: 'get' | 'post' | 'put', credential: string | null, path: string) => {
    let r = request(h.app.getHttpServer())[method](url(path));
    if (credential) r = r.set('authorization', `Bearer ${credential}`);
    return r;
  };

  async function platformUser(label: string, roleKey: string) {
    const email = `p72-${label}-${suffix()}@example.test`;
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
        scopeType: roleKey === PLATFORM_ROLE_KEYS.RESELLER_ADMIN ? 'reseller' : 'platform',
        scopeId: roleKey === PLATFORM_ROLE_KEYS.RESELLER_ADMIN ? tenant.resellerId : null,
      });
    });
    return email;
  }

  async function login(email: string) {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  const newPlan = async () => {
    const res = await call('post', tokens.platform!, '/platform/pricing/plans')
      .send({ name: `p72-plan-${suffix()}`, description: 'test' })
      .expect(201);
    plans.push(res.body.data.id);
    return res.body.data as { id: string };
  };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    tenant = await createTenant(h.admin, 'p72api', credentials);
    tokens.platform = await login(
      await platformUser('platform', PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
    );
    tokens.support = await login(await platformUser('support', PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT));
    tokens.reseller = await login(
      await platformUser('reseller', PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
    );
    tokens.orgAdmin = await login(tenant.email);
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const secret = `s${randomBytes(16).toString('hex')}`;
    const [key] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        name: `p72-${suffix()}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(secret),
        scopes: ['contacts.read'],
      })
      .returning({ id: schema.apiKeys.id });
    apiKey = `${prefix}.${secret}`;
    apiKeyId = key!.id;
    const rows = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels);
    channels = Object.fromEntries(rows.map((r) => [r.code, r.id]));
    const mk = async (channel: string) =>
      (
        await h.admin
          .insert(schema.providers)
          .values({
            channelId: channels[channel]!,
            name: `p72-${channel}-${suffix()}`,
            adapterKey: 'simulator',
          })
          .returning({ id: schema.providers.id })
      )[0]!.id;
    smsProvider = await mk('sms');
    waProvider = await mk('whatsapp');
  }, 180_000);

  afterAll(async () => {
    await h.clearRateLimits();
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      if (plans.length > 0) {
        const list = sql.join(
          plans.map((p) => sql`${p}`),
          sql`, `,
        );
        await tx.execute(sql`DELETE FROM customer_pricing_assignments WHERE plan_id IN (${list})`);
        await tx.execute(
          sql`DELETE FROM pricing_rules WHERE plan_version_id IN (SELECT id FROM pricing_plan_versions WHERE plan_id IN (${list}))`,
        );
        await tx.execute(sql`DELETE FROM pricing_plan_versions WHERE plan_id IN (${list})`);
        await tx.execute(sql`DELETE FROM pricing_plans WHERE id IN (${list})`);
      }
      await tx.execute(
        sql`DELETE FROM provider_cost_rates WHERE provider_id IN (${smsProvider}, ${waProvider})`,
      );
    });
    await h.admin
      .delete(schema.providers)
      .where(inArray(schema.providers.id, [smsProvider, waProvider]));
    await purgeAudit(
      h.admin,
      sql`resource_type IN ('PricingPlan', 'PricingPlanVersion', 'ProviderCostRate', 'PricingAssignment', 'Pricing')`,
    );
    await purgeAudit(h.admin, sql`actor_api_key_id = ${apiKeyId}`);
    await h.admin.execute(sql`DELETE FROM api_keys WHERE id = ${apiKeyId}`);
    await removeIdentities(h.admin, users);
    await destroyTenant(h.admin, tenant);
    await h.close();
  }, 120_000);

  it('the full flow: plan → draft version → rules → activation → cost rate → assignment, each audited as security-sensitive', async () => {
    const p = await newPlan();
    await call('post', tokens.platform!, '/platform/pricing/plans')
      .send({
        name: (await call('get', tokens.platform!, `/platform/pricing/plans/${p.id}`)).body.data
          .name,
      })
      .expect(409);
    const v = (
      await call('post', tokens.platform!, `/platform/pricing/plans/${p.id}/versions`).expect(201)
    ).body.data;
    expect([v.versionNumber, v.status, v.effectiveFrom]).toEqual([1, 'draft', null]);
    const rules = await call('put', tokens.platform!, `/platform/pricing/versions/${v.id}/rules`)
      .send({
        rules: [
          { channelId: channels.sms, unitPriceE4: 1150 },
          { channelId: channels.sms, providerId: smsProvider, unitPriceE4: 1300 },
          { channelId: channels.whatsapp, unitPriceE4: 7800 },
        ],
      })
      .expect(200);
    expect(
      rules.body.data.rules
        .map((r: { channelCode: string; unit: string; unitPriceE4: number }) => [
          r.channelCode,
          r.unit,
          r.unitPriceE4,
        ])
        .sort(),
    ).toEqual([
      ['sms', 'sms_segment', 1150],
      ['sms', 'sms_segment', 1300],
      ['whatsapp', 'message', 7800],
    ]);
    const active = (
      await call('post', tokens.platform!, `/platform/pricing/versions/${v.id}/activate`)
        .send({})
        .expect(200)
    ).body.data;
    expect(active.status).toBe('active');
    expect(Date.parse(active.effectiveFrom)).toBeGreaterThanOrEqual(Date.parse(active.activatedAt));
    await call('post', tokens.platform!, `/platform/pricing/versions/${v.id}/activate`)
      .send({})
      .expect(409);
    await call('put', tokens.platform!, `/platform/pricing/versions/${v.id}/rules`)
      .send({ rules: [] })
      .expect(409);
    const rate = (
      await call('post', tokens.platform!, '/platform/pricing/provider-cost-rates')
        .send({ providerId: smsProvider, unitCostE4: 900 })
        .expect(201)
    ).body.data;
    expect([rate.channelCode, rate.unit, rate.unitCostE4]).toEqual(['sms', 'sms_segment', 900]);
    const assignment = (
      await call('post', tokens.platform!, '/platform/pricing/assignments')
        .send({ orgId: tenant.orgId, planId: p.id })
        .expect(201)
    ).body.data;
    expect(assignment.orgId).toBe(tenant.orgId);
    const audit = await h.admin
      .select({ action: schema.auditLogs.action, scopeType: schema.auditLogs.scopeType })
      .from(schema.auditLogs)
      .where(inArray(schema.auditLogs.resourceId, [p.id, v.id, rate.id, assignment.id]));
    const actions = audit.map((a) => a.action).sort();
    expect(actions).toEqual(
      [
        AUDIT_ACTIONS.PRICING_PLAN_CREATED,
        AUDIT_ACTIONS.PRICING_VERSION_CREATED,
        AUDIT_ACTIONS.PRICING_RULES_REPLACED,
        AUDIT_ACTIONS.PRICING_VERSION_ACTIVATED,
        AUDIT_ACTIONS.PRICING_PROVIDER_COST_RATE_CREATED,
        AUDIT_ACTIONS.PRICING_ASSIGNMENT_CREATED,
      ].sort(),
    );
    expect(audit.every((a) => a.scopeType === 'platform')).toBe(true);
    expect(actions.every(isSecuritySensitiveAction)).toBe(true);
    // Reads.
    const detail = (
      await call('get', tokens.platform!, `/platform/pricing/plans/${p.id}`).expect(200)
    ).body.data;
    expect(detail.versions.map((x: { status: string }) => x.status)).toEqual(['active']);
    await call('get', tokens.platform!, `/platform/pricing/versions/${v.id}`).expect(200);
    const listed = (
      await call(
        'get',
        tokens.platform!,
        `/platform/pricing/assignments?orgId=${tenant.orgId}`,
      ).expect(200)
    ).body.data;
    expect(listed.map((a: { id: string }) => a.id)).toContain(assignment.id);
    const costs = (
      await call(
        'get',
        tokens.platform!,
        `/platform/pricing/provider-cost-rates?providerId=${smsProvider}`,
      ).expect(200)
    ).body.data;
    expect(costs.map((c: { id: string }) => c.id)).toContain(rate.id);
  });

  it('validation: rates are integers in range; duplicate (channel, provider); provider not on the channel; unpriced channel; empty activation; past dates', async () => {
    const p = await newPlan();
    const v = (
      await call('post', tokens.platform!, `/platform/pricing/plans/${p.id}/versions`).expect(201)
    ).body.data;
    // One draft per plan: a retried create is refused and creates nothing.
    await call('post', tokens.platform!, `/platform/pricing/plans/${p.id}/versions`).expect(409);
    const put = (rules: unknown[]) =>
      call('put', tokens.platform!, `/platform/pricing/versions/${v.id}/rules`).send({ rules });
    await put([{ channelId: channels.sms, unitPriceE4: 1.5 }]).expect(400);
    await put([{ channelId: channels.sms, unitPriceE4: -1 }]).expect(400);
    await put([{ channelId: channels.sms, unitPriceE4: 1_000_000_000_001 }]).expect(400);
    await put([
      { channelId: channels.sms, unitPriceE4: 1 },
      { channelId: channels.sms, unitPriceE4: 2 },
    ]).expect(400);
    await put([{ channelId: channels.whatsapp, providerId: smsProvider, unitPriceE4: 1 }]).expect(
      400,
    );
    if (channels.email) await put([{ channelId: channels.email, unitPriceE4: 1 }]).expect(400);
    await call('post', tokens.platform!, `/platform/pricing/versions/${v.id}/activate`)
      .send({})
      .expect(400); // no rules
    await put([{ channelId: channels.sms, unitPriceE4: 1 }]).expect(200);
    const past = new Date(Date.now() - 60_000).toISOString();
    await call('post', tokens.platform!, `/platform/pricing/versions/${v.id}/activate`)
      .send({ effectiveFrom: past })
      .expect(400);
    await call('post', tokens.platform!, '/platform/pricing/provider-cost-rates')
      .send({ providerId: smsProvider, unitCostE4: 1, effectiveFrom: past })
      .expect(400);
    await call('post', tokens.platform!, '/platform/pricing/assignments')
      .send({ planId: p.id, effectiveFrom: past })
      .expect(400);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const a = (
      await call('post', tokens.platform!, '/platform/pricing/assignments')
        .send({ planId: p.id, effectiveFrom: future })
        .expect(201)
    ).body.data;
    expect(a.orgId).toBeNull();
    await call('post', tokens.platform!, '/platform/pricing/assignments')
      .send({ planId: p.id, effectiveFrom: future })
      .expect(409); // retry
    await call('post', tokens.platform!, '/platform/pricing/assignments')
      .send({ orgId: uuidv7(), planId: p.id })
      .expect(404);
    await call('post', tokens.platform!, '/platform/pricing/provider-cost-rates')
      .send({ providerId: uuidv7(), unitCostE4: 1 })
      .expect(404);
  });

  it('platform scope only: support reads but cannot manage; tenant administrators, resellers and API keys are refused everywhere', async () => {
    const p = await newPlan();
    const reads = [
      '/platform/pricing/plans',
      `/platform/pricing/plans/${p.id}`,
      '/platform/pricing/provider-cost-rates',
      '/platform/pricing/assignments',
    ];
    for (const path of reads) await call('get', tokens.support!, path).expect(200);
    await call('post', tokens.support!, '/platform/pricing/plans')
      .send({ name: `p72-support-${suffix()}` })
      .expect(403);
    await call('post', tokens.support!, `/platform/pricing/plans/${p.id}/versions`).expect(403);
    for (const who of ['orgAdmin', 'reseller'] as const) {
      for (const path of reads)
        expect([who, path, (await call('get', tokens[who]!, path)).status]).toEqual([
          who,
          path,
          403,
        ]);
      expect(
        (
          await call('post', tokens[who]!, '/platform/pricing/plans').send({
            name: `p72-x-${suffix()}`,
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('post', tokens[who]!, '/platform/pricing/assignments').send({ planId: p.id }))
          .status,
      ).toBe(403);
    }
    for (const path of reads)
      expect([401, 403]).toContain((await call('get', apiKey, path)).status);
    expect([401, 403]).toContain(
      (await call('post', apiKey, '/platform/pricing/plans').send({ name: `p72-k-${suffix()}` }))
        .status,
    );
    for (const path of reads) expect((await call('get', null, path)).status).toBe(401);
  });

  it('no route rates a transaction or exposes pricing evaluations', () => {
    const document = JSON.parse(
      readFileSync(join(__dirname, '..', 'openapi', 'openapi.v1.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, unknown>> };
    const pricing = Object.entries(document.paths)
      .filter(([path]) => path.includes('/platform/pricing'))
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
      .sort();
    expect(pricing).toHaveLength(11);
    expect(pricing.join('\n')).not.toMatch(/evaluation|rate-message|rating|quote|ledger|charge/);
    expect(
      Object.keys(document.paths).some(
        (p) => /pricing|evaluation/.test(p) && !p.includes('/platform/pricing'),
      ),
    ).toBe(false);
  });
});
