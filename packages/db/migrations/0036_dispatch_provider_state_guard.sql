-- =============================================================================
-- Migration: 0036_dispatch_provider_state_guard
-- Issue: BE-DISPATCH-01
--
-- Objective:
-- 1. Grant EXECUTE on app_has_platform_permission(text) to acc_dispatch.
--    In migration 0019, execute was granted to acc_app only. The dedicated
--    acc_dispatch principal (introduced in 0032) was granted column-level
--    UPDATE on providers (health and circuit columns), but was missing EXECUTE
--    on app_has_platform_permission(text), which is referenced by the
--    fn_providers_state_guard() BEFORE UPDATE trigger.
--
-- 2. Harden fn_providers_state_guard() with nested conditional evaluation.
--    Evaluating the column distinctness check before invoking
--    app_has_platform_permission('providers.manage') prevents unnecessary
--    function calls when administrative columns are unchanged, and prevents
--    compound SPI expression permission check failures.
--
-- Preserved:
-- - Security invoker execution context (caller authority)
-- - Pinned search path: public, pg_temp
-- - Bypass check: app_session_bypasses_rls()
-- - All error SQLSTATE codes: 'insufficient_privilege' (42501), 'check_violation' (23514)
-- - Exact administrative column list: channel_id, name, adapter_key, status, health_override
-- - Exact circuit state transition rules: closed>open, open>half_open, half_open>open, half_open>closed
-- - Exact circuit generation invariants (+1 per transition, immutable without transition)
-- - Existing trigger attachment: trg_providers_state_guard BEFORE UPDATE ON providers
--
-- Rollback:
--   REVOKE EXECUTE ON FUNCTION app_has_platform_permission(text) FROM acc_dispatch;
--   Restore 0022 single-expression definition of fn_providers_state_guard().
-- =============================================================================

-- --- 1. Grant EXECUTE on app_has_platform_permission to acc_dispatch ---------
GRANT EXECUTE ON FUNCTION app_has_platform_permission(text) TO acc_dispatch;--> statement-breakpoint

-- --- 2. Replace fn_providers_state_guard with nested conditional evaluation ---
CREATE OR REPLACE FUNCTION fn_providers_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_session_bypasses_rls() THEN
    RETURN NEW;
  END IF;

  IF (NEW.channel_id, NEW.name, NEW.adapter_key, NEW.status, NEW.health_override)
       IS DISTINCT FROM
     (OLD.channel_id, OLD.name, OLD.adapter_key, OLD.status, OLD.health_override) THEN
    IF NOT app_has_platform_permission('providers.manage') THEN
      RAISE EXCEPTION 'changing a provider''s administrative columns or health override requires providers.manage'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF NEW.circuit_state IS DISTINCT FROM OLD.circuit_state THEN
    IF OLD.circuit_state::text || '>' || NEW.circuit_state::text NOT IN
         ('closed>open', 'open>half_open', 'half_open>open', 'half_open>closed') THEN
      RAISE EXCEPTION 'illegal circuit transition % -> %', OLD.circuit_state, NEW.circuit_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.circuit_generation IS DISTINCT FROM OLD.circuit_generation + 1 THEN
      RAISE EXCEPTION 'a circuit transition advances the generation by exactly one (% -> %)',
        OLD.circuit_generation, NEW.circuit_generation
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.circuit_generation IS DISTINCT FROM OLD.circuit_generation THEN
    RAISE EXCEPTION 'the circuit generation changes only with a circuit transition'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
