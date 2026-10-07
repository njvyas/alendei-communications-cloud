-- =============================================================================
-- ADR-015 remediation step 3 — permission classification and per-permission
-- allowed-scope sets (R-5 / HIGH-4), and the grant side of tenant delegation
-- (R-6; RBAC.md §1, §7, §7b; DATABASE.md §2)
--
-- R-5  `permissions` carries `classification` (platform | platform_catalogue |
--      tenancy_administration | tenant_content — these four only) and
--      `allowed_scope_types` (the scope types at which a grant may confer the
--      permission), projected from packages/contracts (PERMISSION_CLASS,
--      PERMISSION_ALLOWED_SCOPES). Backfill: every platform.* key → platform,
--      {platform}; providers.* → platform_catalogue, all five scopes; every
--      other existing key → tenancy_administration, all five scopes (none of
--      the 37 existing keys is narrowed). No default: a row is classified
--      explicitly or not at all. CHECKs: the four classes; platform ⇔ the
--      `platform.` key prefix; a non-empty scope set; a platform permission is
--      {platform} only; tenant content never includes platform or reseller.
--      The eight ADR-014 §6 tenant-content keys are inserted as INERT catalogue
--      entries (follow-up decision 6): no role carries them.
--      fn_validate_role_permission additionally refuses a role carrying a
--      permission unless role.allowed_scope_types ⊆ permission.allowed_scope_types
--      (42501, role_permissions_scope_eligibility) — so no platform role and
--      no reseller-scope role can carry a tenant-content key, and no tenant role
--      admitting `team` (or `workspace`) can carry an organization-only one. It
--      reads the role and the permission FOR SHARE, in that order.
--      The reverse races: an UPDATE of a permission's classification/allowed
--      scopes that would make a role already carrying it ineligible is refused
--      (42501, permissions_allowed_scope_types_in_use), and so is an UPDATE of a
--      role's allowed_scope_types that would make one of its permissions
--      ineligible (42501, roles_allowed_scope_types_permission_eligibility).
-- R-6  `platform.roles.delegate_tenant` (classification platform, {platform})
--      is inserted and attached to alendei_super_admin (follow-up decision 5).
--      The delegation decision itself is application-only (RBAC.md §7b), as
--      guard 4 is; no SQL re-implements "the actor holds P".
--
-- Lock order, and why the insert-versus-reclassify race is closed at READ
-- COMMITTED:
--   * attach (role_permissions INSERT/UPDATE): role row FOR SHARE, then the
--     permission row FOR SHARE, then the check. A concurrent narrowing of the
--     permission (which holds its row lock) makes the attach wait and then
--     judge the narrowed set; a narrowing that starts second waits for the
--     attach to commit.
--   * narrow a permission: its own row lock (the UPDATE), then FOR SHARE on
--     every role carrying it, then the check in a fresh statement — so it sees
--     a committed attach and a committed widening of any of those roles.
--   * widen a role: its own row lock (the UPDATE), then the check — an attach
--     to the role waits for it, or it waits for the attach.
-- Narrowing a permission at REPEATABLE READ or SERIALIZABLE is refused (25000,
-- permissions_allowed_scope_types_narrowing_isolation), as migration 0015 does
-- for role narrowing: under a transaction snapshot the guard could miss an
-- attach committed after the snapshot. Widening a role is accepted at every
-- isolation level, as before (DATABASE.md records the residual).
--
-- fn_validate_role_permission stays SECURITY DEFINER, as since 0000 (it must
-- see the role whatever the writer's RLS context; PUBLIC EXECUTE revoked in
-- 0016 and again below). The two new functions are SECURITY INVOKER with a
-- pinned search_path and no PUBLIC EXECUTE: the permissions guard runs for the
-- owner only (no application principal may UPDATE permissions), and the roles
-- guard runs as the writer, which sees every role_permissions row of a role it
-- can update (the same organization predicate on both tables). Rerun-safe:
-- ADD COLUMN IF NOT EXISTS, a backfill of NULLs only, ON CONFLICT DO NOTHING,
-- DROP … IF EXISTS before each constraint and trigger, CREATE OR REPLACE.
--
-- The first statement verifies existing data and aborts the whole migration —
-- nothing applied — if a permission key is not in the catalogue this migration
-- classifies, or a role already carries a permission it would be ineligible for.
-- =============================================================================

DO $$
DECLARE
  v_count  bigint;
  v_sample text;
