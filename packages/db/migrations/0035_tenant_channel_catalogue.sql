-- =============================================================================
-- ACC Batch 2 — tenant read of the channel catalogue (owner-approved
-- 21-Oct-2026 as a narrow exception to the 0035+ sequencing hold; it advances
-- no other schema work).
--
-- `channels` RLS (0018 channels_platform_read) admits only platform-scope
-- principals, so a tenant operator holding suppressions.read, contacts.read,
-- templates.read or messages.read at its organization cannot read the
-- immutable catalogue its own content refers to by channel id.
--
-- This adds ONE read-only helper, in the shape of app_channel_code() (0031) and
-- app_channel_resolve() (0033):
--
--   app_channel_catalogue() → (id, code, display_name, status, created_at, updated_at)
--
--   * STABLE SECURITY DEFINER, search_path pinned to public, pg_temp, owned by
--     the migration principal (the tables' owner) like every helper before it.
--   * Returns exactly the six catalogue columns, named, in the table's own
--     types (code and status stay the channel_code / channel_status enums),
--     so ordering and keyset cursors are identical to the platform path's
--     table read. No provider, provider capability, assignment, health or
--     circuit data is reachable through it, and the catalogue holds no
--     credential (0018, ADR-013 F-2).
--   * Takes no argument, so it cannot be steered into any other relation.
--   * EXECUTE: acc_app only. Revoked from PUBLIC; acc_auth, acc_relay and
--     acc_dispatch receive nothing (acc_dispatch already reads channels via
--     0032 channels_dispatch_select).
--
-- What it does NOT change: channels_platform_read is untouched, so a direct
-- SELECT on channels by a tenant acc_app session still sees no row; the
-- table grants are untouched (still SELECT-only for acc_app, no write path);
-- providers and provider_capabilities RLS are untouched.
--
-- Authorization stays in the application (ADR-005 D-5): the API calls this
-- only after AuthorizationService has asserted one of the four tenant-content
-- read permissions at the request's resolved, active organization, inside the
-- same request transaction. Platform callers keep the 0018 path
-- (providers.read at platform scope, direct table read under RLS).
-- =============================================================================

CREATE OR REPLACE FUNCTION app_channel_catalogue()
RETURNS TABLE (
  id uuid,
  code channel_code,
  display_name text,
  status channel_status,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.code, c.display_name, c.status, c.created_at, c.updated_at
  FROM channels c;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_catalogue() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_catalogue() TO acc_app;
