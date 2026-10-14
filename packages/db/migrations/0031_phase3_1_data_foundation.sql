CREATE TYPE "public"."consent_event_type" AS ENUM('grant', 'revoke');--> statement-breakpoint
CREATE TYPE "public"."contact_identity_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."template_approval_status" AS ENUM('draft', 'pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."suppression_status" AS ENUM('active', 'cleared');--> statement-breakpoint
CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"consent_type" text NOT NULL,
	"event" "consent_event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_identities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"raw_address" text NOT NULL,
	"normalized_address" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" "contact_identity_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_id_workspace_org_key" UNIQUE("id","workspace_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_status" "template_approval_status" DEFAULT 'draft' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid,
	"raw_address" text NOT NULL,
	"normalized_address" text NOT NULL,
	"reason" text NOT NULL,
	"status" "suppression_status" DEFAULT 'active' NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_contact_fk" FOREIGN KEY ("contact_id","workspace_id","org_id") REFERENCES "public"."contacts"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_contact_fk" FOREIGN KEY ("contact_id","workspace_id","org_id") REFERENCES "public"."contacts"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_org_fk" FOREIGN KEY ("workspace_id","org_id") REFERENCES "public"."workspaces"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_events_org_id_idx" ON "consent_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "consent_events_contact_channel_type_idx" ON "consent_events" USING btree ("contact_id","channel_id","consent_type","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contact_identities_workspace_active" ON "contact_identities" USING btree ("workspace_id","channel_id","normalized_address") WHERE "contact_identities"."status" = 'active';--> statement-breakpoint
CREATE INDEX "contact_identities_org_id_idx" ON "contact_identities" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contact_identities_contact_id_idx" ON "contact_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_identities_workspace_id_idx" ON "contact_identities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "contacts_org_id_idx" ON "contacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contacts_workspace_id_idx" ON "contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "contacts_workspace_created_at_id_idx" ON "contacts" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_templates_org_name_active" ON "templates" USING btree ("org_id",lower("name")) WHERE "templates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "templates_org_id_idx" ON "templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "templates_channel_id_idx" ON "templates" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_suppressions_channel_active" ON "suppressions" USING btree ("org_id","channel_id","normalized_address") WHERE "suppressions"."status" = 'active' AND "suppressions"."channel_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_suppressions_org_active" ON "suppressions" USING btree ("org_id","normalized_address") WHERE "suppressions"."status" = 'active' AND "suppressions"."channel_id" IS NULL;--> statement-breakpoint
CREATE INDEX "suppressions_org_id_idx" ON "suppressions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "suppressions_channel_id_idx" ON "suppressions" USING btree ("channel_id");--> statement-breakpoint

-- --- Updated-at triggers ----------------------------------------------------
CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON "contacts" FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_contact_identities_updated_at BEFORE UPDATE ON "contact_identities" FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_templates_updated_at BEFORE UPDATE ON "templates" FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();--> statement-breakpoint
CREATE TRIGGER trg_suppressions_updated_at BEFORE UPDATE ON "suppressions" FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();--> statement-breakpoint

-- --- Consent events immutability trigger -------------------------------------
CREATE OR REPLACE FUNCTION fn_consent_events_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'consent_events is append-only' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_consent_events_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_consent_events_immutable
  BEFORE UPDATE OR DELETE ON "consent_events"
  FOR EACH ROW EXECUTE FUNCTION fn_consent_events_immutable();--> statement-breakpoint

-- --- Tenant-key immutability triggers (ADR-015 R-3) -------------------------
CREATE TRIGGER trg_contacts_tenant_key_immutable
  AFTER UPDATE OF org_id, workspace_id ON "contacts" FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id', 'workspace_id');--> statement-breakpoint
CREATE TRIGGER trg_contact_identities_tenant_key_immutable
  AFTER UPDATE OF org_id, workspace_id, contact_id ON "contact_identities" FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.contact_id IS DISTINCT FROM NEW.contact_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id', 'workspace_id', 'contact_id');--> statement-breakpoint
CREATE TRIGGER trg_templates_org_id_immutable
  AFTER UPDATE OF org_id ON "templates" FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id');--> statement-breakpoint
CREATE TRIGGER trg_suppressions_org_id_immutable
  AFTER UPDATE OF org_id ON "suppressions" FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id');--> statement-breakpoint

-- --- Model B RLS: ENABLE (never FORCE) and policies for acc_app with exact P -
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "suppressions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY contacts_select ON "contacts" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY contacts_insert ON "contacts" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY contacts_update ON "contacts" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

CREATE POLICY contact_identities_select ON "contact_identities" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY contact_identities_insert ON "contact_identities" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY contact_identities_update ON "contact_identities" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

CREATE POLICY consent_events_select ON "consent_events" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY consent_events_insert ON "consent_events" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

CREATE POLICY templates_select ON "templates" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY templates_insert ON "templates" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY templates_update ON "templates" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

CREATE POLICY suppressions_select ON "suppressions" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY suppressions_insert ON "suppressions" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY suppressions_update ON "suppressions" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

-- --- Table grants: SELECT, INSERT, UPDATE for acc_app (no DELETE, no TRUNCATE) -
GRANT SELECT, INSERT, UPDATE ON "contacts", "contact_identities", "templates", "suppressions" TO acc_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "consent_events" TO acc_app;--> statement-breakpoint

-- --- Channel code helper for tenant content normalization (ADR-014) ---
CREATE OR REPLACE FUNCTION app_channel_code(p_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT code::text FROM channels WHERE id = p_id;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_code(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_code(uuid) TO acc_app;

