import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditLogsApi,
  setAccessToken,
  setSelectedOrganization,
  ApiError,
  type AuditLogView,
  type ListAuditLogsParams,
} from './api-client';
import { useSession } from './session-store';

describe('Audit Logs Administration API Client', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';

  const mockLog: AuditLogView = {
    id: '01955b0a-7b3b-7411-9a4f-log000000001',
    occurredAt: '2026-09-24T12:00:00.000Z',
    action: 'api_key.create',
    outcome: 'success',
    actorType: 'user',
    actorUserId: '01955b0a-7b3b-7411-9a4f-user00000001',
    actorApiKeyId: null,
    actorLabel: 'Admin Alice',
    resourceType: 'api_key',
    resourceId: '01955b0a-7b3b-7411-9a4f-key0000000001',
    scopeType: 'organization',
    scopeId: ORG_ID,
    resellerId: null,
    orgId: ORG_ID,
    workspaceId: null,
    teamId: null,
    before: null,
    after: { name: 'CI Pipeline Key', scopes: ['messages.send'] },
    metadata: { clientIp: '192.168.1.1' },
    correlationId: '01955b0a-7b3b-7411-9a4f-trace00000001',
    causationId: null,
    ip: '192.168.1.1',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
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
            permissions: ['audit.read', 'api_keys.read'],
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

      return new Response(
        JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false } }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setAccessToken(null);
    setSelectedOrganization(null);
  });

  // ---------------------------------------------------------------------------
  // 1. List Audit Logs with Query Filters & Keyset Pagination
  // ---------------------------------------------------------------------------
  it('1. auditLogsApi.list attaches X-Acc-Organization and constructs query params correctly', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/audit-logs') && !url.includes('/audit-logs/01955b'),
      handle: (url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Authorization'], 'Bearer mock-access-token');

        const parsedUrl = new URL(url, 'http://localhost');
        assert.equal(parsedUrl.searchParams.get('action'), 'api_key.create');
        assert.equal(parsedUrl.searchParams.get('actorType'), 'user');
        assert.equal(
          parsedUrl.searchParams.get('actorUserId'),
          '01955b0a-7b3b-7411-9a4f-user00000001',
        );
        assert.equal(parsedUrl.searchParams.get('outcome'), 'success');
        assert.equal(parsedUrl.searchParams.get('resourceType'), 'api_key');
        assert.equal(
          parsedUrl.searchParams.get('resourceId'),
          '01955b0a-7b3b-7411-9a4f-key0000000001',
        );
        assert.equal(parsedUrl.searchParams.get('scopeType'), 'organization');
        assert.equal(parsedUrl.searchParams.get('scopeId'), ORG_ID);
        assert.equal(
          parsedUrl.searchParams.get('correlationId'),
          '01955b0a-7b3b-7411-9a4f-trace00000001',
        );
        assert.equal(parsedUrl.searchParams.get('occurredFrom'), '2026-09-01T00:00:00.000Z');
        assert.equal(parsedUrl.searchParams.get('occurredTo'), '2026-09-24T23:59:59.999Z');
        assert.equal(parsedUrl.searchParams.get('cursor'), '01955b0a-cursor-id');
        assert.equal(parsedUrl.searchParams.get('limit'), '50');
        assert.equal(parsedUrl.searchParams.get('sort'), '-occurredAt');

        return new Response(
          JSON.stringify({
            data: [mockLog],
            page: { nextCursor: '01955b0a-next-cursor', hasMore: true },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const params: ListAuditLogsParams = {
      action: 'api_key.create',
      actorType: 'user',
      actorUserId: '01955b0a-7b3b-7411-9a4f-user00000001',
      outcome: 'success',
      resourceType: 'api_key',
      resourceId: '01955b0a-7b3b-7411-9a4f-key0000000001',
      scopeType: 'organization',
      scopeId: ORG_ID,
      correlationId: '01955b0a-7b3b-7411-9a4f-trace00000001',
      occurredFrom: '2026-09-01T00:00:00.000Z',
      occurredTo: '2026-09-24T23:59:59.999Z',
      cursor: '01955b0a-cursor-id',
      limit: 50,
      sort: '-occurredAt',
    };

    const res = await auditLogsApi.list(params);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]?.id, mockLog.id);
    assert.equal(res.data[0]?.action, 'api_key.create');
    assert.equal(res.page?.nextCursor, '01955b0a-next-cursor');
    assert.equal(res.page?.hasMore, true);
  });

  it('2. auditLogsApi.list defaults to endpoint with no query string when params are empty', async () => {
    mockHandlers.push({
      match: (url) => url.endsWith('/audit-logs'),
      handle: () => {
        return new Response(
          JSON.stringify({
            data: [],
            page: { nextCursor: null, hasMore: false },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    const res = await auditLogsApi.list({});
    assert.equal(res.data.length, 0);
    assert.equal(fetchCalls.length, 1);
    const firstCall = fetchCalls[0];
    assert(firstCall);
    const parsed = new URL(firstCall.url, 'http://localhost');
    assert.equal(parsed.pathname, '/api/v1/audit-logs');
    assert.equal(parsed.search, '');
  });

  // ---------------------------------------------------------------------------
  // 2. Get Audit Log by ID
  // ---------------------------------------------------------------------------
  it('3. auditLogsApi.get fetches single audit log by ID', async () => {
    mockHandlers.push({
      match: (url) => url.includes(`/audit-logs/${mockLog.id}`),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_ID);
        assert.equal(headers['Authorization'], 'Bearer mock-access-token');

        return new Response(JSON.stringify({ data: mockLog }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const res = await auditLogsApi.get(mockLog.id);
    assert.equal(res.data.id, mockLog.id);
    assert.equal(res.data.action, 'api_key.create');
    assert.equal(res.data.correlationId, '01955b0a-7b3b-7411-9a4f-trace00000001');
    assert.equal(res.data.after?.name, 'CI Pipeline Key');
  });

  it('4. auditLogsApi.get throws ApiError 404 when audit log not found', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/audit-logs/nonexistent-id'),
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: 'Audit log event nonexistent-id was not found',
              correlationId: 'req-404',
              retryable: false,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await auditLogsApi.get('nonexistent-id');
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'NOT_FOUND');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Error Handling: 400 Validation & 403 Forbidden
  // ---------------------------------------------------------------------------
  it('5. auditLogsApi.list throws ApiError 400 on invalid sort parameter', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/audit-logs'),
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Invalid sort parameter: only occurredAt or -occurredAt supported',
              correlationId: 'req-400-sort',
              retryable: false,
              details: {
                fieldErrors: [{ field: 'sort', message: 'Unsupported sort field' }],
              },
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await auditLogsApi.list({ sort: 'actorType' });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 400);
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.equal(err.retryable, false);
        assert.ok(err.details);
        return true;
      },
    );
  });

  it('6. auditLogsApi.list throws ApiError 403 when lacking audit.read permission', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/audit-logs'),
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_SCOPE_DENIED',
              message: 'Caller lacks audit.read permission in the requested scope',
              correlationId: 'req-403',
              retryable: false,
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await auditLogsApi.list();
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_SCOPE_DENIED');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 4. AbortSignal Support
  // ---------------------------------------------------------------------------
  it('7. auditLogsApi.list forwards AbortSignal properly', async () => {
    const controller = new AbortController();
    mockHandlers.push({
      match: (url) => url.includes('/audit-logs'),
      handle: (_url, options) => {
        assert.equal(options.signal, controller.signal);
        return new Response(
          JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await auditLogsApi.list({}, controller.signal);
    assert.equal(fetchCalls.length, 1);
  });
});
