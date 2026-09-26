-- =============================================================================
-- Phase 1C.1b — team lifecycle (ADR-012 F-6, OD-5)
--
-- Teams gain the same `active | archived` lifecycle workspaces already have,
-- reusing the existing `workspace_status` enum so there is one status model
-- below the organization. `ADD COLUMN ... NOT NULL DEFAULT 'active'` backfills
-- every existing team as `active` in the same statement. The index serves
-- `status` filters on `GET /teams` within an organization.
--
-- Additive only. No table is created and no policy changes: `teams_tenant` and
-- `teams_auth_read` from migration `0000` govern the new column unchanged, and
-- the existing table grants cover it. Workspace and team isolation remain
-- application authorization inside the organization boundary (ADR-011 D-4); no
-- status predicate is added to RLS.
-- =============================================================================

ALTER TABLE "teams" ADD COLUMN "status" "workspace_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX "teams_org_id_status_idx" ON "teams" USING btree ("org_id","status");