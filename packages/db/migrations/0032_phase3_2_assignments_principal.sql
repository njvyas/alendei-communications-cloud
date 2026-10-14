-- =============================================================================
-- Phase 3.2 — Organization Provider Assignments & acc_dispatch Principal
-- (ADR-014 §4, §9.2, §17.1, P3-D01–P3-D06)
--
-- 1. `organization_provider_assignments`:
--    Couples the platform provider catalogue to tenant organizations.
--    Classified under TENANCY_RECORD_TABLES (Model A RLS).
--    Unique on (org_id, provider_id) and unique on (org_id, channel_id, priority).
--    Priority integer >= 1; status active | disabled; no DELETE.
--    FKs to organizations, providers, channels, and composite FK
--    (provider_id, channel_id) -> providers(id, channel_id).
-- 2. `acc_dispatch` principal:
--    Dedicated database role for background dispatch execution.
--    Least privilege: access limited to assigned providers, channels,
--    circuit policy, active assignments, and organization status.
--    Strictly zero access to tenant content or identity credentials.
-- 3. Audit log policy for organization_provider.* actions at platform scope.
-- =============================================================================

-- --- 1. Target constraint for composite foreign key --------------------------
ALTER TABLE "providers" ADD CONSTRAINT "providers_id_channel_id_key" UNIQUE("id","channel_id");--> statement-breakpoint

-- --- 2. Organization Provider Assignments Table & Indexes --------------------
CREATE TYPE "public"."assignment_status" AS ENUM('active', 'disabled');--> statement-breakpoint

CREATE TABLE "organization_provider_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"status" "assignment_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_org_provider_assignments_org_provider" UNIQUE("org_id","provider_id"),
	CONSTRAINT "uq_org_provider_assignments_org_channel_priority" UNIQUE("org_id","channel_id","priority"),
	CONSTRAINT "org_provider_assignments_priority_check" CHECK ("organization_provider_assignments"."priority" >= 1)
);
--> statement-breakpoint

