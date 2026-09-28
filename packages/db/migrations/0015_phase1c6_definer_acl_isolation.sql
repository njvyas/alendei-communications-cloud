-- =============================================================================
-- Phase 1C.6 remediation — SECURITY DEFINER ACL and narrowing isolation
-- (Phase 1C.6 security review, findings H-1 and H-2; DATABASE.md §Migration 0015)
--
-- H-1. The three SECURITY DEFINER trigger functions that migration 0014 created
--      or replaced were executable by PUBLIC. A direct call is refused (a
--      trigger function can only run as a trigger), but any principal with the
--      database TEMP privilege — `acc_app`, `acc_auth`, `acc_relay` — could
--      attach one to a temporary table it owns and run its body as the owner
--      on rows of its choosing: disclosing another tenant's grant scope types
--      and organization ids, and holding `FOR SHARE` on any role row. PUBLIC's
--      EXECUTE is revoked. PostgreSQL checks EXECUTE on a trigger function when
--      a trigger is created, never when it fires, so the existing triggers keep
--      running for every writer; only attaching the function elsewhere, or
--      calling it, is refused.
--
-- H-2. Under REPEATABLE READ or SERIALIZABLE the narrowing guard reads
--      `user_roles` with the transaction's snapshot, so a grant committed after
--      that snapshot — which only share-locked the role row, creating no new
--      row version to conflict with — is invisible to it, and the narrowing
--      could commit over it. A narrowing (a change that stops admitting some
--      scope type) is therefore refused unless the transaction is READ
--      COMMITTED, where the guard's statement takes a fresh snapshot after the
--      role row is locked. Widening, and every other role change, is
--      unaffected at any isolation level. The grant side needs no change: a
--      grant at REPEATABLE READ/SERIALIZABLE whose role row was narrowed after
--      its snapshot fails with `40001` on `FOR SHARE`.
--
-- No table, column, index, RLS policy or other grant changes. Migration 0014 is
-- not edited.
-- =============================================================================

-- (H-2) The narrowing guard. Identical to migration 0014 except for the
-- isolation check, which runs first and fails closed for every writer.
-- `CREATE OR REPLACE` keeps the function's ACL; the REVOKE below follows it.
CREATE OR REPLACE FUNCTION fn_roles_guard_allowed_scope_types() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_in_use    text;
  v_isolation text := current_setting('transaction_isolation');
BEGIN
  IF v_isolation <> 'read committed'
     AND EXISTS (
       SELECT 1
         FROM unnest(coalesce(OLD.allowed_scope_types, '{}'::role_scope_type[])) AS o(scope_type)
        WHERE NOT (o.scope_type = ANY (coalesce(NEW.allowed_scope_types, '{}'::role_scope_type[])))
     ) THEN
    RAISE EXCEPTION
      'roles: narrowing allowed_scope_types of role % requires READ COMMITTED isolation (this transaction is %)', NEW.key, v_isolation
      USING ERRCODE = 'invalid_transaction_state',
            CONSTRAINT = 'roles_allowed_scope_types_narrowing_isolation',
            HINT = 'Under a transaction snapshot a grant committed after the snapshot is invisible to this guard; narrow the role in a READ COMMITTED transaction.';
  END IF;

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

-- (H-1) Trigger-only execution: no principal but the owner holds EXECUTE.
REVOKE ALL ON FUNCTION fn_validate_user_role_scope() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_roles_guard_allowed_scope_types() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_organizations_guard_reseller_id() FROM PUBLIC;
