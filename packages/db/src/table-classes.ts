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
  'organization_domains',
  'workspaces',
  'teams',
  'roles',
  'role_permissions',
  'user_roles',
  'api_keys',
  'ws_tickets',
  'idempotency_keys',
  'audit_logs',
  'organization_provider_assignments',
  'message_dispatch_queue',
] as const;

/**
 * Tenant-content tables (Model B, ADR-015 R-7 … R-10, ADR-014 §17.1).
 * Phase 3.1 Data Foundation tables + Phase 3.3 Message Orchestrator tables.
 */
export const CONTENT_TABLES = [
  'campaigns',
  'campaign_recipients',
  'contacts',
  'contact_identities',
  'consent_events',
  'templates',
  'suppressions',
  'messages',
  'message_attempts',
  'message_events',
] as const;

/**
 * Tables with an `org_id` column that are in neither class, each with its
 * reason.
 *
 * Phase 7 PR 7-1 (DP-3, `DECISIONS.md` §1zi) — the financial tables
 * `usage_ledger`, `wallets` and `credit_accounts`: no application role holds any
 * privilege on them, and they are reached only through SECURITY DEFINER
 * functions (`app_ledger_post`, executable by no application role in PR 7-1).
 * They fit neither class: tenant content requires `acc_app` SELECT, INSERT and
 * UPDATE, and a tenancy record is reachable through `app_org_in_scope`. RLS is
 * enabled. Phase 7 PR 7-6a (0055, D-76-2): `acc_app` has SELECT only, under
 * organization-scoped tenant SELECT policies (the ledger's admits only the
 * tenant-visible entry types); there is still no write privilege or policy. The monthly `usage_ledger` partitions are
 * not listed: the census treats each partition as its parent, and every
 * partition carries the parent's protections (`app_ledger_partition_report`).
 */
export const ORG_ID_EXEMPT_TABLES: readonly string[] = [
  'usage_ledger',
  'wallets',
  'credit_accounts',
  // Phase 7 PR 7-2 (migration 0051): `customer_pricing_assignments` is platform
  // pricing administration (org_id NULL = the platform default); acc_app reaches
  // it only under a validated platform-scope claim (`app_has_platform_scope()`),
  // like the provider catalogue — neither tenant content nor a tenancy record.
  // `pricing_evaluations` has no application-role privilege at all: it is
  // written and read only by the SECURITY DEFINER rating functions.
  'customer_pricing_assignments',
  'pricing_evaluations',
  // Phase 7 PR 7-5 (migration 0054): the reached-provider classification of settled
  // attempts. No application-role privilege at all: written and read only by the
  // acc_dispatch settlement functions (SECURITY DEFINER); RLS on, no policy.
  'message_attempt_billing',
];
