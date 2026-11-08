/**
 * Phase 5.0 PR-E (implementation plan T11; spec §F.2(b), §F.3; OD-16) — the operator simulator
 * trigger, over real HTTP, with the ingress enabled for this suite:
 *
 *   POST /api/v1/providers/:id/simulator/delivery-events
 *        X-Acc-Webhook-Ingress-Key: <key>   { attemptId, scenario? }
 *
 * - AC-SIM-1: the §F.3 scenarios produce their stated results through the REAL public ingress
 *   (loopback, header form), deterministically: re-running a scenario changes nothing more.
 * - Late receipts through the trigger keep the two axes apart (AC-LT-1).
 * - Target is an attempt id only; strict correlation decides the match (unknown or another
 *   provider's attempt: unmatched, nothing changes).
 * - Authorization: platform `providers.test_send` only (tenant administrator 403, read-only
 *   platform support 403, no session 401); simulator providers only.
 * - Audit: `provider.test_sent`, metadata.tool = simulator_delivery_events, never the key.
 * - The key never appears in a response, an audit row, a webhook_events row or a metric.
 *
 * The disabled-ingress refusal (409) is in `provider-webhook-key.sec-spec.ts` (ingress off).
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { INGRESS_KEY_HEADER } from '../src/webhooks/ingress-path';
import type { Harness, TenantFixture } from './auth-harness';
import {
  INGRESS_PREFIX,
  channelId,
  cleanWorld,
  ingressProvider,
  plantMessage,
  webhookEnvironment,
  type WebhookWorld,
} from './phase5_0-webhook-fixtures';

jest.setTimeout(180_000);

const PASSWORD = 'a-sufficiently-long-test-passphrase';

describe('Phase 5.0 PR-E — operator simulator trigger (ingress enabled for this suite)', () => {
  let restoreEnv: () => void;
  let h: Harness;
  let A: TenantFixture;
  let world: WebhookWorld;
  let smsWorld: WebhookWorld;
  let operatorToken: string;
  let supportToken: string;
  let tenantToken: string;
  const users: string[] = [];
  let harness: typeof import('./auth-harness');

  const url = (p: string) => `/${INGRESS_PREFIX}${p}`;

  async function login(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  async function platformUser(roleKey: string, label: string): Promise<string> {
    const credentials = h.app.get(CredentialService);
    const email = `${label}-${uuidv7().slice(-10)}@example.test`;
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
      await tx
        .insert(schema.userRoles)
        .values({ userId: u!.id, roleId: role!.id, scopeType: 'platform' });
    });
    return login(email);
  }

  beforeAll(async () => {
    restoreEnv = webhookEnvironment({
      DELIVERY_WEBHOOKS_ENABLED: 'true',
      REDIS_KEY_PREFIX: `acc-test-p50e-t-${randomBytes(4).toString('hex')}`,
    });
    harness = await import('./auth-harness');
    h = await harness.startHarness();
    A = await harness.createTenant(h.admin, 'p50e-t', h.app.get(CredentialService));
    world = { channelId: await channelId(h, 'whatsapp'), providers: [], contacts: new Map() };
    smsWorld = { channelId: await channelId(h, 'sms'), providers: [], contacts: new Map() };
    operatorToken = await platformUser(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN, 'p50e-operator');
    supportToken = await platformUser(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT, 'p50e-support');
    tenantToken = await login(A.email);
  }, 90_000);

  afterAll(async () => {
    try {
      const providers = [...world.providers, ...smsWorld.providers];
      if (providers.length) {
        await harness.purgeAudit(
          h.admin,
          sql`resource_type = 'Provider' AND resource_id IN (${sql.join(
            providers.map((p) => sql`${p}::uuid`),
            sql`, `,
          )})`,
        );
      }
      await cleanWorld(h, world, A ? [A.orgId] : []);
      await cleanWorld(h, smsWorld, []);
      if (A) await harness.destroyTenant(h.admin, A);
      if (users.length) await harness.removeIdentities(h.admin, users);
    } finally {
      await h?.close();
      restoreEnv?.();
    }
  });

  const trigger = (
    providerId: string,
    body: Record<string, unknown>,
    key: string | undefined,
    token: string | null = operatorToken,
  ) => {
    let r = request(h.app.getHttpServer()).post(
      url(`/providers/${providerId}/simulator/delivery-events`),
    );
    if (token) r = r.set('authorization', `Bearer ${token}`);
    if (key !== undefined) r = r.set(INGRESS_KEY_HEADER, key);
    return r.send(body);
  };
  const attempt = async (id: string) =>
    (
      await h.admin.select().from(schema.messageAttempts).where(eq(schema.messageAttempts.id, id))
    )[0]!;
  const message = async (id: string) =>
    (await h.admin.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;
  const rows = async (providerId: string) =>
    (
      await h.admin.execute<{
        outcome: string;
        duplicate_count: number;
        matched_attempt_id: string | null;
      }>(
        sql`SELECT outcome, duplicate_count, matched_attempt_id FROM webhook_events
             WHERE provider_id = ${providerId} ORDER BY id`,
      )
    ).rows;
  const audits = async (providerId: string) =>
    (
      await h.admin.execute<{ action: string; metadata: Record<string, unknown>; row: string }>(
        sql`SELECT action, metadata, to_jsonb(a)::text AS row FROM audit_logs a
             WHERE resource_type = 'Provider' AND resource_id = ${providerId}
               AND action = 'provider.test_sent' ORDER BY id`,
      )
    ).rows;
  /** A fresh accepted attempt (delivery pending) of a fresh message under provider `p`. */
  const fresh = (p: string, status: 'accepted' | 'outcome_unknown' = 'accepted') =>
    plantMessage(h, world, A, [{ provider: p, status }]).then((m) => ({
      messageId: m.messageId,
      attemptId: m.attemptIds[0]!,
    }));

  // ===========================================================================
  describe('AC-SIM-1: the §F.3 scenarios through the real ingress', () => {
    it('DELIVERED: attempt and message delivered; submission status unchanged; audited without the key', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const res = await trigger(
        p.id,
        { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED' } },
        p.key,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        providerId: p.id,
        attemptId: t.attemptId,
        scenario: { outcome: 'DELIVERED' },
        elementCount: 1,
        requests: [{ index: 0, elements: 1, status: 200, received: 1, errorCode: null }],
      });
      expect((await attempt(t.attemptId)).deliveryStatus).toBe('delivered');
      const m = await message(t.messageId);
      expect([m.status, m.deliveryStatus]).toEqual(['accepted', 'delivered']);
      const [audit] = await audits(p.id);
      expect(audit!.metadata).toEqual({
        tool: 'simulator_delivery_events',
        attemptId: t.attemptId,
        scenario: { outcome: 'DELIVERED' },
        elementCount: 1,
        requestCount: 1,
        outcomes: [{ status: 200, received: 1, errorCode: null }],
      });
      for (const text of [JSON.stringify(res.body), audit!.row]) expect(text).not.toContain(p.key);
    });

    it.each<
      [string, Record<string, unknown>, (a: typeof schema.messageAttempts.$inferSelect) => void]
    >([
      [
        'DELIVERED + read',
        { outcome: 'DELIVERED', read: true },
        (a) => {
          expect(a.deliveryStatus).toBe('delivered');
          expect(a.readAt).not.toBeNull();
        },
      ],
      [
        'UNDELIVERED',
        { outcome: 'UNDELIVERED' },
        (a) => expect(a.deliveryStatus).toBe('undelivered'),
      ],
      [
        'REVERSED (read before delivered)',
        { outcome: 'DELIVERED', read: true, order: 'REVERSED' },
        (a) => {
          expect(a.deliveryStatus).toBe('delivered');
          expect(a.readAt).not.toBeNull();
        },
      ],
      [
        'batch (delivered + read in one request)',
        { outcome: 'DELIVERED', read: true, batch: true },
        (a) => {
          expect(a.deliveryStatus).toBe('delivered');
          expect(a.readAt).not.toBeNull();
        },
      ],
      [
        'client reference only',
        { outcome: 'DELIVERED', clientReferenceOnly: true },
        (a) => expect(a.deliveryStatus).toBe('delivered'),
      ],
    ])('%s', async (_label, scenario, check) => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const res = await trigger(p.id, { attemptId: t.attemptId, scenario }, p.key);
      expect(res.status).toBe(200);
      for (const r of res.body.data.requests) expect([r.status, r.errorCode]).toEqual([200, null]);
      check(await attempt(t.attemptId));
    });

    it('duplicates = 2: three requests accepted, state written once, one row counting two duplicates', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const res = await trigger(
        p.id,
        { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED', duplicates: 2 } },
        p.key,
      );
      expect(res.body.data.requests.map((r: { status: number }) => r.status)).toEqual([
        200, 200, 200,
      ]);
      expect(await rows(p.id)).toEqual([
        { outcome: 'applied', duplicate_count: 2, matched_attempt_id: t.attemptId },
      ]);
    });

    it('without event ids, a repeated identical element is deduplicated by its hash', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      await trigger(
        p.id,
        {
          attemptId: t.attemptId,
          scenario: { outcome: 'DELIVERED', duplicates: 1, withEventIds: false },
        },
        p.key,
      ).expect(200);
      expect(await rows(p.id)).toEqual([
        { outcome: 'applied', duplicate_count: 1, matched_attempt_id: t.attemptId },
      ]);
    });

    it('INVALID and STALE signatures: reported 401 per request; nothing recorded or changed', async () => {
      const p = await ingressProvider(h, world);
      for (const signature of ['INVALID', 'STALE']) {
        const t = await fresh(p.id);
        const res = await trigger(
          p.id,
          { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED', signature } },
          p.key,
        );
        expect(res.status).toBe(200);
        expect(res.body.data.requests).toEqual([
          { index: 0, elements: 1, status: 401, received: null, errorCode: 'WEBHOOK_NOT_ACCEPTED' },
        ]);
        expect((await attempt(t.attemptId)).deliveryStatus).toBe('pending');
      }
      expect(await rows(p.id)).toEqual([]);
    });

    it('REPLAY: the same signed request re-sent is a duplicate; no second state change', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const res = await trigger(
        p.id,
        { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED', signature: 'REPLAY' } },
        p.key,
      );
      expect(res.body.data.requests.map((r: { status: number }) => r.status)).toEqual([200, 200]);
      expect(await rows(p.id)).toEqual([
        { outcome: 'applied', duplicate_count: 1, matched_attempt_id: t.attemptId },
      ]);
    });

    it('outcome NONE: nothing is sent; the run is still audited', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const res = await trigger(
        p.id,
        { attemptId: t.attemptId, scenario: { outcome: 'NONE' } },
        p.key,
      ).expect(200);
      expect(res.body.data).toMatchObject({ elementCount: 0, requests: [] });
      expect(await rows(p.id)).toEqual([]);
      expect((await audits(p.id))[0]!.metadata).toMatchObject({ elementCount: 0, requestCount: 0 });
    });

    it('AC-LT-1 through the trigger: a receipt after a submission timeout — delivered; status stays outcome_unknown', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id, 'outcome_unknown');
      await trigger(
        p.id,
        { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED' } },
        p.key,
      ).expect(200);
      const m = await message(t.messageId);
      expect([m.status, m.deliveryStatus]).toEqual(['outcome_unknown', 'delivered']);
    });

    it('deterministic and safe to repeat: the same scenario again is a duplicate and changes nothing', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const body = { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED', read: true } };
      await trigger(p.id, body, p.key).expect(200);
      const after1 = { a: await attempt(t.attemptId), m: await message(t.messageId) };
      const again = await trigger(p.id, body, p.key).expect(200);
      expect(again.body.data.requests.map((r: { status: number }) => r.status)).toEqual([200, 200]);
      expect(await attempt(t.attemptId)).toEqual(after1.a);
      expect(await message(t.messageId)).toEqual(after1.m);
      expect((await rows(p.id)).map((r) => [r.outcome, r.duplicate_count])).toEqual([
        ['applied', 1],
        ['applied', 1],
      ]);
    });

    it("the provider's configured simulator_delivery capability is used when no scenario is passed", async () => {
      const p = await ingressProvider(h, world);
      await h.admin.insert(schema.providerCapabilities).values({
        providerId: p.id,
        capabilityKey: 'simulator_delivery',
        value: { outcome: 'UNDELIVERED' },
      });
      const t = await fresh(p.id);
      const res = await trigger(p.id, { attemptId: t.attemptId }, p.key).expect(200);
      expect(res.body.data.scenario).toEqual({ outcome: 'UNDELIVERED' });
      expect((await attempt(t.attemptId)).deliveryStatus).toBe('undelivered');
    });
  });

  // ===========================================================================
  describe('targeting: attempt id only; strict correlation decides', () => {
    it('an unknown attempt id: accepted by the ingress, recorded unmatched, nothing changes', async () => {
      const p = await ingressProvider(h, world);
      const res = await trigger(
        p.id,
        { attemptId: uuidv7(), scenario: { outcome: 'DELIVERED' } },
        p.key,
      ).expect(200);
      expect(res.body.data.requests[0]).toMatchObject({ status: 200, received: 1 });
      expect(await rows(p.id)).toEqual([
        { outcome: 'unmatched', duplicate_count: 0, matched_attempt_id: null },
      ]);
    });

    it("another provider's attempt, named exactly through this provider: unmatched; that attempt is untouched", async () => {
      const p = await ingressProvider(h, world);
      const q = await ingressProvider(h, world);
      const t = await fresh(q.id);
      await trigger(
        p.id,
        { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED' } },
        p.key,
      ).expect(200);
      expect((await attempt(t.attemptId)).deliveryStatus).toBe('pending');
      expect((await rows(p.id))[0]!.outcome).toBe('unmatched');
    });

    it('a message id, an unknown property or a caller-supplied URL is refused (400); nothing is sent', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      for (const body of [
        { messageId: t.messageId, scenario: { outcome: 'DELIVERED' } },
        { attemptId: t.attemptId, messageId: t.messageId },
        { attemptId: t.attemptId, url: 'http://example.test/hook' },
        { attemptId: t.attemptId, target: 'http://127.0.0.1:1/' },
        { attemptId: 'not-a-uuid' },
      ]) {
        const res = await trigger(p.id, body, p.key);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      }
      expect(await rows(p.id)).toEqual([]);
      expect((await attempt(t.attemptId)).deliveryStatus).toBe('pending');
    });

    it('an invalid scenario, a read on SMS, or no scenario at all: 400, nothing sent', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      for (const scenario of [
        { outcome: 'MAYBE' },
        { outcome: 'UNDELIVERED', read: true },
        { outcome: 'DELIVERED', duplicates: 9 },
        { outcome: 'DELIVERED', extra: 1 },
      ]) {
        expect((await trigger(p.id, { attemptId: t.attemptId, scenario }, p.key)).status).toBe(400);
      }
      expect((await trigger(p.id, { attemptId: t.attemptId }, p.key)).status).toBe(400);
      const sms = await ingressProvider(h, smsWorld, { receipts: ['delivered', 'undelivered'] });
      const smsRes = await trigger(
        sms.id,
        { attemptId: uuidv7(), scenario: { outcome: 'DELIVERED', read: true } },
        sms.key,
      );
      expect(smsRes.status).toBe(400);
      expect(await rows(p.id)).toEqual([]);
      expect(await rows(sms.id)).toEqual([]);
    });
  });

  // ===========================================================================
  describe('the ingress key: transient, header only, never disclosed', () => {
    it('missing, empty or over-long key header: 400 without echo; nothing sent', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const long = 'k'.repeat(129);
      for (const key of [undefined, '', long]) {
        const res = await trigger(
          p.id,
          { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED' } },
          key,
        );
        expect([String(key?.length), res.status]).toEqual([String(key?.length), 400]);
        expect(JSON.stringify(res.body)).not.toContain(long);
      }
      expect(await rows(p.id)).toEqual([]);
    });

    it('a wrong key: the ingress answers 401 (reported); nothing changes; the run is audited, the key is not', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const wrong = `w${p.key.slice(1)}`;
      const res = await trigger(
        p.id,
        { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED' } },
        wrong,
      ).expect(200);
      expect(res.body.data.requests).toEqual([
        { index: 0, elements: 1, status: 401, received: null, errorCode: 'WEBHOOK_NOT_ACCEPTED' },
      ]);
      expect((await attempt(t.attemptId)).deliveryStatus).toBe('pending');
      const [audit] = await audits(p.id);
      for (const secret of [wrong, p.key]) {
        expect(audit!.row).not.toContain(secret);
        expect(JSON.stringify(res.body)).not.toContain(secret);
      }
    });

    it('no response, audit row, webhook_events row or metric carries the key', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const res = await trigger(
        p.id,
        { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED', read: true, duplicates: 1 } },
        p.key,
      ).expect(200);
      expect(JSON.stringify(res.body)).not.toContain(p.key);
      for (const a of await audits(p.id)) expect(a.row).not.toContain(p.key);
      const stored = await h.admin.execute<{ t: string }>(
        sql`SELECT coalesce(string_agg(to_jsonb(w)::text, ''), '') AS t FROM webhook_events w WHERE provider_id = ${p.id}`,
      );
      expect(stored.rows[0]!.t.length).toBeGreaterThan(0);
      expect(stored.rows[0]!.t).not.toContain(p.key);
      const all = await h.admin.execute<{ t: string }>(
        sql`SELECT coalesce(string_agg(to_jsonb(a)::text, ''), '') AS t FROM audit_logs a WHERE created_at > now() - interval '1 hour'`,
      );
      expect(all.rows[0]!.t).not.toContain(p.key);
      const metrics = await request(h.app.getHttpServer()).get('/metrics');
      expect(metrics.text).not.toContain(p.key);
    });
  });

  // ===========================================================================
  describe('authorization and providers', () => {
    it('tenant administrator 403, read-only platform support 403, no session 401; nothing sent', async () => {
      const p = await ingressProvider(h, world);
      const t = await fresh(p.id);
      const body = { attemptId: t.attemptId, scenario: { outcome: 'DELIVERED' } };
      expect((await trigger(p.id, body, p.key, tenantToken)).status).toBe(403);
      expect((await trigger(p.id, body, p.key, supportToken)).status).toBe(403);
      expect((await trigger(p.id, body, p.key, null)).status).toBe(401);
      expect(await rows(p.id)).toEqual([]);
      expect(await audits(p.id)).toEqual([]);
      expect((await attempt(t.attemptId)).deliveryStatus).toBe('pending');
    });

    it('an unknown provider: 404', async () => {
      expect(
        (await trigger(uuidv7(), { attemptId: uuidv7(), scenario: { outcome: 'DELIVERED' } }, 'k'))
          .status,
      ).toBe(404);
    });

    it('a provider that is not a simulator is refused; nothing sent', async () => {
      const slug = `p50e-real-${randomBytes(4).toString('hex')}`;
      const [p] = await h.admin
        .insert(schema.providers)
        .values({
          channelId: world.channelId,
          name: slug,
          slug,
          adapterKey: 'unregistered_adapter',
          status: 'active',
          healthState: 'healthy',
          circuitState: 'closed',
        })
        .returning({ id: schema.providers.id });
      world.providers.push(p!.id);
      const res = await trigger(
        p!.id,
        { attemptId: uuidv7(), scenario: { outcome: 'DELIVERED' } },
        'any-key',
      );
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('PROVIDER_ADAPTER_UNKNOWN');
      expect(await rows(p!.id)).toEqual([]);
      expect(await audits(p!.id)).toEqual([]);
    });
  });
});
