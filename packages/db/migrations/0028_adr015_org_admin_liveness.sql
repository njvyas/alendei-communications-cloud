-- =============================================================================
-- ADR-015 remediation step 6 — last-organization-administrator protection
-- (R-11 / D-MEDIUM-3b; RBAC.md §7c; DATABASE.md §2; mirrors the
-- last-platform-administrator rule of migrations 0005, 0010, 0016 and 0017)
--
-- The invariant, stated exactly. An *organization administrator* of
-- organization O is an ACTIVE user (users.status = 'active') holding a grant of
-- O's seeded system role org_admin
--     roles.org_id = O AND roles.key = 'org_admin' AND roles.is_system_role
-- at scope_type = 'organization' AND scope_id = O.
--
-- It guards TRANSITIONS, not absence: a transaction that removes or
-- deactivates an administrator-qualifying grant of O and leaves O with zero
-- organization administrators is refused (restrict_violation, constraint
-- organization_admin_liveness). An organization that has never had an
-- administrator — every newly provisioned one: organization creation seeds the
-- roles and grants no administrator — is legal, and creating it, granting in
-- it and revoking non-administrator grants in it are unaffected.
--
-- Paths closed (each fires a row-level AFTER trigger, so it observes the
-- statement's final state, as in 0005):
--   1. revoking the grant           AFTER DELETE ON user_roles
--   2. deleting the holder          the cascade from users performs a real
--                                   DELETE on user_roles (path 1). The holder's
--                                   row is gone by then, so its status cannot be
--                                   read: a grant whose user no longer exists is
--                                   treated as qualifying (fail closed).
--   3. disabling the holder         AFTER UPDATE OF status ON users, leaving
--                                   'active', for every organization the user
--                                   administers, locked in sorted order
--   4. changing the grant           AFTER UPDATE OF scope_type, scope_id,
--                                   user_id, role_id, org_id ON user_roles
--                                   (acc_app holds no UPDATE on user_roles since
--                                   0025; the owner still can)
--   5. deleting the role            already closed: user_roles_role_id_fk is ON
--                                   DELETE RESTRICT (0004) and system roles are
--                                   immutable (fn_protect_system_roles)
--
-- Exemption — the organization row no longer exists. Deleting an organization
-- cascades its grants and roles; the check finds no organization and returns.
-- There is NO status exemption (a suspended or closed organization keeps the
-- rule; the decisions name none) and NO owner exemption (the platform rule has
-- none: 0005/0010 apply to every writer, owner included).
--
-- Lock: pg_advisory_xact_lock(482019308, hashtext(O::text)) — the two-int4
-- form, which PostgreSQL keeps in a keyspace separate from every one-bigint
-- lock (pg_locks.objsubid 2 versus 1), so it never collides with
-- PLATFORM_ADMIN_LOCK_KEY (4820193077) or the bigint idempotency and session
-- locks. 482019308 is ORG_ADMIN_LOCK_CLASS from @acc/db; the suite asserts the
-- two agree. One lock per organization, so administration of different
-- organizations never contends; several organizations are locked in ascending
-- id order.
--
-- SECURITY DEFINER with search_path = public, pg_temp, as the platform
-- functions: the count must see every grant and user of O whatever the
-- writer's RLS context. EXECUTE is revoked from PUBLIC on all three functions
-- (the 0016/0017 hygiene); no principal is granted EXECUTE. PostgreSQL checks
-- EXECUTE on a trigger function when a trigger is created, never when it
-- fires, so the triggers run for every writer.
--
-- Rerun-safe: the verification block reads only; CREATE OR REPLACE keeps each
-- function's identity; DROP TRIGGER IF EXISTS precedes each CREATE TRIGGER;
-- REVOKE is idempotent. The verification block refuses the migration — nothing
-- applied — if the data the triggers rely on is not in the expected shape.
-- Existing organizations with zero administrators are legal and not checked.
-- =============================================================================

DO $$
DECLARE
  v_count  bigint;
  v_sample text;
BEGIN
  -- The triggers identify an administrator grant by scope_id = O and read O
  -- from scope_id; an organization-scope grant must name an existing
  -- organization and agree with its own org_id.
  SELECT count(*), string_agg(id::text, ', ') INTO v_count, v_sample FROM (
    SELECT ur.id FROM user_roles ur
     WHERE ur.scope_type = 'organization'
       AND (ur.scope_id IS NULL
            OR ur.org_id IS DISTINCT FROM ur.scope_id
            OR NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = ur.scope_id))
     ORDER BY ur.id) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0028 verification failed [organization_grants_consistent]: % organization-scope grants whose scope disagrees with their organization (ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;

  -- One org_admin role per organization: the definition names it by key.
  SELECT count(*), string_agg(org_id::text, ', ') INTO v_count, v_sample FROM (
    SELECT r.org_id FROM roles r
     WHERE r.org_id IS NOT NULL AND r.key = 'org_admin'
     GROUP BY r.org_id HAVING count(*) > 1
     ORDER BY r.org_id) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0028 verification failed [org_admin_role_unique]: % organizations with more than one org_admin role (ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;--> statement-breakpoint

-- The invariant itself: one definition, shared by every trigger path.
CREATE OR REPLACE FUNCTION fn_assert_org_admin_remains(p_org_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining integer;
BEGIN
  -- Serialise against every other transaction that could remove one of this
  -- organization's administrators. 482019308 = ORG_ADMIN_LOCK_CLASS (@acc/db).
  PERFORM pg_advisory_xact_lock(482019308, hashtext(p_org_id::text));

  -- The organization itself is being deleted (its grants cascade with it).
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_org_id) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_remaining
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
    JOIN roles r ON r.id = ur.role_id
   WHERE ur.scope_type = 'organization'
     AND ur.scope_id = p_org_id
     AND r.org_id = p_org_id
     AND r.key = 'org_admin'
     AND r.is_system_role
     AND u.status = 'active';

  IF v_remaining = 0 THEN
    RAISE EXCEPTION
      'organization administration: refusing to leave organization % with no active administrator', p_org_id
      USING ERRCODE = 'restrict_violation',
            CONSTRAINT = 'organization_admin_liveness';
  END IF;
END;
$$;--> statement-breakpoint

-- Paths 1, 2 and 4: a grant leaving the counted set. Only a grant that
-- qualified before the change reaches the lock and the count; any other
-- organization-scope grant returns after two indexed lookups.
CREATE OR REPLACE FUNCTION fn_user_roles_org_admin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  -- Not the organization's seeded org_admin. A role that no longer exists
  -- (only within an organization delete's cascade) is treated as qualifying;
  -- the organization check in fn_assert_org_admin_remains then decides.
  IF EXISTS (
    SELECT 1 FROM roles r
     WHERE r.id = OLD.role_id
       AND NOT (r.org_id = OLD.scope_id AND r.key = 'org_admin' AND r.is_system_role)
  ) THEN
    RETURN NULL;
  END IF;
  -- Held by a user who is not active: it was not counted, so removing it
  -- changes nothing. A user row that no longer exists (the cascade from
  -- deleting the user) is treated as qualifying — fail closed.
  IF EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id AND u.status <> 'active') THEN
    RETURN NULL;
  END IF;
  PERFORM fn_assert_org_admin_remains(OLD.scope_id);
  RETURN NULL; -- AFTER triggers ignore the return value.
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_user_roles_org_admin_liveness ON "user_roles";--> statement-breakpoint
CREATE TRIGGER trg_user_roles_org_admin_liveness
  AFTER DELETE ON "user_roles"
  FOR EACH ROW WHEN (OLD.scope_type = 'organization')
  EXECUTE FUNCTION fn_user_roles_org_admin_guard();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_user_roles_org_admin_liveness_update ON "user_roles";--> statement-breakpoint
CREATE TRIGGER trg_user_roles_org_admin_liveness_update
  AFTER UPDATE OF scope_type, scope_id, user_id, role_id, org_id ON "user_roles"
  FOR EACH ROW WHEN (OLD.scope_type = 'organization')
  EXECUTE FUNCTION fn_user_roles_org_admin_guard();--> statement-breakpoint

-- Path 3: a holder leaving 'active'. Every organization the user administers,
-- in ascending id order so two such transactions cannot deadlock on the locks.
CREATE OR REPLACE FUNCTION fn_users_org_admin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  FOR v_org_id IN
    SELECT DISTINCT ur.scope_id
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = NEW.id
       AND ur.scope_type = 'organization'
       AND r.org_id = ur.scope_id
       AND r.key = 'org_admin'
       AND r.is_system_role
     ORDER BY ur.scope_id
  LOOP
    PERFORM fn_assert_org_admin_remains(v_org_id);
  END LOOP;
  RETURN NULL;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_users_org_admin_liveness ON "users";--> statement-breakpoint
CREATE TRIGGER trg_users_org_admin_liveness
  AFTER UPDATE OF status ON "users"
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION fn_users_org_admin_guard();--> statement-breakpoint

REVOKE ALL ON FUNCTION fn_assert_org_admin_remains(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_user_roles_org_admin_guard() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_users_org_admin_guard() FROM PUBLIC;
