import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiFetch,
  authApi,
  getAccessToken,
  getSelectedOrganization,
  type EffectiveAuthorization,
  type UserIdentity,
} from './api-client';
import { getActiveOrganizationGrants, useSession } from './session-store';

function createMockUser(authorizedOrganizationIds: string[] = [], orgIdInTenant: string | null = null): UserIdentity {
  return {
    userId: 'user-uuid-1',
    actorType: 'user',
    authMethod: 'session',
    sessionId: 'session-uuid-1',
    authenticatedAt: new Date().toISOString(),
    tenant: {
      // Per contract, tenant.orgId from /auth/me is NULL for identity routes
      orgId: orgIdInTenant,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
    },
    authorizedOrganizationIds,
    roles: [],
    permissions: ['workspaces.read'],
  };
}

function createMockAuthorization(organizationIds: string[] = []): EffectiveAuthorization {
  return {
    actorType: 'user',
    userId: 'user-uuid-1',
    apiKeyId: null,
    grants: [
      {
        roleId: 'role-org-1',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: 'org-allowed-1',
        orgId: 'org-allowed-1',
        permissions: ['roles.read', 'roles.create'],
      },
      {
        roleId: 'role-org-2',
        roleKey: 'campaign_editor',
        scopeType: 'organization',
        scopeId: 'org-allowed-2',
        orgId: 'org-allowed-2',
        permissions: ['workspaces.read'],
      },
      {
        roleId: 'role-platform',
        roleKey: 'alendei_support',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions: ['platform.audit.read'],
      },
    ],
    organizationIds,
    isPlatformAdmin: false,
  };
}

