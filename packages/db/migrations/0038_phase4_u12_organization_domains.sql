-- =============================================================================
-- Migration: 0038_phase4_u12_organization_domains
-- Issue: Phase 4 U12 Multi-Tenant Customer Onboarding & Domain Management
--
-- Objective:
-- 1. Add brand_config JSONB column to organizations table.
-- 2. Create organization_domains table for mapping organizations to platform
--    subdomains (*.alendei.io) and custom white-label domains.
-- 3. Enforce RLS on organization_domains:
--    - acc_app: app_org_in_scope(org_id)
--    - acc_auth: true (for hostname-based domain resolution before auth)
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE "public"."domain_type" AS ENUM('subdomain', 'custom');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."domain_status" AS ENUM('pending_verification', 'active', 'suspended', 'revoked');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."domain_verification_method" AS ENUM('dns_txt', 'dns_cname', 'platform_subdomain');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."domain_verification_status" AS ENUM('pending', 'verified', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "brand_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "organization_domains" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "domain" text NOT NULL,
  "domain_type" "domain_type" DEFAULT 'subdomain' NOT NULL,
  "status" "domain_status" DEFAULT 'pending_verification' NOT NULL,
  "verification_method" "domain_verification_method" DEFAULT 'dns_txt' NOT NULL,
  "verification_value" text NOT NULL,
  "verification_status" "domain_verification_status" DEFAULT 'pending' NOT NULL,
  "verified_at" timestamp with time zone,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "organization_domains_domain_key" ON "organization_domains" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_domains_single_primary_per_org" ON "organization_domains" USING btree ("org_id") WHERE is_primary;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_domains_org_id_idx" ON "organization_domains" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_domains_status_idx" ON "organization_domains" USING btree ("status");--> statement-breakpoint

CREATE OR REPLACE TRIGGER trg_organization_domains_updated_at
BEFORE UPDATE ON "organization_domains"
FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();--> statement-breakpoint

ALTER TABLE "organization_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "organization_domains_select" ON "organization_domains";--> statement-breakpoint
CREATE POLICY "organization_domains_select" ON "organization_domains" FOR SELECT TO acc_app USING (app_org_in_scope(org_id));--> statement-breakpoint

DROP POLICY IF EXISTS "organization_domains_auth_read" ON "organization_domains";--> statement-breakpoint
CREATE POLICY "organization_domains_auth_read" ON "organization_domains" FOR SELECT TO acc_auth USING (true);--> statement-breakpoint

DROP POLICY IF EXISTS "organization_domains_write" ON "organization_domains";--> statement-breakpoint
CREATE POLICY "organization_domains_write" ON "organization_domains" FOR ALL TO acc_app USING (app_org_in_scope(org_id)) WITH CHECK (app_org_in_scope(org_id));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_domains" TO acc_app;--> statement-breakpoint
GRANT SELECT ON "organization_domains" TO acc_auth;
