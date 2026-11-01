-- =============================================================================
-- Migration: 0039_u13_3_domain_platform_read
-- Issue: Phase 4 U13.3 Global Domain & White-Label Operational Oversight
--
-- Lets a platform operator holding `platform.tenants.read` READ every row of
-- organization_domains, for the platform domain registry (/platform/domains).
--
-- Why a policy: `organization_domains_select` (0038) admits a row only when
-- app_org_in_scope(org_id) — the selected organization, a reseller context, or
-- the RLS platform-administrator claim. `alendei_support` holds
-- `platform.tenants.read` but is deliberately not an RLS platform
-- administrator (ADR-011 D-2), so without this policy the registry would be
-- empty for it while the application had authorized the read.
--
-- Scope of the change:
--   - SELECT only, acc_app only. No write policy is added or changed, so every
--     write still goes through the U12 routes and `organization_domains_write`.
--   - The predicate is the same SECURITY DEFINER check the provider catalogue
--     uses (0019): an active user holding the permission through a
--     platform-scope role. No role key and no session flag is consulted.
--   - acc_auth's policy (active + verified only, for hostname resolution) is
--     unchanged.
--   - `app_current_user_id() IS NOT NULL` makes the session binding explicit
--     (schema.int-spec: every acc_app policy on an org-scoped table resolves
--     through session variables) and excludes the function's maintenance-
--     bypass branch: only a signed-in user's request context qualifies.
--
-- Rollback: DROP POLICY IF EXISTS "organization_domains_platform_read" ON "organization_domains";
-- =============================================================================

DROP POLICY IF EXISTS "organization_domains_platform_read" ON "organization_domains";--> statement-breakpoint
CREATE POLICY "organization_domains_platform_read" ON "organization_domains" FOR SELECT TO acc_app
  USING (app_current_user_id() IS NOT NULL AND app_has_platform_permission('platform.tenants.read'));
