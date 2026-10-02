import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  permissionsApi,
  rolesApi,
  setAccessToken,
  setSelectedOrganization,
  ApiError,
  type CreateRoleInput,
  type RoleView,
  type UpdateRoleInput,
} from './api-client';
import { useSession } from './session-store';

describe('Roles & Permissions Administration API Client', () => {
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
              'roles.read',
              'roles.create',
              'roles.update',
              'roles.delete',
              'permissions.read',
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
  // 1. List Roles with Cursor Pagination & Filter Parameters
  // ---------------------------------------------------------------------------
  it('1. rolesApi.list attaches X-Acc-Organization and constructs query params correctly', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/roles') && !url.includes('/roles/'),
      handle: (url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Authorization'], 'Bearer mock-access-token');

        const parsedUrl = new URL(url, 'http://localhost');
        assert.equal(parsedUrl.searchParams.get('isSystemRole'), 'false');
        assert.equal(parsedUrl.searchParams.get('key'), 'custom_editor');
        assert.equal(parsedUrl.searchParams.get('sort'), '-createdAt');
        assert.equal(parsedUrl.searchParams.get('cursor'), 'cursor-abc-123');
        assert.equal(parsedUrl.searchParams.get('limit'), '25');

        return new Response(
          JSON.stringify({
            data: [
              {
                id: '01955b0a-7b3b-7411-9a4f-custom111111',
                key: 'custom_editor',
                name: 'Custom Editor',
                description: 'Custom editing role',
                orgId: ORG_ID,
                isSystemRole: false,
                allowedScopeTypes: ['organization', 'workspace'],
                permissions: ['roles.read'],
                createdAt: '2026-09-23T00:00:00.000Z',
                updatedAt: '2026-09-23T00:00:00.000Z',
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

    const result = await rolesApi.list({
      isSystemRole: false,
      key: 'custom_editor',
      sort: '-createdAt',
      cursor: 'cursor-abc-123',
      limit: 25,
    });

    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.key, 'custom_editor');
    assert.equal(result.data[0]?.isSystemRole, false);
    assert.equal(result.page?.hasMore, false);
  });

  // ---------------------------------------------------------------------------
  // 2. Get Role By ID
  // ---------------------------------------------------------------------------
  it('2. rolesApi.get fetches role by ID and returns RoleView', async () => {
    const roleId = '01955b0a-7b3b-7411-9a4f-custom111111';

    mockHandlers.push({
      match: (url) => url.includes(`/roles/${roleId}`),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);

        return new Response(
          JSON.stringify({
            data: {
              id: roleId,
              key: 'custom_editor',
              name: 'Custom Editor',
              description: 'Custom editing role',
              orgId: ORG_ID,
              isSystemRole: false,
              allowedScopeTypes: ['organization', 'workspace'],
              permissions: ['roles.read', 'workspaces.read'],
              createdAt: '2026-09-23T00:00:00.000Z',
              updatedAt: '2026-09-23T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const result = await rolesApi.get(roleId);
    assert.equal(result.data.id, roleId);
    assert.equal(result.data.name, 'Custom Editor');
    assert.deepEqual(result.data.allowedScopeTypes, ['organization', 'workspace']);
    assert.deepEqual(result.data.permissions, ['roles.read', 'workspaces.read']);
  });

  // ---------------------------------------------------------------------------
  // 3. Create Custom Role with Idempotency Key
  // ---------------------------------------------------------------------------
  it('3. rolesApi.create sends expected body and attaches Idempotency-Key header', async () => {
    const idempotencyKey = 'idem-key-random-uuid-12345';
    const input: CreateRoleInput = {
      key: 'campaign_lead',
      name: 'Campaign Team Lead',
      description: 'Manages marketing campaigns',
      allowedScopeTypes: ['organization', 'workspace'],
      permissions: ['roles.read', 'workspaces.read'],
    };

    mockHandlers.push({
      match: (url, options) => url.includes('/roles') && options.method === 'POST',
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Idempotency-Key'], idempotencyKey);

        const body = JSON.parse(options.body as string) as CreateRoleInput;
        assert.equal(body.key, 'campaign_lead');
        assert.equal(body.name, 'Campaign Team Lead');
        assert.deepEqual(body.allowedScopeTypes, ['organization', 'workspace']);
        assert.deepEqual(body.permissions, ['roles.read', 'workspaces.read']);

        const responseRole: RoleView = {
          id: '01955b0a-7b3b-7411-9a4f-lead11111111',
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          orgId: ORG_ID,
          isSystemRole: false,
          allowedScopeTypes: body.allowedScopeTypes,
          permissions: body.permissions,
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
        };

        return new Response(JSON.stringify({ data: responseRole }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const result = await rolesApi.create(input, idempotencyKey);
    assert.equal(result.data.key, 'campaign_lead');
    assert.equal(result.data.isSystemRole, false);
  });

  // ---------------------------------------------------------------------------
  // 4. Update Role with Complete Permission Replacement Set
  // ---------------------------------------------------------------------------
  it('4. rolesApi.update submits complete replacement set of permissions via PATCH', async () => {
    const roleId = '01955b0a-7b3b-7411-9a4f-lead11111111';
    const input: UpdateRoleInput = {
      name: 'Campaign Operations Lead',
      allowedScopeTypes: ['organization', 'workspace', 'team'],
      permissions: ['roles.read', 'workspaces.read', 'teams.read'], // complete replacement set
    };

    mockHandlers.push({
      match: (url, options) => url.includes(`/roles/${roleId}`) && options.method === 'PATCH',
      handle: (_url, options) => {
        const body = JSON.parse(options.body as string) as UpdateRoleInput;
        assert.equal(body.name, 'Campaign Operations Lead');
        assert.deepEqual(body.allowedScopeTypes, ['organization', 'workspace', 'team']);
        // Verify complete set is sent, never a diff or delta
        assert.deepEqual(body.permissions, ['roles.read', 'workspaces.read', 'teams.read']);

        return new Response(
          JSON.stringify({
            data: {
              id: roleId,
              key: 'campaign_lead',
              name: body.name,
              description: null,
              orgId: ORG_ID,
              isSystemRole: false,
              allowedScopeTypes: body.allowedScopeTypes,
              permissions: body.permissions,
              createdAt: '2026-09-23T00:00:00.000Z',
              updatedAt: '2026-09-23T00:05:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const result = await rolesApi.update(roleId, input);
    assert.equal(result.data.name, 'Campaign Operations Lead');
    assert.equal(result.data.permissions.length, 3);
  });

  // ---------------------------------------------------------------------------
  // 5. Delete Custom Role
  // ---------------------------------------------------------------------------
  it('5. rolesApi.delete issues DELETE request with no body and receives 204', async () => {
    const roleId = '01955b0a-7b3b-7411-9a4f-lead11111111';

    mockHandlers.push({
      match: (url, options) => url.includes(`/roles/${roleId}`) && options.method === 'DELETE',
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        return new Response(null, { status: 204 });
      },
    });

    await rolesApi.delete(roleId);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.options.method, 'DELETE');
  });

  // ---------------------------------------------------------------------------
  // 6. Delete Role Conflict (409) when active grants exist
  // ---------------------------------------------------------------------------
  it('6. rolesApi.delete throws ApiError with status 409 when grants still exist', async () => {
    const roleId = '01955b0a-7b3b-7411-9a4f-lead11111111';

    mockHandlers.push({
      match: (url, options) => url.includes(`/roles/${roleId}`) && options.method === 'DELETE',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'RESOURCE_CONFLICT',
              message: 'This role is still granted to at least one user; revoke those grants first',
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await rolesApi.delete(roleId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'RESOURCE_CONFLICT');
        assert.match(err.message, /still granted to at least one user/i);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 7. List Permissions from Catalogue
  // ---------------------------------------------------------------------------
  it('7. permissionsApi.list constructs domain filter and pagination parameters', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/permissions'),
      handle: (url) => {
        const parsedUrl = new URL(url, 'http://localhost');
        assert.equal(parsedUrl.searchParams.get('domain'), 'roles');
        assert.equal(parsedUrl.searchParams.get('limit'), '50');

        return new Response(
          JSON.stringify({
            data: [
              { key: 'roles.read', domain: 'roles', action: 'read', description: 'Read roles' },
              {
                key: 'roles.create',
                domain: 'roles',
                action: 'create',
                description: 'Create roles',
              },
            ],
            page: { nextCursor: null, hasMore: false, limit: 50 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const result = await permissionsApi.list({ domain: 'roles', limit: 50 });
    assert.equal(result.data.length, 2);
    assert.equal(result.data[0]?.domain, 'roles');
    assert.equal(result.data[1]?.action, 'create');
  });
});
