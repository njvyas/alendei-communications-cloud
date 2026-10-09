/**
 * ADR-015 remediation step 2 — migration `0025` database backstops, proven
 * directly against PostgreSQL (R-2 / HIGH-2, R-3 / MEDIUM-1, R-4 / MEDIUM-2).
 *
 *   A  identity credentials and sessions (R-2): column-level UPDATE, no acc_app
 *      session INSERT, acc_auth narrowed, users insert shape, revocation terminal
 *   B  tenant-key immutability and scope integrity (R-3)
 *   C  organization lifecycle and billing authority, reseller platform fields,
 *      provisioning reseller binding (R-4)
 *   D  transition parity with `ORGANIZATION_TRANSITIONS`
 *   E  deterministic concurrency: a close held while a reopen runs
 *   F  the migration's verification block refuses bad data, naming it
 *
 * Every statement runs as a real principal — `acc_app` under an explicit tenant
 * context, `acc_auth`, or the schema owner — in its own transaction, which is
 * rolled back, so each case sees the same planted state. A refusal asserts the
 * exact SQLSTATE and the permission message or constraint name; an admitted
 * write asserts its row count.
 *
 * Option B (D-HIGH-2): coverage of a subject's grants stays the application's
 * F-9 rule. These tests prove the column and shape backstops, not coverage.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { TRANSITIONS as ORGANIZATION_TRANSITIONS } from '../src/organizations/organization-administration.service';

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}
interface Ctx {
  orgId?: string;
  resellerId?: string;
  userId?: string;
  platform?: boolean;
  provisioning?: boolean;
}
type Outcome = { rows: number } | { code: string; constraint: string | null; message: string };
type Status = 'active' | 'suspended' | 'closed';

const MIGRATION = resolve(
  __dirname,
  '../../../packages/db/migrations/0025_adr015_column_backstops_lifecycle.sql',
);

const ok = (rows = 1): Outcome => ({ rows });
/** A column- or table-privilege refusal: 42501, no constraint, PostgreSQL's own message. */
const denied = (table: string): Outcome => ({
  code: '42501',
  constraint: null,
  message: `permission denied for table ${table}`,
});
/** An RLS WITH CHECK refusal. */
const rlsDenied = (table: string): Outcome => ({
  code: '42501',
  constraint: null,
  message: `new row violates row-level security policy for table "${table}"`,
});
/** A refusal raised by a 0025 guard: exact SQLSTATE and constraint, message by pattern. */
const refused = (code: string, constraint: string, message: RegExp) => ({
  code,
  constraint,
  message: expect.stringMatching(message) as unknown as string,
});

const tag = randomBytes(4).toString('hex');
const suffix = () => randomBytes(5).toString('hex');

