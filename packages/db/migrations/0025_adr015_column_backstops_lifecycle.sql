-- =============================================================================
-- ADR-015 remediation step 2 — column backstops, tenant-key immutability and the
-- organization lifecycle boundary (R-2 / HIGH-2, R-3 / MEDIUM-1, R-4 / MEDIUM-2;
-- DATABASE.md §2, §2a; TENANCY.md §3a; SECURITY.md §4b)
--
-- R-2  Column-level UPDATE grants on users, sessions, api_keys, ws_tickets; no
--      acc_app INSERT on sessions; acc_auth narrowed to the columns it writes;
--      an insert-shape trigger on users and revocation-terminal triggers on
--      sessions and api_keys. Option B: coverage of a subject's grants stays
--      the application's F-9 rule — no policy predicate changes on users or
--      sessions, and no new authorization helper.
-- R-3  org_id (and workspace_id) immutable on roles, workspaces, teams,
--      api_keys, idempotency_keys, and sessions.user_id, for every principal
--      including the owner; a team, workspace or reseller cannot be deleted
--      while a role grant is scoped to it; teams DELETE, user_roles UPDATE,
--      role_permissions UPDATE and idempotency_keys DELETE revoked from acc_app.
-- R-4  organization status*/billing_* need the validated
--      app_has_platform_permission('platform.tenants.manage'); slug is never
--      writable by an application principal; closed is terminal for every
--      application principal, platform included; only active→suspended,
--      active→closed, suspended→active, suspended→closed are legal; a new
--      organization starts active with no status metadata and default billing
--      unless platform.tenants.manage; reseller status, is_platform_default and
--      domain are platform-only; the provisioning arm of organizations_insert
--      binds reseller_id to the validated reseller claim unless
--      platform.tenants.manage.
--
-- UPDATE is the only verb narrowed by column. Drizzle names every column of the
-- table in an INSERT (DEFAULT for the ones not supplied), and PostgreSQL checks
-- column INSERT privilege for every named column, so a column INSERT grant
-- would break every insert; INSERT stays table-level and the protected INSERT
-- columns are guarded by triggers. The fn_set_updated_at triggers write
-- updated_at in BEFORE UPDATE; trigger assignments are not privilege-checked.
--
-- The owner (the migration principal; app_session_bypasses_rls()) is exempt
-- from the lifecycle, reseller, insert-shape and revocation-terminal guards,
-- exactly as from RLS — it is the operator and fixture principal. It is NOT
-- exempt from tenant-key immutability or the parent-delete restriction.
--
-- Error names: 42501 insufficient_privilege (authority, immutability, terminal
-- states), 23503 foreign_key_violation (parent still referenced), 23514
-- check_violation (illegal transition edge), each with a CONSTRAINT name.
--
-- Every new function is SECURITY INVOKER with a pinned search_path and no
-- PUBLIC EXECUTE (a trigger function needs none to fire). Rerun-safe: REVOKE /
-- GRANT are idempotent, functions and triggers use CREATE OR REPLACE, policies
-- ALTER POLICY.
--
-- The first statement verifies existing data and aborts the whole migration —
-- nothing applied — if a grant already references a missing or mismatched
-- parent (the immutability and restrict rules would freeze it) or more than one
-- reseller is the platform default.
-- =============================================================================

DO $$
DECLARE
  v_count  bigint;
  v_sample text;