describe('Session Store & Organization Context', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useSession.getState().clearSession();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useSession.getState().clearSession();
  });

  // ---------------------------------------------------------------------------
  // 10. Sole Authorized Organization is Selected Automatically
  // ---------------------------------------------------------------------------
  it('10. sole authorized organization is selected automatically upon session establishment', () => {
    const user = createMockUser(['01955b0a-sole-org-1']);
    const auth = createMockAuthorization(['01955b0a-sole-org-1']);

    useSession.getState().setSession({
      accessToken: 'token-abc',
      user,
      authorization: auth,
    });

    const state = useSession.getState();
    assert.equal(state.status, 'ready');
    assert.equal(state.selectedOrganizationId, '01955b0a-sole-org-1');
    assert.equal(getSelectedOrganization(), '01955b0a-sole-org-1');
    assert.equal(getAccessToken(), 'token-abc');
  });

  // ---------------------------------------------------------------------------
  // 11. Multiple Organizations Require Explicit Selection
  // ---------------------------------------------------------------------------
  it('11. multiple authorized organizations transition to selecting_organization without auto-selecting', () => {
    const user = createMockUser(['org-1', 'org-2', 'org-3']);
    const auth = createMockAuthorization(['org-1', 'org-2', 'org-3']);

    useSession.getState().setSession({
      accessToken: 'token-multi',
      user,
      authorization: auth,
    });

    const state = useSession.getState();
    assert.equal(state.status, 'selecting_organization');
    assert.equal(state.selectedOrganizationId, null);
    assert.equal(getSelectedOrganization(), null);

    // After explicit valid selection:
    state.selectOrganization('org-2');
    const updatedState = useSession.getState();
    assert.equal(updatedState.status, 'ready');
    assert.equal(updatedState.selectedOrganizationId, 'org-2');
    assert.equal(getSelectedOrganization(), 'org-2');
  });

  // ---------------------------------------------------------------------------
  // 12. Zero Organizations Handled Explicitly
  // ---------------------------------------------------------------------------
  it('12. zero authorized organizations transitions to zero_organizations empty state', () => {
    const user = createMockUser([]);
    const auth = createMockAuthorization([]);

    useSession.getState().setSession({
      accessToken: 'token-zero',
      user,
      authorization: auth,
    });

    const state = useSession.getState();
    assert.equal(state.status, 'zero_organizations');
    assert.equal(state.selectedOrganizationId, null);
    assert.equal(getSelectedOrganization(), null);
  });

  // ---------------------------------------------------------------------------
  // 9. Selected Organization Cannot Be Arbitrary
  // ---------------------------------------------------------------------------
  it('9. selected organization cannot be arbitrary and throws when attempting unauthorized selection', () => {
    const user = createMockUser(['org-allowed-1', 'org-allowed-2']);
    const auth = createMockAuthorization(['org-allowed-1', 'org-allowed-2']);

    useSession.getState().setSession({
      accessToken: 'token-strict',
      user,
      authorization: auth,
    });

    assert.throws(
      () => {
        useSession.getState().selectOrganization('org-forged-or-unauthorized');
      },
      /Cannot select unauthorized organization/,
    );

    const state = useSession.getState();
    assert.equal(state.selectedOrganizationId, null);
    assert.equal(getSelectedOrganization(), null);
    assert.equal(state.status, 'selecting_organization');
  });

  // ---------------------------------------------------------------------------
  // 13. Invalid / Stale Selected Organization is Cleared
  // ---------------------------------------------------------------------------
  it('13. stale selected organization is cleared if subsequent session does not include it', () => {
    const user1 = createMockUser(['org-alpha', 'org-beta']);
    useSession.getState().setSession({
      accessToken: 'token-1',
      user: user1,
      authorization: createMockAuthorization(['org-alpha', 'org-beta']),
      selectedOrgId: 'org-alpha',
    });
    assert.equal(useSession.getState().selectedOrganizationId, 'org-alpha');

    // Re-establishing session where org-alpha is no longer in authorizedOrganizationIds
    const user2 = createMockUser(['org-beta', 'org-gamma']);
    useSession.getState().setSession({
      accessToken: 'token-2',
      user: user2,
      authorization: createMockAuthorization(['org-beta', 'org-gamma']),
      selectedOrgId: 'org-alpha', // stale!
    });

    const state = useSession.getState();
    assert.equal(state.selectedOrganizationId, null, 'stale org was cleared');
    assert.equal(state.status, 'selecting_organization');
    assert.equal(getSelectedOrganization(), null);
  });

  // ---------------------------------------------------------------------------
  // 7. Stale Organization Selection is Rejected Before Tenant Request
  // ---------------------------------------------------------------------------
  it('7. stale organization selection is cleared and rejected before tenant request is sent', async () => {
    const user = createMockUser(['org-allowed-1']);
    useSession.getState().setSession({
      accessToken: 'token-stale-check',
      user,
      authorization: createMockAuthorization(['org-allowed-1']),
    });

    assert.equal(getSelectedOrganization(), 'org-allowed-1');

    // Simulate privilege reduction where org-allowed-1 is revoked
    useSession.setState({ authorizedOrganizationIds: ['org-allowed-2'] });

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = async (_input, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    // Attempting a tenant-scoped request detects stale org and strips it
    await apiFetch('/tenants/workspaces');

    assert.equal(
      capturedHeaders['X-Acc-Organization'],
      undefined,
      'stale organization was not sent on tenant request',
    );
    assert.equal(getSelectedOrganization(), null);
  });

  // ---------------------------------------------------------------------------
  // 15. Identity Request Does NOT Derive Organization from tenant.orgId
  // ---------------------------------------------------------------------------
  it('15. identity route tenant.orgId is null and frontend derives active org only from authorizedOrganizationIds', () => {
    // /auth/me returns tenant.orgId: null
    const user = createMockUser(['org-from-authorized-ids'], null);
    assert.equal(user.tenant.orgId, null, 'tenant.orgId is null on identity routes');

    useSession.getState().setSession({
      accessToken: 'token-identity',
      user,
      authorization: createMockAuthorization(['org-from-authorized-ids']),
    });

    const state = useSession.getState();
    // Proves active organization is derived from authorizedOrganizationIds, NOT tenant.orgId
    assert.equal(state.selectedOrganizationId, 'org-from-authorized-ids');
    assert.equal(getSelectedOrganization(), 'org-from-authorized-ids');
  });

  // ---------------------------------------------------------------------------
  // 5 & 10. Failed Refresh and Logout Clear All Authenticated & Authorization State
  // ---------------------------------------------------------------------------
  it('5 & 10. logout and failed refresh clear user, token, selected org, and authorization state', async () => {
    const user = createMockUser(['org-allowed-1']);
    const auth = createMockAuthorization(['org-allowed-1']);

    useSession.getState().setSession({
      accessToken: 'token-to-clear',
      user,
      authorization: auth,
    });

    assert.ok(useSession.getState().authorization !== null);
    assert.ok(getActiveOrganizationGrants().length > 0);

    // Perform logout
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await authApi.logout();

    const stateAfterLogout = useSession.getState();
    assert.equal(stateAfterLogout.status, 'unauthenticated');
    assert.equal(stateAfterLogout.accessToken, null);
    assert.equal(stateAfterLogout.user, null);
    assert.equal(stateAfterLogout.authorization, null, 'authorization state must be null');
    assert.equal(stateAfterLogout.selectedOrganizationId, null);
    assert.deepEqual(getActiveOrganizationGrants(), [], 'grants must be empty after logout');
  });

  // ---------------------------------------------------------------------------
  // Active Organization Grants Filtering
  // ---------------------------------------------------------------------------
  it('getActiveOrganizationGrants filters grants strictly to the active organization plus platform grants', () => {
    const user = createMockUser(['org-allowed-1', 'org-allowed-2']);
    const auth = createMockAuthorization(['org-allowed-1', 'org-allowed-2']);

    useSession.getState().setSession({
      accessToken: 'token-filter',
      user,
      authorization: auth,
      selectedOrgId: 'org-allowed-1',
    });

    const activeGrants = getActiveOrganizationGrants();
    // Should include role-org-1 and role-platform, but NOT role-org-2
    const grantKeys = activeGrants.map((g) => g.roleKey);
    assert.ok(grantKeys.includes('org_admin'), 'includes active org grant');
    assert.ok(grantKeys.includes('alendei_support'), 'includes platform grant');
    assert.ok(!grantKeys.includes('campaign_editor'), 'must NOT leak grant from other org');
  });

  // ---------------------------------------------------------------------------
  // Mutation Test: Unauthorized organization selection fails
  // ---------------------------------------------------------------------------
  it('mutation: choosing an unauthorized organization ID is rejected by the selection gate', () => {
    const user = createMockUser(['org-100']);
    useSession.getState().setSession({
      accessToken: 'token-m',
      user,
      authorization: createMockAuthorization(['org-100']),
    });

    assert.throws(() => {
      useSession.getState().selectOrganization('org-999-unauthorized');
    });
  });
});
