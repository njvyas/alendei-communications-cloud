-- =============================================================================
-- Phase 8B.1 — Campaign Schema Foundation & Permissions
-- (DATABASE.md §8, ARCHITECTURE.md §11, OD-8B-1)
--
-- 1. `campaigns`:
--    Tenant-content table (Model B RLS: app_content_context_valid).
--    State machine: draft, scheduled, running, paused, completed, cancelled.
-- 2. `campaign_recipients`:
--    Tenant-content table (Model B RLS: app_content_context_valid).
--    Materialized intended recipients with UNIQUE(campaign_id, contact_id) deduplication.
-- 3. `messages.campaign_id`:
--    Attribution FK from core messages to campaigns.
-- 4. Permissions:
--    campaigns.read, campaigns.manage (tenant_content, {organization, workspace}).
-- =============================================================================

CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."campaign_schedule_mode" AS ENUM('immediate', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."campaign_recipient_source_type" AS ENUM('all_contacts', 'tag_segment', 'custom_list');--> statement-breakpoint
CREATE TYPE "public"."campaign_recipient_status" AS ENUM('pending', 'enqueued', 'sent', 'skipped', 'failed');--> statement-breakpoint

CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"channel_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"template_variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"recipient_source" jsonb NOT NULL,
	"schedule_mode" "campaign_schedule_mode" DEFAULT 'immediate' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"throttling" jsonb DEFAULT '{"rateLimitPerSecond": 25, "maxAttemptsPerRecipient": 1}'::jsonb NOT NULL,
	"routing_policy_id" uuid,
	"created_by" uuid,
	"metrics" jsonb DEFAULT '{"totalRecipients": null, "sent": 0, "delivered": 0, "read": 0, "failed": 0, "deliveryRate": 0}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_campaigns_id_org_id" UNIQUE("id","org_id")
);--> statement-breakpoint

ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_org_fk" FOREIGN KEY ("workspace_id","org_id") REFERENCES "public"."workspaces"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "campaigns_org_workspace_status_idx" ON "campaigns" USING btree ("org_id","workspace_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_scheduled_idx" ON "campaigns" USING btree ("status","scheduled_at") WHERE status = 'scheduled' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "campaigns_org_id_id_desc_idx" ON "campaigns" USING btree ("org_id","id" DESC);--> statement-breakpoint

CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"identity_id" uuid,
	"status" "campaign_recipient_status" DEFAULT 'pending' NOT NULL,
	"message_id" uuid,
	"skip_reason" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_identity_id_contact_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."contact_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_org_fk" FOREIGN KEY ("campaign_id","org_id") REFERENCES "public"."campaigns"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_workspace_org_fk" FOREIGN KEY ("contact_id","workspace_id","org_id") REFERENCES "public"."contacts"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "uq_campaign_recipients_campaign_contact" ON "campaign_recipients" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_campaign_status_idx" ON "campaign_recipients" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaign_recipients_message_id_idx" ON "campaign_recipients" USING btree ("message_id") WHERE message_id IS NOT NULL;--> statement-breakpoint

ALTER TABLE "messages" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_org_campaign_idx" ON "messages" USING btree ("org_id","campaign_id") WHERE campaign_id IS NOT NULL;--> statement-breakpoint

-- --- Model B RLS: campaigns and campaign_recipients -------------------------
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY campaigns_select ON "campaigns" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY campaigns_insert ON "campaigns" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY campaigns_update ON "campaigns" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

CREATE POLICY campaign_recipients_select ON "campaign_recipients" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY campaign_recipients_insert ON "campaign_recipients" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY campaign_recipients_update ON "campaign_recipients" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

-- Grants & Revokes
GRANT SELECT, INSERT, UPDATE ON "campaigns", "campaign_recipients" TO acc_app;--> statement-breakpoint
REVOKE ALL ON "campaigns", "campaign_recipients" FROM PUBLIC, acc_auth, acc_relay;--> statement-breakpoint

-- --- Permissions seeding & org_admin backfill (OD-8B-1) -----------------------
INSERT INTO permissions (key, domain, action, description, classification, allowed_scope_types) VALUES
  ('campaigns.read', 'campaigns', 'read',
   'Read campaigns, metrics, previews and campaign recipients', 'tenant_content', '{organization,workspace}'),
  ('campaigns.manage', 'campaigns', 'manage',
   'Create, update, configure and administer campaigns', 'tenant_content', '{organization,workspace}')
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

SELECT set_config('app.provisioning', 'on', true);--> statement-breakpoint

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NOT NULL
  AND r.is_system_role
  AND r.key = 'org_admin'
  AND p.key IN ('campaigns.read', 'campaigns.manage')
ON CONFLICT DO NOTHING;--> statement-breakpoint

SELECT set_config('app.provisioning', 'off', true);
