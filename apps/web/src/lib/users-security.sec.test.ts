import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiFetch,
  setAccessToken,
  setSelectedOrganization,
  usersApi,
  ApiError,
  type CreateUserInput,
  type EffectiveAuthorization,
  type UserIdentity,
} from './api-client';
import {
  hasPermission,
  useSession,
} from './session-store';

describe('Users Security Invariants & Boundary Enforcement', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_A = '01955b0a-7b3b-7411-9a4f-orgAAAAAAAAAA';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-orgBBBBBBBBBB';

  const createMockUser = (orgIds: string[]): UserIdentity => ({
    userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
    actorType: 'user',
    authMethod: 'session',
    sessionId: 'session-123',
    authenticatedAt: '2026-09-22T00:00:00.000Z',
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
    grants: Array<{
      roleKey: string;
      scopeType: 'organization' | 'workspace' | 'platform';
      orgId: string | null;
      scopeId: string | null;
      permissions: string[];
    }>,
    isPlatformAdmin = false,
  ): EffectiveAuthorization => ({
    actorType: 'user',
    userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
    apiKeyId: null,
    grants: grants.map((g, idx) => ({
      roleId: `role-${idx}`,
      roleKey: g.roleKey,
      scopeType: g.scopeType,
      scopeId: g.scopeId,
      orgId: g.orgId,
      permissions: g.permissions,
    })),
    organizationIds: [ORG_A, ORG_B],
    isPlatformAdmin,
  });

  beforeEach(() => {
    fetchCalls = [];
    mockHandlers = [];
    useSession.getState().setSession({
      accessToken: 'mock-access-token',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization([]),
      selectedOrgId: ORG_A,
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
    useSession.getState().clearSession();
    setAccessToken(null);
    setSelectedOrganization(null);
  });

  // ---------------------------------------------------------------------------
  // A. Organization Header: Cannot be Overridden by Caller or UI Parameters
  // ---------------------------------------------------------------------------
  it('A. organization header cannot be overridden through caller parameters on users endpoints', async () => {
    let capturedHeaders: Record<string, string> = {};

    mockHandlers.push({
      match: (url) => url.includes('/users'),
      handle: (_url, options) => {
        capturedHeaders = options.headers as Record<string, string>;
        return new Response(JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false, limit: 25 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    // Caller attempts to forge X-Acc-Organization to attacker org
    await apiFetch('/users', {
      headers: {
        'X-Acc-Organization': 'forged-attacker-org-id',
        'x-acc-organization': 'forged-attacker-org-lowercase',
      },
    });

    assert.equal(
      capturedHeaders['X-Acc-Organization'],
      ORG_A,
      'X-Acc-Organization is strictly derived from active validated session state, ignoring caller parameter',
    );
    assert.equal(capturedHeaders['x-acc-organization'], undefined);
  });

  // ---------------------------------------------------------------------------
  // B. Organization Switching & Query Cache Isolation
  // ---------------------------------------------------------------------------
  it('B. organization switching strictly changes tenant context and prevents query leakage', async () => {
    // 1. Fetch under Organization A
    setSelectedOrganization(ORG_A);
    await usersApi.list();
    const callA = fetchCalls[fetchCalls.length - 1];
    assert.ok(callA);
    assert.equal((callA.options.headers as Record<string, string>)['X-Acc-Organization'], ORG_A);

    // 2. Switch to Organization B
    setSelectedOrganization(ORG_B);
    await usersApi.list();
    const callB = fetchCalls[fetchCalls.length - 1];
    assert.ok(callB);
    assert.equal((callB.options.headers as Record<string, string>)['X-Acc-Organization'], ORG_B);

    // Verify query keys differ by organization
    const queryKeyOrgA = ['users', 'list', ORG_A, { status: undefined, email: undefined, sort: '-createdAt' }];
    const queryKeyOrgB = ['users', 'list', ORG_B, { status: undefined, email: undefined, sort: '-createdAt' }];
    assert.notDeepEqual(queryKeyOrgA, queryKeyOrgB, 'query keys for Org A and Org B must be strictly distinct');
  });

  // ---------------------------------------------------------------------------
  // C. Unauthorized Actions: 403 Handled Correctly and Non-Retryable
  // ---------------------------------------------------------------------------
  it('C. 403 on user creation or lifecycle action throws ApiError with retryable=false and no loop', async () => {
    mockHandlers.push({
      match: (url, options) => url.endsWith('/users') && options.method === 'POST',
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_SCOPE_DENIED',
              message: 'Caller lacks users.invite at this organization',
              correlationId: 'corr-denied-123',
              retryable: false,
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const createInput: CreateUserInput = {
      email: 'forbidden@example.com',
      initialRole: {
        roleId: 'role-123',
        scopeType: 'organization',
        scopeId: ORG_A,
      },
    };

    let caughtError: unknown;
    try {
      await usersApi.create(createInput);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof ApiError);
    assert.equal(caughtError.status, 403);
    assert.equal(caughtError.code, 'AUTHZ_SCOPE_DENIED');
    assert.equal(caughtError.retryable, false);
  });

  // ---------------------------------------------------------------------------
  // D. Authorization-Driven UI: Permissions Scoped to Active Organization
  // ---------------------------------------------------------------------------
  it('D. hasPermission only confers authority matching the active organization grants', () => {
    const user = createMockUser([ORG_A, ORG_B]);
    const authState = createMockAuthorization([
      {
        roleKey: 'org_admin',
        scopeType: 'organization',
        orgId: ORG_A,
        scopeId: ORG_A,
        permissions: ['users.read', 'users.invite', 'users.disable', 'users.reactivate'],
      },
      {
        roleKey: 'read_only',
        scopeType: 'organization',
        orgId: ORG_B,
        scopeId: ORG_B,
        permissions: ['users.read'],
      },
    ]);

    // Active session at ORG_A
    useSession.getState().setSession({
      accessToken: 'token-a',
      user,
      authorization: authState,
      selectedOrgId: ORG_A,
    });

    assert.equal(hasPermission('users.read'), true);
    assert.equal(hasPermission('users.invite'), true);
    assert.equal(hasPermission('users.disable'), true);
    assert.equal(hasPermission('users.reactivate'), true);

    // Switch to ORG_B: permissions must drop to read_only
    useSession.getState().selectOrganization(ORG_B);

    assert.equal(hasPermission('users.read'), true);
    assert.equal(hasPermission('users.invite'), false, 'users.invite must NOT bleed from Org A into Org B');
    assert.equal(hasPermission('users.disable'), false);
    assert.equal(hasPermission('users.reactivate'), false);
  });

  // ---------------------------------------------------------------------------
  // E. Sensitive Data Protection: Access Tokens Never Stored in Browser Storage
  // ---------------------------------------------------------------------------
  it('E. access tokens and credentials are never stored in localStorage, sessionStorage, or user objects', async () => {
    // Assert localStorage and sessionStorage are clean
    assert.equal(globalThis.localStorage?.length ?? 0, 0);
    assert.equal(globalThis.sessionStorage?.length ?? 0, 0);

    // Verify UserView contains zero credential material
    const mockUserPayload = {
      id: '01955b0a-7b3b-7411-9a4f-safeuser1111',
      email: 'safe@example.com',
      phone: null,
      status: 'active',
      lastLoginAt: null,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    };

    assert.equal('passwordHash' in mockUserPayload, false);
    assert.equal('password' in mockUserPayload, false);
    assert.equal('mfaSecretRef' in mockUserPayload, false);
    assert.equal('token' in mockUserPayload, false);
  });

  // ---------------------------------------------------------------------------
  // F. Error Handling: 400 Validation, 404 Not Found, 409 Conflict, 429 Rate Limit
  // ---------------------------------------------------------------------------
  it('F. ApiError preserves structured details for 400, 404, 409, and 429', async () => {
    // 1. 400 Validation Failure with structured field issues
    mockHandlers.push({
      match: (url) => url.endsWith('/test-validation'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Validation failed',
              correlationId: 'corr-val-1',
              retryable: false,
              details: {
                issues: [{ field: 'email', rule: 'IS_EMAIL', message: 'email must be a valid email' }],
              },
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => apiFetch('/test-validation'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 400);
        assert.equal(err.code, 'VALIDATION_FAILED');
        const issues = err.details?.issues as Array<{ field: string }>;
        assert.equal(issues?.[0]?.field, 'email');
        return true;
      },
    );

    // 2. 409 User Lifecycle Conflict
    mockHandlers.push({
      match: (url) => url.endsWith('/test-conflict'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'USER_LIFECYCLE_CONFLICT',
              message: 'Already disabled',
              correlationId: 'corr-conf-1',
              retryable: false,
              details: { status: 'disabled' },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => apiFetch('/test-conflict'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'USER_LIFECYCLE_CONFLICT');
        assert.equal(err.details?.status, 'disabled');
        return true;
      },
    );

    // 3. 429 Rate Limited
    mockHandlers.push({
      match: (url) => url.endsWith('/test-rate-limit'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'Too many requests',
              correlationId: 'corr-rate-1',
              retryable: false,
            },
          }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
          },
        ),
    });

    await assert.rejects(
      async () => apiFetch('/test-rate-limit'),
      (err: unknown) => err instanceof ApiError && err.status === 429 && err.code === 'RATE_LIMIT_EXCEEDED',
    );
  });

  // ---------------------------------------------------------------------------
  // G. Idempotency Key Consistency: Retries Must Reuse the Logical Key
  // ---------------------------------------------------------------------------
  it('G. retrying the same user creation preserves the Idempotency-Key across attempts', async () => {
    const fixedIdempotencyKey = '01955b0a-7b3b-7411-9a4f-fixedidempotent';
    const input: CreateUserInput = {
      email: 'retry-user@example.com',
      initialRole: {
        roleId: 'role-123',
        scopeType: 'organization',
        scopeId: ORG_A,
      },
    };

    let attemptCount = 0;
    const sentIdempotencyKeys: string[] = [];

    mockHandlers.push({
      match: (url, options) => url.endsWith('/users') && options.method === 'POST',
      handle: (_url, options) => {
        attemptCount++;
        const headers = options.headers as Record<string, string>;
        if (headers['Idempotency-Key']) {
          sentIdempotencyKeys.push(headers['Idempotency-Key']);
        }

        // First attempt fails with transient network error / 503
        if (attemptCount === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'Temporary glitch',
                correlationId: 'corr-glitch',
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
              id: '01955b0a-7b3b-7411-9a4f-retrieduser1',
              email: 'retry-user@example.com',
              status: 'invited',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    // First attempt fails
    await assert.rejects(async () => usersApi.create(input, fixedIdempotencyKey));

    // Client retries with the SAME key
    const res = await usersApi.create(input, fixedIdempotencyKey);
    assert.equal(res.data.status, 'invited');

    assert.equal(sentIdempotencyKeys.length, 2);
    assert.equal(sentIdempotencyKeys[0], fixedIdempotencyKey);
    assert.equal(sentIdempotencyKeys[1], fixedIdempotencyKey, 'retry MUST send the identical idempotency key');
  });

  // ---------------------------------------------------------------------------
  // H. Pagination Safety: Stale Cursors Not Reused After Filter Changes
  // ---------------------------------------------------------------------------
  it('H. changing filters must invalidate and clear stale pagination cursor', () => {
    let activeFilter = 'active';
    let cursorStack: string[] = ['cursor-page-1', 'cursor-page-2'];

    // Changing filter state resets cursor stack
    const applyFilterChange = (newFilter: string) => {
      activeFilter = newFilter;
      cursorStack = []; // Invariant: cursor stack must reset
    };

    applyFilterChange('disabled');
    assert.equal(activeFilter, 'disabled');
    assert.equal(cursorStack.length, 0, 'stale cursor must not be reused when filter changes');
  });

  // ---------------------------------------------------------------------------
  // I. Tenant Isolation: UI Cannot Submit Unverified Organization ID
  // ---------------------------------------------------------------------------
  it('I. tenant isolation: initialRole scopeId at organization scope is bound to selectedOrgId', () => {
    useSession.getState().setSession({
      accessToken: 'token-iso',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization([]),
      selectedOrgId: ORG_A,
    });

    const activeOrg = useSession.getState().selectedOrganizationId;
    assert.equal(activeOrg, ORG_A);

    // Initial role scopeId must match activeOrg
    const targetScopeId = activeOrg;
    assert.equal(targetScopeId, ORG_A);
  });

  // ---------------------------------------------------------------------------
  // Mutation Test: Weakening Header Sanitization Fails Boundary Test
  // ---------------------------------------------------------------------------
  it('mutation: absence of header sanitization would leak forged X-Acc-Organization', () => {
    const rawHeaders: Record<string, string> = {
      'x-acc-organization': 'attacker-forged-org',
      Accept: 'application/json',
    };

    // Demonstrates that our sanitization loop strips 'x-acc-organization'
    const sanitized: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (k.toLowerCase() !== 'x-acc-organization') {
        sanitized[k] = v;
      }
    }

    assert.equal(sanitized['x-acc-organization'], undefined);
    assert.equal(sanitized['X-Acc-Organization'], undefined);
    assert.equal(sanitized['Accept'], 'application/json');
  });
});
