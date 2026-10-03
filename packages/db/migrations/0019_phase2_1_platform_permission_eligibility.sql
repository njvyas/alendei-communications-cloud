-- =============================================================================
-- Phase 2.1 Gate D.1 remediation — one eligibility model for catalogue writes
-- and their audit records (ADR-013 F-3, 2.1 notes)
--
-- Migration `0018` made catalogue *reads* eligible for any validated
-- platform-scope principal, naming no role. Two things still disagreed with
-- that model:
--
--   1. Catalogue *writes* were admitted on platform scope alone, while the
--      application required `providers.manage`. The database now requires the
--      same thing the application does.
--   2. A provider mutation's audit row could only be inserted under
--      `app_is_platform_admin()` (`audit_logs_insert`, migration `0001`), which
--      is bound to the role key `alendei_super_admin` — so a second platform role
--      holding `providers.manage` passed authorization and RLS and then failed
--      at its audit write.
--
-- The canonical eligibility for a catalogue write and its audit record is now
-- one predicate, used by both:
--
--   active user + a platform-scope grant + whose role carries the permission
--
-- `app_has_platform_permission(permission)` below. It names no role. Reads keep
-- `app_has_platform_scope()` (`0018`) unchanged.
--
-- Also (Gate D.1 item 3): a validated platform-scope principal may record its
-- *own* `authorization.denied` row at platform scope, so a refusal of, for
-- example, `alendei_support` is audited through the ordinary denial mechanism
-- instead of being unattributable.
--
-- What is deliberately NOT changed: `audit_logs_insert`, `audit_logs_select`,
-- `audit_logs_auth_insert`, the append-only and scope-derivation triggers, and
-- every other policy. The two audit policies added here are additional
-- permissive INSERT policies, each admitting only an exact row shape.
-- =============================================================================

-- --- The permission-carrying platform eligibility ------------------------------
-- True when `app.current_user_id` is an active user holding a platform-scope
-- grant whose role carries `p_permission`, validated against current grants and
-- role permissions. No role key and no flag is consulted: neither
-- `app.is_platform_admin` nor any role name is part of the answer. The owner /
-- maintenance session keeps its documented bypass.
CREATE FUNCTION app_has_platform_permission(p_permission text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := nullif(current_setting('app.current_user_id', true), '')::uuid;
  IF v_user IS NOT NULL AND EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = ur.user_id
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = v_user
      AND ur.scope_type = 'platform'
      AND r.org_id IS NULL
      AND u.status = 'active'
      AND p.key = p_permission
  ) THEN
    RETURN true;
  END IF;

  RETURN app_session_bypasses_rls();
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_has_platform_permission(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_has_platform_permission(text) TO acc_app;
--> statement-breakpoint

-- --- Catalogue writes require the permission the application requires ---------
-- Reads stay on platform-scope eligibility (`0018`). `channels` has no write
-- grant at all, so it needs no write policy.
DROP POLICY providers_platform ON providers;
--> statement-breakpoint
CREATE POLICY providers_platform_read ON providers FOR SELECT TO acc_app
  USING (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY providers_platform_insert ON providers FOR INSERT TO acc_app
  WITH CHECK (app_has_platform_permission('providers.manage'));
--> statement-breakpoint
CREATE POLICY providers_platform_update ON providers FOR UPDATE TO acc_app
  USING (app_has_platform_permission('providers.manage'))
  WITH CHECK (app_has_platform_permission('providers.manage'));
--> statement-breakpoint
DROP POLICY provider_capabilities_platform ON provider_capabilities;
--> statement-breakpoint
CREATE POLICY provider_capabilities_platform_read ON provider_capabilities FOR SELECT TO acc_app
  USING (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY provider_capabilities_platform_insert ON provider_capabilities FOR INSERT TO acc_app
  WITH CHECK (app_has_platform_permission('providers.manage'));
--> statement-breakpoint
CREATE POLICY provider_capabilities_platform_update ON provider_capabilities FOR UPDATE TO acc_app
  USING (app_has_platform_permission('providers.manage'))
  WITH CHECK (app_has_platform_permission('providers.manage'));
--> statement-breakpoint
CREATE POLICY provider_capabilities_platform_delete ON provider_capabilities FOR DELETE TO acc_app
  USING (app_has_platform_permission('providers.manage'));
--> statement-breakpoint

-- --- Provider audit rows: the same eligibility, an exact row shape -------------
-- Admits exactly a provider mutation's success row, at platform scope, recorded
-- by the current user as its own actor, and only for a user who may perform the
-- mutation. Every other audit row is still governed by `audit_logs_insert`.
CREATE POLICY audit_logs_provider_insert ON audit_logs FOR INSERT TO acc_app
  WITH CHECK (
    scope_type = 'platform'
    AND scope_id IS NULL
    AND actor_type = 'user'
    AND actor_user_id = app_current_user_id()
    AND outcome = 'success'
    AND resource_type = 'Provider'
    AND action IN (
      'provider.created',
      'provider.updated',
      'provider.capabilities_replaced',
      'provider.enabled',
      'provider.disabled',
      'provider.drained'
    )
    AND app_has_platform_permission('providers.manage')
  );
--> statement-breakpoint

-- --- A platform-scope principal's own refusal (Gate D.1 item 3) ---------------
-- ADR-005 D-6 files a denial at the actor's own legitimate scope. For a
-- validated platform-scope principal that is not `alendei_super_admin` (today:
-- `alendei_support`) with no organization selected, that scope is `platform`,
-- which `audit_logs_insert` reserves for `app_is_platform_admin()`. This admits
-- exactly such a principal's own denial row and nothing else: the actor must be
-- the current user, the outcome `denied`, the action `authorization.denied`.
CREATE POLICY audit_logs_platform_self_denial_insert ON audit_logs FOR INSERT TO acc_app
  WITH CHECK (
    scope_type = 'platform'
    AND scope_id IS NULL
    AND actor_type = 'user'
    AND actor_user_id = app_current_user_id()
    AND action = 'authorization.denied'
    AND outcome = 'denied'
    AND app_has_platform_scope()
  );
