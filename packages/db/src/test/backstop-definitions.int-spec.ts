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

/**
 * Migration `0026` (ADR-015 R-5, grant side of R-6) — the same discipline: the
 * eligibility triggers, their functions and the permissions CHECKs are pinned
 * by PostgreSQL's own rendering. `fn_validate_role_permission` stays SECURITY
 * DEFINER (since `0000`; it must see the role whatever the writer's RLS
 * context); the two new guards are SECURITY INVOKER.
 */
const TRIGGERS_0026: Record<string, string> = {
  trg_permissions_guard_scope_eligibility: '12ce02574bf95e91568b184e3cf0b84e',
  trg_role_permissions_validate: '73b5f6c4429fae114cff8e23fdc970b8',
  trg_roles_guard_permission_eligibility: '622ca0f81c19269bef261262c88ec99a',
};

/** Function → [md5(pg_get_functiondef), SECURITY DEFINER]. */
const FUNCTIONS_0026: Record<string, [string, boolean]> = {
  fn_permissions_guard_scope_eligibility: ['a96e8b10539cda4f563349cb1eb99899', false],
  fn_roles_guard_permission_eligibility: ['2df88b975456ee2753a33125d8b84118', false],
  fn_validate_role_permission: ['6e58e134434c717ec63f4d8215e84234', true],
};

const PERMISSIONS_CONSTRAINTS_0026: Record<string, string> = {
  permissions_allowed_scope_types_non_empty: 'CHECK ((cardinality(allowed_scope_types) >= 1))',
  permissions_classification_platform_domain:
    "CHECK (((classification = 'platform'::text) = (key ~~ 'platform.%'::text)))",
  permissions_classification_valid:
    "CHECK ((classification = ANY (ARRAY['platform'::text, 'platform_catalogue'::text, 'tenancy_administration'::text, 'tenant_content'::text])))",
  permissions_platform_scope_only:
    "CHECK (((classification <> 'platform'::text) OR (allowed_scope_types = ARRAY['platform'::role_scope_type])))",
  permissions_tenant_content_scopes:
    "CHECK (((classification <> 'tenant_content'::text) OR (NOT (allowed_scope_types && ARRAY['platform'::role_scope_type, 'reseller'::role_scope_type]))))",
};

describe('migration 0026 catalogue: scope-eligibility triggers, functions and CHECKs', () => {
  let db: Principals;

  beforeAll(() => {
    loadTestEnv();
    db = connect();
  });

  afterAll(async () => {
    await db.close();
  });

  it('every 0026 trigger exists, is enabled, and has exactly its pinned definition', async () => {
    const { rows } = await db.admin.execute<{ tgname: string; h: string; enabled: string }>(sql`
      SELECT tgname, md5(pg_get_triggerdef(oid)) AS h, tgenabled AS enabled
      FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY(string_to_array(${Object.keys(TRIGGERS_0026).join(',')}, ','))`);
    expect(Object.fromEntries(rows.map((r) => [r.tgname, r.h]))).toEqual(TRIGGERS_0026);
    expect(rows.map((r) => r.enabled)).toEqual(rows.map(() => 'O'));
  });

  it('every 0026 function has its pinned definition and security mode, a pinned search_path, and no principal may EXECUTE it', async () => {
    const { rows } = await db.admin.execute<{
      proname: string;
      h: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      exec: boolean[];
    }>(sql`
      SELECT p.proname, md5(pg_get_functiondef(p.oid)) AS h, p.prosecdef, p.proconfig,
             ARRAY[has_function_privilege('public', p.oid, 'EXECUTE'),
                   has_function_privilege('acc_app', p.oid, 'EXECUTE'),
                   has_function_privilege('acc_auth', p.oid, 'EXECUTE'),
                   has_function_privilege('acc_relay', p.oid, 'EXECUTE')] AS exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY(string_to_array(${Object.keys(FUNCTIONS_0026).join(',')}, ','))`);
    expect(Object.fromEntries(rows.map((r) => [r.proname, [r.h, r.prosecdef]]))).toEqual(
      FUNCTIONS_0026,
    );
    for (const row of rows) {
      expect([row.proname, row.proconfig, row.exec]).toEqual([
        row.proname,
        ['search_path=public, pg_temp'],
        [false, false, false, false],
      ]);
    }
  });

  it('the permissions CHECKs are exactly the five of 0026 plus the key format', async () => {
    const { rows } = await db.admin.execute<{ conname: string; def: string }>(sql`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'permissions'::regclass AND contype = 'c' AND conname <> 'permissions_key_format'`);
    expect(Object.fromEntries(rows.map((r) => [r.conname, r.def]))).toEqual(
      PERMISSIONS_CONSTRAINTS_0026,
    );
  });

  it('classification and allowed_scope_types are NOT NULL with no default', async () => {
    const { rows } = await db.admin.execute<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
      udt_name: string;
    }>(sql`
      SELECT column_name, is_nullable, column_default, udt_name FROM information_schema.columns
      WHERE table_name = 'permissions' AND column_name IN ('classification', 'allowed_scope_types')
      ORDER BY column_name`);
    expect(rows).toEqual([
      {
        column_name: 'allowed_scope_types',
        is_nullable: 'NO',
        column_default: null,
        udt_name: '_role_scope_type',
      },
      { column_name: 'classification', is_nullable: 'NO', column_default: null, udt_name: 'text' },
    ]);
  });
});

/**
 * Migration `0027` (ADR-015 R-7, ADR-014 §17.1): the Model B tenant-content
 * helper. Pinned by the md5 of `pg_get_functiondef`, with its security mode,
 * volatility, `search_path`, owner and exact ACL — so a definer → invoker
 * change, a dropped search_path pin, an added arm or a widened EXECUTE fails
 * here even where no behavioural test happens to reach the changed branch.
 */
describe('migration 0027 catalogue: app_content_context_valid()', () => {
  let db: Principals;

  beforeAll(() => {
    loadTestEnv();
    db = connect();
  });

  afterAll(async () => {
    await db.close();
  });

  it('has exactly its pinned definition: STABLE SECURITY DEFINER, search_path = public, pg_temp, no arguments, boolean', async () => {
    const { rows } = await db.admin.execute<Record<string, unknown>>(sql`
      SELECT md5(pg_get_functiondef(p.oid)) AS h, p.prosecdef, p.proconfig, p.provolatile,
             p.pronargs, p.prorettype::regtype::text AS returns, l.lanname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND p.proname = 'app_content_context_valid'`);
    expect(rows).toEqual([
      {
        h: '611890103da0a02dacf84707028ecd7e',
        prosecdef: true,
        proconfig: ['search_path=public, pg_temp'],
        provolatile: 's',
        pronargs: 0,
        returns: 'boolean',
        lanname: 'plpgsql',
      },
    ]);
  });

  it('is owned by the tables’ owner and executable by acc_app alone', async () => {
    const { rows } = await db.admin.execute<{
      owner: string;
      acl: string;
      table_owner: string;
    }>(sql`
      SELECT pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
             (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.user_roles'::regclass) AS table_owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_content_context_valid'`);
    const { owner, acl, table_owner } = rows[0]!;
    expect(owner).toBe(table_owner);
    expect(acl).toBe(`{${owner}=X/${owner},acc_app=X/${owner}}`);
  });

  it('no policy calls it yet: there is no content table before Phase 3.1', async () => {
    const { rows } = await db.admin.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM pg_policies
      WHERE coalesce(qual, '') || coalesce(with_check, '') LIKE '%app_content_context_valid%'`);
    expect(rows[0]!.n).toBe('0');
  });
});
