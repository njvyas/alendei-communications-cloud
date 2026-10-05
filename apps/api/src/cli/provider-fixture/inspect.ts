/**
 * Read-only inspection of the provider-console fixture, as the schema owner.
 *
 * As in the Phase 1C.4a fixture, everything is decided before anything is
 * written: each object is found by its natural key, every incompatible
 * existing object is a conflict (the run aborts with nothing written), and the
 * plan lists only what is missing. A fixture provider part-way along its
 * lifecycle path (`disabled → active → draining`) is completed, never moved
 * back; anything else is never "corrected".
 *
 * Nothing here writes. Every statement is a `SELECT`.
 */
import { PLATFORM_ROLE_KEYS } from '@acc/contracts';
import type { Database } from '@acc/db';
import { sql } from 'drizzle-orm';

import {
  PERSONA_REFS,
  PERSONAS,
  PLATFORM_ROLES,
  PROVIDER_REFS,
  PROVIDERS,
  ROLE_REFS,
  personaRoleKey,
  type FixtureRoleRef,
  type PersonaRef,
  type ProviderRef,
} from './topology';

export type ProviderPlanStep =
  | { kind: 'create-provider'; provider: ProviderRef }
  | { kind: 'transition'; provider: ProviderRef; action: 'enable' | 'drain' }
  | { kind: 'replace-capabilities'; provider: ProviderRef }
  | { kind: 'create-platform-role'; role: FixtureRoleRef }
  | { kind: 'create-persona'; persona: PersonaRef };

export interface ProviderFixtureState {
  readonly operator: { readonly id: string; readonly email: string } | null;
  readonly channels: Record<string, string>;
  readonly providers: Partial<Record<ProviderRef, { id: string; status: string }>>;
  readonly roles: Partial<Record<FixtureRoleRef, { id: string }>>;
  readonly seededRoles: Record<string, string>;
  readonly personas: Partial<Record<PersonaRef, { id: string }>>;
}

export interface ProviderInspection {
  readonly state: ProviderFixtureState;
  readonly plan: ProviderPlanStep[];
  /** Missing prerequisites: the run is refused before anything is written. */
  readonly refusals: string[];
  /** Incompatible existing objects: refused, never corrected. */
  readonly conflicts: string[];
}

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** The transitions that take a fixture provider from `current` to `target`, or null if it cannot. */
function pathTo(current: string, target: string): ('enable' | 'drain')[] | null {
  const order = ['disabled', 'active', 'draining'];
  if (target === 'disabled') return current === 'disabled' ? [] : null;
  const from = order.indexOf(current);
  const to = order.indexOf(target);
  if (from < 0 || from > to) return null;
  return (['enable', 'drain'] as const).slice(from, to);
}

