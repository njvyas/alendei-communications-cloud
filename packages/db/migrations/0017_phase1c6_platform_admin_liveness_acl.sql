-- =============================================================================
-- Phase 1C.6 remediation — fn_assert_platform_admin_remains() least privilege
-- (Phase 1C.6 security review finding H-4; DATABASE.md §Migration 0017)
--
-- The last-platform-admin liveness check is SECURITY DEFINER and kept the
-- default ACL, so any principal could call it directly: it takes the
-- platform-admin advisory lock and reveals whether an active platform
-- administrator exists. No application code calls it; its only callers are
-- `fn_user_roles_platform_admin_guard()` and `fn_users_platform_admin_guard()`,
-- SECURITY DEFINER trigger functions that run as the owner, so revoking
-- PUBLIC's EXECUTE leaves the liveness triggers unchanged.
--
-- Nothing else changes: not the body, owner, SECURITY DEFINER, any trigger,
-- table, RLS policy, grant or other function.
-- =============================================================================

REVOKE ALL ON FUNCTION fn_assert_platform_admin_remains() FROM PUBLIC;
