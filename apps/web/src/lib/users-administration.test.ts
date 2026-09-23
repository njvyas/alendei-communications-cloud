import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  rolesApi,
  setAccessToken,
  setSelectedOrganization,
  usersApi,
  workspacesApi,
  roleAssignmentsApi,
  ApiError,
  type CreateUserInput,
} from './api-client';

import { useSession } from './session-store';

describe('Users Administration API Client', () => {
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
        grants: [],
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
  // 1. List Users with Cursor Pagination & Filter Parameters
  // ---------------------------------------------------------------------------
  it('1. usersApi.list attaches X-Acc-Organization and constructs query params correctly', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/users'),
      handle: (url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Authorization'], 'Bearer mock-access-token');

        const parsedUrl = new URL(url, 'http://localhost');
        assert.equal(parsedUrl.searchParams.get('status'), 'active');
        assert.equal(parsedUrl.searchParams.get('email'), 'test@example.com');
        assert.equal(parsedUrl.searchParams.get('sort'), '-createdAt');
        assert.equal(parsedUrl.searchParams.get('cursor'), 'cursor-xyz-123');
        assert.equal(parsedUrl.searchParams.get('limit'), '25');

        return new Response(
          JSON.stringify({
            data: [
              {
                id: '01955b0a-7b3b-7411-9a4f-9e67d4f92222',
                email: 'test@example.com',
                phone: '+919876543210',
                status: 'active',
                lastLoginAt: '2026-09-22T10:00:00.000Z',
                createdAt: '2026-09-20T10:00:00.000Z',
                updatedAt: '2026-09-21T10:00:00.000Z',
              },
            ],
            page: {
              nextCursor: 'cursor-next-456',
              hasMore: true,
              limit: 25,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await usersApi.list({
      status: 'active',
      email: 'test@example.com',
      sort: '-createdAt',
      cursor: 'cursor-xyz-123',
      limit: 25,
    });

    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]?.email, 'test@example.com');
    assert.equal(res.page.nextCursor, 'cursor-next-456');
    assert.equal(res.page.hasMore, true);
  });

  // ---------------------------------------------------------------------------
  // 2. Get User Detail
  // ---------------------------------------------------------------------------
  it('2. usersApi.get retrieves user detail and handles 404 correctly', async () => {
    const targetUserId = '01955b0a-7b3b-7411-9a4f-9e67d4f93333';

    mockHandlers.push({
      match: (url) => url.endsWith(`/users/${targetUserId}`),
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              id: targetUserId,
              email: 'detail@example.com',
              phone: null,
              status: 'invited',
              lastLoginAt: null,
              createdAt: '2026-09-21T12:00:00.000Z',
              updatedAt: '2026-09-21T12:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await usersApi.get(targetUserId);
    assert.equal(res.data.id, targetUserId);
    assert.equal(res.data.status, 'invited');

    // Test 404 out of reach
    mockHandlers.push({
      match: (url) => url.endsWith('/users/01955b0a-0000-0000-0000-000000000000'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'User not found',
              correlationId: 'corr-404',
              retryable: false,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => usersApi.get('01955b0a-0000-0000-0000-000000000000'),
      (err: unknown) => err instanceof ApiError && err.status === 404 && err.code === 'RESOURCE_NOT_FOUND',
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Create User with Initial Role & Idempotency Key
  // ---------------------------------------------------------------------------
  it('3. usersApi.create sends initialRole and Idempotency-Key header', async () => {
    const idempotencyKey = '01955b0a-7b3b-7411-9a4f-9e67d4f99999';
    const input: CreateUserInput = {
      email: 'newuser@example.com',
      phone: '+919876543210',
      initialRole: {
        roleId: '01955b0a-7b3b-7411-9a4f-role11111111',
        scopeType: 'organization',
        scopeId: ORG_ID,
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
              id: '01955b0a-7b3b-7411-9a4f-usercreated1',
              email: 'newuser@example.com',
              phone: '+919876543210',
              status: 'invited',
              lastLoginAt: null,
              createdAt: '2026-09-22T14:00:00.000Z',
              updatedAt: '2026-09-22T14:00:00.000Z',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await usersApi.create(input, idempotencyKey);

    assert.equal(capturedHeaders['Idempotency-Key'], idempotencyKey);
    assert.equal(capturedHeaders['X-Acc-Organization'], ORG_ID);
    assert.deepEqual(capturedBody, input);
    assert.equal(res.data.status, 'invited');
  });

  // ---------------------------------------------------------------------------
  // 4. Update User Phone
  // ---------------------------------------------------------------------------
  it('4. usersApi.update sends PATCH with phone attribute', async () => {
    const targetUserId = '01955b0a-7b3b-7411-9a4f-9e67d4f94444';
    let capturedMethod = '';
    let capturedBody: unknown = null;

    mockHandlers.push({
      match: (url) => url.endsWith(`/users/${targetUserId}`),
      handle: (_url, options) => {
        capturedMethod = options.method ?? '';
        capturedBody = JSON.parse(options.body as string);
        return new Response(
          JSON.stringify({
            data: {
              id: targetUserId,
              email: 'update@example.com',
              phone: '+919876543211',
              status: 'active',
              lastLoginAt: null,
              createdAt: '2026-09-20T10:00:00.000Z',
              updatedAt: '2026-09-22T15:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await usersApi.update(targetUserId, { phone: '+919876543211' });
    assert.equal(capturedMethod, 'PATCH');
    assert.deepEqual(capturedBody, { phone: '+919876543211' });
    assert.equal(res.data.phone, '+919876543211');
  });

  // ---------------------------------------------------------------------------
  // 5. Disable User Lifecycle Action
  // ---------------------------------------------------------------------------
  it('5. usersApi.disable calls POST /users/:id/disable and handles 409 conflict', async () => {
    const targetUserId = '01955b0a-7b3b-7411-9a4f-9e67d4f95555';

    mockHandlers.push({
      match: (url, options) => url.endsWith(`/users/${targetUserId}/disable`) && options.method === 'POST',
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              id: targetUserId,
              email: 'disabled@example.com',
              phone: null,
              status: 'disabled',
              lastLoginAt: null,
              createdAt: '2026-09-20T10:00:00.000Z',
              updatedAt: '2026-09-22T16:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await usersApi.disable(targetUserId);
    assert.equal(res.data.status, 'disabled');

    // Test 409 conflict when already disabled
    mockHandlers.push({
      match: (url) => url.endsWith('/users/already-disabled/disable'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'USER_LIFECYCLE_CONFLICT',
              message: 'User is already disabled',
              details: { status: 'disabled' },
              correlationId: 'corr-conflict',
              retryable: false,
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => usersApi.disable('already-disabled'),
      (err: unknown) =>
        err instanceof ApiError &&
        err.status === 409 &&
        err.code === 'USER_LIFECYCLE_CONFLICT' &&
        err.details?.status === 'disabled',
    );
  });

  // ---------------------------------------------------------------------------
  // 6. Reactivate User Lifecycle Action
  // ---------------------------------------------------------------------------
  it('6. usersApi.reactivate returns either active or invited status according to backend', async () => {
    const userA = '01955b0a-7b3b-7411-9a4f-reactivate-active';
    const userB = '01955b0a-7b3b-7411-9a4f-reactivate-invited';

    // User A holds credentials -> returns active
    mockHandlers.push({
      match: (url) => url.endsWith(`/users/${userA}/reactivate`),
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              id: userA,
              email: 'active-return@example.com',
              status: 'active',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    // User B was credential-less when disabled -> returns invited
    mockHandlers.push({
      match: (url) => url.endsWith(`/users/${userB}/reactivate`),
      handle: () =>
        new Response(
          JSON.stringify({
            data: {
              id: userB,
              email: 'invited-return@example.com',
              status: 'invited',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const resA = await usersApi.reactivate(userA);
    assert.equal(resA.data.status, 'active');

    const resB = await usersApi.reactivate(userB);
    assert.equal(resB.data.status, 'invited');
  });

  // ---------------------------------------------------------------------------
  // 7. Roles, Workspaces, and Role Assignments Helpers
  // ---------------------------------------------------------------------------
  it('7. rolesApi, workspacesApi, and roleAssignmentsApi invoke correct endpoints with tenant context', async () => {
    await rolesApi.list();
    await workspacesApi.list();
    await roleAssignmentsApi.listForUser('user-test-123');

    const rolesCall = fetchCalls.find((c) => c.url.endsWith('/roles'));
    const wsCall = fetchCalls.find((c) => c.url.endsWith('/tenants/workspaces'));
    const assignmentsCall = fetchCalls.find((c) => c.url.includes('/role-assignments?userId=user-test-123'));

    assert.ok(rolesCall);
    assert.ok(wsCall);
    assert.ok(assignmentsCall);

    assert.equal((rolesCall.options.headers as Record<string, string>)['X-Acc-Organization'], ORG_ID);
    assert.equal((wsCall.options.headers as Record<string, string>)['X-Acc-Organization'], ORG_ID);
    assert.equal((assignmentsCall.options.headers as Record<string, string>)['X-Acc-Organization'], ORG_ID);
  });
});
