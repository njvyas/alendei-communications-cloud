/**
 * Phase 8C PR 8C-5b (migration 0067), pinned in the catalog: the runner's claim-bound,
 * read-only view of its attributed messages, the deadline grant, and the step <-> message
 * guard failing closed (N1). Behaviour is proven in apps/api/test/journeys-send.int-spec.ts
 * and journeys-send-attribution.int-spec.ts.
 */
import { Pool } from 'pg';

describe('Phase 8C PR 8C-5b: journey send node surface (migration 0067)', () => {
  let pool: Pool;
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('acc_journey reads messages through one policy, bound to its claimed execution and a live claim', async () => {
    expect(
      await q(
        `SELECT policyname, cmd, permissive, roles::text[] AS roles, qual, with_check
           FROM pg_policies WHERE tablename = 'messages' AND 'acc_journey' = ANY(roles)`,
      ),
    ).toEqual([
      {
        policyname: 'messages_runner_select',
        cmd: 'SELECT',
        permissive: 'PERMISSIVE',
        roles: ['acc_journey'],
        qual: '((org_id = app_current_org_id()) AND (journey_execution_id = app_journey_execution_id()) AND ( SELECT app_journey_claim_valid() AS app_journey_claim_valid))',
        with_check: null,
      },
    ]);
  });

  it('acc_journey may read only the outcome columns of messages, and write none', async () => {
    const rows = await q(
      `SELECT privilege_type, string_agg(column_name, ',' ORDER BY column_name) AS cols
         FROM information_schema.column_privileges
        WHERE grantee = 'acc_journey' AND table_schema = 'public' AND table_name = 'messages'
        GROUP BY privilege_type ORDER BY 1`,
    );
    expect(rows).toEqual([
      {
        privilege_type: 'SELECT',
        cols: 'delivered_at,delivery_status,id,journey_execution_id,org_id,read_at,status',
      },
    ]);
    const [table] = await q(
      `SELECT has_table_privilege('acc_journey', 'public.messages', 'INSERT') AS ins,
              has_table_privilege('acc_journey', 'public.messages', 'UPDATE') AS upd,
              has_table_privilege('acc_journey', 'public.messages', 'DELETE') AS del,
              has_table_privilege('acc_journey', 'public.messages', 'SELECT') AS sel_all,
              has_table_privilege('acc_journey', 'public.message_dispatch_queue', 'INSERT') AS queue,
              has_table_privilege('acc_journey', 'public.message_events', 'INSERT') AS events`,
    );
    expect(table).toEqual({
      ins: false,
      upd: false,
      del: false,
      sel_all: false,
      queue: false,
      events: false,
    });
  });

  it('acc_journey may arm and clear the wait deadline (column UPDATE only)', async () => {
    const [row] = await q(
      `SELECT has_column_privilege('acc_journey', 'public.journey_executions', 'wait_deadline_at', 'UPDATE') AS upd`,
    );
    expect(row).toEqual({ upd: true });
  });

  it('the step <-> message guard fails closed when its lookup finds no row (N1)', async () => {
    const [fn] = await q(
      `SELECT p.prosecdef, p.proconfig, p.prosrc FROM pg_proc p
        WHERE p.oid = 'public.app_journey_step_message_guard()'::regprocedure`,
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=pg_catalog, public']);
    expect(fn.prosrc).toMatch(
      /IF NOT FOUND THEN\s+RAISE EXCEPTION[\s\S]*?ERRCODE = 'foreign_key_violation', CONSTRAINT = 'journey_execution_steps_message_fk'/,
    );
    expect(fn.prosrc).not.toMatch(/v_found/);
  });
});
