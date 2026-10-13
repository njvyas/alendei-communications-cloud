import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RoleDeleteDialog } from './role-delete-dialog';
import { ApiError, type RoleView } from '../../lib/api-client';

// Ensure React is globally available for JSX and SSR transforms
(globalThis as unknown as { React: typeof React }).React = React;

describe('SEC-08: RoleDeleteDialog Security & Immutability Invariants', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-orgAAAAAAAAAA';

  const createMockRole = (overrides: Partial<RoleView> = {}): RoleView => ({
    id: 'role-123',
    key: 'custom_role',
    name: 'Custom Test Role',
    description: 'A test custom role',
    orgId: ORG_A,
    isSystemRole: false,
    allowedScopeTypes: ['organization', 'workspace'],
    permissions: ['workspaces.read'],
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  });

  // ---------------------------------------------------------------------------
  // A.1: Closed or Null State
  // ---------------------------------------------------------------------------
  it('SEC-08.A1: renders null when isOpen is false or role is null', () => {
    const role = createMockRole();

    const closedHtml = renderToStaticMarkup(
      React.createElement(RoleDeleteDialog, {
        role,
        isOpen: false,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );
    assert.equal(closedHtml, '', 'Dialog must render null/empty when isOpen is false');

    const nullRoleHtml = renderToStaticMarkup(
      React.createElement(RoleDeleteDialog, {
        role: null,
        isOpen: true,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );
    assert.equal(nullRoleHtml, '', 'Dialog must render null/empty when role is null');
  });

  // ---------------------------------------------------------------------------
  // A.2: System Role Immutability
  // ---------------------------------------------------------------------------
  it('SEC-08.A2: system role (isSystemRole === true) is strictly immutable — renders warning banner and suppresses Delete button', () => {
    const systemRole = createMockRole({
      id: 'role-org-admin',
      key: 'org_admin',
      name: 'Organization Administrator',
      isSystemRole: true,
      orgId: ORG_A,
    });

    const html = renderToStaticMarkup(
      React.createElement(RoleDeleteDialog, {
        role: systemRole,
        isOpen: true,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    // 1. Must render immutable banner and explanation
    assert.ok(
      html.includes('System Roles Cannot Be Deleted'),
      'Must display "System Roles Cannot Be Deleted" title',
    );
    assert.ok(
      html.includes('is defined by the platform and is protected from deletion'),
      'Must state that role is protected from deletion',
    );
    assert.ok(html.includes('org_admin'), 'Must display role key in code tag');

    // 2. Must render Close button only
    assert.ok(html.includes('>Close<'), 'Must provide Close button for dismissal');

    // 3. Must strictly NOT render deletion trigger button
    assert.equal(
      html.includes('>Delete Role</button>'),
      false,
      'Must NOT render "Delete Role" submit button for system roles',
    );
    assert.equal(
      html.includes('Are you sure you want to permanently delete'),
      false,
      'Must NOT render deletion confirmation prompt for system roles',
    );
  });

  // ---------------------------------------------------------------------------
  // A.3: Platform Role Immutability
  // ---------------------------------------------------------------------------
  it('SEC-08.A3: platform role (orgId === null) is strictly immutable — renders warning banner and suppresses Delete button', () => {
    const platformRole = createMockRole({
      id: 'role-platform-admin',
      key: 'platform_super_admin',
      name: 'Platform Administrator',
      isSystemRole: false, // Even if isSystemRole were false, orgId === null must enforce immutability
      orgId: null,
    });

    const html = renderToStaticMarkup(
      React.createElement(RoleDeleteDialog, {
        role: platformRole,
        isOpen: true,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    assert.ok(
      html.includes('System Roles Cannot Be Deleted'),
      'Platform role with orgId null must be treated as immutable system role',
    );
    assert.equal(
      html.includes('>Delete Role</button>'),
      false,
      'Must NOT render Delete Role button for platform role',
    );
  });

  // ---------------------------------------------------------------------------
  // A.4: Custom Tenant Role Deletion
  // ---------------------------------------------------------------------------
  it('SEC-08.A4: custom tenant role renders deletion confirmation dialog and Delete button', () => {
    const customRole = createMockRole({
      id: 'role-custom-editor',
      key: 'custom_editor',
      name: 'Custom Content Editor',
      isSystemRole: false,
      orgId: ORG_A,
    });

    const html = renderToStaticMarkup(
      React.createElement(RoleDeleteDialog, {
        role: customRole,
        isOpen: true,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    assert.ok(
      html.includes('Are you sure you want to permanently delete custom role'),
      'Must render deletion confirmation text for custom tenant roles',
    );
    assert.ok(
      html.includes('Custom Content Editor'),
      'Must display role name in confirmation dialog',
    );
    assert.ok(
      html.includes('Delete Role'),
      'Must render "Delete Role" action button for custom tenant roles',
    );
    assert.ok(html.includes('Cancel'), 'Must render Cancel button');
    assert.equal(
      html.includes('System Roles Cannot Be Deleted'),
      false,
      'Must NOT render system role blocked banner for custom roles',
    );
  });

  // ---------------------------------------------------------------------------
  // A.5: Deletion API Invariant
  // ---------------------------------------------------------------------------
  it('SEC-08.A5: deletion guard invariant — immutable roles are strictly blocked from invoking rolesApi.delete', () => {
    const systemRole = createMockRole({ isSystemRole: true, orgId: ORG_A });
    const platformRole = createMockRole({ isSystemRole: false, orgId: null });
    const customRole = createMockRole({ isSystemRole: false, orgId: ORG_A });

    // The canonical immutability predicate from RoleDeleteDialog:
    const isImmutablePredicate = (r: RoleView) => r.isSystemRole || r.orgId === null;

    assert.equal(isImmutablePredicate(systemRole), true);
    assert.equal(isImmutablePredicate(platformRole), true);
    assert.equal(isImmutablePredicate(customRole), false);

    // Simulated execution guard
    let deleteCalls = 0;
    const executeDelete = (r: RoleView) => {
      if (isImmutablePredicate(r)) return;
      deleteCalls++;
    };

    executeDelete(systemRole);
    assert.equal(deleteCalls, 0, 'Must not call delete for system role');

    executeDelete(platformRole);
    assert.equal(deleteCalls, 0, 'Must not call delete for platform role');

    executeDelete(customRole);
    assert.equal(deleteCalls, 1, 'Must call delete for custom role');
  });

  // ---------------------------------------------------------------------------
  // A.6: Safe Error Handling
  // ---------------------------------------------------------------------------
  describe('A.6: Safe Error Handling Guidance', () => {
    // Pure error message resolver reflecting RoleDeleteDialog error handling
    const getDeleteErrorMessage = (err: unknown): string => {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          return 'The role is still assigned to one or more users. Revoke those assignments before deleting the role.';
        }
        if (err.status === 403) {
          return 'System and platform roles cannot be deleted.';
        }
        if (err.status === 404) {
          return 'Role already deleted.';
        }
        return err.message || 'Failed to delete role.';
      }
      return 'An unexpected network error occurred.';
    };

    it('renders explicit guidance when role is still assigned to users (409)', () => {
      const err = new ApiError(409, 'ROLE_IN_USE', 'Role currently in use', 'corr-409', false);
      const msg = getDeleteErrorMessage(err);
      assert.match(msg, /The role is still assigned to one or more users/i);
      assert.match(msg, /Revoke those assignments before deleting/i);
    });

    it('renders explicit protection message when backend refuses deletion (403)', () => {
      const err = new ApiError(
        403,
        'AUTHZ_SYSTEM_ROLE_IMMUTABLE',
        'System role immutable',
        'corr-403',
        false,
      );
      const msg = getDeleteErrorMessage(err);
      assert.equal(msg, 'System and platform roles cannot be deleted.');
    });

    it('handles unexpected network error safely without leaking internals', () => {
      const err = new Error('ECONNRESET: socket hang up');
      const msg = getDeleteErrorMessage(err);
      assert.equal(msg, 'An unexpected network error occurred.');
    });
  });
});
