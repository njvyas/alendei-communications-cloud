/**
 * Phase 1C.1b — workspace and team administration and lifecycle
 * (`FRONTEND_API_CONTRACT.md` §31b–§31c, ADR-012 F-5, F-6, F-7, OD-5).
 *
 * Topology:
 *
 *   Reseller A ─┬─ A1 ─┬─ default workspace
 *               │      ├─ W1 ─┬─ T1   (team lead, team reader)
 *               │      │      └─ T2
 *               │      └─ W2 ─── T3
 *               ├─ A2 ─── WA2 ── TA2
 *               ├─ S  (suspended) ── WS (archived)
 *               └─ C  (closed)    ── WC
 *   Reseller B ─── B1 ─── WB ─── TB
 *
 * Organization is the PostgreSQL isolation boundary; workspace and team are
 * application authorization boundaries inside it (ADR-011 D-4). The HTTP cases
 * prove the application boundary; the "RLS backstop" cases prove the database
 * boundary holds when the application's authorization is deliberately widened.
 */
import { AUDIT_ACTIONS, ERROR_CODES, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema, type TenantSession, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { PermissionEvaluator } from '../src/auth/permission-evaluator.service';
import { RequestContext } from '../src/common/context/request-context';
import { AppException } from '../src/common/errors/app.exception';
import { ScopeResolver } from '../src/auth/scope-resolver.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { CredentialService } from '../src/iam/credential.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { TeamAdministrationService } from '../src/workspaces/team-administration.service';
import { WorkspaceAdministrationService } from '../src/workspaces/workspace-administration.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';

interface Org {
  orgId: string;
  roles: Record<string, string>;
  defaultWorkspace: string;
  admin: { userId: string; email: string };
}

type Method = 'get' | 'post' | 'patch' | 'delete';

describe('workspace and team administration (1C.1b)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let db: TenantDatabase;
  let resolver: ScopeResolver;
  let resellerA: string;
  let resellerB: string;
  let a1: Org;
  let a2: Org;
  let b1: Org;
  let s: Org;
  let c: Org;
  const ws: Record<string, string> = {};
  const tm: Record<string, string> = {};
  const people: Record<string, { userId: string; email: string }> = {};
  const tokens: Record<string, string> = {};
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];
  const createdResellers: string[] = [];

  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => uuidv7().replace(/-/g, '').slice(-10);

  // --- fixtures ---------------------------------------------------------------

  async function createUser(label: string) {
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
  ) {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({ userId, roleId, scopeType, scopeId });
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
    const [def] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId, name: 'Default', slug: 'default', isDefault: true })
      .returning({ id: schema.workspaces.id });
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
    const roles = Object.fromEntries(rows.map((r) => [r.key, r.id]));
    const admin = await createUser(`${label}-admin`);
    await grant(admin.userId, roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, 'organization', orgId);
    return { orgId, roles, defaultWorkspace: def!.id, admin };
  }

  async function plantWorkspace(
    orgId: string,
    slug: string,
    status: 'active' | 'archived' = 'active',
  ) {
    const [row] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId, name: `WS ${slug}`, slug, status })
      .returning({ id: schema.workspaces.id });
    return row!.id;
  }

  async function plantTeam(orgId: string, workspaceId: string, name: string) {
    const [row] = await h.admin
      .insert(schema.teams)
      .values({ orgId, workspaceId, name })
      .returning({ id: schema.teams.id });
    return row!.id;
  }

  async function login(email: string) {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  const call = (method: Method, token: string, path: string, org?: string, key?: string) => {
    let r = request(h.app.getHttpServer())
      [method](url(path))
      .set('authorization', `Bearer ${token}`);
    if (org) r = r.set('x-acc-organization', org);
    if (key) r = r.set('idempotency-key', key);
    return r;
  };

  const wsRow = async (id: string) =>
    (await h.admin.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)))[0];
  const teamRow = async (id: string) =>
    (await h.admin.select().from(schema.teams).where(eq(schema.teams.id, id)))[0];
  const auditRows = async (resourceId: string, action: string) =>
    (
      await h.admin.execute<Record<string, unknown>>(
        sql`SELECT * FROM audit_logs WHERE resource_id = ${resourceId} AND action = ${action} ORDER BY id`,
      )
    ).rows;
  const deniedAudit = async (actorUserId: string, attemptedScopeId: string) =>
    (
      await h.admin.execute<Record<string, unknown>>(
        sql`SELECT * FROM audit_logs WHERE actor_user_id = ${actorUserId}
            AND action = ${AUDIT_ACTIONS.AUTHORIZATION_DENIED}
            AND metadata->>'attemptedScopeId' = ${attemptedScopeId}`,
      )
    ).rows;

  const ids = (body: { data: { id: string }[] }) => body.data.map((o) => o.id);
  const strip = (b: { error: Record<string, unknown> }) => ({ ...b.error, correlationId: 0 });

  const WORKSPACE_KEYS = [
    'createdAt',
    'id',
    'isDefault',
    'name',
    'orgId',
    'slug',
    'status',
    'updatedAt',
  ];
  const TEAM_KEYS = ['createdAt', 'id', 'name', 'orgId', 'status', 'updatedAt', 'workspaceId'];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    db = h.app.get(TenantDatabase);
    resolver = h.app.get(ScopeResolver);

    resellerA = await createReseller('wt-a');
    resellerB = await createReseller('wt-b');
    a1 = await plantOrg('wt-a1', resellerA);
    a2 = await plantOrg('wt-a2', resellerA);
    b1 = await plantOrg('wt-b1', resellerB);
    s = await plantOrg('wt-s', resellerA);
    c = await plantOrg('wt-c', resellerA);

    ws.w1 = await plantWorkspace(a1.orgId, 'one');
    ws.w2 = await plantWorkspace(a1.orgId, 'two');
    ws.wa2 = await plantWorkspace(a2.orgId, 'a2-one');
    ws.wb = await plantWorkspace(b1.orgId, 'b-one');
    ws.ws = await plantWorkspace(s.orgId, 's-one', 'archived');
    ws.wc = await plantWorkspace(c.orgId, 'c-one');
    tm.t1 = await plantTeam(a1.orgId, ws.w1, 'T1');
    tm.t2 = await plantTeam(a1.orgId, ws.w1, 'T2');
    tm.t3 = await plantTeam(a1.orgId, ws.w2, 'T3');
    tm.ta2 = await plantTeam(a2.orgId, ws.wa2, 'TA2');
    tm.tb = await plantTeam(b1.orgId, ws.wb, 'TB');
    await h.admin
      .update(schema.organizations)
      .set({ status: 'suspended' })
      .where(eq(schema.organizations.id, s.orgId));
    await h.admin
      .update(schema.organizations)
      .set({ status: 'closed' })
      .where(eq(schema.organizations.id, c.orgId));

    // A custom team-scoped role holding team administration — the strongest
    // team-level principal a tenant can compose.
    const [lead] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: a1.orgId,
        key: 'team_lead',
        name: 'Team lead',
        allowedScopeTypes: ['team'],
      })
      .returning({ id: schema.roles.id });
    await h.admin.execute(sql`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT ${lead!.id}, id FROM permissions WHERE key IN
        ('workspaces.read','teams.read','teams.update','teams.create','users.read')`);

    people.wsManager = await createUser('wt-wsm');
    await grant(
      people.wsManager.userId,
      a1.roles[TENANT_ROLE_KEYS.WORKSPACE_MANAGER]!,
      'workspace',
      ws.w1,
    );
    people.wsReader = await createUser('wt-wsr');
    await grant(people.wsReader.userId, a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'workspace', ws.w1);
    people.teamReader = await createUser('wt-tr');
    await grant(people.teamReader.userId, a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'team', tm.t1);
    people.teamLead = await createUser('wt-tl');
    await grant(people.teamLead.userId, lead!.id, 'team', tm.t1);
    people.orgReader = await createUser('wt-or');
    await grant(
      people.orgReader.userId,
      a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!,
      'organization',
      a1.orgId,
    );
    people.target = await createUser('wt-target');
    await grant(people.target.userId, a1.roles[TENANT_ROLE_KEYS.AGENT]!, 'organization', a1.orgId);

    people.platform = await createUser('wt-platform');
    await grant(
      people.platform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    people.support = await createUser('wt-support');
    await grant(
      people.support.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );
    people.resellerA = await createUser('wt-ra');
    await grant(
      people.resellerA.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerA,
    );
    people.resellerB = await createUser('wt-rb');
    await grant(
      people.resellerB.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerB,
    );

    for (const [name, person] of Object.entries(people)) tokens[name] = await login(person.email);
    for (const [name, org] of Object.entries({ a1, a2, b1, s, c }))
      tokens[name] = await login(org.admin.email);
  }, 180_000);

  afterAll(async () => {
    await h.clearRateLimits();
    const orgs = [...new Set(createdOrgs)];
    const list = (values: string[]) =>
      sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      );
    await purgeAudit(
      h.admin,
      sql`org_id IN (${list(orgs)}) OR actor_user_id IN (${list(createdUsers)}) OR actor_api_key_id IN (SELECT id FROM api_keys WHERE org_id IN (${list(orgs)})) OR reseller_id IN (${list(createdResellers)})`,
    );
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
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await h.admin.execute(sql`DELETE FROM organizations WHERE id IN (${list(orgs)})`);
    await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await h.admin.delete(schema.resellers).where(inArray(schema.resellers.id, createdResellers));
    await h.close();
  }, 180_000);

  // ===========================================================================
  describe('positive paths', () => {
    it('an organization administrator creates, reads, lists, renames, archives and restores a workspace and its team', async () => {
      const slug = `ws-${suffix()}`;
      const created = await call('post', tokens.a1!, '/workspaces')
        .send({ name: 'Brand One', slug })
        .expect(201);
      const w = created.body.data;
      expect(Object.keys(w).sort()).toEqual(WORKSPACE_KEYS);
      expect(w).toMatchObject({ orgId: a1.orgId, slug, status: 'active', isDefault: false });
      expect(await auditRows(w.id, AUDIT_ACTIONS.WORKSPACE_CREATED)).toHaveLength(1);

      expect((await call('get', tokens.a1!, `/workspaces/${w.id}`).expect(200)).body.data.id).toBe(
        w.id,
      );
      const listed = await call('get', tokens.a1!, '/workspaces?limit=100').expect(200);
      expect(ids(listed.body)).toContain(w.id);
      for (const row of listed.body.data) expect(Object.keys(row).sort()).toEqual(WORKSPACE_KEYS);

      const renamed = await call('patch', tokens.a1!, `/workspaces/${w.id}`)
        .send({ name: 'Brand Uno' })
        .expect(200);
      expect(renamed.body.data.name).toBe('Brand Uno');
      const [upd] = await auditRows(w.id, AUDIT_ACTIONS.WORKSPACE_UPDATED);
      expect(upd).toMatchObject({ before: { name: 'Brand One' }, after: { name: 'Brand Uno' } });

      const team = await call('post', tokens.a1!, '/teams')
        .send({ workspaceId: w.id, name: 'Support' })
        .expect(201);
      const t = team.body.data;
      expect(Object.keys(t).sort()).toEqual(TEAM_KEYS);
      expect(t).toMatchObject({ orgId: a1.orgId, workspaceId: w.id, status: 'active' });
      expect(await auditRows(t.id, AUDIT_ACTIONS.TEAM_CREATED)).toHaveLength(1);
      expect(
        ids((await call('get', tokens.a1!, `/teams?workspaceId=${w.id}`).expect(200)).body),
      ).toEqual([t.id]);
      await call('patch', tokens.a1!, `/teams/${t.id}`).send({ name: 'Help' }).expect(200);

      await call('post', tokens.a1!, `/teams/${t.id}/archive`).expect(200);
      await call('post', tokens.a1!, `/workspaces/${w.id}/archive`).expect(200);
      expect((await wsRow(w.id))!.status).toBe('archived');
      await call('post', tokens.a1!, `/workspaces/${w.id}/restore`).expect(200);
      await call('post', tokens.a1!, `/teams/${t.id}/restore`).expect(200);
      expect((await teamRow(t.id))!.status).toBe('active');
      for (const action of [
        AUDIT_ACTIONS.WORKSPACE_ARCHIVED,
        AUDIT_ACTIONS.WORKSPACE_RESTORED,
        AUDIT_ACTIONS.TEAM_ARCHIVED,
        AUDIT_ACTIONS.TEAM_RESTORED,
      ]) {
        const target = action.startsWith('workspace') ? w.id : t.id;
        expect(`${action}:${(await auditRows(target, action)).length}`).toBe(`${action}:1`);
      }
    });

    it('a workspace manager administers inside its own workspace', async () => {
      await call('get', tokens.wsManager!, `/workspaces/${ws.w1}`).expect(200);
      await call('patch', tokens.wsManager!, `/workspaces/${ws.w1}`)
        .send({ name: 'WS one' })
        .expect(200);
      const team = await call('post', tokens.wsManager!, '/teams')
        .send({ workspaceId: ws.w1, name: `wsm-${suffix()}` })
        .expect(201);
      const listed = await call('get', tokens.wsManager!, `/teams?workspaceId=${ws.w1}&limit=100`);
      expect(listed.status).toBe(200);
      expect(ids(listed.body)).toEqual(expect.arrayContaining([tm.t1, tm.t2, team.body.data.id]));
      expect(ids(listed.body)).not.toContain(tm.t3);
      await call('patch', tokens.wsManager!, `/teams/${team.body.data.id}`)
        .send({ name: `wsm-${suffix()}` })
        .expect(200);
      await call('post', tokens.wsManager!, `/teams/${team.body.data.id}/archive`).expect(200);
    });

    it('a team lead reads and renames its own team', async () => {
      await call('get', tokens.teamLead!, `/teams/${tm.t1}`).expect(200);
      await call('patch', tokens.teamLead!, `/teams/${tm.t1}`).send({ name: 'T1' }).expect(200);
      await call('get', tokens.teamReader!, `/teams/${tm.t1}`).expect(200);
    });

    it('a reseller administrator creates a workspace in a selected organization beneath its reseller; platform principals follow their permissions', async () => {
      await call('post', tokens.resellerA!, '/workspaces', a1.orgId)
        .send({ name: 'Reseller made', slug: `rs-${suffix()}` })
        .expect(201);
      await call('post', tokens.platform!, '/workspaces', a1.orgId)
        .send({ name: 'Platform made', slug: `pl-${suffix()}` })
        .expect(201);
      await call('get', tokens.support!, '/workspaces', a1.orgId).expect(200);
      await call('get', tokens.support!, `/teams/${tm.t1}`, a1.orgId).expect(200);
      const refused = await call('post', tokens.support!, '/workspaces', a1.orgId).send({
        name: 'x',
        slug: `sp-${suffix()}`,
      });
      expect(refused.status).toBe(403);
      // A reseller administrator holds no team administration (RBAC.md).
      const team = await call('post', tokens.resellerA!, '/teams', a1.orgId).send({
        workspaceId: ws.w1,
        name: 'nope',
      });
      expect(team.status).toBe(403);
    });

    it('idempotent creation replays the first answer and creates nothing twice', async () => {
      const key = `wt-idem-${uuidv7()}`;
      const slug = `idem-${suffix()}`;
      const first = await call('post', tokens.a1!, '/workspaces', undefined, key)
        .send({ name: 'Idem', slug })
        .expect(201);
      const again = await call('post', tokens.a1!, '/workspaces', undefined, key)
        .send({ name: 'Idem', slug })
        .expect(201);
      expect(again.body.data.id).toBe(first.body.data.id);
      const rows = await h.admin
        .select()
        .from(schema.workspaces)
        .where(and(eq(schema.workspaces.orgId, a1.orgId), eq(schema.workspaces.slug, slug)));
      expect(rows).toHaveLength(1);

      const tkey = `wt-idem-${uuidv7()}`;
      const t1 = await call('post', tokens.a1!, '/teams', undefined, tkey)
        .send({ workspaceId: ws.w2, name: 'Idem team' })
        .expect(201);
      const t2 = await call('post', tokens.a1!, '/teams', undefined, tkey)
        .send({ workspaceId: ws.w2, name: 'Idem team' })
        .expect(201);
      expect(t2.body.data.id).toBe(t1.body.data.id);
    });

    it('duplicate slugs and names are 409 RESOURCE_CONFLICT within their parent only', async () => {
      const dup = await call('post', tokens.a1!, '/workspaces').send({ name: 'x', slug: 'one' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
      // B1's slug is not an oracle in A1: slugs are unique per organization.
      await call('post', tokens.a1!, '/workspaces').send({ name: 'x', slug: 'b-one' }).expect(201);
      const team = await call('post', tokens.a1!, '/teams').send({
        workspaceId: ws.w1,
        name: 'T2',
      });
      expect(team.status).toBe(409);
      expect(team.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
      await call('post', tokens.a1!, '/teams').send({ workspaceId: ws.w2, name: 'T2' }).expect(201);
    });

    it('the deprecated /tenants/workspaces aliases are unchanged and say they are deprecated', async () => {
      const list = await call('get', tokens.a1!, '/tenants/workspaces').expect(200);
      expect(list.headers.deprecation).toBe('true');
      expect(list.headers.link).toBe('</api/v1/workspaces>; rel="successor-version"');
      expect(Object.keys(list.body.data[0]).sort()).toEqual(
        ['createdAt', 'id', 'name', 'orgId', 'slug', 'status'].sort(),
      );
      const one = await call('get', tokens.a1!, `/tenants/workspaces/${ws.w1}`).expect(200);
      expect(one.headers.deprecation).toBe('true');
      expect(Object.keys(one.body.data).sort()).toEqual(
        ['id', 'name', 'orgId', 'slug', 'status'].sort(),
      );
    });

    it('there is no hard delete for workspaces or teams', async () => {
      for (const path of [`/workspaces/${ws.w2}`, `/teams/${tm.t3}`]) {
        const res = await call('delete', tokens.a1!, path);
        expect(res.status).toBe(404);
      }
      expect(await wsRow(ws.w2)).toBeDefined();
      expect(await teamRow(tm.t3)).toBeDefined();
    });
  });

  // ===========================================================================
  describe('A. horizontal isolation', () => {
    it('Organization A → Organization B: every workspace and team route is a 404 byte-identical to an unknown id', async () => {
      const unknownWs = await call('get', tokens.a1!, `/workspaces/${uuidv7()}`).expect(404);
      const unknownTeam = await call('get', tokens.a1!, `/teams/${uuidv7()}`).expect(404);
      const probes: [Method, string, object?][] = [
        ['get', `/workspaces/${ws.wb}`],
        ['patch', `/workspaces/${ws.wb}`, { name: 'x' }],
        ['post', `/workspaces/${ws.wb}/archive`],
        ['post', `/workspaces/${ws.wb}/restore`],
      ];
      for (const [m, p, body] of probes) {
        const res = await call(m, tokens.a1!, p).send(body ?? {});
        expect(`${m} ${p} ${res.status}`).toBe(`${m} ${p} 404`);
        expect(strip(res.body)).toEqual(strip(unknownWs.body));
        expect(JSON.stringify(res.body)).not.toContain(ws.wb);
      }
      for (const [m, p, body] of [
        ['get', `/teams/${tm.tb}`],
        ['patch', `/teams/${tm.tb}`, { name: 'x' }],
        ['post', `/teams/${tm.tb}/archive`],
        ['post', `/teams/${tm.tb}/restore`],
      ] as [Method, string, object?][]) {
        const res = await call(m, tokens.a1!, p).send(body ?? {});
        expect(`${m} ${p} ${res.status}`).toBe(`${m} ${p} 404`);
        expect(strip(res.body)).toEqual(strip(unknownTeam.body));
      }
      const team = await call('post', tokens.a1!, '/teams').send({ workspaceId: ws.wb, name: 'x' });
      expect(team.status).toBe(404);
      expect((await call('get', tokens.a1!, `/teams?workspaceId=${ws.wb}`)).status).toBe(404);
      expect((await wsRow(ws.wb))!.name).toBe('WS b-one');
      const bTeams = await h.admin
        .select()
        .from(schema.teams)
        .where(eq(schema.teams.orgId, b1.orgId));
      expect(bTeams.map((r) => r.id)).toEqual([tm.tb]);
      // Selecting B1 is refused before anything is read.
      const header = await call('get', tokens.a1!, '/workspaces', b1.orgId);
      expect(header.status).toBe(403);
      expect(header.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it('a reseller administrator acting in A1 cannot reach A2’s workspaces or teams through A1 — addressing is pinned to the selected organization', async () => {
      for (const p of [`/workspaces/${ws.wa2}`, `/teams/${tm.ta2}`]) {
        expect(`${p}:${(await call('get', tokens.resellerA!, p, a1.orgId)).status}`).toBe(
          `${p}:404`,
        );
      }
      const patched = await call(
        'patch',
        tokens.resellerA!,
        `/workspaces/${ws.wa2}`,
        a1.orgId,
      ).send({
        name: 'hijack',
      });
      expect(patched.status).toBe(404);
      expect((await wsRow(ws.wa2))!.name).toBe('WS a2-one');
      // Through A2 itself it can — its reseller covers A2.
      await call('get', tokens.resellerA!, `/workspaces/${ws.wa2}`, a2.orgId).expect(200);
      // And reseller B sees nothing of reseller A.
      const cross = await call('get', tokens.resellerB!, '/workspaces', a1.orgId);
      expect(cross.status).toBe(403);
      expect(cross.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it('Workspace A → Workspace B: a workspace-scoped principal gets 404 for the sibling workspace and its teams', async () => {
      const unknown = await call('get', tokens.wsManager!, `/workspaces/${uuidv7()}`).expect(404);
      for (const [m, p, body] of [
        ['get', `/workspaces/${ws.w2}`],
        ['patch', `/workspaces/${ws.w2}`, { name: 'x' }],
        ['get', `/teams/${tm.t3}`],
        ['patch', `/teams/${tm.t3}`, { name: 'x' }],
        ['post', `/teams/${tm.t3}/archive`],
        ['get', `/teams?workspaceId=${ws.w2}`],
      ] as [Method, string, object?][]) {
        const res = await call(m, tokens.wsManager!, p).send(body ?? {});
        expect(`${m} ${p} ${res.status}`).toBe(`${m} ${p} 404`);
        if (p.startsWith('/workspaces')) expect(strip(res.body)).toEqual(strip(unknown.body));
      }
      const team = await call('post', tokens.wsManager!, '/teams').send({
        workspaceId: ws.w2,
        name: 'x',
      });
      expect(team.status).toBe(404);
      expect((await wsRow(ws.w2))!.name).toBe('WS two');
    });

    it('Team A → Team B: team-scoped principals get 404 for sibling teams, in the same workspace or another', async () => {
      for (const who of ['teamLead', 'teamReader']) {
        for (const t of [tm.t2, tm.t3]) {
          expect(`${who}:${(await call('get', tokens[who]!, `/teams/${t}`)).status}`).toBe(
            `${who}:404`,
          );
        }
      }
      for (const t of [tm.t2, tm.t3]) {
        const res = await call('patch', tokens.teamLead!, `/teams/${t}`).send({ name: 'hijack' });
        expect(res.status).toBe(404);
      }
      expect((await teamRow(tm.t2))!.name).toBe('T2');
    });
  });

  // ===========================================================================
  describe('B. vertical escalation', () => {
    it('Team → Workspace: a team lead cannot archive its own team (workspace authority), read its workspace, or list the organization’s teams', async () => {
      const archive = await call('post', tokens.teamLead!, `/teams/${tm.t1}/archive`);
      expect(archive.status).toBe(403);
      expect(archive.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      expect(await deniedAudit(people.teamLead!.userId, ws.w1)).not.toHaveLength(0);
      expect((await teamRow(tm.t1))!.status).toBe('active');
      expect((await call('get', tokens.teamLead!, `/workspaces/${ws.w1}`)).status).toBe(404);
      expect(
        (await call('patch', tokens.teamLead!, `/workspaces/${ws.w1}`).send({ name: 'x' })).status,
      ).toBe(404);
      expect((await call('get', tokens.teamLead!, '/teams')).status).toBe(403);
      expect((await call('get', tokens.teamLead!, `/teams?workspaceId=${ws.w1}`)).status).toBe(404);
      // A team-scoped grant carrying teams.create still cannot create in the workspace.
      const create = await call('post', tokens.teamLead!, '/teams').send({
        workspaceId: ws.w1,
        name: 'x',
      });
      expect(create.status).toBe(404);
    });

    it('Workspace → Organization: a workspace manager cannot archive or restore its workspace, list or create workspaces', async () => {
      for (const action of ['archive', 'restore']) {
        const res = await call('post', tokens.wsManager!, `/workspaces/${ws.w1}/${action}`);
        expect(`${action}:${res.status}:${res.body.error?.code}`).toBe(
          `${action}:403:${ERROR_CODES.AUTHZ_SCOPE_DENIED}`,
        );
      }
      expect(await deniedAudit(people.wsManager!.userId, a1.orgId)).not.toHaveLength(0);
      expect((await call('get', tokens.wsManager!, '/workspaces')).status).toBe(403);
      expect((await call('get', tokens.wsManager!, '/teams')).status).toBe(403);
      const create = await call('post', tokens.wsManager!, '/workspaces').send({
        name: 'x',
        slug: `x-${suffix()}`,
      });
      expect(create.status).toBe(403);
      expect((await wsRow(ws.w1))!.status).toBe('active');
    });

    it('readers read and cannot write: an organization reader and a workspace reader are refused with an audited 403', async () => {
      await call('get', tokens.orgReader!, '/workspaces').expect(200);
      const patched = await call('patch', tokens.orgReader!, `/workspaces/${ws.w1}`).send({
        name: 'x',
      });
      expect(patched.status).toBe(403);
      expect(await deniedAudit(people.orgReader!.userId, ws.w1)).not.toHaveLength(0);
      await call('get', tokens.wsReader!, `/workspaces/${ws.w1}`).expect(200);
      const team = await call('post', tokens.wsReader!, '/teams').send({
        workspaceId: ws.w1,
        name: 'x',
      });
      expect(team.status).toBe(403);
    });

    it('a reseller grant never covers another reseller’s organization, even for a principal who can select it through a different grant', async () => {
      // Reseller B's administrator who is also a reader in A1: it may select A1
      // (through the reader grant) — and its reseller-admin role must still not
      // reach A1, whose reseller is A. Coherent grants, not a union.
      const dual = await createUser('wt-dual');
      await grant(
        dual.userId,
        await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
        'reseller',
        resellerB,
      );
      await grant(dual.userId, a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', a1.orgId);
      const token = await login(dual.email);
      await call('get', token, '/workspaces', a1.orgId).expect(200);
      const created = await call('post', token, '/workspaces', a1.orgId).send({
        name: 'x',
        slug: `dual-${suffix()}`,
      });
      expect(created.status).toBe(403);
      expect(created.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      const patched = await call('patch', token, `/workspaces/${ws.w1}`, a1.orgId).send({
        name: 'x',
      });
      expect(patched.status).toBe(403);
      expect((await call('post', token, `/workspaces/${ws.w2}/archive`, a1.orgId)).status).toBe(
        403,
      );
      expect((await wsRow(ws.w1))!.name).not.toBe('x');
    });

    it('Organization → Reseller and Reseller → Platform: selection never widens', async () => {
      const toSibling = await call('get', tokens.a1!, '/workspaces', a2.orgId);
      expect(toSibling.status).toBe(403);
      expect(toSibling.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      const created = await call('post', tokens.a1!, '/workspaces', a2.orgId).send({
        name: 'x',
        slug: `x-${suffix()}`,
      });
      expect(created.status).toBe(403);
      const cross = await call('post', tokens.resellerA!, '/workspaces', b1.orgId).send({
        name: 'x',
        slug: `x-${suffix()}`,
      });
      expect(cross.status).toBe(403);
      expect(cross.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      const bWorkspaces = await h.admin
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.orgId, b1.orgId));
      expect(bWorkspaces.map((w) => w.id).sort()).toEqual([b1.defaultWorkspace, ws.wb].sort());
    });
  });

  // ===========================================================================
  describe('C. scope substitution', () => {
    it('another org_id in a query or body is 403 TENANCY_CONTEXT_MISMATCH, never substituted', async () => {
      for (const [m, p, body] of [
        ['get', `/workspaces?orgId=${b1.orgId}`],
        ['get', `/teams?orgId=${b1.orgId}`],
        ['post', '/workspaces', { name: 'x', slug: `x-${suffix()}`, orgId: b1.orgId }],
        ['post', '/teams', { workspaceId: ws.w1, name: 'x', orgId: b1.orgId }],
        ['post', '/workspaces', { name: 'x', slug: `x-${suffix()}`, orgId: a2.orgId }],
      ] as [Method, string, object?][]) {
        const res = await call(m, tokens.a1!, p).send(body ?? {});
        expect(`${m} ${p} ${res.status} ${res.body.error?.code}`).toBe(
          `${m} ${p} 403 ${ERROR_CODES.TENANCY_CONTEXT_MISMATCH}`,
        );
      }
      // The matching orgId is accepted, and the organization is still the selected one.
      const ok = await call('post', tokens.a1!, '/workspaces')
        .send({ name: 'x', slug: `x-${suffix()}`, orgId: a1.orgId })
        .expect(201);
      expect(ok.body.data.orgId).toBe(a1.orgId);
      // Repeated identifiers are refused, never resolved by order.
      expect(
        (await call('get', tokens.a1!, `/workspaces?orgId=${a1.orgId}&orgId=${b1.orgId}`)).status,
      ).toBe(400);
    });

    it('another workspace_id or team_id is a 404 target, and immutable parents cannot be rewritten', async () => {
      expect((await call('get', tokens.a1!, `/teams?workspaceId=${ws.wb}`)).status).toBe(404);
      expect(
        (
          await call('post', tokens.a1!, '/teams').send({
            workspaceId: ws.wb,
            name: 'x',
            orgId: a1.orgId,
          })
        ).status,
      ).toBe(404);
      for (const body of [
        { workspaceId: ws.w2 },
        { orgId: b1.orgId },
        { status: 'archived' },
        { id: tm.t2 },
      ]) {
        const res = await call('patch', tokens.a1!, `/teams/${tm.t1}`).send(body);
        expect(`${JSON.stringify(body)}:${res.status}`).toBe(`${JSON.stringify(body)}:400`);
      }
      for (const body of [
        { slug: 'hijack' },
        { orgId: b1.orgId },
        { isDefault: true },
        { status: 'archived' },
      ]) {
        const res = await call('patch', tokens.a1!, `/workspaces/${ws.w1}`).send(body);
        expect(`${JSON.stringify(body)}:${res.status}`).toBe(`${JSON.stringify(body)}:400`);
      }
      expect(await teamRow(tm.t1)).toMatchObject({ workspaceId: ws.w1, orgId: a1.orgId });
      expect(await wsRow(ws.w1)).toMatchObject({ slug: 'one', orgId: a1.orgId, isDefault: false });
      // Unknown filters are refused rather than ignored.
      expect((await call('get', tokens.a1!, `/teams?teamId=${tm.t1}`)).status).toBe(400);
      expect((await call('get', tokens.a1!, `/workspaces?workspaceId=${ws.w1}`)).status).toBe(400);
    });
  });

  // ===========================================================================
  describe('D. parent-child integrity', () => {
    it('a created team takes its organization from its workspace’s row', async () => {
      const res = await call('post', tokens.resellerA!, '/workspaces', a1.orgId)
        .send({ name: 'Parent', slug: `pc-${suffix()}` })
        .expect(201);
      const team = await call('post', tokens.a1!, '/teams')
        .send({ workspaceId: res.body.data.id, name: 'Child' })
        .expect(201);
      expect(await teamRow(team.body.data.id)).toMatchObject({
        orgId: a1.orgId,
        workspaceId: res.body.data.id,
      });
    });

    it('a team claiming a workspace of another organization is unrepresentable in the database', async () => {
      // Owner connection, no RLS: only the composite foreign key stands in the way.
      await expect(
        h.admin
          .insert(schema.teams)
          .values({ orgId: a1.orgId, workspaceId: ws.wb, name: 'forged' }),
      ).rejects.toThrow();
      await expect(
        h.admin
          .insert(schema.teams)
          .values({ orgId: b1.orgId, workspaceId: ws.w1, name: 'forged' }),
      ).rejects.toThrow();
    });

    it('workspace from A combined with team from B, and team from W1 combined with W2, never match', async () => {
      const w1Teams = ids(
        (await call('get', tokens.a1!, `/teams?workspaceId=${ws.w1}&limit=100`).expect(200)).body,
      );
      expect(w1Teams).not.toContain(tm.tb);
      expect(w1Teams).not.toContain(tm.t3);
      const w2Teams = ids(
        (await call('get', tokens.a1!, `/teams?workspaceId=${ws.w2}&limit=100`).expect(200)).body,
      );
      expect(w2Teams).toContain(tm.t3);
      expect(w2Teams).not.toContain(tm.t1);
      // A B1 principal naming A1's workspace to host a team: invisible.
      const res = await call('post', tokens.b1!, '/teams').send({ workspaceId: ws.w1, name: 'x' });
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  describe('E. enumeration', () => {
    async function walk(
      token: string,
      path: string,
      org?: string,
    ): Promise<{ seen: string[]; cursors: string[] }> {
      const seen: string[] = [];
      const cursors: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 200; i++) {
        const sep = path.includes('?') ? '&' : '?';
        const page = await call(
          'get',
          token,
          `${path}${sep}limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          org,
        ).expect(200);
        seen.push(...ids(page.body));
        cursor = page.body.page.nextCursor;
        if (!cursor) break;
        cursors.push(Buffer.from(cursor.split('.')[0]!, 'base64url').toString('utf8'));
      }
      return { seen, cursors };
    }

    it('workspace and team lists, page by page, carry only the selected organization — in rows and in cursors', async () => {
      const foreign = [
        ws.wb,
        ws.wa2,
        tm.tb,
        tm.ta2,
        b1.orgId,
        a2.orgId,
        'b-one',
        'a2-one',
        'TB',
        'TA2',
      ];
      const aWorkspaces = (
        await h.admin
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.orgId, a1.orgId))
      ).map((r) => r.id);
      const aTeams = (
        await h.admin
          .select({ id: schema.teams.id })
          .from(schema.teams)
          .where(eq(schema.teams.orgId, a1.orgId))
      ).map((r) => r.id);
      for (const [token, org] of [
        [tokens.a1!, undefined],
        [tokens.resellerA!, a1.orgId],
        [tokens.platform!, a1.orgId],
      ] as [string, string | undefined][]) {
        const w = await walk(token, '/workspaces', org);
        expect(w.seen.sort()).toEqual([...aWorkspaces].sort());
        const t = await walk(token, '/teams', org);
        expect(t.seen.sort()).toEqual([...aTeams].sort());
        for (const text of [...w.cursors, ...t.cursors]) {
          for (const f of foreign) expect(text).not.toContain(f);
        }
      }
      const scoped = await walk(tokens.wsManager!, `/teams?workspaceId=${ws.w1}`);
      expect(scoped.seen).not.toContain(tm.t3);
    });

    it('errors never echo the requested id and never distinguish foreign from nonexistent', async () => {
      for (const [who, p] of [
        ['a1', `/workspaces/${ws.wb}`],
        ['a1', `/teams/${tm.tb}`],
        ['wsManager', `/workspaces/${ws.w2}`],
        ['teamReader', `/teams/${tm.t2}`],
      ]) {
        const res = await call('get', tokens[who!]!, p!);
        expect(res.status).toBe(404);
        const id = p!.split('/').pop()!;
        expect(JSON.stringify(res.body)).not.toContain(id);
        expect(res.body.error.details).toBeUndefined();
      }
    });
  });

  // ===========================================================================
  describe('F. lifecycle', () => {
    async function freshWorkspace() {
      const res = await call('post', tokens.a1!, '/workspaces')
        .send({ name: 'Life', slug: `life-${suffix()}` })
        .expect(201);
      return res.body.data.id as string;
    }

    it('archiving a workspace with an active team is refused; after the team is archived it is allowed', async () => {
      const w = await freshWorkspace();
      const t = (
        await call('post', tokens.a1!, '/teams')
          .send({ workspaceId: w, name: 'Active' })
          .expect(201)
      ).body.data.id;
      const refused = await call('post', tokens.a1!, `/workspaces/${w}/archive`);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe(ERROR_CODES.WORKSPACE_LIFECYCLE_CONFLICT);
      expect(refused.body.error.details).toEqual({ status: 'active', activeTeams: 1 });
      expect((await wsRow(w))!.status).toBe('active');

      await call('post', tokens.a1!, `/teams/${t}/archive`).expect(200);
      await call('post', tokens.a1!, `/workspaces/${w}/archive`).expect(200);
      const again = await call('post', tokens.a1!, `/workspaces/${w}/archive`);
      expect(again.status).toBe(409);
      expect(again.body.error.details).toEqual({ status: 'archived' });
    });

    it('the default workspace cannot be archived', async () => {
      const res = await call('post', tokens.a1!, `/workspaces/${a1.defaultWorkspace}/archive`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ERROR_CODES.WORKSPACE_LIFECYCLE_CONFLICT);
      expect(res.body.error.details).toEqual({ status: 'active', isDefault: true });
    });

    it('restore: allowed when archived and the organization is active; 409 when not archived', async () => {
      const w = await freshWorkspace();
      const notArchived = await call('post', tokens.a1!, `/workspaces/${w}/restore`);
      expect(notArchived.status).toBe(409);
      expect(notArchived.body.error.details).toEqual({ status: 'active' });
      await call('post', tokens.a1!, `/workspaces/${w}/archive`).expect(200);
      await call('post', tokens.a1!, `/workspaces/${w}/restore`).expect(200);
    });

    it('an archived workspace refuses updates, new teams, new grants and new API keys; existing grants keep working', async () => {
      const w = await freshWorkspace();
      const reader = await createUser('wt-archived-reader');
      await grant(reader.userId, a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'workspace', w);
      const readerToken = await login(reader.email);
      await call('post', tokens.a1!, `/workspaces/${w}/archive`).expect(200);

      const cases: [string, () => request.Test][] = [
        ['patch', () => call('patch', tokens.a1!, `/workspaces/${w}`).send({ name: 'x' })],
        ['team', () => call('post', tokens.a1!, '/teams').send({ workspaceId: w, name: 'x' })],
        [
          'grant',
          () =>
            call('post', tokens.a1!, '/role-assignments').send({
              userId: people.target!.userId,
              roleId: a1.roles[TENANT_ROLE_KEYS.AGENT],
              scopeType: 'workspace',
              scopeId: w,
            }),
        ],
        [
          'api-key',
          () =>
            call('post', tokens.a1!, '/api-keys').send({
              name: 'k',
              scopeType: 'workspace',
              scopeId: w,
              scopes: ['workspaces.read'],
            }),
        ],
      ];
      for (const [label, pending] of cases) {
        const res = await pending();
        expect(`${label}:${res.status}:${res.body.error?.code}`).toBe(
          `${label}:409:${ERROR_CODES.WORKSPACE_LIFECYCLE_CONFLICT}`,
        );
      }
      expect(
        await h.admin.select().from(schema.apiKeys).where(eq(schema.apiKeys.workspaceId, w)),
      ).toHaveLength(0);
      // Still listed, and its existing grant still reads it.
      expect(
        ids(
          (await call('get', tokens.a1!, '/workspaces?status=archived&limit=100').expect(200)).body,
        ),
      ).toContain(w);
      await call('get', readerToken, `/workspaces/${w}`).expect(200);
    });

    it('teams: archive and restore, an archived team refuses updates and grants, and cannot be restored into an archived workspace', async () => {
      const w = await freshWorkspace();
      const t = (
        await call('post', tokens.a1!, '/teams')
          .send({ workspaceId: w, name: 'Life team' })
          .expect(201)
      ).body.data.id;
      await call('post', tokens.a1!, `/teams/${t}/archive`).expect(200);
      const again = await call('post', tokens.a1!, `/teams/${t}/archive`);
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({
        code: ERROR_CODES.TEAM_LIFECYCLE_CONFLICT,
        details: { status: 'archived' },
      });
      const patched = await call('patch', tokens.a1!, `/teams/${t}`).send({ name: 'x' });
      expect(patched.body.error?.code).toBe(ERROR_CODES.TEAM_LIFECYCLE_CONFLICT);
      const granted = await call('post', tokens.a1!, '/role-assignments').send({
        userId: people.target!.userId,
        roleId: a1.roles[TENANT_ROLE_KEYS.AGENT],
        scopeType: 'team',
        scopeId: t,
      });
      expect(granted.status).toBe(409);
      expect(granted.body.error.code).toBe(ERROR_CODES.TEAM_LIFECYCLE_CONFLICT);

      await call('post', tokens.a1!, `/workspaces/${w}/archive`).expect(200);
      const restore = await call('post', tokens.a1!, `/teams/${t}/restore`);
      expect(restore.status).toBe(409);
      expect(restore.body.error.code).toBe(ERROR_CODES.WORKSPACE_LIFECYCLE_CONFLICT);
      await call('post', tokens.a1!, `/workspaces/${w}/restore`).expect(200);
      await call('post', tokens.a1!, `/teams/${t}/restore`).expect(200);
      const notArchived = await call('post', tokens.a1!, `/teams/${t}/restore`);
      expect(notArchived.body.error.code).toBe(ERROR_CODES.TEAM_LIFECYCLE_CONFLICT);
    });

    it('suspended organization: members are refused with the status code; platform principals read but every mutation is 409', async () => {
      const member = await call('get', tokens.s!, '/workspaces');
      expect(member.status).toBe(403);
      expect(member.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED);
      await call('get', tokens.platform!, '/workspaces', s.orgId).expect(200);
      for (const [m, p, body] of [
        ['post', '/workspaces', { name: 'x', slug: `x-${suffix()}` }],
        ['post', `/workspaces/${ws.ws}/restore`],
        ['patch', `/workspaces/${s.defaultWorkspace}`, { name: 'x' }],
        ['post', '/teams', { workspaceId: s.defaultWorkspace, name: 'x' }],
      ] as [Method, string, object?][]) {
        const res = await call(m, tokens.platform!, p, s.orgId).send(body ?? {});
        expect(`${m} ${p} ${res.status} ${res.body.error?.code}`).toBe(
          `${m} ${p} 409 ${ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT}`,
        );
      }
      expect((await wsRow(ws.ws))!.status).toBe('archived');
    });

    it('closed organization: members are refused; nothing can be created or restored in it', async () => {
      const member = await call('get', tokens.c!, `/workspaces/${ws.wc}`);
      expect(member.status).toBe(403);
      expect(member.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_CLOSED);
      for (const [m, p, body] of [
        ['post', '/workspaces', { name: 'x', slug: `x-${suffix()}` }],
        ['post', '/teams', { workspaceId: ws.wc, name: 'x' }],
        ['post', `/workspaces/${ws.wc}/archive`],
      ] as [Method, string, object?][]) {
        const res = await call(m, tokens.platform!, p, c.orgId).send(body ?? {});
        expect(`${m} ${p} ${res.status}`).toBe(`${m} ${p} 409`);
      }
      const resellerRead = await call('get', tokens.resellerA!, '/workspaces', c.orgId);
      expect(resellerRead.status).toBe(403);
      expect(resellerRead.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_CLOSED);
    });

    it('a suspension committed after the guard read the organization is still refused inside the mutation’s transaction', async () => {
      // The principal is resolved while A2 is active — exactly what AuthGuard
      // saw — and A2 is then suspended before the service runs.
      const principal = await db.auth.transaction(async (raw) => {
        const tx = raw as Transaction;
        const scopes = await resolver.forUser(tx, a2.admin.userId);
        const tenant = await resolver.tenantContextFor(tx, scopes, a2.orgId);
        return {
          actorType: 'user' as const,
          userId: a2.admin.userId,
          apiKeyId: null,
          sessionId: null,
          tenant,
          roles: scopes.grants,
          permissions: scopes.permissions,
          authMethod: 'session' as const,
          authenticatedAt: new Date(),
        };
      });
      const workspaces = h.app.get(WorkspaceAdministrationService);
      const teams = h.app.get(TeamAdministrationService);
      const inContext = <T>(work: () => Promise<T>) =>
        RequestContext.run(
          {
            correlationId: uuidv7(),
            requestId: uuidv7(),
            causationId: null,
            traceId: null,
            principal: principal as never,
            ip: null,
            userAgent: null,
          },
          work,
        );
      await h.admin
        .update(schema.organizations)
        .set({ status: 'suspended' })
        .where(eq(schema.organizations.id, a2.orgId));
      try {
        const attempts: [string, () => Promise<unknown>][] = [
          [
            'create workspace',
            () =>
              workspaces.create(principal as never, { name: 'x', slug: `race-${suffix()}` }, null),
          ],
          [
            'update workspace',
            () => workspaces.update(principal as never, ws.wa2, { name: 'raced' }),
          ],
          ['archive workspace', () => workspaces.archive(principal as never, ws.wa2)],
          [
            'create team',
            () => teams.create(principal as never, { workspaceId: ws.wa2, name: 'raced' }, null),
          ],
          ['update team', () => teams.update(principal as never, tm.ta2, { name: 'raced' })],
          ['archive team', () => teams.archive(principal as never, tm.ta2)],
        ];
        for (const [label, attempt] of attempts) {
          const outcome = await inContext(attempt).then(
            () => 'succeeded',
            (e: { code?: string }) => e.code,
          );
          expect(`${label}:${outcome}`).toBe(
            `${label}:${ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT}`,
          );
        }
      } finally {
        await h.admin
          .update(schema.organizations)
          .set({ status: 'active' })
          .where(eq(schema.organizations.id, a2.orgId));
      }
      expect(await wsRow(ws.wa2)).toMatchObject({ name: 'WS a2-one', status: 'active' });
      expect(await teamRow(tm.ta2)).toMatchObject({ name: 'TA2', status: 'active' });
    });

    it('concurrent archive and team creation never leave an archived workspace holding an active team', async () => {
      for (let i = 0; i < 5; i++) {
        const w = await freshWorkspace();
        const [archive, create] = await Promise.all([
          call('post', tokens.a1!, `/workspaces/${w}/archive`),
          call('post', tokens.a1!, '/teams').send({ workspaceId: w, name: `race-${i}` }),
        ]);
        const row = await wsRow(w);
        const active = await h.admin
          .select()
          .from(schema.teams)
          .where(and(eq(schema.teams.workspaceId, w), eq(schema.teams.status, 'active')));
        expect(row!.status === 'archived' && active.length > 0).toBe(false);
        expect([archive.status, create.status].sort()).toEqual(
          row!.status === 'archived' ? [200, 409] : [201, 409],
        );
      }
    });
  });

  // ===========================================================================
  describe('G. RLS backstop — organization is the database boundary', () => {
    async function contextFor(userId: string, orgId: string | null = null): Promise<TenantSession> {
      const tenant = await db.auth.transaction(async (raw) => {
        const tx = raw as Transaction;
        const scopes = await resolver.forUser(tx, userId);
        return resolver.tenantContextFor(tx, scopes, resolver.selectOrganization(scopes, orgId));
      });
      return { ...tenant, userId };
    }

    const visibleIds = (session: TenantSession, table: 'workspaces' | 'teams') =>
      db.withTenant(session, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(
          sql.raw(`SELECT id::text AS id FROM ${table}`),
        );
        return rows.map((r) => r.id);
      });

    it('with no application predicate at all, an A1 principal’s acc_app context admits no row of another organization', async () => {
      const foreignWs = [ws.wb, ws.wa2];
      const foreignTeams = [tm.tb, tm.ta2];
      for (const [label, userId] of [
        ['a1', a1.admin.userId],
        ['wsManager', people.wsManager!.userId],
        ['teamLead', people.teamLead!.userId],
        ['orgReader', people.orgReader!.userId],
      ] as [string, string][]) {
        const ctx = await contextFor(userId);
        const w = await visibleIds(ctx, 'workspaces');
        const t = await visibleIds(ctx, 'teams');
        expect(`${label}:${w.filter((id) => foreignWs.includes(id)).length}`).toBe(`${label}:0`);
        expect(`${label}:${t.filter((id) => foreignTeams.includes(id)).length}`).toBe(`${label}:0`);
        // Inside the organization RLS admits siblings — workspace/team isolation
        // is the application's (ADR-011 D-4), which the HTTP cases above prove.
        expect(w).toEqual(expect.arrayContaining([ws.w1, ws.w2]));
      }
      // A reseller administrator acting in A1 sees its reseller's organizations
      // (A2 included) and nothing beneath reseller B.
      const reseller = await contextFor(people.resellerA!.userId, a1.orgId);
      const rw = await visibleIds(reseller, 'workspaces');
      expect(rw).toContain(ws.wa2);
      expect(rw).not.toContain(ws.wb);
    });

    it('widened application authorization (allow-all evaluator, unpinned lookups) still cannot read or change Org B rows', async () => {
      const allowAll = [
        jest.spyOn(PermissionEvaluator.prototype, 'allows').mockReturnValue(true),
        jest.spyOn(PermissionEvaluator.prototype, 'assert').mockImplementation(() => undefined),
      ];
      // The application's lookups lose their organization pin: only RLS remains.
      const unpinnedWorkspace = jest
        .spyOn(WorkspaceAdministrationService.prototype, 'loadVisible')
        .mockImplementation(async (tx: Transaction, _principal: unknown, id: string) => {
          const [row] = await tx
            .select()
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, id));
          if (!row)
            throw new AppException({
              status: 404,
              code: ERROR_CODES.RESOURCE_NOT_FOUND,
              message: 'not found',
            });
          return row;
        });
      const unpinnedTeam = jest
        .spyOn(TeamAdministrationService.prototype as never, 'loadVisible' as never)
        .mockImplementation((async (tx: Transaction, _principal: unknown, id: string) => {
          const [row] = await tx.select().from(schema.teams).where(eq(schema.teams.id, id));
          if (!row)
            throw new AppException({
              status: 404,
              code: ERROR_CODES.RESOURCE_NOT_FOUND,
              message: 'not found',
            });
          return row;
        }) as never);
      try {
        for (const [m, p, body] of [
          ['get', `/workspaces/${ws.wb}`],
          ['patch', `/workspaces/${ws.wb}`, { name: 'leak' }],
          ['post', `/workspaces/${ws.wb}/archive`],
          ['get', `/teams/${tm.tb}`],
          ['patch', `/teams/${tm.tb}`, { name: 'leak' }],
          ['post', `/teams/${tm.tb}/archive`],
          ['post', '/teams', { workspaceId: ws.wb, name: 'leak' }],
        ] as [Method, string, object?][]) {
          const res = await call(m, tokens.a1!, p).send(body ?? {});
          expect(`${m} ${p} ok=${res.status < 300}`).toBe(`${m} ${p} ok=false`);
          expect(JSON.stringify(res.body)).not.toContain('b-one');
          expect(JSON.stringify(res.body)).not.toContain('"TB"');
        }
        expect(unpinnedWorkspace).toHaveBeenCalled();
        expect(unpinnedTeam).toHaveBeenCalled();
      } finally {
        for (const spy of [...allowAll, unpinnedWorkspace, unpinnedTeam]) spy.mockRestore();
      }
      expect(await wsRow(ws.wb)).toMatchObject({ name: 'WS b-one', status: 'active' });
      expect(await teamRow(tm.tb)).toMatchObject({ name: 'TB', status: 'active' });
      expect(
        await h.admin.select().from(schema.teams).where(eq(schema.teams.workspaceId, ws.wb)),
      ).toHaveLength(1);
    });
  });
});
