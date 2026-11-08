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
 * validation of rules and rates; and that no route rates a transaction or exposes pricing
 * evaluations.
 *
 * Idempotency (owner correction to PR #90, 08-Nov-2026): every creating POST requires an
 * `Idempotency-Key` and runs through the repository mechanism in its platform namespace. The
 * same key and request replay the original response and create nothing — including the three
 * defects the review found (an assignment or cost rate without `effectiveFrom`, and a draft
 * version retried after activation); the same key with a different request is 422; concurrent
 * identical requests create exactly one record.
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
  const newKey = () => `p72-${randomBytes(12).toString('hex')}`;
  /**
   * A request. Every POST carries a fresh `Idempotency-Key` unless `key` names one (a retry) or
   * is `null` (none at all).
   */
  const call = (
    method: 'get' | 'post' | 'put',
    credential: string | null,
    path: string,
    key?: string | null,
  ) => {
    let r = request(h.app.getHttpServer())[method](url(path));
    if (credential) r = r.set('authorization', `Bearer ${credential}`);
    const k = key === undefined ? (method === 'post' ? newKey() : null) : key;
    if (k) r = r.set('idempotency-key', k);
    return r;
  };
  const count = async (query: ReturnType<typeof sql>) =>
    Number((await h.admin.execute<{ n: string }>(query)).rows[0]!.n);

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
    tokens.platform2 = await login(
      await platformUser('platform2', PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
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
    await h.admin.execute(
      sql`DELETE FROM idempotency_keys WHERE org_id IS NULL AND actor_user_id IN (${sql.join(
        users.map((u) => sql`${u}`),
        sql`, `,
      )})`,
    );
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
    // One draft per plan: a new create (new key) while a draft exists is refused.
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
      .expect(409); // a new request (new key) for the same organization and effective time
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

  describe('idempotency (owner correction to PR #90)', () => {
    const assignmentsOf = (planId: string) =>
      count(
        sql`SELECT count(*)::text AS n FROM customer_pricing_assignments WHERE plan_id = ${planId}`,
      );
    const ratesOf = (providerId: string) =>
      count(
        sql`SELECT count(*)::text AS n FROM provider_cost_rates WHERE provider_id = ${providerId}`,
      );
    const versionsOf = (planId: string) =>
      count(sql`SELECT count(*)::text AS n FROM pricing_plan_versions WHERE plan_id = ${planId}`);
    const auditsOf = (resourceId: string, action: string) =>
      count(
        sql`SELECT count(*)::text AS n FROM audit_logs WHERE resource_id = ${resourceId} AND action = ${action}`,
      );
    /** Eight identical requests at once: one record, every success the same answer. */
    async function concurrently(send: () => request.Test, status: number) {
      const responses = await Promise.all(Array.from({ length: 8 }, () => send()));
      const ok = responses.filter((r) => r.status === status);
      const other = responses.filter((r) => r.status !== status);
      // Only the documented, retryable in-progress answer may stand in for a replay.
      for (const r of other) {
        expect([r.status, r.body.error?.code]).toEqual([409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS']);
      }
      expect(ok.length).toBeGreaterThan(0);
      expect(new Set(ok.map((r) => r.body.data.id)).size).toBe(1);
      return ok[0]!.body.data as { id: string };
    }

    it('every creating POST requires a key: 400 IDEMPOTENCY_KEY_REQUIRED and nothing is created', async () => {
      const p = await newPlan();
      const name = `p72-nokey-${suffix()}`;
      const before = {
        rates: await ratesOf(waProvider),
        assignments: await assignmentsOf(p.id),
        versions: await versionsOf(p.id),
      };
      const refusals = [
        call('post', tokens.platform!, '/platform/pricing/plans', null).send({ name }),
        call('post', tokens.platform!, `/platform/pricing/plans/${p.id}/versions`, null),
        call('post', tokens.platform!, '/platform/pricing/provider-cost-rates', null).send({
          providerId: waProvider,
          unitCostE4: 1,
        }),
        call('post', tokens.platform!, '/platform/pricing/assignments', null).send({
          orgId: tenant.orgId,
          planId: p.id,
        }),
        call(
          'post',
          tokens.platform!,
          `/platform/pricing/versions/${uuidv7()}/activate`,
          null,
        ).send({}),
      ];
      for (const res of await Promise.all(refusals)) {
        expect([res.status, res.body.error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      }
      expect(
        await count(sql`SELECT count(*)::text AS n FROM pricing_plans WHERE name = ${name}`),
      ).toBe(0);
      expect({
        rates: await ratesOf(waProvider),
        assignments: await assignmentsOf(p.id),
        versions: await versionsOf(p.id),
      }).toEqual(before);
    });

    it('assignment without effectiveFrom (defect 1): a retry replays the original; a different request under the key is 422; 8 concurrent create one', async () => {
      const p = await newPlan();
      const other = await newPlan();
      const key = newKey();
      const body = { orgId: tenant.orgId, planId: p.id };
      const first = await call('post', tokens.platform!, '/platform/pricing/assignments', key)
        .send(body)
        .expect(201);
      await new Promise((r) => setTimeout(r, 25)); // a later database clock than the original
      const retry = await call('post', tokens.platform!, '/platform/pricing/assignments', key)
        .send(body)
        .expect(201);
      expect(retry.body).toEqual(first.body);
      expect(await assignmentsOf(p.id)).toBe(1);
      expect(await auditsOf(first.body.data.id, AUDIT_ACTIONS.PRICING_ASSIGNMENT_CREATED)).toBe(1);
      // Same key, different request: another plan, or another principal.
      const mismatch = await call('post', tokens.platform!, '/platform/pricing/assignments', key)
        .send({ orgId: tenant.orgId, planId: other.id })
        .expect(422);
      expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
      await call('post', tokens.platform2!, '/platform/pricing/assignments', key)
        .send(body)
        .expect(422);
      expect([await assignmentsOf(p.id), await assignmentsOf(other.id)]).toEqual([1, 0]);
      // Concurrency: one key, eight identical requests, one assignment.
      const concurrentKey = newKey();
      const created = await concurrently(
        () =>
          call('post', tokens.platform!, '/platform/pricing/assignments', concurrentKey).send({
            orgId: tenant.orgId,
            planId: other.id,
          }),
        201,
      );
      expect(await assignmentsOf(other.id)).toBe(1);
      expect(await auditsOf(created.id, AUDIT_ACTIONS.PRICING_ASSIGNMENT_CREATED)).toBe(1);
    });

    it('provider cost rate without effectiveFrom (defect 2): a retry replays the original; a different request under the key is 422; 8 concurrent create one', async () => {
      const key = newKey();
      const before = await ratesOf(waProvider);
      const body = { providerId: waProvider, unitCostE4: 4321 };
      const first = await call(
        'post',
        tokens.platform!,
        '/platform/pricing/provider-cost-rates',
        key,
      )
        .send(body)
        .expect(201);
      await new Promise((r) => setTimeout(r, 25));
      const retry = await call(
        'post',
        tokens.platform!,
        '/platform/pricing/provider-cost-rates',
        key,
      )
        .send(body)
        .expect(201);
      expect(retry.body).toEqual(first.body);
      expect(await ratesOf(waProvider)).toBe(before + 1);
      expect(
        await auditsOf(first.body.data.id, AUDIT_ACTIONS.PRICING_PROVIDER_COST_RATE_CREATED),
      ).toBe(1);
      const mismatch = await call(
        'post',
        tokens.platform!,
        '/platform/pricing/provider-cost-rates',
        key,
      )
        .send({ providerId: waProvider, unitCostE4: 4322 })
        .expect(422);
      expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
      expect(await ratesOf(waProvider)).toBe(before + 1);
      const concurrentKey = newKey();
      const created = await concurrently(
        () =>
          call(
            'post',
            tokens.platform!,
            '/platform/pricing/provider-cost-rates',
            concurrentKey,
          ).send({ providerId: waProvider, unitCostE4: 9999 }),
        201,
      );
      expect(await ratesOf(waProvider)).toBe(before + 2);
      expect(await auditsOf(created.id, AUDIT_ACTIONS.PRICING_PROVIDER_COST_RATE_CREATED)).toBe(1);
    });

    it('draft version retried after activation (defect 3): the retry replays the original draft and creates no version; 8 concurrent create one', async () => {
      const p = await newPlan();
      const key = newKey();
      const first = await call(
        'post',
        tokens.platform!,
        `/platform/pricing/plans/${p.id}/versions`,
        key,
      ).expect(201);
      const versionId = first.body.data.id as string;
      await call('put', tokens.platform!, `/platform/pricing/versions/${versionId}/rules`)
        .send({ rules: [{ channelId: channels.sms, unitPriceE4: 100 }] })
        .expect(200);
      await call('post', tokens.platform!, `/platform/pricing/versions/${versionId}/activate`)
        .send({})
        .expect(200);
      const retry = await call(
        'post',
        tokens.platform!,
        `/platform/pricing/plans/${p.id}/versions`,
        key,
      ).expect(201);
      expect(retry.body).toEqual(first.body); // the original answer, verbatim
      expect(await versionsOf(p.id)).toBe(1);
      expect(await auditsOf(versionId, AUDIT_ACTIONS.PRICING_VERSION_CREATED)).toBe(1);
      // The same key against another plan is a different request.
      const other = await newPlan();
      await call(
        'post',
        tokens.platform!,
        `/platform/pricing/plans/${other.id}/versions`,
        key,
      ).expect(422);
      expect(await versionsOf(other.id)).toBe(0);
      // A genuinely new request (new key) creates the next draft.
      const next = await call(
        'post',
        tokens.platform!,
        `/platform/pricing/plans/${p.id}/versions`,
      ).expect(201);
      expect([next.body.data.versionNumber, await versionsOf(p.id)]).toEqual([2, 2]);
      // Concurrency: eight identical creates on a fresh plan, one draft.
      const fresh = await newPlan();
      const concurrentKey = newKey();
      const created = await concurrently(
        () =>
          call(
            'post',
            tokens.platform!,
            `/platform/pricing/plans/${fresh.id}/versions`,
            concurrentKey,
          ),
        201,
      );
      expect(await versionsOf(fresh.id)).toBe(1);
      expect(await auditsOf(created.id, AUDIT_ACTIONS.PRICING_VERSION_CREATED)).toBe(1);
    });

    it('plan creation and activation replay too; records live in the platform namespace; a refused principal claims no key', async () => {
      const key = newKey();
      const body = { name: `p72-keyed-${suffix()}` };
      const first = await call('post', tokens.platform!, '/platform/pricing/plans', key)
        .send(body)
        .expect(201);
      plans.push(first.body.data.id);
      const again = await call('post', tokens.platform!, '/platform/pricing/plans', key)
        .send(body)
        .expect(201);
      expect(again.body).toEqual(first.body);
      const v = (
        await call(
          'post',
          tokens.platform!,
          `/platform/pricing/plans/${first.body.data.id}/versions`,
        ).expect(201)
      ).body.data;
      await call('put', tokens.platform!, `/platform/pricing/versions/${v.id}/rules`)
        .send({ rules: [{ channelId: channels.sms, unitPriceE4: 1 }] })
        .expect(200);
      const activationKey = newKey();
      const activated = await call(
        'post',
        tokens.platform!,
        `/platform/pricing/versions/${v.id}/activate`,
        activationKey,
      )
        .send({})
        .expect(200);
      const replayed = await call(
        'post',
        tokens.platform!,
        `/platform/pricing/versions/${v.id}/activate`,
        activationKey,
      )
        .send({})
        .expect(200);
      expect(replayed.body).toEqual(activated.body);
      expect(await auditsOf(v.id, AUDIT_ACTIONS.PRICING_VERSION_ACTIVATED)).toBe(1);
      // The records: platform namespace (org_id NULL), completed, owned by the user.
      const rows = (
        await h.admin.execute<{ org_id: string | null; status: string; endpoint: string }>(
          sql`SELECT org_id, status, endpoint FROM idempotency_keys WHERE idempotency_key IN (${key}, ${activationKey}) ORDER BY endpoint`,
        )
      ).rows;
      expect(rows).toEqual([
        { org_id: null, status: 'completed', endpoint: 'POST /platform/pricing/plans' },
        {
          org_id: null,
          status: 'completed',
          endpoint: 'POST /platform/pricing/versions/:id/activate',
        },
      ]);
      // A principal without pricing.manage is refused before any key is claimed.
      const refusedKey = newKey();
      for (const who of ['support', 'orgAdmin'] as const) {
        await call('post', tokens[who]!, '/platform/pricing/plans', refusedKey)
          .send({ name: `p72-refused-${suffix()}` })
          .expect(403);
      }
      expect(
        await count(
          sql`SELECT count(*)::text AS n FROM idempotency_keys WHERE idempotency_key = ${refusedKey}`,
        ),
      ).toBe(0);
    });
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