BEGIN
  SELECT count(*), string_agg(id::text, ', ') INTO v_count, v_sample FROM (
    SELECT ur.id FROM user_roles ur
     WHERE (ur.scope_type = 'team' AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = ur.scope_id))
        OR (ur.scope_type = 'workspace' AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ur.scope_id))
        OR (ur.scope_type = 'reseller' AND NOT EXISTS (SELECT 1 FROM resellers r WHERE r.id = ur.scope_id))
     ORDER BY ur.id) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0025 verification failed [user_roles_scope_parent_exists]: % role grants reference a missing team, workspace or reseller (ids: %)', v_count, v_sample
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT count(*), string_agg(id::text, ', ') INTO v_count, v_sample FROM (
    SELECT ur.id FROM user_roles ur
      LEFT JOIN roles ro ON ro.id = ur.role_id
     WHERE (ur.scope_type = 'organization' AND ur.org_id IS DISTINCT FROM ur.scope_id)
        OR (ur.scope_type = 'team' AND ur.org_id IS DISTINCT FROM (SELECT t.org_id FROM teams t WHERE t.id = ur.scope_id))
        OR (ur.scope_type = 'workspace' AND ur.org_id IS DISTINCT FROM (SELECT w.org_id FROM workspaces w WHERE w.id = ur.scope_id))
        OR (ur.scope_type IN ('platform', 'reseller') AND ur.org_id IS NOT NULL)
        OR (ro.org_id IS NOT NULL AND ro.org_id IS DISTINCT FROM ur.org_id)
     ORDER BY ur.id) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0025 verification failed [user_roles_scope_org_consistent]: % role grants whose org_id disagrees with their scope or role (ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_count FROM resellers WHERE is_platform_default;
  IF v_count > 1 THEN
    RAISE EXCEPTION
      'migration 0025 verification failed [resellers_single_platform_default]: % resellers are the platform default', v_count
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint

-- --- 1. Column-level UPDATE grants (R-2, R-3, R-4) ---------------------------------
-- users: acc_app administers contact and lifecycle; acc_auth records a sign-in
-- and rehashes. email, password_hash, mfa_* are never writable by acc_app.
REVOKE UPDATE ON users FROM acc_app, acc_auth;
GRANT UPDATE (phone, status, updated_at) ON users TO acc_app;
GRANT UPDATE (last_login_at, password_hash, password_updated_at) ON users TO acc_auth;
--> statement-breakpoint
-- sessions: acc_app only revokes; only acc_auth creates and rotates.
REVOKE INSERT, UPDATE ON sessions FROM acc_app;
GRANT UPDATE (revoked_at, revoked_reason) ON sessions TO acc_app;
REVOKE UPDATE ON sessions FROM acc_auth;
GRANT UPDATE (family_id, rotated_at, replaced_by_session_id, reuse_detected_at,
              revoked_at, revoked_reason, last_used_at) ON sessions TO acc_auth;
--> statement-breakpoint
-- organizations: slug, id, created_at, updated_at are not writable.
REVOKE UPDATE ON organizations FROM acc_app;
GRANT UPDATE (name, legal_name, gstin, billing_mode, billing_policy,
              status, status_changed_at, status_reason, reseller_id) ON organizations TO acc_app;
--> statement-breakpoint
-- resellers: slug is not writable; status/is_platform_default/domain are
-- platform-only (trigger below).
REVOKE UPDATE ON resellers FROM acc_app;
GRANT UPDATE (name, domain, brand_config, default_markup_pct, status, is_platform_default)
  ON resellers TO acc_app;
--> statement-breakpoint
REVOKE UPDATE ON roles FROM acc_app;
GRANT UPDATE (name, description, allowed_scope_types, updated_at) ON roles TO acc_app;
--> statement-breakpoint
REVOKE UPDATE ON workspaces FROM acc_app;
GRANT UPDATE (name, status) ON workspaces TO acc_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON teams FROM acc_app;
GRANT UPDATE (name, status) ON teams TO acc_app;
--> statement-breakpoint
-- api_keys: acc_app only revokes; acc_auth only records use.
REVOKE UPDATE ON api_keys FROM acc_app, acc_auth;
GRANT UPDATE (revoked_at, revoked_reason, updated_at) ON api_keys TO acc_app;
GRANT UPDATE (last_used_at) ON api_keys TO acc_auth;
--> statement-breakpoint
-- A grant or a role's permission set changes by delete and insert, each
-- validated by its trigger; never by rewriting a row in place.
REVOKE UPDATE ON user_roles FROM acc_app;
REVOKE UPDATE ON role_permissions FROM acc_app;
--> statement-breakpoint
-- ws_tickets: consumption is acc_auth's, and only its two columns.
REVOKE UPDATE ON ws_tickets FROM acc_app, acc_auth;
GRANT UPDATE (consumed_at, consumed_ip) ON ws_tickets TO acc_auth;
--> statement-breakpoint
-- idempotency_keys: the claim/reclaim/finalize columns; never org_id, endpoint
-- or the key; never deleted by the application (expiry is a reclaim).
REVOKE UPDATE, DELETE ON idempotency_keys FROM acc_app;
GRANT UPDATE (request_hash, status, response_status_code, response_snapshot, completed_at,
              failure_reason, actor_user_id, actor_api_key_id, correlation_id, expires_at)
  ON idempotency_keys TO acc_app;
--> statement-breakpoint

-- --- 2. Tenant-key immutability (R-3) — every principal, the owner included -------
-- AFTER ROW, so a composite foreign key that already rejects the move (its RI
-- trigger sorts first) still reports 23503; this refuses every move no foreign
-- key sees. TG_ARGV names the immutable columns.
CREATE OR REPLACE FUNCTION fn_tenant_key_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_old  jsonb := to_jsonb(OLD);
  v_new  jsonb := to_jsonb(NEW);
  v_col  text;
BEGIN
  FOREACH v_col IN ARRAY TG_ARGV LOOP
    IF v_old -> v_col IS DISTINCT FROM v_new -> v_col THEN
      RAISE EXCEPTION '%: % of row % is immutable', TG_TABLE_NAME, v_col, OLD.id
        USING ERRCODE = 'insufficient_privilege',
              CONSTRAINT = TG_TABLE_NAME || '_' || v_col || '_immutable';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_tenant_key_immutable() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_roles_org_id_immutable
  AFTER UPDATE OF org_id ON roles FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_workspaces_org_id_immutable
  AFTER UPDATE OF org_id ON workspaces FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_teams_org_id_immutable
  AFTER UPDATE OF org_id, workspace_id ON teams FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id', 'workspace_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_api_keys_org_id_immutable
  AFTER UPDATE OF org_id, workspace_id ON api_keys FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id', 'workspace_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_idempotency_keys_org_id_immutable
  AFTER UPDATE OF org_id ON idempotency_keys FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_sessions_user_id_immutable
  AFTER UPDATE OF user_id ON sessions FOR EACH ROW
  WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('user_id');
--> statement-breakpoint

-- --- 3. Grant-scope parents cannot be deleted while referenced (R-3) --------------
-- user_roles.scope_id is polymorphic, so no foreign key can express this.
-- Insert/update of a grant is validated by fn_validate_user_role_scope; this
-- closes the delete side. Organization-scope grants need nothing: the
-- user_roles.org_id foreign key cascades. INVOKER: every grant scoped to a
-- team or workspace lies in its organization and the only deleters are the
-- owner (acc_app holds no DELETE on teams, workspaces or resellers).
CREATE OR REPLACE FUNCTION fn_scope_parent_restrict() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_roles ur
              WHERE ur.scope_type = TG_ARGV[0]::role_scope_type AND ur.scope_id = OLD.id) THEN
    RAISE EXCEPTION '%: % is still referenced by a role grant', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'user_roles_scope_id_' || TG_ARGV[0] || '_fk';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_scope_parent_restrict() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_teams_grant_restrict
  BEFORE DELETE ON teams FOR EACH ROW EXECUTE FUNCTION fn_scope_parent_restrict('team');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_workspaces_grant_restrict
  BEFORE DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION fn_scope_parent_restrict('workspace');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_resellers_grant_restrict
  BEFORE DELETE ON resellers FOR EACH ROW EXECUTE FUNCTION fn_scope_parent_restrict('reseller');