BEGIN
  SELECT count(*), string_agg(key, ', ' ORDER BY key) INTO v_count, v_sample
    FROM permissions
   WHERE key NOT IN (
     'organizations.read', 'organizations.create', 'organizations.update',
     'workspaces.read', 'workspaces.create', 'workspaces.update',
     'teams.read', 'teams.create', 'teams.update',
     'users.read', 'users.invite', 'users.update', 'users.disable', 'users.reactivate',
     'roles.read', 'roles.create', 'roles.update', 'roles.delete',
     'role_assignments.read', 'role_assignments.grant', 'role_assignments.revoke',
     'permissions.read',
     'api_keys.read', 'api_keys.create', 'api_keys.revoke',
     'sessions.read', 'sessions.revoke',
     'audit.read',
     'resellers.read', 'resellers.update',
     'providers.read', 'providers.manage', 'providers.test_send',
     'platform.tenants.read', 'platform.tenants.manage', 'platform.roles.assign',
     'platform.roles.delegate_tenant', 'platform.audit.read',
     'contacts.read', 'contacts.manage', 'templates.read', 'templates.manage',
     'suppressions.read', 'suppressions.manage', 'messages.read', 'messages.send');
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0026 verification failed [permissions_known_catalogue]: % permissions this migration cannot classify (keys: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*), string_agg(r.key || ':' || p.key, ', ' ORDER BY r.key, p.key) INTO v_count, v_sample
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE NOT (r.allowed_scope_types <@ CASE
           WHEN p.key LIKE 'platform.%' THEN '{platform}'::role_scope_type[]
           WHEN p.key IN ('contacts.read', 'contacts.manage', 'messages.read', 'messages.send')
             THEN '{organization,workspace}'::role_scope_type[]
           WHEN p.key IN ('templates.read', 'templates.manage', 'suppressions.read', 'suppressions.manage')
             THEN '{organization}'::role_scope_type[]
           ELSE '{platform,reseller,organization,workspace,team}'::role_scope_type[]
         END);
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0026 verification failed [role_permissions_scope_eligibility]: % role permissions whose role admits a scope type the permission may not be conferred at (role:permission: %)', v_count, v_sample
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;
--> statement-breakpoint

-- --- 1. The two columns, backfilled, then required ---------------------------------
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS classification text;
--> statement-breakpoint
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS allowed_scope_types role_scope_type[];
--> statement-breakpoint
-- The existing rows (the verification above admitted only known keys). Rows
-- already classified are left as they are.
UPDATE permissions SET
  classification = CASE
    WHEN key LIKE 'platform.%' THEN 'platform'
    WHEN key LIKE 'providers.%' THEN 'platform_catalogue'
    WHEN key IN ('contacts.read', 'contacts.manage', 'templates.read', 'templates.manage',
                 'suppressions.read', 'suppressions.manage', 'messages.read', 'messages.send')
      THEN 'tenant_content'
    ELSE 'tenancy_administration'
  END,
  allowed_scope_types = CASE
    WHEN key LIKE 'platform.%' THEN '{platform}'::role_scope_type[]
    WHEN key IN ('contacts.read', 'contacts.manage', 'messages.read', 'messages.send')
      THEN '{organization,workspace}'::role_scope_type[]
    WHEN key IN ('templates.read', 'templates.manage', 'suppressions.read', 'suppressions.manage')
      THEN '{organization}'::role_scope_type[]
    ELSE '{platform,reseller,organization,workspace,team}'::role_scope_type[]
  END
WHERE classification IS NULL OR allowed_scope_types IS NULL;
--> statement-breakpoint
-- The new keys (0018 precedent: an upgrade is complete without re-seeding;
-- seed.ts upserts the same rows from packages/contracts, so either order is
-- safe). The eight tenant-content keys are inert catalogue entries.
INSERT INTO permissions (key, domain, action, description, classification, allowed_scope_types) VALUES
  ('platform.roles.delegate_tenant', 'platform.roles', 'delegate_tenant',
   'Appoint a predefined tenant-system role carrying tenant-content permissions the actor does not hold (ADR-015 R-6)',
   'platform', '{platform}'),
  ('contacts.read', 'contacts', 'read', 'Read contacts, identities and consent history', 'tenant_content', '{organization,workspace}'),
  ('contacts.manage', 'contacts', 'manage', 'Create, update and delete contacts; grant and revoke consent', 'tenant_content', '{organization,workspace}'),
  ('templates.read', 'templates', 'read', 'Read organization-owned templates', 'tenant_content', '{organization}'),
  ('templates.manage', 'templates', 'manage', 'Create, update and delete templates; simulated approve and reject', 'tenant_content', '{organization}'),
  ('suppressions.read', 'suppressions', 'read', 'Read organization-owned suppressions', 'tenant_content', '{organization}'),
  ('suppressions.manage', 'suppressions', 'manage', 'Create and lift suppressions', 'tenant_content', '{organization}'),
  ('messages.read', 'messages', 'read', 'Read messages, attempts and events', 'tenant_content', '{organization,workspace}'),
  ('messages.send', 'messages', 'send', 'Send a message', 'tenant_content', '{organization,workspace}')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
