import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  channelsApi,
  providersApi,
  providerCircuitPolicyApi,
  type ChannelView,
  type ProviderDetailView,
  type CircuitPolicyView,
  type ProviderTestSendResult,
  type ProviderHealthCheckResult,
} from './api-client';

describe('Channels & Providers Administration API Client', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-ch0000000001';
  const PROVIDER_ID = '01955b0a-7b3b-7411-9a4f-pr0000000001';

  const mockChannel: ChannelView = {
    id: CHANNEL_ID,
    code: 'whatsapp',
    displayName: 'WhatsApp Business',
    status: 'active',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
  };

  const mockProvider: ProviderDetailView = {
    id: PROVIDER_ID,
    channelId: CHANNEL_ID,
    channelCode: 'whatsapp',
    name: 'Infobip WhatsApp Primary',
    adapterKey: 'simulator',
    status: 'active',
    healthState: 'healthy',
    healthOverride: null,
    healthChangedAt: '2026-09-20T10:00:00.000Z',
    circuitState: 'closed',
    circuitChangedAt: '2026-09-20T10:00:00.000Z',
    circuitCooldownUntil: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    capabilities: [{ key: 'max_segments', value: 10 }],
  };

  const mockCircuitPolicy: CircuitPolicyView = {
    windowMs: 60000,
    windowMaxSamples: 20,
    minSamples: 5,
    failurePercent: 50,
    cooldownMs: 30000,
    halfOpenMaxProbes: 1,
    probeLeaseMs: 10000,
    halfOpenSuccessesToClose: 2,
    version: 3,
    updatedAt: '2026-09-20T10:00:00.000Z',
  };

  beforeEach(() => {
    fetchCalls = [];
    mockHandlers = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const options = init ?? {};
      fetchCalls.push({ url, options });

      for (const h of mockHandlers) {
        if (h.match(url, options)) {
          return h.handle(url, options);
        }
      }

      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- Channels API Tests ---------------------------------------------------

  it('1. channelsApi.list calls GET /channels with pagination and skipTenant', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/channels'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: [mockChannel],
            page: { nextCursor: 'next-123', hasMore: true, limit: 10 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await channelsApi.list({ cursor: 'cur-1', limit: 10, sort: 'displayName' });
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]!.code, 'whatsapp');
    assert.equal(res.page.hasMore, true);

    const call = fetchCalls[0]!;
    assert.ok(call.url.includes('/channels?cursor=cur-1&limit=10&sort=displayName'));
    assert.equal(call.options.method, 'GET');
    // skipTenant ensures X-Acc-Organization is absent
    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], undefined);
  });

  it('2. channelsApi.get calls GET /channels/:id', async () => {
    mockHandlers.push({
      match: (url) => url.includes(`/channels/${CHANNEL_ID}`),
      handle: () =>
        new Response(JSON.stringify({ data: mockChannel }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await channelsApi.get(CHANNEL_ID);
    assert.equal(res.data.id, CHANNEL_ID);
    assert.equal(res.data.displayName, 'WhatsApp Business');
  });

  // --- Providers API Tests --------------------------------------------------

  it('3. providersApi.list serializes channelId, status, and cursor filters', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/providers'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: [mockProvider],
            page: { nextCursor: null, hasMore: false, limit: 25 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await providersApi.list({
      channelId: CHANNEL_ID,
      status: 'active',
      limit: 25,
    });

    assert.equal(res.data.length, 1);
    const call = fetchCalls[0]!;
    assert.ok(call.url.includes(`/providers?channelId=${CHANNEL_ID}&status=active&limit=25`));
    assert.equal(call.options.method, 'GET');
  });

  it('4. providersApi.get retrieves provider detail with capabilities', async () => {
    mockHandlers.push({
      match: (url) => url.includes(`/providers/${PROVIDER_ID}`),
      handle: () =>
        new Response(JSON.stringify({ data: mockProvider }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await providersApi.get(PROVIDER_ID);
    assert.equal(res.data.id, PROVIDER_ID);
    assert.equal(res.data.capabilities.length, 1);
    assert.equal(res.data.capabilities[0]!.key, 'max_segments');
  });

  it('5. providersApi.create posts CreateProviderDto to /providers', async () => {
    mockHandlers.push({
      match: (url, opts) => url.endsWith('/providers') && opts.method === 'POST',
      handle: (_url, opts) => {
        const body = JSON.parse(opts.body as string);
        assert.equal(body.channelId, CHANNEL_ID);
        assert.equal(body.name, 'New Provider');
        assert.equal(body.adapterKey, 'simulator');
        return new Response(JSON.stringify({ data: { ...mockProvider, name: body.name } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const res = await providersApi.create({
      channelId: CHANNEL_ID,
      name: 'New Provider',
      adapterKey: 'simulator',
    });

    assert.equal(res.data.name, 'New Provider');
  });

  it('6. providersApi.update sends PATCH /providers/:id with name', async () => {
    mockHandlers.push({
      match: (url, opts) => url.includes(`/providers/${PROVIDER_ID}`) && opts.method === 'PATCH',
      handle: (_url, opts) => {
        const body = JSON.parse(opts.body as string);
        assert.equal(body.name, 'Renamed Provider');
        return new Response(JSON.stringify({ data: { ...mockProvider, name: body.name } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const res = await providersApi.update(PROVIDER_ID, { name: 'Renamed Provider' });
    assert.equal(res.data.name, 'Renamed Provider');
  });

  it('7. providersApi.replaceCapabilities sends PUT /providers/:id/capabilities', async () => {
    mockHandlers.push({
      match: (url, opts) =>
        url.includes(`/providers/${PROVIDER_ID}/capabilities`) && opts.method === 'PUT',
      handle: (_url, opts) => {
        const body = JSON.parse(opts.body as string);
        assert.equal(body.capabilities.length, 2);
        return new Response(
          JSON.stringify({ data: { ...mockProvider, capabilities: body.capabilities } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const newCaps = [
      { key: 'max_segments', value: 15 },
      { key: 'supports_templates', value: true },
    ];
    const res = await providersApi.replaceCapabilities(PROVIDER_ID, { capabilities: newCaps });
    assert.equal(res.data.capabilities.length, 2);
  });

  it('8. providersApi lifecycle transitions: enable, disable, drain', async () => {
    mockHandlers.push({
      match: (url, opts) => url.includes('/enable') && opts.method === 'POST',
      handle: () =>
        new Response(JSON.stringify({ data: { ...mockProvider, status: 'active' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    mockHandlers.push({
      match: (url, opts) => url.includes('/disable') && opts.method === 'POST',
      handle: () =>
        new Response(JSON.stringify({ data: { ...mockProvider, status: 'disabled' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    mockHandlers.push({
      match: (url, opts) => url.includes('/drain') && opts.method === 'POST',
      handle: () =>
        new Response(JSON.stringify({ data: { ...mockProvider, status: 'draining' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const enabled = await providersApi.enable(PROVIDER_ID);
    assert.equal(enabled.data.status, 'active');

    const disabled = await providersApi.disable(PROVIDER_ID);
    assert.equal(disabled.data.status, 'disabled');

    const draining = await providersApi.drain(PROVIDER_ID);
    assert.equal(draining.data.status, 'draining');
  });

  it('9. providersApi.testSend dispatches behavior and returns simulation result', async () => {
    const mockTestSendResult: ProviderTestSendResult = {
      providerId: PROVIDER_ID,
      adapterKey: 'simulator',
      channelCode: 'whatsapp',
      behavior: 'SUCCESS',
      submissionId: 'sub-123',
      correlationId: 'corr-123',
      outcome: 'accepted',
      providerMessageId: 'sim-sub-123',
      failure: null,
      latencyMs: 42,
      circuitProbe: false,
      healthState: 'healthy',
      circuitState: 'closed',
    };

    mockHandlers.push({
      match: (url, opts) =>
        url.includes(`/providers/${PROVIDER_ID}/test-send`) && opts.method === 'POST',
      handle: (_url, opts) => {
        const body = JSON.parse(opts.body as string);
        assert.equal(body.behavior, 'SUCCESS');
        return new Response(JSON.stringify({ data: mockTestSendResult }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const res = await providersApi.testSend(PROVIDER_ID, { behavior: 'SUCCESS' });
    assert.equal(res.data.outcome, 'accepted');
    assert.equal(res.data.providerMessageId, 'sim-sub-123');
    assert.equal(res.data.latencyMs, 42);
  });

  it('10. providersApi.healthCheck executes simulator probe', async () => {
    const mockHealthResult: ProviderHealthCheckResult = {
      providerId: PROVIDER_ID,
      adapterKey: 'simulator',
      channelCode: 'whatsapp',
      behavior: 'HEALTHY',
      outcome: 'healthy',
      latencyMs: 15,
      correlationId: 'corr-probe-1',
      healthState: 'healthy',
      circuitState: 'closed',
    };

    mockHandlers.push({
      match: (url, opts) =>
        url.includes(`/providers/${PROVIDER_ID}/health-check`) && opts.method === 'POST',
      handle: (_url, opts) => {
        const body = JSON.parse(opts.body as string);
        assert.equal(body.behavior, 'HEALTHY');
        return new Response(JSON.stringify({ data: mockHealthResult }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const res = await providersApi.healthCheck(PROVIDER_ID, { behavior: 'HEALTHY' });
    assert.equal(res.data.outcome, 'healthy');
    assert.equal(res.data.latencyMs, 15);
  });

  it('11. providersApi.overrideHealth sends override and reason', async () => {
    mockHandlers.push({
      match: (url, opts) =>
        url.includes(`/providers/${PROVIDER_ID}/health`) && opts.method === 'POST',
      handle: (_url, opts) => {
        const body = JSON.parse(opts.body as string);
        assert.equal(body.override, 'degraded');
        assert.equal(body.reason, 'Maintenance');
        return new Response(
          JSON.stringify({
            data: { ...mockProvider, healthState: 'degraded', healthOverride: 'degraded' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await providersApi.overrideHealth(PROVIDER_ID, {
      override: 'degraded',
      reason: 'Maintenance',
    });
    assert.equal(res.data.healthState, 'degraded');
    assert.equal(res.data.healthOverride, 'degraded');
  });

  it('12. providersApi.listHealth retrieves health sample history', async () => {
    mockHandlers.push({
      match: (url, opts) =>
        url.includes(`/providers/${PROVIDER_ID}/health`) && opts.method === 'GET',
      handle: () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'samp-1',
                providerId: PROVIDER_ID,
                kind: 'submission',
                outcome: 'accepted',
                classification: 'success',
                latencyMs: 25,
                healthState: 'healthy',
                circuitState: 'closed',
                circuitGeneration: 1,
                source: 'automatic',
                observedAt: '2026-09-20T10:00:00.000Z',
                createdAt: '2026-09-20T10:00:00.000Z',
              },
            ],
            page: { nextCursor: null, hasMore: false, limit: 10 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await providersApi.listHealth(PROVIDER_ID, { limit: 10 });
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]!.kind, 'submission');
    assert.equal(res.data[0]!.classification, 'success');
  });

  // --- Circuit Policy API Tests ---------------------------------------------

  it('13. providerCircuitPolicyApi reads and replaces platform circuit policy', async () => {
    mockHandlers.push({
      match: (url, opts) => url.includes('/provider-circuit-policy') && opts.method === 'GET',
      handle: () =>
        new Response(JSON.stringify({ data: mockCircuitPolicy }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    mockHandlers.push({
      match: (url, opts) => url.includes('/provider-circuit-policy') && opts.method === 'PUT',
      handle: (_url, opts) => {
        const body = JSON.parse(opts.body as string);
        assert.equal(body.expectedVersion, 3);
        assert.equal(body.windowMs, 45000);
        return new Response(
          JSON.stringify({ data: { ...mockCircuitPolicy, version: 4, windowMs: 45000 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const policy = await providerCircuitPolicyApi.get();
    assert.equal(policy.data.version, 3);

    const updated = await providerCircuitPolicyApi.update({
      ...policy.data,
      windowMs: 45000,
      expectedVersion: policy.data.version,
    });
    assert.equal(updated.data.version, 4);
    assert.equal(updated.data.windowMs, 45000);
  });
});
