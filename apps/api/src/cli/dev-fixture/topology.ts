/**
 * The Phase 1C.4a development/test fixture topology (`TESTING.md` §6p, §6r).
 *
 * Every fixture object is identified by a natural key — a slug, an email, or a
 * name inside a named parent — never by a generated id. UUIDv7 ids and Argon2
 * digests differ between databases; the logical topology these keys describe
 * does not, and that is what the fixture guarantees.
 *
 *   PLATFORM
 *   ├─ Reseller A  = the seeded platform-default reseller ("Alendei Direct")
 *   │   ├─ Organization A1 ── Default workspace ── Team T (markup-bearing name)
 *   │   └─ Organization A2 ── Default workspace
 *   └─ Reseller B  = fixture-owned (owner-level exception, see `owner-operations.ts`)
 *       └─ Organization B1 ── Default workspace
 */
import { PLATFORM_DEFAULT_RESELLER_SLUG } from '@acc/db';
import { TENANT_ROLE_KEYS, type ScopeType } from '@acc/contracts';

export const FIXTURE_NAME = 'acc-dev-fixture';
export const FIXTURE_VERSION = 1;

/** Sent on every fixture request, and therefore stamped on every audit row it causes. */
export const FIXTURE_USER_AGENT = `${FIXTURE_NAME}/${FIXTURE_VERSION} (Phase 1C.4a)`;

/** Reserved by RFC 2606; distinct from the `example.test` addresses the suites plant and purge. */
export const FIXTURE_EMAIL_DOMAIN = 'acc-fixture.test';

export type ResellerRef = 'A' | 'B';
export type OrgRef = 'A1' | 'A2' | 'B1';
export type UserRef = 'a1Admin' | 'a2Admin' | 'b1Admin' | 'teamReader' | 'multiOrg';

export const RESELLERS: Readonly<
  Record<
    ResellerRef,
    { readonly slug: string; readonly name: string; readonly fixtureOwned: boolean }
  >
> = Object.freeze({
  A: { slug: PLATFORM_DEFAULT_RESELLER_SLUG, name: 'Alendei Direct', fixtureOwned: false },
  B: { slug: 'acc-fixture-reseller-b', name: 'ACC Fixture Reseller B', fixtureOwned: true },
});

export const ORGANIZATIONS: Readonly<
  Record<OrgRef, { readonly slug: string; readonly name: string; readonly reseller: ResellerRef }>
> = Object.freeze({
  A1: { slug: 'acc-fixture-a1', name: 'ACC Fixture A1', reseller: 'A' },
  A2: { slug: 'acc-fixture-a2', name: 'ACC Fixture A2', reseller: 'A' },
  B1: { slug: 'acc-fixture-b1', name: 'ACC Fixture B1', reseller: 'B' },
});

/** The workspace every organization is created with (ADR-012 F-3). */
export const DEFAULT_WORKSPACE_SLUG = 'default';

/**
 * Harmless, clearly fixture-owned markup. It only ever sets a global flag the
 * browser suite can assert stays unset; it references no external resource.
 * The team is created through `POST /teams`, so the `team.created` audit row
 * that carries this string in `after.name` is written by the real audit path.
 */
export const MARKUP_PAYLOAD =
  '<img src=x onerror="window.__accFixtureMarkup=1"><script>window.__accFixtureMarkup=1</script>';

export const TEAM = Object.freeze({
  org: 'A1' as OrgRef,
  workspaceSlug: DEFAULT_WORKSPACE_SLUG,
  name: `ACC Fixture Team ${MARKUP_PAYLOAD}`,
});

export interface GrantSpec {
  readonly roleKey: string;
  readonly scopeType: Extract<ScopeType, 'organization' | 'team'>;
  /** The organization whose role is granted, and whose scope (or team) it is granted at. */
  readonly org: OrgRef;
}

export const USERS: Readonly<
  Record<UserRef, { readonly email: string; readonly grants: readonly GrantSpec[] }>
> = Object.freeze({
  a1Admin: {
    email: `a1-admin@${FIXTURE_EMAIL_DOMAIN}`,
    grants: [{ roleKey: TENANT_ROLE_KEYS.ORG_ADMIN, scopeType: 'organization', org: 'A1' }],
  },
  a2Admin: {
    email: `a2-admin@${FIXTURE_EMAIL_DOMAIN}`,
    grants: [{ roleKey: TENANT_ROLE_KEYS.ORG_ADMIN, scopeType: 'organization', org: 'A2' }],
  },
  b1Admin: {
    email: `b1-admin@${FIXTURE_EMAIL_DOMAIN}`,
    grants: [{ roleKey: TENANT_ROLE_KEYS.ORG_ADMIN, scopeType: 'organization', org: 'B1' }],
  },
  teamReader: {
    email: `a1-team-reader@${FIXTURE_EMAIL_DOMAIN}`,
    grants: [{ roleKey: TENANT_ROLE_KEYS.READ_ONLY, scopeType: 'team', org: 'A1' }],
  },
  multiOrg: {
    email: `multi-org@${FIXTURE_EMAIL_DOMAIN}`,
    grants: [
      { roleKey: TENANT_ROLE_KEYS.WORKSPACE_MANAGER, scopeType: 'organization', org: 'A1' },
      { roleKey: TENANT_ROLE_KEYS.WORKSPACE_MANAGER, scopeType: 'organization', org: 'A2' },
    ],
  },
});

export const USER_REFS = Object.keys(USERS) as UserRef[];
export const ORG_REFS = Object.keys(ORGANIZATIONS) as OrgRef[];

/** A grant's natural key, stable across databases. */
export function grantKey(email: string, grant: GrantSpec): string {
  const target =
    grant.scopeType === 'team'
      ? `team:${ORGANIZATIONS[grant.org].slug}/${TEAM.name}`
      : `organization:${ORGANIZATIONS[grant.org].slug}`;
  return `${email.toLowerCase()} ${grant.roleKey}@${ORGANIZATIONS[grant.org].slug} ${target}`;
}
