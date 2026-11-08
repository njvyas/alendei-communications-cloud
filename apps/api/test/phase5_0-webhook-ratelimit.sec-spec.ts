/**
 * Phase 5.0 PR-C — ingress rate limiting runs before key handling (design spec Rev 2 §E.3
 * steps 1 and 3; AC-RL-1). Its own suite: small limits, isolated Redis buckets.
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import request from 'supertest';

import { INGRESS_KEY_HEADER } from '../src/webhooks/ingress-path';
import { WebhookIngressService } from '../src/webhooks/webhook-ingress.service';
import { IngressKeyHasher } from '../src/webhooks/webhook-key-material.module';
import type { Harness } from './auth-harness';
import {
  channelId,
  cleanWorld,
  ingressProvider,
  post,
  webhookEnvironment,
  type WebhookWorld,
} from './phase5_0-webhook-fixtures';

jest.setTimeout(120_000);

describe('Phase 5.0 PR-C — ingress rate limiting runs before key handling (AC-RL-1)', () => {
  let restoreEnv: () => void;
  let h: Harness;
  let world: WebhookWorld;

  beforeAll(async () => {
    restoreEnv = webhookEnvironment({
      DELIVERY_WEBHOOKS_ENABLED: 'true',
      REDIS_KEY_PREFIX: `acc-test-p50c-rl-${randomBytes(4).toString('hex')}`,
      WEBHOOK_RATE_LIMIT_IP_MAX: '4',
      WEBHOOK_RATE_LIMIT_PROVIDER_MAX: '2',
    });
    // After the environment: ConfigModule.forRoot validates it when AppModule is imported.
    h = await (await import('./auth-harness')).startHarness();
    world = { channelId: await channelId(h, 'whatsapp'), providers: [], contacts: new Map() };
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanWorld(h, world, []);
    } finally {
      await h?.close();
      restoreEnv?.();
    }
  });

  it('per provider after resolution, then per source IP before any hashing or lookup', async () => {
    const p = await ingressProvider(h, world);
    const ingress = h.app.get(WebhookIngressService);
    const hasher = h.app.get(IngressKeyHasher);
    const resolve = jest.spyOn(
      ingress as unknown as { resolve: () => Promise<unknown> },
      'resolve',
    );
    const hash = jest.spyOn(hasher, 'hash');
    try {
      const body = [
        { type: 'delivery', eventId: 'rl', providerMessageId: 'sim-none', status: 'DELIVERED' },
      ];
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await post(h, p.key, body)).status);
      // 1–2 accepted; 3–4 refused by the provider bucket (after resolution); 5–6 refused by the
      // IP bucket (before resolution).
      expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
      expect(resolve).toHaveBeenCalledTimes(4);
      expect(hash).toHaveBeenCalledTimes(4);
      // A flood of unknown keys from the same source costs no hash and no lookup at all.
      for (let i = 0; i < 5; i += 1) expect((await post(h, `unknown-${i}`, body)).status).toBe(429);
      expect(resolve).toHaveBeenCalledTimes(4);
      expect(hash).toHaveBeenCalledTimes(4);
    } finally {
      resolve.mockRestore();
      hash.mockRestore();
    }
    const metrics = await request(h.app.getHttpServer()).get('/metrics');
    expect(metrics.text).toMatch(
      /acc_webhook_requests_total\{[^}]*outcome="rate_limited"[^}]*\} [1-9]/,
    );
  });

  it('Phase 5.0 PR-E: the header form is limited by the same buckets, before any hashing or lookup', async () => {
    // The per-IP bucket of this source is exhausted by the test above.
    const ingress = h.app.get(WebhookIngressService);
    const hasher = h.app.get(IngressKeyHasher);
    const resolve = jest.spyOn(
      ingress as unknown as { resolve: () => Promise<unknown> },
      'resolve',
    );
    const hash = jest.spyOn(hasher, 'hash');
    try {
      for (let i = 0; i < 3; i += 1) {
        const res = await request(h.app.getHttpServer())
          .post('/api/v1/webhooks/providers')
          .set(INGRESS_KEY_HEADER, `unknown-header-${i}`)
          .set('content-type', 'application/json')
          .send('{"events":[]}');
        expect(res.status).toBe(429);
      }
      expect(resolve).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
      hash.mockRestore();
    }
  });
});
