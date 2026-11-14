/**
 * Phase 8C PR 8C-5a (migration 0066): journey send attribution, pinned in the catalog.
 *
 * Behaviour (shape, composite FK per dimension, write-once, step <-> message integrity, the
 * wait-deadline CHECK, direct-API invariance) is proven against the real application in
 * apps/api/test/journeys-send-attribution.int-spec.ts. This spec pins the definitions: every
 * constraint validated, the exact FK columns, no new index on messages, the write-once
 * trigger's columns, and the step guard as a trigger-only definer function.
 */
import { Pool } from 'pg';

describe('Phase 8C PR 8C-5a: journey send attribution (migration 0066)', () => {
  let pool: Pool;
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('adds nullable attribution columns to messages and the deadline column to executions', async () => {
    expect(
      await q(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (table_name, column_name) IN (('messages', 'journey_id'), ('messages', 'journey_execution_id'),
                                              ('journey_executions', 'wait_deadline_at'))
          ORDER BY table_name, column_name`,
      ),
    ).toEqual([
      {
        table_name: 'journey_executions',
        column_name: 'wait_deadline_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        table_name: 'messages',
        column_name: 'journey_execution_id',
        data_type: 'uuid',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        table_name: 'messages',
        column_name: 'journey_id',
        data_type: 'uuid',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
  });

  it('defines each 0066 constraint exactly, and every one is validated', async () => {
    const rows = await q(
      `SELECT conrelid::regclass::text AS tbl, conname, convalidated, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conname IN ('messages_journey_shape', 'messages_journey_execution_fk',
                          'journey_execution_steps_message_fk', 'journey_execution_steps_message_shape',
                          'journey_executions_wait_deadline_shape', 'uq_journey_executions_attribution')
        ORDER BY conname`,
    );
    expect(rows).toEqual([
      {
        tbl: 'journey_execution_steps',
        conname: 'journey_execution_steps_message_fk',
        convalidated: true,
        def: 'FOREIGN KEY (message_id, org_id) REFERENCES messages(id, org_id) ON DELETE RESTRICT',
      },
      {
        tbl: 'journey_execution_steps',
        conname: 'journey_execution_steps_message_shape',
        convalidated: true,
        def: "CHECK (((message_id IS NULL) OR ((node_type = 'send_message'::text) AND (outcome = 'completed'::journey_step_outcome))))",
      },
      {
        tbl: 'journey_executions',
        conname: 'journey_executions_wait_deadline_shape',
        convalidated: true,
        def: "CHECK (((wait_deadline_at IS NULL) OR (status = 'waiting'::journey_execution_status)))",
      },
      {
        tbl: 'messages',
        conname: 'messages_journey_execution_fk',
        convalidated: true,
        def: 'FOREIGN KEY (journey_execution_id, journey_id, workspace_id, contact_id, org_id) REFERENCES journey_executions(id, journey_id, workspace_id, contact_id, org_id) ON DELETE RESTRICT',
      },
      {
        tbl: 'messages',
        conname: 'messages_journey_shape',
        convalidated: true,
        def: 'CHECK (((journey_id IS NULL) = (journey_execution_id IS NULL)))',
      },
      {
        tbl: 'journey_executions',
        conname: 'uq_journey_executions_attribution',
        convalidated: true,
        def: 'UNIQUE (id, journey_id, workspace_id, contact_id, org_id)',
      },
    ]);
  });

  it('leaves no NOT VALID constraint anywhere in the schema', async () => {
    expect(
      await q(
        `SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
          WHERE connamespace = 'public'::regnamespace AND NOT convalidated`,
      ),
    ).toEqual([]);
  });

  it('adds no index on messages for the attribution columns', async () => {
    expect(
      await q(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'messages' AND indexdef ~ 'journey'`,
      ),
    ).toEqual([]);
  });

  it('write-once: the tenant-key trigger now covers both attribution columns', async () => {
    const [row] = await q(
      `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
        WHERE t.tgrelid = 'public.messages'::regclass AND t.tgname = 'trg_messages_tenant_key_immutable'`,
    );
    expect(row.def).toBe(
      "CREATE TRIGGER trg_messages_tenant_key_immutable AFTER UPDATE OF org_id, workspace_id, contact_id, channel_id, journey_id, journey_execution_id ON public.messages FOR EACH ROW WHEN (((old.org_id IS DISTINCT FROM new.org_id) OR (old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.contact_id IS DISTINCT FROM new.contact_id) OR (old.channel_id IS DISTINCT FROM new.channel_id) OR (old.journey_id IS DISTINCT FROM new.journey_id) OR (old.journey_execution_id IS DISTINCT FROM new.journey_execution_id))) EXECUTE FUNCTION fn_tenant_key_immutable('org_id', 'workspace_id', 'contact_id', 'channel_id', 'journey_id', 'journey_execution_id')",
    );
  });

  it('the step <-> message guard is a BEFORE INSERT trigger on a definer function nobody may execute', async () => {
    const [trigger] = await q(
      `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
        WHERE t.tgrelid = 'public.journey_execution_steps'::regclass
          AND t.tgname = 'trg_journey_execution_steps_message_guard'`,
    );
    expect(trigger.def).toBe(
      'CREATE TRIGGER trg_journey_execution_steps_message_guard BEFORE INSERT ON public.journey_execution_steps FOR EACH ROW WHEN ((new.message_id IS NOT NULL)) EXECUTE FUNCTION app_journey_step_message_guard()',
    );
    const [fn] = await q(
      `SELECT p.prosecdef, p.proconfig, pg_get_function_result(p.oid) AS result
         FROM pg_proc p WHERE p.oid = 'public.app_journey_step_message_guard()'::regprocedure`,
    );
    expect(fn).toEqual({
      prosecdef: true,
      proconfig: ['search_path=pg_catalog, public'],
      result: 'trigger',
    });
    const executable = await q(
      `SELECT r.rolname FROM pg_roles r
        WHERE (r.rolname LIKE 'acc\\_%' OR r.rolname = 'public')
          AND NOT r.rolsuper
          AND r.oid <> (SELECT proowner FROM pg_proc WHERE oid = 'public.app_journey_step_message_guard()'::regprocedure)
          AND has_function_privilege(r.oid, 'public.app_journey_step_message_guard()'::regprocedure, 'EXECUTE')
        ORDER BY 1`,
    );
    expect(executable).toEqual([]);
    const [publicGrant] = await q(
      `SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       WHERE p.oid = 'public.app_journey_step_message_guard()'::regprocedure
                         AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute`,
    );
    expect(publicGrant).toEqual({ public_execute: false });
  });

  it('column grants on the new columns: only the two 8C-5b grants to acc_journey (0067, §3.1D)', async () => {
    // 0066 granted nothing. 0067 (8C-5b) grants acc_journey SELECT of journey_execution_id (its
    // claim-bound read of attributed messages) and UPDATE of wait_deadline_at (the deadline
    // lifecycle); both are also pinned in phase8c3-runner-principal.int-spec.ts.
    expect(
      await q(
        `SELECT grantee, table_name, column_name, privilege_type FROM information_schema.column_privileges
          WHERE table_schema = 'public'
            AND (table_name, column_name) IN (('messages', 'journey_id'), ('messages', 'journey_execution_id'),
                                              ('journey_executions', 'wait_deadline_at'))
            AND grantee LIKE 'acc\\_%'
            AND grantee NOT IN (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = table_name)
            AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                             WHERE g.table_schema = 'public' AND g.table_name = column_privileges.table_name
                               AND g.grantee = column_privileges.grantee
                               AND g.privilege_type = column_privileges.privilege_type)
          ORDER BY 1, 2, 3, 4`,
      ),
    ).toEqual([
      {
        grantee: 'acc_journey',
        table_name: 'journey_executions',
        column_name: 'wait_deadline_at',
        privilege_type: 'UPDATE',
      },
      {
        grantee: 'acc_journey',
        table_name: 'messages',
        column_name: 'journey_execution_id',
        privilege_type: 'SELECT',
      },
    ]);
  });
});
