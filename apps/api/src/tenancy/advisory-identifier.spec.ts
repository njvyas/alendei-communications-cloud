import type { AuthPrincipal, RoleGrant, ScopeType } from '@acc/contracts';

import { admissibleAdvisoryIds, normalizeAdvisoryValue } from './advisory-identifier';

const ORG = '01930000-0000-7000-8000-00000000000a';
const OTHER_ORG = '01930000-0000-7000-8000-00000000000b';
const WORKSPACE = '01930000-0000-7000-8000-0000000000c1';
const OTHER_WORKSPACE = '01930000-0000-7000-8000-0000000000c2';
const TEAM = '01930000-0000-7000-8000-0000000000d1';
const OTHER_TEAM = '01930000-0000-7000-8000-0000000000d2';
const RESELLER = '01930000-0000-7000-8000-0000000000e1';

const grant = (scopeType: ScopeType, scopeId: string | null, orgId: string | null): RoleGrant => ({
  roleId: `role-${scopeType}`,
  roleKey: scopeType,
  scopeType,
  scopeId,
  orgId,
});

const principalOf = (
  roles: RoleGrant[],
  tenant: Partial<AuthPrincipal['tenant']> = {},
): AuthPrincipal => ({
  actorType: 'user',
  userId: 'user-1',
  apiKeyId: null,
  sessionId: 'session-1',
  tenant: {
    orgId: ORG,
    workspaceId: null,
    resellerId: null,
    isPlatformAdmin: false,
    ...tenant,
  },
  roles,
  permissions: [],
});

describe('normalizeAdvisoryValue', () => {
  it('accepts a well-formed identifier', () => {
    expect(normalizeAdvisoryValue(ORG)).toEqual({ state: 'ok', value: ORG });
    // Surrounding whitespace is trimmed, not treated as a different identifier.
    expect(normalizeAdvisoryValue(`  ${ORG}  `)).toEqual({ state: 'ok', value: ORG });
  });

  it('accepts a UUIDv7 identifier, which is what the platform actually issues', () => {
    expect(normalizeAdvisoryValue('01997b2c-6b4e-7c11-8f2a-0242ac120002').state).toBe('ok');
  });

  it('treats an omitted value as absent', () => {
    expect(normalizeAdvisoryValue(undefined)).toEqual({ state: 'absent' });
    expect(normalizeAdvisoryValue(null)).toEqual({ state: 'absent' });
  });

  it('refuses a repeated or array-valued parameter rather than choosing one', () => {
    // `?orgId=A&orgId=B` — picking either would make the security decision
    // depend on parameter order.
    expect(normalizeAdvisoryValue([ORG, OTHER_ORG])).toEqual({ state: 'ambiguous' });
    // `?orgId=A&orgId=A` — still more than one value, still refused. The
    // behaviour does not depend on whether the duplicates happen to agree.
    expect(normalizeAdvisoryValue([ORG, ORG])).toEqual({ state: 'ambiguous' });
    // `?orgId[]=A`
    expect(normalizeAdvisoryValue([ORG])).toEqual({ state: 'ambiguous' });
    // `?orgId[x]=A`
    expect(normalizeAdvisoryValue({ x: ORG })).toEqual({ state: 'ambiguous' });
  });

  it('refuses a malformed identifier', () => {
    expect(normalizeAdvisoryValue('not-a-uuid')).toEqual({ state: 'malformed' });
    expect(normalizeAdvisoryValue(`${ORG}'; DROP TABLE users; --`)).toEqual({ state: 'malformed' });
    // An empty parameter names nothing; it is not the same as omitting it,
    // because `?orgId=` would otherwise skip the assertion entirely.
    expect(normalizeAdvisoryValue('')).toEqual({ state: 'malformed' });
    expect(normalizeAdvisoryValue('   ')).toEqual({ state: 'malformed' });
  });
});

