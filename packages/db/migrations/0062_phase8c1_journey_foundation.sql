-- Phase 8C PR 8C-1: journey foundation (owner approval 10-Nov-2026; docs/PHASE-8C-JOURNEYS-HANDOVER.md §5).
-- Journeys and their versions, Model B RLS, publication immutability, journeys.read/manage.
-- Non-executing by construction: no execution, queue, trigger-event or step table, and nothing
-- here sends, schedules or calls out. Expand-only: no existing object is altered.
CREATE TYPE "public"."journey_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."journey_version_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint

CREATE TABLE "journeys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "journey_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_journeys_id_workspace_org" UNIQUE("id","workspace_id","org_id"),
	CONSTRAINT "journeys_name_length" CHECK (char_length("name") BETWEEN 1 AND 200)
);--> statement-breakpoint

ALTER TABLE "journeys" ADD CONSTRAINT "journeys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_workspace_org_fk" FOREIGN KEY ("workspace_id","org_id") REFERENCES "public"."workspaces"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journeys_org_workspace_status_idx" ON "journeys" USING btree ("org_id","workspace_id","status");--> statement-breakpoint

CREATE TABLE "journey_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "journey_version_status" DEFAULT 'draft' NOT NULL,
	"graph_schema_version" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"graph_sha256" text NOT NULL,
	"created_by" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_versions_number_positive" CHECK ("version_number" >= 1),
	CONSTRAINT "journey_versions_sha256_hex" CHECK ("graph_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "journey_versions_graph_object" CHECK (jsonb_typeof("graph") = 'object'),
	CONSTRAINT "journey_versions_published_shape" CHECK (("status" = 'draft') = ("published_at" IS NULL))
);--> statement-breakpoint

ALTER TABLE "journey_versions" ADD CONSTRAINT "journey_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_versions" ADD CONSTRAINT "journey_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_versions" ADD CONSTRAINT "journey_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_versions" ADD CONSTRAINT "journey_versions_journey_fk" FOREIGN KEY ("journey_id","workspace_id","org_id") REFERENCES "public"."journeys"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_journey_versions_journey_number" ON "journey_versions" USING btree ("journey_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_journey_versions_one_draft" ON "journey_versions" USING btree ("journey_id") WHERE status = 'draft';--> statement-breakpoint

-- Publication immutability. A draft may change freely and become `published`; a published
-- version may only become `retired` (8C-2), with every other column unchanged; a retired
-- version never changes. Identity columns never change. No version is ever deleted.
CREATE FUNCTION app_journey_versions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journey versions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.journey_id IS DISTINCT FROM OLD.journey_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'journey version identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'retired' THEN
      RAISE EXCEPTION 'a draft journey version cannot be retired' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'published' AND NEW.status = 'retired'
     AND NEW.graph_schema_version = OLD.graph_schema_version AND NEW.graph = OLD.graph
     AND NEW.graph_sha256 = OLD.graph_sha256 AND NEW.published_at = OLD.published_at
     AND NEW.published_by IS NOT DISTINCT FROM OLD.published_by THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'journey version % is % and immutable', OLD.id, OLD.status
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_versions_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_journey_versions_guard BEFORE UPDATE OR DELETE ON "journey_versions"
  FOR EACH ROW EXECUTE FUNCTION app_journey_versions_guard();--> statement-breakpoint

ALTER TABLE "journeys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journey_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY journeys_select ON "journeys" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journeys_insert ON "journeys" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journeys_update ON "journeys" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

CREATE POLICY journey_versions_select ON "journey_versions" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_versions_insert ON "journey_versions" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_versions_update ON "journey_versions" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "journeys", "journey_versions" TO acc_app;--> statement-breakpoint
REVOKE ALL ON "journeys", "journey_versions" FROM PUBLIC, acc_auth, acc_relay;--> statement-breakpoint

INSERT INTO permissions (key, domain, action, description, classification, allowed_scope_types) VALUES
  ('journeys.read', 'journeys', 'read',
   'Read journeys, their versions and graphs', 'tenant_content', '{organization,workspace}'),
  ('journeys.manage', 'journeys', 'manage',
   'Create, edit, version and publish journeys', 'tenant_content', '{organization,workspace}')
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

SELECT set_config('app.provisioning', 'on', true);--> statement-breakpoint

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NOT NULL
  AND r.is_system_role
  AND r.key = 'org_admin'
  AND p.key IN ('journeys.read', 'journeys.manage')
ON CONFLICT DO NOTHING;--> statement-breakpoint

SELECT set_config('app.provisioning', 'off', true);