--> statement-breakpoint

-- --- 4. Organization lifecycle and billing authority (R-4) --------------------------
-- Keys on validated claims only (app_has_platform_permission re-reads the
-- caller's platform grant), never on app.current_org_id or the platform flag.
-- Order: closed terminal → lifecycle authority → legal edge → billing authority.
CREATE OR REPLACE FUNCTION fn_organizations_guard_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_manage boolean;
BEGIN
  IF app_session_bypasses_rls() THEN
    RETURN NEW;
  END IF;
  v_manage := app_has_platform_permission('platform.tenants.manage');

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.status_changed_at IS NOT NULL OR NEW.status_reason IS NOT NULL THEN
      RAISE EXCEPTION 'organizations: a new organization starts active, with no status history'
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'organizations_insert_lifecycle';
    END IF;
    IF (NEW.billing_mode IS DISTINCT FROM 'prepaid'
        OR NEW.billing_policy IS DISTINCT FROM 'charge_per_logical_message')
       AND NOT v_manage THEN
      RAISE EXCEPTION 'organizations: non-default billing requires platform.tenants.manage'
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'organizations_billing_authority';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'organizations: organization % is closed, which is terminal', OLD.id
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'organizations_closed_terminal';
  END IF;

  IF (NEW.status, NEW.status_changed_at, NEW.status_reason)
     IS DISTINCT FROM (OLD.status, OLD.status_changed_at, OLD.status_reason) THEN
    IF NOT v_manage THEN
      RAISE EXCEPTION 'organizations: the lifecycle of organization % requires platform.tenants.manage', OLD.id
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'organizations_lifecycle_authority';
    END IF;
    -- A lifecycle write is a transition: re-stamping the current status (e.g.
    -- suspended -> suspended with a new reason) is not one of the four edges.
    IF NOT (
         (OLD.status = 'active'    AND NEW.status IN ('suspended', 'closed'))
      OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'closed'))) THEN
      RAISE EXCEPTION 'organizations: illegal transition % -> % for organization %', OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'organizations_status_transition';
    END IF;
  END IF;

  IF (NEW.billing_mode, NEW.billing_policy) IS DISTINCT FROM (OLD.billing_mode, OLD.billing_policy)
     AND NOT v_manage THEN
    RAISE EXCEPTION 'organizations: billing of organization % requires platform.tenants.manage', OLD.id
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'organizations_billing_authority';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_organizations_guard_lifecycle() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_organizations_guard_lifecycle
  BEFORE INSERT OR UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION fn_organizations_guard_lifecycle();
