-- =============================================================================
-- Phase 1C.6 remediation — pre-existing SECURITY DEFINER trigger functions
-- (Phase 1C.6 security review finding H-3; DATABASE.md §Migration 0016)
--
-- Migration 0015 made the three 1C.6 SECURITY DEFINER trigger functions
-- trigger-only. The same exposure existed in the six older ones: they kept
-- the default ACL, so PUBLIC — and therefore `acc_app`, `acc_auth` and
-- `acc_relay` — could attach any of them to a temporary table of its own and
-- run its body as the owner on rows of its choosing. `fn_validate_audit_scope`
-- and `fn_validate_role_permission` disclosed, that way, whether supplied
-- cross-tenant ids exist and which organization (and workspace) owns them.
--
-- This revokes PUBLIC's EXECUTE on exactly those six. PostgreSQL checks EXECUTE
-- on a trigger function when a trigger is created, never when it fires, so
-- every existing trigger keeps running unchanged for every writer. Function
-- bodies, ownership, triggers, RLS policies, tables and every other grant are
-- untouched; no other function is changed.
-- =============================================================================

REVOKE ALL ON FUNCTION fn_validate_audit_scope() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_validate_role_permission() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_protect_system_role_permissions() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_protect_system_roles() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_user_roles_platform_admin_guard() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_users_platform_admin_guard() FROM PUBLIC;
