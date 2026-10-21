import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  messagesApi,
  setSelectedOrganization,
  registerOrgValidator,
  type EffectiveAuthorization,
  type UserIdentity,
} from './api-client';
import { useSession, canReadMessages } from './session-store';
import { humanizeApiError } from './error-mapping';

describe('SEC-MSG: Messages Security & RBAC Enforcement Tests', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options: RequestInit }[] = [];

  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';

  const resetSession = () => {
    useSession.setState({
      status: 'unauthenticated',
      user: null,
      authorization: null,
      selectedOrganizationId: null,
      authorizedOrganizationIds: [],
    });
    setSelectedOrganization(null);
    registerOrgValidator(null);
  };

  const setupSessionWithGrants = (
    selectedOrg: string | null,
    isPlatformAdmin: boolean,
    grants: EffectiveAuthorization['grants'],
  ) => {
    const user: UserIdentity = {
      userId: 'test-user-msg',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-msg-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: selectedOrg, workspaceId: null, resellerId: null, isPlatformAdmin },
      authorizedOrganizationIds: [ORG_A, ORG_B],
      roles: [],
      permissions: [],
    };

    const authorization: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-user-msg',
      apiKeyId: null,
      isPlatformAdmin,
      organizationIds: [ORG_A, ORG_B],
      grants,
    };

    useSession.setState({
      status: 'ready',
      user,
      authorization,
      selectedOrganizationId: selectedOrg,
      authorizedOrganizationIds: [ORG_A, ORG_B],
    });

    registerOrgValidator((id) => [ORG_A, ORG_B].includes(id));
    setSelectedOrganization(selectedOrg);
  };

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const options = init ?? {};
      fetchCalls.push({ url, options });
      return new Response(
        JSON.stringify({ data: [], page: { hasMore: false, nextCursor: null, limit: 25 } }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSession();
  });

  // --- 1. RBAC Grant Verification -------------------------------------------

  it('1. confers read permission to tenant org_admin holding messages.read on active organization', () => {
    setupSessionWithGrants(ORG_A, false, [
      {
        roleId: 'role-org-admin-a',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: ORG_A,
        orgId: ORG_A,
        permissions: ['messages.read'],
      },
    ]);

    assert.equal(canReadMessages(), true);
  });

  it('2. denies message read when caller lacks messages.read grant', () => {
    setupSessionWithGrants(ORG_A, false, [
      {
        roleId: 'role-readonly',
        roleKey: 'auditor',
        scopeType: 'organization',
        scopeId: ORG_A,
        orgId: ORG_A,
        permissions: ['audit.read'],
      },
    ]);

    assert.equal(canReadMessages(), false);
  });

  it('3. denies message access to Platform Super Admin without tenant-content grant (ADR-015 R-5)', () => {
    setupSessionWithGrants(ORG_A, true, [
      {
        roleId: 'role-super-admin',
        roleKey: 'alendei_super_admin',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions: ['platform.tenants.manage', 'providers.read'],
      },
    ]);

    assert.equal(canReadMessages(), false);
  });

  it('4. denies access when no organization context is active', () => {
    setupSessionWithGrants(null, false, [
      {
        roleId: 'role-org-admin-a',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: ORG_A,
        orgId: ORG_A,
        permissions: ['messages.read'],
      },
    ]);

    assert.equal(canReadMessages(), false);
  });

  it('5. enforces tenant isolation: Org B grant does not confer authority on Org A', () => {
    setupSessionWithGrants(ORG_A, false, [
      {
        roleId: 'role-org-admin-b',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: ORG_B,
        orgId: ORG_B,
        permissions: ['messages.read'],
      },
    ]);

    assert.equal(canReadMessages(), false);
  });

  // --- 2. Tenant Context Attachment ------------------------------------------

  it('6. messagesApi.list dispatches enforce authoritative X-Acc-Organization header', async () => {
    setupSessionWithGrants(ORG_A, false, [
      {
        roleId: 'role-org-admin-a',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: ORG_A,
        orgId: ORG_A,
        permissions: ['messages.read'],
      },
    ]);

    await messagesApi.list({ limit: 10 });

    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0]!;
    const headers = call.options.headers as Record<string, string>;
    assert.equal(headers['X-Acc-Organization'], ORG_A);
  });

  // --- 3. Anti-Enumeration & Privacy -----------------------------------------

  it('7. handles Model B RLS 404 cleanly without leaking cross-tenant details', () => {
    const crossTenantError = {
      name: 'ApiError',
      status: 404,
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      correlationId: 'corr-anti-enum-msg-1',
    };

    const humanized = humanizeApiError(crossTenantError);
    assert.equal(humanized.title, 'Message Not Found');
    assert.ok(humanized.message.includes('does not exist or has been removed'));
    assert.equal(humanized.correlationId, 'corr-anti-enum-msg-1');
  });
});
