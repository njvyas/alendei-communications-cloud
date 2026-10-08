-- =============================================================================
-- ADR-015 remediation step 4 — the Model B tenant-content RLS infrastructure
-- (R-7 / HIGH-5, R-8, R-9, R-10; ADR-014 §17.1; DATABASE.md §2; TENANCY.md §3a;
-- SECURITY.md §4b)
--
-- Infrastructure only: this migration creates NO content table and changes no
-- existing policy, grant or table. Tenancy-record tables keep app_org_in_scope.
-- The first tenant-content table (Phase 3.1) uses, for acc_app only,
--   org_id = app_current_org_id() AND (SELECT app_content_context_valid())
-- with SELECT/UPDATE USING it, INSERT/UPDATE WITH CHECK it, and no DELETE.
--
-- app_content_context_valid() is true only when app.current_org_id is set AND
-- either
--   (a) app.current_user_id is an ACTIVE user holding an organization-,
--       workspace- or team-scope grant in that organization, or
--   (b) app.current_api_key_id (the seventh transaction-local claim, written on
--       every transaction by tenantContextStatements, empty when absent) names
--       an unrevoked, unexpired API key of that organization.
-- There is no reseller, platform, support, break-glass or bypass arm (R-7,
-- R-8): platform and reseller authority never create tenant-content
-- visibility, and the reseller/platform claims are neither read nor cleared.
-- A workspace or team grant admits the whole organization at this layer;
-- workspace and team isolation stay application-layer (ADR-011 D-4). The
-- organization's own status is not consulted (the decisions name none).
--
-- STABLE SECURITY DEFINER with search_path = public, pg_temp: it reads
-- user_roles, users and api_keys as their owner, so its answer does not depend
-- on those tables' own (reseller- and platform-aware) policies, and a caller's
-- temporary table cannot shadow them. Grants and keys are read live: STABLE
-- holds within one statement only — wrapped as (SELECT …) it is an InitPlan,
-- evaluated once per statement — so a grant revoked, a user disabled or a key
-- revoked in another committed transaction denies the next statement.
-- EXECUTE: acc_app only. Never PUBLIC, acc_auth, acc_relay or acc_dispatch.
--
-- RESIDUAL (accepted, SECURITY.md §4b, unchanged in kind from migration 0010):
-- app.current_user_id and app.current_api_key_id are set by acc_app and are
-- the trust anchor. A compromised acc_app that forges current_user_id to a
-- real active member of organization B, with current_org_id = B, reaches B's
-- content — the single organization in context, never another one, never two
-- in one statement, and never by reseller or platform reach. Forging a key id
-- requires knowing an unrevoked, unexpired key id of that same organization,
-- with the same single-organization bound.
--
-- R-9 (content side channels) and R-10 (classification) need no database
-- object: R-9 binds the first content route (DECISIONS §1o); R-10 is recorded
-- in packages/db/src/table-classes.ts.
--
-- Rerun-safe: the verification block reads only; CREATE OR REPLACE keeps the
-- function's identity; REVOKE/GRANT are idempotent. The first statement
-- verifies what the function relies on and aborts the whole migration —
-- nothing applied — if an organization-, workspace- or team-scope grant's
-- org_id disagrees with its scope, or a principal it names is missing.
-- =============================================================================

DO $$
DECLARE
  v_count  bigint;
  v_sample text;
BEGIN
  SELECT count(*), string_agg(rolname, ', ' ORDER BY rolname) INTO v_count, v_sample
    FROM (VALUES ('acc_app'), ('acc_auth'), ('acc_relay')) AS r(rolname)
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles p WHERE p.rolname = r.rolname);
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0027 verification failed [principals_present]: missing database principals (%)', v_sample
      USING ERRCODE = 'undefined_object';
  END IF;

  -- The user arm trusts user_roles.org_id for these three scopes.
  SELECT count(*), string_agg(id::text, ', ') INTO v_count, v_sample FROM (
    SELECT ur.id FROM user_roles ur
     WHERE (ur.scope_type = 'organization' AND ur.org_id IS DISTINCT FROM ur.scope_id)
        OR (ur.scope_type = 'workspace' AND ur.org_id IS DISTINCT FROM (SELECT w.org_id FROM workspaces w WHERE w.id = ur.scope_id))
        OR (ur.scope_type = 'team' AND ur.org_id IS DISTINCT FROM (SELECT t.org_id FROM teams t WHERE t.id = ur.scope_id))
        OR (ur.scope_type IN ('platform', 'reseller') AND ur.org_id IS NOT NULL)
     ORDER BY ur.id) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0027 verification failed [user_roles_scope_org_consistent]: % role grants whose org_id disagrees with their scope (ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_content_context_valid() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_org  uuid := nullif(current_setting('app.current_org_id', true), '')::uuid;
  v_user uuid;
  v_key  uuid;
BEGIN
  IF v_org IS NULL THEN
    RETURN false;
  END IF;

  v_user := nullif(current_setting('app.current_user_id', true), '')::uuid;
  IF v_user IS NOT NULL AND EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
    WHERE ur.user_id = v_user
      AND ur.org_id = v_org
      AND ur.scope_type IN ('organization', 'workspace', 'team')
      AND u.status = 'active'
  ) THEN
    RETURN true;
  END IF;

  v_key := nullif(current_setting('app.current_api_key_id', true), '')::uuid;
  IF v_key IS NOT NULL AND EXISTS (
    SELECT 1
    FROM api_keys k
    WHERE k.id = v_key
      AND k.org_id = v_org
      AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > now())
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_content_context_valid() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_content_context_valid() FROM acc_auth, acc_relay;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_content_context_valid() TO acc_app;
--> statement-breakpoint
COMMENT ON FUNCTION app_content_context_valid() IS
  'ADR-015 R-7 (Model B): true only when app.current_org_id is set and app.current_user_id is an active user with an organization/workspace/team grant there, or app.current_api_key_id is an unrevoked, unexpired key of that organization. No reseller, platform or break-glass arm. EXECUTE: acc_app only.';
