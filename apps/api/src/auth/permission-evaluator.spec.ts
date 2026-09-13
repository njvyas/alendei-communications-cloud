import { PERMISSIONS, scopeCovers, type AuthPrincipal, type ScopeType } from '@acc/contracts';

import { PermissionEvaluator } from './permission-evaluator.service';

const CHAIN = {
  resellerId: 'reseller-1',
  orgId: 'org-1',
  workspaceId: 'ws-1',
  teamId: 'team-1',
} as const;

const idFor: Record<ScopeType, string | null> = {
  platform: null,
  reseller: 'reseller-1',
  organization: 'org-1',
  workspace: 'ws-1',
  team: 'team-1',
};

const LEVELS: ScopeType[] = ['platform', 'reseller', 'organization', 'workspace', 'team'];

describe('scopeCovers', () => {
  it('covers downward and never upward or sideways — the full 5x5 matrix', () => {
    const depth = Object.fromEntries(LEVELS.map((l, i) => [l, i])) as Record<ScopeType, number>;

    for (const grant of LEVELS) {
      for (const target of LEVELS) {
        const covered = scopeCovers(
          { scopeType: grant, scopeId: idFor[grant] },
          { scopeType: target, scopeId: idFor[target] },
          CHAIN,
        );
        // Downward-only inheritance: a grant covers its own level and below.
        expect([grant, target, covered]).toEqual([grant, target, depth[grant] <= depth[target]]);
      }
    }
  });

  it('does not reach a sibling at the same level', () => {
    expect(
      scopeCovers(
        { scopeType: 'workspace', scopeId: 'ws-OTHER' },
        { scopeType: 'workspace', scopeId: 'ws-1' },
        CHAIN,
      ),
    ).toBe(false);
    expect(
      scopeCovers(
        { scopeType: 'organization', scopeId: 'org-OTHER' },
        { scopeType: 'team', scopeId: 'team-1' },
        CHAIN,
      ),
    ).toBe(false);
  });

  it('lets an organization grant reach its workspaces and teams with no extra grant', () => {
    // The positive half of inheritance — without it the model would be
    // isolation by accident rather than by design.
    for (const target of ['organization', 'workspace', 'team'] as ScopeType[]) {
      expect(
        scopeCovers(
          { scopeType: 'organization', scopeId: 'org-1' },
          { scopeType: target, scopeId: idFor[target] },
          CHAIN,
        ),
      ).toBe(true);
    }
  });

  it('treats a non-platform grant with no scope id as covering nothing', () => {
    expect(
      scopeCovers(
        { scopeType: 'organization', scopeId: null },
        { scopeType: 'team', scopeId: 'team-1' },
        CHAIN,
      ),
    ).toBe(false);
  });
});

describe('PermissionEvaluator', () => {
  const evaluator = new PermissionEvaluator();

  const principal = (over: Partial<AuthPrincipal> = {}): AuthPrincipal => ({
    actorType: 'user',
    userId: 'u1',
    apiKeyId: null,
    sessionId: 's1',
    tenant: { orgId: 'org-1', workspaceId: null, resellerId: null, isPlatformAdmin: false },
    roles: [
      {
        roleId: 'r1',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: 'org-1',
        orgId: 'org-1',
      },
    ],
    permissions: [PERMISSIONS.WORKSPACES_READ],
    ...over,
  });

  const target = (scopeType: ScopeType, scopeId: string | null) => ({
    scope: { scopeType, scopeId },
    chain: CHAIN,
  });

  it('allows a held permission at a covered scope', () => {
    expect(
      evaluator.allows({
        principal: principal(),
        permission: PERMISSIONS.WORKSPACES_READ,
        target: target('workspace', 'ws-1'),
      }),
    ).toBe(true);
  });

  it('refuses a permission the principal does not hold', () => {
    expect(
      evaluator.allows({
        principal: principal(),
        permission: PERMISSIONS.ROLES_DELETE,
        target: target('organization', 'org-1'),
      }),
    ).toBe(false);
  });

  it('refuses a held permission at a scope the grant does not cover', () => {
    // Holding workspaces.read somewhere is never authority over this workspace.
    const workspaceScoped = principal({
      roles: [
        {
          roleId: 'r1',
          roleKey: 'workspace_manager',
          scopeType: 'workspace',
          scopeId: 'ws-OTHER',
          orgId: 'org-1',
        },
      ],
    });
    expect(
      evaluator.allows({
        principal: workspaceScoped,
        permission: PERMISSIONS.WORKSPACES_READ,
        target: target('workspace', 'ws-1'),
      }),
    ).toBe(false);
  });

  it('refuses upward escalation from a team grant', () => {
    const teamScoped = principal({
      roles: [
        { roleId: 'r1', roleKey: 'agent', scopeType: 'team', scopeId: 'team-1', orgId: 'org-1' },
      ],
    });
    expect(
      evaluator.allows({
        principal: teamScoped,
        permission: PERMISSIONS.WORKSPACES_READ,
        target: target('organization', 'org-1'),
      }),
    ).toBe(false);
    expect(
      evaluator.allows({
        principal: teamScoped,
        permission: PERMISSIONS.WORKSPACES_READ,
        target: target('team', 'team-1'),
      }),
    ).toBe(true);
  });

  it('lets a platform grant cover everything', () => {
    const platform = principal({
      roles: [
        {
          roleId: 'r1',
          roleKey: 'alendei_super_admin',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
        },
      ],
    });
    for (const level of LEVELS) {
      expect(
        evaluator.allows({
          principal: platform,
          permission: PERMISSIONS.WORKSPACES_READ,
          target: target(level, idFor[level]),
        }),
      ).toBe(true);
    }
  });

  it('refuses a principal holding no grants at all', () => {
    expect(
      evaluator.allows({
        principal: principal({ roles: [] }),
        permission: PERMISSIONS.WORKSPACES_READ,
        target: target('organization', 'org-1'),
      }),
    ).toBe(false);
  });

  it('assert throws a scope-denied error that does not echo the target', () => {
    let thrown: unknown;
    try {
      evaluator.assert({
        principal: principal(),
        permission: PERMISSIONS.ROLES_DELETE,
        target: target('organization', 'org-1'),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const message = (thrown as Error).message;
    expect(message).not.toContain('org-1');
    expect(message).toMatch(/do not have permission/i);
  });
});
