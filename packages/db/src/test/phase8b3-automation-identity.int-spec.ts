/**
 * Phase 8B PR 8B-3a (migration 0068), pinned in the catalog: the shared automation identity, the
 * campaign executor principal `acc_campaign`, the claim protocol, campaign attribution, and the
 * reservation admission. Behaviour is proven in apps/api/test/automation-identity.int-spec.ts;
 * K1 and its barrier in phase8b3-index.int-spec.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const ROOT = resolve(__dirname, '../../../..');

describe('Phase 8B PR 8B-3a: automation identity and campaign attribution (migration 0068)', () => {
  let pool: Pool;
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('acc_campaign is an ordinary NOLOGIN principal: no superuser, no BYPASSRLS, no membership', async () => {
    expect(
      await q(
        `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
                (SELECT count(*)::int FROM pg_auth_members am WHERE am.member = r.oid OR am.roleid = r.oid) AS memberships
           FROM pg_roles r WHERE rolname = 'acc_campaign'`,
      ),
    ).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        memberships: 0,
      },
    ]);
  });

  it('acc_campaign holds exactly the executor and core-footprint privileges, and no update, delete or billing privilege', async () => {
    const table = await q(
      `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
         FROM information_schema.role_table_grants WHERE grantee = 'acc_campaign' AND table_schema = 'public'
        GROUP BY table_name ORDER BY table_name`,
    );
    expect(Object.fromEntries(table.map((r) => [r.table_name, r.privs]))).toEqual({
      audit_logs: 'INSERT',
      campaign_dispatch: 'DELETE,SELECT',
      campaign_recipients: 'SELECT',
      campaigns: 'SELECT',
      consent_events: 'SELECT',
      contact_identities: 'SELECT',
      contacts: 'SELECT',
      message_dispatch_queue: 'INSERT',
      message_events: 'INSERT',
      messages: 'INSERT,SELECT',
      organization_provider_assignments: 'SELECT',
      organizations: 'SELECT',
      suppressions: 'SELECT',
      templates: 'SELECT',
      workspaces: 'SELECT',
    });
    const columns = await q(
      `SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS cols
         FROM information_schema.column_privileges
        WHERE grantee = 'acc_campaign' AND table_schema = 'public' AND privilege_type = 'UPDATE'
        GROUP BY table_name ORDER BY table_name`,
    );
    expect(Object.fromEntries(columns.map((r) => [r.table_name, r.cols]))).toEqual({
      campaign_dispatch:
        'attempts,available_at,claim_token,claimed_by,claimed_until,last_error_code,next_slot_at',
      campaign_recipients: 'attempts,error_code,message_id,skip_reason,status,updated_at',
      campaigns: 'completed_at,metrics,pause_reason,status,updated_at',
    });
    const [none] = await q(
      `SELECT bool_or(has_table_privilege('acc_campaign', t, p)) AS any
         FROM unnest(ARRAY['public.messages', 'public.message_dispatch_queue', 'public.message_events',
                           'public.message_attempts', 'public.usage_ledger', 'public.wallets',
                           'public.credit_accounts', 'public.api_keys', 'public.automation_capabilities',
                           'public.automation_controls', 'public.journey_executions']) t,
              unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) p`,
    );
    expect(none).toEqual({ any: false });
  });

  it('every acc_campaign policy is bound to the claimed campaign; the core-footprint ones also to a valid capability', async () => {
    const policies = await q(
      `SELECT tablename, policyname, cmd, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expr
         FROM pg_policies WHERE 'acc_campaign' = ANY(roles) ORDER BY tablename, policyname`,
    );
    expect(policies.map((p) => `${p.tablename}.${p.policyname}:${p.cmd}`)).toEqual([
      'audit_logs.audit_logs_campaign_executor_insert:INSERT',
      'campaign_dispatch.campaign_dispatch_executor_delete:DELETE',
      'campaign_dispatch.campaign_dispatch_executor_select:SELECT',
      'campaign_dispatch.campaign_dispatch_executor_update:UPDATE',
      'campaign_recipients.campaign_recipients_executor_select:SELECT',
      'campaign_recipients.campaign_recipients_executor_update:UPDATE',
      'campaigns.campaigns_executor_select:SELECT',
      'campaigns.campaigns_executor_update:UPDATE',
      'consent_events.consent_events_executor_select:SELECT',
      'contact_identities.contact_identities_executor_select:SELECT',
      'contacts.contacts_executor_select:SELECT',
      'message_dispatch_queue.message_dispatch_queue_executor_insert:INSERT',
      'message_events.message_events_executor_insert:INSERT',
      'messages.messages_executor_insert:INSERT',
      'messages.messages_executor_select:SELECT',
      'organization_provider_assignments.organization_provider_assignments_executor_select:SELECT',
      'organizations.organizations_executor_select:SELECT',
      'suppressions.suppressions_executor_select:SELECT',
      'templates.templates_executor_select:SELECT',
      'workspaces.workspaces_executor_select:SELECT',
    ]);
    const gated = new Set([
      'consent_events',
      'contact_identities',
      'contacts',
      'message_dispatch_queue',
      'message_events',
      'messages',
      'organization_provider_assignments',
      'organizations',
      'suppressions',
      'templates',
      'workspaces',
    ]);
    for (const p of policies) {
      expect([p.policyname, /app_current_org_id\(\)/.test(p.expr)]).toEqual([p.policyname, true]);
      expect([
        p.policyname,
        // The dispatch row's SELECT names the session's campaign only (content-free; a release
        // clears the token, and PostgreSQL checks the updated row against SELECT policies too) —
        // the journey queue's 0064 pattern. Its UPDATE and DELETE require the live claim.
        /app_campaign_claim_valid\(\)|app_campaign_claim_token\(\)|app_campaign_session_recipient\(\)|app_campaign_claimed\(\)|app_automation_capability_valid\(\)|campaign_id = app_campaign_id\(\)/.test(
          p.expr,
        ),
      ]).toEqual([p.policyname, true]);
      expect([p.policyname, /app_automation_capability_valid\(\)/.test(p.expr)]).toEqual([
        p.policyname,
        gated.has(p.tablename),
      ]);
      expect(p.expr).not.toMatch(/\btrue\b/i);
    }
  });

  it("the capability-gated policies cover exactly the shared core's table footprint (drift fails closed)", async () => {
    const core = readFileSync(
      resolve(ROOT, 'apps/api/src/messages/submission/message-submission.core.ts'),
      'utf8',
    );
    const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const footprint = new Set([...core.matchAll(/schema\.(\w+)/g)].map((m) => snake(m[1]!)));
    const gated = await q(
      `SELECT DISTINCT tablename FROM pg_policies
        WHERE 'acc_campaign' = ANY(roles)
          AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%app_automation_capability_valid()%'
        ORDER BY 1`,
    );
    expect(new Set(gated.map((r) => r.tablename))).toEqual(footprint);
    const fns = new Set([...core.matchAll(/\b(app_\w+)\(/g)].map((m) => m[1]!));
    for (const fn of fns) {
      const [row] = await q(
        `SELECT bool_or(has_function_privilege('acc_campaign', p.oid, 'EXECUTE')) AS can FROM pg_proc p WHERE p.proname = $1`,
        [fn],
      );
      expect([fn, row.can]).toEqual([fn, true]);
    }
  });

  it('the identity functions are definers with a pinned search path, executable only by their intended principal', async () => {
    const rows = await q(
      `SELECT p.proname, p.prosecdef, p.proconfig,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public,
              has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('acc_campaign', p.oid, 'EXECUTE') AS campaign,
              has_function_privilege('acc_journey', p.oid, 'EXECUTE') AS journey,
              has_function_privilege('acc_dispatch', p.oid, 'EXECUTE') AS dispatch
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('app_automation_capability_mint', 'app_automation_capability_valid',
                            'app_automation_purge_capabilities', 'app_campaign_claim', 'app_campaign_claim_valid',
                            'app_campaign_claimed', 'app_campaign_session_recipient',
                            'app_automation_org_authority', 'app_automation_control',
                            'app_automation_control_status', 'app_automation_apply_control')
        ORDER BY 1`,
    );
    const who = (r: Record<string, boolean>) =>
      ['public', 'app', 'campaign', 'journey', 'dispatch'].filter((k) => r[k]).join(',') || 'none';
    expect(
      Object.fromEntries(
        rows.map((r) => [r.proname, `${r.prosecdef}|${r.proconfig?.join(';')}|${who(r)}`]),
      ),
    ).toEqual({
      app_automation_apply_control: 'true|search_path=pg_catalog, public|none',
      app_automation_capability_mint: 'true|search_path=pg_catalog, public|campaign',
      app_automation_capability_valid: 'true|search_path=pg_catalog, public|campaign',
      app_automation_control: 'true|search_path=pg_catalog, public|app',
      app_automation_control_status: 'true|search_path=pg_catalog, public|app',
      app_automation_org_authority: 'true|search_path=pg_catalog, public|app',
      app_automation_purge_capabilities: 'true|search_path=pg_catalog, public|campaign',
      app_campaign_claim: 'true|search_path=pg_catalog, public|campaign',
      app_campaign_claim_valid: 'true|search_path=pg_catalog, public|campaign',
      app_campaign_claimed: 'true|search_path=pg_catalog, public|campaign',
      app_campaign_session_recipient: 'true|search_path=pg_catalog, public|campaign',
    });
    const [reserve] = await q(
      `SELECT has_function_privilege('acc_app', 'public.app_message_reserve(uuid)', 'EXECUTE') AS app,
              has_function_privilege('acc_campaign', 'public.app_message_reserve(uuid)', 'EXECUTE') AS campaign,
              has_function_privilege('acc_journey', 'public.app_message_reserve(uuid)', 'EXECUTE') AS journey,
              has_function_privilege('public', 'public.app_message_reserve(uuid)', 'EXECUTE') AS public`,
    );
    expect(reserve).toEqual({ app: true, campaign: true, journey: false, public: false });
  });

  it('the automation tables are definer-only: RLS on, no policy, no grant to any application role', async () => {
    const rows = await q(
      `SELECT c.relname, c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies,
              (SELECT count(*)::int FROM information_schema.role_table_grants g
                WHERE g.table_name = c.relname AND g.grantee LIKE 'acc\\_%') AS grants
         FROM pg_class c WHERE c.relname IN ('automation_capabilities', 'automation_controls') ORDER BY 1`,
    );
    expect(rows).toEqual([
      { relname: 'automation_capabilities', rls: true, policies: 0, grants: 0 },
      { relname: 'automation_controls', rls: true, policies: 0, grants: 0 },
    ]);
  });

  it('defines the attribution and uniqueness constraints exactly; every one is validated; none NOT VALID anywhere', async () => {
    const rows = await q(
      `SELECT conrelid::regclass::text AS tbl, conname, convalidated, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conname IN ('messages_campaign_shape', 'messages_single_origin', 'messages_campaign_recipient_fk',
                          'uq_campaign_recipients_attribution', 'campaign_recipients_sent_shape',
                          'campaigns_pause_reason_shape', 'campaign_dispatch_campaign_org_fk')
        ORDER BY conname`,
    );
    expect(rows).toEqual([
      {
        tbl: 'campaign_dispatch',
        conname: 'campaign_dispatch_campaign_org_fk',
        convalidated: true,
        def: 'FOREIGN KEY (campaign_id, org_id) REFERENCES campaigns(id, org_id) ON DELETE RESTRICT',
      },
      {
        tbl: 'campaign_recipients',
        conname: 'campaign_recipients_sent_shape',
        convalidated: true,
        def: "CHECK (((status = 'sent'::campaign_recipient_status) = (message_id IS NOT NULL)))",
      },
      {
        tbl: 'campaigns',
        conname: 'campaigns_pause_reason_shape',
        convalidated: true,
        def: "CHECK (((pause_reason IS NULL) OR (status = 'paused'::campaign_status)))",
      },
      {
        tbl: 'messages',
        conname: 'messages_campaign_recipient_fk',
        convalidated: true,
        def: 'FOREIGN KEY (campaign_recipient_id, campaign_id, contact_id, workspace_id, org_id) REFERENCES campaign_recipients(id, campaign_id, contact_id, workspace_id, org_id) ON DELETE RESTRICT',
      },
      {
        tbl: 'messages',
        conname: 'messages_campaign_shape',
        convalidated: true,
        def: 'CHECK (((campaign_id IS NULL) = (campaign_recipient_id IS NULL)))',
      },
      {
        tbl: 'messages',
        conname: 'messages_single_origin',
        convalidated: true,
        def: 'CHECK (((journey_execution_id IS NULL) OR (campaign_recipient_id IS NULL)))',
      },
      {
        tbl: 'campaign_recipients',
        conname: 'uq_campaign_recipients_attribution',
        convalidated: true,
        def: 'UNIQUE (id, campaign_id, contact_id, workspace_id, org_id)',
      },
    ]);
    expect(
      await q(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname IN ('uq_campaign_recipients_message', 'campaign_recipients_message_id_idx', 'uq_campaign_recipients_campaign_contact')
          ORDER BY 1`,
      ),
    ).toEqual([
      {
        indexname: 'uq_campaign_recipients_campaign_contact',
        indexdef:
          'CREATE UNIQUE INDEX uq_campaign_recipients_campaign_contact ON public.campaign_recipients USING btree (campaign_id, contact_id)',
      },
      {
        indexname: 'uq_campaign_recipients_message',
        indexdef:
          'CREATE UNIQUE INDEX uq_campaign_recipients_message ON public.campaign_recipients USING btree (message_id) WHERE (message_id IS NOT NULL)',
      },
    ]);
    expect(
      await q(
        `SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT convalidated`,
      ),
    ).toEqual([]);
  });

  it('the guards: campaign lifecycle and recipient triggers; the recipient guard is a trigger-only definer that fails closed', async () => {
    const triggers = await q(
      `SELECT tgrelid::regclass::text AS tbl, tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
        WHERE tgname IN ('trg_campaigns_lifecycle_guard', 'trg_campaign_recipients_guard', 'trg_automation_capabilities_guard')
        ORDER BY 2`,
    );
    expect(triggers.map((t) => t.def)).toEqual([
      'CREATE TRIGGER trg_automation_capabilities_guard BEFORE DELETE OR UPDATE ON public.automation_capabilities FOR EACH ROW EXECUTE FUNCTION app_automation_capabilities_guard()',
      'CREATE TRIGGER trg_campaign_recipients_guard BEFORE UPDATE ON public.campaign_recipients FOR EACH ROW EXECUTE FUNCTION app_campaign_recipients_guard()',
      'CREATE TRIGGER trg_campaigns_lifecycle_guard BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION app_campaigns_lifecycle_guard()',
    ]);
    const [guard] = await q(
      `SELECT p.prosecdef, p.prosrc FROM pg_proc p WHERE p.oid = 'public.app_campaign_recipients_guard()'::regprocedure`,
    );
    expect(guard.prosecdef).toBe(true);
    expect(guard.prosrc).toMatch(
      /IF NOT FOUND THEN\s+RAISE EXCEPTION[\s\S]*?ERRCODE = 'foreign_key_violation'/,
    );
  });

  it('app_content_context_valid() is byte-identical to its creating migration (0027): not widened for automation', async () => {
    const sqlText = readFileSync(
      resolve(__dirname, '../../migrations/0027_adr015_content_context.sql'),
      'utf8',
    );
    const start = sqlText.indexOf('CREATE OR REPLACE FUNCTION app_content_context_valid()');
    const body = sqlText.slice(start).match(/AS \$\$([\s\S]*?)\$\$/)![1];
    const [row] = await q(
      `SELECT prosrc FROM pg_proc WHERE oid = 'public.app_content_context_valid()'::regprocedure`,
    );
    expect(row.prosrc).toBe(body);
    // and no migration after 0027 redefines it
    const later = readFileSync(
      resolve(
        __dirname,
        '../../migrations/0068_phase8b3_automation_identity_campaign_attribution.sql',
      ),
      'utf8',
    );
    expect(later).not.toMatch(/FUNCTION\s+app_content_context_valid/);
  });

  it('the reservation admits a capability only through a function-local branch tied to the subject', async () => {
    const [row] = await q(
      `SELECT prosrc FROM pg_proc WHERE oid = 'public.app_message_reserve(uuid)'::regprocedure`,
    );
    expect(row.prosrc).toMatch(
      /IF NOT app_content_context_valid\(\) THEN\s+IF NOT app_automation_capability_valid\(\) THEN/,
    );
    expect(row.prosrc).toMatch(
      /IF v_automation AND \(v_message\.campaign_recipient_id IS DISTINCT FROM app_campaign_recipient_id\(\)/,
    );
    expect(row.prosrc).toMatch(/app_ledger_post\(\s*v_org, 'reservation', v_message\.id/);
  });
});
