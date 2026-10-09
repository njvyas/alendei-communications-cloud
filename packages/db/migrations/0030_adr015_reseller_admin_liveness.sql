-- =============================================================================
-- ADR-015 follow-up (item 4, approved 08-Oct-2026) — last-reseller-administrator
-- protection (RBAC.md §7d; DATABASE.md §2; DECISIONS.md §1o). The reseller
-- counterpart of migration 0028 (organizations) and of 0005/0010/0016/0017
-- (the platform).
--
-- The invariant, stated exactly. A *reseller administrator* of reseller R is an
-- ACTIVE user (users.status = 'active') holding a grant of the seeded system
-- platform role reseller_admin
--     roles.org_id IS NULL AND roles.key = 'reseller_admin' AND roles.is_system_role
-- at scope_type = 'reseller' AND scope_id = R.
--
-- It guards TRANSITIONS, not absence: a transaction that removes or
-- deactivates an administrator-qualifying grant of R and leaves R with zero
-- reseller administrators is refused (restrict_violation, constraint
-- reseller_admin_liveness). A reseller that has never had an administrator —
-- the seeded default reseller among them — is legal, and creating it,
-- granting in it and revoking non-administrator grants in it are unaffected.
-- Peer revocation is unaffected while another administrator remains.
--
-- Paths closed (each a row-level AFTER trigger, so it observes the statement's
-- final state, as in 0005 and 0028):
--   1. revoking the grant           AFTER DELETE ON user_roles
--   2. deleting the holder          the cascade from users performs a real
--                                   DELETE on user_roles (path 1). The holder's
--                                   row is gone by then, so its status cannot be
--                                   read: a grant whose user no longer exists is
--                                   treated as qualifying (fail closed).
--   3. disabling the holder         AFTER UPDATE OF status ON users, leaving
--                                   'active', for every reseller the user
--                                   administers, locked in ascending id order
--   4. changing the grant           AFTER UPDATE OF scope_type, scope_id,
--                                   user_id, role_id, org_id ON user_roles
--                                   (acc_app holds no UPDATE on user_roles since
--                                   0025; the owner still can)
--   5. deleting the role            already closed: user_roles_role_id_fk is ON
--                                   DELETE RESTRICT (0004) and system roles are
--                                   immutable (fn_protect_system_roles)
--
-- Exemption — the reseller row no longer exists: the check returns. Unlike an
-- organization, a reseller's grants do not cascade with it — reseller-scope
-- grants carry no foreign key to resellers, and trg_resellers_grant_restrict
-- (0025) refuses deleting a reseller while any grant references it — so this
-- exemption is not reachable by ordinary DML today; it is kept so the
-- invariant never blocks a reseller's own removal should that path change.
-- There is NO status exemption (reseller lifecycle is deferred, OD-2) and NO
-- owner exemption (as 0005/0010/0028: the rule binds every writer).
--
-- Lock: pg_advisory_xact_lock(482019309, hashtext(R::text)) — the two-int4
-- form, in the keyspace 0028 uses, with a class distinct from
-- ORG_ADMIN_LOCK_CLASS (482019308) and apart from the one-bigint
-- PLATFORM_ADMIN_LOCK_KEY (4820193077) and the bigint idempotency and session
-- locks. 482019309 is RESELLER_ADMIN_LOCK_CLASS from @acc/db; the suite
-- asserts the two agree. One lock per reseller, so administration of
-- different resellers never contends.
--
-- Lock order: organization → platform → reseller, everywhere. PostgreSQL fires
-- same-event triggers in name order, so on users the liveness triggers fire
-- trg_users_org_admin_liveness, trg_users_platform_admin_liveness,
-- trg_users_reseller_admin_liveness; the services take the locks in the same
-- order before the write.
--
-- SECURITY DEFINER with search_path = public, pg_temp, as the platform and
-- organization functions: the count must see every grant and user of R
-- whatever the writer's RLS context. EXECUTE is revoked from PUBLIC on all
-- three functions; no principal is granted EXECUTE. PostgreSQL checks EXECUTE
-- on a trigger function when a trigger is created, never when it fires, so the
-- triggers run for every writer.
--
-- Rerun-safe: the verification block reads only; CREATE OR REPLACE keeps each
-- function's identity; DROP TRIGGER IF EXISTS precedes each CREATE TRIGGER;
-- REVOKE is idempotent. The verification block refuses the migration — nothing
-- applied — if the data the triggers rely on is not in the expected shape.
-- Existing resellers with zero administrators are legal and not checked.
-- =============================================================================

DO $$
DECLARE
  v_count  bigint;
  v_sample text;
