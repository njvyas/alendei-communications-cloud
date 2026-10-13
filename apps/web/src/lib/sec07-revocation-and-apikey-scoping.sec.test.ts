import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ERROR_CODES,
  SUPER_ADMIN_PERMISSIONS,
  ALL_PERMISSION_KEYS,
  isTenantContentPermission,
  permissionAllowedAt,
} from '@acc/contracts';
import { ApiError, type EffectiveAuthorization } from './api-client';
import { getRevokeErrorMessage } from '../components/role-assignments/revoke-assignment-dialog';
import { computeHeldApiKeyPermissions } from '../components/api-keys/create-api-key-dialog';

describe('SEC-07: Revocation Error Handling & API-Key Permission Scoping', () => {
  const ORG_1 = '01955b0a-7b3b-7411-9a4f-9e67d4f90001';
  const ORG_2 = '01955b0a-7b3b-7411-9a4f-9e67d4f90002';
  const WS_1 = '01955b0a-7b3b-7411-9a4f-9e67d4f90011';
  const WS_2 = '01955b0a-7b3b-7411-9a4f-9e67d4f90022';

  // ===========================================================================
  // 1. Revocation Error Handling (RevokeAssignmentDialog)
  // ===========================================================================
  describe('Revocation Error Handling', () => {
    it('SEC-07.1: renders explicit guidance for AUTHZ_LAST_PLATFORM_ADMIN (409)', () => {
      const err = new ApiError(
        409,
        ERROR_CODES.AUTHZ_LAST_PLATFORM_ADMIN,
        'Cannot revoke last platform admin',
        'corr-1',
        false,
      );
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /Cannot revoke the last active platform administrator/i);
      assert.match(msg, /Appoint another platform administrator first/i);
    });

    it('SEC-07.2: renders explicit guidance for AUTHZ_LAST_ORGANIZATION_ADMIN (409)', () => {
      const err = new ApiError(
        409,
        ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
        'Conflict: last org admin',
        'corr-2',
        false,
      );
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /Cannot revoke the last active organization administrator/i);
      assert.match(msg, /Appoint another organization administrator first/i);
    });

    it('SEC-07.3: renders explicit guidance for AUTHZ_LAST_RESELLER_ADMIN (409)', () => {
      const err = new ApiError(
        409,
        ERROR_CODES.AUTHZ_LAST_RESELLER_ADMIN,
        'Conflict: last reseller admin',
        'corr-3',
        false,
      );
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /Cannot revoke the last active reseller administrator/i);
      assert.match(msg, /Appoint another reseller administrator first/i);
    });

    it('SEC-07.4: renders symmetric revocation guidance with rejected permissions for AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION (403)', () => {
      const err = new ApiError(
        403,
        ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
        'Unheld permissions',
        'corr-4',
        false,
        { rejected: ['roles.create', 'roles.update'] },
      );
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /Under symmetric revocation rules/i);
      assert.match(msg, /roles\.create, roles\.update/);
      // Must NOT claim that role_assignments.revoke is missing
      assert.equal(msg.includes('role_assignments.revoke required'), false);
    });

    it('SEC-07.5: renders symmetric revocation guidance without rejected list when details are empty', () => {
      const err = new ApiError(
        403,
        ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
        'Unheld permissions',
        'corr-5',
        false,
      );
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /Under symmetric revocation rules/i);
      assert.match(msg, /carries permissions you do not hold at this scope/i);
      assert.equal(msg.includes('role_assignments.revoke required'), false);
    });

    it('SEC-07.6: generic 403 message is strictly reserved for ordinary missing revoke permission', () => {
      const err = new ApiError(
        403,
        ERROR_CODES.AUTHZ_PERMISSION_DENIED,
        'Forbidden',
        'corr-6',
        false,
      );
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /role_assignments\.revoke required/i);
    });

    it('SEC-07.7: handles 404 resource not found / already revoked cleanly', () => {
      const err = new ApiError(404, ERROR_CODES.RESOURCE_NOT_FOUND, 'Not Found', 'corr-7', false);
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /already revoked or does not exist/i);
    });

    it('SEC-07.8: handles generic 409 conflict gracefully', () => {
      const err = new ApiError(
        409,
        ERROR_CODES.RESOURCE_CONFLICT,
        'Concurrent write detected',
        'corr-8',
        false,
      );
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /Concurrent write detected/);
    });

    it('SEC-07.9: handles 429 rate limit exceeded', () => {
      const err = new ApiError(
        429,
        ERROR_CODES.RATE_LIMIT_EXCEEDED,
        'Too Many Requests',
        'corr-9',
        true,
      );
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /Rate limit exceeded/i);
    });

    it('SEC-07.10: handles non-ApiError network failure', () => {
      const err = new TypeError('Failed to fetch');
      const msg = getRevokeErrorMessage(err);
      assert.match(msg, /Network error while revoking role assignment/i);
    });
  });

  // ===========================================================================
  // 2. API-Key Permission Scoping (computeHeldApiKeyPermissions)
  // ===========================================================================
  describe('API-Key Permission Scoping', () => {
    it('SEC-07.11: platform administrator API keys derive held permissions from SUPER_ADMIN_PERMISSIONS and target scope admissibility', () => {
      const auth: EffectiveAuthorization = {
        actorType: 'user',
        userId: 'admin-1',
        apiKeyId: null,
        grants: [],
        organizationIds: [ORG_1],
        isPlatformAdmin: true,
      };

      const orgHeld = computeHeldApiKeyPermissions({
        authorization: auth,
        scopeType: 'organization',
        selectedOrgId: ORG_1,
      });

      // 1. Must include valid organization-admitted permissions
      assert.ok(orgHeld.has('api_keys.read'));
      assert.ok(orgHeld.has('api_keys.create'));
      assert.ok(orgHeld.has('workspaces.read'));
      assert.ok(orgHeld.has('audit.read'));

      // 2. Must strictly exclude platform-only permissions
      assert.equal(
        orgHeld.has('platform.tenants.manage'),
        false,
        'Platform-only permissions must not be held for org-bound API keys',
      );
      assert.equal(
        orgHeld.has('platform.roles.assign'),
        false,
        'platform.roles.assign must not be held for org-bound API keys',
      );
      assert.equal(
        orgHeld.has('platform.roles.delegate_tenant'),
        false,
        'platform.roles.delegate_tenant must not be held for org-bound API keys',
      );
      assert.equal(
        orgHeld.has('platform.audit.read'),
        false,
        'platform.audit.read must not be held for org-bound API keys',
      );

      // 3. Must strictly exclude tenant-content permissions
      const contentKeys = ALL_PERMISSION_KEYS.filter((k) => isTenantContentPermission(k));
      for (const k of contentKeys) {
        assert.equal(
          orgHeld.has(k),
          false,
          `Tenant-content permission ${k} must never be held by platform admin for API key`,
        );
      }

      // 4. Every permission present in orgHeld must satisfy permissionAllowedAt(p, 'organization')
      for (const p of orgHeld) {
        assert.ok(
          permissionAllowedAt(p, 'organization'),
          `Permission ${p} in orgHeld must be admitted at organization scope`,
        );
        assert.ok(
          SUPER_ADMIN_PERMISSIONS.includes(p as never),
          `Permission ${p} must belong to SUPER_ADMIN_PERMISSIONS`,
        );
      }
    });

    it('SEC-07.12: organization-only permissions are strictly excluded for workspace-bound keys', () => {
      const auth: EffectiveAuthorization = {
        actorType: 'user',
        userId: 'admin-1',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-org-admin',
            roleKey: 'org_admin',
            scopeType: 'organization',
            scopeId: ORG_1,
            orgId: ORG_1,
            permissions: [
              'workspaces.read',
              'workspaces.create',
              'templates.read', // organization-only
              'templates.manage', // organization-only
              'suppressions.read', // organization-only
              'suppressions.manage', // organization-only
              'contacts.read', // admitted at organization and workspace
            ],
          },
        ],
        organizationIds: [ORG_1],
        isPlatformAdmin: false,
      };

      // When scopeType is organization: templates and suppressions are included
      const orgHeld = computeHeldApiKeyPermissions({
        authorization: auth,
        scopeType: 'organization',
        selectedOrgId: ORG_1,
      });
      assert.ok(orgHeld.has('templates.read'));
      assert.ok(orgHeld.has('templates.manage'));
      assert.ok(orgHeld.has('suppressions.read'));
      assert.ok(orgHeld.has('suppressions.manage'));
      assert.ok(orgHeld.has('workspaces.read'));
      assert.ok(orgHeld.has('contacts.read'));

      // When scopeType is workspace: organization-only permissions MUST be excluded
      const wsHeld = computeHeldApiKeyPermissions({
        authorization: auth,
        scopeType: 'workspace',
        selectedOrgId: ORG_1,
        workspaceId: WS_1,
      });

      assert.equal(
        wsHeld.has('templates.read'),
        false,
        'templates.read must not be permitted on workspace-bound keys',
      );
      assert.equal(
        wsHeld.has('templates.manage'),
        false,
        'templates.manage must not be permitted on workspace-bound keys',
      );
      assert.equal(
        wsHeld.has('suppressions.read'),
        false,
        'suppressions.read must not be permitted on workspace-bound keys',
      );
      assert.equal(
        wsHeld.has('suppressions.manage'),
        false,
        'suppressions.manage must not be permitted on workspace-bound keys',
      );

      // Workspace-admitted permissions from the org grant are retained via downward inheritance
      assert.ok(wsHeld.has('workspaces.read'));
      assert.ok(wsHeld.has('contacts.read'));
    });

    it('SEC-07.13: workspace-scoped grants cover target workspace but not sibling workspace or organization', () => {
      const auth: EffectiveAuthorization = {
        actorType: 'user',
        userId: 'manager-1',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-ws-mgr',
            roleKey: 'workspace_manager',
            scopeType: 'workspace',
            scopeId: WS_1,
            orgId: ORG_1,
            permissions: ['workspaces.read', 'workspaces.update'],
          },
        ],
        organizationIds: [ORG_1],
        isPlatformAdmin: false,
      };

      // 1. Does not confer permissions at organization scope
      const orgHeld = computeHeldApiKeyPermissions({
        authorization: auth,
        scopeType: 'organization',
        selectedOrgId: ORG_1,
      });
      assert.equal(
        orgHeld.size,
        0,
        'Workspace grant must not confer organization-level permissions',
      );

      // 2. Confers permissions at matching target workspace WS_1
      const ws1Held = computeHeldApiKeyPermissions({
        authorization: auth,
        scopeType: 'workspace',
        selectedOrgId: ORG_1,
        workspaceId: WS_1,
      });
      assert.ok(ws1Held.has('workspaces.read'));
      assert.ok(ws1Held.has('workspaces.update'));

      // 3. Does not confer permissions at sibling workspace WS_2
      const ws2Held = computeHeldApiKeyPermissions({
        authorization: auth,
        scopeType: 'workspace',
        selectedOrgId: ORG_1,
        workspaceId: WS_2,
      });
      assert.equal(
        ws2Held.size,
        0,
        'Workspace grant for WS_1 must not confer permissions for WS_2',
      );
    });

    it('SEC-07.14: foreign organization grants do not confer permissions', () => {
      const auth: EffectiveAuthorization = {
        actorType: 'user',
        userId: 'user-1',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-org-admin-2',
            roleKey: 'org_admin',
            scopeType: 'organization',
            scopeId: ORG_2,
            orgId: ORG_2,
            permissions: ['api_keys.create', 'workspaces.read'],
          },
        ],
        organizationIds: [ORG_1, ORG_2],
        isPlatformAdmin: false,
      };

      const org1Held = computeHeldApiKeyPermissions({
        authorization: auth,
        scopeType: 'organization',
        selectedOrgId: ORG_1,
      });
      assert.equal(org1Held.size, 0, 'Grants in ORG_2 must not confer permissions in ORG_1');
    });

    it('SEC-07.15: null authorization returns empty permission set (fail-closed)', () => {
      const held = computeHeldApiKeyPermissions({
        authorization: null,
        scopeType: 'organization',
        selectedOrgId: ORG_1,
      });
      assert.equal(held.size, 0);
    });
  });
});
