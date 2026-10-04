-- =============================================================================
-- Phase 2.4 — the provider configuration revision (ADR-013 "2.4 design",
-- PROVIDER_ADAPTER.md §3a.2)
--
-- One row whose revision the database — never the application — increases, in
-- the same transaction as any change to:
--   channels                      insert / update / delete
--   providers                     insert / delete / update OF channel_id, name,
--                                 adapter_key, status (not health or circuit)
--   provider_capabilities         insert / update / delete
--   provider_circuit_policy       update
-- and announces with pg_notify('acc_provider_configuration', revision). NOTIFY
-- is delivered only on commit, so a revision is never announced before the
-- change it describes is visible, and a rollback leaves neither a revision nor
-- a notification. The payload is a hint: instances re-read PostgreSQL.
--
-- The application's advisory configuration snapshot reconciles against this
-- revision; nothing here takes part in authorization. RLS: read on platform-
-- scope eligibility, update on providers.manage (the only application writers
-- of the watched columns). No INSERT/DELETE; nothing to acc_auth or acc_relay.
-- No SECURITY DEFINER function: the trigger functions are SECURITY INVOKER.
-- =============================================================================

CREATE TABLE "provider_configuration_revision" (
	"scope" text PRIMARY KEY DEFAULT 'platform' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_configuration_revision_singleton" CHECK ("provider_configuration_revision"."scope" = 'platform'),
	CONSTRAINT "provider_configuration_revision_positive" CHECK ("provider_configuration_revision"."revision" >= 1)
);
--> statement-breakpoint
INSERT INTO provider_configuration_revision (scope, revision) VALUES ('platform', 1)
ON CONFLICT (scope) DO NOTHING;
--> statement-breakpoint

-- --- The revision only ever increases (every principal, the owner included) ----
CREATE FUNCTION fn_provider_configuration_revision_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.scope IS DISTINCT FROM OLD.scope THEN
    RAISE EXCEPTION 'the configuration revision key is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'the configuration revision only increases (% -> %)', OLD.revision, NEW.revision
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_provider_configuration_revision_monotonic
  BEFORE UPDATE ON provider_configuration_revision
  FOR EACH ROW EXECUTE FUNCTION fn_provider_configuration_revision_monotonic();
--> statement-breakpoint

-- --- Bump and announce, in the change's own transaction -----------------------
-- SECURITY INVOKER: it runs as the writer, under the writer's RLS. A statement
-- that changed nothing visible to the writer (e.g. refused rows) may still bump
-- the revision when the writer may update it — a harmless extra reload; a
-- writer without providers.manage updates zero revision rows and announces
-- nothing.
CREATE FUNCTION fn_provider_configuration_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_revision bigint;
BEGIN
  UPDATE provider_configuration_revision
     SET revision = revision + 1, changed_at = now()
   WHERE scope = 'platform'
  RETURNING revision INTO v_revision;
  IF v_revision IS NOT NULL THEN
    PERFORM pg_notify('acc_provider_configuration', v_revision::text);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_channels_configuration_changed
  AFTER INSERT OR UPDATE OR DELETE ON channels
  FOR EACH STATEMENT EXECUTE FUNCTION fn_provider_configuration_changed();
--> statement-breakpoint
CREATE TRIGGER trg_providers_configuration_inserted_deleted
  AFTER INSERT OR DELETE ON providers
  FOR EACH STATEMENT EXECUTE FUNCTION fn_provider_configuration_changed();
--> statement-breakpoint
CREATE TRIGGER trg_providers_configuration_updated
  AFTER UPDATE OF channel_id, name, adapter_key, status ON providers
  FOR EACH STATEMENT EXECUTE FUNCTION fn_provider_configuration_changed();
--> statement-breakpoint
CREATE TRIGGER trg_provider_capabilities_configuration_changed
  AFTER INSERT OR UPDATE OR DELETE ON provider_capabilities
  FOR EACH STATEMENT EXECUTE FUNCTION fn_provider_configuration_changed();
--> statement-breakpoint
CREATE TRIGGER trg_provider_circuit_policy_configuration_changed
  AFTER UPDATE ON provider_circuit_policy
  FOR EACH STATEMENT EXECUTE FUNCTION fn_provider_configuration_changed();
--> statement-breakpoint

-- --- RLS and grants -----------------------------------------------------------------
ALTER TABLE provider_configuration_revision ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY provider_configuration_revision_platform_read ON provider_configuration_revision
  FOR SELECT TO acc_app
  USING (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY provider_configuration_revision_platform_update ON provider_configuration_revision
  FOR UPDATE TO acc_app
  USING (app_has_platform_permission('providers.manage'))
  WITH CHECK (app_has_platform_permission('providers.manage'));
--> statement-breakpoint
GRANT SELECT, UPDATE ON provider_configuration_revision TO acc_app;
