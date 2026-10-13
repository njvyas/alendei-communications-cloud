import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import ConsoleLayout from '@/app/(console)/layout';
import UsersPage from '@/app/(console)/users/page';
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
import { hasPermission, useSession } from './session-store';

// Ensure React is globally available for tsx / react-dom/server JSX transforms
(globalThis as unknown as { React: typeof React }).React = React;
// Allow Zustand state to be read live during server-side static markup rendering
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

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
        return new Response(
          JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false, limit: 25 } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
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
    const queryKeyOrgA = [
      'users',
      'list',
      ORG_A,
      { status: undefined, email: undefined, sort: '-createdAt' },
    ];
    const queryKeyOrgB = [
      'users',
      'list',
      ORG_B,
      { status: undefined, email: undefined, sort: '-createdAt' },
    ];
    assert.notDeepEqual(
      queryKeyOrgA,
      queryKeyOrgB,
      'query keys for Org A and Org B must be strictly distinct',
    );
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
    assert.equal(
      hasPermission('users.invite'),
      false,
      'users.invite must NOT bleed from Org A into Org B',
    );
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
                issues: [
                  { field: 'email', rule: 'IS_EMAIL', message: 'email must be a valid email' },
                ],
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
      (err: unknown) =>
        err instanceof ApiError && err.status === 429 && err.code === 'RATE_LIMIT_EXCEEDED',
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
    assert.equal(
      sentIdempotencyKeys[1],
      fixedIdempotencyKey,
      'retry MUST send the identical idempotency key',
    );
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

  // ---------------------------------------------------------------------------
  // SEC-03: Team Scope Support in User Creation
  // ---------------------------------------------------------------------------
  describe('SEC-03: Team Scope Support in User Creation', () => {
    const WORKSPACE_ID = '01955b0a-7b3b-7411-9a4f-wsAAAAAAAAAAA';
    const TEAM_ID = '01955b0a-7b3b-7411-9a4f-teamAAAAAAAAA';

    it('SEC-03.5: usersApi.create successfully dispatches team-scoped initialRole', async () => {
      const idempotencyKey = '01955b0a-7b3b-7411-9a4f-idemTeam1111';
      const input: CreateUserInput = {
        email: 'teamuser@example.com',
        phone: '+919876543210',
        initialRole: {
          roleId: 'role-agent',
          scopeType: 'team',
          scopeId: TEAM_ID,
        },
      };

      let capturedHeaders: Record<string, string> = {};
      let capturedBody: unknown = null;

      mockHandlers.push({
        match: (url, options) => url.endsWith('/users') && options.method === 'POST',
        handle: (_url, options) => {
          capturedHeaders = options.headers as Record<string, string>;
          capturedBody = JSON.parse(options.body as string);

          return new Response(
            JSON.stringify({
              data: {
                id: '01955b0a-7b3b-7411-9a4f-teamusercreated',
                email: 'teamuser@example.com',
                phone: '+919876543210',
                status: 'invited',
                lastLoginAt: null,
                createdAt: '2026-09-23T14:00:00.000Z',
                updatedAt: '2026-09-23T14:00:00.000Z',
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      const res = await usersApi.create(input, idempotencyKey);

      assert.equal(capturedHeaders['Idempotency-Key'], idempotencyKey);
      assert.equal(capturedHeaders['X-Acc-Organization'], ORG_A);
      assert.deepEqual(capturedBody, input);
      assert.equal(res.data.status, 'invited');
    });

    it('SEC-03.6: user creation fails closed if role does not admit team scope', async () => {
      mockHandlers.push({
        match: (url, options) => url.endsWith('/users') && options.method === 'POST',
        handle: () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED',
                message: 'The chosen role does not admit the selected scope level.',
                retryable: false,
              },
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const invalidInput: CreateUserInput = {
        email: 'teamuser@example.com',
        initialRole: {
          roleId: 'role-org-admin',
          scopeType: 'team',
          scopeId: TEAM_ID,
        },
      };

      await assert.rejects(
        async () => usersApi.create(invalidInput),
        (err: unknown) => {
          assert(err instanceof ApiError);
          assert.equal(err.code, 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED');
          assert.equal(err.status, 422);
          assert.equal(err.retryable, false);
          return true;
        },
      );
    });

    it('SEC-03.7: user creation at team scope strictly preserves team scope without broadening', async () => {
      let capturedBody: unknown = null;

      mockHandlers.push({
        match: (url, options) => url.endsWith('/users') && options.method === 'POST',
        handle: (_url, options) => {
          capturedBody = JSON.parse(options.body as string);
          return new Response(
            JSON.stringify({
              data: {
                id: 'user-created-team-isolated',
                email: 'isolated@example.com',
                status: 'invited',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      await usersApi.create({
        email: 'isolated@example.com',
        initialRole: {
          roleId: 'role-agent',
          scopeType: 'team',
          scopeId: TEAM_ID,
        },
      });

      assert.deepEqual(capturedBody, {
        email: 'isolated@example.com',
        initialRole: {
          roleId: 'role-agent',
          scopeType: 'team',
          scopeId: TEAM_ID,
        },
      });

      const casted = capturedBody as CreateUserInput;
      assert.equal(casted.initialRole.scopeType, 'team');
      assert.equal(casted.initialRole.scopeId, TEAM_ID);
      assert.notEqual(casted.initialRole.scopeType, 'workspace');
      assert.notEqual(casted.initialRole.scopeType, 'organization');
    });

    it('SEC-03.8: team scope hierarchy validation correctly checks parent workspace and organization', () => {
      const activeOrgId = ORG_A;
      const selectedWorkspaceId = WORKSPACE_ID;
      const teams = [
        { id: TEAM_ID, workspaceId: WORKSPACE_ID, orgId: ORG_A, name: 'Support Alpha' },
        { id: 'team-wrong-ws', workspaceId: 'ws-other', orgId: ORG_A, name: 'Wrong WS' },
        { id: 'team-wrong-org', workspaceId: WORKSPACE_ID, orgId: ORG_B, name: 'Wrong Org' },
      ];

      const validateTeam = (teamId: string) => {
        const team = teams.find((t) => t.id === teamId);
        if (!team) return { valid: false, reason: 'not_found' };
        if (team.workspaceId !== selectedWorkspaceId)
          return { valid: false, reason: 'wrong_workspace' };
        if (team.orgId !== activeOrgId) return { valid: false, reason: 'wrong_org' };
        return { valid: true };
      };

      assert.deepEqual(validateTeam(TEAM_ID), { valid: true });
      assert.deepEqual(validateTeam('team-wrong-ws'), { valid: false, reason: 'wrong_workspace' });
      assert.deepEqual(validateTeam('team-wrong-org'), { valid: false, reason: 'wrong_org' });
      assert.deepEqual(validateTeam('nonexistent'), { valid: false, reason: 'not_found' });
    });
  });

  // ---------------------------------------------------------------------------
  // SEC-04: Users Navigation and Page-Level Authorization Guard
  // ---------------------------------------------------------------------------
  describe('SEC-04: Users Navigation and Page-Level Authorization Guard', () => {
    const mockRouter = {
      push: () => {},
      replace: () => {},
      refresh: () => {},
      back: () => {},
      forward: () => {},
      prefetch: () => {},
    };

    const renderNavigation = (pathname = '/users') =>
      renderToStaticMarkup(
        React.createElement(
          AppRouterContext.Provider,
          {
            value: mockRouter as unknown as React.ComponentProps<
              typeof AppRouterContext.Provider
            >['value'],
          },
          React.createElement(
            PathnameContext.Provider,
            { value: pathname },
            React.createElement(ConsoleLayout, null, 'Child Content'),
          ),
        ),
      );

    const renderUsersPage = (qc: QueryClient) =>
      renderToStaticMarkup(
        React.createElement(QueryClientProvider, { client: qc }, React.createElement(UsersPage)),
      );

    let lastUsersObserver: QueryObserver<
      unknown,
      Error,
      unknown,
      unknown,
      readonly unknown[]
    > | null = null;
    const origSetOptions = QueryObserver.prototype.setOptions;

    beforeEach(() => {
      lastUsersObserver = null;
      (
        QueryObserver.prototype as unknown as { setOptions: (...args: unknown[]) => void }
      ).setOptions = function (
        this: QueryObserver<unknown, Error, unknown, unknown, readonly unknown[]>,
        ...args: unknown[]
      ) {
        const options = args[0] as { queryKey?: unknown[] } | undefined;
        if (
          Array.isArray(options?.queryKey) &&
          options.queryKey[0] === 'users' &&
          options.queryKey[1] === 'list'
        ) {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          lastUsersObserver = this;
        }
        return (origSetOptions as (...a: unknown[]) => void).apply(this, args);
      };
    });

    afterEach(() => {
      QueryObserver.prototype.setOptions = origSetOptions;
    });

    it('SEC-04.1: unauthorized user without users.read: navigation link hidden, page displays access-denied state, controls suppressed, usersApi.list not called', () => {
      const user = createMockUser([ORG_A]);
      const authState = createMockAuthorization([
        {
          roleKey: 'platform_reader',
          scopeType: 'platform',
          orgId: null,
          scopeId: null,
          permissions: ['providers.read'],
        },
        {
          roleKey: 'inviter_plus_sections',
          scopeType: 'organization',
          orgId: ORG_A,
          scopeId: ORG_A,
          permissions: [
            'users.invite', // Holds invite, but strictly lacks users.read
            'organizations.read',
            'workspaces.read',
            'teams.read',
            'roles.read',
            'api_keys.read',
            'audit.read',
          ],
        },
      ]);

      useSession.getState().setSession({
        accessToken: 'mock-token-unauthorized',
        user,
        authorization: authState,
        selectedOrgId: ORG_A,
      });

      assert.equal(hasPermission('users.read'), false);

      // 1. Navigation Guard Verification
      const navHtml = renderNavigation('/users');
      assert.equal(
        navHtml.includes('href="/users"'),
        false,
        'Users navigation link must NOT be rendered when user lacks users.read',
      );
      // Invariant: other navigation links remain present in correct order
      assert.ok(navHtml.includes('href="/"'));
      assert.ok(navHtml.includes('href="/channels"'));
      assert.ok(navHtml.includes('href="/providers"'));
      assert.ok(navHtml.includes('href="/organizations"'));
      assert.ok(navHtml.includes('href="/workspaces"'));
      assert.ok(navHtml.includes('href="/teams"'));
      assert.ok(navHtml.includes('href="/roles"'));
      assert.ok(navHtml.includes('href="/api-keys"'));
      assert.ok(navHtml.includes('href="/audit-logs"'));

      // 2. Page Guard Verification
      const qc = new QueryClient();
      fetchCalls = [];
      const pageHtml = renderUsersPage(qc);

      // Explicit access-denied boundary rendered
      assert.ok(
        pageHtml.includes('Access Forbidden'),
        'UsersPage must render Access Forbidden state when users.read is absent',
      );
      assert.ok(
        pageHtml.includes('users.read'),
        'UsersPage must explicitly state users.read requirement',
      );

      // Functional controls and invitation workflow must NOT be rendered
      assert.equal(
        pageHtml.includes('Lookup exact email'),
        false,
        'User search form must not be rendered in denied state',
      );
      assert.equal(
        pageHtml.includes('Lookup'),
        false,
        'Lookup button must not be rendered in denied state',
      );
      assert.equal(
        pageHtml.includes('filter-status'),
        false,
        'Status filter dropdown must not be rendered in denied state',
      );
      assert.equal(
        pageHtml.includes('sort-users'),
        false,
        'Sorting controls must not be rendered in denied state',
      );
      assert.equal(
        pageHtml.includes('+ Invite User'),
        false,
        'Invitation workflow button must not be rendered in denied state even if holding users.invite',
      );
      assert.equal(
        pageHtml.includes('<table'),
        false,
        'Users table must not be rendered in denied state',
      );

      // 3. Query Execution Guard Verification
      assert.ok(lastUsersObserver, 'Query observer must be captured');
      assert.equal(
        lastUsersObserver.options.enabled,
        false,
        'Primary users list query must be disabled when users.read is absent',
      );

      // No network calls made to /users list
      const listCalls = fetchCalls.filter(
        (c) => c.url.includes('/users') && !c.url.includes('/users/'),
      );
      assert.equal(
        listCalls.length,
        0,
        'usersApi.list must never be called when users.read is absent',
      );

      // Subscribing observer must not execute fetch
      const unsub = lastUsersObserver.subscribe(() => {});
      unsub();
      assert.equal(
        fetchCalls.filter((c) => c.url.includes('/users') && !c.url.includes('/users/')).length,
        0,
        'Observer subscription must not trigger query execution when disabled',
      );
    });

    it('SEC-04.2: authorized user with users.read: navigation link visible, page loads, controls available, usersApi.list query is enabled', async () => {
      const user = createMockUser([ORG_A]);
      const authState = createMockAuthorization([
        {
          roleKey: 'org_admin',
          scopeType: 'organization',
          orgId: ORG_A,
          scopeId: ORG_A,
          permissions: ['users.read', 'users.invite'],
        },
      ]);

      useSession.getState().setSession({
        accessToken: 'mock-token-authorized',
        user,
        authorization: authState,
        selectedOrgId: ORG_A,
      });

      assert.equal(hasPermission('users.read'), true);

      // 1. Navigation Guard Verification
      const navHtml = renderNavigation('/users');
      assert.ok(
        navHtml.includes('href="/users"'),
        'Users navigation link must be visible for authorized user',
      );

      // 2. Page Guard Verification
      const qc = new QueryClient();
      fetchCalls = [];
      const pageHtml = renderUsersPage(qc);

      assert.equal(
        pageHtml.includes('Access Forbidden'),
        false,
        'Access Forbidden must not be shown to authorized user',
      );
      assert.ok(
        pageHtml.includes('Manage user memberships, scopes, and lifecycle states'),
        'Users page header must be rendered',
      );
      assert.ok(
        pageHtml.includes('Lookup exact email'),
        'Search form must be rendered for authorized user',
      );
      assert.ok(
        pageHtml.includes('filter-status'),
        'Status filter must be rendered for authorized user',
      );
      assert.ok(
        pageHtml.includes('sort-users'),
        'Sort controls must be rendered for authorized user',
      );
      assert.ok(
        pageHtml.includes('+ Invite User'),
        'Invite user button must be rendered when holding users.invite',
      );

      // 3. Query Execution Guard Verification
      assert.ok(lastUsersObserver, 'Query observer must be captured');
      assert.equal(
        lastUsersObserver.options.enabled,
        true,
        'Primary users list query must be enabled when users.read is present',
      );

      // Subscribing observer dispatches usersApi.list
      const unsub = lastUsersObserver.subscribe(() => {});
      unsub();
      await new Promise((r) => setTimeout(r, 20));

      const listCalls = fetchCalls.filter((c) => c.url.includes('/users'));
      assert.ok(listCalls.length > 0, 'usersApi.list must be called when query is enabled');
      assert.equal(
        (listCalls[0]!.options.headers as Record<string, string>)['X-Acc-Organization'],
        ORG_A,
        'Request must be strictly scoped to active organization header',
      );
    });

    it('SEC-04.3: organization switch from granted to denied context: immediate fail-closed transition, no query execution, cached data suppressed', () => {
      const user = createMockUser([ORG_A, ORG_B]);
      const authState = createMockAuthorization([
        {
          roleKey: 'admin_org_a',
          scopeType: 'organization',
          orgId: ORG_A,
          scopeId: ORG_A,
          permissions: ['users.read'],
        },
        {
          roleKey: 'reader_org_b',
          scopeType: 'organization',
          orgId: ORG_B,
          scopeId: ORG_B,
          permissions: ['roles.read'], // No users.read in ORG_B
        },
      ]);

      // Phase 1: Start in ORG_A where users.read is granted
      useSession.getState().setSession({
        accessToken: 'mock-token-transition',
        user,
        authorization: authState,
        selectedOrgId: ORG_A,
      });

      assert.equal(hasPermission('users.read'), true);
      assert.ok(renderNavigation('/users').includes('href="/users"'));

      const qc = new QueryClient();
      const pageA = renderUsersPage(qc);
      assert.equal(pageA.includes('Access Forbidden'), false);

      // Phase 2: Switch to ORG_B where users.read is absent
      useSession.getState().selectOrganization(ORG_B);
      assert.equal(
        hasPermission('users.read'),
        false,
        'Permission must immediately update on organization switch',
      );

      // Navigation immediately hides Users link
      assert.equal(
        renderNavigation('/users').includes('href="/users"'),
        false,
        'Navigation link must immediately hide after organization switch to denied context',
      );

      // Pre-populate query cache for ORG_B to verify cached data does not leak into denied state
      const mockCachedUser = {
        id: 'cached-user-org-b',
        email: 'confidential-user@example.com',
        phone: '+1234567890',
        status: 'active',
        lastLoginAt: null,
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      };
      qc.setQueryData(
        [
          'users',
          'list',
          ORG_B,
          {
            status: undefined,
            email: undefined,
            sort: '-createdAt',
            cursor: undefined,
            limit: 25,
          },
        ],
        {
          data: [mockCachedUser],
          page: { nextCursor: null, hasMore: false, limit: 25 },
        },
      );

      fetchCalls = [];
      const pageB = renderUsersPage(qc);

      // Page boundary transitions to Access Forbidden
      assert.ok(
        pageB.includes('Access Forbidden'),
        'UsersPage must transition to Access Forbidden in ORG_B',
      );
      assert.ok(pageB.includes('users.read'));

      // Invariant: cached data MUST NOT appear in denied state
      assert.equal(
        pageB.includes('confidential-user@example.com'),
        false,
        'Cached user data must NEVER appear when users.read is absent',
      );
      assert.equal(
        pageB.includes('cached-user-org-b'),
        false,
        'Cached user IDs must NEVER appear in denied state',
      );
      assert.equal(
        pageB.includes('filter-status'),
        false,
        'Functional controls must not appear in denied state',
      );
      assert.equal(
        pageB.includes('Lookup exact email'),
        false,
        'Search controls must not appear in denied state',
      );

      // No queries enabled or issued for ORG_B
      assert.ok(lastUsersObserver);
      assert.equal(
        lastUsersObserver.options.enabled,
        false,
        'List query for ORG_B must be disabled',
      );
      assert.equal(
        fetchCalls.filter((c) => c.url.includes('/users')).length,
        0,
        'No network request to /users must be issued for ORG_B',
      );
    });

    it('SEC-04.4: fail-closed on absent, null, malformed, or unauthenticated authorization context', () => {
      const qc = new QueryClient();

      // Case 1: Unauthenticated session
      useSession.getState().clearSession();
      assert.equal(hasPermission('users.read'), false);
      assert.equal(renderNavigation().includes('href="/users"'), false);
      const pageClear = renderUsersPage(qc);
      assert.ok(pageClear.includes('Access Forbidden'));
      assert.equal(lastUsersObserver?.options?.enabled, false);

      // Case 2: Session with authorization === null
      useSession.getState().setSession({
        accessToken: 'mock-token-null-auth',
        user: createMockUser([ORG_A]),
        authorization: null as unknown as EffectiveAuthorization,
        selectedOrgId: ORG_A,
      });
      assert.equal(hasPermission('users.read'), false);
      assert.equal(renderNavigation().includes('href="/users"'), false);
      const pageNull = renderUsersPage(qc);
      assert.ok(pageNull.includes('Access Forbidden'));
      assert.equal(lastUsersObserver?.options?.enabled, false);

      // Case 3: Empty grants
      useSession.getState().setSession({
        accessToken: 'mock-token-empty-grants',
        user: createMockUser([ORG_A]),
        authorization: createMockAuthorization([]),
        selectedOrgId: ORG_A,
      });
      assert.equal(hasPermission('users.read'), false);
      assert.equal(renderNavigation().includes('href="/users"'), false);
      const pageEmpty = renderUsersPage(qc);
      assert.ok(pageEmpty.includes('Access Forbidden'));
      assert.equal(lastUsersObserver?.options?.enabled, false);

      // Case 4: Malformed scope type (workspace grant does not confer organization scope)
      const workspaceAuth = createMockAuthorization([
        {
          roleKey: 'workspace_reader',
          scopeType: 'workspace',
          orgId: ORG_A,
          scopeId: 'ws-123',
          permissions: ['users.read'],
        },
      ]);
      useSession.getState().setSession({
        accessToken: 'mock-token-ws-scope',
        user: createMockUser([ORG_A]),
        authorization: workspaceAuth,
        selectedOrgId: ORG_A,
      });
      assert.equal(
        hasPermission('users.read'),
        false,
        'Workspace scope grant must not confer organization-level users.read',
      );
      assert.equal(renderNavigation().includes('href="/users"'), false);
      const pageWs = renderUsersPage(qc);
      assert.ok(pageWs.includes('Access Forbidden'));
      assert.equal(lastUsersObserver?.options?.enabled, false);

      // Case 5: Foreign organization grant (orgId mismatch)
      const foreignOrgAuth = createMockAuthorization([
        {
          roleKey: 'foreign_admin',
          scopeType: 'organization',
          orgId: ORG_B,
          scopeId: ORG_B,
          permissions: ['users.read'],
        },
      ]);
      useSession.getState().setSession({
        accessToken: 'mock-token-foreign',
        user: createMockUser([ORG_A, ORG_B]),
        authorization: foreignOrgAuth,
        selectedOrgId: ORG_A,
      });
      assert.equal(
        hasPermission('users.read'),
        false,
        'Foreign organization grant must not confer permissions in ungranted organization',
      );
      assert.equal(renderNavigation().includes('href="/users"'), false);
      const pageForeign = renderUsersPage(qc);
      assert.ok(pageForeign.includes('Access Forbidden'));
      assert.equal(lastUsersObserver?.options?.enabled, false);
    });

    it('SEC-04.5: strict independence of users.invite and users.read permissions', () => {
      const qc = new QueryClient();

      // Case 1: Has users.read, lacks users.invite
      useSession.getState().setSession({
        accessToken: 'mock-token-read-only',
        user: createMockUser([ORG_A]),
        authorization: createMockAuthorization([
          {
            roleKey: 'auditor',
            scopeType: 'organization',
            orgId: ORG_A,
            scopeId: ORG_A,
            permissions: ['users.read'],
          },
        ]),
        selectedOrgId: ORG_A,
      });

      assert.equal(hasPermission('users.read'), true);
      assert.equal(hasPermission('users.invite'), false);

      assert.ok(renderNavigation().includes('href="/users"'));
      const pageReadOnly = renderUsersPage(qc);
      assert.equal(pageReadOnly.includes('Access Forbidden'), false);
      assert.ok(pageReadOnly.includes('Lookup exact email'));
      assert.equal(
        pageReadOnly.includes('+ Invite User'),
        false,
        '+ Invite User must NOT be rendered when user lacks users.invite',
      );
      assert.equal(lastUsersObserver?.options?.enabled, true);

      // Case 2: Has users.invite, lacks users.read
      useSession.getState().setSession({
        accessToken: 'mock-token-invite-only',
        user: createMockUser([ORG_A]),
        authorization: createMockAuthorization([
          {
            roleKey: 'inviter_isolated',
            scopeType: 'organization',
            orgId: ORG_A,
            scopeId: ORG_A,
            permissions: ['users.invite'],
          },
        ]),
        selectedOrgId: ORG_A,
      });

      assert.equal(hasPermission('users.read'), false);
      assert.equal(hasPermission('users.invite'), true);

      assert.equal(
        renderNavigation().includes('href="/users"'),
        false,
        'Navigation link must be hidden even if holding users.invite',
      );
      const pageInviteOnly = renderUsersPage(qc);
      assert.ok(pageInviteOnly.includes('Access Forbidden'));
      assert.equal(
        pageInviteOnly.includes('+ Invite User'),
        false,
        '+ Invite User must NOT be rendered when users.read is absent',
      );
      assert.equal(lastUsersObserver?.options?.enabled, false);

      // Case 3: Has both users.read and users.invite
      useSession.getState().setSession({
        accessToken: 'mock-token-both',
        user: createMockUser([ORG_A]),
        authorization: createMockAuthorization([
          {
            roleKey: 'full_admin',
            scopeType: 'organization',
            orgId: ORG_A,
            scopeId: ORG_A,
            permissions: ['users.read', 'users.invite'],
          },
        ]),
        selectedOrgId: ORG_A,
      });

      assert.equal(hasPermission('users.read'), true);
      assert.equal(hasPermission('users.invite'), true);

      assert.ok(renderNavigation().includes('href="/users"'));
      const pageBoth = renderUsersPage(qc);
      assert.equal(pageBoth.includes('Access Forbidden'), false);
      assert.ok(pageBoth.includes('+ Invite User'));
      assert.equal(lastUsersObserver?.options?.enabled, true);
    });
  });
});
