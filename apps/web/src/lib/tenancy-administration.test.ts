import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  organizationsApi,
  workspacesApi,
  teamsApi,
  type OrganizationView,
  type WorkspaceView,
  type TeamView,
} from './api-client';
import { useSession } from './session-store';

describe('Tenancy Administration API Client (Organizations, Workspaces, Teams)', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const WS_ID = '01955b0a-7b3b-7411-9a4f-ws0000000001';
  const TEAM_ID = '01955b0a-7b3b-7411-9a4f-team00000001';

  const mockOrg: OrganizationView = {
    id: ORG_ID,
    name: 'Acme Retail',
    slug: 'acme-retail',
    legalName: 'Acme Retail Pvt Ltd',
    gstin: '24ABCDE1234F1Z5',
    resellerId: '01955b0a-7b3b-7411-9a4f-reseller0001',
    status: 'active',
    statusChangedAt: null,
    billingMode: 'prepaid',
    billingPolicy: 'charge_per_logical_message',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
  };

  const mockWorkspace: WorkspaceView = {
    id: WS_ID,
    orgId: ORG_ID,
    name: 'Default Workspace',
    slug: 'default-workspace',
    status: 'active',
    isDefault: true,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
  };

  const mockTeam: TeamView = {
    id: TEAM_ID,
    orgId: ORG_ID,
    workspaceId: WS_ID,
    name: 'Customer Support',
    status: 'active',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
  };

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
        tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
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
            roleKey: 'platform_super_admin',
            scopeType: 'platform',
            scopeId: null,
            orgId: null,
            permissions: [
              'organizations.read',
              'organizations.create',
              'organizations.update',
              'workspaces.read',
              'workspaces.create',
              'workspaces.update',
              'teams.read',
              'teams.create',
              'teams.update',
              'platform.tenants.manage',
            ],
          },
        ],
        organizationIds: [ORG_ID],
        isPlatformAdmin: true,
      },
      selectedOrgId: ORG_ID,
    });

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const options = init ?? {};
      fetchCalls.push({ url, options });

      for (const handler of mockHandlers) {
        if (handler.match(url, options)) {
          return handler.handle(url, options);
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
  });

  // ---------------------------------------------------------------------------
  // 1. Organizations API
  // ---------------------------------------------------------------------------
  describe('Organizations API (organizationsApi)', () => {
    it('list constructs query parameters and does NOT send X-Acc-Organization (skipTenant: true)', async () => {
      mockHandlers.push({
        match: (url) => url.includes('/organizations'),
        handle: () =>
          new Response(
            JSON.stringify({
              data: [mockOrg],
              page: { nextCursor: null, hasMore: false, limit: 25 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await organizationsApi.list({
        status: 'active',
        resellerId: 'reseller-uuid',
        cursor: 'cursor-123',
        limit: 10,
        sort: 'name',
      });

      assert.equal(res.data.length, 1);
      assert.equal(fetchCalls.length, 1);

      const call = fetchCalls[0]!;
      assert.ok(call.url.includes('/organizations?'));
      assert.ok(call.url.includes('status=active'));
      assert.ok(call.url.includes('resellerId=reseller-uuid'));
      assert.ok(call.url.includes('cursor=cursor-123'));
      assert.ok(call.url.includes('limit=10'));
      assert.ok(call.url.includes('sort=name'));

      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], undefined, 'Must not send X-Acc-Organization');
    });

    it('get retrieves organization by ID with skipTenant: true', async () => {
      mockHandlers.push({
        match: (url) => url.endsWith(`/organizations/${ORG_ID}`),
        handle: () =>
          new Response(JSON.stringify({ data: mockOrg }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });

      const res = await organizationsApi.get(ORG_ID);
      assert.equal(res.data.id, ORG_ID);
      assert.equal(res.data.slug, 'acme-retail');

      const call = fetchCalls[0]!;
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], undefined);
    });

    it('create sends payload, Idempotency-Key, and skipTenant: true', async () => {
      const idempotencyKey = 'key-uuid-123';
      let capturedBody: unknown;
      let capturedHeaders: Record<string, string> = {};

      mockHandlers.push({
        match: (url, opts) => url.endsWith('/organizations') && opts.method === 'POST',
        handle: (_url, opts) => {
          capturedHeaders = opts.headers as Record<string, string>;
          capturedBody = JSON.parse(opts.body as string);
          return new Response(JSON.stringify({ data: mockOrg }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const input = {
        name: 'Acme Retail',
        slug: 'acme-retail',
        legalName: 'Acme Retail Pvt Ltd',
        gstin: '24ABCDE1234F1Z5',
        billingMode: 'prepaid' as const,
        billingPolicy: 'charge_per_logical_message' as const,
      };

      const res = await organizationsApi.create(input, idempotencyKey);
      assert.equal(res.data.slug, 'acme-retail');
      assert.deepEqual(capturedBody, input);
      assert.equal(capturedHeaders['Idempotency-Key'], idempotencyKey);
      assert.equal(capturedHeaders['X-Acc-Organization'], undefined);
    });

    it('update sends PATCH with name and legal entity fields', async () => {
      let capturedBody: unknown;
      mockHandlers.push({
        match: (url, opts) => url.endsWith(`/organizations/${ORG_ID}`) && opts.method === 'PATCH',
        handle: (_url, opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return new Response(JSON.stringify({ data: { ...mockOrg, name: 'Acme Global' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const res = await organizationsApi.update(ORG_ID, {
        name: 'Acme Global',
        legalName: 'Acme Global LLC',
      });

      assert.equal(res.data.name, 'Acme Global');
      assert.deepEqual(capturedBody, { name: 'Acme Global', legalName: 'Acme Global LLC' });
    });

    it('suspend, reactivate, and close execute POST to corresponding lifecycle paths with reason', async () => {
      mockHandlers.push({
        match: (url) => url.endsWith(`/organizations/${ORG_ID}/suspend`),
        handle: () =>
          new Response(JSON.stringify({ data: { ...mockOrg, status: 'suspended' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      mockHandlers.push({
        match: (url) => url.endsWith(`/organizations/${ORG_ID}/reactivate`),
        handle: () =>
          new Response(JSON.stringify({ data: { ...mockOrg, status: 'active' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      mockHandlers.push({
        match: (url) => url.endsWith(`/organizations/${ORG_ID}/close`),
        handle: () =>
          new Response(JSON.stringify({ data: { ...mockOrg, status: 'closed' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });

      const suspended = await organizationsApi.suspend(ORG_ID, 'Non-payment');
      assert.equal(suspended.data.status, 'suspended');

      const reactivated = await organizationsApi.reactivate(ORG_ID, 'Payment resolved');
      assert.equal(reactivated.data.status, 'active');

      const closed = await organizationsApi.close(ORG_ID, 'Tenant requested closure');
      assert.equal(closed.data.status, 'closed');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Workspaces API
  // ---------------------------------------------------------------------------
  describe('Workspaces API (workspacesApi)', () => {
    it('list calls canonical /workspaces with tenant pinning header and query filters', async () => {
      mockHandlers.push({
        match: (url) => url.includes('/workspaces'),
        handle: () =>
          new Response(
            JSON.stringify({
              data: [mockWorkspace],
              page: { nextCursor: null, hasMore: false, limit: 25 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await workspacesApi.list({
        status: 'active',
        cursor: 'cur-1',
        limit: 15,
        sort: 'name',
      });

      assert.equal(res.data.length, 1);
      const call = fetchCalls[0]!;
      assert.ok(call.url.includes('/workspaces?'));
      assert.ok(call.url.includes('status=active'));
      assert.ok(call.url.includes('cursor=cur-1'));
      assert.ok(call.url.includes('limit=15'));

      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_ID);
    });

    it('get calls /workspaces/:id with tenant pinning header', async () => {
      mockHandlers.push({
        match: (url) => url.endsWith(`/workspaces/${WS_ID}`),
        handle: () =>
          new Response(JSON.stringify({ data: mockWorkspace }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });

      const res = await workspacesApi.get(WS_ID);
      assert.equal(res.data.id, WS_ID);
      assert.equal(res.data.isDefault, true);

      const call = fetchCalls[0]!;
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_ID);
    });

    it('create calls POST /workspaces with Idempotency-Key and safe payload', async () => {
      let capturedBody: unknown;
      let capturedHeaders: Record<string, string> = {};

      mockHandlers.push({
        match: (url, opts) => url.endsWith('/workspaces') && opts.method === 'POST',
        handle: (_url, opts) => {
          capturedHeaders = opts.headers as Record<string, string>;
          capturedBody = JSON.parse(opts.body as string);
          return new Response(JSON.stringify({ data: mockWorkspace }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const idempotencyKey = 'ws-idem-uuid';
      const res = await workspacesApi.create({ name: 'Default Workspace', slug: 'default-workspace' }, idempotencyKey);

      assert.equal(res.data.slug, 'default-workspace');
      assert.deepEqual(capturedBody, { name: 'Default Workspace', slug: 'default-workspace' });
      assert.equal(capturedHeaders['Idempotency-Key'], idempotencyKey);
      assert.equal(capturedHeaders['X-Acc-Organization'], ORG_ID);
    });

    it('update sends PATCH with name only and strips forbidden fields', async () => {
      let capturedBody: unknown;
      mockHandlers.push({
        match: (url, opts) => url.endsWith(`/workspaces/${WS_ID}`) && opts.method === 'PATCH',
        handle: (_url, opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return new Response(JSON.stringify({ data: { ...mockWorkspace, name: 'Support WS' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const res = await workspacesApi.update(WS_ID, { name: 'Support WS' });
      assert.equal(res.data.name, 'Support WS');
      assert.deepEqual(capturedBody, { name: 'Support WS' });
    });

    it('archive and restore execute POST to :id/archive and :id/restore', async () => {
      mockHandlers.push({
        match: (url) => url.endsWith(`/workspaces/${WS_ID}/archive`),
        handle: () =>
          new Response(JSON.stringify({ data: { ...mockWorkspace, status: 'archived' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      mockHandlers.push({
        match: (url) => url.endsWith(`/workspaces/${WS_ID}/restore`),
        handle: () =>
          new Response(JSON.stringify({ data: { ...mockWorkspace, status: 'active' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });

      const archived = await workspacesApi.archive(WS_ID);
      assert.equal(archived.data.status, 'archived');

      const restored = await workspacesApi.restore(WS_ID);
      assert.equal(restored.data.status, 'active');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Teams API
  // ---------------------------------------------------------------------------
  describe('Teams API (teamsApi)', () => {
    it('list calls /teams and NEVER sends orgId in query params', async () => {
      mockHandlers.push({
        match: (url) => url.includes('/teams'),
        handle: () =>
          new Response(
            JSON.stringify({
              data: [mockTeam],
              page: { nextCursor: null, hasMore: false, limit: 25 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await teamsApi.list({
        workspaceId: WS_ID,
        status: 'active',
        cursor: 'team-cur',
        limit: 20,
        sort: 'name',
      });

      assert.equal(res.data.length, 1);
      const call = fetchCalls[0]!;
      assert.ok(call.url.includes('/teams?'));
      assert.ok(call.url.includes(`workspaceId=${WS_ID}`));
      assert.ok(call.url.includes('status=active'));
      assert.ok(call.url.includes('cursor=team-cur'));
      assert.ok(call.url.includes('limit=20'));
      assert.ok(!call.url.includes('orgId='), 'Must NEVER include orgId in query');

      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_ID);
    });

    it('get calls /teams/:id with tenant pinning header', async () => {
      mockHandlers.push({
        match: (url) => url.endsWith(`/teams/${TEAM_ID}`),
        handle: () =>
          new Response(JSON.stringify({ data: mockTeam }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });

      const res = await teamsApi.get(TEAM_ID);
      assert.equal(res.data.id, TEAM_ID);
      assert.equal(res.data.workspaceId, WS_ID);

      const call = fetchCalls[0]!;
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_ID);
    });

    it('create calls POST /teams with Idempotency-Key and NEVER sends orgId in body', async () => {
      let capturedBody: unknown;
      let capturedHeaders: Record<string, string> = {};

      mockHandlers.push({
        match: (url, opts) => url.endsWith('/teams') && opts.method === 'POST',
        handle: (_url, opts) => {
          capturedHeaders = opts.headers as Record<string, string>;
          capturedBody = JSON.parse(opts.body as string);
          return new Response(JSON.stringify({ data: mockTeam }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const idempotencyKey = 'team-idem-uuid';
      const res = await teamsApi.create({ workspaceId: WS_ID, name: 'Customer Support' }, idempotencyKey);

      assert.equal(res.data.name, 'Customer Support');
      assert.deepEqual(capturedBody, { workspaceId: WS_ID, name: 'Customer Support' });
      assert.equal((capturedBody as Record<string, unknown>).orgId, undefined, 'Must NEVER send orgId in body');
      assert.equal(capturedHeaders['Idempotency-Key'], idempotencyKey);
      assert.equal(capturedHeaders['X-Acc-Organization'], ORG_ID);
    });

    it('update sends PATCH with name only and NEVER sends orgId, workspaceId, or status', async () => {
      let capturedBody: unknown;
      mockHandlers.push({
        match: (url, opts) => url.endsWith(`/teams/${TEAM_ID}`) && opts.method === 'PATCH',
        handle: (_url, opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return new Response(JSON.stringify({ data: { ...mockTeam, name: 'Tier 2 Support' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const res = await teamsApi.update(TEAM_ID, { name: 'Tier 2 Support' });
      assert.equal(res.data.name, 'Tier 2 Support');
      assert.deepEqual(capturedBody, { name: 'Tier 2 Support' });
      assert.equal((capturedBody as Record<string, unknown>).orgId, undefined);
      assert.equal((capturedBody as Record<string, unknown>).workspaceId, undefined);
      assert.equal((capturedBody as Record<string, unknown>).status, undefined);
    });

    it('archive and restore execute POST to :id/archive and :id/restore', async () => {
      mockHandlers.push({
        match: (url) => url.endsWith(`/teams/${TEAM_ID}/archive`),
        handle: () =>
          new Response(JSON.stringify({ data: { ...mockTeam, status: 'archived' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      mockHandlers.push({
        match: (url) => url.endsWith(`/teams/${TEAM_ID}/restore`),
        handle: () =>
          new Response(JSON.stringify({ data: { ...mockTeam, status: 'active' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });

      const archived = await teamsApi.archive(TEAM_ID);
      assert.equal(archived.data.status, 'archived');

      const restored = await teamsApi.restore(TEAM_ID);
      assert.equal(restored.data.status, 'active');
    });
  });
});
