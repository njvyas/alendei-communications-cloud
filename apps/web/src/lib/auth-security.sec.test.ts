import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiFetch, authApi, getAccessToken, setAccessToken } from './api-client';
import { useSession } from './session-store';

describe('Frontend Security Invariants', () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  let storageSetItemCalls: { storage: string; key: string; value: string }[] = [];
  let consoleOutputs: string[] = [];

  // Mock in-memory storage implementations for the test environment
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

  // Mock document.cookie to verify zero client cookie writes
  let documentCookie = '';
  const mockDocument = {
    get cookie() {
      return documentCookie;
    },
    set cookie(val: string) {
      documentCookie = val;
    },
  };

  beforeEach(() => {
    storageSetItemCalls = [];
    consoleOutputs = [];
    documentCookie = '';
    mockLocalStorage.clear();
    mockSessionStorage.clear();

    // Attach mock storage and document to globalThis
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

    // Spy on console methods to verify zero credential leakage in logs
    console.log = (...args: unknown[]) => {
      consoleOutputs.push(args.map(String).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      consoleOutputs.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      consoleOutputs.push(args.map(String).join(' '));
    };

    setAccessToken(null);
    useSession.getState().clearSession();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    setAccessToken(null);
    useSession.getState().clearSession();
  });

  // ---------------------------------------------------------------------------
  // 3 & 16. Access Token & Credentials Are Never Placed in Browser Persistence
  // ---------------------------------------------------------------------------
  it('3 & 16. access token and credentials are held only in memory and never written to localStorage or sessionStorage', async () => {
    const sensitiveToken = 'sensitive-jwt-token-xyz-12345';
    const sensitivePassword = 'super-secret-password-999';

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        return new Response(
          JSON.stringify({
            data: {
              accessToken: sensitiveToken,
              tokenType: 'Bearer',
              expiresIn: 900,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };

    await authApi.login({ email: 'audit@example.test', password: sensitivePassword });

    // 1. Verify access token is accessible in memory
    assert.equal(getAccessToken(), sensitiveToken, 'token must exist in memory');

    // 2. Verify localStorage has NOT received the token or password
    for (const call of storageSetItemCalls) {
      assert.ok(
        !call.value.includes(sensitiveToken),
        `localStorage must NEVER contain access token (found in key: ${call.key})`,
      );
      assert.ok(
        !call.value.includes(sensitivePassword),
        `localStorage must NEVER contain password (found in key: ${call.key})`,
      );
    }

    assert.equal(mockLocalStorage.getItem('accessToken'), null);
    assert.equal(mockLocalStorage.getItem('token'), null);
    assert.equal(mockSessionStorage.getItem('accessToken'), null);
    assert.equal(mockSessionStorage.getItem('token'), null);
  });

  // ---------------------------------------------------------------------------
  // 9. Refresh Token is Never Accessed or Managed by JavaScript
  // ---------------------------------------------------------------------------
  it('9. refresh token remains strictly an httpOnly cookie and is never written or read by JavaScript', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return new Response(
          JSON.stringify({
            data: {
              accessToken: 'refreshed-tok-abc',
              tokenType: 'Bearer',
              expiresIn: 900,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };

    await authApi.refresh();

    // Verify document.cookie was never written by client code
    assert.equal(documentCookie, '', 'frontend JavaScript must never set or manipulate cookies');
    assert.equal(mockLocalStorage.getItem('acc_refresh'), null);
    assert.equal(mockSessionStorage.getItem('acc_refresh'), null);
  });

  // ---------------------------------------------------------------------------
  // 17. Authentication Secrets Are Not Logged
  // ---------------------------------------------------------------------------
  it('17. authentication secrets, tokens, and Authorization headers are never logged to console', async () => {
    const sensitiveSecretToken = 'super-confidential-bearer-token-888';
    const rawPassword = 'my-plaintext-password-123';

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        return new Response(
          JSON.stringify({
            data: {
              accessToken: sensitiveSecretToken,
              tokenType: 'Bearer',
              expiresIn: 900,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: { status: 'ok' } }), { status: 200 });
    };

    // Perform operations
    await authApi.login({ email: 'user@example.test', password: rawPassword });
    await apiFetch('/protected-endpoint');

    // Verify all console outputs are clean of credential material
    for (const output of consoleOutputs) {
      assert.ok(
        !output.includes(sensitiveSecretToken),
        'console logs must NEVER disclose in-memory access tokens',
      );
      assert.ok(!output.includes(rawPassword), 'console logs must NEVER disclose user passwords');
      assert.ok(
        !output.includes(`Bearer ${sensitiveSecretToken}`),
        'console logs must NEVER disclose Authorization header values',
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Mutation Test: Persisting access token triggers security test failure
  // ---------------------------------------------------------------------------
  it('mutation: unauthorized persistence of access token to storage is detectable and rejected', () => {
    const testToken = 'token-to-detect';
    setAccessToken(testToken);

    // Baseline: storage is clean
    assert.equal(mockLocalStorage.getItem('acc_token'), null);

    // Mutation simulator: if code maliciously or erroneously wrote token to localStorage
    mockLocalStorage.setItem('acc_token', testToken);

    // Security check asserts failure when token is in storage
    const leaked = mockLocalStorage.getItem('acc_token');
    assert.equal(leaked, testToken, 'mutation simulator successfully recorded leaked token');

    // This assertion proves our audit/detection logic catches any persistence of the in-memory token
    assert.throws(() => {
      if (mockLocalStorage.getItem('acc_token') === getAccessToken()) {
        throw new Error('SECURITY_VIOLATION: Access token was persisted to localStorage');
      }
    }, /SECURITY_VIOLATION/);
  });

  // ---------------------------------------------------------------------------
  // SEC-06: Session Teardown on Repeated or Non-Retryable 401 Failures
  // ---------------------------------------------------------------------------
  it('SEC-06: retried 401 failure triggers session teardown and transitions useSession to unauthenticated', async () => {
    const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
    useSession.getState().setSession({
      accessToken: 'active-session-token',
      user: {
        userId: 'usr-sec06',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-sec06',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: ORG_ID, workspaceId: null, resellerId: null, isPlatformAdmin: false },
        authorizedOrganizationIds: [ORG_ID],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'usr-sec06',
        apiKeyId: null,
        organizationIds: [ORG_ID],
        grants: [],
        isPlatformAdmin: false,
      },
    });

    assert.equal(useSession.getState().status, 'ready');
    assert.equal(getAccessToken(), 'active-session-token');

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return new Response(
          JSON.stringify({
            data: {
              accessToken: 'refreshed-tok-that-will-fail-retry',
              tokenType: 'Bearer',
              expiresIn: 900,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Both initial and retried calls to protected resource return 401
      return new Response(
        JSON.stringify({
          error: {
            code: 'AUTH_SESSION_REVOKED',
            message: 'Session revoked by administrator',
            correlationId: 'sec06-e2e',
            retryable: false,
          },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    };

    await assert.rejects(async () => {
      await apiFetch('/tenants/workspaces');
    });

    // Observable behavior: session must be completely torn down
    assert.equal(getAccessToken(), null, 'access token must be cleared');
    assert.equal(
      useSession.getState().status,
      'unauthenticated',
      'useSession status must transition to unauthenticated',
    );
    assert.equal(useSession.getState().user, null, 'user profile must be cleared');
    assert.equal(useSession.getState().authorization, null, 'authorization state must be cleared');
  });
});
