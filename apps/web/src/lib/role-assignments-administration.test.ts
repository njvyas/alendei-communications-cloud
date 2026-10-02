import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  roleAssignmentsApi,
  setAccessToken,
  setSelectedOrganization,
  ApiError,
  type CreateRoleAssignmentInput,
} from './api-client';
import { useSession } from './session-store';

describe('Role Assignments Administration API Client', () => {
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
            permissions: [
              'role_assignments.read',
              'role_assignments.grant',
              'role_assignments.revoke',
            ],
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
  // 1. List Role Assignments with Filter Parameters
  // ---------------------------------------------------------------------------
  it('1. roleAssignmentsApi.list attaches X-Acc-Organization and constructs query params correctly', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/role-assignments') && !url.includes('/role-assignments/'),
      handle: (url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Authorization'], 'Bearer mock-access-token');

        const parsedUrl = new URL(url, 'http://localhost');
        assert.equal(parsedUrl.searchParams.get('userId'), '01955b0a-user-1111');
        assert.equal(parsedUrl.searchParams.get('scopeType'), 'workspace');
        assert.equal(parsedUrl.searchParams.get('scopeId'), '01955b0a-ws-2222');
        assert.equal(parsedUrl.searchParams.get('cursor'), 'cur_abc123');
        assert.equal(parsedUrl.searchParams.get('limit'), '25');
        assert.equal(parsedUrl.searchParams.get('sort'), '-createdAt');

        return new Response(
          JSON.stringify({
            data: [
              {
                id: '01955b0a-grant-1',
                userId: '01955b0a-user-1111',
                roleId: '01955b0a-role-1',
                roleKey: 'workspace_editor',
                orgId: ORG_ID,
                scopeType: 'workspace',
                scopeId: '01955b0a-ws-2222',
                grantedBy: 'test-admin',
                createdAt: '2026-09-23T10:00:00.000Z',
              },
            ],
            page: {
              nextCursor: null,
              hasMore: false,
              limit: 25,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await roleAssignmentsApi.list({
      userId: '01955b0a-user-1111',
      scopeType: 'workspace',
      scopeId: '01955b0a-ws-2222',
      cursor: 'cur_abc123',
      limit: 25,
      sort: '-createdAt',
    });

    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]!.roleKey, 'workspace_editor');
    assert.equal(res.data[0]!.scopeType, 'workspace');
    assert.equal(res.page.hasMore, false);
  });

  // ---------------------------------------------------------------------------
  // 2. List Role Assignments For User (Backward Compatible Shortcut)
  // ---------------------------------------------------------------------------
  it('2. roleAssignmentsApi.listForUser sends GET /role-assignments?userId=...', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/role-assignments?userId=target-user-999'),
      handle: (url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);

        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'grant-999',
                userId: 'target-user-999',
                roleId: 'role-org-admin',
                roleKey: 'org_admin',
                orgId: ORG_ID,
                scopeType: 'organization',
                scopeId: ORG_ID,
                grantedBy: 'test-admin',
                createdAt: '2026-09-23T10:00:00.000Z',
              },
            ],
            page: { nextCursor: null, hasMore: false, limit: 50 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await roleAssignmentsApi.listForUser('target-user-999');
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]!.id, 'grant-999');
    assert.equal(res.data[0]!.userId, 'target-user-999');
  });

  // ---------------------------------------------------------------------------
  // 3. Get Role Assignment by ID
  // ---------------------------------------------------------------------------
  it('3. roleAssignmentsApi.get fetches role assignment by ID', async () => {
    const grantId = '01955b0a-grant-view-1';
    mockHandlers.push({
      match: (url) => url.includes(`/role-assignments/${grantId}`),
      handle: () => {
        return new Response(
          JSON.stringify({
            data: {
              id: grantId,
              userId: '01955b0a-user-1',
              roleId: '01955b0a-role-1',
              roleKey: 'support_agent',
              orgId: ORG_ID,
              scopeType: 'organization',
              scopeId: ORG_ID,
              grantedBy: 'test-admin',
              createdAt: '2026-09-23T12:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await roleAssignmentsApi.get(grantId);
    assert.equal(res.data.id, grantId);
    assert.equal(res.data.roleKey, 'support_agent');
  });

  // ---------------------------------------------------------------------------
  // 4. Create Role Assignment with Idempotency Key
  // ---------------------------------------------------------------------------
  it('4. roleAssignmentsApi.create sends expected body and attaches Idempotency-Key header', async () => {
    const payload: CreateRoleAssignmentInput = {
      userId: '01955b0a-user-create',
      roleId: '01955b0a-role-custom',
      scopeType: 'workspace',
      scopeId: '01955b0a-ws-1',
    };
    const testIdempotencyKey = 'idem-grant-key-uuid-1234';

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Idempotency-Key'], testIdempotencyKey);
        assert.equal(headers['Content-Type'], 'application/json');

        const body = JSON.parse(String(options.body));
        assert.deepEqual(body, payload);

        return new Response(
          JSON.stringify({
            data: {
              id: '01955b0a-grant-created',
              ...payload,
              roleKey: 'custom_support',
              orgId: ORG_ID,
              grantedBy: 'test-admin',
              createdAt: new Date().toISOString(),
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await roleAssignmentsApi.create(payload, testIdempotencyKey);
    assert.equal(res.data.id, '01955b0a-grant-created');
    assert.equal(res.data.roleId, payload.roleId);
    assert.equal(res.data.scopeType, 'workspace');
  });

  // ---------------------------------------------------------------------------
  // 5. Delete Role Assignment
  // ---------------------------------------------------------------------------
  it('5. roleAssignmentsApi.delete issues DELETE request with no body and receives 204', async () => {
    const grantId = '01955b0a-grant-to-delete';
    let deleteCalled = false;

    mockHandlers.push({
      match: (url, options) =>
        url.includes(`/role-assignments/${grantId}`) && options.method === 'DELETE',
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(options.body, undefined);
        deleteCalled = true;
        return new Response(null, { status: 204 });
      },
    });

    await roleAssignmentsApi.delete(grantId);
    assert.equal(deleteCalled, true);
  });

  // ---------------------------------------------------------------------------
  // 6. Delete Role Assignment 404 Handled
  // ---------------------------------------------------------------------------
  it('6. roleAssignmentsApi.delete throws ApiError with status 404 when assignment already gone', async () => {
    const grantId = '01955b0a-grant-nonexistent';

    mockHandlers.push({
      match: (url, options) =>
        url.includes(`/role-assignments/${grantId}`) && options.method === 'DELETE',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Role assignment not found',
              correlationId: 'corr-404',
              retryable: false,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.delete(grantId);
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'RESOURCE_NOT_FOUND');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Delete Role Assignment 409 AUTHZ_LAST_PLATFORM_ADMIN Handled
  // ---------------------------------------------------------------------------
  it('7. roleAssignmentsApi.delete throws ApiError 409 AUTHZ_LAST_PLATFORM_ADMIN', async () => {
    const grantId = '01955b0a-platform-admin-grant';

    mockHandlers.push({
      match: (url, options) =>
        url.includes(`/role-assignments/${grantId}`) && options.method === 'DELETE',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_LAST_PLATFORM_ADMIN',
              message: 'Cannot revoke the last platform administrator',
              correlationId: 'corr-last-admin',
              retryable: false,
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.delete(grantId);
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'AUTHZ_LAST_PLATFORM_ADMIN');
        return true;
      },
    );
  });
});
