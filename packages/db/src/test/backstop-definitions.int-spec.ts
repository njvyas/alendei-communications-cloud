/**
 * Migration `0025` (ADR-015 R-2, R-3, R-4) — the exact catalogue of what it
 * installed, so a change to any trigger, function or policy it owns fails here
 * even when no behavioural test happens to exercise the changed branch.
 *
 * Definitions are pinned by the md5 of PostgreSQL's own rendering
 * (`pg_get_triggerdef`, `pg_get_functiondef`, `pg_policies`), so the check is of
 * what the database runs, not of the migration text. A deliberate change to one
 * of them updates the pin here in the same commit, with the reason.
 *
 * Option B (D-HIGH-2): the users and sessions policies are pinned to their
 * pre-0025 definitions — 0025 changed no predicate there — and no
 * `app_actor_covers_user` exists.
 */
import { sql } from 'drizzle-orm';

import { connect, loadTestEnv, type Principals } from './harness';

/** Trigger name → md5(pg_get_triggerdef). Every trigger is enabled ('O'). */
const TRIGGERS: Record<string, string> = {
  trg_api_keys_org_id_immutable: '56cda0cc9141e36f22908777b345459c',
  trg_api_keys_revocation_terminal: '7be4790f80e05a4cf4e8f00e9a56e36e',
  trg_idempotency_keys_org_id_immutable: '63360462348e153a6892ddc3e9fdff9b',
  trg_organizations_guard_lifecycle: '4bd98e15b483ff126c621fbf91e83d21',
  trg_resellers_grant_restrict: 'f4da9776f96b35451b60dcc4afb88abd',
  trg_resellers_guard_platform_fields: 'c668af5f62e3b29f8cb68d5bd6d55a51',
  trg_roles_org_id_immutable: 'a0906def3643676fa9da24b49b02f85d',
  trg_sessions_revocation_terminal: '24ebde6432c3949612fa09f8623ef35f',
  trg_sessions_user_id_immutable: 'a040f7eaa53d556f505da5af05e42ef9',
  trg_teams_grant_restrict: '967ba6026fd2e9eee4c3dc487a39a99b',
  trg_teams_org_id_immutable: '79ad065fa276c4e9de6960884b332ecb',
  trg_users_insert_shape: '09b68347c34da8307edea4685db1cc73',
  trg_workspaces_grant_restrict: '58c845194c8a2e338813f6236ef6b21a',
  trg_workspaces_org_id_immutable: '353576a35f3c5384113480db657aafc2',
};

/** Function name → md5(pg_get_functiondef). All SECURITY INVOKER, pinned search_path. */
const FUNCTIONS: Record<string, string> = {
  fn_organizations_guard_lifecycle: '7dc0b068a5509fe638efdbd496a5051d',
  fn_resellers_guard_platform_fields: '3b80f64db8ba3ddec3e56b8933a4cff4',
  fn_revocation_terminal: 'f0f4eeb6fb0d291e0fc1792d84fd8d5f',
  fn_scope_parent_restrict: 'c4a2f404e5f86a666e96a1dde9bb9d9b',
  fn_tenant_key_immutable: '8d7196b9d83439a24aa6236517b8b9e2',
  fn_users_insert_shape: '58df7d4ba934c9789ccd3833639e4131',
};

/** Policy → md5(qual || '|' || with_check). */
const POLICIES: Record<string, string> = {
  // Changed by 0025: the provisioning arm binds reseller_id (R-4).
  'organizations.organizations_insert': '465f8a2a05a336c0a01b4bed4ec553e5',
  // Unchanged by 0025 (pre-0025 values; option B changes no coverage predicate).
  'organizations.organizations_update': '589e36d05247f73007bfdc1ee56c3245',
  'resellers.resellers_write': 'e26cae75652e5e934c757a32ab27fd78',
  'sessions.sessions_self': '31d6c50fe993eebe55ef13e30234fd13',
  'users.users_select': '7f97d40a6bb2408ce88c39f896d31567',
  'users.users_update': 'fd6898f5dc393c66a113a4e2e59ccb33',
};

describe('migration 0025 catalogue: triggers, functions and policies', () => {
  let db: Principals;

  beforeAll(() => {
    loadTestEnv();
    db = connect();
  });

  afterAll(async () => {
    await db.close();
  });

  it('every 0025 trigger exists, is enabled, and has exactly its pinned definition', async () => {
    const { rows } = await db.admin.execute<{ tgname: string; h: string; enabled: string }>(sql`
      SELECT tgname, md5(pg_get_triggerdef(oid)) AS h, tgenabled AS enabled
      FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY(string_to_array(${Object.keys(TRIGGERS).join(',')}, ','))`);
    expect(Object.fromEntries(rows.map((r) => [r.tgname, r.h]))).toEqual(TRIGGERS);
    expect(rows.map((r) => r.enabled)).toEqual(rows.map(() => 'O'));
  });

  it('every 0025 function has its pinned definition, is SECURITY INVOKER with a pinned search_path, and no principal may EXECUTE it', async () => {
    const { rows } = await db.admin.execute<{
      proname: string;
      h: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      public_exec: boolean;
      app_exec: boolean;
      auth_exec: boolean;
      relay_exec: boolean;
    }>(sql`
      SELECT p.proname, md5(pg_get_functiondef(p.oid)) AS h, p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app_exec,
             has_function_privilege('acc_auth', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('acc_relay', p.oid, 'EXECUTE') AS relay_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY(string_to_array(${Object.keys(FUNCTIONS).join(',')}, ','))`);
    expect(Object.fromEntries(rows.map((r) => [r.proname, r.h]))).toEqual(FUNCTIONS);
    for (const row of rows) {
      expect({
        name: row.proname,
        definer: row.prosecdef,
        config: row.proconfig,
        exec: [row.public_exec, row.app_exec, row.auth_exec, row.relay_exec],
      }).toEqual({
        name: row.proname,
        definer: false,
        config: ['search_path=public, pg_temp'],
        exec: [false, false, false, false],
      });
    }
  });

  it('the changed policy and the deliberately unchanged ones have exactly their pinned predicates', async () => {
    const { rows } = await db.admin.execute<{ k: string; h: string }>(sql`
      SELECT tablename || '.' || policyname AS k,
             md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) AS h
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename || '.' || policyname = ANY(string_to_array(${Object.keys(POLICIES).join(',')}, ','))`);
    expect(Object.fromEntries(rows.map((r) => [r.k, r.h]))).toEqual(POLICIES);
  });

  it('the provisioning arm of organizations_insert requires the validated reseller claim or platform.tenants.manage', async () => {
    const { rows } = await db.admin.execute<{ with_check: string }>(sql`
      SELECT with_check FROM pg_policies
      WHERE tablename = 'organizations' AND policyname = 'organizations_insert'`);
    const check = rows[0]!.with_check.replace(/\s+/g, ' ');
    expect(check).toContain(
      "app_is_provisioning() AND (id = app_current_org_id()) AND ((reseller_id = app_current_reseller_id()) OR app_has_platform_permission('platform.tenants.manage'::text))",
    );
  });

  it('option B: no second authorization source — app_actor_covers_user does not exist', async () => {
    const { rows } = await db.admin.execute(
      sql`SELECT 1 FROM pg_proc WHERE proname = 'app_actor_covers_user'`,
    );
    expect(rows).toEqual([]);
  });
});
