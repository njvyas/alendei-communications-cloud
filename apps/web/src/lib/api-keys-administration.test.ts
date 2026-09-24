import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiKeysApi,
  setAccessToken,
  setSelectedOrganization,
  ApiError,
  type CreateApiKeyInput,
} from './api-client';
import { useSession } from './session-store';

describe('API Keys Administration API Client', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';

  beforeEach(() => {
    fetchCalls = [];
    mockHandlers = [];
    useSession.getState().setSession({
      accessToken: 'mock-access-token',
      user: {
        userId: 'test-admin',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-1',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
        authorizedOrganizationIds: [ORG_ID],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'test-admin',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-1',
            roleKey: 'org_admin',
            scopeType: 'organization',
            scopeId: ORG_ID,
            orgId: ORG_ID,
            permissions: ['api_keys.read', 'api_keys.create', 'api_keys.revoke'],
          },
        ],
        organizationIds: [ORG_ID],
        isPlatformAdmin: false,
      },
      selectedOrgId: ORG_ID,
    });

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const options = init ?? {};
      fetchCalls.push({ url, options });

      for (const { match, handle } of mockHandlers) {
        if (match(url, options)) {
          return handle(url, options);
        }
      }

      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setAccessToken(null);
    setSelectedOrganization(null);
  });

  // ---------------------------------------------------------------------------
  // 1. List API Keys with Query Filters & Pagination
  // ---------------------------------------------------------------------------
  it('1. apiKeysApi.list attaches X-Acc-Organization and constructs query params correctly', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/api-keys') && !url.includes('/api-keys/'),
      handle: (url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Authorization'], 'Bearer mock-access-token');

        const parsedUrl = new URL(url, 'http://localhost');
        assert.equal(parsedUrl.searchParams.get('status'), 'active');
        assert.equal(parsedUrl.searchParams.get('scopeType'), 'workspace');
        assert.equal(parsedUrl.searchParams.get('scopeId'), '01955b0a-ws-2222');
        assert.equal(parsedUrl.searchParams.get('name'), 'CI Deployment Key');
        assert.equal(parsedUrl.searchParams.get('cursor'), 'cur_xyz789');
        assert.equal(parsedUrl.searchParams.get('limit'), '25');
        assert.equal(parsedUrl.searchParams.get('sort'), '-createdAt');

        return new Response(
          JSON.stringify({
            data: [
              {
                id: '01955b0a-key-1',
                name: 'CI Deployment Key',
                prefix: 'ak_test_abcdef1234567890',
                status: 'active',
                scopeType: 'workspace',
                scopeId: '01955b0a-ws-2222',
                orgId: ORG_ID,
                scopes: ['workspaces.read'],
                expiresAt: '2026-12-31T23:59:59.000Z',
                lastUsedAt: null,
                revokedAt: null,
                revokedReason: null,
                createdBy: 'test-admin',
                createdAt: '2026-09-24T00:00:00.000Z',
                updatedAt: '2026-09-24T00:00:00.000Z',
              },
            ],
            page: {
              nextCursor: null,
              prevCursor: null,
              hasMore: false,
              limit: 25,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const result = await apiKeysApi.list({
      status: 'active',
      scopeType: 'workspace',
      scopeId: '01955b0a-ws-2222',
      name: 'CI Deployment Key',
      cursor: 'cur_xyz789',
      limit: 25,
      sort: '-createdAt',
    });

    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.name, 'CI Deployment Key');
    assert.equal(result.data[0]?.prefix, 'ak_test_abcdef1234567890');
    assert.equal(result.data[0]?.status, 'active');
  });

  // ---------------------------------------------------------------------------
  // 2. Get API Key Detail
  // ---------------------------------------------------------------------------
  it('2. apiKeysApi.get retrieves key detail and handles 404 correctly', async () => {
    const keyId = '01955b0a-key-1';
    mockHandlers.push({
      match: (url) => url.includes(`/api-keys/${keyId}`),
      handle: (url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Authorization'], 'Bearer mock-access-token');

        return new Response(
          JSON.stringify({
            data: {
              id: keyId,
              name: 'Ingestion Service',
              prefix: 'ak_test_1111222233334444',
              status: 'active',
              scopeType: 'organization',
              scopeId: ORG_ID,
              orgId: ORG_ID,
              scopes: ['users.read', 'roles.read'],
              expiresAt: null,
              lastUsedAt: '2026-09-24T01:00:00.000Z',
              revokedAt: null,
              revokedReason: null,
              createdBy: 'test-admin',
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: '2026-09-24T01:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const result = await apiKeysApi.get(keyId);
    assert.equal(result.data.id, keyId);
    assert.equal(result.data.name, 'Ingestion Service');
    assert.equal(result.data.prefix, 'ak_test_1111222233334444');

    // 404 verification
    mockHandlers.push({
      match: (url) => url.includes('/api-keys/non-existent-id'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'API key not found',
              correlationId: 'corr-404',
              retryable: false,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => {
        await apiKeysApi.get('non-existent-id');
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'RESOURCE_NOT_FOUND');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Create API Key with One-Time Secret and Idempotency Key
  // ---------------------------------------------------------------------------
  it('3. apiKeysApi.create sends POST with Idempotency-Key and returns plaintext secret', async () => {
    const input: CreateApiKeyInput = {
      name: 'Automated Bot',
      scopeType: 'organization',
      scopeId: ORG_ID,
      scopes: ['users.read'],
      expiresAt: '2026-10-24T00:00:00.000Z',
    };
    const testIdempotencyKey = 'idem-uuid-9999-0000';

    mockHandlers.push({
      match: (url, options) => url.includes('/api-keys') && options.method === 'POST' && !url.includes('/revoke'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Idempotency-Key'], testIdempotencyKey);
        assert.equal(headers['Content-Type'], 'application/json');

        const body = JSON.parse(options.body as string);
        assert.equal(body.name, 'Automated Bot');
        assert.equal(body.scopeType, 'organization');
        assert.equal(body.scopeId, ORG_ID);
        assert.deepEqual(body.scopes, ['users.read']);
        assert.equal(body.expiresAt, '2026-10-24T00:00:00.000Z');

        return new Response(
          JSON.stringify({
            data: {
              id: '01955b0a-new-key',
              name: 'Automated Bot',
              prefix: 'ak_test_abcdef1234567890',
              status: 'active',
              scopeType: 'organization',
              scopeId: ORG_ID,
              orgId: ORG_ID,
              scopes: ['users.read'],
              expiresAt: '2026-10-24T00:00:00.000Z',
              lastUsedAt: null,
              revokedAt: null,
              revokedReason: null,
              createdBy: 'test-admin',
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: '2026-09-24T00:00:00.000Z',
              secret: '7xX8Y9zZ1234567890abcdefghijklmnopqrstuv',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await apiKeysApi.create(input, testIdempotencyKey);
    assert.equal(res.data.id, '01955b0a-new-key');
    assert.equal(res.data.prefix, 'ak_test_abcdef1234567890');
    assert.equal(res.data.secret, '7xX8Y9zZ1234567890abcdefghijklmnopqrstuv');
  });

  // ---------------------------------------------------------------------------
  // 4. Idempotent Replay Returns Secret: null (ADR-008)
  // ---------------------------------------------------------------------------
  it('4. apiKeysApi.create handles idempotent replay returning secret: null', async () => {
    const input: CreateApiKeyInput = {
      name: 'Automated Bot',
      scopeType: 'organization',
      scopeId: ORG_ID,
      scopes: ['users.read'],
    };
    const replayIdempotencyKey = 'idem-replay-key-1111';

    mockHandlers.push({
      match: (url, options) => url.includes('/api-keys') && options.method === 'POST' && !url.includes('/revoke'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              id: '01955b0a-replayed-key',
              name: 'Automated Bot',
              prefix: 'ak_test_abcdef1234567890',
              status: 'active',
              scopeType: 'organization',
              scopeId: ORG_ID,
              orgId: ORG_ID,
              scopes: ['users.read'],
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: null,
              revokedReason: null,
              createdBy: 'test-admin',
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: '2026-09-24T00:00:00.000Z',
              secret: null, // ADR-008: Snapshot never stores plaintext secret
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await apiKeysApi.create(input, replayIdempotencyKey);
    assert.equal(res.data.id, '01955b0a-replayed-key');
    assert.equal(res.data.secret, null);
  });

  // ---------------------------------------------------------------------------
  // 5. Revoke API Key Calls POST /api-keys/:id/revoke (Never DELETE)
  // ---------------------------------------------------------------------------
  it('5. apiKeysApi.revoke dispatches POST /api-keys/:id/revoke and returns revoked key view', async () => {
    const keyId = '01955b0a-key-to-revoke';
    let dispatchedMethod = '';

    mockHandlers.push({
      match: (url, options) => url.includes(`/api-keys/${keyId}/revoke`) && options.method === 'POST',
      handle: (_url, options) => {
        dispatchedMethod = options.method!;
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Authorization'], 'Bearer mock-access-token');

        return new Response(
          JSON.stringify({
            data: {
              id: keyId,
              name: 'Old Key',
              prefix: 'ak_test_1234567890123456',
              status: 'revoked',
              scopeType: 'organization',
              scopeId: ORG_ID,
              orgId: ORG_ID,
              scopes: ['users.read'],
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: '2026-09-24T06:00:00.000Z',
              revokedReason: 'revoked_by_administrator',
              createdBy: 'test-admin',
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: '2026-09-24T06:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await apiKeysApi.revoke(keyId);
    assert.equal(dispatchedMethod, 'POST');
    assert.equal(res.data.status, 'revoked');
    assert.equal(res.data.revokedReason, 'revoked_by_administrator');
  });

  // ---------------------------------------------------------------------------
  // 6. Revoke API Key Handles 409 Conflict (API_KEY_LIFECYCLE_CONFLICT)
  // ---------------------------------------------------------------------------
  it('6. apiKeysApi.revoke surfaces 409 API_KEY_LIFECYCLE_CONFLICT with authoritative status', async () => {
    const keyId = '01955b0a-already-revoked-key';

    mockHandlers.push({
      match: (url) => url.includes(`/api-keys/${keyId}/revoke`),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'API_KEY_LIFECYCLE_CONFLICT',
              message: 'This API key is already revoked',
              correlationId: 'corr-409',
              retryable: false,
              details: { status: 'revoked' },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => {
        await apiKeysApi.revoke(keyId);
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'API_KEY_LIFECYCLE_CONFLICT');
        assert.equal(err.retryable, false);
        assert.deepEqual(err.details, { status: 'revoked' });
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Structured Error Details Handling (400 validation and 403 unheld permissions)
  // ---------------------------------------------------------------------------
  it('7. ApiError preserves structured details for unheld permissions and validation failures', async () => {
    // 403 unheld permissions
    mockHandlers.push({
      match: (url, options) => url.includes('/api-keys') && options.method === 'POST',
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION',
              message: 'This key requests a permission you do not hold at that scope',
              correlationId: 'corr-unheld',
              retryable: false,
              details: { rejected: ['roles.create', 'roles.delete'] },
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => {
        await apiKeysApi.create({
          name: 'Overprivileged Key',
          scopeType: 'organization',
          scopeId: ORG_ID,
          scopes: ['roles.create', 'roles.delete'],
        });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION');
        assert.deepEqual(err.details?.rejected, ['roles.create', 'roles.delete']);
        return true;
      },
    );
  });
});
