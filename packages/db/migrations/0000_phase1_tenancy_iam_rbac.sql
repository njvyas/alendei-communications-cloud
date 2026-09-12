-- =============================================================================
-- Phase 1 — tenancy, IAM and RBAC foundation
--
-- This single change set creates the Phase 1 tables AND their Row-Level Security
-- policies, scope-integrity triggers and role grants. RLS is never added in a
-- later migration than the table it protects (TENANCY.md §3, DATABASE.md §1).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- UUIDv7 (DATABASE.md §1) — time-sortable primary keys, implemented in plain SQL
-- so no non-core extension is required and ids are generable either side.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
LANGUAGE sql VOLATILE
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex')::uuid;
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Transaction-scoped tenant context (TENANCY.md §§3, 5; DATABASE.md §14a).
--
-- Every accessor reads a `SET LOCAL` session variable. `SET LOCAL` resets
-- automatically at transaction end, which is what makes a pooled connection safe
-- to hand to a different tenant's request or job immediately afterwards. No code
-- path may use connection-level `SET` for any of these.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.current_org_id', true), '')::uuid $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.current_workspace_id', true), '')::uuid $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_current_reseller_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.current_reseller_id', true), '')::uuid $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.current_user_id', true), '')::uuid $$;
--> statement-breakpoint

-- True only when the authenticated principal holds a platform-scoped role
-- (RBAC.md §3). Set by the server from resolved auth material, never from input.
CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT coalesce(nullif(current_setting('app.is_platform_admin', true), ''), 'off') = 'on' $$;
--> statement-breakpoint

-- Set only by the tenant-provisioning code path, inside its own transaction,
-- alongside `app.current_org_id` already set to the organization being created.
-- It permits creating that one organization row and nothing else: it never
-- widens read access and never applies to an org other than the one in context.
CREATE OR REPLACE FUNCTION app_is_provisioning() RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT coalesce(nullif(current_setting('app.provisioning', true), ''), 'off') = 'on' $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Database principals (least privilege; none of them owns a table, so none of
-- them can bypass RLS):
--
--   acc_app    tenant-scoped business access; every statement runs under a
--              transaction-local tenant context and is RLS-filtered.
--   acc_auth   identity resolution only. Credential verification happens before
--              any tenant context exists, so it cannot be RLS-filtered by org;
--              its reach is instead bounded by table grants to exactly the
--              identity tables plus the reads needed to build a principal.
--   acc_relay  the transactional-outbox publisher: cross-tenant by necessity
--              (EVENTS.md §1), and granted nothing but the outbox.
--
-- Created NOLOGIN and passwordless here; `npm run db:migrate` grants LOGIN and
-- sets each password from the environment, so no credential is ever in git.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acc_app') THEN
    CREATE ROLE acc_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acc_auth') THEN
    CREATE ROLE acc_auth NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acc_relay') THEN
    CREATE ROLE acc_relay NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO acc_app, acc_auth, acc_relay;
--> statement-breakpoint

