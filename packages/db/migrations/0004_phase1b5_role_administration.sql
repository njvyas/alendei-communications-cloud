-- =============================================================================
-- Phase 1B.5.4 — role administration foundations (ADR-005 D-8, `RBAC.md` §7)
--
-- Three changes, each closing a gap the role-administration surface would
-- otherwise open. Additive and forward-only: no table is created, so no new RLS
-- policy is required — `roles`, `role_permissions` and `user_roles` already
-- carry theirs from migration 0000, and every column added here is governed by
-- them unchanged. The integration suite re-asserts that against the catalog
-- rather than assuming it.
--
--   1. `user_roles.role_id` moves from ON DELETE CASCADE to ON DELETE RESTRICT.
--   2. `roles.allowed_scope_types` is added, NOT NULL and non-empty.
--   3. System roles are protected from mutation and deletion by trigger.
--
-- --- 1. Why RESTRICT (ADR-005 D-8, §6n case 18) -------------------------------
--
-- Under CASCADE, deleting a role silently revokes every grant of it. That is a
-- mass privilege revocation performed by the database with no audit row for any
-- individual revocation — the trail would show one `role.deleted` and nothing
-- about the users who lost access. RESTRICT makes the deletion fail while grants
-- exist, so each revocation must be an explicit, individually audited act before
-- the role can go. The service reports this as `409`; the constraint is what
-- makes it true even when the service is bypassed.
--
-- --- 2. Why allowed_scope_types (`RBAC.md` §7) --------------------------------
--
-- `RoleDefinition.allowedScopeTypes` has been a documented constraint enforced
-- nowhere. This migration gives it a home in the schema and populates it, so a
-- role carries the scope levels it was designed for. **Grant-time enforcement is
-- deliberately NOT added here** — it is service-layer work owned by Phase 1B.5.5
-- (`RBAC.md` §7, `DECISIONS.md` ADR-005), and `fn_validate_user_role_scope` is
-- left exactly as migration 0000 wrote it. Adding the column now is what lets
-- 1B.5.4 seed `TENANT_ROLE_DEFINITIONS` without discarding the property and
-- forcing a re-seed one increment later.
--
-- The backfill mirrors the canonical definitions in
-- `packages/contracts/src/roles.ts`. A role that predates this migration and
-- matches no definition is a custom role; it is backfilled with the conservative
-- default of its own organization level, never something wider.
--
-- --- 3. Why system-role protection --------------------------------------------
--
-- `roles.is_system_role` marked the seeded roles but bound nothing. A tenant
-- principal holding `roles.update` could therefore rewrite `org_admin` — editing
-- the definition of administration rather than escalating within it. The
-- triggers below refuse mutation and deletion of any system role.
--
-- Two transaction-local escapes, both pre-existing and both narrow:
-- `app_is_platform_admin()`, which `seed.ts` and the bootstrap CLI already
-- declare as the schema owner; and `app_is_provisioning()`, which
-- `TenantSession.provisioning` sets for the tenant-provisioning path alone. The
-- provisioner composes an organization's seeded roles under the second, so it
-- never has to claim platform-admin inside a tenant request transaction — which
-- would widen RLS for everything else in that transaction. No application
-- principal can set either variable.
-- =============================================================================

-- --- 1. user_roles.role_id: CASCADE -> RESTRICT ------------------------------
-- Dropped and recreated rather than altered: PostgreSQL has no ALTER CONSTRAINT
-- for referential actions. Guarded so a re-run against an already-migrated
-- database is a no-op rather than an error.
ALTER TABLE "user_roles" DROP CONSTRAINT IF EXISTS "user_roles_role_id_fk";--> statement-breakpoint
ALTER TABLE "user_roles" DROP CONSTRAINT IF EXISTS "user_roles_role_id_roles_id_fk";--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fk"
  FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;--> statement-breakpoint

-- --- 2. roles.allowed_scope_types --------------------------------------------
-- Added nullable, backfilled, then constrained: an ALTER adding a NOT NULL
-- column to a populated table would otherwise fail on a database upgraded from
-- the current HEAD.
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "allowed_scope_types" role_scope_type[];--> statement-breakpoint

-- Platform roles (org_id IS NULL), from PLATFORM_ROLE_DEFINITIONS.
UPDATE "roles" SET "allowed_scope_types" = ARRAY['platform']::role_scope_type[]
  WHERE "org_id" IS NULL AND "key" IN ('alendei_super_admin', 'alendei_support')
    AND "allowed_scope_types" IS NULL;--> statement-breakpoint
UPDATE "roles" SET "allowed_scope_types" = ARRAY['reseller']::role_scope_type[]
  WHERE "org_id" IS NULL AND "key" = 'reseller_admin'
    AND "allowed_scope_types" IS NULL;--> statement-breakpoint

