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

  /** Runs `work` as `acc_app` with the given tenant context, then rolls back. */
  async function asApp<T>(session: AppSession, work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
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
  async function asOwner<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await ownerPool.connect();
    try {
      await c.query('BEGIN');
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
});
