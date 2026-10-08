/**
 * Tenant-content table tooling for the integration suites (ADR-015 R-7,
 * ADR-014 §17.1).
 *
 * Two things live here because two suites need them:
 *
 * - `contentTableViolations` — the catalogue checker every table in
 *   `CONTENT_TABLES` must pass. It is one function so that the suite proving it
 *   rejects bad shapes (on disposable fixture tables) and the suite applying it
 *   to the registry run exactly the same code.
 * - `contentFixtureDdl` — a disposable, test-only content table with exactly the
 *   §17.1 policy shape, created by a suite on its own clone and dropped again.
 *   No migration creates a content table (Phase 3.1 is not authorized).
 */
import type { PoolClient } from 'pg';

/** The org-equality term, as PostgreSQL renders it in `pg_policies`. */
export const CONTENT_ORG_TERM = '(org_id = app_current_org_id())';

/** The validated-context term — the InitPlan form — as PostgreSQL renders it. */
export const CONTENT_CONTEXT_TERM =
  '( SELECT app_content_context_valid() AS app_content_context_valid)';

/** P, exactly as PostgreSQL renders `org_id = app_current_org_id() AND (SELECT app_content_context_valid())`. */
export const CONTENT_PREDICATE = `(${CONTENT_ORG_TERM} AND ${CONTENT_CONTEXT_TERM})`;

/** References that give a policy reseller, platform or tenancy-hierarchy reach. */
export const FORBIDDEN_CONTENT_REFERENCES =
  /app_org_in_scope|app_is_platform_admin|app_current_reseller_id|app_org_reseller|app_has_platform_/;

const NON_APP_PRINCIPALS = ['public', 'acc_auth', 'acc_relay'];

/**
 * Every way `table` departs from the tenant-content rule; empty when it
 * conforms. Reads the catalogue only, through `client` (so a caller can run it
 * inside the transaction that created a fixture and roll both back).
 *
 * The rule: RLS enabled (not forced — `principals.int-spec.ts` records why the
 * repository never relies on FORCE); every PERMISSIVE `acc_app` policy has
 * exactly P as each expression it carries (USING and/or WITH CHECK); a
 * RESTRICTIVE one may narrow further but must still contain both terms; no
 * expression references a reseller/platform helper or is a bare `true`; no
 * policy targets PUBLIC, `acc_auth` or `acc_relay`; no DELETE or TRUNCATE
 * grant to anyone; no table or column grant to PUBLIC, `acc_auth` or
 * `acc_relay`.
 */
export async function contentTableViolations(client: PoolClient, table: string): Promise<string[]> {
  const out: string[] = [];
  const rel = await client.query<{ rls: boolean }>(
    `SELECT c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r', 'p')`,
    [table],
  );
  if (rel.rows.length === 0) return [`${table}: no such table`];
  if (!rel.rows[0]!.rls) out.push(`${table}: row-level security is not enabled`);

  const policies = await client.query<{
    policyname: string;
    permissive: string;
    roles: string[];
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check
     FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
    [table],
  );
  if (policies.rows.length === 0) out.push(`${table}: no policy`);
  for (const p of policies.rows) {
    const name = `${table}.${p.policyname}`;
    for (const role of p.roles) {
      if (NON_APP_PRINCIPALS.includes(role)) out.push(`${name}: targets ${role}`);
    }
    const expressions = [p.qual, p.with_check].filter((e): e is string => e !== null);
    for (const expression of expressions) {
      if (FORBIDDEN_CONTENT_REFERENCES.test(expression)) {
        out.push(`${name}: references a reseller/platform helper: ${expression}`);
      }
      if (/(^|[^a-z_])true([^a-z_]|$)/i.test(expression)) {
        out.push(`${name}: has a true expression: ${expression}`);
      }
    }
    if (!p.roles.includes('acc_app')) continue;
    if (expressions.length === 0) out.push(`${name}: acc_app policy without an expression`);
    for (const expression of expressions) {
      if (p.permissive === 'PERMISSIVE') {
        if (expression !== CONTENT_PREDICATE) {
          out.push(`${name}: permissive acc_app expression is not exactly P: ${expression}`);
        }
      } else if (
        !expression.includes(CONTENT_ORG_TERM) ||
        !expression.includes('app_content_context_valid()')
      ) {
        out.push(`${name}: restrictive acc_app expression lacks a term of P: ${expression}`);
      }
    }
  }

  // The owner's implicit privileges are listed too; the owner is the migration
  // principal, exempt from RLS by design, and is not what this rule is about.
  const grants = await client.query<{ grantee: string; privilege_type: string }>(
    `SELECT grantee, privilege_type FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = $1
     UNION
     SELECT grantee, privilege_type FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const owner = (
    await client.query<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = ('public.' || $1)::regclass`,
      [table],
    )
  ).rows[0]!.owner;
  // `information_schema` spells PUBLIC in capitals.
  for (const g of grants.rows.filter((row) => row.grantee !== owner)) {
    const grantee = g.grantee.toLowerCase();
    if (g.privilege_type === 'DELETE' || g.privilege_type === 'TRUNCATE') {
      out.push(`${table}: ${g.privilege_type} granted to ${grantee}`);
    }
    if (NON_APP_PRINCIPALS.includes(grantee)) {
      out.push(`${table}: ${g.privilege_type} granted to ${grantee}`);
    }
  }
  return [...new Set(out)];
}

/**
 * DDL for a disposable content fixture with exactly the §17.1 shape:
 * `org_id NOT NULL`, nullable `workspace_id` with the composite FK, RLS
 * enabled, SELECT/UPDATE `USING (P)`, INSERT/UPDATE `WITH CHECK (P)`, all
 * `TO acc_app`, and SELECT/INSERT/UPDATE (no DELETE) granted to `acc_app`.
 */
export function contentFixtureDdl(table: string): string[] {
  if (!/^s4_[a-z0-9_]+$/.test(table)) throw new Error(`fixture name ${table} must start with s4_`);
  const P = 'org_id = app_current_org_id() AND (SELECT app_content_context_valid())';
  return [
    `CREATE TABLE ${table} (
       id uuid PRIMARY KEY DEFAULT uuidv7(),
       org_id uuid NOT NULL REFERENCES organizations(id),
       workspace_id uuid,
       label text NOT NULL,
       CONSTRAINT ${table}_workspace_org_fk FOREIGN KEY (workspace_id, org_id)
         REFERENCES workspaces(id, org_id))`,
    `CREATE INDEX ${table}_org_id_idx ON ${table} (org_id)`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `CREATE POLICY ${table}_select ON ${table} FOR SELECT TO acc_app USING (${P})`,
    `CREATE POLICY ${table}_insert ON ${table} FOR INSERT TO acc_app WITH CHECK (${P})`,
    `CREATE POLICY ${table}_update ON ${table} FOR UPDATE TO acc_app USING (${P}) WITH CHECK (${P})`,
    `GRANT SELECT, INSERT, UPDATE ON ${table} TO acc_app`,
  ];
}