-- Tenant roles, from TENANT_ROLE_DEFINITIONS.
UPDATE "roles" SET "allowed_scope_types" = ARRAY['organization']::role_scope_type[]
  WHERE "org_id" IS NOT NULL AND "key" = 'org_admin'
    AND "allowed_scope_types" IS NULL;--> statement-breakpoint
UPDATE "roles" SET "allowed_scope_types" = ARRAY['organization','workspace']::role_scope_type[]
  WHERE "org_id" IS NOT NULL AND "key" = 'workspace_manager'
    AND "allowed_scope_types" IS NULL;--> statement-breakpoint
UPDATE "roles" SET "allowed_scope_types" = ARRAY['organization','workspace','team']::role_scope_type[]
  WHERE "org_id" IS NOT NULL AND "key" IN ('campaign_editor', 'agent', 'read_only')
    AND "allowed_scope_types" IS NULL;--> statement-breakpoint

-- Anything still unset is a custom role created before this migration. The
-- conservative default is the level it lives at, never wider.
UPDATE "roles" SET "allowed_scope_types" = ARRAY['organization']::role_scope_type[]
  WHERE "allowed_scope_types" IS NULL AND "org_id" IS NOT NULL;--> statement-breakpoint
UPDATE "roles" SET "allowed_scope_types" = ARRAY['platform']::role_scope_type[]
  WHERE "allowed_scope_types" IS NULL;--> statement-breakpoint

ALTER TABLE "roles" ALTER COLUMN "allowed_scope_types" SET NOT NULL;--> statement-breakpoint

-- Non-empty: a role admitting no scope at all could never be granted anywhere,
-- which is a silently broken role rather than a restrictive one.
ALTER TABLE "roles" DROP CONSTRAINT IF EXISTS "roles_allowed_scope_types_non_empty";--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_allowed_scope_types_non_empty"
  CHECK (array_length("allowed_scope_types", 1) >= 1);--> statement-breakpoint

-- A platform role (org_id IS NULL) is designed for platform or reseller scope
-- and nothing below it; a tenant role for organization/workspace/team and
-- nothing above. This mirrors what `fn_validate_user_role_scope` already
-- enforces at grant time, so the column can never describe a shape the trigger
-- would refuse anyway.
ALTER TABLE "roles" DROP CONSTRAINT IF EXISTS "roles_allowed_scope_types_level";--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_allowed_scope_types_level"
  CHECK (
    CASE WHEN "org_id" IS NULL
      THEN "allowed_scope_types" <@ ARRAY['platform','reseller']::role_scope_type[]
      ELSE "allowed_scope_types" <@ ARRAY['organization','workspace','team']::role_scope_type[]
    END
  );--> statement-breakpoint

-- --- 3. System-role protection ------------------------------------------------
-- `is_system_role` is set only by the seeder and the tenant-role provisioner,
-- both of which elevate transaction-locally. No application principal can set
-- `app.is_platform_admin`, so no request can reach past this.
CREATE OR REPLACE FUNCTION fn_protect_system_roles() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system_role AND NOT app_is_platform_admin() AND NOT app_is_provisioning() THEN
      RAISE EXCEPTION 'roles: system role % cannot be deleted', OLD.key
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  -- An existing system role is immutable, and a role cannot be promoted into
  -- one: both would let a tenant principal rewrite the definition of
  -- administration rather than escalate within it.
  IF (OLD.is_system_role OR NEW.is_system_role)
     AND NOT app_is_platform_admin() AND NOT app_is_provisioning() THEN
    RAISE EXCEPTION 'roles: system role % cannot be modified', OLD.key
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_roles_protect_system ON "roles";--> statement-breakpoint
CREATE TRIGGER trg_roles_protect_system
  BEFORE UPDATE OR DELETE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION fn_protect_system_roles();--> statement-breakpoint

-- A system role's permission set is part of the same definition, so it is
-- protected on the same terms.
CREATE OR REPLACE FUNCTION fn_protect_system_role_permissions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_role_id uuid;
  v_is_system boolean;
  v_key text;
BEGIN
  v_role_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.role_id ELSE NEW.role_id END;
  SELECT r.is_system_role, r.key INTO v_is_system, v_key FROM roles r WHERE r.id = v_role_id;

  IF coalesce(v_is_system, false)
     AND NOT app_is_platform_admin() AND NOT app_is_provisioning() THEN
    RAISE EXCEPTION 'role_permissions: system role % has a fixed permission set', v_key
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_role_permissions_protect_system ON "role_permissions";--> statement-breakpoint
CREATE TRIGGER trg_role_permissions_protect_system
  BEFORE INSERT OR UPDATE OR DELETE ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION fn_protect_system_role_permissions();
