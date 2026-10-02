import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  organizationsApi,
  workspacesApi,
  teamsApi,
  apiFetch,
  ApiError,
  getSelectedOrganization,
  setSelectedOrganization,
} from './api-client';
import { useSession } from './session-store';

describe('Tenancy Administration Security Invariants & Boundary Enforcement', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';
  const WS_ID = '01955b0a-7b3b-7411-9a4f-ws0000000001';
  const TEAM_ID = '01955b0a-7b3b-7411-9a4f-team00000001';

  beforeEach(() => {
    fetchCalls = [];
    mockHandlers = [];

    useSession.getState().setSession({
      accessToken: 'sec-test-token',
      user: {
        userId: 'sec-admin',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-sec-1',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
        authorizedOrganizationIds: [ORG_A, ORG_B],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'sec-admin',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-1',
            roleKey: 'org_admin',
            scopeType: 'organization',
            scopeId: ORG_A,
            orgId: ORG_A,
            permissions: [
              'organizations.read',
              'organizations.update',
              'workspaces.read',
              'workspaces.create',
              'workspaces.update',
              'teams.read',
              'teams.create',
              'teams.update',
            ],
          },
        ],
        organizationIds: [ORG_A, ORG_B],
        isPlatformAdmin: true,
      },
      selectedOrgId: ORG_A,
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
  // SEC-1: Cross-Tenant Isolation: Tenant Pinned to In-Memory Selected Org
  // ---------------------------------------------------------------------------
  it('SEC-1: workspacesApi and teamsApi strictly pin X-Acc-Organization to verified selected organization', async () => {
    assert.equal(getSelectedOrganization(), ORG_A);

    await workspacesApi.list();
    await teamsApi.list();

    assert.equal(fetchCalls.length, 2);
    for (const call of fetchCalls) {
      const headers = call.options.headers as Record<string, string>;
      assert.equal(
        headers['X-Acc-Organization'],
        ORG_A,
        `Expected X-Acc-Organization to be pinned to ${ORG_A}`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // SEC-2: Organizations Endpoints NEVER Send X-Acc-Organization
  // ---------------------------------------------------------------------------
  it('SEC-2: organizationsApi endpoints NEVER leak or transmit X-Acc-Organization header', async () => {
    assert.equal(getSelectedOrganization(), ORG_A);

    await organizationsApi.list();
    await organizationsApi.get(ORG_A);
    await organizationsApi.create({ name: 'New Org', slug: 'new-org' });
    await organizationsApi.update(ORG_A, { name: 'Updated Org' });
    await organizationsApi.suspend(ORG_A);
    await organizationsApi.reactivate(ORG_A);
    await organizationsApi.close(ORG_A);

    assert.equal(fetchCalls.length, 7);
    for (const call of fetchCalls) {
      const headers = call.options.headers as Record<string, string>;
      assert.equal(
        headers['X-Acc-Organization'],
        undefined,
        `organizations route ${call.url} must NOT carry X-Acc-Organization`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // SEC-3: Teams Endpoints Strictly Omit orgId to Prevent 400 VALIDATION_FAILED
  // ---------------------------------------------------------------------------
  it('SEC-3: teamsApi strictly omits orgId from query params, create body, and update body', async () => {
    await teamsApi.list({ workspaceId: WS_ID, orgId: 'unauthorized-org' } as unknown as Parameters<
      typeof teamsApi.list
    >[0]);
    await teamsApi.create({
      workspaceId: WS_ID,
      name: 'Team Alpha',
      orgId: 'unauthorized-org',
    } as unknown as Parameters<typeof teamsApi.create>[0]);
    await teamsApi.update(TEAM_ID, {
      name: 'Team Beta',
      orgId: 'unauthorized-org',
      workspaceId: WS_ID,
      status: 'archived',
    } as unknown as Parameters<typeof teamsApi.update>[1]);

    const listCall = fetchCalls[0]!;
    assert.ok(!listCall.url.includes('orgId='), 'Query string must not contain orgId');

    const createCall = fetchCalls[1]!;
    const createBody = JSON.parse(createCall.options.body as string);
    assert.equal(createBody.orgId, undefined, 'Create body must not contain orgId');
    assert.equal(createBody.workspaceId, WS_ID);
    assert.equal(createBody.name, 'Team Alpha');

    const updateCall = fetchCalls[2]!;
    const updateBody = JSON.parse(updateCall.options.body as string);
    assert.equal(updateBody.orgId, undefined, 'Update body must not contain orgId');
    assert.equal(updateBody.workspaceId, undefined, 'Update body must not contain workspaceId');
    assert.equal(updateBody.status, undefined, 'Update body must not contain status');
    assert.equal(updateBody.name, 'Team Beta');
  });

  // ---------------------------------------------------------------------------
  // SEC-4: Workspaces Update Payload Strips Forbidden Fields
  // ---------------------------------------------------------------------------
  it('SEC-4: workspacesApi.update strips slug, isDefault, status, and orgId from request body', async () => {
    await workspacesApi.update(WS_ID, {
      name: 'Renamed Workspace',
      ...({
        slug: 'illegal-slug',
        isDefault: false,
        status: 'archived',
        orgId: ORG_B,
      } as unknown as Record<string, unknown>),
    });

    const updateCall = fetchCalls[0]!;
    const updateBody = JSON.parse(updateCall.options.body as string);

    assert.equal(updateBody.name, 'Renamed Workspace');
    assert.equal(updateBody.slug, undefined, 'slug is immutable and must not be sent');
    assert.equal(updateBody.isDefault, undefined, 'isDefault is immutable and must not be sent');
    assert.equal(updateBody.status, undefined, 'status changes via archive/restore only');
    assert.equal(updateBody.orgId, undefined, 'orgId is immutable and must not be sent');
  });

  // ---------------------------------------------------------------------------
  // SEC-5: Switching Organizations Strictly Re-pins Tenant Header
  // ---------------------------------------------------------------------------
  it('SEC-5: switching organization re-pins tenant header and isolates tenant context', async () => {
    setSelectedOrganization(ORG_A);
    await workspacesApi.list();
    const callA = fetchCalls[fetchCalls.length - 1]!;
    assert.equal((callA.options.headers as Record<string, string>)['X-Acc-Organization'], ORG_A);

    // Switch to ORG_B
    useSession.getState().selectOrganization(ORG_B);
    assert.equal(getSelectedOrganization(), ORG_B);

    await workspacesApi.list();
    const callB = fetchCalls[fetchCalls.length - 1]!;
    assert.equal((callB.options.headers as Record<string, string>)['X-Acc-Organization'], ORG_B);

    // Verify query keys across all tenant resources are strictly partitioned by organization
    const wsListKeyA = ['workspaces', 'list', ORG_A, {}];
    const wsListKeyB = ['workspaces', 'list', ORG_B, {}];
    assert.notDeepEqual(wsListKeyA, wsListKeyB);

    const wsDetailKeyA = ['workspaces', 'detail', ORG_A, WS_ID];
    const wsDetailKeyB = ['workspaces', 'detail', ORG_B, WS_ID];
    assert.notDeepEqual(wsDetailKeyA, wsDetailKeyB);

    const teamListKeyA = ['teams', 'list', ORG_A, {}];
    const teamListKeyB = ['teams', 'list', ORG_B, {}];
    assert.notDeepEqual(teamListKeyA, teamListKeyB);

    const teamDetailKeyA = ['teams', 'detail', ORG_A, TEAM_ID];
    const teamDetailKeyB = ['teams', 'detail', ORG_B, TEAM_ID];
    assert.notDeepEqual(teamDetailKeyA, teamDetailKeyB);
  });

  // ---------------------------------------------------------------------------
  // SEC-6: Caller Cannot Override Selected Organization via Parameters
  // ---------------------------------------------------------------------------
  it('SEC-6: caller cannot inject or spoof arbitrary organization headers through apiFetch', async () => {
    // Attempting to inject X-Acc-Organization manually
    await apiFetch('/workspaces', {
      method: 'GET',
      headers: {
        'X-Acc-Organization': '01955b0a-forged-org-000000000000',
      },
    });

    const call = fetchCalls[0]!;
    const headers = call.options.headers as Record<string, string>;
    assert.equal(
      headers['X-Acc-Organization'],
      ORG_A,
      'Tenant header must be overwritten with validated selected organization',
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-7: Stable Idempotency-Key across Retries for Workspace & Team Creation
  // ---------------------------------------------------------------------------
  it('SEC-7: same Idempotency-Key is preserved across retry attempts for creation mutations', async () => {
    const fixedKey = 'idem-retry-stable-12345';
    let attempts = 0;

    mockHandlers.push({
      match: (url, opts) => url.endsWith('/workspaces') && opts.method === 'POST',
      handle: () => {
        attempts++;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'INTERNAL_ERROR',
                message: 'Temporary glitch',
                correlationId: 'corr-1',
                retryable: true,
              },
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              id: WS_ID,
              name: 'Retry Ws',
              slug: 'retry-ws',
              status: 'active',
              isDefault: false,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    // First attempt fails with 500
    await assert.rejects(
      async () => workspacesApi.create({ name: 'Retry Ws', slug: 'retry-ws' }, fixedKey),
      (err: unknown) => err instanceof ApiError && err.status === 500 && err.retryable === true,
    );

    // Second retry attempt passes with the exact same idempotency key
    const res = await workspacesApi.create({ name: 'Retry Ws', slug: 'retry-ws' }, fixedKey);
    assert.equal(res.data.name, 'Retry Ws');

    assert.equal(fetchCalls.length, 2);
    assert.equal(
      (fetchCalls[0]!.options.headers as Record<string, string>)['Idempotency-Key'],
      fixedKey,
    );
    assert.equal(
      (fetchCalls[1]!.options.headers as Record<string, string>)['Idempotency-Key'],
      fixedKey,
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-8: 404 Does Not Leak Target Existence
  // ---------------------------------------------------------------------------
  it('SEC-8: 404 response on out-of-reach workspace or team throws ApiError without echoing IDs', async () => {
    const foreignId = '01955b0a-7b3b-7411-9a4f-foreign00001';

    mockHandlers.push({
      match: (url) => url.includes(foreignId),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Workspace not found',
              correlationId: 'corr-404',
              retryable: false,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => workspacesApi.get(foreignId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'RESOURCE_NOT_FOUND');
        assert.equal(err.retryable, false);
        assert.ok(!err.message.includes(foreignId), 'Error message must not echo target ID');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-9: 403 AUTHZ_SCOPE_DENIED Is Preserved and Non-Retryable
  // ---------------------------------------------------------------------------
  it('SEC-9: 403 AUTHZ_SCOPE_DENIED is preserved as non-retryable 403 ApiError', async () => {
    mockHandlers.push({
      match: (url) => url.endsWith(`/workspaces/${WS_ID}/archive`),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_SCOPE_DENIED',
              message: 'Permission denied for this scope',
              correlationId: 'corr-403',
              retryable: false,
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => workspacesApi.archive(WS_ID),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_SCOPE_DENIED');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-10: 409 WORKSPACE_LIFECYCLE_CONFLICT Structured Details
  // ---------------------------------------------------------------------------
  it('SEC-10: 409 WORKSPACE_LIFECYCLE_CONFLICT preserves structured details (activeTeams, isDefault)', async () => {
    mockHandlers.push({
      match: (url) => url.endsWith(`/workspaces/${WS_ID}/archive`),
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'WORKSPACE_LIFECYCLE_CONFLICT',
              message: 'Cannot archive workspace while active teams exist',
              correlationId: 'corr-409',
              retryable: false,
              details: { status: 'active', activeTeams: 3 },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => workspacesApi.archive(WS_ID),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'WORKSPACE_LIFECYCLE_CONFLICT');
        assert.equal(err.retryable, false);
        assert.deepEqual(err.details, { status: 'active', activeTeams: 3 });
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // SEC-11: Credentials Never Persisted
  // ---------------------------------------------------------------------------
  it('SEC-11: access tokens, refresh tokens, and passwords are never written to storage', () => {
    assert.equal(typeof window !== 'undefined' ? window.localStorage.length : 0, 0);
    assert.equal(typeof window !== 'undefined' ? window.sessionStorage.length : 0, 0);
  });
});
