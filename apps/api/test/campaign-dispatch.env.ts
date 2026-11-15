/**
 * Imported first by `campaigns-dispatch.int-spec.ts` (Phase 8B PR 8B-3b). Configuration is
 * validated once, when the application module is loaded, so these must be set before anything
 * imports it; `setup-env.ts` leaves campaign dispatch and billing enforcement OFF for every other
 * suite.
 *
 * - `CAMPAIGN_DISPATCH_ENABLED` is admitted only because the integration setup runs with
 *   `NODE_ENV=test` and `APP_ENV=test`, and only together with billing enforcement
 *   (`campaignDispatchProblems`, owner decision OD-8B3-4).
 * - `acc_campaign` is NOLOGIN. On the disposable clone the executor URL is the clone owner's,
 *   with the session role set to `acc_campaign` at connection start, so the application's own
 *   principal check (`assertRlsBoundPrincipal`: current_user, not superuser, no BYPASSRLS, owns
 *   nothing, member of nothing) runs against `acc_campaign` exactly as it would in production.
 * - The poll interval is the maximum; the suite stops the worker before its first cycle and
 *   drives the executor explicitly.
 */
process.env.BILLING_ENFORCEMENT_ENABLED = 'true';
process.env.CAMPAIGN_DISPATCH_ENABLED = 'true';
process.env.CAMPAIGN_DISPATCH_POLL_INTERVAL_MS = '60000';
{
  const admin = process.env.DATABASE_ADMIN_URL;
  if (!admin) throw new Error('campaign-dispatch.env: DATABASE_ADMIN_URL is required');
  const executor = new URL(admin);
  executor.searchParams.set('options', '-c role=acc_campaign');
  process.env.DATABASE_CAMPAIGN_URL = executor.toString();
}
