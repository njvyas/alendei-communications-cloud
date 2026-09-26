-- =============================================================================
-- Phase 1C.1a — organization lifecycle metadata (ADR-012 F-1)
--
-- Two nullable columns recording when an organization's status last changed and
-- the operator's stated reason, bounded to 500 characters. The lifecycle itself
-- uses the existing `organization_status` values (`active | suspended | closed`);
-- no value is added.
--
-- Additive only. No table is created, so no new RLS policy is required:
-- `organizations_select`, `organizations_update` and `organizations_auth_read`
-- from migration `0000` govern the new columns unchanged, and the existing table
-- grants cover them. **No organization-status predicate is added to RLS** —
-- status is enforced by application authorization (ADR-012 OD-3), so the direct
-- database guarantees proven at Gate B are untouched.
-- =============================================================================

ALTER TABLE "organizations" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_status_reason_length" CHECK ("organizations"."status_reason" IS NULL OR char_length("organizations"."status_reason") <= 500);