describe('migration 0025 database backstops (ADR-015 R-2, R-3, R-4)', () => {
  let owner: Pool;
  let app: Pool;
  let auth: Pool;
  let relay: Pool;

  // Planted state (ids).
  const f = {} as Record<string, string>;
  const users: string[] = [];
  let tenantsManagePlatformRole = '';
  let addedSuperAdminTenantsManage = false;

  /** One statement as `pool` under `ctx`, in a transaction that is always rolled back. */
  async function attempt(
    pool: Pool,
    ctx: Ctx | null,
    text: string,
    params: unknown[] = [],
  ): Promise<Outcome> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (ctx) await applyCtx(c, ctx);
      const r = await c.query(text, params);
      return { rows: r.rowCount ?? 0 };
    } catch (error) {
      const e = error as PgError;
      return { code: e.code ?? '', constraint: e.constraint ?? null, message: e.message };
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  async function applyCtx(c: PoolClient, ctx: Ctx): Promise<void> {
    for (const [name, value] of [
      ['app.current_org_id', ctx.orgId ?? ''],
      ['app.current_workspace_id', ''],
      ['app.current_reseller_id', ctx.resellerId ?? ''],
      ['app.current_user_id', ctx.userId ?? ''],
      ['app.is_platform_admin', ctx.platform ? 'on' : 'off'],
      ['app.provisioning', ctx.provisioning ? 'on' : 'off'],
    ] as const) {
      await c.query('SELECT set_config($1, $2, true)', [name, value]);
    }
  }

  /** Owner statements committed as planting, with the platform flag the scope validator needs. */
  async function plant<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.is_platform_admin', 'on', true)");
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  const one = async (c: PoolClient, text: string, params: unknown[] = []): Promise<string> =>
    (await c.query(text, params)).rows[0].id as string;

  // Contexts.
  const orgAdminA = (): Ctx => ({ userId: f.uOrg!, orgId: f.A! });
  const resellerR = (): Ctx => ({ userId: f.uRes!, resellerId: f.R! });
  const superAdmin = (orgId = f.A!): Ctx => ({ userId: f.uSup!, platform: true, orgId });
  const tenantsManager = (orgId = f.A!): Ctx => ({ userId: f.uTm!, orgId });
  const support = (orgId = f.A!): Ctx => ({ userId: f.uSupport!, platform: true, orgId });

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 3 });
    app = new Pool({ connectionString: process.env.DATABASE_URL!, max: 4 });
    auth = new Pool({ connectionString: process.env.DATABASE_AUTH_URL!, max: 2 });
    relay = new Pool({ connectionString: process.env.DATABASE_RELAY_URL!, max: 1 });

    await plant(async (c) => {
      const role = async (key: string) =>
        one(c, 'SELECT id FROM roles WHERE key = $1 AND org_id IS NULL', [key]);
      const superRole = await role('alendei_super_admin');
      const supportRole = await role('alendei_support');
      const resellerRole = await role('reseller_admin');
      const manage = await one(
        c,
        "SELECT id FROM permissions WHERE key = 'platform.tenants.manage'",
      );
      addedSuperAdminTenantsManage =
        ((
          await c.query(
            'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [superRole, manage],
          )
        ).rowCount ?? 0) > 0;
      f.superRole = superRole;
      // A platform role holding platform.tenants.manage and nothing else: the
      // validated permission, without the super-admin role key.
      tenantsManagePlatformRole = await one(
        c,
        `INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
         VALUES (NULL, $1, 'Backstop tenants manager', false, '{platform}') RETURNING id`,
        [`bs_tenants_manager_${tag}`],
      );
      await c.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [
        tenantsManagePlatformRole,
        manage,
      ]);

      const reseller = (n: string) =>
        one(c, 'INSERT INTO resellers (name, slug) VALUES ($1, $2) RETURNING id', [
          n,
          `bs-${n}-${tag}`,
        ]);
      f.R = await reseller('r');
      f.R2 = await reseller('r2');
      const org = (n: string, r: string, status: Status = 'active') =>
        one(
          c,
          'INSERT INTO organizations (name, slug, reseller_id, status) VALUES ($1, $2, $3, $4) RETURNING id',
          [`BS ${n}`, `bs-${n}-${tag}`, r, status],
        );
      f.A = await org('a', f.R);
      f.B = await org('b', f.R, 'suspended');
      f.C = await org('c', f.R2);
      f.X = await org('x', f.R, 'closed');
      f.P = await org('p', f.R); // transition parity
      f.Q = await org('q', f.R, 'suspended'); // concurrency
      const ws = (o: string, n: string) =>
        one(c, 'INSERT INTO workspaces (org_id, name, slug) VALUES ($1, $2, $2) RETURNING id', [
          o,
          n,
        ]);
      f.WA = await ws(f.A, 'wa');
      f.WA2 = await ws(f.A, 'wa2');
      f.WG = await ws(f.A, 'wg'); // holds a workspace-scoped grant
      f.WB = await ws(f.B, 'wb');
      const team = (o: string, w: string, n: string) =>
        one(c, 'INSERT INTO teams (org_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id', [
          o,
          w,
          n,
        ]);
      f.TA = await team(f.A, f.WA, 'ta'); // holds a team-scoped grant
      f.TA2 = await team(f.A, f.WA, 'ta2'); // free
      const user = async (n: string) => {
        const id = await one(
          c,
          "INSERT INTO users (email, password_hash, status) VALUES ($1, 'not-a-credential', 'active') RETURNING id",
          [`bs-${n}-${tag}@example.test`],
        );
        users.push(id);
        return id;
      };
      f.uSup = await user('sup');
      f.uTm = await user('tm');
      f.uSupport = await user('support');
      f.uRes = await user('res');
      f.uOrg = await user('org');
      f.uMulti = await user('multi');
      f.uPlain = await user('plain');
      f.uAb = await user('ab');
      const tenantRole = (o: string, k: string) =>
        one(
          c,
          `INSERT INTO roles (org_id, key, name, allowed_scope_types)
           VALUES ($1, $2, 'Backstop', '{organization,workspace,team}') RETURNING id`,
          [o, `bs_${k}_${tag}`],
        );
      f.RA = await tenantRole(f.A, 'ra');
      f.RA2 = await tenantRole(f.A, 'ra2'); // free: no grant
      f.RB = await tenantRole(f.B, 'rb');
      const grant = (u: string, r: string, scopeType: string, scopeId: string | null) =>
        c.query(
          'INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, $4)',
          [u, r, scopeType, scopeId],
        );
      await grant(f.uSup, superRole, 'platform', null);
      await grant(f.uSup, f.RA, 'organization', f.A); // a super admin that is also an org member
      await grant(f.uTm, tenantsManagePlatformRole, 'platform', null);
      await grant(f.uSupport, supportRole, 'platform', null);
      await grant(f.uRes, resellerRole, 'reseller', f.R);
      await grant(f.uOrg, f.RA, 'organization', f.A);
      await grant(f.uOrg, f.RA, 'team', f.TA);
      await grant(f.uOrg, f.RA, 'workspace', f.WG);
      await grant(f.uMulti, f.RA, 'organization', f.A);
      await grant(f.uMulti, f.RB, 'organization', f.B);
      await grant(f.uPlain, f.RA, 'organization', f.A);
      await grant(f.uAb, f.RA, 'organization', f.A);
      await grant(f.uAb, f.RB, 'organization', f.B);

      const session = (u: string) =>
        one(
          c,
          "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id",
          [u, `bs-${suffix()}`],
        );
      f.sSup = await session(f.uSup);
      f.sPlain = await session(f.uPlain);
      f.sRevoked = await one(
        c,
        `INSERT INTO sessions (user_id, refresh_token_hash, expires_at, revoked_at, revoked_reason)
         VALUES ($1, $2, now() + interval '1 day', now() - interval '1 hour', 'user_logout') RETURNING id`,
        [f.uPlain, `bs-${suffix()}`],
      );
      const key = (o: string, w: string | null, revoked = false) =>
        one(
          c,
          `INSERT INTO api_keys (org_id, workspace_id, name, key_prefix, key_hash, scopes, revoked_at, revoked_reason)
           VALUES ($1, $2, 'bs', $3, 'not-a-hash', '["users.read"]'::jsonb, $4, $5) RETURNING id`,
          [
            o,
            w,
            `ak_test_${randomBytes(8).toString('hex')}`,
            revoked ? new Date(Date.now() - 3_600_000) : null,
            revoked ? 'revoked_by_admin' : null,
          ],
        );
      f.KA = await key(f.A, null);
      f.KW = await key(f.A, f.WA);
      f.KRevoked = await key(f.A, null, true);
      f.IK = await one(
        c,
        `INSERT INTO idempotency_keys (org_id, endpoint, idempotency_key, request_hash, status, expires_at)
         VALUES ($1, 'POST /bs', $2, 'h', 'pending', now() + interval '1 day') RETURNING id`,
        [f.A, `bs-${tag}`],
      );
      f.TICKET = await one(
        c,
        `INSERT INTO ws_tickets (ticket_hash, user_id, org_id, workspace_id, expires_at)
         VALUES ($1, $2, $3, NULL, now() + interval '1 minute') RETURNING id`,
        [`bs-${suffix()}`, f.uPlain, f.A],
      );
    });
  }, 60_000);

  afterAll(async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        'ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness',
      );
      await c.query(
        'ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_reseller_admin_liveness',
      );
      const orgs = [f.A, f.B, f.C, f.X, f.P, f.Q].filter(Boolean);
      await c.query('DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])', [users]);
      await c.query('DELETE FROM ws_tickets WHERE org_id = ANY($1::uuid[])', [orgs]);
      await c.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [users]);
      await c.query('DELETE FROM api_keys WHERE org_id = ANY($1::uuid[])', [orgs]);
      await c.query('DELETE FROM idempotency_keys WHERE org_id = ANY($1::uuid[])', [orgs]);
      await c.query('DELETE FROM teams WHERE org_id = ANY($1::uuid[])', [orgs]);
      await c.query('DELETE FROM workspaces WHERE org_id = ANY($1::uuid[])', [orgs]);
      await c.query('DELETE FROM role_permissions WHERE org_id = ANY($1::uuid[])', [orgs]);
      await c.query('DELETE FROM roles WHERE org_id = ANY($1::uuid[])', [orgs]);
      if (tenantsManagePlatformRole) {
        await c.query("SELECT set_config('app.is_platform_admin', 'on', true)");
        await c.query('DELETE FROM role_permissions WHERE role_id = $1', [
          tenantsManagePlatformRole,
        ]);
        await c.query('DELETE FROM roles WHERE id = $1', [tenantsManagePlatformRole]);
      }
      if (addedSuperAdminTenantsManage) {
        await c.query(
          `DELETE FROM role_permissions WHERE role_id = $1
             AND permission_id = (SELECT id FROM permissions WHERE key = 'platform.tenants.manage')`,
          [f.superRole],
        );
      }
      await c.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
      await c.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [orgs]);
      await c.query('DELETE FROM resellers WHERE id = ANY($1::uuid[])', [
        [f.R, f.R2].filter(Boolean),
      ]);
      await c.query('ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_reseller_admin_liveness');
      await c.query('ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness');
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
    await Promise.all([owner.end(), app.end(), auth.end(), relay.end()]);
  }, 60_000);

  // ===========================================================================
  describe('A. identity credentials and sessions (R-2)', () => {
    it('acc_app cannot write email, password_hash or mfa_* of a super administrator holding an org grant', async () => {
      for (const set of [
        "password_hash = 'attacker'",
        "email = 'pwn@example.test'",
        "mfa_secret_ref = 'x'",
        'mfa_enabled = true',
        'password_updated_at = now()',
        'last_login_at = now()',
      ]) {
        expect(
          await attempt(app, orgAdminA(), `UPDATE users SET ${set} WHERE id = $1`, [f.uSup]),
        ).toEqual(denied('users'));
      }
    });

    it('nor of a multi-organization user, nor under a validated platform or reseller context', async () => {
      for (const ctx of [orgAdminA(), superAdmin(), resellerR()]) {
        for (const target of [f.uMulti!, f.uPlain!]) {
          expect(
            await attempt(app, ctx, "UPDATE users SET password_hash = 'x' WHERE id = $1", [target]),
          ).toEqual(denied('users'));
          expect(
            await attempt(app, ctx, "UPDATE users SET email = 'x@example.test' WHERE id = $1", [
              target,
            ]),
          ).toEqual(denied('users'));
        }
      }
    });

    it('[+] acc_app still administers phone and status (F-9 coverage stays the application rule)', async () => {
      expect(
        await attempt(
          app,
          orgAdminA(),
          "UPDATE users SET phone = '+911', updated_at = now() WHERE id = $1",
          [f.uPlain],
        ),
      ).toEqual(ok());
      expect(
        await attempt(
          app,
          orgAdminA(),
          "UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1",
          [f.uPlain],
        ),
      ).toEqual(ok());
      expect(
        await attempt(
          app,
          { userId: f.uAb!, orgId: f.A! },
          "UPDATE users SET status = 'disabled' WHERE id = $1",
          [f.uMulti],
        ),
      ).toEqual(ok());
    });

    it('acc_app cannot create a session, under any context', async () => {
      for (const ctx of [orgAdminA(), superAdmin(), { userId: f.uPlain! }]) {
        expect(
          await attempt(
            app,
            ctx,
            "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES ($1, 'known', now() + interval '1 day')",
            [f.uSup],
          ),
        ).toEqual(denied('sessions'));
      }
    });

    it('[+] acc_app revokes a live session; it cannot extend, re-point or un-revoke one', async () => {
      expect(
        await attempt(
          app,
          orgAdminA(),
          "UPDATE sessions SET revoked_at = now(), revoked_reason = 'admin_revoked' WHERE id = $1",
          [f.sPlain],
        ),
      ).toEqual(ok());
      for (const set of [
        "expires_at = now() + interval '9 years'",
        'refresh_token_hash = refresh_token_hash',
        'user_id = user_id',
        'rotated_at = NULL',
        'last_used_at = now()',
      ]) {
        expect(
          await attempt(app, superAdmin(), `UPDATE sessions SET ${set} WHERE id = $1`, [f.sPlain]),
        ).toEqual(denied('sessions'));
      }
      for (const set of ['revoked_at = NULL', "revoked_reason = 'other'", 'revoked_at = now()']) {
        expect(
          await attempt(app, orgAdminA(), `UPDATE sessions SET ${set} WHERE id = $1`, [f.sRevoked]),
        ).toEqual(
          refused(
            '42501',
            'sessions_revocation_terminal',
            /sessions: revocation of .* is terminal/,
          ),
        );
      }
    });

    it('acc_auth cannot un-revoke or extend a session, nor re-point it', async () => {
      expect(
        await attempt(auth, null, 'UPDATE sessions SET revoked_at = NULL WHERE id = $1', [
          f.sRevoked,
        ]),
      ).toEqual(
        refused('42501', 'sessions_revocation_terminal', /sessions: revocation of .* is terminal/),
      );
      expect(
        await attempt(
          auth,
          null,
          "UPDATE sessions SET expires_at = now() + interval '9 years' WHERE id = $1",
          [f.sPlain],
        ),
      ).toEqual(denied('sessions'));
      expect(
        await attempt(auth, null, 'UPDATE sessions SET user_id = $1 WHERE id = $2', [
          f.uSup,
          f.sPlain,
        ]),
      ).toEqual(denied('sessions'));
    });

    it('sessions.user_id is immutable for the owner too', async () => {
      expect(
        await attempt(owner, null, 'UPDATE sessions SET user_id = $1 WHERE id = $2', [
          f.uSup,
          f.sPlain,
        ]),
      ).toEqual(
        refused('42501', 'sessions_user_id_immutable', /sessions: user_id of row .* is immutable/),
      );
    });

    it('[+] acc_auth creates (Drizzle shape), rotates, touches and revokes sessions', async () => {
      expect(
        await attempt(
          auth,
          null,
          `INSERT INTO sessions (id, user_id, refresh_token_hash, device_info, ip, user_agent, expires_at,
             family_id, revoked_at, revoked_reason, rotated_at, replaced_by_session_id, reuse_detected_at,
             last_used_at, created_at, updated_at)
           VALUES (default, $1, $2, '{}', NULL, NULL, now() + interval '1 day', default, default, default,
             default, default, default, default, default, default)`,
          [f.uPlain, `bs-${suffix()}`],
        ),
      ).toEqual(ok());
      expect(
        await attempt(
          auth,
          null,
          `UPDATE sessions SET family_id = family_id, rotated_at = now(), reuse_detected_at = now(),
             last_used_at = now(), revoked_at = now(), revoked_reason = 'user_logout' WHERE id = $1`,
          [f.sPlain],
        ),
      ).toEqual(ok());
    });

    it('acc_auth cannot write users.status or email; [+] it records sign-in and rehashes', async () => {
      for (const set of ["status = 'active'", "email = 'z@example.test'", "mfa_secret_ref = 'x'"]) {
        expect(
          await attempt(auth, null, `UPDATE users SET ${set} WHERE id = $1`, [f.uSup]),
        ).toEqual(denied('users'));
      }
      expect(
        await attempt(
          auth,
          null,
          "UPDATE users SET last_login_at = now(), password_hash = 'h2', password_updated_at = now() WHERE id = $1",
          [f.uPlain],
        ),
      ).toEqual(ok());
    });

    it('acc_app creates only an invited user with nothing else set', async () => {
      const insert = (columns: string, values: string) =>
        attempt(
          app,
          orgAdminA(),
          `INSERT INTO users (email, ${columns}) VALUES ('n-${suffix()}@example.test', ${values})`,
        );
      const shape = refused(
        '42501',
        'users_insert_invited_only',
        /users: an application principal may only create an invited user/,
      );
      expect(await insert('password_hash, status', "'h', 'active'")).toEqual(shape);
      expect(await insert('password_hash, status', "'h', 'invited'")).toEqual(shape);
      expect(await insert('status, password_updated_at', "'invited', now()")).toEqual(shape);
      expect(await insert('status, mfa_enabled', "'invited', true")).toEqual(shape);
      expect(await insert('status, mfa_secret_ref', "'invited', 'x'")).toEqual(shape);
      expect(await insert('status, last_login_at', "'invited', now()")).toEqual(shape);
      expect(await insert('status', "'disabled'")).toEqual(shape);
      // [+] The Drizzle-shaped invite: every column named, DEFAULT for the rest.
      expect(
        await attempt(
          app,
          orgAdminA(),
          `INSERT INTO users (id, email, phone, password_hash, password_updated_at, mfa_enabled,
             mfa_secret_ref, status, last_login_at, created_at, updated_at)
           VALUES (default, $1, NULL, default, default, default, default, 'invited', default, default, default)`,
          [`n-${suffix()}@example.test`],
        ),
      ).toEqual(ok());
    });

    it('api_keys: acc_app cannot rewrite scopes, hash, expiry or binding; [+] revokes; cannot un-revoke', async () => {
      for (const set of [
        `scopes = '["*"]'::jsonb`,
        "key_hash = 'x'",
        "expires_at = now() + interval '9 years'",
        'org_id = org_id',
        'name = name',
      ]) {
        expect(
          await attempt(app, orgAdminA(), `UPDATE api_keys SET ${set} WHERE id = $1`, [f.KA]),
        ).toEqual(denied('api_keys'));
      }
      expect(
        await attempt(
          app,
          orgAdminA(),
          "UPDATE api_keys SET revoked_at = now(), revoked_reason = 'revoked_by_admin', updated_at = now() WHERE id = $1",
          [f.KA],
        ),
      ).toEqual(ok());
      for (const set of ['revoked_at = NULL, revoked_reason = NULL', "revoked_reason = 'other'"]) {
        expect(
          await attempt(app, orgAdminA(), `UPDATE api_keys SET ${set} WHERE id = $1`, [f.KRevoked]),
        ).toEqual(
          refused(
            '42501',
            'api_keys_revocation_terminal',
            /api_keys: revocation of .* is terminal/,
          ),
        );
      }
    });

    it('api_keys: acc_auth only records use', async () => {
      expect(
        await attempt(auth, null, 'UPDATE api_keys SET last_used_at = now() WHERE id = $1', [f.KA]),
      ).toEqual(ok());
      for (const set of ['revoked_at = NULL', `scopes = '["*"]'::jsonb`]) {
        expect(
          await attempt(auth, null, `UPDATE api_keys SET ${set} WHERE id = $1`, [f.KRevoked]),
        ).toEqual(denied('api_keys'));
      }
    });

    it('ws_tickets: acc_app updates nothing; acc_auth only consumes', async () => {
      expect(
        await attempt(app, orgAdminA(), 'UPDATE ws_tickets SET consumed_at = now() WHERE id = $1', [
          f.TICKET,
        ]),
      ).toEqual(denied('ws_tickets'));
      expect(
        await attempt(
          auth,
          null,
          "UPDATE ws_tickets SET consumed_at = now(), consumed_ip = '10.0.0.1' WHERE id = $1",
          [f.TICKET],
        ),
      ).toEqual(ok());
      for (const set of ["expires_at = now() + interval '1 day'", 'user_id = user_id']) {
        expect(
          await attempt(auth, null, `UPDATE ws_tickets SET ${set} WHERE id = $1`, [f.TICKET]),
        ).toEqual(denied('ws_tickets'));
      }
    });
  });

  // ===========================================================================
  describe('B. tenant-key immutability and scope integrity (R-3)', () => {
    it('acc_app cannot move org_id or workspace_id on any table, under any context', async () => {
      for (const ctx of [resellerR(), superAdmin(), orgAdminA()]) {
        for (const [table, set, id] of [
          ['roles', 'org_id = $2', f.RA2],
          ['workspaces', 'org_id = $2', f.WA2],
          ['teams', 'org_id = $2', f.TA2],
          ['api_keys', 'org_id = $2', f.KA],
          ['idempotency_keys', 'org_id = $2', f.IK],
        ] as const) {
          expect(
            `${table}:${JSON.stringify(await attempt(app, ctx, `UPDATE ${table} SET ${set} WHERE id = $1`, [id, f.B]))}`,
          ).toBe(`${table}:${JSON.stringify(denied(table))}`);
        }
        expect(
          await attempt(app, ctx, 'UPDATE teams SET workspace_id = $2 WHERE id = $1', [
            f.TA2,
            f.WA2,
          ]),
        ).toEqual(denied('teams'));
        expect(
          await attempt(app, ctx, 'UPDATE api_keys SET workspace_id = $2 WHERE id = $1', [
            f.KW,
            f.WA2,
          ]),
        ).toEqual(denied('api_keys'));
      }
    });

    it('the owner cannot move them either — with or without a platform claim', async () => {
      const immutable = (table: string, column: string) =>
        refused('42501', `${table}_${column}_immutable`, new RegExp(`${table}: ${column} of row`));
      for (const ctx of [null, { platform: true, userId: f.uSup! }]) {
        expect(
          await attempt(owner, ctx, 'UPDATE roles SET org_id = $1 WHERE id = $2', [f.B, f.RA2]),
        ).toEqual(immutable('roles', 'org_id'));
        expect(
          await attempt(owner, ctx, 'UPDATE workspaces SET org_id = $1 WHERE id = $2', [
            f.B,
            f.WA2,
          ]),
        ).toEqual(immutable('workspaces', 'org_id'));
        // Both keys moved consistently, so the composite FK is satisfied and only
        // immutability refuses.
        expect(
          await attempt(
            owner,
            ctx,
            'UPDATE teams SET org_id = $1, workspace_id = $2 WHERE id = $3',
            [f.B, f.WB, f.TA2],
          ),
        ).toEqual(immutable('teams', 'org_id'));
        expect(
          await attempt(owner, ctx, 'UPDATE teams SET workspace_id = $1 WHERE id = $2', [
            f.WA2,
            f.TA2,
          ]),
        ).toEqual(immutable('teams', 'workspace_id'));
        expect(
          await attempt(owner, ctx, 'UPDATE api_keys SET org_id = $1 WHERE id = $2', [f.B, f.KA]),
        ).toEqual(immutable('api_keys', 'org_id'));
        expect(
          await attempt(owner, ctx, 'UPDATE api_keys SET workspace_id = $1 WHERE id = $2', [
            f.WA2,
            f.KW,
          ]),
        ).toEqual(immutable('api_keys', 'workspace_id'));
        expect(
          await attempt(owner, ctx, 'UPDATE api_keys SET workspace_id = NULL WHERE id = $1', [
            f.KW,
          ]),
        ).toEqual(immutable('api_keys', 'workspace_id'));
        expect(
          await attempt(owner, ctx, 'UPDATE idempotency_keys SET org_id = $1 WHERE id = $2', [
            f.B,
            f.IK,
          ]),
        ).toEqual(immutable('idempotency_keys', 'org_id'));
      }
      // [+] A no-op write of the key is not a move.
      expect(
        await attempt(owner, null, 'UPDATE roles SET org_id = org_id WHERE id = $1', [f.RA2]),
      ).toEqual(ok());
    });

    it('a team move the composite FK already rejects still reports 23503 first', async () => {
      expect(
        await attempt(owner, null, 'UPDATE teams SET org_id = $1 WHERE id = $2', [f.B, f.TA2]),
      ).toMatchObject({ code: '23503', constraint: 'teams_workspace_org_fk' });
    });

    it('acc_app cannot delete a team, update a grant or role permission, or delete an idempotency record', async () => {
      expect(await attempt(app, orgAdminA(), 'DELETE FROM teams WHERE id = $1', [f.TA2])).toEqual(
        denied('teams'),
      );
      expect(await attempt(app, superAdmin(), 'DELETE FROM teams WHERE id = $1', [f.TA2])).toEqual(
        denied('teams'),
      );
      for (const ctx of [orgAdminA(), superAdmin()]) {
        expect(
          await attempt(
            app,
            ctx,
            "UPDATE user_roles SET scope_type = 'workspace', scope_id = $1 WHERE user_id = $2 AND scope_type = 'organization'",
            [f.WA, f.uOrg],
          ),
        ).toEqual(denied('user_roles'));
        expect(
          await attempt(
            app,
            ctx,
            'UPDATE role_permissions SET role_id = role_id WHERE role_id = $1',
            [f.RA],
          ),
        ).toEqual(denied('role_permissions'));
        expect(
          await attempt(app, ctx, 'DELETE FROM idempotency_keys WHERE id = $1', [f.IK]),
        ).toEqual(denied('idempotency_keys'));
      }
      // [+] The idempotency claim columns remain writable.
      expect(
        await attempt(
          app,
          orgAdminA(),
          "UPDATE idempotency_keys SET status = 'completed', response_status_code = 201, completed_at = now() WHERE id = $1",
          [f.IK],
        ),
      ).toEqual(ok());
    });

    it('a team, workspace or reseller cannot be deleted while a grant is scoped to it — owner included', async () => {
      expect(await attempt(owner, null, 'DELETE FROM teams WHERE id = $1', [f.TA])).toEqual(
        refused(
          '23503',
          'user_roles_scope_id_team_fk',
          /teams: .* is still referenced by a role grant/,
        ),
      );
      expect(await attempt(owner, null, 'DELETE FROM workspaces WHERE id = $1', [f.WG])).toEqual(
        refused(
          '23503',
          'user_roles_scope_id_workspace_fk',
          /workspaces: .* is still referenced by a role grant/,
        ),
      );
      // R and R2 hold organizations (their own RESTRICT foreign key); a reseller
      // with only a grant shows the grant restriction alone.
      const lone = await plant(async (c) => {
        const r = await one(c, 'INSERT INTO resellers (name, slug) VALUES ($1, $2) RETURNING id', [
          'lone',
          `bs-lone-${tag}`,
        ]);
        await c.query(
          "INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) SELECT $1, id, 'reseller', $2 FROM roles WHERE key = 'reseller_admin' AND org_id IS NULL",
          [f.uRes, r],
        );
        return r;
      });
      try {
        expect(await attempt(owner, null, 'DELETE FROM resellers WHERE id = $1', [lone])).toEqual(
          refused(
            '23503',
            'user_roles_scope_id_reseller_fk',
            /resellers: .* is still referenced by a role grant/,
          ),
        );
      } finally {
        await plant(async (c) => {
          // The planted grant is the lone reseller's only administrator: its
          // removal is refused by migration 0030 unless the owner disables
          // the liveness trigger for this teardown statement.
          await c.query(
            'ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_reseller_admin_liveness',
          );
          await c.query("DELETE FROM user_roles WHERE scope_type = 'reseller' AND scope_id = $1", [
            lone,
          ]);
          await c.query(
            'ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_reseller_admin_liveness',
          );
          await c.query('DELETE FROM resellers WHERE id = $1', [lone]);
        });
      }
      // [+] Unreferenced parents still delete.
      expect(await attempt(owner, null, 'DELETE FROM teams WHERE id = $1', [f.TA2])).toEqual(ok());
      expect(await attempt(owner, null, 'DELETE FROM workspaces WHERE id = $1', [f.WA2])).toEqual(
        ok(),
      );
    });
  });

  // ===========================================================================
  describe('C. organization lifecycle, billing, reseller fields, provisioning (R-4)', () => {
    const lifecycleAuthority = refused(
      '42501',
      'organizations_lifecycle_authority',
      /requires platform\.tenants\.manage/,
    );
    const closedTerminal = refused(
      '42501',
      'organizations_closed_terminal',
      /organizations: organization .* is closed, which is terminal/,
    );
    const billingAuthority = refused(
      '42501',
      'organizations_billing_authority',
      /billing .*requires platform\.tenants\.manage/,
    );

    it('an organization administrator cannot reactivate its own suspended organization', async () => {
      expect(
        await attempt(
          app,
          { userId: f.uAb!, orgId: f.B! },
          "UPDATE organizations SET status = 'active', status_changed_at = now(), status_reason = NULL WHERE id = $1",
          [f.B],
        ),
      ).toEqual(lifecycleAuthority);
      expect(
        await attempt(
          app,
          { userId: f.uAb!, orgId: f.B! },
          "UPDATE organizations SET status = 'active' WHERE id = $1",
          [f.B],
        ),
      ).toEqual(lifecycleAuthority);
    });

    it('nor rewrite status metadata, nor change billing, nor the slug', async () => {
      expect(
        await attempt(
          app,
          orgAdminA(),
          "UPDATE organizations SET status_reason = 'x' WHERE id = $1",
          [f.A],
        ),
      ).toEqual(lifecycleAuthority);
      expect(
        await attempt(
          app,
          orgAdminA(),
          "UPDATE organizations SET billing_mode = 'postpaid' WHERE id = $1",
          [f.A],
        ),
      ).toEqual(billingAuthority);
      expect(
        await attempt(
          app,
          orgAdminA(),
          "UPDATE organizations SET billing_policy = 'charge_per_attempt' WHERE id = $1",
          [f.A],
        ),
      ).toEqual(billingAuthority);
      for (const ctx of [orgAdminA(), resellerR(), superAdmin(), tenantsManager()]) {
        expect(
          await attempt(app, ctx, `UPDATE organizations SET slug = 's-${suffix()}' WHERE id = $1`, [
            f.A,
          ]),
        ).toEqual(denied('organizations'));
      }
    });

    it('[+] organization configuration stays writable by the organization and reseller administrators', async () => {
      expect(
        await attempt(
          app,
          orgAdminA(),
          "UPDATE organizations SET name = 'A2', legal_name = 'Legal A', gstin = '27AAPFU0939F1ZV' WHERE id = $1",
          [f.A],
        ),
      ).toEqual(ok());
      expect(
        await attempt(
          app,
          resellerR(),
          "UPDATE organizations SET name = 'A3', legal_name = NULL, gstin = NULL WHERE id = $1",
          [f.A],
        ),
      ).toEqual(ok());
    });

    it('a reseller administrator cannot suspend, reopen or re-bill an organization', async () => {
      expect(
        await attempt(
          app,
          resellerR(),
          "UPDATE organizations SET status = 'suspended', status_changed_at = now() WHERE id = $1",
          [f.A],
        ),
      ).toEqual(lifecycleAuthority);
      expect(
        await attempt(
          app,
          resellerR(),
          "UPDATE organizations SET status = 'active' WHERE id = $1",
          [f.B],
        ),
      ).toEqual(lifecycleAuthority);
      expect(
        await attempt(
          app,
          resellerR(),
          "UPDATE organizations SET status = 'active' WHERE id = $1",
          [f.X],
        ),
      ).toEqual(closedTerminal);
      expect(
        await attempt(
          app,
          resellerR(),
          "UPDATE organizations SET billing_mode = 'postpaid' WHERE id = $1",
          [f.A],
        ),
      ).toEqual(billingAuthority);
    });

    it('support (platform read, no platform.tenants.manage) cannot change the lifecycle', async () => {
      expect(
        await attempt(
          app,
          support(),
          "UPDATE organizations SET status = 'suspended', status_changed_at = now() WHERE id = $1",
          [f.A],
        ),
      ).toEqual(lifecycleAuthority);
    });

    it('[+] platform.tenants.manage suspends, reactivates, closes and re-bills — with or without the super-admin role', async () => {
      for (const ctx of [superAdmin, tenantsManager]) {
        expect(
          await attempt(
            app,
            ctx(f.A),
            "UPDATE organizations SET status = 'suspended', status_changed_at = now(), status_reason = 'r' WHERE id = $1 AND status = 'active'",
            [f.A],
          ),
        ).toEqual(ok());
        expect(
          await attempt(
            app,
            ctx(f.B),
            "UPDATE organizations SET status = 'active', status_changed_at = now(), status_reason = NULL WHERE id = $1 AND status = 'suspended'",
            [f.B],
          ),
        ).toEqual(ok());
        expect(
          await attempt(
            app,
            ctx(f.B),
            "UPDATE organizations SET status = 'closed', status_changed_at = now() WHERE id = $1 AND status IN ('active', 'suspended')",
            [f.B],
          ),
        ).toEqual(ok());
        expect(
          await attempt(
            app,
            ctx(f.A),
            "UPDATE organizations SET billing_mode = 'postpaid', billing_policy = 'charge_per_attempt' WHERE id = $1",
            [f.A],
          ),
        ).toEqual(ok());
      }
      // The documented reseller move (migration 0014) stays a validated
      // platform-administrator capability.
      expect(
        await attempt(
          app,
          superAdmin(f.A),
          'UPDATE organizations SET reseller_id = $1 WHERE id = $2',
          [f.R2, f.A],
        ),
      ).toEqual(ok());
    });

    it('closed is terminal for every application principal, platform included', async () => {
      for (const ctx of [superAdmin(f.X), tenantsManager(f.X)]) {
        for (const set of [
          "status = 'active', status_changed_at = now()",
          "status = 'suspended', status_changed_at = now()",
          "status = 'closed', status_changed_at = now()",
          "name = 'reopened'",
          "billing_mode = 'postpaid'",
        ]) {
          expect(
            await attempt(app, ctx, `UPDATE organizations SET ${set} WHERE id = $1`, [f.X]),
          ).toEqual(closedTerminal);
        }
      }
      // acc_auth and acc_relay hold no UPDATE on organizations at all.
      for (const pool of [auth, relay]) {
        expect(
          await attempt(pool, null, "UPDATE organizations SET status = 'active' WHERE id = $1", [
            f.X,
          ]),
        ).toEqual(denied('organizations'));
      }
    });

    it('only the owner (migration/administrative tooling) may reopen a closed organization, for controlled teardown or recovery', async () => {
      // Decision 07-Oct-2026: closed is terminal for every application
      // principal; the owner keeps the exemption it has from RLS.
      for (const to of ['active', 'suspended']) {
        expect(
          await attempt(
            owner,
            null,
            'UPDATE organizations SET status = $1, status_changed_at = now() WHERE id = $2',
            [to, f.X],
          ),
        ).toEqual(ok());
      }
    });

    it('an illegal edge is a check violation: re-stamping the current status is not a transition', async () => {
      for (const [orgId, status] of [
        [f.A!, 'active'],
        [f.B!, 'suspended'],
      ] as const) {
        expect(
          await attempt(
            app,
            superAdmin(orgId),
            `UPDATE organizations SET status = '${status}', status_changed_at = now(), status_reason = 'again' WHERE id = $1`,
            [orgId],
          ),
        ).toEqual(
          refused(
            '23514',
            'organizations_status_transition',
            new RegExp(`illegal transition ${status} -> ${status}`),
          ),
        );
      }
    });

    it('reseller status, platform default and domain are platform-only; slug is never writable', async () => {
      const platformFields = refused(
        '42501',
        'resellers_platform_fields',
        /resellers: status, platform default, slug and domain of reseller .* are platform-administered/,
      );
      for (const set of [
        "status = 'suspended'",
        'is_platform_default = true',
        `domain = 'evil-${tag}.example'`,
      ]) {
        expect(
          await attempt(app, resellerR(), `UPDATE resellers SET ${set} WHERE id = $1`, [f.R]),
        ).toEqual(platformFields);
      }
      for (const ctx of [resellerR(), superAdmin()]) {
        expect(
          await attempt(app, ctx, `UPDATE resellers SET slug = 'x-${tag}' WHERE id = $1`, [f.R]),
        ).toEqual(denied('resellers'));
      }
      // [+] The reseller's own configuration stays its own.
      expect(
        await attempt(
          app,
          resellerR(),
          `UPDATE resellers SET default_markup_pct = 5, brand_config = '{"c": 1}', name = 'R!' WHERE id = $1`,
          [f.R],
        ),
      ).toEqual(ok());
      // [+] Platform sets reseller status (super admin, and the permission alone).
      expect(
        await attempt(
          app,
          superAdmin(),
          "UPDATE resellers SET status = 'suspended' WHERE id = $1",
          [f.R2],
        ),
      ).toEqual(ok());
    });

    it('a new organization starts active with no status history and default billing unless platform', async () => {
      const insert = (ctx: (id: string) => Ctx, reseller: string, extra = '', values = '') => {
        const id = uuidv7();
        return attempt(
          app,
          ctx(id),
          `INSERT INTO organizations (id, name, slug, reseller_id${extra}) VALUES ($1, 'n', $2, $3${values})`,
          [id, `bs-n-${suffix()}`, reseller],
        );
      };
      const asReseller = (id: string): Ctx => ({ ...resellerR(), orgId: id, provisioning: true });
      const asManager = (id: string): Ctx => ({ userId: f.uTm!, orgId: id, provisioning: true });
      const startsActive = refused(
        '42501',
        'organizations_insert_lifecycle',
        /a new organization starts active/,
      );
      expect(await insert(asReseller, f.R!, ', status', ", 'closed'")).toEqual(startsActive);
      expect(await insert(asReseller, f.R!, ', status', ", 'suspended'")).toEqual(startsActive);
      expect(await insert(asReseller, f.R!, ', status_reason', ", 'x'")).toEqual(startsActive);
      expect(await insert(asManager, f.R2!, ', status_changed_at', ', now()')).toEqual(
        startsActive,
      );
      expect(await insert(asReseller, f.R!, ', billing_mode', ", 'postpaid'")).toEqual(
        refused(
          '42501',
          'organizations_billing_authority',
          /non-default billing requires platform\.tenants\.manage/,
        ),
      );
      // [+] Platform may choose billing at creation.
      expect(await insert(asManager, f.R2!, ', billing_mode', ", 'postpaid'")).toEqual(ok());
    });

    it('provisioning binds reseller_id to the validated reseller claim unless platform.tenants.manage', async () => {
      const provision = (ctx: Ctx, reseller: string) =>
        attempt(
          app,
          ctx,
          `INSERT INTO organizations (id, reseller_id, name, slug, legal_name, gstin, billing_mode,
             billing_policy, status, created_at, updated_at, status_changed_at, status_reason)
           VALUES ($1, $2, 'n', $3, NULL, NULL, default, default, default, default, default, default, default)`,
          [ctx.orgId, reseller, `bs-p-${suffix()}`],
        );
      // An organization administrator (no reseller claim, no platform permission).
      expect(
        await provision({ userId: f.uOrg!, orgId: uuidv7(), provisioning: true }, f.R!),
      ).toEqual(rlsDenied('organizations'));
      // A reseller administrator naming another reseller.
      expect(
        await provision({ ...resellerR(), orgId: uuidv7(), provisioning: true }, f.R2!),
      ).toEqual(rlsDenied('organizations'));
      // An unvalidated reseller claim (the user holds no grant at R2).
      expect(
        await provision(
          { userId: f.uOrg!, resellerId: f.R2!, orgId: uuidv7(), provisioning: true },
          f.R2!,
        ),
      ).toEqual(rlsDenied('organizations'));
      // Support holds platform read, not platform.tenants.manage.
      expect(
        await provision({ userId: f.uSupport!, orgId: uuidv7(), provisioning: true }, f.R!),
      ).toEqual(rlsDenied('organizations'));
      // [+] Reseller administrator beneath its own reseller (Drizzle shape).
      expect(
        await provision({ ...resellerR(), orgId: uuidv7(), provisioning: true }, f.R!),
      ).toEqual(ok());
      // [+] platform.tenants.manage beneath any reseller, without the super-admin flag.
      expect(
        await provision({ userId: f.uTm!, orgId: uuidv7(), provisioning: true }, f.R2!),
      ).toEqual(ok());
      // [+] The validated super administrator.
      expect(await provision({ ...superAdmin(uuidv7()), provisioning: true }, f.R2!)).toEqual(ok());
    });
  });

  // ===========================================================================
  describe('D. transition parity with ORGANIZATION_TRANSITIONS', () => {
    const STATUSES: Status[] = ['active', 'suspended', 'closed'];
    const legal = (from: Status, to: Status) =>
      Object.values(ORGANIZATION_TRANSITIONS).some(
        (rule) => rule.to === to && (rule.from as readonly Status[]).includes(from),
      );

    it('for every (from, to) the database admits exactly the service’s transitions', async () => {
      const results: string[] = [];
      for (const from of STATUSES) {
        await plant((c) =>
          c.query(
            'UPDATE organizations SET status = $1, status_changed_at = NULL, status_reason = NULL WHERE id = $2',
            [from, f.P],
          ),
        );
        for (const to of STATUSES) {
          const outcome = await attempt(
            app,
            superAdmin(f.P),
            "UPDATE organizations SET status = $1, status_changed_at = now(), status_reason = 'parity' WHERE id = $2",
            [to, f.P],
          );
          const admitted = 'rows' in outcome && outcome.rows === 1;
          results.push(`${from}->${to}:${admitted}`);
          expect(`${from}->${to}:${admitted}`).toBe(`${from}->${to}:${legal(from, to)}`);
          if (!admitted) {
            expect(outcome).toMatchObject(
              from === 'closed'
                ? { code: '42501', constraint: 'organizations_closed_terminal' }
                : { code: '23514', constraint: 'organizations_status_transition' },
            );
          }
        }
      }
      // Exactly the four documented edges.
      expect(results.filter((r) => r.endsWith(':true')).sort()).toEqual([
        'active->closed:true',
        'active->suspended:true',
        'suspended->active:true',
        'suspended->closed:true',
      ]);
    });
  });

  // ===========================================================================
  describe('E. deterministic concurrency', () => {
    it('a reopen racing a close that got there first waits, then is refused by closed-terminal', async () => {
      const ctx = superAdmin(f.Q);
      const tx1 = await app.connect();
      const tx2 = await app.connect();
      try {
        await tx1.query('BEGIN');
        await applyCtx(tx1, ctx);
        const pid1 = (await tx1.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        const closed = await tx1.query(
          "UPDATE organizations SET status = 'closed', status_changed_at = now() WHERE id = $1 AND status IN ('active', 'suspended')",
          [f.Q],
        );
        expect(closed.rowCount).toBe(1);

        await tx2.query('BEGIN');
        await applyCtx(tx2, ctx);
        const pid2 = (await tx2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        const reopen = tx2
          .query(
            "UPDATE organizations SET status = 'active', status_changed_at = now(), status_reason = NULL WHERE id = $1",
            [f.Q],
          )
          .then(
            (r) => ({ rows: r.rowCount ?? 0 }),
            (e: PgError) => ({ code: e.code, constraint: e.constraint ?? null }),
          );

        // tx2 is blocked behind tx1 — observed, not assumed.
        let waited = false;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !waited) {
          const { rows } = await owner.query<{ blocked: boolean }>(
            'SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS blocked',
            [pid1, pid2],
          );
          waited = rows[0]!.blocked;
          if (!waited) await new Promise((r) => setTimeout(r, 25));
        }
        expect(waited).toBe(true);

        await tx1.query('COMMIT');
        expect(await reopen).toEqual({
          code: '42501',
          constraint: 'organizations_closed_terminal',
        });
        await tx2.query('ROLLBACK');
        const { rows } = await owner.query('SELECT status FROM organizations WHERE id = $1', [f.Q]);
        expect(rows[0].status).toBe('closed');
      } finally {
        await tx1.query('ROLLBACK').catch(() => undefined);
        await tx2.query('ROLLBACK').catch(() => undefined);
        tx1.release();
        tx2.release();
      }
    });
  });

  // ===========================================================================
  describe('F. the verification block refuses bad data before anything is applied', () => {
    /** The migration's first statement, executed verbatim. */
    const verification = () => {
      const block = readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')[0]!;
      const start = block.indexOf('DO $$');
      expect(start).toBeGreaterThan(-1);
      return block.slice(start);
    };
    const asOwner = async (work: (c: PoolClient) => Promise<void>) => {
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.is_platform_admin', 'on', true)");
        await work(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    const failure = async (c: PoolClient): Promise<PgError> => {
      try {
        await c.query(verification());
      } catch (error) {
        return error as PgError;
      }
      throw new Error('expected the verification to refuse');
    };

    it('passes on the current database', async () => {
      await asOwner(async (c) => {
        await c.query(verification());
      });
    });

    it('names a grant whose team is gone', async () => {
      await asOwner(async (c) => {
        await c.query('ALTER TABLE teams DISABLE TRIGGER trg_teams_grant_restrict');
        await c.query('DELETE FROM teams WHERE id = $1', [f.TA]);
        const err = await failure(c);
        expect(err.code).toBe('23503');
        expect(err.message).toMatch(
          /migration 0025 verification failed \[user_roles_scope_parent_exists\]: 1 role grants/,
        );
      });
    });

    it('names a grant whose org_id disagrees with its scope', async () => {
      await asOwner(async (c) => {
        await c.query('ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_validate_scope');
        const { rows } = await c.query(
          `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id, org_id)
           VALUES ($1, $2, 'workspace', $3, $4) RETURNING id`,
          [f.uPlain, f.RA, f.WB, f.A],
        );
        const err = await failure(c);
        expect(err.code).toBe('23514');
        expect(err.message).toMatch(/\[user_roles_scope_org_consistent\]: 1 role grants/);
        expect(err.message).toContain(rows[0]!.id);
      });
    });

    it('names more than one platform-default reseller', async () => {
      await asOwner(async (c) => {
        await c.query('DROP INDEX resellers_single_platform_default');
        await c.query(
          'UPDATE resellers SET is_platform_default = true WHERE id = ANY($1::uuid[])',
          [[f.R, f.R2]],
        );
        const err = await failure(c);
        expect(err.code).toBe('23514');
        expect(err.message).toMatch(/\[resellers_single_platform_default\]: \d+ resellers/);
      });
    });
  });
});