ALTER TABLE permissions ALTER COLUMN classification SET NOT NULL;
--> statement-breakpoint
ALTER TABLE permissions ALTER COLUMN allowed_scope_types SET NOT NULL;
--> statement-breakpoint
ALTER TABLE permissions ALTER COLUMN classification DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE permissions ALTER COLUMN allowed_scope_types DROP DEFAULT;
--> statement-breakpoint

-- --- 2. Shape of a classification ------------------------------------------------
ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_classification_valid;
--> statement-breakpoint
ALTER TABLE permissions ADD CONSTRAINT permissions_classification_valid
  CHECK (classification IN ('platform', 'platform_catalogue', 'tenancy_administration', 'tenant_content'));
--> statement-breakpoint
ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_classification_platform_domain;
--> statement-breakpoint
ALTER TABLE permissions ADD CONSTRAINT permissions_classification_platform_domain
  CHECK ((classification = 'platform') = (key LIKE 'platform.%'));
--> statement-breakpoint
ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_allowed_scope_types_non_empty;
--> statement-breakpoint
-- cardinality, not array_length: array_length('{}', 1) is NULL and a CHECK
-- passes on NULL.
ALTER TABLE permissions ADD CONSTRAINT permissions_allowed_scope_types_non_empty
  CHECK (cardinality(allowed_scope_types) >= 1);
--> statement-breakpoint
ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_platform_scope_only;
--> statement-breakpoint
ALTER TABLE permissions ADD CONSTRAINT permissions_platform_scope_only
  CHECK (classification <> 'platform' OR allowed_scope_types = ARRAY['platform']::role_scope_type[]);
--> statement-breakpoint
ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_tenant_content_scopes;
--> statement-breakpoint
ALTER TABLE permissions ADD CONSTRAINT permissions_tenant_content_scopes
  CHECK (classification <> 'tenant_content' OR NOT (allowed_scope_types && ARRAY['platform','reseller']::role_scope_type[]));
--> statement-breakpoint

-- --- 3. Attach: the role must be eligible for the permission ----------------------
-- Identical to migration 0000 except: the role and the permission rows are read
-- FOR SHARE (role first), and the scope-eligibility rule after the platform.%
-- rule, which keeps its own message. `CREATE OR REPLACE` keeps the ACL.
CREATE OR REPLACE FUNCTION fn_validate_role_permission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_role_org_id    uuid;
  v_role_key       text;
  v_role_scopes    role_scope_type[];
  v_role_found     boolean;
  v_permission_key text;
  v_perm_scopes    role_scope_type[];
BEGIN
  SELECT r.org_id, r.key, r.allowed_scope_types, true
    INTO v_role_org_id, v_role_key, v_role_scopes, v_role_found
    FROM roles r WHERE r.id = NEW.role_id
    FOR SHARE;
  IF NOT coalesce(v_role_found, false) THEN
    RAISE EXCEPTION 'role_permissions: role % does not exist', NEW.role_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT p.key, p.allowed_scope_types INTO v_permission_key, v_perm_scopes
    FROM permissions p WHERE p.id = NEW.permission_id
    FOR SHARE;
  IF v_permission_key IS NULL THEN
    RAISE EXCEPTION 'role_permissions: permission % does not exist', NEW.permission_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_role_org_id IS NOT NULL AND v_permission_key LIKE 'platform.%' THEN
    RAISE EXCEPTION
      'role_permissions: platform permission % cannot be attached to tenant role %',
      v_permission_key, NEW.role_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- ADR-015 R-5: every scope type the role may be granted at must be one the
  -- permission may be conferred at. Refuses tenant content on any platform or
  -- reseller-scope role, and an organization-only permission on a role that
  -- admits workspace or team.
  IF NOT (coalesce(v_role_scopes, '{}'::role_scope_type[])
          <@ coalesce(v_perm_scopes, '{}'::role_scope_type[])) THEN
    RAISE EXCEPTION
      'role_permissions: role % admits scope types % but permission % may only be conferred at %',
      v_role_key, v_role_scopes, v_permission_key, v_perm_scopes
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'role_permissions_scope_eligibility';
  END IF;

  NEW.org_id := v_role_org_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_validate_role_permission() FROM PUBLIC;
