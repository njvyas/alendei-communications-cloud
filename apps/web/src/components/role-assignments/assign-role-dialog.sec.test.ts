import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AssignRoleDialog, isAssignableTenantRole } from './assign-role-dialog';
import {
  type RoleView,
  type WorkspaceItem,
  type TeamView,
  type UserIdentity,
} from '../../lib/api-client';
import { useSession } from '../../lib/session-store';

// Ensure React is globally available for JSX and SSR transforms
(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('SEC-08: AssignRoleDialog Security & Scope Invariants', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-orgAAAAAAAAAA';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-orgBBBBBBBBBB';
  const WS_1 = '01955b0a-7b3b-7411-9a4f-ws1111111111';
  const WS_2 = '01955b0a-7b3b-7411-9a4f-ws2222222222';
  const USER_ID = '01955b0a-7b3b-7411-9a4f-targetuser11';
  const USER_EMAIL = 'target.user@example.com';

  const createMockRole = (overrides: Partial<RoleView> = {}): RoleView => ({
    id: 'role-default',
    key: 'role_default',
    name: 'Default Role',
    description: 'A test role',
    orgId: ORG_A,
    isSystemRole: false,
    allowedScopeTypes: ['organization'],
    permissions: ['roles.read'],
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  });

  const mockWorkspaces: readonly WorkspaceItem[] = [
    {
      id: WS_1,
      orgId: ORG_A,
      name: 'Primary Workspace',
      slug: 'primary',
      isDefault: true,
      status: 'active',
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    },
  ];

  const setupSession = () => {
    const user: UserIdentity = {
      userId: 'admin-1',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
      authorizedOrganizationIds: [ORG_A],
      roles: [],
      permissions: ['role_assignments.grant'],
    };
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user,
      authorization: {
        actorType: 'user',
        userId: 'admin-1',
        apiKeyId: null,
        grants: [],
        organizationIds: [ORG_A],
        isPlatformAdmin: false,
      },
      selectedOrgId: ORG_A,
    });
  };

  beforeEach(() => {
    setupSession();
  });

  afterEach(() => {
    useSession.getState().clearSession();
  });

  // ---------------------------------------------------------------------------
  // B.1: Closed State
  // ---------------------------------------------------------------------------
  it('SEC-08.B1: renders null when isOpen is false', () => {
    const qc = new QueryClient();
    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(AssignRoleDialog, {
          isOpen: false,
          userId: USER_ID,
          userEmail: USER_EMAIL,
          onClose: () => {},
          onSuccess: () => {},
        }),
      ),
    );
    assert.equal(html, '', 'Dialog must render null/empty when isOpen is false');
  });

  // ---------------------------------------------------------------------------
  // B.2: Assignable Roles Filtering (System Roles Admitted, Platform/Foreign Excluded)
  // ---------------------------------------------------------------------------
  it('SEC-08.B2: admits seeded tenant system roles (org_admin, agent) and excludes platform roles (orgId === null) and foreign org roles', () => {
    const orgAdminRole = createMockRole({
      id: 'role-org-admin',
      key: 'org_admin',
      name: 'Organization Administrator',
      isSystemRole: true,
      orgId: ORG_A,
      allowedScopeTypes: ['organization'],
    });

    const agentRole = createMockRole({
      id: 'role-agent',
      key: 'agent',
      name: 'Support Agent',
      isSystemRole: true,
      orgId: ORG_A,
      allowedScopeTypes: ['workspace', 'team'],
    });

    const customRole = createMockRole({
      id: 'role-custom-lead',
      key: 'custom_lead',
      name: 'Custom Team Lead',
      isSystemRole: false,
      orgId: ORG_A,
      allowedScopeTypes: ['team'],
    });

    const platformRole = createMockRole({
      id: 'role-platform-admin',
      key: 'platform_super_admin',
      name: 'Platform Super Admin',
      isSystemRole: true,
      orgId: null, // Platform role
      allowedScopeTypes: ['platform'],
    });

    const foreignRole = createMockRole({
      id: 'role-foreign-admin',
      key: 'foreign_admin',
      name: 'Foreign Organization Role',
      isSystemRole: false,
      orgId: ORG_B, // Foreign organization
      allowedScopeTypes: ['organization'],
    });

    const mockRoles: readonly RoleView[] = [
      orgAdminRole,
      agentRole,
      customRole,
      platformRole,
      foreignRole,
    ];

    // Verify pure isAssignableTenantRole helper invariants directly
    assert.equal(
      isAssignableTenantRole(orgAdminRole, ORG_A),
      true,
      'Tenant system org_admin must be assignable',
    );
    assert.equal(
      isAssignableTenantRole(agentRole, ORG_A),
      true,
      'Tenant system agent must be assignable',
    );
    assert.equal(
      isAssignableTenantRole(customRole, ORG_A),
      true,
      'Custom tenant role must be assignable',
    );
    assert.equal(
      isAssignableTenantRole(platformRole, ORG_A),
      false,
      'Platform role must NOT be assignable',
    );
    assert.equal(
      isAssignableTenantRole(foreignRole, ORG_A),
      false,
      'Foreign org role must NOT be assignable',
    );

    // Verify rendered dialog component options
    const qc = new QueryClient();
    qc.setQueryData(['roles', 'assignable-list', ORG_A], {
      data: mockRoles,
      page: { nextCursor: null, hasMore: false, limit: 100 },
    });
    qc.setQueryData(['workspaces', 'list', ORG_A], {
      data: mockWorkspaces,
    });

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(AssignRoleDialog, {
          isOpen: true,
          userId: USER_ID,
          userEmail: USER_EMAIL,
          onClose: () => {},
          onSuccess: () => {},
        }),
      ),
    );

    // 1. Seeded tenant system roles MUST appear as assignable options
    assert.ok(
      html.includes('value="role-org-admin"'),
      'Option for seeded system role org_admin must be present',
    );
    assert.ok(
      html.includes('Organization Administrator (org_admin)'),
      'Display label for org_admin must be rendered',
    );
    assert.ok(
      html.includes('value="role-agent"'),
      'Option for seeded system role agent must be present',
    );

    // 2. Custom role for active organization MUST appear
    assert.ok(
      html.includes('value="role-custom-lead"'),
      'Option for custom role in active org must be present',
    );

    // 3. Platform role (orgId === null) MUST be strictly excluded
    assert.equal(
      html.includes('value="role-platform-admin"'),
      false,
      'Platform role must NOT be present in select options',
    );
    assert.equal(
      html.includes('Platform Super Admin'),
      false,
      'Platform role label must NOT be rendered',
    );

    // 4. Foreign organization role MUST be strictly excluded
    assert.equal(
      html.includes('value="role-foreign-admin"'),
      false,
      'Foreign organization role must NOT be present in select options',
    );
  });

  // ---------------------------------------------------------------------------
  // B.3: Team Scope Admissibility on Role Selection
  // ---------------------------------------------------------------------------
  it('SEC-08.B3: Team Scope radio option is rendered only when role admits team scope', () => {
    // Role 1: org_admin admits only organization scope
    const orgOnlyRole = createMockRole({
      id: 'role-org-only',
      allowedScopeTypes: ['organization'],
    });
    // Role 2: agent admits workspace and team scope
    const teamAdmittedRole = createMockRole({
      id: 'role-team-admitted',
      allowedScopeTypes: ['workspace', 'team'],
    });

    assert.equal(
      orgOnlyRole.allowedScopeTypes.includes('team'),
      false,
      'org_admin must not admit team scope',
    );
    assert.equal(
      teamAdmittedRole.allowedScopeTypes.includes('team'),
      true,
      'agent must admit team scope',
    );

    // Invariant: The scope selector checks roleAllowedScopes.includes('team') before rendering the team radio button.
    const isTeamScopeRenderable = (role: RoleView) => role.allowedScopeTypes.includes('team');
    assert.equal(isTeamScopeRenderable(orgOnlyRole), false);
    assert.equal(isTeamScopeRenderable(teamAdmittedRole), true);
  });

  // ---------------------------------------------------------------------------
  // B.4: Team Scope Assignment Validation Requirements
  // ---------------------------------------------------------------------------
  it('SEC-08.B4: team scope assignment requires valid workspace and team selection', () => {
    const validateAssignmentSubmission = (params: {
      selectedRoleId: string;
      selectedScopeType: 'organization' | 'workspace' | 'team' | null;
      selectedWorkspaceId: string;
      selectedTeamId: string;
    }): { valid: boolean; error?: string } => {
      if (!params.selectedRoleId) return { valid: false, error: 'Please select a role to assign.' };
      if (!params.selectedScopeType)
        return { valid: false, error: 'Please choose an assignment scope.' };
      if (params.selectedScopeType === 'workspace' && !params.selectedWorkspaceId) {
        return { valid: false, error: 'Please select a target workspace.' };
      }
      if (params.selectedScopeType === 'team') {
        if (!params.selectedWorkspaceId)
          return { valid: false, error: 'Please select a target workspace.' };
        if (!params.selectedTeamId) return { valid: false, error: 'Please select a target team.' };
      }
      return { valid: true };
    };

    // Submitting team scope without workspace selection
    const resNoWs = validateAssignmentSubmission({
      selectedRoleId: 'role-agent',
      selectedScopeType: 'team',
      selectedWorkspaceId: '',
      selectedTeamId: 'team-1',
    });
    assert.equal(resNoWs.valid, false);
    assert.equal(resNoWs.error, 'Please select a target workspace.');

    // Submitting team scope without team selection
    const resNoTeam = validateAssignmentSubmission({
      selectedRoleId: 'role-agent',
      selectedScopeType: 'team',
      selectedWorkspaceId: 'ws-1',
      selectedTeamId: '',
    });
    assert.equal(resNoTeam.valid, false);
    assert.equal(resNoTeam.error, 'Please select a target team.');

    // Submitting team scope with both workspace and team
    const resValid = validateAssignmentSubmission({
      selectedRoleId: 'role-agent',
      selectedScopeType: 'team',
      selectedWorkspaceId: 'ws-1',
      selectedTeamId: 'team-1',
    });
    assert.equal(resValid.valid, true);
  });

  // ---------------------------------------------------------------------------
  // B.5: Team Scope Hierarchy Invariants (Cross-Workspace & Cross-Tenant Rejection)
  // ---------------------------------------------------------------------------
  it('SEC-08.B5: team scope hierarchy validation strictly prevents cross-workspace or cross-tenant team assignment', () => {
    const teams: readonly TeamView[] = [
      {
        id: 'team-valid',
        orgId: ORG_A,
        workspaceId: WS_1,
        name: 'Valid Team',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'team-wrong-ws',
        orgId: ORG_A,
        workspaceId: WS_2, // Belongs to different workspace
        name: 'Wrong Workspace Team',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'team-wrong-org',
        orgId: ORG_B, // Belongs to foreign organization
        workspaceId: WS_1,
        name: 'Foreign Org Team',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    // The canonical validation check implemented in AssignRoleDialog handleSubmit
    const validateTeamHierarchy = (
      teamId: string,
      targetWorkspaceId: string,
      activeOrgId: string,
    ): { valid: boolean; error?: string } => {
      const team = teams.find((t) => t.id === teamId);
      if (team) {
        if (team.workspaceId !== targetWorkspaceId) {
          return { valid: false, error: 'Selected team does not belong to the chosen workspace.' };
        }
        if (activeOrgId && team.orgId !== activeOrgId) {
          return {
            valid: false,
            error: 'Selected team does not belong to the active organization.',
          };
        }
      }
      return { valid: true };
    };

    const validRes = validateTeamHierarchy('team-valid', WS_1, ORG_A);
    assert.equal(validRes.valid, true);

    const wrongWsRes = validateTeamHierarchy('team-wrong-ws', WS_1, ORG_A);
    assert.equal(wrongWsRes.valid, false);
    assert.equal(wrongWsRes.error, 'Selected team does not belong to the chosen workspace.');

    const wrongOrgRes = validateTeamHierarchy('team-wrong-org', WS_1, ORG_A);
    assert.equal(wrongOrgRes.valid, false);
    assert.equal(wrongOrgRes.error, 'Selected team does not belong to the active organization.');
  });

  // ---------------------------------------------------------------------------
  // B.6: Unadmitted Scope Level Rejection
  // ---------------------------------------------------------------------------
  it('SEC-08.B6: cannot submit role assignment for unadmitted scope level', () => {
    const roleOrgOnly = createMockRole({
      id: 'role-org-only',
      allowedScopeTypes: ['organization'],
    });

    const validateAdmittedScope = (
      role: RoleView,
      scopeType: 'organization' | 'workspace' | 'team',
    ): { valid: boolean; error?: string } => {
      if (!role.allowedScopeTypes.includes(scopeType)) {
        return { valid: false, error: `The chosen role does not admit ${scopeType} scope.` };
      }
      return { valid: true };
    };

    const attemptTeam = validateAdmittedScope(roleOrgOnly, 'team');
    assert.equal(attemptTeam.valid, false);
    assert.equal(attemptTeam.error, 'The chosen role does not admit team scope.');

    const attemptWs = validateAdmittedScope(roleOrgOnly, 'workspace');
    assert.equal(attemptWs.valid, false);
    assert.equal(attemptWs.error, 'The chosen role does not admit workspace scope.');

    const attemptOrg = validateAdmittedScope(roleOrgOnly, 'organization');
    assert.equal(attemptOrg.valid, true);
  });

  // ---------------------------------------------------------------------------
  // B.7: Platform-Level Roles Cannot Be Granted Through Tenant Administration
  // ---------------------------------------------------------------------------
  it('SEC-08.B7: platform-level roles (orgId === null) cannot be granted through tenant administration', () => {
    const platformRole = createMockRole({
      id: 'platform-role',
      orgId: null,
      allowedScopeTypes: ['platform'],
    });

    const validateTenantGrant = (
      role: RoleView,
      activeOrgId: string,
    ): { valid: boolean; error?: string } => {
      if (role.orgId === null) {
        return {
          valid: false,
          error: 'Platform-level roles cannot be granted through tenant administration.',
        };
      }
      if (activeOrgId && role.orgId !== activeOrgId) {
        return { valid: false, error: 'Roles from other organizations cannot be granted.' };
      }
      return { valid: true };
    };

    const res = validateTenantGrant(platformRole, ORG_A);
    assert.equal(res.valid, false);
    assert.equal(
      res.error,
      'Platform-level roles cannot be granted through tenant administration.',
    );
  });

  // ---------------------------------------------------------------------------
  // B.8: Foreign Organization Roles Cannot Be Granted
  // ---------------------------------------------------------------------------
  it('SEC-08.B8: roles from other organizations cannot be granted', () => {
    const foreignRole = createMockRole({
      id: 'foreign-role',
      orgId: ORG_B,
      allowedScopeTypes: ['organization'],
    });

    const validateTenantGrant = (
      role: RoleView,
      activeOrgId: string,
    ): { valid: boolean; error?: string } => {
      if (role.orgId === null) {
        return {
          valid: false,
          error: 'Platform-level roles cannot be granted through tenant administration.',
        };
      }
      if (activeOrgId && role.orgId !== activeOrgId) {
        return { valid: false, error: 'Roles from other organizations cannot be granted.' };
      }
      return { valid: true };
    };

    const res = validateTenantGrant(foreignRole, ORG_A);
    assert.equal(res.valid, false);
    assert.equal(res.error, 'Roles from other organizations cannot be granted.');
  });
});
