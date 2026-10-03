-- =============================================================================
-- Phase 2.1 — channel and provider registry (ADR-013, ROADMAP §5b 2.1)
--
-- A global catalogue, not tenant data: `channels`, `providers` and
-- `provider_capabilities` carry no `org_id`, `reseller_id` or `workspace_id`.
-- Tenant RLS, which filters by the request's tenant context, has nothing to
-- filter on, so it is not used. The security model is layered and no layer
-- names a role (ADR-013 F-3):
--
--   authenticated principal                      (AuthGuard)
--   -> validated providers.* permission          (AuthorizationService.assert)
--   -> platform-scope target                     ({ scopeType: 'platform' })
--   -> RLS platform-scope eligibility            (app_has_platform_scope(), below)
--
-- RLS enforces *eligibility* — the transaction's user holds an active
-- platform-scope grant — and AuthorizationService enforces the *permission*.
-- `app_is_platform_admin()` is deliberately not used here: it is bound to the
-- role key `alendei_super_admin` (migration `0010`), and adopting it would make
-- a role name the boundary. A future privileged platform role therefore needs
-- an RBAC change only, never a policy change.
--
-- What is deliberately NOT here: `provider_credentials` or any credential
-- column (ADR-013 PD-2), health samples (2.3), any DELETE grant on `providers`
-- (no provider deletion), and any grant to `acc_auth` or `acc_relay`.
-- =============================================================================

CREATE TYPE "public"."channel_code" AS ENUM('whatsapp', 'rcs', 'sms', 'email', 'voice');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."provider_circuit_state" AS ENUM('closed', 'open', 'half_open');--> statement-breakpoint
CREATE TYPE "public"."provider_health_state" AS ENUM('healthy', 'degraded', 'critical', 'offline');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('active', 'disabled', 'draining');--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" "channel_code" NOT NULL,
	"display_name" text NOT NULL,
	"status" "channel_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider_id" uuid NOT NULL,
	"capability_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_capabilities_key_format" CHECK ("provider_capabilities"."capability_key" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "provider_capabilities_value_size" CHECK (octet_length("provider_capabilities"."value"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"adapter_key" text NOT NULL,
	"status" "provider_status" DEFAULT 'disabled' NOT NULL,
	"health_state" "provider_health_state" DEFAULT 'healthy' NOT NULL,
	"circuit_state" "provider_circuit_state" DEFAULT 'closed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_name_length" CHECK (char_length("providers"."name") BETWEEN 1 AND 200 AND "providers"."name" = btrim("providers"."name")),
	CONSTRAINT "providers_adapter_key_format" CHECK ("providers"."adapter_key" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "provider_capabilities" ADD CONSTRAINT "provider_capabilities_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_code_key" ON "channels" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_capabilities_provider_key_key" ON "provider_capabilities" USING btree ("provider_id","capability_key");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_channel_name_key" ON "providers" USING btree ("channel_id",lower("name"));--> statement-breakpoint
CREATE INDEX "providers_status_idx" ON "providers" USING btree ("status");
--> statement-breakpoint

-- --- updated_at maintenance (DATABASE.md §1) ----------------------------------
CREATE TRIGGER trg_channels_updated_at BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_providers_updated_at BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_provider_capabilities_updated_at BEFORE UPDATE ON provider_capabilities
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint

-- --- Platform-scope eligibility (ADR-013 F-3) -----------------------------------
-- True when the transaction's user (`app.current_user_id`, set from the
-- authenticated principal) is active and holds at least one platform-scope
-- grant, validated against current grants — the same validated-claim discipline
-- as ADR-011, with no role key and no permission named. An API-key principal
-- has no user id and is never eligible. The owner/maintenance session keeps its
-- documented bypass (`app_session_bypasses_rls()`).
CREATE FUNCTION app_has_platform_scope() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := nullif(current_setting('app.current_user_id', true), '')::uuid;
  IF v_user IS NOT NULL AND EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = ur.user_id
    WHERE ur.user_id = v_user
      AND ur.scope_type = 'platform'
      AND r.org_id IS NULL
      AND u.status = 'active'
  ) THEN
    RETURN true;
  END IF;

  RETURN app_session_bypasses_rls();
END;
$$;
--> statement-breakpoint
-- Only the principal whose policies call it may execute it: it answers "does
-- this user hold a platform grant", which nothing else needs to ask.
REVOKE ALL ON FUNCTION app_has_platform_scope() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_has_platform_scope() TO acc_app;
--> statement-breakpoint

-- --- RLS: enabled (not forced, like every table — the owner is exempt) ------
ALTER TABLE channels              ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE providers             ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE provider_capabilities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY channels_platform_read ON channels FOR SELECT TO acc_app
  USING (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY providers_platform ON providers FOR ALL TO acc_app
  USING (app_has_platform_scope())
  WITH CHECK (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY provider_capabilities_platform ON provider_capabilities FOR ALL TO acc_app
  USING (app_has_platform_scope())
  WITH CHECK (app_has_platform_scope());
--> statement-breakpoint

-- --- Grants: acc_app only; nothing to acc_auth or acc_relay ----------------------
-- `channels` is read-only (seeded below; changed by migration only). `providers`
-- has no DELETE: providers are disabled, never deleted. `provider_capabilities`
-- has DELETE because the capability set is replaced as a whole.
GRANT SELECT ON channels TO acc_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON providers TO acc_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_capabilities TO acc_app;
--> statement-breakpoint

-- --- The seeded channel catalogue (ADR-013 F-2) ----------------------------------
INSERT INTO channels (code, display_name) VALUES
  ('whatsapp', 'WhatsApp'),
  ('rcs', 'RCS'),
  ('sms', 'SMS'),
  ('email', 'Email'),
  ('voice', 'Voice')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- --- The providers.* permissions (ADR-013 F-4) -----------------------------------
-- Seeded here so an upgrade is complete on its own; `seed.ts` upserts the same
-- rows from `ALL_PERMISSION_KEYS`, so either order is safe.
INSERT INTO permissions (key, domain, action, description) VALUES
  ('providers.read', 'providers', 'read', 'Read the channel and provider catalogue'),
  ('providers.manage', 'providers', 'manage', 'Create, update and change the status of providers'),
  ('providers.test_send', 'providers', 'test_send', 'Send a synthetic test message to one provider')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- Attached to `alendei_super_admin` only — today's grant, not the boundary: the
-- role is defined as the whole catalogue, so a new permission belongs to it by
-- construction. No other role, and no support role, receives them. The system
-- role guard (`0004`) admits this in a provisioning transaction, declared
-- exactly as `0008` and `seed.ts` do.
SELECT set_config('app.provisioning', 'on', true);
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key = 'alendei_super_admin'
  AND p.key IN ('providers.read', 'providers.manage', 'providers.test_send')
ON CONFLICT DO NOTHING;
