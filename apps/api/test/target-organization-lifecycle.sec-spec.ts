/**
 * Target-organization lifecycle (Gate C remediation M-1, ADR-012 F-5) — security
 * suite.
 *
 * F-5: no tenant-data mutation is accepted in a suspended or closed
 * organization, except the lifecycle transitions themselves. `AuthGuard` judges
 * the *selected* organization; role grants, role revocations and API keys name
 * their *target* scope explicitly, and a principal whose authority spans several
 * organizations can select an active one and target a non-active sibling. These
 * cases prove the target's own organization — derived from the target's database
 * row — is judged too, and that the check widens nothing:
 *
 *     Reseller A ── A1 (active)   ← selected
 *                ├─ A2 (suspended) ← targeted
 *                └─ A3 (closed)    ← targeted
 *     Reseller B ── B1 (active)   ← an unconnected reseller
 *
 * Every case drives real HTTP with real tokens against the real database.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';

type Status = 'active' | 'suspended' | 'closed';

interface Org {
  orgId: string;
  workspaceId: string;
  teamId: string;
  roles: Record<string, string>;
  admin: { userId: string; email: string };
  /** A `read_only` grant at the organization, planted for revocation cases. */
  plantedGrantId: string;
  /** A live API key bound to the organization, planted for revocation cases. */
  plantedKeyId: string;
}

