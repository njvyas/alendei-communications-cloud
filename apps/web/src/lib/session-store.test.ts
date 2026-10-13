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
import {
  getActiveOrganizationGrants,
  getHeldOrganizationPermissions,
  hasPermission,
  useSession,
} from './session-store';

function createMockUser(
  authorizedOrganizationIds: string[] = [],
  orgIdInTenant: string | null = null,
): UserIdentity {
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

    assert.throws(() => {
      useSession.getState().selectOrganization('org-forged-or-unauthorized');
    }, /Cannot select unauthorized organization/);

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

  // ---------------------------------------------------------------------------
  // SEC-01: Downward-Only Scope Inheritance & Permission Evaluation
  // ---------------------------------------------------------------------------
  describe('SEC-01: Canonical Scope Inheritance & Permission Evaluation', () => {
    const ORG_A = '01955b0a-7b3b-7411-9a4f-org-alpha-111';
    const ORG_B = '01955b0a-7b3b-7411-9a4f-org-beta--222';
    const RESELLER_R1 = '01955b0a-7b3b-7411-9a4f-reseller-r1';
    const RESELLER_R2 = '01955b0a-7b3b-7411-9a4f-reseller-r2';
    const WS_1 = '01955b0a-7b3b-7411-9a4f-workspace-01';
    const TEAM_1 = '01955b0a-7b3b-7411-9a4f-team-----01';

    it('team grant cannot authorize an organization-level operation', () => {
      // Actor holds teams.update and audit.read ONLY at team scope
      useSession.getState().setSession({
        accessToken: 'token-team-test',
        user: createMockUser([ORG_A]),
        authorization: {
          actorType: 'user',
          userId: 'user-team',
          apiKeyId: null,
          grants: [
            {
              roleId: 'role-team-lead',
              roleKey: 'team_lead',
              scopeType: 'team',
              scopeId: TEAM_1,
              orgId: ORG_A,
              permissions: ['teams.update', 'audit.read', 'workspaces.read'],
            },
          ],
          organizationIds: [ORG_A],
          isPlatformAdmin: false,
        },
        selectedOrgId: ORG_A,
      });

      // Operation at organization level (default target) must fail closed
      assert.equal(hasPermission('teams.update'), false);
      assert.equal(hasPermission('audit.read'), false);
      assert.equal(hasPermission('workspaces.read'), false);

      // Nor does it appear in held organization permissions
      const held = getHeldOrganizationPermissions();
      assert.equal(held.has('teams.update'), false);
      assert.equal(held.has('audit.read'), false);
    });

    it('workspace grant cannot authorize an organization-level operation', () => {
      // Actor holds workspaces.update and users.disable ONLY at workspace scope
      useSession.getState().setSession({
        accessToken: 'token-ws-test',
        user: createMockUser([ORG_A]),
        authorization: {
          actorType: 'user',
          userId: 'user-ws',
          apiKeyId: null,
          grants: [
            {
              roleId: 'role-ws-manager',
              roleKey: 'workspace_manager',
              scopeType: 'workspace',
              scopeId: WS_1,
              orgId: ORG_A,
              permissions: ['workspaces.update', 'users.disable', 'workspaces.read'],
            },
          ],
          organizationIds: [ORG_A],
          isPlatformAdmin: false,
        },
        selectedOrgId: ORG_A,
      });

      // Operation at organization level must fail closed
      assert.equal(hasPermission('workspaces.update'), false);
      assert.equal(hasPermission('users.disable'), false);
      assert.equal(hasPermission('workspaces.read'), false);

      // Nor does it appear in held organization permissions
      const held = getHeldOrganizationPermissions();
      assert.equal(held.has('workspaces.update'), false);
      assert.equal(held.has('users.disable'), false);
    });

    it('organization grant behaves according to the canonical permission rules', () => {
      // Actor holds roles.read and workspaces.create at organization scope for ORG_A
      useSession.getState().setSession({
        accessToken: 'token-org-test',
        user: createMockUser([ORG_A, ORG_B]),
        authorization: {
          actorType: 'user',
          userId: 'user-org',
          apiKeyId: null,
          grants: [
            {
              roleId: 'role-org-admin',
              roleKey: 'org_admin',
              scopeType: 'organization',
              scopeId: ORG_A,
              orgId: ORG_A,
              permissions: ['roles.read', 'workspaces.create', 'workspaces.read'],
            },
          ],
          organizationIds: [ORG_A, ORG_B],
          isPlatformAdmin: false,
        },
        selectedOrgId: ORG_A,
      });

      // Authorizes operations at active organization scope (ORG_A)
      assert.equal(hasPermission('roles.read'), true);
      assert.equal(hasPermission('workspaces.create'), true);
      assert.equal(hasPermission('workspaces.read'), true);

      // Does NOT authorize operations when active organization context is changed to ORG_B
      useSession.getState().selectOrganization(ORG_B);
      assert.equal(hasPermission('roles.read'), false);
      assert.equal(hasPermission('workspaces.create'), false);
      assert.equal(hasPermission('workspaces.read'), false);
    });

    it('organization grant cannot be used to claim authorization for foreign scopes or caller-supplied arguments', () => {
      // Actor holds organization-scoped grant for ORG_A only
      useSession.getState().setSession({
        accessToken: 'token-foreign-scope-test',
        user: createMockUser([ORG_A, ORG_B]),
        authorization: {
          actorType: 'user',
          userId: 'user-org-alpha',
          apiKeyId: null,
          grants: [
            {
              roleId: 'role-org-admin',
              roleKey: 'org_admin',
              scopeType: 'organization',
              scopeId: ORG_A,
              orgId: ORG_A,
              permissions: ['workspaces.read', 'workspaces.create', 'roles.read'],
            },
          ],
          organizationIds: [ORG_A, ORG_B],
          isPlatformAdmin: false,
        },
        selectedOrgId: ORG_A,
      });

      // Existing active-organization permissions work
      assert.equal(hasPermission('workspaces.read'), true);
      assert.equal(hasPermission('workspaces.create'), true);
      assert.equal(hasPermission('roles.read'), true);

      // Caller cannot supply a foreign scope argument to influence permission result
      const untypedHasPermission = hasPermission as unknown as (
        perm: string,
        foreignScope?: unknown,
      ) => boolean;

      // Evaluates strictly against active ORG_A context where workspaces.read is held
      assert.equal(
        untypedHasPermission('workspaces.read', {
          scopeType: 'workspace',
          scopeId: 'foreign-ws-in-org-b',
        }),
        true,
      );

      // When switching to ORG_B, the ORG_A grant cannot authorize ORG_B, even if caller passes scopeId ORG_A
      useSession.getState().selectOrganization(ORG_B);
      assert.equal(hasPermission('workspaces.read'), false);
      assert.equal(hasPermission('workspaces.create'), false);
      assert.equal(hasPermission('roles.read'), false);
      assert.equal(
        untypedHasPermission('workspaces.read', {
          scopeType: 'organization',
          scopeId: ORG_A,
        }),
        false,
      );
    });

    it('valid reseller grant is recognized for an organization within that reseller', () => {
      // User belongs to RESELLER_R1 and active organization is under RESELLER_R1
      const user = createMockUser([ORG_A]);
      (user as { tenant: { resellerId: string | null } }).tenant.resellerId = RESELLER_R1;

      useSession.getState().setSession({
        accessToken: 'token-reseller-test',
        user,
        authorization: {
          actorType: 'user',
          userId: 'user-reseller',
          apiKeyId: null,
          grants: [
            {
              roleId: 'role-reseller-admin',
              roleKey: 'reseller_admin',
              scopeType: 'reseller',
              scopeId: RESELLER_R1,
              orgId: null,
              permissions: ['workspaces.read', 'audit.read'],
            },
          ],
          organizationIds: [ORG_A],
          isPlatformAdmin: false,
        },
        selectedOrgId: ORG_A,
      });

      // Reseller grant covers organizations beneath RESELLER_R1
      assert.equal(hasPermission('workspaces.read'), true);
      assert.equal(hasPermission('audit.read'), true);

      // Held organization permissions include reseller-derived permissions
      const held = getHeldOrganizationPermissions();
      assert.ok(held.has('workspaces.read'));
      assert.ok(held.has('audit.read'));

      // Active organization grants include the covering reseller grant
      const activeGrants = getActiveOrganizationGrants();
      assert.equal(
        activeGrants.some((g) => g.scopeType === 'reseller'),
        true,
      );
    });

    it('reseller grant does not confer access outside that reseller', () => {
      // User holds grant for RESELLER_R1, but active organization is under RESELLER_R2
      const user = createMockUser([ORG_B]);
      (user as { tenant: { resellerId: string | null } }).tenant.resellerId = RESELLER_R2;

      useSession.getState().setSession({
        accessToken: 'token-reseller-mismatch',
        user,
        authorization: {
          actorType: 'user',
          userId: 'user-reseller',
          apiKeyId: null,
          grants: [
            {
              roleId: 'role-reseller-admin',
              roleKey: 'reseller_admin',
              scopeType: 'reseller',
              scopeId: RESELLER_R1,
              orgId: null,
              permissions: ['workspaces.read', 'audit.read'],
            },
          ],
          organizationIds: [ORG_B],
          isPlatformAdmin: false,
        },
        selectedOrgId: ORG_B,
      });

      // Must NOT confer access to organization belonging to a different reseller
      assert.equal(hasPermission('workspaces.read'), false);
      assert.equal(hasPermission('audit.read'), false);

      const held = getHeldOrganizationPermissions();
      assert.equal(held.has('workspaces.read'), false);

      const activeGrants = getActiveOrganizationGrants();
      assert.equal(
        activeGrants.some((g) => g.scopeType === 'reseller'),
        false,
      );
    });

    it('platform admin can exercise legitimate SUPER_ADMIN_PERMISSIONS', () => {
      useSession.getState().setSession({
        accessToken: 'token-super-admin',
        user: {
          ...createMockUser([ORG_A]),
          tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
        },
        authorization: {
          actorType: 'user',
          userId: 'user-platform-admin',
          apiKeyId: null,
          grants: [],
          organizationIds: [ORG_A],
          isPlatformAdmin: true,
        },
        selectedOrgId: ORG_A,
      });

      // Legitimate tenancy administration and platform permissions in SUPER_ADMIN_PERMISSIONS
      assert.equal(hasPermission('audit.read'), true);
      assert.equal(hasPermission('organizations.read'), true);
      assert.equal(hasPermission('workspaces.read'), true);
      assert.equal(hasPermission('platform.tenants.manage'), true);
      assert.equal(hasPermission('platform.audit.read'), true);

      const held = getHeldOrganizationPermissions();
      assert.ok(held.has('audit.read'));
      assert.ok(held.has('organizations.read'));
      assert.ok(held.has('workspaces.read'));
    });

    it('platform admin cannot implicitly authorize an unknown or malformed permission', () => {
      useSession.getState().setSession({
        accessToken: 'token-super-admin',
        user: {
          ...createMockUser([ORG_A]),
          tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
        },
        authorization: {
          actorType: 'user',
          userId: 'user-platform-admin',
          apiKeyId: null,
          grants: [],
          organizationIds: [ORG_A],
          isPlatformAdmin: true,
        },
        selectedOrgId: ORG_A,
      });

      // Nonexistent, malformed, or arbitrary permissions must fail closed
      assert.equal(hasPermission('nonexistent.action'), false);
      assert.equal(hasPermission('system.admin.bypass'), false);
      assert.equal(hasPermission('*'), false);
      assert.equal(hasPermission(''), false);

      const held = getHeldOrganizationPermissions();
      assert.equal(held.has('nonexistent.action'), false);
    });

    it('platform admin cannot implicitly authorize tenant-content permissions', () => {
      useSession.getState().setSession({
        accessToken: 'token-super-admin',
        user: {
          ...createMockUser([ORG_A]),
          tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
        },
        authorization: {
          actorType: 'user',
          userId: 'user-platform-admin',
          apiKeyId: null,
          grants: [],
          organizationIds: [ORG_A],
          isPlatformAdmin: true,
        },
        selectedOrgId: ORG_A,
      });

      // Tenant-content permissions MUST NOT be conferred via platform admin flag
      assert.equal(hasPermission('contacts.read'), false);
      assert.equal(hasPermission('contacts.manage'), false);
      assert.equal(hasPermission('templates.read'), false);
      assert.equal(hasPermission('templates.manage'), false);
      assert.equal(hasPermission('suppressions.read'), false);
      assert.equal(hasPermission('suppressions.manage'), false);
      assert.equal(hasPermission('messages.read'), false);
      assert.equal(hasPermission('messages.send'), false);

      // Held organization permissions for platform admin do not include tenant content
      const held = getHeldOrganizationPermissions();
      assert.equal(held.has('contacts.read'), false);
      assert.equal(held.has('templates.read'), false);
      assert.equal(held.has('messages.send'), false);

      // Even if a platform grant explicitly lists a tenant-content permission,
      // grantConfers enforces that platform scope cannot confer tenant-content keys
      useSession.getState().setSession({
        accessToken: 'token-bogus-platform-grant',
        user: createMockUser([ORG_A]),
        authorization: {
          actorType: 'user',
          userId: 'user-bogus',
          apiKeyId: null,
          grants: [
            {
              roleId: 'role-bogus',
              roleKey: 'bogus_role',
              scopeType: 'platform',
              scopeId: null,
              orgId: null,
              permissions: ['contacts.read'],
            },
          ],
          organizationIds: [ORG_A],
          isPlatformAdmin: false,
        },
        selectedOrgId: ORG_A,
      });

      assert.equal(hasPermission('contacts.read'), false);
    });

    it('platform admin cannot access explicit platform-catalogue permissions using admin flag alone', () => {
      useSession.getState().setSession({
        accessToken: 'token-super-admin',
        user: {
          ...createMockUser([ORG_A]),
          tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
        },
        authorization: {
          actorType: 'user',
          userId: 'user-platform-admin',
          apiKeyId: null,
          grants: [],
          organizationIds: [ORG_A],
          isPlatformAdmin: true,
        },
        selectedOrgId: ORG_A,
      });

      // Explicit platform catalogue permissions require genuine qualifying grant
      assert.equal(hasPermission('providers.read'), false);
      assert.equal(hasPermission('providers.manage'), false);
      assert.equal(hasPermission('providers.test_send'), false);

      const held = getHeldOrganizationPermissions();
      assert.equal(held.has('providers.read'), false);
      assert.equal(held.has('providers.manage'), false);
      assert.equal(held.has('providers.test_send'), false);
    });

    it('platform admin can access platform-catalogue permissions when holding genuine platform grant', () => {
      useSession.getState().setSession({
        accessToken: 'token-super-admin-with-grant',
        user: {
          ...createMockUser([ORG_A]),
          tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
        },
        authorization: {
          actorType: 'user',
          userId: 'user-platform-admin',
          apiKeyId: null,
          grants: [
            {
              roleId: 'role-providers-manager',
              roleKey: 'providers_manager',
              scopeType: 'platform',
              scopeId: null,
              orgId: null,
              permissions: ['providers.read', 'providers.manage', 'providers.test_send'],
            },
          ],
          organizationIds: [ORG_A],
          isPlatformAdmin: true,
        },
        selectedOrgId: ORG_A,
      });

      // Succeeded via genuine qualifying platform grant
      assert.equal(hasPermission('providers.read'), true);
      assert.equal(hasPermission('providers.manage'), true);
      assert.equal(hasPermission('providers.test_send'), true);

      const held = getHeldOrganizationPermissions();
      assert.ok(held.has('providers.read'));
      assert.ok(held.has('providers.manage'));
      assert.ok(held.has('providers.test_send'));
    });

    it('missing authorization fails closed', () => {
      useSession.getState().clearSession();

      assert.equal(useSession.getState().authorization, null);
      assert.equal(hasPermission('workspaces.read'), false);
      assert.equal(hasPermission('audit.read'), false);
      assert.equal(hasPermission('roles.read'), false);
      assert.equal(hasPermission('contacts.read'), false);
      assert.equal(getHeldOrganizationPermissions().size, 0);
      assert.deepEqual(getActiveOrganizationGrants(), []);
    });
  });
});
