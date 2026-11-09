-- =============================================================================
-- Phase 7 PR 7-6a — tenant billing reads (DECISIONS.md §1zi.9 D-76-2, D-76-4;
-- docs/PHASE-7-6-BILLING-APIS-HANDOVER.md Rev 2 §4, owner-approved 09-Nov-2026).
--
-- Expand-only. Tenant isolation is enforced here, in the database:
--
--   * acc_app gains SELECT, and nothing else, on wallets, credit_accounts and the
--     usage_ledger parent. No INSERT, UPDATE, DELETE, TRUNCATE or write policy:
--     every write stays with the SECURITY DEFINER ledger writer (app_ledger_post).
--   * Each table gets one SELECT policy for acc_app: the row's organization is the
--     request's (app_current_org_id()) and the tenant content context is valid
--     (app_content_context_valid(): an active organization-level user or an
--     unrevoked API key of that organization — the API layer admits user sessions
--     only, D-76-4).
--   * The ledger policy also admits only the tenant-visible entry types —
--     reservation, reservation_release, customer_charge — so provider_cost (and
--     reseller_markup, should it ever be enabled) is invisible to tenants at the
--     database layer, whatever a query asks for (baseline §7.1).
--   * The monthly partitions get no grant: tenants read through the parent, whose
--     policy applies; a direct partition read is refused (42501), and
--     app_ledger_partition_report still finds every partition privilege-restricted.
--
-- No 7.1–7.5 function, trigger, constraint or writer branch changes; settlement
-- semantics are untouched. Supersedes the "no policy" clause of DP-3 for tenant
-- SELECT only (D-76-2).
-- =============================================================================

GRANT SELECT ON TABLE wallets, credit_accounts, usage_ledger TO acc_app;
--> statement-breakpoint
CREATE POLICY wallets_tenant_select ON wallets FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));
--> statement-breakpoint
CREATE POLICY credit_accounts_tenant_select ON credit_accounts FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));
--> statement-breakpoint
CREATE POLICY usage_ledger_tenant_select ON usage_ledger FOR SELECT TO acc_app
  USING (
    org_id = app_current_org_id()
    AND (SELECT app_content_context_valid())
    AND entry_type IN ('reservation', 'reservation_release', 'customer_charge')
  );
