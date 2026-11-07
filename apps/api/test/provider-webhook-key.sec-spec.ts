/**
 * Phase 5.0 PR-C (implementation plan T9) — ingress-key administration and the per-provider
 * kill switch, with the ingress itself at its deployment default: DISABLED.
 *
 * Acceptance: AC-SV-5 (hash-only storage, one-time display, rotation grace, audit without
 * the key), OD-12 (kill switch), authorization (platform `providers.manage` only), and the
 * disabled ingress (404, no acc_delivery pool) — key administration works before ingress is
 * enabled (release steps S6 before S7).
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { schema } from '@acc/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { DELIVERY_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import { hashIngressKey } from '../src/webhooks/ingress-key';
import type { Harness, TenantFixture } from './auth-harness';
import {
  channelId,
  cleanWorld,
  INGRESS_PREFIX,
  TEST_PEPPER,
  webhookEnvironment,
  type WebhookWorld,
} from './phase5_0-webhook-fixtures';

jest.setTimeout(120_000);

describe('Phase 5.0 PR-C — webhook ingress key administration (ingress disabled)', () => {
  let restoreEnv: () => void;
  let h: Harness;
  let tenant: TenantFixture;
  let platformToken: string;
  let tenantToken: string;
  let platformUser: string;
  let world: WebhookWorld;
  let destroyTenant: typeof import('./auth-harness').destroyTenant;
  let removeIdentities: typeof import('./auth-harness').removeIdentities;
  let purgeAudit: typeof import('./auth-harness').purgeAudit;
  const PASSWORD = 'a-sufficiently-long-test-passphrase';

  const url = (p: string) => `/${INGRESS_PREFIX}${p}`;
  const call = (method: 'get' | 'post', token: string | null, path: string) => {
    let r = request(h.app.getHttpServer())[method](url(path));
    if (token) r = r.set('authorization', `Bearer ${token}`);
    return r;
  };
  async function login(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  beforeAll(async () => {
    // Ingress stays at its default (off); only the pepper for key issuance is configured.
    restoreEnv = webhookEnvironment();
    delete process.env.DELIVERY_WEBHOOKS_ENABLED;
    const harness = await import('./auth-harness');
    ({ destroyTenant, removeIdentities, purgeAudit } = harness);
    h = await harness.startHarness();
    const credentials = h.app.get(CredentialService);
    tenant = await harness.createTenant(h.admin, 'p50c-keys', credentials);
    world = { channelId: await channelId(h, 'sms'), providers: [], contacts: new Map() };

    const email = `p50c-platform-${uuidv7().slice(-10)}@example.test`;
    const [u] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    platformUser = u!.id;
    const [role] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, 'alendei_super_admin'), isNull(schema.roles.orgId)));
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx
        .insert(schema.userRoles)
        .values({ userId: platformUser, roleId: role!.id, scopeType: 'platform' });
    });
    platformToken = await login(email);
    tenantToken = await login(tenant.email);
  }, 60_000);

  afterAll(async () => {
    try {
      if (world?.providers.length) {
        await purgeAudit(
          h.admin,
          sql`resource_type = 'Provider' AND resource_id IN (${sql.join(
            world.providers.map((p) => sql`${p}::uuid`),
            sql`, `,
          )})`,
        );
      }
      await cleanWorld(h, world, []);
      if (tenant) await destroyTenant(h.admin, tenant);
      if (platformUser) await removeIdentities(h.admin, [platformUser]);
    } finally {
      await h?.close();
      restoreEnv?.();
    }
  });

  async function newProvider(): Promise<string> {
    const res = await call('post', platformToken, '/providers')
      .send({
        channelId: world.channelId,
        name: `p50c-${uuidv7().slice(-10)}`,
        adapterKey: 'simulator',
      })
      .expect(201);
    world.providers.push(res.body.data.id);
    return res.body.data.id as string;
  }
  const row = async (id: string) =>
    (await h.admin.select().from(schema.providers).where(eq(schema.providers.id, id)))[0]!;
  const audits = async (id: string, action: string) =>
    (
      await h.admin.execute<{ before: unknown; after: unknown; actor_user_id: string }>(
        sql`SELECT before, after, actor_user_id FROM audit_logs WHERE resource_id = ${id} AND action = ${action} ORDER BY id`,
      )
    ).rows;

  it('the ingress is disabled by default: 404, nothing echoed, and no acc_delivery pool exists', async () => {
    expect(h.app.get(DELIVERY_POOL)).toBeNull();
    const res = await request(h.app.getHttpServer())
      .post(url('/webhooks/providers/some-would-be-key-value'))
      .set('content-type', 'application/json')
      .send('{"events":[]}');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('some-would-be-key-value');
  });

  it('Phase 5.0 PR-E: with ingress disabled, the header form is the same 404, and the simulator trigger is refused (409) before anything is sent', async () => {
    const key = 'some-would-be-header-key-value';
    const header = await request(h.app.getHttpServer())
      .post(url('/webhooks/providers'))
      .set('x-acc-webhook-ingress-key', key)
      .set('content-type', 'application/json')
      .send('{"events":[]}');
    expect(header.status).toBe(404);
    expect(header.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(JSON.stringify(header.body)).not.toContain(key);

    const id = await newProvider();
    const res = await call('post', platformToken, `/providers/${id}/simulator/delivery-events`)
      .set('x-acc-webhook-ingress-key', key)
      .send({ attemptId: uuidv7(), scenario: { outcome: 'DELIVERED' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WEBHOOK_INGRESS_DISABLED');
    expect(JSON.stringify(res.body)).not.toContain(key);
    const sent = await h.admin.execute(sql`SELECT 1 FROM webhook_events WHERE provider_id = ${id}`);
    expect(sent.rows).toHaveLength(0);
    // Refused before any audit record: nothing was exercised.
    expect(await audits(id, 'provider.test_sent')).toHaveLength(0);
  });

  it('issues a key shown once: never stored, only its peppered hash; never in a provider read; audited without it (AC-SV-5)', async () => {
    const id = await newProvider();
    const res = await call('post', platformToken, `/providers/${id}/webhook-ingress-key`).expect(
      200,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const data = res.body.data;
    expect(data).toMatchObject({
      providerId: id,
      enabled: false,
      keyConfigured: true,
      previousKeyValidUntil: null,
      ingressPathTemplate: '/api/v1/webhooks/providers/:providerKey',
    });
    expect(data.key).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 random bits, base64url
    const stored = await row(id);
    expect(
      Buffer.compare(stored.webhookIngressKeyHash!, hashIngressKey(TEST_PEPPER, data.key)),
    ).toBe(0);
    expect(stored.webhookIngressKeyHash!.toString('utf8')).not.toContain(data.key);
    const hex = stored.webhookIngressKeyHash!.toString('hex');
    const read = await call('get', platformToken, `/providers/${id}`).expect(200);
    for (const secret of [data.key, hex]) expect(JSON.stringify(read.body)).not.toContain(secret);
    const [audit] = await audits(id, 'provider.webhook_ingress_key_rotated');
    expect(audit!.actor_user_id).toBe(platformUser);
    for (const secret of [data.key, hex]) expect(JSON.stringify(audit)).not.toContain(secret);
    expect(audit!.after).toMatchObject({ keyConfigured: true, enabled: false });
  });

  it('rotation: a new key; the previous one stays valid for the 24 h grace (OD-6)', async () => {
    const id = await newProvider();
    const first = (
      await call('post', platformToken, `/providers/${id}/webhook-ingress-key`).expect(200)
    ).body.data;
    const before = await row(id);
    const second = (
      await call('post', platformToken, `/providers/${id}/webhook-ingress-key`).expect(200)
    ).body.data;
    expect(second.key).not.toBe(first.key);
    const after = await row(id);
    expect(
      Buffer.compare(after.webhookIngressKeyPreviousHash!, before.webhookIngressKeyHash!),
    ).toBe(0);
    expect(
      Buffer.compare(after.webhookIngressKeyHash!, hashIngressKey(TEST_PEPPER, second.key)),
    ).toBe(0);
    const graceMs = Date.parse(second.previousKeyValidUntil) - Date.now();
    expect(graceMs).toBeGreaterThan(23.9 * 3600_000);
    expect(graceMs).toBeLessThanOrEqual(24 * 3600_000);
    expect(await audits(id, 'provider.webhook_ingress_key_rotated')).toHaveLength(2);
  });

  it('kill switch: enabling needs a key; enable/disable are audited once; re-applying is idempotent (OD-12)', async () => {
    const id = await newProvider();
    const refused = await call(
      'post',
      platformToken,
      `/providers/${id}/webhook-ingress/enable`,
    ).expect(409);
    expect(refused.body.error.code).toBe('WEBHOOK_INGRESS_KEY_REQUIRED');
    await call('post', platformToken, `/providers/${id}/webhook-ingress-key`).expect(200);
    const on = await call('post', platformToken, `/providers/${id}/webhook-ingress/enable`).expect(
      200,
    );
    expect(on.body.data).toMatchObject({ enabled: true, keyConfigured: true });
    await call('post', platformToken, `/providers/${id}/webhook-ingress/enable`).expect(200);
    expect(await audits(id, 'provider.webhook_ingress_enabled')).toHaveLength(1);
    const off = await call(
      'post',
      platformToken,
      `/providers/${id}/webhook-ingress/disable`,
    ).expect(200);
    expect(off.body.data.enabled).toBe(false);
    expect((await row(id)).webhookIngressEnabled).toBe(false);
    expect(await audits(id, 'provider.webhook_ingress_disabled')).toHaveLength(1);
  });

  it('only a platform providers.manage holder: a tenant administrator gets 403, no session 401, unknown provider 404', async () => {
    const id = await newProvider();
    for (const path of [
      'webhook-ingress-key',
      'webhook-ingress/enable',
      'webhook-ingress/disable',
    ]) {
      await call('post', tenantToken, `/providers/${id}/${path}`).expect(403);
      await call('post', null, `/providers/${id}/${path}`).expect(401);
    }
    await call('post', platformToken, `/providers/${uuidv7()}/webhook-ingress-key`).expect(404);
    expect((await row(id)).webhookIngressKeyHash).toBeNull();
  });
});