describe('target-organization lifecycle (Gate C M-1, ADR-012 F-5)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let resellerA: string;
  let resellerB: string;
  let a1: Org;
  let a2: Org;
  let a3: Org;
  let b1: Org;
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
    scopeType: 'platform' | 'reseller' | 'organization',
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

  async function plantKey(orgId: string, createdBy: string): Promise<string> {
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    const [key] = await h.admin
      .insert(schema.apiKeys)
      .values({
        orgId,
        name: `planted-${prefix}`,
        keyPrefix: prefix,
        keyHash: await credentials.hash(`s${uuidv7().replace(/-/g, '')}`),
        scopes: ['workspaces.read'],
        createdBy,
      })
      .returning({ id: schema.apiKeys.id });
    return key!.id;
  }

  /**
   * An organization planted by the owner — provisioned roles, a default
   * workspace, a team, an administrator, a revocable grant and a live key —
   * while active, and only then moved to `status`, exactly as a real one would
   * have accumulated state before being suspended or closed.
   */
  async function plantOrg(label: string, resellerId: string, status: Status): Promise<Org> {
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
    const roles = Object.fromEntries(rows.map((r) => [r.key, r.id]));
    const admin = await createUser(`${label}-admin`);
    await grant(admin.userId, roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, 'organization', orgId);
    const plantedGrantId = await grant(
      admin.userId,
      roles[TENANT_ROLE_KEYS.READ_ONLY]!,
      'organization',
      orgId,
    );
    const plantedKeyId = await plantKey(orgId, admin.userId);
    if (status !== 'active') {
      await h.admin
        .update(schema.organizations)
        .set({ status, statusChangedAt: new Date() })
        .where(eq(schema.organizations.id, orgId));
    }
    return {
      orgId,
      workspaceId: ws!.id,
      teamId: team!.id,
      roles,
      admin,
      plantedGrantId,
      plantedKeyId,
    };
  }

  async function login(email: string) {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    token: string,
    path: string,
    org?: string,
  ) => {
    const r = request(h.app.getHttpServer())
      [method](url(path))
      .set('authorization', `Bearer ${token}`);
    return org ? r.set('x-acc-organization', org) : r;
  };

  // --- request builders -----------------------------------------------------------

  type Target = { scopeType: 'organization' | 'workspace' | 'team'; scopeId: string };
  const atOrg = (o: Org): Target => ({ scopeType: 'organization', scopeId: o.orgId });
  const atWorkspace = (o: Org): Target => ({ scopeType: 'workspace', scopeId: o.workspaceId });
  const atTeam = (o: Org): Target => ({ scopeType: 'team', scopeId: o.teamId });

  /** Grants `o`'s `read_only` role to `o`'s administrator at `target`. */
  const grantReadOnly = (token: string, selected: string, o: Org, target: Target) =>
    call('post', token, '/role-assignments', selected).send({
      userId: o.admin.userId,
      roleId: o.roles[TENANT_ROLE_KEYS.READ_ONLY],
      ...target,
    });
  const revokeGrant = (token: string, selected: string, grantId: string) =>
    call('delete', token, `/role-assignments/${grantId}`, selected);
  const createKey = (token: string, selected: string, target: Target) =>
    call('post', token, '/api-keys', selected).send({
      name: `m1-${suffix()}`,
      scopes: ['workspaces.read'],
      ...target,
    });
  const revokeKey = (token: string, selected: string, keyId: string) =>
    call('post', token, `/api-keys/${keyId}/revoke`, selected);

  // --- database probes ------------------------------------------------------------

  const grantExists = async (id: string) =>
    (await h.admin.select().from(schema.userRoles).where(eq(schema.userRoles.id, id))).length === 1;
  const readOnlyGrantsAt = async (o: Org, target: Target) =>
    (
      await h.admin
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, o.admin.userId),
            eq(schema.userRoles.roleId, o.roles[TENANT_ROLE_KEYS.READ_ONLY]!),
            eq(schema.userRoles.scopeType, target.scopeType),
            eq(schema.userRoles.scopeId, target.scopeId),
          ),
        )
    ).length;
  const keyCount = async (orgId: string) =>
    (await h.admin.select().from(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId))).length;
  const keyRevokedAt = async (id: string) =>
    (
      await h.admin
        .select({ revokedAt: schema.apiKeys.revokedAt })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, id))
    )[0]!.revokedAt;

  /** The F-5 refusal: `409 ORGANIZATION_LIFECYCLE_CONFLICT` naming the target's status. */
  const expectLifecycleConflict = (
    res: request.Response,
    status: Exclude<Status, 'active'>,
  ): void => {
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT);
    expect(res.body.error.details).toEqual({ status });
  };

  /** A refusal that discloses nothing about the target — not even its status. */
  const expectInvisible = (res: request.Response): void => {
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/suspended|closed/i);
    for (const o of [a2, a3]) expect(text).not.toContain(o.orgId);
  };

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);

    resellerA = await createReseller('m1-a');
    resellerB = await createReseller('m1-b');
    a1 = await plantOrg('m1-a1', resellerA, 'active');
    a2 = await plantOrg('m1-a2', resellerA, 'suspended');
    a3 = await plantOrg('m1-a3', resellerA, 'closed');
    b1 = await plantOrg('m1-b1', resellerB, 'active');

    people.platform = await createUser('m1-platform');
    await grant(
      people.platform.userId,
      await platformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    people.resellerA = await createUser('m1-reseller-a');
    await grant(
      people.resellerA.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerA,
    );
    people.resellerB = await createUser('m1-reseller-b');
    await grant(
      people.resellerB.userId,
      await platformRole(PLATFORM_ROLE_KEYS.RESELLER_ADMIN),
      'reseller',
      resellerB,
    );
    people.a1Reader = await createUser('m1-a1-reader');
    await grant(
      people.a1Reader.userId,
      a1.roles[TENANT_ROLE_KEYS.READ_ONLY]!,
      'organization',
      a1.orgId,
    );

    for (const [name, person] of Object.entries(people)) tokens[name] = await login(person.email);
    tokens.a1 = await login(a1.admin.email);
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
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_reseller_admin_liveness`,
      );
      try {
        await tx.execute(
          sql`DELETE FROM user_roles WHERE (user_id IN (${list(createdUsers)}) OR org_id IN (${list(orgs)})) AND NOT (scope_type = 'organization' AND org_id IN (${list(orgs)}))`,
        );
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_reseller_admin_liveness`,
        );
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

  // ===========================================================================

  describe('reseller administrator: A1 selected, suspended A2 and closed A3 targeted', () => {
    it('creating a role assignment in A2 or A3 is 409 and grants nothing — at the organization, its workspace or its team', async () => {
      for (const [o, status] of [
        [a2, 'suspended'],
        [a3, 'closed'],
      ] as const) {
        for (const target of [atOrg(o), atWorkspace(o), atTeam(o)]) {
          expectLifecycleConflict(
            await grantReadOnly(tokens.resellerA!, a1.orgId, o, target),
            status,
          );
        }
      }
      // `atOrg` already held the planted grant; the others must hold nothing new.
      for (const o of [a2, a3]) {
        expect(await readOnlyGrantsAt(o, atOrg(o))).toBe(1);
        expect(await readOnlyGrantsAt(o, atWorkspace(o))).toBe(0);
        expect(await readOnlyGrantsAt(o, atTeam(o))).toBe(0);
      }
    });

    it('revoking a role assignment held in A2 or A3 is 409 and removes nothing', async () => {
      expectLifecycleConflict(
        await revokeGrant(tokens.resellerA!, a1.orgId, a2.plantedGrantId),
        'suspended',
      );
      expectLifecycleConflict(
        await revokeGrant(tokens.resellerA!, a1.orgId, a3.plantedGrantId),
        'closed',
      );
      expect(await grantExists(a2.plantedGrantId)).toBe(true);
      expect(await grantExists(a3.plantedGrantId)).toBe(true);
    });

    it('creating or revoking an API key in A2 or A3 is refused and changes nothing (reseller_admin carries no API-key permission)', async () => {
      const before = { a2: await keyCount(a2.orgId), a3: await keyCount(a3.orgId) };
      for (const o of [a2, a3]) {
        const created = await createKey(tokens.resellerA!, a1.orgId, atOrg(o));
        expect(created.status).toBe(403);
        expect(created.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
        const revoked = await revokeKey(tokens.resellerA!, a1.orgId, o.plantedKeyId);
        expect(revoked.status).toBe(403);
        expect(await keyRevokedAt(o.plantedKeyId)).toBeNull();
      }
      expect({ a2: await keyCount(a2.orgId), a3: await keyCount(a3.orgId) }).toEqual(before);
    });

    it('positive control: the same grant and revoke against active A1 succeed', async () => {
      const granted = await grantReadOnly(tokens.resellerA!, a1.orgId, a1, atWorkspace(a1));
      expect(granted.status).toBe(201);
      expect(await revokeGrant(tokens.resellerA!, a1.orgId, granted.body.data.id)).toHaveProperty(
        'status',
        204,
      );
      expect(await readOnlyGrantsAt(a1, atWorkspace(a1))).toBe(0);
    });
  });

  describe('platform super administrator: A1 selected, suspended A2 and closed A3 targeted', () => {
    it('grants, revocations, API-key creation and API-key revocation in A2 and A3 are all 409 and change nothing', async () => {
      const keysBefore = { a2: await keyCount(a2.orgId), a3: await keyCount(a3.orgId) };
      for (const [o, status] of [
        [a2, 'suspended'],
        [a3, 'closed'],
      ] as const) {
        for (const target of [atOrg(o), atWorkspace(o), atTeam(o)]) {
          expectLifecycleConflict(
            await grantReadOnly(tokens.platform!, a1.orgId, o, target),
            status,
          );
        }
        expectLifecycleConflict(await createKey(tokens.platform!, a1.orgId, atOrg(o)), status);
        expectLifecycleConflict(
          await createKey(tokens.platform!, a1.orgId, atWorkspace(o)),
          status,
        );
        expectLifecycleConflict(
          await revokeGrant(tokens.platform!, a1.orgId, o.plantedGrantId),
          status,
        );
        expectLifecycleConflict(
          await revokeKey(tokens.platform!, a1.orgId, o.plantedKeyId),
          status,
        );

        expect(await grantExists(o.plantedGrantId)).toBe(true);
        expect(await keyRevokedAt(o.plantedKeyId)).toBeNull();
        expect(await readOnlyGrantsAt(o, atWorkspace(o))).toBe(0);
        expect(await readOnlyGrantsAt(o, atTeam(o))).toBe(0);
      }
      expect({ a2: await keyCount(a2.orgId), a3: await keyCount(a3.orgId) }).toEqual(keysBefore);
    });

    it('positive control: grant, revoke, API-key creation and API-key revocation against active A1 succeed', async () => {
      const granted = await grantReadOnly(tokens.platform!, a1.orgId, a1, atTeam(a1));
      expect(granted.status).toBe(201);
      expect(await revokeGrant(tokens.platform!, a1.orgId, granted.body.data.id)).toHaveProperty(
        'status',
        204,
      );

      const key = await createKey(tokens.platform!, a1.orgId, atOrg(a1));
      expect(key.status).toBe(201);
      const revoked = await revokeKey(tokens.platform!, a1.orgId, key.body.data.id);
      expect(revoked.status).toBe(200);
      expect(revoked.body.data.status).toBe('revoked');
    });
  });

  describe('the target-lifecycle check widens nothing', () => {
    it('an unconnected reseller administrator gets 404 for A1, A2 and A3 — never a 409 that would disclose status', async () => {
      for (const o of [a1, a2, a3]) {
        expectInvisible(await grantReadOnly(tokens.resellerB!, b1.orgId, o, atOrg(o)));
        expectInvisible(await revokeGrant(tokens.resellerB!, b1.orgId, o.plantedGrantId));
      }
    });

    it('an organization administrator of A1 cannot reach A2 or A3 through any of the four operations — 404, status undisclosed', async () => {
      for (const o of [a2, a3]) {
        expectInvisible(await grantReadOnly(tokens.a1!, a1.orgId, o, atOrg(o)));
        expectInvisible(await grantReadOnly(tokens.a1!, a1.orgId, o, atWorkspace(o)));
        expectInvisible(await revokeGrant(tokens.a1!, a1.orgId, o.plantedGrantId));
        expectInvisible(await createKey(tokens.a1!, a1.orgId, atOrg(o)));
        expectInvisible(await revokeKey(tokens.a1!, a1.orgId, o.plantedKeyId));
      }
    });

    it('scope coverage is still enforced inside an active organization: a reader cannot grant or create keys (403)', async () => {
      const granted = await grantReadOnly(tokens.a1Reader!, a1.orgId, a1, atWorkspace(a1));
      expect(granted.status).toBe(403);
      expect(granted.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      const key = await createKey(tokens.a1Reader!, a1.orgId, atOrg(a1));
      expect(key.status).toBe(403);
      expect(key.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    });

    it('the selected-organization check is unchanged: selecting A2 or A3 directly is refused with its status', async () => {
      const suspended = await grantReadOnly(tokens.resellerA!, a2.orgId, a2, atWorkspace(a2));
      expect(suspended.status).toBe(403);
      expect(suspended.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_SUSPENDED);
      const closed = await grantReadOnly(tokens.resellerA!, a3.orgId, a3, atWorkspace(a3));
      expect(closed.status).toBe(403);
      expect(closed.body.error.code).toBe(ERROR_CODES.TENANCY_ORGANIZATION_CLOSED);
    });
  });

  describe('platform lifecycle transitions are unaffected', () => {
    it('reactivating A2 re-admits the mutation; suspending it again refuses it; closed A3 stays terminal', async () => {
      await call('post', tokens.platform!, `/organizations/${a2.orgId}/reactivate`)
        .send({})
        .expect(200);
      const granted = await grantReadOnly(tokens.resellerA!, a1.orgId, a2, atTeam(a2));
      expect(granted.status).toBe(201);

      await call('post', tokens.platform!, `/organizations/${a2.orgId}/suspend`)
        .send({ reason: 'M-1 regression' })
        .expect(200);
      expectLifecycleConflict(
        await revokeGrant(tokens.resellerA!, a1.orgId, granted.body.data.id),
        'suspended',
      );
      expect(await grantExists(granted.body.data.id)).toBe(true);

      const reopened = await call(
        'post',
        tokens.platform!,
        `/organizations/${a3.orgId}/reactivate`,
      ).send({});
      expect(reopened.status).toBe(409);
      expect(reopened.body.error.code).toBe(ERROR_CODES.ORGANIZATION_LIFECYCLE_CONFLICT);
    });
  });
});
