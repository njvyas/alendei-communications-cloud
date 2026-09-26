/**
 * Workspace and team boundaries — verified, not restated (ADR-011 D-4, Gate-B
 * final verification).
 *
 * The decision under test: **organization is the PostgreSQL isolation boundary;
 * workspace and team are application authorization boundaries.** So this suite
 * proves both halves explicitly:
 *
 *   - over HTTP, a workspace- or team-scoped principal cannot act on a sibling
 *     workspace or team, and cannot reach the organization above it;
 *   - directly as `acc_app`, under the context the resolver computes for such a
 *     principal, RLS *does* admit sibling workspaces and teams of the same
 *     organization (by design) and does *not* admit another organization.
 *
 *     Org O ── Workspace 1 ── Team 1, Team 2
 *           └─ Workspace 2 ── Team 3
 *     Org X (different reseller) — the organization-boundary control
 */
import { ERROR_CODES, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema, type TenantSession, type Transaction } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { ScopeResolver } from '../src/auth/scope-resolver.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { CredentialService } from '../src/iam/credential.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';

interface Org {
  orgId: string;
  resellerId: string;
  ws1: string;
  ws2: string;
  t1: string;
  t2: string;
  t3: string;
  roles: Record<string, string>;
}

describe('workspace and team boundaries (API authorization vs. organization-scoped RLS)', () => {
  let h: Harness;
  let db: TenantDatabase;
  let resolver: ScopeResolver;
  let credentials: CredentialService;
  let o: Org;
  let x: Org;
  const users: Record<string, { userId: string; email: string }> = {};
  const tokens: Record<string, string> = {};
  const audit: Record<string, string> = {};
  const assignments: Record<string, string> = {};
  const createdUsers: string[] = [];
  const resellers: string[] = [];

  const url = (p: string) => `/${PREFIX}${p}`;

  async function createUser(label: string) {
    const email = `${label}-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;
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
    scopeType: 'organization' | 'workspace' | 'team',
    scopeId: string,
  ) {
    const [row] = await h.admin
      .insert(schema.userRoles)
      .values({ userId, roleId, scopeType, scopeId })
      .returning({ id: schema.userRoles.id });
    return row!.id;
  }

  async function createOrg(label: string): Promise<Org> {
    const slug = `${label}-${uuidv7().replace(/-/g, '').slice(-10)}`;
    const [reseller] = await h.admin
      .insert(schema.resellers)
      .values({ name: `R ${slug}`, slug: `rs-${slug}` })
      .returning({ id: schema.resellers.id });
    resellers.push(reseller!.id);
    const [org] = await h.admin
      .insert(schema.organizations)
      .values({ name: `O ${slug}`, slug: `org-${slug}`, resellerId: reseller!.id })
      .returning({ id: schema.organizations.id });
    const orgId = org!.id;
    const ws = async (name: string) =>
      (
        await h.admin
          .insert(schema.workspaces)
          .values({ orgId, name, slug: name.toLowerCase() })
          .returning({ id: schema.workspaces.id })
      )[0]!.id;
    const ws1 = await ws('One');
    const ws2 = await ws('Two');
    const team = async (workspaceId: string, name: string) =>
      (
        await h.admin
          .insert(schema.teams)
          .values({ orgId, workspaceId, name })
          .returning({ id: schema.teams.id })
      )[0]!.id;
    const t1 = await team(ws1, 'T1');
    const t2 = await team(ws1, 'T2');
    const t3 = await team(ws2, 'T3');

    const provisioner = h.app.get(TenantRoleProvisioner);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await provisioner.seedTenantRoles(tx as unknown as Transaction, orgId, {
        correlationId: uuidv7(),
      });
    });
    // A custom role designed for team scope that can administer grants — the
    // strongest team-level principal a tenant can compose.
    const [lead] = await h.admin
      .insert(schema.roles)
      .values({ orgId, key: 'team_lead', name: 'Team lead', allowedScopeTypes: ['team'] })
      .returning({ id: schema.roles.id });
    await h.admin.execute(sql`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT ${lead!.id}, id FROM permissions WHERE key IN
        ('role_assignments.grant','role_assignments.revoke','role_assignments.read',
         'workspaces.read','teams.read','users.read','audit.read')`);
    const rows = await h.admin
      .select({ id: schema.roles.id, key: schema.roles.key })
      .from(schema.roles)
      .where(eq(schema.roles.orgId, orgId));
    return {
      orgId,
      resellerId: reseller!.id,
      ws1,
      ws2,
      t1,
      t2,
      t3,
      roles: Object.fromEntries(rows.map((r) => [r.key, r.id])),
    };
  }

  async function plantAudit(scopeType: string, scopeId: string): Promise<string> {
    const { rows } = await h.admin.execute<{ id: string }>(sql`
      INSERT INTO audit_logs (scope_type, scope_id, actor_type, actor_label, action, resource_type, outcome, correlation_id)
      VALUES (${scopeType}::role_scope_type, ${scopeId}, 'system', 'test', 'organization.updated', 'organization', 'success', ${uuidv7()})
      RETURNING id`);
    return rows[0]!.id;
  }

  async function login(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  beforeAll(async () => {
    h = await startHarness();
    db = h.app.get(TenantDatabase);
    resolver = h.app.get(ScopeResolver);
    credentials = h.app.get(CredentialService);
    o = await createOrg('wt-o');
    x = await createOrg('wt-x');

    users.wsManager = await createUser('ws1-manager');
    await grant(
      users.wsManager.userId,
      o.roles[TENANT_ROLE_KEYS.WORKSPACE_MANAGER]!,
      'workspace',
      o.ws1,
    );
    users.wsReader = await createUser('ws1-reader');
    await grant(users.wsReader.userId, o.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'workspace', o.ws1);
    users.teamLead = await createUser('t1-lead');
    await grant(users.teamLead.userId, o.roles.team_lead!, 'team', o.t1);
    users.teamReader = await createUser('t1-reader');
    await grant(users.teamReader.userId, o.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'team', o.t1);
    // Targets: members of the organization, so they are reachable for a grant.
    users.target1 = await createUser('target-1');
    await grant(users.target1.userId, o.roles[TENANT_ROLE_KEYS.AGENT]!, 'organization', o.orgId);
    users.target2 = await createUser('target-2');
    await grant(users.target2.userId, o.roles[TENANT_ROLE_KEYS.AGENT]!, 'organization', o.orgId);
    assignments.ws2 = await grant(
      users.target1.userId,
      o.roles[TENANT_ROLE_KEYS.AGENT]!,
      'workspace',
      o.ws2,
    );
    assignments.t2 = await grant(
      users.target2.userId,
      o.roles[TENANT_ROLE_KEYS.AGENT]!,
      'team',
      o.t2,
    );

    for (const [k, t, id] of [
      ['org', 'organization', o.orgId],
      ['ws1', 'workspace', o.ws1],
      ['ws2', 'workspace', o.ws2],
      ['t1', 'team', o.t1],
      ['t2', 'team', o.t2],
      ['t3', 'team', o.t3],
      ['x', 'organization', x.orgId],
    ] as const) {
      audit[k] = await plantAudit(t, id);
    }

    for (const name of ['wsManager', 'wsReader', 'teamLead', 'teamReader'])
      tokens[name] = await login(users[name]!.email);
  }, 120_000);

  afterAll(async () => {
    // Sign-ins and denials write rows naming these users as actors (sign-ins at
    // platform scope), so they go with the organizations' own trail.
    await purgeAudit(
      h.admin,
      sql`org_id IN (${o.orgId}, ${x.orgId}) OR actor_user_id IN (${sql.join(
        createdUsers.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
    await h.admin.execute(
      sql`DELETE FROM sessions WHERE user_id IN (${sql.join(
        createdUsers.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      for (const org of [o, x]) {
        for (const table of ['user_roles', 'role_permissions', 'roles', 'teams', 'workspaces']) {
          await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id = ${org.orgId}`);
        }
      }
    });
    await h.admin.execute(sql`DELETE FROM organizations WHERE id IN (${o.orgId}, ${x.orgId})`);
    if (createdUsers.length)
      await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await h.admin.execute(
      sql`DELETE FROM resellers WHERE id IN (${resellers[0]!}, ${resellers[1]!})`,
    );
    await h.close();
  }, 120_000);

  const call = (method: 'get' | 'post' | 'delete', token: string, path: string) =>
    request(h.app.getHttpServer())[method](url(path)).set('authorization', `Bearer ${token}`);
  const grantAs = (token: string, userId: string, scopeType: string, scopeId: string) =>
    call('post', token, '/role-assignments').send({
      userId,
      roleId: o.roles[TENANT_ROLE_KEYS.AGENT],
      scopeType,
      scopeId,
    });

  // ===========================================================================
  describe('Workspace 1 → Workspace 2 through API authorization', () => {
    it('positive control: the workspace manager grants inside its own workspace and its teams', async () => {
      await grantAs(tokens.wsManager!, users.target1!.userId, 'workspace', o.ws1).expect(201);
      await grantAs(tokens.wsManager!, users.target1!.userId, 'team', o.t1).expect(201);
    });

    it('cannot grant at the sibling workspace or at a team inside it', async () => {
      for (const [type, id] of [
        ['workspace', o.ws2],
        ['team', o.t3],
      ] as const) {
        const res = await grantAs(tokens.wsManager!, users.target2!.userId, type, id);
        expect(`${type}:${res.status}:${res.body.error?.code}`).toBe(
          `${type}:403:${ERROR_CODES.AUTHZ_SCOPE_DENIED}`,
        );
      }
    });

    it('cannot revoke a grant held at the sibling workspace, and nothing is removed', async () => {
      const res = await call('delete', tokens.wsManager!, `/role-assignments/${assignments.ws2}`);
      expect(res.status).toBe(403);
      const [still] = await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.id, assignments.ws2!));
      expect(still).toBeDefined();
    });

    it('a workspace reader reads its workspace’s and teams’ audit records, and not the sibling’s', async () => {
      const status = async (key: string) =>
        (await call('get', tokens.wsReader!, `/audit-logs/${audit[key]}`)).status;
      expect({
        ws1: await status('ws1'),
        t1: await status('t1'),
        ws2: await status('ws2'),
        t3: await status('t3'),
      }).toEqual({
        ws1: 200,
        t1: 200,
        ws2: 403,
        t3: 403,
      });
    });
  });

  describe('Team 1 → Team 2 through API authorization', () => {
    it('positive control: the team lead grants inside its own team', async () => {
      await grantAs(tokens.teamLead!, users.target2!.userId, 'team', o.t1).expect(201);
    });

    it('cannot grant at a sibling team in the same workspace or in another workspace', async () => {
      for (const id of [o.t2, o.t3]) {
        const res = await grantAs(tokens.teamLead!, users.target1!.userId, 'team', id);
        expect(`${id === o.t2 ? 't2' : 't3'}:${res.status}`).toBe(
          `${id === o.t2 ? 't2' : 't3'}:403`,
        );
      }
    });

    it('cannot revoke a grant held at a sibling team', async () => {
      expect(
        (await call('delete', tokens.teamLead!, `/role-assignments/${assignments.t2}`)).status,
      ).toBe(403);
    });

    it('a team reader reads its team’s audit records only', async () => {
      const status = async (key: string) =>
        (await call('get', tokens.teamReader!, `/audit-logs/${audit[key]}`)).status;
      expect({ t1: await status('t1'), t2: await status('t2'), ws1: await status('ws1') }).toEqual({
        t1: 200,
        t2: 403,
        ws1: 403,
      });
    });
  });

  describe('no escalation from workspace or team to the organization', () => {
    it('a workspace manager cannot grant at the organization, nor read organization-level surfaces', async () => {
      expect(
        (await grantAs(tokens.wsManager!, users.target2!.userId, 'organization', o.orgId)).status,
      ).toBe(403);
      for (const path of ['/tenants/workspaces', '/api-keys', '/role-assignments', '/audit-logs']) {
        expect(`${path}:${(await call('get', tokens.wsManager!, path)).status}`).toBe(
          `${path}:403`,
        );
      }
    });

    it('a team lead cannot grant at its workspace or at the organization', async () => {
      expect(
        (await grantAs(tokens.teamLead!, users.target1!.userId, 'workspace', o.ws1)).status,
      ).toBe(403);
      expect(
        (await grantAs(tokens.teamLead!, users.target1!.userId, 'organization', o.orgId)).status,
      ).toBe(403);
      expect((await call('get', tokens.teamLead!, '/role-assignments')).status).toBe(403);
    });

    it('workspace and team readers cannot read organization-level audit records', async () => {
      expect((await call('get', tokens.wsReader!, `/audit-logs/${audit.org}`)).status).toBe(403);
      expect((await call('get', tokens.teamReader!, `/audit-logs/${audit.org}`)).status).toBe(403);
    });

    it('another organization is invisible, not merely refused (404)', async () => {
      expect((await call('get', tokens.wsReader!, `/audit-logs/${audit.x}`)).status).toBe(404);
      expect(
        (await grantAs(tokens.wsManager!, users.target1!.userId, 'workspace', x.ws1)).status,
      ).toBe(404);
    });
  });

  // ===========================================================================
  describe('directly as acc_app: RLS is organization-scoped by design', () => {
    async function contextFor(userId: string): Promise<TenantSession> {
      const tenant = await db.auth.transaction(async (raw) => {
        const tx = raw as Transaction;
        const scopes = await resolver.forUser(tx, userId);
        return resolver.tenantContextFor(tx, scopes, resolver.selectOrganization(scopes, null));
      });
      return { ...tenant, userId };
    }

    const visible = (session: TenantSession, table: 'workspaces' | 'teams', ids: string[]) =>
      db.withTenant(session, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(
          sql.raw(`SELECT id::text AS id FROM ${table}`),
        );
        return ids.filter((id) => rows.some((r) => r.id === id));
      });

    it('a workspace-scoped principal’s context admits the sibling workspace and its team — RLS stops at organization', async () => {
      const ctx = await contextFor(users.wsManager!.userId);
      expect(ctx.orgId).toBe(o.orgId);
      expect(ctx.workspaceId).toBe(o.ws1);
      expect(await visible(ctx, 'workspaces', [o.ws1, o.ws2])).toEqual([o.ws1, o.ws2]);
      expect(await visible(ctx, 'teams', [o.t1, o.t2, o.t3])).toEqual([o.t1, o.t2, o.t3]);
    });

    it('a team-scoped principal’s context admits sibling teams — RLS stops at organization', async () => {
      const ctx = await contextFor(users.teamLead!.userId);
      expect(await visible(ctx, 'teams', [o.t1, o.t2, o.t3])).toEqual([o.t1, o.t2, o.t3]);
    });

    it('the same contexts admit nothing of another organization — the database boundary', async () => {
      for (const name of ['wsManager', 'teamLead', 'wsReader', 'teamReader']) {
        const ctx = await contextFor(users[name]!.userId);
        expect(`${name}:${(await visible(ctx, 'workspaces', [x.ws1, x.ws2])).length}`).toBe(
          `${name}:0`,
        );
        expect(`${name}:${(await visible(ctx, 'teams', [x.t1, x.t2, x.t3])).length}`).toBe(
          `${name}:0`,
        );
      }
    });
  });
});