--> statement-breakpoint

-- Provisioning arm bound to a validated claim: the organization being created
-- under app.provisioning must sit beneath the caller's validated reseller, or
-- the caller holds platform.tenants.manage. (The first two arms are unchanged.)
ALTER POLICY organizations_insert ON organizations
  WITH CHECK (
    app_is_platform_admin()
    OR (app_current_reseller_id() IS NOT NULL AND reseller_id = app_current_reseller_id())
    OR (app_is_provisioning() AND id = app_current_org_id()
        AND (reseller_id = app_current_reseller_id()
             OR app_has_platform_permission('platform.tenants.manage')))
  );
--> statement-breakpoint

-- --- 5. Reseller platform fields (R-4) ---------------------------------------------
CREATE OR REPLACE FUNCTION fn_resellers_guard_platform_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_session_bypasses_rls() OR app_has_platform_permission('platform.tenants.manage') THEN
    RETURN NEW;
  END IF;
  IF (NEW.status, NEW.is_platform_default, NEW.slug, NEW.domain)
     IS DISTINCT FROM (OLD.status, OLD.is_platform_default, OLD.slug, OLD.domain) THEN
    RAISE EXCEPTION 'resellers: status, platform default, slug and domain of reseller % are platform-administered', OLD.id
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'resellers_platform_fields';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_resellers_guard_platform_fields() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_resellers_guard_platform_fields
  BEFORE UPDATE ON resellers
  FOR EACH ROW EXECUTE FUNCTION fn_resellers_guard_platform_fields();
--> statement-breakpoint

-- --- 6. users insert shape, revocation terminal (R-2) -------------------------------
-- An application principal creates only an invited identity with no credential
-- or sign-in history; activation is an owner operation (bootstrap / CLIs).
CREATE OR REPLACE FUNCTION fn_users_insert_shape() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_session_bypasses_rls() THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'invited' OR NEW.password_hash IS NOT NULL OR NEW.password_updated_at IS NOT NULL
     OR NEW.mfa_enabled OR NEW.mfa_secret_ref IS NOT NULL OR NEW.last_login_at IS NOT NULL THEN
    RAISE EXCEPTION 'users: an application principal may only create an invited user with nothing else set'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'users_insert_invited_only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_users_insert_shape() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_users_insert_shape
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION fn_users_insert_shape();
--> statement-breakpoint
-- A revoked session or API key stays revoked, with its original time and
-- reason, for every application principal.
CREATE OR REPLACE FUNCTION fn_revocation_terminal() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.revoked_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.revoked_at, NEW.revoked_reason) IS NOT DISTINCT FROM (OLD.revoked_at, OLD.revoked_reason) THEN
    RETURN NEW;
  END IF;
  IF app_session_bypasses_rls() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%: revocation of % is terminal', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = TG_TABLE_NAME || '_revocation_terminal';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_revocation_terminal() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_sessions_revocation_terminal
  BEFORE UPDATE OF revoked_at, revoked_reason ON sessions
  FOR EACH ROW EXECUTE FUNCTION fn_revocation_terminal();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_api_keys_revocation_terminal
  BEFORE UPDATE OF revoked_at, revoked_reason ON api_keys
  FOR EACH ROW EXECUTE FUNCTION fn_revocation_terminal();
