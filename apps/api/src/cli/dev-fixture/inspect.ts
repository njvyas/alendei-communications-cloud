/**
 * Read-only inspection of the fixture's state, as the schema owner.
 *
 * The fixture decides everything it will do before it writes anything: this
 * module finds each fixture object by its natural key, reports every
 * incompatible existing object as a conflict, and lists what is missing. A
 * conflict aborts the run with nothing written — the fixture never overwrites,
 * moves, re-parents or "corrects" existing state.
 *
 * Nothing here writes. Every statement is a `SELECT`.
 */
import { PLATFORM_ROLE_KEYS } from '@acc/contracts';
import type { Database } from '@acc/db';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import type { CredentialService } from '../../iam/credential.service';
import {
  DEFAULT_WORKSPACE_SLUG,
  FIXTURE_EMAIL_DOMAIN,
  grantKey,
  ORG_REFS,
  ORGANIZATIONS,
  RESELLERS,
  TEAM,
  USER_REFS,
  USERS,
  type GrantSpec,
  type OrgRef,
  type ResellerRef,
  type UserRef,
} from './topology';

export interface ResellerRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly isPlatformDefault: boolean;
}
export interface OrgRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly resellerId: string;
  readonly defaultWorkspaceId: string | null;
  readonly defaultWorkspaceStatus: string | null;
}
export interface TeamRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
}
export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly passwordHash: string | null;
}
interface GrantRow {
  readonly id: string;
  readonly roleKey: string;
  readonly roleOrgId: string | null;
  readonly scopeType: string;
  readonly scopeId: string | null;
}

export interface FixtureState {
  readonly resellers: Partial<Record<ResellerRef, ResellerRow>>;
  readonly orgs: Partial<Record<OrgRef, OrgRow>>;
  readonly team: TeamRow | null;
  readonly users: Partial<Record<UserRef, UserRow>>;
  /** Per user, which of its expected grants (by index) already exist. */
  readonly presentGrants: Record<UserRef, readonly boolean[]>;
  readonly operator: { readonly userId: string | null; readonly isPlatformAdmin: boolean };
}

export type PlanStep =
  | { readonly kind: 'bootstrap-operator' }
  | { readonly kind: 'create-reseller'; readonly reseller: 'B' }
  | { readonly kind: 'create-organization'; readonly org: OrgRef }
  | { readonly kind: 'create-team' }
  | { readonly kind: 'create-user'; readonly user: UserRef }
  | { readonly kind: 'grant'; readonly user: UserRef; readonly index: number }
  | { readonly kind: 'activate-user'; readonly user: UserRef };

export interface Inspection {
  readonly state: FixtureState;
  /** Prerequisites the fixture does not create (`db:seed`), or refuses to replace. */
  readonly refusals: readonly string[];
  readonly conflicts: readonly string[];
  readonly plan: readonly PlanStep[];
}

async function rows<T>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

async function resellerBySlug(db: Database, slug: string): Promise<ResellerRow | undefined> {
  const [row] = await rows<ResellerRow>(
    db,
    sql`SELECT id, slug, name, status::text AS status, is_platform_default AS "isPlatformDefault"
          FROM resellers WHERE slug = ${slug}`,
  );
  return row;
}

async function orgBySlug(db: Database, slug: string): Promise<OrgRow | undefined> {
  const [row] = await rows<OrgRow>(
    db,
    sql`SELECT o.id, o.slug, o.name, o.status::text AS status, o.reseller_id AS "resellerId",
               w.id AS "defaultWorkspaceId", w.status::text AS "defaultWorkspaceStatus"
          FROM organizations o
          LEFT JOIN workspaces w ON w.org_id = o.id AND w.is_default
         WHERE o.slug = ${slug}`,
  );
  return row;
}

async function userByEmail(db: Database, email: string): Promise<UserRow | undefined> {
  const [row] = await rows<UserRow>(
    db,
    sql`SELECT id, email, status::text AS status, password_hash AS "passwordHash"
          FROM users WHERE lower(email) = lower(${email})`,
  );
  return row;
}

async function grantsOf(db: Database, userId: string): Promise<GrantRow[]> {
  return rows<GrantRow>(
    db,
    sql`SELECT ur.id, r.key AS "roleKey", r.org_id AS "roleOrgId",
               ur.scope_type::text AS "scopeType", ur.scope_id AS "scopeId"
          FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = ${userId}
         ORDER BY ur.id`,
  );
}

