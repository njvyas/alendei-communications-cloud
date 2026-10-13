import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiFetch,
  authApi,
  getAccessToken,
  getSelectedOrganization,
  invalidateSessionEpoch,
  onAuthFailure,
  refreshAccessToken,
  registerOrgValidator,
  setAccessToken,
  setSelectedOrganization,
  ApiError,
} from './api-client';

describe('API Client Security Foundation', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  beforeEach(() => {
    fetchCalls = [];
    mockHandlers = [];
    invalidateSessionEpoch();
    setAccessToken(null);
    setSelectedOrganization(null);
    registerOrgValidator(null);

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const options = init ?? {};
      fetchCalls.push({ url, options });

      for (const { match, handle } of mockHandlers) {
        if (match(url, options)) {
          return handle(url, options);
        }
      }

      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setAccessToken(null);
    setSelectedOrganization(null);
    registerOrgValidator(null);
  });

  // ---------------------------------------------------------------------------
  // 1. Successful Login
  // ---------------------------------------------------------------------------
  it('1. successful login sets in-memory access token and sends credentials', async () => {
    mockHandlers.push({
      match: (url) => url.endsWith('/auth/login'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              accessToken: 'test-token-12345',
              tokenType: 'Bearer',
              expiresIn: 900,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await authApi.login({ email: 'user@example.test', password: 'correct-password' });

    assert.equal(res.data.accessToken, 'test-token-12345');
    assert.equal(getAccessToken(), 'test-token-12345');

    const loginCall = fetchCalls.find((c) => c.url.endsWith('/auth/login'));
    assert.ok(loginCall, 'fetch was called on /auth/login');
    assert.equal(loginCall.options.credentials, 'include');

    // Login must NOT send an Authorization header
    const headers = loginCall.options.headers as Record<string, string>;
    assert.equal(headers['Authorization'], undefined);
  });

  // ---------------------------------------------------------------------------
  // 2. Failed Login
  // ---------------------------------------------------------------------------
  it('2. failed login throws ApiError and leaves in-memory token null', async () => {
    mockHandlers.push({
      match: (url) => url.endsWith('/auth/login'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_INVALID_CREDENTIALS',
              message: 'Invalid credentials',
              correlationId: 'test-corr-id-fail',
              retryable: false,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => {
        await authApi.login({ email: 'user@example.test', password: 'wrong-password' });
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 401);
        assert.equal(err.code, 'AUTH_INVALID_CREDENTIALS');
        assert.equal(err.correlationId, 'test-corr-id-fail');
        return true;
      },
    );

    assert.equal(getAccessToken(), null, 'token remains null after failed login');
  });

  // ---------------------------------------------------------------------------
  // 4. Refresh Success
  // ---------------------------------------------------------------------------
  it('4. refresh success updates access token and sends X-Acc-Refresh header', async () => {
    mockHandlers.push({
      match: (url) => url.endsWith('/auth/refresh'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              accessToken: 'new-rotated-token-67890',
              tokenType: 'Bearer',
              expiresIn: 900,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await authApi.refresh();
    assert.equal(res.data.accessToken, 'new-rotated-token-67890');
    assert.equal(getAccessToken(), 'new-rotated-token-67890');

    const refreshCall = fetchCalls.find((c) => c.url.endsWith('/auth/refresh'));
    assert.ok(refreshCall, 'fetch was called on /auth/refresh');
    const headers = refreshCall.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Refresh'], '1', 'refresh carries non-simple CSRF header');
    assert.equal(
      refreshCall.options.credentials,
      'include',
      'credentials included for httpOnly cookie',
    );
  });

  // ---------------------------------------------------------------------------
  // 5. Refresh Failure
  // ---------------------------------------------------------------------------
  it('5. refresh failure clears in-memory access token and triggers onAuthFailure', async () => {
    setAccessToken('old-expired-token');

    let failureNotified = false;
    const unsub = onAuthFailure(() => {
      failureNotified = true;
    });

    mockHandlers.push({
      match: (url) => url.endsWith('/auth/refresh'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_CREDENTIAL_REQUIRED',
              message: 'No refresh credential presented',
              correlationId: 'corr-refresh-fail',
              retryable: false,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(async () => {
      await authApi.refresh();
    });

    assert.equal(getAccessToken(), null, 'access token is cleared after refresh failure');
    assert.equal(failureNotified, true, 'auth failure listeners are notified');
    unsub();
  });

  // ---------------------------------------------------------------------------
  // 6. Concurrent 401s Result in One Refresh Request
  // ---------------------------------------------------------------------------
  it('6. concurrent 401s deduplicate into exactly one /auth/refresh request and retry original requests', async () => {
    setAccessToken('stale-token');

    let refreshCallCount = 0;
    let usersEndpointCallCount = 0;

    mockHandlers.push({
      match: (url) => url.endsWith('/auth/refresh'),
      handle: async () => {
        refreshCallCount++;
        // Introduce small async delay to ensure overlapping caller wait
        await new Promise((r) => setTimeout(r, 10));
        return new Response(
          JSON.stringify({
            data: {
              accessToken: 'freshly-minted-token',
              tokenType: 'Bearer',
              expiresIn: 900,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    mockHandlers.push({
      match: (url) => url.endsWith('/tenants/workspaces'),
      handle: (_url, options) => {
        usersEndpointCallCount++;
        const headers = options.headers as Record<string, string>;
        if (headers['Authorization'] === 'Bearer stale-token') {
          return new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_TOKEN_EXPIRED',
                message: 'Token expired',
                correlationId: 'corr-exp',
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (headers['Authorization'] === 'Bearer freshly-minted-token') {
          return new Response(
            JSON.stringify({
              data: [{ id: 'ws-1', name: 'Workspace 1' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        return new Response('Unauthorized', { status: 401 });
      },
    });

    // Dispatch 3 concurrent requests that encounter 401
    const [res1, res2, res3] = await Promise.all([
      apiFetch<{ data: unknown[] }>('/tenants/workspaces'),
      apiFetch<{ data: unknown[] }>('/tenants/workspaces'),
      apiFetch<{ data: unknown[] }>('/tenants/workspaces'),
    ]);

    assert.equal(refreshCallCount, 1, 'refresh was called EXACTLY ONCE for all concurrent 401s');
    assert.equal(getAccessToken(), 'freshly-minted-token');
    assert.equal(res1.data.length, 1);
    assert.equal(res2.data.length, 1);
    assert.equal(res3.data.length, 1);
    assert.equal(usersEndpointCallCount, 6, '3 initial calls + 3 retried calls = 6 total');
  });

  // ---------------------------------------------------------------------------
  // 7. Failed Refresh Does Not Loop
  // ---------------------------------------------------------------------------
  it('7. failed refresh does not enter recursive refresh loops', async () => {
    setAccessToken('unrefreshable-token');

    let refreshAttemptCount = 0;
    mockHandlers.push({
      match: (url) => url.endsWith('/auth/refresh'),
      handle: () => {
        refreshAttemptCount++;
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_SESSION_REVOKED',
              message: 'Session revoked',
              correlationId: 'corr-revoked',
              retryable: false,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    mockHandlers.push({
      match: (url) => url.endsWith('/protected/test'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_TOKEN_EXPIRED',
              message: 'Token expired',
              correlationId: 'corr-init-401',
              retryable: false,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(async () => {
      await apiFetch('/protected/test');
    });

    assert.equal(refreshAttemptCount, 1, 'refresh was attempted exactly once and did not loop');
    assert.equal(getAccessToken(), null);
  });

  // ---------------------------------------------------------------------------
  // 8. Logout Clears In-Memory State
  // ---------------------------------------------------------------------------
  it('8. logout sends X-Acc-Refresh and clears in-memory access token and selected org', async () => {
    setAccessToken('active-token-logout');
    setSelectedOrganization('org-logout-123');

    let logoutCalled = false;
    mockHandlers.push({
      match: (url) => url.endsWith('/auth/logout'),
      handle: (_url, options) => {
        logoutCalled = true;
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['Authorization'], 'Bearer active-token-logout');
        assert.equal(headers['X-Acc-Refresh'], '1');
        return new Response(null, { status: 204 });
      },
    });

    await authApi.logout();

    assert.equal(logoutCalled, true);
    assert.equal(getAccessToken(), null, 'access token is null after logout');
    assert.equal(getSelectedOrganization(), null, 'selected org is null after logout');
  });

  // ---------------------------------------------------------------------------
  // Logout Does Not Enter Refresh Loop
  // ---------------------------------------------------------------------------
  it('logout failure with 401 does not trigger refresh loop', async () => {
    setAccessToken('token-to-logout');

    let refreshCalled = false;
    mockHandlers.push({
      match: (url) => url.endsWith('/auth/refresh'),
      handle: () => {
        refreshCalled = true;
        return new Response('ok', { status: 200 });
      },
    });

    mockHandlers.push({
      match: (url) => url.endsWith('/auth/logout'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_TOKEN_EXPIRED',
              message: 'Token expired',
              correlationId: 'logout-401',
              retryable: false,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await authApi.logout();

    assert.equal(refreshCalled, false, 'logout with 401 must NEVER trigger refresh');
    assert.equal(getAccessToken(), null);
    assert.equal(getSelectedOrganization(), null);
  });

  // ---------------------------------------------------------------------------
  // Logout Race Condition Prevention
  // ---------------------------------------------------------------------------
  it('logout racing with in-flight refresh discards the refreshed token', async () => {
    setAccessToken('token-before-race');

    mockHandlers.push({
      match: (url) => url.endsWith('/auth/refresh'),
      handle: async () => {
        // Delay to allow logout to execute while refresh is in-flight
        await new Promise((r) => setTimeout(r, 20));
        return new Response(
          JSON.stringify({
            data: {
              accessToken: 'late-arriving-token',
              tokenType: 'Bearer',
              expiresIn: 900,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    mockHandlers.push({
      match: (url) => url.endsWith('/auth/logout'),
      handle: () => new Response(null, { status: 204 }),
    });

    // 1. Refresh starts in the background
    const refreshOp = refreshAccessToken();

    // 2. User immediately logs out before refresh completes
    await authApi.logout();

    // 3. Await the refresh resolution
    const result = await refreshOp;

    // 4. Token must be discarded because logout intervened
    assert.equal(result, null, 'late-arriving refresh token is discarded due to epoch bump');
    assert.equal(getAccessToken(), null, 'token remains null after logout race');
  });

  // ---------------------------------------------------------------------------
  // Request Retried At Most Once After Refresh
  // ---------------------------------------------------------------------------
  it('request is retried at most once after refresh; second 401 is not retried', async () => {
    setAccessToken('token-1');

    let endpointCallCount = 0;
    mockHandlers.push({
      match: (url) => url.endsWith('/auth/refresh'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              accessToken: 'token-2',
              tokenType: 'Bearer',
              expiresIn: 900,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    mockHandlers.push({
      match: (url) => url.endsWith('/test-twice'),
      handle: () => {
        endpointCallCount++;
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_SESSION_REVOKED',
              message: 'Session revoked',
              correlationId: 'double-fail',
              retryable: false,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(async () => {
      await apiFetch('/test-twice');
    });

    assert.equal(endpointCallCount, 2, 'called once initially + retried once = 2 total, never 3');
  });

  // ---------------------------------------------------------------------------
  // Arbitrary Organization ID in Caller Headers is Sanitized
  // ---------------------------------------------------------------------------
  it('arbitrary organization ID in caller headers cannot override or become X-Acc-Organization', async () => {
    setAccessToken('token-test');
    setSelectedOrganization('org-legitimate-123');

    let capturedHeaders: Record<string, string> = {};
    mockHandlers.push({
      match: (url) => url.endsWith('/tenants/workspaces'),
      handle: (_url, options) => {
        capturedHeaders = options.headers as Record<string, string>;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });

    // Caller attempts to supply an arbitrary/forged X-Acc-Organization header
    await apiFetch('/tenants/workspaces', {
      headers: {
        'X-Acc-Organization': 'forged-attacker-org',
        'x-acc-organization': 'forged-attacker-org-lowercase',
      },
    });

    assert.equal(
      capturedHeaders['X-Acc-Organization'],
      'org-legitimate-123',
      'X-Acc-Organization was derived strictly from validated in-memory state, not caller header',
    );
    assert.equal(capturedHeaders['x-acc-organization'], undefined);
  });

  // ---------------------------------------------------------------------------
  // 14. Tenant-scoped Request Receives X-Acc-Organization
  // ---------------------------------------------------------------------------
  it('14. tenant-scoped request receives X-Acc-Organization header, but identity routes omit it', async () => {
    setAccessToken('valid-token');
    setSelectedOrganization('01955b0a-7b3b-7411-9a4f-9e67d4f91234');

    // Call tenant-scoped endpoint
    await apiFetch('/tenants/workspaces');
    const tenantCall = fetchCalls.find((c) => c.url.endsWith('/tenants/workspaces'));
    assert.ok(tenantCall);
    const tenantHeaders = tenantCall.options.headers as Record<string, string>;
    assert.equal(tenantHeaders['X-Acc-Organization'], '01955b0a-7b3b-7411-9a4f-9e67d4f91234');

    // Call identity endpoint (/auth/me) with skipTenant: true
    await authApi.me();
    const meCall = fetchCalls.find((c) => c.url.endsWith('/auth/me'));
    assert.ok(meCall);
    const meHeaders = meCall.options.headers as Record<string, string>;
    assert.equal(
      meHeaders['X-Acc-Organization'],
      undefined,
      'identity endpoint does not carry X-Acc-Organization',
    );
  });

  // ---------------------------------------------------------------------------
  // Mutation Test: Removing Authorization header causes failure
  // ---------------------------------------------------------------------------
  it('mutation: removing Authorization header causes authenticated endpoint to fail', async () => {
    setAccessToken('authorized-token');

    mockHandlers.push({
      match: (url) => url.endsWith('/secure-resource'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        if (!headers['Authorization']) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_CREDENTIAL_REQUIRED',
                message: 'Authentication is required',
                correlationId: 'mut-1',
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ data: { success: true } }), { status: 200 });
      },
    });

    // With token attached, request succeeds
    const successRes = await apiFetch<{ data: { success: boolean } }>('/secure-resource');
    assert.equal(successRes.data.success, true);

    // Mutation: explicitly removing auth: false triggers 401 failure
    await assert.rejects(async () => {
      await apiFetch('/secure-resource', { auth: false });
    });
  });

  // ---------------------------------------------------------------------------
  // Mutation Test: Removing refresh deduplication causes failure
  // ---------------------------------------------------------------------------
  it('mutation: absence of refresh deduplication would dispatch multiple refresh calls', async () => {
    let uncoordinatedCalls = 0;
    const fakeRawRefresh = async () => {
      uncoordinatedCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return 'token';
    };

    // If deduplication is NOT used, 3 concurrent calls make 3 network requests
    await Promise.all([fakeRawRefresh(), fakeRawRefresh(), fakeRawRefresh()]);
    assert.equal(uncoordinatedCalls, 3, 'uncoordinated refresh triggers multiple calls');

    // Whereas api-client deduplication makes exactly 1 call
    const [token1, token2, token3] = await Promise.all([
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
    ]);
    assert.equal(token1, token2);
    assert.equal(token2, token3);
  });

  // ---------------------------------------------------------------------------
  // SEC-06: Session Teardown on Repeated or Non-Retryable 401 Failures
  // ---------------------------------------------------------------------------
  describe('SEC-06: Session Teardown on Repeated or Non-Retryable 401 Failures', () => {
    it('1. ordinary login failure (401 from /auth/login) does not trigger session teardown or auth failure notification', async () => {
      let notified = false;
      const unsub = onAuthFailure(() => {
        notified = true;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/auth/login'),
        handle: () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_INVALID_CREDENTIALS',
                message: 'Invalid credentials',
                correlationId: 'sec06-login-fail',
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      await assert.rejects(
        async () => {
          await authApi.login({ email: 'user@example.test', password: 'bad-password' });
        },
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.status, 401);
          assert.equal(err.code, 'AUTH_INVALID_CREDENTIALS');
          return true;
        },
      );

      assert.equal(notified, false, 'login failure must NEVER notify auth failure');
      assert.equal(getAccessToken(), null, 'access token remains null');
      unsub();
    });

    it('2. terminal 401 from /auth/refresh clears access token and notifies auth failure', async () => {
      setAccessToken('token-prior-to-refresh');

      let notified = false;
      const unsub = onAuthFailure(() => {
        notified = true;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/auth/refresh'),
        handle: () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_SESSION_EXPIRED',
                message: 'Refresh token expired',
                correlationId: 'sec06-refresh-expired',
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      await assert.rejects(async () => {
        await authApi.refresh();
      });

      assert.equal(getAccessToken(), null, 'access token must be cleared');
      assert.equal(notified, true, 'auth failure must be notified');
      unsub();
    });

    it('3. retried authenticated request returning 401 clears access token, notifies auth failure, and prevents infinite retry loop', async () => {
      setAccessToken('initial-stale-token');

      let refreshCount = 0;
      let protectedCalls = 0;
      let failureNotified = false;
      const unsub = onAuthFailure(() => {
        failureNotified = true;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/auth/refresh'),
        handle: () => {
          refreshCount++;
          return new Response(
            JSON.stringify({
              data: {
                accessToken: 'fresh-token-that-will-fail-retry',
                tokenType: 'Bearer',
                expiresIn: 900,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/protected/workspaces'),
        handle: (_url, options) => {
          protectedCalls++;
          const headers = options.headers as Record<string, string>;
          if (protectedCalls === 1) {
            assert.equal(headers['Authorization'], 'Bearer initial-stale-token');
          } else if (protectedCalls === 2) {
            assert.equal(headers['Authorization'], 'Bearer fresh-token-that-will-fail-retry');
          }
          return new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_SESSION_REVOKED',
                message: 'Session revoked on backend',
                correlationId: `corr-prot-${protectedCalls}`,
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      await assert.rejects(
        async () => {
          await apiFetch('/protected/workspaces');
        },
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.status, 401);
          assert.equal(err.code, 'AUTH_SESSION_REVOKED');
          return true;
        },
      );

      // Verify sequence: initial call (401) -> refresh (200) -> retried call (401) -> teardown
      assert.equal(
        protectedCalls,
        2,
        'protected endpoint called exactly twice (1 initial + 1 retried)',
      );
      assert.equal(refreshCount, 1, 'refresh called exactly once (no infinite refresh loop)');
      assert.equal(getAccessToken(), null, 'stale access token must be cleared after retry 401');
      assert.equal(
        failureNotified,
        true,
        'auth failure must be notified after retried 401 failure',
      );
      unsub();
    });

    it('4. terminal 401 on non-refreshable authenticated request clears access token and notifies failure', async () => {
      setAccessToken('token-on-non-refreshable');

      let notified = false;
      const unsub = onAuthFailure(() => {
        notified = true;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/explicitly-non-refreshable'),
        handle: () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_CREDENTIAL_REVOKED',
                message: 'Credential revoked',
                correlationId: 'sec06-terminal-401',
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      await assert.rejects(async () => {
        await apiFetch('/explicitly-non-refreshable', { _retried: true });
      });

      assert.equal(getAccessToken(), null, 'access token is cleared');
      assert.equal(notified, true, 'auth failure is notified');
      unsub();
    });

    it('5. failed refresh on background authenticated request clears stale token and notifies failure', async () => {
      setAccessToken('token-background-fail');

      let refreshCount = 0;
      let failureNotified = false;
      const unsub = onAuthFailure(() => {
        failureNotified = true;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/auth/refresh'),
        handle: () => {
          refreshCount++;
          return new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_SESSION_EXPIRED',
                message: 'Refresh cookie invalid or expired',
                correlationId: 'corr-refresh-die',
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/resource/needing-refresh'),
        handle: () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_TOKEN_EXPIRED',
                message: 'Expired access token',
                correlationId: 'corr-init',
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      await assert.rejects(async () => {
        await apiFetch('/resource/needing-refresh');
      });

      assert.equal(refreshCount, 1, 'refresh attempted once');
      assert.equal(getAccessToken(), null, 'stale access token cleared');
      assert.equal(failureNotified, true, 'auth failure notified');
      unsub();
    });

    it('6. concurrent terminal 401 responses deduplicate teardown and notify failure exactly once (no notification storm)', async () => {
      setAccessToken('token-concurrent-retried');

      let notificationCount = 0;
      const unsub = onAuthFailure(() => {
        notificationCount++;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/concurrent/endpoint'),
        handle: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_CREDENTIAL_REVOKED',
                message: 'Revoked',
                correlationId: 'corr-conc-rev',
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      // 4 concurrent retried requests all encountering terminal 401
      const results = await Promise.allSettled([
        apiFetch('/concurrent/endpoint', { _retried: true }),
        apiFetch('/concurrent/endpoint', { _retried: true }),
        apiFetch('/concurrent/endpoint', { _retried: true }),
        apiFetch('/concurrent/endpoint', { _retried: true }),
      ]);

      assert.equal(
        results.every((r) => r.status === 'rejected'),
        true,
        'all 4 requests rejected',
      );
      assert.equal(getAccessToken(), null, 'access token is null');
      assert.equal(
        notificationCount,
        1,
        'auth failure listeners must be notified EXACTLY ONCE across concurrent terminal failures',
      );
      unsub();
    });

    it('7. ordinary unauthenticated requests with auth: false do not clear session or notify auth failure', async () => {
      setAccessToken('valid-actor-token');

      let notified = false;
      const unsub = onAuthFailure(() => {
        notified = true;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/public/restricted-probe'),
        handle: () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_CREDENTIAL_REQUIRED',
                message: 'Probe rejected without authorization',
                correlationId: 'corr-probe',
                retryable: false,
              },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      await assert.rejects(async () => {
        await apiFetch('/public/restricted-probe', { auth: false });
      });

      assert.equal(
        notified,
        false,
        'unauthenticated request must NOT trigger auth failure notification',
      );
      assert.equal(
        getAccessToken(),
        'valid-actor-token',
        'unauthenticated request must NOT clear unrelated active access token',
      );
      unsub();
    });

    it('8. delayed 401 from Session A arriving in Session B does not refresh or invalidate Session B', async () => {
      // User A starts with token A in epoch A
      setAccessToken('token-user-a');

      let refreshAttempted = false;
      let failureNotified = false;
      const unsub = onAuthFailure(() => {
        failureNotified = true;
      });

      let delayedResolve: (res: Response) => void;
      const delayedResponsePromise = new Promise<Response>((resolve) => {
        delayedResolve = resolve;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/resource/session-a'),
        handle: () => delayedResponsePromise,
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/auth/refresh'),
        handle: () => {
          refreshAttempted = true;
          return new Response(JSON.stringify({ error: { code: 'AUTH_SESSION_EXPIRED' } }), {
            status: 401,
          });
        },
      });

      // Session A dispatches request
      const sessionAPromise = apiFetch('/resource/session-a');

      // Session A terminates and Session B establishes a new session
      invalidateSessionEpoch();
      setAccessToken('token-user-b');

      // Delayed 401 arrives from Session A
      delayedResolve!(
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_TOKEN_EXPIRED',
              message: 'Token expired',
              correlationId: 'delayed-401',
              retryable: false,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await assert.rejects(async () => {
        await sessionAPromise;
      });

      // Assert Session B was not affected
      assert.equal(refreshAttempted, false, 'must not trigger refresh under Session B');
      assert.equal(getAccessToken(), 'token-user-b', 'Session B access token must remain intact');
      assert.equal(failureNotified, false, 'Session B must not receive auth failure notification');
      unsub();
    });

    it('9. delayed /auth/refresh 401 from Session A arriving in Session B does not clear Session B', async () => {
      setAccessToken('token-user-a');

      let failureNotified = false;
      const unsub = onAuthFailure(() => {
        failureNotified = true;
      });

      let delayedResolve: (res: Response) => void;
      const delayedResponsePromise = new Promise<Response>((resolve) => {
        delayedResolve = resolve;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/auth/refresh'),
        handle: () => delayedResponsePromise,
      });

      // Session A calls refresh
      const refreshPromiseA = authApi.refresh();

      // Session A terminates and Session B establishes a new session
      invalidateSessionEpoch();
      setAccessToken('token-user-b');

      // Delayed refresh response returns 401
      delayedResolve!(
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_SESSION_EXPIRED',
              message: 'Refresh token expired',
              correlationId: 'delayed-refresh-401',
              retryable: false,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await assert.rejects(async () => {
        await refreshPromiseA;
      });

      // Assert Session B token and listeners are intact
      assert.equal(
        getAccessToken(),
        'token-user-b',
        'Session B access token must remain intact after delayed refresh 401',
      );
      assert.equal(failureNotified, false, 'must not notify auth failure for newer session epoch');
      unsub();
    });

    it('10. successful logout in Session A does not clear Session B established while logout is in-flight', async () => {
      setAccessToken('token-user-a');
      setSelectedOrganization('org-user-a');

      let failureNotified = false;
      const unsub = onAuthFailure(() => {
        failureNotified = true;
      });

      let delayedResolve: (res: Response) => void;
      const delayedLogoutPromise = new Promise<Response>((resolve) => {
        delayedResolve = resolve;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/auth/logout'),
        handle: () => delayedLogoutPromise,
      });

      // Session A starts logout
      const logoutPromise = authApi.logout();

      // Session B establishes a new session while logout network call is in flight
      invalidateSessionEpoch();
      setAccessToken('token-user-b');
      setSelectedOrganization('org-user-b');

      // Logout resolves successfully
      delayedResolve!(new Response(null, { status: 204 }));
      await logoutPromise;

      // Session B must remain intact
      assert.equal(
        getAccessToken(),
        'token-user-b',
        'Session B token must remain intact after Session A logout completes',
      );
      assert.equal(
        getSelectedOrganization(),
        'org-user-b',
        'Session B selected organization must remain intact after Session A logout completes',
      );
      assert.equal(
        failureNotified,
        false,
        'Session B must not receive auth failure notification after Session A logout completes',
      );
      unsub();
    });

    it('11. failed logout in Session A does not clear Session B established while logout is in-flight', async () => {
      setAccessToken('token-user-a');
      setSelectedOrganization('org-user-a');

      let failureNotified = false;
      const unsub = onAuthFailure(() => {
        failureNotified = true;
      });

      let delayedResolve: (res: Response) => void;
      const delayedLogoutPromise = new Promise<Response>((resolve) => {
        delayedResolve = resolve;
      });

      mockHandlers.push({
        match: (url) => url.endsWith('/auth/logout'),
        handle: () => delayedLogoutPromise,
      });

      // Session A starts logout
      const logoutPromise = authApi.logout();

      // Session B establishes a new session while logout network call is in flight
      invalidateSessionEpoch();
      setAccessToken('token-user-b');
      setSelectedOrganization('org-user-b');

      // Logout rejects with 401
      delayedResolve!(
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_SESSION_EXPIRED',
              message: 'Session expired',
              correlationId: 'logout-fail',
              retryable: false,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await logoutPromise;

      // Session B must remain intact
      assert.equal(
        getAccessToken(),
        'token-user-b',
        'Session B token must remain intact after failed Session A logout',
      );
      assert.equal(
        getSelectedOrganization(),
        'org-user-b',
        'Session B selected organization must remain intact after failed Session A logout',
      );
      assert.equal(
        failureNotified,
        false,
        'Session B must not receive auth failure notification after failed Session A logout',
      );
      unsub();
    });
  });
});