ALTER TABLE "organization_provider_assignments" ADD CONSTRAINT "organization_provider_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_provider_assignments" ADD CONSTRAINT "organization_provider_assignments_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_provider_assignments" ADD CONSTRAINT "organization_provider_assignments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_provider_assignments" ADD CONSTRAINT "organization_provider_assignments_provider_channel_fk" FOREIGN KEY ("provider_id","channel_id") REFERENCES "public"."providers"("id","channel_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "org_provider_assignments_org_id_idx" ON "organization_provider_assignments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_provider_assignments_provider_id_idx" ON "organization_provider_assignments" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "org_provider_assignments_channel_id_idx" ON "organization_provider_assignments" USING btree ("channel_id");--> statement-breakpoint

-- --- 3. Updated-at & Tenant-key Immutability Triggers ------------------------
CREATE TRIGGER trg_org_provider_assignments_updated_at
  BEFORE UPDATE ON "organization_provider_assignments"
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();--> statement-breakpoint

CREATE TRIGGER trg_org_provider_assignments_tenant_key_immutable
  AFTER UPDATE OF org_id, provider_id, channel_id ON "organization_provider_assignments"
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.provider_id IS DISTINCT FROM NEW.provider_id OR OLD.channel_id IS DISTINCT FROM NEW.channel_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id', 'provider_id', 'channel_id');--> statement-breakpoint

-- --- 4. Database Role acc_dispatch -------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acc_dispatch') THEN
    CREATE ROLE acc_dispatch NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO acc_dispatch;--> statement-breakpoint

-- --- 5. Dispatch Context Functions (Plain STABLE SQL, ADR-014 §9.2) -----------
CREATE OR REPLACE FUNCTION app_dispatch_message_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.dispatch_message_id', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_dispatch_message_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_dispatch_message_id() TO acc_app, acc_dispatch;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_dispatch_claim_token() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.dispatch_claim_token', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_dispatch_claim_token() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_dispatch_claim_token() TO acc_app, acc_dispatch;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app_session_bypasses_rls() TO acc_dispatch;--> statement-breakpoint

-- --- 6. RLS: Model A for organization_provider_assignments -------------------
ALTER TABLE "organization_provider_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY organization_provider_assignments_tenant ON "organization_provider_assignments"
  FOR ALL TO acc_app
  USING (app_org_in_scope(org_id))
  WITH CHECK (app_org_in_scope(org_id));--> statement-breakpoint

CREATE POLICY organization_provider_assignments_dispatch_select ON "organization_provider_assignments"
  FOR SELECT TO acc_dispatch
  USING (org_id = app_current_org_id() AND status = 'active');--> statement-breakpoint

-- --- 7. acc_dispatch Policies on Existing Tables (ADR-014 §9.2) ---------------
CREATE POLICY providers_dispatch_select ON "providers"
  FOR SELECT TO acc_dispatch
  USING (EXISTS (
    SELECT 1 FROM "organization_provider_assignments" opa
    WHERE opa.provider_id = providers.id
      AND opa.org_id = app_current_org_id()
      AND opa.status = 'active'
  ));--> statement-breakpoint

CREATE POLICY providers_dispatch_update ON "providers"
  FOR UPDATE TO acc_dispatch
  USING (EXISTS (
    SELECT 1 FROM "organization_provider_assignments" opa
    WHERE opa.provider_id = providers.id
      AND opa.org_id = app_current_org_id()
      AND opa.status = 'active'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "organization_provider_assignments" opa
    WHERE opa.provider_id = providers.id
      AND opa.org_id = app_current_org_id()
      AND opa.status = 'active'
  ));--> statement-breakpoint

CREATE POLICY provider_capabilities_dispatch_select ON "provider_capabilities"
  FOR SELECT TO acc_dispatch
  USING (EXISTS (
    SELECT 1 FROM "organization_provider_assignments" opa
    WHERE opa.provider_id = provider_capabilities.provider_id
      AND opa.org_id = app_current_org_id()
      AND opa.status = 'active'
  ));--> statement-breakpoint

CREATE POLICY provider_health_dispatch_select ON "provider_health"
  FOR SELECT TO acc_dispatch
  USING (EXISTS (
    SELECT 1 FROM "organization_provider_assignments" opa
    WHERE opa.provider_id = provider_health.provider_id
      AND opa.org_id = app_current_org_id()
      AND opa.status = 'active'
  ));--> statement-breakpoint

CREATE POLICY provider_health_dispatch_insert ON "provider_health"
  FOR INSERT TO acc_dispatch
  WITH CHECK (
    kind = 'submission'
    AND EXISTS (
      SELECT 1 FROM "organization_provider_assignments" opa
      WHERE opa.provider_id = provider_health.provider_id
        AND opa.org_id = app_current_org_id()
        AND opa.status = 'active'
    )
  );--> statement-breakpoint

CREATE POLICY channels_dispatch_select ON "channels"
  FOR SELECT TO acc_dispatch
  USING (true);--> statement-breakpoint

CREATE POLICY provider_circuit_policy_dispatch_select ON "provider_circuit_policy"
  FOR SELECT TO acc_dispatch
  USING (true);--> statement-breakpoint

CREATE POLICY organizations_dispatch_select ON "organizations"
  FOR SELECT TO acc_dispatch
  USING (id = app_current_org_id());--> statement-breakpoint

-- --- 8. Table & Column Grants ------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "organization_provider_assignments" TO acc_app;--> statement-breakpoint

GRANT SELECT ON "organization_provider_assignments" TO acc_dispatch;--> statement-breakpoint
GRANT SELECT ON "channels", "provider_circuit_policy" TO acc_dispatch;--> statement-breakpoint
GRANT SELECT (id, status) ON "organizations" TO acc_dispatch;--> statement-breakpoint
GRANT SELECT ON "providers", "provider_capabilities" TO acc_dispatch;--> statement-breakpoint
GRANT UPDATE (health_state, health_changed_at, circuit_state, circuit_generation, circuit_changed_at, circuit_probe_successes, circuit_probes, updated_at) ON "providers" TO acc_dispatch;--> statement-breakpoint
GRANT SELECT, INSERT ON "provider_health" TO acc_dispatch;--> statement-breakpoint

-- --- 9. Audit Log Policy for Assignment Operations (Platform Scope) ----------
CREATE POLICY audit_logs_organization_provider_insert ON "audit_logs" FOR INSERT TO acc_app
  WITH CHECK (
    scope_type = 'platform'
    AND scope_id IS NULL
    AND actor_type = 'user'
    AND actor_user_id = app_current_user_id()
    AND outcome = 'success'
    AND resource_type = 'OrganizationProviderAssignment'
    AND action IN (
      'organization_provider.assigned',
      'organization_provider.updated',
      'organization_provider.disabled',
      'organization_provider.enabled'
    )
    AND app_has_platform_permission('providers.manage')
  );
