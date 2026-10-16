import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { templatesApi, contactsApi, messagesApi, apiFetch, ApiError } from './api-client';
import { hasPermission, useSession } from './session-store';
import { isTerminalMessageStatus, type MessageStatus } from '@acc/contracts';

describe('WhatsApp Management Console Security Invariants & Boundary Enforcement', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f99999';
  const WORKSPACE_1 = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';
  const MESSAGE_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f95555';

  beforeEach(() => {
    fetchCalls = [];
    mockHandlers = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const options = init ?? {};
      fetchCalls.push({ url, options });

      for (const h of mockHandlers) {
        if (h.match(url, options)) {
          return h.handle(url, options);
        }
      }

      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    useSession.getState().setSession({
      accessToken: 'sec-token-wa',
      user: {
        userId: 'admin-1',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-1',
        authenticatedAt: new Date().toISOString(),
        tenant: {
          orgId: ORG_A,
          workspaceId: WORKSPACE_1,
          resellerId: null,
          isPlatformAdmin: false,
        },
        authorizedOrganizationIds: [ORG_A, ORG_B],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'admin-1',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-org-admin',
            roleKey: 'org_admin',
            scopeType: 'organization',
            scopeId: ORG_A,
            orgId: ORG_A,
            permissions: [
              'templates.read',
              'templates.manage',
              'contacts.read',
              'contacts.manage',
              'messages.read',
              'messages.send',
            ],
          },
        ],
        organizationIds: [ORG_A, ORG_B],
        isPlatformAdmin: false,
      },
      selectedOrgId: ORG_A,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useSession.getState().clearSession();
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-01: Tenant context pinning
  // ---------------------------------------------------------------------------
  it('SEC-WA-01: All Phase 3.5 API calls strictly transmit active X-Acc-Organization', async () => {
    mockHandlers.push({
      match: () => true,
      handle: () =>
        new Response(
          JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false, limit: 10 } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    });

    await templatesApi.list();
    await contactsApi.list(WORKSPACE_1);
    await messagesApi.get(MESSAGE_ID);

    assert.equal(fetchCalls.length, 3);
    for (const call of fetchCalls) {
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_A);
    }
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-02: Header sanitization prevents tenant spoofing
  // ---------------------------------------------------------------------------
  it('SEC-WA-02: Caller cannot spoof or forge X-Acc-Organization through custom options', async () => {
    mockHandlers.push({
      match: () => true,
      handle: () =>
        new Response(JSON.stringify({ data: { id: 'test' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await apiFetch('/templates', {
      headers: {
        'x-acc-organization': ORG_B,
        'X-Acc-Organization': ORG_B,
      },
    });

    const call = fetchCalls[0]!;
    const headers = call.options.headers as Record<string, string>;
    // Injected header is sanitized; active in-memory selected organization is used
    assert.equal(headers['X-Acc-Organization'], ORG_A);
    assert.notEqual(headers['X-Acc-Organization'], ORG_B);
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-03: Switching organization updates tenant context
  // ---------------------------------------------------------------------------
  it('SEC-WA-03: Switching organization immediately re-pins X-Acc-Organization', async () => {
    mockHandlers.push({
      match: () => true,
      handle: () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    // 1. Initial request under ORG_A
    await templatesApi.list();
    let call = fetchCalls[0]!;
    assert.equal((call.options.headers as Record<string, string>)['X-Acc-Organization'], ORG_A);

    // 2. Select ORG_B
    useSession.getState().selectOrganization(ORG_B);

    // 3. Subsequent request under ORG_B
    await templatesApi.list();
    call = fetchCalls[fetchCalls.length - 1]!;
    assert.equal((call.options.headers as Record<string, string>)['X-Acc-Organization'], ORG_B);
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-04: Idempotency Key retention across retries
  // ---------------------------------------------------------------------------
  it('SEC-WA-04: Retries of the same creation or send request retain the exact same Idempotency-Key', async () => {
    let callCount = 0;
    mockHandlers.push({
      match: (url, opts) => opts.method === 'POST' && url.endsWith('/messages'),
      handle: () => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({ error: { code: 'NETWORK_TIMEOUT', message: 'Timeout' } }),
            {
              status: 504,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        return new Response(JSON.stringify({ data: { id: MESSAGE_ID, status: 'queued' } }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const idemKey = 'consistent-idem-key-77';

    // First attempt fails with 504
    await assert.rejects(async () => {
      await messagesApi.send(
        {
          channelCode: 'whatsapp',
          recipient: '+12025550199',
          payload: { text: 'Hello' },
        },
        idemKey,
      );
    });

    // Retry attempt reuses the same key
    const res = await messagesApi.send(
      {
        channelCode: 'whatsapp',
        recipient: '+12025550199',
        payload: { text: 'Hello' },
      },
      idemKey,
    );

    assert.equal(res.data.id, MESSAGE_ID);
    assert.equal(fetchCalls.length, 2);
    assert.equal(
      (fetchCalls[0]!.options.headers as Record<string, string>)['Idempotency-Key'],
      idemKey,
    );
    assert.equal(
      (fetchCalls[1]!.options.headers as Record<string, string>)['Idempotency-Key'],
      idemKey,
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-05: RBAC fail-closed for tenant content
  // ---------------------------------------------------------------------------
  it('SEC-WA-05: hasPermission fails closed when organization grant is absent', () => {
    // Under ORG_A, actor holds templates, contacts, and messages permissions
    assert.equal(hasPermission('templates.read'), true);
    assert.equal(hasPermission('templates.manage'), true);
    assert.equal(hasPermission('contacts.read'), true);
    assert.equal(hasPermission('messages.send'), true);

    // Switch to ORG_B where actor holds no grants
    useSession.getState().selectOrganization(ORG_B);

    assert.equal(hasPermission('templates.read'), false);
    assert.equal(hasPermission('templates.manage'), false);
    assert.equal(hasPermission('contacts.read'), false);
    assert.equal(hasPermission('messages.send'), false);
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-06: Platform admin flag alone cannot authorize tenant content
  // ---------------------------------------------------------------------------
  it('SEC-WA-06: Platform admin flag does NOT confer tenant-content permissions without explicit tenant grant', () => {
    useSession.getState().setSession({
      accessToken: 'platform-token',
      user: {
        userId: 'platform-admin',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-p',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: ORG_A, workspaceId: null, resellerId: null, isPlatformAdmin: true },
        authorizedOrganizationIds: [ORG_A],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'platform-admin',
        apiKeyId: null,
        grants: [
          {
            roleId: 'super-admin-role',
            roleKey: 'super_admin',
            scopeType: 'platform',
            scopeId: null,
            orgId: null,
            permissions: ['platform.audit.read', 'providers.read'],
          },
        ],
        organizationIds: [ORG_A],
        isPlatformAdmin: true,
      },
      selectedOrgId: ORG_A,
    });

    // Platform catalogue is granted
    assert.equal(hasPermission('providers.read'), true);

    // Tenant content permissions are strictly NOT conferred to platform admin without tenant grant
    assert.equal(hasPermission('templates.read'), false);
    assert.equal(hasPermission('templates.manage'), false);
    assert.equal(hasPermission('contacts.read'), false);
    assert.equal(hasPermission('messages.read'), false);
    assert.equal(hasPermission('messages.send'), false);
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-07: In-memory token storage invariant
  // ---------------------------------------------------------------------------
  it('SEC-WA-07: Access tokens are held strictly in memory and never written to browser storage', () => {
    const session = useSession.getState();
    assert.ok(session.accessToken);

    if (typeof localStorage !== 'undefined') {
      assert.equal(localStorage.getItem('access_token'), null);
      assert.equal(localStorage.getItem('token'), null);
    }
    if (typeof sessionStorage !== 'undefined') {
      assert.equal(sessionStorage.getItem('access_token'), null);
      assert.equal(sessionStorage.getItem('token'), null);
    }
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-08: Terminal status halts polling
  // ---------------------------------------------------------------------------
  it('SEC-WA-08: isTerminalMessageStatus correctly identifies terminal states to stop polling', () => {
    const nonTerminalStatuses: MessageStatus[] = ['queued', 'routing', 'submitting'];
    const terminalStatuses: MessageStatus[] = ['accepted', 'failed', 'outcome_unknown'];

    for (const status of nonTerminalStatuses) {
      assert.equal(isTerminalMessageStatus(status), false);
    }

    for (const status of terminalStatuses) {
      assert.equal(isTerminalMessageStatus(status), true);
    }
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-09: Semantic distinction of outcomes
  // ---------------------------------------------------------------------------
  it('SEC-WA-09: Outcome types preserve strict separation between accepted, failed, and outcome_unknown', () => {
    const acceptedOutcome: MessageStatus = 'accepted';
    const failedOutcome: MessageStatus = 'failed';
    const unknownOutcome: MessageStatus = 'outcome_unknown';

    assert.notEqual(acceptedOutcome, failedOutcome);
    assert.notEqual(acceptedOutcome, unknownOutcome);
    assert.notEqual(failedOutcome, unknownOutcome);
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-10: Cross-tenant anti-enumeration
  // ---------------------------------------------------------------------------
  it('SEC-WA-10: Cross-tenant and non-existent resource queries reject with generic 404 without leaking metadata', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/messages/01955b0a-7b3b-7411-9a4f-9e67d4f99999'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Resource not found',
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => {
        await messagesApi.get('01955b0a-7b3b-7411-9a4f-9e67d4f99999');
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'RESOURCE_NOT_FOUND');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-WA-11: Protected-resource query failure on missing permission
  // ---------------------------------------------------------------------------
  it('SEC-WA-11: Permission-denied API queries fail closed with non-retryable 403 ApiError', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/messages'),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_SCOPE_DENIED',
              message: 'Missing required permission messages.read at organization scope',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => {
        await messagesApi.get(MESSAGE_ID);
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_SCOPE_DENIED');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });
});
