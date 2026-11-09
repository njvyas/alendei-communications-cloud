CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_workspace_org_fk" FOREIGN KEY ("workspace_id","org_id") REFERENCES "public"."workspaces"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_segments_workspace_name" ON "segments" USING btree ("workspace_id",lower("name")) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "segments_org_id_idx" ON "segments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "segments_workspace_id_idx" ON "segments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "segments_workspace_created_at_id_idx" ON "segments" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
ALTER TABLE "segments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY segments_select ON "segments" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY segments_insert ON "segments" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY segments_update ON "segments" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "segments" TO acc_app;--> statement-breakpoint
REVOKE ALL ON "segments" FROM PUBLIC, acc_auth, acc_relay;