describe('admissibleAdvisoryIds', () => {
  describe('organization', () => {
    it('admits exactly the resolved organization', () => {
      const principal = principalOf([grant('organization', ORG, ORG)]);
      expect(admissibleAdvisoryIds(principal, 'organization')).toEqual([ORG]);
    });

    it('admits nothing when no organization context is resolved', () => {
      const principal = principalOf([], { orgId: null });
      expect(admissibleAdvisoryIds(principal, 'organization')).toEqual([]);
    });

    it('admits only the selected organization for a platform admin', () => {
      // Holding platform scope puts every organization in scope, but exactly
      // one was selected for this request (ADR-003 D-4) and that is the only
      // one an advisory identifier may name.
      const principal = principalOf([grant('platform', null, null)], { isPlatformAdmin: true });
      expect(admissibleAdvisoryIds(principal, 'organization')).toEqual([ORG]);
    });
  });

  describe('workspace', () => {
    it('is unconstrained for an organization-scoped principal', () => {
      // The organization grant covers every workspace beneath it; which one is
      // reachable is a question for target-scope authorization and RLS, with
      // the row in hand — not for a cross-check that reads no database.
      const principal = principalOf([grant('organization', ORG, ORG)]);
      expect(admissibleAdvisoryIds(principal, 'workspace')).toBeNull();
    });

    it('is unconstrained for a reseller-scoped principal', () => {
      const principal = principalOf([grant('reseller', RESELLER, null)], { resellerId: RESELLER });
      expect(admissibleAdvisoryIds(principal, 'workspace')).toBeNull();
    });

    it('pins a workspace-scoped principal to its own workspaces', () => {
      const principal = principalOf([grant('workspace', WORKSPACE, ORG)], {
        workspaceId: WORKSPACE,
      });
      const admissible = admissibleAdvisoryIds(principal, 'workspace');
      expect(admissible).toEqual([WORKSPACE]);
      expect(admissible).not.toContain(OTHER_WORKSPACE);
    });

    it('admits every workspace a multi-workspace principal actually holds', () => {
      const principal = principalOf(
        [grant('workspace', WORKSPACE, ORG), grant('workspace', OTHER_WORKSPACE, ORG)],
        { workspaceId: WORKSPACE },
      );
      expect(admissibleAdvisoryIds(principal, 'workspace')).toEqual(
        expect.arrayContaining([WORKSPACE, OTHER_WORKSPACE]),
      );
    });

    it('admits the server-derived workspace of a team-scoped principal', () => {
      // A team grant carries no workspace id; `ScopeResolver` derives one from
      // the team's own parent, and that derived value is authoritative.
      const principal = principalOf([grant('team', TEAM, ORG)], { workspaceId: WORKSPACE });
      expect(admissibleAdvisoryIds(principal, 'workspace')).toEqual([WORKSPACE]);
    });

    it('ignores grants belonging to another organization', () => {
      const principal = principalOf(
        [grant('workspace', WORKSPACE, ORG), grant('workspace', OTHER_WORKSPACE, OTHER_ORG)],
        { workspaceId: WORKSPACE },
      );
      expect(admissibleAdvisoryIds(principal, 'workspace')).toEqual([WORKSPACE]);
    });
  });

  describe('team', () => {
    it('is unconstrained for an organization-scoped principal', () => {
      const principal = principalOf([grant('organization', ORG, ORG)]);
      expect(admissibleAdvisoryIds(principal, 'team')).toBeNull();
    });

    it('is unconstrained for a workspace-scoped principal', () => {
      const principal = principalOf([grant('workspace', WORKSPACE, ORG)], {
        workspaceId: WORKSPACE,
      });
      expect(admissibleAdvisoryIds(principal, 'team')).toBeNull();
    });

    it('pins a team-scoped principal to its own teams', () => {
      const principal = principalOf([grant('team', TEAM, ORG)], { workspaceId: WORKSPACE });
      const admissible = admissibleAdvisoryIds(principal, 'team');
      expect(admissible).toEqual([TEAM]);
      expect(admissible).not.toContain(OTHER_TEAM);
    });

    it('admits nothing — rather than everything — for a principal holding no grant at all', () => {
      // Fail closed: an empty admissible set refuses every supplied identifier.
      expect(admissibleAdvisoryIds(principalOf([]), 'team')).toEqual([]);
      expect(admissibleAdvisoryIds(principalOf([]), 'workspace')).toEqual([]);
    });
  });
});
