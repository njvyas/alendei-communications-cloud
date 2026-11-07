-- =============================================================================
-- Migration: 0048_phase5_0_ingress_resolver_facts   (Phase 5.0, PR-C)
--
-- The webhook ingress (PR-C) runs as acc_delivery, which by design (spec Rev 2
-- §C.2a) reads `providers` and `provider_capabilities` only through the definer
-- resolvers. Two facts the ingestion rules need were missing from them:
--
--   1. app_webhook_provider_resolve also returns the provider's `delivery_receipts`
--      capability value (OD-3): which receipt types it declares decides whether a
--      `read` receipt may set read_at (AC-ST-5) and whether a receipt is
--      `unsolicited`. Read from the database at ingestion time — never from the
--      advisory in-memory configuration snapshot.
--   2. app_delivery_resolve also returns the matched attempt's organization
--      status, so a receipt for a CLOSED organization is recorded as informational
--      without changing that organization's rows (implementation plan §4.3 default).
--
-- Both functions change their result type, so they are dropped and recreated in
-- this one transaction, with identical bodies otherwise, identical security
-- (SECURITY DEFINER, fixed search_path) and identical grants (EXECUTE for
-- acc_delivery only, never PUBLIC). No caller exists yet outside tests: the
-- ingress ships disabled. Metadata only; no table is touched.
-- =============================================================================
DROP FUNCTION app_webhook_provider_resolve(bytea);--> statement-breakpoint
CREATE FUNCTION app_webhook_provider_resolve(p_key_hash bytea)
RETURNS TABLE (provider_id uuid, adapter_key text, channel_code text, provider_status text,
               ingress_enabled boolean, delivery_receipts jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.adapter_key, c.code::text, p.status::text, p.webhook_ingress_enabled,
         (SELECT pc.value FROM provider_capabilities pc
           WHERE pc.provider_id = p.id AND pc.capability_key = 'delivery_receipts')
    FROM providers p
    JOIN channels c ON c.id = p.channel_id
   WHERE p_key_hash IS NOT NULL
     AND octet_length(p_key_hash) = 32
     AND (p.webhook_ingress_key_hash = p_key_hash
          OR (p.webhook_ingress_key_previous_hash = p_key_hash
              AND p.webhook_ingress_key_previous_expires_at > now()))
   LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_webhook_provider_resolve(bytea) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_webhook_provider_resolve(bytea) TO acc_delivery;--> statement-breakpoint

DROP FUNCTION app_delivery_resolve(uuid, text, uuid);--> statement-breakpoint
CREATE FUNCTION app_delivery_resolve(p_provider_id uuid, p_provider_message_id text, p_client_reference uuid)
RETURNS TABLE (attempt_id uuid, message_id uuid, org_id uuid, attempt_status text, org_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.message_id, a.org_id, a.status::text, o.status::text
    FROM message_attempts a
    JOIN organizations o ON o.id = a.org_id
   WHERE p_provider_id IS NOT NULL
     AND a.provider_id = p_provider_id
     AND (
       (p_provider_message_id IS NOT NULL AND a.provider_message_id = p_provider_message_id)
       OR (p_provider_message_id IS NULL AND p_client_reference IS NOT NULL AND a.id = p_client_reference)
       OR (p_provider_message_id IS NOT NULL AND p_client_reference IS NOT NULL
           AND a.id = p_client_reference AND a.provider_message_id IS NULL)
     )
   ORDER BY (a.provider_message_id = p_provider_message_id) DESC NULLS LAST
   LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_delivery_resolve(uuid, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_delivery_resolve(uuid, text, uuid) TO acc_delivery;
