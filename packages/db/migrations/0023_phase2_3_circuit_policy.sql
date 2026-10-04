-- =============================================================================
-- Phase 2.3 Gate D.3 remediation — an administrable circuit policy
-- (ADR-013 "Gate D.3 remediation design", PROVIDER_ADAPTER.md §6a, §6c, §6i)
--
-- 1. `provider_circuit_policy`: the circuit parameters, one platform-wide row,
--    seeded below with the values frozen before the review (version 1). Every
--    safe bound is a CHECK; a SECURITY INVOKER trigger keeps the key immutable
--    and advances `version` by exactly one per update. RLS: read on platform-
--    scope eligibility (every circuit decision reads it), update on
--    `providers.manage`; no INSERT or DELETE grant. Nothing to acc_auth or
--    acc_relay.
-- 2. `providers.circuit_probes` replaces the single probe slot
--    (`circuit_probe_id`, `circuit_probe_lease_until`, migration 0022): up to
--    `half_open_max_probes` live slots. A slot held at upgrade is carried over.
-- 3. `provider_health.circuit_policy_version`: the policy each decision used.
-- 4. One exact-shape audit policy for `provider.circuit_policy_updated`.
--
-- No SECURITY DEFINER function is added; `app_has_platform_scope()` (0018) and
-- `app_has_platform_permission(text)` (0019) are reused.
-- =============================================================================

CREATE TABLE "provider_circuit_policy" (
	"scope" text PRIMARY KEY DEFAULT 'platform' NOT NULL,
	"window_ms" integer NOT NULL,
	"window_max_samples" integer NOT NULL,
	"min_samples" integer NOT NULL,
	"failure_percent" integer NOT NULL,
	"cooldown_ms" integer NOT NULL,
	"half_open_max_probes" integer NOT NULL,
	"probe_lease_ms" integer NOT NULL,
	"half_open_successes_to_close" integer NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_circuit_policy_singleton" CHECK ("provider_circuit_policy"."scope" = 'platform'),
	CONSTRAINT "provider_circuit_policy_window_ms" CHECK ("provider_circuit_policy"."window_ms" BETWEEN 10000 AND 3600000),
	CONSTRAINT "provider_circuit_policy_window_max_samples" CHECK ("provider_circuit_policy"."window_max_samples" BETWEEN 1 AND 200),
	CONSTRAINT "provider_circuit_policy_min_samples" CHECK ("provider_circuit_policy"."min_samples" BETWEEN 1 AND 200),
	CONSTRAINT "provider_circuit_policy_min_le_max" CHECK ("provider_circuit_policy"."min_samples" <= "provider_circuit_policy"."window_max_samples"),
	CONSTRAINT "provider_circuit_policy_failure_percent" CHECK ("provider_circuit_policy"."failure_percent" BETWEEN 1 AND 100),
	CONSTRAINT "provider_circuit_policy_cooldown_ms" CHECK ("provider_circuit_policy"."cooldown_ms" BETWEEN 1000 AND 3600000),
	CONSTRAINT "provider_circuit_policy_half_open_max_probes" CHECK ("provider_circuit_policy"."half_open_max_probes" BETWEEN 1 AND 10),
	CONSTRAINT "provider_circuit_policy_probe_lease_ms" CHECK ("provider_circuit_policy"."probe_lease_ms" BETWEEN 5000 AND 600000),
	CONSTRAINT "provider_circuit_policy_successes_to_close" CHECK ("provider_circuit_policy"."half_open_successes_to_close" BETWEEN 1 AND 20),
	CONSTRAINT "provider_circuit_policy_version_positive" CHECK ("provider_circuit_policy"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "providers" DROP CONSTRAINT "providers_circuit_probe_slot";--> statement-breakpoint
ALTER TABLE "provider_health" ADD COLUMN "circuit_policy_version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_probes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Carry a probe slot held at upgrade over into the new list before the old
-- columns go (an owner write: the state guard exempts the maintenance session).
UPDATE providers
SET circuit_probes = jsonb_build_array(jsonb_build_object(
  'id', circuit_probe_id,
  'leaseUntil', to_char(circuit_probe_lease_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
WHERE circuit_probe_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN "circuit_probe_id";--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN "circuit_probe_lease_until";--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_circuit_probes" CHECK (jsonb_typeof("providers"."circuit_probes") = 'array' AND jsonb_array_length("providers"."circuit_probes") <= 10 AND (jsonb_array_length("providers"."circuit_probes") = 0 OR "providers"."circuit_state" = 'half_open'));
--> statement-breakpoint

-- --- The seeded policy (version 1): the values frozen before the review --------
INSERT INTO provider_circuit_policy (
  scope, window_ms, window_max_samples, min_samples, failure_percent,
  cooldown_ms, half_open_max_probes, probe_lease_ms, half_open_successes_to_close
) VALUES ('platform', 60000, 20, 5, 50, 30000, 1, 10000, 2)
ON CONFLICT (scope) DO NOTHING;
--> statement-breakpoint

-- --- updated_at, and the version / key guard -------------------------------------
CREATE TRIGGER trg_provider_circuit_policy_updated_at BEFORE UPDATE ON provider_circuit_policy
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
-- Every principal, the owner included: the key never changes and every update
-- advances the version by exactly one, so a stale or replayed writer cannot
-- overwrite a newer policy without the application seeing a version gap.
CREATE FUNCTION fn_provider_circuit_policy_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.scope IS DISTINCT FROM OLD.scope THEN
    RAISE EXCEPTION 'the circuit policy key is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'a circuit policy update advances the version by exactly one (% -> %)',
      OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_provider_circuit_policy_version BEFORE UPDATE ON provider_circuit_policy
  FOR EACH ROW EXECUTE FUNCTION fn_provider_circuit_policy_version();
--> statement-breakpoint

-- --- RLS and grants ----------------------------------------------------------------
ALTER TABLE provider_circuit_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY provider_circuit_policy_platform_read ON provider_circuit_policy FOR SELECT TO acc_app
  USING (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY provider_circuit_policy_platform_update ON provider_circuit_policy FOR UPDATE TO acc_app
  USING (app_has_platform_permission('providers.manage'))
  WITH CHECK (app_has_platform_permission('providers.manage'));
--> statement-breakpoint
GRANT SELECT, UPDATE ON provider_circuit_policy TO acc_app;
--> statement-breakpoint

-- --- Audit: the policy change, an exact row shape ------------------------------------
CREATE POLICY audit_logs_provider_circuit_policy_insert ON audit_logs FOR INSERT TO acc_app
  WITH CHECK (
    scope_type = 'platform'
    AND scope_id IS NULL
    AND actor_type = 'user'
    AND actor_user_id = app_current_user_id()
    AND outcome = 'success'
    AND action = 'provider.circuit_policy_updated'
    AND resource_type = 'ProviderCircuitPolicy'
    AND resource_id IS NULL
    AND app_has_platform_permission('providers.manage')
  );