function matches(grant: GrantRow, spec: GrantSpec, state: FixtureState): boolean {
  const org = state.orgs[spec.org];
  if (!org || grant.roleKey !== spec.roleKey || grant.roleOrgId !== org.id) return false;
  if (grant.scopeType !== spec.scopeType) return false;
  const scopeId = spec.scopeType === 'team' ? state.team?.id : org.id;
  return scopeId !== undefined && grant.scopeId === scopeId;
}

export async function inspectFixture(
  db: Database,
  input: {
    readonly operatorEmail: string;
    readonly operatorPassword: string;
    readonly userPassword: string;
  },
  credentials: CredentialService,
): Promise<Inspection> {
  const refusals: string[] = [];
  const conflicts: string[] = [];
  const plan: PlanStep[] = [];

  // --- Prerequisites: seeded reference data the fixture never creates -------
  const platformRoles = await rows<{ key: string }>(
    db,
    sql`SELECT key FROM roles WHERE org_id IS NULL`,
  );
  if (!platformRoles.some((r) => r.key === PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN)) {
    refusals.push('the platform roles are not seeded — run `npm run db:seed` first');
  }

  // --- Operator: the bootstrap platform administrator -----------------------
  if (input.operatorEmail.endsWith(`@${FIXTURE_EMAIL_DOMAIN}`)) {
    refusals.push(`the operator must not be a fixture identity (@${FIXTURE_EMAIL_DOMAIN})`);
  }
  const admins = await rows<{ userId: string }>(
    db,
    sql`SELECT ur.user_id AS "userId" FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE r.org_id IS NULL AND r.key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN}
           AND ur.scope_type = 'platform'`,
  );
  const operatorRow = await userByEmail(db, input.operatorEmail);
  const operatorIsAdmin = !!operatorRow && admins.some((a) => a.userId === operatorRow.id);
  if (admins.length === 0) {
    if (operatorRow) {
      // Bootstrap would activate this existing identity with the configured
      // password; the fixture will not let it overwrite a credential.
      conflicts.push(
        `operator ${input.operatorEmail} already exists but the platform is not bootstrapped; refusing to replace its credential`,
      );
    } else {
      plan.push({ kind: 'bootstrap-operator' });
    }
  } else if (!operatorIsAdmin) {
    conflicts.push(
      `the platform is bootstrapped with a different administrator; ${input.operatorEmail} holds no alendei_super_admin grant`,
    );
  } else if (
    operatorRow.status !== 'active' ||
    !operatorRow.passwordHash ||
    !(await credentials.verify(operatorRow.passwordHash, input.operatorPassword))
  ) {
    conflicts.push(
      `operator ${input.operatorEmail} is not active or does not match AUTH_BOOTSTRAP_PASSWORD_REF`,
    );
  }

  // --- Resellers --------------------------------------------------------------
  const resellers: Partial<Record<ResellerRef, ResellerRow>> = {};
  const resellerA = await resellerBySlug(db, RESELLERS.A.slug);
  if (!resellerA || !resellerA.isPlatformDefault || resellerA.status !== 'active') {
    refusals.push(
      `Reseller A (the platform-default reseller "${RESELLERS.A.slug}") is missing or not active — run \`npm run db:seed\``,
    );
  } else {
    resellers.A = resellerA;
  }
  const resellerB = await resellerBySlug(db, RESELLERS.B.slug);
  if (resellerB) {
    if (
      resellerB.name !== RESELLERS.B.name ||
      resellerB.status !== 'active' ||
      resellerB.isPlatformDefault
    ) {
      conflicts.push(
        `reseller ${RESELLERS.B.slug} exists with incompatible attributes (name, status or platform-default flag)`,
      );
    }
    resellers.B = resellerB;
    const foreign = await rows<{ slug: string }>(
      db,
      sql`SELECT slug FROM organizations WHERE reseller_id = ${resellerB.id}
            AND slug <> ${ORGANIZATIONS.B1.slug} ORDER BY slug`,
    );
    for (const { slug } of foreign) {
      conflicts.push(`reseller ${RESELLERS.B.slug} owns a non-fixture organization "${slug}"`);
    }
  } else {
    plan.push({ kind: 'create-reseller', reseller: 'B' });
  }

  // --- Organizations ----------------------------------------------------------
  const orgs: Partial<Record<OrgRef, OrgRow>> = {};
  for (const ref of ORG_REFS) {
    const spec = ORGANIZATIONS[ref];
    const org = await orgBySlug(db, spec.slug);
    if (!org) {
      plan.push({ kind: 'create-organization', org: ref });
      continue;
    }
    orgs[ref] = org;
    const expectedReseller = resellers[spec.reseller];
    if (!expectedReseller || org.resellerId !== expectedReseller.id) {
      conflicts.push(
        `organization ${spec.slug} exists under a different reseller than ${RESELLERS[spec.reseller].slug}; the fixture never moves an organization`,
      );
    }
    if (org.name !== spec.name) conflicts.push(`organization ${spec.slug} has an unexpected name`);
    if (org.status !== 'active') {
      conflicts.push(`organization ${spec.slug} is ${org.status}, not active`);
    }
    if (!org.defaultWorkspaceId || org.defaultWorkspaceStatus !== 'active') {
      conflicts.push(`organization ${spec.slug} has no active default workspace`);
    }
  }

  // --- Team -------------------------------------------------------------------
  let team: TeamRow | null = null;
  const teamOrg = orgs[TEAM.org];
  if (teamOrg?.defaultWorkspaceId) {
    const found = await rows<TeamRow>(
      db,
      sql`SELECT id, workspace_id AS "workspaceId", status::text AS status FROM teams
           WHERE org_id = ${teamOrg.id} AND workspace_id = ${teamOrg.defaultWorkspaceId}
             AND name = ${TEAM.name}`,
    );
    if (found.length > 1)
      conflicts.push(`more than one fixture team exists in ${ORGANIZATIONS[TEAM.org].slug}`);
    team = found[0] ?? null;
    if (team && team.status !== 'active') conflicts.push('the fixture team is not active');
  }
  if (!team) plan.push({ kind: 'create-team' });

  // --- Users and grants -------------------------------------------------------
  const users: Partial<Record<UserRef, UserRow>> = {};
  const presentGrants = {} as Record<UserRef, boolean[]>;
  const partial: FixtureState = {
    resellers,
    orgs,
    team,
    users,
    presentGrants,
    operator: { userId: operatorRow?.id ?? null, isPlatformAdmin: operatorIsAdmin },
  };
  for (const ref of USER_REFS) {
    const spec = USERS[ref];
    presentGrants[ref] = spec.grants.map(() => false);
    const user = await userByEmail(db, spec.email);
    if (!user) {
      plan.push({ kind: 'create-user', user: ref });
      spec.grants.slice(1).forEach((_, i) => plan.push({ kind: 'grant', user: ref, index: i + 1 }));
      plan.push({ kind: 'activate-user', user: ref });
      continue;
    }
    users[ref] = user;

    if (user.status === 'disabled') {
      conflicts.push(`fixture user ${spec.email} is disabled; the fixture never reactivates`);
    } else if (user.status === 'active') {
      if (
        !user.passwordHash ||
        !(await credentials.verify(user.passwordHash, input.userPassword))
      ) {
        conflicts.push(
          `fixture user ${spec.email} has a credential that does not match ACC_FIXTURE_USER_PASSWORD_REF; the fixture never overwrites a credential`,
        );
      }
    } else if (user.passwordHash) {
      conflicts.push(`fixture user ${spec.email} is invited but already holds a credential`);
    }

    for (const grant of await grantsOf(db, user.id)) {
      const index = spec.grants.findIndex(
        (g, i) => !presentGrants[ref][i] && matches(grant, g, partial),
      );
      if (index === -1) {
        conflicts.push(
          `fixture user ${spec.email} holds an unexpected grant (${grant.roleKey} at ${grant.scopeType}); the fixture never revokes`,
        );
      } else {
        presentGrants[ref][index] = true;
      }
    }
    presentGrants[ref].forEach((present, index) => {
      if (!present) plan.push({ kind: 'grant', user: ref, index });
    });
    if (user.status === 'invited') plan.push({ kind: 'activate-user', user: ref });
  }

  return { state: partial, refusals, conflicts, plan };
}

