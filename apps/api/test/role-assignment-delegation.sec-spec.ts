/**
 * ADR-015 R-6 — the grant side of tenant delegation (`RBAC.md` §7b), and the
 * API surface of the R-5 tenant-content keys.
 *
 * Guard 4 of `RoleAssignmentService.grant` ("the actor holds every permission
 * of the role at a covering scope") may be satisfied by delegation only when
 * all of these hold: the role is in `DELEGABLE_TENANT_SYSTEM_ROLES`
 * (`['org_admin']`); it is a seeded system role owned by the target
 * organization; the grant is at organization scope in that organization; the
 * actor holds `platform.roles.delegate_tenant` at platform scope (through the
 * evaluator); what the actor lacks is non-empty and only tenant-content keys;
 * the target is not the actor. Anything else is the ordinary refusal —
 * `403 AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION`, `details.rejected` — and no row.
 *
 * No seeded role carries a tenant-content key (they are inert, follow-up
 * decision 6), so every role that does here is a **disposable-test fixture**:
 * the owner attaches the key to a test organization's role on this clone.
 * `TENANT_ROLE_DEFINITIONS` is never changed for it. Revocation by delegation
 * is R-11's and is not exercised.
 */
import {
  API_SURFACE_PERMISSION_KEYS,
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  PLATFORM_ROLE_KEYS,
  TENANT_CONTENT_PERMISSIONS,
  TENANT_ROLE_DEFINITIONS,
  TENANT_ROLE_KEYS,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { TenantRoleProvisioner } from '../src/rbac/tenant-role-provisioner.service';
import { PASSWORD, PREFIX, purgeAudit, startHarness, type Harness } from './auth-harness';

interface Org {
  orgId: string;
  workspaceId: string;
  roles: Record<string, string>;
}

const DELEGATE = PERMISSIONS.PLATFORM_ROLES_DELEGATE_TENANT;
const ORG_ADMIN_PERMISSIONS = TENANT_ROLE_DEFINITIONS.find(
  (r) => r.key === TENANT_ROLE_KEYS.ORG_ADMIN,
)!.permissions;
/** The fixture content keys attached to the delegable org_admin (sorted). */
const FIXTURE_CONTENT = ['contacts.read', 'templates.read'];

describe('tenant delegation on grant (ADR-015 R-6) and the content-key API surface (R-5)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let reseller: string;
  /** org_admin carries the fixture content keys. */
  let t: Org;
  /** org_admin widened (fixture) to organization+workspace, carrying contacts.read. */
  let t2: Org;
  /** Production roles, untouched: no content key anywhere. */
  let c: Org;
  /** Another organization whose org_admin carries contacts.read. */
  let u: Org;
  /** An organization whose `org_admin` is a NON-system role carrying contacts.read. */
  let v: { orgId: string; roleId: string; readerRoleId: string };
  let customContentRole: string;
  const people: Record<string, { userId: string; email: string }> = {};
  const tokens: Record<string, string> = {};
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];
  const createdPlatformRoles: string[] = [];

  const url = (p: string) => `/${PREFIX}${p}`;
  const suffix = () => uuidv7().replace(/-/g, '').slice(-10);

  // --- fixtures ---------------------------------------------------------------

  async function createUser(label: string) {
    const email = `${label}-${suffix()}@example.test`;
    const [row] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    createdUsers.push(row!.id);
    return { userId: row!.id, email };
  }

  async function grant(
    userId: string,
    roleId: string,
    scopeType: 'platform' | 'organization',
    scopeId: string | null,
  ) {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({ userId, roleId, scopeType, scopeId });
    });
  }

  async function permissionIds(keys: readonly string[]): Promise<string[]> {
    const rows = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(inArray(schema.permissions.key, [...keys]));
    expect(rows).toHaveLength(keys.length);
    return rows.map((r) => r.id);
  }

  /** Owner-only fixture write to a (possibly system) role's permission set. */
  async function attachFixture(roleId: string, keys: readonly string[]) {
    const ids = await permissionIds(keys);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      for (const permissionId of ids) {
        await tx.insert(schema.rolePermissions).values({ roleId, permissionId });
      }
    });
  }

  async function plantOrg(label: string): Promise<Org> {
    const [org] = await h.admin
      .insert(schema.organizations)
      .values({ name: `D ${label}`, slug: `d-${label}-${suffix()}`, resellerId: reseller })
      .returning({ id: schema.organizations.id });
    createdOrgs.push(org!.id);
    const [ws] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: org!.id, name: 'Default', slug: 'default', isDefault: true })
      .returning({ id: schema.workspaces.id });
    const provisioner = h.app.get(TenantRoleProvisioner);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await provisioner.seedTenantRoles(tx as unknown as Transaction, org!.id, {
        correlationId: uuidv7(),
      });
    });
    const rows = await h.admin
      .select({ id: schema.roles.id, key: schema.roles.key })
      .from(schema.roles)
      .where(eq(schema.roles.orgId, org!.id));
    return {
      orgId: org!.id,
      workspaceId: ws!.id,
      roles: Object.fromEntries(rows.map((r) => [r.key, r.id])),
    };
  }

  /** A custom platform role at {platform} carrying exactly `keys`. */
  async function platformRole(label: string, keys: readonly string[]): Promise<string> {
    const ids = await permissionIds(keys);
    return h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      const [role] = await tx
        .insert(schema.roles)
        .values({
          orgId: null,
          key: `dlg_${label}_${suffix()}`,
          name: `Delegation test ${label}`,
          isSystemRole: false,
          allowedScopeTypes: ['platform'],
        })
        .returning({ id: schema.roles.id });
      createdPlatformRoles.push(role!.id);
      for (const permissionId of ids) {
        await tx.insert(schema.rolePermissions).values({ roleId: role!.id, permissionId });
      }
      return role!.id;
    });
  }

  async function seededPlatformRole(key: string) {
    const [r] = await h.admin
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, key), isNull(schema.roles.orgId)));
    return r!.id;
  }

  /** A fresh member of `org` (reachable: it holds read_only there). */
  async function member(org: Org, label: string): Promise<string> {
    const person = await createUser(label);
    await grant(person.userId, org.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', org.orgId);
    return person.userId;
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
  const grantVia = (
    token: string,
    org: string,
    body: { userId: string; roleId: string; scopeType: string; scopeId: string },
  ) => call('post', token, '/role-assignments', org).send(body);

  const grantsOf = async (userId: string, roleId: string) =>
    h.admin
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.roleId, roleId)));
  const grantedAudit = async (resourceId: string) =>
    (
      await h.admin.execute<{ metadata: Record<string, unknown>; actor_user_id: string }>(
        sql`SELECT metadata, actor_user_id FROM audit_logs
            WHERE action = ${AUDIT_ACTIONS.USER_ROLE_GRANTED} AND resource_id = ${resourceId}`,
      )
    ).rows;

  /** The ordinary guard-4 refusal, unchanged, and no row. */
  async function expectRefused(
    res: request.Response,
    userId: string,
    roleId: string,
    rejected: readonly string[],
  ) {
    expect([res.status, res.body.error?.code]).toEqual([
      403,
      ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
    ]);
    expect([...(res.body.error.details.rejected as string[])].sort()).toEqual([...rejected].sort());
    expect(await grantsOf(userId, roleId)).toEqual([]);
  }

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    const [r] = await h.admin
      .insert(schema.resellers)
      .values({ name: 'Delegation', slug: `dlg-${suffix()}` })
      .returning({ id: schema.resellers.id });
    reseller = r!.id;

    t = await plantOrg('t');
    t2 = await plantOrg('t2');
    c = await plantOrg('c');
    u = await plantOrg('u');

    // Disposable-test fixtures: content keys on this clone's test roles only.
    await attachFixture(t.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, FIXTURE_CONTENT);
    await attachFixture(t.roles[TENANT_ROLE_KEYS.WORKSPACE_MANAGER]!, ['contacts.read']);
    await attachFixture(u.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, ['contacts.read']);
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx
        .update(schema.roles)
        .set({ allowedScopeTypes: ['organization', 'workspace'] })
        .where(eq(schema.roles.id, t2.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!));
    });
    await attachFixture(t2.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!, ['contacts.read']);

    const [custom] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: t.orgId,
        key: 'content_custom',
        name: 'Custom with content',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      })
      .returning({ id: schema.roles.id });
    customContentRole = custom!.id;
    await attachFixture(customContentRole, ['contacts.read', 'users.read']);

    // An organization whose `org_admin` key belongs to a custom (non-system) role.
    const [vOrg] = await h.admin
      .insert(schema.organizations)
      .values({ name: 'D v', slug: `d-v-${suffix()}`, resellerId: reseller })
      .returning({ id: schema.organizations.id });
    createdOrgs.push(vOrg!.id);
    const [vRole] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: vOrg!.id,
        key: TENANT_ROLE_KEYS.ORG_ADMIN,
        name: 'Not the system org_admin',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      })
      .returning({ id: schema.roles.id });
    await attachFixture(vRole!.id, [...ORG_ADMIN_PERMISSIONS, 'contacts.read']);
    // A second role so a target can be made reachable in V without holding org_admin.
    const [vReader] = await h.admin
      .insert(schema.roles)
      .values({
        orgId: vOrg!.id,
        key: 'v_reader',
        name: 'Reader',
        isSystemRole: false,
        allowedScopeTypes: ['organization'],
      })
      .returning({ id: schema.roles.id });
    await attachFixture(vReader!.id, ['users.read']);
    v = { orgId: vOrg!.id, roleId: vRole!.id, readerRoleId: vReader!.id };

    const nonContent = ORG_ADMIN_PERMISSIONS;
    people.superAdmin = await createUser('dlg-super');
    await grant(
      people.superAdmin.userId,
      await seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
      'platform',
      null,
    );
    people.delegator = await createUser('dlg-full');
    await grant(
      people.delegator.userId,
      await platformRole('full', [DELEGATE, ...nonContent]),
      'platform',
      null,
    );
    people.noDisable = await createUser('dlg-nodisable');
    await grant(
      people.noDisable.userId,
      await platformRole(
        'nodisable',
        [DELEGATE, ...nonContent].filter((k) => k !== PERMISSIONS.USERS_DISABLE),
      ),
      'platform',
      null,
    );
    people.tenantsManager = await createUser('dlg-tm');
    await grant(
      people.tenantsManager.userId,
      await platformRole('tm', [PERMISSIONS.PLATFORM_TENANTS_MANAGE, ...nonContent]),
      'platform',
      null,
    );
    people.cAdmin = await createUser('dlg-c-admin');
    await grant(
      people.cAdmin.userId,
      c.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
      'organization',
      c.orgId,
    );

    for (const [name, person] of Object.entries(people)) tokens[name] = await login(person.email);
  }, 180_000);

  afterAll(async () => {
    await h.clearRateLimits();
    const list = (ids: string[]) =>
      sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
    await purgeAudit(
      h.admin,
      sql`org_id IN (${list(createdOrgs)}) OR actor_user_id IN (${list(createdUsers)})`,
    );
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.provisioning','on',true)`);
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.execute(
        sql`ALTER TABLE user_roles DISABLE TRIGGER trg_user_roles_platform_admin_liveness`,
      );
      try {
        await tx.execute(
          sql`DELETE FROM user_roles WHERE (user_id IN (${list(createdUsers)}) OR org_id IN (${list(createdOrgs)})) AND NOT (scope_type = 'organization' AND org_id IN (${list(createdOrgs)}))`,
        );
      } finally {
        await tx.execute(
          sql`ALTER TABLE user_roles ENABLE TRIGGER trg_user_roles_platform_admin_liveness`,
        );
      }
      for (const table of ['api_keys', 'idempotency_keys', 'workspaces']) {
        await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id IN (${list(createdOrgs)})`);
      }
      // The organizations go inside this provisioning transaction: their
      // organization-scope grants, roles and role permissions cascade with them,
      // the one exemption of the last-organization-administrator rule (0028).
      await tx.execute(sql`DELETE FROM organizations WHERE id IN (${list(createdOrgs)})`);
      await tx.execute(
        sql`DELETE FROM role_permissions WHERE role_id IN (${list(createdPlatformRoles)})`,
      );
      await tx.execute(sql`DELETE FROM roles WHERE id IN (${list(createdPlatformRoles)})`);
    });
    await h.admin.execute(sql`DELETE FROM sessions WHERE user_id IN (${list(createdUsers)})`);
    await h.admin.execute(sql`DELETE FROM organizations WHERE id IN (${list(createdOrgs)})`);
    await h.admin.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await h.admin.execute(sql`DELETE FROM resellers WHERE id = ${reseller}`);
    await h.close();
  }, 60_000);

  // ===========================================================================
  describe('A. a delegated grant', () => {
    it('super admin appoints org_admin carrying content keys it does not hold: 201, audited as delegation', async () => {
      const target = await member(t, 'dlg-target');
      const roleId = t.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      const res = await grantVia(tokens.superAdmin!, t.orgId, {
        userId: target,
        roleId,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
      expect(res.status).toBe(201);
      expect(await grantsOf(target, roleId)).toHaveLength(1);
      const audit = await grantedAudit(res.body.data.id);
      expect(audit).toEqual([
        {
          actor_user_id: people.superAdmin!.userId,
          metadata: {
            roleKey: TENANT_ROLE_KEYS.ORG_ADMIN,
            grantedTo: target,
            delegation: true,
            delegatedPermissions: FIXTURE_CONTENT,
          },
        },
      ]);
    });

    it('any platform principal holding delegate_tenant and every non-content key qualifies — decided by permission, not role name', async () => {
      const target = await member(t, 'dlg-target2');
      const roleId = t.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      const res = await grantVia(tokens.delegator!, t.orgId, {
        userId: target,
        roleId,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
      expect(res.status).toBe(201);
      expect((await grantedAudit(res.body.data.id))[0]!.metadata).toEqual({
        roleKey: TENANT_ROLE_KEYS.ORG_ADMIN,
        grantedTo: target,
        delegation: true,
        delegatedPermissions: FIXTURE_CONTENT,
      });
    });

    it('an ordinary grant of a content-free org_admin by super admin records no delegation', async () => {
      const target = await member(c, 'dlg-plain');
      const res = await grantVia(tokens.superAdmin!, c.orgId, {
        userId: target,
        roleId: c.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!,
        scopeType: 'organization',
        scopeId: c.orgId,
      });
      expect(res.status).toBe(201);
      expect((await grantedAudit(res.body.data.id))[0]!.metadata).toEqual({
        roleKey: TENANT_ROLE_KEYS.ORG_ADMIN,
        grantedTo: target,
      });
    });
  });

  // ===========================================================================
  describe('B. every other case is the ordinary refusal, with no row', () => {
    it('an actor without delegate_tenant — platform.tenants.manage does not stand in for it', async () => {
      const target = await member(t, 'dlg-n1');
      const roleId = t.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      const res = await grantVia(tokens.tenantsManager!, t.orgId, {
        userId: target,
        roleId,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
      await expectRefused(res, target, roleId, FIXTURE_CONTENT);
    });

    it('a custom role carrying a content key', async () => {
      const target = await member(t, 'dlg-n2');
      const res = await grantVia(tokens.superAdmin!, t.orgId, {
        userId: target,
        roleId: customContentRole,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
      await expectRefused(res, target, customContentRole, ['contacts.read']);
    });

    it('a non-system role keyed org_admin carrying a content key', async () => {
      const target = await createUser('dlg-n3');
      await grant(target.userId, v.readerRoleId, 'organization', v.orgId);
      const res = await grantVia(tokens.superAdmin!, v.orgId, {
        userId: target.userId,
        roleId: v.roleId,
        scopeType: 'organization',
        scopeId: v.orgId,
      });
      await expectRefused(res, target.userId, v.roleId, ['contacts.read']);
    });

    it('a system role outside the delegable set (workspace_manager carrying a content key)', async () => {
      const target = await member(t, 'dlg-n4');
      const roleId = t.roles[TENANT_ROLE_KEYS.WORKSPACE_MANAGER]!;
      const res = await grantVia(tokens.superAdmin!, t.orgId, {
        userId: target,
        roleId,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
      await expectRefused(res, target, roleId, ['contacts.read']);
    });

    it('the org_admin of another organization', async () => {
      const target = await member(t, 'dlg-n5');
      const roleId = u.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      const res = await grantVia(tokens.superAdmin!, t.orgId, {
        userId: target,
        roleId,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
      await expectRefused(res, target, roleId, ['contacts.read']);
    });

    it('a grant at workspace scope (org_admin widened by fixture to admit it)', async () => {
      const target = await member(t2, 'dlg-n6');
      const roleId = t2.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      const res = await grantVia(tokens.superAdmin!, t2.orgId, {
        userId: target,
        roleId,
        scopeType: 'workspace',
        scopeId: t2.workspaceId,
      });
      await expectRefused(res, target, roleId, ['contacts.read']);
    });

    it('delegating to oneself', async () => {
      const roleId = t.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      const res = await grantVia(tokens.superAdmin!, t.orgId, {
        userId: people.superAdmin!.userId,
        roleId,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
      await expectRefused(res, people.superAdmin!.userId, roleId, FIXTURE_CONTENT);
    });

    it('an actor lacking a NON-content permission of org_admin (delegate_tenant is no escape hatch)', async () => {
      const target = await member(t, 'dlg-n8');
      const roleId = t.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      const res = await grantVia(tokens.noDisable!, t.orgId, {
        userId: target,
        roleId,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
      await expectRefused(res, target, roleId, [PERMISSIONS.USERS_DISABLE, ...FIXTURE_CONTENT]);
    });
  });

  // ===========================================================================
  describe('C. delegate_tenant stays a platform key', () => {
    it('it cannot be composed into a tenant role through the API', async () => {
      const res = await call('post', tokens.cAdmin!, '/roles', c.orgId).send({
        key: `with_delegate_${suffix()}`,
        name: 'x',
        allowedScopeTypes: ['organization'],
        permissions: [DELEGATE],
      });
      expect([res.status, res.body.error?.code]).toEqual([
        403,
        ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
      ]);
      expect(res.body.error.details.rejected).toEqual([DELEGATE]);
    });

    it('the platform role that carries it cannot be granted through the API at any scope', async () => {
      const target = await member(c, 'dlg-pr');
      const superRole = await seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
      for (const [scopeType, scopeId] of [
        ['organization', c.orgId],
        ['workspace', c.workspaceId],
      ] as const) {
        const res = await grantVia(tokens.superAdmin!, c.orgId, {
          userId: target,
          roleId: superRole,
          scopeType,
          scopeId,
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await grantsOf(target, superRole)).toEqual([]);
      }
    });
  });

  // ===========================================================================
  describe('D. the API surface neither accepts nor lists a tenant-content key', () => {
    it('custom-role composition with a content key is a 400, for super admin and org admin', async () => {
      for (const [token, org] of [
        [tokens.superAdmin!, c.orgId],
        [tokens.cAdmin!, c.orgId],
      ] as const) {
        for (const key of TENANT_CONTENT_PERMISSIONS) {
          const res = await call('post', token, '/roles', org).send({
            key: `content_${suffix()}`,
            name: 'x',
            allowedScopeTypes: ['organization'],
            permissions: [key],
          });
          expect([key, res.status, res.body.error?.code]).toEqual([
            key,
            400,
            ERROR_CODES.VALIDATION_FAILED,
          ]);
        }
        const patch = await call(
          'patch',
          token,
          `/roles/${c.roles[TENANT_ROLE_KEYS.READ_ONLY]}`,
          org,
        ).send({ permissions: ['messages.send'] });
        expect([patch.status, patch.body.error?.code]).toEqual([
          400,
          ERROR_CODES.VALIDATION_FAILED,
        ]);
      }
    });

    it('API-key creation with a content scope is a 400', async () => {
      const res = await call('post', tokens.cAdmin!, '/api-keys', c.orgId).send({
        name: 'content key',
        scopeType: 'organization',
        scopeId: c.orgId,
        scopes: ['messages.send'],
      });
      expect([res.status, res.body.error?.code]).toEqual([400, ERROR_CODES.VALIDATION_FAILED]);
    });

    it('GET /permissions lists the API surface: delegate_tenant, and no content key', async () => {
      const res = await call('get', tokens.cAdmin!, '/permissions?limit=100', c.orgId).expect(200);
      const keys = (res.body.data as { key: string }[]).map((p) => p.key).sort();
      expect(keys).toEqual([...API_SURFACE_PERMISSION_KEYS].sort());
      expect(keys).toContain(DELEGATE);
      for (const domain of ['contacts', 'templates', 'suppressions', 'messages']) {
        const filtered = await call(
          'get',
          tokens.cAdmin!,
          `/permissions?domain=${domain}`,
          c.orgId,
        ).expect(200);
        expect([domain, filtered.body.data]).toEqual([domain, []]);
      }
    });
  });
  // ===========================================================================
  describe('E. the role is locked before its permissions are read', () => {
    it('an edit of the role in flight is waited for, and the grant is judged and audited on the committed set', async () => {
      const roleId = c.roles[TENANT_ROLE_KEYS.ORG_ADMIN]!;
      const target = await member(c, 'dlg-lock');
      const [contacts] = await permissionIds(['contacts.read']);
      const owner = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 2 });
      const holder = await owner.connect();
      try {
        // The edit: lock the role row as a role edit does, then change its set.
        await holder.query('BEGIN');
        await holder.query("SELECT set_config('app.provisioning', 'on', true)");
        const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]
          .pid as number;
        await holder.query('UPDATE roles SET updated_at = now() WHERE id = $1', [roleId]);

        const pending = grantVia(tokens.superAdmin!, c.orgId, {
          userId: target,
          roleId,
          scopeType: 'organization',
          scopeId: c.orgId,
        }).then((r) => r);

        let waited = false;
        const deadline = Date.now() + 10_000;
        while (!waited && Date.now() < deadline) {
          const { rows } = await owner.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))',
            [holderPid],
          );
          waited = rows[0]!.n > 0;
          if (!waited) await new Promise((r) => setTimeout(r, 25));
        }
        await holder.query(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)',
          [roleId, contacts],
        );
        await holder.query('COMMIT');

        const res = await pending;
        expect(waited).toBe(true);
        expect(res.status).toBe(201);
        // Judged on the committed set: the content key was delegated, and said so.
        expect((await grantedAudit(res.body.data.id))[0]!.metadata).toEqual({
          roleKey: TENANT_ROLE_KEYS.ORG_ADMIN,
          grantedTo: target,
          delegation: true,
          delegatedPermissions: ['contacts.read'],
        });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        const cleanup = await owner.connect();
        try {
          await cleanup.query('BEGIN');
          await cleanup.query("SELECT set_config('app.provisioning', 'on', true)");
          await cleanup.query(
            'DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2',
            [roleId, contacts],
          );
          await cleanup.query('COMMIT');
        } finally {
          cleanup.release();
        }
        await owner.end();
      }
    });
  });
});
