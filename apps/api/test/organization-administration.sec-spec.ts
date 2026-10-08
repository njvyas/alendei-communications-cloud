/**
 * Organization administration and lifecycle (Phase 1C.1a, ADR-012,
 * `FRONTEND_API_CONTRACT.md` §31a) — security suite.
 *
 * Built on the Gate-B shared-reseller topology, because that is the topology in
 * which organization isolation actually failed once:
 *
 *     Reseller A ── Org A1 ── (L1: a lifecycle subject, also beneath A)
 *                └─ Org A2
 *     Reseller B ── Org B1 ── (L2: a suspended organization nobody here is connected to)
 *
 * Every case drives real HTTP with real tokens against the real database; the
 * rollback cases inject a failure into the production services mid-transaction.
 */
import { randomBytes } from 'node:crypto';
import { AUDIT_ACTIONS, ERROR_CODES, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { OrganizationAdministrationService } from '../src/organizations/organization-administration.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';

interface Org {
  orgId: string;
  resellerId: string;
  roles: Record<string, string>;
  admin: { userId: string; email: string };
}

describe('organization administration and lifecycle (1C.1a)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let resellerA: string;
  let resellerB: string;
  let defaultReseller: string;
  let a1: Org;
  let a2: Org;
  let b1: Org;
  let l1: Org;
  let l2: Org;
  const people: Record<string, { userId: string; email: string }> = {};
  const tokens: Record<string, string> = {};
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];
  const createdResellers: string[] = [];
  let l1Key: string;

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
    scopeType: 'platform' | 'reseller' | 'organization',
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

  /** An organization planted by the owner, with provisioned roles and an admin. */
  async function plantOrg(
    label: string,
    resellerId: string,
    status: 'active' | 'suspended' = 'active',
  ): Promise<Org> {
    const [org] = await h.admin
      .insert(schema.organizations)
      .values({ name: `O ${label}`, slug: `o-${label}-${suffix()}`, resellerId, status })
      .returning({ id: schema.organizations.id });
    const orgId = org!.id;
    createdOrgs.push(orgId);
    await h.admin
      .insert(schema.workspaces)
      .values({ orgId, name: 'Default', slug: 'default', isDefault: true });
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
    return { orgId, resellerId, roles, admin };
  }

  async function login(email: string) {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  const call = (method: 'get' | 'post' | 'patch', token: string, path: string, org?: string) => {
    const r = request(h.app.getHttpServer())
      [method](url(path))
      .set('authorization', `Bearer ${token}`);
    return org ? r.set('x-acc-organization', org) : r;
  };

  const orgRow = async (id: string) =>
    (await h.admin.select().from(schema.organizations).where(eq(schema.organizations.id, id)))[0];
  const orgBySlug = async (slug: string) =>
    (
      await h.admin.select().from(schema.organizations).where(eq(schema.organizations.slug, slug))
    )[0];
  const auditFor = async (orgId: string, action: string) =>
    (
      await h.admin.execute<Record<string, unknown>>(
        // `id` is a UUIDv7, so this is chronological and `.at(-1)` is the latest.
        sql`SELECT * FROM audit_logs WHERE org_id = ${orgId} AND action = ${action} ORDER BY id`,
      )
    ).rows;

  const track = (id: string) => {
    createdOrgs.push(id);
    return id;
  };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    const [d] = await h.admin
      .select({ id: schema.resellers.id })
      .from(schema.resellers)
      .where(eq(schema.resellers.isPlatformDefault, true));
    defaultReseller = d!.id;

    resellerA = await createReseller('org-a');
    resellerB = await createReseller('org-b');
    a1 = await plantOrg('a1', resellerA);
    a2 = await plantOrg('a2', resellerA);
    b1 = await plantOrg('b1', resellerB);
    l1 = await plantOrg('l1', resellerA);
    l2 = await plantOrg('l2', resellerB, 'suspended');

    people.platform = await createUser('platform');
    await grant(
      people.platform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    people.support = await createUser('support');
    await grant(
      people.support.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );
    people.resellerA = await createUser('reseller-a');
    await grant(
      people.resellerA.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerA,
    );
    people.resellerB = await createUser('reseller-b');
    await grant(
      people.resellerB.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerB,
    );

    // A working API key bound to L1, created by L1's administrator.
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const secret = `s${uuidv7().replace(/-/g, '')}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: l1.orgId,
      name: `l1-${prefix}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      scopes: ['workspaces.read'],
      createdBy: l1.admin.userId,
    });
    l1Key = `${prefix}.${secret}`;

    for (const [name, person] of Object.entries(people)) tokens[name] = await login(person.email);
    for (const [name, org] of Object.entries({ a1, a2, b1, l1 }))
      tokens[name] = await login(org.admin.email);
  }, 180_000);

  afterAll(async () => {
    await h.clearRateLimits();
    const orgs = [...new Set(createdOrgs)];
    const list = (ids: string[]) =>
      sql.join(
        ids.map((id) => sql`${id}`),
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
          sql`DELETE FROM user_roles WHERE (user_id IN (${list(createdUsers)}) OR org_id IN (${list(orgs)})) AND NOT (scope_type = 'organization' AND org_id IN (${list(orgs)}))`,
        );
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
      for (const table of ['ws_tickets', 'api_keys', 'idempotency_keys', 'teams', 'workspaces']) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${list(orgs)})`);
      }
      // The organizations go inside this provisioning transaction: their
      // organization-scope grants, roles and role permissions cascade with them,
      // the one exemption of the last-organization-administrator rule (0028).
      await tx.execute(sql`DELETE FROM organizations WHERE id IN (${list(orgs)})`);
    });
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await h.admin.execute(sql`DELETE FROM organizations WHERE id IN (${list(orgs)})`);
    await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await h.admin.delete(schema.resellers).where(inArray(schema.resellers.id, createdResellers));
    await h.close();
  }, 180_000);

  const ORG_KEYS = [
    'billingMode',
    'billingPolicy',
    'createdAt',
    'gstin',
    'id',
    'legalName',
    'name',
    'resellerId',
    'slug',
    'status',
    'statusChangedAt',
    'updatedAt',
  ];

  // ===========================================================================
  describe('creation authority (F-3)', () => {
    it('1. a platform administrator creates an organization beneath the platform-default reseller, fully initialized', async () => {
      const slug = `plat-${suffix()}`;
      const res = await call('post', tokens.platform!, '/organizations')
        .send({ name: 'Platform Co', slug })
        .expect(201);
      const org = res.body.data;
      track(org.id);
      expect(Object.keys(org).sort()).toEqual(ORG_KEYS);
      expect(org).toMatchObject({
        slug,
        resellerId: defaultReseller,
        status: 'active',
        statusChangedAt: null,
      });

      const roles = await h.admin
        .select({ key: schema.roles.key, system: schema.roles.isSystemRole })
        .from(schema.roles)
        .where(eq(schema.roles.orgId, org.id));
      expect(roles.map((r) => r.key).sort()).toEqual(Object.values(TENANT_ROLE_KEYS).sort());
      expect(roles.every((r) => r.system)).toBe(true);
      const workspaces = await h.admin
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.orgId, org.id));
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]).toMatchObject({
        orgId: org.id,
        slug: 'default',
        isDefault: true,
        status: 'active',
      });

      const created = await auditFor(org.id, AUDIT_ACTIONS.ORGANIZATION_CREATED);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        actor_type: 'user',
        actor_user_id: people.platform!.userId,
        scope_type: 'organization',
        scope_id: org.id,
      });
      expect(await auditFor(org.id, AUDIT_ACTIONS.WORKSPACE_CREATED)).toHaveLength(1);
      expect(await auditFor(org.id, AUDIT_ACTIONS.ROLE_CREATED)).toHaveLength(5);
    });

    it('1. a platform administrator may name any reseller and set billing fields', async () => {
      const res = await call('post', tokens.platform!, '/organizations')
        .send({
          name: 'Billed',
          slug: `bill-${suffix()}`,
          resellerId: resellerB,
          billingMode: 'postpaid',
        })
        .expect(201);
      track(res.body.data.id);
      expect(res.body.data).toMatchObject({ resellerId: resellerB, billingMode: 'postpaid' });
    });

    it('2. a reseller administrator creates beneath its own reseller, named or implied', async () => {
      const implied = await call('post', tokens.resellerA!, '/organizations')
        .send({ name: 'RA implied', slug: `ra-i-${suffix()}` })
        .expect(201);
      track(implied.body.data.id);
      expect(implied.body.data.resellerId).toBe(resellerA);
      const named = await call('post', tokens.resellerA!, '/organizations')
        .send({ name: 'RA named', slug: `ra-n-${suffix()}`, resellerId: resellerA })
        .expect(201);
      track(named.body.data.id);
      expect(named.body.data.resellerId).toBe(resellerA);
      expect(await auditFor(named.body.data.id, AUDIT_ACTIONS.ORGANIZATION_CREATED)).toHaveLength(
        1,
      );
    });

    it('3/16. reseller A cannot create beneath reseller B — the forged reseller is invisible (404), nothing is created', async () => {
      const slug = `ra-b-${suffix()}`;
      const res = await call('post', tokens.resellerA!, '/organizations')
        .send({ name: 'x', slug, resellerId: resellerB })
        .expect(404);
      expect(JSON.stringify(res.body)).not.toContain(resellerB);
      expect(await orgBySlug(slug)).toBeUndefined();
      // Nor beneath a reseller id that does not exist at all — same answer.
      const unknown = await call('post', tokens.resellerA!, '/organizations')
        .send({ name: 'x', slug, resellerId: uuidv7() })
        .expect(404);
      expect({ ...unknown.body.error, correlationId: 0 }).toEqual({
        ...res.body.error,
        correlationId: 0,
      });
    });

    it('3. a reseller administrator cannot set billing fields', async () => {
      const slug = `ra-bill-${suffix()}`;
      await call('post', tokens.resellerA!, '/organizations')
        .send({ name: 'x', slug, billingMode: 'postpaid' })
        .expect(403);
      expect(await orgBySlug(slug)).toBeUndefined();
    });

    it('4. an organization administrator cannot create organizations, and the refusal is audited at its own scope', async () => {
      const slug = `oa-${suffix()}`;
      const res = await call('post', tokens.a1!, '/organizations')
        .send({ name: 'x', slug, resellerId: resellerA })
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      expect(await orgBySlug(slug)).toBeUndefined();
      const denied = await auditFor(a1.orgId, AUDIT_ACTIONS.AUTHORIZATION_DENIED);
      const mine = denied.filter((r) => r.actor_user_id === a1.admin.userId);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.at(-1)).toMatchObject({ scope_type: 'organization', scope_id: a1.orgId });
      // Without naming a reseller: still refused, nothing created.
      await call('post', tokens.a1!, '/organizations').send({ name: 'x', slug }).expect(403);
      expect(await orgBySlug(slug)).toBeUndefined();
    });

    it('4. alendei_support and API keys cannot create organizations', async () => {
      const slug = `sup-${suffix()}`;
      const support = await call('post', tokens.support!, '/organizations', a1.orgId)
        .send({ name: 'x', slug })
        .expect(403);
      expect(support.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      await request(h.app.getHttpServer())
        .post(url('/organizations'))
        .set('authorization', `Bearer ${l1Key}`)
        .send({ name: 'x', slug })
        .expect(403);
      expect(await orgBySlug(slug)).toBeUndefined();
    });

    it('a duplicate slug is 409 and creates nothing', async () => {
      const [existing] = await h.admin
        .select({ slug: schema.organizations.slug })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, a1.orgId));
      const res = await call('post', tokens.platform!, '/organizations')
        .send({ name: 'dup', slug: existing!.slug })
        .expect(409);
      expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
    });
  });

  // ===========================================================================
  describe('atomicity (19–21)', () => {
    it('20. a TenantRoleProvisioner failure rolls back the whole creation', async () => {
      const provisioner = h.app.get(TenantRoleProvisioner);
      const spy = jest
        .spyOn(provisioner, 'seedTenantRoles')
        .mockRejectedValueOnce(new Error('injected provisioner failure'));
      const slug = `atomic-p-${suffix()}`;
      try {
        await call('post', tokens.platform!, '/organizations')
          .send({ name: 'x', slug })
          .expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(await orgBySlug(slug)).toBeUndefined();
      const { rows } = await h.admin.execute(
        sql`SELECT 1 FROM audit_logs WHERE after->>'slug' = ${slug}`,
      );
      expect(rows).toEqual([]);
    });

    it('21. a default-workspace failure rolls back the organization and its seeded roles', async () => {
      const service = h.app.get(OrganizationAdministrationService);
      let seededOrgId: string | null = null;
      const spy = jest
        .spyOn(service, 'createDefaultWorkspace')
        .mockImplementationOnce(async (_tx, _p, orgId) => {
          seededOrgId = orgId;
          throw new Error('injected default-workspace failure');
        });
      const slug = `atomic-w-${suffix()}`;
      try {
        await call('post', tokens.platform!, '/organizations')
          .send({ name: 'x', slug })
          .expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(seededOrgId).not.toBeNull();
      expect(await orgBySlug(slug)).toBeUndefined();
      expect(
        await h.admin.select().from(schema.roles).where(eq(schema.roles.orgId, seededOrgId!)),
      ).toEqual([]);
      expect(
        await h.admin
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.orgId, seededOrgId!)),
      ).toEqual([]);
      const { rows } = await h.admin.execute(
        sql`SELECT 1 FROM audit_logs WHERE org_id = ${seededOrgId!}`,
      );
      expect(rows).toEqual([]);
    });
  });

  // ===========================================================================
  describe('idempotent creation (22)', () => {
    const create = (token: string, body: object, key: string) =>
      call('post', token, '/organizations').set('idempotency-key', key).send(body);

    it('replays the original response verbatim and creates exactly one organization', async () => {
      const key = `org-create-${uuidv7()}`;
      const body = { name: 'Idem', slug: `idem-${suffix()}` };
      const first = await create(tokens.platform!, body, key).expect(201);
      track(first.body.data.id);
      const second = await create(tokens.platform!, body, key).expect(201);
      expect(second.body).toEqual(first.body);
      expect(
        await h.admin
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.slug, body.slug)),
      ).toHaveLength(1);
      expect(await auditFor(first.body.data.id, AUDIT_ACTIONS.ORGANIZATION_CREATED)).toHaveLength(
        1,
      );
    });

    it('the same key with a different body is 422, and creates nothing', async () => {
      const key = `org-mismatch-${uuidv7()}`;
      const first = await create(
        tokens.platform!,
        { name: 'A', slug: `idem-a-${suffix()}` },
        key,
      ).expect(201);
      track(first.body.data.id);
      const slug = `idem-b-${suffix()}`;
      const res = await create(tokens.platform!, { name: 'B', slug }, key).expect(422);
      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH);
      expect(await orgBySlug(slug)).toBeUndefined();
    });

    it('a key is never shared across principals: another caller’s identical request is its own request', async () => {
      const key = `org-principal-${uuidv7()}`;
      const body = { name: 'Shared', slug: `idem-s-${suffix()}`, resellerId: resellerA };
      const first = await create(tokens.platform!, body, key).expect(201);
      track(first.body.data.id);
      // Reseller A's administrator presents the same key and body: not a
      // replay of the platform's response — it runs, and the slug is taken.
      const other = await create(tokens.resellerA!, body, key).expect(409);
      expect(other.body.error.code).toBe(ERROR_CODES.RESOURCE_CONFLICT);
    });

    it('two concurrent identical requests produce one organization and the same answer', async () => {
      const key = `org-race-${uuidv7()}`;
      const body = { name: 'Race', slug: `idem-r-${suffix()}` };
      const [a, b] = await Promise.all([
        create(tokens.platform!, body, key),
        create(tokens.platform!, body, key),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(b.body).toEqual(a.body);
      track(a.body.data.id);
      expect(
        await h.admin
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.slug, body.slug)),
      ).toHaveLength(1);
    });

    it('a replay is refused once the caller’s authority is gone — a stored response is not a credential', async () => {
      const temp = await createUser('temp-reseller');
      await grant(
        temp.userId,
        await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
        'reseller',
        resellerA,
      );
      const token = await login(temp.email);
      const key = `org-authz-${uuidv7()}`;
      const body = { name: 'Authz', slug: `idem-z-${suffix()}` };
      const first = await create(token, body, key).expect(201);
      track(first.body.data.id);
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx.delete(schema.userRoles).where(eq(schema.userRoles.userId, temp.userId));
      });
      const replay = await create(token, body, key);
      expect([403, 404]).toContain(replay.status);
    });
  });

  // ===========================================================================
  describe('update and immutability (5, 6, F-8)', () => {
    it('an organization administrator updates its own mutable fields, audited with before/after', async () => {
      const res = await call('patch', tokens.a1!, `/organizations/${a1.orgId}`)
        .send({ name: 'A1 Renamed', legalName: 'A1 Legal' })
        .expect(200);
      expect(res.body.data).toMatchObject({ name: 'A1 Renamed', legalName: 'A1 Legal' });
      const updated = await auditFor(a1.orgId, AUDIT_ACTIONS.ORGANIZATION_UPDATED);
      expect(updated.at(-1)).toMatchObject({
        actor_user_id: a1.admin.userId,
        scope_type: 'organization',
        scope_id: a1.orgId,
      });
      expect(updated.at(-1)!.after).toMatchObject({ name: 'A1 Renamed', legalName: 'A1 Legal' });
    });

    it('5/6. resellerId, slug and status cannot be changed through PATCH — by anyone', async () => {
      const before = await orgRow(a1.orgId);
      for (const body of [
        { resellerId: resellerB },
        { slug: `moved-${suffix()}` },
        { status: 'closed' },
      ]) {
        for (const token of [tokens.a1!, tokens.resellerA!, tokens.platform!]) {
          const res = await call('patch', token, `/organizations/${a1.orgId}`)
            .send(body)
            .expect(400);
          expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
        }
      }
      const after = await orgRow(a1.orgId);
      expect({ resellerId: after!.resellerId, slug: after!.slug, status: after!.status }).toEqual({
        resellerId: before!.resellerId,
        slug: before!.slug,
        status: before!.status,
      });
    });

    it('billing fields are platform-only on update', async () => {
      await call('patch', tokens.a1!, `/organizations/${a1.orgId}`)
        .send({ billingMode: 'postpaid' })
        .expect(403);
      await call('patch', tokens.resellerA!, `/organizations/${a1.orgId}`)
        .send({ billingMode: 'postpaid' })
        .expect(403);
      expect((await orgRow(a1.orgId))!.billingMode).toBe('prepaid');
      await call('patch', tokens.platform!, `/organizations/${a1.orgId}`)
        .send({ billingMode: 'postpaid' })
        .expect(200);
      await call('patch', tokens.platform!, `/organizations/${a1.orgId}`)
        .send({ billingMode: 'prepaid' })
        .expect(200);
    });
  });

  // ===========================================================================
  describe('visibility and isolation (13–16, 24)', () => {
    it('13. an organization administrator lists only its own organization; siblings and other resellers are invisible', async () => {
      const res = await call('get', tokens.a1!, '/organizations?limit=100').expect(200);
      expect(res.body.data.map((o: { id: string }) => o.id)).toEqual([a1.orgId]);
      for (const other of [a2.orgId, b1.orgId]) {
        await call('get', tokens.a1!, `/organizations/${other}`).expect(404);
        await call('patch', tokens.a1!, `/organizations/${other}`).send({ name: 'x' }).expect(404);
      }
    });

    it('14. a reseller administrator lists its own organizations only, in any status', async () => {
      const res = await call('get', tokens.resellerA!, '/organizations?limit=100').expect(200);
      const ids = res.body.data.map((o: { id: string }) => o.id);
      expect(ids).toEqual(expect.arrayContaining([a1.orgId, a2.orgId, l1.orgId]));
      expect(ids).not.toContain(b1.orgId);
      expect(ids).not.toContain(l2.orgId);
      await call('get', tokens.resellerA!, `/organizations/${b1.orgId}`).expect(404);
      await call('get', tokens.resellerB!, `/organizations/${a1.orgId}`).expect(404);
    });

    it('16. filters narrow and never widen', async () => {
      const res = await call('get', tokens.a1!, `/organizations?resellerId=${resellerB}`).expect(
        200,
      );
      expect(res.body.data).toEqual([]);
    });

    it('platform principals list every organization; support included, without write authority', async () => {
      for (const who of ['platform', 'support']) {
        const res = await call(
          'get',
          tokens[who]!,
          '/organizations?limit=100&status=suspended',
        ).expect(200);
        expect(res.body.data.map((o: { id: string }) => o.id)).toContain(l2.orgId);
      }
      await call('get', tokens.support!, `/organizations/${b1.orgId}`).expect(200);
      await call('patch', tokens.support!, `/organizations/${b1.orgId}`)
        .send({ name: 'x' })
        .expect(403);
    });

    it('15/24. a forged or unknown organization id is a 404 byte-identical to a real foreign one', async () => {
      const foreign = await call('get', tokens.a1!, `/organizations/${b1.orgId}`).expect(404);
      const unknown = await call('get', tokens.a1!, `/organizations/${uuidv7()}`).expect(404);
      const strip = (b: { error: Record<string, unknown> }) => ({ ...b.error, correlationId: 0 });
      expect(strip(foreign.body)).toEqual(strip(unknown.body));
      expect(JSON.stringify(foreign.body)).not.toContain(b1.orgId);
      // Selecting a sibling through the header is refused as before.
      const header = await call('get', tokens.a1!, '/organizations', a2.orgId).expect(403);
      expect(header.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    // --- RLS backstop for the list (1C.1a remediation) --------------------------
    //
    // The list's candidates come from `acc_auth`, whose read policy admits every
    // organization; the rows come from `acc_app` under RLS. These reintroduce the
    // Gate B defect class into the reach calculation and require that PostgreSQL,
    // not the application, keeps the other tenants' rows out of the response.
    // Moving the row fetch back to `acc_auth` makes both return A2 (and B1) — a
    // `200` carrying another tenant's organization — and fail.

    type Reach = { everything: boolean; resellerIds: string[]; activeOrganizationIds: string[] };
    const mutateReach = (reach: (principal: { roles: { orgId: string | null }[] }) => Reach) =>
      jest
        .spyOn(OrganizationAdministrationService.prototype as never, 'readReach' as never)
        .mockImplementation(reach as never);
    const leaks = (body: unknown, orgs: Org[]) => {
      const text = JSON.stringify(body);
      return orgs.filter((o) => text.includes(o.orgId));
    };

    it('RLS backstop: a reseller wrongly derived from the caller’s organization cannot return a sibling’s row', async () => {
      // The pre-Gate-B defect: A1's administrator is given reseller reach over
      // A1's own reseller. The reach now admits A2 (and L1).
      const spy = mutateReach((principal) => ({
        everything: false,
        resellerIds: [resellerA],
        activeOrganizationIds: principal.roles.map((g) => g.orgId!).filter(Boolean),
      }));
      try {
        // The mutation took effect: under this reach the identity plane admits A2.
        const candidates = await h.app
          .get(TenantDatabase)
          .auth.select({ id: schema.organizations.id })
          .from(schema.organizations)
          .where(eq(schema.organizations.resellerId, resellerA));
        expect(candidates.map((c) => c.id)).toEqual(expect.arrayContaining([a1.orgId, a2.orgId]));

        const res = await call('get', tokens.a1!, '/organizations?limit=100');
        expect(leaks(res.body, [a2, b1, l1])).toEqual([]);
        expect(JSON.stringify(res.body)).not.toContain('O a2');
        // Fail closed: RLS withheld a candidate, so no partial page and no cursor.
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('RLS backstop: an organization administrator wrongly given platform-wide reach sees no other tenant, on any page', async () => {
      const spy = mutateReach(() => ({
        everything: true,
        resellerIds: [],
        activeOrganizationIds: [],
      }));
      try {
        const res = await call('get', tokens.a1!, '/organizations?limit=100');
        expect(leaks(res.body, [a2, b1, l1, l2])).toEqual([]);
        expect(res.status).toBe(500);

        // Page by page: every page RLS fully admits is returned, a page holding
        // a withheld row fails closed, and no page or cursor carries a foreign row.
        let cursor: string | null = null;
        let failed = false;
        for (let i = 0; i < 200 && !failed; i++) {
          const page = await call(
            'get',
            tokens.a1!,
            `/organizations?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
          expect(leaks(page.body, [a2, b1, l1, l2])).toEqual([]);
          if (page.status !== 200) {
            expect(page.status).toBe(500);
            failed = true;
            break;
          }
          for (const o of page.body.data) expect(o.id).toBe(a1.orgId);
          cursor = page.body.page.nextCursor;
          if (!cursor) break;
          const decoded = Buffer.from(cursor.split('.')[0]!, 'base64url').toString('utf8');
          expect(leaks(decoded, [a2, b1, l1, l2])).toEqual([]);
        }
        expect(failed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('two-stage list: every legitimate reach pages identically at limit=1 and limit=100', async () => {
      for (const who of ['a1', 'resellerA', 'resellerB', 'platform', 'support']) {
        const whole = await call('get', tokens[who]!, '/organizations?limit=100').expect(200);
        const expected = whole.body.data.map((o: { id: string }) => o.id);
        expect(whole.body.page.hasMore).toBe(false);

        const walked: string[] = [];
        let cursor: string | null = null;
        do {
          const page = await call(
            'get',
            tokens[who]!,
            `/organizations?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          ).expect(200);
          walked.push(...page.body.data.map((o: { id: string }) => o.id));
          expect(page.body.page.hasMore).toBe(page.body.page.nextCursor !== null);
          cursor = page.body.page.nextCursor;
        } while (cursor && walked.length <= expected.length);
        expect(walked).toEqual(expected);
        for (const o of whole.body.data) expect(Object.keys(o).sort()).toEqual(ORG_KEYS);
      }
    });

    it('24. an unconnected principal never learns a suspended organization’s status', async () => {
      // L2 (beneath reseller B) is suspended; nobody in reseller A is connected to it.
      const selected = await call('get', tokens.a1!, '/users', l2.orgId).expect(403);
      expect(selected.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      const byId = await call('get', tokens.a1!, `/organizations/${l2.orgId}`).expect(404);
      const unknown = await call('get', tokens.a1!, `/organizations/${uuidv7()}`).expect(404);
      expect({ ...byId.body.error, correlationId: 0 }).toEqual({
        ...unknown.body.error,
        correlationId: 0,
      });
      for (const body of [selected.body, byId.body])
        expect(JSON.stringify(body).toLowerCase()).not.toContain('suspend');
      await call('get', tokens.resellerA!, `/organizations/${l2.orgId}`).expect(404);
    });
  });

  // ===========================================================================
  describe('lifecycle authority (7–9) and transitions (F-1, 17, 18)', () => {
    it('7–9. nobody without platform.tenants.manage can suspend, reactivate or close', async () => {
      for (const action of ['suspend', 'reactivate', 'close']) {
        for (const token of [tokens.a1!, tokens.resellerA!, tokens.support!]) {
          const res = await call('post', token, `/organizations/${a1.orgId}/${action}`).send({});
          expect(`${action}:${res.status}`).toBe(`${action}:403`);
        }
        const key = await request(h.app.getHttpServer())
          .post(url(`/organizations/${l1.orgId}/${action}`))
          .set('authorization', `Bearer ${l1Key}`)
          .send({});
        expect(key.status).toBe(403);
      }
      expect((await orgRow(a1.orgId))!.status).toBe('active');
      expect((await orgRow(l1.orgId))!.status).toBe('active');
    });

    it('a refused lifecycle attempt by a connected principal is audited at the organization it addressed', async () => {
      await call('post', tokens.a1!, `/organizations/${a1.orgId}/suspend`).send({}).expect(403);
      const denied = (await auditFor(a1.orgId, AUDIT_ACTIONS.AUTHORIZATION_DENIED)).filter(
        (r) => r.actor_user_id === a1.admin.userId,
      );
      expect(denied.at(-1)).toMatchObject({ scope_type: 'organization', scope_id: a1.orgId });
      expect(denied.at(-1)!.metadata).toMatchObject({
        permission: 'platform.tenants.manage',
        attemptedScopeType: 'platform',
      });
    });

    it('17/18. the full transition matrix; each legal step audited with the platform actor, each illegal one a 409 that changes nothing', async () => {
      const subject = await call('post', tokens.platform!, '/organizations')
        .send({ name: 'Lifecycle', slug: `life-${suffix()}` })
        .expect(201);
      const id = track(subject.body.data.id);
      const go = (action: string, reason?: string) =>
        call('post', tokens.platform!, `/organizations/${id}/${action}`).send(
          reason ? { reason } : {},
        );

      // active: reactivate illegal
      let res = await go('reactivate').expect(409);
      expect(res.body.error).toMatchObject({
        code: ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT,
        details: { status: 'active' },
      });

      res = await go('suspend', 'billing hold').expect(200);
      expect(res.body.data).toMatchObject({ status: 'suspended' });
      expect(res.body.data.statusChangedAt).not.toBeNull();
      const suspended = await auditFor(id, AUDIT_ACTIONS.ORGANIZATION_SUSPENDED);
      expect(suspended).toHaveLength(1);
      expect(suspended[0]).toMatchObject({
        actor_type: 'user',
        actor_user_id: people.platform!.userId,
        scope_type: 'organization',
        scope_id: id,
      });
      expect(suspended[0]!.metadata).toMatchObject({ reason: 'billing hold' });
      expect((await orgRow(id))!.statusReason).toBe('billing hold');

      // suspended: suspend illegal, and it changes nothing
      const snapshot = await orgRow(id);
      res = await go('suspend').expect(409);
      expect(res.body.error.details).toEqual({ status: 'suspended' });
      expect(await orgRow(id)).toEqual(snapshot);
      expect(await auditFor(id, AUDIT_ACTIONS.ORGANIZATION_SUSPENDED)).toHaveLength(1);

      await go('reactivate').expect(200);
      expect(await auditFor(id, AUDIT_ACTIONS.ORGANIZATION_REACTIVATED)).toHaveLength(1);
      await go('suspend').expect(200);
      res = await go('close', 'contract ended').expect(200);
      expect(res.body.data.status).toBe('closed');
      expect(await auditFor(id, AUDIT_ACTIONS.ORGANIZATION_CLOSED)).toHaveLength(1);

      // closed is terminal
      for (const action of ['suspend', 'reactivate', 'close']) {
        const r = await go(action);
        expect(`${action}:${r.status}:${r.body.error?.details?.status}`).toBe(
          `${action}:409:closed`,
        );
      }
      // …and closing deleted nothing.
      expect(
        await h.admin.select().from(schema.roles).where(eq(schema.roles.orgId, id)),
      ).toHaveLength(5);
      expect(
        await h.admin.select().from(schema.workspaces).where(eq(schema.workspaces.orgId, id)),
      ).toHaveLength(1);
    });

    it('two concurrent transitions cannot both succeed', async () => {
      const subject = await call('post', tokens.platform!, '/organizations')
        .send({ name: 'Race', slug: `life-r-${suffix()}` })
        .expect(201);
      const id = track(subject.body.data.id);
      const [a, b] = await Promise.all([
        call('post', tokens.platform!, `/organizations/${id}/suspend`).send({}),
        call('post', tokens.platform!, `/organizations/${id}/suspend`).send({}),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await auditFor(id, AUDIT_ACTIONS.ORGANIZATION_SUSPENDED)).toHaveLength(1);
    });
  });

  // ===========================================================================
  describe('status enforcement (10–12, 23, F-4, F-5)', () => {
    const setStatus = async (orgId: string, status: 'active' | 'suspended' | 'closed') =>
      h.admin
        .update(schema.organizations)
        .set({ status })
        .where(eq(schema.organizations.id, orgId));

    afterEach(() => setStatus(l1.orgId, 'active'));

    it('10. a suspended organization’s members are refused on their next request — reads and writes alike', async () => {
      await call('get', tokens.l1!, '/users').expect(200);
      await setStatus(l1.orgId, 'suspended');
      for (const [method, path] of [
        ['get', '/users'],
        ['post', '/users'],
        ['get', '/tenants/workspaces'],
        ['post', '/ws/ticket'],
      ] as const) {
        const res = await call(method, tokens.l1!, path).send({});
        expect(`${method} ${path}:${res.status}:${res.body.error?.code}`).toBe(
          `${method} ${path}:403:${ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED}`,
        );
      }
      const me = await call('get', tokens.l1!, '/auth/me').expect(200);
      expect(me.body.data.authorizedOrganizationIds).not.toContain(l1.orgId);
      const byId = await call('get', tokens.l1!, `/organizations/${l1.orgId}`).expect(403);
      expect(byId.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED);
      // The reseller above it is connected, so it is told the status too.
      const reseller = await call('get', tokens.resellerA!, '/users', l1.orgId).expect(403);
      expect(reseller.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED);
      // …and still sees it, with its status, in its list.
      const listed = await call(
        'get',
        tokens.resellerA!,
        '/organizations?status=suspended&limit=100',
      ).expect(200);
      expect(listed.body.data.map((o: { id: string }) => o.id)).toContain(l1.orgId);
    });

    it('11. a closed organization’s members are refused with the closed code', async () => {
      await setStatus(l1.orgId, 'closed');
      const res = await call('post', tokens.l1!, '/users').send({}).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_CLOSED);
      const read = await call('get', tokens.l1!, '/users').expect(403);
      expect(read.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_CLOSED);
    });

    it('12. a platform principal can still inspect a suspended or closed organization, but not mutate its data', async () => {
      for (const status of ['suspended', 'closed'] as const) {
        await setStatus(l1.orgId, status);
        await call('get', tokens.platform!, '/users', l1.orgId).expect(200);
        await call('get', tokens.support!, '/users', l1.orgId).expect(200);
        const detail = await call('get', tokens.platform!, `/organizations/${l1.orgId}`).expect(
          200,
        );
        expect(detail.body.data.status).toBe(status);
        const mutation = await call('post', tokens.platform!, '/ws/ticket', l1.orgId)
          .send({})
          .expect(409);
        expect(mutation.body.error).toMatchObject({
          code: ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT,
          details: { status },
        });
        const patch = await call('patch', tokens.platform!, `/organizations/${l1.orgId}`)
          .send({ name: 'x' })
          .expect(409);
        expect(patch.body.error.details).toEqual({ status });
      }
      // The lifecycle transition itself remains available (F-5's exception).
      await setStatus(l1.orgId, 'suspended');
      await call('post', tokens.platform!, `/organizations/${l1.orgId}/reactivate`)
        .send({})
        .expect(200);
      await call('get', tokens.l1!, '/users').expect(200);
    });

    it('23. an API key bound to a suspended or closed organization stops working; a wrong secret learns nothing', async () => {
      const withKey = (credential: string) =>
        request(h.app.getHttpServer())
          .get(url('/tenants/workspaces'))
          .set('authorization', `Bearer ${credential}`);
      await h.clearRateLimits();
      await withKey(l1Key).expect(200);
      for (const status of ['suspended', 'closed'] as const) {
        await setStatus(l1.orgId, status);
        const res = await withKey(l1Key).expect(403);
        expect(res.body.error.code).toBe(
          status === 'suspended'
            ? ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED
            : ERROR_CODES.TENANCY_ORGANIZATION_CLOSED,
        );
        const [prefix] = l1Key.split('.');
        const wrong = await withKey(`${prefix}.not-the-secret`).expect(401);
        expect(wrong.body.error.code).toBe(ERROR_CODES.AUTH_API_KEY_INVALID);
        expect(JSON.stringify(wrong.body).toLowerCase()).not.toMatch(/suspend|closed/);
      }
      await h.clearRateLimits();
    });

    it('status is authorization, not RLS (OD-3): acc_app still sees a suspended organization’s rows in its own context', async () => {
      await setStatus(l1.orgId, 'suspended');
      const db = h.app.get(TenantDatabase);
      const rows = await db.withTenant({ orgId: l1.orgId, userId: l1.admin.userId }, (tx) =>
        tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.orgId, l1.orgId)),
      );
      expect(rows.length).toBeGreaterThan(0);
      const policies = await h.admin.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM pg_policies WHERE coalesce(qual,'') || coalesce(with_check,'') LIKE '%status%'`,
      );
      expect(policies.rows[0]!.n).toBe('0');
    });
  });
});
