-- =============================================================================
-- Phase 1B.5.6 — the at-least-one-active-platform-admin invariant (ADR-005 D-7)
--
-- The invariant, stated exactly:
--
--   At every committed state there exists at least one user `u` with
--   `u.status = 'active'` holding a grant of a platform role at `platform`
--   scope.
--
-- "Active" is load-bearing: a disabled user holding `alendei_super_admin`
-- cannot authenticate, so the grant confers nothing and must not count. The
-- definition is the authorization model's own — `ScopeResolver` derives
-- `isPlatformAdmin` as "holds some grant at platform scope" — and is not a
-- second, parallel notion of administrator.
--
-- --- Why this cannot live in the application ----------------------------------
--
-- An application count is write-skew-prone. Two concurrent transactions each
-- count two admins, each decide their own removal is safe, each remove a
-- *different* admin, and both commit. Under READ COMMITTED neither sees the
-- other's uncommitted delete and no row they wrote overlaps, so nothing
-- serialises them and zero admins remain.
--
-- --- Why an advisory lock, and not something smaller --------------------------
--
--   `SELECT … FOR UPDATE`      locks rows that exist; the hazard here is the
--                              *absence* of rows, and it does not block a
--                              concurrent INSERT of a replacement admin.
--   `SERIALIZABLE`             correct, but changes the isolation level of the
--                              whole request path and forces 40001 retry
--                              handling everywhere, for one invariant.
--   CHECK / unique index       per-row; cannot express "at least one row exists".
--   `pg_advisory_xact_lock`    serialises exactly the mutators of this
--                              invariant, releases on commit *and* rollback —
--                              the property that makes `SET LOCAL` safe — and
--                              needs no isolation change.
--
-- The key is `PLATFORM_ADMIN_LOCK_KEY` exported from `@acc/db`. Every call site
-- takes the same one; a second key would silently disable the guarantee.
--
-- --- Why row-level AFTER triggers with WHEN clauses ---------------------------
--
-- A trigger that locked and counted on *every* `user_roles` DELETE would
-- serialise all role revocation platform-wide — ordinary tenant administration
-- queuing behind a lock it can never affect. The `WHEN` clause is the early
-- exit: a row that is not a platform grant never reaches the function, so it
-- takes no lock and runs no count. Contention is confined to platform-admin
-- mutations, which are rare. That is the property ADR-005 D-7 claims; this is
-- how it is actually obtained.
--
-- `AFTER … FOR EACH ROW` rather than `FOR EACH STATEMENT`, and the distinction
-- matters less than it appears: PostgreSQL queues AFTER-row triggers and fires
-- them once the whole statement has completed, so every invocation observes the
-- *final* state of the statement. A multi-row delete that is collectively safe
-- is therefore never refused on an intermediate state. Transition tables would
-- express the same thing, but PostgreSQL forbids them on a trigger with a
-- column list (`UPDATE OF status`), and dropping the column list would fire this
-- on every `users` write — `last_login_at` on each sign-in included.
--
-- --- Paths covered -------------------------------------------------------------
--
--   1. Revoking the grant        DELETE on `user_roles` — including the cascade
--                                from `DELETE FROM users`, which performs a real
--                                DELETE on `user_roles` and fires this trigger.
--   2. Disabling the holder      UPDATE OF `status` on `users`.
--   3. Deleting the role         already closed: `user_roles_role_id_fk` is
--                                ON DELETE RESTRICT (migration `0004`), so the
--                                role cannot go while the grant exists, and the
--                                grant's removal is path 1.
--
-- Enforcement lives in the database for the reason `RBAC.md` §6 already gives
-- for cross-tenant grants: a guard that exists only in the service is a
-- different quality of assurance, and a migration script or admin tool bypasses
-- it. The service keeps its own check so the caller gets a clean `409`; this is
-- the guarantee.
-- =============================================================================

-- The invariant itself, as a plain function rather than a trigger function, so
-- both trigger paths share exactly one definition of it. A second copy would be
-- a second thing to keep in step, and the two would eventually disagree.
--
-- `4820193077` is `PLATFORM_ADMIN_LOCK_KEY` from `@acc/db`. The two are asserted
-- equal by the integration suite rather than trusted to stay in step by review.
CREATE OR REPLACE FUNCTION fn_assert_platform_admin_remains() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining integer;
BEGIN
  -- Serialise against every other transaction that could remove an admin.
  -- Reached only past the callers' early exits, so an ordinary tenant
  -- revocation acquires nothing.
  PERFORM pg_advisory_xact_lock(4820193077);

  SELECT count(*) INTO v_remaining
  FROM user_roles ur
  JOIN users u ON u.id = ur.user_id
  WHERE ur.scope_type = 'platform'
    AND u.status = 'active';

  IF v_remaining = 0 THEN
    RAISE EXCEPTION
      'platform administration: refusing to leave the platform with no active administrator'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;--> statement-breakpoint

-- --- 1. Revoking a platform grant ---------------------------------------------
-- Fires only for a deleted row that *was* a platform grant. Covers the cascade
-- from `DELETE FROM users` too, which performs a real DELETE here.
CREATE OR REPLACE FUNCTION fn_user_roles_platform_admin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM fn_assert_platform_admin_remains();
  RETURN NULL; -- AFTER triggers ignore the return value.
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_user_roles_platform_admin_liveness ON "user_roles";--> statement-breakpoint
CREATE TRIGGER trg_user_roles_platform_admin_liveness
  AFTER DELETE ON "user_roles"
  FOR EACH ROW WHEN (OLD.scope_type = 'platform')
  EXECUTE FUNCTION fn_user_roles_platform_admin_guard();--> statement-breakpoint

-- --- 2. Disabling a platform administrator ------------------------------------
-- Only a transition *away from* active can violate the invariant; the WHEN
-- clause admits nothing else. The holder check cannot live in WHEN — it reads
-- another table — so it is the function's first statement, one indexed lookup
-- ahead of the lock, keeping an ordinary user's disable free of both.
CREATE OR REPLACE FUNCTION fn_users_platform_admin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = NEW.id AND ur.scope_type = 'platform'
  ) THEN
    RETURN NULL;
  END IF;
  PERFORM fn_assert_platform_admin_remains();
  RETURN NULL;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_users_platform_admin_liveness ON "users";--> statement-breakpoint
CREATE TRIGGER trg_users_platform_admin_liveness
  AFTER UPDATE OF status ON "users"
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION fn_users_platform_admin_guard();--> statement-breakpoint

-- Partial index supporting the liveness count. Small and highly selective:
-- platform grants are a handful of rows in a table that grows with every tenant.
CREATE INDEX IF NOT EXISTS user_roles_platform_scope_idx
  ON "user_roles" ("user_id") WHERE "scope_type" = 'platform';
