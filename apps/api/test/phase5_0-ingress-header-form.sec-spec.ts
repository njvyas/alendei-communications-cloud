/**
 * Phase 5.0 PR-E — the header form of the provider webhook ingress (owner-approved contract
 * correction, 07-Nov-2026), over real HTTP with the ingress enabled for this suite.
 *
 *   POST /api/v1/webhooks/providers   X-Acc-Webhook-Ingress-Key: <key>
 *
 * - The same pipeline as the URL form: a valid receipt is applied; a forged signature, an
 *   unknown key, a missing key and a key in BOTH forms all get the one uniform 401; an event
 *   delivered once through each form is deduplicated. (Rate limiting before key resolution for
 *   the header form: `phase5_0-webhook-ratelimit.sec-spec.ts`.)
 * - Other methods get the uniform path-free 404; the URL form is unchanged.
 * - The key never appears in a response body, a metric, a webhook_events row or a message event.
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { CredentialService } from '../src/iam/credential.service';
import { INGRESS_KEY_HEADER } from '../src/webhooks/ingress-path';
import { WebhookIngressService } from '../src/webhooks/webhook-ingress.service';
import type { Harness, TenantFixture } from './auth-harness';
import {
  INGRESS_PREFIX,
  channelId,
  cleanWorld,
  delivered,
  factory,
  ingressProvider,
  plantMessage,
  post,
  webhookEnvironment,
  type WebhookWorld,
} from './phase5_0-webhook-fixtures';

jest.setTimeout(120_000);

const HEADER_ROUTE = `/${INGRESS_PREFIX}/webhooks/providers`;

describe('Phase 5.0 PR-E — ingress header form (enabled for this suite)', () => {
  let restoreEnv: () => void;
  let h: Harness;
  let A: TenantFixture;
  let world: WebhookWorld;
  let destroyTenant: typeof import('./auth-harness').destroyTenant;

  beforeAll(async () => {
    restoreEnv = webhookEnvironment({
      DELIVERY_WEBHOOKS_ENABLED: 'true',
      REDIS_KEY_PREFIX: `acc-test-p50e-h-${randomBytes(4).toString('hex')}`,
    });
    const harness = await import('./auth-harness');
    destroyTenant = harness.destroyTenant;
    h = await harness.startHarness();
    A = await harness.createTenant(h.admin, 'p50e-h', h.app.get(CredentialService));
    world = { channelId: await channelId(h, 'whatsapp'), providers: [], contacts: new Map() };
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanWorld(h, world, A ? [A.orgId] : []);
      if (A) await destroyTenant(h.admin, A);
    } finally {
      await h?.close();
      restoreEnv?.();
    }
  });

  /** POSTs signed elements to the header-form route; `key` undefined = no header. */
  const postHeader = (
    key: string | undefined,
    elements: Parameters<typeof post>[2],
    options: { signature?: 'VALID' | 'INVALID' | 'STALE'; path?: string } = {},
  ) => {
    const signed = factory.request(elements, {
      nowMs: Date.now(),
      ...(options.signature ? { signature: options.signature } : {}),
    });
    let r = request(h.app.getHttpServer()).post(options.path ?? HEADER_ROUTE);
    for (const [k, v] of Object.entries(signed.headers)) r = r.set(k, v);
    if (key !== undefined) r = r.set(INGRESS_KEY_HEADER, key);
    return r.send(Buffer.from(signed.rawBody).toString('utf8'));
  };
  const shape = (res: request.Response) => {
    const body = JSON.parse(JSON.stringify(res.body)) as { error?: { correlationId?: string } };
    if (body.error) delete body.error.correlationId;
    return { status: res.status, body };
  };
  const attempt = async (id: string) =>
    (
      await h.admin.select().from(schema.messageAttempts).where(eq(schema.messageAttempts.id, id))
    )[0]!;

  it('a valid receipt through the header form is applied, exactly like the URL form', async () => {
    const p = await ingressProvider(h, world);
    const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
    const res = await postHeader(p.key, [delivered(m.attemptIds[0]!)]);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: 1 });
    expect((await attempt(m.attemptIds[0]!)).deliveryStatus).toBe('delivered');
    const [msg] = await h.admin
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, m.messageId));
    expect(msg!.deliveryStatus).toBe('delivered');
    expect(msg!.status).toBe('accepted');
  });

  it('missing, unknown, forged, ambiguous (both forms) and repeated credentials: one uniform 401, no row', async () => {
    const p = await ingressProvider(h, world);
    const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
    const el = () => [delivered(m.attemptIds[0]!)];
    const forged = shape(await post(h, p.key, el(), { signature: 'INVALID' }));
    expect(forged.status).toBe(401);
    const cases: [string, request.Response][] = [
      ['missing header', await postHeader(undefined, el())],
      ['empty header', await postHeader('', el())],
      ['unknown key', await postHeader(`x${p.key}`, el())],
      ['forged signature', await postHeader(p.key, el(), { signature: 'INVALID' })],
      ['stale signature', await postHeader(p.key, el(), { signature: 'STALE' })],
      // Both forms, even with the same valid key, and each one valid on its own.
      [
        'path AND header (same key)',
        await postHeader(p.key, el(), { path: `${HEADER_ROUTE}/${p.key}` }),
      ],
      [
        'path AND header (unknown path key)',
        await postHeader(p.key, el(), { path: `${HEADER_ROUTE}/${'y'.repeat(43)}` }),
      ],
    ];
    // A header sent twice: Node joins repeated custom headers, which then matches no key.
    const twice = request(h.app.getHttpServer()).post(HEADER_ROUTE);
    const signed = factory.request(el(), { nowMs: Date.now() });
    let r = twice;
    for (const [k, v] of Object.entries(signed.headers)) r = r.set(k, v);
    cases.push([
      'header twice',
      await r
        .set(INGRESS_KEY_HEADER, [p.key, p.key])
        .send(Buffer.from(signed.rawBody).toString('utf8')),
    ]);
    for (const [label, res] of cases) {
      expect([label, shape(res)]).toEqual([label, forged]);
      expect(JSON.stringify(res.body)).not.toContain(p.key);
    }
    expect((await attempt(m.attemptIds[0]!)).deliveryStatus).toBe('pending');
    const rows = await h.admin.execute(
      sql`SELECT 1 FROM webhook_events WHERE provider_id = ${p.id}`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('the key header never reaches the ingress service: removed before the pipeline, the key passed only as the credential', async () => {
    const p = await ingressProvider(h, world);
    const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
    const ingress = h.app.get(WebhookIngressService);
    const handle = jest.spyOn(ingress, 'handle');
    try {
      expect((await postHeader(p.key, [delivered(m.attemptIds[0]!)])).status).toBe(200);
      expect(handle).toHaveBeenCalledTimes(1);
      const [arg] = handle.mock.calls[0]!;
      expect(arg.providerKey).toBe(p.key);
      expect(Object.keys(arg.headers)).not.toContain(INGRESS_KEY_HEADER);
      expect(JSON.stringify(arg.headers)).not.toContain(p.key);
    } finally {
      handle.mockRestore();
    }
  });

  it('one pipeline: the same event through the URL form and then the header form is a duplicate', async () => {
    const p = await ingressProvider(h, world);
    const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
    const event = delivered(m.attemptIds[0]!);
    expect((await post(h, p.key, [event])).status).toBe(200);
    expect((await postHeader(p.key, [event])).status).toBe(200);
    const rows = (
      await h.admin.execute<{ outcome: string; duplicate_count: number }>(
        sql`SELECT outcome, duplicate_count FROM webhook_events WHERE provider_id = ${p.id}`,
      )
    ).rows;
    expect(rows).toEqual([{ outcome: 'applied', duplicate_count: 1 }]);
  });

  it('a provider whose ingress is switched off answers the header form like a bad signature', async () => {
    const p = await ingressProvider(h, world, { enabled: false });
    const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
    const off = shape(await postHeader(p.key, [delivered(m.attemptIds[0]!)]));
    const forged = shape(await postHeader(`z${p.key}`, [delivered(m.attemptIds[0]!)]));
    expect(off).toEqual(forged);
    expect(off.status).toBe(401);
  });

  it('other methods on the header-form route: the uniform path-free 404; the URL form is unchanged', async () => {
    const p = await ingressProvider(h, world);
    for (const method of ['get', 'put', 'delete', 'patch'] as const) {
      const res = await request(h.app.getHttpServer())
        [method](HEADER_ROUTE)
        .set(INGRESS_KEY_HEADER, p.key);
      expect([method, res.status, res.body.error?.code]).toEqual([
        method,
        404,
        'RESOURCE_NOT_FOUND',
      ]);
      expect(JSON.stringify(res.body)).not.toContain(p.key);
    }
    const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
    expect((await post(h, p.key, [delivered(m.attemptIds[0]!)])).status).toBe(200);
  });

  it('wrong content type and an oversized body are refused before the key is resolved (415, 413)', async () => {
    const p = await ingressProvider(h, world);
    const wrong = await request(h.app.getHttpServer())
      .post(HEADER_ROUTE)
      .set(INGRESS_KEY_HEADER, p.key)
      .set('content-type', 'text/plain')
      .send('x');
    expect(wrong.status).toBe(415);
    const big = await request(h.app.getHttpServer())
      .post(HEADER_ROUTE)
      .set(INGRESS_KEY_HEADER, p.key)
      .set('content-type', 'application/json')
      .send(`{"events":["${'x'.repeat(70_000)}"]}`);
    expect(big.status).toBe(413);
    for (const res of [wrong, big]) expect(JSON.stringify(res.body)).not.toContain(p.key);
  });

  it('the key never reaches a metric, a webhook_events row or a message event', async () => {
    const p = await ingressProvider(h, world);
    const m = await plantMessage(h, world, A, [{ provider: p.id, status: 'accepted' }]);
    await postHeader(p.key, [delivered(m.attemptIds[0]!)]);
    await postHeader(p.key, [delivered(m.attemptIds[0]!)], { signature: 'INVALID' });
    const metrics = await request(h.app.getHttpServer()).get('/metrics');
    expect(metrics.text).not.toContain(p.key);
    expect(metrics.text).toMatch(/route="\/api\/v1\/webhooks\/providers"/);
    const stored = await h.admin.execute<{ t: string }>(
      sql`SELECT coalesce(string_agg(to_jsonb(w)::text, ''), '') AS t FROM webhook_events w WHERE provider_id = ${p.id}`,
    );
    expect(stored.rows[0]!.t).not.toContain(p.key);
    expect(stored.rows[0]!.t.length).toBeGreaterThan(0);
    const events = await h.admin.execute<{ t: string }>(
      sql`SELECT coalesce(string_agg(to_jsonb(e)::text, ''), '') AS t FROM message_events e WHERE message_id = ${m.messageId}`,
    );
    expect(events.rows[0]!.t).not.toContain(p.key);
  });
});
