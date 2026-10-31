import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { templatesApi, contactsApi, messagesApi } from './api-client';
import { useSession } from './session-store';

describe('WhatsApp Management API Clients (Templates, Contacts, Messages)', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const WORKSPACE_1 = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';
  const TEMPLATE_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f93333';
  const CONTACT_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f94444';
  const MESSAGE_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f95555';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f96666';

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
      accessToken: 'test-token',
      user: {
        userId: 'user-1',
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
        authorizedOrganizationIds: [ORG_A],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'user-1',
        apiKeyId: null,
        grants: [],
        organizationIds: [ORG_A],
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
  // Templates API
  // ---------------------------------------------------------------------------
  describe('templatesApi', () => {
    it('list constructs query parameters and attaches X-Acc-Organization', async () => {
      mockHandlers.push({
        match: (url, opts) => opts.method === 'GET' && url.includes('/templates'),
        handle: () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: TEMPLATE_ID,
                  orgId: ORG_A,
                  channelId: CHANNEL_ID,
                  name: 'welcome_template',
                  body: 'Hello {{1}}',
                  variables: ['1'],
                  approvalStatus: 'approved',
                  createdAt: '2026-10-15T10:00:00Z',
                  updatedAt: '2026-10-15T10:00:00Z',
                },
              ],
              page: { nextCursor: null, hasMore: false, limit: 20 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await templatesApi.list({
        approvalStatus: 'approved',
        channelId: CHANNEL_ID,
        limit: 20,
      });

      assert.equal(res.data.length, 1);
      assert.equal(res.data[0]?.name, 'welcome_template');
      assert.equal(res.data[0]?.approvalStatus, 'approved');

      const call = fetchCalls[0]!;
      assert.ok(call.url.includes('approvalStatus=approved'));
      assert.ok(call.url.includes(`channelId=${CHANNEL_ID}`));
      assert.ok(call.url.includes('limit=20'));
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_A);
    });

    it('create sends payload, Idempotency-Key, and attaches X-Acc-Organization', async () => {
      mockHandlers.push({
        match: (url, opts) => opts.method === 'POST' && url.endsWith('/templates'),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                id: TEMPLATE_ID,
                orgId: ORG_A,
                channelId: CHANNEL_ID,
                name: 'order_update',
                body: 'Your order {{1}} is ready',
                variables: ['1'],
                approvalStatus: 'draft',
                createdAt: '2026-10-15T10:00:00Z',
                updatedAt: '2026-10-15T10:00:00Z',
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await templatesApi.create(
        {
          channelId: CHANNEL_ID,
          name: 'order_update',
          body: 'Your order {{1}} is ready',
          variables: ['1'],
        },
        'idem-key-1',
      );

      assert.equal(res.data.name, 'order_update');
      assert.equal(res.data.approvalStatus, 'draft');

      const call = fetchCalls[0]!;
      assert.equal(call.options.method, 'POST');
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['Idempotency-Key'], 'idem-key-1');
      assert.equal(headers['X-Acc-Organization'], ORG_A);
      const parsedBody = JSON.parse(call.options.body as string);
      assert.equal(parsedBody.name, 'order_update');
    });

    it('simulateApproval dispatches targetStatus to /templates/:id/simulate-approval', async () => {
      mockHandlers.push({
        match: (url, opts) => opts.method === 'POST' && url.includes('/simulate-approval'),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                id: TEMPLATE_ID,
                orgId: ORG_A,
                channelId: CHANNEL_ID,
                name: 'order_update',
                body: 'Your order {{1}} is ready',
                variables: ['1'],
                approvalStatus: 'approved',
                createdAt: '2026-10-15T10:00:00Z',
                updatedAt: '2026-10-15T10:05:00Z',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await templatesApi.simulateApproval(TEMPLATE_ID, 'approved');
      assert.equal(res.data.approvalStatus, 'approved');

      const call = fetchCalls[0]!;
      assert.ok(call.url.endsWith(`/templates/${TEMPLATE_ID}/simulate-approval`));
      const parsedBody = JSON.parse(call.options.body as string);
      assert.equal(parsedBody.targetStatus, 'approved');
    });

    it('update sends PATCH with name and body and attaches X-Acc-Organization', async () => {
      mockHandlers.push({
        match: (url, opts) => opts.method === 'PATCH' && url.includes(`/templates/${TEMPLATE_ID}`),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                id: TEMPLATE_ID,
                orgId: ORG_A,
                channelId: CHANNEL_ID,
                name: 'order_update_v2',
                body: 'Your order {{1}} is out for delivery',
                variables: ['1'],
                approvalStatus: 'draft',
                createdAt: '2026-10-15T10:00:00Z',
                updatedAt: '2026-10-15T10:10:00Z',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await templatesApi.update(TEMPLATE_ID, {
        name: 'order_update_v2',
        body: 'Your order {{1}} is out for delivery',
      });

      assert.equal(res.data.name, 'order_update_v2');
      const call = fetchCalls[0]!;
      assert.equal(call.options.method, 'PATCH');
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_A);
      const parsedBody = JSON.parse(call.options.body as string);
      assert.equal(parsedBody.name, 'order_update_v2');
    });

    it('delete sends DELETE to /templates/:id and attaches X-Acc-Organization', async () => {
      mockHandlers.push({
        match: (url, opts) => opts.method === 'DELETE' && url.includes(`/templates/${TEMPLATE_ID}`),
        handle: () => new Response(null, { status: 204 }),
      });

      await templatesApi.delete(TEMPLATE_ID);
      const call = fetchCalls[0]!;
      assert.equal(call.options.method, 'DELETE');
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_A);
    });
  });

  // ---------------------------------------------------------------------------
  // Contacts API
  // ---------------------------------------------------------------------------
  describe('contactsApi', () => {
    it('list queries /workspaces/:workspaceId/contacts with pagination parameters', async () => {
      mockHandlers.push({
        match: (url, opts) =>
          opts.method === 'GET' && url.includes(`/workspaces/${WORKSPACE_1}/contacts`),
        handle: () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: CONTACT_ID,
                  workspaceId: WORKSPACE_1,
                  firstName: 'Jane',
                  lastName: 'Doe',
                  metadata: {},
                  createdAt: '2026-10-15T10:00:00Z',
                  updatedAt: '2026-10-15T10:00:00Z',
                },
              ],
              page: { nextCursor: null, hasMore: false, limit: 50 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await contactsApi.list(WORKSPACE_1, { limit: 50 });
      assert.equal(res.data.length, 1);
      assert.equal(res.data[0]?.firstName, 'Jane');

      const call = fetchCalls[0]!;
      assert.ok(call.url.includes(`/workspaces/${WORKSPACE_1}/contacts?limit=50`));
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_A);
    });

    it('create dispatches POST with idempotency key to workspace route', async () => {
      mockHandlers.push({
        match: (url, opts) =>
          opts.method === 'POST' && url.includes(`/workspaces/${WORKSPACE_1}/contacts`),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                id: CONTACT_ID,
                workspaceId: WORKSPACE_1,
                firstName: 'Alice',
                lastName: 'Smith',
                metadata: {},
                createdAt: '2026-10-15T10:00:00Z',
                updatedAt: '2026-10-15T10:00:00Z',
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await contactsApi.create(
        WORKSPACE_1,
        { firstName: 'Alice', lastName: 'Smith' },
        'idem-contact-1',
      );
      assert.equal(res.data.firstName, 'Alice');

      const call = fetchCalls[0]!;
      assert.equal(call.options.method, 'POST');
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['Idempotency-Key'], 'idem-contact-1');
      assert.equal(headers['X-Acc-Organization'], ORG_A);
    });

    it('createIdentity and createConsentEvent post to contact resource paths', async () => {
      mockHandlers.push({
        match: (url, opts) =>
          opts.method === 'POST' && url.includes(`/contacts/${CONTACT_ID}/identities`),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                id: 'identity-1',
                workspaceId: WORKSPACE_1,
                contactId: CONTACT_ID,
                channelId: CHANNEL_ID,
                rawAddress: '+12025550199',
                normalizedAddress: '+12025550199',
                isPrimary: true,
                status: 'active',
                createdAt: '2026-10-15T10:00:00Z',
                updatedAt: '2026-10-15T10:00:00Z',
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      mockHandlers.push({
        match: (url, opts) =>
          opts.method === 'POST' && url.includes(`/contacts/${CONTACT_ID}/consent-events`),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                id: 'consent-1',
                workspaceId: WORKSPACE_1,
                contactId: CONTACT_ID,
                channelId: CHANNEL_ID,
                consentType: 'transactional',
                event: 'grant',
                occurredAt: '2026-10-15T10:00:00Z',
                source: 'web_form',
                createdAt: '2026-10-15T10:00:00Z',
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const idRes = await contactsApi.createIdentity(CONTACT_ID, {
        channelId: CHANNEL_ID,
        rawAddress: '+12025550199',
        isPrimary: true,
      });
      assert.equal(idRes.data.rawAddress, '+12025550199');

      const consentRes = await contactsApi.createConsentEvent(CONTACT_ID, {
        channelId: CHANNEL_ID,
        consentType: 'transactional',
        event: 'grant',
        occurredAt: new Date().toISOString(),
        source: 'web_form',
      });
      assert.equal(consentRes.data.event, 'grant');
    });

    it('getEffectiveConsent queries /contacts/:id/consent-effective with query parameters', async () => {
      mockHandlers.push({
        match: (url, opts) =>
          opts.method === 'GET' && url.includes(`/contacts/${CONTACT_ID}/consent-effective`),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                contactId: CONTACT_ID,
                channelId: CHANNEL_ID,
                consentType: 'transactional',
                effectiveState: 'opted_in',
                evaluatedAt: '2026-10-15T10:00:00Z',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await contactsApi.getEffectiveConsent(CONTACT_ID, {
        channelId: CHANNEL_ID,
        consentType: 'transactional',
      });

      assert.equal(res.data.effectiveState, 'opted_in');
      const call = fetchCalls[0]!;
      assert.ok(call.url.includes(`channelId=${CHANNEL_ID}`));
      assert.ok(call.url.includes('consentType=transactional'));
    });

    it('update sends PATCH to /contacts/:id and attaches X-Acc-Organization', async () => {
      mockHandlers.push({
        match: (url, opts) => opts.method === 'PATCH' && url.includes(`/contacts/${CONTACT_ID}`),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                id: CONTACT_ID,
                workspaceId: WORKSPACE_1,
                firstName: 'Alice',
                lastName: 'Smith',
                metadata: { vip: true },
                createdAt: '2026-10-15T10:00:00Z',
                updatedAt: '2026-10-15T10:05:00Z',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await contactsApi.update(CONTACT_ID, {
        firstName: 'Alice',
        lastName: 'Smith',
        metadata: { vip: true },
      });

      assert.equal(res.data.firstName, 'Alice');
      const call = fetchCalls[0]!;
      assert.equal(call.options.method, 'PATCH');
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_A);
    });

    it('listIdentities sends GET to /contacts/:id/identities and attaches X-Acc-Organization', async () => {
      mockHandlers.push({
        match: (url, opts) =>
          opts.method === 'GET' && url.includes(`/contacts/${CONTACT_ID}/identities`),
        handle: () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'idnt-1',
                  workspaceId: WORKSPACE_1,
                  contactId: CONTACT_ID,
                  channelId: CHANNEL_ID,
                  rawAddress: '+12025550199',
                  normalizedAddress: '+12025550199',
                  isPrimary: true,
                  status: 'active',
                  createdAt: '2026-10-15T10:00:00Z',
                  updatedAt: '2026-10-15T10:00:00Z',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await contactsApi.listIdentities(CONTACT_ID);
      assert.equal(res.data.length, 1);
      assert.equal(res.data[0]?.rawAddress, '+12025550199');
      const call = fetchCalls[0]!;
      assert.equal(call.options.method, 'GET');
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_A);
    });
  });

  // ---------------------------------------------------------------------------
  // Messages API
  // ---------------------------------------------------------------------------
  describe('messagesApi', () => {
    it('send posts to /messages with idempotency key and returns 202 Accepted envelope', async () => {
      mockHandlers.push({
        match: (url, opts) => opts.method === 'POST' && url.endsWith('/messages'),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                id: MESSAGE_ID,
                orgId: ORG_A,
                channelCode: 'whatsapp',
                status: 'queued',
                createdAt: '2026-10-15T10:00:00Z',
              },
            }),
            { status: 202, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await messagesApi.send(
        {
          channelCode: 'whatsapp',
          recipient: '+12025550199',
          workspaceId: WORKSPACE_1,
          templateId: TEMPLATE_ID,
          payload: { name: 'Alice' },
        },
        'idem-msg-1',
      );

      assert.equal(res.data.id, MESSAGE_ID);
      assert.equal(res.data.status, 'queued');

      const call = fetchCalls[0]!;
      assert.equal(call.options.method, 'POST');
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['Idempotency-Key'], 'idem-msg-1');
      assert.equal(headers['X-Acc-Organization'], ORG_A);
    });

    it('get retrieves message details with attempt history and failure info', async () => {
      mockHandlers.push({
        match: (url, opts) => opts.method === 'GET' && url.endsWith(`/messages/${MESSAGE_ID}`),
        handle: () =>
          new Response(
            JSON.stringify({
              data: {
                id: MESSAGE_ID,
                orgId: ORG_A,
                workspaceId: WORKSPACE_1,
                contactId: CONTACT_ID,
                channelId: CHANNEL_ID,
                templateId: TEMPLATE_ID,
                status: 'accepted',
                recipientAddress: '+12025550199',
                payload: { name: 'Alice' },
                failureReason: null,
                createdAt: '2026-10-15T10:00:00Z',
                completedAt: '2026-10-15T10:00:02Z',
                attempts: [
                  {
                    id: 'att-1',
                    attemptNumber: 1,
                    providerId: 'prov-primary',
                    status: 'failed',
                    failureReason: 'PROVIDER_ERROR_500: Internal server error',
                    latencyMs: 142,
                    completedAt: '2026-10-15T10:00:01Z',
                  },
                  {
                    id: 'att-2',
                    attemptNumber: 2,
                    providerId: 'prov-secondary',
                    status: 'accepted',
                    failureReason: null,
                    latencyMs: 88,
                    completedAt: '2026-10-15T10:00:02Z',
                  },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      const res = await messagesApi.get(MESSAGE_ID);
      assert.equal(res.data.status, 'accepted');
      assert.equal(res.data.attempts.length, 2);
      assert.equal(res.data.attempts[0]?.status, 'failed');
      assert.equal(res.data.attempts[1]?.status, 'accepted');

      const call = fetchCalls[0]!;
      assert.ok(call.url.endsWith(`/messages/${MESSAGE_ID}`));
      const headers = call.options.headers as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], ORG_A);
    });
  });
});
