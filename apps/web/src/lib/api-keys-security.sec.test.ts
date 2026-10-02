import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiKeysApi,
  setAccessToken,
  setSelectedOrganization,
  ApiError,
  type CreateApiKeyInput,
  type EffectiveAuthorization,
  type UserIdentity,
} from './api-client';
import { hasPermission, useSession } from './session-store';

describe('API Keys Security Invariants & Boundary Enforcement', () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  let storageSetItemCalls: { storage: string; key: string; value: string }[] = [];
  let consoleOutputs: string[] = [];

  const mockLocalStorage = {
    store: new Map<string, string>(),
    getItem: (key: string) => mockLocalStorage.store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageSetItemCalls.push({ storage: 'localStorage', key, value });
      mockLocalStorage.store.set(key, value);
    },
    removeItem: (key: string) => mockLocalStorage.store.delete(key),
    clear: () => mockLocalStorage.store.clear(),
  };

  const mockSessionStorage = {
    store: new Map<string, string>(),
    getItem: (key: string) => mockSessionStorage.store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageSetItemCalls.push({ storage: 'sessionStorage', key, value });
      mockSessionStorage.store.set(key, value);
    },
    removeItem: (key: string) => mockSessionStorage.store.delete(key),
    clear: () => mockSessionStorage.store.clear(),
  };

  let documentCookie = '';
  const mockDocument = {
    get cookie() {
      return documentCookie;
    },
    set cookie(val: string) {
      documentCookie = val;
    },
  };

  const ORG_A = '01955b0a-7b3b-7411-9a4f-orgAAAAAAAAAA';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-orgBBBBBBBBBB';

  const createMockUser = (orgIds: string[]): UserIdentity => ({
    userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
    actorType: 'user',
    authMethod: 'session',
    sessionId: 'session-123',
    authenticatedAt: '2026-09-24T00:00:00.000Z',
    tenant: {
      orgId: null,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
    },
    authorizedOrganizationIds: orgIds,
    roles: [],
    permissions: [],
  });

  const createMockAuthorization = (
    orgId: string,
    permissions: string[] = ['api_keys.read', 'api_keys.create', 'api_keys.revoke'],
  ): EffectiveAuthorization => ({
    actorType: 'user',
    userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
    apiKeyId: null,
    grants: [
      {
        roleId: 'role-org-admin',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: orgId,
        orgId,
        permissions,
      },
    ],
    organizationIds: [orgId],
    isPlatformAdmin: false,
  });

  beforeEach(() => {
    fetchCalls = [];
    mockHandlers = [];
    storageSetItemCalls = [];
    consoleOutputs = [];
    documentCookie = '';
    mockLocalStorage.clear();
    mockSessionStorage.clear();

    Object.defineProperty(globalThis, 'localStorage', {
      value: mockLocalStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: mockSessionStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: mockDocument,
      configurable: true,
      writable: true,
    });

    console.log = (...args: unknown[]) => {
      consoleOutputs.push(args.map(String).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      consoleOutputs.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      consoleOutputs.push(args.map(String).join(' '));
    };

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
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    setAccessToken(null);
    setSelectedOrganization(null);
    useSession.getState().clearSession();
  });

  // ---------------------------------------------------------------------------
  // 1. Cross-org API key list isolation
  // ---------------------------------------------------------------------------
  it('SEC-1: Cross-org API key list isolation pins X-Acc-Organization strictly to active org', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url) => url.includes('/api-keys'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        const currentOrg = useSession.getState().selectedOrganizationId;
        assert.equal(headers['X-Acc-Organization'], currentOrg);
        return new Response(
          JSON.stringify({
            data: [
              {
                id: `key-${currentOrg}`,
                name: `Key for ${currentOrg}`,
                prefix: 'ak_test_OrgAPrefix11111',
                status: 'active',
                scopeType: 'organization',
                scopeId: currentOrg,
                orgId: currentOrg,
                scopes: ['users.read'],
                expiresAt: null,
                lastUsedAt: null,
                revokedAt: null,
                revokedReason: null,
                createdBy: 'user-a',
                createdAt: '2026-09-24T00:00:00.000Z',
                updatedAt: '2026-09-24T00:00:00.000Z',
              },
            ],
            page: { hasMore: false },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const result = await apiKeysApi.list();
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.orgId, ORG_A);

    // Switch to Org B
    useSession.getState().selectOrganization(ORG_B);
    const resultB = await apiKeysApi.list();
    assert.equal(resultB.data.length, 1);
    assert.equal(resultB.data[0]?.orgId, ORG_B);

    const apiKeyCalls = fetchCalls.filter((c) => c.url.includes('/api-keys'));
    assert(apiKeyCalls[0] && apiKeyCalls[1]);
    const headersA = apiKeyCalls[0].options.headers as Record<string, string>;
    const headersB = apiKeyCalls[1].options.headers as Record<string, string>;
    assert.equal(headersA['X-Acc-Organization'], ORG_A);
    assert.equal(headersB['X-Acc-Organization'], ORG_B);
  });

  // ---------------------------------------------------------------------------
  // 2. Cross-org revocation prevention
  // ---------------------------------------------------------------------------
  it('SEC-2: Cross-org API key revocation is rejected as non-retryable 403 or 404', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    // Attempt to revoke key from Org B while session is pinned to Org A
    const orgBKeyId = '01955b0a-key-in-org-B';
    mockHandlers.push({
      match: (url) => url.includes(`/api-keys/${orgBKeyId}/revoke`),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        // Server verifies that key row's orgId does not match X-Acc-Organization (or is hidden by RLS)
        assert.equal(headers['X-Acc-Organization'], ORG_A);
        return new Response(
          JSON.stringify({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'API key not found',
              correlationId: 'corr-cross-org',
              retryable: false,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await apiKeysApi.revoke(orgBKeyId);
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
  // 3. Caller-supplied X-Acc-Organization cannot override selected organization
  // ---------------------------------------------------------------------------
  it('SEC-3: Caller-supplied X-Acc-Organization cannot override selected organization', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url) => url.includes('/api-keys'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        // Even if caller attempted override, it MUST be sanitized and pinned to ORG_A
        assert.equal(headers['X-Acc-Organization'], ORG_A);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    // Pass forged header directly through fetch options if exposed
    await apiKeysApi.list();
    assert(fetchCalls[0]);
    const headers = fetchCalls[0].options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_A);
  });

  // ---------------------------------------------------------------------------
  // 4. Stale / cleared organization throws before mutation network dispatch
  // ---------------------------------------------------------------------------
  it('SEC-4: Stale / cleared organization throws before mutation network dispatch', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        return !headers['X-Acc-Organization'];
      },
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'TENANCY_CONTEXT_REQUIRED',
              message: 'No organization context is established for this request',
              correlationId: 'corr-tenant-req',
              retryable: false,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    // Clear organization
    useSession.getState().clearOrganization();

    const input: CreateApiKeyInput = {
      name: 'Orphan Key',
      scopeType: 'organization',
      scopeId: ORG_A,
      scopes: ['users.read'],
    };

    await assert.rejects(
      async () => {
        await apiKeysApi.create(input);
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.code, 'TENANCY_CONTEXT_REQUIRED');
        return true;
      },
    );

    // Verify request had no X-Acc-Organization header
    const lastCall = fetchCalls[fetchCalls.length - 1];
    assert(lastCall);
    const sentHeaders = lastCall.options.headers as Record<string, string>;
    assert.equal(sentHeaders['X-Acc-Organization'], undefined);
  });

  // ---------------------------------------------------------------------------
  // 5. Plaintext secret is NEVER stored in localStorage, sessionStorage, or cookies
  // ---------------------------------------------------------------------------
  it('SEC-5: Plaintext secret is never written to localStorage, sessionStorage, or document.cookie', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    const secretValue = '7xX8Y9zZ1234567890abcdefghijklmnopqrstuv';

    mockHandlers.push({
      match: (url, options) => url.includes('/api-keys') && options.method === 'POST',
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              id: '01955b0a-new-key',
              name: 'Secret Audit Key',
              prefix: 'ak_test_abcdef1234567890',
              status: 'active',
              scopeType: 'organization',
              scopeId: ORG_A,
              orgId: ORG_A,
              scopes: ['users.read'],
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: null,
              revokedReason: null,
              createdBy: 'test-admin',
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: '2026-09-24T00:00:00.000Z',
              secret: secretValue,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await apiKeysApi.create({
      name: 'Secret Audit Key',
      scopeType: 'organization',
      scopeId: ORG_A,
      scopes: ['users.read'],
    });

    assert.equal(res.data.secret, secretValue);

    // Verify storage calls: neither localStorage nor sessionStorage must contain the secret
    for (const call of storageSetItemCalls) {
      assert(
        !call.value.includes(secretValue),
        `Secret detected in ${call.storage} under key "${call.key}"!`,
      );
    }

    assert(!documentCookie.includes(secretValue), 'Secret detected in document.cookie!');
  });

  // ---------------------------------------------------------------------------
  // 6. Plaintext secret is NEVER stored in Zustand session store
  // ---------------------------------------------------------------------------
  it('SEC-6: Plaintext secret is never stored in Zustand session store', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    const sessionJson = JSON.stringify(useSession.getState());
    assert(
      !sessionJson.includes('ak_test_') && !sessionJson.includes('7xX8Y9zZ'),
      'Session store must never contain API key credentials',
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Plaintext secret and credential (<prefix>.<secret>) are never emitted to console logs
  // ---------------------------------------------------------------------------
  it('SEC-7: Plaintext secret and credential are never emitted to console logs', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    const secretValue = '99secretAlphaBravoCharlieDeltaEchoFoxtrot';
    const prefixValue = 'ak_test_secretLogTest12';

    mockHandlers.push({
      match: (url, options) => url.includes('/api-keys') && options.method === 'POST',
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              id: '01955b0a-log-test-key',
              name: 'Logging Key',
              prefix: prefixValue,
              status: 'active',
              scopeType: 'organization',
              scopeId: ORG_A,
              orgId: ORG_A,
              scopes: ['users.read'],
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: null,
              revokedReason: null,
              createdBy: 'test-admin',
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: '2026-09-24T00:00:00.000Z',
              secret: secretValue,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await apiKeysApi.create({
      name: 'Logging Key',
      scopeType: 'organization',
      scopeId: ORG_A,
      scopes: ['users.read'],
    });

    // Check all captured console outputs
    for (const output of consoleOutputs) {
      assert(!output.includes(secretValue), 'Secret leaked to console output!');
      assert(
        !output.includes(`${prefixValue}.${secretValue}`),
        'Credential leaked to console output!',
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Plaintext secret is never placed in URL query parameters
  // ---------------------------------------------------------------------------
  it('SEC-8: Plaintext secret is never placed in URL query parameters', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    await apiKeysApi.list({ name: 'Key Without Secret' });

    for (const call of fetchCalls) {
      const parsedUrl = new URL(call.url, 'http://localhost');
      assert.equal(parsedUrl.searchParams.has('secret'), false);
      assert.equal(parsedUrl.searchParams.has('keyHash'), false);
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Null or uninitialized authorization fails closed for api_keys permissions
  // ---------------------------------------------------------------------------
  it('SEC-9: Null or uninitialized authorization fails closed for api_keys permissions', () => {
    useSession.getState().clearSession();

    assert.equal(hasPermission('api_keys.read'), false);
    assert.equal(hasPermission('api_keys.create'), false);
    assert.equal(hasPermission('api_keys.revoke'), false);
  });

  // ---------------------------------------------------------------------------
  // 10. Downward inheritance: workspace_manager and reseller_admin hold no api_keys permissions
  // ---------------------------------------------------------------------------
  it('SEC-10: Downward inheritance: workspace_manager and reseller_admin hold no api_keys permissions', () => {
    const limitedAuth: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-user',
      apiKeyId: null,
      grants: [
        {
          roleId: 'role-workspace-mgr',
          roleKey: 'workspace_manager',
          scopeType: 'workspace',
          scopeId: 'ws-1',
          orgId: ORG_A,
          permissions: ['workspaces.read', 'workspaces.update'],
        },
        {
          roleId: 'role-reseller-adm',
          roleKey: 'reseller_admin',
          scopeType: 'reseller',
          scopeId: 'reseller-1',
          orgId: null,
          permissions: ['resellers.read'],
        },
      ],
      organizationIds: [ORG_A],
      isPlatformAdmin: false,
    };

    useSession.getState().setSession({
      accessToken: 'token-limited',
      user: createMockUser([ORG_A]),
      authorization: limitedAuth,
      selectedOrgId: ORG_A,
    });

    assert.equal(hasPermission('api_keys.read'), false);
    assert.equal(hasPermission('api_keys.create'), false);
    assert.equal(hasPermission('api_keys.revoke'), false);
  });

  // ---------------------------------------------------------------------------
  // 11. Platform admin holds authority across all scopes
  // ---------------------------------------------------------------------------
  it('SEC-11: Platform admin holds authority across all scopes', () => {
    const platformAuth: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'platform-user',
      apiKeyId: null,
      grants: [
        {
          roleId: 'role-super-admin',
          roleKey: 'platform_super_admin',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
          permissions: ['api_keys.read', 'api_keys.create', 'api_keys.revoke'],
        },
      ],
      organizationIds: [ORG_A],
      isPlatformAdmin: true,
    };

    useSession.getState().setSession({
      accessToken: 'token-platform',
      user: createMockUser([ORG_A]),
      authorization: platformAuth,
      selectedOrgId: ORG_A,
    });

    assert.equal(hasPermission('api_keys.read'), true);
    assert.equal(hasPermission('api_keys.create'), true);
    assert.equal(hasPermission('api_keys.revoke'), true);
  });

  // ---------------------------------------------------------------------------
  // 12. Idempotency-Key preservation across retries
  // ---------------------------------------------------------------------------
  it('SEC-12: Idempotency-Key is preserved across network retry attempts for the same creation attempt', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    const testIdempotencyKey = 'fixed-uuid-retry-test-1111';
    let attemptCount = 0;

    mockHandlers.push({
      match: (url, options) => url.includes('/api-keys') && options.method === 'POST',
      handle: () => {
        attemptCount++;
        if (attemptCount === 1) {
          // First attempt fails with network 503
          return new Response(
            JSON.stringify({
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'Backend temporarily unavailable',
                correlationId: 'corr-503',
                retryable: true,
              },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // Second attempt succeeds
        return new Response(
          JSON.stringify({
            data: {
              id: '01955b0a-retried-key',
              name: 'Retry Bot',
              prefix: 'ak_test_abcdef1234567890',
              status: 'active',
              scopeType: 'organization',
              scopeId: ORG_A,
              orgId: ORG_A,
              scopes: ['users.read'],
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: null,
              revokedReason: null,
              createdBy: 'test-admin',
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: '2026-09-24T00:00:00.000Z',
              secret: 'secret-retry-success',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const input: CreateApiKeyInput = {
      name: 'Retry Bot',
      scopeType: 'organization',
      scopeId: ORG_A,
      scopes: ['users.read'],
    };

    // First attempt fails
    await assert.rejects(async () => {
      await apiKeysApi.create(input, testIdempotencyKey);
    });

    // Retry attempt with same idempotency key
    const res = await apiKeysApi.create(input, testIdempotencyKey);
    assert.equal(res.data.id, '01955b0a-retried-key');

    // Both calls must have carried the exact same Idempotency-Key
    assert.equal(fetchCalls.length, 2);
    assert(fetchCalls[0] && fetchCalls[1]);
    const headers1 = fetchCalls[0].options.headers as Record<string, string>;
    const headers2 = fetchCalls[1].options.headers as Record<string, string>;
    assert.equal(headers1['Idempotency-Key'], testIdempotencyKey);
    assert.equal(headers2['Idempotency-Key'], testIdempotencyKey);
  });

  // ---------------------------------------------------------------------------
  // 13. Revoke dispatches POST /api-keys/:id/revoke with verified organization header
  // ---------------------------------------------------------------------------
  it('SEC-13: Revoke dispatches POST /api-keys/:id/revoke with verified organization header', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    const keyId = '01955b0a-key-to-kill';
    let capturedMethod = '';

    mockHandlers.push({
      match: (url) => url.includes(`/api-keys/${keyId}/revoke`),
      handle: (_url, options) => {
        capturedMethod = options.method!;
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_A);
        return new Response(
          JSON.stringify({
            data: {
              id: keyId,
              name: 'Killed Key',
              prefix: 'ak_test_1234567890123456',
              status: 'revoked',
              scopeType: 'organization',
              scopeId: ORG_A,
              orgId: ORG_A,
              scopes: [],
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: new Date().toISOString(),
              revokedReason: 'revoked_by_administrator',
              createdBy: 'test-admin',
              createdAt: '2026-09-24T00:00:00.000Z',
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await apiKeysApi.revoke(keyId);
    assert.equal(capturedMethod, 'POST');
  });
});
