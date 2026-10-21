import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  providerAssignmentsApi,
  getAccessToken,
  getSelectedOrganization,
  type EffectiveAuthorization,
  type UserIdentity,
} from './api-client';
import { canManageProviders, canReadProviders, useSession } from './session-store';

describe('SEC-PA: Provider Assignments Security Invariants & Boundary Enforcement', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';
  const ASSIGNMENT_ID = '01955b0a-7b3b-7411-9a4f-as0000000001';
  const PROVIDER_ID = '01955b0a-7b3b-7411-9a4f-pr0000000001';

  const setupSession = (grants: EffectiveAuthorization['grants'], isPlatformAdmin = false) => {
    const user: UserIdentity = {
      userId: 'test-admin-1',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: ORG_A, workspaceId: null, resellerId: null, isPlatformAdmin },
      authorizedOrganizationIds: [ORG_A, ORG_B],
      roles: [],
      permissions: [],
    };

    const authorization: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-admin-1',
      apiKeyId: null,
      organizationIds: [ORG_A, ORG_B],
      grants,
      isPlatformAdmin,
    };

    useSession.getState().setSession({
      accessToken: 'test-in-memory-token',
      user,
      authorization,
      selectedOrgId: ORG_A,
    });
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

  // --- SEC-PA-01: Platform Route Tenant Header Omission -----------------------

  it('SEC-PA-01: Provider assignment endpoints NEVER send X-Acc-Organization header', async () => {
    setupSession([
      {
        roleId: 'role-platform-admin',
        roleKey: 'platform_admin',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions: ['providers.read', 'providers.manage'],
      },
    ]);

    // Verify session has selected organization
    assert.equal(getSelectedOrganization(), ORG_A);

    await providerAssignmentsApi.list(ORG_A);
    await providerAssignmentsApi.get(ORG_A, ASSIGNMENT_ID);
    await providerAssignmentsApi.create(ORG_A, { providerId: PROVIDER_ID, priority: 1 });
    await providerAssignmentsApi.update(ORG_A, ASSIGNMENT_ID, { priority: 2 });
    await providerAssignmentsApi.enable(ORG_A, ASSIGNMENT_ID);
    await providerAssignmentsApi.disable(ORG_A, ASSIGNMENT_ID);

    assert.equal(fetchCalls.length, 6);
    for (const call of fetchCalls) {
      const headers = (call.options.headers ?? {}) as Record<string, string>;
      assert.equal(
        headers['X-Acc-Organization'],
        undefined,
        `Endpoint ${call.url} must NOT transmit X-Acc-Organization header`,
      );
    }
  });

  // --- SEC-PA-02: Platform Admin Flag Alone Does Not Confer Permissions --------

  it('SEC-PA-02: Platform admin flag alone does NOT confer providers.read or providers.manage', () => {
    // User is marked isPlatformAdmin: true, but holds NO grants
    setupSession([], true);

    assert.equal(
      canReadProviders(),
      false,
      'canReadProviders must be false without explicit platform grant',
    );
    assert.equal(
      canManageProviders(),
      false,
      'canManageProviders must be false without explicit platform grant',
    );
  });

  // --- SEC-PA-03: Tenant-Scoped Grants Do Not Confer Platform Catalogue --------

  it('SEC-PA-03: Organization-scoped grants do NOT confer platform provider permissions', () => {
    // User holds providers.read and providers.manage at organization scope
    setupSession([
      {
        roleId: 'role-org-admin',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: ORG_A,
        orgId: ORG_A,
        permissions: ['providers.read', 'providers.manage'],
      },
    ]);

    assert.equal(
      canReadProviders(),
      false,
      'Organization scope must not confer platform providers.read',
    );
    assert.equal(
      canManageProviders(),
      false,
      'Organization scope must not confer platform providers.manage',
    );
  });

  // --- SEC-PA-04: Explicit Platform Grant Grants Authority -------------------

  it('SEC-PA-04: Explicit platform scope grants confer canReadProviders and canManageProviders', () => {
    // Read-only platform operator
    setupSession([
      {
        roleId: 'role-plat-reader',
        roleKey: 'platform_reader',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions: ['providers.read'],
      },
    ]);

    assert.equal(canReadProviders(), true);
    assert.equal(canManageProviders(), false);

    // Full platform manager
    setupSession([
      {
        roleId: 'role-plat-mgr',
        roleKey: 'platform_manager',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions: ['providers.read', 'providers.manage'],
      },
    ]);

    assert.equal(canReadProviders(), true);
    assert.equal(canManageProviders(), true);
  });

  // --- SEC-PA-05: In-Memory Token Hygiene ------------------------------------

  it('SEC-PA-05: Access tokens are stored strictly in memory and cleared on logout', () => {
    setupSession([
      {
        roleId: 'role-1',
        roleKey: 'test',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions: ['providers.read'],
      },
    ]);

    assert.equal(getAccessToken(), 'test-in-memory-token');

    // Verify localStorage and sessionStorage were NOT touched
    if (typeof globalThis.localStorage !== 'undefined') {
      assert.equal(globalThis.localStorage.getItem('accessToken'), null);
      assert.equal(globalThis.localStorage.getItem('token'), null);
    }
    if (typeof globalThis.sessionStorage !== 'undefined') {
      assert.equal(globalThis.sessionStorage.getItem('accessToken'), null);
      assert.equal(globalThis.sessionStorage.getItem('token'), null);
    }

    useSession.getState().clearSession();
    assert.equal(getAccessToken(), null);
    assert.equal(getSelectedOrganization(), null);
  });
});
