import { PLATFORM_ROLE_KEYS, type RoleGrant } from '@acc/contracts';
import type { Transaction } from '@acc/db';

import {
  ScopeResolver,
  isPlatformAdministrator,
  type ResolvedScopes,
} from './scope-resolver.service';

/**
 * `tenantContextFor` — the derivation the Gate-B audit found defective
 * (Blocker 1): `resellerId` was filled from the selected organization's reseller
 * for every principal. These cases pin the corrected rule without a database;
 * the database-level half is `shared-reseller.int-spec.ts`.
 */

const RESELLER_A = 'aaaaaaaa-0000-7000-8000-000000000001';
const RESELLER_B = 'bbbbbbbb-0000-7000-8000-000000000002';
const ORG_A1 = 'a1a1a1a1-0000-7000-8000-000000000003';

/** A transaction whose every select answers with the organization's reseller. */
function txOwnedBy(resellerId: string | null): Transaction {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve([{ resellerId, workspaceId: null }]),
  };
  return { select: () => chain } as unknown as Transaction;
}

const grant = (over: Partial<RoleGrant>): RoleGrant => ({
  roleId: 'r',
  roleKey: 'org_admin',
  scopeType: 'organization',
  scopeId: ORG_A1,
  orgId: ORG_A1,
  permissions: [],
  ...over,
});

const scopes = (grants: RoleGrant[]): ResolvedScopes => ({
  grants,
  permissions: [],
  organizationIds: [ORG_A1],
  isPlatformAdmin: isPlatformAdministrator(grants),
  hasPlatformGrant: grants.some((g) => g.scopeType === 'platform'),
  resellerIds: grants.filter((g) => g.scopeType === 'reseller').map((g) => g.scopeId!),
  inactiveOrganizations: {},
  organizationStatuses: { [ORG_A1]: 'active' },
});

describe('ScopeResolver.tenantContextFor — reseller authority, never reseller context', () => {
  const resolver = new ScopeResolver();

  it('an organization member acting in its organization carries no reseller claim', async () => {
    const ctx = await resolver.tenantContextFor(txOwnedBy(RESELLER_A), scopes([grant({})]), ORG_A1);
    expect(ctx.resellerId).toBeNull();
  });

  it('a workspace- or team-scoped member carries no reseller claim either', async () => {
    const ws = await resolver.tenantContextFor(
      txOwnedBy(RESELLER_A),
      scopes([grant({ scopeType: 'workspace', scopeId: 'ws' })]),
      ORG_A1,
    );
    expect(ws.resellerId).toBeNull();
    const team = await resolver.tenantContextFor(
      txOwnedBy(RESELLER_A),
      scopes([grant({ scopeType: 'team', scopeId: 'team' })]),
      ORG_A1,
    );
    expect(team.resellerId).toBeNull();
  });

  it('a reseller administrator acting in an organization beneath its reseller claims that reseller', async () => {
    const ctx = await resolver.tenantContextFor(
      txOwnedBy(RESELLER_A),
      scopes([
        grant({
          roleKey: 'reseller_admin',
          scopeType: 'reseller',
          scopeId: RESELLER_A,
          orgId: null,
        }),
      ]),
      ORG_A1,
    );
    expect(ctx.resellerId).toBe(RESELLER_A);
  });

  it('a reseller grant on a different reseller confers no claim in this organization', async () => {
    const ctx = await resolver.tenantContextFor(
      txOwnedBy(RESELLER_A),
      scopes([
        grant({}),
        grant({
          roleKey: 'reseller_admin',
          scopeType: 'reseller',
          scopeId: RESELLER_B,
          orgId: null,
        }),
      ]),
      ORG_A1,
    );
    expect(ctx.resellerId).toBeNull();
  });

  it('with no organization selected, exactly one reseller grant is the claim; several are none', async () => {
    const one = await resolver.tenantContextFor(
      txOwnedBy(null),
      scopes([
        grant({
          roleKey: 'reseller_admin',
          scopeType: 'reseller',
          scopeId: RESELLER_A,
          orgId: null,
        }),
      ]),
      null,
    );
    expect(one.resellerId).toBe(RESELLER_A);
    const two = await resolver.tenantContextFor(
      txOwnedBy(null),
      scopes([
        grant({
          roleKey: 'reseller_admin',
          scopeType: 'reseller',
          scopeId: RESELLER_A,
          orgId: null,
        }),
        grant({
          roleKey: 'reseller_admin',
          scopeType: 'reseller',
          scopeId: RESELLER_B,
          orgId: null,
        }),
      ]),
      null,
    );
    expect(two.resellerId).toBeNull();
  });
});

describe('isPlatformAdministrator — one definition', () => {
  it('is true for alendei_super_admin at platform scope', () => {
    expect(
      isPlatformAdministrator([
        grant({
          roleKey: PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN,
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
        }),
      ]),
    ).toBe(true);
  });

  it('is false for alendei_support, although it is platform-scoped', () => {
    expect(
      isPlatformAdministrator([
        grant({
          roleKey: PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT,
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
        }),
      ]),
    ).toBe(false);
  });

  it('is false for a reseller administrator and for any tenant grant', () => {
    expect(
      isPlatformAdministrator([
        grant({
          roleKey: PLATFORM_ROLE_KEYS.RESELLER_ADMIN,
          scopeType: 'reseller',
          scopeId: RESELLER_A,
          orgId: null,
        }),
        grant({}),
      ]),
    ).toBe(false);
  });
});
