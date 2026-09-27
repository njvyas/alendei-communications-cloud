import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { QueryClient } from '@tanstack/react-query';

import { createAppQueryClient, registerQueryClient } from './query-client';
import { useSession } from './session-store';

/**
 * Gate C remediation M-2: USER A signs out → USER B signs in → USER B must not
 * see USER A's cached tenant data. Proven against a real `QueryClient` built
 * with the console's own configuration (30 s `staleTime`), so a surviving entry
 * would be served without a refetch.
 */
describe('Session teardown clears authenticated query cache (Gate C M-2)', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';

  const KEYS = {
    organizations: ['organizations', 'list', {}],
    organizationDetail: ['organizations', 'detail', ORG_A],
    workspaces: ['workspaces', 'list', ORG_A, {}],
    teams: ['teams', 'list', ORG_A, {}],
    health: ['health'],
  } as const;

  let client: QueryClient;
  let unregister: () => void;

  const identity = (userId: string) => ({
    accessToken: `token-${userId}`,
    user: {
      userId,
      actorType: 'user' as const,
      authMethod: 'session' as const,
      sessionId: `sess-${userId}`,
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
      authorizedOrganizationIds: [ORG_A],
      roles: [],
      permissions: [],
    },
    authorization: {
      actorType: 'user' as const,
      userId,
      apiKeyId: null,
      grants: [],
      isPlatformAdmin: true,
    },
  });

  const seedUserAData = () => {
    client.setQueryData(KEYS.organizations, { data: [{ id: ORG_A, name: 'User A tenant' }] });
    client.setQueryData(KEYS.organizationDetail, { data: { id: ORG_A, name: 'User A tenant' } });
    client.setQueryData(KEYS.workspaces, { data: [{ id: 'ws-a', orgId: ORG_A }] });
    client.setQueryData(KEYS.teams, { data: [{ id: 'team-a', orgId: ORG_A }] });
    client.setQueryData(KEYS.health, { status: 'ok' });
  };

  const tenantKeys = [KEYS.organizations, KEYS.organizationDetail, KEYS.workspaces, KEYS.teams];

  beforeEach(() => {
    client = createAppQueryClient();
    unregister = registerQueryClient(client);
    useSession.getState().setSession(identity('user-a') as never);
    seedUserAData();
  });

  afterEach(() => {
    unregister();
    client.clear();
    useSession.getState().clearSession();
  });

  it('precondition: user A data is cached and fresh (would render without a refetch)', () => {
    for (const key of tenantKeys) {
      assert.ok(client.getQueryData(key), `expected cached ${JSON.stringify(key)}`);
      assert.equal(client.getQueryState(key)?.isInvalidated, false);
    }
  });

  it('A logs out → B logs in: none of A’s organization, workspace or team data remains', () => {
    useSession.getState().clearSession();
    useSession.getState().setSession(identity('user-b') as never);

    for (const key of tenantKeys) {
      assert.equal(client.getQueryData(key), undefined, `leaked ${JSON.stringify(key)}`);
    }
    assert.equal(client.getQueryCache().findAll({ queryKey: ['organizations'] }).length, 0);
  });

  it('public, non-authenticated state is kept across sign-out', () => {
    useSession.getState().clearSession();
    assert.deepEqual(client.getQueryData(KEYS.health), { status: 'ok' });
  });

  it('switching identity without an explicit sign-out still clears A’s data', () => {
    useSession.getState().setSession(identity('user-b') as never);
    for (const key of tenantKeys) {
      assert.equal(client.getQueryData(key), undefined, `leaked ${JSON.stringify(key)}`);
    }
  });

  it('a session refresh for the same identity keeps its own cache', () => {
    useSession.getState().setSession(identity('user-a') as never);
    for (const key of tenantKeys) assert.ok(client.getQueryData(key));
  });

  it('a fetch user A started cannot repopulate the cache after sign-out', async () => {
    let release!: (value: unknown) => void;
    const pending = client
      .fetchQuery({
        queryKey: ['organizations', 'list', { cursor: 'late' }],
        queryFn: () => new Promise((resolve) => (release = resolve)),
      })
      .catch(() => undefined);

    useSession.getState().clearSession();
    release({ data: [{ id: ORG_A, name: 'User A tenant (late)' }] });
    await pending;

    assert.equal(client.getQueryData(['organizations', 'list', { cursor: 'late' }]), undefined);
    assert.equal(client.getQueryCache().findAll({ queryKey: ['organizations'] }).length, 0);
  });

  it('pending mutations of user A are discarded', () => {
    client.getMutationCache().build(client, { mutationKey: ['organizations', 'create'] });
    assert.equal(client.getMutationCache().getAll().length, 1);
    useSession.getState().clearSession();
    assert.equal(client.getMutationCache().getAll().length, 0);
  });
});
