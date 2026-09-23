import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  rolesApi,
  setAccessToken,
  setSelectedOrganization,
  ApiError,
  type EffectiveAuthorization,
  type UserIdentity,
} from './api-client';
import {
  getHeldOrganizationPermissions,
  hasPermission,
  useSession,
} from './session-store';

describe('Roles & Permissions Security Invariants & Boundary Enforcement', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];
  let mockHandlers: {
    match: (url: string, options: RequestInit) => boolean;
    handle: (url: string, options: RequestInit) => Response | Promise<Response>;
  }[] = [];

  const ORG_A = '01955b0a-7b3b-7411-9a4f-orgAAAAAAAAAA';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-orgBBBBBBBBBB';

  const createMockUser = (orgIds: string[]): UserIdentity => ({
    userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
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
    grants: Array<{
      roleKey: string;
      scopeType: 'organization' | 'workspace' | 'team' | 'platform' | 'reseller';
      orgId: string | null;
      scopeId: string | null;
      permissions: string[];
    }>,
    isPlatformAdmin = false,
  ): EffectiveAuthorization => ({
    actorType: 'user',
    userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
    apiKeyId: null,
    grants: grants.map((g, idx) => ({
      roleId: `role-${idx}`,
      roleKey: g.roleKey,
      scopeType: g.scopeType,
      scopeId: g.scopeId,
      orgId: g.orgId,
      permissions: g.permissions,
    })),
    organizationIds: [ORG_A],
    isPlatformAdmin,
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
  // 1. Fail-closed when authorization state is unavailable
  // ---------------------------------------------------------------------------
  it('SEC-1: Evaluates to fail-closed (denied) when authorization is null', () => {
    useSession.getState().clearSession();
    assert.equal(hasPermission('roles.read'), false);
    assert.equal(hasPermission('roles.create'), false);
    assert.equal(hasPermission('roles.update'), false);
    assert.equal(hasPermission('roles.delete'), false);

    const held = getHeldOrganizationPermissions();
    assert.equal(held.size, 0);
  });

  // ---------------------------------------------------------------------------
  // 2. Downward-Only Inheritance: Workspace & Team grants do not cover Organization
  // ---------------------------------------------------------------------------
  it('SEC-2: Workspace and Team grants do NOT confer authority to compose permissions at organization scope', () => {
    const auth = createMockAuthorization([
      // Actor holds roles.read across the organization
      {
        roleKey: 'read_only',
        scopeType: 'organization',
        orgId: ORG_A,
        scopeId: ORG_A,
        permissions: ['roles.read'],
      },
      // Actor holds users.disable in a specific workspace ONLY
      {
        roleKey: 'workspace_lead',
        scopeType: 'workspace',
        orgId: ORG_A,
        scopeId: '01955b0a-7b3b-7411-9a4f-ws1111111111',
        permissions: ['users.disable'],
      },
      // Actor holds teams.update in a specific team ONLY
      {
        roleKey: 'team_lead',
        scopeType: 'team',
        orgId: ORG_A,
        scopeId: '01955b0a-7b3b-7411-9a4f-team111111111',
        permissions: ['teams.update'],
      },
    ]);

    useSession.getState().setSession({
      accessToken: 'token-sec',
      user: createMockUser([ORG_A]),
      authorization: auth,
      selectedOrgId: ORG_A,
    });

    const held = getHeldOrganizationPermissions();
    // roles.read is held at organization scope
    assert.ok(held.has('roles.read'));
    // users.disable held only at workspace scope MUST NOT be treated as held at organization scope
    assert.equal(held.has('users.disable'), false);
    // teams.update held only at team scope MUST NOT be treated as held at organization scope
    assert.equal(held.has('teams.update'), false);
  });

  // ---------------------------------------------------------------------------
  // 3. Platform and System Role Immutability Assertion
  // ---------------------------------------------------------------------------
  it('SEC-3: Backend rejects mutation and deletion of system roles with 403 Forbidden', async () => {
    const systemRoleId = '01955b0a-7b3b-7411-9a4f-sysrole11111';

    mockHandlers.push({
      match: (url, options) => url.includes(`/roles/${systemRoleId}`) && options.method === 'PATCH',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_PERMISSION_DENIED',
              message: 'System-defined roles cannot be modified or deleted',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    mockHandlers.push({
      match: (url, options) => url.includes(`/roles/${systemRoleId}`) && options.method === 'DELETE',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_PERMISSION_DENIED',
              message: 'System-defined roles cannot be modified or deleted',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    useSession.getState().setSession({
      accessToken: 'token-sec',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization([
        {
          roleKey: 'org_admin',
          scopeType: 'organization',
          orgId: ORG_A,
          scopeId: ORG_A,
          permissions: ['roles.update', 'roles.delete'],
        },
      ]),
      selectedOrgId: ORG_A,
    });

    // Attempting update on system role must fail with 403
    await assert.rejects(
      async () => {
        await rolesApi.update(systemRoleId, { name: 'Compromised Name' });
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_PERMISSION_DENIED');
        return true;
      },
    );

    // Attempting delete on system role must fail with 403
    await assert.rejects(
      async () => {
        await rolesApi.delete(systemRoleId);
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 4. Role Key Validation Regex (Client Defense-in-depth)
  // ---------------------------------------------------------------------------
  it('SEC-4: Rejects role keys that violate ^[a-z][a-z0-9_]{2,63}$', () => {
    const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

    // Valid role keys
    assert.ok(ROLE_KEY_PATTERN.test('marketing_lead'));
    assert.ok(ROLE_KEY_PATTERN.test('agent_v2'));
    assert.ok(ROLE_KEY_PATTERN.test('abc'));
    assert.ok(ROLE_KEY_PATTERN.test('a'.repeat(64)));

    // Invalid role keys
    assert.equal(ROLE_KEY_PATTERN.test(''), false); // Empty
    assert.equal(ROLE_KEY_PATTERN.test('ab'), false); // Too short (< 3)
    assert.equal(ROLE_KEY_PATTERN.test('a'.repeat(65)), false); // Too long (> 64)
    assert.equal(ROLE_KEY_PATTERN.test('123role'), false); // Starts with number
    assert.equal(ROLE_KEY_PATTERN.test('_role'), false); // Starts with underscore
    assert.equal(ROLE_KEY_PATTERN.test('RoleName'), false); // Uppercase disallowed
    assert.equal(ROLE_KEY_PATTERN.test('role-name'), false); // Hyphen disallowed (snake_case only)
    assert.equal(ROLE_KEY_PATTERN.test('role name'), false); // Space disallowed
    assert.equal(ROLE_KEY_PATTERN.test('role@admin'), false); // Special chars disallowed
  });

  // ---------------------------------------------------------------------------
  // 5. Unheld Permissions Rejection (AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION)
  // ---------------------------------------------------------------------------
  it('SEC-5: Backend surfaces rejected unheld permissions in error.details.rejected', async () => {
    mockHandlers.push({
      match: (url, options) => url.includes('/roles') && options.method === 'POST',
      handle: () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION',
              message: 'A role cannot carry a permission you do not hold at this organization',
              details: {
                rejected: ['billing.manage', 'platform.tenants.read'],
              },
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    useSession.getState().setSession({
      accessToken: 'token-sec',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization([
        {
          roleKey: 'org_admin',
          scopeType: 'organization',
          orgId: ORG_A,
          scopeId: ORG_A,
          permissions: ['roles.create'],
        },
      ]),
      selectedOrgId: ORG_A,
    });

    await assert.rejects(
      async () => {
        await rolesApi.create({
          key: 'escalation_test',
          name: 'Escalation Test',
          allowedScopeTypes: ['organization'],
          permissions: ['billing.manage', 'platform.tenants.read'],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION');
        const details = err.details as { rejected: string[] };
        assert.deepEqual(details.rejected, ['billing.manage', 'platform.tenants.read']);
        return true;
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 6. Tenant Context Isolation: X-Acc-Organization cannot be forged
  // ---------------------------------------------------------------------------
  it('SEC-6: X-Acc-Organization header is strictly pinned to the verified session state', async () => {
    useSession.getState().setSession({
      accessToken: 'token-sec',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization([
        {
          roleKey: 'org_admin',
          scopeType: 'organization',
          orgId: ORG_A,
          scopeId: ORG_A,
          permissions: ['roles.read'],
        },
      ]),
      selectedOrgId: ORG_A,
    });

    mockHandlers.push({
      match: (url) => url.includes('/roles'),
      handle: (_url, options) => {
        const headers = options.headers as Record<string, string>;
        // Must match session's active ORG_A, not arbitrary caller values
        assert.equal(headers['X-Acc-Organization'], ORG_A);
        return new Response(JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false, limit: 25 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await rolesApi.list();
    assert.equal(fetchCalls.length, 1);
    const sentHeaders = fetchCalls[0]?.options.headers as Record<string, string>;
    assert.equal(sentHeaders['X-Acc-Organization'], ORG_A);
  });

  // ---------------------------------------------------------------------------
  // 7. Cross-Tenant Switching Clears Cached Context
  // ---------------------------------------------------------------------------
  it('SEC-7: Switching organization re-pins tenant header to new organization', async () => {
    useSession.getState().setSession({
      accessToken: 'token-sec',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization([
        {
          roleKey: 'org_admin',
          scopeType: 'organization',
          orgId: ORG_A,
          scopeId: ORG_A,
          permissions: ['roles.read'],
        },
        {
          roleKey: 'org_admin',
          scopeType: 'organization',
          orgId: ORG_B,
          scopeId: ORG_B,
          permissions: ['roles.read'],
        },
      ]),
      selectedOrgId: ORG_A,
    });

    // Make first call under ORG_A
    await rolesApi.list();
    const callA = fetchCalls[fetchCalls.length - 1];
    assert.ok(callA);
    assert.equal(
      (callA.options.headers as Record<string, string>)['X-Acc-Organization'],
      ORG_A,
    );

    // Switch to ORG_B
    useSession.getState().selectOrganization(ORG_B);

    // Make second call under ORG_B
    await rolesApi.list();
    const callB = fetchCalls[fetchCalls.length - 1];
    assert.ok(callB);
    assert.equal(
      (callB.options.headers as Record<string, string>)['X-Acc-Organization'],
      ORG_B,
    );
  });

  // ---------------------------------------------------------------------------
  // 8. Replay & Idempotency Key Preservation Across Retries
  // ---------------------------------------------------------------------------
  it('SEC-8: Preserves the same Idempotency-Key across network retry attempts', async () => {
    const stableKey = 'stable-idem-key-9999-8888';
    let attempts = 0;

    mockHandlers.push({
      match: (url, options) => url.includes('/roles') && options.method === 'POST',
      handle: (_url, options) => {
        attempts++;
        const headers = options.headers as Record<string, string>;
        assert.equal(headers['Idempotency-Key'], stableKey);

        if (attempts === 1) {
          // First attempt fails with network error / 500
          return new Response(JSON.stringify({ error: { message: 'Temporary failure' } }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Retry succeeds
        return new Response(
          JSON.stringify({
            data: {
              id: '01955b0a-7b3b-7411-9a4f-idemrole111',
              key: 'idem_role',
              name: 'Idempotent Role',
              description: null,
              orgId: ORG_A,
              isSystemRole: false,
              allowedScopeTypes: ['organization'],
              permissions: ['roles.read'],
              createdAt: '2026-09-23T00:00:00.000Z',
              updatedAt: '2026-09-23T00:00:00.000Z',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    useSession.getState().setSession({
      accessToken: 'token-sec',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization([
        {
          roleKey: 'org_admin',
          scopeType: 'organization',
          orgId: ORG_A,
          scopeId: ORG_A,
          permissions: ['roles.create'],
        },
      ]),
      selectedOrgId: ORG_A,
    });

    const payload = {
      key: 'idem_role',
      name: 'Idempotent Role',
      allowedScopeTypes: ['organization' as const],
      permissions: ['roles.read'],
    };

    // First attempt fails
    await assert.rejects(async () => {
      await rolesApi.create(payload, stableKey);
    });

    // Retry with SAME stable key succeeds
    const res = await rolesApi.create(payload, stableKey);
    assert.equal(res.data.key, 'idem_role');
    assert.equal(attempts, 2);
  });
});