// --- Fingerprints ----------------------------------------------------------

/**
 * The canonical description of the fixture as it exists in the database: one
 * line per object, keyed by natural keys only. With `withIds` each line also
 * carries the database ids and credential digests, which is what a second run
 * must leave byte-identical; without, it is identical across databases.
 */
export async function fixtureLines(db: Database, options: { withIds: boolean }): Promise<string[]> {
  const orgSlugs = ORG_REFS.map((r) => ORGANIZATIONS[r].slug);
  const emails = USER_REFS.map((r) => USERS[r].email.toLowerCase());
  const id = (value: unknown) => (options.withIds ? ` #${String(value)}` : '');
  const lines: string[] = [];

  for (const r of await rows<Record<string, unknown>>(
    db,
    sql`SELECT id, slug, name, status::text AS status, is_platform_default AS d FROM resellers
         WHERE slug IN (${RESELLERS.A.slug}, ${RESELLERS.B.slug}) ORDER BY slug`,
  )) {
    lines.push(
      `reseller ${String(r.slug)} "${String(r.name)}" ${String(r.status)} default=${String(r.d)}${id(r.id)}`,
    );
  }

  const orgList = sql.join(
    orgSlugs.map((s) => sql`${s}`),
    sql`, `,
  );
  for (const r of await rows<Record<string, unknown>>(
    db,
    sql`SELECT o.id, o.slug, o.name, o.status::text AS status, rs.slug AS reseller
          FROM organizations o JOIN resellers rs ON rs.id = o.reseller_id
         WHERE o.slug IN (${orgList}) ORDER BY o.slug`,
  )) {
    lines.push(
      `organization ${String(r.slug)} "${String(r.name)}" ${String(r.status)} reseller=${String(r.reseller)}${id(r.id)}`,
    );
  }
  for (const r of await rows<Record<string, unknown>>(
    db,
    sql`SELECT w.id, o.slug AS org, w.slug, w.name, w.status::text AS status, w.is_default AS d
          FROM workspaces w JOIN organizations o ON o.id = w.org_id
         WHERE o.slug IN (${orgList}) ORDER BY o.slug, w.slug`,
  )) {
    lines.push(
      `workspace ${String(r.org)}/${String(r.slug)} "${String(r.name)}" ${String(r.status)} default=${String(r.d)}${id(r.id)}`,
    );
  }
  for (const r of await rows<Record<string, unknown>>(
    db,
    sql`SELECT t.id, o.slug AS org, w.slug AS ws, t.name, t.status::text AS status
          FROM teams t JOIN organizations o ON o.id = t.org_id JOIN workspaces w ON w.id = t.workspace_id
         WHERE o.slug IN (${orgList}) ORDER BY o.slug, w.slug, t.name`,
  )) {
    lines.push(
      `team ${String(r.org)}/${String(r.ws)} "${String(r.name)}" ${String(r.status)}${id(r.id)}`,
    );
  }

  const emailList = sql.join(
    emails.map((e) => sql`${e}`),
    sql`, `,
  );
  for (const r of await rows<Record<string, unknown>>(
    db,
    sql`SELECT id, lower(email) AS email, status::text AS status, password_hash AS digest FROM users
         WHERE lower(email) IN (${emailList}) ORDER BY lower(email)`,
  )) {
    lines.push(
      `user ${String(r.email)} ${String(r.status)} credential=${r.digest ? 'set' : 'none'}` +
        (options.withIds
          ? ` #${String(r.id)} digest=${createHash('sha256').update(String(r.digest)).digest('hex').slice(0, 16)}`
          : ''),
    );
  }
  for (const r of await rows<Record<string, unknown>>(
    db,
    sql`SELECT ur.id, lower(u.email) AS email, r.key AS role, ro.slug AS role_org,
               ur.scope_type::text AS scope_type,
               COALESCE(so.slug, tso.slug || '/' || t.name, rs.slug, '') AS target
          FROM user_roles ur
          JOIN users u ON u.id = ur.user_id
          JOIN roles r ON r.id = ur.role_id
          LEFT JOIN organizations ro ON ro.id = r.org_id
          LEFT JOIN organizations so ON ur.scope_type = 'organization' AND so.id = ur.scope_id
          LEFT JOIN teams t ON ur.scope_type = 'team' AND t.id = ur.scope_id
          LEFT JOIN organizations tso ON tso.id = t.org_id
          LEFT JOIN resellers rs ON ur.scope_type = 'reseller' AND rs.id = ur.scope_id
         WHERE lower(u.email) IN (${emailList})
         ORDER BY 2, 3, 4, 5, 6`,
  )) {
    lines.push(
      `grant ${String(r.email)} ${String(r.role)}@${String(r.role_org ?? 'platform')} ${String(r.scope_type)}:${String(r.target)}${id(r.id)}`,
    );
  }
  return lines;
}

export function digestLines(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The expected grant lines, derived from the topology alone (for the manifest and tests). */
export function expectedGrantKeys(): string[] {
  return USER_REFS.flatMap((ref) =>
    USERS[ref].grants.map((g) => grantKey(USERS[ref].email, g)),
  ).sort();
}

export { DEFAULT_WORKSPACE_SLUG };
