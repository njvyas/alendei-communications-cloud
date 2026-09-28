-- =============================================================================
-- Phase 1C.6 — database integrity (ADR-011 D-8, ADR-012; DATABASE.md §Phase 1C)
--
-- Turns four guarantees that were application-only into database guarantees:
--
--   1. `api_keys(workspace_id, org_id)` and `ws_tickets(workspace_id, org_id)`
--      reference `workspaces(id, org_id)`: a key or ticket whose workspace
--      belongs to another organization becomes unrepresentable. MATCH SIMPLE,
--      so an organization-bound row (`workspace_id IS NULL`) is unaffected. The
--      existing single-column `workspace_id` foreign keys stay.
--   2. `fn_validate_user_role_scope` refuses a grant at a `scope_type` outside
--      its role's `allowed_scope_types` — uniformly, platform roles included —
--      and takes `FOR SHARE` on the role row so a concurrent narrowing of the
--      role serializes against the grant.
--   3. `roles.allowed_scope_types` cannot be narrowed while a grant exists at a
--      scope type it would stop admitting (Phase 1C.6 decision §14.1, Option
--      A). Together with (2) the invariant is literal: no `user_roles` row
--      exists at a scope type its role does not admit.
--   4. `organizations.reseller_id` cannot change unless the writer is a
--      validated platform administrator or a principal that bypasses RLS
--      (`organizations_update`'s WITH CHECK evaluates the pre-update reseller,
--      so RLS alone never prevented a move).
--
-- The first statement verifies existing data and aborts the whole migration,
-- before any constraint or trigger exists, if a row already violates (1) or
-- (2)–(3); the message names the invariant, the count and sample ids. Nothing
-- is repaired automatically. No table, column, RLS policy or grant changes.
-- =============================================================================

DO $$
DECLARE
  v_count  bigint;
  v_sample text;
BEGIN
  SELECT count(*) INTO v_count FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id WHERE w.org_id <> k.org_id;
  IF v_count > 0 THEN
    SELECT string_agg(id::text, ', ') INTO v_sample
      FROM (SELECT k.id AS id FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id WHERE w.org_id <> k.org_id ORDER BY k.id LIMIT 5) s;
    RAISE EXCEPTION
      'migration 0014 verification failed [api_keys_workspace_org]: % api_keys bound to a workspace of another organization (sample ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_count FROM ws_tickets t JOIN workspaces w ON w.id = t.workspace_id WHERE w.org_id <> t.org_id;
  IF v_count > 0 THEN
    SELECT string_agg(id::text, ', ') INTO v_sample
      FROM (SELECT t.id AS id FROM ws_tickets t JOIN workspaces w ON w.id = t.workspace_id WHERE w.org_id <> t.org_id ORDER BY t.id LIMIT 5) s;
    RAISE EXCEPTION
      'migration 0014 verification failed [ws_tickets_workspace_org]: % ws_tickets bound to a workspace of another organization (sample ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_count FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE NOT (ur.scope_type = ANY (r.allowed_scope_types));
  IF v_count > 0 THEN
    SELECT string_agg(id::text, ', ') INTO v_sample
      FROM (SELECT ur.id AS id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE NOT (ur.scope_type = ANY (r.allowed_scope_types)) ORDER BY ur.id LIMIT 5) s;
    RAISE EXCEPTION
      'migration 0014 verification failed [user_roles_scope_type_admitted]: % user_roles granted at a scope_type their role does not admit (sample ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_org_fk" FOREIGN KEY ("workspace_id","org_id") REFERENCES "public"."workspaces"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ws_tickets" ADD CONSTRAINT "ws_tickets_workspace_org_fk" FOREIGN KEY ("workspace_id","org_id") REFERENCES "public"."workspaces"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- (2) The grant-time guard: unchanged except for `allowed_scope_types`, checked
-- first and for every role, and the `FOR SHARE` lock on the role row.
CREATE OR REPLACE FUNCTION fn_validate_user_role_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_role_org_id uuid;
  v_role_key    text;
  v_allowed     role_scope_type[];
  v_role_found  boolean;
  v_scope_org   uuid;
