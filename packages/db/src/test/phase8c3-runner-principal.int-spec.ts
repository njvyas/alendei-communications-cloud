/**
 * Phase 8C PR 8C-3 (migration 0064): the journey runner principal `acc_journey`, pinned.
 *
 * The role is created NOLOGIN and has no credential: the runner is off and refused outside tests
 * until its enablement is separately authorised. Its privileges are exactly the claim protocol
 * and the claimed execution's reads and writes; every policy is bound to one live claim
 * (behaviour is proven in apps/api/test/journeys-runner.int-spec.ts).
 */
import { Pool } from 'pg';

describe('Phase 8C PR 8C-3: acc_journey (migration 0064)', () => {
  let pool: Pool;
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('is an ordinary NOLOGIN principal: no superuser, no BYPASSRLS, no membership', async () => {
    expect(
      await q(
        `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
                (SELECT count(*)::int FROM pg_auth_members am WHERE am.member = r.oid OR am.roleid = r.oid) AS memberships
           FROM pg_roles r WHERE rolname = 'acc_journey'`,
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

  it('holds exactly the claimed execution’s privileges: no message, dispatch, billing or credential table', async () => {
    const table = await q(
      `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
         FROM information_schema.role_table_grants WHERE grantee = 'acc_journey' AND table_schema = 'public'
        GROUP BY table_name ORDER BY table_name`,
    );
    expect(Object.fromEntries(table.map((r) => [r.table_name, r.privs]))).toEqual({
      audit_logs: 'INSERT',
      consent_events: 'SELECT',
      contact_identities: 'SELECT',
      contacts: 'SELECT',
      journey_execution_queue: 'DELETE,SELECT',
      journey_execution_steps: 'INSERT,SELECT',
      journey_executions: 'SELECT',
      journey_versions: 'SELECT',
      journeys: 'SELECT',
      segments: 'SELECT',
      suppressions: 'SELECT',
    });
    const columns = await q(
      `SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS cols
         FROM information_schema.column_privileges
        WHERE grantee = 'acc_journey' AND table_schema = 'public' AND privilege_type = 'UPDATE'
        GROUP BY table_name ORDER BY table_name`,
    );
    expect(Object.fromEntries(columns.map((r) => [r.table_name, r.cols]))).toEqual({
      contacts: 'first_name,last_name,metadata,updated_at',
      journey_execution_queue:
        'attempts,available_at,claim_token,claimed_by,claimed_until,last_error_code',
      // 8C-5b (0067): + wait_deadline_at (the wait_for_outcome deadline lifecycle).
      journey_executions:
        'current_node_key,end_reason,ended_at,state_version,status,transitions,updated_at,wait_deadline_at,wake_at',
    });
  });

  it('every acc_journey policy is bound to the session’s claimed execution (8C-3) or claimed schedule firing (8C-4)', async () => {
    const policies = await q(
      `SELECT tablename, policyname, cmd, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expr
         FROM pg_policies WHERE 'acc_journey' = ANY(roles) ORDER BY tablename, policyname`,
    );
    expect(policies.map((p) => `${p.tablename}.${p.policyname}:${p.cmd}`)).toEqual([
      'audit_logs.audit_logs_journey_runner_insert:INSERT',
      'consent_events.consent_events_runner_select:SELECT',
      // Phase 8C PR 8C-4 (0065): a claimed schedule firing reads its trigger's audience.
      'consent_events.consent_events_scheduler_select:SELECT',
      'contact_identities.contact_identities_runner_select:SELECT',
      'contact_identities.contact_identities_scheduler_select:SELECT',
      'contacts.contacts_runner_select:SELECT',
      'contacts.contacts_runner_update:UPDATE',
      'contacts.contacts_scheduler_select:SELECT',
      'journey_execution_queue.journey_execution_queue_runner_delete:DELETE',
      'journey_execution_queue.journey_execution_queue_runner_select:SELECT',
      'journey_execution_queue.journey_execution_queue_runner_update:UPDATE',
      'journey_execution_steps.journey_execution_steps_runner_insert:INSERT',
      'journey_execution_steps.journey_execution_steps_runner_select:SELECT',
      'journey_executions.journey_executions_runner_select:SELECT',
      'journey_executions.journey_executions_runner_update:UPDATE',
      'journey_versions.journey_versions_runner_select:SELECT',
      'journeys.journeys_runner_select:SELECT',
      // Phase 8C PR 8C-5b (0067): the claimed execution's attributed messages, outcome columns only.
      'messages.messages_runner_select:SELECT',
      'segments.segments_runner_select:SELECT',
      'segments.segments_scheduler_select:SELECT',
      'suppressions.suppressions_runner_select:SELECT',
      'suppressions.suppressions_scheduler_select:SELECT',
    ]);
    for (const p of policies) {
      expect([p.policyname, /app_current_org_id\(\)/.test(p.expr)]).toEqual([p.policyname, true]);
      expect([
        p.policyname,
        /app_journey_execution_id\(\)|app_journey_claimed_execution\(\)|app_journey_claim_valid\(\)|app_journey_claimed_trigger\(\)/.test(
          p.expr,
        ),
      ]).toEqual([p.policyname, true]);
      expect(p.expr).not.toMatch(/\btrue\b/i);
    }
  });

  it('the claim functions are definer functions executable by acc_journey only', async () => {
    const rows = await q(
      `SELECT p.proname, p.prosecdef,
              has_function_privilege('acc_journey', p.oid, 'EXECUTE') AS journey,
              has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('acc_dispatch', p.oid, 'EXECUTE') AS dispatch,
              (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) AS public_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('app_journey_claim', 'app_journey_claim_token', 'app_journey_claim_valid', 'app_journey_claimed_execution', 'app_journey_execution_id')
        ORDER BY p.proname`,
    );
    expect(rows).toEqual([
      {
        proname: 'app_journey_claim',
        prosecdef: true,
        journey: true,
        app: false,
        dispatch: false,
        public_exec: false,
      },
      {
        proname: 'app_journey_claim_token',
        prosecdef: false,
        journey: true,
        app: false,
        dispatch: false,
        public_exec: false,
      },
      {
        proname: 'app_journey_claim_valid',
        prosecdef: true,
        journey: true,
        app: false,
        dispatch: false,
        public_exec: false,
      },
      {
        proname: 'app_journey_claimed_execution',
        prosecdef: true,
        journey: true,
        app: false,
        dispatch: false,
        public_exec: false,
      },
      {
        proname: 'app_journey_execution_id',
        prosecdef: false,
        journey: true,
        app: false,
        dispatch: false,
        public_exec: false,
      },
    ]);
  });

  it('app_journey_claim refuses out-of-range arguments', async () => {
    for (const args of [
      ['w', 0, 30, 5],
      ['w', 101, 30, 5],
      ['w', 10, 4, 5],
      ['w', 10, 601, 5],
      ['w', 10, 30, 0],
      ['', 10, 30, 5],
    ]) {
      await expect(q('SELECT * FROM app_journey_claim($1, $2, $3, $4)', args)).rejects.toThrow(
        /invalid arguments/,
      );
    }
  });
});
