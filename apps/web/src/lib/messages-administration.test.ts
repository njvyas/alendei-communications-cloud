import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  messagesApi,
  maskRecipientAddress,
  setSelectedOrganization,
  registerOrgValidator,
  type MessageSummaryResponse,
  type MessageDetailWithAttempts,
} from './api-client';

describe('Messages Administration API Client & Masking Tests', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const MSG_ID = '01955b0a-7b3b-7411-9a4f-msg000000001';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-ch000000001';
  const WORKSPACE_ID = '01955b0a-7b3b-7411-9a4f-ws000000001';

  const mockSummary: MessageSummaryResponse = {
    id: MSG_ID,
    orgId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: CHANNEL_ID,
    channelCode: 'whatsapp',
    templateId: null,
    status: 'accepted',
    recipientAddress: '+12025550199',
    failureReason: null,
    attemptCount: 1,
    createdAt: '2026-10-21T12:00:00.000Z',
    completedAt: '2026-10-21T12:00:02.000Z',
  };

  const mockDetail: MessageDetailWithAttempts = {
    id: MSG_ID,
    orgId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: CHANNEL_ID,
    templateId: null,
    status: 'accepted',
    recipientAddress: '+12025550199',
    payload: { text: 'Hello from test suite!' },
    failureReason: null,
    createdAt: '2026-10-21T12:00:00.000Z',
    completedAt: '2026-10-21T12:00:02.000Z',
    attempts: [
      {
        id: '01955b0a-7b3b-7411-9a4f-att000000001',
        attemptNumber: 1,
        providerId: '01955b0a-7b3b-7411-9a4f-pr000000001',
        status: 'accepted',
        failureReason: null,
        latencyMs: 145,
        completedAt: '2026-10-21T12:00:02.000Z',
      },
    ],
  };

  beforeEach(() => {
    fetchCalls = [];
    mockHandlers = [];
    registerOrgValidator(() => true);
    setSelectedOrganization(ORG_ID);

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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSelectedOrganization(null);
    registerOrgValidator(null);
  });

  // ---------------------------------------------------------------------------
  // 1. messagesApi.list tests
  // ---------------------------------------------------------------------------
  it('1. messagesApi.list constructs query parameters, attaches X-Acc-Organization, and strictly omits recipient from query', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/messages'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: [mockSummary],
            page: { hasMore: false, nextCursor: null, limit: 25 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await messagesApi.list({
      status: 'accepted',
      channelCode: 'whatsapp',
      workspaceId: WORKSPACE_ID,
      createdFrom: '2026-10-20T00:00:00.000Z',
      createdTo: '2026-10-22T00:00:00.000Z',
      limit: 25,
      sort: '-createdAt',
    });

    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]?.id, MSG_ID);
    assert.equal(fetchCalls.length, 1);

    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'GET');
    assert.ok(call.url.includes('/messages'));
    assert.ok(call.url.includes('status=accepted'));
    assert.ok(call.url.includes('channelCode=whatsapp'));
    assert.ok(call.url.includes(`workspaceId=${WORKSPACE_ID}`));
    assert.ok(call.url.includes('createdFrom=2026-10-20T00%3A00%3A00.000Z'));
    assert.ok(call.url.includes('createdTo=2026-10-22T00%3A00%3A00.000Z'));
    assert.ok(call.url.includes('limit=25'));
    assert.ok(call.url.includes('sort=-createdAt'));

    // Privacy invariant: query strings must never contain recipient PII
    assert.ok(!call.url.includes('recipient'));
    assert.ok(!call.url.includes('recipientAddress'));
    assert.ok(!call.url.includes('+12025550199'));

    // Tenancy requirement: X-Acc-Organization header must be present
    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_ID);
  });

  // ---------------------------------------------------------------------------
  // 2. messagesApi.get tests
  // ---------------------------------------------------------------------------
  it('2. messagesApi.get fetches message details with attempt history and X-Acc-Organization', async () => {
    mockHandlers.push({
      match: (url) => url.includes(`/messages/${MSG_ID}`),
      handle: () =>
        new Response(JSON.stringify({ data: mockDetail }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await messagesApi.get(MSG_ID);
    assert.equal(res.data.id, MSG_ID);
    assert.equal(res.data.status, 'accepted');
    assert.equal(res.data.attempts.length, 1);
    assert.equal(res.data.attempts[0]?.latencyMs, 145);

    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'GET');
    assert.ok(call.url.endsWith(`/messages/${MSG_ID}`));
    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_ID);
  });

  // ---------------------------------------------------------------------------
  // 3. maskRecipientAddress tests
  // ---------------------------------------------------------------------------
  it('3. maskRecipientAddress correctly masks E.164 phone numbers and email addresses', () => {
    // US / North American phone (+1)
    const maskedUs = maskRecipientAddress('+12025550199');
    assert.equal(maskedUs, '+1 •••• 0199');

    // UK / International phone (+44)
    const maskedUk = maskRecipientAddress('+447911123456');
    assert.equal(maskedUk, '+44 •••• 3456');

    // Standard Email
    const maskedEmail = maskRecipientAddress('operator@alendei.com');
    assert.equal(maskedEmail, 'o••••r@alendei.com');

    // Short Email
    const maskedShort = maskRecipientAddress('ab@domain.com');
    assert.equal(maskedShort, 'a•••@domain.com');

    // Null, empty, or whitespace
    assert.equal(maskRecipientAddress(null), '');
    assert.equal(maskRecipientAddress(''), '');
    assert.equal(maskRecipientAddress('   '), '');
  });
});
