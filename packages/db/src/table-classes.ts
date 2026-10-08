/**
 * The RLS class of every tenant-bearing table (ADR-015 R-7 … R-10, ADR-014
 * §17.1; `DATABASE.md` §2, `TENANCY.md` §3a).
 *
 * Two predicates exist, by table class, and a table must be in exactly one
 * class — `packages/db/src/test/table-classes.int-spec.ts` fails for every
 * public table carrying an `org_id` column that is in none, or in more than one,
 * so a new table cannot fall into a class by default:
 *
 * - **Tenancy records** keep `app_org_in_scope(org_id)` — reseller- and
 *   platform-aware, the documented administration hierarchy.
 * - **Tenant content** uses, for `acc_app` only,
 *   `org_id = app_current_org_id() AND (SELECT app_content_context_valid())`:
 *   no reseller, platform, support or break-glass reach (R-7, R-8). SELECT and
 *   UPDATE `USING` it, INSERT and UPDATE `WITH CHECK` it, no DELETE grant, no
 *   policy or grant for `acc_auth`, `acc_relay` or PUBLIC. The catalogue test
 *   checks every table listed here against exactly that.
 *
 * R-10 classification, for tables that do not exist yet:
 * `organization_provider_assignments` is a tenancy record (control-plane data);
 * `message_dispatch_queue` is not tenant content while it stays content-free
 * (identifiers, state, claim and fencing only). Neither goes in
 * `CONTENT_TABLES`.
 */

/**
 * Tables whose `acc_app` policies use `app_org_in_scope` (or, for
 * `organizations`, the organization's own id). `organizations` is listed
 * although it has no `org_id` column: it is the root of the same class.
 */
export const TENANCY_RECORD_TABLES = [
  'organizations',
  'workspaces',
  'teams',
  'roles',
  'role_permissions',
  'user_roles',
  'api_keys',
  'ws_tickets',
  'idempotency_keys',
  'audit_logs',
] as const;

/**
 * Tenant-content tables (Model B). Empty until Phase 3.1 creates the first
 * one in the same migration as its policies (`DATABASE.md` §2).
 */
export const CONTENT_TABLES: readonly string[] = [];

/**
 * Tables with an `org_id` column that are in neither class, each with its
 * reason. Empty: every such table today is a tenancy record.
 */
export const ORG_ID_EXEMPT_TABLES: readonly string[] = [];
