import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { providerAssignmentsApi, type OrganizationProviderAssignment } from './api-client';
import { humanizeApiError } from './error-mapping';

describe('Organization Provider Assignments Administration API Client & Error Mapping', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ASSIGNMENT_ID = '01955b0a-7b3b-7411-9a4f-as0000000001';
  const PROVIDER_ID = '01955b0a-7b3b-7411-9a4f-pr0000000001';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-ch0000000001';

  const mockAssignment: OrganizationProviderAssignment = {
    id: ASSIGNMENT_ID,
    orgId: ORG_ID,
    providerId: PROVIDER_ID,
    channelId: CHANNEL_ID,
    priority: 1,
    status: 'active',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
  };

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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- API Client Methods ----------------------------------------------------

  it('1. providerAssignmentsApi.list calls GET /organizations/:orgId/provider-assignments with query params', async () => {
    mockHandlers.push({
      match: (url) => url.includes(`/organizations/${ORG_ID}/provider-assignments`),
      handle: () =>
        new Response(
          JSON.stringify({
            data: [mockAssignment],
            page: { hasMore: false, nextCursor: null },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await providerAssignmentsApi.list(ORG_ID, {
      channelId: CHANNEL_ID,
      status: 'active',
      limit: 25,
      sort: 'priority:asc',
    });

    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]?.id, ASSIGNMENT_ID);
    assert.equal(fetchCalls.length, 1);

    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'GET');
    assert.ok(call.url.includes(`/organizations/${ORG_ID}/provider-assignments`));
    assert.ok(call.url.includes(`channelId=${CHANNEL_ID}`));
    assert.ok(call.url.includes('status=active'));
    assert.ok(call.url.includes('limit=25'));
    assert.ok(call.url.includes('sort=priority%3Aasc'));
  });

  it('2. providerAssignmentsApi.get calls GET /organizations/:orgId/provider-assignments/:id', async () => {
    mockHandlers.push({
      match: (url) =>
        url.includes(`/organizations/${ORG_ID}/provider-assignments/${ASSIGNMENT_ID}`),
      handle: () =>
        new Response(JSON.stringify({ data: mockAssignment }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await providerAssignmentsApi.get(ORG_ID, ASSIGNMENT_ID);
    assert.equal(res.data.id, ASSIGNMENT_ID);
    assert.equal(res.data.priority, 1);

    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'GET');
    assert.ok(call.url.includes(`/organizations/${ORG_ID}/provider-assignments/${ASSIGNMENT_ID}`));
  });

  it('3. providerAssignmentsApi.create sends POST with payload and skipTenant', async () => {
    mockHandlers.push({
      match: (url, opts) =>
        url.includes(`/organizations/${ORG_ID}/provider-assignments`) && opts.method === 'POST',
      handle: () =>
        new Response(JSON.stringify({ data: mockAssignment }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await providerAssignmentsApi.create(ORG_ID, {
      providerId: PROVIDER_ID,
      priority: 2,
      status: 'active',
    });

    assert.equal(res.data.id, ASSIGNMENT_ID);
    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'POST');
    assert.equal(
      call.options.body,
      JSON.stringify({ providerId: PROVIDER_ID, priority: 2, status: 'active' }),
    );
  });

  it('4. providerAssignmentsApi.update sends PATCH with updated priority', async () => {
    const updatedMock = { ...mockAssignment, priority: 3 };
    mockHandlers.push({
      match: (url, opts) =>
        url.includes(`/organizations/${ORG_ID}/provider-assignments/${ASSIGNMENT_ID}`) &&
        opts.method === 'PATCH',
      handle: () =>
        new Response(JSON.stringify({ data: updatedMock }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await providerAssignmentsApi.update(ORG_ID, ASSIGNMENT_ID, { priority: 3 });
    assert.equal(res.data.priority, 3);
    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'PATCH');
    assert.equal(call.options.body, JSON.stringify({ priority: 3 }));
  });

  it('5. providerAssignmentsApi.enable calls POST :id/enable', async () => {
    mockHandlers.push({
      match: (url, opts) =>
        url.includes(`/organizations/${ORG_ID}/provider-assignments/${ASSIGNMENT_ID}/enable`) &&
        opts.method === 'POST',
      handle: () =>
        new Response(JSON.stringify({ data: { ...mockAssignment, status: 'active' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await providerAssignmentsApi.enable(ORG_ID, ASSIGNMENT_ID);
    assert.equal(res.data.status, 'active');
    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'POST');
    assert.ok(call.url.endsWith(`/provider-assignments/${ASSIGNMENT_ID}/enable`));
  });

  it('6. providerAssignmentsApi.disable calls POST :id/disable', async () => {
    mockHandlers.push({
      match: (url, opts) =>
        url.includes(`/organizations/${ORG_ID}/provider-assignments/${ASSIGNMENT_ID}/disable`) &&
        opts.method === 'POST',
      handle: () =>
        new Response(JSON.stringify({ data: { ...mockAssignment, status: 'disabled' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await providerAssignmentsApi.disable(ORG_ID, ASSIGNMENT_ID);
    assert.equal(res.data.status, 'disabled');
    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'POST');
    assert.ok(call.url.endsWith(`/provider-assignments/${ASSIGNMENT_ID}/disable`));
  });

  // --- Human-Readable Error Mapping Tests -------------------------------------

  it('7. humanizeApiError translates ASSIGNMENT_PRIORITY_CONFLICT correctly', () => {
    const error = {
      status: 409,
      code: 'ASSIGNMENT_PRIORITY_CONFLICT',
      message: 'Priority 1 is already in use for channel in organization',
      correlationId: 'req-corr-123',
    };

    const humanized = humanizeApiError(error);
    assert.equal(humanized.title, 'Priority Conflict');
    assert.ok(humanized.message.includes('Another provider assignment already uses this priority'));
    assert.equal(humanized.code, 'ASSIGNMENT_PRIORITY_CONFLICT');
    assert.equal(humanized.correlationId, 'req-corr-123');
  });

  it('8. humanizeApiError translates PROVIDER_ASSIGNMENT_CONFLICT correctly', () => {
    const error = {
      status: 409,
      code: 'PROVIDER_ASSIGNMENT_CONFLICT',
      message: 'Provider is already assigned to organization',
      correlationId: 'req-corr-456',
    };

    const humanized = humanizeApiError(error);
    assert.equal(humanized.title, 'Provider Already Assigned');
    assert.ok(humanized.message.includes('already assigned to this organization'));
    assert.equal(humanized.code, 'PROVIDER_ASSIGNMENT_CONFLICT');
    assert.equal(humanized.correlationId, 'req-corr-456');
  });

  it('9. humanizeApiError translates AUTHZ_SCOPE_DENIED correctly without implying only platform', () => {
    const error = {
      status: 403,
      code: 'AUTHZ_SCOPE_DENIED',
      message: 'Access denied at this scope',
    };

    const humanized = humanizeApiError(error);
    assert.equal(humanized.title, 'Scope Denied');
    assert.ok(humanized.message.includes('requested scope level'));
    assert.ok(!humanized.message.includes('requires platform-level'));
  });

  it('10. humanizeApiError translates tenancy lifecycle codes correctly', () => {
    const suspended = humanizeApiError({ code: 'TENANCY_ORGANIZATION_SUSPENDED' });
    assert.equal(suspended.title, 'Organization Suspended');
    assert.ok(suspended.message.includes('suspended'));

    const closed = humanizeApiError({ code: 'TENANCY_ORGANIZATION_CLOSED' });
    assert.equal(closed.title, 'Organization Closed');
    assert.ok(closed.message.includes('permanently closed'));

    const conflict = humanizeApiError({ code: 'ORGANIZATION_LIFECYCLE_CONFLICT' });
    assert.equal(conflict.title, 'Organization Lifecycle Conflict');
    assert.ok(conflict.message.includes('active state'));

    const contextReq = humanizeApiError({ code: 'TENANCY_CONTEXT_REQUIRED' });
    assert.equal(contextReq.title, 'Organization Context Required');

    const contextMismatch = humanizeApiError({ code: 'TENANCY_CONTEXT_MISMATCH' });
    assert.equal(contextMismatch.title, 'Organization Context Mismatch');
  });

  it('11. humanizeApiError translates suppression, idempotency, pagination, and not found codes', () => {
    const suppConflict = humanizeApiError({ code: 'SUPPRESSION_LIFECYCLE_CONFLICT' });
    assert.equal(suppConflict.title, 'Suppression Lifecycle Conflict');

    const suppActive = humanizeApiError({ code: 'SUPPRESSION_ALREADY_ACTIVE' });
    assert.equal(suppActive.title, 'Recipient Already Suppressed');

    const idempConflict = humanizeApiError({ code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' });
    assert.equal(idempConflict.title, 'Idempotency Key Conflict');

    const idempInProgress = humanizeApiError({ code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
    assert.equal(idempInProgress.title, 'Request In Progress');

    const idempInvalid = humanizeApiError({ code: 'IDEMPOTENCY_KEY_INVALID' });
    assert.equal(idempInvalid.title, 'Invalid Idempotency Key');

    const cursorInvalid = humanizeApiError({ code: 'PAGINATION_CURSOR_INVALID' });
    assert.equal(cursorInvalid.title, 'Invalid Pagination Cursor');

    const notFound = humanizeApiError({ code: 'RESOURCE_NOT_FOUND' });
    assert.equal(notFound.title, 'Resource Not Found');
  });

  it('12. humanizeApiError handles unknown errors and preserves fallback message', () => {
    const error = new Error('Network timeout during dispatch');
    const humanized = humanizeApiError(error, 'Custom fallback title');
    assert.equal(humanized.title, 'Custom fallback title');
    assert.equal(humanized.message, 'Network timeout during dispatch');
  });
});