export async function inspectProviderFixture(
  db: Database,
  operatorEmail: string,
): Promise<ProviderInspection> {
  const plan: ProviderPlanStep[] = [];
  const refusals: string[] = [];
  const conflicts: string[] = [];
  const q = async <T>(query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];

  // The Phase 1C.4a operator — the platform administrator the API phase signs in as.
  const [operator] = await q<{ id: string; email: string }>(
    sql`SELECT u.id, lower(u.email) AS email FROM users u
          JOIN user_roles ur ON ur.user_id = u.id AND ur.scope_type = 'platform'
          JOIN roles r ON r.id = ur.role_id AND r.org_id IS NULL AND r.key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN}
         WHERE lower(u.email) = ${operatorEmail} AND u.status = 'active'`,
  );
  if (!operator) {
    refusals.push(
      `the platform administrator ${operatorEmail} does not exist — run fixture:dev first`,
    );
  }

  const channels = Object.fromEntries(
    (
      await q<{ code: string; id: string }>(
        sql`SELECT code::text AS code, id FROM channels WHERE code::text IN (${list([
          ...new Set(PROVIDER_REFS.map((r) => PROVIDERS[r].channel)),
        ])})`,
      )
    ).map((c) => [c.code, c.id]),
  );
  for (const ref of PROVIDER_REFS) {
    if (!channels[PROVIDERS[ref].channel])
      refusals.push(`channel ${PROVIDERS[ref].channel} is missing — migrations not applied`);
  }

  // --- providers ---------------------------------------------------------------
  const providers: ProviderFixtureState['providers'] = {};
  const rows = await q<{
    id: string;
    channel: string;
    name: string;
    adapterKey: string;
    status: string;
    capabilities: { key: string; value: unknown }[];
  }>(
    sql`SELECT p.id, c.code::text AS channel, p.name, p.adapter_key AS "adapterKey", p.status::text AS status,
               coalesce((SELECT json_agg(json_build_object('key', pc.capability_key, 'value', pc.value)
                                         ORDER BY pc.capability_key)
                           FROM provider_capabilities pc WHERE pc.provider_id = p.id), '[]'::json) AS capabilities
          FROM providers p JOIN channels c ON c.id = p.channel_id
         WHERE lower(p.name) IN (${list(PROVIDER_REFS.map((r) => PROVIDERS[r].name.toLowerCase()))})`,
  );
  for (const ref of PROVIDER_REFS) {
    const spec = PROVIDERS[ref];
    const row = rows.find(
      (r) => r.channel === spec.channel && r.name.toLowerCase() === spec.name.toLowerCase(),
    );
    const elsewhere = rows.find(
      (r) => r.channel !== spec.channel && r.name.toLowerCase() === spec.name.toLowerCase(),
    );
    if (elsewhere) conflicts.push(`provider "${spec.name}" exists on channel ${elsewhere.channel}`);
    if (!row) {
      plan.push({ kind: 'create-provider', provider: ref });
      for (const action of pathTo('disabled', spec.status)!)
        plan.push({ kind: 'transition', provider: ref, action });
      if (spec.capabilities.length > 0) plan.push({ kind: 'replace-capabilities', provider: ref });
      continue;
    }
    providers[ref] = { id: row.id, status: row.status };
    if (row.name !== spec.name || row.adapterKey !== 'simulator') {
      conflicts.push(`provider "${spec.name}" has a different name or adapter key`);
      continue;
    }
    const path = pathTo(row.status, spec.status);
    if (!path) {
      conflicts.push(`provider "${spec.name}" is ${row.status}, not ${spec.status}`);
      continue;
    }
    for (const action of path) plan.push({ kind: 'transition', provider: ref, action });
    const want = JSON.stringify([...spec.capabilities].sort((a, b) => a.key.localeCompare(b.key)));
    const have = JSON.stringify(row.capabilities);
    if (have !== want) {
      if (row.capabilities.length === 0) plan.push({ kind: 'replace-capabilities', provider: ref });
      else conflicts.push(`provider "${spec.name}" has different capabilities`);
    }
  }

  // --- platform roles --------------------------------------------------------
  const roleRows = await q<{
    id: string;
    key: string;
    name: string;
    isSystemRole: boolean;
    allowedScopeTypes: string[];
    permissions: string[];
  }>(
    sql`SELECT r.id, r.key, r.name, r.is_system_role AS "isSystemRole",
               r.allowed_scope_types::text[] AS "allowedScopeTypes",
               coalesce(array(SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                               WHERE rp.role_id = r.id ORDER BY p.key), '{}') AS permissions
          FROM roles r
         WHERE r.org_id IS NULL
           AND r.key IN (${list([...ROLE_REFS.map((ref) => PLATFORM_ROLES[ref].key), PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT])})`,
  );
  const roles: ProviderFixtureState['roles'] = {};
  for (const ref of ROLE_REFS) {
    const spec = PLATFORM_ROLES[ref];
    const row = roleRows.find((r) => r.key === spec.key);
    if (!row) {
      plan.push({ kind: 'create-platform-role', role: ref });
      continue;
    }
    roles[ref] = { id: row.id };
    if (
      row.name !== spec.name ||
      row.isSystemRole ||
      JSON.stringify(row.allowedScopeTypes) !== JSON.stringify(['platform']) ||
      JSON.stringify(row.permissions) !== JSON.stringify([...spec.permissions].sort())
    ) {
      conflicts.push(`platform role ${spec.key} differs from the fixture definition`);
    }
  }
  const seededRoles: Record<string, string> = {};
  const support = roleRows.find((r) => r.key === PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT);
  if (support) seededRoles[PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT] = support.id;
  else refusals.push('the seeded alendei_support role is missing — run db:seed first');

  // --- personas ---------------------------------------------------------------
  const personas: ProviderFixtureState['personas'] = {};
  const userRows = await q<{ id: string; email: string; status: string; hasCredential: boolean }>(
    sql`SELECT id, lower(email) AS email, status::text AS status, password_hash IS NOT NULL AS "hasCredential"
          FROM users WHERE lower(email) IN (${list(PERSONA_REFS.map((r) => PERSONAS[r].email))})`,
  );
  const grantRows = userRows.length
    ? await q<{ userId: string; roleKey: string; scopeType: string; scopeId: string | null }>(
        sql`SELECT ur.user_id AS "userId", r.key AS "roleKey", ur.scope_type::text AS "scopeType", ur.scope_id AS "scopeId"
              FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id IN (${list(userRows.map((u) => u.id))})`,
      )
    : [];
  for (const ref of PERSONA_REFS) {
    const row = userRows.find((u) => u.email === PERSONAS[ref].email);
    if (!row) {
      plan.push({ kind: 'create-persona', persona: ref });
      continue;
    }
    personas[ref] = { id: row.id };
    const grants = grantRows
      .filter((g) => g.userId === row.id)
      .map((g) => `${g.roleKey}@${g.scopeType}:${g.scopeId ?? ''}`);
    if (row.status !== 'active' || !row.hasCredential) {
      conflicts.push(`persona ${PERSONAS[ref].email} is ${row.status} or has no credential`);
    } else if (JSON.stringify(grants) !== JSON.stringify([`${personaRoleKey(ref)}@platform:`])) {
      conflicts.push(`persona ${PERSONAS[ref].email} holds different grants: ${grants.join(', ')}`);
    }
  }

  return {
    state: { operator: operator ?? null, channels, providers, roles, seededRoles, personas },
    plan,
    refusals,
    conflicts,
  };
}