CREATE TYPE "public"."billing_mode" AS ENUM('prepaid', 'postpaid');--> statement-breakpoint
CREATE TYPE "public"."billing_policy" AS ENUM('charge_per_logical_message', 'charge_per_attempt');--> statement-breakpoint
CREATE TYPE "public"."organization_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."reseller_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."workspace_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'invited', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."role_scope_type" AS ENUM('platform', 'reseller', 'organization', 'workspace', 'team');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"reseller_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text,
	"gstin" text,
	"billing_mode" "billing_mode" DEFAULT 'prepaid' NOT NULL,
	"billing_policy" "billing_policy" DEFAULT 'charge_per_logical_message' NOT NULL,
	"status" "organization_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_gstin_format" CHECK ("organizations"."gstin" IS NULL OR "organizations"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$')
);
--> statement-breakpoint
CREATE TABLE "resellers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"domain" text,
	"brand_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_markup_pct" numeric(6, 3) DEFAULT '0' NOT NULL,
	"status" "reseller_status" DEFAULT 'active' NOT NULL,
	"is_platform_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resellers_markup_range" CHECK ("resellers"."default_markup_pct" >= 0)
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_id_org_id_key" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"brand_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "workspace_status" DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_id_org_id_key" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_scopes_is_array" CHECK (jsonb_typeof("api_keys"."scopes") = 'array'),
	CONSTRAINT "api_keys_prefix_shape" CHECK ("api_keys"."key_prefix" ~ '^ak_(live|test)_[A-Za-z0-9]{16}$')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"device_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"password_hash" text,
	"password_updated_at" timestamp with time zone,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret_ref" text,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_format" CHECK ("users"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	CONSTRAINT "users_active_requires_credential" CHECK ("users"."status" <> 'active' OR "users"."password_hash" IS NOT NULL OR "users"."mfa_secret_ref" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "ws_tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ticket_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ws_tickets_scope_is_array" CHECK (jsonb_typeof("ws_tickets"."scope") = 'array'),
	CONSTRAINT "ws_tickets_ttl_positive" CHECK ("ws_tickets"."expires_at" > "ws_tickets"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"domain" text NOT NULL,
	"action" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_format" CHECK ("permissions"."key" ~ '^[a-z][a-z0-9_.]*\.[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"org_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pkey" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system_role" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_format" CHECK ("roles"."key" ~ '^[a-z][a-z0-9_]{2,63}$')
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"org_id" uuid,
	"scope_type" "role_scope_type" NOT NULL,
	"scope_id" uuid,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_scope_shape" CHECK (("user_roles"."scope_type" = 'platform' AND "user_roles"."scope_id" IS NULL AND "user_roles"."org_id" IS NULL)
       OR ("user_roles"."scope_type" = 'reseller' AND "user_roles"."scope_id" IS NOT NULL AND "user_roles"."org_id" IS NULL)
       OR ("user_roles"."scope_type" IN ('organization','workspace','team') AND "user_roles"."scope_id" IS NOT NULL AND "user_roles"."org_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'pending' NOT NULL,
	"response_status_code" integer,
	"response_snapshot" jsonb,
	"resource_id" uuid,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_completed_shape" CHECK ("idempotency_keys"."status" <> 'completed' OR ("idempotency_keys"."response_status_code" IS NOT NULL AND "idempotency_keys"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_workspace_org_fk" FOREIGN KEY ("workspace_id","org_id") REFERENCES "public"."workspaces"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ws_tickets" ADD CONSTRAINT "ws_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ws_tickets" ADD CONSTRAINT "ws_tickets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ws_tickets" ADD CONSTRAINT "ws_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ws_tickets" ADD CONSTRAINT "ws_tickets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_reseller_id_idx" ON "organizations" USING btree ("reseller_id");--> statement-breakpoint
CREATE INDEX "organizations_status_idx" ON "organizations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "resellers_slug_key" ON "resellers" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "resellers_domain_key" ON "resellers" USING btree ("domain") WHERE "resellers"."domain" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resellers_single_platform_default" ON "resellers" USING btree ("is_platform_default") WHERE "resellers"."is_platform_default";--> statement-breakpoint
CREATE UNIQUE INDEX "teams_workspace_name_key" ON "teams" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "teams_org_id_idx" ON "teams" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "teams_workspace_id_idx" ON "teams" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_slug_key" ON "workspaces" USING btree ("org_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_single_default_per_org" ON "workspaces" USING btree ("org_id") WHERE "workspaces"."is_default";--> statement-breakpoint
CREATE INDEX "workspaces_org_id_idx" ON "workspaces" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_prefix_key" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "api_keys_org_id_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_active_idx" ON "sessions" USING btree ("user_id","expires_at") WHERE "sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "ws_tickets_ticket_hash_key" ON "ws_tickets" USING btree ("ticket_hash");--> statement-breakpoint
CREATE INDEX "ws_tickets_org_id_idx" ON "ws_tickets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ws_tickets_expires_at_idx" ON "ws_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions" USING btree ("key");--> statement-breakpoint
CREATE INDEX "permissions_domain_idx" ON "permissions" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "role_permissions_org_id_idx" ON "role_permissions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_key_key" ON "roles" USING btree ("org_id","key") WHERE "roles"."org_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_platform_key_key" ON "roles" USING btree ("key") WHERE "roles"."org_id" IS NULL;--> statement-breakpoint
CREATE INDEX "roles_org_id_idx" ON "roles" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_unique_scoped_grant" ON "user_roles" USING btree ("user_id","role_id","scope_type","scope_id") WHERE "user_roles"."scope_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_unique_platform_grant" ON "user_roles" USING btree ("user_id","role_id","scope_type") WHERE "user_roles"."scope_id" IS NULL;--> statement-breakpoint
CREATE INDEX "user_roles_user_id_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_id_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "user_roles_org_id_idx" ON "user_roles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "user_roles_scope_idx" ON "user_roles" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_key" ON "idempotency_keys" USING btree ("org_id","endpoint","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
-- -----------------------------------------------------------------------------
-- Reseller scope resolution (TENANCY.md §4).
--
-- SECURITY DEFINER, and deliberately minimal: it discloses exactly one column of
-- one row so that an organization-scoped policy can answer "is this org under my
-- reseller?" without the policy recursing into `organizations`' own policy.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_org_reseller(target_org uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT o.reseller_id FROM organizations o WHERE o.id = target_org $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_org_reseller(uuid) FROM PUBLIC;
--> statement-breakpoint

-- The single tenant-visibility predicate every org-scoped policy is built from.
CREATE OR REPLACE FUNCTION app_org_in_scope(target_org uuid) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT target_org IS NOT NULL
     AND (
       app_is_platform_admin()
       OR target_org = app_current_org_id()
       OR (
         app_current_reseller_id() IS NOT NULL
         AND app_org_reseller(target_org) = app_current_reseller_id()
       )
     );
$$;
--> statement-breakpoint

-- =============================================================================
-- updated_at maintenance (DATABASE.md §1)
-- =============================================================================
CREATE TRIGGER trg_resellers_updated_at BEFORE UPDATE ON resellers
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_workspaces_updated_at BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_sessions_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_api_keys_updated_at BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_ws_tickets_updated_at BEFORE UPDATE ON ws_tickets
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_permissions_updated_at BEFORE UPDATE ON permissions
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_user_roles_updated_at BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_idempotency_keys_updated_at BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint

-- =============================================================================
-- Scope integrity for role grants (RBAC.md §6, DATABASE.md §2).
--
-- `user_roles.scope_id` is polymorphic, so it cannot carry one physical foreign
-- key. This trigger resolves the row named by (scope_type, scope_id), verifies
-- its ownership chain traces back to the same organization as the role being
-- granted, and DERIVES `org_id` rather than trusting whatever the writer sent.
--
-- It is the hard boundary: it holds for a migration script, an internal admin
-- tool, or a bug in another service, not only for the application service layer
-- that performs the same check earlier for a better error message.
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_validate_user_role_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_role_org_id uuid;
  v_role_key    text;
  v_role_found  boolean;
  v_scope_org   uuid;
BEGIN
  SELECT r.org_id, r.key, true INTO v_role_org_id, v_role_key, v_role_found
  FROM roles r WHERE r.id = NEW.role_id;

  IF NOT coalesce(v_role_found, false) THEN
    RAISE EXCEPTION 'user_roles: role % does not exist', NEW.role_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_role_org_id IS NULL THEN
    -- Platform-level role (RBAC.md §3). Only an existing platform admin may
    -- grant one (RBAC.md §7) — enforced here as well as in the service layer.
    IF NOT app_is_platform_admin() THEN
      RAISE EXCEPTION
        'user_roles: platform-level role % may only be granted by a platform admin', v_role_key
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.scope_type NOT IN ('platform', 'reseller') THEN
      RAISE EXCEPTION
        'user_roles: platform-level role % cannot be granted at scope_type %', v_role_key, NEW.scope_type
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.scope_type = 'reseller'
       AND NOT EXISTS (SELECT 1 FROM resellers rs WHERE rs.id = NEW.scope_id) THEN
      RAISE EXCEPTION 'user_roles: reseller scope % does not exist', NEW.scope_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    NEW.org_id := NULL;
    RETURN NEW;
  END IF;

  -- Tenant-scoped role: resolve the organization that owns the target scope.
  IF NEW.scope_type = 'organization' THEN
    SELECT o.id INTO v_scope_org FROM organizations o WHERE o.id = NEW.scope_id;
  ELSIF NEW.scope_type = 'workspace' THEN
    SELECT w.org_id INTO v_scope_org FROM workspaces w WHERE w.id = NEW.scope_id;
  ELSIF NEW.scope_type = 'team' THEN
    SELECT t.org_id INTO v_scope_org FROM teams t WHERE t.id = NEW.scope_id;
  ELSE
    RAISE EXCEPTION
      'user_roles: tenant role % cannot be granted at scope_type %', v_role_key, NEW.scope_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_scope_org IS NULL THEN
    RAISE EXCEPTION 'user_roles: % scope % does not exist', NEW.scope_type, NEW.scope_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The invalid state this exists to prevent: a role belonging to Organization A
  -- granted at a scope owned by Organization B.
  IF v_scope_org <> v_role_org_id THEN
    RAISE EXCEPTION
      'user_roles: cross-tenant grant refused — role % belongs to organization %, scope % belongs to organization %',
      v_role_key, v_role_org_id, NEW.scope_id, v_scope_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  NEW.org_id := v_scope_org;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_user_roles_validate_scope
  BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION fn_validate_user_role_scope();
--> statement-breakpoint

-- =============================================================================
-- Role/permission integrity.
--
-- Derives `role_permissions.org_id` from the role (so it cannot be forged) and
-- refuses to attach a `platform.*` permission to any tenant role, which would
-- otherwise be a privilege-escalation path through custom role composition
-- (RBAC.md §7).
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_validate_role_permission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_role_org_id  uuid;
  v_role_found   boolean;
  v_permission_key text;
BEGIN
  SELECT r.org_id, true INTO v_role_org_id, v_role_found FROM roles r WHERE r.id = NEW.role_id;
  IF NOT coalesce(v_role_found, false) THEN
    RAISE EXCEPTION 'role_permissions: role % does not exist', NEW.role_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT p.key INTO v_permission_key FROM permissions p WHERE p.id = NEW.permission_id;
  IF v_permission_key IS NULL THEN
    RAISE EXCEPTION 'role_permissions: permission % does not exist', NEW.permission_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_role_org_id IS NOT NULL AND v_permission_key LIKE 'platform.%' THEN
    RAISE EXCEPTION
      'role_permissions: platform permission % cannot be attached to tenant role %',
      v_permission_key, NEW.role_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  NEW.org_id := v_role_org_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_role_permissions_validate
  BEFORE INSERT OR UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION fn_validate_role_permission();
--> statement-breakpoint
-- =============================================================================
-- Row-Level Security (TENANCY.md §3, DATABASE.md §1)
--
-- RLS is defence in depth *under* application-layer filtering, not instead of
-- it. Every policy below resolves tenancy from transaction-local session
-- variables only — never from anything a client can influence.
-- =============================================================================
ALTER TABLE resellers        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE teams            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ws_tickets       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE roles            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE permissions      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_roles       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- --- resellers ---------------------------------------------------------------
CREATE POLICY resellers_select ON resellers FOR SELECT TO acc_app
  USING (
    app_is_platform_admin()
    OR id = app_current_reseller_id()
    OR (app_current_org_id() IS NOT NULL AND id = app_org_reseller(app_current_org_id()))
  );
--> statement-breakpoint
CREATE POLICY resellers_write ON resellers FOR ALL TO acc_app
  USING (app_is_platform_admin() OR id = app_current_reseller_id())
  WITH CHECK (app_is_platform_admin() OR id = app_current_reseller_id());
--> statement-breakpoint
CREATE POLICY resellers_auth_read ON resellers FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint

-- --- organizations -----------------------------------------------------------
CREATE POLICY organizations_select ON organizations FOR SELECT TO acc_app
  USING (app_org_in_scope(id));
--> statement-breakpoint
-- INSERT checks the literal reseller_id on the incoming row rather than
-- re-reading the not-yet-visible organization.
CREATE POLICY organizations_insert ON organizations FOR INSERT TO acc_app
  WITH CHECK (
    app_is_platform_admin()
    OR (app_current_reseller_id() IS NOT NULL AND reseller_id = app_current_reseller_id())
    OR (app_is_provisioning() AND id = app_current_org_id())
  );
--> statement-breakpoint
CREATE POLICY organizations_update ON organizations FOR UPDATE TO acc_app
  USING (app_org_in_scope(id))
  WITH CHECK (app_org_in_scope(id));
--> statement-breakpoint
CREATE POLICY organizations_delete ON organizations FOR DELETE TO acc_app
  USING (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY organizations_auth_read ON organizations FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint

-- --- workspaces / teams / api_keys / ws_tickets / idempotency_keys ------------
-- Uniform org-scoped isolation: the row's own org_id must be in scope, for reads
-- and writes alike, so a write can never place a row in another tenant.
CREATE POLICY workspaces_tenant ON workspaces FOR ALL TO acc_app
  USING (app_org_in_scope(org_id)) WITH CHECK (app_org_in_scope(org_id));
--> statement-breakpoint
CREATE POLICY workspaces_auth_read ON workspaces FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint
CREATE POLICY teams_tenant ON teams FOR ALL TO acc_app
  USING (app_org_in_scope(org_id)) WITH CHECK (app_org_in_scope(org_id));
--> statement-breakpoint
CREATE POLICY teams_auth_read ON teams FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint
CREATE POLICY api_keys_tenant ON api_keys FOR ALL TO acc_app
  USING (app_org_in_scope(org_id)) WITH CHECK (app_org_in_scope(org_id));
--> statement-breakpoint
-- API key presentation happens before any tenant context exists, so lookup and
-- last_used_at bookkeeping run as acc_auth.
CREATE POLICY api_keys_auth ON api_keys FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint
CREATE POLICY api_keys_auth_touch ON api_keys FOR UPDATE TO acc_auth
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY ws_tickets_tenant ON ws_tickets FOR ALL TO acc_app
  USING (app_org_in_scope(org_id)) WITH CHECK (app_org_in_scope(org_id));
--> statement-breakpoint
-- Ticket consumption happens at WebSocket connect, before context is bound.
CREATE POLICY ws_tickets_auth ON ws_tickets FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint
CREATE POLICY ws_tickets_auth_consume ON ws_tickets FOR UPDATE TO acc_auth
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY idempotency_keys_tenant ON idempotency_keys FOR ALL TO acc_app
  USING (app_org_in_scope(org_id)) WITH CHECK (app_org_in_scope(org_id));
--> statement-breakpoint

-- --- users -------------------------------------------------------------------
-- Users are platform-level identities, so their visibility is "self, or someone
-- holding a grant in an organization I can see" rather than a direct org match.
-- The EXISTS runs under user_roles' own policy, so it cannot widen the view.
CREATE POLICY users_select ON users FOR SELECT TO acc_app
  USING (
    app_is_platform_admin()
    OR id = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = users.id AND app_org_in_scope(ur.org_id)
    )
  );
--> statement-breakpoint
-- Creating a user identity requires an established tenant context; which callers
-- may do it is decided by the `users.invite` permission in the service layer.
CREATE POLICY users_insert ON users FOR INSERT TO acc_app
  WITH CHECK (app_is_platform_admin() OR app_current_org_id() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY users_update ON users FOR UPDATE TO acc_app
  USING (
    app_is_platform_admin()
    OR id = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = users.id AND app_org_in_scope(ur.org_id)
    )
  )
  WITH CHECK (
    app_is_platform_admin()
    OR id = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = users.id AND app_org_in_scope(ur.org_id)
    )
  );
--> statement-breakpoint
-- Credential verification precedes tenant context, so it runs as acc_auth.
CREATE POLICY users_auth ON users FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint
CREATE POLICY users_auth_touch ON users FOR UPDATE TO acc_auth
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- --- sessions ----------------------------------------------------------------
CREATE POLICY sessions_self ON sessions FOR ALL TO acc_app
  USING (
    app_is_platform_admin()
    OR user_id = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = sessions.user_id AND app_org_in_scope(ur.org_id)
    )
  )
  WITH CHECK (
    app_is_platform_admin()
    OR user_id = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = sessions.user_id AND app_org_in_scope(ur.org_id)
    )
  );
--> statement-breakpoint
CREATE POLICY sessions_auth ON sessions FOR ALL TO acc_auth USING (true) WITH CHECK (true);
--> statement-breakpoint

-- --- roles / permissions / role_permissions ----------------------------------
-- Platform role definitions are readable (RBAC needs them) but writable only by
-- a platform admin; tenant roles follow ordinary org scoping.
CREATE POLICY roles_select ON roles FOR SELECT TO acc_app
  USING (org_id IS NULL OR app_org_in_scope(org_id));
--> statement-breakpoint
CREATE POLICY roles_write ON roles FOR ALL TO acc_app
  USING (CASE WHEN org_id IS NULL THEN app_is_platform_admin() ELSE app_org_in_scope(org_id) END)
  WITH CHECK (CASE WHEN org_id IS NULL THEN app_is_platform_admin() ELSE app_org_in_scope(org_id) END);
--> statement-breakpoint
CREATE POLICY roles_auth_read ON roles FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint

CREATE POLICY permissions_select ON permissions FOR SELECT TO acc_app USING (true);
--> statement-breakpoint
CREATE POLICY permissions_auth_read ON permissions FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint

CREATE POLICY role_permissions_select ON role_permissions FOR SELECT TO acc_app
  USING (org_id IS NULL OR app_org_in_scope(org_id));
--> statement-breakpoint
CREATE POLICY role_permissions_write ON role_permissions FOR ALL TO acc_app
  USING (CASE WHEN org_id IS NULL THEN app_is_platform_admin() ELSE app_org_in_scope(org_id) END)
  WITH CHECK (CASE WHEN org_id IS NULL THEN app_is_platform_admin() ELSE app_org_in_scope(org_id) END);
--> statement-breakpoint
CREATE POLICY role_permissions_auth_read ON role_permissions FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint

-- --- user_roles --------------------------------------------------------------
-- A grant is visible/writable within its own organization; reseller-scoped
-- grants belong to the reseller context; platform grants to platform admins.
CREATE POLICY user_roles_tenant ON user_roles FOR ALL TO acc_app
  USING (
    app_is_platform_admin()
    OR (org_id IS NOT NULL AND app_org_in_scope(org_id))
    OR (scope_type = 'reseller' AND scope_id = app_current_reseller_id())
  )
  WITH CHECK (
    app_is_platform_admin()
    OR (org_id IS NOT NULL AND app_org_in_scope(org_id))
    OR (scope_type = 'reseller' AND scope_id = app_current_reseller_id())
  );
--> statement-breakpoint
CREATE POLICY user_roles_auth_read ON user_roles FOR SELECT TO acc_auth USING (true);
--> statement-breakpoint

-- =============================================================================
-- Table grants. `acc_app` deliberately has no DELETE on credential or audit-
-- bearing tables: revocation is an UPDATE that leaves the record in place.
-- =============================================================================
GRANT SELECT, INSERT, UPDATE ON
  resellers, organizations, workspaces, teams, users, sessions,
  api_keys, ws_tickets, roles, role_permissions, user_roles, idempotency_keys
  TO acc_app;
--> statement-breakpoint
GRANT DELETE ON teams, roles, role_permissions, user_roles, idempotency_keys TO acc_app;
--> statement-breakpoint
GRANT SELECT ON permissions TO acc_app;
--> statement-breakpoint
GRANT SELECT ON
  users, sessions, api_keys, ws_tickets, roles, permissions, role_permissions,
  user_roles, organizations, workspaces, teams, resellers
  TO acc_auth;
--> statement-breakpoint
GRANT INSERT, UPDATE ON sessions TO acc_auth;
--> statement-breakpoint
GRANT UPDATE ON users, api_keys, ws_tickets TO acc_auth;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app_current_org_id(), app_current_workspace_id(), app_current_reseller_id(),
  app_current_user_id(), app_is_platform_admin(), app_is_provisioning(),
  app_org_in_scope(uuid), app_org_reseller(uuid), uuidv7()
  TO acc_app, acc_auth, acc_relay;
