import {
  PERMISSIONS,
  TENANT_ROLE_DEFINITIONS,
  scopeCovers,
  type AuthPrincipal,
  type RoleGrant,
  type ScopeType,
} from '@acc/contracts';

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

const ORG_TARGET = { scopeType: 'organization' as ScopeType, scopeId: 'org-1' };

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
        permissions: [PERMISSIONS.WORKSPACES_READ],
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
          permissions: [PERMISSIONS.WORKSPACES_READ],
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
        {
          roleId: 'r1',
          roleKey: 'agent',
          scopeType: 'team',
          scopeId: 'team-1',
          orgId: 'org-1',
          permissions: [PERMISSIONS.WORKSPACES_READ],
        },
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
          permissions: [PERMISSIONS.WORKSPACES_READ],
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

// ---------------------------------------------------------------------------
/**
 * Coherent-grant authorization (ADR-005 D-1, `TESTING.md` §6b, §6n).
 *
 * The rule under test is that **one** grant must supply both the permission and
 * the covering scope. These cases are the ones a flattened permission union
 * cannot distinguish: every principal below holds permissions and holds covering
 * scopes, just never together in the same grant.
 *
 * Permission sets come from `TENANT_ROLE_DEFINITIONS` rather than being invented
 * here, so the attack is expressed in the roles the platform actually seeds.
 */
