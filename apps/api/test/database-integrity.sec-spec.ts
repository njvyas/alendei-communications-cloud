/**
 * Phase 1C.6 — database integrity (ADR-011 D-8, ADR-012; migration `0014`) —
 * security suite.
 *
 *   A  composite `(workspace_id, org_id)` foreign keys on `api_keys`/`ws_tickets`
 *   B  `roles.allowed_scope_types` enforced by `fn_validate_user_role_scope`
 *   C  `organizations.reseller_id` immutability
 *   D  role narrowing refused while grants would be stranded (decision §14.1, A)
 *   E  the migration's verifying backfill fails loudly on bad data
 *   F  deterministic concurrency (a held transaction, proven by `pg_blocking_pids`)
 *   G  trigger-only SECURITY DEFINER functions (migration `0015`, review H-1):
 *      no application principal holds EXECUTE or can attach one to a table
 *   H  narrowing refused outside READ COMMITTED (migration `0015`, review H-2)
 *   I  the six pre-existing SECURITY DEFINER trigger functions made trigger-only
 *      (migration `0016`, review H-3), and every trigger using them still fires
 *
 * Every database guarantee is proven **directly** — as the schema owner and as
 * `acc_app` with an explicit tenant context — never inferred from the service.
 */
import { ERROR_CODES, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';

interface Org {
  orgId: string;
  resellerId: string;
  workspaceId: string;
  teamId: string;
  roles: Record<string, string>;
}
interface Person {
  userId: string;
  email: string;
}
interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

const MIGRATION = resolve(
  __dirname,
  '../../../packages/db/migrations/0014_phase1c6_database_integrity.sql',
);

describe('Phase 1C.6 database integrity', () => {
  let h: Harness;
  let credentials: CredentialService;
  let ownerPool: Pool;
  let appPool: Pool;
  let authPool: Pool;
  let relayPool: Pool;
  let resellerA: string;
  let resellerB: string;
  let a1: Org;
  let a2: Org;
  const p: Record<string, Person> = {};
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];
  const createdResellers: string[] = [];
  /** A custom, mutable role in A1 that admits all three tenant scopes. */
  let narrowRole: string;
  let adminToken: string;

  const url = (path: string) => `/${PREFIX}${path}`;
  const suffix = () => uuidv7().replace(/-/g, '').slice(-10);
  const keyPrefix = () => `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`;

  // --- fixtures ---------------------------------------------------------------

  async function createUser(label: string): Promise<Person> {
    const email = `${label}-${suffix()}@example.test`;
    const [u] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    createdUsers.push(u!.id);
    return { userId: u!.id, email };
  }

  async function grant(
    userId: string,
    roleId: string,
    scopeType: 'platform' | 'reseller' | 'organization' | 'workspace' | 'team',
    scopeId: string | null,
  ): Promise<string> {
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [row] = await tx
        .insert(schema.userRoles)
        .values({ userId, roleId, scopeType, scopeId })
        .returning({ id: schema.userRoles.id });
      return row!.id;
    });
  }

  async function platformRole(key: string) {
    const [r] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, key), isNull(schema.roles.orgId)));
    return r!.id;
  }

  async function createReseller(label: string) {
    const [r] = await h.admin
      .insert(schema.resellers)
      .values({ name: `R ${label}`, slug: `rs-${label}-${suffix()}` })
      .returning({ id: schema.resellers.id });
    createdResellers.push(r!.id);
    return r!.id;
  }

  async function plantOrg(label: string, resellerId: string): Promise<Org> {
    const [org] = await h.admin
      .insert(schema.organizations)
      .values({ name: `O ${label}`, slug: `o-${label}-${suffix()}`, resellerId })
      .returning({ id: schema.organizations.id });
    const orgId = org!.id;
    createdOrgs.push(orgId);
    const [ws] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId, name: 'Default', slug: 'default', isDefault: true })
      .returning({ id: schema.workspaces.id });
    const [team] = await h.admin
      .insert(schema.teams)
      .values({ orgId, workspaceId: ws!.id, name: `T ${label}` })
      .returning({ id: schema.teams.id });
    const provisioner = h.app.get(TenantRoleProvisioner);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await provisioner.seedTenantRoles(tx as unknown as Transaction, orgId, {
        correlationId: uuidv7(),
      });
    });
    const rows = await h.admin
      .select({ id: schema.roles.id, key: schema.roles.key })
      .from(schema.roles)
      .where(eq(schema.roles.orgId, orgId));
    return {
      orgId,
      resellerId,
      workspaceId: ws!.id,
      teamId: team!.id,
      roles: Object.fromEntries(rows.map((r) => [r.key, r.id])),
    };
  }

  /** A workspace with no teams, so its `org_id` can be the subject of an update. */
  async function bareWorkspace(org: Org): Promise<string> {
    const [ws] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: org.orgId, name: `bare ${suffix()}`, slug: `bare-${suffix()}` })
      .returning({ id: schema.workspaces.id });
    return ws!.id;
  }

  // --- database principals ------------------------------------------------------

  interface AppSession {
    orgId?: string | null;
    resellerId?: string | null;
    userId?: string | null;
    isPlatformAdmin?: boolean;
  }

  type Isolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

  /** Runs `work` as `acc_app` with the given tenant context, then rolls back. */
  async function asApp<T>(
    session: AppSession,
    work: (c: PoolClient) => Promise<T>,
    isolation: Isolation = 'READ COMMITTED',
  ): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      for (const [name, value] of [
        ['app.current_org_id', session.orgId ?? ''],
        ['app.current_workspace_id', ''],
        ['app.current_reseller_id', session.resellerId ?? ''],
        ['app.current_user_id', session.userId ?? ''],
        ['app.is_platform_admin', session.isPlatformAdmin ? 'on' : 'off'],
        ['app.provisioning', 'off'],
      ] as const) {
        await c.query('SELECT set_config($1, $2, true)', [name, value]);
      }
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  /** Runs `work` as the schema owner, then rolls back. */
  async function asOwner<T>(
    work: (c: PoolClient) => Promise<T>,
    isolation: Isolation = 'READ COMMITTED',
  ): Promise<T> {
    const c = await ownerPool.connect();
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  const refusal = async (op: Promise<unknown>): Promise<PgError> => {
    try {
      await op;
    } catch (error) {
      return error as PgError;
    }
    throw new Error('expected the database to refuse the write');
  };

  const insertKey = (c: PoolClient, orgId: string, workspaceId: string | null) =>
    c.query(
      `INSERT INTO api_keys (org_id, workspace_id, name, key_prefix, key_hash, scopes)
       VALUES ($1, $2, 'c6', $3, 'not-a-hash', '[]'::jsonb) RETURNING id`,
      [orgId, workspaceId, keyPrefix()],
    );
  const insertTicket = (c: PoolClient, userId: string, orgId: string, workspaceId: string | null) =>
    c.query(
      `INSERT INTO ws_tickets (ticket_hash, user_id, org_id, workspace_id, expires_at)
       VALUES (md5(random()::text), $1, $2, $3, now() + interval '1 minute') RETURNING id`,
      [userId, orgId, workspaceId],
    );
  const insertGrant = (
    c: PoolClient,
    userId: string,
    roleId: string,
    scopeType: string,
    scopeId: string | null,
  ) =>
    c.query(
      `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, roleId, scopeType, scopeId],
    );

  // --- HTTP ----------------------------------------------------------------------

  async function login(person: Person): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: person.email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }
  const call = (method: 'get' | 'post' | 'patch', token: string, path: string) =>
    request(h.app.getHttpServer())[method](url(path)).set('authorization', `Bearer ${token}`);

  // --- role-narrowing helpers ---------------------------------------------------

  const allowedOf = async (roleId: string) =>
    (
      await h.admin
        .select({ a: schema.roles.allowedScopeTypes })
        .from(schema.roles)
        .where(eq(schema.roles.id, roleId))
    )[0]!.a;
  const grantsOf = async (roleId: string) =>
    (
      await h.admin.execute<{ id: string; scope_type: string; scope_id: string | null }>(
        sql`SELECT id, scope_type, scope_id FROM user_roles WHERE role_id = ${roleId} ORDER BY id`,
      )
    ).rows;
  /** Grants of `roleId` at a scope type the role does not admit — always 0. */
  const strandedOf = async (roleId: string) =>
    (
      await h.admin.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            WHERE ur.role_id = ${roleId} AND NOT (ur.scope_type = ANY (r.allowed_scope_types))`,
      )
    ).rows[0]!.n;
  async function resetNarrowRole() {
    await h.admin.execute(sql`DELETE FROM user_roles WHERE role_id = ${narrowRole}`);
    await h.admin.execute(
      sql`UPDATE roles SET allowed_scope_types = '{organization,workspace,team}' WHERE id = ${narrowRole}`,
    );
  }

  // --- setup ------------------------------------------------------------------------

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    ownerPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 3 });
    appPool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 3 });
    authPool = new Pool({ connectionString: process.env.DATABASE_AUTH_URL!, max: 1 });
    relayPool = new Pool({ connectionString: process.env.DATABASE_RELAY_URL!, max: 1 });

    resellerA = await createReseller('c6-a');
    resellerB = await createReseller('c6-b');
    a1 = await plantOrg('c6-a1', resellerA);
    a2 = await plantOrg('c6-a2', resellerA);

    p.adminA1 = await createUser('c6-admin-a1');
    await grant(p.adminA1.userId, a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, 'organization', a1.orgId);
    for (const name of ['member', 'member2', 'member3']) {
      p[name] = await createUser(`c6-${name}`);
      await grant(p[name]!.userId, a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', a1.orgId);
    }
    p.platform = await createUser('c6-platform');
    await grant(
      p.platform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    p.resellerAdmin = await createUser('c6-reseller-admin');
    await grant(
      p.resellerAdmin.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerA,
    );

    narrowRole = await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: a1.orgId,
          key: `c6_narrow_${suffix()}`,
          name: 'C6 narrowing subject',
          isSystemRole: false,
          allowedScopeTypes: ['organization', 'workspace', 'team'],
        })
        .returning({ id: schema.roles.id });
      const [perm] = await tx
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, 'workspaces.read'));
      await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId: perm!.id });
      return role!.id;
    });

    adminToken = await login(p.adminA1);
  }, 240_000);

  afterAll(async () => {
    await h.clearRateLimits();
    await ownerPool.end();
    await appPool.end();
    await authPool.end();
    await relayPool.end();
    const orgs = [...new Set(createdOrgs)];
    const list = (ids: string[]) =>
      sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
    await purgeAudit(
      h.admin,
      sql`org_id IN (${list(orgs)}) OR actor_user_id IN (${list(createdUsers)}) OR reseller_id IN (${list(createdResellers)})`,
    );
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        await tx.execute(
          sql`DELETE FROM user_roles WHERE user_id IN (${list(createdUsers)}) OR org_id IN (${list(orgs)})`,
        );
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
      for (const table of [
        'role_permissions',
        'roles',
        'ws_tickets',
        'api_keys',
        'idempotency_keys',
        'teams',
        'workspaces',
      ]) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${list(orgs)})`);
      }
    });
    await h.admin.execute(sql`DELETE FROM organizations WHERE id IN (${list(orgs)})`);
    await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await h.admin.delete(schema.resellers).where(inArray(schema.resellers.id, createdResellers));
    await h.close();
  }, 240_000);

  // ===========================================================================
  describe('A. composite (workspace_id, org_id) foreign keys', () => {
    it('api_keys: owner and acc_app may bind a same-organization workspace or none; a workspace of another organization is refused', async () => {
      await asOwner(async (c) => {
        await insertKey(c, a1.orgId, a1.workspaceId);
        await insertKey(c, a1.orgId, null);
        const err = await refusal(insertKey(c, a1.orgId, a2.workspaceId));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('api_keys_workspace_org_fk');
      });
      const ctx = { orgId: a1.orgId, userId: p.adminA1!.userId };
      await asApp(ctx, async (c) => {
        await insertKey(c, a1.orgId, a1.workspaceId);
        await insertKey(c, a1.orgId, null);
      });
      await asApp(ctx, async (c) => {
        const err = await refusal(insertKey(c, a1.orgId, a2.workspaceId));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('api_keys_workspace_org_fk');
      });
    });

    it('ws_tickets: the same, for owner and acc_app', async () => {
      await asOwner(async (c) => {
        await insertTicket(c, p.adminA1!.userId, a1.orgId, a1.workspaceId);
        await insertTicket(c, p.adminA1!.userId, a1.orgId, null);
        const err = await refusal(insertTicket(c, p.adminA1!.userId, a1.orgId, a2.workspaceId));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('ws_tickets_workspace_org_fk');
      });
      const ctx = { orgId: a1.orgId, userId: p.adminA1!.userId };
      await asApp(ctx, async (c) => {
        await insertTicket(c, p.adminA1!.userId, a1.orgId, a1.workspaceId);
      });
      await asApp(ctx, async (c) => {
        const err = await refusal(insertTicket(c, p.adminA1!.userId, a1.orgId, a2.workspaceId));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('ws_tickets_workspace_org_fk');
      });
    });

    it('an existing binding cannot be rewritten into a mismatch, by either side', async () => {
      await asOwner(async (c) => {
        const { rows } = await insertKey(c, a1.orgId, a1.workspaceId);
        const moved = await refusal(
          c.query('UPDATE api_keys SET workspace_id = $1 WHERE id = $2', [
            a2.workspaceId,
            rows[0]!.id,
          ]),
        );
        expect(moved.constraint).toBe('api_keys_workspace_org_fk');
      });
      const ws = await bareWorkspace(a1);
      await asOwner(async (c) => {
        await insertKey(c, a1.orgId, ws);
        await c.query('SAVEPOINT s');
        const parent = await refusal(
          c.query('UPDATE workspaces SET org_id = $1 WHERE id = $2', [a2.orgId, ws]),
        );
        expect(parent.code).toBe('23503');
        expect(parent.constraint).toBe('api_keys_workspace_org_fk');
      });
    });
  });

  // ===========================================================================
  describe('B. allowed_scope_types enforced by fn_validate_user_role_scope', () => {
    it('owner: an admitted scope is accepted; a scope the role does not admit is refused', async () => {
      await asOwner(async (c) => {
        await insertGrant(
          c,
          p.member!.userId,
          a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!,
          'team',
          a1.teamId,
        );
        const err = await refusal(
          insertGrant(
            c,
            p.member!.userId,
            a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
            'workspace',
            a1.workspaceId,
          ),
        );
        expect(err.code).toBe('23514');
        expect(err.constraint).toBe('user_roles_scope_type_admitted');
        expect(err.message).toMatch(/does not admit scope_type workspace/);
      });
    });

    it('acc_app: the same, inside a legitimate organization context', async () => {
      const ctx = { orgId: a1.orgId, userId: p.adminA1!.userId };
      await asApp(ctx, async (c) => {
        await insertGrant(
          c,
          p.member!.userId,
          a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!,
          'workspace',
          a1.workspaceId,
        );
      });
      await asApp(ctx, async (c) => {
        const err = await refusal(
          insertGrant(
            c,
            p.member!.userId,
            a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
            'team',
            a1.teamId,
          ),
        );
        expect(err.code).toBe('23514');
        expect(err.constraint).toBe('user_roles_scope_type_admitted');
      });
    });

    it('an existing grant cannot be moved to a scope its role does not admit', async () => {
      await asOwner(async (c) => {
        const { rows } = await insertGrant(
          c,
          p.member2!.userId,
          a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
          'organization',
          a1.orgId,
        );
        const err = await refusal(
          c.query('UPDATE user_roles SET scope_type = $1, scope_id = $2 WHERE id = $3', [
            'workspace',
            a1.workspaceId,
            rows[0]!.id,
          ]),
        );
        expect(err.constraint).toBe('user_roles_scope_type_admitted');
      });
    });

    it('platform roles are enforced uniformly: each only at the scope it admits', async () => {
      const superAdmin = await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
      const support = await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT);
      const resellerAdmin = await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN);
      await asOwner(async (c) => {
        // Platform-role grants require the platform-administrator claim even for
        // the owner (`fn_validate_user_role_scope`, as in `seed.ts`).
        await c.query("SELECT set_config('app.is_platform_admin', 'on', true)");
        await insertGrant(c, p.member3!.userId, superAdmin, 'platform', null);
        await insertGrant(c, p.member3!.userId, support, 'platform', null);
        await insertGrant(c, p.member3!.userId, resellerAdmin, 'reseller', resellerB);
        for (const [role, scopeType, scopeId] of [
          [superAdmin, 'reseller', resellerB],
          [support, 'reseller', resellerB],
          [resellerAdmin, 'platform', null],
        ] as const) {
          await c.query('SAVEPOINT s');
          const err = await refusal(insertGrant(c, p.member3!.userId, role, scopeType, scopeId));
          expect(err.code).toBe('23514');
          expect(err.constraint).toBe('user_roles_scope_type_admitted');
          await c.query('ROLLBACK TO SAVEPOINT s');
        }
      });
    });

    it('the API still answers the pre-checked 422 for a non-admitted scope', async () => {
      const res = await call('post', adminToken, '/role-assignments').send({
        userId: p.member!.userId,
        roleId: a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN],
        scopeType: 'workspace',
        scopeId: a1.workspaceId,
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_TYPE_NOT_ADMITTED);
    });
  });

  // ===========================================================================
  describe('C. organizations.reseller_id immutability', () => {
    const move = (c: PoolClient, to: string) =>
      c.query('UPDATE organizations SET reseller_id = $1 WHERE id = $2 RETURNING reseller_id', [
        to,
        a1.orgId,
      ]);

    it('a reseller-scoped writer cannot move an organization, though RLS lets it update the row', async () => {
      await asApp({ resellerId: resellerA, userId: p.resellerAdmin!.userId }, async (c) => {
        await c.query("UPDATE organizations SET name = name || '' WHERE id = $1", [a1.orgId]);
        const err = await refusal(move(c, resellerB));
        expect(err.code).toBe('42501');
        expect(err.constraint).toBe('organizations_reseller_id_immutable');
      });
    });

    it('an organization-scoped writer cannot move it either', async () => {
      await asApp({ orgId: a1.orgId, userId: p.adminA1!.userId }, async (c) => {
        const err = await refusal(move(c, resellerB));
        expect(err.constraint).toBe('organizations_reseller_id_immutable');
      });
    });

    it('an unvalidated platform claim is refused; a validated platform administrator may move it', async () => {
      // The forged claim is given an organization context so RLS admits the
      // row: the refusal below is the guard's, not a zero-row RLS filter.
      await asApp(
        { orgId: a1.orgId, userId: p.adminA1!.userId, isPlatformAdmin: true },
        async (c) => {
          const err = await refusal(move(c, resellerB));
          expect(err.constraint).toBe('organizations_reseller_id_immutable');
        },
      );
      await asApp({ userId: p.platform!.userId, isPlatformAdmin: true }, async (c) => {
        const { rows, rowCount } = await move(c, resellerB);
        expect(rowCount).toBe(1);
        expect(rows[0]!.reseller_id).toBe(resellerB);
      });
    });

    it('a principal that bypasses RLS (the owner) keeps the documented capability', async () => {
      await asOwner(async (c) => {
        const { rows } = await move(c, resellerB);
        expect(rows[0]!.reseller_id).toBe(resellerB);
      });
    });

    it('the API still refuses the field (400), and the organization never moved', async () => {
      const res = await call('patch', adminToken, `/organizations/${a1.orgId}`).send({
        resellerId: resellerB,
      });
      expect(res.status).toBe(400);
      const [row] = await h.admin
        .select({ r: schema.organizations.resellerId })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, a1.orgId));
      expect(row!.r).toBe(resellerA);
    });
  });

  // ===========================================================================
  describe('D. role narrowing refused while grants would be stranded (Option A)', () => {
    beforeEach(() => resetNarrowRole());

    it('PATCH /roles/:id narrowing past an existing grant is 409; the role and every grant are unchanged', async () => {
      await grant(p.member!.userId, narrowRole, 'workspace', a1.workspaceId);
      await grant(p.member2!.userId, narrowRole, 'team', a1.teamId);
      const grantsBefore = await grantsOf(narrowRole);

      const res = await call('patch', adminToken, `/roles/${narrowRole}`).send({
        allowedScopeTypes: ['organization'],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
      expect(res.body.error.details).toEqual({ scopeTypesInUse: ['team', 'workspace'] });
      expect(await allowedOf(narrowRole)).toEqual(['organization', 'workspace', 'team']);
      expect(await grantsOf(narrowRole)).toEqual(grantsBefore);
    });

    it('narrowing that strands nothing succeeds; unrelated and widening changes succeed', async () => {
      await grant(p.member!.userId, narrowRole, 'workspace', a1.workspaceId);
      const narrowed = await call('patch', adminToken, `/roles/${narrowRole}`).send({
        allowedScopeTypes: ['organization', 'workspace'],
      });
      expect(narrowed.status).toBe(200);
      expect(await allowedOf(narrowRole)).toEqual(['organization', 'workspace']);

      await call('patch', adminToken, `/roles/${narrowRole}`)
        .send({ name: 'C6 renamed' })
        .expect(200);
      await call('patch', adminToken, `/roles/${narrowRole}`)
        .send({ allowedScopeTypes: ['organization', 'workspace', 'team'] })
        .expect(200);
      expect(await allowedOf(narrowRole)).toEqual(['organization', 'workspace', 'team']);
    });

    it('no database write path can narrow into a stranded state: owner and acc_app are refused', async () => {
      await grant(p.member!.userId, narrowRole, 'team', a1.teamId);
      const narrow = (c: PoolClient) =>
        c.query("UPDATE roles SET allowed_scope_types = '{organization}' WHERE id = $1", [
          narrowRole,
        ]);
      await asOwner(async (c) => {
        const err = await refusal(narrow(c));
        expect(err.code).toBe('23514');
        expect(err.constraint).toBe('roles_allowed_scope_types_in_use');
        expect(err.message).toMatch(/team/);
      });
      await asApp({ orgId: a1.orgId, userId: p.adminA1!.userId }, async (c) => {
        const err = await refusal(narrow(c));
        expect(err.constraint).toBe('roles_allowed_scope_types_in_use');
      });
      // A seeded system role with grants is guarded the same way.
      await asOwner(async (c) => {
        const err = await refusal(
          c.query("UPDATE roles SET allowed_scope_types = '{workspace}' WHERE id = $1", [
            a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN],
          ]),
        );
        expect(err.constraint).toBe('roles_allowed_scope_types_in_use');
      });
      expect(await allowedOf(narrowRole)).toEqual(['organization', 'workspace', 'team']);
    });

    it('once the stranded grant is revoked, the same narrowing succeeds', async () => {
      const id = await grant(p.member!.userId, narrowRole, 'team', a1.teamId);
      await call('patch', adminToken, `/roles/${narrowRole}`)
        .send({ allowedScopeTypes: ['organization'] })
        .expect(409);
      await h.admin.execute(sql`DELETE FROM user_roles WHERE id = ${id}`);
      await call('patch', adminToken, `/roles/${narrowRole}`)
        .send({ allowedScopeTypes: ['organization'] })
        .expect(200);
    });
  });

  // ===========================================================================
  describe('E. the verifying backfill fails loudly, before any constraint exists', () => {
    /** The migration's first statement — the verification block, executed verbatim. */
    const verification = () => {
      const text = readFileSync(MIGRATION, 'utf8');
      const block = text.split('--> statement-breakpoint')[0]!;
      const start = block.indexOf('DO $$');
      expect(start).toBeGreaterThan(-1);
      return block.slice(start);
    };

    it('passes on the current, clean database', async () => {
      await asOwner(async (c) => {
        await c.query(verification());
      });
    });

    it('names the invariant, the count and sample ids for a mismatched api_keys binding', async () => {
      await asOwner(async (c) => {
        await c.query('ALTER TABLE api_keys DROP CONSTRAINT api_keys_workspace_org_fk');
        const { rows } = await insertKey(c, a1.orgId, a2.workspaceId);
        const err = await refusal(c.query(verification()));
        expect(err.code).toBe('23514');
        expect(err.message).toMatch(
          /migration 0014 verification failed \[api_keys_workspace_org\]: 1 api_keys/,
        );
        expect(err.message).toContain(rows[0]!.id);
      });
    });

    it('does the same for ws_tickets', async () => {
      await asOwner(async (c) => {
        await c.query('ALTER TABLE ws_tickets DROP CONSTRAINT ws_tickets_workspace_org_fk');
        await insertTicket(c, p.adminA1!.userId, a1.orgId, a2.workspaceId);
        const err = await refusal(c.query(verification()));
        expect(err.message).toMatch(/\[ws_tickets_workspace_org\]: 1 ws_tickets/);
      });
    });

    it('does the same for a grant at a scope its role does not admit', async () => {
      await asOwner(async (c) => {
        await c.query('ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_validate_scope');
        const { rows } = await c.query(
          `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id, org_id)
           VALUES ($1, $2, 'workspace', $3, $4) RETURNING id`,
          [p.member3!.userId, a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN], a1.workspaceId, a1.orgId],
        );
        const err = await refusal(c.query(verification()));
        expect(err.message).toMatch(/\[user_roles_scope_type_admitted\]: 1 user_roles/);
        expect(err.message).toContain(rows[0]!.id);
      });
    });
  });

  // ===========================================================================
  describe('F. deterministic concurrency', () => {
    beforeEach(() => resetNarrowRole());

    /** Holds an owner transaction open after `stage`, until released. */
    async function hold(stage: (c: PoolClient) => Promise<void>) {
      const c = await ownerPool.connect();
      await c.query('BEGIN');
      const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await stage(c);
      return {
        pid,
        client: c,
        commit: async () => {
          await c.query('COMMIT');
          c.release();
        },
        rollback: async () => {
          await c.query('ROLLBACK').catch(() => undefined);
          c.release();
        },
      };
    }

    /** True once some backend is blocked behind `holderPid`. */
    async function blockedBehind(holderPid: number, timeoutMs = 10_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { rows } = await h.admin.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid} = ANY (pg_blocking_pids(pid))`,
        );
        if (rows[0]!.n > 0) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    }

    /** Observe while held, then always commit the holder, then await the contender. */
    async function race<T>(
      holder: { pid: number; commit: () => Promise<void> },
      contender: Promise<T>,
    ) {
      const state = { settled: false };
      const tracked = contender.then(
        (v) => {
          state.settled = true;
          return v;
        },
        (e) => {
          state.settled = true;
          throw e;
        },
      );
      let queued = false;
      let settledEarly = true;
      try {
        queued = await blockedBehind(holder.pid);
        settledEarly = state.settled;
      } finally {
        await holder.commit();
      }
      return {
        queued,
        settledEarly,
        outcome: await tracked.then(
          (v) => ({ v }),
          (e) => ({ e }),
        ),
      };
    }

    it('narrowing racing a role assignment that got there first: the narrowing waits, then is refused (409)', async () => {
      const holder = await hold(async (c) => {
        await insertGrant(c, p.member3!.userId, narrowRole, 'team', a1.teamId);
      });
      const { queued, settledEarly, outcome } = await race(
        holder,
        call('patch', adminToken, `/roles/${narrowRole}`)
          .send({ allowedScopeTypes: ['organization', 'workspace'] })
          .then((r) => r),
      );
      expect(queued).toBe(true);
      expect(settledEarly).toBe(false);
      const res = (outcome as { v: request.Response }).v;
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual({ scopeTypesInUse: ['team'] });
      expect(await allowedOf(narrowRole)).toEqual(['organization', 'workspace', 'team']);
    });

    it('a role assignment racing a narrowing that got there first: the assignment waits, then is refused (422) and nothing is granted', async () => {
      const holder = await hold(async (c) => {
        await c.query(
          "UPDATE roles SET allowed_scope_types = '{organization,workspace}' WHERE id = $1",
          [narrowRole],
        );
      });
      const { queued, settledEarly, outcome } = await race(
        holder,
        call('post', adminToken, '/role-assignments')
          .send({
            userId: p.member2!.userId,
            roleId: narrowRole,
            scopeType: 'team',
            scopeId: a1.teamId,
          })
          .then((r) => r),
      );
      expect(queued).toBe(true);
      expect(settledEarly).toBe(false);
      const res = (outcome as { v: request.Response }).v;
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_TYPE_NOT_ADMITTED);
      expect(await grantsOf(narrowRole)).toEqual([]);
      expect(await allowedOf(narrowRole)).toEqual(['organization', 'workspace']);
    });

    it('narrowing racing a direct grant mutation into the scope being dropped: the narrowing waits, then is refused', async () => {
      const id = await grant(p.member!.userId, narrowRole, 'organization', a1.orgId);
      const holder = await hold(async (c) => {
        await c.query('UPDATE user_roles SET scope_type = $1, scope_id = $2 WHERE id = $3', [
          'team',
          a1.teamId,
          id,
        ]);
      });
      const { queued, outcome } = await race(
        holder,
        call('patch', adminToken, `/roles/${narrowRole}`)
          .send({ allowedScopeTypes: ['organization'] })
          .then((r) => r),
      );
      expect(queued).toBe(true);
      expect((outcome as { v: request.Response }).v.status).toBe(409);
      expect(await allowedOf(narrowRole)).toEqual(['organization', 'workspace', 'team']);
    });

    it('a direct narrowing racing a direct grant: whichever commits second is refused by the database', async () => {
      const holder = await hold(async (c) => {
        await insertGrant(c, p.member!.userId, narrowRole, 'team', a1.teamId);
      });
      const contender = asOwner((c) =>
        c.query("UPDATE roles SET allowed_scope_types = '{organization}' WHERE id = $1", [
          narrowRole,
        ]),
      );
      const { queued, outcome } = await race(holder, contender);
      expect(queued).toBe(true);
      expect((outcome as { e: PgError }).e.constraint).toBe('roles_allowed_scope_types_in_use');
    });

    it('composite FK under concurrent parent and child writes: the later writer is refused', async () => {
      // Child first: a key bound to (ws, A1) is in flight; moving ws to A2 waits, then fails.
      const ws = await bareWorkspace(a1);
      const child = await hold(async (c) => {
        await insertKey(c, a1.orgId, ws);
      });
      const parentMove = asOwner((c) =>
        c.query('UPDATE workspaces SET org_id = $1 WHERE id = $2', [a2.orgId, ws]),
      );
      const first = await race(child, parentMove);
      expect(first.queued).toBe(true);
      expect((first.outcome as { e: PgError }).e.constraint).toBe('api_keys_workspace_org_fk');

      // Parent first: ws2 is moving to A2; a key bound to (ws2, A1) waits, then fails.
      const ws2 = await bareWorkspace(a1);
      const parent = await hold(async (c) => {
        await c.query('UPDATE workspaces SET org_id = $1 WHERE id = $2', [a2.orgId, ws2]);
      });
      const childInsert = asOwner((c) => insertKey(c, a1.orgId, ws2));
      const second = await race(parent, childInsert);
      expect(second.queued).toBe(true);
      expect((second.outcome as { e: PgError }).e.constraint).toBe('api_keys_workspace_org_fk');
    });
  });
  // ===========================================================================
  describe('G. trigger-only SECURITY DEFINER functions (migration 0015, review H-1)', () => {
    const TRIGGER_ONLY = [
      'fn_validate_user_role_scope',
      'fn_roles_guard_allowed_scope_types',
      'fn_organizations_guard_reseller_id',
    ] as const;
    const principals = () =>
      [
        ['acc_app', appPool],
        ['acc_auth', authPool],
        ['acc_relay', relayPool],
      ] as const;

    /** Runs `work` on `pool` in a transaction that is always rolled back. */
    async function rolledBack<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        return await work(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }

    it('PUBLIC, acc_app, acc_auth and acc_relay hold no EXECUTE on any of the three', async () => {
      const { rows } = await h.admin.execute<{
        proname: string;
        definer: boolean;
        pub: boolean;
        app: boolean;
        auth: boolean;
        relay: boolean;
      }>(sql`
        SELECT p.proname, p.prosecdef AS definer,
               has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
               has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app,
               has_function_privilege('acc_auth', p.oid, 'EXECUTE') AS auth,
               has_function_privilege('acc_relay', p.oid, 'EXECUTE') AS relay
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('fn_validate_user_role_scope',
          'fn_roles_guard_allowed_scope_types', 'fn_organizations_guard_reseller_id')
        ORDER BY p.proname`);
      expect(rows.map((r) => r.proname).sort()).toEqual([...TRIGGER_ONLY].sort());
      for (const r of rows) {
        expect({ ...r }).toEqual({
          proname: r.proname,
          definer: true,
          pub: false,
          app: false,
          auth: false,
          relay: false,
        });
      }
    });

    it('a direct call is refused for every application principal', async () => {
      for (const [name, pool] of principals()) {
        for (const fn of TRIGGER_ONLY) {
          const err = await rolledBack(pool, (c) => refusal(c.query(`SELECT public.${fn}()`)));
          expect(`${name}:${fn}:${err.code}`).toBe(`${name}:${fn}:42501`);
        }
      }
    });

    it('no application principal can attach any of the three to a temporary table of its own', async () => {
      for (const [name, pool] of principals()) {
        for (const fn of TRIGGER_ONLY) {
          const err = await rolledBack(pool, async (c) => {
            await c.query('CREATE TEMP TABLE c6_probe (id uuid) ON COMMIT DROP');
            return refusal(
              c.query(
                `CREATE TRIGGER c6_probe BEFORE INSERT ON c6_probe FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
              ),
            );
          });
          expect(`${name}:${fn}:${err.code}`).toBe(`${name}:${fn}:42501`);
        }
      }
    });

    it('the temp-table attack discloses no other tenant data and takes no cross-tenant role lock', async () => {
      // The victim: A2's role, granted at A2's workspace. The attacker: acc_app
      // inside A1 — a legitimate tenant context of another organization.
      const victimRole = a2.roles[TENANT_ROLE_KEYS.READ_ONLY]!;
      await grant(p.member3!.userId, victimRole, 'workspace', a2.workspaceId);
      const secrets = [a2.orgId, a2.workspaceId, victimRole, 'workspace'];
      const attacker = { orgId: a1.orgId, userId: p.adminA1!.userId };

      // P1 — the narrowing guard as a grant-topology oracle.
      await asApp(attacker, async (c) => {
        await c.query(
          'CREATE TEMP TABLE p1 (id uuid, key text, allowed_scope_types role_scope_type[]) ON COMMIT DROP',
        );
        const err = await refusal(
          c.query(
            'CREATE TRIGGER p1 BEFORE INSERT ON p1 FOR EACH ROW EXECUTE FUNCTION public.fn_roles_guard_allowed_scope_types()',
          ),
        );
        expect(err.code).toBe('42501');
        for (const s of secrets) expect(err.message).not.toContain(s);
      });

      // P2 — the grant validator as an organization-id oracle.
      await asApp(attacker, async (c) => {
        await c.query(
          'CREATE TEMP TABLE p2 (role_id uuid, scope_type role_scope_type, scope_id uuid, org_id uuid) ON COMMIT DROP',
        );
        const err = await refusal(
          c.query(
            'CREATE TRIGGER p2 BEFORE INSERT ON p2 FOR EACH ROW EXECUTE FUNCTION public.fn_validate_user_role_scope()',
          ),
        );
        expect(err.code).toBe('42501');
        for (const s of secrets) expect(err.message).not.toContain(s);
        // With no trigger the row is the caller's own data: nothing is derived.
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query(
          'CREATE TEMP TABLE p2b (role_id uuid, scope_type role_scope_type, scope_id uuid, org_id uuid) ON COMMIT DROP',
        );
        await c.query("INSERT INTO p2b VALUES ($1, 'workspace', $2, NULL)", [
          a1.roles[TENANT_ROLE_KEYS.READ_ONLY],
          a2.workspaceId,
        ]);
        const { rows } = await c.query('SELECT org_id FROM p2b');
        expect(rows[0]!.org_id).toBeNull();
      });

      // P3 — the validator's FOR SHARE as a cross-tenant lock. The attacker's
      // transaction stays open while the owner tries to lock the victim role.
      const attackerClient = await appPool.connect();
      try {
        await attackerClient.query('BEGIN');
        await attackerClient.query("SELECT set_config('app.current_org_id', $1, true)", [a1.orgId]);
        await attackerClient.query(
          'CREATE TEMP TABLE p3 (role_id uuid, scope_type role_scope_type, scope_id uuid, org_id uuid) ON COMMIT DROP',
        );
        await attackerClient.query('SAVEPOINT s');
        const err = await refusal(
          attackerClient.query(
            'CREATE TRIGGER p3 BEFORE INSERT ON p3 FOR EACH ROW EXECUTE FUNCTION public.fn_validate_user_role_scope()',
          ),
        );
        expect(err.code).toBe('42501');
        await attackerClient.query('ROLLBACK TO SAVEPOINT s');
        await attackerClient.query("INSERT INTO p3 VALUES ($1, 'organization', $2, NULL)", [
          victimRole,
          a2.orgId,
        ]);
        await asOwner(async (c) => {
          const { rowCount } = await c.query(
            'SELECT 1 FROM roles WHERE id = $1 FOR UPDATE NOWAIT',
            [victimRole],
          );
          expect(rowCount).toBe(1);
        });
      } finally {
        await attackerClient.query('ROLLBACK').catch(() => undefined);
        attackerClient.release();
      }
    });

    it('the real triggers still fire for acc_app, which holds no EXECUTE (checked at CREATE TRIGGER, never at firing)', async () => {
      const ctx = { orgId: a1.orgId, userId: p.adminA1!.userId };
      await resetNarrowRole();
      await asApp(ctx, async (c) => {
        const { rows } = await c.query(
          `SELECT has_function_privilege('fn_validate_user_role_scope()', 'EXECUTE') AS v,
                  has_function_privilege('fn_roles_guard_allowed_scope_types()', 'EXECUTE') AS g,
                  has_function_privilege('fn_organizations_guard_reseller_id()', 'EXECUTE') AS o`,
        );
        expect(rows[0]).toEqual({ v: false, g: false, o: false });

        // fn_validate_user_role_scope: admits, derives org_id, refuses.
        const ok = await c.query(
          `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
           VALUES ($1, $2, 'team', $3) RETURNING org_id`,
          [p.member!.userId, narrowRole, a1.teamId],
        );
        expect(ok.rows[0]!.org_id).toBe(a1.orgId);
        await c.query('SAVEPOINT s');
        const denied = await refusal(
          insertGrant(
            c,
            p.member!.userId,
            a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
            'team',
            a1.teamId,
          ),
        );
        expect(denied.constraint).toBe('user_roles_scope_type_admitted');
        await c.query('ROLLBACK TO SAVEPOINT s');

        // fn_roles_guard_allowed_scope_types: refuses stranding, allows the rest.
        const stranded = await refusal(
          c.query("UPDATE roles SET allowed_scope_types = '{organization}' WHERE id = $1", [
            narrowRole,
          ]),
        );
        expect(stranded.constraint).toBe('roles_allowed_scope_types_in_use');
        await c.query('ROLLBACK TO SAVEPOINT s');
        const narrowed = await c.query(
          "UPDATE roles SET allowed_scope_types = '{organization,team}' WHERE id = $1",
          [narrowRole],
        );
        expect(narrowed.rowCount).toBe(1);

        // fn_organizations_guard_reseller_id: refuses the move.
        await c.query('SAVEPOINT r');
        const moved = await refusal(
          c.query('UPDATE organizations SET reseller_id = $1 WHERE id = $2', [resellerB, a1.orgId]),
        );
        expect(moved.constraint).toBe('organizations_reseller_id_immutable');
      });
      expect(await grantsOf(narrowRole)).toEqual([]);
    });
  });

  // ===========================================================================
  describe('H. narrowing is refused outside READ COMMITTED (migration 0015, review H-2)', () => {
    beforeEach(() => resetNarrowRole());

    const narrow = (c: PoolClient, to = '{organization}') =>
      c.query('UPDATE roles SET allowed_scope_types = $1 WHERE id = $2', [to, narrowRole]);
    const ctx = () => ({ orgId: a1.orgId, userId: p.adminA1!.userId });
    const writers = () =>
      [
        ['owner', <T>(work: (c: PoolClient) => Promise<T>, iso: Isolation) => asOwner(work, iso)],
        [
          'acc_app',
          <T>(work: (c: PoolClient) => Promise<T>, iso: Isolation) => asApp(ctx(), work, iso),
        ],
      ] as const;
    const FULL = ['organization', 'workspace', 'team'];

    it('READ COMMITTED: a narrowing that strands nothing succeeds for owner and acc_app; a stranding one is refused', async () => {
      for (const [, as] of writers()) {
        await as(async (c) => {
          const { rows } = await c.query("SELECT current_setting('transaction_isolation') AS i");
          expect(rows[0]!.i).toBe('read committed');
          expect((await narrow(c)).rowCount).toBe(1);
        }, 'READ COMMITTED');
      }
      await grant(p.member!.userId, narrowRole, 'team', a1.teamId);
      for (const [, as] of writers()) {
        await as(async (c) => {
          expect((await refusal(narrow(c))).constraint).toBe('roles_allowed_scope_types_in_use');
        }, 'READ COMMITTED');
      }
    });

    it('READ COMMITTED: a grant committed after the narrowing transaction began is still seen, and the narrowing is refused', async () => {
      for (const [name, as] of writers()) {
        await resetNarrowRole();
        await as(async (c) => {
          await c.query('SELECT count(*) FROM roles'); // the transaction's first snapshot
          await grant(p.member!.userId, narrowRole, 'team', a1.teamId);
          const err = await refusal(narrow(c));
          expect(`${name}:${err.constraint}`).toBe(`${name}:roles_allowed_scope_types_in_use`);
        }, 'READ COMMITTED');
        expect(await strandedOf(narrowRole)).toBe(0);
      }
    });

    it('READ COMMITTED: a direct grant racing a direct narrowing that got there first waits, then is refused', async () => {
      const holder = await ownerPool.connect();
      await holder.query('BEGIN');
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await narrow(holder);
      const contender = asApp(ctx(), (c) =>
        insertGrant(c, p.member!.userId, narrowRole, 'team', a1.teamId),
      ).then(
        () => null,
        (e: PgError) => e,
      );
      let queued = false;
      try {
        const deadline = Date.now() + 10_000;
        while (!queued && Date.now() < deadline) {
          const { rows } = await h.admin.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY (pg_blocking_pids(pid))`,
          );
          queued = rows[0]!.n > 0;
          if (!queued) await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }
      expect(queued).toBe(true);
      expect((await contender)?.constraint).toBe('user_roles_scope_type_admitted');
      expect(await grantsOf(narrowRole)).toEqual([]);
    });

    for (const iso of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
      it(`${iso}: any narrowing is refused by the database guard, for owner and acc_app, and nothing changes`, async () => {
        const grantId = await grant(p.member!.userId, narrowRole, 'workspace', a1.workspaceId);
        const before = await grantsOf(narrowRole);
        for (const [name, as] of writers()) {
          // Strands nothing (only 'team' is dropped) — refused all the same.
          await as(async (c) => {
            const err = await refusal(narrow(c, '{organization,workspace}'));
            expect(`${name}:${err.code}:${err.constraint}`).toBe(
              `${name}:25000:roles_allowed_scope_types_narrowing_isolation`,
            );
            expect(err.message).toMatch(/requires READ COMMITTED isolation/);
          }, iso);
        }
        expect(await allowedOf(narrowRole)).toEqual(FULL);
        expect(await grantsOf(narrowRole)).toEqual(before);
        expect(before.map((g) => g.id)).toEqual([grantId]);
        expect(await strandedOf(narrowRole)).toBe(0);
      });

      it(`${iso}: the review's attack — a grant committed after the snapshot, then a narrowing past it — is refused, and no grant is stranded`, async () => {
        for (const [name, as] of writers()) {
          await resetNarrowRole();
          await as(async (c) => {
            await c.query('SELECT count(*) FROM roles'); // the transaction snapshot
            await grant(p.member!.userId, narrowRole, 'team', a1.teamId);
            const err = await refusal(narrow(c));
            expect(`${name}:${err.code}:${err.constraint}`).toBe(
              `${name}:25000:roles_allowed_scope_types_narrowing_isolation`,
            );
          }, iso);
          expect(await allowedOf(narrowRole)).toEqual(FULL);
          expect((await grantsOf(narrowRole)).map((g) => g.scope_type)).toEqual(['team']);
          expect(await strandedOf(narrowRole)).toBe(0);
        }
      });

      it(`${iso}: widening is not narrowing and is still allowed; a grant after a committed narrowing fails to serialize`, async () => {
        await h.admin.execute(
          sql`UPDATE roles SET allowed_scope_types = '{organization}' WHERE id = ${narrowRole}`,
        );
        for (const [, as] of writers()) {
          await as(async (c) => {
            expect((await narrow(c, '{organization,workspace,team}')).rowCount).toBe(1);
          }, iso);
        }
        await resetNarrowRole();
        for (const [name, as] of writers()) {
          await as(async (c) => {
            await c.query('SELECT count(*) FROM roles'); // the transaction snapshot
            await h.admin.execute(
              sql`UPDATE roles SET allowed_scope_types = '{organization}' WHERE id = ${narrowRole}`,
            );
            const err = await refusal(
              insertGrant(c, p.member!.userId, narrowRole, 'team', a1.teamId),
            );
            expect(`${name}:${err.code}`).toBe(`${name}:40001`);
          }, iso);
          await resetNarrowRole();
        }
        expect(await grantsOf(narrowRole)).toEqual([]);
      });
    }
  });
  // ===========================================================================
  describe('I. pre-existing SECURITY DEFINER trigger functions are trigger-only (migration 0016, review H-3)', () => {
    const PRE_EXISTING = [
      'fn_validate_audit_scope',
      'fn_validate_role_permission',
      'fn_protect_system_role_permissions',
      'fn_protect_system_roles',
      'fn_user_roles_platform_admin_guard',
      'fn_users_platform_admin_guard',
    ] as const;
    const principals = () =>
      [
        ['acc_app', appPool],
        ['acc_auth', authPool],
        ['acc_relay', relayPool],
      ] as const;
    async function rolledBack<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        return await work(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    const noExecute = async (c: PoolClient) =>
      (
        await c.query(
          `SELECT bool_or(has_function_privilege(f, 'EXECUTE')) AS any
           FROM unnest($1::text[]) AS f`,
          [PRE_EXISTING.map((f) => `${f}()`)],
        )
      ).rows[0]!.any as boolean;
    const ctxA1 = () => ({ orgId: a1.orgId, userId: p.adminA1!.userId });
    const platformCtx = () => ({ userId: p.platform!.userId, isPlatformAdmin: true });

    it('PUBLIC, acc_app, acc_auth and acc_relay hold no EXECUTE on any of the six; owner and SECURITY DEFINER unchanged', async () => {
      const { rows } = await h.admin.execute<{
        proname: string;
        owner: string;
        definer: boolean;
        pub: boolean;
        app: boolean;
        auth: boolean;
        relay: boolean;
      }>(sql`
        SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
               has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
               has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app,
               has_function_privilege('acc_auth', p.oid, 'EXECUTE') AS auth,
               has_function_privilege('acc_relay', p.oid, 'EXECUTE') AS relay
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
          AND p.proname = ANY (${`{${PRE_EXISTING.join(',')}}`}::text[])`);
      expect(rows.map((r) => r.proname).sort()).toEqual([...PRE_EXISTING].sort());
      const tableOwner = (
        await h.admin.execute<{ o: string }>(
          sql`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'public.user_roles'::regclass`,
        )
      ).rows[0]!.o;
      for (const r of rows) {
        expect({ ...r }).toEqual({
          proname: r.proname,
          owner: tableOwner,
          definer: true,
          pub: false,
          app: false,
          auth: false,
          relay: false,
        });
      }
    });

    it('a direct call is refused for every application principal', async () => {
      for (const [name, pool] of principals()) {
        for (const fn of PRE_EXISTING) {
          const err = await rolledBack(pool, (c) => refusal(c.query(`SELECT public.${fn}()`)));
          expect(`${name}:${fn}:${err.code}`).toBe(`${name}:${fn}:42501`);
        }
      }
    });

    it('no application principal can attach any of the six to a temporary table of its own', async () => {
      for (const [name, pool] of principals()) {
        for (const fn of PRE_EXISTING) {
          const err = await rolledBack(pool, async (c) => {
            await c.query('CREATE TEMP TABLE c6_probe (id uuid) ON COMMIT DROP');
            return refusal(
              c.query(
                `CREATE TRIGGER c6_probe BEFORE INSERT ON c6_probe FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
              ),
            );
          });
          expect(`${name}:${fn}:${err.code}`).toBe(`${name}:${fn}:42501`);
        }
      }
    });

    it('the demonstrated temp-table disclosures and the advisory-lock path are no longer reachable', async () => {
      // The attacker is acc_app inside A1; the victims are A2's team and role,
      // and the platform role set.
      const secrets = [a2.orgId, a2.workspaceId, a2.teamId, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN];
      const cases = [
        {
          fn: 'fn_validate_audit_scope',
          ddl: 'CREATE TEMP TABLE x (scope_type text, scope_id uuid, reseller_id uuid, org_id uuid, workspace_id uuid, team_id uuid) ON COMMIT DROP',
          dml: "INSERT INTO x (scope_type, scope_id) VALUES ('team', $1)",
          params: [a2.teamId],
          timing: 'BEFORE INSERT',
        },
        {
          fn: 'fn_validate_role_permission',
          ddl: 'CREATE TEMP TABLE x (role_id uuid, permission_id uuid, org_id uuid) ON COMMIT DROP',
          dml: 'INSERT INTO x (role_id) VALUES ($1)',
          params: [a2.roles[TENANT_ROLE_KEYS.READ_ONLY]],
          timing: 'BEFORE INSERT',
        },
        {
          fn: 'fn_protect_system_role_permissions',
          ddl: 'CREATE TEMP TABLE x (role_id uuid, permission_id uuid, org_id uuid) ON COMMIT DROP',
          dml: "INSERT INTO x (role_id) VALUES ((SELECT id FROM roles WHERE key = 'alendei_super_admin'))",
          params: [],
          timing: 'BEFORE INSERT',
        },
        {
          fn: 'fn_protect_system_roles',
          ddl: 'CREATE TEMP TABLE x (key text, is_system_role boolean) ON COMMIT DROP',
          dml: "INSERT INTO x VALUES ('k', true)",
          params: [],
          timing: 'BEFORE INSERT',
        },
        {
          fn: 'fn_users_platform_admin_guard',
          ddl: 'CREATE TEMP TABLE x (id uuid) ON COMMIT DROP',
          dml: 'INSERT INTO x VALUES ($1)',
          params: [p.platform!.userId],
          timing: 'AFTER INSERT',
        },
        {
          fn: 'fn_user_roles_platform_admin_guard',
          ddl: 'CREATE TEMP TABLE x (scope_type role_scope_type) ON COMMIT DROP',
          dml: "INSERT INTO x VALUES ('platform')",
          params: [],
          timing: 'AFTER INSERT',
        },
      ];
      for (const t of cases) {
        await asApp(ctxA1(), async (c) => {
          await c.query(t.ddl);
          await c.query('SAVEPOINT s');
          const err = await refusal(
            c.query(
              `CREATE TRIGGER x ${t.timing} ON x FOR EACH ROW EXECUTE FUNCTION public.${t.fn}()`,
            ),
          );
          expect(`${t.fn}:${err.code}`).toBe(`${t.fn}:42501`);
          for (const secret of secrets) expect(err.message).not.toContain(secret);
          await c.query('ROLLBACK TO SAVEPOINT s');
          // Without the trigger the row stays the caller's own data: nothing
          // derived, nothing raised, no lock taken as the owner.
          await c.query(t.dml, t.params);
          const { rows } = await c.query('SELECT * FROM x');
          const derivable = secrets.filter((secret) => !(t.params as unknown[]).includes(secret));
          for (const secret of derivable) expect(JSON.stringify(rows)).not.toContain(secret);
          const locks = await c.query(
            "SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'",
          );
          expect(`${t.fn}:${locks.rows[0]!.n}`).toBe(`${t.fn}:0`);
        });
      }
    });

    it('trg_audit_logs_validate_scope still derives tenancy and refuses a bad scope, for acc_app and acc_auth', async () => {
      const row = (scopeType: string, scopeId: string | null, action = 'c6.h3.probe') => [
        scopeType,
        scopeId,
        action,
        uuidv7(),
      ];
      const insert = `INSERT INTO audit_logs (scope_type, scope_id, actor_type, actor_user_id, action, resource_type, outcome, correlation_id)
        VALUES ($1, $2, 'user', '${p.adminA1!.userId}', $3, 'probe', 'success', $4)`;
      await asApp(ctxA1(), async (c) => {
        expect(await noExecute(c)).toBe(false);
        const ok = await c.query(`${insert} RETURNING org_id, workspace_id, team_id`, [
          ...row('team', a1.teamId),
        ]);
        expect(ok.rows[0]).toEqual({
          org_id: a1.orgId,
          workspace_id: a1.workspaceId,
          team_id: a1.teamId,
        });
        await c.query('SAVEPOINT s');
        const missing = await refusal(c.query(insert, row('team', uuidv7())));
        expect(missing.code).toBe('23503');
        expect(missing.message).toMatch(/team scope .* does not exist/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        // The trigger derives A2 from A2's team; RLS then refuses the row.
        const foreign = await refusal(c.query(insert, row('team', a2.teamId)));
        expect(foreign.code).toBe('42501');
      });
      await rolledBack(authPool, async (c) => {
        expect(await noExecute(c)).toBe(false);
        const ok = await c.query(insert, row('platform', null, 'auth.login.failed'));
        expect(ok.rowCount).toBe(1);
        await c.query('SAVEPOINT s');
        const shape = await refusal(
          c.query(insert, row('platform', a1.orgId, 'auth.login.failed')),
        );
        expect(shape.message).toMatch(/platform scope carries no scope_id/);
      });
    });

    it('trg_role_permissions_validate and trg_role_permissions_protect_system still fire for acc_app', async () => {
      const perm = async (platform: boolean) =>
        (
          await h.admin.execute<{ id: string }>(
            platform
              ? sql`SELECT id FROM permissions WHERE key LIKE 'platform.%' ORDER BY key LIMIT 1`
              : sql`SELECT id FROM permissions WHERE key NOT LIKE 'platform.%' AND key <> 'workspaces.read' ORDER BY key LIMIT 1`,
          )
        ).rows[0]!.id;
      const tenantPerm = await perm(false);
      const platformPerm = await perm(true);
      const systemRole = a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      await asApp(ctxA1(), async (c) => {
        expect(await noExecute(c)).toBe(false);
        const ok = await c.query(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) RETURNING org_id',
          [narrowRole, tenantPerm],
        );
        expect(ok.rows[0]!.org_id).toBe(a1.orgId);
        await c.query('SAVEPOINT s');
        const platform = await refusal(
          c.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [
            narrowRole,
            platformPerm,
          ]),
        );
        expect(platform.code).toBe('42501');
        expect(platform.message).toMatch(
          /platform permission .* cannot be attached to tenant role/,
        );
        await c.query('ROLLBACK TO SAVEPOINT s');
        const system = await refusal(
          c.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [
            systemRole,
            tenantPerm,
          ]),
        );
        expect(system.code).toBe('42501');
        expect(system.message).toMatch(/has a fixed permission set/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        const removal = await refusal(
          c.query('DELETE FROM role_permissions WHERE role_id = $1', [systemRole]),
        );
        expect(removal.message).toMatch(/has a fixed permission set/);
      });
    });

    it('trg_roles_protect_system still refuses modifying or deleting a system role for acc_app, and allows a custom role', async () => {
      const systemRole = a1.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      await asApp(ctxA1(), async (c) => {
        expect(await noExecute(c)).toBe(false);
        const renamed = await c.query("UPDATE roles SET name = name || ' ' WHERE id = $1", [
          narrowRole,
        ]);
        expect(renamed.rowCount).toBe(1);
        await c.query('SAVEPOINT s');
        const modified = await refusal(
          c.query("UPDATE roles SET name = 'x' WHERE id = $1", [systemRole]),
        );
        expect(modified.code).toBe('42501');
        expect(modified.message).toMatch(/cannot be modified/);
        await c.query('ROLLBACK TO SAVEPOINT s');
        const deleted = await refusal(c.query('DELETE FROM roles WHERE id = $1', [systemRole]));
        expect(deleted.code).toBe('42501');
        expect(deleted.message).toMatch(/cannot be deleted/);
      });
    });

    it('the platform-admin liveness triggers (user_roles delete and update, users status) still fire for acc_app', async () => {
      const superAdmin = await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
      const support = await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT);
      await asApp(platformCtx(), async (c) => {
        expect(await noExecute(c)).toBe(false);
        // A non-administrator's status change passes fn_users_platform_admin_guard.
        const disabled = await c.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
          p.member!.userId,
        ]);
        expect(disabled.rowCount).toBe(1);
        // Removing every other super-admin grant passes the liveness check
        // (trg_user_roles_platform_admin_liveness fires and admits it) ...
        await c.query(
          "DELETE FROM user_roles WHERE scope_type = 'platform' AND role_id = $1 AND user_id <> $2",
          [superAdmin, p.platform!.userId],
        );
        const { rows } = await c.query(
          "SELECT id FROM user_roles WHERE scope_type = 'platform' AND role_id = $1 AND user_id = $2",
          [superAdmin, p.platform!.userId],
        );
        const lastGrant = rows[0]!.id as string;
        // ... and the last one is then protected on every path.
        for (const [label, statement, params] of [
          [
            'users status',
            "UPDATE users SET status = 'disabled' WHERE id = $1",
            [p.platform!.userId],
          ],
          ['user_roles delete', 'DELETE FROM user_roles WHERE id = $1', [lastGrant]],
          [
            'user_roles update',
            'UPDATE user_roles SET role_id = $1 WHERE id = $2',
            [support, lastGrant],
          ],
        ] as const) {
          await c.query('SAVEPOINT s');
          const err = await refusal(c.query(statement, [...params]));
          expect(`${label}:${err.code}`).toBe(`${label}:23001`);
          expect(err.message).toMatch(/no active administrator/);
          await c.query('ROLLBACK TO SAVEPOINT s');
        }
      });
    });
  });
});
