-- =============================================================================
-- Gate-B remediation — tenant-context claims are validated against grants
--
-- The defect this closes (Gate-B security audit, Blocker 1):
--
--   `ScopeResolver.tenantContextFor` filled `app.current_reseller_id` from the
--   *selected organization's* reseller for every principal, and
--   `app_org_in_scope()` treats every organization under that reseller as in
--   scope. An ordinary organization administrator's transaction could therefore
--   read every sibling organization under the same reseller — and all direct
--   customers share one reseller. The application-side derivation is corrected
--   in the same change set; this migration makes the database refuse the wrong
--   claim on its own, so the boundary no longer depends on the application
--   deriving it correctly.
--
-- The same audit found the platform flag had the matching weakness: any grant at
-- `platform` scope — including the read-only `alendei_support` — set
-- `app.is_platform_admin`, which every policy treats as unrestricted read AND
-- write, and which `fn_validate_user_role_scope` treats as authority to grant
-- platform roles.
--
-- --- The rule, stated once ----------------------------------------------------
--
-- A session variable is a *claim*. For a principal that is subject to RLS, a
-- claim of elevated scope is honoured only while the transaction's
-- `app.current_user_id` holds the grant that confers it, re-read from current
-- state:
--
--   app.current_reseller_id = R   requires an active user holding a grant at
--                                 `reseller` scope on R.
--   app.is_platform_admin   = on  requires an active user holding
--                                 `alendei_super_admin` at `platform` scope.
--
-- An unbacked claim is not an error; it is simply not honoured (NULL / false),
-- which is the fail-closed direction and leaves the organization arm intact.
--
-- A principal that already bypasses RLS (a superuser or BYPASSRLS role — the
-- schema owner running migrations, `seed.ts`, the bootstrap CLI) is trusted with
-- the claim as before: RLS never applied to it, and the variables only matter to
-- it inside the integrity triggers, where the bootstrap of the very first
-- platform administrator must remain possible.
--
-- --- What this does NOT defend against ----------------------------------------
--
-- `app.current_user_id` is itself a session variable. A principal able to run
-- arbitrary SQL as `acc_app` can set it to a real administrator's id. This
-- validation stops application *logic* errors from widening RLS (the class of
-- defect found); it is not a defence against a compromised application role.
-- That residual risk is recorded in `SECURITY.md` §4b.
--
-- --- Cost ----------------------------------------------------------------------
--
-- Both functions keep a constant-time fast path for the common case (variable
-- unset or `off`), so ordinary organization traffic pays one `current_setting`
-- per call as before. Only a transaction that actually claims reseller or
-- platform scope pays an indexed grant lookup per evaluation.
-- =============================================================================

-- True when the session's own login principal is exempt from RLS: a superuser, a
-- BYPASSRLS role, or the owner of the tenancy tables (RLS is enabled but not
-- forced, so the owner is exempt — which is also how a managed-PostgreSQL
-- deployment's non-superuser migration role runs `seed.ts` and the bootstrap
-- CLI). `session_user` rather than `current_user`: inside a SECURITY DEFINER
-- function `current_user` is the function owner, and the question is who
-- connected. No application principal satisfies any arm; `principals.int-spec.ts`
-- asserts that against the catalog and the API refuses to start otherwise.
CREATE OR REPLACE FUNCTION app_session_bypasses_rls() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = session_user),
    false
  )
  OR pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.user_roles'::regclass), 'MEMBER')
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_current_reseller_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_claim uuid := nullif(current_setting('app.current_reseller_id', true), '')::uuid;
  v_user  uuid;
BEGIN
  IF v_claim IS NULL THEN
    RETURN NULL;
  END IF;

  v_user := nullif(current_setting('app.current_user_id', true), '')::uuid;
  IF v_user IS NOT NULL AND EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
    WHERE ur.user_id = v_user
      AND ur.scope_type = 'reseller'
      AND ur.scope_id = v_claim
      AND u.status = 'active'
  ) THEN
    RETURN v_claim;
  END IF;

  IF app_session_bypasses_rls() THEN
    RETURN v_claim;
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF coalesce(nullif(current_setting('app.is_platform_admin', true), ''), 'off') <> 'on' THEN
    RETURN false;
  END IF;

  v_user := nullif(current_setting('app.current_user_id', true), '')::uuid;
  IF v_user IS NOT NULL AND EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = ur.user_id
    WHERE ur.user_id = v_user
      AND ur.scope_type = 'platform'
      AND r.org_id IS NULL
      AND r.key = 'alendei_super_admin'
      AND u.status = 'active'
  ) THEN
    RETURN true;
  END IF;

  RETURN app_session_bypasses_rls();
END;
$$;
--> statement-breakpoint

-- --- Liveness uses the same definition -----------------------------------------
-- "At least one active platform administrator" now means what the RLS flag
-- means: an active holder of `alendei_super_admin` at platform scope. Counting a
-- support grant would let the last real administrator be removed while a
-- read-only role kept the invariant nominally satisfied.
CREATE OR REPLACE FUNCTION fn_assert_platform_admin_remains() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining integer;
BEGIN
  PERFORM pg_advisory_xact_lock(4820193077);

  SELECT count(*) INTO v_remaining
  FROM user_roles ur
  JOIN users u ON u.id = ur.user_id
  JOIN roles r ON r.id = ur.role_id
  WHERE ur.scope_type = 'platform'
    AND r.org_id IS NULL
    AND r.key = 'alendei_super_admin'
    AND u.status = 'active';

  IF v_remaining = 0 THEN
    RAISE EXCEPTION
      'platform administration: refusing to leave the platform with no active administrator'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;
--> statement-breakpoint

-- A grant can also stop counting by being *changed*, not only deleted: an UPDATE
-- moving it off platform scope, onto another user or onto another role. No
-- application path updates `user_roles`, but the invariant is the database's,
-- so every way of leaving the counted set is guarded.
DROP TRIGGER IF EXISTS trg_user_roles_platform_admin_liveness_update ON "user_roles";
--> statement-breakpoint
CREATE TRIGGER trg_user_roles_platform_admin_liveness_update
  AFTER UPDATE OF scope_type, user_id, role_id ON "user_roles"
  FOR EACH ROW WHEN (OLD.scope_type = 'platform')
  EXECUTE FUNCTION fn_user_roles_platform_admin_guard();
--> statement-breakpoint

-- Only the functions an RLS policy or trigger needs are executable by the
-- application principals; nothing is granted to PUBLIC.
REVOKE ALL ON FUNCTION app_session_bypasses_rls() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_session_bypasses_rls(), app_current_reseller_id(), app_is_platform_admin()
  TO acc_app, acc_auth, acc_relay;
