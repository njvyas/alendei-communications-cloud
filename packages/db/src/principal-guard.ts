import type { Pool } from 'pg';

/**
 * What the database says about the principal a pool actually logs in as.
 *
 * Row-Level Security binds a principal only while it is neither a superuser,
 * nor `BYPASSRLS`, nor (because RLS is enabled but not forced) a member of the
 * role that owns a table. Every one of those is a configuration fact that can
 * drift — a connection string pointed at the owner, an `ALTER ROLE` run by hand,
 * an `ALTER TABLE … OWNER TO` in a migration — and none of them is visible to
 * the application's own tests, which would all stay green.
 */
export interface PrincipalPosture {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** Tables in `public` owned by this principal or by a role it is a member of. */
  readonly ownedTables: readonly string[];
  /** Roles this principal is a member of (and could therefore `SET ROLE` to). */
  readonly memberOf: readonly string[];
}

export async function inspectPrincipal(pool: Pool): Promise<PrincipalPosture> {
  const { rows } = await pool.query<{
    role: string;
    superuser: boolean;
    bypass_rls: boolean;
    owned_tables: string[] | null;
    member_of: string[] | null;
  }>(`
    SELECT
      r.rolname AS role,
      r.rolsuper AS superuser,
      r.rolbypassrls AS bypass_rls,
      (SELECT array_agg(c.relname::text ORDER BY c.relname)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS owned_tables,
      (SELECT array_agg(g.rolname::text ORDER BY g.rolname)
         FROM pg_roles g
        WHERE g.rolname <> current_user
          AND g.rolname NOT LIKE 'pg\\_%'
          AND pg_has_role(current_user, g.oid, 'MEMBER')) AS member_of
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);
  const row = rows[0];
  if (!row) throw new Error('principal guard: current_user has no pg_roles row');
  return {
    role: row.role,
    superuser: row.superuser,
    bypassRls: row.bypass_rls,
    ownedTables: row.owned_tables ?? [],
    memberOf: row.member_of ?? [],
  };
}

/** The reasons a posture is unfit for an RLS-bound application pool. */
export function postureViolations(posture: PrincipalPosture): string[] {
  const problems: string[] = [];
  if (posture.superuser) problems.push(`${posture.role} is a superuser`);
  if (posture.bypassRls) problems.push(`${posture.role} has BYPASSRLS`);
  if (posture.ownedTables.length > 0) {
    problems.push(
      `${posture.role} owns (or is a member of the owner of) ${posture.ownedTables.join(', ')}`,
    );
  }
  if (posture.memberOf.length > 0) {
    problems.push(`${posture.role} is a member of ${posture.memberOf.join(', ')}`);
  }
  return problems;
}

export class PrincipalPostureError extends Error {
  constructor(
    readonly label: string,
    readonly problems: readonly string[],
  ) {
    super(
      `refusing to use the ${label} database pool: RLS would not bind its principal — ${problems.join('; ')}`,
    );
    this.name = 'PrincipalPostureError';
  }
}

/**
 * Refuses a pool whose login principal is not bound by RLS.
 *
 * Called at API start-up for every request-serving pool, so a misconfiguration
 * stops the process rather than silently turning the tenant boundary off.
 */
export async function assertRlsBoundPrincipal(
  pool: Pool,
  label: string,
): Promise<PrincipalPosture> {
  const posture = await inspectPrincipal(pool);
  const problems = postureViolations(posture);
  if (problems.length > 0) throw new PrincipalPostureError(label, problems);
  return posture;
}