--> statement-breakpoint

-- --- 4. Narrowing or reclassifying a permission a role already carries -----------
CREATE OR REPLACE FUNCTION fn_permissions_guard_scope_eligibility() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_isolation  text := current_setting('transaction_isolation');
  v_ineligible text;
BEGIN
  IF v_isolation <> 'read committed'
     AND NOT (coalesce(OLD.allowed_scope_types, '{}'::role_scope_type[])
              <@ coalesce(NEW.allowed_scope_types, '{}'::role_scope_type[])) THEN
    RAISE EXCEPTION
      'permissions: narrowing allowed_scope_types of % requires READ COMMITTED isolation (this transaction is %)', NEW.key, v_isolation
      USING ERRCODE = 'invalid_transaction_state',
            CONSTRAINT = 'permissions_allowed_scope_types_narrowing_isolation',
            HINT = 'Under a transaction snapshot a role permission committed after the snapshot is invisible to this guard.';
  END IF;

  -- Lock every role carrying the permission, so a concurrent widening of one
  -- of them is waited for; the check below is a fresh statement and so sees it.
  PERFORM 1 FROM roles r
   WHERE r.id IN (SELECT rp.role_id FROM role_permissions rp WHERE rp.permission_id = NEW.id)
   ORDER BY r.id
   FOR SHARE;

  SELECT string_agg(r.key, ', ' ORDER BY r.key) INTO v_ineligible
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE rp.permission_id = NEW.id
     AND NOT (r.allowed_scope_types <@ coalesce(NEW.allowed_scope_types, '{}'::role_scope_type[]));
  IF v_ineligible IS NOT NULL THEN
    RAISE EXCEPTION
      'permissions: % cannot stop being conferrable at a scope type roles carrying it admit (roles: %)', NEW.key, v_ineligible
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'permissions_allowed_scope_types_in_use';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_permissions_guard_scope_eligibility() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_permissions_guard_scope_eligibility ON permissions;
--> statement-breakpoint
CREATE TRIGGER trg_permissions_guard_scope_eligibility
  BEFORE UPDATE OF classification, allowed_scope_types ON permissions
  FOR EACH ROW
  WHEN (OLD.classification IS DISTINCT FROM NEW.classification
        OR OLD.allowed_scope_types IS DISTINCT FROM NEW.allowed_scope_types)
  EXECUTE FUNCTION fn_permissions_guard_scope_eligibility();
--> statement-breakpoint

-- --- 5. Widening a role past what its permissions may be conferred at -------------
CREATE OR REPLACE FUNCTION fn_roles_guard_permission_eligibility() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
  v_ineligible text;
BEGIN
  SELECT string_agg(p.key, ', ' ORDER BY p.key) INTO v_ineligible
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE rp.role_id = NEW.id
     AND NOT (coalesce(NEW.allowed_scope_types, '{}'::role_scope_type[]) <@ p.allowed_scope_types);
  IF v_ineligible IS NOT NULL THEN
    RAISE EXCEPTION
      'roles: role % cannot admit scope types % while it carries permissions not conferrable there (%)', NEW.key, NEW.allowed_scope_types, v_ineligible
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'roles_allowed_scope_types_permission_eligibility';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_roles_guard_permission_eligibility() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_roles_guard_permission_eligibility ON roles;
--> statement-breakpoint
CREATE TRIGGER trg_roles_guard_permission_eligibility
  BEFORE UPDATE OF allowed_scope_types ON roles
  FOR EACH ROW
  WHEN (OLD.allowed_scope_types IS DISTINCT FROM NEW.allowed_scope_types)
  EXECUTE FUNCTION fn_roles_guard_permission_eligibility();
--> statement-breakpoint

-- --- 6. alendei_super_admin holds platform.roles.delegate_tenant (decision 5) -----
-- Attached exactly as 0018 attached providers.*: the system role guard (0004)
-- admits it in a provisioning transaction. Validated by the new
-- fn_validate_role_permission ({platform} ⊆ {platform}).
SELECT set_config('app.provisioning', 'on', true);
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key = 'alendei_super_admin'
  AND p.key = 'platform.roles.delegate_tenant'
ON CONFLICT DO NOTHING;
