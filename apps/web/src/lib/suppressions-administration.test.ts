import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  channelsApi,
  suppressionsApi,
  setSelectedOrganization,
  registerOrgValidator,
  type SuppressionResponse,
} from './api-client';
import { humanizeApiError } from './error-mapping';

describe('Suppressions Administration API Client & Error Mapping', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const SUPPRESSION_ID = '01955b0a-7b3b-7411-9a4f-su0000000001';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-ch0000000001';

  const mockSuppression: SuppressionResponse = {
    id: SUPPRESSION_ID,
    orgId: ORG_ID,
    channelId: CHANNEL_ID,
    rawAddress: '+12025550199',
    normalizedAddress: '+12025550199',
    reason: 'Customer requested unsubscribe',
    status: 'active',
    clearedAt: null,
    clearedReason: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
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

  // --- API Client Methods ----------------------------------------------------

  it('1. suppressionsApi.list calls GET /suppressions with filters and attaches tenant header', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/suppressions'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: [mockSuppression],
            page: { hasMore: false, nextCursor: null, limit: 25 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await suppressionsApi.list({
      channelId: CHANNEL_ID,
      status: 'active',
      limit: 25,
      sort: '-createdAt',
    });

    assert.equal(res.data.length, 1);
    assert.equal(res.data[0]?.id, SUPPRESSION_ID);
    assert.equal(fetchCalls.length, 1);

    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'GET');
    assert.ok(call.url.includes('/suppressions'));
    assert.ok(call.url.includes(`channelId=${CHANNEL_ID}`));
    assert.ok(call.url.includes('status=active'));
    assert.ok(call.url.includes('limit=25'));
    assert.ok(call.url.includes('sort=-createdAt'));

    // Privacy constraint: recipient address must never be in query string
    assert.ok(!call.url.includes('rawAddress'));
    assert.ok(!call.url.includes('+12025550199'));

    // Tenant context requirement: X-Acc-Organization must be present
    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_ID);
  });

  it('2. suppressionsApi.get calls GET /suppressions/:id with tenant header', async () => {
    mockHandlers.push({
      match: (url) => url.includes(`/suppressions/${SUPPRESSION_ID}`),
      handle: () =>
        new Response(JSON.stringify({ data: mockSuppression }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await suppressionsApi.get(SUPPRESSION_ID);

    assert.equal(res.data.id, SUPPRESSION_ID);
    assert.equal(fetchCalls.length, 1);

    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'GET');
    assert.ok(call.url.endsWith(`/suppressions/${SUPPRESSION_ID}`));

    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_ID);
  });

  it('3. suppressionsApi.create calls POST /suppressions with payload and Idempotency-Key', async () => {
    const testIdempotencyKey = '01955b0a-7b3b-7411-9a4f-idempotent01';

    mockHandlers.push({
      match: (url, options) => url.includes('/suppressions') && options.method === 'POST',
      handle: () =>
        new Response(JSON.stringify({ data: mockSuppression }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await suppressionsApi.create(
      {
        channelId: CHANNEL_ID,
        rawAddress: '+12025550199',
        reason: 'Customer complaint',
      },
      testIdempotencyKey,
    );

    assert.equal(res.data.id, SUPPRESSION_ID);
    assert.equal(fetchCalls.length, 1);

    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'POST');
    assert.ok(call.url.endsWith('/suppressions'));

    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_ID);
    assert.equal(headers['Idempotency-Key'], testIdempotencyKey);

    const body = JSON.parse(call.options.body as string);
    assert.equal(body.channelId, CHANNEL_ID);
    assert.equal(body.rawAddress, '+12025550199');
    assert.equal(body.reason, 'Customer complaint');
  });

  it('4. suppressionsApi.lift calls POST /suppressions/:id/lift with reason', async () => {
    const clearedSuppression: SuppressionResponse = {
      ...mockSuppression,
      status: 'cleared',
      clearedAt: '2026-10-21T01:00:00.000Z',
      clearedReason: 'Customer opted back in',
    };

    mockHandlers.push({
      match: (url, options) =>
        url.includes(`/suppressions/${SUPPRESSION_ID}/lift`) && options.method === 'POST',
      handle: () =>
        new Response(JSON.stringify({ data: clearedSuppression }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const res = await suppressionsApi.lift(SUPPRESSION_ID, {
      reason: 'Customer opted back in',
    });

    assert.equal(res.data.status, 'cleared');
    assert.equal(res.data.clearedReason, 'Customer opted back in');
    assert.equal(fetchCalls.length, 1);

    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'POST');
    assert.ok(call.url.endsWith(`/suppressions/${SUPPRESSION_ID}/lift`));

    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_ID);

    const body = JSON.parse(call.options.body as string);
    assert.equal(body.reason, 'Customer opted back in');
  });

  // --- Error Mapping Verification --------------------------------------------

  it('5. humanizeApiError translates suppression conflict and normalization codes', () => {
    // SUPPRESSION_ALREADY_ACTIVE
    const errAlreadyActive = {
      name: 'ApiError',
      status: 409,
      code: 'SUPPRESSION_ALREADY_ACTIVE',
      message: 'An active suppression already exists for this address',
      correlationId: 'corr-supp-1',
    };
    const humanizedAlreadyActive = humanizeApiError(errAlreadyActive);
    assert.equal(humanizedAlreadyActive.title, 'Recipient Already Suppressed');
    assert.ok(humanizedAlreadyActive.message.includes('active suppression entry already exists'));
    assert.equal(humanizedAlreadyActive.code, 'SUPPRESSION_ALREADY_ACTIVE');
    assert.equal(humanizedAlreadyActive.correlationId, 'corr-supp-1');

    // SUPPRESSION_LIFECYCLE_CONFLICT
    const errLifecycle = {
      name: 'ApiError',
      status: 409,
      code: 'SUPPRESSION_LIFECYCLE_CONFLICT',
      message: 'This suppression is not active',
      correlationId: 'corr-supp-2',
    };
    const humanizedLifecycle = humanizeApiError(errLifecycle);
    assert.equal(humanizedLifecycle.title, 'Suppression Lifecycle Conflict');
    assert.ok(humanizedLifecycle.message.includes('not in an active state and cannot be lifted'));

    // PHONE_MISSING_COUNTRY_CODE
    const errPhoneCode = {
      name: 'ApiError',
      status: 400,
      code: 'PHONE_MISSING_COUNTRY_CODE',
      message: 'Phone number must start with a +',
    };
    const humanizedPhoneCode = humanizeApiError(errPhoneCode);
    assert.equal(humanizedPhoneCode.title, 'Missing Country Code');
    assert.ok(humanizedPhoneCode.message.includes('E.164 format'));

    // INVALID_PHONE_NUMBER
    const errPhoneNum = {
      name: 'ApiError',
      status: 400,
      code: 'INVALID_PHONE_NUMBER',
      message: 'Invalid phone digits',
    };
    const humanizedPhoneNum = humanizeApiError(errPhoneNum);
    assert.equal(humanizedPhoneNum.title, 'Invalid Phone Number');
    assert.ok(humanizedPhoneNum.message.includes('7-15 digits'));

    // INVALID_EMAIL_ADDRESS
    const errEmail = {
      name: 'ApiError',
      status: 400,
      code: 'INVALID_EMAIL_ADDRESS',
      message: 'Invalid email',
    };
    const humanizedEmail = humanizeApiError(errEmail);
    assert.equal(humanizedEmail.title, 'Invalid Email Address');
    assert.ok(humanizedEmail.message.includes('RFC 5322'));

    // IDEMPOTENCY_KEY_PAYLOAD_MISMATCH
    const errIdemMismatch = {
      name: 'ApiError',
      status: 422,
      code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
      message: 'Payload mismatch',
    };
    const humanizedIdemMismatch = humanizeApiError(errIdemMismatch);
    assert.equal(humanizedIdemMismatch.title, 'Idempotency Key Conflict');
    assert.ok(humanizedIdemMismatch.message.includes('different request parameters'));
  });

  // --- Tenant Channel Catalogue Option A -------------------------------------

  it('6. channelsApi.list with tenantScoped=true attaches X-Acc-Organization for tenant operator', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/channels'),
      handle: () =>
        new Response(
          JSON.stringify({
            data: [{ id: CHANNEL_ID, code: 'sms', displayName: 'SMS', status: 'active' }],
            page: { hasMore: false, nextCursor: null, limit: 50 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const res = await channelsApi.list({ limit: 50, tenantScoped: true });
    assert.equal(res.data.length, 1);
    assert.equal(fetchCalls.length, 1);

    const call = fetchCalls[0]!;
    assert.equal(call.options.method, 'GET');
    assert.ok(call.url.includes('/channels?limit=50'));

    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_ID);
  });
});