describe('PermissionEvaluator — coherent grants', () => {
  const evaluator = new PermissionEvaluator();

  const permissionsOf = (roleKey: string): readonly string[] =>
    TENANT_ROLE_DEFINITIONS.find((r) => r.key === roleKey)!.permissions;

  const grantOf = (
    roleKey: string,
    scopeType: ScopeType,
    scopeId: string | null,
    permissions: readonly string[] = permissionsOf(roleKey),
  ): RoleGrant => ({
    roleId: `role-${roleKey}-${scopeId ?? 'platform'}`,
    roleKey,
    scopeType,
    scopeId,
    orgId: scopeType === 'platform' ? null : 'org-1',
    permissions,
  });

  /** A principal whose union is deliberately the union of all its grants. */
  const principalOf = (roles: RoleGrant[]): AuthPrincipal => ({
    actorType: 'user',
    userId: 'u1',
    apiKeyId: null,
    sessionId: 's1',
    tenant: { orgId: 'org-1', workspaceId: 'ws-1', resellerId: null, isPlatformAdmin: false },
    roles,
    permissions: [...new Set(roles.flatMap((r) => r.permissions))],
  });

  const ask = (
    roles: RoleGrant[],
    permission: string,
    scopeType: ScopeType,
    scopeId: string | null,
  ) =>
    evaluator.allows({
      principal: principalOf(roles),
      permission,
      target: { scope: { scopeType, scopeId }, chain: CHAIN },
    });

  const readOnlyAtOrg = grantOf('read_only', 'organization', 'org-1');
  const wsManagerAtWs = grantOf('workspace_manager', 'workspace', 'ws-1');

  // The permissions `workspace_manager` carries and `read_only` does not. These
  // are the administrative permissions the cross-product used to leak upward.
  const LEAKABLE = [
    PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
    PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE,
    PERMISSIONS.TEAMS_CREATE,
    PERMISSIONS.TEAMS_UPDATE,
    PERMISSIONS.WORKSPACES_UPDATE,
    PERMISSIONS.USERS_INVITE,
  ] as const;

  it('confirms the fixture really is the cross-product setup', () => {
    // Guards the test itself: if the seeded roles ever change so that
    // `read_only` gains these permissions, the attack cases below would pass
    // vacuously and prove nothing.
    for (const permission of LEAKABLE) {
      expect(readOnlyAtOrg.permissions).not.toContain(permission);
      expect(wsManagerAtWs.permissions).toContain(permission);
    }
    // And the covering half really is covering.
    expect(scopeCovers({ scopeType: 'organization', scopeId: 'org-1' }, ORG_TARGET, CHAIN)).toBe(
      true,
    );
    expect(scopeCovers({ scopeType: 'workspace', scopeId: 'ws-1' }, ORG_TARGET, CHAIN)).toBe(false);
  });

  // -------------------------------------------------------------------------
  describe('the ADR-005 attack: permission from one grant, scope from another', () => {
    it('denies role_assignments.grant at organization scope', () => {
      // read_only@org-1     covers the target, does not carry the permission
      // workspace_manager@ws-1  carries the permission, does not cover the target
      // No single grant satisfies both. The flattened evaluator allowed this.
      expect(
        ask(
          [readOnlyAtOrg, wsManagerAtWs],
          PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
          'organization',
          'org-1',
        ),
      ).toBe(false);
    });

    it.each(LEAKABLE)('denies %s at organization scope', (permission) => {
      expect(ask([readOnlyAtOrg, wsManagerAtWs], permission, 'organization', 'org-1')).toBe(false);
    });

    it.each(LEAKABLE)('denies %s regardless of grant order', (permission) => {
      // Proves the defect is not an artifact of which grant `some()` reaches
      // first: the permission-carrying grant is now listed before the
      // scope-carrying one.
      expect(ask([wsManagerAtWs, readOnlyAtOrg], permission, 'organization', 'org-1')).toBe(false);
    });

    it('denies across a workspace/team pairing too, not only organization/workspace', () => {
      // agent@team-1 carries no admin permission; workspace_manager@ws-OTHER
      // carries them but covers a different workspace's teams.
      const agentAtTeam = grantOf('agent', 'team', 'team-1');
      const managerElsewhere = grantOf('workspace_manager', 'workspace', 'ws-OTHER');
      expect(ask([agentAtTeam, managerElsewhere], PERMISSIONS.TEAMS_UPDATE, 'team', 'team-1')).toBe(
        false,
      );
    });

    it('denies when the scope-carrying grant is a platform-adjacent reseller grant without the permission', () => {
      // A reseller grant covers the organization, but if it does not carry the
      // permission it cannot lend its reach to a grant that does.
      const resellerNoPerm = grantOf('read_only', 'reseller', 'reseller-1', []);
      expect(
        ask(
          [resellerNoPerm, wsManagerAtWs],
          PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
          'organization',
          'org-1',
        ),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('positive cases — valid authorization still works', () => {
    it('A. allows when one grant carries both the permission and the scope', () => {
      expect(ask([wsManagerAtWs], PERMISSIONS.TEAMS_CREATE, 'workspace', 'ws-1')).toBe(true);
    });

    it('B. allows a parent-scope grant to reach a child target', () => {
      expect(ask([readOnlyAtOrg], PERMISSIONS.WORKSPACES_READ, 'workspace', 'ws-1')).toBe(true);
      expect(ask([readOnlyAtOrg], PERMISSIONS.WORKSPACES_READ, 'team', 'team-1')).toBe(true);
    });

    it('C. denies a carried permission at a scope the same grant does not cover', () => {
      expect(ask([wsManagerAtWs], PERMISSIONS.TEAMS_CREATE, 'organization', 'org-1')).toBe(false);
    });

    it('D. denies when scope is sufficient in one grant but the permission lives in another', () => {
      expect(
        ask([readOnlyAtOrg, wsManagerAtWs], PERMISSIONS.WORKSPACES_UPDATE, 'organization', 'org-1'),
      ).toBe(false);
    });

    it('E. allows when exactly one of several grants is coherent', () => {
      // workspace_manager@ws-1 is the only grant that both carries
      // teams.create and covers the team beneath ws-1.
      expect(ask([readOnlyAtOrg, wsManagerAtWs], PERMISSIONS.TEAMS_CREATE, 'team', 'team-1')).toBe(
        true,
      );
    });

    it('F. allows when several grants are independently coherent', () => {
      // Both grants carry workspaces.read and both cover ws-1. The correction
      // must not require uniqueness — "some grant", not "exactly one".
      expect(
        ask([readOnlyAtOrg, wsManagerAtWs], PERMISSIONS.WORKSPACES_READ, 'workspace', 'ws-1'),
      ).toBe(true);
    });

    it('G. denies a principal holding no grants', () => {
      expect(ask([], PERMISSIONS.WORKSPACES_READ, 'organization', 'org-1')).toBe(false);
    });

    it('H. denies a permission present in no grant', () => {
      expect(
        ask([readOnlyAtOrg, wsManagerAtWs], PERMISSIONS.API_KEYS_CREATE, 'organization', 'org-1'),
      ).toBe(false);
    });

    it('still lets a platform grant carrying the permission cover everything', () => {
      const platform = grantOf('read_only', 'platform', null, [PERMISSIONS.WORKSPACES_READ]);
      for (const level of LEVELS) {
        expect(ask([platform], PERMISSIONS.WORKSPACES_READ, level, idFor[level])).toBe(true);
      }
    });

    it('denies even a platform grant a permission its own role does not carry', () => {
      // Platform scope covers every target, which is exactly why the permission
      // half must still be read off that same grant.
      const platform = grantOf('read_only', 'platform', null, [PERMISSIONS.WORKSPACES_READ]);
      expect(ask([platform], PERMISSIONS.ROLES_DELETE, 'organization', 'org-1')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('grant and role state', () => {
    /**
     * The schema models neither a disabled role nor a revoked grant as a column:
     * a revoked grant is a deleted `user_roles` row and a deleted role cascades
     * its grants away, so both reach the evaluator as *absence* rather than as a
     * flag. Authorization is re-derived per request (ADR-003 D-3), so absence is
     * the whole mechanism. These assert that absence denies, rather than
     * inventing lifecycle states the schema does not have.
     */
    it('denies once the grant is absent from the principal', () => {
      expect(ask([wsManagerAtWs], PERMISSIONS.TEAMS_CREATE, 'workspace', 'ws-1')).toBe(true);
      expect(ask([], PERMISSIONS.TEAMS_CREATE, 'workspace', 'ws-1')).toBe(false);
    });

    it('denies when the role still exists but no longer carries the permission', () => {
      const stripped = grantOf('workspace_manager', 'workspace', 'ws-1', [
        PERMISSIONS.WORKSPACES_READ,
      ]);
      expect(ask([stripped], PERMISSIONS.TEAMS_CREATE, 'workspace', 'ws-1')).toBe(false);
      expect(ask([stripped], PERMISSIONS.WORKSPACES_READ, 'workspace', 'ws-1')).toBe(true);
    });

    it('denies a grant carrying an empty permission set at any scope', () => {
      const empty = grantOf('read_only', 'organization', 'org-1', []);
      for (const level of ['organization', 'workspace', 'team'] as ScopeType[]) {
        expect(ask([empty], PERMISSIONS.WORKSPACES_READ, level, idFor[level])).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('the flattened union is not consulted', () => {
    it('denies even when the union contains the permission and a grant covers the target', () => {
      // Constructed so the *old* rule is satisfied on both halves while no
      // grant satisfies both: this is the precise shape of the defect, and it
      // fails closed only if `principal.permissions` is never read.
      const principal: AuthPrincipal = {
        ...principalOf([readOnlyAtOrg, wsManagerAtWs]),
        permissions: [PERMISSIONS.ROLE_ASSIGNMENTS_GRANT],
      };
      expect(
        evaluator.allows({
          principal,
          permission: PERMISSIONS.ROLE_ASSIGNMENTS_GRANT,
          target: { scope: ORG_TARGET, chain: CHAIN },
        }),
      ).toBe(false);
    });

    it('allows a coherent grant even when the union is empty', () => {
      // The mirror image: a stale or empty union must not be able to deny what
      // a real grant permits, or the union would still be load-bearing.
      const principal: AuthPrincipal = {
        ...principalOf([wsManagerAtWs]),
        permissions: [],
      };
      expect(
        evaluator.allows({
          principal,
          permission: PERMISSIONS.TEAMS_CREATE,
          target: { scope: { scopeType: 'workspace', scopeId: 'ws-1' }, chain: CHAIN },
        }),
      ).toBe(true);
    });
  });
});
