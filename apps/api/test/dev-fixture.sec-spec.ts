/**
 * Phase 1C.4a — the deterministic development/test fixture (`TESTING.md` §6r).
 *
 * The fixture is itself a security test asset, so this suite proves both that
 * it builds exactly the frozen topology through the real paths and that the
 * topology it builds is actually isolated:
 *
 *   A  environment gate and secret handling — refused before anything is written
 *   B  refusal of conflicting pre-existing state, from an empty fixture
 *   C  the first run: topology, identities, grants, parent/child, real login
 *   D  idempotence — a second run (and the real CLI) is a byte-identical no-op
 *   E  the real paths: authentication, role assignment, audit (with markup)
 *   F  isolation over HTTP: detail and list endpoints, same- and cross-reseller
 *   G  low privilege, multi-organization reach, platform-scope escalation
 *   H  RLS as `acc_app`, principal privileges, no HTTP route
 *   I  refusal of conflicting state on an existing fixture
 *
 * The suite refuses to start when any fixture object (or a platform
 * administrator) already exists, so it can never adopt or tear down a
 * developer's fixture; it removes everything it created in `afterAll`.
 * Mutation runs use `scripts/with-db-clone.mjs` only.
 */
import { ERROR_CODES, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { type TenantSession } from '@acc/db';
import { sql } from 'drizzle-orm';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import request from 'supertest';

import { digestLines, fixtureLines } from '../src/cli/dev-fixture/inspect';
import { runDevFixture, type FixtureManifest } from '../src/cli/dev-fixture/run';
import {
  FIXTURE_USER_AGENT,
  MARKUP_PAYLOAD,
  ORGANIZATIONS,
  RESELLERS,
  TEAM,
  USER_REFS,
  USERS,
  type OrgRef,
  type UserRef,
} from '../src/cli/dev-fixture/topology';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { PASSWORD, PREFIX, startHarness, type Harness } from './auth-harness';

jest.setTimeout(180_000);

const API_ROOT = resolve(__dirname, '..');
const SUITE_USER_AGENT = 'acc-dev-fixture-suite';
const OPERATOR = 'dev-fixture-operator@example.test';
const OPERATOR_PASSWORD = `op-${randomBytes(24).toString('hex')}`;
const USER_PASSWORD = `fx-${randomBytes(24).toString('hex')}`;

/**
 * The logical fingerprint of the frozen topology: natural keys only, no ids.
 * Identical on every database the fixture runs on; a change to the topology
 * (or to the reseller B1 hangs under) changes it.
 */
const GOLDEN_LOGICAL_FINGERPRINT =
  '82fe0a6cd741900b7010385346e783463d7d2506078bc9c83c9bf71d36f9796f';

/** Known non-secret strings in this repository that must authenticate no fixture user. */
const KNOWN_DEFAULTS = [
  PASSWORD,
  'local-development-only-passphrase-not-a-secret',
  'change-me-a-long-development-only-passphrase',
];

function fixtureEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: 'test',
    NODE_ENV: 'test',
    SECRETS_BACKEND: 'env',
    AUTH_BOOTSTRAP_EMAIL: OPERATOR,
    AUTH_BOOTSTRAP_PASSWORD_REF: 'env:ACC_FIXTURE_SUITE_OPERATOR_PASSWORD',
    ACC_FIXTURE_USER_PASSWORD_REF: 'env:ACC_FIXTURE_SUITE_USER_PASSWORD',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Runs the real CLI entry point (`src/cli/dev-fixture.ts`) in a child process. */
function runCli(env: NodeJS.ProcessEnv) {
  const result = spawnSync(
    process.execPath,
    [resolve(API_ROOT, '../../node_modules/tsx/dist/cli.mjs'), 'src/cli/dev-fixture.ts'],
    { cwd: API_ROOT, env, encoding: 'utf8', timeout: 120_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sourcesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourcesOf(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const FIXTURE_SOURCES = [
  resolve(API_ROOT, 'src/cli/dev-fixture.ts'),
  ...sourcesOf(resolve(API_ROOT, 'src/cli/dev-fixture')),
];

describe('Phase 1C.4a development/test fixture', () => {
  let h: Harness;
  let tenantDb: TenantDatabase;
  let manifest: FixtureManifest;
  const logs: string[] = [];
  const tokens: Partial<Record<UserRef, string>> = {};

  const url = (p: string) => `/${PREFIX}${p}`;
  const q = async <T = Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await h.admin.execute(query)).rows as T[];

  /** Every table's full content, hashed: the strongest "nothing changed" there is. */
  async function databaseHash(): Promise<string> {
    const tables = await q<{ name: string }>(
      sql`SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
           WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
    );
    const parts: string[] = [];
    for (const { name } of tables) {
      const [row] = await q<{ h: string }>(
        sql.raw(
          `SELECT '${name}:' || count(*) || ':' || md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS h FROM ${name} t`,
        ),
      );
      parts.push(row!.h);
    }
    return parts.join('|');
  }

  async function rowCounts(): Promise<Record<string, number>> {
    const tables = await q<{ name: string }>(
      sql`SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
           WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
    );
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const [row] = await q<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${name}`));
      counts[name] = row!.n;
    }
    return counts;
  }

  async function privilegeSnapshot(): Promise<string> {
    const rows = await q(
      sql`SELECT 'table' AS k, grantee::text AS who, table_name::text AS what, privilege_type::text AS how
            FROM information_schema.role_table_grants WHERE grantee IN ('acc_app','acc_auth','acc_relay')
          UNION ALL
          SELECT 'role', rolname::text, '', concat_ws(',', rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit)
            FROM pg_roles WHERE rolname IN ('acc_app','acc_auth','acc_relay')
          UNION ALL
          SELECT 'member', m.rolname::text, r.rolname::text, ''
            FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
           WHERE m.rolname IN ('acc_app','acc_auth','acc_relay')
          ORDER BY 1, 2, 3, 4`,
    );
    return JSON.stringify(rows);
  }

  const fixtureOrgIds = () => Object.values(manifest.organizations).map((o) => o.id);

  async function login(email: string, password: string) {
    await h.clearRateLimits();
    return request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .set('user-agent', SUITE_USER_AGENT)
      .send({ email, password });
  }

  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    token: string,
    path: string,
    org?: string,
  ) => {
    let r = request(h.app.getHttpServer())
      [method](url(path))
      .set('user-agent', SUITE_USER_AGENT)
      .set('authorization', `Bearer ${token}`);
    if (org) r = r.set('x-acc-organization', org);
    return r;
  };

  const idsOf = (res: request.Response) =>
    ((res.body as { data: { id: string }[] }).data ?? []).map((item) => item.id);

  /** Every id a list endpoint enumerates, across every page. */
  async function listAll(token: string, path: string, org?: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const res: request.Response = await call(
        'get',
        token,
        `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        org,
      ).expect(200);
      ids.push(...idsOf(res));
      cursor = (res.body as { page?: { nextCursor: string | null } }).page?.nextCursor ?? null;
    } while (cursor);
    return ids;
  }

  /** Removes everything the fixture (and this suite) created, by natural key. */
  async function removeFixture(): Promise<void> {
    const orgSlugs = Object.values(ORGANIZATIONS).map((o) => o.slug);
    const emails = [...USER_REFS.map((r) => USERS[r].email), OPERATOR];
    const orgs = (
      await q<{ id: string }>(
        sql`SELECT id FROM organizations WHERE slug IN (${sql.join(
          orgSlugs.map((s) => sql`${s}`),
          sql`, `,
        )})
              OR reseller_id IN (SELECT id FROM resellers WHERE slug = ${RESELLERS.B.slug})`,
      )
    ).map((r) => r.id);
    const users = (
      await q<{ id: string }>(
        sql`SELECT id FROM users WHERE lower(email) IN (${sql.join(
          emails.map((e) => sql`${e.toLowerCase()}`),
          sql`, `,
        )})`,
      )
    ).map((r) => r.id);
    const orgList = orgs.length
      ? sql.join(
          orgs.map((id) => sql`${id}::uuid`),
          sql`, `,
        )
      : sql`NULL::uuid`;
    const userList = users.length
      ? sql.join(
          users.map((id) => sql`${id}::uuid`),
          sql`, `,
        )
      : sql`NULL::uuid`;

    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`);
      await tx.execute(
        sql`DELETE FROM audit_logs WHERE org_id IN (${orgList}) OR actor_user_id IN (${userList})
              OR resource_id IN (${userList})
              OR reseller_id IN (SELECT id FROM resellers WHERE slug = ${RESELLERS.B.slug})
              OR user_agent IN (${FIXTURE_USER_AGENT}, ${SUITE_USER_AGENT})`,
      );
      await tx.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_reseller_admin_liveness`,
      );
      await tx.execute(sql`DELETE FROM sessions WHERE user_id IN (${userList})`);
      await tx.execute(
        sql`DELETE FROM user_roles WHERE (user_id IN (${userList}) OR org_id IN (${orgList}))
              AND NOT (scope_type = 'organization' AND org_id IN (${orgList}))`,
      );
      for (const table of ['ws_tickets', 'api_keys', 'idempotency_keys', 'teams', 'workspaces']) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${orgList})`);
      }
      // The organizations before their users: organization-scope grants, roles
      // and role permissions cascade with them — the exemption of the
      // last-organization-administrator rule (migration 0028).
      await tx.execute(sql`DELETE FROM organizations WHERE id IN (${orgList})`);
      await tx.execute(
        sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_reseller_admin_liveness`,
      );
      await tx.execute(
        sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      await tx.execute(sql`DELETE FROM users WHERE id IN (${userList})`);
      await tx.execute(sql`DELETE FROM organizations WHERE id IN (${orgList})`);
      await tx.execute(sql`DELETE FROM resellers WHERE slug = ${RESELLERS.B.slug}`);
    });
  }

  async function expectRefusedUnchanged(env: NodeJS.ProcessEnv, message: RegExp): Promise<void> {
    const before = await databaseHash();
    await expect(runDevFixture(env)).rejects.toThrow(message);
    expect(await databaseHash()).toBe(before);
  }

  let privilegesBefore: string;

  beforeAll(async () => {
    process.env.ACC_FIXTURE_SUITE_OPERATOR_PASSWORD = OPERATOR_PASSWORD;
    process.env.ACC_FIXTURE_SUITE_USER_PASSWORD = USER_PASSWORD;
    h = await startHarness();
    tenantDb = h.app.get(TenantDatabase);

    // Never adopt or tear down state this suite did not create.
    const existing = await fixtureLines(h.admin, { withIds: false });
    const foreign = existing.filter((l) => !l.startsWith(`reseller ${RESELLERS.A.slug} `));
    const admins = await q(
      sql`SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE r.org_id IS NULL AND r.key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN}`,
    );
    const operator = await q(sql`SELECT 1 FROM users WHERE lower(email) = ${OPERATOR}`);
    if (foreign.length > 0 || admins.length > 0 || operator.length > 0) {
      throw new Error(
        'dev-fixture suite: this database already holds fixture objects or a platform administrator; ' +
          'run it on a fresh or cloned test database (scripts/with-db-clone.mjs)',
      );
    }
    privilegesBefore = await privilegeSnapshot();
  });

  afterAll(async () => {
    if (h) {
      try {
        await removeFixture();
      } finally {
        await h.close();
      }
    }
    delete process.env.ACC_FIXTURE_SUITE_OPERATOR_PASSWORD;
    delete process.env.ACC_FIXTURE_SUITE_USER_PASSWORD;
  });

  // --- A. environment gate and secrets -------------------------------------

  describe('A. environment gate and secret handling (nothing written on refusal)', () => {
    it.each(['production', 'staging', 'prod', 'Development', ''])(
      'the real CLI refuses APP_ENV=%j before touching the database',
      async (appEnv) => {
        const before = await databaseHash();
        const result = runCli(fixtureEnv({ APP_ENV: appEnv }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`refusing to run with APP_ENV=${JSON.stringify(appEnv)}`);
        expect(result.stdout).toBe('');
        expect(await databaseHash()).toBe(before);
      },
    );

    it('refuses an unset APP_ENV and NODE_ENV=production in-process', async () => {
      await expectRefusedUnchanged(fixtureEnv({ APP_ENV: undefined }), /APP_ENV=<unset>/);
      await expectRefusedUnchanged(fixtureEnv({ NODE_ENV: 'production' }), /NODE_ENV=production/);
    });

    it('refuses a missing, unresolvable, short or foreign-backend password reference', async () => {
      await expectRefusedUnchanged(
        fixtureEnv({ ACC_FIXTURE_USER_PASSWORD_REF: undefined }),
        /ACC_FIXTURE_USER_PASSWORD_REF must be set.*no default/,
      );
      await expectRefusedUnchanged(
        fixtureEnv({ ACC_FIXTURE_USER_PASSWORD_REF: '' }),
        /ACC_FIXTURE_USER_PASSWORD_REF must be set/,
      );
      await expectRefusedUnchanged(
        fixtureEnv({ ACC_FIXTURE_USER_PASSWORD_REF: 'env:ACC_FIXTURE_SUITE_UNSET_VARIABLE' }),
        /ACC_FIXTURE_SUITE_UNSET_VARIABLE is not set/,
      );
      process.env.ACC_FIXTURE_SUITE_SHORT = 'too-short';
      try {
        await expectRefusedUnchanged(
          fixtureEnv({ ACC_FIXTURE_USER_PASSWORD_REF: 'env:ACC_FIXTURE_SUITE_SHORT' }),
          /shorter than the 32-character minimum/,
        );
      } finally {
        delete process.env.ACC_FIXTURE_SUITE_SHORT;
      }
      await expectRefusedUnchanged(
        fixtureEnv({ ACC_FIXTURE_USER_PASSWORD_REF: 'vault:secret/acc/fixture' }),
        /"env" secrets backend/,
      );
      await expectRefusedUnchanged(
        fixtureEnv({ SECRETS_BACKEND: 'vault' }),
        /SECRETS_BACKEND="vault"/,
      );
      await expectRefusedUnchanged(
        fixtureEnv({ AUTH_BOOTSTRAP_PASSWORD_REF: undefined }),
        /AUTH_BOOTSTRAP_PASSWORD_REF must be set/,
      );
      await expectRefusedUnchanged(
        fixtureEnv({ AUTH_BOOTSTRAP_EMAIL: undefined }),
        /AUTH_BOOTSTRAP_EMAIL must be set/,
      );
    });

    it('refuses a fixture password equal to the platform administrator password', async () => {
      await expectRefusedUnchanged(
        fixtureEnv({ ACC_FIXTURE_USER_PASSWORD_REF: 'env:ACC_FIXTURE_SUITE_OPERATOR_PASSWORD' }),
        /never share the platform credential/,
      );
    });

    it('never prints a resolved secret in a refusal', () => {
      const result = runCli(
        fixtureEnv({ ACC_FIXTURE_USER_PASSWORD_REF: 'env:ACC_FIXTURE_SUITE_OPERATOR_PASSWORD' }),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('never share the platform credential');
      for (const secret of [OPERATOR_PASSWORD, USER_PASSWORD]) {
        expect(result.stderr).not.toContain(secret);
        expect(result.stdout).not.toContain(secret);
      }
    });
  });

  // --- B. conflicting state before any fixture exists -----------------------

  describe('B. an invalid reseller/organization relationship is refused before anything is written', () => {
    it('refuses B1 pre-existing under Reseller A — not even the bootstrap runs', async () => {
      const [a] = await q<{ id: string }>(
        sql`SELECT id FROM resellers WHERE slug = ${RESELLERS.A.slug}`,
      );
      await h.admin.execute(
        sql`INSERT INTO organizations (name, slug, reseller_id) VALUES (${ORGANIZATIONS.B1.name}, ${ORGANIZATIONS.B1.slug}, ${a!.id})`,
      );
      try {
        await expectRefusedUnchanged(
          fixtureEnv(),
          /acc-fixture-b1 exists under a different reseller.*never moves/s,
        );
        expect(await q(sql`SELECT 1 FROM users WHERE lower(email) = ${OPERATOR}`)).toHaveLength(0);
      } finally {
        await h.admin.execute(sql`DELETE FROM organizations WHERE slug = ${ORGANIZATIONS.B1.slug}`);
      }
    });
  });

  // --- C. the first run -----------------------------------------------------

  describe('C. the first run builds exactly the frozen topology', () => {
    let firstRunError: unknown;
    let countsBefore: Record<string, number>;
    let countsAfter: Record<string, number>;

    beforeAll(async () => {
      countsBefore = await rowCounts();
      // A failed run is recorded, not thrown, so each invariant below is still
      // asserted against whatever the run left in the database — a mutant that
      // makes the run fail must also fail the invariant it violates.
      try {
        manifest = await runDevFixture(fixtureEnv(), (line) => logs.push(line));
      } catch (error) {
        firstRunError = error;
      }
      countsAfter = await rowCounts();
    });

    it('completes without a refusal', () => {
      expect(firstRunError).toBeUndefined();
    });

    it('changes exactly the documented row counts (a creating run writes data by design)', () => {
      const delta = Object.fromEntries(
        Object.keys(countsAfter)
          .map((t) => [t, countsAfter[t]! - (countsBefore[t] ?? 0)] as const)
          .filter(([, d]) => d !== 0),
      );
      expect(delta).toEqual({
        'public.resellers': 1,
        'public.organizations': 3,
        'public.workspaces': 3,
        'public.teams': 1,
        'public.roles': 15,
        'public.role_permissions': 174,
        // Five fixture users and the bootstrap operator.
        'public.users': 6,
        // Six fixture grants through the API, one platform grant by the bootstrap.
        'public.user_roles': 7,
        // The operator's single sign-in: one session, revoked at sign-out.
        'public.sessions': 1,
        'public.audit_logs': 37,
      });
    });

    it('reports a created fixture whose logical fingerprint is the pinned, database-independent one', async () => {
      expect(manifest.outcome).toBe('created');
      expect(manifest.fingerprint.logical).toBe(GOLDEN_LOGICAL_FINGERPRINT);
      expect(digestLines(await fixtureLines(h.admin, { withIds: false }))).toBe(
        GOLDEN_LOGICAL_FINGERPRINT,
      );
    });

    it('holds exactly the expected resellers, organizations, workspaces and team (natural keys)', async () => {
      const lines = await fixtureLines(h.admin, { withIds: false });
      expect(lines.filter((l) => !l.startsWith('user ') && !l.startsWith('grant '))).toEqual([
        `reseller ${RESELLERS.B.slug} "${RESELLERS.B.name}" active default=false`,
        `reseller ${RESELLERS.A.slug} "Alendei Direct" active default=true`,
        `organization acc-fixture-a1 "ACC Fixture A1" active reseller=${RESELLERS.A.slug}`,
        `organization acc-fixture-a2 "ACC Fixture A2" active reseller=${RESELLERS.A.slug}`,
        `organization acc-fixture-b1 "ACC Fixture B1" active reseller=${RESELLERS.B.slug}`,
        'workspace acc-fixture-a1/default "Default" active default=true',
        'workspace acc-fixture-a2/default "Default" active default=true',
        'workspace acc-fixture-b1/default "Default" active default=true',
        `team acc-fixture-a1/default "${TEAM.name}" active`,
      ]);
    });

    it('holds every expected user, active with a credential, and exactly the expected grants', async () => {
      const lines = await fixtureLines(h.admin, { withIds: false });
      expect(lines.filter((l) => l.startsWith('user '))).toEqual(
        USER_REFS.map((r) => `user ${USERS[r].email} active credential=set`).sort(),
      );
      expect(lines.filter((l) => l.startsWith('grant '))).toEqual(
        [
          'grant a1-admin@acc-fixture.test org_admin@acc-fixture-a1 organization:acc-fixture-a1',
          `grant a1-team-reader@acc-fixture.test read_only@acc-fixture-a1 team:acc-fixture-a1/${TEAM.name}`,
          'grant a2-admin@acc-fixture.test org_admin@acc-fixture-a2 organization:acc-fixture-a2',
          'grant b1-admin@acc-fixture.test org_admin@acc-fixture-b1 organization:acc-fixture-b1',
          'grant multi-org@acc-fixture.test workspace_manager@acc-fixture-a1 organization:acc-fixture-a1',
          'grant multi-org@acc-fixture.test workspace_manager@acc-fixture-a2 organization:acc-fixture-a2',
        ].sort(),
      );
    });

    it('has valid parent/child relationships and reseller ownership (checked by id)', async () => {
      const orgs = await q<{ slug: string; reseller: string }>(
        sql`SELECT o.slug, r.slug AS reseller FROM organizations o JOIN resellers r ON r.id = o.reseller_id
             WHERE o.id IN (${sql.join(
               fixtureOrgIds().map((id) => sql`${id}`),
               sql`, `,
             )}) ORDER BY o.slug`,
      );
      expect(orgs).toEqual([
        { slug: 'acc-fixture-a1', reseller: RESELLERS.A.slug },
        { slug: 'acc-fixture-a2', reseller: RESELLERS.A.slug },
        { slug: 'acc-fixture-b1', reseller: RESELLERS.B.slug },
      ]);
      expect(manifest.organizations.A1.id).not.toBe(manifest.organizations.A2.id);
      const [team] = await q<{ org_id: string; workspace_id: string }>(
        sql`SELECT org_id, workspace_id FROM teams WHERE id = ${manifest.team.id}`,
      );
      expect(team).toEqual({
        org_id: manifest.organizations.A1.id,
        workspace_id: manifest.organizations.A1.defaultWorkspaceId,
      });
      // Every granted role belongs to the organization the grant is in.
      const mismatched = await q(
        sql`SELECT ur.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id IN (${sql.join(
               USER_REFS.map((u) => sql`${manifest.users[u].id}`),
               sql`, `,
             )})
               AND (r.org_id IS DISTINCT FROM ur.org_id OR ur.org_id IS NULL)`,
      );
      expect(mismatched).toEqual([]);
    });

    it('grants no fixture user platform or reseller scope, and adds no other platform administrator', async () => {
      // By natural key, independent of the run's outcome and of its manifest.
      const elevated = await q<{ email: string; role: string; scope_type: string }>(
        sql`SELECT lower(u.email) AS email, r.key AS role, ur.scope_type::text AS scope_type
              FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
             WHERE lower(u.email) LIKE ${'%@acc-fixture.test'}
               AND (ur.scope_type IN ('platform', 'reseller') OR r.org_id IS NULL)`,
      );
      expect(elevated).toEqual([]);
      const holders = await q<{ email: string; role: string; scope_type: string }>(
        sql`SELECT lower(u.email) AS email, r.key AS role, ur.scope_type::text AS scope_type
              FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
             WHERE r.org_id IS NULL ORDER BY 1, 2`,
      );
      expect(holders).toEqual([
        { email: OPERATOR, role: PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN, scope_type: 'platform' },
      ]);
    });

    it('signs in every fixture user through the real login path with the configured password only', async () => {
      for (const ref of USER_REFS) {
        const res = await login(USERS[ref].email, USER_PASSWORD);
        expect(res.status).toBe(200);
        tokens[ref] = (res.body as { data: { accessToken: string } }).data.accessToken;
      }
    });

    it('accepts no known default password for any fixture user', async () => {
      for (const ref of USER_REFS) {
        for (const candidate of [...KNOWN_DEFAULTS, OPERATOR_PASSWORD]) {
          expect((await login(USERS[ref].email, candidate)).status).toBe(401);
        }
      }
    });

    it('leaves no live session and no credential material in its output', async () => {
      const sessions = await q<{ revoked: boolean }>(
        sql`SELECT revoked_at IS NOT NULL AS revoked FROM sessions WHERE user_id = ${manifest.operator.id}`,
      );
      expect(sessions).toEqual([{ revoked: true }]);
      const output = JSON.stringify(manifest) + logs.join('\n');
      for (const secret of [OPERATOR_PASSWORD, USER_PASSWORD, '$argon2']) {
        expect(output).not.toContain(secret);
      }
      expect(manifest.credentials).toEqual({ passwordReference: 'ACC_FIXTURE_USER_PASSWORD_REF' });
    });
  });

  // --- D. idempotence ---------------------------------------------------------

  describe('D. a second run is a no-op', () => {
    it('in-process: outcome "unchanged", every table byte-identical, same identities', async () => {
      const before = await databaseHash();
      const identity = digestLines(await fixtureLines(h.admin, { withIds: true }));
      const second = await runDevFixture(fixtureEnv());
      expect(second.outcome).toBe('unchanged');
      expect(second.fingerprint).toEqual(manifest.fingerprint);
      expect(second.fingerprint.identity).toBe(identity);
      expect(second.users).toEqual(manifest.users);
      expect(second.organizations).toEqual(manifest.organizations);
      expect(await databaseHash()).toBe(before);
    });

    it('through the real CLI: exit 0, a JSON manifest on stdout, no secret anywhere, nothing changed', async () => {
      const before = await databaseHash();
      const result = runCli(fixtureEnv());
      expect(result.status).toBe(0);
      const printed = JSON.parse(result.stdout) as FixtureManifest;
      expect(printed.outcome).toBe('unchanged');
      expect(printed.fingerprint).toEqual(manifest.fingerprint);
      for (const secret of [OPERATOR_PASSWORD, USER_PASSWORD, '$argon2']) {
        expect(result.stdout + result.stderr).not.toContain(secret);
      }
      expect(await databaseHash()).toBe(before);
    });
  });

  // --- E. the real paths --------------------------------------------------------

  describe('E. every tenant object and grant was made through the real API and audited by it', () => {
    let runCorrelations: string[];

    beforeAll(async () => {
      runCorrelations = (
        await q<{ correlation_id: string }>(
          sql`SELECT correlation_id FROM audit_logs WHERE action = 'auth.login.succeeded'
                AND actor_user_id = ${manifest.operator.id} AND user_agent = ${FIXTURE_USER_AGENT}`,
        )
      ).map((r) => r.correlation_id);
    });

    it('the operator signed in once, through the real login, and signed out', async () => {
      expect(runCorrelations).toHaveLength(1);
      const logout = await q(
        sql`SELECT 1 FROM audit_logs WHERE action = 'auth.logout' AND actor_user_id = ${manifest.operator.id}
              AND correlation_id = ${runCorrelations[0]!}`,
      );
      expect(logout).toHaveLength(1);
    });

    it('each organization, the team and each user has its creation audit row from that signed-in request chain', async () => {
      const expected: [string, string][] = [
        ...Object.values(manifest.organizations).map(
          (o) => ['organization.created', o.id] as [string, string],
        ),
        ['team.created', manifest.team.id],
        ...USER_REFS.map((r) => ['user.invited', manifest.users[r].id] as [string, string]),
      ];
      for (const [action, resourceId] of expected) {
        const rows = await q<Record<string, unknown>>(
          sql`SELECT actor_type::text AS actor_type, actor_user_id, user_agent, host(ip) AS ip, correlation_id
                FROM audit_logs WHERE action = ${action} AND resource_id = ${resourceId}`,
        );
        expect(rows).toEqual([
          {
            actor_type: 'user',
            actor_user_id: manifest.operator.id,
            user_agent: FIXTURE_USER_AGENT,
            ip: '127.0.0.1',
            correlation_id: runCorrelations[0],
          },
        ]);
      }
    });

    it('every fixture grant has exactly one user_role.granted row from the role-assignment path', async () => {
      const grants = await q<{ id: string; scope_type: string; org_id: string }>(
        sql`SELECT id, scope_type::text AS scope_type, org_id FROM user_roles
             WHERE user_id IN (${sql.join(
               USER_REFS.map((u) => sql`${manifest.users[u].id}`),
               sql`, `,
             )})`,
      );
      expect(grants).toHaveLength(6);
      for (const grant of grants) {
        const rows = await q<Record<string, unknown>>(
          sql`SELECT actor_user_id, user_agent, correlation_id, scope_type::text AS scope_type, org_id
                FROM audit_logs WHERE action = 'user_role.granted' AND resource_id = ${grant.id}`,
        );
        expect(rows).toEqual([
          {
            actor_user_id: manifest.operator.id,
            user_agent: FIXTURE_USER_AGENT,
            correlation_id: runCorrelations[0],
            scope_type: grant.scope_type,
            org_id: grant.org_id,
          },
        ]);
      }
    });

    it('at least one audit record exists per organization, at that organization', async () => {
      for (const org of Object.values(manifest.organizations)) {
        const rows = await q<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${org.id}
                AND scope_type IN ('organization','workspace','team')`,
        );
        expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
      }
    });

    it('the markup-bearing team.created row is at team scope in A1 and stores the payload verbatim', async () => {
      const rows = await q<Record<string, unknown>>(
        sql`SELECT scope_type::text AS scope_type, org_id, workspace_id, team_id, after, metadata
              FROM audit_logs WHERE action = 'team.created' AND resource_id = ${manifest.team.id}`,
      );
      expect(rows).toEqual([
        {
          scope_type: 'team',
          org_id: manifest.organizations.A1.id,
          workspace_id: manifest.organizations.A1.defaultWorkspaceId,
          team_id: manifest.team.id,
          // Exactly what TeamAdministrationService writes, nothing more or less.
          after: {
            orgId: manifest.organizations.A1.id,
            workspaceId: manifest.organizations.A1.defaultWorkspaceId,
            name: TEAM.name,
          },
          metadata: {},
        },
      ]);
      expect(TEAM.name).toContain(MARKUP_PAYLOAD);
    });

    it('the A1 administrator reads that row through the real audit API; A2 and B1 cannot', async () => {
      const [row] = await q<{ id: string }>(
        sql`SELECT id FROM audit_logs WHERE action = 'team.created' AND resource_id = ${manifest.team.id}`,
      );
      const own = await call('get', tokens.a1Admin!, `/audit-logs/${row!.id}`).expect(200);
      expect((own.body as { data: { after: { name: string } } }).data.after.name).toBe(TEAM.name);
      await call('get', tokens.a2Admin!, `/audit-logs/${row!.id}`).expect(404);
      await call('get', tokens.b1Admin!, `/audit-logs/${row!.id}`).expect(404);
    });

    it('fixture-caused audit rows carry the scope of what they describe; only sign-in/out is at platform', async () => {
      const rows = await q<{ action: string; scope_type: string; org_id: string | null }>(
        sql`SELECT action, scope_type::text AS scope_type, org_id FROM audit_logs WHERE user_agent = ${FIXTURE_USER_AGENT}`,
      );
      const orgIds = fixtureOrgIds();
      for (const row of rows) {
        if (row.action.startsWith('auth.')) {
          expect(row.org_id).toBeNull();
        } else {
          expect(['organization', 'workspace', 'team']).toContain(row.scope_type);
          expect(orgIds).toContain(row.org_id);
        }
      }
    });

    // --- The owner-level write set (static proof) ---------------------------
    //
    // A schema owner can forge an audit row, a grant or an identity that is
    // byte-for-byte indistinguishable from one the application wrote, so
    // database state alone cannot prove provenance against that principal
    // (`SECURITY.md` §4a). The proof that the fixture writes only what was
    // approved is therefore a proof about its source: the complete set of
    // owner-level writes it can reach, pinned, so that any new one fails here.

    it('owner write set, fixture: exactly the two Phase 1C.4a exceptions and nothing else', () => {
      const rawWrites: string[] = [];
      const lifecycleCalls: string[] = [];
      for (const file of FIXTURE_SOURCES) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(
          /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO|COPY)\s+([a-z_]+)/gi,
        )) {
          rawWrites.push(`${m[1]!.toUpperCase().replace(/\s+/g, ' ')} ${m[2]}`);
        }
        for (const m of text.matchAll(/\.(invite|activate|disable|reactivate|reinstate)\(/g)) {
          lifecycleCalls.push(`${relative(API_ROOT, file)} ${m[1]}`);
        }
        // No query-builder write, no elevation, no trigger or DDL, no audit write.
        expect(text).not.toMatch(/\b(tx|db|work|admin)\.(insert|update|delete)\(/);
        expect(text).not.toMatch(/\.(insert|update|delete)\(\s*schema\./);
        expect(text).not.toMatch(/set_config|DISABLE\s+TRIGGER|\.record\(/i);
        // SQL-shaped DDL and privilege statements (upper case, as all SQL here is).
        expect(text).not.toMatch(
          /\b(ALTER|CREATE|DROP)\s+(TABLE|ROLE|POLICY|TRIGGER|FUNCTION)\b|\b(GRANT|REVOKE)\s+\w+\s+ON\b/,
        );
      }
      // 1. Reseller B (Phase 9 defers reseller CRUD).
      expect(rawWrites).toEqual(['INSERT INTO resellers']);
      // 2. Fixture-user activation, through the unchanged lifecycle primitive, once.
      expect(lifecycleCalls).toEqual(['src/cli/dev-fixture/owner-operations.ts activate']);
    });

    it('owner write set, fixture: the import closure is pinned, so no new writing helper can be added silently', () => {
      const imports = new Set<string>();
      const fromBootstrap: string[] = [];
      for (const file of FIXTURE_SOURCES) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/(?:from\s+|import\()'([^']+)'/g)) {
          const spec = m[1]!;
          imports.add(
            spec.startsWith('.') ? relative(API_ROOT, resolve(dirname(file), spec)) : spec,
          );
        }
        const named = /import\s*\{([^}]*)\}\s*from\s*'\.\.\/bootstrap'/.exec(text);
        if (named)
          fromBootstrap.push(
            ...named[1]!
              .split(',')
              .map((n) => n.trim())
              .filter(Boolean),
          );
      }
      expect([...imports].sort()).toEqual([
        '@acc/contracts',
        '@acc/db',
        'dotenv',
        'drizzle-orm',
        'node:crypto',
        'node:net',
        'node:path',
        'src/app.factory',
        'src/audit/audit-writer.service',
        'src/cli/bootstrap',
        'src/cli/dev-fixture/api-client',
        'src/cli/dev-fixture/environment',
        'src/cli/dev-fixture/inspect',
        'src/cli/dev-fixture/owner-operations',
        'src/cli/dev-fixture/run',
        'src/cli/dev-fixture/topology',
        'src/config/app-config.service',
        'src/iam/credential.service',
        'src/iam/user-lifecycle.service',
        'src/secrets/env-secrets.adapter',
      ]);
      // From the bootstrap CLI, the fixture uses the bootstrap and its audit shim only.
      expect(fromBootstrap.sort()).toEqual(['ownerAuditWriter', 'runBootstrap']);
    });

    it('owner write set, existing bootstrap exception (ADR-003 D-1): runBootstrap writes exactly its approved set', () => {
      const text = readFileSync(resolve(API_ROOT, 'src/cli/bootstrap.ts'), 'utf8');
      const body = text.slice(
        text.indexOf('export async function runBootstrap('),
        text.indexOf('async function main('),
      );
      expect(body.length).toBeGreaterThan(500);
      expect([...body.matchAll(/set_config\('([^']+)'/g)].map((m) => m[1])).toEqual([
        'app.is_platform_admin',
      ]);
      expect(
        [...body.matchAll(/\btx\.(insert|update|delete)\(\s*schema\.(\w+)/g)].map(
          (m) => `${m[1]} ${m[2]}`,
        ),
      ).toEqual(['insert userRoles']);
      expect(body).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
      expect([...body.matchAll(/\busers\.(\w+)\(/g)].map((m) => m[1])).toEqual([
        'findByEmail',
        'invite',
        'activate',
      ]);
      expect([...body.matchAll(/action:\s*AUDIT_ACTIONS\.(\w+)/g)].map((m) => m[1])).toEqual([
        'USER_INVITED',
        'USER_ROLE_GRANTED',
      ]);
      expect([...body.matchAll(/\baudit\.record\(/g)]).toHaveLength(2);

      // The lifecycle primitives bootstrap and the fixture share: one `users`
      // write each, nothing else.
      const lifecycle = readFileSync(
        resolve(API_ROOT, 'src/iam/user-lifecycle.service.ts'),
        'utf8',
      );
      const method = (name: string) => {
        const from = lifecycle.indexOf(`  async ${name}(`);
        return lifecycle.slice(from, lifecycle.indexOf('\n  }\n', from));
      };
      for (const [name, write] of [
        ['invite', 'insert users'],
        ['activate', 'update users'],
      ] as const) {
        const writes = [...method(name).matchAll(/\.(insert|update|delete)\(\s*schema\.(\w+)/g)];
        expect(writes.map((m) => `${m[1]} ${m[2]}`)).toEqual([write]);
      }
      expect(method('activate')).toMatch(
        /\.set\(\{ passwordHash: digest, passwordUpdatedAt: new Date\(\), status: 'active' \}\)/,
      );
    });

    it('owner write set, runtime: the bootstrap wrote only the operator, its one platform grant and its two audit rows', async () => {
      const grants = await q(
        sql`SELECT r.key AS role, ur.scope_type::text AS scope_type, ur.scope_id FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${manifest.operator.id}`,
      );
      expect(grants).toEqual([
        { role: PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN, scope_type: 'platform', scope_id: null },
      ]);
      const rows = await q(
        sql`SELECT action, scope_type::text AS scope_type, actor_type::text AS actor_type, resource_id,
                   metadata ->> 'via' AS via
              FROM audit_logs WHERE actor_label = 'platform_bootstrap' ORDER BY action`,
      );
      expect(rows).toEqual([
        {
          action: 'user.invited',
          scope_type: 'platform',
          actor_type: 'system',
          resource_id: manifest.operator.id,
          via: 'bootstrap-cli',
        },
        {
          action: 'user_role.granted',
          scope_type: 'platform',
          actor_type: 'system',
          resource_id: manifest.operator.id,
          via: 'bootstrap-cli',
        },
      ]);
      // The only other system-actor rows in the fixture's footprint are the
      // tenant-role provisioner's, written inside `POST /organizations` (five
      // system roles per organization) and carrying that request's user agent
      // and the run's correlation id — the real path, not an owner write.
      const system = await q<{ action: string; label: string; n: number; chained: boolean }>(
        sql`SELECT action, actor_label AS label, count(*)::int AS n,
                   bool_and(user_agent = ${FIXTURE_USER_AGENT} AND correlation_id = (
                     SELECT correlation_id FROM audit_logs WHERE action = 'auth.login.succeeded'
                        AND actor_user_id = ${manifest.operator.id})) AS chained
              FROM audit_logs WHERE actor_type = 'system'
               AND (org_id IN (${sql.join(
                 fixtureOrgIds().map((id) => sql`${id}`),
                 sql`, `,
               )}) OR user_agent = ${FIXTURE_USER_AGENT})
             GROUP BY 1, 2`,
      );
      expect(system).toEqual([
        { action: 'role.created', label: 'tenant_role_provisioning', n: 15, chained: true },
      ]);
    });
  });

  // --- F. isolation over HTTP -------------------------------------------------------

  describe('F. isolation: no administrator discovers another organization', () => {
    const admins: [UserRef, OrgRef][] = [
      ['a1Admin', 'A1'],
      ['a2Admin', 'A2'],
      ['b1Admin', 'B1'],
    ];

    async function objectsOf(org: OrgRef) {
      const orgId = manifest.organizations[org].id;
      const col = async (query: ReturnType<typeof sql>) =>
        (await q<{ id: string }>(query)).map((r) => r.id);
      return {
        organizations: [orgId],
        workspaces: await col(sql`SELECT id FROM workspaces WHERE org_id = ${orgId}`),
        teams: await col(sql`SELECT id FROM teams WHERE org_id = ${orgId}`),
        users: await col(
          sql`SELECT DISTINCT user_id AS id FROM user_roles WHERE org_id = ${orgId}
                AND user_id <> ${manifest.users.multiOrg.id}`,
        ),
        roles: await col(sql`SELECT id FROM roles WHERE org_id = ${orgId}`),
        'role-assignments': await col(sql`SELECT id FROM user_roles WHERE org_id = ${orgId}`),
        'audit-logs': await col(sql`SELECT id FROM audit_logs WHERE org_id = ${orgId}`),
      };
    }

    it.each(admins)('%s cannot select any other fixture organization (403)', async (who, own) => {
      for (const org of ['A1', 'A2', 'B1'] as OrgRef[]) {
        if (org === own) continue;
        const res = await call(
          'get',
          tokens[who]!,
          '/workspaces',
          manifest.organizations[org].id,
        ).expect(403);
        expect((res.body as { error: { code: string } }).error.code).toBe(
          ERROR_CODES.TENANCY_CONTEXT_MISMATCH,
        );
      }
    });

    it.each(admins)(
      '%s enumerates none of the other organizations’ objects on any list endpoint',
      async (who, own) => {
        const others = (['A1', 'A2', 'B1'] as OrgRef[]).filter((o) => o !== own);
        const mine = await objectsOf(own);
        for (const [collection, ownIds] of Object.entries(mine)) {
          const listed = await listAll(tokens[who]!, `/${collection}`);
          for (const other of others) {
            const foreign = (await objectsOf(other))[collection as keyof typeof mine];
            expect(listed.filter((id) => foreign.includes(id))).toEqual([]);
          }
          // Positive control: the endpoint does list the administrator's own objects.
          if (collection !== 'audit-logs') expect(listed).toEqual(expect.arrayContaining(ownIds));
          else expect(listed.length).toBeGreaterThan(0);
        }
      },
    );

    it.each(admins)(
      '%s gets 404 for every detail endpoint of another organization',
      async (who, own) => {
        for (const other of (['A1', 'A2', 'B1'] as OrgRef[]).filter((o) => o !== own)) {
          const objects = await objectsOf(other);
          for (const [collection, ids] of Object.entries(objects)) {
            for (const id of ids.slice(0, 3)) {
              await call('get', tokens[who]!, `/${collection}/${id}`).expect(404);
            }
          }
        }
      },
    );
  });

  // --- G. privilege boundaries ---------------------------------------------------------

  describe('G. low privilege, multi-organization reach and platform escalation', () => {
    it('the team read-only user is refused every administrative operation, and nothing changes', async () => {
      const t = tokens.teamReader!;
      const a1 = manifest.organizations.A1;
      const before = await databaseHash();
      const attempts = [
        () => call('post', t, '/teams').send({ workspaceId: a1.defaultWorkspaceId, name: 'nope' }),
        () => call('patch', t, `/teams/${manifest.team.id}`).send({ name: 'nope' }),
        () => call('post', t, '/workspaces').send({ name: 'nope', slug: 'nope-ws' }),
        () =>
          call('post', t, '/users').send({
            email: 'nope@acc-fixture.test',
            initialRole: { roleId: a1.id, scopeType: 'organization', scopeId: a1.id },
          }),
        () =>
          call('post', t, '/role-assignments').send({
            userId: manifest.users.teamReader.id,
            roleId: a1.id,
            scopeType: 'organization',
            scopeId: a1.id,
          }),
        () => call('patch', t, `/organizations/${a1.id}`).send({ name: 'nope' }),
        () => call('post', t, `/organizations/${a1.id}/suspend`).send({}),
        () => call('post', t, `/users/${manifest.users.a1Admin.id}/disable`).send({}),
        () =>
          call('post', t, '/api-keys').send({
            name: 'nope',
            scopeType: 'organization',
            scopes: ['workspaces.read'],
            scopeId: a1.id,
          }),
      ];
      const unexpected: string[] = [];
      for (const [index, attempt] of attempts.entries()) {
        const res = await attempt();
        if (![403, 404].includes(res.status)) {
          unexpected.push(`#${index} ${res.status} ${JSON.stringify(res.body)}`);
        }
      }
      expect(unexpected).toEqual([]);
      // The audited denials, and the reader's own session bookkeeping, are the
      // only difference: no tenant, identity or grant table changed.
      const changed = (await databaseHash())
        .split('|')
        .filter((p) => !before.split('|').includes(p));
      expect(
        changed
          .map((p) => p.split(':')[0])
          .filter((t) => t !== 'public.audit_logs' && t !== 'public.sessions'),
      ).toEqual([]);
      const denials = await q<{ outcome: string }>(
        sql`SELECT DISTINCT outcome::text AS outcome FROM audit_logs
             WHERE actor_user_id = ${manifest.users.teamReader.id} AND action = 'authorization.denied'`,
      );
      expect(denials.map((d) => d.outcome)).toEqual(['denied']);
    });

    it('the multi-organization user must choose, may operate in A1 and A2, and is refused B1', async () => {
      const m = tokens.multiOrg!;
      const res = await call('get', m, '/workspaces').expect(400);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
      );
      for (const org of ['A1', 'A2'] as OrgRef[]) {
        const o = manifest.organizations[org];
        const ws = await call('get', m, '/workspaces', o.id).expect(200);
        expect(idsOf(ws)).toContain(o.defaultWorkspaceId);
        await call('post', m, '/teams', o.id)
          .send({ workspaceId: o.defaultWorkspaceId, name: `multi-org probe ${org}` })
          .expect(201);
      }
      const b1 = manifest.organizations.B1;
      const denied = await call('get', m, '/workspaces', b1.id).expect(403);
      expect((denied.body as { error: { code: string } }).error.code).toBe(
        ERROR_CODES.TENANCY_CONTEXT_MISMATCH,
      );
      await call('post', m, '/teams', b1.id)
        .send({ workspaceId: b1.defaultWorkspaceId, name: 'nope' })
        .expect(403);
      const orgs = await listAll(m, '/organizations', manifest.organizations.A1.id);
      expect(orgs).not.toContain(b1.id);
      expect(
        await q(sql`SELECT 1 FROM teams WHERE org_id = ${b1.id} AND name = 'nope'`),
      ).toHaveLength(0);
    });

    it('no fixture administrator can reach platform scope or another organization through a grant', async () => {
      const [superAdmin] = await q<{ id: string }>(
        sql`SELECT id FROM roles WHERE org_id IS NULL AND key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN}`,
      );
      const [a2Admin] = await q<{ id: string }>(
        sql`SELECT id FROM roles WHERE org_id = ${manifest.organizations.A2.id} AND key = 'org_admin'`,
      );
      const a1 = manifest.organizations.A1;
      const self = manifest.users.a1Admin.id;
      const grantsBefore = await q(sql`SELECT id FROM user_roles ORDER BY id`);

      await call('post', tokens.a1Admin!, '/role-assignments')
        .send({ userId: self, roleId: superAdmin!.id, scopeType: 'platform', scopeId: a1.id })
        .expect(400);
      const viaOrg = await call('post', tokens.a1Admin!, '/role-assignments').send({
        userId: self,
        roleId: superAdmin!.id,
        scopeType: 'organization',
        scopeId: a1.id,
      });
      expect([403, 404, 422]).toContain(viaOrg.status);
      const intoA2 = await call('post', tokens.a1Admin!, '/role-assignments').send({
        userId: self,
        roleId: a2Admin!.id,
        scopeType: 'organization',
        scopeId: manifest.organizations.A2.id,
      });
      expect([403, 404]).toContain(intoA2.status);
      await call('post', tokens.a1Admin!, '/users')
        .send({
          email: 'escalate@acc-fixture.test',
          initialRole: { roleId: superAdmin!.id, scopeType: 'platform', scopeId: a1.id },
        })
        .expect(400);

      expect(await q(sql`SELECT id FROM user_roles ORDER BY id`)).toEqual(grantsBefore);
      expect(
        await q(sql`SELECT 1 FROM users WHERE email = 'escalate@acc-fixture.test'`),
      ).toHaveLength(0);
    });
  });

  // --- H. database and surface ---------------------------------------------------------

  describe('H. RLS, principal privileges and the absence of an HTTP route', () => {
    it('as acc_app, each administrator’s context sees only its own organization’s rows', async () => {
      const orgIds = fixtureOrgIds();
      const list = sql.join(
        orgIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      for (const [who, org] of [
        ['a1Admin', 'A1'],
        ['a2Admin', 'A2'],
        ['b1Admin', 'B1'],
      ] as [UserRef, OrgRef][]) {
        const session: TenantSession = {
          orgId: manifest.organizations[org].id,
          workspaceId: null,
          userId: manifest.users[who].id,
          isPlatformAdmin: false,
          resellerId: null,
        };
        const seen = await tenantDb.withTenant(session, async (tx) => {
          const out: Record<string, string[]> = {};
          for (const table of [
            'organizations',
            'workspaces',
            'teams',
            'roles',
            'user_roles',
            'audit_logs',
          ]) {
            const column = table === 'organizations' ? 'id' : 'org_id';
            const rows = (
              await tx.execute(sql`SELECT DISTINCT ${sql.raw(column)}::text AS o FROM ${sql.raw(table)}
                                    WHERE ${sql.raw(column)} IN (${list})`)
            ).rows as { o: string }[];
            out[table] = rows.map((r) => r.o);
          }
          return out;
        });
        const own = manifest.organizations[org].id;
        const hasTeams = (await q(sql`SELECT 1 FROM teams WHERE org_id = ${own}`)).length > 0;
        expect(seen).toEqual({
          organizations: [own],
          workspaces: [own],
          teams: hasTeams ? [own] : [],
          roles: [own],
          user_roles: [own],
          audit_logs: [own],
        });
      }
    });

    it('acc_app, acc_auth and acc_relay hold exactly the privileges they held before the fixture', async () => {
      expect(await privilegeSnapshot()).toBe(privilegesBefore);
    });

    it('no HTTP route reaches the fixture, and no application module imports the CLI', async () => {
      const http = h.app.getHttpAdapter().getInstance() as {
        router: { stack: Array<{ route?: { path: string } }> };
      };
      const paths = http.router.stack.flatMap((l) => (l.route ? [l.route.path] : []));
      expect(paths.length).toBeGreaterThan(50);
      expect(paths.filter((p) => /fixture|bootstrap|seed/i.test(p))).toEqual([]);
      for (const path of ['/dev-fixture', '/fixture', '/fixtures', '/bootstrap']) {
        const res = await request(h.app.getHttpServer()).post(url(path)).send({});
        expect(res.status).toBe(404);
      }
      const importers = sourcesOf(resolve(API_ROOT, 'src'))
        .filter((f) => !f.includes(`${join('src', 'cli')}`))
        .filter((f) => /from '[^']*\/cli(\/|')/.test(readFileSync(f, 'utf8')));
      expect(importers).toEqual([]);
    });
  });

  // --- I. conflicting state on an existing fixture ----------------------------------------

  describe('I. an existing fixture with incompatible state is refused, never corrected', () => {
    async function withMutation(
      apply: ReturnType<typeof sql>,
      undo: ReturnType<typeof sql>,
      message: RegExp,
    ) {
      await h.admin.execute(apply);
      try {
        await expectRefusedUnchanged(fixtureEnv(), message);
      } finally {
        await h.admin.execute(undo);
      }
    }

    it('B1 moved under Reseller A is refused, not moved back', async () => {
      const b1 = manifest.organizations.B1.id;
      await withMutation(
        sql`UPDATE organizations SET reseller_id = ${manifest.resellers.A.id} WHERE id = ${b1}`,
        sql`UPDATE organizations SET reseller_id = ${manifest.resellers.B.id} WHERE id = ${b1}`,
        /acc-fixture-b1 exists under a different reseller/,
      );
    });

    it('Reseller B with a different name is refused, not renamed', async () => {
      await withMutation(
        sql`UPDATE resellers SET name = 'Someone Else' WHERE slug = ${RESELLERS.B.slug}`,
        sql`UPDATE resellers SET name = ${RESELLERS.B.name} WHERE slug = ${RESELLERS.B.slug}`,
        /reseller acc-fixture-reseller-b exists with incompatible attributes/,
      );
    });

    it('a non-fixture organization under Reseller B is refused', async () => {
      await withMutation(
        sql`INSERT INTO organizations (name, slug, reseller_id) VALUES ('Intruder', 'acc-fixture-intruder', ${manifest.resellers.B.id})`,
        sql`DELETE FROM organizations WHERE slug = 'acc-fixture-intruder'`,
        /owns a non-fixture organization "acc-fixture-intruder"/,
      );
    });

    it('a suspended fixture organization is refused, not reactivated', async () => {
      const a2 = manifest.organizations.A2.id;
      await withMutation(
        sql`UPDATE organizations SET status = 'suspended' WHERE id = ${a2}`,
        sql`UPDATE organizations SET status = 'active' WHERE id = ${a2}`,
        /acc-fixture-a2 is suspended, not active/,
      );
    });

    it('an extra grant on a fixture user is refused, not revoked', async () => {
      const [readOnlyA2] = await q<{ id: string }>(
        sql`SELECT id FROM roles WHERE org_id = ${manifest.organizations.A2.id} AND key = 'read_only'`,
      );
      await withMutation(
        sql`INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
            VALUES (${manifest.users.a1Admin.id}, ${readOnlyA2!.id}, 'organization', ${manifest.organizations.A2.id})`,
        sql`DELETE FROM user_roles WHERE user_id = ${manifest.users.a1Admin.id} AND role_id = ${readOnlyA2!.id}`,
        /a1-admin@acc-fixture.test holds an unexpected grant/,
      );
    });

    it('a disabled fixture user is refused, not reactivated', async () => {
      // The team reader rather than an organization's only administrator, whom
      // the last-organization-administrator rule (ADR-015 R-11, migration 0028)
      // keeps active for every writer, the owner included.
      const id = manifest.users.teamReader.id;
      await withMutation(
        sql`UPDATE users SET status = 'disabled' WHERE id = ${id}`,
        sql`UPDATE users SET status = 'active' WHERE id = ${id}`,
        /a1-team-reader@acc-fixture.test is disabled/,
      );
    });

    it('a changed password reference is refused, and no credential is overwritten', async () => {
      process.env.ACC_FIXTURE_SUITE_OTHER_PASSWORD = `other-${randomBytes(24).toString('hex')}`;
      try {
        await expectRefusedUnchanged(
          fixtureEnv({ ACC_FIXTURE_USER_PASSWORD_REF: 'env:ACC_FIXTURE_SUITE_OTHER_PASSWORD' }),
          /does not match ACC_FIXTURE_USER_PASSWORD_REF; the fixture never overwrites a credential/,
        );
      } finally {
        delete process.env.ACC_FIXTURE_SUITE_OTHER_PASSWORD;
      }
    });

    it('a different operator is refused while another platform administrator exists', async () => {
      await expectRefusedUnchanged(
        fixtureEnv({ AUTH_BOOTSTRAP_EMAIL: 'someone-else@example.test' }),
        /bootstrapped with a different administrator/,
      );
    });

    it('after every refusal the fixture is intact: a run is again a no-op', async () => {
      const again = await runDevFixture(fixtureEnv());
      expect(again.outcome).toBe('unchanged');
      expect(again.fingerprint.identity).not.toBe('');
    });
  });
});