BEGIN
  -- The triggers identify an administrator grant by scope_id = R and read R
  -- from scope_id; a reseller-scope grant must name an existing reseller and
  -- carry no organization.
  SELECT count(*), string_agg(id::text, ', ') INTO v_count, v_sample FROM (
    SELECT ur.id FROM user_roles ur
     WHERE ur.scope_type = 'reseller'
       AND (ur.scope_id IS NULL
            OR ur.org_id IS NOT NULL
            OR NOT EXISTS (SELECT 1 FROM resellers s WHERE s.id = ur.scope_id))
     ORDER BY ur.id) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0030 verification failed [reseller_grants_consistent]: % reseller-scope grants whose scope disagrees with their reseller (ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;

  -- The definition names the platform role by key. roles_platform_key_key
  -- already allows at most one platform role per key; if it exists it must be
  -- the seeded system role. It is created by the seed, which runs after the
  -- migrations, so a fresh database legitimately has none here.
  SELECT count(*), string_agg(id::text, ', ') INTO v_count, v_sample FROM (
    SELECT r.id FROM roles r
     WHERE r.org_id IS NULL AND r.key = 'reseller_admin' AND NOT r.is_system_role
     ORDER BY r.id) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0030 verification failed [reseller_admin_role_system]: % platform roles keyed reseller_admin that are not the system role (ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;--> statement-breakpoint

-- The invariant itself: one definition, shared by every trigger path.
CREATE OR REPLACE FUNCTION fn_assert_reseller_admin_remains(p_reseller_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining integer;
BEGIN
  -- Serialise against every other transaction that could remove one of this
  -- reseller's administrators. 482019309 = RESELLER_ADMIN_LOCK_CLASS (@acc/db).
  PERFORM pg_advisory_xact_lock(482019309, hashtext(p_reseller_id::text));

  -- The reseller itself no longer exists.
  IF NOT EXISTS (SELECT 1 FROM resellers s WHERE s.id = p_reseller_id) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_remaining
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
    JOIN roles r ON r.id = ur.role_id
   WHERE ur.scope_type = 'reseller'
     AND ur.scope_id = p_reseller_id
     AND r.org_id IS NULL
     AND r.key = 'reseller_admin'
     AND r.is_system_role
     AND u.status = 'active';

  IF v_remaining = 0 THEN
    RAISE EXCEPTION
      'reseller administration: refusing to leave reseller % with no active administrator', p_reseller_id
      USING ERRCODE = 'restrict_violation',
            CONSTRAINT = 'reseller_admin_liveness';
  END IF;
END;
$$;--> statement-breakpoint

-- Paths 1, 2 and 4: a grant leaving the counted set. Only a grant that
-- qualified before the change reaches the lock and the count; any other
-- reseller-scope grant returns after two indexed lookups.
CREATE OR REPLACE FUNCTION fn_user_roles_reseller_admin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  -- Not the seeded reseller_admin. A role that no longer exists cannot occur
  -- (ON DELETE RESTRICT); it would be treated as qualifying, fail closed.
  IF EXISTS (
    SELECT 1 FROM roles r
     WHERE r.id = OLD.role_id
       AND NOT (r.org_id IS NULL AND r.key = 'reseller_admin' AND r.is_system_role)
  ) THEN
    RETURN NULL;
  END IF;
  -- Held by a user who is not active: it was not counted, so removing it
  -- changes nothing. A user row that no longer exists (the cascade from
  -- deleting the user) is treated as qualifying — fail closed.
  IF EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id AND u.status <> 'active') THEN
    RETURN NULL;
  END IF;
  PERFORM fn_assert_reseller_admin_remains(OLD.scope_id);
  RETURN NULL; -- AFTER triggers ignore the return value.
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_user_roles_reseller_admin_liveness ON "user_roles";--> statement-breakpoint
CREATE TRIGGER trg_user_roles_reseller_admin_liveness
  AFTER DELETE ON "user_roles"
  FOR EACH ROW WHEN (OLD.scope_type = 'reseller')
  EXECUTE FUNCTION fn_user_roles_reseller_admin_guard();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_user_roles_reseller_admin_liveness_update ON "user_roles";--> statement-breakpoint
CREATE TRIGGER trg_user_roles_reseller_admin_liveness_update
  AFTER UPDATE OF scope_type, scope_id, user_id, role_id, org_id ON "user_roles"
  FOR EACH ROW WHEN (OLD.scope_type = 'reseller')
  EXECUTE FUNCTION fn_user_roles_reseller_admin_guard();--> statement-breakpoint

-- Path 3: a holder leaving 'active'. Every reseller the user administers, in
-- ascending id order so two such transactions cannot deadlock on the locks.
CREATE OR REPLACE FUNCTION fn_users_reseller_admin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_reseller_id uuid;
BEGIN
  FOR v_reseller_id IN
    SELECT DISTINCT ur.scope_id
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = NEW.id
       AND ur.scope_type = 'reseller'
       AND r.org_id IS NULL
       AND r.key = 'reseller_admin'
       AND r.is_system_role
     ORDER BY ur.scope_id
  LOOP
    PERFORM fn_assert_reseller_admin_remains(v_reseller_id);
  END LOOP;
  RETURN NULL;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_users_reseller_admin_liveness ON "users";--> statement-breakpoint
CREATE TRIGGER trg_users_reseller_admin_liveness
  AFTER UPDATE OF status ON "users"
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION fn_users_reseller_admin_guard();--> statement-breakpoint

REVOKE ALL ON FUNCTION fn_assert_reseller_admin_remains(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_user_roles_reseller_admin_guard() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_users_reseller_admin_guard() FROM PUBLIC;