BEGIN
  -- FOR SHARE: a concurrent narrowing of this role (an UPDATE of the row) waits
  -- for this grant to commit, or this grant waits for it and then judges the
  -- narrowed value. Either way the committed state satisfies the invariant.
  SELECT r.org_id, r.key, r.allowed_scope_types, true
    INTO v_role_org_id, v_role_key, v_allowed, v_role_found
    FROM roles r WHERE r.id = NEW.role_id
    FOR SHARE;

  IF NOT coalesce(v_role_found, false) THEN
    RAISE EXCEPTION 'user_roles: role % does not exist', NEW.role_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Phase 1C.6: the role's own assignability, for every role — platform and
  -- tenant alike. The service refuses this first (422
  -- AUTHZ_SCOPE_TYPE_NOT_ADMITTED); this is the backstop for any writer.
  IF NOT (NEW.scope_type = ANY (coalesce(v_allowed, '{}'::role_scope_type[]))) THEN
    RAISE EXCEPTION
      'user_roles: role % does not admit scope_type %', v_role_key, NEW.scope_type
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_roles_scope_type_admitted';
  END IF;

  IF v_role_org_id IS NULL THEN
    -- Platform-level role (RBAC.md §3). Only an existing platform admin may
    -- grant one (RBAC.md §7) — enforced here as well as in the service layer.
    IF NOT app_is_platform_admin() THEN
      RAISE EXCEPTION
        'user_roles: platform-level role % may only be granted by a platform admin', v_role_key
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.scope_type NOT IN ('platform', 'reseller') THEN
      RAISE EXCEPTION
        'user_roles: platform-level role % cannot be granted at scope_type %', v_role_key, NEW.scope_type
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.scope_type = 'reseller'
       AND NOT EXISTS (SELECT 1 FROM resellers rs WHERE rs.id = NEW.scope_id) THEN
      RAISE EXCEPTION 'user_roles: reseller scope % does not exist', NEW.scope_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    NEW.org_id := NULL;
    RETURN NEW;
  END IF;

  -- Tenant-scoped role: resolve the organization that owns the target scope.
  IF NEW.scope_type = 'organization' THEN
    SELECT o.id INTO v_scope_org FROM organizations o WHERE o.id = NEW.scope_id;
  ELSIF NEW.scope_type = 'workspace' THEN
    SELECT w.org_id INTO v_scope_org FROM workspaces w WHERE w.id = NEW.scope_id;
  ELSIF NEW.scope_type = 'team' THEN
    SELECT t.org_id INTO v_scope_org FROM teams t WHERE t.id = NEW.scope_id;
  ELSE
    RAISE EXCEPTION
      'user_roles: tenant role % cannot be granted at scope_type %', v_role_key, NEW.scope_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_scope_org IS NULL THEN
    RAISE EXCEPTION 'user_roles: % scope % does not exist', NEW.scope_type, NEW.scope_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The invalid state this exists to prevent: a role belonging to Organization A
  -- granted at a scope owned by Organization B.
  IF v_scope_org <> v_role_org_id THEN
    RAISE EXCEPTION
      'user_roles: cross-tenant grant refused — role % belongs to organization %, scope % belongs to organization %',
      v_role_key, v_role_org_id, NEW.scope_id, v_scope_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  NEW.org_id := v_scope_org;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- (3) The narrowing guard. SECURITY DEFINER so it sees every grant of the role
-- whatever the writer's RLS context; it fails closed.
CREATE OR REPLACE FUNCTION fn_roles_guard_allowed_scope_types() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_in_use text;
BEGIN
  SELECT string_agg(DISTINCT ur.scope_type::text, ', ' ORDER BY ur.scope_type::text)
    INTO v_in_use
    FROM user_roles ur
   WHERE ur.role_id = NEW.id
     AND NOT (ur.scope_type = ANY (coalesce(NEW.allowed_scope_types, '{}'::role_scope_type[])));

  IF v_in_use IS NOT NULL THEN
    RAISE EXCEPTION
      'roles: role % cannot stop admitting scope_type(s) % while grants exist at them', NEW.key, v_in_use
      USING ERRCODE = 'check_violation', CONSTRAINT = 'roles_allowed_scope_types_in_use';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_roles_guard_allowed_scope_types
  BEFORE UPDATE OF allowed_scope_types ON roles
  FOR EACH ROW
  WHEN (OLD.allowed_scope_types IS DISTINCT FROM NEW.allowed_scope_types)
  EXECUTE FUNCTION fn_roles_guard_allowed_scope_types();
--> statement-breakpoint

-- (4) Reseller immutability. The decision depends only on the writer's
-- validated claim (`app_is_platform_admin()`, migration 0010) or on its being a
-- principal that bypasses RLS — never on the row or the request.
CREATE OR REPLACE FUNCTION fn_organizations_guard_reseller_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_is_platform_admin() OR app_session_bypasses_rls() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'organizations: reseller_id of organization % is immutable except to a platform administrator', OLD.id
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'organizations_reseller_id_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_organizations_guard_reseller_id
  BEFORE UPDATE OF reseller_id ON organizations
  FOR EACH ROW
  WHEN (OLD.reseller_id IS DISTINCT FROM NEW.reseller_id)
  EXECUTE FUNCTION fn_organizations_guard_reseller_id();
