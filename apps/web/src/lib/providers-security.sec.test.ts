import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { channelsApi, providersApi, providerCircuitPolicyApi, ApiError } from './api-client';
import {
  canManageProviders,
  canReadProviders,
  canTestSendProviders,
  useSession,
} from './session-store';
import { PERMISSIONS } from '@acc/contracts';

describe('Channels & Providers Security Invariants & Boundary Enforcement', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const PROVIDER_ID = '01955b0a-7b3b-7411-9a4f-pr0000000001';

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
    useSession.getState().clearSession();
  });

  it('SEC-1: Catalogue endpoints NEVER transmit X-Acc-Organization even when an org is selected', async () => {
    useSession.getState().setSession({
      accessToken: 'sec-token-1',
      user: {
        userId: 'admin-1',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-1',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: ORG_A, workspaceId: null, resellerId: null, isPlatformAdmin: true },
        authorizedOrganizationIds: [ORG_A],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'admin-1',
        apiKeyId: null,
        grants: [],
        organizationIds: [ORG_A],
        isPlatformAdmin: true,
      },
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: () => true,
      handle: () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await channelsApi.list();
    await providersApi.list();
    await providerCircuitPolicyApi.get();

    for (const call of fetchCalls) {
      const headers = call.options.headers as Record<string, string>;
      assert.equal(
        headers['X-Acc-Organization'],
        undefined,
        `Endpoint ${call.url} must NOT send X-Acc-Organization header`,
      );
    }
  });

  it('SEC-2: Tenant-scoped grants (org, workspace, team) do NOT confer platform catalogue permissions', () => {
    // User holds organizations.manage and even providers.manage but strictly at organization scope
    useSession.getState().setSession({
      accessToken: 'sec-token-2',
      user: {
        userId: 'org-admin-1',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-2',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: ORG_A, workspaceId: null, resellerId: null, isPlatformAdmin: false },
        authorizedOrganizationIds: [ORG_A],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'org-admin-1',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-org-1',
            roleKey: 'org_admin',
            scopeType: 'organization',
            scopeId: ORG_A,
            orgId: ORG_A,
            permissions: [PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_MANAGE],
          },
        ],
        organizationIds: [ORG_A],
        isPlatformAdmin: false,
      },
      selectedOrgId: ORG_A,
    });

    // Despite holding providers.read / providers.manage in the org grant, platform-level catalogue hooks must fail closed
    assert.equal(canReadProviders(), false);
    assert.equal(canManageProviders(), false);
    assert.equal(canTestSendProviders(), false);
  });

  it('SEC-3: Low-privilege platform grants isolate read, test-send, and management permissions', () => {
    // 1. Reader persona: platform grant with providers.read only
    useSession.getState().setSession({
      accessToken: 'reader-token',
      user: {
        userId: 'reader-1',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-reader',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
        authorizedOrganizationIds: [],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'reader-1',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-reader',
            roleKey: 'acc_fixture_providers_reader',
            scopeType: 'platform',
            scopeId: null,
            orgId: null,
            permissions: [PERMISSIONS.PROVIDERS_READ],
          },
        ],
        organizationIds: [],
        isPlatformAdmin: false,
      },
    });

    assert.equal(canReadProviders(), true);
    assert.equal(canManageProviders(), false);
    assert.equal(canTestSendProviders(), false);

    // 2. Tester persona: platform grant with providers.read + providers.test_send
    useSession.getState().setSession({
      accessToken: 'tester-token',
      user: {
        userId: 'tester-1',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-tester',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
        authorizedOrganizationIds: [],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'tester-1',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-tester',
            roleKey: 'acc_fixture_providers_tester',
            scopeType: 'platform',
            scopeId: null,
            orgId: null,
            permissions: [PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_TEST_SEND],
          },
        ],
        organizationIds: [],
        isPlatformAdmin: false,
      },
    });

    assert.equal(canReadProviders(), true);
    assert.equal(canManageProviders(), false);
    assert.equal(canTestSendProviders(), true);

    // 3. Denied persona (alendei_support): platform grant without providers.*
    useSession.getState().setSession({
      accessToken: 'support-token',
      user: {
        userId: 'support-1',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-support',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
        authorizedOrganizationIds: [],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'support-1',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-support',
            roleKey: 'alendei_support',
            scopeType: 'platform',
            scopeId: null,
            orgId: null,
            permissions: ['users.read', 'roles.read', 'audit.read'],
          },
        ],
        organizationIds: [],
        isPlatformAdmin: false,
      },
    });

    assert.equal(canReadProviders(), false);
    assert.equal(canManageProviders(), false);
    assert.equal(canTestSendProviders(), false);
  });

  it('SEC-4: 403 Forbidden is translated to non-retryable ApiError', async () => {
    mockHandlers.push({
      match: () => true,
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_SCOPE_DENIED',
              message: 'Forbidden',
              correlationId: 'corr-403',
              retryable: false,
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => providersApi.enable(PROVIDER_ID),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_SCOPE_DENIED');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  it('SEC-5: 409 PROVIDER_LIFECYCLE_CONFLICT preserves structured status detail', async () => {
    mockHandlers.push({
      match: () => true,
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'PROVIDER_LIFECYCLE_CONFLICT',
              message: 'This provider is disabled; the operation is not permitted in that state',
              correlationId: 'corr-409',
              retryable: false,
              details: { status: 'disabled' },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => providersApi.drain(PROVIDER_ID),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'PROVIDER_LIFECYCLE_CONFLICT');
        assert.equal(err.details?.status, 'disabled');
        return true;
      },
    );
  });

  it('SEC-6: 409 CIRCUIT_POLICY_VERSION_CONFLICT preserves currentVersion in structured details', async () => {
    mockHandlers.push({
      match: () => true,
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'CIRCUIT_POLICY_VERSION_CONFLICT',
              message: 'Policy version mismatch',
              correlationId: 'corr-conf',
              retryable: false,
              details: { expectedVersion: 2, currentVersion: 3 },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () =>
        providerCircuitPolicyApi.update({
          windowMs: 60000,
          windowMaxSamples: 20,
          minSamples: 5,
          failurePercent: 50,
          cooldownMs: 30000,
          halfOpenMaxProbes: 1,
          probeLeaseMs: 10000,
          halfOpenSuccessesToClose: 2,
          expectedVersion: 2,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.details?.currentVersion, 3);
        return true;
      },
    );
  });

  it('SEC-7: Clearing health override sends { override: null } explicitly', async () => {
    mockHandlers.push({
      match: (url, opts) => url.includes('/health') && opts.method === 'POST',
      handle: (_url, opts) => {
        const body = JSON.parse(opts.body as string);
        assert.equal(body.override, null);
        assert.ok('override' in body);
        return new Response(JSON.stringify({ data: { id: PROVIDER_ID, healthOverride: null } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await providersApi.overrideHealth(PROVIDER_ID, { override: null });
    const call = fetchCalls[0]!;
    const body = JSON.parse(call.options.body as string);
    assert.strictEqual(body.override, null);
  });

  it('SEC-8: isPlatformAdmin flag alone without platform-scoped grant does NOT confer provider permissions', () => {
    // Session has isPlatformAdmin = true, but NO platform grants
    useSession.getState().setSession({
      accessToken: 'platform-admin-nogrants-token',
      user: {
        userId: 'admin-nogrants',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-nogrants',
        authenticatedAt: new Date().toISOString(),
        tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
        authorizedOrganizationIds: [],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'admin-nogrants',
        apiKeyId: null,
        grants: [], // ZERO platform grants
        organizationIds: [],
        isPlatformAdmin: true,
      },
    });

    // Rule 1: A permission is valid for D.6 only when the authorization grant has scopeType === 'platform'.
    // Do NOT use isPlatformAdmin as a substitute for permission checking.
    assert.equal(canReadProviders(), false);
    assert.equal(canManageProviders(), false);
    assert.equal(canTestSendProviders(), false);
  });

  it('SEC-9: 409 PROVIDER_CIRCUIT_OPEN preserves retryAfterMs and circuitState in details', async () => {
    mockHandlers.push({
      match: () => true,
      handle: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'PROVIDER_CIRCUIT_OPEN',
              message: "This provider's circuit is open; the submission was not sent",
              correlationId: 'corr-open',
              retryable: false,
              details: { circuitState: 'open', retryAfterMs: 30000 },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await assert.rejects(
      async () => providersApi.testSend(PROVIDER_ID, { behavior: 'SUCCESS' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'PROVIDER_CIRCUIT_OPEN');
        assert.equal(err.details?.circuitState, 'open');
        assert.equal(err.details?.retryAfterMs, 30000);
        return true;
      },
    );
  });
});
