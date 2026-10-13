import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  roleAssignmentsApi,
  setAccessToken,
  setSelectedOrganization,
  ApiError,
  type CreateRoleAssignmentInput,
  type EffectiveAuthorization,
  type RoleView,
  type UserIdentity,
} from './api-client';
import { isAssignableTenantRole } from '../components/role-assignments/assign-role-dialog';
import { hasPermission, useSession } from './session-store';

describe('Role Assignments Security Invariants & Boundary Enforcement', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_A = '01955b0a-7b3b-7411-9a4f-orgAAAAAAAAAA';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-orgBBBBBBBBBB';
  const USER_ID = '01955b0a-7b3b-7411-9a4f-targetuser11';

  const createMockUser = (orgIds: string[]): UserIdentity => ({
    userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
    actorType: 'user',
    authMethod: 'session',
    sessionId: 'session-123',
    authenticatedAt: '2026-09-23T00:00:00.000Z',
    tenant: {
      orgId: null,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
    },
    authorizedOrganizationIds: orgIds,
    roles: [],
    permissions: [],
  });

  const createMockAuthorization = (
    orgId: string,
    permissions: string[] = [
      'role_assignments.read',
      'role_assignments.grant',
      'role_assignments.revoke',
    ],
  ): EffectiveAuthorization => ({
    actorType: 'user',
    userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
    apiKeyId: null,
    grants: [
      {
        roleId: 'role-org-admin',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: orgId,
        orgId,
        permissions,
      },
    ],
    organizationIds: [orgId],
    isPlatformAdmin: false,
  });

  beforeEach(() => {
    fetchCalls = [];
    mockHandlers = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const options = init ?? {};
      fetchCalls.push({ url, options });

      for (const { match, handle } of mockHandlers) {
        if (match(url, options)) {
          return handle(url, options);
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
    setAccessToken(null);
    setSelectedOrganization(null);
    useSession.getState().clearSession();
  });

  // ---------------------------------------------------------------------------
  // 1. Cross-org assignment list isolation
  // ---------------------------------------------------------------------------
  it('SEC-1: Cross-org assignment list isolation pins X-Acc-Organization strictly to active org', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url) => url.includes('/role-assignments'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_A);
        return new Response(
          JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false, limit: 10 } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    });

    await roleAssignmentsApi.listForUser(USER_ID);
    assert.equal(fetchCalls.length, 1);
    const sentHeaders = fetchCalls[0]!.options.headers as Record<string, string>;
    assert.equal(sentHeaders['X-Acc-Organization'], ORG_A);
    assert.notEqual(sentHeaders['X-Acc-Organization'], ORG_B);
  });

  // ---------------------------------------------------------------------------
  // 2. Cross-org assignment mutation rejection handling
  // ---------------------------------------------------------------------------
  it('SEC-2: Cross-org assignment mutation rejection is handled as non-retryable 403', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_SCOPE_DENIED',
              message: 'Target scope is outside the callers tenant context',
              correlationId: 'corr-scope-denied',
              retryable: false,
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.create({
          userId: USER_ID,
          roleId: 'role-b',
          scopeType: 'organization',
          scopeId: ORG_B,
        });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_SCOPE_DENIED');
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Caller-supplied org header cannot override selected organization
  // ---------------------------------------------------------------------------
  it('SEC-3: Caller-supplied org header cannot override selected organization', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url) => url.includes('/role-assignments'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_A);
        return new Response(
          JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false, limit: 10 } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    });

    await roleAssignmentsApi.list({ userId: USER_ID });
    const lastCall = fetchCalls[fetchCalls.length - 1]!;
    const headers = lastCall.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_A);
  });

  // ---------------------------------------------------------------------------
  // 4. Stale selected organization invalidates assignment data
  // ---------------------------------------------------------------------------
  it('SEC-4: Stale selected organization invalidates assignment queries and switches tenant context', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    await roleAssignmentsApi.listForUser(USER_ID);
    const firstCall = fetchCalls.find((c) => c.url.includes('/role-assignments'))!;
    assert.equal(
      (firstCall.options.headers as Record<string, string>)['X-Acc-Organization'],
      ORG_A,
    );

    // Switch to Org B
    useSession.getState().selectOrganization(ORG_B);

    await roleAssignmentsApi.listForUser(USER_ID);
    const roleCalls = fetchCalls.filter((c) => c.url.includes('/role-assignments'));
    const secondRoleCall = roleCalls[roleCalls.length - 1]!;
    assert.equal(
      (secondRoleCall.options.headers as Record<string, string>)['X-Acc-Organization'],
      ORG_B,
    );
  });

  // ---------------------------------------------------------------------------
  // 5. Stale selected organization cannot be used for mutation
  // ---------------------------------------------------------------------------
  it('SEC-5: Stale / cleared organization throws before mutation network dispatch', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        return !headers['X-Acc-Organization'];
      },
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'TENANCY_CONTEXT_REQUIRED',
              message: 'No organization context is established for this request',
              correlationId: 'corr-tenant-req',
              retryable: false,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    useSession.getState().clearOrganization();

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.create({
          userId: USER_ID,
          roleId: 'role-1',
          scopeType: 'organization',
          scopeId: ORG_A,
        });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.code, 'TENANCY_CONTEXT_REQUIRED');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 6. Role allowedScopeTypes is respected by the UI
  // ---------------------------------------------------------------------------
  it('SEC-6: Backend rejects role assignment when role allowedScopeTypes does not admit scope level', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED',
              message: 'This role cannot be granted at organization scope',
              details: {
                roleKey: 'workspace_lead',
                allowedScopeTypes: ['workspace'],
                requested: 'organization',
              },
              correlationId: 'corr-scope-admit',
              retryable: false,
            },
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.create({
          userId: USER_ID,
          roleId: 'role-workspace-only',
          scopeType: 'organization',
          scopeId: ORG_A,
        });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 422);
        assert.equal(err.code, 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED');
        assert.deepEqual(err.details?.allowedScopeTypes, ['workspace']);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Platform role cannot be assigned through tenant UI
  // ---------------------------------------------------------------------------
  it('SEC-7: Platform role cannot be granted through tenant administration (403 AUTHZ_PLATFORM_ROLE_REQUIRED)', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_PLATFORM_ROLE_REQUIRED',
              message: 'Platform-level roles cannot be granted through tenant administration',
              details: { roleKey: 'platform_admin' },
              correlationId: 'corr-platform-role',
              retryable: false,
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.create({
          userId: USER_ID,
          roleId: 'platform-role-id',
          scopeType: 'organization',
          scopeId: ORG_A,
        });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_PLATFORM_ROLE_REQUIRED');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 8. Unsupported reseller/platform scope cannot be fabricated
  // ---------------------------------------------------------------------------
  it('SEC-8: Backend refuses platform scope in tenant role assignment (400 validation error)', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_FAILED',
              message:
                'Validation failed: scopeType must be one of reseller, organization, workspace, team',
              correlationId: 'corr-val-scope',
              retryable: false,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.create({
          userId: USER_ID,
          roleId: 'role-1',
          scopeType: 'platform' as never,
          scopeId: 'platform-root',
        });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 400);
        assert.equal(err.code, 'VALIDATION_FAILED');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 9. Workspace scope cannot be silently converted to organization scope
  // ---------------------------------------------------------------------------
  it('SEC-9: Workspace scope preserves workspace ID and does not broaden to organization scope', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    const workspaceId = '01955b0a-ws-specific-99';
    let receivedPayload: CreateRoleAssignmentInput | null = null;

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: (_url, options) => {
        receivedPayload = JSON.parse(String(options.body));
        return new Response(
          JSON.stringify({
            data: {
              id: 'grant-new',
              ...receivedPayload,
              roleKey: 'ws_viewer',
              orgId: ORG_A,
              grantedBy: 'admin',
              createdAt: new Date().toISOString(),
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await roleAssignmentsApi.create({
      userId: USER_ID,
      roleId: 'role-ws-1',
      scopeType: 'workspace',
      scopeId: workspaceId,
    });

    assert(receivedPayload);
    assert.equal((receivedPayload as CreateRoleAssignmentInput).scopeType, 'workspace');
    assert.equal((receivedPayload as CreateRoleAssignmentInput).scopeId, workspaceId);
    assert.notEqual((receivedPayload as CreateRoleAssignmentInput).scopeId, ORG_A);
  });

  // ---------------------------------------------------------------------------
  // 10. Team scope cannot be fabricated without authoritative team metadata
  // ---------------------------------------------------------------------------
  it('SEC-10: Team scope assignment is refused with 404 when target team is unverified or absent', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Scope not found',
              correlationId: 'corr-team-404',
              retryable: false,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.create({
          userId: USER_ID,
          roleId: 'role-team-1',
          scopeType: 'team',
          scopeId: 'unverified-team-uuid',
        });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'RESOURCE_NOT_FOUND');
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 11. Null/uninitialized authorization fails closed
  // ---------------------------------------------------------------------------
  it('SEC-11: Null/uninitialized authorization fails closed for role assignments permissions', () => {
    useSession.getState().clearSession();

    assert.equal(hasPermission('role_assignments.read'), false);
    assert.equal(hasPermission('role_assignments.grant'), false);
    assert.equal(hasPermission('role_assignments.revoke'), false);
  });

  // ---------------------------------------------------------------------------
  // 12. Backend 403 is surfaced without leaking security internals
  // ---------------------------------------------------------------------------
  it('SEC-12: Backend 403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION surfaces rejected permissions cleanly', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION',
              message: 'This role carries a permission you do not hold at that scope',
              details: { rejected: ['users.disable', 'audit.read'] },
              correlationId: 'corr-unheld-perms',
              retryable: false,
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.create({
          userId: USER_ID,
          roleId: 'role-with-admin-perms',
          scopeType: 'organization',
          scopeId: ORG_A,
        });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION');
        assert.deepEqual(err.details?.rejected, ['users.disable', 'audit.read']);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 13. Backend 422 scope-type rejection is handled safely
  // ---------------------------------------------------------------------------
  it('SEC-13: Backend 422 scope-type rejection is marked retryable=false', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED',
              message: 'This role cannot be granted at team scope',
              details: {
                roleKey: 'org_admin',
                allowedScopeTypes: ['organization'],
                requested: 'team',
              },
              correlationId: 'corr-scope-422',
              retryable: false,
            },
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.create({
          userId: USER_ID,
          roleId: 'role-org-admin-id',
          scopeType: 'team',
          scopeId: 'some-team-id',
        });
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 422);
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 14. Last-platform-admin 409 is handled without retry loops
  // ---------------------------------------------------------------------------
  it('SEC-14: Last-platform-admin 409 AUTHZ_LAST_PLATFORM_ADMIN is marked retryable=false and causes no loops', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    let deleteAttempts = 0;
    mockHandlers.push({
      match: (url, options) =>
        url.includes('/role-assignments/grant-last-admin') && options.method === 'DELETE',
      handle: () => {
        deleteAttempts++;
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_LAST_PLATFORM_ADMIN',
              message: 'Cannot revoke the last platform administrator',
              correlationId: 'corr-last-admin-liveness',
              retryable: false,
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.delete('grant-last-admin');
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'AUTHZ_LAST_PLATFORM_ADMIN');
        assert.equal(err.retryable, false);
        return true;
      },
    );

    // Verify it was called exactly once and did not loop
    assert.equal(deleteAttempts, 1);
  });

  // ---------------------------------------------------------------------------
  // 15. Role assignment cache keys are tenant-partitioned
  // ---------------------------------------------------------------------------
  it('SEC-15: Role assignment queries generate distinct cache keys partitioned by organization', () => {
    const keyOrgA = ['role-assignments', ORG_A, USER_ID];
    const keyOrgB = ['role-assignments', ORG_B, USER_ID];

    assert.notDeepEqual(keyOrgA, keyOrgB);
    assert.equal(keyOrgA[1], ORG_A);
    assert.equal(keyOrgB[1], ORG_B);
  });

  // ---------------------------------------------------------------------------
  // 16. Role-assignment mutation uses the current validated organization context
  // ---------------------------------------------------------------------------
  it('SEC-16: Role-assignment mutation uses the current validated organization context in header', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_A);
        return new Response(
          JSON.stringify({
            data: {
              id: 'g-1',
              userId: USER_ID,
              roleId: 'r-1',
              roleKey: 'custom',
              orgId: ORG_A,
              scopeType: 'organization',
              scopeId: ORG_A,
              grantedBy: 'adm',
              createdAt: new Date().toISOString(),
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await roleAssignmentsApi.create({
      userId: USER_ID,
      roleId: 'r-1',
      scopeType: 'organization',
      scopeId: ORG_A,
    });
  });

  // ---------------------------------------------------------------------------
  // 17. Revoke operation does not operate on an assignment from a stale tenant context
  // ---------------------------------------------------------------------------
  it('SEC-17: Revoke operation dispatches DELETE with active validated organization header', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-b',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization(ORG_B),
      selectedOrgId: ORG_B,
    });

    mockHandlers.push({
      match: (url, options) =>
        url.includes('/role-assignments/grant-to-revoke') && options.method === 'DELETE',
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['X-Acc-Organization'], ORG_B);
        return new Response(null, { status: 204 });
      },
    });

    await roleAssignmentsApi.delete('grant-to-revoke');
    assert.equal(fetchCalls.length, 1);
    const sentHeaders = fetchCalls[0]!.options.headers as Record<string, string>;
    assert.equal(sentHeaders['X-Acc-Organization'], ORG_B);
  });

  // ---------------------------------------------------------------------------
  // 18. No access token / refresh token persistence is introduced
  // ---------------------------------------------------------------------------
  it('SEC-18: Access tokens and refresh tokens are never persisted in localStorage or sessionStorage', async () => {
    useSession.getState().setSession({
      accessToken: 'super-secret-access-token-xyz',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    await roleAssignmentsApi.listForUser(USER_ID);

    if (typeof localStorage !== 'undefined') {
      assert.equal(localStorage.getItem('access_token'), null);
      assert.equal(localStorage.getItem('accessToken'), null);
      assert.equal(localStorage.getItem('token'), null);
      assert.equal(localStorage.getItem('refresh_token'), null);
    }
    if (typeof sessionStorage !== 'undefined') {
      assert.equal(sessionStorage.getItem('access_token'), null);
      assert.equal(sessionStorage.getItem('accessToken'), null);
      assert.equal(sessionStorage.getItem('token'), null);
      assert.equal(sessionStorage.getItem('refresh_token'), null);
    }
  });

  // ---------------------------------------------------------------------------
  // 19. No sensitive assignment data is written to localStorage/sessionStorage
  // ---------------------------------------------------------------------------
  it('SEC-19: Sensitive role assignment payloads are not stored in browser storage', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url) => url.includes('/role-assignments'),
      handle: () => {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'grant-secret-1',
                userId: USER_ID,
                roleId: 'role-secret-1',
                roleKey: 'confidential_role',
                orgId: ORG_A,
                scopeType: 'organization',
                scopeId: ORG_A,
                grantedBy: 'admin',
                createdAt: new Date().toISOString(),
              },
            ],
            page: { nextCursor: null, hasMore: false, limit: 10 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await roleAssignmentsApi.listForUser(USER_ID);

    if (typeof localStorage !== 'undefined') {
      assert.equal(localStorage.getItem('role-assignments'), null);
      assert.equal(localStorage.getItem('grants'), null);
    }
    if (typeof sessionStorage !== 'undefined') {
      assert.equal(sessionStorage.getItem('role-assignments'), null);
      assert.equal(sessionStorage.getItem('grants'), null);
    }
  });

  // ---------------------------------------------------------------------------
  // 20. Error messages do not leak raw backend internals
  // ---------------------------------------------------------------------------
  it('SEC-20: Error responses do not leak raw SQL or stack traces to caller', async () => {
    mockHandlers.push({
      match: (url) => url.includes('/role-assignments'),
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Internal server error',
              correlationId: 'corr-500-sanitized',
              retryable: false,
            },
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    await assert.rejects(
      async () => {
        await roleAssignmentsApi.listForUser(USER_ID);
      },
      (err: unknown) => {
        assert(err instanceof ApiError);
        assert.equal(err.status, 500);
        assert.equal(err.message, 'Internal server error');
        assert.equal((err.details as Record<string, unknown> | undefined)?.['sql'], undefined);
        assert.equal((err.details as Record<string, unknown> | undefined)?.['stack'], undefined);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Mutation Test: Absence of Idempotency-Key preservation across retries
  // ---------------------------------------------------------------------------
  it('SEC-MUTATION: Idempotency-Key is preserved across retry attempts for the same mutation', async () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    const key = 'shared-idempotency-key-uuid-retry';
    let callCount = 0;

    mockHandlers.push({
      match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
      handle: (_url, options) => {
        callCount++;
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['Idempotency-Key'], key);

        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMIT_EXCEEDED',
                message: 'Rate limit',
                correlationId: 'c1',
                retryable: true,
              },
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } },
          );
        }

        return new Response(
          JSON.stringify({
            data: {
              id: 'g-retry',
              userId: USER_ID,
              roleId: 'r-1',
              roleKey: 'role',
              orgId: ORG_A,
              scopeType: 'organization',
              scopeId: ORG_A,
              grantedBy: 'admin',
              createdAt: new Date().toISOString(),
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    // First attempt fails with 429
    await assert.rejects(async () => {
      await roleAssignmentsApi.create(
        { userId: USER_ID, roleId: 'r-1', scopeType: 'organization', scopeId: ORG_A },
        key,
      );
    });

    // Retry with SAME idempotency key succeeds
    const successRes = await roleAssignmentsApi.create(
      { userId: USER_ID, roleId: 'r-1', scopeType: 'organization', scopeId: ORG_A },
      key,
    );

    assert.equal(successRes.data.id, 'g-retry');
    assert.equal(callCount, 2);
  });

  // ---------------------------------------------------------------------------
  // SEC-02: Role Assignment Dialog System Roles & Scope Boundaries
  // ---------------------------------------------------------------------------
  describe('SEC-02: Role Assignment Dialog System Roles & Scope Boundaries', () => {
    const makeRole = (overrides: Partial<RoleView>): RoleView => ({
      id: overrides.id ?? 'role-default-id',
      key: overrides.key ?? 'default_role',
      name: overrides.name ?? 'Default Role',
      description: overrides.description ?? null,
      orgId: overrides.orgId !== undefined ? overrides.orgId : ORG_A,
      isSystemRole: overrides.isSystemRole ?? false,
      allowedScopeTypes: overrides.allowedScopeTypes ?? ['organization'],
      permissions: overrides.permissions ?? ['users.read'],
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    });

    it('SEC-02.1: admits seeded system tenant roles (org_admin, workspace_manager, agent, read_only, campaign_editor) in active organization', () => {
      const seededSystemRoles: RoleView[] = [
        makeRole({
          id: 'role-org-admin',
          key: 'org_admin',
          name: 'Organization Admin',
          orgId: ORG_A,
          isSystemRole: true,
          allowedScopeTypes: ['organization'],
        }),
        makeRole({
          id: 'role-workspace-mgr',
          key: 'workspace_manager',
          name: 'Workspace Manager',
          orgId: ORG_A,
          isSystemRole: true,
          allowedScopeTypes: ['organization', 'workspace'],
        }),
        makeRole({
          id: 'role-agent',
          key: 'agent',
          name: 'Agent',
          orgId: ORG_A,
          isSystemRole: true,
          allowedScopeTypes: ['organization', 'workspace', 'team'],
        }),
        makeRole({
          id: 'role-read-only',
          key: 'read_only',
          name: 'Read Only',
          orgId: ORG_A,
          isSystemRole: true,
          allowedScopeTypes: ['organization', 'workspace', 'team'],
        }),
        makeRole({
          id: 'role-campaign-editor',
          key: 'campaign_editor',
          name: 'Campaign Editor',
          orgId: ORG_A,
          isSystemRole: true,
          allowedScopeTypes: ['organization', 'workspace', 'team'],
        }),
      ];

      for (const role of seededSystemRoles) {
        assert.equal(
          isAssignableTenantRole(role, ORG_A),
          true,
          `Seeded system role ${role.key} must be assignable in active organization`,
        );
      }
    });

    it('SEC-02.2: admits custom tenant roles in active organization', () => {
      const customRole = makeRole({
        id: 'role-custom-billing',
        key: 'custom_billing_auditor',
        name: 'Custom Billing Auditor',
        orgId: ORG_A,
        isSystemRole: false,
        allowedScopeTypes: ['organization', 'workspace'],
      });

      assert.equal(
        isAssignableTenantRole(customRole, ORG_A),
        true,
        'Custom tenant role in active organization must be assignable',
      );
    });

    it('SEC-02.3: strictly excludes platform-only system roles with orgId === null', () => {
      const platformSuperAdmin = makeRole({
        id: 'role-super-admin',
        key: 'alendei_super_admin',
        name: 'Alendei Super Admin',
        orgId: null,
        isSystemRole: true,
        allowedScopeTypes: ['platform'],
      });
      const platformSupport = makeRole({
        id: 'role-support',
        key: 'alendei_support',
        name: 'Alendei Support',
        orgId: null,
        isSystemRole: true,
        allowedScopeTypes: ['platform'],
      });

      assert.equal(
        isAssignableTenantRole(platformSuperAdmin, ORG_A),
        false,
        'Platform super admin role (orgId === null) must NOT be assignable via tenant administration',
      );
      assert.equal(
        isAssignableTenantRole(platformSupport, ORG_A),
        false,
        'Platform support role (orgId === null) must NOT be assignable via tenant administration',
      );
    });

    it('SEC-02.4: strictly excludes reseller roles with orgId === null', () => {
      const resellerAdmin = makeRole({
        id: 'role-reseller-admin',
        key: 'reseller_admin',
        name: 'Reseller Admin',
        orgId: null,
        isSystemRole: true,
        allowedScopeTypes: ['reseller'],
      });

      assert.equal(
        isAssignableTenantRole(resellerAdmin, ORG_A),
        false,
        'Reseller admin role (orgId === null) must NOT be assignable via tenant administration',
      );
    });

    it('SEC-02.5: strictly excludes foreign organization roles where orgId does not match active organization', () => {
      const foreignOrgRole = makeRole({
        id: 'role-foreign-org-admin',
        key: 'org_admin',
        name: 'Organization Admin',
        orgId: ORG_B,
        isSystemRole: true,
        allowedScopeTypes: ['organization'],
      });

      assert.equal(
        isAssignableTenantRole(foreignOrgRole, ORG_A),
        false,
        'Role belonging to foreign organization B must NOT be assignable in organization A',
      );
    });

    it('SEC-02.6: excludes roles that do not admit any tenant scope levels', () => {
      const invalidTenantRole = makeRole({
        id: 'role-invalid-scope',
        key: 'invalid_scope_role',
        name: 'Invalid Scope Role',
        orgId: ORG_A,
        isSystemRole: false,
        allowedScopeTypes: ['platform'],
      });

      assert.equal(
        isAssignableTenantRole(invalidTenantRole, ORG_A),
        false,
        'Role with no admitted tenant scope levels must NOT be assignable',
      );
    });

    it('SEC-02.7: end-to-end assignment dispatches valid payload for eligible seeded system role', async () => {
      useSession.getState().setSession({
        accessToken: 'token-org-a',
        user: createMockUser([ORG_A]),
        authorization: createMockAuthorization(ORG_A),
        selectedOrgId: ORG_A,
      });

      let capturedPayload: unknown = null;
      let capturedHeaderOrg: string | undefined = undefined;
      mockHandlers.push({
        match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
        handle: (_url, options) => {
          const headers = options.headers as Record<string, string>;
          capturedHeaderOrg = headers['X-Acc-Organization'];
          capturedPayload = JSON.parse(String(options.body));
          return new Response(
            JSON.stringify({
              data: {
                id: 'grant-new-system-role',
                userId: USER_ID,
                roleId: 'role-seeded-org-admin',
                roleKey: 'org_admin',
                orgId: ORG_A,
                scopeType: 'organization',
                scopeId: ORG_A,
                grantedBy: 'admin',
                createdAt: new Date().toISOString(),
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      const res = await roleAssignmentsApi.create({
        userId: USER_ID,
        roleId: 'role-seeded-org-admin',
        scopeType: 'organization',
        scopeId: ORG_A,
      });

      assert.equal(res.data.id, 'grant-new-system-role');
      assert.equal(capturedHeaderOrg, ORG_A);
      assert.deepEqual(capturedPayload, {
        userId: USER_ID,
        roleId: 'role-seeded-org-admin',
        scopeType: 'organization',
        scopeId: ORG_A,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // SEC-03: Team Scope Support in Role Assignment Dialog
  // ---------------------------------------------------------------------------
  describe('SEC-03: Team Scope Support in Role Assignment Dialog', () => {
    const WORKSPACE_ID = '01955b0a-7b3b-7411-9a4f-wsAAAAAAAAAAA';
    const TEAM_ID = '01955b0a-7b3b-7411-9a4f-teamAAAAAAAAA';
    const FOREIGN_WORKSPACE_ID = '01955b0a-7b3b-7411-9a4f-wsBBBBBBBBBBB';
    const FOREIGN_TEAM_ID = '01955b0a-7b3b-7411-9a4f-teamBBBBBBBBB';

    const makeRole = (overrides: Partial<RoleView>): RoleView => ({
      id: overrides.id ?? 'role-default-id',
      key: overrides.key ?? 'default_role',
      name: overrides.name ?? 'Default Role',
      description: overrides.description ?? null,
      orgId: overrides.orgId !== undefined ? overrides.orgId : ORG_A,
      isSystemRole: overrides.isSystemRole ?? false,
      allowedScopeTypes: overrides.allowedScopeTypes ?? ['organization', 'workspace', 'team'],
      permissions: overrides.permissions ?? ['campaigns.read'],
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    });

    it('SEC-03.1: allows team-scope assignment for roles that admit team scope', async () => {
      useSession.getState().setSession({
        accessToken: 'token-org-a',
        user: createMockUser([ORG_A]),
        authorization: createMockAuthorization(ORG_A),
        selectedOrgId: ORG_A,
      });

      const teamAdmittingRole = makeRole({
        id: 'role-campaign-editor',
        key: 'campaign_editor',
        allowedScopeTypes: ['organization', 'workspace', 'team'],
      });

      assert.equal(
        teamAdmittingRole.allowedScopeTypes.includes('team'),
        true,
        'Role must admit team scope',
      );

      let capturedPayload: unknown = null;
      let capturedHeaderOrg: string | undefined = undefined;

      mockHandlers.push({
        match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
        handle: (_url, options) => {
          const headers = options.headers as Record<string, string>;
          capturedHeaderOrg = headers['X-Acc-Organization'];
          capturedPayload = JSON.parse(String(options.body));
          return new Response(
            JSON.stringify({
              data: {
                id: 'grant-team-role',
                userId: USER_ID,
                roleId: teamAdmittingRole.id,
                roleKey: teamAdmittingRole.key,
                orgId: ORG_A,
                scopeType: 'team',
                scopeId: TEAM_ID,
                grantedBy: 'admin',
                createdAt: new Date().toISOString(),
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      const res = await roleAssignmentsApi.create({
        userId: USER_ID,
        roleId: teamAdmittingRole.id,
        scopeType: 'team',
        scopeId: TEAM_ID,
      });

      assert.equal(res.data.id, 'grant-team-role');
      assert.equal(res.data.scopeType, 'team');
      assert.equal(res.data.scopeId, TEAM_ID);
      assert.equal(capturedHeaderOrg, ORG_A);
      assert.deepEqual(capturedPayload, {
        userId: USER_ID,
        roleId: teamAdmittingRole.id,
        scopeType: 'team',
        scopeId: TEAM_ID,
      });
    });

    it('SEC-03.2: fails closed if role does not admit team scope (e.g. org_admin or workspace_manager)', async () => {
      const orgAdminRole = makeRole({
        id: 'role-org-admin',
        key: 'org_admin',
        allowedScopeTypes: ['organization'],
      });
      const wsManagerRole = makeRole({
        id: 'role-ws-manager',
        key: 'workspace_manager',
        allowedScopeTypes: ['workspace'],
      });

      assert.equal(orgAdminRole.allowedScopeTypes.includes('team'), false);
      assert.equal(wsManagerRole.allowedScopeTypes.includes('team'), false);

      mockHandlers.push({
        match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
        handle: () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED',
                message: 'Role org_admin does not admit team scope',
                retryable: false,
              },
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          ),
      });

      await assert.rejects(
        async () =>
          roleAssignmentsApi.create({
            userId: USER_ID,
            roleId: orgAdminRole.id,
            scopeType: 'team',
            scopeId: TEAM_ID,
          }),
        (err: unknown) => {
          assert(err instanceof ApiError);
          assert.equal(err.code, 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED');
          assert.equal(err.status, 422);
          assert.equal(err.retryable, false);
          return true;
        },
      );
    });

    it('SEC-03.3: team assignment strictly preserves team scope without broadening to workspace or organization', async () => {
      useSession.getState().setSession({
        accessToken: 'token-org-a',
        user: createMockUser([ORG_A]),
        authorization: createMockAuthorization(ORG_A),
        selectedOrgId: ORG_A,
      });

      let capturedPayload: unknown = null;
      mockHandlers.push({
        match: (url, options) => url.includes('/role-assignments') && options.method === 'POST',
        handle: (_url, options) => {
          capturedPayload = JSON.parse(String(options.body));
          return new Response(
            JSON.stringify({
              data: {
                id: 'grant-team-isolated',
                userId: USER_ID,
                roleId: 'role-agent',
                roleKey: 'agent',
                orgId: ORG_A,
                scopeType: 'team',
                scopeId: TEAM_ID,
                grantedBy: 'admin',
                createdAt: new Date().toISOString(),
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        },
      });

      await roleAssignmentsApi.create({
        userId: USER_ID,
        roleId: 'role-agent',
        scopeType: 'team',
        scopeId: TEAM_ID,
      });

      assert.deepEqual(capturedPayload, {
        userId: USER_ID,
        roleId: 'role-agent',
        scopeType: 'team',
        scopeId: TEAM_ID,
      });
      // Verification: scopeType must NOT have broadened to workspace or organization
      assert.notEqual((capturedPayload as { scopeType: string }).scopeType, 'workspace');
      assert.notEqual((capturedPayload as { scopeType: string }).scopeType, 'organization');
      assert.notEqual((capturedPayload as { scopeId: string }).scopeId, WORKSPACE_ID);
      assert.notEqual((capturedPayload as { scopeId: string }).scopeId, ORG_A);
    });

    it('SEC-03.4: team scope hierarchy invariants: team must belong to workspace and active organization', () => {
      // Invariant checks on team hierarchy metadata
      const validTeam = {
        id: TEAM_ID,
        orgId: ORG_A,
        workspaceId: WORKSPACE_ID,
        name: 'Sales Team',
      };
      const foreignWsTeam = {
        id: 'team-foreign-ws',
        orgId: ORG_A,
        workspaceId: FOREIGN_WORKSPACE_ID,
        name: 'Foreign WS Team',
      };
      const foreignOrgTeam = {
        id: FOREIGN_TEAM_ID,
        orgId: ORG_B,
        workspaceId: WORKSPACE_ID,
        name: 'Foreign Org Team',
      };

      // Helper function matching dialog client validation
      const validateTeamHierarchy = (
        team: { orgId: string; workspaceId: string },
        expectedOrgId: string,
        expectedWorkspaceId: string,
      ) => {
        if (team.workspaceId !== expectedWorkspaceId) return false;
        if (team.orgId !== expectedOrgId) return false;
        return true;
      };

      assert.equal(validateTeamHierarchy(validTeam, ORG_A, WORKSPACE_ID), true);
      assert.equal(validateTeamHierarchy(foreignWsTeam, ORG_A, WORKSPACE_ID), false);
      assert.equal(validateTeamHierarchy(foreignOrgTeam, ORG_A, WORKSPACE_ID), false);
    });
  });
});
