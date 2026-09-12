-- =============================================================================
-- Phase 1B — immutable audit log (ADR-002)
--
-- As with 0000, this single change set creates the table AND its Row-Level
-- Security policies, scope-integrity trigger, append-only enforcement and role
-- grants. RLS is never added in a later migration than the table it protects
-- (TENANCY.md §3, DATABASE.md §1).
--
-- `api_keys` gains a composite unique key first, because the audit table's
-- cross-tenant actor foreign key references it.
-- =============================================================================

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_id_org_id_key" UNIQUE("id","org_id");--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'api_key', 'oauth_client', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'failure', 'denied');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scope_type" "role_scope_type" NOT NULL,
	"scope_id" uuid,
	"reseller_id" uuid,
	"org_id" uuid,
	"workspace_id" uuid,
	"team_id" uuid,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"actor_api_key_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"outcome" "audit_outcome" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"ip" "inet",
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_scope_shape" CHECK (("audit_logs"."scope_type" = 'platform' AND "audit_logs"."scope_id" IS NULL AND "audit_logs"."reseller_id" IS NULL AND "audit_logs"."org_id" IS NULL AND "audit_logs"."workspace_id" IS NULL AND "audit_logs"."team_id" IS NULL)
       OR ("audit_logs"."scope_type" = 'reseller' AND "audit_logs"."scope_id" IS NOT NULL AND "audit_logs"."reseller_id" = "audit_logs"."scope_id" AND "audit_logs"."org_id" IS NULL AND "audit_logs"."workspace_id" IS NULL AND "audit_logs"."team_id" IS NULL)
       OR ("audit_logs"."scope_type" = 'organization' AND "audit_logs"."scope_id" IS NOT NULL AND "audit_logs"."reseller_id" IS NULL AND "audit_logs"."org_id" = "audit_logs"."scope_id" AND "audit_logs"."workspace_id" IS NULL AND "audit_logs"."team_id" IS NULL)
       OR ("audit_logs"."scope_type" = 'workspace' AND "audit_logs"."scope_id" IS NOT NULL AND "audit_logs"."reseller_id" IS NULL AND "audit_logs"."org_id" IS NOT NULL AND "audit_logs"."workspace_id" = "audit_logs"."scope_id" AND "audit_logs"."team_id" IS NULL)
       OR ("audit_logs"."scope_type" = 'team' AND "audit_logs"."scope_id" IS NOT NULL AND "audit_logs"."reseller_id" IS NULL AND "audit_logs"."org_id" IS NOT NULL AND "audit_logs"."workspace_id" IS NOT NULL AND "audit_logs"."team_id" = "audit_logs"."scope_id")),
	CONSTRAINT "audit_logs_actor_shape" CHECK (("audit_logs"."actor_type" = 'user' AND "audit_logs"."actor_user_id" IS NOT NULL AND "audit_logs"."actor_api_key_id" IS NULL)
       OR ("audit_logs"."actor_type" = 'api_key' AND "audit_logs"."actor_api_key_id" IS NOT NULL AND "audit_logs"."actor_user_id" IS NULL)
       OR ("audit_logs"."actor_type" = 'oauth_client' AND "audit_logs"."actor_user_id" IS NULL AND "audit_logs"."actor_api_key_id" IS NULL AND "audit_logs"."actor_label" IS NOT NULL)
       OR ("audit_logs"."actor_type" = 'system' AND "audit_logs"."actor_user_id" IS NULL AND "audit_logs"."actor_api_key_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_org_fk" FOREIGN KEY ("workspace_id","org_id") REFERENCES "public"."workspaces"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_team_org_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "public"."teams"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_api_key_org_fk" FOREIGN KEY ("actor_api_key_id","org_id") REFERENCES "public"."api_keys"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_api_key_id_fk" FOREIGN KEY ("actor_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_occurred_idx" ON "audit_logs" USING btree ("org_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_scope_idx" ON "audit_logs" USING btree ("scope_type","scope_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_correlation_idx" ON "audit_logs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "audit_logs_causation_idx" ON "audit_logs" USING btree ("causation_id") WHERE "audit_logs"."causation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_logs_reseller_idx" ON "audit_logs" USING btree ("reseller_id","occurred_at" DESC NULLS LAST) WHERE "audit_logs"."reseller_id" IS NOT NULL;--> statement-breakpoint

-- =============================================================================
-- Scope integrity (TENANCY.md §1a.3, ADR-002).
--
-- The writer supplies only (scope_type, scope_id). This trigger resolves the row
-- that pair names, walks its ownership chain, and DERIVES reseller_id, org_id,
-- workspace_id and team_id — it never trusts them from the writer. That ordering
-- matters: PostgreSQL evaluates a BEFORE ROW trigger before the RLS WITH CHECK
-- expression, so the tenancy the policy authorises is the derived tenancy, not
-- anything the caller sent.
--
-- Same shape and same reasoning as fn_validate_user_role_scope (RBAC.md §6): a
-- hard boundary that holds for a migration script or an internal tool, not only
-- for the service layer that performs the same check earlier for a better error.
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_validate_audit_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_org       uuid;
  v_workspace uuid;
BEGIN
  IF NEW.scope_type = 'platform' THEN
    IF NEW.scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'audit_logs: platform scope carries no scope_id'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.reseller_id  := NULL;
    NEW.org_id       := NULL;
    NEW.workspace_id := NULL;
    NEW.team_id      := NULL;
    RETURN NEW;
  END IF;

  IF NEW.scope_id IS NULL THEN
    RAISE EXCEPTION 'audit_logs: scope_type % requires a scope_id', NEW.scope_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.scope_type = 'reseller' THEN
    IF NOT EXISTS (SELECT 1 FROM resellers rs WHERE rs.id = NEW.scope_id) THEN
      RAISE EXCEPTION 'audit_logs: reseller scope % does not exist', NEW.scope_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.reseller_id  := NEW.scope_id;
    NEW.org_id       := NULL;
    NEW.workspace_id := NULL;
    NEW.team_id      := NULL;
    RETURN NEW;
  END IF;

  IF NEW.scope_type = 'organization' THEN
    SELECT o.id INTO v_org FROM organizations o WHERE o.id = NEW.scope_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'audit_logs: organization scope % does not exist', NEW.scope_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.reseller_id  := NULL;
    NEW.org_id       := v_org;
    NEW.workspace_id := NULL;
    NEW.team_id      := NULL;
    RETURN NEW;
  END IF;

  IF NEW.scope_type = 'workspace' THEN
    SELECT w.org_id INTO v_org FROM workspaces w WHERE w.id = NEW.scope_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'audit_logs: workspace scope % does not exist', NEW.scope_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.reseller_id  := NULL;
    NEW.org_id       := v_org;
    NEW.workspace_id := NEW.scope_id;
    NEW.team_id      := NULL;
    RETURN NEW;
  END IF;

  IF NEW.scope_type = 'team' THEN
    SELECT t.org_id, t.workspace_id INTO v_org, v_workspace
    FROM teams t WHERE t.id = NEW.scope_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'audit_logs: team scope % does not exist', NEW.scope_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.reseller_id  := NULL;
    NEW.org_id       := v_org;
    NEW.workspace_id := v_workspace;
    NEW.team_id      := NEW.scope_id;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_logs: unhandled scope_type %', NEW.scope_type
    USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_audit_logs_validate_scope
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION fn_validate_audit_scope();
--> statement-breakpoint

-- =============================================================================
-- Append-only enforcement (DATABASE.md §1, SECURITY.md §4a).
--
-- Three layers, each doing something the others cannot:
--
--   1. Grants      — no principal the application connects as holds UPDATE,
--                    DELETE or TRUNCATE. This is the primary control.
--   2. No policy   — even were a grant added by mistake, no UPDATE or DELETE
--                    policy exists, so RLS would still admit no rows.
--   3. Trigger     — refuses UPDATE, DELETE and TRUNCATE for every principal,
--                    including the schema owner, so a migration script or an
--                    admin tool cannot quietly rewrite history either.
--
-- What this deliberately does NOT claim: tamper-proofing against the table
-- owner or a superuser. Either can DROP or DISABLE the trigger and then mutate
-- rows. That capability is real, is the mechanism retention/archival and test
-- teardown legitimately use, and is why genuine tamper-EVIDENCE lives outside
-- this database — the SIEM export in EVENTS.md §4 (alendei.audit.action_recorded.v1).
-- SECURITY.md §4a states the threat model in full.
--
-- The TRUNCATE guard must be attached to every partition individually if this
-- table is ever partitioned (ADR-002): a TRUNCATE trigger on a partitioned
-- parent does NOT fire when a partition is truncated directly.
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted (record a new row instead)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION fn_audit_logs_append_only();
--> statement-breakpoint

CREATE TRIGGER trg_audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION fn_audit_logs_append_only();
--> statement-breakpoint

-- =============================================================================
-- The action vocabulary acc_auth is confined to (ADR-002).
--
-- These are exactly the events that occur before a tenant context exists, so
-- they cannot be bounded by org_id and are bounded by vocabulary instead. The
-- list mirrors AUTH_ROLE_AUDIT_ACTIONS in packages/contracts/src/audit.ts, and
-- audit.int-spec.ts fails if the two ever drift apart.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_is_auth_audit_action(target_action text) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT target_action IN (
    'auth.login.succeeded',
    'auth.login.failed',
    'auth.logout',
    'auth.token.refreshed',
    'api_key.authenticated'
  );
$$;
--> statement-breakpoint

-- =============================================================================
-- Row-Level Security (TENANCY.md §3a)
-- =============================================================================
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A tenant reads its own audit trail. Reseller-scoped rows belong to the
-- reseller context; platform-scoped rows (org_id IS NULL, reseller_id IS NULL)
-- are visible only to platform admins. Mirrors user_roles_tenant.
CREATE POLICY audit_logs_select ON audit_logs FOR SELECT TO acc_app
  USING (
    app_is_platform_admin()
    OR (org_id IS NOT NULL AND app_org_in_scope(org_id))
    OR (scope_type = 'reseller' AND reseller_id = app_current_reseller_id())
  );
--> statement-breakpoint

-- A writer may only record an event against a tenant it is already acting in.
-- org_id/reseller_id here are the values fn_validate_audit_scope derived, not
-- anything the caller supplied, so this authorises the resolved scope.
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT TO acc_app
  WITH CHECK (
    app_is_platform_admin()
    OR (org_id IS NOT NULL AND app_org_in_scope(org_id))
    OR (scope_type = 'reseller' AND reseller_id = app_current_reseller_id())
  );
--> statement-breakpoint

-- The identity role writes authentication outcomes — including failed logins,
-- which by definition occur before any tenant context exists. It is confined to
-- platform scope (so it can never name an organization), to the two actor types
-- that can actually present a credential, and to the auth action vocabulary.
CREATE POLICY audit_logs_auth_insert ON audit_logs FOR INSERT TO acc_auth
  WITH CHECK (
    scope_type = 'platform'
    AND actor_type IN ('user', 'api_key')
    AND app_is_auth_audit_action(action)
  );
--> statement-breakpoint

-- =============================================================================
-- Grants. No principal receives UPDATE, DELETE or TRUNCATE on audit_logs —
-- that absence is the primary append-only control, not the trigger.
-- =============================================================================
GRANT SELECT, INSERT ON audit_logs TO acc_app;
--> statement-breakpoint
GRANT INSERT ON audit_logs TO acc_auth;
--> statement-breakpoint
-- The outbox relay projects every audit insert to the SIEM export event
-- (EVENTS.md §4); it reads cross-tenant by necessity and writes nothing.
GRANT SELECT ON audit_logs TO acc_relay;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_is_auth_audit_action(text) TO acc_app, acc_auth, acc_relay;
